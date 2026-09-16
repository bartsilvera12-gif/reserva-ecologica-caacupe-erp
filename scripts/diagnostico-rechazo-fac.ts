/**
 * Diagnóstico READ-ONLY del rechazo SIFEN de una factura (default FAC-000080).
 *
 * Qué hace (y qué NO hace):
 *   - NO reenvía, NO regenera, NO firma, NO escribe en la BD.
 *   - NO usa el servicio síncrono (recibirDeSifenSync). El código 1264 proviene
 *     de ese servicio y NO es la causa del rechazo del envío asíncrono.
 *
 *   1. Lee factura_electronica.sifen_ultima_respuesta_recibe_lote (envío ASÍNCRONO
 *      real, siRecepLoteDE) y parsea el SOAP crudo: dCodRes/dMsgRes de lote +
 *      TODOS los gResProc por DE (dCodRes/dMsgRes) que la respuesta contenga.
 *   2. Consulta el DE por CDC en el ambiente configurado (producción) → siConsDE.
 *      - Si SET lo reporta APROBADO: se marca STOP (no reenviar) y se listan los
 *        datos del DTE (dEstRes, dProtAut).
 *      - Si SET responde NO ENCONTRADO (0420): se reporta explícitamente.
 *   3. Si el SOAP del 0301 NO trae el motivo por-DE, consulta el lote por
 *      protocolo → siResultLoteDE, y extrae de ahí el detalle real por CDC.
 *
 * Uso:
 *   npx tsx scripts/diagnostico-rechazo-fac.ts
 *   npx tsx scripts/diagnostico-rechazo-fac.ts --numero FAC-000080 --protocolo 85010225259220718
 *
 * Requiere .env.local con NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY y
 * SIFEN_SECRETS_KEY alineada con producción (o E2E_CERT_PASSWORD_PLAIN).
 */
import path from "node:path";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { resolveP12PasswordForScripts } from "../src/lib/sifen/resolve-p12-password-for-scripts";
import { downloadSifenCertificadoObject } from "../src/lib/sifen/sifen-certificados-storage";
import { consultarDePorCdc } from "../src/lib/sifen/consulta-de-por-cdc";
import { consultarLoteSifen } from "../src/lib/sifen/consulta-lote-sifen-test";

dotenv.config({ path: path.join(process.cwd(), ".env.local") });

const DEFAULT_NUMERO = "FAC-000080";
const DEFAULT_PROTOCOLO = "85010225259220718";

function parseArgs(): { numero: string; protocolo: string } {
  const argv = process.argv.slice(2);
  let numero = DEFAULT_NUMERO;
  let protocolo = DEFAULT_PROTOCOLO;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--numero") numero = String(argv[++i] ?? "").trim();
    else if (argv[i] === "--protocolo") protocolo = String(argv[++i] ?? "").trim();
  }
  return { numero, protocolo };
}

/** Extrae el primer elemento hoja (prefijo opcional). */
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

/** Devuelve el contenido interno de todos los bloques <local>...</local>. */
function allBlocks(xml: string, local: string): string[] {
  const re = new RegExp(
    `<(?:[^\\s/>:]+:)?${local}\\b[^>]*>([\\s\\S]*?)</(?:[^\\s/>:]+:)?${local}\\b[^>]*>`,
    "gi"
  );
  const out: string[] = [];
  for (const m of xml.matchAll(re)) if (m[1]) out.push(m[1]);
  return out;
}

/** Todos los gResProc {dCodRes,dMsgRes} presentes en un SOAP crudo. */
function extraerGResProc(xml: string): Array<{ dCodRes: string | null; dMsgRes: string | null }> {
  return allBlocks(xml, "gResProc").map((b) => ({
    dCodRes: firstText(b, "dCodRes"),
    dMsgRes: firstText(b, "dMsgRes"),
  }));
}

