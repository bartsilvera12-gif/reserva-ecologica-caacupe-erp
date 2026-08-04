/**
 * Caja por sucursal (turno + arqueo) — capa PG. Modelo multi-caja (Ferretería R.)
 *
 * Se admiten VARIAS cajas activas por sucursal (numero_caja distinto) y un estado
 * intermedio 'en_cierre' (conteo): la caja deja de recibir ventas nuevas.
 *
 * Atribución de ventas (transicional, no rompe cajas ya abiertas):
 *   - Una venta pertenece a la caja cuyo `ventas.caja_id` coincide.
 *   - Las ventas SIN caja_id (históricas, o creadas cuando había una sola caja)
 *     se atribuyen por VENTANA DE TIEMPO a la única caja activa de la sucursal.
 *     Con varias cajas activas, las ventas sin tag NO se cuentan (deben venir
 *     etiquetadas desde el POS).
 *
 * Ventana de la caja: [abierta_at, hasta], donde hasta =
 *   cerrada  → cerrada_at ; en_cierre → updated_at (congelada) ; abierta → now().
 *
 * Efectivo esperado =
 *   apertura + ventas contado efectivo + cobros efectivo + ingresos efectivo
 *   + ajustes efectivo - egresos efectivo - retiros efectivo.
 * Tarjeta/transferencia suman al total vendido pero NO al efectivo físico.
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
  cantidad_ventas: number;
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

type CajaCore = {
  id: string; monto_apertura: number; estado: string;
  abierta_at: string; cerrada_at: string | null; updated_at: string | null;
};

/** Fin de la ventana temporal de una caja según su estado. */
function ventanaHasta(caja: CajaCore): string | null {
  if (caja.estado === "cerrada") return caja.cerrada_at;
  if (caja.estado === "en_cierre") return caja.updated_at; // congelada al pasar a conteo
  return null; // abierta => now()
}

/**
 * Arqueo de UNA caja. `sole` = true si es la única caja activa de la sucursal
 * (habilita el fallback de ventas/cobros sin caja_id por ventana de tiempo).
 */
export async function calcularArqueoCaja(
  q: Querier,
  schemaRaw: string,
  empresaId: string,
  sucursalId: string,
  caja: CajaCore,
  sole: boolean
): Promise<Arqueo> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tV = quoteSchemaTable(schema, "ventas");
  const tC = quoteSchemaTable(schema, "cobros_clientes");
  const tM = quoteSchemaTable(schema, "caja_movimientos");
  const desde = caja.abierta_at;
  const hasta = ventanaHasta(caja); // null => now()

  // Ventas de la caja: por caja_id, más el fallback por ventana para ventas sin
  // etiquetar cuando esta es la única caja activa.
  const { rows: v } = await q.query(
    `SELECT
       COUNT(*) cantidad,
       COALESCE(SUM(total) FILTER (WHERE tipo_venta='CONTADO' AND metodo_pago='efectivo'),0) ventas_efectivo,
       COALESCE(SUM(total) FILTER (WHERE tipo_venta='CONTADO' AND metodo_pago='tarjeta'),0) ventas_tarjeta,
       COALESCE(SUM(total) FILTER (WHERE tipo_venta='CONTADO' AND metodo_pago='transferencia'),0) ventas_transferencia,
       COALESCE(SUM(total) FILTER (WHERE tipo_venta='CREDITO'),0) ventas_credito,
       COALESCE(SUM(total),0) ventas_total
     FROM ${tV}
     WHERE empresa_id=$1::uuid AND sucursal_id=$2::uuid AND estado='completada'
       AND (
         caja_id=$3::uuid
         OR ( caja_id IS NULL AND $4::boolean
              AND fecha >= $5::timestamptz AND fecha <= COALESCE($6::timestamptz, now()) )
       )`,
    [empresaId, sucursalId, caja.id, sole, desde, hasta]
  );
  // Cobros CxC en efectivo: solo por ventana y solo si es la única caja activa
  // (los cobros no llevan caja_id; con varias cajas no se atribuyen para no
  // duplicar). Preserva el comportamiento histórico de una caja por sucursal.
  const { rows: co } = await q.query(
    `SELECT
       COALESCE(SUM(monto) FILTER (WHERE metodo_pago='efectivo'),0) cobros_efectivo,
       COALESCE(SUM(monto),0) cobros_total
     FROM ${tC}
     WHERE empresa_id=$1::uuid AND sucursal_id=$2::uuid AND $3::boolean
       AND fecha_pago >= $4::timestamptz AND fecha_pago <= COALESCE($5::timestamptz, now())`,
    [empresaId, sucursalId, sole, desde, hasta]
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
    cantidad_ventas: num(v[0].cantidad),
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
  abierta_at: string; cerrada_at: string | null; updated_at: string | null;
  abierta_por_nombre: string | null; cerrada_por_nombre: string | null;
  efectivo_esperado: number | null; efectivo_contado: number | null; diferencia: number | null;
  observacion_apertura: string | null; observacion_cierre: string | null;
  arqueo_apertura: ArqueoItem[] | null; arqueo_cierre: ArqueoItem[] | null;
  sucursal_nombre: string | null;
};

