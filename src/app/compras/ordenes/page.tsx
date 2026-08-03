"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import { getProveedores } from "@/lib/proveedores/storage";
import type { Proveedor } from "@/lib/proveedores/types";
import { ClipboardList, Plus, X, Search, Loader2, Truck } from "lucide-react";

type OcRow = {
  id: string; numero: string; proveedor_nombre: string; estado: string; moneda: string;
  fecha: string; llegada_estimada: string | null; tipo_pago: string; plazo_dias: number | null;
  items_count: number; total: number;
};
type OcItem = {
  id: string; producto_id: string; producto_nombre: string; sku_snapshot: string | null;
  descripcion: string | null; cantidad_solicitada: number; cantidad_recibida: number;
  costo_estimado: number; iva_tipo: string; subtotal: number; total: number;
};
type ProductoBusq = { id: string; nombre: string; sku: string };

const ESTADO: Record<string, { label: string; cls: string }> = {
  borrador: { label: "Borrador", cls: "bg-slate-100 text-slate-600" },
  emitida: { label: "Emitida", cls: "bg-sky-100 text-sky-800" },
  aprobada: { label: "Aprobada", cls: "bg-indigo-100 text-indigo-800" },
  parcialmente_recibida: { label: "Parcial", cls: "bg-amber-100 text-amber-800" },
  recibida: { label: "Recibida", cls: "bg-emerald-100 text-emerald-700" },
  cancelada: { label: "Cancelada", cls: "bg-slate-100 text-slate-500" },
};

