import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { getTransferenciaDetalle } from "@/lib/transferencias/server/transferencias-queries";
import { membreteA4, EMPRESA_DOC } from "@/lib/documentos/membrete";

/**
 * GET /api/transferencias/[id]/remision?auto=1
 *
 * Nota de remisión A4 imprimible (HTML) de una transferencia entre sucursales.
 * Documento interno de movimiento de mercadería — NO es comprobante fiscal.
 * El navegador la imprime o la guarda como PDF (?auto=1 abre el diálogo solo).
 */
function esc(v: unknown): string {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function fmtNum(n: unknown): string {
  return (Number(n) || 0).toLocaleString("es-PY", { maximumFractionDigits: 2 });
}
function fmtFechaHora(iso: unknown): string {
  if (!iso) return "—";
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return "—";
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const ESTADO_LABEL: Record<string, string> = {
  pendiente: "Pendiente",
  aprobada: "Aprobada",
  rechazada: "Rechazada",
  despachada: "Despachada / En tránsito",
  recibida: "Recibida",
  cancelada: "Cancelada",
};

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auto = new URL(request.url).searchParams.get("auto") === "1";
  const ctx = await getTenantSupabaseFromAuth(request);
  if (!ctx) return new NextResponse("No autorizado", { status: 401 });

  const { id } = await params;
  const empresaId = ctx.auth.empresa_id;
  const sucursalId = ctx.auth.sucursal_id;
  if (!sucursalId) return new NextResponse("Tu usuario no tiene una sucursal asignada.", { status: 409 });

  const schema = await fetchDataSchemaForEmpresaId(empresaId);
  const det = await getTransferenciaDetalle({ schemaRaw: schema, empresaId, sucursalId, transferenciaId: id });
  if (!det) return new NextResponse("Remisión no encontrada", { status: 404 });

  const c = det.cabecera;
  const items = det.items;
  const estadoLbl = ESTADO_LABEL[c.estado] ?? c.estado;
  // ¿Ya hubo despacho? Entonces la columna relevante es lo despachado.
  const huboDespacho = items.some((it) => Number(it.cantidad_despachada) > 0);

  const filas = items
    .map((it, i) => `
      <tr>
        <td class="c">${i + 1}</td>
        <td>${esc(it.nombre)}</td>
        <td class="mono">${esc(it.sku)}</td>
        <td class="c">${esc(it.unidad || "UNIDAD")}</td>
        <td class="r">${fmtNum(it.cantidad_solicitada)}</td>
        <td class="r">${huboDespacho ? fmtNum(it.cantidad_despachada) : "—"}</td>
      </tr>`)
    .join("");

  const totalSolic = items.reduce((a, it) => a + (Number(it.cantidad_solicitada) || 0), 0);
  const totalDesp = items.reduce((a, it) => a + (Number(it.cantidad_despachada) || 0), 0);

  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Remisión ${esc(c.numero)}</title>
<style>
  :root{--verde:#2E7D32;--suave:#6b7280;--linea:#e5e7eb;--tinta:#1f2937;}
  *{box-sizing:border-box;}
  body{margin:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;color:var(--tinta);}
  .toolbar{position:sticky;top:0;background:#fff;border-bottom:1px solid var(--linea);padding:10px 16px;text-align:right;}
  .toolbar button{background:var(--verde);color:#fff;border:0;border-radius:8px;padding:9px 16px;font-size:13px;font-weight:700;cursor:pointer;}
  .page{width:210mm;min-height:297mm;margin:14px auto;background:#fff;padding:14mm;box-shadow:0 1px 6px rgba(0,0,0,.12);}
  h1{font-size:20px;letter-spacing:.04em;margin:6px 0 2px;}
  .sub{color:var(--suave);font-size:12px;margin-bottom:14px;}
  .titublo{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin-bottom:14px;}
  .badge{display:inline-block;border:1px solid var(--verde);color:var(--verde);border-radius:999px;padding:3px 12px;font-size:12px;font-weight:700;}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 24px;margin-bottom:14px;}
  .box{border:1px solid var(--linea);border-radius:10px;padding:10px 12px;}
  .box .k{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--suave);}
  .box .v{font-size:14px;font-weight:700;margin-top:2px;}
  .obs{border:1px solid var(--linea);border-radius:10px;padding:10px 12px;font-size:12px;color:#374151;margin-bottom:14px;}
  table{width:100%;border-collapse:collapse;font-size:12px;}
  thead th{background:#f0fdf4;color:#166534;text-align:left;padding:8px 8px;border-bottom:2px solid var(--verde);font-size:11px;text-transform:uppercase;letter-spacing:.03em;}
  tbody td{padding:7px 8px;border-bottom:1px solid var(--linea);}
  tfoot td{padding:8px;border-top:2px solid var(--verde);font-weight:800;}
  .c{text-align:center;} .r{text-align:right;} .mono{font-family:ui-monospace,Menlo,Consolas,monospace;color:#4b5563;}
  .firmas{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:48px;}
  .firma{text-align:center;font-size:12px;color:#374151;}
  .firma .linea{border-top:1px solid #9ca3af;margin:0 8px 6px;padding-top:6px;}
  .pie{margin-top:22px;font-size:10.5px;color:var(--suave);text-align:center;border-top:1px dashed var(--linea);padding-top:8px;}
  @media print{body{background:#fff;}.toolbar{display:none;}.page{width:auto;min-height:auto;margin:0;padding:12mm;box-shadow:none;}@page{size:A4 portrait;margin:12mm;}}
</style></head>
<body>
<div class="toolbar"><button onclick="window.print()">Imprimir / Guardar PDF</button></div>
<div class="page">
  ${membreteA4()}
  <div class="titublo">
    <div>
      <h1>NOTA DE REMISIÓN</h1>
      <div class="sub">Movimiento de mercadería entre sucursales · N° <strong>${esc(c.numero)}</strong></div>
    </div>
    <div class="badge">${esc(estadoLbl)}</div>
  </div>

  <div class="grid">
    <div class="box"><div class="k">Depósito de origen (envía)</div><div class="v">${esc(c.sucursal_origen_nombre)}</div></div>
    <div class="box"><div class="k">Sucursal de destino (recibe)</div><div class="v">${esc(c.sucursal_destino_nombre)}</div></div>
    <div class="box"><div class="k">Fecha de emisión</div><div class="v">${fmtFechaHora(c.solicitada_at)}</div></div>
    <div class="box"><div class="k">${huboDespacho ? "Fecha de despacho" : "Estado"}</div><div class="v">${huboDespacho ? fmtFechaHora(c.despachada_at) : esc(estadoLbl)}</div></div>
  </div>

  ${c.observacion_solicitud ? `<div class="obs"><strong>Observación:</strong> ${esc(c.observacion_solicitud)}</div>` : ""}

  <table>
    <thead><tr>
      <th class="c" style="width:26px;">#</th>
      <th>Producto</th>
      <th style="width:90px;">SKU</th>
      <th class="c" style="width:70px;">Unidad</th>
      <th class="r" style="width:80px;">Cant. pedida</th>
      <th class="r" style="width:80px;">Cant. enviada</th>
    </tr></thead>
    <tbody>${filas || `<tr><td colspan="6" class="c" style="color:#9ca3af;padding:16px;">Sin productos</td></tr>`}</tbody>
    <tfoot><tr>
      <td colspan="4" class="r">Totales</td>
      <td class="r">${fmtNum(totalSolic)}</td>
      <td class="r">${huboDespacho ? fmtNum(totalDesp) : "—"}</td>
    </tr></tfoot>
  </table>

  <div class="firmas">
    <div class="firma"><div class="linea">Entregado por · ${esc(c.sucursal_origen_nombre)}</div>Aclaración y firma</div>
    <div class="firma"><div class="linea">Recibido por · ${esc(c.sucursal_destino_nombre)}</div>Aclaración y firma</div>
  </div>

  <div class="pie">${esc(EMPRESA_DOC.nombre)} · Documento interno de movimiento de mercadería entre sucursales. No es un comprobante fiscal.</div>
</div>
<script>try{ if (${auto ? "true" : "false"}) setTimeout(function(){ window.print(); }, 350); }catch(e){}</script>
</body></html>`;

  return new NextResponse(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
