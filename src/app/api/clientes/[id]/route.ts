import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/middleware/auth";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { getTenantSupabaseFromAuthWithRol } from "@/lib/supabase/tenant-api";


/**
 * DELETE /api/clientes/:id
 * Eliminación lógica (soft delete). Solo administradores.
 * Body: { deletion_reason: string, cancelar_suscripciones?: boolean, anular_facturas_pendientes?: boolean }
 * Si hay suscripciones activas o facturas con saldo, se exige el flag correspondiente en true.
 * Bloqueo duro: ventas o tipificaciones asociadas.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await getTenantSupabaseFromAuthWithRol();
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const { auth, supabase } = ctx;

    if (!isAdmin(auth)) {
      return NextResponse.json(errorResponse("Solo usuarios administradores pueden eliminar clientes"), { status: 403 });
    }

    const { id: clienteId } = await params;
    if (!clienteId) {
      return NextResponse.json(errorResponse("id es obligatorio"), { status: 400 });
    }

    const body = await request.json().catch(() => ({}));
    const deletionReason = typeof body.deletion_reason === "string" ? body.deletion_reason.trim() : "";
    const cancelarSuscripciones = Boolean(body.cancelar_suscripciones);
    const anularFacturasPendientes = Boolean(body.anular_facturas_pendientes);

    if (!deletionReason) {
      return NextResponse.json(errorResponse("El motivo de eliminación es obligatorio"), { status: 400 });
    }


    const { data: cliente, error: errCliente } = await supabase
      .from("clientes")
      .select("id, empresa_id, deleted_at")
      .eq("id", clienteId)
      .eq("empresa_id", auth.empresa_id)
      .is("deleted_at", null)
      .single();

    if (errCliente || !cliente) {
      return NextResponse.json(errorResponse("Cliente no encontrado o ya eliminado"), { status: 404 });
    }

    const [ventas, tipif, suscActivas, factPend] = await Promise.all([
      supabase.from("ventas").select("id").eq("cliente_id", clienteId).limit(1),
      supabase.from("tipificaciones").select("id").eq("cliente_id", clienteId).limit(1),
      supabase
        .from("suscripciones")
        .select("id")
        .eq("cliente_id", clienteId)
        .eq("empresa_id", auth.empresa_id)
        .eq("estado", "activa"),
      supabase
        .from("facturas")
        .select("id")
        .eq("cliente_id", clienteId)
        .eq("empresa_id", auth.empresa_id)
        .neq("estado", "Anulado")
        .gt("saldo", 0),
    ]);

    const tieneVentas = (ventas.data?.length ?? 0) > 0;
    const tieneTipificaciones = (tipif.data?.length ?? 0) > 0;

    if (tieneVentas || tieneTipificaciones) {
      const partes: string[] = [];
      if (tieneVentas) partes.push("ventas");
      if (tieneTipificaciones) partes.push("tipificaciones");
      return NextResponse.json(
        errorResponse(`No se puede eliminar: el cliente tiene ${partes.join(" y ")} asociados`),
        { status: 400 }
      );
    }

    const nSuscActivas = suscActivas.data?.length ?? 0;
    const nFactPend = factPend.data?.length ?? 0;

    if (nSuscActivas > 0 && !cancelarSuscripciones) {
      return NextResponse.json(
        errorResponse(
          "Hay suscripciones activas. Confirme cancelarlas (cancelar_suscripciones: true) para continuar con la eliminación."
        ),
        { status: 400 }
      );
    }

    if (nFactPend > 0 && !anularFacturasPendientes) {
      return NextResponse.json(
        errorResponse(
          "Hay facturas con saldo pendiente. Confirme anularlas (anular_facturas_pendientes: true) para no afectar reportería, o gestione el cobro antes de eliminar."
        ),
        { status: 400 }
      );
    }

    const now = new Date().toISOString();

    if (cancelarSuscripciones && nSuscActivas > 0) {
      const { error: errSusc } = await supabase
        .from("suscripciones")
        .update({ estado: "cancelada" })
        .eq("cliente_id", clienteId)
        .eq("empresa_id", auth.empresa_id)
        .eq("estado", "activa");

      if (errSusc) {
        return NextResponse.json(errorResponse("Error al cancelar suscripciones: " + errSusc.message), { status: 500 });
      }
    }

    if (anularFacturasPendientes && nFactPend > 0) {
      for (const f of factPend.data ?? []) {
        const { error: errF } = await supabase
          .from("facturas")
          .update({ estado: "Anulado", saldo: 0, updated_at: now })
          .eq("id", f.id)
          .eq("empresa_id", auth.empresa_id);

        if (errF) {
          return NextResponse.json(errorResponse("Error al anular facturas: " + errF.message), { status: 500 });
        }
      }
    }

    const { error: errUpdate } = await supabase
      .from("clientes")
      .update({
        deleted_at: new Date().toISOString(),
        deleted_by_user_id: auth.user.id,
        deletion_reason: deletionReason,
        updated_at: now,
      })
      .eq("id", clienteId)
      .is("deleted_at", null);

    if (errUpdate) {
      return NextResponse.json(errorResponse(errUpdate.message), { status: 500 });
    }

    return NextResponse.json(
      successResponse({
        deleted: true,
        suscripciones_canceladas: cancelarSuscripciones && nSuscActivas > 0,
        facturas_anuladas: anularFacturasPendientes && nFactPend > 0,
      })
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
