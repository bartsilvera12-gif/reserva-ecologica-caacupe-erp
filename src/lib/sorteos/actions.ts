import { getEmpresaId } from "@/lib/db/empresa";
import { supabase } from "@/lib/supabase";
import type {
  Sorteo,
  SorteoConversacion,
  SorteoCupon,
  SorteoCuponOrdenRow,
  SorteoEntrada,
  SorteoEstado,
} from "@/lib/sorteos/types";

function mapSorteo(r: Record<string, unknown>): Sorteo {
  return {
    id: r.id as string,
    empresa_id: r.empresa_id as string,
    nombre: (r.nombre as string) ?? "",
    descripcion: (r.descripcion as string) ?? null,
    precio_por_boleto: Number(r.precio_por_boleto) ?? 0,
    max_boletos: Number(r.max_boletos) ?? 0,
    total_boletos_vendidos: Number(r.total_boletos_vendidos) ?? 0,
    ultimo_numero_cupon: Number(r.ultimo_numero_cupon) ?? 0,
    fecha_sorteo: (r.fecha_sorteo as string) ?? null,
    estado: (r.estado as SorteoEstado) ?? "activo",
    datos_bancarios: (typeof r.datos_bancarios === "object" && r.datos_bancarios !== null
      ? (r.datos_bancarios as Record<string, unknown>)
      : {}) as Record<string, unknown>,
    imagen_url: (r.imagen_url as string) ?? null,
    created_at: (r.created_at as string) ?? "",
    updated_at: (r.updated_at as string) ?? "",
  };
}

export async function getSorteos(): Promise<Sorteo[]> {
  const { data, error } = await supabase
    .from("sorteos")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => mapSorteo(r as Record<string, unknown>));
}

export async function getSorteoById(id: string): Promise<Sorteo | null> {
  let q = supabase.from("sorteos").select("*").eq("id", id);
  try {
    const empresaId = await getEmpresaId();
    q = q.eq("empresa_id", empresaId);
  } catch {
    /* Sin empresa en perfil: el acceso lo define RLS (p. ej. super_admin). */
  }
  const { data, error } = await q.maybeSingle();

  if (error) throw new Error(error.message);
  return data ? mapSorteo(data as Record<string, unknown>) : null;
}

export type SorteoInput = {
  nombre: string;
  descripcion?: string;
  precio_por_boleto: number;
  max_boletos: number;
  fecha_sorteo?: string | null;
  estado: SorteoEstado;
  datos_bancarios: Record<string, unknown>;
  imagen_url?: string | null;
};

export async function createSorteo(input: SorteoInput): Promise<Sorteo> {
  const empresa_id = await getEmpresaId();
  const { data, error } = await supabase
    .from("sorteos")
    .insert({
      empresa_id,
      nombre: input.nombre.trim(),
      descripcion: input.descripcion?.trim() || null,
      precio_por_boleto: input.precio_por_boleto,
      max_boletos: input.max_boletos,
      fecha_sorteo: input.fecha_sorteo || null,
      estado: input.estado,
      datos_bancarios: input.datos_bancarios,
      imagen_url: input.imagen_url?.trim() || null,
    })
    .select("*")
    .single();

  if (error) throw new Error(error.message);
  return mapSorteo(data as Record<string, unknown>);
}

export async function updateSorteo(id: string, input: SorteoInput): Promise<Sorteo> {
  let q = supabase
    .from("sorteos")
    .update({
      nombre: input.nombre.trim(),
      descripcion: input.descripcion?.trim() || null,
      precio_por_boleto: input.precio_por_boleto,
      max_boletos: input.max_boletos,
      fecha_sorteo: input.fecha_sorteo || null,
      estado: input.estado,
      datos_bancarios: input.datos_bancarios,
      imagen_url: input.imagen_url?.trim() || null,
    })
    .eq("id", id);
  try {
    const empresaId = await getEmpresaId();
    q = q.eq("empresa_id", empresaId);
  } catch {
    /* Sin empresa en perfil: actualización acotada por RLS. */
  }
  const { data, error } = await q.select("*").single();

  if (error) throw new Error(error.message);
  if (!data) throw new Error("No se pudo actualizar el sorteo.");
  return mapSorteo(data as Record<string, unknown>);
}

export async function getSorteoConversaciones(): Promise<SorteoConversacion[]> {
  const { data, error } = await supabase
    .from("sorteo_conversaciones")
    .select("*, sorteos(nombre)")
    .order("updated_at", { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as SorteoConversacion[];
}

export async function getSorteoEntradas(): Promise<SorteoEntrada[]> {
  const { data, error } = await supabase
    .from("sorteo_entradas")
    .select("*, sorteos(nombre)")
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as SorteoEntrada[];
}

export async function getSorteoCupones(): Promise<SorteoCupon[]> {
  const { data, error } = await supabase
    .from("sorteo_cupones")
    .select("*, sorteos(nombre), sorteo_entradas(nombre_participante)")
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as SorteoCupon[];
}

/** Una fila por orden con los números de cupón agregados (vista operativa Cupones). */
export async function getSorteoCuponesOrdenes(): Promise<SorteoCuponOrdenRow[]> {
  const { data, error } = await supabase
    .from("sorteo_entradas")
    .select(
      "id, numero_orden, nombre_participante, whatsapp_numero, cantidad_boletos, monto_total, promo_nombre, precio_fuente, estado_pago, created_at, chat_conversation_id, sorteos(nombre), sorteo_cupones(numero_cupon)"
    )
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);

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

  return rows
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
}
