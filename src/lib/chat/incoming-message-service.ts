/**
 * Entrada omnicanal: persistencia central de mensajes entrantes y contacto/conversación.
 * WhatsApp en producción sigue pasando por `processInboundWebhookValue` (flujos, CRM, media);
 * este módulo concentra la escritura en BD reutilizable y el route genérico `/api/webhooks/[channel]`.
 */
import { assignConversation } from "@/lib/chat/assign-conversation-service";
import { createWhatsappConversationWithActiveFlow } from "@/lib/chat/whatsapp-conversation-bootstrap";
import type { SupabaseAdmin } from "@/lib/chat/types";
import { normalizeWaPhone } from "@/lib/chat/wa-phone";

export const CHAT_CHANNEL_TYPES = ["whatsapp", "instagram", "facebook", "email"] as const;
export type ChatChannelType = (typeof CHAT_CHANNEL_TYPES)[number];

export function isChatChannelType(s: string): s is ChatChannelType {
  return (CHAT_CHANNEL_TYPES as readonly string[]).includes(s);
}

export type SaveIncomingMessageChannel = {
  id: string;
  empresa_id: string;
  type: ChatChannelType;
};

export type SaveIncomingMessageContactData = {
  /** Identificador estable del contacto en el canal (tel normalizado, email, id social, etc.) */
  address: string;
  display_name?: string | null;
};

export type SaveIncomingMessageMessageData = {
  message_type: string;
  content: string | null;
  raw_payload: Record<string, unknown>;
  created_at?: string;
  from_me?: boolean;
  sender_type?: "contact" | "ai" | "human" | "system";
};

export type SaveIncomingMessageParams = {
  supabase: SupabaseAdmin;
  channel: SaveIncomingMessageChannel;
  /** ID del mensaje en el proveedor (p. ej. wa_message_id de Meta). */
  external_id: string;
  contact_data: SaveIncomingMessageContactData;
  message_data: SaveIncomingMessageMessageData;
  /**
   * Tras asegurar conversación y antes de insertar el mensaje (p. ej. reinicios / handoff WhatsApp).
   * Si actualiza `chat_conversations`, el paso final de `saveIncomingMessage` relee la fila.
   */
  adjustConversationBeforePersist?: (ctx: {
    supabase: SupabaseAdmin;
    empresaId: string;
    channelId: string;
    conversationId: string;
    contactId: string;
  }) => Promise<void>;
};

export type SaveIncomingMessageResult =
  | { ok: true; skipped_duplicate: true }
  | {
      ok: true;
      skipped_duplicate: false;
      conversation_id: string;
      contact_id: string;
      message_id: string;
    }
  | { ok: false; error: string };

type ConversationRowLite = {
  id: string;
  status: string;
  unread_count: number;
  flow_code: string | null;
  flow_current_node: string | null;
  flow_status: string;
  human_taken_over: boolean;
  active_flow_session_id?: string | null;
};

function normalizeContactAddress(type: ChatChannelType, address: string): string {
  const t = address.trim();
  if (!t) return "";
  if (type === "whatsapp") return normalizeWaPhone(t);
  if (type === "email") return t.toLowerCase();
  return t;
}

async function messageExistsByExternalId(
  supabase: SupabaseAdmin,
  externalId: string
): Promise<boolean> {
  const { data } = await supabase
    .from("chat_messages")
    .select("id")
    .eq("wa_message_id", externalId)
    .maybeSingle();
  return !!data?.id;
}

export type PersistInboundChatMessageInput = {
  supabase: SupabaseAdmin;
  empresaId: string;
  conversationId: string;
  externalMessageId: string;
  messageType: string;
  content: string | null;
  rawPayload: Record<string, unknown>;
  timestampIso: string;
  preview: string;
  fromMe?: boolean;
  senderType?: string;
  /** Estado de conversación a persistir junto con el bump del último mensaje. */
  conversationState: {
    flow_code?: string | null;
    flow_current_node?: string | null;
    flow_status?: string;
    human_taken_over?: boolean;
    unread_count: number;
    status?: string;
  };
};

