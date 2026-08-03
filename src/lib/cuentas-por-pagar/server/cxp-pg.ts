/**
 * Cuentas por pagar a proveedores — capa PG.
 *
 * Reglas:
 *  - saldo = max(0, monto_original - nc_aplicado - pagado). Nunca negativo.
 *  - estado guardado: pendiente | parcial | pagada | anulada. 'vencida' es
 *    derivado en lectura (saldo>0 y fecha_vencimiento < hoy).
 *  - Impacto financiero una sola vez: la CxP se crea idempotente por compra
 *    (UNIQUE numero_control, ON CONFLICT DO NOTHING). NC y pagos ajustan saldo.
 *
 * No rompe el alta de compras: `crearCuentaPorPagarDesdeCompra` corre dentro de
 * la MISMA transacción de la compra pero bajo SAVEPOINT en el llamador, así que
 * si algo falla, la compra igual se guarda.
 */
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import type { PoolClient } from "pg";

function pool() {
  const p = getChatPostgresPool();
  if (!p) throw new Error("Pool PG no disponible para cuentas por pagar.");
  return p;
}

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

export class CxpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "CxpError";
    this.status = status;
  }
}

/** SQL que recomputa saldo + estado desde las columnas de la propia fila. */
function recomputeSql(tCxp: string): string {
  return `UPDATE ${tCxp} SET
            saldo = GREATEST(0, monto_original - nc_aplicado - pagado),
            estado = CASE
              WHEN estado = 'anulada' THEN 'anulada'
              WHEN GREATEST(0, monto_original - nc_aplicado - pagado) <= 0 THEN 'pagada'
              WHEN pagado > 0 OR nc_aplicado > 0 THEN 'parcial'
              ELSE 'pendiente' END,
            updated_at = now()
          WHERE id = $1::uuid`;
}

/**
 * Crea la CxP de una compra a crédito DENTRO de la transacción de la compra.
 * Idempotente (ON CONFLICT DO NOTHING). El llamador la envuelve en SAVEPOINT.
 */
export async function crearCuentaPorPagarDesdeCompra(
  client: PoolClient,
  schemaRaw: string,
  params: {
    empresaId: string;
    sucursalId: string;
    compraNumeroControl: string;
    proveedorId: string | null;
    proveedorNombre: string;
    numeroFacturaProveedor: string | null;
    fechaFactura: string | null; // YYYY-MM-DD
    plazoDias: number | null;
    montoOriginal: number;
    moneda: string;
    usuarioId: string | null;
    usuarioNombre: string | null;
  }
): Promise<void> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tCxp = quoteSchemaTable(schema, "cuentas_por_pagar");

  // Vencimiento = (fecha_factura o hoy Asunción) + plazo_dias.
  const base = params.fechaFactura
    ? `$6::date`
    : `(now() AT TIME ZONE 'America/Asuncion')::date`;
  const venc =
    params.plazoDias != null
      ? `(${base} + ($7::int) * INTERVAL '1 day')::date`
      : `NULL::date`;

  await client.query(
    `INSERT INTO ${tCxp}
       (empresa_id, sucursal_id, compra_numero_control, proveedor_id, proveedor_nombre,
        numero_factura_proveedor, fecha_factura, fecha_vencimiento, moneda,
        monto_original, nc_aplicado, pagado, saldo, estado, created_by, usuario_nombre)
     VALUES ($1::uuid,$2::uuid,$3,$4,$5,
             $8,$6::date,${venc},$9,
             $10::numeric,0,0,$10::numeric,'pendiente',$11,$12)
     ON CONFLICT (empresa_id, compra_numero_control) DO NOTHING`,
    [
      params.empresaId, params.sucursalId, params.compraNumeroControl,
      params.proveedorId, params.proveedorNombre,
      params.fechaFactura, params.plazoDias,
      params.numeroFacturaProveedor, params.moneda,
      params.montoOriginal, params.usuarioId, params.usuarioNombre,
    ]
  );
}

