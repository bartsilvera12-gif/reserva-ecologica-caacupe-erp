import { supabase } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth";
import type { Cliente, EstadoCliente, NotaCliente } from "./types";

// ─── Tipo de fila Supabase ────────────────────────────────────────────────────
// RLS maneja empresa_id automáticamente; no filtrar manualmente en SELECT
interface SupabaseRow {
  id:                      string;
  empresa_id:              string | null;
  tipo_cliente:            string | null;
  tipo_servicio_cliente:   string | null;
  created_by_user_id:      string | null;
  created_by_nombre:       string | null;
  deleted_at:              string | null;
  deleted_by_user_id:      string | null;
  deletion_reason:         string | null;
  baja_operativa_at:         string | null;
  baja_operativa_by_user_id: string | null;
  baja_operativa_by_nombre:  string | null;
  baja_operativa_motivo:     string | null;
  baja_operativa_anulo_factura: boolean | null;
  empresa:            string | null;
  nombre:             string | null;
  nombre_contacto:    string | null;
  ruc:                string | null;
  documento:          string | null;
  telefono:           string | null;
  telefono_secundario: string | null;
  email:              string | null;
  email_secundario:   string | null;
  direccion:          string | null;
  ciudad:             string | null;
  pais:               string | null;
  sitio_web:          string | null;
  instagram:          string | null;
  linkedin:           string | null;
  valor_cliente:      number | null;
  condicion_pago:     string | null;
  moneda_preferida:   string | null;
  vendedor_asignado:  string | null;
  origen:             string | null;
  prospecto_id:       number | null;
  estado:             string | null;
  notas:              unknown;
  created_at:         string | null;
  updated_at:         string | null;
}

// ─── Mapping fila → Cliente ───────────────────────────────────────────────────

function parseNotas(notas: unknown): NotaCliente[] {
  if (!Array.isArray(notas)) return [];
  return notas
    .filter((n): n is { id?: number; texto?: string; fecha?: string } => n && typeof n === "object")
    .map((n) => ({
      id:    typeof n.id === "number" ? n.id : Date.now(),
      texto: typeof n.texto === "string" ? n.texto : "",
      fecha: typeof n.fecha === "string" ? n.fecha : new Date().toISOString(),
    }));
}

function rowToCliente(row: SupabaseRow): Cliente {
  const nombreContacto = row.nombre_contacto ?? row.nombre ?? "";
  const now = new Date().toISOString();
  return {
    id:                  row.id,
    codigo_cliente:      `CL-${row.id.slice(0, 8).toUpperCase()}`,
    tipo_cliente:        (row.tipo_cliente === "persona" ? "persona" : "empresa") as Cliente["tipo_cliente"],
    empresa:             row.empresa ?? undefined,
    nombre_contacto:     nombreContacto,
    ruc:                 row.ruc ?? undefined,
    documento:           row.documento ?? undefined,
    telefono:            row.telefono ?? undefined,
    telefono_secundario: row.telefono_secundario ?? undefined,
    email:               row.email ?? undefined,
    email_secundario:    row.email_secundario ?? undefined,
    direccion:           row.direccion ?? undefined,
    ciudad:              row.ciudad ?? undefined,
    pais:                row.pais ?? undefined,
    sitio_web:           row.sitio_web ?? undefined,
    instagram:           row.instagram ?? undefined,
    linkedin:            row.linkedin ?? undefined,
    valor_cliente:       row.valor_cliente ?? undefined,
    condicion_pago:      row.condicion_pago ?? undefined,
    moneda_preferida:    (row.moneda_preferida === "USD" ? "USD" : "GS") as "GS" | "USD",
    vendedor_asignado:   row.vendedor_asignado ?? undefined,
    origen:              (row.origen as Cliente["origen"]) ?? "MANUAL",
    prospecto_id:        row.prospecto_id ?? undefined,
    estado:              (row.estado === "inactivo" ? "inactivo" : "activo") as EstadoCliente,
    notas:               parseNotas(row.notas),
    tipo_servicio_cliente: (row.tipo_servicio_cliente as Cliente["tipo_servicio_cliente"]) ?? undefined,
    created_by_user_id:  row.created_by_user_id ?? undefined,
    created_by_nombre:   row.created_by_nombre ?? undefined,
    deleted_at:          row.deleted_at ?? undefined,
    deleted_by_user_id:  row.deleted_by_user_id ?? undefined,
    deletion_reason:     row.deletion_reason ?? undefined,
    baja_operativa_at:         row.baja_operativa_at ?? undefined,
    baja_operativa_by_user_id: row.baja_operativa_by_user_id ?? undefined,
    baja_operativa_by_nombre:  row.baja_operativa_by_nombre ?? undefined,
    baja_operativa_motivo:     row.baja_operativa_motivo ?? undefined,
    baja_operativa_anulo_factura: row.baja_operativa_anulo_factura ?? undefined,
    created_at:          row.created_at ?? now,
    updated_at:          row.updated_at ?? row.created_at ?? now,
  };
}

// ─── API pública ──────────────────────────────────────────────────────────────

