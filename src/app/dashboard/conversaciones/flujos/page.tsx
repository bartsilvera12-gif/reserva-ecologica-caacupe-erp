"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { getSorteoById } from "@/lib/sorteos/actions";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";

type FlowRow = {
  id: string;
  flow_code: string;
  label: string | null;
  channel: string;
  activo: boolean;
  node_count: number;
  updated_at: string;
  sorteo_id: string | null;
  sorteo_nombre: string | null;
};

function fmt(iso: string) {
  try {
    return new Date(iso).toLocaleString("es-PY", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/** Código interno estable: letras minúsculas, números y guiones bajos (válido para `flow_code`). */
function suggestedFlowCodeFromSorteoName(nombre: string): string {
  const base = nombre
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  if (base.length > 0) return `sorteo_${base}`;
  return "sorteo_whatsapp";
}

function FlowsListContent() {
  const searchParams = useSearchParams();
  const sorteoIdParam = searchParams?.get("sorteo_id")?.trim() || null;

  const [rows, setRows] = useState<FlowRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<ReactNode>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [togglingCode, setTogglingCode] = useState<string | null>(null);
  const [duplicatingCode, setDuplicatingCode] = useState<string | null>(null);
  const [newCode, setNewCode] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [duplicateFrom, setDuplicateFrom] = useState("");
  const prefilledSorteoRef = useRef(false);

  async function reload() {
    setLoading(true);
    try {
      const res = await fetchWithSupabaseSession("/api/chat/flows", {
        credentials: "same-origin",
        cache: "no-store",
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        items?: FlowRow[];
      };
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Error al cargar flujos");
      setRows(json.items ?? []);
      setError(null);
      setSuccess(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al cargar flujos");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  useEffect(() => {
    if (!sorteoIdParam || prefilledSorteoRef.current) return;
    prefilledSorteoRef.current = true;
    void getSorteoById(sorteoIdParam).then((s) => {
      if (!s) return;
      setNewCode((prev) => (prev.trim() ? prev : suggestedFlowCodeFromSorteoName(s.nombre)));
      setNewLabel((prev) => (prev.trim() ? prev : s.nombre.trim() || suggestedFlowCodeFromSorteoName(s.nombre)));
    });
  }, [sorteoIdParam]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const flowCode = newCode.trim();
    if (!flowCode) {
      setError("Definí un flow_code: es el identificador técnico del flujo (ej. sorteo_navidad). Podés cambiarlo antes de crear.");
      return;
    }
    setCreating(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetchWithSupabaseSession("/api/chat/flows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          flow_code: flowCode,
          label: newLabel.trim() || flowCode,
          duplicate_from: duplicateFrom.trim() || undefined,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Error al crear flujo");
      setNewCode("");
      setNewLabel("");
      setDuplicateFrom("");
      await reload();
      const editorHref = `/configuracion/conversaciones/flujos/${encodeURIComponent(flowCode)}`;
      setSuccess(
        <>
          Flujo «{flowCode}» creado correctamente.{" "}
          <Link href={editorHref} className="font-semibold text-emerald-800 underline underline-offset-2">
            Abrir editor del flujo
          </Link>
          {sorteoIdParam
            ? " para vincular este sorteo y configurar los mensajes."
            : " para asociar un sorteo y los pasos del WhatsApp."}
        </>,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al crear flujo");
    } finally {
      setCreating(false);
    }
  }

  async function toggleFlow(flowCode: string, activo: boolean) {
    setTogglingCode(flowCode);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetchWithSupabaseSession(`/api/chat/flows/${encodeURIComponent(flowCode)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ activo: !activo }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error ?? "No se pudo actualizar estado");
      await reload();
      setSuccess(`Flujo ${flowCode} ${activo ? "desactivado" : "activado"} correctamente.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al actualizar estado");
    } finally {
      setTogglingCode(null);
    }
  }

  async function duplicateFlow(sourceFlowCode: string) {
    const suggested = `${sourceFlowCode}_copy`;
    const newFlowCode = prompt("Nuevo flow_code para duplicar:", suggested)?.trim() || "";
    if (!newFlowCode) return;
    setDuplicatingCode(sourceFlowCode);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetchWithSupabaseSession("/api/chat/flows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          flow_code: newFlowCode,
          label: `${newFlowCode}`,
          duplicate_from: sourceFlowCode,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error ?? "No se pudo duplicar flujo");
      await reload();
      setSuccess(`Flujo ${sourceFlowCode} duplicado como ${newFlowCode}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al duplicar flujo");
    } finally {
      setDuplicatingCode(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap justify-between gap-3 items-start">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Flujos conversacionales</h1>
          <p className="text-sm text-slate-500">Administración simple de flujos WhatsApp por empresa</p>
        </div>
        <Link
          href="/configuracion/canales"
          className="text-sm font-medium text-[#0EA5E9] hover:underline px-3 py-2 rounded-lg border border-sky-200 bg-sky-50"
        >
          Ir a Canales y comunicación
        </Link>
      </div>

      {sorteoIdParam ? (
        <div className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
          Venís desde un sorteo: completá el formulario y después en{" "}
          <strong>Editar</strong> del flujo elegí ese sorteo en la configuración del bot.
        </div>
      ) : null}

      {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-2">{error}</div>}
      {success && <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2">{success}</div>}

      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
        <p className="text-sm text-slate-600 leading-relaxed">
          Crear un sorteo no crea solo el flujo de WhatsApp: aquí definís el{" "}
          <strong className="text-slate-800">flow_code</strong> (identificador único interno, sin espacios). El nombre
          que venís usando en el sorteo puede ir en <strong>label visible</strong>. Para atender compras por WhatsApp,
          después abrís <strong>Editar</strong> en el flujo y allí vinculás el sorteo y los pasos del chat.
        </p>
        <form noValidate onSubmit={handleCreate} className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
          <div className="space-y-1 md:col-span-1">
            <label htmlFor="flow-new-code" className="block text-xs font-semibold text-slate-600">
              flow_code <span className="text-red-600">*</span>
            </label>
            <input
              id="flow-new-code"
              type="text"
              autoComplete="off"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono"
              placeholder="ej: sorteo_navidad"
              value={newCode}
              onChange={(e) => setNewCode(e.target.value)}
              aria-describedby="flow-code-help"
            />
            <p id="flow-code-help" className="text-[11px] text-slate-500 leading-snug">
              Solo letras minúsculas, números y guiones bajos. No es el nombre público del sorteo.
            </p>
          </div>
          <div className="space-y-1 md:col-span-1">
            <label htmlFor="flow-new-label" className="block text-xs font-semibold text-slate-600">
              Nombre visible
            </label>
            <input
              id="flow-new-label"
              type="text"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
              placeholder="Cómo lo ves en la lista"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
            />
          </div>
          <div className="space-y-1 md:col-span-1">
            <label htmlFor="flow-duplicate-from" className="block text-xs font-semibold text-slate-600">
              Duplicar desde (opcional)
            </label>
            <input
              id="flow-duplicate-from"
              type="text"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono"
              placeholder="flow_code de otro flujo"
              value={duplicateFrom}
              onChange={(e) => setDuplicateFrom(e.target.value)}
            />
          </div>
          <button
            type="submit"
            disabled={creating}
            className="bg-[#0EA5E9] hover:bg-[#0284C7] disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium"
          >
            {creating ? "Creando..." : "Crear flujo"}
          </button>
        </form>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 text-sm font-semibold text-slate-700">Listado</div>
        {loading ? (
          <div className="p-6 text-sm text-slate-400 animate-pulse">Cargando...</div>
        ) : rows.length === 0 ? (
          <div className="p-6 text-sm text-slate-500">
            No hay flujos creados. Completá el flow_code arriba y pulsá Crear flujo (no es un error del sistema).
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="text-left px-4 py-2">flow_code</th>
                  <th className="text-left px-4 py-2">nombre</th>
                  <th className="text-left px-4 py-2">canal</th>
                  <th className="text-left px-4 py-2">estado</th>
                  <th className="text-left px-4 py-2">nodos</th>
                  <th className="text-left px-4 py-2">sorteo</th>
                  <th className="text-left px-4 py-2">actualizado</th>
                  <th className="text-left px-4 py-2">acciones</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-slate-100">
                    <td className="px-4 py-2 font-mono">{r.flow_code}</td>
                    <td className="px-4 py-2">{r.label || r.flow_code}</td>
                    <td className="px-4 py-2">{r.channel}</td>
                    <td className="px-4 py-2">
                      {r.activo ? <span className="text-emerald-600">Activo</span> : <span className="text-amber-600">Inactivo</span>}
                    </td>
                    <td className="px-4 py-2">{r.node_count}</td>
                    <td className="px-4 py-2">
                      {r.sorteo_id ? (
                        <span className="text-emerald-700 text-xs font-medium">{r.sorteo_nombre || "Sí"}</span>
                      ) : (
                        <span className="text-slate-400 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2">{fmt(r.updated_at)}</td>
                    <td className="px-4 py-2 flex gap-3">
                      <Link href={`/configuracion/conversaciones/flujos/${encodeURIComponent(r.flow_code)}`} className="text-[#0EA5E9] hover:underline">
                        Editar
                      </Link>
                      <button type="button" onClick={() => void toggleFlow(r.flow_code, r.activo)} className="text-slate-600 hover:underline" disabled={togglingCode === r.flow_code}>
                        {togglingCode === r.flow_code ? "..." : r.activo ? "Desactivar" : "Activar"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void duplicateFlow(r.flow_code)}
                        className="text-slate-600 hover:underline"
                        disabled={duplicatingCode === r.flow_code}
                      >
                        {duplicatingCode === r.flow_code ? "..." : "Duplicar"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function FlowsListFallback() {
  return <div className="p-6 text-sm text-slate-400">Cargando flujos…</div>;
}

export default function FlowsListPage() {
  return (
    <Suspense fallback={<FlowsListFallback />}>
      <FlowsListContent />
    </Suspense>
  );
}
