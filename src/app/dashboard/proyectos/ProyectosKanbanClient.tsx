"use client";

import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
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
  inactiveFallback?: boolean;
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
  proyecto_estado?: { nombre?: string; codigo?: string; color?: string; es_estado_final?: boolean } | null;
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

type ProjectCardViewProps = {
  p: ProyectoCard;
  estados: EstadoRow[];
  estadoActivoIds: Set<string>;
  prioridadConfig?: PrioridadConfig;
  onOpen: (id: string) => void;
  onMove: (proyectoId: string, estadoId: string) => void;
  moving?: boolean;
  dragOverlay?: boolean;
};

type KanbanColumnViewProps = {
  col: EstadoRow;
  children: ReactNode;
};

const PROJECT_DRAG_PREFIX = "project:";
const COLUMN_DROP_PREFIX = "estado:";

function projectDragId(projectId: string): string {
  return `${PROJECT_DRAG_PREFIX}${projectId}`;
}

function estadoDropId(estadoId: string): string {
  return `${COLUMN_DROP_PREFIX}${estadoId}`;
}

function readProjectIdFromDragId(id: unknown): string | null {
  const raw = String(id ?? "");
  return raw.startsWith(PROJECT_DRAG_PREFIX) ? raw.slice(PROJECT_DRAG_PREFIX.length) : null;
}

function readEstadoIdFromDropId(id: unknown): string | null {
  const raw = String(id ?? "");
  return raw.startsWith(COLUMN_DROP_PREFIX) ? raw.slice(COLUMN_DROP_PREFIX.length) : null;
}

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

function prioridadFallbackVisual(p: string): {
  bgColor: string;
  textColor: string;
  borderColor: string;
  accentColor: string;
} {
  if (p === "urgente") {
    return { bgColor: "#dc2626", textColor: "#ffffff", borderColor: "#b91c1c", accentColor: "#dc2626" };
  }
  if (p === "alta") {
    return { bgColor: "#f97316", textColor: "#ffffff", borderColor: "#ea580c", accentColor: "#f97316" };
  }
  if (p === "normal") {
    return { bgColor: "#e2e8f0", textColor: "#1e293b", borderColor: "#cbd5e1", accentColor: "#94a3b8" };
  }
  return { bgColor: "#f1f5f9", textColor: "#475569", borderColor: "#cbd5e1", accentColor: "#94a3b8" };
}

function prioridadClass(p: string): string {
  if (p === "urgente") return "bg-red-600 text-white";
  if (p === "alta") return "bg-orange-500 text-white";
  if (p === "normal") return "bg-slate-200 text-slate-800";
  return "bg-slate-100 text-slate-600";
}

