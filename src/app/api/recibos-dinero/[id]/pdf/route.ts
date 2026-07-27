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

/**
 * Importe con relleno de asteriscos a la izquierda y ".-" al final, como en los
 * recibos preimpresos: impide que se agreguen dígitos delante de la cifra.
 * Ej. 1200000 -> "***********1.200.000.-"
 */
function montoConAsteriscos(monto: number, ancho = 22): string {
  const n = Math.round(Number(monto) || 0).toLocaleString("es-PY");
  const cuerpo = `${n}.-`;
  const relleno = Math.max(0, ancho - cuerpo.length);
  return `${"*".repeat(relleno)}${cuerpo}`;
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

  /**
   * Filas de la tabla. Se completan con filas vacías hasta un mínimo para que el
   * comprobante conserve la forma del preimpreso aunque cobre un solo documento.
   */
  const MIN_FILAS = 5;
  const filasReales = detalle.map((d) => ({
    doc: (d.numero_documento ?? "").trim() || "—",
    venc: d.fecha_vencimiento ? fmtFecha(d.fecha_vencimiento) : "",
    concepto: "Cobro de cuenta",
    importe: fmtMonto(d.importe_aplicado, moneda),
  }));
  // Sin detalle (recibos anteriores al desglose) se muestra el concepto guardado.
  if (filasReales.length === 0) {
    filasReales.push({
      doc: "—",
      venc: "",
      concepto: String(r.concepto ?? "Cobro"),
      importe: fmtMonto(r.monto, moneda),
    });
  }
  const filasTabla = [
    ...filasReales,
    ...Array.from({ length: Math.max(0, MIN_FILAS - filasReales.length) }, () => ({
      doc: "", venc: "", concepto: "", importe: "",
    })),
  ];

  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(r.numero_recibo)} — Recibo de dinero</title>
