import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuthWithRol } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { createNotaCreditoBorrador } from "@/lib/nota-credito/create-nota-credito";
import { evaluateNotaCreditoCreationGate } from "@/lib/nota-credito/evaluate-creation-gate";
import type { NotaCreditoCreateBody, NotaCreditoListItemDTO } from "@/lib/nota-credito/types";
import { obtenerSifenPrevueloFacturaParaNcs } from "@/lib/nota-credito/pre-vuelo-nc-sifen";

function compactSetResponses(ne: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!ne) return null;
  const rec = ne.sifen_ultima_respuesta_recibe_lote;
  const cons = ne.sifen_ultima_respuesta_consulta_lote;
  if (rec == null && cons == null) return null;
  const out: Record<string, unknown> = {};
  if (rec != null && typeof rec === "object") out.recibe_lote = rec;
  if (cons != null && typeof cons === "object") out.consulta_lote = cons;
  return Object.keys(out).length ? out : null;
}

function mapListRow(r: Record<string, unknown>): NotaCreditoListItemDTO {
  const ne = r.nota_credito_electronica as Record<string, unknown> | null | undefined;
  const lineasRaw = Array.isArray(r.nota_credito_items)
    ? (r.nota_credito_items as Record<string, unknown>[])
    : [];
  return {
    id: String(r.id),
    numero: r.numero == null || !Number.isFinite(Number(r.numero)) ? null : Number(r.numero),
    items: lineasRaw.map((l) => ({
      producto_nombre: String(l.producto_nombre_snapshot ?? "").trim() || "Ítem",
      sku: l.sku_snapshot == null ? null : String(l.sku_snapshot),
      cantidad: Number(l.cantidad) || 0,
      precio_unitario: Number(l.precio_unitario) || 0,
      tipo_iva: (l.tipo_iva === "5%" || l.tipo_iva === "10%" ? l.tipo_iva : "EXENTA") as
        | "EXENTA"
        | "5%"
        | "10%",
      total_linea: Number(l.total_linea) || 0,
    })),
    monto: Number(r.monto),
    motivo: String(r.motivo),
    observacion_interna: r.observacion_interna == null ? null : String(r.observacion_interna),
    estado_erp: String(r.estado_erp) as NotaCreditoListItemDTO["estado_erp"],
    created_at: String(r.created_at ?? ""),
    created_by_user_id: r.created_by_user_id == null ? null : String(r.created_by_user_id),
    created_by_email_snapshot: r.created_by_email_snapshot == null ? null : String(r.created_by_email_snapshot),
    created_by_nombre_snapshot: r.created_by_nombre_snapshot == null ? null : String(r.created_by_nombre_snapshot),
    saldo_previo_snapshot: Number(r.saldo_previo_snapshot),
    monto_factura_snapshot: Number(r.monto_factura_snapshot),
    suma_pagos_snapshot: Number(r.suma_pagos_snapshot),
    moneda_snapshot: String(r.moneda_snapshot),
    estado_sifen: ne?.estado_sifen == null ? null : (String(ne.estado_sifen) as NotaCreditoListItemDTO["estado_sifen"]),
    cdc: ne?.cdc == null ? null : String(ne.cdc),
    cdc_factura_origen: ne?.cdc_factura_origen == null ? null : String(ne.cdc_factura_origen),
    last_error: ne?.last_error == null ? null : String(ne.last_error),
    xml_path: ne?.xml_path == null || String(ne.xml_path).trim() === "" ? null : String(ne.xml_path),
    xml_firmado_path:
      ne?.xml_firmado_path == null || String(ne.xml_firmado_path).trim() === ""
        ? null
        : String(ne.xml_firmado_path),
    sifen_respuestas_set: compactSetResponses(ne),
  };
}

