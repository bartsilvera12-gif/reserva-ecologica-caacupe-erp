import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { exigirSucursal, respuestaSucursalNoAsignada } from "@/lib/sucursales/filtro";

/**
 * GET /api/inventario/movimientos — lista movimientos via PostgREST (compat Hostinger sin pool PG).
 */
export async function GET(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const empresaId = ctx.auth.empresa_id;

    const { data, error } = await ctx.supabase
      .from("movimientos_inventario")
      .select(
        "id, empresa_id, producto_id, producto_nombre, producto_sku, tipo, cantidad, costo_unitario, origen, referencia, fecha, created_at, updated_at, created_by, usuario_nombre"
      )
      .eq("empresa_id", empresaId)
      .eq("sucursal_id", exigirSucursal(ctx.auth.sucursal_id))
      .order("fecha", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);

    return NextResponse.json(successResponse({ movimientos: data ?? [] }));
  } catch (err) {
    const rSuc = respuestaSucursalNoAsignada(err);
    if (rSuc) return rSuc;
    console.error("[/api/inventario/movimientos GET]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudieron cargar los movimientos."), { status: 500 });
  }
}
