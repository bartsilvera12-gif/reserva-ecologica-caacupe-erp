import { NextRequest, NextResponse } from "next/server";
import { successResponse } from "@/lib/api/response";
import { resolverCtx, respError } from "./_ctx";
import { getCajaAbierta, listCajas } from "@/lib/caja/server/caja-pg";

/** GET /api/caja — caja abierta (con arqueo en vivo) + historial de la sucursal. */
export async function GET(request: NextRequest) {
  const r = await resolverCtx(request);
  if (!r.ok) return r.response;
  try {
    const [abierta, historial] = await Promise.all([
      getCajaAbierta(r.ctx.schema, r.ctx.empresaId, r.ctx.sucursalId),
      listCajas(r.ctx.schema, r.ctx.empresaId, r.ctx.sucursalId),
    ]);
    return NextResponse.json(successResponse({ abierta, historial }));
  } catch (e) {
    return respError(e);
  }
}
