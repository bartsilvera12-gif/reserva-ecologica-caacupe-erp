import { createClient } from "@supabase/supabase-js";
import { supabaseServiceRoleClientOptions } from "@/lib/supabase/schema";
import { NextResponse } from "next/server";
import { requireAdminEmpresa } from "@/lib/auth/require-admin-empresa";

export async function GET(request: Request) {
  try {
    // Listaba TODAS las empresas del sistema sin autenticacion alguna.
    const guard = await requireAdminEmpresa(request);
    if (!guard.ok) return guard.response;

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      return NextResponse.json({ error: "Config no disponible" }, { status: 500 });
    }

    const supabase = createClient(url, key, { ...supabaseServiceRoleClientOptions });

    // Un admin de empresa solo ve la suya; super_admin ve todas.
    let q = supabase.from("empresas").select("*").order("created_at", { ascending: false });
    if (guard.auth.rol !== "super_admin") q = q.eq("id", guard.auth.empresa_id);
    const { data, error } = await q;

    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json(data);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
