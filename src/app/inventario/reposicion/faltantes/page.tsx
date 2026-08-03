"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import { ArrowLeft, PackageX, Loader2, Search, AlertTriangle } from "lucide-react";

type Faltante = {
  numero: string;
  recibida_at: string | null;
  origen_nombre: string;
  producto: string;
  sku: string;
  unidad: string;
  cantidad_despachada: number;
  cantidad_recibida: number;
  faltante: number;
};

function fmtNum(n: number) {
  return (Number(n) || 0).toLocaleString("es-PY", { maximumFractionDigits: 2 });
}
function fmtFecha(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

export default function FaltantesRecepcionPage() {
  const [rows, setRows] = useState<Faltante[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      const res = await fetchWithSupabaseSession("/api/transferencias/faltantes", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "No se pudo cargar.");
      setRows(json?.data?.faltantes ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al cargar.");
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    cargar();
  }, [cargar]);

  const visibles = useMemo(() => {
    const t = q.trim().toLowerCase();
    return rows.filter(
      (r) =>
        t === "" ||
        r.producto.toLowerCase().includes(t) ||
        r.sku.toLowerCase().includes(t) ||
        r.numero.toLowerCase().includes(t) ||
        r.origen_nombre.toLowerCase().includes(t)
    );
  }, [rows, q]);

  const totalUnidades = useMemo(() => visibles.reduce((a, r) => a + r.faltante, 0), [visibles]);

  return (
    <div className="w-full space-y-6">
      <div>
        <Link href="/inventario/reposicion/recepciones" className="mb-2 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700">
          <ArrowLeft className="h-4 w-4" /> Volver a recepciones
        </Link>
        <h1 className="flex items-center gap-2.5 text-2xl font-bold text-slate-900">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-100 text-amber-600">
            <PackageX className="h-5 w-5" />
          </span>
          Faltantes de recepción
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Productos recibidos con menos de lo despachado, para seguimiento (tu sucursal).
        </p>
      </div>

      {/* Resumen */}
      <div className="grid grid-cols-2 gap-3 sm:max-w-md">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="text-2xl font-bold tabular-nums text-amber-600">{visibles.length}</div>
          <p className="mt-1 text-xs font-medium text-slate-500">Ítems con faltante</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="text-2xl font-bold tabular-nums text-slate-800">{fmtNum(totalUnidades)}</div>
          <p className="mt-1 text-xs font-medium text-slate-500">Unidades faltantes</p>
        </div>
      </div>

      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscar por producto, SKU, TRF u origen…"
          className="w-full rounded-xl border border-slate-200 py-2.5 pl-9 pr-3 text-sm focus:border-[#4FAEB2] focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/30"
        />
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
        {cargando ? (
          <div className="flex items-center justify-center gap-2 px-4 py-16 text-sm text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
          </div>
        ) : visibles.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-500">
              <PackageX className="h-6 w-6" />
            </span>
            <p className="text-sm font-semibold text-slate-700">
              {rows.length === 0 ? "No hay faltantes registrados 👌" : "Ningún faltante coincide con la búsqueda"}
            </p>
            <p className="text-sm text-slate-400">Las recepciones donde recibiste menos de lo despachado aparecen acá.</p>
          </div>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50/80 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3 font-semibold">Producto</th>
                <th className="px-4 py-3 font-semibold">Remisión</th>
                <th className="px-4 py-3 font-semibold">Origen</th>
                <th className="px-4 py-3 font-semibold">Recibida</th>
                <th className="px-4 py-3 font-semibold text-right">Despachado</th>
                <th className="px-4 py-3 font-semibold text-right">Recibido</th>
                <th className="px-4 py-3 font-semibold text-right">Faltante</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {visibles.map((r, i) => (
                <tr key={`${r.numero}-${r.sku}-${i}`} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-800">{r.producto}</div>
                    <div className="text-xs text-slate-400">{r.sku} · {r.unidad}</div>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-600">{r.numero}</td>
                  <td className="px-4 py-3 text-slate-600">{r.origen_nombre}</td>
                  <td className="px-4 py-3 text-slate-500">{fmtFecha(r.recibida_at)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-500">{fmtNum(r.cantidad_despachada)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-700">{fmtNum(r.cantidad_recibida)}</td>
                  <td className="px-4 py-3 text-right">
                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
                      <AlertTriangle className="h-3 w-3" /> {fmtNum(r.faltante)}
                    </span>
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
