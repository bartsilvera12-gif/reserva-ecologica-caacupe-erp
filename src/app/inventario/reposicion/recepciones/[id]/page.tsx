"use client";

import { use as usePromise, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import { ArrowLeft, Truck, PackageCheck, Loader2, CheckCircle2, AlertTriangle } from "lucide-react";

type Cabecera = {
  id: string;
  numero: string;
  estado: string;
  sucursal_origen_nombre: string;
  sucursal_destino_nombre: string;
  observacion_solicitud: string | null;
  despachada_at: string | null;
  recibida_at: string | null;
  es_solicitante: boolean;
};
type ItemDet = {
  id: string;
  nombre: string;
  sku: string;
  unidad: string;
  cantidad_despachada: number;
  cantidad_recibida: number;
};

function fmtNum(n: number) {
  return (Number(n) || 0).toLocaleString("es-PY", { maximumFractionDigits: 2 });
}
function fmtFecha(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function RecepcionDetallePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = usePromise(params);
  const router = useRouter();

  const [cab, setCab] = useState<Cabecera | null>(null);
  const [items, setItems] = useState<ItemDet[]>([]);
  const [recibido, setRecibido] = useState<Record<string, string>>({});
  const [rol, setRol] = useState("");
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmando, setConfirmando] = useState(false);
  const [ok, setOk] = useState(false);

  // Confirmar recepción: admin/supervisor + el rol operativo "usuario"
  // (cajero/repositor de la sucursal destino). Mismo criterio que el backend.
  const puedeRecibir = useMemo(() => {
    const r = rol.trim().toLowerCase();
    return r === "admin" || r === "administrador" || r === "supervisor" || r === "super_admin" || r === "usuario";
  }, [rol]);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      const res = await fetchWithSupabaseSession(`/api/transferencias/${id}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "No se pudo cargar.");
      const c: Cabecera = json?.data?.cabecera ?? null;
      const its: ItemDet[] = json?.data?.items ?? [];
      setCab(c);
      setItems(its);
      // Prefill: recibís lo despachado (el receptor baja lo que falte).
      const pre: Record<string, string> = {};
      for (const it of its) pre[it.id] = String(it.cantidad_despachada);
      setRecibido(pre);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al cargar.");
    } finally {
      setCargando(false);
    }
  }, [id]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetchWithSupabaseSession("/api/usuarios/me", { cache: "no-store" });
        const json = await res.json();
        if (res.ok) setRol(json?.usuario?.rol ?? "");
      } catch {
        /* sin rol */
      }
    })();
  }, []);

  const estado = cab?.estado ?? "";
  const editable = estado === "despachada";
  const itemsDespachados = items.filter((i) => i.cantidad_despachada > 0);

  const totales = useMemo(() => {
    let desp = 0;
    let rec = 0;
    for (const it of itemsDespachados) {
      desp += it.cantidad_despachada;
      rec += editable ? Number(recibido[it.id]) || 0 : it.cantidad_recibida;
    }
    return { desp, rec, faltante: Math.max(0, desp - rec) };
  }, [itemsDespachados, recibido, editable]);

  function setTodo(full: boolean) {
    const next: Record<string, string> = {};
    for (const it of itemsDespachados) next[it.id] = full ? String(it.cantidad_despachada) : "0";
    setRecibido(next);
  }

  async function confirmar() {
    if (!window.confirm("¿Confirmar la recepción? Esto suma a tu stock las cantidades recibidas.")) return;
    setConfirmando(true);
    setError(null);
    try {
      const recepciones = itemsDespachados.map((it) => {
        const val = Math.max(0, Math.min(Number(recibido[it.id]) || 0, it.cantidad_despachada));
        return { item_id: it.id, cantidad_recibida: val };
      });
      const res = await fetchWithSupabaseSession(`/api/transferencias/${id}/recibir`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recepciones }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "No se pudo confirmar.");
      setOk(true);
      setTimeout(() => router.push("/inventario/reposicion/recepciones"), 900);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al confirmar.");
      setConfirmando(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <div>
        <Link href="/inventario/reposicion/recepciones" className="mb-2 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700">
          <ArrowLeft className="h-4 w-4" /> Volver a recepciones
        </Link>
        <h1 className="flex flex-wrap items-center gap-2.5 text-2xl font-bold text-slate-900">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-100 text-indigo-600">
            <Truck className="h-5 w-5" />
          </span>
          Recepción {cab?.numero ?? ""}
          {estado === "despachada" && (
            <span className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-semibold text-indigo-700">
              <Truck className="h-3 w-3" /> En tránsito
            </span>
          )}
          {estado === "recibida" && (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">
              <CheckCircle2 className="h-3 w-3" /> Recibida
            </span>
          )}
        </h1>
        {cab && (
          <p className="mt-1 text-sm text-slate-500">
            Desde <span className="font-medium text-slate-700">{cab.sucursal_origen_nombre}</span> → {cab.sucursal_destino_nombre}
            {cab.despachada_at ? ` · despachada ${fmtFecha(cab.despachada_at)}` : ""}
          </p>
        )}
      </div>

      {ok && (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-700">
          <CheckCircle2 className="h-5 w-5" /> Recepción confirmada. Redirigiendo…
        </div>
      )}
      {error && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      {cargando ? (
        <div className="flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-16 text-sm text-slate-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
        </div>
      ) : !cab ? (
        <div className="rounded-2xl border border-slate-200 bg-white px-6 py-16 text-center text-sm text-slate-400">No se encontró la transferencia.</div>
      ) : !editable ? (
        // No está en tránsito: o ya se recibió (muestra control) o no está lista.
        estado === "recibida" ? (
          <ControlRecibida items={itemsDespachados} recibidaAt={cab.recibida_at} />
        ) : (
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-slate-200 bg-white px-6 py-14 text-center">
            <AlertTriangle className="h-8 w-8 text-amber-400" />
            <p className="text-sm font-semibold text-slate-700">Esta transferencia todavía no está para recibir</p>
            <p className="text-sm text-slate-400">Solo se puede recibir cuando la sucursal de origen la despacha (estado “En tránsito”).</p>
          </div>
        )
      ) : (
        <>
          {cab.observacion_solicitud && (
            <div className="flex items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-600">
              <span className="mt-0.5 shrink-0 text-slate-400">✎</span>
              <span>{cab.observacion_solicitud}</span>
            </div>
          )}

          {/* Resumen + progreso */}
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-slate-800">Verificá lo que llegó</p>
                <p className="mt-0.5 text-xs text-slate-400">Ajustá la cantidad recibida si falta algo. El resto queda como faltante.</p>
              </div>
              <div className="flex gap-2">
                <button onClick={() => setTodo(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-700 transition-colors hover:bg-emerald-100">
                  <CheckCircle2 className="h-4 w-4" /> Recibir todo
                </button>
                <button onClick={() => setTodo(false)} className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-500 transition-colors hover:bg-slate-50">
                  Poner en 0
                </button>
              </div>
            </div>
            <div className="mt-4">
              <div className="mb-1.5 flex items-center justify-between text-xs">
                <span className="text-slate-500">{fmtNum(totales.rec)} de {fmtNum(totales.desp)} unidades</span>
                <span className={totales.faltante > 0 ? "font-semibold text-amber-600" : "font-semibold text-emerald-600"}>
                  {totales.faltante > 0 ? `Faltan ${fmtNum(totales.faltante)}` : "Completo"}
                </span>
              </div>
              <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${totales.faltante > 0 ? "bg-amber-400" : "bg-emerald-500"}`}
                  style={{ width: `${totales.desp > 0 ? Math.min(100, Math.round((totales.rec / totales.desp) * 100)) : 0}%` }}
                />
              </div>
            </div>
          </div>

          {/* Tabla de control */}
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50/80 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-5 py-3 font-semibold">Producto</th>
                  <th className="px-5 py-3 font-semibold text-center">Despachado</th>
                  <th className="px-5 py-3 font-semibold text-center">Recibido</th>
                  <th className="px-5 py-3 font-semibold text-right">Diferencia</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {itemsDespachados.map((it) => {
                  const rec = Number(recibido[it.id]) || 0;
                  const falta = Math.max(0, it.cantidad_despachada - rec);
                  const excede = rec > it.cantidad_despachada;
                  return (
                    <tr key={it.id} className={falta > 0 ? "bg-amber-50/40" : excede ? "bg-red-50/40" : ""}>
                      <td className="px-5 py-3.5">
                        <div className="font-medium text-slate-800">{it.nombre}</div>
                        <div className="text-xs text-slate-400">{it.sku} · {it.unidad}</div>
                      </td>
                      <td className="px-5 py-3.5 text-center tabular-nums text-slate-500">{fmtNum(it.cantidad_despachada)}</td>
                      <td className="px-5 py-3.5">
                        <div className="flex justify-center">
                          <input
                            type="number" min={0} max={it.cantidad_despachada} step="any"
                            value={recibido[it.id] ?? ""}
                            onChange={(e) => setRecibido((p) => ({ ...p, [it.id]: e.target.value }))}
                            className={`w-24 rounded-lg border px-2 py-1.5 text-center text-base font-semibold tabular-nums focus:outline-none focus:ring-2 ${
                              excede ? "border-red-300 bg-red-50 text-red-700 focus:ring-red-200"
                                : falta > 0 ? "border-amber-300 focus:ring-amber-200"
                                : "border-slate-200 focus:ring-emerald-400/40"
                            }`}
                          />
                        </div>
                      </td>
                      <td className="px-5 py-3.5 text-right">
                        {excede ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">
                            <AlertTriangle className="h-3 w-3" /> +{fmtNum(rec - it.cantidad_despachada)}
                          </span>
                        ) : falta > 0 ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
                            Falta {fmtNum(falta)}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                            <CheckCircle2 className="h-3 w-3" /> OK
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-200 bg-slate-50/70 font-semibold text-slate-700">
                  <td className="px-5 py-3">Totales</td>
                  <td className="px-5 py-3 text-center tabular-nums">{fmtNum(totales.desp)}</td>
                  <td className="px-5 py-3 text-center tabular-nums">{fmtNum(totales.rec)}</td>
                  <td className="px-5 py-3 text-right tabular-nums">
                    {totales.faltante > 0 ? <span className="text-amber-700">Falta {fmtNum(totales.faltante)}</span> : <span className="text-emerald-700">Completo</span>}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Barra de acción fija */}
          <div className="sticky bottom-4 z-10 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white/95 px-4 py-3 shadow-lg backdrop-blur">
            <div className="text-sm">
              {totales.faltante > 0 ? (
                <span className="flex items-center gap-1.5 text-amber-700"><AlertTriangle className="h-4 w-4 shrink-0" /> {fmtNum(totales.faltante)} en faltante — no suma a stock</span>
              ) : (
                <span className="flex items-center gap-1.5 text-emerald-700"><CheckCircle2 className="h-4 w-4 shrink-0" /> Todo lo despachado será recibido</span>
              )}
            </div>
            <div className="flex items-center gap-3">
              {!puedeRecibir && <span className="text-xs text-slate-400">No tenés permiso para confirmar recepciones.</span>}
              <button onClick={confirmar} disabled={confirmando || ok || !puedeRecibir}
                className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm shadow-emerald-600/20 transition-all hover:bg-emerald-700 hover:shadow-md active:scale-95 disabled:opacity-50">
                {confirmando ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackageCheck className="h-4 w-4" />}
                Confirmar recepción
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── Vista de control de una transferencia ya recibida ────────────────────────
function ControlRecibida({ items, recibidaAt }: { items: ItemDet[]; recibidaAt: string | null }) {
  const hayFaltantes = items.some((i) => i.cantidad_recibida < i.cantidad_despachada);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-700">
        <CheckCircle2 className="h-5 w-5" /> Recibida el {fmtFecha(recibidaAt)}
      </div>
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50/80 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-5 py-3 font-semibold">Producto</th>
              <th className="px-5 py-3 font-semibold text-right">Despachado</th>
              <th className="px-5 py-3 font-semibold text-right">Recibido</th>
              <th className="px-5 py-3 font-semibold text-right">Diferencia</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.map((it) => {
              const falta = Math.max(0, it.cantidad_despachada - it.cantidad_recibida);
              return (
                <tr key={it.id}>
                  <td className="px-5 py-3">
                    <div className="font-medium text-slate-800">{it.nombre}</div>
                    <div className="text-xs text-slate-400">{it.sku} · {it.unidad}</div>
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums text-slate-500">{fmtNum(it.cantidad_despachada)}</td>
                  <td className="px-5 py-3 text-right tabular-nums text-slate-700">{fmtNum(it.cantidad_recibida)}</td>
                  <td className="px-5 py-3 text-right">
                    {falta > 0 ? (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">Faltó {fmtNum(falta)}</span>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {hayFaltantes && (
        <p className="text-sm text-amber-700">Esta recepción tuvo faltantes respecto de lo despachado.</p>
      )}
    </div>
  );
}
