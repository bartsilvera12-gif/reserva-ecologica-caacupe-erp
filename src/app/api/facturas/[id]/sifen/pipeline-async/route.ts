import { NextRequest, NextResponse } from "next/server";
import { getUserAndEmpresa } from "@/lib/middleware/auth";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";

/**
 * POST /api/facturas/[id]/sifen/pipeline-async
 *
 * Dispara la cadena SIFEN (borrador → xml → firmar → enviar) SERVER-SIDE y en
 * background: responde 202 inmediatamente y sigue la cadena en el event loop
 * del proceso Node. La UI puede seguir operando y solo polea /sifen/resumen
 * cada N segundos para reflejar el avance.
 *
 * NO cambia la lógica fiscal: cada paso reusa el endpoint HTTP existente (mismo
 * comportamiento y validaciones que cuando se aprieta "Generar y enviar" a mano).
 * Solo desacopla la experiencia del usuario del tiempo de SET.
 *
 * Requiere que el proceso Node (Docker en Coolify) siga vivo después de responder
 * — no funcionaría bien en serverless que congela el proceso post-respuesta.
 *
 * Logs: cada paso emite [sifen-pipeline <facturaId>] path -> status (ms) para
 * medir tiempos por etapa en Coolify.
 */

async function runPipelineInBackground(
  origin: string,
  facturaId: string,
  cookie: string
): Promise<void> {
  const label = `[sifen-pipeline ${facturaId}]`;
  const totalStart = Date.now();
  const post = async (path: string): Promise<{ ok: boolean; ms: number }> => {
    const t0 = Date.now();
    try {
      const r = await fetch(`${origin}${path}`, {
        method: "POST",
        headers: { cookie },
        cache: "no-store",
      });
      const ms = Date.now() - t0;
      console.log(`${label} ${path} -> ${r.status} (${ms}ms)`);
      return { ok: r.ok, ms };
    } catch (e) {
      const ms = Date.now() - t0;
      console.error(`${label} ${path} -> error (${ms}ms)`, e);
      return { ok: false, ms };
    }
  };
  const fetchResumen = async (): Promise<Record<string, unknown> | null> => {
    try {
      const r = await fetch(`${origin}/api/facturas/${facturaId}/sifen/resumen`, {
        headers: { cookie },
        cache: "no-store",
      });
      if (!r.ok) return null;
      const j = (await r.json()) as { success?: boolean; data?: Record<string, unknown> };
      return j.success ? j.data ?? null : null;
    } catch {
      return null;
    }
  };
  const getEstado = (cur: Record<string, unknown> | null): string => {
    const fe = cur?.factura_electronica as Record<string, unknown> | null | undefined;
    return typeof fe?.estado_sifen === "string" ? fe.estado_sifen : "";
  };
  const getXmlPath = (cur: Record<string, unknown> | null): string => {
    const fe = cur?.factura_electronica as Record<string, unknown> | null | undefined;
    return typeof fe?.xml_path === "string" ? fe.xml_path : "";
  };
  const getXmlFirmadoPath = (cur: Record<string, unknown> | null): string => {
    const fe = cur?.factura_electronica as Record<string, unknown> | null | undefined;
    return typeof fe?.xml_firmado_path === "string" ? fe.xml_firmado_path : "";
  };

  try {
    let cur = await fetchResumen();
    if (!cur || cur.sifen_config_activa !== true) {
      console.warn(`${label} SIFEN inactivo o resumen vacío — abortado`);
      return;
    }

    // 1) borrador — solo si no hay factura_electronica.
    if (!cur.factura_electronica) {
      const r = await post(`/api/facturas/${facturaId}/sifen/borrador`);
      if (!r.ok) return;
      cur = await fetchResumen();
    }

    let st = getEstado(cur);
    if (st === "aprobado" || st === "cancelado" || st === "rechazado") {
      console.log(`${label} estado terminal ${st}, nada por hacer`);
      return;
    }

    // 2) xml — desde 'borrador'.
    if (st === "borrador") {
      const r = await post(`/api/facturas/${facturaId}/sifen/xml`);
      if (!r.ok) return;
      cur = await fetchResumen();
      st = getEstado(cur);
    }

    // 3) firmar — desde 'generado' o desde 'error_envio' con xml sin firmar.
    if (st === "generado") {
      const r = await post(`/api/facturas/${facturaId}/sifen/firmar`);
      if (!r.ok) return;
      cur = await fetchResumen();
      st = getEstado(cur);
    } else if (st === "error_envio" && getXmlPath(cur) && !getXmlFirmadoPath(cur)) {
      const r = await post(`/api/facturas/${facturaId}/sifen/firmar`);
      if (!r.ok) return;
      cur = await fetchResumen();
      st = getEstado(cur);
    }

    // 4) enviar — desde 'firmado' o 'error_envio' con xml firmado.
    if (st === "firmado" || (st === "error_envio" && getXmlFirmadoPath(cur))) {
      await post(`/api/facturas/${facturaId}/sifen/enviar`);
    }
  } finally {
    console.log(`${label} TOTAL ${Date.now() - totalStart}ms`);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await getUserAndEmpresa(request);
    if (!auth) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const { id } = await params;
    const facturaId = id?.trim();
    if (!facturaId) {
      return NextResponse.json(errorResponse("id de factura obligatorio"), { status: 400 });
    }

    const cookie = request.headers.get("cookie") ?? "";
    const origin = new URL(request.url).origin;

    // Fire-and-forget: NO await. La cadena sigue corriendo en el event loop
    // aunque ya hayamos respondido al cliente.
    void runPipelineInBackground(origin, facturaId, cookie).catch((err) => {
      console.error(`[sifen-pipeline ${facturaId}] error no capturado`, err);
    });

    return NextResponse.json(
      successResponse({ started: true, at: new Date().toISOString() }),
      { status: 202 }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
