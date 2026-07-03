import type { Venta } from "./types";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";

/** Un faltante de stock devuelto por el backend (409) para el modal de confirmación. */
export type FaltanteStock = {
  tipo: "producto" | "insumo";
  producto_id: string;
  nombre: string;
  sku: string;
  stock_actual: number;
  solicitado: number;
  faltante: number;
};

export type ResultadoGuardarVenta =
  | { success: true; venta: Venta }
  | { success: false; error: string; faltantes?: FaltanteStock[] };

/** Modalidad del pedido (instancia gastronómica En lo de Mari). */
export type PedidoCocinaInput = {
  modalidad: "local" | "delivery" | "carry_out";
  mesa?: string | null;
  cliente_nombre?: string | null;
  cliente_telefono?: string | null;
  direccion_entrega?: string | null;
  observacion?: string | null;
};

/** Detalle de cobro (conciliación bancaria) — opcional, 1 por venta. */
export type PagoDetalleInput = {
  entidad_bancaria_id?: string | null;
  entidad_nombre_snapshot?: string | null;
  referencia?: string | null;
  titular?: string | null;
  observacion?: string | null;
  fecha_acreditacion?: string | null;
};

/**
 * Lista ventas del tenant (misma fuente que el dashboard: tablas `ventas` / `ventas_items`).
 */
export async function getVentas(): Promise<Venta[]> {
  try {
    const res = await fetchWithSupabaseSession("/api/ventas", { cache: "no-store" });
    const json = (await res.json()) as {
      success?: boolean;
      data?: { ventas?: Venta[] };
      error?: string;
    };
    if (!res.ok || !json.success || !json.data?.ventas) {
      console.error("[ventas] getVentas:", json.error ?? res.statusText);
      return [];
    }
    return json.data.ventas;
  } catch (e) {
    console.error("[ventas] getVentas:", e);
    return [];
  }
}

/**
 * Crea una venta en base de datos (transacción servidor: ítems, stock, movimientos).
 */
export async function saveVenta(
  datos: Omit<Venta, "id" | "numero_control" | "fecha"> & { cliente_id?: string | null; genera_nota_remision?: boolean },
  pedidoCocina?: PedidoCocinaInput,
  pagoDetalle?: PagoDetalleInput | null,
  opts?: { permitirSinStock?: boolean; pedidoId?: string | null }
): Promise<ResultadoGuardarVenta> {
  if (!datos.items || datos.items.length === 0) {
    return { success: false, error: "La venta debe tener al menos un producto." };
  }

  try {
    const res = await fetchWithSupabaseSession("/api/ventas/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: datos.items,
        moneda: datos.moneda,
        tipo_cambio: datos.tipo_cambio,
        subtotal: datos.subtotal,
        monto_iva: datos.monto_iva,
        total: datos.total,
        tipo_venta: datos.tipo_venta,
        plazo_dias: datos.plazo_dias,
        metodo_pago: datos.metodo_pago,
        cliente_id: datos.cliente_id ?? null,
        observaciones: null,
        pedido_cocina: pedidoCocina ?? null,
        pago_detalle: pagoDetalle ?? null,
        permitir_sin_stock: opts?.permitirSinStock === true,
        genera_nota_remision: datos.genera_nota_remision === true,
        pedido_id: opts?.pedidoId ?? null,
      }),
    });

    const json = (await res.json()) as {
      success?: boolean;
      data?: { venta?: Venta };
      error?: string;
      faltantes?: FaltanteStock[];
    };

    if (!res.ok || !json.success || !json.data?.venta) {
      return {
        success: false,
        error: json.error ?? `No se pudo registrar la venta (${res.status}).`,
        faltantes: Array.isArray(json.faltantes) ? json.faltantes : undefined,
      };
    }

    return { success: true, venta: json.data.venta };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error de red.";
    return { success: false, error: msg };
  }
}

/** Anula una venta (ticket no fiscal). Reintegra stock y bloquea si tiene cobros aplicados. */
export async function anularVenta(
  ventaId: string,
  motivo: string
): Promise<{ success: true } | { success: false; error: string }> {
  try {
    const res = await fetchWithSupabaseSession(`/api/ventas/${ventaId}/anular`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ motivo }),
    });
    const json = (await res.json()) as { success?: boolean; error?: string };
    if (!res.ok || !json.success) {
      return { success: false, error: json.error ?? `No se pudo anular (${res.status}).` };
    }
    return { success: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error de red.";
    return { success: false, error: msg };
  }
}
