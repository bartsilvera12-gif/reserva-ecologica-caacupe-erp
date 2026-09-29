/**
 * Cálculo del efectivo de un recibo de cobro múltiple. Puro y testeable.
 *
 * Regla (corregida): el "Importe a cobrar" de cada factura ES el efectivo real
 * recibido para esa factura. La nota de crédito se aplica POR SEPARADO al saldo
 * de la factura y NO se vuelve a descontar del efectivo.
 *
 *   efectivo_recibo   = Σ importes cobrados en efectivo
 *   total_cancelado   = efectivo + NC aplicada  (lo que salda la factura)
 *
 * Bug histórico: el recibo hacía `efectivo − NC`, restando la NC dos veces
 * (el importe ya venía neto), y subvaluaba el efectivo real.
 */

export function round2(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** Efectivo del recibo = suma de los importes cobrados en efectivo. No resta NC. */
export function montoEfectivoRecibo(importesEfectivo: number[]): number {
  const s = (importesEfectivo ?? []).reduce((a, b) => a + (Number(b) || 0), 0);
  return round2(s);
}

/** Total que cancela una factura = efectivo aplicado + NC aplicada. */
export function totalCancelado(efectivo: number, ncAplicada: number): number {
  return round2((Number(efectivo) || 0) + (Number(ncAplicada) || 0));
}
