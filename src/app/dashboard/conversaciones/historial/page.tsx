import { Suspense } from "react";
import { ConversacionesClient } from "../ConversacionesClient";

export default function ConversacionesHistorialPage() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-400 text-sm animate-pulse">Cargando historial…</div>}>
      <ConversacionesClient mode="historial" />
    </Suspense>
  );
}
