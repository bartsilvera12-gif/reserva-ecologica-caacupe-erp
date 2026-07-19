import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { aplicarFiltroSucursal } from "@/lib/sucursales/filtro";

/**
 * GET /api/productos/sku-sugerencias?tipo=<reventa|menu|materia>
 *
 * Devuelve:
 *  - sugerido: SKU autogenerado para el tipo (REV/MEN/MP) con el próximo número.
 *  - patrones: prefijos detectados en SKUs existentes + los por tipo, cada uno
 *    con su "siguiente" (próximo número), para el dropdown "Usar patrón existente".
 * Solo lectura sobre productos.sku. No toca ventas/compras.
 */

const PREFIJO_TIPO: Record<string, string> = { reventa: "REV", menu: "MEN", materia: "MP" };

function pad(n: number, width: number): string {
  return String(n).padStart(Math.max(width, 1), "0");
}

/** Separa "QA-MAY-001" → {prefix:"QA-MAY", num:1, width:3}. Si no hay número final, null. */
function parseSku(sku: string): { prefix: string; num: number; width: number } | null {
  const m = /^(.+?)[-_](\d+)$/.exec(sku.trim());
  if (!m) return null;
  return { prefix: m[1], num: parseInt(m[2], 10) || 0, width: m[2].length };
}

export async function GET(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const tipo = (new URL(request.url).searchParams.get("tipo") ?? "reventa").toLowerCase();
    const prefijoTipo = PREFIJO_TIPO[tipo] ?? "REV";

    // Por sucursal: el correlativo de SKU es independiente en cada una, igual
    // que el único (empresa_id, sucursal_id, sku).
    const { data, error } = await aplicarFiltroSucursal(
      ctx.supabase.from("productos").select("sku").eq("empresa_id", ctx.auth.empresa_id),
      ctx.auth.sucursal_id
    );
    if (error) throw new Error(error.message);

    // prefix -> { maxNum, width }
    const map = new Map<string, { maxNum: number; width: number }>();
    for (const r of (data ?? []) as Array<{ sku: string | null }>) {
      const p = r.sku ? parseSku(r.sku) : null;
      if (!p) continue;
      const cur = map.get(p.prefix);
      if (!cur) map.set(p.prefix, { maxNum: p.num, width: p.width });
      else map.set(p.prefix, { maxNum: Math.max(cur.maxNum, p.num), width: Math.max(cur.width, p.width) });
    }

    // Asegurar que los 3 prefijos por tipo existan en la lista (aunque no se hayan usado).
    for (const px of Object.values(PREFIJO_TIPO)) {
      if (!map.has(px)) map.set(px, { maxNum: 0, width: 4 });
    }

    const patrones = [...map.entries()]
      .map(([prefix, v]) => ({
        prefix,
        siguiente: `${prefix}-${pad(v.maxNum + 1, Math.max(v.width, 4))}`,
      }))
      .sort((a, b) => a.prefix.localeCompare(b.prefix));

    const def = map.get(prefijoTipo) ?? { maxNum: 0, width: 4 };
    const sugerido = `${prefijoTipo}-${pad(def.maxNum + 1, Math.max(def.width, 4))}`;

    return NextResponse.json(successResponse({ sugerido, prefijo_tipo: prefijoTipo, patrones }));
  } catch (err) {
    console.error("[/api/productos/sku-sugerencias]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudieron generar sugerencias de SKU."), { status: 500 });
  }
}
