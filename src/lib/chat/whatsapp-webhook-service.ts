import {
  provisionChannelFromWebhookEnv,
  type WebhookProvisionEnv,
} from "@/lib/chat/channel-provision";
import { createFlowEngine } from "@/lib/chat/flow-engine-service";
import { flowTrace } from "@/lib/chat/flow-trace-log";
import { persistInboundChatMessageAndBump } from "@/lib/chat/incoming-message-service";
import {
  fetchOmnichannelRouteByMetaPhone,
  syncOmnichannelRouteForWhatsappChannel,
} from "@/lib/chat/omnichannel-route-sync";
import { createWhatsappConversationWithActiveFlow } from "@/lib/chat/whatsapp-conversation-bootstrap";
import { getConversationWhatsAppSendContext } from "@/lib/chat/conversation-send-context";
import { attachInboundMessageMedia } from "@/lib/chat/inbound-media-attach";
import {
  CONV_LOG,
  isFlowKnownAndActiveInCatalog,
  isNodeActiveInFlow,
  matchesConversationRestartKeyword,
  matchesHumanHandoffKeyword,
  restartWhatsappConversationToFlowStart,
  syncWhatsappConversationFlowFromCatalog,
  WEBHOOK_IMMEDIATE_HANDOFF_BUTTON_IDS,
} from "@/lib/chat/resolve-whatsapp-active-flow";
import { sendWhatsAppText } from "@/lib/chat/whatsapp-send-service";
import { saveProspectoFromWebhook } from "@/lib/crm/storage";
import type {
  MetaInboundMessage,
  MetaWebhookValue,
  ProcessWebhookResult,
  SupabaseAdmin,
} from "@/lib/chat/types";
import { normalizeWaPhone } from "@/lib/chat/wa-phone";
import { applySorteoReferralToActiveSession } from "@/lib/sorteos/referral-attribution";
import { createServiceRoleClientWithDbSchema } from "@/lib/supabase/empresa-data-schema";
import { SUPABASE_APP_SCHEMA, resolveEmpresaDataSchema } from "@/lib/supabase/schema";

export { normalizeWaPhone } from "@/lib/chat/wa-phone";

function contactNameForWa(
  contacts: MetaWebhookValue["contacts"],
  waId: string
): string | null {
  if (!contacts?.length) return null;
  const norm = normalizeWaPhone(waId);
  const c = contacts.find((x) => x.wa_id && normalizeWaPhone(x.wa_id) === norm);
  return c?.profile?.name?.trim() || null;
}

export function extractMessageBody(msg: MetaInboundMessage): { message_type: string; content: string } {
  const t = msg.type ?? "unknown";
  switch (t) {
    case "text":
      return { message_type: "text", content: msg.text?.body ?? "" };
    case "image":
      return {
        message_type: "image",
        content: msg.image?.caption?.trim() || "[imagen]",
      };
    case "document":
      return {
        message_type: "document",
        content:
          msg.document?.caption?.trim() ||
          msg.document?.filename ||
          "[documento]",
      };
    case "audio":
      return { message_type: "audio", content: "[audio]" };
    case "video":
      return {
        message_type: "video",
        content: msg.video?.caption?.trim() || "[video]",
      };
    case "sticker":
      return { message_type: "sticker", content: "[sticker]" };
    case "interactive": {
      const button = msg.interactive?.button_reply;
      if (button?.id) {
        return {
          message_type: "interactive",
          content: button.title?.trim() || `[button:${button.id}]`,
        };
      }
      const list = msg.interactive?.list_reply;
      if (list?.id) {
        return {
          message_type: "interactive",
          content: list.title?.trim() || `[list:${list.id}]`,
        };
      }
      return { message_type: "interactive", content: "[interactive]" };
    }
    default:
      return { message_type: t, content: `[${t}]` };
  }
}

/**
 * Media descargable para nodo `image_input` / comprobante.
 * Meta suele mandar fotos como `image`, pero muchos usuarios envían PDF o imagen como `document`.
 */
export function extractInboundComprobanteMedia(msg: MetaInboundMessage): {
  mediaId: string;
  mimeType: string | null;
  caption: string | null;
  sourceType: "image" | "document" | "sticker";
} | null {
  const t = (msg.type ?? "").trim();
  if (t === "image") {
    const mediaId = msg.image?.id?.trim();
    if (!mediaId) return null;
    return {
      mediaId,
      mimeType: msg.image?.mime_type?.trim() || null,
      caption: msg.image?.caption?.trim() || null,
      sourceType: "image",
    };
  }
  if (t === "document") {
    const doc = msg.document;
    const mediaId = doc?.id?.trim();
    if (!mediaId) return null;
    return {
      mediaId,
      mimeType: doc?.mime_type?.trim() || null,
      caption: doc?.caption?.trim() || null,
      sourceType: "document",
    };
  }
  if (t === "sticker") {
    const mediaId = msg.sticker?.id?.trim();
    if (!mediaId) return null;
    return {
      mediaId,
      mimeType: null,
      caption: null,
      sourceType: "sticker",
    };
  }
  return null;
}

