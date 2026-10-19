import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { duplicarPresupuesto } from "@/lib/presupuestos/server/presupuestos-pg";
import { exigirSucursal, respuestaSucursalNoAsignada } from "@/lib/sucursales/filtro";

/**
 * POST /api/presupuestos/[id]/duplicar — crea una copia nueva (estado 'creado',
 * número y fecha nuevos) con los mismos datos e ítems. No toca el original.
 */
export async function POST(request: NextRequest, ctxParams: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctxParams.params;
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });

    const { id: nuevoId, numero_control } = await duplicarPresupuesto(
      ctx.supabase,
      ctx.auth.empresa_id,
      exigirSucursal(ctx.auth.sucursal_id),
      id
    );

    return NextResponse.json(successResponse({ id: nuevoId, numero_control }));
  } catch (err) {
    const rSuc = respuestaSucursalNoAsignada(err);
    if (rSuc) return rSuc;
    const msg = err instanceof Error ? err.message : "No se pudo duplicar el presupuesto.";
    const status = /no encontrado/i.test(msg) ? 404 : /ítem|item/i.test(msg) ? 400 : 500;
    console.error("[/api/presupuestos/[id]/duplicar POST]", msg);
    return NextResponse.json(errorResponse(msg), { status });
  }
}
