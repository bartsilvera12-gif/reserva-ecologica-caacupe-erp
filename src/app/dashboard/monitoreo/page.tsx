"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  fetchMonitoringDashboard,
  fetchSupervisorAgentLoads,
  type MonitoringDashboard,
  type MonitoringReassignmentRow,
  type MonitoringUnassignedRow,
  type SupervisorAgentLoadRow,
} from "@/lib/chat/chat-ops-actions";
import { assignmentWaitBadge, assignmentWaitBadgeClass } from "@/lib/chat/inbox-assignment-labels";

function formatWait(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = Math.max(0, Date.now() - t);
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

export default function MonitoreoPage() {
  const [dash, setDash] = useState<MonitoringDashboard | null>(null);
  const [agents, setAgents] = useState<SupervisorAgentLoadRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [d, a] = await Promise.all([fetchMonitoringDashboard(), fetchSupervisorAgentLoads()]);
      setDash(d);
      setAgents(a);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al cargar");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-8 max-w-6xl pb-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Monitoreo</h1>
          <p className="text-sm text-slate-500 mt-1 max-w-2xl">
            Centro de control operativo: colas, canales, carga de agentes y conversaciones que requieren atención.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Link
            href="/configuracion/colas"
            className="text-sm font-semibold text-slate-700 hover:text-slate-900 underline-offset-2 hover:underline"
          >
            Colas y enrutamiento
          </Link>
          <Link
            href="/dashboard/conversaciones"
            className="inline-flex items-center rounded-xl bg-[#0EA5E9] px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-[#0284C7]"
          >
            Ir al inbox
          </Link>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>
      )}

      <section className="rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-50 to-white p-6 shadow-sm">
        <h2 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-4">Resumen general</h2>
        {loading || !dash ? (
          <p className="text-sm text-slate-400">Cargando métricas…</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            <MetricTile label="Colas activas" value={dash.active_queues} tone="slate" />
            <MetricTile label="Agentes asignados" value={dash.agents_assigned} tone="slate" />
            <MetricTile label="Chats sin asignar" value={dash.unassigned_chats} tone="amber" />
            <MetricTile label="Pend. 1ª respuesta" value={dash.awaiting_first_response} tone="amber" />
            <MetricTile label="Chats pendientes" value={dash.pending_chats} tone="sky" />
            <MetricTile label="Canales activos" value={dash.active_channels} tone="emerald" />
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-slate-800 uppercase tracking-wide">Chats sin asignar (recientes)</h2>
            <p className="text-xs text-slate-500 mt-1 max-w-3xl">
              <span className="font-medium text-slate-600">Motivo</span>: cola manual, sin agentes en estado{" "}
              <span className="font-medium">Disponible</span> para autoasignar, u otra espera en cola.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            className="text-xs font-semibold text-[#0EA5E9] hover:underline shrink-0"
          >
            Actualizar
          </button>
        </div>
        {loading || !dash ? (
          <p className="text-sm text-slate-400">Cargando…</p>
        ) : dash.unassigned_recent.length === 0 ? (
          <p className="text-sm text-slate-500">No hay conversaciones abiertas sin agente en este momento.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b border-slate-100">
                  <th className="pb-2 pr-3">Espera</th>
                  <th className="pb-2 pr-3">Contacto</th>
                  <th className="pb-2 pr-3">Canal</th>
                  <th className="pb-2 pr-3">Cola</th>
                  <th className="pb-2 pr-3">Motivo</th>
                  <th className="pb-2">Estado</th>
                </tr>
              </thead>
              <tbody>
                {dash.unassigned_recent.map((r: MonitoringUnassignedRow) => {
                  const w = assignmentWaitBadge(r.assignment_wait_code, Boolean(r.queue_id));
                  return (
                  <tr key={r.id} className="border-b border-slate-50">
                    <td className="py-2 pr-3 text-slate-700 tabular-nums">{formatWait(r.waiting_since)}</td>
                    <td className="py-2 pr-3">
                      <span className="font-medium text-slate-800">{r.contact_name ?? "—"}</span>
                      <span className="block text-xs text-slate-400 font-mono truncate max-w-[160px]">
                        {r.contact_phone ?? ""}
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-slate-600">
                      {r.channel_nombre ?? r.channel_type ?? "—"}
                    </td>
                    <td className="py-2 pr-3 text-slate-600">{r.queue_name ?? "—"}</td>
                    <td className="py-2 pr-3">
                      <span
                        className={`inline-block rounded-md border px-2 py-0.5 text-[10px] font-semibold ${assignmentWaitBadgeClass(w.tone)}`}
                      >
                        {w.label}
                      </span>
                    </td>
                    <td className="py-2">
                      <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">
                        {r.status}
                      </span>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between gap-2 mb-3">
          <h2 className="text-sm font-bold text-slate-800 uppercase tracking-wide">
            Reasignaciones por SLA (primera respuesta)
          </h2>
          <button
            type="button"
            onClick={() => void load()}
            className="text-xs font-semibold text-[#0EA5E9] hover:underline"
          >
            Actualizar
          </button>
        </div>
        {loading || !dash ? (
          <p className="text-sm text-slate-400">Cargando…</p>
        ) : dash.recent_initial_reassignments.length === 0 ? (
          <p className="text-sm text-slate-500">
            No hay reasignaciones recientes registradas por falta de primera respuesta humana.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b border-slate-100">
                  <th className="pb-2 pr-3">Cuándo</th>
                  <th className="pb-2 pr-3">Conversación</th>
                  <th className="pb-2">Detalle</th>
                </tr>
              </thead>
              <tbody>
                {dash.recent_initial_reassignments.map((r: MonitoringReassignmentRow) => (
                  <tr key={r.id} className="border-b border-slate-50">
                    <td className="py-2 pr-3 text-slate-600 whitespace-nowrap">
                      {new Date(r.created_at).toLocaleString("es")}
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs text-slate-700">{r.conversation_id.slice(0, 8)}…</td>
                    <td className="py-2 text-xs text-slate-600">
                      {(r.payload.from_agent_id as string | undefined)?.slice(0, 8) ?? "—"} →{" "}
                      {(r.payload.to_agent_id as string | undefined)?.slice(0, 8) ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-bold text-slate-800 uppercase tracking-wide mb-3">Agentes y carga</h2>
        {loading ? (
          <p className="text-sm text-slate-400">Cargando…</p>
        ) : agents.length === 0 ? (
          <p className="text-sm text-slate-500">
            No hay filas en <code className="text-xs bg-slate-100 px-1 rounded">chat_agents</code>. Asigná usuarios
            desde <Link href="/configuracion/colas" className="text-[#0EA5E9] font-semibold hover:underline">Colas</Link>.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b border-slate-100">
                  <th className="pb-2 pr-3">Cola</th>
                  <th className="pb-2 pr-3">Agente</th>
                  <th className="pb-2 pr-3">En línea</th>
                  <th className="pb-2 pr-3">Turno</th>
                  <th className="pb-2 pr-3">Máx.</th>
                  <th className="pb-2 pr-3">Chats activos</th>
                  <th className="pb-2">Sin 1ª resp.</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((a) => (
                  <tr key={a.id} className="border-b border-slate-50">
                    <td className="py-2 pr-3 text-slate-600">{a.queue_nombre}</td>
                    <td className="py-2 pr-3">
                      <span className="font-medium text-slate-800">{a.nombre}</span>
                      <span className="block text-xs text-slate-400 truncate max-w-[200px]">{a.email}</span>
                    </td>
                    <td className="py-2 pr-3">
                      {a.is_online ? (
                        <span className="text-emerald-700 text-xs font-semibold">Sí</span>
                      ) : (
                        <span className="text-slate-400 text-xs">No</span>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      {a.operational_status === "ready" ? (
                        <span className="text-emerald-800 text-xs font-semibold">Disponible</span>
                      ) : (
                        <span className="text-slate-500 text-xs font-medium">En pausa</span>
                      )}
                    </td>
                    <td className="py-2 pr-3">{a.max_conversations}</td>
                    <td className="py-2 pr-3">
                      <span
                        className={
                          a.active_conversations >= a.max_conversations
                            ? "text-amber-700 font-semibold"
                            : "text-slate-700"
                        }
                      >
                        {a.active_conversations}
                      </span>
                    </td>
                    <td className="py-2">
                      <span className={a.pending_first_reply > 0 ? "text-amber-800 font-semibold" : "text-slate-500"}>
                        {a.pending_first_reply}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function MetricTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "slate" | "amber" | "sky" | "emerald";
}) {
  const tones: Record<string, string> = {
    slate: "bg-slate-50 border-slate-200 text-slate-900",
    amber: "bg-amber-50 border-amber-200 text-amber-950",
    sky: "bg-sky-50 border-sky-200 text-sky-950",
    emerald: "bg-emerald-50 border-emerald-200 text-emerald-950",
  };
  return (
    <div className={`rounded-xl border px-4 py-3 ${tones[tone]}`}>
      <p className="text-[10px] font-bold uppercase tracking-wide opacity-80">{label}</p>
      <p className="text-2xl font-bold tabular-nums mt-1">{value}</p>
    </div>
  );
}
