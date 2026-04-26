export type TipoCliente = "empresa" | "persona";
export type OrigenCliente = "CRM" | "VENTA" | "MANUAL";
export type EstadoCliente = "activo" | "inactivo";

import {
  SLUGS_TIPOS_CLIENTE_SISTEMA,
} from "./tipo-servicio-catalogo";

/**
 * Clasificación operativa del cliente (distinto de tipo_cliente). Slug libre; los de sistema
 * (marketing, saas, etc.) se documentan en `SLUGS_TIPOS_CLIENTE_SISTEMA`.
 */
export type TipoServicioCliente = string;

export const TIPOS_SERVICIO_CLIENTE: string[] = [...SLUGS_TIPOS_CLIENTE_SISTEMA];
export { SLUGS_TIPOS_CLIENTE_SISTEMA };

export interface NotaCliente {
  id:    number;
  texto: string;
  fecha: string; // ISO string
}

export interface Cliente {
  id:                  string;          // UUID de Supabase
  codigo_cliente:      string;          // CL-000001

  tipo_cliente:        TipoCliente;
  empresa?:            string;          // razón social (si es empresa)
  nombre_contacto:     string;          // persona de contacto principal

  ruc?:                string;
  documento?:          string;          // CI / pasaporte (persona)

  telefono?:           string;
  telefono_secundario?: string;
  email?:              string;
  email_secundario?:   string;

  direccion?:          string;
  ciudad?:             string;
  pais?:               string;

  sitio_web?:          string;
  instagram?:          string;
  linkedin?:           string;

  valor_cliente?:      number;          // valor estimado anual en GS

  condicion_pago?:     string;          // CONTADO / 30 DÍAS / 60 DÍAS…
  moneda_preferida?:   "GS" | "USD";
  vendedor_asignado?:  string;

  origen:              OrigenCliente;
  prospecto_id?:       number;          // ID del prospecto CRM de origen

  estado:              EstadoCliente;
  notas:               NotaCliente[];

  /** Clasificación operativa (marketing, saas, branding, web, otro) */
  tipo_servicio_cliente?: TipoServicioCliente;

  /** Usuario que creó el cliente (auth.users.id) */
  created_by_user_id?:   string | null;
  /** Nombre del creador para display (denormalizado) */
  created_by_nombre?:    string | null;

  /** Eliminación lógica */
  deleted_at?:           string | null;   // ISO string
  deleted_by_user_id?:   string | null;
  deletion_reason?:      string | null;

  /** Baja operativa (estado inactivo + suscripciones canceladas) */
  baja_operativa_at?:         string | null;   // ISO string
  baja_operativa_by_user_id?: string | null;
  baja_operativa_by_nombre?:  string | null;   // Para trazabilidad
  baja_operativa_motivo?:     string | null;
  baja_operativa_anulo_factura?: boolean | null;

  created_at:          string;          // ISO string
  updated_at:          string;          // ISO string

  /** Nombre del plan activo (suscripción activa). Solo cuando se solicita en listado. */
  plan_activo?:        string | null;

  /** Indicador de UI: el perfil tributario está activo (no implica que la empresa tenga la función encendida). */
  perfil_tributario_activo?: boolean;

  /** Detalle de obligaciones y metadatos fiscales (sin clave en claro). */
  perfil_tributario?:  PerfilTributarioCliente | null;
}

/** Perfil fiscal extendido; la clave nunca se expone, solo el hecho de que exista. */
export interface PerfilTributarioCliente {
  perfil_activo: boolean;
  dv: string | null;
  razon_social_fiscal: string | null;
  fecha_vencimiento: string | null;
  honorario_mensual: number | null;
  honorario_anual: number | null;
  notas_tributarias: string | null;
  obligacion_otro_detalle: string | null;
  clave_tributaria_configurada: boolean;
  obligaciones: { id: string; slug: string; nombre: string }[];
}
