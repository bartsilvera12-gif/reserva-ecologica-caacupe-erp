import { NextResponse } from "next/server";
import { getTenantSupabaseFromAuthWithRol } from "@/lib/supabase/tenant-api";
import { errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { puedeEditarRecetas } from "@/lib/roles/erp-role-access";
import type { UsuarioConEmpresaYRol } from "@/lib/middleware/auth";
import type { AppSupabaseClient } from "@/lib/supabase/schema";

export const MSG_RECETAS_SOLO_ADMIN_SUPERVISOR =
  "Solo un administrador o supervisor puede modificar el recetario. Podés fabricar desde una receta existente.";

type Ctx = { auth: UsuarioConEmpresaYRol; supabase: AppSupabaseClient };

/**
 * Guard de servidor para MUTAR el recetario (crear/editar/eliminar recetas e
 * insumos): solo admin y supervisor.
 *
 * No usar para FABRICAR (`POST /api/producciones`): fabricar es una operación
 * de planta habilitada para todos los roles. Tampoco para los GET, que deben
 * seguir abiertos porque cualquier usuario necesita leer la receta para fabricar.
 *
 * Ocultar los botones en la UI no alcanza: sin este guard, un `usuario` podía
 * editar el recetario llamando la API directamente.
 */
export async function requireEdicionRecetas(
  request: Request
): Promise<{ ok: true; ctx: Ctx } | { ok: false; response: NextResponse }> {
  const ctx = await getTenantSupabaseFromAuthWithRol(request);
  if (!ctx) {
    return {
      ok: false,
      response: NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 }),
    };
  }
  if (!puedeEditarRecetas(ctx.auth.rol)) {
    return {
      ok: false,
      response: NextResponse.json(errorResponse(MSG_RECETAS_SOLO_ADMIN_SUPERVISOR), { status: 403 }),
    };
  }
  return { ok: true, ctx };
}
