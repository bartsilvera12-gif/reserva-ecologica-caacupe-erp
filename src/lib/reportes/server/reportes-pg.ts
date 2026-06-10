/**
 * Agregados SQL server-side para el módulo Reportes (schema reservacaacupe).
 * Fase 1: Estado de cuenta + Proveedores. Solo lectura sobre
 * ventas / compras / gastos / proveedores. Mismo patrón de pool que compras-pg.
 *
 * `start`/`end` = límites timestamptz del mes (para ventas/compras, fecha tz).
 * `mesInicio` = "YYYY-MM-01" (para gastos.fecha que es DATE).
 *
 * NOTA — modelo de compras de Reserva (PLANO): una compra multiproducto son N
 * filas en `compras` que comparten `numero_control` (no hay tabla `compras_items`).
 * Por eso, para contar "compras" reales se agrupa/cuenta por `numero_control`,
 * mientras que los SUM(total) ya son correctos (suman los totales de línea).
 */
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import type {
  EstadoCuentaReporte,
  MovimientoEstadoCuenta,
  ProveedoresReporte,
  ProveedorReporteRow,
  ComprasReporte,
  CompraReporteRow,
  ItemCompradoRow,
  CompraProveedorTotal,
  CompraProductoTotal,
  VentasReporte,
  VentaReporteRow,
  ItemVendidoRow,
  VentaProductoTotal,
  TipoPrecioReporte,
  ConciliacionReporte,
  ConciliacionAgrupado,
  ConciliacionVentaRow,
} from "@/lib/reportes/types";

function pool() {
  const p = getChatPostgresPool();
  if (!p) throw new Error("Pool no disponible.");
  return p;
}

export interface MesBounds {
  mes: string;
  start: string;
  end: string;
  mesInicio: string; // YYYY-MM-01
}

const num = (v: unknown): number => Number(v ?? 0) || 0;

// ── Estado de cuenta ─────────────────────────────────────────────────────────

export async function getEstadoCuenta(
  schemaRaw: string,
  empresaId: string,
  b: MesBounds
): Promise<EstadoCuentaReporte> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tVentas = quoteSchemaTable(schema, "ventas");
  const tCompras = quoteSchemaTable(schema, "compras");
  const tGastos = quoteSchemaTable(schema, "gastos");
  const p = pool();

  const ventasQ = p.query<{ total: number }>(
    `SELECT COALESCE(SUM(total),0)::float8 AS total FROM ${tVentas}
      WHERE empresa_id=$1::uuid AND fecha>=$2::timestamptz AND fecha<=$3::timestamptz`,
    [empresaId, b.start, b.end]
  );
  const comprasQ = p.query<{ total: number }>(
    `SELECT COALESCE(SUM(total),0)::float8 AS total FROM ${tCompras}
      WHERE empresa_id=$1::uuid AND fecha>=$2::timestamptz AND fecha<=$3::timestamptz`,
    [empresaId, b.start, b.end]
  );
  const gastosQ = p.query<{ total: number }>(
    `SELECT COALESCE(SUM(monto),0)::float8 AS total FROM ${tGastos}
      WHERE empresa_id=$1::uuid AND fecha>=$2::date AND fecha < ($2::date + interval '1 month')`,
    [empresaId, b.mesInicio]
  );
  const porCobrarQ = p.query<{ total: number }>(
    `SELECT COALESCE(SUM(total),0)::float8 AS total FROM ${tVentas}
      WHERE empresa_id=$1::uuid AND tipo_venta='CREDITO' AND fecha>=$2::timestamptz AND fecha<=$3::timestamptz`,
    [empresaId, b.start, b.end]
  );
  const porPagarQ = p.query<{ total: number }>(
    `SELECT COALESCE(SUM(total),0)::float8 AS total FROM ${tCompras}
      WHERE empresa_id=$1::uuid AND tipo_pago='credito' AND fecha>=$2::timestamptz AND fecha<=$3::timestamptz`,
    [empresaId, b.start, b.end]
  );
  // Compras agrupadas por numero_control (modelo plano): una fila por compra real.
  const movsQ = p.query<MovimientoEstadoCuenta>(
    `SELECT fecha, tipo, referencia, descripcion, entrada, salida FROM (
        SELECT fecha, 'Venta'::text AS tipo, numero_control AS referencia,
               'Venta a cliente'::text AS descripcion, total::float8 AS entrada, 0::float8 AS salida
          FROM ${tVentas}
         WHERE empresa_id=$1::uuid AND fecha>=$2::timestamptz AND fecha<=$3::timestamptz
        UNION ALL
        SELECT MIN(fecha) AS fecha, 'Compra'::text, numero_control,
               MIN(proveedor_nombre), 0::float8, SUM(total)::float8
          FROM ${tCompras}
         WHERE empresa_id=$1::uuid AND fecha>=$2::timestamptz AND fecha<=$3::timestamptz
         GROUP BY numero_control
        UNION ALL
        SELECT fecha::timestamptz, 'Gasto'::text, COALESCE(categoria,''),
               COALESCE(descripcion,''), 0::float8, monto::float8
          FROM ${tGastos}
         WHERE empresa_id=$1::uuid AND fecha>=$4::date AND fecha < ($4::date + interval '1 month')
      ) m ORDER BY fecha ASC`,
    [empresaId, b.start, b.end, b.mesInicio]
  );

  const [ventas, compras, gastos, porCobrar, porPagar, movs] = await Promise.all([
    ventasQ, comprasQ, gastosQ, porCobrarQ, porPagarQ, movsQ,
  ]);

  const ingresosVentas = num(ventas.rows[0]?.total);
  const comprasTotal = num(compras.rows[0]?.total);
  const gastosTotal = num(gastos.rows[0]?.total);

  return {
    mes: b.mes,
    ingresosVentas,
    compras: comprasTotal,
    gastos: gastosTotal,
    resultado: ingresosVentas - comprasTotal - gastosTotal,
    porCobrar: num(porCobrar.rows[0]?.total),
    porPagar: num(porPagar.rows[0]?.total),
    movimientos: movs.rows.map((m) => ({
      fecha: m.fecha,
      tipo: m.tipo,
      referencia: m.referencia,
      descripcion: m.descripcion,
      entrada: num(m.entrada),
      salida: num(m.salida),
    })),
  };
}

