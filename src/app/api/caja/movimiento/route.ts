import { NextRequest, NextResponse } from "next/server";
import { successResponse, errorResponse } from "@/lib/api/response";
import { resolverCtx, respError } from "../_ctx";
import { registrarMovimientoCaja } from "@/lib/caja/server/caja-pg";

/** POST /api/caja/movimiento — ingreso/egreso/retiro/ajuste en la caja abierta. */
export async function POST(request: NextRequest) {
  const r = await resolverCtx(request);
  if (!r.ok) return r.response;
  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; }
  catch { return NextResponse.json(errorResponse("Cuerpo JSON inválido."), { status: 400 }); }

  const cajaId = String(body.caja_id ?? "");
  if (!cajaId) return NextResponse.json(errorResponse("Falta la caja."), { status: 400 });
  const tipo = String(body.tipo ?? "");
  const monto = Number(body.monto) || 0;
  const concepto = body.concepto != null && String(body.concepto).trim() !== "" ? String(body.concepto).trim() : null;
  const metodo = String(body.metodo_pago ?? "efectivo");

  try {
    await registrarMovimientoCaja({
      schemaRaw: r.ctx.schema, empresaId: r.ctx.empresaId, sucursalId: r.ctx.sucursalId, cajaId,
      tipo, concepto, monto, metodoPago: metodo, usuarioId: r.ctx.usuarioId, usuarioNombre: r.ctx.usuarioNombre,
    });
    return NextResponse.json(successResponse({ ok: true }));
  } catch (e) {
    return respError(e);
  }
}
