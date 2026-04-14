/**
 * Emisión de factura de suscripción desde rutas API (sin localStorage / getCurrentUser).
 */
import type { AppSupabaseClient } from "@/lib/supabase/schema";
import { montosFacturaItemParaInsert } from "./factura-item-montos";
import { emitEvent, EVENT_TYPES } from "@/lib/integrations/events";
import { fechaVencimientoSuscripcion, hoyYmdLocal } from "@/lib/fechas/calendario";

export async function obtenerSiguienteNumeroFacturaEmpresa(
  supabase: AppSupabaseClient,
  empresaId: string
): Promise<string> {
  const prefijoDefault = process.env.FACTURA_PREFIJO ?? "FAC-";

  // Camino principal: función SQL transaccional (contador por empresa/schema).
  const { data: rpc, error: rpcErr } = await supabase.rpc("next_numero_factura_empresa", {
    p_empresa_id: empresaId,
    p_prefijo_default: prefijoDefault,
  });
  if (!rpcErr && typeof rpc === "string" && rpc.trim() !== "") {
    return rpc.trim();
  }

  // Fallback de compatibilidad si la migración aún no fue aplicada.
  const { data: ultima } = await supabase
    .from("facturas")
    .select("numero_factura")
    .eq("empresa_id", empresaId)
    .order("created_at", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let max = 0;
  let prefijo = prefijoDefault;
  const nUlt = String((ultima as { numero_factura?: string } | null)?.numero_factura ?? "").trim();
  const pUlt = nUlt.replace(/(\d+)$/, "");
  if (pUlt.trim()) prefijo = pUlt;

  // Escaneo paginado para evitar tope fijo (solo se usa si falta la migración).
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data: page, error: pageErr } = await supabase
      .from("facturas")
      .select("numero_factura")
      .eq("empresa_id", empresaId)
      .range(from, from + pageSize - 1);
    if (pageErr || !page?.length) break;
    for (const r of page) {
      const n = String((r as { numero_factura?: string }).numero_factura ?? "").trim();
      const m = n.match(/(\d+)$/);
      if (!m) continue;
      const num = Number(m[1]);
      if (Number.isFinite(num) && num > max) max = num;
    }
    if (page.length < pageSize) break;
    from += pageSize;
  }

  return `${prefijo}${String(max + 1).padStart(6, "0")}`;
}

export type SuscripcionFacturaRow = {
  id: string;
  cliente_id: string;
  plan_id: string | null;
  precio: number;
  moneda: string;
  dia_facturacion?: number | null;
  dia_vencimiento?: number | null;
};

/**
 * Si no hay factura del mes calendario actual para esa suscripción, crea una (equivalente a emitir este mes).
 */
export async function crearFacturaInicialSuscripcionSiCorresponde(opts: {
  supabase: AppSupabaseClient;
  empresaId: string;
  suscripcion: SuscripcionFacturaRow;
}): Promise<void> {
  const { supabase, empresaId, suscripcion } = opts;
  const hoy = hoyYmdLocal();
  const y = new Date().getFullYear();
  const m = new Date().getMonth() + 1;
  const mesActual = `${y}-${String(m).padStart(2, "0")}`;
  const nextM = m === 12 ? 1 : m + 1;
  const nextY = m === 12 ? y + 1 : y;
  const mesSiguiente = `${nextY}-${String(nextM).padStart(2, "0")}`;

  const { data: existentes } = await supabase
    .from("facturas")
    .select("id")
    .eq("cliente_id", suscripcion.cliente_id)
    .eq("suscripcion_id", suscripcion.id)
    .eq("empresa_id", empresaId)
    .gte("fecha", `${mesActual}-01`)
    .lt("fecha", `${mesSiguiente}-01`)
    .limit(1);

  if (existentes && existentes.length > 0) return;

  const monto = Number(suscripcion.precio);
  if (!Number.isFinite(monto) || monto <= 0) return;

  const numeroFactura = await obtenerSiguienteNumeroFacturaEmpresa(supabase, empresaId);
  const moneda = suscripcion.moneda === "USD" ? "USD" : "GS";
  const diaVencCfg = Math.min(Math.max(1, Number(suscripcion.dia_vencimiento) || 10), 31);
  const fechaVenc = fechaVencimientoSuscripcion(hoy, diaVencCfg);

  const { data: factura, error: errFact } = await supabase
    .from("facturas")
    .insert({
      empresa_id: empresaId,
      cliente_id: suscripcion.cliente_id,
      suscripcion_id: suscripcion.id,
      numero_factura: numeroFactura,
      fecha: hoy,
      fecha_vencimiento: fechaVenc,
      monto,
      saldo: monto,
      estado: "Pendiente",
      tipo: "suscripcion",
      moneda,
    })
    .select()
    .single();

  if (errFact || !factura) {
    console.error("[crearFacturaInicialSuscripcionSiCorresponde]", errFact?.message);
    return;
  }

  let planNombre = "Suscripción";
  if (suscripcion.plan_id) {
    const { data: plan } = await supabase
      .from("planes")
      .select("nombre")
      .eq("id", suscripcion.plan_id)
      .maybeSingle();
    if (plan?.nombre) planNombre = plan.nombre;
  }

  const linea = montosFacturaItemParaInsert({
    totalLinea: monto,
    moneda,
    cantidad: 1,
    precioUnitario: monto,
  });

  const { error: errItem } = await supabase.from("factura_items").insert({
    factura_id: factura.id,
    empresa_id: empresaId,
    descripcion: planNombre,
    cantidad: 1,
    precio_unitario: linea.precio_unitario,
    subtotal: linea.subtotal,
    iva: linea.iva,
    total: linea.total,
  });

  if (errItem) {
    console.error("[crearFacturaInicialSuscripcionSiCorresponde] factura_items:", errItem.message);
  }

  await emitEvent(EVENT_TYPES.factura_creada, {
    factura_id: factura.id,
    cliente_id: suscripcion.cliente_id,
    monto: (factura as { monto: number }).monto,
  });
}
