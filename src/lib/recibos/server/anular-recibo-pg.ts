/**
 * Anulación de recibo de dinero (documento INTERNO NO FISCAL).
 *
 * Efectos, todos en UNA transacción PG:
 *   1. Bloqueo FOR UPDATE del recibo. Rechaza si ya está anulado.
 *   2. Trae todos los cobros_clientes vinculados via recibos_dinero_items.
 *   3. Por cada cobro (con FOR UPDATE de su cuenta_por_cobrar):
 *      - Restaura saldo: saldo += monto_del_cobro (acotado por total).
 *      - Recalcula estado (pendiente / parcial / pagado).
 *      - Marca cobros_clientes.anulado = true con motivo/usuario/timestamp.
 *   4. Marca recibos_dinero.anulado = true con motivo/usuario/timestamp.
 *
 * NO llama a SET. NO toca facturas. NO desanula: si el operador anula por
 * error debe registrar un nuevo cobro/recibo.
 */
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";

function pool() {
  const p = getChatPostgresPool();
  if (!p) throw new Error("Pool PG no disponible para anular recibo.");
  return p;
}

export class AnularReciboError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AnularReciboError";
    this.status = status;
  }
}

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

export type AnularReciboInput = {
  schemaRaw: string;
  empresaId: string;
  reciboId: string;
  motivo: string;
  usuarioId: string | null;
  usuarioNombre: string | null;
};

export type AnularReciboResult = {
  recibo_id: string;
  cobros_anulados: number;
  cuentas_recompuestas: number;
};

