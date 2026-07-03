"use client";

import { useEffect, useState } from "react";
import { anularVenta } from "@/lib/ventas/storage";

interface Props {
  ventaId: string;
  numeroControl: string;
  onClose: () => void;
  onAnulada: () => void;
}

export default function AnularVentaModal({ ventaId, numeroControl, onClose, onAnulada }: Props) {
  const [motivo, setMotivo] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !enviando) onClose();
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [onClose, enviando]);

  const motivoTrim = motivo.trim();
  const puedeEnviar = motivoTrim.length >= 5 && !enviando;

  async function handleSubmit() {
    if (!puedeEnviar) return;
    setEnviando(true);
    setError(null);
    const res = await anularVenta(ventaId, motivoTrim);
    setEnviando(false);
    if (!res.success) {
      setError(res.error);
      return;
    }
    onAnulada();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget && !enviando) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
        <h3 className="text-lg font-semibold text-slate-900">Anular venta {numeroControl}</h3>
        <p className="mt-1 text-sm text-slate-600">
          Se reintegra el stock vendido y se registra el motivo. Si la venta tiene cobros aplicados, primero
          debés revertirlos.
        </p>

        <label className="mt-4 block text-sm font-medium text-slate-800">
          Motivo <span className="text-rose-600">*</span>
        </label>
        <textarea
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          disabled={enviando}
          rows={3}
          placeholder="Ej: cliente devolvió pedido, error de cargador…"
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-rose-500 focus:outline-none focus:ring-2 focus:ring-rose-100"
        />
        <p className="mt-1 text-xs text-slate-500">Mínimo 5 caracteres.</p>

        {error && (
          <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
            {error}
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={enviando}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!puedeEnviar}
            className="rounded-lg bg-rose-700 px-3 py-2 text-sm font-semibold text-white hover:bg-rose-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {enviando ? "Anulando…" : "Anular venta"}
          </button>
        </div>
      </div>
    </div>
  );
}
