import { NextRequest, NextResponse } from "next/server";
import { successResponse, errorResponse } from "@/lib/api/response";
import { resolverCtx, respError, esAprobador } from "./_ctx";
import { crearOrdenCompra, listOrdenesCompra, type OcItemInput } from "@/lib/ordenes-compra/server/oc-pg";

/** GET /api/ordenes-compra — lista de OC de la sucursal. */
export async function GET(request: NextRequest) {
  const r = await resolverCtx(request);
  if (!r.ok) return r.response;
  try {
    const ordenes = await listOrdenesCompra(r.ctx.schema, r.ctx.empresaId, r.ctx.sucursalId);
    return NextResponse.json(successResponse({ ordenes }));
  } catch (e) {
    return respError(e);
  }
}

/** POST /api/ordenes-compra — crea una OC (borrador o emitida). */
export async function POST(request: NextRequest) {
  const r = await resolverCtx(request);
  if (!r.ok) return r.response;
  if (!esAprobador(r.ctx.rol)) {
    return NextResponse.json(errorResponse("Solo un administrador o supervisor puede crear órdenes de compra."), { status: 403 });
  }
  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; }
  catch { return NextResponse.json(errorResponse("Cuerpo JSON inválido."), { status: 400 }); }

  const proveedorId = body.proveedor_id != null && String(body.proveedor_id).trim() !== "" ? String(body.proveedor_id) : null;
  if (!proveedorId) return NextResponse.json(errorResponse("Elegí el proveedor."), { status: 400 });

  const fechaRaw = body.llegada_estimada;
  const llegada = typeof fechaRaw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(fechaRaw) ? fechaRaw : null;
  const rawItems = Array.isArray(body.items) ? (body.items as Record<string, unknown>[]) : [];
  const items: OcItemInput[] = rawItems.map((it) => ({
    producto_id: String(it.producto_id ?? ""),
    producto_nombre: String(it.producto_nombre ?? ""),
    sku: String(it.sku ?? ""),
    descripcion: it.descripcion != null ? String(it.descripcion) : null,
    cantidad_solicitada: Number(it.cantidad_solicitada) || 0,
    costo_estimado: Number(it.costo_estimado) || 0,
    iva_tipo: ["exenta", "5", "10"].includes(String(it.iva_tipo)) ? String(it.iva_tipo) : "10",
  })).filter((i) => i.producto_id && i.cantidad_solicitada > 0);
  if (items.length === 0) return NextResponse.json(errorResponse("Agregá al menos un producto con cantidad."), { status: 400 });

  try {
    const out = await crearOrdenCompra({
      schemaRaw: r.ctx.schema,
      empresaId: r.ctx.empresaId,
      sucursalId: r.ctx.sucursalId,
      proveedorId,
      proveedorNombre: String(body.proveedor_nombre ?? ""),
      moneda: body.moneda === "USD" ? "USD" : "PYG",
      tipoCambio: Number(body.tipo_cambio) || 1,
      llegadaEstimada: llegada,
      tipoPago: body.tipo_pago === "credito" ? "credito" : "contado",
      plazoDias: body.plazo_dias != null && String(body.plazo_dias).trim() !== "" ? parseInt(String(body.plazo_dias), 10) || null : null,
      observaciones: body.observaciones != null && String(body.observaciones).trim() !== "" ? String(body.observaciones).trim() : null,
      emitir: body.emitir === true,
      items,
      usuarioId: r.ctx.usuarioId,
      usuarioNombre: r.ctx.usuarioNombre,
    });
    return NextResponse.json(successResponse(out));
  } catch (e) {
    return respError(e);
  }
}
