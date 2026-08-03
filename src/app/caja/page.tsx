"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import { Banknote, X, Loader2, LockOpen, Lock, Plus, ArrowDownCircle, ArrowUpCircle, Printer } from "lucide-react";
import { DENOMINACIONES, type ArqueoItem } from "@/lib/caja/denominaciones";

type Arqueo = {
  monto_apertura: number; ventas_efectivo: number; ventas_tarjeta: number; ventas_transferencia: number;
  ventas_credito: number; ventas_total: number; cobros_efectivo: number; cobros_total: number;
  ingresos_efectivo: number; egresos_efectivo: number; retiros_efectivo: number; ajustes_efectivo: number;
  efectivo_esperado: number;
};
type Caja = {
  id: string; numero_caja: number; estado: string; monto_apertura: number;
  abierta_at: string; cerrada_at: string | null; abierta_por_nombre: string | null;
  cerrada_por_nombre: string | null; efectivo_esperado: number | null; efectivo_contado: number | null; diferencia: number | null;
};

function fmtGs(n: number) { return "Gs. " + Math.round(Number(n) || 0).toLocaleString("es-PY"); }
function fmtFechaHora(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function CajaPage() {
  const [abierta, setAbierta] = useState<{ caja: Caja; arqueo: Arqueo } | null>(null);
  const [historial, setHistorial] = useState<Caja[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<null | "abrir" | "movimiento" | "cerrar">(null);

  const cargar = useCallback(async () => {
    setCargando(true); setError(null);
    try {
      const res = await fetchWithSupabaseSession("/api/caja", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "No se pudo cargar.");
      setAbierta(json?.data?.abierta ?? null);
      setHistorial(json?.data?.historial ?? []);
    } catch (e) { setError(e instanceof Error ? e.message : "Error."); }
    finally { setCargando(false); }
  }, []);
  useEffect(() => { cargar(); }, [cargar]);

  return (
    <div className="w-full space-y-6">
      <div>
        <h1 className="flex items-center gap-2.5 text-2xl font-bold text-slate-900">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-100 text-emerald-600"><Banknote className="h-5 w-5" /></span>
          Caja y arqueo
        </h1>
        <p className="mt-1 text-sm text-slate-500">Turno de caja de tu sucursal: apertura, movimientos y cierre con arqueo.</p>
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      {cargando ? (
        <div className="flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-16 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /> Cargando…</div>
      ) : abierta ? (
        <CajaAbierta data={abierta} onMovimiento={() => setModal("movimiento")} onCerrar={() => setModal("cerrar")} />
      ) : (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-slate-200 bg-white px-6 py-14 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-400"><Lock className="h-7 w-7" /></span>
          <p className="text-sm font-semibold text-slate-700">No hay una caja abierta en tu sucursal</p>
          <button onClick={() => setModal("abrir")} className="mt-1 inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 active:scale-95">
            <LockOpen className="h-4 w-4" /> Abrir caja
          </button>
        </div>
      )}

      {/* Historial */}
      <div>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Historial de turnos</h2>
        <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
          {historial.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-slate-400">Sin turnos registrados.</div>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50/80 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-semibold">Apertura</th>
                  <th className="px-4 py-3 font-semibold">Cierre</th>
                  <th className="px-4 py-3 font-semibold text-right">Esperado</th>
                  <th className="px-4 py-3 font-semibold text-right">Contado</th>
                  <th className="px-4 py-3 font-semibold text-right">Diferencia</th>
                  <th className="px-4 py-3 font-semibold">Estado</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {historial.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 text-slate-600">{fmtFechaHora(c.abierta_at)}<div className="text-xs text-slate-400">{c.abierta_por_nombre}</div></td>
                    <td className="px-4 py-3 text-slate-600">{fmtFechaHora(c.cerrada_at)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-600">{c.efectivo_esperado != null ? fmtGs(c.efectivo_esperado) : "—"}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-600">{c.efectivo_contado != null ? fmtGs(c.efectivo_contado) : "—"}</td>
                    <td className={`px-4 py-3 text-right tabular-nums font-semibold ${c.diferencia == null ? "text-slate-400" : c.diferencia === 0 ? "text-emerald-600" : c.diferencia < 0 ? "text-red-600" : "text-amber-600"}`}>
                      {c.diferencia != null ? fmtGs(c.diferencia) : "—"}
                    </td>
                    <td className="px-4 py-3">
                      {c.estado === "abierta"
                        ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">Abierta</span>
                        : <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-500">Cerrada</span>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button onClick={() => window.open(`/api/caja/${c.id}/pdf?auto=1`, "_blank")} className="inline-flex items-center gap-1 text-sm font-medium text-[#4FAEB2] hover:underline">
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

      {modal === "abrir" && <ModalAbrir onClose={() => setModal(null)} onOk={() => { setModal(null); cargar(); }} />}
      {modal === "movimiento" && abierta && <ModalMovimiento cajaId={abierta.caja.id} onClose={() => setModal(null)} onOk={() => { setModal(null); cargar(); }} />}
      {modal === "cerrar" && abierta && <ModalCerrar caja={abierta.caja} arqueo={abierta.arqueo} onClose={() => setModal(null)} onOk={() => { setModal(null); cargar(); }} />}
    </div>
  );
}

function Fila({ label, value, fuerte }: { label: string; value: number; fuerte?: boolean }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className={`text-sm ${fuerte ? "font-semibold text-slate-800" : "text-slate-500"}`}>{label}</span>
      <span className={`tabular-nums ${fuerte ? "text-base font-bold text-slate-900" : "text-sm text-slate-700"}`}>{fmtGs(value)}</span>
    </div>
  );
}

function CajaAbierta({ data, onMovimiento, onCerrar }: { data: { caja: Caja; arqueo: Arqueo }; onMovimiento: () => void; onCerrar: () => void }) {
  const { caja, arqueo } = data;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-emerald-800">
          <LockOpen className="h-4 w-4" /> Caja abierta · {fmtFechaHora(caja.abierta_at)} · {caja.abierta_por_nombre ?? ""}
        </div>
        <div className="flex gap-2">
          <button onClick={() => window.open(`/api/caja/${caja.id}/pdf?auto=1`, "_blank")} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50"><Printer className="h-4 w-4" /> Imprimir</button>
          <button onClick={onMovimiento} className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-300 bg-white px-3 py-1.5 text-sm font-medium text-emerald-700 hover:bg-emerald-50"><Plus className="h-4 w-4" /> Movimiento</button>
          <button onClick={onCerrar} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700"><Lock className="h-4 w-4" /> Cerrar caja</button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="mb-2 text-sm font-bold text-slate-700">Efectivo</h3>
          <Fila label="Monto de apertura" value={arqueo.monto_apertura} />
          <Fila label="+ Ventas en efectivo" value={arqueo.ventas_efectivo} />
          <Fila label="+ Cobros en efectivo" value={arqueo.cobros_efectivo} />
          <Fila label="+ Ingresos manuales" value={arqueo.ingresos_efectivo} />
          <Fila label="+ Ajustes" value={arqueo.ajustes_efectivo} />
          <Fila label="− Egresos" value={arqueo.egresos_efectivo} />
          <Fila label="− Retiros" value={arqueo.retiros_efectivo} />
          <div className="mt-2 border-t border-slate-200 pt-2"><Fila label="Efectivo esperado en caja" value={arqueo.efectivo_esperado} fuerte /></div>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="mb-2 text-sm font-bold text-slate-700">Ventas del turno (todos los medios)</h3>
          <Fila label="Efectivo" value={arqueo.ventas_efectivo} />
          <Fila label="Tarjeta" value={arqueo.ventas_tarjeta} />
          <Fila label="Transferencia" value={arqueo.ventas_transferencia} />
          <Fila label="A crédito (no ingresa a caja)" value={arqueo.ventas_credito} />
          <div className="mt-2 border-t border-slate-200 pt-2"><Fila label="Total vendido" value={arqueo.ventas_total} fuerte /></div>
        </div>
      </div>
    </div>
  );
}

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

/** Conteo físico por denominaciones (billetes y monedas). Total en vivo. */
function ArqueoContador({ onChange }: { onChange: (items: ArqueoItem[], total: number) => void }) {
  const [cant, setCant] = useState<Record<number, string>>({});
  function update(valor: number, raw: string) {
    const next = { ...cant, [valor]: raw };
    setCant(next);
    const items: ArqueoItem[] = [];
    let total = 0;
    for (const d of DENOMINACIONES) {
      const q = Math.max(0, Math.floor(Number(next[d.valor]) || 0));
      const v = q * d.valor;
      if (q > 0) items.push({ tipo: d.tipo, denominacion: d.valor, cantidad: q, valor: v });
      total += v;
    }
    onChange(items, total);
  }
  const total = DENOMINACIONES.reduce((s, d) => s + Math.max(0, Math.floor(Number(cant[d.valor]) || 0)) * d.valor, 0);
  return (
    <div className="max-h-64 overflow-auto rounded-lg border border-slate-200 divide-y divide-slate-100">
      {[...DENOMINACIONES].reverse().map((d) => {
        const q = Math.max(0, Math.floor(Number(cant[d.valor]) || 0));
        return (
          <div key={d.valor} className="flex items-center gap-2 px-3 py-1.5 text-sm">
            <span className="w-20 tabular-nums text-slate-700">{fmtGs(d.valor)}</span>
            <span className="w-12 text-[10px] uppercase tracking-wide text-slate-400">{d.tipo}</span>
            <span className="text-slate-300">×</span>
            <input type="number" min={0} step={1} value={cant[d.valor] ?? ""} onChange={(e) => update(d.valor, e.target.value)}
              className="w-16 rounded border border-slate-200 px-2 py-1 text-right tabular-nums focus:outline-none focus:ring-2 focus:ring-emerald-500" />
            <span className="ml-auto w-24 text-right tabular-nums text-slate-600">{fmtGs(q * d.valor)}</span>
          </div>
        );
      })}
      <div className="flex items-center justify-between bg-slate-50 px-3 py-2 text-sm font-bold">
        <span>Total contado</span><span className="tabular-nums text-slate-900">{fmtGs(total)}</span>
      </div>
    </div>
  );
}

function ModalAbrir({ onClose, onOk }: { onClose: () => void; onOk: () => void }) {
  const [monto, setMonto] = useState("0");
  const [obs, setObs] = useState("");
  const [porDenom, setPorDenom] = useState(false);
  const [arqueo, setArqueo] = useState<ArqueoItem[]>([]);
  const [arqueoTotal, setArqueoTotal] = useState(0);
  const { busy, err, post } = usePost();
  const efectivo = porDenom ? arqueoTotal : Number(monto) || 0;
  return (
    <Overlay titulo="Abrir caja" onClose={onClose}>
      <div className="space-y-4">
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={porDenom} onChange={(e) => setPorDenom(e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
          Contar por billetes y monedas
        </label>
        {porDenom ? (
          <ArqueoContador onChange={(items, total) => { setArqueo(items); setArqueoTotal(total); }} />
        ) : (
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">Monto de apertura (efectivo)</label>
            <input type="number" min={0} step="any" value={monto} onChange={(e) => setMonto(e.target.value)} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-right text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-emerald-500" />
          </div>
        )}
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">Observación (opcional)</label>
          <input value={obs} onChange={(e) => setObs(e.target.value)} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" />
        </div>
        {err && <p className="text-sm text-red-600">{err}</p>}
        <div className="flex items-center justify-between pt-1">
          <span className="text-sm text-slate-500">Apertura: <span className="font-semibold text-slate-800">{fmtGs(efectivo)}</span></span>
          <div className="flex gap-2">
            <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-slate-500 hover:text-slate-700">Cancelar</button>
            <button disabled={busy} onClick={async () => {
              const body = porDenom
                ? { arqueo_apertura: arqueo, observacion: obs.trim() || undefined }
                : { monto_apertura: Number(monto) || 0, observacion: obs.trim() || undefined };
              if (await post("/api/caja/abrir", body)) onOk();
            }} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">{busy ? "Abriendo…" : "Abrir caja"}</button>
          </div>
        </div>
      </div>
    </Overlay>
  );
}

function ModalMovimiento({ cajaId, onClose, onOk }: { cajaId: string; onClose: () => void; onOk: () => void }) {
  const [tipo, setTipo] = useState("ingreso");
  const [monto, setMonto] = useState("");
  const [concepto, setConcepto] = useState("");
  const [metodo, setMetodo] = useState("efectivo");
  const { busy, err, post } = usePost();
  return (
    <Overlay titulo="Registrar movimiento" onClose={onClose}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2">
          {([["ingreso", "Ingreso", ArrowDownCircle], ["egreso", "Egreso", ArrowUpCircle], ["retiro", "Retiro", ArrowUpCircle], ["ajuste", "Ajuste", Plus]] as const).map(([k, label, Icon]) => (
            <button key={k} onClick={() => setTipo(k)} className={`inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium ${tipo === k ? "border-emerald-500 bg-emerald-50 text-emerald-700" : "border-slate-200 text-slate-500 hover:bg-slate-50"}`}><Icon className="h-4 w-4" /> {label}</button>
          ))}
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">Monto</label>
          <input type="number" min={0} step="any" value={monto} onChange={(e) => setMonto(e.target.value)} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-right text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-emerald-500" />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">Método</label>
          <select value={metodo} onChange={(e) => setMetodo(e.target.value)} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500">
            <option value="efectivo">Efectivo</option><option value="transferencia">Transferencia</option><option value="tarjeta">Tarjeta</option>
          </select>
          <p className="mt-1 text-[11px] text-slate-500">Solo los movimientos en efectivo afectan el arqueo de caja.</p>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">Concepto</label>
          <input value={concepto} onChange={(e) => setConcepto(e.target.value)} placeholder="Ej: pago a delivery, retiro a banco…" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" />
        </div>
        {err && <p className="text-sm text-red-600">{err}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-slate-500 hover:text-slate-700">Cancelar</button>
          <button disabled={busy} onClick={async () => { if ((Number(monto) || 0) <= 0) return; if (await post("/api/caja/movimiento", { caja_id: cajaId, tipo, monto: Number(monto), concepto: concepto.trim() || undefined, metodo_pago: metodo })) onOk(); }} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">{busy ? "Guardando…" : "Registrar"}</button>
        </div>
      </div>
    </Overlay>
  );
}

function ModalCerrar({ caja, arqueo, onClose, onOk }: { caja: Caja; arqueo: Arqueo; onClose: () => void; onOk: () => void }) {
  const [contadoManual, setContadoManual] = useState("");
  const [obs, setObs] = useState("");
  const [porDenom, setPorDenom] = useState(false);
  const [arqueoItems, setArqueoItems] = useState<ArqueoItem[]>([]);
  const [arqueoTotal, setArqueoTotal] = useState(0);
  const { busy, err, post } = usePost();
  const contado = porDenom ? arqueoTotal : Number(contadoManual) || 0;
  const contadoDefinido = porDenom || contadoManual !== "";
  const dif = contado - arqueo.efectivo_esperado;
  return (
    <Overlay titulo="Cerrar caja (arqueo)" onClose={onClose}>
      <div className="space-y-4">
        <div className="rounded-lg bg-slate-50 px-3 py-2">
          <Fila label="Efectivo esperado" value={arqueo.efectivo_esperado} fuerte />
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={porDenom} onChange={(e) => setPorDenom(e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
          Contar por billetes y monedas
        </label>
        {porDenom ? (
          <ArqueoContador onChange={(items, total) => { setArqueoItems(items); setArqueoTotal(total); }} />
        ) : (
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">Efectivo físico contado</label>
            <input type="number" min={0} step="any" value={contadoManual} onChange={(e) => setContadoManual(e.target.value)} autoFocus className="w-full rounded-lg border border-slate-200 px-3 py-2 text-right text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-emerald-500" />
          </div>
        )}
        {contadoDefinido && (
          <div className={`rounded-lg px-3 py-2 text-sm font-semibold ${dif === 0 ? "bg-emerald-50 text-emerald-700" : dif < 0 ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-700"}`}>
            {dif === 0 ? "Cierre exacto" : dif < 0 ? `Faltante: ${fmtGs(Math.abs(dif))}` : `Sobrante: ${fmtGs(dif)}`}
          </div>
        )}
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">Observación (opcional)</label>
          <input value={obs} onChange={(e) => setObs(e.target.value)} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" />
        </div>
        {err && <p className="text-sm text-red-600">{err}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-slate-500 hover:text-slate-700">Cancelar</button>
          <button disabled={busy || !contadoDefinido} onClick={async () => {
            const body = porDenom
              ? { arqueo_cierre: arqueoItems, observacion: obs.trim() || undefined }
              : { efectivo_contado: Number(contadoManual) || 0, observacion: obs.trim() || undefined };
            if (await post(`/api/caja/${caja.id}/cerrar`, body)) onOk();
          }} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">{busy ? "Cerrando…" : "Cerrar caja"}</button>
        </div>
      </div>
    </Overlay>
  );
}
