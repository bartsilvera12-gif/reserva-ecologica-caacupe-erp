import { NextRequest, NextResponse } from "next/server";
import { successResponse, errorResponse } from "@/lib/api/response";
import { getCompraParaNC } from "@/lib/notas-credito-compra/server/nc-compra-pg";
import { resolverCtx, respError } from "../../_ctx";

/**
 * GET /api/notas-credito-compra/compra/[numero_control]
 * Devuelve proveedor + líneas de la compra a corregir (para armar la NC).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ numero_control: string }> }
) {
  const r = await resolverCtx(request);
  if (!r.ok) return r.response;
  try {
    const { numero_control } = await params;
    const numero = decodeURIComponent(numero_control ?? "").trim();
    if (!numero) {
      return NextResponse.json(errorResponse("Falta el número de compra."), { status: 400 });
    }
    const compra = await getCompraParaNC(r.ctx.schema, r.ctx.empresaId, r.ctx.sucursalId, numero);
    if (!compra) {
      return NextResponse.json(
        errorResponse("No se encontró una compra con ese número en tu sucursal (o está anulada)."),
        { status: 404 }
      );
    }
    return NextResponse.json(successResponse({ compra }));
  } catch (e) {
    return respError(e);
  }
}
