"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  approveComprobanteValidacion,
  fetchChatChannels,
  fetchChatConversations,
  fetchComprobanteValidacionesForConversation,
  markConversationRead,
  releaseConversationToBot,
  type ComprobanteValidacionListRow,
  type ConversacionesVista,
  type InboxConversation,
} from "@/lib/chat/actions";
import {
  getErpAttachmentCaption,
  getErpAttachmentFilename,
  getErpAttachmentPublicUrl,
  getMetaInboundDocumentFilename,
  isImageMimeHint,
} from "@/lib/chat/message-erp-display";
import { supabase } from "@/lib/supabase";

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
  return getErpAttachmentPublicUrl(message.raw_payload) ?? parseOutgoingImageMessage(message).url;
}

function tabClass(active: boolean) {
  return `px-3 py-2 text-xs font-semibold rounded-lg transition-colors ${
    active ? "bg-white text-slate-800 shadow-sm border border-slate-200" : "text-slate-500 hover:text-slate-700"
  }`;
}

export default function ConversacionesPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const vistaParam = searchParams?.get("vista") ?? "";
  const vista: ConversacionesVista =
    vistaParam === "bot" ? "bot" : vistaParam === "historial" ? "historial" : "inbox";

  const [conversations, setConversations] = useState<InboxConversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loadingList, setLoadingList] = useState(true);
  const [loadingMsg, setLoadingMsg] = useState(false);
  const [sending, setSending] = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [releasingBot, setReleasingBot] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [hasActiveChannel, setHasActiveChannel] = useState<boolean | null>(null);
  const [compVals, setCompVals] = useState<ComprobanteValidacionListRow[]>([]);
  const [compLoading, setCompLoading] = useState(false);
  const [compActionId, setCompActionId] = useState<string | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  /** Si el usuario está cerca del final, los mensajes nuevos hacen scroll; si subió a leer historial, no. */
  const stickBottomRef = useRef(true);
  const lastMessageIdRef = useRef<string | null>(null);
  const loadConversationsRef = useRef<(opts?: { silent?: boolean }) => Promise<void>>(async () => {});

  const loadConversations = useCallback(
    async (opts?: { silent?: boolean }) => {
      const silent = opts?.silent ?? false;
      try {
        const rows = await fetchChatConversations(vista);
        setConversations(rows);
        setListError(null);
      } catch (e) {
        setListError(e instanceof Error ? e.message : "Error al cargar conversaciones");
      } finally {
        if (!silent) setLoadingList(false);
      }
    },
    [vista]
  );

  const loadMessages = useCallback(async (conversationId: string, opts?: { silent?: boolean }) => {
    const silent = opts?.silent ?? false;
    if (!silent) setLoadingMsg(true);
    try {
      const { data, error: err } = await supabase
        .from("chat_messages")
        .select("id, from_me, message_type, content, raw_payload, created_at")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true });

      if (err) throw new Error(err.message);
      setMessages((data ?? []) as ChatMessage[]);
    } catch (e) {
      setListError(e instanceof Error ? e.message : "Error al cargar mensajes");
    } finally {
      if (!silent) setLoadingMsg(false);
    }
  }, []);

  loadConversationsRef.current = loadConversations;

  useEffect(() => {
    setLoadingList(true);
    setSelectedId(null);
    setMessages([]);
    loadConversations();
  }, [loadConversations]);

  function setVista(next: ConversacionesVista) {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (next === "inbox") params.delete("vista");
    else params.set("vista", next);
    const qs = params.toString();
    const base = pathname || "/dashboard/conversaciones";
    router.push(qs ? `${base}?${qs}` : base);
  }

  useEffect(() => {
    fetchChatChannels()
      .then((ch) => setHasActiveChannel(ch.some((c) => c.activo)))
      .catch(() => setHasActiveChannel(null));
  }, []);

  /** Lista: actualizar con Realtime (sin polling). */
  useEffect(() => {
    const channel = supabase
      .channel("conversaciones-inbox-list")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "chat_conversations" },
        () => {
          void loadConversationsRef.current?.({ silent: true });
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, []);

  /** Mensajes del hilo abierto: INSERT en tiempo real. */
  useEffect(() => {
    if (!selectedId) return;

    const channel = supabase
      .channel(`conversaciones-msg-${selectedId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "chat_messages",
          filter: `conversation_id=eq.${selectedId}`,
        },
        (payload) => {
          const row = payload.new as Record<string, unknown>;
          if (!row?.id) return;
          const msg = mapRowToMessage(row);
          setMessages((prev) => {
            if (prev.some((m) => m.id === msg.id)) return prev;
            return [...prev, msg].sort(
              (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
            );
          });
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [selectedId]);

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

  const handleSelect = useCallback(async (id: string) => {
    stickBottomRef.current = true;
    lastMessageIdRef.current = null;
    setSelectedId(id);
    await loadMessages(id);
    setCompLoading(true);
    try {
      const rows = await fetchComprobanteValidacionesForConversation(id);
      setCompVals(rows);
    } catch {
      setCompVals([]);
    } finally {
      setCompLoading(false);
    }
    try {
      await markConversationRead(id);
      setConversations((prev) =>
        prev.map((c) => (c.id === id ? { ...c, unread_count: 0 } : c))
      );
    } catch {
      /* no bloquear UI */
    }
  }, [loadMessages]);

  async function handleSendFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !selectedId || uploadingFile) return;
    setUploadingFile(true);
    setSendError(null);
    stickBottomRef.current = true;
    try {
      const fd = new FormData();
      fd.set("conversation_id", selectedId);
      fd.set("file", file);
      const res = await fetch("/api/chat/send-media", {
        method: "POST",
        body: fd,
        credentials: "same-origin",
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        throw new Error(typeof json.error === "string" ? json.error : `Error HTTP ${res.status}`);
      }
      await loadMessages(selectedId, { silent: true });
      await loadConversations({ silent: true });
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Error al enviar archivo");
    } finally {
      setUploadingFile(false);
    }
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

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedId || !input.trim() || sending) return;
    setSending(true);
    setSendError(null);
    stickBottomRef.current = true;
    try {
      const res = await fetch("/api/chat/send", {
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

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-3">
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

      <div className="flex flex-wrap items-start justify-between gap-3 shrink-0">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Conversaciones</h1>
          <p className="text-sm text-slate-500">
            WhatsApp ·{" "}
            {vista === "inbox"
              ? "Inbox (operador humano)"
              : vista === "bot"
                ? "Automatización / bot"
                : "Historial completo"}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-1 rounded-lg border border-slate-200 bg-slate-100/80 p-1 w-fit shrink-0">
        <button type="button" className={tabClass(vista === "inbox")} onClick={() => setVista("inbox")}>
          Inbox
        </button>
        <button type="button" className={tabClass(vista === "bot")} onClick={() => setVista("bot")}>
          Bot
        </button>
        <button
          type="button"
          className={tabClass(vista === "historial")}
          onClick={() => setVista("historial")}
        >
          Historial
        </button>
      </div>

      {hasActiveChannel === false && (
        <div className="bg-amber-50 border border-amber-200 text-amber-900 text-sm rounded-lg px-4 py-3 shrink-0">
          No hay un canal WhatsApp activo para tu empresa. Los mensajes no se registrarán hasta configurarlo.
        </div>
      )}

      {listError && (
        <div className="bg-red-50 border border-red-200 text-red-800 text-sm rounded-lg px-4 py-2 shrink-0">
          {listError}
        </div>
      )}

      <div className="flex flex-1 min-h-0 border border-slate-200 rounded-xl overflow-hidden bg-white shadow-sm">
        {/* Lista */}
        <div className="w-full max-w-[340px] border-r border-slate-200 flex flex-col bg-slate-50/80">
          <div className="p-3 border-b border-slate-200 text-xs font-semibold text-slate-500 uppercase tracking-wide">
            Chats
          </div>
          <div className="flex-1 overflow-y-auto">
            {loadingList ? (
              <div className="p-6 text-sm text-slate-400 text-center animate-pulse">Cargando…</div>
            ) : conversations.length === 0 ? (
              <div className="p-6 text-sm text-slate-500 text-center space-y-2">
                <p>No hay conversaciones aún</p>
              </div>
            ) : (
              conversations.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => handleSelect(c.id)}
                  className={`w-full text-left px-4 py-3 border-b border-slate-100 hover:bg-white transition-colors ${
                    selectedId === c.id ? "bg-white border-l-4 border-l-[#0EA5E9]" : ""
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-medium text-slate-800 truncate">
                      {c.contact.name || c.contact.phone_number}
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      {c.human_taken_over || c.flow_status === "human" ? (
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded">
                          Humano
                        </span>
                      ) : (
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-violet-700 bg-violet-50 border border-violet-200 px-1.5 py-0.5 rounded">
                          Bot
                        </span>
                      )}
                      {c.unread_count > 0 && (
                        <span className="bg-[#0EA5E9] text-white text-xs font-bold px-2 py-0.5 rounded-full">
                          {c.unread_count}
                        </span>
                      )}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 truncate mt-0.5">
                    {c.last_message_preview || "—"}
                  </p>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Panel mensajes */}
        <div className="flex-1 flex flex-col min-w-0">
          {!selectedId ? (
            <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">
              Seleccioná una conversación
            </div>
          ) : (
            <>
              <div className="px-4 py-3 border-b border-slate-200 bg-white flex flex-wrap items-center gap-2">
                <div className="font-semibold text-slate-800">
                  {selected?.contact.name || selected?.contact.phone_number}
                </div>
                <span className="text-xs text-slate-400 font-mono">
                  {selected?.contact.phone_number}
                </span>
                {isHumanActive ? (
                  <span className="text-[11px] font-semibold text-emerald-800 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">
                    Modo humano · el bot no responde
                  </span>
                ) : (
                  <span className="text-[11px] font-semibold text-violet-800 bg-violet-50 border border-violet-200 px-2 py-0.5 rounded-full">
                    Bot activo
                  </span>
                )}
                {isHumanActive && (
                  <button
                    type="button"
                    disabled={releasingBot}
                    onClick={() => void handleReleaseToBot()}
                    className="text-xs font-medium text-slate-600 hover:text-slate-800 border border-slate-200 rounded-lg px-2 py-1 bg-white disabled:opacity-50"
                  >
                    {releasingBot ? "…" : "Volver a modo bot"}
                  </button>
                )}
                {selected?.contact.cliente_id && (
                  <Link
                    href={`/clientes/${selected.contact.cliente_id}`}
                    className="text-xs text-[#0EA5E9] hover:underline"
                  >
                    Ver cliente
                  </Link>
                )}
                {selected?.contact.crm_prospecto_id && (
                  <Link
                    href={`/crm/${selected.contact.crm_prospecto_id}`}
                    className="text-xs text-violet-600 hover:underline"
                  >
                    Ver prospecto CRM
                  </Link>
                )}
              </div>

              <div className="px-4 py-2 border-b border-slate-200 bg-amber-50/40 text-sm">
                <div className="font-semibold text-slate-700 text-xs uppercase tracking-wide mb-2">
                  Comprobantes (validación)
                </div>
                {compLoading ? (
                  <p className="text-xs text-slate-500">Cargando…</p>
                ) : compVals.length === 0 ? (
                  <p className="text-xs text-slate-500">No hay comprobantes registrados en esta conversación.</p>
                ) : (
                  <ul className="space-y-2 max-h-40 overflow-y-auto">
                    {compVals.map((v) => (
                      <li
                        key={v.id}
                        className="flex flex-wrap items-center gap-2 text-xs bg-white border border-slate-200 rounded-lg px-2 py-1.5"
                      >
                        <span className="font-mono text-slate-600">{v.estado_validacion}</span>
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

              <div
                ref={messagesScrollRef}
                onScroll={onMessagesScroll}
                className="flex-1 overflow-y-auto p-4 space-y-3 bg-slate-50/50 min-h-0"
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
                          className={`max-w-[85%] rounded-2xl px-4 py-2 text-sm ${
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
                          ) : m.message_type === "document" || m.message_type === "video" ? (
                            <div className="space-y-2">
                              <div
                                className={`text-xs font-medium ${m.from_me ? "text-sky-100" : "text-slate-500"}`}
                              >
                                {m.message_type === "video" ? "Video" : "Documento"}
                              </div>
                              {attachUrl ? (
                                <a
                                  href={attachUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className={`inline-flex items-center gap-2 font-medium underline ${
                                    m.from_me ? "text-white" : "text-[#0EA5E9]"
                                  }`}
                                >
                                  <span className="text-lg" aria-hidden>
                                    {m.message_type === "video" ? "▶" : "📄"}
                                  </span>
                                  <span className="break-all">
                                    {erpName || metaDocName || "Abrir archivo"}
                                  </span>
                                </a>
                              ) : (
                                <p className="whitespace-pre-wrap break-words">
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
                className="p-3 border-t border-slate-200 bg-white flex flex-col gap-2"
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt"
                  onChange={(e) => void handleSendFile(e)}
                />
                {sendError && (
                  <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                    {sendError}
                  </div>
                )}
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={uploadingFile || !selectedId}
                    onClick={() => fileInputRef.current?.click()}
                    className="shrink-0 border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-50 px-3 py-2 rounded-lg text-sm font-medium"
                    title="Adjuntar imagen o documento"
                  >
                    {uploadingFile ? "…" : "Adjunto"}
                  </button>
                  <input
                    className="flex-1 border border-slate-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#0EA5E9]/30 focus:border-[#0EA5E9] outline-none"
                    placeholder="Escribí un mensaje…"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    disabled={sending}
                  />
                  <button
                    type="submit"
                    disabled={sending || !input.trim()}
                    className="bg-[#0EA5E9] hover:bg-[#0284C7] disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium shrink-0"
                  >
                    {sending ? "…" : "Enviar"}
                  </button>
                </div>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
