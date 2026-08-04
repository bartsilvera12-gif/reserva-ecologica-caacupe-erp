"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AlertTriangle, Loader2, Download } from "lucide-react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";

type Cabecera = {
  id: string; numero: string; proveedor_nombre: string; estado: string;
  moneda: string; tipo_cambio: number; fecha: string; llegada_estimada: string | null;
  tipo_pago: string; plazo_dias: number | null; observaciones: string | null;
};
type Item = {
  id: string; producto_nombre: string; sku_snapshot: string | null;
  cantidad_solicitada: number; cantidad_recibida: number;
  costo_estimado: number; iva_tipo: string; subtotal: number; total: number;
};

function fmtGs(v: number) { return `Gs. ${Math.round(Number(v) || 0).toLocaleString("es-PY")}`; }
function fmtFecha(iso: string | null | undefined) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  } catch { return iso; }
}
const IVA_LBL: Record<string, string> = { exenta: "Exenta", "5": "5%", "10": "10%" };
const ESTADO_BADGE: Record<string, string> = {
  borrador: "bg-slate-100 text-slate-600",
  emitida: "bg-amber-100 text-amber-700",
  aprobada: "bg-[#4FAEB2]/15 text-[#3F8E91]",
  parcialmente_recibida: "bg-sky-100 text-sky-700",
  recibida: "bg-emerald-100 text-emerald-700",
  cancelada: "bg-slate-100 text-slate-500",
};
const ESTADO_LBL: Record<string, string> = {
  borrador: "Borrador", emitida: "Emitida", aprobada: "Aprobada",
  parcialmente_recibida: "Parcialmente recibida", recibida: "Recibida", cancelada: "Cancelada",
};

