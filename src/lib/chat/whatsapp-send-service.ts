/**
 * Envío vía WhatsApp Cloud API (Graph)
 */
export type SendWhatsAppTextParams = {
  toDigits: string;
  text: string;
  phoneNumberId: string;
  accessToken: string;
  graphVersion?: string;
};

export type SendWhatsAppTextResult =
  | { ok: true; waMessageId: string | null; raw: unknown }
  | { ok: false; error: string; status?: number; raw?: unknown };

export type SendWhatsAppButtonsParams = {
  toDigits: string;
  phoneNumberId: string;
  accessToken: string;
  bodyText: string;
  buttons: Array<{
    id: string;
    title: string;
  }>;
  graphVersion?: string;
};

export type SendWhatsAppImageParams = {
  toDigits: string;
  phoneNumberId: string;
  accessToken: string;
  imageUrl: string;
  caption?: string;
  graphVersion?: string;
};

export type SendWhatsAppDocumentParams = {
  toDigits: string;
  phoneNumberId: string;
  accessToken: string;
  /** URL HTTPS pública (p. ej. Supabase Storage). */
  link: string;
  filename: string;
  caption?: string;
  graphVersion?: string;
};

export type SendWhatsAppAudioParams = {
  toDigits: string;
  phoneNumberId: string;
  accessToken: string;
  /** URL HTTPS pública del audio (ogg/opus, mpeg, etc.). */
  audioUrl: string;
  graphVersion?: string;
};

async function sendWhatsAppPayload(
  params: {
    phoneNumberId: string;
    accessToken: string;
    graphVersion?: string;
  },
  body: Record<string, unknown>
): Promise<SendWhatsAppTextResult> {
  const v = params.graphVersion ?? process.env.WHATSAPP_GRAPH_VERSION ?? "v19.0";
  const url = `https://graph.facebook.com/${v}/${params.phoneNumberId}/messages`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const errMsg =
      typeof raw.error === "object" && raw.error && "message" in (raw.error as object)
        ? String((raw.error as { message?: string }).message)
        : res.statusText;
    return {
      ok: false,
      error: errMsg || `HTTP ${res.status}`,
      status: res.status,
      raw,
    };
  }
  const messages = raw.messages as Array<{ id?: string }> | undefined;
  const waMessageId = messages?.[0]?.id ?? null;
  return { ok: true, waMessageId, raw };
}

export async function sendWhatsAppText(
  params: SendWhatsAppTextParams
): Promise<SendWhatsAppTextResult> {
  return sendWhatsAppPayload(params, {
    messaging_product: "whatsapp",
    to: params.toDigits,
    type: "text",
    text: { body: params.text },
  });
}

export async function sendWhatsAppInteractiveButtons(
  params: SendWhatsAppButtonsParams
): Promise<SendWhatsAppTextResult> {
  const buttons = params.buttons.slice(0, 3).map((b) => ({
    type: "reply",
    reply: { id: b.id, title: b.title.slice(0, 20) },
  }));

  if (buttons.length === 0) {
    return { ok: false, error: "No hay botones para enviar" };
  }

  return sendWhatsAppPayload(params, {
    messaging_product: "whatsapp",
    to: params.toDigits,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: params.bodyText.slice(0, 1024) },
      action: { buttons },
    },
  });
}

export async function sendWhatsAppImage(
  params: SendWhatsAppImageParams
): Promise<SendWhatsAppTextResult> {
  return sendWhatsAppPayload(params, {
    messaging_product: "whatsapp",
    to: params.toDigits,
    type: "image",
    image: {
      link: params.imageUrl,
      ...(params.caption ? { caption: params.caption.slice(0, 1024) } : {}),
    },
  });
}

export async function sendWhatsAppAudio(params: SendWhatsAppAudioParams): Promise<SendWhatsAppTextResult> {
  return sendWhatsAppPayload(params, {
    messaging_product: "whatsapp",
    to: params.toDigits,
    type: "audio",
    audio: { link: params.audioUrl },
  });
}

export type SendWhatsAppVideoParams = {
  toDigits: string;
  phoneNumberId: string;
  accessToken: string;
  videoUrl: string;
  caption?: string;
  graphVersion?: string;
};

export async function sendWhatsAppVideo(params: SendWhatsAppVideoParams): Promise<SendWhatsAppTextResult> {
  return sendWhatsAppPayload(params, {
    messaging_product: "whatsapp",
    to: params.toDigits,
    type: "video",
    video: {
      link: params.videoUrl,
      ...(params.caption ? { caption: params.caption.slice(0, 1024) } : {}),
    },
  });
}

export async function sendWhatsAppDocument(
  params: SendWhatsAppDocumentParams
): Promise<SendWhatsAppTextResult> {
  const fn = params.filename.trim() || "documento";
  const body: Record<string, unknown> = {
    messaging_product: "whatsapp",
    to: params.toDigits,
    type: "document",
    document: {
      link: params.link,
      filename: fn.slice(0, 240),
    },
  };
  const doc = (body.document as Record<string, unknown>);
  if (params.caption?.trim()) doc.caption = params.caption.trim().slice(0, 1024);
  return sendWhatsAppPayload(params, body);
}
