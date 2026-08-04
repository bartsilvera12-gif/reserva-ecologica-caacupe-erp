import { NextRequest, NextResponse } from "next/server";
import { successResponse } from "@/lib/api/response";
import { resolverCtx, respError } from "../_ctx";
import { listarCajasAbiertasParaVenta } from "@/lib/caja/server/caja-pg";

/** GET /api/caja/abiertas — cajas 'abierta' de la sucursal (id + número) para el POS. */
export async function GET(request: NextRequest) {
  const r = await resolverCtx(request);
  if (!r.ok) return r.response;
  try {
    const cajas = await listarCajasAbiertasParaVenta(r.ctx.schema, r.ctx.empresaId, r.ctx.sucursalId);
    return NextResponse.json(successResponse({ cajas }));
  } catch (e) {
    return respError(e);
  }
}
