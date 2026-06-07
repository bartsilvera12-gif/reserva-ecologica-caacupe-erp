import type { EstadoCuentaReporte, ProveedoresReporte, ComprasReporte } from "./types";

async function getReporte<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { credentials: "include", cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j?.success) return null;
    return j.data as T;
  } catch (e) {
    console.error("[reportes] getReporte:", e);
    return null;
  }
}

const mq = (mes: string) => encodeURIComponent(mes);

export const getEstadoCuentaReporte = (mes: string) =>
  getReporte<EstadoCuentaReporte>(`/api/reportes/estado-cuenta?mes=${mq(mes)}`);
export const getProveedoresReporte = (mes: string) =>
  getReporte<ProveedoresReporte>(`/api/reportes/proveedores?mes=${mq(mes)}`);
export const getComprasReporte = (mes: string) =>
  getReporte<ComprasReporte>(`/api/reportes/compras?mes=${mq(mes)}`);
