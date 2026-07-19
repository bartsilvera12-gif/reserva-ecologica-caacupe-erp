"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import {
  emptyUsuarioForm,
  rolFromNivelForm,
  UsuarioFormFields,
  type UsuarioFormValues,
} from "@/components/usuarios/UsuarioForm";

export default function NuevoUsuarioPage() {
  const router = useRouter();

  const [form, setForm] = useState(emptyUsuarioForm());
  const [showPwd, setShowPwd] = useState(false);
  const [showPwd2, setShowPwd2] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  // Sucursal del usuario. Cada usuario pertenece a una sola y ve únicamente lo
  // de esa sucursal, admin incluido. No se preselecciona ninguna a propósito:
  // el admin de otra sucursal se crea desde acá, y un default silencioso lo
  // dejaría en la sucursal equivocada.
  const [sucursales, setSucursales] = useState<Array<{ id: string; nombre: string }>>([]);
  const [sucursalId, setSucursalId] = useState("");

  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        const res = await fetchWithSupabaseSession("/api/sucursales");
        const json = await res.json();
        if (!vivo || !res.ok) return;
        setSucursales(json?.data?.sucursales ?? []);
      } catch {
        /* si falla, el select queda vacío y el submit avisa */
      }
    })();
    return () => {
      vivo = false;
    };
  }, []);

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) {
    const { name, value, type } = e.target;
    const upper = ["nombre"];
    if (type === "checkbox") {
      setForm((prev) => ({ ...prev, [name]: (e.target as HTMLInputElement).checked }));
    } else {
      let normalized = value;
      if (name === "email" || type === "email") normalized = value.toLowerCase();
      else if (upper.includes(name)) normalized = value.toUpperCase();
      setForm((prev) => ({ ...prev, [name]: normalized } as UsuarioFormValues));
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!form.nombre.trim()) {
      setError("El nombre es obligatorio.");
      return;
    }
    if (!form.email.trim()) {
      setError("El email es obligatorio.");
      return;
    }
    if (!form.password) {
      setError("La contraseña es obligatoria.");
      return;
    }
    if (form.password.length < 6) {
      setError("La contraseña debe tener al menos 6 caracteres.");
      return;
    }
    if (form.password !== form.password2) {
      setError("Las contraseñas no coinciden.");
      return;
    }

    if (!sucursalId) {
      setError("Seleccioná la sucursal del usuario.");
      return;
    }

    const pct = form.porcentaje_comision.trim();
    const pctNum = pct === "" ? null : Number(pct);
    if (pctNum !== null && (!Number.isFinite(pctNum) || pctNum < 0 || pctNum > 100)) {
      setError("La comisión debe estar entre 0 y 100.");
      return;
    }

    setGuardando(true);

    try {
      const res = await fetchWithSupabaseSession("/api/empresas/usuarios/nuevo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: form.email.trim().toLowerCase(),
          password: form.password,
          nombre: form.nombre.trim(),
          telefono: form.telefono.trim() || undefined,
          fecha_nacimiento: form.fecha_nacimiento || undefined,
          fecha_ingreso: form.fecha_ingreso || undefined,
          tipo_contrato: form.tipo_contrato,
          salario_base: form.salario_base.trim() || undefined,
          porcentaje_comision: pct.trim() || undefined,
          ips: form.ips,
          area: form.area,
          rol: rolFromNivelForm(form.nivel),
          sucursal_id: sucursalId,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(typeof json.error === "string" ? json.error : "Error al crear usuario");
      }
    } catch (err: unknown) {
      setGuardando(false);
      const msg =
        err instanceof Error
          ? err.message
          : typeof err === "object" && err !== null && "message" in err
            ? String((err as { message: unknown }).message)
            : String(err);
      setError(`Error al crear usuario: ${msg}`);
      return;
    }

    setGuardando(false);
    router.push("/usuarios");
  }

  return (
    <div className="space-y-8 max-w-2xl">
      <div className="flex items-center gap-2 text-sm text-gray-400">
        <Link href="/usuarios" className="hover:text-gray-700 transition-colors">
          Usuarios
        </Link>
        <span>/</span>
        <span className="text-gray-700 font-medium">Nuevo usuario</span>
      </div>

      <div>
        <h1 className="text-2xl font-bold text-gray-900">Nuevo usuario</h1>
        <p className="text-sm text-gray-500 mt-1">Código generado automáticamente al guardar.</p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">{error}</div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        <div>
          <label htmlFor="sucursal_id" className="block text-sm font-medium text-gray-700 mb-1.5">
            Sucursal <span className="text-red-500">*</span>
          </label>
          <select
            id="sucursal_id"
            name="sucursal_id"
            value={sucursalId}
            onChange={(e) => setSucursalId(e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#0EA5E9] focus:border-transparent"
          >
            <option value="">Seleccioná una sucursal…</option>
            {sucursales.map((s) => (
              <option key={s.id} value={s.id}>
                {s.nombre}
              </option>
            ))}
          </select>
          <p className="text-xs text-gray-500 mt-1.5">
            El usuario va a ver únicamente los datos de esta sucursal. No se puede cambiar desde el
            sistema una vez creado.
          </p>
        </div>

        <UsuarioFormFields
          variant="create"
          form={form}
          onChange={handleChange}
          onSalarioBaseChange={(n) => setForm((prev) => ({ ...prev, salario_base: String(n) }))}
          showPwd={showPwd}
          setShowPwd={setShowPwd}
          showPwd2={showPwd2}
          setShowPwd2={setShowPwd2}
        />

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={guardando}
            className="bg-[#0EA5E9] hover:bg-[#0284C7] text-white text-sm font-semibold px-6 py-2.5 rounded-lg transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed active:scale-95"
          >
            {guardando ? "Creando usuario…" : "Guardar usuario"}
          </button>
          <Link href="/usuarios" className="text-sm text-gray-500 hover:text-gray-800 transition-colors px-4 py-2.5">
            Cancelar
          </Link>
        </div>
      </form>
    </div>
  );
}
