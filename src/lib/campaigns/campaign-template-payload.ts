/**
 * Construye payload `template` para Meta Cloud API / YCloud a partir del snapshot de plantilla y variables por slot ({{1}}, {{2}}, …).
 */

export function extractBodyVariableSlotsOrdered(componentsJson: unknown[]): string[] {
  const comps = Array.isArray(componentsJson)
    ? (componentsJson as { type?: string; text?: string }[])
    : [];
  const body = comps.find((c) => String(c.type ?? "").toUpperCase() === "BODY");
  const text = body?.text ?? "";
  const re = /\{\{(\d+)\}\}/g;
  const ordered: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const slot = m[1];
    if (!seen.has(slot)) {
      seen.add(slot);
      ordered.push(slot);
    }
  }
  return ordered.sort((a, b) => Number(a) - Number(b));
}

/** `mappedBySlot`: claves "1","2" → texto final para cada {{n}} */
export function buildMetaCloudTemplatePayload(params: {
  templateName: string;
  languageCode: string;
  componentsSnapshot: unknown[];
  mappedBySlot: Record<string, string>;
}): Record<string, unknown> {
  const slots = extractBodyVariableSlotsOrdered(params.componentsSnapshot);
  const parameters = slots.map((slot) => ({
    type: "text",
    text: String(params.mappedBySlot[slot] ?? "").slice(0, 4096),
  }));

  const template: Record<string, unknown> = {
    name: params.templateName,
    language: { code: params.languageCode },
  };

  if (parameters.length > 0) {
    template.components = [{ type: "body", parameters }];
  }

  return template;
}
