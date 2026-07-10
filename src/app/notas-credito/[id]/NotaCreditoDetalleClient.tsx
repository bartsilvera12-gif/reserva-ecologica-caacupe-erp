"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import type { NotaCreditoGlobalDetailDTO } from "@/lib/nota-credito/types";

type AccionSifen = "xml" | "firmar" | "procesar" | "enviar" | "consulta-lote";

export default function NotaCreditoDetalleClient() {
  const params = useParams();
  const id = String(params?.id ?? "");
  const [data, setData] = useState<NotaCreditoGlobalDetailDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [accion, setAccion] = useState<AccionSifen | null>(null);
  const [flash, setFlash] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setErr(null);
    try {
      const res = await fetchWithSupabaseSession(`/api/notas-credito/${id}`, { cache: "no-store" });
      const j = (await res.json()) as { success?: boolean; data?: NotaCreditoGlobalDetailDTO; error?: string };
      if (!res.ok || !j.success || !j.data) {
        setData(null);
        setErr(j.error ?? "No se pudo cargar");
        return;
      }
      setData(j.data);
    } catch {
      setData(null);
      setErr("Error de red");
    } finally {
      setLoading(false);
    }
  }, [id]);

  const runAccion = useCallback(async (a: AccionSifen) => {
    if (accion) return;
    setAccion(a);
    setFlash(null);
    try {
      const res = await fetchWithSupabaseSession(
        `/api/notas-credito/${id}/sifen/${a}`,
        { method: "POST" }
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.success === false) {
        setFlash({ kind: "err", text: body?.error ?? `No se pudo ejecutar ${a}.` });
      } else {
        setFlash({ kind: "ok", text: `Acción "${a}" completada.` });
      }
      await load();
    } catch {
      setFlash({ kind: "err", text: "Error de red." });
    } finally {
      setAccion(null);
    }
  }, [accion, id, load]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-16 text-center text-slate-500 text-sm">
        Cargando nota de crédito…
      </div>
    );
  }
  if (err || !data) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">{err ?? "Sin datos"}</div>
        <Link href="/notas-credito" className="inline-block mt-4 text-[#0EA5E9] text-sm font-semibold hover:underline">
          ← Volver al listado
        </Link>
      </div>
    );
  }

  const nc = data.nota_credito;
  const ne = data.nota_credito_electronica;
  const moneda = String(nc.moneda_snapshot ?? "GS");

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/notas-credito" className="text-xs font-semibold text-[#0EA5E9] hover:underline">
            ← Notas de crédito
          </Link>
          <h1 className="text-2xl font-bold text-slate-900 mt-1">Detalle de nota de crédito</h1>
          <p className="text-xs font-mono text-slate-500 mt-0.5">{String(nc.id)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {ne?.estado_sifen === "aprobado" ? (
            <a
              href={`/api/notas-credito/${nc.id}/sifen/kude`}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700"
            >
              Imprimir KUDE
            </a>
          ) : null}
          <Link
            href={`/facturas/${data.factura.id}`}
            className="px-3 py-2 rounded-lg bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800"
          >
            Ir a factura
          </Link>
        </div>
      </div>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm space-y-3">
        <h2 className="text-sm font-bold text-slate-700 uppercase tracking-wide">Datos generales</h2>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-slate-400 text-xs">Cliente</dt>
            <dd className="font-medium">
              <Link href={`/clientes/${data.cliente.id}`} className="text-[#0EA5E9] hover:underline">
                {data.cliente.display}
              </Link>
              {data.cliente.ruc ? <span className="text-slate-500 text-xs ml-1">RUC {data.cliente.ruc}</span> : null}
            </dd>
          </div>
          <div>
            <dt className="text-slate-400 text-xs">Factura</dt>
            <dd className="font-mono text-xs">{data.factura.numero_factura ?? data.factura.id}</dd>
          </div>
          <div>
            <dt className="text-slate-400 text-xs">Monto NC</dt>
            <dd className="font-bold text-amber-900 tabular-nums">
              {moneda === "USD" ? "USD" : "Gs."} {Number(nc.monto).toLocaleString(moneda === "USD" ? "en-US" : "es-PY")}
            </dd>
          </div>
          <div>
            <dt className="text-slate-400 text-xs">Estado ERP / SIFEN</dt>
            <dd className="space-x-2">
              <span className="font-semibold">{String(nc.estado_erp)}</span>
              <span className="text-slate-400">/</span>
              <span className="font-semibold">{ne?.estado_sifen != null ? String(ne.estado_sifen) : "—"}</span>
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-slate-400 text-xs">Motivo</dt>
            <dd className="text-slate-800 whitespace-pre-wrap">{String(nc.motivo ?? "")}</dd>
          </div>
          <div>
            <dt className="text-slate-400 text-xs">Creador</dt>
            <dd className="text-xs">
              {String(nc.created_by_nombre_snapshot ?? nc.created_by_email_snapshot ?? nc.created_by_user_id ?? "—")}
            </dd>
          </div>
          <div>
            <dt className="text-slate-400 text-xs">CDC (NC)</dt>
            <dd className="font-mono text-[11px] break-all">{ne?.cdc != null ? String(ne.cdc) : "—"}</dd>
          </div>
        </dl>
      </section>

      {data.items.length > 0 && (
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-bold text-slate-700 uppercase tracking-wide">
              Detalle de ítems{" "}
              <span className="ml-1 text-[10px] font-normal text-slate-400">
                ({data.items.length} línea{data.items.length === 1 ? "" : "s"})
              </span>
            </h2>
            <span className="text-[11px] text-slate-500">NC parcial</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-slate-50 border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">Producto</th>
                  <th className="px-3 py-2">SKU</th>
                  <th className="px-3 py-2 text-right">Cant.</th>
                  <th className="px-3 py-2 text-right">Precio unit.</th>
                  <th className="px-3 py-2">IVA</th>
                  <th className="px-3 py-2">Modo</th>
                  <th className="px-3 py-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.items.map((it) => (
                  <tr key={it.id}>
                    <td className="px-3 py-2 text-slate-800">{it.producto_nombre}</td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-500">{it.sku ?? "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{it.cantidad}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-600">
                      {moneda === "USD" ? "USD" : "Gs."}{" "}
                      {it.precio_unitario.toLocaleString(moneda === "USD" ? "en-US" : "es-PY")}
                    </td>
                    <td className="px-3 py-2">
                      <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold text-indigo-700">
                        {it.tipo_iva}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-500 capitalize">{it.modo}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-semibold text-slate-900">
                      {moneda === "USD" ? "USD" : "Gs."}{" "}
                      {it.total_linea.toLocaleString(moneda === "USD" ? "en-US" : "es-PY")}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-slate-50 border-t border-slate-200 text-sm">
                <tr>
                  <td colSpan={6} className="px-3 py-2 text-right font-semibold text-slate-600">
                    Total NC
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums font-bold text-amber-900">
                    {moneda === "USD" ? "USD" : "Gs."}{" "}
                    {Number(nc.monto).toLocaleString(moneda === "USD" ? "en-US" : "es-PY")}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>
      )}

      {ne && (
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm space-y-2">
          <h2 className="text-sm font-bold text-slate-700 uppercase tracking-wide">Documento electrónico (SIFEN)</h2>
          <dl className="grid grid-cols-1 gap-2 text-xs font-mono text-slate-600 break-all">
            <div>
              <dt className="text-slate-400 font-sans">xml_path</dt>
              <dd>{ne.xml_path != null ? String(ne.xml_path) : "—"}</dd>
            </div>
            <div>
              <dt className="text-slate-400 font-sans">xml_firmado_path</dt>
              <dd>{ne.xml_firmado_path != null ? String(ne.xml_firmado_path) : "—"}</dd>
            </div>
            <div>
              <dt className="text-slate-400 font-sans">kude_url</dt>
              <dd>{ne.kude_url != null ? String(ne.kude_url) : "—"}</dd>
            </div>
            <div>
              <dt className="text-slate-400 font-sans">last_error</dt>
              <dd className="text-red-800">{ne.last_error != null ? String(ne.last_error) : "—"}</dd>
            </div>
            <div>
              <dt className="text-slate-400 font-sans">sifen_aprobado_at</dt>
              <dd>{ne.sifen_aprobado_at != null ? String(ne.sifen_aprobado_at) : "—"}</dd>
            </div>
          </dl>
          <details className="text-xs">
            <summary className="cursor-pointer text-[#0EA5E9] font-semibold">Respuestas SET (JSON)</summary>
            <pre className="mt-2 max-h-64 overflow-auto rounded bg-slate-50 p-2 text-[10px]">
              {JSON.stringify(
                {
                  sifen_ultima_respuesta_recibe_lote: ne.sifen_ultima_respuesta_recibe_lote,
                  sifen_ultima_respuesta_consulta_lote: ne.sifen_ultima_respuesta_consulta_lote,
                  last_response_json: ne.last_response_json,
                },
                null,
                2
              )}
            </pre>
          </details>
        </section>
      )}

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-slate-700 uppercase tracking-wide">Acciones SIFEN</h2>
          <span className="text-[11px] text-slate-400">
            Estado actual: <strong>{ne?.estado_sifen != null ? String(ne.estado_sifen) : "—"}</strong>
          </span>
        </div>
        {flash && (
          <div
            className={`rounded-md border px-3 py-2 text-xs ${
              flash.kind === "ok"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-red-200 bg-red-50 text-red-800"
            }`}
          >
            {flash.text}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {(() => {
            const stSifen = String(ne?.estado_sifen ?? "");
            const stErp = String(nc.estado_erp ?? "");
            const generable = stErp !== "aprobada" && stSifen !== "aprobado" && stSifen !== "cancelado";
            const firmable = stSifen === "generado" || stSifen === "error_envio" || stSifen === "rechazado";
            const enviable = stSifen === "firmado" || stSifen === "error_envio";
            const consultable = stSifen === "enviado" || stSifen === "en_proceso";
            const procesable = generable;
            const btn = "inline-flex items-center rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50 transition-colors";
            return (
              <>
                <button
                  type="button"
                  disabled={!generable || accion !== null}
                  onClick={() => void runAccion("xml")}
                  className={`${btn} border border-slate-300 bg-white text-slate-800 hover:bg-slate-50`}
                >
                  {accion === "xml" ? "Generando…" : "Generar XML"}
                </button>
                <button
                  type="button"
                  disabled={!firmable || accion !== null}
                  onClick={() => void runAccion("firmar")}
                  className={`${btn} border border-slate-300 bg-white text-slate-800 hover:bg-slate-50`}
                >
                  {accion === "firmar" ? "Firmando…" : "Firmar"}
                </button>
                <button
                  type="button"
                  disabled={!enviable || accion !== null}
                  onClick={() => void runAccion("enviar")}
                  className={`${btn} bg-slate-900 text-white hover:bg-slate-800`}
                >
                  {accion === "enviar" ? "Enviando…" : "Enviar a SET"}
                </button>
                <button
                  type="button"
                  disabled={!consultable || accion !== null}
                  onClick={() => void runAccion("consulta-lote")}
                  className={`${btn} border border-slate-300 bg-white text-slate-800 hover:bg-slate-50`}
                >
                  {accion === "consulta-lote" ? "Consultando…" : "Consultar lote"}
                </button>
                <button
                  type="button"
                  disabled={!procesable || accion !== null}
                  onClick={() => void runAccion("procesar")}
                  className={`${btn} border border-slate-300 bg-white text-slate-800 hover:bg-slate-50`}
                  title="Ejecuta la cadena xml → firmar → enviar en un solo paso."
                >
                  {accion === "procesar" ? "Procesando…" : "Procesar completo"}
                </button>
              </>
            );
          })()}
        </div>
        <p className="text-[11px] text-slate-500 leading-relaxed">
          Los botones se habilitan según el estado SIFEN actual. También podés operar desde el panel embebido en la ficha
          de la factura origen. Para descargar XML/KUDE de la nota de crédito ya aprobada, andá al
          {" "}
          <Link href={`/facturas/${data.factura.id}`} className="text-[#0EA5E9] font-medium hover:underline">
            panel de la factura
          </Link>{" "}
          (mismo pipeline reutilizado).
        </p>
      </section>

    </div>
  );
}
