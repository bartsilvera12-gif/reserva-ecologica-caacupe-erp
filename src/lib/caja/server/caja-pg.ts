/**
 * Caja por sucursal (turno + arqueo) — capa PG.
 *
 * Una caja abierta por sucursal (índice parcial único). El arqueo se calcula por
 * VENTANA DE TIEMPO [abierta_at, cierre] filtrando por sucursal, sin depender de
 * ventas.caja_id ni de hooks en ventas/cobros (esos flujos quedan intactos).
 *
 * Efectivo esperado =
 *   apertura + ventas contado efectivo + cobros efectivo + ingresos efectivo
 *   + ajustes efectivo - egresos efectivo - retiros efectivo.
 * Tarjeta/transferencia suman al total vendido pero NO al efectivo físico.
 * Ventas a crédito no cuentan como efectivo (entran cuando se cobran).
 */
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import type { ArqueoItem } from "@/lib/caja/denominaciones";
import type { Pool, PoolClient } from "pg";

function pool() {
  const p = getChatPostgresPool();
  if (!p) throw new Error("Pool PG no disponible para caja.");
  return p;
}
const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

export class CajaError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "CajaError";
    this.status = status;
  }
}

type Querier = Pool | PoolClient;

export type Arqueo = {
  monto_apertura: number;
  ventas_efectivo: number;
  ventas_tarjeta: number;
  ventas_transferencia: number;
  ventas_credito: number;
  ventas_total: number;
  cobros_efectivo: number;
  cobros_total: number;
  ingresos_efectivo: number;
  egresos_efectivo: number;
  retiros_efectivo: number;
  ajustes_efectivo: number;
  ingresos_total: number;
  salidas_total: number;
  efectivo_esperado: number;
};

/** Calcula el arqueo de una caja por ventana de tiempo. `hasta` null = ahora. */
export async function calcularArqueo(
  q: Querier,
  schemaRaw: string,
  empresaId: string,
  sucursalId: string,
  caja: { id: string; monto_apertura: number; abierta_at: string; cerrada_at: string | null }
): Promise<Arqueo> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tV = quoteSchemaTable(schema, "ventas");
  const tC = quoteSchemaTable(schema, "cobros_clientes");
  const tM = quoteSchemaTable(schema, "caja_movimientos");
  const desde = caja.abierta_at;
  const hasta = caja.cerrada_at; // null => now()

  const { rows: v } = await q.query(
    `SELECT
       COALESCE(SUM(total) FILTER (WHERE tipo_venta='CONTADO' AND metodo_pago='efectivo'),0) ventas_efectivo,
       COALESCE(SUM(total) FILTER (WHERE tipo_venta='CONTADO' AND metodo_pago='tarjeta'),0) ventas_tarjeta,
       COALESCE(SUM(total) FILTER (WHERE tipo_venta='CONTADO' AND metodo_pago='transferencia'),0) ventas_transferencia,
       COALESCE(SUM(total) FILTER (WHERE tipo_venta='CREDITO'),0) ventas_credito,
       COALESCE(SUM(total),0) ventas_total
     FROM ${tV}
     WHERE empresa_id=$1::uuid AND sucursal_id=$2::uuid AND estado='completada'
       AND fecha >= $3::timestamptz AND fecha <= COALESCE($4::timestamptz, now())`,
    [empresaId, sucursalId, desde, hasta]
  );
  const { rows: co } = await q.query(
    `SELECT
       COALESCE(SUM(monto) FILTER (WHERE metodo_pago='efectivo'),0) cobros_efectivo,
       COALESCE(SUM(monto),0) cobros_total
     FROM ${tC}
     WHERE empresa_id=$1::uuid AND sucursal_id=$2::uuid
       AND fecha_pago >= $3::timestamptz AND fecha_pago <= COALESCE($4::timestamptz, now())`,
    [empresaId, sucursalId, desde, hasta]
  );
  const { rows: m } = await q.query(
    `SELECT
       COALESCE(SUM(monto) FILTER (WHERE tipo='ingreso' AND metodo_pago='efectivo'),0) ingresos_efectivo,
       COALESCE(SUM(monto) FILTER (WHERE tipo='egreso'  AND metodo_pago='efectivo'),0) egresos_efectivo,
       COALESCE(SUM(monto) FILTER (WHERE tipo='retiro'  AND metodo_pago='efectivo'),0) retiros_efectivo,
       COALESCE(SUM(monto) FILTER (WHERE tipo='ajuste'  AND metodo_pago='efectivo'),0) ajustes_efectivo,
       COALESCE(SUM(monto) FILTER (WHERE tipo='ingreso'),0) ingresos_total,
       COALESCE(SUM(monto) FILTER (WHERE tipo IN ('egreso','retiro')),0) salidas_total
     FROM ${tM} WHERE caja_id=$1::uuid`,
    [caja.id]
  );

  const apertura = num(caja.monto_apertura);
  const a: Arqueo = {
    monto_apertura: apertura,
    ventas_efectivo: num(v[0].ventas_efectivo),
    ventas_tarjeta: num(v[0].ventas_tarjeta),
    ventas_transferencia: num(v[0].ventas_transferencia),
    ventas_credito: num(v[0].ventas_credito),
    ventas_total: num(v[0].ventas_total),
    cobros_efectivo: num(co[0].cobros_efectivo),
    cobros_total: num(co[0].cobros_total),
    ingresos_efectivo: num(m[0].ingresos_efectivo),
    egresos_efectivo: num(m[0].egresos_efectivo),
    retiros_efectivo: num(m[0].retiros_efectivo),
    ajustes_efectivo: num(m[0].ajustes_efectivo),
    ingresos_total: num(m[0].ingresos_total),
    salidas_total: num(m[0].salidas_total),
    efectivo_esperado: 0,
  };
  a.efectivo_esperado =
    a.monto_apertura + a.ventas_efectivo + a.cobros_efectivo +
    a.ingresos_efectivo + a.ajustes_efectivo -
    a.egresos_efectivo - a.retiros_efectivo;
  return a;
}

