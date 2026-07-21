"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import MontoInput from "@/components/ui/MontoInput";
import SearchableSelect from "@/components/ui/SearchableSelect";
import { saveCompraMulti, uploadComprobante, type CompraItemPayload } from "@/lib/compras/storage";
import { getProveedores, proveedorExiste, createProveedor } from "@/lib/proveedores/storage";
import { getProductos, productoExiste, saveProducto } from "@/lib/inventario/storage";
import type { TipoIva, TipoPago, Moneda } from "@/lib/compras/types";
import type { Proveedor } from "@/lib/proveedores/types";
import type { MetodoValuacion, Producto } from "@/lib/inventario/types";

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatGs(valor: number) {
  return `Gs. ${Math.round(valor).toLocaleString("es-PY")}`;
}
function margenColor(m: number) {
  if (m >= 40) return "text-green-600";
  if (m >= 20) return "text-yellow-600";
  return "text-red-600";
}
/**
 * IVA INCLUIDO (mismo patrón que Ventas y que las facturas físicas de proveedores):
 * el precio unitario que se carga YA contiene el IVA. El monto de IVA se desglosa
 * "desde adentro" a partir del total, no se suma encima.
 *
 * Total = precio × cantidad
 * IVA   = total − total / (1 + tasa)
 * Base  = total − IVA
 */
function ivaMonto(total: number, iva: TipoIva): number {
  if (iva === "exenta") return 0;
  if (iva === "5") return total - total / 1.05;
  return total - total / 1.10;
}

const inputClass =
  "w-full border border-slate-200 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-[#0EA5E9] focus:outline-none bg-white text-sm";
const inputSmClass = inputClass;
const labelClass = "block text-sm font-medium text-slate-700 mb-2";
const labelSmClass = "block text-xs font-medium text-slate-600 mb-1.5";

const ivaLabel: Record<TipoIva, string> = { exenta: "Exenta", "5": "IVA 5%", "10": "IVA 10%" };

// ── Tipos locales ────────────────────────────────────────────────────────────

type LineaCompra = {
  producto_id: string;
  producto_nombre: string;
  sku: string;
  cantidad: number;
  costo_unitario_input: number; // en la moneda de la cabecera
  costo_unitario_pyg: number;
  iva_tipo: TipoIva;
  precio_venta: number;
  subtotal: number;
  monto_iva: number;
  total: number;
  margen_venta: number | null;
};

// ── SegmentedControl ───────────────────────────────────────────────────────────

