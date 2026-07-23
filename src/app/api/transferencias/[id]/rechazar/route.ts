import { NextRequest, NextResponse } from "next/server";
import { successResponse, errorResponse } from "@/lib/api/response";
import { resolverCtx, respError, respProhibido, cargarLado } from "../../_ctx";
import { rechazarTransferencia } from "@/lib/transferencias/server/transferencias-pg";
import { esRolAprobador, esOrigen } from "@/lib/transferencias/permisos";

/** POST /api/transferencias/[id]/rechazar — admin/supervisor de la sucursal ORIGEN. */
export async function POST(request: NextRequest, ctxParams: { params: Promise<{ id: string }> }) {
  const r = await resolverCtx(request);
  if (!r.ok) return r.response;
  try {
    const { id } = await ctxParams.params;
    if (!esRolAprobador(r.ctx.rol)) return respProhibido("Requiere rol administrador o supervisor.");

    const lado = await cargarLado(r.ctx.schema, r.ctx.empresaId, id);
    if (!lado) return respProhibido("Transferencia no encontrada.");
    if (!esOrigen(lado, r.ctx.sucursalId)) {
      return respProhibido("Solo la sucursal de origen puede rechazar.");
    }

    const body = (await request.json().catch(() => ({}))) as { motivo?: unknown };
    const motivo = typeof body.motivo === "string" ? body.motivo.trim() : "";
    if (!motivo) return NextResponse.json(errorResponse("Indicá el motivo del rechazo."), { status: 400 });

    await rechazarTransferencia({
      schemaRaw: r.ctx.schema,
      empresaId: r.ctx.empresaId,
      transferenciaId: id,
      motivo,
      usuarioId: r.ctx.usuarioId,
    });
    return NextResponse.json(successResponse({ ok: true }));
  } catch (err) {
    return respError(err);
  }
}
