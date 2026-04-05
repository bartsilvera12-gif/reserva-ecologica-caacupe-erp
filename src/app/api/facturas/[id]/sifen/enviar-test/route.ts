import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getUserAndEmpresa } from "@/lib/middleware/auth";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { decryptSecret } from "@/lib/sifen/security";
import { enviarLoteSifenTest, type RecibeLoteRespuestaParsed } from "@/lib/sifen/enviar-lote-sifen-test";
import { downloadSifenObject, SIFEN_STORAGE_BUCKET } from "@/lib/sifen/sifen-storage";
import { downloadSifenCertificadoObject } from "@/lib/sifen/sifen-certificados-storage";
import { toFacturaElectronicaDto } from "@/lib/sifen/to-factura-electronica-dto";
import type { SifenApiEnviarTestDetalle, SifenEnviarTestResponseData } from "@/lib/sifen/types";

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase no configurado");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

function respuestaRecibeLoteJson(r: RecibeLoteRespuestaParsed): Record<string, unknown> {
  return {
    dCodRes: r.dCodRes,
    dMsgRes: r.dMsgRes,
    dProtConsLote: r.dProtConsLote,
    dFecProc: r.dFecProc,
    dTpoProces: r.dTpoProces,
    loteRecibido: r.loteRecibido,
    loteNoEncolado: r.loteNoEncolado,
    httpStatus: r.httpStatus,
    cuerpoSoapCrudo: r.cuerpoSoapCrudo,
  };
}

