"use client";

import { useState } from "react";
import PageHeader from "@/components/ui/PageHeader";

type SN = "S" | "N";

function mesActual(): string {
  return new Date().toISOString().slice(0, 7);
}

export default function R90VentasPage() {
  const [mes, setMes] = useState<string>(mesActual());
  const [imputaIva, setImputaIva] = useState<SN>("S");
  const [imputaIre, setImputaIre] = useState<SN>("S");
  const [imputaIrp, setImputaIrp] = useState<SN>("N");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "info" | "err"; text: string } | null>(null);

  const generar = async () => {
    setMsg(null);
    if (!/^\d{4}-\d{2}$/.test(mes)) {
      setMsg({ kind: "err", text: "Elegí un mes válido." });
      return;
    }
    setBusy(true);
    try {
      const qs = new URLSearchParams({ mes, imputaIva, imputaIre, imputaIrp });
      const res = await fetch(`/api/reportes/r90/ventas/export?${qs.toString()}`, {
        credentials: "include",
        cache: "no-store",
      });
      if (!res.ok) {
        setMsg({ kind: "err", text: `No se pudo generar el archivo (${res.status}).` });
        return;
      }
      const filas = Number(res.headers.get("X-R90-Filas") ?? "0");
      const autoimpresor = res.headers.get("X-R90-Autoimpresor") === "1";
      const blob = await res.blob();

      if (filas === 0) {
        // Archivo vacío: informamos el motivo y NO forzamos una descarga inútil.
        setMsg({
          kind: "info",
          text: autoimpresor
            ? "No hay comprobantes NO electrónicos para informar en este período. El archivo R90 queda vacío (nada que presentar)."
            : "Esta empresa emite 100% electrónico (SIFEN) y no tiene autoimpresor configurado, por lo que no hay comprobantes para el R90. La SET ya obtiene los documentos electrónicos automáticamente.",
        });
        return;
      }

      // Descargar el CSV.
      const cd = res.headers.get("Content-Disposition") ?? "";
      const m = /filename="([^"]+)"/.exec(cd);
      const filename = m?.[1] ?? `R90_${mes}.csv`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setMsg({ kind: "ok", text: `Archivo R90 generado con ${filas} comprobante(s): ${filename}` });
    } catch {
      setMsg({ kind: "err", text: "Error al generar el archivo R90." });
    } finally {
      setBusy(false);
    }
  };

  const SelectSN = ({ value, onChange, label }: { value: SN; onChange: (v: SN) => void; label: string }) => (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium text-slate-700">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value === "S" ? "S" : "N")}
        className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900"
      >
        <option value="S">S (Sí)</option>
        <option value="N">N (No)</option>
      </select>
    </label>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Zentra · Análisis"
        title="R90 – Registro de Comprobantes de Ventas"
        description="Genera el archivo CSV para Marangatú (RG 90/2021) con los comprobantes NO electrónicos del período."
      />

      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <p className="font-semibold">Alcance del archivo</p>
        <p className="mt-1 leading-snug">
          Incluye <strong>solo comprobantes NO electrónicos</strong> (ej. autoimpresor). Los documentos
          electrónicos SIFEN <strong>no se incluyen</strong>: la SET ya los obtiene automáticamente para el libro.
          Si la empresa emite 100% electrónico, el archivo puede quedar vacío — y eso es correcto.
        </p>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm max-w-2xl">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-slate-700">Período (mes)</span>
            <input
              type="month"
              value={mes}
              onChange={(e) => setMes(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900"
            />
          </label>
        </div>

        <div className="mt-4">
          <p className="text-sm font-semibold text-slate-800">Imputación (campos 15–17)</p>
          <p className="text-xs text-slate-500 mb-2">
            Según las obligaciones tributarias reales de la empresa. Confirmá los valores con el contador antes de presentar.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <SelectSN value={imputaIva} onChange={setImputaIva} label="Imputa IVA" />
            <SelectSN value={imputaIre} onChange={setImputaIre} label="Imputa IRE" />
            <SelectSN value={imputaIrp} onChange={setImputaIrp} label="Imputa IRP-RSP" />
          </div>
        </div>

        <div className="mt-5 flex items-center gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => void generar()}
            className="inline-flex items-center justify-center rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {busy ? "Generando…" : "Generar y descargar"}
          </button>
        </div>

        {msg && (
          <div
            className={`mt-4 rounded-lg border px-3 py-2 text-sm ${
              msg.kind === "ok"
                ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                : msg.kind === "info"
                  ? "border-slate-200 bg-slate-50 text-slate-800"
                  : "border-red-200 bg-red-50 text-red-900"
            }`}
          >
            {msg.text}
          </div>
        )}
      </div>

      <p className="text-xs text-slate-500 max-w-2xl">
        Formato: CSV delimitado por coma, UTF-8, sin encabezado, en el orden oficial de campos de la DNIT (19 campos).
        Para subir a Marangatú, comprimí el archivo (.zip) según lo requiera el portal.
      </p>
    </div>
  );
}
