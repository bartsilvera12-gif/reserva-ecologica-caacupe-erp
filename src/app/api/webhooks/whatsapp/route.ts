import { NextRequest } from "next/server";
import {
  handleWhatsAppWebhookGet,
  handleWhatsAppWebhookPost,
} from "@/lib/chat/webhooks/meta-whatsapp-webhook-handlers";

/**
 * GET: verificación pública Meta (sin auth). Excluido del middleware en `middleware.ts`.
 * POST: firma `X-Hub-Signature-256` si existe `WHATSAPP_APP_SECRET`.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return handleWhatsAppWebhookGet(request);
}

export async function POST(request: NextRequest) {
  return handleWhatsAppWebhookPost(request);
}
