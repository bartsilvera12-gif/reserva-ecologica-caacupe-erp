/**
 * Reporte "Cierres de caja" (arqueo de turnos) por rango de fechas y sucursal.
 * SQL directo vía PG pool. Paridad con Ferretería República, adaptado a las
 * columnas de Reserva (abierta_at/cerrada_at, efectivo_esperado/contado, y la
 * atribución de ventas por `ventas.caja_id` con fallback por ventana de tiempo
 * para ventas sin etiquetar — igual que el módulo operativo de caja).
 */
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import type { ArqueoItem } from "@/lib/caja/denominaciones";

function pool() {
  const p = getChatPostgresPool();
  if (!p) throw new Error("Pool PG no disponible para el reporte de caja.");
  return p;
}
const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
function arqueoJson(v: unknown): ArqueoItem[] | null {
  if (Array.isArray(v)) return v as ArqueoItem[];
  if (typeof v === "string") { try { const j = JSON.parse(v); return Array.isArray(j) ? j : null; } catch { return null; } }
  return null;
}

export type CierreCajaRow = {
  id: string; numero_caja: number; estado: string;
  fecha_apertura: string; fecha_cierre: string | null;
  abierta_por_nombre: string | null; cerrada_por_nombre: string | null;
  monto_apertura: number;
  cantidad_ventas: number; total_vendido: number;
  total_efectivo: number; total_tarjeta: number; total_transferencia: number;
  ingresos_efectivo: number; egresos_efectivo: number; retiros_efectivo: number; ajustes_efectivo: number;
  efectivo_esperado: number;
  efectivo_contado: number | null;
  diferencia: number | null;
  observacion_cierre: string | null;
  arqueo_apertura_json: ArqueoItem[] | null;
  arqueo_cierre_json: ArqueoItem[] | null;
};

export type CierresCajaTotales = {
  cantidad_cajas: number; cajas_abiertas: number; cajas_cerradas: number;
  total_vendido: number; total_efectivo: number; total_tarjeta: number; total_transferencia: number;
  total_diferencia: number; faltantes: number; sobrantes: number; cajas_con_diferencia: number;
};

export type CierresCajaReporte = {
  desde: string; hasta: string;
  maneja_caja: boolean;
  totales: CierresCajaTotales;
  cajas: CierreCajaRow[];
};

function totalesVacios(): CierresCajaTotales {
  return {
    cantidad_cajas: 0, cajas_abiertas: 0, cajas_cerradas: 0,
    total_vendido: 0, total_efectivo: 0, total_tarjeta: 0, total_transferencia: 0,
    total_diferencia: 0, faltantes: 0, sobrantes: 0, cajas_con_diferencia: 0,
  };
}

