"use server";

import {
  SORTEO_COMPROBANTE_ESTADO_VALIDACION_FIELD,
  SORTEO_COMPROBANTE_MOTIVO_VALIDACION_FIELD,
} from "@/lib/chat/comprobante-validation-types";
import { requireEmpresaTenantServiceRole } from "@/lib/chat/empresa-tenant-service-role";
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
  const { supabase, catalogSr, empresa_id, usuario_id } = await requireEmpresaTenantServiceRole();
  let q = supabase
    .from("chat_conversations")
    .select(
      `
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
      flow_status,
      human_taken_over,
      chat_channels ( id, type, nombre ),
      chat_queues ( id, nombre ),
      chat_agents ( id, usuario_id, queue_id, is_online, max_conversations )
    `
    )
    .eq("empresa_id", empresa_id);

  if (vista === "inbox") {
    q = q.in("status", ["open", "pending"]);
  } else if (vista === "bot") {
    q = q.eq("flow_status", "bot").eq("human_taken_over", false);
  }

  const assignment = filters?.assignment ?? "all";
  if (assignment === "mine") {
    const { data: myAgents, error: maErr } = await supabase
      .from("chat_agents")
      .select("id")
      .eq("empresa_id", empresa_id)
      .eq("usuario_id", usuario_id);
    if (maErr) throw new Error(maErr.message);
    const ids = (myAgents ?? []).map((r) => r.id as string);
    if (ids.length === 0) return [];
    q = q.in("assigned_agent_id", ids);
  } else if (assignment === "unassigned") {
    q = q.is("assigned_agent_id", null);
  }

  const fq = filters?.queue_id?.trim();
  if (fq) q = q.eq("queue_id", fq);

  const fs = filters?.status?.trim().toLowerCase();
  if (fs && ["open", "pending", "closed"].includes(fs)) {
    q = q.eq("status", fs);
  }

  const fp = filters?.priority?.trim().toLowerCase();
  if (fp && ["low", "medium", "high"].includes(fp)) {
    q = q.eq("priority", fp);
  }

  const { data: convs, error } = await q.order("last_message_at", {
    ascending: false,
    nullsFirst: false,
  });

  if (error) throw new Error(error.message);
  const list = convs ?? [];
  if (list.length === 0) return [];

  const contactIds = [...new Set(list.map((c) => c.contact_id as string))];
  const { data: contacts, error: e2 } = await supabase
    .from("chat_contacts")
    .select("id, name, phone_number, cliente_id, crm_prospecto_id")
    .in("id", contactIds);

  if (e2) throw new Error(e2.message);
  const byId = Object.fromEntries((contacts ?? []).map((c) => [c.id, c]));

  const agentUserIds = [
    ...new Set(
      list
        .map((row) => {
          const ag = row.chat_agents as { usuario_id?: string } | null | undefined;
          return ag?.usuario_id as string | undefined;
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
    if (uErr) throw new Error(uErr.message);
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

  return list.map((row) => {
    const c = byId[row.contact_id as string];
    const chRaw = row.chat_channels as
      | { id?: string; type?: string; nombre?: string | null }
      | null
      | undefined;
    const channelId = (row.channel_id as string) ?? chRaw?.id ?? "";
    const channelType = (chRaw?.type as string) ?? "whatsapp";
    const channelNombre = (chRaw?.nombre as string | null) ?? null;
    const qRow = row.chat_queues as { id?: string; nombre?: string | null } | null | undefined;
    const ag = row.chat_agents as
      | {
          id?: string;
          usuario_id?: string;
          queue_id?: string;
          chat_queues?: { nombre?: string | null } | null;
        }
      | null
      | undefined;
    const uid = ag?.usuario_id as string | undefined;
    const uMeta = uid ? usuarioNombreById[uid] : undefined;
    const assignedName =
      (uMeta?.nombre?.trim() || uMeta?.email?.trim() || null) as string | null;
    return {
      id: row.id as string,
      status: row.status as string,
      priority: (row.priority as string) ?? "medium",
      queue_id: (row.queue_id as string | null) ?? null,
      queue_name: (qRow?.nombre as string | null) ?? null,
      assigned_agent_id: (row.assigned_agent_id as string | null) ?? null,
      assigned_agent_name: assignedName,
      last_message_at: row.last_message_at as string | null,
      last_message_preview: row.last_message_preview as string | null,
      unread_count: (row.unread_count as number) ?? 0,
      flow_status: String(row.flow_status ?? "bot"),
      human_taken_over: Boolean(row.human_taken_over),
      channel: {
        id: channelId,
        type: channelType,
        nombre: channelNombre,
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
  meta_phone_number_id: string;
  nombre: string | null;
  provider: string;
  provider_channel_id: string | null;
  activo: boolean;
  config: Record<string, unknown>;
  created_at: string;
  updated_at?: string;
};

function mapChatChannelRow(r: Record<string, unknown>): ChatChannelRow {
  return {
    id: r.id as string,
    empresa_id: r.empresa_id as string,
    type: (r.type as string) ?? "whatsapp",
    meta_phone_number_id: (r.meta_phone_number_id as string) ?? "",
    nombre: (r.nombre as string) ?? null,
    provider: (r.provider as string) ?? "meta",
    provider_channel_id: (r.provider_channel_id as string) ?? null,
    activo: r.activo !== false,
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
      "id, empresa_id, type, meta_phone_number_id, nombre, provider, provider_channel_id, activo, config, created_at, updated_at"
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
      "id, empresa_id, type, meta_phone_number_id, nombre, provider, provider_channel_id, activo, config, created_at, updated_at"
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
  /** Se guarda en `config.comprobante_validation` (validación de comprobantes WhatsApp). */
  comprobante_validation?: Record<string, unknown>;
};

/** Crea o actualiza canal WhatsApp (Meta). Devuelve el id del canal. */
export async function saveChatChannel(input: ChatChannelFormInput): Promise<string> {
  const { supabase, empresa_id, dataSchema } = await requireEmpresaTenantServiceRole();
  const pid = input.meta_phone_number_id.trim();
  if (!pid) throw new Error("Phone Number ID es obligatorio");

  const existingId =
    typeof input.id === "string" && input.id.trim().length > 0 ? input.id.trim() : undefined;

  const disp = input.display_phone_number?.trim();

  let config: Record<string, unknown> = { phone_number_id: pid };
  let previousMetaPhone: string | null = null;
  if (existingId) {
    const { data: prevRow } = await supabase
      .from("chat_channels")
      .select("config, meta_phone_number_id")
      .eq("id", existingId)
      .eq("empresa_id", empresa_id)
      .maybeSingle();
    previousMetaPhone =
      (prevRow as { meta_phone_number_id?: string } | null)?.meta_phone_number_id?.trim() || null;
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

  if (input.comprobante_validation !== undefined) {
    config.comprobante_validation = input.comprobante_validation;
  }

  const base = {
    nombre: input.nombre.trim() || "WhatsApp",
    type: "whatsapp" as const,
    meta_phone_number_id: pid,
    provider: "meta",
    provider_channel_id: input.provider_channel_id.trim() || pid,
    activo: input.activo,
    config,
  };

  const tokenPatch = input.whatsapp_access_token?.trim();

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
    .select("meta_phone_number_id")
    .eq("id", id)
    .eq("empresa_id", empresa_id)
    .maybeSingle();
  const { error } = await supabase.from("chat_channels").delete().eq("id", id).eq("empresa_id", empresa_id);
  if (error) throw new Error(error.message);
  const mp = (prev as { meta_phone_number_id?: string } | null)?.meta_phone_number_id?.trim();
  if (mp) await deleteOmnichannelRouteByMetaPhone(mp);
}
