import { NextRequest, NextResponse } from "next/server";
import { successResponse } from "@/lib/api/response";
import { resolverCtx, respError } from "../_ctx";
import { buscarProductosDeSucursal } from "@/lib/transferencias/server/transferencias-queries";

/**
 * GET /api/transferencias/productos-origen?q=...
 *
 * Productos de la PROPIA sucursal del usuario (= el depósito de ORIGEN al crear
 * una remisión / resolver equivalencia). Solo activos y que controlan stock (los
 * únicos remitibles). NUNCA expone catálogos de otras sucursales: siempre
 * consulta la sucursal del usuario autenticado. Cualquier usuario con sucursal
 * puede leer su propio catálogo (no es dato sensible).
 */
export async function GET(request: NextRequest) {
  const r = await resolverCtx(request);
  if (!r.ok) return r.response;
  try {
    const q = new URL(request.url).searchParams.get("q") ?? "";
    const productos = await buscarProductosDeSucursal({
      schemaRaw: r.ctx.schema,
      empresaId: r.ctx.empresaId,
      sucursalId: r.ctx.sucursalId,
      q,
    });
    return NextResponse.json(successResponse({ productos }));
  } catch (err) {
    return respError(err);
  }
}
