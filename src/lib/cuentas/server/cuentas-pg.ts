/**
 * Control de saldos: cuentas bancarias y caja chica (por empresa).
 *
 * - `cuentas_financieras`: cada cuenta con saldo inicial y fecha de inicio del control.
 * - `cuentas_movimientos`: libro de movimientos (ingreso / egreso). El saldo SIEMPRE se calcula:
 *      saldo = saldo_inicial + ingresos - egresos   (movimientos no anulados, con fecha <= ahora)
 *   Los ingresos con fecha futura (ej. tarjeta con acreditación pendiente) figuran como "por acreditar".
 * - Cada operación del ERP (venta, cobro, pago a proveedor, gasto, compra) deja a lo sumo UN movimiento
 *   activo por (origen, origen_id): `sincronizarMovimientoOrigen` evita duplicados y revierte (anula) al
 *   anular o modificar.
 * - El efectivo del Market sigue en el módulo Caja: no se copia acá (así no se duplica). Los traslados
 *   Caja → Caja chica generan un "retiro" en Caja y un ingreso en la cuenta.
 */
import { randomUUID } from "crypto";
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import { calcularArqueoCaja, registrarMovimientoCaja } from "@/lib/caja/server/caja-pg";

function pool() {
  const p = getChatPostgresPool();
  if (!p) throw new Error("Pool PG no disponible para cuentas.");
  return p;
}
const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

export class CuentasError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "CuentasError";
    this.status = status;
  }
}

const TZ = "America/Asuncion";

/** Expresión SQL que resuelve una fecha (null → ahora; YYYY-MM-DD → hoy=ahora / otro día=12:00 local; ISO → tal cual). */
function fechaSql(p: string): string {
  return `(CASE
    WHEN ${p}::text IS NULL THEN now()
    WHEN length(${p}::text) = 10 THEN
      CASE WHEN ${p}::date = (now() AT TIME ZONE '${TZ}')::date THEN now()
           ELSE ((${p}::date)::timestamp + interval '12 hours') AT TIME ZONE '${TZ}' END
    ELSE ${p}::timestamptz END)`;
}

export type CuentaSaldo = {
  id: string;
  nombre: string;
  tipo: string;
  entidad_bancaria_id: string | null;
  saldo_inicial: number;
  fecha_inicio: string;
  activo: boolean;
  orden: number;
  ingresos: number;
  egresos: number;
  por_acreditar: number;
  saldo: number;
};

export async function listarCuentas(
  schemaRaw: string,
  empresaId: string,
  opts?: { soloActivas?: boolean }
): Promise<CuentaSaldo[]> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tC = quoteSchemaTable(schema, "cuentas_financieras");
  const tM = quoteSchemaTable(schema, "cuentas_movimientos");
  const { rows } = await pool().query(
    `SELECT c.id, c.nombre, c.tipo, c.entidad_bancaria_id, c.saldo_inicial, c.fecha_inicio::text AS fecha_inicio,
            c.activo, c.orden,
            COALESCE(SUM(m.monto) FILTER (WHERE m.tipo='ingreso' AND m.fecha <= now()),0) AS ingresos,
            COALESCE(SUM(m.monto) FILTER (WHERE m.tipo='egreso'  AND m.fecha <= now()),0) AS egresos,
            COALESCE(SUM(m.monto) FILTER (WHERE m.tipo='ingreso' AND m.fecha >  now()),0) AS por_acreditar
       FROM ${tC} c
       LEFT JOIN ${tM} m ON m.cuenta_id = c.id AND m.anulado = false
      WHERE c.empresa_id = $1::uuid ${opts?.soloActivas ? "AND c.activo = true" : ""}
      GROUP BY c.id
      ORDER BY c.orden, c.nombre`,
    [empresaId]
  );
  return rows.map((r) => {
    const saldo_inicial = num(r.saldo_inicial);
    const ingresos = num(r.ingresos);
    const egresos = num(r.egresos);
    return {
      id: String(r.id),
      nombre: String(r.nombre),
      tipo: String(r.tipo),
      entidad_bancaria_id: r.entidad_bancaria_id ? String(r.entidad_bancaria_id) : null,
      saldo_inicial,
      fecha_inicio: String(r.fecha_inicio),
      activo: Boolean(r.activo),
      orden: num(r.orden),
      ingresos,
      egresos,
      por_acreditar: num(r.por_acreditar),
      saldo: saldo_inicial + ingresos - egresos,
    };
  });
}