/** Reporte de cierres de caja de la sucursal en el rango [start, end]. */
export async function getReporteCierresCaja(
  schemaRaw: string,
  empresaId: string,
  sucursalId: string,
  rango: { start: string; end: string; desde: string; hasta: string },
  manejaCaja: boolean
): Promise<CierresCajaReporte> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tC = quoteSchemaTable(schema, "cajas");
  const tV = quoteSchemaTable(schema, "ventas");
  const tM = quoteSchemaTable(schema, "caja_movimientos");
  const p = pool();

  const cajasQ = await p.query(
    `SELECT id::text AS id, numero_caja, estado, abierta_at, cerrada_at,
            abierta_por_nombre, cerrada_por_nombre, monto_apertura,
            efectivo_esperado, efectivo_contado, diferencia, observacion_cierre,
            arqueo_apertura_json, arqueo_cierre_json
       FROM ${tC}
      WHERE empresa_id=$1::uuid AND sucursal_id=$2::uuid
        AND abierta_at >= $3::timestamptz AND abierta_at <= $4::timestamptz
      ORDER BY abierta_at DESC`,
    [empresaId, sucursalId, rango.start, rango.end]
  );
  if (cajasQ.rows.length === 0) {
    return { desde: rango.desde, hasta: rango.hasta, maneja_caja: manejaCaja, totales: totalesVacios(), cajas: [] };
  }
  const cajaIds = cajasQ.rows.map((r) => String(r.id));

  // Ventas por caja: por caja_id, más fallback por ventana [apertura, cierre]
  // para ventas sin etiquetar (compat con turnos previos al vínculo caja_id).
  const vQ = await p.query(
    `SELECT c.id::text AS caja_id,
        COUNT(v.id) FILTER (WHERE v.estado='completada') AS cantidad,
        COALESCE(SUM(v.total) FILTER (WHERE v.estado='completada'),0) AS total_vendido,
        COALESCE(SUM(v.total) FILTER (WHERE v.estado='completada' AND v.metodo_pago='efectivo'),0) AS efectivo,
        COALESCE(SUM(v.total) FILTER (WHERE v.estado='completada' AND v.metodo_pago='tarjeta'),0) AS tarjeta,
        COALESCE(SUM(v.total) FILTER (WHERE v.estado='completada' AND v.metodo_pago='transferencia'),0) AS transferencia
      FROM ${tC} c
      LEFT JOIN ${tV} v
        ON v.empresa_id=c.empresa_id AND v.sucursal_id=c.sucursal_id
       AND ( v.caja_id=c.id
             OR ( v.caja_id IS NULL AND v.fecha >= c.abierta_at
                  AND v.fecha <= COALESCE(c.cerrada_at, now()) ) )
      WHERE c.id = ANY($1::uuid[])
      GROUP BY c.id`,
    [cajaIds]
  );
  const vAgg = new Map<string, { cantidad: number; total: number; efectivo: number; tarjeta: number; transferencia: number }>();
  for (const r of vQ.rows as Record<string, unknown>[]) {
    vAgg.set(String(r.caja_id), {
      cantidad: num(r.cantidad), total: num(r.total_vendido),
      efectivo: num(r.efectivo), tarjeta: num(r.tarjeta), transferencia: num(r.transferencia),
    });
  }

  const mQ = await p.query(
    `SELECT caja_id::text AS caja_id,
        COALESCE(SUM(monto) FILTER (WHERE tipo='ingreso' AND metodo_pago='efectivo'),0) AS ingresos,
        COALESCE(SUM(monto) FILTER (WHERE tipo='egreso'  AND metodo_pago='efectivo'),0) AS egresos,
        COALESCE(SUM(monto) FILTER (WHERE tipo='retiro'  AND metodo_pago='efectivo'),0) AS retiros,
        COALESCE(SUM(monto) FILTER (WHERE tipo='ajuste'  AND metodo_pago='efectivo'),0) AS ajustes
      FROM ${tM}
      WHERE caja_id = ANY($1::uuid[])
      GROUP BY caja_id`,
    [cajaIds]
  );
  const mAgg = new Map<string, { ingresos: number; egresos: number; retiros: number; ajustes: number }>();
  for (const r of mQ.rows as Record<string, unknown>[]) {
    mAgg.set(String(r.caja_id), { ingresos: num(r.ingresos), egresos: num(r.egresos), retiros: num(r.retiros), ajustes: num(r.ajustes) });
  }

  const cajas: CierreCajaRow[] = cajasQ.rows.map((c) => {
    const id = String(c.id);
    const estado = String(c.estado);
    const v = vAgg.get(id) ?? { cantidad: 0, total: 0, efectivo: 0, tarjeta: 0, transferencia: 0 };
    const m = mAgg.get(id) ?? { ingresos: 0, egresos: 0, retiros: 0, ajustes: 0 };
    const montoApertura = num(c.monto_apertura);
    const esperadoLive = montoApertura + v.efectivo + m.ingresos + m.ajustes - m.egresos - m.retiros;
    // Turnos cerrados: se muestra el esperado guardado al cierre (coherente con
    // el contado y la diferencia almacenados). Abiertos: esperado en vivo.
    const esperadoGuardado = c.efectivo_esperado == null ? null : num(c.efectivo_esperado);
    const esperado = estado === "cerrada" && esperadoGuardado != null ? esperadoGuardado : esperadoLive;
    return {
      id, numero_caja: num(c.numero_caja) || 1, estado,
      fecha_apertura: c.abierta_at ? new Date(c.abierta_at as string).toISOString() : "",
      fecha_cierre: c.cerrada_at ? new Date(c.cerrada_at as string).toISOString() : null,
      abierta_por_nombre: (c.abierta_por_nombre as string | null) ?? null,
      cerrada_por_nombre: (c.cerrada_por_nombre as string | null) ?? null,
      monto_apertura: montoApertura,
      cantidad_ventas: v.cantidad, total_vendido: v.total,
      total_efectivo: v.efectivo, total_tarjeta: v.tarjeta, total_transferencia: v.transferencia,
      ingresos_efectivo: m.ingresos, egresos_efectivo: m.egresos, retiros_efectivo: m.retiros, ajustes_efectivo: m.ajustes,
      efectivo_esperado: esperado,
      efectivo_contado: c.efectivo_contado == null ? null : num(c.efectivo_contado),
      diferencia: c.diferencia == null ? null : num(c.diferencia),
      observacion_cierre: (c.observacion_cierre as string | null) ?? null,
      arqueo_apertura_json: arqueoJson(c.arqueo_apertura_json),
      arqueo_cierre_json: arqueoJson(c.arqueo_cierre_json),
    };
  });

  const totales = totalesVacios();
  totales.cantidad_cajas = cajas.length;
  for (const f of cajas) {
    if (f.estado === "cerrada") totales.cajas_cerradas++;
    else totales.cajas_abiertas++;
    totales.total_vendido += f.total_vendido;
    totales.total_efectivo += f.total_efectivo;
    totales.total_tarjeta += f.total_tarjeta;
    totales.total_transferencia += f.total_transferencia;
    if (f.diferencia != null && f.diferencia !== 0) {
      totales.cajas_con_diferencia++;
      totales.total_diferencia += f.diferencia;
      if (f.diferencia < 0) totales.faltantes += -f.diferencia;
      else totales.sobrantes += f.diferencia;
    }
  }

  return { desde: rango.desde, hasta: rango.hasta, maneja_caja: manejaCaja, totales, cajas };
}
