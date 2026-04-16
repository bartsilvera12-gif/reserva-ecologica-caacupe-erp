"use server";

import {
  buildFlowSessionMap,
  isActivelyBotHandledConversation,
  type FlowSessionRowMin,
} from "@/lib/chat/actively-bot-handled";
import {
  SORTEO_COMPROBANTE_ESTADO_VALIDACION_FIELD,
  SORTEO_COMPROBANTE_MOTIVO_VALIDACION_FIELD,
  parseComprobanteValidationConfig,
} from "@/lib/chat/comprobante-validation-types";
import { requireEmpresaTenantServiceRole } from "@/lib/chat/empresa-tenant-service-role";
import { isMissingColumnError } from "@/lib/chat/postgres-column-error";
import {
  appendOmnicanalConversationScopeToQuery,
  getOmnicanalScope,
  shouldBypassOmnicanalConversationScope,
} from "@/lib/chat/omnicanal-scope";
import {
  deleteOmnichannelRouteByMetaPhone,
  syncOmnichannelRouteForWhatsappChannel,
} from "@/lib/chat/omnichannel-route-sync";

export type ConversacionesVista = "inbox" | "bot" | "historial";

export type ChatInboxAssignmentFilter = "all" | "mine" | "unassigned";

export type ChatInboxFilters = {
  assignment?: ChatInboxAssignmentFilter;
  queue_id?: string | null;
  status?: string | null;
  priority?: string | null;
};

export type InboxConversation = {
  id: string;
  status: string;
  priority: string;
  queue_id: string | null;
  queue_name: string | null;
  /** manual_queue | no_eligible_agent cuando queda en cola sin agente; null si hay agente o no aplica. */
  assignment_wait_code: string | null;
  assigned_agent_id: string | null;
  assigned_agent_name: string | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  unread_count: number;
  flow_status: string;
  human_taken_over: boolean;
  channel: {
    id: string;
    type: string;
    nombre: string | null;
    /** Si el canal tiene activada la validación inteligente de comprobantes (UI inbox). */
    comprobante_validation_enabled: boolean;
  };
  contact: {
    id: string;
    name: string | null;
    phone_number: string;
    cliente_id: string | null;
    crm_prospecto_id: string | null;
  };
};

export async function fetchChatConversations(
  vista: ConversacionesVista = "inbox",
  filters?: ChatInboxFilters
): Promise<InboxConversation[]> {
  try {
    return await fetchChatConversationsUnsafe(vista, filters);
  } catch (e) {
    console.error("[fetchChatConversations] fatal (inbox vacío):", e);
    return [];
  }
}