function extractMetaButtonId(msg: MetaInboundMessage): string | null {
  const buttonId = msg.interactive?.button_reply?.id?.trim();
  if (buttonId) return buttonId;
  const listId = msg.interactive?.list_reply?.id?.trim();
  if (listId) return listId;
  return null;
}

async function messageExists(
  supabase: SupabaseAdmin,
  waMessageId: string
): Promise<boolean> {
  const { data } = await supabase
    .from("chat_messages")
    .select("id")
    .eq("wa_message_id", waMessageId)
    .maybeSingle();
  return !!data?.id;
}

type WhatsappChannelRow = {
  id: string;
  empresa_id: string;
  meta_phone_number_id: string;
  activo: boolean | null;
};

/**
 * Si el canal vive en un esquema tenant distinto de `zentra_erp` (`er_*`, `erp_*`, etc.) pero falta
 * la fila en `zentra_erp.omnichannel_routes`, el webhook solo miraba `zentra_erp.chat_channels` y fallaba.
 * Recorremos empresas con `data_schema` no vacío (valor real en `empresas`) y buscamos el canal ahí.
 */
const BLOCKED_DATA_SCHEMA_NAMES = new Set(
  ["public", "pg_catalog", "information_schema"].map((s) => s.toLowerCase())
);

async function findWhatsappChannelInTenantSchemas(
  catalogSupabase: SupabaseAdmin,
  phoneNumberId: string
): Promise<{ channel: WhatsappChannelRow; dataSupabase: SupabaseAdmin; dataSchema: string } | null> {
  const { data: empresas, error } = await catalogSupabase
    .from("empresas")
    .select("id, data_schema")
    .not("data_schema", "is", null);

  if (error) {
    console.error("[webhook] listar empresas (data_schema):", error.message);
    return null;
  }

  for (const e of (empresas ?? []) as Array<{ id: string; data_schema: string | null }>) {
    const schema = resolveEmpresaDataSchema(e.data_schema);
    if (schema === SUPABASE_APP_SCHEMA) continue;
    if (BLOCKED_DATA_SCHEMA_NAMES.has(schema.toLowerCase())) {
      console.warn("[webhook] scan tenant: omitiendo data_schema reservado", {
        empresa_id: e.id,
        schema,
      });
      continue;
    }

    const tenantSb = createServiceRoleClientWithDbSchema(schema) as SupabaseAdmin;
    const { data: ch, error: chErr } = await tenantSb
      .from("chat_channels")
      .select("id, empresa_id, meta_phone_number_id, activo")
      .eq("meta_phone_number_id", phoneNumberId)
      .eq("empresa_id", e.id)
      .maybeSingle();

    if (chErr) {
      console.warn("[webhook] scan tenant chat_channels", { schema, err: chErr.message });
      continue;
    }
    if (ch) {
      return {
        channel: ch as WhatsappChannelRow,
        dataSupabase: tenantSb,
        dataSchema: schema,
      };
    }
  }
  return null;
}

async function resolveInitialCrmEtapaCodigo(
  supabase: SupabaseAdmin,
  empresaId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from("crm_etapas")
    .select("codigo")
    .eq("empresa_id", empresaId)
    .eq("activo", true)
    .order("orden", { ascending: true });

  if (error) {
    console.error("[webhook][crm] resolveInitialCrmEtapaCodigo:", error.message);
    return null;
  }

  const rows = (data ?? []) as Array<{ codigo?: string | null }>;
  const terminal = new Set(["GANADO", "PERDIDO"]);

  const candidate = rows.find((r) => r.codigo && !terminal.has(r.codigo))?.codigo ?? null;
  if (candidate) return candidate;
  return rows[0]?.codigo ?? null;
}

/**
 * Procesa mensajes entrantes de un único `value` de Meta (un change).
 */
