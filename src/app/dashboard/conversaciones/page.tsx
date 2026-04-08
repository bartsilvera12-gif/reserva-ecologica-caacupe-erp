import { Suspense } from "react";
import { ConversacionesClient } from "./ConversacionesClient";

export default function ConversacionesInboxPage() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-400 text-sm animate-pulse">Cargando conversaciones…</div>}>
      <ConversacionesClient mode="inbox" />
    </Suspense>
  );
}
