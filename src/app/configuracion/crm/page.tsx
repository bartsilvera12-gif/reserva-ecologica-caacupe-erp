"use client";

import { useCallback, useEffect, useState } from "react";
import { ConfigFormCard, ConfigSectionTitle } from "@/components/config/global-config-primitives";
import { GlobalConfigSubpageShell } from "@/components/config/GlobalConfigSubpageShell";
import { getCurrentUser } from "@/lib/auth";
import { apiFetch } from "@/lib/api/fetch-with-supabase-session";
import {
  createEtapa,
  deleteEtapa,
  getEtapasParaConfig,
  getEtapaClasses,
  updateEtapa,
  type EtapaCrm,
} from "@/lib/crm/etapas";
import type { ClienteTipoServicioRow } from "@/lib/clientes/tipo-servicio-catalogo";

export default function ConfiguracionCrmPipelinePage() {
  const [esAdmin, setEsAdmin] = useState(false);
  const [etapasCrm, setEtapasCrm] = useState<EtapaCrm[]>([]);
  const [nuevaEtapa, setNuevaEtapa] = useState({ nombre: "", codigo: "", color: "gray", orden: 0 });
  const [editandoEtapa, setEditandoEtapa] = useState<string | null>(null);
  const [tiposServ, setTiposServ] = useState<ClienteTipoServicioRow[]>([]);
  const [cargandoTipos, setCargandoTipos] = useState(false);
  const [nuevoTipoNombre, setNuevoTipoNombre] = useState("");
  const [editandoTipo, setEditandoTipo] = useState<string | null>(null);

  useEffect(() => {
    getCurrentUser().then((u) => {
      const rol = (u as { rol?: string })?.rol;
      setEsAdmin(rol === "admin" || rol === "administrador" || rol === "super_admin");
    });
  }, []);

  const loadEtapas = useCallback(() => {
    void getEtapasParaConfig().then(setEtapasCrm);
  }, []);

  useEffect(() => {
    loadEtapas();
  }, [loadEtapas]);

  const loadTipos = useCallback(async () => {
    setCargandoTipos(true);
    try {
      if (esAdmin) {
        const r = await apiFetch("/api/cliente-tipos-servicio?all=1&with_usos=1");
        if (!r.ok) throw new Error("No se pudo cargar el catálogo de tipos");
        const j = (await r.json()) as { success?: boolean; data?: ClienteTipoServicioRow[] };
        if (j?.success && Array.isArray(j.data)) setTiposServ([...j.data].sort((a, b) => a.orden - b.orden));
        else setTiposServ([]);
      } else {
        const r = await apiFetch("/api/cliente-tipos-servicio?form=1");
        if (r.ok) {
          const j = (await r.json()) as { success?: boolean; data?: ClienteTipoServicioRow[] };
          if (j?.success && Array.isArray(j.data)) setTiposServ(j.data);
          else setTiposServ([]);
        } else {
          setTiposServ([]);
        }
      }
    } catch (e) {
      console.error("[config crm] tipos servicio", e);
      setTiposServ([]);
    } finally {
      setCargandoTipos(false);
    }
  }, [esAdmin]);

  useEffect(() => {
    void loadTipos();
  }, [loadTipos]);

  const reordenarTipo = (rowId: string, direction: "up" | "down") => {
    if (!esAdmin) return;
    const s = [...tiposServ].sort((a, b) => a.orden - b.orden);
    const i = s.findIndex((x) => x.id === rowId);
    if (i < 0) return;
    const j = direction === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= s.length) return;
    const a = s[i]!;
    const b = s[j]!;
    const ao = a.orden;
    const bo = b.orden;
    void (async () => {
      const r1 = await apiFetch(`/api/cliente-tipos-servicio/${a.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orden: bo }),
      });
      const r2 = await apiFetch(`/api/cliente-tipos-servicio/${b.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orden: ao }),
      });
      if (r1.ok && r2.ok) void loadTipos();
    })();
  };

  return (
    <GlobalConfigSubpageShell
      title="Configuración CRM"
      description="Etapas del pipeline comercial y columnas del embudo por empresa."
    >
      <div className="space-y-5">
        <ConfigFormCard>
          <ConfigSectionTitle>Estados del pipeline CRM</ConfigSectionTitle>
          {!esAdmin ? (
            <p className="text-sm text-slate-500">Solo usuarios con rol administrador pueden modificar las etapas del funnel.</p>
          ) : (
            <>
              <p className="mb-4 text-xs leading-relaxed text-slate-400">
                Definí las etapas (columnas) del pipeline comercial. Cada empresa tiene sus propias etapas.
              </p>
              <div className="space-y-4">
                {etapasCrm.map((e) => (
                  <div key={e.id} className="flex items-center gap-3 rounded-lg bg-slate-50 p-3">
                    <span className={`h-3 w-3 shrink-0 rounded-full ${getEtapaClasses(e.color).dot}`} />
                    <div className="min-w-0 flex-1">
                      {editandoEtapa === e.id ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <input
                            type="text"
                            defaultValue={e.nombre}
                            id={`edit-nombre-${e.id}`}
                            className="w-32 rounded border px-2 py-1 text-sm"
                          />
                          <select id={`edit-color-${e.id}`} defaultValue={e.color} className="rounded border px-2 py-1 text-sm">
                            {["gray", "blue", "amber", "green", "red", "violet", "cyan", "pink"].map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                          </select>
                          <input
                            type="number"
                            id={`edit-orden-${e.id}`}
                            defaultValue={e.orden}
                            className="w-16 rounded border px-2 py-1 text-sm"
                          />
                          <label className="flex items-center gap-1 text-xs">
                            <input type="checkbox" id={`edit-activo-${e.id}`} defaultChecked={e.activo} />
                            Activo
                          </label>
                          <button
                            type="button"
                            onClick={async () => {
                              const nombre = (document.getElementById(`edit-nombre-${e.id}`) as HTMLInputElement)?.value?.trim();
                              const color = (document.getElementById(`edit-color-${e.id}`) as HTMLSelectElement)?.value;
                              const orden = parseInt(
                                (document.getElementById(`edit-orden-${e.id}`) as HTMLInputElement)?.value ?? "0",
                                10
                              );
                              const activo = (document.getElementById(`edit-activo-${e.id}`) as HTMLInputElement)?.checked ?? true;
                              if (nombre) await updateEtapa(e.id, { nombre, color, orden, activo });
                              setEditandoEtapa(null);
                              loadEtapas();
                            }}
                            className="text-xs font-medium text-green-600 hover:text-green-800"
                          >
                            Guardar
                          </button>
                          <button type="button" onClick={() => setEditandoEtapa(null)} className="text-xs text-slate-500">
                            Cancelar
                          </button>
                        </div>
                      ) : (
                        <>
                          <span className="font-medium text-slate-800">{e.nombre}</span>
                          <span className="ml-2 text-xs text-slate-500">
                            ({e.codigo}) · orden {e.orden}
                          </span>
                          {!e.activo && <span className="ml-1 text-xs text-amber-600">· Inactivo</span>}
                        </>
                      )}
                    </div>
                    {editandoEtapa !== e.id && (
                      <div className="flex shrink-0 gap-1">
                        <button
                          type="button"
                          onClick={() => setEditandoEtapa(e.id)}
                          className="rounded px-2 py-1 text-xs text-slate-500 hover:bg-white hover:text-slate-800"
                        >
                          Editar
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            if (
                              confirm(
                                "¿Eliminar esta etapa? Los prospectos en esta etapa quedarán sin etapa asignada."
                              )
                            ) {
                              await deleteEtapa(e.id);
                              loadEtapas();
                            }
                          }}
                          className="rounded px-2 py-1 text-xs text-red-500 hover:bg-red-50 hover:text-red-800"
                        >
                          Eliminar
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <div className="mt-4 border-t border-slate-100 pt-4">
                <h5 className="mb-2 text-xs font-semibold text-slate-600">Crear nueva etapa</h5>
                <div className="flex flex-wrap items-end gap-2">
                  <div>
                    <label className="mb-0.5 block text-[10px] text-slate-500">Nombre</label>
                    <input
                      type="text"
                      value={nuevaEtapa.nombre}
                      onChange={(ev) =>
                        setNuevaEtapa((prev) => ({
                          ...prev,
                          nombre: ev.target.value,
                          codigo: ev.target.value.replace(/\s+/g, "_").toUpperCase(),
                        }))
                      }
                      placeholder="Ej: Calificación"
                      className="w-32 rounded border px-2 py-1.5 text-sm"
                    />
                  </div>
                  <div>
                    <label className="mb-0.5 block text-[10px] text-slate-500">Color</label>
                    <select
                      value={nuevaEtapa.color}
                      onChange={(ev) => setNuevaEtapa((prev) => ({ ...prev, color: ev.target.value }))}
                      className="rounded border px-2 py-1.5 text-sm"
                    >
                      {["gray", "blue", "amber", "green", "red", "violet", "cyan", "pink"].map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="mb-0.5 block text-[10px] text-slate-500">Orden</label>
                    <input
                      type="number"
                      value={nuevaEtapa.orden || ""}
                      onChange={(ev) => setNuevaEtapa((prev) => ({ ...prev, orden: parseInt(ev.target.value, 10) || 0 }))}
                      className="w-16 rounded border px-2 py-1.5 text-sm"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={async () => {
                      if (!nuevaEtapa.nombre.trim()) return;
                      const codigo = nuevaEtapa.codigo || nuevaEtapa.nombre.replace(/\s+/g, "_").toUpperCase();
                      const orden = nuevaEtapa.orden ?? (Math.max(0, ...etapasCrm.map((x) => x.orden)) + 1);
                      await createEtapa({ nombre: nuevaEtapa.nombre.trim(), codigo, color: nuevaEtapa.color, orden });
                      setNuevaEtapa({ nombre: "", codigo: "", color: "gray", orden: 0 });
                      loadEtapas();
                    }}
                    className="rounded bg-[#0EA5E9] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#0284C7]"
                  >
                    Crear etapa
                  </button>
                </div>
              </div>
            </>
          )}

          <div className="mt-6 border-t border-slate-200 pt-6">
            <ConfigSectionTitle>Tipos de servicio / segmentos de cliente</ConfigSectionTitle>
            <p className="mb-3 text-xs leading-relaxed text-slate-500">
              Estos tipos se usan para segmentar clientes, reportes, mora, cobranzas y análisis comercial. No borres slugs
              vinculados; podés <strong className="font-medium text-slate-600">desactivar</strong> un segmento o editar
              el nombre que ve el usuario.
            </p>
            {cargandoTipos ? (
              <p className="text-sm text-slate-400">Cargando…</p>
            ) : (
              <div className="space-y-2">
                {[...tiposServ].sort((a, b) => a.orden - b.orden).map((t, idx, arr) => (
                  <div key={t.id} className="flex items-start gap-2 rounded-lg border border-slate-100 bg-slate-50/50 p-3">
                    {esAdmin && (
                      <div className="flex flex-col gap-0.5 pt-0.5">
                        <button
                          type="button"
                          disabled={idx === 0}
                          onClick={() => reordenarTipo(t.id, "up")}
                          className="rounded border border-slate-200 px-1 text-xs leading-none text-slate-500 disabled:opacity-30"
                          aria-label="Subir"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          disabled={idx === arr.length - 1}
                          onClick={() => reordenarTipo(t.id, "down")}
                          className="rounded border border-slate-200 px-1 text-xs leading-none text-slate-500 disabled:opacity-30"
                          aria-label="Bajar"
                        >
                          ↓
                        </button>
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      {esAdmin && editandoTipo === t.id ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <input
                            id={`nmt-${t.id}`}
                            defaultValue={t.nombre}
                            className="w-40 rounded border px-2 py-1 text-sm"
                            disabled={!esAdmin}
                          />
                          <input
                            id={`ord-${t.id}`}
                            type="number"
                            defaultValue={t.orden}
                            className="w-16 rounded border px-2 py-1 text-sm"
                          />
                          <label className="flex items-center gap-1 text-xs">
                            <input type="checkbox" id={`ac-${t.id}`} defaultChecked={t.activo} />
                            Activo
                          </label>
                          <button
                            type="button"
                            className="text-xs font-medium text-green-600"
                            onClick={async () => {
                              const nombre = (document.getElementById(`nmt-${t.id}`) as HTMLInputElement)?.value?.trim();
                              const ord = parseInt(
                                (document.getElementById(`ord-${t.id}`) as HTMLInputElement)?.value ?? "0",
                                10
                              );
                              const activo = (document.getElementById(`ac-${t.id}`) as HTMLInputElement)?.checked ?? true;
                              if (nombre) {
                                await apiFetch(`/api/cliente-tipos-servicio/${t.id}`, {
                                  method: "PUT",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ nombre, orden: ord, activo }),
                                });
                              }
                              setEditandoTipo(null);
                              void loadTipos();
                            }}
                          >
                            Guardar
                          </button>
                          <button type="button" className="text-xs text-slate-500" onClick={() => setEditandoTipo(null)}>
                            Cancelar
                          </button>
                        </div>
                      ) : (
                        <>
                          <p className="text-sm font-medium text-slate-800">{t.nombre}</p>
                          <p className="text-xs text-slate-500">
                            <span className="font-mono">{t.slug}</span>
                            {t.es_sistema ? " · sistema" : null}
                            {" · "}
                            orden {t.orden}
                            {typeof t.usos === "number" ? ` · ${t.usos} clientes` : null}
                            {!t.activo && <span className="ml-1 text-amber-600">· inactivo</span>}
                          </p>
                        </>
                      )}
                    </div>
                    {esAdmin && editandoTipo !== t.id && (
                      <div className="flex flex-wrap gap-1">
                        <button
                          type="button"
                          className="text-xs text-slate-500 hover:text-slate-800"
                          onClick={() => setEditandoTipo(t.id)}
                        >
                          Editar
                        </button>
                        {!t.es_sistema && (
                          <button
                            type="button"
                            className="text-xs text-red-500 hover:text-red-700"
                            onClick={async () => {
                              if ((t.usos ?? 0) > 0) {
                                window.alert("Hay clientes con este segmento. Reasigná o desactivá en lugar de borrar.");
                                return;
                              }
                              if (!window.confirm("¿Eliminar este segmento? No debe tener clientes asignados.")) return;
                              const r = await apiFetch(`/api/cliente-tipos-servicio/${t.id}`, { method: "DELETE" });
                              if (r.ok) void loadTipos();
                            }}
                            disabled={(t.usos ?? 0) > 0}
                            title={
                              (t.usos ?? 0) > 0 ? "No se elimina mientras tenga clientes" : "Eliminar segmento"
                            }
                          >
                            Borrar
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ))}

                {esAdmin && (
                  <div className="mt-2 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3">
                    <div>
                      <span className="mb-0.5 block text-[10px] text-slate-500">Nuevo segmento (nombre en pantalla)</span>
                      <input
                        value={nuevoTipoNombre}
                        onChange={(e) => setNuevoTipoNombre(e.target.value)}
                        placeholder="Ej. Consultoría contable"
                        className="w-56 rounded border px-2 py-1.5 text-sm"
                      />
                    </div>
                    <button
                      type="button"
                      className="rounded bg-slate-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-900"
                      onClick={async () => {
                        if (!nuevoTipoNombre.trim()) return;
                        const r = await apiFetch("/api/cliente-tipos-servicio", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ nombre: nuevoTipoNombre.trim() }),
                        });
                        if (r.ok) {
                          setNuevoTipoNombre("");
                          void loadTipos();
                        } else {
                          const j = (await r.json().catch(() => ({}))) as { error?: string };
                          window.alert(j?.error?.trim() ? j.error : "Error al crear");
                        }
                      }}
                    >
                      Agregar tipo
                    </button>
                  </div>
                )}
                {!esAdmin && tiposServ.length > 0 && (
                  <p className="text-xs text-slate-400">Sólo se listan los segmentos activos. Pedí a un admin la gestión completa.</p>
                )}
              </div>
            )}
          </div>
        </ConfigFormCard>
      </div>
    </GlobalConfigSubpageShell>
  );
}
