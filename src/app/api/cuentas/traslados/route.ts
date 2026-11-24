import { NextRequest, NextResponse } from "next/server";
import { successResponse, errorResponse } from "@/lib/api/response";
import { resolverCtx, respError } from "../_ctx";
import {
  transferirEntreCuentas,
  retirarDeCajaACuenta,
  anularTransferencia,
} from "@/lib/cuentas/server/cuentas-pg";

/**
 * POST /api/cuentas/traslados
 *  { tipo: "transferencia", origen_id, destino_id, monto, fecha?, concepto? }  entre cuentas (total general no cambia)
 *  { tipo: "retiro_caja", caja_id, cuenta_id, monto, concepto? }              caja del Market → caja chica
 *  { tipo: "anular_transferencia", grupo_id, motivo }
 */
export async function POST(request: NextRequest) {
  const r = await resolverCtx(request);
  if (!r.ok) return r.response;
  let b: Record<string, unknown>;
  try {
    b = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(errorResponse("Cuerpo JSON inválido."), { status: 400 });
  }
  const s = (k: string) => (b[k] != null && String(b[k]).trim() !== "" ? String(b[k]).trim() : "");
  const { ctx } = r;
  try {
    const tipo = s("tipo");
    if (tipo === "transferencia") {
      const fecha = /^\d{4}-\d{2}-\d{2}$/.test(s("fecha")) ? s("fecha") : null;
      const out = await transferirEntreCuentas({
        schemaRaw: ctx.schema, empresaId: ctx.empresaId,
        origenCuentaId: s("origen_id"), destinoCuentaId: s("destino_id"),
        monto: Number(b.monto) || 0, fecha, concepto: s("concepto") || null, usuarioNombre: ctx.usuarioNombre,
      });
      return NextResponse.json(successResponse(out));
    }
    if (tipo === "retiro_caja") {
      if (!s("caja_id") || !s("cuenta_id")) return NextResponse.json(errorResponse("Elegí la caja y la cuenta de destino."), { status: 400 });
      await retirarDeCajaACuenta({
        schemaRaw: ctx.schema, empresaId: ctx.empresaId, cajaId: s("caja_id"), cuentaId: s("cuenta_id"),
        monto: Number(b.monto) || 0, concepto: s("concepto") || null,
        usuarioId: ctx.usuarioId, usuarioNombre: ctx.usuarioNombre,
      });
      return NextResponse.json(successResponse({ ok: true }));
    }
    if (tipo === "anular_transferencia") {
      if (s("motivo").length < 5) return NextResponse.json(errorResponse("Indicá el motivo (mínimo 5 caracteres)."), { status: 400 });
      const n = await anularTransferencia(ctx.schema, ctx.empresaId, s("grupo_id"), s("motivo"));
      return NextResponse.json(successResponse({ movimientos_anulados: n }));
    }
    return NextResponse.json(errorResponse("Tipo de traslado inválido."), { status: 400 });
  } catch (e) {
    return respError(e);
  }
}
