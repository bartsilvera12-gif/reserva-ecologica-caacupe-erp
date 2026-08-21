import { NextRequest, NextResponse } from "next/server";
import { successResponse } from "@/lib/api/response";
import { resolverCtx, respError, respProhibido, cargarLado } from "../../_ctx";
import { recibirTransferencia } from "@/lib/transferencias/server/transferencias-pg";
import { puedeRecibirTransferencia, esDestino } from "@/lib/transferencias/permisos";

/** POST /api/transferencias/[id]/recibir — admin/supervisor de la sucursal DESTINO. */
export async function POST(request: NextRequest, ctxParams: { params: Promise<{ id: string }> }) {
  const r = await resolverCtx(request);
  if (!r.ok) return r.response;
  try {
    const { id } = await ctxParams.params;
    if (!puedeRecibirTransferencia(r.ctx.rol)) return respProhibido("No tenés permiso para confirmar recepciones.");

    const lado = await cargarLado(r.ctx.schema, r.ctx.empresaId, id);
    if (!lado) return respProhibido("Transferencia no encontrada.");
    if (!esDestino(lado, r.ctx.sucursalId)) {
      return respProhibido("Solo la sucursal destino puede confirmar la recepción.");
    }

    // Control de recepción por ítem (opcional). Sin body => recibe todo lo despachado.
    const body = (await request.json().catch(() => ({}))) as { recepciones?: unknown };
    const recepciones = Array.isArray(body.recepciones)
      ? body.recepciones
          .map((x) => {
            const o = x as { item_id?: unknown; cantidad_recibida?: unknown };
            return {
              itemId: typeof o.item_id === "string" ? o.item_id : "",
              cantidadRecibida: Number(o.cantidad_recibida) || 0,
            };
          })
          .filter((x) => x.itemId)
      : undefined;

    await recibirTransferencia({
      schemaRaw: r.ctx.schema,
      empresaId: r.ctx.empresaId,
      transferenciaId: id,
      usuarioId: r.ctx.usuarioId,
      usuarioNombre: r.ctx.usuarioNombre,
      recepciones,
    });
    return NextResponse.json(successResponse({ ok: true }));
  } catch (err) {
    return respError(err);
  }
}
