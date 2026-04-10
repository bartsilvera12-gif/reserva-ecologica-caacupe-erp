import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import { getCurrentUser } from "@/lib/auth";
import { getBrowserSupabaseForEmpresaData } from "@/lib/supabase/browser-data-client";
import type { Plan, EstadoPlan, PlanMarketingPlantilla } from "./types";

// ─── Tipos de fila Supabase ───────────────────────────────────────────────────

interface PlanRow {
  id: string;
  empresa_id: string;
  codigo_plan: string;
  nombre: string;
  descripcion: string | null;
  precio: number;
  moneda: string;
  periodicidad: string;
  limite_usuarios: number | null;
  limite_clientes: number | null;
  limite_facturas: number | null;
  estado: string;
  es_plan_marketing: boolean | null;
  plantilla_operativa: unknown;
  created_at: string;
  updated_at: string;
}

// ─── Mapeo fila → tipo ────────────────────────────────────────────────────────

function rowToPlan(row: PlanRow): Plan {
  const plantilla = row.plantilla_operativa;
  return {
    id: row.id,
    codigo_plan: row.codigo_plan,
    nombre: row.nombre,
    descripcion: row.descripcion ?? undefined,
    precio: Number(row.precio),
    moneda: row.moneda as Plan["moneda"],
    periodicidad: row.periodicidad as Plan["periodicidad"],
    limite_usuarios: row.limite_usuarios,
    limite_clientes: row.limite_clientes,
    limite_facturas: row.limite_facturas,
    estado: row.estado as EstadoPlan,
    es_plan_marketing: Boolean(row.es_plan_marketing),
    plantilla_operativa: Array.isArray((plantilla as { items?: unknown })?.items)
      ? (plantilla as PlanMarketingPlantilla)
      : undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function generarCodigoPlan(
  sb: Awaited<ReturnType<typeof getBrowserSupabaseForEmpresaData>>
): Promise<string> {
  const { data } = await sb
    .from("planes")
    .select("codigo_plan")
    .order("created_at", { ascending: false })
    .limit(1);

  const last = data?.[0] as { codigo_plan?: string } | undefined;
  const match = last?.codigo_plan?.match(/PLAN-(\d+)/);
  const next = (parseInt(match?.[1] ?? "0") + 1);
  return `PLAN-${String(next).padStart(4, "0")}`;
}

// ─── API pública ──────────────────────────────────────────────────────────────

/** Lista planes del tenant (API + service role; evita RLS del navegador). */
export async function getPlanes(): Promise<Plan[]> {
  if (typeof window !== "undefined") {
    try {
      const res = await fetchWithSupabaseSession("/api/planes", { cache: "no-store" });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        console.error("[planes] getPlanes API:", res.status, t);
        return [];
      }
      const json = (await res.json()) as { success?: boolean; data?: PlanRow[] };
      if (!json.success || !Array.isArray(json.data)) return [];
      return json.data.map(rowToPlan);
    } catch (e) {
      console.error("[planes] getPlanes:", e);
      return [];
    }
  }

  const supabase = await getBrowserSupabaseForEmpresaData();
  const { data, error } = await supabase
    .from("planes")
    .select("*")
    .order("codigo_plan");

  if (error) {
    console.error("[planes] getPlanes:", error.message);
    return [];
  }
  return (data as PlanRow[]).map(rowToPlan);
}

/** Obtiene un plan por ID. */
export async function getPlan(id: string): Promise<Plan | null> {
  const supabase = await getBrowserSupabaseForEmpresaData();
  const { data, error } = await supabase
    .from("planes")
    .select("*")
    .eq("id", id)
    .single();

  if (error) {
    console.error("[planes] getPlan:", error.message);
    return null;
  }
  return rowToPlan(data as PlanRow);
}

export type NuevoPlanData = Omit<Plan, "id" | "codigo_plan" | "created_at" | "updated_at">;

/** Crea plan. empresa_id desde getCurrentUser(). */
export async function savePlan(datos: NuevoPlanData): Promise<Plan | null> {
  const supabase = await getBrowserSupabaseForEmpresaData();
  const usuario = await getCurrentUser();
  if (!usuario?.empresa_id) throw new Error("Usuario no autenticado o sin empresa");

  const codigoPlan = await generarCodigoPlan(supabase);

  const insert: Record<string, unknown> = {
    empresa_id: usuario.empresa_id,
    codigo_plan: codigoPlan,
    nombre: datos.nombre,
    descripcion: datos.descripcion ?? null,
    precio: datos.precio,
    moneda: datos.moneda,
    periodicidad: datos.periodicidad,
    limite_usuarios: datos.limite_usuarios ?? null,
    limite_clientes: datos.limite_clientes ?? null,
    limite_facturas: datos.limite_facturas ?? null,
    estado: datos.estado,
  };
  if (datos.es_plan_marketing !== undefined) insert.es_plan_marketing = datos.es_plan_marketing;
  if (datos.plantilla_operativa !== undefined) insert.plantilla_operativa = datos.plantilla_operativa;

  const { data, error } = await supabase
    .from("planes")
    .insert([insert])
    .select()
    .single();

  if (error) {
    console.error("[planes] savePlan:", error.message);
    return null;
  }
  return rowToPlan(data as PlanRow);
}

/** Actualiza plan. */
export async function updatePlan(
  id: string,
  datos: Partial<Omit<Plan, "id" | "codigo_plan" | "created_at">>
): Promise<Plan | null> {
  const supabase = await getBrowserSupabaseForEmpresaData();
  const patch: Record<string, unknown> = {};
  if (datos.nombre !== undefined) patch.nombre = datos.nombre;
  if (datos.descripcion !== undefined) patch.descripcion = datos.descripcion ?? null;
  if (datos.precio !== undefined) patch.precio = datos.precio;
  if (datos.moneda !== undefined) patch.moneda = datos.moneda;
  if (datos.periodicidad !== undefined) patch.periodicidad = datos.periodicidad;
  if (datos.limite_usuarios !== undefined) patch.limite_usuarios = datos.limite_usuarios ?? null;
  if (datos.limite_clientes !== undefined) patch.limite_clientes = datos.limite_clientes ?? null;
  if (datos.limite_facturas !== undefined) patch.limite_facturas = datos.limite_facturas ?? null;
  if (datos.estado !== undefined) patch.estado = datos.estado;
  if (datos.es_plan_marketing !== undefined) patch.es_plan_marketing = datos.es_plan_marketing;
  if (datos.plantilla_operativa !== undefined) patch.plantilla_operativa = datos.plantilla_operativa;

  const { data, error } = await supabase
    .from("planes")
    .update(patch)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    console.error("[planes] updatePlan:", error.message);
    return null;
  }
  return rowToPlan(data as PlanRow);
}

/** Cambia el estado del plan. */
export async function toggleEstadoPlan(id: string, estado: EstadoPlan): Promise<void> {
  await updatePlan(id, { estado });
}

/** Elimina un plan. */
export async function deletePlan(id: string): Promise<void> {
  const supabase = await getBrowserSupabaseForEmpresaData();
  const { error } = await supabase.from("planes").delete().eq("id", id);
  if (error) console.error("[planes] deletePlan:", error.message);
}

export function planNombre(p: Plan): string {
  return p.nombre;
}
