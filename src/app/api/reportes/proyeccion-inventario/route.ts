import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { exigirSucursal } from "@/lib/sucursales/filtro";
import { getProyeccionInventario } from "@/lib/reportes/server/proyeccion-inventario-pg";

/** GET /api/reportes/proyeccion-inventario — proyección de quiebre por sucursal (read-only). */
export async function GET(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const empresaId = ctx.auth.empresa_id;
    const schema = await fetchDataSchemaForEmpresaId(empresaId);
    const sucursalId = exigirSucursal(ctx.auth.sucursal_id);

    // "Hoy" en zona horaria de Paraguay (YYYY-MM-DD).
    const hoyISO = new Date().toLocaleDateString("en-CA", { timeZone: "America/Asuncion" });

    const filas = await getProyeccionInventario(schema, empresaId, sucursalId, hoyISO);
    return NextResponse.json(successResponse({ filas, hoy: hoyISO }));
  } catch (err) {
    console.error("[/api/reportes/proyeccion-inventario]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo generar la proyección."), { status: 500 });
  }
}
