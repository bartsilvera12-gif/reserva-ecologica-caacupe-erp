import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { ESTADOS_PRESUPUESTO, type EstadoPresupuesto } from "@/lib/presupuestos/types";
import { actualizarPresupuesto, type PresupuestoItemInput } from "@/lib/presupuestos/server/presupuestos-pg";

const PRESU_COLS =
  "id, cliente_id, cliente_nombre, cliente_ruc, cliente_telefono, cliente_direccion, " +
  "numero_control, estado, moneda, subtotal, monto_iva, descuento_total, total, validez_dias, " +
  "fecha, fecha_vencimiento, forma_pago, plazo_entrega, fecha_entrega, observaciones, " +
  "convertido_pedido_id, convertido_venta_id, created_at, updated_at";

const ITEM_COLS =
  "id, producto_id, producto_nombre, sku, cantidad, unidad_medida, precio_unitario, iva_tipo, subtotal, monto_iva, descuento, total";

function asIva(v: unknown): "EXENTA" | "5%" | "10%" {
  return v === "EXENTA" || v === "5%" || v === "10%" ? v : "10%";
}

/** Valida y normaliza los ítems que llegan del cliente (el server recalcula totales). */
function parseItems(raw: unknown): PresupuestoItemInput[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: PresupuestoItemInput[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") return null;
    const r = x as Record<string, unknown>;
    const nombre = String(r.producto_nombre ?? "").trim();
    const cantidad = Number(r.cantidad);
    const precio = Number(r.precio_unitario);
    if (!nombre || !(cantidad > 0) || !(precio >= 0)) return null;
    out.push({
      producto_id: r.producto_id ? String(r.producto_id) : null,
      producto_nombre: nombre,
      sku: r.sku ? String(r.sku) : null,
      cantidad,
      unidad_medida: r.unidad_medida ? String(r.unidad_medida) : null,
      precio_unitario: precio,
      iva_tipo: asIva(r.iva_tipo),
      descuento: Math.max(0, Number(r.descuento) || 0),
    });
  }
  return out;
}

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
      .order("orden", { ascending: true })
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

/**
 * PUT /api/presupuestos/[id] — editar datos del cliente, condiciones e ítems.
 * Bloqueado si el presupuesto ya fue convertido/facturado. NO toca stock.
 */
export async function PUT(request: NextRequest, ctxParams: { params: Promise<{ id: string }> }) {
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

    const items = parseItems(body.items);
    if (!items) {
      return NextResponse.json(errorResponse("El presupuesto debe tener al menos un ítem válido."), { status: 400 });
    }
    const clienteNombre = String(body.cliente_nombre ?? "").trim();
    if (!clienteNombre) {
      return NextResponse.json(errorResponse("El nombre del cliente es obligatorio."), { status: 400 });
    }
    const validezRaw = body.validez_dias;
    const validez =
      validezRaw === null || validezRaw === undefined || String(validezRaw).trim() === ""
        ? null
        : Math.max(0, parseInt(String(validezRaw), 10) || 0) || null;

    const { id: outId, numero_control } = await actualizarPresupuesto(ctx.supabase, ctx.auth.empresa_id, id, {
      cliente_id: body.cliente_id ? String(body.cliente_id) : null,
      cliente_nombre: clienteNombre,
      cliente_ruc: body.cliente_ruc ? String(body.cliente_ruc) : null,
      cliente_telefono: body.cliente_telefono ? String(body.cliente_telefono) : null,
      cliente_direccion: body.cliente_direccion ? String(body.cliente_direccion) : null,
      moneda: body.moneda === "USD" ? "USD" : "PYG",
      validez_dias: validez,
      forma_pago: body.forma_pago ? String(body.forma_pago) : null,
      plazo_entrega: body.plazo_entrega ? String(body.plazo_entrega) : null,
      fecha_entrega: (() => {
        const v = body.fecha_entrega;
        if (v == null) return null;
        const s = String(v).trim();
        return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
      })(),
      observaciones: body.observaciones ? String(body.observaciones).slice(0, 4000) : null,
      items,
    });

    return NextResponse.json(successResponse({ id: outId, numero_control }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudo editar el presupuesto.";
    const status = /convertido|facturado/i.test(msg)
      ? 409
      : /no encontrado/i.test(msg)
        ? 404
        : /obligatorio|al menos un|inválid/i.test(msg)
          ? 400
          : 500;
    console.error("[/api/presupuestos/[id] PUT]", msg);
    return NextResponse.json(errorResponse(msg), { status });
  }
}
