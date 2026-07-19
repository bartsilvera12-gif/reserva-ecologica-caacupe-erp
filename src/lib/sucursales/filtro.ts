/**
 * Filtro por sucursal para consultas PostgREST.
 *
 * MODELO (definido por el cliente): cada usuario pertenece a UNA sucursal y ve
 * únicamente lo de esa sucursal. Aplica a todos los roles, admin incluido — el
 * admin de Reserva Market no ve nada de Casa Matriz y viceversa. No hay
 * selector de sucursal ni vista consolidada.
 *
 * Por eso un usuario SIN sucursal asignada es una MISCONFIGURACIÓN, no un caso
 * válido. Antes esto devolvía "no filtrar" para no dejar a nadie con la pantalla
 * vacía, pero bajo este modelo eso significa que un usuario mal configurado ve
 * los datos de TODAS las sucursales — una fuga es peor que una pantalla vacía.
 *
 * Ahora `exigirSucursal` falla de forma explícita y con un mensaje accionable,
 * en vez de degradar en silencio hacia cualquiera de los dos extremos.
 */

/** Error de configuración: el usuario no tiene sucursal asignada. */
export class SucursalNoAsignadaError extends Error {
  constructor() {
    super(
      "Tu usuario no tiene una sucursal asignada. Pedile a un administrador que te asigne una desde Usuarios."
    );
    this.name = "SucursalNoAsignadaError";
  }
}

/**
 * Devuelve la sucursal del usuario o lanza si no tiene.
 * Usar en todo endpoint que lea o escriba datos de una sucursal.
 */
export function exigirSucursal(sucursalId: string | null | undefined): string {
  if (!sucursalId) throw new SucursalNoAsignadaError();
  return sucursalId;
}

/**
 * Aplica el filtro de sucursal. Requiere una sucursal válida: pasá el resultado
 * de `exigirSucursal`.
 *
 * `T` va sin restricción estructural a propósito: atarlo a `{ eq(...): T }` hace
 * que TypeScript intente expandir los tipos encadenados de PostgREST y falle con
 * "Type instantiation is excessively deep". El cast interno es seguro porque
 * todos los builders de PostgREST exponen `.eq()`.
 */
export function aplicarFiltroSucursal<T>(query: T, sucursalId: string): T {
  return (query as unknown as { eq(column: string, value: string): T }).eq(
    "sucursal_id",
    sucursalId
  );
}

/**
 * Traduce `SucursalNoAsignadaError` a una respuesta HTTP clara.
 * Devuelve `null` si el error es otro, para que el caller siga con su manejo normal.
 *
 * 409 y no 500: no es una falla del servidor sino un dato faltante que un
 * administrador puede corregir, y el mensaje se le muestra tal cual al usuario.
 */
export function respuestaSucursalNoAsignada(err: unknown): Response | null {
  if (!(err instanceof SucursalNoAsignadaError)) return null;
  return Response.json({ ok: false, error: err.message }, { status: 409 });
}
