import { NextRequest, NextResponse } from "next/server";
import { successResponse, errorResponse } from "@/lib/api/response";
import { resolverCtx, respError } from "../_ctx";
import { abrirCaja } from "@/lib/caja/server/caja-pg";
import { normalizarArqueo, calcularTotalArqueo } from "@/lib/caja/denominaciones";

/** POST /api/caja/abrir — abre la caja de la sucursal (una por sucursal). */
export async function POST(request: NextRequest) {
  const r = await resolverCtx(request);
  if (!r.ok) return r.response;
  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* opcional */ }

  // Arqueo de apertura por denominaciones (opcional). Si viene, el monto de
  // apertura se calcula del detalle; si no, se usa el monto tipeado.
  let arqueoApertura = null;
  if (body.arqueo_apertura != null) {
    arqueoApertura = normalizarArqueo(body.arqueo_apertura);
    if (arqueoApertura == null) {
      return NextResponse.json(errorResponse("Arqueo inválido: revisá denominaciones y cantidades (enteras, no negativas)."), { status: 400 });
    }
  }
  const monto = arqueoApertura ? calcularTotalArqueo(arqueoApertura) : Number(body.monto_apertura) || 0;
  if (monto < 0) return NextResponse.json(errorResponse("El monto de apertura no puede ser negativo."), { status: 400 });
  const obs = body.observacion != null && String(body.observacion).trim() !== "" ? String(body.observacion).trim() : null;
  try {
    const out = await abrirCaja({
      schemaRaw: r.ctx.schema, empresaId: r.ctx.empresaId, sucursalId: r.ctx.sucursalId,
      montoApertura: monto, observacion: obs, usuarioId: r.ctx.usuarioId, usuarioNombre: r.ctx.usuarioNombre,
      arqueoApertura,
    });
    return NextResponse.json(successResponse(out));
  } catch (e) {
    return respError(e);
  }
}
