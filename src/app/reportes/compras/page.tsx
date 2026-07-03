"use client";

import { useEffect, useState } from "react";
import PageHeader from "@/components/ui/PageHeader";
import StatCard from "@/components/ui/StatCard";
import ExportExcelButton from "@/components/ui/ExportExcelButton";
import MesSelector from "@/components/reportes/MesSelector";
import { getComprasReporte } from "@/lib/reportes/storage";
import { mesActualAsuncion } from "@/lib/fechas/asuncion-bounds";
import type { ComprasReporte } from "@/lib/reportes/types";

function formatGs(v: number) {
  return `Gs. ${Math.round(v).toLocaleString("es-PY")}`;
}
function formatFecha(iso: string) {
  try {
    const d = new Date(iso);
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
  } catch {
    return iso;
  }
}
function tipoPagoLabel(t: string) {
  const v = (t || "").toLowerCase();
  if (v === "credito") return "Crédito";
  if (v === "contado") return "Contado";
  return t || "—";
}

export default function ComprasReportePage() {
  const [mes, setMes] = useState(mesActualAsuncion());
  const [data, setData] = useState<ComprasReporte | null>(null);
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    let cancel = false;
    setCargando(true);
    getComprasReporte(mes).then((d) => { if (!cancel) { setData(d); setCargando(false); } });
    return () => { cancel = true; };
  }, [mes]);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Zentra · Reportes"
        title="Compras"
        description="Adquisiciones y costos del período"
        backHref="/reportes"
        backLabel="Reportes"
        actions={
          <div className="flex items-center gap-3">
            <MesSelector mes={mes} onChange={setMes} />
            <ExportExcelButton url={`/api/reportes/compras/export?mes=${mes}`} />
          </div>
        }
      />

      {cargando ? (
        <p className="text-slate-500 animate-pulse">Cargando…</p>
      ) : !data ? (
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-6 text-slate-500">
          No se pudo cargar el reporte de compras.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            <StatCard compact label="Total comprado" value={formatGs(data.totalComprado)} accent />
            <StatCard compact label="Compras del mes" value={String(data.cantidad)} hint={`${data.cantidadItems} ítems / líneas`} />
            <StatCard compact label="Compra más alta" value={data.compraMasAlta ? formatGs(data.compraMasAlta.total) : "—"} hint={data.compraMasAlta ? `${data.compraMasAlta.numero_control} · ${data.compraMasAlta.proveedor_nombre}` : "Sin compras"} />
            <StatCard compact label="Proveedor con mayor monto" value={data.proveedorMayor ? data.proveedorMayor.proveedor_nombre : "—"} hint={data.proveedorMayor ? formatGs(data.proveedorMayor.total) : ""} />
            <StatCard compact label="Producto más comprado" value={data.productoMasComprado ? data.productoMasComprado.producto_nombre : "—"} hint={data.productoMasComprado ? `${data.productoMasComprado.cantidad} u.` : ""} />
            <StatCard compact label="Producto con mayor gasto" value={data.productoMayorGasto ? data.productoMayorGasto.producto_nombre : "—"} hint={data.productoMayorGasto ? formatGs(data.productoMayorGasto.gasto) : ""} />
          </div>

          {/* Compras del mes (agrupadas por N° control) */}
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-6">
            <h2 className="text-base font-semibold text-slate-800 mb-4">Compras del mes</h2>
            {data.compras.length === 0 ? (
              <p className="text-sm text-slate-400">No hay compras en el período.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[920px] text-left text-sm">
                  <thead>
                    <tr className="border-b text-slate-500">
                      <th className="py-2.5 pr-4 font-medium">Fecha</th>
                      <th className="py-2.5 pr-4 font-medium">N° Compra</th>
                      <th className="py-2.5 pr-4 font-medium">Proveedor</th>
                      <th className="py-2.5 pr-4 font-medium text-right">Ítems</th>
                      <th className="py-2.5 pr-4 font-medium text-right">Subtotal</th>
                      <th className="py-2.5 pr-4 font-medium text-right">IVA</th>
                      <th className="py-2.5 pr-4 font-medium text-right">Total</th>
                      <th className="py-2.5 pr-4 font-medium">Pago</th>
                      <th className="py-2.5 pr-4 font-medium">Timbrado</th>
                      <th className="py-2.5 font-medium">Comprobante</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.compras.map((c) => {
                      const anulada = c.estado === "anulada";
                      return (
                        <tr key={c.numero_control} className={`border-b border-slate-100 last:border-0 ${anulada ? "text-slate-400" : ""}`}>
                          <td className="py-3 pr-4 text-xs tabular-nums">{formatFecha(c.fecha)}</td>
                          <td className={`py-3 pr-4 font-mono text-xs ${anulada ? "line-through" : "text-slate-500"}`}>{c.numero_control}</td>
                          <td className="py-3 pr-4">
                            <div className="flex items-center gap-2">
                              <span className={anulada ? "line-through" : "text-slate-700"}>{c.proveedor_nombre}</span>
                              {anulada && (
                                <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold bg-rose-50 text-rose-700 ring-1 ring-rose-200">
                                  Anulada
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="py-3 pr-4 text-right tabular-nums">{c.items_count}</td>
                          <td className="py-3 pr-4 text-right tabular-nums">{formatGs(c.subtotal)}</td>
                          <td className="py-3 pr-4 text-right tabular-nums">{c.monto_iva > 0 ? formatGs(c.monto_iva) : "—"}</td>
                          <td className={`py-3 pr-4 text-right tabular-nums font-semibold ${anulada ? "line-through" : "text-slate-800"}`}>{formatGs(c.total)}</td>
                          <td className="py-3 pr-4">{tipoPagoLabel(c.tipo_pago)}</td>
                          <td className="py-3 pr-4 font-mono text-xs">{c.nro_timbrado || "—"}</td>
                          <td className="py-3">
                            {c.tiene_comprobante ? (
                              <a
                                href={`/api/compras/comprobante?numero_control=${encodeURIComponent(c.numero_control)}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs font-medium text-[#4FAEB2] hover:text-[#3F8E91] hover:underline"
                              >
                                📎 Ver
                              </a>
                            ) : (
                              <span className="text-xs text-slate-300">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            {/* Total por proveedor */}
            <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-6">
              <h2 className="text-base font-semibold text-slate-800 mb-4">Total por proveedor</h2>
              {data.porProveedor.length === 0 ? (
                <p className="text-sm text-slate-400">Sin datos.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b text-slate-500">
                        <th className="py-2.5 pr-4 font-medium">Proveedor</th>
                        <th className="py-2.5 pr-4 font-medium text-right">Compras</th>
                        <th className="py-2.5 font-medium text-right">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.porProveedor.map((p, i) => (
                        <tr key={i} className="border-b border-slate-100 last:border-0">
                          <td className="py-2.5 pr-4 text-slate-700">{p.proveedor_nombre}</td>
                          <td className="py-2.5 pr-4 text-right tabular-nums text-slate-600">{p.compras}</td>
                          <td className="py-2.5 text-right tabular-nums font-semibold text-slate-800">{formatGs(p.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Total por producto */}
            <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-6">
              <h2 className="text-base font-semibold text-slate-800 mb-4">Total por producto</h2>
              {data.porProducto.length === 0 ? (
                <p className="text-sm text-slate-400">Sin datos.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b text-slate-500">
                        <th className="py-2.5 pr-4 font-medium">Producto</th>
                        <th className="py-2.5 pr-4 font-medium text-right">Cantidad</th>
                        <th className="py-2.5 font-medium text-right">Gasto</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.porProducto.map((p, i) => (
                        <tr key={i} className="border-b border-slate-100 last:border-0">
                          <td className="py-2.5 pr-4 text-slate-700">{p.producto_nombre}</td>
                          <td className="py-2.5 pr-4 text-right tabular-nums text-slate-600">{p.cantidad}</td>
                          <td className="py-2.5 text-right tabular-nums font-semibold text-slate-800">{formatGs(p.gasto)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
