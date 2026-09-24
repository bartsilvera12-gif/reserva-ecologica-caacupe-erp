/**
 * Plan de cuotas — capa PG (cuentas por cobrar y por pagar).
 *
 * El plan es solo el cronograma (tabla cuentas_cuotas). El estado de cada cuota
 * se deriva imputando lo ya pagado de la cuenta, de la cuota más antigua a la más
 * nueva (ver cuotas-domain). La única fuente de verdad del dinero sigue siendo el
 * saldo de la cuenta + sus abonos.
 *
 * Objetivo del plan = monto TOTAL de la deuda (no el saldo remanente):
 *   - pagar  → cuentas_por_pagar.monto_original ; pagado = cuentas_por_pagar.pagado
 *   - cobrar → cuentas_por_cobrar.total         ; pagado = total - saldo
 * Así, si ya hubo abonos antes de programar, cubren automáticamente las primeras
 * cuotas y no hay doble conteo.
 */
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import type { PoolClient } from "pg";
import {
  validarPlanCuotas,
  derivarEstadoCuotas,
  type CuotaPlanInput,
  type CuotaDerivada,
  type TipoCuenta,
} from "@/lib/cuotas/cuotas-domain";

function pool() {
  const p = getChatPostgresPool();
  if (!p) throw new Error("Pool PG no disponible para cuotas.");
  return p;
}

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

export class CuotaError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "CuotaError";
    this.status = status;
  }
}

function assertTipo(tipo: string): TipoCuenta {
  if (tipo !== "cobrar" && tipo !== "pagar") {
    throw new CuotaError(400, "tipo inválido (debe ser 'cobrar' o 'pagar').");
  }
  return tipo;
}

/** Carga el objetivo (monto total de la deuda) y lo ya pagado de la cuenta. */
async function cargarObjetivo(
  client: PoolClient,
  schema: string,
  empresaId: string,
  tipo: TipoCuenta,
  cuentaId: string
): Promise<{ objetivo: number; pagado: number; estado: string }> {
  if (tipo === "pagar") {
    const t = quoteSchemaTable(schema, "cuentas_por_pagar");
    const { rows } = await client.query(
      `SELECT monto_original, pagado, estado FROM ${t} WHERE id = $1::uuid AND empresa_id = $2::uuid`,
      [cuentaId, empresaId]
    );
    if (rows.length === 0) throw new CuotaError(404, "Cuenta por pagar no encontrada.");
    return { objetivo: num(rows[0].monto_original), pagado: num(rows[0].pagado), estado: String(rows[0].estado) };
  }
  const t = quoteSchemaTable(schema, "cuentas_por_cobrar");
  const { rows } = await client.query(
    `SELECT total, saldo, estado FROM ${t} WHERE id = $1::uuid AND empresa_id = $2::uuid`,
    [cuentaId, empresaId]
  );
  if (rows.length === 0) throw new CuotaError(404, "Cuenta por cobrar no encontrada.");
  const total = num(rows[0].total);
  const saldo = num(rows[0].saldo);
  return { objetivo: total, pagado: Math.max(0, total - saldo), estado: String(rows[0].estado) };
}

export interface CrearPlanArgs {
  schemaRaw: string;
  empresaId: string;
  sucursalId: string | null;
  tipo: string;
  cuentaId: string;
  cuotas: CuotaPlanInput[];
  createdBy?: string | null;
  usuarioNombre?: string | null;
}

