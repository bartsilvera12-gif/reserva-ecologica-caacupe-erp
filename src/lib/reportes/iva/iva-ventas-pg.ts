/**
 * Datos del Libro de Ventas IVA del período:
 *   - TODAS las facturas no anuladas (filas positivas).
 *   - Las notas de crédito APROBADAS del período (filas negativas): reducen las
 *     ventas gravadas y el IVA débito. Desglose desde nota_credito_items, o de la
 *     factura de origen si la NC no tiene ítems propios (NC total).
 * Las facturas anuladas y las NC no aprobadas (borrador/rechazada/cancelada) se
 * excluyen para que los acumulados reflejen los valores fiscales correctos.
 */
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import {
  mapFacturaToIvaRow,
  mapNcToIvaRow,
  type IvaVentaRow,
  type IvaItemInput,
} from "./iva-ventas";

export interface IvaVentasParams {
  /** ISO timestamptz inicio (inclusive). */ start: string;
  /** ISO timestamptz fin (inclusive). */ end: string;
  /** Timbrado a mostrar en cada fila (de la config SIFEN/autoimpresor). */ timbrado: string;
}

interface FacturaRow {
  id: string;
  numero_factura: string | null;
  fecha: Date | string | null;
  cliente_ruc: string | null;
  cliente_razon_social: string | null;
}
interface FacturaItemRow {
  factura_id: string;
  tipo_iva: string | null;
  subtotal: number | string | null;
  iva: number | string | null;
  total: number | string | null;
}
interface NcRow {
  id: string;
  numero: number | string | null;
  fecha: Date | string | null;
  factura_id: string | null;
  cliente_ruc: string | null;
  cliente_razon_social: string | null;
}
interface NcItemRow {
  nota_credito_id: string;
  tipo_iva: string | null;
  subtotal: number | string | null;
  monto_iva: number | string | null;
  total_linea: number | string | null;
}

/** Filas del libro IVA (facturas + NC), ordenadas por fecha. */
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
  const ncT = quoteSchemaTable(schema, "nota_credito");
  const nciT = quoteSchemaTable(schema, "nota_credito_items");

  // 1) Facturas no anuladas del período.
  const { rows: facturas } = await p.query<FacturaRow>(
    `SELECT f.id, f.numero_factura, f.fecha, f.cliente_ruc, f.cliente_razon_social
       FROM ${fT} f
      WHERE f.empresa_id = $1::uuid AND f.estado <> 'Anulado'
        AND f.fecha >= $2::timestamptz AND f.fecha <= $3::timestamptz`,
    [empresaId, params.start, params.end]
  );

  // 2) Notas de crédito APROBADAS del período (con datos del receptor desde la
  //    factura de origen).
  const { rows: ncs } = await p.query<NcRow>(
    `SELECT nc.id, nc.numero, nc.created_at AS fecha, nc.factura_id,
            f.cliente_ruc, f.cliente_razon_social
       FROM ${ncT} nc
       LEFT JOIN ${fT} f ON f.id = nc.factura_id
      WHERE nc.empresa_id = $1::uuid AND nc.estado_erp = 'aprobada'
        AND nc.created_at >= $2::timestamptz AND nc.created_at <= $3::timestamptz`,
    [empresaId, params.start, params.end]
  );

  // 3) Ítems: de facturas del período + de las facturas de origen de NC sin ítems
  //    propios (se resuelve abajo). Traemos todos los ítems necesarios.
  const facturaIds = new Set<string>(facturas.map((f) => f.id));
  for (const nc of ncs) if (nc.factura_id) facturaIds.add(nc.factura_id);
  const facturaItemsPorFactura = new Map<string, IvaItemInput[]>();
  if (facturaIds.size > 0) {
    const { rows: fitems } = await p.query<FacturaItemRow>(
      `SELECT factura_id, tipo_iva, subtotal, iva, total
         FROM ${fiT} WHERE empresa_id = $1::uuid AND factura_id = ANY($2::uuid[])`,
      [empresaId, Array.from(facturaIds)]
    );
    for (const it of fitems) {
      const arr = facturaItemsPorFactura.get(it.factura_id) ?? [];
      arr.push({ tipo_iva: it.tipo_iva ?? null, subtotal: Number(it.subtotal) || 0, iva: Number(it.iva) || 0, total: Number(it.total) || 0 });
      facturaItemsPorFactura.set(it.factura_id, arr);
    }
  }

  // 4) Ítems propios de las NC.
  const ncItemsPorNc = new Map<string, IvaItemInput[]>();
  if (ncs.length > 0) {
    const { rows: ncItems } = await p.query<NcItemRow>(
      `SELECT nota_credito_id, tipo_iva, subtotal, monto_iva, total_linea
         FROM ${nciT} WHERE empresa_id = $1::uuid AND nota_credito_id = ANY($2::uuid[])`,
      [empresaId, ncs.map((n) => n.id)]
    );
    for (const it of ncItems) {
      const arr = ncItemsPorNc.get(it.nota_credito_id) ?? [];
      arr.push({ tipo_iva: it.tipo_iva ?? null, subtotal: Number(it.subtotal) || 0, iva: Number(it.monto_iva) || 0, total: Number(it.total_linea) || 0 });
      ncItemsPorNc.set(it.nota_credito_id, arr);
    }
  }

  const filasFactura: IvaVentaRow[] = facturas.map((f) =>
    mapFacturaToIvaRow(
      { fecha: f.fecha, numero_factura: f.numero_factura, cliente_ruc: f.cliente_ruc, cliente_razon_social: f.cliente_razon_social, items: facturaItemsPorFactura.get(f.id) ?? [] },
      params.timbrado
    )
  );

  const filasNc: IvaVentaRow[] = ncs.map((nc) => {
    // Ítems propios de la NC; si no tiene, los de la factura de origen (NC total).
    const propios = ncItemsPorNc.get(nc.id);
    const items = propios && propios.length > 0 ? propios : (nc.factura_id ? facturaItemsPorFactura.get(nc.factura_id) ?? [] : []);
    return mapNcToIvaRow(
      { fecha: nc.fecha, numero: nc.numero, cliente_ruc: nc.cliente_ruc, cliente_razon_social: nc.cliente_razon_social, items },
      params.timbrado
    );
  });

  // Orden cronológico (fecha asc); las NC del mismo día quedan tras la factura.
  return [...filasFactura, ...filasNc].sort((a, b) => {
    const fa = a.fecha ?? "", fb = b.fecha ?? "";
    if (fa !== fb) return fa < fb ? -1 : 1;
    // misma fecha: facturas antes que NC
    if (a.tipo !== b.tipo) return a.tipo === "Factura" ? -1 : 1;
    return a.numero_factura.localeCompare(b.numero_factura);
  });
}
