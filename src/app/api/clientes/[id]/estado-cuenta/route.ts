import { exigirSucursal, respuestaSucursalNoAsignada } from "@/lib/sucursales/filtro";
import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { marcarEstadoNc, totalNcDisponibles, saldoNetoInformativo } from "@/lib/estado-cuenta/nc-resumen";

/**
 * GET /api/clientes/[id]/estado-cuenta — resumen + cuentas por cobrar + cobros del cliente.
 * Solo lectura. No toca ventas/stock.
 */
export async function GET(request: NextRequest, ctxParams: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctxParams.params;
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const empresaId = ctx.auth.empresa_id;
    const hoy = new Date().toISOString().slice(0, 10);

    const cq = await ctx.supabase
      .from("clientes")
      .select("id, empresa, nombre_contacto, nombre, ruc, documento, telefono, direccion")
      .eq("empresa_id", empresaId)
      .eq("id", id)
      .maybeSingle();
    if (cq.error) throw new Error(cq.error.message);
    if (!cq.data) return NextResponse.json(errorResponse(API_ERRORS.NOT_FOUND), { status: 404 });
    const c = cq.data as Record<string, unknown>;
    const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const cliente = {
      id: String(c.id),
      nombre: s(c.empresa) || s(c.nombre_contacto) || s(c.nombre) || "Cliente",
      ruc: s(c.ruc) || s(c.documento) || null,
      telefono: s(c.telefono) || null,
      direccion: s(c.direccion) || null,
    };

    // Ventas del cliente → total vendido.
    const vq = await ctx.supabase
      .from("ventas")
      .select("total")
      .eq("empresa_id", empresaId)
      .eq("sucursal_id", exigirSucursal(ctx.auth.sucursal_id))
      .eq("cliente_id", id);
    if (vq.error) throw new Error(vq.error.message);
    const totalVendido = ((vq.data ?? []) as Record<string, unknown>[]).reduce((acc, r) => acc + (Number(r.total) || 0), 0);

    // Cuentas por cobrar (movimientos de crédito).
    const cxcQ = await ctx.supabase
      .from("cuentas_por_cobrar")
      .select("id, venta_id, numero_venta, fecha_emision, fecha_vencimiento, moneda, total, saldo, estado")
      .eq("empresa_id", empresaId)
      .eq("sucursal_id", exigirSucursal(ctx.auth.sucursal_id))
      .eq("cliente_id", id)
      .order("fecha_emision", { ascending: false });
    if (cxcQ.error) throw new Error(cxcQ.error.message);
    let saldoPendiente = 0;
    let vencido = 0;
    const movimientos = ((cxcQ.data ?? []) as Record<string, unknown>[]).map((r) => {
      const total = Number(r.total) || 0;
      const saldo = Number(r.saldo) || 0;
      const venc = r.fecha_vencimiento ? String(r.fecha_vencimiento).slice(0, 10) : null;
      const vigentePendiente = r.estado === "pendiente" || r.estado === "parcial";
      if (r.estado !== "anulado") saldoPendiente += saldo;
      const vencida = vigentePendiente && venc != null && venc < hoy;
      if (vencida) vencido += saldo;
      return {
        id: String(r.id),
        venta_id: r.venta_id ? String(r.venta_id) : null,
        numero_venta: r.numero_venta ?? null,
        fecha_emision: r.fecha_emision ?? null,
        fecha_vencimiento: venc,
        total,
        cobrado: Math.round((total - saldo) * 100) / 100,
        saldo,
        estado: r.estado,
        vencida,
      };
    });

    // Historial de cobros del cliente.
    const cobQ = await ctx.supabase
      .from("cobros_clientes")
      .select("id, cuenta_por_cobrar_id, venta_id, fecha_pago, monto, metodo_pago, referencia")
      .eq("empresa_id", empresaId)
      .eq("sucursal_id", exigirSucursal(ctx.auth.sucursal_id))
      .eq("cliente_id", id)
      .order("fecha_pago", { ascending: false })
      .limit(500);
    if (cobQ.error) throw new Error(cobQ.error.message);
    const cobros = (cobQ.data ?? []) as Record<string, unknown>[];

    // Notas de crédito APROBADAS del cliente (créditos a favor). Son a nivel
    // cliente: reducen la deuda al aplicarse en un cobro. Acá solo se listan para
    // que el cliente pueda conciliar; NO se toca ningún saldo.
    const ncQ = await ctx.supabase
      .from("nota_credito")
      .select("numero, monto, saldo_disponible, factura_id")
      .eq("empresa_id", empresaId)
      .eq("cliente_id", id)
      .eq("estado_erp", "aprobada")
      .order("created_at", { ascending: true });
    if (ncQ.error) throw new Error(ncQ.error.message);
    const ncRows = (ncQ.data ?? []) as Record<string, unknown>[];

    // Número de la factura de origen de cada NC (para conciliar).
    const facturaIds = Array.from(
      new Set(ncRows.map((n) => (n.factura_id ? String(n.factura_id) : "")).filter(Boolean))
    );
    const facturaNumeroPorId = new Map<string, string>();
    if (facturaIds.length > 0) {
      const fq = await ctx.supabase
        .from("facturas")
        .select("id, numero_factura")
        .eq("empresa_id", empresaId)
        .in("id", facturaIds);
      if (fq.error) throw new Error(fq.error.message);
      for (const f of (fq.data ?? []) as Record<string, unknown>[]) {
        facturaNumeroPorId.set(String(f.id), String(f.numero_factura ?? ""));
      }
    }

    const notas_credito = marcarEstadoNc(
      ncRows.map((n) => ({
        numero: (n.numero as number | string | null) ?? null,
        factura_origen: n.factura_id ? facturaNumeroPorId.get(String(n.factura_id)) ?? null : null,
        monto: Number(n.monto) || 0,
        saldo_disponible: Number(n.saldo_disponible) || 0,
      }))
    );
    const ncDisponibles = totalNcDisponibles(notas_credito);
    const saldoNeto = saldoNetoInformativo(saldoPendiente, ncDisponibles);

    const resumen = {
      total_vendido: Math.round(totalVendido),
      saldo_pendiente: Math.round(saldoPendiente),
      total_cobrado: Math.round(totalVendido - saldoPendiente),
      vencido: Math.round(vencido),
      // Conciliación de NC (informativo; no cambia el saldo operativo).
      saldo_operativo: Math.round(saldoPendiente),
      nc_disponibles: Math.round(ncDisponibles),
      saldo_neto: Math.round(saldoNeto),
    };

    return NextResponse.json(successResponse({ cliente, resumen, movimientos, cobros, notas_credito }));
  } catch (err) {
    console.error("[/api/clientes/[id]/estado-cuenta GET]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo cargar el estado de cuenta."), { status: 500 });
  }
}
