// The agent's front door. Receives WhatsApp Cloud API webhook payloads.
// For now it only echoes the message back and reports the steps it took.

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

  const reply = `You said: ${message.text.body}`;
  steps.push({ label: "Wrote a reply", detail: "Repeated the customer's message back" });

  return Response.json({ steps, reply });
}
