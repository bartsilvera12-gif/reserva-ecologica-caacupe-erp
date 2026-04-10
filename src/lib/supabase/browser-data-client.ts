import { createBrowserClient } from "@supabase/ssr";
import { supabaseDbSchemaOption } from "@/lib/supabase/schema";

const SCHEMA_KEY = "neura_erp_data_schema_v1";
const SCHEMA_TS_KEY = "neura_erp_data_schema_ts_v1";
const TTL_MS = 120_000;

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "placeholder-key";

/**
 * Cliente browser para tablas de negocio (respeta `empresas.data_schema` vía API).
 * El catálogo (usuarios, módulos) sigue en `zentra_erp` con el cliente de `@/lib/supabase`.
 */
export async function getBrowserSupabaseForEmpresaData() {
  if (typeof window === "undefined") {
    throw new Error("getBrowserSupabaseForEmpresaData solo está disponible en el cliente");
  }

  const now = Date.now();
  const cached = sessionStorage.getItem(SCHEMA_KEY);
  const ts = Number(sessionStorage.getItem(SCHEMA_TS_KEY) || "0");
  if (cached && now - ts < TTL_MS) {
    return createBrowserClient(supabaseUrl, supabaseAnonKey, {
      ...supabaseDbSchemaOption,
      db: { schema: cached },
    });
  }

  const res = await fetch("/api/empresas/data-schema", { credentials: "include", cache: "no-store" });
  if (!res.ok) {
    throw new Error("No se pudo resolver el schema de datos de la empresa");
  }
  const body = (await res.json()) as { schema?: string };
  const schema = typeof body.schema === "string" && body.schema.trim() ? body.schema.trim() : "zentra_erp";

  sessionStorage.setItem(SCHEMA_KEY, schema);
  sessionStorage.setItem(SCHEMA_TS_KEY, String(now));

  return createBrowserClient(supabaseUrl, supabaseAnonKey, {
    ...supabaseDbSchemaOption,
    db: { schema },
  });
}

export function clearBrowserEmpresaDataSchemaCache(): void {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(SCHEMA_KEY);
  sessionStorage.removeItem(SCHEMA_TS_KEY);
}
