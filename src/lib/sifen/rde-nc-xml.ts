/**
 * rDE SIFEN v150 — Nota de crédito electrónica (iTiDE=5).
 * `gTotSub` (tgTotSub): misma secuencia estricta que `rde-xml.ts` / DE_v150.xsd
 * (dTotIVA antes de dBaseGrav* / dTBasGraIVA; dTotalGs solo si moneda ≠ PYG).
 */
import type { AmbienteSifen, SifenNotaCreditoPayload } from "./types";
import {
  SIFEN_TEST_CSC_GENERICO,
  SIFEN_TEST_LITERAL_DOCUMENTO,
} from "./sifen-ambiente-test";
import { SIFEN_EKUATIA_TARGET_NS, SIFEN_SIRECEP_DE_V150_XSD_FILE } from "./sifen-xsi-schema-location";
import { escapeXml } from "./xml";
import {
  fechaEmisionCdc,
  generarCdcFacturaElectronica,
  normalizarNumeroDocumentoSifen,
  normalizarNumeroTimbrado,
  normalizarCodigoTres,
  formatoCuerpoRucTipoTruc,
  padDigits,
  splitRucParaXml,
  I_TI_DE_NCE,
} from "./sifen-cdc";
import {
  BuildRdeXmlOptions,
  sifenDCodSegNueveDigitos,
  sifenDFeEmiDeYFecFirma,
  sifenEmisorITipContCodigo,
} from "./rde-xml";

const NS = SIFEN_EKUATIA_TARGET_NS;
const XMLNS_XSI = "http://www.w3.org/2001/XMLSchema-instance";
const RDE_XSI_SCHEMA_LOCATION = `${NS} ${SIFEN_SIRECEP_DE_V150_XSD_FILE}`;

const XSD_DES_TI_DE_NCE = "Nota de crédito electrónica";
const XSD_DES_T_IMP_IVA = "IVA";
const XSD_DES_MONE_PYG = "Guarani";
const XSD_DES_AFEC_GRAVADO = "Gravado IVA";
const XSD_DES_DOC_CI_PY = "Cédula paraguaya";
const XSD_DES_UNI_MED = "UNI";

function textEl(name: string, value: string | number): string {
  const c = escapeXml(String(value));
  return `<${name}>${c}</${name}>`;
}

function montoRedondeo(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  return v.toFixed(4);
}

function splitIvaIncluidoDesdeTotal(totalConIva: number, tasa: 5 | 10): { base: number; iva: number } {
  const T = Math.round(totalConIva);
  if (tasa === 10) {
    const base = Math.round(T / 1.1);
    return { base, iva: T - base };
  }
  const base = Math.round(T / 1.05);
  return { base, iva: T - base };
}

function vigenciaIso(dateYmd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateYmd.trim());
  if (!m) throw new Error(`Fecha timbrado inválida (use YYYY-MM-DD): ${dateYmd}`);
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** Número de documento NC (7 dígitos) derivado del UUID para unicidad estable por fila. */
export function numeroDocumentoNcDesdeId(ncId: string): string {
  const hex = ncId.replace(/-/g, "").slice(0, 12);
  const n = parseInt(hex, 16);
  const mod = Number.isFinite(n) ? (n % 9000000) + 1000000 : 1000000;
  return normalizarNumeroDocumentoSifen(String(mod));
}

/**
 * Mapea texto libre del ERP a par (iMotEmi, dDesMotEmi) del XSD tgCamNCDE.
 */
/**
 * Comprueba orden DE_v150 `tgTotSub` en el fragmento generado (evita regresión tipo SET
 * "elemento esperado es: dTotalGs en lugar de: dTotIVA" por dTotIVA mal posicionado).
 */
