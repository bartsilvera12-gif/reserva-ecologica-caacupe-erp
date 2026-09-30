import { NextRequest } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { asuncionMesBoundsUtc, normalizarMes } from "@/lib/fechas/asuncion-bounds";
import { getIvaVentas } from "@/lib/reportes/iva/iva-ventas-pg";
import { totalesIva, type IvaVentaRow } from "@/lib/reportes/iva/iva-ventas";
import { sheetFromRows, buildXlsxBufferSheets, xlsxResponseHeaders } from "@/lib/excel/export";

/**
 * GET /api/reportes/iva/ventas/export?mes=YYYY-MM
 *
 * Libro de Ventas para la liquidación mensual de IVA (.xlsx). Incluye TODAS las
 * facturas no anuladas del período (electrónicas y no electrónicas), con el
 * desglose Gravado 10% / IVA 10% / Gravado 5% / IVA 5% / Exentas / Total.
 * Empresa completa (todas las sucursales), como el R90.
 */
export async function GET(request: NextRequest) {
  const ctx = await getTenantSupabaseFromAuth(request);
  if (!ctx) return new Response("Unauthorized", { status: 401 });
  try {
    const empresaId = ctx.auth.empresa_id;
    const schema = await fetchDataSchemaForEmpresaId(empresaId);
    const mes = normalizarMes(new URL(request.url).searchParams.get("mes"));
    const { start, end } = asuncionMesBoundsUtc(mes);

    // Timbrado del emisor (config SIFEN). Informativo en cada fila.
    let timbrado = "";
    try {
      const cfg = await ctx.supabase
        .from("empresa_sifen_config")
        .select("timbrado_numero")
        .eq("empresa_id", empresaId)
        .maybeSingle();
      timbrado = String((cfg.data as { timbrado_numero?: string } | null)?.timbrado_numero ?? "").trim();
    } catch { /* sin timbrado */ }

    const rows = await getIvaVentas(schema, empresaId, { start, end, timbrado });

    // Fila de totales al final.
    const t = totalesIva(rows);
    const totalesRow: IvaVentaRow = {
      fecha: null, tipo: "", numero_factura: "", timbrado: "", ruc: "", razon_social: "TOTALES",
      gravado_10: t.gravado_10, iva_10: t.iva_10, gravado_5: t.gravado_5, iva_5: t.iva_5,
      exentas: t.exentas, total: t.total,
    };

    const buf = buildXlsxBufferSheets([
      sheetFromRows<IvaVentaRow>("Libro IVA Ventas", [...rows, totalesRow], [
        { header: "Fecha", value: (r) => (r.fecha ? new Date(`${r.fecha}T00:00:00`) : ""), width: 12 },
        { header: "Tipo", value: (r) => r.tipo, width: 10 },
        { header: "N° Factura", value: (r) => r.numero_factura, width: 16 },
        { header: "Timbrado", value: (r) => r.timbrado, width: 14 },
        { header: "RUC/CI", value: (r) => r.ruc, width: 14 },
        { header: "Razón social", value: (r) => r.razon_social, width: 34 },
        { header: "Gravado 10%", value: (r) => r.gravado_10, width: 14 },
        { header: "IVA 10%", value: (r) => r.iva_10, width: 12 },
        { header: "Gravado 5%", value: (r) => r.gravado_5, width: 14 },
        { header: "IVA 5%", value: (r) => r.iva_5, width: 12 },
        { header: "Exentas", value: (r) => r.exentas, width: 14 },
        { header: "Total", value: (r) => r.total, width: 14 },
      ]),
    ]);

    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: xlsxResponseHeaders(`Libro_IVA_Ventas_${mes}`),
    });
  } catch (err) {
    console.error("[/api/reportes/iva/ventas/export]", err instanceof Error ? err.message : err);
    return new Response("No se pudo generar el Libro de Ventas IVA.", { status: 500 });
  }
}