async function fetchChatConversationsUnsafe(
  vista: ConversacionesVista = "inbox",
  filters?: ChatInboxFilters
): Promise<InboxConversation[]> {
  const { supabase, catalogSr, empresa_id, usuario_id } = await requireEmpresaTenantServiceRole();

  const { data: activeFlowRows, error: activeFlowsErr } = await supabase
    .from("chat_flows")
    .select("flow_code")
    .eq("empresa_id", empresa_id)
    .eq("activo", true);
  if (activeFlowsErr) {
    console.warn("[fetchChatConversations] chat_flows activos:", activeFlowsErr.message);
  }
  const activeFlowCodeSet = new Set(
    (activeFlowRows ?? [])
      .map((r) => String((r as { flow_code?: string | null }).flow_code ?? "").trim())
      .filter((c) => c.length > 0)
  );

  if (vista === "bot" && activeFlowCodeSet.size === 0) {
    return [];
  }

  /**
   * Sin embeds desde `chat_conversations`: en esquemas tenant PostgREST suele no tener en caché
   * las FKs hacia `chat_channels` / `chat_queues` / `chat_agents` y falla el select anidado.
   */
  const convSelectWithWait = `
      id,
      status,
      priority,
      queue_id,
      assignment_wait_code,
      assigned_agent_id,
      last_message_at,
      last_message_preview,
      unread_count,
      contact_id,
      channel_id,
      flow_code,
      flow_status,
      human_taken_over,
      active_flow_session_id
    `;
  const convSelectLegacy = `
      id,
      status,
      priority,
      queue_id,
      assigned_agent_id,
      last_message_at,
      last_message_preview,
      unread_count,
      contact_id,
      channel_id,
      flow_code,
      flow_status,
      human_taken_over,
      active_flow_session_id
    `;
  /** Sin `priority` ni `assignment_wait_code` (tenants desalineados). */
  const convSelectLegacyNoPriority = `
      id,
      status,
      queue_id,
      assigned_agent_id,
      last_message_at,
      last_message_preview,
      unread_count,
      contact_id,
      channel_id,
      flow_code,
      flow_status,
      human_taken_over,
      active_flow_session_id
    `;

  const buildFilteredConversationQuery = async (selectStr: string) => {
    let qb = supabase.from("chat_conversations").select(selectStr).eq("empresa_id", empresa_id);

    if (vista === "inbox") {
      qb = qb.in("status", ["open", "pending"]);
    } else if (vista === "bot") {
      qb = qb
        .eq("human_taken_over", false)
        .in("status", ["open", "pending"])
        .not("active_flow_session_id", "is", null);
    } else if (vista === "historial") {
      qb = qb.eq("status", "closed");
    }

    if (vista !== "historial") {
      try {
        const scope = await getOmnicanalScope(supabase, empresa_id, usuario_id);
        const bypass = await shouldBypassOmnicanalConversationScope(catalogSr, usuario_id, scope);
        if (!bypass) {
          qb = await appendOmnicanalConversationScopeToQuery(supabase, empresa_id, scope, qb);
        }
      } catch (e) {
        console.error("[fetchChatConversations] alcance omnicanal omitido (inbox estable):", e);
      }
    }

    const assignment = filters?.assignment ?? "all";
    if (assignment === "mine") {
      let myAgents: { id: string }[] | null = null;
      let maErr = null as { message: string } | null;
      let r = await supabase
        .from("chat_agents")
        .select("id")
        .eq("empresa_id", empresa_id)
        .eq("usuario_id", usuario_id)
        .eq("is_active", true);
      if (r.error && isMissingColumnError(r.error.message, "is_active")) {
        r = await supabase
          .from("chat_agents")
          .select("id")
          .eq("empresa_id", empresa_id)
          .eq("usuario_id", usuario_id);
      }
      myAgents = r.data as { id: string }[] | null;
      maErr = r.error;
      if (maErr) {
        console.warn(
          "[fetchChatConversations] no se pudo cargar chat_agents para filtro «mios»; se listan todas:",
          maErr.message
        );
      } else {
        const ids = (myAgents ?? []).map((row) => row.id as string);
        if (ids.length > 0) {
          qb = qb.in("assigned_agent_id", ids);
        } else {
          console.warn(
            "[fetchChatConversations] filtro «mios» sin filas en chat_agents para el usuario; se listan todas las conversaciones"
          );
        }
      }
    } else if (assignment === "unassigned") {
      qb = qb.is("assigned_agent_id", null);
    }

    const fq = filters?.queue_id?.trim();
    if (fq) qb = qb.eq("queue_id", fq);

    const fs = filters?.status?.trim().toLowerCase();
    if (fs && ["open", "pending", "closed"].includes(fs)) {
      qb = qb.eq("status", fs);
    }

    const fp = filters?.priority?.trim().toLowerCase();
    if (fp && ["low", "medium", "high"].includes(fp)) {
      qb = qb.eq("priority", fp);
    }

    return qb;
  };

  /* PostgREST + scope async: el builder se ensancha a `any` para encadenar `.order` sin choque de genéricos. */
  let q: any = await buildFilteredConversationQuery(convSelectWithWait);
  let { data: convs, error } = await q.order("last_message_at", {
    ascending: false,
    nullsFirst: false,
  });

  if (error && isMissingColumnError(error.message, "assignment_wait_code")) {
    console.warn("[fetchChatConversations] assignment_wait_code ausente; reintento sin columna");
    q = await buildFilteredConversationQuery(convSelectLegacy);
    ({ data: convs, error } = await q.order("last_message_at", {
      ascending: false,
      nullsFirst: false,
    }));
  }

  if (error) {
    console.warn("[fetchChatConversations] reintento select mínimo sin priority ni assignment_wait_code");
    q = await buildFilteredConversationQuery(convSelectLegacyNoPriority);
    ({ data: convs, error } = await q.order("last_message_at", {
      ascending: false,
      nullsFirst: false,
    }));
  }

  if (error) {
    console.warn("[fetchChatConversations] listado conversaciones no disponible:", error.message);
    return [];
  }
  let list = (convs ?? []) as Record<string, unknown>[];
  const totalAfterQuery = list.length;

  const sessionIds = [
    ...new Set(
      list
        .map((row: Record<string, unknown>) =>
          String((row as { active_flow_session_id?: string | null }).active_flow_session_id ?? "").trim()
        )
        .filter((id: string) => id.length > 0)
    ),
  ];
  const flowSessionById = new Map<string, FlowSessionRowMin>();
  const sessionChunk = 100;
  for (let i = 0; i < sessionIds.length; i += sessionChunk) {
    const chunk = sessionIds.slice(i, i + sessionChunk);
    const { data: sessRows, error: sessErr } = await supabase
      .from("chat_flow_sessions")
      .select("id, status, flow_code, conversation_id")
      .eq("empresa_id", empresa_id)
      .in("id", chunk);
    if (sessErr) {
      console.warn("[fetchChatConversations] chat_flow_sessions:", sessErr.message);
      continue;
    }
    for (const [k, v] of buildFlowSessionMap(sessRows as FlowSessionRowMin[]).entries()) {
      flowSessionById.set(k, v);
    }
  }

  const isActivelyBot = (row: Record<string, unknown>) =>
    isActivelyBotHandledConversation(row, activeFlowCodeSet, flowSessionById);

  let classifiedAsActivelyBot = 0;
  if (vista === "inbox") {
    list = list.filter((row) => {
      const b = isActivelyBot(row as Record<string, unknown>);
      if (b) classifiedAsActivelyBot += 1;
      return !b;
    });
  } else if (vista === "bot") {
    list = list.filter((row) => {
      const b = isActivelyBot(row as Record<string, unknown>);
      if (b) classifiedAsActivelyBot += 1;
      return b;
    });
  }

  const botCount = vista === "bot" ? list.length : classifiedAsActivelyBot;
  const inboxCount = vista === "inbox" ? list.length : totalAfterQuery - list.length;
  console.log("[BOT-LIST]", {
    vista,
    empresa_id,
    total: totalAfterQuery,
    botCount,
    inboxCount,
    sessionMapSize: flowSessionById.size,
    activeFlowCodes: activeFlowCodeSet.size,
  });

  if (list.length === 0) return [];

  const channelIds = [
    ...new Set(
      list
        .map((c) => (c.channel_id as string | null | undefined)?.trim())
        .filter((x): x is string => Boolean(x && x.length > 0))
    ),
  ];

  let channelById: Record<
    string,
    { type: string; nombre: string | null; comprobante_validation_enabled: boolean }
  > = {};
  if (channelIds.length > 0) {
    const { data: chrows, error: chErr } = await supabase
      .from("chat_channels")
      .select("id, type, nombre, config")
      .eq("empresa_id", empresa_id)
      .in("id", channelIds);
    if (chErr) {
      console.warn("[fetchChatConversations] chat_channels:", chErr.message);
    } else {
      channelById = Object.fromEntries(
        (chrows ?? []).map((r) => {
          const rec = r as {
            id: string;
            type?: string | null;
            nombre?: string | null;
            config?: unknown;
          };
          const cfg = rec.config;
          const compOn =
            cfg && typeof cfg === "object" && !Array.isArray(cfg)
              ? parseComprobanteValidationConfig(cfg as Record<string, unknown>).enabled
              : false;
          return [
            rec.id,
            {
              type: (rec.type as string) ?? "whatsapp",
              nombre: rec.nombre ?? null,
              comprobante_validation_enabled: compOn,
            },
          ];
        })
      );
    }
  }

  const queueIds = [
    ...new Set(
      list
        .map((c) => (c.queue_id as string | null | undefined)?.trim())
        .filter((x): x is string => Boolean(x && x.length > 0))
    ),
  ];
  const assignedAgentIds = [
    ...new Set(
      list
        .map((c) => (c.assigned_agent_id as string | null | undefined)?.trim())
        .filter((x): x is string => Boolean(x && x.length > 0))
    ),
  ];

  let queueNombreById: Record<string, string | null> = {};
  if (queueIds.length > 0) {
    const { data: qrows, error: qErr } = await supabase
      .from("chat_queues")
      .select("id, nombre")
      .eq("empresa_id", empresa_id)
      .in("id", queueIds);
    if (qErr) {
      console.warn("[fetchChatConversations] chat_queues:", qErr.message);
    } else {
      queueNombreById = Object.fromEntries(
        (qrows ?? []).map((r) => [r.id as string, (r as { nombre?: string | null }).nombre ?? null])
      );
    }
  }

  let agentUsuarioById: Record<string, string> = {};
  if (assignedAgentIds.length > 0) {
    const { data: arows, error: aErr } = await supabase
      .from("chat_agents")
      .select("id, usuario_id")
      .eq("empresa_id", empresa_id)
      .in("id", assignedAgentIds);
    if (aErr) {
      console.warn("[fetchChatConversations] chat_agents (enriquecido):", aErr.message);
    } else {
      agentUsuarioById = Object.fromEntries(
        (arows ?? []).map((r) => [r.id as string, (r as { usuario_id: string }).usuario_id])
      );
    }
  }

  const contactIds = [
    ...new Set(
      list
        .map((c) => (c.contact_id as string | null | undefined)?.trim())
        .filter((x): x is string => Boolean(x && x.length > 0))
    ),
  ];
  let byId: Record<string, Record<string, unknown>> = {};
  if (contactIds.length > 0) {
    const { data: contacts, error: e2 } = await supabase
      .from("chat_contacts")
      .select("id, name, phone_number, cliente_id, crm_prospecto_id")
      .eq("empresa_id", empresa_id)
      .in("id", contactIds);

    if (e2) {
      console.warn("[fetchChatConversations] chat_contacts:", e2.message);
    } else {
      byId = Object.fromEntries((contacts ?? []).map((c) => [c.id, c as Record<string, unknown>]));
    }
  }

  const agentUserIds = [
    ...new Set(
      list
        .map((row) => {
          const aid = (row.assigned_agent_id as string | null | undefined)?.trim();
          const uid = aid ? agentUsuarioById[aid] : undefined;
          return uid;
        })
        .filter(Boolean) as string[]
    ),
  ];

  let usuarioNombreById: Record<string, { nombre: string | null; email: string | null }> = {};
  if (agentUserIds.length > 0) {
    const { data: urows, error: uErr } = await catalogSr
      .from("usuarios")
      .select("id, nombre, email")
      .in("id", agentUserIds);
    if (uErr) {
      console.warn("[fetchChatConversations] usuarios (catálogo):", uErr.message);
    } else {
      usuarioNombreById = Object.fromEntries(
        (urows ?? []).map((u) => [
          u.id as string,
          {
            nombre: (u as { nombre?: string | null }).nombre ?? null,
            email: (u as { email?: string | null }).email ?? null,
          },
        ])
      );
    }
  }

  return list.map((row) => {
    const c = byId[row.contact_id as string] as
      | { id?: string; name?: string | null; phone_number?: string; cliente_id?: string | null; crm_prospecto_id?: string | null }
      | undefined;
    const cid = (row.channel_id as string | null | undefined)?.trim() ?? "";
    const chMeta = cid ? channelById[cid] : undefined;
    const channelId = cid;
    const channelType = chMeta?.type ?? "whatsapp";
    const channelNombre = chMeta?.nombre ?? null;
    const compValEnabled = chMeta?.comprobante_validation_enabled ?? false;
    const qid = (row.queue_id as string | null | undefined)?.trim() || null;
    const qRowNombre = qid ? queueNombreById[qid] : null;
    const waitCode = ((row as { assignment_wait_code?: string | null }).assignment_wait_code ?? null) as
      | string
      | null;
    const aid = (row.assigned_agent_id as string | null | undefined)?.trim();
    const uid = aid ? agentUsuarioById[aid] : undefined;
    const uMeta = uid ? usuarioNombreById[uid] : undefined;
    const assignedName =
      (uMeta?.nombre?.trim() || uMeta?.email?.trim() || null) as string | null;
    return {
      id: row.id as string,
      status: row.status as string,
      priority: (row.priority as string) ?? "medium",
      queue_id: (row.queue_id as string | null) ?? null,
      queue_name: qRowNombre ?? null,
      assignment_wait_code: typeof waitCode === "string" && waitCode.trim() ? waitCode.trim() : null,
      assigned_agent_id: (row.assigned_agent_id as string | null) ?? null,
      assigned_agent_name: assignedName,
      last_message_at: row.last_message_at as string | null,
      last_message_preview: row.last_message_preview as string | null,
      unread_count: (row.unread_count as number) ?? 0,
      flow_status: String((row as { flow_status?: string | null }).flow_status ?? ""),
      human_taken_over: Boolean(row.human_taken_over),
      channel: {
        id: channelId,
        type: channelType,
        nombre: channelNombre,
        comprobante_validation_enabled: compValEnabled,
      },
      contact: {
        id: c?.id ?? (row.contact_id as string),
        name: c?.name ?? null,
        phone_number: c?.phone_number ?? "",
        cliente_id: c?.cliente_id ?? null,
        crm_prospecto_id: c?.crm_prospecto_id ?? null,
      },
    };
  });
}

