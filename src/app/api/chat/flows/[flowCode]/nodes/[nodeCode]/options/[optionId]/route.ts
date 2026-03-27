import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { getAuthWithRol } from "@/lib/middleware/auth";

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase no configurado");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ optionId: string }> }
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
    const patch: Record<string, unknown> = {};
    if (typeof body.label === "string") patch.label = body.label.trim();
    if (typeof body.meta_button_id === "string") {
      const id = body.meta_button_id.trim();
      patch.meta_button_id = id;
      patch.option_value = id;
    }
    if ("next_node_code" in body) patch.next_node_code = body.next_node_code?.trim() || null;
    if (Number.isFinite(body.sort_order)) patch.sort_order = Math.trunc(body.sort_order as number);
    if ("option_payload" in body) {
      patch.option_payload =
        typeof body.option_payload === "object" && body.option_payload
          ? body.option_payload
          : {};
    }

    const supabase = getSupabaseAdmin();
    const { data: currentOption, error: currentErr } = await supabase
      .from("chat_flow_options")
      .select("node_id, next_node_code")
      .eq("id", params.optionId)
      .maybeSingle();
    if (currentErr) return NextResponse.json({ ok: false, error: currentErr.message }, { status: 400 });
    if (!currentOption) return NextResponse.json({ ok: false, error: "Opción no encontrada" }, { status: 404 });

    const { data: parentNode, error: parentErr } = await supabase
      .from("chat_flow_nodes")
      .select("node_type")
      .eq("id", currentOption.node_id as string)
      .eq("empresa_id", auth.empresa_id)
      .maybeSingle();
    if (parentErr) return NextResponse.json({ ok: false, error: parentErr.message }, { status: 400 });
    if (!parentNode) return NextResponse.json({ ok: false, error: "Nodo padre no encontrado" }, { status: 404 });

    const targetNextNodeCode =
      "next_node_code" in patch
        ? ((patch.next_node_code as string | null | undefined)?.trim() || null)
        : ((currentOption.next_node_code as string | null | undefined)?.trim() || null);
    if ((parentNode.node_type === "buttons" || parentNode.node_type === "list") && !targetNextNodeCode) {
      return NextResponse.json(
        { ok: false, error: "Seleccioná 'Siguiente paso' para esta opción." },
        { status: 400 }
      );
    }

    const { data, error } = await supabase
      .from("chat_flow_options")
      .update(patch)
      .eq("id", params.optionId)
      .select("id, node_id, label, option_value, meta_button_id, next_node_code, sort_order, option_payload")
      .maybeSingle();
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    if (!data) return NextResponse.json({ ok: false, error: "Opción no encontrada" }, { status: 404 });
    return NextResponse.json({ ok: true, item: data });
  } catch (e) {
    console.error("[api/chat/flows/.../options/:optionId][PATCH]", e);
    return NextResponse.json({ ok: false, error: "Error interno" }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ optionId: string }> }
) {
  try {
    const auth = await getAuthWithRol();
    if (!auth?.empresa_id) {
      return NextResponse.json({ ok: false, error: "No autenticado" }, { status: 401 });
    }
    const params = await context.params;
    const supabase = getSupabaseAdmin();
    const { error } = await supabase.from("chat_flow_options").delete().eq("id", params.optionId);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[api/chat/flows/.../options/:optionId][DELETE]", e);
    return NextResponse.json({ ok: false, error: "Error interno" }, { status: 500 });
  }
}
