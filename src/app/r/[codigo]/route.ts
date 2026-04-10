import { createHash, randomBytes } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service-admin";
import { createServiceRoleClientWithDbSchema } from "@/lib/supabase/empresa-data-schema";
import type { AppSupabaseClient } from "@/lib/supabase/schema";

export const dynamic = "force-dynamic";

function digitsOnly(s: string): string {
  return s.replace(/\D/g, "");
}

async function resolveRedirectPhoneForEmpresa(
  supabase: AppSupabaseClient,
  empresaId: string
): Promise<{ ok: true; phone: string } | { ok: false; message: string }> {
  const envPhone = digitsOnly(
    process.env.WHATSAPP_LINK_PHONE_NUMBER?.trim() ||
      process.env.NEXT_PUBLIC_WHATSAPP_LINK_PHONE_NUMBER?.trim() ||
      ""
  );

  const { data: channels, error: chErr } = await supabase
    .from("chat_channels")
    .select("id, activo, config")
    .eq("empresa_id", empresaId)
    .eq("type", "whatsapp")
    .eq("activo", true);

  if (chErr) {
    return { ok: false, message: `No se pudo validar el canal WhatsApp: ${chErr.message}` };
  }

  const numbers = new Set<string>();
  for (const ch of channels ?? []) {
    const cfg = (ch as { config?: unknown }).config;
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) continue;
    const raw = (cfg as Record<string, unknown>).display_phone_number;
    if (typeof raw !== "string") continue;
    const d = digitsOnly(raw);
    if (d.length >= 8) numbers.add(d);
  }

  if (numbers.size === 0) {
    return {
      ok: false,
      message:
        "No hay display_phone_number válido en chat_channels activos. Configurá el número visible del canal WhatsApp.",
    };
  }

  if (envPhone) {
    if (!numbers.has(envPhone)) {
      return {
        ok: false,
        message:
          "WHATSAPP_LINK_PHONE_NUMBER no coincide con ningún chat_channels activo de la empresa.",
      };
    }
    return { ok: true, phone: envPhone };
  }

  if (numbers.size === 1) {
    return { ok: true, phone: [...numbers][0] };
  }

  return {
    ok: false,
    message:
      "Hay múltiples canales activos con distintos display_phone_number. Definí WHATSAPP_LINK_PHONE_NUMBER para elegir uno válido.",
  };
}

/**
 * Landing pública: registra click + token opaco y redirige a WhatsApp.
 * URL oficial: /r/{codigo}?sorteo={uuid}
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ codigo: string }> }
) {
  const { codigo: codigoRaw } = await context.params;
  const codigo = decodeURIComponent(codigoRaw ?? "").trim();
  const sorteoId = request.nextUrl.searchParams.get("sorteo")?.trim() ?? "";
  if (!codigo || !sorteoId) {
    return new NextResponse("Falta código en la ruta o sorteo en ?sorteo=uuid", {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  let catalog;
  try {
    catalog = createServiceRoleClient();
  } catch {
    return new NextResponse("Servidor sin credenciales Supabase (service role).", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const { data: resolved, error: rpcErr } = await catalog.rpc("neura_resolve_sorteo_revendedor_public", {
    p_sorteo_id: sorteoId,
    p_codigo: codigo,
  });

  type ResolvedRow = { empresa_id?: string; data_schema?: string; revendedor_id?: string };
  type RevRow = {
    id: string;
    empresa_id: string;
    sorteo_id: string;
    codigo_referido: string;
    activo: boolean;
  };
  const hit = (resolved as ResolvedRow | null) ?? null;

  let dataSupabase: AppSupabaseClient = catalog;
  let row: RevRow | null = null;

  if (!rpcErr && hit?.empresa_id && hit?.data_schema && hit?.revendedor_id) {
    dataSupabase = createServiceRoleClientWithDbSchema(hit.data_schema) as AppSupabaseClient;
    row = {
      id: hit.revendedor_id,
      empresa_id: hit.empresa_id,
      sorteo_id: sorteoId,
      codigo_referido: codigo,
      activo: true,
    };
  } else {
    const { data: rev, error: rErr } = await catalog
      .from("sorteo_revendedores")
      .select("id, empresa_id, sorteo_id, codigo_referido, activo")
      .eq("sorteo_id", sorteoId)
      .ilike("codigo_referido", codigo)
      .eq("activo", true)
      .maybeSingle();

    if (rErr || !rev) {
      return new NextResponse("Enlace inválido o revendedor inactivo.", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    row = rev as RevRow;
  }

  if (!row) {
    return new NextResponse("Enlace inválido o revendedor inactivo.", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const redirectPhoneResult = await resolveRedirectPhoneForEmpresa(dataSupabase, row.empresa_id);
  if (!redirectPhoneResult.ok) {
    return new NextResponse(redirectPhoneResult.message, {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const token = randomBytes(18).toString("base64url");
  const ua = request.headers.get("user-agent") ?? "";
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "";
  const ipHash = ip ? createHash("sha256").update(ip).digest("hex").slice(0, 32) : null;

  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const { error: insErr } = await dataSupabase.from("sorteo_revendedor_clicks").insert({
    empresa_id: row.empresa_id,
    sorteo_id: row.sorteo_id,
    revendedor_id: row.id,
    attribution_token: token,
    user_agent: ua.slice(0, 512),
    ip_hash: ipHash,
    expires_at: expires,
  });

  if (insErr) {
    console.error("[sorteo-r]", insErr.message);
    return new NextResponse("No se pudo registrar el click.", {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const text = `Hola quiero comprar boletas ref=${token}`;
  const waUrl = `https://wa.me/${redirectPhoneResult.phone}?text=${encodeURIComponent(text)}`;
  return NextResponse.redirect(waUrl, 302);
}
