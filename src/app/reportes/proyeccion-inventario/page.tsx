"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import { ArrowLeft, TrendingDown, Loader2, Search } from "lucide-react";

type Fila = {
  producto_id: string;
  nombre: string;
  sku: string;
  stock_actual: number;
  stock_minimo: number;
  unidades_30: number;
  promedio_diario: number;
  dias_cobertura: number | null;
  fecha_quiebre: string | null;
  estado: string;
  critico_minimo: boolean;
};

const ESTADO: Record<string, { label: string; cls: string; orden: number }> = {
  inconsistente: { label: "Stock inconsistente", cls: "bg-rose-100 text-rose-700", orden: 0 },
  sin_stock: { label: "Sin stock", cls: "bg-red-100 text-red-700", orden: 1 },
  critico: { label: "Crítico", cls: "bg-red-100 text-red-700", orden: 2 },
  alto: { label: "Alto", cls: "bg-amber-100 text-amber-800", orden: 3 },
  medio: { label: "Medio", cls: "bg-yellow-100 text-yellow-800", orden: 4 },
  estable: { label: "Estable", cls: "bg-emerald-100 text-emerald-700", orden: 5 },
  sin_consumo: { label: "Sin consumo reciente", cls: "bg-slate-100 text-slate-500", orden: 6 },
};

function fmtNum(n: number) {
  return (Number(n) || 0).toLocaleString("es-PY", { maximumFractionDigits: 2 });
}
function fmtFecha(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return d && m && y ? `${d}/${m}/${y}` : iso;
}

export default function ProyeccionInventarioPage() {
  const [filas, setFilas] = useState<Fila[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [soloRiesgo, setSoloRiesgo] = useState(false);

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

  const visibles = useMemo(() => {
    const t = q.trim().toLowerCase();
    return filas
      .filter((f) => (t === "" || f.nombre.toLowerCase().includes(t) || f.sku.toLowerCase().includes(t)))
      .filter((f) => (!soloRiesgo ? true : ["critico", "alto", "sin_stock", "inconsistente"].includes(f.estado)))
      .sort((a, b) => {
        // Menor cobertura primero; los sin cobertura calculable, según orden de estado.
        const oa = ESTADO[a.estado]?.orden ?? 9;
        const ob = ESTADO[b.estado]?.orden ?? 9;
        if (oa !== ob) return oa - ob;
        const ca = a.dias_cobertura ?? Infinity;
        const cb = b.dias_cobertura ?? Infinity;
        return ca - cb;
      });
  }, [filas, q, soloRiesgo]);

  return (
    <div className="w-full space-y-6">
      <div>
        <Link href="/reportes" className="mb-2 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700">
          <ArrowLeft className="h-4 w-4" /> Volver a Reportes
        </Link>
        <h1 className="flex items-center gap-2.5 text-2xl font-bold text-slate-900">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-100 text-amber-600">
            <TrendingDown className="h-5 w-5" />
          </span>
          Proyección de inventario
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Días de cobertura y fecha estimada de quiebre según el consumo de los últimos 30 días (tu sucursal).
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-64 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar producto o SKU…"
            className="w-full rounded-xl border border-slate-200 py-2.5 pl-9 pr-3 text-sm focus:border-[#4FAEB2] focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/30"
          />
        </div>
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={soloRiesgo} onChange={(e) => setSoloRiesgo(e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
          Solo en riesgo
        </label>
        <span className="ml-auto text-sm text-slate-400">{visibles.length} productos</span>
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
        {cargando ? (
          <div className="flex items-center justify-center gap-2 px-4 py-16 text-sm text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" /> Calculando proyección…
          </div>
        ) : visibles.length === 0 ? (
          <div className="px-4 py-16 text-center text-sm text-slate-400">Sin productos para mostrar.</div>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50/80 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3 font-semibold">Producto</th>
                <th className="px-4 py-3 font-semibold text-right">Stock</th>
                <th className="px-4 py-3 font-semibold text-right">Mínimo</th>
                <th className="px-4 py-3 font-semibold text-right">Vendido 30d</th>
                <th className="px-4 py-3 font-semibold text-right">Prom/día</th>
                <th className="px-4 py-3 font-semibold text-right">Cobertura</th>
                <th className="px-4 py-3 font-semibold">Quiebre estimado</th>
                <th className="px-4 py-3 font-semibold">Estado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {visibles.map((f) => {
                const e = ESTADO[f.estado] ?? { label: f.estado, cls: "bg-slate-100 text-slate-600" };
                return (
                  <tr key={f.producto_id} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-800">{f.nombre}</div>
                      <div className="text-xs text-slate-400">{f.sku}</div>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-700">{fmtNum(f.stock_actual)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-500">{fmtNum(f.stock_minimo)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-600">{fmtNum(f.unidades_30)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-600">{fmtNum(f.promedio_diario)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-700">
                      {f.dias_cobertura == null ? "—" : `${fmtNum(f.dias_cobertura)} d`}
                    </td>
                    <td className="px-4 py-3 text-slate-600">{fmtFecha(f.fecha_quiebre)}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${e.cls}`}>{e.label}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
