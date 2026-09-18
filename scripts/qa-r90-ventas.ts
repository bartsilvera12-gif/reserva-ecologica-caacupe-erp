/**
 * QA unitario (sin red, sin BD) del generador R90 – Registro de Comprobantes de Ventas.
 * Valida: orden de campos DNIT, separador coma (nunca ;), formato, desglose IVA,
 * mapeo comprobante→renglón, validaciones y nombre de archivo.
 *
 * Uso: npm run qa:r90-ventas   (o: npx tsx scripts/qa-r90-ventas.ts)
 */
import {
  toR90Line,
  buildR90VentasCsv,
  validateR90Row,
  desglosarIvaVenta,
  mapVentaComprobanteToR90Row,
  resolverIdentificacionComprador,
  sanitizeR90Text,
  r90NombreArchivo,
  numeroFiscalDesdeNumeroFactura,
  type R90VentaRow,
} from "../src/lib/reportes/r90/r90-ventas";

let fallos = 0;
function check(nombre: string, cond: boolean, extra?: string) {
  if (!cond) fallos++;
  console.log(`${cond ? "✓ PASS" : "✗ FAIL"}  ${nombre}${!cond && extra ? `\n        ${extra}` : ""}`);
}

// ── Caso 1: reproducir el EJEMPLO OFICIAL de la DNIT (con coma en vez de ;) ──
const ejemplo: R90VentaRow = {
  tipoIdentificacion: 11,
  numeroIdentificacion: "80024627",
  nombre: "MINISTERIO DE HACIENDA",
  tipoComprobante: 109,
  fechaEmision: "05/05/2021",
  timbrado: "11138251",
  numeroComprobante: "001-002-0000250",
  gravado10: 3630000,
  gravado5: 0,
  exento: 0,
  total: 3630000,
  condicion: 1,
  monedaExtranjera: "N",
  imputaIva: "S",
  imputaIre: "N",
  imputaIrpRsp: "N",
};
const linea = toR90Line(ejemplo);
const esperado =
  "1,11,80024627,MINISTERIO DE HACIENDA,109,05/05/2021,11138251,001-002-0000250,3630000,0,0,3630000,1,N,S,N,N,,";
check("Caso 1a: la línea coincide con el ejemplo oficial DNIT (coma)", linea === esperado, `got: ${linea}`);
check("Caso 1b: 19 campos exactos", linea.split(",").length === 19, `campos=${linea.split(",").length}`);
check("Caso 1c: NUNCA usa punto y coma", !linea.includes(";"), `got: ${linea}`);
check("Caso 1d: el ejemplo valida sin errores", validateR90Row(ejemplo).length === 0, validateR90Row(ejemplo).join("; "));

// ── Caso 2: desglose de IVA por ítem (10 / 5 / exento, IVA incluido) ──
const des = desglosarIvaVenta([
  { total: 110000, iva: 10000, subtotal: 100000 }, // 10%
  { total: 105000, iva: 5000, subtotal: 100000 },  // 5%
  { total: 50000, iva: 0, subtotal: 50000 },       // exento
]);
check("Caso 2a: gravado 10% correcto", des.gravado10 === 110000, JSON.stringify(des));
check("Caso 2b: gravado 5% correcto", des.gravado5 === 105000, JSON.stringify(des));
check("Caso 2c: exento correcto", des.exento === 50000, JSON.stringify(des));
check("Caso 2d: total = suma de los tres", des.total === 265000, JSON.stringify(des));

// ── Caso 3: mapeo comprobante → renglón (end-to-end, puro) ──
const row = mapVentaComprobanteToR90Row(
  {
    numeroFactura: "FAC-0000250",
    fecha: "2021-05-05",
    tipo: "contado",
    moneda: "GS",
    cliente: { ruc: "80024627-1", documento: null, razon_social: "MINISTERIO DE HACIENDA", es_contribuyente: true },
    items: [{ total: 3630000, iva: 330000, subtotal: 3300000 }],
  },
  { timbrado: "11138251", establecimiento: "001", punto: "002" },
  { imputaIva: "S", imputaIre: "N", imputaIrpRsp: "N" }
);
check("Caso 3a: tipo id 11 (RUC), número sin DV", row.tipoIdentificacion === 11 && row.numeroIdentificacion === "80024627", JSON.stringify(row));
check("Caso 3b: número comprobante ###-###-#######", row.numeroComprobante === "001-002-0000250", row.numeroComprobante);
check("Caso 3c: fecha dd/mm/aaaa", row.fechaEmision === "05/05/2021", row.fechaEmision);
check("Caso 3d: gravado10 = total (ítem 10%)", row.gravado10 === 3630000 && row.total === 3630000, JSON.stringify(row));
check("Caso 3e: mapeo valida sin errores", validateR90Row(row).length === 0, validateR90Row(row).join("; "));

// ── Caso 4: identificación del comprador (Tabla 3) ──
check("Caso 4a: con RUC → tipo 11", resolverIdentificacionComprador({ ruc: "80131562-0", documento: null, razon_social: "X" }).tipoIdentificacion === 11);
check("Caso 4b: solo cédula → tipo 12", resolverIdentificacionComprador({ ruc: null, documento: "8944737-9", razon_social: "X" }).tipoIdentificacion === 12);
check("Caso 4c: sin id → tipo 15 (sin nombre)", resolverIdentificacionComprador({ ruc: null, documento: null, razon_social: "" }).tipoIdentificacion === 15);

// ── Caso 5: validaciones que deben FALLAR ──
const malTotal: R90VentaRow = { ...ejemplo, total: 9999999 };
check("Caso 5a: total ≠ 9+10+11 → error", validateR90Row(malTotal).some((e) => e.includes("total")));
const malFecha: R90VentaRow = { ...ejemplo, fechaEmision: "2021-05-05" };
check("Caso 5b: fecha con formato ISO → error", validateR90Row(malFecha).some((e) => e.includes("fecha")));
const malNumero: R90VentaRow = { ...ejemplo, numeroComprobante: "1-2-3" };
check("Caso 5c: número comprobante mal formado → error", validateR90Row(malNumero).some((e) => e.includes("numeroComprobante")));

// ── Caso 6: saneo de texto (coma prohibida en campos) ──
check("Caso 6a: coma reemplazada por espacio", sanitizeR90Text("EMPRESA, S.A.", 250) === "EMPRESA S.A.", sanitizeR90Text("EMPRESA, S.A.", 250));
check("Caso 6b: saltos de línea removidos", !sanitizeR90Text("A\nB", 250).includes("\n"));

// ── Caso 7: utilidades ──
check("Caso 7a: nombre de archivo oficial", r90NombreArchivo("80131562-0", "2026-09") === "80131562_REG_092026_V0001", r90NombreArchivo("80131562-0", "2026-09"));
check("Caso 7b: número fiscal desde FAC-000080", numeroFiscalDesdeNumeroFactura("FAC-000080") === "000080", numeroFiscalDesdeNumeroFactura("FAC-000080"));
check("Caso 7c: CSV vacío = string vacío", buildR90VentasCsv([]) === "");
check("Caso 7d: CSV de una fila termina en CRLF", buildR90VentasCsv([ejemplo]).endsWith("\r\n"));

console.log(`\n${fallos === 0 ? "✓ TODOS OK" : `✗ ${fallos} FALLO(S)`}`);
process.exit(fallos === 0 ? 0 : 1);
