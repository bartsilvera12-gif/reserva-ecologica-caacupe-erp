import type { User } from "@supabase/supabase-js";
import { resolveApiAuthContext } from "@/lib/middleware/api-auth-context";

export interface UsuarioConEmpresa {
  user: User;
  empresa_id: string;
}

export interface UsuarioConEmpresaYRol extends UsuarioConEmpresa {
  rol?: string;
  nombre?: string;
}

function esRolAdmin(rol?: string): boolean {
  return rol === "admin" || rol === "administrador" || rol === "super_admin";
}

/**
 * Obtiene el usuario autenticado, empresa_id y rol (para validación admin).
 * Usa JWT + RLS (sin depender de SUPABASE_SERVICE_ROLE_KEY).
 */
export async function getAuthWithRol(request?: Request | null): Promise<UsuarioConEmpresaYRol | null> {
  const r = await resolveApiAuthContext(request);
  if (!r.ok || !r.ctx.empresa_id) return null;

  return {
    user: r.ctx.user,
    empresa_id: r.ctx.empresa_id,
    rol: r.ctx.usuarioRol ?? undefined,
    nombre: r.ctx.usuarioNombre ?? undefined,
  };
}

export function isAdmin(auth: UsuarioConEmpresaYRol | null): boolean {
  return !!auth && esRolAdmin(auth.rol);
}

/**
 * Obtiene el usuario autenticado y su empresa_id.
 * Requerido para todas las rutas API multiempresa.
 * No exige SUPABASE_SERVICE_ROLE_KEY: usa anon + sesión (cookies o Bearer) y RLS.
 */
export async function getUserAndEmpresa(request?: Request | null): Promise<UsuarioConEmpresa | null> {
  const r = await resolveApiAuthContext(request);
  if (!r.ok || !r.ctx.empresa_id) return null;
  return {
    user: r.ctx.user,
    empresa_id: r.ctx.empresa_id,
  };
}
