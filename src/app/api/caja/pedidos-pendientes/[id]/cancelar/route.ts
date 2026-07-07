import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import {
  estaFacturado,
  estaPendienteCaja,
  marcarCanceladoDesdeCaja,
} from "@/lib/caja/facturacion";

/**
 * POST /api/caja/pedidos-pendientes/[id]/cancelar
 *
 * Quita un pedido de la Caja (proyecto tipo 'pedido' en estado
 * `facturacion_estado='pendiente_caja'`). Limpia la marca de caja del
 * proyecto para que vuelva a estar "listo para enviar a caja" desde su
 * vista de proyecto. NO toca stock, NO toca el presupuesto origen, NO
 * toca la máquina de estados del proyecto — solo desmarca la caja.
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
      .select("id, metadata")
      .eq("empresa_id", empresaId)
      .eq("id", id)
      .maybeSingle();
    if (pq.error) throw new Error(pq.error.message);
    if (!pq.data) {
      return NextResponse.json(errorResponse("Pedido no encontrado."), { status: 404 });
    }
    const proy = pq.data as { id: string; metadata: unknown };

    if (estaFacturado(proy.metadata)) {
      return NextResponse.json(
        errorResponse("El pedido ya fue facturado; no se puede quitar de Caja."),
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

    return NextResponse.json(successResponse({ cancelado: true }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudo cancelar el pedido.";
    console.error("[/api/caja/pedidos-pendientes/[id]/cancelar]", msg);
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
