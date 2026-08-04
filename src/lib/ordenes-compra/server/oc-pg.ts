/**
 * Órdenes de compra (OC) — capa PG.
 *
 * Crear/emitir una OC NO impacta stock/costo/CxP/movimientos. La RECEPCIÓN
 * reutiliza `insertComprasConImpacto` (compras-pg): crea la compra real, mueve
 * stock, actualiza costo promedio, crea movimientos y —si es crédito— la cuenta
 * por pagar. Luego actualiza las cantidades recibidas y el estado de la OC.
 *
 * Nota de atomicidad: la compra se crea en su propia transacción (atómica para
 * stock/CxP). La actualización de la OC ocurre después, reconsultando el estado
 * bajo FOR UPDATE. La recepción exige estado receptible y acota lo recibido al
 * pendiente, por lo que un reintento no duplica stock (crearía otra compra solo
 * si el usuario confirma de nuevo con cantidades > 0). La UI protege doble clic.
 */
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import type { PoolClient } from "pg";
import {
  insertComprasConImpacto,
  type CompraHeaderInput,
  type CompraItemInput,
} from "@/lib/compras/server/compras-pg";

function pool() {
  const p = getChatPostgresPool();
  if (!p) throw new Error("Pool PG no disponible para órdenes de compra.");
  return p;
}
const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

export class OrdenCompraError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "OrdenCompraError";
    this.status = status;
  }
}

export type OcItemInput = {
  producto_id: string;
  producto_nombre: string;
  sku: string;
  descripcion?: string | null;
  cantidad_solicitada: number;
  costo_estimado: number;
  iva_tipo: string;
};

async function proximoNumeroOC(client: PoolClient, schema: string, empresaId: string): Promise<string> {
  const t = quoteSchemaTable(schema, "ordenes_compra");
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${empresaId}:oc`]);
  const { rows } = await client.query<{ maxn: number | null }>(
    `SELECT COALESCE(MAX(CASE WHEN numero ~ '^OC-[0-9]+$' THEN (substring(numero from 4))::int ELSE 0 END),0) AS maxn
       FROM ${t} WHERE empresa_id = $1::uuid`,
    [empresaId]
  );
  return `OC-${String(Number(rows[0]?.maxn ?? 0) + 1).padStart(6, "0")}`;
}

// ── Crear ─────────────────────────────────────────────────────────────────────
export async function crearOrdenCompra(params: {
  schemaRaw: string;
  empresaId: string;
  sucursalId: string;
  proveedorId: string | null;
  proveedorNombre: string;
  moneda: string;
  tipoCambio: number;
  llegadaEstimada: string | null;
  tipoPago: string;
  plazoDias: number | null;
  observaciones: string | null;
  emitir: boolean;
  items: OcItemInput[];
  usuarioId: string | null;
  usuarioNombre: string | null;
}): Promise<{ id: string; numero: string }> {
  const schema = assertAllowedChatDataSchema(params.schemaRaw);
  if (!params.items.length) throw new OrdenCompraError(400, "La orden debe tener al menos un producto.");
  const tO = quoteSchemaTable(schema, "ordenes_compra");
  const tI = quoteSchemaTable(schema, "ordenes_compra_items");

  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const numero = await proximoNumeroOC(client, schema, params.empresaId);
    const estado = params.emitir ? "emitida" : "borrador";
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO ${tO}
         (empresa_id, sucursal_id, numero, proveedor_id, proveedor_nombre, moneda, tipo_cambio,
          llegada_estimada, tipo_pago, plazo_dias, observaciones, estado, created_by, usuario_nombre)
       VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7::numeric,$8::date,$9,$10::int,$11,$12,$13::uuid,$14)
       RETURNING id`,
      [
        params.empresaId, params.sucursalId, numero, params.proveedorId || null, params.proveedorNombre,
        params.moneda, params.tipoCambio, params.llegadaEstimada, params.tipoPago,
        params.plazoDias, params.observaciones, estado, params.usuarioId, params.usuarioNombre,
      ]
    );
    const ocId = rows[0]!.id;
    for (const it of params.items) {
      const cant = num(it.cantidad_solicitada);
      if (cant <= 0) throw new OrdenCompraError(400, "Las cantidades deben ser mayores a 0.");
      const costo = num(it.costo_estimado);
      // IVA INCLUIDO (modelo PY): el costo ya contiene el IVA; se desglosa el
      // gravado hacia adentro para poblar subtotal (neto) y total (bruto).
      const total = cant * costo;
      const factor = it.iva_tipo === "5" ? 1.05 : it.iva_tipo === "exenta" ? 1 : 1.1;
      const subtotal = total / factor;
      await client.query(
        `INSERT INTO ${tI}
           (orden_compra_id, empresa_id, producto_id, producto_nombre, sku_snapshot, descripcion,
            cantidad_solicitada, costo_estimado, iva_tipo, subtotal, total)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::numeric,$8::numeric,$9,$10::numeric,$11::numeric)`,
        [ocId, params.empresaId, it.producto_id, it.producto_nombre, it.sku, it.descripcion ?? null,
         cant, costo, it.iva_tipo, Math.round(subtotal), Math.round(total)]
      );
    }
    await client.query("COMMIT");
    return { id: ocId, numero };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => null);
    throw e;
  } finally {
    client.release();
  }
}

