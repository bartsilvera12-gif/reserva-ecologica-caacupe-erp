"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";

type CampaignDetail = Record<string, unknown> & {
  id: string;
  name: string;
  status: string;
  channel_id: string;
  queue_id: string | null;
  provider: string;
  template_name: string;
  template_language: string;
  template_components_json: unknown[];
  variable_mapping_json: Record<string, unknown>;
  total_count: number;
  sent_count: number;
  failed_count: number;
  replied_count: number;
};

type EvRow = {
  id: string;
  event_type: string;
  created_at: string;
  event_payload_json: unknown;
};

export default function CampanasDetailClient({ campaignId }: { campaignId: string }) {
  const [campaign, setCampaign] = useState<CampaignDetail | null>(null);
  const [events, setEvents] = useState<EvRow[]>([]);
  const [recipients, setRecipients] = useState<unknown[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [showEvents, setShowEvents] = useState(false);

  const load = useCallback(async () => {
    const res = await fetchWithSupabaseSession(`/api/campanas/${campaignId}`, { cache: "no-store" });
    const json = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      data?: { campaign: CampaignDetail; events: EvRow[] };
      error?: string;
    };
    if (!res.ok || !json.success || !json.data?.campaign) {
      setErr(json.error ?? "No se pudo cargar");
      setLoading(false);
      return;
    }
    setCampaign(json.data.campaign);
    setEvents(json.data.events ?? []);
    const vm = json.data.campaign.variable_mapping_json ?? {};
    const flat: Record<string, string> = {};
    for (const [k, v] of Object.entries(vm)) {
      const key = k.replace(/^\{\{|\}\}$/g, "").trim();
      flat[key] = String(v ?? "");
    }
    setMapping(flat);

    const rr = await fetchWithSupabaseSession(`/api/campanas/${campaignId}/recipients?limit=100`, {
      cache: "no-store",
    });
    const rj = (await rr.json().catch(() => ({}))) as {
      success?: boolean;
      data?: { recipients: unknown[] };
    };
    if (rr.ok && rj.success && rj.data?.recipients) setRecipients(rj.data.recipients);

    setLoading(false);
  }, [campaignId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!campaign || campaign.status !== "sending") return;
    const t = window.setInterval(() => {
      void (async () => {
        await fetchWithSupabaseSession("/api/campanas/process", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ campaign_id: campaignId }),
        });
        await load();
      })();
    }, 4000);
    return () => window.clearInterval(t);
  }, [campaign?.status, campaignId, load, campaign]);

  const slots = useMemo(() => {
    const vs = campaign?.template_components_json as unknown;
    if (!vs || !Array.isArray(vs)) return [] as string[];
    const body = (vs as { type?: string; text?: string }[]).find(
      (c) => String(c.type ?? "").toUpperCase() === "BODY"
    );
    const text = body?.text ?? "";
    const re = /\{\{(\d+)\}\}/g;
    const out: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) out.push(m[1]);
    return [...new Set(out)].sort((a, b) => Number(a) - Number(b));
  }, [campaign]);

  async function uploadFile(file: File) {
    setBusy(true);
    setErr(null);
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetchWithSupabaseSession(`/api/campanas/${campaignId}/import`, {
      method: "POST",
      body: fd,
    });
    const json = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
    setBusy(false);
    if (!res.ok || !json.success) {
      setErr(json.error ?? "Importación fallida");
      return;
    }
    await load();
  }

  async function validateMapping() {
    setBusy(true);
    setErr(null);
    const body: Record<string, string> = {};
    for (const [k, v] of Object.entries(mapping)) {
      body[k] = v;
    }
    const res = await fetchWithSupabaseSession(`/api/campanas/${campaignId}/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variable_mapping_json: body }),
    });
    const json = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
    setBusy(false);
    if (!res.ok || !json.success) {
      setErr(json.error ?? "Validación fallida");
      return;
    }
    await load();
  }

  async function launch() {
    setBusy(true);
    setErr(null);
    const res = await fetchWithSupabaseSession(`/api/campanas/${campaignId}/launch`, {
      method: "POST",
    });
    const json = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
    setBusy(false);
    if (!res.ok || !json.success) {
      setErr(json.error ?? "No se pudo iniciar envío");
      return;
    }
    await load();
  }

  async function cancelSend() {
    setBusy(true);
    const res = await fetchWithSupabaseSession(`/api/campanas/${campaignId}/cancel`, {
      method: "POST",
    });
    setBusy(false);
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      setErr(json.error ?? "No se pudo cancelar");
      return;
    }
    await load();
  }

  if (loading || !campaign) {
    return <div className="p-6 text-sm text-slate-500">Cargando…</div>;
  }

  const canImport = campaign.status === "draft" || campaign.status === "ready";
  const canLaunch = campaign.status === "draft" || campaign.status === "ready";

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div>
        <Link href="/dashboard/campanas" className="text-sm text-indigo-600 hover:underline">
          ← Campañas
        </Link>
        <h1 className="mt-2 text-xl font-semibold text-slate-900">{String(campaign.name)}</h1>
        <p className="text-sm text-slate-500">
          Estado: <strong>{String(campaign.status)}</strong> · Plantilla {String(campaign.template_name)} (
          {String(campaign.template_language)})
        </p>
      </div>

      {err ? <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div> : null}

      <div className="grid gap-4 sm:grid-cols-4">
        {[
          ["Total", campaign.total_count],
          ["Enviados", campaign.sent_count],
          ["Fallidos", campaign.failed_count],
          ["Respondieron", campaign.replied_count],
        ].map(([label, val]) => (
          <div key={String(label)} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="text-xs font-medium uppercase text-slate-500">{String(label)}</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{Number(val ?? 0)}</div>
          </div>
        ))}
      </div>

      <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">Importación (.xlsx / .csv)</h2>
        <input
          type="file"
          accept=".xlsx,.xls,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          disabled={!canImport || busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void uploadFile(f);
          }}
          className="block text-sm text-slate-600"
        />
        <p className="text-xs text-slate-500">Máximo 5.000 filas / 5 MB.</p>
      </section>

      {slots.length > 0 ? (
        <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900">Mapeo de variables → columnas Excel</h2>
          {slots.map((s) => (
            <label key={s} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="w-16 font-mono text-slate-600">{`{{${s}}}`}</span>
              <input
                className="flex-1 rounded border border-slate-300 px-2 py-1"
                value={mapping[s] ?? ""}
                onChange={(e) => setMapping((m) => ({ ...m, [s]: e.target.value }))}
              />
            </label>
          ))}
          <button
            type="button"
            disabled={busy || !canImport}
            onClick={() => void validateMapping()}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            Validar destinatarios
          </button>
        </section>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || !canLaunch}
          onClick={() => void launch()}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          Enviar ahora
        </button>
        <button
          type="button"
          disabled={busy || campaign.status !== "sending"}
          onClick={() => void cancelSend()}
          className="rounded-lg border border-red-300 px-4 py-2 text-sm font-medium text-red-800 hover:bg-red-50 disabled:opacity-50"
        >
          Cancelar envío
        </button>
      </div>

      <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <h2 className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-900">
          Destinatarios (primeras filas)
        </h2>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-100 text-xs">
            <thead className="bg-slate-50 text-left text-slate-600">
              <tr>
                <th className="px-3 py-2">#</th>
                <th className="px-3 py-2">Teléfono</th>
                <th className="px-3 py-2">Estado</th>
                <th className="px-3 py-2">wa_id</th>
                <th className="px-3 py-2">Respuesta</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(recipients as Record<string, unknown>[]).map((r) => (
                <tr key={String(r.id)}>
                  <td className="px-3 py-2 tabular-nums">{Number(r.row_number)}</td>
                  <td className="px-3 py-2 font-mono text-[11px]">{String(r.phone_e164)}</td>
                  <td className="px-3 py-2">{String(r.status)}</td>
                  <td className="max-w-[140px] truncate px-3 py-2 font-mono text-[10px] text-slate-500">
                    {r.provider_message_id ? String(r.provider_message_id) : "—"}
                  </td>
                  <td className="px-3 py-2">{r.first_reply_at ? String(r.first_reply_at).slice(0, 19) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <button
          type="button"
          className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-semibold text-slate-900"
          onClick={() => setShowEvents((v) => !v)}
        >
          Eventos ({events.length})
          <span className="text-slate-400">{showEvents ? "▼" : "▶"}</span>
        </button>
        {showEvents ? (
          <ul className="divide-y divide-slate-100 border-t border-slate-100 px-4 py-2 text-xs text-slate-700">
            {events.map((ev) => (
              <li key={ev.id} className="py-2">
                <span className="font-medium text-slate-900">{ev.event_type}</span> ·{" "}
                {ev.created_at.slice(0, 19)}
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
