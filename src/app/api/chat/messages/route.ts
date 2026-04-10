import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";

/**
 * GET /api/chat/messages?conversation_id=…
 * Historial de mensajes de una conversación de la empresa (service role).
 */
export async function GET(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const conversationId = request.nextUrl.searchParams.get("conversation_id")?.trim() ?? "";
    if (!conversationId) {
      return NextResponse.json(errorResponse("conversation_id requerido"), { status: 400 });
    }

    const { supabase, auth } = ctx;
    const { data: conv, error: cErr } = await supabase
      .from("chat_conversations")
      .select("id")
      .eq("id", conversationId)
      .eq("empresa_id", auth.empresa_id)
      .maybeSingle();

    if (cErr) {
      return NextResponse.json(errorResponse(cErr.message), { status: 400 });
    }
    if (!conv) {
      return NextResponse.json(errorResponse("Conversación no encontrada"), { status: 404 });
    }

    const { data, error } = await supabase
      .from("chat_messages")
      .select("id, from_me, message_type, content, raw_payload, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });

    if (error) {
      return NextResponse.json(errorResponse(error.message), { status: 400 });
    }
    return NextResponse.json(successResponse(data ?? []));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