export async function processInboundWebhookValue(
  catalogSupabase: SupabaseAdmin,
  value: MetaWebhookValue,
  provisionEnv?: WebhookProvisionEnv
): Promise<ProcessWebhookResult> {
  const errors: string[] = [];
  let processed = 0;
  let skipped = 0;

  const phoneNumberId = value.metadata?.phone_number_id?.trim();
  if (!phoneNumberId) {
    return {
      ok: false,
      processed: 0,
      skipped: 0,
      errors: ["Falta metadata.phone_number_id"],
    };
  }

  let dataSupabase: SupabaseAdmin = catalogSupabase;
  let channel: WhatsappChannelRow | null = null;

  const routeRow = await fetchOmnichannelRouteByMetaPhone(catalogSupabase, phoneNumberId);

  if (routeRow) {
    const r = routeRow;
    const schema = resolveEmpresaDataSchema(r.data_schema || null);
    dataSupabase =
      schema === SUPABASE_APP_SCHEMA
        ? catalogSupabase
        : (createServiceRoleClientWithDbSchema(schema) as SupabaseAdmin);
    const { data: chT, error: errT } = await dataSupabase
      .from("chat_channels")
      .select("id, empresa_id, meta_phone_number_id, activo")
      .eq("id", r.channel_id)
      .maybeSingle();
    if (errT) {
      return {
        ok: false,
        processed: 0,
        skipped: 0,
        errors: [errT.message],
      };
    }
    const row = chT as WhatsappChannelRow | null;
    if (!row || row.empresa_id !== r.empresa_id) {
      return {
        ok: false,
        processed: 0,
        skipped: 0,
        errors: ["Ruta omnicanal inconsistente: canal no encontrado o empresa distinta."],
      };
    }
    channel = row;
  } else {
    const { data: ch0, error: chErr } = await catalogSupabase
      .from("chat_channels")
      .select("id, empresa_id, meta_phone_number_id, activo")
      .eq("meta_phone_number_id", phoneNumberId)
      .maybeSingle();

    if (chErr) {
      return {
        ok: false,
        processed: 0,
        skipped: 0,
        errors: [chErr.message],
      };
    }

    channel = ch0 as WhatsappChannelRow | null;
    dataSupabase = catalogSupabase;

    if (!channel) {
      const tenantHit = await findWhatsappChannelInTenantSchemas(catalogSupabase, phoneNumberId);
      if (tenantHit) {
        channel = tenantHit.channel;
        dataSupabase = tenantHit.dataSupabase;
        try {
          await syncOmnichannelRouteForWhatsappChannel({
            metaPhoneNumberId: phoneNumberId,
            empresaId: tenantHit.channel.empresa_id,
            channelId: tenantHit.channel.id,
            activo: tenantHit.channel.activo !== false,
            dataSchema: tenantHit.dataSchema,
          });
        } catch (e) {
          console.warn(
            "[webhook] no se pudo reparar omnichannel_routes (el mensaje sigue con el canal encontrado):",
            e instanceof Error ? e.message : e
          );
        }
      }
    }

    if (!channel && provisionEnv) {
      await provisionChannelFromWebhookEnv(catalogSupabase, phoneNumberId, provisionEnv);
      const routeAfter = await fetchOmnichannelRouteByMetaPhone(catalogSupabase, phoneNumberId);

      if (routeAfter) {
        const r = routeAfter;
        const schema = resolveEmpresaDataSchema(r.data_schema || null);
        dataSupabase =
          schema === SUPABASE_APP_SCHEMA
            ? catalogSupabase
            : (createServiceRoleClientWithDbSchema(schema) as SupabaseAdmin);
        const { data: chTenant } = await dataSupabase
          .from("chat_channels")
          .select("id, empresa_id, meta_phone_number_id, activo")
          .eq("id", r.channel_id)
          .maybeSingle();
        channel = chTenant as WhatsappChannelRow | null;
      } else {
        const { data: ch1 } = await catalogSupabase
          .from("chat_channels")
          .select("id, empresa_id, meta_phone_number_id, activo")
          .eq("meta_phone_number_id", phoneNumberId)
          .maybeSingle();
        channel = ch1 as WhatsappChannelRow | null;
        dataSupabase = catalogSupabase;
      }
    }
  }

  if (channel && channel.activo === false) {
    return {
      ok: false,
      processed: 0,
      skipped: 0,
      errors: [
        "El canal WhatsApp está desactivado. Activalo en Conversaciones → Configuración.",
      ],
    };
  }

  if (!channel) {
    return {
      ok: false,
      processed: 0,
      skipped: 0,
      errors: [
        `Canal no registrado para phone_number_id=${phoneNumberId}. Configurá el canal en el ERP (Conversaciones → Configuración) o definí WHATSAPP_DEFAULT_EMPRESA_ID y WHATSAPP_PHONE_NUMBER_ID (mismo ID que en Meta) en el servidor.`,
      ],
    };
  }

  const { data: channelSanity, error: chSanErr } = await dataSupabase
    .from("chat_channels")
    .select("id")
    .eq("id", channel.id)
    .eq("empresa_id", channel.empresa_id)
    .maybeSingle();
  if (chSanErr || !channelSanity) {
    return {
      ok: false,
      processed: 0,
      skipped: 0,
      errors: [
        `Canal ${channel.id} no existe en el schema PostgREST usado para chat_* (FK o data_schema inconsistente). Revisá migración supabase 20260411190000 y coherencia de empresas.data_schema. ${chSanErr?.message ?? ""}`,
      ],
    };
  }

  /** Cliente PostgREST para tablas chat_* (tenant o zentra_erp). */
  const supabase = dataSupabase;

  const empresaId = channel.empresa_id as string;
  const channelId = channel.id as string;
  const messages = value.messages ?? [];

  for (const msg of messages) {
    const from = msg.from ? normalizeWaPhone(msg.from) : "";
    const waMid = msg.id?.trim();
    if (!from || !waMid) {
      skipped += 1;
      errors.push("Mensaje sin from o id");
      continue;
    }

    if (await messageExists(supabase, waMid)) {
      skipped += 1;
      continue;
    }

    const displayName = contactNameForWa(value.contacts, from) ?? from;

    try {
      const { data: contact, error: cErr } = await supabase
        .from("chat_contacts")
        .upsert(
          {
            empresa_id: empresaId,
            phone_number: from,
            phone_normalized: from,
            name: displayName,
          },
          { onConflict: "empresa_id,phone_number" }
        )
        .select("id, name, crm_prospecto_id")
        .single();

      if (cErr || !contact) {
        errors.push(`Contacto: ${cErr?.message ?? "error"}`);
        continue;
      }

      const contactId = contact.id as string;
      if (displayName && displayName !== contact.name) {
        await supabase
          .from("chat_contacts")
          .update({ name: displayName, updated_at: new Date().toISOString() })
          .eq("id", contactId);
      }

      let { data: existingConv } = await supabase
        .from("chat_conversations")
        .select(
          "id, status, unread_count, flow_code, flow_current_node, flow_status, human_taken_over, active_flow_session_id"
        )
        .eq("contact_id", contactId)
        .eq("channel_id", channelId)
        .maybeSingle();

      const { message_type, content } = extractMessageBody(msg);
      const preview = content.slice(0, 280);
      const ts = msg.timestamp
        ? new Date(parseInt(msg.timestamp, 10) * 1000).toISOString()
        : new Date().toISOString();

      if (!existingConv) {
        const { conv, error: bootErr } = await createWhatsappConversationWithActiveFlow(
          supabase,
          empresaId,
          channelId,
          contactId
        );
        if (bootErr) {
          errors.push(`Conversación: ${bootErr}`);
          continue;
        }
        if (conv) existingConv = conv;
      }

      if (!existingConv) {
        errors.push("Conversación: no encontrada");
        continue;
      }

      const conversationId = existingConv.id as string;

      const syncedFlow = await syncWhatsappConversationFlowFromCatalog(supabase, empresaId, conversationId, {
        flow_code: (existingConv as { flow_code?: string | null }).flow_code ?? null,
        flow_current_node: (existingConv as { flow_current_node?: string | null }).flow_current_node ?? null,
      });
      existingConv = {
        ...existingConv,
        flow_code: syncedFlow.flow_code,
        flow_current_node: syncedFlow.flow_current_node,
      };

      /**
       * Reanudar / reiniciar flujo con el mismo contacto+canal (sin duplicar conversación):
       * - Palabras clave → primer nodo del flujo activo (o del flujo actual si hay varios activos).
       * - Puntero roto (sin flow, flujo inactivo en catálogo, nodo inválido) → reinicio seguro.
       * - Si todo válido → conversation_resumed (solo log).
       */
      let convFlow = (existingConv as { flow_code?: string | null }).flow_code ?? null;
      let convNode = (existingConv as { flow_current_node?: string | null }).flow_current_node ?? null;
      let convHuman = (existingConv as { human_taken_over?: boolean | null }).human_taken_over ?? false;
      let convFlowStatus = (existingConv as { flow_status?: string | null }).flow_status ?? "bot";

      let restartedThisMessage = false;
      /** Takeover por palabra/botón genérico: mensaje de confirmación tras persistir el entrante. */
      let keywordHandoffPendingConfirmation = false;

      const startedInHumanMode = convHuman || convFlowStatus === "human";

      const restartKeywordMatch =
        message_type === "text" ? matchesConversationRestartKeyword(content) : false;
      if (message_type === "text") {
        console.info(CONV_LOG, "inbound_text_before_restart_check", {
          conversationId,
          contentLength: content.length,
          contentPreview: content.slice(0, 200),
          contentJsonHead: JSON.stringify(content.slice(0, 120)),
          matchesRestartKeyword: restartKeywordMatch,
          startedInHumanMode,
        });
      }

      if (!startedInHumanMode) {
        if (restartKeywordMatch) {
          console.info(CONV_LOG, "restart_keyword_branch_entered", {
            conversationId,
            preferFlowCode: convFlow,
          });
          const rrKw = await restartWhatsappConversationToFlowStart(supabase, empresaId, conversationId, {
            preferFlowCode: convFlow,
            trigger: "restart_keyword",
          });
          console.info(CONV_LOG, "restart_keyword_result", {
            conversationId,
            restarted: rrKw.restarted,
            reason: rrKw.reason,
            flow_code: rrKw.flow_code,
            flow_current_node: rrKw.flow_current_node,
          });
          if (!rrKw.restarted) {
            console.warn(CONV_LOG, "restart_keyword_no_op", {
              conversationId,
              reason: rrKw.reason,
              convFlowBefore: convFlow,
            });
          }
          if (rrKw.restarted) {
            convFlow = rrKw.flow_code;
            convNode = rrKw.flow_current_node;
            convHuman = false;
            convFlowStatus = "bot";
            restartedThisMessage = true;
          }
        }

        if (!restartedThisMessage) {
          const fc = convFlow?.trim() || null;
          const nc = convNode?.trim() || null;
          let mustRestart = false;
          let restartTrigger = "";
          let prefer: string | null = null;

          if (!fc) {
            mustRestart = true;
            restartTrigger = "missing_flow_code";
            console.warn(CONV_LOG, "invalid_current_node", {
              conversationId,
              detail: "missing_flow_code",
            });
          } else if (!(await isFlowKnownAndActiveInCatalog(supabase, empresaId, fc))) {
            mustRestart = true;
            restartTrigger = "inactive_flow_reassigned";
            prefer = null;
            console.warn(CONV_LOG, "inactive_flow_reassigned", {
              conversationId,
              flow_code: fc,
              detail: "not_in_catalog_or_inactive",
            });
          } else if (!nc || !(await isNodeActiveInFlow(supabase, empresaId, fc, nc))) {
            mustRestart = true;
            restartTrigger = "invalid_current_node";
            prefer = fc;
            console.warn(CONV_LOG, "invalid_current_node", {
              conversationId,
              flow_code: fc,
              flow_current_node: nc,
            });
          }

          if (mustRestart) {
            const rrFix = await restartWhatsappConversationToFlowStart(supabase, empresaId, conversationId, {
              preferFlowCode: prefer,
              trigger: restartTrigger,
            });
            if (rrFix.restarted) {
              convFlow = rrFix.flow_code;
              convNode = rrFix.flow_current_node;
              convHuman = false;
              convFlowStatus = "bot";
            }
          } else {
            console.info(CONV_LOG, "conversation_resumed", {
              conversationId,
              flow_code: fc,
              flow_current_node: nc,
            });
          }
        }
      } else {
        console.info(CONV_LOG, "skip_restart_and_catalog_repair_human_mode", { conversationId });
      }

      const metaButtonIdPre = extractMetaButtonId(msg);
      if (!convHuman && convFlowStatus === "bot") {
        if (message_type === "text" && matchesHumanHandoffKeyword(content)) {
          convHuman = true;
          convFlowStatus = "human";
          keywordHandoffPendingConfirmation = true;
          console.info(CONV_LOG, "human_handoff_keyword", { conversationId, preview: content.slice(0, 80) });
        } else if (metaButtonIdPre && WEBHOOK_IMMEDIATE_HANDOFF_BUTTON_IDS.has(metaButtonIdPre)) {
          convHuman = true;
          convFlowStatus = "human";
          keywordHandoffPendingConfirmation = true;
          console.info(CONV_LOG, "human_handoff_button", { conversationId, metaButtonId: metaButtonIdPre });
        }
      }

      existingConv = {
        ...existingConv,
        flow_code: convFlow,
        flow_current_node: convNode,
        human_taken_over: convHuman,
        flow_status: convFlowStatus,
      };

      const logW = "[webhook/whatsapp][inbound]";
      console.info(logW, "message_received", {
        waMessageId: waMid,
        fromDigits: from,
        phoneNumberId,
        channelId,
        messageType: (msg as { type?: string }).type ?? "unknown",
        conversationId,
        flow_code: (existingConv as { flow_code?: string | null }).flow_code ?? null,
        flow_current_node: (existingConv as { flow_current_node?: string | null }).flow_current_node ?? null,
        flow_status: (existingConv as { flow_status?: string | null }).flow_status ?? null,
      });

      // ── Integración CRM Funnel (WhatsApp) ─────────────────────────────
      // Si el contacto no tiene prospecto, crear uno en crm_prospectos y enlazarlo a chat_contacts.
      const contactCrmProspectoId =
        (contact as { crm_prospecto_id?: string | null }).crm_prospecto_id ?? null;

      if (!contactCrmProspectoId) {
        const etapaCodigo = await resolveInitialCrmEtapaCodigo(catalogSupabase, empresaId);
        if (!etapaCodigo) {
          errors.push("CRM: no se pudo resolver etapa inicial para el lead whatsapp");
        } else {
          const prospecto = await saveProspectoFromWebhook({
            empresa_id: empresaId,
            telefono: from,
            contacto: displayName,
            empresa_nombre: "WhatsApp",
            etapa: etapaCodigo,
            origen_creacion: "whatsapp",
            origen_detalle: null,
          });

          if (prospecto?.id) {
            await supabase
              .from("chat_contacts")
              .update({ crm_prospecto_id: prospecto.id, updated_at: new Date().toISOString() })
              .eq("id", contactId)
              .eq("empresa_id", empresaId);
          } else {
            errors.push("CRM: no se pudo crear el prospecto desde WhatsApp");
          }
        }
      }

      const flowEngine = createFlowEngine({ supabase });

      const persistInbound = await persistInboundChatMessageAndBump({
        supabase,
        empresaId,
        conversationId,
        externalMessageId: waMid,
        messageType: message_type,
        content,
        rawPayload: msg as unknown as Record<string, unknown>,
        timestampIso: ts,
        preview,
        fromMe: false,
        senderType: "contact",
        conversationState: {
          flow_code: (existingConv as { flow_code?: string | null }).flow_code ?? null,
          flow_current_node: (existingConv as { flow_current_node?: string | null }).flow_current_node ?? null,
          flow_status: (existingConv as { flow_status?: string | null }).flow_status ?? "bot",
          human_taken_over: Boolean(
            (existingConv as { human_taken_over?: boolean | null }).human_taken_over
          ),
          unread_count: (existingConv.unread_count as number) ?? 0,
          status: existingConv.status as string,
        },
      });

      if (!persistInbound.ok) {
        if (persistInbound.duplicate) {
          skipped += 1;
          continue;
        }
        errors.push(`Insert mensaje: ${persistInbound.error}`);
        continue;
      }

      const inboundRowId = persistInbound.message_id;

      console.info(logW, "inbound_message_persisted", {
        conversationId,
        waMessageId: waMid,
        message_type,
        messageRowId: inboundRowId,
      });

      if (inboundRowId) {
        const { data: chTok } = await supabase
          .from("chat_channels")
          .select("whatsapp_access_token")
          .eq("id", channelId)
          .maybeSingle();
        const rowTok =
          typeof (chTok as { whatsapp_access_token?: string } | null)?.whatsapp_access_token === "string"
            ? (chTok as { whatsapp_access_token: string }).whatsapp_access_token.trim()
            : "";
        const mediaToken = rowTok || process.env.WHATSAPP_TOKEN?.trim() || "";
        if (mediaToken) {
          try {
            await attachInboundMessageMedia({
              supabase,
              empresaId,
              conversationId,
              messageId: inboundRowId,
              msg,
              accessToken: mediaToken,
            });
          } catch (e) {
            console.warn(logW, "inbound_media_attach_failed", {
              conversationId,
              messageId: inboundRowId,
              err: e instanceof Error ? e.message : String(e),
            });
          }
        }
      }

      console.info(logW, "conversation_updated_unread", { conversationId });

      const { data: convDbAfterUnread } = await supabase
        .from("chat_conversations")
        .select(
          "flow_code, flow_current_node, active_flow_session_id, flow_status, human_taken_over"
        )
        .eq("id", conversationId)
        .eq("empresa_id", empresaId)
        .maybeSingle();
      if (convDbAfterUnread) {
        const ec = existingConv as {
          flow_code?: string | null;
          flow_current_node?: string | null;
          flow_status?: string | null;
          human_taken_over?: boolean | null;
          active_flow_session_id?: string | null;
        };
        existingConv = {
          ...existingConv,
          flow_code:
            (convDbAfterUnread as { flow_code?: string | null }).flow_code ?? ec.flow_code ?? null,
          flow_current_node:
            (convDbAfterUnread as { flow_current_node?: string | null }).flow_current_node ??
            ec.flow_current_node ??
            null,
          flow_status:
            (convDbAfterUnread as { flow_status?: string | null }).flow_status ?? ec.flow_status ?? null,
          human_taken_over:
            (convDbAfterUnread as { human_taken_over?: boolean | null }).human_taken_over ??
            ec.human_taken_over ??
            false,
          active_flow_session_id: (convDbAfterUnread as { active_flow_session_id?: string | null })
            .active_flow_session_id,
        };
      }
      flowTrace("webhook_pre_engine_db_snapshot", {
        conversation_id: conversationId,
        empresa_id: empresaId,
        wa_message_id: waMid,
        restarted_this_message: restartedThisMessage,
        restart_keyword_matched: restartKeywordMatch,
        db_active_flow_session_id:
          (convDbAfterUnread as { active_flow_session_id?: string | null } | null)
            ?.active_flow_session_id ?? null,
        db_flow_code: (convDbAfterUnread as { flow_code?: string | null } | null)?.flow_code ?? null,
        db_flow_current_node:
          (convDbAfterUnread as { flow_current_node?: string | null } | null)?.flow_current_node ?? null,
        memory_active_flow_session_id:
          (existingConv as { active_flow_session_id?: string | null }).active_flow_session_id ?? null,
      });

      try {
        await applySorteoReferralToActiveSession({
          supabase,
          empresaId,
          conversationId,
          activeFlowSessionId: (existingConv as { active_flow_session_id?: string | null })
            .active_flow_session_id,
          flowCode: (existingConv as { flow_code?: string | null }).flow_code,
          inboundText: content,
          contactPhoneDigits: from,
        });
      } catch (e) {
        console.warn(logW, "referral_attribution_failed", {
          conversationId,
          err: e instanceof Error ? e.message : String(e),
        });
      }

      if (keywordHandoffPendingConfirmation) {
        const sid =
          (convDbAfterUnread as { active_flow_session_id?: string | null } | null)
            ?.active_flow_session_id ??
          (existingConv as { active_flow_session_id?: string | null }).active_flow_session_id ??
          null;
        await supabase.from("chat_flow_events").insert({
          empresa_id: empresaId,
          conversation_id: conversationId,
          flow_code: (existingConv as { flow_code?: string | null }).flow_code ?? null,
          node_code: (existingConv as { flow_current_node?: string | null }).flow_current_node ?? null,
          flow_session_id: sid,
          event_type: "human_handoff_keyword_or_button",
          meta_button_id: metaButtonIdPre,
          payload: {
            trigger: message_type === "text" ? "text_keyword" : "interactive_button",
            preview: preview.slice(0, 200),
          },
        });

        const handoffText =
          "Te derivamos con un asesor humano. En breve te vamos a escribir desde este mismo número.";
        try {
          const ctx = await getConversationWhatsAppSendContext(supabase, conversationId);
          const sendC = await sendWhatsAppText({
            toDigits: ctx.toDigits,
            phoneNumberId: ctx.phoneNumberId,
            accessToken: ctx.token,
            text: handoffText,
          });
          if (sendC.ok) {
            const nowH = new Date().toISOString();
            await supabase.from("chat_messages").insert({
              empresa_id: empresaId,
              conversation_id: conversationId,
              wa_message_id: sendC.waMessageId,
              from_me: true,
              sender_type: "system",
              message_type: "text",
              content: handoffText,
              raw_payload: (sendC.raw ?? {}) as Record<string, unknown>,
            });
            await supabase
              .from("chat_conversations")
              .update({
                last_message_at: nowH,
                last_message_preview: handoffText.slice(0, 280),
                updated_at: nowH,
              })
              .eq("id", conversationId);
          }
        } catch (e) {
          console.warn(logW, "human_handoff_confirm_send_failed", {
            conversationId,
            err: e instanceof Error ? e.message : String(e),
          });
        }
      }

      /**
       * 1) Presentar nodo actual si aún no se envió (botones/texto/media, etc.).
       *    Sin esto, processTextReply solo reacciona a nodos de captura y el primer mensaje no dispara el flujo.
       * 2) Luego procesar respuesta (botón / texto / imagen).
       * Solo mensajes entrantes del cliente entran aquí (from_me: false); salientes del ERP no pasan por este bloque.
       */
      const presentResult = await flowEngine.ensureCurrentNodePresentedAfterInbound({
        conversationId,
        empresaId,
      });
      console.info(logW, "flow_present_step", {
        conversationId,
        ok: presentResult.ok,
        status: presentResult.status,
        presentedNow: presentResult.presentedNow,
        acceptsInboundTextAsCapture: presentResult.acceptsInboundTextAsCapture,
        error: presentResult.error ?? null,
      });
      if (!presentResult.ok && presentResult.error) {
        errors.push(`Flow present: ${presentResult.error}`);
      }

      const metaButtonId = extractMetaButtonId(msg);
      if (metaButtonId) {
        console.info(logW, "flow_trigger: interactive_reply", {
          conversationId,
          empresaId,
          metaButtonId,
          currentNode:
            (existingConv as { flow_current_node?: string | null }).flow_current_node ??
            "inicio",
        });
        const interactiveResult = await flowEngine.processInteractiveReply({
          conversationId,
          empresaId,
          metaButtonId,
          rawPayload: msg as unknown as Record<string, unknown>,
        });
        console.info(logW, "flow_result: interactive", {
          conversationId,
          metaButtonId,
          status: interactiveResult.status,
          nextNodeCode: interactiveResult.nextNodeCode ?? null,
        });
        if (!interactiveResult.ok) {
          errors.push(
            `Flow interactive: ${interactiveResult.error ?? interactiveResult.status}`
          );
        }
      } else if (message_type === "text") {
        const skipAfterRestartKeyword = restartKeywordMatch && restartedThisMessage;
        const skipBecauseNonCapturePresent =
          presentResult.presentedNow && !presentResult.acceptsInboundTextAsCapture;
        if (skipAfterRestartKeyword) {
          console.info(logW, "skip_text_flow_handler", {
            conversationId,
            reason: "mensaje_usado_como_reinicio_flujo_no_es_captura",
          });
        } else if (skipBecauseNonCapturePresent) {
          console.info(logW, "skip_text_flow_handler", {
            conversationId,
            reason:
              "Se acaba de enviar la UI del nodo actual (no es captura de texto); el mismo mensaje no se interpreta como dato del flujo",
          });
        } else {
          const textResult = await flowEngine.processTextReply({
            conversationId,
            empresaId,
            textValue: content,
            rawPayload: msg as unknown as Record<string, unknown>,
          });
          console.info(logW, "flow_result: text", {
            conversationId,
            status: textResult.status,
            nextNodeCode: textResult.nextNodeCode ?? null,
          });
          if (!textResult.ok) {
            errors.push(`Flow text: ${textResult.error ?? textResult.status}`);
          }
        }
      } else {
        const comprobanteMedia = extractInboundComprobanteMedia(msg);
        if (comprobanteMedia) {
          const imageResult = await flowEngine.processImageReply({
            conversationId,
            empresaId,
            mediaId: comprobanteMedia.mediaId,
            mimeType: comprobanteMedia.mimeType,
            caption: comprobanteMedia.caption,
            rawPayload: msg as unknown as Record<string, unknown>,
          });
          console.info(logW, "flow_result: comprobante_media", {
            conversationId,
            mediaId: comprobanteMedia.mediaId,
            sourceType: comprobanteMedia.sourceType,
            messageTypeFromMeta: msg.type ?? null,
            status: imageResult.status,
            nextNodeCode: imageResult.nextNodeCode ?? null,
          });
          if (!imageResult.ok) {
            errors.push(`Flow comprobante: ${imageResult.error ?? imageResult.status}`);
          }
        } else if (message_type === "image" || message_type === "document") {
          errors.push(
            `Flow comprobante: tipo ${message_type} pero falta media id en payload (revisar shape Meta/n8n)`
          );
        } else {
          console.info(logW, "no_typed_flow_handler", {
            conversationId,
            message_type,
          });
        }
      }

      processed += 1;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  return {
    ok: errors.length === 0 || processed > 0,
    processed,
    skipped,
    errors,
  };
}

/**
 * Extrae bloques `value` como los envía Meta en `entry[].changes[]`, o el mismo objeto
 * si n8n (u otro proxy) reenvía solo el `value` en la raíz del JSON.
 */
export function collectMetaWebhookMessageValues(body: unknown): MetaWebhookValue[] {
  const out: MetaWebhookValue[] = [];
  if (!body || typeof body !== "object") return out;

  // n8n a veces serializa el lote como array con un ítem por mensaje
  if (Array.isArray(body)) {
    for (const item of body) {
      out.push(...collectMetaWebhookMessageValues(item));
    }
    return out;
  }

  const root = body as Record<string, unknown>;
  const entries = (root.entry as Array<{ changes?: unknown[] }> | undefined) ?? [];

  for (const ent of entries) {
    const changes = ent.changes ?? [];
    for (const ch of changes) {
      const change = ch as { value?: MetaWebhookValue; field?: string };
      if (change.field === "statuses") continue;
      const value = change.value;
      if (value?.messages?.length) out.push(value);
    }
  }

  if (out.length > 0) return out;

  // Payload plano (p. ej. n8n): mismo shape que `change.value` de Meta
  const field = typeof root.field === "string" ? root.field : undefined;
  if (field === "statuses") return out;

  const metadata = root.metadata as { phone_number_id?: string } | undefined;
  const phoneNumberId = metadata?.phone_number_id?.trim();
  const messages = root.messages;
  if (phoneNumberId && Array.isArray(messages) && messages.length > 0) {
    out.push(body as MetaWebhookValue);
  }

  return out;
}

/**
 * Recorre el body completo del webhook Meta (o el `value` reenviado en la raíz).
 */
export async function processWhatsAppWebhookBody(
  supabase: SupabaseAdmin,
  body: unknown,
  provisionEnv?: WebhookProvisionEnv
): Promise<ProcessWebhookResult> {
  const aggregated: ProcessWebhookResult = {
    ok: true,
    processed: 0,
    skipped: 0,
    errors: [],
  };

  if (!body || typeof body !== "object") {
    aggregated.ok = false;
    aggregated.errors.push("Body inválido");
    return aggregated;
  }

  const values = collectMetaWebhookMessageValues(body);

  for (const value of values) {
    const r = await processInboundWebhookValue(supabase, value, provisionEnv);
    aggregated.processed += r.processed;
    aggregated.skipped += r.skipped;
    aggregated.errors.push(...r.errors);
    if (!r.ok) aggregated.ok = false;
  }

  return aggregated;
}
