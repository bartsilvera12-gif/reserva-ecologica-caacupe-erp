"use server";

import { requireEmpresaTenantServiceRole } from "@/lib/chat/empresa-tenant-service-role";
import {
  appendOmnicanalConversationScopeToQuery,
  filterConversationIdsByOmnicanalScope,
  getOmnicanalScope,
  resolveQueueIdsForUsuarios,
  shouldBypassOmnicanalConversationScope,
} from "@/lib/chat/omnicanal-scope";
import { insertChatRoutingEvent, updateContactLastRouted } from "@/lib/chat/routing-audit";
import { isMissingColumnError } from "@/lib/chat/postgres-column-error";
import type { AppSupabaseClient } from "@/lib/supabase/schema";

/** Fila imposible para forzar 0 resultados en consultas `in`/count cuando el alcance no admite filas. */
const OMNICANAL_NO_MATCH_UUID = "00000000-0000-0000-0000-000000000001";

const STATUSES = new Set(["open", "pending", "closed"]);
const PRIORITIES = new Set(["low", "medium", "high"]);

async function loadConversationForEmpresa(
  supabase: AppSupabaseClient,
  empresaId: string,
  conversationId: string
) {
  const { data, error } = await supabase
    .from("chat_conversations")
    .select("id, empresa_id, queue_id, assigned_agent_id, status, contact_id, channel_id")
    .eq("id", conversationId.trim())
    .eq("empresa_id", empresaId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as {
    id: string;
    empresa_id: string;
    queue_id: string | null;
    assigned_agent_id: string | null;
    status: string;
    contact_id: string | null;
    channel_id: string | null;
  } | null;
}

async function loadAgentForEmpresa(
  supabase: AppSupabaseClient,
  empresaId: string,
  agentId: string
) {
  const { data, error } = await supabase
    .from("chat_agents")
    .select("id, empresa_id, queue_id, usuario_id")
    .eq("id", agentId.trim())
    .eq("empresa_id", empresaId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as {
    id: string;
    empresa_id: string;
    queue_id: string;
    usuario_id: string;
  } | null;
}

async function loadQueueForEmpresa(
  supabase: AppSupabaseClient,
  empresaId: string,
  queueId: string
) {
  const { data, error } = await supabase
    .from("chat_queues")
    .select("id, empresa_id")
    .eq("id", queueId.trim())
    .eq("empresa_id", empresaId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as { id: string; empresa_id: string } | null;
}

/**
 * Asigna conversación a un agente (`chat_agents.id`). Alinea `queue_id` con la cola del agente.
 */
export async function assignConversationToAgent(
  conversationId: string,
  agentId: string
): Promise<void> {
  const { supabase, empresa_id } = await requireEmpresaTenantServiceRole();
  const conv = await loadConversationForEmpresa(supabase, empresa_id, conversationId);
  if (!conv) throw new Error("Conversación no encontrada");
  const agent = await loadAgentForEmpresa(supabase, empresa_id, agentId);
  if (!agent) throw new Error("Agente no encontrado");

  const ts = new Date().toISOString();
  const { error } = await supabase
    .from("chat_conversations")
    .update({
      assigned_agent_id: agent.id,
      queue_id: agent.queue_id,
      initial_assignment_at: ts,
      first_human_response_at: null,
      initial_reassign_count: 0,
      assignment_wait_code: null,
      updated_at: ts,
    })
    .eq("id", conv.id)
    .eq("empresa_id", empresa_id);

  if (error) throw new Error(error.message);

  const cid = (conv.contact_id as string | null)?.trim();
  const chid = (conv.channel_id as string | null)?.trim();
  if (cid && chid) {
    await updateContactLastRouted(supabase, {
      empresa_id: empresa_id,
      contact_id: cid,
      channel_id: chid,
      chat_agent_id: agent.id,
      at_iso: ts,
    });
  }
  await insertChatRoutingEvent(supabase, {
    empresa_id: empresa_id,
    conversation_id: conv.id,
    queue_id: agent.queue_id,
    event_type: "supervisor_assigned",
    payload: { to_agent_id: agent.id, source: "assignConversationToAgent" },
  });
}

/**
 * Cola de la conversación (no limpia asignación; el supervisor puede reasignar después).
 */
export async function changeConversationQueue(conversationId: string, queueId: string): Promise<void> {
  const { supabase, empresa_id } = await requireEmpresaTenantServiceRole();
  const conv = await loadConversationForEmpresa(supabase, empresa_id, conversationId);
  if (!conv) throw new Error("Conversación no encontrada");
  const queue = await loadQueueForEmpresa(supabase, empresa_id, queueId);
  if (!queue) throw new Error("Cola no encontrada");

  const { error } = await supabase
    .from("chat_conversations")
    .update({
      queue_id: queue.id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", conv.id)
    .eq("empresa_id", empresa_id);

  if (error) throw new Error(error.message);
}

export async function changeConversationPriority(
  conversationId: string,
  priority: string
): Promise<void> {
  const p = priority.trim().toLowerCase();
  if (!PRIORITIES.has(p)) {
    throw new Error("Prioridad inválida");
  }
  const { supabase, empresa_id } = await requireEmpresaTenantServiceRole();
  const conv = await loadConversationForEmpresa(supabase, empresa_id, conversationId);
  if (!conv) throw new Error("Conversación no encontrada");

  const { error } = await supabase
    .from("chat_conversations")
    .update({
      priority: p,
      updated_at: new Date().toISOString(),
    })
    .eq("id", conv.id)
    .eq("empresa_id", empresa_id);

  if (error) throw new Error(error.message);
}

export async function changeConversationStatus(conversationId: string, status: string): Promise<void> {
  const s = status.trim().toLowerCase();
  if (!STATUSES.has(s)) {
    throw new Error("Estado inválido");
  }
  const { supabase, empresa_id } = await requireEmpresaTenantServiceRole();
  const conv = await loadConversationForEmpresa(supabase, empresa_id, conversationId);
  if (!conv) throw new Error("Conversación no encontrada");

  const { error } = await supabase
    .from("chat_conversations")
    .update({
      status: s,
      updated_at: new Date().toISOString(),
    })
    .eq("id", conv.id)
    .eq("empresa_id", empresa_id);

  if (error) throw new Error(error.message);
}

/**
 * Asigna al usuario actual si existe `chat_agents` para la cola de la conversación (o cualquier cola de la empresa si la conversación no tiene cola).
 */
export async function assignConversationToMe(conversationId: string): Promise<void> {
  const { supabase, empresa_id, usuario_id } = await requireEmpresaTenantServiceRole();
  const conv = await loadConversationForEmpresa(supabase, empresa_id, conversationId);
  if (!conv) throw new Error("Conversación no encontrada");

  let q = supabase
    .from("chat_agents")
    .select("id, queue_id")
    .eq("empresa_id", empresa_id)
    .eq("usuario_id", usuario_id)
    .eq("is_active", true);

  if (conv.queue_id) {
    q = q.eq("queue_id", conv.queue_id);
  }

  const { data: agent, error: aErr } = await q.limit(1).maybeSingle();
  if (aErr) throw new Error(aErr.message);
  if (!agent?.id) {
    throw new Error(
      conv.queue_id
        ? "No tenés perfil de agente en la cola de esta conversación. Pedí acceso al supervisor."
        : "No tenés perfil de agente en ninguna cola de la empresa."
    );
  }

  const ts = new Date().toISOString();
  const { error } = await supabase
    .from("chat_conversations")
    .update({
      assigned_agent_id: agent.id,
      queue_id: agent.queue_id,
      initial_assignment_at: ts,
      first_human_response_at: null,
      initial_reassign_count: 0,
      assignment_wait_code: null,
      updated_at: ts,
    })
    .eq("id", conv.id)
    .eq("empresa_id", empresa_id);

  if (error) throw new Error(error.message);

  const cid = (conv.contact_id as string | null)?.trim();
  const chid = (conv.channel_id as string | null)?.trim();
  if (cid && chid) {
    await updateContactLastRouted(supabase, {
      empresa_id: empresa_id,
      contact_id: cid,
      channel_id: chid,
      chat_agent_id: agent.id as string,
      at_iso: ts,
    });
  }
  await insertChatRoutingEvent(supabase, {
    empresa_id: empresa_id,
    conversation_id: conv.id,
    queue_id: agent.queue_id as string,
    event_type: "supervisor_assigned",
    payload: { to_agent_id: agent.id, source: "assignConversationToMe" },
  });
}

export type ChatQueueListRow = {
  id: string;
  nombre: string;
  is_active: boolean;
  channel_type: string | null;
  descripcion?: string | null;
  distribution_strategy?: string;
  priority?: number;
};

export async function listChatQueues(): Promise<ChatQueueListRow[]> {
  const { supabase, catalogSr, empresa_id, usuario_id } = await requireEmpresaTenantServiceRole();
  const scope = await getOmnicanalScope(supabase, empresa_id, usuario_id);
  const bypass = await shouldBypassOmnicanalConversationScope(catalogSr, usuario_id, scope);

  let q = supabase
    .from("chat_queues")
    .select("id, nombre, is_active, channel_type, descripcion, distribution_strategy, priority")
    .eq("empresa_id", empresa_id)
    .order("priority", { ascending: false })
    .order("nombre", { ascending: true });

  if (!bypass) {
    if (scope.role === "supervisor") {
      const extra = await resolveQueueIdsForUsuarios(supabase, empresa_id, scope.agentUsuarioIds);
      const union = [...new Set([...scope.queueIds, ...extra])];
      if (union.length > 0) {
        q = q.in("id", union);
      } else {
        return [];
      }
    } else if (scope.agentUsuarioIds.length > 0) {
      const qids = await resolveQueueIdsForUsuarios(supabase, empresa_id, scope.agentUsuarioIds);
      if (qids.length === 0) return [];
      q = q.in("id", qids);
    } else {
      return [];
    }
  }

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as ChatQueueListRow[];
}

export type MonitoringReassignmentRow = {
  id: string;
  created_at: string;
  conversation_id: string;
  queue_id: string | null;
  payload: Record<string, unknown>;
};

export type MonitoringDashboard = {
  active_queues: number;
  agents_assigned: number;
  unassigned_chats: number;
  pending_chats: number;
  active_channels: number;
  /** Asignados a humano pero sin primera respuesta saliente humana registrada. */
  awaiting_first_response: number;
  /** Últimas reasignaciones por SLA de primera respuesta. */
  recent_initial_reassignments: MonitoringReassignmentRow[];
  /** Chats abiertos/pendientes sin agente (orden por última actividad). */
  unassigned_recent: MonitoringUnassignedRow[];
};

export type MonitoringUnassignedRow = {
  id: string;
  status: string;
  last_message_at: string | null;
  created_at: string;
  queue_id: string | null;
  queue_name: string | null;
  assignment_wait_code: string | null;
  channel_id: string | null;
  channel_type: string | null;
  channel_nombre: string | null;
  contact_phone: string | null;
  contact_name: string | null;
  /** ISO8601 del primer mensaje o creación para SLA en Etapa 2. */
  waiting_since: string;
};

export async function fetchMonitoringDashboard(): Promise<MonitoringDashboard> {
  const { supabase, catalogSr, empresa_id, usuario_id } = await requireEmpresaTenantServiceRole();
  const scope = await getOmnicanalScope(supabase, empresa_id, usuario_id);
  const bypass = await shouldBypassOmnicanalConversationScope(catalogSr, usuario_id, scope);

  let queuesCountQ = supabase
    .from("chat_queues")
    .select("id", { count: "exact", head: true })
    .eq("empresa_id", empresa_id)
    .eq("is_active", true);
  if (!bypass) {
    if (scope.role === "supervisor") {
      const extra = await resolveQueueIdsForUsuarios(supabase, empresa_id, scope.agentUsuarioIds);
      const union = [...new Set([...scope.queueIds, ...extra])];
      if (union.length > 0) {
        queuesCountQ = queuesCountQ.in("id", union);
      } else {
        queuesCountQ = queuesCountQ.eq("id", OMNICANAL_NO_MATCH_UUID);
      }
    } else if (scope.agentUsuarioIds.length > 0) {
      const qids = await resolveQueueIdsForUsuarios(supabase, empresa_id, scope.agentUsuarioIds);
      if (qids.length > 0) {
        queuesCountQ = queuesCountQ.in("id", qids);
      } else {
        queuesCountQ = queuesCountQ.eq("id", OMNICANAL_NO_MATCH_UUID);
      }
    } else {
      queuesCountQ = queuesCountQ.eq("id", OMNICANAL_NO_MATCH_UUID);
    }
  }

  let agentsCountQ = supabase
    .from("chat_agents")
    .select("usuario_id")
    .eq("empresa_id", empresa_id)
    .eq("is_active", true);
  if (!bypass) {
    if (scope.agentUsuarioIds.length > 0) {
      agentsCountQ = agentsCountQ.in("usuario_id", scope.agentUsuarioIds);
    } else {
      agentsCountQ = agentsCountQ.eq("id", OMNICANAL_NO_MATCH_UUID);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scopedConv = async (q: any): Promise<any> => {
    if (bypass) return q;
    return appendOmnicanalConversationScopeToQuery(supabase, empresa_id, scope, q);
  };

  const [queuesRes, agentsRes] = await Promise.all([queuesCountQ, agentsCountQ]);

  const [unassignedRes, pendingRes, channelsRes, recentRes, awaitingFirstRes, reassignRes] = await Promise.all([
    (async () => {
      let q = supabase
        .from("chat_conversations")
        .select("*", { count: "exact", head: true })
        .eq("empresa_id", empresa_id)
        .is("assigned_agent_id", null)
        .in("status", ["open", "pending"]);
      q = await scopedConv(q);
      return await q;
    })(),
    (async () => {
      let q = supabase
        .from("chat_conversations")
        .select("*", { count: "exact", head: true })
        .eq("empresa_id", empresa_id)
        .eq("status", "pending");
      q = await scopedConv(q);
      return await q;
    })(),
    supabase
      .from("chat_channels")
      .select("*", { count: "exact", head: true })
      .eq("empresa_id", empresa_id)
      .eq("activo", true)
      .eq("config_status", "active"),
    (async () => {
      const colsFull =
        "id, status, last_message_at, created_at, queue_id, channel_id, contact_id, assigned_agent_id, assignment_wait_code";
      const colsLegacy =
        "id, status, last_message_at, created_at, queue_id, channel_id, contact_id, assigned_agent_id";
      let q = supabase
        .from("chat_conversations")
        .select(colsFull)
        .eq("empresa_id", empresa_id)
        .is("assigned_agent_id", null)
        .in("status", ["open", "pending"])
        .order("last_message_at", { ascending: false, nullsFirst: false })
        .limit(30);
      q = await scopedConv(q);
      let r: any = await q;
      if (r.error && isMissingColumnError(r.error.message, "assignment_wait_code")) {
        let q2 = supabase
          .from("chat_conversations")
          .select(colsLegacy)
          .eq("empresa_id", empresa_id)
          .is("assigned_agent_id", null)
          .in("status", ["open", "pending"])
          .order("last_message_at", { ascending: false, nullsFirst: false })
          .limit(30);
        q2 = await scopedConv(q2);
        r = await q2;
      }
      return r;
    })(),
    (async () => {
      let q = supabase
        .from("chat_conversations")
        .select("*", { count: "exact", head: true })
        .eq("empresa_id", empresa_id)
        .not("assigned_agent_id", "is", null)
        .is("first_human_response_at", null)
        .in("status", ["open", "pending"]);
      q = await scopedConv(q);
      return await q;
    })(),
    supabase
      .from("chat_routing_events")
      .select("id, created_at, conversation_id, queue_id, payload")
      .eq("empresa_id", empresa_id)
      .eq("event_type", "reassigned_initial_timeout")
      .order("created_at", { ascending: false })
      .limit(12),
  ]);

  if (queuesRes.error) throw new Error(queuesRes.error.message);
  if (agentsRes.error) throw new Error(agentsRes.error.message);
  if (unassignedRes.error) throw new Error(unassignedRes.error.message);
  if (pendingRes.error) throw new Error(pendingRes.error.message);
  if (channelsRes.error) throw new Error(channelsRes.error.message);
  if (recentRes.error) throw new Error(recentRes.error.message);
  if (awaitingFirstRes.error) throw new Error(awaitingFirstRes.error.message);

  const agentRows = agentsRes.data ?? [];
  const distinctUsers = new Set(agentRows.map((r) => r.usuario_id as string).filter(Boolean));

  let convList = (recentRes.data ?? []) as Record<string, unknown>[];
  const queueIds = [
    ...new Set(convList.map((c: Record<string, unknown>) => (c.queue_id as string | null)?.trim()).filter(Boolean)),
  ] as string[];
  const channelIds = [
    ...new Set(convList.map((c: Record<string, unknown>) => (c.channel_id as string | null)?.trim()).filter(Boolean)),
  ] as string[];
  const contactIds = [
    ...new Set(convList.map((c: Record<string, unknown>) => (c.contact_id as string | null)?.trim()).filter(Boolean)),
  ] as string[];

  let queueNombreById: Record<string, string> = {};
  if (queueIds.length > 0) {
    const { data: qrows, error: qErr } = await supabase
      .from("chat_queues")
      .select("id, nombre")
      .eq("empresa_id", empresa_id)
      .in("id", queueIds);
    if (qErr) throw new Error(qErr.message);
    queueNombreById = Object.fromEntries(
      (qrows ?? []).map((r) => [r.id as string, String((r as { nombre?: string }).nombre ?? "").trim() || "Cola"])
    );
  }

  let channelMetaById: Record<string, { type: string; nombre: string | null }> = {};
  if (channelIds.length > 0) {
    const { data: chrows, error: chErr } = await supabase
      .from("chat_channels")
      .select("id, type, nombre")
      .eq("empresa_id", empresa_id)
      .in("id", channelIds);
    if (chErr) throw new Error(chErr.message);
    channelMetaById = Object.fromEntries(
      (chrows ?? []).map((r) => [
        r.id as string,
        {
          type: ((r as { type?: string }).type as string) ?? "whatsapp",
          nombre: (r as { nombre?: string | null }).nombre ?? null,
        },
      ])
    );
  }

  let contactById: Record<string, { phone_number: string | null; name: string | null }> = {};
  if (contactIds.length > 0) {
    const { data: crows, error: cErr } = await supabase
      .from("chat_contacts")
      .select("id, phone_number, name")
      .eq("empresa_id", empresa_id)
      .in("id", contactIds);
    if (cErr) throw new Error(cErr.message);
    contactById = Object.fromEntries(
      (crows ?? []).map((r) => [
        r.id as string,
        {
          phone_number: (r as { phone_number?: string | null }).phone_number ?? null,
          name: (r as { name?: string | null }).name ?? null,
        },
      ])
    );
  }

  let recent_initial_reassignments: MonitoringReassignmentRow[] = [];
  if (!reassignRes.error && reassignRes.data) {
    const rawRows = reassignRes.data as Record<string, unknown>[];
    const convIds = rawRows.map((r) => String(r.conversation_id ?? "").trim()).filter(Boolean);
    const visible = await filterConversationIdsByOmnicanalScope(
      supabase,
      catalogSr,
      empresa_id,
      usuario_id,
      convIds
    );
    recent_initial_reassignments = rawRows
      .filter((r) => visible.has(String(r.conversation_id ?? "").trim()))
      .map((r) => ({
        id: r.id as string,
        created_at: (r.created_at as string) ?? "",
        conversation_id: r.conversation_id as string,
        queue_id: (r.queue_id as string | null) ?? null,
        payload: (typeof r.payload === "object" && r.payload !== null ? r.payload : {}) as Record<string, unknown>,
      }));
  }

  const unassigned_recent: MonitoringUnassignedRow[] = convList.map((row: Record<string, unknown>) => {
    const qid = (row.queue_id as string | null)?.trim() || null;
    const cid = (row.channel_id as string | null)?.trim() || null;
    const ctid = (row.contact_id as string | null)?.trim() || null;
    const rawWait = (row as { assignment_wait_code?: string | null }).assignment_wait_code;
    const assignment_wait_code =
      typeof rawWait === "string" && rawWait.trim() ? rawWait.trim() : null;
    const ch = cid ? channelMetaById[cid] : undefined;
    const contact = ctid ? contactById[ctid] : undefined;
    const created = (row.created_at as string) ?? new Date().toISOString();
    const last = (row.last_message_at as string | null) ?? null;
    const waiting_since = last ?? created;
    return {
      id: row.id as string,
      status: (row.status as string) ?? "open",
      last_message_at: last,
      created_at: created,
      queue_id: qid,
      queue_name: qid ? queueNombreById[qid] ?? null : null,
      assignment_wait_code,
      channel_id: cid,
      channel_type: ch?.type ?? null,
      channel_nombre: ch?.nombre ?? null,
      contact_phone: contact?.phone_number ?? null,
      contact_name: contact?.name ?? null,
      waiting_since,
    };
  });

  return {
    active_queues: queuesRes.count ?? 0,
    agents_assigned: distinctUsers.size,
    unassigned_chats: unassignedRes.count ?? 0,
    pending_chats: pendingRes.count ?? 0,
    active_channels: channelsRes.count ?? 0,
    awaiting_first_response: awaitingFirstRes.count ?? 0,
    recent_initial_reassignments,
    unassigned_recent,
  };
}

export type ChatAgentDirectoryRow = {
  id: string;
  queue_id: string;
  queue_nombre: string;
  usuario_id: string;
  nombre: string;
  email: string;
  is_online: boolean;
  /** ready | offline — autoasignación solo en ready. */
  operational_status: string;
  max_conversations: number;
};

/** Agentes con nombre para reasignación y vistas de supervisor. */
export async function listChatAgentsDirectory(): Promise<ChatAgentDirectoryRow[]> {
  const { supabase, catalogSr, empresa_id, usuario_id } = await requireEmpresaTenantServiceRole();
  const scope = await getOmnicanalScope(supabase, empresa_id, usuario_id);
  const bypass = await shouldBypassOmnicanalConversationScope(catalogSr, usuario_id, scope);

  let aq = supabase
    .from("chat_agents")
    .select("id, queue_id, is_online, operational_status, max_conversations, usuario_id")
    .eq("empresa_id", empresa_id)
    .eq("is_active", true)
    .order("queue_id", { ascending: true });

  if (!bypass) {
    if (scope.agentUsuarioIds.length > 0) {
      aq = aq.in("usuario_id", scope.agentUsuarioIds);
    } else {
      aq = aq.eq("id", OMNICANAL_NO_MATCH_UUID);
    }
  }

  let { data, error } = await aq;

  if (error && isMissingColumnError(error.message, "operational_status")) {
    let aq2 = supabase
      .from("chat_agents")
      .select("id, queue_id, is_online, max_conversations, usuario_id")
      .eq("empresa_id", empresa_id)
      .eq("is_active", true)
      .order("queue_id", { ascending: true });
    if (!bypass) {
      if (scope.agentUsuarioIds.length > 0) {
        aq2 = aq2.in("usuario_id", scope.agentUsuarioIds);
      } else {
        aq2 = aq2.eq("id", OMNICANAL_NO_MATCH_UUID);
      }
    }
    const second = await aq2;
    data = second.data as typeof data;
    error = second.error;
  }

  if (error) throw new Error(error.message);

  const rows = (data ?? []) as Record<string, unknown>[];
  const queueIds = [...new Set(rows.map((row) => row.queue_id as string).filter(Boolean))];
  let queueNombreById: Record<string, string> = {};
  if (queueIds.length > 0) {
    const { data: qrows, error: qErr } = await supabase
      .from("chat_queues")
      .select("id, nombre")
      .eq("empresa_id", empresa_id)
      .in("id", queueIds);
    if (qErr) throw new Error(qErr.message);
    queueNombreById = Object.fromEntries(
      (qrows ?? []).map((r) => [
        r.id as string,
        String((r as { nombre?: string | null }).nombre ?? "").trim() || "Cola",
      ])
    );
  }

  const uids = [...new Set(rows.map((row) => row.usuario_id as string).filter(Boolean))];
  let usuarioById: Record<string, { nombre: string | null; email: string | null }> = {};
  if (uids.length > 0) {
    const { data: urows, error: uErr } = await catalogSr
      .from("usuarios")
      .select("id, nombre, email")
      .in("id", uids);
    if (uErr) throw new Error(uErr.message);
    usuarioById = Object.fromEntries(
      (urows ?? []).map((u) => [
        u.id as string,
        {
          nombre: (u as { nombre?: string | null }).nombre ?? null,
          email: (u as { email?: string | null }).email ?? null,
        },
      ])
    );
  }

  return rows.map((row) => {
    const qid = row.queue_id as string;
    const queueNombre = queueNombreById[qid] ?? "Cola";
    const uid = row.usuario_id as string;
    const u = usuarioById[uid];
    const nombre = (u?.nombre?.trim() || u?.email?.trim() || "—") as string;
    return {
      id: row.id as string,
      queue_id: qid,
      queue_nombre: queueNombre,
      usuario_id: uid,
      nombre,
      email: (u?.email as string) ?? "",
      is_online: Boolean(row.is_online),
      operational_status:
        (row.operational_status as string | undefined)?.trim() === "offline" ? "offline" : "ready",
      max_conversations: (row.max_conversations as number) ?? 5,
    };
  });
}

export type SupervisorAgentLoadRow = ChatAgentDirectoryRow & {
  active_conversations: number;
  /** Chats asignados sin primera respuesta humana saliente aún. */
  pending_first_reply: number;
};

export async function fetchSupervisorAgentLoads(): Promise<SupervisorAgentLoadRow[]> {
  const { supabase, catalogSr, empresa_id, usuario_id } = await requireEmpresaTenantServiceRole();
  const agents = await listChatAgentsDirectory();
  if (agents.length === 0) return [];

  const agentIds = agents.map((a) => a.id);
  const scope = await getOmnicanalScope(supabase, empresa_id, usuario_id);
  const bypass = await shouldBypassOmnicanalConversationScope(catalogSr, usuario_id, scope);

  let cq = supabase
    .from("chat_conversations")
    .select("assigned_agent_id, first_human_response_at, status")
    .eq("empresa_id", empresa_id)
    .in("assigned_agent_id", agentIds)
    .neq("status", "closed");

  if (!bypass) {
    cq = await appendOmnicanalConversationScopeToQuery(supabase, empresa_id, scope, cq);
  }

  const { data: counts, error } = await cq;

  if (error) throw new Error(error.message);

  const tally = new Map<string, number>();
  const pendingFirst = new Map<string, number>();
  for (const row of counts ?? []) {
    const aid = row.assigned_agent_id as string | null;
    if (!aid) continue;
    tally.set(aid, (tally.get(aid) ?? 0) + 1);
    const st = (row as { status?: string }).status;
    const fh = (row as { first_human_response_at?: string | null }).first_human_response_at;
    if ((st === "open" || st === "pending") && (fh == null || fh === "")) {
      pendingFirst.set(aid, (pendingFirst.get(aid) ?? 0) + 1);
    }
  }

  return agents.map((a) => ({
    ...a,
    active_conversations: tally.get(a.id) ?? 0,
    pending_first_reply: pendingFirst.get(a.id) ?? 0,
  }));
}

export async function countUnassignedOpenConversations(): Promise<number> {
  const { supabase, catalogSr, empresa_id, usuario_id } = await requireEmpresaTenantServiceRole();
  const scope = await getOmnicanalScope(supabase, empresa_id, usuario_id);
  const bypass = await shouldBypassOmnicanalConversationScope(catalogSr, usuario_id, scope);

  let q = supabase
    .from("chat_conversations")
    .select("*", { count: "exact", head: true })
    .eq("empresa_id", empresa_id)
    .is("assigned_agent_id", null)
    .in("status", ["open", "pending"]);

  if (!bypass) {
    q = await appendOmnicanalConversationScopeToQuery(supabase, empresa_id, scope, q);
  }

  const { count, error } = await q;

  if (error) throw new Error(error.message);
  return count ?? 0;
}

export type ChatAgentOperationalStatus = "ready" | "offline";

/**
 * Presencia omnicanal del usuario logueado en todas sus filas `chat_agents`.
 * Si no participa en ninguna cola, `in_queues: false`.
 */
export async function getMyAgentOperationalPresence(): Promise<
  { in_queues: false } | { in_queues: true; status: ChatAgentOperationalStatus }
> {
  const { supabase, empresa_id, usuario_id } = await requireEmpresaTenantServiceRole();
  let { data, error } = await supabase
    .from("chat_agents")
    .select("operational_status")
    .eq("empresa_id", empresa_id)
    .eq("usuario_id", usuario_id);
  if (error && isMissingColumnError(error.message, "operational_status")) {
    const legacy = await supabase
      .from("chat_agents")
      .select("id")
      .eq("empresa_id", empresa_id)
      .eq("usuario_id", usuario_id);
    data = legacy.data as typeof data;
    error = legacy.error;
    if (error) {
      console.warn("[getMyAgentOperationalPresence] legado chat_agents:", error.message);
      return { in_queues: false };
    }
    const rowsLegacy = data ?? [];
    if (rowsLegacy.length === 0) return { in_queues: false };
    return { in_queues: true, status: "ready" };
  }
  if (error) {
    console.warn("[getMyAgentOperationalPresence] error no fatal:", error.message);
    return { in_queues: false };
  }
  const rows = (data ?? []) as { operational_status?: string | null }[];
  if (rows.length === 0) return { in_queues: false };
  const anyOffline = rows.some((r) => r.operational_status === "offline");
  return { in_queues: true, status: anyOffline ? "offline" : "ready" };
}

/** Sincroniza el estado operativo en todas las colas donde el usuario es agente. */
export async function setMyAgentOperationalPresence(status: ChatAgentOperationalStatus): Promise<void> {
  if (status !== "ready" && status !== "offline") {
    throw new Error("Estado operativo inválido");
  }
  const { supabase, empresa_id, usuario_id } = await requireEmpresaTenantServiceRole();
  const { error } = await supabase
    .from("chat_agents")
    .update({ operational_status: status, updated_at: new Date().toISOString() })
    .eq("empresa_id", empresa_id)
    .eq("usuario_id", usuario_id);
  if (error && isMissingColumnError(error.message, "operational_status")) {
    console.warn(
      "[setMyAgentOperationalPresence] columna operational_status ausente en schema tenant; update omitido (UI sin error)."
    );
    return;
  }
  if (error) {
    console.warn("[setMyAgentOperationalPresence] update no aplicado:", error.message);
    return;
  }
}