function fmtGs(n: number, m = "PYG") { return (m === "USD" ? "USD " : "Gs. ") + Math.round(Number(n) || 0).toLocaleString("es-PY"); }
function fmtNum(n: number) { return (Number(n) || 0).toLocaleString("es-PY", { maximumFractionDigits: 2 }); }
function fmtFecha(iso: string | null) {
  if (!iso) return "—";
  const s = String(iso).slice(0, 10); const [y, m, d] = s.split("-");
  return d && m && y ? `${d}/${m}/${y}` : s;
}
function Badge({ estado }: { estado: string }) {
  const e = ESTADO[estado] ?? { label: estado, cls: "bg-slate-100 text-slate-600" };
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${e.cls}`}>{e.label}</span>;
}

export default function OrdenesCompraPage() {
  const [ordenes, setOrdenes] = useState<OcRow[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [crear, setCrear] = useState(false);
  const [detalle, setDetalle] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true); setError(null);
    try {
      const res = await fetchWithSupabaseSession("/api/ordenes-compra", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "No se pudo cargar.");
      setOrdenes(json?.data?.ordenes ?? []);
    } catch (e) { setError(e instanceof Error ? e.message : "Error."); }
    finally { setCargando(false); }
  }, []);
  useEffect(() => { cargar(); }, [cargar]);

  return (
    <div className="w-full space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2.5 text-2xl font-bold text-slate-900">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#4FAEB2]/10 text-[#4FAEB2]"><ClipboardList className="h-5 w-5" /></span>
            Órdenes de compra
          </h1>
          <p className="mt-1 text-sm text-slate-500">Pedidos a proveedores. Crear/emitir no mueve stock: eso ocurre al recibir.</p>
        </div>
        <button onClick={() => setCrear(true)} className="inline-flex items-center gap-2 rounded-xl bg-[#4FAEB2] px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-all hover:bg-[#3F8E91] active:scale-95">
          <Plus className="h-4 w-4" /> Nueva orden
        </button>
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
        {cargando ? (
          <div className="flex items-center justify-center gap-2 px-4 py-16 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /> Cargando…</div>
        ) : ordenes.length === 0 ? (
          <div className="px-4 py-16 text-center text-sm text-slate-400">Todavía no hay órdenes de compra.</div>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50/80 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3 font-semibold">Número</th>
                <th className="px-4 py-3 font-semibold">Proveedor</th>
                <th className="px-4 py-3 font-semibold text-center">Ítems</th>
                <th className="px-4 py-3 font-semibold text-right">Total est.</th>
                <th className="px-4 py-3 font-semibold">Llegada</th>
                <th className="px-4 py-3 font-semibold">Estado</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {ordenes.map((o) => (
                <tr key={o.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setDetalle(o.id)}>
                  <td className="px-4 py-3 font-semibold tabular-nums text-slate-800">{o.numero}</td>
                  <td className="px-4 py-3 text-slate-600">{o.proveedor_nombre || "—"}</td>
                  <td className="px-4 py-3 text-center tabular-nums text-slate-600">{o.items_count}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-700">{fmtGs(o.total, o.moneda)}</td>
                  <td className="px-4 py-3 text-slate-500">{fmtFecha(o.llegada_estimada)}</td>
                  <td className="px-4 py-3"><Badge estado={o.estado} /></td>
                  <td className="px-4 py-3 text-right"><span className="text-sm font-medium text-[#4FAEB2] hover:underline">Ver</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {crear && <ModalCrear onClose={() => setCrear(false)} onCreada={() => { setCrear(false); cargar(); }} />}
      {detalle && <ModalDetalle id={detalle} onClose={() => setDetalle(null)} onCambio={cargar} />}
    </div>
  );
}

function Overlay({ titulo, onClose, children, max = "max-w-2xl" }: { titulo: string; onClose: () => void; children: React.ReactNode; max?: string }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:items-center">
      <div className={`my-8 w-full ${max} rounded-xl bg-white shadow-xl`}>
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h2 className="text-lg font-semibold text-slate-900">{titulo}</h2>
          <button onClick={onClose} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"><X className="h-5 w-5" /></button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

function ModalCrear({ onClose, onCreada }: { onClose: () => void; onCreada: () => void }) {
  const [proveedores, setProveedores] = useState<Proveedor[]>([]);
  const [proveedorId, setProveedorId] = useState("");
  const [tipoPago, setTipoPago] = useState<"contado" | "credito">("contado");
  const [plazo, setPlazo] = useState("");
  const [llegada, setLlegada] = useState("");
  const [obs, setObs] = useState("");
  const [busqueda, setBusqueda] = useState("");
  const [resultados, setResultados] = useState<ProductoBusq[]>([]);
  const [lineas, setLineas] = useState<Array<{ producto_id: string; nombre: string; sku: string; cantidad: string; costo: string; iva: string }>>([]);
  const [guardando, setGuardando] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { getProveedores().then(setProveedores).catch(() => {}); }, []);
  useEffect(() => {
    const q = busqueda.trim();
    if (q.length < 2) { setResultados([]); return; }
    let vivo = true;
    const t = setTimeout(async () => {
      try {
        const res = await fetchWithSupabaseSession(`/api/productos/search?q=${encodeURIComponent(q)}&limit=20`);
        const json = await res.json();
        if (vivo && res.ok) setResultados(((json?.data?.items ?? []) as ProductoBusq[]).map((p) => ({ id: p.id, nombre: p.nombre, sku: p.sku })));
      } catch { /* ignore */ }
    }, 250);
    return () => { vivo = false; clearTimeout(t); };
  }, [busqueda]);

  function agregar(p: ProductoBusq) {
    if (lineas.some((l) => l.producto_id === p.id)) return;
    setLineas((prev) => [...prev, { producto_id: p.id, nombre: p.nombre, sku: p.sku, cantidad: "", costo: "", iva: "10" }]);
    setBusqueda(""); setResultados([]);
  }

  async function guardar(emitir: boolean) {
    setErr(null);
    if (!proveedorId) return setErr("Elegí el proveedor.");
    const items = lineas
      .map((l) => ({ producto_id: l.producto_id, producto_nombre: l.nombre, sku: l.sku, cantidad_solicitada: Number(l.cantidad) || 0, costo_estimado: Number(l.costo) || 0, iva_tipo: l.iva }))
      .filter((i) => i.cantidad_solicitada > 0);
    if (items.length === 0) return setErr("Agregá al menos un producto con cantidad.");
    const prov = proveedores.find((p) => String(p.id) === proveedorId);
    setGuardando(true);
    try {
      const res = await fetchWithSupabaseSession("/api/ordenes-compra", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proveedor_id: proveedorId, proveedor_nombre: prov?.nombre ?? "",
          tipo_pago: tipoPago, plazo_dias: tipoPago === "credito" && plazo ? Number(plazo) : undefined,
          llegada_estimada: llegada || undefined, observaciones: obs.trim() || undefined,
          emitir, items,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "No se pudo crear.");
      onCreada();
    } catch (e) { setGuardando(false); setErr(e instanceof Error ? e.message : "Error."); }
  }

  const total = lineas.reduce((a, l) => a + (Number(l.cantidad) || 0) * (Number(l.costo) || 0), 0);

  return (
    <Overlay titulo="Nueva orden de compra" onClose={onClose}>
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">Proveedor</label>
            <select value={proveedorId} onChange={(e) => setProveedorId(e.target.value)} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]">
              <option value="">Seleccioná…</option>
              {proveedores.map((p) => <option key={p.id} value={String(p.id)}>{p.nombre}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">Llegada estimada (opcional)</label>
            <input type="date" value={llegada} onChange={(e) => setLlegada(e.target.value)} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]" />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">Tipo de pago</label>
            <select value={tipoPago} onChange={(e) => setTipoPago(e.target.value as "contado" | "credito")} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]">
              <option value="contado">Contado</option>
              <option value="credito">Crédito</option>
            </select>
          </div>
          {tipoPago === "credito" && (
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">Plazo (días)</label>
              <input type="number" min={0} value={plazo} onChange={(e) => setPlazo(e.target.value)} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]" />
            </div>
          )}
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">Agregar productos</label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input value={busqueda} onChange={(e) => setBusqueda(e.target.value)} placeholder="Buscar por nombre o SKU…" className="w-full rounded-lg border border-slate-200 py-2 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]" />
            {resultados.length > 0 && (
              <div className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-slate-200 bg-white p-1 shadow-lg">
                {resultados.map((p) => (
                  <button key={p.id} onClick={() => agregar(p)} className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-50">
                    <span className="font-medium text-slate-800">{p.nombre}</span><span className="text-xs text-slate-400">{p.sku}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {lineas.length > 0 && (
          <div className="overflow-hidden rounded-lg border border-slate-200">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr><th className="px-3 py-2 text-left font-semibold">Producto</th><th className="px-3 py-2 text-right font-semibold">Cantidad</th><th className="px-3 py-2 text-right font-semibold">Costo est.</th><th className="px-3 py-2 text-left font-semibold">IVA</th><th className="px-3 py-2" /></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {lineas.map((l) => (
                  <tr key={l.producto_id}>
                    <td className="px-3 py-2"><div className="font-medium text-slate-800">{l.nombre}</div><div className="text-xs text-slate-400">{l.sku}</div></td>
                    <td className="px-3 py-2 text-right"><input type="number" min={0} step="any" value={l.cantidad} onChange={(e) => setLineas((prev) => prev.map((x) => x.producto_id === l.producto_id ? { ...x, cantidad: e.target.value } : x))} className="w-20 rounded border border-slate-200 px-2 py-1 text-right tabular-nums focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]" /></td>
                    <td className="px-3 py-2 text-right"><input type="number" min={0} step="any" value={l.costo} onChange={(e) => setLineas((prev) => prev.map((x) => x.producto_id === l.producto_id ? { ...x, costo: e.target.value } : x))} className="w-28 rounded border border-slate-200 px-2 py-1 text-right tabular-nums focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]" /></td>
                    <td className="px-3 py-2"><select value={l.iva} onChange={(e) => setLineas((prev) => prev.map((x) => x.producto_id === l.producto_id ? { ...x, iva: e.target.value } : x))} className="rounded border border-slate-200 px-2 py-1 text-sm"><option value="10">10%</option><option value="5">5%</option><option value="exenta">Exenta</option></select></td>
                    <td className="px-3 py-2 text-right"><button onClick={() => setLineas((prev) => prev.filter((x) => x.producto_id !== l.producto_id))} className="text-xs text-red-500 hover:underline">Quitar</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">Observación (opcional)</label>
          <textarea value={obs} onChange={(e) => setObs(e.target.value)} rows={2} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]" />
        </div>

        {err && <p className="text-sm text-red-600">{err}</p>}

        <div className="flex items-center justify-between pt-2">
          <span className="text-sm text-slate-500">Total estimado: <span className="font-semibold text-slate-800">{fmtGs(total)}</span></span>
          <div className="flex gap-2">
            <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-slate-500 hover:text-slate-700">Cancelar</button>
            <button onClick={() => guardar(false)} disabled={guardando} className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50">Guardar borrador</button>
            <button onClick={() => guardar(true)} disabled={guardando} className="rounded-lg bg-[#4FAEB2] px-4 py-2 text-sm font-semibold text-white hover:bg-[#3F8E91] disabled:opacity-50">{guardando ? "Guardando…" : "Emitir orden"}</button>
          </div>
        </div>
      </div>
    </Overlay>
  );
}

function ModalDetalle({ id, onClose, onCambio }: { id: string; onClose: () => void; onCambio: () => void }) {
  const [cab, setCab] = useState<Record<string, unknown> | null>(null);
  const [items, setItems] = useState<OcItem[]>([]);
  const [cargando, setCargando] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [accion, setAccion] = useState(false);
  const [recibiendo, setRecibiendo] = useState(false);
  const [rec, setRec] = useState<Record<string, { cant: string; costo: string }>>({});
  const [timbrado, setTimbrado] = useState("");
  const [factura, setFactura] = useState("");
  const [fechaFactura, setFechaFactura] = useState("");

  const cargar = useCallback(async () => {
    setCargando(true); setErr(null);
    try {
      const res = await fetchWithSupabaseSession(`/api/ordenes-compra/${id}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "No se pudo cargar.");
      setCab(json?.data?.cabecera ?? null);
      const its: OcItem[] = json?.data?.items ?? [];
      setItems(its);
      const pre: Record<string, { cant: string; costo: string }> = {};
      for (const it of its) {
        const pend = Math.max(0, Number(it.cantidad_solicitada) - Number(it.cantidad_recibida));
        pre[it.id] = { cant: String(pend), costo: String(Math.round(Number(it.costo_estimado))) };
      }
      setRec(pre);
    } catch (e) { setErr(e instanceof Error ? e.message : "Error."); }
    finally { setCargando(false); }
  }, [id]);
  useEffect(() => { cargar(); }, [cargar]);

  const estado = cab ? String(cab.estado) : "";
  const receptible = ["emitida", "aprobada", "parcialmente_recibida"].includes(estado);

  async function cambiarEstado(nuevo: string, confirmar?: string) {
    if (confirmar && !window.confirm(confirmar)) return;
    setAccion(true); setErr(null);
    try {
      const res = await fetchWithSupabaseSession(`/api/ordenes-compra/${id}/estado`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ estado: nuevo }) });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "No se pudo.");
      await cargar(); onCambio();
    } catch (e) { setErr(e instanceof Error ? e.message : "Error."); }
    finally { setAccion(false); }
  }

  async function recibir() {
    setErr(null);
    if (!timbrado.trim()) return setErr("Ingresá el N° de timbrado de la factura recibida.");
    const recepciones = items
      .map((it) => ({ item_id: it.id, cantidad: Number(rec[it.id]?.cant) || 0, costo_unitario: Number(rec[it.id]?.costo) || 0 }))
      .filter((r) => r.cantidad > 0);
    if (recepciones.length === 0) return setErr("Indicá al menos una cantidad recibida.");
    if (!window.confirm("¿Confirmar recepción? Esto crea la compra real y suma stock por lo recibido.")) return;
    setRecibiendo(true);
    try {
      const res = await fetchWithSupabaseSession(`/api/ordenes-compra/${id}/recibir`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recepciones, nro_timbrado: timbrado.trim(), numero_factura_proveedor: factura.trim() || undefined, fecha_factura: fechaFactura || undefined }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "No se pudo recibir.");
      await cargar(); onCambio();
    } catch (e) { setErr(e instanceof Error ? e.message : "Error."); }
    finally { setRecibiendo(false); }
  }

  return (
    <Overlay titulo={cab ? `Orden ${String(cab.numero)}` : "Orden de compra"} onClose={onClose} max="max-w-3xl">
      {cargando ? (
        <div className="py-10 text-center text-sm text-slate-400">Cargando…</div>
      ) : !cab ? (
        <div className="py-10 text-center text-sm text-slate-400">No se encontró la orden.</div>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-3">
            <Badge estado={estado} />
            <span className="text-sm text-slate-500">{String(cab.proveedor_nombre || "—")} · {String(cab.tipo_pago)}{cab.plazo_dias ? ` ${cab.plazo_dias}d` : ""}</span>
          </div>

          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr><th className="px-3 py-2 text-left font-semibold">Producto</th><th className="px-3 py-2 text-right font-semibold">Pedido</th><th className="px-3 py-2 text-right font-semibold">Recibido</th>{receptible && <><th className="px-3 py-2 text-right font-semibold">Recibir</th><th className="px-3 py-2 text-right font-semibold">Costo</th></>}</tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((it) => {
                  const pend = Math.max(0, it.cantidad_solicitada - it.cantidad_recibida);
                  return (
                    <tr key={it.id}>
                      <td className="px-3 py-2"><div className="font-medium text-slate-800">{it.producto_nombre}</div><div className="text-xs text-slate-400">{it.sku_snapshot}</div></td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-600">{fmtNum(it.cantidad_solicitada)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-600">{fmtNum(it.cantidad_recibida)}</td>
                      {receptible && (
                        <>
                          <td className="px-3 py-2 text-right"><input type="number" min={0} max={pend} step="any" value={rec[it.id]?.cant ?? ""} onChange={(e) => setRec((p) => ({ ...p, [it.id]: { ...p[it.id], cant: e.target.value } }))} className="w-20 rounded border border-slate-200 px-2 py-1 text-right tabular-nums focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]" /></td>
                          <td className="px-3 py-2 text-right"><input type="number" min={0} step="any" value={rec[it.id]?.costo ?? ""} onChange={(e) => setRec((p) => ({ ...p, [it.id]: { ...p[it.id], costo: e.target.value } }))} className="w-28 rounded border border-slate-200 px-2 py-1 text-right tabular-nums focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]" /></td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {receptible && (
            <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/60 p-3">
              <p className="text-sm font-semibold text-slate-700">Datos de la factura recibida</p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <input value={timbrado} onChange={(e) => setTimbrado(e.target.value)} placeholder="N° timbrado *" className="rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]" />
                <input value={factura} onChange={(e) => setFactura(e.target.value)} placeholder="N° factura proveedor" className="rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]" />
                <input type="date" value={fechaFactura} onChange={(e) => setFechaFactura(e.target.value)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]" />
              </div>
            </div>
          )}

          {err && <p className="text-sm text-red-600">{err}</p>}

          <div className="flex flex-wrap justify-end gap-2">
            {estado === "borrador" && <button onClick={() => cambiarEstado("emitida")} disabled={accion} className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-700 disabled:opacity-50">Emitir</button>}
            {estado === "emitida" && <button onClick={() => cambiarEstado("aprobada")} disabled={accion} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">Aprobar</button>}
            {["borrador", "emitida", "aprobada", "parcialmente_recibida"].includes(estado) && <button onClick={() => cambiarEstado("cancelada", "¿Cancelar esta orden?")} disabled={accion} className="rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50">Cancelar</button>}
            {receptible && <button onClick={recibir} disabled={recibiendo} className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">{recibiendo ? <Loader2 className="h-4 w-4 animate-spin" /> : <Truck className="h-4 w-4" />} Recibir</button>}
          </div>
        </div>
      )}
    </Overlay>
  );
}
