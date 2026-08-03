import { NextRequest, NextResponse } from "next/server";
import { successResponse, errorResponse } from "@/lib/api/response";
import { resolverCtx, respError } from "../_ctx";
import { getOrdenCompra } from "@/lib/ordenes-compra/server/oc-pg";

/** GET /api/ordenes-compra/[id] — detalle + ítems. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await resolverCtx(request);
  if (!r.ok) return r.response;
  try {
    const { id } = await params;
    const det = await getOrdenCompra(r.ctx.schema, r.ctx.empresaId, r.ctx.sucursalId, id);
    if (!det) return NextResponse.json(errorResponse("Orden no encontrada."), { status: 404 });
    return NextResponse.json(successResponse(det));
  } catch (e) {
    return respError(e);
  }
}
