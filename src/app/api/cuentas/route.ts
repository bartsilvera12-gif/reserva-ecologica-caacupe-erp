import { NextRequest, NextResponse } from "next/server";
import { successResponse } from "@/lib/api/response";
import { resolverCtx, respError } from "./_ctx";
import { resumenSaldos, listarCuentas } from "@/lib/cuentas/server/cuentas-pg";

/**
 * GET /api/cuentas            → resumen: cuentas con saldo, efectivo del Market y total general.
 * GET /api/cuentas?lista=1    → solo las cuentas activas (para los selectores de ventas, compras, gastos, cobros).
 */
export async function GET(request: NextRequest) {
  const r = await resolverCtx(request);
  if (!r.ok) return r.response;
  try {
    if (new URL(request.url).searchParams.get("lista")) {
      const cuentas = await listarCuentas(r.ctx.schema, r.ctx.empresaId, { soloActivas: true });
      return NextResponse.json(
        successResponse({ cuentas: cuentas.map((c) => ({ id: c.id, nombre: c.nombre, tipo: c.tipo })) })
      );
    }
    return NextResponse.json(successResponse(await resumenSaldos(r.ctx.schema, r.ctx.empresaId)));
  } catch (e) {
    return respError(e);
  }
}
