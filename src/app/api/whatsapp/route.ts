// The agent's front door. Receives WhatsApp Cloud API webhook payloads, sorts the
// message (Jev), applies the clinic's rules, has Claude write a reply, checks it in
// code, and either sends it or hands the conversation to a person.
//
// Any failure ends in the holding reply and a handover. It never throws a 500, and
// it never puts provider error text in the response.

import { createHmac, timingSafeEqual } from "node:crypto";
import { applyClinicRules } from "@/lib/clinic";
import { classifyMessage } from "@/lib/jev";
import { buildReply, holdingReplyFor } from "@/lib/reply";

export type Step = { label: string; detail: string };

// The worst case is a 2 s classification, a 20 s reply and a little slack.
export const maxDuration = 60;

const MAX_BODY_BYTES = 65_536;
const MAX_MESSAGE_CHARS = 1000;
const RATE_LIMIT_PER_MINUTE = 15; // per sender

// Header the simulator page sets while a person is handling the conversation.
// Trusting it is safe: its only effect is that the bot stays quiet.
const WITH_PERSON_HEADER = "x-conversation-with-person";

type IncomingText = { from: string; id: string; body: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Every text message in the webhook, whatever the body really looks like.
function textMessages(payload: unknown): IncomingText[] {
  if (!isRecord(payload) || !Array.isArray(payload.entry)) return [];
  const found: IncomingText[] = [];
  for (const entry of payload.entry) {
    if (!isRecord(entry) || !Array.isArray(entry.changes)) continue;
    for (const change of entry.changes) {
      if (!isRecord(change) || !isRecord(change.value) || !Array.isArray(change.value.messages)) continue;
      for (const message of change.value.messages) {
        if (!isRecord(message) || !isRecord(message.text)) continue;
        const body = message.text.body;
        if (typeof body !== "string" || body.trim() === "") continue;
        found.push({
          from: String(message.from ?? "unknown").slice(0, 40),
          id: String(message.id ?? "unknown").slice(0, 80),
          body: body.trim(),
        });
      }
    }
  }
  return found;
}

// A WhatsApp webhook has an "entry" list even when it carries no text (delivery
// receipts, images, voice notes). Those get a 200 so WhatsApp does not retry them.
function looksLikeWebhook(payload: unknown): boolean {
  return isRecord(payload) && Array.isArray(payload.entry);
}

// ---------------------------------------------------------------------------
// Who may call this: WhatsApp signs every webhook with the app secret.
// ---------------------------------------------------------------------------

function signatureProblem(request: Request, raw: string): Response | null {
  const secret = process.env.WHATSAPP_APP_SECRET?.trim();
  const given = request.headers.get("x-hub-signature-256");
  const production = process.env.NODE_ENV === "production";
  // The /phone simulator cannot sign its messages. It works unsigned in development, and in
  // a hosted deployment only when SIMULATOR_ENABLED=true is set on purpose. Never set it
  // on a deployment that is open to the public: anyone could then spend the AI keys.
  const unsignedAllowed = !production || process.env.SIMULATOR_ENABLED === "true";

  if (production && !secret && !unsignedAllowed) {
    return Response.json({ steps: [{ label: "Rejected", detail: "The server has no WhatsApp app secret set" }], reply: null }, { status: 503 });
  }
  // Anything that does send a signature is still checked.
  if (!given && unsignedAllowed) return null;
  if (!secret || !given) {
    return Response.json({ steps: [{ label: "Rejected", detail: "Missing signature" }], reply: null }, { status: 401 });
  }
  const expected = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return Response.json({ steps: [{ label: "Rejected", detail: "Signature does not match" }], reply: null }, { status: 401 });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rate limit and duplicates. Kept in this server's memory, so they reset on restart
// and each server instance counts on its own. A real deployment needs a shared store.
// ---------------------------------------------------------------------------

const windows = new Map<string, { count: number; resetAt: number }>();

function tooManyRequests(sender: string): boolean {
  const now = Date.now();
  if (windows.size > 1000) {
    for (const [key, w] of windows) if (w.resetAt < now) windows.delete(key);
  }
  const w = windows.get(sender);
  if (!w || w.resetAt < now) {
    windows.set(sender, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  w.count += 1;
  return w.count > RATE_LIMIT_PER_MINUTE;
}

const seenIds: string[] = [];
const seenSet = new Set<string>();

function alreadySeen(id: string): boolean {
  if (id === "unknown") return false;
  if (seenSet.has(id)) return true;
  seenSet.add(id);
  seenIds.push(id);
  if (seenIds.length > 500) seenSet.delete(seenIds.shift()!);
  return false;
}

// ---------------------------------------------------------------------------

function handover(steps: Step[], reason: string, customerMessage = "") {
  steps.push({ label: "Handed to a person", detail: `${reason}. Sent a holding reply.` });
  return Response.json({
    steps,
    reply: holdingReplyFor("other", customerMessage),
    handoff: { reason, situation: "other" },
  });
}

async function handle(request: Request, steps: Step[]): Promise<Response> {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return Response.json({ steps: [{ label: "Rejected", detail: "Body is too large" }], reply: null }, { status: 413 });
  }

  const unsigned = signatureProblem(request, raw);
  if (unsigned) return unsigned;

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return Response.json(
      { steps: [{ label: "Rejected", detail: "Body was not valid JSON" }], reply: null },
      { status: 400 },
    );
  }
  steps.push({ label: "Received webhook", detail: "POST /api/whatsapp with a JSON body" });

  const messages = textMessages(payload);
  const message = messages[0];
  if (!message) {
    if (looksLikeWebhook(payload)) {
      steps.push({ label: "Ignored", detail: "A webhook with no text message (a receipt, image or similar). Nothing to answer." });
      return Response.json({ steps, reply: null });
    }
    steps.push({ label: "Rejected", detail: "Not a WhatsApp webhook: no entry list" });
    return Response.json({ steps, reply: null }, { status: 400 });
  }

  if (alreadySeen(message.id)) {
    steps.push({ label: "Ignored", detail: `Message ${message.id} was already handled (WhatsApp retried it)` });
    return Response.json({ steps, reply: null });
  }
  if (tooManyRequests(message.from)) {
    steps.push({ label: "Rejected", detail: `More than ${RATE_LIMIT_PER_MINUTE} messages a minute from this sender` });
    return Response.json({ steps, reply: null }, { status: 429, headers: { "Retry-After": "60" } });
  }

  const preview = message.body.length > 200 ? `${message.body.slice(0, 200)}…` : message.body;
  steps.push({
    label: "Read the message",
    detail: `From ${message.from} (id ${message.id}): "${preview}"`,
  });
  if (messages.length > 1) {
    steps.push({
      label: "Note",
      detail: `${messages.length - 1} more message(s) in this webhook were not answered. Only the first is handled for now.`,
    });
  }

  // A person is already handling this conversation: the bot stays quiet.
  if (request.headers.get(WITH_PERSON_HEADER) === "true") {
    steps.push({ label: "No automatic reply", detail: "This conversation is with a person" });
    return Response.json({
      steps,
      reply: null,
      handoff: { reason: "The conversation is already with a person", situation: "other" },
      withPerson: true,
    });
  }

  // Very long messages never reach Jev or Claude.
  if (message.body.length > MAX_MESSAGE_CHARS) {
    return handover(steps, `The message is longer than ${MAX_MESSAGE_CHARS} characters`, message.body);
  }

  const classification = await classifyMessage(message.body);
  steps.push(
    classification.ok
      ? {
          label: "Classified the message",
          detail:
            classification.engine === "templates"
              ? "Sorted with plain keywords (AI_MODE=templates)"
              : `Asked 3 questions in one call to ${classification.engine === "jev" ? "Jev" : "Claude"}`,
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
    const templates = outcome.writer.model === "templates";
    steps.push({
      label: templates ? "Wrote a template reply" : "Claude wrote a draft reply",
      detail: templates ? "Code filled in a template from the facts (AI_MODE=templates)" : "Given only the facts the rules found",
    });
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
      : {
          label: "Sent the reply",
          detail:
            decision.facts?.kind === "greeting"
              ? "A fixed welcome, written by code (no Claude call needed)"
              : "The reply passed every check",
        },
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
