"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import { AlertTriangle, Wallet } from "lucide-react";

type Item = {
  id: string;
  proveedor_nombre: string;
  numero_factura_proveedor: string | null;
  fecha_vencimiento: string | null;
  saldo: number;
  dias: number | null;
  vencida: boolean;
};
type Resumen = {
  vencidas: number;
  vencen_hoy: number;
  proximos_3: number;
  saldo_total: number;
  items: Item[];
};

function fmtGs(n: number) {
  return "Gs. " + Math.round(Number(n) || 0).toLocaleString("es-PY");
}
function fmtFecha(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return d && m && y ? `${d}/${m}` : iso;
}

/**
 * Card autónoma de facturas de proveedores por vencer (dashboard), por sucursal.
 * Lee su propio resumen de /api/cuentas-por-pagar/resumen. No altera el resto del
 * dashboard. Si no hay nada por vencer, no renderiza (evita ruido).
 */
export default function CuentasPorPagarResumenCard() {
  const [r, setR] = useState<Resumen | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancel = false;
    fetchWithSupabaseSession("/api/cuentas-por-pagar/resumen", { cache: "no-store" })
      .then((res) => res.json())
      .then((j) => {
        if (cancel) return;
        if (j?.success && j.data) setR(j.data as Resumen);
      })
      .catch(() => {})
      .finally(() => { if (!cancel) setLoaded(true); });
    return () => { cancel = true; };
  }, []);

  if (!loaded || !r || r.items.length === 0) return null;

  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50/60 p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-bold text-amber-900">
          <Wallet className="h-4 w-4" /> Facturas de proveedores por vencer
        </h3>
        <Link href="/compras/cuentas-por-pagar" className="text-xs font-semibold text-amber-700 hover:underline">
          Ver todas
        </Link>
      </div>

      <div className="mb-3 grid grid-cols-3 gap-2">
        <div className="rounded-lg bg-white/70 px-3 py-2 text-center">
          <div className="text-lg font-bold tabular-nums text-red-600">{r.vencidas}</div>
          <div className="text-[11px] font-medium text-slate-500">Vencidas</div>
        </div>
        <div className="rounded-lg bg-white/70 px-3 py-2 text-center">
          <div className="text-lg font-bold tabular-nums text-amber-700">{r.vencen_hoy}</div>
          <div className="text-[11px] font-medium text-slate-500">Vencen hoy</div>
        </div>
        <div className="rounded-lg bg-white/70 px-3 py-2 text-center">
          <div className="text-lg font-bold tabular-nums text-slate-700">{r.proximos_3}</div>
          <div className="text-[11px] font-medium text-slate-500">Próx. 3 días</div>
        </div>
      </div>

      <ul className="space-y-1">
        {r.items.slice(0, 5).map((it) => (
          <li key={it.id}>
            <Link href="/compras/cuentas-por-pagar" className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-white/60">
              <span className="min-w-0 flex-1 truncate text-slate-700">
                {it.vencida && <AlertTriangle className="mr-1 inline h-3.5 w-3.5 text-red-500" />}
                {it.proveedor_nombre}
                <span className="ml-1 text-xs text-slate-400">{it.numero_factura_proveedor || ""}</span>
              </span>
              <span className="shrink-0 text-xs text-slate-500">{fmtFecha(it.fecha_vencimiento)}</span>
              <span className="shrink-0 tabular-nums font-semibold text-slate-800">{fmtGs(it.saldo)}</span>
            </Link>
          </li>
        ))}
      </ul>

      <div className="mt-2 border-t border-amber-200 pt-2 text-right text-sm">
        <span className="text-slate-500">Saldo por vencer: </span>
        <span className="font-bold text-slate-900">{fmtGs(r.saldo_total)}</span>
      </div>
    </div>
  );
}
