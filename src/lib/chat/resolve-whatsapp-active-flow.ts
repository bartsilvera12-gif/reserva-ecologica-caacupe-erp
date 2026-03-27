import type { SupabaseAdmin } from "@/lib/chat/types";

const LOG = "[webhook/whatsapp][flow-resolve]" as const;
export const CONV_LOG = "[webhook/whatsapp][conversation]" as const;

export type ActiveFlowsCatalogResult =
  | { kind: "single"; flowCode: string }
  | { kind: "none" }
  | { kind: "multiple"; flowCodes: string[] };

/**
 * Flujos marcados activos en catálogo para canal WhatsApp de la empresa.
 */
export async function listActiveWhatsappFlowsForEmpresa(
  supabase: SupabaseAdmin,
  empresaId: string
): Promise<ActiveFlowsCatalogResult> {
  const { data, error } = await supabase
    .from("chat_flows")
    .select("flow_code")
    .eq("empresa_id", empresaId)
    .eq("channel", "whatsapp")
    .eq("activo", true)
    .order("flow_code", { ascending: true });

  if (error) {
    console.error(LOG, "catalog_query_failed", { empresaId, message: error.message });
    throw new Error(error.message);
  }

  const codes = [...new Set((data ?? []).map((r) => String((r as { flow_code?: string }).flow_code ?? "").trim()).filter(Boolean))];
  if (codes.length === 0) return { kind: "none" };
  if (codes.length === 1) return { kind: "single", flowCode: codes[0] };
  return { kind: "multiple", flowCodes: codes };
}

/**
 * Primer nodo activo del flujo (sort_order, luego created_at). Sin filas → null.
 */
export async function getFirstActiveNodeCodeForFlow(
  supabase: SupabaseAdmin,
  empresaId: string,
  flowCode: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from("chat_flow_nodes")
    .select("node_code, sort_order, created_at")
    .eq("empresa_id", empresaId)
    .eq("flow_code", flowCode)
    .eq("is_active", true)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(1);

  if (error) {
    console.error(LOG, "first_node_query_failed", { empresaId, flowCode, message: error.message });
    return null;
  }
  const row = data?.[0] as { node_code?: string } | undefined;
  return row?.node_code?.trim() || null;
}

export type SyncConversationFlowResult = {
  flow_code: string | null;
  flow_current_node: string | null;
  changed: boolean;
};

/**
 * Asigna o corrige flow_code / nodo inicial según catálogo activo.
 * - Un solo flujo activo: usa ese (nueva conv o conv con flujo inexistente/inactivo en catálogo).
 * - Varios activos: solo mantiene la conv si su flow_code ya está entre los activos; si no, no elige al azar.
 * - Ninguno activo: no rompe; deja la conv tal cual y loguea no_active_flow_found.
 */
