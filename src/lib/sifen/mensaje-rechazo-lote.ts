/**
 * Construye el mensaje de error visible cuando el envío ASÍNCRONO por lote
 * (siRecepLoteDE) devuelve `0301` (lote no encolado / rechazado).
 *
 * REGLA CLAVE: el detalle por-DE debe salir SIEMPRE de la respuesta real del
 * lote (`gResProc` dentro del SOAP de recibe-lote). NUNCA del servicio síncrono
 * (siRecepDE). Ese servicio devuelve el código `1264` ("RUC del emisor no está
 * habilitado para utilizar el servicio síncrono") para emisores que sólo están
 * habilitados para el lote — un artefacto que no tiene relación con el motivo
 * del rechazo asíncrono y que antes se mostraba como si fuera la causa.
 *
 * Ver Manual Técnico SIFEN v150, validación D101c (cód. 1264): es exclusiva del
 * servicio síncrono. El lote no produce 1264.
 */

/** Decodifica las entidades SOAP básicas que trae `dMsgRes`. */
export function decodificarEntidadesSoapBasicas(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(String(n), 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function firstText(xml: string, local: string): string | null {
  const re = new RegExp(
    `<(?:[^\\s/>:]+:)?${local}\\b[^>]*>([\\s\\S]*?)</(?:[^\\s/>:]+:)?${local}\\b[^>]*>`,
    "i"
  );
  const m = xml.match(re);
  if (!m?.[1]) return null;
  const inner = m[1].replace(/<[^>]+>/g, "").trim();
  return inner.length > 0 ? inner : null;
}

function allBlocks(xml: string, local: string): string[] {
  const re = new RegExp(
    `<(?:[^\\s/>:]+:)?${local}\\b[^>]*>([\\s\\S]*?)</(?:[^\\s/>:]+:)?${local}\\b[^>]*>`,
    "gi"
  );
  const out: string[] = [];
  for (const m of xml.matchAll(re)) if (m[1]) out.push(m[1]);
  return out;
}

export interface GResProcItem {
  dCodRes: string | null;
  dMsgRes: string | null;
}

/**
 * Extrae todos los `gResProc` (código + mensaje por-DE) de un SOAP de lote.
 * Si la respuesta del lote no trae detalle por-DE, devuelve `[]`.
 */
export function extraerGResProcLoteDeSoap(cuerpoSoapCrudo: string): GResProcItem[] {
  if (!cuerpoSoapCrudo) return [];
  return allBlocks(cuerpoSoapCrudo, "gResProc").map((b) => ({
    dCodRes: firstText(b, "dCodRes"),
    dMsgRes: firstText(b, "dMsgRes"),
  }));
}

export interface MensajeRechazoLoteInput {
  /** `dCodRes` del lote (nivel lote, típicamente "0301"). */
  dCodRes: string | null;
  /** `dMsgRes` del lote. */
  dMsgRes: string | null;
  /** SOAP crudo de la respuesta de recibe-lote (para extraer el detalle real por-DE). */
  cuerpoSoapCrudo: string | null;
  /** Protocolo de consulta de lote, si SET lo devolvió. */
  protocolo: string | null;
  /** Pista para consultar el lote, p. ej. " — Use «Consultar lote SET» con el protocolo". */
  consultaLoteHint: string;
}

/**
 * Arma el texto de error para un rechazo de lote `0301`, tomando el detalle
 * por-DE EXCLUSIVAMENTE de la respuesta del lote. Nunca inyecta el 1264 síncrono.
 */
export function construirMensajeRechazoLote(input: MensajeRechazoLoteInput): string {
  const baseErr =
    [input.dMsgRes, input.dCodRes ? `Código ${input.dCodRes}` : null]
      .filter(Boolean)
      .join(" — ") || "SET no encoló el lote (0301).";

  // Detalle REAL por-DE, tomado de la respuesta del lote (no del síncrono).
  const gres = extraerGResProcLoteDeSoap(input.cuerpoSoapCrudo ?? "");
  const primero = gres.find((g) => g.dCodRes && g.dCodRes.trim() !== "");
  const detalle = primero
    ? ` ${decodificarEntidadesSoapBasicas(`[${primero.dCodRes}] ${primero.dMsgRes ?? ""}`.trim())}`
    : "";

  const prot = (input.protocolo ?? "").trim();
  const sufProt = prot.length > 0 ? `${input.consultaLoteHint} ${prot} para más detalle si aplica.` : "";

  return `${baseErr}${detalle ? `.${detalle}` : ""}${sufProt}`;
}
