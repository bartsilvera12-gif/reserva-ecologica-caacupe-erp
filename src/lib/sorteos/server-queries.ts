import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { SorteoCuponOrdenRow, SorteoEntrada } from "@/lib/sorteos/types";

export async function fetchSorteoEntradasServer(): Promise<{
  data: SorteoEntrada[];
  error: string | null;
}> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("sorteo_entradas")
    .select("*, sorteos(nombre)")
    .order("created_at", { ascending: false });

  if (error) {
    return { data: [], error: error.message };
  }
  return { data: (data ?? []) as unknown as SorteoEntrada[], error: null };
}

export async function fetchSorteoCuponesOrdenesServer(): Promise<{
  data: SorteoCuponOrdenRow[];
  error: string | null;
}> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("sorteo_entradas")
    .select(
      "id, numero_orden, nombre_participante, whatsapp_numero, cantidad_boletos, monto_total, promo_nombre, precio_fuente, estado_pago, created_at, chat_conversation_id, sorteos(nombre), sorteo_cupones(numero_cupon)"
    )
    .order("created_at", { ascending: false });

  if (error) {
    return { data: [], error: error.message };
  }

  const rows = (data ?? []) as unknown as Array<{
    id: string;
    numero_orden: number | null;
    nombre_participante: string;
    whatsapp_numero: string;
    cantidad_boletos: number;
    monto_total: number | null;
    promo_nombre: string | null;
    precio_fuente: string | null;
    estado_pago: string;
    created_at: string;
    chat_conversation_id: string | null;
    sorteos?: { nombre: string } | null;
    sorteo_cupones?: { numero_cupon: string }[] | null;
  }>;

  const mapped = rows
    .map((r) => {
      const cupones = Array.isArray(r.sorteo_cupones) ? r.sorteo_cupones : [];
      const numeros = cupones.map((c) => c.numero_cupon).filter(Boolean).sort();
      if (numeros.length === 0) return null;
      const sorteoJoin = r.sorteos;
      const sorteoNombre =
        sorteoJoin && !Array.isArray(sorteoJoin)
          ? sorteoJoin.nombre
          : Array.isArray(sorteoJoin) && sorteoJoin[0]
            ? sorteoJoin[0].nombre
            : "—";
      const mt =
        typeof r.monto_total === "number" && Number.isFinite(r.monto_total)
          ? r.monto_total
          : Number(r.monto_total);
      const montoTotal = Number.isFinite(mt) ? mt : 0;
      const pf = r.precio_fuente === "promo" || r.precio_fuente === "lista" ? r.precio_fuente : null;
      return {
        entrada_id: r.id,
        numero_orden: typeof r.numero_orden === "number" ? r.numero_orden : 0,
        nombre_participante: r.nombre_participante,
        whatsapp_numero: r.whatsapp_numero,
        cantidad_boletos: r.cantidad_boletos,
        monto_total: montoTotal,
        promo_nombre: r.promo_nombre?.trim() ? r.promo_nombre.trim() : null,
        precio_fuente: pf,
        estado_pago: r.estado_pago as SorteoCuponOrdenRow["estado_pago"],
        created_at: r.created_at,
        chat_conversation_id: r.chat_conversation_id ?? null,
        sorteo_nombre: sorteoNombre ?? "—",
        numeros_cupon: numeros,
      };
    })
    .filter((x): x is SorteoCuponOrdenRow => x !== null);

  return { data: mapped, error: null };
}
