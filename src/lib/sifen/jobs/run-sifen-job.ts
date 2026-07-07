import type { AppSupabaseClient } from "@/lib/supabase/schema";
import { getFacturasServiceClientForEmpresa } from "@/lib/facturacion/facturas-service-client";
import { buildAuthSintetico } from "@/lib/sifen/jobs/auth-sintetico";
import {
  invokeSifenXml,
  invokeSifenFirmar,
  invokeSifenEnviar,
  invokeSifenConsultaLote,
  extraerEstadoSifen,
  type HandlerResult,
} from "@/lib/sifen/jobs/handlers-invoker";
import {
  setSifenJobEtapa,
  setSifenJobEtapaTiempo,
  completeSifenJobAprobado,
  completeSifenJobRechazado,
  registrarIntentoYPlanificar,
} from "@/lib/sifen/jobs/sifen-jobs-repo";
import type {
  SifenJobDTO,
  SifenJobEtapa,
  SifenJobTipoError,
  FacturaElectronicaDTO,
} from "@/lib/sifen/types";

const LABEL = "[sifen-worker]";

/** Config de polling interno de consulta-lote antes de re-encolar. */
const CONSULTA_INTENTOS_INLINE = 4;
const CONSULTA_DELAYS_MS = [1_000, 2_000, 4_000, 8_000]; // ~15s total
/**
 * Cuántas veces se puede re-encolar el Job por "SET sigue en proceso" antes
 * de rendirse. 10 re-encolados × 30s = ~5 min de espera total (más los 15s
 * de polling inline por ciclo). Suficiente para mantenimientos cortos de SET.
 * Después el Job se cierra con tipo_error='set_timeout' y el operador puede
 * consultar manualmente cuando quiera.
 */
const MAX_RE_ENCOLADOS_CONSULTA = 10;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Clasifica un HandlerResult fallido en `tipo_error` según status y mensaje. */
function clasificarError(status: number, mensaje: string): SifenJobTipoError {
  const msg = mensaje.toLowerCase();
  // 502 → recibe-lote/consulta-lote no pudo llegar a SET (red o timeout).
  if (status === 502) return "red";
  // 5xx en general.
  if (status >= 500 && status < 600) {
    if (msg.includes("storage") || msg.includes("bucket") || msg.includes("no se pudo descargar") || msg.includes("no se pudo guardar")) {
      return "storage";
    }
    if (msg.includes("firma") || msg.includes("firmar") || msg.includes(".p12") || msg.includes("xml-dsig")) {
      return "firma";
    }
    return "inesperado";
  }
  // 400/409 → validaciones y configuración.
  if (status === 400 || status === 409) {
    if (
      msg.includes("configuración sifen") ||
      msg.includes("configuracion sifen") ||
      msg.includes("csc") ||
      msg.includes("timbrado") ||
      msg.includes("certificado") ||
      msg.includes("ambiente sifen") ||
      msg.includes("contraseña del certificado")
    ) {
      return "config";
    }
    if (msg.includes(".p12") || msg.includes("firma") || msg.includes("firmar")) {
      return "firma";
    }
    // Reglas fiscales del XML (loadValidatedSifenPayload / buildOfficialRdeFacturaElectronicaXml).
    return "fiscal";
  }
  return "inesperado";
}

/** Clasifica una excepción JS (fuera del handler) por tipo (red / timeout / inesperado). */
function clasificarExcepcion(err: unknown): { tipo: SifenJobTipoError; msg: string } {
  const msg = err instanceof Error ? err.message : String(err);
  const lm = msg.toLowerCase();
  if (
    lm.includes("etimedout") ||
    lm.includes("econnreset") ||
    lm.includes("econnrefused") ||
    lm.includes("eai_again") ||
    lm.includes("network") ||
    lm.includes("fetch failed") ||
    lm.includes("timeout")
  ) {
    return { tipo: "red", msg };
  }
  return { tipo: "inesperado", msg };
}

