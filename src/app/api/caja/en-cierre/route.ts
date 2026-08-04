import { NextRequest, NextResponse } from "next/server";
import { successResponse, errorResponse } from "@/lib/api/response";
import { resolverCtx, respError } from "../_ctx";
import { ponerCajaEnCierre } from "@/lib/caja/server/caja-pg";

/** POST /api/caja/en-cierre — pasa una caja 'abierta' a 'en_cierre' (conteo). */
export async function POST(request: NextRequest) {
  const r = await resolverCtx(request);
  if (!r.ok) return r.response;
  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* opcional */ }
  const cajaId = body.caja_id != null ? String(body.caja_id).trim() : "";
  if (!cajaId) return NextResponse.json(errorResponse("Falta el identificador de la caja."), { status: 400 });
  try {
    const out = await ponerCajaEnCierre({
      schemaRaw: r.ctx.schema, empresaId: r.ctx.empresaId, sucursalId: r.ctx.sucursalId, cajaId,
    });
    return NextResponse.json(successResponse(out));
  } catch (e) {
    return respError(e);
  }
}
