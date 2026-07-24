import { montoEnLetras } from "@/lib/recibos/numero-a-letras";
import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { membreteA4, EMPRESA_DOC } from "@/lib/documentos/membrete";

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

/**
 * Datos que en el talonario preimpreso van fijos en la cabecera.
 * Coinciden con empresa_sifen_config (RUC 80131562-0, punto 001-001).
 */
const RUC_EMPRESA = "80131562-0";
const PUNTO_RECIBO = "001 - 001";

/** "REC-000001" -> "000001", para mostrarlo como en el talonario. */
function numeroCorto(numero: unknown): string {
  const s = String(numero ?? "");
  const m = s.match(/(\d+)\s*$/);
  return m ? m[1]! : s;
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

  // En el talonario los documentos cobrados se escriben a mano en la línea
  // "en concepto de" (ej. "Pago de factura # 001-001-0005519 y 001-001-0005565").
  // Se arma igual desde el detalle; si no hay líneas, se cae al concepto guardado.
  const numeros = detalle
    .map((d) => (d.numero_documento ?? "").trim())
    .filter((x) => x.length > 0);
  const conceptoConDocumentos =
    numeros.length > 0
      ? `Pago de ${numeros.length === 1 ? "factura" : "facturas"} ${numeros.join(" y ")}`
      : String(r.concepto ?? "");

  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(r.numero_recibo)} — Recibo de dinero</title>
<style>
  *{box-sizing:border-box} html,body{margin:0;padding:0}
  body{font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#1f2937;background:#f3f4f6}
  .page{width:210mm;min-height:148mm;margin:0 auto;background:#fff;padding:16mm 16mm}
  .marco{border:1.5px solid #111827;border-radius:4px;padding:14px 16px}
  .cab{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}
  .cab-izq{flex:1}
  .cab-der{width:270px;text-align:center;border-left:1px solid #d1d5db;padding-left:14px}
  .cab-der .tit{font-size:18px;font-weight:800;letter-spacing:.02em}
  .cab-der .ruc{font-size:12px;font-weight:700;border-bottom:1px solid #111827;padding-bottom:4px;margin-bottom:6px}
  .cab-der .songs{display:flex;align-items:baseline;gap:8px;border-bottom:1px solid #111827;padding-bottom:4px}
  .cab-der .songs span{font-size:12px;font-weight:700}
  .cab-der .songs b{flex:1;text-align:right;font-size:17px;font-weight:800;font-variant-numeric:tabular-nums}
  .cab-der .nro{display:flex;align-items:baseline;justify-content:space-between;margin-top:6px}
  .cab-der .nro .pto{font-size:14px;font-weight:800;letter-spacing:.06em}
  .cab-der .nro .sec{font-size:17px;font-weight:800;color:#c1121f;font-variant-numeric:tabular-nums}
  .fecha{margin-top:22px;text-align:center;font-size:13px;border-bottom:1px solid #9ca3af;padding-bottom:3px;width:60%;margin-left:auto;margin-right:auto}
  .campo{display:flex;align-items:baseline;gap:8px;margin-top:16px;font-size:12px}
  .campo .et{color:#374151;white-space:nowrap}
  .campo .val{flex:1;border-bottom:1px solid #9ca3af;padding-bottom:2px;font-weight:700;min-height:16px}
  .campo .val.chico{flex:0 0 150px}
  .campo .val.ancho{flex:1;font-weight:600;line-height:1.5}
  .campo.alto{align-items:stretch}
  .campo .caja{flex:1;border:1px solid #111827;padding:7px 9px;font-weight:700;font-size:12.5px;line-height:1.5;min-height:38px}
  .campo.bloque{margin-top:18px}
  .firmas{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;margin-top:44px}
  .firmas .col{flex:1;text-align:center}
  .firmas .ln{border-bottom:1px dotted #6b7280;padding-bottom:3px;min-height:20px;font-weight:600;font-size:12px}
  .firmas .cap{margin-top:3px;font-size:11px;color:#4b5563}
  .firmas .sello{flex:0 0 190px;text-align:center;font-size:10px;font-weight:700;color:#9ca3af;border:1px dashed #d1d5db;border-radius:6px;padding:8px 6px}
  .pie{display:flex;justify-content:space-between;margin-top:18px;padding-top:8px;border-top:1px solid #e5e7eb;font-size:9.5px;color:#6b7280}
  .toolbar{position:sticky;top:0;background:#111827;padding:10px;text-align:center}
  .toolbar button{background:#4FAEB2;color:#fff;border:0;padding:8px 16px;border-radius:6px;font-size:14px;cursor:pointer}
  @media print{body{background:#fff}.toolbar{display:none}.page{width:auto;min-height:auto;margin:0;padding:12mm}@page{size:A4;margin:12mm}}
</style></head><body>
<div class="toolbar"><button onclick="window.print()">Imprimir / Guardar PDF</button></div>
<div class="page">
  <div class="marco">
    <div class="cab">
      <div class="cab-izq">${membreteA4()}</div>
      <div class="cab-der">
        <div class="tit">RECIBO DE DINERO</div>
        <div class="ruc">R.U.C. ${esc(RUC_EMPRESA)}</div>
        <div class="songs"><span>Son Gs.</span><b>${fmtMonto(r.monto, moneda)}</b></div>
        <div class="nro"><span class="pto">${esc(PUNTO_RECIBO)}</span><span class="sec">${esc(numeroCorto(r.numero_recibo))}</span></div>
      </div>
    </div>

    <div class="fecha">${esc(fechaLarga(r.fecha, ""))}</div>

    <div class="campo">
      <span class="et">Recibí(mos) de:</span>
      <span class="val">${esc(r.cliente_nombre)}</span>
      <span class="et">R.U.C.:</span>
      <span class="val chico">${esc(r.cliente_documento ?? "")}</span>
    </div>

    <div class="campo alto">
      <span class="et">La cantidad de Guaraníes</span>
      <span class="caja">${esc(montoEnLetras(Number(r.monto) || 0, moneda))}</span>
    </div>

    <div class="campo bloque">
      <span class="et">en concepto de:</span>
      <span class="val ancho">${esc(conceptoConDocumentos)}</span>
    </div>

    <div class="firmas">
      <div class="col"><div class="ln"></div><div class="cap">Firma</div></div>
      <div class="sello">${esc(EMPRESA_DOC.nombre)}</div>
      <div class="col"><div class="ln">${esc(r.usuario_nombre ?? "")}</div><div class="cap">Aclaración de Firma</div></div>
    </div>

    <div class="pie">
      <span>${esc(String(r.numero_recibo))}</span>
      <span>Original: Cliente · Duplicado: Arch. Tributario</span>
    </div>
  </div>
</div>
<script>try{ if (${auto ? "true" : "false"}) window.print(); }catch(e){}</script>
</body></html>`;

  return new NextResponse(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
