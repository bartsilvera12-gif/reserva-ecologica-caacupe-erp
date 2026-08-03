import { NextRequest, NextResponse } from "next/server";
import { successResponse, errorResponse } from "@/lib/api/response";
import { resolverCtx, respError } from "../_ctx";
import { getCajaDetalle } from "@/lib/caja/server/caja-pg";

/** GET /api/caja/[id] — detalle de una caja (arqueo + movimientos). */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await resolverCtx(request);
  if (!r.ok) return r.response;
  try {
    const { id } = await params;
    const det = await getCajaDetalle(r.ctx.schema, r.ctx.empresaId, r.ctx.sucursalId, id);
    if (!det) return NextResponse.json(errorResponse("Caja no encontrada."), { status: 404 });
    return NextResponse.json(successResponse(det));
  } catch (e) {
    return respError(e);
  }
}
