import { supabaseServiceRoleClientOptions } from "@/lib/supabase/schema";
import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { getServiceAuthUsuario } from "@/lib/auth/get-service-auth-usuario";
import {
  esRolAdminEmpresa,
  filterModuloIdsForEmpresa,
} from "@/lib/modulos/resolve-effective-modules";

const ERP_ROLES = ["usuario", "supervisor", "administrador"] as const;

function patchOptionalDecimal(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/\./g, "").replace(/\s/g, ""));
  return Number.isFinite(n) ? n : null;
}

function patchNullableDate(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  return String(v);
}

function patchNullableContrato(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const s = String(v).trim().toLowerCase();
  const ok = ["salario", "comision", "mixto", "prestador_servicio"].includes(s);
  return ok ? s : null;
}

function patchNullableArea(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const s = String(v).trim().toLowerCase();
  const ok = ["ventas", "soporte", "finanzas", "operaciones", "administracion"].includes(s);
  return ok ? s : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getAuthUserId(supabase: any, usuario: { auth_user_id?: string | null; email?: string }): Promise<string | null> {
  if (usuario.auth_user_id) return usuario.auth_user_id;
  const emailBuscado = (usuario.email ?? "").trim().toLowerCase();
  if (!emailBuscado) return null;
  let page = 1;
  while (true) {
    const { data } = await supabase.auth.admin.listUsers({ page, perPage: 500 });
    const users = data?.users ?? [];
    const found = users.find((u: { id: string; email?: string }) => (u.email ?? "").toLowerCase() === emailBuscado);
    if (found) return found.id;
    if (users.length < 500) break;
    page++;
  }
  return null;
}

/** Obtiene un usuario. Solo si pertenece a la empresa del usuario autenticado (o super_admin). */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) {
      return NextResponse.json({ error: "Config no disponible" }, { status: 500 });
    }

    const authR = await getServiceAuthUsuario(request);
    if (!authR.ok) {
      return NextResponse.json({ error: "No autenticado" }, { status: authR.status });
    }
    if (!authR.catalogUsuario) {
      return NextResponse.json({ error: "Perfil no encontrado" }, { status: 403 });
    }

    const supabase = createClient(url, serviceKey, { ...supabaseServiceRoleClientOptions });
    const currentUser = {
      empresa_id: authR.catalogUsuario.empresa_id ?? undefined,
      rol: authR.catalogUsuario.rol ?? undefined,
    };

    const { data: usuario, error } = await supabase
      .from("usuarios")
      .select(
        "id, nombre, email, telefono, fecha_nacimiento, fecha_ingreso, tipo_contrato, salario_base, porcentaje_comision, ips, area, rol, estado, created_at, empresa_id"
      )
      .eq("id", id)
      .single();

    if (error || !usuario) {
      return NextResponse.json({ error: "Usuario no encontrado" }, { status: 404 });
    }

    if (currentUser?.rol !== "super_admin" && usuario.empresa_id !== currentUser?.empresa_id) {
      return NextResponse.json({ error: "Sin permiso" }, { status: 403 });
    }

    let modulo_ids: string[] = [];
    let modulos_empresa: { id: string; nombre: string; slug: string }[] = [];

    if (usuario.empresa_id) {
      const { data: emData } = await supabase
        .from("empresa_modulos")
        .select("modulo_id")
        .eq("empresa_id", usuario.empresa_id)
        .eq("activo", true);
      const mids = (emData ?? []).map((r) => r.modulo_id as string).filter(Boolean);
      if (mids.length > 0) {
        const { data: modRows } = await supabase
          .from("modulos")
          .select("id, nombre, slug")
          .in("id", mids)
          .order("slug");
        modulos_empresa = (modRows ?? []).map((m) => ({
          id: m.id as string,
          nombre: (m.nombre as string) ?? "",
          slug: (m.slug as string) ?? "",
        }));
      }

      const { data: umData } = await supabase
        .from("usuario_modulos")
        .select("modulo_id")
        .eq("usuario_id", id);
      modulo_ids = (umData ?? []).map((r) => (r as { modulo_id: string }).modulo_id);
      if (esRolAdminEmpresa(usuario.rol)) {
        modulo_ids = mids;
      }
    }

    const es_admin_empresa = esRolAdminEmpresa(usuario.rol);

    const puede_editar_modulos =
      (currentUser?.rol ?? "").trim() === "super_admin" ||
      ["admin", "administrador"].includes((currentUser?.rol ?? "").trim());

    const puede_editar_rol =
      (currentUser?.rol ?? "").trim() === "super_admin" ||
      ["admin", "administrador"].includes((currentUser?.rol ?? "").trim());

    const { empresa_id: _e, ...rest } = usuario;
    return NextResponse.json({
      ...rest,
      modulo_ids,
      modulos_empresa,
      puede_editar_modulos,
      puede_editar_rol,
      es_admin_empresa,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/** Actualiza un usuario. Solo si pertenece a la empresa del usuario autenticado (o super_admin). */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) {
      return NextResponse.json({ error: "Config no disponible" }, { status: 500 });
    }

    const authR = await getServiceAuthUsuario(req);
    if (!authR.ok) {
      return NextResponse.json({ error: "No autenticado" }, { status: authR.status });
    }
    if (!authR.catalogUsuario) {
      return NextResponse.json({ error: "Perfil no encontrado" }, { status: 403 });
    }

    const supabase = createClient(url, serviceKey, { ...supabaseServiceRoleClientOptions });
    const currentUser = {
      empresa_id: authR.catalogUsuario.empresa_id ?? undefined,
      rol: authR.catalogUsuario.rol ?? undefined,
    };

    const body = await req.json();
    const moduloIdsProvided = Object.prototype.hasOwnProperty.call(body, "modulo_ids");
    const {
      nombre,
      email,
      telefono,
      fecha_nacimiento,
      fecha_ingreso,
      tipo_contrato,
      salario_base,
      porcentaje_comision,
      ips,
      area,
      estado,
      modulo_ids,
      rol: rolBody,
    } = body;

    const { data: usuario, error: errGet } = await supabase
      .from("usuarios")
      .select("id, email, estado, auth_user_id, empresa_id, rol")
      .eq("id", id)
      .single();

    if (errGet || !usuario) {
      return NextResponse.json({ error: "Usuario no encontrado" }, { status: 404 });
    }

    if (currentUser?.rol !== "super_admin" && usuario.empresa_id !== currentUser?.empresa_id) {
      return NextResponse.json({ error: "Sin permiso para editar este usuario" }, { status: 403 });
    }

    const rolEditor = (currentUser?.rol ?? "").trim();
    const puedeModulos =
      rolEditor === "super_admin" || ["admin", "administrador"].includes(rolEditor);

    const puede_editar_rol =
      rolEditor === "super_admin" || ["admin", "administrador"].includes(rolEditor);

    if (Array.isArray(modulo_ids) && !puedeModulos) {
      return NextResponse.json({ error: "Sin permiso para asignar módulos" }, { status: 403 });
    }

    if (rolBody !== undefined && !puede_editar_rol) {
      return NextResponse.json({ error: "Sin permiso para cambiar el nivel de acceso" }, { status: 403 });
    }

    const rolNormalizado =
      rolBody !== undefined ? String(rolBody).trim().toLowerCase() : undefined;
    if (
      rolNormalizado !== undefined &&
      !(ERP_ROLES as readonly string[]).includes(rolNormalizado)
    ) {
      return NextResponse.json({ error: "Rol inválido" }, { status: 400 });
    }

    const finalRol =
      rolNormalizado !== undefined ? rolNormalizado : String(usuario.rol ?? "usuario").trim().toLowerCase();

    const authUserId = await getAuthUserId(supabase, usuario);

    const updates: Record<string, unknown> = {};
    if (nombre !== undefined) updates.nombre = nombre;
    if (estado !== undefined) updates.estado = estado;
    if (telefono !== undefined) updates.telefono = telefono || null;
    if (fecha_nacimiento !== undefined) updates.fecha_nacimiento = fecha_nacimiento || null;

    const pi = patchOptionalDecimal(porcentaje_comision);
    if (pi !== undefined) {
      if (pi !== null && (pi < 0 || pi > 100)) {
        return NextResponse.json({ error: "Comisión debe estar entre 0 y 100." }, { status: 400 });
      }
      updates.porcentaje_comision = pi;
    }

    const sb = patchOptionalDecimal(salario_base);
    if (sb !== undefined) updates.salario_base = sb;

    const fi = patchNullableDate(fecha_ingreso);
    if (fi !== undefined) updates.fecha_ingreso = fi;

    const tc = patchNullableContrato(tipo_contrato);
    if (tc !== undefined) updates.tipo_contrato = tc;

    const ar = patchNullableArea(area);
    if (ar !== undefined) updates.area = ar;

    if (ips !== undefined) updates.ips = Boolean(ips);

    if (rolNormalizado !== undefined) updates.rol = rolNormalizado;

    if (estado !== undefined && authUserId) {
      const banDuration = estado === "inactivo" ? "876000h" : "none";
      await supabase.auth.admin.updateUserById(authUserId, {
        ban_duration: banDuration,
      } as { ban_duration?: string });
    }

    const nuevoEmail = email !== undefined ? email.trim().toLowerCase() : null;
    const emailCambia = nuevoEmail !== null && nuevoEmail !== (usuario.email ?? "");

    if (emailCambia) {
      if (!authUserId) {
        return NextResponse.json(
          { error: "No se puede cambiar el email: usuario de autenticación no encontrado." },
          { status: 400 }
        );
      }
      const { error: errAuth } = await supabase.auth.admin.updateUserById(authUserId, {
        email: nuevoEmail,
        email_confirm: true,
      });
      if (errAuth) {
        return NextResponse.json({ error: `Error al actualizar email: ${errAuth.message}` }, { status: 400 });
      }
      updates.email = nuevoEmail;
      if (!usuario.auth_user_id) updates.auth_user_id = authUserId;
    }

    if (Object.keys(updates).length > 0) {
      const { error: errUpdate } = await supabase.from("usuarios").update(updates).eq("id", id);
      if (errUpdate) {
        return NextResponse.json({ error: errUpdate.message }, { status: 400 });
      }
    }

    if (usuario.empresa_id && rolNormalizado !== undefined) {
      const oldWasAdmin = esRolAdminEmpresa(usuario.rol);
      const newIsAdmin = esRolAdminEmpresa(finalRol);

      if (!oldWasAdmin && newIsAdmin) {
        const { error: errDelA } = await supabase.from("usuario_modulos").delete().eq("usuario_id", id);
        if (errDelA) return NextResponse.json({ error: errDelA.message }, { status: 400 });
      } else if (oldWasAdmin && !newIsAdmin) {
        const { error: errDelD } = await supabase.from("usuario_modulos").delete().eq("usuario_id", id);
        if (errDelD) return NextResponse.json({ error: errDelD.message }, { status: 400 });
        if (!moduloIdsProvided) {
          const { data: emActivos } = await supabase
            .from("empresa_modulos")
            .select("modulo_id")
            .eq("empresa_id", usuario.empresa_id)
            .eq("activo", true);
          const umRows = (emActivos ?? []).map((r) => ({
            usuario_id: id,
            modulo_id: r.modulo_id as string,
          }));
          if (umRows.length > 0) {
            const { error: errInsS } = await supabase.from("usuario_modulos").insert(umRows);
            if (errInsS) return NextResponse.json({ error: errInsS.message }, { status: 400 });
          }
        }
      }
    }

    if (Array.isArray(modulo_ids) && usuario.empresa_id && !esRolAdminEmpresa(finalRol)) {
      const validIds = await filterModuloIdsForEmpresa(supabase, usuario.empresa_id, modulo_ids);
      const { error: errDel } = await supabase.from("usuario_modulos").delete().eq("usuario_id", id);
      if (errDel) {
        return NextResponse.json({ error: errDel.message }, { status: 400 });
      }
      if (validIds.length > 0) {
        const rows = validIds.map((modulo_id: string) => ({ usuario_id: id, modulo_id }));
        const { error: errIns } = await supabase.from("usuario_modulos").insert(rows);
        if (errIns) {
          return NextResponse.json({ error: errIns.message }, { status: 400 });
        }
      }
    }

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
