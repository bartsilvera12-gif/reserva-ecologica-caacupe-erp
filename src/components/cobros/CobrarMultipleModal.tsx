"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Search, X } from "lucide-react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";

/**
 * Modal para registrar un cobro que abarca VARIAS facturas de un mismo cliente
 * y emite UN unico recibo (REC-XXXXXX). Todo transaccional en el server via
 * POST /api/cobros/con-recibo.
 *
 * Flujo:
 *   1. Elegir cliente (autocompletar por nombre/RUC).
 *   2. Se cargan las cuentas por cobrar pendientes (GET /api/cobros/con-recibo).
 *   3. El operador tilda facturas y ajusta importe por cuenta (default = saldo).
 *   4. Metodo de pago + banco/tarjeta + referencia (mismos campos que el cobro
 *      individual).
 *   5. Confirmar -> se crean N cobros_clientes + 1 recibos_dinero, y se abre
 *      el PDF del recibo en una pestaña nueva.
 */

type Entidad = { id: string; codigo: string | null; nombre: string; tipo: string | null };

type ClienteHit = {
  id: string;
  display: string;
  ruc: string | null;
};

type Cuenta = {
  id: string;
  numero: string;
  fecha_vencimiento: string | null;
  total: number;
  saldo: number;
};

type Seleccion = {
  checked: boolean;
  importe: string; // texto libre para no fastidiar el input
};

const METODOS = ["efectivo", "transferencia", "tarjeta", "otro"] as const;
const METODO_LABEL: Record<string, string> = {
  efectivo: "Efectivo",
  transferencia: "Transferencia",
  tarjeta: "Tarjeta",
  otro: "Otro",
};

