import type { AppSupabaseClient } from "@/lib/supabase/schema";
import {
  buildSifenCancelacionPreview,
  normalizePlazoCancelacionHoras,
} from "@/lib/sifen/sifen-cancelacion-rules";
import { validarXmlFirmadoFacturaOrigenParaNc } from "@/lib/sifen/validar-factura-origen-xml-para-nc";

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Evalúa si la UI puede ofrecer «Emitir nota de crédito» (sin crear aún). */
export async function evaluateNotaCreditoCreationGate(
  supabase: AppSupabaseClient,
  empresaId: string,
  facturaId: string
): Promise<{ puede_crear: boolean; motivo_bloqueo: string | null }> {
  const { data: factura, error: errF } = await supabase
    .from("facturas")
    .select("monto, saldo, estado")
    .eq("id", facturaId)
    .eq("empresa_id", empresaId)
    .maybeSingle();

  if (errF || !factura) {
    return { puede_crear: false, motivo_bloqueo: errF?.message ?? "Factura no encontrada." };
  }

  const estado = String((factura as { estado?: string }).estado ?? "");
  if (estado === "Anulado") {
    return { puede_crear: false, motivo_bloqueo: "La factura está anulada." };
  }

  const saldo = num((factura as { saldo?: unknown }).saldo);
  const monto = num((factura as { monto?: unknown }).monto);
  // Antes se bloqueaba con `saldo <= 0`, lo que hacía imposible emitir NC sobre
  // una factura CONTADO (nace con saldo 0 y sin filas en `pagos`). El tope real
  // de una NC no es el saldo sino el importe facturado menos lo ya acreditado
  // (ver más abajo): sobre una factura cobrada la NC es un reembolso/descuento.
  void saldo;
  if (monto <= 0) {
    return { puede_crear: false, motivo_bloqueo: "La factura no tiene monto facturado." };
  }

  const { data: feRow, error: errFe } = await supabase
    .from("factura_electronica")
    .select("id, factura_id, estado_sifen, sifen_aprobado_at, sifen_cancelado_at, cdc, xml_firmado_path")
    .eq("factura_id", facturaId)
    .eq("empresa_id", empresaId)
    .maybeSingle();

  if (errFe) {
    return { puede_crear: false, motivo_bloqueo: errFe.message };
  }
  if (!feRow) {
    return { puede_crear: false, motivo_bloqueo: "No hay documento electrónico para esta factura." };
  }

  const estadoSifen = String((feRow as { estado_sifen?: string }).estado_sifen ?? "");
  if (estadoSifen !== "aprobado") {
    return {
      puede_crear: false,
      motivo_bloqueo: "El documento electrónico debe estar aprobado por SET para crear una nota de crédito.",
    };
  }

  const cdcGate =
    (feRow as { cdc?: string | null }).cdc == null ? "" : String((feRow as { cdc?: string | null }).cdc).trim();
  if (cdcGate.length !== 44) {
    return {
      puede_crear: false,
      motivo_bloqueo:
        "El documento electrónico no tiene CDC válido (44 dígitos); no se puede preparar nota de crédito.",
    };
  }

  const { data: facturaNum, error: errNum } = await supabase
    .from("facturas")
    .select("numero_factura")
    .eq("id", facturaId)
    .eq("empresa_id", empresaId)
    .maybeSingle();

  if (errNum || !facturaNum) {
    return { puede_crear: false, motivo_bloqueo: errNum?.message ?? "Factura no encontrada." };
  }

  const vGate = await validarXmlFirmadoFacturaOrigenParaNc(
    supabase,
    empresaId,
    {
      id: String((feRow as { id: string }).id),
      factura_id: String((feRow as { factura_id: string }).factura_id),
      cdc: cdcGate,
      xml_firmado_path:
        (feRow as { xml_firmado_path?: string | null }).xml_firmado_path == null
          ? null
          : String((feRow as { xml_firmado_path?: string | null }).xml_firmado_path).trim() || null,
    },
    {
      cdcEsperado: cdcGate,
      facturaIdEsperado: facturaId,
      numeroFacturaErp: String((facturaNum as { numero_factura?: string }).numero_factura ?? ""),
    }
  );
  if (!vGate.ok) {
    return { puede_crear: false, motivo_bloqueo: vGate.message };
  }

  const [{ data: cfg }, pagosRes] = await Promise.all([
    supabase
      .from("empresa_sifen_config")
      .select("sifen_plazo_cancelacion_horas")
      .eq("empresa_id", empresaId)
      .maybeSingle(),
    supabase.from("pagos").select("monto").eq("factura_id", facturaId).eq("empresa_id", empresaId),
  ]);

  if (pagosRes.error) {
    return { puede_crear: false, motivo_bloqueo: pagosRes.error.message };
  }
  const pagosRows = (pagosRes.data ?? []) as { monto?: unknown }[];
  const pagosCount = pagosRows.length;
  const sumaPagos = pagosRows.reduce((s, r) => s + num(r.monto), 0);

  const plazo = normalizePlazoCancelacionHoras(
    cfg != null ? (cfg as { sifen_plazo_cancelacion_horas?: unknown }).sifen_plazo_cancelacion_horas : 48
  );

  const preview = buildSifenCancelacionPreview({
    estadoSifen,
    sifenAprobadoAtIso:
      (feRow as { sifen_aprobado_at?: string | null }).sifen_aprobado_at == null
        ? null
        : String((feRow as { sifen_aprobado_at?: string | null }).sifen_aprobado_at),
    sifenCanceladoAtIso:
      (feRow as { sifen_cancelado_at?: string | null }).sifen_cancelado_at == null
        ? null
        : String((feRow as { sifen_cancelado_at?: string | null }).sifen_cancelado_at),
    plazoHoras: plazo,
    pagosCount,
    nowMs: Date.now(),
  });

  // Nota: aunque el DE siga dentro del plazo de cancelación en SET, permitimos
  // emitir NC. El operador elige entre cancelar (anula el DE) o NC (deja registro
  // fiscal ajustando saldo). Antes bloqueábamos aquí para forzar cancelación;
  // se removió a pedido del negocio (2026-07-09) porque hay casos legítimos de
  // NC dentro del plazo (devolución parcial, ajuste de precio, cliente ya cobrado).
  void preview;

  // Se admiten múltiples NC por factura mientras el acumulado (aprobadas +
  // en curso) no supere el IMPORTE ACREDITABLE = monto facturado − NC aprobadas.
  // El tope ya no es el saldo: en contado el saldo nace en 0 y bloqueaba todo.
  // Mismo criterio que el RPC nota_credito_aplicar_aprobacion_set.
  const { data: ncsRows, error: errNcs } = await supabase
    .from("nota_credito")
    .select("monto, estado_erp")
    .eq("factura_id", facturaId)
    .eq("empresa_id", empresaId)
    .in("estado_erp", ["aprobada", "borrador", "pendiente_envio_sifen"]);
  if (errNcs) {
    return { puede_crear: false, motivo_bloqueo: errNcs.message };
  }
  const ncs = (ncsRows ?? []) as { monto?: unknown; estado_erp?: string }[];
  const sumaAprobadas = ncs
    .filter((n) => n.estado_erp === "aprobada")
    .reduce((s, n) => s + num(n.monto), 0);
  const sumaEnCurso = ncs
    .filter((n) => n.estado_erp === "borrador" || n.estado_erp === "pendiente_envio_sifen")
    .reduce((s, n) => s + num(n.monto), 0);

  // Se eliminó el chequeo de coherencia `saldo === monto − pagos − NC aprobadas`:
  // no se cumple en facturas CONTADO (saldo nace en 0 sin filas en `pagos`) y ya
  // no es necesario, porque el tope de la NC no depende del saldo.
  void sumaPagos;

  const acreditable = Math.max(0, monto - sumaAprobadas);
  const disponibleParaNc = Math.max(0, acreditable - sumaEnCurso);
  if (disponibleParaNc <= 0.02) {
    return {
      puede_crear: false,
      motivo_bloqueo:
        sumaEnCurso > 0
          ? "El importe acreditable ya está comprometido por notas de crédito en curso. Anulá alguna borrador o esperá su resolución en SET."
          : "La factura ya fue acreditada por completo con notas de crédito.",
    };
  }

  return { puede_crear: true, motivo_bloqueo: null };
}

