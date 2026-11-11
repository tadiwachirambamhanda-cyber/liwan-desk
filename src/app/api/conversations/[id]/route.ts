// Read one simulator conversation back: the chat, the panel for each message, and the hand-overs.
// Only for the phone page's own conversations (a long random id), never WhatsApp ones.

import { closedResponse, simulatorRoutesAreOpen, unavailableResponse } from "@/lib/gate";
import { loadHistory } from "@/lib/memory";

export async function GET(_request: Request, ctx: RouteContext<"/api/conversations/[id]">) {
  if (!simulatorRoutesAreOpen()) return closedResponse();
  const { id } = await ctx.params;
  try {
    return Response.json(await loadHistory(id));
  } catch (err) {
    console.error("[memory] could not load a conversation:", err instanceof Error ? err.name : "unknown");
    return unavailableResponse();
  }
}
