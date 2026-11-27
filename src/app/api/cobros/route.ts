import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuthWithRol } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { registrarCobro, CobroError } from "@/lib/cobros/server/cobros-pg";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { registrarChequeDeOperacion } from "@/lib/cuentas/server/cheques-pg";
import { exigirCuentaSiCorresponde,sincronizarMovimientoOrigen, CuentasError } from "@/lib/cuentas/server/cuentas-pg";

/** POST /api/cobros — registra un cobro contra una cuenta por cobrar. */
export async function POST(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuthWithRol(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const usuarioNombre = ctx.auth.nombre ?? ctx.auth.user?.email ?? null;
    const usuarioId = ctx.auth.user?.id ?? null;

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json(errorResponse("JSON inválido."), { status: 400 });
    }

    // Cobros por transferencia / tarjeta / cheque: hay que elegir la cuenta donde se acredita.
    // El efectivo sigue en el módulo Caja (no suma a ninguna cuenta, así no se duplica).
    const empresaId = ctx.auth.empresa_id;
    const schema = await fetchDataSchemaForEmpresaId(empresaId);
    const metodoCobro = (body.metodo_pago as string | undefined) ?? "efectivo";
    const cuentaId = body.cuenta_id ? String(body.cuenta_id).trim() : null;
    if (metodoCobro !== "efectivo") {
      await exigirCuentaSiCorresponde(schema, empresaId, cuentaId, "donde se acredita el cobro");
    }

    const result = await registrarCobro(ctx.supabase, ctx.auth.empresa_id, {
      cuenta_id: cuentaId,
      cuenta_por_cobrar_id: String(body.cuenta_por_cobrar_id ?? ""),
      monto: Number(body.monto),
      metodo_pago: (body.metodo_pago as "efectivo" | "transferencia" | "tarjeta" | "cheque" | "otro") ?? "efectivo",
      entidad_bancaria_id: body.entidad_bancaria_id ? String(body.entidad_bancaria_id) : null,
      entidad_nombre_snapshot: body.entidad_nombre_snapshot ? String(body.entidad_nombre_snapshot) : null,
      referencia: body.referencia ? String(body.referencia) : null,
      titular: body.titular ? String(body.titular) : null,
      observaciones: body.observaciones ? String(body.observaciones) : null,
      fecha_pago: typeof body.fecha_pago === "string" ? body.fecha_pago : null,
      cheque_numero: typeof body.cheque_numero === "string" ? body.cheque_numero : null,
      cheque_fecha_cobro: typeof body.cheque_fecha_cobro === "string" ? body.cheque_fecha_cobro : null,
      usuario_id: usuarioId,
      usuario_nombre: usuarioNombre,
    });

    // Suma al saldo de la cuenta elegida (cheque: desde su fecha de cobro). Un movimiento por cobro.
    if (metodoCobro === "cheque" && cuentaId) {
      // Cheque recibido: queda PENDIENTE en el control de cheques; el saldo sube recién al confirmar la acreditación.
      try {
        await registrarChequeDeOperacion({
          schemaRaw: schema, empresaId, sucursalId: ctx.auth.sucursal_id ?? null, usuarioNombre,
          tipo: "recibido", numero: typeof body.cheque_numero === "string" ? body.cheque_numero : null,
          banco: typeof body.entidad_nombre_snapshot === "string" ? body.entidad_nombre_snapshot : null,
          monto: Number(body.monto), fechaPrevista: typeof body.cheque_fecha_cobro === "string" ? body.cheque_fecha_cobro : null,
          cuentaId, origen: "cobro", origenId: result.cobro_id,
          referencia: body.referencia ? String(body.referencia) : null,
          observaciones: "Cobro de cliente",
        });
      } catch (e) {
        console.error("[/api/cobros POST] cobro registrado pero no se creó el cheque pendiente:", result.cobro_id, e instanceof Error ? e.message : e);
      }
    } else if (metodoCobro !== "efectivo" && cuentaId) {
      try {
        await sincronizarMovimientoOrigen({
          schemaRaw: schema, empresaId, origen: "cobro", origenId: result.cobro_id, usuarioNombre,
          deseado: {
            cuentaId, tipo: "ingreso", monto: Number(body.monto),
            fecha: metodoCobro === "cheque" && typeof body.cheque_fecha_cobro === "string" && body.cheque_fecha_cobro
              ? body.cheque_fecha_cobro.slice(0, 10)
              : typeof body.fecha_pago === "string" && body.fecha_pago ? body.fecha_pago : null,
            concepto: `Cobro de cliente (${metodoCobro})`,
            referencia: body.referencia ? String(body.referencia) : null,
          },
        });
      } catch (e) {
        console.error("[/api/cobros POST] cobro registrado pero no se reflejó en la cuenta:", result.cobro_id, e instanceof Error ? e.message : e);
      }
    }

    return NextResponse.json(successResponse(result));
  } catch (err) {
    if (err instanceof CuentasError) {
      return NextResponse.json(errorResponse(err.message), { status: err.status });
    }
    if (err instanceof CobroError) {
      return NextResponse.json(errorResponse(err.message), { status: err.status });
    }
    console.error("[/api/cobros POST]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo registrar el cobro."), { status: 500 });
  }
}
