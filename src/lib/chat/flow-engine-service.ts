import {
  sendWhatsAppInteractiveButtons,
  sendWhatsAppImage,
  sendWhatsAppText,
} from "@/lib/chat/whatsapp-send-service";
import type { SupabaseAdmin } from "@/lib/chat/types";
import { normalizeWaPhone } from "@/lib/chat/whatsapp-webhook-service";

type ConversationFlowState = {
  id: string;
  empresa_id: string;
  channel_id: string;
  contact_id: string;
  flow_code: string | null;
  flow_current_node: string | null;
  flow_status: string;
  human_taken_over: boolean;
};

export type ProcessInteractiveReplyParams = {
  conversationId: string;
  empresaId: string;
  metaButtonId: string;
  rawPayload: Record<string, unknown>;
};

export type AdvanceConversationParams = {
  conversationId: string;
  empresaId: string;
  flowCode: string;
  nextNodeCode: string;
};

export type SendCurrentNodeParams = {
  conversationId: string;
  __autoHop?: number;
};

type FlowOption = {
  id: string;
  label: string;
  option_value: string;
  meta_button_id: string;
  next_node_code: string | null;
  sort_order: number;
  option_payload: Record<string, unknown> | null;
};

type FlowNode = {
  id: string;
  empresa_id: string;
  flow_code: string;
  node_code: string;
  message_text: string | null;
  save_as_field: string | null;
  next_node_code: string | null;
  node_type: "buttons" | "list" | "text" | "media" | "image_input" | "human" | "end";
  is_active: boolean;
};

type FlowNodeBlock = {
  id: string;
  node_id: string;
  block_type: "text" | "image" | "buttons";
  content_text: string | null;
  media_url: string | null;
  sort_order: number;
};

export type ProcessTextReplyParams = {
  conversationId: string;
  empresaId: string;
  textValue: string;
  rawPayload: Record<string, unknown>;
};

export type ProcessImageReplyParams = {
  conversationId: string;
  empresaId: string;
  mediaId: string;
  mimeType?: string | null;
  caption?: string | null;
  rawPayload: Record<string, unknown>;
};

export type FlowEngineContext = {
  supabase: SupabaseAdmin;
};

const CHAT_MEDIA_BUCKET = "chat-media";
let chatMediaBucketChecked = false;

function extensionFromMime(mimeType: string | null | undefined): string {
  if (!mimeType) return "jpg";
  const v = mimeType.toLowerCase();
  if (v.includes("png")) return "png";
  if (v.includes("webp")) return "webp";
  if (v.includes("gif")) return "gif";
  if (v.includes("jpeg") || v.includes("jpg")) return "jpg";
  return "jpg";
}

