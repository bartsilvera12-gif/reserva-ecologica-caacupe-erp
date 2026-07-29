import { NextRequest, NextResponse } from "next/server";
import { successResponse, errorResponse } from "@/lib/api/response";
import { getNotaCreditoCompra } from "@/lib/notas-credito-compra/server/nc-compra-pg";
import { resolverCtx, respError } from "../_ctx";

/** GET /api/notas-credito-compra/[id] — detalle + ítems. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await resolverCtx(request);
  if (!r.ok) return r.response;
  try {
    const { id } = await params;
    const data = await getNotaCreditoCompra(r.ctx.schema, r.ctx.empresaId, id);
    if (!data) return NextResponse.json(errorResponse("Nota de crédito no encontrada."), { status: 404 });
    return NextResponse.json(successResponse(data));
  } catch (e) {
    return respError(e);
  }
}