/** Lista clientes. RLS filtra por empresa. Excluye eliminados (soft delete). */
export async function getClientes(opts?: { incluirEliminados?: boolean; incluirPlanActivo?: boolean }): Promise<Cliente[]> {
  let q = supabase
    .from("clientes")
    .select("*")
    .order("created_at", { ascending: false });
  if (!opts?.incluirEliminados) {
    q = q.is("deleted_at", null);
  }
  const { data, error } = await q;

  if (error) {
    console.error("[clientes] getClientes:", error.message);
    return [];
  }

  const clientes = (data as SupabaseRow[]).map(rowToCliente);

  if (opts?.incluirPlanActivo) {
    const planMap = await getPlanActivoPorClienteMap(clientes.map((c) => c.id));
    clientes.forEach((c) => {
      (c as Cliente).plan_activo = planMap.get(c.id) ?? undefined;
    });
  }

  return clientes;
}

/** Obtiene mapa cliente_id -> nombre del plan activo (suscripción activa más reciente). Una sola query en batch. */
async function getPlanActivoPorClienteMap(clienteIds: string[]): Promise<Map<string, string>> {
  if (clienteIds.length === 0) return new Map();

  const { data, error } = await supabase
    .from("suscripciones")
    .select("cliente_id, planes(nombre)")
    .eq("estado", "activa")
    .in("cliente_id", clienteIds)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[clientes] getPlanActivoPorClienteMap:", error.message);
    return new Map();
  }

  const map = new Map<string, string>();
  for (const row of data ?? []) {
    const cid = (row as { cliente_id: string }).cliente_id;
    if (!map.has(cid)) {
      const planes = (row as { planes: { nombre: string } | { nombre: string }[] | null }).planes;
      const plan = Array.isArray(planes) ? planes[0] : planes;
      const nombre = plan?.nombre?.trim();
      map.set(cid, nombre || "Suscripción");
    }
  }
  return map;
}

/** Obtiene un cliente por ID. RLS filtra por empresa. Por defecto excluye eliminados. */
export async function getCliente(id: string, opts?: { incluirEliminados?: boolean }): Promise<Cliente | null> {
  let q = supabase
    .from("clientes")
    .select("*")
    .eq("id", id);
  if (!opts?.incluirEliminados) {
    q = q.is("deleted_at", null);
  }
  const { data, error } = await q.single();

  if (error) {
    console.error("[clientes] getCliente:", error.message);
    return null;
  }
  return rowToCliente(data as SupabaseRow);
}

export async function getClienteByProspectoId(
  _prospectoId: number
): Promise<Cliente | null> {
  return null; // Sin columna prospecto_id en Supabase por ahora
}

export type NuevoClienteData = Omit<
  Cliente,
  "id" | "codigo_cliente" | "notas" | "created_at" | "updated_at"
>;

/** Crea cliente. empresa_id y created_by se obtienen del usuario; RLS valida acceso. */
export async function saveCliente(datos: NuevoClienteData): Promise<Cliente | null> {
  const usuario = await getCurrentUser();
  if (!usuario?.empresa_id) throw new Error("Usuario no autenticado o sin empresa");

  const { data: { user } } = await supabase.auth.getUser();
  const insert: Record<string, unknown> = {
    empresa_id:           usuario.empresa_id,
    tipo_cliente:         datos.tipo_cliente ?? "empresa",
    tipo_servicio_cliente: datos.tipo_servicio_cliente ?? null,
    created_by_user_id:   user?.id ?? null,
    created_by_nombre:    (usuario as { nombre?: string })?.nombre ?? null,
    empresa:            datos.empresa ?? null,
    nombre:             datos.nombre_contacto ?? null,
    nombre_contacto:    datos.nombre_contacto ?? null,
    ruc:                datos.ruc ?? null,
    documento:          datos.documento ?? null,
    telefono:           datos.telefono ?? null,
    telefono_secundario: datos.telefono_secundario ?? null,
    email:              datos.email ?? null,
    email_secundario:   datos.email_secundario ?? null,
    direccion:          datos.direccion ?? null,
    ciudad:             datos.ciudad ?? null,
    pais:               datos.pais ?? null,
    sitio_web:          datos.sitio_web ?? null,
    instagram:          datos.instagram ?? null,
    linkedin:           datos.linkedin ?? null,
    valor_cliente:      datos.valor_cliente ?? null,
    condicion_pago:     datos.condicion_pago ?? null,
    moneda_preferida:   datos.moneda_preferida ?? "GS",
    vendedor_asignado:  datos.vendedor_asignado ?? null,
    origen:             datos.origen ?? "MANUAL",
    prospecto_id:       datos.prospecto_id ?? null,
    estado:             datos.estado ?? "activo",
  };

  const { data, error } = await supabase
    .from("clientes")
    .insert([insert])
    .select()
    .single();

  if (error) {
    console.error("[clientes] saveCliente:", error.message);
    return null;
  }
  return rowToCliente(data as SupabaseRow);
}

