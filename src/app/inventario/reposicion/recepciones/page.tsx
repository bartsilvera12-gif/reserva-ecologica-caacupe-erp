"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import { ArrowLeft, Truck, PackageCheck, ChevronRight, Loader2, Inbox } from "lucide-react";

type Row = {
  id: string;
  numero: string;
  estado: string;
  sucursal_origen_nombre: string;
  sucursal_destino_nombre: string;
  items_count: number;
  solicitada_at: string;
  despachada_at: string | null;
  recibida_at: string | null;
};

function fmtFecha(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function RecepcionesPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      // filtro=realizadas = transferencias donde mi sucursal es el destino (quien recibe).
      const res = await fetchWithSupabaseSession("/api/transferencias?filtro=realizadas", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "No se pudo cargar.");
      setRows(json?.data?.transferencias ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al cargar.");
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    cargar();
  }, [cargar]);

  const paraRecibir = rows.filter((r) => r.estado === "despachada");
  const recibidas = rows.filter((r) => r.estado === "recibida").slice(0, 20);

  return (
    <div className="w-full space-y-6">
      <div>
        <Link href="/inventario/reposicion" className="mb-2 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700">
          <ArrowLeft className="h-4 w-4" /> Volver a Reposición
        </Link>
        <h1 className="flex items-center gap-2.5 text-2xl font-bold text-slate-900">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-100 text-indigo-600">
            <Truck className="h-5 w-5" />
          </span>
          Recepción de mercadería
        </h1>
        <p className="mt-1 text-sm text-slate-500">Controlá y confirmá lo que llega desde otra sucursal, producto por producto.</p>
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      {/* Para recibir */}
      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          <Inbox className="h-4 w-4" /> Para recibir
          {paraRecibir.length > 0 && (
            <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-bold text-indigo-700">{paraRecibir.length}</span>
          )}
        </h2>

        {cargando ? (
          <div className="flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-16 text-sm text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
          </div>
        ) : paraRecibir.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-slate-200 bg-white px-6 py-14 text-center">
            <PackageCheck className="h-8 w-8 text-emerald-400" />
            <p className="text-sm font-semibold text-slate-700">No hay mercadería en camino</p>
            <p className="text-sm text-slate-400">Cuando otra sucursal despache una solicitud tuya, aparece acá para que la recibas.</p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {paraRecibir.map((r) => (
              <Link
                key={r.id}
                href={`/inventario/reposicion/recepciones/${r.id}`}
                className="group flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition-all hover:border-indigo-300 hover:shadow-md"
              >
                <div className="flex items-center justify-between">
                  <span className="font-bold tabular-nums text-slate-800">{r.numero}</span>
                  <span className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-semibold text-indigo-800">
                    <Truck className="h-3 w-3" /> En tránsito
                  </span>
                </div>
                <div className="text-sm text-slate-600">
                  Desde <span className="font-medium text-slate-800">{r.sucursal_origen_nombre}</span>
                </div>
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span>{r.items_count} {r.items_count === 1 ? "producto" : "productos"} · despachada {fmtFecha(r.despachada_at)}</span>
                  <span className="flex items-center gap-1 font-medium text-indigo-600 group-hover:gap-1.5">
                    Recibir <ChevronRight className="h-4 w-4 transition-all" />
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Historial reciente */}
      {recibidas.length > 0 && (
        <section className="space-y-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
            <PackageCheck className="h-4 w-4" /> Recibidas recientemente
          </h2>
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50/80 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-5 py-3 font-semibold">Número</th>
                  <th className="px-5 py-3 font-semibold">Origen</th>
                  <th className="px-5 py-3 font-semibold text-center">Ítems</th>
                  <th className="px-5 py-3 font-semibold">Recibida</th>
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {recibidas.map((r) => (
                  <tr key={r.id} className="transition-colors hover:bg-slate-50">
                    <td className="px-5 py-3 font-semibold tabular-nums text-slate-800">{r.numero}</td>
                    <td className="px-5 py-3 text-slate-600">{r.sucursal_origen_nombre}</td>
                    <td className="px-5 py-3 text-center tabular-nums text-slate-600">{r.items_count}</td>
                    <td className="px-5 py-3 text-slate-500">{fmtFecha(r.recibida_at)}</td>
                    <td className="px-5 py-3 text-right">
                      <Link href={`/inventario/reposicion/recepciones/${r.id}`} className="text-sm font-medium text-[#4FAEB2] hover:underline">
                        Ver control
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
