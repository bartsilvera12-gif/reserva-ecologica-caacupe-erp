import type { AppSupabaseClient } from "@/lib/supabase/schema";

/**
 * Core reusable de anulación de venta:
 *   - Reintegra el stock que la venta había descontado (contraparte ENTRADA con
 *     origen='anulacion_venta' por cada SALIDA original vinculada a la venta).
 *   - Marca la CxC como 'anulado' (si existe y no tenía cobros — caller decide
 *     si esa validación bloquea o no).
 *   - Marca la venta como 'anulada' + trazabilidad (anulada_at, anulada_por, motivo).
 *
 * Usos:
 *   1) Endpoint /api/ventas/[id]/anular (venta sin factura o de operador que
 *      confirmó rollback voluntario) — verifica cobros antes de llamar.
 *   2) Endpoint /api/facturas/[id]/sifen/cancelar (cuando la factura tiene
 *      origen_venta_id) — llama best-effort DESPUÉS de que SET confirmó el
 *      DE cancelado. Si la venta ya estaba anulada, retorna alreadyAnulada:true.
 *
 * Rollback best-effort: si algún paso falla, revierte stock e inserciones
 * antes de propagar el error. NO usa transacciones PG (PostgREST).
 */

export interface AnularVentaCoreArgs {
  sb: AppSupabaseClient;
  empresaId: string;
  ventaId: string;
  motivo: string;
  /** auth.user.id — usuario que dispara la anulación. */
  userId: string;
  /** usuarioCatalogId — para trazar en movimientos_inventario.created_by. */
  movCreatedBy: string | null;
  /** email del usuario — snapshot en movimientos_inventario.usuario_nombre. */
  movUsuarioNombre: string | null;
}

export interface AnularVentaCoreResult {
  ok: true;
  alreadyAnulada: boolean;
  stockReintegrado: number;
  numeroControl: string | null;
}

export interface AnularVentaCoreError {
  ok: false;
  message: string;
  /** true si el motivo del error es "ya estaba anulada" (409). */
  alreadyAnulada?: boolean;
  /** true si es un problema de cobros aplicados en CxC (409). */
  hasCobros?: boolean;
  status?: number;
}

interface MovimientoRow {
  id: string;
  producto_id: string;
  producto_nombre: string;
  producto_sku: string;
  cantidad: number | string;
  costo_unitario: number | string;
  tipo: string;
}

