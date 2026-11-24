import { NextRequest, NextResponse } from "next/server";
import { successResponse, errorResponse } from "@/lib/api/response";
import { resolverCtx, respError } from "../_ctx";
import { sincronizarMovimientoOrigen } from "@/lib/cuentas/server/cuentas-pg";
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";

/**
 * POST /api/cuentas/sincronizar-gasto { gasto_id }
 * Se llama después de crear / editar / borrar un gasto. Lee el gasto como está en la base:
 *  - con cuenta → deja UN egreso en esa cuenta (si cambió monto/cuenta/fecha, revierte y registra de nuevo);
 *  - sin cuenta o inexistente (borrado) → revierte el egreso.
 */
export async function POST(request: NextRequest) {
  const r = await resolverCtx(request);
  if (!r.ok) return r.response;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const gastoId = String(body.gasto_id ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(gastoId)) return NextResponse.json(errorResponse("Falta el gasto."), { status: 400 });
  const { ctx } = r;
  try {
    const schema = assertAllowedChatDataSchema(ctx.schema);
    const pool = getChatPostgresPool();
    if (!pool) throw new Error("Pool no disponible.");
    const { rows } = await pool.query(
      `SELECT cuenta_id, monto, fecha::text AS fecha, categoria, descripcion, beneficiario, sucursal_id
         FROM ${quoteSchemaTable(schema, "gastos")} WHERE id=$1::uuid AND empresa_id=$2::uuid`,
      [gastoId, ctx.empresaId]
    );
    const g = rows[0];
    const out = await sincronizarMovimientoOrigen({
      schemaRaw: ctx.schema, empresaId: ctx.empresaId, origen: "gasto", origenId: gastoId,
      usuarioNombre: ctx.usuarioNombre,
      motivo: g ? "Gasto modificado" : "Gasto eliminado",
      deseado:
        g && g.cuenta_id
          ? {
              cuentaId: String(g.cuenta_id), tipo: "egreso", monto: Number(g.monto), fecha: String(g.fecha).slice(0, 10),
              concepto: `Gasto: ${[g.categoria, g.descripcion || g.beneficiario].filter(Boolean).join(" — ") || "sin detalle"}`,
              sucursalId: g.sucursal_id ? String(g.sucursal_id) : null,
            }
          : null,
    });
    return NextResponse.json(successResponse(out));
  } catch (e) {
    return respError(e);
  }
}
