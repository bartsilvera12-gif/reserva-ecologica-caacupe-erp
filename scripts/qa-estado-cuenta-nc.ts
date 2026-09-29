/**
 * QA del resumen de NC del estado de cuenta. Sin BD.
 *   npm run qa:estado-cuenta-nc
 */
import {
  estadoNc,
  marcarEstadoNc,
  totalNcDisponibles,
  saldoNetoInformativo,
  type NcEstadoCuentaInput,
} from "../src/lib/estado-cuenta/nc-resumen";

let pass = 0, fail = 0;
function eq(nombre: string, a: unknown, b: unknown) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) { pass++; console.log(`✓ PASS  ${nombre}`); }
  else { fail++; console.log(`✗ FAIL  ${nombre}: got ${JSON.stringify(a)}, esperado ${JSON.stringify(b)}`); }
}

// --- estadoNc ---
eq("estado disponible (saldo = monto)", estadoNc(100000, 100000), "disponible");
eq("estado aplicada (saldo = 0)", estadoNc(100000, 0), "aplicada");
eq("estado parcial (0 < saldo < monto)", estadoNc(100000, 40000), "parcial");

// --- Caso SANABRIA GARCIA JOHANA MARISEL (11 NC aprobadas, todas disponibles) ---
const sanabria: NcEstadoCuentaInput[] = [
  { numero: 9,   factura_origen: "FAC-000111", monto: 510430,  saldo_disponible: 510430 },
  { numero: 37,  factura_origen: "FAC-000239", monto: 270458,  saldo_disponible: 270458 },
  { numero: 51,  factura_origen: "FAC-000314", monto: 133945,  saldo_disponible: 133945 },
  { numero: 65,  factura_origen: "FAC-000367", monto: 252000,  saldo_disponible: 252000 },
  { numero: 112, factura_origen: "FAC-000077", monto: 1737890, saldo_disponible: 1737890 },
  { numero: 113, factura_origen: "FAC-000078", monto: 1737890, saldo_disponible: 1737890 },
  { numero: 127, factura_origen: "FAC-000466", monto: 236073,  saldo_disponible: 236073 },
  { numero: 145, factura_origen: "FAC-000514", monto: 327305,  saldo_disponible: 327305 },
  { numero: 157, factura_origen: "FAC-000038", monto: 1322110, saldo_disponible: 1322110 },
  { numero: 179, factura_origen: "FAC-000609", monto: 486840,  saldo_disponible: 486840 },
  { numero: 194, factura_origen: "FAC-000671", monto: 306070,  saldo_disponible: 306070 },
];
eq("Sanabria: NC disponibles = 7.321.011", totalNcDisponibles(sanabria), 7321011);
eq("Sanabria: saldo neto = 66.399.929", saldoNetoInformativo(73720940, totalNcDisponibles(sanabria)), 66399929);
eq("Sanabria: todas marcadas 'disponible'", marcarEstadoNc(sanabria).every((n) => n.estado === "disponible"), true);
eq("Sanabria: se conserva factura de origen", marcarEstadoNc(sanabria)[0].factura_origen, "FAC-000111");

// --- Bordes ---
eq("sin NC: disponibles = 0", totalNcDisponibles([]), 0);
eq("sin NC: neto = saldo operativo", saldoNetoInformativo(500000, 0), 500000);
eq("NC > saldo → neto con piso 0", saldoNetoInformativo(50000, 80000), 0);
eq("suma solo saldo_disponible (no monto)", totalNcDisponibles([
  { numero: 1, factura_origen: "F", monto: 100000, saldo_disponible: 30000 },
]), 30000);

console.log(`\n${fail === 0 ? "✓ TODOS OK" : "✗ HAY FALLOS"} — ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
