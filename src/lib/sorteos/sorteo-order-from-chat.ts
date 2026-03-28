import type { SupabaseClient } from "@supabase/supabase-js";
import { parseMoneyPy } from "@/lib/sorteos/parse-money-py";

/** Clave estable: mismo comprobante (media) en misma conversación y flujo → una sola orden. */
export function buildSorteoIdempotencyKey(
  conversationId: string,
  flowCode: string,
  mediaId: string
): string {
  return `${conversationId}:${flowCode}:${mediaId}`;
}

function norm(s: string | undefined): string {
  return (s ?? "").trim();
}

const FLOW_SORTEO_LOG = "[flow-sorteo]" as const;

/**
 * Motivo legible cuando `parseSorteoParticipantFromFlowData` devuelve null (diagnóstico en logs).
 */
export function explainParseSorteoParticipantFailure(data: Record<string, string>): string {
  const qtyKeys = ["cantidad_boletos", "cantidad", "boletos", "qty"] as const;
  let foundKey: string | undefined;
  let rawVal: string | undefined;
  let qtyValid = false;
  for (const k of qtyKeys) {
    const v = norm(data[k]);
    if (!v) continue;
    foundKey = k;
    rawVal = v;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 1) {
      qtyValid = true;
      break;
    }
  }
  if (!qtyValid) {
    for (const k of ["producto", "opcion_label", "combo", "opcion", "descripcion"] as const) {
      const q = extractQtyFromFlowText(data[k]);
      if (q != null) {
        qtyValid = true;
        break;
      }
    }
  }
  if (!qtyValid) {
    if (!foundKey) {
      return "cantidad: ninguna clave numérica ni texto con cantidad (producto/opcion_label/etc.)";
    }
    return `cantidad: clave "${foundKey}"="${rawVal}" no es número entero >= 1`;
  }
  const nombreCompleto =
    norm(data["nombre_completo"]) ||
    norm(data["nombre_y_apellido"]) ||
    [norm(data["nombre"]), norm(data["apellido"])].filter(Boolean).join(" ").trim();
  if (!nombreCompleto) {
    return "nombre: falta nombre_completo | nombre_y_apellido | (nombre y apellido)";
  }
  return "desconocido";
}

/** Cantidad desde texto tipo "3 boletos", "Combo 5", "5", etc. */
export function extractQtyFromFlowText(s: string | undefined): number | null {
  const t = norm(s);
  if (!t) return null;
  const direct = Number(t.replace(",", "."));
  if (Number.isFinite(direct) && direct >= 1) return Math.trunc(direct);
  for (const re of [
    /^(\d+)\s*bolet/i,
    /^(\d+)\s*boleta/i,
    /^(\d+)\s*entrada/i,
    /^(\d+)\s*ticket/i,
    /(\d+)\s*bolet/i,
    /^(\d+)\b/,
  ]) {
    const m = t.match(re);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n >= 1) return Math.trunc(n);
    }
  }
  return null;
}

/**
 * Lee campos típicos guardados vía save_as_field en el flujo (nombres flexibles).
 */
export function parseSorteoParticipantFromFlowData(data: Record<string, string>): {
  nombre_completo: string;
  cedula: string;
  ciudad: string;
  cantidad_boletos: number;
} | null {
  const qtyKeys = ["cantidad_boletos", "cantidad", "boletos", "qty"];
  let qty = NaN;
  for (const k of qtyKeys) {
    const v = norm(data[k]);
    if (!v) continue;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 1) {
      qty = Math.trunc(n);
      break;
    }
  }
  if (!Number.isFinite(qty) || qty < 1) {
    for (const k of ["producto", "opcion_label", "combo", "opcion", "descripcion"]) {
      const q = extractQtyFromFlowText(data[k]);
      if (q != null) {
        qty = q;
        break;
      }
    }
  }
  if (!Number.isFinite(qty) || qty < 1) return null;

  const nombreCompleto =
    norm(data["nombre_completo"]) ||
    norm(data["nombre_y_apellido"]) ||
    [norm(data["nombre"]), norm(data["apellido"])].filter(Boolean).join(" ").trim();

  if (!nombreCompleto) return null;

  return {
    nombre_completo: nombreCompleto,
    cedula: norm(data["cedula"]) || norm(data["documento"]) || norm(data["ci"]),
    ciudad: norm(data["ciudad"]),
    cantidad_boletos: qty,
  };
}

const MONTO_FLOW_KEYS = ["monto", "monto_compra", "monto_promocional"] as const;
const PRECIO_REG_KEYS = ["precio_regular", "precio_regular_referencia", "precio_lista"] as const;

/**
 * Monto y metadatos comerciales guardados en chat_flow_data al elegir una opción (JSON estructurado).
 */
