import { NextRequest, NextResponse } from "next/server";
import { successResponse } from "@/lib/api/response";
import { resolverCtx, respError, respProhibido, cargarLado } from "../../_ctx";
import { recibirTransferencia } from "@/lib/transferencias/server/transferencias-pg";
import { esRolAprobador, esDestino } from "@/lib/transferencias/permisos";

/** POST /api/transferencias/[id]/recibir — admin/supervisor de la sucursal DESTINO. */
export async function POST(request: NextRequest, ctxParams: { params: Promise<{ id: string }> }) {
  const r = await resolverCtx(request);
  if (!r.ok) return r.response;
  try {
    const { id } = await ctxParams.params;
    if (!esRolAprobador(r.ctx.rol)) return respProhibido("Requiere rol administrador o supervisor.");

    const lado = await cargarLado(r.ctx.schema, r.ctx.empresaId, id);
    if (!lado) return respProhibido("Transferencia no encontrada.");
    if (!esDestino(lado, r.ctx.sucursalId)) {
      return respProhibido("Solo la sucursal destino puede confirmar la recepción.");
    }

    await recibirTransferencia({
      schemaRaw: r.ctx.schema,
      empresaId: r.ctx.empresaId,
      transferenciaId: id,
      usuarioId: r.ctx.usuarioId,
      usuarioNombre: r.ctx.usuarioNombre,
    });
    return NextResponse.json(successResponse({ ok: true }));
  } catch (err) {
    return respError(err);
  }
}