/** ¿La empresa tiene cuentas activas? (si no, no se exige elegir cuenta en las operaciones). */
export async function empresaTieneCuentas(schemaRaw: string, empresaId: string): Promise<boolean> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tC = quoteSchemaTable(schema, "cuentas_financieras");
  const { rows } = await pool().query(
    `SELECT 1 FROM ${tC} WHERE empresa_id=$1::uuid AND activo=true LIMIT 1`,
    [empresaId]
  );
  return rows.length > 0;
}

export type MovimientoDeseado = {
  cuentaId: string;
  tipo: "ingreso" | "egreso";
  monto: number;
  /** YYYY-MM-DD, ISO o null (ahora). */
  fecha?: string | null;
  concepto?: string | null;
  referencia?: string | null;
  sucursalId?: string | null;
};

/**
 * Deja el libro de la cuenta coherente con UNA operación del ERP:
 *  - `deseado = null`  → anula los movimientos activos de ese origen (anulación / se quitó la cuenta).
 *  - `deseado` igual a lo ya registrado → no hace nada (evita duplicados).
 *  - distinto → anula el anterior y registra el nuevo (modificación).
 * Operaciones con fecha anterior al inicio del control de la cuenta no generan movimiento.
 */
export async function sincronizarMovimientoOrigen(p: {
  schemaRaw: string;
  empresaId: string;
  origen: string;
  origenId: string;
  usuarioNombre?: string | null;
  deseado: MovimientoDeseado | null;
  motivo?: string;
}): Promise<{ accion: "creado" | "sin_cambios" | "anulado" | "omitido" }> {
  const schema = assertAllowedChatDataSchema(p.schemaRaw);
  const tC = quoteSchemaTable(schema, "cuentas_financieras");
  const tM = quoteSchemaTable(schema, "cuentas_movimientos");
  const d = p.deseado;
  if (d && !(num(d.monto) > 0)) throw new CuentasError(400, "El monto debe ser mayor a 0.");

  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${p.empresaId}:${p.origen}:${p.origenId}`]);

    let fechaRes: string | null = null;
    let dentroDelControl = false;
    if (d) {
      const { rows: cu } = await client.query(
        `SELECT c.id, c.activo,
                ${fechaSql("$3")} AS fecha_res,
                (${fechaSql("$3")} >= (c.fecha_inicio::timestamp AT TIME ZONE '${TZ}')) AS dentro
           FROM ${tC} c WHERE c.id=$1::uuid AND c.empresa_id=$2::uuid`,
        [d.cuentaId, p.empresaId, d.fecha ?? null]
      );
      if (!cu[0]) throw new CuentasError(400, "La cuenta elegida no existe.");
      if (!cu[0].activo) throw new CuentasError(400, "La cuenta elegida está inactiva.");
      fechaRes = new Date(cu[0].fecha_res as string).toISOString();
      dentroDelControl = Boolean(cu[0].dentro);
    }

    const { rows: act } = await client.query(
      `SELECT id, cuenta_id, tipo, monto, (fecha AT TIME ZONE '${TZ}')::date::text AS dia
         FROM ${tM}
        WHERE empresa_id=$1::uuid AND origen=$2 AND origen_id=$3 AND anulado=false AND grupo_id IS NULL`,
      [p.empresaId, p.origen, p.origenId]
    );

    if (d && dentroDelControl && act.length === 1) {
      const a = act[0];
      const diaNuevo = await client.query(`SELECT ($1::timestamptz AT TIME ZONE '${TZ}')::date::text AS dia`, [fechaRes]);
      if (
        String(a.cuenta_id) === d.cuentaId &&
        a.tipo === d.tipo &&
        Math.abs(num(a.monto) - num(d.monto)) < 0.005 &&
        a.dia === diaNuevo.rows[0].dia
      ) {
        await client.query("COMMIT");
        return { accion: "sin_cambios" };
      }
    }

    if (act.length > 0) {
      await client.query(
        `UPDATE ${tM} SET anulado=true, anulado_at=now(), anulado_motivo=$4
          WHERE empresa_id=$1::uuid AND origen=$2 AND origen_id=$3 AND anulado=false AND grupo_id IS NULL`,
        [p.empresaId, p.origen, p.origenId, p.motivo ?? (d ? "Operación modificada" : "Operación anulada")]
      );
    }

    if (!d) {
      await client.query("COMMIT");
      return { accion: act.length > 0 ? "anulado" : "omitido" };
    }
    if (!dentroDelControl) {
      await client.query("COMMIT");
      return { accion: act.length > 0 ? "anulado" : "omitido" };
    }

    await client.query(
      `INSERT INTO ${tM} (empresa_id, cuenta_id, fecha, tipo, concepto, monto, origen, origen_id, sucursal_id, referencia, usuario_nombre)
       VALUES ($1::uuid,$2::uuid,$3::timestamptz,$4,$5,$6::numeric,$7,$8,$9::uuid,$10,$11)`,
      [
        p.empresaId, d.cuentaId, fechaRes, d.tipo, d.concepto ?? null, num(d.monto),
        p.origen, p.origenId, d.sucursalId ?? null, d.referencia ?? null, p.usuarioNombre ?? null,
      ]
    );
    await client.query("COMMIT");
    return { accion: "creado" };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => null);
    throw e;
  } finally {
    client.release();
  }
}

/** Anula los movimientos activos de un origen (venta anulada, pago revertido, etc.). Best-effort para el caller. */
export async function anularMovimientosOrigen(
  schemaRaw: string,
  empresaId: string,
  origen: string,
  origenId: string,
  motivo?: string
): Promise<void> {
  await sincronizarMovimientoOrigen({ schemaRaw, empresaId, origen, origenId, deseado: null, motivo });
}

/** Exige cuenta elegida cuando la empresa maneja cuentas. Lanza 400 si falta. */
export async function exigirCuentaSiCorresponde(
  schemaRaw: string,
  empresaId: string,
  cuentaId: string | null | undefined,
  contexto: string
): Promise<void> {
  if (cuentaId && String(cuentaId).trim() !== "") return;
  if (await empresaTieneCuentas(schemaRaw, empresaId)) {
    throw new CuentasError(400, `Elegí la cuenta (banco o caja chica) ${contexto}.`);
  }
}

/** Transferencia entre cuentas: 1 egreso + 1 ingreso con el mismo grupo. No cambia el total general. */
export async function transferirEntreCuentas(p: {
  schemaRaw: string;
  empresaId: string;
  origenCuentaId: string;
  destinoCuentaId: string;
  monto: number;
  fecha?: string | null;
  concepto?: string | null;
  usuarioNombre?: string | null;
}): Promise<{ grupo_id: string }> {
  const schema = assertAllowedChatDataSchema(p.schemaRaw);
  const tC = quoteSchemaTable(schema, "cuentas_financieras");
  const tM = quoteSchemaTable(schema, "cuentas_movimientos");
  const monto = num(p.monto);
  if (!(monto > 0)) throw new CuentasError(400, "El monto debe ser mayor a 0.");
  if (p.origenCuentaId === p.destinoCuentaId) throw new CuentasError(400, "La cuenta de origen y la de destino deben ser distintas.");

  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT c.id, c.nombre, c.activo, ${fechaSql("$3")} AS fecha_res,
              (${fechaSql("$3")} >= (c.fecha_inicio::timestamp AT TIME ZONE '${TZ}')) AS dentro
         FROM ${tC} c WHERE c.empresa_id=$1::uuid AND c.id = ANY($2::uuid[])`,
      [p.empresaId, [p.origenCuentaId, p.destinoCuentaId], p.fecha ?? null]
    );
    const o = rows.find((r) => String(r.id) === p.origenCuentaId);
    const dst = rows.find((r) => String(r.id) === p.destinoCuentaId);
    if (!o || !dst) throw new CuentasError(400, "Cuenta no encontrada.");
    if (!o.activo || !dst.activo) throw new CuentasError(400, "Una de las cuentas está inactiva.");
    if (!o.dentro || !dst.dentro) throw new CuentasError(400, "La fecha es anterior al inicio del control de saldos de la cuenta.");
    const fecha = new Date(o.fecha_res as string).toISOString();
    const grupo = randomUUID();
    const base = p.concepto?.trim() || null;
    const ins = `INSERT INTO ${tM} (empresa_id, cuenta_id, fecha, tipo, concepto, monto, origen, origen_id, grupo_id, usuario_nombre)
                 VALUES ($1::uuid,$2::uuid,$3::timestamptz,$4,$5,$6::numeric,'transferencia',$7,$7::uuid,$8)`;
    await client.query(ins, [
      p.empresaId, p.origenCuentaId, fecha, "egreso",
      `Transferencia a ${dst.nombre}${base ? ` — ${base}` : ""}`, monto, grupo, p.usuarioNombre ?? null,
    ]);
    await client.query(ins, [
      p.empresaId, p.destinoCuentaId, fecha, "ingreso",
      `Transferencia desde ${o.nombre}${base ? ` — ${base}` : ""}`, monto, grupo, p.usuarioNombre ?? null,
    ]);
    await client.query("COMMIT");
    return { grupo_id: grupo };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => null);
    throw e;
  } finally {
    client.release();
  }
}