/** Lee el estado_sifen actual — para idempotencia (saltar etapas ya hechas). */
async function leerEstadoActual(
  supabase: AppSupabaseClient,
  empresaId: string,
  facturaId: string
): Promise<FacturaElectronicaDTO | null> {
  const { data, error } = await supabase
    .from("factura_electronica")
    .select("*")
    .eq("factura_id", facturaId)
    .eq("empresa_id", empresaId)
    .maybeSingle();
  if (error || !data) return null;
  return data as FacturaElectronicaDTO;
}

/**
 * Re-encola el mismo Job con backoff — para consulta-lote cuando SET sigue
 * procesando. NO cuenta como intento fallido (no incrementa `intentos`), pero
 * sí incrementa `veces_re_encolado_consulta` para poder cortarlo eventualmente.
 * Devuelve el nuevo valor del contador.
 */
async function reencolarConsultaEnCurso(
  supabase: AppSupabaseClient,
  job: SifenJobDTO,
  delayMs: number
): Promise<number> {
  const proximo = new Date(Date.now() + delayMs).toISOString();
  const nuevoContador = job.veces_re_encolado_consulta + 1;
  await supabase
    .from("sifen_jobs")
    .update({
      estado: "pendiente",
      etapa: null,
      procesando_desde: null,
      lock_owner: null,
      proximo_reintento_at: proximo,
      veces_re_encolado_consulta: nuevoContador,
    })
    .eq("id", job.id);
  return nuevoContador;
}

/**
 * Cierra el Job en 'error' con tipo_error='set_timeout' cuando SET nunca
 * confirmó el lote tras MAX_RE_ENCOLADOS_CONSULTA. La factura queda en
 * estado 'enviado' (que ya está persistido) y el operador puede darle
 * "Consultar lote" cuando SET responda.
 */
async function cerrarPorSetTimeout(
  supabase: AppSupabaseClient,
  jobId: string,
  vecesReencolado: number,
  tiempoTotalMs: number
): Promise<void> {
  const nowIso = new Date().toISOString();
  const mensaje =
    `SET no confirmó el lote tras ${vecesReencolado} re-intentos automáticos ` +
    `(~${Math.round((vecesReencolado * 30) / 60)} min). La factura sigue registrada como enviada ` +
    `en SET; podés usar "Consultar lote" para verificar el resultado cuando SET responda.`;
  const { error } = await supabase
    .from("sifen_jobs")
    .update({
      estado: "error",
      etapa: "consulta_lote",
      finished_at: nowIso,
      procesando_desde: null,
      lock_owner: null,
      ultimo_error: mensaje,
      tipo_error: "set_timeout",
      tiempo_total_ms: Math.max(0, Math.floor(tiempoTotalMs)),
    })
    .eq("id", jobId);
  if (error) {
    console.error("[sifen-worker] cerrarPorSetTimeout error:", error.message);
  }
}

/**
 * Extrae código SET + subcódigo + mensaje del recibe-lote cuando SET rechaza
 * el lote entero (0301). El mensaje del handler enviar concatena
 * `dMsgRes — Código dCodRes[ detalle]` — parseamos ambos por separado.
 */
function extraerCodigosDelEnviar(
  recibeLote: {
    dCodRes?: string | null;
    dMsgRes?: string | null;
    loteRecibido?: boolean;
    loteNoEncolado?: boolean;
  } | null | undefined,
  feError: string | null | undefined
): { cod: string | null; sub: string | null; msg: string | null } {
  const cod = recibeLote?.dCodRes == null ? null : String(recibeLote.dCodRes).trim() || null;
  const msgSet = recibeLote?.dMsgRes == null ? null : String(recibeLote.dMsgRes).trim() || null;
  // Sub-código: patrón "[1264]" dentro de dMsgRes o del feError.
  const source = `${msgSet ?? ""} ${feError ?? ""}`;
  const subMatch = /\[(\d{2,5})\]/.exec(source);
  const sub = subMatch?.[1] ?? null;
  return { cod, sub, msg: msgSet };
}

interface EtapaMedidaOk<T> {
  ok: true;
  data: T;
  ms: number;
}
interface EtapaMedidaErr {
  ok: false;
  status: number;
  error: string;
  ms: number;
  excepcion?: unknown;
}
type EtapaMedida<T> = EtapaMedidaOk<T> | EtapaMedidaErr;

