/**
 * Generador del archivo R90 — "Registro de Comprobantes de VENTAS" (RG 90/2021, DNIT).
 *
 * Alcance (definido con el cliente): SOLO comprobantes NO electrónicos válidos.
 * Los documentos electrónicos SIFEN NO se incluyen: la SET ya los obtiene
 * automáticamente para el libro de Marangatú. Para un emisor 100% electrónico
 * (como Reserva Caacupé) el archivo queda vacío — y eso es correcto.
 *
 * Formato del archivo (confirmado): CSV delimitado por COMA, UTF-8, SIN encabezado,
 * en el ORDEN oficial de campos de la DNIT (19 campos). Un renglón por comprobante.
 *
 * Referencia: DNIT "Especificaciones Técnicas para registro de comprobantes en
 * Marangatu" — sección "Registro de Comprobantes de Ventas".
 *
 * Este módulo es PURO (sin BD ni red) para poder testearlo directo.
 */

/** Campo 1 (código tipo de registro): 1 = VENTAS (Tabla 1). Constante. */
export const R90_TIPO_REGISTRO_VENTAS = 1;

/** Tabla 4 (tipos de comprobante) relevantes para ventas — según ejemplo oficial. */
export const R90_COMPROBANTE = {
  FACTURA: 109,
  NOTA_CREDITO: 110,
  NOTA_DEBITO: 111,
} as const;

/** Tabla 3 (tipos de identificación del comprador). */
export const R90_TIPO_ID = {
  RUC: 11,
  CEDULA: 12,
  PASAPORTE: 13,
  CEDULA_EXTRANJERO: 14,
  SIN_NOMBRE: 15,
} as const;

/** Tabla 2 (condición de la operación). */
export const R90_CONDICION = { CONTADO: 1, CREDITO: 2 } as const;

/** Separador y fin de línea del archivo (coma + CRLF; UTF-8 lo fija el endpoint). */
export const R90_SEP = ",";
export const R90_EOL = "\r\n";

export type SN = "S" | "N";

/** Flags de imputación (campos 15-17) — configurables por empresa (no hardcodear). */
export interface R90Imputacion {
  imputaIva: SN;
  imputaIre: SN;
  imputaIrpRsp: SN;
}

export interface R90VentaRow {
  /** 2 — Tabla 3 */ tipoIdentificacion: number;
  /** 3 */ numeroIdentificacion: string;
  /** 4 — requerido salvo tipo 11/12/15 */ nombre: string;
  /** 5 — Tabla 4 */ tipoComprobante: number;
  /** 6 — dd/mm/aaaa */ fechaEmision: string;
  /** 7 — 8 díg. */ timbrado: string;
  /** 8 — ###-###-####### */ numeroComprobante: string;
  /** 9 — entero, IVA incluido */ gravado10: number;
  /** 10 */ gravado5: number;
  /** 11 */ exento: number;
  /** 12 — = 9+10+11 */ total: number;
  /** 13 — Tabla 2 */ condicion: number;
  /** 14 — S/N */ monedaExtranjera: SN;
  /** 15 */ imputaIva: SN;
  /** 16 */ imputaIre: SN;
  /** 17 */ imputaIrpRsp: SN;
  /** 18 — solo NC/ND */ comprobanteAsociado?: string;
  /** 19 — solo NC/ND */ timbradoAsociado?: string;
}

