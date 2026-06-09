import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { ESTADOS_PRESUPUESTO, type EstadoPresupuesto } from "@/lib/presupuestos/types";

const PRESU_COLS =
  "id, cliente_id, cliente_nombre, cliente_ruc, cliente_telefono, cliente_direccion, " +
  "numero_control, estado, moneda, subtotal, monto_iva, descuento_total, total, validez_dias, " +
  "fecha, fecha_vencimiento, forma_pago, plazo_entrega, observaciones, " +
  "convertido_pedido_id, convertido_venta_id, created_at, updated_at";

const ITEM_COLS =
  "id, producto_id, producto_nombre, sku, cantidad, unidad_medida, precio_unitario, iva_tipo, subtotal, monto_iva, descuento, total";

/** GET /api/presupuestos/[id] — detalle + ítems. */
export async function GET(request: NextRequest, ctxParams: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctxParams.params;
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });

    const pq = await ctx.supabase
      .from("presupuestos")
      .select(PRESU_COLS)
      .eq("empresa_id", ctx.auth.empresa_id)
      .eq("id", id)
      .maybeSingle();
    if (pq.error) throw new Error(pq.error.message);
    if (!pq.data) return NextResponse.json(errorResponse(API_ERRORS.NOT_FOUND), { status: 404 });

    const itq = await ctx.supabase
      .from("presupuesto_items")
      .select(ITEM_COLS)
      .eq("empresa_id", ctx.auth.empresa_id)
      .eq("presupuesto_id", id)
      .order("created_at", { ascending: true });
    if (itq.error) throw new Error(itq.error.message);

    return NextResponse.json(successResponse({ presupuesto: pq.data, items: itq.data ?? [] }));
  } catch (err) {
    console.error("[/api/presupuestos/[id] GET]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo cargar el presupuesto."), { status: 500 });
  }
}

/**
 * PATCH /api/presupuestos/[id] — cambiar estado (creado|enviado|aprobado|rechazado).
 * NO permite setear 'convertido' por acá (eso lo hace /convertir). NO toca stock.
 */
export async function PATCH(request: NextRequest, ctxParams: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctxParams.params;
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json(errorResponse("JSON inválido."), { status: 400 });
    }

    const nuevoEstado = body.estado as EstadoPresupuesto | undefined;
    if (!nuevoEstado || !ESTADOS_PRESUPUESTO.includes(nuevoEstado)) {
      return NextResponse.json(errorResponse("Estado inválido."), { status: 400 });
    }
    if (nuevoEstado === "convertido") {
      return NextResponse.json(
        errorResponse("Para convertir usá la acción 'Convertir en pedido'."),
        { status: 400 }
      );
    }

    // No permitir cambiar el estado de un presupuesto ya convertido.
    const cur = await ctx.supabase
      .from("presupuestos")
      .select("estado")
      .eq("empresa_id", ctx.auth.empresa_id)
      .eq("id", id)
      .maybeSingle();
    if (cur.error) throw new Error(cur.error.message);
    if (!cur.data) return NextResponse.json(errorResponse(API_ERRORS.NOT_FOUND), { status: 404 });
    if ((cur.data as { estado: string }).estado === "convertido") {
      return NextResponse.json(errorResponse("El presupuesto ya fue convertido; no se puede cambiar su estado."), { status: 409 });
    }

    const upd = await ctx.supabase
      .from("presupuestos")
      .update({ estado: nuevoEstado, updated_at: new Date().toISOString() })
      .eq("empresa_id", ctx.auth.empresa_id)
      .eq("id", id)
      .select(PRESU_COLS)
      .maybeSingle();
    if (upd.error) throw new Error(upd.error.message);
    if (!upd.data) return NextResponse.json(errorResponse(API_ERRORS.NOT_FOUND), { status: 404 });

    return NextResponse.json(successResponse({ presupuesto: upd.data }));
  } catch (err) {
    console.error("[/api/presupuestos/[id] PATCH]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo actualizar el presupuesto."), { status: 500 });
  }
}