/** Anula una transferencia completa (las dos patas). */
export async function anularTransferencia(schemaRaw: string, empresaId: string, grupoId: string, motivo: string): Promise<number> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tM = quoteSchemaTable(schema, "cuentas_movimientos");
  const r = await pool().query(
    `UPDATE ${tM} SET anulado=true, anulado_at=now(), anulado_motivo=$3
      WHERE empresa_id=$1::uuid AND grupo_id=$2::uuid AND origen='transferencia' AND anulado=false`,
    [empresaId, grupoId, motivo]
  );
  if (!r.rowCount) throw new CuentasError(404, "Transferencia no encontrada o ya anulada.");
  return r.rowCount;
}

/**
 * Retiro de efectivo de la caja del Market hacia una cuenta (caja chica): descuenta en Caja
 * (movimiento "retiro" en la caja abierta) y suma en la cuenta. Un solo traslado, sin duplicar.
 */
export async function retirarDeCajaACuenta(p: {
  schemaRaw: string;
  empresaId: string;
  cajaId: string;
  cuentaId: string;
  monto: number;
  concepto: string | null;
  usuarioId: string | null;
  usuarioNombre: string | null;
}): Promise<void> {
  const schema = assertAllowedChatDataSchema(p.schemaRaw);
  const tCaja = quoteSchemaTable(schema, "cajas");
  const tC = quoteSchemaTable(schema, "cuentas_financieras");
  const monto = num(p.monto);
  if (!(monto > 0)) throw new CuentasError(400, "El monto debe ser mayor a 0.");

  const { rows: cj } = await pool().query(
    `SELECT sucursal_id, numero_caja, estado FROM ${tCaja} WHERE id=$1::uuid AND empresa_id=$2::uuid`,
    [p.cajaId, p.empresaId]
  );
  if (!cj[0]) throw new CuentasError(404, "Caja no encontrada.");
  if (cj[0].estado !== "abierta") throw new CuentasError(409, "La caja no está abierta.");
  const { rows: cu } = await pool().query(
    `SELECT nombre, activo, tipo FROM ${tC} WHERE id=$1::uuid AND empresa_id=$2::uuid`,
    [p.cuentaId, p.empresaId]
  );
  if (!cu[0] || !cu[0].activo) throw new CuentasError(400, "La cuenta de destino no existe o está inactiva.");

  const concepto = `Traslado a ${cu[0].nombre}${p.concepto?.trim() ? ` — ${p.concepto.trim()}` : ""}`;
  const movId = await registrarMovimientoCaja({
    schemaRaw: p.schemaRaw, empresaId: p.empresaId, sucursalId: String(cj[0].sucursal_id), cajaId: p.cajaId,
    tipo: "retiro", concepto, monto, metodoPago: "efectivo",
    usuarioId: p.usuarioId, usuarioNombre: p.usuarioNombre,
  });
  try {
    const r = await sincronizarMovimientoOrigen({
      schemaRaw: p.schemaRaw, empresaId: p.empresaId, origen: "retiro_caja", origenId: movId,
      usuarioNombre: p.usuarioNombre,
      deseado: {
        cuentaId: p.cuentaId, tipo: "ingreso", monto,
        concepto: `Traslado desde caja del Market (caja ${cj[0].numero_caja})${p.concepto?.trim() ? ` — ${p.concepto.trim()}` : ""}`,
        sucursalId: String(cj[0].sucursal_id),
      },
    });
    // Si el retiro es anterior al inicio del control de saldos, el efectivo igual salió de Caja:
    // se conserva el retiro en Caja y no se registra en la cuenta (su saldo inicial ya lo contempla).
    void r;
  } catch (e) {
    // Deshace el retiro de Caja para no dejar el efectivo "perdido".
    const tM = quoteSchemaTable(schema, "caja_movimientos");
    await pool().query(`DELETE FROM ${tM} WHERE id=$1::uuid AND empresa_id=$2::uuid`, [movId, p.empresaId]).catch(() => null);
    throw e;
  }
}

