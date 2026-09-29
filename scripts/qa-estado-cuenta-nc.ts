/**
 * QA del resumen de NC del estado de cuenta. Sin BD.
 *   npm run qa:estado-cuenta-nc
 */
import {
  estadoNc,
  marcarEstadoNc,
  totalNcDisponibles,
  saldoNetoInformativo,
  esCorregidaNc,
  ncOrigenCompensada,
  saldoOperativoEfectivo,
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

// --- Issue 1: factura "Corregida NC" (compensada totalmente por NC) ---
eq("esCorregidaNc detecta 'Corregida NC'", esCorregidaNc("Corregida NC"), true);
eq("esCorregidaNc case-insensitive", esCorregidaNc("corregida nc"), true);
eq("esCorregidaNc otra cosa = false", esCorregidaNc("Pendiente"), false);
eq("esCorregidaNc null = false", esCorregidaNc(null), false);

// saldoOperativoEfectivo excluye anuladas y facturas corregidas por NC.
eq("operativo excluye corregida NC y anulado", saldoOperativoEfectivo([
  { saldo: 500000, factura_estado: "Pendiente", cxc_estado: "pendiente" },
  { saldo: 372000, factura_estado: "Corregida NC", cxc_estado: "pendiente" }, // excluida
  { saldo: 100000, factura_estado: "Pendiente", cxc_estado: "anulado" },      // excluida
]), 500000);

// Caso MUSTER / FAC-000532: única CxC 372.000 corregida por NC total 372.000.
const musterMovs = [{ saldo: 372000, factura_estado: "Corregida NC", cxc_estado: "pendiente" }];
const musterNc: NcEstadoCuentaInput[] = [
  { numero: 148, factura_origen: "FAC-000532", monto: 372000, saldo_disponible: 372000, origen_corregida: true },
];
const opMuster = saldoOperativoEfectivo(musterMovs);
const dispMuster = totalNcDisponibles(musterNc);
eq("MUSTER: operativo = 0 (factura corregida excluida)", opMuster, 0);
eq("MUSTER: NC disponibles = 0 (no se descuenta dos veces)", dispMuster, 0);
eq("MUSTER: saldo neto = 0", saldoNetoInformativo(opMuster, dispMuster), 0);
eq("MUSTER: NC marcada 'aplicada'", marcarEstadoNc(musterNc)[0].estado, "aplicada");

// La NC de una factura NO corregida sigue contando como disponible.
eq("NC de factura no corregida cuenta como disponible", totalNcDisponibles([
  { numero: 1, factura_origen: "F", monto: 100000, saldo_disponible: 100000, origen_corregida: false },
]), 100000);

// ncOrigenCompensada: solo cuando la factura está Corregida NC Y su CxC tiene saldo > 0.
eq("compensada: Corregida NC + CxC pendiente (MUSTER)", ncOrigenCompensada("Corregida NC", 372000), true);
eq("NO compensada: Corregida NC pero CxC pagada (Sanabria) → crédito disponible", ncOrigenCompensada("Corregida NC", 0), false);
eq("NO compensada: factura no corregida", ncOrigenCompensada("Pendiente", 500000), false);

// Sanabria (facturas Corregida NC pero ya pagadas): sus NC siguen disponibles,
// el neto no cambia respecto de la versión anterior.
const sanabriaConCorregidasPagadas: NcEstadoCuentaInput[] = sanabria.map((n) => ({
  ...n,
  // factura pagada (saldo 0) aunque esté Corregida NC → NO compensada
  origen_corregida: ncOrigenCompensada("Corregida NC", 0),
}));
eq("Sanabria: NC disponibles se mantiene 7.321.011 (facturas corregidas ya pagadas)",
  totalNcDisponibles(sanabriaConCorregidasPagadas), 7321011);

console.log(`\n${fail === 0 ? "✓ TODOS OK" : "✗ HAY FALLOS"} — ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