export type CajaMovimiento = {
  id: string; tipo: string; concepto: string | null; monto: number;
  metodo_pago: string; origen: string; usuario_nombre: string | null; fecha: string;
};

/** Caja activa con su arqueo en vivo y sus movimientos manuales (para las tarjetas). */
export type CajaResumen = {
  caja: CajaRow;
  arqueo: Arqueo;
  movimientos: CajaMovimiento[];
};

function mapCaja(r: Record<string, unknown>): CajaRow {
  return {
    id: String(r.id), numero_caja: Number(r.numero_caja) || 1, estado: String(r.estado),
    monto_apertura: num(r.monto_apertura),
    abierta_at: r.abierta_at ? new Date(r.abierta_at as string).toISOString() : "",
    cerrada_at: r.cerrada_at ? new Date(r.cerrada_at as string).toISOString() : null,
    updated_at: r.updated_at ? new Date(r.updated_at as string).toISOString() : null,
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

function cajaCore(c: CajaRow): CajaCore {
  return {
    id: c.id, monto_apertura: c.monto_apertura, estado: c.estado,
    abierta_at: c.abierta_at, cerrada_at: c.cerrada_at, updated_at: c.updated_at,
  };
}

/** IDs de números de caja activos (abierta/en_cierre) en la sucursal. */
async function numerosActivos(
  q: Querier, schema: string, empresaId: string, sucursalId: string
): Promise<number[]> {
  const tCaja = quoteSchemaTable(schema, "cajas");
  const { rows } = await q.query(
    `SELECT numero_caja FROM ${tCaja}
      WHERE empresa_id=$1::uuid AND sucursal_id=$2::uuid AND estado IN ('abierta','en_cierre')`,
    [empresaId, sucursalId]
  );
  return rows.map((r) => Number(r.numero_caja) || 1);
}

/**
 * Todas las cajas activas (abierta/en_cierre) de la sucursal con su resumen en
 * vivo y sus movimientos manuales. Ordenadas por numero_caja.
 */
export async function listarCajasActivas(
  schemaRaw: string, empresaId: string, sucursalId: string
): Promise<CajaResumen[]> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tCaja = quoteSchemaTable(schema, "cajas");
  const tM = quoteSchemaTable(schema, "caja_movimientos");
  const { rows } = await pool().query(
    `SELECT * FROM ${tCaja}
      WHERE empresa_id=$1::uuid AND sucursal_id=$2::uuid AND estado IN ('abierta','en_cierre')
      ORDER BY numero_caja ASC`,
    [empresaId, sucursalId]
  );
  const cajas = rows.map(mapCaja);
  const sole = cajas.length === 1;
  const out: CajaResumen[] = [];
  for (const caja of cajas) {
    const arqueo = await calcularArqueoCaja(pool(), schema, empresaId, sucursalId, cajaCore(caja), sole);
    const { rows: movs } = await pool().query(
      `SELECT id, tipo, concepto, monto, metodo_pago, origen, usuario_nombre, fecha
         FROM ${tM} WHERE caja_id=$1::uuid ORDER BY fecha ASC`,
      [caja.id]
    );
    out.push({
      caja, arqueo,
      movimientos: movs.map((m) => ({
        id: String(m.id), tipo: String(m.tipo), concepto: (m.concepto as string) ?? null,
        monto: num(m.monto), metodo_pago: String(m.metodo_pago), origen: String(m.origen),
        usuario_nombre: (m.usuario_nombre as string) ?? null,
        fecha: m.fecha ? new Date(m.fecha as string).toISOString() : "",
      })),
    });
  }
  return out;
}

export async function abrirCaja(params: {
  schemaRaw: string; empresaId: string; sucursalId: string; montoApertura: number;
  observacion: string | null; usuarioId: string | null; usuarioNombre: string | null;
  arqueoApertura?: ArqueoItem[] | null; numeroCaja?: number | null;
}): Promise<{ id: string; numero_caja: number }> {
  const schema = assertAllowedChatDataSchema(params.schemaRaw);
  const tCaja = quoteSchemaTable(schema, "cajas");
  const arqueoJson = params.arqueoApertura && params.arqueoApertura.length ? JSON.stringify(params.arqueoApertura) : null;
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    // Próximo número: el solicitado, o max(activos)+1 (default 1).
    const activos = await numerosActivos(client, schema, params.empresaId, params.sucursalId);
    let numero = params.numeroCaja && params.numeroCaja > 0 ? Math.floor(params.numeroCaja) : 0;
    if (!numero) numero = (activos.length ? Math.max(...activos) : 0) + 1;
    if (activos.includes(numero)) {
      throw new CajaError(409, `La Caja ${numero} ya está activa en esta sucursal.`);
    }
    const { rows } = await client.query<{ id: string; numero_caja: number }>(
      `INSERT INTO ${tCaja}
         (empresa_id, sucursal_id, numero_caja, estado, monto_apertura, observacion_apertura, abierta_por, abierta_por_nombre, arqueo_apertura_json)
       VALUES ($1::uuid,$2::uuid,$3::int,'abierta',$4::numeric,$5,$6::uuid,$7,$8::jsonb)
       RETURNING id, numero_caja`,
      [params.empresaId, params.sucursalId, numero, num(params.montoApertura), params.observacion, params.usuarioId, params.usuarioNombre, arqueoJson]
    );
    await client.query("COMMIT");
    return { id: rows[0]!.id, numero_caja: Number(rows[0]!.numero_caja) || numero };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => null);
    if ((e as { code?: string })?.code === "23505") {
      throw new CajaError(409, "Ese número de caja ya está activo en esta sucursal.");
    }
    throw e;
  } finally {
    client.release();
  }
}

