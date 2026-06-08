"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import { ChefHat, ArrowLeft, Plus, Trash2, Save, Loader2 } from "lucide-react";

type Receta = {
  id: string;
  producto_id: string;
  nombre: string | null;
  producto_nombre: string | null;
  rendimiento_cantidad: number;
  rendimiento_unidad: string | null;
  notas: string | null;
  activa: boolean;
};

const UNIDADES_RENDIMIENTO = ["UNIDAD", "PAQUETE", "PORCION", "FRASCO", "BOLSA", "DOCENA"];
const UNIDADES_INSUMO = ["G", "KG", "ML", "L", "UNIDAD"];
type Item = {
  id: string;
  insumo_producto_id: string;
  cantidad: number;
  unidad_medida: string | null;
  merma_pct: number;
  orden: number;
};
type Costeo = {
  costo_total: number;
  costo_unitario: number | null;
  precio_venta: number;
  margen_abs: number;
  margen_pct: number | null;
  unidades_posibles: number | null;
  items: Array<{
    item_id: string;
    insumo_nombre: string;
    cantidad: number;
    unidad_medida: string | null;
    merma_pct: number;
    costo_promedio: number;
    stock_actual: number;
    subcosto: number;
    unidades_aporte: number | null;
  }>;
};
type Producto = {
  id: string;
  nombre: string;
  sku: string;
  costo_promedio: number;
  stock_actual: number;
  unidad_medida: string | null;
};

function fmtGs(n: number | null | undefined) {
  if (n == null) return "—";
  return "Gs. " + Number(n).toLocaleString("es-PY", { maximumFractionDigits: 0 });
}

