import { NextRequest } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { asuncionMesBoundsUtc, normalizarMes } from "@/lib/fechas/asuncion-bounds";
import { getAutoimpresor } from "@/lib/facturacion/server/facturacion-modo-pg";
import { getR90VentasNoElectronicas } from "@/lib/reportes/r90/r90-ventas-pg";
import {
  buildR90VentasCsv,
  mapVentaComprobanteToR90Row,
  validateR90Row,
  r90NombreArchivo,
  type R90Imputacion,
  type SN,
} from "@/lib/reportes/r90/r90-ventas";

function sn(v: string | null, def: SN): SN {
  const s = (v ?? "").trim().toUpperCase();
  return s === "S" ? "S" : s === "N" ? "N" : def;
}

/**
 * GET /api/reportes/r90/ventas/export?mes=YYYY-MM&imputaIva=S&imputaIre=S&imputaIrp=N
 *
 * Genera el archivo R90 (Registro de Comprobantes de Ventas, RG 90) SOLO con
 * comprobantes NO electrónicos válidos del período. CSV coma, UTF-8, sin
 * encabezado, orden oficial DNIT. Los DE SIFEN se excluyen (SET los toma solo).
 *
 * Campos 15-17 (imputa IVA/IRE/IRP-RSP) se reciben por querystring (configurables
 * en la pantalla). Si la empresa no tiene autoimpresor configurado (100% SIFEN),
 * el archivo sale vacío — correcto.
 */
export async function GET(request: NextRequest) {
  const ctx = await getTenantSupabaseFromAuth(request);
  if (!ctx) return new Response("Unauthorized", { status: 401 });
  try {
    const schema = await fetchDataSchemaForEmpresaId(ctx.auth.empresa_id);
    const url = new URL(request.url);
    const mes = normalizarMes(url.searchParams.get("mes"));
    const { start, end } = asuncionMesBoundsUtc(mes);

    const imputacion: R90Imputacion = {
      imputaIva: sn(url.searchParams.get("imputaIva"), "S"),
      imputaIre: sn(url.searchParams.get("imputaIre"), "S"),
      imputaIrpRsp: sn(url.searchParams.get("imputaIrp"), "N"),
    };

    const autoimpresor = await getAutoimpresor(schema, ctx.auth.empresa_id);
    const comprobantes = await getR90VentasNoElectronicas(schema, ctx.auth.empresa_id, { start, end });

    // "Solo NO electrónicos VÁLIDOS": un comprobante no electrónico es reportable
    // sólo si la empresa tiene un timbrado de autoimpresor válido para asignarle
    // timbrado + número fiscal. Sin autoimpresor (caso 100% SIFEN) → 0 filas.
    const emisorOk = Boolean(
      autoimpresor.activo &&
        autoimpresor.timbrado_numero &&
        autoimpresor.establecimiento_codigo &&
        autoimpresor.punto_expedicion_codigo
    );
    const emisor = {
      timbrado: autoimpresor.timbrado_numero ?? "",
      establecimiento: autoimpresor.establecimiento_codigo ?? "",
      punto: autoimpresor.punto_expedicion_codigo ?? "",
    };

    const rows = emisorOk
      ? comprobantes
          .map((c) => mapVentaComprobanteToR90Row(c, emisor, imputacion))
          .filter((r) => validateR90Row(r).length === 0)
      : [];

    const csv = buildR90VentasCsv(rows);
    const rucEmisor = autoimpresor.ruc_emisor ?? "";
    const filename = `${r90NombreArchivo(rucEmisor, mes)}.csv`;

    // UTF-8 sin BOM (el importador de Marangatú parsea por coma; un BOM rompería
    // el primer campo). Content-Disposition fuerza la descarga.
    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
        "X-R90-Filas": String(rows.length),
        "X-R90-Autoimpresor": emisorOk ? "1" : "0",
      },
    });
  } catch (err) {
    console.error("[/api/reportes/r90/ventas/export]", err instanceof Error ? err.message : err);
    return new Response("No se pudo generar el archivo R90", { status: 500 });
  }
}