/**
 * POST /api/facturas/[id]/sifen/enviar-test
 * Envía el XML firmado a SIFEN TEST (recibe-lote). Requiere estado `firmado` y ambiente test.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await getUserAndEmpresa();
    if (!auth) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }

    const { id: facturaId } = await params;
    if (!facturaId?.trim()) {
      return NextResponse.json(errorResponse("id de factura es obligatorio"), { status: 400 });
    }

    const debugSoap = request.nextUrl.searchParams.get("debug") === "1";
    const supabase = getSupabase();
    const fid = facturaId.trim();

    const { data: feRow, error: errFe } = await supabase
      .from("factura_electronica")
      .select(
        "id, factura_id, estado_sifen, xml_firmado_path, error, sifen_d_prot_cons_lote, sifen_ultima_respuesta_recibe_lote"
      )
      .eq("factura_id", fid)
      .eq("empresa_id", auth.empresa_id)
      .maybeSingle();

    if (errFe) {
      return NextResponse.json(errorResponse(errFe.message), { status: 400 });
    }
    if (!feRow) {
      return NextResponse.json(
        errorResponse("No existe registro electrónico para esta factura."),
        { status: 400 }
      );
    }

    if (String(feRow.estado_sifen) !== "firmado") {
      return NextResponse.json(
        errorResponse(
          `Solo se puede enviar a TEST con estado "firmado". Estado actual: "${feRow.estado_sifen}".`
        ),
        { status: 409 }
      );
    }

    const signedPath =
      feRow.xml_firmado_path == null ? "" : String(feRow.xml_firmado_path).trim();
    if (!signedPath) {
      return NextResponse.json(
        errorResponse("No hay XML firmado (xml_firmado_path vacío). Ejecute primero POST .../sifen/firmar."),
        { status: 400 }
      );
    }

    const { data: cfg, error: errCfg } = await supabase
      .from("empresa_sifen_config")
      .select("ambiente, activo, certificado_path, certificado_password_encrypted")
      .eq("empresa_id", auth.empresa_id)
      .maybeSingle();

    if (errCfg) {
      return NextResponse.json(errorResponse(errCfg.message), { status: 400 });
    }
    if (!cfg) {
      return NextResponse.json(errorResponse("No hay configuración SIFEN para esta empresa."), {
        status: 400,
      });
    }

    if (String(cfg.ambiente) !== "test") {
      return NextResponse.json(
        errorResponse(
          'Este endpoint solo opera con configuración SIFEN en ambiente "test". Cambie ambiente o use el flujo de producción cuando exista.'
        ),
        { status: 400 }
      );
    }

    if (!cfg.activo) {
      return NextResponse.json(
        errorResponse("La configuración SIFEN está inactiva. Actívela antes de enviar."),
        { status: 400 }
      );
    }

    const certPath =
      cfg.certificado_path == null ? "" : String(cfg.certificado_path).trim();
    if (!certPath) {
      return NextResponse.json(
        errorResponse("No hay certificado en storage. Suba el .p12 en configuración SIFEN."),
        { status: 400 }
      );
    }

    const encPwd = cfg.certificado_password_encrypted;
    if (encPwd == null || String(encPwd).trim() === "") {
      return NextResponse.json(
        errorResponse("Falta la contraseña del certificado cifrada en configuración SIFEN."),
        { status: 400 }
      );
    }

    let p12Password: string;
    try {
      p12Password = decryptSecret(String(encPwd));
    } catch (e) {
      const m = e instanceof Error ? e.message : "Error al descifrar la contraseña del certificado";
      return NextResponse.json(errorResponse(m), { status: 500 });
    }

    const xmlDl = await downloadSifenObject(supabase, signedPath);
    if (!xmlDl.ok) {
      return NextResponse.json(
        errorResponse(`No se pudo descargar el XML firmado: ${xmlDl.message}`),
        { status: 500 }
      );
    }

    const p12Dl = await downloadSifenCertificadoObject(supabase, certPath);
    if (!p12Dl.ok) {
      return NextResponse.json(
        errorResponse(`No se pudo descargar el certificado .p12: ${p12Dl.message}`),
        { status: 500 }
      );
    }

    let resp: RecibeLoteRespuestaParsed;
    try {
      resp = await enviarLoteSifenTest({
        xmlFirmado: xmlDl.data.toString("utf8"),
        empresaConfig: {
          ambiente: "test",
          certificadoP12: p12Dl.data,
          certificadoPassword: p12Password,
        },
        facturaElectronicaId: String(feRow.id),
        envoltorioRloteDe: true,
      });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      return NextResponse.json(
        errorResponse(`Fallo al llamar a SIFEN TEST (recibe-lote): ${m}`),
        { status: 502 }
      );
    }

    const respuestaJson = respuestaRecibeLoteJson(resp);

    const previousEstado = String(feRow.estado_sifen ?? "firmado");
    const previousError = feRow.error == null ? null : String(feRow.error);
    const previousProt =
      feRow.sifen_d_prot_cons_lote == null ? null : String(feRow.sifen_d_prot_cons_lote);
    const previousUltima = feRow.sifen_ultima_respuesta_recibe_lote;

    let nuevoEstado: "enviado" | "error_envio";
    let nuevoError: string | null;
    let nuevoProt: string | null;

    /** Aceptación del lote: flag del cliente, código 0300 (con o sin ceros iniciales) o 2xx + protocolo (p. ej. dCodRes no parseado pero SET devolvió dProtConsLote). */
    const codRecibe = String(resp.dCodRes ?? "").trim();
    const codSinCerosIni = codRecibe.replace(/^0+/, "") || "";
    const codigoEs0300 = codRecibe === "0300" || codSinCerosIni === "300";
    const protTrim =
      resp.dProtConsLote == null ? "" : String(resp.dProtConsLote).trim();
    const http2xx = resp.httpStatus >= 200 && resp.httpStatus < 300;
    const loteAceptadoPorSet =
      resp.loteRecibido ||
      codigoEs0300 ||
      (http2xx && protTrim.length > 0 && !resp.loteNoEncolado);

    if (loteAceptadoPorSet) {
      nuevoEstado = "enviado";
      nuevoError = null;
      nuevoProt = resp.dProtConsLote == null ? null : String(resp.dProtConsLote).trim() || null;
    } else if (resp.loteNoEncolado) {
      nuevoEstado = "error_envio";
      nuevoError =
        [resp.dMsgRes, resp.dCodRes ? `Código ${resp.dCodRes}` : null].filter(Boolean).join(" — ") ||
        "SET no encoló el lote (0301).";
      nuevoProt = null;
    } else {
      nuevoEstado = "error_envio";
      const code = resp.dCodRes?.trim() ?? "";
      nuevoError =
        [resp.dMsgRes, code ? `Código ${code}` : null, `HTTP ${resp.httpStatus}`]
          .filter(Boolean)
          .join(" — ") || "Respuesta inesperada de recibe-lote.";
      nuevoProt = null;
    }

    const { data: updatedRow, error: errUpdate } = await supabase
      .from("factura_electronica")
      .update({
        estado_sifen: nuevoEstado,
        error: nuevoError,
        sifen_d_prot_cons_lote: nuevoProt,
        sifen_ultima_respuesta_recibe_lote: respuestaJson,
      })
      .eq("id", feRow.id)
      .eq("empresa_id", auth.empresa_id)
      .select()
      .single();

    if (errUpdate || !updatedRow) {
      return NextResponse.json(
        errorResponse(errUpdate?.message ?? "No se pudo actualizar factura_electronica."),
        { status: 500 }
      );
    }

    const detalle: SifenApiEnviarTestDetalle = {
      origen: "api_enviar_test",
      factura_id: fid,
      xml_firmado_path: signedPath,
      dCodRes: resp.dCodRes,
      dMsgRes: resp.dMsgRes,
      dProtConsLote: resp.dProtConsLote,
      httpStatus: resp.httpStatus,
      loteRecibido: resp.loteRecibido,
      loteNoEncolado: resp.loteNoEncolado,
    };

    const { error: errEvento } = await supabase.from("factura_electronica_evento").insert({
      empresa_id: auth.empresa_id,
      factura_electronica_id: feRow.id,
      tipo: "envio",
      detalle,
    });

    if (errEvento) {
      await supabase
        .from("factura_electronica")
        .update({
          estado_sifen: previousEstado,
          error: previousError,
          sifen_d_prot_cons_lote: previousProt,
          sifen_ultima_respuesta_recibe_lote: previousUltima,
        })
        .eq("id", feRow.id)
        .eq("empresa_id", auth.empresa_id);
      return NextResponse.json(
        errorResponse(`No se pudo registrar el evento; se revirtió el estado: ${errEvento.message}`),
        { status: 500 }
      );
    }

    const dto = toFacturaElectronicaDto(updatedRow as Record<string, unknown>);
    const data: SifenEnviarTestResponseData = {
      factura_electronica: dto,
      storage_bucket: SIFEN_STORAGE_BUCKET,
      recibe_lote: {
        dCodRes: resp.dCodRes,
        dMsgRes: resp.dMsgRes,
        dProtConsLote: resp.dProtConsLote,
        dFecProc: resp.dFecProc,
        dTpoProces: resp.dTpoProces,
        httpStatus: resp.httpStatus,
        loteRecibido: resp.loteRecibido,
        loteNoEncolado: resp.loteNoEncolado,
      },
    };
    if (debugSoap) {
      data.cuerpo_soap = resp.cuerpoSoapCrudo;
    }

    return NextResponse.json(successResponse(data));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
