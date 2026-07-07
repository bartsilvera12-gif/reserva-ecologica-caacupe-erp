import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import {
  asMetadataObject,
  estaFacturado,
  estaPendienteCaja,
  marcarCanceladoDesdeCaja,
} from "@/lib/caja/facturacion";

/**
 * POST /api/caja/pedidos-pendientes/[id]/cancelar
 *
 * Cancela un pedido pendiente en Caja (proyecto tipo 'pedido' en estado
 * `facturacion_estado='pendiente_caja'`). NO toca stock — el pedido nunca lo
 * descontó. Si el pedido nació de un presupuesto, revierte el presupuesto a
 * `estado='aprobado'` y limpia `convertido_pedido_id` para permitir re-facturar
 * o volver a convertir.
 */
export async function POST(
  request: NextRequest,
  ctxParams: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await ctxParams.params;
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const { auth, supabase: sb } = ctx;
    const empresaId = auth.empresa_id;

    const pq = await sb
      .from("proyectos")
      .select("id, metadata, brief_data")
      .eq("empresa_id", empresaId)
      .eq("id", id)
      .maybeSingle();
    if (pq.error) throw new Error(pq.error.message);
    if (!pq.data) {
      return NextResponse.json(errorResponse("Pedido no encontrado."), { status: 404 });
    }
    const proy = pq.data as { id: string; metadata: unknown; brief_data: unknown };

    if (estaFacturado(proy.metadata)) {
      return NextResponse.json(
        errorResponse("El pedido ya fue facturado; no se puede cancelar desde Caja."),
        { status: 409 }
      );
    }
    if (!estaPendienteCaja(proy.metadata)) {
      return NextResponse.json(
        errorResponse("Este pedido no está pendiente en Caja."),
        { status: 409 }
      );
    }

    const nowIso = new Date().toISOString();
    const nuevaMeta = marcarCanceladoDesdeCaja(
      proy.metadata,
      nowIso,
      auth.usuarioCatalogId ?? auth.user?.email ?? null
    );
    const upd = await sb
      .from("proyectos")
      .update({ metadata: nuevaMeta })
      .eq("empresa_id", empresaId)
      .eq("id", id);
    if (upd.error) throw new Error(upd.error.message);

    // Si vino de presupuesto, revertirlo a 'aprobado' para permitir re-uso.
    // Best-effort: si falla, el pedido ya quedó cancelado — se logea nomás.
    const brief = asMetadataObject(proy.brief_data);
    const meta = asMetadataObject(proy.metadata);
    const presupuestoId =
      (typeof brief.presupuesto_id === "string" && brief.presupuesto_id) ||
      (typeof meta.presupuesto_id === "string" && meta.presupuesto_id) ||
      null;
    let presupuesto_liberado = false;
    if (presupuestoId) {
      try {
        const rev = await sb
          .from("presupuestos")
          .update({
            estado: "aprobado",
            convertido_pedido_id: null,
            updated_at: nowIso,
          })
          .eq("empresa_id", empresaId)
          .eq("id", presupuestoId)
          .eq("convertido_pedido_id", id);
        if (rev.error) {
          console.error(
            "[/api/caja/pedidos-pendientes/[id]/cancelar] no se pudo revertir presupuesto",
            { presupuestoId, pedidoId: id, error: rev.error.message }
          );
        } else {
          presupuesto_liberado = true;
        }
      } catch (e) {
        console.error(
          "[/api/caja/pedidos-pendientes/[id]/cancelar] excepción revirtiendo presupuesto",
          { presupuestoId, pedidoId: id, e }
        );
      }
    }

    return NextResponse.json(
      successResponse({ cancelado: true, presupuesto_id: presupuestoId, presupuesto_liberado })
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudo cancelar el pedido.";
    console.error("[/api/caja/pedidos-pendientes/[id]/cancelar]", msg);
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
