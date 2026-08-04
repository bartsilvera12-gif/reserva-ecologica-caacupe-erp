"use client";

import { useEffect, useState } from "react";
import PageHeader from "@/components/ui/PageHeader";
import { ReportCard } from "@/components/reportes/ReportCard";
import { Wallet, Truck, Package, ShoppingCart, ArrowLeftRight, TrendingDown, PackageX, Banknote, ClipboardList } from "lucide-react";

/** Hub de reportería operativa (Fase 1: Estado de cuenta + Proveedores). */
export default function ReportesPage() {
  // La tarjeta de Caja solo se muestra en sucursales que operan caja.
  const [manejaCaja, setManejaCaja] = useState(true);
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/usuarios/me", { credentials: "include", cache: "no-store" });
        const j = await r.json();
        setManejaCaja(j?.usuario?.sucursal_maneja_caja !== false);
      } catch { /* por defecto se muestra */ }
    })();
  }, []);
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Zentra · Análisis"
        title="Reportes"
        description="Panel de análisis y reportería operativa"
      />

      <ul className="m-0 grid list-none gap-4 p-0 sm:grid-cols-2 xl:grid-cols-3">
        <li>
          <ReportCard
            title="Estado de cuenta"
            subtitle="Saldos, movimientos y situación financiera"
            icon={Wallet}
            description="Resumen de ventas, compras, gastos y resultado del período, con sus movimientos."
            href="/reportes/estado-cuenta"
          />
        </li>
        <li>
          <ReportCard
            title="Ventas"
            subtitle="Facturación y operaciones"
            icon={ShoppingCart}
            description="Ventas del mes, desglose por tipo de precio (minorista/mayorista/al costo) y por producto."
            href="/reportes/ventas"
          />
        </li>
        <li>
          <ReportCard
            title="Compras"
            subtitle="Adquisiciones y costos"
            icon={Package}
            description="Compras del mes (agrupadas por N° de control), por proveedor y por producto."
            href="/reportes/compras"
          />
        </li>
        <li>
          <ReportCard
            title="Proveedores"
            subtitle="Abastecimiento y relación comercial"
            icon={Truck}
            description="Resumen de proveedores, compras por proveedor y actividad del mes."
            href="/reportes/proveedores"
          />
        </li>
        <li>
          <ReportCard
            title="Conciliación bancaria"
            subtitle="Cobros por método y entidad"
            icon={ArrowLeftRight}
            description="Detalle de cobro por venta (efectivo/transferencia/tarjeta), por método y por entidad."
            href="/reportes/conciliacion"
          />
        </li>
        {manejaCaja && (
          <li>
            <ReportCard
              title="Caja y arqueo"
              subtitle="Apertura, movimientos y cierre por turno"
              icon={Banknote}
              description="Abrí y cerrá la caja de tu sucursal, registrá movimientos (ingreso/egreso/retiro/ajuste) y controlá el arqueo: efectivo esperado vs. contado."
              href="/caja"
            />
          </li>
        )}
        {manejaCaja && (
          <li>
            <ReportCard
              title="Cierres de caja"
              subtitle="Arqueo de turnos por rango de fechas"
              icon={ClipboardList}
              description="Detalle de turnos: apertura, cierre, vendido, efectivo esperado vs. contado y diferencias. Con totales del período y exportación a Excel."
              href="/reportes/cajas"
            />
          </li>
        )}
        <li>
          <ReportCard
            title="Proyección de inventario"
            subtitle="Cobertura y quiebre de stock"
            icon={TrendingDown}
            description="Días de cobertura y fecha estimada de quiebre por producto, según el consumo de los últimos 30 días."
            href="/reportes/proyeccion-inventario"
          />
        </li>
        <li>
          <ReportCard
            title="Inventario crítico"
            subtitle="Productos bajo el mínimo"
            icon={PackageX}
            description="Listado completo de productos de tu sucursal con stock igual o por debajo del mínimo."
            href="/reportes/inventario-critico"
          />
        </li>
      </ul>
    </div>
  );
}
