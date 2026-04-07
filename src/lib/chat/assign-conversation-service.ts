/**
 * Asignación automática de conversaciones a agentes según cola y carga.
 */
import type { SupabaseAdmin } from "@/lib/chat/types";

export type AssignConversationResult =
  | { ok: true; assigned: false; reason: "already_assigned" | "no_queue" | "no_agent" }
  | { ok: true; assigned: true; agent_id: string; queue_id: string }
  | { ok: false; error: string };

type QueueRow = { id: string; channel_type: string | null; nombre: string };
type AgentRow = { id: string; max_conversations: number };

function pickQueueForChannel(queues: QueueRow[], channelType: string): QueueRow | null {
  const t = channelType.trim().toLowerCase();
  const matching = queues.filter((q) => !q.channel_type || q.channel_type === t);
  if (matching.length === 0) return null;
  matching.sort((a, b) => {
    const aSpec = a.channel_type ? 0 : 1;
    const bSpec = b.channel_type ? 0 : 1;
    if (aSpec !== bSpec) return aSpec - bSpec;
    return a.nombre.localeCompare(b.nombre, "es");
  });
  return matching[0] ?? null;
}

/**
 * Resuelve cola por empresa + tipo de canal, elige agente en línea con menor carga (< max_conversations)
 * y actualiza `queue_id` / `assigned_agent_id`. Idempotente si ya hay agente asignado.
 */
export async function assignConversation(
  supabase: SupabaseAdmin,
  conversationId: string
): Promise<AssignConversationResult> {
  const cid = conversationId.trim();
  if (!cid) return { ok: false, error: "conversation_id vacío" };

  const { data: conv, error: convErr } = await supabase
    .from("chat_conversations")
    .select(
      `
      id,
      empresa_id,
      channel_id,
      assigned_agent_id,
      chat_channels ( type )
    `
    )
    .eq("id", cid)
    .maybeSingle();

  if (convErr) return { ok: false, error: convErr.message };
  if (!conv?.id) return { ok: false, error: "Conversación no encontrada" };

  if (conv.assigned_agent_id) {
    return { ok: true, assigned: false, reason: "already_assigned" };
  }

  const empresaId = conv.empresa_id as string;
  const ch = conv.chat_channels as { type?: string } | null | undefined;
  const channelType = (ch?.type as string) ?? "whatsapp";

  const { data: queues, error: qErr } = await supabase
    .from("chat_queues")
    .select("id, channel_type, nombre")
    .eq("empresa_id", empresaId)
    .eq("is_active", true);

  if (qErr) return { ok: false, error: qErr.message };
  const queue = pickQueueForChannel((queues ?? []) as QueueRow[], channelType);
  if (!queue) {
    return { ok: true, assigned: false, reason: "no_queue" };
  }

  const { data: agents, error: aErr } = await supabase
    .from("chat_agents")
    .select("id, max_conversations")
    .eq("empresa_id", empresaId)
    .eq("queue_id", queue.id)
    .eq("is_online", true);

  if (aErr) return { ok: false, error: aErr.message };
  const list = (agents ?? []) as AgentRow[];
  if (list.length === 0) {
    return { ok: true, assigned: false, reason: "no_agent" };
  }

  const loads = await Promise.all(
    list.map(async (agent) => {
      const { count, error } = await supabase
        .from("chat_conversations")
        .select("*", { count: "exact", head: true })
        .eq("assigned_agent_id", agent.id)
        .neq("status", "closed");
      if (error) return { agent, load: Number.MAX_SAFE_INTEGER };
      return { agent, load: count ?? 0 };
    })
  );

  const candidates = loads.filter(
    ({ agent, load }) => load < (agent.max_conversations ?? 5)
  );
  if (candidates.length === 0) {
    return { ok: true, assigned: false, reason: "no_agent" };
  }

  candidates.sort((a, b) => {
    if (a.load !== b.load) return a.load - b.load;
    return a.agent.id.localeCompare(b.agent.id);
  });
  const best = candidates[0]!.agent;

  const { error: upErr } = await supabase
    .from("chat_conversations")
    .update({
      queue_id: queue.id,
      assigned_agent_id: best.id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", cid)
    .eq("empresa_id", empresaId);

  if (upErr) return { ok: false, error: upErr.message };

  return { ok: true, assigned: true, agent_id: best.id, queue_id: queue.id };
}
