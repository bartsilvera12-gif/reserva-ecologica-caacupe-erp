"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import { slaDeadlineBadge, type SlaBadge } from "@/lib/proyectos/sla-badge";
import ProyectoDetalleModal from "./components/ProyectoDetalleModal";

type EstadoRow = {
  id: string;
  nombre: string;
  codigo: string;
  color: string;
  sort_order: number;
};

type ProyectoCard = Record<string, unknown> & {
  id: string;
  titulo: string;
  prioridad: string;
  estado_id: string;
  last_activity_at?: string;
  fecha_ingreso?: string;
  fecha_prometida?: string | null;
  bloqueado?: boolean;
  archivado?: boolean;
  proyecto_tipo?: { nombre?: string; codigo?: string } | null;
  proyecto_estado?: { nombre?: string; color?: string; es_estado_final?: boolean } | null;
  cliente?: { empresa?: string | null; nombre_contacto?: string | null } | null;
  responsable_comercial?: { nombre?: string | null } | null;
  responsable_tecnico?: { nombre?: string | null } | null;
};

type DashboardData = {
  activos: number;
  vencidos: number;
  por_vencer: number;
  esperando_cliente: number;
  entregados_este_mes: number;
  tiempo_promedio_produccion_dias: number | null;
  por_estado: { estado_id: string; nombre: string; cantidad: number; color: string }[];
  por_responsable: { usuario_id: string; rol: string; cantidad: number }[];
};

type PrioridadConfig = {
  codigo: string;
  nombre: string;
  color: string | null;
  bg_color: string | null;
  text_color: string | null;
  border_color: string | null;
  sort_order: number;
  activo: boolean;
};

function badgeSlaLabel(b: SlaBadge): string {
  if (b === "ok") return "A tiempo";
  if (b === "por_vencer") return "Por vencer";
  if (b === "vencido") return "Vencido";
  return "—";
}

function badgeSlaClass(b: SlaBadge): string {
  if (b === "ok") return "bg-emerald-100 text-emerald-800";
  if (b === "por_vencer") return "bg-amber-100 text-amber-900";
  if (b === "vencido") return "bg-red-100 text-red-800";
  return "bg-slate-100 text-slate-600";
}

function prioridadClass(p: string): string {
  if (p === "urgente") return "bg-red-600 text-white";
  if (p === "alta") return "bg-orange-500 text-white";
  if (p === "normal") return "bg-slate-200 text-slate-800";
  return "bg-slate-100 text-slate-600";
}

