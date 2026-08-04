"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import { Plus, X, Search, Loader2, Paperclip } from "lucide-react";

// ── Tipos ─────────────────────────────────────────────────────────────────────
type Resumen = {
  id: string;
  numero: string;
  compra_numero_control: string;
  proveedor_nombre: string;
  numero_documento: string | null;
  fecha_documento: string | null;
  tipo: string;
  motivo: string | null;
  moneda: string;
  subtotal: number;
  monto_iva: number;
  total: number;
  estado: string;
  items_count: number;
  created_at: string;
};
type CompraLinea = {
  producto_id: string;
  producto_nombre: string;
  sku: string;
  cantidad_comprada: number;
  costo_unitario: number;
  iva_tipo: string;
};
type CompraParaNC = {
  numero_control: string;
  numero_factura_proveedor: string | null;
  proveedor_id: string | null;
  proveedor_nombre: string;
  moneda: string;
  lineas: CompraLinea[];
};

const TIPO_LABEL: Record<string, { label: string; cls: string }> = {
  devolucion: { label: "Devolución", cls: "bg-indigo-100 text-indigo-800" },
  descuento: { label: "Descuento", cls: "bg-sky-100 text-sky-800" },
};
const ESTADO_LABEL: Record<string, { label: string; cls: string }> = {
  registrada: { label: "Registrada", cls: "bg-emerald-100 text-emerald-800" },
  anulada: { label: "Anulada", cls: "bg-slate-100 text-slate-500" },
};

function fmtGs(n: number, moneda = "PYG") {
  return (moneda === "USD" ? "USD " : "Gs. ") + Math.round(Number(n) || 0).toLocaleString("es-PY");
}
function fmtNum(n: number) {
  return (Number(n) || 0).toLocaleString("es-PY", { maximumFractionDigits: 2 });
}
function fmtFecha(iso: string | null): string {
  if (!iso) return "—";
  const s = String(iso).slice(0, 10);
  const [y, m, d] = s.split("-");
  return d && m && y ? `${d}/${m}/${y}` : s;
}

