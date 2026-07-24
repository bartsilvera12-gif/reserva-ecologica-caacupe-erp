import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { exigirSucursal, respuestaSucursalNoAsignada } from "@/lib/sucursales/filtro";
import {
  cobrarConRecibo,
  cuentasPendientesDeCliente,
  CobroReciboError,
} from "@/lib/recibos/server/cobro-con-recibo-pg";

function respError(err: unknown): NextResponse {
  const rSuc = respuestaSucursalNoAsignada(err);
  if (rSuc) return rSuc as NextResponse;
  if (err instanceof CobroReciboError) {
    return NextResponse.json(errorResponse(err.message), { status: err.status });
  }
  console.error("[/api/cobros/con-recibo]", err instanceof Error ? err.message : err);
  return NextResponse.json(errorResponse("No se pudo registrar el cobro."), { status: 500 });
}

/** GET ?cliente_id=... — cuentas pendientes del cliente para armar el cobro. */
export async function GET(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const clienteId = new URL(request.url).searchParams.get("cliente_id") ?? "";
    if (!clienteId) return NextResponse.json(errorResponse("Falta el cliente."), { status: 400 });

    const schema = await fetchDataSchemaForEmpresaId(ctx.auth.empresa_id);
    const cuentas = await cuentasPendientesDeCliente({
      schemaRaw: schema,
      empresaId: ctx.auth.empresa_id,
      sucursalId: exigirSucursal(ctx.auth.sucursal_id),
      clienteId,
    });
    return NextResponse.json(successResponse({ cuentas }));
  } catch (err) {
    return respError(err);
  }
}

/**
 * POST — registra el cobro repartido entre varias facturas y emite UN recibo.
 * Todo en una transacción: o se registra todo, o no se registra nada.
 */
export async function POST(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const clienteId = typeof body.cliente_id === "string" ? body.cliente_id : "";
    if (!clienteId) return NextResponse.json(errorResponse("Falta el cliente."), { status: 400 });

    const aplicRaw = Array.isArray(body.aplicaciones) ? body.aplicaciones : [];
    const aplicaciones = aplicRaw
      .map((a) => {
        const o = a as { cuenta_por_cobrar_id?: unknown; importe?: unknown };
        return {
          cuenta_por_cobrar_id: typeof o.cuenta_por_cobrar_id === "string" ? o.cuenta_por_cobrar_id : "",
          importe: Number(o.importe) || 0,
        };
      })
      .filter((a) => a.cuenta_por_cobrar_id && a.importe > 0);
    if (aplicaciones.length === 0) {
      return NextResponse.json(errorResponse("Indicá al menos una factura con importe."), { status: 400 });
    }

    const schema = await fetchDataSchemaForEmpresaId(ctx.auth.empresa_id);
    const out = await cobrarConRecibo({
      schemaRaw: schema,
      empresaId: ctx.auth.empresa_id,
      sucursalId: exigirSucursal(ctx.auth.sucursal_id),
      clienteId,
      aplicaciones,
      metodo_pago: typeof body.metodo_pago === "string" ? body.metodo_pago : null,
      entidad_bancaria_id: typeof body.entidad_bancaria_id === "string" ? body.entidad_bancaria_id : null,
      referencia: typeof body.referencia === "string" ? body.referencia : null,
      observaciones: typeof body.observaciones === "string" ? body.observaciones : null,
      fecha_pago: typeof body.fecha_pago === "string" ? body.fecha_pago : null,
      usuarioId: ctx.auth.usuarioCatalogId ?? null,
      usuarioNombre: ctx.auth.user?.email ?? null,
    });
    return NextResponse.json(successResponse(out));
  } catch (err) {
    return respError(err);
  }
}