export default function ProyectosKanbanClient() {
  const [estados, setEstados] = useState<EstadoRow[]>([]);
  const [proyectos, setProyectos] = useState<ProyectoCard[]>([]);
  const [prioridadesConfig, setPrioridadesConfig] = useState<PrioridadConfig[]>([]);
  const [dash, setDash] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [q, setQ] = useState("");
  const [filtroEstado, setFiltroEstado] = useState("");
  const [filtroTipo, setFiltroTipo] = useState("");
  const [filtroRc, setFiltroRc] = useState("");
  const [filtroRt, setFiltroRt] = useState("");
  const [tipoOpts, setTipoOpts] = useState<{ id: string; nombre: string }[]>([]);
  const [userOpts, setUserOpts] = useState<{ id: string; nombre?: string }[]>([]);
  const [modalProjectId, setModalProjectId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    const sp = new URLSearchParams();
    if (q.trim()) sp.set("q", q.trim());
    if (filtroEstado) sp.set("estado_id", filtroEstado);
    if (filtroTipo) sp.set("tipo_id", filtroTipo);
    if (filtroRc) sp.set("responsable_comercial_id", filtroRc);
    if (filtroRt) sp.set("responsable_tecnico_id", filtroRt);

    const [rEst, rPr, rDash, rTipos, rUsers, rPrioridades] = await Promise.all([
      fetchWithSupabaseSession("/api/proyectos/estados", { cache: "no-store" }),
      fetchWithSupabaseSession(`/api/proyectos?${sp.toString()}`, { cache: "no-store" }),
      fetchWithSupabaseSession("/api/proyectos/dashboard", { cache: "no-store" }),
      fetchWithSupabaseSession("/api/proyectos/tipos", { cache: "no-store" }),
      fetchWithSupabaseSession("/api/empresas/usuarios", { cache: "no-store" }),
      fetchWithSupabaseSession("/api/configuracion/proyectos/prioridades", { cache: "no-store" }),
    ]);

    const jEst = (await rEst.json().catch(() => ({}))) as { success?: boolean; data?: EstadoRow[]; error?: string };
    const jPr = (await rPr.json().catch(() => ({}))) as { success?: boolean; data?: ProyectoCard[]; error?: string };
    const jDash = (await rDash.json().catch(() => ({}))) as { success?: boolean; data?: DashboardData; error?: string };
    const jTipos = (await rTipos.json().catch(() => ({}))) as {
      success?: boolean;
      data?: { id: string; nombre: string }[];
    };
    const jUsers = (await rUsers.json().catch(() => ({}))) as { usuarios?: { id: string; nombre?: string }[] };
    const jPrioridades = (await rPrioridades.json().catch(() => ({}))) as {
      success?: boolean;
      data?: { prioridades?: PrioridadConfig[] };
    };

    if (!rEst.ok || !jEst.success) {
      setErr(jEst.error ?? "No se pudieron cargar estados");
      setLoading(false);
      return;
    }
    if (!rPr.ok || !jPr.success) {
      setErr(jPr.error ?? "No se pudieron cargar proyectos");
      setLoading(false);
      return;
    }
    if (rDash.ok && jDash.success && jDash.data) setDash(jDash.data);
    setEstados(jEst.data ?? []);
    setProyectos(jPr.data ?? []);

    if (jTipos.success && jTipos.data) setTipoOpts(jTipos.data);
    if (jUsers.usuarios) setUserOpts(jUsers.usuarios);
    if (rPrioridades.ok && jPrioridades.success && jPrioridades.data?.prioridades) {
      setPrioridadesConfig(jPrioridades.data.prioridades);
    } else {
      setPrioridadesConfig([]);
    }

    setLoading(false);
  }, [q, filtroEstado, filtroTipo, filtroRc, filtroRt]);

  useEffect(() => {
    void load();
  }, [load]);

  const byColumn = useMemo(() => {
    const m = new Map<string, ProyectoCard[]>();
    for (const e of estados) m.set(e.id, []);
    for (const p of proyectos) {
      const col = m.get(p.estado_id);
      if (col) col.push(p);
    }
    return m;
  }, [estados, proyectos]);

  const prioridadByCodigo = useMemo(() => {
    const m = new Map<string, PrioridadConfig>();
    for (const prioridad of prioridadesConfig) {
      if (prioridad.activo) m.set(prioridad.codigo, prioridad);
    }
    return m;
  }, [prioridadesConfig]);

  async function cambiarEstado(proyectoId: string, estadoId: string) {
    const res = await fetchWithSupabaseSession(`/api/proyectos/${proyectoId}/cambiar-estado`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estado_id: estadoId }),
    });
    const j = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
    if (!res.ok || !j.success) {
      setErr(j.error ?? "No se pudo cambiar el estado");
      return;
    }
    await load();
  }

  if (loading && proyectos.length === 0 && estados.length === 0) {
    return <div className="p-6 text-sm text-slate-500">Cargando proyectos…</div>;
  }

  if (err && proyectos.length === 0) {
    return <div className="p-6 text-sm text-red-600">{err}</div>;
  }

  return (
    <div className="mx-auto max-w-[1800px] space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Proyectos</h1>
          <p className="text-sm text-slate-500">Kanban configurable por empresa — producción, clientes y SLA.</p>
        </div>
        <Link
          href="/dashboard/proyectos/nuevo"
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          Nuevo proyecto
        </Link>
      </div>

      {err ? <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{err}</div> : null}

      {dash ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <Metric label="Activos" value={dash.activos} />
          <Metric label="Vencidos (fecha)" value={dash.vencidos} tone="danger" />
          <Metric label="Por vencer (48h)" value={dash.por_vencer} tone="warn" />
          <Metric label="Esperando cliente" value={dash.esperando_cliente} />
          <Metric label="Entregados (mes)" value={dash.entregados_este_mes} tone="ok" />
          <Metric
            label="Prom. producción (días)"
            value={dash.tiempo_promedio_produccion_dias ?? "—"}
            sub
          />
        </div>
      ) : null}

      <div className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-white p-4 shadow-sm xl:flex-row xl:flex-wrap xl:items-center">
        <input
          className="min-w-[200px] flex-1 rounded-md border border-slate-200 px-3 py-2 text-sm"
          placeholder="Buscar título o cliente…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void load()}
        />
        <button
          type="button"
          className="shrink-0 rounded-md bg-slate-100 px-3 py-2 text-sm font-medium text-slate-800 hover:bg-slate-200"
          onClick={() => void load()}
        >
          Buscar
        </button>
        <select
          className="min-w-[160px] shrink-0 rounded-md border border-slate-200 px-2 py-2 text-sm"
          value={filtroEstado}
          onChange={(e) => setFiltroEstado(e.target.value)}
        >
          <option value="">Todos los estados</option>
          {estados.map((e) => (
            <option key={e.id} value={e.id}>
              {e.nombre}
            </option>
          ))}
        </select>
        <select
          className="min-w-[140px] shrink-0 rounded-md border border-slate-200 px-2 py-2 text-sm"
          value={filtroTipo}
          onChange={(e) => setFiltroTipo(e.target.value)}
        >
          <option value="">Todos los tipos</option>
          {tipoOpts.map((t) => (
            <option key={t.id} value={t.id}>
              {t.nombre}
            </option>
          ))}
        </select>
        <select
          className="min-w-[170px] shrink-0 rounded-md border border-slate-200 px-2 py-2 text-sm"
          value={filtroRc}
          onChange={(e) => setFiltroRc(e.target.value)}
        >
          <option value="">Resp. comercial</option>
          {userOpts.map((u) => (
            <option key={u.id} value={u.id}>
              {u.nombre ?? u.id.slice(0, 8)}
            </option>
          ))}
        </select>
        <select
          className="min-w-[170px] shrink-0 rounded-md border border-slate-200 px-2 py-2 text-sm"
          value={filtroRt}
          onChange={(e) => setFiltroRt(e.target.value)}
        >
          <option value="">Resp. técnico</option>
          {userOpts.map((u) => (
            <option key={`t-${u.id}`} value={u.id}>
              {u.nombre ?? u.id.slice(0, 8)}
            </option>
          ))}
        </select>
      </div>

      <div className="overflow-x-auto pb-4">
        <div className="flex min-h-[480px] gap-4">
          {estados.map((col) => {
            const items = byColumn.get(col.id) ?? [];
            return (
              <div
                key={col.id}
                className="flex w-[300px] shrink-0 flex-col rounded-xl border border-slate-200 bg-slate-50/80"
              >
                <div
                  className="flex items-center justify-between border-b border-slate-200 px-3 py-2"
                  style={{ borderTopColor: col.color, borderTopWidth: 3 }}
                >
                  <span className="text-sm font-semibold text-slate-800">{col.nombre}</span>
                  <span className="rounded-full bg-white px-2 py-0.5 text-xs text-slate-600">{items.length}</span>
                </div>
                <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-2">
                  {items.map((p) => {
                    const prioridadConfig = prioridadByCodigo.get(p.prioridad);
                    const sla = slaDeadlineBadge({
                      fecha_prometida: p.fecha_prometida,
                      archivado: p.archivado,
                      estado_final: p.proyecto_estado?.es_estado_final,
                    });
                    const cli =
                      (p.cliente?.empresa || "").trim() ||
                      (p.cliente?.nombre_contacto || "").trim() ||
                      "Sin cliente";
                    return (
                      <div
                        key={p.id}
                        className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm hover:shadow-md"
                      >
                        <button
                          type="button"
                          className="block w-full cursor-pointer text-left"
                          onClick={() => setModalProjectId(p.id)}
                        >
                          <div className="text-sm font-semibold text-indigo-700 hover:underline">{p.titulo}</div>
                          <div className="mt-1 text-xs text-slate-600">{cli}</div>
                          <div className="mt-2 flex flex-wrap gap-1">
                            <span className="rounded px-1.5 py-0.5 text-[10px] font-medium text-slate-700 ring-1 ring-slate-200">
                              {p.proyecto_tipo?.nombre ?? "Tipo"}
                            </span>
                            <span
                              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                                prioridadConfig ? "border" : prioridadClass(p.prioridad)
                              }`}
                              style={
                                prioridadConfig
                                  ? {
                                      backgroundColor:
                                        prioridadConfig.bg_color ?? prioridadConfig.color ?? undefined,
                                      color: prioridadConfig.text_color ?? undefined,
                                      borderColor:
                                        prioridadConfig.border_color ??
                                        prioridadConfig.bg_color ??
                                        prioridadConfig.color ??
                                        undefined,
                                    }
                                  : undefined
                              }
                            >
                              {prioridadConfig?.nombre ?? p.prioridad}
                            </span>
                            <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${badgeSlaClass(sla)}`}>
                              SLA {badgeSlaLabel(sla)}
                            </span>
                            {p.bloqueado ? (
                              <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-medium text-rose-800">
                                Bloqueado
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-2 space-y-0.5 text-[11px] text-slate-500">
                            <div>Com.: {p.responsable_comercial?.nombre ?? "—"}</div>
                            <div>Téc.: {p.responsable_tecnico?.nombre ?? "—"}</div>
                            <div>Ingreso: {fmtDate(p.fecha_ingreso)}</div>
                            <div>Prometido: {fmtDate(p.fecha_prometida)}</div>
                            <div>Actividad: {fmtDateTime(p.last_activity_at)}</div>
                          </div>
                        </button>
                        <div className="mt-2" onClick={(e) => e.stopPropagation()}>
                          <Link
                            href={`/dashboard/proyectos/${p.id}`}
                            className="text-[10px] font-medium text-sky-600 hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            Abrir en página completa
                          </Link>
                        </div>
                        <label className="mt-2 block text-[10px] font-medium uppercase text-slate-500">Mover a</label>
                        <select
                          className="mt-1 w-full rounded border border-slate-200 px-2 py-1.5 text-xs"
                          value={p.estado_id}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => void cambiarEstado(p.id, e.target.value)}
                        >
                          {estados.map((e) => (
                            <option key={e.id} value={e.id}>
                              {e.nombre}
                            </option>
                          ))}
                        </select>
                      </div>
                    );
                  })}
                  {items.length === 0 ? (
                    <div className="py-8 text-center text-xs text-slate-400">Vacío</div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <p className="text-center text-xs text-slate-400">
        Arrastrar tarjetas: próxima fase — por ahora usá el selector de estado.
      </p>

      <ProyectoDetalleModal
        projectId={modalProjectId}
        open={modalProjectId != null}
        onClose={() => setModalProjectId(null)}
        onUpdated={() => void load()}
      />
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
  sub,
}: {
  label: string;
  value: number | string;
  tone?: "danger" | "warn" | "ok";
  sub?: boolean;
}) {
  const ring =
    tone === "danger"
      ? "border-red-200 bg-red-50"
      : tone === "warn"
        ? "border-amber-200 bg-amber-50"
        : tone === "ok"
          ? "border-emerald-200 bg-emerald-50"
          : "border-slate-200 bg-white";
  return (
    <div className={`rounded-xl border px-3 py-3 shadow-sm ${ring}`}>
      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${sub ? "text-slate-700" : "text-slate-900"}`}>{value}</div>
    </div>
  );
}

function fmtDate(s?: string | null): string {
  if (!s) return "—";
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString() : "—";
}

function fmtDateTime(s?: string | null): string {
  if (!s) return "—";
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : "—";
}
