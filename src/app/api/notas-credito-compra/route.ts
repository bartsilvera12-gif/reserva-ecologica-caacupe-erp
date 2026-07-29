import { NextRequest, NextResponse } from "next/server";
import { successResponse, errorResponse } from "@/lib/api/response";
import {
  crearNotaCreditoCompra,
  listNotasCreditoCompra,
  type NCCItemInput,
  type TipoNotaCreditoCompra,
} from "@/lib/notas-credito-compra/server/nc-compra-pg";
import { resolverCtx, respError, respProhibido, esAprobador } from "./_ctx";

/** GET /api/notas-credito-compra — lista las NC de proveedor de la sucursal. */
export async function GET(request: NextRequest) {
  const r = await resolverCtx(request);
  if (!r.ok) return r.response;
  try {
    const data = await listNotasCreditoCompra(r.ctx.schema, r.ctx.empresaId, r.ctx.sucursalId);
    return NextResponse.json(successResponse({ notas: data }));
  } catch (e) {
    return respError(e);
  }
}

/** POST /api/notas-credito-compra — registra una NC de proveedor (con impacto de stock si es devolución). */
export async function POST(request: NextRequest) {
  const r = await resolverCtx(request);
  if (!r.ok) return r.response;
  if (!esAprobador(r.ctx.rol)) {
    return respProhibido("Solo un administrador o supervisor puede registrar notas de crédito de proveedor.");
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(errorResponse("Cuerpo JSON inválido."), { status: 400 });
  }

  const compraNumeroControl = String(body.compra_numero_control ?? "").trim();
  if (!compraNumeroControl) {
    return NextResponse.json(errorResponse("Falta la compra a corregir (numero_control)."), { status: 400 });
  }
  const tipo: TipoNotaCreditoCompra = body.tipo === "descuento" ? "descuento" : "devolucion";

  const fechaRaw = body.fecha_documento;
  const fechaDocumento =
    typeof fechaRaw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(fechaRaw) ? fechaRaw : null;

  const str = (v: unknown): string | null => {
    const s = v == null ? "" : String(v).trim();
    return s.length > 0 ? s : null;
  };

  const rawItems: Record<string, unknown>[] = Array.isArray(body.items)
    ? (body.items as Record<string, unknown>[])
    : [];
  const items: NCCItemInput[] = rawItems.map((it) => ({
    producto_id: String(it.producto_id ?? ""),
    producto_nombre: String(it.producto_nombre ?? ""),
    sku: String(it.sku ?? ""),
    cantidad: Number(it.cantidad) || 0,
    costo_unitario: Number(it.costo_unitario) || 0,
    subtotal: Number(it.subtotal) || 0,
  }));

  try {
    const out = await crearNotaCreditoCompra({
      schemaRaw: r.ctx.schema,
      empresaId: r.ctx.empresaId,
      sucursalId: r.ctx.sucursalId,
      compraNumeroControl,
      tipo,
      numeroDocumento: str(body.numero_documento),
      fechaDocumento,
      motivo: str(body.motivo),
      subtotal: Number(body.subtotal) || 0,
      montoIva: Number(body.monto_iva) || 0,
      total: Number(body.total) || 0,
      comprobante: {
        path: str(body.comprobante_storage_path),
        nombre: str(body.comprobante_nombre),
        mime: str(body.comprobante_mime_type),
      },
      items,
      usuarioId: r.ctx.usuarioId,
      usuarioNombre: r.ctx.usuarioNombre,
    });
    return NextResponse.json(successResponse(out));
  } catch (e) {
    return respError(e);
  }
}
