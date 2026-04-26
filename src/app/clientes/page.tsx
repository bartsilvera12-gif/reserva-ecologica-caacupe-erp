"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { getClientes, clienteNombre } from "@/lib/clientes/storage";
import type { Cliente } from "@/lib/clientes/types";
import { etiquetaVisibleTipoServicio, type ClienteTipoServicioRow } from "@/lib/clientes/tipo-servicio-catalogo";
import { filasTiposDesdeSistemaEstatico, fetchTiposFormCliente } from "@/lib/clientes/fetch-tipos-servicio-form";

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatFecha(iso: string) {
  try {
    const d = new Date(iso);
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
  } catch { return ""; }
}

// ── Badges ────────────────────────────────────────────────────────────────────

function BadgeEstado({ estado }: { estado: Cliente["estado"] }) {
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full ${
      estado === "activo"
        ? "bg-green-100 text-green-700"
        : "bg-gray-100 text-gray-500"
    }`}>
      <span className={`w-1.5 h-1.5 rounded-full ${estado === "activo" ? "bg-green-500" : "bg-gray-400"}`} />
      {estado === "activo" ? "Activo" : "Inactivo"}
    </span>
  );
}

function BadgeOrigen({ origen }: { origen: Cliente["origen"] }) {
  const cfg = {
    CRM:    "bg-violet-100 text-violet-700",
    VENTA:  "bg-blue-100 text-blue-700",
    MANUAL: "bg-gray-100 text-gray-600",
  };
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${cfg[origen]}`}>
      {origen}
    </span>
  );
}

// ── Componente principal ──────────────────────────────────────────────────────