export function parseSorteoPricingFromFlowData(data: Record<string, string>): {
  montoCompra: number | null;
  promoNombre: string;
  precioRegularReferencia: number | null;
} {
  let montoCompra: number | null = null;
  for (const k of MONTO_FLOW_KEYS) {
    const v = norm(data[k]);
    if (!v) continue;
    const n = parseMoneyPy(v);
    if (n != null && n > 0) {
      montoCompra = Math.round(n);
      break;
    }
  }
  const promoNombre = norm(data["promo_nombre"]);
  let precioRegularReferencia: number | null = null;
  for (const k of PRECIO_REG_KEYS) {
    const v = norm(data[k]);
    if (!v) continue;
    const n = parseMoneyPy(v);
    if (n != null && n > 0) {
      precioRegularReferencia = Math.round(n);
      break;
    }
  }
  return { montoCompra, promoNombre, precioRegularReferencia };
}

export async function getSorteoIdForChatFlow(
  supabase: SupabaseClient,
  empresaId: string,
  flowCode: string
): Promise<string | null> {
  const fc = flowCode.trim();
  if (!fc) return null;
  const { data, error } = await supabase
    .from("chat_flows")
    .select("sorteo_id, updated_at")
    .eq("empresa_id", empresaId)
    .eq("flow_code", fc)
    .order("updated_at", { ascending: false })
    .limit(10);
  if (error || !data?.length) return null;
  const row = data.find((r) => {
    const sid = (r as { sorteo_id?: string | null }).sorteo_id;
    return typeof sid === "string" && sid.length > 0;
  }) as { sorteo_id?: string | null } | undefined;
  const sid = row?.sorteo_id;
  return typeof sid === "string" ? sid : null;
}

export type EnsureSorteoOrderFromChatInput = {
  empresaId: string;
  conversationId: string;
  flowCode: string;
  mediaId: string;
  whatsappNumero: string;
  comprobanteUrl: string;
  /** Mapa field_name → field_value desde chat_flow_data */
  flowData: Record<string, string>;
};

/** Datos reales devueltos tras crear o reutilizar orden + cupones (para `chat_flow_data` y plantillas `{{...}}`). */
export type EnsureSorteoOrderCreatedData = {
  idempotent: boolean;
  entradaId: string;
  numeroOrden: number;
  cupones: { id: string; numero_cupon: string }[];
  sorteoId: string;
  sorteoNombre: string;
  cantidadBoletos: number;
  montoTotal: number;
  promoNombre: string;
  precioFuente: string;
};

export type EnsureSorteoOrderFromChatResult =
  | { ok: true; skipped: true; reason: string }
  | ({ ok: true; skipped: false } & EnsureSorteoOrderCreatedData)
  | { ok: false; message: string };

/** Nombres de campo en `chat_flow_data` para el nodo de cierre tras comprobante (placeholders en texto). */
export const CHAT_FLOW_SORTEO_CONTEXT_FIELDS = {
  sorteo_entrada_id: "sorteo_entrada_id",
  numero_orden: "numero_orden",
  /** Cupones separados por coma (una línea) */
  numeros_cupon: "numeros_cupon",
  /** Un cupón por línea (mensaje multilínea en WhatsApp) */
  numeros_cupon_lineas: "numeros_cupon_lineas",
  sorteo_nombre: "sorteo_nombre",
  /** Cantidad de boletos de la orden (desde fila `sorteo_entradas`, no del paso previo del flujo) */
  orden_cantidad_boletos: "orden_cantidad_boletos",
  /** Monto total persistido en la orden (promo o lista) */
  orden_monto_total: "orden_monto_total",
  /** Promo asociada a la orden (si hubo) */
  sorteo_promo_nombre: "sorteo_promo_nombre",
  precio_fuente_orden: "precio_fuente_orden",
} as const;

/**
 * Filas para upsert en `chat_flow_data` después de `ensureSorteoOrderFromChat` exitoso.
 * Orden: solo llamar cuando la orden ya exista en DB.
 */
export function buildChatFlowDataUpsertsForSorteoOrder(
  empresaId: string,
  conversationId: string,
  flowCode: string,
  data: EnsureSorteoOrderCreatedData
): Array<{
  empresa_id: string;
  conversation_id: string;
  flow_code: string;
  field_name: string;
  field_value: string;
}> {
  const fc = flowCode.trim();
  const nums = data.cupones
    .map((c) => c.numero_cupon)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const F = CHAT_FLOW_SORTEO_CONTEXT_FIELDS;
  const pairs: [string, string][] = [
    [F.sorteo_entrada_id, data.entradaId],
    [F.numero_orden, String(data.numeroOrden)],
    [F.numeros_cupon, nums.join(", ")],
    [F.numeros_cupon_lineas, nums.join("\n")],
    [F.sorteo_nombre, data.sorteoNombre],
    [F.orden_cantidad_boletos, String(data.cantidadBoletos)],
    [F.orden_monto_total, String(data.montoTotal)],
    [F.precio_fuente_orden, data.precioFuente],
  ];
  if (data.promoNombre.trim()) {
    pairs.push([F.sorteo_promo_nombre, data.promoNombre]);
  }
  return pairs.map(([field_name, field_value]) => ({
    empresa_id: empresaId,
    conversation_id: conversationId,
    flow_code: fc,
    field_name,
    field_value,
  }));
}

