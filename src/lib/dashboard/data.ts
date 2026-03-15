import { queryEmpresa } from "@/lib/db/empresa";
import { getProspectos } from "@/lib/crm/storage";

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

export interface DashboardData {
  prospectos: ProspectoRaw[];
  clientes: ClienteRaw[];
  facturas: FacturaRaw[];
  tipificaciones: TipificacionRaw[];
  productos: ProductoRaw[];
  ventas: VentaRaw[];
  compras: CompraRaw[];
  gastos: GastoRaw[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toDateStr(v: string | null | undefined): string {
  if (!v) return "";
  const d = new Date(v);
  return isNaN(d.getTime()) ? "" : d.toISOString();
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
 * Prospectos se obtienen siempre desde getProspectos (CRM) — si el resto falla, prospectos se mantienen.
 * RLS filtra por empresa_id del usuario actual en tablas con queryEmpresa.
 */
export async function getDashboardData(): Promise<DashboardData> {
  // 1. Prospectos SIEMPRE desde el CRM (misma fuente que el Funnel). No depende de getEmpresaId.
  const prospectos = await fetchProspectos();

  // 2. Resto de tablas — si queryEmpresa falla (ej. usuario sin empresa_id), usamos arrays vacíos
  let clientes: ClienteRaw[] = [];
  let facturas: FacturaRaw[] = [];
  let tipificaciones: TipificacionRaw[] = [];
  let productos: ProductoRaw[] = [];
  let ventas: VentaRaw[] = [];
  let compras: CompraRaw[] = [];
  let gastos: GastoRaw[] = [];

  try {
    const [clientesQ, facturasQ, tipificacionesQ, productosQ, ventasQ, ventasItemsQ, comprasQ, gastosQ] =
      await Promise.all([
        (await queryEmpresa("clientes")).select("*"),
        (await queryEmpresa("facturas")).select("*"),
        (await queryEmpresa("tipificaciones")).select("*"),
        (await queryEmpresa("productos")).select("*"),
        (await queryEmpresa("ventas")).select("*"),
        (await queryEmpresa("ventas_items")).select("*"),
        (await queryEmpresa("compras")).select("*"),
        (await queryEmpresa("gastos")).select("id, monto, fecha"),
      ]);

    if (clientesQ.error) throw new Error(clientesQ.error.message);
    if (facturasQ.error) throw new Error(facturasQ.error.message);
    if (tipificacionesQ.error) throw new Error(tipificacionesQ.error.message);
    if (productosQ.error) throw new Error(productosQ.error.message);
    if (ventasQ.error) throw new Error(ventasQ.error.message);
    if (ventasItemsQ.error) throw new Error(ventasItemsQ.error.message);
    if (comprasQ.error) throw new Error(comprasQ.error.message);

    clientes = (clientesQ.data ?? []).map((r: Record<string, unknown>) => ({
      id: r.id as string,
      codigo_cliente: `CL-${(r.id as string).slice(0, 8).toUpperCase()}`,
      empresa: r.empresa as string | undefined,
      nombre_contacto: (r.nombre_contacto as string) ?? (r.nombre as string) ?? "",
      origen: (r.origen as string) ?? "MANUAL",
      created_at: toDateStr(r.created_at as string),
      vendedor_asignado: r.vendedor_asignado as string | undefined,
    }));

    facturas = (facturasQ.data ?? []).map((r: Record<string, unknown>) => ({
      id: r.id as string,
      cliente_id: r.cliente_id as string,
      numero_factura: (r.numero_factura as string) ?? "",
      fecha: toDateStr(r.fecha as string),
      fecha_vencimiento: toDateStr(r.fecha_vencimiento as string),
      monto: Number(r.monto) ?? 0,
      saldo: Number(r.saldo) ?? 0,
      estado: (r.estado as string) ?? "Pendiente",
      tipo: (r.tipo as string) ?? "credito",
      moneda: (r.moneda as string) ?? "GS",
    }));

    tipificaciones = (tipificacionesQ.data ?? []).map((r: Record<string, unknown>) => ({
      id: r.id as string,
      cliente_id: r.cliente_id as string,
      tipo_gestion: (r.tipo_gestion as string) ?? "",
      resultado: (r.resultado as string) ?? "",
      observacion: r.observacion as string | undefined,
      usuario: (r.usuario as string) ?? "",
      fecha: toDateStr(r.fecha as string),
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
        fecha: toDateStr(r.fecha as string),
      };
    });

    compras = (comprasQ.data ?? []).map((r: Record<string, unknown>) => ({
      id: r.id as string,
      producto_id: r.producto_id as string | undefined,
      producto_nombre: (r.producto_nombre as string) ?? "",
      proveedor_nombre: (r.proveedor_nombre as string) ?? "",
      total: Number(r.total) ?? 0,
      fecha: toDateStr(r.fecha as string),
    }));

    gastos = (gastosQ.data ?? []).map((r: Record<string, unknown>) => ({
      id: r.id as string,
      monto: Number(r.monto) ?? 0,
      fecha: (r.fecha as string) ?? "",
    }));
  } catch (err) {
    console.warn("[dashboard] Error cargando tablas empresa (clientes, facturas, etc.):", err);
    // prospectos ya cargados; clientes, facturas, etc. quedan vacíos
  }

  return {
    prospectos,
    clientes,
    facturas,
    tipificaciones,
    productos,
    ventas,
    compras,
    gastos,
  };
}
