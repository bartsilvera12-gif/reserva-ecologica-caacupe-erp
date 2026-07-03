// Tipos de los reportes operativos (server-side, schema reservacaacupe).
// Fase 1: Estado de cuenta + Proveedores. Fase 2: Compras.
// (Ventas/Conciliación: pendientes.)

export interface MovimientoEstadoCuenta {
  fecha: string;
  tipo: string; // Venta | Compra | Gasto
  referencia: string;
  descripcion: string;
  entrada: number;
  salida: number;
}

export interface EstadoCuentaReporte {
  mes: string;
  ingresosVentas: number;
  compras: number;
  gastos: number;
  resultado: number; // ventas - compras - gastos
  /** Ventas a crédito del período (sin aplicación de pagos parciales). */
  porCobrar: number;
  /** Compras a crédito del período (sin aplicación de pagos parciales). */
  porPagar: number;
  movimientos: MovimientoEstadoCuenta[];
}

export interface ProveedorReporteRow {
  id: string;
  nombre: string;
  ruc: string | null;
  telefono: string | null;
  cantidad: number;
  total: number;
  ultima_compra: string | null;
}

export interface ProveedoresReporte {
  mes: string;
  totalProveedores: number;
  conCompras: number;
  totalComprado: number;
  compraPromedio: number;
  ultimaCompra: { numero_control: string; proveedor_nombre: string; total: number; fecha: string } | null;
  proveedores: ProveedorReporteRow[];
}

// ── Compras (modelo plano: filas de `compras` agrupadas por numero_control) ────

/** Una compra (agrupada por numero_control). subtotal/iva/total = suma de líneas. */
export interface CompraReporteRow {
  numero_control: string;
  fecha: string;
  proveedor_nombre: string;
  items_count: number;   // cantidad de líneas del grupo
  subtotal: number;
  monto_iva: number;
  total: number;
  tipo_pago: string;
  nro_timbrado: string | null;
  tiene_comprobante: boolean; // true si CUALQUIER línea del grupo tiene comprobante
  estado: "registrada" | "pendiente" | "pagada" | "anulada";
  anulada_at: string | null;
  anulacion_motivo: string | null;
  anulada_por_email: string | null;
  /** Lista compacta de productos comprados: "PROD A x2, PROD B x5". null si no hay líneas. */
  productos_resumen: string | null;
}

/** Una línea de compra (una fila de `compras`). */
export interface ItemCompradoRow {
  numero_control: string;
  fecha: string;
  proveedor_nombre: string;
  producto_nombre: string;
  cantidad: number;
  costo_unitario: number;
  total_linea: number;
}

export interface CompraProveedorTotal {
  proveedor_nombre: string;
  compras: number; // numero_control distintos
  total: number;
}

export interface CompraProductoTotal {
  producto_nombre: string;
  cantidad: number;
  gasto: number;
}

export interface ComprasReporte {
  mes: string;
  totalComprado: number;
  cantidad: number;       // COUNT(DISTINCT numero_control) — compras distintas
  cantidadItems: number;  // count(*) — líneas compradas
  compraMasAlta: { numero_control: string; proveedor_nombre: string; total: number } | null;
  proveedorMayor: { proveedor_nombre: string; total: number } | null;
  productoMasComprado: { producto_nombre: string; cantidad: number } | null;
  productoMayorGasto: { producto_nombre: string; gasto: number } | null;
  porProveedor: CompraProveedorTotal[];
  porProducto: CompraProductoTotal[];
  compras: CompraReporteRow[];
  items: ItemCompradoRow[];
}

// ── Ventas (header `ventas` + líneas `ventas_items`, con tipo_precio) ──────────

export type TipoPrecioReporte = "minorista" | "mayorista" | "distribuidor" | "costo";

/** Totales por nivel de precio: monto e ítems (líneas). */
export interface VentaTipoPrecioTotal {
  items: number;
  total: number;
}

export interface VentaProductoTotal {
  producto_nombre: string;
  cantidad: number;
  total: number;
}

/** Una venta (cabecera). */
export interface VentaReporteRow {
  id: string;
  numero_control: string;
  fecha: string;
  cliente: string | null;
  metodo_pago: string | null;
  items_count: number;
  total: number;
  estado: "pendiente" | "completada" | "anulada";
  anulada_at: string | null;
  anulacion_motivo: string | null;
  anulada_por_email: string | null;
  /** Lista compacta de productos vendidos: "PROD A x2, PROD B x1". null si no hay líneas. */
  productos_resumen: string | null;
}

/** Una línea de venta. tipo_precio nunca null en la salida (null → 'minorista'). */
export interface ItemVendidoRow {
  numero_control: string;
  fecha: string;
  producto_nombre: string;
  cantidad: number;
  precio_venta: number;
  subtotal: number;
  monto_iva: number;
  total_linea: number;
  tipo_precio: TipoPrecioReporte;
}

export interface VentasReporte {
  mes: string;
  totalVendido: number;
  cantidadVentas: number;
  cantidadItems: number;     // líneas vendidas
  ticketPromedio: number;
  unidadesVendidas: number;  // SUM(cantidad)
  /** Desglose por nivel de precio (datos null se cuentan como minorista). */
  porTipoPrecio: Record<TipoPrecioReporte, VentaTipoPrecioTotal>;
  porProducto: VentaProductoTotal[];
  ventas: VentaReporteRow[];
  items: ItemVendidoRow[];
}

// ── Conciliación bancaria (ventas_pagos_detalle, venta-céntrico) ──────────────

export interface ConciliacionAgrupado {
  clave: string;   // método o entidad
  cantidad: number;
  total: number;
}

/**
 * Un movimiento bancario a conciliar: cobro de venta contado (no efectivo) o
 * cobro de cuenta por cobrar (no efectivo). El efectivo NO entra en conciliación.
 */
export interface ConciliacionMovRow {
  id: string;
  tipo: "venta" | "cobro";
  fecha: string;
  numero: string | null;       // N° de venta asociado
  cliente: string | null;
  metodo_pago: string | null;
  entidad: string | null;
  entidad_codigo: string | null;
  referencia: string | null;   // N° de comprobante
  titular: string | null;
  monto: number;
  estado: "pendiente" | "aprobado" | "rechazado";
}

export interface ConciliacionReporte {
  mes: string;
  totalCobrado: number;          // SUM(monto) de movimientos bancarios (no efectivo)
  cantidadOperaciones: number;   // cantidad de movimientos
  porMetodo: ConciliacionAgrupado[];
  porEntidad: ConciliacionAgrupado[];
  movimientos: ConciliacionMovRow[];
}
