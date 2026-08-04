import { NextRequest, NextResponse } from "next/server";
import { successResponse } from "@/lib/api/response";
import { resolverCtx, respError } from "./_ctx";
import { listarCajasActivas, listCajasCerradas } from "@/lib/caja/server/caja-pg";

/** GET /api/caja — cajas activas (con arqueo en vivo) + historial de la sucursal. */
export async function GET(request: NextRequest) {
  const r = await resolverCtx(request);
  if (!r.ok) return r.response;
  try {
    const [activas, historial] = await Promise.all([
      listarCajasActivas(r.ctx.schema, r.ctx.empresaId, r.ctx.sucursalId),
      listCajasCerradas(r.ctx.schema, r.ctx.empresaId, r.ctx.sucursalId),
    ]);
    return NextResponse.json(successResponse({ activas, historial }));
  } catch (e) {
    return respError(e);
  }
}