export async function anularVentaCore(
  args: AnularVentaCoreArgs
): Promise<AnularVentaCoreResult | AnularVentaCoreError> {
  const { sb, empresaId, ventaId, motivo, userId, movCreatedBy, movUsuarioNombre } = args;

  const ventaQ = await sb
    .from("ventas")
    .select("id, estado, numero_control, fecha, tipo_venta")
    .eq("id", ventaId)
    .eq("empresa_id", empresaId)
    .maybeSingle();
  if (ventaQ.error) return { ok: false, message: ventaQ.error.message, status: 400 };
  if (!ventaQ.data) return { ok: false, message: "Venta no encontrada.", status: 404 };

  const venta = ventaQ.data as {
    id: string;
    estado: string;
    numero_control: string;
    fecha: string;
    tipo_venta: string;
  };

  if (venta.estado === "anulada") {
    return {
      ok: true,
      alreadyAnulada: true,
      stockReintegrado: 0,
      numeroControl: venta.numero_control,
    };
  }

  // CxC — buscamos si existe; caller decide qué hacer si hay cobros aplicados
  // (venta-anular endpoint bloquea; SIFEN cancel deja pasar).
  let cxcId: string | null = null;
  let cxcTuvoCobros = false;
  if (venta.tipo_venta === "CREDITO") {
    const cxcQ = await sb
      .from("cuentas_por_cobrar")
      .select("id, saldo, total, estado")
      .eq("venta_id", ventaId)
      .eq("empresa_id", empresaId)
      .maybeSingle();
    if (cxcQ.error) return { ok: false, message: cxcQ.error.message, status: 400 };
    if (cxcQ.data) {
      const cxc = cxcQ.data as { id: string; saldo: number | string; total: number | string };
      cxcId = cxc.id;
      const saldo = Number(cxc.saldo);
      const total = Number(cxc.total);
      cxcTuvoCobros = Number.isFinite(saldo) && Number.isFinite(total) && saldo < total;
    }
  }

  const movsQ = await sb
    .from("movimientos_inventario")
    .select("id, producto_id, producto_nombre, producto_sku, cantidad, costo_unitario, tipo")
    .eq("venta_id", ventaId)
    .eq("empresa_id", empresaId)
    .eq("tipo", "SALIDA");
  if (movsQ.error) return { ok: false, message: movsQ.error.message, status: 400 };
  const movs = (movsQ.data ?? []) as MovimientoRow[];

  const nowIso = new Date().toISOString();
  const referencia = `Anulación ${venta.numero_control}`;

  const entradasInsertadas: string[] = [];
  const stockPrevio: Array<{ producto_id: string; stock_actual: number }> = [];

  try {
    for (const m of movs) {
      const cantidad = Number(m.cantidad);
      if (!Number.isFinite(cantidad) || cantidad <= 0) continue;

      const prodQ = await sb
        .from("productos")
        .select("id, stock_actual")
        .eq("id", m.producto_id)
        .eq("empresa_id", empresaId)
        .maybeSingle();
      if (prodQ.error) throw new Error(prodQ.error.message);
      if (!prodQ.data) continue; // producto borrado: reintegro no aplica.
      const prod = prodQ.data as { id: string; stock_actual: number | string };
      const stockActual = Number(prod.stock_actual);
      const nuevoStock = stockActual + cantidad;

      const upd = await sb
        .from("productos")
        .update({ stock_actual: nuevoStock })
        .eq("id", m.producto_id)
        .eq("empresa_id", empresaId);
      if (upd.error) throw new Error(upd.error.message);
      stockPrevio.push({ producto_id: m.producto_id, stock_actual: stockActual });

      const ins = await sb
        .from("movimientos_inventario")
        .insert({
          empresa_id: empresaId,
          producto_id: m.producto_id,
          producto_nombre: m.producto_nombre,
          producto_sku: m.producto_sku,
          tipo: "ENTRADA",
          cantidad,
          costo_unitario: Number(m.costo_unitario) || 0,
          origen: "anulacion_venta",
          referencia,
          fecha: nowIso,
          venta_id: ventaId,
          created_by: movCreatedBy,
          usuario_nombre: movUsuarioNombre,
        })
        .select("id")
        .single();
      if (ins.error) throw new Error(ins.error.message);
      entradasInsertadas.push(String((ins.data as { id: string }).id));
    }

    // Anular CxC (si existe). El caller ya decidió si permite o no cobros.
    if (cxcId) {
      const updCxc = await sb
        .from("cuentas_por_cobrar")
        .update({ estado: "anulado", saldo: 0 })
        .eq("id", cxcId)
        .eq("empresa_id", empresaId);
      if (updCxc.error) throw new Error(updCxc.error.message);
    }

    const updVenta = await sb
      .from("ventas")
      .update({
        estado: "anulada",
        anulada_at: nowIso,
        anulada_por: userId,
        anulacion_motivo: motivo,
      })
      .eq("id", ventaId)
      .eq("empresa_id", empresaId);
    if (updVenta.error) throw new Error(updVenta.error.message);

    return {
      ok: true,
      alreadyAnulada: false,
      stockReintegrado: entradasInsertadas.length,
      numeroControl: venta.numero_control,
    };
  } catch (e) {
    // Rollback best-effort: revertir stock e inserciones.
    for (const s of stockPrevio) {
      try {
        await sb
          .from("productos")
          .update({ stock_actual: s.stock_actual })
          .eq("id", s.producto_id)
          .eq("empresa_id", empresaId);
      } catch {}
    }
    if (entradasInsertadas.length > 0) {
      try {
        await sb
          .from("movimientos_inventario")
          .delete()
          .in("id", entradasInsertadas)
          .eq("empresa_id", empresaId);
      } catch {}
    }
    return {
      ok: false,
      message: e instanceof Error ? e.message : "Error al anular la venta.",
      hasCobros: cxcTuvoCobros,
      status: 500,
    };
  }
}

/**
 * Chequeo previo para el endpoint /api/ventas/[id]/anular: si hay cobros
 * aplicados sobre la CxC de la venta, retorna true (el caller responde 409).
 * El helper anularVentaCore por sí solo NO bloquea por esto — es el caller
 * el que decide.
 */
export async function ventaTieneCobrosAplicados(
  sb: AppSupabaseClient,
  empresaId: string,
  ventaId: string
): Promise<boolean> {
  const cxcQ = await sb
    .from("cuentas_por_cobrar")
    .select("saldo, total")
    .eq("venta_id", ventaId)
    .eq("empresa_id", empresaId)
    .maybeSingle();
  if (cxcQ.error || !cxcQ.data) return false;
  const c = cxcQ.data as { saldo: number | string; total: number | string };
  const saldo = Number(c.saldo);
  const total = Number(c.total);
  return Number.isFinite(saldo) && Number.isFinite(total) && saldo < total;
}
