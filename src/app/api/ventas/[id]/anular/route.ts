import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { anularVentaCore, ventaTieneCobrosAplicados } from "@/lib/ventas/server/anular-venta-core";

/**
 * POST /api/ventas/[id]/anular
 *
 * Anulación de una venta desde /ventas (ventas SIN factura ERP asociada).
 *
 * Flujo:
 *   1) Bloquea si la venta ya tiene factura_id (esas se anulan cancelando el DE
 *      en SIFEN desde /facturas/[id]; el server anula la venta origen en cascada).
 *   2) Bloquea si la CxC de la venta tiene cobros aplicados.
 *   3) Delega a anularVentaCore: reintegra stock + anula CxC + estado='anulada'.
 */

function trimMotivo(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  return s.length > 0 ? s : null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const { auth, supabase: sb } = ctx;
    const empresaId = auth.empresa_id;
    const userId = auth.user.id;
    const movCreatedBy = auth.usuarioCatalogId ?? null;
    const movUsuarioNombre = auth.user?.email ?? null;

    const { id } = await params;
    const ventaId = id?.trim();
    if (!ventaId) {
      return NextResponse.json(errorResponse("id de venta es obligatorio"), { status: 400 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(errorResponse("Cuerpo JSON inválido"), { status: 400 });
    }
    const b = body != null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const motivo = trimMotivo(b.motivo);
    if (motivo == null || motivo.length < 5) {
      return NextResponse.json(
        errorResponse("motivo es obligatorio (mínimo 5 caracteres) para registrar la anulación."),
        { status: 400 }
      );
    }
    if (motivo.length > 2000) {
      return NextResponse.json(errorResponse("motivo no puede superar 2000 caracteres."), { status: 400 });
    }

    // Bloqueo 1: si tiene factura ERP asociada, redirigir al flujo SIFEN.
    const ventaHead = await sb
      .from("ventas")
      .select("id, factura_id, estado")
      .eq("id", ventaId)
      .eq("empresa_id", empresaId)
      .maybeSingle();
    if (ventaHead.error) {
      return NextResponse.json(errorResponse(ventaHead.error.message), { status: 400 });
    }
    if (!ventaHead.data) {
      return NextResponse.json(errorResponse("Venta no encontrada."), { status: 404 });
    }
    const head = ventaHead.data as { id: string; factura_id: string | null; estado: string };
    if (head.estado === "anulada") {
      return NextResponse.json(errorResponse("La venta ya fue anulada."), { status: 409 });
    }
    if (head.factura_id) {
      return NextResponse.json(
        errorResponse(
          "Esta venta tiene una factura ERP asociada. Cancelala desde el detalle de la factura (SIFEN); la venta se anula automáticamente."
        ),
        { status: 409 }
      );
    }

    // Bloqueo 2: cobros aplicados en CxC.
    if (await ventaTieneCobrosAplicados(sb, empresaId, ventaId)) {
      return NextResponse.json(
        errorResponse(
          "La venta tiene cobros aplicados sobre su cuenta por cobrar. Reversá los cobros antes de anular."
        ),
        { status: 409 }
      );
    }

    const res = await anularVentaCore({
      sb,
      empresaId,
      ventaId,
      motivo,
      userId,
      movCreatedBy,
      movUsuarioNombre,
    });
    if (!res.ok) {
      return NextResponse.json(errorResponse(res.message), { status: res.status ?? 500 });
    }
    return NextResponse.json(
      successResponse({
        venta: { id: ventaId, estado: "anulada", numero_control: res.numeroControl },
        stock_reintegrado: res.stockReintegrado,
        ya_estaba_anulada: res.alreadyAnulada,
      })
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
