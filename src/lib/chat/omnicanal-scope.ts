import type { AppSupabaseClient } from "@/lib/supabase/schema";
import { isMissingColumnError } from "@/lib/chat/postgres-column-error";
import {
  fetchAgentsForSupervisorUsuarioIds,
  fetchOmnicanalOperatorRole,
  fetchQueueIdsForSupervisorUsuario,
  type OmnicanalOperatorRole,
} from "@/lib/chat/omnicanal-supervision-read";

export type OmnicanalScope = {
  /** Rol en `chat_empresa_operator_roles`; null si no hay fila (ver `agentUsuarioIds` para fallback operador). */
  role: OmnicanalOperatorRole | null;
  /**
   * Colas supervisadas (solo `supervisor`). Vacío en admin (acceso total) y en agente.
   */
  queueIds: string[];
  /**
   * Agentes cuyas conversaciones entran en el alcance operativo.
   * - admin: [] = sin restricción por esta dimensión
   * - supervisor: agentes a cargo
   * - agente: `[usuarioId]`
   * - sin rol pero con `chat_agents`: `[usuarioId]` como vista mínima
   */
  agentUsuarioIds: string[];
};

function normalizeId(v: string | null | undefined): string {
  return typeof v === "string" ? v.trim() : "";
}

async function usuarioTieneFilaChatAgents(
  supabase: AppSupabaseClient,
  empresaId: string,
  usuarioId: string
): Promise<boolean> {
  const { count, error } = await supabase
    .from("chat_agents")
    .select("id", { count: "exact", head: true })
    .eq("empresa_id", empresaId)
    .eq("usuario_id", usuarioId)
    .limit(1);

  if (error) {
    const m = (error.message ?? "").toLowerCase();
    const c = String((error as { code?: string }).code ?? "");
    const missingChatAgents =
      m.includes("chat_agents") &&
      (c.toLowerCase() === "pgrst205" ||
        m.includes("does not exist") ||
        m.includes("schema cache") ||
        m.includes("could not find") ||
        m.includes("not found"));
    if (missingChatAgents) return false;
    console.warn("[usuarioTieneFilaChatAgents] error no fatal, se asume sin filas:", error.message);
    return false;
  }
  return (count ?? 0) > 0;
}

/**
 * Alcance omnicanal unificado para un usuario en una empresa.
 *
 * - **admin**: `queueIds` y `agentUsuarioIds` vacíos → sin filtro por estas listas (acceso total a nivel módulo cuando se aplique).
 * - **supervisor**: colas en `chat_queue_supervisors` + agentes en `chat_supervisor_agents`.
 * - **agente**: `agentUsuarioIds = [usuarioId]`, `queueIds` vacío.
 * - **sin rol** pero con fila en `chat_agents`: `role` null, `agentUsuarioIds = [usuarioId]` (vista mínima tipo operador).
 * - **sin rol** y sin `chat_agents`: todo vacío y `role` null.
 *
 * El filtrado en consultas lo aplican los módulos (inbox, monitoreo, etc.); historial/finalizadas pueden ignorar este scope.
 */
export async function getOmnicanalScope(
  supabase: AppSupabaseClient,
  empresaId: string | null | undefined,
  usuarioId: string | null | undefined
): Promise<OmnicanalScope> {
  const emp = normalizeId(empresaId ?? undefined);
  const uid = normalizeId(usuarioId ?? undefined);
  if (!emp || !uid) {
    return { role: null, queueIds: [], agentUsuarioIds: [] };
  }

  try {
    const role = await fetchOmnicanalOperatorRole(supabase, emp, uid);

    if (role === "admin") {
      return { role: "admin", queueIds: [], agentUsuarioIds: [] };
    }

    if (role === "supervisor") {
      const [queueIds, agentUsuarioIds] = await Promise.all([
        fetchQueueIdsForSupervisorUsuario(supabase, emp, uid),
        fetchAgentsForSupervisorUsuarioIds(supabase, emp, uid),
      ]);
      return {
        role: "supervisor",
        queueIds,
        agentUsuarioIds,
      };
    }

    if (role === "agente") {
      return { role: "agente", queueIds: [], agentUsuarioIds: [uid] };
    }

    if (await usuarioTieneFilaChatAgents(supabase, emp, uid)) {
      return { role: null, queueIds: [], agentUsuarioIds: [uid] };
    }

    return { role: null, queueIds: [], agentUsuarioIds: [] };
  } catch (e) {
    console.error("[getOmnicanalScope] error; alcance mínimo tipo agente para no bloquear inbox:", e);
    return { role: null, queueIds: [], agentUsuarioIds: [uid] };
  }
}

/** Rol operativo admin omnicanal = sin restricción por listas de colas/agentes. */
export function isOmnicanalAdminScope(scope: OmnicanalScope): boolean {
  return scope.role === "admin";
}

/**
 * Admin ERP (`admin`, `administrador`, `super_admin`) sin rol operativo omnicanal:
 * no se restringe por colas/agentes (compatibilidad con quien gestiona pero no está en `chat_empresa_operator_roles`).
 */
export async function shouldBypassOmnicanalConversationScope(
  catalogSr: AppSupabaseClient,
  usuarioId: string,
  scope: OmnicanalScope
): Promise<boolean> {
  if (isOmnicanalAdminScope(scope)) return true;
  const uid = normalizeId(usuarioId);
  if (!uid) return false;
  const { data, error } = await catalogSr.from("usuarios").select("rol").eq("id", uid).maybeSingle();
  if (error || !data) return false;
  const r = String((data as { rol?: string | null }).rol ?? "")
    .trim()
    .toLowerCase();
  return r === "admin" || r === "administrador" || r === "super_admin";
}

