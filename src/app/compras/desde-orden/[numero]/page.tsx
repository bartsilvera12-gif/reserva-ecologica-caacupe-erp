"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import { uploadComprobante } from "@/lib/compras/storage";

type OcCab = { id: string; numero: string; proveedor_nombre: string; estado: string; fecha: string; moneda: string; tipo_pago: string; plazo_dias: number | null };
type OcItem = { id: string; producto_nombre: string; sku_snapshot: string | null; cantidad_solicitada: number; cantidad_recibida: number; costo_estimado: number };
type Linea = { llego: boolean; cantidad: string; costo: string };

function fmtGs(v: number, m = "PYG") { return (m === "USD" ? "USD " : "Gs. ") + Math.round(Number(v) || 0).toLocaleString("es-PY"); }
function fmtNum(n: number) { return (Number(n) || 0).toLocaleString("es-PY", { maximumFractionDigits: 2 }); }
function fmtFecha(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return "—";
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}
const inputClass = "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#4FAEB2]/30";
const labelClass = "mb-1 block text-xs font-semibold text-slate-600";
const RECEPTIBLES = ["emitida", "aprobada", "parcialmente_recibida"];

export default function DesdeOrdenRecepcionPage() {
  const params = useParams<{ numero: string }>();
  const router = useRouter();
  const numeroOc = decodeURIComponent(String(params.numero));

  const [cab, setCab] = useState<OcCab | null>(null);
  const [items, setItems] = useState<OcItem[]>([]);
  const [rec, setRec] = useState<Record<string, Linea>>({});
  const [cargando, setCargando] = useState(true);
  const [noEncontrada, setNoEncontrada] = useState(false);

  const [numeroFactura, setNumeroFactura] = useState("");
  const [nroTimbrado, setNroTimbrado] = useState("");
  const [fechaFactura, setFechaFactura] = useState("");
  const [comprobanteFile, setComprobanteFile] = useState<File | null>(null);

  const [procesando, setProcesando] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true); setErr(null); setNoEncontrada(false);
    try {
      const lr = await fetchWithSupabaseSession("/api/ordenes-compra", { cache: "no-store" });
      const lj = await lr.json();
      const oc = ((lj?.data?.ordenes ?? []) as OcCab[]).find((o) => o.numero === numeroOc);
      if (!oc) { setNoEncontrada(true); return; }
      const dr = await fetchWithSupabaseSession(`/api/ordenes-compra/${oc.id}`, { cache: "no-store" });
      const dj = await dr.json();
      if (!dr.ok) throw new Error(typeof dj.error === "string" ? dj.error : "No se pudo cargar.");
      const c: OcCab = dj?.data?.cabecera;
      const its: OcItem[] = dj?.data?.items ?? [];
      setCab({ ...c, id: oc.id });
      setItems(its);
      const init: Record<string, Linea> = {};
      for (const it of its) {
        const pend = Math.max(0, Number(it.cantidad_solicitada) - Number(it.cantidad_recibida));
        init[it.id] = { llego: pend > 0, cantidad: pend > 0 ? String(pend) : "0", costo: String(Math.round(Number(it.costo_estimado))) };
      }
      setRec(init);
    } catch (e) { setErr(e instanceof Error ? e.message : "Error."); }
    finally { setCargando(false); }
  }, [numeroOc]);
  useEffect(() => { cargar(); }, [cargar]);

  function setLinea(id: string, patch: Partial<Linea>) {
    setRec((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }
  function toggleLlego(it: OcItem) {
    const pend = Math.max(0, it.cantidad_solicitada - it.cantidad_recibida);
    setRec((prev) => {
      const a = prev[it.id];
      const llego = !a.llego;
      return { ...prev, [it.id]: { ...a, llego, cantidad: llego ? String(pend) : "0" } };
    });
  }

  const totalPedido = useMemo(() => items.reduce((s, it) => s + Number(it.cantidad_solicitada) * Number(it.costo_estimado), 0), [items]);
  const totalAhora = useMemo(() => items.reduce((s, it) => {
    const r = rec[it.id];
    const cant = r?.llego ? Number(r.cantidad) || 0 : 0;
    return s + cant * (Number(r?.costo) || 0);
  }, 0), [items, rec]);

  async function confirmar() {
    setErr(null);
    if (!nroTimbrado.trim()) { setErr("Ingresá el N° de timbrado de la factura recibida."); return; }
    const recepciones = items.map((it) => {
      const r = rec[it.id];
      const pend = Math.max(0, it.cantidad_solicitada - it.cantidad_recibida);
      const cant = r?.llego ? Math.min(Number(r.cantidad) || 0, pend) : 0;
      return { item_id: it.id, cantidad: cant, costo_unitario: Number(r?.costo) || 0 };
    }).filter((x) => x.cantidad > 0);
    if (recepciones.length === 0) { setErr("Marcá al menos un producto como recibido."); return; }
    if (!window.confirm("¿Confirmar la recepción? Se crea la compra real y suma stock por lo recibido.")) return;

    setProcesando(true);
    try {
      let comp: { path: string | null; nombre: string | null; mime: string | null } = { path: null, nombre: null, mime: null };
      if (comprobanteFile) {
        const up = await uploadComprobante(comprobanteFile);
        if (!up.ok) { setErr(`Comprobante: ${up.error}`); setProcesando(false); return; }
        comp = { path: up.data.comprobante_storage_path, nombre: up.data.comprobante_nombre, mime: up.data.comprobante_mime_type };
      }
      const res = await fetchWithSupabaseSession(`/api/ordenes-compra/${cab!.id}/recibir`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recepciones,
          nro_timbrado: nroTimbrado.trim(),
          numero_factura_proveedor: numeroFactura.trim() || undefined,
          fecha_factura: fechaFactura || undefined,
          comprobante_storage_path: comp.path ?? undefined,
          comprobante_nombre: comp.nombre ?? undefined,
          comprobante_mime_type: comp.mime ?? undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "No se pudo confirmar.");
      router.push("/compras");
    } catch (e) { setErr(e instanceof Error ? e.message : "Error."); setProcesando(false); }
  }

  if (cargando) return <p className="py-10 text-center text-slate-500 animate-pulse">Cargando…</p>;
  if (noEncontrada || !cab) {
    return (
      <div className="space-y-4">
        <Link href="/compras/desde-orden" className="text-sm text-slate-500 hover:text-[#3F8E91]">← Desde Orden de Compra</Link>
        <p className="text-slate-500">Orden de compra no encontrada.</p>
      </div>
    );
  }
  if (!RECEPTIBLES.includes(cab.estado)) {
    return (
      <div className="space-y-4">
        <Link href="/compras/desde-orden" className="text-sm text-slate-500 hover:text-[#3F8E91]">← Desde Orden de Compra</Link>
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
          Esta orden ya no tiene nada pendiente de recibir ({cab.estado === "cancelada" ? "cancelada" : cab.estado === "recibida" ? "recibida por completo" : cab.estado}).
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Link href="/compras/desde-orden" className="inline-flex items-center gap-1 text-sm font-medium text-slate-500 hover:text-[#3F8E91]">
        ← Desde Orden de Compra
      </Link>

      <div>
        <div className="flex items-center gap-3">
          <h1 className="font-mono text-2xl font-bold text-slate-900">{cab.numero}</h1>
          <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${cab.estado === "parcialmente_recibida" ? "bg-sky-100 text-sky-700" : "bg-amber-100 text-amber-800"}`}>
            {cab.estado === "parcialmente_recibida" ? "Recibida parcial" : "Pendiente"}
          </span>
        </div>
        <p className="mt-1 text-sm text-slate-500">{cab.proveedor_nombre || "—"} · Pedida el {fmtFecha(cab.fecha)}</p>
      </div>

      {err && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>}

      {/* Tabla de recepción producto por producto */}
      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="border-b-2 border-[#4FAEB2]/40 bg-[#E5F4F4]">
            <tr>
              {["Llegó", "Producto", "Pedida", "Ya recibida", "Pendiente", "Recibida ahora", "Costo", "Subtotal"].map((h, i) => (
                <th key={h} className={`px-3 py-3 text-xs font-bold uppercase tracking-wide text-[#3F8E91] ${i <= 1 ? "text-left" : "text-right"}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.map((it) => {
              const pend = Math.max(0, it.cantidad_solicitada - it.cantidad_recibida);
              const ya = pend <= 0;
              const r = rec[it.id] ?? { llego: false, cantidad: "0", costo: "0" };
              const cant = r.llego ? Number(r.cantidad) || 0 : 0;
              const excede = cant > pend;
              return (
                <tr key={it.id} className={ya ? "bg-slate-50/60 opacity-60" : ""}>
                  <td className="px-3 py-2.5">
                    {!ya && (
                      <button type="button" onClick={() => toggleLlego(it)}
                        className={`rounded-full px-2.5 py-1 text-xs font-semibold transition-colors ${r.llego ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
                        {r.llego ? "Sí" : "No"}
                      </button>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="font-medium text-slate-900">{it.producto_nombre}</div>
                    <div className="text-xs text-slate-400">{it.sku_snapshot}</div>
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">{fmtNum(it.cantidad_solicitada)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-emerald-700">{fmtNum(it.cantidad_recibida)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-amber-700">{fmtNum(pend)}</td>
                  <td className="px-3 py-2.5 text-right">
                    {ya ? <span className="text-xs text-slate-400">completo</span> : (
                      <input type="number" min={0} max={pend} step="any" disabled={!r.llego} value={r.cantidad}
                        onChange={(e) => setLinea(it.id, { cantidad: e.target.value })}
                        className={`w-24 rounded-lg border px-2 py-1.5 text-right text-sm outline-none focus:ring-2 focus:ring-[#4FAEB2]/30 disabled:bg-slate-100 disabled:text-slate-400 ${excede ? "border-amber-400" : "border-slate-200"}`} />
                    )}
                    {excede && <p className="mt-0.5 text-[10px] font-semibold text-amber-600">Se recibirá solo lo pendiente</p>}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    {ya ? <span className="text-xs text-slate-400">—</span> : (
                      <input type="number" min={0} step="any" disabled={!r.llego} value={r.costo}
                        onChange={(e) => setLinea(it.id, { costo: e.target.value })}
                        className="w-28 rounded-lg border border-slate-200 px-2 py-1.5 text-right text-sm outline-none focus:ring-2 focus:ring-[#4FAEB2]/30 disabled:bg-slate-100 disabled:text-slate-400" />
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-slate-900">{fmtGs(cant * (Number(r.costo) || 0), cab.moneda)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-slate-200 bg-slate-50">
              <td colSpan={7} className="px-3 py-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
                Total pedido: {fmtGs(totalPedido, cab.moneda)} · Total a recibir ahora
              </td>
              <td className="px-3 py-3 text-right tabular-nums font-bold text-slate-900">{fmtGs(totalAhora, cab.moneda)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Datos de la compra (factura del proveedor) */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-bold text-slate-800">Datos de la compra</h2>
        <p className="mt-1 text-xs text-slate-500">Se genera una compra SOLO con lo confirmado como recibido arriba. Cargá los datos de la factura del proveedor.</p>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={labelClass}>Proveedor</label>
            <input disabled value={cab.proveedor_nombre} className={`${inputClass} bg-slate-50 text-slate-500`} />
          </div>
          <div>
            <label className={labelClass}>Condición de pago (de la orden)</label>
            <input disabled value={cab.tipo_pago === "credito" ? `Crédito${cab.plazo_dias ? ` ${cab.plazo_dias} días` : ""}` : "Contado"} className={`${inputClass} bg-slate-50 text-slate-500`} />
          </div>
          <div>
            <label className={labelClass}>N° de timbrado <span className="text-red-500">*</span></label>
            <input value={nroTimbrado} onChange={(e) => setNroTimbrado(e.target.value)} placeholder="Ej: 12345678" className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>N° de factura del proveedor</label>
            <input value={numeroFactura} onChange={(e) => setNumeroFactura(e.target.value)} placeholder="001-001-0000123" className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>Fecha de factura</label>
            <input type="date" value={fechaFactura} onChange={(e) => setFechaFactura(e.target.value)} className={inputClass} />
          </div>
          <div className="sm:col-span-2">
            <label className={labelClass}>Comprobante / factura <span className="font-normal text-slate-400">(opcional)</span></label>
            <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf"
              onChange={(e) => setComprobanteFile(e.target.files?.[0] ?? null)}
              className="block w-full text-xs text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-[#4FAEB2] file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-white hover:file:bg-[#3F8E91]" />
          </div>
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <Link href="/compras" className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50">Cancelar</Link>
          <button type="button" onClick={confirmar} disabled={procesando}
            className="inline-flex items-center gap-2 rounded-lg bg-[#4FAEB2] px-4 py-2 text-sm font-bold text-white hover:bg-[#3F8E91] disabled:opacity-50">
            {procesando && <Loader2 className="h-4 w-4 animate-spin" />}
            Confirmar compra y recepción
          </button>
        </div>
      </div>
    </div>
  );
}
