/**
 * Notas de crédito de PROVEEDOR (lado compra) — capa PG transaccional.
 *
 * Mismo patrón que compras-pg / transferencias-pg: pool() + BEGIN/FOR UPDATE/COMMIT.
 *
 * Alcance (decidido con el cliente):
 *  - Siempre vinculada a una compra ya registrada (compras.numero_control).
 *  - tipo='devolucion' -> descuenta stock de los productos devueltos + movimiento
 *    SALIDA (origen='nota_credito_compra'). tipo='descuento' -> solo documental.
 *  - NO mantiene deuda al proveedor (no hay cuentas_por_pagar) ni revierte
 *    costo_promedio / precio_venta (igual criterio que anular compra).
 *
 * Idempotencia del stock: la máquina de estados (registrada -> anulada) bajo
 * FOR UPDATE. Anular una NC ya anulada aborta; nunca duplica movimientos.
 */
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import { aplicarNCaCuentaPorPagar, revertirNCdeCuentaPorPagar } from "@/lib/cuentas-por-pagar/server/cxp-pg";
import type { PoolClient } from "pg";

function pool() {
  const p = getChatPostgresPool();
  if (!p) throw new Error("Pool PG no disponible para notas de crédito de compra.");
  return p;
}

export type TipoNotaCreditoCompra = "devolucion" | "descuento";

/** Error de dominio con status HTTP asociado (lo traduce el route). */
export class NotaCreditoCompraError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "NotaCreditoCompraError";
    this.status = status;
  }
}

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

// ── Tipos de salida ─────────────────────────────────────────────────────────
export type CompraParaNC = {
  numero_control: string;
  numero_factura_proveedor: string | null;
  proveedor_id: string | null;
  proveedor_nombre: string;
  moneda: string;
  lineas: Array<{
    producto_id: string;
    producto_nombre: string;
    sku: string;
    cantidad_comprada: number;
    costo_unitario: number;
    iva_tipo: string;
  }>;
};

export type NCCItemInput = {
  producto_id: string;
  producto_nombre: string;
  sku: string;
  cantidad: number;
  costo_unitario: number;
  subtotal: number;
};

export type ResumenNCC = {
  id: string;
  numero: string;
  compra_numero_control: string;
  proveedor_nombre: string;
  numero_documento: string | null;
  fecha_documento: string | null;
  tipo: string;
  motivo: string | null;
  moneda: string;
  subtotal: number;
  monto_iva: number;
  total: number;
  estado: string;
  items_count: number;
  created_at: string;
};

// ── Lookup de la compra a corregir ───────────────────────────────────────────
/**
 * Devuelve el proveedor y las líneas (agregadas por producto) de una compra
 * NO anulada, dentro de la empresa+sucursal. El término de búsqueda puede ser el
 * número REAL de factura del proveedor o el correlativo interno COMP-XXXXXX.
 * Primero resuelve a UN único numero_control (el más reciente que coincida) para
 * no mezclar líneas de compras distintas. null si no hay coincidencia.
 */
