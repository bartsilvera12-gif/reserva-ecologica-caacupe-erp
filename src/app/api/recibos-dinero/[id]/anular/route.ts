import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuthWithRol } from "@/lib/supabase/tenant-api";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { esAdminErp } from "@/lib/roles/erp-role-access";
import { anularRecibo, AnularReciboError } from "@/lib/recibos/server/anular-recibo-pg";

/**
 * POST /api/recibos-dinero/[id]/anular
 * Body: { motivo: string }  (min 5 caracteres)
 *
 * Solo admin. Anula el recibo, marca los cobros_clientes que agrupó como
 * anulados y restaura el saldo de las cuentas por cobrar afectadas. Todo en
 * una transacción PG. NO llama a SET (el recibo es interno no fiscal).
 */
export async function POST(
  request: NextRequest,
  ctxParams: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await getTenantSupabaseFromAuthWithRol(request);
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    // Solo admin puede anular. Supervisor y usuario reciben 403 aunque el
    // cliente haya intentado por URL directa.
    if (!esAdminErp(ctx.auth.rol)) {
      return NextResponse.json(
        errorResponse("Solo un administrador puede anular recibos."),
        { status: 403 }
      );
    }

    const { id } = await ctxParams.params;
    if (!id?.trim()) {
      return NextResponse.json(errorResponse("Falta el id del recibo."), { status: 400 });
    }

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const motivo = typeof body.motivo === "string" ? body.motivo.trim() : "";
    if (motivo.length < 5) {
      return NextResponse.json(
        errorResponse("El motivo debe tener al menos 5 caracteres."),
        { status: 400 }
      );
    }

    const schema = await fetchDataSchemaForEmpresaId(ctx.auth.empresa_id);
    const result = await anularRecibo({
      schemaRaw: schema,
      empresaId: ctx.auth.empresa_id,
      reciboId: id.trim(),
      motivo,
      usuarioId: ctx.auth.usuarioCatalogId ?? null,
      usuarioNombre: ctx.auth.user?.email ?? null,
    });

    return NextResponse.json(successResponse(result));
  } catch (err) {
    if (err instanceof AnularReciboError) {
      return NextResponse.json(errorResponse(err.message), { status: err.status });
    }
    console.error("[/api/recibos-dinero/:id/anular]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo anular el recibo."), { status: 500 });
  }
}
