import { NextRequest, NextResponse } from "next/server";
import { successResponse, errorResponse } from "@/lib/api/response";
import { resolverCtx, respError, esAprobador } from "../../_ctx";
import { cambiarEstadoOrden } from "@/lib/ordenes-compra/server/oc-pg";

/** POST /api/ordenes-compra/[id]/estado — emitir / aprobar / cancelar. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await resolverCtx(request);
  if (!r.ok) return r.response;
  if (!esAprobador(r.ctx.rol)) {
    return NextResponse.json(errorResponse("Solo un administrador o supervisor puede cambiar el estado."), { status: 403 });
  }
  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* opcional */ }
  const nuevoEstado = String(body.estado ?? "");
  if (!["emitida", "aprobada", "cancelada"].includes(nuevoEstado)) {
    return NextResponse.json(errorResponse("Estado inválido."), { status: 400 });
  }
  try {
    const { id } = await params;
    await cambiarEstadoOrden({
      schemaRaw: r.ctx.schema, empresaId: r.ctx.empresaId, sucursalId: r.ctx.sucursalId, id, nuevoEstado,
    });
    return NextResponse.json(successResponse({ ok: true }));
  } catch (e) {
    return respError(e);
  }
}
