"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import { Wallet, X, Loader2, AlertTriangle, Search } from "lucide-react";

type Cuenta = {
  id: string;
  compra_numero_control: string;
  proveedor_nombre: string;
  numero_factura_proveedor: string | null;
  fecha_factura: string | null;
  fecha_vencimiento: string | null;
  moneda: string;
  monto_original: number;
  nc_aplicado: number;
  pagado: number;
  saldo: number;
  estado: string;
  vencida: boolean;
  dias_para_vencer: number | null;
};

function fmtGs(n: number, moneda = "PYG") {
  return (moneda === "USD" ? "USD " : "Gs. ") + Math.round(Number(n) || 0).toLocaleString("es-PY");
}
function fmtFecha(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return d && m && y ? `${d}/${m}/${y}` : iso;
}

function EstadoBadge({ c }: { c: Cuenta }) {
  if (c.estado === "anulada") return <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-500">Anulada</span>;
  if (c.estado === "pagada") return <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">Pagada</span>;
  if (c.vencida) return <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">Vencida</span>;
  if (c.estado === "parcial") return <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs font-semibold text-sky-700">Parcial</span>;
  return <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">Pendiente</span>;
}

export default function CuentasPorPagarPage() {
  const [cuentas, setCuentas] = useState<Cuenta[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<"pendientes" | "todas">("pendientes");
  const [pagar, setPagar] = useState<Cuenta | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      const res = await fetchWithSupabaseSession("/api/cuentas-por-pagar", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "No se pudo cargar.");
      setCuentas(json?.data?.cuentas ?? []);
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
    return cuentas
      .filter((c) => (tab === "todas" ? true : c.estado !== "pagada" && c.estado !== "anulada" && c.saldo > 0))
      .filter((c) =>
        t === "" ||
        c.proveedor_nombre.toLowerCase().includes(t) ||
        c.compra_numero_control.toLowerCase().includes(t) ||
        (c.numero_factura_proveedor?.toLowerCase().includes(t) ?? false)
      );
  }, [cuentas, q, tab]);

  const totalSaldo = useMemo(() => visibles.reduce((a, c) => a + c.saldo, 0), [visibles]);

  return (
    <div className="w-full space-y-6">
      <div>
        <h1 className="flex items-center gap-2.5 text-2xl font-bold text-slate-900">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#4FAEB2]/10 text-[#4FAEB2]">
            <Wallet className="h-5 w-5" />
          </span>
          Cuentas por pagar
        </h1>
        <p className="mt-1 text-sm text-slate-500">Facturas de proveedores a crédito, saldos y pagos de tu sucursal.</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
          {([["pendientes", "Con saldo"], ["todas", "Todas"]] as const).map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${tab === k ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
              {label}
            </button>
          ))}
        </div>
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Proveedor, factura o COMP…"
            className="w-full rounded-xl border border-slate-200 py-2.5 pl-9 pr-3 text-sm focus:border-[#4FAEB2] focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/30" />
        </div>
        <span className="ml-auto text-sm text-slate-500">Saldo mostrado: <span className="font-semibold text-slate-800">{fmtGs(totalSaldo)}</span></span>
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
        {cargando ? (
          <div className="flex items-center justify-center gap-2 px-4 py-16 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /> Cargando…</div>
        ) : visibles.length === 0 ? (
          <div className="px-4 py-16 text-center text-sm text-slate-400">No hay cuentas por pagar para mostrar.</div>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50/80 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3 font-semibold">Factura / Control</th>
                <th className="px-4 py-3 font-semibold">Proveedor</th>
                <th className="px-4 py-3 font-semibold">Vence</th>
                <th className="px-4 py-3 font-semibold text-right">Monto</th>
                <th className="px-4 py-3 font-semibold text-right">Saldo</th>
                <th className="px-4 py-3 font-semibold">Estado</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {visibles.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-800">{c.numero_factura_proveedor || <span className="italic text-slate-400">Sin número</span>}</div>
                    <div className="font-mono text-[11px] text-slate-400">{c.compra_numero_control}</div>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{c.proveedor_nombre || "—"}</td>
                  <td className="px-4 py-3 text-slate-600">
                    {fmtFecha(c.fecha_vencimiento)}
                    {c.vencida && <span className="ml-1 text-xs font-semibold text-red-600">({Math.abs(c.dias_para_vencer ?? 0)}d)</span>}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-500">{fmtGs(c.monto_original, c.moneda)}</td>
                  <td className="px-4 py-3 text-right tabular-nums font-semibold text-slate-800">{fmtGs(c.saldo, c.moneda)}</td>
                  <td className="px-4 py-3"><EstadoBadge c={c} /></td>
                  <td className="px-4 py-3 text-right">
                    {c.estado !== "anulada" && c.saldo > 0 && (
                      <button onClick={() => setPagar(c)} className="rounded-lg bg-[#4FAEB2] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#3F8E91]">
                        Registrar pago
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {pagar && (
        <ModalPago cuenta={pagar} onClose={() => setPagar(null)} onPagado={() => { setPagar(null); cargar(); }} />
      )}
    </div>
  );
}

function ModalPago({ cuenta, onClose, onPagado }: { cuenta: Cuenta; onClose: () => void; onPagado: () => void }) {
  const [monto, setMonto] = useState(String(Math.round(cuenta.saldo)));
  const [metodo, setMetodo] = useState("efectivo");
  const [referencia, setReferencia] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function guardar() {
    setErr(null);
    const m = Number(monto) || 0;
    if (m <= 0) return setErr("El monto debe ser mayor a 0.");
    if (m > cuenta.saldo) return setErr(`El pago supera el saldo (${Math.round(cuenta.saldo).toLocaleString("es-PY")}).`);
    setGuardando(true);
    try {
      const res = await fetchWithSupabaseSession(`/api/cuentas-por-pagar/${cuenta.id}/pago`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ monto: m, metodo_pago: metodo, referencia: referencia.trim() || undefined }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "No se pudo registrar.");
      onPagado();
    } catch (e) {
      setGuardando(false);
      setErr(e instanceof Error ? e.message : "Error al registrar el pago.");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:items-center">
      <div className="my-8 w-full max-w-md rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h2 className="text-lg font-semibold text-slate-900">Registrar pago</h2>
          <button onClick={onClose} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"><X className="h-5 w-5" /></button>
        </div>
        <div className="space-y-4 px-5 py-4">
          <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
            {cuenta.proveedor_nombre} · {cuenta.numero_factura_proveedor || cuenta.compra_numero_control}
            <div className="mt-0.5 text-xs">Saldo pendiente: <span className="font-semibold text-slate-800">{fmtGs(cuenta.saldo, cuenta.moneda)}</span></div>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">Monto</label>
            <input type="number" min={0} max={cuenta.saldo} step="any" value={monto} onChange={(e) => setMonto(e.target.value)}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-right text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]" />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">Método</label>
            <select value={metodo} onChange={(e) => setMetodo(e.target.value)}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]">
              <option value="efectivo">Efectivo</option>
              <option value="transferencia">Transferencia</option>
              <option value="tarjeta">Tarjeta</option>
              <option value="otro">Otro</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">Referencia (opcional)</label>
            <input value={referencia} onChange={(e) => setReferencia(e.target.value)} placeholder="N° de comprobante / nota"
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]" />
          </div>
          {err && <p className="flex items-start gap-1.5 text-sm text-red-600"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{err}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-slate-500 hover:text-slate-700">Cancelar</button>
            <button onClick={guardar} disabled={guardando}
              className="rounded-lg bg-[#4FAEB2] px-4 py-2 text-sm font-semibold text-white hover:bg-[#3F8E91] disabled:opacity-50">
              {guardando ? "Registrando…" : "Registrar pago"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
