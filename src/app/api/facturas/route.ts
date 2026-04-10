import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { emitEvent, EVENT_TYPES } from "@/lib/integrations/events";
import { fechaMasDiasCalendario, toCalendarDateStr } from "@/lib/fechas/calendario";


export async function GET(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth();
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
    const ctx = await getTenantSupabaseFromAuth();
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const { auth, supabase } = ctx;

    const body = await request.json();
    const { cliente_id, numero_factura, fecha, fecha_vencimiento, monto, tipo, moneda } = body;

    if (!cliente_id?.trim()) {
      return NextResponse.json(errorResponse("cliente_id es obligatorio"), { status: 400 });
    }
    if (!numero_factura?.trim()) {
      return NextResponse.json(errorResponse("numero_factura es obligatorio"), { status: 400 });
    }
    if (!fecha) {
      return NextResponse.json(errorResponse("fecha es obligatoria"), { status: 400 });
    }
    if (monto == null || Number(monto) < 0) {
      return NextResponse.json(errorResponse("monto debe ser >= 0"), { status: 400 });
    }

    const tipoFac = tipo === "contado" || tipo === "credito" || tipo === "suscripcion" ? tipo : "credito";
    const fechaNorm = toCalendarDateStr(String(fecha)) || String(fecha).slice(0, 10);
    let fechaVenc: string;
    if (fecha_vencimiento) {
      fechaVenc = toCalendarDateStr(String(fecha_vencimiento)) || String(fecha_vencimiento).slice(0, 10);
    } else if (tipoFac === "contado") {
      fechaVenc = fechaNorm;
    } else if (tipoFac === "credito") {
      const diasCred = Number(process.env.FACTURA_DIAS_CREDITO_DEFAULT ?? 30);
      fechaVenc = fechaMasDiasCalendario(fechaNorm, Number.isFinite(diasCred) ? diasCred : 30);
    } else {
      fechaVenc = fechaNorm;
    }
    const insert = {
      empresa_id: auth.empresa_id,
      cliente_id: cliente_id.trim(),
      numero_factura: numero_factura.trim(),
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

    console.log("[API] About to emit event");
    await emitEvent(EVENT_TYPES.factura_creada, { factura_id: data.id, cliente_id: data.cliente_id, monto: data.monto });

    return NextResponse.json(successResponse(data));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
