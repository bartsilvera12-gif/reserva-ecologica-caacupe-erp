import { NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { CuentasError } from "@/lib/cuentas/server/cuentas-pg";
import { CajaError } from "@/lib/caja/server/caja-pg";

export type CuentasCtx = {
  empresaId: string;
  schema: string;
  sucursalId: string | null;
  usuarioId: string | null;
  usuarioNombre: string | null;
};

export function respError(err: unknown): NextResponse {
  if (err instanceof CuentasError || err instanceof CajaError) {
    return NextResponse.json(errorResponse(err.message), { status: err.status });
  }
  console.error("[api/cuentas]", err instanceof Error ? err.message : err);
  return NextResponse.json(errorResponse("No se pudo procesar la solicitud."), { status: 500 });
}

export async function resolverCtx(
  request: Request
): Promise<{ ok: true; ctx: CuentasCtx } | { ok: false; response: NextResponse }> {
  const t = await getTenantSupabaseFromAuth(request);
  if (!t) return { ok: false, response: NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 }) };
  const schema = await fetchDataSchemaForEmpresaId(t.auth.empresa_id);
  return {
    ok: true,
    ctx: {
      empresaId: t.auth.empresa_id,
      schema,
      sucursalId: t.auth.sucursal_id ?? null,
      usuarioId: t.auth.usuarioCatalogId ?? null,
      usuarioNombre: t.auth.user?.email ?? null,
    },
  };
}