export type CajaRow = {
  id: string; numero_caja: number; estado: string; monto_apertura: number;
  abierta_at: string; cerrada_at: string | null;
  abierta_por_nombre: string | null; cerrada_por_nombre: string | null;
  efectivo_esperado: number | null; efectivo_contado: number | null; diferencia: number | null;
  observacion_apertura: string | null; observacion_cierre: string | null;
  arqueo_apertura: ArqueoItem[] | null; arqueo_cierre: ArqueoItem[] | null;
  sucursal_nombre: string | null;
};

function mapCaja(r: Record<string, unknown>): CajaRow {
  return {
    id: String(r.id), numero_caja: Number(r.numero_caja) || 1, estado: String(r.estado),
    monto_apertura: num(r.monto_apertura),
    abierta_at: r.abierta_at ? new Date(r.abierta_at as string).toISOString() : "",
    cerrada_at: r.cerrada_at ? new Date(r.cerrada_at as string).toISOString() : null,
    abierta_por_nombre: (r.abierta_por_nombre as string) ?? null,
    cerrada_por_nombre: (r.cerrada_por_nombre as string) ?? null,
    efectivo_esperado: r.efectivo_esperado != null ? num(r.efectivo_esperado) : null,
    efectivo_contado: r.efectivo_contado != null ? num(r.efectivo_contado) : null,
    diferencia: r.diferencia != null ? num(r.diferencia) : null,
    observacion_apertura: (r.observacion_apertura as string) ?? null,
    observacion_cierre: (r.observacion_cierre as string) ?? null,
    arqueo_apertura: (r.arqueo_apertura_json as ArqueoItem[] | null) ?? null,
    arqueo_cierre: (r.arqueo_cierre_json as ArqueoItem[] | null) ?? null,
    sucursal_nombre: (r.sucursal_nombre as string) ?? null,
  };
}