export async function getCompraParaNC(
  schemaRaw: string,
  empresaId: string,
  sucursalId: string,
  busqueda: string
): Promise<CompraParaNC | null> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tC = quoteSchemaTable(schema, "compras");
  const termino = busqueda.trim();
  if (!termino) return null;

  // 1) Resolver a un único numero_control (por COMP interno o por factura real).
  const { rows: head } = await pool().query<{
    numero_control: string;
    numero_factura_proveedor: string | null;
    proveedor_id: string | null;
    proveedor_nombre: string;
    moneda: string;
  }>(
    `SELECT numero_control, numero_factura_proveedor, proveedor_id, proveedor_nombre, moneda
       FROM ${tC}
      WHERE empresa_id = $1::uuid AND sucursal_id = $2::uuid
        AND COALESCE(estado, '') <> 'anulada'
        AND (numero_control = $3 OR numero_factura_proveedor = $3)
      ORDER BY fecha DESC
      LIMIT 1`,
    [empresaId, sucursalId, termino]
  );
  if (!head[0]) return null;
  const numeroControl = head[0].numero_control;

  // 2) Cargar las líneas de esa compra.
  const { rows } = await pool().query<{
    producto_id: string;
    producto_nombre: string;
    sku: string | null;
    cantidad: string;
    costo_unitario: string;
    iva_tipo: string;
  }>(
    `SELECT c.producto_id, c.producto_nombre,
            COALESCE(p.sku, '') AS sku,
            c.cantidad, c.costo_unitario, c.iva_tipo
       FROM ${tC} c
       LEFT JOIN ${quoteSchemaTable(schema, "productos")} p ON p.id = c.producto_id
      WHERE c.empresa_id = $1::uuid AND c.sucursal_id = $2::uuid
        AND c.numero_control = $3
        AND COALESCE(c.estado, '') <> 'anulada'`,
    [empresaId, sucursalId, numeroControl]
  );
  if (rows.length === 0) return null;

  // Agregar por producto (una compra puede repetir el mismo producto en líneas).
  const byProd = new Map<string, CompraParaNC["lineas"][number]>();
  for (const r of rows) {
    const prev = byProd.get(r.producto_id);
    if (prev) {
      prev.cantidad_comprada += num(r.cantidad);
    } else {
      byProd.set(r.producto_id, {
        producto_id: r.producto_id,
        producto_nombre: r.producto_nombre,
        sku: r.sku ?? "",
        cantidad_comprada: num(r.cantidad),
        costo_unitario: num(r.costo_unitario),
        iva_tipo: r.iva_tipo,
      });
    }
  }
  return {
    numero_control: numeroControl,
    numero_factura_proveedor: head[0].numero_factura_proveedor,
    proveedor_id: head[0].proveedor_id,
    proveedor_nombre: head[0].proveedor_nombre,
    moneda: head[0].moneda,
    lineas: [...byProd.values()],
  };
}