export type MovimientoFila = {
  id: string;
  cuenta_id: string;
  cuenta_nombre: string;
  fecha: string;
  tipo: string;
  concepto: string | null;
  monto: number;
  origen: string;
  origen_id: string | null;
  grupo_id: string | null;
  referencia: string | null;
  usuario_nombre: string | null;
  anulado: boolean;
  anulado_motivo: string | null;
  saldo: number;
};

export async function listarMovimientos(
  schemaRaw: string,
  empresaId: string,
  f: { cuentaId?: string | null; desde?: string | null; hasta?: string | null; limit?: number }
): Promise<MovimientoFila[]> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tC = quoteSchemaTable(schema, "cuentas_financieras");
  const tM = quoteSchemaTable(schema, "cuentas_movimientos");
  const limit = Math.min(Math.max(Math.trunc(f.limit ?? 300), 1), 1000);
  const { rows } = await pool().query(
    `SELECT * FROM (
        SELECT m.id, m.cuenta_id, c.nombre AS cuenta_nombre, m.fecha, m.tipo, m.concepto, m.monto, m.origen, m.origen_id,
               m.grupo_id, m.referencia, m.usuario_nombre, m.anulado, m.anulado_motivo, m.created_at,
               c.saldo_inicial + SUM(CASE WHEN m.anulado THEN 0 WHEN m.tipo='ingreso' THEN m.monto ELSE -m.monto END)
                 OVER (PARTITION BY m.cuenta_id ORDER BY m.fecha, m.created_at, m.id) AS saldo
          FROM ${tM} m JOIN ${tC} c ON c.id = m.cuenta_id
         WHERE m.empresa_id = $1::uuid
     ) x
      WHERE ($2::uuid IS NULL OR x.cuenta_id = $2::uuid)
        AND ($3::date IS NULL OR (x.fecha AT TIME ZONE '${TZ}')::date >= $3::date)
        AND ($4::date IS NULL OR (x.fecha AT TIME ZONE '${TZ}')::date <= $4::date)
      ORDER BY x.fecha DESC, x.created_at DESC
      LIMIT ${limit}`,
    [empresaId, f.cuentaId || null, f.desde || null, f.hasta || null]
  );
  return rows.map((r) => ({
    id: String(r.id),
    cuenta_id: String(r.cuenta_id),
    cuenta_nombre: String(r.cuenta_nombre),
    fecha: new Date(r.fecha as string).toISOString(),
    tipo: String(r.tipo),
    concepto: r.concepto ?? null,
    monto: num(r.monto),
    origen: String(r.origen),
    origen_id: r.origen_id ?? null,
    grupo_id: r.grupo_id ? String(r.grupo_id) : null,
    referencia: r.referencia ?? null,
    usuario_nombre: r.usuario_nombre ?? null,
    anulado: Boolean(r.anulado),
    anulado_motivo: r.anulado_motivo ?? null,
    saldo: num(r.saldo),
  }));
}

