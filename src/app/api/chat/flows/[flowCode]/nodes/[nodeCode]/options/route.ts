import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { getAuthWithRol } from "@/lib/middleware/auth";

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase no configurado");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function resolveNodeId(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  empresaId: string,
  flowCode: string,
  nodeCode: string
) {
  const { data, error } = await supabase
    .from("chat_flow_nodes")
    .select("id, node_type")
    .eq("empresa_id", empresaId)
    .eq("flow_code", flowCode)
    .eq("node_code", nodeCode)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { id: string; node_type: string } | null) ?? null;
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ flowCode: string; nodeCode: string }> }
) {
  try {
    const auth = await getAuthWithRol();
    if (!auth?.empresa_id) {
      return NextResponse.json({ ok: false, error: "No autenticado" }, { status: 401 });
    }
    const params = await context.params;
    const body = (await request.json().catch(() => ({}))) as {
      label?: string;
      meta_button_id?: string;
      next_node_code?: string | null;
      sort_order?: number;
      option_payload?: Record<string, unknown> | null;
    };
    const label = (body.label ?? "").trim();
    const metaButtonId = (body.meta_button_id ?? "").trim();
    if (!label || !metaButtonId) {
      return NextResponse.json({ ok: false, error: "label y meta_button_id requeridos" }, { status: 400 });
    }
    const supabase = getSupabaseAdmin();
    const node = await resolveNodeId(supabase, auth.empresa_id, params.flowCode, params.nodeCode);
    if (!node) return NextResponse.json({ ok: false, error: "Nodo no encontrado" }, { status: 404 });
    const nextNodeCode = body.next_node_code?.trim() || null;
    if ((node.node_type === "buttons" || node.node_type === "list") && !nextNodeCode) {
      return NextResponse.json(
        { ok: false, error: "Seleccioná 'Siguiente paso' para esta opción." },
        { status: 400 }
      );
    }
    const optionPayload =
      typeof body.option_payload === "object" && body.option_payload
        ? body.option_payload
        : {};
    const { data, error } = await supabase
      .from("chat_flow_options")
      .insert({
        node_id: node.id,
        label,
        option_value: metaButtonId,
        meta_button_id: metaButtonId,
        next_node_code: nextNodeCode,
        sort_order: Number.isFinite(body.sort_order) ? Math.trunc(body.sort_order as number) : 0,
        option_payload: optionPayload,
      })
      .select("id, node_id, label, option_value, meta_button_id, next_node_code, sort_order, option_payload")
      .single();
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    return NextResponse.json({ ok: true, item: data });
  } catch (e) {
    console.error("[api/chat/flows/:flowCode/nodes/:nodeCode/options][POST]", e);
    return NextResponse.json({ ok: false, error: "Error interno" }, { status: 500 });
  }
}
