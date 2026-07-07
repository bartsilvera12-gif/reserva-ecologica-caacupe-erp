"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import NuevoClienteRapidoModal, { type NuevoClienteCreado } from "./NuevoClienteRapidoModal";
import { useRouter } from "next/navigation";
import MontoInput from "@/components/ui/MontoInput";
import ProductPickerModal, { type ProductoPickerItem, type AgregarVentaPayload } from "@/components/inventario/ProductPickerModal";
import { saveVenta, type FaltanteStock } from "@/lib/ventas/storage";
import { getProductos } from "@/lib/inventario/storage";
import { generarYAbrirRecibo } from "@/lib/recibos/client";
import type { TipoIvaVenta, TipoVenta, MonedaVenta, LineaVenta, MetodoPago, TipoPrecioVenta } from "@/lib/ventas/types";
import type { Producto } from "@/lib/inventario/types";

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatGs(valor: number) {
  return `Gs. ${Math.round(valor).toLocaleString("es-PY")}`;
}

/**
 * IVA INCLUIDO: el precio de venta ya contiene el IVA. `total` es precio × cantidad
 * (= total de la línea). El IVA se desglosa desde adentro, NO se suma encima.
 *   EXENTA → 0 · 5% → total - total/1.05 · 10% → total - total/1.10
 */
function calcIva(tipo: TipoIvaVenta, total: number) {
  if (tipo === "EXENTA") return 0;
  if (tipo === "5%")     return total - total / 1.05;
  return total - total / 1.10;
}

/**
 * Precio unitario (Gs.) según el tipo elegido, con fallbacks:
 *  minorista → precio_venta;
 *  mayorista → precio_mayorista (>0) o fallback a precio_venta;
 *  costo     → costo_promedio.
 */
function precioPorTipo(p: Producto, tipo: TipoPrecioVenta): number {
  if (tipo === "mayorista") return p.precio_mayorista != null && p.precio_mayorista > 0 ? p.precio_mayorista : p.precio_venta;
  if (tipo === "distribuidor") return p.precio_distribuidor != null && p.precio_distribuidor > 0 ? p.precio_distribuidor : p.precio_venta;
  if (tipo === "costo") return p.costo_promedio ?? 0; // histórico: ya no se ofrece en la UI
  return p.precio_venta;
}

/** Tipos de precio ofrecidos en la UI (sin 'costo', que queda solo como histórico). */
const TIPOS_PRECIO_UI: TipoPrecioVenta[] = ["minorista", "mayorista", "distribuidor"];

const tipoPrecioLabel: Record<TipoPrecioVenta, string> = {
  minorista: "Minorista",
  mayorista: "Mayorista",
  distribuidor: "Distribuidor",
  costo: "Al costo",
};

// ── Estilos ────────────────────────────────────────────────────────────────────

const inputClass =
  "w-full border border-slate-200 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-[#0EA5E9] focus:outline-none bg-white text-sm";
const labelClass = "block text-sm font-medium text-slate-700 mb-1.5";

// ── Sub-componentes ───────────────────────────────────────────────────────────

function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className={`flex border border-slate-200 rounded-lg overflow-hidden ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          disabled={disabled}
          onClick={() => onChange(opt.value)}
          className={`flex-1 py-2 text-sm font-medium transition-colors ${
            value === opt.value
              ? "bg-[#0EA5E9] text-white"
              : "bg-white text-slate-600 hover:bg-slate-50"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">
      {children}
    </p>
  );
}

const ivaLabel: Record<TipoIvaVenta, string> = {
  EXENTA: "Exenta",
  "5%":   "5%",
  "10%":  "10%",
};

// ── Componente principal ───────────────────────────────────────────────────────

