"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  addNotaCliente,
  clienteNombre,
  deleteCliente,
  getCliente,
  getNotasCliente,
  toggleEstado,
  updateCliente,
} from "@/lib/clientes/storage";
import {
  getFacturas,
  getSuscripciones,
  savePago,
  saveSuscripcion,
} from "@/lib/facturacion/storage";
import { getPlanes } from "@/lib/planes/storage";
import type { Cliente, NotaCliente } from "@/lib/clientes/types";
import type { Factura } from "@/lib/gestion-clientes/types";
import type { Suscripcion } from "@/lib/facturacion/types";
import type { Plan } from "@/lib/planes/types";

// ── Estilos ────────────────────────────────────────────────────────────────────

const inputClass =
  "w-full border border-slate-200 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-[#0EA5E9] focus:outline-none bg-white text-sm";
const labelClass = "block text-xs font-medium text-slate-500 mb-1";

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-4">
      {children}
    </p>
  );
}

// ── Tipos de pestaña ──────────────────────────────────────────────────────────

type TabId = "informacion" | "estado_cuenta" | "suscripciones" | "proyectos" | "actividad" | "notas";

const TABS: { id: TabId; label: string }[] = [
  { id: "informacion",   label: "Información"      },
  { id: "estado_cuenta", label: "Estado de cuenta" },
  { id: "suscripciones", label: "Suscripciones"    },
  { id: "proyectos",     label: "Proyectos"         },
  { id: "actividad",     label: "Actividad"         },
  { id: "notas",         label: "Notas"             },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatFecha(iso: string) {
  try {
    const d = new Date(iso);
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
  } catch { return ""; }
}

function formatFechaHora(iso: string) {
  try {
    const d = new Date(iso);
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  } catch { return ""; }
}

// ── Placeholder para pestañas futuras ─────────────────────────────────────────

function PlaceholderTab({ icon, title, desc }: { icon: string; title: string; desc: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <span className="text-5xl mb-4">{icon}</span>
      <h3 className="text-base font-semibold text-gray-600 mb-2">{title}</h3>
      <p className="text-sm text-gray-400 max-w-xs">{desc}</p>
      <span className="mt-5 text-xs bg-gray-100 text-gray-500 px-3 py-1.5 rounded-full">Próximamente</span>
    </div>
  );
}

// ── Componente principal ──────────────────────────────────────────────────────

export default function ClienteDetailPage() {
  const params = useParams();
  const router = useRouter();
  if (!params) return null;
  const id = params.id as string;

  const [cliente,   setCliente]   = useState<Cliente | null>(null);
  const [notFound,  setNotFound]  = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>("informacion");
  const [confirmarEliminar, setConfirmarEliminar] = useState(false);

  // Estados del formulario de información
  const [form, setForm] = useState({
    tipo_cliente:        "empresa" as Cliente["tipo_cliente"],
    empresa:             "",
    nombre_contacto:     "",
    ruc:                 "",
    documento:           "",
    telefono:            "",
    telefono_secundario: "",
    email:               "",
    email_secundario:    "",
    direccion:           "",
    ciudad:              "",
    pais:                "",
    sitio_web:           "",
    instagram:           "",
    linkedin:            "",
    categoria_cliente:   "",
    industria:           "",
    valor_cliente:       "",
    condicion_pago:      "",
    moneda_preferida:    "GS" as "GS" | "USD",
    vendedor_asignado:   "",
    estado:              "activo" as Cliente["estado"],
  });

  const [formError, setFormError] = useState<string | null>(null);

  // Campos de suscripción (solo cuando condicion_pago = MENSUAL en edición)
  const [formSuscEdit, setFormSuscEdit] = useState({
    plan_id: "", precio: "", duracion_meses: "12", dia_facturacion: "1", dia_vencimiento: "10", generar_factura: false,
  });

  // Estados de notas
  const [nuevaNota,     setNuevaNota]     = useState("");
  const [guardandoNota, setGuardandoNota] = useState(false);
  const notaRef = useRef<HTMLTextAreaElement>(null);

  // Suscripciones
  const [suscripciones, setSuscripciones] = useState<Suscripcion[]>([]);
  const [planes, setPlanes] = useState<Plan[]>([]);
  const [modalSuscripcion, setModalSuscripcion] = useState(false);
  const [formSusc, setFormSusc] = useState({
    plan_id: "", precio: "", fecha_inicio: "", duracion_meses: "12", dia_facturacion: "1", dia_vencimiento: "10", generar_factura_este_mes: false,
  });
  const [guardandoSusc, setGuardandoSusc] = useState(false);

  // Estado de cuenta
  const [facturas, setFacturas] = useState<Factura[]>([]);
  const [modalPago, setModalPago] = useState(false);
  const [facturaPago, setFacturaPago] = useState<Factura | null>(null);
  const [formPago, setFormPago] = useState({ factura_id: "" as string, monto: "", fecha_pago: "", metodo_pago: "efectivo" as const, referencia: "" });
  const [guardandoPago, setGuardandoPago] = useState(false);

  async function cargar() {
    const c = await getCliente(id);
    if (!c) { setNotFound(true); return; }
    c.notas = await getNotasCliente(id);
    setCliente(c);
    setForm({
      tipo_cliente:        c.tipo_cliente,
      empresa:             c.empresa             ?? "",
      nombre_contacto:     c.nombre_contacto,
      ruc:                 c.ruc                 ?? "",
      documento:           c.documento           ?? "",
      telefono:            c.telefono            ?? "",
      telefono_secundario: c.telefono_secundario ?? "",
      email:               c.email               ?? "",
      email_secundario:    c.email_secundario    ?? "",
      direccion:           c.direccion           ?? "",
      ciudad:              c.ciudad              ?? "",
      pais:                c.pais                ?? "",
      sitio_web:           c.sitio_web           ?? "",
      instagram:           c.instagram           ?? "",
      linkedin:            c.linkedin            ?? "",
      categoria_cliente:   c.categoria_cliente   ?? "",
      industria:           c.industria           ?? "",
      valor_cliente:       c.valor_cliente != null ? String(c.valor_cliente) : "",
      condicion_pago:      c.condicion_pago      ?? "",
      moneda_preferida:    c.moneda_preferida    ?? "GS",
      vendedor_asignado:   c.vendedor_asignado   ?? "",
      estado:              c.estado,
    });
  }

  useEffect(() => { if (id) cargar(); else setNotFound(true); }, [id]);

  useEffect(() => {
    if (id && (activeTab === "suscripciones" || activeTab === "estado_cuenta")) {
      if (activeTab === "suscripciones") {
        getSuscripciones(id).then(setSuscripciones);
        getPlanes().then(setPlanes);
      } else {
        getFacturas(id).then(setFacturas);
      }
    }
  }, [id, activeTab]);

  useEffect(() => {
    if (form.condicion_pago === "MENSUAL") {
      getPlanes().then(setPlanes);
      getSuscripciones(id).then(setSuscripciones);
    }
  }, [form.condicion_pago, id]);

  const upper = ["empresa", "nombre_contacto", "ciudad", "pais", "categoria_cliente", "industria", "vendedor_asignado", "condicion_pago"];

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) {
    setFormError(null);
    const { name, value } = e.target;
    setForm((prev) => ({
      ...prev,
      [name]: upper.includes(name) ? value.toUpperCase() : value,
    }));
  }

  async function handleGuardar(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!form.nombre_contacto.trim())                             return setFormError("El contacto es obligatorio.");
    if (form.tipo_cliente === "empresa" && !form.empresa.trim())  return setFormError("La razón social es obligatoria para empresas.");

    if (form.condicion_pago === "MENSUAL") {
      const dur = parseInt(formSuscEdit.duracion_meses, 10) || 0;
      const diaFac = parseInt(formSuscEdit.dia_facturacion, 10) || 0;
      const diaVenc = parseInt(formSuscEdit.dia_vencimiento, 10) || 0;
      if (dur <= 0) return setFormError("La duración del contrato debe ser mayor a 0.");
      if (diaFac < 1 || diaFac > 28) return setFormError("El día de facturación debe estar entre 1 y 28.");
      if (diaVenc < 1 || diaVenc > 31) return setFormError("El día de vencimiento debe estar entre 1 y 31.");
      if (diaVenc <= diaFac) return setFormError("El día de vencimiento debe ser mayor al día de facturación.");
      if (!formSuscEdit.plan_id.trim()) return setFormError("Seleccioná un plan para clientes mensuales.");
      const precio = parseFloat(formSuscEdit.precio) || 0;
      if (precio <= 0) return setFormError("El precio debe ser mayor a 0.");
    }

    await updateCliente(id, {
      tipo_cliente:        form.tipo_cliente,
      empresa:             form.tipo_cliente === "empresa" ? form.empresa.trim().toUpperCase() : undefined,
      nombre_contacto:     form.nombre_contacto.trim().toUpperCase(),
      ruc:                 form.ruc.trim()                 || undefined,
      documento:           form.documento.trim()           || undefined,
      telefono:            form.telefono.trim()            || undefined,
      telefono_secundario: form.telefono_secundario.trim() || undefined,
      email:               form.email.trim()               || undefined,
      email_secundario:    form.email_secundario.trim()    || undefined,
      direccion:           form.direccion.trim()           || undefined,
      ciudad:              form.ciudad.trim().toUpperCase()  || undefined,
      pais:                form.pais.trim().toUpperCase()    || undefined,
      sitio_web:           form.sitio_web.trim()           || undefined,
      instagram:           form.instagram.trim()           || undefined,
      linkedin:            form.linkedin.trim()            || undefined,
      categoria_cliente:   form.categoria_cliente.trim().toUpperCase() || undefined,
      industria:           form.industria.trim().toUpperCase()         || undefined,
      valor_cliente:       parseFloat(form.valor_cliente) || undefined,
      condicion_pago:      form.condicion_pago.trim().toUpperCase()    || undefined,
      moneda_preferida:    form.moneda_preferida,
      vendedor_asignado:   form.vendedor_asignado.trim().toUpperCase() || undefined,
      estado:              form.estado,
    });

    // Crear suscripción si condicion_pago = MENSUAL y no existe
    if (form.condicion_pago === "MENSUAL" && suscripciones.length === 0) {
      const plan = planes.find((p) => p.id === formSuscEdit.plan_id);
      await saveSuscripcion(
        {
          cliente_id: id,
          plan_id: formSuscEdit.plan_id || null,
          precio: parseFloat(formSuscEdit.precio) || (plan?.precio ?? 0),
          moneda: form.moneda_preferida,
          fecha_inicio: new Date().toISOString().slice(0, 10),
          duracion_meses: parseInt(formSuscEdit.duracion_meses, 10) || 12,
          dia_facturacion: parseInt(formSuscEdit.dia_facturacion, 10) || 1,
          dia_vencimiento: parseInt(formSuscEdit.dia_vencimiento, 10) || 10,
          generar_factura_este_mes: formSuscEdit.generar_factura,
        },
        plan?.nombre
      );
    }

    router.push("/clientes");
  }

  async function handleToggleEstado() {
    if (!cliente) return;
    const nuevo = cliente.estado === "activo" ? "inactivo" : "activo";
    await toggleEstado(id, nuevo);
    cargar();
  }

  async function handleEliminar() {
    await deleteCliente(id);
    router.push("/clientes");
  }

  async function handleAgregarNota(e: React.FormEvent) {
    e.preventDefault();
    if (!nuevaNota.trim()) return;
    setGuardandoNota(true);
    await addNotaCliente(id, nuevaNota);
    setNuevaNota("");
    await cargar();
    setGuardandoNota(false);
    setTimeout(() => notaRef.current?.focus(), 0);
  }

  if (notFound) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-gray-800">Cliente no encontrado</h1>
        <button onClick={() => router.push("/clientes")} className="text-sm text-gray-500 underline">
          ← Volver a Clientes
        </button>
      </div>
    );
  }

  if (!cliente) return null;

  const nombre = clienteNombre(cliente);

  return (
    <div className="space-y-6 max-w-5xl">

      {/* ── Breadcrumb ────────────────────────────────────────────────────── */}
      <button
        onClick={() => router.push("/clientes")}
        className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1"
      >
        ← Clientes
      </button>

      {/* ── Panel resumen ─────────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="bg-gradient-to-r from-[#0EA5E9] to-[#0284C7] px-6 py-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-4">
              {/* Avatar */}
              <div className={`w-14 h-14 rounded-xl flex items-center justify-center text-xl font-bold text-white shrink-0 ${
                cliente.tipo_cliente === "empresa" ? "bg-blue-500/80" : "bg-violet-500/80"
              }`}>
                {nombre.slice(0, 2).toUpperCase()}
              </div>
              <div>
                <h1 className="text-xl font-bold text-white leading-tight">{nombre}</h1>
                <div className="flex items-center gap-3 mt-1 flex-wrap">
                  <span className="text-gray-300 font-mono text-xs">{cliente.codigo_cliente}</span>
                  {cliente.ruc && (
                    <span className="text-gray-300 text-xs">RUC: {cliente.ruc}</span>
                  )}
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                    cliente.estado === "activo"
                      ? "bg-green-500/20 text-green-300"
                      : "bg-gray-500/30 text-gray-300"
                  }`}>
                    ● {cliente.estado === "activo" ? "Activo" : "Inactivo"}
                  </span>
                  <span className="text-xs text-gray-400">
                    Cliente desde {formatFecha(cliente.created_at)}
                  </span>
                </div>
              </div>
            </div>
            {/* Acciones del header */}
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={handleToggleEstado}
                className="text-xs font-medium border border-white/20 text-white/80 hover:bg-white/10 px-3 py-1.5 rounded-lg transition-colors"
              >
                {cliente.estado === "activo" ? "Desactivar" : "Activar"}
              </button>
              <button
                onClick={() => setConfirmarEliminar(true)}
                className="text-red-300 hover:text-red-200 hover:bg-red-900/30 p-1.5 rounded-lg transition-colors"
                title="Eliminar cliente"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                  <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 0 0 6 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 1 0 .23 1.482l.149-.022.841 10.518A2.75 2.75 0 0 0 7.596 19h4.807a2.75 2.75 0 0 0 2.742-2.53l.841-10.52.149.023a.75.75 0 0 0 .23-1.482A41.03 41.03 0 0 0 14 4.193V3.75A2.75 2.75 0 0 0 11.25 1h-2.5ZM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4ZM8.58 7.72a.75.75 0 0 0-1.5.06l.3 7.5a.75.75 0 1 0 1.5-.06l-.3-7.5Zm4.34.06a.75.75 0 1 0-1.5-.06l-.3 7.5a.75.75 0 1 0 1.5.06l.3-7.5Z" clipRule="evenodd" />
                </svg>
              </button>
            </div>
          </div>
        </div>

        {/* Estadísticas rápidas */}
        <div className="grid grid-cols-4 divide-x divide-gray-100 border-t border-gray-100">
          {[
            { label: "Origen",      value: cliente.origen                                   },
            { label: "Condición",   value: cliente.condicion_pago  ?? "—"                   },
            { label: "Moneda",      value: cliente.moneda_preferida ?? "GS"                 },
            { label: "Vendedor",    value: cliente.vendedor_asignado ?? "—"                 },
          ].map((item) => (
            <div key={item.label} className="px-5 py-3">
              <p className="text-xs text-gray-400">{item.label}</p>
              <p className="text-sm font-semibold text-gray-700 mt-0.5">{item.value}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Confirmación de eliminación */}
      {confirmarEliminar && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center justify-between gap-4">
          <p className="text-sm text-red-700 font-medium">¿Eliminar permanentemente este cliente?</p>
          <div className="flex gap-2 shrink-0">
            <button
              onClick={handleEliminar}
              className="bg-red-600 text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-red-700"
            >
              Sí, eliminar
            </button>
            <button
              onClick={() => setConfirmarEliminar(false)}
              className="border border-red-200 text-red-600 px-3 py-1.5 rounded-lg text-xs hover:bg-red-100"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {/* ── Pestañas ──────────────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        {/* Tab nav */}
        <div className="border-b border-gray-200 flex overflow-x-auto">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`px-5 py-3.5 text-sm font-medium whitespace-nowrap transition-colors border-b-2 ${
                activeTab === tab.id
                  ? "border-gray-900 text-gray-900"
                  : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
              } ${tab.id === "notas" && cliente.notas.length > 0 ? "relative" : ""}`}
            >
              {tab.label}
              {tab.id === "notas" && cliente.notas.length > 0 && (
                <span className="ml-1.5 text-xs bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded-full">
                  {cliente.notas.length}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="p-6">

          {/* ── INFORMACIÓN ─────────────────────────────────────────────── */}
          {activeTab === "informacion" && (
            <form onSubmit={handleGuardar} className="space-y-8 max-w-2xl">

              {/* Tipo */}
              <section className="space-y-4">
                <SectionTitle>Datos de identificación</SectionTitle>

                <div>
                  <label className={labelClass}>Tipo de cliente</label>
                  <div className="flex rounded-lg border border-slate-200 overflow-hidden w-fit">
                    {(["empresa", "persona"] as Cliente["tipo_cliente"][]).map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setForm((prev) => ({ ...prev, tipo_cliente: t }))}
                        className={`px-4 py-2 text-sm font-medium transition-colors ${
                          form.tipo_cliente === t ? "bg-[#0EA5E9] text-white" : "bg-white text-slate-600 hover:bg-slate-50"
                        }`}
                      >
                        {t === "empresa" ? "Empresa" : "Persona"}
                      </button>
                    ))}
                  </div>
                </div>

                {form.tipo_cliente === "empresa" && (
                  <div>
                    <label className={labelClass}>Razón social</label>
                    <input type="text" name="empresa" value={form.empresa} onChange={handleChange} className={`${inputClass} uppercase`} />
                  </div>
                )}

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className={labelClass}>{form.tipo_cliente === "empresa" ? "Persona de contacto" : "Nombre completo"}</label>
                    <input type="text" name="nombre_contacto" value={form.nombre_contacto} onChange={handleChange} className={`${inputClass} uppercase`} required />
                  </div>
                  <div>
                    <label className={labelClass}>{form.tipo_cliente === "empresa" ? "RUC" : "CI / Documento"}</label>
                    {form.tipo_cliente === "empresa" ? (
                      <input type="text" name="ruc" value={form.ruc} onChange={handleChange} className={inputClass} />
                    ) : (
                      <input type="text" name="documento" value={form.documento} onChange={handleChange} className={inputClass} />
                    )}
                  </div>
                </div>
              </section>

              {/* Contacto */}
              <section className="space-y-4">
                <SectionTitle>Contacto</SectionTitle>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className={labelClass}>Teléfono principal</label>
                    <input type="text" name="telefono" value={form.telefono} onChange={handleChange} className={inputClass} />
                  </div>
                  <div>
                    <label className={labelClass}>Teléfono secundario</label>
                    <input type="text" name="telefono_secundario" value={form.telefono_secundario} onChange={handleChange} className={inputClass} />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className={labelClass}>Email principal</label>
                    <input type="email" name="email" value={form.email} onChange={handleChange} className={inputClass} />
                  </div>
                  <div>
                    <label className={labelClass}>Email secundario</label>
                    <input type="email" name="email_secundario" value={form.email_secundario} onChange={handleChange} className={inputClass} />
                  </div>
                </div>

                <div>
                  <label className={labelClass}>Dirección</label>
                  <input type="text" name="direccion" value={form.direccion} onChange={handleChange} className={inputClass} />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className={labelClass}>Ciudad</label>
                    <input type="text" name="ciudad" value={form.ciudad} onChange={handleChange} className={`${inputClass} uppercase`} />
                  </div>
                  <div>
                    <label className={labelClass}>País</label>
                    <input type="text" name="pais" value={form.pais} onChange={handleChange} className={`${inputClass} uppercase`} />
                  </div>
                </div>
              </section>

              {/* Digital */}
              <section className="space-y-4">
                <SectionTitle>Presencia digital</SectionTitle>
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <label className={labelClass}>Sitio web</label>
                    <input type="text" name="sitio_web" value={form.sitio_web} onChange={handleChange} placeholder="https://" className={inputClass} />
                  </div>
                  <div>
                    <label className={labelClass}>Instagram</label>
                    <input type="text" name="instagram" value={form.instagram} onChange={handleChange} placeholder="@usuario" className={inputClass} />
                  </div>
                  <div>
                    <label className={labelClass}>LinkedIn</label>
                    <input type="text" name="linkedin" value={form.linkedin} onChange={handleChange} placeholder="URL o perfil" className={inputClass} />
                  </div>
                </div>
              </section>

              {/* Comercial */}
              <section className="space-y-4">
                <SectionTitle>Datos comerciales</SectionTitle>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className={labelClass}>Categoría</label>
                    <input type="text" name="categoria_cliente" value={form.categoria_cliente} onChange={handleChange} className={`${inputClass} uppercase`} />
                  </div>
                  <div>
                    <label className={labelClass}>Industria</label>
                    <input type="text" name="industria" value={form.industria} onChange={handleChange} className={`${inputClass} uppercase`} />
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <label className={labelClass}>Condición de pago</label>
                    <select
                      name="condicion_pago"
                      value={form.condicion_pago}
                      onChange={handleChange}
                      className={inputClass}
                    >
                      <option value="">—</option>
                      <option value="CONTADO">Contado</option>
                      <option value="15 DÍAS">15 días</option>
                      <option value="30 DÍAS">30 días</option>
                      <option value="60 DÍAS">60 días</option>
                      <option value="90 DÍAS">90 días</option>
                      <option value="MENSUAL">Mensual</option>
                    </select>
                  </div>
                  <div>
                    <label className={labelClass}>Moneda preferida</label>
                    <select
                      name="moneda_preferida"
                      value={form.moneda_preferida}
                      onChange={(e) => setForm((p) => ({ ...p, moneda_preferida: e.target.value as "GS" | "USD" }))}
                      className={inputClass}
                    >
                      <option value="GS">Guaraníes (GS)</option>
                      <option value="USD">Dólares (USD)</option>
                    </select>
                  </div>
                  <div>
                    <label className={labelClass}>Valor anual estimado (Gs.)</label>
                    <input type="number" name="valor_cliente" value={form.valor_cliente} onChange={handleChange} min={0} step={1} className={inputClass} />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className={labelClass}>Vendedor asignado</label>
                    <input type="text" name="vendedor_asignado" value={form.vendedor_asignado} onChange={handleChange} className={`${inputClass} uppercase`} />
                  </div>
                  <div>
                    <label className={labelClass}>Estado</label>
                    <select
                      name="estado"
                      value={form.estado}
                      onChange={(e) => setForm((p) => ({ ...p, estado: e.target.value as Cliente["estado"] }))}
                      className={inputClass}
                    >
                      <option value="activo">Activo</option>
                      <option value="inactivo">Inactivo</option>
                    </select>
                  </div>
                </div>

                {/* Campos de suscripción (solo cuando condicion_pago = MENSUAL y no tiene suscripciones) */}
                {form.condicion_pago === "MENSUAL" && (
                  <div className="mt-6 p-4 bg-slate-50 rounded-xl border border-slate-200 space-y-4">
                    <SectionTitle>Configuración de suscripción</SectionTitle>
                    {suscripciones.length > 0 ? (
                      <p className="text-sm text-slate-600">Este cliente ya tiene {suscripciones.length} suscripción(es). Podés agregar más desde la pestaña Suscripciones.</p>
                    ) : (
                      <>
                        <div>
                          <label className={labelClass}>Plan</label>
                          <select
                            value={formSuscEdit.plan_id}
                            onChange={(e) => {
                              const p = planes.find((x) => x.id === e.target.value);
                              setFormSuscEdit((prev) => ({ ...prev, plan_id: e.target.value, precio: p ? String(p.precio) : prev.precio }));
                            }}
                            className={inputClass}
                          >
                            <option value="">— Seleccionar plan —</option>
                            {planes.filter((p) => p.estado === "activo").map((p) => (
                              <option key={p.id} value={p.id}>{p.nombre} — Gs. {p.precio.toLocaleString("es-PY")}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className={labelClass}>Precio (Gs.)</label>
                          <input
                            type="number"
                            value={formSuscEdit.precio}
                            onChange={(e) => setFormSuscEdit((p) => ({ ...p, precio: e.target.value }))}
                            className={inputClass}
                            min={0}
                            placeholder="Monto mensual"
                          />
                        </div>
                        <div>
                          <label className={labelClass}>Duración contrato (meses)</label>
                          <input
                            type="number"
                            value={formSuscEdit.duracion_meses}
                            onChange={(e) => setFormSuscEdit((p) => ({ ...p, duracion_meses: e.target.value }))}
                            className={inputClass}
                            min={1}
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <label className={labelClass}>Día facturación (1–28)</label>
                            <input
                              type="number"
                              value={formSuscEdit.dia_facturacion}
                              onChange={(e) => setFormSuscEdit((p) => ({ ...p, dia_facturacion: e.target.value }))}
                              className={inputClass}
                              min={1}
                              max={28}
                            />
                          </div>
                          <div>
                            <label className={labelClass}>Día vencimiento (1–31)</label>
                            <input
                              type="number"
                              value={formSuscEdit.dia_vencimiento}
                              onChange={(e) => setFormSuscEdit((p) => ({ ...p, dia_vencimiento: e.target.value }))}
                              className={inputClass}
                              min={1}
                              max={31}
                            />
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            id="gen_fact_edit"
                            checked={formSuscEdit.generar_factura}
                            onChange={(e) => setFormSuscEdit((p) => ({ ...p, generar_factura: e.target.checked }))}
                          />
                          <label htmlFor="gen_fact_edit" className="text-sm text-slate-600">Emitir factura este mes</label>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </section>

              {formError && (
                <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
                  <span>⚠</span><span className="font-medium">{formError}</span>
                </div>
              )}

              <div className="flex gap-3">
                <button
                  type="submit"
                  className="bg-[#0EA5E9] hover:bg-[#0284C7] text-white px-5 py-2.5 rounded-lg text-sm font-medium transition-colors shadow-sm active:scale-95"
                >
                  Guardar cambios
                </button>
              </div>
            </form>
          )}

          {/* ── ESTADO DE CUENTA ─────────────────────────────────────────── */}
          {activeTab === "estado_cuenta" && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <SectionTitle>Facturas del cliente</SectionTitle>
                <button
                  type="button"
                  onClick={() => {
                    const conSaldo = facturas.filter((f) => f.saldo > 0);
                    const primera = conSaldo[0];
                    setFacturaPago(null);
                    setFormPago({
                      factura_id: primera?.id ?? "",
                      monto: primera ? String(primera.saldo) : "",
                      fecha_pago: new Date().toISOString().slice(0, 10),
                      metodo_pago: "efectivo",
                      referencia: "",
                    });
                    setModalPago(true);
                  }}
                  className="text-sm font-medium text-[#0EA5E9] hover:text-[#0284C7]"
                >
                  Registrar pago
                </button>
              </div>
              {facturas.length === 0 ? (
                <p className="text-sm text-gray-400 py-8 text-center">No hay facturas registradas.</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-slate-200">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50">
                      <tr>
                        {["Número", "Fecha", "Vencimiento", "Total", "Estado"].map((h) => (
                          <th key={h} className="text-left text-xs font-semibold text-slate-600 px-4 py-3">{h}</th>
                        ))}
                        <th className="text-right text-xs font-semibold text-slate-600 px-4 py-3">Acción</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {facturas.map((f) => (
                        <tr key={f.id} className="hover:bg-slate-50">
                          <td className="px-4 py-3 font-mono text-slate-800">{f.numero_factura}</td>
                          <td className="px-4 py-3 text-slate-600">{formatFecha(f.fecha)}</td>
                          <td className="px-4 py-3 text-slate-600">{formatFecha(f.fecha_vencimiento)}</td>
                          <td className="px-4 py-3 font-semibold text-slate-800">Gs. {f.monto.toLocaleString("es-PY")}</td>
                          <td className="px-4 py-3">
                            <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                              f.estado === "Pagado" ? "bg-green-100 text-green-700" :
                              f.estado === "Vencido" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"
                            }`}>{f.estado}</span>
                          </td>
                          <td className="px-4 py-3 text-right">
                            {f.saldo > 0 && (
                              <button
                                type="button"
                                onClick={() => { setFacturaPago(f); setFormPago({ factura_id: f.id, monto: String(f.saldo), fecha_pago: new Date().toISOString().slice(0, 10), metodo_pago: "efectivo", referencia: "" }); setModalPago(true); }}
                                className="text-xs font-medium text-[#0EA5E9] hover:underline"
                              >
                                Registrar pago
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ── SUSCRIPCIONES ────────────────────────────────────────────── */}
          {activeTab === "suscripciones" && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <SectionTitle>Suscripciones activas</SectionTitle>
                <button
                  type="button"
                  onClick={() => { setFormSusc({ plan_id: "", precio: "", fecha_inicio: new Date().toISOString().slice(0, 10), duracion_meses: "12", dia_facturacion: "1", dia_vencimiento: "10", generar_factura_este_mes: false }); setModalSuscripcion(true); }}
                  className="bg-[#0EA5E9] hover:bg-[#0284C7] text-white px-4 py-2 rounded-lg text-sm font-medium"
                >
                  Nueva suscripción
                </button>
              </div>
              {suscripciones.length === 0 ? (
                <p className="text-sm text-gray-400 py-8 text-center">No hay suscripciones.</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-slate-200">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50">
                      <tr>
                        {["Plan", "Precio", "Fecha inicio", "Duración", "Estado"].map((h) => (
                          <th key={h} className="text-left text-xs font-semibold text-slate-600 px-4 py-3">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {suscripciones.map((s) => (
                        <tr key={s.id} className="hover:bg-slate-50">
                          <td className="px-4 py-3 font-medium text-slate-800">
                            {planes.find((p) => p.id === s.plan_id)?.nombre ?? s.plan_nombre ?? "—"}
                          </td>
                          <td className="px-4 py-3 text-slate-600">Gs. {s.precio.toLocaleString("es-PY")}</td>
                          <td className="px-4 py-3 text-slate-600">{formatFecha(s.fecha_inicio)}</td>
                          <td className="px-4 py-3 text-slate-600">{s.duracion_meses} meses</td>
                          <td className="px-4 py-3">
                            <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                              s.estado === "activa" ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-600"
                            }`}>{s.estado}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ── PROYECTOS ────────────────────────────────────────────────── */}
          {activeTab === "proyectos" && (
            <PlaceholderTab
              icon="📁"
              title="Proyectos"
              desc="Proyectos en curso y finalizados asociados a este cliente, con etapas y responsables."
            />
          )}

          {/* ── ACTIVIDAD ────────────────────────────────────────────────── */}
          {activeTab === "actividad" && (
            <PlaceholderTab
              icon="🕐"
              title="Actividad"
              desc="Timeline completo de interacciones, cambios de estado, ventas y eventos del cliente."
            />
          )}

          {/* ── NOTAS ───────────────────────────────────────────────────── */}
          {activeTab === "notas" && (
            <div className="max-w-2xl space-y-6">
              <form onSubmit={handleAgregarNota}>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Nueva nota</label>
                <textarea
                  ref={notaRef}
                  value={nuevaNota}
                  onChange={(e) => setNuevaNota(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault();
                      handleAgregarNota(e as unknown as React.FormEvent);
                    }
                  }}
                  rows={3}
                  placeholder="Escribí una nota interna (Ctrl+Enter para guardar)..."
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-[#0EA5E9] focus:outline-none bg-white text-sm resize-none mb-3"
                />
<button
                type="submit"
                disabled={!nuevaNota.trim() || guardandoNota}
                className="bg-[#0EA5E9] hover:bg-[#0284C7] text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors shadow-sm disabled:opacity-40 disabled:cursor-not-allowed active:scale-95"
              >
                  Agregar nota
                </button>
              </form>

              {cliente.notas.length === 0 ? (
                <p className="text-sm text-gray-400 italic">No hay notas registradas aún.</p>
              ) : (
                <div className="space-y-3">
                  {[...cliente.notas].reverse().map((nota: NotaCliente) => (
                    <div key={nota.id} className="bg-gray-50 border border-gray-200 rounded-lg px-4 py-3">
                      <p className="text-sm text-gray-700 whitespace-pre-wrap">{nota.texto}</p>
                      <p className="text-xs text-gray-400 mt-2">{formatFechaHora(nota.fecha)}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

        </div>
      </div>

      {/* Modal Nueva suscripción */}
      {modalSuscripcion && cliente && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setModalSuscripcion(false)}>
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-gray-800 mb-4">Nueva suscripción</h3>
            <form onSubmit={async (e) => {
              e.preventDefault();
              setGuardandoSusc(true);
              const plan = planes.find((p) => p.id === formSusc.plan_id);
              await saveSuscripcion({
                cliente_id: id,
                plan_id: formSusc.plan_id || null,
                precio: parseFloat(formSusc.precio) || (plan?.precio ?? 0),
                moneda: "GS",
                fecha_inicio: formSusc.fecha_inicio || new Date().toISOString().slice(0, 10),
                duracion_meses: parseInt(formSusc.duracion_meses, 10) || 12,
                dia_facturacion: parseInt(formSusc.dia_facturacion, 10) || 1,
                dia_vencimiento: parseInt(formSusc.dia_vencimiento, 10) || 10,
                generar_factura_este_mes: formSusc.generar_factura_este_mes,
              }, plan?.nombre);
              setModalSuscripcion(false);
              getSuscripciones(id).then(setSuscripciones);
              getFacturas(id).then(setFacturas);
              setGuardandoSusc(false);
            }} className="space-y-4">
              <div>
                <label className={labelClass}>Plan</label>
                <select
                  value={formSusc.plan_id}
                  onChange={(e) => {
                    const p = planes.find((x) => x.id === e.target.value);
                    setFormSusc((prev) => ({ ...prev, plan_id: e.target.value, precio: p ? String(p.precio) : prev.precio }));
                  }}
                  className={inputClass}
                >
                  <option value="">— Seleccionar —</option>
                  {planes.filter((p) => p.estado === "activo").map((p) => (
                    <option key={p.id} value={p.id}>{p.nombre} — Gs. {p.precio.toLocaleString("es-PY")}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelClass}>Precio</label>
                <input type="number" value={formSusc.precio} onChange={(e) => setFormSusc((p) => ({ ...p, precio: e.target.value }))} className={inputClass} min={0} required />
              </div>
              <div>
                <label className={labelClass}>Fecha inicio</label>
                <input type="date" value={formSusc.fecha_inicio} onChange={(e) => setFormSusc((p) => ({ ...p, fecha_inicio: e.target.value }))} className={inputClass} required />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelClass}>Duración (meses)</label>
                  <input type="number" value={formSusc.duracion_meses} onChange={(e) => setFormSusc((p) => ({ ...p, duracion_meses: e.target.value }))} className={inputClass} min={1} />
                </div>
                <div>
                  <label className={labelClass}>Día facturación</label>
                  <input type="number" value={formSusc.dia_facturacion} onChange={(e) => setFormSusc((p) => ({ ...p, dia_facturacion: e.target.value }))} className={inputClass} min={1} max={28} />
                </div>
              </div>
              <div>
                <label className={labelClass}>Día vencimiento</label>
                <input type="number" value={formSusc.dia_vencimiento} onChange={(e) => setFormSusc((p) => ({ ...p, dia_vencimiento: e.target.value }))} className={inputClass} min={1} max={31} />
              </div>
              <div className="flex items-center gap-2">
                <input type="checkbox" id="gen_fact" checked={formSusc.generar_factura_este_mes} onChange={(e) => setFormSusc((p) => ({ ...p, generar_factura_este_mes: e.target.checked }))} />
                <label htmlFor="gen_fact" className="text-sm text-slate-600">Emitir factura este mes</label>
              </div>
              <div className="flex gap-3 pt-2">
                <button type="submit" disabled={guardandoSusc} className="bg-[#0EA5E9] hover:bg-[#0284C7] text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50">
                  Guardar
                </button>
                <button type="button" onClick={() => setModalSuscripcion(false)} className="border border-slate-200 px-4 py-2 rounded-lg text-sm hover:bg-slate-50">
                  Cancelar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal Registrar pago */}
      {modalPago && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setModalPago(false)}>
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-gray-800 mb-4">Registrar pago</h3>
            {facturaPago && <p className="text-sm text-slate-600 mb-4">Factura {facturaPago.numero_factura} — Saldo: Gs. {facturaPago.saldo.toLocaleString("es-PY")}</p>}
            <form onSubmit={async (e) => {
              e.preventDefault();
              const fid = facturaPago?.id ?? formPago.factura_id;
              if (!fid) return;
              setGuardandoPago(true);
              await savePago({
                factura_id: fid,
                monto: parseFloat(formPago.monto) || 0,
                fecha_pago: formPago.fecha_pago,
                metodo_pago: formPago.metodo_pago,
                referencia: formPago.referencia || undefined,
              });
              setModalPago(false);
              getFacturas(id).then(setFacturas);
              setGuardandoPago(false);
            }} className="space-y-4">
              {!facturaPago && facturas.filter((f) => f.saldo > 0).length > 0 && (
                <div>
                  <label className={labelClass}>Factura</label>
                  <select
                    value={formPago.factura_id}
                    onChange={(e) => {
                      const f = facturas.find((x) => x.id === e.target.value);
                      if (f) setFormPago((p) => ({ ...p, factura_id: f.id, monto: String(f.saldo) }));
                    }}
                    className={inputClass}
                    required
                  >
                    <option value="">— Seleccionar —</option>
                    {facturas.filter((f) => f.saldo > 0).map((f) => (
                      <option key={f.id} value={f.id}>{f.numero_factura} — Saldo Gs. {f.saldo.toLocaleString("es-PY")}</option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label className={labelClass}>Monto</label>
                <input type="number" value={formPago.monto} onChange={(e) => setFormPago((p) => ({ ...p, monto: e.target.value }))} className={inputClass} min={0} step={0.01} required />
              </div>
              <div>
                <label className={labelClass}>Fecha pago</label>
                <input type="date" value={formPago.fecha_pago} onChange={(e) => setFormPago((p) => ({ ...p, fecha_pago: e.target.value }))} className={inputClass} required />
              </div>
              <div>
                <label className={labelClass}>Método de pago</label>
                <select value={formPago.metodo_pago} onChange={(e) => setFormPago((p) => ({ ...p, metodo_pago: e.target.value as "efectivo" }))} className={inputClass}>
                  <option value="efectivo">Efectivo</option>
                  <option value="transferencia">Transferencia</option>
                  <option value="cheque">Cheque</option>
                  <option value="tarjeta">Tarjeta</option>
                  <option value="otro">Otro</option>
                </select>
              </div>
              <div>
                <label className={labelClass}>Referencia</label>
                <input type="text" value={formPago.referencia} onChange={(e) => setFormPago((p) => ({ ...p, referencia: e.target.value }))} className={inputClass} placeholder="Nº de comprobante" />
              </div>
              <div className="flex gap-3 pt-2">
                <button type="submit" disabled={guardandoPago} className="bg-[#0EA5E9] hover:bg-[#0284C7] text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50">
                  Guardar
                </button>
                <button type="button" onClick={() => setModalPago(false)} className="border border-slate-200 px-4 py-2 rounded-lg text-sm hover:bg-slate-50">
                  Cancelar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
  );
}
