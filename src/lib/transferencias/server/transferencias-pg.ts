/**
 * Reposición y transferencias entre sucursales — capa PG transaccional.
 *
 * Sigue el patrón de compras-pg.ts: pool() + BEGIN/FOR UPDATE/COMMIT reales.
 * Las acciones que mueven stock (despachar, recibir) corren en UNA transacción
 * con bloqueo de filas, para ser atómicas e idempotentes.
 *
 * Idempotencia: la garantiza la máquina de estados bajo FOR UPDATE. Despachar
 * exige estado 'aprobada' y lo cambia a 'despachada'; un segundo despacho ve
 * 'despachada' y aborta. Igual para recibir ('despachada' → 'recibida'). Así,
 * repetir el endpoint nunca duplica stock ni movimientos.
 *
 * No toca ventas, compras, facturas, SIFEN, CxC ni precios de venta.
 */
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import type { PoolClient } from "pg";

function pool() {
  const p = getChatPostgresPool();
  if (!p) throw new Error("Pool PG no disponible para transferencias.");
  return p;
}

export type EstadoTransferencia =
  | "pendiente"
  | "aprobada"
  | "rechazada"
  | "despachada"
  | "recibida"
  | "cancelada";

export type TransferenciaItemInput = {
  producto_destino_id: string;
  cantidad_solicitada: number;
};

export type AprobacionItemInput = {
  item_id: string;
  cantidad_aprobada: number;
};

/** Error de dominio con status HTTP asociado (lo traduce el route). */
export class TransferenciaError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "TransferenciaError";
    this.status = status;
  }
}

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Próximo TRF-XXXXXX seguro ante concurrencia: advisory lock por empresa dentro
 * de la transacción (se libera al COMMIT/ROLLBACK) + MAX+1. El índice único
 * (empresa_id, numero) es el respaldo final.
 */
