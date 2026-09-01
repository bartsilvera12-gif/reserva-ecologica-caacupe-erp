/**
 * Cobro a cuenta corriente con emisión de recibo, en UNA transacción PG.
 *
 * Caso real: el cliente paga un monto que cubre VARIAS facturas. Se registra un
 * cobro por cada cuenta (para que cada saldo se actualice con la lógica de
 * siempre) y UN solo recibo que las detalla.
 *
 * Atomicidad: o se registran todos los cobros y el recibo, o no se registra
 * nada. Con FOR UPDATE sobre cada cuenta, dos cobros simultáneos sobre la misma
 * factura no pueden sobregirar el saldo.
 *
 * El recibo es documento INTERNO NO FISCAL: no toca SIFEN ni las facturas.
 */
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";

function pool() {
  const p = getChatPostgresPool();
  if (!p) throw new Error("Pool PG no disponible para cobros.");
  return p;
}

export class CobroReciboError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "CobroReciboError";
    this.status = status;
  }
}

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

const METODOS = new Set(["efectivo", "transferencia", "tarjeta", "cheque", "deposito"]);
const metodoValido = (m: string | null | undefined) => {
  const x = (m ?? "").trim().toLowerCase();
  return METODOS.has(x) ? x : "efectivo";
};

export type AplicacionCobro = {
  cuenta_por_cobrar_id: string;
  importe: number;
};

/** Aplicación de una NC contra una CxC dentro de este cobro. */
export type AplicacionNc = {
  nota_credito_id: string;
  cuenta_por_cobrar_destino_id: string;
  importe_aplicado: number;
};

export type CobrarConReciboInput = {
  schemaRaw: string;
  empresaId: string;
  sucursalId: string;
  clienteId: string;
  aplicaciones: AplicacionCobro[];
  /** NCs del cliente que se aplican como linea negativa en este cobro. */
  nc_aplicaciones?: AplicacionNc[];
  metodo_pago?: string | null;
  entidad_bancaria_id?: string | null;
  referencia?: string | null;
  observaciones?: string | null;
  fecha_pago?: string | null;
  usuarioId: string | null;
  usuarioNombre: string | null;
};