export type CajaAbiertaResumen = {
  id: string;
  numero_caja: number;
  sucursal_id: string;
  sucursal_nombre: string | null;
  estado: string;
  efectivo: number;
};

/** Efectivo que hay hoy en las cajas abiertas (efectivo esperado del arqueo = apertura/vuelto + movimientos). */
export async function efectivoCajasAbiertas(schemaRaw: string, empresaId: string): Promise<CajaAbiertaResumen[]> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tCaja = quoteSchemaTable(schema, "cajas");
  const tS = quoteSchemaTable(schema, "sucursales");
  const { rows } = await pool().query(
    `SELECT c.id, c.numero_caja, c.sucursal_id, c.estado, c.monto_apertura, c.abierta_at, c.cerrada_at, c.updated_at,
            s.nombre AS sucursal_nombre
       FROM ${tCaja} c LEFT JOIN ${tS} s ON s.id = c.sucursal_id
      WHERE c.empresa_id=$1::uuid AND c.estado IN ('abierta','en_cierre')
      ORDER BY c.sucursal_id, c.numero_caja`,
    [empresaId]
  );
  const porSuc = new Map<string, number>();
  for (const r of rows) porSuc.set(String(r.sucursal_id), (porSuc.get(String(r.sucursal_id)) ?? 0) + 1);
  const out: CajaAbiertaResumen[] = [];
  for (const r of rows) {
    const suc = String(r.sucursal_id);
    const arq = await calcularArqueoCaja(
      pool(), schemaRaw, empresaId, suc,
      {
        id: String(r.id), monto_apertura: num(r.monto_apertura), estado: String(r.estado),
        abierta_at: new Date(r.abierta_at as string).toISOString(),
        cerrada_at: r.cerrada_at ? new Date(r.cerrada_at as string).toISOString() : null,
        updated_at: r.updated_at ? new Date(r.updated_at as string).toISOString() : null,
      },
      (porSuc.get(suc) ?? 1) <= 1
    );
    out.push({
      id: String(r.id), numero_caja: num(r.numero_caja), sucursal_id: suc,
      sucursal_nombre: r.sucursal_nombre ?? null, estado: String(r.estado), efectivo: arq.efectivo_esperado,
    });
  }
  return out;
}

export type ResumenSaldos = {
  cuentas: CuentaSaldo[];
  total_bancos: number;
  total_caja_chica: number;
  cajas_market: CajaAbiertaResumen[];
  efectivo_market: number;
  total_general: number;
};

export async function resumenSaldos(schemaRaw: string, empresaId: string): Promise<ResumenSaldos> {
  const [cuentas, cajas] = await Promise.all([
    listarCuentas(schemaRaw, empresaId),
    efectivoCajasAbiertas(schemaRaw, empresaId),
  ]);
  const activas = cuentas.filter((c) => c.activo);
  const total_bancos = activas.filter((c) => c.tipo === "banco").reduce((s, c) => s + c.saldo, 0);
  const total_caja_chica = activas.filter((c) => c.tipo !== "banco").reduce((s, c) => s + c.saldo, 0);
  const efectivo_market = cajas.reduce((s, c) => s + c.efectivo, 0);
  return {
    cuentas, total_bancos, total_caja_chica, cajas_market: cajas, efectivo_market,
    total_general: total_bancos + total_caja_chica + efectivo_market,
  };
}