/** Caja abierta de la sucursal (o null) + su arqueo en vivo. */
export async function getCajaAbierta(schemaRaw: string, empresaId: string, sucursalId: string) {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tCaja = quoteSchemaTable(schema, "cajas");
  const { rows } = await pool().query(
    `SELECT * FROM ${tCaja} WHERE empresa_id=$1::uuid AND sucursal_id=$2::uuid AND estado='abierta' LIMIT 1`,
    [empresaId, sucursalId]
  );
  if (!rows[0]) return null;
  const caja = mapCaja(rows[0]);
  const arqueo = await calcularArqueo(pool(), schema, empresaId, sucursalId, caja);
  return { caja, arqueo };
}

export async function abrirCaja(params: {
  schemaRaw: string; empresaId: string; sucursalId: string; montoApertura: number;
  observacion: string | null; usuarioId: string | null; usuarioNombre: string | null;
  arqueoApertura?: ArqueoItem[] | null;
}): Promise<{ id: string }> {
  const schema = assertAllowedChatDataSchema(params.schemaRaw);
  const tCaja = quoteSchemaTable(schema, "cajas");
  const arqueoJson = params.arqueoApertura && params.arqueoApertura.length ? JSON.stringify(params.arqueoApertura) : null;
  try {
    const { rows } = await pool().query<{ id: string }>(
      `INSERT INTO ${tCaja}
         (empresa_id, sucursal_id, numero_caja, estado, monto_apertura, observacion_apertura, abierta_por, abierta_por_nombre, arqueo_apertura_json)
       VALUES ($1::uuid,$2::uuid,1,'abierta',$3::numeric,$4,$5::uuid,$6,$7::jsonb)
       RETURNING id`,
      [params.empresaId, params.sucursalId, num(params.montoApertura), params.observacion, params.usuarioId, params.usuarioNombre, arqueoJson]
    );
    return { id: rows[0]!.id };
  } catch (e) {
    if ((e as { code?: string })?.code === "23505") {
      throw new CajaError(409, "Ya hay una caja abierta en esta sucursal. Cerrala antes de abrir otra.");
    }
    throw e;
  }
}

export async function registrarMovimientoCaja(params: {
  schemaRaw: string; empresaId: string; sucursalId: string; cajaId: string;
  tipo: string; concepto: string | null; monto: number; metodoPago: string;
  usuarioId: string | null; usuarioNombre: string | null;
}): Promise<void> {
  const schema = assertAllowedChatDataSchema(params.schemaRaw);
  const tCaja = quoteSchemaTable(schema, "cajas");
  const tM = quoteSchemaTable(schema, "caja_movimientos");
  if (!["ingreso", "egreso", "retiro", "ajuste"].includes(params.tipo)) throw new CajaError(400, "Tipo de movimiento inválido.");
  if (num(params.monto) <= 0) throw new CajaError(400, "El monto debe ser mayor a 0.");
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ estado: string }>(
      `SELECT estado FROM ${tCaja} WHERE id=$1::uuid AND empresa_id=$2::uuid AND sucursal_id=$3::uuid FOR UPDATE`,
      [params.cajaId, params.empresaId, params.sucursalId]
    );
    if (!rows[0]) throw new CajaError(404, "Caja no encontrada.");
    if (rows[0].estado !== "abierta") throw new CajaError(409, "La caja no está abierta.");
    await client.query(
      `INSERT INTO ${tM} (empresa_id, sucursal_id, caja_id, tipo, concepto, monto, metodo_pago, origen, created_by, usuario_nombre)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::numeric,$7,'manual',$8::uuid,$9)`,
      [params.empresaId, params.sucursalId, params.cajaId, params.tipo, params.concepto, num(params.monto),
       ["efectivo", "transferencia", "tarjeta"].includes(params.metodoPago) ? params.metodoPago : "efectivo",
       params.usuarioId, params.usuarioNombre]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => null);
    throw e;
  } finally {
    client.release();
  }
}

