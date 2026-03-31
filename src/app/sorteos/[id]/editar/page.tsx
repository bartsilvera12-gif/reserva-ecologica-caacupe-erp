"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getSorteoById, updateSorteo } from "@/lib/sorteos/actions";
import type { SorteoEstado } from "@/lib/sorteos/types";

export default function EditarSorteoPage() {
  const params = useParams();
  const id = String(params?.id ?? "");
  const router = useRouter();
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [nombre, setNombre] = useState("");
  const [descripcion, setDescripcion] = useState("");
  const [precio, setPrecio] = useState(0);
  const [maxBoletos, setMaxBoletos] = useState(100);
  const [fechaSorteo, setFechaSorteo] = useState("");
  const [estado, setEstado] = useState<SorteoEstado>("activo");
  const [imagenUrl, setImagenUrl] = useState("");
  const [datosBancarios, setDatosBancarios] = useState("{}");

  useEffect(() => {
    if (!id) return;
    getSorteoById(id)
      .then((s) => {
        if (!s) {
          setError("Sorteo no encontrado");
          return;
        }
        setNombre(s.nombre);
        setDescripcion(s.descripcion ?? "");
        setPrecio(s.precio_por_boleto);
        setMaxBoletos(s.max_boletos);
        if (s.fecha_sorteo) {
          const d = new Date(s.fecha_sorteo);
          const pad = (n: number) => String(n).padStart(2, "0");
          setFechaSorteo(
            `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
          );
        }
        setEstado(s.estado);
        setImagenUrl(s.imagen_url ?? "");
        setDatosBancarios(JSON.stringify(s.datos_bancarios ?? {}, null, 2));
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Error"))
      .finally(() => setCargando(false));
  }, [id]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    const nombreTrim = nombre.trim();
    if (!nombreTrim) {
      setError("El nombre del sorteo es obligatorio.");
      return;
    }
    if (!Number.isFinite(precio) || precio < 0) {
      setError("El precio por boleto debe ser un número válido mayor o igual a 0.");
      return;
    }
    if (!Number.isFinite(maxBoletos) || maxBoletos < 1) {
      setError("El máximo de boletos debe ser al menos 1.");
      return;
    }

    let json: Record<string, unknown> = {};
    try {
      json = datosBancarios.trim() ? (JSON.parse(datosBancarios) as Record<string, unknown>) : {};
    } catch {
      setError("Datos bancarios: el JSON no es válido. Revisá comillas y comas.");
      return;
    }

    let fechaIso: string | null = null;
    if (fechaSorteo.trim()) {
      const d = new Date(fechaSorteo);
      if (Number.isNaN(d.getTime())) {
        setError("La fecha del sorteo no es válida.");
        return;
      }
      fechaIso = d.toISOString();
    }

    setGuardando(true);
    try {
      await updateSorteo(id, {
        nombre: nombreTrim,
        descripcion,
        precio_por_boleto: precio,
        max_boletos: maxBoletos,
        fecha_sorteo: fechaIso,
        estado,
        datos_bancarios: json,
        imagen_url: imagenUrl.trim() || null,
      });
      setSuccess("Cambios guardados correctamente.");
      router.refresh();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Error al guardar";
      setError(msg);
      console.error("[editar sorteo]", err);
    } finally {
      setGuardando(false);
    }
  }

  if (cargando) {
    return <div className="py-16 text-center text-slate-400 text-sm animate-pulse">Cargando…</div>;
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/sorteos" className="hover:text-slate-800">
          Sorteos
        </Link>
        <span>/</span>
        <span className="text-slate-800 font-medium">Editar</span>
      </div>
      <h1 className="text-2xl font-bold text-gray-800">Editar sorteo</h1>
      <div className="pt-1">
        <Link
          href={`/sorteos/${id}/revendedores`}
          className="inline-flex items-center rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm font-medium text-sky-700 hover:bg-sky-100"
        >
          Revendedores y enlaces de referido
        </Link>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 text-sm rounded-lg px-4 py-2" role="alert">
          {error}
        </div>
      )}
      {success && (
        <div
          className="bg-emerald-50 border border-emerald-200 text-emerald-900 text-sm rounded-lg px-4 py-2"
          role="status"
        >
          {success}{" "}
          <Link href="/sorteos" className="font-medium text-emerald-800 underline underline-offset-2">
            Ver listado de sorteos
          </Link>
        </div>
      )}

      <form noValidate onSubmit={handleSubmit} className="space-y-4 bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Nombre</label>
          <input
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Descripción</label>
          <textarea
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm min-h-[80px]"
            value={descripcion}
            onChange={(e) => setDescripcion(e.target.value)}
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Precio por boleto (₲)</label>
            <input
              type="number"
              min={0}
              step={1}
              required
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
              value={precio}
              onChange={(e) => setPrecio(Number(e.target.value))}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Máx. boletos</label>
            <input
              type="number"
              min={1}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
              value={Number.isFinite(maxBoletos) ? maxBoletos : ""}
              onChange={(e) => {
                const v = e.target.value;
                setMaxBoletos(v === "" ? 0 : Number(v));
              }}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Fecha del sorteo</label>
            <input
              type="datetime-local"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
              value={fechaSorteo}
              onChange={(e) => setFechaSorteo(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Estado</label>
            <select
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
              value={estado}
              onChange={(e) => setEstado(e.target.value as SorteoEstado)}
            >
              <option value="activo">activo</option>
              <option value="pausado">pausado</option>
              <option value="cerrado">cerrado</option>
              <option value="finalizado">finalizado</option>
            </select>
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">URL imagen</label>
          <input
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
            value={imagenUrl}
            onChange={(e) => setImagenUrl(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Datos bancarios (JSON)</label>
          <textarea
            className="w-full font-mono text-xs border border-slate-200 rounded-lg px-3 py-2 min-h-[100px]"
            value={datosBancarios}
            onChange={(e) => setDatosBancarios(e.target.value)}
          />
        </div>
        <div className="flex gap-3 pt-2">
          <button
            type="submit"
            disabled={guardando}
            className="bg-[#0EA5E9] hover:bg-[#0284C7] disabled:opacity-50 text-white px-5 py-2.5 rounded-lg text-sm font-medium"
          >
            {guardando ? "Guardando…" : "Guardar"}
          </button>
          <Link href="/sorteos" className="px-5 py-2.5 text-sm text-slate-600 hover:bg-slate-100 rounded-lg">
            Volver
          </Link>
        </div>
      </form>
    </div>
  );
}