export default function OrdenCompraDetallePage() {
  const params = useParams<{ id: string }>();
  const id = String(params.id);

  const [cab, setCab] = useState<Cabecera | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [cargando, setCargando] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [procesando, setProcesando] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      const res = await fetchWithSupabaseSession(`/api/ordenes-compra/${id}`, { cache: "no-store" });
      const j = await res.json();
      if (res.ok && j?.data) { setCab(j.data.cabecera ?? null); setItems(j.data.items ?? []); }
      else { setCab(null); setItems([]); }
    } catch { setCab(null); setItems([]); }
    finally { setCargando(false); }
  }, [id]);
  useEffect(() => { cargar(); }, [cargar]);

  const subtotal = useMemo(() => items.reduce((s, l) => s + Number(l.subtotal), 0), [items]);
  const total = useMemo(() => items.reduce((s, l) => s + Number(l.total), 0), [items]);
  const totalIva = total - subtotal;

  const estado = cab?.estado ?? "";
  const puedeRecibir = ["emitida", "aprobada", "parcialmente_recibida"].includes(estado);
  const puedeCancelar = ["borrador", "emitida", "aprobada", "parcialmente_recibida"].includes(estado);

  async function cambiarEstado(nuevo: string) {
    setProcesando(true); setErr(null); setMsg(null);
    try {
      const res = await fetchWithSupabaseSession(`/api/ordenes-compra/${id}/estado`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ estado: nuevo }),
      });
      const j = await res.json();
      if (!res.ok || j?.success === false) { setErr(typeof j?.error === "string" ? j.error : "No se pudo cambiar el estado."); return; }
      setCancelOpen(false);
      setMsg(nuevo === "cancelada" ? "Orden cancelada." : nuevo === "emitida" ? "Orden emitida." : "Orden aprobada.");
      cargar();
    } finally { setProcesando(false); }
  }

  if (cargando) return <p className="animate-pulse py-10 text-center text-slate-500">Cargando…</p>;
  if (!cab) {
    return (
      <div className="space-y-4">
        <Link href="/compras/ordenes" className="text-sm text-slate-500 hover:text-[#3F8E91]">← Órdenes de compra</Link>
        <p className="text-slate-500">Orden de compra no encontrada.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Link href="/compras/ordenes" className="inline-flex items-center gap-1 text-sm font-medium text-slate-500 hover:text-[#3F8E91]">
        ← Órdenes de compra
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="font-mono text-2xl font-bold text-slate-900">{cab.numero}</h1>
            <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${ESTADO_BADGE[estado] ?? "bg-slate-100 text-slate-600"}`}>
              {ESTADO_LBL[estado] ?? estado}
            </span>
          </div>
          <p className="mt-1 text-sm text-slate-500">
            {cab.proveedor_nombre || "—"} · {fmtFecha(cab.fecha)}
            {cab.tipo_pago === "credito" ? ` · Crédito${cab.plazo_dias ? ` ${cab.plazo_dias} días` : ""}` : " · Contado"}
            {cab.moneda === "USD" ? ` · USD @ ${fmtGs(cab.tipo_cambio)}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <a href={`/api/ordenes-compra/${id}/pdf?auto=1`} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-lg border border-[#4FAEB2]/30 bg-white px-4 py-2 text-sm font-bold text-[#3F8E91] transition-colors hover:bg-[#4FAEB2]/10">
            <Download className="h-4 w-4" /> PDF
          </a>
          {estado === "borrador" && (
            <button onClick={() => cambiarEstado("emitida")} disabled={procesando}
              className="rounded-lg border border-[#4FAEB2]/40 bg-white px-3 py-2 text-sm font-semibold text-[#3F8E91] hover:bg-[#4FAEB2]/10 disabled:opacity-50">
              Emitir
            </button>
          )}
          {estado === "emitida" && (
            <button onClick={() => cambiarEstado("aprobada")} disabled={procesando}
              className="rounded-lg border border-[#4FAEB2]/40 bg-white px-3 py-2 text-sm font-semibold text-[#3F8E91] hover:bg-[#4FAEB2]/10 disabled:opacity-50">
              Aprobar
            </button>
          )}
          {puedeCancelar && (
            <button onClick={() => setCancelOpen(true)} disabled={procesando}
              className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50">
              Cancelar OC
            </button>
          )}
          {puedeRecibir && (
            <Link href={`/compras/desde-orden/${encodeURIComponent(cab.numero)}`}
              className="rounded-lg bg-[#4FAEB2] px-4 py-2 text-sm font-bold text-white shadow-sm shadow-[#4FAEB2]/30 hover:bg-[#3F8E91]">
              {estado === "parcialmente_recibida" ? "Recibir el resto" : "Registrar compra (recibir)"}
            </Link>
          )}
        </div>
      </div>

      {msg && <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{msg}</p>}
      {err && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>}
      {cab.observaciones && (
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
          <span className="font-semibold text-slate-700">Observación:</span> {cab.observaciones}
        </p>
      )}

      {/* Ítems */}
      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full min-w-[880px] text-sm">
          <thead className="border-b-2 border-[#4FAEB2]/40 bg-[#E5F4F4]">
            <tr>
              {["Producto", "Pedida", "Recibida", "Pendiente", "Costo unit.", "IVA", "Subtotal", "Total"].map((h, i) => (
                <th key={h} className={`px-4 py-3 text-xs font-bold uppercase tracking-wide text-[#3F8E91] ${i === 0 ? "text-left" : i === 5 ? "text-center" : "text-right"}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.map((l) => {
              const pendiente = Math.max(0, Number(l.cantidad_solicitada) - Number(l.cantidad_recibida));
              return (
                <tr key={l.id}>
                  <td className="px-4 py-3 font-medium text-slate-900">
                    {l.producto_nombre}
                    {l.sku_snapshot && <span className="ml-2 font-mono text-[11px] text-slate-400">{l.sku_snapshot}</span>}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-700">{l.cantidad_solicitada}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-emerald-700">{l.cantidad_recibida}</td>
                  <td className="px-4 py-3 text-right font-semibold tabular-nums text-amber-700">{pendiente}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-600">{fmtGs(l.costo_estimado)}</td>
                  <td className="px-4 py-3 text-center text-slate-600">{IVA_LBL[l.iva_tipo] ?? l.iva_tipo}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-600">{fmtGs(l.subtotal)}</td>
                  <td className="px-4 py-3 text-right font-semibold tabular-nums text-slate-900">{fmtGs(l.total)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-slate-200 bg-slate-50">
              <td colSpan={6} className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">Totales pedidos</td>
              <td className="px-4 py-3 text-right tabular-nums text-slate-600">{fmtGs(subtotal)}</td>
              <td className="px-4 py-3 text-right font-bold tabular-nums text-slate-900">{fmtGs(total)}</td>
            </tr>
            <tr>
              <td colSpan={8} className="px-4 py-2 text-right text-xs text-slate-500">IVA incluido: {fmtGs(totalIva)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {cancelOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm" onClick={() => !procesando && setCancelOpen(false)}>
          <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start gap-3 border-b border-slate-100 px-6 py-4">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-red-50 ring-1 ring-red-100">
                <AlertTriangle className="h-5 w-5 text-red-600" />
              </div>
              <div>
                <h2 className="text-base font-bold text-slate-900">Cancelar orden de compra</h2>
                <p className="text-sm text-slate-500">{cab.numero} · {cab.proveedor_nombre || "—"}</p>
              </div>
            </div>
            <div className="px-6 py-5">
              <p className="text-sm text-slate-600">
                La orden queda cancelada y <strong className="text-slate-800">ya no se va a poder recibir</strong>. Esta acción no se deshace.
              </p>
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-100 px-6 py-4">
              <button type="button" onClick={() => setCancelOpen(false)} disabled={procesando}
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50">Volver</button>
              <button type="button" onClick={() => cambiarEstado("cancelada")} disabled={procesando}
                className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-bold text-white hover:bg-red-700 disabled:opacity-50">
                {procesando ? <><Loader2 className="h-4 w-4 animate-spin" /> Cancelando…</> : "Sí, cancelar orden"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
