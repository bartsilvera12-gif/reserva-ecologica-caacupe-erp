import { NextRequest, NextResponse } from "next/server";
import { successResponse, errorResponse } from "@/lib/api/response";
import { resolverCtx, respError } from "./_ctx";
import { crearTransferencia } from "@/lib/transferencias/server/transferencias-pg";
import { listarTransferencias, contarPorEstado } from "@/lib/transferencias/server/transferencias-queries";

/** GET /api/transferencias?filtro=realizadas|recibidas|todas — listado + conteos. */
export async function GET(request: NextRequest) {
  const r = await resolverCtx(request);
  if (!r.ok) return r.response;
  try {
    const url = new URL(request.url);
    const filtroRaw = url.searchParams.get("filtro");
    const filtro = filtroRaw === "realizadas" || filtroRaw === "recibidas" ? filtroRaw : "todas";

    const [transferencias, conteos] = await Promise.all([
      listarTransferencias({ schemaRaw: r.ctx.schema, empresaId: r.ctx.empresaId, sucursalId: r.ctx.sucursalId, filtro }),
      contarPorEstado({ schemaRaw: r.ctx.schema, empresaId: r.ctx.empresaId, sucursalId: r.ctx.sucursalId }),
    ]);
    return NextResponse.json(successResponse({ transferencias, conteos }));
  } catch (err) {
    return respError(err);
  }
}

/** POST /api/transferencias — crear solicitud (la sucursal del usuario es el destino). */
export async function POST(request: NextRequest) {
  const r = await resolverCtx(request);
  if (!r.ok) return r.response;
  try {
    const body = (await request.json().catch(() => ({}))) as {
      sucursal_origen_id?: unknown;
      items?: unknown;
      observacion?: unknown;
    };
    const sucursalOrigenId = typeof body.sucursal_origen_id === "string" ? body.sucursal_origen_id : "";
    if (!sucursalOrigenId) {
      return NextResponse.json(errorResponse("Elegí la sucursal de origen."), { status: 400 });
    }
    const itemsRaw = Array.isArray(body.items) ? body.items : [];
    const items = itemsRaw
      .map((it) => {
        const o = it as { producto_destino_id?: unknown; cantidad_solicitada?: unknown };
        return {
          producto_destino_id: typeof o.producto_destino_id === "string" ? o.producto_destino_id : "",
          cantidad_solicitada: Number(o.cantidad_solicitada) || 0,
        };
      })
      .filter((it) => it.producto_destino_id && it.cantidad_solicitada > 0);
    if (items.length === 0) {
      return NextResponse.json(errorResponse("Agregá al menos un producto con cantidad."), { status: 400 });
    }
    const observacion =
      typeof body.observacion === "string" ? body.observacion.trim().slice(0, 500) || null : null;

    // La sucursal del usuario ES el destino (quien solicita/recibe la mercadería).
    const out = await crearTransferencia({
      schemaRaw: r.ctx.schema,
      empresaId: r.ctx.empresaId,
      sucursalDestinoId: r.ctx.sucursalId,
      sucursalOrigenId,
      items,
      observacion,
      usuarioId: r.ctx.usuarioId,
    });
    return NextResponse.json(successResponse({ id: out.id, numero: out.numero }));
  } catch (err) {
    return respError(err);
  }
}
