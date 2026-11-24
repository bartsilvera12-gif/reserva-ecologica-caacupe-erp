"use client";

import { useCallback, useEffect, useState } from "react";
import PageHeader from "@/components/ui/PageHeader";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";

type Cuenta = {
  id: string;
  nombre: string;
  tipo: string;
  saldo_inicial: number;
  fecha_inicio: string;
  activo: boolean;
  por_acreditar: number;
  saldo: number;
};
type CajaMarket = { id: string; numero_caja: number; sucursal_nombre: string | null; estado: string; efectivo: number };
type Resumen = {
  cuentas: Cuenta[];
  total_bancos: number;
  total_caja_chica: number;
  cajas_market: CajaMarket[];
  efectivo_market: number;
  total_general: number;
};
type Mov = {
  id: string;
  cuenta_id: string;
  cuenta_nombre: string;
  fecha: string;
  tipo: string;
  concepto: string | null;
  monto: number;
  origen: string;
  grupo_id: string | null;
  usuario_nombre: string | null;
  anulado: boolean;
  anulado_motivo: string | null;
  saldo: number;
};

const ORIGEN_LABEL: Record<string, string> = {
  venta: "Venta cobrada",
  cobro: "Cobro de cliente",
  pago_proveedor: "Pago a proveedor",
  compra: "Compra al contado",
  gasto: "Gasto",
  transferencia: "Transferencia entre cuentas",
  retiro_caja: "Traslado desde caja del Market",
};

const gs = (n: number) => `Gs. ${Math.round(n).toLocaleString("es-PY")}`;
const fmtFecha = (iso: string) =>
  new Date(iso).toLocaleString("es-PY", { timeZone: "America/Asuncion", dateStyle: "short", timeStyle: "short" });
const inputCls = "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-[#4FAEB2]/30";
const labelCls = "block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1";

async function postTraslado(body: Record<string, unknown>): Promise<string | null> {
  const res = await fetchWithSupabaseSession("/api/cuentas/traslados", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j?.success === false) return typeof j?.error === "string" ? j.error : "No se pudo registrar.";
  return null;
}