export async function syncWhatsappConversationFlowFromCatalog(
  supabase: SupabaseAdmin,
  empresaId: string,
  conversationId: string,
  conv: { flow_code: string | null; flow_current_node: string | null }
): Promise<SyncConversationFlowResult> {
  const currentFlow = conv.flow_code?.trim() || null;
  const currentNode = conv.flow_current_node?.trim() || null;

  const catalog = await listActiveWhatsappFlowsForEmpresa(supabase, empresaId);

  if (catalog.kind === "none") {
    console.warn(LOG, "no_active_flow_found", { empresaId, conversationId, currentFlow });
    return { flow_code: currentFlow, flow_current_node: currentNode, changed: false };
  }

  if (catalog.kind === "multiple") {
    if (currentFlow && catalog.flowCodes.includes(currentFlow)) {
      console.info(LOG, "resolved_active_flow", {
        empresaId,
        conversationId,
        flowCode: currentFlow,
        reason: "conversation_flow_already_among_multiple_active",
      });
      return { flow_code: currentFlow, flow_current_node: currentNode, changed: false };
    }
    console.error(LOG, "multiple_active_flows", {
      empresaId,
      conversationId,
      activeFlowCodes: catalog.flowCodes,
      conversationFlow: currentFlow,
    });
    return { flow_code: currentFlow, flow_current_node: currentNode, changed: false };
  }

  const targetFlow = catalog.flowCode;

  if (currentFlow === targetFlow) {
    console.info(LOG, "resolved_active_flow", {
      empresaId,
      conversationId,
      flowCode: targetFlow,
      flow_current_node: currentNode,
      action: "unchanged_single_active_match",
    });
    return { flow_code: targetFlow, flow_current_node: currentNode, changed: false };
  }

  const firstNode = (await getFirstActiveNodeCodeForFlow(supabase, empresaId, targetFlow)) ?? "inicio";

  if (currentFlow) {
    console.warn(LOG, "previous_flow_inactive", {
      conversationId,
      previousFlow: currentFlow,
      previousNode: currentNode,
      targetFlow,
      targetInitialNode: firstNode,
    });
  }

  console.info(LOG, "resolved_active_flow", {
    empresaId,
    conversationId,
    flowCode: targetFlow,
    flow_current_node: firstNode,
    action: "assign_single_active_flow",
  });

  const { error: updErr } = await supabase
    .from("chat_conversations")
    .update({
      flow_code: targetFlow,
      flow_current_node: firstNode,
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversationId)
    .eq("empresa_id", empresaId);

  if (updErr) {
    console.error(LOG, "conversation_flow_update_failed", { conversationId, message: updErr.message });
    return { flow_code: currentFlow, flow_current_node: currentNode, changed: false };
  }

  console.info(LOG, "conversation_flow_updated", {
    conversationId,
    flow_code: targetFlow,
    flow_current_node: firstNode,
  });

  return { flow_code: targetFlow, flow_current_node: firstNode, changed: true };
}

/** Fila en catálogo y activa (si no hay fila → false = flujo inexistente en catálogo). */
export async function isFlowKnownAndActiveInCatalog(
  supabase: SupabaseAdmin,
  empresaId: string,
  flowCode: string
): Promise<boolean> {
  const fc = flowCode.trim();
  if (!fc) return false;
  const { data, error } = await supabase
    .from("chat_flows")
    .select("activo")
    .eq("empresa_id", empresaId)
    .eq("flow_code", fc)
    .maybeSingle();
  if (error || !data) return false;
  return (data as { activo?: boolean }).activo === true;
}

/** Nodo activo en ese flujo. */
export async function isNodeActiveInFlow(
  supabase: SupabaseAdmin,
  empresaId: string,
  flowCode: string,
  nodeCode: string
): Promise<boolean> {
  const nc = nodeCode.trim();
  const fc = flowCode.trim();
  if (!fc || !nc) return false;
  const { data, error } = await supabase
    .from("chat_flow_nodes")
    .select("id")
    .eq("empresa_id", empresaId)
    .eq("flow_code", fc)
    .eq("node_code", nc)
    .eq("is_active", true)
    .maybeSingle();
  return !error && Boolean((data as { id?: string } | null)?.id);
}

/**
 * Palabras que fuerzan reinicio al primer nodo del flujo activo (primer token o mensaje exacto).
 */
export function matchesConversationRestartKeyword(text: string): boolean {
  const raw = text
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (!raw) return false;
  const keywords = new Set([
    "hola",
    "menu",
    "menú",
    "comenzar",
    "iniciar",
    "reiniciar",
    "inicio",
  ]);
  const tokens = raw.split(/\s+/).filter(Boolean);
  const first = tokens[0] ?? "";
  if (keywords.has(first)) return true;
  if (tokens.length === 1 && keywords.has(raw)) return true;
  return false;
}

export type RestartToFlowStartResult = {
  flow_code: string | null;
  flow_current_node: string | null;
  restarted: boolean;
  reason: string;
};

/**
 * Reinicia conversación al primer nodo de un flujo activo.
 * - Un solo flujo activo en catálogo → ese.
 * - Varios: solo si `preferFlowCode` está en la lista activa; si no, no elige al azar.
 * Pone flow_status=bot y human_taken_over=false.
 */
export async function restartWhatsappConversationToFlowStart(
  supabase: SupabaseAdmin,
  empresaId: string,
  conversationId: string,
  opts: { preferFlowCode?: string | null; trigger: string }
): Promise<RestartToFlowStartResult> {
  const catalog = await listActiveWhatsappFlowsForEmpresa(supabase, empresaId);
  if (catalog.kind === "none") {
    console.warn(CONV_LOG, "conversation_restarted", {
      conversationId,
      ok: false,
      detail: "no_active_flow_found",
      trigger: opts.trigger,
    });
    return { flow_code: null, flow_current_node: null, restarted: false, reason: "no_active_flow" };
  }

  let targetFlow: string | null = null;
  if (catalog.kind === "single") {
    targetFlow = catalog.flowCode;
  } else {
    const pref = opts.preferFlowCode?.trim() || null;
    if (pref && catalog.flowCodes.includes(pref)) {
      targetFlow = pref;
    } else {
      console.error(CONV_LOG, "conversation_restarted", {
        conversationId,
        ok: false,
        detail: "multiple_active_flows_need_explicit_flow",
        activeFlowCodes: catalog.flowCodes,
        preferFlowCode: pref,
        trigger: opts.trigger,
      });
      return { flow_code: null, flow_current_node: null, restarted: false, reason: "multiple_ambiguous" };
    }
  }

  const firstNode = (await getFirstActiveNodeCodeForFlow(supabase, empresaId, targetFlow)) ?? "inicio";

  const { error: updErr } = await supabase
    .from("chat_conversations")
    .update({
      flow_code: targetFlow,
      flow_current_node: firstNode,
      flow_status: "bot",
      human_taken_over: false,
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversationId)
    .eq("empresa_id", empresaId);

  if (updErr) {
    console.error(CONV_LOG, "conversation_restarted", {
      conversationId,
      ok: false,
      message: updErr.message,
      trigger: opts.trigger,
    });
    return { flow_code: null, flow_current_node: null, restarted: false, reason: "update_failed" };
  }

  console.info(CONV_LOG, "conversation_restarted", {
    conversationId,
    flow_code: targetFlow,
    flow_current_node: firstNode,
    trigger: opts.trigger,
  });

  return {
    flow_code: targetFlow,
    flow_current_node: firstNode,
    restarted: true,
    reason: opts.trigger,
  };
}
