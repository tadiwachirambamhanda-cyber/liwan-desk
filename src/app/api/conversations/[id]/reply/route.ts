// Save a receptionist's reply to a simulator conversation. (Sending it to a real phone is step 4 of 4.)

import { closedResponse, simulatorRoutesAreOpen, unavailableResponse } from "@/lib/gate";
import { saveReceptionistReply } from "@/lib/memory";

const MAX_REPLY_CHARS = 1000;

export async function POST(request: Request, ctx: RouteContext<"/api/conversations/[id]/reply">) {
  if (!simulatorRoutesAreOpen()) return closedResponse();
  const { id } = await ctx.params;

  let text = "";
  try {
    const body: unknown = JSON.parse((await request.text()).slice(0, 10_000));
    if (typeof body === "object" && body !== null && typeof (body as { text?: unknown }).text === "string") {
      text = (body as { text: string }).text.trim();
    }
  } catch {
    // falls through to the check below
  }
  if (!text || text.length > MAX_REPLY_CHARS) {
    return Response.json({ error: `A reply needs 1 to ${MAX_REPLY_CHARS} characters` }, { status: 400 });
  }

  try {
    const saved = await saveReceptionistReply(id, text);
    return saved ? Response.json({ ok: true, id: saved.id }) : closedResponse();
  } catch (err) {
    console.error("[memory] could not save a reply:", err instanceof Error ? err.name : "unknown");
    return unavailableResponse();
  }
}
