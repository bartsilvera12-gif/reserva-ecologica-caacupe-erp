import type { AppSupabaseClient } from "@/lib/supabase/schema";

/**
 * Resuelve el establecimiento y punto de expedición que corresponden a un
 * documento, según la SUCURSAL EN QUE FUE EMITIDO.
 *
 * POR QUÉ SE TOMA DEL DOCUMENTO Y NO DE LA SESIÓN
 * El punto de expedición es parte del CDC y del número fiscal: identifica dónde
 * se emitió el documento. Si se tomara de la sesión, reenviar o consultar una
 * factura vieja desde otra sucursal la reconstruiría con un punto distinto al
 * que ya se declaró ante SET, y el CDC no coincidiría.
 *
 * TIMBRADO: NO se toca. El cliente confirmó con DNIT que el timbrado 18949725
 * tiene habilitados los DOS puntos (001 y 002), así que ambas sucursales usan
 * el mismo. Si en el futuro alguna necesitara timbrado propio, este es el lugar
 * donde agregarlo, no `empresa_sifen_config`.
 *
 * FALLBACK: si el documento no tiene sucursal, o la sucursal no tiene punto
 * cargado, se devuelve la config de empresa tal cual. Eso preserva exactamente
 * el comportamiento previo a multi-sucursal.
 *
 * CASA MATRIZ NO CAMBIA: su fila de sucursal tiene establecimiento 001 y punto
 * 001, idénticos a `empresa_sifen_config`. El resultado es el mismo valor que
 * antes, no un valor equivalente — el XML sale byte por byte igual.
 */
export type PuntoExpedicionResuelto = {
  establecimiento: string;
  punto_expedicion: string;
  /** true si vino de la sucursal; false si se uso el fallback de empresa. */
  desdeSucursal: boolean;
};

export async function resolverPuntoExpedicion(
  supabase: AppSupabaseClient,
  empresaId: string,
  sucursalId: string | null | undefined,
  configEmpresa: { establecimiento?: string | null; punto_expedicion?: string | null }
): Promise<PuntoExpedicionResuelto> {
  const fallback: PuntoExpedicionResuelto = {
    establecimiento: (configEmpresa.establecimiento ?? "").trim(),
    punto_expedicion: (configEmpresa.punto_expedicion ?? "").trim(),
    desdeSucursal: false,
  };

  if (!sucursalId) return fallback;

  const { data, error } = await supabase
    .from("sucursales")
    .select("establecimiento, punto_expedicion")
    .eq("id", sucursalId)
    .eq("empresa_id", empresaId)
    .maybeSingle();

  // Ante error o sucursal sin punto cargado se usa el fallback: es preferible
  // emitir con la config de empresa (comportamiento histórico) que fallar.
  if (error || !data) return fallback;

  const est = (data.establecimiento ?? "").trim();
  const punto = (data.punto_expedicion ?? "").trim();
  if (!est || !punto) return fallback;

  return { establecimiento: est, punto_expedicion: punto, desdeSucursal: true };
}
