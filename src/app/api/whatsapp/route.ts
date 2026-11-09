// The agent's front door. Receives WhatsApp Cloud API webhook payloads, sorts the
// message (Jev), applies the clinic's rules, has Claude write a reply, checks it in
// code, and either sends it or hands the conversation to a person.
//
// Any failure ends in the holding reply and a handover. It never throws a 500, and
// it never puts provider error text in the response.

import { applyClinicRules } from "@/lib/clinic";
import { classifyMessage } from "@/lib/jev";
import { buildReply, HOLDING_REPLY } from "@/lib/reply";

export type Step = { label: string; detail: string };

const MAX_MESSAGE_CHARS = 1000;

type IncomingText = { from: string; id: string; body: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Finds the first text message at entry[0].changes[0].value.messages[0], whatever
// shape the body really has. Returns null when there is no text message.
function firstTextMessage(payload: unknown): IncomingText | null {
  if (!isRecord(payload) || !Array.isArray(payload.entry)) return null;
  const entry = payload.entry[0];
  if (!isRecord(entry) || !Array.isArray(entry.changes)) return null;
  const change = entry.changes[0];
  if (!isRecord(change) || !isRecord(change.value) || !Array.isArray(change.value.messages)) return null;
  const message = change.value.messages[0];
  if (!isRecord(message) || !isRecord(message.text)) return null;
  const body = message.text.body;
  if (typeof body !== "string" || body.trim() === "") return null;
  return {
    from: String(message.from ?? "unknown").slice(0, 40),
    id: String(message.id ?? "unknown").slice(0, 80),
    body: body.trim(),
  };
}

function handover(steps: Step[], reason: string, status = 200) {
  steps.push({ label: "Handed to a person", detail: `${reason}. Sent a holding reply.` });
  return Response.json({ steps, reply: HOLDING_REPLY, handoff: { reason } }, { status });
}

async function handle(request: Request, steps: Step[]): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json(
      { steps: [{ label: "Rejected", detail: "Body was not valid JSON" }], reply: null },
      { status: 400 },
    );
  }
  steps.push({ label: "Received webhook", detail: "POST /api/whatsapp with a JSON body" });

  const message = firstTextMessage(payload);
  if (!message) {
    steps.push({
      label: "Ignored",
      detail: "No text message found at entry[0].changes[0].value.messages[0]",
    });
    return Response.json({ steps, reply: null }, { status: 400 });
  }

  const preview = message.body.length > 200 ? `${message.body.slice(0, 200)}…` : message.body;
  steps.push({
    label: "Read the message",
    detail: `From ${message.from} (id ${message.id}): "${preview}"`,
  });

  // Very long messages never reach Jev or Claude.
  if (message.body.length > MAX_MESSAGE_CHARS) {
    return handover(steps, `The message is longer than ${MAX_MESSAGE_CHARS} characters`);
  }

  const classification = await classifyMessage(message.body);
  steps.push(
    classification.ok
      ? {
          label: "Classified the message",
          detail: `Asked 3 questions in one call to ${classification.engine === "jev" ? "Jev" : "Claude"}`,
        }
      : {
          label: "Classification failed",
          detail: "Treating every answer as not sure. Details are in the server log.",
        },
  );

  const decision = applyClinicRules(message.body, classification);
  steps.push({
    label: "Applied the clinic rules",
    detail: decision.action === "flag" ? `Flagged for a person: ${decision.reason}` : "Found the facts in the clinic's own data",
  });

  const outcome = await buildReply(message.body, decision);
  if (outcome.writer) {
    steps.push({ label: "Claude wrote a draft reply", detail: "Given only the facts the rules found" });
    if (outcome.writer.draft) {
      const failed = outcome.writer.checks.filter((c) => !c.passed);
      steps.push({
        label: "Checked the draft in code",
        detail: failed.length
          ? `Failed: ${failed.map((c) => c.name).join("; ")}`
          : `All ${outcome.writer.checks.length} checks passed`,
      });
    }
  }
  steps.push(
    outcome.handoff
      ? { label: "Handed to a person", detail: `${outcome.handoff.reason}. Sent a holding reply.` }
      : { label: "Sent the reply", detail: "Claude's reply passed every check" },
  );

  return Response.json({
    steps,
    reply: outcome.reply,
    classification,
    decision,
    writer: outcome.writer,
    handoff: outcome.handoff,
  });
}

export async function POST(request: Request) {
  const steps: Step[] = [];
  try {
    return await handle(request, steps);
  } catch (err) {
    // Only the error's name is logged, never its message or the customer's text.
    console.error("[whatsapp] unexpected error:", err instanceof Error ? err.name : "unknown");
    return handover(steps, "Something went wrong inside the agent");
  }
}
