import { Suspense } from "react";
import { getCurrentUserDisplayNameServer } from "@/lib/auth/get-current-user-display-name-server";
import { getChatDataSchemaForCurrentUser } from "@/lib/chat/empresa-chat-schema-server";
import { getMyAgentOperationalPresence } from "@/lib/chat/chat-ops-actions";
import { ConversacionesClient, type ConversacionesInitialOperationalPresence } from "./ConversacionesClient";

export default async function ConversacionesInboxPage() {
  let chatDataSchema = "zentra_erp";
  try {
    chatDataSchema = await getChatDataSchemaForCurrentUser();
  } catch (e) {
    console.error("[dashboard/conversaciones] getChatDataSchemaForCurrentUser", e);
  }

  const [agentDisplayName, presence] = await Promise.all([
    getCurrentUserDisplayNameServer().catch((e) => {
      console.error("[dashboard/conversaciones] getCurrentUserDisplayNameServer", e);
      return "Usuario";
    }),
    getMyAgentOperationalPresence().catch((e) => {
      console.error("[dashboard/conversaciones] getMyAgentOperationalPresence", e);
      return null;
    }),
  ]);

  let initialOperationalPresence: ConversacionesInitialOperationalPresence | undefined;
  if (presence) {
    initialOperationalPresence = presence.in_queues
      ? { in_queues: true, status: presence.status }
      : { in_queues: false, status: null };
  }

  return (
    <Suspense fallback={<div className="p-6 text-slate-400 text-sm animate-pulse">Cargando conversaciones…</div>}>
      <ConversacionesClient
        mode="inbox"
        chatDataSchema={chatDataSchema}
        agentDisplayName={agentDisplayName}
        initialOperationalPresence={initialOperationalPresence}
      />
    </Suspense>
  );
}