function fmtGs(n: number) {
  return "Gs. " + Math.round(Number(n) || 0).toLocaleString("es-PY");
}
function fmtFecha(iso: string | null): string {
  if (!iso) return "—";
  const s = String(iso).slice(0, 10);
  const [y, m, d] = s.split("-");
  return d && m && y ? `${d}/${m}/${y}` : s;
}
function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export function CobrarMultipleModal({
  open,
  onClose,
  onExito,
  clienteInicial,
}: {
  open: boolean;
  onClose: () => void;
  onExito: () => void | Promise<void>;
  /** Si el operador arranca desde una fila del listado, precargamos el cliente. */
  clienteInicial?: { id: string; display: string; ruc?: string | null } | null;
}) {
  // Cliente
  const [clienteSel, setClienteSel] = useState<ClienteHit | null>(null);
  const [busquedaCli, setBusquedaCli] = useState("");
  const [clientesHits, setClientesHits] = useState<ClienteHit[]>([]);
  const [buscandoCli, setBuscandoCli] = useState(false);

  // Cuentas pendientes del cliente
  const [cuentas, setCuentas] = useState<Cuenta[]>([]);
  const [cargandoCuentas, setCargandoCuentas] = useState(false);
  const [sel, setSel] = useState<Record<string, Seleccion>>({});

  // Pago
  const [metodo, setMetodo] = useState<(typeof METODOS)[number]>("efectivo");
  const [entidades, setEntidades] = useState<Entidad[]>([]);
  const [entidadId, setEntidadId] = useState("");
  const [referencia, setReferencia] = useState("");
  const [titular, setTitular] = useState("");
  const [observaciones, setObservaciones] = useState("");

  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset al abrir. Depende SOLO de open + cliente inicial id, para no dispararse
  // en cada render del padre.
  const cliInicialId = clienteInicial?.id ?? null;
  useEffect(() => {
    if (!open) return;
    setError(null);
    setMetodo("efectivo");
    setEntidadId("");
    setReferencia("");
    setTitular("");
    setObservaciones("");
    setCuentas([]);
    setSel({});
    setClientesHits([]);
    setBusquedaCli("");
    if (clienteInicial) {
      setClienteSel({
        id: clienteInicial.id,
        display: clienteInicial.display,
        ruc: clienteInicial.ruc ?? null,
      });
    } else {
      setClienteSel(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cliInicialId]);

  // Entidades bancarias (para transferencia/tarjeta).
  useEffect(() => {
    if (!open) return;
    fetchWithSupabaseSession("/api/entidades-bancarias", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (j?.success && Array.isArray(j.data?.entidades)) {
          setEntidades(j.data.entidades as Entidad[]);
        }
      })
      .catch(() => {});
  }, [open]);

  // Buscador de clientes (debounce liviano).
  useEffect(() => {
    if (!open) return;
    if (clienteSel) return; // ya elegido: no busca
    const q = busquedaCli.trim();
    if (q.length < 2) {
      setClientesHits([]);
      return;
    }
    let cancel = false;
    setBuscandoCli(true);
    const t = window.setTimeout(async () => {
      try {
        const res = await fetchWithSupabaseSession(
          `/api/clientes?limit=15&q=${encodeURIComponent(q)}`,
          { cache: "no-store" }
        );
        const body = await res.json();
        if (cancel) return;
        const rows = (body?.data?.clientes ?? body?.data ?? []) as Array<Record<string, unknown>>;
        const hits: ClienteHit[] = rows.slice(0, 15).map((r) => {
          const nombre =
            (typeof r.empresa === "string" && r.empresa.trim()) ||
            (typeof r.nombre_contacto === "string" && r.nombre_contacto.trim()) ||
            (typeof r.nombre === "string" && r.nombre.trim()) ||
            "Cliente";
          const ruc = typeof r.ruc === "string" && r.ruc.trim() ? r.ruc.trim() : null;
          return { id: String(r.id ?? ""), display: nombre, ruc };
        });
        setClientesHits(hits.filter((h) => h.id));
      } catch {
        if (!cancel) setClientesHits([]);
      } finally {
        if (!cancel) setBuscandoCli(false);
      }
    }, 250);
    return () => {
      cancel = true;
      window.clearTimeout(t);
    };
  }, [busquedaCli, open, clienteSel]);

  // Cargar cuentas del cliente elegido.
  const cargarCuentas = useCallback(async (clienteId: string) => {
    setCargandoCuentas(true);
    setError(null);
    try {
      const res = await fetchWithSupabaseSession(
        `/api/cobros/con-recibo?cliente_id=${encodeURIComponent(clienteId)}`,
        { cache: "no-store" }
      );
      const body = await res.json();
      if (!res.ok || body?.success === false) {
        setError(body?.error ?? "No se pudieron cargar las cuentas del cliente.");
        setCuentas([]);
        return;
      }
      const rows = (body.data?.cuentas ?? []) as Cuenta[];
      setCuentas(rows);
      // Preseleccionar todas con importe = saldo. Facil de destildar despues.
      const inicial: Record<string, Seleccion> = {};
      for (const c of rows) inicial[c.id] = { checked: true, importe: String(c.saldo) };
      setSel(inicial);
    } catch {
      setError("Error de red al cargar cuentas.");
      setCuentas([]);
    } finally {
      setCargandoCuentas(false);
    }
  }, []);

  useEffect(() => {
    if (!open || !clienteSel) return;
    void cargarCuentas(clienteSel.id);
  }, [open, clienteSel, cargarCuentas]);

  const totalCobrar = useMemo(() => {
    let s = 0;
    for (const c of cuentas) {
      const sl = sel[c.id];
      if (sl?.checked) s += Number(sl.importe) || 0;
    }
    return round2(s);
  }, [cuentas, sel]);

  const cantidadFacturas = useMemo(
    () => cuentas.reduce((n, c) => (sel[c.id]?.checked ? n + 1 : n), 0),
    [cuentas, sel]
  );

  if (!open) return null;

  const pideBanco = metodo === "transferencia" || metodo === "tarjeta";
  const entidadesFiltradas = entidades.filter((e) => {
    if (metodo === "transferencia") return e.tipo === "banco" || e.tipo === "billetera" || e.tipo == null;
    if (metodo === "tarjeta") return e.tipo === "tarjeta" || e.tipo === "banco" || e.tipo == null;
    return true;
  });

  function actualizarSel(id: string, patch: Partial<Seleccion>) {
    setSel((prev) => ({ ...prev, [id]: { ...(prev[id] ?? { checked: false, importe: "0" }), ...patch } }));
  }
  function ponerImporteSaldo(c: Cuenta) {
    actualizarSel(c.id, { checked: true, importe: String(c.saldo) });
  }
  function tildarTodas() {
    const next: Record<string, Seleccion> = {};
    for (const c of cuentas) next[c.id] = { checked: true, importe: String(c.saldo) };
    setSel(next);
  }
  function destildarTodas() {
    const next: Record<string, Seleccion> = {};
    for (const c of cuentas) next[c.id] = { checked: false, importe: "0" };
    setSel(next);
  }

  async function confirmar() {
    if (!clienteSel || guardando) return;
    setError(null);

    // Validaciones locales.
    const aplicaciones: Array<{ cuenta_por_cobrar_id: string; importe: number }> = [];
    for (const c of cuentas) {
      const sl = sel[c.id];
      if (!sl?.checked) continue;
      const imp = Number(sl.importe);
      if (!(imp > 0)) {
        setError(`Ingresa un importe > 0 para la factura ${c.numero}.`);
        return;
      }
      if (imp > c.saldo + 0.001) {
        setError(`El importe de ${c.numero} (${fmtGs(imp)}) supera su saldo (${fmtGs(c.saldo)}).`);
        return;
      }
      aplicaciones.push({ cuenta_por_cobrar_id: c.id, importe: round2(imp) });
    }
    if (aplicaciones.length === 0) {
      setError("Marca al menos una factura y poné un importe > 0.");
      return;
    }
    if (pideBanco && !entidadId) {
      setError(`Elegí ${metodo === "tarjeta" ? "la procesadora / banco" : "la entidad bancaria"}.`);
      return;
    }
    if (pideBanco && !referencia.trim()) {
      setError("Ingresá la referencia / nº de operación.");
      return;
    }

    // La pestaña del PDF se abre AHORA en el gesto del usuario, para que el
    // bloqueador de pop-ups no la mate (mismo patron que generarYAbrirRecibo).
    // Sin 'noopener' — con ese flag Chrome/Firefox devuelven null y perdemos
    // la referencia para navegarla despues (queda un about:blank huerfano).
    const tab = typeof window !== "undefined" ? window.open("about:blank", "_blank") : null;
    const cerrarTab = () => { try { tab?.close(); } catch { /* ya cerrada */ } };

    setGuardando(true);
    try {
      const res = await fetchWithSupabaseSession("/api/cobros/con-recibo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cliente_id: clienteSel.id,
          aplicaciones,
          metodo_pago: metodo,
          entidad_bancaria_id: pideBanco ? (entidadId || null) : null,
          referencia: referencia.trim() || null,
          observaciones: observaciones.trim() || null,
        }),
      });
      const body = await res.json();
      if (!res.ok || body?.success === false) {
        cerrarTab();
        setError(body?.error ?? "No se pudo registrar el cobro.");
        return;
      }
      const reciboId = body?.data?.recibo_id ? String(body.data.recibo_id) : null;
      const url = reciboId ? `/api/recibos-dinero/${reciboId}/pdf?auto=1` : null;
      if (tab && !tab.closed && url) {
        tab.location.href = url;
      } else if (url) {
        try { window.open(url, "_blank"); } catch { /* bloqueado */ }
      }
      await onExito();
      onClose();
    } catch {
      cerrarTab();
      setError("Error de red al registrar el cobro.");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4">
      <div className="w-full sm:max-w-2xl max-h-[95vh] flex flex-col rounded-t-2xl sm:rounded-xl bg-white shadow-xl">
        <div className="border-b border-slate-200 px-5 py-4 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-gray-900">Nuevo cobro múltiple</h3>
            <p className="text-xs text-gray-500">
              Cobrá varias facturas de un mismo cliente en un solo movimiento y emití un recibo (REC-…).
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100"
            aria-label="Cerrar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-4 space-y-4">
          {error && (
            <div className="rounded-md bg-red-50 border border-red-200 p-2.5 text-sm text-red-700">{error}</div>
          )}

          {/* Cliente */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Cliente</label>
            {clienteSel ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
                <div>
                  <div className="font-medium text-slate-800">{clienteSel.display}</div>
                  {clienteSel.ruc ? <div className="text-xs text-slate-500 font-mono">RUC {clienteSel.ruc}</div> : null}
                </div>
                <button
                  type="button"
                  onClick={() => { setClienteSel(null); setCuentas([]); setSel({}); }}
                  className="text-xs text-[#4FAEB2] font-semibold hover:underline"
                >
                  Cambiar
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                  <input
                    type="text"
                    value={busquedaCli}
                    onChange={(e) => setBusquedaCli(e.target.value)}
                    placeholder="Buscar por nombre o RUC…"
                    className="w-full rounded-md border border-slate-300 pl-9 pr-3 py-2 text-sm"
                    autoFocus
                  />
                </div>
                {buscandoCli && (
                  <div className="text-xs text-slate-500 flex items-center gap-1.5">
                    <Loader2 className="h-3 w-3 animate-spin" /> Buscando…
                  </div>
                )}
                {!buscandoCli && clientesHits.length > 0 && (
                  <div className="rounded-md border border-slate-200 divide-y divide-slate-100 max-h-56 overflow-y-auto">
                    {clientesHits.map((h) => (
                      <button
                        key={h.id}
                        type="button"
                        onClick={() => setClienteSel(h)}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50"
                      >
                        <div className="font-medium text-slate-800">{h.display}</div>
                        {h.ruc && <div className="text-xs text-slate-500 font-mono">RUC {h.ruc}</div>}
                      </button>
                    ))}
                  </div>
                )}
                {!buscandoCli && busquedaCli.trim().length >= 2 && clientesHits.length === 0 && (
                  <div className="text-xs text-slate-500">Sin resultados.</div>
                )}
              </div>
            )}
          </div>

          {/* Cuentas del cliente */}
          {clienteSel && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-xs font-medium text-gray-600">Facturas pendientes</label>
                {cuentas.length > 0 && (
                  <div className="flex items-center gap-2 text-[11px]">
                    <button type="button" onClick={tildarTodas} className="text-[#4FAEB2] font-semibold hover:underline">Tildar todas</button>
                    <span className="text-slate-300">·</span>
                    <button type="button" onClick={destildarTodas} className="text-slate-500 hover:underline">Ninguna</button>
                  </div>
                )}
              </div>
              {cargandoCuentas ? (
                <div className="rounded-md border border-slate-200 px-3 py-6 text-center text-xs text-slate-500">
                  <Loader2 className="inline h-4 w-4 animate-spin mr-1" /> Cargando cuentas…
                </div>
              ) : cuentas.length === 0 ? (
                <div className="rounded-md border border-slate-200 px-3 py-6 text-center text-xs text-slate-500">
                  Este cliente no tiene cuentas pendientes.
                </div>
              ) : (
                <div className="overflow-x-auto rounded-md border border-slate-200">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-[11px] uppercase text-slate-500">
                      <tr>
                        <th className="py-2 px-2 text-left w-6"></th>
                        <th className="py-2 px-2 text-left">Nº</th>
                        <th className="py-2 px-2 text-left">Vence</th>
                        <th className="py-2 px-2 text-right">Saldo</th>
                        <th className="py-2 px-2 text-right">Importe a cobrar</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {cuentas.map((c) => {
                        const s = sel[c.id] ?? { checked: false, importe: "0" };
                        return (
                          <tr key={c.id} className={s.checked ? "bg-emerald-50/40" : "hover:bg-slate-50"}>
                            <td className="py-2 px-2">
                              <input
                                type="checkbox"
                                checked={s.checked}
                                onChange={(e) => actualizarSel(c.id, {
                                  checked: e.target.checked,
                                  importe: e.target.checked ? String(c.saldo) : "0",
                                })}
                              />
                            </td>
                            <td className="py-2 px-2 font-mono text-xs">{c.numero}</td>
                            <td className="py-2 px-2 text-xs text-slate-600">{fmtFecha(c.fecha_vencimiento)}</td>
                            <td className="py-2 px-2 text-right tabular-nums">{fmtGs(c.saldo)}</td>
                            <td className="py-2 px-2 text-right">
                              <div className="inline-flex items-center gap-1">
                                <input
                                  type="number"
                                  min="0"
                                  step="1"
                                  value={s.importe}
                                  disabled={!s.checked}
                                  onChange={(e) => actualizarSel(c.id, { importe: e.target.value })}
                                  className="w-28 rounded border border-slate-300 px-2 py-1 text-right text-sm disabled:bg-slate-100 disabled:text-slate-400"
                                />
                                <button
                                  type="button"
                                  onClick={() => ponerImporteSaldo(c)}
                                  className="text-[10px] text-[#4FAEB2] font-semibold hover:underline"
                                  title="Poner saldo total"
                                >
                                  Max
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="bg-slate-50 border-t border-slate-200">
                        <td colSpan={3} className="py-2 px-2 text-xs text-slate-600">
                          {cantidadFacturas} factura{cantidadFacturas === 1 ? "" : "s"} seleccionada{cantidadFacturas === 1 ? "" : "s"}
                        </td>
                        <td className="py-2 px-2 text-right text-xs text-slate-500">Total a cobrar</td>
                        <td className="py-2 px-2 text-right font-bold text-base text-slate-800 tabular-nums">{fmtGs(totalCobrar)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Metodo de pago */}
          {clienteSel && cuentas.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Método de pago</label>
                <select
                  value={metodo}
                  onChange={(e) => setMetodo(e.target.value as (typeof METODOS)[number])}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm bg-white"
                >
                  {METODOS.map((m) => <option key={m} value={m}>{METODO_LABEL[m]}</option>)}
                </select>
              </div>
              {pideBanco && (
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    {metodo === "tarjeta" ? "Procesadora / Banco" : "Entidad bancaria"} *
                  </label>
                  <select
                    value={entidadId}
                    onChange={(e) => setEntidadId(e.target.value)}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm bg-white"
                  >
                    <option value="">— Elegí —</option>
                    {entidadesFiltradas.map((e) => <option key={e.id} value={e.id}>{e.nombre}</option>)}
                  </select>
                </div>
              )}
              <div className={pideBanco ? "sm:col-span-2" : ""}>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Referencia{pideBanco ? " *" : " (opcional)"}
                </label>
                <input
                  value={referencia}
                  onChange={(e) => setReferencia(e.target.value)}
                  placeholder="Nº comprobante, transferencia…"
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
              {pideBanco && (
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-gray-600 mb-1">Titular (opcional)</label>
                  <input
                    value={titular}
                    onChange={(e) => setTitular(e.target.value)}
                    placeholder="Titular de la cuenta/tarjeta"
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>
              )}
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-gray-600 mb-1">Observaciones (opcional)</label>
                <input
                  value={observaciones}
                  onChange={(e) => setObservaciones(e.target.value)}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 border-t border-slate-200 px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={confirmar}
            disabled={guardando || !clienteSel || totalCobrar <= 0}
            className="inline-flex items-center justify-center gap-1.5 rounded-md bg-[#4FAEB2] px-5 py-2 text-sm font-medium text-white hover:bg-[#3F8E91] disabled:opacity-50"
          >
            {guardando ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Guardando…
              </>
            ) : (
              <>Cobrar {fmtGs(totalCobrar)} y generar recibo</>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