// ── Cambiar estado (emitir / aprobar / cancelar) ─────────────────────────────
const TRANSICIONES: Record<string, string[]> = {
  emitida: ["borrador"],
  aprobada: ["emitida"],
  cancelada: ["borrador", "emitida", "aprobada", "parcialmente_recibida"],
};
export async function cambiarEstadoOrden(params: {
  schemaRaw: string; empresaId: string; sucursalId: string; id: string; nuevoEstado: string;
}): Promise<void> {
  const schema = assertAllowedChatDataSchema(params.schemaRaw);
  const permitidos = TRANSICIONES[params.nuevoEstado];
  if (!permitidos) throw new OrdenCompraError(400, "Transición de estado no permitida.");
  const tO = quoteSchemaTable(schema, "ordenes_compra");
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ estado: string }>(
      `SELECT estado FROM ${tO} WHERE id=$1::uuid AND empresa_id=$2::uuid AND sucursal_id=$3::uuid FOR UPDATE`,
      [params.id, params.empresaId, params.sucursalId]
    );
    if (!rows[0]) throw new OrdenCompraError(404, "Orden no encontrada.");
    if (!permitidos.includes(rows[0].estado)) {
      throw new OrdenCompraError(409, `No se puede pasar de '${rows[0].estado}' a '${params.nuevoEstado}'.`);
    }
    await client.query(`UPDATE ${tO} SET estado=$1, updated_at=now() WHERE id=$2::uuid`, [params.nuevoEstado, params.id]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => null);
    throw e;
  } finally {
    client.release();
  }
}

// ── Listar / detalle ─────────────────────────────────────────────────────────
export async function listOrdenesCompra(schemaRaw: string, empresaId: string, sucursalId: string) {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tO = quoteSchemaTable(schema, "ordenes_compra");
  const tI = quoteSchemaTable(schema, "ordenes_compra_items");
  const { rows } = await pool().query(
    `SELECT o.id, o.numero, o.proveedor_nombre, o.estado, o.moneda, o.fecha, o.llegada_estimada,
            o.tipo_pago, o.plazo_dias,
            (SELECT count(*) FROM ${tI} i WHERE i.orden_compra_id=o.id)::int AS items_count,
            (SELECT COALESCE(SUM(i.total),0) FROM ${tI} i WHERE i.orden_compra_id=o.id) AS total,
            (SELECT COALESCE(SUM(GREATEST(0, i.cantidad_solicitada - i.cantidad_recibida) * i.costo_estimado),0)
               FROM ${tI} i WHERE i.orden_compra_id=o.id) AS total_pendiente
       FROM ${tO} o
      WHERE o.empresa_id=$1::uuid AND o.sucursal_id=$2::uuid
      ORDER BY o.created_at DESC LIMIT 500`,
    [empresaId, sucursalId]
  );
  return rows.map((r) => ({
    ...r,
    fecha: r.fecha,
    llegada_estimada: r.llegada_estimada ? String(r.llegada_estimada).slice(0, 10) : null,
    total: num(r.total),
    total_pendiente: num(r.total_pendiente),
    items_count: Number(r.items_count) || 0,
  }));
}

