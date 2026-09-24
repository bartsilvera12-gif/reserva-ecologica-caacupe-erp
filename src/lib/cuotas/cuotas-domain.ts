/**
 * Lógica pura del plan de cuotas (cuentas por cobrar y por pagar).
 *
 * El plan es un cronograma: cuota N con su monto y vencimiento. El dinero real
 * lo siguen manejando los abonos (cobros_clientes / pagos_proveedor) que reducen
 * el saldo global de la cuenta. Acá NO se guarda saldo por cuota: el estado de
 * cada cuota se DERIVA imputando lo ya pagado de la más antigua a la más nueva.
 *
 * Sin dependencias de BD ni de red — testeable de forma aislada.
 */

export type TipoCuenta = "cobrar" | "pagar";
export type CuotaEstado = "pendiente" | "parcial" | "pagada";

export interface CuotaPlanInput {
  numero_cuota: number;
  monto: number;
  fecha_vencimiento: string; // YYYY-MM-DD
}

export interface CuotaDerivada extends CuotaPlanInput {
  pagado: number; // cuánto de esta cuota ya está cubierto por los abonos
  saldo: number; // monto - pagado (nunca negativo)
  estado: CuotaEstado;
}

/** Gs no tiene decimales; toleramos 1 unidad por redondeos de prorrateo. */
export const TOLERANCIA_GS = 1;

export function round2(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Valida que un plan de cuotas sea coherente con el saldo a programar.
 * - Al menos 1 cuota.
 * - Números de cuota consecutivos empezando en 1 (1..N, sin repetir).
 * - Cada monto > 0.
 * - Cada fecha en formato YYYY-MM-DD válido.
 * - La suma de los montos iguala el saldo objetivo (± TOLERANCIA_GS).
 */
export function validarPlanCuotas(
  saldoObjetivo: number,
  cuotas: CuotaPlanInput[]
): { ok: true } | { ok: false; error: string } {
  if (!Array.isArray(cuotas) || cuotas.length === 0) {
    return { ok: false, error: "El plan debe tener al menos una cuota." };
  }
  const objetivo = round2(saldoObjetivo);
  if (!(objetivo > 0)) {
    return { ok: false, error: "El saldo a programar debe ser mayor a cero." };
  }

  const numeros = new Set<number>();
  let suma = 0;
  for (const c of cuotas) {
    if (!Number.isInteger(c.numero_cuota) || c.numero_cuota < 1) {
      return { ok: false, error: "Número de cuota inválido (debe ser entero ≥ 1)." };
    }
    if (numeros.has(c.numero_cuota)) {
      return { ok: false, error: `Número de cuota repetido: ${c.numero_cuota}.` };
    }
    numeros.add(c.numero_cuota);

    const monto = round2(c.monto);
    if (!(monto > 0)) {
      return { ok: false, error: `La cuota ${c.numero_cuota} debe tener monto mayor a cero.` };
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(c.fecha_vencimiento ?? "").trim())) {
      return { ok: false, error: `La cuota ${c.numero_cuota} tiene una fecha de vencimiento inválida (use AAAA-MM-DD).` };
    }
    const d = new Date(`${c.fecha_vencimiento}T00:00:00`);
    if (Number.isNaN(d.getTime())) {
      return { ok: false, error: `La cuota ${c.numero_cuota} tiene una fecha de vencimiento inexistente.` };
    }
    suma = round2(suma + monto);
  }

  // Consecutivos 1..N.
  for (let i = 1; i <= cuotas.length; i++) {
    if (!numeros.has(i)) {
      return { ok: false, error: `Falta la cuota ${i}: los números deben ser consecutivos 1..${cuotas.length}.` };
    }
  }

  if (Math.abs(suma - objetivo) > TOLERANCIA_GS) {
    return {
      ok: false,
      error: `La suma de las cuotas (${suma}) no coincide con el saldo a programar (${objetivo}).`,
    };
  }
  return { ok: true };
}

/**
 * Deriva el estado de cada cuota imputando `montoPagado` de la cuota más antigua
 * (menor numero_cuota) a la más nueva. No muta la entrada.
 */
export function derivarEstadoCuotas(
  cuotas: CuotaPlanInput[],
  montoPagado: number
): CuotaDerivada[] {
  const ordenadas = [...cuotas].sort((a, b) => a.numero_cuota - b.numero_cuota);
  let restante = Math.max(0, round2(montoPagado));

  return ordenadas.map((c) => {
    const monto = round2(c.monto);
    const pagado = Math.min(monto, restante);
    restante = round2(restante - pagado);
    const saldo = round2(monto - pagado);
    const estado: CuotaEstado = saldo <= 0.0001 ? "pagada" : pagado > 0.0001 ? "parcial" : "pendiente";
    return { ...c, monto, pagado: round2(pagado), saldo, estado };
  });
}

/**
 * Genera N cuotas iguales a partir de un saldo, con vencimientos mensuales
 * (u otra periodicidad en días) desde `primerVencimiento`. La última cuota
 * absorbe el remanente de redondeo para que la suma sea exacta.
 * Utilidad para el atajo "dividir en N cuotas" de la UI.
 */
export function generarCuotasIguales(
  saldo: number,
  cantidad: number,
  primerVencimiento: string,
  periodicidadDias = 30
): CuotaPlanInput[] {
  const total = round2(saldo);
  if (!(total > 0) || !Number.isInteger(cantidad) || cantidad < 1) return [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(primerVencimiento ?? "").trim())) return [];

  const base = Math.floor((total / cantidad) * 100) / 100;
  const cuotas: CuotaPlanInput[] = [];
  let acumulado = 0;
  const base0 = new Date(`${primerVencimiento}T00:00:00`);
  for (let i = 0; i < cantidad; i++) {
    const esUltima = i === cantidad - 1;
    const monto = esUltima ? round2(total - acumulado) : base;
    acumulado = round2(acumulado + monto);
    const d = new Date(base0);
    d.setDate(d.getDate() + periodicidadDias * i);
    cuotas.push({
      numero_cuota: i + 1,
      monto,
      fecha_vencimiento: d.toISOString().slice(0, 10),
    });
  }
  return cuotas;
}
