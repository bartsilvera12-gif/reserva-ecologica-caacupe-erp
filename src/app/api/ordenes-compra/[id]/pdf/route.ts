import { NextRequest, NextResponse } from "next/server";
import { resolverCtx } from "../../_ctx";
import { getOrdenCompra } from "@/lib/ordenes-compra/server/oc-pg";
import { membreteA4, EMPRESA_DOC } from "@/lib/documentos/membrete";

/**
 * GET /api/ordenes-compra/[id]/pdf?auto=1
 * Orden de compra A4 imprimible (HTML). El navegador la imprime o guarda como
 * PDF. Documento interno (no fiscal): pedido de mercadería al proveedor.
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
const IVA_LBL: Record<string, string> = { exenta: "Exenta", "5": "5%", "10": "10%" };
const ESTADO_LBL: Record<string, string> = {
  borrador: "Borrador", emitida: "Emitida", aprobada: "Aprobada",
  parcialmente_recibida: "Parcialmente recibida", recibida: "Recibida", cancelada: "Cancelada",
};

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auto = new URL(request.url).searchParams.get("auto") === "1";
  const r = await resolverCtx(request);
  if (!r.ok) return new NextResponse("No autorizado", { status: 401 });
  const { id } = await params;
  const det = await getOrdenCompra(r.ctx.schema, r.ctx.empresaId, r.ctx.sucursalId, id);
  if (!det) return new NextResponse("Orden no encontrada", { status: 404 });

  const c = det.cabecera as Record<string, unknown>;
  const items = det.items as Array<Record<string, unknown>>;
  const subtotal = items.reduce((s, it) => s + (Number(it.subtotal) || 0), 0);
  const total = items.reduce((s, it) => s + (Number(it.total) || 0), 0);
  const totalIva = total - subtotal;
  const tipoPago = String(c.tipo_pago) === "credito"
    ? `Crédito${c.plazo_dias ? ` (${esc(c.plazo_dias)} días)` : ""}`
    : "Contado";

  const filas = items.length
    ? items.map((it) => {
        const pend = Math.max(0, (Number(it.cantidad_solicitada) || 0) - (Number(it.cantidad_recibida) || 0));
        return `<tr>
          <td>${esc(it.producto_nombre)}${it.sku_snapshot ? `<div class="sku">${esc(it.sku_snapshot)}</div>` : ""}</td>
          <td class="r">${esc(it.cantidad_solicitada)}</td>
          <td class="r">${esc(it.cantidad_recibida)}</td>
          <td class="r">${pend}</td>
          <td class="r">${gs(it.costo_estimado)}</td>
          <td class="c">${esc(IVA_LBL[String(it.iva_tipo)] ?? it.iva_tipo)}</td>
          <td class="r">${gs(it.subtotal)}</td>
          <td class="r">${gs(it.total)}</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="8" class="c" style="color:#9ca3af;">Sin ítems</td></tr>`;

  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Orden de compra ${esc(c.numero)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; color: #1f2937; margin: 0; padding: 24px; }
  .wrap { max-width: 800px; margin: 0 auto; }
  h1 { font-size: 18px; margin: 16px 0 2px; }
  .meta { font-size: 12px; color: #6b7280; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 24px; margin: 16px 0; font-size: 12.5px; }
  .grid .k { color: #6b7280; }
  .grid .v { font-weight: 600; }
  .badge { display: inline-block; border-radius: 999px; padding: 2px 10px; font-size: 11px; font-weight: 700; background: #E5F4F4; color: #3F8E91; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 12px; }
  thead th { background: #E5F4F4; color: #3F8E91; text-align: left; padding: 8px; font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em; border-bottom: 2px solid rgba(79,174,178,.4); }
  tbody td { padding: 7px 8px; border-bottom: 1px solid #eef2f7; }
  .r { text-align: right; } .c { text-align: center; }
  .sku { font-family: ui-monospace, monospace; font-size: 10px; color: #9ca3af; }
  tfoot td { padding: 7px 8px; font-weight: 700; }
  tfoot .lbl { text-align: right; color: #6b7280; font-weight: 600; text-transform: uppercase; font-size: 10.5px; }
  .foot { margin-top: 18px; font-size: 11px; color: #9ca3af; }
</style></head>
<body>
  <div class="wrap">
    ${membreteA4()}
    <h1>Orden de compra <span style="font-family:ui-monospace,monospace">${esc(c.numero)}</span> <span class="badge">${esc(ESTADO_LBL[String(c.estado)] ?? c.estado)}</span></h1>
    <div class="meta">Documento interno · no fiscal — pedido de mercadería al proveedor</div>
    <div class="grid">
      <div><span class="k">Proveedor:</span> <span class="v">${esc(c.proveedor_nombre) || "—"}</span></div>
      <div><span class="k">Fecha:</span> <span class="v">${fh(c.fecha)}</span></div>
      <div><span class="k">Condición:</span> <span class="v">${tipoPago}</span></div>
      <div><span class="k">Moneda:</span> <span class="v">${esc(c.moneda)}${String(c.moneda) === "USD" ? ` @ ${gs(c.tipo_cambio)}` : ""}</span></div>
      ${c.llegada_estimada ? `<div><span class="k">Llegada estimada:</span> <span class="v">${esc(String(c.llegada_estimada).slice(0, 10))}</span></div>` : ""}
      ${c.observaciones ? `<div style="grid-column:1/-1"><span class="k">Observación:</span> <span class="v">${esc(c.observaciones)}</span></div>` : ""}
    </div>
    <table>
      <thead><tr>
        <th>Producto</th><th class="r">Pedida</th><th class="r">Recibida</th><th class="r">Pendiente</th>
        <th class="r">Costo unit.</th><th class="c">IVA</th><th class="r">Subtotal</th><th class="r">Total</th>
      </tr></thead>
      <tbody>${filas}</tbody>
      <tfoot>
        <tr><td colspan="6" class="lbl">Totales</td><td class="r">${gs(subtotal)}</td><td class="r">${gs(total)}</td></tr>
        <tr><td colspan="8" class="r" style="font-weight:400;color:#6b7280;font-size:11px">IVA incluido: ${gs(totalIva)}</td></tr>
      </tfoot>
    </table>
    <div class="foot">${esc(EMPRESA_DOC.nombre ?? "")} — impreso el ${fh(new Date().toISOString())}</div>
  </div>
  ${auto ? "<script>window.addEventListener('load',()=>{setTimeout(()=>window.print(),300)});</script>" : ""}
</body></html>`;

  return new NextResponse(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
