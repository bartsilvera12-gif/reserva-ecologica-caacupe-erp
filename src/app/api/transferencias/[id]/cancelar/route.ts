import { NextRequest, NextResponse } from "next/server";
import { successResponse } from "@/lib/api/response";
import { resolverCtx, respError, respProhibido, cargarLado } from "../../_ctx";
import { cancelarTransferencia } from "@/lib/transferencias/server/transferencias-pg";
import { esDestino } from "@/lib/transferencias/permisos";

/**
 * POST /api/transferencias/[id]/cancelar — la sucursal SOLICITANTE (destino),
 * cualquier rol, solo si está pendiente (la transacción valida el estado).
 */
export async function POST(request: NextRequest, ctxParams: { params: Promise<{ id: string }> }) {
  const r = await resolverCtx(request);
  if (!r.ok) return r.response;
  try {
    const { id } = await ctxParams.params;
    const lado = await cargarLado(r.ctx.schema, r.ctx.empresaId, id);
    if (!lado) return respProhibido("Transferencia no encontrada.");
    if (!esDestino(lado, r.ctx.sucursalId)) {
      return respProhibido("Solo la sucursal solicitante puede cancelar.");
    }

    await cancelarTransferencia({
      schemaRaw: r.ctx.schema,
      empresaId: r.ctx.empresaId,
      transferenciaId: id,
      usuarioId: r.ctx.usuarioId,
    });
    return NextResponse.json(successResponse({ ok: true }));
  } catch (err) {
    return respError(err);
  }
}