/** Aplica una NC de proveedor al saldo (dentro de la tx de la NC, bajo SAVEPOINT). */
export async function aplicarNCaCuentaPorPagar(
  client: PoolClient,
  schemaRaw: string,
  empresaId: string,
  compraNumeroControl: string,
  monto: number
): Promise<void> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tCxp = quoteSchemaTable(schema, "cuentas_por_pagar");
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM ${tCxp}
      WHERE empresa_id = $1::uuid AND compra_numero_control = $2 AND estado <> 'anulada'
      FOR UPDATE`,
    [empresaId, compraNumeroControl]
  );
  if (!rows[0]) return; // no hay CxP (compra al contado): nada que ajustar.
  const id = rows[0].id;
  // nc_aplicado no puede dejar saldo negativo: se limita a monto_original - pagado.
  await client.query(
    `UPDATE ${tCxp}
        SET nc_aplicado = LEAST(monto_original - pagado, nc_aplicado + $2::numeric)
      WHERE id = $1::uuid`,
    [id, num(monto)]
  );
  await client.query(recomputeSql(tCxp), [id]);
}

/** Revierte una NC de proveedor del saldo (al anular la NC, bajo SAVEPOINT). */
export async function revertirNCdeCuentaPorPagar(
  client: PoolClient,
  schemaRaw: string,
  empresaId: string,
  compraNumeroControl: string,
  monto: number
): Promise<void> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tCxp = quoteSchemaTable(schema, "cuentas_por_pagar");
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM ${tCxp}
      WHERE empresa_id = $1::uuid AND compra_numero_control = $2 AND estado <> 'anulada'
      FOR UPDATE`,
    [empresaId, compraNumeroControl]
  );
  if (!rows[0]) return;
  const id = rows[0].id;
  await client.query(
    `UPDATE ${tCxp} SET nc_aplicado = GREATEST(0, nc_aplicado - $2::numeric) WHERE id = $1::uuid`,
    [id, num(monto)]
  );
  await client.query(recomputeSql(tCxp), [id]);
}

export type CxpRow = {
  id: string;
  compra_numero_control: string;
  proveedor_nombre: string;
  numero_factura_proveedor: string | null;
  fecha_factura: string | null;
  fecha_vencimiento: string | null;
  moneda: string;
  monto_original: number;
  nc_aplicado: number;
  pagado: number;
  saldo: number;
  estado: string;
  vencida: boolean;
  dias_para_vencer: number | null;
};

/** Lista las CxP de la sucursal. `hoyISO` para derivar vencida/días. */
export async function listCuentasPorPagar(
  schemaRaw: string,
  empresaId: string,
  sucursalId: string,
  hoyISO: string
): Promise<CxpRow[]> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tCxp = quoteSchemaTable(schema, "cuentas_por_pagar");
  const { rows } = await pool().query(
    `SELECT id, compra_numero_control, proveedor_nombre, numero_factura_proveedor,
            fecha_factura, fecha_vencimiento, moneda,
            monto_original, nc_aplicado, pagado, saldo, estado,
            (estado <> 'anulada' AND saldo > 0 AND fecha_vencimiento IS NOT NULL
              AND fecha_vencimiento < $3::date) AS vencida,
            CASE WHEN fecha_vencimiento IS NULL THEN NULL
                 ELSE (fecha_vencimiento - $3::date) END AS dias_para_vencer
       FROM ${tCxp}
      WHERE empresa_id = $1::uuid AND sucursal_id = $2::uuid
      ORDER BY (estado <> 'anulada' AND saldo > 0) DESC,
               fecha_vencimiento ASC NULLS LAST, created_at DESC
      LIMIT 1000`,
    [empresaId, sucursalId, hoyISO]
  );
  return rows.map((r) => ({
    id: r.id,
    compra_numero_control: r.compra_numero_control,
    proveedor_nombre: r.proveedor_nombre,
    numero_factura_proveedor: r.numero_factura_proveedor,
    fecha_factura: r.fecha_factura ? String(r.fecha_factura).slice(0, 10) : null,
    fecha_vencimiento: r.fecha_vencimiento ? String(r.fecha_vencimiento).slice(0, 10) : null,
    moneda: r.moneda,
    monto_original: num(r.monto_original),
    nc_aplicado: num(r.nc_aplicado),
    pagado: num(r.pagado),
    saldo: num(r.saldo),
    estado: r.estado,
    vencida: !!r.vencida,
    dias_para_vencer: r.dias_para_vencer == null ? null : Number(r.dias_para_vencer),
  }));
}

