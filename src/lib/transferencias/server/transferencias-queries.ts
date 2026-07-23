/**
 * Lecturas del módulo de transferencias (solo SELECT, vía pool PG).
 *
 * Todo scoped por empresa y por sucursal: una consulta solo devuelve
 * transferencias donde la sucursal del usuario sea ORIGEN o DESTINO. Nunca
 * expone transferencias de dos sucursales ajenas.
 */
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";

function pool() {
  const p = getChatPostgresPool();
  if (!p) throw new Error("Pool PG no disponible para transferencias.");
  return p;
}

export type TransferenciaResumen = {
  id: string;
  numero: string;
  estado: string;
  sucursal_origen_id: string;
  sucursal_origen_nombre: string;
  sucursal_destino_id: string;
  sucursal_destino_nombre: string;
  observacion_solicitud: string | null;
  motivo_rechazo: string | null;
  solicitada_at: string;
  aprobada_at: string | null;
  rechazada_at: string | null;
  despachada_at: string | null;
  recibida_at: string | null;
  cancelada_at: string | null;
  items_count: number;
  /** true si el usuario que consulta es la sucursal solicitante (destino). */
  es_solicitante: boolean;
};

export type TransferenciaItemDetalle = {
  id: string;
  producto_destino_id: string;
  producto_origen_id: string | null;
  sku: string;
  nombre: string;
  unidad: string;
  cantidad_solicitada: number;
  cantidad_aprobada: number;
  cantidad_despachada: number;
  cantidad_recibida: number;
  /** Stock actual del producto en la sucursal solicitante (destino). */
  stock_destino: number;
  /** Stock actual del equivalente en el origen (null si no hay equivalencia). */
  stock_origen: number | null;
  tiene_equivalencia: boolean;
};

const n = (v: unknown): number => {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
};

/**
 * Lista las transferencias visibles para una sucursal.
 * @param filtro "realizadas" (destino = mi sucursal) | "recibidas" (origen = mi sucursal) | "todas"
 */
export async function listarTransferencias(params: {
  schemaRaw: string;
  empresaId: string;
  sucursalId: string;
  filtro: "realizadas" | "recibidas" | "todas";
}): Promise<TransferenciaResumen[]> {
  const schema = assertAllowedChatDataSchema(params.schemaRaw);
  const tT = quoteSchemaTable(schema, "transferencias_inventario");
  const tI = quoteSchemaTable(schema, "transferencias_inventario_items");
  const tS = quoteSchemaTable(schema, "sucursales");

  let scope = "(t.sucursal_origen_id = $2::uuid OR t.sucursal_destino_id = $2::uuid)";
  if (params.filtro === "realizadas") scope = "t.sucursal_destino_id = $2::uuid";
  else if (params.filtro === "recibidas") scope = "t.sucursal_origen_id = $2::uuid";

  const { rows } = await pool().query(
    `SELECT t.id, t.numero, t.estado,
            t.sucursal_origen_id, so.nombre AS sucursal_origen_nombre,
            t.sucursal_destino_id, sd.nombre AS sucursal_destino_nombre,
            t.observacion_solicitud, t.motivo_rechazo,
            t.solicitada_at, t.aprobada_at, t.rechazada_at, t.despachada_at, t.recibida_at, t.cancelada_at,
            (SELECT count(*) FROM ${tI} i WHERE i.transferencia_id = t.id)::int AS items_count,
            (t.sucursal_destino_id = $2::uuid) AS es_solicitante
       FROM ${tT} t
       JOIN ${tS} so ON so.id = t.sucursal_origen_id
       JOIN ${tS} sd ON sd.id = t.sucursal_destino_id
      WHERE t.empresa_id = $1::uuid AND ${scope}
      ORDER BY t.solicitada_at DESC
      LIMIT 500`,
    [params.empresaId, params.sucursalId]
  );
  return rows.map((r) => ({ ...r, items_count: n(r.items_count) })) as TransferenciaResumen[];
}

