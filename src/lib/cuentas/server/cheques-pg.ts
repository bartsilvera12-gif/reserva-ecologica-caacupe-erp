/**
 * Control de cheques emitidos y recibidos.
 * Un cheque pendiente NO toca el saldo. Al confirmarlo (acreditado / debitado) se registra UN solo movimiento
 * en `cuentas_movimientos` (origen "cheque", origen_id = id del cheque) mediante `sincronizarMovimientoOrigen`,
 * que evita duplicados. Cada cambio de estado queda en `cheques_historial` con fecha y usuario.
 */
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import { CuentasError, sincronizarMovimientoOrigen } from "./cuentas-pg";

function pool() {
  const p = getChatPostgresPool();
  if (!p) throw new Error("Pool PG no disponible para cheques.");
  return p;
}
const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

export type ChequeTipo = "recibido" | "emitido";
export type ChequeEstado = "pendiente" | "acreditado" | "debitado" | "rechazado" | "anulado";

export type ChequeFila = {
  id: string;
  tipo: ChequeTipo;
  numero: string;
  banco: string;
  monto: number;
  fecha_prevista: string;
  cuenta_id: string;
  cuenta_nombre: string;
  estado: ChequeEstado;
  origen: string | null;
  origen_id: string | null;
  referencia: string | null;
  observaciones: string | null;
  confirmado_at: string | null;
  confirmado_por: string | null;
  creado_por: string | null;
  /** Días hasta la fecha prevista (negativo = vencido, sin confirmar). Solo para pendientes. */
  dias: number | null;
};

const ORIGENES = new Set(["venta", "compra", "pago", "cobro"]);

export async function listarCheques(
  schemaRaw: string,
  empresaId: string,
  f: { estado?: string | null; tipo?: string | null }
): Promise<ChequeFila[]> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tK = quoteSchemaTable(schema, "cheques");
  const tC = quoteSchemaTable(schema, "cuentas_financieras");
  const { rows } = await pool().query(
    `SELECT k.*, c.nombre AS cuenta_nombre, k.fecha_prevista::text AS fecha_txt,
            (k.fecha_prevista - (now() AT TIME ZONE 'America/Asuncion')::date) AS dias
       FROM ${tK} k JOIN ${tC} c ON c.id = k.cuenta_id
      WHERE k.empresa_id=$1::uuid
        AND ($2::text IS NULL OR k.estado=$2::text)
        AND ($3::text IS NULL OR k.tipo=$3::text)
      ORDER BY (k.estado='pendiente') DESC, k.fecha_prevista ASC, k.created_at ASC
      LIMIT 500`,
    [empresaId, f.estado || null, f.tipo || null]
  );
  return rows.map((r) => ({
    id: String(r.id),
    tipo: r.tipo as ChequeTipo,
    numero: String(r.numero),
    banco: String(r.banco),
    monto: num(r.monto),
    fecha_prevista: String(r.fecha_txt),
    cuenta_id: String(r.cuenta_id),
    cuenta_nombre: String(r.cuenta_nombre),
    estado: r.estado as ChequeEstado,
    origen: r.origen ?? null,
    origen_id: r.origen_id ?? null,
    referencia: r.referencia ?? null,
    observaciones: r.observaciones ?? null,
    confirmado_at: r.confirmado_at ? new Date(r.confirmado_at as string).toISOString() : null,
    confirmado_por: r.confirmado_por ?? null,
    creado_por: r.creado_por ?? null,
    dias: r.estado === "pendiente" ? num(r.dias) : null,
  }));
}

