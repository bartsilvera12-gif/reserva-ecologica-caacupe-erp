"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import { ArrowLeftRight, Plus, X, Search, Clock, CheckCircle2, Truck, PackageCheck, Loader2, PackageSearch, Check } from "lucide-react";

// ── Tipos que devuelve la API ────────────────────────────────────────────────
type Resumen = {
  id: string;
  numero: string;
  estado: string;
  sucursal_origen_id: string;
  sucursal_origen_nombre: string;
  sucursal_destino_id: string;
  sucursal_destino_nombre: string;
  observacion_solicitud: string | null;
  motivo_rechazo: string | null;
  solicitada_at: string;
  aprobada_at: string | null;
  rechazada_at: string | null;
  despachada_at: string | null;
  recibida_at: string | null;
  cancelada_at: string | null;
  items_count: number;
  es_solicitante: boolean;
};
type ItemDet = {
  id: string;
  producto_destino_id: string;
  producto_origen_id: string | null;
  sku: string;
  nombre: string;
  unidad: string;
  cantidad_solicitada: number;
  cantidad_aprobada: number;
  cantidad_despachada: number;
  cantidad_recibida: number;
  stock_destino: number;
  stock_origen: number | null;
  tiene_equivalencia: boolean;
};
type Sucursal = { id: string; nombre: string; es_principal: boolean };
type ProductoBusq = {
  id: string;
  nombre: string;
  sku: string;
  stock_actual: number;
};

const ESTADO_LABEL: Record<string, { label: string; cls: string }> = {
  pendiente: { label: "Pendiente", cls: "bg-amber-100 text-amber-800" },
  aprobada: { label: "Aprobada", cls: "bg-sky-100 text-sky-800" },
  rechazada: { label: "Rechazada", cls: "bg-red-100 text-red-700" },
  despachada: { label: "En tránsito", cls: "bg-indigo-100 text-indigo-800" },
  recibida: { label: "Recibida", cls: "bg-emerald-100 text-emerald-800" },
  cancelada: { label: "Cancelada", cls: "bg-slate-100 text-slate-600" },
};

