"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

type FlowNodeOption = {
  id: string;
  node_id: string;
  label: string;
  option_value: string;
  meta_button_id: string;
  next_node_code: string | null;
  sort_order: number;
  option_payload?: Record<string, unknown>;
};

type FlowNodeBlock = {
  id: string;
  node_id: string;
  block_type: "text" | "image" | "buttons";
  content_text: string | null;
  media_url: string | null;
  sort_order: number;
};

type FlowNode = {
  id: string;
  node_code: string;
  node_type: string;
  message_text: string | null;
  save_as_field: string | null;
  next_node_code: string | null;
  sort_order: number;
  created_at: string;
  is_active: boolean;
  crm_action_type: string | null;
  crm_action_config: Record<string, unknown>;
  options: FlowNodeOption[];
  blocks: FlowNodeBlock[];
};

const NODE_TYPE_OPTIONS = [
  { value: "text", label: "Texto libre", help: "Espera respuesta de texto del cliente." },
  {
    value: "media",
    label: "Mensaje con imagen",
    help: "Envía una sola burbuja con imagen y texto opcional (caption).",
  },
  { value: "buttons", label: "Botones", help: "Muestra botones rápidos al cliente." },
  { value: "list", label: "Lista", help: "Interacción tipo lista (catálogo de opciones)." },
  { value: "image_input", label: "Solicitar imagen", help: "Espera imagen/comprobante del cliente." },
  { value: "human", label: "Derivar a humano", help: "Pasa la conversación a atención humana." },
  { value: "end", label: "Finalizar", help: "Cierra la automatización del flujo." },
] as const;

const MAX_WHATSAPP_IMAGE_CAPTION = 1024;

function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

function prettifyCode(code: string): string {
  return code
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function friendlyNodeTitle(node: FlowNode): string {
  if (node.node_type === "media") {
    const mediaCaption = node.blocks.find((b) => b.block_type === "image")?.content_text?.trim();
    if (mediaCaption) return `Mensaje con imagen: ${mediaCaption.slice(0, 24)}${mediaCaption.length > 24 ? "..." : ""}`;
    return "Mensaje con imagen";
  }
  const txt = node.message_text?.trim();
  if (txt) return txt.slice(0, 42) + (txt.length > 42 ? "..." : "");
  return prettifyCode(node.node_code);
}

function nodeTypeLabel(nodeType: string): string {
  return NODE_TYPE_OPTIONS.find((n) => n.value === nodeType)?.label ?? nodeType;
}

function nodeTypeHelp(nodeType: string): string {
  return (
    NODE_TYPE_OPTIONS.find((n) => n.value === nodeType)?.help ??
    "Configurá este paso según la experiencia del cliente."
  );
}

function nodeAccent(nodeType: string): string {
  if (nodeType === "media") return "border-l-fuchsia-400";
  if (nodeType === "buttons" || nodeType === "list") return "border-l-sky-400";
  if (nodeType === "human") return "border-l-amber-400";
  if (nodeType === "end") return "border-l-emerald-400";
  if (nodeType === "image_input") return "border-l-violet-400";
  return "border-l-slate-300";
}

function toMetaButtonId(label: string): string {
  return (
    label
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 50) || `btn_${Date.now()}`
  );
}

function stringifyOptionPayload(value: Record<string, unknown> | undefined): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return "{}";
  }
}