async function medir<T>(fn: () => Promise<HandlerResult<T>>): Promise<EtapaMedida<T>> {
  const t0 = Date.now();
  try {
    const res = await fn();
    const ms = Date.now() - t0;
    if (res.ok) return { ok: true, data: res.data, ms };
    return { ok: false, status: res.status, error: res.error, ms };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      error: e instanceof Error ? e.message : String(e),
      ms: Date.now() - t0,
      excepcion: e,
    };
  }
}

async function fallarIntento(
  supabase: AppSupabaseClient,
  job: SifenJobDTO,
  etapa: SifenJobEtapa,
  tipoError: SifenJobTipoError,
  mensaje: string,
  tiempoMs: number
): Promise<void> {
  const label = `${LABEL}[${job.id}]`;
  const result = await registrarIntentoYPlanificar(supabase, {
    jobActual: job,
    etapa,
    tipoError,
    mensaje,
    tiempoMs,
  });
  console.log(
    `${label} intento ${job.intentos + 1} fallido en etapa=${etapa} tipo=${tipoError} → ${result} (${tiempoMs}ms) msg="${mensaje.slice(0, 300)}"`
  );
}

/**
 * Orquesta el ciclo completo de un Job: xml → firmar → enviar → consulta_lote.
 * Idempotente: lee el estado_sifen antes de cada etapa y salta las ya hechas.
 * Si SET rechaza → cierra el Job como 'rechazado' con el código real.
 * Si falla algo técnico → registra intento; si es reintentable y quedan
 * intentos, re-encola con backoff (5s/20s); si no, cierra como 'error'.
 * Si consulta-lote sigue en proceso → re-encola sin contar como intento.
 */