function Badge({ map, k }: { map: Record<string, { label: string; cls: string }>; k: string }) {
  const e = map[k] ?? { label: k, cls: "bg-slate-100 text-slate-600" };
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${e.cls}`}>{e.label}</span>;
}

export default function NotasCreditoCompraPage() {
  const [notas, setNotas] = useState<Resumen[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detalleId, setDetalleId] = useState<string | null>(null);
  const [crearAbierto, setCrearAbierto] = useState(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      const res = await fetchWithSupabaseSession("/api/notas-credito-compra", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "No se pudo cargar.");
      setNotas(json?.data?.notas ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al cargar.");
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    cargar();
  }, [cargar]);

  return (
    <div className="space-y-8">
      <div>
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-[#4FAEB2]" style={{ boxShadow: "0 0 0 3px rgba(79, 174, 178, 0.18)" }} />
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#4FAEB2]">Zentra · Adquisiciones</p>
        </div>
        <h1 className="mt-1 text-lg font-semibold tracking-tight text-slate-900">Compras</h1>
        <p className="mt-0.5 text-xs text-slate-500">Notas de crédito de proveedor (devolución de mercadería o descuento), vinculadas a una compra</p>
      </div>

      {/* Navegación del módulo Compras */}
      <div className="flex flex-wrap items-center gap-1 border-b border-slate-200">
        <Link href="/compras" className="border-b-2 border-transparent px-4 py-2 text-sm font-medium text-slate-500 transition-colors hover:text-[#3F8E91]">Compras</Link>
        <Link href="/compras/ordenes" className="border-b-2 border-transparent px-4 py-2 text-sm font-medium text-slate-500 transition-colors hover:text-[#3F8E91]">Órdenes de compra</Link>
        <span className="border-b-2 border-[#4FAEB2] px-4 py-2 text-sm font-semibold text-[#3F8E91]">NC Proveedor</span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">Notas de crédito de proveedor</h2>
        <button
          onClick={() => setCrearAbierto(true)}
          className="inline-flex items-center gap-2 rounded-lg bg-[#4FAEB2] px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-[#3F8E91] active:scale-95"
        >
          <Plus className="h-4 w-4" /> Registrar NC
        </button>
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        {cargando ? (
          <div className="px-4 py-10 text-center text-sm text-slate-400">Cargando…</div>
        ) : notas.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-slate-400">Todavía no registraste notas de crédito de proveedor.</div>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3 font-semibold">Número</th>
                <th className="px-4 py-3 font-semibold">Compra</th>
                <th className="px-4 py-3 font-semibold">Proveedor</th>
                <th className="px-4 py-3 font-semibold">Tipo</th>
                <th className="px-4 py-3 font-semibold text-right">Total</th>
                <th className="px-4 py-3 font-semibold">Fecha</th>
                <th className="px-4 py-3 font-semibold">Estado</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {notas.map((n) => (
                <tr key={n.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-medium tabular-nums text-slate-800">{n.numero}</td>
                  <td className="px-4 py-3 tabular-nums text-slate-600">{n.compra_numero_control}</td>
                  <td className="px-4 py-3 text-slate-600">{n.proveedor_nombre || "—"}</td>
                  <td className="px-4 py-3"><Badge map={TIPO_LABEL} k={n.tipo} /></td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-700">{fmtGs(n.total, n.moneda)}</td>
                  <td className="px-4 py-3 text-slate-500">{fmtFecha(n.fecha_documento ?? n.created_at)}</td>
                  <td className="px-4 py-3"><Badge map={ESTADO_LABEL} k={n.estado} /></td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => setDetalleId(n.id)} className="text-sm font-medium text-[#4FAEB2] hover:underline">Ver</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {crearAbierto && (
        <ModalCrear
          onClose={() => setCrearAbierto(false)}
          onCreada={() => {
            setCrearAbierto(false);
            cargar();
          }}
        />
      )}
      {detalleId && <ModalDetalle id={detalleId} onClose={() => setDetalleId(null)} onCambio={cargar} />}
    </div>
  );
}

// ── Modal: crear ──────────────────────────────────────────────────────────────
function ModalCrear({ onClose, onCreada }: { onClose: () => void; onCreada: () => void }) {
  const [numeroCompra, setNumeroCompra] = useState("");
  const [compra, setCompra] = useState<CompraParaNC | null>(null);
  const [buscando, setBuscando] = useState(false);
  const [tipo, setTipo] = useState<"devolucion" | "descuento">("devolucion");
  const [numeroDoc, setNumeroDoc] = useState("");
  const [fechaDoc, setFechaDoc] = useState("");
  const [motivo, setMotivo] = useState("");
  // Cantidad a devolver por producto (solo devolución).
  const [devol, setDevol] = useState<Record<string, string>>({});
  // Montos (editables — se prellenan pero el usuario ajusta a lo que dice el documento).
  const [subtotal, setSubtotal] = useState("");
  const [montoIva, setMontoIva] = useState("");
  const [total, setTotal] = useState("");
  const [comprobante, setComprobante] = useState<{ path: string; nombre: string; mime: string } | null>(null);
  const [subiendo, setSubiendo] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function buscarCompra() {
    const numero = numeroCompra.trim();
    if (!numero) return;
    setBuscando(true);
    setErr(null);
    setCompra(null);
    setDevol({});
    try {
      const res = await fetchWithSupabaseSession(`/api/notas-credito-compra/compra/${encodeURIComponent(numero)}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "No se encontró la compra.");
      setCompra(json?.data?.compra ?? null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error al buscar la compra.");
    } finally {
      setBuscando(false);
    }
  }

  // Recalcula el subtotal sugerido con las cantidades a devolver.
  const subtotalDevol = useMemo(() => {
    if (tipo !== "devolucion" || !compra) return 0;
    return compra.lineas.reduce((acc, l) => acc + (Number(devol[l.producto_id]) || 0) * l.costo_unitario, 0);
  }, [tipo, compra, devol]);

  useEffect(() => {
    if (tipo === "devolucion") {
      const st = Math.round(subtotalDevol);
      setSubtotal(String(st));
      const iva = Math.round(st * 0.1); // sugerencia 10%; editable
      setMontoIva(String(iva));
      setTotal(String(st + iva));
    }
  }, [subtotalDevol, tipo]);

  async function subirComprobante(file: File) {
    setSubiendo(true);
    setErr(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetchWithSupabaseSession("/api/compras/comprobante/upload", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "No se pudo subir.");
      setComprobante({
        path: json.data.comprobante_storage_path,
        nombre: json.data.comprobante_nombre,
        mime: json.data.comprobante_mime_type,
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error al subir el comprobante.");
    } finally {
      setSubiendo(false);
    }
  }

  async function guardar() {
    setErr(null);
    if (!compra) return setErr("Buscá primero la compra a corregir.");
    const items =
      tipo === "devolucion"
        ? compra.lineas
            .map((l) => {
              const cant = Number(devol[l.producto_id]) || 0;
              return {
                producto_id: l.producto_id,
                producto_nombre: l.producto_nombre,
                sku: l.sku,
                cantidad: cant,
                costo_unitario: l.costo_unitario,
                subtotal: cant * l.costo_unitario,
              };
            })
            .filter((i) => i.cantidad > 0)
        : [];
    if (tipo === "devolucion" && items.length === 0) {
      return setErr("Indicá la cantidad a devolver de al menos un producto.");
    }
    if (!(Number(total) > 0)) return setErr("El total debe ser mayor a 0.");

    setGuardando(true);
    try {
      const res = await fetchWithSupabaseSession("/api/notas-credito-compra", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          compra_numero_control: compra.numero_control,
          tipo,
          numero_documento: numeroDoc.trim() || undefined,
          fecha_documento: fechaDoc || undefined,
          motivo: motivo.trim() || undefined,
          subtotal: Number(subtotal) || 0,
          monto_iva: Number(montoIva) || 0,
          total: Number(total) || 0,
          comprobante_storage_path: comprobante?.path,
          comprobante_nombre: comprobante?.nombre,
          comprobante_mime_type: comprobante?.mime,
          items,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "No se pudo registrar.");
      onCreada();
    } catch (e) {
      setGuardando(false);
      setErr(e instanceof Error ? e.message : "Error al registrar.");
    }
  }

  return (
    <Overlay onClose={onClose} titulo="Registrar nota de crédito de proveedor">
      <div className="space-y-4">
        {/* Compra */}
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">Compra a corregir</label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
              <input
                value={numeroCompra}
                onChange={(e) => setNumeroCompra(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") buscarCompra(); }}
                placeholder="N° de factura del proveedor o COMP-000012"
                className="w-full rounded-lg border border-slate-200 py-2 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]"
              />
            </div>
            <button
              onClick={buscarCompra}
              disabled={buscando}
              className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            >
              {buscando ? "Buscando…" : "Buscar"}
            </button>
          </div>
        </div>

        {compra && (
          <>
            <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
              <div>Proveedor: <span className="font-medium text-slate-800">{compra.proveedor_nombre || "—"}</span></div>
              <div className="mt-0.5 text-xs text-slate-500">
                Factura: <span className="font-medium text-slate-700">{compra.numero_factura_proveedor || "Sin número cargado"}</span>
                <span className="ml-2 text-slate-400">· Control {compra.numero_control}</span>
              </div>
            </div>

            {/* Tipo */}
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">Tipo</label>
              <div className="flex gap-2">
                {(["devolucion", "descuento"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTipo(t)}
                    className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${tipo === t ? "border-[#4FAEB2] bg-[#4FAEB2]/10 text-[#3F8E91]" : "border-slate-200 text-slate-500 hover:bg-slate-50"}`}
                  >
                    {t === "devolucion" ? "Devolución (afecta stock)" : "Descuento (solo documento)"}
                  </button>
                ))}
              </div>
            </div>

            {/* Líneas de devolución */}
            {tipo === "devolucion" && (
              <div className="overflow-hidden rounded-lg border border-slate-200">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-3 py-2 text-left font-semibold">Producto</th>
                      <th className="px-3 py-2 text-right font-semibold">Comprado</th>
                      <th className="px-3 py-2 text-right font-semibold">Costo</th>
                      <th className="px-3 py-2 text-right font-semibold">A devolver</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {compra.lineas.map((l) => (
                      <tr key={l.producto_id}>
                        <td className="px-3 py-2">
                          <div className="font-medium text-slate-800">{l.producto_nombre}</div>
                          <div className="text-xs text-slate-400">{l.sku}</div>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-500">{fmtNum(l.cantidad_comprada)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-500">{fmtGs(l.costo_unitario, compra.moneda)}</td>
                        <td className="px-3 py-2 text-right">
                          <input
                            type="number"
                            min={0}
                            max={l.cantidad_comprada}
                            step="any"
                            value={devol[l.producto_id] ?? ""}
                            onChange={(e) => setDevol((p) => ({ ...p, [l.producto_id]: e.target.value }))}
                            className="w-24 rounded border border-slate-200 px-2 py-1 text-right tabular-nums focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Datos del documento */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">N° documento (del proveedor)</label>
                <input value={numeroDoc} onChange={(e) => setNumeroDoc(e.target.value)} placeholder="Ej: 001-001-0000123"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">Fecha del documento</label>
                <input type="date" value={fechaDoc} onChange={(e) => setFechaDoc(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]" />
              </div>
            </div>

            {/* Montos (editables) */}
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">Subtotal</label>
                <input type="number" min={0} step="any" value={subtotal} onChange={(e) => setSubtotal(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-right text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">IVA</label>
                <input type="number" min={0} step="any" value={montoIva} onChange={(e) => setMontoIva(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-right text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">Total</label>
                <input type="number" min={0} step="any" value={total} onChange={(e) => setTotal(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-right text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]" />
              </div>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">Motivo (opcional)</label>
              <textarea value={motivo} onChange={(e) => setMotivo(e.target.value)} rows={2}
                placeholder="Ej: devolución por mercadería vencida"
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]" />
            </div>

            {/* Comprobante */}
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">Comprobante (PDF/imagen, opcional)</label>
              <div className="flex items-center gap-3">
                <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50">
                  {subiendo ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
                  {subiendo ? "Subiendo…" : "Adjuntar"}
                  <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) subirComprobante(f); }} />
                </label>
                {comprobante && <span className="truncate text-xs text-slate-500">{comprobante.nombre}</span>}
              </div>
            </div>
          </>
        )}

        {err && <p className="text-sm text-red-600">{err}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-slate-500 hover:text-slate-700">Cancelar</button>
          <button onClick={guardar} disabled={guardando || !compra}
            className="rounded-lg bg-[#4FAEB2] px-4 py-2 text-sm font-semibold text-white hover:bg-[#3F8E91] disabled:opacity-50">
            {guardando ? "Registrando…" : "Registrar NC"}
          </button>
        </div>
      </div>
    </Overlay>
  );
}

// ── Modal: detalle + anular ───────────────────────────────────────────────────
function ModalDetalle({ id, onClose, onCambio }: { id: string; onClose: () => void; onCambio: () => void }) {
  const [cab, setCab] = useState<Record<string, unknown> | null>(null);
  const [items, setItems] = useState<Array<Record<string, unknown>>>([]);
  const [cargando, setCargando] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [anulando, setAnulando] = useState(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    setErr(null);
    try {
      const res = await fetchWithSupabaseSession(`/api/notas-credito-compra/${id}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "No se pudo cargar.");
      setCab(json?.data?.cabecera ?? null);
      setItems(json?.data?.items ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error.");
    } finally {
      setCargando(false);
    }
  }, [id]);

  useEffect(() => { cargar(); }, [cargar]);

  const g = (k: string) => (cab ? cab[k] : null);
  const estado = String(g("estado") ?? "");
  const moneda = String(g("moneda") ?? "PYG");

  async function anular() {
    const motivo = window.prompt("Motivo de la anulación (mín. 5 caracteres):");
    if (!motivo || motivo.trim().length < 5) return;
    setAnulando(true);
    setErr(null);
    try {
      const res = await fetchWithSupabaseSession(`/api/notas-credito-compra/${id}/anular`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ motivo: motivo.trim() }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "No se pudo anular.");
      await cargar();
      onCambio();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error al anular.");
    } finally {
      setAnulando(false);
    }
  }

  return (
    <Overlay onClose={onClose} titulo={cab ? `Nota de crédito ${String(g("numero"))}` : "Nota de crédito"}>
      {cargando ? (
        <div className="py-10 text-center text-sm text-slate-400">Cargando…</div>
      ) : !cab ? (
        <div className="py-10 text-center text-sm text-slate-400">No se encontró la nota de crédito.</div>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-3">
            <Badge map={ESTADO_LABEL} k={estado} />
            <Badge map={TIPO_LABEL} k={String(g("tipo"))} />
            <span className="text-sm text-slate-500">Compra {String(g("compra_numero_control"))}</span>
          </div>

          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm text-slate-600">
            <span>Proveedor: <span className="font-medium text-slate-800">{String(g("proveedor_nombre") || "—")}</span></span>
            <span>N° documento: {String(g("numero_documento") || "—")}</span>
            <span>Fecha doc.: {fmtFecha(g("fecha_documento") as string | null)}</span>
            <span>Total: <span className="font-medium text-slate-800">{fmtGs(Number(g("total")), moneda)}</span></span>
          </div>

          {g("motivo") ? <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">{String(g("motivo"))}</p> : null}
          {g("anulacion_motivo") ? <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">Anulación: {String(g("anulacion_motivo"))}</p> : null}

          {items.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold">Producto</th>
                    <th className="px-3 py-2 text-right font-semibold">Cantidad</th>
                    <th className="px-3 py-2 text-right font-semibold">Costo</th>
                    <th className="px-3 py-2 text-right font-semibold">Subtotal</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {items.map((it, i) => (
                    <tr key={i}>
                      <td className="px-3 py-2">
                        <div className="font-medium text-slate-800">{String(it.producto_nombre)}</div>
                        <div className="text-xs text-slate-400">{String(it.sku_snapshot ?? "")}</div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-600">{fmtNum(Number(it.cantidad))}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-600">{fmtGs(Number(it.costo_unitario), moneda)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-600">{fmtGs(Number(it.subtotal), moneda)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {err && <p className="text-sm text-red-600">{err}</p>}

          <div className="flex justify-end gap-2 pt-1">
            {estado === "registrada" && (
              <button onClick={anular} disabled={anulando}
                className="rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50">
                {anulando ? "Anulando…" : "Anular"}
              </button>
            )}
          </div>
        </div>
      )}
    </Overlay>
  );
}

// ── Overlay ───────────────────────────────────────────────────────────────────
function Overlay({ titulo, onClose, children }: { titulo: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:items-center">
      <div className="my-8 w-full max-w-2xl rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h2 className="text-lg font-semibold text-slate-900">{titulo}</h2>
          <button onClick={onClose} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}
