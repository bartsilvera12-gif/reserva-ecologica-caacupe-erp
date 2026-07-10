import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { downloadSifenObject } from "@/lib/sifen/sifen-storage";
import { buildKudePdfBuffer, type KudeBranding } from "@/lib/sifen/kude-pdf";
import {
  kudeFallbackQrUrl,
  parseKudeFromSignedRdeXml,
} from "@/lib/sifen/parse-kude-from-signed-xml";
import type { SifenConsultaLoteUltimaPersistida } from "@/lib/sifen/types";
import type { AppSupabaseClient } from "@/lib/supabase/schema";

function filasDetalleConsulta(
  consulta: SifenConsultaLoteUltimaPersistida | Record<string, unknown> | null | undefined
): { cdc: string; dProtAut: string | null }[] {
  if (!consulta || typeof consulta !== "object") return [];
  const o = consulta as Record<string, unknown>;
  const raw = o.detallePorCdc ?? o.detalle_por_cdc;
  if (!Array.isArray(raw)) return [];
  return raw as { cdc: string; dProtAut: string | null }[];
}

function dProtAutDesdeConsulta(
  cdc: string,
  consulta: SifenConsultaLoteUltimaPersistida | Record<string, unknown> | null | undefined
): string | null {
  const rows = filasDetalleConsulta(consulta);
  if (rows.length === 0) return null;
  const hit = rows.find((d) => d.cdc === cdc);
  const v = hit?.dProtAut;
  return v != null && String(v).trim() !== "" ? String(v).trim() : null;
}

function nombreArchivoKudeNc(refErp: string, cdc: string): string {
  const safe = refErp.replace(/[^\w.-]+/g, "_").slice(0, 40);
  const tail = cdc.slice(-8);
  return `KuDE-NC-${safe || "nota-credito"}-${tail}.pdf`;
}

/**
 * Branding KuDE/PDF por empresa — mismo helper que el endpoint de facturas.
 * Solo afecta apariencia visual, no XML/firma/SET/CDC.
 */
async function loadKudeBranding(
  supabase: AppSupabaseClient,
  empresaId: string
): Promise<KudeBranding | null> {
  const { data, error } = await supabase
    .from("empresa_sifen_config")
    .select("kude_logo_path, kude_color_primario, kude_color_primario_fill")
    .eq("empresa_id", empresaId)
    .maybeSingle();

  if (error || !data) return null;

  const row = data as {
    kude_logo_path: string | null;
    kude_color_primario: string | null;
    kude_color_primario_fill: string | null;
  };

  const colorPrimario =
    row.kude_color_primario == null || String(row.kude_color_primario).trim() === ""
      ? null
      : String(row.kude_color_primario).trim();
  const colorPrimarioFill =
    row.kude_color_primario_fill == null ||
    String(row.kude_color_primario_fill).trim() === ""
      ? null
      : String(row.kude_color_primario_fill).trim();

  let logoBytes: Uint8Array | null = null;
  const logoPath =
    row.kude_logo_path == null || String(row.kude_logo_path).trim() === ""
      ? null
      : String(row.kude_logo_path).trim();
  if (logoPath) {
    const dl = await downloadSifenObject(supabase, logoPath);
    if (dl.ok) {
      logoBytes = new Uint8Array(dl.data);
    } else {
      console.warn("[kude-nc] logo download failed, falling back to default", {
        empresa_id: empresaId,
        path: logoPath,
        message: dl.message,
      });
    }
  }

  if (!logoBytes && !colorPrimario && !colorPrimarioFill) return null;
  return { logoBytes, colorPrimario, colorPrimarioFill };
}

