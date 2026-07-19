import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { facturarPresupuestoDirecto } from "@/lib/presupuestos/server/presupuestos-pg";
import { StockInsuficienteError } from "@/lib/ventas/server/create-venta-pg";
import { exigirSucursal, respuestaSucursalNoAsignada } from "@/lib/sucursales/filtro";

/**
 * POST /api/presupuestos/[id]/facturar
 * Facturación directa desde presupuesto aprobado: genera venta + descuenta stock
 * + emite factura vía el puente venta→factura (arranca pipeline SIFEN si corresponde).
 * NO pasa por proyecto/pedido ni por el formulario /ventas/nueva.
 */
export async function POST(
  request: NextRequest,
  ctxParams: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await ctxParams.params;
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const schema = await fetchDataSchemaForEmpresaId(ctx.auth.empresa_id);

    const result = await facturarPresupuestoDirecto(
      ctx.supabase,
      schema,
      ctx.auth.empresa_id,
      exigirSucursal(ctx.auth.sucursal_id),
      id,
      {
        createdBy: ctx.auth.usuarioCatalogId ?? null,
        usuarioNombre: ctx.auth.user?.email ?? null,
      }
    );

    return NextResponse.json(successResponse(result));
  } catch (err) {
    if (err instanceof StockInsuficienteError) {
      return NextResponse.json(
        { ...errorResponse("Stock insuficiente: requiere confirmación."), faltantes: err.faltantes },
        { status: 409 }
      );
    }
    const msg = err instanceof Error ? err.message : "No se pudo facturar el presupuesto.";
    const status = /ya fue convertido|ya fue facturado/i.test(msg)
      ? 409
      : /no encontrado|solo se puede|sin producto|sin ítems/i.test(msg)
      ? 400
      : 500;
    console.error("[/api/presupuestos/[id]/facturar]", msg);
    return NextResponse.json(errorResponse(msg), { status });
  }
}