/** True si la empresa tiene al menos un flujo de chat activo (tab Bot en inbox). */
export async function hasEmpresaActiveChatFlows(): Promise<boolean> {
  const { supabase, empresa_id } = await requireEmpresaTenantServiceRole();
  const { count, error } = await supabase
    .from("chat_flows")
    .select("id", { count: "exact", head: true })
    .eq("empresa_id", empresa_id)
    .eq("activo", true);
  if (error) return false;
  return (count ?? 0) > 0;
}

/**
 * Vuelve a modo bot (solo operador). No reinicia el flujo ni la sesión.
 */
export async function releaseConversationToBot(conversationId: string): Promise<void> {
  const { supabase, empresa_id } = await requireEmpresaTenantServiceRole();
  const id = conversationId.trim();
  if (!id) throw new Error("ID inválido");

  const { error } = await supabase
    .from("chat_conversations")
    .update({
      human_taken_over: false,
      flow_status: "bot",
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("empresa_id", empresa_id);

  if (error) throw new Error(error.message);
}

export async function markConversationRead(conversationId: string): Promise<void> {
  const { supabase, empresa_id } = await requireEmpresaTenantServiceRole();
  const { error } = await supabase
    .from("chat_conversations")
    .update({ unread_count: 0, updated_at: new Date().toISOString() })
    .eq("id", conversationId)
    .eq("empresa_id", empresa_id);

  if (error) throw new Error(error.message);
}

export type ChatChannelRow = {
  id: string;
  empresa_id: string;
  type: string;
  meta_phone_number_id: string | null;
  nombre: string | null;
  provider: string;
  provider_channel_id: string | null;
  activo: boolean;
  connection_mode: string | null;
  config_status: string;
  config: Record<string, unknown>;
  created_at: string;
  updated_at?: string;
};

function mapChatChannelRow(r: Record<string, unknown>): ChatChannelRow {
  const mp = r.meta_phone_number_id;
  return {
    id: r.id as string,
    empresa_id: r.empresa_id as string,
    type: (r.type as string) ?? "whatsapp",
    meta_phone_number_id: typeof mp === "string" ? mp : mp != null ? String(mp) : null,
    nombre: (r.nombre as string) ?? null,
    provider: (r.provider as string) ?? "meta",
    provider_channel_id: (r.provider_channel_id as string) ?? null,
    activo: r.activo !== false,
    connection_mode: (r.connection_mode as string | null) ?? null,
    config_status: (r.config_status as string) ?? "incomplete",
    config: (typeof r.config === "object" && r.config !== null ? r.config : {}) as Record<string, unknown>,
    created_at: (r.created_at as string) ?? "",
    updated_at: r.updated_at as string | undefined,
  };
}

export async function fetchChatChannels(): Promise<ChatChannelRow[]> {
  const { supabase, empresa_id } = await requireEmpresaTenantServiceRole();
  const { data, error } = await supabase
    .from("chat_channels")
    .select(
      "id, empresa_id, type, meta_phone_number_id, nombre, provider, provider_channel_id, activo, connection_mode, config_status, config, created_at, updated_at"
    )
    .eq("empresa_id", empresa_id)
    .order("created_at", { ascending: true });

  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => mapChatChannelRow(r as Record<string, unknown>));
}

export async function fetchChatChannelById(channelId: string): Promise<ChatChannelRow | null> {
  const { supabase, empresa_id } = await requireEmpresaTenantServiceRole();
  const id = channelId.trim();
  if (!id) return null;
  const { data, error } = await supabase
    .from("chat_channels")
    .select(
      "id, empresa_id, type, meta_phone_number_id, nombre, provider, provider_channel_id, activo, connection_mode, config_status, config, created_at, updated_at"
    )
    .eq("id", id)
    .eq("empresa_id", empresa_id)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;
  return mapChatChannelRow(data as Record<string, unknown>);
}

export type ChatChannelFormInput = {
  id?: string;
  nombre: string;
  meta_phone_number_id: string;
  provider_channel_id: string;
  activo: boolean;
  display_phone_number?: string;
  /** Token Meta para enviar desde el ERP; en edición, vacío = no cambiar el guardado */
  whatsapp_access_token?: string;
  /** Opcionales Cloud API (se persisten en `config`). */
  meta_waba_id?: string;
  meta_app_id?: string;
  meta_verify_token?: string;
  /** Se guarda en `config.comprobante_validation` (validación de comprobantes WhatsApp). */
  comprobante_validation?: Record<string, unknown>;
  /** Mensajes automáticos livianos en `config.business_automation` (no es chat_flows). */
  business_automation?: Record<string, unknown>;
  /** Estado UI de secciones del formulario en `config.form_section_state`. */
  form_section_state?: Record<string, { active: boolean; expanded: boolean }>;
};

function metaChannelConfigStatus(params: {
  activo: boolean;
  phoneId: string;
  hasAccessToken: boolean;
}): "inactive" | "incomplete" | "active" {
  if (!params.activo) return "inactive";
  if (!params.phoneId) return "incomplete";
  if (!params.hasAccessToken) return "incomplete";
  return "active";
}

export type YCloudWhatsappChannelInput = {
  id?: string;
  nombre: string;
  activo: boolean;
  ycloud_api_key?: string;
  ycloud_webhook_secret?: string;
  ycloud_sender_id?: string;
  ycloud_channel_id?: string;
  /** Misma persistencia que Meta: validación de comprobantes, automatización, estado UI de secciones. */
  comprobante_validation?: Record<string, unknown>;
  business_automation?: Record<string, unknown>;
  form_section_state?: Record<string, { active: boolean; expanded: boolean }>;
};

/** WhatsApp vía YCloud (coexistencia). Sin ruta omnicanal Meta. */
export async function saveYCloudWhatsappChannel(input: YCloudWhatsappChannelInput): Promise<string> {
  const { supabase, empresa_id } = await requireEmpresaTenantServiceRole();
  const existingId = typeof input.id === "string" && input.id.trim().length > 0 ? input.id.trim() : undefined;
  let config: Record<string, unknown> = {};
  if (existingId) {
    const { data: prevRow } = await supabase
      .from("chat_channels")
      .select("config")
      .eq("id", existingId)
      .eq("empresa_id", empresa_id)
      .maybeSingle();
    const prev =
      prevRow?.config &&
      typeof prevRow.config === "object" &&
      prevRow.config !== null &&
      !Array.isArray(prevRow.config)
        ? ({ ...(prevRow.config as Record<string, unknown>) } as Record<string, unknown>)
        : {};
    config = { ...prev };
  }
  const keyPatch = input.ycloud_api_key?.trim();
  if (keyPatch) config.ycloud_api_key = keyPatch;
  if (input.ycloud_webhook_secret !== undefined) {
    const s = input.ycloud_webhook_secret.trim();
    if (s) config.ycloud_webhook_secret = s;
  }
  if (input.ycloud_sender_id !== undefined) {
    const s = input.ycloud_sender_id.trim();
    if (s) config.ycloud_sender_id = s;
  }
  if (input.ycloud_channel_id !== undefined) {
    const s = input.ycloud_channel_id.trim();
    if (s) config.ycloud_channel_id = s;
  }

  if (input.comprobante_validation !== undefined) {
    config.comprobante_validation = input.comprobante_validation;
  }
  if (input.business_automation !== undefined) {
    config.business_automation = input.business_automation;
  }
  if (input.form_section_state !== undefined) {
    config.form_section_state = input.form_section_state;
  }

  const hasKey =
    Boolean(keyPatch) ||
    Boolean(
      typeof config.ycloud_api_key === "string" && (config.ycloud_api_key as string).trim().length > 0
    );
  const config_status: "inactive" | "incomplete" | "active" = !input.activo
    ? "inactive"
    : hasKey
      ? "active"
      : "incomplete";

  const base = {
    nombre: input.nombre.trim() || "WhatsApp (YCloud)",
    type: "whatsapp" as const,
    meta_phone_number_id: null as string | null,
    provider: "ycloud",
    provider_channel_id: (input.ycloud_channel_id?.trim() || input.ycloud_sender_id?.trim() || null) as
      | string
      | null,
    activo: input.activo,
    connection_mode: "coexistence",
    config_status,
    config,
  };

  if (existingId) {
    const { data: updated, error } = await supabase
      .from("chat_channels")
      .update({ ...base, updated_at: new Date().toISOString() })
      .eq("id", existingId)
      .eq("empresa_id", empresa_id)
      .select("id")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!updated) throw new Error("No se pudo actualizar el canal.");
    return existingId;
  }

  const { data: inserted, error } = await supabase
    .from("chat_channels")
    .insert({
      empresa_id,
      ...base,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  const newId = inserted?.id as string | undefined;
  if (!newId) throw new Error("No se pudo crear el canal.");
  return newId;
}

export type GenericOmnichannelChannelInput = {
  id?: string;
  type: "instagram" | "facebook" | "linkedin" | "email";
  nombre: string;
  provider: string;
  activo: boolean;
  config?: Record<string, unknown>;
};

/** Canal no WhatsApp: registro base para Etapa 2 (sin phone Meta). */
export async function saveGenericOmnichannelChannel(input: GenericOmnichannelChannelInput): Promise<string> {
  const { supabase, empresa_id } = await requireEmpresaTenantServiceRole();
  const existingId = typeof input.id === "string" && input.id.trim().length > 0 ? input.id.trim() : undefined;
  let config: Record<string, unknown> = input.config ? { ...input.config } : {};
  if (existingId) {
    const { data: prevRow } = await supabase
      .from("chat_channels")
      .select("config")
      .eq("id", existingId)
      .eq("empresa_id", empresa_id)
      .maybeSingle();
    const prev =
      prevRow?.config &&
      typeof prevRow.config === "object" &&
      prevRow.config !== null &&
      !Array.isArray(prevRow.config)
        ? ({ ...(prevRow.config as Record<string, unknown>) } as Record<string, unknown>)
        : {};
    config = { ...prev, ...config };
  }

  const config_status: "inactive" | "incomplete" | "active" = !input.activo
    ? "inactive"
    : "incomplete";

  const base = {
    nombre: input.nombre.trim() || input.type,
    type: input.type,
    meta_phone_number_id: null as string | null,
    provider: (input.provider || "meta").trim() || "meta",
    provider_channel_id: null as string | null,
    activo: input.activo,
    connection_mode: "standard" as const,
    config_status,
    config,
  };

  if (existingId) {
    const { data: updated, error } = await supabase
      .from("chat_channels")
      .update({ ...base, updated_at: new Date().toISOString() })
      .eq("id", existingId)
      .eq("empresa_id", empresa_id)
      .select("id")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!updated) throw new Error("No se pudo actualizar el canal.");
    return existingId;
  }

  const { data: inserted, error } = await supabase
    .from("chat_channels")
    .insert({
      empresa_id,
      ...base,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  const newId = inserted?.id as string | undefined;
  if (!newId) throw new Error("No se pudo crear el canal.");
  return newId;
}

/** Crea o actualiza canal WhatsApp Cloud API (Meta). Devuelve el id del canal. */
export async function saveChatChannel(input: ChatChannelFormInput): Promise<string> {
  const { supabase, empresa_id, dataSchema } = await requireEmpresaTenantServiceRole();
  const pid = input.meta_phone_number_id.trim();
  if (!pid) throw new Error("Phone Number ID es obligatorio");

  const existingId =
    typeof input.id === "string" && input.id.trim().length > 0 ? input.id.trim() : undefined;

  const disp = input.display_phone_number?.trim();

  let config: Record<string, unknown> = { phone_number_id: pid };
  let previousMetaPhone: string | null = null;
  let existingToken: string | null = null;
  if (existingId) {
    const { data: prevRow } = await supabase
      .from("chat_channels")
      .select("config, meta_phone_number_id, whatsapp_access_token")
      .eq("id", existingId)
      .eq("empresa_id", empresa_id)
      .maybeSingle();
    previousMetaPhone =
      (prevRow as { meta_phone_number_id?: string | null } | null)?.meta_phone_number_id?.trim() || null;
    existingToken =
      (prevRow as { whatsapp_access_token?: string | null } | null)?.whatsapp_access_token?.trim() || null;
    const prev =
      prevRow?.config &&
      typeof prevRow.config === "object" &&
      prevRow.config !== null &&
      !Array.isArray(prevRow.config)
        ? ({ ...(prevRow.config as Record<string, unknown>) } as Record<string, unknown>)
        : {};
    config = { ...prev, phone_number_id: pid };
    if (disp) config.display_phone_number = disp;
  } else if (disp) {
    config.display_phone_number = disp;
  }

  const waba = input.meta_waba_id?.trim();
  if (waba) config.meta_waba_id = waba;
  const appId = input.meta_app_id?.trim();
  if (appId) config.meta_app_id = appId;
  const verify = input.meta_verify_token?.trim();
  if (verify) config.meta_verify_token = verify;

  if (input.comprobante_validation !== undefined) {
    config.comprobante_validation = input.comprobante_validation;
  }
  if (input.business_automation !== undefined) {
    config.business_automation = input.business_automation;
  }
  if (input.form_section_state !== undefined) {
    config.form_section_state = input.form_section_state;
  }

  const tokenPatch = input.whatsapp_access_token?.trim();
  const hasAccessToken = Boolean(tokenPatch) || Boolean(existingToken);

  const config_status = metaChannelConfigStatus({
    activo: input.activo,
    phoneId: pid,
    hasAccessToken,
  });

  const base = {
    nombre: input.nombre.trim() || "WhatsApp",
    type: "whatsapp" as const,
    meta_phone_number_id: pid,
    provider: "meta",
    provider_channel_id: input.provider_channel_id.trim() || pid,
    activo: input.activo,
    connection_mode: "official",
    config_status,
    config,
  };

  if (existingId) {
    const updatePayload: Record<string, unknown> = {
      ...base,
      updated_at: new Date().toISOString(),
    };
    if (tokenPatch) {
      updatePayload.whatsapp_access_token = tokenPatch;
    }
    const { data: updated, error } = await supabase
      .from("chat_channels")
      .update(updatePayload)
      .eq("id", existingId)
      .eq("empresa_id", empresa_id)
      .select("id")
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!updated) {
      throw new Error("No se pudo actualizar el canal (¿pertenece a tu empresa?).");
    }
    if (previousMetaPhone && previousMetaPhone !== pid) {
      await deleteOmnichannelRouteByMetaPhone(previousMetaPhone);
    }
    await syncOmnichannelRouteForWhatsappChannel({
      metaPhoneNumberId: pid,
      empresaId: empresa_id,
      channelId: existingId,
      activo: input.activo,
      dataSchema,
    });
    return existingId;
  }

  const { data: inserted, error } = await supabase
    .from("chat_channels")
    .insert({
      empresa_id,
      ...base,
      whatsapp_access_token: tokenPatch || null,
    })
    .select("id")
    .single();

  if (error) throw new Error(error.message);
  const newId = inserted?.id as string | undefined;
  if (!newId) throw new Error("No se pudo obtener el id del canal creado.");
  await syncOmnichannelRouteForWhatsappChannel({
    metaPhoneNumberId: pid,
    empresaId: empresa_id,
    channelId: newId,
    activo: input.activo,
    dataSchema,
  });
  return newId;
}

export type ComprobanteValidacionListRow = {
  id: string;
  estado_validacion: string;
  motivo_validacion: string | null;
  comprobante_url: string | null;
  flow_code: string;
  created_at: string;
  ocr_referencia: string | null;
  ocr_monto: string | null;
  monto_validacion_esperado_gs: number | null;
  monto_validacion_ocr_gs: number | null;
  monto_validacion_diferencia_gs: number | null;
  monto_validacion_status: string | null;
  bank_val_titular_esperado: string | null;
  bank_val_cuenta_esperada: string | null;
  bank_val_alias_esperado: string | null;
  bank_val_titular_ocr: string | null;
  bank_val_cuenta_ocr: string | null;
  bank_val_alias_ocr: string | null;
  bank_val_coincidencias: number | null;
  bank_val_min_requeridas: number | null;
  bank_val_status: string | null;
};

export async function fetchComprobanteValidacionesForConversation(
  conversationId: string
): Promise<ComprobanteValidacionListRow[]> {
  const { supabase, empresa_id } = await requireEmpresaTenantServiceRole();
  const cid = conversationId.trim();
  if (!cid) return [];

  const { data: conv, error: cErr } = await supabase
    .from("chat_conversations")
    .select("id")
    .eq("id", cid)
    .eq("empresa_id", empresa_id)
    .maybeSingle();
  if (cErr) throw new Error(cErr.message);
  if (!conv) return [];

  const { data, error } = await supabase
    .from("chat_comprobante_validaciones")
    .select(
      "id, estado_validacion, motivo_validacion, comprobante_url, flow_code, created_at, ocr_referencia, ocr_monto, monto_validacion_esperado_gs, monto_validacion_ocr_gs, monto_validacion_diferencia_gs, monto_validacion_status, bank_val_titular_esperado, bank_val_cuenta_esperada, bank_val_alias_esperado, bank_val_titular_ocr, bank_val_cuenta_ocr, bank_val_alias_ocr, bank_val_coincidencias, bank_val_min_requeridas, bank_val_status"
    )
    .eq("conversation_id", cid)
    .eq("empresa_id", empresa_id)
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as ComprobanteValidacionListRow[];
}

export async function approveComprobanteValidacion(validacionId: string): Promise<void> {
  const { supabase, empresa_id } = await requireEmpresaTenantServiceRole();
  const id = validacionId.trim();
  if (!id) throw new Error("ID de validación inválido");

  const { data: row, error: qErr } = await supabase
    .from("chat_comprobante_validaciones")
    .select("id, conversation_id, flow_code, flow_session_id")
    .eq("id", id)
    .eq("empresa_id", empresa_id)
    .maybeSingle();

  if (qErr) throw new Error(qErr.message);
  if (!row) throw new Error("Validación no encontrada");

  const r = row as {
    id: string;
    conversation_id: string;
    flow_code: string;
    flow_session_id: string;
  };

  const now = new Date().toISOString();
  const { error: uErr } = await supabase
    .from("chat_comprobante_validaciones")
    .update({
      estado_validacion: "valido",
      motivo_validacion: "aprobado_manual_erp",
      updated_at: now,
    })
    .eq("id", id)
    .eq("empresa_id", empresa_id);

  if (uErr) throw new Error(uErr.message);

  const upserts = [
    {
      empresa_id,
      conversation_id: r.conversation_id,
      flow_code: r.flow_code.trim(),
      flow_session_id: r.flow_session_id,
      field_name: SORTEO_COMPROBANTE_ESTADO_VALIDACION_FIELD,
      field_value: "valido",
    },
    {
      empresa_id,
      conversation_id: r.conversation_id,
      flow_code: r.flow_code.trim(),
      flow_session_id: r.flow_session_id,
      field_name: SORTEO_COMPROBANTE_MOTIVO_VALIDACION_FIELD,
      field_value: "aprobado_manual_erp",
    },
  ];

  const { error: dErr } = await supabase.from("chat_flow_data").upsert(upserts, {
    onConflict: "flow_session_id,field_name",
  });
  if (dErr) throw new Error(dErr.message);
}

export async function deleteChatChannel(id: string): Promise<void> {
  const { supabase, empresa_id } = await requireEmpresaTenantServiceRole();
  const { data: prev } = await supabase
    .from("chat_channels")
    .select("meta_phone_number_id, provider")
    .eq("id", id)
    .eq("empresa_id", empresa_id)
    .maybeSingle();
  const { error } = await supabase.from("chat_channels").delete().eq("id", id).eq("empresa_id", empresa_id);
  if (error) throw new Error(error.message);
  const prov = String((prev as { provider?: string | null } | null)?.provider ?? "meta").toLowerCase();
  const mp = (prev as { meta_phone_number_id?: string | null } | null)?.meta_phone_number_id?.trim();
  if (mp && prov === "meta") await deleteOmnichannelRouteByMetaPhone(mp);
}