/**
 * GET /api/facturas/[id]/notas-credito — listado + gate para crear.
 * POST — crea NC borrador (fase 1, sin SIFEN).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getTenantSupabaseFromAuthWithRol(request);
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const { auth, supabase } = ctx;
    const { id } = await params;
    const fid = id?.trim();
    if (!fid) {
      return NextResponse.json(errorResponse("id de factura es obligatorio"), { status: 400 });
    }

    const { data: factura, error: errF } = await supabase
      .from("facturas")
      .select("id")
      .eq("id", fid)
      .eq("empresa_id", auth.empresa_id)
      .maybeSingle();

    if (errF) {
      return NextResponse.json(errorResponse(errF.message), { status: 400 });
    }
    if (!factura) {
      return NextResponse.json(errorResponse("Factura no encontrada"), { status: 404 });
    }

    const gate = await evaluateNotaCreditoCreationGate(supabase, auth.empresa_id, fid);
    const sifen_prevuelo_factura = await obtenerSifenPrevueloFacturaParaNcs(supabase, auth.empresa_id, fid);

    const { data: rows, error: errL } = await supabase
      .from("nota_credito")
      .select(
        "id, numero, monto, motivo, observacion_interna, estado_erp, created_at, created_by_user_id, created_by_email_snapshot, created_by_nombre_snapshot, saldo_previo_snapshot, monto_factura_snapshot, suma_pagos_snapshot, moneda_snapshot, nota_credito_items(producto_nombre_snapshot, sku_snapshot, cantidad, precio_unitario, tipo_iva, total_linea), nota_credito_electronica(estado_sifen, cdc, cdc_factura_origen, last_error, xml_path, xml_firmado_path, sifen_ultima_respuesta_recibe_lote, sifen_ultima_respuesta_consulta_lote)"
      )
      .eq("factura_id", fid)
      .eq("empresa_id", auth.empresa_id)
      .order("created_at", { ascending: false });

    if (errL) {
      return NextResponse.json(errorResponse(errL.message), { status: 400 });
    }

    const items = (rows ?? []).map((x) => mapListRow(x as unknown as Record<string, unknown>));

    // Agregados: monto acreditado (NC ya aprobadas por SIFEN) + monto pendiente
    // (borradores + en curso, aún no aplicados al saldo). Se usan en la ficha
    // de factura para mostrar "Acreditado / Saldo restante" sin cálculos extra
    // en el cliente.
    let monto_acreditado = 0;
    let monto_pendiente_aprobacion = 0;
    for (const it of items) {
      const monto = Number(it.monto) || 0;
      if (it.estado_erp === "aprobada") monto_acreditado += monto;
      else if (
        it.estado_erp === "borrador" ||
        it.estado_erp === "pendiente_envio_sifen"
      ) {
        monto_pendiente_aprobacion += monto;
      }
    }

    // Ítems de la factura origen: se usan para precargar el editor de NC
    // parcial (Fase B) sin requerir un fetch extra. Best-effort: si la
    // factura no tiene ítems desglosados (ej. facturas de suscripción),
    // se devuelve array vacío.
    const { data: facItemsRows } = await supabase
      .from("factura_items")
      .select("id, descripcion, cantidad, precio_unitario, subtotal, iva, total, tipo_iva")
      .eq("factura_id", fid)
      .eq("empresa_id", auth.empresa_id)
      .order("created_at", { ascending: true });
    const factura_items = (facItemsRows ?? []).map((r) => {
      const row = r as Record<string, unknown>;
      const tipoIvaRaw = String(row.tipo_iva ?? "").trim();
      const tipoIva: "EXENTA" | "5%" | "10%" =
        tipoIvaRaw === "5%" || tipoIvaRaw === "10%" ? tipoIvaRaw : "EXENTA";
      return {
        id: String(row.id ?? ""),
        descripcion: String(row.descripcion ?? ""),
        cantidad: Number(row.cantidad) || 0,
        precio_unitario: Number(row.precio_unitario) || 0,
        subtotal: Number(row.subtotal) || 0,
        monto_iva: Number(row.iva) || 0,
        total_linea: Number(row.total) || 0,
        tipo_iva: tipoIva,
      };
    });

    return NextResponse.json(
      successResponse({
        items,
        puede_crear: gate.puede_crear,
        motivo_bloqueo_creacion: gate.motivo_bloqueo,
        sifen_prevuelo_factura,
        resumen: {
          monto_acreditado,
          monto_pendiente_aprobacion,
          cantidad_ncs: items.length,
          cantidad_aprobadas: items.filter((i) => i.estado_erp === "aprobada").length,
        },
        factura_items,
      })
    );
  } catch (e) {
    return NextResponse.json(
      errorResponse(e instanceof Error ? e.message : "Error interno"),
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getTenantSupabaseFromAuthWithRol(request);
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const { auth, supabase } = ctx;
    const { id } = await params;
    const fid = id?.trim();
    if (!fid) {
      return NextResponse.json(errorResponse("id de factura es obligatorio"), { status: 400 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(errorResponse("Cuerpo JSON inválido"), { status: 400 });
    }
    const b = (body ?? {}) as NotaCreditoCreateBody;

    const result = await createNotaCreditoBorrador({
      supabase,
      empresaId: auth.empresa_id,
      facturaId: fid,
      authUserId: auth.user.id,
      authEmail: auth.user.email ?? null,
      authNombre: auth.nombre ?? null,
      motivo: b.motivo ?? "",
      observacionInterna: b.observacion_interna ?? null,
      tipoNc: b.tipo_nc === "parcial" ? "parcial" : "total",
      items: Array.isArray(b.items) ? b.items : null,
    });

    if (!result.ok) {
      return NextResponse.json(errorResponse(result.error), { status: result.status });
    }

    return NextResponse.json(successResponse({ nota_credito_id: result.nota_credito_id }));
  } catch (e) {
    return NextResponse.json(
      errorResponse(e instanceof Error ? e.message : "Error interno"),
      { status: 500 }
    );
  }
}
