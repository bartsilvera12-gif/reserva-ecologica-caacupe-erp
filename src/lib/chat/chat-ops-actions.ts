"use server";

import { requireEmpresaTenantServiceRole } from "@/lib/chat/empresa-tenant-service-role";
import type { AppSupabaseClient } from "@/lib/supabase/schema";

const STATUSES = new Set(["open", "pending", "closed"]);
const PRIORITIES = new Set(["low", "medium", "high"]);

async function loadConversationForEmpresa(
  supabase: AppSupabaseClient,
  empresaId: string,
  conversationId: string
) {
  const { data, error } = await supabase
    .from("chat_conversations")
    .select("id, empresa_id, queue_id, assigned_agent_id, status")
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

  const { error } = await supabase
    .from("chat_conversations")
    .update({
      assigned_agent_id: agent.id,
      queue_id: agent.queue_id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", conv.id)
    .eq("empresa_id", empresa_id);

  if (error) throw new Error(error.message);
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
    .eq("usuario_id", usuario_id);

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

  const { error } = await supabase
    .from("chat_conversations")
    .update({
      assigned_agent_id: agent.id,
      queue_id: agent.queue_id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", conv.id)
    .eq("empresa_id", empresa_id);

  if (error) throw new Error(error.message);
}

export type ChatQueueListRow = {
  id: string;
  nombre: string;
  is_active: boolean;
  channel_type: string | null;
};

export async function listChatQueues(): Promise<ChatQueueListRow[]> {
  const { supabase, empresa_id } = await requireEmpresaTenantServiceRole();
  const { data, error } = await supabase
    .from("chat_queues")
    .select("id, nombre, is_active, channel_type")
    .eq("empresa_id", empresa_id)
    .order("nombre", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as ChatQueueListRow[];
}

export type ChatAgentDirectoryRow = {
  id: string;
  queue_id: string;
  queue_nombre: string;
  usuario_id: string;
  nombre: string;
  email: string;
  is_online: boolean;
  max_conversations: number;
};

/** Agentes con nombre para reasignación y vistas de supervisor. */
export async function listChatAgentsDirectory(): Promise<ChatAgentDirectoryRow[]> {
  const { supabase, catalogSr, empresa_id } = await requireEmpresaTenantServiceRole();
  const { data, error } = await supabase
    .from("chat_agents")
    .select(
      `
      id,
      queue_id,
      is_online,
      max_conversations,
      usuario_id,
      chat_queues ( nombre )
    `
    )
    .eq("empresa_id", empresa_id)
    .order("queue_id", { ascending: true });

  if (error) throw new Error(error.message);

  const rows = (data ?? []) as Record<string, unknown>[];
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
    const q = row.chat_queues as { nombre?: string } | null;
    const uid = row.usuario_id as string;
    const u = usuarioById[uid];
    const nombre = (u?.nombre?.trim() || u?.email?.trim() || "—") as string;
    return {
      id: row.id as string,
      queue_id: row.queue_id as string,
      queue_nombre: (q?.nombre as string) ?? "Cola",
      usuario_id: uid,
      nombre,
      email: (u?.email as string) ?? "",
      is_online: Boolean(row.is_online),
      max_conversations: (row.max_conversations as number) ?? 5,
    };
  });
}

export type SupervisorAgentLoadRow = ChatAgentDirectoryRow & { active_conversations: number };

export async function fetchSupervisorAgentLoads(): Promise<SupervisorAgentLoadRow[]> {
  const { supabase, empresa_id } = await requireEmpresaTenantServiceRole();
  const agents = await listChatAgentsDirectory();
  if (agents.length === 0) return [];

  const agentIds = agents.map((a) => a.id);
  const { data: counts, error } = await supabase
    .from("chat_conversations")
    .select("assigned_agent_id")
    .eq("empresa_id", empresa_id)
    .in("assigned_agent_id", agentIds)
    .neq("status", "closed");

  if (error) throw new Error(error.message);

  const tally = new Map<string, number>();
  for (const row of counts ?? []) {
    const aid = row.assigned_agent_id as string | null;
    if (!aid) continue;
    tally.set(aid, (tally.get(aid) ?? 0) + 1);
  }

  return agents.map((a) => ({
    ...a,
    active_conversations: tally.get(a.id) ?? 0,
  }));
}

export async function countUnassignedOpenConversations(): Promise<number> {
  const { supabase, empresa_id } = await requireEmpresaTenantServiceRole();
  const { count, error } = await supabase
    .from("chat_conversations")
    .select("*", { count: "exact", head: true })
    .eq("empresa_id", empresa_id)
    .is("assigned_agent_id", null)
    .in("status", ["open", "pending"]);

  if (error) throw new Error(error.message);
  return count ?? 0;
}