/** Próximo NCC-XXXXXX seguro ante concurrencia (advisory lock por empresa + MAX+1). */
async function proximoNumeroNCC(
  client: PoolClient,
  schema: string,
  empresaId: string
): Promise<string> {
  const t = quoteSchemaTable(schema, "notas_credito_compra");
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${empresaId}:ncc`]);
  const { rows } = await client.query<{ maxn: number | null }>(
    `SELECT COALESCE(MAX(
       CASE WHEN numero ~ '^NCC-[0-9]+$' THEN (substring(numero from 5))::int ELSE 0 END
     ), 0) AS maxn
     FROM ${t} WHERE empresa_id = $1::uuid`,
    [empresaId]
  );
  const next = Number(rows[0]?.maxn ?? 0) + 1;
  return `NCC-${String(next).padStart(6, "0")}`;
}

// ── Crear ────────────────────────────────────────────────────────────────────
export async function crearNotaCreditoCompra(params: {
  schemaRaw: string;
  empresaId: string;
  sucursalId: string;
  compraNumeroControl: string;
  tipo: TipoNotaCreditoCompra;
  numeroDocumento: string | null;
  fechaDocumento: string | null;
  motivo: string | null;
  subtotal: number;
  montoIva: number;
  total: number;
  comprobante: { path: string | null; nombre: string | null; mime: string | null } | null;
  items: NCCItemInput[];
  usuarioId: string | null;
  usuarioNombre: string | null;
}): Promise<{ id: string; numero: string }> {
  const schema = assertAllowedChatDataSchema(params.schemaRaw);
  const { empresaId, sucursalId } = params;
  const tNC = quoteSchemaTable(schema, "notas_credito_compra");
  const tNCI = quoteSchemaTable(schema, "notas_credito_compra_items");
  const tP = quoteSchemaTable(schema, "productos");
  const tM = quoteSchemaTable(schema, "movimientos_inventario");

  if (params.tipo !== "devolucion" && params.tipo !== "descuento") {
    throw new NotaCreditoCompraError(400, "Tipo inválido (devolucion | descuento).");
  }

  // La compra debe existir y no estar anulada. Toma el proveedor de ahí.
  const compra = await getCompraParaNC(schema, empresaId, sucursalId, params.compraNumeroControl);
  if (!compra) {
    throw new NotaCreditoCompraError(400, "La compra indicada no existe en tu sucursal o está anulada.");
  }
  const lineasCompra = new Map(compra.lineas.map((l) => [l.producto_id, l]));

  // Validaciones de ítems.
  if (params.tipo === "devolucion") {
    if (params.items.length === 0) {
      throw new NotaCreditoCompraError(400, "Una devolución debe indicar al menos un producto.");
    }
    for (const it of params.items) {
      const linea = lineasCompra.get(it.producto_id);
      if (!linea) {
        throw new NotaCreditoCompraError(400, `El producto ${it.producto_nombre} no pertenece a la compra ${compra.numero_control}.`);
      }
      if (num(it.cantidad) <= 0) {
        throw new NotaCreditoCompraError(400, `La cantidad devuelta de ${it.producto_nombre} debe ser mayor a 0.`);
      }
      if (num(it.cantidad) > linea.cantidad_comprada) {
        throw new NotaCreditoCompraError(400, `No podés devolver más de lo comprado de ${it.producto_nombre} (comprado ${linea.cantidad_comprada}).`);
      }
    }
  }

  const client = await pool().connect();
  try {
    await client.query("BEGIN");

    const numero = await proximoNumeroNCC(client, schema, empresaId);

    const { rows: cab } = await client.query<{ id: string }>(
      `INSERT INTO ${tNC}
         (empresa_id, sucursal_id, numero, compra_numero_control, proveedor_id, proveedor_nombre,
          numero_documento, fecha_documento, tipo, motivo, moneda,
          subtotal, monto_iva, total,
          comprobante_storage_path, comprobante_nombre, comprobante_mime_type,
          estado, created_by, usuario_nombre)
       VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,
               $7,$8::date,$9,$10,$11,
               $12::numeric,$13::numeric,$14::numeric,
               $15,$16,$17,
               'registrada',$18::uuid,$19)
       RETURNING id`,
      [
        empresaId, sucursalId, numero, compra.numero_control,
        compra.proveedor_id, compra.proveedor_nombre,
        params.numeroDocumento, params.fechaDocumento, params.tipo, params.motivo, compra.moneda,
        num(params.subtotal), num(params.montoIva), num(params.total),
        params.comprobante?.path ?? null, params.comprobante?.nombre ?? null, params.comprobante?.mime ?? null,
        params.usuarioId, params.usuarioNombre,
      ]
    );
    const ncId = cab[0]!.id;

    // Ítems: en 'descuento' pueden venir vacíos (nota puramente financiera).
    for (const it of params.items) {
      await client.query(
        `INSERT INTO ${tNCI}
           (nota_credito_compra_id, empresa_id, producto_id, producto_nombre, sku_snapshot,
            cantidad, costo_unitario, subtotal)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::numeric,$7::numeric,$8::numeric)`,
        [ncId, empresaId, it.producto_id, it.producto_nombre, it.sku,
         num(it.cantidad), num(it.costo_unitario), num(it.subtotal)]
      );
    }

    // Impacto de stock solo en devolución.
    if (params.tipo === "devolucion") {
      for (const it of params.items) {
        const cant = num(it.cantidad);
        if (cant <= 0) continue;
        const { rows: prod } = await client.query<{ stock_actual: string; sku: string | null }>(
          `SELECT stock_actual, sku FROM ${tP}
            WHERE id = $1::uuid AND empresa_id = $2::uuid AND sucursal_id = $3::uuid FOR UPDATE`,
          [it.producto_id, empresaId, sucursalId]
        );
        if (!prod[0]) {
          throw new NotaCreditoCompraError(400, `El producto ${it.producto_nombre} no existe en tu sucursal.`);
        }
        const stock = num(prod[0].stock_actual);
        if (stock < cant) {
          throw new NotaCreditoCompraError(
            409,
            `Stock insuficiente de ${it.producto_nombre} para devolver (disponible ${stock}, a devolver ${cant}).`
          );
        }
        await client.query(
          `UPDATE ${tP} SET stock_actual = stock_actual - $1::numeric, updated_at = now()
            WHERE id = $2::uuid AND empresa_id = $3::uuid`,
          [cant, it.producto_id, empresaId]
        );
        await client.query(
          `INSERT INTO ${tM}
             (empresa_id, sucursal_id, producto_id, producto_nombre, producto_sku,
              tipo, cantidad, costo_unitario, origen, referencia, fecha, created_by, usuario_nombre)
           VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,'SALIDA',$6::numeric,$7::numeric,
                   'nota_credito_compra',$8,now(),$9::uuid,$10)`,
          [
            empresaId, sucursalId, it.producto_id, it.producto_nombre, it.sku ?? prod[0].sku ?? "",
            cant, num(it.costo_unitario), numero, params.usuarioId, params.usuarioNombre,
          ]
        );
      }
    }

    // Reducir el saldo de la cuenta por pagar de la compra (si existe).
    // Best-effort bajo SAVEPOINT: no aborta la NC si algo falla.
    try {
      await client.query("SAVEPOINT sp_cxp_nc");
      await aplicarNCaCuentaPorPagar(client, schema, empresaId, compra.numero_control, num(params.total));
      await client.query("RELEASE SAVEPOINT sp_cxp_nc");
    } catch (e) {
      await client.query("ROLLBACK TO SAVEPOINT sp_cxp_nc").catch(() => null);
      console.error("[nc-compra-pg] aplicar NC a cuenta por pagar falló (best-effort)", e instanceof Error ? e.message : e);
    }

    await client.query("COMMIT");
    return { id: ncId, numero };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => null);
    throw e;
  } finally {
    client.release();
  }
}

// ── Listar ───────────────────────────────────────────────────────────────────
export async function listNotasCreditoCompra(
  schemaRaw: string,
  empresaId: string,
  sucursalId: string
): Promise<ResumenNCC[]> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tNC = quoteSchemaTable(schema, "notas_credito_compra");
  const tNCI = quoteSchemaTable(schema, "notas_credito_compra_items");
  const { rows } = await pool().query<ResumenNCC & { subtotal: string; monto_iva: string; total: string; items_count: string }>(
    `SELECT nc.id, nc.numero, nc.compra_numero_control, nc.proveedor_nombre,
            nc.numero_documento, nc.fecha_documento, nc.tipo, nc.motivo, nc.moneda,
            nc.subtotal, nc.monto_iva, nc.total, nc.estado,
            nc.created_at,
            (SELECT count(*) FROM ${tNCI} i WHERE i.nota_credito_compra_id = nc.id) AS items_count
       FROM ${tNC} nc
      WHERE nc.empresa_id = $1::uuid AND nc.sucursal_id = $2::uuid
      ORDER BY nc.created_at DESC
      LIMIT 500`,
    [empresaId, sucursalId]
  );
  return rows.map((r) => ({
    ...r,
    subtotal: num(r.subtotal),
    monto_iva: num(r.monto_iva),
    total: num(r.total),
    items_count: Number(r.items_count) || 0,
  }));
}

// ── Detalle ──────────────────────────────────────────────────────────────────
export async function getNotaCreditoCompra(
  schemaRaw: string,
  empresaId: string,
  id: string
): Promise<{ cabecera: Record<string, unknown>; items: Array<Record<string, unknown>> } | null> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tNC = quoteSchemaTable(schema, "notas_credito_compra");
  const tNCI = quoteSchemaTable(schema, "notas_credito_compra_items");
  const { rows: cab } = await pool().query(
    `SELECT * FROM ${tNC} WHERE id = $1::uuid AND empresa_id = $2::uuid`,
    [id, empresaId]
  );
  if (!cab[0]) return null;
  const { rows: items } = await pool().query(
    `SELECT id, producto_id, producto_nombre, sku_snapshot, cantidad, costo_unitario, subtotal
       FROM ${tNCI} WHERE nota_credito_compra_id = $1::uuid ORDER BY created_at ASC`,
    [id]
  );
  return { cabecera: cab[0], items };
}

// ── Anular (reversa el stock si era devolución) ──────────────────────────────
export async function anularNotaCreditoCompra(params: {
  schemaRaw: string;
  empresaId: string;
  id: string;
  motivo: string;
  usuarioId: string | null;
  usuarioNombre: string | null;
}): Promise<void> {
  const schema = assertAllowedChatDataSchema(params.schemaRaw);
  const { empresaId, id } = params;
  const tNC = quoteSchemaTable(schema, "notas_credito_compra");
  const tNCI = quoteSchemaTable(schema, "notas_credito_compra_items");
  const tP = quoteSchemaTable(schema, "productos");
  const tM = quoteSchemaTable(schema, "movimientos_inventario");

  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const { rows: cab } = await client.query<{
      numero: string; estado: string; tipo: string; sucursal_id: string;
      compra_numero_control: string; total: string;
    }>(
      `SELECT numero, estado, tipo, sucursal_id, compra_numero_control, total FROM ${tNC}
        WHERE id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE`,
      [id, empresaId]
    );
    if (!cab[0]) throw new NotaCreditoCompraError(404, "Nota de crédito no encontrada.");
    if (cab[0].estado !== "registrada") {
      throw new NotaCreditoCompraError(409, "La nota de crédito ya fue anulada.");
    }
    const numero = cab[0].numero;

    // Reintegrar stock si fue devolución.
    if (cab[0].tipo === "devolucion") {
      const { rows: items } = await client.query<{
        producto_id: string; producto_nombre: string; sku_snapshot: string | null;
        cantidad: string; costo_unitario: string;
      }>(
        `SELECT producto_id, producto_nombre, sku_snapshot, cantidad, costo_unitario
           FROM ${tNCI} WHERE nota_credito_compra_id = $1::uuid`,
        [id]
      );
      for (const it of items) {
        const cant = num(it.cantidad);
        if (cant <= 0 || !it.producto_id) continue;
        const { rows: prod } = await client.query<{ id: string; sku: string | null }>(
          `SELECT id, sku FROM ${tP}
            WHERE id = $1::uuid AND empresa_id = $2::uuid AND sucursal_id = $3::uuid FOR UPDATE`,
          [it.producto_id, empresaId, cab[0].sucursal_id]
        );
        if (!prod[0]) continue; // producto borrado: no se puede reintegrar.
        await client.query(
          `UPDATE ${tP} SET stock_actual = stock_actual + $1::numeric, updated_at = now()
            WHERE id = $2::uuid AND empresa_id = $3::uuid`,
          [cant, it.producto_id, empresaId]
        );
        await client.query(
          `INSERT INTO ${tM}
             (empresa_id, sucursal_id, producto_id, producto_nombre, producto_sku,
              tipo, cantidad, costo_unitario, origen, referencia, fecha, created_by, usuario_nombre)
           VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,'ENTRADA',$6::numeric,$7::numeric,
                   'nota_credito_compra',$8,now(),$9::uuid,$10)`,
          [
            empresaId, cab[0].sucursal_id, it.producto_id, it.producto_nombre,
            it.sku_snapshot ?? prod[0].sku ?? "", cant, num(it.costo_unitario),
            `Anulación ${numero}`, params.usuarioId, params.usuarioNombre,
          ]
        );
      }
    }

    await client.query(
      `UPDATE ${tNC}
          SET estado = 'anulada', anulada_at = now(), anulada_por = $1::uuid,
              anulacion_motivo = $2, updated_at = now()
        WHERE id = $3::uuid`,
      [params.usuarioId, params.motivo.slice(0, 2000), id]
    );

    // Revertir el impacto de la NC en la cuenta por pagar (best-effort).
    try {
      await client.query("SAVEPOINT sp_cxp_ncrev");
      await revertirNCdeCuentaPorPagar(client, schema, empresaId, cab[0].compra_numero_control, num(cab[0].total));
      await client.query("RELEASE SAVEPOINT sp_cxp_ncrev");
    } catch (e) {
      await client.query("ROLLBACK TO SAVEPOINT sp_cxp_ncrev").catch(() => null);
      console.error("[nc-compra-pg] revertir NC de cuenta por pagar falló (best-effort)", e instanceof Error ? e.message : e);
    }

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => null);
    throw e;
  } finally {
    client.release();
  }
}