async function proximoNumeroTransferencia(
  client: PoolClient,
  schema: string,
  empresaId: string
): Promise<string> {
  const t = quoteSchemaTable(schema, "transferencias_inventario");
  // Lock por empresa: dos creaciones simultáneas de la misma empresa se serializan.
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${empresaId}:transferencia`]);
  const { rows } = await client.query<{ maxn: number | null }>(
    `SELECT COALESCE(MAX(
       CASE WHEN numero ~ '^TRF-[0-9]+$' THEN (substring(numero from 5))::int ELSE 0 END
     ), 0) AS maxn
     FROM ${t} WHERE empresa_id = $1::uuid`,
    [empresaId]
  );
  const next = Number(rows[0]?.maxn ?? 0) + 1;
  return `TRF-${String(next).padStart(6, "0")}`;
}

// ── Crear solicitud ─────────────────────────────────────────────────────────
/**
 * La crea la sucursal SOLICITANTE (= destino). El origen se elige entre las
 * sucursales activas de la empresa. Los ítems nacen con el producto del DESTINO;
 * el equivalente del origen se resuelve por SKU acá (nullable si no existe).
 */
export async function crearTransferencia(params: {
  schemaRaw: string;
  empresaId: string;
  sucursalDestinoId: string;
  sucursalOrigenId: string;
  items: TransferenciaItemInput[];
  observacion: string | null;
  usuarioId: string | null;
}): Promise<{ id: string; numero: string }> {
  const schema = assertAllowedChatDataSchema(params.schemaRaw);
  const { empresaId, sucursalDestinoId, sucursalOrigenId } = params;

  if (sucursalOrigenId === sucursalDestinoId) {
    throw new TransferenciaError(400, "El origen y el destino no pueden ser la misma sucursal.");
  }
  if (!Array.isArray(params.items) || params.items.length === 0) {
    throw new TransferenciaError(400, "La solicitud debe tener al menos un producto.");
  }

  const tT = quoteSchemaTable(schema, "transferencias_inventario");
  const tI = quoteSchemaTable(schema, "transferencias_inventario_items");
  const tS = quoteSchemaTable(schema, "sucursales");
  const tP = quoteSchemaTable(schema, "productos");

  const client = await pool().connect();
  try {
    await client.query("BEGIN");

    // Ambas sucursales existen, son de la empresa y están activas.
    const { rows: sucRows } = await client.query<{ id: string; activa: boolean }>(
      `SELECT id, activa FROM ${tS} WHERE empresa_id = $1::uuid AND id = ANY($2::uuid[])`,
      [empresaId, [sucursalOrigenId, sucursalDestinoId]]
    );
    if (sucRows.length !== 2 || sucRows.some((s) => !s.activa)) {
      throw new TransferenciaError(400, "Ambas sucursales deben pertenecer a la empresa y estar activas.");
    }

    const numero = await proximoNumeroTransferencia(client, schema, empresaId);

    const { rows: cab } = await client.query<{ id: string }>(
      `INSERT INTO ${tT}
         (empresa_id, numero, sucursal_origen_id, sucursal_destino_id, estado,
          observacion_solicitud, solicitada_por, solicitada_at)
       VALUES ($1::uuid,$2,$3::uuid,$4::uuid,'pendiente',$5,$6::uuid,now())
       RETURNING id`,
      [
        empresaId,
        numero,
        sucursalOrigenId,
        sucursalDestinoId,
        params.observacion,
        params.usuarioId,
      ]
    );
    const transferenciaId = cab[0]!.id;

    for (const it of params.items) {
      const cant = num(it.cantidad_solicitada);
      if (cant <= 0) throw new TransferenciaError(400, "Las cantidades deben ser mayores a 0.");

      // Producto del DESTINO: debe existir, ser de esa sucursal, activo y controlar stock.
      const { rows: prodDst } = await client.query<{
        id: string; sku: string; nombre: string; unidad_medida: string;
      }>(
        `SELECT id, sku, nombre, unidad_medida FROM ${tP}
          WHERE id = $1::uuid AND empresa_id = $2::uuid AND sucursal_id = $3::uuid
            AND activo = true AND controla_stock = true`,
        [it.producto_destino_id, empresaId, sucursalDestinoId]
      );
      if (!prodDst[0]) {
        throw new TransferenciaError(
          400,
          "Un producto no pertenece a tu sucursal, está inactivo o no controla stock."
        );
      }
      const p = prodDst[0];

      // Equivalente en el ORIGEN por MISMO SKU (no por nombre). Nullable si no hay.
      const { rows: prodOrg } = await client.query<{ id: string }>(
        `SELECT id FROM ${tP}
          WHERE empresa_id = $1::uuid AND sucursal_id = $2::uuid AND sku = $3
            AND activo = true AND controla_stock = true
          LIMIT 1`,
        [empresaId, sucursalOrigenId, p.sku]
      );
      const productoOrigenId = prodOrg[0]?.id ?? null;

      await client.query(
        `INSERT INTO ${tI}
           (transferencia_id, empresa_id, producto_destino_id, producto_origen_id,
            sku_snapshot, nombre_snapshot, unidad_snapshot, cantidad_solicitada)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8::numeric)`,
        [
          transferenciaId,
          empresaId,
          p.id,
          productoOrigenId,
          p.sku,
          p.nombre,
          p.unidad_medida,
          cant,
        ]
      );
    }

    await client.query("COMMIT");
    return { id: transferenciaId, numero };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => null);
    throw e;
  } finally {
    client.release();
  }
}

// ── Aprobar (total o parcial) ───────────────────────────────────────────────
export async function aprobarTransferencia(params: {
  schemaRaw: string;
  empresaId: string;
  transferenciaId: string;
  aprobaciones: AprobacionItemInput[];
  usuarioId: string | null;
}): Promise<void> {
  const schema = assertAllowedChatDataSchema(params.schemaRaw);
  const { empresaId, transferenciaId } = params;
  const tT = quoteSchemaTable(schema, "transferencias_inventario");
  const tI = quoteSchemaTable(schema, "transferencias_inventario_items");

  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const { rows: cab } = await client.query<{ estado: string }>(
      `SELECT estado FROM ${tT} WHERE id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE`,
      [transferenciaId, empresaId]
    );
    if (!cab[0]) throw new TransferenciaError(404, "Transferencia no encontrada.");
    if (cab[0].estado !== "pendiente") {
      throw new TransferenciaError(409, "Solo se puede aprobar una solicitud pendiente.");
    }

    const { rows: items } = await client.query<{ id: string; cantidad_solicitada: string }>(
      `SELECT id, cantidad_solicitada FROM ${tI} WHERE transferencia_id = $1::uuid`,
      [transferenciaId]
    );
    const solicitadaById = new Map(items.map((i) => [i.id, num(i.cantidad_solicitada)]));
    const aprobById = new Map(params.aprobaciones.map((a) => [a.item_id, num(a.cantidad_aprobada)]));

    let algunaAprobada = false;
    for (const [itemId, solicitada] of solicitadaById) {
      const aprob = aprobById.has(itemId) ? aprobById.get(itemId)! : solicitada;
      if (aprob < 0) throw new TransferenciaError(400, "La cantidad aprobada no puede ser negativa.");
      if (aprob > solicitada) {
        throw new TransferenciaError(400, "La cantidad aprobada no puede superar la solicitada.");
      }
      if (aprob > 0) algunaAprobada = true;
      await client.query(
        `UPDATE ${tI} SET cantidad_aprobada = $1::numeric, updated_at = now()
          WHERE id = $2::uuid AND transferencia_id = $3::uuid`,
        [aprob, itemId, transferenciaId]
      );
    }
    if (!algunaAprobada) {
      throw new TransferenciaError(400, "Aprobá al menos un producto con cantidad mayor a 0.");
    }

    await client.query(
      `UPDATE ${tT} SET estado = 'aprobada', aprobada_por = $1::uuid, aprobada_at = now(), updated_at = now()
        WHERE id = $2::uuid`,
      [params.usuarioId, transferenciaId]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => null);
    throw e;
  } finally {
    client.release();
  }
}

// ── Rechazar ────────────────────────────────────────────────────────────────
export async function rechazarTransferencia(params: {
  schemaRaw: string;
  empresaId: string;
  transferenciaId: string;
  motivo: string;
  usuarioId: string | null;
}): Promise<void> {
  const schema = assertAllowedChatDataSchema(params.schemaRaw);
  const tT = quoteSchemaTable(schema, "transferencias_inventario");
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ estado: string }>(
      `SELECT estado FROM ${tT} WHERE id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE`,
      [params.transferenciaId, params.empresaId]
    );
    if (!rows[0]) throw new TransferenciaError(404, "Transferencia no encontrada.");
    if (rows[0].estado !== "pendiente") {
      throw new TransferenciaError(409, "Solo se puede rechazar una solicitud pendiente.");
    }
    await client.query(
      `UPDATE ${tT} SET estado = 'rechazada', motivo_rechazo = $1, aprobada_por = $2::uuid,
              rechazada_at = now(), updated_at = now()
        WHERE id = $3::uuid`,
      [params.motivo.slice(0, 500), params.usuarioId, params.transferenciaId]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => null);
    throw e;
  } finally {
    client.release();
  }
}

// ── Cancelar (solo pendiente, por la sucursal solicitante) ──────────────────
export async function cancelarTransferencia(params: {
  schemaRaw: string;
  empresaId: string;
  transferenciaId: string;
  usuarioId: string | null;
}): Promise<void> {
  const schema = assertAllowedChatDataSchema(params.schemaRaw);
  const tT = quoteSchemaTable(schema, "transferencias_inventario");
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ estado: string }>(
      `SELECT estado FROM ${tT} WHERE id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE`,
      [params.transferenciaId, params.empresaId]
    );
    if (!rows[0]) throw new TransferenciaError(404, "Transferencia no encontrada.");
    if (rows[0].estado !== "pendiente") {
      throw new TransferenciaError(409, "Solo se puede cancelar una solicitud pendiente.");
    }
    await client.query(
      `UPDATE ${tT} SET estado = 'cancelada', cancelada_at = now(), updated_at = now() WHERE id = $1::uuid`,
      [params.transferenciaId]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => null);
    throw e;
  } finally {
    client.release();
  }
}

// ── Resolver equivalencia manual (admin/supervisor) ─────────────────────────
export async function resolverEquivalencia(params: {
  schemaRaw: string;
  empresaId: string;
  transferenciaId: string;
  itemId: string;
  productoOrigenId: string;
}): Promise<void> {
  const schema = assertAllowedChatDataSchema(params.schemaRaw);
  const tT = quoteSchemaTable(schema, "transferencias_inventario");
  const tI = quoteSchemaTable(schema, "transferencias_inventario_items");
  const tP = quoteSchemaTable(schema, "productos");
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const { rows: cab } = await client.query<{ estado: string; sucursal_origen_id: string }>(
      `SELECT estado, sucursal_origen_id FROM ${tT} WHERE id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE`,
      [params.transferenciaId, params.empresaId]
    );
    if (!cab[0]) throw new TransferenciaError(404, "Transferencia no encontrada.");
    if (!["pendiente", "aprobada"].includes(cab[0].estado)) {
      throw new TransferenciaError(409, "No se puede cambiar la equivalencia en este estado.");
    }
    // El producto elegido debe ser del ORIGEN, activo y con control de stock.
    const { rows: prod } = await client.query<{ id: string }>(
      `SELECT id FROM ${tP}
        WHERE id = $1::uuid AND empresa_id = $2::uuid AND sucursal_id = $3::uuid
          AND activo = true AND controla_stock = true`,
      [params.productoOrigenId, params.empresaId, cab[0].sucursal_origen_id]
    );
    if (!prod[0]) {
      throw new TransferenciaError(400, "El producto elegido no es válido para la sucursal de origen.");
    }
    const upd = await client.query(
      `UPDATE ${tI} SET producto_origen_id = $1::uuid, updated_at = now()
        WHERE id = $2::uuid AND transferencia_id = $3::uuid`,
      [params.productoOrigenId, params.itemId, params.transferenciaId]
    );
    if (upd.rowCount === 0) throw new TransferenciaError(404, "Ítem no encontrado.");
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => null);
    throw e;
  } finally {
    client.release();
  }
}

// ── Despachar (transacción: descuenta origen + movimientos SALIDA) ──────────
export async function despacharTransferencia(params: {
  schemaRaw: string;
  empresaId: string;
  transferenciaId: string;
  usuarioId: string | null;
  usuarioNombre: string | null;
}): Promise<void> {
  const schema = assertAllowedChatDataSchema(params.schemaRaw);
  const { empresaId, transferenciaId } = params;
  const tT = quoteSchemaTable(schema, "transferencias_inventario");
  const tI = quoteSchemaTable(schema, "transferencias_inventario_items");
  const tP = quoteSchemaTable(schema, "productos");
  const tM = quoteSchemaTable(schema, "movimientos_inventario");

  const client = await pool().connect();
  try {
    await client.query("BEGIN");

    const { rows: cab } = await client.query<{ numero: string; estado: string; sucursal_origen_id: string }>(
      `SELECT numero, estado, sucursal_origen_id FROM ${tT}
        WHERE id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE`,
      [transferenciaId, empresaId]
    );
    if (!cab[0]) throw new TransferenciaError(404, "Transferencia no encontrada.");
    if (cab[0].estado !== "aprobada") {
      // Idempotente: si ya está 'despachada' u otro estado, no se repite el movimiento.
      throw new TransferenciaError(409, "Solo se puede despachar una transferencia aprobada.");
    }
    const numero = cab[0].numero;

    const { rows: items } = await client.query<{
      id: string; producto_origen_id: string | null; cantidad_aprobada: string;
      nombre_snapshot: string; sku_snapshot: string;
    }>(
      `SELECT id, producto_origen_id, cantidad_aprobada, nombre_snapshot, sku_snapshot
         FROM ${tI} WHERE transferencia_id = $1::uuid`,
      [transferenciaId]
    );
    const aDespachar = items.filter((i) => num(i.cantidad_aprobada) > 0);
    if (aDespachar.length === 0) {
      throw new TransferenciaError(400, "No hay cantidades aprobadas para despachar.");
    }
    // Bloqueo de despacho si falta equivalencia en algún ítem aprobado.
    if (aDespachar.some((i) => !i.producto_origen_id)) {
      throw new TransferenciaError(
        409,
        "Hay productos sin equivalencia en la sucursal de origen. Resolvelos antes de despachar."
      );
    }

    for (const it of aDespachar) {
      const cant = num(it.cantidad_aprobada);
      // Bloquear el producto de origen y verificar stock suficiente.
      const { rows: prod } = await client.query<{ stock_actual: string; costo_promedio: string }>(
        `SELECT stock_actual, costo_promedio FROM ${tP}
          WHERE id = $1::uuid AND empresa_id = $2::uuid AND sucursal_id = $3::uuid FOR UPDATE`,
        [it.producto_origen_id, empresaId, cab[0].sucursal_origen_id]
      );
      if (!prod[0]) {
        throw new TransferenciaError(400, `El producto ${it.nombre_snapshot} no existe en el origen.`);
      }
      const stock = num(prod[0].stock_actual);
      if (stock < cant) {
        // Aborta TODA la transacción: no se toca ninguna tabla.
        throw new TransferenciaError(
          409,
          `Stock insuficiente de ${it.nombre_snapshot} en el origen (disponible ${stock}, requerido ${cant}).`
        );
      }
      const costo = num(prod[0].costo_promedio);

      // Descontar stock del origen.
      await client.query(
        `UPDATE ${tP} SET stock_actual = stock_actual - $1::numeric, updated_at = now()
          WHERE id = $2::uuid AND empresa_id = $3::uuid`,
        [cant, it.producto_origen_id, empresaId]
      );

      // Movimiento SALIDA, ligado a la transferencia por referencia = TRF.
      await client.query(
        `INSERT INTO ${tM}
           (empresa_id, sucursal_id, producto_id, producto_nombre, producto_sku,
            tipo, cantidad, costo_unitario, origen, referencia, fecha, created_by, usuario_nombre)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,'SALIDA',$6::numeric,$7::numeric,
                 'transferencia_salida',$8,now(),$9::uuid,$10)`,
        [
          empresaId, cab[0].sucursal_origen_id, it.producto_origen_id, it.nombre_snapshot,
          it.sku_snapshot, cant, costo, numero, params.usuarioId, params.usuarioNombre,
        ]
      );

      // Guardar cantidad despachada y el costo con que sale (para la recepción).
      await client.query(
        `UPDATE ${tI}
            SET cantidad_despachada = $1::numeric, costo_unitario_transferencia = $2::numeric, updated_at = now()
          WHERE id = $3::uuid`,
        [cant, costo, it.id]
      );
    }

    // Ítems aprobados en 0 quedan fuera del despacho (cantidad_despachada = 0).
    await client.query(
      `UPDATE ${tT} SET estado = 'despachada', despachada_por = $1::uuid, despachada_at = now(), updated_at = now()
        WHERE id = $2::uuid`,
      [params.usuarioId, transferenciaId]
    );

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => null);
    throw e;
  } finally {
    client.release();
  }
}

// ── Recibir (transacción: incrementa destino + movimientos ENTRADA) ─────────
export async function recibirTransferencia(params: {
  schemaRaw: string;
  empresaId: string;
  transferenciaId: string;
  usuarioId: string | null;
  usuarioNombre: string | null;
}): Promise<void> {
  const schema = assertAllowedChatDataSchema(params.schemaRaw);
  const { empresaId, transferenciaId } = params;
  const tT = quoteSchemaTable(schema, "transferencias_inventario");
  const tI = quoteSchemaTable(schema, "transferencias_inventario_items");
  const tP = quoteSchemaTable(schema, "productos");
  const tM = quoteSchemaTable(schema, "movimientos_inventario");

  const client = await pool().connect();
  try {
    await client.query("BEGIN");

    const { rows: cab } = await client.query<{ numero: string; estado: string; sucursal_destino_id: string }>(
      `SELECT numero, estado, sucursal_destino_id FROM ${tT}
        WHERE id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE`,
      [transferenciaId, empresaId]
    );
    if (!cab[0]) throw new TransferenciaError(404, "Transferencia no encontrada.");
    if (cab[0].estado !== "despachada") {
      // Idempotente: si ya está 'recibida', no se vuelve a sumar stock.
      throw new TransferenciaError(409, "Solo se puede recibir una transferencia despachada.");
    }
    const numero = cab[0].numero;

    const { rows: items } = await client.query<{
      id: string; producto_destino_id: string; cantidad_despachada: string;
      costo_unitario_transferencia: string; nombre_snapshot: string; sku_snapshot: string;
    }>(
      `SELECT id, producto_destino_id, cantidad_despachada, costo_unitario_transferencia,
              nombre_snapshot, sku_snapshot
         FROM ${tI} WHERE transferencia_id = $1::uuid`,
      [transferenciaId]
    );
    const aRecibir = items.filter((i) => num(i.cantidad_despachada) > 0);

    for (const it of aRecibir) {
      const cant = num(it.cantidad_despachada);
      const costo = num(it.costo_unitario_transferencia);

      // Bloquear el producto destino.
      const { rows: prod } = await client.query<{ id: string }>(
        `SELECT id FROM ${tP}
          WHERE id = $1::uuid AND empresa_id = $2::uuid AND sucursal_id = $3::uuid FOR UPDATE`,
        [it.producto_destino_id, empresaId, cab[0].sucursal_destino_id]
      );
      if (!prod[0]) {
        throw new TransferenciaError(400, `El producto ${it.nombre_snapshot} no existe en el destino.`);
      }

      // Incrementar stock destino + costo promedio (misma lógica que Compras:
      // el costo pasa a ser el costo entrante). NO se toca precio_venta.
      await client.query(
        `UPDATE ${tP}
            SET stock_actual = stock_actual + $1::numeric,
                costo_promedio = $2::numeric,
                updated_at = now()
          WHERE id = $3::uuid AND empresa_id = $4::uuid`,
        [cant, costo, it.producto_destino_id, empresaId]
      );

      await client.query(
        `INSERT INTO ${tM}
           (empresa_id, sucursal_id, producto_id, producto_nombre, producto_sku,
            tipo, cantidad, costo_unitario, origen, referencia, fecha, created_by, usuario_nombre)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,'ENTRADA',$6::numeric,$7::numeric,
                 'transferencia_entrada',$8,now(),$9::uuid,$10)`,
        [
          empresaId, cab[0].sucursal_destino_id, it.producto_destino_id, it.nombre_snapshot,
          it.sku_snapshot, cant, costo, numero, params.usuarioId, params.usuarioNombre,
        ]
      );

      await client.query(
        `UPDATE ${tI} SET cantidad_recibida = $1::numeric, updated_at = now() WHERE id = $2::uuid`,
        [cant, it.id]
      );
    }

    await client.query(
      `UPDATE ${tT} SET estado = 'recibida', recibida_por = $1::uuid, recibida_at = now(), updated_at = now()
        WHERE id = $2::uuid`,
      [params.usuarioId, transferenciaId]
    );

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => null);
    throw e;
  } finally {
    client.release();
  }
}
