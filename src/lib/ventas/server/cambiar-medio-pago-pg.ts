/**
 * Cambio del medio de pago de una venta contado completada.
 * Actualiza ventas, ventas_pagos_detalle y deja rastro en ventas_cambios_pago en UNA transacción;
 * luego sincroniza el ingreso en la cuenta (origen "venta"). No toca stock, factura ni SIFEN.
 */
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import { CuentasError, exigirCuentaSiCorresponde, sincronizarMovimientoOrigen } from "@/lib/cuentas/server/cuentas-pg";

export const METODOS_CAMBIO = ["efectivo", "transferencia", "tarjeta", "qr", "billetera", "otro"] as const;

export type CambioMedioPagoInput = {
  schemaRaw: string;
  empresaId: string;
  ventaId: string;
  usuarioId: string | null;
  usuarioNombre: string | null;
  metodoNuevo: string;
  tarjetaTipo: string | null;
  cuentaId: string | null;
  entidadBancariaId: string | null;
  entidadNombre: string | null;
  referencia: string | null;
  titular: string | null;
  motivo: string;
  confirmarConciliado: boolean;
};

export async function cambiarMedioPagoVenta(p: CambioMedioPagoInput): Promise<{ metodo_anterior: string; metodo_nuevo: string }> {
  const schema = assertAllowedChatDataSchema(p.schemaRaw);
  const tV = quoteSchemaTable(schema, "ventas");
  const tD = quoteSchemaTable(schema, "ventas_pagos_detalle");
  const tCaja = quoteSchemaTable(schema, "cajas");
  const tAud = quoteSchemaTable(schema, "ventas_cambios_pago");
  const pool = getChatPostgresPool();
  if (!pool) throw new CuentasError(500, "Pool no disponible.");

  const esEfectivo = p.metodoNuevo === "efectivo";
  const cuentaId = esEfectivo ? null : p.cuentaId;
  if (!esEfectivo) await exigirCuentaSiCorresponde(p.schemaRaw, p.empresaId, cuentaId, "donde se acredita el cobro");
  const tarjetaTipo = p.metodoNuevo === "tarjeta" ? p.tarjetaTipo : null;

  const client = await pool.connect();
  let venta: { numero_control: string; total: number; sucursal_id: string | null; metodo_pago: string | null; tarjeta_tipo: string | null };
  let detAnterior: { cuenta_id: string | null; fecha_acreditacion: string | null } | null = null;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT numero_control, total, sucursal_id, caja_id, fecha, estado, tipo_venta, metodo_pago, tarjeta_tipo
         FROM ${tV} WHERE id=$1::uuid AND empresa_id=$2::uuid FOR UPDATE`,
      [p.ventaId, p.empresaId]
    );
    const v = rows[0];
    if (!v) throw new CuentasError(404, "Venta no encontrada.");
    if (v.estado !== "completada") throw new CuentasError(409, "Solo se puede cambiar el medio de pago de ventas completadas.");
    if (v.tipo_venta !== "CONTADO") throw new CuentasError(409, "Solo se puede cambiar el medio de pago de ventas al contado.");
    if ((v.metodo_pago ?? "") === p.metodoNuevo && (v.tarjeta_tipo ?? null) === tarjetaTipo && !cuentaId) {
      throw new CuentasError(400, "La venta ya tiene ese medio de pago.");
    }

    // Caja cerrada: el arqueo ya se cerró con el medio anterior.
    if (v.caja_id) {
      const { rows: cj } = await client.query(`SELECT estado FROM ${tCaja} WHERE id=$1::uuid AND empresa_id=$2::uuid`, [v.caja_id, p.empresaId]);
      if (cj[0] && cj[0].estado !== "abierta") {
        throw new CuentasError(409, "La caja de esta venta ya fue cerrada: no se puede cambiar el medio de pago.");
      }
    } else if (v.sucursal_id) {
      const { rows: cj } = await client.query(
        `SELECT 1 FROM ${tCaja} WHERE empresa_id=$1::uuid AND sucursal_id=$2::uuid AND estado='cerrada'
            AND abierta_at <= $3::timestamptz AND cerrada_at >= $3::timestamptz LIMIT 1`,
        [p.empresaId, v.sucursal_id, v.fecha]
      );
      if (cj.length > 0) throw new CuentasError(409, "La caja de esta venta ya fue cerrada: no se puede cambiar el medio de pago.");
    }

    const { rows: dets } = await client.query(
      `SELECT id, conciliacion_estado, cuenta_id, fecha_acreditacion::text AS fecha_acreditacion
         FROM ${tD} WHERE venta_id=$1::uuid AND empresa_id=$2::uuid ORDER BY created_at LIMIT 1 FOR UPDATE`,
      [p.ventaId, p.empresaId]
    );
    const det = dets[0];
    if (det?.conciliacion_estado === "aprobado" && !p.confirmarConciliado) {
      throw new CuentasError(409, "El pago ya está aprobado en Conciliación. Confirmá el cambio para volver a dejarlo pendiente.");
    }
    detAnterior = det ? { cuenta_id: det.cuenta_id ?? null, fecha_acreditacion: det.fecha_acreditacion ?? null } : null;

    await client.query(
      `UPDATE ${tV} SET metodo_pago=$3, tarjeta_tipo=$4, updated_at=now() WHERE id=$1::uuid AND empresa_id=$2::uuid`,
      [p.ventaId, p.empresaId, p.metodoNuevo, tarjetaTipo]
    );
    if (det) {
      await client.query(
        `UPDATE ${tD} SET metodo_pago=$2, tarjeta_tipo=$3, entidad_bancaria_id=$4::uuid, entidad_nombre_snapshot=$5,
                referencia=$6, titular=$7, cuenta_id=$8::uuid, conciliacion_estado='pendiente',
                conciliado_at=NULL, conciliado_por=NULL, updated_at=now()
          WHERE id=$1::uuid`,
        [det.id, p.metodoNuevo, tarjetaTipo, esEfectivo ? null : p.entidadBancariaId, esEfectivo ? null : p.entidadNombre,
         esEfectivo ? null : p.referencia, esEfectivo ? null : p.titular, cuentaId]
      );
    } else {
      await client.query(
        `INSERT INTO ${tD} (empresa_id, venta_id, metodo_pago, tarjeta_tipo, entidad_bancaria_id, entidad_nombre_snapshot, monto, referencia, titular, cuenta_id)
         VALUES ($1::uuid,$2::uuid,$3,$4,$5::uuid,$6,$7::numeric,$8,$9,$10::uuid)`,
        [p.empresaId, p.ventaId, p.metodoNuevo, tarjetaTipo, esEfectivo ? null : p.entidadBancariaId,
         esEfectivo ? null : p.entidadNombre, v.total, esEfectivo ? null : p.referencia, esEfectivo ? null : p.titular, cuentaId]
      );
    }
    await client.query(
      `INSERT INTO ${tAud} (empresa_id, venta_id, usuario_id, usuario_nombre, metodo_anterior, metodo_nuevo,
                            tarjeta_tipo_anterior, tarjeta_tipo_nuevo, cuenta_id_nueva, motivo)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9::uuid,$10)`,
      [p.empresaId, p.ventaId, p.usuarioId, p.usuarioNombre, v.metodo_pago, p.metodoNuevo, v.tarjeta_tipo, tarjetaTipo, cuentaId, p.motivo]
    );
    await client.query("COMMIT");
    venta = {
      numero_control: String(v.numero_control), total: Number(v.total), sucursal_id: v.sucursal_id ?? null,
      metodo_pago: v.metodo_pago ?? null, tarjeta_tipo: v.tarjeta_tipo ?? null,
    };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => null);
    throw e;
  } finally {
    client.release();
  }

  // Cuenta: efectivo → anula el ingreso; otro medio → ingreso en la cuenta elegida.
  try {
    await sincronizarMovimientoOrigen({
      schemaRaw: p.schemaRaw, empresaId: p.empresaId, origen: "venta", origenId: p.ventaId,
      usuarioNombre: p.usuarioNombre,
      motivo: `Cambio de medio de pago: ${p.motivo}`,
      deseado: cuentaId
        ? {
            cuentaId, tipo: "ingreso", monto: venta.total, fecha: detAnterior?.fecha_acreditacion ?? null,
            concepto: `Venta ${venta.numero_control} (${p.metodoNuevo})`, referencia: p.referencia,
            sucursalId: venta.sucursal_id,
          }
        : null,
    });
  } catch (e) {
    // Deja la venta como estaba para no desalinear Ventas y Cuentas.
    await pool.query(`UPDATE ${tV} SET metodo_pago=$3, tarjeta_tipo=$4 WHERE id=$1::uuid AND empresa_id=$2::uuid`,
      [p.ventaId, p.empresaId, venta.metodo_pago, venta.tarjeta_tipo]).catch(() => null);
    await pool.query(`UPDATE ${tD} SET metodo_pago=$3, tarjeta_tipo=$4, cuenta_id=$5::uuid WHERE venta_id=$1::uuid AND empresa_id=$2::uuid`,
      [p.ventaId, p.empresaId, venta.metodo_pago, venta.tarjeta_tipo, detAnterior?.cuenta_id ?? null]).catch(() => null);
    throw e;
  }
  return { metodo_anterior: venta.metodo_pago ?? "", metodo_nuevo: p.metodoNuevo };
}
