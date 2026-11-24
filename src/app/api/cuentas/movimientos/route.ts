import { NextRequest, NextResponse } from "next/server";
import { successResponse } from "@/lib/api/response";
import { resolverCtx, respError } from "../_ctx";
import { listarMovimientos } from "@/lib/cuentas/server/cuentas-pg";

/** GET /api/cuentas/movimientos?cuenta_id=&desde=YYYY-MM-DD&hasta=YYYY-MM-DD — historial con saldo corrido. */
export async function GET(request: NextRequest) {
  const r = await resolverCtx(request);
  if (!r.ok) return r.response;
  const sp = new URL(request.url).searchParams;
  const ymd = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const cuentaId = sp.get("cuenta_id");
  try {
    const movimientos = await listarMovimientos(r.ctx.schema, r.ctx.empresaId, {
      cuentaId: cuentaId && /^[0-9a-f-]{36}$/i.test(cuentaId) ? cuentaId : null,
      desde: ymd(sp.get("desde")),
      hasta: ymd(sp.get("hasta")),
    });
    return NextResponse.json(successResponse({ movimientos }));
  } catch (e) {
    return respError(e);
  }
}
