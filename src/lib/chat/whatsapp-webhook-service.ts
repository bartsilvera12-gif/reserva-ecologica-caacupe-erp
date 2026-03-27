import {
  provisionChannelFromWebhookEnv,
  type WebhookProvisionEnv,
} from "@/lib/chat/channel-provision";
import { createFlowEngine } from "@/lib/chat/flow-engine-service";
import {
  CONV_LOG,
  getFirstActiveNodeCodeForFlow,
  isFlowKnownAndActiveInCatalog,
  isNodeActiveInFlow,
  listActiveWhatsappFlowsForEmpresa,
  matchesConversationRestartKeyword,
  restartWhatsappConversationToFlowStart,
  syncWhatsappConversationFlowFromCatalog,
} from "@/lib/chat/resolve-whatsapp-active-flow";
import { saveProspectoFromWebhook } from "@/lib/crm/storage";
import type {
  MetaInboundMessage,
  MetaWebhookValue,
  ProcessWebhookResult,
  SupabaseAdmin,
} from "@/lib/chat/types";

/** Solo dígitos, sin prefijo + */
export function normalizeWaPhone(waId: string): string {
  return waId.replace(/\D/g, "");
}

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
  supabase: SupabaseAdmin,
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

  const { data: ch0, error: chErr } = await supabase
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

  let channel = ch0 as
    | { id: string; empresa_id: string; meta_phone_number_id: string; activo: boolean | null }
    | null;

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

  if (!channel && provisionEnv) {
    await provisionChannelFromWebhookEnv(supabase, phoneNumberId, provisionEnv);
    const { data: ch1 } = await supabase
      .from("chat_channels")
      .select("id, empresa_id, meta_phone_number_id, activo")
      .eq("meta_phone_number_id", phoneNumberId)
      .maybeSingle();
    channel = ch1 as typeof channel;
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
        .select("id, status, unread_count, flow_code, flow_current_node, flow_status, human_taken_over")
        .eq("contact_id", contactId)
        .eq("channel_id", channelId)
        .maybeSingle();

      const { message_type, content } = extractMessageBody(msg);
      const preview = content.slice(0, 280);
      const ts = msg.timestamp
        ? new Date(parseInt(msg.timestamp, 10) * 1000).toISOString()
        : new Date().toISOString();

      if (!existingConv) {
        const catalogNew = await listActiveWhatsappFlowsForEmpresa(supabase, empresaId);
        let flowCodeIns: string | null = null;
        let nodeIns: string | null = null;
        if (catalogNew.kind === "single") {
          flowCodeIns = catalogNew.flowCode;
          nodeIns =
            (await getFirstActiveNodeCodeForFlow(supabase, empresaId, flowCodeIns)) ?? "inicio";
          console.info("[webhook/whatsapp][flow-resolve]", "resolved_active_flow", {
            context: "new_conversation_insert",
            empresaId,
            flowCode: flowCodeIns,
            flow_current_node: nodeIns,
          });
        } else if (catalogNew.kind === "multiple") {
          console.error("[webhook/whatsapp][flow-resolve]", "multiple_active_flows", {
            context: "new_conversation_insert",
            empresaId,
            activeFlowCodes: catalogNew.flowCodes,
          });
        } else {
          console.warn("[webhook/whatsapp][flow-resolve]", "no_active_flow_found", {
            context: "new_conversation_insert",
            empresaId,
          });
        }

        const { data: conv, error: convErr } = await supabase
          .from("chat_conversations")
          .insert({
            empresa_id: empresaId,
            channel_id: channelId,
            contact_id: contactId,
            status: "nuevo",
            flow_code: flowCodeIns,
            flow_current_node: nodeIns,
            flow_status: "bot",
            human_taken_over: false,
            last_message_at: null,
            last_message_preview: null,
            unread_count: 0,
          })
          .select("id, status, unread_count, flow_code, flow_current_node, flow_status, human_taken_over")
          .single();

        if (conv) {
          existingConv = conv;
        } else if (convErr?.code === "23505") {
          const { data: again } = await supabase
            .from("chat_conversations")
            .select("id, status, unread_count, flow_code, flow_current_node, flow_status, human_taken_over")
            .eq("contact_id", contactId)
            .eq("channel_id", channelId)
            .maybeSingle();
          if (again) existingConv = again;
        } else if (convErr) {
          errors.push(`Conversación: ${convErr.message}`);
          continue;
        }
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

      if (message_type === "text" && matchesConversationRestartKeyword(content)) {
        console.info(CONV_LOG, "restart_keyword_detected", {
          conversationId,
          preview: content.slice(0, 120),
        });
        const rrKw = await restartWhatsappConversationToFlowStart(supabase, empresaId, conversationId, {
          preferFlowCode: convFlow,
          trigger: "restart_keyword",
        });
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
        const etapaCodigo = await resolveInitialCrmEtapaCodigo(supabase, empresaId);
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

      const { error: insErr } = await supabase.from("chat_messages").insert({
        empresa_id: empresaId,
        conversation_id: conversationId,
        wa_message_id: waMid,
        from_me: false,
        sender_type: "contact",
        message_type,
        content,
        raw_payload: msg as unknown as Record<string, unknown>,
      });

      if (insErr) {
        if (insErr.code === "23505") {
          skipped += 1;
          continue;
        }
        errors.push(`Insert mensaje: ${insErr.message}`);
        continue;
      }

      console.info(logW, "inbound_message_persisted", {
        conversationId,
        waMessageId: waMid,
        message_type,
      });

      const prevStatus = existingConv.status as string;
      const nextStatus = prevStatus === "cerrado" ? "pendiente" : prevStatus;

      await supabase
        .from("chat_conversations")
        .update({
          flow_code: (existingConv as { flow_code?: string | null }).flow_code ?? null,
          flow_current_node: (existingConv as { flow_current_node?: string | null }).flow_current_node ?? null,
          flow_status:
            (existingConv as { flow_status?: string | null }).flow_status ?? "bot",
          human_taken_over:
            (existingConv as { human_taken_over?: boolean | null }).human_taken_over ?? false,
          last_message_at: ts,
          last_message_preview: preview,
          unread_count: (existingConv.unread_count as number) + 1,
          status: nextStatus,
          updated_at: new Date().toISOString(),
        })
        .eq("id", conversationId);

      console.info(logW, "conversation_updated_unread", { conversationId, nextStatus });

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
        if (presentResult.presentedNow) {
          console.info(logW, "skip_text_flow_handler", {
            conversationId,
            reason:
              "Se acaba de enviar la UI del nodo actual; el mismo mensaje no se interpreta como captura",
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
      } else if (message_type === "image") {
        const mediaId = msg.image?.id?.trim() || "";
        if (!mediaId) {
          errors.push("Flow image: message.image.id ausente");
        } else {
          const imageResult = await flowEngine.processImageReply({
            conversationId,
            empresaId,
            mediaId,
            mimeType: msg.image?.mime_type ?? null,
            caption: msg.image?.caption ?? null,
            rawPayload: msg as unknown as Record<string, unknown>,
          });
          console.info(logW, "flow_result: image", {
            conversationId,
            mediaId,
            status: imageResult.status,
            nextNodeCode: imageResult.nextNodeCode ?? null,
          });
          if (!imageResult.ok) {
            errors.push(`Flow image: ${imageResult.error ?? imageResult.status}`);
          }
        }
      } else {
        console.info(logW, "no_typed_flow_handler", {
          conversationId,
          message_type,
        });
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
