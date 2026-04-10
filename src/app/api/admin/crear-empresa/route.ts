import { createClient } from "@supabase/supabase-js";
import { supabaseServiceRoleClientOptions } from "@/lib/supabase/schema";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      nombre_empresa,
      plan,
      ruc,
      estado,
      email,
      password,
      nombre,
      modulo_ids,
      schema_slug,
    } = body;

    if (!nombre_empresa?.trim() || !email?.trim() || !password?.trim() || !nombre?.trim()) {
      return NextResponse.json(
        { error: "nombre_empresa, email, password y nombre son requeridos" },
        { status: 400 }
      );
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      return NextResponse.json(
        { error: "Variables de entorno no configuradas" },
        { status: 500 }
      );
    }

    const supabase = createClient(url, key, { ...supabaseServiceRoleClientOptions });

    // 1 — Insertar empresa
    const { data: empresa, error: errEmpresa } = await supabase
      .from("empresas")
      .insert([{
        nombre_empresa: nombre_empresa.trim(),
        plan: plan?.trim() || null,
        ruc: ruc?.trim() || null,
        estado: estado || "activo",
      }])
      .select("id")
      .single();

    if (errEmpresa) {
      return NextResponse.json({ error: errEmpresa.message }, { status: 400 });
    }

    const empresaId = empresa.id;

    const slugFuente =
      typeof schema_slug === "string" && schema_slug.trim()
        ? schema_slug.trim()
        : nombre_empresa.trim();

    const { data: provisionJson, error: provErr } = await supabase.rpc(
      "neura_provision_empresa_data_schema",
      { p_empresa_id: empresaId, p_schema_slug: slugFuente }
    );

    if (provErr) {
      await supabase.from("empresas").delete().eq("id", empresaId);
      return NextResponse.json(
        { error: `Provisión de esquema: ${provErr.message}` },
        { status: 500 }
      );
    }

    const prov = provisionJson as { ok?: boolean; status?: string } | null;
    if (prov && prov.ok === false) {
      await supabase.from("empresas").delete().eq("id", empresaId);
      return NextResponse.json(
        { error: "No se pudo provisionar el esquema de datos de la empresa." },
        { status: 500 }
      );
    }

    // 2 — Crear usuario en Supabase Auth
    const { data: authData, error: errAuth } = await supabase.auth.admin.createUser({
      email: email.trim().toLowerCase(),
      password,
      email_confirm: true,
    });

    if (errAuth) {
      await supabase.from("empresas").delete().eq("id", empresaId);
      return NextResponse.json({ error: errAuth.message }, { status: 400 });
    }

    // 3 — Insertar en tabla usuarios (auth_user_id para actualización fiable de email)
    const { error: errUsuario } = await supabase.from("usuarios").insert([{
      empresa_id: empresaId,
      nombre: nombre.trim(),
      email: email.trim().toLowerCase(),
      rol: "admin",
      auth_user_id: authData.user?.id ?? null,
    }]);

    if (errUsuario) {
      await supabase.from("empresas").delete().eq("id", empresaId);
      return NextResponse.json({ error: errUsuario.message }, { status: 400 });
    }

    const moduloIds = [...new Set(Array.isArray(modulo_ids) ? modulo_ids : [])];

    const { data: emExistentes } = await supabase
      .from("empresa_modulos")
      .select("modulo_id")
      .eq("empresa_id", empresaId);
    const yaInsertados = new Set((emExistentes ?? []).map((r) => r.modulo_id as string));
    const faltan = moduloIds.filter((id) => !yaInsertados.has(id));

    if (faltan.length > 0) {
      const rows = faltan.map((modulo_id: string) => ({
        empresa_id: empresaId,
        modulo_id,
        activo: true,
      }));
      const { error: errModulos } = await supabase.from("empresa_modulos").insert(rows);
      if (errModulos) {
        return NextResponse.json(
          { error: `Empresa creada pero error en módulos: ${errModulos.message}` },
          { status: 400 }
        );
      }
    }

    return NextResponse.json({
      empresa_id: empresaId,
      usuario_id: authData.user?.id,
    });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Error interno";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