/** Resumen para el dashboard: facturas de proveedores por vencer (saldo>0). */
export async function getResumenPorVencer(
  schemaRaw: string,
  empresaId: string,
  sucursalId: string,
  hoyISO: string
): Promise<{
  vencidas: number; vencen_hoy: number; proximos_3: number;
  saldo_total: number;
  items: Array<{ id: string; proveedor_nombre: string; numero_factura_proveedor: string | null; fecha_vencimiento: string | null; saldo: number; dias: number | null; vencida: boolean }>;
}> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tCxp = quoteSchemaTable(schema, "cuentas_por_pagar");
  const { rows } = await pool().query(
    `SELECT id, proveedor_nombre, numero_factura_proveedor, fecha_vencimiento, saldo,
            CASE WHEN fecha_vencimiento IS NULL THEN NULL ELSE (fecha_vencimiento - $3::date) END AS dias
       FROM ${tCxp}
      WHERE empresa_id = $1::uuid AND sucursal_id = $2::uuid
        AND estado <> 'anulada' AND saldo > 0
        AND fecha_vencimiento IS NOT NULL
        AND fecha_vencimiento <= ($3::date + INTERVAL '3 days')
      ORDER BY fecha_vencimiento ASC`,
    [empresaId, sucursalId, hoyISO]
  );
  let vencidas = 0, vencen_hoy = 0, proximos_3 = 0, saldo_total = 0;
  const items = rows.map((r) => {
    const dias = r.dias == null ? null : Number(r.dias);
    const saldo = num(r.saldo);
    saldo_total += saldo;
    const vencida = dias != null && dias < 0;
    if (dias != null) {
      if (dias < 0) vencidas++;
      else if (dias === 0) vencen_hoy++;
      else proximos_3++;
    }
    return {
      id: r.id,
      proveedor_nombre: r.proveedor_nombre,
      numero_factura_proveedor: r.numero_factura_proveedor,
      fecha_vencimiento: r.fecha_vencimiento ? String(r.fecha_vencimiento).slice(0, 10) : null,
      saldo,
      dias,
      vencida,
    };
  });
  return { vencidas, vencen_hoy, proximos_3, saldo_total, items };
}

/** Registra un pago a proveedor. Atómico; rechaza pagar más que el saldo. */
export async function registrarPagoProveedor(params: {
  schemaRaw: string;
  empresaId: string;
  sucursalId: string;
  cuentaPorPagarId: string;
  monto: number;
  metodoPago: string;
  referencia: string | null;
  fecha: string | null; // YYYY-MM-DD
  usuarioId: string | null;
  usuarioNombre: string | null;
}): Promise<{ saldo: number; estado: string }> {
  const schema = assertAllowedChatDataSchema(params.schemaRaw);
  const tCxp = quoteSchemaTable(schema, "cuentas_por_pagar");
  const tPgp = quoteSchemaTable(schema, "pagos_proveedor");
  const monto = num(params.monto);
  if (monto <= 0) throw new CxpError(400, "El monto del pago debe ser mayor a 0.");

  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const { rows: cta } = await client.query<{ id: string; saldo: string; estado: string }>(
      `SELECT id, saldo, estado FROM ${tCxp}
        WHERE id = $1::uuid AND empresa_id = $2::uuid AND sucursal_id = $3::uuid FOR UPDATE`,
      [params.cuentaPorPagarId, params.empresaId, params.sucursalId]
    );
    if (!cta[0]) throw new CxpError(404, "Cuenta por pagar no encontrada.");
    if (cta[0].estado === "anulada") throw new CxpError(409, "La cuenta está anulada.");
    const saldo = num(cta[0].saldo);
    if (saldo <= 0) throw new CxpError(409, "La cuenta ya está saldada.");
    if (monto > saldo) throw new CxpError(400, `El pago (${monto}) supera el saldo pendiente (${saldo}).`);

    await client.query(
      `INSERT INTO ${tPgp}
         (empresa_id, sucursal_id, cuenta_por_pagar_id, fecha, monto, metodo_pago, referencia,
          created_by, usuario_nombre)
       VALUES ($1::uuid,$2::uuid,$3::uuid, COALESCE($4::date,(now() AT TIME ZONE 'America/Asuncion')::date),
               $5::numeric,$6,$7,$8::uuid,$9)`,
      [
        params.empresaId, params.sucursalId, params.cuentaPorPagarId, params.fecha,
        monto, params.metodoPago, params.referencia, params.usuarioId, params.usuarioNombre,
      ]
    );
    await client.query(
      `UPDATE ${tCxp} SET pagado = pagado + $2::numeric WHERE id = $1::uuid`,
      [params.cuentaPorPagarId, monto]
    );
    await client.query(recomputeSql(tCxp), [params.cuentaPorPagarId]);

    const { rows: fin } = await client.query<{ saldo: string; estado: string }>(
      `SELECT saldo, estado FROM ${tCxp} WHERE id = $1::uuid`,
      [params.cuentaPorPagarId]
    );
    await client.query("COMMIT");
    return { saldo: num(fin[0]?.saldo), estado: fin[0]?.estado ?? "parcial" };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => null);
    throw e;
  } finally {
    client.release();
  }
}
