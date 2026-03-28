import Link from "next/link";
import { fetchSorteoCuponesOrdenesServer } from "@/lib/sorteos/server-queries";

export const dynamic = "force-dynamic";

function formatGs(n: number) {
  return `${n.toLocaleString("es-PY")} ₲`;
}

function formatFecha(iso: string) {
  try {
    return new Date(iso).toLocaleString("es-PY", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function estadoLabel(e: string) {
  if (e === "pendiente_revision") return "Pendiente revisión";
  if (e === "pendiente") return "Pendiente";
  if (e === "confirmado") return "Confirmado";
  if (e === "rechazado") return "Rechazado";
  return e;
}

export default async function SorteoCuponesPage() {
  const { data: rows, error: queryError } = await fetchSorteoCuponesOrdenesServer();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-800">Cupones</h1>
        <p className="text-gray-500 text-sm mt-1">Órdenes con números de cupón generados</p>
      </div>

      <nav className="flex flex-wrap gap-2 text-sm border-b border-slate-200 pb-3">
        <Link href="/sorteos" className="text-slate-600 hover:text-[#0EA5E9]">
          Sorteos
        </Link>
        <Link href="/sorteos/entradas" className="text-slate-600 hover:text-[#0EA5E9]">
          Entradas
        </Link>
        <span className="font-semibold text-[#0EA5E9]">Cupones</span>
      </nav>

      {queryError ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <strong>Error al cargar cupones:</strong> {queryError}
        </div>
      ) : null}

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
        {rows.length === 0 && !queryError ? (
          <div className="py-16 text-center text-gray-400 text-sm">No hay órdenes con cupones</div>
        ) : rows.length === 0 ? null : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px]">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50">
                  <th className="text-left text-sm font-semibold text-slate-600 px-5 py-3">Nº orden</th>
                  <th className="text-left text-sm font-semibold text-slate-600 px-5 py-3">Sorteo</th>
                  <th className="text-left text-sm font-semibold text-slate-600 px-5 py-3">Cliente</th>
                  <th className="text-left text-sm font-semibold text-slate-600 px-5 py-3">Teléfono</th>
                  <th className="text-left text-sm font-semibold text-slate-600 px-5 py-3">Cantidad</th>
                  <th className="text-right text-sm font-semibold text-slate-600 px-5 py-3">Monto</th>
                  <th className="text-left text-sm font-semibold text-slate-600 px-5 py-3">Cupones</th>
                  <th className="text-left text-sm font-semibold text-slate-600 px-5 py-3">Pago</th>
                  <th className="text-left text-sm font-semibold text-slate-600 px-5 py-3">Fecha</th>
                  <th className="text-left text-sm font-semibold text-slate-600 px-5 py-3">Chat</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {rows.map((r) => (
                  <tr key={r.entrada_id} className="hover:bg-slate-50/80">
                    <td className="px-5 py-3 text-sm font-mono font-semibold text-slate-800">{r.numero_orden}</td>
                    <td className="px-5 py-3 text-sm text-slate-800">{r.sorteo_nombre}</td>
                    <td className="px-5 py-3 text-sm text-slate-800">{r.nombre_participante}</td>
                    <td className="px-5 py-3 text-sm font-mono text-slate-700">{r.whatsapp_numero}</td>
                    <td className="px-5 py-3 text-sm text-slate-800">{r.cantidad_boletos}</td>
                    <td className="px-5 py-3 text-sm text-right tabular-nums text-slate-800">
                      {formatGs(r.monto_total)}
                      {r.promo_nombre ? (
                        <div className="text-[11px] font-normal text-slate-500 mt-0.5">{r.promo_nombre}</div>
                      ) : null}
                    </td>
                    <td className="px-5 py-3 text-sm font-mono text-slate-800">{r.numeros_cupon.join(", ")}</td>
                    <td className="px-5 py-3 text-sm text-slate-700">{estadoLabel(r.estado_pago)}</td>
                    <td className="px-5 py-3 text-sm text-slate-600 whitespace-nowrap">{formatFecha(r.created_at)}</td>
                    <td className="px-5 py-3 text-sm">
                      {r.chat_conversation_id ? (
                        <Link
                          href={`/dashboard/conversaciones?conversationId=${encodeURIComponent(r.chat_conversation_id)}`}
                          className="text-[#0EA5E9] hover:underline"
                        >
                          Abrir
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
