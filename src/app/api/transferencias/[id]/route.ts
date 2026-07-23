import { NextRequest, NextResponse } from "next/server";
import { successResponse, errorResponse } from "@/lib/api/response";
import { resolverCtx, respError } from "../_ctx";
import { getTransferenciaDetalle } from "@/lib/transferencias/server/transferencias-queries";

/** GET /api/transferencias/[id] — detalle. Solo si la sucursal participa (la query lo scoping). */
export async function GET(request: NextRequest, ctxParams: { params: Promise<{ id: string }> }) {
  const r = await resolverCtx(request);
  if (!r.ok) return r.response;
  try {
    const { id } = await ctxParams.params;
    const det = await getTransferenciaDetalle({
      schemaRaw: r.ctx.schema,
      empresaId: r.ctx.empresaId,
      sucursalId: r.ctx.sucursalId,
      transferenciaId: id,
    });
    // null = no existe o la sucursal no participa. 404 en ambos casos: no se
    // confirma la existencia de transferencias ajenas.
    if (!det) return NextResponse.json(errorResponse("Transferencia no encontrada."), { status: 404 });
    return NextResponse.json(successResponse(det));
  } catch (err) {
    return respError(err);
  }
}