/** Cabecera + ítems + stock de ambos lados. Devuelve null si la sucursal no participa. */
export async function getTransferenciaDetalle(params: {
  schemaRaw: string;
  empresaId: string;
  sucursalId: string;
  transferenciaId: string;
}): Promise<{ cabecera: TransferenciaResumen; items: TransferenciaItemDetalle[] } | null> {
  const schema = assertAllowedChatDataSchema(params.schemaRaw);
  const tT = quoteSchemaTable(schema, "transferencias_inventario");
  const tI = quoteSchemaTable(schema, "transferencias_inventario_items");
  const tS = quoteSchemaTable(schema, "sucursales");
  const tP = quoteSchemaTable(schema, "productos");

  const { rows: cab } = await pool().query(
    `SELECT t.id, t.numero, t.estado,
            t.sucursal_origen_id, so.nombre AS sucursal_origen_nombre,
            t.sucursal_destino_id, sd.nombre AS sucursal_destino_nombre,
            t.observacion_solicitud, t.motivo_rechazo,
            t.solicitada_at, t.aprobada_at, t.rechazada_at, t.despachada_at, t.recibida_at, t.cancelada_at,
            0::int AS items_count,
            (t.sucursal_destino_id = $3::uuid) AS es_solicitante
       FROM ${tT} t
       JOIN ${tS} so ON so.id = t.sucursal_origen_id
       JOIN ${tS} sd ON sd.id = t.sucursal_destino_id
      WHERE t.id = $1::uuid AND t.empresa_id = $2::uuid
        AND (t.sucursal_origen_id = $3::uuid OR t.sucursal_destino_id = $3::uuid)`,
    [params.transferenciaId, params.empresaId, params.sucursalId]
  );
  if (!cab[0]) return null;

  const { rows: items } = await pool().query(
    `SELECT i.id, i.producto_destino_id, i.producto_origen_id,
            i.sku_snapshot AS sku, i.nombre_snapshot AS nombre, i.unidad_snapshot AS unidad,
            i.cantidad_solicitada, i.cantidad_aprobada, i.cantidad_despachada, i.cantidad_recibida,
            COALESCE(pd.stock_actual, 0) AS stock_destino,
            po.stock_actual AS stock_origen
       FROM ${tI} i
       LEFT JOIN ${tP} pd ON pd.id = i.producto_destino_id
       LEFT JOIN ${tP} po ON po.id = i.producto_origen_id
      WHERE i.transferencia_id = $1::uuid
      ORDER BY i.created_at ASC`,
    [params.transferenciaId]
  );

  const cabecera = { ...cab[0], items_count: items.length } as TransferenciaResumen;
  const itemsOut: TransferenciaItemDetalle[] = items.map((r) => ({
    id: r.id,
    producto_destino_id: r.producto_destino_id,
    producto_origen_id: r.producto_origen_id,
    sku: r.sku ?? "",
    nombre: r.nombre ?? "",
    unidad: r.unidad ?? "",
    cantidad_solicitada: n(r.cantidad_solicitada),
    cantidad_aprobada: n(r.cantidad_aprobada),
    cantidad_despachada: n(r.cantidad_despachada),
    cantidad_recibida: n(r.cantidad_recibida),
    stock_destino: n(r.stock_destino),
    stock_origen: r.stock_origen == null ? null : n(r.stock_origen),
    tiene_equivalencia: r.producto_origen_id != null,
  }));

  return { cabecera, items: itemsOut };
}

/** Conteos para las cards (Pendientes / Aprobadas / En tránsito / Recibidas). */
export async function contarPorEstado(params: {
  schemaRaw: string;
  empresaId: string;
  sucursalId: string;
}): Promise<Record<string, number>> {
  const schema = assertAllowedChatDataSchema(params.schemaRaw);
  const tT = quoteSchemaTable(schema, "transferencias_inventario");
  const { rows } = await pool().query(
    `SELECT estado, count(*)::int AS n FROM ${tT}
      WHERE empresa_id = $1::uuid
        AND (sucursal_origen_id = $2::uuid OR sucursal_destino_id = $2::uuid)
      GROUP BY estado`,
    [params.empresaId, params.sucursalId]
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.estado] = n(r.n);
  return out;
}

/** Productos activos con control de stock de una sucursal, para el selector de equivalencia. */
export async function buscarProductosDeSucursal(params: {
  schemaRaw: string;
  empresaId: string;
  sucursalId: string;
  q: string;
}): Promise<Array<{ id: string; sku: string; nombre: string; stock_actual: number }>> {
  const schema = assertAllowedChatDataSchema(params.schemaRaw);
  const tP = quoteSchemaTable(schema, "productos");
  const q = (params.q ?? "").trim().slice(0, 60);
  const like = `%${q.replace(/[%_\\]/g, (m) => "\\" + m)}%`;
  const { rows } = await pool().query(
    `SELECT id, sku, nombre, stock_actual FROM ${tP}
      WHERE empresa_id = $1::uuid AND sucursal_id = $2::uuid
        AND activo = true AND controla_stock = true
        AND ($3 = '' OR nombre ILIKE $4 OR sku ILIKE $4 OR codigo_barras ILIKE $4)
      ORDER BY nombre LIMIT 30`,
    [params.empresaId, params.sucursalId, q, like]
  );
  return rows.map((r) => ({ id: r.id, sku: r.sku, nombre: r.nombre, stock_actual: n(r.stock_actual) }));
}