export default function EditarRecetaPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;

  const [receta, setReceta] = useState<Receta | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [costeo, setCosteo] = useState<Costeo | null>(null);
  const [insumos, setInsumos] = useState<Producto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // form add item
  const [newInsumoId, setNewInsumoId] = useState("");
  const [newCantidad, setNewCantidad] = useState<number>(1);
  const [newUnidad, setNewUnidad] = useState("");
  const [newMerma, setNewMerma] = useState<number>(0);
  const [addingItem, setAddingItem] = useState(false);

  const refresh = useCallback(async () => {
    const [recRes, prodRes] = await Promise.all([
      fetchWithSupabaseSession(`/api/recetas/${id}`, { cache: "no-store" }),
      fetchWithSupabaseSession(`/api/recetas/productos?filtro=insumos`, { cache: "no-store" }),
    ]);
    const recBody = await recRes.json();
    const prodBody = await prodRes.json();
    if (!recRes.ok || recBody?.success === false) {
      setError(recBody?.error ?? "Error al cargar receta");
      return;
    }
    setReceta(recBody.data.receta);
    setItems(recBody.data.items ?? []);
    setCosteo(recBody.data.costeo ?? null);
    if (prodRes.ok && prodBody?.success) {
      setInsumos((prodBody.data.productos ?? []) as Producto[]);
    }
  }, [id]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        await refresh();
      } finally {
        setLoading(false);
      }
    })();
  }, [refresh]);

  const insumosDisponibles = useMemo(() => {
    const usados = new Set(items.map((i) => i.insumo_producto_id));
    return insumos.filter((p) => !usados.has(p.id));
  }, [insumos, items]);

  useEffect(() => {
    if (insumosDisponibles.length > 0 && !newInsumoId) {
      setNewInsumoId(insumosDisponibles[0].id);
      setNewUnidad(insumosDisponibles[0].unidad_medida ?? "");
    }
  }, [insumosDisponibles, newInsumoId]);

  async function saveHeader() {
    if (!receta) return;
    setError(null);
    const res = await fetchWithSupabaseSession(`/api/recetas/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nombre: receta.nombre,
        rendimiento_cantidad: receta.rendimiento_cantidad,
        rendimiento_unidad: receta.rendimiento_unidad,
        notas: receta.notas,
        activa: receta.activa,
      }),
    });
    const body = await res.json();
    if (!res.ok || body?.success === false) {
      setError(body?.error ?? "Error al guardar");
      return;
    }
    await refresh();
  }

  async function addItem() {
    if (!newInsumoId || newCantidad <= 0) return;
    setAddingItem(true);
    try {
      const res = await fetchWithSupabaseSession(`/api/recetas/${id}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          insumo_producto_id: newInsumoId,
          cantidad: Number(newCantidad),
          unidad_medida: newUnidad.trim() || null,
          merma_pct: Number(newMerma) || 0,
        }),
      });
      const body = await res.json();
      if (!res.ok || body?.success === false) {
        setError(body?.error ?? "Error al agregar item");
        return;
      }
      setNewInsumoId("");
      setNewCantidad(1);
      setNewUnidad("");
      setNewMerma(0);
      await refresh();
    } finally {
      setAddingItem(false);
    }
  }

  async function removeItem(itemId: string) {
    if (!confirm("¿Eliminar este insumo de la receta?")) return;
    const res = await fetchWithSupabaseSession(`/api/recetas/${id}/items/${itemId}`, {
      method: "DELETE",
    });
    const body = await res.json();
    if (!res.ok || body?.success === false) {
      setError(body?.error ?? "Error al eliminar");
      return;
    }
    await refresh();
  }

  async function deleteReceta() {
    if (!confirm("¿Eliminar receta completa? Esta acción no se puede deshacer.")) return;
    const res = await fetchWithSupabaseSession(`/api/recetas/${id}`, { method: "DELETE" });
    const body = await res.json();
    if (!res.ok || body?.success === false) {
      setError(body?.error ?? "Error al eliminar");
      return;
    }
    router.push("/dashboard/recetas");
  }

  if (loading) {
    return (
      <div className="p-6 flex items-center gap-2 text-sm text-gray-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
      </div>
    );
  }
  if (!receta) {
    return (
      <div className="p-6">
        <div className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700">
          {error ?? "Receta no encontrada"}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <Link
        href="/dashboard/recetas"
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4"
      >
        <ArrowLeft className="h-4 w-4" /> Volver
      </Link>

      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <ChefHat className="h-7 w-7 text-amber-600" />
          <h1 className="text-2xl font-semibold">
            {receta.nombre?.trim() || (receta.producto_nombre ? `Receta: ${receta.producto_nombre}` : "Receta")}
          </h1>
        </div>
        <button
          onClick={deleteReceta}
          className="inline-flex items-center gap-1 text-sm text-red-600 hover:text-red-700"
        >
          <Trash2 className="h-4 w-4" /> Eliminar receta
        </button>
      </div>

      {/* Costeo summary */}
      {costeo && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <div className="rounded-md bg-white border border-gray-200 p-4">
            <div className="text-xs text-gray-500 uppercase">Costo total receta</div>
            <div className="text-lg font-semibold text-gray-900">{fmtGs(costeo.costo_total)}</div>
          </div>
          <div className="rounded-md bg-white border border-gray-200 p-4">
            <div className="text-xs text-gray-500 uppercase">Costo unitario</div>
            <div className="text-lg font-semibold text-gray-900">{fmtGs(costeo.costo_unitario)}</div>
            <div className="text-xs text-gray-500">costo total / rendimiento</div>
          </div>
          <div className="rounded-md bg-white border border-gray-200 p-4">
            <div className="text-xs text-gray-500 uppercase">Margen</div>
            <div className={`text-lg font-semibold ${(costeo.margen_pct ?? 0) >= 0 ? "text-green-700" : "text-red-700"}`}>
              {costeo.margen_pct == null ? "—" : `${costeo.margen_pct}%`}
            </div>
            <div className="text-xs text-gray-500">{fmtGs(costeo.margen_abs)} / unidad</div>
          </div>
          <div className="rounded-md bg-white border border-gray-200 p-4">
            <div className="text-xs text-gray-500 uppercase">Unidades posibles</div>
            <div className="text-lg font-semibold text-gray-900">
              {costeo.unidades_posibles == null
                ? "—"
                : Math.floor(costeo.unidades_posibles * (receta.rendimiento_cantidad || 1)).toLocaleString("es-PY")}
              {receta.rendimiento_unidad ? <span className="ml-1 text-xs font-normal text-gray-400">{receta.rendimiento_unidad}</span> : null}
            </div>
            <div className="text-xs text-gray-500">
              {costeo.unidades_posibles == null
                ? "según stock de insumos"
                : `${costeo.unidades_posibles} lote(s) × ${receta.rendimiento_cantidad} — según stock de materia prima`}
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700 mb-4">
          {error}
        </div>
      )}

      {/* Header form */}
      <div className="bg-white p-5 rounded-md border border-gray-200 mb-6">
        <h2 className="text-sm font-semibold text-gray-700 mb-1">Datos de la receta</h2>
        <p className="text-xs text-gray-500 mb-3">
          El <b>rendimiento</b> es cuántas unidades produce esta receta con los insumos indicados.
          Ej: 1.500 G de avena + 300 G de miel para producir <b>10 paquetes</b>.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="md:col-span-3">
            <label className="block text-xs font-medium text-gray-600 mb-1">Nombre de la receta</label>
            <input
              type="text"
              value={receta.nombre ?? ""}
              onChange={(e) => setReceta({ ...receta, nombre: e.target.value })}
              placeholder={receta.producto_nombre ? `Ej: Receta de ${receta.producto_nombre}` : "Ej: Granola Orgánica 250g"}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
            <p className="mt-1 text-[11px] text-gray-400">
              Si lo dejás vacío, se mostrará el nombre del producto: <b>{receta.producto_nombre ?? "—"}</b>.
            </p>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Rendimiento (cantidad)</label>
            <input
              type="number"
              step="1"
              min="0.01"
              value={receta.rendimiento_cantidad}
              onChange={(e) => setReceta({ ...receta, rendimiento_cantidad: Number(e.target.value) || 1 })}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
            <p className="mt-1 text-[11px] text-gray-400">¿Cuántas unidades produce?</p>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Unidad de rendimiento</label>
            <select
              value={receta.rendimiento_unidad ?? ""}
              onChange={(e) => setReceta({ ...receta, rendimiento_unidad: e.target.value })}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm bg-white"
            >
              <option value="">— Elegí —</option>
              {UNIDADES_RENDIMIENTO.map((u) => <option key={u} value={u}>{u}</option>)}
              {receta.rendimiento_unidad && !UNIDADES_RENDIMIENTO.includes(receta.rendimiento_unidad) && (
                <option value={receta.rendimiento_unidad}>{receta.rendimiento_unidad}</option>
              )}
            </select>
            <p className="mt-1 text-[11px] text-gray-400">paquetes, unidades, frascos…</p>
          </div>
          <div className="flex items-end pb-6">
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={receta.activa}
                onChange={(e) => setReceta({ ...receta, activa: e.target.checked })}
                className="rounded"
              />
              Activa
            </label>
          </div>
          <div className="md:col-span-3">
            <label className="block text-xs font-medium text-gray-600 mb-1">Notas</label>
            <textarea
              value={receta.notas ?? ""}
              onChange={(e) => setReceta({ ...receta, notas: e.target.value })}
              rows={2}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
        </div>
        <div className="flex justify-end mt-3">
          <button
            onClick={saveHeader}
            className="inline-flex items-center gap-1 rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700"
          >
            <Save className="h-4 w-4" /> Guardar cambios
          </button>
        </div>
      </div>

      {/* Items */}
      <div className="bg-white p-5 rounded-md border border-gray-200">
        <h2 className="text-sm font-semibold text-gray-700 mb-1">Insumos (materia prima)</h2>
        <p className="text-xs text-gray-500 mb-3">
          Cargá cada materia prima con la <b>cantidad usada</b> para todo el rendimiento, su <b>unidad de consumo</b>
          y la <b>merma %</b> (desperdicio). La merma aumenta el consumo real del insumo. El costo se calcula con el
          costo promedio de cada insumo; las <b>unidades posibles</b> salen del stock disponible de materia prima.
        </p>

        {items.length === 0 && (
          <div className="text-sm text-gray-500 mb-3">
            Sin insumos todavía. Agregá insumos del inventario para calcular costo y disponibilidad.
          </div>
        )}

        {items.length > 0 && costeo && (
          /* Wrapper overflow-x-auto + min-w-[840px] activa scroll horizontal
              real en mobile. Columnas secundarias (Merma, Costo unit., Stock,
              Unid. posibles) se ocultan progresivamente para no aplastar todo. */
          <div className="overflow-x-auto -mx-px sm:mx-0">
          <table className="w-full min-w-[840px] sm:min-w-0 text-sm mb-4">
            <thead className="text-left text-xs text-gray-500 uppercase">
              <tr>
                <th className="py-2">Insumo</th>
                <th className="py-2">Cantidad usada</th>
                <th className="py-2 hidden md:table-cell">U. consumo</th>
                <th className="py-2 hidden lg:table-cell">Merma</th>
                <th className="py-2 hidden md:table-cell">Costo/u. insumo</th>
                <th className="py-2">Subcosto</th>
                <th className="py-2 hidden lg:table-cell">Stock</th>
                <th className="py-2 hidden lg:table-cell">Alcanza para</th>
                <th className="py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {costeo.items.map((row) => (
                <tr key={row.item_id}>
                  <td className="py-2 font-medium text-gray-800">{row.insumo_nombre}</td>
                  <td className="py-2 tabular-nums">{Number(row.cantidad).toLocaleString("es-PY")} <span className="text-xs text-gray-400">{row.unidad_medida ?? ""}</span></td>
                  <td className="py-2 text-gray-600 hidden md:table-cell">{row.unidad_medida ?? "—"}</td>
                  <td className="py-2 text-gray-600 hidden lg:table-cell">{(row.merma_pct * 100).toFixed(0)}%</td>
                  <td className="py-2 hidden md:table-cell">{fmtGs(row.costo_promedio)}<span className="text-[10px] text-gray-400">/{row.unidad_medida ?? "u"}</span></td>
                  <td className="py-2 tabular-nums">{fmtGs(row.subcosto)}</td>
                  <td className="py-2 text-gray-600 hidden lg:table-cell tabular-nums">{Number(row.stock_actual).toLocaleString("es-PY")} <span className="text-xs text-gray-400">{row.unidad_medida ?? ""}</span></td>
                  <td className="py-2 hidden lg:table-cell tabular-nums">
                    {row.unidades_aporte == null ? "—" : `${Math.floor(row.unidades_aporte * (receta.rendimiento_cantidad || 1)).toLocaleString("es-PY")} u.`}
                  </td>
                  <td className="py-2 text-right">
                    <button
                      onClick={() => removeItem(row.item_id)}
                      className="inline-flex items-center justify-center min-w-[40px] min-h-[40px] text-red-600 hover:text-red-700 hover:bg-red-50 rounded"
                      aria-label="Eliminar"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}

        {/* Add item */}
        <div className="border-t border-gray-200 pt-4">
          <div className="text-xs font-medium text-gray-600 mb-2">Agregar insumo</div>
          {insumosDisponibles.length === 0 ? (
            <div className="text-sm text-gray-500">
              No hay más insumos disponibles. Marcá productos como insumo (<code>es_insumo=true</code>) desde Inventario.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
              <div className="md:col-span-2">
                <label className="block text-[11px] text-gray-500 mb-1">Materia prima</label>
                <select
                  value={newInsumoId}
                  onChange={(e) => {
                    setNewInsumoId(e.target.value);
                    const p = insumosDisponibles.find((x) => x.id === e.target.value);
                    if (p) setNewUnidad(p.unidad_medida ?? "");
                  }}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm bg-white"
                >
                  {insumosDisponibles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.nombre} — {fmtGs(p.costo_promedio)}/{p.unidad_medida ?? ""} (stock {p.stock_actual})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-gray-500 mb-1">Cantidad usada</label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={newCantidad}
                  onChange={(e) => setNewCantidad(Number(e.target.value))}
                  placeholder="Ej: 1500"
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-[11px] text-gray-500 mb-1">Unidad de consumo</label>
                <select
                  value={newUnidad}
                  onChange={(e) => setNewUnidad(e.target.value)}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm bg-white"
                >
                  <option value="">— Elegí —</option>
                  {UNIDADES_INSUMO.map((u) => <option key={u} value={u}>{u}</option>)}
                  {newUnidad && !UNIDADES_INSUMO.includes(newUnidad) && <option value={newUnidad}>{newUnidad}</option>}
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-gray-500 mb-1">Merma %</label>
                <input
                  type="number"
                  step="1"
                  min="0"
                  max="99"
                  value={Math.round(newMerma * 100)}
                  onChange={(e) => setNewMerma(Math.min(0.99, Math.max(0, (Number(e.target.value) || 0) / 100)))}
                  placeholder="Ej: 5"
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
              <p className="md:col-span-5 -mt-1 text-[11px] text-gray-400">
                Ej: 1.500 G de avena para producir 10 paquetes. La merma % (desperdicio) aumenta el consumo real del insumo.
              </p>
              <button
                onClick={addItem}
                disabled={addingItem || !newInsumoId || newCantidad <= 0}
                className="md:col-span-5 inline-flex items-center justify-center gap-1 rounded-md bg-amber-600 px-3 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
              >
                <Plus className="h-4 w-4" /> {addingItem ? "Agregando…" : "Agregar insumo"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
