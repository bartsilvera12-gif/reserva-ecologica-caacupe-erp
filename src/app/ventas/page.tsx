"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useState } from "react";
import { AlertTriangle, RotateCw, X } from "lucide-react";
import EdgeScrollArea from "@/components/ui/EdgeScrollArea";
import { FancySelect } from "@/components/ui/FancySelect";
import MobileFab from "@/components/ui/MobileFab";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import { getVentas } from "@/lib/ventas/storage";
import PedidosPendientesCaja from "./PedidosPendientesCaja";
import AnularVentaModal from "./AnularVentaModal";
import { esMismoDiaAsuncion } from "@/lib/fecha/asuncion";
import type { Venta, TipoVenta, TipoIvaVenta } from "@/lib/ventas/types";

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatGs(valor: number) {
  return `Gs. ${Math.round(valor).toLocaleString("es-PY")}`;
}

function formatFecha(iso: string) {
  try {
    const d    = new Date(iso);
    const dd   = String(d.getDate()).padStart(2, "0");
    const mm   = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    const hh   = String(d.getHours()).padStart(2, "0");
    const min  = String(d.getMinutes()).padStart(2, "0");
    return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
  } catch {
    return iso;
  }
}

// ── Constantes de estilo ───────────────────────────────────────────────────────

const inputFilterClass =
  "border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-[#0EA5E9] focus:outline-none";

const tipoVentaBadge: Record<TipoVenta, string> = {
  CONTADO: "bg-blue-50 text-blue-700",
  CREDITO: "bg-orange-50 text-orange-700",
};

const ivaLabel: Record<TipoIvaVenta, string> = {
  EXENTA: "Exenta",
  "5%":   "IVA 5%",
  "10%":  "IVA 10%",
};

// ── Métricas del día ──────────────────────────────────────────────────────────

function esDeHoy(iso: string): boolean {
  // Compara por día calendario de Paraguay (America/Asuncion), no por el TZ del
  // runtime: una venta hecha de noche PY se guarda con fecha UTC del día siguiente
  // y con `getDate()` local se contaría/descartaría mal.
  try {
    return esMismoDiaAsuncion(iso);
  } catch {
    return false;
  }
}

interface MetricasHoy {
  facturacion:       number;
  cantidadVentas:    number;
  ticketPromedio:    number;
  productosVendidos: number;  // suma de todas las cantidades en todos los ítems
}

function calcularMetricas(ventas: Venta[]): MetricasHoy {
  // Excluir anuladas del resumen "Facturación de hoy" / órdenes / productos vendidos.
  const deHoy            = ventas.filter((v) => esDeHoy(v.fecha) && v.estado !== "anulada");
  const facturacion      = deHoy.reduce((s, v) => s + v.total, 0);
  const cantidadVentas   = deHoy.length;
  const ticketPromedio   = cantidadVentas > 0 ? facturacion / cantidadVentas : 0;
  const productosVendidos = deHoy.reduce(
    (s, v) => s + v.items.reduce((si, i) => si + i.cantidad, 0),
    0
  );
  return { facturacion, cantidadVentas, ticketPromedio, productosVendidos };
}

// ── Tarjeta métrica ───────────────────────────────────────────────────────────

function MetricCard({
  label, value, sub, accent,
}: {
  label: string; value: string; sub?: string; accent?: boolean;
}) {
  return (
    <div className={`rounded-2xl border px-5 py-4 flex flex-col gap-1 shadow-sm ${
      accent
        ? "bg-[#4FAEB2] border-[#4FAEB2] ring-1 ring-[#4FAEB2]/25"
        : "bg-white border-[#4FAEB2]/30 ring-1 ring-[#4FAEB2]/10"
    }`}>
      <span className={`text-[10px] font-semibold uppercase tracking-[0.14em] ${
        accent ? "text-white/90" : "text-[#4FAEB2]"
      }`}>
        {label}
      </span>
      <span className={`text-2xl font-bold tabular-nums leading-tight ${
        accent ? "text-white" : "text-[#3F8E91]"
      }`}>
        {value}
      </span>
      {sub && <span className={`text-xs ${accent ? "text-white/80" : "text-slate-500"}`}>{sub}</span>}
    </div>
  );
}

