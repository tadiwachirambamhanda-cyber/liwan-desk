"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Step } from "../api/whatsapp/route";
import type { Classification } from "@/lib/jev";
import type { Decision } from "@/lib/clinic";
import type { WriterResult } from "@/lib/reply";
import type { History } from "@/lib/memory";

type Bubble = { id: string; from: "customer" | "agent" | "receptionist"; text: string };
type StepGroup = {
  id: string;
  message: string;
  steps: Step[];
  classification?: Classification;
  decision?: Decision;
  writer?: WriterResult | null;
};
type ThreadLine = { who: "customer" | "receptionist"; text: string };
type Handoff = { id: string; reason: string; thread: ThreadLine[]; resolved: boolean; urgent: boolean };

// WhatsApp shows *text* as bold. The simulator does the same so a list looks as it would on a phone.
function whatsappText(text: string): React.ReactNode[] {
  return text.split(/(\*[^*\n]+\*)/g).map((part, i) =>
    /^\*[^*\n]+\*$/.test(part) ? <strong key={i}>{part.slice(1, -1)}</strong> : part,
  );
}

function WriterView({ w, held }: { w: WriterResult; held: boolean }) {
  return (
    <div className="mt-3 rounded-md bg-neutral-50 p-3 text-sm">
      <p className="font-medium text-neutral-900">
        {w.model === "templates" ? "Template reply (no AI)" : "Claude reply"}{" "}
        {w.model !== "templates" && <span className="font-normal text-neutral-500">({w.model})</span>}
      </p>
      {w.error ? (
        <p className="mt-2 text-red-700">{w.error}</p>
      ) : (
        <>
          <p className="mt-2 whitespace-pre-wrap rounded bg-white p-2 text-neutral-800">
            {w.draft}
          </p>
          <ul className="mt-2 space-y-1">
            {w.checks.map((c) => (
              <li key={c.name} className="flex gap-2">
                <span className={c.passed ? "text-green-700" : "font-bold text-red-700"}>
                  {c.passed ? "✓" : "✗"}
                </span>
                <span>
                  <span className="text-neutral-600">{c.name}</span>{" "}
                  <span className={c.passed ? "text-neutral-500" : "font-medium text-red-700"}>
                    {c.detail}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="mt-2 text-xs text-neutral-500">
        {w.ms} ms · {formatCost(w.costUsd)}
        {w.inputTokens !== null && ` · ${w.inputTokens} in / ${w.outputTokens ?? 0} out tokens`}
      </p>
      <p className={`mt-1 font-medium ${held ? "text-amber-700" : "text-green-700"}`}>
        {held ? "Held back. A holding reply was sent instead." : "Sent to the phone."}
      </p>
    </div>
  );
}

function DecisionView({ d }: { d: Decision }) {
  const mark = { pass: "✓", flag: "⚑", info: "•" } as const;
  const color = { pass: "text-green-700", flag: "text-amber-700", info: "text-neutral-500" } as const;
  return (
    <div className="mt-3 rounded-md bg-neutral-50 p-3 text-sm">
      <p className="font-medium text-neutral-900">Clinic rules</p>
      <ul className="mt-2 space-y-1">
        {d.checks.map((c, i) => (
          <li key={i} className="flex gap-2">
            <span className={color[c.status]}>{mark[c.status]}</span>
            <span>
              <span className="text-neutral-600">{c.label}</span>{" "}
              <span className="font-medium text-neutral-900">{c.result}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className={`mt-2 font-medium ${d.action === "flag" ? "text-amber-700" : "text-green-700"}`}>
        {d.action === "flag" ? `Flagged for a person: ${d.reason}` : "Facts found by the rules"}
      </p>
    </div>
  );
}

function formatCost(usd: number | null): string {
  if (usd === null) return "cost unknown";
  if (usd < 0.0001) return "under $0.0001";
  return `$${usd.toFixed(usd < 0.01 ? 5 : 4)}`;
}

function ClassificationView({ c }: { c: Classification }) {
  const engine = c.engine === "jev" ? "Jev" : c.engine === "claude" ? "Claude" : "Keywords";
  return (
    <div className="mt-3 rounded-md bg-neutral-50 p-3 text-sm">
      <p className="font-medium text-neutral-900">
        {engine} <span className="font-normal text-neutral-500">({c.model})</span>
      </p>
      {c.note && <p className="mt-1 text-amber-700">{c.note}</p>}
      {c.ok ? (
        <>
          <ul className="mt-2 space-y-1">
            {c.answers.map((a) => (
              <li key={a.question} className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-neutral-600">{a.asked}</span>
                <span className={a.unsure ? "font-medium text-amber-700" : "font-medium text-neutral-900"}>
                  {a.answer.replaceAll("_", " ")}{" "}
                  <span className="font-normal text-neutral-500">
                    {Math.round(a.confidence * 100)}%
                  </span>
                  {a.unsure && (
                    <span className="font-normal text-neutral-500">
                      {" "}
                      (picked {a.label.replaceAll("_", " ")})
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-neutral-500">
            {c.ms} ms · {formatCost(c.costUsd)}
            {c.inputTokens !== null && ` · ${c.inputTokens} input tokens`}
          </p>
        </>
      ) : (
        <p className="mt-2 text-red-700">
          {c.error} <span className="text-neutral-500">· {c.ms} ms</span>
        </p>
      )}
    </div>
  );
}

// A fake business number for the simulator. The customer is the chat's own random session id.
const BUSINESS_NUMBER = "15550001111";
const SESSION_KEY = "liwan-sim-session";
const SESSION_ID = /^sim-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The chat's session id lives in the browser's saved data, read the way React expects for outside data.
const sessionListeners = new Set<() => void>();
let unsavedSessionId: string | null = null; // used only when the browser blocks saved data

function subscribeToSession(listener: () => void) {
  sessionListeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    sessionListeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function readSessionId(): string {
  try {
    const saved = localStorage.getItem(SESSION_KEY);
    if (saved && SESSION_ID.test(saved)) return saved;
    const id = `sim-${crypto.randomUUID()}`;
    localStorage.setItem(SESSION_KEY, id);
    return id;
  } catch {
    unsavedSessionId ??= `sim-${crypto.randomUUID()}`;
    return unsavedSessionId;
  }
}

function startNewSessionId() {
  const id = `sim-${crypto.randomUUID()}`;
  try {
    localStorage.setItem(SESSION_KEY, id);
  } catch {
    unsavedSessionId = id;
  }
  sessionListeners.forEach((listener) => listener());
}

// Builds an incoming text message exactly as the WhatsApp Cloud API sends it.
function buildPayload(body: string, messageId: string, from: string) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WHATSAPP_BUSINESS_ACCOUNT_ID",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: BUSINESS_NUMBER,
                phone_number_id: "PHONE_NUMBER_ID",
              },
              contacts: [{ profile: { name: "Test Customer" }, wa_id: from }],
              messages: [
                {
                  from,
                  id: messageId,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

export default function PhonePage() {
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [groups, setGroups] = useState<StepGroup[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [handoffs, setHandoffs] = useState<Handoff[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const sessionId = useSyncExternalStore(subscribeToSession, readSessionId, () => null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "failed">("loading");
  const [notice, setNotice] = useState<string | null>(null);
  const chatEnd = useRef<HTMLDivElement>(null);

  // The chat is remembered by the server. This page keeps only a random session id in the browser
  // and asks the server for the history when it opens.
  const [reloadTick, setReloadTick] = useState(0);

  // Whenever the chat's session id is known (or changes), bring its history back from the server.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    fetch(`/api/conversations/${sessionId}`)
      .then((res) => {
        if (!res.ok) throw new Error("history");
        return res.json() as Promise<History>;
      })
      .then((h) => {
        if (cancelled) return;
        setBubbles(h.bubbles);
        setGroups(h.groups);
        setHandoffs(h.handoffs);
        setLoadState("ready");
      })
      .catch(() => {
        if (!cancelled) setLoadState("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, reloadTick]);

  function newChat() {
    setBubbles([]);
    setGroups([]);
    setHandoffs([]);
    setDrafts({});
    setNotice(null);
    startNewSessionId();
  }

  // The receptionist answers a handed-over conversation. The server saves it; it appears on the phone.
  async function answerAsReceptionist(h: Handoff) {
    const reply = (drafts[h.id] ?? "").trim();
    if (!reply || !sessionId) return;
    try {
      const res = await fetch(`/api/conversations/${sessionId}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: reply }),
      });
      if (!res.ok) throw new Error("reply");
    } catch {
      setNotice("The reply could not be saved. Try again.");
      return;
    }
    setNotice(null);
    setBubbles((b) => [...b, { id: `${h.id}-person-${b.length}`, from: "receptionist", text: reply }]);
    setHandoffs((list) =>
      list.map((x) => (x.id === h.id ? { ...x, thread: [...x.thread, { who: "receptionist", text: reply }] } : x)),
    );
    setDrafts((d) => ({ ...d, [h.id]: "" }));
  }

  // While a conversation is with a person, the server keeps the agent quiet until it is handed back.
  const openHandoff = [...handoffs].reverse().find((h) => !h.resolved);
  async function handBack() {
    if (!sessionId) return;
    try {
      const res = await fetch(`/api/conversations/${sessionId}/hand-back`, { method: "POST" });
      if (!res.ok) throw new Error("hand back");
    } catch {
      setNotice("Could not hand the conversation back. Try again.");
      return;
    }
    setNotice(null);
    setHandoffs((list) => list.map((x) => ({ ...x, resolved: true })));
  }

  useEffect(() => {
    chatEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [bubbles]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if (!body || sending || !sessionId) return;

    const messageId = `wamid.${crypto.randomUUID()}`;
    setBubbles((b) => [...b, { id: messageId, from: "customer", text: body }]);
    setText("");
    setSending(true);
    const open = openHandoff;

    try {
      const res = await fetch("/api/whatsapp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload(body, messageId, sessionId)),
      });
      const data: {
        steps?: Step[];
        reply: string | null;
        classification?: Classification;
        decision?: Decision;
        writer?: WriterResult | null;
        handoff?: { reason: string; situation?: string } | null;
        withPerson?: boolean;
      } = await res.json();
      setGroups((g) => [
        ...g,
        {
          id: messageId,
          message: body,
          steps: Array.isArray(data.steps)
            ? data.steps
            : [{ label: "Error", detail: `The server answered with HTTP ${res.status}` }],
          classification: data.classification,
          decision: data.decision,
          writer: data.writer,
        },
      ]);
      if (open && data.withPerson) {
        // The customer wrote again while a person is handling it: it joins that conversation.
        setHandoffs((list) =>
          list.map((x) => (x.id === open.id ? { ...x, thread: [...x.thread, { who: "customer", text: body }] } : x)),
        );
      } else if (data.handoff) {
        const { reason, situation } = data.handoff;
        setHandoffs((list) => [
          ...list,
          {
            id: messageId,
            reason,
            thread: [{ who: "customer", text: body }],
            resolved: false,
            urgent: situation === "emergency",
          },
        ]);
      }
      if (data.reply) {
        setBubbles((b) => [...b, { id: `${messageId}-reply`, from: "agent", text: data.reply! }]);
      }
    } catch {
      setGroups((g) => [
        ...g,
        {
          id: messageId,
          message: body,
          steps: [{ label: "Error", detail: "Could not reach /api/whatsapp or read its answer" }],
        },
      ]);
    } finally {
      setSending(false);
    }
  }

  return (
    <main className="flex min-h-screen flex-col gap-8 bg-neutral-100 p-6 md:flex-row md:items-start md:justify-center">
      {/* Left: the phone */}
      <section className="mx-auto w-full max-w-sm">
        <div className="flex h-[640px] flex-col overflow-hidden rounded-[2rem] border-8 border-neutral-900 bg-[#efeae2] shadow-xl">
          <header className="flex items-center gap-3 bg-[#075e54] px-4 py-3 text-white">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-white/20 text-sm font-semibold">
              L
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold leading-tight">Liwan Desk</p>
              <p className="text-xs text-white/70">online</p>
            </div>
            <button
              type="button"
              onClick={newChat}
              className="rounded-full bg-white/15 px-3 py-1 text-xs font-medium text-white hover:bg-white/25"
            >
              New chat
            </button>
          </header>

          <div className="flex-1 space-y-2 overflow-y-auto p-3">
            {loadState === "loading" && (
              <p className="mt-6 text-center text-xs text-neutral-500">Loading your chat…</p>
            )}
            {loadState === "failed" && (
              <div className="mt-6 rounded-lg bg-amber-100 p-3 text-center text-xs text-amber-900">
                Could not load the earlier messages, so this chat may look empty even though it was saved.{" "}
                <button type="button" className="font-semibold underline" onClick={() => {
                    setLoadState("loading");
                    setReloadTick((t) => t + 1);
                  }}>
                  Try again
                </button>
              </div>
            )}
            {loadState === "ready" && bubbles.length === 0 && (
              <p className="mt-6 text-center text-xs text-neutral-500">
                Type a message below as the customer.
              </p>
            )}
            {bubbles.map((b) => (
              <div
                key={b.id}
                className={`flex ${b.from === "customer" ? "justify-end" : "justify-start"}`}
              >
                <p
                  className={`max-w-[80%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm text-neutral-900 shadow-sm ${
                    b.from === "customer" ? "bg-[#d9fdd3]" : "bg-white"
                  }`}
                >
                  {b.from === "receptionist" && (
                    <span className="mb-0.5 block text-xs font-medium text-[#075e54]">Receptionist</span>
                  )}
                  {whatsappText(b.text)}
                </p>
              </div>
            ))}
            <div ref={chatEnd} />
          </div>

          <form onSubmit={send} className="flex gap-2 bg-[#f0f2f5] p-2">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Type a message"
              className="min-w-0 flex-1 rounded-full bg-white px-4 py-2 text-sm text-neutral-900 outline-none"
            />
            <button
              type="submit"
              disabled={sending || !text.trim() || !sessionId}
              className="rounded-full bg-[#075e54] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              Send
            </button>
          </form>
        </div>
      </section>

      {/* Right: what the agent did */}
      <section className="mx-auto w-full max-w-md">
        {notice && <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{notice}</p>}
        {handoffs.length > 0 && (
          <div className="mb-6">
            <h2 className="mb-3 text-lg font-semibold text-neutral-900">Handed to a person</h2>
            <ul className="space-y-3">
              {handoffs.map((h) => (
                <li
                  key={h.id}
                  className={`rounded-lg border p-4 text-sm ${
                    h.resolved
                      ? "border-neutral-200 bg-white"
                      : h.urgent
                        ? "border-red-400 bg-red-50"
                        : "border-amber-300 bg-amber-50"
                  }`}
                >
                  <p className={h.resolved ? "text-neutral-500" : h.urgent ? "text-red-800" : "text-amber-800"}>
                    {h.urgent && !h.resolved && (
                      <span className="mr-2 rounded bg-red-600 px-1.5 py-0.5 text-xs font-bold text-white">URGENT</span>
                    )}
                    {h.reason}
                  </p>
                  <div className="mt-2 space-y-1">
                    {h.thread.map((line, i) => (
                      <p
                        key={i}
                        className={`rounded p-2 ${line.who === "customer" ? "bg-white text-neutral-900" : "bg-[#d9fdd3] text-neutral-800"}`}
                      >
                        <span className="text-xs font-medium text-[#075e54]">
                          {line.who === "customer" ? "Customer: " : "Receptionist: "}
                        </span>
                        {line.text}
                      </p>
                    ))}
                  </div>
                  {h.resolved ? (
                    <p className="mt-2 text-xs font-medium text-green-700">Handed back to the agent</p>
                  ) : (
                    <>
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          void answerAsReceptionist(h);
                        }}
                        className="mt-3 flex gap-2"
                      >
                        <input
                          value={drafts[h.id] ?? ""}
                          onChange={(e) => setDrafts((d) => ({ ...d, [h.id]: e.target.value }))}
                          placeholder="Reply as the receptionist"
                          className="min-w-0 flex-1 rounded border border-neutral-300 bg-white px-3 py-1.5 text-neutral-900 outline-none"
                        />
                        <button
                          type="submit"
                          disabled={!(drafts[h.id] ?? "").trim()}
                          className="rounded bg-[#075e54] px-3 py-1.5 font-medium text-white disabled:opacity-50"
                        >
                          Reply
                        </button>
                      </form>
                      <button
                        type="button"
                        onClick={() => void handBack()}
                        className="mt-2 text-xs font-medium text-neutral-600 underline"
                      >
                        Done, hand back to the agent
                      </button>
                      <p className="mt-1 text-xs text-neutral-500">
                        The agent stays quiet on this conversation until you do.
                      </p>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        <h2 className="mb-3 text-lg font-semibold text-neutral-900">What the agent did</h2>
        {groups.length === 0 ? (
          <p className="text-sm text-neutral-500">
            Send a message and every step the agent takes will show up here.
          </p>
        ) : (
          <ol className="space-y-4">
            {groups.map((g) => (
              <li key={g.id} className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm">
                <p className="mb-2 text-sm font-medium text-neutral-900">
                  Message: &ldquo;{g.message}&rdquo;
                </p>
                <ol className="list-inside list-decimal space-y-1 text-sm text-neutral-700">
                  {g.steps.map((s, i) => (
                    <li key={i}>
                      <span className="font-medium">{s.label}</span>
                      <span className="text-neutral-500"> — {s.detail}</span>
                    </li>
                  ))}
                </ol>
                {g.classification && <ClassificationView c={g.classification} />}
                {g.decision && <DecisionView d={g.decision} />}
                {g.writer && (
                  <WriterView
                    w={g.writer}
                    held={Boolean(g.writer.error) || g.writer.checks.some((c) => !c.passed)}
                  />
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}
