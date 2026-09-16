/**
 * Guardia anti-duplicación previa al reenvío/envío de un DE a SET.
 *
 * Antes de reenviar, se consulta el CDC en SET (siConsDE, `consultarDePorCdc`).
 * Si SET ya reporta el DE como APROBADO, NO se debe reenviar: hacerlo generaría
 * un segundo DTE (o un rechazo por CDC duplicado). Esta función aísla la decisión
 * para poder testearla sin tocar la red.
 */
import type { ConsultaDeRespuesta } from "./consulta-de-por-cdc";

/**
 * Bloquea el reenvío SOLO cuando SET reporta el DE explícitamente como aprobado.
 * Un CDC "no encontrado" (0420) o cualquier otro veredicto NO bloquea: el envío
 * puede continuar con normalidad.
 */
export function debeBloquearReenvioPorDteAprobado(
  consulta: Pick<ConsultaDeRespuesta, "aprobado">
): boolean {
  return consulta.aprobado === true;
}