/** Quita separador, comillas y saltos de línea de un campo de texto (CSV por coma naive). */
export function sanitizeR90Text(v: unknown, maxLen: number): string {
  const s = String(v ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/,/g, " ") // el importador separa por coma → sin comas en el texto
    .replace(/"/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s.slice(0, maxLen);
}

/** Entero R90: positivo, sin decimales ni separador de miles. */
export function r90Entero(n: unknown): string {
  const v = Math.round(Number(n));
  return String(Number.isFinite(v) && v > 0 ? v : 0);
}

/** Fecha dd/mm/aaaa a partir de Date o 'YYYY-MM-DD'. */
export function r90Fecha(d: Date | string): string {
  const dt = d instanceof Date ? d : new Date(String(d));
  if (Number.isNaN(dt.getTime())) return "";
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = dt.getUTCFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

/** Formatea el número de comprobante a ###-###-#######. */
export function r90NumeroComprobante(establecimiento: string, punto: string, numero: string | number): string {
  const est = String(establecimiento ?? "").replace(/\D/g, "").padStart(3, "0").slice(-3);
  const pto = String(punto ?? "").replace(/\D/g, "").padStart(3, "0").slice(-3);
  const nro = String(numero ?? "").replace(/\D/g, "").padStart(7, "0").slice(-7);
  return `${est}-${pto}-${nro}`;
}

/** Toma un RUC/documento del ERP ("8809421-9") y devuelve el cuerpo sin DV. */
export function r90NumeroIdSinDv(rucODoc: string | null | undefined): string {
  const s = String(rucODoc ?? "").trim();
  if (!s) return "";
  const cuerpo = s.split("-")[0];
  return cuerpo.replace(/[^0-9A-Za-z]/g, "");
}

const RE_NUM_COMPROBANTE = /^\d{3}-\d{3}-\d{7}$/;
const RE_FECHA = /^\d{2}\/\d{2}\/\d{4}$/;

/** Valida un renglón según reglas R90. Devuelve lista de errores (vacía = OK). */
export function validateR90Row(r: R90VentaRow): string[] {
  const e: string[] = [];
  if (!Number.isInteger(r.tipoIdentificacion)) e.push("tipoIdentificacion inválido");
  if (!r.numeroIdentificacion?.trim()) e.push("numeroIdentificacion requerido");
  // Nombre requerido salvo tipo 11 (RUC), 12 (CÉDULA) y 15 (SIN NOMBRE).
  const nombreOpcional = [R90_TIPO_ID.RUC, R90_TIPO_ID.CEDULA, R90_TIPO_ID.SIN_NOMBRE].includes(
    r.tipoIdentificacion as 11 | 12 | 15
  );
  if (!nombreOpcional && !r.nombre?.trim()) e.push("nombre requerido para este tipo de identificación");
  if (![109, 110, 111].includes(r.tipoComprobante)) e.push("tipoComprobante fuera de Tabla 4 (ventas)");
  if (!RE_FECHA.test(r.fechaEmision)) e.push("fechaEmision debe ser dd/mm/aaaa");
  if (!/^\d{1,8}$/.test(String(r.timbrado))) e.push("timbrado debe ser numérico de hasta 8 dígitos");
  if (!RE_NUM_COMPROBANTE.test(r.numeroComprobante)) e.push("numeroComprobante debe ser ###-###-#######");
  const g10 = Math.round(r.gravado10), g5 = Math.round(r.gravado5), ex = Math.round(r.exento), tot = Math.round(r.total);
  if (g10 < 0 || g5 < 0 || ex < 0) e.push("montos no pueden ser negativos");
  if (tot <= 0) e.push("total debe ser > 0");
  if (g10 + g5 + ex !== tot) e.push(`total (${tot}) ≠ gravado10+gravado5+exento (${g10 + g5 + ex})`);
  if (![1, 2].includes(r.condicion)) e.push("condicion debe ser 1 (contado) o 2 (crédito)");
  for (const [k, v] of [["monedaExtranjera", r.monedaExtranjera], ["imputaIva", r.imputaIva], ["imputaIre", r.imputaIre], ["imputaIrpRsp", r.imputaIrpRsp]] as const) {
    if (v !== "S" && v !== "N") e.push(`${k} debe ser S o N`);
  }
  const esNcNd = r.tipoComprobante === 110 || r.tipoComprobante === 111;
  if (esNcNd && !r.comprobanteAsociado?.trim()) e.push("NC/ND requiere comprobante asociado (campo 18)");
  return e;
}

/** Convierte un renglón al string de 19 campos delimitado por coma (orden oficial DNIT). */
export function toR90Line(r: R90VentaRow): string {
  const campos: (string | number)[] = [
    R90_TIPO_REGISTRO_VENTAS,                 // 1
    r.tipoIdentificacion,                     // 2
    sanitizeR90Text(r.numeroIdentificacion, 20), // 3
    sanitizeR90Text(r.nombre, 250),           // 4
    r.tipoComprobante,                        // 5
    r.fechaEmision,                           // 6
    sanitizeR90Text(r.timbrado, 8),           // 7
    r.numeroComprobante,                      // 8
    r90Entero(r.gravado10),                   // 9
    r90Entero(r.gravado5),                    // 10
    r90Entero(r.exento),                      // 11
    r90Entero(r.total),                       // 12
    r.condicion,                              // 13
    r.monedaExtranjera,                       // 14
    r.imputaIva,                              // 15
    r.imputaIre,                              // 16
    r.imputaIrpRsp,                           // 17
    sanitizeR90Text(r.comprobanteAsociado ?? "", 20), // 18
    sanitizeR90Text(r.timbradoAsociado ?? "", 8),     // 19
  ];
  return campos.join(R90_SEP);
}

/** Arma el contenido completo del archivo R90 (sin encabezado). Vacío = string "". */
export function buildR90VentasCsv(rows: R90VentaRow[]): string {
  if (!rows.length) return "";
  return rows.map(toR90Line).join(R90_EOL) + R90_EOL;
}

/** Nombre de archivo oficial: RUC_REG_MMAAAA_Vnnnn (RUC sin DV). */
export function r90NombreArchivo(rucEmisor: string, mes: string, version = 1): string {
  const ruc = r90NumeroIdSinDv(rucEmisor) || "00000000";
  const [yyyy, mm] = String(mes).split("-");
  const mmaaaa = `${(mm ?? "01").padStart(2, "0")}${yyyy ?? "0000"}`;
  const v = `V${String(version).padStart(4, "0")}`;
  return `${ruc}_REG_${mmaaaa}_${v}`;
}

// ── Mapeo de datos del ERP → renglón R90 (puro) ──────────────────────────────

export interface R90ItemMonto {
  /** total de la línea (IVA incluido). */ total: number;
  /** IVA de la línea. */ iva: number;
  /** base de la línea. */ subtotal: number;
}

/** Clasifica los ítems de una factura en gravado 10% / 5% / exento (IVA incluido). */
export function desglosarIvaVenta(items: R90ItemMonto[]): { gravado10: number; gravado5: number; exento: number; total: number } {
  let g10 = 0, g5 = 0, ex = 0;
  for (const it of items) {
    const total = Math.round(Number(it.total) || 0);
    const iva = Math.round(Number(it.iva) || 0);
    const base = Math.round(Number(it.subtotal) || 0);
    if (total <= 0) continue;
    if (iva <= 0) { ex += total; continue; }
    // Tasa por línea: snap a 5% o 10% según cuál se acerca más a iva/base.
    const dif5 = Math.abs(base * 0.05 - iva);
    const dif10 = Math.abs(base * 0.10 - iva);
    if (dif5 < dif10) g5 += total; else g10 += total;
  }
  return { gravado10: g10, gravado5: g5, exento: ex, total: g10 + g5 + ex };
}

export interface R90ClienteInput {
  ruc: string | null;
  documento: string | null;
  razon_social: string | null;
  es_contribuyente?: boolean | null;
}

/** Resuelve tipo/número/nombre de identificación del comprador (Tabla 3). */
export function resolverIdentificacionComprador(c: R90ClienteInput): { tipoIdentificacion: number; numeroIdentificacion: string; nombre: string } {
  const ruc = String(c.ruc ?? "").trim();
  const doc = String(c.documento ?? "").trim();
  const nombre = sanitizeR90Text(c.razon_social ?? "", 250);
  if (ruc) {
    return { tipoIdentificacion: R90_TIPO_ID.RUC, numeroIdentificacion: r90NumeroIdSinDv(ruc), nombre };
  }
  if (doc) {
    return { tipoIdentificacion: R90_TIPO_ID.CEDULA, numeroIdentificacion: r90NumeroIdSinDv(doc), nombre };
  }
  // Sin identificación → SIN NOMBRE (innominado / consumidor final).
  return { tipoIdentificacion: R90_TIPO_ID.SIN_NOMBRE, numeroIdentificacion: "0", nombre: "" };
}

/** Condición de venta (Tabla 2) desde el tipo del ERP. */
export function resolverCondicion(tipo: string | null | undefined): number {
  return String(tipo ?? "").trim().toLowerCase() === "credito" ? R90_CONDICION.CREDITO : R90_CONDICION.CONTADO;
}

/** Deriva el número fiscal (7 díg.) desde el número interno del ERP ("FAC-000080" → "0000080"). */
export function numeroFiscalDesdeNumeroFactura(numeroFactura: string): string {
  const m = String(numeroFactura ?? "").match(/(\d+)\s*$/);
  return (m?.[1] ?? "0").replace(/\D/g, "");
}

export interface R90ComprobanteVentaInput {
  /** Número interno del ERP (FAC-XXXXXX) — para derivar el número fiscal. */
  numeroFactura: string;
  fecha: Date | string;
  /** 'contado' | 'credito' */ tipo: string | null;
  /** 'GS' | 'USD' */ moneda: string | null;
  cliente: R90ClienteInput;
  items: R90ItemMonto[];
}

/** Datos del timbrado NO electrónico (autoimpresor) para armar timbrado + número. */
export interface R90EmisorAutoimpresor {
  timbrado: string;
  establecimiento: string;
  punto: string;
}

/**
 * Mapea un comprobante de venta NO electrónico a un renglón R90 (Factura, 109).
 * El total se toma del desglose de IVA para garantizar 9+10+11 = 12.
 */
export function mapVentaComprobanteToR90Row(
  c: R90ComprobanteVentaInput,
  emisor: R90EmisorAutoimpresor,
  imputacion: R90Imputacion
): R90VentaRow {
  const id = resolverIdentificacionComprador(c.cliente);
  const des = desglosarIvaVenta(c.items);
  return {
    tipoIdentificacion: id.tipoIdentificacion,
    numeroIdentificacion: id.numeroIdentificacion,
    nombre: id.nombre,
    tipoComprobante: R90_COMPROBANTE.FACTURA,
    fechaEmision: r90Fecha(c.fecha),
    timbrado: String(emisor.timbrado ?? "").replace(/\D/g, ""),
    numeroComprobante: r90NumeroComprobante(
      emisor.establecimiento,
      emisor.punto,
      numeroFiscalDesdeNumeroFactura(c.numeroFactura)
    ),
    gravado10: des.gravado10,
    gravado5: des.gravado5,
    exento: des.exento,
    total: des.total,
    condicion: resolverCondicion(c.tipo),
    monedaExtranjera: String(c.moneda ?? "GS").toUpperCase() === "GS" ? "N" : "S",
    imputaIva: imputacion.imputaIva,
    imputaIre: imputacion.imputaIre,
    imputaIrpRsp: imputacion.imputaIrpRsp,
  };
}