export default function FlowEditorPage() {
  const params = useParams<{ flowCode: string }>();
  const flowCode = decodeURIComponent(params?.flowCode ?? "");
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [newNodeCode, setNewNodeCode] = useState("");
  const [newNodeType, setNewNodeType] = useState("text");
  const [creatingNode, setCreatingNode] = useState(false);
  const [savingNodeId, setSavingNodeId] = useState<string | null>(null);
  const [lastSavedNodeId, setLastSavedNodeId] = useState<string | null>(null);
  const [expandedNodeId, setExpandedNodeId] = useState<string | null>(null);
  const [optionPayloadDrafts, setOptionPayloadDrafts] = useState<Record<string, string>>({});

  const orderedNodes = useMemo(
    () =>
      [...nodes].sort((a, b) => {
        const bySort = (a.sort_order ?? 0) - (b.sort_order ?? 0);
        if (bySort !== 0) return bySort;
        const byCreatedAt = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        if (!Number.isNaN(byCreatedAt) && byCreatedAt !== 0) return byCreatedAt;
        return a.node_code.localeCompare(b.node_code);
      }),
    [nodes]
  );

  const nodeByCode = useMemo(
    () => new Map(orderedNodes.map((n) => [n.node_code, n])),
    [orderedNodes]
  );

  const nodeCodes = useMemo(() => orderedNodes.map((n) => n.node_code), [orderedNodes]);

  function getImageBlock(node: FlowNode): FlowNodeBlock | undefined {
    return node.blocks.find((b) => b.block_type === "image");
  }

  function getTextPreview(node: FlowNode): string {
    const blockText = node.blocks.find((b) => b.block_type === "text")?.content_text?.trim();
    if (blockText) return blockText;
    return node.message_text?.trim() || "Sin texto de vista previa";
  }

  function nextStepLabel(nextNodeCode: string | null): string {
    if (!nextNodeCode) return "Sin siguiente paso";
    const target = nodeByCode.get(nextNodeCode);
    if (!target) return `${prettifyCode(nextNodeCode)} (pendiente crear)`;
    return friendlyNodeTitle(target);
  }

  async function reload(): Promise<FlowNode[]> {
    setLoading(true);
    try {
      const res = await fetch(`/api/chat/flows/${encodeURIComponent(flowCode)}/nodes`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        items?: FlowNode[];
      };
      if (!res.ok || !json.ok) throw new Error(json.error ?? "No se pudo cargar nodos");
      const items = json.items ?? [];
      setNodes(items);
      setOptionPayloadDrafts((prev) => {
        const next = { ...prev };
        for (const node of items) {
          for (const option of node.options ?? []) {
            if (typeof next[option.id] !== "string") {
              next[option.id] = stringifyOptionPayload(option.option_payload);
            }
          }
        }
        return next;
      });
      setError(null);
      return items;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al cargar");
      return [];
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, [flowCode]);

  async function createNode(e: React.FormEvent) {
    e.preventDefault();
    const trimmedCode = newNodeCode.trim();
    if (!trimmedCode) {
      setError("Escribí el nombre del paso (código interno) antes de crear el nodo.");
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmedCode)) {
      setError("El código del paso solo puede tener letras, números, guion y guion bajo.");
      return;
    }
    setError(null);
    setSuccess(null);
    setCreatingNode(true);
    try {
      const res = await fetch(`/api/chat/flows/${encodeURIComponent(flowCode)}/nodes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          node_code: trimmedCode,
          node_type: newNodeType,
          message_text: "",
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error ?? "No se pudo crear nodo");
      setNewNodeCode("");
      const reloaded = await reload();
      const created = reloaded.find((n) => n.node_code === trimmedCode);
      setExpandedNodeId(created?.id ?? null);
      setSuccess(`Paso ${prettifyCode(trimmedCode)} creado.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error creando nodo");
    } finally {
      setCreatingNode(false);
    }
  }

  async function saveNode(node: FlowNode) {
    setError(null);
    if (node.node_type === "media") {
      const mediaBlock = getImageBlock(node);
      const mediaUrl = mediaBlock?.media_url?.trim() ?? "";
      const captionSize = (mediaBlock?.content_text ?? "").trim().length;
      if (!mediaBlock) {
        throw new Error("Este nodo requiere configurar una imagen antes de guardar.");
      }
      if (!mediaUrl || !isValidHttpUrl(mediaUrl)) {
        throw new Error("El nodo 'Mensaje con imagen' requiere una URL válida de imagen.");
      }
      if (captionSize > MAX_WHATSAPP_IMAGE_CAPTION) {
        throw new Error(`El caption supera ${MAX_WHATSAPP_IMAGE_CAPTION} caracteres.`);
      }
      // UX: guardar el bloque media junto con el paso para evitar errores por cambios no persistidos.
      await saveBlock(node, mediaBlock);
    }
    const res = await fetch(
      `/api/chat/flows/${encodeURIComponent(flowCode)}/nodes/${encodeURIComponent(node.node_code)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          node_type: node.node_type,
          message_text: node.message_text ?? "",
          save_as_field: node.save_as_field ?? null,
          next_node_code: node.next_node_code ?? null,
          is_active: node.is_active,
          crm_action_type: node.crm_action_type ?? null,
          crm_action_config: node.crm_action_config ?? {},
        }),
      }
    );
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || !json.ok) throw new Error(json.error ?? "No se pudo guardar nodo");
  }

  async function saveOption(node: FlowNode, opt: FlowNodeOption) {
    if ((node.node_type === "buttons" || node.node_type === "list") && !opt.next_node_code) {
      throw new Error("Seleccioná 'Va a' para esta opción antes de guardar.");
    }
    const payloadDraft = optionPayloadDrafts[opt.id] ?? stringifyOptionPayload(opt.option_payload);
    let payloadParsed: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(payloadDraft) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("El payload debe ser un objeto JSON");
      }
      payloadParsed = parsed as Record<string, unknown>;
    } catch {
      throw new Error("Variables JSON inválidas para esta opción.");
    }
    const metaButtonId = toMetaButtonId(opt.label);
    const res = await fetch(
      `/api/chat/flows/${encodeURIComponent(flowCode)}/nodes/${encodeURIComponent(node.node_code)}/options/${opt.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          label: opt.label,
          meta_button_id: metaButtonId,
          next_node_code: opt.next_node_code,
          sort_order: opt.sort_order,
          option_payload: payloadParsed,
        }),
      }
    );
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || !json.ok) throw new Error(json.error ?? "No se pudo guardar opción");
    setSuccess(`Botón "${opt.label}" guardado.`);
  }

  async function createOption(node: FlowNode) {
    const label = "Nueva opción";
    const defaultNext = nodeCodes.find((code) => code !== node.node_code) ?? null;
    const res = await fetch(
      `/api/chat/flows/${encodeURIComponent(flowCode)}/nodes/${encodeURIComponent(node.node_code)}/options`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          label,
          meta_button_id: toMetaButtonId(label),
          next_node_code: defaultNext,
          sort_order: node.options.length + 1,
          option_payload: {},
        }),
      }
    );
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || !json.ok) throw new Error(json.error ?? "No se pudo crear opción");
    setSuccess(`Opción creada en ${prettifyCode(node.node_code)}.`);
  }

  async function createBlock(node: FlowNode, blockType: FlowNodeBlock["block_type"]) {
    const res = await fetch(
      `/api/chat/flows/${encodeURIComponent(flowCode)}/nodes/${encodeURIComponent(node.node_code)}/blocks`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          block_type: blockType,
          content_text: blockType === "text" ? "Nuevo texto" : blockType === "buttons" ? "Elegí una opción" : null,
          media_url: null,
          sort_order: node.blocks.length + 1,
        }),
      }
    );
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || !json.ok) throw new Error(json.error ?? "No se pudo crear bloque");
  }

  async function saveBlock(node: FlowNode, block: FlowNodeBlock) {
    const res = await fetch(
      `/api/chat/flows/${encodeURIComponent(flowCode)}/nodes/${encodeURIComponent(node.node_code)}/blocks/${block.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          block_type: block.block_type,
          content_text: block.content_text,
          media_url: block.media_url,
          sort_order: block.sort_order,
        }),
      }
    );
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || !json.ok) throw new Error(json.error ?? "No se pudo guardar bloque");
  }

  async function deleteBlock(node: FlowNode, blockId: string) {
    const res = await fetch(
      `/api/chat/flows/${encodeURIComponent(flowCode)}/nodes/${encodeURIComponent(node.node_code)}/blocks/${blockId}`,
      { method: "DELETE", credentials: "same-origin" }
    );
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || !json.ok) throw new Error(json.error ?? "No se pudo eliminar bloque");
  }

  async function uploadImage(file: File): Promise<string> {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/chat/flow-media/upload", {
      method: "POST",
      body: fd,
      credentials: "same-origin",
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; media_url?: string };
    if (!res.ok || !json.ok || !json.media_url) throw new Error(json.error ?? "No se pudo subir imagen");
    return json.media_url;
  }

  async function deleteOption(node: FlowNode, optionId: string) {
    const res = await fetch(
      `/api/chat/flows/${encodeURIComponent(flowCode)}/nodes/${encodeURIComponent(node.node_code)}/options/${optionId}`,
      { method: "DELETE", credentials: "same-origin" }
    );
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || !json.ok) throw new Error(json.error ?? "No se pudo eliminar opción");
    setSuccess("Opción eliminada.");
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap justify-between gap-3 items-start">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Editor de flujo: {flowCode}</h1>
          <p className="text-sm text-slate-500">Nodos + opciones de botones + preparación CRM</p>
        </div>
        <Link
          href="/configuracion/conversaciones/flujos"
          className="text-sm font-medium text-[#0EA5E9] hover:underline px-3 py-2 rounded-lg border border-sky-200 bg-sky-50"
        >
          Volver a Configuración de Flujos
        </Link>
      </div>

      {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-2">{error}</div>}
      {success && <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2">{success}</div>}

      <form onSubmit={createNode} className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap gap-3 items-end shadow-sm">
        <div className="flex-1 min-w-[180px]">
          <label className="block text-xs text-slate-500 mb-1">Nombre del paso (código interno)</label>
          <input className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" value={newNodeCode} onChange={(e) => setNewNodeCode(e.target.value)} placeholder="ej: datos_pago" />
        </div>
        <div className="min-w-[180px]">
          <label className="block text-xs text-slate-500 mb-1">Tipo de nodo</label>
          <select className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" value={newNodeType} onChange={(e) => setNewNodeType(e.target.value)}>
            {NODE_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-slate-500">{nodeTypeHelp(newNodeType)}</p>
        </div>
        <button
          type="submit"
          disabled={creatingNode}
          className="bg-[#0EA5E9] hover:bg-[#0284C7] disabled:opacity-60 text-white px-4 py-2 rounded-lg text-sm font-medium"
        >
          {creatingNode ? "Creando..." : "Crear nodo"}
        </button>
      </form>

      {loading ? (
        <div className="p-6 text-sm text-slate-400 animate-pulse">Cargando nodos...</div>
      ) : (
        <div className="space-y-4">
          {orderedNodes.map((node, idx) => {
            const isExpanded = expandedNodeId === node.id;
            return (
            <div key={node.id} className={`bg-white border border-slate-200 border-l-4 ${nodeAccent(node.node_type)} rounded-xl p-4 space-y-3 shadow-sm`}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-slate-800">Paso #{idx + 1}: {friendlyNodeTitle(node)}</div>
                  <div className="text-xs text-slate-500">Tipo: {nodeTypeLabel(node.node_type)} · {nodeTypeHelp(node.node_type)}</div>
                  {lastSavedNodeId === node.id && (
                    <div className="text-xs text-emerald-600 mt-1">Guardado correctamente.</div>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <label className="text-sm text-slate-700 flex items-center gap-2">
                    <input type="checkbox" checked={node.is_active} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === node.id ? { ...n, is_active: e.target.checked } : n))} />
                    Activo
                  </label>
                  <button
                    type="button"
                    onClick={() => setExpandedNodeId((prev) => (prev === node.id ? null : node.id))}
                    className="text-xs text-[#0EA5E9] hover:underline"
                  >
                    {isExpanded ? "Cerrar edición" : "Editar"}
                  </button>
                </div>
              </div>

              {!isExpanded && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
                  <div className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                    <div className="text-[11px] uppercase text-slate-500">Nombre del paso</div>
                    <div className="font-mono text-slate-800">{node.node_code}</div>
                  </div>
                  <div className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                    <div className="text-[11px] uppercase text-slate-500">Tipo</div>
                    <div className="text-slate-800">{nodeTypeLabel(node.node_type)}</div>
                  </div>
                  <div className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                    <div className="text-[11px] uppercase text-slate-500">Siguiente paso</div>
                    <div className="text-slate-800">{nextStepLabel(node.next_node_code)}</div>
                  </div>
                </div>
              )}

              {isExpanded && (
              <>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Nombre del paso</label>
                  <input className="border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono w-full" value={node.node_code} readOnly />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Tipo de nodo</label>
                  <select className="border border-slate-200 rounded-lg px-3 py-2 text-sm w-full" value={node.node_type} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === node.id ? { ...n, node_type: e.target.value } : n))}>
                    {NODE_TYPE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Siguiente paso</label>
                  <select className="border border-slate-200 rounded-lg px-3 py-2 text-sm w-full" value={node.next_node_code ?? ""} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === node.id ? { ...n, next_node_code: e.target.value || null } : n))}>
                    <option value="">(finaliza en este paso)</option>
                    {nodeCodes.filter((code) => code !== node.node_code).map((code) => (
                      <option key={code} value={code}>{nextStepLabel(code)}</option>
                    ))}
                  </select>
                </div>
              </div>

              {node.node_type !== "media" && (
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Mensaje al cliente (compatibilidad)</label>
                  <textarea className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm min-h-[74px]" placeholder="Se usa solo en nodos sin bloques configurados" value={node.message_text ?? ""} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === node.id ? { ...n, message_text: e.target.value } : n))} />
                  <p className="text-[11px] text-slate-500 mt-1">
                    Podés usar placeholders del contexto, por ejemplo: {"{{producto}}"}, {"{{cantidad}}"}, {"{{monto}}"}.
                  </p>
                </div>
              )}

              <div className="text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                Este paso va a → <span className="font-medium text-slate-800">{nextStepLabel(node.next_node_code)}</span>
              </div>

              <div className="border border-slate-100 rounded-lg p-3 bg-slate-50/60 text-xs text-slate-600">
                {node.node_type === "media" ? (
                  (() => {
                    const mediaBlock = getImageBlock(node);
                    const mediaUrl = mediaBlock?.media_url?.trim() ?? "";
                    const caption = mediaBlock?.content_text?.trim() ?? "";
                    return (
                      <div className="space-y-2">
                        <div className="font-semibold uppercase text-[11px] text-slate-500">Vista previa del mensaje</div>
                        {mediaUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={mediaUrl} alt="Preview media" className="max-h-36 rounded border border-slate-200 bg-white" />
                        ) : (
                          <div className="text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                            Falta URL de imagen.
                          </div>
                        )}
                        <div>{caption || "Sin texto opcional"}</div>
                        <div className="text-[11px] text-slate-500">
                          WhatsApp enviará una sola burbuja con imagen y texto opcional debajo.
                        </div>
                      </div>
                    );
                  })()
                ) : (
                  <div>
                    <div className="font-semibold uppercase text-[11px] text-slate-500 mb-1">Vista previa del mensaje</div>
                    {getTextPreview(node)}
                  </div>
                )}
              </div>

              <details className="border border-slate-100 rounded-lg p-3 bg-slate-50/60">
                <summary className="text-sm font-medium text-slate-700 cursor-pointer">Opciones avanzadas</summary>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Guardar respuesta como</label>
                    <input className="border border-slate-200 rounded-lg px-3 py-2 text-sm w-full" placeholder="ej: nombre, cedula, ciudad" value={node.save_as_field ?? ""} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === node.id ? { ...n, save_as_field: e.target.value || null } : n))} />
                  </div>
                  <div className="md:col-span-2">
                    <label className="block text-xs text-slate-500 mb-1">Acción en CRM (opcional)</label>
                    <input className="border border-slate-200 rounded-lg px-3 py-2 text-sm w-full" placeholder="ej: create_lead, move_funnel_stage, assign_advisor" value={node.crm_action_type ?? ""} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === node.id ? { ...n, crm_action_type: e.target.value || null } : n))} />
                  </div>
                </div>
              </details>

              {node.node_type === "media" && (
                <div className="border border-fuchsia-100 rounded-lg p-3 space-y-3 bg-fuchsia-50/40">
                  <div className="text-xs font-semibold text-fuchsia-700 uppercase">Mensaje con imagen</div>
                  <p className="text-xs text-slate-600">
                    WhatsApp enviará una sola burbuja con imagen y texto opcional debajo.
                  </p>
                  {getImageBlock(node) ? (
                    (() => {
                      const mediaBlock = getImageBlock(node)!;
                      return (
                        <div className="space-y-2">
                          <label className="block text-xs text-slate-500 mb-1">Imagen / URL de imagen</label>
                          <input
                            type="file"
                            accept="image/*"
                            onChange={async (e) => {
                              try {
                                const file = e.target.files?.[0];
                                if (!file) return;
                                const mediaUrl = await uploadImage(file);
                                setNodes((prev) =>
                                  prev.map((n) =>
                                    n.id !== node.id
                                      ? n
                                      : {
                                          ...n,
                                          blocks: n.blocks.map((b) =>
                                            b.id === mediaBlock.id ? { ...b, media_url: mediaUrl } : b
                                          ),
                                        }
                                  )
                                );
                              } catch (err) {
                                setError(err instanceof Error ? err.message : "No se pudo subir imagen");
                              } finally {
                                e.target.value = "";
                              }
                            }}
                            className="text-xs"
                          />
                          <input
                            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                            value={mediaBlock.media_url ?? ""}
                            placeholder="https://..."
                            onChange={(e) =>
                              setNodes((prev) =>
                                prev.map((n) =>
                                  n.id !== node.id
                                    ? n
                                    : {
                                        ...n,
                                        blocks: n.blocks.map((b) =>
                                          b.id === mediaBlock.id ? { ...b, media_url: e.target.value } : b
                                        ),
                                      }
                                )
                              )
                            }
                          />
                          {!!mediaBlock.media_url && !isValidHttpUrl(mediaBlock.media_url) && (
                            <div className="text-[11px] text-red-600">La URL debe iniciar con http:// o https://</div>
                          )}

                          <label className="block text-xs text-slate-500 mb-1 mt-2">Texto del mensaje (opcional)</label>
                          <textarea
                            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm min-h-[70px]"
                            value={mediaBlock.content_text ?? ""}
                            placeholder="Escribí un texto opcional para mostrar debajo de la imagen"
                            onChange={(e) =>
                              setNodes((prev) =>
                                prev.map((n) =>
                                  n.id !== node.id
                                    ? n
                                    : {
                                        ...n,
                                        blocks: n.blocks.map((b) =>
                                          b.id === mediaBlock.id ? { ...b, content_text: e.target.value } : b
                                        ),
                                      }
                                )
                              )
                            }
                          />
                          <div className={`text-[11px] ${(mediaBlock.content_text ?? "").length > MAX_WHATSAPP_IMAGE_CAPTION ? "text-red-600" : "text-slate-500"}`}>
                            Texto: {(mediaBlock.content_text ?? "").length}/{MAX_WHATSAPP_IMAGE_CAPTION}
                          </div>
                          <p className="text-[11px] text-slate-500">
                            Este texto también acepta placeholders, por ejemplo {"{{opcion_label}}"} o {"{{monto}}"}.
                          </p>
                        </div>
                      );
                    })()
                  ) : (
                    <button
                      type="button"
                      className="text-xs text-[#0EA5E9] hover:underline"
                      onClick={async () => {
                        try {
                          await createBlock(node, "image");
                          await reload();
                        } catch (e) {
                          setError(e instanceof Error ? e.message : "Error al preparar mensaje con imagen");
                        }
                      }}
                    >
                      + Configurar mensaje con imagen
                    </button>
                  )}
                </div>
              )}

              {node.node_type !== "media" && (
              <div className="border border-slate-100 rounded-lg p-3 space-y-3 bg-slate-50/60">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-semibold text-slate-600 uppercase">
                    {node.node_type === "media" ? "Bloque de imagen saliente" : "Bloques del mensaje"}
                  </div>
                  <div className="flex gap-2">
                    {node.node_type !== "media" && (
                      <button type="button" className="text-xs text-[#0EA5E9] hover:underline" onClick={async () => {
                        try { await createBlock(node, "text"); await reload(); } catch (e) { setError(e instanceof Error ? e.message : "Error"); }
                      }}>+ Texto</button>
                    )}
                    <button type="button" className="text-xs text-[#0EA5E9] hover:underline" onClick={async () => {
                      try { await createBlock(node, "image"); await reload(); } catch (e) { setError(e instanceof Error ? e.message : "Error"); }
                    }}>+ Imagen</button>
                    {node.node_type !== "media" && (
                      <button type="button" className="text-xs text-[#0EA5E9] hover:underline" onClick={async () => {
                        try { await createBlock(node, "buttons"); await reload(); } catch (e) { setError(e instanceof Error ? e.message : "Error"); }
                      }}>+ Botones</button>
                    )}
                  </div>
                </div>
                {node.blocks.length === 0 && (
                  <div className="text-xs text-slate-500">
                    {node.node_type === "media"
                      ? "Este nodo necesita un bloque de imagen con URL válida."
                      : "Sin bloques. Se usará el mensaje de compatibilidad."}
                  </div>
                )}
                {node.node_type === "media" && node.blocks.some((b) => b.block_type !== "image") && (
                  <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                    Este nodo usa solo bloques de imagen; los demás bloques se ignoran en la vista.
                  </div>
                )}
                {(node.node_type === "media"
                  ? node.blocks.filter((b) => b.block_type === "image")
                  : node.blocks
                ).map((block, bi) => (
                  <div key={block.id} className="bg-white border border-slate-200 rounded-lg p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="text-xs text-slate-500">Bloque #{bi + 1} ({block.block_type})</div>
                      <div className="flex gap-2">
                        <button type="button" className="text-xs text-slate-600 hover:underline" disabled={bi === 0} onClick={async () => {
                          try {
                            const prev = node.blocks[bi - 1];
                            if (!prev) return;
                            await saveBlock(node, { ...block, sort_order: prev.sort_order });
                            await saveBlock(node, { ...prev, sort_order: block.sort_order });
                            await reload();
                          } catch (e) { setError(e instanceof Error ? e.message : "Error"); }
                        }}>↑</button>
                        <button type="button" className="text-xs text-slate-600 hover:underline" disabled={bi === node.blocks.length - 1} onClick={async () => {
                          try {
                            const next = node.blocks[bi + 1];
                            if (!next) return;
                            await saveBlock(node, { ...block, sort_order: next.sort_order });
                            await saveBlock(node, { ...next, sort_order: block.sort_order });
                            await reload();
                          } catch (e) { setError(e instanceof Error ? e.message : "Error"); }
                        }}>↓</button>
                        <button type="button" className="text-xs text-red-600 hover:underline" onClick={async () => {
                          try { await deleteBlock(node, block.id); await reload(); } catch (e) { setError(e instanceof Error ? e.message : "Error"); }
                        }}>Eliminar</button>
                      </div>
                    </div>
                    {block.block_type === "text" && (
                      <textarea
                        className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm min-h-[64px]"
                        value={block.content_text ?? ""}
                        placeholder="Texto del bloque"
                        onChange={(e) => setNodes((prev) => prev.map((n) => n.id !== node.id ? n : ({ ...n, blocks: n.blocks.map((b) => b.id === block.id ? { ...b, content_text: e.target.value } : b) })))}
                      />
                    )}
                    {block.block_type === "image" && (
                      <div className="space-y-2">
                        <p className="text-[11px] text-slate-500">
                          Podés subir una imagen o pegar una URL pública (http/https).
                        </p>
                        <input type="file" accept="image/*" onChange={async (e) => {
                          try {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            const mediaUrl = await uploadImage(file);
                            setNodes((prev) => prev.map((n) => n.id !== node.id ? n : ({ ...n, blocks: n.blocks.map((b) => b.id === block.id ? { ...b, media_url: mediaUrl } : b) })));
                          } catch (err) {
                            setError(err instanceof Error ? err.message : "No se pudo subir imagen");
                          } finally {
                            e.target.value = "";
                          }
                        }} className="text-xs" />
                        <input
                          className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                          value={block.media_url ?? ""}
                          placeholder="URL pública de imagen"
                          onChange={(e) => setNodes((prev) => prev.map((n) => n.id !== node.id ? n : ({ ...n, blocks: n.blocks.map((b) => b.id === block.id ? { ...b, media_url: e.target.value } : b) })))}
                        />
                        {!!block.media_url && !isValidHttpUrl(block.media_url) && (
                          <div className="text-[11px] text-red-600">La URL debe iniciar con http:// o https://</div>
                        )}
                        <input
                          className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                          value={block.content_text ?? ""}
                          placeholder="Caption opcional"
                          onChange={(e) => setNodes((prev) => prev.map((n) => n.id !== node.id ? n : ({ ...n, blocks: n.blocks.map((b) => b.id === block.id ? { ...b, content_text: e.target.value } : b) })))}
                        />
                        <div className={`text-[11px] ${(block.content_text ?? "").length > MAX_WHATSAPP_IMAGE_CAPTION ? "text-red-600" : "text-slate-500"}`}>
                          Caption: {(block.content_text ?? "").length}/{MAX_WHATSAPP_IMAGE_CAPTION}
                        </div>
                        {block.media_url && <img src={block.media_url} alt="preview" className="max-h-40 rounded border border-slate-200" />}
                      </div>
                    )}
                    {block.block_type === "buttons" && (
                      <input
                        className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                        value={block.content_text ?? ""}
                        placeholder="Texto arriba de los botones"
                        onChange={(e) => setNodes((prev) => prev.map((n) => n.id !== node.id ? n : ({ ...n, blocks: n.blocks.map((b) => b.id === block.id ? { ...b, content_text: e.target.value } : b) })))}
                      />
                    )}
                    <button type="button" className="text-xs text-[#0EA5E9] hover:underline" onClick={async () => {
                      try {
                        const latestNode = nodes.find((n) => n.id === node.id);
                        const latestBlock = latestNode?.blocks.find((b) => b.id === block.id);
                        if (!latestBlock) return;
                        if (latestBlock.block_type === "image") {
                          const mediaUrl = latestBlock.media_url?.trim() ?? "";
                          const caption = latestBlock.content_text?.trim() ?? "";
                          if (mediaUrl && !isValidHttpUrl(mediaUrl)) {
                            throw new Error("La URL de imagen debe ser http/https.");
                          }
                          if (caption.length > MAX_WHATSAPP_IMAGE_CAPTION) {
                            throw new Error(`El caption supera ${MAX_WHATSAPP_IMAGE_CAPTION} caracteres.`);
                          }
                        }
                        await saveBlock(node, latestBlock);
                        setSuccess("Bloque guardado.");
                        await reload();
                      } catch (e) {
                        setError(e instanceof Error ? e.message : "Error al guardar bloque");
                      }
                    }}>Guardar bloque</button>
                  </div>
                ))}
              </div>
              )}

              <button
                type="button"
                disabled={savingNodeId === node.id}
                onClick={async () => {
                  try {
                    setSavingNodeId(node.id);
                    await saveNode(node);
                    await reload();
                    setSuccess(`Paso ${prettifyCode(node.node_code)} guardado correctamente.`);
                    setLastSavedNodeId(node.id);
                    setExpandedNodeId(null);
                  } catch (e) {
                    setError(e instanceof Error ? e.message : "Error al guardar nodo");
                  } finally {
                    setSavingNodeId(null);
                  }
                }}
                className="bg-[#0EA5E9] hover:bg-[#0284C7] disabled:opacity-60 text-white px-4 py-2 rounded-lg text-sm font-medium"
              >
                {savingNodeId === node.id ? "Guardando..." : "Guardar paso"}
              </button>

              {(node.node_type === "buttons" || node.node_type === "list") && (
                <div className="border border-slate-100 rounded-lg p-3 space-y-2 bg-slate-50/60">
                  <div className="text-xs font-semibold text-slate-600 uppercase">
                    {node.node_type === "list" ? "Opciones de lista del cliente" : "Botones del cliente"}
                  </div>
                  {node.options.map((opt) => (
                    <div key={opt.id} className="grid grid-cols-1 md:grid-cols-4 gap-2 items-start">
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">
                          {node.node_type === "list" ? "Texto de la opción" : "Texto del botón"}
                        </label>
                        <input className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm w-full" value={opt.label} onChange={(e) => setNodes((prev) => prev.map((n) => n.id !== node.id ? n : ({ ...n, options: n.options.map((o) => o.id === opt.id ? { ...o, label: e.target.value } : o) } )))} placeholder={node.node_type === "list" ? "Ej: Plan Premium" : "Ej: Comprar entrada"} />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">Va a</label>
                        <select className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm w-full" value={opt.next_node_code ?? ""} onChange={(e) => setNodes((prev) => prev.map((n) => n.id !== node.id ? n : ({ ...n, options: n.options.map((o) => o.id === opt.id ? { ...o, next_node_code: e.target.value || null } : o) } )))} >
                          <option value="">(sin siguiente)</option>
                          {nodeCodes.filter((code) => code !== node.node_code).map((code) => (
                            <option key={code} value={code}>{nextStepLabel(code)}</option>
                          ))}
                        </select>
                      </div>
                      <div className="flex gap-2 pt-5">
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              await saveOption(node, opt);
                              await reload();
                            } catch (e) {
                              setError(e instanceof Error ? e.message : "Error al guardar opción");
                            }
                          }}
                          className="text-[#0EA5E9] hover:underline text-sm"
                        >
                          Guardar
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              await deleteOption(node, opt.id);
                              await reload();
                            } catch (e) {
                              setError(e instanceof Error ? e.message : "Error al eliminar opción");
                            }
                          }}
                          className="text-red-600 hover:underline text-sm"
                        >
                          Eliminar
                        </button>
                      </div>
                      <div className="md:col-span-4">
                        <label className="block text-xs text-slate-500 mb-1">Variables guardadas (JSON)</label>
                        <textarea
                          className="border border-slate-200 rounded-lg px-2 py-1.5 text-xs font-mono w-full min-h-[82px]"
                          value={optionPayloadDrafts[opt.id] ?? stringifyOptionPayload(opt.option_payload)}
                          placeholder={'{\n  "cantidad": 1,\n  "producto": "1 boleto",\n  "monto": 20000,\n  "opcion_label": "1 boleto a 20.000"\n}'}
                          onChange={(e) =>
                            setOptionPayloadDrafts((prev) => ({
                              ...prev,
                              [opt.id]: e.target.value,
                            }))
                          }
                        />
                        <p className="text-[11px] text-slate-500 mt-1">
                          Se guardan en contexto al elegir este botón. Usá placeholders: {"{{cantidad}}"}, {"{{producto}}"}, {"{{monto}}"}.
                        </p>
                      </div>
                      <div className="md:col-span-4 text-xs text-slate-500 bg-white border border-slate-200 rounded px-2 py-1">
                        {node.node_type === "list" ? "Opción" : "Botón"}: "{opt.label}" → va a: "{nextStepLabel(opt.next_node_code)}"
                      </div>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await createOption(node);
                        await reload();
                      } catch (e) {
                        setError(e instanceof Error ? e.message : "Error al crear opción");
                      }
                    }}
                    className="text-sm text-[#0EA5E9] hover:underline"
                  >
                    {node.node_type === "list" ? "+ Agregar opción" : "+ Agregar botón"}
                  </button>
                </div>
              )}
              </>
              )}
            </div>
          );
          })}
        </div>
      )}
    </div>
  );
}
