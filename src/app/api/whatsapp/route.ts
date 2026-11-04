// The agent's front door. Receives WhatsApp Cloud API webhook payloads.
// For now it only echoes the message back and reports the steps it took.

import { applyClinicRules } from "@/lib/clinic";
import { classifyMessage } from "@/lib/jev";

export type Step = { label: string; detail: string };

type IncomingMessage = {
  from: string;
  id: string;
  timestamp: string;
  type?: string;
  text?: { body: string };
};

type WebhookPayload = {
  entry?: {
    changes?: {
      value?: { messages?: IncomingMessage[] };
    }[];
  }[];
};

export async function POST(request: Request) {
  const steps: Step[] = [];

  let payload: WebhookPayload;
  try {
    payload = await request.json();
  } catch {
    return Response.json(
      { steps: [{ label: "Rejected", detail: "Body was not valid JSON" }], reply: null },
      { status: 400 },
    );
  }
  steps.push({ label: "Received webhook", detail: "POST /api/whatsapp with a JSON body" });

  const message = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!message || !message.text?.body) {
    steps.push({
      label: "Ignored",
      detail: "No text message found at entry[0].changes[0].value.messages[0]",
    });
    return Response.json({ steps, reply: null }, { status: 400 });
  }
  steps.push({
    label: "Read the message",
    detail: `From ${message.from} (id ${message.id}): "${message.text.body}"`,
  });

  const classification = await classifyMessage(message.text.body);
  steps.push(
    classification.ok
      ? {
          label: "Classified the message",
          detail: `Asked 3 questions in one call to ${classification.engine === "jev" ? "Jev" : "Claude"}`,
        }
      : {
          label: "Classification failed",
          detail: `${classification.error}. Treating every answer as not sure.`,
        },
  );

  const decision = applyClinicRules(message.text.body, classification);
  steps.push({
    label: "Applied the clinic rules",
    detail: decision.action === "flag" ? `Flagged for a person: ${decision.reason}` : "Answered from the clinic's own data",
  });

  steps.push({
    label: "Wrote a reply",
    detail: decision.action === "flag" ? "Told the customer a person will be in touch" : "Sent the answer from the rules",
  });

  return Response.json({ steps, reply: decision.reply, classification, decision });
}
