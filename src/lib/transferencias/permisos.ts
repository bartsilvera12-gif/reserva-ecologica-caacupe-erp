/**
 * Permisos del módulo de transferencias. Backend Y UI validan lo mismo.
 *
 * Reglas:
 *  - Todo usuario con sucursal puede: crear solicitudes (su sucursal = destino),
 *    ver las de su sucursal (origen o destino) y cancelar las pendientes propias.
 *  - admin / administrador / supervisor además: aprobar, rechazar, despachar
 *    (lado ORIGEN) y recibir (lado DESTINO).
 *  - Una sucursal solo ve/opera transferencias donde es origen o destino.
 */
export function esRolAprobador(rol: string | null | undefined): boolean {
  const r = (rol ?? "").trim().toLowerCase();
  return r === "admin" || r === "administrador" || r === "supervisor" || r === "super_admin";
}

/**
 * Confirmar la RECEPCIÓN en la sucursal destino. Además del rol aprobador
 * (admin/supervisor), lo puede hacer el rol operativo `usuario` (cajero/
 * repositor de la sucursal que recibe la mercadería). La ruta/UI ya restringen
 * la acción a la sucursal destino, así que no expone nada de otras sucursales.
 */
export function puedeRecibirTransferencia(rol: string | null | undefined): boolean {
  if (esRolAprobador(rol)) return true;
  return (rol ?? "").trim().toLowerCase() === "usuario";
}

export type LadoTransferencia = {
  estado: string;
  sucursal_origen_id: string;
  sucursal_destino_id: string;
};

/** ¿La sucursal del usuario participa en la transferencia? */
export function participa(lado: LadoTransferencia, sucursalId: string): boolean {
  return lado.sucursal_origen_id === sucursalId || lado.sucursal_destino_id === sucursalId;
}

export function esOrigen(lado: LadoTransferencia, sucursalId: string): boolean {
  return lado.sucursal_origen_id === sucursalId;
}

export function esDestino(lado: LadoTransferencia, sucursalId: string): boolean {
  return lado.sucursal_destino_id === sucursalId;
}
