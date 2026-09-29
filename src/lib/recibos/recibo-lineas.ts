/**
 * Armado de las LÍNEAS del recibo de dinero (solo presentación). Puro y testeable.
 *
 * Regla para recibos con NC:
 *   - La línea de la factura muestra el importe BRUTO aplicado en la operación
 *     = efectivo/transferencia cobrado + NC aplicada a esa factura.
 *   - La NC va en una línea SEPARADA, en negativo.
 *   - Así `Σ(líneas) = total cobrado` (línea factura − NC = efectivo). Cuadra
 *     también en pagos parciales.
 *
 * No cambia ningún dato: el monto del recibo, el cobro y la NC quedan igual; esto
 * solo decide qué número se escribe en cada fila del PDF.
 */
import { round2 } from "./recibo-calculo";

export interface DetalleReciboItem {
  numero_documento: string | null;
  fecha_vencimiento?: string | null;
  /** Efectivo/transferencia cobrado por esta factura (neto). */
  importe_aplicado: number;
}

export interface NcAplicacionRecibo {
  importe: number;
  nc_factura_origen: string | null;
  /** Número de la factura (o venta) destino a la que se aplicó la NC. */
  destino_numero: string | null;
}

export interface FilaRecibo {
  doc: string;
  venc: string | null;
  concepto: string;
  /** Positivo para facturas (bruto), negativo para NC. */
  importe: number;
  esNegativo: boolean;
}

/**
 * Construye las filas del recibo: cada factura con su importe BRUTO (efectivo +
 * NC aplicada a esa factura) y cada NC como fila negativa aparte.
 */
export function construirFilasRecibo(
  detalle: DetalleReciboItem[],
  ncAplic: NcAplicacionRecibo[]
): FilaRecibo[] {
  // NC total aplicada por documento destino.
  const ncPorDestino = new Map<string, number>();
  for (const a of ncAplic) {
    const k = (a.destino_numero ?? "").trim();
    if (!k) continue;
    ncPorDestino.set(k, round2((ncPorDestino.get(k) ?? 0) + (Number(a.importe) || 0)));
  }

  const filas: FilaRecibo[] = [];

  // Facturas: importe bruto = efectivo cobrado + NC aplicada a esa factura.
  for (const d of detalle) {
    const doc = (d.numero_documento ?? "").trim() || "—";
    const ncDeEsta = ncPorDestino.get(doc) ?? 0;
    const bruto = round2((Number(d.importe_aplicado) || 0) + ncDeEsta);
    filas.push({
      doc,
      venc: d.fecha_vencimiento ?? null,
      concepto: "Cobro de cuenta",
      importe: bruto,
      esNegativo: false,
    });
  }

  // NC: una fila negativa por aplicación.
  for (const a of ncAplic) {
    const etiqueta = a.nc_factura_origen ? `NC de ${a.nc_factura_origen}` : "Nota de crédito";
    const concepto = a.destino_numero ? `Aplicada a ${a.destino_numero}` : "Aplicación de crédito";
    filas.push({
      doc: etiqueta,
      venc: null,
      concepto,
      importe: -round2(Number(a.importe) || 0),
      esNegativo: true,
    });
  }

  return filas;
}

/** Suma de todas las filas (facturas brutas − NC). Debe igualar el total cobrado. */
export function sumaFilasRecibo(filas: FilaRecibo[]): number {
  return round2(filas.reduce((a, f) => a + (Number(f.importe) || 0), 0));
}
