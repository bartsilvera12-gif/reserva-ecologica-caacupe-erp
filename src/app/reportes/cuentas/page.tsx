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
  cheque: "Cheque confirmado",
};

type Cheque = {
  id: string;
  tipo: "recibido" | "emitido";
  numero: string;
  banco: string;
  monto: number;
  fecha_prevista: string;
  cuenta_nombre: string;
  estado: string;
  origen: string | null;
  referencia: string | null;
  confirmado_at: string | null;
  confirmado_por: string | null;
  dias: number | null;
};
const ESTADO_CHEQUE: Record<string, string> = {
  pendiente: "Pendiente", acreditado: "Acreditado", debitado: "Debitado", rechazado: "Rechazado", anulado: "Anulado",
};
const fmtDia = (d: string) => d.split("-").reverse().join("/");

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

  // Cheques
  const [cheques, setCheques] = useState<Cheque[]>([]);
  const [chFiltro, setChFiltro] = useState("pendiente");
  const [chTipo, setChTipo] = useState("recibido");
  const [chNumero, setChNumero] = useState("");
  const [chBanco, setChBanco] = useState("");
  const [chMonto, setChMonto] = useState("");
  const [chFecha, setChFecha] = useState("");
  const [chCuenta, setChCuenta] = useState("");
  const [chRef, setChRef] = useState("");
  const [chOrigen, setChOrigen] = useState("");

  const cargarCheques = useCallback(async () => {
    try {
      const qs = chFiltro ? `?estado=${chFiltro}` : "";
      const j = await fetchWithSupabaseSession(`/api/cuentas/cheques${qs}`, { cache: "no-store" }).then((r) => r.json());
      if (j?.success) setCheques((j.data?.cheques ?? []) as Cheque[]);
    } catch {
      /* se ignora: el resto de la pantalla sigue funcionando */
    }
  }, [chFiltro]);

  useEffect(() => {
    cargarCheques();
  }, [cargarCheques]);

  async function accionCheque(body: Record<string, unknown>, okMsg: string, reset?: () => void) {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const res = await fetchWithSupabaseSession("/api/cuentas/cheques", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j?.success === false) {
        setError(typeof j?.error === "string" ? j.error : "No se pudo procesar el cheque.");
      } else {
        setOk(okMsg);
        reset?.();
        cargar();
        cargarCheques();
      }
    } catch {
      setError("Error de red.");
    }
    setBusy(false);
  }

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
          <h2 className="mr-auto text-sm font-bold uppercase tracking-wider text-slate-700">Control de cheques</h2>
          <div>
            <label className={labelCls}>Estado</label>
            <select value={chFiltro} onChange={(e) => setChFiltro(e.target.value)} className={inputCls}>
              <option value="pendiente">Pendientes</option>
              <option value="">Todos</option>
              <option value="acreditado">Acreditados</option>
              <option value="debitado">Debitados</option>
              <option value="rechazado">Rechazados</option>
              <option value="anulado">Anulados</option>
            </select>
          </div>
        </div>
        {(() => {
          const pend = cheques.filter((c) => c.estado === "pendiente");
          const vencidos = pend.filter((c) => (c.dias ?? 1) <= 0);
          const proximos = pend.filter((c) => (c.dias ?? 99) > 0 && (c.dias ?? 99) <= 7);
          return (
            <>
              {vencidos.length > 0 && (
                <div className="mx-5 mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
                  {vencidos.length} cheque(s) pendiente(s) de confirmación: ya llegó o pasó la fecha prevista.
                </div>
              )}
              {proximos.length > 0 && (
                <div className="mx-5 mt-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-700">
                  {proximos.length} cheque(s) próximo(s) a vencer en los próximos 7 días.
                </div>
              )}
            </>
          );
        })()}
        <div className="grid gap-3 px-5 py-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className={labelCls}>Tipo de cheque</label>
            <select value={chTipo} onChange={(e) => setChTipo(e.target.value)} className={inputCls}>
              <option value="recibido">Recibido (de un cliente)</option>
              <option value="emitido">Emitido (a un proveedor)</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>N° de cheque</label>
            <input value={chNumero} onChange={(e) => setChNumero(e.target.value)} placeholder="Número del cheque" className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Banco del cheque</label>
            <input value={chBanco} onChange={(e) => setChBanco(e.target.value)} placeholder="Banco emisor" className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Monto del cheque (Gs.)</label>
            <input type="number" min={0} value={chMonto} onChange={(e) => setChMonto(e.target.value)} placeholder="0" className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Fecha prevista (cobro / débito)</label>
            <input type="date" value={chFecha} onChange={(e) => setChFecha(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Cuenta bancaria</label>
            <select value={chCuenta} onChange={(e) => setChCuenta(e.target.value)} className={inputCls}>
              <option value="">Elegí la cuenta…</option>
              {activas.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>Vinculado a</label>
            <select value={chOrigen} onChange={(e) => setChOrigen(e.target.value)} className={inputCls}>
              <option value="">Sin vincular</option>
              <option value="venta">Venta</option>
              <option value="cobro">Cobranza</option>
              <option value="compra">Compra</option>
              <option value="pago">Pago a proveedor</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>N° de documento vinculado</label>
            <input value={chRef} onChange={(e) => setChRef(e.target.value)} placeholder="Ej: N° de factura o compra" className={inputCls} />
          </div>
          <div className="sm:col-span-2 lg:col-span-4">
            <button
              disabled={busy || !chNumero.trim() || !chBanco.trim() || !(Number(chMonto) > 0) || !chFecha || !chCuenta}
              onClick={() =>
                accionCheque(
                  {
                    accion: "crear", tipo: chTipo, numero: chNumero, banco: chBanco, monto: Number(chMonto),
                    fecha_prevista: chFecha, cuenta_id: chCuenta, origen: chOrigen, referencia: chRef,
                  },
                  "Cheque registrado como pendiente. No modifica el saldo hasta confirmarlo.",
                  () => { setChNumero(""); setChBanco(""); setChMonto(""); setChFecha(""); setChRef(""); setChOrigen(""); }
                )
              }
              className="rounded-lg bg-[#4FAEB2] px-4 py-2 text-sm font-semibold text-white hover:bg-[#3F8E91] disabled:opacity-50"
            >
              Registrar cheque
            </button>
          </div>
        </div>
        <div className="overflow-x-auto border-t border-slate-100">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="bg-slate-50 text-xs text-slate-600">
                <th className="px-4 py-2 font-medium">Fecha prevista</th>
                <th className="px-4 py-2 font-medium">Tipo</th>
                <th className="px-4 py-2 font-medium">N°</th>
                <th className="px-4 py-2 font-medium">Banco</th>
                <th className="px-4 py-2 font-medium">Cuenta</th>
                <th className="px-4 py-2 font-medium text-right">Monto</th>
                <th className="px-4 py-2 font-medium">Estado</th>
                <th className="px-4 py-2 font-medium">Vinculado</th>
                <th className="px-4 py-2 font-medium">Confirmación</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {cheques.length === 0 && (
                <tr><td colSpan={10} className="px-4 py-6 text-center text-slate-400">No hay cheques para mostrar.</td></tr>
              )}
              {cheques.map((c) => (
                <tr key={c.id} className="border-t border-slate-100">
                  <td className="px-4 py-2 whitespace-nowrap">
                    {fmtDia(c.fecha_prevista)}
                    {c.estado === "pendiente" && (c.dias ?? 1) <= 0 && <span className="ml-2 text-xs font-semibold text-red-600">Confirmar</span>}
                    {c.estado === "pendiente" && (c.dias ?? 99) > 0 && (c.dias ?? 99) <= 7 && <span className="ml-2 text-xs font-semibold text-amber-600">En {c.dias} día(s)</span>}
                  </td>
                  <td className="px-4 py-2">{c.tipo === "recibido" ? "Recibido" : "Emitido"}</td>
                  <td className="px-4 py-2">{c.numero}</td>
                  <td className="px-4 py-2">{c.banco}</td>
                  <td className="px-4 py-2">{c.cuenta_nombre}</td>
                  <td className={`px-4 py-2 text-right tabular-nums ${c.tipo === "recibido" ? "text-emerald-700" : "text-red-600"}`}>
                    {c.tipo === "recibido" ? "+" : "−"}{gs(c.monto)}
                  </td>
                  <td className="px-4 py-2">{ESTADO_CHEQUE[c.estado] ?? c.estado}</td>
                  <td className="px-4 py-2 text-slate-500">{c.origen ? `${c.origen}${c.referencia ? ` ${c.referencia}` : ""}` : "—"}</td>
                  <td className="px-4 py-2 text-slate-500 whitespace-nowrap">
                    {c.confirmado_at ? `${fmtFecha(c.confirmado_at)} · ${c.confirmado_por ?? "—"}` : "—"}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap space-x-3">
                    {c.estado === "pendiente" && (
                      <>
                        <button
                          disabled={busy}
                          onClick={() =>
                            accionCheque(
                              { accion: "confirmar", cheque_id: c.id },
                              c.tipo === "recibido" ? "Cheque acreditado: se sumó al saldo de la cuenta." : "Cheque debitado: se descontó del saldo de la cuenta."
                            )
                          }
                          className="text-xs font-semibold text-emerald-700 hover:underline disabled:opacity-50"
                        >
                          {c.tipo === "recibido" ? "Confirmar acreditación" : "Confirmar débito"}
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => {
                            const motivo = window.prompt("Motivo del rechazo del cheque (mínimo 5 letras):");
                            if (motivo) accionCheque({ accion: "rechazar", cheque_id: c.id, motivo }, "Cheque marcado como rechazado.");
                          }}
                          className="text-xs text-red-600 hover:underline disabled:opacity-50"
                        >
                          Rechazar
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => {
                            const motivo = window.prompt("Motivo de la anulación del cheque (mínimo 5 letras):");
                            if (motivo) accionCheque({ accion: "anular", cheque_id: c.id, motivo }, "Cheque anulado.");
                          }}
                          className="text-xs text-slate-500 hover:underline disabled:opacity-50"
                        >
                          Anular
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

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
