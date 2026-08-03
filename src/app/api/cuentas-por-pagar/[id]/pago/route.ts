import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuthWithRol } from "@/lib/supabase/tenant-api";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { exigirSucursal } from "@/lib/sucursales/filtro";
import { registrarPagoProveedor, CxpError } from "@/lib/cuentas-por-pagar/server/cxp-pg";

function esAprobador(rol: string | null | undefined): boolean {
  const r = (rol ?? "").trim().toLowerCase();
  return r === "admin" || r === "administrador" || r === "supervisor" || r === "super_admin";
}

/** POST /api/cuentas-por-pagar/[id]/pago — registra un pago (admin/supervisor). */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getTenantSupabaseFromAuthWithRol(request);
    if (!auth) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    if (!esAprobador(auth.auth.rol)) {
      return NextResponse.json(errorResponse("Solo un administrador o supervisor puede registrar pagos."), { status: 403 });
    }
    const sucursalId = exigirSucursal(auth.auth.sucursal_id);
    const empresaId = auth.auth.empresa_id;
    const schema = await fetchDataSchemaForEmpresaId(empresaId);
    const { id } = await params;

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const monto = Number(body.monto) || 0;
    const metodoRaw = String(body.metodo_pago ?? "efectivo");
    const metodo = ["efectivo", "transferencia", "tarjeta", "otro"].includes(metodoRaw) ? metodoRaw : "efectivo";
    const referencia = body.referencia != null && String(body.referencia).trim() !== "" ? String(body.referencia).trim() : null;
    const fechaRaw = body.fecha;
    const fecha = typeof fechaRaw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(fechaRaw) ? fechaRaw : null;

    const out = await registrarPagoProveedor({
      schemaRaw: schema,
      empresaId,
      sucursalId,
      cuentaPorPagarId: id,
      monto,
      metodoPago: metodo,
      referencia,
      fecha,
      usuarioId: auth.auth.usuarioCatalogId ?? null,
      usuarioNombre: auth.auth.user?.email ?? null,
    });
    return NextResponse.json(successResponse(out));
  } catch (err) {
    if (err instanceof CxpError) {
      return NextResponse.json(errorResponse(err.message), { status: err.status });
    }
    console.error("[/api/cuentas-por-pagar/pago]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo registrar el pago."), { status: 500 });
  }
}
