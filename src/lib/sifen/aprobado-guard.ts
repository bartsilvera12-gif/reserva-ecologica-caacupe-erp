/**
 * Guardia definitiva anti-duplicación: una factura electrónica que YA fue
 * aprobada por SET no puede regenerarse ni reenviarse.
 *
 * Reemitir un documento aprobado genera un duplicado que SET rechaza con el
 * código 1002 "Documento electrónico duplicado", y deja el DTE válido huérfano
 * en el ERP (evidencia: FAC-000080 de la reserva, regenerada 4 veces sobre un
 * documento ya aprobado). El chequeo va en el BACKEND (no alcanza con ocultar
 * botones): tanto `POST /sifen/xml` (regenerar) como `POST /sifen/enviar`
 * (reenviar) deben rechazar la operación.
 *
 * Se considera "ya aprobada" cuando:
 *   - `sifen_aprobado_at` tiene valor (fue aprobada alguna vez, aunque una
 *     regeneración posterior haya movido el estado a rechazado/error_envio), o
 *   - el estado fiscal actual es `aprobado`.
 *
 * NO toca el CDC ni sobrescribe datos del DTE aprobado: sólo bloquea la acción.
 * La recuperación del documento aprobado ("Recuperar documento aprobado (SET)")
 * usa otro endpoint y no pasa por esta guardia.
 */
export const MSG_DOC_APROBADO =
  "Este documento ya fue aprobado por SET y no puede regenerarse ni reenviarse. Utilice el documento aprobado existente.";

export interface FacturaElectronicaAprobadaCheck {
  sifen_aprobado_at?: unknown;
  estado_sifen?: unknown;
}

/**
 * true si la factura electrónica ya fue aprobada por SET (por timestamp de
 * aprobación o por estado fiscal actual). Pura y sin efectos: se testea directo.
 */
export function facturaElectronicaYaAprobada(row: FacturaElectronicaAprobadaCheck | null | undefined): boolean {
  if (!row) return false;
  const aprobadoAt = row.sifen_aprobado_at;
  const tieneAprobadoAt = aprobadoAt != null && String(aprobadoAt).trim() !== "";
  const estado = String(row.estado_sifen ?? "").trim().toLowerCase();
  return tieneAprobadoAt || estado === "aprobado";
}
