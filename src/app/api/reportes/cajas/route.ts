import { NextRequest, NextResponse } from "next/server";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { exigirSucursal, respuestaSucursalNoAsignada } from "@/lib/sucursales/filtro";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { resolverRangoCajas } from "@/lib/caja/reporte-rango";
import { getReporteCierresCaja } from "@/lib/caja/reporte-caja-pg";
import { sucursalManejaCaja } from "@/lib/caja/server/caja-pg";

/** GET /api/reportes/cajas?desde=YYYY-MM-DD&hasta=YYYY-MM-DD — reporte de cierres de caja. */
export async function GET(request: NextRequest) {
  const ctx = await getTenantSupabaseFromAuth(request);
  if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
  try {
    const sucursalId = exigirSucursal(ctx.auth.sucursal_id);
    const schema = await fetchDataSchemaForEmpresaId(ctx.auth.empresa_id);
    const sp = new URL(request.url).searchParams;
    const rango = resolverRangoCajas(sp.get("desde"), sp.get("hasta"));
    const manejaCaja = await sucursalManejaCaja(schema, ctx.auth.empresa_id, sucursalId);
    const reporte = await getReporteCierresCaja(schema, ctx.auth.empresa_id, sucursalId, rango, manejaCaja);
    return NextResponse.json(successResponse(reporte));
  } catch (e) {
    const sr = respuestaSucursalNoAsignada(e);
    if (sr) return sr;
    console.error("[/api/reportes/cajas]", e instanceof Error ? e.message : e);
    return NextResponse.json(errorResponse("No se pudo cargar el reporte de caja."), { status: 500 });
  }
}