/** Próximo REC-XXXXXX por sucursal, con advisory lock (se libera al COMMIT). */
async function proximoNumeroRecibo(
  client: import("pg").PoolClient,
  schema: string,
  empresaId: string,
  sucursalId: string
): Promise<string> {
  const t = quoteSchemaTable(schema, "recibos_dinero");
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${empresaId}:${sucursalId}:recibo`]);
  const { rows } = await client.query<{ maxn: number | null }>(
    `SELECT COALESCE(MAX(
       CASE WHEN numero_recibo ~ '^REC-[0-9]+$' THEN (substring(numero_recibo from 5))::int ELSE 0 END
     ), 0) AS maxn
     FROM ${t} WHERE empresa_id = $1::uuid AND sucursal_id = $2::uuid`,
    [empresaId, sucursalId]
  );
  return `REC-${String(Number(rows[0]?.maxn ?? 0) + 1).padStart(6, "0")}`;
}

export async function cobrarConRecibo(
  p: CobrarConReciboInput
): Promise<{ recibo_id: string; numero_recibo: string; total: number }> {
  const schema = assertAllowedChatDataSchema(p.schemaRaw);
  const tC = quoteSchemaTable(schema, "cuentas_por_cobrar");
  const tCob = quoteSchemaTable(schema, "cobros_clientes");
  const tR = quoteSchemaTable(schema, "recibos_dinero");
  const tRI = quoteSchemaTable(schema, "recibos_dinero_items");
  const tCli = quoteSchemaTable(schema, "clientes");
  const tFac = quoteSchemaTable(schema, "facturas");

  const aplic = (p.aplicaciones ?? []).filter((a) => a.cuenta_por_cobrar_id && round2(a.importe) > 0);
  if (aplic.length === 0) {
    throw new CobroReciboError(400, "Indicá al menos una factura con importe mayor a 0.");
  }

  const client = await pool().connect();
  try {
    await client.query("BEGIN");

    // Datos del cliente para el encabezado del recibo.
    const { rows: cli } = await client.query<{ nombre: string | null; ruc: string | null; documento: string | null }>(
      `SELECT COALESCE(NULLIF(TRIM(nombre_facturacion),''), NULLIF(TRIM(empresa),''),
                       NULLIF(TRIM(nombre_contacto),''), NULLIF(TRIM(nombre),'')) AS nombre,
              ruc, documento
         FROM ${tCli} WHERE id = $1::uuid AND empresa_id = $2::uuid`,
      [p.clienteId, p.empresaId]
    );
    if (!cli[0]) throw new CobroReciboError(404, "Cliente no encontrado.");
    const clienteNombre = (cli[0].nombre ?? "").trim() || "Cliente";
    const clienteDoc = (cli[0].ruc ?? cli[0].documento ?? "").trim() || null;

    const fechaPago = p.fecha_pago && p.fecha_pago.trim() ? p.fecha_pago : new Date().toISOString();
    const metodo = metodoValido(p.metodo_pago);

    let total = 0;
    const items: Array<{
      cxcId: string; cobroId: string; facturaId: string | null;
      numeroDoc: string | null; venc: string | null; importe: number;
    }> = [];

    for (const a of aplic) {
      const importe = round2(a.importe);

      // Bloquear la cuenta: impide que dos cobros simultáneos sobregiren el saldo.
      const { rows: cxcRows } = await client.query<{
        id: string; cliente_id: string; venta_id: string | null; total: string; saldo: string;
        estado: string; numero_venta: string | null; fecha_vencimiento: string | null; sucursal_id: string | null;
      }>(
        `SELECT id, cliente_id, venta_id, total, saldo, estado, numero_venta, fecha_vencimiento, sucursal_id
           FROM ${tC} WHERE id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE`,
        [a.cuenta_por_cobrar_id, p.empresaId]
      );
      const cxc = cxcRows[0];
      if (!cxc) throw new CobroReciboError(404, "Cuenta por cobrar no encontrada.");
      if (cxc.cliente_id !== p.clienteId) {
        throw new CobroReciboError(400, "Todas las facturas deben ser del mismo cliente.");
      }
      // Aislamiento por sucursal: no se cobra una cuenta de otra sucursal.
      if (cxc.sucursal_id && cxc.sucursal_id !== p.sucursalId) {
        throw new CobroReciboError(403, "La cuenta pertenece a otra sucursal.");
      }
      if (cxc.estado === "anulado") throw new CobroReciboError(409, "Una de las cuentas está anulada.");
      if (cxc.estado === "pagado") throw new CobroReciboError(409, "Una de las cuentas ya está pagada.");

      const saldoActual = round2(num(cxc.saldo));
      const totalCxc = round2(num(cxc.total));
      if (importe > saldoActual + 0.001) {
        throw new CobroReciboError(
          400,
          `El importe (${importe}) supera el saldo pendiente (${saldoActual}) de ${cxc.numero_venta ?? "la cuenta"}.`
        );
      }

      // 1) Cobro de esta cuenta.
      const { rows: cobRows } = await client.query<{ id: string }>(
        `INSERT INTO ${tCob}
           (empresa_id, sucursal_id, cliente_id, cuenta_por_cobrar_id, venta_id, fecha_pago, monto,
            metodo_pago, entidad_bancaria_id, referencia, observaciones, usuario_id, usuario_nombre)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::timestamptz,$7::numeric,
                 $8,$9::uuid,$10,$11,$12::uuid,$13)
         RETURNING id`,
        [
          p.empresaId, p.sucursalId, p.clienteId, cxc.id, cxc.venta_id, fechaPago, importe,
          metodo, p.entidad_bancaria_id || null, p.referencia?.trim() || null,
          p.observaciones?.trim() || null, p.usuarioId, p.usuarioNombre,
        ]
      );
      const cobroId = cobRows[0]!.id;

      // 2) Saldo y estado (misma regla que el cobro de una sola cuenta).
      const saldoNuevo = round2(saldoActual - importe);
      const estadoNuevo = saldoNuevo <= 0.001 ? "pagado" : saldoNuevo < totalCxc ? "parcial" : "pendiente";
      await client.query(
        `UPDATE ${tC} SET saldo = $1::numeric, estado = $2, updated_at = now()
          WHERE id = $3::uuid AND empresa_id = $4::uuid`,
        [saldoNuevo < 0 ? 0 : saldoNuevo, estadoNuevo, cxc.id, p.empresaId]
      );

      // Número de factura para el detalle del recibo (si la venta tiene factura).
      let facturaId: string | null = null;
      let numeroDoc: string | null = cxc.numero_venta;
      if (cxc.venta_id) {
        const { rows: fac } = await client.query<{ id: string; numero_factura: string | null }>(
          `SELECT id, numero_factura FROM ${tFac}
            WHERE empresa_id = $1::uuid AND origen_venta_id = $2::uuid LIMIT 1`,
          [p.empresaId, cxc.venta_id]
        );
        if (fac[0]) {
          facturaId = fac[0].id;
          numeroDoc = fac[0].numero_factura ?? numeroDoc;
        }
      }

      // Nota (2026-09-01): revertido el update de facturas.saldo aqui. El
      // cobro solo debe reducir cuentas_por_cobrar.saldo (dominio operativo).
      // facturas.saldo se reserva para eventos fiscales (NC aprobadas). Las
      // dos tablas modelan cosas distintas y se sincronizan por otro flujo
      // (proximo: aplicacion explicita de NC al cobro).

      total = round2(total + importe);
      items.push({
        cxcId: cxc.id, cobroId, facturaId, numeroDoc,
        venc: cxc.fecha_vencimiento, importe,
      });
    }

    // 2c) Aplicaciones de NC: cada NC del cliente que el operador decide usar
    //     en este cobro se descuenta del `saldo_disponible` de esa NC y del
    //     `saldo` de la CxC destino. Se registra en nota_credito_aplicaciones.
    //     El monto NETO del recibo = suma cobros - suma NCs aplicadas.
    const tNc  = quoteSchemaTable(schema, "nota_credito");
    const tNcA = quoteSchemaTable(schema, "nota_credito_aplicaciones");
    const ncApps = (p.nc_aplicaciones ?? []).filter(
      (a) => a.nota_credito_id && a.cuenta_por_cobrar_destino_id && round2(a.importe_aplicado) > 0
    );
    const ncAppsProcesadas: Array<{
      ncId: string;
      cxcId: string;
      importe: number;
      numeroDocDestino: string | null;
      facturaIdDestino: string | null;
      vencDestino: string | null;
      ncFacturaOrigenNumero: string | null;
    }> = [];
    let totalNcAplicado = 0;
    for (const a of ncApps) {
      // NC con lock — validar saldo disponible.
      const ncQ = await client.query<{
        id: string; monto: string; saldo_disponible: string;
        cliente_id: string; estado_erp: string; factura_id: string;
      }>(
        `SELECT id, monto, saldo_disponible, cliente_id, estado_erp, factura_id
           FROM ${tNc}
          WHERE id = $1::uuid AND empresa_id = $2::uuid
          FOR UPDATE`,
        [a.nota_credito_id, p.empresaId]
      );
      const nc = ncQ.rows[0];
      if (!nc) throw new CobroReciboError(404, `NC ${a.nota_credito_id} no encontrada.`);
      if (nc.estado_erp !== "aprobada") {
        throw new CobroReciboError(409, `La NC no está aprobada (estado=${nc.estado_erp}).`);
      }
      if (nc.cliente_id !== p.clienteId) {
        throw new CobroReciboError(400, "La NC pertenece a otro cliente.");
      }
      const impAplic = round2(a.importe_aplicado);
      const sd = round2(num(nc.saldo_disponible));
      if (impAplic > sd + 0.001) {
        throw new CobroReciboError(
          400,
          `El importe de la NC (${impAplic}) supera su saldo disponible (${sd}).`
        );
      }

      // CxC destino con lock (misma reglas que un cobro comun).
      const cxcQ = await client.query<{
        id: string; cliente_id: string; total: string; saldo: string;
        estado: string; venta_id: string | null;
      }>(
        `SELECT id, cliente_id, total, saldo, estado, venta_id
           FROM ${tC}
          WHERE id = $1::uuid AND empresa_id = $2::uuid
          FOR UPDATE`,
        [a.cuenta_por_cobrar_destino_id, p.empresaId]
      );
      const cxcDest = cxcQ.rows[0];
      if (!cxcDest) throw new CobroReciboError(404, "Cuenta por cobrar destino no encontrada.");
      if (cxcDest.cliente_id !== p.clienteId) {
        throw new CobroReciboError(400, "La CxC destino pertenece a otro cliente.");
      }
      if (cxcDest.estado === "anulado") {
        throw new CobroReciboError(409, "La CxC destino está anulada.");
      }
      const saldoDest = round2(num(cxcDest.saldo));
      if (impAplic > saldoDest + 0.001) {
        throw new CobroReciboError(
          400,
          `El importe NC (${impAplic}) supera el saldo pendiente (${saldoDest}) de la CxC destino.`
        );
      }

      // Descuento en la CxC destino.
      const saldoNuevo = round2(saldoDest - impAplic);
      const totalDest = round2(num(cxcDest.total));
      const estadoNuevo =
        saldoNuevo <= 0.001 ? "pagado" : saldoNuevo < totalDest ? "parcial" : "pendiente";
      await client.query(
        `UPDATE ${tC} SET saldo = $1::numeric, estado = $2, updated_at = now()
          WHERE id = $3::uuid AND empresa_id = $4::uuid`,
        [saldoNuevo < 0 ? 0 : saldoNuevo, estadoNuevo, cxcDest.id, p.empresaId]
      );

      // Descuento del saldo_disponible de la NC.
      await client.query(
        `UPDATE ${tNc} SET saldo_disponible = GREATEST(0::numeric, saldo_disponible - $1::numeric),
                          updated_at = now()
          WHERE id = $2::uuid AND empresa_id = $3::uuid`,
        [impAplic, nc.id, p.empresaId]
      );

      // Resolver etiqueta legible de la CxC destino (numero de factura si hay).
      let numeroDocDestino: string | null = null;
      let facturaIdDestino: string | null = null;
      let vencDestino: string | null = null;
      if (cxcDest.venta_id) {
        const { rows: facDest } = await client.query<{ id: string; numero_factura: string | null }>(
          `SELECT id, numero_factura FROM ${tFac}
            WHERE empresa_id = $1::uuid AND origen_venta_id = $2::uuid LIMIT 1`,
          [p.empresaId, cxcDest.venta_id]
        );
        if (facDest[0]) {
          facturaIdDestino = facDest[0].id;
          numeroDocDestino = facDest[0].numero_factura ?? null;
        }
      }
      // Nro factura de origen de la NC (informativo para el detalle del recibo).
      let ncFacturaOrigenNumero: string | null = null;
      const { rows: facOri } = await client.query<{ numero_factura: string | null }>(
        `SELECT numero_factura FROM ${tFac} WHERE id = $1::uuid`,
        [nc.factura_id]
      );
      if (facOri[0]?.numero_factura) ncFacturaOrigenNumero = facOri[0].numero_factura;

      ncAppsProcesadas.push({
        ncId: nc.id,
        cxcId: cxcDest.id,
        importe: impAplic,
        numeroDocDestino,
        facturaIdDestino,
        vencDestino,
        ncFacturaOrigenNumero,
      });
      totalNcAplicado = round2(totalNcAplicado + impAplic);
    }

    const totalNeto = round2(total - totalNcAplicado);
    if (totalNeto < 0) {
      throw new CobroReciboError(400, "Las NC aplicadas superan al total del cobro.");
    }

    // 3) Un solo recibo por el total, con su detalle.
    const numeroRecibo = await proximoNumeroRecibo(client, schema, p.empresaId, p.sucursalId);
    const { rows: recRows } = await client.query<{ id: string }>(
      `INSERT INTO ${tR}
         (empresa_id, sucursal_id, numero_recibo, cliente_id, cliente_nombre, cliente_documento,
          origen, fecha, moneda, monto, metodo_pago, entidad_bancaria_id, referencia,
          concepto, observaciones, usuario_id, usuario_nombre)
       VALUES ($1::uuid,$2::uuid,$3,$4::uuid,$5,$6,'cobro_cxc',$7::timestamptz,'GS',$8::numeric,
               $9,$10::uuid,$11,$12,$13,$14::uuid,$15)
       RETURNING id`,
      [
        p.empresaId, p.sucursalId, numeroRecibo, p.clienteId, clienteNombre, clienteDoc,
        fechaPago, totalNeto, metodo, p.entidad_bancaria_id || null, p.referencia?.trim() || null,
        `Cobro de ${items.length} ${items.length === 1 ? "documento" : "documentos"}${ncAppsProcesadas.length > 0 ? ` con ${ncAppsProcesadas.length} NC aplicada${ncAppsProcesadas.length === 1 ? "" : "s"}` : ""}`,
        p.observaciones?.trim() || null, p.usuarioId, p.usuarioNombre,
      ]
    );
    const reciboId = recRows[0]!.id;

    for (const it of items) {
      await client.query(
        `INSERT INTO ${tRI}
           (recibo_id, empresa_id, cuenta_por_cobrar_id, cobro_cliente_id, factura_id,
            numero_documento, fecha_vencimiento, importe_aplicado)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7::date,$8::numeric)`,
        [reciboId, p.empresaId, it.cxcId, it.cobroId, it.facturaId, it.numeroDoc, it.venc, it.importe]
      );
    }

    // Registro formal de cada aplicacion NC (con vinculo al recibo).
    for (const na of ncAppsProcesadas) {
      await client.query(
        `INSERT INTO ${tNcA}
           (empresa_id, sucursal_id, nota_credito_id, cuenta_por_cobrar_id,
            recibo_id, cobro_cliente_id, importe_aplicado,
            usuario_id, usuario_nombre)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,NULL,$6::numeric,$7::uuid,$8)`,
        [
          p.empresaId, p.sucursalId, na.ncId, na.cxcId,
          reciboId, na.importe, p.usuarioId, p.usuarioNombre,
        ]
      );
    }

    await client.query("COMMIT");
    return {
      recibo_id: reciboId,
      numero_recibo: numeroRecibo,
      total: totalNeto,
    };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => null);
    throw e;
  } finally {
    client.release();
  }
}

/** Cuentas por cobrar pendientes de un cliente, en la sucursal del usuario. */
export async function cuentasPendientesDeCliente(params: {
  schemaRaw: string;
  empresaId: string;
  sucursalId: string;
  clienteId: string;
}): Promise<Array<{ id: string; numero: string; fecha_vencimiento: string | null; total: number; saldo: number }>> {
  const schema = assertAllowedChatDataSchema(params.schemaRaw);
  const tC = quoteSchemaTable(schema, "cuentas_por_cobrar");
  const tFac = quoteSchemaTable(schema, "facturas");
  const { rows } = await pool().query(
    `SELECT c.id,
            COALESCE(f.numero_factura, c.numero_venta) AS numero,
            c.fecha_vencimiento, c.total, c.saldo
       FROM ${tC} c
       LEFT JOIN ${tFac} f ON f.origen_venta_id = c.venta_id AND f.empresa_id = c.empresa_id
      WHERE c.empresa_id = $1::uuid AND c.sucursal_id = $2::uuid AND c.cliente_id = $3::uuid
        AND c.saldo > 0 AND c.estado <> 'anulado'
      ORDER BY c.fecha_vencimiento NULLS LAST, c.created_at`,
    [params.empresaId, params.sucursalId, params.clienteId]
  );
  return rows.map((r) => ({
    id: r.id,
    numero: r.numero ?? "—",
    fecha_vencimiento: r.fecha_vencimiento,
    total: num(r.total),
    saldo: num(r.saldo),
  }));
}

/** NCs aprobadas del cliente con saldo disponible para aplicar en un cobro. */
export async function ncDisponiblesDeCliente(params: {
  schemaRaw: string;
  empresaId: string;
  clienteId: string;
}): Promise<Array<{
  id: string;
  monto: number;
  saldo_disponible: number;
  factura_origen_numero: string | null;
  motivo: string | null;
  created_at: string;
}>> {
  const schema = assertAllowedChatDataSchema(params.schemaRaw);
  const tNc = quoteSchemaTable(schema, "nota_credito");
  const tFac = quoteSchemaTable(schema, "facturas");
  const { rows } = await pool().query(
    `SELECT nc.id, nc.monto, nc.saldo_disponible, nc.motivo, nc.created_at,
            f.numero_factura AS factura_origen_numero
       FROM ${tNc} nc
       LEFT JOIN ${tFac} f ON f.id = nc.factura_id
      WHERE nc.empresa_id = $1::uuid
        AND nc.cliente_id = $2::uuid
        AND nc.estado_erp = 'aprobada'
        AND nc.saldo_disponible > 0.001
      ORDER BY nc.created_at`,
    [params.empresaId, params.clienteId]
  );
  return rows.map((r) => ({
    id: String(r.id),
    monto: num(r.monto),
    saldo_disponible: num(r.saldo_disponible),
    factura_origen_numero: r.factura_origen_numero ?? null,
    motivo: r.motivo ?? null,
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }));
}
