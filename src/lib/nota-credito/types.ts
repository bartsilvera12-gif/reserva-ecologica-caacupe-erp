/** Estados ERP de `nota_credito` (fase 1). */
export type NotaCreditoEstadoErp =
  | "borrador"
  | "pendiente_envio_sifen"
  | "aprobada"
  | "rechazada"
  | "error"
  | "anulada_borrador";

/** Estados SIFEN del DE de la NC (`nota_credito_electronica`). */
export type NotaCreditoEstadoSifen =
  | "sin_envio"
  | "borrador"
  | "generado"
  | "firmado"
  | "enviado"
  | "en_proceso"
  | "aprobado"
  | "rechazado"
  | "error_envio"
  | "cancelado";

export type NotaCreditoEventoTipo =
  | "creacion"
  | "validacion"
  | "rechazo_negocio"
  | "cambio_estado_erp"
  | "preparacion_sifen"
  | "error"
  | "observacion_operativa"
  | "anulacion_borrador"
  | "xml_generado"
  | "xml_firmado"
  | "enviado_set"
  | "respuesta_set"
  | "aprobado"
  | "rechazado"
  | "impacto_saldo_aplicado"
  | "error_envio";

export type NotaCreditoListItemDTO = {
  id: string;
  /** Correlativo por empresa (= dNumDoc del CDC). NULL en notas de legado,
   *  emitidas cuando el número se derivaba de un hash del UUID. */
  numero: number | null;
  /** Líneas de la NC (solo en NC parcial). Vacío en NC total. */
  items: {
    producto_nombre: string;
    sku: string | null;
    cantidad: number;
    precio_unitario: number;
    tipo_iva: "EXENTA" | "5%" | "10%";
    total_linea: number;
  }[];
  monto: number;
  motivo: string;
  observacion_interna: string | null;
  estado_erp: NotaCreditoEstadoErp;
  created_at: string;
  created_by_user_id: string | null;
  created_by_email_snapshot: string | null;
  created_by_nombre_snapshot: string | null;
  saldo_previo_snapshot: number;
  monto_factura_snapshot: number;
  suma_pagos_snapshot: number;
  moneda_snapshot: string;
  estado_sifen: NotaCreditoEstadoSifen | null;
  cdc: string | null;
  cdc_factura_origen: string | null;
  last_error: string | null;
  /** Rutas en bucket SIFEN (`nota_credito_electronica`) para diagnóstico. */
  xml_path: string | null;
  /** Ruta del XML firmado de la NC en storage. */
  xml_firmado_path: string | null;
  /** Últimas respuestas SET (recibe-lote / consulta-lote) para diagnóstico en UI. */
  sifen_respuestas_set: Record<string, unknown> | null;
};

/** Tipo de NC: total (acredita todo el saldo, sin ítems) o parcial (líneas). */
export type NotaCreditoTipoNc = "total" | "parcial";

/** Modo con que el operador armó cada línea de una NC parcial.
 *  - unidades: cantidad libre × precio fijo → sistema calcula subtotal + IVA.
 *  - monto:    total_linea libre (típico ajuste post-venta) → sistema deriva IVA. */
export type NotaCreditoItemModo = "unidades" | "monto";

/** Item de una NC parcial. Todos los montos son IVA-incluido en Gs./USD sin decimales
 *  (salvo cantidad, que sí acepta decimales). El servidor recalcula subtotal/monto_iva
 *  a partir de tipo_iva para evitar depender del cliente. */
export type NotaCreditoItemInput = {
  /** Trazabilidad opcional al item origen de la factura. */
  factura_item_id?: string | null;
  producto_id?: string | null;
  producto_nombre: string;
  sku?: string | null;
  cantidad: number;
  precio_unitario: number;
  tipo_iva: "EXENTA" | "5%" | "10%";
  total_linea: number;
  modo?: NotaCreditoItemModo;
};

export type NotaCreditoCreateBody = {
  motivo: string;
  observacion_interna?: string | null;
  /** Default 'total' por compat. Si es 'parcial' se exigen items[]. */
  tipo_nc?: NotaCreditoTipoNc;
  /** Líneas de una NC parcial. Se ignora si tipo_nc='total'. */
  items?: NotaCreditoItemInput[];
};

/** Resultado de `obtenerSifenPrevueloFacturaParaNcs` (listado por factura, sin NC concreta). */
export type SifenPrevueloFacturaNcDTO = {
  ok: boolean;
  mensaje: string | null;
  diagnostico: Record<string, unknown> | null;
};

/** Fila del listado global `/notas-credito`. */
export type NotaCreditoGlobalListItemDTO = {
  id: string;
  monto: number;
  motivo: string;
  observacion_interna: string | null;
  estado_erp: NotaCreditoEstadoErp;
  created_at: string;
  factura_id: string;
  factura_numero: string | null;
  cliente_id: string;
  cliente_display: string;
  moneda_snapshot: string;
  created_by_user_id: string | null;
  created_by_email_snapshot: string | null;
  created_by_nombre_snapshot: string | null;
  estado_sifen: NotaCreditoEstadoSifen | null;
  cdc: string | null;
  cdc_factura_origen: string | null;
  last_error_resumido: string | null;
};

export type NotaCreditoEventoAuditoriaDTO = {
  id: string;
  tipo_evento: string;
  detalle_json: Record<string, unknown>;
  created_at: string;
  actor_user_id: string | null;
};

/** Fila de `nota_credito_items` expuesta al UI (snapshots + valores calculados). */
export type NotaCreditoItemDTO = {
  id: string;
  producto_nombre: string;
  sku: string | null;
  cantidad: number;
  precio_unitario: number;
  tipo_iva: string;
  subtotal: number;
  monto_iva: number;
  total_linea: number;
  modo: string;
};

/** Detalle global + auditoría + líneas (fase B). */
export type NotaCreditoGlobalDetailDTO = {
  nota_credito: Record<string, unknown>;
  nota_credito_electronica: Record<string, unknown> | null;
  cliente: { id: string; display: string; ruc: string | null };
  factura: { id: string; numero_factura: string | null; fecha: string | null; monto: number | null; moneda: string | null };
  eventos: NotaCreditoEventoAuditoriaDTO[];
  /** Líneas de la NC (solo si tipo_nc='parcial'; vacío para NC total). */
  items: NotaCreditoItemDTO[];
};
