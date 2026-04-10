import { getBrowserSupabaseForEmpresaData } from "@/lib/supabase/browser-data-client";
import { getProspectos } from "@/lib/crm/storage";
import { toCalendarDateStr } from "@/lib/fechas/calendario";

// ── Tipos de salida (estructura esperada por el Dashboard en page.tsx) ────────

export interface ProspectoRaw {
  id: number | string;
  empresa: string;
  contacto?: string;
  etapa: string;
  servicio?: string;
  valor_estimado?: number;
  fecha_creacion: string;
  fecha_actualizacion: string;
  responsable?: string;
  cliente_creado?: boolean;
}

export interface ClienteRaw {
  id: number | string;
  codigo_cliente: string;
  empresa?: string;
  nombre_contacto: string;
  origen: string;
  created_at: string;
  vendedor_asignado?: string;
  /** Para distribución en dashboard (prioridad: tipo servicio → condición → origen) */
  tipo_servicio_cliente?: string;
  condicion_pago?: string;
}

export interface FacturaRaw {
  id: number | string;
  cliente_id: number | string;
  numero_factura: string;
  fecha: string;
  fecha_vencimiento: string;
  monto: number;
  saldo: number;
  estado: string;
  tipo: string;
  moneda: string;
}

export interface TipificacionRaw {
  id: number | string;
  cliente_id: number | string;
  tipo_gestion: string;
  resultado: string;
  observacion?: string;
  usuario: string;
  fecha: string;
}

export interface ProductoRaw {
  id: number | string;
  nombre: string;
  sku: string;
  costo_promedio: number;
  precio_venta: number;
  stock_actual: number;
  stock_minimo: number;
  unidad_medida: string;
  metodo_valuacion: string;
}

export interface LineaVentaRaw {
  producto_id: number | string;
  producto_nombre: string;
  sku?: string;
  cantidad: number;
  precio_venta: number;
  subtotal: number;
  monto_iva?: number;
  total: number;
}

export interface VentaRaw {
  id: number | string;
  numero_control: string;
  lineas: LineaVentaRaw[];
  subtotal: number;
  monto_iva: number;
  total: number;
  tipo_venta: string;
  moneda: string;
  tipo_cambio?: number;
  fecha: string;
}

export interface CompraRaw {
  id: number | string;
  producto_id?: number | string;
  producto_nombre: string;
  proveedor_nombre: string;
  total: number;
  fecha: string;
}

export interface GastoRaw {
  id: string;
  monto: number;
  fecha: string;
}

export interface PagoRaw {
  id: string;
  factura_id: string;
  monto: number;
  fecha_pago: string;
}

/** Suscripciones para métricas comerciales (valor cliente nuevo en período). */
export interface SuscripcionDashRow {
  id: string;
  cliente_id: string;
  precio: number;
  moneda: string;
  fecha_inicio: string;
  created_at: string;
}