function EstadoBadge({ estado }: { estado: string }) {
  const e = ESTADO_LABEL[estado] ?? { label: estado, cls: "bg-slate-100 text-slate-600" };
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${e.cls}`}>{e.label}</span>;
}

function fmtFecha(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function fmtNum(n: number): string {
  return n.toLocaleString("es-PY", { maximumFractionDigits: 2 });
}

export default function ReposicionPage() {
  const [tab, setTab] = useState<"realizadas" | "recibidas">("realizadas");
  const [transfers, setTransfers] = useState<Resumen[]>([]);
  const [conteos, setConteos] = useState<Record<string, number>>({});
  const [rol, setRol] = useState<string>("");
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detalleId, setDetalleId] = useState<string | null>(null);
  const [crearAbierto, setCrearAbierto] = useState(false);

  const esAprobador = useMemo(() => {
    const r = rol.trim().toLowerCase();
    return r === "admin" || r === "administrador" || r === "supervisor" || r === "super_admin";
  }, [rol]);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      const res = await fetchWithSupabaseSession(`/api/transferencias?filtro=${tab}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "No se pudo cargar.");
      setTransfers(json?.data?.transferencias ?? []);
      setConteos(json?.data?.conteos ?? {});
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al cargar.");
    } finally {
      setCargando(false);
    }
  }, [tab]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetchWithSupabaseSession("/api/usuarios/me", { cache: "no-store" });
        const json = await res.json();
        if (res.ok) setRol(json?.usuario?.rol ?? "");
      } catch {
        /* sin rol => solo acciones de usuario */
      }
    })();
  }, []);

  return (
    <div className="w-full space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2.5 text-2xl font-bold text-slate-900">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#4FAEB2]/10 text-[#4FAEB2]">
              <ArrowLeftRight className="h-5 w-5" />
            </span>
            Reposición entre sucursales
          </h1>
          <p className="mt-1 text-sm text-slate-500">Solicitá mercadería a otra sucursal y seguí el estado de cada transferencia.</p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/inventario/reposicion/recepciones"
            className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-600 shadow-sm transition-all hover:border-indigo-300 hover:text-indigo-600 active:scale-95"
          >
            <Truck className="h-4 w-4" /> Recepciones
          </Link>
          <button
            onClick={() => setCrearAbierto(true)}
            className="inline-flex items-center gap-2 rounded-xl bg-[#4FAEB2] px-4 py-2.5 text-sm font-semibold text-white shadow-sm shadow-[#4FAEB2]/20 transition-all hover:bg-[#3F8E91] hover:shadow-md active:scale-95"
          >
            <Plus className="h-4 w-4" /> Solicitar reposición
          </button>
        </div>
      </div>

      {/* Cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { k: "pendiente", label: "Pendientes", icon: Clock, color: "text-amber-600", bg: "bg-amber-50" },
          { k: "aprobada", label: "Aprobadas", icon: CheckCircle2, color: "text-sky-600", bg: "bg-sky-50" },
          { k: "despachada", label: "En tránsito", icon: Truck, color: "text-indigo-600", bg: "bg-indigo-50" },
          { k: "recibida", label: "Recibidas", icon: PackageCheck, color: "text-emerald-600", bg: "bg-emerald-50" },
        ].map((c) => {
          const Icon = c.icon;
          return (
            <div key={c.k} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition-shadow hover:shadow-md">
              <div className="flex items-center justify-between">
                <span className={`flex h-9 w-9 items-center justify-center rounded-lg ${c.bg} ${c.color}`}>
                  <Icon className="h-5 w-5" />
                </span>
                <span className="text-3xl font-bold tabular-nums text-slate-900">{conteos[c.k] ?? 0}</span>
              </div>
              <p className="mt-2 text-sm font-medium text-slate-500">{c.label}</p>
            </div>
          );
        })}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 rounded-lg bg-slate-100 p-1 w-fit">
        {([
          ["realizadas", "Solicitudes realizadas"],
          ["recibidas", "Solicitudes recibidas"],
        ] as const).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${tab === k ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      {/* Lista */}
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        {cargando ? (
          <div className="flex items-center justify-center gap-2 px-4 py-16 text-sm text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
          </div>
        ) : transfers.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-400">
              <ArrowLeftRight className="h-7 w-7" />
            </span>
            <div>
              <p className="text-sm font-semibold text-slate-700">
                {tab === "realizadas" ? "Todavía no solicitaste reposiciones" : "No hay solicitudes de otras sucursales"}
              </p>
              <p className="mt-0.5 text-sm text-slate-400">
                {tab === "realizadas"
                  ? "Cuando pidas mercadería a otra sucursal, va a aparecer acá."
                  : "Las solicitudes que te hagan otras sucursales van a aparecer acá."}
              </p>
            </div>
            {tab === "realizadas" && (
              <button
                onClick={() => setCrearAbierto(true)}
                className="mt-1 inline-flex items-center gap-2 rounded-xl bg-[#4FAEB2] px-4 py-2 text-sm font-semibold text-white shadow-sm transition-all hover:bg-[#3F8E91] active:scale-95"
              >
                <Plus className="h-4 w-4" /> Solicitar reposición
              </button>
            )}
          </div>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50/80 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-5 py-3 font-semibold">Número</th>
                <th className="px-5 py-3 font-semibold">{tab === "realizadas" ? "Origen" : "Destino"}</th>
                <th className="px-5 py-3 font-semibold text-center">Ítems</th>
                <th className="px-5 py-3 font-semibold">Solicitada</th>
                <th className="px-5 py-3 font-semibold">Estado</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {transfers.map((t) => (
                <tr
                  key={t.id}
                  onClick={() => setDetalleId(t.id)}
                  className="cursor-pointer transition-colors hover:bg-[#4FAEB2]/[0.04]"
                >
                  <td className="px-5 py-3.5 font-semibold tabular-nums text-slate-800">{t.numero}</td>
                  <td className="px-5 py-3.5 text-slate-600">
                    {tab === "realizadas" ? t.sucursal_origen_nombre : t.sucursal_destino_nombre}
                  </td>
                  <td className="px-5 py-3.5 text-center tabular-nums text-slate-600">{t.items_count}</td>
                  <td className="px-5 py-3.5 text-slate-500">{fmtFecha(t.solicitada_at)}</td>
                  <td className="px-5 py-3.5"><EstadoBadge estado={t.estado} /></td>
                  <td className="px-5 py-3.5 text-right">
                    <span className="text-sm font-medium text-[#4FAEB2] hover:underline">Ver</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {crearAbierto && (
        <ModalCrear
          onClose={() => setCrearAbierto(false)}
          onCreada={() => {
            setCrearAbierto(false);
            setTab("realizadas");
            cargar();
          }}
        />
      )}
      {detalleId && (
        <ModalDetalle
          id={detalleId}
          esAprobador={esAprobador}
          onClose={() => setDetalleId(null)}
          onCambio={() => {
            cargar();
          }}
        />
      )}
    </div>
  );
}

// ── Modal: crear solicitud ───────────────────────────────────────────────────
function ModalCrear({ onClose, onCreada }: { onClose: () => void; onCreada: () => void }) {
  const [sucursales, setSucursales] = useState<Sucursal[]>([]);
  const [origenId, setOrigenId] = useState("");
  const [obs, setObs] = useState("");
  const [busqueda, setBusqueda] = useState("");
  const [resultados, setResultados] = useState<ProductoBusq[]>([]);
  const [buscando, setBuscando] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [lineas, setLineas] = useState<Array<{ producto_destino_id: string; nombre: string; sku: string; stock: number; cantidad: string }>>([]);
  const [guardando, setGuardando] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const res = await fetchWithSupabaseSession("/api/sucursales");
      const json = await res.json();
      if (res.ok) {
        const list: Sucursal[] = json?.data?.sucursales ?? [];
        setSucursales(list);
        // Opción inicial: la sucursal principal (es_principal).
        const principal = list.find((s) => s.es_principal);
        if (principal) setOrigenId(principal.id);
      }
    })();
  }, []);

  useEffect(() => {
    const q = busqueda.trim();
    if (q.length < 2) {
      setResultados([]);
      setBuscando(false);
      return;
    }
    let vivo = true;
    setBuscando(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetchWithSupabaseSession(`/api/productos/search?q=${encodeURIComponent(q)}&limit=20`);
        const json = await res.json();
        if (vivo && res.ok) {
          const items = (json?.data?.items ?? []) as Array<{ id: string; nombre: string; sku: string; stock_actual: number }>;
          setResultados(items.map((p) => ({ id: p.id, nombre: p.nombre, sku: p.sku, stock_actual: p.stock_actual })));
          setActiveIdx(0);
        }
      } catch {
        /* ignore */
      } finally {
        if (vivo) setBuscando(false);
      }
    }, 250);
    return () => {
      vivo = false;
      clearTimeout(t);
    };
  }, [busqueda]);

  const yaAgregado = useCallback((id: string) => lineas.some((l) => l.producto_destino_id === id), [lineas]);

  function agregar(p: ProductoBusq) {
    if (yaAgregado(p.id)) return;
    setLineas((prev) => [...prev, { producto_destino_id: p.id, nombre: p.nombre, sku: p.sku, stock: p.stock_actual, cantidad: "" }]);
    setBusqueda("");
    setResultados([]);
    setActiveIdx(0);
  }
  function quitar(id: string) {
    setLineas((prev) => prev.filter((l) => l.producto_destino_id !== id));
  }

  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setBusqueda("");
      setResultados([]);
      return;
    }
    if (resultados.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, resultados.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const p = resultados[activeIdx];
      if (p && !yaAgregado(p.id)) agregar(p);
    }
  }

  async function guardar() {
    setErr(null);
    if (!origenId) return setErr("Elegí la sucursal de origen.");
    const items = lineas
      .map((l) => ({ producto_destino_id: l.producto_destino_id, cantidad_solicitada: Number(l.cantidad) || 0 }))
      .filter((i) => i.cantidad_solicitada > 0);
    if (items.length === 0) return setErr("Agregá al menos un producto con cantidad mayor a 0.");
    setGuardando(true);
    try {
      const res = await fetchWithSupabaseSession("/api/transferencias", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sucursal_origen_id: origenId, observacion: obs.trim() || undefined, items }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "No se pudo crear.");
      onCreada();
    } catch (e) {
      setGuardando(false);
      setErr(e instanceof Error ? e.message : "Error al crear.");
    }
  }

  return (
    <Overlay onClose={onClose} titulo="Solicitar reposición">
      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">Sucursal de origen</label>
          <select
            value={origenId}
            onChange={(e) => setOrigenId(e.target.value)}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]"
          >
            <option value="">Seleccioná…</option>
            {sucursales.map((s) => (
              <option key={s.id} value={s.id}>
                {s.nombre}
                {s.es_principal ? " (principal)" : ""}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">Agregar productos</label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              autoFocus
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder="Buscar por nombre, SKU o código de barras…"
              className="w-full rounded-xl border border-slate-200 py-2.5 pl-9 pr-9 text-sm transition-shadow focus:border-[#4FAEB2] focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/30"
            />
            {buscando ? (
              <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-slate-400" />
            ) : busqueda ? (
              <button
                type="button"
                onClick={() => { setBusqueda(""); setResultados([]); }}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                aria-label="Limpiar"
              >
                <X className="h-4 w-4" />
              </button>
            ) : null}

            {busqueda.trim().length >= 2 && (
              <div className="absolute z-10 mt-1 max-h-64 w-full overflow-auto rounded-xl border border-slate-200 bg-white p-1 shadow-lg">
                {buscando && resultados.length === 0 ? (
                  <div className="flex items-center gap-2 px-3 py-3 text-sm text-slate-400">
                    <Loader2 className="h-4 w-4 animate-spin" /> Buscando…
                  </div>
                ) : resultados.length === 0 ? (
                  <div className="flex flex-col items-center gap-1 px-3 py-6 text-center">
                    <PackageSearch className="h-6 w-6 text-slate-300" />
                    <p className="text-sm text-slate-400">Sin resultados para “{busqueda.trim()}”</p>
                  </div>
                ) : (
                  resultados.map((p, i) => {
                    const added = yaAgregado(p.id);
                    const sinStock = p.stock_actual <= 0;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        disabled={added}
                        onMouseEnter={() => setActiveIdx(i)}
                        onClick={() => agregar(p)}
                        className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                          added
                            ? "cursor-default opacity-60"
                            : i === activeIdx
                            ? "bg-[#4FAEB2]/10"
                            : "hover:bg-slate-50"
                        }`}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-slate-800">{p.nombre}</span>
                          <span className="text-xs text-slate-400">{p.sku}</span>
                        </span>
                        {added ? (
                          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
                            <Check className="h-3 w-3" /> Agregado
                          </span>
                        ) : (
                          <span
                            className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                              sinStock ? "bg-red-50 text-red-600" : "bg-slate-100 text-slate-500"
                            }`}
                          >
                            Stock: {fmtNum(p.stock_actual)}
                          </span>
                        )}
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </div>
          <p className="mt-1 text-xs text-slate-400">Escribí al menos 2 caracteres. Usá ↑ ↓ y Enter para agregar.</p>
        </div>

        {lineas.length > 0 && (
          <div className="overflow-hidden rounded-lg border border-slate-200">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">Producto</th>
                  <th className="px-3 py-2 text-right font-semibold">Stock actual</th>
                  <th className="px-3 py-2 text-right font-semibold">Cantidad</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {lineas.map((l) => (
                  <tr key={l.producto_destino_id}>
                    <td className="px-3 py-2">
                      <div className="font-medium text-slate-800">{l.nombre}</div>
                      <div className="text-xs text-slate-400">{l.sku}</div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-500">{fmtNum(l.stock)}</td>
                    <td className="px-3 py-2 text-right">
                      <input
                        type="number"
                        min={0}
                        step="any"
                        value={l.cantidad}
                        onChange={(e) =>
                          setLineas((prev) => prev.map((x) => (x.producto_destino_id === l.producto_destino_id ? { ...x, cantidad: e.target.value } : x)))
                        }
                        className="w-24 rounded border border-slate-200 px-2 py-1 text-right tabular-nums focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]"
                      />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => quitar(l.producto_destino_id)} className="text-xs text-red-500 hover:underline">
                        Quitar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">Observación (opcional)</label>
          <textarea
            value={obs}
            onChange={(e) => setObs(e.target.value)}
            rows={2}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]"
            placeholder="Ej: reposición semanal de góndola"
          />
        </div>

        {err && <p className="text-sm text-red-600">{err}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-slate-500 hover:text-slate-700">
            Cancelar
          </button>
          <button
            onClick={guardar}
            disabled={guardando}
            className="rounded-lg bg-[#4FAEB2] px-4 py-2 text-sm font-semibold text-white hover:bg-[#3F8E91] disabled:opacity-50"
          >
            {guardando ? "Creando…" : "Crear solicitud"}
          </button>
        </div>
      </div>
    </Overlay>
  );
}

// ── Modal: detalle + acciones ────────────────────────────────────────────────
function ModalDetalle({
  id,
  esAprobador,
  onClose,
  onCambio,
}: {
  id: string;
  esAprobador: boolean;
  onClose: () => void;
  onCambio: () => void;
}) {
  const [cab, setCab] = useState<Resumen | null>(null);
  const [items, setItems] = useState<ItemDet[]>([]);
  const [cargando, setCargando] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [accion, setAccion] = useState<string | null>(null);
  const [aprob, setAprob] = useState<Record<string, string>>({});

  const cargar = useCallback(async () => {
    setCargando(true);
    setErr(null);
    try {
      const res = await fetchWithSupabaseSession(`/api/transferencias/${id}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "No se pudo cargar.");
      setCab(json?.data?.cabecera ?? null);
      setItems(json?.data?.items ?? []);
      // Prefill aprobación con la cantidad solicitada.
      const pre: Record<string, string> = {};
      for (const it of (json?.data?.items ?? []) as ItemDet[]) pre[it.id] = String(it.cantidad_solicitada);
      setAprob(pre);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error.");
    } finally {
      setCargando(false);
    }
  }, [id]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  const esOrigen = cab ? !cab.es_solicitante : false;
  const esDestino = cab ? cab.es_solicitante : false;
  const faltaEquivalencia = items.some((i) => i.cantidad_solicitada > 0 && !i.tiene_equivalencia);

  async function accionar(path: string, body?: unknown, confirmar?: string) {
    if (confirmar && !window.confirm(confirmar)) return;
    setAccion(path);
    setErr(null);
    try {
      const res = await fetchWithSupabaseSession(`/api/transferencias/${id}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "No se pudo procesar.");
      await cargar();
      onCambio();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error.");
    } finally {
      setAccion(null);
    }
  }

  const estado = cab?.estado ?? "";

  return (
    <Overlay onClose={onClose} titulo={cab ? `Transferencia ${cab.numero}` : "Transferencia"}>
      {cargando ? (
        <div className="py-10 text-center text-sm text-slate-400">Cargando…</div>
      ) : !cab ? (
        <div className="py-10 text-center text-sm text-slate-400">No se encontró la transferencia.</div>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-3">
            <EstadoBadge estado={cab.estado} />
            <span className="text-sm text-slate-500">
              {cab.sucursal_origen_nombre} → {cab.sucursal_destino_nombre}
            </span>
          </div>

          {cab.observacion_solicitud && (
            <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">{cab.observacion_solicitud}</p>
          )}
          {cab.motivo_rechazo && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">Rechazo: {cab.motivo_rechazo}</p>
          )}

          {/* Línea de tiempo */}
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-500">
            <span>Solicitada: {fmtFecha(cab.solicitada_at)}</span>
            {cab.aprobada_at && <span>Aprobada: {fmtFecha(cab.aprobada_at)}</span>}
            {cab.despachada_at && <span>Despachada: {fmtFecha(cab.despachada_at)}</span>}
            {cab.recibida_at && <span>Recibida: {fmtFecha(cab.recibida_at)}</span>}
          </div>

          {/* Ítems */}
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">Producto</th>
                  <th className="px-3 py-2 text-right font-semibold">Solic.</th>
                  {esOrigen && <th className="px-3 py-2 text-right font-semibold">Stock origen</th>}
                  <th className="px-3 py-2 text-right font-semibold">Aprob.</th>
                  {(estado === "despachada" || estado === "recibida") && (
                    <th className="px-3 py-2 text-right font-semibold">Desp.</th>
                  )}
                  {estado === "recibida" && <th className="px-3 py-2 text-right font-semibold">Recib.</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((it) => (
                  <tr key={it.id}>
                    <td className="px-3 py-2">
                      <div className="font-medium text-slate-800">{it.nombre}</div>
                      <div className="text-xs text-slate-400">{it.sku} · {it.unidad}</div>
                      {esOrigen && !it.tiene_equivalencia && (
                        <div className="mt-0.5 text-xs font-medium text-red-600">Producto no encontrado en la sucursal de origen</div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-600">{fmtNum(it.cantidad_solicitada)}</td>
                    {esOrigen && (
                      <td className="px-3 py-2 text-right tabular-nums text-slate-500">
                        {it.stock_origen == null ? "—" : fmtNum(it.stock_origen)}
                      </td>
                    )}
                    <td className="px-3 py-2 text-right">
                      {estado === "pendiente" && esAprobador && esOrigen ? (
                        <input
                          type="number"
                          min={0}
                          max={it.cantidad_solicitada}
                          step="any"
                          value={aprob[it.id] ?? ""}
                          onChange={(e) => setAprob((p) => ({ ...p, [it.id]: e.target.value }))}
                          className="w-20 rounded border border-slate-200 px-2 py-1 text-right tabular-nums focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]"
                        />
                      ) : (
                        <span className="tabular-nums text-slate-600">{fmtNum(it.cantidad_aprobada)}</span>
                      )}
                    </td>
                    {(estado === "despachada" || estado === "recibida") && (
                      <td className="px-3 py-2 text-right tabular-nums text-slate-600">{fmtNum(it.cantidad_despachada)}</td>
                    )}
                    {estado === "recibida" && (
                      <td className="px-3 py-2 text-right tabular-nums text-slate-600">{fmtNum(it.cantidad_recibida)}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {esOrigen && estado === "aprobada" && faltaEquivalencia && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">
              Hay productos sin equivalencia en tu sucursal. No se puede despachar hasta resolverlos.
            </p>
          )}

          {err && <p className="text-sm text-red-600">{err}</p>}

          {/* Acciones según rol/lado/estado */}
          <div className="flex flex-wrap justify-end gap-2 pt-1">
            {/* Cancelar: solicitante, pendiente */}
            {esDestino && estado === "pendiente" && (
              <button
                onClick={() => accionar("cancelar", undefined, "¿Cancelar esta solicitud?")}
                disabled={!!accion}
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                Cancelar solicitud
              </button>
            )}
            {/* Aprobar / rechazar: origen, aprobador, pendiente */}
            {esOrigen && esAprobador && estado === "pendiente" && (
              <>
                <button
                  onClick={() => {
                    const motivo = window.prompt("Motivo del rechazo:");
                    if (motivo && motivo.trim()) accionar("rechazar", { motivo: motivo.trim() });
                  }}
                  disabled={!!accion}
                  className="rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                >
                  Rechazar
                </button>
                <button
                  onClick={() => {
                    const aprobaciones = items.map((it) => ({ item_id: it.id, cantidad_aprobada: Number(aprob[it.id]) || 0 }));
                    accionar("aprobar", { aprobaciones });
                  }}
                  disabled={!!accion}
                  className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-700 disabled:opacity-50"
                >
                  Aprobar
                </button>
              </>
            )}
            {/* Despachar: origen, aprobador, aprobada */}
            {esOrigen && esAprobador && estado === "aprobada" && (
              <button
                onClick={() => accionar("despachar", undefined, "¿Despachar? Esto descuenta el stock de tu sucursal.")}
                disabled={!!accion || faltaEquivalencia}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                Despachar
              </button>
            )}
            {/* Recepción: destino, despachada. Se hace en pantalla aparte, con
                control ítem por ítem. El botón de acá solo lleva a esa pantalla. */}
            {esDestino && estado === "despachada" && (
              <Link
                href={`/inventario/reposicion/recepciones/${id}`}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
              >
                <Truck className="h-4 w-4" /> Ir a recepción
              </Link>
            )}
          </div>
        </div>
      )}
    </Overlay>
  );
}

// ── Overlay reutilizable ─────────────────────────────────────────────────────
function Overlay({ titulo, onClose, children }: { titulo: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:items-center">
      <div className="my-8 w-full max-w-2xl rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h2 className="text-lg font-semibold text-slate-900">{titulo}</h2>
          <button onClick={onClose} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}
