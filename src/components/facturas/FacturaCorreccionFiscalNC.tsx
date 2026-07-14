"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import type { NotaCreditoListItemDTO, SifenPrevueloFacturaNcDTO } from "@/lib/nota-credito/types";

const MSG_BLOQUEO_TIMBRADO_ORIGEN =
  "No se puede generar la NC porque el timbrado de la factura origen es inválido o inconsistente.";

type FacturaItemPrecarga = {
  id: string;
  descripcion: string;
  cantidad: number;
  precio_unitario: number;
  subtotal: number;
  monto_iva: number;
  total_linea: number;
  tipo_iva: "EXENTA" | "5%" | "10%";
};

type NcApiGet = {
  success?: boolean;
  data?: {
    items: NotaCreditoListItemDTO[];
    puede_crear: boolean;
    motivo_bloqueo_creacion: string | null;
    sifen_prevuelo_factura?: SifenPrevueloFacturaNcDTO;
    factura_items?: FacturaItemPrecarga[];
  };
  error?: string;
};

/** Línea del editor de NC parcial. Coincide con el input backend, más un
 *  `checked` para permitir seleccionar solo algunas líneas de la factura. */
type LineaNcEditor = {
  checked: boolean;
  factura_item_id: string | null;
  producto_nombre: string;
  cantidad_max: number;
  /** Total original de esta línea en la factura. En modo "monto" el input no
   *  puede superar este valor — el servidor también lo valida (create-nota-credito.ts). */
  total_max: number;
  precio_unitario: number;
  tipo_iva: "EXENTA" | "5%" | "10%";
  cantidad: number;
  total_linea: number;
  /** "unidades": devuelve N unidades · "monto": acredita un importe fijo ·
   *  "porcentaje": acredita un % del total de la línea (descuento comercial).
   *  El backend solo distingue unidades/monto; "porcentaje" se envía como
   *  "monto" con el importe ya calculado. */
  modo: "unidades" | "monto" | "porcentaje";
  /** Solo para modo "porcentaje": % sobre total_max (0–100). */
  porcentaje: number;
};

/** Tipo/motivo fiscal de la NC (SIFEN acepta UN solo motivo por documento). */
type TipoFiscalNc = "devolucion" | "descuento" | "bonificacion" | "ajuste";

/** Etiqueta que además dispara el iMotEmi correcto en mapMotivoNcSifen (rde-nc-xml.ts). */
const TIPO_FISCAL_NC: { value: TipoFiscalNc; label: string; hint: string }[] = [
  { value: "devolucion", label: "Devolución", hint: "Devolución de mercadería (total o parcial)." },
  { value: "descuento", label: "Descuento", hint: "Descuento comercial sin devolución física." },
  { value: "bonificacion", label: "Bonificación", hint: "Bonificación / promoción (ej. 2x1)." },
  { value: "ajuste", label: "Ajuste de precio", hint: "Corrección de precio facturado." },
];

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function ivaIncluidoDeTotal(total: number, tipoIva: "EXENTA" | "5%" | "10%"): number {
  if (tipoIva === "10%") return round2((total * 10) / 110);
  if (tipoIva === "5%") return round2((total * 5) / 105);
  return 0;
}
function totalDesdeCantidad(cantidad: number, precioUnit: number): number {
  return round2(cantidad * precioUnit);
}

function labelEstadoErp(e: string) {
  const m: Record<string, string> = {
    borrador: "Borrador",
    pendiente_envio_sifen: "Pendiente envío SIFEN",
    aprobada: "Aprobada",
    rechazada: "Rechazada",
    error: "Error",
    anulada_borrador: "Anulada (borrador)",
  };
  return m[e] ?? e;
}

function labelEstadoSifen(e: string | null) {
  if (e == null || e === "") return "—";
  const m: Record<string, string> = {
    sin_envio: "Sin envío",
    borrador: "Borrador DE",
    generado: "XML generado",
    firmado: "Firmado",
    enviado: "Enviado a SET",
    en_proceso: "En proceso (SET)",
    aprobado: "Aprobado (SET)",
    rechazado: "Rechazado (SET)",
    error_envio: "Error de envío",
    cancelado: "Cancelado",
  };
  return m[e] ?? e;
}

const NC_SIFEN_BASE = (ncId: string) => `/api/notas-credito/${ncId}/sifen`;