// ── Proveedores ──────────────────────────────────────────────────────────────

export async function getReporteProveedores(
  schemaRaw: string,
  empresaId: string,
  b: MesBounds
): Promise<ProveedoresReporte> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tProv = quoteSchemaTable(schema, "proveedores");
  const tC = quoteSchemaTable(schema, "compras");
  const p = pool();

  const totalProvQ = p.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${tProv} WHERE empresa_id=$1::uuid`, [empresaId]);
  const mesQ = p.query<{ proveedores: number; total: number }>(
    `SELECT count(DISTINCT proveedor_id)::int AS proveedores, COALESCE(SUM(total),0)::float8 AS total
       FROM ${tC} WHERE empresa_id=$1::uuid AND fecha>=$2::timestamptz AND fecha<=$3::timestamptz`,
    [empresaId, b.start, b.end]);
  // Última compra: total de la compra agrupada por numero_control (modelo plano).
  const ultimaQ = p.query<{ numero_control: string; proveedor_nombre: string; total: number; fecha: string }>(
    `SELECT numero_control, MIN(proveedor_nombre) AS proveedor_nombre,
            SUM(total)::float8 AS total, MAX(fecha) AS fecha
       FROM ${tC} WHERE empresa_id=$1::uuid AND fecha>=$2::timestamptz AND fecha<=$3::timestamptz
      GROUP BY numero_control
      ORDER BY MAX(fecha) DESC LIMIT 1`, [empresaId, b.start, b.end]);
  // Proveedores con sus métricas del mes (LEFT JOIN para incluir los sin compras).
  // `cantidad` = compras reales (numero_control distintos), no líneas.
  const provListQ = p.query<ProveedorReporteRow>(
    `SELECT pr.id, pr.nombre, pr.ruc, pr.telefono,
            COALESCE(cc.cantidad,0)::int AS cantidad,
            COALESCE(cc.total,0)::float8 AS total,
            cc.ultima_compra
       FROM ${tProv} pr
       LEFT JOIN (
         SELECT proveedor_id,
                count(DISTINCT numero_control)::int AS cantidad,
                SUM(total)::float8 AS total,
                MAX(fecha) AS ultima_compra
           FROM ${tC} WHERE empresa_id=$1::uuid AND fecha>=$2::timestamptz AND fecha<=$3::timestamptz
          GROUP BY proveedor_id
       ) cc ON cc.proveedor_id = pr.id
      WHERE pr.empresa_id=$1::uuid
      ORDER BY COALESCE(cc.total,0) DESC, pr.nombre ASC`,
    [empresaId, b.start, b.end]);

  const [totalProv, mes, ultima, provList] = await Promise.all([totalProvQ, mesQ, ultimaQ, provListQ]);

  const conCompras = num(mes.rows[0]?.proveedores);
  const totalComprado = num(mes.rows[0]?.total);

  return {
    mes: b.mes,
    totalProveedores: num(totalProv.rows[0]?.n),
    conCompras,
    totalComprado,
    compraPromedio: conCompras > 0 ? totalComprado / conCompras : 0,
    ultimaCompra: ultima.rows[0] ? { ...ultima.rows[0], total: num(ultima.rows[0].total) } : null,
    proveedores: provList.rows.map((r) => ({ ...r, cantidad: num(r.cantidad), total: num(r.total) })),
  };
}

// ── Compras (modelo PLANO: N filas en `compras` por numero_control) ───────────

export async function getReporteCompras(
  schemaRaw: string,
  empresaId: string,
  b: MesBounds
): Promise<ComprasReporte> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tC = quoteSchemaTable(schema, "compras");
  const p = pool();
  const per = `c.empresa_id=$1::uuid AND c.fecha>=$2::timestamptz AND c.fecha<=$3::timestamptz`;
  const args = [empresaId, b.start, b.end];

  // Totales: compras distintas (numero_control), líneas (count *) y total (suma de líneas).
  const totQ = p.query<{ compras: number; items: number; total: number }>(
    `SELECT count(DISTINCT numero_control)::int AS compras, count(*)::int AS items,
            COALESCE(SUM(total),0)::float8 AS total
       FROM ${tC} c WHERE ${per}`, args);
  // Compra más alta: total agrupado por numero_control.
  const masAltaQ = p.query<{ numero_control: string; proveedor_nombre: string; total: number }>(
    `SELECT numero_control, MIN(proveedor_nombre) AS proveedor_nombre, SUM(total)::float8 AS total
       FROM ${tC} c WHERE ${per} GROUP BY numero_control ORDER BY total DESC LIMIT 1`, args);
  const provMayorQ = p.query<{ proveedor_nombre: string; total: number }>(
    `SELECT proveedor_nombre, SUM(total)::float8 AS total FROM ${tC} c WHERE ${per}
      GROUP BY proveedor_id, proveedor_nombre ORDER BY total DESC LIMIT 1`, args);
  const prodCantQ = p.query<{ producto_nombre: string; cantidad: number }>(
    `SELECT producto_nombre, SUM(cantidad)::float8 AS cantidad FROM ${tC} c WHERE ${per}
      GROUP BY producto_id, producto_nombre ORDER BY cantidad DESC LIMIT 1`, args);
  const prodGastoQ = p.query<{ producto_nombre: string; gasto: number }>(
    `SELECT producto_nombre, SUM(total)::float8 AS gasto FROM ${tC} c WHERE ${per}
      GROUP BY producto_id, producto_nombre ORDER BY gasto DESC LIMIT 1`, args);
  // Total por proveedor (lista).
  const porProvQ = p.query<CompraProveedorTotal>(
    `SELECT proveedor_nombre, count(DISTINCT numero_control)::int AS compras, SUM(total)::float8 AS total
       FROM ${tC} c WHERE ${per} GROUP BY proveedor_id, proveedor_nombre ORDER BY total DESC`, args);
  // Total por producto (lista).
  const porProdQ = p.query<CompraProductoTotal>(
    `SELECT producto_nombre, SUM(cantidad)::float8 AS cantidad, SUM(total)::float8 AS gasto
       FROM ${tC} c WHERE ${per} GROUP BY producto_id, producto_nombre ORDER BY gasto DESC`, args);
  // Detalle por compra (agrupado por numero_control). tiene_comprobante = bool_or sobre las líneas.
  const comprasQ = p.query<CompraReporteRow>(
    `SELECT numero_control, MIN(fecha) AS fecha, MIN(proveedor_nombre) AS proveedor_nombre,
            count(*)::int AS items_count, SUM(subtotal)::float8 AS subtotal,
            SUM(monto_iva)::float8 AS monto_iva, SUM(total)::float8 AS total,
            MIN(tipo_pago) AS tipo_pago, MIN(nro_timbrado) AS nro_timbrado,
            bool_or(comprobante_storage_path IS NOT NULL) AS tiene_comprobante
       FROM ${tC} c WHERE ${per}
      GROUP BY numero_control ORDER BY MIN(fecha) DESC, numero_control DESC`, args);
  // Detalle por línea (una fila de compras = una línea).
  const itemsQ = p.query<ItemCompradoRow>(
    `SELECT numero_control, fecha, proveedor_nombre, producto_nombre,
            cantidad::float8 AS cantidad, costo_unitario::float8 AS costo_unitario,
            total::float8 AS total_linea
       FROM ${tC} c WHERE ${per} ORDER BY fecha DESC, numero_control DESC`, args);

  const [tot, masAlta, provMayor, prodCant, prodGasto, porProv, porProd, compras, items] =
    await Promise.all([totQ, masAltaQ, provMayorQ, prodCantQ, prodGastoQ, porProvQ, porProdQ, comprasQ, itemsQ]);

  return {
    mes: b.mes,
    totalComprado: num(tot.rows[0]?.total),
    cantidad: num(tot.rows[0]?.compras),
    cantidadItems: num(tot.rows[0]?.items),
    compraMasAlta: masAlta.rows[0]
      ? { numero_control: masAlta.rows[0].numero_control, proveedor_nombre: masAlta.rows[0].proveedor_nombre, total: num(masAlta.rows[0].total) }
      : null,
    proveedorMayor: provMayor.rows[0] ? { proveedor_nombre: provMayor.rows[0].proveedor_nombre, total: num(provMayor.rows[0].total) } : null,
    productoMasComprado: prodCant.rows[0] ? { producto_nombre: prodCant.rows[0].producto_nombre, cantidad: num(prodCant.rows[0].cantidad) } : null,
    productoMayorGasto: prodGasto.rows[0] ? { producto_nombre: prodGasto.rows[0].producto_nombre, gasto: num(prodGasto.rows[0].gasto) } : null,
    porProveedor: porProv.rows.map((r) => ({ ...r, compras: num(r.compras), total: num(r.total) })),
    porProducto: porProd.rows.map((r) => ({ ...r, cantidad: num(r.cantidad), gasto: num(r.gasto) })),
    compras: compras.rows.map((c) => ({
      ...c,
      items_count: num(c.items_count),
      subtotal: num(c.subtotal),
      monto_iva: num(c.monto_iva),
      total: num(c.total),
      nro_timbrado: c.nro_timbrado || null,
      tiene_comprobante: c.tiene_comprobante === true,
    })),
    items: items.rows.map((i) => ({
      ...i,
      cantidad: num(i.cantidad),
      costo_unitario: num(i.costo_unitario),
      total_linea: num(i.total_linea),
    })),
  };
}

// ── Ventas (cabecera `ventas` + líneas `ventas_items`, desglose por tipo_precio) ─

/** Normaliza tipo_precio (null/'' → minorista). */
const TP_SQL = `COALESCE(NULLIF(vi.tipo_precio,''),'minorista')`;
function normTipoPrecio(v: unknown): TipoPrecioReporte {
  return v === "mayorista" || v === "distribuidor" || v === "costo" ? v : "minorista";
}

export async function getReporteVentas(
  schemaRaw: string,
  empresaId: string,
  b: MesBounds
): Promise<VentasReporte> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tV = quoteSchemaTable(schema, "ventas");
  const tVI = quoteSchemaTable(schema, "ventas_items");
  const tCli = quoteSchemaTable(schema, "clientes");
  const p = pool();
  const perV = `v.empresa_id=$1::uuid AND v.fecha>=$2::timestamptz AND v.fecha<=$3::timestamptz`;
  const args = [empresaId, b.start, b.end];

  // Totales de cabecera.
  const totQ = p.query<{ ventas: number; total: number }>(
    `SELECT count(*)::int AS ventas, COALESCE(SUM(total),0)::float8 AS total
       FROM ${tV} v WHERE ${perV}`, args);
  // Ítems / unidades.
  const itemsTotQ = p.query<{ items: number; unidades: number }>(
    `SELECT count(*)::int AS items, COALESCE(SUM(vi.cantidad),0)::float8 AS unidades
       FROM ${tVI} vi JOIN ${tV} v ON v.id=vi.venta_id WHERE ${perV}`, args);
  // Desglose por tipo_precio (null → minorista).
  const tipoPrecioQ = p.query<{ tipo_precio: string; items: number; total: number }>(
    `SELECT ${TP_SQL} AS tipo_precio, count(*)::int AS items, COALESCE(SUM(vi.total_linea),0)::float8 AS total
       FROM ${tVI} vi JOIN ${tV} v ON v.id=vi.venta_id WHERE ${perV}
      GROUP BY ${TP_SQL}`, args);
  // Total por producto.
  const porProdQ = p.query<VentaProductoTotal>(
    `SELECT vi.producto_nombre, SUM(vi.cantidad)::float8 AS cantidad, SUM(vi.total_linea)::float8 AS total
       FROM ${tVI} vi JOIN ${tV} v ON v.id=vi.venta_id WHERE ${perV}
      GROUP BY vi.producto_id, vi.producto_nombre ORDER BY total DESC`, args);
  // Detalle de ventas (con cliente opcional).
  const ventasQ = p.query<VentaReporteRow>(
    `SELECT v.id, v.numero_control, v.fecha, c.nombre AS cliente, v.metodo_pago,
            (SELECT count(*) FROM ${tVI} vi WHERE vi.venta_id=v.id)::int AS items_count,
            v.total::float8 AS total
       FROM ${tV} v
       LEFT JOIN ${tCli} c ON c.id=v.cliente_id AND c.empresa_id=v.empresa_id
      WHERE ${perV} ORDER BY v.fecha DESC, v.numero_control DESC`, args);
  // Detalle por línea.
  const itemsQ = p.query<ItemVendidoRow>(
    `SELECT v.numero_control, v.fecha, vi.producto_nombre,
            vi.cantidad::float8 AS cantidad, vi.precio_venta::float8 AS precio_venta,
            vi.subtotal::float8 AS subtotal, vi.monto_iva::float8 AS monto_iva,
            vi.total_linea::float8 AS total_linea, ${TP_SQL} AS tipo_precio
       FROM ${tVI} vi JOIN ${tV} v ON v.id=vi.venta_id WHERE ${perV}
      ORDER BY v.fecha DESC, v.numero_control DESC`, args);

  const [tot, itemsTot, tipoPrecio, porProd, ventas, items] = await Promise.all([
    totQ, itemsTotQ, tipoPrecioQ, porProdQ, ventasQ, itemsQ]);

  const cantidadVentas = num(tot.rows[0]?.ventas);
  const totalVendido = num(tot.rows[0]?.total);
  const porTipoPrecio: Record<TipoPrecioReporte, { items: number; total: number }> = {
    minorista: { items: 0, total: 0 },
    mayorista: { items: 0, total: 0 },
    distribuidor: { items: 0, total: 0 },
    costo: { items: 0, total: 0 },
  };
  for (const r of tipoPrecio.rows) {
    porTipoPrecio[normTipoPrecio(r.tipo_precio)] = { items: num(r.items), total: num(r.total) };
  }

  return {
    mes: b.mes,
    totalVendido,
    cantidadVentas,
    cantidadItems: num(itemsTot.rows[0]?.items),
    ticketPromedio: cantidadVentas > 0 ? totalVendido / cantidadVentas : 0,
    unidadesVendidas: num(itemsTot.rows[0]?.unidades),
    porTipoPrecio,
    porProducto: porProd.rows.map((r) => ({ ...r, cantidad: num(r.cantidad), total: num(r.total) })),
    ventas: ventas.rows.map((v) => ({
      ...v,
      cliente: v.cliente || null,
      metodo_pago: v.metodo_pago || null,
      items_count: num(v.items_count),
      total: num(v.total),
    })),
    items: items.rows.map((i) => ({
      ...i,
      cantidad: num(i.cantidad),
      precio_venta: num(i.precio_venta),
      subtotal: num(i.subtotal),
      monto_iva: num(i.monto_iva),
      total_linea: num(i.total_linea),
      tipo_precio: normTipoPrecio(i.tipo_precio),
    })),
  };
}

// ── Conciliación bancaria (ventas del mes + detalle de cobro) ─────────────────

export async function getReporteConciliacion(
  schemaRaw: string,
  empresaId: string,
  b: MesBounds
): Promise<ConciliacionReporte> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tV = quoteSchemaTable(schema, "ventas");
  const tD = quoteSchemaTable(schema, "ventas_pagos_detalle");
  const tCob = quoteSchemaTable(schema, "cobros_clientes");
  const tCli = quoteSchemaTable(schema, "clientes");
  const p = pool();
  const perV = `v.empresa_id=$1::uuid AND v.fecha>=$2::timestamptz AND v.fecha<=$3::timestamptz`;
  const args = [empresaId, b.start, b.end];

  // Un detalle por venta (defensivo: el más reciente si hubiera más de uno).
  const detLateral = `LEFT JOIN LATERAL (
      SELECT d.metodo_pago, d.entidad_nombre_snapshot, d.referencia, d.titular, d.monto
        FROM ${tD} d WHERE d.venta_id=v.id AND d.empresa_id=v.empresa_id
       ORDER BY d.fecha_pago DESC LIMIT 1
    ) d ON true`;

  // Detalle por venta (todas las ventas del mes; con o sin cobro).
  const ventasQ = p.query<ConciliacionVentaRow & { con_detalle: boolean }>(
    `SELECT v.id AS venta_id, v.numero_control, v.fecha, c.nombre AS cliente,
            d.metodo_pago, d.entidad_nombre_snapshot AS entidad, d.referencia, d.titular,
            d.monto::float8 AS monto, (d.metodo_pago IS NOT NULL) AS con_detalle
       FROM ${tV} v
       LEFT JOIN ${tCli} c ON c.id=v.cliente_id AND c.empresa_id=v.empresa_id
       ${detLateral}
      WHERE ${perV} ORDER BY v.fecha DESC, v.numero_control DESC`, args);

  // Totales de cabecera de ventas (para sin/con detalle).
  const ventasTotQ = p.query<{ ventas: number }>(
    `SELECT count(*)::int AS ventas FROM ${tV} v WHERE ${perV}`, args);

  // Movimientos de cobranza del mes = detalle de cobro de ventas (contado) +
  // cobros de cuentas por cobrar (créditos cobrados en el período). Ambos alimentan
  // la conciliación por método y por entidad bancaria.
  const detPer = `d.empresa_id=$1::uuid AND EXISTS (SELECT 1 FROM ${tV} v WHERE v.id=d.venta_id AND ${perV})`;
  const movsCTE = `WITH movs AS (
      SELECT d.metodo_pago AS metodo,
             COALESCE(NULLIF(d.entidad_nombre_snapshot,''),'(sin entidad)') AS entidad,
             d.monto::float8 AS monto
        FROM ${tD} d WHERE ${detPer}
      UNION ALL
      SELECT cc.metodo_pago AS metodo,
             COALESCE(NULLIF(cc.entidad_nombre_snapshot,''),'(sin entidad)') AS entidad,
             cc.monto::float8 AS monto
        FROM ${tCob} cc
       WHERE cc.empresa_id=$1::uuid AND cc.fecha_pago>=$2::timestamptz AND cc.fecha_pago<=$3::timestamptz
    )`;
  const totQ = p.query<{ cantidad: number; total: number }>(
    `${movsCTE} SELECT count(*)::int AS cantidad, COALESCE(SUM(monto),0)::float8 AS total FROM movs`, args);
  const porMetodoQ = p.query<ConciliacionAgrupado>(
    `${movsCTE} SELECT metodo AS clave, count(*)::int AS cantidad, COALESCE(SUM(monto),0)::float8 AS total
       FROM movs GROUP BY metodo ORDER BY total DESC`, args);
  const porEntidadQ = p.query<ConciliacionAgrupado>(
    `${movsCTE} SELECT entidad AS clave, count(*)::int AS cantidad, COALESCE(SUM(monto),0)::float8 AS total
       FROM movs GROUP BY entidad ORDER BY total DESC`, args);

  const [ventas, ventasTot, tot, porMetodo, porEntidad] = await Promise.all([
    ventasQ, ventasTotQ, totQ, porMetodoQ, porEntidadQ]);

  const ventasRows: ConciliacionVentaRow[] = ventas.rows.map((r) => ({
    venta_id: r.venta_id,
    numero_control: r.numero_control,
    fecha: r.fecha,
    cliente: r.cliente || null,
    metodo_pago: r.metodo_pago || null,
    entidad: r.entidad || null,
    referencia: r.referencia || null,
    titular: r.titular || null,
    monto: r.con_detalle ? num(r.monto) : null,
    con_detalle: r.con_detalle === true,
  }));
  const cantidadVentas = num(ventasTot.rows[0]?.ventas);
  const ventasConDetalle = ventasRows.filter((v) => v.con_detalle).length;

  return {
    mes: b.mes,
    totalCobrado: num(tot.rows[0]?.total),
    cantidadOperaciones: num(tot.rows[0]?.cantidad),
    cantidadVentas,
    ventasConDetalle,
    ventasSinDetalle: cantidadVentas - ventasConDetalle,
    porMetodo: porMetodo.rows.map((r) => ({ clave: r.clave, cantidad: num(r.cantidad), total: num(r.total) })),
    porEntidad: porEntidad.rows.map((r) => ({ clave: r.clave, cantidad: num(r.cantidad), total: num(r.total) })),
    ventas: ventasRows,
  };
}
