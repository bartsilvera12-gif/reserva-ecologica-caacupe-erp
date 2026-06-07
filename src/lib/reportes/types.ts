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
