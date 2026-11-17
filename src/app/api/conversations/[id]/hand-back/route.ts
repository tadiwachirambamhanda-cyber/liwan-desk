// Give a simulator conversation back to the agent: status goes back to "bot" and its
// open hand-overs are resolved, together.

import { closedResponse, simulatorRoutesAreOpen, unavailableResponse } from "@/lib/gate";
import { handBack } from "@/lib/memory";

export async function POST(_request: Request, ctx: RouteContext<"/api/conversations/[id]/hand-back">) {
  if (!simulatorRoutesAreOpen()) return closedResponse();
  const { id } = await ctx.params;
  try {
    return (await handBack(id)) ? Response.json({ ok: true }) : closedResponse();
  } catch (err) {
    console.error("[memory] could not hand back:", err instanceof Error ? err.name : "unknown");
    return unavailableResponse();
  }
}
