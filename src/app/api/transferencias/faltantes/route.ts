import { NextRequest, NextResponse } from "next/server";
import { successResponse } from "@/lib/api/response";
import { resolverCtx, respError } from "../_ctx";
import { listFaltantesRecepcion } from "@/lib/transferencias/server/transferencias-queries";

/** GET /api/transferencias/faltantes — faltantes de recepción de mi sucursal (destino). */
export async function GET(request: NextRequest) {
  const r = await resolverCtx(request);
  if (!r.ok) return r.response;
  try {
    const faltantes = await listFaltantesRecepcion({
      schemaRaw: r.ctx.schema,
      empresaId: r.ctx.empresaId,
      sucursalId: r.ctx.sucursalId,
    });
    return NextResponse.json(successResponse({ faltantes }));
  } catch (err) {
    return respError(err);
  }
}
