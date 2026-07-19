/**
 * Filtro de sucursal para las capas que arman SQL crudo (reportes-pg, el
 * fallback PG del dashboard), donde no hay query builder de PostgREST.
 *
 * POR QUÉ SE EMBEBE EL VALOR EN VEZ DE USAR UN PARÁMETRO:
 * esas consultas tienen distinta cantidad de parámetros posicionales cada una
 * ($1..$3, $1..$4, etc.). Agregar un `$N` obliga a renumerar y a mantener
 * alineado el array de argumentos consulta por consulta — exactamente el tipo
 * de cambio manual donde un desalineado silencioso produce datos incorrectos
 * en vez de un error.
 *
 * Embeber es seguro AQUÍ y SOLO aquí porque el valor se valida antes como UUID
 * canónico: si no matchea el formato exacto, se lanza y no se arma ningún SQL.
 * Un UUID validado no puede contener comillas ni ningún carácter de escape.
 *
 * NO usar esta función con datos que vengan del usuario. `sucursalId` viene de
 * `usuarios.sucursal_predeterminada_id`, resuelto en el servidor.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Valida el UUID y devuelve el literal SQL listo para concatenar. */
export function sucursalUuidLiteral(sucursalId: string): string {
  if (!UUID_RE.test(sucursalId)) {
    throw new Error("sucursal_id inválido: se esperaba un UUID canónico.");
  }
  return `'${sucursalId}'::uuid`;
}

/**
 * Fragmento ` AND <prefijo>sucursal_id = '<uuid>'::uuid` para pegar dentro de
 * un WHERE existente.
 *
 * @param sucursalId UUID de la sucursal (validado).
 * @param prefijo    Alias de tabla con punto, p.ej. `"v."`. Vacío si no hay alias.
 */
export function andSucursal(sucursalId: string, prefijo = ""): string {
  return ` AND ${prefijo}sucursal_id = ${sucursalUuidLiteral(sucursalId)}`;
}
