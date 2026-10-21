import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { sincronizarEstadoDesdeConsultaDe } from "@/lib/sifen/sincronizar-estado-consulta-de";

type RouteCtx = { params: Promise<{ id: string }> };

/**
 * POST /api/facturas/[id]/sifen/consulta-de
 *
 * Pregunta a SET por el CDC (siConsDE), NO por el lote. Sirve cuando el lote
 * quedó colgado en 0361 y `consulta-lote` nunca resuelve: el DE puede estar ya
 * aprobado del lado de SET aunque el lote siga trabado.
 *
 * Solo sincroniza el estado local si SET da un veredicto explícito
 * (aprobado / rechazado). Si SET no conoce el CDC o no opina, no se toca nada.
 *
 * Toda la lógica vive en `sincronizarEstadoDesdeConsultaDe` — reutilizada por
 * el worker SIFEN como fallback automático (ver run-sifen-job.ts).
 */
export async function POST(request: NextRequest, { params }: RouteCtx) {
  try {
    const { id } = await params;
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const { auth, supabase } = ctx;

    const r = await sincronizarEstadoDesdeConsultaDe(supabase, auth.empresa_id, id);
    if (!r.ok) {
      return NextResponse.json(errorResponse(r.error), { status: r.status });
    }

    return NextResponse.json(
      successResponse({
        cambio: r.cambio,
        estado_sifen: r.estado_sifen,
        estado_sifen_anterior: r.estado_sifen_anterior,
        set: r.set,
      })
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[/api/facturas/[id]/sifen/consulta-de]", msg);
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
