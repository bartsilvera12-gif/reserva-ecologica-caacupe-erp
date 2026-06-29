"use client";

/**
 * Tabla de rentabilidad por canal de venta (Minorista / Mayorista / Distribuidor).
 * Para cada precio cargado muestra el markup sobre costo y el margen sobre venta,
 * resaltando en rojo los canales que venderían por debajo del costo.
 *
 * Solo presentación + cálculo en tiempo real; no toca datos ni el formulario.
 */

type CanalInput = {
  label: string;
  /** Precio del canal en Gs. (string del form o number). Vacío/0/NaN => se omite. */
  precio: string | number | null | undefined;
};

type FilaCanal = {
  label: string;
  precio: number;
  markup: number; // (precio - costo) / costo * 100
  margen: number; // (precio - costo) / precio * 100
  perdida: boolean;
};

function aNumero(v: string | number | null | undefined): number {
  if (v === null || v === undefined || v === "") return NaN;
  return typeof v === "number" ? v : parseFloat(v);
}

export function MargenPorCanal({
  costo: costoRaw,
  canales,
}: {
  costo: string | number;
  canales: CanalInput[];
}) {
  const costo = aNumero(costoRaw);
  if (isNaN(costo) || costo <= 0) return null;

  const filas: FilaCanal[] = canales
    .map((c) => {
      const precio = aNumero(c.precio);
      if (isNaN(precio) || precio <= 0) return null;
      const markup = ((precio - costo) / costo) * 100;
      const margen = ((precio - costo) / precio) * 100;
      return { label: c.label, precio, markup, margen, perdida: markup < 0 };
    })
    .filter((f): f is FilaCanal => f !== null);

  if (filas.length === 0) return null;

  const hayPerdida = filas.some((f) => f.perdida);
  const fmtGs = (n: number) => "Gs. " + Math.round(n).toLocaleString("es-PY");

  return (
    <div className="mt-4 space-y-3">
      {hayPerdida && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-xs text-red-600">
          <span className="mt-0.5 text-base leading-none">⚠</span>
          <span>
            Uno o más canales tienen un precio <strong>menor al costo</strong>. Esas ventas generarían pérdida neta.
          </span>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2 font-semibold">Canal</th>
              <th className="px-4 py-2 font-semibold text-right">Precio</th>
              <th className="px-4 py-2 font-semibold text-right">Markup s/costo</th>
              <th className="px-4 py-2 font-semibold text-right">Margen s/venta</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filas.map((f) => (
              <tr key={f.label} className={f.perdida ? "bg-red-50/60" : ""}>
                <td className="px-4 py-2 font-medium text-slate-700">{f.label}</td>
                <td className="px-4 py-2 text-right tabular-nums text-slate-600">{fmtGs(f.precio)}</td>
                <td
                  className={`px-4 py-2 text-right tabular-nums font-semibold ${
                    f.perdida ? "text-red-600" : "text-blue-700"
                  }`}
                >
                  {f.markup.toFixed(2)}%
                </td>
                <td
                  className={`px-4 py-2 text-right tabular-nums font-semibold ${
                    f.perdida ? "text-red-600" : "text-green-700"
                  }`}
                >
                  {f.margen.toFixed(2)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-400">
        Markup = (precio − costo) / costo · Margen s/venta = (precio − costo) / precio. El costo es el costo promedio de adquisición.
      </p>
    </div>
  );
}
