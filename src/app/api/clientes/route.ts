import { NextRequest, NextResponse } from "next/server";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { emitEvent, EVENT_TYPES } from "@/lib/integrations/events";
import type { TipoServicioCliente } from "@/lib/clientes/types";
import { getTenantSupabaseFromAuthWithRol } from "@/lib/supabase/tenant-api";

const TIPOS_SERVICIO_VALIDOS: TipoServicioCliente[] = ["marketing", "saas", "branding", "web", "otro"];

export async function GET() {
  try {
    const ctx = await getTenantSupabaseFromAuthWithRol();
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const { auth, supabase } = ctx;
    const { data, error } = await supabase
      .from("clientes")
      .select("*")
      .eq("empresa_id", auth.empresa_id)
      .is("deleted_at", null)
      .order("created_at", { ascending: false });

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
    const ctx = await getTenantSupabaseFromAuthWithRol();
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const { auth, supabase } = ctx;

    const body = await request.json();
    const { tipo_cliente, empresa, nombre_contacto, ruc, documento, telefono, email, direccion, ciudad, pais, condicion_pago, moneda_preferida, estado, tipo_servicio_cliente, plan_comercial_id } = body;

    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const planComercial =
      typeof plan_comercial_id === "string" && uuidRe.test(plan_comercial_id.trim()) ? plan_comercial_id.trim() : null;

    if (!nombre_contacto?.trim()) {
      return NextResponse.json(errorResponse("nombre_contacto es obligatorio"), { status: 400 });
    }

    const tipoServicio = tipo_servicio_cliente?.trim();
    if (tipoServicio && !TIPOS_SERVICIO_VALIDOS.includes(tipoServicio)) {
      return NextResponse.json(errorResponse(`tipo_servicio_cliente debe ser uno de: ${TIPOS_SERVICIO_VALIDOS.join(", ")}`), { status: 400 });
    }

    const insertBase = {
      empresa_id:           auth.empresa_id,
      created_by_user_id:    auth.user.id,
      created_by_nombre:     auth.nombre ?? null,
      tipo_cliente:         tipo_cliente ?? "empresa",
      tipo_servicio_cliente: tipoServicio || null,
      empresa:              empresa?.trim() || null,
      nombre:               nombre_contacto.trim(),
      nombre_contacto:      nombre_contacto.trim(),
      ruc:                  ruc?.trim() || null,
      documento:            documento?.trim() || null,
      telefono:             telefono?.trim() || null,
      email:                email?.trim() || null,
      direccion:            direccion?.trim() || null,
      ciudad:               ciudad?.trim() || null,
      pais:                 pais?.trim() || null,
      condicion_pago:       condicion_pago?.trim() || null,
      moneda_preferida:     moneda_preferida === "USD" ? "USD" : "GS",
      estado:               estado === "inactivo" ? "inactivo" : "activo",
    };

    const rowWithPlan =
      planComercial ? { ...insertBase, plan_comercial_id: planComercial } : insertBase;

    let { data, error } = await supabase.from("clientes").insert([rowWithPlan]).select().single();

    // Si falla con plan (columna sin migrar, caché PostgREST, FK, etc.), reintentar sin plan_comercial_id.
    if (error && planComercial) {
      const second = await supabase.from("clientes").insert([insertBase]).select().single();
      if (!second.error) {
        data = second.data;
        error = null;
      } else {
        error = second.error;
      }
    }

    if (error) {
      return NextResponse.json(errorResponse(error.message), { status: 400 });
    }

    await emitEvent(EVENT_TYPES.cliente_creado, { cliente_id: data.id, empresa: data.empresa });

    return NextResponse.json(successResponse(data));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
