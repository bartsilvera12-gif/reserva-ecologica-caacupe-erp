import "server-only";
import { extractBodyVariableSlotsOrdered } from "@/lib/campaigns/campaign-template-payload";

/** Normaliza claves de mapeo ("{{1}}" → "1"). */
export function normalizeVariableMapping(input: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    const slot = k.replace(/^\{\{|\}\}$/g, "").trim();
    out[slot] = String(v ?? "").trim();
  }
  return out;
}

export function buildMappedVariablesFromRow(
  row: Record<string, string>,
  mapping: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [slot, header] of Object.entries(mapping)) {
    const key = slot.replace(/^\{\{|\}\}$/g, "").trim();
    const val = row[header];
    out[key] = val != null ? String(val).trim() : "";
  }
  return out;
}

export function mappingSatisfiedForTemplate(
  templateComponentsJson: unknown[],
  mapped: Record<string, string>
): boolean {
  const slots = extractBodyVariableSlotsOrdered(templateComponentsJson);
  if (slots.length === 0) return true;
  return slots.every((s) => String(mapped[s] ?? "").trim().length > 0);
}
