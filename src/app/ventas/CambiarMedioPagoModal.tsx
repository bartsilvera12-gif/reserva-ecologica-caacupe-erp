"use client";

import { useEffect, useState } from "react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";

interface Props {
  ventaId: string;
  numeroControl: string;
  metodoActual: string | null;
  onClose: () => void;
  onCambiado: () => void;
}

type Cuenta = { id: string; nombre: string; tipo: string };

const inputClass =
  "mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-100";

export default function CambiarMedioPagoModal({ ventaId, numeroControl, metodoActual, onClose, onCambiado }: Props) {
  const [metodo, setMetodo] = useState(metodoActual === "efectivo" ? "transferencia" : "efectivo");
  const [tarjetaTipo, setTarjetaTipo] = useState("debito");
  const [cuentas, setCuentas] = useState<Cuenta[]>([]);
  const [cuentaId, setCuentaId] = useState("");
  const [referencia, setReferencia] = useState("");
  const [titular, setTitular] = useState("");
  const [motivo, setMotivo] = useState("");
  const [confirmarConc, setConfirmarConc] = useState(false);
  const [pideConfirmar, setPideConfirmar] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetchWithSupabaseSession("/api/cuentas?lista=1");
        const body = await res.json().catch(() => ({}));
        setCuentas((body?.data?.cuentas ?? []) as Cuenta[]);
      } catch {
        setCuentas([]);
      }
    })();
  }, []);

  const noEfectivo = metodo !== "efectivo";
  const puedeEnviar =
    motivo.trim().length >= 5 && !enviando && (!noEfectivo || cuentas.length === 0 || cuentaId !== "") && (!pideConfirmar || confirmarConc);

  async function handleSubmit() {
    if (!puedeEnviar) return;
    setEnviando(true);
    setError(null);
    try {
      const res = await fetchWithSupabaseSession(`/api/ventas/${ventaId}/medio-pago`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          metodo_pago: metodo,
          tarjeta_tipo: metodo === "tarjeta" ? tarjetaTipo : null,
          cuenta_id: noEfectivo ? cuentaId || null : null,
          referencia: referencia || null,
          titular: titular || null,
          motivo: motivo.trim(),
          confirmar_conciliado: confirmarConc,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.success === false) {
        const msg = String(body?.error ?? "No se pudo cambiar el medio de pago.");
        if (res.status === 409 && msg.includes("Conciliación")) setPideConfirmar(true);
        setError(msg);
        return;
      }
      onCambiado();
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
        <h3 className="text-lg font-semibold text-slate-900">Cambiar medio de pago — venta {numeroControl}</h3>
        <p className="mt-1 text-sm text-slate-600">
          No modifica stock, factura ni SIFEN. Queda registrado quién lo cambió y el motivo.
        </p>

        <label className="mt-4 block text-sm font-medium text-slate-800">Nuevo medio de pago</label>
        <select value={metodo} onChange={(e) => setMetodo(e.target.value)} className={inputClass}>
          <option value="efectivo">Efectivo</option>
          <option value="transferencia">Transferencia</option>
          <option value="tarjeta">Tarjeta</option>
          <option value="qr">QR</option>
          <option value="billetera">Billetera</option>
        </select>

        {metodo === "tarjeta" && (
          <>
            <label className="mt-3 block text-sm font-medium text-slate-800">Tipo de tarjeta</label>
            <select value={tarjetaTipo} onChange={(e) => setTarjetaTipo(e.target.value)} className={inputClass}>
              <option value="debito">Débito</option>
              <option value="credito">Crédito</option>
            </select>
          </>
        )}

        {noEfectivo && (
          <>
            <label className="mt-3 block text-sm font-medium text-slate-800">Cuenta donde se acredita</label>
            <select value={cuentaId} onChange={(e) => setCuentaId(e.target.value)} className={inputClass}>
              <option value="">Elegí una cuenta…</option>
              {cuentas.map((c) => (
                <option key={c.id} value={c.id}>{c.nombre}</option>
              ))}
            </select>
            <label className="mt-3 block text-sm font-medium text-slate-800">Referencia</label>
            <input value={referencia} onChange={(e) => setReferencia(e.target.value)} className={inputClass} />
            <label className="mt-3 block text-sm font-medium text-slate-800">Titular</label>
            <input value={titular} onChange={(e) => setTitular(e.target.value)} className={inputClass} />
          </>
        )}

        <label className="mt-3 block text-sm font-medium text-slate-800">
          Motivo <span className="text-rose-600">*</span>
        </label>
        <textarea
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          rows={2}
          placeholder="Ej: el cliente pagó por transferencia al recibir el pedido"
          className={inputClass}
        />

        {pideConfirmar && (
          <label className="mt-3 flex items-start gap-2 text-sm text-amber-800">
            <input type="checkbox" checked={confirmarConc} onChange={(e) => setConfirmarConc(e.target.checked)} className="mt-1" />
            El pago ya estaba aprobado en Conciliación. Confirmo el cambio (vuelve a quedar pendiente).
          </label>
        )}

        {error && (
          <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={enviando}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
            Cancelar
          </button>
          <button type="button" onClick={handleSubmit} disabled={!puedeEnviar}
            className="rounded-lg bg-sky-700 px-3 py-2 text-sm font-semibold text-white hover:bg-sky-800 disabled:cursor-not-allowed disabled:opacity-50">
            {enviando ? "Guardando…" : "Guardar cambio"}
          </button>
        </div>
      </div>
    </div>
  );
}
