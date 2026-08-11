import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuthWithRol } from "@/lib/supabase/tenant-api";
import { errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { downloadSifenObject } from "@/lib/sifen/sifen-storage";

/**
 * GET /api/notas-credito/[id]/sifen/documento
 * Descarga el XML rDE de la NOTA DE CRÉDITO almacenado en el bucket `sifen`:
 * el firmado si existe, si no el generado. Content-Type: application/xml.
 * Se usa, entre otros, para entregar a la DNIT los documentos de un caso.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getTenantSupabaseFromAuthWithRol(request);
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const { auth, supabase } = ctx;
    const { id } = await params;
    const nid = id?.trim() ?? "";
    if (!nid) {
      return NextResponse.json(errorResponse("id de nota de crédito es obligatorio"), { status: 400 });
    }

    const { data: neRow, error: errNe } = await supabase
      .from("nota_credito_electronica")
      .select("xml_path, xml_firmado_path, cdc")
      .eq("nota_credito_id", nid)
      .eq("empresa_id", auth.empresa_id)
      .maybeSingle();

    if (errNe) {
      return NextResponse.json(errorResponse(errNe.message), { status: 400 });
    }
    if (!neRow) {
      return NextResponse.json(errorResponse("No hay documento electrónico para esta nota de crédito."), { status: 404 });
    }

    const firmado = neRow.xml_firmado_path == null ? "" : String(neRow.xml_firmado_path).trim();
    const generado = neRow.xml_path == null ? "" : String(neRow.xml_path).trim();
    const tryPaths: { path: string; label: string }[] = [];
    if (firmado) tryPaths.push({ path: firmado, label: "firmado" });
    if (generado) tryPaths.push({ path: generado, label: "generado" });

    if (tryPaths.length === 0) {
      return NextResponse.json(errorResponse("Aún no hay XML en storage para esta NC."), { status: 404 });
    }

    const cdc = neRow.cdc == null ? "" : String(neRow.cdc).trim();
    const filename = `${cdc || `NC-${nid}`}.xml`;

    let lastErr = "";
    for (const { path: objectPath, label } of tryPaths) {
      const dl = await downloadSifenObject(supabase, objectPath);
      if (dl.ok) {
        return new NextResponse(dl.data.toString("utf8"), {
          status: 200,
          headers: {
            "Content-Type": "application/xml; charset=utf-8",
            "Content-Disposition": `attachment; filename="${filename}"`,
            "Cache-Control": "private, no-store",
            "X-Sifen-Xml-Origen": label,
          },
        });
      }
      lastErr = dl.message;
    }

    return NextResponse.json(errorResponse(`No se pudo leer el XML desde storage: ${lastErr}`), { status: 502 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
