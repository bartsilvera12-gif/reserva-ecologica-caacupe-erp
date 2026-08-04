"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import {
  Banknote, X, Loader2, Lock, Unlock, Plus, ArrowDownCircle, ArrowUpCircle,
  Printer, Wallet, Clock, AlertTriangle, CheckCircle2, ArrowDownRight,
} from "lucide-react";
import ArqueoDenominaciones, {
  arqueoVacio,
  cantidadesAArqueo,
  totalArqueo,
  type ArqueoCantidades,
} from "@/components/caja/ArqueoDenominaciones";

type Arqueo = {
  monto_apertura: number; cantidad_ventas: number; ventas_efectivo: number; ventas_tarjeta: number;
  ventas_transferencia: number; ventas_credito: number; ventas_total: number;
  cobros_efectivo: number; cobros_total: number; ingresos_efectivo: number; egresos_efectivo: number;
  retiros_efectivo: number; ajustes_efectivo: number; efectivo_esperado: number;
};
type Caja = {
  id: string; numero_caja: number; estado: string; monto_apertura: number;
  abierta_at: string; cerrada_at: string | null; abierta_por_nombre: string | null;
  cerrada_por_nombre: string | null; efectivo_esperado: number | null; efectivo_contado: number | null; diferencia: number | null;
};
type Movimiento = {
  id: string; tipo: string; concepto: string | null; monto: number; metodo_pago: string; origen: string;
  usuario_nombre: string | null; fecha: string;
};
type CajaResumen = { caja: Caja; arqueo: Arqueo; movimientos: Movimiento[] };

const TEAL = "#4FAEB2";
const TEAL_D = "#3F8E91";

