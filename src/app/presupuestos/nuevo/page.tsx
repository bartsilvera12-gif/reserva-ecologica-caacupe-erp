"use client";

import PresupuestoForm from "@/components/presupuestos/PresupuestoForm";

export default function NuevoPresupuestoPage() {
  return (
    <PresupuestoForm
      mode="crear"
      title="Nuevo presupuesto"
      submitLabel="Guardar presupuesto"
      cancelHref="/presupuestos"
    />
  );
}
