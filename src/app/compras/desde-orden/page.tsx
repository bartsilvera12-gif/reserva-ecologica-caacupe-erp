"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import { Loader2, Search } from "lucide-react";

type Oc = { id: string; numero: string; proveedor_nombre: string; estado: string; fecha: string; items_count: number; total_pendiente: number };

function fmtGs(v: number) { return "Gs. " + Math.round(Number(v) || 0).toLocaleString("es-PY"); }
function fmtFecha(iso: string) {
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return "—";
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}
const RECEPTIBLES = ["emitida", "aprobada", "parcialmente_recibida"];

export default function DesdeOrdenPickerPage() {
  const [ocs, setOcs] = useState<Oc[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const cargar = useCallback(async () => {
    setCargando(true); setError(null);
    try {
      const res = await fetchWithSupabaseSession("/api/ordenes-compra", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "No se pudo cargar.");
      setOcs(((json?.data?.ordenes ?? []) as Oc[]).filter((o) => RECEPTIBLES.includes(o.estado)));
    } catch (e) { setError(e instanceof Error ? e.message : "Error."); }
    finally { setCargando(false); }
  }, []);
  useEffect(() => { cargar(); }, [cargar]);

  const visibles = useMemo(() => {
    const t = q.trim().toLowerCase();
    return ocs.filter((o) => t === "" || o.numero.toLowerCase().includes(t) || o.proveedor_nombre.toLowerCase().includes(t));
  }, [ocs, q]);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/compras" className="mb-2 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-[#3F8E91]">← Volver a Compras</Link>
        <h1 className="text-lg font-semibold tracking-tight text-slate-900">Registrar compra desde una orden</h1>
        <p className="mt-0.5 text-xs text-slate-500">Elegí una orden de compra pendiente y confirmá lo que llegó. Se crea la compra solo con lo recibido.</p>
      </div>

      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por N° OC o proveedor…"
          className="w-full rounded-lg border border-slate-200 py-2.5 pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-[#4FAEB2]/40" />
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
        {cargando ? (
          <div className="flex items-center justify-center gap-2 px-4 py-16 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /> Cargando…</div>
        ) : visibles.length === 0 ? (
          <div className="px-4 py-16 text-center text-sm text-slate-400">No hay órdenes de compra pendientes de recibir.</div>
        ) : (
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-b-2 border-[#4FAEB2]/40 bg-[#E5F4F4]">
              <tr>
                {["N° OC", "Fecha", "Proveedor", "Ítems", "Pendiente (Gs.)", "Estado", ""].map((h, i) => (
                  <th key={h || i} className={`px-3 py-2.5 text-xs font-bold uppercase tracking-wide text-[#3F8E91] ${i === 3 || i === 4 ? "text-right" : i === 5 || i === 6 ? "text-center" : "text-left"}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {visibles.map((o) => (
                <tr key={o.id} className="transition-colors hover:bg-[#4FAEB2]/5">
                  <td className="px-3 py-2.5 font-mono text-xs font-semibold text-[#3F8E91]">{o.numero}</td>
                  <td className="px-3 py-2.5 text-xs tabular-nums text-slate-600">{fmtFecha(o.fecha)}</td>
                  <td className="px-3 py-2.5 text-xs font-medium text-slate-800">{o.proveedor_nombre || "—"}</td>
                  <td className="px-3 py-2.5 text-right text-xs tabular-nums text-slate-600">{o.items_count}</td>
                  <td className="px-3 py-2.5 text-right text-xs tabular-nums font-bold text-slate-900">{fmtGs(o.total_pendiente)}</td>
                  <td className="px-3 py-2.5 text-center">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${o.estado === "parcialmente_recibida" ? "bg-sky-100 text-sky-700" : "bg-amber-100 text-amber-800"}`}>
                      {o.estado === "parcialmente_recibida" ? "Recibida parcial" : "Pendiente"}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    <Link href={`/compras/desde-orden/${encodeURIComponent(o.numero)}`} className="rounded-lg bg-[#4FAEB2] px-3 py-1.5 text-xs font-bold text-white transition-colors hover:bg-[#3F8E91]">Confirmar recepción</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
