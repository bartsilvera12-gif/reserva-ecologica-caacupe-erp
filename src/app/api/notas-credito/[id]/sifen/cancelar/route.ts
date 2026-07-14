import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { downloadSifenCertificadoObject } from "@/lib/sifen/sifen-certificados-storage";
import { decryptSecret } from "@/lib/sifen/security";
import { enviarEventoCancelacionSifen, normalizarMotivoEvento } from "@/lib/sifen/evento-cancelacion";
import type { AmbienteSifen } from "@/lib/sifen/types";

type RouteCtx = { params: Promise<{ id: string }> };

/**
 * POST /api/notas-credito/[id]/sifen/cancelar
 *
 * Cancela una NC APROBADA ante la SET (evento siRecepEvento) y, SOLO si la SET
 * registra el evento, la marca cancelada en el ERP y devuelve el saldo a la
 * factura.
 *
 * No se marca nada localmente si la SET rechaza: el documento sigue vigente para
 * el fisco, y decir lo contrario en el ERP sería peor que no hacer nada.
 */
export async function POST(request: NextRequest, { params }: RouteCtx) {
  try {
    const { id } = await params;
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const { auth, supabase } = ctx;

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    let motivo: string;
    try {
      motivo = normalizarMotivoEvento(String(body.motivo ?? ""));
    } catch (e) {
      return NextResponse.json(
        errorResponse(e instanceof Error ? e.message : "Motivo inválido."),
        { status: 400 }
      );
    }

    const { data: nc, error: errNc } = await supabase
      .from("nota_credito")
      .select("id, factura_id, monto, estado_erp")
      .eq("id", id)
      .eq("empresa_id", auth.empresa_id)
      .maybeSingle();

    if (errNc) return NextResponse.json(errorResponse(errNc.message), { status: 400 });
    if (!nc) return NextResponse.json(errorResponse("Nota de crédito no encontrada."), { status: 404 });

    const estadoErp = String((nc as { estado_erp?: string }).estado_erp ?? "");
    if (estadoErp === "cancelada") {
      return NextResponse.json(successResponse({ ya_cancelada: true }));
    }
    if (estadoErp !== "aprobada") {
      return NextResponse.json(
        errorResponse(
          `Solo se puede cancelar en la SET una nota de crédito aprobada (estado actual: ${estadoErp}). ` +
            "Si es un borrador, usá «Anular borrador»."
        ),
        { status: 409 }
      );
    }

    const { data: ne, error: errNe } = await supabase
      .from("nota_credito_electronica")
      .select("id, cdc, estado_sifen")
      .eq("nota_credito_id", id)
      .eq("empresa_id", auth.empresa_id)
      .maybeSingle();

    if (errNe) return NextResponse.json(errorResponse(errNe.message), { status: 400 });
    if (!ne) {
      return NextResponse.json(
        errorResponse("La nota de crédito no tiene documento electrónico."),
        { status: 404 }
      );
    }

    const cdc = String((ne as { cdc?: string | null }).cdc ?? "").trim();
    if (cdc.length !== 44) {
      return NextResponse.json(
        errorResponse("La nota de crédito no tiene CDC válido; no hay nada que cancelar en la SET."),
        { status: 409 }
      );
    }

    const { data: cfg, error: errCfg } = await supabase
      .from("empresa_sifen_config")
      .select("ambiente, activo, certificado_path, certificado_password_encrypted")
      .eq("empresa_id", auth.empresa_id)
      .maybeSingle();

    if (errCfg) return NextResponse.json(errorResponse(errCfg.message), { status: 400 });
    if (!cfg) {
      return NextResponse.json(errorResponse("No hay configuración SIFEN."), { status: 400 });
    }

    const ambiente: AmbienteSifen =
      String((cfg as { ambiente?: string }).ambiente ?? "").trim().toLowerCase() === "produccion"
        ? "produccion"
        : "test";

    const certPath = String((cfg as { certificado_path?: string | null }).certificado_path ?? "").trim();
    if (!certPath) {
      return NextResponse.json(
        errorResponse("No hay certificado .p12 en configuración SIFEN."),
        { status: 400 }
      );
    }
    const encPwd = (cfg as { certificado_password_encrypted?: unknown }).certificado_password_encrypted;
    if (encPwd == null) {
      return NextResponse.json(
        errorResponse("Falta la contraseña del certificado en configuración SIFEN."),
        { status: 400 }
      );
    }

    let p12Password: string;
    try {
      p12Password = decryptSecret(String(encPwd));
    } catch (e) {
      return NextResponse.json(
        errorResponse(e instanceof Error ? e.message : "No se pudo descifrar la contraseña del certificado."),
        { status: 400 }
      );
    }

    const p12Dl = await downloadSifenCertificadoObject(supabase, certPath);
    if (!p12Dl.ok) {
      return NextResponse.json(
        errorResponse(`No se pudo descargar el certificado .p12: ${p12Dl.message}`),
        { status: 400 }
      );
    }

    // ── Envío del evento a la SET ────────────────────────────────────────────
    const resp = await enviarEventoCancelacionSifen({
      ambiente,
      cdc,
      motivo,
      certificadoP12: p12Dl.data,
      certificadoPassword: p12Password,
    });

    if (!resp.cancelado) {
      // La SET NO registró la cancelación: no se toca nada local. El documento
      // sigue vigente para el fisco.
      return NextResponse.json(
        {
          ...errorResponse(
            resp.dMsgRes?.trim() ||
              (resp.soapFault
                ? "La SET devolvió un SOAP Fault al procesar el evento de cancelación."
                : `La SET no registró la cancelación (HTTP ${resp.httpStatus}).`)
          ),
          sifen: {
            dCodRes: resp.dCodRes,
            dMsgRes: resp.dMsgRes,
            httpStatus: resp.httpStatus,
          },
        },
        { status: 409 }
      );
    }

    // ── La SET registró el evento: recién ahora se aplica en el ERP ──────────
    const schema = await fetchDataSchemaForEmpresaId(auth.empresa_id);
    const canceladoEn = new Date().toISOString();

    const { error: rpcErr } = await supabase.rpc("nota_credito_aplicar_cancelacion_set", {
      p_data_schema: schema,
      p_nota_credito_id: id,
      p_ne_id: String((ne as { id: string }).id),
      p_factura_id: String((nc as { factura_id: string }).factura_id),
      p_empresa_id: auth.empresa_id,
      p_motivo: motivo,
      p_cancelado_at: canceladoEn,
    });

    if (rpcErr) {
      // Caso delicado: la SET YA canceló, pero el ERP no pudo registrarlo.
      // Se informa explícitamente para que se reintente (el RPC es idempotente).
      return NextResponse.json(
        errorResponse(
          `La SET canceló la nota de crédito, pero el ERP no pudo registrarlo: ${rpcErr.message}. ` +
            "Reintentá la cancelación (la operación es idempotente)."
        ),
        { status: 500 }
      );
    }

    return NextResponse.json(
      successResponse({
        cancelado: true,
        cdc,
        motivo,
        cancelado_at: canceladoEn,
        sifen: { dCodRes: resp.dCodRes, dMsgRes: resp.dMsgRes },
      })
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[/api/notas-credito/[id]/sifen/cancelar]", msg);
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
