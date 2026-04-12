"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Calendar } from "lucide-react";
import { SifenEstadoBadge } from "@/components/sifen/SifenEstadoBadge";
import { useFacturaSifenEstados } from "@/hooks/useFacturaSifenEstados";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import { getClientes, clienteNombre } from "@/lib/clientes/storage";
import { toCalendarDateStr } from "@/lib/fechas/calendario";
import { getFacturas } from "@/lib/gestion-clientes/storage";
import type { Cliente } from "@/lib/clientes/types";
import type { EstadoFactura, Factura } from "@/lib/gestion-clientes/types";

// ── Estilos ────────────────────────────────────────────────────────────────────

const fInputClass =
  "w-full border border-slate-200 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#0EA5E9] focus:outline-none bg-white";
const fLabelClass = "block text-xs font-medium text-slate-500 mb-0.5";

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatGs(n: number) {
  return n.toLocaleString("es-PY");
}

function formatFecha(str: string) {
  if (!str) return "—";
  const [y, m, d] = str.split("-");
  return `${d}/${m}/${y}`;
}

function formatFechaIso(iso: string) {
  try {
    const d = new Date(iso);
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
  } catch { return ""; }
}

// ── Badges ────────────────────────────────────────────────────────────────────

function BadgeEstado({ estado }: { estado: Cliente["estado"] }) {
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-semibold px-1.5 py-0.5 rounded-full ${
      estado === "activo" ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"
    }`}>
      <span className={`w-1.5 h-1.5 rounded-full ${estado === "activo" ? "bg-green-500" : "bg-gray-400"}`} />
      {estado === "activo" ? "Activo" : "Inactivo"}
    </span>
  );
}

function BadgeFactura({ estado }: { estado: string }) {
  const cfg: Record<string, string> = {
    Pagado:    "bg-green-100 text-green-700",
    Pendiente: "bg-amber-100 text-amber-700",
    Vencido:   "bg-red-100 text-red-700",
    Anulado:   "bg-gray-100 text-gray-500",
  };
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${cfg[estado] ?? "bg-gray-100 text-gray-500"}`}>
      {estado}
    </span>
  );
}