export async function crearCheque(p: {
  schemaRaw: string;
  empresaId: string;
  sucursalId?: string | null;
  usuarioNombre?: string | null;
  tipo: string;
  numero: string;
  banco: string;
  monto: number;
  fechaPrevista: string;
  cuentaId: string;
  origen?: string | null;
  origenId?: string | null;
  referencia?: string | null;
  observaciones?: string | null;
}): Promise<{ id: string }> {
  const schema = assertAllowedChatDataSchema(p.schemaRaw);
  const tK = quoteSchemaTable(schema, "cheques");
  const tH = quoteSchemaTable(schema, "cheques_historial");
  const tC = quoteSchemaTable(schema, "cuentas_financieras");
  if (p.tipo !== "recibido" && p.tipo !== "emitido") throw new CuentasError(400, "Indicá si el cheque es emitido o recibido.");
  if (!p.numero.trim()) throw new CuentasError(400, "Ingresá el número del cheque.");
  if (!p.banco.trim()) throw new CuentasError(400, "Ingresá el banco del cheque.");
  if (!(num(p.monto) > 0)) throw new CuentasError(400, "El monto debe ser mayor a 0.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.fechaPrevista)) throw new CuentasError(400, "Ingresá la fecha prevista.");
  if (p.origen && !ORIGENES.has(p.origen)) throw new CuentasError(400, "Origen inválido.");

  const { rows: cu } = await pool().query(
    `SELECT activo FROM ${tC} WHERE id=$1::uuid AND empresa_id=$2::uuid`,
    [p.cuentaId, p.empresaId]
  );
  if (!cu[0]) throw new CuentasError(400, "La cuenta elegida no existe.");
  if (!cu[0].activo) throw new CuentasError(400, "La cuenta elegida está inactiva.");

  const { rows: dup } = await pool().query(
    `SELECT 1 FROM ${tK} WHERE empresa_id=$1::uuid AND tipo=$2 AND numero=$3 AND banco=$4 AND estado<>'anulado' LIMIT 1`,
    [p.empresaId, p.tipo, p.numero.trim(), p.banco.trim()]
  );
  if (dup[0]) throw new CuentasError(409, "Ya hay un cheque cargado con ese número y banco.");

  const { rows } = await pool().query(
    `INSERT INTO ${tK} (empresa_id, sucursal_id, tipo, numero, banco, monto, fecha_prevista, cuenta_id, origen, origen_id, referencia, observaciones, creado_por)
     VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6::numeric,$7::date,$8::uuid,$9,$10,$11,$12,$13) RETURNING id`,
    [
      p.empresaId, p.sucursalId ?? null, p.tipo, p.numero.trim(), p.banco.trim(), num(p.monto), p.fechaPrevista, p.cuentaId,
      p.origen || null, p.origenId?.trim() || null, p.referencia?.trim() || null, p.observaciones?.trim() || null, p.usuarioNombre ?? null,
    ]
  );
  await pool().query(
    `INSERT INTO ${tH} (empresa_id, cheque_id, estado_anterior, estado_nuevo, motivo, usuario_nombre)
     VALUES ($1::uuid,$2::uuid,NULL,'pendiente','Cheque registrado',$3)`,
    [p.empresaId, rows[0].id, p.usuarioNombre ?? null]
  );
  return { id: String(rows[0].id) };
}

/**
 * Cambia el estado de un cheque pendiente.
 *  acreditar (recibido) / debitar (emitido): registra el movimiento en la cuenta (una sola vez).
 *  rechazar / anular: sin movimiento.
 */
export async function resolverCheque(p: {
  schemaRaw: string;
  empresaId: string;
  chequeId: string;
  accion: "confirmar" | "rechazar" | "anular";
  motivo?: string | null;
  usuarioNombre?: string | null;
}): Promise<{ estado: ChequeEstado }> {
  const schema = assertAllowedChatDataSchema(p.schemaRaw);
  const tK = quoteSchemaTable(schema, "cheques");
  const tH = quoteSchemaTable(schema, "cheques_historial");
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT * FROM ${tK} WHERE id=$1::uuid AND empresa_id=$2::uuid FOR UPDATE`,
      [p.chequeId, p.empresaId]
    );
    const k = rows[0];
    if (!k) throw new CuentasError(404, "Cheque no encontrado.");
    if (k.estado !== "pendiente") throw new CuentasError(409, `El cheque ya está ${String(k.estado).toLowerCase()}: no se puede confirmar de nuevo.`);

    let nuevo: ChequeEstado;
    if (p.accion === "confirmar") nuevo = k.tipo === "recibido" ? "acreditado" : "debitado";
    else if (p.accion === "rechazar") nuevo = "rechazado";
    else nuevo = "anulado";

    if (p.accion !== "confirmar" && (p.motivo ?? "").trim().length < 5) {
      throw new CuentasError(400, "Indicá el motivo (mínimo 5 caracteres).");
    }

    await client.query(
      `UPDATE ${tK} SET estado=$2, confirmado_at=now(), confirmado_por=$3, updated_at=now(),
              observaciones = CASE WHEN $4::text IS NULL THEN observaciones ELSE COALESCE(observaciones || ' | ', '') || $4::text END
        WHERE id=$1::uuid`,
      [p.chequeId, nuevo, p.usuarioNombre ?? null, p.accion === "confirmar" ? null : (p.motivo ?? "").trim()]
    );
    await client.query(
      `INSERT INTO ${tH} (empresa_id, cheque_id, estado_anterior, estado_nuevo, motivo, usuario_nombre)
       VALUES ($1::uuid,$2::uuid,'pendiente',$3,$4,$5)`,
      [p.empresaId, p.chequeId, nuevo, p.accion === "confirmar" ? null : (p.motivo ?? "").trim(), p.usuarioNombre ?? null]
    );
    await client.query("COMMIT");

    if (p.accion === "confirmar") {
      try {
        await sincronizarMovimientoOrigen({
          schemaRaw: p.schemaRaw, empresaId: p.empresaId, origen: "cheque", origenId: p.chequeId,
          usuarioNombre: p.usuarioNombre,
          deseado: {
            cuentaId: String(k.cuenta_id),
            tipo: k.tipo === "recibido" ? "ingreso" : "egreso",
            monto: num(k.monto),
            concepto: `Cheque ${k.tipo === "recibido" ? "recibido" : "emitido"} N° ${k.numero} (${k.banco})`,
            referencia: k.referencia ?? null,
            sucursalId: k.sucursal_id ? String(k.sucursal_id) : null,
          },
        });
      } catch (e) {
        // Vuelve a pendiente para que no quede "confirmado" sin movimiento.
        await pool().query(`UPDATE ${tK} SET estado='pendiente', confirmado_at=NULL, confirmado_por=NULL WHERE id=$1::uuid`, [p.chequeId]).catch(() => null);
        await pool().query(`DELETE FROM ${tH} WHERE cheque_id=$1::uuid AND estado_nuevo=$2 AND id = (SELECT id FROM ${tH} WHERE cheque_id=$1::uuid ORDER BY created_at DESC LIMIT 1)`, [p.chequeId, nuevo]).catch(() => null);
        throw e;
      }
    }
    return { estado: nuevo };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => null);
    throw e;
  } finally {
    client.release();
  }
}

export async function historialCheque(schemaRaw: string, empresaId: string, chequeId: string) {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tH = quoteSchemaTable(schema, "cheques_historial");
  const { rows } = await pool().query(
    `SELECT estado_anterior, estado_nuevo, motivo, usuario_nombre, created_at FROM ${tH}
      WHERE empresa_id=$1::uuid AND cheque_id=$2::uuid ORDER BY created_at`,
    [empresaId, chequeId]
  );
  return rows.map((r) => ({
    estado_anterior: r.estado_anterior ?? null,
    estado_nuevo: String(r.estado_nuevo),
    motivo: r.motivo ?? null,
    usuario_nombre: r.usuario_nombre ?? null,
    fecha: new Date(r.created_at as string).toISOString(),
  }));
}
