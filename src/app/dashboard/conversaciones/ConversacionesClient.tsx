"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import {
  approveComprobanteValidacion,
  fetchChatChannels,
  fetchChatConversations,
  fetchComprobanteValidacionesForConversation,
  hasEmpresaActiveChatFlows,
  markConversationRead,
  releaseConversationToBot,
  type ChatInboxAssignmentFilter,
  type ChatInboxFilters,
  type ComprobanteValidacionListRow,
  type ConversacionesVista,
  type InboxConversation,
} from "@/lib/chat/actions";
import {
  assignConversationToAgent,
  changeConversationQueue,
  changeConversationStatus,
  getMyAgentOperationalPresence,
  listChatAgentsDirectory,
  listChatQueues,
  setMyAgentOperationalPresence,
  touchChatAgentInboxHeartbeat,
  type ChatAgentDirectoryRow,
  type ChatAgentOperationalStatus,
  type ChatQueueListRow,
  type InboxCabeceraInsignia,
} from "@/lib/chat/chat-ops-actions";
import { formatWaitHuman } from "@/lib/chat/format-wait-human";
import { Flame, UserRound } from "lucide-react";
import {
  finalizeConversationWithClosure,
  loadFinalizeOptionsForConversation,
  type FinalizeOptionsResult,
} from "@/lib/chat/conversation-finalize-actions";
import {
  getErpAttachmentCaption,
  getErpAttachmentFilename,
  getErpAttachmentPublicUrl,
  getMetaInboundDocumentFilename,
  getWhatsAppMediaUrlFromRawPayload,
  isImageMimeHint,
} from "@/lib/chat/message-erp-display";
import { assignmentWaitBadge, assignmentWaitBadgeClass } from "@/lib/chat/inbox-assignment-labels";
import { playInboxNotificationBeep, readInboxNotificationSoundEnabled } from "@/lib/chat/inbox-notification-preference";
import { createBrowserClientForSchema } from "@/lib/supabase";
import { ChannelBadge } from "@/components/chat/ChannelBadge";

type ChatMessage = {
  id: string;
  from_me: boolean;
  message_type: string;
  content: string | null;
  created_at: string;
  raw_payload?: Record<string, unknown> | null;
};