/**
 * Crea orden (sorteo_entradas) + cupones vía RPC atómica e idempotente.
 * Si el flow no tiene sorteo_id o faltan datos, hace skip sin error.
 * No exige `empresa_modulos.sorteos`: el vínculo explícito chat_flows.sorteo_id basta.
 */
export async function ensureSorteoOrderFromChat(
  supabase: SupabaseClient,
  input: EnsureSorteoOrderFromChatInput
): Promise<EnsureSorteoOrderFromChatResult> {
  const flowCode = input.flowCode.trim();
  console.info(FLOW_SORTEO_LOG, "ensureSorteoOrderFromChat_invoke", {
    conversationId: input.conversationId,
    flowCode,
    empresaId: input.empresaId,
    mediaId: input.mediaId,
    flowDataKeys: Object.keys(input.flowData),
    chat_flow_data: input.flowData,
  });

  const sorteoId = await getSorteoIdForChatFlow(supabase, input.empresaId, flowCode);
  if (!sorteoId) {
    console.warn(FLOW_SORTEO_LOG, "ensureSorteoOrderFromChat_outcome", {
      path: "skipped",
      reason: "flow_sin_sorteo_id",
      sorteo_id: null,
      conversationId: input.conversationId,
      flowCode,
      archivo: "src/lib/sorteos/sorteo-order-from-chat.ts",
      condicion: "getSorteoIdForChatFlow devolvió null (chat_flows.sorteo_id vacío o sin fila)",
    });
    return { ok: true, skipped: true, reason: "flow_sin_sorteo_id" };
  }

  const participant = parseSorteoParticipantFromFlowData(input.flowData);
  if (!participant) {
    const parseDetail = explainParseSorteoParticipantFailure(input.flowData);
    console.warn(FLOW_SORTEO_LOG, "ensureSorteoOrderFromChat_outcome", {
      path: "skipped",
      reason: "datos_flujo_incompletos",
      parseDetail,
      conversationId: input.conversationId,
      flowCode,
      sorteo_id: sorteoId,
      chat_flow_data: input.flowData,
      archivo: "src/lib/sorteos/sorteo-order-from-chat.ts",
      condicion: "parseSorteoParticipantFromFlowData === null",
    });
    return { ok: true, skipped: true, reason: "datos_flujo_incompletos" };
  }

  const pricing = parseSorteoPricingFromFlowData(input.flowData);

  const idempotencyKey = buildSorteoIdempotencyKey(
    input.conversationId,
    flowCode,
    input.mediaId
  );

  const rpcPayload: Record<string, unknown> = {
    empresa_id: input.empresaId,
    sorteo_id: sorteoId,
    chat_conversation_id: input.conversationId,
    flow_code: flowCode,
    idempotency_key: idempotencyKey,
    whatsapp_numero: input.whatsappNumero,
    nombre_completo: participant.nombre_completo,
    cedula: participant.cedula || "",
    ciudad: participant.ciudad || "",
    cantidad_boletos: participant.cantidad_boletos,
    comprobante_url: input.comprobanteUrl,
    validado_por: "chat_flow",
  };
  if (pricing.montoCompra != null) {
    rpcPayload.monto_compra = pricing.montoCompra;
  }
  if (pricing.promoNombre) {
    rpcPayload.promo_nombre = pricing.promoNombre;
  }
  if (pricing.precioRegularReferencia != null) {
    rpcPayload.precio_regular_referencia = pricing.precioRegularReferencia;
  }

  const { data, error } = await supabase.rpc("sorteos_ensure_order_from_chat", {
    p: rpcPayload,
  });

  if (error) {
    console.error(FLOW_SORTEO_LOG, "ensureSorteoOrderFromChat_outcome", {
      path: "failed",
      reason: "rpc_error",
      error: error.message,
      conversationId: input.conversationId,
      flowCode,
      sorteo_id: sorteoId,
      archivo: "src/lib/sorteos/sorteo-order-from-chat.ts",
      condicion: "supabase.rpc sorteos_ensure_order_from_chat devolvió error",
      rpcError: error.message,
      rpcCode: error.code,
      rpcDetails: error.details,
    });
    return { ok: false, message: error.message || "RPC sorteos_ensure_order_from_chat falló" };
  }

  const row = data as Record<string, unknown> | null;
  if (!row || typeof row.ok !== "boolean") {
    const invalidMsg = "Respuesta inválida del servidor (sorteo)";
    console.error(FLOW_SORTEO_LOG, "ensureSorteoOrderFromChat_outcome", {
      path: "failed",
      reason: "invalid_rpc_payload",
      error: invalidMsg,
      conversationId: input.conversationId,
      flowCode,
      sorteo_id: sorteoId,
      archivo: "src/lib/sorteos/sorteo-order-from-chat.ts",
      condicion: "!row || typeof row.ok !== boolean",
      rawData: data,
    });
    return { ok: false, message: invalidMsg };
  }
  if (!row.ok) {
    const msg =
      typeof row.message === "string" ? row.message : "Error al crear orden de sorteo";
    console.error(FLOW_SORTEO_LOG, "ensureSorteoOrderFromChat_outcome", {
      path: "failed",
      reason: "rpc_row_not_ok",
      error: msg,
      conversationId: input.conversationId,
      flowCode,
      sorteo_id: sorteoId,
      archivo: "src/lib/sorteos/sorteo-order-from-chat.ts",
      condicion: "row.ok === false (RPC negocio)",
      rpcRowMessage: msg,
      rawRow: row,
    });
    return {
      ok: false,
      message: msg,
    };
  }

  const entrada = row.entrada as Record<string, unknown> | undefined;
  const entradaId = typeof entrada?.id === "string" ? entrada.id : "";
  const numeroOrden =
    typeof entrada?.numero_orden === "number"
      ? entrada.numero_orden
      : Number(entrada?.numero_orden);
  const cuponesRaw = row.cupones as unknown;
  const cupones: { id: string; numero_cupon: string }[] = Array.isArray(cuponesRaw)
    ? cuponesRaw.map((c) => {
        const o = c as Record<string, unknown>;
        return {
          id: String(o.id ?? ""),
          numero_cupon: String(o.numero_cupon ?? ""),
        };
      })
    : [];

  if (!entradaId || !Number.isFinite(numeroOrden)) {
    const incompleteMsg = "Respuesta de orden incompleta";
    console.error(FLOW_SORTEO_LOG, "ensureSorteoOrderFromChat_outcome", {
      path: "failed",
      reason: "entrada_incompleta",
      error: incompleteMsg,
      conversationId: input.conversationId,
      flowCode,
      sorteo_id: sorteoId,
      archivo: "src/lib/sorteos/sorteo-order-from-chat.ts",
      condicion: "!entradaId || !Number.isFinite(numeroOrden)",
      entradaId,
      numeroOrden,
      rawRow: row,
    });
    return { ok: false, message: incompleteMsg };
  }

  const cbRaw = entrada?.cantidad_boletos;
  let cantidadBoletos =
    typeof cbRaw === "number" ? cbRaw : Number(cbRaw);
  if (!Number.isFinite(cantidadBoletos) || cantidadBoletos < 1) {
    cantidadBoletos = participant.cantidad_boletos;
  }

  const montoRaw = entrada?.monto_total;
  let montoTotal = typeof montoRaw === "number" ? montoRaw : Number(montoRaw);
  if (!Number.isFinite(montoTotal) || montoTotal < 0) {
    montoTotal = 0;
  }

  const promoNombre =
    typeof entrada?.promo_nombre === "string" ? entrada.promo_nombre.trim() : "";
  const precioFuenteRaw = entrada?.precio_fuente;
  const precioFuente =
    precioFuenteRaw === "promo" || precioFuenteRaw === "lista"
      ? precioFuenteRaw
      : "lista";

  const { data: sorteoRow, error: sorteoNomErr } = await supabase
    .from("sorteos")
    .select("nombre")
    .eq("id", sorteoId)
    .maybeSingle();
  if (sorteoNomErr) {
    console.warn(FLOW_SORTEO_LOG, "sorteo_nombre_lookup_failed", {
      sorteoId,
      message: sorteoNomErr.message,
    });
  }
  const sorteoNombre = String((sorteoRow as { nombre?: string } | null)?.nombre ?? "").trim();

  console.info(FLOW_SORTEO_LOG, "ensureSorteoOrderFromChat_outcome", {
    path: "success",
    conversationId: input.conversationId,
    flowCode,
    sorteo_id: sorteoId,
    sorteo_nombre: sorteoNombre,
    idempotent: row.idempotent === true,
    entradaId,
    numeroOrden,
    cantidadBoletos,
    cuponesCount: cupones.length,
  });

  return {
    ok: true,
    skipped: false,
    idempotent: row.idempotent === true,
    entradaId,
    numeroOrden,
    cupones,
    sorteoId,
    sorteoNombre,
    cantidadBoletos,
    montoTotal,
    promoNombre,
    precioFuente,
  };
}
