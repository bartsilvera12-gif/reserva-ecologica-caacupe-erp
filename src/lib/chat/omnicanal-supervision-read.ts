import type { AppSupabaseClient } from "@/lib/supabase/schema";

export type OmnicanalOperatorRole = "admin" | "supervisor" | "agente";

const ROLES: ReadonlySet<string> = new Set(["admin", "supervisor", "agente"]);

/**
 * PostgREST/Supabase suele devolver "schema cache" / "could not find" cuando la tabla
 * aún no está expuesta o no existe en el tenant; no siempre incluye "does not exist".
 */
function isMissingSupervisionTable(err: { message?: string; code?: string } | null): boolean {
  if (!err) return false;
  const m = (err.message ?? "").toLowerCase();
  const c = String(err.code ?? "").toLowerCase();
  const mentions =
    m.includes("chat_empresa_operator_roles") ||
    m.includes("chat_queue_supervisors") ||
    m.includes("chat_supervisor_agents");
  if (!mentions) return false;
  if (c === "pgrst205") return true; // tabla no resuelta en caché de esquema
  return (
    m.includes("does not exist") ||
    m.includes("schema cache") ||
    m.includes("could not find") ||
    m.includes("not found") ||
    m.includes("undefined_table")
  );
}

function asRole(raw: string | null | undefined): OmnicanalOperatorRole | null {
  if (!raw) return null;
  const r = raw.trim();
  return ROLES.has(r) ? (r as OmnicanalOperatorRole) : null;
}

/**
 * Rol operativo omnicanal del usuario en la empresa (tabla tenant `chat_empresa_operator_roles`).
 * Devuelve null si no hay fila o la tabla aún no existe en el schema.
 */
export async function fetchOmnicanalOperatorRole(
  supabase: AppSupabaseClient,
  empresaId: string,
  usuarioId: string
): Promise<OmnicanalOperatorRole | null> {
  const { data, error } = await supabase
    .from("chat_empresa_operator_roles")
    .select("role")
    .eq("empresa_id", empresaId)
    .eq("usuario_id", usuarioId)
    .maybeSingle();

  if (error) {
    if (isMissingSupervisionTable(error)) return null;
    console.warn("[fetchOmnicanalOperatorRole] error no fatal, se asume sin rol:", error.message);
    return null;
  }
  return asRole((data as { role?: string } | null)?.role);
}

/**
 * Usuarios (ids de catálogo) configurados como supervisores de una cola.
 */
export async function fetchQueueSupervisorUsuarioIds(
  supabase: AppSupabaseClient,
  empresaId: string,
  queueId: string
): Promise<string[]> {
  const { data, error } = await supabase
    .from("chat_queue_supervisors")
    .select("usuario_id")
    .eq("empresa_id", empresaId)
    .eq("queue_id", queueId);

  if (error) {
    if (isMissingSupervisionTable(error)) return [];
    console.warn("[fetchQueueSupervisorUsuarioIds] error no fatal:", error.message);
    return [];
  }
  const rows = (data ?? []) as { usuario_id?: string }[];
  return [...new Set(rows.map((r) => String(r.usuario_id ?? "").trim()).filter(Boolean))];
}

/**
 * Ids de colas en las que el usuario actúa como supervisor (`chat_queue_supervisors`).
 */
export async function fetchQueueIdsForSupervisorUsuario(
  supabase: AppSupabaseClient,
  empresaId: string,
  supervisorUsuarioId: string
): Promise<string[]> {
  const { data, error } = await supabase
    .from("chat_queue_supervisors")
    .select("queue_id")
    .eq("empresa_id", empresaId)
    .eq("usuario_id", supervisorUsuarioId);

  if (error) {
    if (isMissingSupervisionTable(error)) return [];
    console.warn("[fetchQueueIdsForSupervisorUsuario] error no fatal:", error.message);
    return [];
  }
  const rows = (data ?? []) as { queue_id?: string }[];
  return [...new Set(rows.map((r) => String(r.queue_id ?? "").trim()).filter(Boolean))];
}

/**
 * Agentes (`agent_usuario_id`) asignados a un supervisor en la empresa.
 */
export async function fetchAgentsForSupervisorUsuarioIds(
  supabase: AppSupabaseClient,
  empresaId: string,
  supervisorUsuarioId: string
): Promise<string[]> {
  const { data, error } = await supabase
    .from("chat_supervisor_agents")
    .select("agent_usuario_id")
    .eq("empresa_id", empresaId)
    .eq("supervisor_usuario_id", supervisorUsuarioId);

  if (error) {
    if (isMissingSupervisionTable(error)) return [];
    console.warn("[fetchAgentsForSupervisorUsuarioIds] error no fatal:", error.message);
    return [];
  }
  const rows = (data ?? []) as { agent_usuario_id?: string }[];
  return [...new Set(rows.map((r) => String(r.agent_usuario_id ?? "").trim()).filter(Boolean))];
}
