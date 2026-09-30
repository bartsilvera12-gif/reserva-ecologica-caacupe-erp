/**
 * Libro de Ventas para la liquidación mensual de IVA. Puro y testeable.
 *
 * Por cada factura del período, desglosa el IVA a partir de sus ítems
 * (factura_items.tipo_iva): Gravado 10% / IVA 10% / Gravado 5% / IVA 5% /
 * Exentas / Total. Incluye TODAS las facturas (electrónicas y no electrónicas),
 * a diferencia del R90 (solo no electrónicas para DNIT).
 *
 * Montos en Gs (sin decimales): se redondea cada columna y el Total es la suma
 * de las columnas, de modo que la fila siempre cuadra.
 */

export type TasaIva = "10" | "5" | "exenta";

export interface IvaItemInput {
  tipo_iva: string | null;
  /** Base gravada (sin IVA). */
  subtotal: number;
  /** Monto de IVA del ítem. */
  iva: number;
  /** Total del ítem (base + IVA). */
  total: number;
}

export interface IvaVentaFacturaInput {
  fecha: string | Date | null;
  numero_factura: string | null;
  cliente_ruc: string | null;
  cliente_razon_social: string | null;
  items: IvaItemInput[];
}

export interface IvaVentaRow {
  fecha: string | null; // YYYY-MM-DD
  tipo: string; // tipo de comprobante
  numero_factura: string;
  timbrado: string;
  ruc: string;
  razon_social: string;
  gravado_10: number;
  iva_10: number;
  gravado_5: number;
  iva_5: number;
  exentas: number;
  total: number;
}

function round0(n: number): number {
  return Math.round(Number(n) || 0);
}

/** Clasifica el tipo_iva del ítem en 10 / 5 / exenta. */
export function clasificarTasa(tipoIva: string | null | undefined): TasaIva {
  const s = String(tipoIva ?? "").toLowerCase();
  if (s.includes("10")) return "10";
  if (s.includes("5")) return "5";
  return "exenta";
}

export interface DesgloseIva {
  gravado_10: number;
  iva_10: number;
  gravado_5: number;
  iva_5: number;
  exentas: number;
  total: number;
}

/** Suma los ítems de una factura en columnas de IVA (redondeadas). Total = suma. */
export function desglosarItemsIva(items: IvaItemInput[]): DesgloseIva {
  let g10 = 0, i10 = 0, g5 = 0, i5 = 0, ex = 0;
  for (const it of items ?? []) {
    const sub = Number(it.subtotal) || 0;
    const iva = Number(it.iva) || 0;
    const tot = Number(it.total) || 0;
    switch (clasificarTasa(it.tipo_iva)) {
      case "10": g10 += sub; i10 += iva; break;
      case "5": g5 += sub; i5 += iva; break;
      default: ex += tot; break; // exenta: no tiene IVA
    }
  }
  const gravado_10 = round0(g10);
  const iva_10 = round0(i10);
  const gravado_5 = round0(g5);
  const iva_5 = round0(i5);
  const exentas = round0(ex);
  return {
    gravado_10, iva_10, gravado_5, iva_5, exentas,
    total: gravado_10 + iva_10 + gravado_5 + iva_5 + exentas,
  };
}

function fechaYmd(fecha: string | Date | null): string | null {
  if (!fecha) return null;
  if (fecha instanceof Date) return fecha.toISOString().slice(0, 10);
  return String(fecha).slice(0, 10);
}

/** Arma la fila del libro IVA de una factura. */
export function mapFacturaToIvaRow(f: IvaVentaFacturaInput, timbrado: string): IvaVentaRow {
  const d = desglosarItemsIva(f.items);
  return {
    fecha: fechaYmd(f.fecha),
    tipo: "Factura",
    numero_factura: (f.numero_factura ?? "").trim(),
    timbrado: (timbrado ?? "").trim(),
    ruc: (f.cliente_ruc ?? "").trim() || "Sin RUC",
    razon_social: (f.cliente_razon_social ?? "").trim() || "Sin nombre",
    gravado_10: d.gravado_10,
    iva_10: d.iva_10,
    gravado_5: d.gravado_5,
    iva_5: d.iva_5,
    exentas: d.exentas,
    total: d.total,
  };
}

export interface IvaNcInput {
  fecha: string | Date | null;
  /** Número de la NC. */ numero: number | string | null;
  cliente_ruc: string | null;
  cliente_razon_social: string | null;
  /** Ítems de la NC, o de la factura de origen si la NC no tiene ítems propios. */
  items: IvaItemInput[];
}

/**
 * Arma la fila del libro IVA de una NOTA DE CRÉDITO. Los montos salen en NEGATIVO:
 * la NC reduce las ventas gravadas y el IVA débito del período. Solo NC aprobadas.
 */
export function mapNcToIvaRow(nc: IvaNcInput, timbrado: string): IvaVentaRow {
  const d = desglosarItemsIva(nc.items);
  return {
    fecha: fechaYmd(nc.fecha),
    tipo: "Nota de Crédito",
    numero_factura: nc.numero != null && String(nc.numero).trim() !== "" ? `NC-${nc.numero}` : "NC",
    timbrado: (timbrado ?? "").trim(),
    ruc: (nc.cliente_ruc ?? "").trim() || "Sin RUC",
    razon_social: (nc.cliente_razon_social ?? "").trim() || "Sin nombre",
    gravado_10: -d.gravado_10,
    iva_10: -d.iva_10,
    gravado_5: -d.gravado_5,
    iva_5: -d.iva_5,
    exentas: -d.exentas,
    total: -d.total,
  };
}

/** Fila de totales (suma de cada columna numérica). */
export function totalesIva(rows: IvaVentaRow[]): DesgloseIva {
  return (rows ?? []).reduce<DesgloseIva>(
    (a, r) => ({
      gravado_10: a.gravado_10 + r.gravado_10,
      iva_10: a.iva_10 + r.iva_10,
      gravado_5: a.gravado_5 + r.gravado_5,
      iva_5: a.iva_5 + r.iva_5,
      exentas: a.exentas + r.exentas,
      total: a.total + r.total,
    }),
    { gravado_10: 0, iva_10: 0, gravado_5: 0, iva_5: 0, exentas: 0, total: 0 }
  );
}
