"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getGastos, deleteGasto } from "@/lib/gastos/actions";
import type { Gasto } from "@/lib/gastos/actions";

function formatGs(valor: number) {
  return `${valor.toLocaleString("es-PY")} ₲`;
}

function formatFecha(fecha: string) {
  // `gastos.fecha` es un `date` (YYYY-MM-DD). Parsear con `new Date(fecha)` lo
  // interpreta como UTC 00:00, que en Paraguay (UTC-3/-4) cae al día anterior.
  // Parseamos manualmente para evitar el shift.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(fecha);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  try {
    return new Date(fecha).toLocaleDateString("es-PY", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      timeZone: "America/Asuncion",
    });
  } catch {
    return fecha;
  }
}

const tipoBadge: Record<string, string> = {
  fijo: "bg-blue-50 text-blue-700",
  variable: "bg-slate-100 text-slate-700",
};

const metodoPagoBadge: Record<string, { label: string; className: string }> = {
  efectivo: { label: "Efectivo", className: "bg-emerald-50 text-emerald-700" },
  transferencia: { label: "Transferencia", className: "bg-indigo-50 text-indigo-700" },
  tarjeta: { label: "Tarjeta", className: "bg-amber-50 text-amber-800" },
};

export default function GastosPage() {
  const [gastos, setGastos] = useState<Gasto[]>([]);
  const [cargando, setCargando] = useState(true);
  const [eliminando, setEliminando] = useState<string | null>(null);

  // Filtros client-side (getGastos() ya trae todo).
  const [busqueda, setBusqueda] = useState("");
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [tipoFiltro, setTipoFiltro] = useState<"" | "fijo" | "variable">("");
  const [metodoPagoFiltro, setMetodoPagoFiltro] = useState<
    "" | "efectivo" | "transferencia" | "tarjeta" | "sin_especificar"
  >("");

  const filtrados = gastos.filter((g) => {
    if (desde && g.fecha < desde) return false;
    if (hasta && g.fecha > hasta) return false;
    if (tipoFiltro && g.tipo !== tipoFiltro) return false;
    if (metodoPagoFiltro === "sin_especificar") {
      if (g.metodo_pago) return false;
    } else if (metodoPagoFiltro && g.metodo_pago !== metodoPagoFiltro) {
      return false;
    }
    if (busqueda.trim()) {
      const q = busqueda.trim().toLowerCase();
      const enCategoria = (g.categoria ?? "").toLowerCase().includes(q);
      const enDescripcion = (g.descripcion ?? "").toLowerCase().includes(q);
      const enBeneficiario = (g.beneficiario ?? "").toLowerCase().includes(q);
      if (!enCategoria && !enDescripcion && !enBeneficiario) return false;
    }
    return true;
  });

  const hayFiltros =
    busqueda.trim() !== "" ||
    desde !== "" ||
    hasta !== "" ||
    tipoFiltro !== "" ||
    metodoPagoFiltro !== "";

  const totalFiltrado = filtrados.reduce((s, g) => s + Number(g.monto ?? 0), 0);

  useEffect(() => {
    getGastos()
      .then(setGastos)
      .catch(() => setGastos([]))
      .finally(() => setCargando(false));
  }, []);

  async function handleEliminar(g: Gasto) {
    if (!confirm(`¿Eliminar el gasto "${g.descripcion || g.categoria || "sin descripción"}"?`)) return;
    setEliminando(g.id);
    try {
      await deleteGasto(g.id);
      setGastos((prev) => prev.filter((x) => x.id !== g.id));
    } catch {
      setEliminando(null);
    } finally {
      setEliminando(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="inline-block h-1.5 w-1.5 rounded-full bg-[#4FAEB2]"
              style={{ boxShadow: "0 0 0 3px rgba(79, 174, 178, 0.18)" }}
            />
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#4FAEB2]">
              Zentra · Egresos
            </p>
          </div>
          <h1 className="mt-1 text-lg font-semibold tracking-tight text-slate-900">Gastos operativos</h1>
          <p className="mt-0.5 text-xs text-slate-500">Registro de gastos de la empresa</p>
        </div>
        <Link
          href="/gastos/nuevo"
          className="flex shrink-0 items-center gap-1.5 rounded-lg bg-[#4FAEB2] px-3 py-1.5 text-xs font-semibold text-white shadow-sm shadow-[#4FAEB2]/25 transition-colors hover:bg-[#3F8E91] active:scale-95"
        >
          <span>+</span>
          Nuevo gasto
        </Link>
      </div>

      {gastos.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-3">
            <div className="lg:col-span-2">
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">
                Buscar
              </label>
              <input
                type="text"
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                placeholder="Categoría, beneficiario o descripción…"
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#4FAEB2] bg-white"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">
                Desde
              </label>
              <input
                type="date"
                value={desde}
                onChange={(e) => setDesde(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#4FAEB2] bg-white"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">
                Hasta
              </label>
              <input
                type="date"
                value={hasta}
                onChange={(e) => setHasta(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#4FAEB2] bg-white"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">
                Tipo
              </label>
              <select
                value={tipoFiltro}
                onChange={(e) => setTipoFiltro(e.target.value as "" | "fijo" | "variable")}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#4FAEB2] bg-white"
              >
                <option value="">Todos</option>
                <option value="variable">Variable</option>
                <option value="fijo">Fijo</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">
                Método de pago
              </label>
              <select
                value={metodoPagoFiltro}
                onChange={(e) =>
                  setMetodoPagoFiltro(
                    e.target.value as "" | "efectivo" | "transferencia" | "tarjeta" | "sin_especificar"
                  )
                }
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#4FAEB2] bg-white"
              >
                <option value="">Todos</option>
                <option value="efectivo">Efectivo</option>
                <option value="transferencia">Transferencia</option>
                <option value="tarjeta">Tarjeta</option>
                <option value="sin_especificar">Sin especificar</option>
              </select>
            </div>
          </div>
          {hayFiltros && (
            <div className="flex items-center justify-between gap-3 text-xs text-slate-500">
              <span>
                Mostrando <span className="font-semibold text-slate-800">{filtrados.length}</span> de{" "}
                <span className="font-semibold text-slate-800">{gastos.length}</span> gastos ·{" "}
                <span className="font-semibold text-[#4FAEB2]">{formatGs(totalFiltrado)}</span>
              </span>
              <button
                type="button"
                onClick={() => {
                  setBusqueda("");
                  setDesde("");
                  setHasta("");
                  setTipoFiltro("");
                  setMetodoPagoFiltro("");
                }}
                className="text-[#4FAEB2] hover:text-[#3F8E91] font-medium"
              >
                Limpiar filtros
              </button>
            </div>
          )}
        </div>
      )}

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm ring-1 ring-[#4FAEB2]/15">
        {cargando ? (
          <div className="py-16 text-center text-gray-400 text-sm animate-pulse">Cargando gastos…</div>
        ) : gastos.length === 0 ? (
          <div className="py-16 text-center text-gray-400">
            <p className="text-4xl mb-3">📋</p>
            <p className="font-medium text-gray-600">No hay gastos registrados</p>
            <Link
              href="/gastos/nuevo"
              className="mt-4 inline-block text-sm text-[#0EA5E9] hover:underline"
            >
              Registrar primer gasto
            </Link>
          </div>
        ) : (
          /* overflow-x-auto + min-w fuerza scroll horizontal en mobile;
              Categoria + Tipo se ocultan en pantallas chicas. */
          <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] sm:min-w-0">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50">
                <th className="text-left text-sm font-semibold text-slate-600 px-5 py-3">Fecha</th>
                <th className="text-left text-sm font-semibold text-slate-600 px-5 py-3 hidden lg:table-cell">Categoría</th>
                <th className="text-left text-sm font-semibold text-slate-600 px-5 py-3">Beneficiario</th>
                <th className="text-left text-sm font-semibold text-slate-600 px-5 py-3">Descripción</th>
                <th className="text-left text-sm font-semibold text-slate-600 px-5 py-3">Monto</th>
                <th className="text-left text-sm font-semibold text-slate-600 px-5 py-3">Pago</th>
                <th className="text-left text-sm font-semibold text-slate-600 px-5 py-3 hidden md:table-cell">Tipo</th>
                <th className="text-left text-sm font-semibold text-slate-600 px-5 py-3">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {filtrados.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-sm text-gray-400">
                    Ningún gasto coincide con los filtros aplicados.
                  </td>
                </tr>
              )}
              {filtrados.map((g) => (
                <tr key={g.id} className="hover:bg-[#4FAEB2]/[0.04] transition-colors">
                  <td className="px-5 py-3.5 text-sm text-gray-600">{formatFecha(g.fecha)}</td>
                  <td className="px-5 py-3.5 text-sm font-medium text-gray-800 hidden lg:table-cell">{g.categoria || "—"}</td>
                  <td className="px-5 py-3.5 text-sm text-gray-800 max-w-[180px] truncate">
                    {g.beneficiario || <span className="text-slate-400">—</span>}
                  </td>
                  <td className="px-5 py-3.5 text-sm text-gray-600 max-w-[200px] truncate">
                    {g.descripcion || "—"}
                  </td>
                  <td className="px-5 py-3.5 text-sm font-semibold text-gray-800 tabular-nums">
                    {formatGs(g.monto)}
                  </td>
                  <td className="px-5 py-3.5">
                    {g.metodo_pago ? (
                      <span
                        className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${metodoPagoBadge[g.metodo_pago]?.className ?? "bg-slate-100 text-slate-700"}`}
                      >
                        {metodoPagoBadge[g.metodo_pago]?.label ?? g.metodo_pago}
                      </span>
                    ) : (
                      <span className="text-slate-400 text-xs">—</span>
                    )}
                  </td>
                  <td className="px-5 py-3.5 hidden md:table-cell">
                    <span
                      className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${tipoBadge[g.tipo] ?? "bg-slate-100"}`}
                    >
                      {g.tipo}
                    </span>
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="flex gap-2">
                      <Link
                        href={`/gastos/${g.id}/editar`}
                        className="inline-flex items-center min-h-[40px] text-xs text-gray-500 hover:text-gray-800 underline"
                      >
                        Editar
                      </Link>
                      <button
                        type="button"
                        onClick={() => handleEliminar(g)}
                        disabled={eliminando === g.id}
                        className="inline-flex items-center min-h-[40px] text-xs text-red-500 hover:text-red-700 underline disabled:opacity-50"
                      >
                        {eliminando === g.id ? "…" : "Eliminar"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {gastos.length > 0 && !hayFiltros && (
        <p className="text-sm text-gray-500">
          <span className="font-semibold text-gray-800">{gastos.length}</span> gastos
        </p>
      )}
    </div>
  );
}
