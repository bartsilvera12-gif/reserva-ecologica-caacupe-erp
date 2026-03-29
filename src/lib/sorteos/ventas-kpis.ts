"use server";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { asuncionDayBoundsUtc, asuncionMonthBoundsUtc } from "@/lib/sorteos/kpis-time-bounds";

/**
 * KPIs de ventas de sorteos (página principal).
 *
 * Tabla: public.sorteo_entradas (cada fila = una orden / compra de boletos).
 * Criterio de fecha: created_at (momento en que se registró la orden en el ERP).
 * Boletos: suma de cantidad_boletos (excluye filas con estado_pago = 'rechazado').
 * Monto: suma de monto_total en la misma moneda de la fila (PYG), mismo filtro de estado.
 * Ventana calendario: día y mes en zona America/Asuncion (Paraguay).
 */
export type SorteosVentasKpis = {
  boletosHoy: number;
  boletosMes: number;
  montoHoy: number;
  montoMes: number;
};

function sumRows(
  rows: Array<{ cantidad_boletos?: number | null; monto_total?: number | string | null; estado_pago?: string | null }>
): { boletos: number; monto: number } {
  let boletos = 0;
  let monto = 0;
  for (const r of rows) {
    if ((r.estado_pago ?? "").trim() === "rechazado") continue;
    boletos += Number(r.cantidad_boletos) || 0;
    monto += Number(r.monto_total) || 0;
  }
  return { boletos, monto };
}

export async function getSorteosVentasKpis(): Promise<SorteosVentasKpis> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) {
    return { boletosHoy: 0, boletosMes: 0, montoHoy: 0, montoMes: 0 };
  }

  const { data: usuario, error: uErr } = await supabase
    .from("usuarios")
    .select("empresa_id")
    .eq("email", user.email)
    .single();

  if (uErr || !usuario?.empresa_id) {
    return { boletosHoy: 0, boletosMes: 0, montoHoy: 0, montoMes: 0 };
  }

  const empresaId = usuario.empresa_id as string;
  const day = asuncionDayBoundsUtc();
  const month = asuncionMonthBoundsUtc();

  const [dayRes, monthRes] = await Promise.all([
    supabase
      .from("sorteo_entradas")
      .select("cantidad_boletos, monto_total, estado_pago")
      .eq("empresa_id", empresaId)
      .gte("created_at", day.start)
      .lte("created_at", day.end),
    supabase
      .from("sorteo_entradas")
      .select("cantidad_boletos, monto_total, estado_pago")
      .eq("empresa_id", empresaId)
      .gte("created_at", month.start)
      .lte("created_at", month.end),
  ]);

  if (dayRes.error) throw new Error(dayRes.error.message);
  if (monthRes.error) throw new Error(monthRes.error.message);

  const sD = sumRows(dayRes.data ?? []);
  const sM = sumRows(monthRes.data ?? []);

  return {
    boletosHoy: sD.boletos,
    montoHoy: sD.monto,
    boletosMes: sM.boletos,
    montoMes: sM.monto,
  };
}