/** Crea (o reemplaza) el plan de cuotas de una cuenta. Devuelve las cuotas con estado. */
export async function crearPlanCuotas(args: CrearPlanArgs): Promise<CuotaDerivada[]> {
  const schema = assertAllowedChatDataSchema(args.schemaRaw);
  const tipo = assertTipo(args.tipo);
  if (!args.cuentaId) throw new CuotaError(400, "Falta la cuenta.");
  const tCuotas = quoteSchemaTable(schema, "cuentas_cuotas");

  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const { objetivo, estado } = await cargarObjetivo(client, schema, args.empresaId, tipo, args.cuentaId);
    if (estado === "anulada" || estado === "anulado") {
      throw new CuotaError(409, "La cuenta está anulada; no admite plan de cuotas.");
    }

    const v = validarPlanCuotas(objetivo, args.cuotas);
    if (!v.ok) throw new CuotaError(400, v.error);

    // Reemplazo total: borramos el plan anterior de esta cuenta y cargamos el nuevo.
    await client.query(
      `DELETE FROM ${tCuotas} WHERE empresa_id = $1::uuid AND tipo = $2 AND cuenta_id = $3::uuid`,
      [args.empresaId, tipo, args.cuentaId]
    );

    const ordenadas = [...args.cuotas].sort((a, b) => a.numero_cuota - b.numero_cuota);
    for (const c of ordenadas) {
      await client.query(
        `INSERT INTO ${tCuotas}
           (empresa_id, sucursal_id, tipo, cuenta_id, numero_cuota, monto, fecha_vencimiento, created_by, usuario_nombre)
         VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6, $7::date, $8, $9)`,
        [
          args.empresaId,
          args.sucursalId,
          tipo,
          args.cuentaId,
          c.numero_cuota,
          c.monto,
          c.fecha_vencimiento,
          args.createdBy ?? null,
          args.usuarioNombre ?? null,
        ]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw e;
  } finally {
    client.release();
  }

  const out = await listarPlanCuotas({
    schemaRaw: args.schemaRaw,
    empresaId: args.empresaId,
    tipo,
    cuentaId: args.cuentaId,
  });
  return out.cuotas;
}

export interface ListarPlanArgs {
  schemaRaw: string;
  empresaId: string;
  tipo: string;
  cuentaId: string;
}

export interface PlanCuotasResult {
  cuotas: CuotaDerivada[];
  objetivo: number;
  pagado: number;
}

/** Lista el plan de una cuenta con el estado derivado de cada cuota. */
export async function listarPlanCuotas(args: ListarPlanArgs): Promise<PlanCuotasResult> {
  const schema = assertAllowedChatDataSchema(args.schemaRaw);
  const tipo = assertTipo(args.tipo);
  const tCuotas = quoteSchemaTable(schema, "cuentas_cuotas");

  const client = await pool().connect();
  try {
    const { objetivo, pagado } = await cargarObjetivo(client, schema, args.empresaId, tipo, args.cuentaId);
    const { rows } = await client.query(
      `SELECT numero_cuota, monto, to_char(fecha_vencimiento, 'YYYY-MM-DD') AS fecha_vencimiento
         FROM ${tCuotas}
        WHERE empresa_id = $1::uuid AND tipo = $2 AND cuenta_id = $3::uuid
        ORDER BY numero_cuota ASC`,
      [args.empresaId, tipo, args.cuentaId]
    );
    const plan: CuotaPlanInput[] = rows.map((r) => ({
      numero_cuota: Number(r.numero_cuota),
      monto: num(r.monto),
      fecha_vencimiento: String(r.fecha_vencimiento),
    }));
    return { cuotas: derivarEstadoCuotas(plan, pagado), objetivo, pagado };
  } finally {
    client.release();
  }
}

/** Borra el plan de cuotas de una cuenta (vuelve al saldo único sin cronograma). */
export async function eliminarPlanCuotas(args: ListarPlanArgs): Promise<void> {
  const schema = assertAllowedChatDataSchema(args.schemaRaw);
  const tipo = assertTipo(args.tipo);
  const tCuotas = quoteSchemaTable(schema, "cuentas_cuotas");
  await pool().query(
    `DELETE FROM ${tCuotas} WHERE empresa_id = $1::uuid AND tipo = $2 AND cuenta_id = $3::uuid`,
    [args.empresaId, tipo, args.cuentaId]
  );
}
