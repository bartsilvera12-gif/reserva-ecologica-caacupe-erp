import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { exigirSucursal } from "@/lib/sucursales/filtro";
import { getResumenPorVencer } from "@/lib/cuentas-por-pagar/server/cxp-pg";

/** GET /api/cuentas-por-pagar/resumen — facturas por vencer (dashboard), por sucursal. */
export async function GET(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const empresaId = ctx.auth.empresa_id;
    const schema = await fetchDataSchemaForEmpresaId(empresaId);
    const sucursalId = exigirSucursal(ctx.auth.sucursal_id);
    const hoyISO = new Date().toLocaleDateString("en-CA", { timeZone: "America/Asuncion" });
    const resumen = await getResumenPorVencer(schema, empresaId, sucursalId, hoyISO);
    return NextResponse.json(successResponse(resumen));
  } catch (err) {
    console.error("[/api/cuentas-por-pagar/resumen]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo cargar el resumen."), { status: 500 });
  }
}