export default function ClientesPage() {
  const searchParams = useSearchParams();
  const [clientes,    setClientes]    = useState<Cliente[]>([]);
  const [cargando,    setCargando]    = useState(true);
  const [busqueda,    setBusqueda]    = useState("");
  const [bajaOk,      setBajaOk]      = useState(false);
  const [filtroEstado, setFiltroEstado] = useState<"" | "activo" | "inactivo">("");
  const [filtroOrigen, setFiltroOrigen] = useState<"" | "CRM" | "VENTA" | "MANUAL">("");
  const [filtroTipo,   setFiltroTipo]   = useState<"" | "empresa" | "persona">("");
  const [filtroTipoServicio, setFiltroTipoServicio] = useState<"" | string>("");
  const [filasTipoCatalogo, setFilasTipoCatalogo] = useState<ClienteTipoServicioRow[]>(() => filasTiposDesdeSistemaEstatico());
  const mapNombreTipo = useMemo(() => {
    const m: Record<string, string> = {};
    for (const t of filasTipoCatalogo) m[t.slug] = t.nombre;
    return m;
  }, [filasTipoCatalogo]);

  useEffect(() => {
    getClientes({ incluirPlanActivo: true }).then((data) => {
      setClientes(data);
      setCargando(false);
    });
  }, []);

  useEffect(() => {
    void fetchTiposFormCliente().then(setFilasTipoCatalogo);
  }, []);
  const slugsExtraFiltro = useMemo(() => {
    const known = new Set(filasTipoCatalogo.map((f) => f.slug));
    const u = new Set<string>();
    for (const c of clientes) {
      const t = (c.tipo_servicio_cliente ?? "").trim();
      if (t && !known.has(t)) u.add(t);
    }
    return Array.from(u).sort();
  }, [clientes, filasTipoCatalogo]);

  useEffect(() => {
    if (searchParams?.get("baja_ok") === "1") {
      setBajaOk(true);
      window.history.replaceState({}, "", "/clientes");
      const t = setTimeout(() => setBajaOk(false), 5000);
      return () => clearTimeout(t);
    }
  }, [searchParams]);

  const filtrados = clientes.filter((c) => {
    const nombre = clienteNombre(c).toLowerCase();
    const q      = busqueda.toLowerCase();
    if (q) {
      const match =
        nombre.includes(q) ||
        (c.codigo_cliente ?? "").toLowerCase().includes(q) ||
        (c.email          ?? "").toLowerCase().includes(q) ||
        (c.telefono       ?? "").toLowerCase().includes(q) ||
        (c.ruc            ?? "").toLowerCase().includes(q) ||
        (c.ciudad         ?? "").toLowerCase().includes(q);
      if (!match) return false;
    }
    if (filtroEstado       && c.estado              !== filtroEstado) return false;
    if (filtroOrigen       && c.origen              !== filtroOrigen) return false;
    if (filtroTipo         && c.tipo_cliente        !== filtroTipo) return false;
    if (filtroTipoServicio && c.tipo_servicio_cliente !== filtroTipoServicio) return false;
    return true;
  });

  const hayFiltros = busqueda || filtroEstado || filtroOrigen || filtroTipo || filtroTipoServicio;

  return (
    <div className="space-y-6">

      {/* Mensaje de éxito baja operativa */}
      {bajaOk && (
        <div className="flex items-center gap-3 bg-green-50 border border-green-200 rounded-xl px-4 py-3 text-green-800">
          <span className="text-xl">✓</span>
          <p className="text-sm font-medium">Baja procesada correctamente</p>
        </div>
      )}

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-800">Clientes</h1>
          <p className="text-gray-500 text-sm mt-1">Base de clientes activos de la empresa</p>
        </div>
        <Link
          href="/clientes/nuevo"
          className="flex items-center gap-1.5 bg-[#0EA5E9] hover:bg-[#0284C7] text-white px-4 py-2.5 rounded-lg text-sm font-medium transition-colors shadow-sm shrink-0"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
            <path d="M10.75 4.75a.75.75 0 0 0-1.5 0v4.5h-4.5a.75.75 0 0 0 0 1.5h4.5v4.5a.75.75 0 0 0 1.5 0v-4.5h4.5a.75.75 0 0 0 0-1.5h-4.5v-4.5Z" />
          </svg>
          Nuevo cliente
        </Link>
      </div>

      {/* Filtros */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 flex flex-wrap gap-3 items-center">
        <input
          type="text"
          placeholder="Buscar por nombre, código, email, RUC..."
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          className="flex-1 min-w-48 border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-[#0EA5E9] focus:outline-none transition-all"
        />
        <select
          value={filtroEstado}
          onChange={(e) => setFiltroEstado(e.target.value as "" | "activo" | "inactivo")}
          className="border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-[#0EA5E9] focus:outline-none"
        >
          <option value="">Todos los estados</option>
          <option value="activo">Activo</option>
          <option value="inactivo">Inactivo</option>
        </select>
        <select
          value={filtroTipo}
          onChange={(e) => setFiltroTipo(e.target.value as "" | "empresa" | "persona")}
          className="border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-[#0EA5E9] focus:outline-none"
        >
          <option value="">Todos los tipos</option>
          <option value="empresa">Empresa</option>
          <option value="persona">Persona</option>
        </select>
        <select
          value={filtroOrigen}
          onChange={(e) => setFiltroOrigen(e.target.value as "" | "CRM" | "VENTA" | "MANUAL")}
          className="border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-[#0EA5E9] focus:outline-none"
        >
          <option value="">Todos los orígenes</option>
          <option value="CRM">CRM</option>
          <option value="VENTA">Venta</option>
          <option value="MANUAL">Manual</option>
        </select>
        <select
          value={filtroTipoServicio}
          onChange={(e) => setFiltroTipoServicio(e.target.value)}
          className="border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-[#0EA5E9] focus:outline-none"
        >
          <option value="">Tipo servicio</option>
          {filasTipoCatalogo.map((t) => (
            <option key={t.slug} value={t.slug}>
              {t.nombre}
            </option>
          ))}
          {slugsExtraFiltro.map((slug) => (
            <option key={slug} value={slug}>
              {etiquetaVisibleTipoServicio(slug, mapNombreTipo)}
            </option>
          ))}
        </select>
        {hayFiltros && (
          <button
            onClick={() => { setBusqueda(""); setFiltroEstado(""); setFiltroOrigen(""); setFiltroTipo(""); setFiltroTipoServicio(""); }}
            className="text-xs text-gray-500 hover:text-gray-900 border border-gray-300 rounded-lg px-3 py-2 hover:bg-gray-50 transition-colors"
          >
            Limpiar
          </button>
        )}
      </div>

      {/* Contador */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">
          <span className="font-semibold text-gray-800">{filtrados.length}</span> de{" "}
          <span className="font-semibold text-gray-800">{clientes.length}</span> clientes
        </p>
        <div className="flex gap-3 text-xs text-gray-400">
          <span>{clientes.filter((c) => c.estado === "activo").length} activos</span>
          <span>·</span>
          <span>{clientes.filter((c) => c.tipo_cliente === "empresa").length} empresas</span>
        </div>
      </div>

      {/* Tabla */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
        {cargando ? (
          <div className="py-16 text-center text-gray-400 text-sm animate-pulse">Cargando clientes…</div>
        ) : filtrados.length === 0 ? (
          <div className="py-16 text-center text-gray-400">
            <p className="text-4xl mb-3">👥</p>
            <p className="font-medium text-gray-600">
              {clientes.length === 0 ? "No hay clientes registrados" : "Sin resultados para los filtros aplicados"}
            </p>
            {clientes.length === 0 && (
              <Link href="/clientes/nuevo" className="mt-4 inline-block text-sm text-gray-500 underline hover:text-gray-800">
                Crear primer cliente
              </Link>
            )}
          </div>
        ) : /* tabla */ (
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50">
                <th className="text-left text-xs font-semibold text-slate-600 px-5 py-3">Código</th>
                <th className="text-left text-xs font-semibold text-slate-600 px-5 py-3">Empresa / Nombre</th>
                <th className="text-left text-xs font-semibold text-slate-600 px-5 py-3">Contacto</th>
                <th className="text-left text-xs font-semibold text-slate-600 px-5 py-3">Teléfono</th>
                <th className="text-left text-xs font-semibold text-slate-600 px-5 py-3">Plan activo</th>
                <th className="text-left text-xs font-semibold text-slate-600 px-5 py-3">Origen</th>
                <th className="text-left text-xs font-semibold text-slate-600 px-5 py-3">Tipo servicio</th>
                <th className="text-left text-xs font-semibold text-slate-600 px-5 py-3">Estado</th>
                <th className="text-left text-xs font-semibold text-slate-600 px-5 py-3">Creado por</th>
                <th className="text-left text-xs font-semibold text-slate-600 px-5 py-3">Desde</th>
              </tr>
            </thead>
            <tbody>
              {filtrados.map((c) => (
                <tr
                  key={c.id}
                  className="border-b border-slate-200 hover:bg-slate-50 transition-colors cursor-pointer group"
                  onClick={() => window.location.href = `/clientes/${c.id}`}
                >
                  <td className="px-5 py-3.5">
                    <span className="font-mono text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded">
                      {c.codigo_cliente}
                    </span>
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-2">
                      <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold text-white shrink-0 ${
                        c.tipo_cliente === "empresa" ? "bg-blue-500" : "bg-violet-500"
                      }`}>
                        {c.tipo_cliente === "empresa" ? "E" : "P"}
                      </div>
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-semibold text-gray-800 group-hover:text-gray-900">
                            {clienteNombre(c)}
                          </p>
                          {c.perfil_tributario_activo && (
                            <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-100">
                              Tributario
                            </span>
                          )}
                        </div>
                        {c.tipo_cliente === "empresa" && c.ruc && (
                          <p className="text-xs text-gray-400">RUC: {c.ruc}</p>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-3.5">
                    <p className="text-sm text-gray-700">
                      {c.tipo_cliente === "empresa" ? c.nombre_contacto : (c.ciudad ?? "—")}
                    </p>
                  </td>
                  <td className="px-5 py-3.5 text-sm text-gray-600">{c.telefono ?? "—"}</td>
                  <td className="px-5 py-3.5">
                    {c.plan_activo ? (
                      <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-100">
                        {c.plan_activo}
                      </span>
                    ) : (
                      <span className="text-xs text-gray-400">Sin suscripción</span>
                    )}
                  </td>
                  <td className="px-5 py-3.5"><BadgeOrigen origen={c.origen} /></td>
                  <td className="px-5 py-3.5 text-xs text-gray-600">
                    {etiquetaVisibleTipoServicio(c.tipo_servicio_cliente ?? null, mapNombreTipo)}
                  </td>
                  <td className="px-5 py-3.5"><BadgeEstado estado={c.estado} /></td>
                  <td className="px-5 py-3.5 text-xs text-gray-500">{c.created_by_nombre ?? "—"}</td>
                  <td className="px-5 py-3.5 text-xs text-gray-400">{formatFecha(c.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

    </div>
  );
}
