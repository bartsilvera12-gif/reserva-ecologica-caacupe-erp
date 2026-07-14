import type { AppSupabaseClient } from "@/lib/supabase/schema";
import {
  buildSifenCancelacionPreview,
  normalizePlazoCancelacionHoras,
} from "@/lib/sifen/sifen-cancelacion-rules";
import { validarXmlFirmadoFacturaOrigenParaNc } from "@/lib/sifen/validar-factura-origen-xml-para-nc";
import type {
  NotaCreditoEventoTipo,
  NotaCreditoItemInput,
  NotaCreditoTipoNc,
} from "./types";

/** Redondea a 2 decimales (moneda). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Devuelve el `monto_iva` incluido en un `total_linea` según la tasa. */
function ivaIncluidoDeTotal(total: number, tipoIva: "EXENTA" | "5%" | "10%"): number {
  if (tipoIva === "10%") return round2((total * 10) / 110);
  if (tipoIva === "5%") return round2((total * 5) / 105);
  return 0;
}

function trimMotivo(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  return s.length > 0 ? s : null;
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export type CreateNotaCreditoParams = {
  supabase: AppSupabaseClient;
  empresaId: string;
  facturaId: string;
  authUserId: string;
  authEmail: string | null;
  authNombre: string | null;
  motivo: string;
  observacionInterna: string | null;
  /** 'total' (default): monto NC = saldo disponible; sin items. 'parcial': items[] obligatorio. */
  tipoNc?: NotaCreditoTipoNc;
  items?: NotaCreditoItemInput[] | null;
};

export type CreateNotaCreditoResult =
  | { ok: true; nota_credito_id: string }
  | { ok: false; status: number; error: string };

async function insertEvento(
  supabase: AppSupabaseClient,
  row: {
    empresa_id: string;
    nota_credito_id: string;
    actor_user_id: string;
    tipo_evento: NotaCreditoEventoTipo;
    detalle_json: Record<string, unknown>;
  }
) {
  const { error } = await supabase.from("nota_credito_evento").insert(row);
  if (error) throw new Error(error.message);
}

/**
 * Crea NC en borrador + fila electrónica en sin_envio + eventos de auditoría.
 * No modifica saldo de la factura (solo al aprobar NC en fases posteriores).
 */
export async function createNotaCreditoBorrador(p: CreateNotaCreditoParams): Promise<CreateNotaCreditoResult> {
  const motivo = trimMotivo(p.motivo);
  if (motivo == null || motivo.length < 5) {
    return { ok: false, status: 400, error: "El motivo es obligatorio (mínimo 5 caracteres)." };
  }
  if (motivo.length > 2000) {
    return { ok: false, status: 400, error: "El motivo no puede superar 2000 caracteres." };
  }

  const obs =
    p.observacionInterna == null || String(p.observacionInterna).trim() === ""
      ? null
      : String(p.observacionInterna).trim().slice(0, 4000);

  const { data: factura, error: errF } = await p.supabase
    .from("facturas")
    .select("id, empresa_id, cliente_id, monto, saldo, estado, moneda, numero_factura")
    .eq("id", p.facturaId)
    .eq("empresa_id", p.empresaId)
    .maybeSingle();

  if (errF) {
    return { ok: false, status: 400, error: errF.message };
  }
  if (!factura) {
    return { ok: false, status: 404, error: "Factura no encontrada." };
  }

  const estadoFactura = String((factura as { estado?: string }).estado ?? "");
  if (estadoFactura === "Anulado") {
    return { ok: false, status: 409, error: "La factura está anulada; no corresponde nota de crédito." };
  }

  const saldo = num((factura as { saldo?: unknown }).saldo);
  const montoFactura = num((factura as { monto?: unknown }).monto);
  // Ya NO se bloquea por `saldo <= 0`: una factura CONTADO nace con saldo 0 y
  // igual puede necesitar NC (devolución, descuento, bonificación). El tope real
  // se calcula más abajo sobre el monto facturado.
  if (montoFactura <= 0) {
    return { ok: false, status: 409, error: "La factura no tiene monto facturado; no corresponde nota de crédito." };
  }

  const monedaRaw = String((factura as { moneda?: string }).moneda ?? "GS").toUpperCase();
  const monedaSnapshot = monedaRaw === "USD" ? "USD" : "GS";

  const { data: feRow, error: errFe } = await p.supabase
    .from("factura_electronica")
    .select("id, factura_id, estado_sifen, sifen_aprobado_at, sifen_cancelado_at, cdc, xml_firmado_path")
    .eq("factura_id", p.facturaId)
    .eq("empresa_id", p.empresaId)
    .maybeSingle();

  if (errFe) {
    return { ok: false, status: 400, error: errFe.message };
  }
  if (!feRow) {
    return { ok: false, status: 409, error: "No hay documento electrónico asociado a esta factura." };
  }

  const estadoSifen = String((feRow as { estado_sifen?: string }).estado_sifen ?? "");
  if (estadoSifen !== "aprobado") {
    return {
      ok: false,
      status: 409,
      error: "Solo se puede crear nota de crédito cuando el documento electrónico está aprobado por SET.",
    };
  }

  const [{ data: cfg }, pagosRes] = await Promise.all([
    p.supabase
      .from("empresa_sifen_config")
      .select("sifen_plazo_cancelacion_horas")
      .eq("empresa_id", p.empresaId)
      .maybeSingle(),
    p.supabase
      .from("pagos")
      .select("monto")
      .eq("factura_id", p.facturaId)
      .eq("empresa_id", p.empresaId),
  ]);

  if (pagosRes.error) {
    return { ok: false, status: 400, error: pagosRes.error.message };
  }

  const pagosRows = (pagosRes.data ?? []) as { monto?: unknown }[];
  const pagosCount = pagosRows.length;
  const sumaPagos = pagosRows.reduce((s, r) => s + num(r.monto), 0);

  const plazo = normalizePlazoCancelacionHoras(
    cfg != null ? (cfg as { sifen_plazo_cancelacion_horas?: unknown }).sifen_plazo_cancelacion_horas : 48
  );

  const preview = buildSifenCancelacionPreview({
    estadoSifen,
    sifenAprobadoAtIso:
      (feRow as { sifen_aprobado_at?: string | null }).sifen_aprobado_at == null
        ? null
        : String((feRow as { sifen_aprobado_at?: string | null }).sifen_aprobado_at),
    sifenCanceladoAtIso:
      (feRow as { sifen_cancelado_at?: string | null }).sifen_cancelado_at == null
        ? null
        : String((feRow as { sifen_cancelado_at?: string | null }).sifen_cancelado_at),
    plazoHoras: plazo,
    pagosCount,
    nowMs: Date.now(),
  });

  // Guard removido (2026-07-09): permitimos NC aunque el DE siga siendo cancelable
  // en SET. El operador decide entre cancelar el DE o emitir NC según el caso real
  // (devolución parcial, ajuste de precio, cliente ya cobrado). Ver evaluate-creation-gate.ts.
  void preview;

  // Consideramos NC previas: sumaAprobadas (ya restadas del saldo por el RPC)
  // + sumaEnCurso (compromiso pendiente). Se permiten múltiples NC hasta agotar
  // el saldo disponible (política del negocio confirmada por el operador).
  const { data: ncsPrevRows, error: errNcsPrev } = await p.supabase
    .from("nota_credito")
    .select("id, monto, estado_erp")
    .eq("factura_id", p.facturaId)
    .eq("empresa_id", p.empresaId)
    .in("estado_erp", ["aprobada", "borrador", "pendiente_envio_sifen"]);
  if (errNcsPrev) {
    return { ok: false, status: 400, error: errNcsPrev.message };
  }
  const ncsPrev = (ncsPrevRows ?? []) as { monto?: unknown; estado_erp?: string }[];
  const sumaAprobadas = ncsPrev
    .filter((n) => n.estado_erp === "aprobada")
    .reduce((s, n) => s + num(n.monto), 0);
  const sumaEnCurso = ncsPrev
    .filter((n) => n.estado_erp === "borrador" || n.estado_erp === "pendiente_envio_sifen")
    .reduce((s, n) => s + num(n.monto), 0);

  // El tope de la NC es el IMPORTE ACREDITABLE = monto facturado − NC aprobadas,
  // NO el saldo pendiente. En una factura CONTADO el saldo nace en 0 (sin filas
  // en `pagos`), y el tope por saldo hacía imposible acreditarla. Sobre una
  // factura ya cobrada la NC representa un reembolso/descuento al cliente.
  // Mismo criterio que el RPC nota_credito_aplicar_aprobacion_set.
  // (Se quitó el chequeo de coherencia saldo === monto − pagos − NC: no se
  // cumple en contado y ya no hace falta, el tope no depende del saldo.)
  void sumaPagos;
  void saldo;

  const acreditable = Math.max(0, montoFactura - sumaAprobadas);
  const saldoDisponibleParaNc = Math.max(0, acreditable - sumaEnCurso);
  if (saldoDisponibleParaNc <= 0.02) {
    return {
      ok: false,
      status: 409,
      error:
        sumaEnCurso > 0
          ? "El importe acreditable ya está comprometido por notas de crédito en curso."
          : "La factura ya fue acreditada por completo con notas de crédito.",
    };
  }

  // Decidir monto según tipo. Si es 'parcial' se exige items[]; el sistema
  // recalcula subtotal + monto_iva a partir de tipo_iva para no depender
  // del cliente. Si es 'total' el monto es el saldo disponible.
  const tipoNc: NotaCreditoTipoNc = p.tipoNc === "parcial" ? "parcial" : "total";
  type ItemNormalizado = {
    factura_item_id: string | null;
    producto_id: string | null;
    producto_nombre_snapshot: string;
    sku_snapshot: string | null;
    cantidad: number;
    precio_unitario: number;
    tipo_iva: "EXENTA" | "5%" | "10%";
    subtotal: number;
    monto_iva: number;
    total_linea: number;
    modo: "unidades" | "monto";
  };
  let montoNc: number;
  let itemsNormalizados: ItemNormalizado[] = [];

  if (tipoNc === "parcial") {
    const itemsInput = Array.isArray(p.items) ? p.items : [];
    if (itemsInput.length === 0) {
      return {
        ok: false,
        status: 400,
        error: "Nota de crédito parcial: se requiere al menos un ítem.",
      };
    }
    if (itemsInput.length > 200) {
      return {
        ok: false,
        status: 400,
        error: "Nota de crédito parcial: máximo 200 ítems por NC.",
      };
    }

    // Validación cruzada contra la factura origen: el modo "monto" del editor
    // no tiene tope en el frontend, y el servidor no validaba antes que cada
    // línea de NC respetara la línea real de la factura — permitía acreditar
    // por un ítem mucho más de lo que esa línea vale, mientras la SUMA total
    // de la NC siguiera dentro del saldo (distorsiona reportes por producto).
    // Cargamos factura_items una sola vez y capamos cantidad/monto por línea
    // referenciada. Ítems sin factura_item_id (ajuste libre, sin línea de
    // origen) no tienen este tope — quedan sujetos solo al saldo total.
    const facturaItemsQ = await p.supabase
      .from("factura_items")
      .select("id, cantidad, total")
      .eq("factura_id", p.facturaId)
      .eq("empresa_id", p.empresaId);
    if (facturaItemsQ.error) {
      return { ok: false, status: 400, error: facturaItemsQ.error.message };
    }
    const facturaItemsById = new Map(
      (facturaItemsQ.data ?? []).map((r) => [
        String((r as { id: string }).id),
        {
          cantidad: num((r as { cantidad?: unknown }).cantidad),
          total: num((r as { total?: unknown }).total),
        },
      ])
    );

    for (let idx = 0; idx < itemsInput.length; idx++) {
      const it = itemsInput[idx]!;
      const nombre = trimMotivo(it.producto_nombre);
      if (!nombre) {
        return {
          ok: false,
          status: 400,
          error: `Ítem ${idx + 1}: producto_nombre es obligatorio.`,
        };
      }
      const cantidad = num(it.cantidad);
      if (cantidad <= 0) {
        return {
          ok: false,
          status: 400,
          error: `Ítem ${idx + 1}: cantidad debe ser mayor a 0.`,
        };
      }
      const precioUnit = num(it.precio_unitario);
      if (precioUnit < 0) {
        return {
          ok: false,
          status: 400,
          error: `Ítem ${idx + 1}: precio_unitario no puede ser negativo.`,
        };
      }
      const tipoIva: "EXENTA" | "5%" | "10%" =
        it.tipo_iva === "5%" || it.tipo_iva === "10%" ? it.tipo_iva : "EXENTA";
      const totalLinea = round2(num(it.total_linea));
      if (totalLinea <= 0) {
        return {
          ok: false,
          status: 400,
          error: `Ítem ${idx + 1}: total_linea debe ser mayor a 0.`,
        };
      }
      const facturaItemIdTrim = it.factura_item_id?.trim() || null;
      if (facturaItemIdTrim) {
        const lineaOrigen = facturaItemsById.get(facturaItemIdTrim);
        if (!lineaOrigen) {
          return {
            ok: false,
            status: 400,
            error: `Ítem ${idx + 1}: factura_item_id no corresponde a un ítem de esta factura.`,
          };
        }
        if (cantidad > lineaOrigen.cantidad + 0.0001) {
          return {
            ok: false,
            status: 400,
            error: `Ítem ${idx + 1}: la cantidad (${cantidad}) supera la cantidad facturada originalmente (${lineaOrigen.cantidad}).`,
          };
        }
        if (totalLinea > lineaOrigen.total + 0.02) {
          return {
            ok: false,
            status: 400,
            error: `Ítem ${idx + 1}: el monto (${totalLinea}) supera el total de esa línea en la factura original (${lineaOrigen.total}).`,
          };
        }
      }
      const montoIva = ivaIncluidoDeTotal(totalLinea, tipoIva);
      const subtotal = round2(totalLinea - montoIva);
      itemsNormalizados.push({
        factura_item_id: it.factura_item_id?.trim() || null,
        producto_id: it.producto_id?.trim() || null,
        producto_nombre_snapshot: nombre,
        sku_snapshot: it.sku?.trim() || null,
        cantidad,
        precio_unitario: precioUnit,
        tipo_iva: tipoIva,
        subtotal,
        monto_iva: montoIva,
        total_linea: totalLinea,
        modo: it.modo === "monto" ? "monto" : "unidades",
      });
    }
    montoNc = round2(itemsNormalizados.reduce((s, it) => s + it.total_linea, 0));
    if (montoNc <= 0) {
      return {
        ok: false,
        status: 400,
        error: "Nota de crédito parcial: la suma de ítems debe ser mayor a 0.",
      };
    }
    if (montoNc > saldoDisponibleParaNc + 0.02) {
      return {
        ok: false,
        status: 409,
        error: `La suma de ítems (${montoNc}) supera el saldo disponible (${saldoDisponibleParaNc}).`,
      };
    }
  } else {
    // NC total: acredita todo el saldo disponible en un solo tramo.
    montoNc = round2(saldoDisponibleParaNc);
    itemsNormalizados = [];
  }

  const feId = String((feRow as { id: string }).id);
  const cdcOrigen =
    (feRow as { cdc?: string | null }).cdc == null || String((feRow as { cdc?: string | null }).cdc).trim() === ""
      ? null
      : String((feRow as { cdc?: string | null }).cdc).trim();

  if (cdcOrigen == null || cdcOrigen.length !== 44) {
    return {
      ok: false,
      status: 409,
      error: "El documento electrónico no tiene CDC válido (44 dígitos); no se puede crear nota de crédito.",
    };
  }

  const vXml = await validarXmlFirmadoFacturaOrigenParaNc(
    p.supabase,
    p.empresaId,
    {
      id: feId,
      factura_id: String((feRow as { factura_id: string }).factura_id),
      cdc: cdcOrigen,
      xml_firmado_path:
        (feRow as { xml_firmado_path?: string | null }).xml_firmado_path == null
          ? null
          : String((feRow as { xml_firmado_path?: string | null }).xml_firmado_path).trim() || null,
    },
    {
      cdcEsperado: cdcOrigen,
      facturaIdEsperado: p.facturaId,
      numeroFacturaErp: String((factura as { numero_factura?: string }).numero_factura ?? ""),
    }
  );
  if (!vXml.ok) {
    return { ok: false, status: vXml.status, error: vXml.message };
  }

  const clienteId = String((factura as { cliente_id: string }).cliente_id);

  const insertNc = {
    empresa_id: p.empresaId,
    cliente_id: clienteId,
    factura_id: p.facturaId,
    monto: montoNc,
    motivo,
    observacion_interna: obs,
    estado_erp: "borrador" as const,
    tipo_nc: tipoNc,
    created_by_user_id: p.authUserId,
    created_by_email_snapshot: p.authEmail,
    created_by_nombre_snapshot: p.authNombre,
    saldo_previo_snapshot: saldo,
    monto_factura_snapshot: montoFactura,
    suma_pagos_snapshot: sumaPagos,
    moneda_snapshot: monedaSnapshot,
    factura_electronica_origen_id: feId,
  };

  const { data: ncRow, error: errNc } = await p.supabase.from("nota_credito").insert(insertNc).select("id").single();

  if (errNc || !ncRow) {
    const msg = errNc?.message ?? "No se pudo crear la nota de crédito.";
    if (msg.includes("uq_nota_credito_factura_estado_activo") || msg.includes("duplicate key")) {
      return {
        ok: false,
        status: 409,
        error: "Ya existe una nota de crédito en curso para esta factura (borrador o pendiente).",
      };
    }
    return { ok: false, status: 500, error: msg };
  }

  const ncId = String((ncRow as { id: string }).id);

  try {
    // Ítems (solo si tipo_nc='parcial'). Best-effort agrupado: si el insert
    // falla, borramos NC + registros derivados y devolvemos error.
    if (itemsNormalizados.length > 0) {
      const itemsPayload = itemsNormalizados.map((it) => ({
        empresa_id: p.empresaId,
        nota_credito_id: ncId,
        factura_item_id: it.factura_item_id,
        producto_id: it.producto_id,
        producto_nombre_snapshot: it.producto_nombre_snapshot,
        sku_snapshot: it.sku_snapshot,
        cantidad: it.cantidad,
        precio_unitario: it.precio_unitario,
        tipo_iva: it.tipo_iva,
        subtotal: it.subtotal,
        monto_iva: it.monto_iva,
        total_linea: it.total_linea,
        modo: it.modo,
      }));
      const { error: errItems } = await p.supabase
        .from("nota_credito_items")
        .insert(itemsPayload);
      if (errItems) throw new Error(`Error insertando ítems NC: ${errItems.message}`);
    }

    const { error: errNe } = await p.supabase.from("nota_credito_electronica").insert({
      empresa_id: p.empresaId,
      nota_credito_id: ncId,
      estado_sifen: "sin_envio",
      cdc_factura_origen: cdcOrigen,
    });
    if (errNe) throw new Error(errNe.message);

    await insertEvento(p.supabase, {
      empresa_id: p.empresaId,
      nota_credito_id: ncId,
      actor_user_id: p.authUserId,
      tipo_evento: "creacion",
      detalle_json: {
        factura_id: p.facturaId,
        cliente_id: clienteId,
        monto: montoNc,
        motivo,
        observacion_interna: obs,
        tipo_nc: tipoNc,
        items_cantidad: itemsNormalizados.length,
        items_resumen: itemsNormalizados.map((it) => ({
          producto: it.producto_nombre_snapshot,
          cantidad: it.cantidad,
          total: it.total_linea,
          tipo_iva: it.tipo_iva,
        })),
        saldo_previo_snapshot: saldo,
        saldo_disponible_para_nc: saldoDisponibleParaNc,
        monto_factura_snapshot: montoFactura,
        suma_pagos_snapshot: sumaPagos,
        suma_ncs_aprobadas_previas: sumaAprobadas,
        suma_ncs_en_curso_previas: sumaEnCurso,
        moneda_snapshot: monedaSnapshot,
        factura_electronica_origen_id: feId,
        cdc_factura_origen: cdcOrigen,
        estado_erp_inicial: "borrador",
        estado_sifen_inicial: "sin_envio",
        cancelacion_preview: preview,
      },
    });

    await insertEvento(p.supabase, {
      empresa_id: p.empresaId,
      nota_credito_id: ncId,
      actor_user_id: p.authUserId,
      tipo_evento: "validacion",
      detalle_json: {
        resultado: "ok",
        reglas: {
          puede_cancelar_de: false,
          saldo_pendiente: saldo,
          suma_pagos: sumaPagos,
          monto_factura: montoFactura,
        },
      },
    });
  } catch (e) {
    await p.supabase.from("nota_credito").delete().eq("id", ncId).eq("empresa_id", p.empresaId);
    return {
      ok: false,
      status: 500,
      error: e instanceof Error ? e.message : "Error al registrar la nota de crédito.",
    };
  }

  return { ok: true, nota_credito_id: ncId };
}