export function assertNcXmlGtotSubTotalsDe150Order(xml: string): void {
  const open = xml.indexOf("<gTotSub>");
  const close = xml.indexOf("</gTotSub>");
  if (open === -1 || close === -1 || close < open) {
    throw new Error("XML NC: bloque gTotSub no encontrado.");
  }
  const block = xml.slice(open, close);
  const iTot = block.indexOf("<dTotIVA");
  if (iTot === -1) {
    throw new Error("XML NC: falta dTotIVA en gTotSub.");
  }
  if (block.indexOf("<dTotIVA", iTot + 1) !== -1) {
    throw new Error("XML NC: dTotIVA duplicado en gTotSub.");
  }
  const iB5 = block.indexOf("<dBaseGrav5");
  const iB10 = block.indexOf("<dBaseGrav10");
  const iTB = block.indexOf("<dTBasGraIVA");
  if (iB5 !== -1 && !(iTot < iB5)) {
    throw new Error("XML NC: orden gTotSub — dTotIVA debe preceder a dBaseGrav5 (DE_v150).");
  }
  if (iB10 !== -1 && !(iTot < iB10)) {
    throw new Error("XML NC: orden gTotSub — dTotIVA debe preceder a dBaseGrav10 (DE_v150).");
  }
  if (iTB !== -1 && !(iTot < iTB)) {
    throw new Error("XML NC: orden gTotSub — dTotIVA debe preceder a dTBasGraIVA (DE_v150).");
  }
  if (iB5 !== -1 && iTB !== -1 && !(iB5 < iTB)) {
    throw new Error("XML NC: orden gTotSub — dBaseGrav5 debe preceder a dTBasGraIVA (DE_v150).");
  }
  if (iB10 !== -1 && iTB !== -1 && !(iB10 < iTB)) {
    throw new Error("XML NC: orden gTotSub — dBaseGrav10 debe preceder a dTBasGraIVA (DE_v150).");
  }
}

/**
 * SET rechaza NC (iTiDE=5) si se informa tipo de transacción comercial (`iTipTra` / `dDesTipTra`):
 * mensaje típico «Tipo de transacción no requerido para el tipo de documento electrónico seleccionado».
 * En `tgOpeCom` esos nodos son opcionales en XSD (minOccurs=0) pero no aplican a nota de crédito.
 */
export function assertNotaCreditoXmlSinTipoTransaccionComercial(xml: string): void {
  if (/<\s*iTipTra\b/i.test(xml) || /<\s*dDesTipTra\b/i.test(xml)) {
    throw new Error(
      "XML NC (iTiDE=5): no debe incluir tipo de transacción comercial (iTipTra / dDesTipTra). La SET lo rechaza para nota de crédito electrónica."
    );
  }
}

/**
 * SET rechaza NC si se informa condición de la operación (`gCamCond`: contado/crédito, formas de pago).
 * Mensaje típico: «no se requiere informar la condición de la operación».
 * En `tgDtipDE`, `gCamCond` es opcional (minOccurs=0) y no aplica a nota de crédito electrónica.
 */
export function assertNotaCreditoXmlSinCondicionOperacion(xml: string): void {
  if (/<\s*gCamCond\b/i.test(xml)) {
    throw new Error(
      "XML NC (iTiDE=5): no debe incluir gCamCond (condición de operación: iCondOpe, formas de pago, etc.). La SET lo rechaza."
    );
  }
}

export function mapMotivoNcSifen(motivo: string): { iMotEmi: string; dDesMotEmi: string } {
  const t = motivo.toLowerCase();
  if (/descuent/.test(t)) return { iMotEmi: "3", dDesMotEmi: "Descuento" };
  if (/bonif/.test(t)) return { iMotEmi: "4", dDesMotEmi: "Bonificación" };
  if (/incobrable|moros/.test(t)) return { iMotEmi: "5", dDesMotEmi: "Crédito incobrable" };
  if (/recupero.*costo/.test(t)) return { iMotEmi: "6", dDesMotEmi: "Recupero de costo" };
  if (/recupero.*gasto/.test(t)) return { iMotEmi: "7", dDesMotEmi: "Recupero de gasto" };
  if (/ajuste.*precio/.test(t)) return { iMotEmi: "8", dDesMotEmi: "Ajuste de precio" };
  if (/^devoluc/i.test(t) && !/ajuste/.test(t)) return { iMotEmi: "2", dDesMotEmi: "Devolución" };
  return { iMotEmi: "1", dDesMotEmi: "Devolución y Ajuste de precios" };
}

/**
 * Construye el XML rDE de nota de crédito electrónica (iTiDE=5), listo para firmar el nodo `DE`.
 */
