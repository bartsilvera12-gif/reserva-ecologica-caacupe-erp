import { getBrowserSupabaseForEmpresaData } from "@/lib/supabase/browser-data-client";
import { getCurrentUser } from "@/lib/auth";

export interface EtapaCrm {
  id:         string;
  empresa_id: string;
  codigo:     string;
  nombre:     string;
  color:      string;
  orden:      number;
  activo:     boolean;
  created_at: string;
  updated_at: string;
}

interface EtapaRow {
  id: string;
  empresa_id: string;
  codigo: string;
  nombre: string;
  color: string;
  orden: number;
  activo: boolean;
  created_at: string;
  updated_at: string;
}

function rowToEtapa(row: EtapaRow): EtapaCrm {
  return {
    id: row.id,
    empresa_id: row.empresa_id,
    codigo: row.codigo,
    nombre: row.nombre,
    color: row.color,
    orden: row.orden,
    activo: row.activo,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Lista etapas activas de la empresa del usuario. Ordenadas por orden. */
export async function getEtapas(): Promise<EtapaCrm[]> {
  const usuario = await getCurrentUser();
  if (!usuario?.empresa_id) return [];

  const supabase = await getBrowserSupabaseForEmpresaData();
  const { data, error } = await supabase
    .from("crm_etapas")
    .select("*")
    .eq("empresa_id", usuario.empresa_id)
    .eq("activo", true)
    .order("orden", { ascending: true });

  if (error) {
    console.error("[crm] getEtapas:", error.message);
    return [];
  }
  return (data as EtapaRow[]).map(rowToEtapa);
}

/** Lista todas las etapas (incluidas inactivas) para configuración. */
export async function getEtapasParaConfig(): Promise<EtapaCrm[]> {
  const usuario = await getCurrentUser();
  if (!usuario?.empresa_id) return [];

  const supabase = await getBrowserSupabaseForEmpresaData();
  const { data, error } = await supabase
    .from("crm_etapas")
    .select("*")
    .eq("empresa_id", usuario.empresa_id)
    .order("orden", { ascending: true });

  if (error) {
    console.error("[crm] getEtapasParaConfig:", error.message);
    return [];
  }
  return (data as EtapaRow[]).map(rowToEtapa);
}

/** Crea etapa. Solo admin. */
export async function createEtapa(datos: {
  codigo: string;
  nombre: string;
  color: string;
  orden: number;
}): Promise<EtapaCrm | null> {
  const usuario = await getCurrentUser();
  if (!usuario?.empresa_id) throw new Error("Usuario no autenticado o sin empresa");

  const insert = {
    empresa_id: usuario.empresa_id,
    codigo: datos.codigo.trim().toUpperCase().replace(/\s+/g, "_"),
    nombre: datos.nombre.trim(),
    color: datos.color || "gray",
    orden: datos.orden,
    activo: true,
  };

  const supabase = await getBrowserSupabaseForEmpresaData();
  const { data, error } = await supabase
    .from("crm_etapas")
    .insert([insert])
    .select()
    .single();

  if (error) {
    console.error("[crm] createEtapa:", error.message);
    return null;
  }
  return rowToEtapa(data as EtapaRow);
}

/** Actualiza etapa. */
export async function updateEtapa(
  id: string,
  datos: Partial<Pick<EtapaCrm, "nombre" | "color" | "orden" | "activo">>
): Promise<EtapaCrm | null> {
  const patch: Record<string, unknown> = {};
  if (datos.nombre !== undefined) patch.nombre = datos.nombre.trim();
  if (datos.color !== undefined) patch.color = datos.color;
  if (datos.orden !== undefined) patch.orden = datos.orden;
  if (datos.activo !== undefined) patch.activo = datos.activo;

  const supabase = await getBrowserSupabaseForEmpresaData();
  const { data, error } = await supabase
    .from("crm_etapas")
    .update(patch)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    console.error("[crm] updateEtapa:", error.message);
    return null;
  }
  return rowToEtapa(data as EtapaRow);
}

/** Elimina etapa (o la desactiva si tiene prospectos). */
export async function deleteEtapa(id: string): Promise<boolean> {
  const supabase = await getBrowserSupabaseForEmpresaData();
  const { error } = await supabase.from("crm_etapas").delete().eq("id", id);
  if (error) {
    console.error("[crm] deleteEtapa:", error.message);
    return false;
  }
  return true;
}

/** Mapeo color -> clases Tailwind para el Kanban. */
export const COLOR_TO_CLASSES: Record<string, { headerBg: string; headerText: string; border: string; dot: string }> = {
  gray:   { headerBg: "bg-gray-100",   headerText: "text-gray-700",   border: "border-gray-200",   dot: "bg-gray-400"   },
  blue:   { headerBg: "bg-blue-50",     headerText: "text-blue-700",   border: "border-blue-200",   dot: "bg-blue-500"   },
  amber:  { headerBg: "bg-amber-50",   headerText: "text-amber-700",  border: "border-amber-200",  dot: "bg-amber-500"  },
  green:  { headerBg: "bg-green-50",   headerText: "text-green-700",  border: "border-green-200",  dot: "bg-green-500"  },
  red:    { headerBg: "bg-red-50",     headerText: "text-red-700",    border: "border-red-200",    dot: "bg-red-400"    },
  violet: { headerBg: "bg-violet-50",  headerText: "text-violet-700", border: "border-violet-200", dot: "bg-violet-500" },
  cyan:   { headerBg: "bg-cyan-50",   headerText: "text-cyan-700",   border: "border-cyan-200",   dot: "bg-cyan-500"   },
  pink:   { headerBg: "bg-pink-50",   headerText: "text-pink-700",   border: "border-pink-200",   dot: "bg-pink-500"   },
};

export function getEtapaClasses(color: string) {
  return COLOR_TO_CLASSES[color] ?? COLOR_TO_CLASSES.gray;
}
