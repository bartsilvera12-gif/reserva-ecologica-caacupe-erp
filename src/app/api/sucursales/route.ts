import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";

/**
 * GET /api/sucursales — sucursales activas de la empresa.
 *
 * Se usa para el selector del alta de usuarios. NO filtra por la sucursal del
 * usuario: para asignarle una sucursal a alguien hay que poder ver la lista
 * completa. Solo devuelve id/código/nombre, ningún dato operativo.
 */
export async function GET(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });

    const { data, error } = await ctx.supabase
      .from("sucursales")
      .select("id, codigo, nombre, es_principal")
      .eq("empresa_id", ctx.auth.empresa_id)
      .eq("activa", true)
      .order("es_principal", { ascending: false })
      .order("nombre");
    if (error) throw new Error(error.message);

    return NextResponse.json(successResponse({ sucursales: data ?? [] }));
  } catch (err) {
    console.error("[/api/sucursales GET]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudieron cargar las sucursales."), { status: 500 });
  }
}
