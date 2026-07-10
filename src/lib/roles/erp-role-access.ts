/**
 * Matriz de acceso por rol ERP a nivel de UI.
 *
 * Roles del catalogo zentra_erp.usuarios.rol (normalizados en
 * lib/usuarios/erp-rol-normalize.ts):
 *   - administrador / admin: acceso total.
 *   - supervisor: todo menos el tab "Financiero" del dashboard principal.
 *   - usuario: acceso operativo minimo — Clientes, Presupuestos, Caja
 *     (ventas). Landing directa en /ventas cuando entra a "/".
 *
 * Notas:
 * - Este archivo solo define reglas de UI (sidebar + tabs). Los guards
 *   reales por endpoint viven en cada route.ts (multi-tenant + rol) o en
 *   el nuevo helper isAdminOnly usado por /api/dashboard/financial-audit.
 * - super_admin (rol de plataforma) mapea a admin para efectos de esta
 *   matriz.
 */
import { normalizeErpRolSlug } from "@/lib/usuarios/erp-rol-normalize";

/** Slugs que el rol `usuario` puede ver/usar. Todo lo demas se oculta. */
export const SLUGS_PERMITIDOS_ROL_USUARIO_LIMITADO: ReadonlySet<string> = new Set([
  // Caja / punto de venta.
  "ventas",
  // Cotizaciones comerciales.
  "presupuestos",
  // Alta y consulta de clientes.
  "clientes",
]);

/** Ruta a la que se redirige un `usuario` que entra a "/". */
export const LANDING_ROL_USUARIO_LIMITADO = "/ventas";

export function esAdminErp(rol: string | null | undefined): boolean {
  const r = normalizeErpRolSlug(rol);
  return r === "administrador" || r === "admin" || r === "super_admin";
}

export function esSupervisorErp(rol: string | null | undefined): boolean {
  return normalizeErpRolSlug(rol) === "supervisor";
}

/**
 * "usuario" literal del catalogo. NO incluye vendedor/comercial/asesor
 * (esos son otro dominio y no fueron parte del pedido de restricciones).
 */
export function esUsuarioLimitadoErp(rol: string | null | undefined): boolean {
  return normalizeErpRolSlug(rol) === "usuario";
}

/** El tab "Financiero" del dashboard solo lo ve el admin. */
export function puedeVerTabFinanciero(rol: string | null | undefined): boolean {
  return esAdminErp(rol);
}

/**
 * Item del sidebar visible para el rol. Devuelve true para admin y para
 * supervisor (que ve todo el menu igual que admin — el tab Financiero se
 * gatea aparte dentro del dashboard, no en el sidebar).
 * Para `usuario`, solo permite slugs del set permitido.
 */
export function puedeVerSidebarSlugPorRol(
  slug: string,
  rol: string | null | undefined
): boolean {
  if (esAdminErp(rol) || esSupervisorErp(rol)) return true;
  if (esUsuarioLimitadoErp(rol)) {
    return SLUGS_PERMITIDOS_ROL_USUARIO_LIMITADO.has(slug);
  }
  // Roles historicos (vendedor/asesor/etc) o desconocidos: no aplico gate
  // aqui — se rigen por el catalogo de modulos_activos existente.
  return true;
}
