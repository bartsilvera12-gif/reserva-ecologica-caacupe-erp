import { NextResponse } from "next/server";
import { getTenantSupabaseFromAuthWithRol } from "@/lib/supabase/tenant-api";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { OrdenCompraError } from "@/lib/ordenes-compra/server/oc-pg";

export type OcCtx = {
  empresaId: string; sucursalId: string; schema: string; rol: string | null;
  usuarioId: string | null; usuarioNombre: string | null;
};

export function esAprobador(rol: string | null | undefined): boolean {
  const r = (rol ?? "").trim().toLowerCase();
  return r === "admin" || r === "administrador" || r === "supervisor" || r === "super_admin";
}

export function respError(err: unknown): NextResponse {
  if (err instanceof OrdenCompraError) return NextResponse.json(errorResponse(err.message), { status: err.status });
  console.error("[api/ordenes-compra]", err instanceof Error ? err.message : err);
  return NextResponse.json(errorResponse("No se pudo procesar la solicitud."), { status: 500 });
}

export async function resolverCtx(
  request: Request
): Promise<{ ok: true; ctx: OcCtx } | { ok: false; response: NextResponse }> {
  const auth = await getTenantSupabaseFromAuthWithRol(request);
  if (!auth) return { ok: false, response: NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 }) };
  const sucursalId = auth.auth.sucursal_id ?? null;
  if (!sucursalId) {
    return { ok: false, response: NextResponse.json(errorResponse("Tu usuario no tiene una sucursal asignada."), { status: 409 }) };
  }
  const schema = await fetchDataSchemaForEmpresaId(auth.auth.empresa_id);
  return {
    ok: true,
    ctx: {
      empresaId: auth.auth.empresa_id, sucursalId, schema,
      rol: auth.auth.rol ?? null,
      usuarioId: auth.auth.usuarioCatalogId ?? null,
      usuarioNombre: auth.auth.user?.email ?? null,
    },
  };
}