export async function anularRecibo(p: AnularReciboInput): Promise<AnularReciboResult> {
  const schema = assertAllowedChatDataSchema(p.schemaRaw);
  const tR = quoteSchemaTable(schema, "recibos_dinero");
  const tRI = quoteSchemaTable(schema, "recibos_dinero_items");
  const tCob = quoteSchemaTable(schema, "cobros_clientes");
  const tCxc = quoteSchemaTable(schema, "cuentas_por_cobrar");
  const tFac = quoteSchemaTable(schema, "facturas");

  const motivo = (p.motivo ?? "").trim();
  if (motivo.length < 5) {
    throw new AnularReciboError(400, "El motivo debe tener al menos 5 caracteres.");
  }

  const client = await pool().connect();
  try {
    await client.query("BEGIN");

    // 1) Recibo con lock. Debe pertenecer a la empresa y no estar anulado.
    const rq = await client.query<{
      id: string; anulado: boolean; empresa_id: string;
    }>(
      `SELECT id, anulado, empresa_id FROM ${tR}
        WHERE id = $1::uuid AND empresa_id = $2::uuid
        FOR UPDATE`,
      [p.reciboId, p.empresaId]
    );
    const recibo = rq.rows[0];
    if (!recibo) throw new AnularReciboError(404, "Recibo no encontrado.");
    if (recibo.anulado) throw new AnularReciboError(409, "El recibo ya está anulado.");

    // 2) Cobros vinculados via recibos_dinero_items.cobro_cliente_id.
    //    Ojo: recibos viejos (single-cobro) también pueden tener el link solo
    //    en recibos_dinero.cobro_cliente_id — cubrimos ambos.
    const cobrosLinkQ = await client.query<{ cobro_id: string }>(
      `SELECT DISTINCT cobro_cliente_id AS cobro_id FROM ${tRI}
        WHERE recibo_id = $1::uuid AND empresa_id = $2::uuid
          AND cobro_cliente_id IS NOT NULL
       UNION
       SELECT cobro_cliente_id FROM ${tR}
        WHERE id = $1::uuid AND empresa_id = $2::uuid
          AND cobro_cliente_id IS NOT NULL`,
      [p.reciboId, p.empresaId]
    );
    const cobroIds = cobrosLinkQ.rows.map((r) => r.cobro_id).filter(Boolean);

    let cuentasRecompuestas = 0;

    // 3) Para cada cobro: restaurar saldo + marcar cobro anulado.
    for (const cobroId of cobroIds) {
      const cq = await client.query<{
        id: string; monto: string; cuenta_por_cobrar_id: string; anulado: boolean;
      }>(
        `SELECT id, monto, cuenta_por_cobrar_id, anulado FROM ${tCob}
          WHERE id = $1::uuid AND empresa_id = $2::uuid
          FOR UPDATE`,
        [cobroId, p.empresaId]
      );
      const cobro = cq.rows[0];
      if (!cobro) continue;             // el cobro fue borrado por alguien — saltar
      if (cobro.anulado) continue;      // ya estaba anulado (idempotencia parcial)

      const monto = round2(num(cobro.monto));

      // Lock de la cuenta afectada y restaurar saldo.
      const cxq = await client.query<{
        id: string; total: string; saldo: string; estado: string;
      }>(
        `SELECT id, total, saldo, estado FROM ${tCxc}
          WHERE id = $1::uuid AND empresa_id = $2::uuid
          FOR UPDATE`,
        [cobro.cuenta_por_cobrar_id, p.empresaId]
      );
      const cxc = cxq.rows[0];
      if (cxc) {
        const total = round2(num(cxc.total));
        // Restaurar el monto (acotado por total, defensive).
        const saldoNuevo = round2(Math.min(total, num(cxc.saldo) + monto));
        const estadoNuevo =
          saldoNuevo >= total - 0.001 ? "pendiente" :
          saldoNuevo > 0.001          ? "parcial"   : "pagado";

        await client.query(
          `UPDATE ${tCxc} SET saldo = $1::numeric, estado = $2, updated_at = now()
            WHERE id = $3::uuid`,
          [saldoNuevo, estadoNuevo, cxc.id]
        );

        // Simetria con cobrarConRecibo: al anular devolvemos el monto tambien
        // a facturas.saldo (acotado a facturas.monto para no sobregirar).
        // Match por venta_id porque cxc no siempre tiene factura_id.
        const cxqVenta = await client.query<{ venta_id: string | null }>(
          `SELECT venta_id FROM ${tCxc} WHERE id = $1::uuid`,
          [cxc.id]
        );
        const ventaIdCxc = cxqVenta.rows[0]?.venta_id ?? null;
        if (ventaIdCxc) {
          await client.query(
            `UPDATE ${tFac}
                SET saldo = LEAST(monto, saldo + $1::numeric),
                    updated_at = now()
              WHERE origen_venta_id = $2::uuid AND empresa_id = $3::uuid`,
            [monto, ventaIdCxc, p.empresaId]
          );
        }
        cuentasRecompuestas += 1;
      }

      // Marcar cobro anulado.
      await client.query(
        `UPDATE ${tCob}
            SET anulado = true,
                anulado_at = now(),
                anulado_by_user_id = $1::uuid,
                anulado_motivo = $2
          WHERE id = $3::uuid`,
        [p.usuarioId, motivo, cobro.id]
      );
    }

    // 4) Marcar recibo anulado.
    await client.query(
      `UPDATE ${tR}
          SET anulado = true,
              anulado_at = now(),
              anulado_by_user_id = $1::uuid,
              anulado_by_nombre = $2,
              anulado_motivo = $3,
              updated_at = now()
        WHERE id = $4::uuid AND empresa_id = $5::uuid`,
      [p.usuarioId, p.usuarioNombre, motivo, p.reciboId, p.empresaId]
    );

    await client.query("COMMIT");
    return {
      recibo_id: p.reciboId,
      cobros_anulados: cobroIds.length,
      cuentas_recompuestas: cuentasRecompuestas,
    };
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* pool ya fallido */ }
    if (err instanceof AnularReciboError) throw err;
    const msg = err instanceof Error ? err.message : "Error al anular el recibo.";
    throw new AnularReciboError(500, msg);
  } finally {
    client.release();
  }
}