export async function getOrdenCompra(schemaRaw: string, empresaId: string, sucursalId: string, id: string) {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tO = quoteSchemaTable(schema, "ordenes_compra");
  const tI = quoteSchemaTable(schema, "ordenes_compra_items");
  const { rows: cab } = await pool().query(
    `SELECT * FROM ${tO} WHERE id=$1::uuid AND empresa_id=$2::uuid AND sucursal_id=$3::uuid`,
    [id, empresaId, sucursalId]
  );
  if (!cab[0]) return null;
  const { rows: items } = await pool().query(
    `SELECT id, producto_id, producto_nombre, sku_snapshot, descripcion,
            cantidad_solicitada, cantidad_recibida, costo_estimado, iva_tipo, subtotal, total
       FROM ${tI} WHERE orden_compra_id=$1::uuid ORDER BY created_at ASC`,
    [id]
  );
  return { cabecera: cab[0], items };
}

// ── Recepción (crea la compra real, actualiza cantidades y estado) ───────────
export async function recibirOrdenCompra(params: {
  schemaRaw: string;
  empresaId: string;
  sucursalId: string;
  id: string;
  recepciones: Array<{ item_id: string; cantidad: number; costo_unitario: number }>;
  nroTimbrado: string;
  numeroFacturaProveedor: string | null;
  fechaFactura: string | null;
  metodoPago: string | null;
  comprobante: { path: string | null; nombre: string | null; mime: string | null } | null;
  usuarioId: string | null;
  usuarioNombre: string | null;
}): Promise<{ numero_control: string }> {
  const schema = assertAllowedChatDataSchema(params.schemaRaw);
  const { empresaId, sucursalId } = params;
  const tO = quoteSchemaTable(schema, "ordenes_compra");
  const tI = quoteSchemaTable(schema, "ordenes_compra_items");

  // 1) Cargar OC + items, validar estado receptible.
  const det = await getOrdenCompra(schema, empresaId, sucursalId, params.id);
  if (!det) throw new OrdenCompraError(404, "Orden no encontrada.");
  const cab = det.cabecera as Record<string, unknown>;
  const estado = String(cab.estado);
  if (!["emitida", "aprobada", "parcialmente_recibida"].includes(estado)) {
    throw new OrdenCompraError(409, "Solo se puede recibir una orden emitida, aprobada o parcialmente recibida.");
  }
  const itemsById = new Map((det.items as Array<Record<string, unknown>>).map((i) => [String(i.id), i]));

  // 2) Armar los ítems de la compra a partir de lo recibido (> 0).
  const recepMap = new Map(params.recepciones.map((r) => [r.item_id, r]));
  const compraItems: CompraItemInput[] = [];
  const aplicadas: Array<{ item_id: string; cantidad: number }> = [];
  for (const [itemId, rec] of recepMap) {
    const it = itemsById.get(itemId);
    if (!it) continue;
    const cant = num(rec.cantidad);
    if (cant <= 0) continue;
    const solicitada = num(it.cantidad_solicitada);
    const yaRecibida = num(it.cantidad_recibida);
    const pendiente = Math.max(0, solicitada - yaRecibida);
    if (cant > pendiente) {
      throw new OrdenCompraError(400, `No podés recibir más de lo pendiente de ${it.producto_nombre} (pendiente ${pendiente}).`);
    }
    const costo = num(rec.costo_unitario);
    const ivaTipo = String(it.iva_tipo || "10");
    const subtotal = cant * costo;
    const iva = ivaTipo === "10" ? subtotal / 11 : ivaTipo === "5" ? subtotal / 21 : 0;
    compraItems.push({
      producto_id: String(it.producto_id),
      producto_nombre: String(it.producto_nombre),
      cantidad: cant,
      costo_unitario_original: costo,
      costo_unitario: costo,
      iva_tipo: ivaTipo,
      subtotal,
      monto_iva: Math.round(iva),
      total: subtotal,
      precio_venta: 0, // no pisa el precio de venta del producto
      margen_venta: null,
    });
    aplicadas.push({ item_id: itemId, cantidad: cant });
  }
  if (compraItems.length === 0) throw new OrdenCompraError(400, "Indicá al menos una cantidad recibida.");

  // 3) Crear la compra real (atómico: stock + costo + movimientos + CxP si crédito).
  const header: CompraHeaderInput = {
    proveedor_id: String(cab.proveedor_id ?? "") || "",
    proveedor_nombre: String(cab.proveedor_nombre ?? ""),
    moneda: String(cab.moneda ?? "PYG"),
    tipo_cambio: num(cab.tipo_cambio) || 1,
    tipo_pago: String(cab.tipo_pago ?? "contado"),
    plazo_dias: cab.plazo_dias != null ? Number(cab.plazo_dias) : null,
    nro_timbrado: (params.nroTimbrado || "").trim().toUpperCase(),
    numero_factura_proveedor: params.numeroFacturaProveedor,
    fecha_factura: params.fechaFactura,
    metodo_pago: params.metodoPago,
    comprobante_url: null,
    comprobante_storage_path: params.comprobante?.path ?? null,
    comprobante_nombre: params.comprobante?.nombre ?? null,
    comprobante_mime_type: params.comprobante?.mime ?? null,
    created_by: params.usuarioId,
    usuario_nombre: params.usuarioNombre,
  };
  if (!header.proveedor_id) throw new OrdenCompraError(400, "La orden no tiene proveedor válido para generar la compra.");
  if (!header.nro_timbrado) throw new OrdenCompraError(400, "Ingresá el N° de timbrado de la factura recibida.");

  const out = await insertComprasConImpacto(schema, empresaId, sucursalId, header, compraItems);

  // 4) Actualizar cantidades recibidas + estado de la OC (reconsultando bajo FOR UPDATE).
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT id FROM ${tO} WHERE id=$1::uuid AND empresa_id=$2::uuid AND sucursal_id=$3::uuid FOR UPDATE`,
      [params.id, empresaId, sucursalId]
    );
    for (const a of aplicadas) {
      await client.query(
        `UPDATE ${tI} SET cantidad_recibida = cantidad_recibida + $1::numeric, updated_at=now()
          WHERE id=$2::uuid AND orden_compra_id=$3::uuid`,
        [a.cantidad, a.item_id, params.id]
      );
    }
    // Estado: recibida si todo lo solicitado quedó recibido; si no, parcial.
    const { rows: pend } = await client.query<{ pendiente: string }>(
      `SELECT COALESCE(SUM(GREATEST(0, cantidad_solicitada - cantidad_recibida)),0) AS pendiente
         FROM ${tI} WHERE orden_compra_id=$1::uuid`,
      [params.id]
    );
    const nuevoEstado = num(pend[0]?.pendiente) <= 0 ? "recibida" : "parcialmente_recibida";
    await client.query(
      `UPDATE ${tO} SET estado=$1,
              observaciones = COALESCE(observaciones,'') ||
                CASE WHEN COALESCE(observaciones,'')='' THEN '' ELSE E'\n' END ||
                'Recepción ' || $2,
              updated_at=now()
        WHERE id=$3::uuid`,
      [nuevoEstado, out.numero_control, params.id]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => null);
    // La compra ya se creó; informamos pero no la deshacemos (stock ya impactado).
    console.error("[oc-pg] compra creada pero fallo al actualizar la OC", e instanceof Error ? e.message : e);
  } finally {
    client.release();
  }

  return { numero_control: out.numero_control };
}
