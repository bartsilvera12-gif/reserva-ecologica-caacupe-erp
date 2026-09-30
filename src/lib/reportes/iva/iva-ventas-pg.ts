/**
 * Datos del Libro de Ventas IVA del período: TODAS las facturas no anuladas,
 * con sus ítems para el desglose por tasa.
 */
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import {
  mapFacturaToIvaRow,
  type IvaVentaRow,
  type IvaItemInput,
} from "./iva-ventas";

export interface IvaVentasParams {
  /** ISO timestamptz inicio (inclusive). */ start: string;
  /** ISO timestamptz fin (inclusive). */ end: string;
  /** Sucursal (opcional): si se pasa, filtra por ella. */ sucursalId?: string | null;
  /** Timbrado a mostrar en cada fila (de la config SIFEN/autoimpresor). */ timbrado: string;
}

interface FacturaRow {
  id: string;
  numero_factura: string | null;
  fecha: Date | string | null;
  cliente_ruc: string | null;
  cliente_razon_social: string | null;
}
interface ItemRow {
  factura_id: string;
  tipo_iva: string | null;
  subtotal: number | string | null;
  iva: number | string | null;
  total: number | string | null;
}

/** Filas del libro IVA (una por factura), ordenadas por fecha asc y número. */
export async function getIvaVentas(
  schemaRaw: string,
  empresaId: string,
  params: IvaVentasParams
): Promise<IvaVentaRow[]> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const p = getChatPostgresPool();
  if (!p) throw new Error("Pool no disponible.");
  const fT = quoteSchemaTable(schema, "facturas");
  const fiT = quoteSchemaTable(schema, "factura_items");

  const sucFilter = params.sucursalId ? "AND f.sucursal_id = $4::uuid" : "";
  const args: unknown[] = [empresaId, params.start, params.end];
  if (params.sucursalId) args.push(params.sucursalId);

  const { rows: facturas } = await p.query<FacturaRow>(
    `SELECT f.id, f.numero_factura, f.fecha, f.cliente_ruc, f.cliente_razon_social
       FROM ${fT} f
      WHERE f.empresa_id = $1::uuid
        AND f.estado <> 'Anulado'
        AND f.fecha >= $2::timestamptz AND f.fecha <= $3::timestamptz
        ${sucFilter}
      ORDER BY f.fecha ASC, f.numero_factura ASC`,
    args
  );
  if (facturas.length === 0) return [];

  const ids = facturas.map((f) => f.id);
  const { rows: items } = await p.query<ItemRow>(
    `SELECT factura_id, tipo_iva, subtotal, iva, total
       FROM ${fiT}
      WHERE empresa_id = $1::uuid AND factura_id = ANY($2::uuid[])`,
    [empresaId, ids]
  );
  const itemsPorFactura = new Map<string, IvaItemInput[]>();
  for (const it of items) {
    const arr = itemsPorFactura.get(it.factura_id) ?? [];
    arr.push({
      tipo_iva: it.tipo_iva ?? null,
      subtotal: Number(it.subtotal) || 0,
      iva: Number(it.iva) || 0,
      total: Number(it.total) || 0,
    });
    itemsPorFactura.set(it.factura_id, arr);
  }

  return facturas.map((f) =>
    mapFacturaToIvaRow(
      {
        fecha: f.fecha,
        numero_factura: f.numero_factura,
        cliente_ruc: f.cliente_ruc,
        cliente_razon_social: f.cliente_razon_social,
        items: itemsPorFactura.get(f.id) ?? [],
      },
      params.timbrado
    )
  );
}
