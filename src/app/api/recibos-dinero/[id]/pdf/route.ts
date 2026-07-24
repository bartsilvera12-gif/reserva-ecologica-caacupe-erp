import { montoEnLetras } from "@/lib/recibos/numero-a-letras";
import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { membreteA4 } from "@/lib/documentos/membrete";

/**
 * GET /api/recibos-dinero/[id]/pdf?auto=1
 * Recibo de dinero A4 imprimible (HTML). Documento interno NO fiscal.
 */
function esc(v: unknown): string {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function fmtMonto(n: unknown, moneda: string): string {
  const v = Number(n) || 0;
  return (moneda === "USD" ? "USD " : "Gs. ") + v.toLocaleString("es-PY", { maximumFractionDigits: moneda === "USD" ? 2 : 0 });
}
function fmtFecha(iso: unknown): string {
  if (!iso) return "—";
  try {
    return new Date(String(iso)).toLocaleDateString("es-PY", { day: "2-digit", month: "2-digit", year: "numeric" });
  } catch {
    return String(iso);
  }
}
/**
 * Fecha en formato largo con ciudad, como los recibos preimpresos paraguayos:
 * "Caacupé, 24 de julio de 2026". Se arma a mano y no con toLocaleDateString
 * para no depender de la zona horaria del servidor: se toma la parte YYYY-MM-DD
 * del ISO, que es la fecha real del cobro.
 */
const MESES = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
function fechaLarga(iso: unknown, ciudad = "Caacupé"): string {
  const s = String(iso ?? "").slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return ciudad;
  const [, y, mm, dd] = m;
  const mes = MESES[Number(mm) - 1] ?? "";
  return `${ciudad}, ${Number(dd)} de ${mes} de ${y}`;
}

const METODO_LBL: Record<string, string> = { efectivo: "Efectivo", transferencia: "Transferencia", tarjeta: "Tarjeta", cheque: "Cheque", otro: "Otro" };

export async function GET(request: NextRequest, ctxParams: { params: Promise<{ id: string }> }) {
  const { id } = await ctxParams.params;
  const auto = new URL(request.url).searchParams.get("auto") === "1";
  const ctx = await getTenantSupabaseFromAuth(request);
  if (!ctx) return new NextResponse("No autorizado", { status: 401 });

  const rq = await ctx.supabase
    .from("recibos_dinero")
    .select("*")
    .eq("empresa_id", ctx.auth.empresa_id)
    .eq("id", id)
    .maybeSingle();
  if (rq.error || !rq.data) return new NextResponse("Recibo no encontrado", { status: 404 });
  const r = rq.data as Record<string, unknown>;

  // Detalle de facturas cobradas. Un mismo pago puede cubrir varias: el cliente
  // necesita ver cuáles, no solo el total (Decreto de recibos aparte, es lo que
  // permite conciliar contra su cuenta corriente).
  const itq = await ctx.supabase
    .from("recibos_dinero_items")
    .select("numero_documento, fecha_vencimiento, importe_aplicado")
    .eq("empresa_id", ctx.auth.empresa_id)
    .eq("recibo_id", id)
    .order("created_at", { ascending: true });
  const detalle = ((itq.data ?? []) as Array<{
    numero_documento?: string | null;
    fecha_vencimiento?: string | null;
    importe_aplicado?: unknown;
  }>);

  const moneda = String(r.moneda ?? "PYG");
  const metodo = METODO_LBL[String(r.metodo_pago ?? "")] ?? (r.metodo_pago ?? "—");

  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(r.numero_recibo)} — Recibo de dinero</title>
<style>
  *{box-sizing:border-box} html,body{margin:0;padding:0}
  body{font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#1f2937;background:#f3f4f6}
  .page{width:210mm;min-height:148mm;margin:0 auto;background:#fff;padding:16mm 16mm}
  .head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #4FAEB2;padding-bottom:12px}
  .negocio{font-size:20px;font-weight:800}
  .tag{display:inline-block;margin-top:4px;background:#4FAEB2;color:#fff;font-size:13px;font-weight:700;letter-spacing:.06em;padding:4px 12px;border-radius:6px}
  .meta{text-align:right;font-size:13px}
  .meta .num{font-size:18px;font-weight:800;color:#4FAEB2}
  .row{display:flex;gap:24px;margin-top:16px;font-size:13px}
  .row .l{color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
  .montobox{margin-top:18px;border:2px solid #4FAEB2;border-radius:10px;padding:14px 18px;display:flex;justify-content:space-between;align-items:center}
  .montobox .lbl{font-size:12px;text-transform:uppercase;color:#6b7280}
  .montobox .val{font-size:26px;font-weight:800;color:#1f2937}
  .det{margin-top:16px;font-size:13px;line-height:1.7}
  .det b{color:#374151}
  .firma{margin-top:46px;display:flex;justify-content:flex-end}
  .firma .linea{width:240px;border-top:1px solid #9ca3af;text-align:center;padding-top:6px;font-size:12px;color:#6b7280}
  .metodos{margin-top:16px;display:flex;flex-wrap:wrap;gap:18px;font-size:12px;color:#374151}
  .metodos .mp{display:inline-flex;align-items:center;gap:6px}
  .metodos .box{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border:1.5px solid #94a3b8;border-radius:3px;font-weight:800;font-size:12px;line-height:1;color:#0f172a}
  .fechalarga{margin-top:14px;text-align:right;font-size:12px;color:#475569}
  .letras{margin-top:14px;border:1px solid #cbd5e1;border-radius:8px;padding:10px 12px;background:#f8fafc}
  .letras .l{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:#6b7280}
  .letras .txt{display:block;margin-top:3px;font-size:13px;font-weight:700;color:#1f2937;line-height:1.35}
  .detalle{width:100%;border-collapse:collapse;margin-top:18px;font-size:12px}
  .detalle th{background:#f1f5f9;text-align:left;padding:7px 9px;border:1px solid #e2e8f0;font-size:10px;text-transform:uppercase;letter-spacing:.03em;color:#475569}
  .detalle td{padding:7px 9px;border:1px solid #e2e8f0}
  .detalle .num{text-align:right;font-variant-numeric:tabular-nums}
  .detalle tfoot td{font-weight:700;background:#f8fafc}
  .legal{margin-top:26px;padding-top:12px;border-top:1px dashed #d1d5db;font-size:11px;color:#6b7280;text-align:center}
  .toolbar{position:sticky;top:0;background:#111827;padding:10px;text-align:center}
  .toolbar button{background:#4FAEB2;color:#fff;border:0;padding:8px 16px;border-radius:6px;font-size:14px;cursor:pointer}
  @media print{body{background:#fff}.toolbar{display:none}.page{width:auto;min-height:auto;margin:0;padding:12mm}@page{size:A4;margin:12mm}}
</style></head><body>
<div class="toolbar"><button onclick="window.print()">Imprimir / Guardar PDF</button></div>
<div class="page">
  ${membreteA4()}
  <div class="head">
    <div><div class="tag">RECIBO DE DINERO</div></div>
    <div class="meta">
      <div class="num">${esc(r.numero_recibo)}</div>
      <div>Fecha: ${fmtFecha(r.fecha)}</div>
    </div>
  </div>

  <div class="fechalarga">${esc(fechaLarga(r.fecha))}</div>

  <div class="row">
    <div style="flex:1"><div class="l">Recibimos de</div><div><strong>${esc(r.cliente_nombre)}</strong>${r.cliente_documento ? ` · ${esc(r.cliente_documento)}` : ""}</div></div>
  </div>

  <!-- Monto en letras: estándar del recibo paraguayo, evita que se altere la cifra. -->
  <div class="letras">
    <span class="l">La cantidad de</span>
    <span class="txt">${esc(montoEnLetras(Number(r.monto) || 0, moneda))}</span>
  </div>

  <div class="montobox">
    <div class="lbl">Monto recibido</div>
    <div class="val">${fmtMonto(r.monto, moneda)}</div>
  </div>

  ${detalle.length > 0 ? `
  <table class="detalle">
    <thead><tr><th>Documento</th><th>Vencimiento</th><th class="num">Importe</th></tr></thead>
    <tbody>
      ${detalle.map((d) => `<tr>
        <td>${esc(d.numero_documento ?? "—")}</td>
        <td>${d.fecha_vencimiento ? fmtFecha(d.fecha_vencimiento) : "—"}</td>
        <td class="num">${fmtMonto(d.importe_aplicado, moneda)}</td>
      </tr>`).join("")}
    </tbody>
    <tfoot><tr><td colspan="2">Total cobrado</td><td class="num">${fmtMonto(r.monto, moneda)}</td></tr></tfoot>
  </table>` : ""}

  <!-- Método de pago como casillas, igual que los recibos preimpresos: se marca
       el que corresponde y el resto queda visible en blanco. -->
  <div class="metodos">
    ${["efectivo","transferencia","tarjeta","cheque"].map((k) => {
      const activo = String(r.metodo_pago ?? "").toLowerCase() === k;
      return `<span class="mp"><span class="box">${activo ? "×" : ""}</span>${esc(METODO_LBL[k] ?? k)}</span>`;
    }).join("")}
  </div>

  <div class="det">
    ${r.concepto ? `<div><b>Concepto:</b> ${esc(r.concepto)}</div>` : ""}
    ${r.referencia ? `<div><b>Referencia:</b> ${esc(r.referencia)}</div>` : ""}
    ${r.observaciones ? `<div><b>Observaciones:</b> ${esc(r.observaciones)}</div>` : ""}
  </div>

  <div class="firma"><div class="linea">Recibido por${r.usuario_nombre ? `: ${esc(r.usuario_nombre)}` : ""}</div></div>

  <div class="legal">Documento interno no fiscal. No reemplaza factura legal.</div>
</div>
<script>try{ if (${auto ? "true" : "false"}) window.print(); }catch(e){}</script>
</body></html>`;

  return new NextResponse(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
