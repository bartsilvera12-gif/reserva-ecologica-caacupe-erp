import { NextRequest, NextResponse } from "next/server";
import { getChatServiceClientForEmpresa } from "@/app/api/chat/_chat-service-client";
import { successResponse, errorResponse } from "@/lib/api/response";
import { requireCampanasApiAccess } from "@/lib/campaigns/campaign-auth";
import {
  buildMappedVariablesFromRow,
  mappingSatisfiedForTemplate,
  normalizeVariableMapping,
} from "@/lib/campaigns/campaign-mapping";

type RouteCtx = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, ctx: RouteCtx) {
  const auth = await requireCampanasApiAccess(request);
  if (!auth.ok) {
    return NextResponse.json(errorResponse(auth.message), { status: auth.status });
  }

  const { id: campaignId } = await ctx.params;

  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const sb = await getChatServiceClientForEmpresa(auth.empresaId);

    const { data: campaign, error: cErr } = await sb
      .from("chat_campaigns")
      .select("variable_mapping_json, template_components_json, status")
      .eq("id", campaignId)
      .eq("empresa_id", auth.empresaId)
      .maybeSingle();

    if (cErr || !campaign) {
      return NextResponse.json(errorResponse("Campaña no encontrada"), { status: 404 });
    }

    const mapping =
      body.variable_mapping_json && typeof body.variable_mapping_json === "object"
        ? normalizeVariableMapping(body.variable_mapping_json as Record<string, unknown>)
        : normalizeVariableMapping(
            ((campaign as { variable_mapping_json?: unknown }).variable_mapping_json ?? {}) as Record<
              string,
              unknown
            >
          );

    if (Object.keys(mapping).length > 0) {
      await sb
        .from("chat_campaigns")
        .update({
          variable_mapping_json: mapping,
          updated_at: new Date().toISOString(),
        })
        .eq("id", campaignId)
        .eq("empresa_id", auth.empresaId);
    }

    const tplComponents = (campaign as { template_components_json?: unknown }).template_components_json ?? [];

    const { data: recipients, error: rErr } = await sb
      .from("chat_campaign_recipients")
      .select("id, row_payload_json, status")
      .eq("campaign_id", campaignId)
      .eq("empresa_id", auth.empresaId);

    if (rErr) {
      return NextResponse.json(errorResponse(rErr.message), { status: 400 });
    }

    let mappingErrors = 0;
    const ts = new Date().toISOString();

    for (const rec of recipients ?? []) {
      const row = rec as {
        id: string;
        row_payload_json: Record<string, string>;
        status: string;
      };
      if (row.status === "invalid") continue;

      const payload = (row.row_payload_json ?? {}) as Record<string, string>;
      const mapped =
        Object.keys(mapping).length > 0
          ? buildMappedVariablesFromRow(payload, mapping)
          : {};

      const okMap =
        Object.keys(mapping).length === 0
          ? mappingSatisfiedForTemplate(tplComponents as unknown[], {})
          : mappingSatisfiedForTemplate(tplComponents as unknown[], mapped);

      if (!okMap) {
        mappingErrors += 1;
        await sb
          .from("chat_campaign_recipients")
          .update({
            status: "pending",
            mapped_variables_json: mapped,
            validation_error: "Faltan variables de plantilla",
            updated_at: ts,
          })
          .eq("id", row.id)
          .eq("empresa_id", auth.empresaId);
        continue;
      }

      await sb
        .from("chat_campaign_recipients")
        .update({
          mapped_variables_json: mapped,
          validation_error: null,
          status: "pending",
          updated_at: ts,
        })
        .eq("id", row.id)
        .eq("empresa_id", auth.empresaId);
    }

    await sb
      .from("chat_campaigns")
      .update({
        status: mappingErrors > 0 ? "draft" : "ready",
        updated_at: ts,
      })
      .eq("id", campaignId)
      .eq("empresa_id", auth.empresaId);

    await sb.from("chat_campaign_events").insert({
      empresa_id: auth.empresaId,
      campaign_id: campaignId,
      recipient_id: null,
      event_type: "import_validated",
      event_payload_json: { mapping_errors: mappingErrors },
    });

    return NextResponse.json(successResponse({ mapping_errors: mappingErrors, ready: mappingErrors === 0 }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