/** Actualiza cliente. RLS valida que pertenezca a la empresa del usuario. */
export async function updateCliente(
  id: string,
  datos: Partial<Omit<Cliente, "id" | "codigo_cliente" | "created_at">>
): Promise<Cliente | null> {
  const patch: Record<string, unknown> = {};
  if (datos.tipo_cliente !== undefined) patch.tipo_cliente = datos.tipo_cliente;
  if (datos.empresa !== undefined) patch.empresa = datos.empresa ?? null;
  if (datos.nombre_contacto !== undefined) {
    patch.nombre = datos.nombre_contacto ?? null;
    patch.nombre_contacto = datos.nombre_contacto ?? null;
  }
  if (datos.ruc !== undefined) patch.ruc = datos.ruc ?? null;
  if (datos.documento !== undefined) patch.documento = datos.documento ?? null;
  if (datos.telefono !== undefined) patch.telefono = datos.telefono ?? null;
  if (datos.telefono_secundario !== undefined) patch.telefono_secundario = datos.telefono_secundario ?? null;
  if (datos.email !== undefined) patch.email = datos.email ?? null;
  if (datos.email_secundario !== undefined) patch.email_secundario = datos.email_secundario ?? null;
  if (datos.direccion !== undefined) patch.direccion = datos.direccion ?? null;
  if (datos.ciudad !== undefined) patch.ciudad = datos.ciudad ?? null;
  if (datos.pais !== undefined) patch.pais = datos.pais ?? null;
  if (datos.sitio_web !== undefined) patch.sitio_web = datos.sitio_web ?? null;
  if (datos.instagram !== undefined) patch.instagram = datos.instagram ?? null;
  if (datos.linkedin !== undefined) patch.linkedin = datos.linkedin ?? null;
  if (datos.valor_cliente !== undefined) patch.valor_cliente = datos.valor_cliente ?? null;
  if (datos.condicion_pago !== undefined) patch.condicion_pago = datos.condicion_pago ?? null;
  if (datos.moneda_preferida !== undefined) patch.moneda_preferida = datos.moneda_preferida ?? null;
  if (datos.vendedor_asignado !== undefined) patch.vendedor_asignado = datos.vendedor_asignado ?? null;
  if (datos.estado !== undefined) patch.estado = datos.estado ?? null;
  if (datos.tipo_servicio_cliente !== undefined) patch.tipo_servicio_cliente = datos.tipo_servicio_cliente ?? null;
  patch.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from("clientes")
    .update(patch)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    console.error("[clientes] updateCliente:", error.message);
    return null;
  }
  return rowToCliente(data as SupabaseRow);
}

/**
 * Eliminación lógica (soft delete) de cliente.
 * Solo debe llamarse tras validar: 1) usuario admin, 2) sin relaciones bloqueantes, 3) motivo obligatorio.
 * Para uso desde API; el cliente no debe llamar deleteCliente directamente.
 */
export async function softDeleteCliente(
  id: string,
  userId: string,
  reason: string
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await supabase
    .from("clientes")
    .update({
      deleted_at:         new Date().toISOString(),
      deleted_by_user_id: userId,
      deletion_reason:    reason.trim() || null,
      updated_at:        new Date().toISOString(),
    })
    .eq("id", id)
    .is("deleted_at", null);

  if (error) {
    console.error("[clientes] softDeleteCliente:", error.message);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/**
 * @deprecated No usar: la eliminación debe hacerse vía API con validación admin.
 * Mantenido para compatibilidad; en producción usar DELETE /api/clientes/[id].
 */
export async function deleteCliente(id: string): Promise<void> {
  const { error } = await supabase.from("clientes").delete().eq("id", id);
  if (error) console.error("[clientes] deleteCliente:", error.message);
}

// ─── Notas (persistidas en Supabase, columna notas jsonb) ────────────────────

/** Obtiene notas del cliente desde Supabase. Fallback a [] si no hay datos. */
export async function getNotasCliente(clienteId: string): Promise<NotaCliente[]> {
  const { data, error } = await supabase
    .from("clientes")
    .select("notas")
    .eq("id", clienteId)
    .single();

  if (error || !data) return [];
  return parseNotas((data as { notas: unknown }).notas);
}

/** Añade una nota al cliente y persiste en Supabase. */
export async function addNotaCliente(clienteId: string, texto: string): Promise<NotaCliente> {
  const notas = await getNotasCliente(clienteId);
  const nota: NotaCliente = {
    id:    Date.now(),
    texto: texto.trim(),
    fecha: new Date().toISOString(),
  };
  const nuevas = [...notas, nota];

  const { error } = await supabase
    .from("clientes")
    .update({ notas: nuevas, updated_at: new Date().toISOString() })
    .eq("id", clienteId);

  if (error) console.error("[clientes] addNotaCliente:", error.message);
  return nota;
}

export async function toggleEstado(id: string, estado: EstadoCliente): Promise<void> {
  await updateCliente(id, { estado });
}

/** Nombre de display según tipo de cliente. */
export function clienteNombre(c: Cliente): string {
  return c.tipo_cliente === "empresa" && c.empresa ? c.empresa : c.nombre_contacto;
}