export default function NuevaVentaPage() {
  const router = useRouter();

  // ── Estado global ──────────────────────────────────────────────────────────
  const [productos, setProductos]   = useState<Producto[]>([]);
  const [items, setItems]           = useState<LineaVenta[]>([]);
  const [errorLinea, setErrorLinea] = useState<string | null>(null);
  const [errorVenta, setErrorVenta] = useState<string | null>(null);
  // Venta sin stock: faltantes devueltos por el backend + modal de confirmación.
  const [faltantes, setFaltantes] = useState<FaltanteStock[]>([]);
  const [confirmSinStockOpen, setConfirmSinStockOpen] = useState(false);
  // Panel post-venta: tras confirmar, ofrece abrir ticket y (si aplica) nota de remisión.
  const [postVenta, setPostVenta] = useState<{
    id: string;
    numero: string;
    generaNota: boolean;
    credito: boolean;
    facturaId?: string | null;
    numeroFactura?: string | null;
    facturaWarning?: string | null;
  } | null>(null);
  // Guard anti doble-submit: estado para UI (botón/spinner) + ref para bloqueo síncrono
  // inmediato (React puede tardar en aplicar el estado; el ref corta el segundo disparo ya).
  const [guardando, setGuardando] = useState(false);
  const isSubmittingRef = useRef(false);

  // Facturación de un pedido enviado a Caja (?pedido_id=...). Precarga items + cliente.
  const [pedidoId, setPedidoId] = useState<string | null>(null);
  const [pedidoNumero, setPedidoNumero] = useState<string | null>(null);

  // ── Condiciones de la venta ───────────────────────────────────────────────
  // Instancia dedicada: siempre Guaraníes.
  const moneda: MonedaVenta = "GS";

  // Contado / Crédito (campos ya existentes en `ventas`: tipo_venta + plazo_dias).
  const [tipoVenta, setTipoVenta] = useState<TipoVenta>("CONTADO");
  const [plazoDias, setPlazoDias] = useState("");

  // Cliente (opcional). Si se selecciona, se envía cliente_id al crear la venta.
  type ClienteLite = { id: string; label: string; ruc: string | null; usa_nota_remision: boolean; nivel_precio: "minorista" | "mayorista" | "distribuidor" };
  const [clientes, setClientes] = useState<ClienteLite[]>([]);
  const [clienteId, setClienteId] = useState("");
  const [clienteQuery, setClienteQuery] = useState("");
  const [modalNuevoCliente, setModalNuevoCliente] = useState(false);
  const [clienteOpen, setClienteOpen] = useState(false);
  const clienteContainerRef = useRef<HTMLDivElement>(null);
  // Nota de remisión: activada si el cliente la usa; toggle manual solo con cliente.
  const [generaNotaRemision, setGeneraNotaRemision] = useState(false);

  // ── Cobro (solo CONTADO, no se persiste — solo ayuda al cajero) ───────────
  const [montoRecibido, setMontoRecibido] = useState("");
  const [metodoPago, setMetodoPago] = useState<MetodoPago>("efectivo");

  // ── Detalle de cobro (conciliación bancaria) ──────────────────────────────
  const [entidades, setEntidades] = useState<{ id: string; codigo: string | null; nombre: string; tipo: string | null }[]>([]);
  const [pagoEntidadId, setPagoEntidadId] = useState("");
  const [pagoReferencia, setPagoReferencia] = useState("");
  const [pagoTitular, setPagoTitular] = useState("");
  const [pagoObservacion] = useState("");
  // Modal de cobro (transferencia / tarjeta) + buscador de entidad.
  const [cobroModalOpen, setCobroModalOpen] = useState(false);
  const [entidadQuery, setEntidadQuery] = useState("");

  // ── Línea en construcción ─────────────────────────────────────────────────
  const [lineaProdId, setLineaProdId] = useState("");
  const [lineaCant,   setLineaCant]   = useState("");
  const [lineaPrecio, setLineaPrecio] = useState("");
  const [lineaIva,    setLineaIva]    = useState<TipoIvaVenta>("10%");
  const [lineaTipoPrecio, setLineaTipoPrecio] = useState<TipoPrecioVenta>("minorista");

  // ── Combobox de producto ───────────────────────────────────────────────────
  const [comboQuery,     setComboQuery]     = useState("");
  const [comboOpen,      setComboOpen]      = useState(false);
  const [comboHighlight, setComboHighlight] = useState(-1);
  const comboInputRef    = useRef<HTMLInputElement>(null);
  const comboContainerRef = useRef<HTMLDivElement>(null);

  // ── Modal buscador (F3) ────────────────────────────────────────────────────
  const [pickerOpen, setPickerOpen] = useState(false);

  function pickerToProducto(p: ProductoPickerItem): Producto {
    return {
      id: p.id,
      nombre: p.nombre,
      sku: p.sku,
      precio_venta: p.precio_venta,
      precio_mayorista: p.precio_mayorista ?? null,
      precio_distribuidor: p.precio_distribuidor ?? null,
      stock_actual: p.stock_actual,
      unidad_medida: p.unidad_medida,
      costo_promedio: p.costo_promedio ?? 0,
      stock_minimo: 0,
      metodo_valuacion: "CPP",
      codigo_barras: p.codigo_barras,
      codigo_barras_interno: p.codigo_barras_interno,
      imagen_path: null,
      imagen_url: p.imagen_url,
    };
  }

  function handleSelectFromPicker(p: ProductoPickerItem) {
    const prod = pickerToProducto(p);
    setProductos((prev) => (prev.find((x) => x.id === prod.id) ? prev : [...prev, prod]));
    seleccionarProducto(prod);
    setPickerOpen(false);
  }

  /**
   * Agregado directo desde el modal: arma la LineaVenta usando la misma
   * logica que handleAgregarLinea pero con datos del modal, sin pasar
   * por el form inline. Mantiene el modal abierto si todo OK.
   */
  function handleAgregarDesdePicker(payload: AgregarVentaPayload): boolean {
    const { producto: p, cantidad, precio_input, iva, tipo_precio } = payload;
    const precioPyg = precio_input;
    // Verificar stock vs lo ya cargado SOLO si el producto controla stock.
    // Venta sin stock (Fase 5): NO se bloquea por falta de stock al agregar; la
    // confirmación se pide al registrar la venta. El Menú (controla_stock=false) tampoco valida.
    // IVA incluido: el total de la línea es precio × cantidad; el IVA se desglosa
    // desde adentro y el subtotal (base imponible) = total − IVA.
    const totalLinea = cantidad * precioPyg;
    const montoIva = calcIva(iva, totalLinea);
    const subtotal = totalLinea - montoIva;

    // Asegurar que el producto este en el array local (para que stock_actual
    // se conozca en validaciones posteriores del form inline).
    const prodLocal = pickerToProducto(p);
    setProductos((prev) => (prev.find((x) => x.id === prodLocal.id) ? prev : [...prev, prodLocal]));

    setItems((prev) => [
      ...prev,
      {
        producto_id: p.id,
        producto_nombre: p.nombre,
        sku: p.sku,
        cantidad,
        precio_venta_original: precio_input,
        precio_venta: precioPyg,
        tipo_iva: iva,
        tipo_precio,
        subtotal,
        monto_iva: montoIva,
        total_linea: totalLinea,
      },
    ]);
    setErrorVenta(null);
    return true;
  }

  useEffect(() => {
    let cancelled = false;
    getProductos().then((data) => {
      if (!cancelled) setProductos(data);
    });
    return () => { cancelled = true; };
  }, []);

  // Precarga al facturar un pedido (Caja): lee ?pedido_id=, trae el pedido y carga sus
  // items + cliente en el carrito. NO crea nada acá; la venta se genera al confirmar.
  useEffect(() => {
    let cancelled = false;
    let pid: string | null = null;
    try {
      pid = new URLSearchParams(window.location.search).get("pedido_id");
    } catch { pid = null; }
    if (!pid) return;
    setPedidoId(pid);
    (async () => {
      try {
        const res = await fetch(`/api/proyectos/${pid}`, { credentials: "include", cache: "no-store" });
        const j = await res.json();
        if (cancelled || !j?.success || !j.data?.proyecto) return;
        const p = j.data.proyecto as { brief_data?: unknown; cliente_id?: string | null; metadata?: unknown };
        const brief = (p.brief_data && typeof p.brief_data === "object" && !Array.isArray(p.brief_data))
          ? (p.brief_data as Record<string, unknown>) : {};
        const meta = (p.metadata && typeof p.metadata === "object" && !Array.isArray(p.metadata))
          ? (p.metadata as Record<string, unknown>) : {};
        setPedidoNumero(
          (typeof brief.numero_control === "string" && brief.numero_control) ||
          (typeof brief.numero_presupuesto === "string" && brief.numero_presupuesto) ||
          (typeof meta.numero_presupuesto === "string" && meta.numero_presupuesto) || null
        );
        const itemsRaw = Array.isArray(brief.items) ? (brief.items as Record<string, unknown>[]) : [];
        const lineas: LineaVenta[] = itemsRaw
          .filter((it) => it.producto_id && (Number(it.cantidad) || 0) > 0)
          .map((it) => {
            const cantidad = Number(it.cantidad) || 0;
            const precio = Number(it.precio_venta) || 0;
            const iva: TipoIvaVenta = "10%";
            // IVA incluido: total de línea = precio × cantidad; IVA desglosado desde adentro.
            const totalLinea = cantidad * precio;
            const montoIva = calcIva(iva, totalLinea);
            const subtotal = totalLinea - montoIva;
            return {
              producto_id: String(it.producto_id),
              producto_nombre: typeof it.producto_nombre === "string" ? it.producto_nombre : "",
              sku: typeof it.sku === "string" ? it.sku : "",
              cantidad,
              precio_venta_original: precio,
              precio_venta: precio,
              tipo_iva: iva,
              tipo_precio: ((): TipoPrecioVenta => {
                const t = typeof it.tipo_precio === "string" ? it.tipo_precio : "";
                return t === "mayorista" || t === "distribuidor" || t === "costo" ? t as TipoPrecioVenta : "minorista";
              })(),
              subtotal,
              monto_iva: montoIva,
              total_linea: totalLinea,
            };
          });
        if (!cancelled && lineas.length) setItems(lineas);
        if (!cancelled && p.cliente_id) setClienteId(String(p.cliente_id));
      } catch { /* el aviso seguirá visible; el cajero puede cargar manualmente */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Cargar entidades bancarias (caja/banco/tarjeta/billetera) para el detalle de cobro.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/entidades-bancarias", { credentials: "include", cache: "no-store" })
      .then((r) => r.json())
      .then((j) => { if (!cancelled && j?.success) setEntidades(j.data?.entidades ?? []); })
      .catch(() => { /* no bloquea la venta si falla */ });
    return () => { cancelled = true; };
  }, []);

  // Cargar clientes (buscador opcional de cliente en la venta).
  // Se recarga al montar Y cada vez que la ventana recupera el foco — así, si el
  // usuario abrió "Cargar nuevo cliente" en otra pestaña y volvió, el nuevo
  // cliente aparece en el buscador sin refrescar la página.
  const fetchClientes = useCallback(async () => {
    try {
      const r = await fetch("/api/clientes", { credentials: "include", cache: "no-store" });
      const j = await r.json();
      if (!j?.success || !Array.isArray(j.data)) return;
      const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
      const lite: ClienteLite[] = (j.data as Record<string, unknown>[]).map((row) => ({
        id: String(row.id),
        label: s(row.empresa) || s(row.nombre_contacto) || s(row.nombre) || "Cliente",
        ruc: s(row.ruc) || null,
        usa_nota_remision: row.usa_nota_remision === true,
        nivel_precio: (row.nivel_precio === "mayorista" || row.nivel_precio === "distribuidor" ? row.nivel_precio : "minorista") as "minorista" | "mayorista" | "distribuidor",
      }));
      setClientes(lite);
    } catch {
      /* el buscador de cliente es opcional, no bloquea la venta */
    }
  }, []);
  useEffect(() => {
    let cancelled = false;
    void fetchClientes();
    const onFocus = () => { if (!cancelled) void fetchClientes(); };
    window.addEventListener("focus", onFocus);
    return () => { cancelled = true; window.removeEventListener("focus", onFocus); };
  }, []);

  // UX rápida: abrir el buscador de productos al entrar (carrito vacío).
  // Si el usuario lo cierra, sigue usando el formulario normal (no queda atrapado).
  // EXCEPCIÓN: al facturar un pedido (?pedido_id=...) NO se auto-abre, porque el
  // carrito viene precargado; el usuario usa el botón "+ Agregar producto" si quiere más.
  // Se lee la URL directamente (no el estado pedidoId) para evitar la carrera de montaje.
  useEffect(() => {
    let tienePedido = false;
    try {
      tienePedido = !!new URLSearchParams(window.location.search).get("pedido_id");
    } catch { tienePedido = false; }
    if (!tienePedido) setPickerOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cerrar dropdown al hacer clic fuera
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (comboContainerRef.current && !comboContainerRef.current.contains(e.target as Node)) {
        setComboOpen(false);
      }
      if (clienteContainerRef.current && !clienteContainerRef.current.contains(e.target as Node)) {
        setClienteOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Scroll a la opción destacada en el dropdown
  useEffect(() => {
    if (comboHighlight >= 0) {
      document.getElementById(`combo-opt-${comboHighlight}`)?.scrollIntoView({ block: "nearest" });
    }
  }, [comboHighlight]);

  // ── Cálculos ───────────────────────────────────────────────────────────────
  const tipoCambioNum = 1;

  const prodSel     = productos.find((p) => p.id === lineaProdId);
  const cantNum     = parseInt(lineaCant) || 0;
  const precioInput = parseFloat(lineaPrecio) || 0;
  const precioGs    = precioInput;

  const enCarrito = items
    .filter((i) => i.producto_id === lineaProdId)
    .reduce((s, i) => s + i.cantidad, 0);
  const prodSelControlaStock = prodSel ? prodSel.controla_stock !== false : true;
  const stockDisp = (prodSel?.stock_actual ?? 0) - enCarrito;

  // IVA incluido: el total de la línea es precio × cantidad; el IVA se desglosa
  // desde adentro y el subtotal (base imponible) = total − IVA.
  const lineaTotalLinea = cantNum > 0 && precioGs > 0 ? cantNum * precioGs : 0;
  const lineaMontoIva   = calcIva(lineaIva, lineaTotalLinea);
  const lineaSubtotal   = lineaTotalLinea - lineaMontoIva;

  // Aviso de stock (no bloquea): si falta stock se permite agregar igual y se pide
  // confirmación al confirmar la venta (venta sin stock con confirmación, Fase 5).
  // Productos del Menú (controla_stock=false) no controlan stock.
  const stockInsuf  = prodSel !== undefined && prodSelControlaStock && cantNum > 0 && cantNum > stockDisp;
  const lineaValida =
    !!prodSel && cantNum > 0 && precioGs > 0;

  const totalSubtotal = items.reduce((s, i) => s + i.subtotal, 0);
  const totalIva      = items.reduce((s, i) => s + i.monto_iva, 0);
  const totalGeneral  = items.reduce((s, i) => s + i.total_linea, 0);
  // Condición de venta: si es Crédito, exigir plazo de al menos 1 día.
  const plazoDiasNum = parseInt(plazoDias) || 0;
  // Crédito exige cliente seleccionado Y plazo/vencimiento (≥1 día). Genera cuenta por cobrar.
  const creditoValido = tipoVenta === "CONTADO" || (plazoDiasNum >= 1 && !!clienteId);
  // Cliente obligatorio: toda venta emite factura ERP para SIFEN, no dejamos pasar sin receptor.
  const ventaValida   = items.length > 0 && creditoValido && !!clienteId;

  // Cliente (opcional) — selección + filtrado del buscador.
  const clienteSel = clientes.find((c) => c.id === clienteId) ?? null;
  const clientesFiltrados = (clienteQuery.trim() === ""
    ? clientes
    : clientes.filter((c) => {
        const q = clienteQuery.toLowerCase();
        return c.label.toLowerCase().includes(q) || (c.ruc ?? "").toLowerCase().includes(q);
      })
  ).slice(0, 50);

  // Cobro: entidad seleccionada + filtrado por código/nombre.
  const entidadSel = entidades.find((e) => e.id === pagoEntidadId) ?? null;
  const entidadesFiltradas = (entidadQuery.trim() === ""
    ? entidades
    : entidades.filter((e) => {
        const q = entidadQuery.toLowerCase();
        return e.nombre.toLowerCase().includes(q) || (e.codigo ?? "").toLowerCase().includes(q);
      })
  ).slice(0, 50);

  // Vuelto (solo informativo, no se persiste)
  const montoRecibidoNum = parseFloat(montoRecibido) || 0;
  const vuelto           = montoRecibidoNum - totalGeneral;

  // ── Productos filtrados para el combobox ──────────────────────────────────
  // Solo vendibles (Reventa + Menú). Excluye materia prima / insumos.
  const productosVendibles = productos.filter((p) => p.es_vendible !== false);
  const comboFiltrados = comboQuery.trim() === ""
    ? productosVendibles
    : productosVendibles.filter((p) => {
        const q = comboQuery.toLowerCase();
        return p.nombre.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q);
      });

  // ── Selección de un producto desde el combobox ────────────────────────────
  function seleccionarProducto(p: Producto) {
    setLineaProdId(String(p.id));
    setLineaTipoPrecio("minorista");
    setLineaPrecio(String(precioPorTipo(p, "minorista")));
    setLineaCant("1");
    setLineaIva("10%");
    setComboQuery(`${p.nombre} — ${p.sku}`);
    setComboOpen(false);
    setComboHighlight(-1);
    setErrorLinea(null);
  }

  /** Selecciona método de cobro. Efectivo no pide datos; transferencia/tarjeta abren modal. */
  function handleSelectMetodo(m: MetodoPago) {
    setMetodoPago(m);
    if (m === "efectivo") {
      setCobroModalOpen(false);
      // "Caja efectivo" por defecto si existe una entidad tipo caja.
      const caja = entidades.find((e) => e.tipo === "caja");
      setPagoEntidadId(caja ? caja.id : "");
      setPagoTitular("");
    } else {
      setEntidadQuery("");
      setCobroModalOpen(true);
    }
  }

  /** Cambia el tipo de precio de la línea en construcción y ajusta el precio unitario. */
  function handleLineaTipoPrecio(tipo: TipoPrecioVenta) {
    setLineaTipoPrecio(tipo);
    if (prodSel) setLineaPrecio(String(precioPorTipo(prodSel, tipo)));
    setErrorLinea(null);
  }

  // ── Handlers del combobox ─────────────────────────────────────────────────
  function handleComboInput(e: React.ChangeEvent<HTMLInputElement>) {
    setComboQuery(e.target.value);
    setComboOpen(true);
    setComboHighlight(-1);
    // Si el usuario borra el texto, limpiar la selección
    if (e.target.value === "") {
      setLineaProdId("");
      setLineaPrecio("");
      setLineaCant("");
    }
    setErrorLinea(null);
  }

  function handleComboKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setComboOpen(true);
      setComboHighlight((h) => Math.min(h + 1, comboFiltrados.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setComboHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (comboOpen && comboHighlight >= 0 && comboFiltrados[comboHighlight]) {
        // Seleccionar el ítem destacado del dropdown
        seleccionarProducto(comboFiltrados[comboHighlight]);
      } else if (!comboOpen && lineaValida) {
        // Dropdown cerrado + producto válido → agregar al carrito
        handleAgregarLinea();
      }
    } else if (e.key === "Escape") {
      setComboOpen(false);
      setComboHighlight(-1);
    }
  }

  // ── Agregar línea al carrito ──────────────────────────────────────────────
  function handleAgregarLinea() {
    setErrorLinea(null);
    if (!prodSel)          return setErrorLinea("Seleccioná un producto.");
    if (cantNum <= 0)      return setErrorLinea("La cantidad debe ser mayor a 0.");
    if (precioGs <= 0)     return setErrorLinea("El precio de venta debe ser mayor a 0.");
    // Nota: si falta stock NO se bloquea; se confirma al registrar la venta.

    setItems((prev) => [
      ...prev,
      {
        producto_id:           prodSel.id,
        producto_nombre:       prodSel.nombre,
        sku:                   prodSel.sku,
        cantidad:              cantNum,
        precio_venta_original: precioInput,
        precio_venta:          precioGs,
        tipo_iva:              lineaIva,
        tipo_precio:           lineaTipoPrecio,
        subtotal:              lineaSubtotal,
        monto_iva:             lineaMontoIva,
        total_linea:           lineaTotalLinea,
      },
    ]);

    // Limpiar línea y devolver foco al buscador de producto
    setLineaProdId("");
    setLineaCant("");
    setLineaPrecio("");
    setLineaIva("10%");
    setLineaTipoPrecio("minorista");
    setComboQuery("");
    setComboOpen(false);
    setTimeout(() => comboInputRef.current?.focus(), 0);
  }

  function handleEliminarLinea(index: number) {
    setItems((prev) => prev.filter((_, i) => i !== index));
  }

  /** Envía la venta. Con `permitirSinStock=true` autoriza vender aunque falte stock. */
  async function enviarVenta(permitirSinStock: boolean) {
    // Guard duro contra doble submit: si ya hay una confirmación en vuelo, cortar
    // inmediatamente. El ref se evalúa de forma síncrona (no espera al re-render de React),
    // así que un segundo click/Enter casi simultáneo no puede disparar otra venta.
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    // Cliente obligatorio: la factura ERP necesita receptor. Si el operador quiere
    // vender sin cliente, primero tiene que crearlo (botón "+ Cargar nuevo cliente"
    // en el buscador arriba).
    if (!clienteId) {
      isSubmittingRef.current = false;
      setErrorVenta("Elegí un cliente antes de confirmar la venta. Podés cargarlo rápido desde el buscador de arriba.");
      return;
    }
    setGuardando(true);
    try {
      const resultado = await saveVenta(
        {
          items,
          moneda,
          tipo_cambio:  tipoCambioNum,
          subtotal:     totalSubtotal,
          monto_iva:    totalIva,
          total:        totalGeneral,
          tipo_venta:   tipoVenta,
          plazo_dias:   tipoVenta === "CREDITO" ? plazoDiasNum : undefined,
          metodo_pago:  metodoPago,
          cliente_id:   clienteId || null,
          genera_nota_remision: !!clienteId && generaNotaRemision,
        },
        undefined,
        {
          entidad_bancaria_id: pagoEntidadId || null,
          entidad_nombre_snapshot: entidades.find((e) => e.id === pagoEntidadId)?.nombre ?? null,
          referencia: pagoReferencia.trim() || null,
          titular: metodoPago === "transferencia" ? pagoTitular.trim() || null : null,
          observacion: pagoObservacion.trim() || null,
        },
        { permitirSinStock, pedidoId }
      );

      if (!resultado.success) {
        // Falta stock sin autorizar → abrir modal de confirmación con el detalle.
        // (El guard se libera en el finally para permitir confirmar sin stock.)
        if (resultado.faltantes && resultado.faltantes.length > 0) {
          setFaltantes(resultado.faltantes);
          setConfirmSinStockOpen(true);
          return;
        }
        setErrorVenta(resultado.error);
        return;
      }
      const v = resultado.venta;
      const generaNota = v.genera_nota_remision === true || !!v.nota_remision_numero;

      // Redirección directa al panel SIFEN: si el puente creó la factura ERP,
      // saltamos el modal post-venta y llevamos al operador al detalle donde
      // vive el FacturaElectronicaPanel (firmar, enviar, imprimir KUDE legal).
      if (resultado.factura?.id) {
        router.push(`/facturas/${resultado.factura.id}`);
        return;
      }

      // Fallback: si el puente falló (facturaWarning) o la venta no generó
      // factura, mantenemos el flujo previo con ticket + nota de remisión.
      const ticketUrl = `/api/ventas/${v.id}/ticket?mode=comandas&auto=1`;
      const remisionUrl = `/api/ventas/${v.id}/ticket?tipo=remision&auto=1`;
      try { window.open(ticketUrl, "_blank", "noopener"); } catch {}
      if (generaNota) { try { window.open(remisionUrl, "_blank", "noopener"); } catch {} }
      setPostVenta({
        id: v.id,
        numero: v.numero_control,
        generaNota,
        credito: tipoVenta === "CREDITO",
        facturaId: null,
        numeroFactura: null,
        facturaWarning: resultado.facturaWarning ?? null,
      });
    } finally {
      // Liberar el guard SIEMPRE: éxito, error o flujo de "confirmar sin stock".
      isSubmittingRef.current = false;
      setGuardando(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorVenta(null);
    if (!ventaValida) return;
    await enviarVenta(false);
  }

  async function confirmarVentaSinStock() {
    setConfirmSinStockOpen(false);
    setErrorVenta(null);
    await enviarVenta(true);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-8">

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-800">Nueva venta</h1>
          <p className="text-gray-600">
            Agregá productos de reventa o del catálogo. Al confirmar se registra la venta.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="shrink-0 inline-flex items-center gap-1.5 rounded-lg bg-[#0EA5E9] px-4 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[#0284C7] active:scale-95"
        >
          + Agregar producto
        </button>
      </div>

      {pedidoId && (
        <div className="rounded-lg border border-[#4FAEB2]/40 bg-[#4FAEB2]/[0.08] px-4 py-3 text-sm text-slate-700">
          <span className="font-semibold text-[#3F8E91]">Estás facturando un pedido{pedidoNumero ? ` (${pedidoNumero})` : ""}.</span>{" "}
          La venta se generará al confirmar y el pedido quedará marcado como facturado. Podés ajustar items, precios y método de pago.
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6 max-w-7xl">

        {/* ── SECCIÓN 0: Datos de la venta (cliente opcional + condición) ────── */}
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4 sm:p-6">
          <SectionTitle>Datos de la venta</SectionTitle>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">

            {/* Cliente (opcional) */}
            <div ref={clienteContainerRef} className="relative">
              <label className={labelClass}>
                Cliente <span className="text-rose-600">*</span>
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={clienteSel ? clienteSel.label : clienteQuery}
                  onChange={(e) => { setClienteId(""); setClienteQuery(e.target.value); setClienteOpen(true); }}
                  onFocus={() => setClienteOpen(true)}
                  placeholder="Buscar por nombre o RUC…"
                  className={`${inputClass} ${clienteSel ? "font-medium" : ""}`}
                />
                {clienteSel && (
                  <button
                    type="button"
                    onClick={() => { setClienteId(""); setClienteQuery(""); setGeneraNotaRemision(false); }}
                    className="shrink-0 rounded-lg border border-slate-200 px-3 text-xs text-slate-500 hover:bg-slate-50"
                  >
                    Quitar
                  </button>
                )}
              </div>
              {clienteOpen && !clienteSel && (
                <div className="absolute z-20 mt-1 w-full max-h-64 overflow-auto rounded-lg border border-slate-200 bg-white shadow-lg">
                  {/* Acción al TOPE del dropdown: abre el modal de "nuevo cliente rápido". */}
                  <button
                    type="button"
                    onClick={() => { setClienteOpen(false); setModalNuevoCliente(true); }}
                    className="flex w-full items-center gap-1.5 border-b border-slate-100 bg-[#4FAEB2]/[0.06] px-3 py-2 text-left text-xs font-semibold text-[#3F8E91] hover:bg-[#4FAEB2]/[0.12]"
                    title="Se abre un mini formulario acá mismo, sin cambiar de página."
                  >
                    <span className="text-base leading-none">＋</span>
                    Cargar nuevo cliente
                    {clienteQuery.trim() && <span className="ml-1 truncate text-slate-500">«{clienteQuery.trim()}»</span>}
                  </button>
                  {clientesFiltrados.length === 0 ? (
                    <p className="px-3 py-2 text-xs text-gray-400">Sin clientes que coincidan.</p>
                  ) : (
                    clientesFiltrados.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => { setClienteId(c.id); setClienteQuery(""); setClienteOpen(false); setGeneraNotaRemision(c.usa_nota_remision); }}
                        className="block w-full text-left px-3 py-2 text-sm hover:bg-slate-50"
                      >
                        <span className="font-medium text-gray-800">{c.label}</span>
                        {c.ruc && <span className="ml-2 text-xs text-gray-400">RUC {c.ruc}</span>}
                        {c.usa_nota_remision && <span className="ml-2 text-[10px] rounded-full bg-sky-100 text-sky-700 px-1.5 py-0.5 font-semibold">Nota remisión</span>}
                      </button>
                    ))
                  )}
                </div>
              )}
              <p className="mt-1 text-[11px] text-gray-400">
                Toda venta emite factura ERP. Si el cliente no existe, cargalo con “＋ Cargar nuevo cliente”.
              </p>
              {!clienteId && (
                <p className="mt-1 text-[11px] text-rose-600">Seleccioná un cliente para poder confirmar la venta.</p>
              )}

              {/* Nota de remisión: solo con cliente. Si el cliente la usa, viene activada. */}
              {clienteSel && (
                <div className="mt-2 rounded-lg border border-sky-100 bg-sky-50/60 px-3 py-2">
                  {clienteSel.usa_nota_remision && (
                    <p className="mb-1.5 text-[11px] text-sky-700">
                      Este cliente usa nota de remisión. Se generará junto al ticket.
                    </p>
                  )}
                  <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={generaNotaRemision}
                      onChange={(e) => setGeneraNotaRemision(e.target.checked)}
                      className="h-4 w-4 rounded border-slate-300 text-[#0EA5E9] focus:ring-[#0EA5E9]"
                    />
                    Generar nota de remisión
                  </label>
                </div>
              )}
            </div>

            {/* Condición: Contado / Crédito */}
            <div>
              <label className={labelClass}>Condición</label>
              <SegmentedControl<TipoVenta>
                value={tipoVenta}
                options={[
                  { value: "CONTADO", label: "Contado" },
                  { value: "CREDITO", label: "Crédito" },
                ]}
                onChange={(v) => { setTipoVenta(v); if (v === "CONTADO") setPlazoDias(""); }}
              />
              {tipoVenta === "CREDITO" && (
                <div className="mt-3">
                  <label className={labelClass}>Plazo de crédito (días)</label>
                  <input
                    type="number"
                    min={1}
                    value={plazoDias}
                    onChange={(e) => setPlazoDias(e.target.value)}
                    placeholder="Ej: 30"
                    className={`${inputClass} ${plazoDiasNum < 1 ? "border-red-300 bg-red-50" : ""}`}
                  />
                  {plazoDiasNum < 1 && (
                    <p className="mt-1 text-[11px] text-red-600">Ingresá un plazo de al menos 1 día.</p>
                  )}
                  {!clienteId && (
                    <p className="mt-1 text-[11px] text-red-600">La venta a crédito requiere un cliente seleccionado.</p>
                  )}
                  <p className="mt-1 text-[11px] text-slate-500">Al confirmar se genera una cuenta por cobrar por el total.</p>
                </div>
              )}
            </div>

          </div>
        </div>

        {/* ── SECCIÓN 3: Carrito + totales + confirmar ─────────────────────── */}
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4 sm:p-6">
          <SectionTitle>Productos en esta venta</SectionTitle>

          {items.length === 0 ? (
            <div className="py-10 text-center text-gray-400 text-sm border-2 border-dashed border-gray-200 rounded-lg">
              Todavía no agregaste productos a esta venta.
            </div>
          ) : (
            <>
              {/* min-w fuerza scroll horizontal en mobile (9 columnas).
                  Columnas secundarias (SKU, Subtotal, IVA Gs) se ocultan
                  progresivamente: en mobile solo Producto/Cant/Precio/Total/eliminar. */}
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] sm:min-w-0 text-sm text-left">
                  <thead>
                    <tr className="bg-slate-50 text-slate-600 text-sm font-semibold">
                      <th className="py-2.5 pr-3 font-medium">Producto</th>
                      <th className="hidden py-2.5 pr-3 font-medium lg:table-cell">SKU</th>
                      <th className="py-2.5 pr-3 font-medium text-right">Cant.</th>
                      <th className="py-2.5 pr-3 font-medium text-right">Precio unit.</th>
                      <th className="hidden py-2.5 pr-3 text-center font-medium lg:table-cell">IVA</th>
                      <th className="py-2.5 pr-3 font-medium text-right hidden lg:table-cell">Subtotal</th>
                      <th className="py-2.5 pr-3 font-medium text-right hidden lg:table-cell">IVA Gs.</th>
                      <th className="py-2.5 pr-3 font-medium text-right">Total</th>
                      <th className="py-2.5 font-medium"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item, idx) => (
                      <tr key={idx} className="border-b border-slate-200 last:border-0 hover:bg-slate-50 transition-colors">
                        <td className="py-3 pr-3 font-medium text-gray-800">
                          <span>{item.producto_nombre}</span>
                          <span className={`ml-2 inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold align-middle ${
                            item.tipo_precio === "mayorista" ? "bg-indigo-100 text-indigo-700"
                            : item.tipo_precio === "distribuidor" ? "bg-emerald-100 text-emerald-700"
                            : item.tipo_precio === "costo" ? "bg-amber-100 text-amber-700"
                            : "bg-slate-100 text-slate-600"
                          }`}>
                            {tipoPrecioLabel[item.tipo_precio ?? "minorista"]}
                          </span>
                        </td>
                        <td className="hidden py-3 pr-3 font-mono text-xs text-gray-500 lg:table-cell">
                          {item.sku}
                        </td>
                        <td className="py-3 pr-3 text-right tabular-nums">
                          {item.cantidad}
                        </td>
                        <td className="py-3 pr-3 text-right tabular-nums text-gray-600 text-xs">
                          {formatGs(item.precio_venta)}
                        </td>
                        <td className="hidden py-3 pr-3 text-center lg:table-cell">
                          <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-gray-100 text-gray-600">
                            {ivaLabel[item.tipo_iva]}
                          </span>
                        </td>
                        <td className="py-3 pr-3 text-right tabular-nums text-gray-600 text-xs hidden lg:table-cell">
                          {formatGs(item.subtotal)}
                        </td>
                        <td className="py-3 pr-3 text-right tabular-nums text-gray-500 text-xs hidden lg:table-cell">
                          {item.monto_iva > 0 ? formatGs(item.monto_iva) : "—"}
                        </td>
                        <td className="py-3 pr-3 text-right tabular-nums font-semibold text-gray-800">
                          {formatGs(item.total_linea)}
                        </td>
                        <td className="py-3 text-center">
                          <button
                            type="button"
                            onClick={() => handleEliminarLinea(idx)}
                            className="inline-flex items-center justify-center min-w-[40px] min-h-[40px] text-red-400 hover:text-red-700 transition-colors rounded hover:bg-red-50"
                            title="Eliminar producto"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                              <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 0 0 6 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 1 0 .23 1.482l.149-.022.841 10.518A2.75 2.75 0 0 0 7.596 19h4.807a2.75 2.75 0 0 0 2.742-2.53l.841-10.52.149.023a.75.75 0 0 0 .23-1.482A41.03 41.03 0 0 0 14 4.193V3.75A2.75 2.75 0 0 0 11.25 1h-2.5ZM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4ZM8.58 7.72a.75.75 0 0 0-1.5.06l.3 7.5a.75.75 0 1 0 1.5-.06l-.3-7.5Zm4.34.06a.75.75 0 1 0-1.5-.06l-.3 7.5a.75.75 0 1 0 1.5.06l.3-7.5Z" clipRule="evenodd" />
                            </svg>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Totales + Cobro (vuelto) */}
              <div className="mt-5 flex justify-end">
                <div className="w-full space-y-3 lg:w-80">
                  <div className="space-y-1.5">
                    <div className="flex justify-between text-sm text-gray-600">
                      <span>Subtotal</span>
                      <span className="tabular-nums font-medium">{formatGs(totalSubtotal)}</span>
                    </div>
                    <div className="flex justify-between text-sm text-gray-600">
                      <span>IVA</span>
                      <span className="tabular-nums font-medium">
                        {totalIva > 0 ? formatGs(totalIva) : "—"}
                      </span>
                    </div>
                    <div className="flex justify-between text-base font-bold text-gray-900 pt-2 border-t border-gray-200">
                      <span>TOTAL</span>
                      <span className="tabular-nums">{formatGs(totalGeneral)}</span>
                    </div>
                  </div>

                  {tipoVenta === "CONTADO" && (
                    <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2.5">
                      <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">Cobro</p>
                      <div className="grid grid-cols-3 gap-1.5">
                        {([
                          { v: "efectivo", label: "Efectivo" },
                          { v: "transferencia", label: "Transferencia" },
                          { v: "tarjeta", label: "Tarjeta/Débito" },
                        ] as { v: MetodoPago; label: string }[]).map((m) => (
                          <button
                            key={m.v}
                            type="button"
                            onClick={() => handleSelectMetodo(m.v)}
                            className={`text-xs py-2 rounded-md border transition-colors ${
                              metodoPago === m.v
                                ? "border-[#0EA5E9] bg-[#0EA5E9]/10 text-[#0EA5E9] font-medium"
                                : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                            }`}
                          >
                            {m.label}
                          </button>
                        ))}
                      </div>

                      {/* Efectivo: monto recibido + vuelto, sin datos extra */}
                      {metodoPago === "efectivo" && (
                        <div className="space-y-1.5">
                          <MontoInput
                            value={montoRecibido}
                            onChange={(n) => setMontoRecibido(String(n))}
                            placeholder="Monto recibido (Gs.) — opcional"
                            className={inputClass}
                            decimals={false}
                          />
                          {montoRecibidoNum > 0 && (
                            <div className="flex justify-between text-sm">
                              <span className="text-gray-600">{vuelto >= 0 ? "Vuelto" : "Falta"}</span>
                              <span className={`font-bold tabular-nums ${vuelto >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                                {formatGs(Math.abs(vuelto))}
                              </span>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Transferencia / Tarjeta: resumen compacto + editar */}
                      {(metodoPago === "transferencia" || metodoPago === "tarjeta") && (
                        <div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs space-y-1">
                          <div className="flex items-center justify-between">
                            <span className="font-medium text-slate-700">
                              {metodoPago === "transferencia" ? "Transferencia" : "Tarjeta / Débito"}
                            </span>
                            <button type="button" onClick={() => { setEntidadQuery(""); setCobroModalOpen(true); }} className="text-sky-600 font-medium hover:underline">
                              Editar
                            </button>
                          </div>
                          <p className="text-slate-500">
                            Entidad: <span className="text-slate-700">{entidadSel ? `${entidadSel.codigo ? entidadSel.codigo + " · " : ""}${entidadSel.nombre}` : "— sin especificar —"}</span>
                          </p>
                          {pagoReferencia.trim() && <p className="text-slate-500">Comprobante: <span className="text-slate-700">{pagoReferencia}</span></p>}
                          {metodoPago === "transferencia" && pagoTitular.trim() && (
                            <p className="text-slate-500">Titular: <span className="text-slate-700">{pagoTitular}</span></p>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}

          {/* Error confirmar */}
          {errorVenta && (
            <div className="mt-4 flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-xs text-red-700">
              <span className="text-base leading-none mt-0.5">⚠</span>
              <span className="font-medium">{errorVenta}</span>
            </div>
          )}

          {/* Acciones — stack vertical full-width en mobile (mas facil de tappear),
              fila en sm+. Confirmar en orden visual primero (primary). */}
          <div className="mt-6 flex flex-col-reverse sm:flex-row gap-3">
            <button
              type="button"
              onClick={() => router.push("/ventas")}
              className="border border-slate-200 px-6 py-3 rounded-lg text-sm hover:bg-slate-50 transition-colors min-h-[48px] w-full sm:w-auto"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={!ventaValida || guardando}
              aria-busy={guardando}
              className="bg-[#0EA5E9] hover:bg-[#0284C7] text-white px-6 py-3 rounded-lg text-sm font-medium transition-colors shadow-sm disabled:opacity-40 disabled:cursor-not-allowed active:scale-95 min-h-[48px] w-full sm:w-auto"
            >
              {guardando ? "Guardando…" : "Confirmar venta"}
            </button>
          </div>

        </div>

      </form>

      <ProductPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onAgregar={handleAgregarDesdePicker}
        excludeIds={items.map((i) => i.producto_id)}
        moneda={moneda}
        tipoCambio={tipoCambioNum}
        ivaDefault={lineaIva}
        tipoPrecioDefault={clienteSel?.nivel_precio ?? "minorista"}
      />

      {/* Modal de cobro (transferencia / tarjeta-débito) */}
      {cobroModalOpen && (metodoPago === "transferencia" || metodoPago === "tarjeta") && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setCobroModalOpen(false)}>
          <div className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl space-y-3" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-800">
                {metodoPago === "transferencia" ? "Datos de transferencia" : "Datos de tarjeta / débito"}
              </h3>
              <button type="button" onClick={() => setCobroModalOpen(false)} className="text-slate-400 hover:text-slate-700 text-lg leading-none">✕</button>
            </div>

            <div>
              <label className="block text-xs text-gray-600 mb-1">
                {metodoPago === "tarjeta" ? "Entidad / banco / POS" : "Entidad / banco"}
              </label>
              <input
                type="text"
                value={entidadQuery}
                onChange={(e) => setEntidadQuery(e.target.value)}
                placeholder="Buscar por código o nombre…"
                className={inputClass}
                autoFocus
              />
              <div className="mt-1 max-h-40 overflow-auto rounded-lg border border-slate-100">
                {entidadesFiltradas.length === 0 ? (
                  <p className="px-3 py-2 text-xs text-gray-400">Sin entidades. Cargalas en Configuración → Entidades bancarias.</p>
                ) : (
                  entidadesFiltradas.map((en) => (
                    <button
                      key={en.id}
                      type="button"
                      onClick={() => { setPagoEntidadId(en.id); setEntidadQuery(""); }}
                      className={`block w-full text-left px-3 py-1.5 text-sm hover:bg-slate-50 ${pagoEntidadId === en.id ? "bg-sky-50" : ""}`}
                    >
                      {en.codigo && <span className="font-mono text-xs text-slate-400 mr-2">{en.codigo}</span>}
                      {en.nombre}
                    </button>
                  ))
                )}
              </div>
              {entidadSel && <p className="mt-1 text-[11px] text-emerald-600">Seleccionada: {entidadSel.nombre}</p>}
            </div>

            {metodoPago === "transferencia" && (
              <div>
                <label className="block text-xs text-gray-600 mb-1">Titular que transfirió</label>
                <input type="text" value={pagoTitular} onChange={(e) => setPagoTitular(e.target.value)} placeholder="Nombre del titular" className={inputClass} />
              </div>
            )}

            <div>
              <label className="block text-xs text-gray-600 mb-1">N° de comprobante / referencia</label>
              <input type="text" value={pagoReferencia} onChange={(e) => setPagoReferencia(e.target.value)} placeholder="Comprobante / transacción" className={inputClass} />
            </div>

            <button type="button" onClick={() => setCobroModalOpen(false)} className="w-full rounded-lg bg-[#0EA5E9] py-2 text-sm font-medium text-white hover:bg-[#0284C7]">
              Listo
            </button>
          </div>
        </div>
      )}

      {/* Modal de confirmación: venta sin stock suficiente */}
      {confirmSinStockOpen && faltantes.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setConfirmSinStockOpen(false)}>
          <div className="w-full max-w-lg rounded-xl bg-white p-5 shadow-xl space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start gap-2">
              <span className="text-amber-500 text-xl leading-none">⚠</span>
              <div>
                <h3 className="text-sm font-semibold text-slate-800">Hay productos/insumos sin stock suficiente</h3>
                <p className="text-xs text-slate-500 mt-0.5">Revisá el detalle. Podés vender igual: el stock quedará negativo y se registrará el movimiento de salida.</p>
              </div>
            </div>

            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="bg-slate-50 text-slate-600 text-xs">
                    <th className="py-2 px-3 font-medium">Producto / Insumo</th>
                    <th className="py-2 px-3 font-medium text-right">Stock actual</th>
                    <th className="py-2 px-3 font-medium text-right">Solicitado</th>
                    <th className="py-2 px-3 font-medium text-right">Faltante</th>
                  </tr>
                </thead>
                <tbody>
                  {faltantes.map((f) => (
                    <tr key={f.producto_id} className="border-t border-slate-100">
                      <td className="py-2 px-3">
                        <span className="font-medium text-slate-800">{f.nombre}</span>
                        <span className={`ml-2 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${f.tipo === "insumo" ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-600"}`}>
                          {f.tipo === "insumo" ? "Insumo" : "Producto"}
                        </span>
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums">{f.stock_actual}</td>
                      <td className="py-2 px-3 text-right tabular-nums">{f.solicitado}</td>
                      <td className="py-2 px-3 text-right tabular-nums font-semibold text-red-600">{f.faltante}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
              <button type="button" onClick={() => setConfirmSinStockOpen(false)} className="rounded-lg border border-slate-200 px-4 py-2 text-sm hover:bg-slate-50">
                Cancelar
              </button>
              <button type="button" disabled={guardando} aria-busy={guardando} onClick={() => void confirmarVentaSinStock()} className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-white hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed">
                {guardando ? "Guardando…" : "Confirmar venta de todos modos"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Panel post-venta: abrir ticket y (si aplica) nota de remisión */}
      {postVenta && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl space-y-4 text-center">
            <div className="text-3xl">✅</div>
            <div>
              <h3 className="text-base font-semibold text-slate-800">Venta {postVenta.numero} registrada</h3>
              {postVenta.credito && (
                <p className="mt-1 text-sm font-medium text-amber-700">Venta a crédito registrada. Cuenta por cobrar generada.</p>
              )}
              {postVenta.generaNota && (
                <p className="mt-1 text-sm text-sky-700">Esta venta genera nota de remisión.</p>
              )}
              {postVenta.numeroFactura && (
                <p className="mt-1 text-sm font-medium text-emerald-700">
                  Factura ERP <span className="font-mono">{postVenta.numeroFactura}</span> generada — lista para emitir a SIFEN.
                </p>
              )}
              {postVenta.facturaWarning && (
                <p className="mt-1 text-xs text-rose-700">{postVenta.facturaWarning}</p>
              )}
              <p className="mt-1 text-xs text-gray-400">
                Si tu navegador bloqueó las pestañas, abrí los documentos con estos botones.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-2">
              {postVenta.facturaId && (
                <button
                  type="button"
                  onClick={() => router.push(`/facturas/${postVenta.facturaId}`)}
                  className="rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700"
                >
                  Emitir factura legal (SIFEN)
                </button>
              )}
              <a
                href={`/api/ventas/${postVenta.id}/ticket?mode=comandas&auto=1`}
                target="_blank"
                rel="noopener"
                className="rounded-lg bg-[#0EA5E9] px-4 py-2.5 text-sm font-medium text-white hover:bg-[#0284C7]"
              >
                Abrir ticket
              </a>
              {postVenta.generaNota && (
                <a
                  href={`/api/ventas/${postVenta.id}/ticket?tipo=remision&auto=1`}
                  target="_blank"
                  rel="noopener"
                  className="rounded-lg border border-sky-300 bg-sky-50 px-4 py-2.5 text-sm font-medium text-sky-700 hover:bg-sky-100"
                >
                  Abrir nota de remisión
                </a>
              )}
              {/* Recibo de dinero solo para venta contado (en crédito el recibo sale al cobrar). */}
              {!postVenta.credito && (
                <button
                  type="button"
                  onClick={async () => {
                    const r = await generarYAbrirRecibo({ origen: "venta_contado", venta_id: postVenta.id });
                    if (!r.ok) setErrorVenta(r.error ?? "No se pudo generar el recibo.");
                  }}
                  className="rounded-lg border border-[#4FAEB2]/40 bg-[#4FAEB2]/[0.08] px-4 py-2.5 text-sm font-medium text-[#3F8E91] hover:bg-[#4FAEB2]/[0.16]"
                >
                  Generar recibo de dinero
                </button>
              )}
            </div>

            <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-center pt-1">
              <button
                type="button"
                onClick={() => { setPostVenta(null); router.push("/ventas"); }}
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
              >
                Ir a ventas
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal chico para crear un cliente sin salir del flujo de la venta. */}
      {modalNuevoCliente && (
        <NuevoClienteRapidoModal
          nombreInicial={clienteQuery.trim() || undefined}
          onClose={() => setModalNuevoCliente(false)}
          onCreado={(c: NuevoClienteCreado) => {
            // Insertamos el nuevo cliente en la lista local y lo seleccionamos.
            setClientes((prev) => [
              ...prev,
              {
                id: c.id,
                label: c.nombre,
                ruc: c.ruc,
                usa_nota_remision: false,
                nivel_precio: "minorista",
              },
            ]);
            setClienteId(c.id);
            setClienteQuery("");
            setModalNuevoCliente(false);
            // Refresco pasivo para pescar campos derivados (empresa, nombre_facturacion, etc.).
            void fetchClientes();
          }}
        />
      )}
    </div>
  );
}
