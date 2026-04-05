import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getUserAndEmpresa } from "@/lib/middleware/auth";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { toFacturaElectronicaDto } from "@/lib/sifen/to-factura-electronica-dto";
import type { FacturaElectronicaDTO } from "@/lib/sifen/types";

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase no configurado");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

export type FacturaSifenResumenData = {
  sifen_config_exists: boolean;
  sifen_config_activa: boolean;
  /** `test` | `prod` si hay fila de config; null si no. */
  sifen_ambiente: string | null;
  factura_electronica: FacturaElectronicaDTO | null;
};

/**
 * GET /api/facturas/[id]/sifen/resumen
 * Config SIFEN (existencia/activo) + fila factura_electronica si existe (una sola ida a BD agrupada en handler).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await getUserAndEmpresa();
    if (!auth) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }

    const { id } = await params;
    const fid = id?.trim();
    if (!fid) {
      return NextResponse.json(errorResponse("id de factura es obligatorio"), { status: 400 });
    }

    const supabase = getSupabase();

    const { data: factura, error: errFactura } = await supabase
      .from("facturas")
      .select("id")
      .eq("id", fid)
      .eq("empresa_id", auth.empresa_id)
      .maybeSingle();

    if (errFactura) {
      return NextResponse.json(errorResponse(errFactura.message), { status: 400 });
    }
    if (!factura) {
      return NextResponse.json(errorResponse("Factura no encontrada"), { status: 404 });
    }

    const [{ data: cfg }, { data: fe }] = await Promise.all([
      supabase
        .from("empresa_sifen_config")
        .select("activo, ambiente")
        .eq("empresa_id", auth.empresa_id)
        .maybeSingle(),
      supabase.from("factura_electronica").select("*").eq("factura_id", fid).eq("empresa_id", auth.empresa_id).maybeSingle(),
    ]);

    const sifen_config_exists = cfg != null;
    const sifen_config_activa = Boolean(cfg && (cfg as { activo?: boolean }).activo);
    const ambienteRaw =
      cfg != null && (cfg as { ambiente?: string | null }).ambiente != null
        ? String((cfg as { ambiente?: string | null }).ambiente).trim()
        : "";
    const sifen_ambiente = ambienteRaw.length > 0 ? ambienteRaw : null;

    let feOut = fe;
    if (fe) {
      const row = fe as Record<string, unknown>;
      if (String(row.estado_sifen ?? "") === "error_envio") {
        const ult = row.sifen_ultima_respuesta_recibe_lote;
        const cod =
          ult != null && typeof ult === "object" && "dCodRes" in ult
            ? String((ult as Record<string, unknown>).dCodRes ?? "").trim()
            : "";
        const prot =
          row.sifen_d_prot_cons_lote == null ? "" : String(row.sifen_d_prot_cons_lote).trim();
        const httpSt =
          ult != null && typeof ult === "object" && "httpStatus" in ult
            ? Number((ult as Record<string, unknown>).httpStatus)
            : NaN;
        const httpOk = Number.isFinite(httpSt) && httpSt >= 200 && httpSt < 300;
        const codSin = cod.replace(/^0+/, "") || "";
        const es0300 = cod === "0300" || codSin === "300";
        const es0301 = cod === "0301" || codSin === "301";
        const debeCorregir =
          (es0300 && prot.length > 0) || (httpOk && prot.length > 0 && !es0301);
        if (debeCorregir) {
          const { data: fixed } = await supabase
            .from("factura_electronica")
            .update({ estado_sifen: "enviado", error: null })
            .eq("id", row.id)
            .eq("empresa_id", auth.empresa_id)
            .select()
            .single();
          if (fixed) feOut = fixed;
        }
      }
    }

    const payload: FacturaSifenResumenData = {
      sifen_config_exists,
      sifen_config_activa,
      sifen_ambiente,
      factura_electronica: feOut ? toFacturaElectronicaDto(feOut as Record<string, unknown>) : null,
    };

    return NextResponse.json(successResponse(payload), {
      headers: {
        "Cache-Control": "private, no-store, max-age=0, must-revalidate",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
