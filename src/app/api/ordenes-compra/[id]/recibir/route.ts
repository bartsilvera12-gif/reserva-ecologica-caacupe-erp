import { NextRequest, NextResponse } from "next/server";
import { successResponse, errorResponse } from "@/lib/api/response";
import { resolverCtx, respError, esAprobador } from "../../_ctx";
import { recibirOrdenCompra } from "@/lib/ordenes-compra/server/oc-pg";

/** POST /api/ordenes-compra/[id]/recibir — recepción (crea la compra real). */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await resolverCtx(request);
  if (!r.ok) return r.response;
  if (!esAprobador(r.ctx.rol)) {
    return NextResponse.json(errorResponse("Solo un administrador o supervisor puede recibir órdenes."), { status: 403 });
  }
  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; }
  catch { return NextResponse.json(errorResponse("Cuerpo JSON inválido."), { status: 400 }); }

  const recepcionesRaw = Array.isArray(body.recepciones) ? (body.recepciones as Record<string, unknown>[]) : [];
  const recepciones = recepcionesRaw.map((x) => ({
    item_id: String(x.item_id ?? ""),
    cantidad: Number(x.cantidad) || 0,
    costo_unitario: Number(x.costo_unitario) || 0,
  })).filter((x) => x.item_id && x.cantidad > 0);
  if (recepciones.length === 0) return NextResponse.json(errorResponse("Indicá al menos una cantidad recibida."), { status: 400 });

  const fechaRaw = body.fecha_factura;
  const fechaFactura = typeof fechaRaw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(fechaRaw) ? fechaRaw : null;
  const metodoRaw = body.metodo_pago;
  const metodo = metodoRaw === "efectivo" || metodoRaw === "transferencia" || metodoRaw === "tarjeta" ? metodoRaw : null;
  const str = (v: unknown) => (v != null && String(v).trim() !== "" ? String(v).trim() : null);

  try {
    const { id } = await params;
    const out = await recibirOrdenCompra({
      schemaRaw: r.ctx.schema,
      empresaId: r.ctx.empresaId,
      sucursalId: r.ctx.sucursalId,
      id,
      recepciones,
      nroTimbrado: String(body.nro_timbrado ?? ""),
      numeroFacturaProveedor: str(body.numero_factura_proveedor),
      fechaFactura,
      metodoPago: metodo,
      comprobante: {
        path: str(body.comprobante_storage_path),
        nombre: str(body.comprobante_nombre),
        mime: str(body.comprobante_mime_type),
      },
      usuarioId: r.ctx.usuarioId,
      usuarioNombre: r.ctx.usuarioNombre,
    });
    return NextResponse.json(successResponse(out));
  } catch (e) {
    return respError(e);
  }
}
