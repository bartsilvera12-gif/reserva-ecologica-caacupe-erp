"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ConfigFormCard,
  ConfigHelpText,
  ConfigSectionTitle,
  F_INPUT,
  F_LABEL,
} from "@/components/config/global-config-primitives";
import { GlobalConfigSubpageShell } from "@/components/config/GlobalConfigSubpageShell";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import {
  getUnknownErrorKeys,
  serializeUnknownError,
} from "@/lib/errors/serialize-unknown-error";

type EscalaRow = {
  id?: string;
  desde_monto: string;
  hasta_monto: string;
  porcentaje_comision: string;
  premio_fijo: string;
};

const BASE_OPTIONS = [
  { value: "pago_registrado", label: "Pago registrado" },
  { value: "factura_emitida", label: "Factura emitida" },
  { value: "factura_pagada", label: "Factura pagada" },
] as const;

const POLITICA_ENDPOINT = "/api/comisiones/politica";

function nuevoTraceCliente(): string {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return [...a].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 12);
}

export default function ConfiguracionComisionesPage() {
  const [loading, setLoading] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [puedeEditar, setPuedeEditar] = useState(false);

  const [nombre, setNombre] = useState("Política principal");
  const [activo, setActivo] = useState(true);
  const [baseCalculo, setBaseCalculo] = useState<string>("pago_registrado");
  const [timezone, setTimezone] = useState("America/Asuncion");
  const [modoPeriodo, setModoPeriodo] = useState("mensual_penultimo_dia_habil");
  const [escalas, setEscalas] = useState<EscalaRow[]>([
    { desde_monto: "0", hasta_monto: "", porcentaje_comision: "0", premio_fijo: "" },
  ]);

  const cargar = useCallback(async () => {
    setLoading(true);
    setError(null);
    const traceCliente = nuevoTraceCliente();
    try {
      const res = await fetchWithSupabaseSession(POLITICA_ENDPOINT, {
        cache: "no-store",
        headers: { "X-Client-Trace-Id": traceCliente },
      });

      const rawText = await res.text();
      let parsed: unknown = null;
      try {
        parsed = rawText.trim() ? JSON.parse(rawText) : null;
      } catch {
        parsed = null;
      }
      const json =
        parsed && typeof parsed === "object"
          ? (parsed as {
              success?: boolean;
              traceId?: string;
              data?: {
                politica: Record<string, unknown> | null;
                escalas: Record<string, unknown>[];
                puedeEditar?: boolean;
                canEdit?: boolean;
                rol?: string | null;
              };
              error?: string;
            })
          : null;

      const traceServidor = typeof json?.traceId === "string" ? json.traceId : null;
      const traceMostrar = traceServidor ?? traceCliente;

      if (!res.ok) {
        const apiErr =
          typeof json?.error === "string"
            ? json.error
            : rawText.replace(/\s+/g, " ").trim().slice(0, 320) || "(cuerpo vacío o no JSON)";
        setError(
          `Error al cargar ${POLITICA_ENDPOINT} — ${res.status} ${res.statusText} — ${apiErr} — trace ${traceMostrar}`
        );
        return;
      }

      if (json?.success !== true) {
        const detalle =
          typeof json?.error === "string"
            ? json.error
            : rawText.replace(/\s+/g, " ").trim().slice(0, 280) || "success !== true sin mensaje";
        setError(
          `Respuesta inválida ${POLITICA_ENDPOINT} — ${res.status} — ${detalle} — trace ${traceMostrar}`
        );
        return;
      }

      const puede =
        json.data?.puedeEditar ?? json.data?.canEdit ?? false;
      setPuedeEditar(Boolean(puede));

      const pol = json.data?.politica;
      const esc = json.data?.escalas ?? [];
      if (pol && typeof pol === "object") {
        setNombre(typeof pol.nombre === "string" ? pol.nombre : "Política principal");
        setActivo(pol.activo !== false);
        setBaseCalculo(typeof pol.base_calculo === "string" ? pol.base_calculo : "pago_registrado");
        setTimezone(typeof pol.timezone === "string" ? pol.timezone : "America/Asuncion");
        setModoPeriodo(
          typeof pol.modo_periodo === "string" ? pol.modo_periodo : "mensual_penultimo_dia_habil"
        );
      }
      if (esc.length > 0) {
        setEscalas(
          esc.map((r) => ({
            id: typeof r.id === "string" ? r.id : undefined,
            desde_monto: String(r.desde_monto ?? "0"),
            hasta_monto: r.hasta_monto != null ? String(r.hasta_monto) : "",
            porcentaje_comision: String(r.porcentaje_comision ?? "0"),
            premio_fijo: r.premio_fijo != null ? String(r.premio_fijo) : "",
          }))
        );
      }
    } catch (e) {
      const serialized = serializeUnknownError(e);
      console.warn("[configuracion/comisiones] cargar excepción", {
        traceId: traceCliente,
        endpoint: POLITICA_ENDPOINT,
        error: serialized,
        errorKeys: getUnknownErrorKeys(e),
      });
      setError(`Excepción al cargar ${POLITICA_ENDPOINT} — ${serialized} — trace ${traceCliente}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function handleGuardar() {
    if (!puedeEditar) return;
    setGuardando(true);
    setError(null);
    setSuccess(false);
    try {
      const escalasPayload = escalas.map((row) => ({
        desde_monto: parseFloat(row.desde_monto.replace(",", ".")) || 0,
        hasta_monto: row.hasta_monto.trim() === "" ? null : parseFloat(row.hasta_monto.replace(",", ".")),
        porcentaje_comision: parseFloat(row.porcentaje_comision.replace(",", ".")) || 0,
        premio_fijo: row.premio_fijo.trim() === "" ? null : parseFloat(row.premio_fijo.replace(",", ".")),
      }));
      const res = await fetchWithSupabaseSession("/api/comisiones/politica", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nombre: nombre.trim(),
          activo,
          base_calculo: baseCalculo,
          timezone: timezone.trim() || "America/Asuncion",
          modo_periodo: modoPeriodo.trim() || "mensual_penultimo_dia_habil",
          escalas: escalasPayload,
        }),
      });
      const json = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || json.success !== true) {
        throw new Error(json.error ?? `Error ${res.status}`);
      }
      setSuccess(true);
      setTimeout(() => setSuccess(false), 4000);
    } catch (e) {
      const serialized = serializeUnknownError(e);
      console.warn("[configuracion/comisiones] guardar excepción", {
        endpoint: "/api/comisiones/politica",
        error: serialized,
        errorKeys: getUnknownErrorKeys(e),
      });
      setError(serialized || "No se pudo guardar");
    } finally {
      setGuardando(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-sm text-slate-400">
        Cargando política de comisiones…
      </div>
    );
  }

  return (
    <GlobalConfigSubpageShell
      title="Comisiones"
      description="Política base y escalas por montos. El cálculo sobre facturas y pagos se activará en una etapa posterior."
    >
      {success && (
        <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          Cambios guardados correctamente.
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}
      {!puedeEditar && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Solo administradores de la empresa pueden editar esta configuración. Podés revisar los valores actuales.
        </div>
      )}

      <div className="space-y-5">
        <ConfigFormCard>
          <ConfigSectionTitle>Política</ConfigSectionTitle>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className={F_LABEL}>Nombre</label>
              <input
                type="text"
                value={nombre}
                onChange={(e) => setNombre(e.target.value)}
                disabled={!puedeEditar}
                className={F_INPUT}
              />
            </div>
            <div>
              <label className={F_LABEL}>Estado</label>
              <select
                value={activo ? "1" : "0"}
                onChange={(e) => setActivo(e.target.value === "1")}
                disabled={!puedeEditar}
                className={F_INPUT}
              >
                <option value="1">Activa</option>
                <option value="0">Inactiva</option>
              </select>
            </div>
            <div>
              <label className={F_LABEL}>Base de cálculo (futuro)</label>
              <select
                value={baseCalculo}
                onChange={(e) => setBaseCalculo(e.target.value)}
                disabled={!puedeEditar}
                className={F_INPUT}
              >
                {BASE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <ConfigHelpText>
                Define la fuente cuando el motor calcule comisiones (habilitación próxima).
              </ConfigHelpText>
            </div>
            <div>
              <label className={F_LABEL}>Zona horaria</label>
              <input
                type="text"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                disabled={!puedeEditar}
                className={F_INPUT}
              />
            </div>
            <div>
              <label className={F_LABEL}>Modo de período</label>
              <input
                type="text"
                value={modoPeriodo}
                onChange={(e) => setModoPeriodo(e.target.value)}
                disabled={!puedeEditar}
                className={F_INPUT}
              />
              <ConfigHelpText>Valor por defecto del ERP: mensual (penúltimo día hábil).</ConfigHelpText>
            </div>
          </div>
        </ConfigFormCard>

        <ConfigFormCard>
          <ConfigSectionTitle>Escalas</ConfigSectionTitle>
          <p className="mb-3 text-sm text-slate-600">
            Rangos de monto y porcentaje de comisión. Dejá «Hasta» vacío para indicar sin techo en ese tramo.
          </p>
          <div className="space-y-3">
            {escalas.map((row, idx) => (
              <div
                key={idx}
                className="grid gap-2 rounded-lg border border-slate-200 bg-slate-50/80 p-3 sm:grid-cols-12 sm:items-end"
              >
                <div className="sm:col-span-3">
                  <label className={F_LABEL}>Desde (monto)</label>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={row.desde_monto}
                    onChange={(e) => {
                      const v = e.target.value;
                      setEscalas((prev) => prev.map((x, i) => (i === idx ? { ...x, desde_monto: v } : x)));
                    }}
                    disabled={!puedeEditar}
                    className={F_INPUT}
                  />
                </div>
                <div className="sm:col-span-3">
                  <label className={F_LABEL}>Hasta (opcional)</label>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={row.hasta_monto}
                    onChange={(e) => {
                      const v = e.target.value;
                      setEscalas((prev) => prev.map((x, i) => (i === idx ? { ...x, hasta_monto: v } : x)));
                    }}
                    disabled={!puedeEditar}
                    className={F_INPUT}
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className={F_LABEL}>% comisión</label>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={row.porcentaje_comision}
                    onChange={(e) => {
                      const v = e.target.value;
                      setEscalas((prev) => prev.map((x, i) => (i === idx ? { ...x, porcentaje_comision: v } : x)));
                    }}
                    disabled={!puedeEditar}
                    className={F_INPUT}
                  />
                </div>
                <div className="sm:col-span-3">
                  <label className={F_LABEL}>Premio fijo (opc.)</label>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={row.premio_fijo}
                    onChange={(e) => {
                      const v = e.target.value;
                      setEscalas((prev) => prev.map((x, i) => (i === idx ? { ...x, premio_fijo: v } : x)));
                    }}
                    disabled={!puedeEditar}
                    className={F_INPUT}
                  />
                </div>
                <div className="sm:col-span-1 flex justify-end pb-1">
                  {puedeEditar && escalas.length > 1 && (
                    <button
                      type="button"
                      className="text-xs font-medium text-red-600 hover:underline"
                      onClick={() => setEscalas((prev) => prev.filter((_, i) => i !== idx))}
                    >
                      Quitar
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
          {puedeEditar && (
            <button
              type="button"
              className="mt-3 text-sm font-medium text-sky-700 hover:underline"
              onClick={() =>
                setEscalas((prev) => [
                  ...prev,
                  { desde_monto: "0", hasta_monto: "", porcentaje_comision: "0", premio_fijo: "" },
                ])
              }
            >
              + Agregar escala
            </button>
          )}
        </ConfigFormCard>

        {puedeEditar && (
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void handleGuardar()}
              disabled={guardando}
              className="rounded-lg bg-sky-600 px-5 py-2.5 text-sm font-semibold text-white shadow hover:bg-sky-700 disabled:opacity-60"
            >
              {guardando ? "Guardando…" : "Guardar política"}
            </button>
          </div>
        )}
      </div>
    </GlobalConfigSubpageShell>
  );
}