/** Pasa una caja 'abierta' a 'en_cierre' (conteo): deja de recibir ventas nuevas. */
export async function ponerCajaEnCierre(params: {
  schemaRaw: string; empresaId: string; sucursalId: string; cajaId: string;
}): Promise<{ numero_caja: number }> {
  const schema = assertAllowedChatDataSchema(params.schemaRaw);
  const tCaja = quoteSchemaTable(schema, "cajas");
  const { rows } = await pool().query<{ numero_caja: number }>(
    `UPDATE ${tCaja} SET estado='en_cierre', updated_at=now()
      WHERE id=$1::uuid AND empresa_id=$2::uuid AND sucursal_id=$3::uuid AND estado='abierta'
      RETURNING numero_caja`,
    [params.cajaId, params.empresaId, params.sucursalId]
  );
  if (!rows[0]) throw new CajaError(409, "La caja no está abierta o no existe.");
  return { numero_caja: Number(rows[0].numero_caja) || 1 };
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
      `SELECT id, monto_apertura, abierta_at, cerrada_at, updated_at, estado FROM ${tCaja}
        WHERE id=$1::uuid AND empresa_id=$2::uuid AND sucursal_id=$3::uuid FOR UPDATE`,
      [params.cajaId, params.empresaId, params.sucursalId]
    );
    if (!rows[0]) throw new CajaError(404, "Caja no encontrada.");
    if (rows[0].estado === "cerrada") throw new CajaError(409, "La caja ya está cerrada.");

    // ¿Es la única caja activa? (habilita el fallback por ventana de tiempo).
    const activos = await numerosActivos(client, schema, params.empresaId, params.sucursalId);
    const sole = activos.length <= 1;

    const arqueo = await calcularArqueoCaja(client, schema, params.empresaId, params.sucursalId, {
      id: String(rows[0].id), monto_apertura: num(rows[0].monto_apertura), estado: String(rows[0].estado),
      abierta_at: new Date(rows[0].abierta_at as string).toISOString(),
      cerrada_at: null,
      updated_at: rows[0].updated_at ? new Date(rows[0].updated_at as string).toISOString() : null,
    }, sole);
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

