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
  const fecha = `${Number(dd)} de ${mes} de ${y}`;
  // Sin ciudad no se deja la coma huérfana (antes salía ", 24 de julio de 2026").
  return ciudad.trim() ? `${ciudad.trim()}, ${fecha}` : fecha;
}

/**
 * Datos que en el talonario preimpreso van fijos en la cabecera.
 * Coinciden con empresa_sifen_config (RUC 80131562-0, punto 001-001).
 */
const RUC_EMPRESA = "80131562-0";
/** Punto por defecto si el recibo no tiene sucursal resoluble. */
const PUNTO_FALLBACK = "001 - 001";

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

  // El punto de expedición sale de la SUCURSAL que emitió el recibo, no de una
  // constante: cada sucursal lleva su propia serie desde 000001 y se distinguen
  // por el punto (Casa Matriz 001-001, Reserva Market 001-002). Con un valor
  // fijo, los recibos de Market saldrían con el punto de Casa Matriz.
  let puntoRecibo = PUNTO_FALLBACK;
  if (r.sucursal_id) {
    const sq = await ctx.supabase
      .from("sucursales")
      .select("establecimiento, punto_expedicion")
      .eq("empresa_id", ctx.auth.empresa_id)
      .eq("id", String(r.sucursal_id))
      .maybeSingle();
    const suc = sq.data as { establecimiento?: string | null; punto_expedicion?: string | null } | null;
    const est = (suc?.establecimiento ?? "").trim();
    const pto = (suc?.punto_expedicion ?? "").trim();
    if (est && pto) puntoRecibo = `${est} - ${pto}`;
  }

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
  .page{width:210mm;min-height:150mm;margin:0 auto;background:#fff;padding:14mm}

  /* Marco del comprobante */
  .marco{border:1px solid #1f2937;border-radius:6px;padding:0;overflow:hidden}

  /* ── Cabecera ─────────────────────────────────────────────── */
  .cab{display:flex;align-items:stretch;border-bottom:2px solid #2E7D32}
  .cab-izq{flex:1;display:flex;align-items:center;gap:14px;padding:14px 16px;min-width:0}
  .cab-izq img{width:78px;height:auto;object-fit:contain;flex:0 0 auto}
  .emp{min-width:0}
  .emp .nom{font-size:14px;font-weight:800;color:#1f2937;line-height:1.25}
  .emp .act{margin-top:3px;font-size:9.5px;color:#6b7280;line-height:1.45}
  .emp .dir{margin-top:5px;font-size:9.5px;color:#4b5563;line-height:1.45}
  .emp .dir b{color:#374151}

  .cab-der{flex:0 0 232px;border-left:1px solid #d1d5db;background:#fafafa;padding:12px 14px;display:flex;flex-direction:column;justify-content:center}
  .cab-der .tit{font-size:15px;font-weight:800;letter-spacing:.04em;text-align:center;color:#111827}
  .cab-der .ruc{margin-top:2px;font-size:10.5px;font-weight:600;text-align:center;color:#4b5563}
  .cab-der .sep{margin:9px 0;border-top:1px solid #d1d5db}
  .cab-der .son{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
  .cab-der .son span{font-size:11px;font-weight:600;color:#4b5563}
  .cab-der .son b{font-size:18px;font-weight:800;color:#111827;font-variant-numeric:tabular-nums}
  .cab-der .nro{margin-top:9px;display:flex;align-items:baseline;justify-content:space-between;gap:8px}
  .cab-der .nro .pto{font-size:13px;font-weight:700;color:#374151;letter-spacing:.04em}
  .cab-der .nro .sec{font-size:18px;font-weight:800;color:#c1121f;font-variant-numeric:tabular-nums;letter-spacing:.02em}

  /* ── Cuerpo ───────────────────────────────────────────────── */
  .cuerpo{padding:18px 20px 14px}
  .fecha{text-align:right;font-size:11.5px;color:#4b5563;margin-bottom:16px}

  .fila{display:flex;align-items:flex-end;gap:10px;margin-bottom:15px}
  .fila .et{font-size:11px;color:#6b7280;white-space:nowrap;padding-bottom:3px}
  .fila .dato{flex:1;min-width:0;border-bottom:1px solid #cbd5e1;padding:0 2px 3px;font-size:12.5px;font-weight:700;color:#111827}
  .fila .dato.corto{flex:0 0 170px}

  .letras-lbl{font-size:11px;color:#6b7280;margin-bottom:5px}
  .letras-caja{border:1px solid #1f2937;border-radius:4px;background:#fbfdfb;padding:11px 13px;font-size:12.5px;font-weight:700;color:#111827;letter-spacing:.01em;line-height:1.5;min-height:20px}

  .concepto{margin-top:16px}
  .concepto .dato{margin-top:5px;border-bottom:1px solid #cbd5e1;padding-bottom:4px;font-size:12px;font-weight:600;color:#1f2937;line-height:1.6;min-height:18px}

  /* ── Firmas ───────────────────────────────────────────────── */
  .firmas{display:flex;justify-content:space-between;gap:40px;margin-top:46px;padding:0 8px}
  .firmas .col{flex:1;max-width:220px;text-align:center}
  .firmas .val{font-size:12px;font-weight:700;color:#1f2937;min-height:17px;padding-bottom:3px}
  .firmas .ln{border-top:1px solid #9ca3af}
  .firmas .cap{margin-top:4px;font-size:10px;color:#6b7280;letter-spacing:.02em}

  /* ── Pie ──────────────────────────────────────────────────── */
  .pie{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:16px;padding:8px 20px;border-top:1px solid #e5e7eb;background:#fafafa;font-size:9px;color:#9ca3af}
  .pie .doc{font-weight:700;color:#6b7280;letter-spacing:.03em}


  .toolbar{position:sticky;top:0;background:#111827;padding:10px;text-align:center}
  .toolbar button{background:#4FAEB2;color:#fff;border:0;padding:8px 16px;border-radius:6px;font-size:14px;cursor:pointer}
  @media print{body{background:#fff}.toolbar{display:none}.page{width:auto;min-height:auto;margin:0;padding:12mm}@page{size:A4;margin:12mm}}
</style></head><body>
<div class="toolbar"><button onclick="window.print()">Imprimir / Guardar PDF</button></div>
<div class="page">
  <div class="marco">
    <div class="cab">
      <div class="cab-izq">
        <img src="${esc(EMPRESA_DOC.logoUrl)}" alt="${esc(EMPRESA_DOC.nombre)}" />
        <div class="emp">
          <div class="nom">${esc(EMPRESA_DOC.nombre)}</div>
          <div class="act">${EMPRESA_DOC.actividad.map(esc).join(" · ")}</div>
          <div class="dir"><b>Tel:</b> ${esc(EMPRESA_DOC.telefono)}<br>${EMPRESA_DOC.direccion.map(esc).join(" · ")}</div>
        </div>
      </div>
      <div class="cab-der">
        <div class="tit">RECIBO DE DINERO</div>
        <div class="ruc">R.U.C. ${esc(RUC_EMPRESA)}</div>
        <div class="sep"></div>
        <div class="son"><span>Son Gs.</span><b>${fmtMonto(r.monto, moneda)}</b></div>
        <div class="nro"><span class="pto">${esc(puntoRecibo)}</span><span class="sec">${esc(numeroCorto(r.numero_recibo))}</span></div>
      </div>
    </div>

    <div class="cuerpo">
      <div class="fecha">${esc(fechaLarga(r.fecha))}</div>

      <div class="fila">
        <span class="et">Recibí(mos) de</span>
        <span class="dato">${esc(r.cliente_nombre)}</span>
        <span class="et">R.U.C.</span>
        <span class="dato corto">${esc(r.cliente_documento ?? "")}</span>
      </div>

      <div class="letras-lbl">La cantidad de Guaraníes</div>
      <div class="letras-caja">${esc(montoEnLetras(Number(r.monto) || 0, moneda))}</div>

      <div class="concepto">
        <span class="et" style="font-size:11px;color:#6b7280">En concepto de</span>
        <div class="dato">${esc(conceptoConDocumentos)}</div>
      </div>

      <div class="firmas">
        <div class="col">
          <div class="val">&nbsp;</div>
          <div class="ln"></div>
          <div class="cap">Firma</div>
        </div>
        <div class="col">
          <div class="val">${esc(r.usuario_nombre ?? "")}</div>
          <div class="ln"></div>
          <div class="cap">Aclaración de firma</div>
        </div>
      </div>
    </div>

    <div class="pie">
      <span class="doc">${esc(String(r.numero_recibo))}</span>
      <span>Original: Cliente · Duplicado: Archivo Tributario</span>
    </div>
  </div>
</div>
<script>try{ if (${auto ? "true" : "false"}) window.print(); }catch(e){}</script>
</body></html>`;

  return new NextResponse(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
