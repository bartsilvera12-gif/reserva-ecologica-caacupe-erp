import { createBrowserClient } from "@supabase/ssr";

export interface Empresa {
  id: string;
  nombre_empresa: string;
  plan: string | null;
  ruc: string | null;
  estado: string;
  created_at: string;
}

export interface Modulo {
  id: string;
  nombre?: string;
  name?: string;
}

export interface ModuloEmpresa {
  id: string;
  nombre: string;
  slug: string;
}

export async function getModulosEmpresa(empresaId: string): Promise<ModuloEmpresa[]> {
  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
  const { data: emData, error: err1 } = await supabase
    .from("empresa_modulos")
    .select("modulo_id")
    .eq("empresa_id", empresaId)
    .eq("activo", true);

  if (err1) throw new Error(err1.message);
  const moduloIds = (emData ?? []).map((r) => r.modulo_id).filter(Boolean);
  if (moduloIds.length === 0) return [];

  const { data: modulos, error: err2 } = await supabase
    .from("modulos")
    .select("id, nombre, slug")
    .in("id", moduloIds);

  if (err2) throw new Error(err2.message);
  return (modulos ?? []).map((m) => ({
    id: m.id,
    nombre: m.nombre ?? "",
    slug: m.slug ?? "",
  }));
}

/** Obtiene los módulos habilitados para la empresa del usuario autenticado (vía API con service role). */
export async function getMisModulos(): Promise<ModuloEmpresa[]> {
  const res = await fetch("/api/empresas/mis-modulos", { cache: "no-store" });
  if (!res.ok) {
    if (res.status === 401) return [];
    throw new Error("Error al cargar módulos");
  }
  return res.json();
}

/** Obtiene todos los módulos de la tabla modulos (para super_admin). */
export async function getTodosModulos(): Promise<ModuloEmpresa[]> {
  const res = await fetch("/api/admin/modulos", { cache: "no-store" });
  if (!res.ok) throw new Error("Error al cargar módulos");
  const data = await res.json();
  return (data ?? []).map((m: { id: string; nombre?: string; slug?: string }) => ({
    id: m.id,
    nombre: m.nombre ?? "",
    slug: m.slug ?? "",
  }));
}

export async function getEmpresas(): Promise<Empresa[]> {
  const res = await fetch("/api/admin/empresas");
  if (!res.ok) throw new Error("Error al cargar empresas");
  return res.json();
}

export async function getModulos(): Promise<Modulo[]> {
  const res = await fetch("/api/admin/modulos");
  if (!res.ok) throw new Error("Error al cargar módulos");
  return res.json();
}

export interface CrearEmpresaData {
  nombre_empresa: string;
  plan?: string;
  ruc: string;
  estado: string;
  email: string;
  password: string;
  nombre: string;
  modulo_ids: string[];
}

export async function crearEmpresa(data: CrearEmpresaData): Promise<{ empresa_id: string }> {
  const res = await fetch("/api/admin/crear-empresa", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });

  const json = await res.json();
  if (!res.ok) {
    throw new Error(
      typeof json.error === "string" ? json.error : json.error?.message || "Error creando empresa"
    );
  }
  return json;
}

export interface EmpresaDetalle {
  empresa: Empresa;
  usuarios: { id: string; nombre: string; email: string; rol: string; created_at: string }[];
  modulos: { id: string; nombre: string; slug: string }[];
}

export async function getEmpresaById(id: string): Promise<EmpresaDetalle> {
  const res = await fetch(`/api/admin/empresas/${id}`, { cache: "no-store" });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(typeof json.error === "string" ? json.error : "Empresa no encontrada");
  }
  return json;
}

export interface ActualizarEmpresaData {
  nombre_empresa?: string;
  ruc?: string;
  plan?: string;
  estado?: string;
  modulo_ids?: string[];
}

export async function actualizarEmpresa(id: string, data: ActualizarEmpresaData): Promise<void> {
  const res = await fetch(`/api/admin/empresas/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });

  const json = await res.json();
  if (!res.ok) {
    throw new Error(
      typeof json.error === "string" ? json.error : json.error?.message || "Error actualizando empresa"
    );
  }
}
