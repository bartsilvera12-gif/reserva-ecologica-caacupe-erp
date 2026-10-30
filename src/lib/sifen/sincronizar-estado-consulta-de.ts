/**
 * Sincroniza el estado_sifen de una factura con lo que SET reporta por
 * **Consulta DE (siConsDE)** — consulta directa por CDC, NO por lote.
 *
 * Caso de uso principal: el lote quedó colgado en "en proceso" (consulta-lote
 * nunca resuelve, 0361/0362). El DE puede estar ya aprobado del lado de SET
 * aunque el lote siga trabado. Esta consulta por CDC es la fuente autoritativa.
 *
 * Solo sincroniza si SET da un veredicto explícito (aprobado / rechazado). Si
 * SET no conoce el CDC o no opina, no toca el estado (solo guarda diagnóstico).
 *
 * Reutilizado por:
 *   - El endpoint POST /api/facturas/[id]/sifen/consulta-de (acción manual).
 *   - El worker SIFEN, como fallback automático cuando la consulta-lote se
 *     traba (ver run-sifen-job.ts).
 */
import type { AppSupabaseClient } from "@/lib/supabase/schema";
import { downloadSifenCertificadoObject } from "@/lib/sifen/sifen-certificados-storage";
import { decryptSecret } from "@/lib/sifen/security";
import { consultarDePorCdc } from "@/lib/sifen/consulta-de-por-cdc";
import type { AmbienteSifen } from "@/lib/sifen/types";

export type SincronizarConsultaDeResult =
  | {
      ok: true;
      cambio: boolean;
      estado_sifen: string;
      estado_sifen_anterior: string;
      set: {
        dCodRes: string | null;
        dMsgRes: string | null;
        dEstRes: string | null;
        dProtAut: string | null;
        noEncontrado: boolean;
        aprobado: boolean;
        rechazado: boolean;
      };
    }
  | { ok: false; status: number; error: string };

