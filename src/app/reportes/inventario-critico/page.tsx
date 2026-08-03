"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import { ArrowLeft, PackageX, Loader2, Search } from "lucide-react";

type Fila = {
  producto_id: string;
  nombre: string;
  sku: string;
  stock_actual: number;
  stock_minimo: number;
  dias_cobertura: number | null;
  estado: string;
  critico_minimo: boolean;
};

const PAGE = 50;

function fmtNum(n: number) {
  return (Number(n) || 0).toLocaleString("es-PY", { maximumFractionDigits: 2 });
}

export default function InventarioCriticoPage() {
  const [filas, setFilas] = useState<Fila[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(PAGE);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      const res = await fetchWithSupabaseSession("/api/reportes/proyeccion-inventario", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "No se pudo cargar.");
      setFilas(json?.data?.filas ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al cargar.");
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    cargar();
  }, [cargar]);

  const criticos = useMemo(() => filas.filter((f) => f.critico_minimo), [filas]);
  const filtrados = useMemo(() => {
    const t = q.trim().toLowerCase();
    return criticos
      .filter((f) => t === "" || f.nombre.toLowerCase().includes(t) || f.sku.toLowerCase().includes(t))
      .sort((a, b) => (a.stock_actual - a.stock_minimo) - (b.stock_actual - b.stock_minimo));
  }, [criticos, q]);
  const visibles = filtrados.slice(0, limit);

  return (
    <div className="w-full space-y-6">
      <div>
        <Link href="/reportes" className="mb-2 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700">
          <ArrowLeft className="h-4 w-4" /> Volver a Reportes
        </Link>
        <h1 className="flex items-center gap-2.5 text-2xl font-bold text-slate-900">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-100 text-red-600">
            <PackageX className="h-5 w-5" />
          </span>
          Inventario crítico
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Productos de tu sucursal con stock igual o por debajo del mínimo.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-64 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            value={q}
            onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }}
            placeholder="Buscar producto o SKU…"
            className="w-full rounded-xl border border-slate-200 py-2.5 pl-9 pr-3 text-sm focus:border-[#4FAEB2] focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/30"
          />
        </div>
        <span className="ml-auto text-sm font-medium text-slate-600">
          {cargando ? "…" : `${criticos.length} productos críticos`}
        </span>
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
        {cargando ? (
          <div className="flex items-center justify-center gap-2 px-4 py-16 text-sm text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
          </div>
        ) : filtrados.length === 0 ? (
          <div className="px-4 py-16 text-center text-sm text-slate-400">
            {criticos.length === 0 ? "No hay productos por debajo del mínimo. 👌" : "Ningún producto coincide con la búsqueda."}
          </div>
        ) : (
          <>
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50/80 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-semibold">Producto</th>
                  <th className="px-4 py-3 font-semibold text-right">Stock actual</th>
                  <th className="px-4 py-3 font-semibold text-right">Mínimo</th>
                  <th className="px-4 py-3 font-semibold text-right">Faltante</th>
                  <th className="px-4 py-3 font-semibold text-right">Cobertura</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visibles.map((f) => {
                  const faltante = Math.max(0, f.stock_minimo - f.stock_actual);
                  return (
                    <tr key={f.producto_id} className="hover:bg-slate-50">
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-800">{f.nombre}</div>
                        <div className="text-xs text-slate-400">{f.sku}</div>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-700">{fmtNum(f.stock_actual)}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-500">{fmtNum(f.stock_minimo)}</td>
                      <td className="px-4 py-3 text-right tabular-nums font-semibold text-red-600">{fmtNum(faltante)}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-600">
                        {f.dias_cobertura == null ? "—" : `${fmtNum(f.dias_cobertura)} d`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {filtrados.length > visibles.length && (
              <div className="border-t border-slate-100 px-4 py-3 text-center">
                <button
                  onClick={() => setLimit((l) => l + PAGE)}
                  className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
                >
                  Ver más ({filtrados.length - visibles.length} restantes)
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
