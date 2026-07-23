import { NextRequest, NextResponse } from "next/server";
import { successResponse } from "@/lib/api/response";
import { resolverCtx, respError, respProhibido, cargarLado } from "../../_ctx";
import { aprobarTransferencia } from "@/lib/transferencias/server/transferencias-pg";
import { esRolAprobador, esOrigen } from "@/lib/transferencias/permisos";

/** POST /api/transferencias/[id]/aprobar — admin/supervisor de la sucursal ORIGEN. */
export async function POST(request: NextRequest, ctxParams: { params: Promise<{ id: string }> }) {
  const r = await resolverCtx(request);
  if (!r.ok) return r.response;
  try {
    const { id } = await ctxParams.params;
    if (!esRolAprobador(r.ctx.rol)) return respProhibido("Requiere rol administrador o supervisor.");

    const lado = await cargarLado(r.ctx.schema, r.ctx.empresaId, id);
    if (!lado) return respProhibido("Transferencia no encontrada.");
    if (!esOrigen(lado, r.ctx.sucursalId)) {
      return respProhibido("Solo la sucursal de origen puede aprobar.");
    }

    const body = (await request.json().catch(() => ({}))) as { aprobaciones?: unknown };
    const aprobaciones = Array.isArray(body.aprobaciones)
      ? body.aprobaciones
          .map((a) => {
            const o = a as { item_id?: unknown; cantidad_aprobada?: unknown };
            return {
              item_id: typeof o.item_id === "string" ? o.item_id : "",
              cantidad_aprobada: Number(o.cantidad_aprobada) || 0,
            };
          })
          .filter((a) => a.item_id)
      : [];

    await aprobarTransferencia({
      schemaRaw: r.ctx.schema,
      empresaId: r.ctx.empresaId,
      transferenciaId: id,
      aprobaciones,
      usuarioId: r.ctx.usuarioId,
    });
    return NextResponse.json(successResponse({ ok: true }));
  } catch (err) {
    return respError(err);
  }
}
