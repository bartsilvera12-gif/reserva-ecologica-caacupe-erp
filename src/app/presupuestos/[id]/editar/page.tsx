"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import { type IvaTipoPresupuesto } from "@/lib/presupuestos/types";
import PresupuestoForm, { type PresupuestoFormInitial } from "@/components/presupuestos/PresupuestoForm";

function asIva(v: unknown): IvaTipoPresupuesto {
  return v === "EXENTA" || v === "5%" || v === "10%" ? v : "10%";
}

export default function EditarPresupuestoPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [initial, setInitial] = useState<PresupuestoFormInitial | null>(null);
  const [numero, setNumero] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetchWithSupabaseSession(`/api/presupuestos/${id}`, { cache: "no-store" });
        const body = await res.json();
        if (!res.ok || body?.success === false) {
          if (!cancel) setError(body?.error ?? "No se pudo cargar el presupuesto.");
          return;
        }
        const p = body.data.presupuesto as Record<string, unknown>;
        if (p.estado === "convertido" || p.convertido_pedido_id || p.convertido_venta_id) {
          if (!cancel) setError("Este presupuesto ya fue convertido o facturado; no se puede editar.");
          return;
        }
        const itemsRaw = (body.data.items ?? []) as Record<string, unknown>[];
        if (cancel) return;
        setNumero(String(p.numero_control ?? ""));
        setInitial({
          cliente_id: p.cliente_id ? String(p.cliente_id) : "",
          cliente_nombre: String(p.cliente_nombre ?? ""),
          cliente_ruc: p.cliente_ruc ? String(p.cliente_ruc) : "",
          cliente_telefono: p.cliente_telefono ? String(p.cliente_telefono) : "",
          cliente_direccion: p.cliente_direccion ? String(p.cliente_direccion) : "",
          validez_dias: p.validez_dias != null ? String(p.validez_dias) : "",
          forma_pago: p.forma_pago ? String(p.forma_pago) : "",
          plazo_entrega: p.plazo_entrega ? String(p.plazo_entrega) : "",
          fecha_entrega: p.fecha_entrega ? String(p.fecha_entrega) : "",
          observaciones: p.observaciones ? String(p.observaciones) : "",
          items: itemsRaw.map((it) => ({
            producto_id: it.producto_id ? String(it.producto_id) : null,
            producto_nombre: String(it.producto_nombre ?? ""),
            sku: it.sku ? String(it.sku) : null,
            cantidad: Number(it.cantidad) || 0,
            unidad_medida: it.unidad_medida ? String(it.unidad_medida) : null,
            precio_unitario: Number(it.precio_unitario) || 0,
            iva_tipo: asIva(it.iva_tipo),
            descuento: Number(it.descuento) || 0,
          })),
        });
      } catch {
        if (!cancel) setError("Error de red al cargar el presupuesto.");
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => { cancel = true; };
  }, [id]);

  if (loading) {
    return <div className="p-6 flex items-center gap-2 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> Cargando…</div>;
  }
  if (error || !initial) {
    return (
      <div className="p-6 space-y-3">
        <div className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700">{error ?? "Presupuesto no encontrado"}</div>
        <Link href={`/presupuestos/${id}`} className="text-sm text-[#4FAEB2] hover:underline">Volver al presupuesto</Link>
      </div>
    );
  }

  return (
    <PresupuestoForm
      mode="editar"
      presupuestoId={id}
      initial={initial}
      title={numero ? `Editar ${numero}` : "Editar presupuesto"}
      submitLabel="Guardar cambios"
      cancelHref={`/presupuestos/${id}`}
    />
  );
}
