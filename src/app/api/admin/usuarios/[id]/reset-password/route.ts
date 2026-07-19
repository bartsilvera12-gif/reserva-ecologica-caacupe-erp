import { createClient } from "@supabase/supabase-js";
import { supabaseServiceRoleClientOptions } from "@/lib/supabase/schema";
import { NextResponse } from "next/server";
import { requireAdminEmpresa, usuarioDeLaMismaEmpresa } from "@/lib/auth/require-admin-empresa";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Sin este guard el endpoint permitia cambiar la contrasena de CUALQUIER
    // usuario con solo conocer su UUID: no habia autenticacion de ningun tipo.
    const guard = await requireAdminEmpresa(req);
    if (!guard.ok) return guard.response;

    const { id } = await params;
    const body = await req.json();
    const { password } = body;

    if (!password || typeof password !== "string" || password.length < 6) {
      return NextResponse.json(
        { error: "La contraseña debe tener al menos 6 caracteres" },
        { status: 400 }
      );
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      return NextResponse.json({ error: "Config no disponible" }, { status: 500 });
    }

    const supabase = createClient(url, key, { ...supabaseServiceRoleClientOptions });

    // El objetivo tiene que ser de la MISMA empresa que el admin que llama.
    const objetivo = await usuarioDeLaMismaEmpresa(supabase, id, guard.auth.empresa_id);
    if (!objetivo.ok) return objetivo.response;

    const { data: authUsers } = await supabase.auth.admin.listUsers();
    const authUser = authUsers?.users?.find((u) => u.email === objetivo.email);

    if (!authUser) {
      return NextResponse.json(
        { error: "No se encontró el usuario en Auth. Verifique que el email coincida." },
        { status: 404 }
      );
    }

    const { error: errAuth } = await supabase.auth.admin.updateUserById(authUser.id, {
      password,
    });

    if (errAuth) {
      return NextResponse.json({ error: errAuth.message }, { status: 400 });
    }

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