function hexToRgba(hex: string | null | undefined, alpha: number): string | null {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export default function ProyectosKanbanClient() {
  const [estados, setEstados] = useState<EstadoRow[]>([]);
  const [proyectos, setProyectos] = useState<ProyectoCard[]>([]);
  const [prioridadesConfig, setPrioridadesConfig] = useState<PrioridadConfig[]>([]);
  const [dash, setDash] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [movingProjectId, setMovingProjectId] = useState<string | null>(null);
  const [activeDragProjectId, setActiveDragProjectId] = useState<string | null>(null);

  const [q, setQ] = useState("");
  const [filtroEstado, setFiltroEstado] = useState("");
  const [filtroTipo, setFiltroTipo] = useState("");
  const [filtroRc, setFiltroRc] = useState("");
  const [filtroRt, setFiltroRt] = useState("");
  const [tipoOpts, setTipoOpts] = useState<{ id: string; nombre: string }[]>([]);
  const [userOpts, setUserOpts] = useState<{ id: string; nombre?: string }[]>([]);
  const [modalProjectId, setModalProjectId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor)
  );

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

  const estadoActivoIds = useMemo(() => new Set(estados.map((e) => e.id)), [estados]);

  const kanbanColumns = useMemo(() => {
    const columns = [...estados];
    const missing = new Map<string, EstadoRow>();
    for (const p of proyectos) {
      if (estadoActivoIds.has(p.estado_id) || missing.has(p.estado_id)) continue;
      missing.set(p.estado_id, {
        id: p.estado_id,
        nombre: `Oculto / no usado: ${p.proyecto_estado?.nombre ?? "Estado sin configurar"}`,
        codigo: p.proyecto_estado?.codigo ?? "estado_inactivo",
        color: p.proyecto_estado?.color ?? "#94a3b8",
        sort_order: 9999,
        inactiveFallback: true,
      });
    }
    return [...columns, ...missing.values()];
  }, [estadoActivoIds, estados, proyectos]);

  const byColumn = useMemo(() => {
    const m = new Map<string, ProyectoCard[]>();
    for (const e of kanbanColumns) m.set(e.id, []);
    for (const p of proyectos) {
      const col = m.get(p.estado_id);
      if (col) col.push(p);
    }
    return m;
  }, [kanbanColumns, proyectos]);

  const prioridadByCodigo = useMemo(() => {
    const m = new Map<string, PrioridadConfig>();
    for (const prioridad of prioridadesConfig) {
      if (prioridad.activo) m.set(prioridad.codigo, prioridad);
    }
    return m;
  }, [prioridadesConfig]);

  const activeDragProject = useMemo(
    () => proyectos.find((p) => p.id === activeDragProjectId) ?? null,
    [activeDragProjectId, proyectos]
  );

  async function cambiarEstado(proyectoId: string, estadoId: string): Promise<boolean> {
    if (!estadoActivoIds.has(estadoId)) {
      setErr("No se puede mover a una columna inactiva.");
      return false;
    }

    const currentProject = proyectos.find((p) => p.id === proyectoId);
    if (!currentProject) {
      setErr("No se encontró el proyecto a mover.");
      return false;
    }
    if (currentProject.estado_id === estadoId) return true;

    const previousProjects = proyectos;
    const destino = estados.find((e) => e.id === estadoId);
    setErr(null);
    setMovingProjectId(proyectoId);
    setProyectos((prev) =>
      prev.map((p) =>
        p.id === proyectoId
          ? {
              ...p,
              estado_id: estadoId,
              proyecto_estado: destino
                ? {
                    ...(p.proyecto_estado ?? {}),
                    nombre: destino.nombre,
                    codigo: destino.codigo,
                    color: destino.color,
                    es_estado_final: p.proyecto_estado?.es_estado_final,
                  }
                : p.proyecto_estado,
            }
          : p
      )
    );

    try {
      const res = await fetchWithSupabaseSession(`/api/proyectos/${proyectoId}/cambiar-estado`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estado_id: estadoId }),
      });
      const j = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
      if (!res.ok || !j.success) {
        setProyectos(previousProjects);
        setErr(j.error ?? "No se pudo cambiar el estado. La tarjeta volvió a su columna anterior.");
        setMovingProjectId(null);
        return false;
      }
      setMovingProjectId(null);
      await load();
      return true;
    } catch (e) {
      setProyectos(previousProjects);
      setErr(
        e instanceof Error
          ? `${e.message}. La tarjeta volvió a su columna anterior.`
          : "No se pudo cambiar el estado. La tarjeta volvió a su columna anterior."
      );
      setMovingProjectId(null);
      return false;
    }
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveDragProjectId(readProjectIdFromDragId(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent) {
    const proyectoId = readProjectIdFromDragId(event.active.id);
    const estadoId = readEstadoIdFromDropId(event.over?.id);
    setActiveDragProjectId(null);

    if (!proyectoId || !estadoId) return;
    void cambiarEstado(proyectoId, estadoId);
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

      <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <div className="overflow-x-auto pb-4">
          <div className="flex min-h-[480px] gap-4">
            {kanbanColumns.map((col) => {
              const items = byColumn.get(col.id) ?? [];
              return (
                <KanbanColumnView key={col.id} col={col}>
                  <div
                    className="sticky top-3 z-20 flex items-center justify-between border-b border-slate-200 bg-white/95 px-3 py-2 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-white/85"
                    style={{ borderTopColor: col.color, borderTopWidth: 3 }}
                  >
                    <span className="text-sm font-semibold text-slate-800">{col.nombre}</span>
                    <span className="rounded-full bg-white px-2 py-0.5 text-xs text-slate-600">{items.length}</span>
                  </div>
                  {col.inactiveFallback ? (
                    <div className="border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      Esta columna está inactiva, pero contiene proyectos. Movelos a una columna activa.
                    </div>
                  ) : null}
                  <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-2">
                    {items.map((p) => (
                      <ProjectCardView
                        key={p.id}
                        p={p}
                        estados={estados}
                        estadoActivoIds={estadoActivoIds}
                        prioridadConfig={prioridadByCodigo.get(p.prioridad)}
                        onOpen={setModalProjectId}
                        onMove={(proyectoId, estadoId) => void cambiarEstado(proyectoId, estadoId)}
                        moving={movingProjectId === p.id}
                      />
                    ))}
                    {items.length === 0 ? (
                      <div className="py-8 text-center text-xs text-slate-400">Soltá tarjetas acá</div>
                    ) : null}
                  </div>
                </KanbanColumnView>
              );
            })}
          </div>
        </div>
        <DragOverlay>
          {activeDragProject ? (
            <ProjectCardView
              p={activeDragProject}
              estados={estados}
              estadoActivoIds={estadoActivoIds}
              prioridadConfig={prioridadByCodigo.get(activeDragProject.prioridad)}
              onOpen={() => undefined}
              onMove={() => undefined}
              dragOverlay
            />
          ) : null}
        </DragOverlay>
      </DndContext>

      <p className="text-center text-xs text-slate-400">
        Arrastrá tarjetas entre columnas activas o usá el selector “Mover a” como alternativa.
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

function KanbanColumnView({ col, children }: KanbanColumnViewProps) {
  const { isOver, setNodeRef } = useDroppable({
    id: estadoDropId(col.id),
    disabled: col.inactiveFallback === true,
    data: { estadoId: col.id, active: col.inactiveFallback !== true },
  });

  return (
    <div
      ref={setNodeRef}
      className={`flex w-[300px] shrink-0 flex-col rounded-xl border bg-slate-50/80 transition-colors ${
        isOver && !col.inactiveFallback
          ? "border-indigo-300 bg-indigo-50/70 ring-2 ring-indigo-100"
          : "border-slate-200"
      }`}
    >
      {children}
    </div>
  );
}

function ProjectCardView({
  p,
  estados,
  estadoActivoIds,
  prioridadConfig,
  onOpen,
  onMove,
  moving,
  dragOverlay,
}: ProjectCardViewProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: projectDragId(p.id),
    disabled: dragOverlay === true,
    data: { projectId: p.id, estadoId: p.estado_id },
  });

  const sla = slaDeadlineBadge({
    fecha_prometida: p.fecha_prometida,
    archivado: p.archivado,
    estado_final: p.proyecto_estado?.es_estado_final,
  });
  const cli =
    (p.cliente?.empresa || "").trim() ||
    (p.cliente?.nombre_contacto || "").trim() ||
    "Sin cliente";

  const style: CSSProperties | undefined = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;
  const fallbackPriority = prioridadFallbackVisual(p.prioridad);
  const priorityAccent =
    prioridadConfig?.border_color ??
    prioridadConfig?.color ??
    prioridadConfig?.bg_color ??
    fallbackPriority.accentColor;
  const priorityBg = prioridadConfig?.bg_color ?? prioridadConfig?.color ?? fallbackPriority.bgColor;
  const cardTint = hexToRgba(priorityBg, 0.1);
  const cardStyle: CSSProperties = {
    ...style,
    borderLeftColor: priorityAccent,
    background: cardTint ? `linear-gradient(90deg, ${cardTint}, #ffffff 42%)` : undefined,
  };
  const badgeStyle: CSSProperties | undefined = prioridadConfig
    ? {
        backgroundColor: prioridadConfig.bg_color ?? prioridadConfig.color ?? undefined,
        color: prioridadConfig.text_color ?? undefined,
        borderColor:
          prioridadConfig.border_color ??
          prioridadConfig.bg_color ??
          prioridadConfig.color ??
          undefined,
      }
    : undefined;

  return (
    <div
      ref={setNodeRef}
      style={cardStyle}
      {...attributes}
      {...listeners}
      className={`touch-none rounded-lg border border-l-4 border-slate-200 bg-white p-3 shadow-sm transition-shadow hover:shadow-md ${
        dragOverlay ? "rotate-1 cursor-grabbing shadow-2xl" : "cursor-grab active:cursor-grabbing"
      } ${isDragging ? "opacity-40" : ""} ${moving ? "ring-2 ring-sky-100" : ""}`}
    >
      <button
        type="button"
        className="block w-full text-left"
        onClick={() => {
          if (!dragOverlay) onOpen(p.id);
        }}
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
            style={badgeStyle}
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
          {moving ? (
            <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-800">
              Guardando...
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
      {!dragOverlay ? (
        <>
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
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => onMove(p.id, e.target.value)}
          >
            {!estadoActivoIds.has(p.estado_id) ? (
              <option value={p.estado_id}>Estado actual oculto / no usado</option>
            ) : null}
            {estados.map((e) => (
              <option key={e.id} value={e.id}>
                {e.nombre}
              </option>
            ))}
          </select>
        </>
      ) : null}
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
