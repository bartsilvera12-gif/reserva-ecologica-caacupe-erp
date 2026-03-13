"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  getEmpresaById,
  getModulos,
  actualizarEmpresa,
} from "@/lib/empresas/actions";
import type { Modulo } from "@/lib/empresas/actions";

const fLabel = "block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1";
const fInput =
  "w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0EA5E9] bg-white";

export default function EditarEmpresaPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;
  const [modulos, setModulos] = useState<Modulo[]>([]);
  const [cargandoModulos, setCargandoModulos] = useState(true);
  const [cargandoEmpresa, setCargandoEmpresa] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState({
    nombre_empresa: "",
    plan: "",
    ruc: "",
    estado: "activo" as "activo" | "inactivo",
    modulo_ids: [] as string[],
  });

  useEffect(() => {
    Promise.all([getModulos(), getEmpresaById(id)])
      .then(([mods, detalle]) => {
        setModulos(mods);
        setForm({
          nombre_empresa: detalle.empresa.nombre_empresa ?? "",
          plan: detalle.empresa.plan ?? "",
          ruc: detalle.empresa.ruc ?? "",
          estado: (detalle.empresa.estado as "activo" | "inactivo") ?? "activo",
          modulo_ids: detalle.modulos.map((m) => m.id),
        });
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Error"))
      .finally(() => {
        setCargandoModulos(false);
        setCargandoEmpresa(false);
      });
  }, [id]);

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) {
    const { name, value, type } = e.target;
    if (type === "checkbox") {
      const checked = (e.target as HTMLInputElement).checked;
      const modId = (e.target as HTMLInputElement).value;
      setForm((prev) => ({
        ...prev,
        modulo_ids: checked
          ? [...prev.modulo_ids, modId]
          : prev.modulo_ids.filter((m) => m !== modId),
      }));
    } else {
      setForm((prev) => ({ ...prev, [name]: value }));
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!form.nombre_empresa.trim()) {
      return setError("El nombre de la empresa es obligatorio.");
    }

    setGuardando(true);

    try {
      await actualizarEmpresa(id, {
        nombre_empresa: form.nombre_empresa.trim(),
        plan: form.plan.trim() || undefined,
        ruc: form.ruc.trim() || undefined,
        estado: form.estado,
        modulo_ids: form.modulo_ids,
      });
      router.push(`/admin/empresas/${id}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setGuardando(false);
    }
  }

  if (cargandoEmpresa) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Link href="/admin/empresas" className="hover:text-gray-700 transition-colors">
            Empresas
          </Link>
          <span>/</span>
          <span className="text-gray-700 font-medium">Cargando…</span>
        </div>
        <div className="py-16 text-center text-gray-400 text-sm animate-pulse">
          Cargando empresa…
        </div>
      </div>
    );
  }

  if (error && !form.nombre_empresa) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Link href="/admin/empresas" className="hover:text-gray-700 transition-colors">
            Empresas
          </Link>
          <span>/</span>
          <span className="text-gray-700 font-medium">Error</span>
        </div>
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">
          {error}
        </div>
        <Link
          href="/admin/empresas"
          className="inline-flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-800"
        >
          ← Volver a empresas
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-2 text-sm text-gray-400">
        <Link href="/admin/empresas" className="hover:text-gray-700 transition-colors">
          Empresas
        </Link>
        <span>/</span>
        <Link href={`/admin/empresas/${id}`} className="hover:text-gray-700 transition-colors">
          {form.nombre_empresa || "Empresa"}
        </Link>
        <span>/</span>
        <span className="text-gray-700 font-medium">Editar</span>
      </div>

      <div>
        <h1 className="text-2xl font-bold text-gray-900">Editar empresa</h1>
        <p className="text-sm text-gray-500 mt-1">
          Modificar datos de la empresa y módulos habilitados.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-8 max-w-2xl">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">
            {error}
          </div>
        )}

        <section className="bg-white rounded-xl border border-gray-100 shadow-sm p-6">
          <div className="flex items-center gap-2 mb-5 pb-2 border-b border-gray-100">
            <span className="text-base">🏢</span>
            <h3 className="text-sm font-bold text-gray-700 uppercase tracking-wider">
              Datos de la empresa
            </h3>
          </div>
          <div className="space-y-4">
            <div>
              <label className={fLabel}>Nombre de la empresa *</label>
              <input
                type="text"
                name="nombre_empresa"
                value={form.nombre_empresa}
                onChange={handleChange}
                placeholder="Ej: MI EMPRESA S.A."
                className={`${fInput} uppercase`}
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={fLabel}>Plan</label>
                <input
                  type="text"
                  name="plan"
                  value={form.plan}
                  onChange={handleChange}
                  placeholder="Ej: Básico, Pro, Enterprise"
                  className={fInput}
                />
              </div>
              <div>
                <label className={fLabel}>RUC</label>
                <input
                  type="text"
                  name="ruc"
                  value={form.ruc}
                  onChange={handleChange}
                  placeholder="00000000-0"
                  className={fInput}
                />
              </div>
            </div>
            <div>
              <label className={fLabel}>Estado</label>
              <select
                name="estado"
                value={form.estado}
                onChange={handleChange}
                className={fInput}
              >
                <option value="activo">Activo</option>
                <option value="inactivo">Inactivo</option>
              </select>
            </div>
          </div>
        </section>

        <section className="bg-white rounded-xl border border-gray-100 shadow-sm p-6">
          <div className="flex items-center gap-2 mb-5 pb-2 border-b border-gray-100">
            <span className="text-base">📦</span>
            <h3 className="text-sm font-bold text-gray-700 uppercase tracking-wider">
              Módulos habilitados
            </h3>
          </div>
          {cargandoModulos ? (
            <p className="text-sm text-gray-400">Cargando módulos…</p>
          ) : modulos.length === 0 ? (
            <p className="text-sm text-gray-400">No hay módulos configurados en el sistema.</p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {modulos.map((m) => (
                <label
                  key={m.id}
                  className="flex items-center gap-2 cursor-pointer p-2 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  <input
                    type="checkbox"
                    value={m.id}
                    checked={form.modulo_ids.includes(m.id)}
                    onChange={handleChange}
                    className="rounded border-gray-300"
                  />
                  <span className="text-sm text-gray-700">{m.nombre ?? m.name ?? m.id}</span>
                </label>
              ))}
            </div>
          )}
        </section>

        <div className="flex gap-4">
          <button
            type="submit"
            disabled={guardando}
            className="bg-[#0EA5E9] hover:bg-[#0284C7] text-white text-sm font-semibold px-6 py-2.5 rounded-lg transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed active:scale-95"
          >
            {guardando ? "Guardando…" : "Guardar cambios"}
          </button>
          <Link
            href={`/admin/empresas/${id}`}
            className="border border-slate-200 text-sm px-6 py-2.5 rounded-lg hover:bg-slate-50 transition-colors inline-flex items-center"
          >
            Cancelar
          </Link>
        </div>
      </form>
    </div>
  );
}
