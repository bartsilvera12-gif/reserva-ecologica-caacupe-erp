import { NextResponse } from "next/server";
import { getTenantSupabaseFromAuthWithRol } from "@/lib/supabase/tenant-api";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { NotaCreditoCompraError } from "@/lib/notas-credito-compra/server/nc-compra-pg";

export type NccCtx = {
  empresaId: string;
  sucursalId: string;
  schema: string;
  rol: string | null;
  usuarioId: string | null;
  usuarioNombre: string | null;
};

/** admin / administrador / supervisor / super_admin pueden crear y anular NC. */
export function esAprobador(rol: string | null | undefined): boolean {
  const r = (rol ?? "").trim().toLowerCase();
  return r === "admin" || r === "administrador" || r === "supervisor" || r === "super_admin";
}

/** Traduce errores de dominio a HTTP; el resto es 500 genérico. */
export function respError(err: unknown): NextResponse {
  if (err instanceof NotaCreditoCompraError) {
    return NextResponse.json(errorResponse(err.message), { status: err.status });
  }
  console.error("[api/notas-credito-compra]", err instanceof Error ? err.message : err);
  return NextResponse.json(errorResponse("No se pudo procesar la solicitud."), { status: 500 });
}

export function respProhibido(msg: string): NextResponse {
  return NextResponse.json(errorResponse(msg), { status: 403 });
}

/** Resuelve auth + sucursal + schema. Devuelve error listo si falta algo. */
export async function resolverCtx(
  request: Request
): Promise<{ ok: true; ctx: NccCtx } | { ok: false; response: NextResponse }> {
  const auth = await getTenantSupabaseFromAuthWithRol(request);
  if (!auth) {
    return { ok: false, response: NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 }) };
  }
  const sucursalId = auth.auth.sucursal_id ?? null;
  if (!sucursalId) {
    return {
      ok: false,
      response: NextResponse.json(
        errorResponse("Tu usuario no tiene una sucursal asignada. Pedile a un administrador que te asigne una."),
        { status: 409 }
      ),
    };
  }
  const schema = await fetchDataSchemaForEmpresaId(auth.auth.empresa_id);
  return {
    ok: true,
    ctx: {
      empresaId: auth.auth.empresa_id,
      sucursalId,
      schema,
      rol: auth.auth.rol ?? null,
      usuarioId: auth.auth.usuarioCatalogId ?? null,
      usuarioNombre: auth.auth.user?.email ?? null,
    },
  };
}