export function createFlowEngine(ctx: FlowEngineContext) {
  const supabase = ctx.supabase;

  async function getConversationFlowState(
    conversationId: string
  ): Promise<ConversationFlowState | null> {
    const { data, error } = await supabase
      .from("chat_conversations")
      .select(
        "id, empresa_id, channel_id, contact_id, flow_code, flow_current_node, flow_status, human_taken_over"
      )
      .eq("id", conversationId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    return data as ConversationFlowState;
  }

  async function insertFlowEvent(input: {
    empresaId: string;
    conversationId: string;
    flowCode?: string | null;
    nodeCode?: string | null;
    eventType: string;
    selectedOptionId?: string | null;
    metaButtonId?: string | null;
    payload?: Record<string, unknown>;
  }) {
    const { error } = await supabase.from("chat_flow_events").insert({
      empresa_id: input.empresaId,
      conversation_id: input.conversationId,
      flow_code: input.flowCode ?? null,
      node_code: input.nodeCode ?? null,
      event_type: input.eventType,
      selected_option_id: input.selectedOptionId ?? null,
      meta_button_id: input.metaButtonId ?? null,
      payload: input.payload ?? {},
    });
    if (error) {
      console.error("[flow-engine] event insert:", error.message);
    }
  }

  async function getConversationSendContext(conversationId: string): Promise<{
    conversation: ConversationFlowState;
    toDigits: string;
    phoneNumberId: string;
    token: string;
  }> {
    const conversation = await getConversationFlowState(conversationId);
    if (!conversation) throw new Error("Conversación no encontrada");

    const { data: contact, error: cErr } = await supabase
      .from("chat_contacts")
      .select("phone_number")
      .eq("id", conversation.contact_id)
      .maybeSingle();
    if (cErr) throw new Error(cErr.message);

    const { data: channel, error: chErr } = await supabase
      .from("chat_channels")
      .select("meta_phone_number_id, whatsapp_access_token, activo")
      .eq("id", conversation.channel_id)
      .maybeSingle();
    if (chErr) throw new Error(chErr.message);

    const toDigits = normalizeWaPhone((contact?.phone_number as string) ?? "");
    const phoneNumberId =
      (channel as { meta_phone_number_id?: string } | null)?.meta_phone_number_id ??
      process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
    const tokenInChannel =
      typeof (channel as { whatsapp_access_token?: string } | null)?.whatsapp_access_token ===
      "string"
        ? (channel as { whatsapp_access_token: string }).whatsapp_access_token.trim()
        : "";
    const token = tokenInChannel || process.env.WHATSAPP_TOKEN?.trim() || "";

    if (!toDigits || !phoneNumberId || !token) {
      throw new Error(
        "Faltan datos de envío (toDigits/phoneNumberId/token) para avanzar flujo"
      );
    }
    return { conversation, toDigits, phoneNumberId, token };
  }

  async function persistOutgoingMessage(input: {
    conversation: ConversationFlowState;
    content: string;
    messageType: string;
    waMessageId: string | null;
    raw: unknown;
    senderType: "system" | "human" | "ai";
    automationSource: string;
  }) {
    const ts = new Date().toISOString();
    await supabase.from("chat_messages").insert({
      empresa_id: input.conversation.empresa_id,
      conversation_id: input.conversation.id,
      wa_message_id: input.waMessageId,
      from_me: true,
      sender_type: input.senderType,
      automation_source: input.automationSource,
      message_type: input.messageType,
      content: input.content,
      raw_payload: (input.raw ?? {}) as Record<string, unknown>,
    });
    await supabase
      .from("chat_conversations")
      .update({
        last_message_at: ts,
        last_message_preview: input.content.slice(0, 280),
        updated_at: ts,
      })
      .eq("id", input.conversation.id);
  }

  async function ensureChatMediaBucket() {
    if (chatMediaBucketChecked) return;
    const { data: buckets, error: listErr } = await supabase.storage.listBuckets();
    if (listErr) throw new Error(listErr.message);
    const exists = (buckets ?? []).some((b) => b.name === CHAT_MEDIA_BUCKET);
    if (!exists) {
      const { error: createErr } = await supabase.storage.createBucket(CHAT_MEDIA_BUCKET, {
        public: true,
        fileSizeLimit: "10MB",
      });
      if (createErr && !createErr.message.toLowerCase().includes("already exists")) {
        throw new Error(createErr.message);
      }
    }
    chatMediaBucketChecked = true;
  }

  async function downloadMetaMedia(params: {
    mediaId: string;
    accessToken: string;
    mimeTypeHint?: string | null;
  }): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const version = process.env.WHATSAPP_GRAPH_VERSION ?? "v19.0";
    const metaRes = await fetch(
      `https://graph.facebook.com/${version}/${params.mediaId}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${params.accessToken}` },
      }
    );
    const metaJson = (await metaRes.json().catch(() => ({}))) as {
      url?: string;
      mime_type?: string;
      error?: { message?: string };
    };
    if (!metaRes.ok || !metaJson.url) {
      throw new Error(
        metaJson.error?.message || `No se pudo obtener URL temporal para media_id=${params.mediaId}`
      );
    }

    const binRes = await fetch(metaJson.url, {
      method: "GET",
      headers: { Authorization: `Bearer ${params.accessToken}` },
    });
    if (!binRes.ok) {
      throw new Error(`No se pudo descargar binario media_id=${params.mediaId}`);
    }
    const arr = new Uint8Array(await binRes.arrayBuffer());
    return { bytes: arr, mimeType: metaJson.mime_type || params.mimeTypeHint || "image/jpeg" };
  }

  async function getNode(
    empresaId: string,
    flowCode: string,
    nodeCode: string
  ): Promise<FlowNode | null> {
    const { data, error } = await supabase
      .from("chat_flow_nodes")
      .select(
        "id, empresa_id, flow_code, node_code, message_text, save_as_field, next_node_code, node_type, is_active"
      )
      .eq("empresa_id", empresaId)
      .eq("flow_code", flowCode)
      .eq("node_code", nodeCode)
      .eq("is_active", true)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (data as FlowNode | null) ?? null;
  }

  async function getNodeOptions(nodeId: string): Promise<FlowOption[]> {
    const { data, error } = await supabase
      .from("chat_flow_options")
      .select("id, label, option_value, meta_button_id, next_node_code, sort_order, option_payload")
      .eq("node_id", nodeId)
      .order("sort_order", { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []) as FlowOption[];
  }

  async function getConversationFlowDataMap(input: {
    empresaId: string;
    conversationId: string;
    flowCode: string | null;
  }): Promise<Record<string, string>> {
    if (!input.flowCode) return {};
    const { data, error } = await supabase
      .from("chat_flow_data")
      .select("field_name, field_value")
      .eq("empresa_id", input.empresaId)
      .eq("conversation_id", input.conversationId)
      .eq("flow_code", input.flowCode);
    if (error) throw new Error(error.message);
    const out: Record<string, string> = {};
    for (const row of data ?? []) {
      const key = String((row as { field_name?: unknown }).field_name ?? "").trim();
      if (!key) continue;
      out[key] = String((row as { field_value?: unknown }).field_value ?? "");
    }
    return out;
  }

  function interpolateTemplate(
    input: string,
    vars: Record<string, string | number | boolean | null | undefined>
  ): string {
    return input.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_full, name: string) => {
      const raw = vars[name];
      if (raw === null || raw === undefined) return "";
      return String(raw);
    });
  }

  async function getNodeBlocks(node: FlowNode): Promise<FlowNodeBlock[]> {
    const { data, error } = await supabase
      .from("chat_flow_node_blocks")
      .select("id, node_id, block_type, content_text, media_url, sort_order")
      .eq("empresa_id", node.empresa_id)
      .eq("node_id", node.id)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []) as FlowNodeBlock[];
  }

  async function advanceConversationToNode(
    params: AdvanceConversationParams
  ): Promise<{ ok: boolean; error?: string }> {
    const { error } = await supabase
      .from("chat_conversations")
      .update({
        flow_code: params.flowCode,
        flow_current_node: params.nextNodeCode,
        updated_at: new Date().toISOString(),
      })
      .eq("id", params.conversationId)
      .eq("empresa_id", params.empresaId);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  }

  async function sendCurrentFlowNode(
    params: SendCurrentNodeParams
  ): Promise<{ ok: boolean; nodeCode?: string; error?: string }> {
    const currentHop = params.__autoHop ?? 0;
    if (currentHop > 10) {
      return { ok: false, error: "Se alcanzó el límite de auto-encadenamiento del flujo" };
    }
    const ctxSend = await getConversationSendContext(params.conversationId);
    const state = ctxSend.conversation;
    if (!state.flow_code || !state.flow_current_node) {
      return { ok: false, error: "Conversación sin flow_code o flow_current_node" };
    }

    const node = await getNode(state.empresa_id, state.flow_code, state.flow_current_node);
    if (!node) return { ok: false, error: "Nodo actual no encontrado" };

    const flowVars = await getConversationFlowDataMap({
      empresaId: state.empresa_id,
      conversationId: state.id,
      flowCode: state.flow_code,
    });
    const fallbackText = interpolateTemplate(
      node.message_text?.trim() || "Continuemos con el flujo.",
      flowVars
    );
    const basePayload = {
      flow_code: state.flow_code,
      node_code: node.node_code,
      node_type: node.node_type,
    };
    const blocks = await getNodeBlocks(node);

    // Compatibilidad: si el nodo aún no tiene bloques, mantiene comportamiento legacy.
    if (blocks.length === 0) {
      const bodyText = fallbackText;
      if (node.node_type === "buttons") {
        const options = await getNodeOptions(node.id);
        const send = await sendWhatsAppInteractiveButtons({
          toDigits: ctxSend.toDigits,
          phoneNumberId: ctxSend.phoneNumberId,
          accessToken: ctxSend.token,
          bodyText,
          buttons: options.map((o) => ({
            id: o.meta_button_id,
            title: o.label,
          })),
        });
        if (!send.ok) return { ok: false, error: send.error };

        await persistOutgoingMessage({
          conversation: state,
          content: bodyText,
          messageType: "interactive",
          waMessageId: send.waMessageId,
          raw: send.raw,
          senderType: "system",
          automationSource: "flow_engine",
        });
      } else if (node.node_type === "media") {
        const imageFromLegacyText = node.message_text?.trim() || "";
        if (!imageFromLegacyText) {
          return {
            ok: false,
            error: `Nodo media "${node.node_code}" sin imagen configurada en bloques ni mensaje legacy`,
          };
        }
        const send = await sendWhatsAppImage({
          toDigits: ctxSend.toDigits,
          phoneNumberId: ctxSend.phoneNumberId,
          accessToken: ctxSend.token,
          imageUrl: imageFromLegacyText,
        });
        if (!send.ok) return { ok: false, error: send.error };

        await persistOutgoingMessage({
          conversation: state,
          content: `Imagen enviada\n${imageFromLegacyText}`,
          messageType: "image",
          waMessageId: send.waMessageId,
          raw: send.raw,
          senderType: "system",
          automationSource: "flow_engine",
        });
      } else {
        const send = await sendWhatsAppText({
          toDigits: ctxSend.toDigits,
          phoneNumberId: ctxSend.phoneNumberId,
          accessToken: ctxSend.token,
          text: bodyText,
        });
        if (!send.ok) return { ok: false, error: send.error };

        await persistOutgoingMessage({
          conversation: state,
          content: bodyText,
          messageType: "text",
          waMessageId: send.waMessageId,
          raw: send.raw,
          senderType: "system",
          automationSource: "flow_engine",
        });
      }

      if (node.node_type === "human") {
        console.info("[flow-engine] takeover activated", {
          conversationId: state.id,
          nodeCode: node.node_code,
        });
        await supabase
          .from("chat_conversations")
          .update({
            flow_status: "human",
            human_taken_over: true,
            updated_at: new Date().toISOString(),
          })
          .eq("id", state.id);
      }

      await insertFlowEvent({
        empresaId: state.empresa_id,
        conversationId: state.id,
        flowCode: state.flow_code,
        nodeCode: node.node_code,
        eventType: "node_sent",
        payload: { ...basePayload, legacy: true },
      });

      return { ok: true, nodeCode: node.node_code };
    }

    const options = await getNodeOptions(node.id);
    for (const block of blocks) {
      if (block.block_type === "text") {
        const textRaw = block.content_text?.trim();
        const text = textRaw ? interpolateTemplate(textRaw, flowVars) : "";
        if (!text) continue;
        const send = await sendWhatsAppText({
          toDigits: ctxSend.toDigits,
          phoneNumberId: ctxSend.phoneNumberId,
          accessToken: ctxSend.token,
          text,
        });
        if (!send.ok) return { ok: false, error: send.error };
        await persistOutgoingMessage({
          conversation: state,
          content: text,
          messageType: "text",
          waMessageId: send.waMessageId,
          raw: send.raw,
          senderType: "system",
          automationSource: "flow_engine",
        });
        continue;
      }
      if (block.block_type === "image") {
        const imageUrl = block.media_url?.trim();
        if (!imageUrl) continue;
        const captionRaw = block.content_text?.trim() || "";
        const caption = captionRaw ? interpolateTemplate(captionRaw, flowVars) : undefined;
        const send = await sendWhatsAppImage({
          toDigits: ctxSend.toDigits,
          phoneNumberId: ctxSend.phoneNumberId,
          accessToken: ctxSend.token,
          imageUrl,
          caption,
        });
        if (!send.ok) return { ok: false, error: send.error };
        const imageLabel = caption ? `Imagen enviada: ${caption}` : "Imagen enviada";
        await persistOutgoingMessage({
          conversation: state,
          content: `${imageLabel}\n${imageUrl}`,
          messageType: "image",
          waMessageId: send.waMessageId,
          raw: send.raw,
          senderType: "system",
          automationSource: "flow_engine",
        });
        continue;
      }
      if (block.block_type === "buttons") {
        const bodyTextRaw = block.content_text?.trim() || fallbackText;
        const bodyText = interpolateTemplate(bodyTextRaw, flowVars);
        const send = await sendWhatsAppInteractiveButtons({
          toDigits: ctxSend.toDigits,
          phoneNumberId: ctxSend.phoneNumberId,
          accessToken: ctxSend.token,
          bodyText,
          buttons: options.map((o) => ({
            id: o.meta_button_id,
            title: o.label,
          })),
        });
        if (!send.ok) return { ok: false, error: send.error };
        await persistOutgoingMessage({
          conversation: state,
          content: bodyText,
          messageType: "interactive",
          waMessageId: send.waMessageId,
          raw: send.raw,
          senderType: "system",
          automationSource: "flow_engine",
        });
      }
    }

    if (node.node_type === "human") {
      console.info("[flow-engine] takeover activated", {
        conversationId: state.id,
        nodeCode: node.node_code,
      });
      await supabase
        .from("chat_conversations")
        .update({
          flow_status: "human",
          human_taken_over: true,
          updated_at: new Date().toISOString(),
        })
        .eq("id", state.id);
    }

    await insertFlowEvent({
      empresaId: state.empresa_id,
      conversationId: state.id,
      flowCode: state.flow_code,
      nodeCode: node.node_code,
      eventType: "node_sent",
      payload: { ...basePayload, blocks: blocks.length },
    });

    const canAutoAdvance =
      Boolean(node.next_node_code) &&
      !["buttons", "list", "image_input", "human", "end"].includes(node.node_type) &&
      !(node.node_type === "text" && Boolean(node.save_as_field?.trim()));
    if (canAutoAdvance && node.next_node_code && state.flow_code) {
      const adv = await advanceConversationToNode({
        conversationId: state.id,
        empresaId: state.empresa_id,
        flowCode: state.flow_code,
        nextNodeCode: node.next_node_code,
      });
      if (!adv.ok) return { ok: false, error: adv.error ?? "No se pudo auto-avanzar nodo" };
      await insertFlowEvent({
        empresaId: state.empresa_id,
        conversationId: state.id,
        flowCode: state.flow_code,
        nodeCode: node.next_node_code,
        eventType: "node_advanced",
        payload: {
          from_node: node.node_code,
          next_node_code: node.next_node_code,
          reason: "auto_chain_after_outbound",
        },
      });
      return sendCurrentFlowNode({ conversationId: state.id, __autoHop: currentHop + 1 });
    }

    return { ok: true, nodeCode: node.node_code };
  }

  async function processInteractiveReply(
    params: ProcessInteractiveReplyParams
  ): Promise<{ ok: boolean; status: string; nextNodeCode?: string; error?: string }> {
    console.info("[flow-engine] button received", {
      conversationId: params.conversationId,
      empresaId: params.empresaId,
      metaButtonId: params.metaButtonId,
    });
    const state = await getConversationFlowState(params.conversationId);
    if (!state || state.empresa_id !== params.empresaId) {
      return { ok: false, status: "conversation_not_found", error: "Conversación no encontrada" };
    }
    if (state.flow_status !== "bot" || state.human_taken_over) {
      await insertFlowEvent({
        empresaId: state.empresa_id,
        conversationId: state.id,
        flowCode: state.flow_code,
        nodeCode: state.flow_current_node,
        eventType: "ignored_interactive_reply",
        metaButtonId: params.metaButtonId,
        payload: { reason: "conversation_not_in_bot_mode", raw: params.rawPayload },
      });
      return { ok: true, status: "ignored_not_bot_mode" };
    }
    if (!state.flow_code || !state.flow_current_node) {
      await insertFlowEvent({
        empresaId: state.empresa_id,
        conversationId: state.id,
        eventType: "invalid_button",
        metaButtonId: params.metaButtonId,
        payload: { reason: "missing_flow_state", raw: params.rawPayload },
      });
      return { ok: true, status: "missing_flow_state" };
    }

    const currentNode = await getNode(
      state.empresa_id,
      state.flow_code,
      state.flow_current_node
    );
    console.info("[flow-engine] current node", {
      conversationId: state.id,
      flowCode: state.flow_code,
      nodeCode: state.flow_current_node,
    });
    if (!currentNode) {
      await insertFlowEvent({
        empresaId: state.empresa_id,
        conversationId: state.id,
        flowCode: state.flow_code,
        nodeCode: state.flow_current_node,
        eventType: "invalid_button",
        metaButtonId: params.metaButtonId,
        payload: { reason: "current_node_not_found", raw: params.rawPayload },
      });
      return { ok: true, status: "current_node_not_found" };
    }

    const options = await getNodeOptions(currentNode.id);
    const selected = options.find((o) => o.meta_button_id === params.metaButtonId);
    if (!selected) {
      await insertFlowEvent({
        empresaId: state.empresa_id,
        conversationId: state.id,
        flowCode: state.flow_code,
        nodeCode: currentNode.node_code,
        eventType: "invalid_button",
        metaButtonId: params.metaButtonId,
        payload: { reason: "option_not_found_in_node", raw: params.rawPayload },
      });
      return { ok: true, status: "invalid_button" };
    }

    await insertFlowEvent({
      empresaId: state.empresa_id,
      conversationId: state.id,
      flowCode: state.flow_code,
      nodeCode: currentNode.node_code,
      eventType: "button_selected",
      selectedOptionId: selected.id,
      metaButtonId: params.metaButtonId,
      payload: {
        option_value: selected.option_value,
        option_payload: selected.option_payload ?? {},
        raw: params.rawPayload,
      },
    });

    const optionPayload =
      selected.option_payload && typeof selected.option_payload === "object"
        ? selected.option_payload
        : {};
    const payloadEntries = Object.entries(optionPayload).filter(([key]) => key.trim().length > 0);
    if (!payloadEntries.some(([k]) => k === "opcion_label")) {
      payloadEntries.push(["opcion_label", selected.label]);
    }
    if (payloadEntries.length > 0 && state.flow_code) {
      const upserts = payloadEntries.map(([fieldName, fieldValue]) => ({
        empresa_id: state.empresa_id,
        conversation_id: state.id,
        flow_code: state.flow_code as string,
        field_name: fieldName.trim(),
        field_value:
          typeof fieldValue === "string" || typeof fieldValue === "number" || typeof fieldValue === "boolean"
            ? String(fieldValue)
            : JSON.stringify(fieldValue ?? ""),
      }));
      const { error: payloadSaveErr } = await supabase
        .from("chat_flow_data")
        .upsert(upserts, { onConflict: "conversation_id,field_name" });
      if (payloadSaveErr) {
        return { ok: false, status: "save_option_payload_failed", error: payloadSaveErr.message };
      }
    }

    if (!selected.next_node_code) {
      await insertFlowEvent({
        empresaId: state.empresa_id,
        conversationId: state.id,
        flowCode: state.flow_code,
        nodeCode: currentNode.node_code,
        eventType: "node_advanced",
        selectedOptionId: selected.id,
        metaButtonId: params.metaButtonId,
        payload: { next_node_code: null },
      });
      return { ok: true, status: "no_next_node" };
    }
    console.info("[flow-engine] next node resolved", {
      conversationId: state.id,
      currentNode: currentNode.node_code,
      nextNodeCode: selected.next_node_code,
      metaButtonId: params.metaButtonId,
    });

    const adv = await advanceConversationToNode({
      conversationId: state.id,
      empresaId: state.empresa_id,
      flowCode: state.flow_code,
      nextNodeCode: selected.next_node_code,
    });
    if (!adv.ok) {
      return {
        ok: false,
        status: "advance_failed",
        error: adv.error ?? "No se pudo avanzar al siguiente nodo",
      };
    }

    await insertFlowEvent({
      empresaId: state.empresa_id,
      conversationId: state.id,
      flowCode: state.flow_code,
      nodeCode: selected.next_node_code,
      eventType: "node_advanced",
      selectedOptionId: selected.id,
      metaButtonId: params.metaButtonId,
      payload: { from_node: currentNode.node_code, next_node_code: selected.next_node_code },
    });

    const sent = await sendCurrentFlowNode({ conversationId: state.id });
    if (!sent.ok) {
      return { ok: false, status: "send_next_node_failed", error: sent.error };
    }
    console.info("[flow-engine] message sent for node", {
      conversationId: state.id,
      nodeCode: sent.nodeCode ?? selected.next_node_code,
    });

    return { ok: true, status: "advanced", nextNodeCode: selected.next_node_code };
  }

  async function processTextReply(
    params: ProcessTextReplyParams
  ): Promise<{ ok: boolean; status: string; nextNodeCode?: string; error?: string }> {
    const textValue = params.textValue.trim();
    if (!textValue) return { ok: true, status: "empty_text_ignored" };

    const state = await getConversationFlowState(params.conversationId);
    if (!state || state.empresa_id !== params.empresaId) {
      return { ok: false, status: "conversation_not_found", error: "Conversación no encontrada" };
    }
    if (state.flow_status !== "bot" || state.human_taken_over) {
      return { ok: true, status: "ignored_not_bot_mode" };
    }
    if (!state.flow_code || !state.flow_current_node) {
      return { ok: true, status: "missing_flow_state" };
    }

    const currentNode = await getNode(
      state.empresa_id,
      state.flow_code,
      state.flow_current_node
    );
    if (!currentNode) {
      return { ok: true, status: "ignored_node_not_found" };
    }
    if (currentNode.node_type === "image_input") {
      const sendCtx = await getConversationSendContext(state.id);
      const reminder = "Por favor envía una imagen del comprobante";
      const send = await sendWhatsAppText({
        toDigits: sendCtx.toDigits,
        phoneNumberId: sendCtx.phoneNumberId,
        accessToken: sendCtx.token,
        text: reminder,
      });
      if (send.ok) {
        await persistOutgoingMessage({
          conversation: state,
          content: reminder,
          messageType: "text",
          waMessageId: send.waMessageId,
          raw: send.raw,
          senderType: "system",
          automationSource: "flow_engine",
        });
      }
      await insertFlowEvent({
        empresaId: state.empresa_id,
        conversationId: state.id,
        flowCode: state.flow_code,
        nodeCode: currentNode.node_code,
        eventType: "image_expected_text_received",
        payload: { text_value: textValue, raw: params.rawPayload },
      });
      return { ok: true, status: "image_expected_text_received" };
    }
    if (currentNode.node_type !== "text" || !currentNode.save_as_field?.trim()) {
      return { ok: true, status: "ignored_not_text_node" };
    }

    if (currentNode.save_as_field) {
      const { error: dataErr } = await supabase
        .from("chat_flow_data")
        .upsert(
          {
            empresa_id: state.empresa_id,
            conversation_id: state.id,
            flow_code: state.flow_code,
            field_name: currentNode.save_as_field,
            field_value: textValue,
          },
          { onConflict: "conversation_id,field_name" }
        );
      if (dataErr) {
        return { ok: false, status: "save_text_failed", error: dataErr.message };
      }
    }

    await insertFlowEvent({
      empresaId: state.empresa_id,
      conversationId: state.id,
      flowCode: state.flow_code,
      nodeCode: currentNode.node_code,
      eventType: "text_captured",
      payload: {
        save_as_field: currentNode.save_as_field ?? null,
        text_value: textValue,
        raw: params.rawPayload,
      },
    });

    if (!currentNode.next_node_code) {
      return { ok: true, status: "captured_no_next_node" };
    }

    console.info("[flow-engine] text captured advance", {
      conversationId: state.id,
      currentNode: currentNode.node_code,
      saveAsField: currentNode.save_as_field ?? null,
      nextNodeCode: currentNode.next_node_code,
    });

    const adv = await advanceConversationToNode({
      conversationId: state.id,
      empresaId: state.empresa_id,
      flowCode: state.flow_code,
      nextNodeCode: currentNode.next_node_code,
    });
    if (!adv.ok) {
      return {
        ok: false,
        status: "advance_failed",
        error: adv.error ?? "No se pudo avanzar al siguiente nodo",
      };
    }

    await insertFlowEvent({
      empresaId: state.empresa_id,
      conversationId: state.id,
      flowCode: state.flow_code,
      nodeCode: currentNode.next_node_code,
      eventType: "node_advanced",
      payload: {
        from_node: currentNode.node_code,
        next_node_code: currentNode.next_node_code,
        reason: "text_captured",
      },
    });

    const sent = await sendCurrentFlowNode({ conversationId: state.id });
    if (!sent.ok) {
      return { ok: false, status: "send_next_node_failed", error: sent.error };
    }

    return { ok: true, status: "advanced", nextNodeCode: currentNode.next_node_code };
  }

  async function processImageReply(
    params: ProcessImageReplyParams
  ): Promise<{ ok: boolean; status: string; nextNodeCode?: string; error?: string }> {
    const state = await getConversationFlowState(params.conversationId);
    if (!state || state.empresa_id !== params.empresaId) {
      return { ok: false, status: "conversation_not_found", error: "Conversación no encontrada" };
    }
    if (state.flow_status !== "bot" || state.human_taken_over) {
      return { ok: true, status: "ignored_not_bot_mode" };
    }
    if (!state.flow_code || !state.flow_current_node) {
      return { ok: true, status: "missing_flow_state" };
    }

    const currentNode = await getNode(
      state.empresa_id,
      state.flow_code,
      state.flow_current_node
    );
    if (!currentNode || currentNode.node_type !== "image_input") {
      return { ok: true, status: "ignored_not_image_node" };
    }

    const sendCtx = await getConversationSendContext(state.id);
    const media = await downloadMetaMedia({
      mediaId: params.mediaId,
      accessToken: sendCtx.token,
      mimeTypeHint: params.mimeType ?? null,
    });
    await ensureChatMediaBucket();

    const ext = extensionFromMime(media.mimeType);
    const path = `${state.empresa_id}/${state.id}/${Date.now()}.${ext}`;
    const upload = await supabase.storage.from(CHAT_MEDIA_BUCKET).upload(path, media.bytes, {
      contentType: media.mimeType,
      upsert: true,
    });
    if (upload.error) {
      return { ok: false, status: "upload_failed", error: upload.error.message };
    }
    const publicUrl = supabase.storage.from(CHAT_MEDIA_BUCKET).getPublicUrl(path).data.publicUrl;

    if (currentNode.save_as_field) {
      const { error: upErr } = await supabase
        .from("chat_flow_data")
        .upsert(
          {
            empresa_id: state.empresa_id,
            conversation_id: state.id,
            flow_code: state.flow_code,
            field_name: currentNode.save_as_field,
            field_value: publicUrl,
          },
          { onConflict: "conversation_id,field_name" }
        );
      if (upErr) return { ok: false, status: "save_image_failed", error: upErr.message };
    }

    await insertFlowEvent({
      empresaId: state.empresa_id,
      conversationId: state.id,
      flowCode: state.flow_code,
      nodeCode: currentNode.node_code,
      eventType: "image_received",
      payload: {
        media_id: params.mediaId,
        mime_type: media.mimeType,
        caption: params.caption ?? null,
        storage_url: publicUrl,
        save_as_field: currentNode.save_as_field ?? null,
      },
    });

    if (!currentNode.next_node_code) {
      return { ok: true, status: "captured_no_next_node" };
    }

    const adv = await advanceConversationToNode({
      conversationId: state.id,
      empresaId: state.empresa_id,
      flowCode: state.flow_code,
      nextNodeCode: currentNode.next_node_code,
    });
    if (!adv.ok) {
      return { ok: false, status: "advance_failed", error: adv.error };
    }

    await insertFlowEvent({
      empresaId: state.empresa_id,
      conversationId: state.id,
      flowCode: state.flow_code,
      nodeCode: currentNode.next_node_code,
      eventType: "node_advanced",
      payload: {
        from_node: currentNode.node_code,
        next_node_code: currentNode.next_node_code,
        reason: "image_received",
      },
    });

    const sent = await sendCurrentFlowNode({ conversationId: state.id });
    if (!sent.ok) {
      return { ok: false, status: "send_next_node_failed", error: sent.error };
    }
    return { ok: true, status: "advanced", nextNodeCode: currentNode.next_node_code };
  }

  return {
    getConversationFlowState,
    processInteractiveReply,
    processTextReply,
    processImageReply,
    advanceConversationToNode,
    sendCurrentFlowNode,
  };
}

export async function getConversationFlowState(
  supabase: SupabaseAdmin,
  conversationId: string
) {
  return createFlowEngine({ supabase }).getConversationFlowState(conversationId);
}

export async function processInteractiveReply(
  supabase: SupabaseAdmin,
  params: ProcessInteractiveReplyParams
) {
  return createFlowEngine({ supabase }).processInteractiveReply(params);
}

export async function advanceConversationToNode(
  supabase: SupabaseAdmin,
  params: AdvanceConversationParams
) {
  return createFlowEngine({ supabase }).advanceConversationToNode(params);
}

export async function processTextReply(
  supabase: SupabaseAdmin,
  params: ProcessTextReplyParams
) {
  return createFlowEngine({ supabase }).processTextReply(params);
}

export async function processImageReply(
  supabase: SupabaseAdmin,
  params: ProcessImageReplyParams
) {
  return createFlowEngine({ supabase }).processImageReply(params);
}

export async function sendCurrentFlowNode(
  supabase: SupabaseAdmin,
  params: SendCurrentNodeParams
) {
  return createFlowEngine({ supabase }).sendCurrentFlowNode(params);
}
