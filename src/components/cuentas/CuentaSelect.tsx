"use client";

import { useEffect, useState } from "react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";

export type CuentaOpcion = { id: string; nombre: string; tipo: string; entidad_bancaria_id?: string | null };

/** Cuentas activas (bancos y caja chica) de la empresa. `cargado` = ya respondió el servidor. */
export function useCuentasActivas(): { cuentas: CuentaOpcion[]; cargado: boolean } {
  const [cuentas, setCuentas] = useState<CuentaOpcion[]>([]);
  const [cargado, setCargado] = useState(false);
  useEffect(() => {
    let cancel = false;
    fetchWithSupabaseSession("/api/cuentas?lista=1", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (!cancel && j?.success) setCuentas(j.data?.cuentas ?? []);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancel) setCargado(true);
      });
    return () => {
      cancel = true;
    };
  }, []);
  return { cuentas, cargado };
}

type Props = {
  value: string;
  onChange: (id: string) => void;
  cuentas: CuentaOpcion[];
  label?: string;
  required?: boolean;
  labelClassName?: string;
  className?: string;
  /** Solo muestra las cuentas de este tipo (ej. "banco"). */
  soloTipo?: "banco" | "caja_chica";
};

/** Selector de cuenta (Continental, Bancop, Caja chica…). No muestra nada si la empresa no tiene cuentas. */
export default function CuentaSelect({
  value,
  onChange,
  cuentas,
  label = "Cuenta",
  required,
  labelClassName = "block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1",
  className = "w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0EA5E9] bg-white",
  soloTipo,
}: Props) {
  const lista = soloTipo ? cuentas.filter((c) => c.tipo === soloTipo) : cuentas;
  if (lista.length === 0) return null;
  return (
    <div>
      <label className={labelClassName}>
        {label}
        {required ? " *" : ""}
      </label>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={className} required={required}>
        <option value="">Elegí una cuenta…</option>
        {lista.map((c) => (
          <option key={c.id} value={c.id}>
            {c.nombre}
          </option>
        ))}
      </select>
    </div>
  );
}
