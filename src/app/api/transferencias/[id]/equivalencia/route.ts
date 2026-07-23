import { NextRequest, NextResponse } from "next/server";
import { successResponse, errorResponse } from "@/lib/api/response";
import { resolverCtx, respError, respProhibido, cargarLado } from "../../_ctx";
import { resolverEquivalencia } from "@/lib/transferencias/server/transferencias-pg";
import { esRolAprobador, esOrigen } from "@/lib/transferencias/permisos";

/**
 * POST /api/transferencias/[id]/equivalencia — admin/supervisor de la ORIGEN
 * asigna manualmente el producto equivalente del origen a un ítem sin match.
 */
export async function POST(request: NextRequest, ctxParams: { params: Promise<{ id: string }> }) {
  const r = await resolverCtx(request);
  if (!r.ok) return r.response;
  try {
    const { id } = await ctxParams.params;
    if (!esRolAprobador(r.ctx.rol)) return respProhibido("Requiere rol administrador o supervisor.");

    const lado = await cargarLado(r.ctx.schema, r.ctx.empresaId, id);
    if (!lado) return respProhibido("Transferencia no encontrada.");
    if (!esOrigen(lado, r.ctx.sucursalId)) {
      return respProhibido("Solo la sucursal de origen puede resolver la equivalencia.");
    }

    const body = (await request.json().catch(() => ({}))) as { item_id?: unknown; producto_origen_id?: unknown };
    const itemId = typeof body.item_id === "string" ? body.item_id : "";
    const productoOrigenId = typeof body.producto_origen_id === "string" ? body.producto_origen_id : "";
    if (!itemId || !productoOrigenId) {
      return NextResponse.json(errorResponse("Faltan datos para asignar la equivalencia."), { status: 400 });
    }

    await resolverEquivalencia({
      schemaRaw: r.ctx.schema,
      empresaId: r.ctx.empresaId,
      transferenciaId: id,
      itemId,
      productoOrigenId,
    });
    return NextResponse.json(successResponse({ ok: true }));
  } catch (err) {
    return respError(err);
  }
}