export interface DashboardData {
  prospectos: ProspectoRaw[];
  clientes: ClienteRaw[];
  facturas: FacturaRaw[];
  pagos: PagoRaw[];
  tipificaciones: TipificacionRaw[];
  productos: ProductoRaw[];
  ventas: VentaRaw[];
  compras: CompraRaw[];
  gastos: GastoRaw[];
  suscripciones: SuscripcionDashRow[];
  /** Clientes dados de baja operativa en el mes actual */
  clientes_baja_mes: number;
  /** Monto mensual perdido por bajas del mes (suma de precios de suscripciones canceladas) */
  monto_perdido_bajas_mes: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Timestamps (created_at, etc.): mantener ISO de Supabase sin recomputar UTC desde date-only. */
function toIsoTimestampStr(v: string | null | undefined): string {
  if (!v) return "";
  const s = String(v).trim();
  if (s.includes("T")) return s;
  const d = new Date(s);
  return isNaN(d.getTime()) ? "" : d.toISOString();
}

/**
 * Convierte cualquier valor a número seguro.
 * Formato Paraguay: "450.000" = 450 mil, "450.000.000" = 450 millones.
 * Evita que "450.000" se parsee como 450 (parseFloat corta en el primer punto).
 */
function toNum(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const s = v.replace(/\s/g, "").trim();
    if (!s) return 0;
    // Si tiene coma: decimal europeo (1.234,56)
    if (s.includes(",")) {
      const [intPart, decPart] = s.split(",");
      const n = parseFloat((intPart || "").replace(/\./g, "") + "." + (decPart || "0"));
      return Number.isFinite(n) ? n : 0;
    }
    // Si tiene punto: puede ser miles (450.000) o decimal (450.50)
    const parts = s.split(".");
    if (parts.length === 1) return parseFloat(parts[0]) || 0;
    const last = parts[parts.length - 1] || "";
    // Última parte 1-2 dígitos = decimales (450.50)
    if (last.length <= 2 && /^\d+$/.test(last)) {
      const n = parseFloat(parts.slice(0, -1).join("") + "." + last);
      return Number.isFinite(n) ? n : 0;
    }
    // Última parte 3+ dígitos = separador de miles (450.000)
    const n = parseFloat(parts.join(""));
    return Number.isFinite(n) ? n : 0;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ── getDashboardData ──────────────────────────────────────────────────────────

/**
 * Obtiene prospectos desde crm_prospectos (misma fuente que el CRM Funnel).
 * No depende de queryEmpresa/getEmpresaId — RLS filtra por empresa.
 */
async function fetchProspectos(): Promise<ProspectoRaw[]> {
  const prospectosFromCrm = await getProspectos();
  return prospectosFromCrm.map((p) => ({
    id: p.id,
    empresa: p.empresa,
    contacto: p.contacto,
    etapa: p.etapa,
    servicio: p.servicio,
    valor_estimado: p.valor_estimado ?? 0,
    fecha_creacion: p.fecha_creacion ?? "",
    fecha_actualizacion: p.fecha_actualizacion ?? "",
    responsable: p.responsable,
    cliente_creado: p.cliente_creado,
  }));
}

/**
 * Obtiene todos los datos necesarios para el Dashboard desde Supabase.
 * RLS filtra por empresa_id automáticamente según el usuario autenticado.
 */
export async function getDashboardData(): Promise<DashboardData> {
  const prospectos = await fetchProspectos();
  const supabase = await getBrowserSupabaseForEmpresaData();

  let clientes: ClienteRaw[] = [];
  let facturas: FacturaRaw[] = [];
  let pagos: PagoRaw[] = [];
  let tipificaciones: TipificacionRaw[] = [];
  let productos: ProductoRaw[] = [];
  let ventas: VentaRaw[] = [];
  let compras: CompraRaw[] = [];
  let gastos: GastoRaw[] = [];
  let suscripciones: SuscripcionDashRow[] = [];
  let clientesBajaMes = 0;
  let montoPerdidoBajasMes = 0;

  try {
    const now = new Date();
    const anio = now.getFullYear();
    const mes = now.getMonth() + 1;
    const inicioMes = `${anio}-${String(mes).padStart(2, "0")}-01`;
    const finMes = `${anio}-${String(mes).padStart(2, "0")}-31`;

    const [clientesQ, facturasQ, pagosQ, tipificacionesQ, productosQ, ventasQ, ventasItemsQ, comprasQ, gastosQ, suscripcionesDashQ, bajasQ, suscBajasQ] =
      await Promise.all([
        supabase.from("clientes").select("*").is("deleted_at", null),
        supabase.from("facturas").select("*"),
        supabase.from("pagos").select("id, factura_id, monto, fecha_pago"),
        supabase.from("tipificaciones").select("*"),
        supabase.from("productos").select("*"),
        supabase.from("ventas").select("*"),
        supabase.from("ventas_items").select("*"),
        supabase.from("compras").select("*"),
        supabase.from("gastos").select("id, monto, fecha"),
        supabase.from("suscripciones").select("id, cliente_id, precio, moneda, fecha_inicio, created_at"),
        supabase.from("clientes").select("id").not("baja_operativa_at", "is", null).gte("baja_operativa_at", inicioMes).lte("baja_operativa_at", finMes + "T23:59:59.999Z"),
        supabase.from("suscripciones").select("cliente_id, precio").eq("estado", "cancelada"),
      ]);

    const clientesBajaIds = new Set((bajasQ.data ?? []).map((c: { id: string }) => c.id));
    const suscBajas = (suscBajasQ.data ?? []) as { cliente_id: string; precio: number }[];
    clientesBajaMes = clientesBajaIds.size;
    montoPerdidoBajasMes = suscBajas
      .filter((s) => clientesBajaIds.has(s.cliente_id))
      .reduce((sum, s) => sum + Number(s.precio ?? 0), 0);

    if (clientesQ.error) throw new Error(clientesQ.error.message);
    if (facturasQ.error) throw new Error(facturasQ.error.message);
    if (pagosQ.error) throw new Error(pagosQ.error.message);
    if (tipificacionesQ.error) throw new Error(tipificacionesQ.error.message);
    if (productosQ.error) throw new Error(productosQ.error.message);
    if (ventasQ.error) throw new Error(ventasQ.error.message);
    if (ventasItemsQ.error) throw new Error(ventasItemsQ.error.message);
    if (comprasQ.error) throw new Error(comprasQ.error.message);
    if (suscripcionesDashQ.error) throw new Error(suscripcionesDashQ.error.message);

    clientes = (clientesQ.data ?? []).map((r: Record<string, unknown>) => ({
      id: r.id as string,
      codigo_cliente: `CL-${(r.id as string).slice(0, 8).toUpperCase()}`,
      empresa: r.empresa as string | undefined,
      nombre_contacto: (r.nombre_contacto as string) ?? (r.nombre as string) ?? "",
      origen: (r.origen as string) ?? "MANUAL",
      created_at: toIsoTimestampStr(r.created_at as string),
      vendedor_asignado: r.vendedor_asignado as string | undefined,
      tipo_servicio_cliente: (r.tipo_servicio_cliente as string) ?? undefined,
      condicion_pago: (r.condicion_pago as string) ?? undefined,
    }));

    facturas = (facturasQ.data ?? []).map((r: Record<string, unknown>) => ({
      id: r.id as string,
      cliente_id: r.cliente_id as string,
      numero_factura: (r.numero_factura as string) ?? "",
      fecha: toCalendarDateStr(r.fecha as string),
      fecha_vencimiento: toCalendarDateStr(r.fecha_vencimiento as string),
      monto: toNum(r.monto),
      saldo: toNum(r.saldo),
      estado: (r.estado as string) ?? "Pendiente",
      tipo: (r.tipo as string) ?? "credito",
      moneda: (r.moneda as string) ?? "GS",
    }));

    pagos = (pagosQ.data ?? []).map((r: Record<string, unknown>) => ({
      id: r.id as string,
      factura_id: r.factura_id as string,
      monto: toNum(r.monto),
      fecha_pago: toCalendarDateStr(r.fecha_pago as string),
    }));

    tipificaciones = (tipificacionesQ.data ?? []).map((r: Record<string, unknown>) => ({
      id: r.id as string,
      cliente_id: r.cliente_id as string,
      tipo_gestion: (r.tipo_gestion as string) ?? "",
      resultado: (r.resultado as string) ?? "",
      observacion: r.observacion as string | undefined,
      usuario: (r.usuario as string) ?? "",
      fecha: toCalendarDateStr(r.fecha as string),
    }));

    productos = (productosQ.data ?? []).map((r: Record<string, unknown>) => ({
      id: r.id as string,
      nombre: (r.nombre as string) ?? "",
      sku: (r.sku as string) ?? "",
      costo_promedio: Number(r.costo_promedio) ?? 0,
      precio_venta: Number(r.precio_venta) ?? 0,
      stock_actual: Number(r.stock_actual) ?? 0,
      stock_minimo: Number(r.stock_minimo) ?? 0,
      unidad_medida: (r.unidad_medida as string) ?? "Unidad",
      metodo_valuacion: (r.metodo_valuacion as string) ?? "CPP",
    }));

    const itemsByVenta = new Map<string, LineaVentaRaw[]>();
    for (const it of ventasItemsQ.data ?? []) {
      const r = it as Record<string, unknown>;
      const ventaId = r.venta_id as string;
      const lineas = itemsByVenta.get(ventaId) ?? [];
      lineas.push({
        producto_id: r.producto_id as string,
        producto_nombre: (r.producto_nombre as string) ?? "",
        sku: r.sku as string | undefined,
        cantidad: Number(r.cantidad) ?? 0,
        precio_venta: Number(r.precio_venta) ?? 0,
        subtotal: Number(r.subtotal) ?? 0,
        monto_iva: Number(r.monto_iva) ?? 0,
        total: Number(r.total_linea) ?? 0,
      });
      itemsByVenta.set(ventaId, lineas);
    }

    ventas = (ventasQ.data ?? []).map((r: Record<string, unknown>) => {
      const id = r.id as string;
      return {
        id,
        numero_control: (r.numero_control as string) ?? "",
        lineas: itemsByVenta.get(id) ?? [],
        subtotal: Number(r.subtotal) ?? 0,
        monto_iva: Number(r.monto_iva) ?? 0,
        total: Number(r.total) ?? 0,
        tipo_venta: (r.tipo_venta as string) ?? "CONTADO",
        moneda: (r.moneda as string) ?? "GS",
        tipo_cambio: Number(r.tipo_cambio) ?? 1,
        fecha: toIsoTimestampStr(r.fecha as string),
      };
    });

    compras = (comprasQ.data ?? []).map((r: Record<string, unknown>) => ({
      id: r.id as string,
      producto_id: r.producto_id as string | undefined,
      producto_nombre: (r.producto_nombre as string) ?? "",
      proveedor_nombre: (r.proveedor_nombre as string) ?? "",
      total: toNum(r.total),
      fecha: toCalendarDateStr(r.fecha as string),
    }));

    gastos = (gastosQ.data ?? []).map((r: Record<string, unknown>) => ({
      id: r.id as string,
      monto: toNum(r.monto),
      fecha: (r.fecha as string) ?? "",
    }));

    suscripciones = (suscripcionesDashQ.data ?? []).map((r: Record<string, unknown>) => ({
      id: r.id as string,
      cliente_id: r.cliente_id as string,
      precio: toNum(r.precio),
      moneda: (r.moneda as string) ?? "GS",
      fecha_inicio: toCalendarDateStr(r.fecha_inicio as string),
      created_at: toIsoTimestampStr(r.created_at as string),
    }));
  } catch (err) {
    console.warn("[dashboard] Error cargando tablas empresa (clientes, facturas, etc.):", err);
    // prospectos ya cargados; clientes, facturas, etc. quedan vacíos
  }

  return {
    prospectos,
    clientes,
    facturas,
    pagos,
    tipificaciones,
    productos,
    ventas,
    compras,
    gastos,
    suscripciones,
    clientes_baja_mes: clientesBajaMes,
    monto_perdido_bajas_mes: montoPerdidoBajasMes,
  };
}
