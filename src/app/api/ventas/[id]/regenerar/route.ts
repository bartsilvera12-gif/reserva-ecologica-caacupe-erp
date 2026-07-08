import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import {
  createVentaTransaccionalPg,
  StockInsuficienteError,
  type CreateVentaItemInput,
} from "@/lib/ventas/server/create-venta-pg";

/**
 * POST /api/ventas/[id]/regenerar
 *
 * Clona una venta anulada en una nueva venta con los mismos items, cliente,
 * moneda, tipo de venta y método de pago. Reutiliza `createVentaTransaccionalPg`,
 * así el puente venta→factura (FAC-XXXXXX + factura_electronica) se dispara
 * igual que en una venta normal.
 *
 * Restricciones:
 *  - La venta origen debe estar en estado 'anulada'.
 *  - Requiere que cada línea original tenga producto_id (para descontar stock).
 *  - Si la venta origen es CREDITO, exige cliente (mismo criterio que crear).
 *
 * NO toca la venta anulada ni su factura anulada — solo crea una nueva.
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

    // Cabecera de la venta origen
    const vQ = await sb
      .from("ventas")
      .select(
        "id, numero_control, estado, cliente_id, moneda, tipo_cambio, tipo_venta, plazo_dias, metodo_pago, subtotal, monto_iva, total, genera_nota_remision"
      )
      .eq("empresa_id", empresaId)
      .eq("id", id)
      .maybeSingle();
    if (vQ.error) throw new Error(vQ.error.message);
    if (!vQ.data) {
      return NextResponse.json(errorResponse("Venta no encontrada."), { status: 404 });
    }
    const venta = vQ.data as {
      id: string;
      numero_control: string;
      estado: string;
      cliente_id: string | null;
      moneda: string;
      tipo_cambio: number | string | null;
      tipo_venta: string;
      plazo_dias: number | null;
      metodo_pago: string | null;
      subtotal: number | string;
      monto_iva: number | string;
      total: number | string;
      genera_nota_remision?: boolean | null;
    };

    if (venta.estado !== "anulada") {
      return NextResponse.json(
        errorResponse("Solo se pueden regenerar ventas anuladas."),
        { status: 409 }
      );
    }

    // Items de la venta origen
    const iQ = await sb
      .from("ventas_items")
      .select(
        "producto_id, producto_nombre, sku, cantidad, precio_venta_original, precio_venta, tipo_iva, tipo_precio, subtotal, monto_iva, total_linea"
      )
      .eq("empresa_id", empresaId)
      .eq("venta_id", id);
    if (iQ.error) throw new Error(iQ.error.message);
    const itemsRows = (iQ.data ?? []) as Record<string, unknown>[];
    if (itemsRows.length === 0) {
      return NextResponse.json(
        errorResponse("La venta anulada no tiene ítems para regenerar."),
        { status: 400 }
      );
    }
    const sinProducto = itemsRows.filter((it) => !it.producto_id);
    if (sinProducto.length > 0) {
      return NextResponse.json(
        errorResponse(
          "La venta tiene ítems sin producto vinculado; no se puede regenerar automáticamente."
        ),
        { status: 400 }
      );
    }

    const items: CreateVentaItemInput[] = itemsRows.map((it) => ({
      producto_id: String(it.producto_id),
      producto_nombre: String(it.producto_nombre ?? ""),
      sku: String(it.sku ?? ""),
      cantidad: Number(it.cantidad) || 0,
      precio_venta_original: Number(it.precio_venta_original) || Number(it.precio_venta) || 0,
      precio_venta: Number(it.precio_venta) || 0,
      tipo_iva: (String(it.tipo_iva ?? "10%") as "EXENTA" | "5%" | "10%"),
      tipo_precio:
        (String(it.tipo_precio ?? "minorista") as "minorista" | "mayorista" | "distribuidor" | "costo"),
      subtotal: Number(it.subtotal) || 0,
      monto_iva: Number(it.monto_iva) || 0,
      total_linea: Number(it.total_linea) || 0,
    }));

    const subtotal = items.reduce((s, it) => s + it.subtotal, 0);
    const montoIva = items.reduce((s, it) => s + it.monto_iva, 0);
    const total = items.reduce((s, it) => s + it.total_linea, 0);

    const schema = await fetchDataSchemaForEmpresaId(empresaId);
    const moneda = (venta.moneda === "USD" ? "USD" : "GS") as "GS" | "USD";
    const tipoVenta = (venta.tipo_venta === "CREDITO" ? "CREDITO" : "CONTADO") as
      | "CONTADO"
      | "CREDITO";
    const metodoPago = (() => {
      const m = venta.metodo_pago;
      if (m === "tarjeta" || m === "transferencia" || m === "efectivo") return m;
      return null;
    })();

    try {
      const {
        ventaId,
        numeroControl,
        facturaId,
        numeroFactura,
        facturaWarning,
      } = await createVentaTransaccionalPg({
        schema,
        empresaId,
        clienteId: venta.cliente_id,
        observaciones: `Regenerada desde ${venta.numero_control} (anulada).`,
        moneda,
        tipoCambio: Number(venta.tipo_cambio) || 1,
        tipoVenta,
        plazoDias: tipoVenta === "CREDITO" ? venta.plazo_dias ?? null : null,
        metodoPago,
        items,
        subtotalDeclarado: subtotal,
        montoIvaDeclarado: montoIva,
        totalDeclarado: total,
        generaNotaRemision: venta.genera_nota_remision === true,
        emitirFactura: true,
        createdBy: auth.usuarioCatalogId ?? null,
        usuarioNombre: auth.user?.email ?? null,
      });

      return NextResponse.json(
        successResponse({
          origen: { id: venta.id, numero_control: venta.numero_control },
          venta: { id: ventaId, numero_control: numeroControl },
          factura: facturaId
            ? { id: facturaId, numero_factura: numeroFactura ?? null }
            : null,
          factura_warning: facturaWarning ?? null,
        })
      );
    } catch (err) {
      if (err instanceof StockInsuficienteError) {
        return NextResponse.json(
          {
            ...errorResponse("Stock insuficiente: requiere confirmación."),
            faltantes: err.faltantes,
          },
          { status: 409 }
        );
      }
      throw err;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudo regenerar la venta.";
    console.error("[/api/ventas/[id]/regenerar]", msg);
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
