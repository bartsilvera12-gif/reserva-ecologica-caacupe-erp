import { getCurrentUser } from "@/lib/auth";
import { getBrowserSupabaseForEmpresaData } from "@/lib/supabase/browser-data-client";
import type {
  Producto,
  MovimientoInventario,
  MetodoValuacion,
  TipoMovimiento,
} from "./types";

// ─── Tipos de fila Supabase ───────────────────────────────────────────────────

interface ProductoRow {
  id: string;
  empresa_id: string;
  nombre: string;
  sku: string;
  costo_promedio: number;
  precio_venta: number;
  stock_actual: number;
  stock_minimo: number;
  unidad_medida: string;
  metodo_valuacion: string;
  activo: boolean;
  created_at: string;
  updated_at: string;
  codigo_barras?: string | null;
  codigo_barras_interno?: boolean | null;
  imagen_path?: string | null;
  imagen_url?: string | null;
}

interface MovimientoRow {
  id: string;
  empresa_id: string;
  producto_id: string;
  producto_nombre: string;
  producto_sku: string;
  tipo: string;
  cantidad: number;
  costo_unitario: number;
  origen: string;
  referencia: string | null;
  fecha: string;
  created_at: string;
  updated_at: string;
}

// ─── Mapeo fila → tipo ────────────────────────────────────────────────────────

function rowToProducto(row: ProductoRow): Producto {
  return {
    id: row.id,
    nombre: row.nombre,
    sku: row.sku,
    costo_promedio: Number(row.costo_promedio),
    precio_venta: Number(row.precio_venta),
    stock_actual: Number(row.stock_actual),
    stock_minimo: Number(row.stock_minimo),
    unidad_medida: row.unidad_medida,
    metodo_valuacion: row.metodo_valuacion as MetodoValuacion,
    codigo_barras: row.codigo_barras ?? null,
    codigo_barras_interno: row.codigo_barras_interno ?? false,
    imagen_path: row.imagen_path ?? null,
    imagen_url: row.imagen_url ?? null,
  };
}

function rowToMovimiento(row: MovimientoRow): MovimientoInventario {
  return {
    id: row.id,
    producto_id: row.producto_id,
    producto_nombre: row.producto_nombre,
    producto_sku: row.producto_sku,
    tipo: row.tipo as TipoMovimiento,
    cantidad: Number(row.cantidad),
    costo_unitario: Number(row.costo_unitario),
    origen: row.origen as MovimientoInventario["origen"],
    referencia: row.referencia ?? undefined,
    fecha: row.fecha,
  };
}

// ─── Productos ─────────────────────────────────────────────────────────────────

/** Lista productos. RLS filtra por empresa automáticamente. */
export async function getProductos(): Promise<Producto[]> {
  const supabase = await getBrowserSupabaseForEmpresaData();
  const { data, error } = await supabase
    .from("productos")
    .select("*")
    .eq("activo", true)
    .order("nombre");

  if (error) {
    console.error("[inventario] getProductos:", error.message);
    return [];
  }
  return (data as ProductoRow[]).map(rowToProducto);
}

/** Obtiene un producto por ID. */
export async function getProducto(id: string): Promise<Producto | null> {
  const supabase = await getBrowserSupabaseForEmpresaData();
  const { data, error } = await supabase
    .from("productos")
    .select("*")
    .eq("id", id)
    .single();

  if (error) {
    console.error("[inventario] getProducto:", error.message);
    return null;
  }
  return rowToProducto(data as ProductoRow);
}

/**
 * Comprueba si ya existe un producto con el mismo SKU o nombre (case-insensitive).
 * Devuelve el producto encontrado o null.
 */
export async function productoExiste(
  sku: string,
  nombre: string
): Promise<Producto | null> {
  const productos = await getProductos();
  const skuNorm = sku.toLowerCase().trim();
  const nombreNorm = nombre.toLowerCase().trim();
  return (
    productos.find(
      (p) =>
        p.sku.toLowerCase() === skuNorm ||
        p.nombre.toLowerCase() === nombreNorm
    ) ?? null
  );
}

