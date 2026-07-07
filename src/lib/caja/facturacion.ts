/**
 * Lógica reutilizable: estado de facturación de un pedido (proyecto tipo 'pedido').
 *
 * Se persiste dentro de `proyectos.metadata` (JSONB) para no requerir tablas nuevas.
 * Estados:
 *   - sin marca            → el pedido aún no fue enviado a Caja.
 *   - 'pendiente_caja'     → enviado a Caja, esperando cobro/facturación. NO descuenta stock.
 *   - 'facturado'          → Caja confirmó la venta. Tiene venta_id. NO se puede facturar de nuevo.
 *
 * Pensado para ser reutilizable por otras instancias: la forma es genérica.
 */

export type FacturacionEstado = "pendiente_caja" | "facturado" | "cancelado_caja";

export interface FacturacionMeta {
  facturacion_estado?: FacturacionEstado;
  enviado_a_caja_at?: string;
  facturado_at?: string;
  venta_id?: string;
  venta_numero?: string;
  cancelado_caja_at?: string;
  cancelado_caja_by?: string | null;
}

/** Metadata genérica de un proyecto (incluye trazabilidad de origen + facturación). */
export type ProyectoMetadata = Record<string, unknown> & FacturacionMeta;

export function asMetadataObject(raw: unknown): ProyectoMetadata {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? ({ ...(raw as Record<string, unknown>) } as ProyectoMetadata)
    : {};
}

export function getFacturacionEstado(metadata: unknown): FacturacionEstado | null {
  const m = asMetadataObject(metadata);
  return m.facturacion_estado === "pendiente_caja" ||
    m.facturacion_estado === "facturado" ||
    m.facturacion_estado === "cancelado_caja"
    ? m.facturacion_estado
    : null;
}

export function estaFacturado(metadata: unknown): boolean {
  return getFacturacionEstado(metadata) === "facturado";
}

export function estaPendienteCaja(metadata: unknown): boolean {
  return getFacturacionEstado(metadata) === "pendiente_caja";
}

/** Devuelve la metadata mergeada para marcar el pedido como enviado a Caja. */
export function marcarEnviadoACaja(metadata: unknown, nowIso: string): ProyectoMetadata {
  return {
    ...asMetadataObject(metadata),
    facturacion_estado: "pendiente_caja",
    enviado_a_caja_at: nowIso,
  };
}

/**
 * Devuelve la metadata "quitada de caja": limpia `facturacion_estado`,
 * `enviado_a_caja_at` y deja rastro de auditoría de cuándo/quién lo canceló.
 *
 * Deja el pedido en estado "nunca enviado a caja" para que la vista del proyecto
 * vuelva a mostrar el botón "Enviar a Caja" (que exige `facturacionEstado === null`).
 * NO toca el presupuesto ni la máquina de estados del proyecto.
 */
export function marcarCanceladoDesdeCaja(
  metadata: unknown,
  nowIso: string,
  canceladoBy: string | null
): ProyectoMetadata {
  const base = asMetadataObject(metadata);
  // Explícitamente quitamos las marcas de caja para que `getFacturacionEstado` vuelva a null.
  const { facturacion_estado: _fe, enviado_a_caja_at: _eca, ...rest } = base;
  void _fe; void _eca;
  return {
    ...rest,
    cancelado_caja_at: nowIso,
    cancelado_caja_by: canceladoBy,
  };
}

/** Devuelve la metadata mergeada para marcar el pedido como facturado por Caja. */
export function marcarFacturado(
  metadata: unknown,
  nowIso: string,
  ventaId: string,
  ventaNumero: string
): ProyectoMetadata {
  return {
    ...asMetadataObject(metadata),
    facturacion_estado: "facturado",
    facturado_at: nowIso,
    venta_id: ventaId,
    venta_numero: ventaNumero,
  };
}
