import { NextRequest, NextResponse } from "next/server";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { emitEvent, EVENT_TYPES } from "@/lib/integrations/events";
import type { TipoServicioCliente } from "@/lib/clientes/types";
import type { AppSupabaseClient } from "@/lib/supabase/schema";
import { getTenantSupabaseFromAuthWithRol } from "@/lib/supabase/tenant-api";

const TIPOS_SERVICIO_VALIDOS: TipoServicioCliente[] = ["marketing", "saas", "branding", "web", "otro"];

/** Une `plan_activo` (nombre) a cada fila de cliente según suscripción activa más reciente. */
function attachPlanesActivos(
  rows: Record<string, unknown>[],
  map: Map<string, string>
): void {
  for (const r of rows) {
    const id = typeof r.id === "string" ? r.id : null;
    if (!id) continue;
    const nombre = map.get(id);
    if (nombre) r.plan_activo = nombre;
  }
}

async function buildPlanActivoMap(
  supabase: AppSupabaseClient,
  empresaId: string,
  clienteIds: string[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (clienteIds.length === 0) return map;

  const { data, error } = await supabase
    .from("suscripciones")
    .select("cliente_id, planes(nombre)")
    .eq("empresa_id", empresaId)
    .eq("estado", "activa")
    .in("cliente_id", clienteIds)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[api/clientes] buildPlanActivoMap:", error.message);
    return map;
  }

  for (const row of data ?? []) {
    const cid = (row as { cliente_id: string }).cliente_id;
    if (!map.has(cid)) {
      const planes = (row as { planes: { nombre: string } | { nombre: string }[] | null }).planes;
      const plan = Array.isArray(planes) ? planes[0] : planes;
      const nombre = plan?.nombre?.trim();
      map.set(cid, nombre || "Suscripción");
    }
  }
  return map;
}

export async function GET(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuthWithRol(request);
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const { auth, supabase } = ctx;
    const sp = request.nextUrl.searchParams;
    const incluirEliminados = sp.get("incluir_eliminados") === "1";
    const planActivo = sp.get("plan_activo") === "1";

    let q = supabase
      .from("clientes")
      .select("*")
      .eq("empresa_id", auth.empresa_id)
      .order("created_at", { ascending: false });
    if (!incluirEliminados) {
      q = q.is("deleted_at", null);
    }

    const { data, error } = await q;

    if (error) {
      return NextResponse.json(errorResponse(error.message), { status: 400 });
    }

    const rows = (data ?? []) as Record<string, unknown>[];
    if (planActivo && rows.length > 0) {
      const ids = rows.map((r) => r.id).filter((id): id is string => typeof id === "string");
      const planMap = await buildPlanActivoMap(supabase, auth.empresa_id, ids);
      attachPlanesActivos(rows, planMap);
    }

    return NextResponse.json(successResponse(rows));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuthWithRol(request);
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
