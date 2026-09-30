"use client";

import { useState } from "react";
import PageHeader from "@/components/ui/PageHeader";
import ExportExcelButton from "@/components/ui/ExportExcelButton";

function mesActual(): string {
  return new Date().toISOString().slice(0, 7);
}

export default function LibroIvaVentasPage() {
  const [mes, setMes] = useState<string>(mesActual());
  const mesValido = /^\d{4}-\d{2}$/.test(mes);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Zentra · Análisis"
        title="Libro de Ventas IVA"
        description="Genera el detalle de facturas del período para la liquidación mensual del IVA, listo para descargar en Excel."
      />

      <div className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
        <p className="font-semibold">Qué incluye</p>
        <p className="mt-1 leading-snug">
          Todas las facturas <strong>no anuladas</strong> del período (electrónicas y no electrónicas) y las
          <strong> notas de crédito aprobadas</strong> (como filas negativas, que reducen el IVA débito), con el
          desglose por columnas: <strong>Fecha · Tipo · N° Factura · Timbrado · RUC/CI · Razón social · Gravado
          10% · IVA 10% · Gravado 5% · IVA 5% · Exentas · Total</strong>, y una fila de <strong>TOTALES netos</strong>.
        </p>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm max-w-xl">
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-slate-700">Período (mes)</span>
            <input
              type="month"
              value={mes}
              onChange={(e) => setMes(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900"
            />
          </label>
          <ExportExcelButton
            url={`/api/reportes/iva/ventas/export?mes=${mes}`}
            label="Generar y descargar Excel"
            className={!mesValido ? "pointer-events-none opacity-50" : ""}
          />
        </div>
        <p className="mt-3 text-xs text-slate-500">
          Incluye todas las sucursales (empresa completa), igual que el R90. Los montos van en guaraníes, sin
          decimales.
        </p>
      </div>
    </div>
  );
}
