import "server-only";
import type { NormalizedTemplateRow } from "@/lib/campaigns/providers/types";

function extractSlots(text: string | undefined): string[] {
  if (!text) return [];
  const re = /\{\{(\d+)\}\}/g;
  const slots: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) slots.push(m[1]);
  return [...new Set(slots)].sort((a, b) => Number(a) - Number(b));
}

/**
 * Lista plantillas desde YCloud. Intenta varios paths por compatibilidad de versión API.
 */
export async function fetchYCloudApprovedTemplates(params: {
  apiKey: string;
  wabaId: string;
}): Promise<NormalizedTemplateRow[]> {
  const key = params.apiKey.trim();
  const waba = params.wabaId.trim();
  if (!key || !waba) return [];

  const candidates = [
    `https://api.ycloud.com/v2/whatsapp/wabas/${encodeURIComponent(waba)}/messageTemplates`,
    `https://api.ycloud.com/v2/whatsapp/wabas/${encodeURIComponent(waba)}/templates`,
  ];

  let lastErr: string | null = null;
  for (const url of candidates) {
    const res = await fetch(url, {
      method: "GET",
      headers: { "X-API-Key": key, Accept: "application/json" },
    });
    const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      lastErr =
        typeof raw.message === "string"
          ? raw.message
          : typeof (raw.error as { message?: string } | undefined)?.message === "string"
            ? String((raw.error as { message?: string }).message)
            : `HTTP ${res.status}`;
      continue;
    }

    const rows = Array.isArray(raw.data)
      ? (raw.data as Record<string, unknown>[])
      : Array.isArray(raw.records)
        ? (raw.records as Record<string, unknown>[])
        : Array.isArray(raw.items)
          ? (raw.items as Record<string, unknown>[])
          : raw.data && typeof raw.data === "object"
            ? Object.values(raw.data as Record<string, unknown>)
            : [];

    const out: NormalizedTemplateRow[] = [];
    for (const raw of rows) {
      const t = raw as Record<string, unknown>;
      const name = typeof t.name === "string" ? t.name.trim() : "";
      if (!name) continue;
      const language =
        typeof t.language === "string"
          ? t.language.trim()
          : typeof (t as { languageCode?: string }).languageCode === "string"
            ? String((t as { languageCode?: string }).languageCode).trim()
            : "en";
      const status = String(t.status ?? t["approvalStatus"] ?? "").trim().toUpperCase();
      if (status && status !== "APPROVED") continue;

      const comps = Array.isArray(t.components) ? (t.components as { type?: string; text?: string }[]) : [];
      const body = comps.find((c) => String(c.type ?? "").toUpperCase() === "BODY");
      const variable_schema_json = { kind: "ycloud", body_slots: extractSlots(body?.text) };

      out.push({
        provider_template_id: typeof t.id === "string" ? t.id : null,
        name,
        language,
        category: typeof t.category === "string" ? t.category : null,
        status: "APPROVED",
        components_json: comps as unknown[],
        variable_schema_json,
        provider_payload_json: { source: "ycloud_api", raw_id: t.id },
      });
    }
    if (out.length > 0 || res.ok) return out;
  }

  if (lastErr) {
    console.warn("[ycloud-campaign-provider] templates_unavailable", { hint: lastErr });
  }
  return [];
}
