// The agent's memory: the only file that reads and writes the conversation tables.
//
// Server side only (it uses the database's secret key). Never log message text or phone
// numbers from here: only ids, counts and error names.

import type { Decision } from "./clinic";
import { db } from "./db";
import type { Classification } from "./jev";
import type { WriterResult } from "./reply";

export class DatabaseError extends Error {
  constructor(where: string) {
    super(`database problem while ${where}`);
    this.name = "DatabaseError";
  }
}

export type Source = "simulator" | "whatsapp";
export type ConversationStatus = "bot" | "with_person" | "closed";

// One earlier message, as the writer sees it. Only customer and agent messages.
export type ChatLine = { who: "customer" | "agent"; text: string };

export type OpenedConversation = {
  duplicate: false;
  conversationId: string;
  messageId: string; // the customer message just saved
  status: ConversationStatus;
  recent: ChatLine[]; // up to 6 earlier messages, oldest first
  hasGreeted: boolean; // the agent already welcomed this customer in this conversation
};

const MEMORY_MESSAGES = 6;
const MEMORY_CHARS = 300;

// The phone page's conversation ids: "sim-" and a random UUID. Nothing else is readable
// through the simulator routes, so a WhatsApp conversation can never be read that way.
export function isSimulatorId(id: string): boolean {
  return /^sim-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
}

// ---------------------------------------------------------------------------
// Opening a conversation and saving the customer's message (always first)
// ---------------------------------------------------------------------------

export async function openConversation(input: {
  source: Source;
  externalId: string; // the customer's WhatsApp number, or the phone page's session id
  externalMessageId: string | null; // WhatsApp's own message id; a repeat of one is ignored
  body: string;
}): Promise<OpenedConversation | { duplicate: true }> {
  const d = db();

  // One safe step: two messages arriving together cannot create two conversations.
  const conv = await d
    .from("conversations")
    .upsert(
      { source: input.source, external_id: input.externalId, is_synthetic: input.source === "simulator" },
      { onConflict: "source,external_id" },
    )
    .select("id,status")
    .single();
  if (conv.error || !conv.data) throw new DatabaseError("opening the conversation");

  // The customer's words are saved before anything else, so a crash later never loses them.
  const saved = await d
    .from("messages")
    .insert({
      conversation_id: conv.data.id,
      direction: "in",
      sender: "customer",
      body: input.body,
      external_id: input.externalMessageId,
    })
    .select("id")
    .single();
  if (saved.error) {
    if (saved.error.code === "23505") return { duplicate: true }; // WhatsApp retried a message we already have
    throw new DatabaseError("saving the customer's message");
  }

  const [recent, greeted] = await Promise.all([
    d
      .from("messages")
      .select("sender,body")
      .eq("conversation_id", conv.data.id)
      .in("sender", ["customer", "agent"])
      .neq("id", saved.data.id)
      .order("created_at", { ascending: false })
      .limit(MEMORY_MESSAGES),
    d
      .from("agent_steps")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", conv.data.id)
      .eq("kind", "rules")
      .contains("payload", { facts: { kind: "greeting" } }),
  ]);
  if (recent.error || greeted.error) throw new DatabaseError("reading the conversation so far");

  return {
    duplicate: false,
    conversationId: conv.data.id,
    messageId: saved.data.id,
    status: conv.data.status as ConversationStatus,
    recent: [...(recent.data ?? [])]
      .reverse()
      .map((m) => ({ who: m.sender as "customer" | "agent", text: String(m.body).slice(0, MEMORY_CHARS) })),
    hasGreeted: (greeted.count ?? 0) > 0,
  };
}

// ---------------------------------------------------------------------------
// Saving what the agent did, all together
// ---------------------------------------------------------------------------

export type SavedStep = {
  kind: "step" | "classification" | "rules" | "writer";
  label: string;
  detail?: string | null;
  engine?: string | null;
  model?: string | null;
  durationMs?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
  payload?: unknown; // the answers, the rule checks, the draft: what the panel shows
};

export async function saveRun(input: {
  conversationId: string;
  messageId: string;
  reply: string | null;
  steps: SavedStep[];
  handover: { reason: string; situation: string } | null;
}): Promise<void> {
  const { error } = await db().rpc("save_run", {
    p: {
      conversation_id: input.conversationId,
      message_id: input.messageId,
      reply: input.reply,
      handover: input.handover,
      steps: input.steps.map((s, i) => ({
        position: i + 1,
        kind: s.kind,
        label: s.label,
        detail: s.detail ?? null,
        engine: s.engine ?? null,
        model: s.model ?? null,
        duration_ms: s.durationMs ?? null,
        input_tokens: s.inputTokens ?? null,
        output_tokens: s.outputTokens ?? null,
        cost_usd: s.costUsd ?? null,
        payload: s.payload ?? {},
      })),
    },
  });
  if (error) throw new DatabaseError("saving the run");
}

