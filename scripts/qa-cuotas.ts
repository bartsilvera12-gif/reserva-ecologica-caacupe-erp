/**
 * QA de la lógica pura de cuotas. Sin BD ni red.
 *   npm run qa:cuotas
 */
import {
  validarPlanCuotas,
  derivarEstadoCuotas,
  generarCuotasIguales,
  type CuotaPlanInput,
} from "../src/lib/cuotas/cuotas-domain";

let pass = 0;
let fail = 0;
function check(nombre: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`✓ PASS  ${nombre}`);
  } else {
    fail++;
    console.log(`✗ FAIL  ${nombre}`);
  }
}
function eq(nombre: string, a: unknown, b: unknown) {
  check(`${nombre} (${JSON.stringify(a)} === ${JSON.stringify(b)})`, JSON.stringify(a) === JSON.stringify(b));
}

// ---- validarPlanCuotas ----
const plan3: CuotaPlanInput[] = [
  { numero_cuota: 1, monto: 100000, fecha_vencimiento: "2026-10-01" },
  { numero_cuota: 2, monto: 100000, fecha_vencimiento: "2026-11-01" },
  { numero_cuota: 3, monto: 100000, fecha_vencimiento: "2026-12-01" },
];
check("1a plan válido suma = saldo", validarPlanCuotas(300000, plan3).ok === true);
check("1b suma != saldo → error", validarPlanCuotas(290000, plan3).ok === false);
check("1c tolerancia ±1 Gs", validarPlanCuotas(300001, plan3).ok === true);
check("1d sin cuotas → error", validarPlanCuotas(300000, []).ok === false);
check(
  "1e monto <= 0 → error",
  validarPlanCuotas(200000, [
    { numero_cuota: 1, monto: 0, fecha_vencimiento: "2026-10-01" },
    { numero_cuota: 2, monto: 200000, fecha_vencimiento: "2026-11-01" },
  ]).ok === false
);
check(
  "1f numeros no consecutivos → error",
  validarPlanCuotas(200000, [
    { numero_cuota: 1, monto: 100000, fecha_vencimiento: "2026-10-01" },
    { numero_cuota: 3, monto: 100000, fecha_vencimiento: "2026-11-01" },
  ]).ok === false
);
check(
  "1g fecha inválida → error",
  validarPlanCuotas(100000, [{ numero_cuota: 1, monto: 100000, fecha_vencimiento: "01/10/2026" }]).ok === false
);
check(
  "1h numero repetido → error",
  validarPlanCuotas(200000, [
    { numero_cuota: 1, monto: 100000, fecha_vencimiento: "2026-10-01" },
    { numero_cuota: 1, monto: 100000, fecha_vencimiento: "2026-11-01" },
  ]).ok === false
);

// ---- derivarEstadoCuotas ----
// Sin pagos → todas pendientes.
const d0 = derivarEstadoCuotas(plan3, 0);
eq("2a estados sin pago", d0.map((c) => c.estado), ["pendiente", "pendiente", "pendiente"]);

// Pago que cubre la 1ra exacta.
const d1 = derivarEstadoCuotas(plan3, 100000);
eq("2b una cuota pagada", d1.map((c) => c.estado), ["pagada", "pendiente", "pendiente"]);
eq("2b saldos", d1.map((c) => c.saldo), [0, 100000, 100000]);

// Pago que cubre 1ra + parte de 2da.
const d2 = derivarEstadoCuotas(plan3, 150000);
eq("2c 1 pagada + 2 parcial", d2.map((c) => c.estado), ["pagada", "parcial", "pendiente"]);
eq("2c pagado 2da", d2[1].pagado, 50000);
eq("2c saldo 2da", d2[1].saldo, 50000);

// Pago total → todas pagadas.
const d3 = derivarEstadoCuotas(plan3, 300000);
eq("2d todas pagadas", d3.map((c) => c.estado), ["pagada", "pagada", "pagada"]);

// Imputación siempre de la más antigua aunque llegue desordenado.
const desordenado: CuotaPlanInput[] = [
  { numero_cuota: 3, monto: 100000, fecha_vencimiento: "2026-12-01" },
  { numero_cuota: 1, monto: 100000, fecha_vencimiento: "2026-10-01" },
  { numero_cuota: 2, monto: 100000, fecha_vencimiento: "2026-11-01" },
];
const d4 = derivarEstadoCuotas(desordenado, 100000);
eq("2e ordena por numero_cuota", d4.map((c) => c.numero_cuota), [1, 2, 3]);
eq("2e imputa a la 1ra", d4.map((c) => c.estado), ["pagada", "pendiente", "pendiente"]);

// ---- generarCuotasIguales ----
const g = generarCuotasIguales(300000, 3, "2026-10-01", 30);
eq("3a cantidad", g.length, 3);
eq("3a suma exacta", g.reduce((a, c) => a + c.monto, 0), 300000);
eq("3a vencimientos mensuales", g.map((c) => c.fecha_vencimiento), ["2026-10-01", "2026-10-31", "2026-11-30"]);

// Reparto con remanente: 100000 / 3 → última absorbe el redondeo.
const g2 = generarCuotasIguales(100000, 3, "2026-10-01", 30);
eq("3b suma exacta con remanente", g2.reduce((a, c) => a + c.monto, 0), 100000);
check("3b valida contra su propio saldo", validarPlanCuotas(100000, g2).ok === true);

console.log(`\n${fail === 0 ? "✓ TODOS OK" : "✗ HAY FALLOS"} — ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