export type NuevoProductoData = Omit<Producto, "id">;

/** Crea producto. empresa_id se obtiene del usuario; RLS valida acceso. */
export async function saveProducto(
  datos: NuevoProductoData
): Promise<Producto | null> {
  const supabase = await getBrowserSupabaseForEmpresaData();
  const usuario = await getCurrentUser();
  if (!usuario?.empresa_id) throw new Error("Usuario no autenticado o sin empresa");

  const insert: Record<string, unknown> = {
    empresa_id: usuario.empresa_id,
    nombre: datos.nombre,
    sku: datos.sku,
    costo_promedio: datos.costo_promedio,
    precio_venta: datos.precio_venta,
    stock_actual: datos.stock_actual ?? 0,
    stock_minimo: datos.stock_minimo ?? 0,
    unidad_medida: datos.unidad_medida || "Unidad",
    metodo_valuacion: datos.metodo_valuacion,
  };
  if (datos.codigo_barras !== undefined && datos.codigo_barras !== null && datos.codigo_barras !== "") {
    insert.codigo_barras = datos.codigo_barras;
    insert.codigo_barras_interno = datos.codigo_barras_interno === true;
  }

  const { data, error } = await supabase
    .from("productos")
    .insert([insert])
    .select()
    .single();

  if (error) {
    console.error("[inventario] saveProducto:", error.message);
    // Surface known unique-violations con mensaje claro para la UI.
    // codigo Postgres 23505 = unique_violation.
    const code = (error as { code?: string }).code;
    const msg = error.message ?? "";
    if (code === "23505" && /codigo_barras/i.test(msg)) {
      throw new Error("Ya existe otro producto con el mismo código de barras en esta empresa.");
    }
    if (code === "23505" && /sku/i.test(msg)) {
      throw new Error("Ya existe otro producto con el mismo SKU en esta empresa.");
    }
    if (code === "23505") {
      throw new Error("Ya existe un registro con un valor único conflictivo.");
    }
    return null;
  }

  const producto = rowToProducto(data as ProductoRow);

  // Si tiene stock inicial, generar movimiento de inventario_inicial
  if (producto.stock_actual > 0) {
    await saveMovimiento({
      producto_id: producto.id,
      producto_nombre: producto.nombre,
      producto_sku: producto.sku,
      tipo: "ENTRADA",
      cantidad: producto.stock_actual,
      costo_unitario: producto.costo_promedio,
      origen: "inventario_inicial",
      fecha: new Date().toISOString(),
    });
  }

  return producto;
}

/** Actualiza solo precio_venta y/o costo_promedio. Wrapper de updateProducto. */
export async function updateProductoPrecios(
  productoId: string,
  datos: { precio_venta?: number; costo_promedio?: number }
): Promise<void> {
  await updateProducto(productoId, datos);
}

/** Actualiza producto. RLS valida que pertenezca a la empresa del usuario. */
export async function updateProducto(
  id: string,
  datos: Partial<Omit<Producto, "id">>
): Promise<Producto | null> {
  const supabase = await getBrowserSupabaseForEmpresaData();
  const patch: Record<string, unknown> = {};
  if (datos.nombre !== undefined) patch.nombre = datos.nombre;
  if (datos.sku !== undefined) patch.sku = datos.sku;
  if (datos.costo_promedio !== undefined) patch.costo_promedio = datos.costo_promedio;
  if (datos.precio_venta !== undefined) patch.precio_venta = datos.precio_venta;
  if (datos.stock_actual !== undefined) patch.stock_actual = datos.stock_actual;
  if (datos.stock_minimo !== undefined) patch.stock_minimo = datos.stock_minimo;
  if (datos.unidad_medida !== undefined) patch.unidad_medida = datos.unidad_medida;
  if (datos.metodo_valuacion !== undefined) patch.metodo_valuacion = datos.metodo_valuacion;
  if (datos.codigo_barras !== undefined) {
    patch.codigo_barras = datos.codigo_barras || null;
    if (datos.codigo_barras_interno !== undefined) {
      patch.codigo_barras_interno = datos.codigo_barras_interno;
    } else if (!datos.codigo_barras) {
      patch.codigo_barras_interno = false;
    }
  }
  if (datos.imagen_path !== undefined) patch.imagen_path = datos.imagen_path || null;
  if (datos.imagen_url !== undefined) patch.imagen_url = datos.imagen_url || null;

  const { data, error } = await supabase
    .from("productos")
    .update(patch)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    const code = (error as { code?: string }).code;
    const msg = error.message ?? "";
    if (code === "23505" && /codigo_barras/i.test(msg)) {
      throw new Error("Ya existe otro producto con el mismo código de barras en esta empresa.");
    }
    if (code === "23505" && /sku/i.test(msg)) {
      throw new Error("Ya existe otro producto con el mismo SKU en esta empresa.");
    }
    console.error("[inventario] updateProducto:", error.message);
    return null;
  }
  return rowToProducto(data as ProductoRow);
}

