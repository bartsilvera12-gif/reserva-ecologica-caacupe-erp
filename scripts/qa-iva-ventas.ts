/**
 * QA del Libro de Ventas IVA (desglose por tasa). Sin BD.
 *   npm run qa:iva-ventas
 */
import {
  clasificarTasa,
  desglosarItemsIva,
  mapFacturaToIvaRow,
  mapNcToIvaRow,
  totalesIva,
  type IvaItemInput,
} from "../src/lib/reportes/iva/iva-ventas";

let pass = 0, fail = 0;
function eq(nombre: string, a: unknown, b: unknown) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) { pass++; console.log(`✓ PASS  ${nombre}`); }
  else { fail++; console.log(`✗ FAIL  ${nombre}: got ${JSON.stringify(a)}, esperado ${JSON.stringify(b)}`); }
}

// --- clasificarTasa ---
eq("tasa 10%", clasificarTasa("10%"), "10");
eq("tasa 5%", clasificarTasa("5%"), "5");
eq("tasa exenta (null)", clasificarTasa(null), "exenta");
eq("tasa exenta (texto)", clasificarTasa("Exenta"), "exenta");

// --- desglose de una factura con 10% + 5% + exenta ---
const items: IvaItemInput[] = [
  { tipo_iva: "10%", subtotal: 77272.73, iva: 7727.27, total: 85000 },
  { tipo_iva: "5%", subtotal: 19047.62, iva: 952.38, total: 20000 },
  { tipo_iva: "exenta", subtotal: 30000, iva: 0, total: 30000 },
];
const d = desglosarItemsIva(items);
eq("gravado 10% redondeado", d.gravado_10, 77273);
eq("iva 10% redondeado", d.iva_10, 7727);
eq("gravado 5% redondeado", d.gravado_5, 19048);
eq("iva 5% redondeado", d.iva_5, 952);
eq("exentas", d.exentas, 30000);
eq("total = suma de columnas", d.total, 77273 + 7727 + 19048 + 952 + 30000);

// --- solo 10% (caso típico) ---
const solo10 = desglosarItemsIva([{ tipo_iva: "10%", subtotal: 77272.73, iva: 7727.27, total: 85000 }]);
eq("solo 10%: total = 85.000", solo10.total, 85000);
eq("solo 10%: 5% y exentas en 0", [solo10.gravado_5, solo10.iva_5, solo10.exentas], [0, 0, 0]);

// --- mapFacturaToIvaRow ---
const row = mapFacturaToIvaRow(
  { fecha: "2026-08-15T03:00:00.000Z", numero_factura: "FAC-000123", cliente_ruc: "80012345-6", cliente_razon_social: "CLIENTE SA", items },
  "18949725"
);
eq("fecha YYYY-MM-DD", row.fecha, "2026-08-15");
eq("tipo = Factura", row.tipo, "Factura");
eq("timbrado", row.timbrado, "18949725");
eq("ruc", row.ruc, "80012345-6");
eq("total de la fila", row.total, d.total);

// Fallbacks sin RUC / sin nombre.
const rowSf = mapFacturaToIvaRow(
  { fecha: null, numero_factura: "FAC-1", cliente_ruc: null, cliente_razon_social: null, items: [] },
  ""
);
eq("sin RUC → 'Sin RUC'", rowSf.ruc, "Sin RUC");
eq("sin nombre → 'Sin nombre'", rowSf.razon_social, "Sin nombre");

// --- totalesIva ---
const total = totalesIva([row, row]);
eq("totales suma gravado 10%", total.gravado_10, row.gravado_10 * 2);
eq("totales suma total", total.total, row.total * 2);
eq("totales de lista vacía = ceros", totalesIva([]), { gravado_10: 0, iva_10: 0, gravado_5: 0, iva_5: 0, exentas: 0, total: 0 });

// --- Notas de crédito (filas negativas) ---
const ncRow = mapNcToIvaRow(
  { fecha: "2026-08-20T03:00:00.000Z", numero: 225, cliente_ruc: "80012345-6", cliente_razon_social: "CLIENTE SA",
    items: [{ tipo_iva: "10%", subtotal: 9090.91, iva: 909.09, total: 10000 }] },
  "18949725"
);
eq("NC: tipo = Nota de Crédito", ncRow.tipo, "Nota de Crédito");
eq("NC: numero = NC-225", ncRow.numero_factura, "NC-225");
eq("NC: gravado 10% negativo", ncRow.gravado_10, -9091);
eq("NC: iva 10% negativo", ncRow.iva_10, -909);
eq("NC: total negativo", ncRow.total, -10000);

// Totales NETOS: factura 85.000 (10%) − NC 10.000 (10%).
const fac10 = mapFacturaToIvaRow(
  { fecha: "2026-08-10", numero_factura: "FAC-1", cliente_ruc: "1-1", cliente_razon_social: "X",
    items: [{ tipo_iva: "10%", subtotal: 77272.73, iva: 7727.27, total: 85000 }] }, "T");
const neto = totalesIva([fac10, ncRow]);
eq("neto: gravado 10% = 77273 − 9091", neto.gravado_10, 77273 - 9091);
eq("neto: iva 10% = 7727 − 909", neto.iva_10, 7727 - 909);
eq("neto: total = 85000 − 10000", neto.total, 75000);

console.log(`\n${fail === 0 ? "✓ TODOS OK" : "✗ HAY FALLOS"} — ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