export async function runSifenJob(job: SifenJobDTO): Promise<void> {
  const label = `${LABEL}[${job.id}]`;
  const totalStart = Date.now();
  const auth = buildAuthSintetico(job.empresa_id);
  let supabase: AppSupabaseClient;
  try {
    supabase = await getFacturasServiceClientForEmpresa(job.empresa_id);
  } catch (e) {
    // Sin cliente Supabase no podemos ni siquiera marcar el error. Log y salir.
    console.error(`${label} no se pudo instanciar service client:`, e);
    return;
  }

  const fid = job.factura_id;
  // Métricas por etapa acumuladas en memoria para el log final.
  const tiempos = { xml: 0, firmar: 0, enviar: 0, consulta: 0 };

  try {
    // === XML ===
    {
      const fe = await leerEstadoActual(supabase, job.empresa_id, fid);
      const st = extraerEstadoSifen(fe);
      // Bloqueadores terminales.
      if (st === "aprobado" || st === "cancelado") {
        console.log(`${label} DE ya en estado terminal ${st} — cerrando Job como aprobado si aplica`);
        if (st === "aprobado") {
          await completeSifenJobAprobado(supabase, job.id, {
            cdc: fe?.cdc ?? null,
            protocoloLote: fe?.sifen_d_prot_cons_lote ?? null,
            respuestaConsultaLote:
              (fe?.sifen_ultima_respuesta_consulta_lote as unknown as Record<string, unknown> | null) ?? null,
            respuestaRecibeLote:
              (fe?.sifen_ultima_respuesta_recibe_lote as unknown as Record<string, unknown> | null) ?? null,
            tiempoTotalMs: Date.now() - totalStart,
          });
        }
        return;
      }
      const necesitaXml = !fe || st === "" || st === "borrador" || st === "rechazado";
      if (necesitaXml) {
        await setSifenJobEtapa(supabase, job.id, "xml");
        const r = await medir(() => invokeSifenXml(auth, supabase, fid));
        if (!r.ok) {
          const tipo = clasificarError(r.status, r.error);
          await fallarIntento(supabase, job, "xml", tipo, r.error, r.ms);
          return;
        }
        tiempos.xml = r.ms;
        await setSifenJobEtapaTiempo(supabase, job.id, "xml", r.ms);
        console.log(`${label} etapa=xml ok (${r.ms}ms)`);
      }
    }

    // === FIRMAR ===
    {
      const fe = await leerEstadoActual(supabase, job.empresa_id, fid);
      const st = extraerEstadoSifen(fe);
      const necesitaFirmar =
        st === "generado" ||
        (st === "error_envio" && !!fe?.xml_path && !fe?.xml_firmado_path);
      if (necesitaFirmar) {
        await setSifenJobEtapa(supabase, job.id, "firmar");
        const r = await medir(() => invokeSifenFirmar(auth, supabase, fid));
        if (!r.ok) {
          const tipo = clasificarError(r.status, r.error);
          await fallarIntento(supabase, job, "firmar", tipo, r.error, r.ms);
          return;
        }
        tiempos.firmar = r.ms;
        await setSifenJobEtapaTiempo(supabase, job.id, "firmar", r.ms);
        console.log(`${label} etapa=firmar ok (${r.ms}ms)`);
      }
    }

    // === ENVIAR ===
    {
      const fe = await leerEstadoActual(supabase, job.empresa_id, fid);
      const st = extraerEstadoSifen(fe);
      const necesitaEnviar =
        st === "firmado" || (st === "error_envio" && !!fe?.xml_firmado_path);
      if (necesitaEnviar) {
        await setSifenJobEtapa(supabase, job.id, "enviar");
        const r = await medir(() => invokeSifenEnviar(auth, supabase, fid));
        if (!r.ok) {
          const tipo = clasificarError(r.status, r.error);
          await fallarIntento(supabase, job, "enviar", tipo, r.error, r.ms);
          return;
        }
        tiempos.enviar = r.ms;
        await setSifenJobEtapaTiempo(supabase, job.id, "enviar", r.ms);
        const recibe = r.data.recibe_lote;
        // Rechazo directo del lote entero (0301 típico): la factura queda en
        // 'error_envio' pero SET ya se pronunció — cerramos como 'rechazado'.
        if (recibe && recibe.loteNoEncolado === true) {
          const codigos = extraerCodigosDelEnviar(
            recibe,
            r.data.factura_electronica?.error ?? null
          );
          await completeSifenJobRechazado(supabase, job.id, {
            etapa: "enviar",
            codigoErrorSet: codigos.cod,
            codigoSubErrorSet: codigos.sub,
            mensajeSet: codigos.msg ?? r.data.factura_electronica?.error ?? "SET rechazó el lote (0301).",
            respuestaRecibeLote: recibe as unknown as Record<string, unknown>,
            respuestaConsultaLote: null,
            tiempoTotalMs: Date.now() - totalStart,
          });
          console.log(
            `${label} SET rechazó lote codigo=${codigos.cod} sub=${codigos.sub ?? "-"} — cerrando como rechazado`
          );
          return;
        }
        console.log(`${label} etapa=enviar ok (${r.ms}ms) protocolo=${recibe?.dProtConsLote ?? "-"}`);
      }
    }

    // === CONSULTA-LOTE (polling inline) ===
    {
      await setSifenJobEtapa(supabase, job.id, "consulta_lote");
      const consultaStart = Date.now();
      let ultimoResumen: string | null = null;
      let ultimoEstado: string = "";

      for (let i = 0; i < CONSULTA_INTENTOS_INLINE; i++) {
        // Delay antes de cada intento (SET necesita tiempo para procesar).
        await sleep(CONSULTA_DELAYS_MS[i] ?? 8_000);

        const r = await medir(() => invokeSifenConsultaLote(auth, supabase, fid));
        if (!r.ok) {
          const tipo = clasificarError(r.status, r.error);
          await fallarIntento(supabase, job, "consulta_lote", tipo, r.error, Date.now() - consultaStart);
          return;
        }
        const feResp = r.data.factura_electronica;
        ultimoEstado = extraerEstadoSifen(feResp);
        ultimoResumen = r.data.consulta_lote?.resumenInferido ?? null;

        if (ultimoEstado === "aprobado") {
          await setSifenJobEtapaTiempo(supabase, job.id, "consulta_lote", Date.now() - consultaStart);
          await completeSifenJobAprobado(supabase, job.id, {
            cdc: feResp.cdc ?? null,
            protocoloLote: feResp.sifen_d_prot_cons_lote ?? null,
            respuestaConsultaLote:
              (feResp.sifen_ultima_respuesta_consulta_lote as unknown as Record<string, unknown> | null) ?? null,
            respuestaRecibeLote:
              (feResp.sifen_ultima_respuesta_recibe_lote as unknown as Record<string, unknown> | null) ?? null,
            tiempoTotalMs: Date.now() - totalStart,
          });
          tiempos.consulta = Date.now() - consultaStart;
          console.log(
            `${label} DE aprobado por SET — total=${Date.now() - totalStart}ms xml=${tiempos.xml}ms firmar=${tiempos.firmar}ms enviar=${tiempos.enviar}ms consulta=${tiempos.consulta}ms cdc=${feResp.cdc ?? "-"}`
          );
          return;
        }
        if (ultimoEstado === "rechazado") {
          await setSifenJobEtapaTiempo(supabase, job.id, "consulta_lote", Date.now() - consultaStart);
          const uc = feResp.sifen_ultima_respuesta_consulta_lote as
            | { dCodResLot?: string | null; dMsgResLot?: string | null; detallePorCdc?: unknown[] }
            | null
            | undefined;
          // Sub-código: buscar en detallePorCdc[0].grupoRes[0].dCodRes.
          const detalle = Array.isArray(uc?.detallePorCdc) ? (uc?.detallePorCdc as Array<{ grupoRes?: Array<{ dCodRes?: string; dMsgRes?: string }> }>) : [];
          const grupo0 = detalle[0]?.grupoRes?.[0];
          await completeSifenJobRechazado(supabase, job.id, {
            etapa: "consulta_lote",
            codigoErrorSet: uc?.dCodResLot ?? null,
            codigoSubErrorSet: grupo0?.dCodRes ?? null,
            mensajeSet: grupo0?.dMsgRes ?? uc?.dMsgResLot ?? feResp.error ?? "SET rechazó el DE.",
            respuestaConsultaLote: uc as unknown as Record<string, unknown>,
            respuestaRecibeLote:
              (feResp.sifen_ultima_respuesta_recibe_lote as unknown as Record<string, unknown> | null) ?? null,
            tiempoTotalMs: Date.now() - totalStart,
          });
          console.log(
            `${label} DE rechazado por SET codigo=${uc?.dCodResLot ?? "-"} sub=${grupo0?.dCodRes ?? "-"} — cerrando como rechazado`
          );
          return;
        }
        // Sigue en enviado/en_proceso. Reintento inline.
      }

      // Se agotaron los intentos inline. Decidimos entre re-encolar o cerrar
      // por set_timeout según el contador de re-encolados previos.
      await setSifenJobEtapaTiempo(supabase, job.id, "consulta_lote", Date.now() - consultaStart);
      if (job.veces_re_encolado_consulta >= MAX_RE_ENCOLADOS_CONSULTA) {
        await cerrarPorSetTimeout(
          supabase,
          job.id,
          job.veces_re_encolado_consulta,
          Date.now() - totalStart
        );
        console.warn(
          `${label} SET sigue en proceso tras ${job.veces_re_encolado_consulta} re-encolados — cerrando como set_timeout (DE queda en 'enviado' con protocolo; el operador puede consultar-lote manual).`
        );
        return;
      }
      const nuevoContador = await reencolarConsultaEnCurso(supabase, job, 30_000);
      console.log(
        `${label} SET sigue en proceso (${ultimoEstado}, resumen="${ultimoResumen ?? "-"}"). Re-encolado +30s (${nuevoContador}/${MAX_RE_ENCOLADOS_CONSULTA}).`
      );
      return;
    }
  } catch (e) {
    // Cualquier excepción no capturada en las etapas.
    const { tipo, msg } = clasificarExcepcion(e);
    const etapaActual = (job.etapa ?? "xml") as SifenJobEtapa;
    console.error(`${label} excepción no capturada en etapa=${etapaActual}:`, msg);
    try {
      await fallarIntento(supabase, job, etapaActual, tipo, msg, Date.now() - totalStart);
    } catch (e2) {
      console.error(`${label} tampoco pudo registrar el fallo:`, e2);
    }
  }
}