export default function CuentasSaldosPage() {
  const [resumen, setResumen] = useState<Resumen | null>(null);
  const [movs, setMovs] = useState<Mov[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [cuentaFiltro, setCuentaFiltro] = useState("");
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");

  // Transferencia entre cuentas
  const [trOrigen, setTrOrigen] = useState("");
  const [trDestino, setTrDestino] = useState("");
  const [trMonto, setTrMonto] = useState("");
  const [trConcepto, setTrConcepto] = useState("");
  // Retiro desde la caja del Market
  const [rtCaja, setRtCaja] = useState("");
  const [rtCuenta, setRtCuenta] = useState("");
  const [rtMonto, setRtMonto] = useState("");
  const [rtConcepto, setRtConcepto] = useState("");
  const [busy, setBusy] = useState(false);

  const cargar = useCallback(async () => {
    try {
      const qs = new URLSearchParams();
      if (cuentaFiltro) qs.set("cuenta_id", cuentaFiltro);
      if (desde) qs.set("desde", desde);
      if (hasta) qs.set("hasta", hasta);
      const [r1, r2] = await Promise.all([
        fetchWithSupabaseSession("/api/cuentas", { cache: "no-store" }).then((r) => r.json()),
        fetchWithSupabaseSession(`/api/cuentas/movimientos?${qs.toString()}`, { cache: "no-store" }).then((r) => r.json()),
      ]);
      if (r1?.success) setResumen(r1.data as Resumen);
      else setError(typeof r1?.error === "string" ? r1.error : "No se pudieron cargar los saldos.");
      if (r2?.success) setMovs((r2.data?.movimientos ?? []) as Mov[]);
    } catch {
      setError("Error de red al cargar los saldos.");
    }
  }, [cuentaFiltro, desde, hasta]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  async function accion(body: Record<string, unknown>, okMsg: string, reset: () => void) {
    setBusy(true);
    setError(null);
    setOk(null);
    const err = await postTraslado(body);
    setBusy(false);
    if (err) return setError(err);
    setOk(okMsg);
    reset();
    cargar();
  }

  const activas = resumen?.cuentas.filter((c) => c.activo) ?? [];
  const cajasAbiertas = resumen?.cajas_market.filter((c) => c.estado === "abierta") ?? [];

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Reportes"
        title="Saldos de bancos y caja chica"
        description="Dinero disponible en cada banco, en la caja chica y en el efectivo del Market. Se actualiza solo con las ventas, cobros, compras, pagos y gastos."
      />

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {ok && <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{ok}</div>}

      {resumen && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[
              ["Total en bancos", resumen.total_bancos],
              ["Total caja chica", resumen.total_caja_chica],
              ["Efectivo del Market (caja)", resumen.efectivo_market],
              ["Total general disponible", resumen.total_general],
            ].map(([t, v]) => (
              <div key={String(t)} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t}</p>
                <p className="mt-1 text-xl font-bold text-slate-900 tabular-nums">{gs(Number(v))}</p>
              </div>
            ))}
          </div>

          <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
            <h2 className="border-b border-slate-200 px-5 py-3 text-sm font-bold uppercase tracking-wider text-slate-700">
              Saldo por cuenta
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="bg-slate-50 text-xs text-slate-600">
                    <th className="px-4 py-2 font-medium">Cuenta</th>
                    <th className="px-4 py-2 font-medium">Tipo</th>
                    <th className="px-4 py-2 font-medium text-right">Saldo inicial</th>
                    <th className="px-4 py-2 font-medium">Control desde</th>
                    <th className="px-4 py-2 font-medium text-right">Por acreditar</th>
                    <th className="px-4 py-2 font-medium text-right">Saldo disponible</th>
                  </tr>
                </thead>
                <tbody>
                  {resumen.cuentas.map((c) => (
                    <tr key={c.id} className="border-t border-slate-100">
                      <td className="px-4 py-2 font-medium text-slate-800">{c.nombre}{!c.activo ? " (inactiva)" : ""}</td>
                      <td className="px-4 py-2 text-slate-600">{c.tipo === "banco" ? "Banco" : "Caja chica"}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{gs(c.saldo_inicial)}</td>
                      <td className="px-4 py-2 text-slate-600">{c.fecha_inicio.split("-").reverse().join("/")}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-500">{c.por_acreditar > 0 ? gs(c.por_acreditar) : "—"}</td>
                      <td className="px-4 py-2 text-right font-semibold tabular-nums">{gs(c.saldo)}</td>
                    </tr>
                  ))}
                  {resumen.cajas_market.map((c) => (
                    <tr key={c.id} className="border-t border-slate-100 bg-slate-50/60">
                      <td className="px-4 py-2 font-medium text-slate-800">
                        Caja {c.numero_caja}{c.sucursal_nombre ? ` · ${c.sucursal_nombre}` : ""}
                      </td>
                      <td className="px-4 py-2 text-slate-600">Efectivo en caja (módulo Caja)</td>
                      <td className="px-4 py-2" />
                      <td className="px-4 py-2" />
                      <td className="px-4 py-2" />
                      <td className="px-4 py-2 text-right font-semibold tabular-nums">{gs(c.efectivo)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <div className="grid gap-6 lg:grid-cols-2">
            <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm space-y-3">
              <h2 className="text-sm font-bold uppercase tracking-wider text-slate-700">Transferir entre cuentas</h2>
              <p className="text-xs text-slate-500">Mueve plata entre bancos y caja chica. El total general no cambia.</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelCls}>Desde</label>
                  <select value={trOrigen} onChange={(e) => setTrOrigen(e.target.value)} className={inputCls}>
                    <option value="">Elegí la cuenta de origen…</option>
                    {activas.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Hacia</label>
                  <select value={trDestino} onChange={(e) => setTrDestino(e.target.value)} className={inputCls}>
                    <option value="">Elegí la cuenta de destino…</option>
                    {activas.filter((c) => c.id !== trOrigen).map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Monto (Gs.)</label>
                  <input type="number" min={0} value={trMonto} onChange={(e) => setTrMonto(e.target.value)} placeholder="0" className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Concepto</label>
                  <input value={trConcepto} onChange={(e) => setTrConcepto(e.target.value)} placeholder="Motivo de la transferencia" className={inputCls} />
                </div>
              </div>
              <button
                disabled={busy || !trOrigen || !trDestino || !(Number(trMonto) > 0)}
                onClick={() =>
                  accion(
                    { tipo: "transferencia", origen_id: trOrigen, destino_id: trDestino, monto: Number(trMonto), concepto: trConcepto },
                    "Transferencia registrada.",
                    () => { setTrMonto(""); setTrConcepto(""); }
                  )
                }
                className="rounded-lg bg-[#4FAEB2] px-4 py-2 text-sm font-semibold text-white hover:bg-[#3F8E91] disabled:opacity-50"
              >
                Registrar transferencia
              </button>
            </section>

            <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm space-y-3">
              <h2 className="text-sm font-bold uppercase tracking-wider text-slate-700">Retiro de efectivo de la caja del Market</h2>
              <p className="text-xs text-slate-500">
                Pasa efectivo de la caja abierta del Market a la caja chica: se descuenta de la caja (queda como retiro en el arqueo) y se suma a la cuenta.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelCls}>Caja del Market</label>
                  <select value={rtCaja} onChange={(e) => setRtCaja(e.target.value)} className={inputCls}>
                    <option value="">Elegí la caja abierta…</option>
                    {cajasAbiertas.map((c) => (
                      <option key={c.id} value={c.id}>Caja {c.numero_caja}{c.sucursal_nombre ? ` · ${c.sucursal_nombre}` : ""} ({gs(c.efectivo)})</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Cuenta destino</label>
                  <select value={rtCuenta} onChange={(e) => setRtCuenta(e.target.value)} className={inputCls}>
                    <option value="">Elegí la cuenta…</option>
                    {activas.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Monto a retirar (Gs.)</label>
                  <input type="number" min={0} value={rtMonto} onChange={(e) => setRtMonto(e.target.value)} placeholder="0" className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Concepto</label>
                  <input value={rtConcepto} onChange={(e) => setRtConcepto(e.target.value)} placeholder="Ej: depósito del día" className={inputCls} />
                </div>
              </div>
              {cajasAbiertas.length === 0 && <p className="text-xs text-amber-600">No hay una caja del Market abierta en este momento.</p>}
              <button
                disabled={busy || !rtCaja || !rtCuenta || !(Number(rtMonto) > 0)}
                onClick={() =>
                  accion(
                    { tipo: "retiro_caja", caja_id: rtCaja, cuenta_id: rtCuenta, monto: Number(rtMonto), concepto: rtConcepto },
                    "Retiro registrado: se descontó de la caja y se sumó a la cuenta.",
                    () => { setRtMonto(""); setRtConcepto(""); }
                  )
                }
                className="rounded-lg bg-[#4FAEB2] px-4 py-2 text-sm font-semibold text-white hover:bg-[#3F8E91] disabled:opacity-50"
              >
                Registrar retiro
              </button>
            </section>
          </div>
        </>
      )}

      <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-end gap-3 border-b border-slate-200 px-5 py-3">
          <h2 className="mr-auto text-sm font-bold uppercase tracking-wider text-slate-700">Historial de movimientos</h2>
          <div>
            <label className={labelCls}>Cuenta</label>
            <select value={cuentaFiltro} onChange={(e) => setCuentaFiltro(e.target.value)} className={inputCls}>
              <option value="">Todas las cuentas</option>
              {(resumen?.cuentas ?? []).map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>Desde</label>
            <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Hasta</label>
            <input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} className={inputCls} />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="bg-slate-50 text-xs text-slate-600">
                <th className="px-4 py-2 font-medium">Fecha</th>
                <th className="px-4 py-2 font-medium">Cuenta</th>
                <th className="px-4 py-2 font-medium">Concepto</th>
                <th className="px-4 py-2 font-medium">Tipo de operación</th>
                <th className="px-4 py-2 font-medium text-right">Importe</th>
                <th className="px-4 py-2 font-medium text-right">Saldo</th>
                <th className="px-4 py-2 font-medium">Responsable</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {movs.length === 0 && (
                <tr><td colSpan={8} className="px-4 py-6 text-center text-slate-400">Todavía no hay movimientos registrados.</td></tr>
              )}
              {movs.map((m) => (
                <tr key={m.id} className={`border-t border-slate-100 ${m.anulado ? "text-slate-400 line-through" : ""}`}>
                  <td className="px-4 py-2 whitespace-nowrap">{fmtFecha(m.fecha)}</td>
                  <td className="px-4 py-2">{m.cuenta_nombre}</td>
                  <td className="px-4 py-2">{m.concepto ?? "—"}{m.anulado && m.anulado_motivo ? ` (anulado: ${m.anulado_motivo})` : ""}</td>
                  <td className="px-4 py-2">{ORIGEN_LABEL[m.origen] ?? m.origen}</td>
                  <td className={`px-4 py-2 text-right tabular-nums ${m.tipo === "ingreso" ? "text-emerald-700" : "text-red-600"}`}>
                    {m.tipo === "ingreso" ? "+" : "−"}{gs(m.monto)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{gs(m.saldo)}</td>
                  <td className="px-4 py-2 text-slate-500">{m.usuario_nombre ?? "—"}</td>
                  <td className="px-4 py-2">
                    {m.origen === "transferencia" && m.grupo_id && !m.anulado && m.tipo === "egreso" && (
                      <button
                        onClick={() => {
                          const motivo = window.prompt("Motivo de la anulación de la transferencia (mínimo 5 letras):");
                          if (motivo) accion({ tipo: "anular_transferencia", grupo_id: m.grupo_id, motivo }, "Transferencia anulada.", () => {});
                        }}
                        className="text-xs text-red-600 hover:underline"
                      >
                        Anular
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
