/**
 * Resumen de notas de crédito para el estado de cuenta. Puro y testeable.
 *
 * Contexto: el estado de cuenta muestra el saldo OPERATIVO (cuentas por cobrar).
 * Las NC aprobadas son créditos a favor que reducen la deuda al aplicarse en un
 * cobro; mientras no se aplican, no bajan el saldo operativo. Este módulo NO
 * modifica ningún saldo: solo calcula, para MOSTRAR, cuánto crédito hay
 * disponible y cuál sería el saldo neto informativo.
 *
 * Caso especial (factura "Corregida NC"): cuando una factura fue compensada
 * TOTALMENTE por una NC (facturas.estado = 'Corregida NC'), esa factura ya no es
 * deuda pendiente. Su fila se muestra con saldo 0 y se excluye del saldo
 * operativo; y su NC de origen se marca 'aplicada' y NO se vuelve a restar del
 * neto (si no, se descontaría dos veces).
 */

export type EstadoNcEC = "disponible" | "parcial" | "aplicada";

export interface NcEstadoCuentaInput {
  numero: number | string | null;
  factura_origen: string | null;
  monto: number;
  saldo_disponible: number;
  /** true si la factura de origen quedó totalmente 'Corregida NC'. */
  origen_corregida?: boolean;
}

export interface NcEstadoCuentaRow extends NcEstadoCuentaInput {
  estado: EstadoNcEC;
}

function round2(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** Una factura está totalmente compensada por NC si su estado es 'Corregida NC'. */
export function esCorregidaNc(facturaEstado: string | null | undefined): boolean {
  return String(facturaEstado ?? "").trim().toLowerCase() === "corregida nc";
}

/**
 * Una NC se considera "aplicada" a su factura de origen (y por lo tanto NO cuenta
 * como crédito disponible) solo si esa factura está 'Corregida NC' Y su cuenta por
 * cobrar todavía tiene saldo pendiente (la NC compensó una deuda vigente). Si la
 * factura ya se pagó (saldo 0), la NC es un crédito a favor real y sí queda
 * disponible.
 */
export function ncOrigenCompensada(
  facturaEstado: string | null | undefined,
  saldoCxcOrigen: number
): boolean {
  return esCorregidaNc(facturaEstado) && (Number(saldoCxcOrigen) || 0) > 0.001;
}

/** Estado de una NC aprobada según cuánto de su crédito queda sin aplicar. */
export function estadoNc(monto: number, saldoDisponible: number): EstadoNcEC {
  const m = round2(Number(monto) || 0);
  const d = round2(Number(saldoDisponible) || 0);
  if (d <= 0.01) return "aplicada";
  if (d >= m - 0.01) return "disponible";
  return "parcial";
}

/** Marca el estado de cada NC. Si su factura de origen está 'Corregida NC', se
 *  considera ya aplicada (reflejada en esa factura). */
export function marcarEstadoNc(ncs: NcEstadoCuentaInput[]): NcEstadoCuentaRow[] {
  return (ncs ?? []).map((n) => ({
    ...n,
    estado: n.origen_corregida ? "aplicada" : estadoNc(n.monto, n.saldo_disponible),
  }));
}

/** Crédito disponible = saldo_disponible de NC cuya factura NO está corregida
 *  (las corregidas ya se reflejan excluyendo su factura del saldo operativo). */
export function totalNcDisponibles(ncs: NcEstadoCuentaInput[]): number {
  return round2(
    (ncs ?? [])
      .filter((n) => !n.origen_corregida)
      .reduce((a, n) => a + (Number(n.saldo_disponible) || 0), 0)
  );
}

/** Saldo neto informativo = saldo operativo − crédito disponible (piso 0). */
export function saldoNetoInformativo(saldoOperativo: number, totalNcDisp: number): number {
  return round2(Math.max(0, (Number(saldoOperativo) || 0) - (Number(totalNcDisp) || 0)));
}

export interface MovSaldoInput {
  saldo: number;
  factura_estado?: string | null;
  cxc_estado?: string | null;
}

/**
 * Saldo operativo efectivo: suma de saldos de las cuentas por cobrar, EXCLUYENDO
 * las anuladas y las facturas totalmente 'Corregida NC' (esas ya no son deuda).
 */
export function saldoOperativoEfectivo(movs: MovSaldoInput[]): number {
  return round2(
    (movs ?? [])
      .filter((m) => String(m.cxc_estado ?? "").toLowerCase() !== "anulado")
      .filter((m) => !esCorregidaNc(m.factura_estado))
      .reduce((a, m) => a + (Number(m.saldo) || 0), 0)
  );
}