/** Resuelve `chat_agents.id` para los `usuario_id` indicados (misma empresa). */
export async function resolveChatAgentIdsForUsuarios(
  supabase: AppSupabaseClient,
  empresaId: string,
  usuarioIds: string[]
): Promise<string[]> {
  const ids = [...new Set(usuarioIds.map((x) => normalizeId(x)).filter(Boolean))];
  if (ids.length === 0) return [];
  let { data, error } = await supabase
    .from("chat_agents")
    .select("id")
    .eq("empresa_id", empresaId)
    .in("usuario_id", ids)
    .eq("is_active", true);
  if (error && isMissingColumnError(error.message, "is_active")) {
    ({ data, error } = await supabase
      .from("chat_agents")
      .select("id")
      .eq("empresa_id", empresaId)
      .in("usuario_id", ids));
  }
  if (error) {
    console.warn("[resolveChatAgentIdsForUsuarios] error no fatal:", error.message);
    return [];
  }
  return [...new Set((data ?? []).map((r) => String((r as { id?: string }).id ?? "").trim()).filter(Boolean))];
}

/** Colas (`chat_queues.id`) en las que participan los usuarios agentes dados. */
export async function resolveQueueIdsForUsuarios(
  supabase: AppSupabaseClient,
  empresaId: string,
  usuarioIds: string[]
): Promise<string[]> {
  const ids = [...new Set(usuarioIds.map((x) => normalizeId(x)).filter(Boolean))];
  if (ids.length === 0) return [];
  let { data, error } = await supabase
    .from("chat_agents")
    .select("queue_id")
    .eq("empresa_id", empresaId)
    .in("usuario_id", ids)
    .eq("is_active", true);
  if (error && isMissingColumnError(error.message, "is_active")) {
    ({ data, error } = await supabase
      .from("chat_agents")
      .select("queue_id")
      .eq("empresa_id", empresaId)
      .in("usuario_id", ids));
  }
  if (error) {
    console.warn("[resolveQueueIdsForUsuarios] error no fatal:", error.message);
    return [];
  }
  return [...new Set((data ?? []).map((r) => String((r as { queue_id?: string }).queue_id ?? "").trim()).filter(Boolean))];
}

const NO_CONVERSATION_MATCH = "00000000-0000-0000-0000-000000000001";

/**
 * Restringe un query builder de `chat_conversations` al alcance omnicanal.
 * No aplicar si `shouldBypassOmnicanalConversationScope` es true.
 * Admin operativo (`role === admin`) no debe llamar esta función (no-op si se llama).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function appendOmnicanalConversationScopeToQuery(
  supabase: AppSupabaseClient,
  empresaId: string,
  scope: OmnicanalScope,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  q: any
): Promise<any> {
  if (isOmnicanalAdminScope(scope)) return q;

  const agentFkIds = await resolveChatAgentIdsForUsuarios(supabase, empresaId, scope.agentUsuarioIds);
  const queueIds = scope.queueIds ?? [];

  if (queueIds.length === 0 && agentFkIds.length === 0) {
    return q.eq("id", NO_CONVERSATION_MATCH);
  }
  if (queueIds.length > 0 && agentFkIds.length > 0) {
    const qIn = queueIds.map((id) => `"${normalizeId(id)}"`).join(",");
    const aIn = agentFkIds.map((id) => `"${normalizeId(id)}"`).join(",");
    return q.or(`queue_id.in.(${qIn}),assigned_agent_id.in.(${aIn})`);
  }
  if (queueIds.length > 0) {
    return q.in("queue_id", queueIds);
  }
  if (agentFkIds.length === 0) {
    return q.eq("id", NO_CONVERSATION_MATCH);
  }
  return q.in("assigned_agent_id", agentFkIds);
}

/** Filtra ids de conversación que caen dentro del alcance (misma lógica que el append). */
export async function filterConversationIdsByOmnicanalScope(
  supabase: AppSupabaseClient,
  catalogSr: AppSupabaseClient,
  empresaId: string,
  usuarioId: string,
  conversationIds: string[]
): Promise<Set<string>> {
  const ids = [...new Set(conversationIds.map((x) => normalizeId(x)).filter(Boolean))];
  if (ids.length === 0) return new Set();

  const scope = await getOmnicanalScope(supabase, empresaId, usuarioId);
  if (await shouldBypassOmnicanalConversationScope(catalogSr, usuarioId, scope)) {
    return new Set(ids);
  }

  try {
    let q = supabase.from("chat_conversations").select("id").eq("empresa_id", empresaId).in("id", ids);
    q = await appendOmnicanalConversationScopeToQuery(supabase, empresaId, scope, q);
    const { data, error } = await q;
    if (error) {
      console.warn("[filterConversationIdsByOmnicanalScope] error; fail-open lectura:", error.message);
      return new Set(ids);
    }
    return new Set((data ?? []).map((r) => String((r as { id?: string }).id ?? "").trim()).filter(Boolean));
  } catch (e) {
    console.error("[filterConversationIdsByOmnicanalScope] excepción; fail-open:", e);
    return new Set(ids);
  }
}
