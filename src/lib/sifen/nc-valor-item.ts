/**
 * Redondeo de cantidad · precio unitario · total por ítem para la NOTA DE CRÉDITO,
 * alineado a la validación de SET (rechazo 1858).
 *
 * POR QUÉ ESTE MÓDULO EXISTE (y por qué es una copia)
 * La lógica es idéntica a la de `rde-xml.ts` (la factura, que SET ya acepta).
 * Se copió en vez de compartir para NO tocar el generador de la factura de
 * Casa Matriz, que funciona en producción. Si se corrige el redondeo de la
 * factura, hay que replicarlo acá. Son funciones puras, sin estado.
 *
 * SET valida `cantidad × precio` con el redondeo TIPS de
 * `facturacionelectronicapy-xmlgen`: (cant×precio) a 2 decimales, luego a 0.
 * Mandar el precio "crudo" puede diferir en 1 Gs. y SET rechaza con 1858. Por
 * eso la NC historicamente mandaba cantidad=1 y precio=total (1×total siempre
 * cierra). Ahora emitimos la cantidad real buscando un precio unitario que
 * cierre exacto con ese redondeo; si no existe, se cae a cantidad=1 (nunca se
 * bloquea la emisión de la NC por esto).
 */

const E8 = BigInt(100000000);
const TEN16 = BigInt(10) ** BigInt(16);
const HALF16 = BigInt(5) * (BigInt(10) ** BigInt(15));
const BI0 = BigInt(0);
const BI1 = BigInt(1);
const BI2 = BigInt(2);

/** Hasta 8 decimales, sin ceros finales. */
function formatDecimalSifen(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  const s = n.toFixed(8).replace(/\.?0+$/, "");
  return s === "" || s === "-" ? "0" : s;
}

function escalaE8AStringDecimal(scaled: bigint): string {
  if (scaled <= BI0) return "0";
  const intPart = scaled / E8;
  let frac = (scaled % E8).toString().padStart(8, "0");
  frac = frac.replace(/0+$/, "");
  return frac ? `${intPart}.${frac}` : `${intPart}`;
}

/** Total valor operación por ítem en PYG según TIPS (2 decimales → 0). */
function totalValorOperacionItemPygSegunTips(cantStr: string, precioStr: string): number {
  let x = parseFloat(precioStr) * parseFloat(cantStr);
  if (!Number.isFinite(x)) x = 0;
  x = parseFloat(x.toFixed(2));
  return parseFloat(x.toFixed(0));
}

/** Precio unitario (×10⁸) tal que half-up de (cant×precio) a Gs. enteros = T. */
function precioUnitarioE8DesdeTotalGuaranies(T: number, cantE8: bigint): bigint {
  const Tb = BigInt(Math.max(0, Math.round(T)));
  const Q = cantE8 > BI0 ? cantE8 : E8;
  const P = (Tb * TEN16 + Q / BI2) / Q;
  const redondeado = (Q * P + HALF16) / TEN16;
  if (redondeado === Tb) return P;
  const lo = Tb * TEN16 - HALF16;
  const pMin = (lo + Q - BI1) / Q;
  const hi = (Tb + BI1) * TEN16 - HALF16 - BI1;
  const pMax = hi / Q;
  if (pMin <= pMax) return pMin;
  throw new Error(`NC ítem: total ${T} incompatible con cantidad para precio unitario`);
}

function cantidadValida(cant: number): number {
  if (!Number.isFinite(cant) || cant <= 0) return 1;
  return cant;
}

export type ValorItemNc = {
  /** dCantProSer */
  dCantStr: string;
  /** dPUniProSer y dTotBruOpeItem/dTotOpeItem (estos dos = total). */
  dPUniStr: string;
  cantidad: number;
  total: number;
};

/**
 * Resuelve los valores del ítem para el XML de la NC.
 *
 * Estrategia:
 *  1. Con la cantidad real, buscar un precio unitario que cierre exacto con el
 *     redondeo de SET. Se prueba primero el precio del ERP; si no cierra, se
 *     calcula uno y se explora un rango chico.
 *  2. Si nada cierra (cantidad rara, decimales incompatibles), FALLBACK a
 *     cantidad=1 y precio=total — el comportamiento historico, que siempre es
 *     aceptado. Preferible emitir con cantidad 1 que fallar la NC entera.
 */
export function resolverValorItemNc(
  cantidadReal: number,
  precioUnitarioErp: number,
  totalLineaGs: number
): ValorItemNc {
  const T = Math.max(0, Math.round(totalLineaGs));
  const cant = cantidadValida(cantidadReal);

  // Fallback trivial y siempre válido.
  const fallback: ValorItemNc = {
    dCantStr: "1",
    dPUniStr: String(T),
    cantidad: 1,
    total: T,
  };

  // Si la cantidad es 1, el historico ya es correcto y exacto.
  if (cant === 1) return fallback;

  const dCantStr = formatDecimalSifen(cant);
  const cantE8 = BigInt(Math.round(cant * 1e8));

  // 1) ¿El precio del ERP ya cierra?
  const erpStr = formatDecimalSifen(precioUnitarioErp);
  if (precioUnitarioErp > 0 && totalValorOperacionItemPygSegunTips(dCantStr, erpStr) === T) {
    return { dCantStr, dPUniStr: erpStr, cantidad: cant, total: T };
  }

  // 2) Buscar un precio unitario que cierre con el redondeo oficial.
  try {
    const pE8 = precioUnitarioE8DesdeTotalGuaranies(T, cantE8);
    for (let i = -5000; i <= 5000; i++) {
      const P = pE8 + BigInt(i);
      if (P <= BI0) continue;
      const ps = escalaE8AStringDecimal(P);
      if (totalValorOperacionItemPygSegunTips(dCantStr, ps) === T) {
        return { dCantStr, dPUniStr: ps, cantidad: cant, total: T };
      }
    }
  } catch {
    /* cae al fallback */
  }

  // 3) No se pudo: emitir con cantidad 1 (comportamiento historico, seguro).
  return fallback;
}
