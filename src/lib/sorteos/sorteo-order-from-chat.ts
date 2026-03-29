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
  const qtyKeys = ["sorteo_cantidad_opcion", "cantidad_boletos", "cantidad", "boletos", "qty"] as const;
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
    [norm(data["nombre"]), norm(data["apellido"])].filter(Boolean).join(" ").trim() ||
    norm(data["nombre_y_apellido"]) ||
    norm(data["nombre_completo"]);
  if (!nombreCompleto) {
    return "nombre: falta (nombre y apellido) | nombre_y_apellido | nombre_completo";
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
 * Si el flujo guardó `Nombre`, `Cédula`, etc., expone también `nombre`, `cedula` para el parser.
 */
export function expandFlowDataCanonicalKeys(data: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...data };
  for (const [k, v] of Object.entries(data)) {
    const tk = k.trim();
    if (!tk) continue;
    const val = String(v ?? "");
    if (!norm(val)) continue;
    const lk = tk.toLowerCase();
    if (!norm(out[lk])) out[lk] = val;
  }
  return out;
}

function flowDataHasResolvableQty(data: Record<string, string>): boolean {
  const qtyKeys = ["sorteo_cantidad_opcion", "cantidad_boletos", "cantidad", "boletos", "qty"] as const;
  for (const k of qtyKeys) {
    const v = norm(data[k]);
    if (!v) continue;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 1) return true;
  }
  for (const k of ["producto", "opcion_label", "combo", "opcion", "descripcion"] as const) {
    if (extractQtyFromFlowText(data[k]) != null) return true;
  }
  return false;
}

/**
 * Completa cantidad desde el texto visible de la opción si el payload no trajo cantidad explícita.
 */
export function enrichFlowDataForSorteoParse(data: Record<string, string>): Record<string, string> {
  if (flowDataHasResolvableQty(data)) return data;
  const out = { ...data };
  for (const k of ["opcion_label", "producto", "combo", "opcion", "descripcion"] as const) {
    const q = extractQtyFromFlowText(out[k]);
    if (q != null) {
      out["sorteo_cantidad_opcion"] = String(q);
      out["cantidad"] = String(q);
      break;
    }
  }
  return out;
}

export function prepareFlowDataForSorteoOrder(data: Record<string, string>): Record<string, string> {
  return enrichFlowDataForSorteoParse(expandFlowDataCanonicalKeys(data));
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
  const qtyKeys = ["sorteo_cantidad_opcion", "cantidad_boletos", "cantidad", "boletos", "qty"];
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

  const fromNombreApellido = [norm(data["nombre"]), norm(data["apellido"])]
    .filter(Boolean)
    .join(" ")
    .trim();
  const nombreCompleto =
    fromNombreApellido ||
    norm(data["nombre_y_apellido"]) ||
    norm(data["nombre_completo"]);

  if (!nombreCompleto) return null;

  return {
    nombre_completo: nombreCompleto,
    cedula: norm(data["cedula"]) || norm(data["documento"]) || norm(data["ci"]),
    ciudad: norm(data["ciudad"]),
    cantidad_boletos: qty,
  };
}

const PRECIO_REG_KEYS = ["precio_regular", "precio_regular_referencia", "precio_lista"] as const;

function parseFirstMoney(
  data: Record<string, string>,
  keys: readonly string[]
): number | null {
  for (const k of keys) {
    const v = norm(data[k]);
    if (!v) continue;
    const n = parseMoneyPy(v);
    if (n != null && n > 0) return Math.round(n);
  }
  return null;
}

/**
 * Monto y metadatos comerciales guardados en chat_flow_data al elegir una opción (JSON estructurado).
 *
 * No usa el campo genérico `monto` salvo si `precio_fuente` es `promo`, para que pasos del flujo
 * que rellenan `{{monto}}` con el total de lista no pisen el precio promocional guardado en
 * `monto_compra` / `monto_promocional`.
 */
