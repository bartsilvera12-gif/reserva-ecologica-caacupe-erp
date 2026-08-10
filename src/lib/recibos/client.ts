import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";

type GenerarReciboInput =
  | { origen: "venta_contado"; venta_id: string }
  | { origen: "cobro_cxc"; cobro_cliente_id: string };

/**
 * Genera (o reutiliza si ya existe) un recibo de dinero y abre su documento imprimible.
 * Idempotente: si ya hay recibo para esa venta/cobro, se reimprime el mismo.
 * Devuelve true si se abrió OK, o un mensaje de error.
 */
export async function generarYAbrirRecibo(input: GenerarReciboInput): Promise<{ ok: boolean; error?: string }> {
  // La pestaña se abre AHORA, dentro del gesto del usuario. Si se abriera
  // después del await, el navegador ya no la asocia al clic y el bloqueador de
  // pop-ups la descarta — por eso antes había que apretar el botón dos veces.
  // Se abre en blanco y se le carga el PDF cuando llega el id.
  const tab = typeof window !== "undefined" ? window.open("", "_blank", "noopener") : null;
  const cerrarTab = () => { try { tab?.close(); } catch { /* ya cerrada */ } };
  try {
    const res = await fetchWithSupabaseSession("/api/recibos-dinero", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const body = await res.json();
    if (!res.ok || body?.success === false || !body?.data?.recibo?.id) {
      cerrarTab();
      return { ok: false, error: body?.error ?? "No se pudo generar el recibo." };
    }
    const id = String(body.data.recibo.id);
    const url = `/api/recibos-dinero/${id}/pdf?auto=1`;
    if (tab && !tab.closed) {
      tab.location.href = url;
    } else {
      // El bloqueador impidió la pestaña: se intenta igual (algunos navegadores
      // la permiten) y si no, al menos el recibo quedó creado.
      try { window.open(url, "_blank", "noopener"); } catch { /* bloqueado */ }
    }
    return { ok: true };
  } catch {
    cerrarTab();
    return { ok: false, error: "Error de red al generar el recibo." };
  }
}
