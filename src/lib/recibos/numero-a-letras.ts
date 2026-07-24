/**
 * Monto en letras para el recibo de dinero.
 *
 * Es el estándar en un recibo paraguayo: la cifra escrita evita que se altere
 * el número. Se escribe en mayúsculas, como en los formularios preimpresos.
 *
 * Guaraníes: se trabaja con enteros (la moneda no usa centavos en la práctica).
 */

const UNIDADES = [
  "", "UN", "DOS", "TRES", "CUATRO", "CINCO", "SEIS", "SIETE", "OCHO", "NUEVE",
  "DIEZ", "ONCE", "DOCE", "TRECE", "CATORCE", "QUINCE", "DIECISÉIS", "DIECISIETE",
  "DIECIOCHO", "DIECINUEVE", "VEINTE", "VEINTIUNO", "VEINTIDÓS", "VEINTITRÉS",
  "VEINTICUATRO", "VEINTICINCO", "VEINTISÉIS", "VEINTISIETE", "VEINTIOCHO", "VEINTINUEVE",
];
const DECENAS = ["", "", "VEINTE", "TREINTA", "CUARENTA", "CINCUENTA", "SESENTA", "SETENTA", "OCHENTA", "NOVENTA"];
const CENTENAS = [
  "", "CIENTO", "DOSCIENTOS", "TRESCIENTOS", "CUATROCIENTOS", "QUINIENTOS",
  "SEISCIENTOS", "SETECIENTOS", "OCHOCIENTOS", "NOVECIENTOS",
];

/** 0–999 en letras. */
function tramo(n: number): string {
  if (n === 0) return "";
  if (n === 100) return "CIEN";
  if (n < 30) return UNIDADES[n]!;
  if (n < 100) {
    const d = Math.floor(n / 10);
    const u = n % 10;
    return u === 0 ? DECENAS[d]! : `${DECENAS[d]} Y ${UNIDADES[u]}`;
  }
  const c = Math.floor(n / 100);
  const resto = n % 100;
  return resto === 0 ? CENTENAS[c]! : `${CENTENAS[c]} ${tramo(resto)}`;
}

/**
 * Convierte un importe a letras. Soporta hasta billones, suficiente de sobra
 * para guaraníes.
 *
 * Ejemplos: 1200000 -> "UN MILLÓN DOSCIENTOS MIL"
 *           7000    -> "SIETE MIL"
 *           1000    -> "MIL"  (no "UN MIL")
 *           21000   -> "VEINTIÚN MIL"
 */
export function numeroALetras(monto: number): string {
  const n = Math.floor(Math.abs(Number(monto) || 0));
  if (n === 0) return "CERO";

  const partes: string[] = [];

  const millones = Math.floor(n / 1_000_000);
  const miles = Math.floor((n % 1_000_000) / 1000);
  const resto = n % 1000;

  if (millones > 0) {
    partes.push(millones === 1 ? "UN MILLÓN" : `${tramo(millones)} MILLONES`);
  }
  if (miles > 0) {
    // "MIL" a secas, nunca "UN MIL". Y "VEINTIÚN MIL", no "VEINTIUNO MIL".
    if (miles === 1) partes.push("MIL");
    else partes.push(`${tramo(miles).replace(/\bVEINTIUNO\b/, "VEINTIÚN").replace(/\bUNO\b/, "UN")} MIL`);
  }
  if (resto > 0) {
    partes.push(tramo(resto));
  }

  return partes.join(" ").replace(/\s+/g, " ").trim();
}

/** Texto completo para el recibo: "UN MILLÓN DOSCIENTOS MIL GUARANÍES". */
export function montoEnLetras(monto: number, moneda: string): string {
  const letras = numeroALetras(monto);
  const sufijo = (moneda ?? "").toUpperCase() === "USD" ? "DÓLARES AMERICANOS" : "GUARANÍES";
  return `${letras} ${sufijo}`;
}
