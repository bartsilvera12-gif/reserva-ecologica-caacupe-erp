"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import { X, AlertTriangle, Loader2, Plus, Trash2, CalendarClock } from "lucide-react";
import {
  validarPlanCuotas,
  generarCuotasIguales,
  derivarEstadoCuotas,
  type CuotaPlanInput,
} from "@/lib/cuotas/cuotas-domain";

export type TipoCuentaUI = "cobrar" | "pagar";

interface Props {
  tipo: TipoCuentaUI;
  cuentaId: string;
  /** Monto total de la deuda (objetivo del plan). */
  montoTotal: number;
  moneda?: string;
  /** Texto identificador (cliente/proveedor + factura). */
  titulo: string;
  onClose: () => void;
  onSaved?: () => void;
}

const ACCENT = "#4FAEB2";

function fmtGs(n: number, moneda = "PYG") {
  return (moneda === "USD" ? "USD " : "Gs. ") + Math.round(Number(n) || 0).toLocaleString("es-PY");
}
function hoyISO() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Asuncion" });
}
function estadoChip(estado: string) {
  if (estado === "pagada") return <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">Pagada</span>;
  if (estado === "parcial") return <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-semibold text-sky-700">Parcial</span>;
  return <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">Pendiente</span>;
}

export default function ProgramarCuotasModal({ tipo, cuentaId, montoTotal, moneda = "PYG", titulo, onClose, onSaved }: Props) {
  const [cuotas, setCuotas] = useState<CuotaPlanInput[]>([]);
  const [pagado, setPagado] = useState(0);
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tienePlan, setTienePlan] = useState(false);

  // Atajo "dividir en N iguales".
  const [nCuotas, setNCuotas] = useState(3);
  const [primerVenc, setPrimerVenc] = useState(hoyISO());
  const [periodicidad, setPeriodicidad] = useState(30);

  const cargar = useCallback(async () => {
    setCargando(true);
    setErr(null);
    try {
      const res = await fetchWithSupabaseSession(`/api/cuotas?tipo=${tipo}&cuentaId=${encodeURIComponent(cuentaId)}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "No se pudo cargar el plan.");
      const data = json?.data ?? {};
      const existentes: CuotaPlanInput[] = (data.cuotas ?? []).map((c: CuotaPlanInput) => ({
        numero_cuota: c.numero_cuota, monto: c.monto, fecha_vencimiento: c.fecha_vencimiento,
      }));
      setPagado(Number(data.pagado) || 0);
      setTienePlan(existentes.length > 0);
      setCuotas(existentes.length > 0 ? existentes : generarCuotasIguales(montoTotal, 3, hoyISO(), 30));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error al cargar.");
    } finally {
      setCargando(false);
    }
  }, [tipo, cuentaId, montoTotal]);

  useEffect(() => { cargar(); }, [cargar]);

  const suma = useMemo(() => cuotas.reduce((a, c) => a + (Number(c.monto) || 0), 0), [cuotas]);
  const validacion = useMemo(() => validarPlanCuotas(montoTotal, cuotas), [montoTotal, cuotas]);
  const derivadas = useMemo(() => derivarEstadoCuotas(cuotas, pagado), [cuotas, pagado]);

  function renumerar(arr: CuotaPlanInput[]): CuotaPlanInput[] {
    return arr.map((c, i) => ({ ...c, numero_cuota: i + 1 }));
  }
  function generarIguales() {
    const g = generarCuotasIguales(montoTotal, Math.max(1, nCuotas), primerVenc, Math.max(1, periodicidad));
    if (g.length === 0) { setErr("No se pudo generar (revisá monto, cantidad y fecha)."); return; }
    setErr(null);
    setCuotas(g);
  }
  function setMonto(i: number, val: string) {
    setCuotas((prev) => prev.map((c, idx) => (idx === i ? { ...c, monto: Number(val) || 0 } : c)));
  }
  function setFecha(i: number, val: string) {
    setCuotas((prev) => prev.map((c, idx) => (idx === i ? { ...c, fecha_vencimiento: val } : c)));
  }
  function agregar() {
    setCuotas((prev) => renumerar([...prev, { numero_cuota: prev.length + 1, monto: 0, fecha_vencimiento: primerVenc }]));
  }
  function quitar(i: number) {
    setCuotas((prev) => renumerar(prev.filter((_, idx) => idx !== i)));
  }

  async function guardar() {
    setErr(null);
    const v = validarPlanCuotas(montoTotal, cuotas);
    if (!v.ok) { setErr(v.error); return; }
    setGuardando(true);
    try {
      const res = await fetchWithSupabaseSession(`/api/cuotas`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tipo, cuentaId, cuotas: renumerar(cuotas) }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "No se pudo guardar.");
      onSaved?.();
      onClose();
    } catch (e) {
      setGuardando(false);
      setErr(e instanceof Error ? e.message : "Error al guardar el plan.");
    }
  }

  async function quitarPlan() {
    setGuardando(true);
    setErr(null);
    try {
      const res = await fetchWithSupabaseSession(`/api/cuotas?tipo=${tipo}&cuentaId=${encodeURIComponent(cuentaId)}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "No se pudo eliminar.");
      onSaved?.();
      onClose();
    } catch (e) {
      setGuardando(false);
      setErr(e instanceof Error ? e.message : "Error al eliminar el plan.");
    }
  }

  const sumaOk = validacion.ok;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:items-center">
      <div className="my-8 w-full max-w-xl rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-900">
            <CalendarClock className="h-5 w-5" style={{ color: ACCENT }} /> Programar cuotas
          </h2>
          <button onClick={onClose} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"><X className="h-5 w-5" /></button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
            {titulo}
            <div className="mt-0.5 flex flex-wrap gap-x-4 text-xs">
              <span>Total a programar: <span className="font-semibold text-slate-800">{fmtGs(montoTotal, moneda)}</span></span>
              {pagado > 0 && <span>Ya {tipo === "pagar" ? "pagado" : "cobrado"}: <span className="font-semibold text-slate-800">{fmtGs(pagado, moneda)}</span> (imputado a las primeras cuotas)</span>}
            </div>
          </div>

          {cargando ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /> Cargando…</div>
          ) : (
            <>
              {/* Atajo dividir en N iguales */}
              <div className="flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 p-3">
                <label className="flex flex-col gap-1 text-xs text-slate-600">Cuotas
                  <input type="number" min={1} max={60} value={nCuotas} onChange={(e) => setNCuotas(Number(e.target.value) || 1)} className="w-16 rounded-lg border border-slate-200 px-2 py-1.5 text-sm" />
                </label>
                <label className="flex flex-col gap-1 text-xs text-slate-600">1er vencimiento
                  <input type="date" value={primerVenc} onChange={(e) => setPrimerVenc(e.target.value)} className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm" />
                </label>
                <label className="flex flex-col gap-1 text-xs text-slate-600">Cada (días)
                  <input type="number" min={1} max={365} value={periodicidad} onChange={(e) => setPeriodicidad(Number(e.target.value) || 30)} className="w-20 rounded-lg border border-slate-200 px-2 py-1.5 text-sm" />
                </label>
                <button onClick={generarIguales} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50">Dividir en iguales</button>
              </div>

              {/* Tabla editable de cuotas */}
              <div className="overflow-hidden rounded-lg border border-slate-200">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                    <tr>
                      <th className="px-2 py-2 text-left font-semibold">#</th>
                      <th className="px-2 py-2 text-left font-semibold">Vencimiento</th>
                      <th className="px-2 py-2 text-right font-semibold">Monto</th>
                      <th className="px-2 py-2 text-center font-semibold">Estado</th>
                      <th className="px-2 py-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {cuotas.map((c, i) => (
                      <tr key={i}>
                        <td className="px-2 py-1.5 text-slate-500">{i + 1}</td>
                        <td className="px-2 py-1.5">
                          <input type="date" value={c.fecha_vencimiento} onChange={(e) => setFecha(i, e.target.value)} className="rounded border border-slate-200 px-2 py-1 text-sm" />
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          <input type="number" min={0} step="any" value={c.monto} onChange={(e) => setMonto(i, e.target.value)} className="w-28 rounded border border-slate-200 px-2 py-1 text-right text-sm tabular-nums" />
                        </td>
                        <td className="px-2 py-1.5 text-center">{estadoChip(derivadas[i]?.estado ?? "pendiente")}</td>
                        <td className="px-2 py-1.5 text-right">
                          {cuotas.length > 1 && (
                            <button onClick={() => quitar(i)} className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center justify-between text-sm">
                <button onClick={agregar} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"><Plus className="h-4 w-4" /> Agregar cuota</button>
                <span className={sumaOk ? "text-emerald-700" : "text-red-600"}>
                  Suma: <span className="font-semibold tabular-nums">{fmtGs(suma, moneda)}</span> / {fmtGs(montoTotal, moneda)}
                </span>
              </div>

              {!sumaOk && !validacion.ok && <p className="flex items-start gap-1.5 text-xs text-amber-700"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{validacion.error}</p>}
              {err && <p className="flex items-start gap-1.5 text-sm text-red-600"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{err}</p>}
            </>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-slate-200 px-5 py-3">
          <div>
            {tienePlan && (
              <button onClick={quitarPlan} disabled={guardando} className="rounded-lg px-3 py-2 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50">Quitar plan</button>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-slate-500 hover:text-slate-700">Cancelar</button>
            <button onClick={guardar} disabled={guardando || cargando || !sumaOk} className="rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" style={{ backgroundColor: ACCENT }}>
              {guardando ? "Guardando…" : "Guardar plan"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
