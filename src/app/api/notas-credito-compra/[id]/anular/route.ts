import { NextRequest, NextResponse } from "next/server";
import { successResponse, errorResponse } from "@/lib/api/response";
import { anularNotaCreditoCompra } from "@/lib/notas-credito-compra/server/nc-compra-pg";
import { resolverCtx, respError, respProhibido, esAprobador } from "../../_ctx";

/** POST /api/notas-credito-compra/[id]/anular — reversa el stock si era devolución. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await resolverCtx(request);
  if (!r.ok) return r.response;
  if (!esAprobador(r.ctx.rol)) {
    return respProhibido("Solo un administrador o supervisor puede anular notas de crédito de proveedor.");
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    /* body opcional */
  }
  const motivo = String(body.motivo ?? "").trim();
  if (motivo.length < 5) {
    return NextResponse.json(errorResponse("El motivo de anulación es obligatorio (mínimo 5 caracteres)."), { status: 400 });
  }

  try {
    const { id } = await params;
    await anularNotaCreditoCompra({
      schemaRaw: r.ctx.schema,
      empresaId: r.ctx.empresaId,
      id,
      motivo,
      usuarioId: r.ctx.usuarioId,
      usuarioNombre: r.ctx.usuarioNombre,
    });
    return NextResponse.json(successResponse({ ok: true }));
  } catch (e) {
    return respError(e);
  }
}
