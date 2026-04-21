import { downloadMetaMediaBytes } from "@/lib/chat/meta-media-download";
import { flowTrace, summarizeFlowDataForTrace } from "@/lib/chat/flow-trace-log";
import { COMPROBANTE_BUTTON_IDS, parseComprobanteValidationConfig } from "@/lib/chat/comprobante-validation-types";
import {
  mensajeClienteComprobanteNoValido,
  runComprobanteValidationPipeline,
} from "@/lib/chat/comprobante-validation-service";
import { sendWhatsAppInteractiveButtons, sendWhatsAppImage } from "@/lib/chat/whatsapp-send-service";
import {
  resolveOutboundTextContextFromIds,
  sendOutboundTextMessage,
  ycloudOutboundUnsupportedMessage,
} from "@/lib/chat/outbound-send-dispatch";
import type { SupabaseAdmin } from "@/lib/chat/types";
import { normalizeWaPhone } from "@/lib/chat/whatsapp-webhook-service";
import { ensureActiveFlowSessionForConversation } from "@/lib/chat/flow-session-service";
import {
  applySorteoInteractiveCommercialContract,
  buildChatFlowDataUpsertsForSorteoOrder,
  buildSorteoOrderFlowVarOverrides,
  finalizeSorteoOrderFromConfirmedFlowData,
  getSorteoDatosIncompletosMessage,
  getSorteoIdForChatFlow,
  optionPayloadFinalizesSorteoOrder,
  SORTEO_COMPROBANTE_MEDIA_ID_FIELD,
  SORTEO_COMPROBANTE_URL_FIELD,
} from "@/lib/sorteos/sorteo-order-from-chat";
import { parseMoneyPy } from "@/lib/sorteos/parse-money-py";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";

