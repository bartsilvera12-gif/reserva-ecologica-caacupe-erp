import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { emitEvent, EVENT_TYPES } from "@/lib/integrations/events";
import { fechaMasDiasCalendario, fechaVencimientoSuscripcion, toCalendarDateStr } from "@/lib/fechas/calendario";
import { montosFacturaItemParaInsert } from "@/lib/facturacion/factura-item-montos";
import { parseFacturaPostTipo } from "@/lib/facturacion/factura-post-tipo";
import { obtenerSiguienteNumeroFacturaEmpresa } from "@/lib/facturacion/factura-suscripcion-servidor";


export async function GET(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const { auth, supabase } = ctx;

    const { searchParams } = new URL(request.url);
    const clienteId = searchParams.get("cliente_id");

    let query = supabase
      .from("facturas")
      .select("*")
      .eq("empresa_id", auth.empresa_id)
      .order("fecha", { ascending: false });

    if (clienteId) {
      query = query.eq("cliente_id", clienteId);
    }

    const { data, error } = await query;

    if (error) {
      return NextResponse.json(errorResponse(error.message), { status: 400 });
    }

    return NextResponse.json(successResponse(data ?? []));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const { auth, supabase } = ctx;

    const body = (await request.json()) as Record<string, unknown>;
    const cliente_id = body.cliente_id;
    const fecha = body.fecha;
    const fecha_vencimiento = body.fecha_vencimiento;
    const monto = body.monto;
    const tipo = body.tipo;
    const moneda = body.moneda;
    const descripcion_linea =
      typeof body.descripcion_linea === "string" ? body.descripcion_linea.trim() : "";
    const dia_vencimiento_susc = Number(body.dia_vencimiento);

    if (!String(cliente_id ?? "").trim()) {
      return NextResponse.json(errorResponse("cliente_id es obligatorio"), { status: 400 });
    }
    if (!fecha) {
      return NextResponse.json(errorResponse("fecha es obligatoria"), { status: 400 });
    }
    if (monto == null || Number(monto) < 0) {
      return NextResponse.json(errorResponse("monto debe ser >= 0"), { status: 400 });
    }

    const parsedTipo = parseFacturaPostTipo(tipo);
    if (!parsedTipo.ok) {
      return NextResponse.json(errorResponse(parsedTipo.error), { status: 400 });
    }
    const tipoFac = parsedTipo.tipo;

    const fechaNorm = toCalendarDateStr(String(fecha)) || String(fecha).slice(0, 10);
    let fechaVenc: string;
    if (fecha_vencimiento != null && String(fecha_vencimiento).trim() !== "") {
      fechaVenc =
        toCalendarDateStr(String(fecha_vencimiento)) || String(fecha_vencimiento).slice(0, 10);
    } else if (tipoFac === "contado") {
      fechaVenc = fechaNorm;
    } else if (tipoFac === "suscripcion") {
      /** Misma regla que emitir suscripción: día de vencimiento en el mes de emisión o mes siguiente si ya pasó. */
      const diaV = Math.min(31, Math.max(1, Number.isFinite(dia_vencimiento_susc) ? dia_vencimiento_susc : 10));
      fechaVenc = fechaVencimientoSuscripcion(fechaNorm, diaV);
    } else {
      const diasCred = Number(process.env.FACTURA_DIAS_CREDITO_DEFAULT ?? 30);
      fechaVenc = fechaMasDiasCalendario(fechaNorm, Number.isFinite(diasCred) ? diasCred : 30);
    }
    const numeroFactura = await obtenerSiguienteNumeroFacturaEmpresa(supabase, auth.empresa_id);

    const insert = {
      empresa_id: auth.empresa_id,
      cliente_id: String(cliente_id).trim(),
      numero_factura: numeroFactura,
      fecha: fechaNorm,
      fecha_vencimiento: fechaVenc,
      monto: Number(monto),
      saldo: Number(monto),
      estado: "Pendiente",
      tipo: tipoFac,
      moneda: moneda === "USD" ? "USD" : "GS",
    };

    const { data, error } = await supabase
      .from("facturas")
      .insert([insert])
      .select()
      .single();

    if (error) {
      return NextResponse.json(errorResponse(error.message), { status: 400 });
    }

    if (descripcion_linea && data?.id) {
      const mon = insert.moneda;
      const lineaUi = montosFacturaItemParaInsert({
        totalLinea: Number(monto),
        moneda: mon,
        cantidad: 1,
        precioUnitario: Number(monto),
      });
      const { error: errItem } = await supabase.from("factura_items").insert({
        factura_id: data.id,
        empresa_id: auth.empresa_id,
        descripcion: descripcion_linea,
        cantidad: 1,
        precio_unitario: lineaUi.precio_unitario,
        subtotal: lineaUi.subtotal,
        iva: lineaUi.iva,
        total: lineaUi.total,
      });
      if (errItem) {
        console.error("[api/facturas POST] factura_items:", errItem.message);
      }
    }

    console.log("[API] About to emit event");
    await emitEvent(EVENT_TYPES.factura_creada, { factura_id: data.id, cliente_id: data.cliente_id, monto: data.monto });

    return NextResponse.json(successResponse(data));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