export async function sincronizarEstadoDesdeConsultaDe(
  supabase: AppSupabaseClient,
  empresaId: string,
  facturaId: string
): Promise<SincronizarConsultaDeResult> {
  const { data: fe, error: errFe } = await supabase
    .from("factura_electronica")
    .select("id, factura_id, estado_sifen, cdc, sifen_aprobado_at, sifen_ultima_respuesta_consulta_lote")
    .eq("factura_id", facturaId)
    .eq("empresa_id", empresaId)
    .maybeSingle();

  if (errFe) return { ok: false, status: 400, error: errFe.message };
  if (!fe) return { ok: false, status: 404, error: "La factura no tiene documento electrónico." };

  const cdc = String((fe as { cdc?: string | null }).cdc ?? "").trim();
  if (cdc.length !== 44) {
    return { ok: false, status: 409, error: "La factura no tiene CDC válido; no hay nada que consultar." };
  }

  const { data: cfg, error: errCfg } = await supabase
    .from("empresa_sifen_config")
    .select("ambiente, certificado_path, certificado_password_encrypted")
    .eq("empresa_id", empresaId)
    .maybeSingle();

  if (errCfg) return { ok: false, status: 400, error: errCfg.message };
  if (!cfg) return { ok: false, status: 400, error: "No hay configuración SIFEN." };

  const ambiente: AmbienteSifen =
    String((cfg as { ambiente?: string }).ambiente ?? "").trim().toLowerCase() === "produccion"
      ? "produccion"
      : "test";

  const certPath = String((cfg as { certificado_path?: string | null }).certificado_path ?? "").trim();
  const encPwd = (cfg as { certificado_password_encrypted?: unknown }).certificado_password_encrypted;
  if (!certPath || encPwd == null) {
    return { ok: false, status: 400, error: "Falta certificado o contraseña en configuración SIFEN." };
  }

  let p12Password: string;
  try {
    p12Password = decryptSecret(String(encPwd));
  } catch (e) {
    return { ok: false, status: 400, error: e instanceof Error ? e.message : "No se pudo descifrar la contraseña." };
  }

  const p12Dl = await downloadSifenCertificadoObject(supabase, certPath);
  if (!p12Dl.ok) {
    return { ok: false, status: 400, error: `No se pudo descargar el .p12: ${p12Dl.message}` };
  }

  const resp = await consultarDePorCdc({
    ambiente,
    cdc,
    certificadoP12: p12Dl.data,
    certificadoPassword: p12Password,
  });

  const previo = String((fe as { estado_sifen?: string }).estado_sifen ?? "");

  // Diagnóstico: guardar lo que SET contestó SIN pisar la respuesta del lote.
  const consultaLotePrevia =
    (fe as { sifen_ultima_respuesta_consulta_lote?: unknown }).sifen_ultima_respuesta_consulta_lote;
  const base =
    consultaLotePrevia && typeof consultaLotePrevia === "object" && !Array.isArray(consultaLotePrevia)
      ? (consultaLotePrevia as Record<string, unknown>)
      : {};
  const diagnostico = {
    ...base,
    consulta_de: {
      at: new Date().toISOString(),
      dCodRes: resp.dCodRes,
      dMsgRes: resp.dMsgRes,
      dEstRes: resp.dEstRes,
      dProtAut: resp.dProtAut,
      httpStatus: resp.httpStatus,
      request_soap: resp.requestSoap,
      response_soap: resp.cuerpoSoapCrudo,
    },
  };

  const setResumen = {
    dCodRes: resp.dCodRes,
    dMsgRes: resp.dMsgRes,
    dEstRes: resp.dEstRes,
    dProtAut: resp.dProtAut,
    noEncontrado: resp.noEncontrado,
    aprobado: resp.aprobado,
    rechazado: resp.rechazado,
  };

  const feId = String((fe as { id: string }).id);

  // SET confirma APROBADO (0422 = CDC encontrado). Fijar estado y limpiar
  // cualquier error stale (p. ej. un 0301 de un primer intento fallido que luego
  // sí entró) AUNQUE el ERP ya figurara "aprobado": ese error viejo es lo que
  // hacía que el panel mostrara "Rechazado" debajo de un documento aprobado.
  if (resp.aprobado) {
    const update: Record<string, unknown> = {
      estado_sifen: "aprobado",
      error: null,
      sifen_ultima_respuesta_consulta_lote: diagnostico,
    };
    if ((fe as { sifen_aprobado_at?: string | null }).sifen_aprobado_at == null) {
      update.sifen_aprobado_at = new Date().toISOString();
    }
    const { error: errUp } = await supabase
      .from("factura_electronica")
      .update(update)
      .eq("id", feId)
      .eq("empresa_id", empresaId);
    if (errUp) {
      return { ok: false, status: 500, error: `SET confirma aprobado, pero no se pudo actualizar: ${errUp.message}` };
    }
    return {
      ok: true,
      cambio: previo !== "aprobado",
      estado_sifen: "aprobado",
      estado_sifen_anterior: previo,
      set: setResumen,
    };
  }

  // SET reporta rechazo/cancelación explícito y aún no estaba así: sincronizar.
  if (resp.rechazado && previo !== "rechazado") {
    const update: Record<string, unknown> = {
      estado_sifen: "rechazado",
      sifen_ultima_respuesta_consulta_lote: diagnostico,
      error:
        resp.dMsgRes == null || String(resp.dMsgRes).trim() === ""
          ? `SET reporta el DE como ${resp.dEstRes ?? "rechazado/cancelado"}.`
          : `SET: ${String(resp.dMsgRes).trim()}`,
    };
    const { error: errUp } = await supabase
      .from("factura_electronica")
      .update(update)
      .eq("id", feId)
      .eq("empresa_id", empresaId);
    if (errUp) {
      return { ok: false, status: 500, error: `SET reporta rechazo, pero no se pudo actualizar: ${errUp.message}` };
    }
    return { ok: true, cambio: true, estado_sifen: "rechazado", estado_sifen_anterior: previo, set: setResumen };
  }

  // Sin veredicto nuevo: solo guardar diagnóstico, no tocar estado.
  await supabase
    .from("factura_electronica")
    .update({ sifen_ultima_respuesta_consulta_lote: diagnostico })
    .eq("id", feId)
    .eq("empresa_id", empresaId);
  return { ok: true, cambio: false, estado_sifen: previo, estado_sifen_anterior: previo, set: setResumen };
}