export type PersistInboundChatMessageResult =
  | { ok: true; message_id: string }
  | { ok: false; error: string; duplicate?: boolean };

/**
 * Inserta fila en `chat_messages` y actualiza preview / unread / estado de flujo en `chat_conversations`.
 * Usado por el webhook WhatsApp tras toda la lógica de flujo (reinicios, handoff, etc.).
 */
export async function persistInboundChatMessageAndBump(
  input: PersistInboundChatMessageInput
): Promise<PersistInboundChatMessageResult> {
  const {
    supabase,
    empresaId,
    conversationId,
    externalMessageId,
    messageType,
    content,
    rawPayload,
    timestampIso,
    preview,
    fromMe = false,
    senderType = "contact",
    conversationState,
  } = input;

  const { data: insertedMsg, error: insErr } = await supabase
    .from("chat_messages")
    .insert({
      empresa_id: empresaId,
      conversation_id: conversationId,
      wa_message_id: externalMessageId,
      from_me: fromMe,
      sender_type: senderType,
      message_type: messageType,
      content,
      raw_payload: rawPayload,
    })
    .select("id")
    .single();

  if (insErr) {
    if (insErr.code === "23505") {
      return { ok: false, error: insErr.message, duplicate: true };
    }
    return { ok: false, error: insErr.message };
  }

  const messageId = (insertedMsg as { id?: string } | null)?.id;
  if (!messageId) return { ok: false, error: "Insert mensaje sin id" };

  const prevStatus = conversationState.status ?? "open";
  const nextStatus = prevStatus === "closed" ? "pending" : prevStatus;

  await supabase
    .from("chat_conversations")
    .update({
      flow_code: conversationState.flow_code ?? null,
      flow_current_node: conversationState.flow_current_node ?? null,
      flow_status: conversationState.flow_status ?? "bot",
      human_taken_over: conversationState.human_taken_over ?? false,
      last_message_at: timestampIso,
      last_message_preview: preview,
      unread_count: conversationState.unread_count + 1,
      status: nextStatus,
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversationId)
    .eq("empresa_id", empresaId);

  return { ok: true, message_id: messageId };
}

/**
 * Punto central omnicanal: contacto + conversación + mensaje entrante.
 * Canales futuros (Meta IG/FB, email) pueden invocar solo esto desde su webhook.
 */
export async function saveIncomingMessage(params: SaveIncomingMessageParams): Promise<SaveIncomingMessageResult> {
  const {
    supabase,
    channel,
    external_id: externalId,
    contact_data,
    message_data,
    adjustConversationBeforePersist,
  } = params;

  const ext = externalId.trim();
  if (!ext) return { ok: false, error: "external_id es obligatorio" };

  const address = normalizeContactAddress(channel.type, contact_data.address);
  if (!address) return { ok: false, error: "contact_data.address inválido" };

  if (await messageExistsByExternalId(supabase, ext)) {
    return { ok: true, skipped_duplicate: true };
  }

  const displayName = contact_data.display_name?.trim() || address;
  const empresaId = channel.empresa_id;
  const channelId = channel.id;

  const { data: contact, error: cErr } = await supabase
    .from("chat_contacts")
    .upsert(
      {
        empresa_id: empresaId,
        phone_number: address,
        phone_normalized: address,
        name: displayName,
      },
      { onConflict: "empresa_id,phone_number" }
    )
    .select("id, name, crm_prospecto_id")
    .single();

  if (cErr || !contact) {
    return { ok: false, error: `Contacto: ${cErr?.message ?? "error"}` };
  }

  const contactId = contact.id as string;
  if (displayName && displayName !== contact.name) {
    await supabase
      .from("chat_contacts")
      .update({ name: displayName, updated_at: new Date().toISOString() })
      .eq("id", contactId);
  }

  let { data: existingConvRaw } = await supabase
    .from("chat_conversations")
    .select(
      "id, status, unread_count, flow_code, flow_current_node, flow_status, human_taken_over, active_flow_session_id"
    )
    .eq("contact_id", contactId)
    .eq("channel_id", channelId)
    .maybeSingle();

  let existingConv: ConversationRowLite | null = existingConvRaw as ConversationRowLite | null;

  if (!existingConv) {
    if (channel.type === "whatsapp") {
      const { conv, error: bootErr } = await createWhatsappConversationWithActiveFlow(
        supabase,
        empresaId,
        channelId,
        contactId
      );
      if (bootErr) return { ok: false, error: bootErr };
      existingConv = conv;
    } else {
      const { data: conv, error: convErr } = await supabase
        .from("chat_conversations")
        .insert({
          empresa_id: empresaId,
          channel_id: channelId,
          contact_id: contactId,
          status: "open",
          flow_code: null,
          flow_current_node: null,
          flow_status: "human",
          human_taken_over: true,
          last_message_at: null,
          last_message_preview: null,
          unread_count: 0,
        })
        .select(
          "id, status, unread_count, flow_code, flow_current_node, flow_status, human_taken_over, active_flow_session_id"
        )
        .single();

      if (convErr?.code === "23505") {
        const { data: again } = await supabase
          .from("chat_conversations")
          .select(
            "id, status, unread_count, flow_code, flow_current_node, flow_status, human_taken_over, active_flow_session_id"
          )
          .eq("contact_id", contactId)
          .eq("channel_id", channelId)
          .maybeSingle();
        existingConv = again as ConversationRowLite | null;
      } else if (convErr) {
        return { ok: false, error: `Conversación: ${convErr.message}` };
      } else {
        existingConv = conv as ConversationRowLite;
        if (existingConv?.id) {
          const ar = await assignConversation(supabase, existingConv.id);
          if (!ar.ok) {
            console.warn("[saveIncomingMessage] assignConversation", ar.error);
          }
        }
      }
    }
  }

  if (!existingConv?.id) {
    return { ok: false, error: "No se pudo resolver conversación" };
  }

  const conversationId = existingConv.id as string;

  await adjustConversationBeforePersist?.({
    supabase,
    empresaId,
    channelId,
    conversationId,
    contactId,
  });

  const { data: convRow } = await supabase
    .from("chat_conversations")
    .select(
      "status, unread_count, flow_code, flow_current_node, flow_status, human_taken_over"
    )
    .eq("id", conversationId)
    .eq("empresa_id", empresaId)
    .maybeSingle();

  const row = convRow ?? existingConv;
  const ts =
    message_data.created_at?.trim() || new Date().toISOString();
  const preview = (message_data.content ?? "").slice(0, 280);
  const fromMe = message_data.from_me === true;
  const senderType = message_data.sender_type ?? (fromMe ? "human" : "contact");

  const persist = await persistInboundChatMessageAndBump({
    supabase,
    empresaId,
    conversationId,
    externalMessageId: ext,
    messageType: message_data.message_type,
    content: message_data.content,
    rawPayload: message_data.raw_payload,
    timestampIso: ts,
    preview,
    fromMe,
    senderType,
    conversationState: {
      flow_code: row.flow_code as string | null | undefined,
      flow_current_node: row.flow_current_node as string | null | undefined,
      flow_status: (row.flow_status as string) ?? "bot",
      human_taken_over: Boolean(row.human_taken_over),
      unread_count: (row.unread_count as number) ?? 0,
      status: row.status as string | undefined,
    },
  });

  if (!persist.ok) {
    if (persist.duplicate) return { ok: true, skipped_duplicate: true };
    return { ok: false, error: persist.error };
  }

  return {
    ok: true,
    skipped_duplicate: false,
    conversation_id: conversationId,
    contact_id: contactId,
    message_id: persist.message_id,
  };
}