/** Historial de cajas cerradas de la sucursal. */
export async function listCajasCerradas(schemaRaw: string, empresaId: string, sucursalId: string): Promise<CajaRow[]> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tCaja = quoteSchemaTable(schema, "cajas");
  const { rows } = await pool().query(
    `SELECT * FROM ${tCaja}
      WHERE empresa_id=$1::uuid AND sucursal_id=$2::uuid AND estado='cerrada'
      ORDER BY cerrada_at DESC NULLS LAST LIMIT 200`,
    [empresaId, sucursalId]
  );
  return rows.map(mapCaja);
}

/**
 * Cajas activas para el POS (venta): id + numero_caja de las 'abierta'.
 * Usado para resolver `ventas.caja_id` y para el selector cuando hay varias.
 */
export async function listarCajasAbiertasParaVenta(
  schemaRaw: string, empresaId: string, sucursalId: string
): Promise<{ id: string; numero_caja: number }[]> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tCaja = quoteSchemaTable(schema, "cajas");
  const { rows } = await pool().query<{ id: string; numero_caja: number }>(
    `SELECT id, numero_caja FROM ${tCaja}
      WHERE empresa_id=$1::uuid AND sucursal_id=$2::uuid AND estado='abierta'
      ORDER BY numero_caja ASC`,
    [empresaId, sucursalId]
  );
  return rows.map((r) => ({ id: String(r.id), numero_caja: Number(r.numero_caja) || 1 }));
}

/**
 * Resuelve a qué caja se imputa una venta de la sucursal (patrón Ferretería):
 *   - `cajaIdPedida` presente → debe estar abierta (si no, error).
 *   - 1 caja abierta → esa.
 *   - 0 cajas abiertas → null (la venta procede igual; no rompe el flujo actual).
 *   - varias abiertas → exige elegir (error): el POS debe mandar caja_id.
 */
export async function resolverCajaParaVenta(
  schemaRaw: string, empresaId: string, sucursalId: string, cajaIdPedida: string | null
): Promise<string | null> {
  const abiertas = await listarCajasAbiertasParaVenta(schemaRaw, empresaId, sucursalId);
  if (cajaIdPedida) {
    const match = abiertas.find((c) => c.id === cajaIdPedida);
    if (!match) throw new CajaError(409, "La caja seleccionada no está abierta. Elegí una caja abierta.");
    return match.id;
  }
  if (abiertas.length === 1) return abiertas[0]!.id;
  if (abiertas.length === 0) return null;
  throw new CajaError(409, "Hay varias cajas abiertas: elegí en qué caja registrar la venta.");
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
  // Para el detalle histórico: si sigue activa, ¿es la única activa?
  const activos = caja.estado === "cerrada" ? [] : await numerosActivos(pool(), schema, empresaId, sucursalId);
  const sole = activos.length <= 1;
  const arqueo = await calcularArqueoCaja(pool(), schema, empresaId, sucursalId, cajaCore(caja), sole);
  const { rows: movs } = await pool().query(
    `SELECT id, tipo, concepto, monto, metodo_pago, origen, referencia, usuario_nombre, fecha
       FROM ${tM} WHERE caja_id=$1::uuid ORDER BY fecha ASC`,
    [id]
  );
  return { caja, arqueo, movimientos: movs };
}
