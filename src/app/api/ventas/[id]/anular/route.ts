import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";

/**
 * POST /api/ventas/[id]/anular
 *
 * Anulación de una venta (ticket no fiscal). Efectos:
 *   1) Reintegra stock: por cada `movimientos_inventario` SALIDA con `venta_id`,
 *      suma la cantidad al `productos.stock_actual` e inserta un movimiento
 *      ENTRADA (`origen='anulacion_venta'`) como contraparte auditable.
 *   2) Si la venta tiene `cuentas_por_cobrar` sin cobros aplicados, la marca
 *      `estado='anulado'`, `saldo=0`. Si tiene cobros, bloquea la anulación.
 *   3) Marca `ventas.estado='anulada'`, `anulada_at`, `anulada_por`, `anulacion_motivo`.
 *
 * NO toca facturas SIFEN (son un flujo aparte con su propio ciclo).
 */

function trimMotivo(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  return s.length > 0 ? s : null;
}

interface MovimientoRow {
  id: string;
  producto_id: string;
  producto_nombre: string;
  producto_sku: string;
  cantidad: number | string;
  costo_unitario: number | string;
  tipo: string;
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

    // 1) Cargar la venta y bloquear si ya está anulada.
    const ventaQ = await sb
      .from("ventas")
      .select("id, estado, numero_control, fecha, tipo_venta")
      .eq("id", ventaId)
      .eq("empresa_id", empresaId)
      .maybeSingle();
    if (ventaQ.error) {
      return NextResponse.json(errorResponse(ventaQ.error.message), { status: 400 });
    }
    if (!ventaQ.data) {
      return NextResponse.json(errorResponse("Venta no encontrada."), { status: 404 });
    }
    const venta = ventaQ.data as { id: string; estado: string; numero_control: string; fecha: string; tipo_venta: string };
    if (venta.estado === "anulada") {
      return NextResponse.json(errorResponse("La venta ya fue anulada."), { status: 409 });
    }

    // 2) Si es CRÉDITO, verificar cuentas_por_cobrar y cobros aplicados.
    let cxcId: string | null = null;
    if (venta.tipo_venta === "CREDITO") {
      const cxcQ = await sb
        .from("cuentas_por_cobrar")
        .select("id, saldo, total, estado")
        .eq("venta_id", ventaId)
        .eq("empresa_id", empresaId)
        .maybeSingle();
      if (cxcQ.error) {
        return NextResponse.json(errorResponse(cxcQ.error.message), { status: 400 });
      }
      if (cxcQ.data) {
        const cxc = cxcQ.data as { id: string; saldo: number | string; total: number | string; estado: string };
        cxcId = cxc.id;
        // Si el saldo es menor al total, hubo cobros → bloquear.
        const saldo = Number(cxc.saldo);
        const total = Number(cxc.total);
        if (Number.isFinite(saldo) && Number.isFinite(total) && saldo < total) {
          return NextResponse.json(
            errorResponse(
              "La venta tiene cobros aplicados sobre su cuenta por cobrar. Reversá los cobros antes de anular."
            ),
            { status: 409 }
          );
        }
      }
    }

    // 3) Cargar movimientos SALIDA originados por esta venta (productos + insumos por receta).
    const movsQ = await sb
      .from("movimientos_inventario")
      .select("id, producto_id, producto_nombre, producto_sku, cantidad, costo_unitario, tipo")
      .eq("venta_id", ventaId)
      .eq("empresa_id", empresaId)
      .eq("tipo", "SALIDA");
    if (movsQ.error) {
      return NextResponse.json(errorResponse(movsQ.error.message), { status: 400 });
    }
    const movs = (movsQ.data ?? []) as MovimientoRow[];

    const nowIso = new Date().toISOString();
    const referencia = `Anulación ${venta.numero_control}`;

    // 4) Reintegro de stock + movimiento ENTRADA contraparte por cada SALIDA.
    // Best-effort: rastreamos los movimientos ENTRADA insertados y los stock previos para rollback.
    const entradasInsertadas: string[] = [];
    const stockPrevio: Array<{ producto_id: string; stock_actual: number }> = [];

    try {
      for (const m of movs) {
        const cantidad = Number(m.cantidad);
        if (!Number.isFinite(cantidad) || cantidad <= 0) continue;

        const prodQ = await sb
          .from("productos")
          .select("id, stock_actual")
          .eq("id", m.producto_id)
          .eq("empresa_id", empresaId)
          .maybeSingle();
        if (prodQ.error) throw new Error(prodQ.error.message);
        if (!prodQ.data) continue; // producto borrado: reintegro no aplica.
        const prod = prodQ.data as { id: string; stock_actual: number | string };
        const stockActual = Number(prod.stock_actual);
        const nuevoStock = stockActual + cantidad;

        const upd = await sb
          .from("productos")
          .update({ stock_actual: nuevoStock })
          .eq("id", m.producto_id)
          .eq("empresa_id", empresaId);
        if (upd.error) throw new Error(upd.error.message);
        stockPrevio.push({ producto_id: m.producto_id, stock_actual: stockActual });

        const ins = await sb
          .from("movimientos_inventario")
          .insert({
            empresa_id: empresaId,
            producto_id: m.producto_id,
            producto_nombre: m.producto_nombre,
            producto_sku: m.producto_sku,
            tipo: "ENTRADA",
            cantidad,
            costo_unitario: Number(m.costo_unitario) || 0,
            origen: "anulacion_venta",
            referencia,
            fecha: nowIso,
            venta_id: ventaId,
          })
          .select("id")
          .single();
        if (ins.error) throw new Error(ins.error.message);
        entradasInsertadas.push(String((ins.data as { id: string }).id));
      }

      // 5) Anular la cuenta por cobrar (si aplica y no tenía cobros).
      if (cxcId) {
        const updCxc = await sb
          .from("cuentas_por_cobrar")
          .update({ estado: "anulado", saldo: 0 })
          .eq("id", cxcId)
          .eq("empresa_id", empresaId);
        if (updCxc.error) throw new Error(updCxc.error.message);
      }

      // 6) Marcar la venta como anulada.
      const updVenta = await sb
        .from("ventas")
        .update({
          estado: "anulada",
          anulada_at: nowIso,
          anulada_por: userId,
          anulacion_motivo: motivo,
        })
        .eq("id", ventaId)
        .eq("empresa_id", empresaId)
        .select("id, estado, anulada_at, anulacion_motivo")
        .single();
      if (updVenta.error) throw new Error(updVenta.error.message);

      return NextResponse.json(
        successResponse({
          venta: updVenta.data,
          stock_reintegrado: entradasInsertadas.length,
        })
      );
    } catch (e) {
      // Rollback best-effort: revertir stock y borrar entradas insertadas.
      for (const s of stockPrevio) {
        try {
          await sb
            .from("productos")
            .update({ stock_actual: s.stock_actual })
            .eq("id", s.producto_id)
            .eq("empresa_id", empresaId);
        } catch {}
      }
      if (entradasInsertadas.length > 0) {
        try {
          await sb
            .from("movimientos_inventario")
            .delete()
            .in("id", entradasInsertadas)
            .eq("empresa_id", empresaId);
        } catch {}
      }
      const msg = e instanceof Error ? e.message : "Error al anular la venta.";
      return NextResponse.json(errorResponse(msg), { status: 500 });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