<style>
  *{box-sizing:border-box} html,body{margin:0;padding:0}
  body{font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#1f2937;background:#f3f4f6}
  .page{width:210mm;min-height:170mm;margin:0 auto;background:#fff;padding:14mm}

  /* Paleta de marca */
  :root{ --verde:#2E7D32; --verde-osc:#1f5c22; --tinta:#1f2937; --suave:#6b7280; --linea:#d9e2dc; --crema:#f6f9f6; }

  .marco{border:1px solid var(--linea);border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(31,41,55,.06)}

  /* Cabecera con banda de marca */
  .cab{display:flex;justify-content:space-between;align-items:center;gap:26px;padding:20px 26px;border-bottom:3px solid var(--verde)}
  .cab-izq{display:flex;align-items:center;gap:18px;min-width:0}
  .cab-izq img{width:132px;height:auto;object-fit:contain;flex:0 0 auto}
  .emisor{min-width:0;border-left:1px solid var(--linea);padding-left:18px}
  .emisor .nom{font-family:Georgia,"Times New Roman",serif;font-size:16px;font-weight:700;color:var(--verde-osc);line-height:1.2}
  .emisor .act{margin-top:4px;font-size:9px;color:var(--suave);line-height:1.5;max-width:280px}
  .emisor .lin{margin-top:6px;font-size:9.5px;color:#4b5563;line-height:1.55}
  .emisor .lin b{color:var(--tinta)}

  .cab-der{flex:0 0 250px;text-align:right}
  .cab-der .tit{font-family:Georgia,"Times New Roman",serif;font-size:19px;font-weight:700;letter-spacing:.03em;color:var(--tinta)}
  .cab-der .fiscal{margin-top:4px;font-size:10px;color:var(--suave)}
  .cab-der .fiscal .serie{margin-left:12px;color:#4b5563}
  .cab-der .nro{margin-top:10px;display:inline-flex;align-items:baseline;gap:6px;background:var(--crema);border:1px solid var(--linea);border-radius:8px;padding:5px 12px}
  .cab-der .nro small{font-size:10px;font-weight:600;color:var(--suave)}
  .cab-der .nro b{font-size:19px;font-weight:800;color:var(--verde-osc);font-variant-numeric:tabular-nums;letter-spacing:.02em}

  /* Franja del monto */
  .montofranja{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 26px;background:var(--crema)}
  .montofranja .recibi{font-size:12px;color:#4b5563}
  .montofranja .recibi b{color:var(--tinta);font-weight:700}
  .montofranja .fecha{font-size:10.5px;color:var(--suave);margin-top:2px}
  .montofranja .gs{display:flex;align-items:center;gap:8px;flex:0 0 auto}
  .montofranja .gs .lb{font-size:11px;font-weight:700;color:var(--suave)}
  .montofranja .gs .caja{border:1px solid var(--verde);border-radius:6px;background:#fff;padding:5px 12px;font-size:14px;font-weight:800;color:var(--verde-osc);font-variant-numeric:tabular-nums;letter-spacing:.03em}

  .cuerpo{padding:18px 26px 22px}

  .letras{border:1px solid var(--linea);border-radius:8px;padding:11px 14px;font-size:11px;background:#fff}
  .letras .et{text-transform:uppercase;letter-spacing:.06em;font-size:9px;color:var(--suave);font-weight:600}
  .letras .txt{display:block;margin-top:3px;font-size:13px;font-weight:700;color:var(--tinta);line-height:1.45}

  .tabla{width:100%;border-collapse:separate;border-spacing:0;margin-top:16px;font-size:10.5px;border:1px solid var(--linea);border-radius:8px;overflow:hidden}
  .tabla th{background:var(--verde);color:#fff;padding:8px 12px;font-weight:600;font-size:9.5px;letter-spacing:.05em;text-transform:uppercase;text-align:left}
  .tabla th.num{text-align:right}
  .tabla td{padding:8px 12px;height:22px;color:var(--tinta);border-top:1px solid var(--linea)}
  .tabla tbody tr:first-child td{border-top:0}
  .tabla tbody tr:nth-child(even) td{background:var(--crema)}
  .tabla .num{text-align:right;font-variant-numeric:tabular-nums}
  .tabla .ct{text-align:center;color:var(--suave)}
  .totalfila{display:flex;justify-content:flex-end;margin-top:12px}
  .totalfila .caja{background:var(--verde);color:#fff;border-radius:8px;padding:9px 18px;min-width:210px;display:flex;justify-content:space-between;align-items:center;gap:16px}
  .totalfila .caja .l{font-size:10px;letter-spacing:.08em;text-transform:uppercase;opacity:.9}
  .totalfila .caja .v{font-size:15px;font-weight:800;font-variant-numeric:tabular-nums}

  .pie{display:flex;justify-content:space-between;align-items:flex-end;gap:24px;margin-top:30px}
  .metodos{flex:0 0 auto;font-size:10px;color:#4b5563;line-height:2.1}
  .metodos .tt{text-transform:uppercase;letter-spacing:.06em;font-size:8.5px;color:var(--suave);font-weight:600;margin-bottom:2px}
  .metodos .it{display:flex;align-items:center;gap:8px}
  .metodos .bx{width:13px;height:13px;border:1.5px solid var(--suave);border-radius:3px;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;line-height:1;color:var(--verde-osc)}
  .metodos .it.on{color:var(--tinta);font-weight:700}
  .metodos .it.on .bx{border-color:var(--verde)}
  .cobrador{flex:1;text-align:center;font-size:10px;color:var(--suave);padding-bottom:8px}
  .cobrador b{color:var(--tinta)}
  .firma{flex:0 0 236px;text-align:center;padding-top:26px}
  .firma .ln{border-top:1.5px solid var(--tinta);padding-top:5px;font-size:10.5px;font-weight:800;color:var(--verde-osc);letter-spacing:.02em}
  .firma .orig{margin-top:4px;font-size:8.5px;color:var(--suave);letter-spacing:.02em}

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
        <div class="emisor">
          <div class="nom">${esc(EMPRESA_DOC.nombre)}</div>
          <div class="act">${EMPRESA_DOC.actividad.map(esc).join(" · ")}</div>
          <div class="lin"><b>Tel.:</b> ${esc(EMPRESA_DOC.telefono)} &nbsp;·&nbsp; ${EMPRESA_DOC.direccion.map(esc).join(" · ")}</div>
        </div>
      </div>
      <div class="cab-der">
        <div class="tit">Recibo de dinero</div>
        <div class="fiscal">R.U.C. ${esc(RUC_EMPRESA)}<span class="serie">Serie ${esc(puntoRecibo)}</span></div>
        <div class="nro"><small>N&ordm;</small><b>${esc(numeroCorto(r.numero_recibo))}</b></div>
      </div>
    </div>

    <div class="montofranja">
      <div>
        <div class="recibi">Recibimos de: <b>${esc(r.cliente_nombre)}</b>${r.cliente_documento ? ` &nbsp;&middot;&nbsp; R.U.C./C.I.: <b>${esc(r.cliente_documento)}</b>` : ""}</div>
        <div class="fecha">${esc(fechaLarga(r.fecha))}</div>
      </div>
      <div class="gs">
        <span class="lb">Gs.</span>
        <span class="caja">${esc(montoConAsteriscos(Number(r.monto) || 0))}</span>
      </div>
    </div>

    <div class="cuerpo">
      <div class="letras">
        <span class="et">La cantidad de guaran&iacute;es</span>
        <span class="txt">${esc(montoEnLetras(Number(r.monto) || 0, moneda))}</span>
      </div>

      <table class="tabla">
        <thead>
          <tr>
            <th style="width:28%">Documento</th>
            <th style="width:20%">Vencimiento</th>
            <th style="width:30%">Concepto</th>
            <th class="num" style="width:22%">Importe</th>
          </tr>
        </thead>
        <tbody>
          ${filasTabla.map((f) => `<tr>
            <td>${esc(f.doc)}</td>
            <td class="ct">${esc(f.venc)}</td>
            <td>${esc(f.concepto)}</td>
            <td class="num">${esc(f.importe)}</td>
          </tr>`).join("")}
        </tbody>
      </table>
      <div class="totalfila"><div class="caja"><span class="l">Total</span><span class="v">${fmtMonto(r.monto, moneda)}</span></div></div>

      <div class="pie">
        <div class="metodos">
          <div class="tt">Forma de pago</div>
          ${["efectivo","transferencia","tarjeta","cheque"].map((k) => {
            const on = String(r.metodo_pago ?? "").toLowerCase() === k;
            return `<div class="it${on ? " on" : ""}"><span class="bx">${on ? "&times;" : ""}</span>${esc(METODO_LBL[k] ?? k)}</div>`;
          }).join("")}
        </div>
        <div class="cobrador">${r.usuario_nombre ? `Cobrador: <b>${esc(r.usuario_nombre)}</b>` : ""}${r.referencia ? `<br>Ref.: ${esc(r.referencia)}` : ""}</div>
        <div class="firma">
          <div class="ln">${esc(EMPRESA_DOC.nombre)}</div>
          <div class="orig">Original: Cliente &middot; Duplicado: Archivo Tributario</div>
        </div>
      </div>
    </div>
  </div>
</div>

<script>try{ if (${auto ? "true" : "false"}) window.print(); }catch(e){}</script>
</body></html>`;

  return new NextResponse(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
