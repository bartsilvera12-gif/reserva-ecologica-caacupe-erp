import "server-only";
import type { SupabaseAdmin } from "@/lib/chat/types";
import { normalizeWaPhone } from "@/lib/chat/wa-phone";
import { digitsInternational } from "@/lib/campaigns/campaign-phone";

/**
 * Tras un inbound real del contacto: marca el recipient de campaña más reciente (mismo canal/teléfono)
 * si aún estaba en `sent` y sin respuesta. Idempotente por `first_reply_at`.
 */
export async function markCampaignReplyFromInbound(params: {
  supabase: SupabaseAdmin;
  empresaId: string;
  channelId: string;
  contactId: string;
}): Promise<void> {
  const { supabase, empresaId, channelId, contactId } = params;

  const { data: contact, error: cErr } = await supabase
    .from("chat_contacts")
    .select("phone_number")
    .eq("id", contactId)
    .eq("empresa_id", empresaId)
    .maybeSingle();

  if (cErr || !contact) return;

  const phoneDigits = normalizeWaPhone((contact as { phone_number?: string }).phone_number ?? "");
  if (!phoneDigits) return;

  const { data: campaigns, error: campErr } = await supabase
    .from("chat_campaigns")
    .select("id")
    .eq("empresa_id", empresaId)
    .eq("channel_id", channelId);

  if (campErr || !campaigns?.length) return;

  const campaignIds = (campaigns as { id: string }[]).map((c) => c.id);

  const { data: rows, error: rErr } = await supabase
    .from("chat_campaign_recipients")
    .select("id, campaign_id, status, first_reply_at, phone_e164, sent_at")
    .eq("empresa_id", empresaId)
    .in("campaign_id", campaignIds)
    .eq("status", "sent")
    .is("first_reply_at", null)
    .order("sent_at", { ascending: false })
    .limit(50);

  if (rErr || !rows?.length) return;

  type Row = {
    id: string;
    campaign_id: string;
    phone_e164: string;
  };

  const match = (rows as unknown as Row[]).find((r) => {
    const d = normalizeWaPhone(digitsInternational(r.phone_e164));
    return d === phoneDigits;
  });

  if (!match) return;

  const ts = new Date().toISOString();

  const { error: upErr } = await supabase
    .from("chat_campaign_recipients")
    .update({
      status: "replied",
      first_reply_at: ts,
      updated_at: ts,
    })
    .eq("id", match.id)
    .eq("empresa_id", empresaId)
    .is("first_reply_at", null);

  if (upErr) {
    console.warn("[campaign-inbound]", upErr.message);
    return;
  }

  await supabase.from("chat_campaign_events").insert({
    empresa_id: empresaId,
    campaign_id: match.campaign_id,
    recipient_id: match.id,
    event_type: "inbound_reply",
    event_payload_json: { contact_id: contactId, channel_id: channelId },
  });

  const { data: camp } = await supabase
    .from("chat_campaigns")
    .select("replied_count")
    .eq("id", match.campaign_id)
    .eq("empresa_id", empresaId)
    .maybeSingle();

  const rc = (camp as { replied_count?: number } | null)?.replied_count ?? 0;
  await supabase
    .from("chat_campaigns")
    .update({
      replied_count: rc + 1,
      updated_at: ts,
    })
    .eq("id", match.campaign_id)
    .eq("empresa_id", empresaId);
}
