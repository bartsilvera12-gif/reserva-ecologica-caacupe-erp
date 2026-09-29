import { exigirSucursal, respuestaSucursalNoAsignada } from "@/lib/sucursales/filtro";
import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { marcarEstadoNc, totalNcDisponibles, saldoNetoInformativo, saldoOperativoEfectivo, esCorregidaNc, ncOrigenCompensada } from "@/lib/estado-cuenta/nc-resumen";

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
    const cxcData = (cxcQ.data ?? []) as Record<string, unknown>[];

    // Factura asociada a cada CxC (por la venta): número (FAC-xxx) para mostrar en
    // lugar del VTA interno, y estado fiscal para detectar 'Corregida NC'.
    const ventaIds = Array.from(new Set(cxcData.map((r) => (r.venta_id ? String(r.venta_id) : "")).filter(Boolean)));
    const facturaPorVenta = new Map<string, { numero: string | null; estado: string | null }>();
    if (ventaIds.length > 0) {
      const ffq = await ctx.supabase
        .from("facturas")
        .select("origen_venta_id, numero_factura, estado")
        .eq("empresa_id", empresaId)
        .in("origen_venta_id", ventaIds);
      if (ffq.error) throw new Error(ffq.error.message);
      for (const f of (ffq.data ?? []) as Record<string, unknown>[]) {
        facturaPorVenta.set(String(f.origen_venta_id), {
          numero: (f.numero_factura as string | null) ?? null,
          estado: (f.estado as string | null) ?? null,
        });
      }
    }

    let vencido = 0;
    const movimientos = cxcData.map((r) => {
      const total = Number(r.total) || 0;
      const saldo = Number(r.saldo) || 0;
      const venc = r.fecha_vencimiento ? String(r.fecha_vencimiento).slice(0, 10) : null;
      const fac = r.venta_id ? facturaPorVenta.get(String(r.venta_id)) : undefined;
      const facturaEstado = fac?.estado ?? null;
      const corregidaNc = esCorregidaNc(facturaEstado);
      // Una factura 'Corregida NC' ya no es deuda: su saldo efectivo es 0.
      const saldoEfectivo = corregidaNc ? 0 : saldo;
      const vigentePendiente = (r.estado === "pendiente" || r.estado === "parcial") && !corregidaNc;
      const vencida = vigentePendiente && venc != null && venc < hoy;
      if (vencida) vencido += saldoEfectivo;
      return {
        id: String(r.id),
        venta_id: r.venta_id ? String(r.venta_id) : null,
        numero_venta: r.numero_venta ?? null,
        numero_factura: fac?.numero ?? null,
        fecha_emision: r.fecha_emision ?? null,
        fecha_vencimiento: venc,
        total,
        cobrado: Math.round((total - saldo) * 100) / 100,
        saldo: saldoEfectivo,
        saldo_operativo: saldo,
        estado: corregidaNc ? "corregida_nc" : r.estado,
        corregida_nc: corregidaNc,
        vencida,
      };
    });

    // Saldo pendiente operativo: excluye anuladas y facturas 'Corregida NC'.
    const saldoPendiente = saldoOperativoEfectivo(
      cxcData.map((r) => ({
        saldo: Number(r.saldo) || 0,
        cxc_estado: (r.estado as string | null) ?? null,
        factura_estado: (r.venta_id ? facturaPorVenta.get(String(r.venta_id))?.estado : null) ?? null,
      }))
    );

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

    // Factura de origen de cada NC (número + estado + venta, para conciliar).
    const ncFacturaIds = Array.from(
      new Set(ncRows.map((n) => (n.factura_id ? String(n.factura_id) : "")).filter(Boolean))
    );
    const ncFacturaPorId = new Map<string, { numero: string | null; estado: string | null; ventaId: string | null }>();
    if (ncFacturaIds.length > 0) {
      const fq = await ctx.supabase
        .from("facturas")
        .select("id, numero_factura, estado, origen_venta_id")
        .eq("empresa_id", empresaId)
        .in("id", ncFacturaIds);
      if (fq.error) throw new Error(fq.error.message);
      for (const f of (fq.data ?? []) as Record<string, unknown>[]) {
        ncFacturaPorId.set(String(f.id), {
          numero: (f.numero_factura as string | null) ?? null,
          estado: (f.estado as string | null) ?? null,
          ventaId: (f.origen_venta_id as string | null) ?? null,
        });
      }
    }
    // Saldo operativo (CxC) por venta, para saber si la NC compensa una deuda
    // vigente. Una NC se considera 'aplicada' (no cuenta como crédito disponible)
    // solo si su factura está 'Corregida NC' Y su CxC todavía tiene saldo > 0
    // (compensó una deuda pendiente). Si la factura ya se pagó (saldo 0), la NC
    // es un crédito a favor real y SÍ cuenta como disponible.
    const cxcSaldoPorVenta = new Map<string, number>();
    for (const r of cxcData) {
      if (r.venta_id) cxcSaldoPorVenta.set(String(r.venta_id), Number(r.saldo) || 0);
    }

    const notas_credito = marcarEstadoNc(
      ncRows.map((n) => {
        const fac = n.factura_id ? ncFacturaPorId.get(String(n.factura_id)) : undefined;
        const saldoCxcOrigen = fac?.ventaId ? cxcSaldoPorVenta.get(fac.ventaId) ?? 0 : 0;
        return {
          numero: (n.numero as number | string | null) ?? null,
          factura_origen: fac?.numero ?? null,
          monto: Number(n.monto) || 0,
          saldo_disponible: Number(n.saldo_disponible) || 0,
          origen_corregida: ncOrigenCompensada(fac?.estado, saldoCxcOrigen),
        };
      })
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