function BadgeTipo({ tipo }: { tipo: string }) {
  const cfg: Record<string, string> = {
    contado:     "bg-gray-50 text-gray-500 border-gray-200",
    credito:     "bg-blue-50 text-blue-600 border-blue-100",
    suscripcion: "bg-violet-50 text-violet-600 border-violet-100",
  };
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded border capitalize ${cfg[tipo] ?? "bg-gray-50 text-gray-500 border-gray-200"}`}>
      {tipo}
    </span>
  );
}

const KUDE_SOLO_APROBADO_TIP =
  "KuDE (factura electrónica PDF): solo disponible cuando SIFEN está «Aprobado».";

function FacturaRowAccionesSifen({
  facturaId,
  clienteId,
  sifenAprobado,
}: {
  facturaId: string;
  clienteId: string;
  sifenAprobado: boolean;
}) {
  const kudeView = `/api/facturas/${facturaId}/sifen/kude`;
  const kudeDl = `/api/facturas/${facturaId}/sifen/kude?download=1`;
  const btnBase =
    "inline-flex items-center justify-center w-7 h-7 rounded-lg transition-colors";
  const active = "text-gray-400 hover:text-blue-600 hover:bg-blue-50";
  const activePrint = "text-gray-400 hover:text-gray-700 hover:bg-gray-100";
  const activePdf = "text-gray-400 hover:text-green-600 hover:bg-green-50";
  const disabledCls = "text-gray-200 cursor-not-allowed opacity-50";

  const iconEye = (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
      <path d="M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" />
      <path
        fillRule="evenodd"
        d="M.664 10.59a1.651 1.651 0 0 1 0-1.186A10.004 10.004 0 0 1 10 3c4.257 0 7.893 2.66 9.336 6.41.147.381.146.804 0 1.186A10.004 10.004 0 0 1 10 17c-4.257 0-7.893-2.66-9.336-6.41ZM14 10a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z"
        clipRule="evenodd"
      />
    </svg>
  );
  const iconPrint = (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
      <path
        fillRule="evenodd"
        d="M5 4v3H4a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h1v2a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2h1a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-1V4a1 1 0 0 0-1-1H6a1 1 0 0 0-1 1Zm2 0h6v3H7V4Zm-1 9v-1h8v1a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 6 13Zm8-4.5a.5.5 0 1 1-1 0 .5.5 0 0 1 1 0Z"
        clipRule="evenodd"
      />
    </svg>
  );
  const iconPdf = (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
      <path
        fillRule="evenodd"
        d="M4 4a2 2 0 0 1 2-2h4.586A2 2 0 0 1 12 2.586L15.414 6A2 2 0 0 1 16 7.414V16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4Zm2 6a1 1 0 0 1 1-1h6a1 1 0 1 1 0 2H7a1 1 0 0 1-1-1Zm1 3a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2H7Z"
        clipRule="evenodd"
      />
    </svg>
  );

  return (
    <div className="flex flex-col items-start gap-1.5 min-w-[7rem]">
      <div className="flex items-center gap-0.5 flex-wrap">
        {sifenAprobado ? (
          <button
            type="button"
            title="Ver KuDE (PDF) en nueva pestaña"
            onClick={() => window.open(kudeView, "_blank", "noopener,noreferrer")}
            className={`${btnBase} ${active}`}
          >
            {iconEye}
          </button>
        ) : (
          <button type="button" disabled title={KUDE_SOLO_APROBADO_TIP} className={`${btnBase} ${disabledCls}`}>
            {iconEye}
          </button>
        )}
        {sifenAprobado ? (
          <a
            href={kudeDl}
            download
            title="Descargar KuDE (PDF)"
            className={`${btnBase} ${activePrint}`}
          >
            {iconPrint}
          </a>
        ) : (
          <button type="button" disabled title={KUDE_SOLO_APROBADO_TIP} className={`${btnBase} ${disabledCls}`}>
            {iconPrint}
          </button>
        )}
        {sifenAprobado ? (
          <a href={kudeDl} download title="Descargar KuDE (PDF)" className={`${btnBase} ${activePdf}`}>
            {iconPdf}
          </a>
        ) : (
          <button type="button" disabled title={KUDE_SOLO_APROBADO_TIP} className={`${btnBase} ${disabledCls}`}>
            {iconPdf}
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] font-semibold">
        <Link href={`/facturas/${facturaId}`} className="text-[#0EA5E9] hover:underline whitespace-nowrap" title="Ver factura, SIFEN y cancelación">
          Ver / SIFEN
        </Link>
        <Link href={`/clientes/${clienteId}`} className="text-slate-600 hover:underline whitespace-nowrap" title="Abrir ficha del cliente para registrar pago">
          Cobrar
        </Link>
      </div>
    </div>
  );
}

// ── Botón operativo ───────────────────────────────────────────────────────────

function BotonOperativo({
  label,
  icon,
  iconNode,
  activo = false,
  href,
  onClick,
}: {
  label:    string;
  icon:     string;
  iconNode?: React.ReactNode;
  activo?:  boolean;
  href?:    string;
  onClick?: () => void;
}) {
  const base =
    "flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-medium transition-colors";
  const activeClass  = "border-gray-800 bg-gray-900 text-white hover:bg-gray-700";
  const disabledClass = "border-gray-200 bg-gray-50 text-gray-400 cursor-not-allowed";
  const iconEl = iconNode ?? <span>{icon}</span>;

  if (activo && href) {
    return (
      <Link href={href} className={`${base} ${activeClass}`}>
        {iconEl}
        {label}
      </Link>
    );
  }
  if (activo && onClick) {
    return (
      <button type="button" onClick={onClick} className={`${base} ${activeClass}`}>
        {iconEl}
        {label}
      </button>
    );
  }
  return (
    <button type="button" disabled className={`${base} ${disabledClass}`}>
      {iconEl}
      {label}
    </button>
  );
}

// ── Sección header de columna ─────────────────────────────────────────────────

function ColHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-200">
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{children}</p>
    </div>
  );
}

// ── Modal Estado de Facturación ─────────────────────────────────────────────

const MESES_ES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];

function formatMesLabel(mes: string) {
  const [y, m] = mes.split("-").map(Number);
  return `${MESES_ES[m - 1]} ${y}`;
}

function ModalFacturacion({
  clienteId,
  clienteNombre: nombreCliente,
  onClose,
}: {
  clienteId: string;
  clienteNombre: string;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<{
    facturacion: { mes: string; estado: string; badge_estado: string; factura_id: string | null }[];
    suscripcion: { id: string; precio: number; moneda: string; fecha_inicio: string; duracion_meses: number } | null;
  } | null>(null);
  const [emitiendo, setEmitiendo] = useState<string | null>(null);
  const [errorEmitir, setErrorEmitir] = useState<string | null>(null);

  async function cargar() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithSupabaseSession(`/api/clientes/${clienteId}/facturacion`);
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? "Error al cargar");
      setData(json.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al cargar facturación");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    cargar();
  }, [clienteId]);

  async function handleEmitir(mes: string) {
    setEmitiendo(mes);
    setErrorEmitir(null);
    try {
      const res = await fetchWithSupabaseSession(`/api/clientes/${clienteId}/facturacion/emitir`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mes }),
      });
      const json = await res.json();
      if (res.status === 409) {
        setErrorEmitir("Ya existe una factura para este mes");
        return;
      }
      if (!res.ok) throw new Error(json?.error ?? "Error al emitir");
      await cargar();
    } catch (e) {
      setErrorEmitir(e instanceof Error ? e.message : "Error al emitir factura");
    } finally {
      setEmitiendo(null);
    }
  }

  const badgeClass: Record<string, string> = {
    emitida:   "bg-green-100 text-green-700",
    proyectada: "bg-gray-100 text-gray-600",
    vencida:  "bg-red-100 text-red-700",
    pendiente: "bg-amber-100 text-amber-700",
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl max-w-lg w-full max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-bold text-gray-900">Estado de Facturación</h3>
          <p className="text-sm text-gray-500 mt-0.5">{nombreCliente}</p>
          {data?.suscripcion && (
            <p className="text-sm font-medium text-gray-700 mt-2">
              Suscripción mensual — {data.suscripcion.moneda === "USD" ? "USD" : "Gs."} {data.suscripcion.precio.toLocaleString("es-PY")}
            </p>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {loading ? (
            <div className="py-12 text-center text-sm text-gray-500">Cargando...</div>
          ) : error ? (
            <div className="py-12 text-center text-sm text-red-600">{error}</div>
          ) : !data?.suscripcion ? (
            <div className="py-12 text-center text-sm text-gray-500">
              Este cliente no tiene suscripción activa para proyectar facturación.
            </div>
          ) : (
            <div className="space-y-4">
              {errorEmitir && (
                <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
                  <span>⚠</span>
                  <span>{errorEmitir}</span>
                </div>
              )}
              <div className="space-y-2">
                {data.facturacion.map((item) => (
                  <div
                    key={item.mes}
                    className="flex items-center justify-between gap-4 py-3 px-4 rounded-lg border border-gray-100 hover:bg-gray-50/60"
                  >
                    <div>
                      <p className="text-sm font-semibold text-gray-800">{formatMesLabel(item.mes)}</p>
                      <span className={`inline-flex text-xs font-medium px-2 py-0.5 rounded-full mt-1 ${badgeClass[item.badge_estado] ?? badgeClass.proyectada}`}>
                        {item.badge_estado === "emitida" ? "Emitida" : item.badge_estado === "proyectada" ? "Proyectada" : item.badge_estado === "vencida" ? "Vencida" : "Pendiente"}
                      </span>
                    </div>
                    <div className="shrink-0 text-sm font-semibold text-gray-700 tabular-nums">
                      {data.suscripcion?.moneda === "USD" ? "USD" : "Gs."} {(data.suscripcion?.precio ?? 0).toLocaleString("es-PY")}
                    </div>
                    <div className="shrink-0">
                      {item.estado === "proyectada" && (
                        <button
                          type="button"
                          disabled={emitiendo === item.mes}
                          onClick={() => handleEmitir(item.mes)}
                          className="text-xs font-medium text-[#0EA5E9] hover:text-[#0284C7] hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {emitiendo === item.mes ? "Emitiendo..." : "Emitir factura"}
                        </button>
                      )}
                      {item.factura_id && (
                        <Link
                          href={`/facturas/${item.factura_id}`}
                          className="text-xs font-medium text-[#0EA5E9] hover:text-[#0284C7] hover:underline"
                        >
                          Ver factura
                        </Link>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="shrink-0 px-6 py-4 border-t border-gray-200">
          <button
            type="button"
            onClick={onClose}
            className="w-full text-sm font-medium text-gray-600 border border-gray-200 rounded-lg py-2.5 hover:bg-gray-50 transition-colors"
          >
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Lookup de cliente (popup buscador) ───────────────────────────────────────

function ClienteLookup({
  clientes,
  selected,
  onSelect,
  onClear,
}: {
  clientes: Cliente[];
  selected: Cliente | null;
  onSelect: (c: Cliente) => void;
  onClear:  () => void;
}) {
  const [open,  setOpen]  = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef     = useRef<HTMLInputElement>(null);

  const resultados = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q
      ? clientes.filter((c) =>
          (c.empresa         ?? "").toLowerCase().includes(q) ||
          c.nombre_contacto.toLowerCase().includes(q)         ||
          (c.telefono        ?? "").toLowerCase().includes(q) ||
          (c.ruc             ?? "").toLowerCase().includes(q) ||
          (c.documento       ?? "").toLowerCase().includes(q) ||
          (c.email           ?? "").toLowerCase().includes(q)
        )
      : clientes;
    return base.slice(0, 10);
  }, [clientes, query]);

  // Cerrar al hacer click fuera del popup
  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  // Foco automático al abrir
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  function handleOpen() {
    setQuery("");
    setOpen(true);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "Enter" && resultados.length > 0) {
      onSelect(resultados[0]);
      setOpen(false);
      setQuery("");
    }
  }

  function handleSelect(c: Cliente) {
    onSelect(c);
    setOpen(false);
    setQuery("");
  }

  return (
    <div ref={containerRef} className="relative">

      {/* ── Trigger ── */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={handleOpen}
          className={`flex-1 min-w-0 border rounded-md px-3 py-1.5 text-xs flex items-center gap-1.5 transition-colors text-left ${
            open
              ? "border-blue-400 bg-white ring-1 ring-blue-200"
              : "border-gray-200 bg-white hover:border-gray-300"
          }`}
        >
          <svg className="w-3 h-3 text-gray-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          {selected ? (
            <span className="font-semibold text-gray-800 truncate">{clienteNombre(selected)}</span>
          ) : (
            <span className="text-gray-400">Buscar cliente...</span>
          )}
        </button>
        {selected && (
          <button
            type="button"
            onClick={onClear}
            className="shrink-0 p-1 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
            title="Limpiar selección"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {/* ── Dropdown popup ── */}
      {open && (
        <div className="absolute left-0 right-0 top-full mt-1.5 bg-white border border-gray-200 rounded-xl shadow-2xl z-50 overflow-hidden">

          {/* Buscador interno */}
          <div className="p-2 border-b border-gray-100 bg-gray-50/60">
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Escribí para buscar..."
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#0EA5E9] focus:outline-none bg-white"
            />
          </div>

          {/* Resultados */}
          <div className="overflow-y-auto max-h-56">
            {resultados.length === 0 ? (
              <div className="py-6 text-center text-xs text-gray-400">
                Sin resultados para &ldquo;{query}&rdquo;
              </div>
            ) : (
              resultados.map((c, i) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => handleSelect(c)}
                  className={`w-full text-left px-3 py-2.5 border-b border-slate-200 last:border-0 transition-colors hover:bg-slate-50 ${
                    i === 0 ? "bg-[#0EA5E9]/10" : ""
                  }`}
                >
                  <p className="text-xs font-bold text-gray-900 truncate">{clienteNombre(c)}</p>
                  <div className="flex flex-wrap gap-x-3 mt-0.5">
                    {c.ruc && (
                      <span className="text-xs text-gray-500">RUC: {c.ruc}</span>
                    )}
                    <span className="text-xs text-gray-500">Contacto: {c.nombre_contacto}</span>
                  </div>
                </button>
              ))
            )}
          </div>

          {/* Atajos de teclado */}
          <div className="flex items-center gap-4 px-3 py-1.5 bg-gray-50 border-t border-gray-100">
            <span className="text-xs text-gray-400 flex items-center gap-1">
              <kbd className="bg-white border border-gray-200 rounded px-1 py-0.5 text-[10px] font-mono leading-none">↵</kbd>
              seleccionar primero
            </span>
            <span className="text-xs text-gray-400 flex items-center gap-1">
              <kbd className="bg-white border border-gray-200 rounded px-1 py-0.5 text-[10px] font-mono leading-none">Esc</kbd>
              cerrar
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Página principal ──────────────────────────────────────────────────────────

export default function GestionClientesPage() {
  const [clientes,  setClientes]  = useState<Cliente[]>([]);
  const [selected,  setSelected]  = useState<Cliente | null>(null);
  const [facturas,  setFacturas]  = useState<Factura[]>([]);
  const [modalFacturacion, setModalFacturacion] = useState(false);

  const [filters, setFilters] = useState({
    cliente:                 "",
    nombre:                  "",
    ruc:                     "",
    telefono:                "",
    correo:                  "",
    nro_documento:           "",
    fecha_desde:             "",
    fecha_hasta:             "",
    vencimiento_desde:       "",
    vencimiento_hasta:       "",
    incluir_saldo_cero:      true,
    incluir_factura_contado: true,
    moneda:                  "" as "" | "GS" | "USD",
  });

  useEffect(() => {
    getClientes().then(setClientes);
  }, []);

  /** Al elegir cliente: misma API que la ficha (`/api/facturas?cliente_id=`) y filtros de período en blanco para no ocultar filas. */
  function selectCliente(c: Cliente) {
    setSelected(c);
    setFilters((prev) => ({
      ...prev,
      cliente: clienteNombre(c),
      fecha_desde: "",
      fecha_hasta: "",
      vencimiento_desde: "",
      vencimiento_hasta: "",
      moneda: "",
      incluir_saldo_cero: true,
      incluir_factura_contado: true,
    }));
    getFacturas(c.id).then(setFacturas);
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) {
    const { name, value, type } = e.target;
    const checked = (e.target as HTMLInputElement).checked;
    setFilters((prev) => ({
      ...prev,
      [name]: type === "checkbox" ? checked : value,
    }));
  }

  function limpiarFiltros() {
    setFilters({
      cliente: "", nombre: "", ruc: "", telefono: "", correo: "", nro_documento: "",
      fecha_desde: "", fecha_hasta: "", vencimiento_desde: "", vencimiento_hasta: "",
      incluir_saldo_cero: true, incluir_factura_contado: true, moneda: "",
    });
    setSelected(null);
    setFacturas([]);
  }

  // Handlers del lookup
  function handleSelectFromLookup(c: Cliente) {
    selectCliente(c);
  }

  function handleClearLookup() {
    setSelected(null);
    setFacturas([]);
    setFilters((prev) => ({ ...prev, cliente: "" }));
  }

  // ── Filtrado de clientes (columna izquierda) ─────────────────────────────

  const clientesFiltrados = useMemo(() => {
    return clientes.filter((c) => {
      const nombre = clienteNombre(c).toLowerCase();
      if (filters.cliente      && !nombre.includes(filters.cliente.toLowerCase())
                                && !(c.codigo_cliente ?? "").toLowerCase().includes(filters.cliente.toLowerCase())) return false;
      if (filters.nombre       && !nombre.includes(filters.nombre.toLowerCase()))                                   return false;
      if (filters.ruc          && !(c.ruc       ?? "").toLowerCase().includes(filters.ruc.toLowerCase()))           return false;
      if (filters.telefono     && !(c.telefono  ?? "").toLowerCase().includes(filters.telefono.toLowerCase()))      return false;
      if (filters.correo       && !(c.email     ?? "").toLowerCase().includes(filters.correo.toLowerCase()))        return false;
      if (filters.nro_documento && !(c.documento ?? "").toLowerCase().includes(filters.nro_documento.toLowerCase())) return false;
      return true;
    });
  }, [clientes, filters.cliente, filters.nombre, filters.ruc, filters.telefono, filters.correo, filters.nro_documento]);

  // ── Filtrado de facturas (columna derecha) ───────────────────────────────

  const facturasFiltradas = useMemo(() => {
    const fd = toCalendarDateStr(filters.fecha_desde) || filters.fecha_desde.trim();
    const fh = toCalendarDateStr(filters.fecha_hasta) || filters.fecha_hasta.trim();
    const vd = toCalendarDateStr(filters.vencimiento_desde) || filters.vencimiento_desde.trim();
    const vh = toCalendarDateStr(filters.vencimiento_hasta) || filters.vencimiento_hasta.trim();
    return facturas.filter((f) => {
      const fEmi = toCalendarDateStr(f.fecha) || String(f.fecha).slice(0, 10);
      const fVen = toCalendarDateStr(f.fecha_vencimiento) || String(f.fecha_vencimiento).slice(0, 10);
      if (fd && fEmi < fd) return false;
      if (fh && fEmi > fh) return false;
      if (vd && fVen < vd) return false;
      if (vh && fVen > vh) return false;
      if (!filters.incluir_saldo_cero && f.saldo === 0) return false;
      if (!filters.incluir_factura_contado && f.tipo === "contado") return false;
      if (filters.moneda) {
        const mon = String(f.moneda ?? "").toUpperCase() === "USD" ? "USD" : "GS";
        if (mon !== filters.moneda) return false;
      }
      return true;
    });
  }, [facturas, filters.fecha_desde, filters.fecha_hasta, filters.vencimiento_desde, filters.vencimiento_hasta, filters.incluir_saldo_cero, filters.incluir_factura_contado, filters.moneda]);

  // ── Fecha de hoy para mora/estado automático ─────────────────────────────

  const hoyStr = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }, []);

  // ── Facturas enriquecidas: estado efectivo + días mora + ordenadas DESC ───

  const facturasOrdenadas = useMemo(() => {
    return [...facturasFiltradas]
      .sort((a, b) => {
        const av = toCalendarDateStr(a.fecha_vencimiento) || String(a.fecha_vencimiento).slice(0, 10);
        const bv = toCalendarDateStr(b.fecha_vencimiento) || String(b.fecha_vencimiento).slice(0, 10);
        return bv.localeCompare(av);
      })
      .map((f) => {
        const fv = toCalendarDateStr(f.fecha_vencimiento) || String(f.fecha_vencimiento).slice(0, 10);
        const estaVencida = f.saldo > 0 && fv.length >= 10 && fv < hoyStr;
        const estadoEfectivo: EstadoFactura = estaVencida ? "Vencido" : f.estado;
        const diasMora = estaVencida
          ? Math.floor(
              (new Date().getTime() - new Date(`${fv}T00:00:00`).getTime()) /
              86_400_000
            )
          : 0;
        return { ...f, _estadoEfectivo: estadoEfectivo, _diasMora: diasMora };
      });
  }, [facturasFiltradas, hoyStr]);

  // ── Totales de facturas ──────────────────────────────────────────────────

  const totalMonto    = facturasOrdenadas.reduce((s, f) => s + f.monto, 0);
  const totalSaldo    = facturasOrdenadas.reduce((s, f) => s + f.saldo, 0);
  const cntVencidas   = facturasOrdenadas.filter((f) => f._estadoEfectivo === "Vencido").length;
  const cntPendientes = facturasOrdenadas.filter((f) => f._estadoEfectivo === "Pendiente").length;
  const cntPagadas    = facturasOrdenadas.filter((f) => f._estadoEfectivo === "Pagado").length;

  const sifenPorFactura = useFacturaSifenEstados(facturasOrdenadas.map((f) => f.id));

  return (
    <div className="flex flex-col gap-4 h-full">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="shrink-0">
        <h1 className="text-3xl font-bold text-gray-800">Gestión del Cliente</h1>
        <p className="text-gray-500 text-sm mt-1">Panel operativo · consultas y tipificaciones</p>
      </div>

      {/* ── Panel dos columnas ──────────────────────────────────────────── */}
      <div
        className="flex border border-gray-200 rounded-xl overflow-hidden shadow-sm bg-white flex-1 min-h-0"
        style={{ height: "calc(100vh - 170px)" }}
      >

        {/* ══════════════════════════════════════════════════════════════
            COLUMNA IZQUIERDA — Filtros + Lista de clientes
        ══════════════════════════════════════════════════════════════ */}
        <div className="w-[340px] shrink-0 border-r border-gray-200 flex flex-col overflow-hidden bg-gray-50/40 min-h-0">

          <ColHeader>Filtros de búsqueda</ColHeader>

          {/* Formulario de filtros */}
          <div className="flex-1 min-h-0 overflow-y-auto">
            <div className="p-4 space-y-3">

              {/* Criterios de texto */}
              <div className="space-y-2">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Criterios</p>

                <div>
                  <label className={fLabelClass}>Cliente</label>
                  <ClienteLookup
                    clientes={clientes}
                    selected={selected}
                    onSelect={handleSelectFromLookup}
                    onClear={handleClearLookup}
                  />
                </div>
                <div>
                  <label className={fLabelClass}>Nombre</label>
                  <input name="nombre" value={filters.nombre} onChange={handleChange} placeholder="Nombre del contacto" className={fInputClass} />
                </div>
                <div>
                  <label className={fLabelClass}>RUC</label>
                  <input name="ruc" value={filters.ruc} onChange={handleChange} placeholder="00000000-0" className={fInputClass} />
                </div>
                <div>
                  <label className={fLabelClass}>Teléfono</label>
                  <input name="telefono" value={filters.telefono} onChange={handleChange} placeholder="021 / 09XX" className={fInputClass} />
                </div>
                <div>
                  <label className={fLabelClass}>Correo</label>
                  <input name="correo" value={filters.correo} onChange={handleChange} placeholder="email@dominio.com" className={fInputClass} />
                </div>
                <div>
                  <label className={fLabelClass}>Nro. documento</label>
                  <input name="nro_documento" value={filters.nro_documento} onChange={handleChange} placeholder="CI o pasaporte" className={fInputClass} />
                </div>
              </div>

              {/* Filtros de período */}
              <div className="space-y-2 pt-2 border-t border-gray-200">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Período facturas</p>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className={fLabelClass}>Fecha desde</label>
                    <input type="date" name="fecha_desde" value={filters.fecha_desde} onChange={handleChange} className={fInputClass} />
                  </div>
                  <div>
                    <label className={fLabelClass}>Fecha hasta</label>
                    <input type="date" name="fecha_hasta" value={filters.fecha_hasta} onChange={handleChange} className={fInputClass} />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className={fLabelClass}>Venc. desde</label>
                    <input type="date" name="vencimiento_desde" value={filters.vencimiento_desde} onChange={handleChange} className={fInputClass} />
                  </div>
                  <div>
                    <label className={fLabelClass}>Venc. hasta</label>
                    <input type="date" name="vencimiento_hasta" value={filters.vencimiento_hasta} onChange={handleChange} className={fInputClass} />
                  </div>
                </div>
              </div>

              {/* Opciones */}
              <div className="space-y-2 pt-2 border-t border-gray-200">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Opciones</p>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    name="incluir_saldo_cero"
                    checked={filters.incluir_saldo_cero}
                    onChange={handleChange}
                    className="rounded border-gray-300 accent-gray-800"
                  />
                  <span className="text-xs text-gray-600">Incluir saldo cero</span>
                </label>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    name="incluir_factura_contado"
                    checked={filters.incluir_factura_contado}
                    onChange={handleChange}
                    className="rounded border-gray-300 accent-gray-800"
                  />
                  <span className="text-xs text-gray-600">Incluir factura contado</span>
                </label>

                <div>
                  <label className={fLabelClass}>Moneda</label>
                  <select name="moneda" value={filters.moneda} onChange={handleChange} className={fInputClass}>
                    <option value="">Todas</option>
                    <option value="GS">Guaraníes (GS)</option>
                    <option value="USD">Dólares (USD)</option>
                  </select>
                </div>
              </div>

              {/* Botón limpiar */}
              <button
                type="button"
                onClick={limpiarFiltros}
                className="w-full text-xs text-gray-500 border border-gray-200 rounded-lg py-1.5 hover:bg-gray-100 transition-colors"
              >
                Limpiar filtros
              </button>
            </div>

            {/* ── Lista de resultados ──────────────────────────────────── */}
            <div className="border-t border-gray-200">
              <div className="px-4 py-2 bg-gray-100/50 flex items-center justify-between">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Resultados</p>
                <span className="text-xs font-bold text-gray-600 bg-white border border-gray-200 px-1.5 py-0.5 rounded-full">
                  {clientesFiltrados.length}
                </span>
              </div>

              {clientesFiltrados.length === 0 ? (
                <div className="px-4 py-8 text-center text-xs text-gray-400">
                  Sin resultados para los filtros aplicados
                </div>
              ) : (
                <div className="divide-y divide-gray-100">
                  {clientesFiltrados.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => selectCliente(c)}
                      className={`w-full text-left px-4 py-3 transition-colors hover:bg-blue-50/60 ${
                        selected?.id === c.id
                          ? "bg-blue-50 border-l-[3px] border-l-blue-500"
                          : "border-l-[3px] border-l-transparent"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className={`text-xs font-semibold truncate ${selected?.id === c.id ? "text-blue-800" : "text-gray-800"}`}>
                            {clienteNombre(c)}
                          </p>
                          <p className="text-xs text-gray-400 mt-0.5 font-mono">
                            {c.codigo_cliente}
                            {(c.ruc || c.documento) && ` · ${c.ruc ?? c.documento}`}
                          </p>
                        </div>
                        <BadgeEstado estado={c.estado} />
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

          </div>
        </div>

        {/* ══════════════════════════════════════════════════════════════
            COLUMNA DERECHA — Información del cliente
        ══════════════════════════════════════════════════════════════ */}
        <div className="flex-1 flex flex-col overflow-hidden min-h-0">

          {selected === null ? (
            /* Empty state */
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <span className="text-5xl">👤</span>
                <p className="mt-4 text-base font-semibold text-gray-600">Seleccioná un cliente</p>
                <p className="text-sm text-gray-400 mt-1 max-w-xs">
                  Buscá en la columna izquierda y hacé click en un cliente para ver su información
                </p>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col overflow-hidden min-h-0">

              {/* ── Panel info del cliente ─────────────────────────── */}
              <div className="shrink-0 border-b border-gray-200 max-h-[min(52vh,520px)] overflow-y-auto">
                <ColHeader>Información del cliente</ColHeader>
                <div className="px-6 py-4">
                  <div className="flex items-start justify-between mb-4">
                    <div>
                      <h2 className="text-lg font-bold text-gray-900">{clienteNombre(selected)}</h2>
                      <span className="font-mono text-xs text-gray-400">{selected.codigo_cliente}</span>
                    </div>
                    <BadgeEstado estado={selected.estado} />
                  </div>

                  <div className="grid grid-cols-3 gap-x-8 gap-y-2.5 text-sm">
                    {[
                      { label: "RUC",        value: selected.ruc        ?? "—" },
                      { label: "Contacto",   value: selected.nombre_contacto   },
                      { label: "Correo",     value: selected.email      ?? "—" },
                      { label: "Teléfono",   value: selected.telefono   ?? "—" },
                      { label: "Dirección",  value: selected.direccion  ?? "—" },
                      { label: "Ciudad",     value: selected.ciudad     ?? "—" },
                      { label: "Condición",  value: selected.condicion_pago ?? "—" },
                      { label: "Moneda",     value: selected.moneda_preferida ?? "GS" },
                      { label: "Fecha alta", value: formatFechaIso(selected.created_at) },
                    ].map((item) => (
                      <div key={item.label}>
                        <p className="text-xs text-gray-400">{item.label}</p>
                        <p className="font-medium text-gray-800 truncate" title={item.value}>{item.value}</p>
                      </div>
                    ))}
                  </div>
                </div>

                {/* ── Botones operativos ─────────────────────────── */}
                <div className="px-6 pb-4 flex flex-wrap gap-2">
                  <BotonOperativo
                    label="Tipificación"
                    icon="📋"
                    activo
                    href={`/clientes/${selected.id}/tipificacion`}
                  />
                  <BotonOperativo
                    label="Facturación"
                    icon="📄"
                    iconNode={<Calendar className="w-3.5 h-3.5" />}
                    activo
                    onClick={() => setModalFacturacion(true)}
                  />
                  <BotonOperativo label="Servicios asociados"   icon="🔗" />
                  <BotonOperativo label="Cambio de plan"        icon="🔄" />
                  <BotonOperativo label="Cambio fecha venc."    icon="📅" />
                  <BotonOperativo label="Historial cliente"     icon="🕐" />
                </div>
              </div>

              {/* ── Tabla de facturas ──────────────────────────────── */}
              <div className="flex-1 flex flex-col overflow-hidden min-h-0">
                <ColHeader>
                  Facturas del cliente
                  {facturasFiltradas.length !== facturas.length && (
                    <span className="ml-2 normal-case font-normal text-gray-400">
                      ({facturasFiltradas.length} de {facturas.length} con filtros aplicados)
                    </span>
                  )}
                </ColHeader>

                {/* ── Resumen de facturas ──────────────────────────── */}
                {facturasOrdenadas.length > 0 && (
                  <div className="shrink-0 grid grid-cols-3 gap-2 px-4 py-3 border-b border-gray-100 bg-gray-50/40">
                    <div className="bg-white rounded-lg border border-gray-100 px-3 py-2">
                      <p className="text-xs text-gray-400">Facturas</p>
                      <p className="text-lg font-bold text-gray-800 leading-tight">{facturasOrdenadas.length}</p>
                    </div>
                    <div className="bg-white rounded-lg border border-gray-100 px-3 py-2">
                      <p className="text-xs text-gray-400">Monto total</p>
                      <p className="text-xs font-bold text-gray-800 tabular-nums leading-tight mt-0.5">
                        Gs. {formatGs(totalMonto)}
                      </p>
                    </div>
                    <div className="bg-white rounded-lg border border-gray-100 px-3 py-2">
                      <p className="text-xs text-gray-400">Saldo pendiente</p>
                      <p className={`text-xs font-bold tabular-nums leading-tight mt-0.5 ${totalSaldo > 0 ? "text-red-600" : "text-green-600"}`}>
                        Gs. {formatGs(totalSaldo)}
                      </p>
                    </div>
                    <div className="bg-white rounded-lg border border-red-100 px-3 py-2">
                      <p className="text-xs text-red-400">Vencidas</p>
                      <p className="text-lg font-bold text-red-600 leading-tight">{cntVencidas}</p>
                    </div>
                    <div className="bg-white rounded-lg border border-amber-100 px-3 py-2">
                      <p className="text-xs text-amber-500">Pendientes</p>
                      <p className="text-lg font-bold text-amber-600 leading-tight">{cntPendientes}</p>
                    </div>
                    <div className="bg-white rounded-lg border border-green-100 px-3 py-2">
                      <p className="text-xs text-green-500">Pagadas</p>
                      <p className="text-lg font-bold text-green-600 leading-tight">{cntPagadas}</p>
                    </div>
                  </div>
                )}

                {/* ── Tabla ────────────────────────────────────────── */}
                <div className="flex-1 min-h-0 overflow-y-auto">
                  {facturasOrdenadas.length === 0 ? (
                    <div className="py-12 text-center text-sm text-gray-400 space-y-2 px-4">
                      <p>No hay facturas para los filtros seleccionados.</p>
                      {facturas.length > 0 && (
                        <p className="text-xs text-amber-700">
                          Hay {facturas.length} factura(s) cargadas; revisá período de emisión/vencimiento, moneda o «Incluir factura contado».
                        </p>
                      )}
                    </div>
                  ) : (
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-slate-50 border-b border-slate-200 shadow-sm">
                        <tr>
                          {["Tipo", "Nro. Factura", "Fecha emisión", "Fecha vencimiento", "Monto", "Saldo", "Días mora", "Estado", "SIFEN", "Operación"].map((h) => (
                            <th key={h} className="text-left text-sm font-semibold text-slate-600 px-3 py-2.5 uppercase tracking-wide whitespace-nowrap">
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50">
                        {facturasOrdenadas.map((f) => (
                          <tr
                            key={f.id}
                            className={`transition-colors ${
                              f._estadoEfectivo === "Vencido"
                                ? "bg-red-50/40 hover:bg-red-50/70"
                                : "hover:bg-gray-50/60"
                            }`}
                          >
                            {/* Tipo */}
                            <td className="px-3 py-2.5">
                              <BadgeTipo tipo={f.tipo} />
                            </td>
                            {/* Nro. Factura — clickable */}
                            <td className="px-3 py-2.5">
                              <Link
                                href={`/facturas/${f.id}`}
                                className="font-mono text-xs font-semibold text-blue-600 hover:text-blue-800 hover:underline"
                              >
                                {f.numero_factura}
                              </Link>
                            </td>
                            {/* Fecha emisión */}
                            <td className="px-3 py-2.5 text-xs text-gray-500 whitespace-nowrap">
                              {formatFecha(f.fecha)}
                            </td>
                            {/* Fecha vencimiento */}
                            <td className={`px-3 py-2.5 text-xs font-medium whitespace-nowrap ${
                              f._estadoEfectivo === "Vencido" ? "text-red-600" : "text-gray-600"
                            }`}>
                              {formatFecha(f.fecha_vencimiento)}
                            </td>
                            {/* Monto */}
                            <td className="px-3 py-2.5 text-xs text-gray-800 tabular-nums whitespace-nowrap">
                              {f.moneda === "GS"
                                ? `Gs. ${formatGs(f.monto)}`
                                : `USD ${f.monto.toLocaleString("en-US")}`}
                            </td>
                            {/* Saldo */}
                            <td className={`px-3 py-2.5 text-xs tabular-nums font-semibold whitespace-nowrap ${
                              f.saldo > 0 ? "text-red-600" : "text-gray-400"
                            }`}>
                              {f.moneda === "GS"
                                ? `Gs. ${formatGs(f.saldo)}`
                                : `USD ${f.saldo.toLocaleString("en-US")}`}
                            </td>
                            {/* Días mora */}
                            <td className="px-3 py-2.5 text-xs text-center">
                              {f._diasMora > 0 ? (
                                <span className="font-bold text-red-600 tabular-nums">{f._diasMora}</span>
                              ) : (
                                <span className="text-gray-300">—</span>
                              )}
                            </td>
                            {/* Estado */}
                            <td className="px-3 py-2.5">
                              <BadgeFactura estado={f._estadoEfectivo} />
                            </td>
                            <td className="px-3 py-2.5 align-top">
                              <SifenEstadoBadge
                                estadoSifen={sifenPorFactura[f.id]?.estado_sifen ?? null}
                              />
                            </td>
                            {/* KuDE + enlaces a ficha factura (SIFEN/cancelar/NC) y cliente (pago) */}
                            <td className="px-3 py-2.5 align-top">
                              <FacturaRowAccionesSifen
                                facturaId={f.id}
                                clienteId={selected.id}
                                sifenAprobado={sifenPorFactura[f.id]?.estado_sifen === "aprobado"}
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

                {/* ── Pie de tabla ─────────────────────────────────── */}
                {facturasOrdenadas.length > 0 && (
                  <div className="shrink-0 border-t border-gray-100 bg-gray-50/50 px-4 py-2 flex items-center gap-4 flex-wrap">
                    <span className="text-xs text-gray-500 tabular-nums">
                      <span className="font-semibold text-gray-700">{facturasOrdenadas.length}</span> facturas
                      {facturasFiltradas.length !== facturas.length && (
                        <span className="text-gray-400"> (filtradas)</span>
                      )}
                    </span>
                    <span className="text-xs text-gray-500 tabular-nums">
                      Total: <span className="font-semibold text-gray-700">Gs. {formatGs(totalMonto)}</span>
                    </span>
                    <span className="text-xs text-gray-500 tabular-nums">
                      Saldo: <span className={`font-semibold ${totalSaldo > 0 ? "text-red-600" : "text-green-700"}`}>
                        Gs. {formatGs(totalSaldo)}
                      </span>
                    </span>
                  </div>
                )}
              </div>

            </div>
          )}

        </div>
      </div>

      {/* Modal Estado de Facturación */}
      {modalFacturacion && selected && (
        <ModalFacturacion
          clienteId={selected.id}
          clienteNombre={clienteNombre(selected)}
          onClose={() => setModalFacturacion(false)}
        />
      )}
    </div>
  );
}