function formatTime(iso: string) {
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

function mapRowToMessage(row: Record<string, unknown>): ChatMessage {
  return {
    id: row.id as string,
    from_me: Boolean(row.from_me),
    message_type: String(row.message_type ?? "text"),
    content: (row.content as string | null) ?? null,
    created_at: String(row.created_at),
    raw_payload:
      typeof row.raw_payload === "object" && row.raw_payload !== null
        ? (row.raw_payload as Record<string, unknown>)
        : null,
  };
}

function parseOutgoingImageMessage(message: ChatMessage): { url: string | null; caption: string | null } {
  const erpUrl = getErpAttachmentPublicUrl(message.raw_payload);
  if (erpUrl) {
    const cap = getErpAttachmentCaption(message.raw_payload) ?? getErpAttachmentFilename(message.raw_payload);
    return { url: erpUrl, caption: cap };
  }
  const waUrl = getWhatsAppMediaUrlFromRawPayload(message.raw_payload);
  if (waUrl) {
    const imagePayload = (message.raw_payload?.image as { caption?: string } | undefined) ?? {};
    const cap = typeof imagePayload.caption === "string" ? imagePayload.caption.trim() : "";
    return { url: waUrl, caption: cap || null };
  }
  const imagePayload = (message.raw_payload?.image as { link?: string; caption?: string } | undefined) ?? {};
  const link = typeof imagePayload.link === "string" ? imagePayload.link.trim() : "";
  const captionFromPayload = typeof imagePayload.caption === "string" ? imagePayload.caption.trim() : "";
  if (link) return { url: link, caption: captionFromPayload || null };

  const lines = (message.content ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const urlLine = lines.find((line) => /^https?:\/\//i.test(line)) ?? null;
  const captionLine = lines.find((line) => !/^https?:\/\//i.test(line) && !/^Imagen enviada:?/i.test(line)) ?? null;
  return { url: urlLine, caption: captionLine };
}

function resolveAttachmentUrl(message: ChatMessage): string | null {
  return (
    getErpAttachmentPublicUrl(message.raw_payload) ??
    getWhatsAppMediaUrlFromRawPayload(message.raw_payload) ??
    parseOutgoingImageMessage(message).url
  );
}

function displayFilenameForAttachment(message: ChatMessage): string {
  const erp = getErpAttachmentFilename(message.raw_payload);
  if (erp) return erp;
  const meta = getMetaInboundDocumentFilename(message.raw_payload);
  if (meta) return meta;
  const raw = (message.content ?? "").trim();
  const m = /^\[documento\]\s*(.+)$/i.exec(raw);
  if (m?.[1]?.trim()) return m[1].trim();
  if (raw && !raw.startsWith("[")) return raw.slice(0, 120);
  return message.message_type === "video" ? "Video" : "Archivo";
}

function tabClass(active: boolean) {
  return `px-3 py-2 text-xs font-semibold rounded-lg transition-colors ${
    active ? "bg-white text-slate-800 shadow-sm border border-slate-200" : "text-slate-500 hover:text-slate-700"
  }`;
}

/**
 * Control segmentado: el modo activo = pastilla blanca con borde de color (no “todo verde”);
 * el inactivo = gris plano (se entiende qué está elegido).
 */
function opPresenceToggleClass(isSelected: boolean, variant: "ready" | "offline") {
  const base =
    "px-3 py-1.5 text-xs font-semibold rounded-md transition-all disabled:opacity-50 min-w-[6.75rem] text-center border-2";
  if (!isSelected) {
    return `${base} border-transparent bg-slate-200/60 text-slate-500 hover:bg-slate-200 hover:text-slate-600`;
  }
  if (variant === "ready") {
    return `${base} border-emerald-500 bg-white text-emerald-700 shadow-sm ring-1 ring-emerald-200/90 z-[1]`;
  }
  return `${base} border-slate-600 bg-white text-slate-800 shadow-sm ring-1 ring-slate-200/90 z-[1]`;
}

function LiveElapsedLabel({ sinceIso }: { sinceIso: string | null }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((x) => x + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  if (!sinceIso) return <span className="text-slate-400">—</span>;
  return <span className="tabular-nums font-medium">{formatWaitHuman(sinceIso)}</span>;
}

function inboxClientWaitingSince(c: InboxConversation): string | null {
  if (c.awaiting_agent_reply_since) return null;
  return c.awaiting_client_reply_since ?? null;
}

function InboxReplyTurnBadges({ c, dense }: { c: InboxConversation; dense?: boolean }) {
  const agentSince = c.awaiting_agent_reply_since;
  const clientSince = inboxClientWaitingSince(c);
  if (!agentSince && !clientSince) return null;
  const pad = dense ? "px-1.5 py-0.5 text-[9px]" : "px-1.5 py-0.5 text-[10px]";
  return (
    <>
      {agentSince ? (
        <span
          className={`inline-flex items-center gap-0.5 font-semibold text-orange-950 bg-orange-50 border border-orange-200 rounded ${pad} shrink-0`}
          title="Cliente escribió; falta respuesta humana del asesor"
        >
          <Flame className={`shrink-0 text-orange-600 ${dense ? "w-3 h-3" : "w-3.5 h-3.5"}`} aria-hidden />
          <LiveElapsedLabel sinceIso={agentSince} />
        </span>
      ) : null}
      {clientSince ? (
        <span
          className={`inline-flex items-center gap-0.5 font-semibold text-sky-950 bg-sky-50 border border-sky-200 rounded ${pad} shrink-0`}
          title="Último mensaje saliente; turno del contacto"
        >
          <UserRound className={`shrink-0 text-sky-600 ${dense ? "w-3 h-3" : "w-3.5 h-3.5"}`} aria-hidden />
          <LiveElapsedLabel sinceIso={clientSince} />
        </span>
      ) : null}
    </>
  );
}

function parseInboxFilters(sp: URLSearchParams): ChatInboxFilters | undefined {
  const rawA = sp.get("asignacion");
  const assignment: ChatInboxAssignmentFilter =
    rawA === "mios" ? "mine" : rawA === "sin_asignar" ? "unassigned" : "all";
  const queue_id = sp.get("cola")?.trim() || null;
  const statusRaw = sp.get("estado")?.trim().toLowerCase() || null;
  const priorityRaw = sp.get("prioridad")?.trim().toLowerCase() || null;
  const status =
    statusRaw && ["open", "pending", "closed"].includes(statusRaw) ? statusRaw : null;
  const priority =
    priorityRaw && ["low", "medium", "high"].includes(priorityRaw) ? priorityRaw : null;
  const has =
    assignment !== "all" ||
    (queue_id && queue_id.length > 0) ||
    status !== null ||
    priority !== null;
  if (!has) return undefined;
  return {
    assignment,
    queue_id: queue_id && queue_id.length > 0 ? queue_id : null,
    status,
    priority,
  };
}

function labelEstado(s: string) {
  if (s === "open") return "Abierta";
  if (s === "pending") return "Pendiente";
  if (s === "closed") return "Cerrada";
  return s;
}

function badgeEstadoClass(s: string) {
  if (s === "open") return "text-sky-800 bg-sky-50 border-sky-200";
  if (s === "pending") return "text-amber-800 bg-amber-50 border-amber-200";
  if (s === "closed") return "text-slate-600 bg-slate-100 border-slate-200";
  return "text-slate-600 bg-slate-50 border-slate-200";
}

export type ConversacionesClientMode = "inbox" | "historial";

/** Presencia operativa precargada en el servidor (evita parpadeo y fallos solo-cliente). */
export type ConversacionesInitialOperationalPresence =
  | { in_queues: false; status: null; status_changed_at?: null }
  | { in_queues: true; status: ChatAgentOperationalStatus; status_changed_at: string | null };

export function ConversacionesClient({
  mode,
  chatDataSchema,
  agentDisplayName,
  initialOperationalPresence,
  initialCabeceraInsignia = null,
}: {
  mode: ConversacionesClientMode;
  /** Esquema Postgres de tablas chat_* (zentra_erp o `er_…`). */
  chatDataSchema: string;
  /** Nombre visible del agente logueado (resuelto en servidor). */
  agentDisplayName: string;
  /** Si viene del RSC, el toggle de presencia puede mostrarse sin esperar la primera server action. */
  initialOperationalPresence?: ConversacionesInitialOperationalPresence;
  /** Admin/supervisor sin cola (incluye admin ERP por `usuarios.rol`). */
  initialCabeceraInsignia?: InboxCabeceraInsignia;
}) {
  const supabaseChat = useMemo(
    () => createBrowserClientForSchema(chatDataSchema),
    [chatDataSchema]
  );
  const searchParams = useSearchParams();
  const router = useRouter();
  const vistaParam = searchParams?.get("vista") ?? "";
  const vista: ConversacionesVista =
    mode === "historial" ? "historial" : vistaParam === "bot" ? "bot" : "inbox";

  const [conversations, setConversations] = useState<InboxConversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loadingList, setLoadingList] = useState(true);
  const [loadingMsg, setLoadingMsg] = useState(false);
  const [sending, setSending] = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);
  /** Grabación de nota de voz (MediaRecorder) antes de subir a /api/chat/send-media. */
  const [recordingVoice, setRecordingVoice] = useState(false);
  const [releasingBot, setReleasingBot] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [hasActiveChannel, setHasActiveChannel] = useState<boolean | null>(null);
  const [compVals, setCompVals] = useState<ComprobanteValidacionListRow[]>([]);
  const [compLoading, setCompLoading] = useState(false);
  const [compActionId, setCompActionId] = useState<string | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [opsQueues, setOpsQueues] = useState<ChatQueueListRow[]>([]);
  const [opsAgents, setOpsAgents] = useState<ChatAgentDirectoryRow[]>([]);
  const [opsBusy, setOpsBusy] = useState(false);
  const [hasActiveBotFlows, setHasActiveBotFlows] = useState(false);
  const [botFlowsChecked, setBotFlowsChecked] = useState(false);
  const [compValidacionesOpen, setCompValidacionesOpen] = useState(false);
  const [listColumnHidden, setListColumnHidden] = useState(false);
  /** Filtro local del listado (nombre o teléfono); no altera la carga desde servidor. */
  const [listSearch, setListSearch] = useState("");
  const [finalizeOpen, setFinalizeOpen] = useState(false);
  const [finalizeLoading, setFinalizeLoading] = useState(false);
  const [opPresenceLoaded, setOpPresenceLoaded] = useState(
    mode !== "inbox" || initialOperationalPresence !== undefined
  );
  const [opInQueues, setOpInQueues] = useState(
    mode !== "inbox" ? false : (initialOperationalPresence?.in_queues ?? false)
  );
  const [opStatus, setOpStatus] = useState<ChatAgentOperationalStatus | null>(
    mode !== "inbox"
      ? null
      : initialOperationalPresence?.in_queues
        ? initialOperationalPresence.status
        : null
  );
  const [opPresenceBusy, setOpPresenceBusy] = useState(false);
  const [opPresenceErr, setOpPresenceErr] = useState<string | null>(null);
  const [opPresenceOkMsg, setOpPresenceOkMsg] = useState<string | null>(null);
  const [opSince, setOpSince] = useState<string | null>(() =>
    mode === "inbox" && initialOperationalPresence?.in_queues
      ? initialOperationalPresence.status_changed_at ?? null
      : null
  );
  /** Ancla de sesión en esta pestaña inbox (tiempo de uso del módulo). */
  const [sessionSinceIso, setSessionSinceIso] = useState<string | null>(null);
  const [finalizeSaving, setFinalizeSaving] = useState(false);
  const [finalizeOptions, setFinalizeOptions] = useState<FinalizeOptionsResult | null>(null);
  const [finalizeStateId, setFinalizeStateId] = useState("");
  const [finalizeSubstateId, setFinalizeSubstateId] = useState("");
  const [finalizeComment, setFinalizeComment] = useState("");
  const [finalizeModalError, setFinalizeModalError] = useState<string | null>(null);

  const inboxFilterKey = searchParams?.toString() ?? "";

  const fileInputRef = useRef<HTMLInputElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordChunksRef = useRef<Blob[]>([]);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  /** Si el usuario está cerca del final, los mensajes nuevos hacen scroll; si subió a leer historial, no. */
  const stickBottomRef = useRef(true);
  const lastMessageIdRef = useRef<string | null>(null);
  const loadConversationsRef = useRef<(opts?: { silent?: boolean }) => Promise<void>>(async () => {});
  /** Tras la primera carga visible del inbox, se permite el beep (evita sonido en hidratar inicial). */
  const inboxSoundPrimedRef = useRef(false);
  /** Dedupe de ids de mensaje entrante ya notificados con sonido. */
  const inboundSoundMsgIdsRef = useRef<Set<string>>(new Set());

  const loadConversations = useCallback(
    async (opts?: { silent?: boolean }) => {
      const silent = opts?.silent ?? false;
      try {
        const sp = new URLSearchParams(inboxFilterKey);
        const filters = parseInboxFilters(sp);
        const rows = await fetchChatConversations(vista, filters);
        setConversations(rows);
        setListError(null);
      } catch (e) {
        setListError(e instanceof Error ? e.message : "Error al cargar conversaciones");
      } finally {
        if (!silent) {
          setLoadingList(false);
          inboxSoundPrimedRef.current = true;
        }
      }
    },
    [vista, inboxFilterKey]
  );

  const loadMessages = useCallback(async (conversationId: string, opts?: { silent?: boolean }) => {
    const silent = opts?.silent ?? false;
    if (!silent) setLoadingMsg(true);
    setMessagesError(null);
    try {
      const qs = new URLSearchParams({ conversation_id: conversationId });
      const res = await fetchWithSupabaseSession(`/api/chat/messages?${qs.toString()}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        let detail = "";
        try {
          const j = (await res.json()) as { error?: string; message?: string };
          detail = (j.error || j.message || "").trim();
        } catch {
          detail = (await res.text().catch(() => "")).trim();
        }
        throw new Error(detail || `Error ${res.status} al cargar mensajes`);
      }
      const json = (await res.json()) as { success?: boolean; data?: Record<string, unknown>[] };
      if (!json.success || !Array.isArray(json.data)) {
        setMessages([]);
        return;
      }
      setMessages(json.data.map(mapRowToMessage));
    } catch (e) {
      setMessages([]);
      setMessagesError(e instanceof Error ? e.message : "Error al cargar mensajes");
    } finally {
      if (!silent) setLoadingMsg(false);
    }
  }, []);

  const loadMessagesRef = useRef(loadMessages);
  loadMessagesRef.current = loadMessages;

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  const sendMediaFile = useCallback(async (file: File) => {
    const cid = selectedIdRef.current;
    if (!cid || file.size < 1) return;
    setSendError(null);
    stickBottomRef.current = true;
    setUploadingFile(true);
    try {
      const fd = new FormData();
      fd.set("conversation_id", cid);
      fd.set("file", file);
      const res = await fetchWithSupabaseSession("/api/chat/send-media", {
        method: "POST",
        body: fd,
        credentials: "same-origin",
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        throw new Error(typeof json.error === "string" ? json.error : `Error HTTP ${res.status}`);
      }
      await loadMessagesRef.current(cid, { silent: true });
      await loadConversationsRef.current?.({ silent: true });
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Error al enviar archivo");
    } finally {
      setUploadingFile(false);
    }
  }, []);

  async function toggleVoiceNote() {
    const cid = selectedIdRef.current;
    if (!cid || uploadingFile) return;
    const mr = mediaRecorderRef.current;
    if (mr && mr.state === "recording") {
      mr.stop();
      return;
    }
    setSendError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      recordChunksRef.current = [];
      const mime =
        typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("audio/webm")
            ? "audio/webm"
            : "";
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      mediaRecorderRef.current = rec;
      rec.ondataavailable = (ev) => {
        if (ev.data.size > 0) recordChunksRef.current.push(ev.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        mediaRecorderRef.current = null;
        streamRef.current = null;
        const blob = new Blob(recordChunksRef.current, { type: rec.mimeType || "audio/webm" });
        recordChunksRef.current = [];
        setRecordingVoice(false);
        if (blob.size < 300) return;
        const ext = blob.type.includes("ogg") ? "ogg" : "webm";
        const voiceFile = new File([blob], `nota-voz.${ext}`, { type: blob.type || "audio/webm" });
        void sendMediaFile(voiceFile);
      };
      setRecordingVoice(true);
      rec.start(400);
    } catch (e) {
      setSendError(e instanceof Error ? e.message : "No se pudo acceder al micrófono");
      setRecordingVoice(false);
    }
  }

  useEffect(() => {
    return () => {
      try {
        mediaRecorderRef.current?.stop();
      } catch {
        /* noop */
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  loadConversationsRef.current = loadConversations;

  useEffect(() => {
    setSelectedId(null);
    setMessages([]);
  }, [vista]);

  useEffect(() => {
    setLoadingList(true);
    loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    listChatQueues()
      .then(setOpsQueues)
      .catch(() => setOpsQueues([]));
    listChatAgentsDirectory()
      .then(setOpsAgents)
      .catch(() => setOpsAgents([]));
  }, []);

  function setVista(next: ConversacionesVista) {
    if (mode === "historial") {
      if (next === "inbox") router.push("/dashboard/conversaciones");
      if (next === "bot" && hasActiveBotFlows) router.push("/dashboard/conversaciones?vista=bot");
      return;
    }
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (next === "inbox") params.delete("vista");
    else if (next === "bot" && hasActiveBotFlows) params.set("vista", "bot");
    else if (next === "historial") {
      router.push("/dashboard/historial-omnicanal");
      return;
    }
    const qs = params.toString();
    const base = "/dashboard/conversaciones";
    router.push(qs ? `${base}?${qs}` : base);
  }

  useEffect(() => {
    fetchChatChannels()
      .then((ch) => setHasActiveChannel(ch.some((c) => c.activo)))
      .catch(() => setHasActiveChannel(null));
  }, []);

  useEffect(() => {
    if (mode !== "inbox") {
      setBotFlowsChecked(true);
      return;
    }
    void hasEmpresaActiveChatFlows().then((v) => {
      setHasActiveBotFlows(v);
      setBotFlowsChecked(true);
    });
  }, [mode]);

  useEffect(() => {
    if (mode !== "inbox") {
      setOpPresenceLoaded(true);
      setOpInQueues(false);
      setOpStatus(null);
      setOpPresenceErr(null);
      return;
    }
    let cancelled = false;
    if (initialOperationalPresence === undefined) {
      setOpPresenceLoaded(false);
    }
    setOpPresenceErr(null);
    void getMyAgentOperationalPresence()
      .then((p) => {
        if (cancelled) return;
        if (p.in_queues) {
          setOpInQueues(true);
          setOpStatus(p.status);
          setOpSince(p.status_changed_at);
        } else {
          setOpInQueues(false);
          setOpStatus(null);
          setOpSince(null);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        if (initialOperationalPresence === undefined) {
          setOpInQueues(false);
          setOpStatus(null);
          setOpSince(null);
        }
        setOpPresenceErr(e instanceof Error ? e.message : "No se pudo cargar estado operativo");
      })
      .finally(() => {
        if (!cancelled) setOpPresenceLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, initialOperationalPresence]);

  useEffect(() => {
    if (mode !== "inbox") return;
    setSessionSinceIso((prev) => prev ?? new Date().toISOString());
  }, [mode]);

  useEffect(() => {
    if (mode !== "inbox" || !opInQueues) return;
    void touchChatAgentInboxHeartbeat();
    const id = window.setInterval(() => void touchChatAgentInboxHeartbeat(), 90_000);
    const onVis = () => {
      if (document.visibilityState === "visible") void touchChatAgentInboxHeartbeat();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [mode, opInQueues]);

  const applyOperationalStatus = useCallback(async (next: ChatAgentOperationalStatus) => {
    setOpPresenceErr(null);
    setOpPresenceOkMsg(null);
    setOpPresenceBusy(true);
    try {
      const res = await setMyAgentOperationalPresence(next);
      if (!res.applied) {
        if (res.reason === "missing_operational_status_column") {
          setOpPresenceErr(
            "Presencia no disponible en base de datos (falta columna). Ejecutá la migración operational_status en Supabase o contactá soporte."
          );
        } else {
          setOpPresenceErr(res.reason?.trim() || "No se pudo guardar el estado.");
        }
        return;
      }
      const refreshed = await getMyAgentOperationalPresence();
      if (refreshed.in_queues) {
        setOpInQueues(true);
        setOpStatus(refreshed.status);
        setOpSince(refreshed.status_changed_at ?? new Date().toISOString());
      } else {
        setOpInQueues(false);
        setOpStatus(null);
        setOpSince(null);
      }
      setOpPresenceOkMsg(next === "ready" ? "Disponible · guardado" : "En pausa · guardado");
      window.setTimeout(() => setOpPresenceOkMsg(null), 3500);
    } catch (e) {
      setOpPresenceErr(e instanceof Error ? e.message : "No se pudo guardar el estado");
    } finally {
      setOpPresenceBusy(false);
    }
  }, []);

  /** URL legacy: ?vista=historial en inbox → ruta dedicada */
  useEffect(() => {
    if (mode !== "inbox") return;
    if (searchParams?.get("vista") === "historial") {
      router.replace("/dashboard/historial-omnicanal");
    }
  }, [mode, router, searchParams]);

  /** Sin flujos activos, no forzar vista bot */
  useEffect(() => {
    if (mode !== "inbox" || !botFlowsChecked || hasActiveBotFlows) return;
    if (searchParams?.get("vista") !== "bot") return;
    router.replace("/dashboard/conversaciones");
  }, [mode, botFlowsChecked, hasActiveBotFlows, router, searchParams]);

  /** Lista: Realtime sobre conversaciones + INSERT en mensajes (cubre preview/unread si el UPDATE de conversación no emite). */
  useEffect(() => {
    const channel = supabaseChat
      .channel("conversaciones-inbox-list")
      .on(
        "postgres_changes",
        { event: "*", schema: chatDataSchema, table: "chat_conversations" },
        () => {
          void loadConversationsRef.current?.({ silent: true });
        }
      )
      .subscribe();

    return () => {
      void supabaseChat.removeChannel(channel);
    };
  }, [chatDataSchema, supabaseChat]);

  /** Mensajes entrantes: refresca inbox, beep opcional (dedupe por id de mensaje). */
  useEffect(() => {
    const channel = supabaseChat
      .channel("conversaciones-inbox-inbound-messages")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: chatDataSchema, table: "chat_messages" },
        (payload) => {
          void loadConversationsRef.current?.({ silent: true });
          const row = payload.new as Record<string, unknown>;
          const convId = typeof row?.conversation_id === "string" ? row.conversation_id : "";
          if (convId && convId === selectedIdRef.current) {
            void loadMessagesRef.current(convId, { silent: true });
          }
          const mid = typeof row?.id === "string" ? row.id : "";
          if (!mid || row.from_me === true) return;
          if (inboundSoundMsgIdsRef.current.has(mid)) return;
          inboundSoundMsgIdsRef.current.add(mid);
          if (inboundSoundMsgIdsRef.current.size > 600) {
            inboundSoundMsgIdsRef.current.clear();
          }
          if (!inboxSoundPrimedRef.current) return;
          if (readInboxNotificationSoundEnabled()) {
            playInboxNotificationBeep();
          }
        }
      )
      .subscribe();

    return () => {
      void supabaseChat.removeChannel(channel);
    };
  }, [chatDataSchema, supabaseChat]);

  /** Respaldo si Realtime no llega (publicación RLS, pestaña en background, etc.). */
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void loadConversationsRef.current?.({ silent: true });
    }, 2800);
    return () => window.clearInterval(id);
  }, []);

  /** Al volver a la pestaña, sincronizar de inmediato (evita depender solo del intervalo). */
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      void loadConversationsRef.current?.({ silent: true });
      const sid = selectedIdRef.current;
      if (sid) void loadMessagesRef.current(sid, { silent: true });
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  /** Con hilo abierto: sondeo corto por si Realtime no entrega INSERT/UPDATE (p. ej. webhook vía PG). */
  useEffect(() => {
    if (!selectedId) return;
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void loadMessagesRef.current(selectedId, { silent: true });
    }, 2800);
    return () => window.clearInterval(id);
  }, [selectedId]);

  /** Mensajes del hilo abierto: INSERT/UPDATE en tiempo real (UPDATE cubre enrich de media YCloud). */
  useEffect(() => {
    if (!selectedId) return;

    const mergeRow = (row: Record<string, unknown>) => {
      if (!row?.id) return;
      const msg = mapRowToMessage(row);
      setMessages((prev) => {
        const i = prev.findIndex((m) => m.id === msg.id);
        if (i >= 0) {
          const next = [...prev];
          next[i] = msg;
          return next;
        }
        return [...prev, msg].sort(
          (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        );
      });
    };

    const channel = supabaseChat
      .channel(`conversaciones-msg-${selectedId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: chatDataSchema,
          table: "chat_messages",
          filter: `conversation_id=eq.${selectedId}`,
        },
        (payload) => mergeRow(payload.new as Record<string, unknown>)
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: chatDataSchema,
          table: "chat_messages",
          filter: `conversation_id=eq.${selectedId}`,
        },
        (payload) => mergeRow(payload.new as Record<string, unknown>)
      )
      .subscribe();

    return () => {
      void supabaseChat.removeChannel(channel);
    };
  }, [selectedId, chatDataSchema, supabaseChat]);

  const onMessagesScroll = useCallback(() => {
    const el = messagesScrollRef.current;
    if (!el) return;
    const threshold = 100;
    stickBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }, []);

  useLayoutEffect(() => {
    if (!selectedId || messages.length === 0) return;
    const last = messages[messages.length - 1]?.id;
    const prev = lastMessageIdRef.current;
    lastMessageIdRef.current = last;

    if (last === prev) return;

    const el = messagesScrollRef.current;
    if (!el) return;
    if (!stickBottomRef.current && prev !== null) return;

    el.scrollTop = el.scrollHeight;
  }, [messages, selectedId]);

  const handleSelect = useCallback(
    async (id: string) => {
      stickBottomRef.current = true;
      lastMessageIdRef.current = null;
      setMessagesError(null);
      setSelectedId(id);
      await loadMessages(id);
      const compOn = conversations.some(
        (c) => c.id === id && c.channel.comprobante_validation_enabled === true
      );
      if (compOn) {
        setCompLoading(true);
        try {
          const rows = await fetchComprobanteValidacionesForConversation(id);
          setCompVals(rows);
        } catch {
          setCompVals([]);
        } finally {
          setCompLoading(false);
        }
      } else {
        setCompVals([]);
        setCompLoading(false);
      }
      try {
        await markConversationRead(id);
        setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, unread_count: 0 } : c)));
      } catch {
        /* no bloquear UI */
      }
    },
    [loadMessages, conversations]
  );

  async function handleSendFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !selectedId || uploadingFile) return;
    await sendMediaFile(file);
  }

  async function handleReleaseToBot() {
    if (!selectedId || releasingBot) return;
    setReleasingBot(true);
    setSendError(null);
    try {
      await releaseConversationToBot(selectedId);
      await loadConversations({ silent: true });
      if (vista === "inbox") {
        setSelectedId(null);
        setMessages([]);
      }
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "No se pudo devolver al bot");
    } finally {
      setReleasingBot(false);
    }
  }

  async function runConversationOp(fn: () => Promise<void>) {
    if (!selectedId || opsBusy) return;
    setOpsBusy(true);
    setSendError(null);
    try {
      await fn();
      await loadConversations({ silent: true });
    } catch (e) {
      setSendError(e instanceof Error ? e.message : "Error en la acción");
    } finally {
      setOpsBusy(false);
    }
  }

  async function openFinalizeModal() {
    const sel = selectedId ? conversations.find((c) => c.id === selectedId) : null;
    if (!selectedId || !sel || sel.status === "closed") return;
    setFinalizeModalError(null);
    setFinalizeOpen(true);
    setFinalizeLoading(true);
    setFinalizeOptions(null);
    setFinalizeStateId("");
    setFinalizeSubstateId("");
    setFinalizeComment("");
    try {
      const opts = await loadFinalizeOptionsForConversation(selectedId);
      setFinalizeOptions(opts);
      const first = opts.states[0];
      if (first) {
        setFinalizeStateId(first.id);
        setFinalizeSubstateId(first.substates[0]?.id ?? "");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "No se pudieron cargar las opciones de cierre";
      setFinalizeModalError(msg);
      if (msg.includes("finalizada")) {
        setFinalizeOpen(false);
      }
    } finally {
      setFinalizeLoading(false);
    }
  }

  function closeFinalizeModal() {
    if (finalizeSaving) return;
    setFinalizeOpen(false);
    setFinalizeModalError(null);
  }

  async function confirmFinalize() {
    if (!selectedId || !finalizeOptions) return;
    setFinalizeModalError(null);
    const st = finalizeOptions.states.find((x) => x.id === finalizeStateId);
    if (!st) {
      setFinalizeModalError("Elegí un estado.");
      return;
    }
    if (st.substates.length > 0 && !finalizeSubstateId) {
      setFinalizeModalError("Elegí un subestado.");
      return;
    }
    const comment = finalizeComment.trim();
    if (comment.length < 3) {
      setFinalizeModalError("El comentario es obligatorio (al menos 3 caracteres).");
      return;
    }
    const sub = st.substates.find((x) => x.id === finalizeSubstateId);
    setFinalizeSaving(true);
    try {
      await finalizeConversationWithClosure({
        conversationId: selectedId,
        closureStateId: st.id,
        closureSubstateId: st.substates.length > 0 ? finalizeSubstateId : null,
        closureStateLabel: st.label,
        closureSubstateLabel: sub?.label ?? (st.substates.length > 0 ? "" : "—"),
        comment,
      });
      setFinalizeOpen(false);
      setFinalizeOptions(null);
      if (mode === "inbox") {
        setSelectedId(null);
        setMessages([]);
      }
      await loadConversations({ silent: true });
    } catch (e) {
      setFinalizeModalError(e instanceof Error ? e.message : "No se pudo finalizar la conversación");
    } finally {
      setFinalizeSaving(false);
    }
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedId || !input.trim() || sending) return;
    setSending(true);
    setSendError(null);
    stickBottomRef.current = true;
    try {
      const res = await fetchWithSupabaseSession("/api/chat/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ conversation_id: selectedId, message: input.trim() }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        meta?: unknown;
      };
      if (!res.ok) {
        const base =
          typeof json.error === "string"
            ? json.error
            : res.status === 401
              ? "Sesión expirada o no autenticado"
              : `Error al enviar (HTTP ${res.status})`;
        throw new Error(base);
      }
      setInput("");
      setSendError(null);
      await loadMessages(selectedId, { silent: true });
      await loadConversations({ silent: true });
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Error al enviar");
    } finally {
      setSending(false);
    }
  }

  const visibleConversations = useMemo(() => {
    const q = listSearch.trim().toLowerCase();
    if (!q) return conversations;
    const qDigits = q.replace(/\D/g, "");
    return conversations.filter((c) => {
      const name = (c.contact.name || "").toLowerCase();
      const phone = String(c.contact.phone_number || "");
      const phoneDigits = phone.replace(/\D/g, "");
      if (name.includes(q)) return true;
      if (phone.toLowerCase().includes(q)) return true;
      if (qDigits.length > 0 && phoneDigits.includes(qDigits)) return true;
      return false;
    });
  }, [conversations, listSearch]);

  const selected = conversations.find((c) => c.id === selectedId);
  const isHumanActive =
    !!selected && (selected.human_taken_over || selected.flow_status === "human");
  const requestedConversationId = searchParams?.get("conversationId") ?? null;

  useEffect(() => {
    if (!requestedConversationId || !conversations.length) return;
    if (selectedId === requestedConversationId) return;
    const exists = conversations.some((c) => c.id === requestedConversationId);
    if (!exists) return;
    void handleSelect(requestedConversationId);
  }, [requestedConversationId, conversations, selectedId, handleSelect]);

  useEffect(() => {
    if (selectedId && !conversations.some((c) => c.id === selectedId)) {
      setSelectedId(null);
      setMessages([]);
    }
  }, [conversations, selectedId]);

  useEffect(() => {
    setCompValidacionesOpen(false);
  }, [selectedId]);

  useEffect(() => {
    if (!finalizeOptions || !finalizeStateId) return;
    const st = finalizeOptions.states.find((s) => s.id === finalizeStateId);
    if (!st) return;
    setFinalizeSubstateId((prev) =>
      st.substates.some((sub) => sub.id === prev) ? prev : st.substates[0]?.id ?? ""
    );
  }, [finalizeStateId, finalizeOptions]);

  return (
    <div className="flex flex-col flex-1 min-h-0 h-[calc(100dvh-5.25rem)] max-h-[calc(100dvh-5.25rem)] gap-2 overflow-hidden">
      {lightboxUrl ? (
        <button
          type="button"
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4 border-0 cursor-zoom-out"
          onClick={() => setLightboxUrl(null)}
          aria-label="Cerrar vista ampliada"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={lightboxUrl}
            alt="Vista ampliada"
            className="max-h-[92vh] max-w-full object-contain rounded-lg shadow-2xl"
            onClick={(ev) => ev.stopPropagation()}
          />
        </button>
      ) : null}

      {finalizeOpen ? (
        <div
          className="fixed inset-0 z-[110] flex items-center justify-center bg-black/40 p-4"
          role="presentation"
          onClick={() => closeFinalizeModal()}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="finalize-chat-title"
            className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-xl"
            onClick={(ev) => ev.stopPropagation()}
          >
            <h2 id="finalize-chat-title" className="text-lg font-semibold text-slate-900">
              Finalizar conversación
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Completá el cierre para guardar el resultado en el historial. Todos los campos son obligatorios.
            </p>
            {finalizeLoading ? (
              <p className="mt-4 text-sm text-slate-500">Cargando opciones…</p>
            ) : finalizeOptions && finalizeOptions.states.length > 0 ? (
              <div className="mt-4 space-y-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">Estado</label>
                  <select
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                    value={finalizeStateId}
                    onChange={(e) => setFinalizeStateId(e.target.value)}
                  >
                    {finalizeOptions.states.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </div>
                {(() => {
                  const st = finalizeOptions.states.find((s) => s.id === finalizeStateId);
                  if (!st || st.substates.length === 0) return null;
                  return (
                    <div>
                      <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">Subestado</label>
                      <select
                        className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                        value={finalizeSubstateId}
                        onChange={(e) => setFinalizeSubstateId(e.target.value)}
                      >
                        <option value="">Elegir…</option>
                        {st.substates.map((sub) => (
                          <option key={sub.id} value={sub.id}>
                            {sub.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  );
                })()}
                <div>
                  <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">Comentario</label>
                  <textarea
                    className="w-full min-h-[88px] border border-slate-200 rounded-lg px-3 py-2 text-sm resize-y"
                    value={finalizeComment}
                    onChange={(e) => setFinalizeComment(e.target.value)}
                    placeholder="Resumí el resultado o próximos pasos para el equipo."
                  />
                </div>
                {finalizeOptions.source === "fallback" ? (
                  <p className="text-xs text-amber-800 bg-amber-50 border border-amber-100 rounded-lg px-2 py-1.5">
                    Esta cola no tiene estados propios configurados. Se muestran opciones por defecto hasta que un
                    administrador los defina en la configuración de la cola.
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="mt-4 text-sm text-red-700">No hay estados de cierre disponibles.</p>
            )}
            {finalizeModalError ? (
              <p className="mt-3 text-sm text-red-700 bg-red-50 border border-red-100 rounded-lg px-2 py-1.5">
                {finalizeModalError}
              </p>
            ) : null}
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                disabled={finalizeSaving}
                onClick={() => closeFinalizeModal()}
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={finalizeSaving || finalizeLoading || !finalizeOptions || finalizeOptions.states.length === 0}
                onClick={() => void confirmFinalize()}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
              >
                {finalizeSaving ? "Guardando…" : "Confirmar finalización"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3 shrink-0">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold text-slate-800 leading-tight truncate">
            {agentDisplayName}
          </h1>
          <p className="text-xs text-slate-500 leading-snug mt-0.5">
            Omnicanal ·{" "}
            {mode === "historial"
              ? "Historial omnicanal"
              : vista === "inbox"
                ? "Inbox"
                : "Bot"}
            {mode === "historial" ? (
              <>
                {" · "}
                <Link href="/dashboard/conversaciones" className="text-[#0EA5E9] hover:underline font-medium">
                  Inbox
                </Link>
              </>
            ) : null}
          </p>
        </div>
        {mode === "inbox" && opPresenceLoaded && !opInQueues ? (
          initialCabeceraInsignia === "admin" ? (
            <div className="flex flex-col items-end gap-1 shrink-0 max-w-[20rem] text-right">
              <span className="inline-flex items-center rounded-full bg-slate-800 px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-white">
                Administrador
              </span>
              <span className="text-[10px] text-slate-600 leading-snug">
                Sin puesto en colas ·{" "}
                <Link href="/configuracion/colas" className="font-semibold text-[#0EA5E9] hover:underline">
                  Colas
                </Link>
              </span>
            </div>
          ) : initialCabeceraInsignia === "supervisor" ? (
            <div className="flex flex-col items-end gap-1 shrink-0 max-w-[20rem] text-right">
              <span className="inline-flex items-center rounded-full bg-indigo-800 px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-white">
                Supervisor
              </span>
              <span className="text-[10px] text-slate-600 leading-snug">
                Sin fila de agente en colas ·{" "}
                <Link href="/configuracion/colas" className="font-semibold text-[#0EA5E9] hover:underline">
                  Colas
                </Link>
              </span>
            </div>
          ) : (
            <div className="text-[10px] text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5 max-w-[18rem] text-right leading-snug shrink-0">
              No figurás como agente en ninguna cola: no se muestra el turno Disponible/Pausa. Pedí asignación en{" "}
              <Link href="/configuracion/colas" className="font-semibold text-amber-950 underline-offset-2 hover:underline">
                Configuración → Colas
              </Link>
              .
            </div>
          )
        ) : null}
        {mode === "inbox" && opPresenceLoaded && opInQueues && opStatus !== null ? (
          <div
            className="flex flex-col items-end gap-1 shrink-0"
            role="group"
            aria-label="Disponible u en pausa para recibir chats nuevos por autoasignación"
          >
            <div className="flex flex-col items-end gap-0.5">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Tu turno</span>
                {opPresenceBusy ? (
                  <span className="text-[10px] font-medium text-sky-600 animate-pulse">Guardando…</span>
                ) : null}
              </div>
              <p className="text-[11px] font-bold text-slate-800 tabular-nums">
                Estado actual:{" "}
                <span className={opStatus === "ready" ? "text-emerald-700" : "text-slate-600"}>
                  {opStatus === "ready" ? "Disponible" : "En pausa"}
                </span>
              </p>
            </div>
            <div className="flex items-center gap-0.5 rounded-lg border border-slate-300 bg-slate-100 p-0.5 shadow-inner">
              <button
                type="button"
                disabled={opPresenceBusy}
                className={opPresenceToggleClass(opStatus === "ready", "ready")}
                aria-pressed={opStatus === "ready"}
                aria-label="Marcar disponible para autoasignación (ready)"
                onClick={() => void applyOperationalStatus("ready")}
              >
                Disponible
              </button>
              <button
                type="button"
                disabled={opPresenceBusy}
                className={opPresenceToggleClass(opStatus === "offline", "offline")}
                aria-pressed={opStatus === "offline"}
                aria-label="Pausar recepción de chats nuevos por autoasignación (offline)"
                onClick={() => void applyOperationalStatus("offline")}
              >
                En pausa
              </button>
            </div>
            <span className="text-[10px] text-slate-500 max-w-[15rem] text-right leading-tight hidden sm:block">
              Disponible = entrás en la rotación de nuevos chats. En pausa = no recibís asignaciones automáticas.
            </span>
            <div className="text-[10px] text-slate-700 text-right leading-tight w-full">
              <span className="text-slate-500">
                {opStatus === "ready" ? "Tiempo en Disponible" : "Tiempo en pausa"}:{" "}
              </span>
              {opSince ? (
                <LiveElapsedLabel sinceIso={opSince} />
              ) : (
                <span className="text-slate-400 italic">sin marca de tiempo en DB</span>
              )}
            </div>
            {sessionSinceIso ? (
              <div className="text-[10px] text-slate-600 text-right leading-tight w-full border-t border-slate-200/80 pt-1 mt-0.5">
                <span className="text-slate-500">Sesión en inbox:</span>{" "}
                <LiveElapsedLabel sinceIso={sessionSinceIso} />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      {mode === "inbox" && sessionSinceIso && !opInQueues ? (
        <div className="flex justify-end w-full shrink-0 -mt-1">
          <p className="text-[10px] text-slate-500 tabular-nums">
            Sesión en inbox: <LiveElapsedLabel sinceIso={sessionSinceIso} />
          </p>
        </div>
      ) : null}
      {mode === "inbox" && opPresenceErr ? (
        <div className="bg-amber-50 border border-amber-200 text-amber-900 text-xs rounded-lg px-2 py-1.5 shrink-0">
          {opPresenceErr}
        </div>
      ) : null}
      {mode === "inbox" && opPresenceOkMsg ? (
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-900 text-xs rounded-lg px-2 py-1.5 shrink-0 font-medium">
          {opPresenceOkMsg}
        </div>
      ) : null}

      {mode === "inbox" ? (
        <div className="flex flex-wrap items-stretch gap-2 shrink-0 min-w-0">
          <div className="flex flex-wrap gap-1 rounded-lg border border-slate-200 bg-slate-100/80 p-1 w-fit shrink-0 self-center">
            <button type="button" className={tabClass(vista === "inbox")} onClick={() => setVista("inbox")}>
              Inbox
            </button>
            {hasActiveBotFlows ? (
              <button type="button" className={tabClass(vista === "bot")} onClick={() => setVista("bot")}>
                Bot
              </button>
            ) : null}
          </div>
          <input
            type="search"
            value={listSearch}
            onChange={(e) => setListSearch(e.target.value)}
            placeholder="Buscar por nombre o número"
            className="flex-1 min-w-[12rem] border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-800 bg-white placeholder:text-slate-400 outline-none focus:ring-1 focus:ring-sky-400/40 focus:border-sky-300"
            aria-label="Buscar por nombre o número"
          />
        </div>
      ) : null}

      {hasActiveChannel === false && (
        <div className="bg-amber-50 border border-amber-200 text-amber-900 text-xs rounded-lg px-2 py-2 shrink-0">
          No hay un canal de conversación activo para tu empresa. Los mensajes no se registrarán hasta configurarlo.
        </div>
      )}

      {listError && (
        <div className="bg-red-50 border border-red-200 text-red-800 text-xs rounded-lg px-2 py-1.5 shrink-0">
          {listError}
        </div>
      )}
      {messagesError && (
        <div className="bg-amber-50 border border-amber-200 text-amber-950 text-xs rounded-lg px-2 py-1.5 shrink-0">
          {messagesError}
        </div>
      )}

      <div className="flex flex-1 min-h-0 border border-slate-200 rounded-lg overflow-hidden bg-white shadow-sm">
        {/* Lista */}
        {!listColumnHidden ? (
        <div className="w-full max-w-[min(360px,40vw)] shrink-0 border-r border-slate-200 flex flex-col min-h-0 bg-slate-50/80">
          <div className="px-2 py-1.5 border-b border-slate-200 flex items-center justify-between gap-2 shrink-0">
            <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Chats</span>
            <button
              type="button"
              onClick={() => setListColumnHidden(true)}
              className="text-[10px] font-medium text-slate-500 hover:text-slate-800 px-1.5 py-0.5 rounded border border-transparent hover:border-slate-200 hover:bg-white"
              title="Ocultar lista de chats"
            >
              Ocultar
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
            {loadingList ? (
              <div className="p-4 text-xs text-slate-400 text-center animate-pulse">Cargando…</div>
            ) : conversations.length === 0 ? (
              <div className="p-4 text-xs text-slate-500 text-center space-y-1">
                <p>No hay conversaciones aún</p>
              </div>
            ) : visibleConversations.length === 0 ? (
              <div className="p-4 text-xs text-slate-500 text-center space-y-1">
                <p>Ningún chat coincide con la búsqueda</p>
              </div>
            ) : (
              visibleConversations.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => handleSelect(c.id)}
                  className={`w-full text-left px-2.5 py-2 border-b border-slate-100 hover:bg-white transition-colors ${
                    selectedId === c.id ? "bg-white border-l-[3px] border-l-[#0EA5E9]" : ""
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-slate-800 truncate">
                        {c.contact.name?.trim() ? c.contact.name.trim() : "Sin nombre"}
                      </div>
                      <div className="text-xs text-slate-500 font-mono truncate">
                        {c.contact.phone_number || "—"}
                      </div>
                      <div className="mt-1">
                        <ChannelBadge type={c.channel.type} nombre={c.channel.nombre} />
                      </div>
                      <p className="text-xs text-slate-500 truncate mt-1">{c.last_message_preview || "—"}</p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <div className="flex items-center gap-1">
                        {vista === "bot" ? (
                          <span className="text-[10px] font-semibold uppercase tracking-wide text-violet-700 bg-violet-50 border border-violet-200 px-1.5 py-0.5 rounded">
                            Bot
                          </span>
                        ) : c.human_taken_over || c.flow_status === "human" ? (
                          <span className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded">
                            Humano
                          </span>
                        ) : null}
                        {c.unread_count > 0 && (
                          <span className="bg-[#0EA5E9] text-white text-xs font-bold px-2 py-0.5 rounded-full">
                            {c.unread_count}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    <span
                      className={`text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border ${badgeEstadoClass(c.status)}`}
                    >
                      {labelEstado(c.status)}
                    </span>
                    {c.queue_name ? (
                      <span
                        className="text-[9px] font-medium text-indigo-800 bg-indigo-50 border border-indigo-200 px-1.5 py-0.5 rounded truncate max-w-full"
                        title={`Cola: ${c.queue_name}`}
                      >
                        Cola · {c.queue_name}
                      </span>
                    ) : null}
                    {vista !== "bot" ? <InboxReplyTurnBadges c={c} dense /> : null}
                    {c.assigned_agent_name ? (
                      <span
                        className="text-[9px] font-semibold text-emerald-900 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded truncate max-w-full"
                        title={`Agente asignado: ${c.assigned_agent_name}`}
                      >
                        Agente · {c.assigned_agent_name}
                      </span>
                    ) : (
                      (() => {
                        const w = assignmentWaitBadge(c.assignment_wait_code, Boolean(c.queue_id));
                        return (
                          <span
                            className={`text-[9px] font-semibold px-1.5 py-0.5 rounded border truncate max-w-full ${assignmentWaitBadgeClass(w.tone)}`}
                            title="Sin agente asignado"
                          >
                            {w.label}
                          </span>
                        );
                      })()
                    )}
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
        ) : null}

        {/* Panel mensajes */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
          {!selectedId ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-2 text-slate-400 text-sm min-h-0 px-2">
              <span>Seleccioná una conversación</span>
              {listColumnHidden ? (
                <button
                  type="button"
                  onClick={() => setListColumnHidden(false)}
                  className="text-xs font-medium text-[#0EA5E9] hover:underline"
                >
                  Mostrar lista de chats
                </button>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
              <div className="px-2 py-2 border-b border-slate-200 bg-white shrink-0">
                {selected ? (
                  <div className="flex flex-col gap-2 min-w-0 w-full">
                    <div className="flex flex-wrap items-start gap-x-2 gap-y-1.5 min-w-0">
                      <div className="min-w-0 flex-1 basis-[min(100%,14rem)]">
                        <div className="font-semibold text-slate-800 text-sm truncate">
                          {selected.contact.name?.trim() ? selected.contact.name.trim() : "Sin nombre"}
                        </div>
                        <div className="text-xs text-slate-500 font-mono truncate">
                          {selected.contact.phone_number || "—"}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-1 shrink-0 justify-end">
                        <ChannelBadge type={selected.channel.type} nombre={selected.channel.nombre} />
                        {vista === "bot" ? (
                          <span className="text-[10px] font-semibold text-violet-800 bg-violet-50 border border-violet-200 px-1.5 py-0.5 rounded shrink-0">
                            Bot
                          </span>
                        ) : isHumanActive ? (
                          <span className="text-[10px] font-semibold text-emerald-800 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded shrink-0">
                            Humano
                          </span>
                        ) : null}
                        <span
                          className={`text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded border shrink-0 ${badgeEstadoClass(selected.status)}`}
                        >
                          {labelEstado(selected.status)}
                        </span>
                        {listColumnHidden ? (
                          <button
                            type="button"
                            onClick={() => setListColumnHidden(false)}
                            className="shrink-0 text-[10px] font-medium text-slate-600 hover:text-slate-900 border border-slate-200 rounded px-1.5 py-0.5 bg-white"
                            title="Mostrar lista de chats"
                          >
                            Chats
                          </button>
                        ) : null}
                      </div>
                    </div>

                    {vista !== "bot" && selected ? (
                      <div className="flex flex-wrap items-center gap-1">
                        {selected.queue_name ? (
                          <span
                            className="text-[10px] font-medium text-indigo-900 bg-indigo-50 border border-indigo-200 rounded px-1.5 py-0.5 truncate max-w-full"
                            title="Cola de enrutamiento"
                          >
                            Cola: {selected.queue_name}
                          </span>
                        ) : mode === "inbox" ? (
                          <span className="text-[10px] text-slate-600 bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5">
                            Sin cola
                          </span>
                        ) : null}
                        <InboxReplyTurnBadges c={selected} />
                        {selected.assigned_agent_name ? (
                          <span
                            className="text-[10px] font-semibold text-emerald-900 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5 truncate max-w-full"
                            title="Agente asignado"
                          >
                            Agente: {selected.assigned_agent_name}
                          </span>
                        ) : mode === "inbox" ? (
                          (() => {
                            const w = assignmentWaitBadge(
                              selected.assignment_wait_code,
                              Boolean(selected.queue_id)
                            );
                            return (
                              <span
                                className={`text-[10px] font-semibold rounded px-1.5 py-0.5 border ${assignmentWaitBadgeClass(w.tone)}`}
                                title="Aún sin agente asignado"
                              >
                                Sin agente · {w.label}
                              </span>
                            );
                          })()
                        ) : null}
                      </div>
                    ) : null}

                    <div className="flex flex-wrap items-center gap-1 w-full sm:justify-end">
                      <span className="text-[10px] font-semibold text-slate-600 shrink-0">Transferir a</span>
                      <select
                        disabled={opsBusy}
                        className="text-[10px] border border-slate-200 rounded px-1 py-0.5 max-w-[10rem] min-h-[1.5rem] bg-white"
                        value=""
                        onChange={(e) => {
                          const v = e.target.value;
                          (e.target as HTMLSelectElement).value = "";
                          if (v && selected) {
                            void runConversationOp(() => changeConversationQueue(selected.id, v));
                          }
                        }}
                        aria-label="Transferir conversación a otra cola"
                      >
                        <option value="">Cola…</option>
                        {opsQueues
                          .filter((q) => q.is_active)
                          .map((q) => (
                            <option key={q.id} value={q.id}>
                              {q.nombre}
                            </option>
                          ))}
                      </select>
                      <select
                        disabled={opsBusy}
                        className="text-[10px] border border-slate-200 rounded px-1 py-0.5 max-w-[11rem] min-h-[1.5rem] bg-white"
                        value=""
                        onChange={(e) => {
                          const v = e.target.value;
                          (e.target as HTMLSelectElement).value = "";
                          if (v && selected) {
                            void runConversationOp(() => assignConversationToAgent(selected.id, v));
                          }
                        }}
                        aria-label="Transferir conversación a otro agente"
                      >
                        <option value="">Agente…</option>
                        {opsAgents
                          .filter((a) => a.id !== selected.assigned_agent_id)
                          .map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.nombre} · {a.queue_nombre}
                            </option>
                          ))}
                      </select>
                      {isHumanActive ? (
                        <button
                          type="button"
                          disabled={releasingBot}
                          onClick={() => void handleReleaseToBot()}
                          className="text-[10px] font-medium text-slate-600 hover:text-slate-800 border border-slate-200 rounded px-1.5 py-0.5 bg-white disabled:opacity-50"
                        >
                          {releasingBot ? "…" : "Modo bot"}
                        </button>
                      ) : null}
                      {selected.status !== "closed" && mode === "inbox" ? (
                        <button
                          type="button"
                          disabled={opsBusy || finalizeSaving}
                          onClick={() => void openFinalizeModal()}
                          className="text-[10px] font-medium text-slate-700 border border-slate-300 rounded px-1.5 py-0.5 hover:bg-slate-50 disabled:opacity-50"
                        >
                          Finalizar
                        </button>
                      ) : selected.status === "closed" ? (
                        <button
                          type="button"
                          disabled={opsBusy}
                          onClick={() =>
                            void runConversationOp(() =>
                              changeConversationStatus(selected.id, "open")
                            )
                          }
                          className="text-[10px] font-medium text-emerald-800 border border-emerald-300 rounded px-1.5 py-0.5 bg-emerald-50 hover:bg-emerald-100 disabled:opacity-50"
                        >
                          Reabrir
                        </button>
                      ) : null}
                      {selected.contact.cliente_id ? (
                        <Link
                          href={`/clientes/${selected.contact.cliente_id}`}
                          className="text-[10px] text-[#0EA5E9] hover:underline shrink-0"
                        >
                          Cliente
                        </Link>
                      ) : null}
                      {selected.contact.crm_prospecto_id ? (
                        <Link
                          href={`/crm/${selected.contact.crm_prospecto_id}`}
                          className="text-[10px] text-violet-600 hover:underline shrink-0"
                        >
                          CRM
                        </Link>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>

              {selected?.channel.comprobante_validation_enabled ? (
                <div className="border-b border-amber-100/90 bg-amber-50/30 shrink-0">
                  <button
                    type="button"
                    onClick={() => setCompValidacionesOpen((o) => !o)}
                    aria-expanded={compValidacionesOpen}
                    className="w-full text-left px-2 py-1 text-xs font-medium text-amber-900 flex items-center justify-between gap-2 hover:bg-amber-50/80"
                  >
                    <span>
                      ⚠️ Validaciones ({compLoading ? "…" : compVals.length})
                    </span>
                    <span className="text-slate-500 tabular-nums shrink-0" aria-hidden>
                      {compValidacionesOpen ? "▲" : "▼"}
                    </span>
                  </button>
                  {compValidacionesOpen ? (
                    <div className="px-2 pb-2 max-h-48 overflow-y-auto overscroll-contain border-t border-amber-100/80">
                      {compLoading ? (
                        <p className="text-xs text-slate-500 pt-1">Cargando…</p>
                      ) : compVals.length === 0 ? (
                        <p className="text-xs text-slate-500 pt-1">
                          No hay comprobantes registrados en esta conversación.
                        </p>
                      ) : (
                        <ul className="space-y-1.5 pt-1">
                          {compVals.map((v) => (
                            <li
                              key={v.id}
                              className="flex flex-wrap items-center gap-1.5 text-[11px] bg-white border border-slate-200 rounded-md px-1.5 py-1"
                            >
                              <span className="font-mono text-slate-600">{v.estado_validacion}</span>
                              {v.monto_validacion_status != null && v.monto_validacion_status !== "" ? (
                                <span
                                  className="text-[10px] text-slate-500 max-w-[200px] truncate"
                                  title={v.motivo_validacion ?? ""}
                                >
                                  monto: {v.monto_validacion_status}
                                  {v.monto_validacion_esperado_gs != null
                                    ? ` · esp ${v.monto_validacion_esperado_gs}`
                                    : ""}
                                  {v.monto_validacion_ocr_gs != null ? ` · ocr ${v.monto_validacion_ocr_gs}` : ""}
                                  {v.monto_validacion_diferencia_gs != null
                                    ? ` · Δ ${v.monto_validacion_diferencia_gs}`
                                    : ""}
                                </span>
                              ) : null}
                              {v.bank_val_status != null && v.bank_val_status !== "" ? (
                                <span
                                  className="text-[10px] text-slate-500 max-w-[220px] truncate"
                                  title={v.motivo_validacion ?? ""}
                                >
                                  banco: {v.bank_val_status}
                                  {v.bank_val_coincidencias != null && v.bank_val_min_requeridas != null
                                    ? ` · ${v.bank_val_coincidencias}/${v.bank_val_min_requeridas}`
                                    : ""}
                                </span>
                              ) : null}
                              {v.comprobante_url ? (
                                <a
                                  href={v.comprobante_url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-[#0EA5E9] hover:underline"
                                >
                                  Ver archivo
                                </a>
                              ) : null}
                              {v.estado_validacion !== "valido" ? (
                                <button
                                  type="button"
                                  disabled={compActionId === v.id}
                                  onClick={async () => {
                                    const convId = selectedId;
                                    if (!convId) return;
                                    setCompActionId(v.id);
                                    try {
                                      await approveComprobanteValidacion(v.id);
                                      const rows = await fetchComprobanteValidacionesForConversation(convId);
                                      setCompVals(rows);
                                    } catch (e) {
                                      setSendError(
                                        e instanceof Error ? e.message : "No se pudo aprobar el comprobante"
                                      );
                                    } finally {
                                      setCompActionId(null);
                                    }
                                  }}
                                  className="text-emerald-700 font-medium hover:underline disabled:opacity-50"
                                >
                                  Aprobar (cerrar compra)
                                </button>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div
                ref={messagesScrollRef}
                onScroll={onMessagesScroll}
                className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-2 space-y-2 bg-slate-50/50"
              >
                {loadingMsg ? (
                  <div className="text-center text-slate-400 text-sm py-8">Cargando mensajes…</div>
                ) : (
                  messages.map((m) => {
                    const attachUrl = resolveAttachmentUrl(m);
                    const metaDocName = getMetaInboundDocumentFilename(m.raw_payload);
                    const erpName = getErpAttachmentFilename(m.raw_payload);
                    const showAsImage =
                      m.message_type === "image" ||
                      m.message_type === "sticker" ||
                      (m.message_type === "document" && isImageMimeHint(m.raw_payload, m.message_type));

                    return (
                      <div
                        key={m.id}
                        className={`flex ${m.from_me ? "justify-end" : "justify-start"}`}
                      >
                        <div
                          className={`max-w-[85%] rounded-xl px-3 py-1.5 text-sm ${
                            m.from_me
                              ? "bg-[#0EA5E9] text-white rounded-br-md"
                              : "bg-white border border-slate-200 text-slate-800 rounded-bl-md shadow-sm"
                          }`}
                        >
                          {showAsImage && attachUrl ? (
                            <div className="space-y-2">
                              <div
                                className={`text-xs font-medium ${m.from_me ? "text-sky-100" : "text-slate-500"}`}
                              >
                                Imagen
                              </div>
                              <button
                                type="button"
                                className="p-0 border-0 bg-transparent cursor-zoom-in text-left"
                                onClick={() => setLightboxUrl(attachUrl)}
                              >
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={attachUrl}
                                  alt="Imagen del chat"
                                  className="max-h-52 rounded-lg border border-white/30 bg-white object-contain"
                                />
                              </button>
                              {m.content && m.content !== "[imagen]" ? (
                                <p className="whitespace-pre-wrap break-words text-sm opacity-95">{m.content}</p>
                              ) : null}
                            </div>
                          ) : m.message_type === "audio" ? (
                            <div className="space-y-2">
                              <div
                                className={`text-xs font-medium ${m.from_me ? "text-sky-100" : "text-slate-500"}`}
                              >
                                Audio
                              </div>
                              {attachUrl ? (
                                <audio
                                  controls
                                  src={attachUrl}
                                  className="w-full max-w-[280px] h-9"
                                  preload="metadata"
                                />
                              ) : (
                                <p className="whitespace-pre-wrap break-words text-sm opacity-90">
                                  {m.content ?? "[audio]"}
                                </p>
                              )}
                            </div>
                          ) : m.message_type === "document" || m.message_type === "video" ? (
                            <div className="space-y-2">
                              {attachUrl ? (
                                <a
                                  href={attachUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className={`flex items-start gap-3 rounded-xl border px-3 py-2.5 no-underline transition-colors ${
                                    m.from_me
                                      ? "border-white/25 bg-sky-500/20 hover:bg-sky-500/30 text-white"
                                      : "border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-900"
                                  }`}
                                >
                                  <span className="text-2xl leading-none shrink-0 select-none" aria-hidden>
                                    {m.message_type === "video" ? "▶️" : "📎"}
                                  </span>
                                  <span className="min-w-0 flex-1">
                                    <span
                                      className={`block text-[10px] font-bold uppercase tracking-wide ${
                                        m.from_me ? "text-sky-100" : "text-slate-500"
                                      }`}
                                    >
                                      {m.message_type === "video" ? "Video" : "Documento"}
                                    </span>
                                    <span className="block text-sm font-semibold break-words mt-0.5">
                                      {displayFilenameForAttachment(m)}
                                    </span>
                                    <span
                                      className={`block text-[11px] mt-1 ${
                                        m.from_me ? "text-sky-100" : "text-slate-500"
                                      }`}
                                    >
                                      Tocá para abrir o descargar
                                    </span>
                                  </span>
                                </a>
                              ) : (
                                <div>
                                  <div
                                    className={`text-xs font-medium ${m.from_me ? "text-sky-100" : "text-slate-500"}`}
                                  >
                                    {m.message_type === "video" ? "Video" : "Documento"}
                                  </div>
                                  <p className="whitespace-pre-wrap break-words mt-1">
                                    {erpName || metaDocName ? (
                                      <>
                                        <span className="font-medium">{erpName || metaDocName}</span>
                                        {m.content ? (
                                          <>
                                            <br />
                                            {m.content}
                                          </>
                                        ) : null}
                                      </>
                                    ) : (
                                      m.content
                                    )}
                                  </p>
                                </div>
                              )}
                            </div>
                          ) : m.message_type === "image" ? (
                            (() => {
                              const parsed = parseOutgoingImageMessage(m);
                              return (
                                <div className="space-y-2">
                                  <div
                                    className={`text-xs font-medium ${m.from_me ? "text-sky-100" : "text-slate-500"}`}
                                  >
                                    Mensaje con imagen
                                  </div>
                                  {parsed.url ? (
                                    <button
                                      type="button"
                                      className="p-0 border-0 bg-transparent cursor-zoom-in text-left"
                                      onClick={() => setLightboxUrl(parsed.url!)}
                                    >
                                      {/* eslint-disable-next-line @next/next/no-img-element */}
                                      <img
                                        src={parsed.url}
                                        alt="Imagen enviada"
                                        className="max-h-52 rounded-lg border border-white/30 bg-white object-contain"
                                      />
                                    </button>
                                  ) : null}
                                  {parsed.caption ? (
                                    <p className="whitespace-pre-wrap break-words">{parsed.caption}</p>
                                  ) : null}
                                  {!parsed.url && !parsed.caption ? (
                                    <p className="whitespace-pre-wrap break-words">{m.content}</p>
                                  ) : null}
                                </div>
                              );
                            })()
                          ) : (
                            <p className="whitespace-pre-wrap break-words">{m.content}</p>
                          )}
                          <p
                            className={`text-[10px] mt-1 ${m.from_me ? "text-sky-100" : "text-slate-400"}`}
                          >
                            {formatTime(m.created_at)}
                            {m.message_type !== "text" && ` · ${m.message_type}`}
                          </p>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              <form
                onSubmit={handleSend}
                className="p-2 border-t border-slate-200 bg-white flex flex-col gap-1.5 shrink-0 min-h-0"
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  accept="image/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt"
                  onChange={(e) => void handleSendFile(e)}
                />
                {sendError && (
                  <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-2 py-1.5">
                    {sendError}
                  </div>
                )}
                <div className="flex gap-1.5 items-stretch">
                  <button
                    type="button"
                    disabled={uploadingFile || !selectedId || recordingVoice}
                    onClick={() => fileInputRef.current?.click()}
                    className="shrink-0 border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-50 px-2.5 py-2 rounded-lg text-sm font-medium min-h-[2.5rem]"
                    title="Adjuntar imagen, audio o documento"
                  >
                    {uploadingFile ? "…" : "Adjunto"}
                  </button>
                  <button
                    type="button"
                    disabled={uploadingFile || !selectedId}
                    onClick={() => void toggleVoiceNote()}
                    className={`shrink-0 border px-2.5 py-2 rounded-lg text-xs font-semibold min-h-[2.5rem] disabled:opacity-50 ${
                      recordingVoice
                        ? "border-red-300 bg-red-50 text-red-700"
                        : "border-slate-200 text-slate-600 hover:bg-slate-50"
                    }`}
                    title={
                      recordingVoice
                        ? "Detener y enviar nota de voz"
                        : "Grabar nota de voz (micrófono)"
                    }
                  >
                    {recordingVoice ? "Parar" : "Voz"}
                  </button>
                  <input
                    className="flex-1 min-w-0 border border-slate-200 rounded-lg px-2.5 py-2 text-sm min-h-[2.5rem] focus:ring-2 focus:ring-[#0EA5E9]/30 focus:border-[#0EA5E9] outline-none"
                    placeholder="Escribí un mensaje…"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    disabled={sending}
                  />
                  <button
                    type="submit"
                    disabled={sending || !input.trim()}
                    className="bg-[#0EA5E9] hover:bg-[#0284C7] disabled:opacity-50 text-white px-3 py-2 rounded-lg text-sm font-medium shrink-0 min-h-[2.5rem]"
                  >
                    {sending ? "…" : "Enviar"}
                  </button>
                </div>
              </form>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
