import { NextRequest, NextResponse } from "next/server";
import { successResponse, errorResponse } from "@/lib/api/response";
import { resolverCtx, respError } from "../../_ctx";
import { cerrarCaja } from "@/lib/caja/server/caja-pg";
import { normalizarArqueo, calcularTotalArqueo } from "@/lib/caja/denominaciones";

/** POST /api/caja/[id]/cerrar — cierra la caja y calcula el arqueo. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await resolverCtx(request);
  if (!r.ok) return r.response;
  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; }
  catch { return NextResponse.json(errorResponse("Cuerpo JSON inválido."), { status: 400 }); }

  // Arqueo de cierre por denominaciones (opcional). Si viene, el efectivo contado
  // se calcula del detalle; si no, se usa el monto tipeado.
  let arqueoCierre = null;
  if (body.arqueo_cierre != null) {
    arqueoCierre = normalizarArqueo(body.arqueo_cierre);
    if (arqueoCierre == null) {
      return NextResponse.json(errorResponse("Arqueo inválido: revisá denominaciones y cantidades (enteras, no negativas)."), { status: 400 });
    }
  }
  const efectivoContado = arqueoCierre ? calcularTotalArqueo(arqueoCierre) : Number(body.efectivo_contado);
  if (!Number.isFinite(efectivoContado) || efectivoContado < 0) {
    return NextResponse.json(errorResponse("Ingresá el efectivo contado (mayor o igual a 0)."), { status: 400 });
  }
  const obs = body.observacion != null && String(body.observacion).trim() !== "" ? String(body.observacion).trim() : null;
  try {
    const { id } = await params;
    const out = await cerrarCaja({
      schemaRaw: r.ctx.schema, empresaId: r.ctx.empresaId, sucursalId: r.ctx.sucursalId, cajaId: id,
      efectivoContado, observacion: obs, usuarioId: r.ctx.usuarioId, usuarioNombre: r.ctx.usuarioNombre,
      arqueoCierre,
    });
    return NextResponse.json(successResponse(out));
  } catch (e) {
    return respError(e);
  }
}
