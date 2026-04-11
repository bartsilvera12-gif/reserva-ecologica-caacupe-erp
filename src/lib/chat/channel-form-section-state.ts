/**
 * Estado visual de secciones del formulario de canal (expandir + switch “activo”).
 * Persistido en `chat_channels.config.form_section_state`.
 */

export const CHANNEL_FORM_SECTION_KEYS = [
  "credentials",
  "business_automation",
  "comprobantes_core",
  "comprobantes_bank",
  "comprobantes_messages",
] as const;

export type ChannelFormSectionKey = (typeof CHANNEL_FORM_SECTION_KEYS)[number];

export type ChannelFormSectionSlice = {
  active: boolean;
  expanded: boolean;
};

export type ChannelFormSectionStateMap = Record<ChannelFormSectionKey, ChannelFormSectionSlice>;

export function defaultChannelFormSectionState(): ChannelFormSectionStateMap {
  return {
    credentials: { active: true, expanded: true },
    business_automation: { active: true, expanded: false },
    comprobantes_core: { active: true, expanded: false },
    comprobantes_bank: { active: true, expanded: false },
    comprobantes_messages: { active: true, expanded: false },
  };
}

export function parseFormSectionStateFromChannelConfig(config: unknown): ChannelFormSectionStateMap {
  const out = defaultChannelFormSectionState();
  if (!config || typeof config !== "object" || Array.isArray(config)) return out;
  const raw = (config as Record<string, unknown>).form_section_state;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  for (const key of CHANNEL_FORM_SECTION_KEYS) {
    const slice = r[key];
    if (!slice || typeof slice !== "object" || Array.isArray(slice)) continue;
    const o = slice as Record<string, unknown>;
    const b = out[key];
    out[key] = {
      active: typeof o.active === "boolean" ? o.active : b.active,
      expanded: typeof o.expanded === "boolean" ? o.expanded : b.expanded,
    };
  }
  return out;
}

export function formSectionStateForPersistence(
  state: ChannelFormSectionStateMap
): Record<string, { active: boolean; expanded: boolean }> {
  const o: Record<string, { active: boolean; expanded: boolean }> = {};
  for (const key of CHANNEL_FORM_SECTION_KEYS) {
    o[key] = { active: state[key].active, expanded: state[key].expanded };
  }
  return o;
}