// ── Helpers de fila ───────────────────────────────────────────────────────────

/** Muestra el primer producto de la venta y un badge con el resto. */
function ResumenProductos({ v }: { v: Venta }) {
  const primero = v.items[0];
  if (!primero) {
    return (
      <span className="text-xs text-gray-400">Sin líneas cargadas</span>
    );
  }
  const extra   = v.items.length - 1;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-medium text-gray-800 leading-tight">
        {primero.producto_nombre}
      </span>
      <div className="flex items-center gap-2 mt-0.5">
        <span className="font-mono text-xs text-gray-400">{primero.sku}</span>
        {extra > 0 && (
          <span className="bg-gray-100 text-gray-500 text-xs px-1.5 py-0.5 rounded-full font-medium">
            +{extra} más
          </span>
        )}
      </div>
    </div>
  );
}

/** Determina qué mostrar en la celda IVA cuando hay múltiples ítems. */
function ivaResumen(v: Venta): string {
  const tipos = [...new Set(v.items.map((i) => i.tipo_iva))];
  if (tipos.length === 1) return ivaLabel[tipos[0]];
  return "Mixto";
}

// ── Componente principal ───────────────────────────────────────────────────────

export default function VentasPage() {
  const router = useRouter();
  const [todas,      setTodas]      = useState<Venta[]>([]);
  const [busqueda,   setBusqueda]   = useState("");
  const [filtroTipo, setFiltroTipo] = useState<TipoVenta | "">("");
  const [filtroIva,  setFiltroIva]  = useState<TipoIvaVenta | "">("");
  const [ventaAnular, setVentaAnular] = useState<{ id: string; numero: string } | null>(null);
  const [ventaRegenerar, setVentaRegenerar] = useState<{ id: string; numero: string; eraFactura: boolean } | null>(null);
  const [regenerandoId, setRegenerandoId] = useState<string | null>(null);
  const [errorRegenerar, setErrorRegenerar] = useState<string | null>(null);
  const [expandidas, setExpandidas] = useState<Set<string>>(() => new Set());

  const toggleExpandida = (id: string) => {
    setExpandidas((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  async function recargar() {
    const data = await getVentas();
    const ordenadas = [...data].sort((a, b) => {
      const ta = new Date(a.fecha).getTime();
      const tb = new Date(b.fecha).getTime();
      return tb - ta || b.numero_control.localeCompare(a.numero_control);
    });
    setTodas(ordenadas);
  }

  useEffect(() => {
    void recargar();
  }, []);

  const metricas = calcularMetricas(todas);

  const filtradas = todas.filter((v) => {
    // Búsqueda global: número de control, CLIENTE, nombre o SKU de cualquier ítem.
    // Se prioriza para que buscar el nombre del cliente sea el caso principal
    // (pedido explícito del cliente: "filtrar por cliente en vez de productos").
    if (busqueda.trim() !== "") {
      const t = busqueda.toLowerCase().trim();
      const coincide =
        (v.cliente_nombre ?? "").toLowerCase().includes(t) ||
        v.numero_control.toLowerCase().includes(t) ||
        v.items.some(
          (i) =>
            i.producto_nombre.toLowerCase().includes(t) ||
            i.sku.toLowerCase().includes(t)
        );
      if (!coincide) return false;
    }
    // Tipo de venta
    if (filtroTipo !== "" && v.tipo_venta !== filtroTipo) return false;
    // IVA: coincide si al menos un ítem tiene ese tipo
    if (filtroIva !== "" && !v.items.some((i) => i.tipo_iva === filtroIva))
      return false;
    return true;
  });

  const hayFiltros = busqueda || filtroTipo || filtroIva;

  return (
    <div className="space-y-8">

      <div>
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-block h-1.5 w-1.5 rounded-full bg-[#4FAEB2]"
            style={{ boxShadow: "0 0 0 3px rgba(79, 174, 178, 0.18)" }}
          />
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#4FAEB2]">
            Zentra · Operaciones
          </p>
        </div>
        <h1 className="mt-1 text-lg font-semibold tracking-tight text-slate-900">Caja</h1>
        <p className="mt-0.5 text-xs text-slate-500">Cobro, facturación y cierre de pedidos</p>
      </div>

      <PedidosPendientesCaja />

      {/* ── Métricas del día ──────────────────────────────────────────────────── */}
      <div>
        <p className="text-xs text-gray-400 uppercase tracking-wide font-medium mb-3">
          Resumen de hoy —{" "}
          {new Date().toLocaleDateString("es-PY", {
            weekday: "long", day: "numeric", month: "long", year: "numeric",
            timeZone: "America/Asuncion",
          })}
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard
            label="Facturación de hoy"
            value={`Gs. ${metricas.facturacion.toLocaleString("es-PY")}`}
            sub="Total incl. IVA"
            accent
          />
          <MetricCard
            label="Ventas de hoy"
            value={String(metricas.cantidadVentas)}
            sub={metricas.cantidadVentas === 1 ? "orden registrada" : "órdenes registradas"}
          />
          <MetricCard
            label="Ticket promedio"
            value={
              metricas.ticketPromedio > 0
                ? `Gs. ${Math.round(metricas.ticketPromedio).toLocaleString("es-PY")}`
                : "—"
            }
            sub="Por orden de venta"
          />
          <MetricCard
            label="Unidades vendidas"
            value={String(metricas.productosVendidos)}
            sub="Unidades despachadas"
          />
        </div>
      </div>

      {/* ── Tabla de ventas ───────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm ring-1 ring-[#4FAEB2]/15 sm:p-5 lg:p-6">

        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-semibold">Órdenes de venta</h2>
          <Link
            href="/ventas/nueva"
            className="bg-[#0EA5E9] hover:bg-[#0284C7] text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors shadow-sm"
          >
            + Nueva venta
          </Link>
        </div>

        {/* Filtros */}
        <div className="flex flex-wrap items-center gap-3 mb-5 pb-5 border-b border-gray-100">
          <input
            type="text"
            placeholder="Buscar por cliente, número, producto o SKU..."
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            className={`${inputFilterClass} min-w-0 flex-1 sm:min-w-64`}
          />
          <FancySelect
            value={filtroTipo}
            onChange={(v) => setFiltroTipo(v as TipoVenta | "")}
            ariaLabel="Filtrar por tipo de venta"
            className="w-44"
            size="sm"
            options={[
              { value: "", label: "Todos los tipos" },
              { value: "CONTADO", label: "Contado" },
              { value: "CREDITO", label: "Crédito" },
            ]}
          />
          <FancySelect
            value={filtroIva}
            onChange={(v) => setFiltroIva(v as TipoIvaVenta | "")}
            ariaLabel="Filtrar por IVA"
            className="w-44"
            size="sm"
            options={[
              { value: "", label: "Todos los IVA" },
              { value: "EXENTA", label: "Exenta" },
              { value: "5%", label: "IVA 5%" },
              { value: "10%", label: "IVA 10%" },
            ]}
          />
          {hayFiltros && (
            <button
              onClick={() => { setBusqueda(""); setFiltroTipo(""); setFiltroIva(""); }}
              className="text-sm text-gray-400 hover:text-gray-600 transition-colors px-2"
            >
              Limpiar filtros
            </button>
          )}
          <span className="ml-auto text-sm text-gray-400">
            {filtradas.length} de {todas.length} ventas
          </span>
        </div>

        {/* Tabla — min-w fuerza scroll horizontal en mobile; columnas secundarias
            (Items, Cant total, IVA, Pago) se ocultan progresivamente. */}
        <EdgeScrollArea>
          <table className="w-full min-w-[760px] lg:min-w-0 text-left text-sm">
            <thead>
              <tr className="bg-slate-50 text-slate-600 text-sm font-semibold">
                <th className="py-3 pr-4 font-medium">Número</th>
                <th className="py-3 pr-4 font-medium">Cliente</th>
                <th className="py-3 pr-4 font-medium">Productos</th>
                <th className="hidden py-3 pr-4 text-center font-medium lg:table-cell">Ítems</th>
                <th className="py-3 pr-4 font-medium text-right hidden lg:table-cell">Cant. total</th>
                <th className="py-3 pr-4 font-medium hidden lg:table-cell">IVA</th>
                <th className="py-3 pr-4 font-medium text-right">Total</th>
                <th className="hidden py-3 pr-4 font-medium lg:table-cell">Tipo</th>
                <th className="hidden py-3 pr-4 font-medium lg:table-cell">Pago</th>
                <th className="py-3 pr-4 font-medium">Fecha</th>
                <th className="hidden py-3 pr-4 font-medium lg:table-cell">Estado</th>
                <th className="py-3 font-medium text-center">Ticket</th>
              </tr>
            </thead>
            <tbody>
              {filtradas.length === 0 ? (
                <tr>
                  <td colSpan={12} className="py-12 text-center text-gray-400">
                    {todas.length === 0
                      ? "No hay ventas registradas"
                      : "Ninguna venta coincide con los filtros"}
                  </td>
                </tr>
              ) : (
                filtradas.map((v) => {
                  const cantTotal = v.items.reduce((s, i) => s + i.cantidad, 0);
                  const anulada = v.estado === "anulada";
                  const abierta = expandidas.has(v.id);
                  return (
                    <Fragment key={v.id}>
                    <tr className={`border-b border-slate-200 last:border-0 hover:bg-[#4FAEB2]/[0.04] transition-colors ${anulada ? "opacity-60" : ""}`}>
                      <td className="py-4 pr-4 font-mono text-xs text-gray-500 align-middle">
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => toggleExpandida(v.id)}
                            className="flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                            aria-label={abierta ? "Ocultar ítems" : "Ver todos los ítems"}
                            title={abierta ? "Ocultar ítems" : "Ver todos los ítems"}
                          >
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 12 12"
                              fill="none"
                              className={`transition-transform ${abierta ? "rotate-90" : ""}`}
                            >
                              <path d="M4 2l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </button>
                          <span>{v.numero_control}</span>
                        </div>
                      </td>
                      <td className="py-4 pr-4 align-middle text-slate-700">
                        {v.cliente_id && v.cliente_nombre ? (
                          <Link
                            href={`/clientes/${v.cliente_id}`}
                            className="font-medium text-slate-800 hover:underline"
                          >
                            {v.cliente_nombre}
                          </Link>
                        ) : v.cliente_nombre ? (
                          <span className="font-medium text-slate-800">{v.cliente_nombre}</span>
                        ) : (
                          <span className="text-xs italic text-slate-400">Consumidor final</span>
                        )}
                      </td>
                      <td
                        className="py-4 pr-4 align-middle cursor-pointer"
                        onClick={() => toggleExpandida(v.id)}
                        title="Ver todos los ítems"
                      >
                        <ResumenProductos v={v} />
                      </td>
                      <td className="hidden py-4 pr-4 text-center align-middle lg:table-cell">
                        <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 text-xs font-semibold text-gray-600">
                          {v.items.length}
                        </span>
                      </td>
                      <td className="py-4 pr-4 text-right tabular-nums text-gray-700 align-middle hidden lg:table-cell">
                        {cantTotal}
                      </td>
                      <td className="py-4 pr-4 align-middle hidden lg:table-cell">
                        <span className="px-2 py-1 rounded-full text-xs font-semibold bg-indigo-50 text-indigo-700">
                          {ivaResumen(v)}
                        </span>
                      </td>
                      <td className="py-4 pr-4 text-right tabular-nums font-semibold text-gray-800 align-middle">
                        {formatGs(v.total)}
                      </td>
                      <td className="hidden py-4 pr-4 align-middle lg:table-cell">
                        <span className={`px-2 py-1 rounded-full text-xs font-semibold ${tipoVentaBadge[v.tipo_venta]}`}>
                          {v.tipo_venta === "CONTADO"
                            ? "Contado"
                            : `Crédito ${v.plazo_dias ?? ""}d`}
                        </span>
                      </td>
                      <td className="hidden py-4 pr-4 align-middle text-xs text-gray-600 lg:table-cell">
                        {v.metodo_pago === "tarjeta" ? "Tarjeta"
                          : v.metodo_pago === "transferencia" ? "Transfer."
                          : v.metodo_pago === "efectivo" ? "Efectivo"
                          : "—"}
                      </td>
                      <td className="py-4 pr-4 text-gray-500 text-xs tabular-nums align-middle">
                        {formatFecha(v.fecha)}
                      </td>
                      <td className="hidden py-4 pr-4 align-middle lg:table-cell">
                        {anulada ? (
                          <span
                            className="inline-flex items-center rounded-full px-2 py-1 text-xs font-semibold bg-rose-50 text-rose-800 ring-1 ring-rose-200"
                            title={v.anulacion_motivo ?? undefined}
                          >
                            Anulada
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-full px-2 py-1 text-xs font-semibold bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200">
                            Completada
                          </span>
                        )}
                      </td>
                      <td className="py-4 text-center align-middle">
                        <div className="inline-flex items-center gap-1.5">
                          {v.genera_nota_remision && (
                            <a
                              href={`/api/ventas/${v.id}/ticket?tipo=remision`}
                              target="_blank"
                              rel="noopener"
                              className="inline-flex items-center justify-center rounded-md border border-sky-200 bg-sky-50 px-3 py-1.5 text-xs font-medium text-sky-700 hover:bg-sky-100 transition-colors"
                              title="Nota de remisión (documento no fiscal)"
                            >
                              Nota de remisión
                            </a>
                          )}
                          {/* Regla de anulación:
                              - Sin factura ERP → botón Anular directo (reintegra stock).
                              - Factura ERP con estado SIFEN aprobado/enviado/en_proceso
                                → sólo link al panel SIFEN (cancelar via SET; cascada
                                anula la venta en el server).
                              - Factura ERP en borrador/generado/firmado/error_envio/
                                rechazado/cancelado → link a la factura + botón Anular:
                                el DE nunca llegó a SET, se puede descartar localmente. */}
                          {v.factura_id ? (
                            <Link
                              href={`/facturas/${v.factura_id}`}
                              className="inline-flex items-center justify-center rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 transition-colors"
                              title="Ver / gestionar factura electrónica (SIFEN)"
                            >
                              {v.numero_factura ? `Factura ${v.numero_factura}` : "Factura"}
                            </Link>
                          ) : (
                            /* Venta sin factura electrónica (solo ticket): antes no había
                               forma de volver a verla/reimprimirla desde Caja. */
                            <a
                              href={`/api/ventas/${v.id}/ticket`}
                              target="_blank"
                              rel="noopener"
                              className="inline-flex items-center justify-center rounded-md border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100 transition-colors"
                              title="Ver / reimprimir el ticket de esta venta"
                            >
                              Ticket
                            </a>
                          )}
                          {!anulada && (() => {
                            const est = v.factura_estado_sifen;
                            const facturaBloqueaAnular =
                              est === "aprobado" || est === "enviado" || est === "en_proceso";
                            if (v.factura_id && facturaBloqueaAnular) return null;
                            return (
                              <button
                                type="button"
                                onClick={() => setVentaAnular({ id: v.id, numero: v.numero_control })}
                                className="inline-flex items-center justify-center rounded-md border border-rose-200 bg-white px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50 transition-colors"
                                title={
                                  v.factura_id
                                    ? "Anular venta y descartar factura (el DE nunca llegó a SET)"
                                    : "Anular esta venta (reintegra stock)"
                                }
                              >
                                Anular
                              </button>
                            );
                          })()}
                          {anulada && (
                            <button
                              type="button"
                              onClick={() =>
                                setVentaRegenerar({
                                  id: v.id,
                                  numero: v.numero_control,
                                  eraFactura: !!v.factura_id,
                                })
                              }
                              disabled={regenerandoId === v.id}
                              className="inline-flex items-center justify-center rounded-md border border-[#4FAEB2] bg-[#4FAEB2]/10 px-3 py-1.5 text-xs font-semibold text-[#3F8E91] hover:bg-[#4FAEB2]/20 transition-colors disabled:opacity-50"
                              title={
                                v.factura_id
                                  ? "Regenerar como factura electrónica (clona cliente, ítems y precios)"
                                  : "Regenerar como ticket (clona ítems y precios, sin SIFEN)"
                              }
                            >
                              {regenerandoId === v.id ? "Regenerando…" : "Regenerar"}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {abierta && (
                      <tr className={`border-b border-slate-200 bg-slate-50/60 ${anulada ? "opacity-60" : ""}`}>
                        <td colSpan={12} className="px-4 py-3">
                          <div className="rounded-lg border border-slate-200 bg-white p-3">
                            <div className="mb-2 flex items-baseline justify-between">
                              <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                                Detalle de la venta {v.numero_control}
                              </h4>
                              <span className="text-xs text-slate-500">
                                {v.items.length} ítem{v.items.length === 1 ? "" : "s"} · {cantTotal} unidad{cantTotal === 1 ? "" : "es"}
                              </span>
                            </div>
                            <div className="overflow-x-auto">
                              <table className="w-full min-w-[560px] text-left text-sm">
                                <thead>
                                  <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                                    <th className="py-2 pr-3 font-medium">SKU</th>
                                    <th className="py-2 pr-3 font-medium">Producto</th>
                                    <th className="py-2 pr-3 font-medium text-right">Cant.</th>
                                    <th className="py-2 pr-3 font-medium text-right">Precio unit.</th>
                                    <th className="py-2 pr-3 font-medium">IVA</th>
                                    <th className="py-2 font-medium text-right">Subtotal</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {v.items.map((it, idx) => (
                                    <tr key={`${v.id}-item-${idx}`} className="border-b border-slate-100 last:border-0">
                                      <td className="py-2 pr-3 font-mono text-xs text-slate-500">{it.sku || "—"}</td>
                                      <td className="py-2 pr-3 text-slate-800">{it.producto_nombre}</td>
                                      <td className="py-2 pr-3 text-right tabular-nums text-slate-700">{it.cantidad}</td>
                                      <td className="py-2 pr-3 text-right tabular-nums text-slate-700">{formatGs(it.precio_venta)}</td>
                                      <td className="py-2 pr-3">
                                        <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700">
                                          {ivaLabel[it.tipo_iva]}
                                        </span>
                                      </td>
                                      <td className="py-2 text-right tabular-nums font-semibold text-slate-800">
                                        {formatGs(it.total_linea)}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                                <tfoot>
                                  <tr className="border-t border-slate-200 text-sm">
                                    <td colSpan={5} className="py-2 pr-3 text-right font-medium text-slate-600">
                                      Total
                                    </td>
                                    <td className="py-2 text-right tabular-nums font-bold text-slate-900">
                                      {formatGs(v.total)}
                                    </td>
                                  </tr>
                                </tfoot>
                              </table>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </EdgeScrollArea>

      </div>

      {/* FAB mobile: acceso 1-tap a "+ Nueva venta" desde cualquier scroll position */}
      <MobileFab href="/ventas/nueva" label="Nueva venta" />

      {ventaAnular && (
        <AnularVentaModal
          ventaId={ventaAnular.id}
          numeroControl={ventaAnular.numero}
          onClose={() => setVentaAnular(null)}
          onAnulada={() => {
            setVentaAnular(null);
            void recargar();
          }}
        />
      )}

      {ventaRegenerar && (
        <RegenerarVentaModal
          numero={ventaRegenerar.numero}
          eraFactura={ventaRegenerar.eraFactura}
          enviando={regenerandoId === ventaRegenerar.id}
          error={errorRegenerar}
          onClose={() => {
            if (regenerandoId) return;
            setVentaRegenerar(null);
            setErrorRegenerar(null);
          }}
          onConfirmar={async () => {
            if (!ventaRegenerar) return;
            const v = ventaRegenerar;
            setRegenerandoId(v.id);
            setErrorRegenerar(null);
            try {
              const res = await fetchWithSupabaseSession(
                `/api/ventas/${v.id}/regenerar`,
                { method: "POST" }
              );
              const body = await res.json().catch(() => ({}));
              if (!res.ok || body?.success === false) {
                setErrorRegenerar(body?.error ?? "No se pudo regenerar la venta.");
                return;
              }
              const facturaId = body?.data?.factura?.id;
              const nuevaVentaId = body?.data?.venta?.id;
              // Factura → panel SIFEN con auto-pipeline (mismo criterio que
              // la venta directa). Ticket → abrir el ticket comanda en pestaña
              // nueva y recargar el listado.
              if (facturaId) {
                router.push(`/facturas/${facturaId}?auto=1`);
                return;
              }
              if (nuevaVentaId) {
                try {
                  window.open(
                    `/api/ventas/${nuevaVentaId}/ticket?mode=comandas&auto=1`,
                    "_blank",
                    "noopener"
                  );
                } catch {}
              }
              setVentaRegenerar(null);
              void recargar();
            } catch {
              setErrorRegenerar("Error de red al regenerar la venta.");
            } finally {
              setRegenerandoId(null);
            }
          }}
        />
      )}
    </div>
  );
}

function RegenerarVentaModal({
  numero,
  eraFactura,
  enviando,
  error,
  onClose,
  onConfirmar,
}: {
  numero: string;
  eraFactura: boolean;
  enviando: boolean;
  error: string | null;
  onClose: () => void;
  onConfirmar: () => void | Promise<void>;
}) {
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !enviando) onClose();
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [onClose, enviando]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget && !enviando) onClose();
      }}
    >
      <div className="w-full max-w-md overflow-hidden rounded-xl bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#4FAEB2]/15">
              <RotateCw className="h-5 w-5 text-[#3F8E91]" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-slate-900">
                Regenerar {eraFactura ? "factura" : "ticket"}
              </h3>
              <p className="text-xs text-slate-500">
                {eraFactura
                  ? "Se crea una nueva venta con factura electrónica."
                  : "Se crea una nueva venta con ticket (sin SIFEN)."}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={enviando}
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-50"
            aria-label="Cerrar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 px-5 py-4 text-sm text-slate-700">
          <p>
            Vamos a crear una nueva venta clonando <span className="font-semibold text-slate-900">{numero}</span>.
          </p>
          <ul className="space-y-1.5 rounded-lg bg-slate-50 px-3 py-2.5 text-xs text-slate-600">
            <li className="flex items-start gap-2">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
              <span>Se copian cliente, ítems, precios, moneda y método de pago.</span>
            </li>
            {eraFactura ? (
              <li className="flex items-start gap-2">
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                <span>Se emite una nueva factura FAC-XXXXXX y arranca el pipeline SIFEN.</span>
              </li>
            ) : (
              <li className="flex items-start gap-2">
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                <span>Se re-imprime el ticket comanda. No se emite factura ni toca SIFEN.</span>
              </li>
            )}
            <li className="flex items-start gap-2">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
              <span>Se descuenta stock otra vez (se re-cobra a la caja).</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400" />
              <span>La venta anulada {numero} queda intacta como registro histórico.</span>
            </li>
          </ul>

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={enviando}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => void onConfirmar()}
            disabled={enviando}
            className="rounded-lg bg-[#4FAEB2] px-4 py-2 text-sm font-semibold text-white hover:bg-[#3F8E91] disabled:opacity-50"
          >
            {enviando ? "Regenerando…" : eraFactura ? "Sí, regenerar factura" : "Sí, regenerar ticket"}
          </button>
        </div>
      </div>
    </div>
  );
}
