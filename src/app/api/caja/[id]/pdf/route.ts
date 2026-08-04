import { NextRequest, NextResponse } from "next/server";
import { resolverCtx } from "../../_ctx";
import { getCajaDetalle } from "@/lib/caja/server/caja-pg";
import { membreteA4, EMPRESA_DOC } from "@/lib/documentos/membrete";
import { getMarcaSucursal } from "@/lib/documentos/marca-sucursal";
import type { ArqueoItem } from "@/lib/caja/denominaciones";

/**
 * GET /api/caja/[id]/pdf?auto=1
 * Arqueo / cierre de caja A4 imprimible (HTML). El navegador lo imprime o guarda
 * como PDF. Documento interno (no fiscal).
 */
function esc(v: unknown): string {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function gs(n: unknown): string {
  return "Gs. " + Math.round(Number(n) || 0).toLocaleString("es-PY");
}
function fh(iso: unknown): string {
  if (!iso) return "—";
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return "—";
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auto = new URL(request.url).searchParams.get("auto") === "1";
  const r = await resolverCtx(request);
  if (!r.ok) return new NextResponse("No autorizado", { status: 401 });
  const { id } = await params;
  const det = await getCajaDetalle(r.ctx.schema, r.ctx.empresaId, r.ctx.sucursalId, id);
  if (!det) return new NextResponse("Caja no encontrada", { status: 404 });
  const marca = await getMarcaSucursal(r.ctx.schema, r.ctx.empresaId, r.ctx.sucursalId);

  const c = det.caja;
  const a = det.arqueo;
  const cerrada = c.estado === "cerrada";
  const arqueo: ArqueoItem[] = c.arqueo_cierre ?? c.arqueo_apertura ?? [];

  const filaEfectivo = (label: string, val: number, signo = "+") =>
    `<tr><td>${signo} ${esc(label)}</td><td class="r">${gs(val)}</td></tr>`;

  const denomRows = arqueo.length
    ? arqueo
        .filter((it) => it.cantidad > 0)
        .map((it) => `<tr><td class="c">${it.tipo === "billete" ? "Billete" : "Moneda"}</td><td class="r">${gs(it.denominacion)}</td><td class="r">${it.cantidad}</td><td class="r">${gs(it.valor)}</td></tr>`)
        .join("")
    : "";

  const movRows = det.movimientos.length
    ? (det.movimientos as Array<Record<string, unknown>>)
        .map((m) => `<tr><td>${esc(m.tipo)}</td><td>${esc(m.metodo_pago)}</td><td>${esc(m.concepto ?? "")}</td><td class="r">${gs(m.monto)}</td></tr>`)
        .join("")
    : `<tr><td colspan="4" class="c" style="color:#9ca3af;">Sin movimientos manuales</td></tr>`;

  const contado = cerrada ? Number(c.efectivo_contado) : null;
  const diferencia = cerrada ? Number(c.diferencia) : null;

  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Arqueo de caja</title>
<style>
  :root{--verde:#2E7D32;--suave:#6b7280;--linea:#e5e7eb;--tinta:#1f2937;}
  *{box-sizing:border-box;} body{margin:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;color:var(--tinta);}
  .toolbar{position:sticky;top:0;background:#fff;border-bottom:1px solid var(--linea);padding:10px 16px;text-align:right;}
  .toolbar button{background:var(--verde);color:#fff;border:0;border-radius:8px;padding:9px 16px;font-size:13px;font-weight:700;cursor:pointer;}
  .page{width:210mm;min-height:297mm;margin:14px auto;background:#fff;padding:14mm;box-shadow:0 1px 6px rgba(0,0,0,.12);}
  h1{font-size:19px;letter-spacing:.04em;margin:6px 0 2px;}
  .sub{color:var(--suave);font-size:12px;margin-bottom:14px;}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 24px;margin-bottom:14px;}
  .box{border:1px solid var(--linea);border-radius:10px;padding:9px 12px;}
  .box .k{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--suave);}
  .box .v{font-size:14px;font-weight:700;margin-top:2px;}
  .cols{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:14px;}
  h2{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#166534;margin:0 0 6px;}
  table{width:100%;border-collapse:collapse;font-size:12px;}
  th{background:#f0fdf4;color:#166534;text-align:left;padding:6px 8px;border-bottom:2px solid var(--verde);font-size:10.5px;text-transform:uppercase;}
  td{padding:5px 8px;border-bottom:1px solid var(--linea);}
  .r{text-align:right;} .c{text-align:center;}
  .tot{font-weight:800;border-top:2px solid var(--verde);}
  .dif{margin-top:10px;padding:8px 12px;border-radius:10px;font-weight:800;text-align:center;}
  .ok{background:#ecfdf5;color:#065f46;} .falta{background:#fef2f2;color:#991b1b;} .sobra{background:#fffbeb;color:#92400e;}
  .firma{margin-top:44px;text-align:center;font-size:12px;color:#374151;width:60%;margin-left:auto;margin-right:auto;}
  .firma .linea{border-top:1px solid #9ca3af;margin:0 8px 6px;padding-top:6px;}
  .pie{margin-top:20px;font-size:10.5px;color:var(--suave);text-align:center;border-top:1px dashed var(--linea);padding-top:8px;}
  @media print{body{background:#fff;}.toolbar{display:none;}.page{width:auto;min-height:auto;margin:0;padding:12mm;box-shadow:none;}@page{size:A4 portrait;margin:12mm;}}
</style></head>
<body>
<div class="toolbar"><button onclick="window.print()">Imprimir / Guardar PDF</button></div>
<div class="page">
  ${membreteA4(marca)}
  <h1>ARQUEO / CIERRE DE CAJA</h1>
  <div class="sub">${esc(c.sucursal_nombre ?? "")} · Turno ${cerrada ? "cerrado" : "abierto"}</div>

  <div class="grid">
    <div class="box"><div class="k">Apertura</div><div class="v">${fh(c.abierta_at)}</div><div class="k" style="margin-top:4px;">${esc(c.abierta_por_nombre ?? "")}</div></div>
    <div class="box"><div class="k">Cierre</div><div class="v">${fh(c.cerrada_at)}</div><div class="k" style="margin-top:4px;">${esc(c.cerrada_por_nombre ?? "")}</div></div>
  </div>

  <div class="cols">
    <div>
      <h2>Efectivo del turno</h2>
      <table>
        <tbody>
          ${filaEfectivo("Monto de apertura", a.monto_apertura)}
          ${filaEfectivo("Ventas en efectivo", a.ventas_efectivo)}
          ${filaEfectivo("Cobros en efectivo", a.cobros_efectivo)}
          ${filaEfectivo("Ingresos manuales", a.ingresos_efectivo)}
          ${filaEfectivo("Ajustes", a.ajustes_efectivo)}
          ${filaEfectivo("Egresos", a.egresos_efectivo, "−")}
          ${filaEfectivo("Retiros", a.retiros_efectivo, "−")}
          <tr class="tot"><td>Efectivo esperado</td><td class="r">${gs(a.efectivo_esperado)}</td></tr>
          ${cerrada ? `<tr class="tot"><td>Efectivo contado</td><td class="r">${gs(contado)}</td></tr>` : ""}
        </tbody>
      </table>
      ${cerrada ? `<div class="dif ${diferencia === 0 ? "ok" : (diferencia ?? 0) < 0 ? "falta" : "sobra"}">${diferencia === 0 ? "Cierre exacto" : (diferencia ?? 0) < 0 ? "Faltante: " + gs(Math.abs(diferencia ?? 0)) : "Sobrante: " + gs(diferencia ?? 0)}</div>` : ""}
    </div>
    <div>
      <h2>Ventas del turno (todos los medios)</h2>
      <table>
        <tbody>
          <tr><td>Efectivo</td><td class="r">${gs(a.ventas_efectivo)}</td></tr>
          <tr><td>Tarjeta</td><td class="r">${gs(a.ventas_tarjeta)}</td></tr>
          <tr><td>Transferencia</td><td class="r">${gs(a.ventas_transferencia)}</td></tr>
          <tr><td>A crédito</td><td class="r">${gs(a.ventas_credito)}</td></tr>
          <tr class="tot"><td>Total vendido</td><td class="r">${gs(a.ventas_total)}</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  ${denomRows ? `
  <h2>Detalle del arqueo (conteo físico)</h2>
  <table style="margin-bottom:14px;">
    <thead><tr><th class="c">Tipo</th><th class="r">Denominación</th><th class="r">Cantidad</th><th class="r">Valor</th></tr></thead>
    <tbody>${denomRows}<tr class="tot"><td colspan="3" class="r">Total contado</td><td class="r">${gs(cerrada ? contado : a.monto_apertura)}</td></tr></tbody>
  </table>` : ""}

  <h2>Movimientos manuales</h2>
  <table>
    <thead><tr><th>Tipo</th><th>Método</th><th>Concepto</th><th class="r">Monto</th></tr></thead>
    <tbody>${movRows}</tbody>
  </table>

  ${c.observacion_cierre ? `<p style="margin-top:12px;font-size:12px;"><strong>Observación de cierre:</strong> ${esc(c.observacion_cierre)}</p>` : ""}

  <div class="firma"><div class="linea">Responsable de caja · ${esc(c.sucursal_nombre ?? "")}</div>Aclaración y firma</div>
  <div class="pie">${esc(EMPRESA_DOC.nombre)} · Documento interno de arqueo de caja. No es un comprobante fiscal.</div>
</div>
<script>try{ if (${auto ? "true" : "false"}) setTimeout(function(){ window.print(); }, 350); }catch(e){}</script>
</body></html>`;

  return new NextResponse(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
