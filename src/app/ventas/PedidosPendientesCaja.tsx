"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, X } from "lucide-react";

type PedidoPendiente = {
  id: string;
  titulo: string;
  cliente_nombre: string | null;
  total_estimado: number;
  origen: string;
  fecha: string | null;
  items: { producto_nombre: string; cantidad: number }[];
};

const ORIGEN_LABEL: Record<string, string> = {
  presupuesto: "Presupuesto",
  venta: "Venta",
  manual: "Manual",
};

function fmtGs(n: number) {
  return "Gs. " + Math.round(n || 0).toLocaleString("es-PY");
}
function fmtFecha(iso: string | null) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("es-PY", { day: "2-digit", month: "2-digit", year: "numeric" });
  } catch {
    return iso;
  }
}

export default function PedidosPendientesCaja() {
  const [pedidos, setPedidos] = useState<PedidoPendiente[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmar, setConfirmar] = useState<PedidoPendiente | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [errorModal, setErrorModal] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    fetch("/api/caja/pedidos-pendientes", { credentials: "include", cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (cancel) return;
        if (j?.success && Array.isArray(j.data?.pedidos)) setPedidos(j.data.pedidos as PedidoPendiente[]);
      })
      .catch(() => {})
      .finally(() => { if (!cancel) setLoading(false); });
    return () => { cancel = true; };
  }, []);

  function abrirConfirmacion(p: PedidoPendiente) {
    if (enviando) return;
    setErrorModal(null);
    setConfirmar(p);
  }

  function cerrarConfirmacion() {
    if (enviando) return;
    setConfirmar(null);
    setErrorModal(null);
  }

  async function ejecutarCancelar() {
    if (!confirmar || enviando) return;
    const p = confirmar;
    setEnviando(true);
    setErrorModal(null);
    try {
      const res = await fetch(`/api/caja/pedidos-pendientes/${p.id}/cancelar`, {
        method: "POST",
        credentials: "include",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.success === false) {
        setErrorModal(body?.error ?? "No se pudo cancelar el pedido.");
        return;
      }
      setPedidos((prev) => prev.filter((x) => x.id !== p.id));
      setConfirmar(null);
    } catch {
      setErrorModal("Error de red al cancelar el pedido.");
    } finally {
      setEnviando(false);
    }
  }

  // Mientras carga, no ocupar espacio; si no hay pendientes, no mostrar la sección.
  if (loading || pedidos.length === 0) return null;

  return (
    <>
      <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-4 shadow-sm sm:p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-amber-900">
            Pedidos pendientes de facturación
            <span className="ml-2 rounded-full bg-amber-200 px-2 py-0.5 text-xs font-semibold text-amber-800">
              {pedidos.length}
            </span>
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] text-left text-sm">
            <thead className="text-xs uppercase text-amber-700/80">
              <tr>
                <th className="py-2 pr-4 font-medium">Pedido</th>
                <th className="py-2 pr-4 font-medium">Cliente</th>
                <th className="py-2 pr-4 font-medium">Items</th>
                <th className="py-2 pr-4 font-medium text-right">Total estimado</th>
                <th className="py-2 pr-4 font-medium">Origen</th>
                <th className="py-2 pr-4 font-medium">Fecha</th>
                <th className="py-2 pr-2 font-medium text-right">Acción</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-amber-100">
              {pedidos.map((p) => (
                <tr key={p.id} className="align-middle">
                  <td className="py-2.5 pr-4 font-medium text-slate-800">{p.titulo || "Pedido"}</td>
                  <td className="py-2.5 pr-4 text-slate-600">{p.cliente_nombre ?? "—"}</td>
                  <td className="py-2.5 pr-4 text-slate-600">
                    {p.items.length === 0
                      ? "—"
                      : p.items.slice(0, 2).map((it) => `${it.cantidad}× ${it.producto_nombre}`).join(", ") +
                        (p.items.length > 2 ? ` +${p.items.length - 2}` : "")}
                  </td>
                  <td className="py-2.5 pr-4 text-right tabular-nums font-semibold text-slate-800">{fmtGs(p.total_estimado)}</td>
                  <td className="py-2.5 pr-4">
                    <span className="rounded-full bg-white px-2 py-0.5 text-xs font-medium text-slate-600 ring-1 ring-slate-200">
                      {ORIGEN_LABEL[p.origen] ?? p.origen}
                    </span>
                  </td>
                  <td className="py-2.5 pr-4 text-slate-500">{fmtFecha(p.fecha)}</td>
                  <td className="py-2.5 pr-2 text-right">
                    <div className="inline-flex items-center gap-2">
                      <Link
                        href={`/ventas/nueva?pedido_id=${p.id}`}
                        className="inline-flex items-center rounded-lg bg-[#4FAEB2] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#3F8E91]"
                      >
                        Facturar / Cobrar
                      </Link>
                      <button
                        type="button"
                        onClick={() => abrirConfirmacion(p)}
                        className="inline-flex items-center rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50"
                        title="Cancelar el pedido. No afecta stock. Si vino de presupuesto, se libera para re-facturar."
                      >
                        Cancelar
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {confirmar && (
        <ConfirmarCancelarModal
          pedido={confirmar}
          enviando={enviando}
          error={errorModal}
          onClose={cerrarConfirmacion}
          onConfirmar={ejecutarCancelar}
        />
      )}
    </>
  );
}

function ConfirmarCancelarModal({
  pedido,
  enviando,
  error,
  onClose,
  onConfirmar,
}: {
  pedido: PedidoPendiente;
  enviando: boolean;
  error: string | null;
  onClose: () => void;
  onConfirmar: () => void;
}) {
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !enviando) onClose();
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [onClose, enviando]);

  const desdePresupuesto = pedido.origen === "presupuesto";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget && !enviando) onClose();
      }}
    >
      <div className="w-full max-w-md overflow-hidden rounded-xl bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-red-50">
              <AlertTriangle className="h-5 w-5 text-red-600" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-slate-900">Cancelar pedido</h3>
              <p className="text-xs text-slate-500">Esta acción no se puede deshacer.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={enviando}
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-50"
            aria-label="Cerrar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 px-5 py-4 text-sm text-slate-700">
          <p>
            ¿Cancelar el pedido{" "}
            <span className="font-semibold text-slate-900">
              &ldquo;{pedido.titulo || pedido.id}&rdquo;
            </span>
            ?
          </p>
          <ul className="space-y-1.5 rounded-lg bg-slate-50 px-3 py-2.5 text-xs text-slate-600">
            <li className="flex items-start gap-2">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400" />
              <span>No afecta el stock (el pedido nunca lo descontó).</span>
            </li>
            {desdePresupuesto ? (
              <li className="flex items-start gap-2">
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                <span>
                  El presupuesto origen volverá a estado <span className="font-medium">&ldquo;aprobado&rdquo;</span>{" "}
                  y podrás re-facturarlo o crear otro pedido.
                </span>
              </li>
            ) : (
              <li className="flex items-start gap-2">
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400" />
                <span>El pedido dejará de aparecer en la caja.</span>
              </li>
            )}
          </ul>

          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={enviando}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            Volver
          </button>
          <button
            type="button"
            onClick={onConfirmar}
            disabled={enviando}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
          >
            {enviando ? "Cancelando…" : "Sí, cancelar pedido"}
          </button>
        </div>
      </div>
    </div>
  );
}