type ConversationFlowState = {
  id: string;
  empresa_id: string;
  channel_id: string;
  contact_id: string;
  flow_code: string | null;
  flow_current_node: string | null;
  flow_status: string;
  human_taken_over: boolean;
  /** Run activo: lecturas/escrituras de `chat_flow_data` solo bajo este id. */
  active_flow_session_id?: string | null;
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
  /** Se fusiona encima de chat_flow_data (útil tras crear orden sorteo sin esperar réplica). */
  mergeFlowVars?: Record<string, string>;
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

/**
 * Texto del botón reply en WhatsApp: debe coincidir con lo configurado en el ERP.
 * Prioriza `option_payload.opcion_label` (modo simple del editor), luego promo/producto abreviado, luego `label`.
 */
function whatsAppInteractiveTitleFromOption(o: FlowOption): string {
  const pl = o.option_payload;
  if (pl && typeof pl === "object" && !Array.isArray(pl)) {
    const ol = (pl as Record<string, unknown>).opcion_label;
    if (typeof ol === "string" && ol.trim()) return ol.trim();
    const pn = (pl as Record<string, unknown>).promo_nombre;
    if (typeof pn === "string" && pn.trim()) return pn.trim();
    const prod = (pl as Record<string, unknown>).producto;
    const monto = (pl as Record<string, unknown>).monto;
    if (typeof prod === "string" && prod.trim() && typeof monto === "number" && monto > 0) {
      return `${prod.trim()} ${monto}`.trim();
    }
  }
  return (o.label ?? "").trim() || "Opción";
}

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

export type EnsureInboundPresentParams = {
  conversationId: string;
  empresaId: string;
};

export type EnsureInboundPresentResult = {
  ok: boolean;
  status: string;
  /** Si true, acabamos de enviar la UI del nodo actual; no interpretar el mismo mensaje de texto como captura */
  presentedNow: boolean;
  /**
   * Si true junto con `presentedNow`, el nodo recién enviado es captura de texto: el mismo mensaje
   * entrante debe pasarse a `processTextReply` (evita perder nombre/cédula en el primer reply).
   */
  acceptsInboundTextAsCapture: boolean;
  error?: string;
};

export type FlowEngineContext = {
  supabase: SupabaseAdmin;
};

const CHAT_MEDIA_BUCKET = "chat-media";
let chatMediaBucketChecked = false;

function extensionFromMime(mimeType: string | null | undefined): string {
  if (!mimeType) return "jpg";
  const v = mimeType.toLowerCase();
  if (v.includes("pdf")) return "pdf";
  if (v.includes("png")) return "png";
  if (v.includes("webp")) return "webp";
  if (v.includes("gif")) return "gif";
  if (v.includes("jpeg") || v.includes("jpg")) return "jpg";
  return "jpg";
}

/** Imagen o PDF (comprobante bancario frecuente como archivo). */
function isComprobanteMimeAccepted(mimeType: string | null | undefined): boolean {
  const m = (mimeType ?? "").toLowerCase();
  if (m.startsWith("image/")) return true;
  if (m.includes("pdf")) return true;
  return false;
}

const FLOW_SORTEO_LOG = "[flow-sorteo]" as const;

function dedupeChatFlowFieldEntries(entries: [string, string][]): [string, string][] {
  const m = new Map<string, string>();
  for (const [k, v] of entries) {
    const key = k.trim();
    if (!key) continue;
    m.set(key, v);
  }
  return [...m.entries()];
}

/**
 * Tras elegir botón/lista: si no hay clave de cantidad en `chat_flow_data`, inferir desde
 * option_payload, option_value o texto del label (p. ej. "3 boletos", "1 boleta").
 */
function augmentCantidadFromInteractiveOption(
  entries: [string, string][],
  selected: FlowOption
): [string, string][] {
  const lowerKeys = new Set(entries.map(([k]) => k.trim().toLowerCase()));
  const qtyNames = ["cantidad", "cantidad_boletos", "boletos", "qty", "quantity"];
  const withCantidadSnapshot = (list: [string, string][], qty: string): [string, string][] => {
    const lk = new Set(list.map(([k]) => k.trim().toLowerCase()));
    if (lk.has("sorteo_cantidad_opcion")) return list;
    return [...list, ["sorteo_cantidad_opcion", qty]];
  };
  if (qtyNames.some((k) => lowerKeys.has(k))) {
    const entry = entries.find(([k]) => qtyNames.includes(k.trim().toLowerCase()));
    const v = entry?.[1]?.trim() ?? "";
    if (!v) return entries;
    return withCantidadSnapshot(entries, v);
  }

  const tryQty = (raw: unknown): number | null => {
    if (raw == null) return null;
    const n = Number(String(raw).trim().replace(",", "."));
    if (!Number.isFinite(n) || n < 1) return null;
    return Math.trunc(n);
  };

  const payload =
    selected.option_payload && typeof selected.option_payload === "object"
      ? (selected.option_payload as Record<string, unknown>)
      : null;

  if (payload) {
    for (const k of qtyNames) {
      const n = tryQty(payload[k]);
      if (n != null) {
        const rest = entries.filter((e) => e[0].trim().toLowerCase() !== "cantidad");
        return withCantidadSnapshot([...rest, ["cantidad", String(n)]], String(n));
      }
    }
  }

  const ov = selected.option_value?.trim() ?? "";
  if (ov) {
    const direct = tryQty(ov);
    if (direct != null) {
      return withCantidadSnapshot([...entries, ["cantidad", String(direct)]], String(direct));
    }
    const lead = ov.match(/^(\d+)/);
    if (lead) {
      const n = tryQty(lead[1]);
      if (n != null) {
        return withCantidadSnapshot([...entries, ["cantidad", String(n)]], String(n));
      }
    }
  }

  const label = selected.label?.trim() ?? "";
  const labelPatterns = [
    /^(\d+)\s*bolet/i,
    /^(\d+)\s*boleta/i,
    /^(\d+)\s*entrada/i,
    /^(\d+)\s*ticket/i,
    /(\d+)\s*bolet/i,
    /^(\d+)\b/,
  ];
  for (const re of labelPatterns) {
    const m = label.match(re);
    if (m) {
      const n = tryQty(m[1]);
      if (n != null) {
        return withCantidadSnapshot([...entries, ["cantidad", String(n)]], String(n));
      }
    }
  }

  console.warn(FLOW_SORTEO_LOG, "interactive_cantidad_no_inferida", {
    optionId: selected.id,
    label: selected.label,
    option_value: selected.option_value,
    meta_button_id: selected.meta_button_id,
  });
  return entries;
}

/**
 * Normaliza montos del option_payload y marca precio_fuente=promo cuando hay monto estructurado
 * (sin depender del texto visible del botón).
 */
function augmentSorteoPricingFromInteractiveOption(
  entries: [string, string][]
): [string, string][] {
  const lower = (k: string) => k.trim().toLowerCase();
  const montoKeys = new Set(["monto", "monto_compra", "monto_promocional", "sorteo_monto_opcion"]);
  let rawMonto: string | null = null;
  for (const [k, v] of entries) {
    if (montoKeys.has(lower(k))) {
      rawMonto = v;
      break;
    }
  }
  if (!rawMonto) return entries;
  const parsed = parseMoneyPy(rawMonto);
  if (parsed == null || parsed <= 0) return entries;
  const normalized = String(Math.round(parsed));
  const filtered = entries.filter(([k]) => !montoKeys.has(lower(k)));
  const pfEntry = filtered.find(([k]) => lower(k) === "precio_fuente");
  const pfVal = pfEntry ? String(pfEntry[1]).toLowerCase().trim() : "";
  const withMonto: [string, string][] = [...filtered, ["monto", normalized]];
  let out: [string, string][];
  if (!pfEntry) {
    out = [...withMonto, ["precio_fuente", "promo"]];
  } else {
    out = withMonto;
  }
  if (!pfEntry || pfVal === "promo") {
    out = [
      ...out,
      ["monto_compra", normalized],
      ["monto_promocional", normalized],
      ["sorteo_monto_opcion", normalized],
    ];
  }
  return out;
}

export function createFlowEngine(ctx: FlowEngineContext) {
  const supabase = ctx.supabase;

  async function getConversationFlowState(
    conversationId: string
  ): Promise<ConversationFlowState | null> {
    const { data, error } = await supabase
      .from("chat_conversations")
      .select(
        "id, empresa_id, channel_id, contact_id, flow_code, flow_current_node, flow_status, human_taken_over, active_flow_session_id"
      )
      .eq("id", conversationId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    const state = data as ConversationFlowState;
    if (state.flow_code?.trim()) {
      const sid = await ensureActiveFlowSessionForConversation(
        supabase,
        state.empresa_id,
        conversationId,
        state.flow_code
      );
      if (sid) state.active_flow_session_id = sid;
    }
    return state;
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
    flowSessionId?: string | null;
  }) {
    let sid = input.flowSessionId?.trim() || null;
    if (!sid) {
      const { data: crow } = await supabase
        .from("chat_conversations")
        .select("active_flow_session_id")
        .eq("id", input.conversationId)
        .eq("empresa_id", input.empresaId)
        .maybeSingle();
      sid = (crow as { active_flow_session_id?: string | null } | null)?.active_flow_session_id?.trim() || null;
    }
    const { error } = await supabase.from("chat_flow_events").insert({
      empresa_id: input.empresaId,
      conversation_id: input.conversationId,
      flow_code: input.flowCode ?? null,
      node_code: input.nodeCode ?? null,
      event_type: input.eventType,
      selected_option_id: input.selectedOptionId ?? null,
      meta_button_id: input.metaButtonId ?? null,
      payload: input.payload ?? {},
      flow_session_id: sid,
    });
    if (error) {
      console.error("[flow-engine] event insert:", error.message);
    }
  }

  type FlowSendContext =
    | {
        conversation: ConversationFlowState;
        provider: "meta";
        toDigits: string;
        phoneNumberId: string;
        token: string;
      }
    | {
        conversation: ConversationFlowState;
        provider: "ycloud";
        toDigits: string;
        ycloudApiKey: string;
        ycloudFromE164: string;
      };

  async function getConversationSendContext(conversationId: string): Promise<FlowSendContext> {
    const conversation = await getConversationFlowState(conversationId);
    if (!conversation) throw new Error("Conversación no encontrada");

    const ds = await fetchDataSchemaForEmpresaId(conversation.empresa_id);
    const outbound = await resolveOutboundTextContextFromIds(
      supabase,
      {
        contactId: conversation.contact_id,
        channelId: conversation.channel_id,
      },
      { dataSchema: ds }
    );

    if (outbound.provider === "meta") {
      return {
        conversation,
        provider: "meta",
        toDigits: outbound.toDigits,
        phoneNumberId: outbound.phoneNumberId,
        token: outbound.accessToken,
      };
    }
    return {
      conversation,
      provider: "ycloud",
      toDigits: outbound.toDigits,
      ycloudApiKey: outbound.apiKey,
      ycloudFromE164: outbound.fromE164,
    };
  }

  async function flowSendText(ctx: FlowSendContext, text: string) {
    const slice =
      ctx.provider === "meta"
        ? {
            provider: "meta" as const,
            toDigits: ctx.toDigits,
            phoneNumberId: ctx.phoneNumberId,
            accessToken: ctx.token,
          }
        : {
            provider: "ycloud" as const,
            toDigits: ctx.toDigits,
            apiKey: ctx.ycloudApiKey,
            fromE164: ctx.ycloudFromE164,
          };
    return sendOutboundTextMessage(slice, text);
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
    return downloadMetaMediaBytes(params);
  }

  async function isFlowDefinitionActive(empresaId: string, flowCode: string): Promise<boolean> {
    const { data, error } = await supabase
      .from("chat_flows")
      .select("activo")
      .eq("empresa_id", empresaId)
      .eq("flow_code", flowCode)
      .maybeSingle();
    if (error) {
      console.warn("[flow-engine] isFlowDefinitionActive:", error.message);
      return true;
    }
    if (!data) return true;
    return (data as { activo?: boolean }).activo !== false;
  }

  async function wasNodeSentForCurrentStep(
    conversationId: string,
    flowCode: string,
    nodeCode: string,
    flowSessionId: string | null | undefined
  ): Promise<boolean> {
    const sid = flowSessionId?.trim();
    if (!sid) {
      console.warn("[flow-engine] wasNodeSentForCurrentStep: no flow_session_id, assume not sent", {
        conversationId,
        flowCode,
        nodeCode,
      });
      return false;
    }
    const { data, error } = await supabase
      .from("chat_flow_events")
      .select("id")
      .eq("conversation_id", conversationId)
      .eq("flow_code", flowCode)
      .eq("flow_session_id", sid)
      .eq("node_code", nodeCode)
      .eq("event_type", "node_sent")
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error("[flow-engine] wasNodeSentForCurrentStep:", error.message);
      return false;
    }
    return Boolean((data as { id?: string } | null)?.id);
  }

  /**
   * Tras un mensaje entrante del cliente: si el nodo actual aún no se envió (botones/texto/media, etc.),
   * ejecuta sendCurrentFlowNode. Sin esto, processTextReply ignora textos cuando el nodo no es captura.
   */
  async function ensureCurrentNodePresentedAfterInbound(
    params: EnsureInboundPresentParams
  ): Promise<EnsureInboundPresentResult> {
    const logPrefix = "[flow-engine][inbound-present]";
    try {
      const state = await getConversationFlowState(params.conversationId);
      if (!state || state.empresa_id !== params.empresaId) {
        console.info(logPrefix, "skip: conversation_not_found", {
          conversationId: params.conversationId,
        });
        return {
          ok: true,
          status: "conversation_not_found",
          presentedNow: false,
          acceptsInboundTextAsCapture: false,
        };
      }
      if (state.flow_status !== "bot" || state.human_taken_over) {
        console.info(logPrefix, "skip: not_bot_mode", {
          conversationId: state.id,
          flow_status: state.flow_status,
          human_taken_over: state.human_taken_over,
        });
        return {
          ok: true,
          status: "skipped_not_bot_mode",
          presentedNow: false,
          acceptsInboundTextAsCapture: false,
        };
      }
      if (!state.flow_code?.trim() || !state.flow_current_node?.trim()) {
        console.info(logPrefix, "skip: missing_flow_pointer", {
          conversationId: state.id,
          flow_code: state.flow_code,
          flow_current_node: state.flow_current_node,
        });
        return {
          ok: true,
          status: "missing_flow_state",
          presentedNow: false,
          acceptsInboundTextAsCapture: false,
        };
      }

      flowTrace("inbound_present_engine_state", {
        conversation_id: state.id,
        empresa_id: state.empresa_id,
        active_flow_session_id: state.active_flow_session_id ?? null,
        flow_current_node: state.flow_current_node,
        flow_code: state.flow_code,
        event: "ensure_current_node_presented",
      });

      const flowCode = state.flow_code as string;
      const nodeCode = state.flow_current_node as string;

      const flowActive = await isFlowDefinitionActive(state.empresa_id, flowCode);
      if (!flowActive) {
        console.warn(logPrefix, "skip: flow_inactive_in_catalog", { flowCode, conversationId: state.id });
        await insertFlowEvent({
          empresaId: state.empresa_id,
          conversationId: state.id,
          flowCode,
          nodeCode,
          flowSessionId: state.active_flow_session_id,
          eventType: "automation_skipped_flow_inactive",
          payload: {},
        });
        return {
          ok: true,
          status: "flow_inactive",
          presentedNow: false,
          acceptsInboundTextAsCapture: false,
        };
      }

      const already = await wasNodeSentForCurrentStep(
        state.id,
        flowCode,
        nodeCode,
        state.active_flow_session_id
      );
      if (already) {
        console.info(logPrefix, "skip: node_already_sent", {
          conversationId: state.id,
          flowCode,
          nodeCode,
        });
        return {
          ok: true,
          status: "already_presented",
          presentedNow: false,
          acceptsInboundTextAsCapture: false,
        };
      }

      console.info(logPrefix, "trigger: sending_current_node", {
        conversationId: state.id,
        empresaId: state.empresa_id,
        flowCode,
        nodeCode,
      });

      const sent = await sendCurrentFlowNode({ conversationId: state.id });
      if (!sent.ok) {
        console.error(logPrefix, "send_failed", { conversationId: state.id, error: sent.error });
        await insertFlowEvent({
          empresaId: state.empresa_id,
          conversationId: state.id,
          flowCode,
          nodeCode,
          flowSessionId: state.active_flow_session_id,
          eventType: "present_failed",
          payload: { error: sent.error ?? "unknown" },
        });
        return {
          ok: false,
          status: "send_failed",
          presentedNow: false,
          acceptsInboundTextAsCapture: false,
          error: sent.error,
        };
      }

      const presentedNodeCode = sent.nodeCode ?? nodeCode;
      const presentedNode = await getNode(state.empresa_id, flowCode.trim(), presentedNodeCode);
      const acceptsInboundTextAsCapture = Boolean(
        presentedNode?.node_type === "text" && presentedNode.save_as_field?.trim()
      );

      console.info(logPrefix, "ok: node_presented", {
        conversationId: state.id,
        nodeCode: presentedNodeCode,
        acceptsInboundTextAsCapture,
      });
      return {
        ok: true,
        status: "presented",
        presentedNow: true,
        acceptsInboundTextAsCapture,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(logPrefix, "exception", msg);
      return {
        ok: false,
        status: "exception",
        presentedNow: false,
        acceptsInboundTextAsCapture: false,
        error: msg,
      };
    }
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
    flowSessionId: string | null | undefined;
    traceReadContext?: string;
  }): Promise<Record<string, string>> {
    const fc = input.flowCode?.trim();
    const sid = input.flowSessionId?.trim();
    if (!fc || !sid) {
      flowTrace("flow_data_read", {
        conversation_id: input.conversationId,
        empresa_id: input.empresaId,
        flow_code: fc ?? null,
        flow_session_id_read: sid ?? null,
        read_context: input.traceReadContext ?? "unspecified",
        empty_reason: !fc ? "missing_flow_code" : "missing_flow_session_id",
        field_count: 0,
      });
      return {};
    }
    const { data, error } = await supabase
      .from("chat_flow_data")
      .select("field_name, field_value")
      .eq("empresa_id", input.empresaId)
      .eq("conversation_id", input.conversationId)
      .eq("flow_code", fc)
      .eq("flow_session_id", sid);
    if (error) throw new Error(error.message);
    const out: Record<string, string> = {};
    for (const row of data ?? []) {
      const key = String((row as { field_name?: unknown }).field_name ?? "").trim();
      if (!key) continue;
      out[key] = String((row as { field_value?: unknown }).field_value ?? "");
    }
    const sum = summarizeFlowDataForTrace(out);
    flowTrace("flow_data_read", {
      conversation_id: input.conversationId,
      empresa_id: input.empresaId,
      flow_code: fc,
      flow_session_id_read: sid,
      read_context: input.traceReadContext ?? "unspecified",
      field_count: Object.keys(out).length,
      flow_data_keys: sum.keys,
      flow_data_samples: sum.samples ?? null,
    });
    return out;
  }

  function opcionTitleFromRawMeta(payload: Record<string, unknown>): string | null {
    const raw = payload.raw;
    if (!raw || typeof raw !== "object") return null;
    const interactive = (raw as Record<string, unknown>).interactive;
    if (!interactive || typeof interactive !== "object") return null;
    const br = (interactive as Record<string, unknown>).button_reply;
    const lr = (interactive as Record<string, unknown>).list_reply;
    const fromBr =
      br && typeof br === "object" && typeof (br as Record<string, unknown>).title === "string"
        ? String((br as Record<string, unknown>).title).trim()
        : "";
    const fromLr =
      lr && typeof lr === "object" && typeof (lr as Record<string, unknown>).title === "string"
        ? String((lr as Record<string, unknown>).title).trim()
        : "";
    const title = fromBr || fromLr;
    return title || null;
  }

  /**
   * Reconstruye variables del flujo desde `chat_flow_events` tras un reinicio o si `chat_flow_data`
   * quedó vacío: textos capturados y payloads de botones/listas quedan auditados ahí.
   */
  async function hydrateFlowDataFromSessionEvents(
    conversationId: string,
    flowCode: string,
    base: Record<string, string>,
    flowSessionId: string | null | undefined
  ): Promise<Record<string, string>> {
    const fc = flowCode.trim();
    const sid = flowSessionId?.trim();
    if (!fc || !sid) return base;

    const { data: rows, error } = await supabase
      .from("chat_flow_events")
      .select("event_type, payload, created_at")
      .eq("conversation_id", conversationId)
      .eq("flow_code", fc)
      .eq("flow_session_id", sid)
      .in("event_type", ["text_captured", "button_selected"])
      .order("created_at", { ascending: true });
    if (error) {
      console.warn(FLOW_SORTEO_LOG, "hydrate_events_failed", { message: error.message });
      return base;
    }

    const merged: Record<string, string> = { ...base };
    const slotEmpty = (key: string) => !String(merged[key] ?? "").trim();
    for (const row of rows ?? []) {
      const et = String((row as { event_type?: string }).event_type ?? "");
      const payload = ((row as { payload?: Record<string, unknown> }).payload ?? {}) as Record<
        string,
        unknown
      >;
      if (et === "text_captured") {
        const field = typeof payload.save_as_field === "string" ? payload.save_as_field.trim() : "";
        const tv = typeof payload.text_value === "string" ? payload.text_value.trim() : "";
        if (field && tv && slotEmpty(field)) merged[field] = tv;
      } else if (et === "button_selected") {
        const op = payload.option_payload;
        if (op && typeof op === "object" && !Array.isArray(op)) {
          for (const [k, v] of Object.entries(op as Record<string, unknown>)) {
            const kn = k.trim();
            if (!kn) continue;
            const sv =
              typeof v === "string" || typeof v === "number" || typeof v === "boolean"
                ? String(v)
                : "";
            if (sv && slotEmpty(kn)) merged[kn] = sv;
          }
        }
        const ov = typeof payload.option_value === "string" ? payload.option_value.trim() : "";
        if (ov && slotEmpty("option_value")) merged["option_value"] = ov;
        const ol =
          (typeof payload.option_label === "string" ? payload.option_label.trim() : "") ||
          opcionTitleFromRawMeta(payload) ||
          "";
        if (ol && slotEmpty("opcion_label")) merged["opcion_label"] = ol;
      }
    }
    if ((rows?.length ?? 0) > 0) {
      console.info(FLOW_SORTEO_LOG, "hydrate_flow_data_applied", {
        conversationId,
        flowCode: fc,
        flowSessionId: sid,
        eventCount: rows?.length ?? 0,
        keysAfter: Object.keys(merged).length,
      });
    }
    const sumM = summarizeFlowDataForTrace(merged);
    flowTrace("flow_data_after_event_hydrate", {
      conversation_id: conversationId,
      flow_code: fc,
      flow_session_id: sid,
      event: "resumen_vars_from_events",
      event_count: rows?.length ?? 0,
      flow_data_keys: sumM.keys,
      flow_data_samples: sumM.samples ?? null,
    });
    return merged;
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

  async function buildImageInputReminderText(
    node: FlowNode,
    conversationId: string,
    reason: "expected_image_got_text" | "expected_image_got_non_image"
  ): Promise<string> {
    const st = await getConversationFlowState(conversationId);
    const flowVars = await getConversationFlowDataMap({
      empresaId: node.empresa_id,
      conversationId,
      flowCode: node.flow_code,
      flowSessionId: st?.active_flow_session_id ?? null,
      traceReadContext: "image_input_reminder_text",
    });
    const base = interpolateTemplate(node.message_text?.trim() || "", flowVars).trim();
    const tail =
      reason === "expected_image_got_text"
        ? "Por favor enviá el comprobante como imagen (foto o captura), no como mensaje de texto."
        : "Ese formato no sirve como comprobante. Enviá foto (JPG/PNG), imagen como archivo o PDF del comprobante.";
    if (base) return `${base}\n\n${tail}`;
    return tail;
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

  /**
   * Tras enviar un nodo saliente: si hay siguiente paso y el nodo no espera input del cliente,
   * avanza la conversación y ejecuta sendCurrentFlowNode recursivamente (máx. __autoHop).
   * Importante: la rama legacy (sin bloques) debe usar la misma lógica que la rama con bloques.
   */
  async function autoChainOutboundIfApplicable(
    state: ConversationFlowState,
    node: FlowNode,
    currentHop: number,
    mergeFlowVars?: Record<string, string>
  ): Promise<{ ok: boolean; nodeCode?: string; error?: string } | null> {
    const canAutoAdvance =
      Boolean(node.next_node_code) &&
      !["buttons", "list", "image_input", "human", "end"].includes(node.node_type) &&
      !(node.node_type === "text" && Boolean(node.save_as_field?.trim()));
    if (!canAutoAdvance || !node.next_node_code || !state.flow_code) return null;

    console.info("[flow-engine] auto_chain_after_outbound", {
      conversationId: state.id,
      fromNode: node.node_code,
      nextNodeCode: node.next_node_code,
      node_type: node.node_type,
      save_as_field: node.save_as_field ?? null,
      carriesMergeFlowVars: Boolean(mergeFlowVars && Object.keys(mergeFlowVars).length),
    });

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
      flowSessionId: state.active_flow_session_id,
      eventType: "node_advanced",
      payload: {
        from_node: node.node_code,
        next_node_code: node.next_node_code,
        reason: "auto_chain_after_outbound",
      },
    });
    return sendCurrentFlowNode({
      conversationId: state.id,
      __autoHop: currentHop + 1,
      mergeFlowVars,
    });
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
    if (!state.active_flow_session_id?.trim()) {
      return {
        ok: false,
        error: "Sesión de flujo no inicializada; escribí hola para reiniciar.",
      };
    }

    const node = await getNode(state.empresa_id, state.flow_code, state.flow_current_node);
    if (!node) return { ok: false, error: "Nodo actual no encontrado" };

    const flowVarsBase = await getConversationFlowDataMap({
      empresaId: state.empresa_id,
      conversationId: state.id,
      flowCode: state.flow_code,
      flowSessionId: state.active_flow_session_id,
      traceReadContext: "send_current_node_confirmacion_resumen",
    });
    const flowVars = { ...flowVarsBase, ...(params.mergeFlowVars ?? {}) };
    const sumV = summarizeFlowDataForTrace(flowVars);
    flowTrace("send_node_interpolate", {
      conversation_id: state.id,
      empresa_id: state.empresa_id,
      flow_code: state.flow_code,
      flow_current_node: state.flow_current_node,
      active_flow_session_id: state.active_flow_session_id ?? null,
      flow_session_id_used_for_vars: state.active_flow_session_id ?? null,
      event: "confirmacion_o_resumen_mensaje",
      merge_flow_var_keys: params.mergeFlowVars ? Object.keys(params.mergeFlowVars).sort() : [],
      flow_data_keys: sumV.keys,
      flow_data_samples: sumV.samples ?? null,
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
        if (ctxSend.provider !== "meta") {
          return {
            ok: false,
            error: ycloudOutboundUnsupportedMessage("botones interactivos"),
          };
        }
        const options = await getNodeOptions(node.id);
        console.info("[flow-options]", "buttons_legacy_no_blocks", {
          conversation_id: state.id,
          node_code: node.node_code,
          resolved_titles: options.map((o) => ({
            meta_button_id: o.meta_button_id,
            title: whatsAppInteractiveTitleFromOption(o),
          })),
        });
        const send = await sendWhatsAppInteractiveButtons({
          toDigits: ctxSend.toDigits,
          phoneNumberId: ctxSend.phoneNumberId,
          accessToken: ctxSend.token,
          bodyText,
          buttons: options.map((o) => ({
            id: o.meta_button_id,
            title: whatsAppInteractiveTitleFromOption(o),
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
        if (ctxSend.provider !== "meta") {
          return {
            ok: false,
            error: ycloudOutboundUnsupportedMessage("imagen"),
          };
        }
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
        if (!send.ok) {
          console.warn("[flow-send]", "whatsapp_image_failed_legacy_media_node", {
            conversationId: state.id,
            node_code: node.node_code,
            error: send.error,
          });
          return { ok: false, error: send.error };
        }

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
        const send = await flowSendText(ctxSend, bodyText);
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
        flowSessionId: state.active_flow_session_id,
        eventType: "node_sent",
        payload: { ...basePayload, legacy: true },
      });

      const chainedLegacy = await autoChainOutboundIfApplicable(
        state,
        node,
        currentHop,
        params.mergeFlowVars
      );
      if (chainedLegacy) return chainedLegacy;
      return { ok: true, nodeCode: node.node_code };
    }

    const options = await getNodeOptions(node.id);
    console.info("[flow-options]", "buttons_with_blocks_context", {
      conversation_id: state.id,
      node_code: node.node_code,
      block_count: blocks.length,
      resolved_titles: options.map((o) => ({
        meta_button_id: o.meta_button_id,
        title: whatsAppInteractiveTitleFromOption(o),
      })),
    });
    for (const block of blocks) {
      if (block.block_type === "text") {
        const textRaw = block.content_text?.trim();
        const text = textRaw ? interpolateTemplate(textRaw, flowVars) : "";
        if (!text) continue;
        const send = await flowSendText(ctxSend, text);
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
        if (ctxSend.provider !== "meta") {
          return { ok: false, error: ycloudOutboundUnsupportedMessage("imagen") };
        }
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
        if (!send.ok) {
          console.warn("[flow-send]", "whatsapp_image_failed_block", {
            conversationId: state.id,
            node_code: node.node_code,
            error: send.error,
            imageUrlPreview: imageUrl.slice(0, 96),
          });
          return { ok: false, error: send.error };
        }
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
        if (ctxSend.provider !== "meta") {
          return { ok: false, error: ycloudOutboundUnsupportedMessage("botones interactivos") };
        }
        const bodyTextRaw = block.content_text?.trim() || fallbackText;
        const bodyText = interpolateTemplate(bodyTextRaw, flowVars);
        const send = await sendWhatsAppInteractiveButtons({
          toDigits: ctxSend.toDigits,
          phoneNumberId: ctxSend.phoneNumberId,
          accessToken: ctxSend.token,
          bodyText,
          buttons: options.map((o) => ({
            id: o.meta_button_id,
            title: whatsAppInteractiveTitleFromOption(o),
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
      flowSessionId: state.active_flow_session_id,
      eventType: "node_sent",
      payload: { ...basePayload, blocks: blocks.length },
    });

    const chained = await autoChainOutboundIfApplicable(
      state,
      node,
      currentHop,
      params.mergeFlowVars
    );
    if (chained) return chained;
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
        flowSessionId: state.active_flow_session_id,
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
        flowSessionId: state.active_flow_session_id,
        eventType: "invalid_button",
        metaButtonId: params.metaButtonId,
        payload: { reason: "missing_flow_state", raw: params.rawPayload },
      });
      return { ok: true, status: "missing_flow_state" };
    }

    const currentNodePre = await getNode(
      state.empresa_id,
      state.flow_code,
      state.flow_current_node
    );
    if (
      currentNodePre?.node_type === "image_input" &&
      (params.metaButtonId === COMPROBANTE_BUTTON_IDS.enviar_otro ||
        params.metaButtonId === COMPROBANTE_BUTTON_IDS.hablar_asesor)
    ) {
      const sendCtxCv = await getConversationSendContext(state.id);
      const { data: chCfg } = await supabase
        .from("chat_channels")
        .select("config")
        .eq("id", state.channel_id)
        .maybeSingle();
      const cvMsgs = parseComprobanteValidationConfig(chCfg?.config).messages;
      if (params.metaButtonId === COMPROBANTE_BUTTON_IDS.enviar_otro) {
        const hint =
          "Podés enviar otro comprobante ahora como imagen o PDF en este mismo chat.";
        const send = await flowSendText(sendCtxCv, hint);
        if (send.ok) {
          await persistOutgoingMessage({
            conversation: state,
            content: hint,
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
          nodeCode: state.flow_current_node,
          flowSessionId: state.active_flow_session_id,
          eventType: "comprobante_validation_retry",
          metaButtonId: params.metaButtonId,
          payload: { raw: params.rawPayload },
        });
        return { ok: true, status: "comprobante_retry_hint" };
      }
      await supabase
        .from("chat_conversations")
        .update({
          flow_status: "human",
          human_taken_over: true,
          updated_at: new Date().toISOString(),
        })
        .eq("id", state.id);
      const handoff =
        "Te derivamos con un asesor humano. En breve te vamos a escribir desde este mismo número.";
      const sendH = await flowSendText(sendCtxCv, handoff);
      if (sendH.ok) {
        await persistOutgoingMessage({
          conversation: state,
          content: handoff,
          messageType: "text",
          waMessageId: sendH.waMessageId,
          raw: sendH.raw,
          senderType: "system",
          automationSource: "flow_engine",
        });
      }
      await insertFlowEvent({
        empresaId: state.empresa_id,
        conversationId: state.id,
        flowCode: state.flow_code,
        nodeCode: state.flow_current_node,
        flowSessionId: state.active_flow_session_id,
        eventType: "comprobante_validation_asesor",
        metaButtonId: params.metaButtonId,
        payload: { raw: params.rawPayload, message_template: cvMsgs.revision_manual },
      });
      return { ok: true, status: "comprobante_asesor_handoff" };
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
        flowSessionId: state.active_flow_session_id,
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
        flowSessionId: state.active_flow_session_id,
        eventType: "invalid_button",
        metaButtonId: params.metaButtonId,
        payload: { reason: "option_not_found_in_node", raw: params.rawPayload },
      });
      return { ok: true, status: "invalid_button" };
    }

    const flowSidInteractive = state.active_flow_session_id?.trim();
    if (!flowSidInteractive) {
      return {
        ok: false,
        status: "missing_flow_session",
        error: "Sesión de flujo no inicializada; escribí hola para reiniciar.",
      };
    }

    await insertFlowEvent({
      empresaId: state.empresa_id,
      conversationId: state.id,
      flowCode: state.flow_code,
      nodeCode: currentNode.node_code,
      flowSessionId: flowSidInteractive,
      eventType: "button_selected",
      selectedOptionId: selected.id,
      metaButtonId: params.metaButtonId,
      payload: {
        option_value: selected.option_value,
        option_label: selected.label,
        option_payload: selected.option_payload ?? {},
        raw: params.rawPayload,
      },
    });

    const sorteoLinked = await getSorteoIdForChatFlow(
      supabase,
      state.empresa_id,
      state.flow_code as string
    );
    /** Cierre de compra sorteo: no escribir en chat_flow_data ni re-ejecutar contrato comercial (evita pisar snapshots con el label del botón, ej. "Confirmado"). */
    const isSorteoFinalizeClick =
      Boolean(sorteoLinked) && optionPayloadFinalizesSorteoOrder(selected.option_payload);

    const optionPayload =
      selected.option_payload && typeof selected.option_payload === "object"
        ? selected.option_payload
        : {};
    let payloadEntries: [string, string][] = [];

    if (!isSorteoFinalizeClick) {
      payloadEntries = Object.entries(optionPayload)
        .filter(([key]) => key.trim().length > 0)
        .map(([k, v]) => [
          k,
          typeof v === "string" || typeof v === "number" || typeof v === "boolean"
            ? String(v)
            : JSON.stringify(v ?? ""),
        ]);
      if (!payloadEntries.some(([k]) => k === "opcion_label")) {
        payloadEntries.push(["opcion_label", selected.label]);
      }
      payloadEntries = augmentCantidadFromInteractiveOption(payloadEntries, selected);
      payloadEntries = augmentSorteoPricingFromInteractiveOption(payloadEntries);
      payloadEntries = dedupeChatFlowFieldEntries(payloadEntries);
      payloadEntries = applySorteoInteractiveCommercialContract(payloadEntries, {
        label: selected.label,
        option_value: selected.option_value,
        option_payload: selected.option_payload,
      });
    }

    if (payloadEntries.length > 0 && state.flow_code) {
      const upserts = payloadEntries.map(([fieldName, fieldValue]) => ({
        empresa_id: state.empresa_id,
        conversation_id: state.id,
        flow_code: state.flow_code as string,
        flow_session_id: flowSidInteractive,
        field_name: fieldName.trim(),
        field_value:
          typeof fieldValue === "string" || typeof fieldValue === "number" || typeof fieldValue === "boolean"
            ? String(fieldValue)
            : JSON.stringify(fieldValue ?? ""),
      }));
      const { error: payloadSaveErr } = await supabase
        .from("chat_flow_data")
        .upsert(upserts, { onConflict: "flow_session_id,field_name" });
      if (payloadSaveErr) {
        return { ok: false, status: "save_option_payload_failed", error: payloadSaveErr.message };
      }
      flowTrace("flow_data_write", {
        conversation_id: state.id,
        empresa_id: state.empresa_id,
        flow_code: state.flow_code,
        flow_session_id_write: flowSidInteractive,
        node_code: currentNode.node_code,
        event: "interactive_option_payload",
        field_names: payloadEntries.map(([k]) => k.trim()).filter(Boolean),
      });
    }

    let sorteoOrderMerge: Record<string, string> | undefined;
    const wantsSorteoFinalize = isSorteoFinalizeClick;

    if (wantsSorteoFinalize) {
      const rawFd = await getConversationFlowDataMap({
        empresaId: state.empresa_id,
        conversationId: state.id,
        flowCode: state.flow_code,
        flowSessionId: flowSidInteractive,
        traceReadContext: "before_finalize_sorteo_on_confirm",
      });
      const hydFd = await hydrateFlowDataFromSessionEvents(
        state.id,
        state.flow_code as string,
        rawFd,
        flowSidInteractive
      );
      const sendCtxFin = await getConversationSendContext(state.id);
      const fin = await finalizeSorteoOrderFromConfirmedFlowData(supabase, {
        empresaId: state.empresa_id,
        conversationId: state.id,
        flowCode: state.flow_code as string,
        flowSessionId: flowSidInteractive,
        whatsappNumero: sendCtxFin.toDigits,
        flowData: hydFd,
      });

      const notifyFinalizeError = async (text: string) => {
        const send = await flowSendText(sendCtxFin, text);
        if (send.ok) {
          await persistOutgoingMessage({
            conversation: state,
            content: text,
            messageType: "text",
            waMessageId: send.waMessageId,
            raw: send.raw,
            senderType: "system",
            automationSource: "flow_engine",
          });
        }
      };

      if (!fin.ok) {
        await notifyFinalizeError(fin.message);
        return { ok: false, status: "sorteo_finalize_failed", error: fin.message };
      }
      if (fin.skipped) {
        let detail: string;
        if (fin.reason === "sin_comprobante_en_sesion") {
          detail =
            "No encontramos el comprobante de esta compra. Enviá la imagen del comprobante y volvé a confirmar.";
        } else if (fin.reason === "flow_sin_sorteo_id") {
          detail = "Este flujo no está vinculado a un sorteo.";
        } else if (fin.reason === "datos_flujo_incompletos") {
          detail = await getSorteoDatosIncompletosMessage(
            supabase,
            state.empresa_id,
            state.flow_code as string
          );
        } else if (fin.reason === "comprobante_no_validado") {
          detail = await mensajeClienteComprobanteNoValido(
            supabase,
            state.id,
            typeof fin.comprobanteEstado === "string" ? fin.comprobanteEstado : ""
          );
        } else {
          detail = await getSorteoDatosIncompletosMessage(
            supabase,
            state.empresa_id,
            state.flow_code as string
          );
        }
        await notifyFinalizeError(detail);
        return { ok: false, status: "sorteo_finalize_skipped", error: detail };
      }

      sorteoOrderMerge = buildSorteoOrderFlowVarOverrides(fin);
      const ctxRows = buildChatFlowDataUpsertsForSorteoOrder(
        state.empresa_id,
        state.id,
        state.flow_code as string,
        flowSidInteractive,
        fin
      );
      const { error: ctxErr } = await supabase
        .from("chat_flow_data")
        .upsert(ctxRows, { onConflict: "flow_session_id,field_name" });
      if (ctxErr) {
        await notifyFinalizeError("No se pudo guardar el resultado de la compra. Intentá confirmar de nuevo.");
        return { ok: false, status: "sorteo_context_after_finalize_failed", error: ctxErr.message };
      }
      await insertFlowEvent({
        empresaId: state.empresa_id,
        conversationId: state.id,
        flowCode: state.flow_code,
        nodeCode: currentNode.node_code,
        flowSessionId: flowSidInteractive,
        eventType: "sorteo_order_ensured",
        selectedOptionId: selected.id,
        metaButtonId: params.metaButtonId,
        payload: {
          idempotent: fin.idempotent,
          entrada_id: fin.entradaId,
          numero_orden: fin.numeroOrden,
          cantidad_boletos: fin.cantidadBoletos,
          monto_total: fin.montoTotal,
          precio_fuente: fin.precioFuente,
          promo_nombre: fin.promoNombre,
          sorteo_id: fin.sorteoId,
          sorteo_nombre: fin.sorteoNombre,
          cupones: fin.cupones.map((c) => c.numero_cupon),
          trigger: "confirmacion_final",
        },
      });
    }

    if (!selected.next_node_code) {
      await insertFlowEvent({
        empresaId: state.empresa_id,
        conversationId: state.id,
        flowCode: state.flow_code,
        nodeCode: currentNode.node_code,
        flowSessionId: flowSidInteractive,
        eventType: "node_advanced",
        selectedOptionId: selected.id,
        metaButtonId: params.metaButtonId,
        payload: { next_node_code: null },
      });
      if (sorteoOrderMerge && Object.keys(sorteoOrderMerge).length > 0) {
        const sendCtxEnd = await getConversationSendContext(state.id);
        const no = sorteoOrderMerge.numero_orden ?? "";
        const cup = sorteoOrderMerge.numeros_cupon ?? "";
        const summary = `Listo. Tu orden Nº ${no}. Cupones: ${cup}.`;
        const sendSum = await flowSendText(sendCtxEnd, summary);
        if (sendSum.ok) {
          await persistOutgoingMessage({
            conversation: state,
            content: summary,
            messageType: "text",
            waMessageId: sendSum.waMessageId,
            raw: sendSum.raw,
            senderType: "system",
            automationSource: "flow_engine",
          });
        }
      }
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
      flowSessionId: flowSidInteractive,
      eventType: "node_advanced",
      selectedOptionId: selected.id,
      metaButtonId: params.metaButtonId,
      payload: { from_node: currentNode.node_code, next_node_code: selected.next_node_code },
    });

    const sent = await sendCurrentFlowNode({
      conversationId: state.id,
      ...(sorteoOrderMerge ? { mergeFlowVars: sorteoOrderMerge } : {}),
    });
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
      const reminder = await buildImageInputReminderText(
        currentNode,
        state.id,
        "expected_image_got_text"
      );
      const send = await flowSendText(sendCtx, reminder);
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
        flowSessionId: state.active_flow_session_id,
        eventType: "image_expected_text_received",
        payload: { text_value: textValue, raw: params.rawPayload },
      });
      return { ok: true, status: "image_expected_text_received" };
    }
    if (currentNode.node_type !== "text" || !currentNode.save_as_field?.trim()) {
      return { ok: true, status: "ignored_not_text_node" };
    }

    const textFlowSid = state.active_flow_session_id?.trim();
    if (!textFlowSid) {
      return {
        ok: false,
        status: "missing_flow_session",
        error: "Sesión de flujo no inicializada; reiniciá el chat o escribí hola.",
      };
    }

    if (currentNode.save_as_field) {
      const { error: dataErr } = await supabase
        .from("chat_flow_data")
        .upsert(
          {
            empresa_id: state.empresa_id,
            conversation_id: state.id,
            flow_code: state.flow_code,
            flow_session_id: textFlowSid,
            field_name: currentNode.save_as_field,
            field_value: textValue,
          },
          { onConflict: "flow_session_id,field_name" }
        );
      if (dataErr) {
        return { ok: false, status: "save_text_failed", error: dataErr.message };
      }
      flowTrace("flow_data_write", {
        conversation_id: state.id,
        empresa_id: state.empresa_id,
        flow_code: state.flow_code,
        flow_session_id_write: textFlowSid,
        node_code: currentNode.node_code,
        event: "text_captured",
        field_name: currentNode.save_as_field ?? null,
        field_value_len: textValue.length,
      });
      const sfLower = currentNode.save_as_field.trim().toLowerCase();
      if (["nombre", "apellido", "nombre_y_apellido"].includes(sfLower)) {
        const { error: clrErr } = await supabase.from("chat_flow_data").upsert(
          {
            empresa_id: state.empresa_id,
            conversation_id: state.id,
            flow_code: state.flow_code,
            flow_session_id: textFlowSid,
            field_name: "nombre_completo",
            field_value: "",
          },
          { onConflict: "flow_session_id,field_name" }
        );
        if (clrErr) {
          console.warn(FLOW_SORTEO_LOG, "clear_stale_nombre_completo_failed", {
            conversationId: state.id,
            message: clrErr.message,
          });
        }
      }
    }

    await insertFlowEvent({
      empresaId: state.empresa_id,
      conversationId: state.id,
      flowCode: state.flow_code,
      nodeCode: currentNode.node_code,
      flowSessionId: textFlowSid,
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
      flowSessionId: textFlowSid,
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
    console.info(FLOW_SORTEO_LOG, "processImageReply_enter", {
      conversationId: params.conversationId,
      empresaId: params.empresaId,
      mediaId: params.mediaId,
    });
    const state = await getConversationFlowState(params.conversationId);
    if (!state || state.empresa_id !== params.empresaId) {
      console.warn(FLOW_SORTEO_LOG, "processImageReply_early_exit", {
        status: "conversation_not_found",
        archivo: "src/lib/chat/flow-engine-service.ts",
        lineApprox: 1154,
        condicion: "!state || state.empresa_id !== params.empresaId",
        conversationId: params.conversationId,
        ensureSorteoOrderFromChat: "no_llamado",
      });
      return { ok: false, status: "conversation_not_found", error: "Conversación no encontrada" };
    }
    if (state.flow_status !== "bot" || state.human_taken_over) {
      console.info(FLOW_SORTEO_LOG, "processImageReply_early_exit", {
        status: "ignored_not_bot_mode",
        archivo: "src/lib/chat/flow-engine-service.ts",
        lineApprox: 1167,
        condicion: "flow_status !== 'bot' || human_taken_over",
        conversationId: state.id,
        flow_status: state.flow_status,
        human_taken_over: state.human_taken_over,
        ensureSorteoOrderFromChat: "no_llamado",
      });
      return { ok: true, status: "ignored_not_bot_mode" };
    }
    if (!state.flow_code || !state.flow_current_node) {
      console.info(FLOW_SORTEO_LOG, "processImageReply_early_exit", {
        status: "missing_flow_state",
        archivo: "src/lib/chat/flow-engine-service.ts",
        lineApprox: 1180,
        condicion: "!flow_code || !flow_current_node",
        conversationId: state.id,
        flow_code: state.flow_code,
        flow_current_node: state.flow_current_node,
        ensureSorteoOrderFromChat: "no_llamado",
      });
      return { ok: true, status: "missing_flow_state" };
    }

    const currentNode = await getNode(
      state.empresa_id,
      state.flow_code,
      state.flow_current_node
    );
    if (!currentNode || currentNode.node_type !== "image_input") {
      console.info(FLOW_SORTEO_LOG, "processImageReply_early_exit", {
        status: "ignored_not_image_node",
        archivo: "src/lib/chat/flow-engine-service.ts",
        lineApprox: 1200,
        condicion: "!currentNode || currentNode.node_type !== 'image_input'",
        conversationId: state.id,
        flowCode: state.flow_code,
        flow_current_node: state.flow_current_node,
        node_type: currentNode?.node_type ?? null,
        ensureSorteoOrderFromChat: "no_llamado",
      });
      return { ok: true, status: "ignored_not_image_node" };
    }

    const sendCtx = await getConversationSendContext(state.id);
    if (sendCtx.provider !== "meta") {
      console.warn("[flow-engine] processImageReply omitido: descarga de media usa Graph (Meta)", {
        conversationId: state.id,
      });
      return { ok: true, status: "ignored_ycloud_image_pipeline" };
    }
    const media = await downloadMetaMedia({
      mediaId: params.mediaId,
      accessToken: sendCtx.token,
      mimeTypeHint: params.mimeType ?? null,
    });
    const mimeNorm = (media.mimeType || "").toLowerCase();
    if (!isComprobanteMimeAccepted(media.mimeType)) {
      const reminder = await buildImageInputReminderText(
        currentNode,
        state.id,
        "expected_image_got_non_image"
      );
      const send = await flowSendText(sendCtx, reminder);
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
        flowSessionId: state.active_flow_session_id,
        eventType: "image_expected_non_image_received",
        payload: {
          mime_type: media.mimeType,
          media_id: params.mediaId,
          raw: params.rawPayload,
        },
      });
      console.info(FLOW_SORTEO_LOG, "processImageReply_early_exit", {
        status: "ignored_non_image_mime",
        archivo: "src/lib/chat/flow-engine-service.ts",
        lineApprox: 1255,
        condicion: "!isComprobanteMimeAccepted (imagen o PDF)",
        conversationId: state.id,
        flowCode: state.flow_code,
        mimeNorm,
        ensureSorteoOrderFromChat: "no_llamado",
      });
      return { ok: true, status: "ignored_non_image_mime" };
    }

    await ensureChatMediaBucket();

    const ext = extensionFromMime(media.mimeType);
    const path = `${state.empresa_id}/${state.id}/${Date.now()}.${ext}`;
    const upload = await supabase.storage.from(CHAT_MEDIA_BUCKET).upload(path, media.bytes, {
      contentType: media.mimeType,
      upsert: true,
    });
    if (upload.error) {
      console.error(FLOW_SORTEO_LOG, "processImageReply_early_exit", {
        status: "upload_failed",
        archivo: "src/lib/chat/flow-engine-service.ts",
        lineApprox: 1277,
        condicion: "storage.upload.error",
        conversationId: state.id,
        flowCode: state.flow_code,
        error: upload.error.message,
        ensureSorteoOrderFromChat: "no_llamado",
      });
      return { ok: false, status: "upload_failed", error: upload.error.message };
    }
    const publicUrl = supabase.storage.from(CHAT_MEDIA_BUCKET).getPublicUrl(path).data.publicUrl;

    const imgFlowSid = state.active_flow_session_id?.trim();
    if (!imgFlowSid) {
      return {
        ok: false,
        status: "missing_flow_session",
        error: "Sesión de flujo no inicializada; escribí hola para reiniciar antes del comprobante.",
      };
    }

    flowTrace("process_image_reply_state", {
      conversation_id: state.id,
      empresa_id: state.empresa_id,
      active_flow_session_id: state.active_flow_session_id ?? null,
      flow_session_id_for_comprobante: imgFlowSid,
      flow_current_node: state.flow_current_node,
      flow_code: state.flow_code,
      event: "comprobante_image_input",
    });

    const { data: chCfgImg } = await supabase
      .from("chat_channels")
      .select("config")
      .eq("id", state.channel_id)
      .maybeSingle();
    const valSettings = parseComprobanteValidationConfig(chCfgImg?.config);

    let comprobanteStagingRows: Array<{
      empresa_id: string;
      conversation_id: string;
      flow_code: string;
      flow_session_id: string;
      field_name: string;
      field_value: string;
    }> = [
      {
        empresa_id: state.empresa_id,
        conversation_id: state.id,
        flow_code: state.flow_code,
        flow_session_id: imgFlowSid,
        field_name: SORTEO_COMPROBANTE_MEDIA_ID_FIELD,
        field_value: params.mediaId,
      },
      {
        empresa_id: state.empresa_id,
        conversation_id: state.id,
        flow_code: state.flow_code,
        flow_session_id: imgFlowSid,
        field_name: SORTEO_COMPROBANTE_URL_FIELD,
        field_value: publicUrl,
      },
    ];

    const pipeline = await runComprobanteValidationPipeline({
      supabase,
      empresaId: state.empresa_id,
      conversationId: state.id,
      channelId: state.channel_id,
      flowCode: state.flow_code,
      flowSessionId: imgFlowSid,
      mediaId: params.mediaId,
      publicUrl,
      bytes: Buffer.from(media.bytes),
      mimeType: media.mimeType,
      settings: valSettings,
    });

    if (pipeline.kind === "resolved") {
      comprobanteStagingRows = pipeline.flowUpserts;
    }

    if (currentNode.save_as_field?.trim()) {
      comprobanteStagingRows.push({
        empresa_id: state.empresa_id,
        conversation_id: state.id,
        flow_code: state.flow_code,
        flow_session_id: imgFlowSid,
        field_name: currentNode.save_as_field.trim(),
        field_value: publicUrl,
      });
    }
    const { error: upErr } = await supabase
      .from("chat_flow_data")
      .upsert(comprobanteStagingRows, { onConflict: "flow_session_id,field_name" });
    if (upErr) {
      console.error(FLOW_SORTEO_LOG, "processImageReply_early_exit", {
        status: "save_image_failed",
        archivo: "src/lib/chat/flow-engine-service.ts",
        condicion: "chat_flow_data comprobante staging upsert",
        conversationId: state.id,
        flowCode: state.flow_code,
        error: upErr.message,
      });
      return { ok: false, status: "save_image_failed", error: upErr.message };
    }
    flowTrace("flow_data_write", {
      conversation_id: state.id,
      empresa_id: state.empresa_id,
      flow_code: state.flow_code,
      flow_session_id_write: imgFlowSid,
      node_code: currentNode.node_code,
      event: "comprobante_staged_deferred_order",
      field_names: comprobanteStagingRows.map((r) => r.field_name),
    });

    await insertFlowEvent({
      empresaId: state.empresa_id,
      conversationId: state.id,
      flowCode: state.flow_code,
      nodeCode: currentNode.node_code,
      flowSessionId: imgFlowSid,
      eventType: "image_received",
      payload: {
        media_id: params.mediaId,
        mime_type: media.mimeType,
        caption: params.caption ?? null,
        storage_url: publicUrl,
        save_as_field: currentNode.save_as_field ?? null,
        sorteo_order_deferred_until_confirm: true,
        comprobante_validacion:
          pipeline.kind === "resolved"
            ? {
                validation_id: pipeline.validationId,
                estado: pipeline.estado,
                advance: pipeline.advance,
              }
            : null,
      },
    });

    if (pipeline.kind === "resolved") {
      const sendCtxVal = await getConversationSendContext(state.id);
      if (pipeline.sendText?.trim()) {
        const st = await flowSendText(sendCtxVal, pipeline.sendText.trim());
        if (st.ok) {
          await persistOutgoingMessage({
            conversation: state,
            content: pipeline.sendText.trim(),
            messageType: "text",
            waMessageId: st.waMessageId,
            raw: st.raw,
            senderType: "system",
            automationSource: "flow_engine",
          });
        }
      }
      if (pipeline.humanTakeover) {
        await supabase
          .from("chat_conversations")
          .update({
            flow_status: "human",
            human_taken_over: true,
            updated_at: new Date().toISOString(),
          })
          .eq("id", state.id);
      }
      if (pipeline.sendInteractive && sendCtxVal.provider === "meta") {
        const ib = await sendWhatsAppInteractiveButtons({
          toDigits: sendCtxVal.toDigits,
          phoneNumberId: sendCtxVal.phoneNumberId,
          accessToken: sendCtxVal.token,
          bodyText: pipeline.sendInteractive.body,
          buttons: pipeline.sendInteractive.buttons,
        });
        if (ib.ok) {
          await persistOutgoingMessage({
            conversation: state,
            content: pipeline.sendInteractive.body,
            messageType: "interactive",
            waMessageId: ib.waMessageId,
            raw: ib.raw,
            senderType: "system",
            automationSource: "flow_engine",
          });
        }
      }
      if (!pipeline.advance) {
        return { ok: true, status: "comprobante_blocked_validation" };
      }
    }

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
      flowSessionId: imgFlowSid,
      eventType: "node_advanced",
      payload: {
        from_node: currentNode.node_code,
        next_node_code: currentNode.next_node_code,
        reason: "image_received",
      },
    });

    const sent = await sendCurrentFlowNode({
      conversationId: state.id,
      mergeFlowVars: {
        sorteo_comprobante_url: publicUrl,
        comprobante_recibido: "sí",
      },
    });
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
    ensureCurrentNodePresentedAfterInbound,
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

export async function ensureCurrentNodePresentedAfterInbound(
  supabase: SupabaseAdmin,
  params: EnsureInboundPresentParams
): Promise<EnsureInboundPresentResult> {
  return createFlowEngine({ supabase }).ensureCurrentNodePresentedAfterInbound(params);
}
