"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, Check, ChevronDown } from "lucide-react";
import { getProveedores } from "@/lib/proveedores/storage";
import type { Proveedor } from "@/lib/proveedores/types";

/**
 * Selector de proveedor buscable (nombre / razón social / RUC). Carga los
 * proveedores activos una vez y filtra en cliente. Devuelve id + nombre.
 */
export default function ProveedorPicker({
  value,
  onChange,
  placeholder = "Buscar proveedor por nombre o RUC…",
}: {
  value: string;
  onChange: (id: string, nombre: string) => void;
  placeholder?: string;
}) {
  const [proveedores, setProveedores] = useState<Proveedor[]>([]);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getProveedores()
      .then((ps) => setProveedores((ps ?? []).filter((p) => p.estado !== "inactivo")))
      .catch(() => setProveedores([]));
  }, []);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const seleccionado = useMemo(() => proveedores.find((p) => String(p.id) === value) ?? null, [proveedores, value]);

  const resultados = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return proveedores.slice(0, 30);
    return proveedores
      .filter((p) =>
        p.nombre.toLowerCase().includes(t) ||
        (p.razon_social ?? "").toLowerCase().includes(t) ||
        (p.ruc ?? "").toLowerCase().includes(t)
      )
      .slice(0, 30);
  }, [proveedores, q]);

  function elegir(p: Proveedor) {
    onChange(String(p.id), p.nombre);
    setQ("");
    setOpen(false);
    setHighlight(-1);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setHighlight((h) => Math.min(h + 1, resultados.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const sel = resultados[highlight] ?? resultados[0]; if (sel) elegir(sel); }
    else if (e.key === "Escape") { setOpen(false); setHighlight(-1); }
  }

  return (
    <div ref={boxRef} className="relative">
      {seleccionado && !open ? (
        <button
          type="button"
          onClick={() => { setOpen(true); setQ(""); }}
          className="flex w-full items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-left text-sm outline-none focus:ring-2 focus:ring-[#4FAEB2]/30"
        >
          <span className="min-w-0 truncate">
            <span className="font-semibold text-slate-800">{seleccionado.nombre}</span>
            {seleccionado.ruc && <span className="ml-2 text-xs text-slate-400">RUC {seleccionado.ruc}</span>}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
        </button>
      ) : (
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#4FAEB2]" />
          <input
            value={q}
            onChange={(e) => { setQ(e.target.value); setOpen(true); setHighlight(-1); }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            autoComplete="off"
            className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-[#4FAEB2]/30"
          />
        </div>
      )}

      {open && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg">
          {resultados.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-slate-400">{proveedores.length === 0 ? "Cargando proveedores…" : "Sin resultados"}</div>
          ) : (
            <ul className="divide-y divide-slate-50">
              {resultados.map((p, i) => {
                const sel = String(p.id) === value;
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      onMouseEnter={() => setHighlight(i)}
                      onClick={() => elegir(p)}
                      className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors ${i === highlight ? "bg-[#4FAEB2]/[0.08]" : "hover:bg-slate-50"}`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-slate-800">{p.nombre}</span>
                        {(p.razon_social || p.ruc) && (
                          <span className="block truncate text-xs text-slate-400">
                            {p.razon_social ?? ""}{p.razon_social && p.ruc ? " · " : ""}{p.ruc ? `RUC ${p.ruc}` : ""}
                          </span>
                        )}
                      </span>
                      {sel && <Check className="h-4 w-4 shrink-0 text-[#4FAEB2]" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
