/**
 * QA del armado de líneas del recibo PDF (factura bruta + NC negativa). Sin BD.
 *   npm run qa:recibo-lineas
 */
import { construirFilasRecibo, sumaFilasRecibo } from "../src/lib/recibos/recibo-lineas";

let pass = 0, fail = 0;
function eq(nombre: string, a: unknown, b: unknown) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) { pass++; console.log(`✓ PASS  ${nombre}`); }
  else { fail++; console.log(`✗ FAIL  ${nombre}: got ${JSON.stringify(a)}, esperado ${JSON.stringify(b)}`); }
}

// --- Caso REC-000045: FAC-000509 990.550 efectivo + NC 72.000 ---
const f45 = construirFilasRecibo(
  [{ numero_documento: "FAC-000509", fecha_vencimiento: "2026-09-25", importe_aplicado: 990550 }],
  [{ importe: 72000, nc_factura_origen: "FAC-000509", destino_numero: "FAC-000509" }]
);
eq("REC-000045: línea factura bruta = 1.062.550", f45[0].importe, 1062550);
eq("REC-000045: factura no negativa", f45[0].esNegativo, false);
eq("REC-000045: línea NC = -72.000", f45[1].importe, -72000);
eq("REC-000045: NC negativa", f45[1].esNegativo, true);
eq("REC-000045: etiqueta NC", f45[1].doc, "NC de FAC-000509");
eq("REC-000045: concepto NC", f45[1].concepto, "Aplicada a FAC-000509");
eq("REC-000045: TOTAL (suma filas) = 990.550", sumaFilasRecibo(f45), 990550);

// --- Sin NC: la línea es el efectivo tal cual ---
const fSinNc = construirFilasRecibo(
  [{ numero_documento: "FAC-000001", importe_aplicado: 500000 }],
  []
);
eq("sin NC: factura = 500.000", fSinNc[0].importe, 500000);
eq("sin NC: total = 500.000", sumaFilasRecibo(fSinNc), 500000);

// --- Pago PARCIAL: efectivo 300.000 + NC 100.000 → factura 400.000, total 300.000 ---
const fParcial = construirFilasRecibo(
  [{ numero_documento: "FAC-000002", importe_aplicado: 300000 }],
  [{ importe: 100000, nc_factura_origen: "FAC-000002", destino_numero: "FAC-000002" }]
);
eq("parcial: factura bruta = 400.000", fParcial[0].importe, 400000);
eq("parcial: total = efectivo 300.000", sumaFilasRecibo(fParcial), 300000);

// --- Varias facturas, NC solo a una ---
const fMulti = construirFilasRecibo(
  [
    { numero_documento: "FAC-A", importe_aplicado: 990550 },
    { numero_documento: "FAC-B", importe_aplicado: 500000 },
  ],
  [{ importe: 72000, nc_factura_origen: "FAC-A", destino_numero: "FAC-A" }]
);
eq("multi: FAC-A bruta = 1.062.550", fMulti[0].importe, 1062550);
eq("multi: FAC-B sin cambio = 500.000", fMulti[1].importe, 500000);
eq("multi: total = 1.490.550", sumaFilasRecibo(fMulti), 1490550);

// --- NC sin factura de origen → etiqueta genérica ---
const fSinOrigen = construirFilasRecibo(
  [{ numero_documento: "FAC-000003", importe_aplicado: 100000 }],
  [{ importe: 50000, nc_factura_origen: null, destino_numero: "FAC-000003" }]
);
eq("sin origen: factura bruta = 150.000", fSinOrigen[0].importe, 150000);
eq("sin origen: etiqueta genérica", fSinOrigen[1].doc, "Nota de crédito");
eq("sin origen: total = 100.000", sumaFilasRecibo(fSinOrigen), 100000);

// --- Invariante: Σ filas = Σ efectivo, siempre ---
eq("invariante multi-NC", sumaFilasRecibo(construirFilasRecibo(
  [{ numero_documento: "X", importe_aplicado: 200000 }, { numero_documento: "Y", importe_aplicado: 150000 }],
  [{ importe: 30000, nc_factura_origen: "X", destino_numero: "X" }, { importe: 20000, nc_factura_origen: "Y", destino_numero: "Y" }]
)), 350000);

console.log(`\n${fail === 0 ? "✓ TODOS OK" : "✗ HAY FALLOS"} — ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