function fmtGs(n: number) { return "Gs. " + Math.round(Number(n) || 0).toLocaleString("es-PY"); }
function fmtFechaHora(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Módulo de caja reutilizable (modelo multi-caja, Ferretería República): varias
 * cajas activas por sucursal, tarjeta con tiles en vivo (Apertura · Ventas ·
 * Efectivo · Transfer · Tarjeta · Esperado) y estado intermedio "en cierre".
 * Se usa como página completa en /caja (desde Reportes) y embebido en modo
 * `compact` dentro del POS /ventas (sin encabezado ni historial).
 */
export default function CajaModule({ compact = false }: { compact?: boolean }) {
  const [activas, setActivas] = useState<CajaResumen[]>([]);
  const [historial, setHistorial] = useState<Caja[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<null | "abrir" | "movimiento" | "cerrar" | "en_cierre">(null);
  const [target, setTarget] = useState<CajaResumen | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true); setError(null);
    try {
      const res = await fetchWithSupabaseSession("/api/caja", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "No se pudo cargar.");
      setActivas(json?.data?.activas ?? []);
      setHistorial(json?.data?.historial ?? []);
    } catch (e) { setError(e instanceof Error ? e.message : "Error."); }
    finally { setCargando(false); }
  }, []);
  useEffect(() => { cargar(); }, [cargar]);

  const cerrarModal = () => { setModal(null); setTarget(null); };
  const refrescar = () => { cerrarModal(); cargar(); };

  return (
    <div className={`w-full ${compact ? "space-y-4" : "space-y-6"}`}>
      {!compact && (
        <div>
          <h1 className="flex items-center gap-2.5 text-2xl font-bold text-slate-900">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl" style={{ backgroundColor: `${TEAL}1a`, color: TEAL_D }}><Banknote className="h-5 w-5" /></span>
            Caja y arqueo
          </h1>
          <p className="mt-1 text-sm text-slate-500">Turno de caja de tu sucursal: apertura, movimientos y cierre con arqueo por denominaciones.</p>
        </div>
      )}

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      {cargando ? (
        <div className="flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-16 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /> Cargando…</div>
      ) : activas.length === 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border-2 border-amber-200 bg-amber-50/60 p-5 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500 shadow-sm"><Lock className="h-4.5 w-4.5 text-white" /></div>
            <div>
              <h2 className="text-[15px] font-bold leading-none text-amber-900">Caja cerrada</h2>
              <p className="mt-1 text-xs text-amber-700">Abrila antes de operar para que las ventas se registren en el turno.</p>
            </div>
          </div>
          <button onClick={() => setModal("abrir")} className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2.5 text-sm font-bold text-white shadow-sm transition-colors" style={{ backgroundColor: TEAL }}>
            <Unlock className="h-4 w-4" /> Abrir caja
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-[15px] font-bold text-slate-800">
              <Wallet className="h-4 w-4" style={{ color: TEAL }} /> Cajas ({activas.length})
            </h2>
            <button onClick={() => setModal("abrir")} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold text-white shadow-sm transition-colors" style={{ backgroundColor: TEAL }}>
              <Unlock className="h-3.5 w-3.5" /> Abrir otra caja
            </button>
          </div>

          {activas.map((cr) => (
            <CajaCard
              key={cr.caja.id}
              cr={cr}
              onMovimiento={() => { setTarget(cr); setModal("movimiento"); }}
              onEnCierre={() => { setTarget(cr); setModal("en_cierre"); }}
              onCerrar={() => { setTarget(cr); setModal("cerrar"); }}
            />
          ))}
        </div>
      )}

      {/* Historial (oculto en modo compacto embebido en el POS) */}
      {!compact && (
        <div>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Historial de turnos</h2>
          <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
            {historial.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-slate-400">Sin turnos cerrados.</div>
            ) : (
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50/80 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Caja</th>
                    <th className="px-4 py-3 font-semibold">Apertura</th>
                    <th className="px-4 py-3 font-semibold">Cierre</th>
                    <th className="px-4 py-3 text-right font-semibold">Esperado</th>
                    <th className="px-4 py-3 text-right font-semibold">Contado</th>
                    <th className="px-4 py-3 text-right font-semibold">Diferencia</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {historial.map((c) => (
                    <tr key={c.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3 font-semibold text-slate-700">Caja {c.numero_caja}</td>
                      <td className="px-4 py-3 text-slate-600">{fmtFechaHora(c.abierta_at)}<div className="text-xs text-slate-400">{c.abierta_por_nombre}</div></td>
                      <td className="px-4 py-3 text-slate-600">{fmtFechaHora(c.cerrada_at)}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-600">{c.efectivo_esperado != null ? fmtGs(c.efectivo_esperado) : "—"}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-600">{c.efectivo_contado != null ? fmtGs(c.efectivo_contado) : "—"}</td>
                      <td className={`px-4 py-3 text-right tabular-nums font-semibold ${c.diferencia == null ? "text-slate-400" : c.diferencia === 0 ? "text-emerald-600" : c.diferencia < 0 ? "text-red-600" : "text-amber-600"}`}>
                        {c.diferencia != null ? fmtGs(c.diferencia) : "—"}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button onClick={() => window.open(`/api/caja/${c.id}/pdf?auto=1`, "_blank")} className="inline-flex items-center gap-1 text-sm font-medium hover:underline" style={{ color: TEAL_D }}>
                          <Printer className="h-3.5 w-3.5" /> Arqueo
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {modal === "abrir" && <ModalAbrir onClose={cerrarModal} onOk={refrescar} />}
      {modal === "movimiento" && target && <ModalMovimiento cajaId={target.caja.id} numero={target.caja.numero_caja} onClose={cerrarModal} onOk={refrescar} />}
      {modal === "cerrar" && target && <ModalCerrar caja={target.caja} arqueo={target.arqueo} onClose={cerrarModal} onOk={refrescar} />}
      {modal === "en_cierre" && target && <ModalEnCierre cr={target} onClose={cerrarModal} onOk={refrescar} />}
    </div>
  );
}

// ============================================================
// Tarjeta por caja + tiles
// ============================================================

function CajaCard({ cr, onMovimiento, onEnCierre, onCerrar }: {
  cr: CajaResumen; onMovimiento: () => void; onEnCierre: () => void; onCerrar: () => void;
}) {
  const c = cr.caja;
  const a = cr.arqueo;
  const enCierre = c.estado === "en_cierre";
  return (
    <div className="overflow-hidden rounded-2xl border-2 bg-white shadow-[0_2px_10px_-2px_rgba(79,174,178,0.12)]" style={{ borderColor: `${TEAL}40` }}>
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4" style={{ borderColor: `${TEAL}26`, background: `linear-gradient(90deg, ${TEAL}0d, transparent)` }}>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl shadow-sm" style={{ backgroundColor: enCierre ? "#f59e0b" : TEAL }}>
            <Wallet className="h-4.5 w-4.5 text-white" />
          </div>
          <div>
            <h3 className="flex items-center gap-2 text-[15px] font-bold leading-none text-slate-800">
              Caja {c.numero_caja}
              {enCierre ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-100 px-2 py-0.5 text-[10.5px] font-bold text-amber-700">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500" /> En cierre
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-100 px-2 py-0.5 text-[10.5px] font-bold text-emerald-700">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Abierta
                </span>
              )}
            </h3>
            <p className="mt-1 flex items-center gap-1 text-xs text-slate-500">
              <Clock className="h-3 w-3" /> Abierta el {fmtFechaHora(c.abierta_at)}{c.abierta_por_nombre ? ` · ${c.abierta_por_nombre}` : ""}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => window.open(`/api/caja/${c.id}/pdf?auto=1`, "_blank")} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-50">
            <Printer className="h-3.5 w-3.5" /> Imprimir
          </button>
          {!enCierre && (
            <>
              <button onClick={onMovimiento} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50">
                <Plus className="h-3.5 w-3.5" /> Movimiento
              </button>
              <button onClick={onEnCierre} className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800 transition-colors hover:bg-amber-100">
                <AlertTriangle className="h-3.5 w-3.5" /> Pasar a cierre
              </button>
            </>
          )}
          <button onClick={onCerrar} className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-2 text-xs font-bold text-white shadow-sm transition-colors hover:bg-red-700">
            <Lock className="h-3.5 w-3.5" /> Cerrar
          </button>
        </div>
      </div>

      {enCierre && (
        <div className="border-b border-amber-100 bg-amber-50/60 px-5 py-2 text-[11px] font-medium text-amber-800">
          En conteo — no recibe nuevas ventas ni movimientos. Cargá el efectivo contado para cerrar.
        </div>
      )}

      {/* Tiles en vivo */}
      <div className="grid grid-cols-2 gap-px bg-slate-100 md:grid-cols-3 lg:grid-cols-6">
        <Metric label="Apertura" value={fmtGs(a.monto_apertura)} icon={<Wallet className="h-3.5 w-3.5" />} />
        <Metric label="Ventas" value={String(a.cantidad_ventas)} icon={<CheckCircle2 className="h-3.5 w-3.5" />} />
        <Metric label="Efectivo" value={fmtGs(a.ventas_efectivo)} icon={<ArrowDownRight className="h-3.5 w-3.5 text-emerald-600" />} highlight="emerald" />
        <Metric label="Transfer" value={fmtGs(a.ventas_transferencia)} icon={<ArrowDownRight className="h-3.5 w-3.5 text-sky-600" />} />
        <Metric label="Tarjeta" value={fmtGs(a.ventas_tarjeta)} icon={<ArrowDownRight className="h-3.5 w-3.5 text-violet-600" />} />
        <Metric label="Esperado efectivo" value={fmtGs(a.efectivo_esperado)} icon={<Wallet className="h-3.5 w-3.5" style={{ color: TEAL }} />} highlight="turquesa" />
      </div>

      {cr.movimientos.length > 0 && (
        <div className="border-t border-slate-100 bg-slate-50/40 px-5 py-3">
          <p className="mb-2 text-[10.5px] font-bold uppercase tracking-wider text-slate-500">Movimientos manuales</p>
          <ul className="space-y-1">
            {cr.movimientos.slice(-5).reverse().map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="flex min-w-0 items-center gap-1.5">
                  <MovIcon tipo={m.tipo} />
                  <span className="truncate font-medium text-slate-700">{m.concepto || m.tipo}</span>
                  <span className="text-slate-400">·</span>
                  <span className="capitalize text-slate-500">{m.metodo_pago}</span>
                </span>
                <span className={`tabular-nums font-bold ${m.tipo === "ingreso" ? "text-emerald-700" : m.tipo === "egreso" || m.tipo === "retiro" ? "text-red-600" : "text-amber-700"}`}>
                  {m.tipo === "egreso" || m.tipo === "retiro" ? "−" : "+"}{fmtGs(Math.abs(m.monto))}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, icon, highlight }: { label: string; value: string; icon?: React.ReactNode; highlight?: "turquesa" | "emerald" }) {
  const style = highlight === "turquesa" ? { backgroundColor: `${TEAL}0d` } : highlight === "emerald" ? { backgroundColor: "#ecfdf580" } : { backgroundColor: "#fff" };
  return (
    <div className="px-3 py-3" style={style}>
      <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">{icon}{label}</p>
      <p className="mt-1 text-[15px] font-bold tabular-nums text-slate-800">{value}</p>
    </div>
  );
}

function MovIcon({ tipo }: { tipo: string }) {
  const cls = "h-3 w-3";
  if (tipo === "ingreso") return <ArrowDownCircle className={`${cls} text-emerald-600`} />;
  if (tipo === "egreso" || tipo === "retiro") return <ArrowUpCircle className={`${cls} text-red-600`} />;
  return <Plus className={`${cls} text-amber-600`} />;
}

// ============================================================
// Modales
// ============================================================

function Overlay({ titulo, onClose, children }: { titulo: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:items-center">
      <div className="my-8 w-full max-w-md rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h2 className="text-lg font-semibold text-slate-900">{titulo}</h2>
          <button onClick={onClose} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"><X className="h-5 w-5" /></button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

function usePost() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function post(url: string, body: unknown): Promise<boolean> {
    setErr(null); setBusy(true);
    try {
      const res = await fetchWithSupabaseSession(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "No se pudo procesar.");
      return true;
    } catch (e) { setErr(e instanceof Error ? e.message : "Error."); setBusy(false); return false; }
  }
  return { busy, err, post };
}

function Fila({ label, value, fuerte }: { label: string; value: number; fuerte?: boolean }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className={`text-sm ${fuerte ? "font-semibold text-slate-800" : "text-slate-500"}`}>{label}</span>
      <span className={`tabular-nums ${fuerte ? "text-base font-bold text-slate-900" : "text-sm text-slate-700"}`}>{fmtGs(value)}</span>
    </div>
  );
}

function ModalAbrir({ onClose, onOk }: { onClose: () => void; onOk: () => void }) {
  const [monto, setMonto] = useState("0");
  const [obs, setObs] = useState("");
  const [porDenom, setPorDenom] = useState(false);
  const [cantidades, setCantidades] = useState<ArqueoCantidades>(arqueoVacio);
  const { busy, err, post } = usePost();
  const efectivo = porDenom ? totalArqueo(cantidades) : Number(monto) || 0;
  return (
    <Overlay titulo="Abrir caja" onClose={onClose}>
      <div className="space-y-4">
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={porDenom} onChange={(e) => setPorDenom(e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
          Contar por billetes y monedas
        </label>
        {porDenom ? (
          <ArqueoDenominaciones value={cantidades} onChange={setCantidades} />
        ) : (
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">Monto de apertura (efectivo)</label>
            <input type="number" min={0} step="any" value={monto} onChange={(e) => setMonto(e.target.value)} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-right text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/40" />
          </div>
        )}
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">Observación (opcional)</label>
          <input value={obs} onChange={(e) => setObs(e.target.value)} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/40" />
        </div>
        {err && <p className="text-sm text-red-600">{err}</p>}
        <div className="flex items-center justify-between pt-1">
          <span className="text-sm text-slate-500">Apertura: <span className="font-semibold text-slate-800">{fmtGs(efectivo)}</span></span>
          <div className="flex gap-2">
            <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-slate-500 hover:text-slate-700">Cancelar</button>
            <button disabled={busy} onClick={async () => {
              const body = porDenom
                ? { arqueo_apertura: cantidadesAArqueo(cantidades), observacion: obs.trim() || undefined }
                : { monto_apertura: Number(monto) || 0, observacion: obs.trim() || undefined };
              if (await post("/api/caja/abrir", body)) onOk();
            }} className="rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" style={{ backgroundColor: TEAL }}>{busy ? "Abriendo…" : "Abrir caja"}</button>
          </div>
        </div>
      </div>
    </Overlay>
  );
}

function ModalMovimiento({ cajaId, numero, onClose, onOk }: { cajaId: string; numero: number; onClose: () => void; onOk: () => void }) {
  const [tipo, setTipo] = useState("ingreso");
  const [monto, setMonto] = useState("");
  const [concepto, setConcepto] = useState("");
  const [metodo, setMetodo] = useState("efectivo");
  const { busy, err, post } = usePost();
  return (
    <Overlay titulo={`Movimiento · Caja ${numero}`} onClose={onClose}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2">
          {([["ingreso", "Ingreso", ArrowDownCircle], ["egreso", "Egreso", ArrowUpCircle], ["retiro", "Retiro", ArrowUpCircle], ["ajuste", "Ajuste", Plus]] as const).map(([k, label, Icon]) => (
            <button key={k} onClick={() => setTipo(k)} className={`inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium ${tipo === k ? "text-white" : "border-slate-200 text-slate-500 hover:bg-slate-50"}`} style={tipo === k ? { backgroundColor: TEAL, borderColor: TEAL } : undefined}><Icon className="h-4 w-4" /> {label}</button>
          ))}
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">Monto</label>
          <input type="number" min={0} step="any" value={monto} onChange={(e) => setMonto(e.target.value)} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-right text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/40" />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">Método</label>
          <select value={metodo} onChange={(e) => setMetodo(e.target.value)} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/40">
            <option value="efectivo">Efectivo</option><option value="transferencia">Transferencia</option><option value="tarjeta">Tarjeta</option>
          </select>
          <p className="mt-1 text-[11px] text-slate-500">Solo los movimientos en efectivo afectan el arqueo de caja.</p>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">Concepto</label>
          <input value={concepto} onChange={(e) => setConcepto(e.target.value)} placeholder="Ej: pago a delivery, retiro a banco…" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/40" />
        </div>
        {err && <p className="text-sm text-red-600">{err}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-slate-500 hover:text-slate-700">Cancelar</button>
          <button disabled={busy} onClick={async () => { if ((Number(monto) || 0) <= 0) return; if (await post("/api/caja/movimiento", { caja_id: cajaId, tipo, monto: Number(monto), concepto: concepto.trim() || undefined, metodo_pago: metodo })) onOk(); }} className="rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" style={{ backgroundColor: TEAL }}>{busy ? "Guardando…" : "Registrar"}</button>
        </div>
      </div>
    </Overlay>
  );
}

function ModalEnCierre({ cr, onClose, onOk }: { cr: CajaResumen; onClose: () => void; onOk: () => void }) {
  const { busy, err, post } = usePost();
  return (
    <Overlay titulo={`Pasar Caja ${cr.caja.numero_caja} a cierre`} onClose={onClose}>
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
          <p className="text-sm text-amber-800">
            La <b>Caja {cr.caja.numero_caja}</b> dejará de recibir ventas y movimientos. Después vas a cargar el efectivo contado para cerrarla. ¿Continuar?
          </p>
        </div>
        {err && <p className="text-sm text-red-600">{err}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-slate-500 hover:text-slate-700">Cancelar</button>
          <button disabled={busy} onClick={async () => { if (await post("/api/caja/en-cierre", { caja_id: cr.caja.id })) onOk(); }} className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-600 disabled:opacity-50">{busy ? "Procesando…" : "Pasar a cierre"}</button>
        </div>
      </div>
    </Overlay>
  );
}

function ModalCerrar({ caja, arqueo, onClose, onOk }: { caja: Caja; arqueo: Arqueo; onClose: () => void; onOk: () => void }) {
  const [contadoManual, setContadoManual] = useState("");
  const [obs, setObs] = useState("");
  const [porDenom, setPorDenom] = useState(false);
  const [cantidades, setCantidades] = useState<ArqueoCantidades>(arqueoVacio);
  const { busy, err, post } = usePost();
  const contado = porDenom ? totalArqueo(cantidades) : Number(contadoManual) || 0;
  const contadoDefinido = porDenom || contadoManual !== "";
  const dif = contado - arqueo.efectivo_esperado;
  return (
    <Overlay titulo={`Cerrar Caja ${caja.numero_caja} (arqueo)`} onClose={onClose}>
      <div className="space-y-4">
        <div className="rounded-lg bg-slate-50 px-3 py-2">
          <Fila label="Efectivo esperado" value={arqueo.efectivo_esperado} fuerte />
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={porDenom} onChange={(e) => setPorDenom(e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
          Contar por billetes y monedas
        </label>
        {porDenom ? (
          <ArqueoDenominaciones value={cantidades} onChange={setCantidades} />
        ) : (
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">Efectivo físico contado</label>
            <input type="number" min={0} step="any" value={contadoManual} onChange={(e) => setContadoManual(e.target.value)} autoFocus className="w-full rounded-lg border border-slate-200 px-3 py-2 text-right text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/40" />
          </div>
        )}
        {contadoDefinido && (
          <div className={`rounded-lg px-3 py-2 text-sm font-semibold ${dif === 0 ? "bg-emerald-50 text-emerald-700" : dif < 0 ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-700"}`}>
            {dif === 0 ? "Cierre exacto" : dif < 0 ? `Faltante: ${fmtGs(Math.abs(dif))}` : `Sobrante: ${fmtGs(dif)}`}
          </div>
        )}
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">Observación (opcional)</label>
          <input value={obs} onChange={(e) => setObs(e.target.value)} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/40" />
        </div>
        {err && <p className="text-sm text-red-600">{err}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-slate-500 hover:text-slate-700">Cancelar</button>
          <button disabled={busy || !contadoDefinido} onClick={async () => {
            const body = porDenom
              ? { arqueo_cierre: cantidadesAArqueo(cantidades), observacion: obs.trim() || undefined }
              : { efectivo_contado: Number(contadoManual) || 0, observacion: obs.trim() || undefined };
            if (await post(`/api/caja/${caja.id}/cerrar`, body)) onOk();
          }} className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50">{busy ? "Cerrando…" : "Cerrar caja"}</button>
        </div>
      </div>
    </Overlay>
  );
}
