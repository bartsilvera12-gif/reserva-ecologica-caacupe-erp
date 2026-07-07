import type { AppSupabaseClient } from "@/lib/supabase/schema";
import { NEURA_CLIENT_SCHEMA } from "@/lib/supabase/schema";
import type { SifenJobDTO, SifenJobEstado, SifenJobEtapa } from "@/lib/sifen/types";

/**
 * Repositorio de la cola SIFEN — sólo lecturas y creación.
 *
 * El worker (Fase 3) agregará `claimNextJob`, `completeJob`, `failJob`,
 * `reclaimStuckJobs`, `retryJobAsync`. Fase 2 sólo necesita:
 *   - `enqueueSifenJob`: llamado por /sifen/encolar y /sifen/reintentar.
 *   - `getLastJobForFe`: consumido por /sifen/resumen para renderizar el panel.
 *
 * El Job congela `data_schema` al momento del encolado para que el worker
 * pueda operar sin re-resolver la empresa desde JWT/cookie — que fue la
 * causa exacta del bug del pipeline-async anterior.
 */

export interface EnqueueSifenJobArgs {
  empresaId: string;
  facturaId: string;
  facturaElectronicaId: string;
  origen: "auto_venta" | "reintento_manual" | "manual_admin";
  /** Override opcional del schema del tenant; por defecto NEURA_CLIENT_SCHEMA. */
  dataSchema?: string;
}

export type EnqueueSifenJobResult =
  | { ok: true; job: SifenJobDTO; ya_habia_activo: false }
  /**
   * Ya existía un job pendiente/procesando para el mismo DE (unique parcial).
   * No es un error: el operador aprieta doble "Reintentar" o refresca la
   * página y el server responde 200 con el job existente.
   */
  | { ok: true; job: SifenJobDTO; ya_habia_activo: true }
  | { ok: false; message: string; status: number };

interface RawJobRow {
  id: string;
  empresa_id: string;
  data_schema: string;
  factura_id: string;
  factura_electronica_id: string;
  estado: string;
  etapa: string | null;
  intentos: number | string;
  max_intentos_auto: number | string;
  intentos_log: unknown;
  codigo_error_set: string | null;
  codigo_sub_error_set: string | null;
  mensaje_set: string | null;
  ultimo_error: string | null;
  tipo_error: string | null;
  respuesta_recibe_lote: unknown;
  respuesta_consulta_lote: unknown;
  cdc: string | null;
  protocolo_lote: string | null;
  tiempo_xml_ms: number | string | null;
  tiempo_firmar_ms: number | string | null;
  tiempo_enviar_ms: number | string | null;
  tiempo_consulta_ms: number | string | null;
  tiempo_total_ms: number | string | null;
  origen: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  procesando_desde: string | null;
  lock_owner: string | null;
  proximo_reintento_at: string | null;
}

function toDto(row: RawJobRow): SifenJobDTO {
  const toInt = (v: unknown): number => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? Math.floor(n) : 0;
  };
  const toIntOrNull = (v: unknown): number | null => {
    if (v == null) return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? Math.floor(n) : null;
  };
  return {
    id: row.id,
    empresa_id: row.empresa_id,
    data_schema: row.data_schema,
    factura_id: row.factura_id,
    factura_electronica_id: row.factura_electronica_id,
    estado: row.estado as SifenJobEstado,
    etapa: (row.etapa ?? null) as SifenJobEtapa | null,
    intentos: toInt(row.intentos),
    max_intentos_auto: toInt(row.max_intentos_auto),
    intentos_log: Array.isArray(row.intentos_log) ? row.intentos_log : [],
    codigo_error_set: row.codigo_error_set,
    codigo_sub_error_set: row.codigo_sub_error_set,
    mensaje_set: row.mensaje_set,
    ultimo_error: row.ultimo_error,
    tipo_error: row.tipo_error as SifenJobDTO["tipo_error"],
    respuesta_recibe_lote: (row.respuesta_recibe_lote as Record<string, unknown> | null) ?? null,
    respuesta_consulta_lote: (row.respuesta_consulta_lote as Record<string, unknown> | null) ?? null,
    cdc: row.cdc,
    protocolo_lote: row.protocolo_lote,
    tiempo_xml_ms: toIntOrNull(row.tiempo_xml_ms),
    tiempo_firmar_ms: toIntOrNull(row.tiempo_firmar_ms),
    tiempo_enviar_ms: toIntOrNull(row.tiempo_enviar_ms),
    tiempo_consulta_ms: toIntOrNull(row.tiempo_consulta_ms),
    tiempo_total_ms: toIntOrNull(row.tiempo_total_ms),
    origen: row.origen as SifenJobDTO["origen"],
    created_at: row.created_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    procesando_desde: row.procesando_desde,
    lock_owner: row.lock_owner,
    proximo_reintento_at: row.proximo_reintento_at,
  };
}

/**
 * Inserta un nuevo Job en la cola. Si ya existe uno vivo (pendiente/procesando)
 * para el mismo DE devuelve `{ ya_habia_activo: true, job }` — cubre el caso
 * de doble clic en "Reintentar" o refresh del panel que redispara auto=1.
 */
export async function enqueueSifenJob(
  supabase: AppSupabaseClient,
  args: EnqueueSifenJobArgs
): Promise<EnqueueSifenJobResult> {
  const dataSchema = (args.dataSchema ?? NEURA_CLIENT_SCHEMA).trim();
  const insertRes = await supabase
    .from("sifen_jobs")
    .insert({
      empresa_id: args.empresaId,
      data_schema: dataSchema,
      factura_id: args.facturaId,
      factura_electronica_id: args.facturaElectronicaId,
      estado: "pendiente",
      origen: args.origen,
    })
    .select("*")
    .single();

  if (insertRes.error) {
    if (insertRes.error.code === "23505") {
      const { data: activo, error: errActivo } = await supabase
        .from("sifen_jobs")
        .select("*")
        .eq("empresa_id", args.empresaId)
        .eq("factura_electronica_id", args.facturaElectronicaId)
        .in("estado", ["pendiente", "procesando"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (errActivo) {
        return { ok: false, message: errActivo.message, status: 500 };
      }
      if (!activo) {
        return {
          ok: false,
          message: "El DE ya tenía un job activo pero no se pudo leer.",
          status: 500,
        };
      }
      return { ok: true, job: toDto(activo as RawJobRow), ya_habia_activo: true };
    }
    return { ok: false, message: insertRes.error.message, status: 500 };
  }

  return {
    ok: true,
    job: toDto(insertRes.data as RawJobRow),
    ya_habia_activo: false,
  };
}

/**
 * Último Job por factura_electronica (para /sifen/resumen). Puede ser null si
 * la emisión ocurrió por el flujo sincrónico manual sin encolar.
 */
export async function getLastSifenJobForFe(
  supabase: AppSupabaseClient,
  empresaId: string,
  facturaElectronicaId: string
): Promise<SifenJobDTO | null> {
  const { data, error } = await supabase
    .from("sifen_jobs")
    .select("*")
    .eq("empresa_id", empresaId)
    .eq("factura_electronica_id", facturaElectronicaId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return toDto(data as RawJobRow);
}
