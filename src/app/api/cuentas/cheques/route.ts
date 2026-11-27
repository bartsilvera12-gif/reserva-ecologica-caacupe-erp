import { NextRequest, NextResponse } from "next/server";
import { successResponse, errorResponse } from "@/lib/api/response";
import { resolverCtx, respError } from "../_ctx";
import { listarCheques, crearCheque, resolverCheque, historialCheque } from "@/lib/cuentas/server/cheques-pg";

/** GET /api/cuentas/cheques?estado=&tipo=  |  GET ?historial_id=<id> */
export async function GET(request: NextRequest) {
  const r = await resolverCtx(request);
  if (!r.ok) return r.response;
  try {
    const sp = new URL(request.url).searchParams;
    const h = sp.get("historial_id");
    if (h) return NextResponse.json(successResponse({ historial: await historialCheque(r.ctx.schema, r.ctx.empresaId, h) }));
    const cheques = await listarCheques(r.ctx.schema, r.ctx.empresaId, { estado: sp.get("estado"), tipo: sp.get("tipo") });
    return NextResponse.json(successResponse({ cheques }));
  } catch (e) {
    return respError(e);
  }
}

/**
 * POST /api/cuentas/cheques
 *  { accion: "crear", tipo, numero, banco, monto, fecha_prevista, cuenta_id, origen?, origen_id?, referencia?, observaciones? }
 *  { accion: "confirmar" | "rechazar" | "anular", cheque_id, motivo? }
 */
export async function POST(request: NextRequest) {
  const r = await resolverCtx(request);
  if (!r.ok) return r.response;
  let b: Record<string, unknown>;
  try {
    b = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(errorResponse("Cuerpo JSON inválido."), { status: 400 });
  }
  const s = (k: string) => (b[k] != null && String(b[k]).trim() !== "" ? String(b[k]).trim() : "");
  const { ctx } = r;
  try {
    const accion = s("accion");
    if (accion === "crear") {
      const out = await crearCheque({
        schemaRaw: ctx.schema, empresaId: ctx.empresaId, sucursalId: ctx.sucursalId, usuarioNombre: ctx.usuarioNombre,
        tipo: s("tipo"), numero: s("numero"), banco: s("banco"), monto: Number(b.monto) || 0,
        fechaPrevista: s("fecha_prevista"), cuentaId: s("cuenta_id"),
        origen: s("origen") || null, origenId: s("origen_id") || null,
        referencia: s("referencia") || null, observaciones: s("observaciones") || null,
      });
      return NextResponse.json(successResponse(out));
    }
    if (accion === "confirmar" || accion === "rechazar" || accion === "anular") {
      if (!s("cheque_id")) return NextResponse.json(errorResponse("Falta el cheque."), { status: 400 });
      const out = await resolverCheque({
        schemaRaw: ctx.schema, empresaId: ctx.empresaId, chequeId: s("cheque_id"), accion,
        motivo: s("motivo") || null, usuarioNombre: ctx.usuarioNombre,
      });
      return NextResponse.json(successResponse(out));
    }
    return NextResponse.json(errorResponse("Acción inválida."), { status: 400 });
  } catch (e) {
    return respError(e);
  }
}
