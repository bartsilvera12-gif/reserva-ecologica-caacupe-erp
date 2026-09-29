/**
 * Resumen de notas de crédito para el estado de cuenta. Puro y testeable.
 *
 * Contexto: el estado de cuenta muestra el saldo OPERATIVO (cuentas por cobrar).
 * Las NC aprobadas son créditos a favor que reducen la deuda al aplicarse en un
 * cobro; mientras no se aplican, no bajan el saldo operativo. Este módulo NO
 * modifica ningún saldo: solo calcula, para MOSTRAR, cuánto crédito hay
 * disponible y cuál sería el saldo neto informativo.
 */

export type EstadoNcEC = "disponible" | "parcial" | "aplicada";

export interface NcEstadoCuentaInput {
  numero: number | string | null;
  factura_origen: string | null;
  monto: number;
  saldo_disponible: number;
}

export interface NcEstadoCuentaRow extends NcEstadoCuentaInput {
  estado: EstadoNcEC;
}

function round2(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** Estado de una NC aprobada según cuánto de su crédito queda sin aplicar. */
export function estadoNc(monto: number, saldoDisponible: number): EstadoNcEC {
  const m = round2(Number(monto) || 0);
  const d = round2(Number(saldoDisponible) || 0);
  if (d <= 0.01) return "aplicada";
  if (d >= m - 0.01) return "disponible";
  return "parcial";
}

/** Marca el estado de cada NC (no cambia el orden ni filtra). */
export function marcarEstadoNc(ncs: NcEstadoCuentaInput[]): NcEstadoCuentaRow[] {
  return (ncs ?? []).map((n) => ({ ...n, estado: estadoNc(n.monto, n.saldo_disponible) }));
}

/** Crédito total disponible = suma de saldo_disponible (lo aún no aplicado). */
export function totalNcDisponibles(ncs: NcEstadoCuentaInput[]): number {
  return round2((ncs ?? []).reduce((a, n) => a + (Number(n.saldo_disponible) || 0), 0));
}

/** Saldo neto informativo = saldo operativo − crédito disponible (piso 0). */
export function saldoNetoInformativo(saldoOperativo: number, totalNcDisp: number): number {
  return round2(Math.max(0, (Number(saldoOperativo) || 0) - (Number(totalNcDisp) || 0)));
}
