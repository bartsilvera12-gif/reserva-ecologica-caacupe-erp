import { NextRequest } from "next/server";
import { exigirSucursal } from "@/lib/sucursales/filtro";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { resolverRangoCajas } from "@/lib/caja/reporte-rango";
import { getReporteCierresCaja } from "@/lib/caja/reporte-caja-pg";
import { sucursalManejaCaja } from "@/lib/caja/server/caja-pg";
import { sheetFromRows, buildXlsxBufferSheets, xlsxResponseHeaders } from "@/lib/excel/export";

const ESTADO_LBL: Record<string, string> = { abierta: "Abierta", en_cierre: "En cierre", cerrada: "Cerrada" };

/** GET /api/reportes/cajas/export?desde=YYYY-MM-DD&hasta=YYYY-MM-DD → XLSX (Resumen + Cierres). */
export async function GET(request: NextRequest) {
  const ctx = await getTenantSupabaseFromAuth(request);
  if (!ctx) return new Response("Unauthorized", { status: 401 });
  const sucursalId = ctx.auth.sucursal_id ?? null;
  if (!sucursalId) return new Response("Sucursal no asignada", { status: 409 });
  try {
    const schema = await fetchDataSchemaForEmpresaId(ctx.auth.empresa_id);
    const sp = new URL(request.url).searchParams;
    const rango = resolverRangoCajas(sp.get("desde"), sp.get("hasta"));
    const manejaCaja = await sucursalManejaCaja(schema, ctx.auth.empresa_id, sucursalId);
    const r = await getReporteCierresCaja(schema, ctx.auth.empresa_id, exigirSucursal(sucursalId), rango, manejaCaja);
    const t = r.totales;

    const resumen = [
      { c: "Reporte", v: "Cierres de caja" },
      { c: "Desde", v: r.desde },
      { c: "Hasta", v: r.hasta },
      { c: "Cantidad de cajas", v: t.cantidad_cajas },
      { c: "Cerradas", v: t.cajas_cerradas },
      { c: "Abiertas", v: t.cajas_abiertas },
      { c: "Total vendido", v: t.total_vendido },
      { c: "Total efectivo", v: t.total_efectivo },
      { c: "Total tarjeta", v: t.total_tarjeta },
      { c: "Total transferencia", v: t.total_transferencia },
      { c: "Cajas con diferencia", v: t.cajas_con_diferencia },
      { c: "Faltantes (acumulado)", v: t.faltantes },
      { c: "Sobrantes (acumulado)", v: t.sobrantes },
      { c: "Diferencia neta", v: t.total_diferencia },
    ];

    const buf = buildXlsxBufferSheets([
      sheetFromRows("Resumen", resumen, [
        { header: "Concepto", value: (x) => x.c, width: 28 },
        { header: "Valor", value: (x) => x.v, width: 22 },
      ]),
      sheetFromRows("Cierres", r.cajas, [
        { header: "Caja", value: (x) => `Caja ${x.numero_caja}`, width: 10 },
        { header: "Apertura", value: (x) => (x.fecha_apertura ? new Date(x.fecha_apertura) : ""), width: 20 },
        { header: "Cierre", value: (x) => (x.fecha_cierre ? new Date(x.fecha_cierre) : ""), width: 20 },
        { header: "Estado", value: (x) => ESTADO_LBL[x.estado] ?? x.estado, width: 12 },
        { header: "Abrió", value: (x) => x.abierta_por_nombre ?? "", width: 22 },
        { header: "Cerró", value: (x) => x.cerrada_por_nombre ?? "", width: 22 },
        { header: "Monto apertura", value: (x) => x.monto_apertura, width: 16 },
        { header: "Ventas", value: (x) => x.cantidad_ventas, width: 10 },
        { header: "Total vendido", value: (x) => x.total_vendido, width: 16 },
        { header: "Efectivo", value: (x) => x.total_efectivo, width: 14 },
        { header: "Tarjeta", value: (x) => x.total_tarjeta, width: 14 },
        { header: "Transferencia", value: (x) => x.total_transferencia, width: 14 },
        { header: "Ingresos ef.", value: (x) => x.ingresos_efectivo, width: 14 },
        { header: "Egresos ef.", value: (x) => x.egresos_efectivo, width: 14 },
        { header: "Retiros ef.", value: (x) => x.retiros_efectivo, width: 14 },
        { header: "Efectivo esperado", value: (x) => x.efectivo_esperado, width: 16 },
        { header: "Contado al cierre", value: (x) => (x.efectivo_contado == null ? "" : x.efectivo_contado), width: 16 },
        { header: "Diferencia", value: (x) => (x.diferencia == null ? "" : x.diferencia), width: 14 },
        { header: "Observación cierre", value: (x) => x.observacion_cierre ?? "", width: 36 },
      ]),
    ]);
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: xlsxResponseHeaders(`cierres-caja-${r.desde}_${r.hasta}`),
    });
  } catch (err) {
    console.error("[/api/reportes/cajas/export]", err instanceof Error ? err.message : err);
    return new Response("No se pudo generar el Excel", { status: 500 });
  }
}
