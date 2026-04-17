import { NextRequest } from "next/server";
import { handleWhatsAppWebhookPost } from "@/lib/chat/webhooks/meta-whatsapp-webhook-handlers";

/**
 * GET: verificación webhook Meta — texto plano, solo `hub.challenge` (200).
 * POST: firma `X-Hub-Signature-256` si existe `WHATSAPP_APP_SECRET`.
 */

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return new Response(challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  return new Response("Forbidden", { status: 403 });
}

export async function POST(request: NextRequest) {
  return handleWhatsAppWebhookPost(request);
}