/**
 * GET /api/notas-credito/[id]/sifen/kude
 * PDF KuDE de la nota de credito a partir del XML firmado. Solo si
 * `nota_credito_electronica.estado_sifen` = aprobado.
 * Query: `download=1` -> Content-Disposition attachment.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const { auth, supabase } = ctx;

    const { id: ncId } = await params;
    if (!ncId?.trim()) {
      return NextResponse.json(errorResponse("id de nota de crédito es obligatorio"), { status: 400 });
    }

    const download = request.nextUrl.searchParams.get("download") === "1";
    const nid = ncId.trim();

    const { data: nc, error: errNc } = await supabase
      .from("nota_credito")
      .select("id, factura_id")
      .eq("id", nid)
      .eq("empresa_id", auth.empresa_id)
      .maybeSingle();

    if (errNc) {
      return NextResponse.json(errorResponse(errNc.message), { status: 400 });
    }
    if (!nc) {
      return NextResponse.json(errorResponse("Nota de crédito no encontrada."), { status: 404 });
    }

    const { data: neRow, error: errNe } = await supabase
      .from("nota_credito_electronica")
      .select("estado_sifen, xml_firmado_path, cdc, sifen_ultima_respuesta_consulta_lote")
      .eq("nota_credito_id", nid)
      .eq("empresa_id", auth.empresa_id)
      .maybeSingle();

    if (errNe) {
      return NextResponse.json(errorResponse(errNe.message), { status: 400 });
    }
    if (!neRow) {
      return NextResponse.json(
        errorResponse("No hay documento electrónico para esta nota de crédito."),
        { status: 404 }
      );
    }

    if (String(neRow.estado_sifen) !== "aprobado") {
      return NextResponse.json(
        errorResponse("El KuDE solo está disponible con SIFEN en estado «aprobado»."),
        { status: 403 }
      );
    }

    const xmlPath =
      neRow.xml_firmado_path == null ? "" : String(neRow.xml_firmado_path).trim();
    if (!xmlPath) {
      return NextResponse.json(errorResponse("No hay XML firmado en storage."), { status: 400 });
    }

    const dl = await downloadSifenObject(supabase, xmlPath);
    if (!dl.ok) {
      return NextResponse.json(
        errorResponse(`No se pudo descargar el XML firmado: ${dl.message}`),
        { status: 500 }
      );
    }

    let parsed;
    try {
      parsed = parseKudeFromSignedRdeXml(dl.data.toString("utf8"));
    } catch (e) {
      const m = e instanceof Error ? e.message : "Error al leer el XML";
      return NextResponse.json(errorResponse(`XML firmado inválido: ${m}`), { status: 500 });
    }

    const cdcBd = neRow.cdc == null ? "" : String(neRow.cdc).trim();
    if (cdcBd && cdcBd !== parsed.cdc) {
      return NextResponse.json(
        errorResponse("Inconsistencia CDC: re-genere y firme el XML o contacte soporte."),
        { status: 409 }
      );
    }

    const consultaRaw = neRow.sifen_ultima_respuesta_consulta_lote as
      | SifenConsultaLoteUltimaPersistida
      | Record<string, unknown>
      | null
      | undefined;
    const dProtAut = dProtAutDesdeConsulta(parsed.cdc, consultaRaw ?? null);

    const qrUrl = parsed.dCarQR ?? kudeFallbackQrUrl(parsed.cdc);

    const branding = await loadKudeBranding(supabase, auth.empresa_id).catch((e) => {
      console.warn("[kude-nc] branding load failed, using default", {
        empresa_id: auth.empresa_id,
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    });

    // Override de contacto emisor (mismo criterio que el KUDE de facturas):
    // toma el vigente en empresa_sifen_config aunque el XML firmado tenga
    // valores viejos. No modifica el XML.
    let emisorTelefonoOverride: string | null = null;
    let emisorEmailOverride: string | null = null;
    try {
      const { data: cfgRow } = await supabase
        .from("empresa_sifen_config")
        .select("emisor_telefono, emisor_email")
        .eq("empresa_id", auth.empresa_id)
        .maybeSingle();
      const row = cfgRow as { emisor_telefono?: string | null; emisor_email?: string | null } | null;
      const tel = (row?.emisor_telefono ?? "").trim();
      const em = (row?.emisor_email ?? "").trim();
      if (tel) emisorTelefonoOverride = tel;
      if (em) emisorEmailOverride = em;
    } catch (e) {
      console.warn("[kude-nc] no se pudo cargar contacto emisor override", {
        error: e instanceof Error ? e.message : String(e),
      });
    }

    // Ref. ERP para el header del KUDE. Usamos "NC-<8 ult. del id>" — la NC no
    // tiene un numero_control propio en la tabla; el numero fiscal real aparece
    // como `Nº: dEst-dPunExp-dNumDoc` (extraido del XML) en el mismo header.
    const refErp = `NC-${nid.slice(-8).toUpperCase()}`;

    let pdf: Buffer;
    try {
      pdf = await buildKudePdfBuffer({
        parsed,
        numeroFactura: refErp,
        dProtAut,
        qrUrl,
        branding,
        emisorTelefonoOverride,
        emisorEmailOverride,
      });
    } catch (e) {
      const m = e instanceof Error ? e.message : "Error al generar PDF";
      return NextResponse.json(errorResponse(m), { status: 500 });
    }

    const fname = nombreArchivoKudeNc(refErp, parsed.cdc);
    const disp = download ? `attachment; filename="${fname}"` : `inline; filename="${fname}"`;

    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": disp,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
