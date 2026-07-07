"use client";

import { useEffect, useState } from "react";
import { apiCreateCliente } from "@/lib/api/client";

export interface NuevoClienteCreado {
  id: string;
  nombre: string;
  ruc: string | null;
}

interface Props {
  /** Texto pre-cargado (lo que el operador venía tipeando en el buscador). */
  nombreInicial?: string;
  onClose: () => void;
  onCreado: (c: NuevoClienteCreado) => void;
}

/**
 * Modal minimalista para crear un cliente sin salir del flujo de "Nueva venta".
 * Solo pide los campos indispensables: tipo, razón social/nombre, RUC/CI, teléfono.
 * Cualquier otra edición (dirección, SIFEN, condiciones) se hace después en
 * /clientes/[id] cuando el operador tenga tiempo.
 */
export default function NuevoClienteRapidoModal({ nombreInicial, onClose, onCreado }: Props) {
  const [tipo, setTipo] = useState<"empresa" | "persona">("empresa");
  const [nombre, setNombre] = useState((nombreInicial ?? "").toUpperCase());
  const [ruc, setRuc] = useState("");
  const [documento, setDocumento] = useState("");
  const [telefono, setTelefono] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !enviando) onClose();
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [onClose, enviando]);

  const nombreTrim = nombre.trim();
  const puedeGuardar = nombreTrim.length >= 2 && !enviando;

  async function handleSubmit() {
    if (!puedeGuardar) return;
    setEnviando(true);
    setError(null);
    const res = await apiCreateCliente({
      tipo_cliente: tipo,
      empresa: tipo === "empresa" ? nombreTrim : undefined,
      nombre_contacto: nombreTrim,
      ruc: tipo === "empresa" ? ruc.trim() || undefined : undefined,
      documento: tipo === "persona" ? documento.trim() || undefined : undefined,
      telefono: telefono.trim() || undefined,
      origen: "VENTA",
      estado: "activo",
    });
    setEnviando(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onCreado({
      id: res.data.id,
      nombre: nombreTrim,
      ruc: (tipo === "empresa" ? ruc.trim() : documento.trim()) || null,
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget && !enviando) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
        <h3 className="text-lg font-semibold text-slate-900">Nuevo cliente</h3>
        <p className="mt-1 text-xs text-slate-500">
          Solo los datos mínimos. Podés completar dirección, SIFEN y condiciones más tarde desde la ficha del cliente.
        </p>

        {/* Tipo */}
        <div className="mt-4 flex gap-2">
          {(["empresa", "persona"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTipo(t)}
              className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${
                tipo === t
                  ? "border-[#4FAEB2] bg-[#4FAEB2]/10 text-[#3F8E91]"
                  : "border-slate-200 text-slate-600 hover:bg-slate-50"
              }`}
            >
              {t === "empresa" ? "Empresa" : "Persona"}
            </button>
          ))}
        </div>

        {/* Nombre */}
        <label className="mt-4 block text-sm font-medium text-slate-800">
          {tipo === "empresa" ? "Razón social" : "Nombre completo"} <span className="text-rose-600">*</span>
        </label>
        <input
          value={nombre}
          onChange={(e) => setNombre(e.target.value.toUpperCase())}
          disabled={enviando}
          placeholder={tipo === "empresa" ? "Ej: TALLER VIDAL S.A." : "Ej: PEDRO GONZALEZ"}
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm uppercase focus:border-[#4FAEB2] focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/20"
        />

        {/* RUC / documento */}
        <label className="mt-3 block text-sm font-medium text-slate-800">
          {tipo === "empresa" ? "RUC" : "CI / Documento"}
        </label>
        <input
          value={tipo === "empresa" ? ruc : documento}
          onChange={(e) =>
            tipo === "empresa" ? setRuc(e.target.value) : setDocumento(e.target.value)
          }
          disabled={enviando}
          placeholder={tipo === "empresa" ? "Ej: 80011405-1" : "Ej: 4123456"}
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-[#4FAEB2] focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/20"
        />

        {/* Teléfono */}
        <label className="mt-3 block text-sm font-medium text-slate-800">
          Teléfono <span className="text-xs font-normal text-slate-400">(opcional)</span>
        </label>
        <input
          value={telefono}
          onChange={(e) => setTelefono(e.target.value)}
          disabled={enviando}
          placeholder="Ej: 0991 234 567"
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-[#4FAEB2] focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/20"
        />

        {error && (
          <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
            {error}
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={enviando}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!puedeGuardar}
            className="rounded-lg bg-[#4FAEB2] px-3 py-2 text-sm font-semibold text-white hover:bg-[#3F8E91] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {enviando ? "Guardando…" : "Crear cliente"}
          </button>
        </div>
      </div>
    </div>
  );
}