export function buildOfficialRdeNotaCreditoElectronicaXml(
  base: SifenNotaCreditoPayload,
  opts: BuildRdeXmlOptions
): string {
  const { emisor, receptor, notaCredito, documentoElectronicoOrigen } = base;
  const ambiente: AmbienteSifen = opts.ambiente ?? "produccion";
  const esAmbienteTest = ambiente === "test";

  let cscParaCodSeg: string;
  if (esAmbienteTest) {
    const cscCfg = emisor.csc == null ? "" : String(emisor.csc).trim();
    cscParaCodSeg = cscCfg !== "" ? cscCfg : SIFEN_TEST_CSC_GENERICO;
  } else {
    const csc = emisor.csc;
    if (csc == null || String(csc).trim() === "") {
      throw new Error("Falta CSC en configuración SIFEN para generar el DE de nota de crédito.");
    }
    cscParaCodSeg = String(csc).trim();
  }

  const { cuerpo: rucEmCuerpo, dDV: dDVEmi } = splitRucParaXml(emisor.ruc);
  const dRucEmCdc = padDigits(rucEmCuerpo, 8);
  const dNumTim = normalizarNumeroTimbrado(emisor.timbrado_numero);
  const dEst = normalizarCodigoTres(emisor.establecimiento);
  const dPunExp = normalizarCodigoTres(emisor.punto_expedicion);
  const dNumDoc = numeroDocumentoNcDesdeId(notaCredito.id);
  const fechaCdc = fechaEmisionCdc(notaCredito.fecha_emision);
  const iTipContEmi = sifenEmisorITipContCodigo(emisor.razon_social);
  const semillaSeg = base.sifen.nota_credito_electronica_id;
  const dCodSeg = sifenDCodSegNueveDigitos(cscParaCodSeg, semillaSeg);

  const { cdc, dDVId } = generarCdcFacturaElectronica({
    iTiDE: I_TI_DE_NCE,
    dRucEm: dRucEmCdc,
    dDVEmi,
    dEst,
    dPunExp,
    numeroFactura: dNumDoc,
    fechaEmision: fechaCdc,
    iTipContEmisor: iTipContEmi,
    iTipEmi: "1",
    dCodSeg,
  });

  const ahora = opts.fechaHoraEmision ?? new Date();
  const dFeEmiDE = sifenDFeEmiDeYFecFirma(notaCredito.fecha_emision, ahora);
  const dFecFirma = dFeEmiDE;
  const dFeIniT = vigenciaIso(opts.timbradoFechaInicio);

  const telEmi = opts.emisorTelefono.replace(/\D/g, "");
  if (telEmi.length < 8 || telEmi.length > 15) {
    throw new Error("emisorTelefono debe tener entre 8 y 15 dígitos para gEmis.dTelEmi.");
  }
  const dirEmi = opts.emisorDireccion.trim();
  if (dirEmi.length < 1) throw new Error("emisorDireccion es obligatoria.");

  const dep = (opts.emisorDepartamento ?? "1").trim();
  const depDes = (opts.emisorDepartamentoDescripcion ?? "CAPITAL").trim();
  const cAct = opts.actividadEconomicaCodigo?.trim() ?? "";
  const dActDes = opts.actividadEconomicaDescripcion?.trim() ?? "";
  if (!cAct || !dActDes) {
    throw new Error("Faltan actividadEconomicaCodigo y actividadEconomicaDescripcion.");
  }

  const dNomEmi = esAmbienteTest ? SIFEN_TEST_LITERAL_DOCUMENTO : emisor.razon_social.trim();

  const gEmisParts: string[] = [
    "<gEmis>",
    textEl("dRucEm", dRucEmCdc),
    textEl("dDVEmi", dDVEmi),
    textEl("iTipCont", iTipContEmi),
    textEl("dNomEmi", dNomEmi),
    textEl("dDirEmi", dirEmi),
    textEl("dNumCas", opts.emisorNumCasa),
    textEl("cDepEmi", dep),
    textEl("dDesDepEmi", depDes),
  ];
  if (opts.emisorDistrito?.trim()) {
    gEmisParts.push(textEl("cDisEmi", opts.emisorDistrito.replace(/\D/g, "").slice(0, 4)));
    gEmisParts.push(textEl("dDesDisEmi", (opts.emisorDistritoDescripcion ?? "").trim() || "ASUNCION"));
  }
  if (opts.emisorCiudad?.trim()) {
    gEmisParts.push(textEl("cCiuEmi", opts.emisorCiudad.replace(/\D/g, "").slice(0, 5)));
    gEmisParts.push(textEl("dDesCiuEmi", (opts.emisorCiudadDescripcion ?? "").trim() || "ASUNCION"));
  } else {
    gEmisParts.push(textEl("cCiuEmi", "1"));
    gEmisParts.push(textEl("dDesCiuEmi", "ASUNCION (DISTRITO)"));
  }
  gEmisParts.push(textEl("dTelEmi", telEmi));
  gEmisParts.push(textEl("dEmailE", opts.emisorEmail.trim()));
  gEmisParts.push("<gActEco>");
  gEmisParts.push(textEl("cActEco", cAct));
  gEmisParts.push(textEl("dDesActEco", dActDes));
  gEmisParts.push("</gActEco>");
  gEmisParts.push("</gEmis>");

  const recParts: string[] = ["<gDatRec>"];
  if (receptor.ruc?.trim()) {
    const { cuerpo: dRucRec, dDV: dDVRec } = splitRucParaXml(receptor.ruc.trim());
    const iTiContRec = sifenEmisorITipContCodigo(receptor.nombre);
    recParts.push(textEl("iNatRec", "1"));
    recParts.push(textEl("iTiOpe", "1"));
    recParts.push(textEl("cPaisRec", "PRY"));
    recParts.push(textEl("dDesPaisRe", "Paraguay"));
    recParts.push(textEl("iTiContRec", iTiContRec));
    recParts.push(textEl("dRucRec", formatoCuerpoRucTipoTruc(dRucRec)));
    recParts.push(textEl("dDVRec", dDVRec));
    recParts.push(textEl("dNomRec", receptor.nombre.trim()));
    if (receptor.direccion?.trim()) recParts.push(textEl("dDirRec", receptor.direccion.trim()));
    if (receptor.telefono?.trim()) {
      const tr = receptor.telefono.replace(/\D/g, "");
      if (tr.length >= 8) recParts.push(textEl("dTelRec", tr.slice(0, 15)));
    }
    if (receptor.email?.trim()) recParts.push(textEl("dEmailRec", receptor.email.trim()));
  } else {
    const doc = (receptor.documento ?? "").replace(/\s/g, "").trim();
    if (!doc) throw new Error("Receptor sin RUC: se requiere documento (CI) en cliente.");
    recParts.push(textEl("iNatRec", "2"));
    /** tiTiOpe (DE_Types v150): 2=B2C. Receptor no contribuyente (iNatRec=2) con
     *  documento nacional exige B2C, no B2B. Antes se enviaba iTiOpe=1 → SET
     *  rechazaba con "El tipo de operación no compatible con la naturaleza del
     *  receptor" (mismo criterio ya aplicado en la factura, rde-xml.ts). */
    recParts.push(textEl("iTiOpe", "2"));
    recParts.push(textEl("cPaisRec", "PRY"));
    recParts.push(textEl("dDesPaisRe", "Paraguay"));
    recParts.push(textEl("iTipIDRec", "1"));
    recParts.push(textEl("dDTipIDRec", XSD_DES_DOC_CI_PY));
    recParts.push(textEl("dNumIDRec", doc.slice(0, 20)));
    recParts.push(textEl("dNomRec", receptor.nombre.trim()));
    if (receptor.direccion?.trim()) recParts.push(textEl("dDirRec", receptor.direccion.trim()));
    if (receptor.telefono?.trim()) {
      const tr = receptor.telefono.replace(/\D/g, "");
      if (tr.length >= 8) recParts.push(textEl("dTelRec", tr.slice(0, 15)));
    }
    if (receptor.email?.trim()) recParts.push(textEl("dEmailRec", receptor.email.trim()));
  }
  recParts.push("</gDatRec>");

  const { iMotEmi, dDesMotEmi } = mapMotivoNcSifen(notaCredito.motivo);
  const T = Math.round(Number(notaCredito.monto));
  if (!(T > 0)) throw new Error("El monto de la nota de crédito debe ser mayor a cero.");

  // Fase B: si hay items[] emitimos un gCamItem por producto, con su propia
  // tasa de IVA. Si no, mantenemos el ítem genérico único (compat con NC total).
  type LineaXml = { descripcion: string; codigo: string; total: number; tasa: 0 | 5 | 10; base: number; iva: number };
  const items = Array.isArray(notaCredito.items) && notaCredito.items.length > 0
    ? notaCredito.items
    : null;

  let lineas: LineaXml[];
  if (items) {
    let sumaTotales = 0;
    lineas = items.map((it, idx) => {
      const totalLinea = Math.round(Number(it.total_linea));
      sumaTotales += totalLinea;
      const tasa: 0 | 5 | 10 = it.tipo_iva === "10%" ? 10 : it.tipo_iva === "5%" ? 5 : 0;
      let base = totalLinea;
      let iva = 0;
      if (tasa === 10 || tasa === 5) {
        const sp = splitIvaIncluidoDesdeTotal(totalLinea, tasa);
        base = sp.base;
        iva = sp.iva;
      }
      return {
        descripcion:
          esAmbienteTest && SIFEN_TEST_LITERAL_DOCUMENTO.length > 0 && idx === 0
            ? SIFEN_TEST_LITERAL_DOCUMENTO.slice(0, 120)
            : String(it.producto_nombre).slice(0, 120),
        codigo: (it.sku && String(it.sku).trim()) || `L${idx + 1}`,
        total: totalLinea,
        tasa,
        base,
        iva,
      };
    });
    if (Math.abs(sumaTotales - T) > 2) {
      throw new Error(
        `NC parcial: la suma de items (${sumaTotales}) no coincide con el monto de la NC (${T}).`
      );
    }
  } else {
    const sp = splitIvaIncluidoDesdeTotal(T, 10);
    const dDesProSer =
      esAmbienteTest && SIFEN_TEST_LITERAL_DOCUMENTO.length > 0
        ? SIFEN_TEST_LITERAL_DOCUMENTO.slice(0, 120)
        : `Nota de crédito — ${notaCredito.motivo.slice(0, 100)}`;
    lineas = [
      {
        descripcion: dDesProSer,
        codigo: "NC1",
        total: T,
        tasa: 10,
        base: sp.base,
        iva: sp.iva,
      },
    ];
  }

  const itemXml = lineas
    .map((l) => {
      const iAfec = l.tasa === 0 ? "3" : "1";
      const desAfec = l.tasa === 0 ? "Exento" : XSD_DES_AFEC_GRAVADO;
      return [
        "<gCamItem>",
        textEl("dCodInt", l.codigo.slice(0, 20)),
        textEl("dDesProSer", l.descripcion),
        textEl("cUniMed", "77"),
        textEl("dDesUniMed", XSD_DES_UNI_MED),
        textEl("dCantProSer", "1"),
        "<gValorItem>",
        textEl("dPUniProSer", l.total),
        textEl("dTotBruOpeItem", l.total),
        "<gValorRestaItem>",
        textEl("dDescItem", "0"),
        textEl("dTotOpeItem", l.total),
        "</gValorRestaItem>",
        "</gValorItem>",
        "<gCamIVA>",
        textEl("iAfecIVA", iAfec),
        textEl("dDesAfecIVA", desAfec),
        textEl("dPropIVA", 100),
        textEl("dTasaIVA", l.tasa),
        textEl("dBasGravIVA", l.base),
        textEl("dLiqIVAItem", l.iva),
        textEl("dBasExe", l.tasa === 0 ? l.total : 0),
        "</gCamIVA>",
        "</gCamItem>",
      ].join("");
    })
    .join("");

  const sumaTotOpeItem = lineas.reduce((s, l) => s + l.total, 0);
  const sumaSub10 = lineas.filter((l) => l.tasa === 10).reduce((s, l) => s + l.total, 0);
  const sumaSub5 = lineas.filter((l) => l.tasa === 5).reduce((s, l) => s + l.total, 0);
  const sumaSubExe = lineas.filter((l) => l.tasa === 0).reduce((s, l) => s + l.total, 0);
  const sumaIva10 = lineas.filter((l) => l.tasa === 10).reduce((s, l) => s + l.iva, 0);
  const sumaIva5 = lineas.filter((l) => l.tasa === 5).reduce((s, l) => s + l.iva, 0);
  const sumaBase10 = lineas.filter((l) => l.tasa === 10).reduce((s, l) => s + l.base, 0);
  const sumaBase5 = lineas.filter((l) => l.tasa === 5).reduce((s, l) => s + l.base, 0);
  const sumaTotIva = sumaIva10 + sumaIva5;
  const sumaBaseGravTotal = sumaBase10 + sumaBase5;

  /** Secuencia estricta `tgTotSub` en DE_v150.xsd (igual que `buildOfficialRdeElectronicaXml` en rde-xml.ts). */
  const totParts: string[] = ["<gTotSub>"];
  if (sumaSubExe > 0) totParts.push(textEl("dSubExe", sumaSubExe));
  if (sumaSub5 > 0) totParts.push(textEl("dSub5", sumaSub5));
  totParts.push(textEl("dSub10", sumaSub10));
  totParts.push(
    textEl("dTotOpe", sumaTotOpeItem),
    textEl("dTotDesc", "0"),
    textEl("dTotDescGlotem", "0"),
    textEl("dTotAntItem", "0"),
    textEl("dTotAnt", "0"),
    textEl("dPorcDescTotal", "0"),
    textEl("dDescTotal", "0"),
    textEl("dAnticipo", "0"),
    textEl("dRedon", montoRedondeo(0)),
    textEl("dTotGralOpe", sumaTotOpeItem)
  );
  if (sumaIva5 > 0) totParts.push(textEl("dIVA5", sumaIva5));
  totParts.push(textEl("dIVA10", sumaIva10));
  totParts.push(textEl("dTotIVA", sumaTotIva));
  if (sumaBase5 > 0) totParts.push(textEl("dBaseGrav5", sumaBase5));
  totParts.push(textEl("dBaseGrav10", sumaBase10));
  totParts.push(textEl("dTBasGraIVA", sumaBaseGravTotal));
  /**
   * `dTotalGs` (minOccurs=0): solo si `cMoneOpe` ≠ PYG. Con Guaraníes, omitir (SET 2389),
   * coherente con factura electrónica en `rde-xml.ts`.
   */
  totParts.push("</gTotSub>");

  const gCamNCDE = ["<gCamNCDE>", textEl("iMotEmi", iMotEmi), textEl("dDesMotEmi", dDesMotEmi), "</gCamNCDE>"].join("");

  const gCamDEAsoc = [
    "<gCamDEAsoc>",
    textEl("iTipDocAso", "1"),
    textEl("dDesTipDocAso", "Electrónico"),
    textEl("dCdCDERef", documentoElectronicoOrigen.cdc.trim()),
    "</gCamDEAsoc>",
  ].join("");

  const deInner = [
    textEl("dDVId", dDVId),
    textEl("dFecFirma", dFecFirma),
    textEl("dSisFact", "1"),
    "<gOpeDE>",
    textEl("iTipEmi", "1"),
    textEl("dDesTipEmi", "Normal"),
    textEl("dCodSeg", dCodSeg),
    "</gOpeDE>",
    "<gTimb>",
    textEl("iTiDE", "5"),
    textEl("dDesTiDE", XSD_DES_TI_DE_NCE),
    textEl("dNumTim", dNumTim),
    textEl("dEst", dEst),
    textEl("dPunExp", dPunExp),
    textEl("dNumDoc", dNumDoc),
    textEl("dFeIniT", dFeIniT),
    "</gTimb>",
    "<gDatGralOpe>",
    textEl("dFeEmiDE", dFeEmiDE),
    "<gOpeCom>",
    textEl("iTImp", "1"),
    textEl("dDesTImp", XSD_DES_T_IMP_IVA),
    textEl("cMoneOpe", "PYG"),
    textEl("dDesMoneOpe", XSD_DES_MONE_PYG),
    "</gOpeCom>",
    ...gEmisParts,
    ...recParts,
    "</gDatGralOpe>",
    "<gDtipDE>",
    gCamNCDE,
    itemXml,
    "</gDtipDE>",
    ...totParts,
    gCamDEAsoc,
  ].join("");

  const de = `<DE Id="${escapeXml(cdc)}">${deInner}</DE>`;

  const out =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<rDE xmlns="${NS}" xmlns:xsi="${XMLNS_XSI}" xsi:schemaLocation="${escapeXml(RDE_XSI_SCHEMA_LOCATION)}">` +
    textEl("dVerFor", "150") +
    de +
    `</rDE>\n`;

  assertNcXmlGtotSubTotalsDe150Order(out);
  assertNotaCreditoXmlSinTipoTransaccionComercial(out);
  assertNotaCreditoXmlSinCondicionOperacion(out);
  return out;
}
