/**
 * Datos para el R90 de VENTAS: comprobantes NO electrónicos del período.
 *
 * Un comprobante es "no electrónico" si la factura NO tiene ningún registro en
 * `factura_electronica` (nunca se emitió por SIFEN). Los DE SIFEN se excluyen a
 * propósito: la SET ya los obtiene automáticamente para el libro de Marangatú.
 */
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import type { R90ComprobanteVentaInput, R90ItemMonto } from "./r90-ventas";

export interface R90VentasRangoParams {
  /** ISO timestamptz inicio (inclusive). */ start: string;
  /** ISO timestamptz fin (inclusive). */ end: string;
}

interface FacturaRow {
  id: string;
  numero_factura: string | null;
  fecha: Date | string | null;
  tipo: string | null;
  moneda: string | null;
  cliente_ruc: string | null;
  cliente_razon_social: string | null;
  c_ruc: string | null;
  c_documento: string | null;
  c_nombre: string | null;
  c_es_contrib: boolean | null;
}

interface ItemRow {
  factura_id: string;
  subtotal: number | string | null;
  iva: number | string | null;
  total: number | string | null;
}

export async function getR90VentasNoElectronicas(
  schemaRaw: string,
  empresaId: string,
  params: R90VentasRangoParams
): Promise<R90ComprobanteVentaInput[]> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const p = getChatPostgresPool();
  if (!p) throw new Error("Pool no disponible.");

  const fT = quoteSchemaTable(schema, "facturas");
  const feT = quoteSchemaTable(schema, "factura_electronica");
  const cT = quoteSchemaTable(schema, "clientes");
  const fiT = quoteSchemaTable(schema, "factura_items");

  const { rows: facturas } = await p.query<FacturaRow>(
    `SELECT f.id, f.numero_factura, f.fecha, f.tipo, f.moneda,
            f.cliente_ruc, f.cliente_razon_social,
            c.ruc AS c_ruc, c.documento AS c_documento, c.nombre AS c_nombre,
            c.es_contribuyente AS c_es_contrib
       FROM ${fT} f
       LEFT JOIN ${cT} c ON c.id = f.cliente_id
      WHERE f.empresa_id = $1::uuid
        AND f.fecha >= $2::timestamptz AND f.fecha <= $3::timestamptz
        AND lower(coalesce(f.estado,'')) NOT IN ('anulada','anulado','cancelada','cancelado')
        AND NOT EXISTS (SELECT 1 FROM ${feT} fe WHERE fe.factura_id = f.id)
      ORDER BY f.fecha, f.numero_factura`,
    [empresaId, params.start, params.end]
  );
  if (!facturas.length) return [];

  const ids = facturas.map((r) => String(r.id));
  const { rows: items } = await p.query<ItemRow>(
    `SELECT factura_id, subtotal, iva, total FROM ${fiT} WHERE factura_id = ANY($1::uuid[])`,
    [ids]
  );
  const porFactura = new Map<string, R90ItemMonto[]>();
  for (const it of items) {
    const k = String(it.factura_id);
    const arr = porFactura.get(k) ?? [];
    arr.push({
      subtotal: Number(it.subtotal) || 0,
      iva: Number(it.iva) || 0,
      total: Number(it.total) || 0,
    });
    porFactura.set(k, arr);
  }

  return facturas.map((f) => ({
    numeroFactura: String(f.numero_factura ?? ""),
    fecha: f.fecha ?? "",
    tipo: f.tipo ?? null,
    moneda: f.moneda ?? "GS",
    cliente: {
      ruc: (f.cliente_ruc ?? f.c_ruc) || null,
      documento: f.c_documento || null,
      razon_social: (f.cliente_razon_social ?? f.c_nombre) || null,
      es_contribuyente: f.c_es_contrib ?? null,
    },
    items: porFactura.get(String(f.id)) ?? [],
  }));
}
