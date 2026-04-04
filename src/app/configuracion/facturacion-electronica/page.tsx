"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { AmbienteSifen, EmpresaSifenConfigDTO } from "@/lib/sifen/types";

const fLabel = "block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1";
const fInput =
  "w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0EA5E9] bg-white";
const fSelect = fInput;

function Card({ children }: { children: React.ReactNode }) {
  return <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">{children}</div>;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-4 pb-2 border-b border-gray-100">
      {children}
    </h4>
  );
}

function isoToDateInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

/** Config “completa” según datos persistidos (no borrador en curso). */
function isSifenConfigCompleta(c: EmpresaSifenConfigDTO): boolean {
  const datos =
    Boolean(c.ruc?.trim()) &&
    Boolean(c.razon_social?.trim()) &&
    Boolean(c.timbrado_numero?.trim()) &&
    Boolean(c.establecimiento?.trim()) &&
    Boolean(c.punto_expedicion?.trim());
  return (
    datos &&
    c.activo === true &&
    Boolean(c.certificado_path?.trim()) &&
    c.has_certificado_password === true
  );
}

export default function FacturacionElectronicaSifenPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [cfg, setCfg] = useState<EmpresaSifenConfigDTO | null>(null);

  const [ambiente, setAmbiente] = useState<AmbienteSifen>("test");
  const [ruc, setRuc] = useState("");
  const [razonSocial, setRazonSocial] = useState("");
  const [timbradoNumero, setTimbradoNumero] = useState("");
  const [establecimiento, setEstablecimiento] = useState("");
  const [puntoExpedicion, setPuntoExpedicion] = useState("");
  const [csc, setCsc] = useState("");
  const [activo, setActivo] = useState(true);
  const [certVenc, setCertVenc] = useState("");
  const [nuevaPassword, setNuevaPassword] = useState("");
  const [limpiarPassword, setLimpiarPassword] = useState(false);

  const certFileInputId = useId();
  const certFileInputRef = useRef<HTMLInputElement>(null);
  /** Nombre del .p12 elegido en el diálogo (se limpia tras subida OK). */
  const [nombreArchivoCert, setNombreArchivoCert] = useState<string | null>(null);
  /** Si la config está completa, permite colapsar el formulario (opción A). */
  const [editarFormulario, setEditarFormulario] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/configuracion/sifen");
      const j = (await res.json()) as { success?: boolean; data?: EmpresaSifenConfigDTO | null; error?: string };
      if (!res.ok || !j.success) {
        setError(j.error ?? "No se pudo cargar la configuración");
        return;
      }
      const d = j.data ?? null;
      setCfg(d);
      if (d) {
        setAmbiente(d.ambiente);
        setRuc(d.ruc);
        setRazonSocial(d.razon_social);
        setTimbradoNumero(d.timbrado_numero);
        setEstablecimiento(d.establecimiento);
        setPuntoExpedicion(d.punto_expedicion);
        setCsc(d.csc ?? "");
        setActivo(d.activo);
        setCertVenc(isoToDateInput(d.certificado_vencimiento));
      }
    } catch {
      setError("Error de red al cargar SIFEN");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (cfg != null && !isSifenConfigCompleta(cfg)) setEditarFormulario(true);
  }, [cfg]);

  /**
   * Vencimiento: obligatorio solo si ya hay .p12 en storage (certificado_path).
   * Crear config sin certificado → no enviar fecha (omitir en POST).
   * PATCH sin cert y fecha vacía → null en servidor.
   */
  function resolveCertificadoVencimiento(): { ok: true; iso: string | null } | { ok: false; message: string } {
    const t = certVenc.trim();
    const tieneCertificado = Boolean(cfg?.certificado_path?.trim());

    if (!t) {
      if (tieneCertificado) {
        return {
          ok: false,
          message: "Indicá la fecha de vencimiento del certificado .p12 cargado.",
        };
      }
      return { ok: true, iso: null };
    }

    const d = new Date(t + "T12:00:00");
    if (Number.isNaN(d.getTime())) {
      return { ok: false, message: "Fecha de vencimiento del certificado no válida" };
    }
    return { ok: true, iso: d.toISOString() };
  }

  async function guardar(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setSaving(true);
    try {
      const vencRes = resolveCertificadoVencimiento();
      if (!vencRes.ok) {
        setError(vencRes.message);
        setSaving(false);
        return;
      }
      const { iso: venc } = vencRes;

      if (!cfg) {
        const body: Record<string, unknown> = {
          ambiente,
          ruc: ruc.trim(),
          razon_social: razonSocial.trim(),
          timbrado_numero: timbradoNumero.trim(),
          establecimiento: establecimiento.trim(),
          punto_expedicion: puntoExpedicion.trim(),
          csc: csc.trim() || null,
          activo,
        };
        if (venc != null) body.certificado_vencimiento = venc;
        if (nuevaPassword.trim()) body.certificado_password = nuevaPassword.trim();

        const res = await fetch("/api/configuracion/sifen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const j = (await res.json()) as { success?: boolean; data?: EmpresaSifenConfigDTO; error?: string };
        if (!res.ok || !j.success) {
          setError(j.error ?? "No se pudo crear la configuración");
          return;
        }
        setCfg(j.data!);
        setNuevaPassword("");
        setSuccess("Configuración SIFEN creada correctamente.");
        if (j.data != null && isSifenConfigCompleta(j.data)) setEditarFormulario(false);
      } else {
        const body: Record<string, unknown> = {
          ambiente,
          ruc: ruc.trim(),
          razon_social: razonSocial.trim(),
          timbrado_numero: timbradoNumero.trim(),
          establecimiento: establecimiento.trim(),
          punto_expedicion: puntoExpedicion.trim(),
          csc: csc.trim() || null,
          activo,
          certificado_vencimiento: venc,
        };
        if (limpiarPassword) body.certificado_password = null;
        else if (nuevaPassword.trim()) body.certificado_password = nuevaPassword.trim();

        const res = await fetch("/api/configuracion/sifen", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const j = (await res.json()) as { success?: boolean; data?: EmpresaSifenConfigDTO; error?: string };
        if (!res.ok || !j.success) {
          setError(j.error ?? "No se pudo actualizar");
          return;
        }
        setCfg(j.data!);
        setNuevaPassword("");
        setLimpiarPassword(false);
        setSuccess("Cambios guardados.");
        if (j.data != null && isSifenConfigCompleta(j.data)) setEditarFormulario(false);
      }
      await load();
    } catch {
      setError("Error de red");
    } finally {
      setSaving(false);
    }
  }

  async function onCertFileChange(ev: React.ChangeEvent<HTMLInputElement>) {
    const file = ev.target.files?.[0];
    ev.target.value = "";
    if (!file) {
      setNombreArchivoCert(null);
      return;
    }
    setNombreArchivoCert(file.name);
    setError(null);
    setSuccess(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/configuracion/sifen/certificado", { method: "POST", body: fd });
      const j = (await res.json()) as {
        success?: boolean;
        data?: { config?: EmpresaSifenConfigDTO };
        error?: string;
      };
      if (!res.ok || !j.success) {
        setError(j.error ?? "No se pudo subir el certificado");
        return;
      }
      if (j.data?.config) setCfg(j.data.config);
      setNombreArchivoCert(null);
      setSuccess("Certificado .p12 cargado correctamente.");
      await load();
      const c = j.data?.config as EmpresaSifenConfigDTO | undefined;
      if (c && isSifenConfigCompleta(c)) setEditarFormulario(false);
    } catch {
      setError("Error de red al subir certificado");
    } finally {
      setUploading(false);
    }
  }

  const datosMinimosOk =
    Boolean(ruc.trim()) &&
    Boolean(razonSocial.trim()) &&
    Boolean(timbradoNumero.trim()) &&
    Boolean(establecimiento.trim()) &&
    Boolean(puntoExpedicion.trim());

  const tieneCert = Boolean(cfg?.certificado_path);
  const tieneCertificadoCargado = Boolean(cfg?.certificado_path?.trim());
  const tienePw = Boolean(cfg?.has_certificado_password);

  const configCompleta = cfg != null && isSifenConfigCompleta(cfg);
  const mostrarFormulario = cfg == null || !configCompleta || editarFormulario;

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto py-24 text-center text-sm text-slate-400">Cargando configuración SIFEN…</div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6 pb-12">
      <div className="flex flex-col gap-1">
        <Link href="/configuracion" className="text-xs font-medium text-[#0EA5E9] hover:underline w-fit">
          ← Volver a configuración global
        </Link>
        <h1 className="text-2xl font-bold text-gray-900">Facturación electrónica (SIFEN)</h1>
        <p className="text-sm text-gray-500">
          Datos del emisor y certificado digital. Las empresas sin SIFEN siguen usando facturas normales.
        </p>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 text-red-800 text-sm px-4 py-3">{error}</div>
      )}
      {success && (
        <div className="rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm px-4 py-3">
          {success}
        </div>
      )}

      {configCompleta && !mostrarFormulario && cfg && (
        <Card>
          <div className="rounded-xl border border-emerald-200 bg-gradient-to-b from-emerald-50/90 to-white px-5 py-5 space-y-4">
            <div className="flex flex-wrap items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-lg" aria-hidden>
                ✅
              </span>
              <div className="min-w-0 flex-1 space-y-1">
                <h2 className="text-lg font-bold text-emerald-950">Configuración SIFEN lista para operar</h2>
                <p className="text-sm text-emerald-900/80 leading-relaxed">
                  Ya completaste los datos del emisor, el certificado y la contraseña. Podés generar documentos electrónicos en el flujo de
                  facturas cuando corresponda.
                </p>
              </div>
            </div>
            <ul className="text-sm text-slate-700 space-y-1.5 border-t border-emerald-100 pt-4">
              <li>
                <span className="text-slate-500">Ambiente:</span>{" "}
                <span className="font-medium">{cfg.ambiente === "produccion" ? "Producción" : "Test"}</span>
              </li>
              <li>
                <span className="text-slate-500">RUC:</span> <span className="font-mono font-medium">{cfg.ruc}</span>
              </li>
              <li>
                <span className="text-slate-500">Razón social:</span> <span className="font-medium">{cfg.razon_social}</span>
              </li>
              <li>
                <span className="text-slate-500">Certificado .p12:</span>{" "}
                <span className="font-medium text-emerald-800">Cargado</span>
              </li>
              <li>
                <span className="text-slate-500">Contraseña del certificado:</span>{" "}
                <span className="font-medium text-emerald-800">Configurada</span>
              </li>
              <li>
                <span className="text-slate-500">SIFEN:</span>{" "}
                <span className="font-semibold text-emerald-800">Activo</span>
              </li>
            </ul>
            <button
              type="button"
              onClick={() => {
                setEditarFormulario(true);
                setSuccess(null);
              }}
              className="w-full sm:w-auto rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 shadow-sm hover:bg-slate-50"
            >
              Editar configuración
            </button>
          </div>
        </Card>
      )}

      {mostrarFormulario && (
      <Card>
        <SectionTitle>Estado</SectionTitle>
        <div className="flex flex-wrap gap-2">
          <span
            className={`text-xs font-semibold px-2.5 py-1 rounded-full border ${
              datosMinimosOk ? "bg-emerald-50 text-emerald-800 border-emerald-200" : "bg-amber-50 text-amber-800 border-amber-200"
            }`}
          >
            {datosMinimosOk ? "Datos obligatorios completos" : "Configuración incompleta"}
          </span>
          <span
            className={`text-xs font-semibold px-2.5 py-1 rounded-full border ${
              datosMinimosOk && activo
                ? "bg-sky-50 text-sky-900 border-sky-200"
                : "bg-slate-100 text-slate-600 border-slate-200"
            }`}
          >
            {datosMinimosOk && activo ? "Lista para operar (activo)" : activo ? "Revisá campos obligatorios" : "Inactivo — no se generan DE"}
          </span>
          <span
            className={`text-xs font-semibold px-2.5 py-1 rounded-full border ${
              tieneCert ? "bg-indigo-50 text-indigo-900 border-indigo-200" : "bg-slate-100 text-slate-500 border-slate-200"
            }`}
          >
            Certificado: {tieneCert ? "Cargado" : "No cargado"}
          </span>
          <span
            className={`text-xs font-semibold px-2.5 py-1 rounded-full border ${
              tienePw ? "bg-violet-50 text-violet-900 border-violet-200" : "bg-slate-100 text-slate-500 border-slate-200"
            }`}
          >
            Contraseña .p12: {tienePw ? "Configurada" : "No configurada"}
          </span>
        </div>
      </Card>
      )}

      <form onSubmit={guardar} className={`space-y-5 ${mostrarFormulario ? "" : "hidden"}`} aria-hidden={!mostrarFormulario}>
        <Card>
          <SectionTitle>Datos del emisor</SectionTitle>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={fLabel}>Ambiente</label>
              <select
                className={fSelect}
                value={ambiente}
                onChange={(e) => setAmbiente(e.target.value as AmbienteSifen)}
              >
                <option value="test">Test</option>
                <option value="produccion">Producción</option>
              </select>
            </div>
            <div className="flex items-end pb-2">
              <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={activo}
                  onChange={(e) => setActivo(e.target.checked)}
                  className="rounded border-slate-300"
                />
                SIFEN activo para esta empresa
              </label>
            </div>
            <div>
              <label className={fLabel}>RUC</label>
              <input className={fInput} value={ruc} onChange={(e) => setRuc(e.target.value)} required />
            </div>
            <div>
              <label className={fLabel}>Razón social</label>
              <input className={fInput} value={razonSocial} onChange={(e) => setRazonSocial(e.target.value)} required />
            </div>
            <div>
              <label className={fLabel}>Timbrado (número)</label>
              <input className={fInput} value={timbradoNumero} onChange={(e) => setTimbradoNumero(e.target.value)} required />
            </div>
            <div>
              <label className={fLabel}>Establecimiento</label>
              <input className={fInput} value={establecimiento} onChange={(e) => setEstablecimiento(e.target.value)} required />
            </div>
            <div>
              <label className={fLabel}>Punto de expedición</label>
              <input className={fInput} value={puntoExpedicion} onChange={(e) => setPuntoExpedicion(e.target.value)} required />
            </div>
            <div>
              <label className={fLabel}>CSC</label>
              <input
                className={fInput}
                value={csc}
                onChange={(e) => setCsc(e.target.value)}
                placeholder="Opcional"
                autoComplete="off"
              />
            </div>
          </div>
        </Card>

        <Card>
          <SectionTitle>Certificado digital (.p12)</SectionTitle>
          <p className="text-xs text-slate-500 mb-3">
            El archivo se guarda de forma privada. No se muestra la contraseña ni datos cifrados.
          </p>
          <div className="space-y-3">
            <div>
              <label className={fLabel}>Ruta en almacenamiento (solo lectura)</label>
              <input
                className={`${fInput} bg-slate-50 text-slate-600`}
                readOnly
                value={cfg?.certificado_path ?? "—"}
              />
            </div>
            <div>
              <label className={fLabel}>Vencimiento del certificado</label>
              <input type="date" className={fInput} value={certVenc} onChange={(e) => setCertVenc(e.target.value)} />
              <p className="text-xs text-slate-500 mt-1.5 leading-relaxed">
                {tieneCertificadoCargado ? (
                  <>
                    <span className="font-medium text-slate-600">Obligatorio</span> mientras tengas un .p12 cargado.
                  </>
                ) : (
                  <>Opcional hasta que subas el certificado; podés guardar la configuración base antes.</>
                )}
              </p>
            </div>
            <div>
              <label htmlFor={certFileInputId} className={`${fLabel} block`}>
                Subir / reemplazar .p12
              </label>
              <input
                ref={certFileInputRef}
                id={certFileInputId}
                type="file"
                accept=".p12,.pfx,application/x-pkcs12,application/octet-stream"
                disabled={!cfg || uploading}
                onChange={onCertFileChange}
                className="sr-only"
              />
              <div className="mt-1 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                <button
                  type="button"
                  disabled={!cfg || uploading}
                  onClick={() => certFileInputRef.current?.click()}
                  className="w-fit rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Seleccionar archivo
                </button>
                {nombreArchivoCert && (
                  <span className="text-xs text-slate-600 truncate max-w-full sm:max-w-xs" title={nombreArchivoCert}>
                    Archivo: <span className="font-mono font-medium text-slate-800">{nombreArchivoCert}</span>
                  </span>
                )}
              </div>
              {!cfg && (
                <p className="text-xs text-amber-700 mt-2">Guardá primero la configuración base para habilitar la subida del certificado.</p>
              )}
              {uploading && <p className="text-xs text-slate-500 mt-1">Subiendo…</p>}
            </div>
            <div>
              <label className={fLabel}>Contraseña del certificado</label>
              <input
                type="password"
                className={fInput}
                autoComplete="new-password"
                value={nuevaPassword}
                onChange={(e) => setNuevaPassword(e.target.value)}
                placeholder={cfg ? "Nueva contraseña (dejar vacío para no cambiar)" : "Opcional al crear"}
              />
              {cfg && (
                <label className="mt-2 flex items-center gap-2 text-xs text-slate-600 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={limpiarPassword}
                    onChange={(e) => setLimpiarPassword(e.target.checked)}
                    className="rounded border-slate-300"
                  />
                  Eliminar contraseña guardada en el servidor
                </label>
              )}
            </div>
          </div>
        </Card>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={saving}
            className="bg-[#0EA5E9] hover:bg-[#0284C7] text-white px-5 py-2.5 rounded-lg text-sm font-medium disabled:opacity-50"
          >
            {saving ? "Guardando…" : cfg ? "Guardar cambios" : "Crear configuración SIFEN"}
          </button>
          {configCompleta && editarFormulario && (
            <button
              type="button"
              onClick={() => {
                setEditarFormulario(false);
                setError(null);
                setSuccess(null);
                if (cfg) {
                  setAmbiente(cfg.ambiente);
                  setRuc(cfg.ruc);
                  setRazonSocial(cfg.razon_social);
                  setTimbradoNumero(cfg.timbrado_numero);
                  setEstablecimiento(cfg.establecimiento);
                  setPuntoExpedicion(cfg.punto_expedicion);
                  setCsc(cfg.csc ?? "");
                  setActivo(cfg.activo);
                  setCertVenc(isoToDateInput(cfg.certificado_vencimiento));
                }
                setNuevaPassword("");
                setLimpiarPassword(false);
              }}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              Cancelar edición
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