function SegmentedControl<T extends string>({
  value, options, onChange, small = false,
}: {
  value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; small?: boolean;
}) {
  return (
    <div className="flex border border-slate-200 rounded-lg overflow-hidden">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`flex-1 font-medium transition-colors ${small ? "py-2 text-xs" : "py-2.5 text-sm"} ${
            value === opt.value ? "bg-[#0EA5E9] text-white" : "bg-white text-slate-600 hover:bg-slate-50"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// ── Componente principal ───────────────────────────────────────────────────────

export default function NuevaCompraPage() {
  const router = useRouter();

  const [proveedores, setProveedores] = useState<Proveedor[]>([]);
  const [productos, setProductos] = useState<Producto[]>([]);

  // Cabecera (compartida por toda la compra)
  const [cab, setCab] = useState({
    proveedor_id: "",
    nro_timbrado: "",
    tipo_pago: "contado" as TipoPago,
    plazo_dias: "",
    moneda: "PYG" as Moneda,
    tipo_cambio: "",
    fecha_factura: "" as string,
    metodo_pago: "" as "" | "efectivo" | "transferencia" | "tarjeta",
  });

  // Líneas ya agregadas
  const [lineas, setLineas] = useState<LineaCompra[]>([]);

  // Editor de la línea en curso
  const [nl, setNl] = useState({
    producto_id: "",
    cantidad: "",
    costo_unitario_input: "",
    iva_tipo: "10" as TipoIva,
    precio_venta: "",
  });

  // Inline crear proveedor / producto
  const [mostrarFormProveedor, setMostrarFormProveedor] = useState(false);
  const [formProveedor, setFormProveedor] = useState({ nombre: "", ruc: "", telefono: "", email: "", contacto: "" });
  const [errorRuc, setErrorRuc] = useState<string | null>(null);
  const [proveedorCreado, setProveedorCreado] = useState<string | null>(null);

  const [mostrarFormProducto, setMostrarFormProducto] = useState(false);
  const [formProducto, setFormProducto] = useState({
    nombre: "", sku: "", unidad_medida: "Unidad", metodo_valuacion: "CPP" as MetodoValuacion,
    stock_minimo: "0", precio_venta_sugerido: "", tipo: "reventa" as "reventa" | "menu" | "materia",
  });
  const [errorSku, setErrorSku] = useState<string | null>(null);
  const [productoCreado, setProductoCreado] = useState<string | null>(null);

  // Comprobante / factura del proveedor (opcional, para toda la compra)
  const [comprobanteFile, setComprobanteFile] = useState<File | null>(null);
  const [comprobanteError, setComprobanteError] = useState<string | null>(null);

  const [errorLinea, setErrorLinea] = useState<string | null>(null);
  const [errorSubmit, setErrorSubmit] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function handleComprobanteChange(e: React.ChangeEvent<HTMLInputElement>) {
    setComprobanteError(null);
    const f = e.target.files?.[0] ?? null;
    if (f && !["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(f.type)) {
      setComprobanteError("Formato no permitido. Usá JPG, PNG, WebP o PDF.");
      setComprobanteFile(null);
      return;
    }
    if (f && f.size > 10 * 1024 * 1024) {
      setComprobanteError("Archivo demasiado grande (máx. 10 MB).");
      setComprobanteFile(null);
      return;
    }
    setComprobanteFile(f);
  }

  async function recargarProveedores() {
    const data = await getProveedores();
    setProveedores(data.filter((p) => p.estado === "activo"));
  }
  function recargarProductos() { getProductos().then(setProductos); }
  useEffect(() => { recargarProveedores(); recargarProductos(); }, []);

  // ── Cálculos de la línea en curso ──────────────────────────────────────────
  const tipoCambioNum = cab.moneda === "USD" ? parseFloat(cab.tipo_cambio) || 0 : 1;
  const nlCant = parseFloat(nl.cantidad) || 0;
  const nlCostoInput = parseFloat(nl.costo_unitario_input) || 0;
  const nlCostoPYG = nlCostoInput * tipoCambioNum;
  const nlPrecio = parseFloat(nl.precio_venta) || 0;
  // IVA incluido: el costo unitario cargado ya contiene el IVA.
  // Total línea = precio × cantidad; IVA se desglosa desde adentro; subtotal = base imponible.
  const nlTotal = nlCant > 0 && nlCostoPYG > 0 ? nlCant * nlCostoPYG : 0;
  const nlIva = ivaMonto(nlTotal, nl.iva_tipo);
  const nlSubtotal = nlTotal - nlIva;
  const nlMargen = nlPrecio > 0 && nlCostoPYG > 0 ? ((nlPrecio - nlCostoPYG) / nlPrecio) * 100 : null;
  const productoSel = productos.find((p) => p.id === nl.producto_id);
  // Solo informativo: para mostrar el aviso "es materia prima". Ya NO condiciona
  // si se puede agregar — el precio de venta es opcional para cualquier producto.
  const esInsumoNoVendible = !!productoSel && productoSel.es_insumo === true && productoSel.es_vendible !== true;
  // Precio de venta OPCIONAL: la compra no lo exige. Si se deja en 0, el backend
  // conserva el precio actual del producto (UPDATE ... CASE WHEN $3 > 0), no lo
  // pisa con 0. Solo se pide producto, cantidad y costo.
  const lineaLista = !!nl.producto_id && nlCant > 0 && nlCostoPYG > 0;
  // Motivo por el que el botón está deshabilitado, para no dejar al usuario
  // adivinando.
  const motivoNoAgregar = !nl.producto_id
    ? "Elegí un producto."
    : nlCant <= 0
    ? "Ingresá la cantidad."
    : nlCostoPYG <= 0
    ? "Ingresá el costo unitario."
    : null;

  // ── Totales de la compra ───────────────────────────────────────────────────
  const totales = useMemo(() => {
    return lineas.reduce(
      (acc, l) => ({
        subtotal: acc.subtotal + l.subtotal,
        iva: acc.iva + l.monto_iva,
        total: acc.total + l.total,
      }),
      { subtotal: 0, iva: 0, total: 0 }
    );
  }, [lineas]);

  // ── Agregar / quitar línea ──────────────────────────────────────────────────
  function handleAgregarLinea() {
    setErrorLinea(null);
    if (!nl.producto_id) return setErrorLinea("Elegí un producto.");
    if (nlCant <= 0) return setErrorLinea("La cantidad debe ser mayor a 0.");
    if (nlCostoPYG <= 0) return setErrorLinea("El costo unitario debe ser mayor a 0.");
    if (cab.moneda === "USD" && tipoCambioNum <= 0)
      return setErrorLinea("Cargá el tipo de cambio (USD → Gs.) en la cabecera.");
    const prod = productos.find((p) => p.id === nl.producto_id);
    if (!prod) return setErrorLinea("Producto no encontrado. Recargá e intentá de nuevo.");

    setLineas((prev) => [
      ...prev,
      {
        producto_id: prod.id,
        producto_nombre: prod.nombre,
        sku: prod.sku,
        cantidad: nlCant,
        costo_unitario_input: nlCostoInput,
        costo_unitario_pyg: nlCostoPYG,
        iva_tipo: nl.iva_tipo,
        // Para insumos sin precio cargado, guardamos el precio actual del producto
        // (no inventamos uno). El backend no sobreescribe productos.precio_venta con 0.
        precio_venta: nlPrecio > 0 ? nlPrecio : (prod.precio_venta ?? 0),
        subtotal: nlSubtotal,
        monto_iva: nlIva,
        total: nlTotal,
        margen_venta: nlMargen,
      },
    ]);
    setNl({ producto_id: "", cantidad: "", costo_unitario_input: "", iva_tipo: "10", precio_venta: "" });
    setProductoCreado(null);
  }

  function handleQuitarLinea(idx: number) {
    setLineas((prev) => prev.filter((_, i) => i !== idx));
  }

  // ── Submit ──────────────────────────────────────────────────────────────────
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorSubmit(null);
    if (!cab.proveedor_id) return setErrorSubmit("Seleccioná o agregá un proveedor.");
    if (!cab.nro_timbrado.trim()) return setErrorSubmit("Ingresá el N° de timbrado.");
    if (lineas.length === 0) return setErrorSubmit("Agregá al menos un producto a la compra.");
    if (cab.moneda === "USD" && tipoCambioNum <= 0)
      return setErrorSubmit("Cargá el tipo de cambio (USD → Gs.).");

    const proveedor = proveedores.find((p) => String(p.id) === cab.proveedor_id);
    if (!proveedor) return setErrorSubmit("Proveedor no encontrado. Recargá e intentá de nuevo.");

    const items: CompraItemPayload[] = lineas.map((l) => ({
      producto_id: l.producto_id,
      producto_nombre: l.producto_nombre,
      cantidad: l.cantidad,
      costo_unitario: l.costo_unitario_pyg,
      costo_unitario_original: l.costo_unitario_input,
      iva_tipo: l.iva_tipo,
      subtotal: l.subtotal,
      monto_iva: l.monto_iva,
      total: l.total,
      precio_venta: l.precio_venta,
      margen_venta: l.margen_venta ?? 0,
    }));

    setSubmitting(true);
    try {
      // Subir comprobante primero (si hay) para asociarlo a toda la compra.
      let comprobante: { comprobante_storage_path: string; comprobante_nombre: string; comprobante_mime_type: string } | null = null;
      if (comprobanteFile) {
        const up = await uploadComprobante(comprobanteFile);
        if (!up.ok) { setErrorSubmit(`Comprobante: ${up.error}`); return; }
        comprobante = up.data;
      }

      const res = await saveCompraMulti(
        {
          proveedor_id: String(proveedor.id),
          proveedor_nombre: proveedor.nombre,
          moneda: cab.moneda,
          tipo_cambio: tipoCambioNum,
          tipo_pago: cab.tipo_pago,
          plazo_dias: cab.tipo_pago === "credito" && cab.plazo_dias ? parseInt(cab.plazo_dias) : undefined,
          nro_timbrado: cab.nro_timbrado,
          fecha_factura: cab.fecha_factura || null,
          metodo_pago: cab.metodo_pago || null,
          comprobante_storage_path: comprobante?.comprobante_storage_path ?? null,
          comprobante_nombre: comprobante?.comprobante_nombre ?? null,
          comprobante_mime_type: comprobante?.comprobante_mime_type ?? null,
        },
        items
      );
      if (!res.success) { setErrorSubmit(res.error); return; }
      if (res.warning) alert(res.warning);
      router.push("/compras");
    } finally {
      setSubmitting(false);
    }
  }

  // ── Inline proveedor ─────────────────────────────────────────────────────────
  function handleProveedorInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.name === "ruc") setErrorRuc(null);
    const { name, value, type } = e.target;
    let normalized = value;
    if (name === "email" || type === "email") normalized = value.toLowerCase();
    else if (["nombre", "contacto"].includes(name)) normalized = value.toUpperCase();
    setFormProveedor((prev) => ({ ...prev, [name]: normalized }));
  }
  async function handleAgregarProveedor() {
    if (!formProveedor.nombre.trim() || !formProveedor.ruc.trim()) return;
    setErrorRuc(null);
    const dup = await proveedorExiste(formProveedor.ruc);
    if (dup) { setErrorRuc(`RUC ya registrado para "${dup.nombre}".`); return; }
    const resultado = await createProveedor({
      nombre: formProveedor.nombre.trim().toUpperCase(), ruc: formProveedor.ruc.trim(),
      telefono: formProveedor.telefono.trim(), email: formProveedor.email.trim(),
      contacto: formProveedor.contacto.trim().toUpperCase(), direccion: "", estado: "activo",
    });
    if (!resultado.ok) { setErrorRuc(resultado.error); return; }
    await recargarProveedores();
    setCab((prev) => ({ ...prev, proveedor_id: String(resultado.proveedor.id) }));
    setProveedorCreado(resultado.proveedor.nombre);
    setMostrarFormProveedor(false);
    setFormProveedor({ nombre: "", ruc: "", telefono: "", email: "", contacto: "" });
  }
  function handleCancelarProveedor() {
    setMostrarFormProveedor(false);
    setFormProveedor({ nombre: "", ruc: "", telefono: "", email: "", contacto: "" });
    setErrorRuc(null);
  }

  // ── Inline producto ──────────────────────────────────────────────────────────
  function handleProductoInputChange(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) {
    if (e.target.name === "sku") setErrorSku(null);
    setFormProducto((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  }
  async function handleAgregarProducto() {
    if (!formProducto.nombre.trim() || !formProducto.sku.trim()) return;
    setErrorSku(null);
    const dup = await productoExiste(formProducto.sku, formProducto.nombre);
    if (dup) { setErrorSku(`Ya existe un producto con ese SKU o nombre ("${dup.nombre}" — ${dup.sku}).`); return; }
    // Mapear el tipo elegido a los flags del producto (igual que en Inventario → Nuevo).
    const flags =
      formProducto.tipo === "materia"
        ? { es_vendible: false, es_insumo: true, controla_stock: false }
        : formProducto.tipo === "menu"
        ? { es_vendible: true, es_insumo: false, controla_stock: false }
        : { es_vendible: true, es_insumo: false, controla_stock: true };
    const creado = await saveProducto({
      nombre: formProducto.nombre.trim().toUpperCase(), sku: formProducto.sku.trim().toUpperCase(),
      unidad_medida: formProducto.unidad_medida.toUpperCase(), metodo_valuacion: formProducto.metodo_valuacion,
      stock_actual: 0, stock_minimo: parseInt(formProducto.stock_minimo) || 0,
      costo_promedio: nlCostoPYG || 0, precio_venta: parseFloat(formProducto.precio_venta_sugerido) || 0,
      ...flags,
    });
    if (!creado) return;
    // Insert optimista para que la línea reconozca de inmediato si es insumo (precio opcional).
    setProductos((prev) => (prev.some((p) => p.id === creado.id) ? prev : [...prev, creado]));
    recargarProductos();
    const creadoInsumo = formProducto.tipo === "materia";
    setNl((prev) => ({
      ...prev, producto_id: creado.id,
      // Para materia prima dejamos el precio vacío (es opcional).
      precio_venta: creadoInsumo ? "" : (formProducto.precio_venta_sugerido || prev.precio_venta),
    }));
    setProductoCreado(creado.nombre);
    setMostrarFormProducto(false);
    setFormProducto({ nombre: "", sku: "", unidad_medida: "Unidad", metodo_valuacion: "CPP", stock_minimo: "0", precio_venta_sugerido: "", tipo: "reventa" });
  }
  function handleCancelarProducto() {
    setMostrarFormProducto(false);
    setFormProducto({ nombre: "", sku: "", unidad_medida: "Unidad", metodo_valuacion: "CPP", stock_minimo: "0", precio_venta_sugerido: "", tipo: "reventa" });
    setErrorSku(null);
  }

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-gray-800">Nueva compra</h1>
        <p className="text-gray-600">Una compra puede tener varios productos del mismo proveedor. Impacta el inventario al guardar.</p>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-6 max-w-3xl">
        <form className="space-y-8" onSubmit={handleSubmit}>

          {/* ── Cabecera ─────────────────────────────────────────────────────── */}
          <section className="space-y-4">
            <SectionTitle>Comprobante y proveedor</SectionTitle>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className={labelClass}>N° de timbrado <span className="text-red-500">*</span></label>
                <input type="text" name="nro_timbrado" value={cab.nro_timbrado}
                  onChange={(e) => setCab((p) => ({ ...p, nro_timbrado: e.target.value }))}
                  placeholder="Ej: 001-001-0000001" className={inputClass} />
              </div>
              <div>
                <label className={labelClass}>Fecha de la factura <span className="text-gray-400 font-normal">(opcional)</span></label>
                <input
                  type="date"
                  value={cab.fecha_factura}
                  onChange={(e) => setCab((p) => ({ ...p, fecha_factura: e.target.value }))}
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>Proveedor <span className="text-red-500">*</span></label>
                <SearchableSelect
                  value={cab.proveedor_id || null}
                  onChange={(id) => {
                    setCab((p) => ({ ...p, proveedor_id: id }));
                    setProveedorCreado(null);
                  }}
                  options={proveedores.map((p) => ({
                    id: String(p.id),
                    label: p.nombre,
                    hint: p.ruc ? `RUC ${p.ruc}` : null,
                  }))}
                  placeholder="Buscar proveedor…"
                  emptyText="Sin proveedores que coincidan"
                />
              </div>
              <div className="sm:col-span-2">
                <label className={labelClass}>Comprobante / factura <span className="text-gray-400 font-normal">(opcional)</span></label>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,application/pdf"
                  onChange={handleComprobanteChange}
                  className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-[#4FAEB2] file:px-4 file:py-2 file:text-xs file:font-semibold file:text-white hover:file:bg-[#3F8E91]"
                />
                {comprobanteFile && !comprobanteError && (
                  <p className="mt-1.5 text-xs text-green-600">✓ {comprobanteFile.name} listo para subir al guardar.</p>
                )}
                {comprobanteError && <p className="mt-1.5 text-xs text-red-600">{comprobanteError}</p>}
                <p className="mt-1 text-xs text-gray-400">JPG, PNG, WebP o PDF — máx. 10 MB. Se asocia a toda la compra.</p>
              </div>
            </div>

            {proveedorCreado && (
              <p className="text-xs text-green-600">✓ Proveedor &quot;{proveedorCreado}&quot; creado y seleccionado.</p>
            )}
            {!mostrarFormProveedor ? (
              <button type="button" onClick={() => { setMostrarFormProveedor(true); setProveedorCreado(null); }}
                className="text-xs text-gray-400 hover:text-gray-700 underline transition-colors">
                ¿No encontrás el proveedor? Crear nuevo
              </button>
            ) : (
              <InlineFormBox titulo="Nuevo proveedor" onCancel={handleCancelarProveedor} onSave={handleAgregarProveedor}
                saveDisabled={!formProveedor.nombre.trim() || !formProveedor.ruc.trim()}>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label className={labelSmClass}>Nombre / Razón social <span className="text-red-500">*</span></label>
                    <input type="text" name="nombre" value={formProveedor.nombre} onChange={handleProveedorInputChange}
                      placeholder="Ej: DISTRIBUIDORA SUR S.A." className={`${inputSmClass} uppercase`} />
                  </div>
                  <div>
                    <label className={labelSmClass}>RUC <span className="text-red-500">*</span></label>
                    <input type="text" name="ruc" value={formProveedor.ruc} onChange={handleProveedorInputChange}
                      placeholder="Ej: 80012345-1" className={`${inputSmClass} ${errorRuc ? "border-red-300 bg-red-50" : ""}`} />
                    {errorRuc && <p className="mt-1 text-xs text-red-600">{errorRuc}</p>}
                  </div>
                  <div>
                    <label className={labelSmClass}>Teléfono</label>
                    <input type="text" name="telefono" value={formProveedor.telefono} onChange={handleProveedorInputChange}
                      placeholder="Ej: 0981 111 222" className={inputSmClass} />
                  </div>
                  <div>
                    <label className={labelSmClass}>Email</label>
                    <input type="email" name="email" value={formProveedor.email} onChange={handleProveedorInputChange}
                      placeholder="Ej: ventas@empresa.com" className={inputSmClass} />
                  </div>
                  <div className="col-span-2">
                    <label className={labelSmClass}>Persona de contacto</label>
                    <input type="text" name="contacto" value={formProveedor.contacto} onChange={handleProveedorInputChange}
                      placeholder="Ej: CARLOS MENDOZA" className={`${inputSmClass} uppercase`} />
                  </div>
                </div>
              </InlineFormBox>
            )}
          </section>

          {/* ── Condiciones + moneda ─────────────────────────────────────────── */}
          <section className="space-y-4">
            <SectionTitle>Condiciones y moneda</SectionTitle>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className={labelClass}>Tipo de pago</label>
                <SegmentedControl<TipoPago> value={cab.tipo_pago}
                  options={[{ value: "contado", label: "Contado" }, { value: "credito", label: "Crédito" }]}
                  onChange={(v) => setCab((p) => ({ ...p, tipo_pago: v }))} />
                <p className="mt-1 text-[11px] text-slate-500">Contado vs. crédito (plazo).</p>
              </div>
              <div>
                <label className={labelClass}>Método de pago <span className="text-gray-400 font-normal">(opcional)</span></label>
                <select
                  value={cab.metodo_pago}
                  onChange={(e) =>
                    setCab((p) => ({
                      ...p,
                      metodo_pago:
                        e.target.value === "efectivo" ||
                        e.target.value === "transferencia" ||
                        e.target.value === "tarjeta"
                          ? e.target.value
                          : "",
                    }))
                  }
                  className={inputClass}
                >
                  <option value="">Sin especificar</option>
                  <option value="efectivo">Efectivo</option>
                  <option value="transferencia">Transferencia</option>
                  <option value="tarjeta">Tarjeta</option>
                </select>
                <p className="mt-1 text-[11px] text-slate-500">Cómo se hizo el pago.</p>
              </div>
              <div>
                <label className={labelClass}>Moneda</label>
                <SegmentedControl<Moneda> value={cab.moneda}
                  options={[{ value: "PYG", label: "Guaraníes (₲)" }, { value: "USD", label: "Dólares (USD)" }]}
                  onChange={(v) => setCab((p) => ({ ...p, moneda: v, tipo_cambio: "" }))} />
              </div>
              {cab.tipo_pago === "credito" && (
                <div>
                  <label className={labelClass}>Plazo (días)</label>
                  <input type="number" value={cab.plazo_dias} onChange={(e) => setCab((p) => ({ ...p, plazo_dias: e.target.value }))}
                    placeholder="Ej: 30" className={inputClass} min={1} />
                </div>
              )}
              {cab.moneda === "USD" && (
                <div>
                  <label className={labelClass}>Tipo de cambio (USD → Gs.) <span className="text-red-500">*</span></label>
                  <MontoInput value={cab.tipo_cambio} onChange={(n) => setCab((p) => ({ ...p, tipo_cambio: String(n) }))}
                    placeholder="Ej: 7500" className={inputClass} decimals={false} />
                </div>
              )}
            </div>
          </section>

          {/* ── Productos (líneas) ───────────────────────────────────────────── */}
          <section className="space-y-4">
            <SectionTitle>Productos de la compra</SectionTitle>

            {/* Líneas ya agregadas */}
            {lineas.length > 0 && (
              <div className="overflow-x-auto rounded-lg border border-slate-200">
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead className="bg-slate-50 text-gray-500">
                    <tr>
                      <th className="py-2 px-3 font-medium">Producto</th>
                      <th className="py-2 px-3 font-medium text-right">Cant.</th>
                      <th className="py-2 px-3 font-medium text-right">Costo unit.</th>
                      <th className="py-2 px-3 font-medium">IVA</th>
                      <th className="py-2 px-3 font-medium text-right">Precio venta</th>
                      <th className="py-2 px-3 font-medium text-right">Total línea</th>
                      <th className="py-2 px-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {lineas.map((l, i) => (
                      <tr key={`${l.producto_id}-${i}`} className="border-t border-slate-100">
                        <td className="py-2 px-3">
                          <div className="font-medium text-gray-800">{l.producto_nombre}</div>
                          <div className="font-mono text-[11px] text-gray-400">{l.sku}</div>
                        </td>
                        <td className="py-2 px-3 text-right tabular-nums">{l.cantidad}</td>
                        <td className="py-2 px-3 text-right tabular-nums text-gray-600">{formatGs(l.costo_unitario_pyg)}</td>
                        <td className="py-2 px-3 text-xs text-gray-500">{ivaLabel[l.iva_tipo]}</td>
                        <td className="py-2 px-3 text-right tabular-nums text-gray-600">{formatGs(l.precio_venta)}</td>
                        <td className="py-2 px-3 text-right tabular-nums font-semibold text-gray-800">{formatGs(l.total)}</td>
                        <td className="py-2 px-3 text-right">
                          <button type="button" onClick={() => handleQuitarLinea(i)}
                            className="text-red-500 hover:text-red-700 text-xs font-medium" aria-label="Quitar línea">
                            Quitar
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-slate-200 bg-slate-50/60">
                      <td className="py-2 px-3 text-xs font-semibold uppercase tracking-wide text-gray-500" colSpan={5}>
                        Total compra ({lineas.length} {lineas.length === 1 ? "ítem" : "ítems"})
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums font-bold text-[#0EA5E9]">{formatGs(totales.total)}</td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}

            {/* Editor de nueva línea */}
            <div className="rounded-xl border border-dashed border-slate-300 p-4 space-y-4 bg-slate-50/40">
              <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Agregar producto</p>

              <div>
                <label className={labelSmClass}>Producto <span className="text-red-500">*</span></label>
                <SearchableSelect
                  value={nl.producto_id || null}
                  onChange={(id) => {
                    const p = productos.find((x) => x.id === id);
                    setProductoCreado(null);
                    const insumoNoVendible = !!p && p.es_insumo === true && p.es_vendible !== true;
                    setNl((prev) => ({
                      ...prev,
                      producto_id: id,
                      costo_unitario_input: p ? String(p.costo_promedio) : "",
                      precio_venta: !p || insumoNoVendible ? "" : String(p.precio_venta),
                    }));
                  }}
                  options={productos.map((p) => ({
                    id: p.id,
                    label: p.nombre,
                    hint: `${p.sku} · stock ${p.stock_actual}`,
                  }))}
                  placeholder="Buscar producto por nombre o SKU…"
                  emptyText="Sin productos que coincidan"
                />
                {productoSel && !productoCreado && (
                  <p className="mt-1.5 text-xs text-gray-400">
                    Costo promedio actual: {formatGs(productoSel.costo_promedio)} · Precio venta actual: {formatGs(productoSel.precio_venta)}
                  </p>
                )}
                {productoCreado && (
                  <p className="mt-1.5 text-xs text-green-600">✓ Producto &quot;{productoCreado}&quot; creado y seleccionado.</p>
                )}
                {!mostrarFormProducto ? (
                  <button type="button" onClick={() => { setMostrarFormProducto(true); setProductoCreado(null); }}
                    className="mt-2 text-xs text-gray-400 hover:text-gray-700 underline transition-colors">
                    ¿No encontrás el producto? Crear nuevo
                  </button>
                ) : (
                  <InlineFormBox titulo="Nuevo producto" onCancel={handleCancelarProducto} onSave={handleAgregarProducto}
                    saveDisabled={!formProducto.nombre.trim() || !formProducto.sku.trim()}>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <div className="col-span-2">
                        <label className={labelSmClass}>Tipo de producto</label>
                        <SegmentedControl<"reventa" | "menu" | "materia"> small value={formProducto.tipo}
                          options={[
                            { value: "reventa", label: "Reventa" },
                            { value: "menu", label: "Menú" },
                            { value: "materia", label: "Materia prima" },
                          ]}
                          onChange={(v) => setFormProducto((prev) => ({
                            ...prev,
                            tipo: v,
                            // Materia prima suele medirse en gramos; si está en "Unidad", sugerimos "G".
                            unidad_medida: v === "materia" && prev.unidad_medida === "Unidad" ? "G" : prev.unidad_medida,
                          }))} />
                        {formProducto.tipo === "materia" && (
                          <p className="mt-1.5 text-xs text-amber-600">
                            Materia prima / insumo: se usa en recetas. No requiere precio de venta.
                          </p>
                        )}
                      </div>
                      <div>
                        <label className={labelSmClass}>Nombre <span className="text-red-500">*</span></label>
                        <input type="text" name="nombre" value={formProducto.nombre} onChange={handleProductoInputChange}
                          placeholder="Ej: CHÍA 500G" className={`${inputSmClass} uppercase`} />
                      </div>
                      <div>
                        <label className={labelSmClass}>SKU / Código <span className="text-red-500">*</span></label>
                        <input type="text" name="sku" value={formProducto.sku} onChange={handleProductoInputChange}
                          placeholder="Ej: CHIA-500" className={`${inputSmClass} uppercase ${errorSku ? "border-red-300 bg-red-50" : ""}`} />
                        {errorSku && <p className="mt-1 text-xs text-red-600">{errorSku}</p>}
                      </div>
                      <div>
                        <label className={labelSmClass}>Unidad de medida</label>
                        <select name="unidad_medida" value={formProducto.unidad_medida} onChange={handleProductoInputChange} className={inputSmClass}>
                          <option value="Unidad">Unidad</option>
                          <option value="Kg">Kg</option>
                          <option value="G">G</option>
                          <option value="Litro">Litro</option>
                          <option value="Caja">Caja</option>
                        </select>
                      </div>
                      <div>
                        <label className={labelSmClass}>Stock mínimo</label>
                        <input type="number" name="stock_minimo" value={formProducto.stock_minimo} onChange={handleProductoInputChange}
                          placeholder="Ej: 5" min={0} className={inputSmClass} />
                      </div>
                      {formProducto.tipo !== "materia" && (
                        <div className="col-span-2">
                          <label className={labelSmClass}>Precio de venta sugerido (Gs.)</label>
                          <MontoInput value={formProducto.precio_venta_sugerido}
                            onChange={(n) => setFormProducto((prev) => ({ ...prev, precio_venta_sugerido: String(n) }))}
                            placeholder="Ej: 25000" className={inputSmClass} decimals={false} />
                        </div>
                      )}
                    </div>
                  </InlineFormBox>
                )}
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div>
                  <label className={labelSmClass}>Cantidad <span className="text-red-500">*</span></label>
                  <input type="number" value={nl.cantidad} onChange={(e) => setNl((p) => ({ ...p, cantidad: e.target.value }))}
                    placeholder="Ej: 50" className={inputSmClass} min={0} step="any" />
                </div>
                <div>
                  <label className={labelSmClass}>Costo unit. ({cab.moneda === "USD" ? "USD" : "Gs."}) <span className="text-red-500">*</span></label>
                  <MontoInput value={nl.costo_unitario_input}
                    onChange={(n) => setNl((p) => ({ ...p, costo_unitario_input: String(n) }))}
                    placeholder={cab.moneda === "USD" ? "Ej: 12" : "Ej: 18000"} className={inputSmClass}
                    decimals={cab.moneda === "USD"} />
                </div>
                <div>
                  <label className={labelSmClass}>IVA</label>
                  <SegmentedControl<TipoIva> small value={nl.iva_tipo}
                    options={[{ value: "exenta", label: "Ex." }, { value: "5", label: "5%" }, { value: "10", label: "10%" }]}
                    onChange={(v) => setNl((p) => ({ ...p, iva_tipo: v }))} />
                </div>
                <div>
                  <label className={labelSmClass}>
                    Precio venta <span className="font-normal text-gray-400">(opcional)</span>
                  </label>
                  <MontoInput value={nl.precio_venta}
                    onChange={(n) => setNl((p) => ({ ...p, precio_venta: String(n) }))}
                    placeholder="Opcional" className={inputSmClass} decimals={false} />
                </div>
              </div>

              {esInsumoNoVendible && (
                <p className="text-xs text-amber-600 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                  Este producto es materia prima. La compra actualizará stock y costo promedio; el precio de venta no es necesario.
                </p>
              )}

              {(nlSubtotal > 0 || nlMargen !== null) && (
                <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-gray-500">
                  {cab.moneda === "USD" && nlCostoPYG > 0 && <span>≈ {formatGs(nlCostoPYG)}/u</span>}
                  {nlSubtotal > 0 && <span>Subtotal: <strong className="text-gray-700">{formatGs(nlSubtotal)}</strong></span>}
                  {nlSubtotal > 0 && <span>Total línea: <strong className="text-gray-700">{formatGs(nlTotal)}</strong></span>}
                  {nlMargen !== null && <span className={margenColor(nlMargen)}>Margen: {nlMargen.toFixed(1)}%</span>}
                </div>
              )}

              {errorLinea && <p className="text-xs text-red-600">{errorLinea}</p>}
              {!errorLinea && !lineaLista && motivoNoAgregar && (
                <p className="text-xs text-amber-600">{motivoNoAgregar}</p>
              )}

              <button type="button" onClick={handleAgregarLinea} disabled={!lineaLista}
                className="w-full rounded-lg bg-[#4FAEB2] py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[#3F8E91] disabled:opacity-40 disabled:cursor-not-allowed active:scale-95">
                + Agregar producto a la compra
              </button>
            </div>
          </section>

          {/* ── Totales generales ────────────────────────────────────────────── */}
          {lineas.length > 0 && (
            <section className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="bg-gray-50 border border-gray-200 rounded-lg px-3 py-3 text-center">
                <p className="text-xs text-gray-400 mb-1">Subtotal</p>
                <p className="text-sm font-semibold tabular-nums text-gray-700">{formatGs(totales.subtotal)}</p>
              </div>
              <div className="bg-gray-50 border border-gray-200 rounded-lg px-3 py-3 text-center">
                <p className="text-xs text-gray-400 mb-1">IVA</p>
                <p className="text-sm font-semibold tabular-nums text-gray-700">{formatGs(totales.iva)}</p>
              </div>
              <div className="bg-[#0EA5E9] text-white rounded-lg px-3 py-3 text-center">
                <p className="text-xs text-gray-200 mb-1">Total compra</p>
                <p className="text-sm font-bold tabular-nums">{formatGs(totales.total)}</p>
              </div>
            </section>
          )}

          {errorSubmit && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3">
              <p className="text-sm text-red-700">{errorSubmit}</p>
            </div>
          )}

          <div className="flex gap-4 pt-2">
            <button type="submit" disabled={lineas.length === 0 || submitting}
              className="bg-[#0EA5E9] hover:bg-[#0284C7] text-white px-5 py-3 rounded-lg text-sm font-medium transition-colors shadow-sm disabled:opacity-40 disabled:cursor-not-allowed active:scale-95">
              {submitting ? "Guardando..." : "Guardar compra"}
            </button>
            <button type="button" onClick={() => router.push("/compras")}
              className="border border-slate-200 px-5 py-3 rounded-lg text-sm hover:bg-slate-50 transition-colors">
              Cancelar
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Sub-componentes ────────────────────────────────────────────────────────────

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-widest">{children}</h3>;
}

function InlineFormBox({
  titulo, children, onSave, onCancel, saveDisabled,
}: {
  titulo: string; children: React.ReactNode; onSave: () => void; onCancel: () => void; saveDisabled: boolean;
}) {
  return (
    <div className="mt-4 border border-gray-200 rounded-xl p-4 bg-white space-y-4">
      <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide">{titulo}</p>
      {children}
      <div className="flex gap-3 pt-1">
        <button type="button" onClick={onSave} disabled={saveDisabled}
          className="bg-[#0EA5E9] hover:bg-[#0284C7] text-white px-4 py-2 rounded-lg text-xs font-medium transition-colors shadow-sm disabled:opacity-40 disabled:cursor-not-allowed active:scale-95">
          Guardar {titulo.toLowerCase()}
        </button>
        <button type="button" onClick={onCancel}
          className="border border-slate-200 px-4 py-2 rounded-lg text-xs hover:bg-white transition-colors">
          Cancelar
        </button>
      </div>
    </div>
  );
}
