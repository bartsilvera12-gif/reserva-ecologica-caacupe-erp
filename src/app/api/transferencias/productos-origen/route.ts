import { NextRequest, NextResponse } from "next/server";
import { successResponse } from "@/lib/api/response";
import { resolverCtx, respError, respProhibido } from "../_ctx";
import { buscarProductosDeSucursal } from "@/lib/transferencias/server/transferencias-queries";
import { esRolAprobador } from "@/lib/transferencias/permisos";

/**
 * GET /api/transferencias/productos-origen?q=...
 *
 * Productos de la PROPIA sucursal del usuario (que es la de origen cuando
 * despacha), para el selector de equivalencia manual. No expone catálogos de
 * otras sucursales: siempre consulta la sucursal del usuario autenticado.
 */
export async function GET(request: NextRequest) {
  const r = await resolverCtx(request);
  if (!r.ok) return r.response;
  try {
    if (!esRolAprobador(r.ctx.rol)) return respProhibido("Requiere rol administrador o supervisor.");
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