export async function cerrarCaja(params: {
  schemaRaw: string; empresaId: string; sucursalId: string; cajaId: string;
  efectivoContado: number; observacion: string | null; usuarioId: string | null; usuarioNombre: string | null;
  arqueoCierre?: ArqueoItem[] | null;
}): Promise<{ efectivo_esperado: number; efectivo_contado: number; diferencia: number }> {
  const schema = assertAllowedChatDataSchema(params.schemaRaw);
  const tCaja = quoteSchemaTable(schema, "cajas");
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT id, monto_apertura, abierta_at, cerrada_at, estado FROM ${tCaja}
        WHERE id=$1::uuid AND empresa_id=$2::uuid AND sucursal_id=$3::uuid FOR UPDATE`,
      [params.cajaId, params.empresaId, params.sucursalId]
    );
    if (!rows[0]) throw new CajaError(404, "Caja no encontrada.");
    if (rows[0].estado !== "abierta") throw new CajaError(409, "La caja ya está cerrada.");

    const arqueo = await calcularArqueo(client, schema, params.empresaId, params.sucursalId, {
      id: String(rows[0].id), monto_apertura: num(rows[0].monto_apertura),
      abierta_at: new Date(rows[0].abierta_at as string).toISOString(), cerrada_at: null,
    });
    const esperado = arqueo.efectivo_esperado;
    const contado = num(params.efectivoContado);
    const diferencia = contado - esperado;

    const arqueoJson = params.arqueoCierre && params.arqueoCierre.length ? JSON.stringify(params.arqueoCierre) : null;
    await client.query(
      `UPDATE ${tCaja} SET estado='cerrada', cerrada_at=now(), cerrada_por=$2::uuid, cerrada_por_nombre=$3,
              efectivo_esperado=$4::numeric, efectivo_contado=$5::numeric, diferencia=$6::numeric,
              observacion_cierre=$7, arqueo_cierre_json=$8::jsonb, updated_at=now()
        WHERE id=$1::uuid`,
      [params.cajaId, params.usuarioId, params.usuarioNombre, esperado, contado, diferencia, params.observacion, arqueoJson]
    );
    await client.query("COMMIT");
    return { efectivo_esperado: esperado, efectivo_contado: contado, diferencia };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => null);
    throw e;
  } finally {
    client.release();
  }
}

export async function listCajas(schemaRaw: string, empresaId: string, sucursalId: string): Promise<CajaRow[]> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tCaja = quoteSchemaTable(schema, "cajas");
  const { rows } = await pool().query(
    `SELECT * FROM ${tCaja} WHERE empresa_id=$1::uuid AND sucursal_id=$2::uuid ORDER BY abierta_at DESC LIMIT 200`,
    [empresaId, sucursalId]
  );
  return rows.map(mapCaja);
}

export async function getCajaDetalle(schemaRaw: string, empresaId: string, sucursalId: string, id: string) {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tCaja = quoteSchemaTable(schema, "cajas");
  const tM = quoteSchemaTable(schema, "caja_movimientos");
  const tS = quoteSchemaTable(schema, "sucursales");
  const { rows } = await pool().query(
    `SELECT c.*, s.nombre AS sucursal_nombre FROM ${tCaja} c
       JOIN ${tS} s ON s.id = c.sucursal_id
      WHERE c.id=$1::uuid AND c.empresa_id=$2::uuid AND c.sucursal_id=$3::uuid`,
    [id, empresaId, sucursalId]
  );
  if (!rows[0]) return null;
  const caja = mapCaja(rows[0]);
  const arqueo = await calcularArqueo(pool(), schema, empresaId, sucursalId, caja);
  const { rows: movs } = await pool().query(
    `SELECT id, tipo, concepto, monto, metodo_pago, origen, referencia, usuario_nombre, fecha
       FROM ${tM} WHERE caja_id=$1::uuid ORDER BY fecha ASC`,
    [id]
  );
  return { caja, arqueo, movimientos: movs };
}
