"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import { Search, Loader2, Plus } from "lucide-react";

type OcRow = {
  id: string; numero: string; proveedor_nombre: string; estado: string; moneda: string;
  fecha: string; llegada_estimada: string | null; tipo_pago: string; plazo_dias: number | null;
  items_count: number; total: number; total_pendiente: number;
};

const ESTADO: Record<string, { label: string; cls: string }> = {
  borrador: { label: "Borrador", cls: "bg-slate-100 text-slate-600" },
  emitida: { label: "Emitida", cls: "bg-amber-100 text-amber-800" },
  aprobada: { label: "Aprobada", cls: "bg-[#4FAEB2]/15 text-[#3F8E91]" },
  parcialmente_recibida: { label: "Recibida parcial", cls: "bg-sky-100 text-sky-700" },
  recibida: { label: "Recibida total", cls: "bg-emerald-100 text-emerald-700" },
  cancelada: { label: "Cancelada", cls: "bg-slate-100 text-slate-500" },
};
/** Estados de OC que están pendientes de recibir (aparecen en "por confirmar"). */
const RECEPTIBLES = ["emitida", "aprobada", "parcialmente_recibida"];

function fmtGs(n: number, m = "PYG") { return (m === "USD" ? "USD " : "Gs. ") + Math.round(Number(n) || 0).toLocaleString("es-PY"); }
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
  const router = useRouter();
  const [ordenes, setOrdenes] = useState<OcRow[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busqueda, setBusqueda] = useState("");
  const [filtroEstado, setFiltroEstado] = useState("");

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

  // Deep-link ?abrir=<id> (desde la card "por confirmar") → detalle en su página.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("abrir");
    if (id) router.replace(`/compras/ordenes/${id}`);
  }, [router]);

  const filtradas = useMemo(() => {
    const t = busqueda.trim().toLowerCase();
    return ordenes.filter((o) =>
      (filtroEstado === "" || o.estado === filtroEstado) &&
      (t === "" || o.numero.toLowerCase().includes(t) || o.proveedor_nombre.toLowerCase().includes(t))
    );
  }, [ordenes, busqueda, filtroEstado]);

  return (
    <div className="space-y-8">
      <div>
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-[#4FAEB2]" style={{ boxShadow: "0 0 0 3px rgba(79, 174, 178, 0.18)" }} />
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#4FAEB2]">Zentra · Adquisiciones</p>
        </div>
        <h1 className="mt-1 text-lg font-semibold tracking-tight text-slate-900">Compras</h1>
        <p className="mt-0.5 text-xs text-slate-500">Órdenes de compra a proveedores (sin factura, sin impacto en stock)</p>
      </div>

      {/* Navegación del módulo Compras */}
      <div className="flex flex-wrap items-center gap-1 border-b border-slate-200">
        <Link href="/compras" className="border-b-2 border-transparent px-4 py-2 text-sm font-medium text-slate-500 transition-colors hover:text-[#3F8E91]">Compras</Link>
        <span className="border-b-2 border-[#4FAEB2] px-4 py-2 text-sm font-semibold text-[#3F8E91]">Órdenes de compra</span>
        <Link href="/compras/notas-credito" className="border-b-2 border-transparent px-4 py-2 text-sm font-medium text-slate-500 transition-colors hover:text-[#3F8E91]">NC Proveedor</Link>
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm ring-1 ring-[#4FAEB2]/15 sm:p-5 lg:p-6">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-semibold">Órdenes de compra</h2>
          <Link href="/compras/ordenes/nueva" className="inline-flex items-center gap-1.5 rounded-lg bg-[#4FAEB2] px-3 py-1.5 text-xs font-semibold text-white shadow-sm shadow-[#4FAEB2]/25 transition-colors hover:bg-[#3F8E91] active:scale-95">
            <Plus className="h-3.5 w-3.5" /> Nueva orden de compra
          </Link>
        </div>

        <div className="mb-5 flex flex-wrap items-center gap-3 border-b border-gray-100 pb-5">
          <div className="relative min-w-0 flex-1 sm:min-w-72">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input value={busqueda} onChange={(e) => setBusqueda(e.target.value)} placeholder="Buscar por N° OC o proveedor…"
              className="w-full rounded-lg border border-slate-200 py-2 pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-[#4FAEB2]/40" />
          </div>
          <select value={filtroEstado} onChange={(e) => setFiltroEstado(e.target.value)}
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#4FAEB2]/40">
            <option value="">Todos los estados</option>
            <option value="borrador">Borrador</option>
            <option value="emitida">Emitida</option>
            <option value="aprobada">Aprobada</option>
            <option value="parcialmente_recibida">Recibida parcial</option>
            <option value="recibida">Recibida total</option>
            <option value="cancelada">Cancelada</option>
          </select>
          <span className="ml-auto text-sm text-gray-400">{filtradas.length} de {ordenes.length} órdenes</span>
        </div>

        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-b-2 border-[#4FAEB2]/40 bg-[#E5F4F4]">
              <tr>
                {["N° OC", "Fecha", "Proveedor", "Ítems", "Total", "Estado", ""].map((h, i) => (
                  <th key={h || i} className={`px-3 py-2.5 text-xs font-bold uppercase tracking-wide text-[#3F8E91] ${i === 3 || i === 4 ? "text-right" : i === 5 || i === 6 ? "text-center" : "text-left"}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {cargando ? (
                <tr><td colSpan={7} className="px-3 py-14 text-center text-sm text-slate-400"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>
              ) : filtradas.length === 0 ? (
                <tr><td colSpan={7} className="px-3 py-14 text-center text-sm text-slate-400">{ordenes.length === 0 ? "Todavía no hay órdenes de compra." : "Ninguna orden coincide con los filtros."}</td></tr>
              ) : (
                filtradas.map((o) => (
                  <tr key={o.id} className="cursor-pointer transition-colors hover:bg-[#4FAEB2]/5" onClick={() => router.push(`/compras/ordenes/${o.id}`)}>
                    <td className="px-3 py-2.5 font-mono text-xs font-semibold text-[#3F8E91]">{o.numero}</td>
                    <td className="px-3 py-2.5 text-xs tabular-nums text-slate-600">{fmtFecha(o.fecha)}</td>
                    <td className="px-3 py-2.5 text-xs font-medium text-slate-800">{o.proveedor_nombre || "—"}</td>
                    <td className="px-3 py-2.5 text-right text-xs tabular-nums text-slate-600">{o.items_count}</td>
                    <td className="px-3 py-2.5 text-right text-xs font-bold tabular-nums text-slate-900">{fmtGs(o.total, o.moneda)}</td>
                    <td className="px-3 py-2.5 text-center"><Badge estado={o.estado} /></td>
                    <td className="px-3 py-2.5 text-center" onClick={(e) => e.stopPropagation()}>
                      <div className="inline-flex items-center gap-3">
                        <Link href={`/compras/ordenes/${o.id}`} className="text-xs font-semibold text-slate-500 hover:text-[#3F8E91] hover:underline">Ver</Link>
                        {RECEPTIBLES.includes(o.estado) && (
                          <Link href={`/compras/desde-orden/${encodeURIComponent(o.numero)}`} className="rounded-lg bg-[#4FAEB2] px-3 py-1.5 text-xs font-bold text-white transition-colors hover:bg-[#3F8E91]">Recibir</Link>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
