import { NextRequest, NextResponse } from "next/server";
import { getAuthWithRol } from "@/lib/middleware/auth";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { CuentasError } from "@/lib/cuentas/server/cuentas-pg";
import { cambiarMedioPagoVenta, METODOS_CAMBIO } from "@/lib/ventas/server/cambiar-medio-pago-pg";

/**
 * POST /api/ventas/[id]/medio-pago
 * Body: { metodo_pago, motivo, tarjeta_tipo?, cuenta_id?, entidad_bancaria_id?, entidad_nombre?, referencia?, titular?, confirmar_conciliado? }
 * Solo ventas contado completadas. Roles: admin y supervisor. No toca stock, factura ni SIFEN.
 */
const ROLES_PERMITIDOS = new Set(["admin", "supervisor"]);

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getAuthWithRol(request);
    if (!auth) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const rol = String(auth.rol ?? "").toLowerCase();
    if (!ROLES_PERMITIDOS.has(rol) && !rol.includes("admin")) {
      return NextResponse.json(errorResponse("No tenés permiso para cambiar el medio de pago."), { status: 403 });
    }
    const { id } = await params;
    let b: Record<string, unknown>;
    try {
      b = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json(errorResponse("Cuerpo JSON inválido"), { status: 400 });
    }
    const str = (v: unknown, max = 200) => (v == null || String(v).trim() === "" ? null : String(v).trim().slice(0, max));
    const metodo = String(b.metodo_pago ?? "").toLowerCase();
    if (!(METODOS_CAMBIO as readonly string[]).includes(metodo)) {
      return NextResponse.json(errorResponse("Medio de pago inválido."), { status: 400 });
    }
    const motivo = str(b.motivo, 2000);
    if (!motivo || motivo.length < 5) {
      return NextResponse.json(errorResponse("El motivo es obligatorio (mínimo 5 caracteres)."), { status: 400 });
    }
    const schema = await fetchDataSchemaForEmpresaId(auth.empresa_id);
    const r = await cambiarMedioPagoVenta({
      schemaRaw: schema,
      empresaId: auth.empresa_id,
      ventaId: id.trim(),
      usuarioId: auth.usuarioCatalogId ?? null,
      usuarioNombre: auth.nombre ?? auth.user?.email ?? null,
      metodoNuevo: metodo,
      tarjetaTipo: str(b.tarjeta_tipo, 30),
      cuentaId: str(b.cuenta_id, 60),
      entidadBancariaId: str(b.entidad_bancaria_id, 60),
      entidadNombre: str(b.entidad_nombre),
      referencia: str(b.referencia),
      titular: str(b.titular),
      motivo,
      confirmarConciliado: b.confirmar_conciliado === true,
    });
    return NextResponse.json(successResponse(r));
  } catch (err) {
    if (err instanceof CuentasError) return NextResponse.json(errorResponse(err.message), { status: err.status });
    console.error("[ventas/medio-pago]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo cambiar el medio de pago."), { status: 500 });
  }
}
