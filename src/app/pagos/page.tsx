"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { enRangoCalendario, hoyYmdLocal, rangoDesdeHastaInputs, toCalendarDateStr } from "@/lib/fechas/calendario";
import { getFacturas } from "@/lib/gestion-clientes/storage";
import MontoInput from "@/components/ui/MontoInput";
import { getClientes } from "@/lib/clientes/storage";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import { apiCreatePago } from "@/lib/api/client";
import type { Factura } from "@/lib/gestion-clientes/types";

const inputClass = "w-full border border-slate-200 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-[#0EA5E9] focus:outline-none bg-white text-sm";
const labelClass = "block text-xs font-medium text-slate-500 mb-1";

type TabPagos = "pendientes" | "cobrados";

function formatFecha(str: string) {
  if (!str) return "—";
  const [y, m, d] = str.split("-");
  return `${d}/${m}/${y}`;
}

interface PagoCobrado {
  id: string;
  factura_numero: string;
  cliente_nombre: string;
  monto: number;
  fecha_pago: string;
  metodo_pago: string;
  usuario_email: string;
  referencia?: string;
}

export default function PagosPage() {
  const [tab, setTab] = useState<TabPagos>("pendientes");
  const [facturas, setFacturas] = useState<Factura[]>([]);
  const [clientes, setClientes] = useState<{ id: string; nombre: string; estado: string }[]>([]);
  const [cobrados, setCobrados] = useState<PagoCobrado[]>([]);
  const [cargandoCobrados, setCargandoCobrados] = useState(false);
  const [modalPago, setModalPago] = useState(false);
  const [facturaSeleccionada, setFacturaSeleccionada] = useState<Factura | null>(null);
  const [formPago, setFormPago] = useState({ monto: "", fecha_pago: "", metodo_pago: "efectivo" as const, referencia: "" });
  const [guardando, setGuardando] = useState(false);
  const [filtroDesde, setFiltroDesde] = useState("");
  const [filtroHasta, setFiltroHasta] = useState("");

  const rangoFechas = useMemo(
    () => rangoDesdeHastaInputs(filtroDesde, filtroHasta),
    [filtroDesde, filtroHasta]
  );

  const fechaEnRangoCalendario = useCallback(
    (fechaRaw: string): boolean => {
      if (!rangoFechas) return true;
      const cal = toCalendarDateStr(fechaRaw);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(cal)) return false;
      return enRangoCalendario(cal, rangoFechas.desde, rangoFechas.hasta);
    },
    [rangoFechas]
  );

  useEffect(() => {
    getFacturas().then(setFacturas);
    getClientes().then((c) =>
      setClientes(
        c.map((x) => ({
          id: x.id,
          nombre: (x.empresa ?? x.nombre_contacto) || "—",
          estado: x.estado ?? "activo",
        }))
      )
    );
  }, []);

  async function fetchCobrados() {
    setCargandoCobrados(true);
    try {
      const res = await fetchWithSupabaseSession("/api/pagos");
      const json = await res.json();
      if (json.success && Array.isArray(json.data)) {
        setCobrados(
          json.data.map((p: Record<string, unknown>) => ({
            id: p.id as string,
            factura_numero: (p.factura_numero as string) ?? "—",
            cliente_nombre: (p.cliente_nombre as string) ?? "—",
            monto: Number(p.monto) || 0,
            fecha_pago: toCalendarDateStr((p.fecha_pago as string) ?? "") || String(p.fecha_pago ?? "").slice(0, 10),
            metodo_pago: (p.metodo_pago as string) ?? "efectivo",
            usuario_email: (p.usuario_email as string) ?? "—",
            referencia: (p.referencia as string) || undefined,
          }))
        );
      } else {
        setCobrados([]);
      }
    } catch {
      setCobrados([]);
    } finally {
      setCargandoCobrados(false);
    }
  }

  useEffect(() => {
    if (tab === "cobrados") fetchCobrados();
  }, [tab]);

  const pendientesBase = useMemo(
    () =>
      facturas.filter((f) => {
        if (f.saldo <= 0 || f.estado === "Anulado" || f.estado === "Corregida NC") return false;
        const cli = clientes.find((c) => c.id === f.cliente_id);
        if (cli?.estado === "inactivo") return false;
        return true;
      }),
    [facturas, clientes]
  );

  const pendientes = useMemo(() => {
    if (!rangoFechas) return pendientesBase;
    return pendientesBase.filter(
      (f) =>
        fechaEnRangoCalendario(f.fecha) ||
        fechaEnRangoCalendario(f.fecha_vencimiento)
    );
  }, [pendientesBase, rangoFechas, fechaEnRangoCalendario]);

  const cobradosFiltrados = useMemo(() => {
    if (!rangoFechas) return cobrados;
    return cobrados.filter((p) => fechaEnRangoCalendario(p.fecha_pago));
  }, [cobrados, rangoFechas, fechaEnRangoCalendario]);

  /** Total de la vista actual (respeta el mismo filtro de fechas que la tabla). */
  const totalCobradoVista = useMemo(
    () => cobradosFiltrados.reduce((acc, p) => acc + (Number.isFinite(p.monto) ? p.monto : 0), 0),
    [cobradosFiltrados]
  );

  const clienteMap = Object.fromEntries(clientes.map((c) => [c.id, c.nombre]));

  async function handleRegistrarPago(e: React.FormEvent) {
    e.preventDefault();
    const f = facturaSeleccionada;
    if (!f) return;
    const monto = parseFloat(formPago.monto) || 0;
    if (monto > f.saldo) {
      alert("El monto del pago no puede superar el saldo pendiente de la factura.");
      return;
    }
    setGuardando(true);
    const result = await apiCreatePago({
      factura_id: f.id,
      monto,
      fecha_pago: formPago.fecha_pago,
      metodo_pago: formPago.metodo_pago,
      referencia: formPago.referencia || undefined,
    });
    setGuardando(false);
    if (result) {
      setModalPago(false);
      setFacturaSeleccionada(null);
      getFacturas().then(setFacturas);
      if (tab === "cobrados") fetchCobrados();
    } else {
      alert("Error al registrar el pago. Verifique que el monto no supere el saldo.");
    }
  }

  const METODO_LABELS: Record<string, string> = {
    efectivo: "Efectivo",
    transferencia: "Transferencia",
    cheque: "Cheque",
    tarjeta: "Tarjeta",
    otro: "Otro",
  };

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold text-gray-800">Pagos</h1>
        <p className="text-sm text-gray-500 mt-0.5">Registrar pagos de facturas pendientes de cobro</p>
      </div>

      <div className="flex gap-3 border-b border-slate-200">
        <button
          type="button"
          onClick={() => setTab("pendientes")}
          className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
            tab === "pendientes" ? "bg-white border border-slate-200 border-b-white -mb-px text-[#0EA5E9]" : "text-slate-600 hover:text-slate-800"
          }`}
        >
          Pendientes
        </button>
        <button
          type="button"
          onClick={() => setTab("cobrados")}
          className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
            tab === "cobrados" ? "bg-white border border-slate-200 border-b-white -mb-px text-[#0EA5E9]" : "text-slate-600 hover:text-slate-800"
          }`}
        >
          Cobrados
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-slate-50/80 px-4 py-3 text-sm">
        <p className="w-full text-xs text-slate-500 sm:w-auto sm:mr-2">
          Filtro por fechas (calendario local, mismo criterio que el dashboard). Se aplica al elegir desde/hasta.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className={labelClass}>Desde</label>
            <input
              type="date"
              value={filtroDesde}
              onChange={(e) => setFiltroDesde(e.target.value)}
              className={`${inputClass} w-[11rem]`}
            />
          </div>
          <div>
            <label className={labelClass}>Hasta</label>
            <input
              type="date"
              value={filtroHasta}
              onChange={(e) => setFiltroHasta(e.target.value)}
              className={`${inputClass} w-[11rem]`}
            />
          </div>
          <button
            type="button"
            onClick={() => {
              setFiltroDesde("");
              setFiltroHasta("");
            }}
            className="border border-slate-300 bg-white px-3 py-2 rounded-lg text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Limpiar filtros
          </button>
        </div>
      </div>

      {tab === "pendientes" && (
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-700">Facturas pendientes de cobro</h2>
          <span className="text-xs text-slate-500">
            {rangoFechas
              ? `${pendientes.length} en el rango · ${pendientesBase.length} con saldo en total`
              : `${pendientes.length} facturas con saldo`}
          </span>
        </div>
        {pendientes.length === 0 ? (
          <div className="p-12 text-center text-slate-500">
            <p className="text-sm">No hay facturas pendientes de cobro.</p>
            <Link href="/clientes" className="text-[#0EA5E9] hover:underline text-sm mt-2 inline-block">
              Ir a Clientes →
            </Link>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50">
                <tr>
                  {["Número", "Cliente", "Fecha", "Vencimiento", "Total", "Saldo", "Estado", "Acción"].map((h) => (
                    <th key={h} className="text-left text-xs font-semibold text-slate-600 px-4 py-3">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {pendientes.map((f) => (
                  <tr key={f.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-mono text-slate-800">{f.numero_factura}</td>
                    <td className="px-4 py-3">
                      <Link href={`/clientes/${f.cliente_id}`} className="text-[#0EA5E9] hover:underline truncate max-w-[140px] block">
                        {clienteMap[f.cliente_id] ?? `Cliente #${f.cliente_id.slice(0, 8)}`}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{formatFecha(f.fecha)}</td>
                    <td className="px-4 py-3 text-slate-600">{formatFecha(f.fecha_vencimiento)}</td>
                    <td className="px-4 py-3 font-semibold text-slate-800">Gs. {f.monto.toLocaleString("es-PY")}</td>
                    <td className="px-4 py-3 font-semibold text-amber-600">Gs. {f.saldo.toLocaleString("es-PY")}</td>
                    <td className="px-4 py-3">
                      <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">{f.estado}</span>
                    </td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => {
                          setFacturaSeleccionada(f);
                          setFormPago({ monto: String(f.saldo), fecha_pago: hoyYmdLocal(), metodo_pago: "efectivo", referencia: "" });
                          setModalPago(true);
                        }}
                        className="text-xs font-medium text-[#0EA5E9] hover:underline"
                      >
                        Registrar pago
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      )}

      {tab === "cobrados" && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-slate-700">Pagos registrados</h2>
              <p className="text-[11px] text-slate-500 mt-0.5">
                Solo filas de la tabla de pagos (mismo criterio que “Cobrado del período” en el dashboard financiero).
              </p>
            </div>
            <span className="text-xs text-slate-500">
              {rangoFechas && cobrados.length > 0
                ? `${cobradosFiltrados.length} en el rango · ${cobrados.length} pagos en total`
                : `${cobradosFiltrados.length} pago${cobradosFiltrados.length === 1 ? "" : "s"}`}
            </span>
          </div>
          {cargandoCobrados ? (
            <div className="p-12 text-center text-slate-500 text-sm">Cargando…</div>
          ) : cobrados.length === 0 ? (
            <div className="p-12 text-center text-slate-500">
              <p className="text-sm">No hay pagos registrados.</p>
              <span className="text-xs mt-2 block">Los pagos aparecerán aquí cuando los registres.</span>
            </div>
          ) : cobradosFiltrados.length === 0 ? (
            <div className="p-12 text-center text-slate-500">
              <p className="text-sm">Ningún pago en el rango de fechas seleccionado.</p>
              <button
                type="button"
                onClick={() => {
                  setFiltroDesde("");
                  setFiltroHasta("");
                }}
                className="text-[#0EA5E9] hover:underline text-xs mt-2"
              >
                Limpiar filtros
              </button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    {["Factura", "Cliente", "Monto pagado", "Fecha", "Método", "Usuario", "Referencia"].map((h) => (
                      <th key={h} className="text-left text-xs font-semibold text-slate-600 px-4 py-3">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {cobradosFiltrados.map((p) => (
                    <tr key={p.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3 font-mono text-slate-800">{p.factura_numero}</td>
                      <td className="px-4 py-3 text-slate-700 truncate max-w-[140px]">{p.cliente_nombre}</td>
                      <td className="px-4 py-3 font-semibold text-slate-800">Gs. {p.monto.toLocaleString("es-PY")}</td>
                      <td className="px-4 py-3 text-slate-600">{formatFecha(p.fecha_pago)}</td>
                      <td className="px-4 py-3 text-slate-600">{METODO_LABELS[p.metodo_pago] ?? p.metodo_pago}</td>
                      <td className="px-4 py-3 text-slate-600">{p.usuario_email}</td>
                      <td className="px-4 py-3 text-slate-500">{p.referencia || "—"}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-slate-50/90 border-t-2 border-slate-200">
                    <td colSpan={2} className="px-4 py-3 text-xs font-semibold text-slate-700">
                      Total cobrado {rangoFechas ? "en el rango" : "en esta vista"}
                    </td>
                    <td className="px-4 py-3 text-sm font-bold text-[#0EA5E9] tabular-nums">
                      Gs. {totalCobradoVista.toLocaleString("es-PY")}
                    </td>
                    <td colSpan={4} className="px-4 py-3 text-[11px] text-slate-500">
                      {cobradosFiltrados.length} registro{cobradosFiltrados.length === 1 ? "" : "s"} · se recalcula al cambiar el filtro
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      )}

      {modalPago && facturaSeleccionada && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setModalPago(false)}>
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-gray-800 mb-4">Registrar pago</h3>
            <p className="text-sm text-slate-600 mb-4">
              Factura {facturaSeleccionada.numero_factura} — Saldo: Gs. {facturaSeleccionada.saldo.toLocaleString("es-PY")}
            </p>
            <form onSubmit={handleRegistrarPago} className="space-y-4">
              <div>
                <label className={labelClass}>Monto</label>
                <MontoInput
                  value={formPago.monto}
                  onChange={(n) => setFormPago((p) => ({ ...p, monto: String(n) }))}
                  className={inputClass}
                  required
                />
              </div>
              <div>
                <label className={labelClass}>Fecha pago</label>
                <input type="date" value={formPago.fecha_pago} onChange={(e) => setFormPago((p) => ({ ...p, fecha_pago: e.target.value }))} className={inputClass} required />
              </div>
              <div>
                <label className={labelClass}>Método de pago</label>
                <select value={formPago.metodo_pago} onChange={(e) => setFormPago((p) => ({ ...p, metodo_pago: e.target.value as "efectivo" }))} className={inputClass}>
                  <option value="efectivo">Efectivo</option>
                  <option value="transferencia">Transferencia</option>
                  <option value="cheque">Cheque</option>
                  <option value="tarjeta">Tarjeta</option>
                  <option value="otro">Otro</option>
                </select>
              </div>
              <div>
                <label className={labelClass}>Referencia</label>
                <input type="text" value={formPago.referencia} onChange={(e) => setFormPago((p) => ({ ...p, referencia: e.target.value }))} className={inputClass} placeholder="Nº de comprobante" />
              </div>
              <div className="flex gap-3 pt-2">
                <button type="submit" disabled={guardando} className="bg-[#0EA5E9] hover:bg-[#0284C7] text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50">
                  Guardar
                </button>
                <button type="button" onClick={() => setModalPago(false)} className="border border-slate-200 px-4 py-2 rounded-lg text-sm hover:bg-slate-50">
                  Cancelar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
