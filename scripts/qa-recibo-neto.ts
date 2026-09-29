/**
 * QA del cálculo del efectivo del recibo (cobro múltiple con NC). Sin BD.
 *   npm run qa:recibo-neto
 *
 * Regla corregida: el efectivo del recibo = suma de importes cobrados en
 * efectivo. La NC se aplica aparte al saldo de la factura y NO se descuenta
 * del efectivo (bug histórico: se restaba dos veces).
 */
import { montoEfectivoRecibo, totalCancelado } from "../src/lib/recibos/recibo-calculo";

let pass = 0, fail = 0;
function eq(nombre: string, a: unknown, b: unknown) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) { pass++; console.log(`✓ PASS  ${nombre} (${JSON.stringify(a)})`); }
  else { fail++; console.log(`✗ FAIL  ${nombre}: got ${JSON.stringify(a)}, esperado ${JSON.stringify(b)}`); }
}

// --- Caso del reclamo: FAC-000509 ---
// Saldo 1.062.550, NC 72.000, efectivo real 990.550.
const efectivo509 = montoEfectivoRecibo([990550]);
eq("FAC-000509: efectivo del recibo = 990.550 (NO 918.550)", efectivo509, 990550);
eq("FAC-000509: total cancelado = efectivo + NC = 1.062.550", totalCancelado(990550, 72000), 1062550);

// --- Varias facturas en efectivo: se suman, no se resta NC ---
eq("efectivo suma varias facturas", montoEfectivoRecibo([990550, 500000, 167000]), 1657550);

// --- Sin NC: el efectivo es el saldo completo cobrado ---
eq("sin NC: efectivo = importe", montoEfectivoRecibo([1062550]), 1062550);

// --- La NC nunca resta del efectivo (aunque haya varias NC) ---
// El importe ya viene neto; el recibo no vuelve a tocar la NC.
eq("efectivo ignora montos de NC", montoEfectivoRecibo([918550]), 918550);
eq("total cancelado con NC grande", totalCancelado(918550, 144000), 1062550);

// --- Bordes ---
eq("lista vacía = 0", montoEfectivoRecibo([]), 0);
eq("valores no numéricos se ignoran", montoEfectivoRecibo([100000, NaN as unknown as number, 50000]), 150000);
eq("redondeo a 2 decimales", montoEfectivoRecibo([333.33, 333.33, 333.34]), 1000);

console.log(`\n${fail === 0 ? "✓ TODOS OK" : "✗ HAY FALLOS"} — ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
