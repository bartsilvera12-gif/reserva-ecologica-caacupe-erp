import { NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { CajaError } from "@/lib/caja/server/caja-pg";

export type CajaCtx = {
  empresaId: string; sucursalId: string; schema: string;
  usuarioId: string | null; usuarioNombre: string | null;
};

export function respError(err: unknown): NextResponse {
  if (err instanceof CajaError) return NextResponse.json(errorResponse(err.message), { status: err.status });
  console.error("[api/caja]", err instanceof Error ? err.message : err);
  return NextResponse.json(errorResponse("No se pudo procesar la solicitud."), { status: 500 });
}

export async function resolverCtx(
  request: Request
): Promise<{ ok: true; ctx: CajaCtx } | { ok: false; response: NextResponse }> {
  const ctx = await getTenantSupabaseFromAuth(request);
  if (!ctx) return { ok: false, response: NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 }) };
  const sucursalId = ctx.auth.sucursal_id ?? null;
  if (!sucursalId) {
    return { ok: false, response: NextResponse.json(errorResponse("Tu usuario no tiene una sucursal asignada."), { status: 409 }) };
  }
  const schema = await fetchDataSchemaForEmpresaId(ctx.auth.empresa_id);
  return {
    ok: true,
    ctx: {
      empresaId: ctx.auth.empresa_id, sucursalId, schema,
      usuarioId: ctx.auth.usuarioCatalogId ?? null,
      usuarioNombre: ctx.auth.user?.email ?? null,
    },
  };
}
