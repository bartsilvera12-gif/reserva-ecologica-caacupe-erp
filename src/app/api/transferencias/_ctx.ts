import { NextResponse } from "next/server";
import { getTenantSupabaseFromAuthWithRol } from "@/lib/supabase/tenant-api";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import type { LadoTransferencia } from "@/lib/transferencias/permisos";
import { TransferenciaError } from "@/lib/transferencias/server/transferencias-pg";

/** Traduce errores de dominio a respuestas HTTP; el resto es 500 genérico. */
export function respError(err: unknown): NextResponse {
  if (err instanceof TransferenciaError) {
    return NextResponse.json(errorResponse(err.message), { status: err.status });
  }
  console.error("[api/transferencias]", err instanceof Error ? err.message : err);
  return NextResponse.json(errorResponse("No se pudo procesar la solicitud."), { status: 500 });
}

/** 403 estándar para acciones no permitidas al rol o sucursal. */
export function respProhibido(msg: string): NextResponse {
  return NextResponse.json(errorResponse(msg), { status: 403 });
}

/** Contexto resuelto para las rutas de transferencias. */
export type TransfCtx = {
  empresaId: string;
  sucursalId: string;
  schema: string;
  rol: string | null;
  usuarioId: string | null;
  usuarioNombre: string | null;
};

/**
 * Resuelve auth + sucursal + schema. Devuelve una respuesta de error lista si
 * algo falta (401 sin sesión, 409 sin sucursal asignada).
 */
export async function resolverCtx(
  request: Request
): Promise<{ ok: true; ctx: TransfCtx } | { ok: false; response: NextResponse }> {
  const auth = await getTenantSupabaseFromAuthWithRol(request);
  if (!auth) {
    return { ok: false, response: NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 }) };
  }
  const sucursalId = auth.auth.sucursal_id ?? null;
  if (!sucursalId) {
    // 409: dato faltante que un admin corrige (mismo criterio que el resto del ERP).
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

/** Carga origen/destino/estado de una transferencia para chequear permisos. null si no existe o no es de la empresa. */
export async function cargarLado(
  schemaRaw: string,
  empresaId: string,
  transferenciaId: string
): Promise<LadoTransferencia | null> {
  const p = getChatPostgresPool();
  if (!p) throw new Error("Pool PG no disponible.");
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const t = quoteSchemaTable(schema, "transferencias_inventario");
  const { rows } = await p.query(
    `SELECT estado, sucursal_origen_id, sucursal_destino_id FROM ${t}
      WHERE id = $1::uuid AND empresa_id = $2::uuid`,
    [transferenciaId, empresaId]
  );
  return rows[0] ?? null;
}
