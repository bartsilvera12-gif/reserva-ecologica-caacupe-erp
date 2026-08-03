/**
 * Proyección de inventario (read-only) por sucursal.
 *
 * Ventana: 30 días MÓVILES hasta hoy (America/Asuncion). Decisión documentada:
 * se usa la ventana móvil (hoy - 30 días) por ser la más representativa del
 * consumo reciente. Solo ventas 'completada' (excluye anuladas). Las unidades
 * son ventas brutas del período: no se descuentan devoluciones porque no hay un
 * vínculo confiable NC-de-venta ↔ producto/cantidad en este esquema.
 *
 * Una sola query agregada (sin N+1). Filtra estrictamente por empresa+sucursal;
 * no mezcla los productos clonados de la otra sucursal.
 */
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";

function pool() {
  const p = getChatPostgresPool();
  if (!p) throw new Error("Pool PG no disponible para proyección de inventario.");
  return p;
}

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

export type EstadoProyeccion =
  | "sin_stock"
  | "inconsistente"
  | "sin_consumo"
  | "critico"
  | "alto"
  | "medio"
  | "estable";

export type FilaProyeccion = {
  producto_id: string;
  nombre: string;
  sku: string;
  stock_actual: number;
  stock_minimo: number;
  unidades_30: number;
  promedio_diario: number;
  dias_cobertura: number | null;
  fecha_quiebre: string | null; // YYYY-MM-DD
  estado: EstadoProyeccion;
  critico_minimo: boolean; // stock_actual <= stock_minimo
};

function clasificar(stock: number, promedio: number): { estado: EstadoProyeccion; cobertura: number | null } {
  if (stock < 0) return { estado: "inconsistente", cobertura: null };
  if (stock === 0) return { estado: "sin_stock", cobertura: 0 };
  if (promedio <= 0) return { estado: "sin_consumo", cobertura: null };
  const cobertura = stock / promedio;
  let estado: EstadoProyeccion;
  if (cobertura <= 3) estado = "critico";
  else if (cobertura <= 7) estado = "alto";
  else if (cobertura <= 15) estado = "medio";
  else estado = "estable";
  return { estado, cobertura };
}

/**
 * @param hoyISO fecha "hoy" en America/Asuncion (YYYY-MM-DD), calculada por el caller.
 */
export async function getProyeccionInventario(
  schemaRaw: string,
  empresaId: string,
  sucursalId: string,
  hoyISO: string
): Promise<FilaProyeccion[]> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tP = quoteSchemaTable(schema, "productos");
  const tV = quoteSchemaTable(schema, "ventas");
  const tVI = quoteSchemaTable(schema, "ventas_items");

  const { rows } = await pool().query<{
    producto_id: string;
    nombre: string;
    sku: string | null;
    stock_actual: string;
    stock_minimo: string;
    unidades_30: string;
  }>(
    `WITH ventas30 AS (
       SELECT vi.producto_id, SUM(vi.cantidad)::numeric AS unidades
         FROM ${tVI} vi
         JOIN ${tV} v ON v.id = vi.venta_id
        WHERE v.empresa_id = $1::uuid AND v.sucursal_id = $2::uuid
          AND v.estado = 'completada'
          AND (v.fecha AT TIME ZONE 'America/Asuncion')::date
              > ($3::date - INTERVAL '30 days')
        GROUP BY vi.producto_id
     )
     SELECT p.id AS producto_id, p.nombre, p.sku,
            p.stock_actual, p.stock_minimo,
            COALESCE(v.unidades, 0) AS unidades_30
       FROM ${tP} p
       LEFT JOIN ventas30 v ON v.producto_id = p.id
      WHERE p.empresa_id = $1::uuid AND p.sucursal_id = $2::uuid
        AND p.activo = true AND p.controla_stock = true`,
    [empresaId, sucursalId, hoyISO]
  );

  const hoy = new Date(hoyISO + "T00:00:00");
  return rows.map((r) => {
    const stock = num(r.stock_actual);
    const minimo = num(r.stock_minimo);
    const unidades = num(r.unidades_30);
    const promedio = unidades / 30;
    const { estado, cobertura } = clasificar(stock, promedio);

    let fechaQuiebre: string | null = null;
    if (cobertura != null && cobertura > 0 && Number.isFinite(cobertura)) {
      const d = new Date(hoy);
      d.setDate(d.getDate() + Math.ceil(cobertura));
      fechaQuiebre = d.toISOString().slice(0, 10);
    } else if (estado === "sin_stock") {
      fechaQuiebre = hoyISO;
    }

    return {
      producto_id: r.producto_id,
      nombre: r.nombre,
      sku: r.sku ?? "",
      stock_actual: stock,
      stock_minimo: minimo,
      unidades_30: unidades,
      promedio_diario: Math.round(promedio * 100) / 100,
      dias_cobertura: cobertura == null ? null : Math.round(cobertura * 10) / 10,
      fecha_quiebre: fechaQuiebre,
      estado,
      critico_minimo: minimo > 0 && stock <= minimo,
    };
  });
}
