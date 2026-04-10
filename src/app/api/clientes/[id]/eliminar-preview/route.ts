import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/middleware/auth";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { getTenantSupabaseFromAuthWithRol } from "@/lib/supabase/tenant-api";


/**
 * GET /api/clientes/:id/eliminar-preview
 * Datos previos a eliminación lógica: suscripciones activas, facturas con saldo,
 * bloqueos duros (ventas / tipificaciones).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await getTenantSupabaseFromAuthWithRol();
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const { auth, supabase } = ctx;

    if (!isAdmin(auth)) {
      return NextResponse.json(errorResponse("Solo administradores pueden consultar la eliminación de clientes"), { status: 403 });
    }

    const { id: clienteId } = await params;
    if (!clienteId) {
      return NextResponse.json(errorResponse("id es obligatorio"), { status: 400 });
    }

    const { data: cliente } = await supabase
      .from("clientes")
      .select("id, empresa_id, deleted_at")
      .eq("id", clienteId)
      .eq("empresa_id", auth.empresa_id)
      .is("deleted_at", null)
      .single();

    if (!cliente) {
      return NextResponse.json(errorResponse("Cliente no encontrado o ya eliminado"), { status: 404 });
    }

    const [suscRes, factRes, ventasRes, tipifRes] = await Promise.all([
      supabase
        .from("suscripciones")
        .select("id, precio, moneda")
        .eq("cliente_id", clienteId)
        .eq("empresa_id", auth.empresa_id)
        .eq("estado", "activa"),
      supabase
        .from("facturas")
        .select("id, numero_factura, monto, saldo, fecha, estado")
        .eq("cliente_id", clienteId)
        .eq("empresa_id", auth.empresa_id)
        .neq("estado", "Anulado")
        .gt("saldo", 0)
        .order("fecha", { ascending: false }),
      supabase.from("ventas").select("id").eq("cliente_id", clienteId).limit(1),
      supabase.from("tipificaciones").select("id").eq("cliente_id", clienteId).limit(1),
    ]);

    const suscripcionesActivas = suscRes.data ?? [];
    const facturasPendientes = factRes.data ?? [];
    const tieneVentas = (ventasRes.data?.length ?? 0) > 0;
    const tieneTipificaciones = (tipifRes.data?.length ?? 0) > 0;
    const puedeEliminar = !tieneVentas && !tieneTipificaciones;

    const bloqueos: string[] = [];
    if (tieneVentas) bloqueos.push("ventas");
    if (tieneTipificaciones) bloqueos.push("tipificaciones");

    return NextResponse.json(
      successResponse({
        suscripciones_activas: suscripcionesActivas.length,
        suscripciones: suscripcionesActivas,
        facturas_pendientes_count: facturasPendientes.length,
        factura_ejemplo:
          facturasPendientes.length > 0
            ? {
                id: facturasPendientes[0].id,
                numero_factura: facturasPendientes[0].numero_factura,
                monto: facturasPendientes[0].monto,
              }
            : null,
        puede_eliminar: puedeEliminar,
        bloqueos,
      })
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