// ---------------------------------------------------------------------------
// The phone page: restore a conversation, answer as the receptionist, hand it back
// ---------------------------------------------------------------------------

export type HistoryBubble = { id: string; from: "customer" | "agent" | "receptionist"; text: string };
export type HistoryGroup = {
  id: string;
  message: string;
  steps: { label: string; detail: string }[];
  classification?: Classification;
  decision?: Decision;
  writer?: WriterResult | null;
};
export type HistoryHandoff = {
  id: string;
  reason: string;
  urgent: boolean;
  resolved: boolean;
  thread: { who: "customer" | "receptionist"; text: string }[];
};
export type History = {
  conversationId: string | null;
  status: ConversationStatus;
  bubbles: HistoryBubble[];
  groups: HistoryGroup[];
  handoffs: HistoryHandoff[];
};

const EMPTY_HISTORY: History = { conversationId: null, status: "bot", bubbles: [], groups: [], handoffs: [] };

async function findSimulatorConversation(externalId: string): Promise<{ id: string; status: ConversationStatus } | null> {
  if (!isSimulatorId(externalId)) return null;
  const { data, error } = await db()
    .from("conversations")
    .select("id,status")
    .eq("source", "simulator")
    .eq("external_id", externalId)
    .maybeSingle();
  if (error) throw new DatabaseError("finding the conversation");
  return data ? { id: data.id, status: data.status as ConversationStatus } : null;
}

export async function loadHistory(externalId: string): Promise<History> {
  const conv = await findSimulatorConversation(externalId);
  if (!conv) return EMPTY_HISTORY;
  const d = db();
  const [messages, steps, handovers] = await Promise.all([
    d.from("messages").select("id,direction,sender,body,created_at").eq("conversation_id", conv.id).order("created_at").limit(500),
    d.from("agent_steps").select("message_id,position,kind,label,detail,payload").eq("conversation_id", conv.id).order("created_at").order("position"),
    d.from("handovers").select("id,message_id,reason,situation,status,created_at,resolved_at").eq("conversation_id", conv.id).order("created_at"),
  ]);
  if (messages.error || steps.error || handovers.error) throw new DatabaseError("loading the conversation");

  const msgs = messages.data ?? [];
  const bubbles: HistoryBubble[] = msgs.map((m) => ({ id: m.id, from: m.sender as HistoryBubble["from"], text: m.body }));

  const groups: HistoryGroup[] = msgs
    .filter((m) => m.direction === "in")
    .map((m) => {
      const rows = (steps.data ?? []).filter((s) => s.message_id === m.id);
      const payloadOf = (kind: string) => rows.find((r) => r.kind === kind)?.payload;
      return {
        id: m.id,
        message: m.body,
        steps: rows.filter((r) => r.kind === "step").map((r) => ({ label: r.label, detail: r.detail ?? "" })),
        classification: payloadOf("classification") as Classification | undefined,
        decision: payloadOf("rules") as Decision | undefined,
        writer: (payloadOf("writer") as WriterResult | undefined) ?? null,
      };
    });

  const handoffs: HistoryHandoff[] = (handovers.data ?? []).map((h) => {
    const trigger = msgs.find((m) => m.id === h.message_id);
    const until = h.resolved_at ? new Date(h.resolved_at).getTime() : Infinity;
    const later = msgs.filter(
      (m) =>
        (m.sender === "customer" || m.sender === "receptionist") &&
        m.id !== h.message_id &&
        new Date(m.created_at).getTime() > new Date(h.created_at).getTime() &&
        new Date(m.created_at).getTime() <= until,
    );
    return {
      id: h.id,
      reason: h.reason,
      urgent: h.situation === "emergency",
      resolved: h.status === "resolved",
      thread: [
        ...(trigger ? [{ who: "customer" as const, text: trigger.body }] : []),
        ...later.map((m) => ({ who: m.sender as "customer" | "receptionist", text: m.body })),
      ],
    };
  });

  return { conversationId: conv.id, status: conv.status, bubbles, groups, handoffs };
}

export async function saveReceptionistReply(externalId: string, text: string): Promise<{ id: string } | null> {
  const conv = await findSimulatorConversation(externalId);
  if (!conv) return null;
  const d = db();
  const saved = await d
    .from("messages")
    .insert({ conversation_id: conv.id, direction: "out", sender: "receptionist", body: text })
    .select("id")
    .single();
  if (saved.error || !saved.data) throw new DatabaseError("saving the receptionist's reply");
  await d.from("conversations").update({ last_message_at: new Date().toISOString() }).eq("id", conv.id);
  return { id: saved.data.id };
}

export async function handBack(externalId: string): Promise<boolean> {
  const conv = await findSimulatorConversation(externalId);
  if (!conv) return false;
  const { error } = await db().rpc("hand_back", { p_conversation_id: conv.id });
  if (error) throw new DatabaseError("handing the conversation back");
  return true;
}
