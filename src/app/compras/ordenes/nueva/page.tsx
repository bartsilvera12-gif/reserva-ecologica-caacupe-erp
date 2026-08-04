"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Search, Trash2, Loader2, Plus, ImageIcon } from "lucide-react";
import ProveedorPicker from "@/components/proveedores/ProveedorPicker";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";

type ComboHit = {
  id: string; nombre: string; sku: string; precio_venta: number;
  stock_actual: number; controla_stock: boolean; unidad_medida: string; imagen_url: string | null;
};
type IvaTipo = "exenta" | "5" | "10";
type Linea = {
  producto_id: string; producto_nombre: string; sku: string; unidad_medida: string;
  cantidad: number; costo_input: number; iva_tipo: IvaTipo; precio_venta: number;
};

function fmtGs(v: number) { return `Gs. ${Math.round(v).toLocaleString("es-PY")}`; }
const inputClass = "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#4FAEB2]/30 bg-white";

function ProductoThumb({ url, alt }: { url?: string | null; alt: string }) {
  const [err, setErr] = useState(false);
  if (!url || err) {
    return (
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-slate-100 bg-slate-50 text-slate-300">
        <ImageIcon className="h-4 w-4" />
      </div>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt={alt} loading="lazy" onError={() => setErr(true)} className="h-10 w-10 shrink-0 rounded-md border border-slate-100 object-cover" />;
}

export default function NuevaOrdenCompraPage() {
  const router = useRouter();
  const [cab, setCab] = useState({
    proveedor_id: "", proveedor_nombre: "",
    moneda: "PYG" as "PYG" | "USD", tipo_cambio: "",
    tipo_pago: "contado" as "contado" | "credito", plazo_dias: "",
    llegada_estimada: "", observacion: "",
  });
  const [lineas, setLineas] = useState<Linea[]>([]);
  const [q, setQ] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [hits, setHits] = useState<ComboHit[]>([]);
  const [buscando, setBuscando] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [enviando, setEnviando] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const searchBoxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target as Node)) setSearchOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const term = q.trim();
    if (term.length < 2) { setHits([]); setBuscando(false); return; }
    setBuscando(true);
    timer.current = setTimeout(async () => {
      try {
        const r = await fetchWithSupabaseSession(`/api/productos/search?q=${encodeURIComponent(term)}&limit=20`, { cache: "no-store" });
        const j = await r.json();
        setHits(((j?.data?.items ?? []) as Record<string, unknown>[]).map((p): ComboHit => ({
          id: String(p.id), nombre: String(p.nombre ?? ""), sku: String(p.sku ?? ""),
          precio_venta: Number(p.precio_venta) || 0, stock_actual: Number(p.stock_actual) || 0,
          controla_stock: p.controla_stock !== false,
          unidad_medida: String(p.unidad_medida ?? "UNIDAD"),
          imagen_url: (p.imagen_url as string | null) ?? null,
        })));
      } catch { setHits([]); }
      finally { setBuscando(false); }
    }, 220);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [q]);

  useEffect(() => { setHighlight(-1); }, [hits]);

  const tc = cab.moneda === "USD" ? Number(cab.tipo_cambio) || 0 : 1;
  const excluidos = useMemo(() => new Set(lineas.map((l) => l.producto_id)), [lineas]);
  const resultados = useMemo(() => hits.filter((p) => !excluidos.has(p.id)), [hits, excluidos]);
  const totalOc = useMemo(() => lineas.reduce((s, l) => s + l.costo_input * tc * l.cantidad, 0), [lineas, tc]);

  function addProducto(p: ComboHit) {
    setLineas((prev) => {
      if (prev.some((l) => l.producto_id === p.id)) return prev;
      return [...prev, {
        producto_id: p.id, producto_nombre: p.nombre, sku: p.sku,
        unidad_medida: p.unidad_medida || "UNIDAD", cantidad: 1, costo_input: 0,
        iva_tipo: "10", precio_venta: p.precio_venta,
      }];
    });
    setQ(""); setHits([]); setSearchOpen(false); setHighlight(-1);
    setTimeout(() => inputRef.current?.focus(), 0);
  }
  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") { e.preventDefault(); setSearchOpen(true); setHighlight((h) => Math.min(h + 1, resultados.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const sel = resultados[highlight] ?? resultados[0]; if (sel) addProducto(sel); }
    else if (e.key === "Escape") { setSearchOpen(false); setHighlight(-1); }
  }
  function updateLinea(id: string, patch: Partial<Linea>) {
    setLineas((prev) => prev.map((l) => (l.producto_id === id ? { ...l, ...patch } : l)));
  }
  function removeLinea(id: string) { setLineas((prev) => prev.filter((l) => l.producto_id !== id)); }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!cab.proveedor_id) return setErr("Seleccioná un proveedor.");
    if (cab.moneda === "USD" && tc <= 0) return setErr("Cargá el tipo de cambio (USD → Gs.).");
    if (lineas.length === 0) return setErr("Agregá al menos un producto.");
    const mala = lineas.find((l) => l.cantidad <= 0 || l.costo_input <= 0);
    if (mala) return setErr(`Revisá "${mala.producto_nombre}": cantidad y costo deben ser mayores a 0.`);

    const items = lineas.map((l) => ({
      producto_id: l.producto_id,
      producto_nombre: l.producto_nombre,
      sku: l.sku,
      cantidad_solicitada: l.cantidad,
      costo_estimado: Math.round(l.costo_input * tc),
      iva_tipo: l.iva_tipo,
    }));

    setEnviando(true);
    try {
      const res = await fetchWithSupabaseSession("/api/ordenes-compra", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proveedor_id: cab.proveedor_id,
          proveedor_nombre: cab.proveedor_nombre,
          moneda: cab.moneda,
          tipo_cambio: tc,
          tipo_pago: cab.tipo_pago,
          plazo_dias: cab.tipo_pago === "credito" && cab.plazo_dias ? parseInt(cab.plazo_dias, 10) : undefined,
          llegada_estimada: cab.llegada_estimada || undefined,
          observaciones: cab.observacion.trim() || undefined,
          emitir: true,
          items,
        }),
      });
      const j = await res.json();
      if (!res.ok || j?.success === false) { setErr(typeof j?.error === "string" ? j.error : "No se pudo crear la orden."); return; }
      const id = j?.data?.id;
      router.push(id ? `/compras/ordenes/${id}` : "/compras/ordenes");
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Error de red.");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="space-y-6">
      <Link href="/compras/ordenes" className="inline-flex items-center gap-1 text-sm font-medium text-slate-500 hover:text-[#3F8E91]">
        ← Órdenes de compra
      </Link>
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#4FAEB2]">Zentra · Adquisiciones</p>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Nueva orden de compra</h1>
        <p className="mt-1 text-sm text-slate-500">Productos y costos pactados con el proveedor. No impacta stock — eso se hace al recibir.</p>
      </div>

      <form onSubmit={onSubmit} className="space-y-6">
        {/* Cabecera */}
        <div className="space-y-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600">Proveedor <span className="text-red-500">*</span></label>
            <ProveedorPicker value={cab.proveedor_id} onChange={(id, nombre) => setCab((p) => ({ ...p, proveedor_id: id, proveedor_nombre: nombre }))} />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">Moneda</label>
              <select value={cab.moneda} onChange={(e) => setCab((p) => ({ ...p, moneda: e.target.value as "PYG" | "USD" }))} className={inputClass}>
                <option value="PYG">Guaraníes (PYG)</option>
                <option value="USD">Dólares (USD)</option>
              </select>
            </div>
            {cab.moneda === "USD" && (
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">Tipo de cambio</label>
                <input type="number" min={0} value={cab.tipo_cambio} onChange={(e) => setCab((p) => ({ ...p, tipo_cambio: e.target.value }))} placeholder="Ej: 7300" className={inputClass} />
              </div>
            )}
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">Tipo de pago</label>
              <select value={cab.tipo_pago} onChange={(e) => setCab((p) => ({ ...p, tipo_pago: e.target.value as "contado" | "credito" }))} className={inputClass}>
                <option value="contado">Contado</option>
                <option value="credito">Crédito</option>
              </select>
            </div>
            {cab.tipo_pago === "credito" && (
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">Plazo (días)</label>
                <input type="number" min={1} value={cab.plazo_dias} onChange={(e) => setCab((p) => ({ ...p, plazo_dias: e.target.value }))} className={inputClass} />
              </div>
            )}
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">Llegada estimada <span className="font-normal text-slate-400">(opcional)</span></label>
              <input type="date" value={cab.llegada_estimada} onChange={(e) => setCab((p) => ({ ...p, llegada_estimada: e.target.value }))} className={inputClass} />
            </div>
            <div className="sm:col-span-2 lg:col-span-4">
              <label className="mb-1 block text-xs font-semibold text-slate-600">Observación <span className="font-normal text-slate-400">(opcional)</span></label>
              <input value={cab.observacion} onChange={(e) => setCab((p) => ({ ...p, observacion: e.target.value }))} className={inputClass} placeholder="Notas de la orden…" />
            </div>
          </div>
        </div>

        {/* Buscador de productos */}
        <div ref={searchBoxRef} className="relative">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-[#4FAEB2]" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => { setQ(e.target.value); setSearchOpen(true); setHighlight(-1); }}
            onFocus={() => setSearchOpen(true)}
            onKeyDown={onKeyDown}
            placeholder="Buscar producto por nombre, SKU o palabras clave…"
            className="h-14 w-full rounded-2xl border-2 border-[#4FAEB2]/25 bg-white pl-12 pr-4 text-base outline-none focus:border-[#4FAEB2] focus:ring-4 focus:ring-[#4FAEB2]/15"
            autoComplete="off"
          />
          {searchOpen && q.trim().length >= 2 && (
            <div className="absolute left-0 right-0 top-full z-30 mt-2 max-h-[50vh] overflow-y-auto rounded-2xl border-2 border-[#4FAEB2]/20 bg-white shadow-[0_16px_40px_-12px_rgba(15,23,42,0.28)]">
              {buscando && resultados.length === 0 ? (
                <div className="px-4 py-6 text-center text-sm text-slate-400">Buscando…</div>
              ) : resultados.length === 0 ? (
                <div className="px-4 py-6 text-center text-sm text-slate-400">Sin resultados para &quot;{q}&quot;</div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {resultados.map((p, i) => {
                    const sinStock = p.stock_actual <= 0;
                    return (
                      <li key={p.id}>
                        <button type="button"
                          onMouseEnter={() => setHighlight(i)}
                          onClick={() => addProducto(p)}
                          className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors ${i === highlight ? "bg-[#4FAEB2]/[0.08]" : "hover:bg-slate-50"}`}>
                          <ProductoThumb url={p.imagen_url} alt={p.nombre} />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-semibold text-slate-800">{p.nombre}</p>
                            <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-500">
                              <span className="font-mono">{p.sku || "—"}</span>
                              <span className="text-slate-300">·</span>
                              <span className={`font-semibold ${sinStock ? "text-red-600" : p.stock_actual < 5 ? "text-amber-600" : "text-emerald-700"}`}>
                                {sinStock ? "Sin stock" : `${p.stock_actual} en stock`}
                              </span>
                            </div>
                          </div>
                          <span className="shrink-0 tabular-nums text-sm font-bold text-slate-800">{fmtGs(p.precio_venta)}</span>
                          <span className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-[#4FAEB2]/10 px-2.5 py-1 text-xs font-bold text-[#3F8E91]">
                            <Plus className="h-3.5 w-3.5" strokeWidth={2.5} /> Agregar
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>

        {/* Ítems */}
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          {lineas.length === 0 ? (
            <p className="py-12 text-center text-sm text-slate-400">Buscá productos arriba y agregalos a la orden.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-sm">
                <thead className="border-b border-slate-200 bg-slate-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-slate-500">Producto</th>
                    <th className="px-3 py-3 text-center text-[11px] font-bold uppercase tracking-wide text-slate-500">Cant.</th>
                    <th className="px-3 py-3 text-right text-[11px] font-bold uppercase tracking-wide text-slate-500">Costo unit. ({cab.moneda})</th>
                    <th className="px-3 py-3 text-center text-[11px] font-bold uppercase tracking-wide text-slate-500">IVA</th>
                    <th className="px-4 py-3 text-right text-[11px] font-bold uppercase tracking-wide text-slate-500">Total (Gs.)</th>
                    <th className="w-10 px-2 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {lineas.map((l) => (
                    <tr key={l.producto_id} className="hover:bg-[#4FAEB2]/5">
                      <td className="px-4 py-3">
                        <p className="font-semibold text-slate-900">{l.producto_nombre}</p>
                        <p className="font-mono text-[11px] text-slate-500">{l.sku}</p>
                      </td>
                      <td className="px-3 py-3">
                        <div className="mx-auto flex w-fit items-center gap-1.5">
                          <input type="number" min={0} step="any" value={l.cantidad}
                            onChange={(e) => updateLinea(l.producto_id, { cantidad: Math.max(0, Number(e.target.value) || 0) })}
                            className="h-8 w-20 rounded-md border border-slate-200 px-2 text-center text-sm tabular-nums" />
                          <span className="text-[10px] uppercase text-slate-400">{l.unidad_medida}</span>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right">
                        <input type="number" min={0} value={l.costo_input}
                          onChange={(e) => updateLinea(l.producto_id, { costo_input: Math.max(0, Number(e.target.value) || 0) })}
                          className="h-8 w-28 rounded-md border border-slate-200 px-2 text-right text-sm tabular-nums" />
                      </td>
                      <td className="px-3 py-3">
                        <div className="mx-auto inline-flex overflow-hidden rounded-lg border border-slate-200">
                          {(["exenta", "5", "10"] as const).map((iva) => {
                            const sel = l.iva_tipo === iva;
                            return (
                              <button key={iva} type="button" onClick={() => updateLinea(l.producto_id, { iva_tipo: iva })}
                                className={`px-2 py-1.5 text-[11px] font-semibold transition-colors ${sel ? "bg-[#4FAEB2] text-white" : "bg-white text-slate-600 hover:bg-slate-100"}`}>
                                {iva === "exenta" ? "Ex" : `${iva}%`}
                              </button>
                            );
                          })}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right text-sm font-bold tabular-nums text-slate-900">
                        {fmtGs(l.costo_input * tc * l.cantidad)}
                      </td>
                      <td className="px-2 py-3 text-center">
                        <button type="button" onClick={() => removeLinea(l.producto_id)} className="rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label="Quitar">
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {err && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>}

        <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Total estimado</p>
            <p className="text-2xl font-bold tabular-nums text-slate-900">{fmtGs(totalOc)}</p>
          </div>
          <button type="submit" disabled={enviando}
            className="inline-flex items-center gap-2 rounded-xl bg-[#4FAEB2] px-6 py-3 text-sm font-bold text-white shadow-md shadow-[#4FAEB2]/30 hover:bg-[#3F8E91] disabled:opacity-50">
            {enviando && <Loader2 className="h-4 w-4 animate-spin" />}
            Crear orden de compra
          </button>
        </div>
      </form>
    </div>
  );
}
