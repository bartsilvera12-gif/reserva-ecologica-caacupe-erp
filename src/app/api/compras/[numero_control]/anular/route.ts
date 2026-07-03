import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";

/**
 * POST /api/compras/[numero_control]/anular
 *
 * Anulación de una compra multi-línea (todas las filas comparten `numero_control`):
 *   1) Reintegra en reverso el stock: por cada línea, resta la cantidad al
 *      producto e inserta un movimiento SALIDA (`origen='anulacion_compra'`) como
 *      contraparte auditable del ENTRADA original de la compra.
 *   2) Marca `compras.estado='anulada'` en todas las filas del `numero_control`
 *      con la trazabilidad (anulada_at, anulada_por, anulacion_motivo).
 *
 * Alcance: NO revierte `productos.costo_promedio` ni `precio_venta` (pueden haber
 * cambiado con compras/movimientos posteriores). Si eso hace falta, corregir
 * manualmente desde inventario. Sin cuentas_por_pagar todavía en este ERP, los
 * pagos a proveedores se manejan por separado.
 */

function trimMotivo(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  return s.length > 0 ? s : null;
}

interface CompraRow {
  id: string;
  producto_id: string;
  producto_nombre: string;
  cantidad: number | string;
  costo_unitario: number | string;
  estado: string | null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ numero_control: string }> }
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

    const { numero_control } = await params;
    const numero = decodeURIComponent(numero_control ?? "").trim();
    if (!numero) {
      return NextResponse.json(errorResponse("numero_control es obligatorio"), { status: 400 });
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

    // 1) Cargar todas las filas de la compra.
    const filasQ = await sb
      .from("compras")
      .select("id, producto_id, producto_nombre, cantidad, costo_unitario, estado")
      .eq("empresa_id", empresaId)
      .eq("numero_control", numero);
    if (filasQ.error) {
      return NextResponse.json(errorResponse(filasQ.error.message), { status: 400 });
    }
    const filas = (filasQ.data ?? []) as CompraRow[];
    if (filas.length === 0) {
      return NextResponse.json(errorResponse("Compra no encontrada."), { status: 404 });
    }
    if (filas.every((f) => f.estado === "anulada")) {
      return NextResponse.json(errorResponse("La compra ya fue anulada."), { status: 409 });
    }

    const nowIso = new Date().toISOString();
    const referencia = `Anulación ${numero}`;

    const salidasInsertadas: string[] = [];
    const stockPrevio: Array<{ producto_id: string; stock_actual: number }> = [];

    try {
      // 2) Por cada fila que no esté ya anulada, reintegrar en reverso stock + insertar SALIDA.
      for (const f of filas) {
        if (f.estado === "anulada") continue;
        const cantidad = Number(f.cantidad);
        if (!Number.isFinite(cantidad) || cantidad <= 0) continue;

        const prodQ = await sb
          .from("productos")
          .select("id, stock_actual, sku")
          .eq("id", f.producto_id)
          .eq("empresa_id", empresaId)
          .maybeSingle();
        if (prodQ.error) throw new Error(prodQ.error.message);
        if (!prodQ.data) continue; // producto borrado.
        const prod = prodQ.data as { id: string; stock_actual: number | string; sku: string | null };
        const stockActual = Number(prod.stock_actual);
        // Nunca dejamos stock negativo: si la compra ya se consumió, el stock queda en 0.
        const nuevoStock = Math.max(0, stockActual - cantidad);

        const upd = await sb
          .from("productos")
          .update({ stock_actual: nuevoStock })
          .eq("id", f.producto_id)
          .eq("empresa_id", empresaId);
        if (upd.error) throw new Error(upd.error.message);
        stockPrevio.push({ producto_id: f.producto_id, stock_actual: stockActual });

        const ins = await sb
          .from("movimientos_inventario")
          .insert({
            empresa_id: empresaId,
            producto_id: f.producto_id,
            producto_nombre: f.producto_nombre,
            producto_sku: prod.sku ?? "",
            tipo: "SALIDA",
            cantidad,
            costo_unitario: Number(f.costo_unitario) || 0,
            origen: "anulacion_compra",
            referencia,
            fecha: nowIso,
            created_by: movCreatedBy,
            usuario_nombre: movUsuarioNombre,
          })
          .select("id")
          .single();
        if (ins.error) throw new Error(ins.error.message);
        salidasInsertadas.push(String((ins.data as { id: string }).id));
      }

      // 3) Marcar TODAS las filas del numero_control como anuladas (trazabilidad
      //    completa aunque alguna fila ya lo estuviera).
      const updCompras = await sb
        .from("compras")
        .update({
          estado: "anulada",
          anulada_at: nowIso,
          anulada_por: userId,
          anulacion_motivo: motivo,
        })
        .eq("numero_control", numero)
        .eq("empresa_id", empresaId);
      if (updCompras.error) throw new Error(updCompras.error.message);

      return NextResponse.json(
        successResponse({
          numero_control: numero,
          filas_anuladas: filas.length,
          stock_reintegrado: salidasInsertadas.length,
        })
      );
    } catch (e) {
      // Rollback best-effort.
      for (const s of stockPrevio) {
        try {
          await sb
            .from("productos")
            .update({ stock_actual: s.stock_actual })
            .eq("id", s.producto_id)
            .eq("empresa_id", empresaId);
        } catch {}
      }
      if (salidasInsertadas.length > 0) {
        try {
          await sb
            .from("movimientos_inventario")
            .delete()
            .in("id", salidasInsertadas)
            .eq("empresa_id", empresaId);
        } catch {}
      }
      const msg = e instanceof Error ? e.message : "Error al anular la compra.";
      return NextResponse.json(errorResponse(msg), { status: 500 });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
