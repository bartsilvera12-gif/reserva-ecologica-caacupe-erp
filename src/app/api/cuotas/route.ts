import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import {
  crearPlanCuotas,
  listarPlanCuotas,
  eliminarPlanCuotas,
  CuotaError,
} from "@/lib/cuotas/server/cuotas-pg";
import type { CuotaPlanInput } from "@/lib/cuotas/cuotas-domain";

/** GET /api/cuotas?tipo=cobrar|pagar&cuentaId=<uuid> — plan de una cuenta. */
export async function GET(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const empresaId = ctx.auth.empresa_id;
    const schemaRaw = await fetchDataSchemaForEmpresaId(empresaId);
    const url = new URL(request.url);
    const tipo = (url.searchParams.get("tipo") ?? "").trim();
    const cuentaId = (url.searchParams.get("cuentaId") ?? "").trim();
    if (!cuentaId) return NextResponse.json(errorResponse("cuentaId es obligatorio."), { status: 400 });

    const plan = await listarPlanCuotas({ schemaRaw, empresaId, tipo, cuentaId });
    return NextResponse.json(successResponse(plan));
  } catch (err) {
    if (err instanceof CuotaError) {
      return NextResponse.json(errorResponse(err.message), { status: err.status });
    }
    console.error("[/api/cuotas GET]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo cargar el plan de cuotas."), { status: 500 });
  }
}

/** POST /api/cuotas — crea/reemplaza el plan. Body: { tipo, cuentaId, cuotas: [...] } */
export async function POST(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const empresaId = ctx.auth.empresa_id;
    const schemaRaw = await fetchDataSchemaForEmpresaId(empresaId);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(errorResponse("Cuerpo JSON inválido."), { status: 400 });
    }
    const b = body != null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const tipo = String(b.tipo ?? "").trim();
    const cuentaId = String(b.cuentaId ?? "").trim();
    if (!cuentaId) return NextResponse.json(errorResponse("cuentaId es obligatorio."), { status: 400 });
    if (!Array.isArray(b.cuotas)) return NextResponse.json(errorResponse("cuotas debe ser una lista."), { status: 400 });

    const cuotas: CuotaPlanInput[] = (b.cuotas as unknown[]).map((raw, i) => {
      const r = raw != null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      return {
        numero_cuota: Number(r.numero_cuota ?? i + 1),
        monto: Number(r.monto),
        fecha_vencimiento: String(r.fecha_vencimiento ?? "").trim(),
      };
    });

    const creadas = await crearPlanCuotas({
      schemaRaw,
      empresaId,
      sucursalId: ctx.auth.sucursal_id ?? null,
      tipo,
      cuentaId,
      cuotas,
      createdBy: ctx.auth.usuarioCatalogId ?? null,
      usuarioNombre: ctx.auth.user?.email ?? null,
    });
    return NextResponse.json(successResponse({ cuotas: creadas }));
  } catch (err) {
    if (err instanceof CuotaError) {
      return NextResponse.json(errorResponse(err.message), { status: err.status });
    }
    console.error("[/api/cuotas POST]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo guardar el plan de cuotas."), { status: 500 });
  }
}

/** DELETE /api/cuotas?tipo=&cuentaId= — elimina el plan (vuelve a saldo único). */
export async function DELETE(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const empresaId = ctx.auth.empresa_id;
    const schemaRaw = await fetchDataSchemaForEmpresaId(empresaId);
    const url = new URL(request.url);
    const tipo = (url.searchParams.get("tipo") ?? "").trim();
    const cuentaId = (url.searchParams.get("cuentaId") ?? "").trim();
    if (!cuentaId) return NextResponse.json(errorResponse("cuentaId es obligatorio."), { status: 400 });

    await eliminarPlanCuotas({ schemaRaw, empresaId, tipo, cuentaId });
    return NextResponse.json(successResponse({ eliminado: true }));
  } catch (err) {
    if (err instanceof CuotaError) {
      return NextResponse.json(errorResponse(err.message), { status: err.status });
    }
    console.error("[/api/cuotas DELETE]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo eliminar el plan de cuotas."), { status: 500 });
  }
}