export function parseSorteoPricingFromFlowData(data: Record<string, string>): {
  montoCompra: number | null;
  promoNombre: string;
  precioRegularReferencia: number | null;
} {
  const pf = norm(data["precio_fuente"]).toLowerCase();
  let montoCompra =
    parseFirstMoney(data, ["sorteo_monto_opcion", "monto_compra", "monto_promocional"]) ??
    null;
  if (montoCompra == null && pf === "promo") {
    montoCompra = parseFirstMoney(data, ["monto"]);
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
function sorteoOrderContextPairs(data: EnsureSorteoOrderCreatedData): [string, string][] {
  const nums = data.cupones
    .map((c) => c.numero_cupon)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const comma = nums.join(", ");
  const lines = nums.join("\n");
  const no = String(data.numeroOrden);
  const F = CHAT_FLOW_SORTEO_CONTEXT_FIELDS;
  const pairs: [string, string][] = [
    [F.sorteo_entrada_id, data.entradaId],
    [F.numero_orden, no],
    [F.numeros_cupon, comma],
    [F.numeros_cupon_lineas, lines],
    [F.sorteo_nombre, data.sorteoNombre],
    [F.orden_cantidad_boletos, String(data.cantidadBoletos)],
    [F.orden_monto_total, String(data.montoTotal)],
    [F.precio_fuente_orden, data.precioFuente],
    ["id_orden", no],
    ["ID_orden", no],
    ["id_tu_orden", no],
    ["orden_id", no],
    ["order_id", no],
    ["id_de_orden", no],
    ["numero_de_orden", no],
    ["numeros_generados", comma],
    ["tus_numeros_generados", comma],
    ["tus_numeros", comma],
    ["numeros_cupones", comma],
    ["cupones", comma],
    ["cupones_generados", comma],
    ["nros_cupon", comma],
    ["nros_cupones", comma],
    ["cupones_lineas", lines],
  ];
  if (data.promoNombre.trim()) {
    pairs.push([F.sorteo_promo_nombre, data.promoNombre]);
  }
  return pairs;
}

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
  return sorteoOrderContextPairs(data).map(([field_name, field_value]) => ({
    empresa_id: empresaId,
    conversation_id: conversationId,
    flow_code: fc,
    field_name,
    field_value,
  }));
}

/**
 * Variables para `{{...}}` en el nodo que sigue al comprobante.
 * Incluye alias típicos de plantillas; el merge en memoria evita placeholders vacíos
 * por lag de lectura tras el upsert.
 */
export function buildSorteoOrderFlowVarOverrides(
  data: EnsureSorteoOrderCreatedData
): Record<string, string> {
  return Object.fromEntries(sorteoOrderContextPairs(data));
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
  const flowData = prepareFlowDataForSorteoOrder(input.flowData);
  console.info(FLOW_SORTEO_LOG, "ensureSorteoOrderFromChat_invoke", {
    conversationId: input.conversationId,
    flowCode,
    empresaId: input.empresaId,
    mediaId: input.mediaId,
    flowDataKeysRaw: Object.keys(input.flowData),
    flowDataKeysPrepared: Object.keys(flowData),
    chat_flow_data: flowData,
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

  const participant = parseSorteoParticipantFromFlowData(flowData);
  if (!participant) {
    const parseDetail = explainParseSorteoParticipantFailure(flowData);
    console.warn(FLOW_SORTEO_LOG, "ensureSorteoOrderFromChat_outcome", {
      path: "skipped",
      reason: "datos_flujo_incompletos",
      parseDetail,
      conversationId: input.conversationId,
      flowCode,
      sorteo_id: sorteoId,
      chat_flow_data: flowData,
      archivo: "src/lib/sorteos/sorteo-order-from-chat.ts",
      condicion: "parseSorteoParticipantFromFlowData === null",
    });
    return { ok: true, skipped: true, reason: "datos_flujo_incompletos" };
  }

  const pricing = parseSorteoPricingFromFlowData(flowData);
  console.info(FLOW_SORTEO_LOG, "ensureSorteoOrderFromChat_pricing", {
    conversationId: input.conversationId,
    flowCode,
    montoCompra: pricing.montoCompra,
    promoNombre: pricing.promoNombre,
    tiene_sorteo_monto_opcion: Boolean(flowData["sorteo_monto_opcion"]?.trim()),
    tiene_precio_fuente: Boolean(flowData["precio_fuente"]?.trim()),
  });

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
