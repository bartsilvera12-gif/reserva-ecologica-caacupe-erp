import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { anularVentaCore, ventaTieneCobrosAplicados } from "@/lib/ventas/server/anular-venta-core";
import { marcarDesfacturadoPorAnulacion } from "@/lib/caja/facturacion";

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
    // Si tiene factura ERP asociada, verificar el estado SIFEN:
    //  - aprobado / enviado / en_proceso  → bloquear y redirigir al panel SIFEN
    //    (esas se cancelan via SET; el DE ya está en el sistema fiscal).
    //  - borrador / generado / firmado / error_envio / rechazado / cancelado /
    //    sin factura_electronica → permitir y también marcar la factura ERP
    //    como anulada (el DE nunca llegó a SET o quedó en falla local).
    let facturaEDescartar: { facturaId: string; feId: string | null } | null = null;
    if (head.factura_id) {
      const feQ = await sb
        .from("factura_electronica")
        .select("id, estado_sifen")
        .eq("empresa_id", empresaId)
        .eq("factura_id", head.factura_id)
        .maybeSingle();
      if (feQ.error) {
        return NextResponse.json(errorResponse(feQ.error.message), { status: 400 });
      }
      const feEstado = (feQ.data as { id?: string; estado_sifen?: string } | null)?.estado_sifen ?? null;
      const bloqueaSet =
        feEstado === "aprobado" || feEstado === "enviado" || feEstado === "en_proceso";
      if (bloqueaSet) {
        return NextResponse.json(
          errorResponse(
            "Esta venta tiene una factura electrónica ya enviada / aprobada por la SET. Cancelala desde el detalle de la factura (SIFEN); la venta se anula automáticamente."
          ),
          { status: 409 }
        );
      }
      facturaEDescartar = {
        facturaId: head.factura_id,
        feId: (feQ.data as { id?: string } | null)?.id ?? null,
      };
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

    // Best-effort: si la venta tenía factura ERP no-aceptada, descartarla también.
    // La venta ya está anulada; si esta parte falla, se logea nomás.
    let factura_descartada = false;
    if (facturaEDescartar) {
      try {
        const nowIso = new Date().toISOString();
        const uf = await sb
          .from("facturas")
          .update({ estado: "anulada", saldo: 0, updated_at: nowIso })
          .eq("empresa_id", empresaId)
          .eq("id", facturaEDescartar.facturaId);
        if (uf.error) {
          console.error("[anular venta] no se pudo marcar factura anulada", {
            facturaId: facturaEDescartar.facturaId,
            error: uf.error.message,
          });
        } else {
          factura_descartada = true;
        }
        if (facturaEDescartar.feId) {
          const ufe = await sb
            .from("factura_electronica")
            .update({ estado_sifen: "cancelado", updated_at: nowIso })
            .eq("empresa_id", empresaId)
            .eq("id", facturaEDescartar.feId);
          if (ufe.error) {
            console.error("[anular venta] no se pudo marcar factura_electronica cancelada", {
              feId: facturaEDescartar.feId,
              error: ufe.error.message,
            });
          }
        }
      } catch (e) {
        console.error("[anular venta] excepción descartando factura", { e });
      }
    }

    // Best-effort: si la venta vino de un pedido (proyecto), revertir su
    // metadata a 'pendiente_caja' para que reaparezca en el chip de Caja y
    // se pueda facturar de nuevo. La detección es por metadata.venta_id ===
    // ventaId (que fue seteado en /api/ventas/create al marcar el pedido
    // como facturado). Si la venta no vino de un pedido, esta query no
    // encuentra nada y se salta silenciosamente.
    let pedido_reactivado_id: string | null = null;
    try {
      const nowIso = new Date().toISOString();
      const pq = await sb
        .from("proyectos")
        .select("id, metadata")
        .eq("empresa_id", empresaId)
        .eq("metadata->>venta_id", ventaId)
        .eq("metadata->>facturacion_estado", "facturado")
        .limit(1);
      if (pq.error) {
        console.error("[anular venta] no se pudo buscar pedido origen", {
          error: pq.error.message,
        });
      } else {
        const rows = (pq.data ?? []) as Array<{ id: string; metadata: unknown }>;
        if (rows.length > 0) {
          const proy = rows[0]!;
          const nuevaMeta = marcarDesfacturadoPorAnulacion(
            proy.metadata,
            nowIso,
            res.numeroControl ?? null
          );
          const upd = await sb
            .from("proyectos")
            .update({
              metadata: nuevaMeta,
              last_activity_at: nowIso,
              ultimo_movimiento_at: nowIso,
            })
            .eq("empresa_id", empresaId)
            .eq("id", proy.id);
          if (upd.error) {
            console.error("[anular venta] no se pudo re-activar pedido en caja", {
              pedidoId: proy.id,
              error: upd.error.message,
            });
          } else {
            pedido_reactivado_id = proy.id;
          }
        }
      }
    } catch (e) {
      console.error("[anular venta] excepción reactivando pedido", { e });
    }

    return NextResponse.json(
      successResponse({
        venta: { id: ventaId, estado: "anulada", numero_control: res.numeroControl },
        stock_reintegrado: res.stockReintegrado,
        ya_estaba_anulada: res.alreadyAnulada,
        factura_descartada,
        pedido_reactivado_id,
      })
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
