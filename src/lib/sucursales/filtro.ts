/**
 * Filtro por sucursal para consultas PostgREST.
 *
 * REGLA CENTRAL: `sucursal_id === null` significa "no filtrar", NO "filtrar por
 * nulo". Un usuario sin sucursal asignada tiene que seguir viendo todo, igual
 * que antes de multi-sucursal. Si se tradujera un `null` a `.eq("sucursal_id",
 * null)` el usuario se quedaría con la pantalla vacía, que es exactamente el
 * modo de falla que hay que evitar en un sistema en producción.
 *
 * Usar SIEMPRE este helper en vez de un `.eq("sucursal_id", ...)` suelto, para
 * que el fallback quede en un solo lugar.
 */

/**
 * Aplica el filtro de sucursal si hay una definida; si no, devuelve la query intacta.
 *
 * `T` va sin restricción estructural a propósito: atarlo a `{ eq(...): T }` hace
 * que TypeScript intente expandir los tipos encadenados de PostgREST y falle con
 * "Type instantiation is excessively deep". El cast interno es seguro porque
 * todos los builders de PostgREST exponen `.eq()`.
 */
export function aplicarFiltroSucursal<T>(query: T, sucursalId: string | null | undefined): T {
  if (!sucursalId) return query;
  return (query as unknown as { eq(column: string, value: string): T }).eq(
    "sucursal_id",
    sucursalId
  );
}

/**
 * Sucursal a estampar al CREAR un registro. Puede ser `null` mientras haya
 * usuarios sin sucursal asignada: la columna es nullable justamente para eso.
 */
export function sucursalParaInsert(sucursalId: string | null | undefined): string | null {
  return sucursalId ?? null;
}