function decodificarEntidadesSoapBasicas(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(String(n), 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

async function main() {
  const { numero, protocolo } = parseArgs();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en .env.local");
    process.exit(1);
  }

  const supabase = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // --- 1. Resolver la factura por número y su registro electrónico ---
  const { data: fac, error: errFac } = await supabase
    .from("facturas")
    .select("id, numero_factura, empresa_id")
    .eq("numero_factura", numero)
    .limit(2);
  if (errFac) {
    console.error("facturas:", errFac.message);
    process.exit(1);
  }
  if (!fac || fac.length === 0) {
    console.error(`No se encontró factura con numero_factura=${numero}`);
    process.exit(1);
  }
  if (fac.length > 1) {
    console.error(`Hay más de una factura ${numero} (multi-tenant). Precise por empresa/CDC.`);
    process.exit(1);
  }
  const factura = fac[0];

  const { data: fe, error: errFe } = await supabase
    .from("factura_electronica")
    .select(
      "id, factura_id, empresa_id, estado_sifen, cdc, error, sifen_d_prot_cons_lote, sifen_aprobado_at, sifen_ultima_respuesta_recibe_lote"
    )
    .eq("factura_id", factura.id)
    .eq("empresa_id", factura.empresa_id)
    .maybeSingle();
  if (errFe) {
    console.error("factura_electronica:", errFe.message);
    process.exit(1);
  }
  if (!fe) {
    console.error(`La factura ${numero} no tiene registro en factura_electronica.`);
    process.exit(1);
  }

  const cdc = String(fe.cdc ?? "").replace(/\D/g, "");
  const protStored = fe.sifen_d_prot_cons_lote == null ? null : String(fe.sifen_d_prot_cons_lote).trim();

  // --- 2. Parsear el SOAP crudo del envío ASÍNCRONO ya guardado ---
  const ultima = (fe.sifen_ultima_respuesta_recibe_lote ?? null) as Record<string, unknown> | null;
  const rawSoap = ultima && typeof ultima.cuerpoSoapCrudo === "string" ? ultima.cuerpoSoapCrudo : "";
  const loteCod = ultima && ultima.dCodRes != null ? String(ultima.dCodRes) : firstText(rawSoap, "dCodRes");
  const loteMsg = ultima && ultima.dMsgRes != null ? String(ultima.dMsgRes) : firstText(rawSoap, "dMsgRes");
  const gResProcLote = rawSoap ? extraerGResProc(rawSoap).map((g) => ({
    dCodRes: g.dCodRes,
    dMsgRes: g.dMsgRes ? decodificarEntidadesSoapBasicas(g.dMsgRes) : null,
  })) : [];
  const motivoPorDeEnSoapInicial = gResProcLote.length > 0;

  // --- 3. Config SIFEN de la empresa (ambiente + certificado) ---
  const { data: cfg, error: errCfg } = await supabase
    .from("empresa_sifen_config")
    .select("ambiente, activo, certificado_path, certificado_password_encrypted")
    .eq("empresa_id", fe.empresa_id)
    .maybeSingle();
  if (errCfg || !cfg) {
    console.error("empresa_sifen_config:", errCfg?.message ?? "no encontrada");
    process.exit(1);
  }
  const ambiente = String(cfg.ambiente ?? "").trim().toLowerCase() === "produccion" ? "produccion" : "test";

  const certPath = String(cfg.certificado_path ?? "").trim();
  const p12Dl = certPath
    ? await downloadSifenCertificadoObject(supabase as Parameters<typeof downloadSifenCertificadoObject>[0], certPath)
    : { ok: false as const, message: "certificado_path vacío" };
  let p12: Buffer | null = null;
  let p12Password: string | null = null;
  let certError: string | null = null;
  if (p12Dl.ok) {
    p12 = p12Dl.data;
    try {
      p12Password = resolveP12PasswordForScripts(String(cfg.certificado_password_encrypted ?? ""));
    } catch (e) {
      certError = e instanceof Error ? e.message : String(e);
    }
  } else {
    certError = p12Dl.message;
  }

  // --- 4. Consulta DE por CDC (siConsDE) — read-only ---
  let consultaDe: unknown = { omitida: true, motivo: "sin CDC de 44 dígitos o sin certificado" };
  let dteAprobado = false;
  if (cdc.length === 44 && p12 && p12Password) {
    try {
      const r = await consultarDePorCdc({ ambiente, cdc, certificadoP12: p12, certificadoPassword: p12Password });
      dteAprobado = r.aprobado;
      consultaDe = {
        httpStatus: r.httpStatus,
        dCodRes: r.dCodRes,
        dMsgRes: r.dMsgRes,
        dEstRes: r.dEstRes,
        dProtAut: r.dProtAut,
        aprobado: r.aprobado,
        rechazado: r.rechazado,
        noEncontrado: r.noEncontrado,
      };
    } catch (e) {
      consultaDe = { error: e instanceof Error ? e.message : String(e) };
    }
  } else if (certError) {
    consultaDe = { omitida: true, motivo: `certificado no disponible: ${certError}` };
  }

  // --- 5. Consulta de lote por protocolo (siResultLoteDE) SÓLO si el SOAP inicial no trae motivo por-DE ---
  let consultaLote: unknown = { omitida: true, motivo: "el SOAP del 0301 ya trae motivo por-DE (gResProc)" };
  const protParaConsulta = protStored || protocolo;
  if (!motivoPorDeEnSoapInicial && p12 && p12Password && protParaConsulta && /^[0-9]+$/.test(protParaConsulta)) {
    try {
      const r = await consultarLoteSifen({
        dProtConsLote: protParaConsulta,
        empresaConfig: { ambiente, certificadoP12: p12, certificadoPassword: p12Password },
        facturaElectronicaId: String(fe.id),
      });
      consultaLote = {
        protocoloUsado: protParaConsulta,
        httpStatus: r.httpStatus,
        soapFault: r.soapFault,
        faultString: r.faultString,
        dCodResLot: r.dCodResLot,
        dMsgResLot: r.dMsgResLot,
        dFecProc: r.dFecProc,
        detalle_por_cdc: r.detalle_por_cdc,
      };
    } catch (e) {
      consultaLote = { protocoloUsado: protParaConsulta, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // --- Reporte ---
  const salida = {
    consultadoEn: new Date().toISOString(),
    ambiente,
    factura: { numero: factura.numero_factura, factura_id: factura.id, factura_electronica_id: fe.id },
    estado_erp: fe.estado_sifen,
    cdc: cdc || null,
    protocolo: { en_bd: protStored, arg_cli: protocolo, coincide: protStored === protocolo },
    error_persistido_actual: fe.error,
    envio_asincrono_recibe_lote: {
      dCodRes_lote: loteCod,
      dMsgRes_lote: loteMsg,
      gResProc_por_DE: gResProcLote,
      motivo_por_DE_presente_en_soap_inicial: motivoPorDeEnSoapInicial,
      hay_soap_crudo_guardado: rawSoap.length > 0,
    },
    consulta_de_por_cdc: consultaDe,
    consulta_lote_por_protocolo: consultaLote,
    certificado: certError ? { ok: false, motivo: certError } : { ok: true },
  };

  console.log(JSON.stringify(salida, null, 2));

  // Veredicto legible
  console.log("\n================ VEREDICTO ================");
  if (dteAprobado) {
    console.log("⛔ STOP: SET reporta el DE como APROBADO. NO reenviar ni regenerar (duplicaría el DTE).");
  } else if (typeof consultaDe === "object" && consultaDe && (consultaDe as { noEncontrado?: boolean }).noEncontrado) {
    console.log("✓ SET responde CDC NO ENCONTRADO (0420): no hay DTE aprobado; reenviar/regenerar es seguro.");
  } else {
    console.log("• Consulta CDC sin veredicto de aprobado (ver bloque consulta_de_por_cdc).");
  }
  const codigoReal =
    gResProcLote.find((g) => g.dCodRes && g.dCodRes.trim() !== "")?.dCodRes ??
    (typeof consultaLote === "object" && consultaLote
      ? ((consultaLote as { detalle_por_cdc?: Array<{ grupo_res?: Array<{ dCodRes: string }> }> }).detalle_por_cdc ?? [])
          .flatMap((d) => d.grupo_res ?? [])
          .map((g) => g.dCodRes)[0]
      : undefined);
  console.log(`• Código de rechazo REAL del lote: ${codigoReal ?? "(no visible aún — revisar bloques de arriba)"}`);
  console.log("• Nota: el 1264 NO se consultó a propósito (proviene del servicio síncrono, no del envío).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