function mensajeErrorPlano(html: string | null | undefined): string {
  if (html == null) return "";
  return String(html)
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number.parseInt(String(n), 10)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Siguiente paso SIFEN **real**: POST sin sufijo `-test`. El ambiente SET (producción vs pruebas)
 * lo resuelve el servidor según `empresa_sifen_config.ambiente`.
 */
function nextNcSifenPasoReal(
  nc: NotaCreditoListItemDTO,
  opts: { deAprobado: boolean; puedeCancelarDe: boolean; bloqueoTimbradoOrigen: boolean }
): {
  url: string;
  label: string;
} | null {
  if (!opts.deAprobado) return null;
  if (nc.estado_erp === "anulada_borrador" || nc.estado_erp === "aprobada" || nc.estado_erp === "rechazada") {
    return null;
  }
  const st = nc.estado_sifen ?? "sin_envio";
  if (st === "aprobado") return null;
  const base = NC_SIFEN_BASE(nc.id);
  if (st === "enviado" || st === "en_proceso") {
    return { url: `${base}/consulta-lote`, label: "Consultar estado del envío" };
  }
  if (opts.bloqueoTimbradoOrigen) return null;
  if (st === "rechazado") {
    return { url: `${base}/procesar`, label: "Corregir y reenviar" };
  }
  if (st === "firmado") {
    return { url: `${base}/enviar`, label: "Enviar al SET" };
  }
  if (["sin_envio", "generado", "error_envio", "borrador"].includes(st)) {
    return {
      url: `${base}/procesar`,
      label: "Procesar envío",
    };
  }
  return null;
}

/** Solo si el servidor tiene `ALLOW_TEST_MODE` y la empresa está en producción: fuerza SOAP contra SET TEST. */
function nextNcSifenPasoTestOverride(
  nc: NotaCreditoListItemDTO,
  opts: { deAprobado: boolean; puedeCancelarDe: boolean; bloqueoTimbradoOrigen: boolean }
): {
  url: string;
  label: string;
} | null {
  if (!opts.deAprobado) return null;
  if (nc.estado_erp === "anulada_borrador" || nc.estado_erp === "aprobada" || nc.estado_erp === "rechazada") {
    return null;
  }
  const st = nc.estado_sifen ?? "sin_envio";
  if (st === "aprobado") return null;
  const base = NC_SIFEN_BASE(nc.id);
  if (st === "enviado" || st === "en_proceso") {
    return { url: `${base}/consulta-lote-test`, label: "Consultar lote (SET TEST — override)" };
  }
  if (opts.bloqueoTimbradoOrigen) return null;
  if (st === "rechazado") {
    return { url: `${base}/procesar-test`, label: "Corregir y reenviar (SET TEST)" };
  }
  if (st === "firmado") {
    return { url: `${base}/enviar-test`, label: "Enviar lote (SET TEST — override)" };
  }
  if (["sin_envio", "generado", "error_envio", "borrador"].includes(st)) {
    return { url: `${base}/procesar-test`, label: "Procesar (SET TEST — override)" };
  }
  return null;
}

function formatGs(n: number, moneda: string) {
  return moneda === "USD" ? n.toLocaleString("en-US") : n.toLocaleString("es-PY");
}

/** Correlativo de la NC con el mismo formato de 7 dígitos que el dNumDoc del CDC. */
function formatNumeroNc(n: number): string {
  return String(Math.floor(n)).padStart(7, "0");
}

export function FacturaCorreccionFiscalNC({
  facturaId,
  clienteId,
  clienteDisplay,
  monto,
  saldo,
  estado,
  moneda,
  puedeCancelarDe,
  deAprobado,
  onAfterNcMutation,
  embedded = false,
  debugUi = false,
}: {
  facturaId: string;
  clienteId: string;
  clienteDisplay: string;
  monto: number;
  saldo: number;
  estado: string;
  moneda: string;
  puedeCancelarDe: boolean;
  deAprobado: boolean;
  onAfterNcMutation?: () => void | Promise<void>;
  /** Sin caja doble: para panel unificado junto a SIFEN. */
  embedded?: boolean;
  /** Rutas XML, SET test, payload técnico, etc. */
  debugUi?: boolean;
}) {
  const [loading, setLoading] = useState(true);
  /** True una vez que reload() completó por primera vez. Evita que refetches
   *  posteriores (poll SIFEN del panel padre, acciones que disparan reload)
   *  colapsen la seccion a null y vuelva a aparecer -> parpadeo. */
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [items, setItems] = useState<NotaCreditoListItemDTO[]>([]);
  const [puedeCrear, setPuedeCrear] = useState(false);
  const [bloqueo, setBloqueo] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [obs, setObs] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [tipoNc, setTipoNc] = useState<"total" | "parcial">("total");
  const [tipoFiscal, setTipoFiscal] = useState<TipoFiscalNc>("devolucion");
  const [facturaItemsCache, setFacturaItemsCache] = useState<FacturaItemPrecarga[]>([]);
  const [lineasEditor, setLineasEditor] = useState<LineaNcEditor[]>([]);
  const [flash, setFlash] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [sifenNcId, setSifenNcId] = useState<string | null>(null);
  /** Config SIFEN empresa + flag servidor (solo para herramientas *-test opcionales). */
  const [sifenCfg, setSifenCfg] = useState<{
    empresaAmbiente: "produccion" | "test";
    allowTestOverride: boolean;
  } | null>(null);
  const [sifenPrevueloFactura, setSifenPrevueloFactura] = useState<SifenPrevueloFacturaNcDTO | null>(null);

  const monedaLabel = moneda === "USD" ? "USD" : "Gs.";

  const reload = useCallback(async () => {
    setLoading(true);
    setFlash(null);
    try {
      const resNc = await fetchWithSupabaseSession(`/api/facturas/${facturaId}/notas-credito`, {
        cache: "no-store",
      });
      if (debugUi) {
        const resCfg = await fetchWithSupabaseSession(`/api/config/allow-test-mode`, { cache: "no-store" });
        if (resCfg.ok) {
          const jc = (await resCfg.json()) as {
            success?: boolean;
            data?: { allowSifenTestOverride?: boolean; empresa_sifen_ambiente?: string };
          };
          if (jc.success && jc.data) {
            const amb =
              jc.data.empresa_sifen_ambiente === "produccion" ? "produccion" : "test";
            setSifenCfg({
              empresaAmbiente: amb,
              allowTestOverride: !!jc.data.allowSifenTestOverride,
            });
          } else {
            setSifenCfg({ empresaAmbiente: "test", allowTestOverride: false });
          }
        } else {
          setSifenCfg({ empresaAmbiente: "test", allowTestOverride: false });
        }
      } else {
        setSifenCfg(null);
      }
      const res = resNc;
      const j = (await res.json()) as NcApiGet;
      if (!res.ok || !j.success || !j.data) {
        setItems([]);
        setPuedeCrear(false);
        setBloqueo(j.error ?? "No se pudo cargar notas de crédito");
        setSifenPrevueloFactura(null);
        return;
      }
      setItems(j.data.items);
      setPuedeCrear(j.data.puede_crear);
      setBloqueo(j.data.motivo_bloqueo_creacion ?? null);
      setSifenPrevueloFactura(j.data.sifen_prevuelo_factura ?? null);
      setFacturaItemsCache(j.data.factura_items ?? []);
    } catch {
      setItems([]);
      setPuedeCrear(false);
      setBloqueo("Error de red");
      setSifenPrevueloFactura(null);
    } finally {
      setLoading(false);
      setHasLoadedOnce(true);
    }
  }, [facturaId, debugUi]);

  useEffect(() => {
    void reload();
  }, [reload]);

  function abrirModalCrear() {
    setMotivo("");
    setObs("");
    setTipoNc("total");
    setTipoFiscal("devolucion");
    // Precarga las líneas desde factura_items. Todas empiezan desmarcadas
    // en modo 'unidades' con la cantidad y precio originales.
    const lineas: LineaNcEditor[] = facturaItemsCache.map((it) => {
      const precioUnit =
        it.cantidad > 0
          ? round2(it.total_linea / it.cantidad)
          : round2(it.precio_unitario);
      return {
        checked: false,
        factura_item_id: it.id,
        producto_nombre: it.descripcion,
        cantidad_max: it.cantidad,
        total_max: it.total_linea,
        precio_unitario: precioUnit,
        tipo_iva: it.tipo_iva,
        cantidad: it.cantidad,
        total_linea: it.total_linea,
        modo: "unidades",
        porcentaje: 0,
      };
    });
    setLineasEditor(lineas);
    setModalOpen(true);
  }

  const totalParcialSeleccionado = round2(
    lineasEditor.filter((l) => l.checked).reduce((s, l) => s + l.total_linea, 0)
  );

  // Tope de la NC = monto facturado − NC aprobadas − NC en curso. NO es el saldo:
  // una factura CONTADO tiene saldo 0 y aun así puede acreditarse (devolución,
  // descuento, bonificación). Mismo criterio que el backend y el RPC de aprobación.
  const ncSumaAprobadas = round2(
    items.filter((n) => n.estado_erp === "aprobada").reduce((s, n) => s + Number(n.monto || 0), 0)
  );
  const ncSumaEnCurso = round2(
    items
      .filter((n) => n.estado_erp === "borrador" || n.estado_erp === "pendiente_envio_sifen")
      .reduce((s, n) => s + Number(n.monto || 0), 0)
  );
  const acreditable = Math.max(0, round2(monto - ncSumaAprobadas));
  const disponibleParaNc = Math.max(0, round2(acreditable - ncSumaEnCurso));

  function actualizarLinea(idx: number, patch: Partial<LineaNcEditor>) {
    setLineasEditor((prev) => {
      const next = prev.slice();
      const actual = next[idx];
      if (!actual) return prev;
      const merged: LineaNcEditor = { ...actual, ...patch };
      // Si cambia el modo, recalcula base sensata.
      if (patch.modo && patch.modo !== actual.modo) {
        if (merged.modo === "unidades") {
          merged.cantidad = Math.min(actual.cantidad_max, actual.cantidad || 1);
          merged.total_linea = totalDesdeCantidad(merged.cantidad, merged.precio_unitario);
        } else if (merged.modo === "porcentaje") {
          // Arranca en 100% del total de la línea; el operador ajusta el %.
          merged.cantidad = 1;
          merged.porcentaje = merged.porcentaje > 0 ? merged.porcentaje : 100;
          merged.total_linea = round2((merged.total_max * merged.porcentaje) / 100);
        } else {
          merged.cantidad = 1;
        }
      }
      // Si cambia cantidad en modo 'unidades', recalcula total.
      if ("cantidad" in patch && merged.modo === "unidades") {
        const clamped = Math.max(0, Math.min(merged.cantidad_max, Number(patch.cantidad) || 0));
        merged.cantidad = clamped;
        merged.total_linea = totalDesdeCantidad(clamped, merged.precio_unitario);
      }
      // Si cambia el % en modo 'porcentaje', recalcula el total (0–100% del total línea).
      if ("porcentaje" in patch && merged.modo === "porcentaje") {
        const pct = Math.max(0, Math.min(100, round2(Number(patch.porcentaje) || 0)));
        merged.porcentaje = pct;
        merged.total_linea = round2((merged.total_max * pct) / 100);
      }
      // Si cambia total en modo 'monto', respetá el valor libre pero sin
      // superar el total original de esa línea (el servidor también lo valida).
      if ("total_linea" in patch && merged.modo === "monto") {
        merged.total_linea = Math.max(
          0,
          Math.min(merged.total_max, round2(Number(patch.total_linea) || 0))
        );
      }
      next[idx] = merged;
      return next;
    });
  }

  async function handleCrear() {
    setFlash(null);
    // El tipo fiscal (Devolución/Descuento/Bonificación/Ajuste) define el iMotEmi
    // SIFEN; el texto libre es un detalle opcional. Se combinan en el motivo que
    // mapMotivoNcSifen (rde-nc-xml.ts) interpreta por palabra clave.
    const tipoLabel = TIPO_FISCAL_NC.find((t) => t.value === tipoFiscal)?.label ?? "Devolución";
    const detalle = motivo.trim();
    const motivoFinal = detalle ? `${tipoLabel}: ${detalle}` : tipoLabel;
    // Validaciones cliente para NC parcial.
    const lineasElegidas = lineasEditor.filter((l) => l.checked && l.total_linea > 0);
    if (tipoNc === "parcial") {
      if (lineasElegidas.length === 0) {
        setFlash({ kind: "err", text: "Marcá al menos una línea con total mayor a 0." });
        return;
      }
      if (totalParcialSeleccionado > disponibleParaNc + 0.02) {
        setFlash({
          kind: "err",
          text: `La suma seleccionada (${monedaLabel} ${formatGs(totalParcialSeleccionado, moneda)}) supera el importe acreditable (${monedaLabel} ${formatGs(disponibleParaNc, moneda)}).`,
        });
        return;
      }
    }
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        motivo: motivoFinal,
        observacion_interna: obs.trim() || null,
        tipo_nc: tipoNc,
      };
      if (tipoNc === "parcial") {
        // "porcentaje" es un modo de UI: el backend solo distingue unidades/monto,
        // así que lo enviamos como "monto" con el importe ya calculado.
        body.items = lineasElegidas.map((l) => ({
          factura_item_id: l.factura_item_id,
          producto_nombre: l.producto_nombre,
          cantidad: l.modo === "unidades" ? l.cantidad : 1,
          precio_unitario: l.modo === "unidades" ? l.precio_unitario : l.total_linea,
          tipo_iva: l.tipo_iva,
          total_linea: l.total_linea,
          modo: l.modo === "unidades" ? "unidades" : "monto",
        }));
      }
      const res = await fetchWithSupabaseSession(`/api/facturas/${facturaId}/notas-credito`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !j.success) {
        setFlash({ kind: "err", text: j.error ?? `Error ${res.status}` });
        return;
      }
      setModalOpen(false);
      setMotivo("");
      setObs("");
      setFlash({ kind: "ok", text: "Nota de crédito creada. Usá el paso SIFEN del historial cuando corresponda." });
      await reload();
      await onAfterNcMutation?.();
    } catch (e) {
      setFlash({ kind: "err", text: e instanceof Error ? e.message : "Error de red" });
    } finally {
      setSubmitting(false);
    }
  }

  async function ejecutarPasoSifen(nc: NotaCreditoListItemDTO, step: { url: string; label: string }) {
    setSifenNcId(nc.id);
    setFlash(null);
    try {
      const res = await fetchWithSupabaseSession(step.url, { method: "POST" });
      const j = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !j.success) {
        setFlash({ kind: "err", text: j.error ?? `Error ${res.status}` });
        return;
      }
      setFlash({ kind: "ok", text: `${step.label}: OK.` });
      await reload();
      await onAfterNcMutation?.();
    } catch (e) {
      setFlash({ kind: "err", text: e instanceof Error ? e.message : "Error de red" });
    } finally {
      setSifenNcId(null);
    }
  }

  /**
   * Cancelación REAL ante la SET: manda el evento siRecepEvento. Solo si la SET
   * lo registra, el ERP marca la NC cancelada y devuelve el saldo a la factura.
   * Si la SET rechaza, no se toca nada local (el documento sigue vigente para el fisco).
   */
  async function cancelarNcEnSet(nc: NotaCreditoListItemDTO) {
    const motivo = prompt(
      "Motivo de la cancelación ante la SET (mínimo 5 caracteres).\n\n" +
        "Se envía el evento de cancelación a la SET. Si lo registra, la nota de crédito " +
        "queda anulada y el saldo vuelve a la factura."
    );
    if (motivo == null) return;
    if (motivo.trim().length < 5) {
      setFlash({ kind: "err", text: "El motivo debe tener al menos 5 caracteres." });
      return;
    }
    setSifenNcId(nc.id);
    setFlash(null);
    try {
      const res = await fetchWithSupabaseSession(`${NC_SIFEN_BASE(nc.id)}/cancelar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ motivo: motivo.trim() }),
      });
      const j = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !j.success) {
        setFlash({
          kind: "err",
          text: `La SET no canceló la nota de crédito: ${mensajeErrorPlano(j.error) || j.error || `Error ${res.status}`}`,
        });
        return;
      }
      setFlash({ kind: "ok", text: "Nota de crédito cancelada en la SET. El saldo volvió a la factura." });
      await reload();
      await onAfterNcMutation?.();
    } catch (e) {
      setFlash({ kind: "err", text: e instanceof Error ? e.message : "Error de red" });
    } finally {
      setSifenNcId(null);
    }
  }

  async function anularBorrador(nc: NotaCreditoListItemDTO) {
    if (!confirm("¿Anular esta nota de crédito en borrador? Podrás crear otra después.")) return;
    setFlash(null);
    try {
      const res = await fetchWithSupabaseSession(`/api/facturas/${facturaId}/notas-credito/${nc.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "anular_borrador" }),
      });
      const j = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !j.success) {
        setFlash({ kind: "err", text: j.error ?? `Error ${res.status}` });
        return;
      }
      setFlash({ kind: "ok", text: "Borrador anulado." });
      await reload();
      await onAfterNcMutation?.();
    } catch (e) {
      setFlash({ kind: "err", text: e instanceof Error ? e.message : "Error de red" });
    }
  }

  const ambienteLabel =
    sifenCfg?.empresaAmbiente === "produccion" ? "Producción (SET real)" : "Pruebas (SET test)";
  const mostrarHerramientasTestOverride =
    Boolean(sifenCfg?.allowTestOverride && sifenCfg.empresaAmbiente === "produccion");

  const bloqueoTimbradoOrigen = Boolean(sifenPrevueloFactura && !sifenPrevueloFactura.ok);
  const sifenPasoOpts = { deAprobado, puedeCancelarDe, bloqueoTimbradoOrigen };

  const ncRechazoMasReciente = items.find((x) => x.estado_sifen === "rechazado");
  const pasoReenviarBanner =
    ncRechazoMasReciente && nextNcSifenPasoReal(ncRechazoMasReciente, sifenPasoOpts);

  /** Solo si hay NC en juego o el gate permite crear una (evita ruido por solo pre-vuelo/timbrado). */
  const correccionOperativa = items.length > 0 || puedeCrear;

  // Solo escondemos mientras carga la PRIMERA vez. En refetches posteriores
  // (polling SIFEN del panel padre, acciones que disparan reload) mantenemos
  // lo ultimo mostrado para evitar parpadeo aparecer/desaparecer.
  if (loading && !hasLoadedOnce) {
    return null;
  }
  if (!correccionOperativa) {
    return null;
  }

  const shell = embedded
    ? "space-y-4 w-full min-w-0 lg:max-w-[26rem]"
    : "rounded-xl border border-slate-200 bg-white shadow-sm p-5 sm:p-6 space-y-4 w-full min-w-0";

  return (
    <div className={shell}>
      <div className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wide">Nota de crédito</h3>
            {debugUi ? (
              <p className="text-[11px] text-slate-500 mt-1">
                Ambiente: <span className="font-semibold text-slate-700">{ambienteLabel}</span>
              </p>
            ) : null}
          </div>
          {debugUi ? (
            <Link
              href="/notas-credito"
              className="text-[11px] font-semibold text-[#0EA5E9] hover:underline shrink-0"
            >
              Módulo NC
            </Link>
          ) : null}
        </div>
      </div>

      {mostrarHerramientasTestOverride && debugUi && (
        <details className="rounded-lg border border-dashed border-slate-300 bg-slate-50/80 px-3 py-2 text-[11px] text-slate-700">
          <summary className="cursor-pointer font-semibold text-slate-600 select-none">
            Herramientas desarrollo (SET TEST con override)
          </summary>
          <p className="mt-2 text-slate-600 leading-snug">
            El servidor tiene <span className="font-mono">ALLOW_TEST_MODE</span>. Los enlaces bajo{" "}
            <span className="font-mono">*-test</span> envían el SOAP a SET de pruebas aunque la empresa esté en
            producción. No uses esto en operación real salvo diagnóstico.
          </p>
        </details>
      )}

      {deAprobado && estado !== "Anulado" && bloqueoTimbradoOrigen && (
        <div
          className="rounded-lg border-2 border-amber-700 bg-amber-50 px-3 py-3 text-sm text-amber-950 shadow-sm"
          role="alert"
        >
          <p className="font-bold">{MSG_BLOQUEO_TIMBRADO_ORIGEN}</p>
          {sifenPrevueloFactura?.mensaje ? (
            <p className="mt-2 text-xs text-amber-900/90 font-mono whitespace-pre-wrap break-words">
              {sifenPrevueloFactura.mensaje}
            </p>
          ) : null}
          <p className="mt-2 text-xs text-amber-900/80">
            Corregí la configuración SIFEN o el documento electrónico de la factura origen; no se reintentará el envío
            hasta que el sistema valide coherencia con el XML firmado.
          </p>
        </div>
      )}

      {deAprobado && estado !== "Anulado" && puedeCrear ? (
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => {
              setFlash(null);
              abrirModalCrear();
            }}
            className="px-4 py-2.5 text-xs font-semibold rounded-lg bg-[#0EA5E9] text-white hover:bg-[#0284C7] shadow-sm"
          >
            Emitir nota de crédito
          </button>
        </div>
      ) : null}

      {ncRechazoMasReciente && deAprobado && (
        <div
          className="rounded-lg border-2 border-red-600 bg-red-50 p-4 space-y-3 shadow-sm"
          role="alert"
        >
          <p className="text-base font-bold text-red-800">Nota de crédito rechazada por SET</p>
          <p className="text-sm text-red-950 leading-relaxed">
            {mensajeErrorPlano(ncRechazoMasReciente.last_error) ||
              "La SET devolvió un rechazo. Revisá el detalle técnico en la NC correspondiente."}
          </p>
          {bloqueoTimbradoOrigen ? (
            <p className="text-sm font-semibold text-red-900">{MSG_BLOQUEO_TIMBRADO_ORIGEN}</p>
          ) : null}
          {pasoReenviarBanner ? (
            <button
              type="button"
              disabled={sifenNcId === ncRechazoMasReciente.id}
              onClick={() => void ejecutarPasoSifen(ncRechazoMasReciente, pasoReenviarBanner)}
              className="inline-flex items-center justify-center px-4 py-2.5 rounded-lg bg-red-700 text-white text-sm font-semibold hover:bg-red-800 disabled:opacity-50 shadow-sm"
            >
              {sifenNcId === ncRechazoMasReciente.id ? "Procesando…" : "Corregir y reenviar"}
            </button>
          ) : null}
        </div>
      )}

      {flash && (
        <div
          className={`rounded-lg text-sm px-3 py-2 ${
            flash.kind === "ok"
              ? "bg-emerald-50 border border-emerald-200 text-emerald-900"
              : "bg-red-50 border border-red-200 text-red-900"
          }`}
        >
          {flash.kind === "err" ? mensajeErrorPlano(flash.text) || flash.text : flash.text}
        </div>
      )}

      {items.length > 0 && (
        <section className="border-t border-slate-100 pt-4 space-y-4 min-w-0" aria-label="Notas de crédito">
          <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider">Notas de crédito</h4>
          <ul className="space-y-4 list-none p-0 m-0">
            {items.map((nc) => {
              const pasoReal = nextNcSifenPasoReal(nc, sifenPasoOpts);
              const pasoTestOv =
                debugUi && mostrarHerramientasTestOverride && nextNcSifenPasoTestOverride(nc, sifenPasoOpts);
              const errPlano = mensajeErrorPlano(nc.last_error);
              const jsonSet =
                nc.sifen_respuestas_set != null ? JSON.stringify(nc.sifen_respuestas_set, null, 2) : null;
              return (
                <li
                  key={nc.id}
                  className="rounded-lg border border-slate-200 bg-white shadow-sm overflow-hidden min-w-0"
                >
                  <div className="px-3 sm:px-4 py-3 border-b border-slate-100 bg-slate-50/80 space-y-2">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 space-y-1">
                        <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
                          Nota de crédito{nc.numero != null ? ` N° ${formatNumeroNc(nc.numero)}` : ""}
                        </p>
                        <p className="text-xs text-slate-800">
                          <span className="text-slate-500">Creada</span>{" "}
                          {new Date(nc.created_at).toLocaleString("es-PY", {
                            dateStyle: "short",
                            timeStyle: "short",
                          })}{" "}
                          · {monedaLabel} {formatGs(nc.monto, moneda)}
                        </p>
                        <p className="text-[11px] text-slate-600">
                          <span className="font-semibold text-slate-700">ERP:</span> {labelEstadoErp(nc.estado_erp)} ·{" "}
                          <span className="font-semibold text-slate-700">SIFEN:</span>{" "}
                          {labelEstadoSifen(nc.estado_sifen)}
                        </p>
                        {nc.motivo ? (
                          <p className="text-[11px] text-slate-600 line-clamp-2" title={nc.motivo}>
                            <span className="font-semibold text-slate-700">Motivo:</span> {nc.motivo}
                          </p>
                        ) : null}
                        {/* Detalle de la NC parcial: qué líneas se acreditaron. */}
                        {nc.items.length > 0 ? (
                          <div className="pt-1">
                            <p className="text-[11px] font-semibold text-slate-700">Detalle</p>
                            <ul className="mt-0.5 space-y-0.5 list-none p-0 m-0">
                              {nc.items.map((l, i) => (
                                <li key={i} className="text-[11px] text-slate-600 flex gap-2">
                                  <span className="min-w-0 flex-1 truncate" title={l.producto_nombre}>
                                    {l.cantidad > 0 ? `${formatGs(l.cantidad, moneda)}× ` : ""}
                                    {l.producto_nombre}
                                    {l.sku ? <span className="text-slate-400"> ({l.sku})</span> : null}
                                  </span>
                                  <span className="shrink-0 tabular-nums text-slate-700">
                                    {monedaLabel} {formatGs(l.total_linea, moneda)}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                      </div>
                      <div className="flex flex-col gap-1.5 shrink-0 w-full sm:w-auto sm:min-w-[11rem]">
                        {pasoReal ? (
                          <button
                            type="button"
                            disabled={sifenNcId === nc.id}
                            onClick={() => void ejecutarPasoSifen(nc, pasoReal)}
                            className="w-full sm:w-auto text-center px-3 py-2 rounded-lg bg-sky-600 text-white text-xs font-semibold hover:bg-sky-700 disabled:opacity-50"
                          >
                            {sifenNcId === nc.id ? "…" : pasoReal.label}
                          </button>
                        ) : null}
                        {pasoTestOv ? (
                          <button
                            type="button"
                            disabled={sifenNcId === nc.id}
                            onClick={() => void ejecutarPasoSifen(nc, pasoTestOv)}
                            className="w-full sm:w-auto text-center px-2 py-1.5 rounded-md border border-dashed border-slate-400 text-slate-600 text-[10px] font-medium hover:bg-slate-50 disabled:opacity-50"
                          >
                            {pasoTestOv.label}
                          </button>
                        ) : null}
                        {nc.estado_erp === "borrador" ? (
                          <button
                            type="button"
                            onClick={() => void anularBorrador(nc)}
                            className="text-[#0284C7] font-semibold hover:underline text-[11px] text-left"
                          >
                            Anular borrador
                          </button>
                        ) : null}
                        {/* Cancelación REAL ante la SET (evento siRecepEvento). Solo
                            para NC ya aprobadas; hay plazo desde la aprobación. */}
                        {nc.estado_erp === "aprobada" && nc.estado_sifen === "aprobado" ? (
                          <button
                            type="button"
                            disabled={sifenNcId === nc.id}
                            onClick={() => void cancelarNcEnSet(nc)}
                            className="w-full sm:w-auto text-center px-3 py-2 rounded-lg border border-red-300 bg-white text-red-700 text-xs font-semibold hover:bg-red-50 disabled:opacity-50"
                            title="Envía a la SET el evento de cancelación. Si la SET lo registra, se anula la NC y se devuelve el saldo a la factura."
                          >
                            {sifenNcId === nc.id ? "Cancelando…" : "Cancelar en SET"}
                          </button>
                        ) : null}
                        {nc.estado_sifen === "aprobado" ? (
                          <a
                            href={`/api/notas-credito/${nc.id}/sifen/kude`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="w-full sm:w-auto text-center px-3 py-2 rounded-lg bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700"
                          >
                            Imprimir KUDE
                          </a>
                        ) : null}
                        {!pasoReal && !pasoTestOv && nc.estado_erp !== "borrador" && nc.estado_sifen !== "aprobado" ? (
                          <span className="text-slate-400 text-[11px]">Sin acción SIFEN disponible</span>
                        ) : null}
                      </div>
                    </div>
                    {nc.estado_sifen === "rechazado" && errPlano ? (
                      <p className="text-sm text-red-900 font-medium leading-snug border-t border-red-100 pt-2 mt-1">
                        {errPlano}
                      </p>
                    ) : null}
                  </div>
                  {!debugUi ? (
                    nc.cdc ? (
                      <div className="px-3 sm:px-4 py-2 border-b border-slate-50">
                        <p className="text-[10px] text-slate-500">
                          CDC <span className="font-mono text-slate-700 break-all">{nc.cdc}</span>
                        </p>
                      </div>
                    ) : null
                  ) : (
                    <>
                      <div className="px-3 sm:px-4 py-2 space-y-1.5 text-[11px] text-slate-600 border-b border-slate-50">
                        <p>
                          <span className="font-semibold text-slate-500">CDC NC:</span>{" "}
                          <span className="font-mono break-all text-slate-800">{nc.cdc ?? "—"}</span>
                        </p>
                        {nc.cdc_factura_origen ? (
                          <p>
                            <span className="font-semibold text-slate-500">CDC factura origen:</span>{" "}
                            <span className="font-mono break-all text-slate-800">{nc.cdc_factura_origen}</span>
                          </p>
                        ) : null}
                        <p>
                          <span className="font-semibold text-slate-500">Usuario:</span>{" "}
                          {nc.created_by_nombre_snapshot ?? nc.created_by_email_snapshot ?? "—"}
                        </p>
                      </div>
                      <div className="px-3 sm:px-4 py-2.5 space-y-2 text-[11px] border-b border-slate-100 bg-slate-50/40">
                        <p className="font-semibold text-slate-600 uppercase tracking-wide text-[10px]">
                          Rutas storage SIFEN (NC)
                        </p>
                        <div className="space-y-1">
                          <p className="text-slate-500">
                            <span className="font-semibold text-slate-600">XML generado</span>{" "}
                            <span className="text-slate-400">(xml_path)</span>
                          </p>
                          <p
                            className="font-mono text-[10px] text-slate-800 break-all select-all rounded border border-slate-200 bg-white px-2 py-1.5"
                            title={nc.xml_path ?? undefined}
                          >
                            {nc.xml_path ?? "—"}
                          </p>
                        </div>
                        <div className="space-y-1">
                          <p className="text-slate-500">
                            <span className="font-semibold text-slate-600">XML firmado</span>{" "}
                            <span className="text-slate-400">(xml_firmado_path)</span>
                          </p>
                          <p
                            className="font-mono text-[10px] text-slate-800 break-all select-all rounded border border-slate-200 bg-white px-2 py-1.5"
                            title={nc.xml_firmado_path ?? undefined}
                          >
                            {nc.xml_firmado_path ?? "—"}
                          </p>
                        </div>
                      </div>
                      <details className="px-3 sm:px-4 py-2 bg-white text-[11px] group">
                        <summary className="cursor-pointer font-semibold text-slate-600 select-none list-none flex items-center gap-2 [&::-webkit-details-marker]:hidden">
                          <span className="text-slate-400 group-open:rotate-90 transition-transform inline-block">▸</span>
                          SIFEN (detalle técnico y respuestas SET)
                        </summary>
                        <p className="mt-2 text-slate-500 leading-snug">
                          Flujo estándar: <span className="font-mono text-slate-700">POST …/sifen/procesar</span>{" "}
                          (generar XML, firmar, recibe-lote), luego <span className="font-mono">enviar</span> /{" "}
                          <span className="font-mono">consulta-lote</span> según estado.
                        </p>
                        {jsonSet ? (
                          <pre className="mt-2 max-h-56 overflow-auto rounded-md bg-slate-900 text-slate-100 p-3 text-[10px] leading-relaxed whitespace-pre-wrap break-words border border-slate-700">
                            {jsonSet}
                          </pre>
                        ) : (
                          <p className="mt-2 text-slate-400 italic">No hay JSON de respuesta SET guardado para esta NC.</p>
                        )}
                      </details>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {modalOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/40"
          role="dialog"
          aria-modal="true"
          aria-labelledby="nc-modal-title"
        >
          <div className="bg-white rounded-xl shadow-xl max-w-lg w-full p-5 space-y-3 border border-slate-200 max-h-[90vh] overflow-y-auto">
            <h4 id="nc-modal-title" className="text-sm font-bold text-slate-900">
              Crear nota de crédito
            </h4>
            <dl className="grid grid-cols-2 gap-2 text-xs text-slate-700">
              <div className="col-span-2">
                <dt className="text-slate-400">Cliente</dt>
                <dd className="font-medium">
                  <Link href={`/clientes/${clienteId}`} className="text-[#0EA5E9] hover:underline">
                    {clienteDisplay || "Cliente"}
                  </Link>
                </dd>
              </div>
              <div>
                <dt className="text-slate-400">Factura</dt>
                <dd className="font-mono text-[11px]">{facturaId.slice(0, 8)}…</dd>
              </div>
              <div>
                <dt className="text-slate-400">Monto factura</dt>
                <dd className="tabular-nums font-semibold">
                  {monedaLabel} {formatGs(monto, moneda)}
                </dd>
              </div>
              <div>
                <dt className="text-slate-400">
                  {ncSumaAprobadas > 0 ? "Ya acreditado (NC aprobadas)" : "Cobrado"}
                </dt>
                <dd className="tabular-nums font-medium">
                  {monedaLabel}{" "}
                  {formatGs(
                    ncSumaAprobadas > 0 ? ncSumaAprobadas : Math.max(0, monto - saldo),
                    moneda
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-slate-400">
                  Disponible para NC {tipoNc === "total" ? "(= NC)" : ""}
                </dt>
                <dd className="tabular-nums font-bold text-[#0284C7]">
                  {monedaLabel} {formatGs(disponibleParaNc, moneda)}
                </dd>
              </div>
              <div className="col-span-2 text-[11px] text-slate-500">
                Luego usá en el historial <span className="font-semibold">Procesar envío SIFEN</span> (flujo real según
                ambiente de la empresa).
              </div>
            </dl>

            {/* Motivo fiscal (SIFEN acepta un solo motivo por NC) */}
            <div>
              <div className="text-xs font-semibold text-slate-600 mb-1">Motivo fiscal</div>
              <div className="flex flex-wrap gap-1.5">
                {TIPO_FISCAL_NC.map((t) => (
                  <button
                    key={t.value}
                    type="button"
                    onClick={() => setTipoFiscal(t.value)}
                    title={t.hint}
                    className={`px-3 py-1.5 text-xs font-semibold rounded-lg border ${
                      tipoFiscal === t.value
                        ? "bg-[#0EA5E9] text-white border-[#0EA5E9]"
                        : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-[11px] text-slate-500">
                {TIPO_FISCAL_NC.find((t) => t.value === tipoFiscal)?.hint}
                {tipoFiscal !== "devolucion"
                  ? " No repone stock; solo ajusta el saldo/importe."
                  : null}
              </p>
            </div>

            {/* Toggle Total / Parcial */}
            <div>
              <div className="text-xs font-semibold text-slate-600 mb-1">Tipo de nota de crédito</div>
              <div className="inline-flex rounded-lg border border-slate-200 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setTipoNc("total")}
                  className={`px-3 py-1.5 text-xs font-semibold ${
                    tipoNc === "total"
                      ? "bg-[#0EA5E9] text-white"
                      : "bg-white text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  Total (acredita todo)
                </button>
                <button
                  type="button"
                  onClick={() => setTipoNc("parcial")}
                  disabled={facturaItemsCache.length === 0}
                  title={
                    facturaItemsCache.length === 0
                      ? "No hay ítems de factura para seleccionar."
                      : undefined
                  }
                  className={`px-3 py-1.5 text-xs font-semibold ${
                    tipoNc === "parcial"
                      ? "bg-[#0EA5E9] text-white"
                      : "bg-white text-slate-700 hover:bg-slate-50"
                  } disabled:opacity-40 disabled:cursor-not-allowed`}
                >
                  Parcial (por ítem)
                </button>
              </div>
              <p className="mt-1 text-[11px] text-slate-500">
                {tipoNc === "total"
                  ? "Acredita todo el importe disponible en un solo tramo."
                  : "Elegí líneas y modo por cada ítem. Podés emitir varias NC parciales hasta agotar el importe acreditable."}
              </p>
            </div>

            {/* Editor de líneas cuando es parcial */}
            {tipoNc === "parcial" && lineasEditor.length > 0 && (
              <div className="rounded-lg border border-slate-200 overflow-hidden">
                <div className="max-h-64 overflow-auto">
                  <table className="w-full text-[11px]">
                    <thead className="bg-slate-50 sticky top-0">
                      <tr className="text-left text-slate-500">
                        <th className="px-2 py-1 w-8"></th>
                        <th className="px-2 py-1">Producto</th>
                        <th className="px-2 py-1">Modo</th>
                        <th className="px-2 py-1 text-right">Cant.</th>
                        <th className="px-2 py-1 text-right">Total línea</th>
                        <th className="px-2 py-1 text-right">IVA</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lineasEditor.map((l, idx) => {
                        const iva = ivaIncluidoDeTotal(l.total_linea, l.tipo_iva);
                        return (
                          <tr key={idx} className="border-t border-slate-100">
                            <td className="px-2 py-1 align-middle">
                              <input
                                type="checkbox"
                                checked={l.checked}
                                onChange={(e) => actualizarLinea(idx, { checked: e.target.checked })}
                              />
                            </td>
                            <td className="px-2 py-1 align-middle">
                              <div className="text-slate-800">{l.producto_nombre}</div>
                              <div className="text-[10px] text-slate-400">
                                Máx {l.cantidad_max} × {monedaLabel} {formatGs(l.precio_unitario, moneda)} ({l.tipo_iva})
                              </div>
                            </td>
                            <td className="px-2 py-1 align-middle">
                              <select
                                value={l.modo}
                                disabled={!l.checked}
                                onChange={(e) =>
                                  actualizarLinea(idx, {
                                    modo: e.target.value as "unidades" | "monto" | "porcentaje",
                                  })
                                }
                                className="text-[11px] border border-slate-200 rounded px-1 py-0.5 disabled:opacity-40"
                              >
                                <option value="unidades">Unidades</option>
                                <option value="monto">Monto</option>
                                <option value="porcentaje">Porcentaje</option>
                              </select>
                            </td>
                            <td className="px-2 py-1 align-middle text-right">
                              {l.modo === "unidades" ? (
                                <input
                                  type="number"
                                  min={0}
                                  max={l.cantidad_max}
                                  step={l.cantidad_max % 1 === 0 ? 1 : 0.01}
                                  value={l.cantidad}
                                  disabled={!l.checked}
                                  onChange={(e) => actualizarLinea(idx, { cantidad: Number(e.target.value) })}
                                  className="w-16 text-right border border-slate-200 rounded px-1 py-0.5 disabled:opacity-40"
                                />
                              ) : l.modo === "porcentaje" ? (
                                <span className="inline-flex items-center gap-0.5">
                                  <input
                                    type="number"
                                    min={0}
                                    max={100}
                                    step={1}
                                    value={l.porcentaje}
                                    disabled={!l.checked}
                                    onChange={(e) => actualizarLinea(idx, { porcentaje: Number(e.target.value) })}
                                    className="w-14 text-right border border-slate-200 rounded px-1 py-0.5 disabled:opacity-40"
                                  />
                                  <span className="text-slate-400">%</span>
                                </span>
                              ) : (
                                <span className="text-slate-400">1</span>
                              )}
                            </td>
                            <td className="px-2 py-1 align-middle text-right">
                              {l.modo === "monto" ? (
                                <input
                                  type="number"
                                  min={0}
                                  max={l.total_max}
                                  step={1}
                                  value={l.total_linea}
                                  disabled={!l.checked}
                                  onChange={(e) => actualizarLinea(idx, { total_linea: Number(e.target.value) })}
                                  className="w-24 text-right border border-slate-200 rounded px-1 py-0.5 disabled:opacity-40 tabular-nums"
                                />
                              ) : (
                                <span className="tabular-nums text-slate-800">
                                  {monedaLabel} {formatGs(l.total_linea, moneda)}
                                </span>
                              )}
                            </td>
                            <td className="px-2 py-1 align-middle text-right tabular-nums text-slate-500">
                              {monedaLabel} {formatGs(iva, moneda)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot className="bg-slate-50 border-t border-slate-200">
                      <tr>
                        <td colSpan={4} className="px-2 py-1 text-right font-semibold text-slate-600">
                          Total NC seleccionada
                        </td>
                        <td className="px-2 py-1 text-right tabular-nums font-bold text-[#0284C7]">
                          {monedaLabel} {formatGs(totalParcialSeleccionado, moneda)}
                        </td>
                        <td />
                      </tr>
                      <tr>
                        <td colSpan={6} className="px-2 py-1 text-right text-[10px] text-slate-500">
                          Disponible para NC: {monedaLabel} {formatGs(disponibleParaNc, moneda)}.
                          {totalParcialSeleccionado > disponibleParaNc + 0.02 && (
                            <span className="text-red-600 ml-1">Supera el importe acreditable.</span>
                          )}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            )}

            {tipoNc === "parcial" && lineasEditor.length === 0 && (
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
                Esta factura no tiene ítems desglosados (ej. factura de suscripción). Usá el modo Total.
              </div>
            )}

            <label className="block text-xs font-semibold text-slate-600">
              Detalle del motivo (opcional)
              <textarea
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                rows={3}
                className="mt-1 w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0EA5E9]"
                placeholder="Ej.: Promoción 2x1, bonificación acordada, error de facturación…"
              />
              <span className="mt-1 block text-[11px] font-normal text-slate-400">
                Se combina con el motivo fiscal seleccionado arriba (ej. «Descuento: Promoción 2x1»).
              </span>
            </label>
            <label className="block text-xs font-semibold text-slate-600">
              Observación interna (opcional)
              <textarea
                value={obs}
                onChange={(e) => setObs(e.target.value)}
                rows={2}
                className="mt-1 w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0EA5E9]"
              />
            </label>
            <div className="flex flex-wrap justify-end gap-2 pt-1">
              <button
                type="button"
                disabled={submitting}
                onClick={() => setModalOpen(false)}
                className="px-3 py-2 text-xs font-semibold rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50"
              >
                Cerrar
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={() => void handleCrear()}
                className="px-3 py-2 text-xs font-semibold rounded-lg bg-[#0EA5E9] text-white hover:bg-[#0284C7] disabled:opacity-50"
              >
                {submitting ? "Guardando…" : "Confirmar creación"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