// ─── Movimientos ─────────────────────────────────────────────────────────────

/** Lista movimientos. RLS filtra por empresa automáticamente. */
export async function getMovimientos(): Promise<MovimientoInventario[]> {
  const supabase = await getBrowserSupabaseForEmpresaData();
  const { data, error } = await supabase
    .from("movimientos_inventario")
    .select("*")
    .order("fecha", { ascending: false });

  if (error) {
    console.error("[inventario] getMovimientos:", error.message);
    return [];
  }
  return (data as MovimientoRow[]).map(rowToMovimiento);
}

function calcularDelta(tipo: TipoMovimiento, cantidad: number): number {
  if (tipo === "ENTRADA") return Math.abs(cantidad);
  if (tipo === "SALIDA") return -Math.abs(cantidad);
  return cantidad; // AJUSTE: la cantidad ya lleva el signo
}

export type NuevoMovimientoData = Omit<MovimientoInventario, "id">;

/**
 * Registra un movimiento y actualiza stock_actual del producto.
 * empresa_id se obtiene del usuario; RLS valida acceso.
 */
export async function saveMovimiento(
  mov: NuevoMovimientoData
): Promise<MovimientoInventario | null> {
  const supabase = await getBrowserSupabaseForEmpresaData();
  const usuario = await getCurrentUser();
  if (!usuario?.empresa_id) throw new Error("Usuario no autenticado o sin empresa");

  // 1. Obtener producto actual
  const producto = await getProducto(mov.producto_id);
  if (!producto) {
    console.error("[inventario] saveMovimiento: producto no encontrado");
    return null;
  }

  const delta = calcularDelta(mov.tipo, mov.cantidad);
  const nuevoStock = Math.max(0, producto.stock_actual + delta);
  const debeActualizarStock = mov.origen !== "inventario_inicial"; // inventario_inicial ya viene del insert

  // 2. Insertar movimiento
  const insert = {
    empresa_id: usuario.empresa_id,
    producto_id: mov.producto_id,
    producto_nombre: mov.producto_nombre,
    producto_sku: mov.producto_sku,
    tipo: mov.tipo,
    cantidad: mov.cantidad,
    costo_unitario: mov.costo_unitario,
    origen: mov.origen,
    referencia: mov.referencia ?? null,
    fecha: mov.fecha,
  };

  const { data: movData, error: movError } = await supabase
    .from("movimientos_inventario")
    .insert([insert])
    .select()
    .single();

  if (movError) {
    console.error("[inventario] saveMovimiento:", movError.message);
    return null;
  }

  // 3. Actualizar stock del producto (salvo inventario_inicial, que ya está en el insert)
  if (debeActualizarStock) {
    const { error: updError } = await supabase
      .from("productos")
      .update({ stock_actual: nuevoStock })
      .eq("id", mov.producto_id);

    if (updError) {
      console.error("[inventario] saveMovimiento (update stock):", updError.message);
    }
  }

  return rowToMovimiento(movData as MovimientoRow);
}
