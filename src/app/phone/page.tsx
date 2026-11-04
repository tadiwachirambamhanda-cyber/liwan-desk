"use client";

import { useEffect, useRef, useState } from "react";
import type { Step } from "../api/whatsapp/route";
import type { Classification } from "@/lib/jev";

type Bubble = { id: string; from: "customer" | "agent"; text: string };
type StepGroup = {
  id: string;
  message: string;
  steps: Step[];
  classification?: Classification;
};

function formatCost(usd: number | null): string {
  if (usd === null) return "cost unknown";
  if (usd < 0.0001) return "under $0.0001";
  return `$${usd.toFixed(usd < 0.01 ? 5 : 4)}`;
}

function ClassificationView({ c }: { c: Classification }) {
  const engine = c.engine === "jev" ? "Jev" : "Claude";
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

// A fake customer phone number and business number for the simulator.
const CUSTOMER_NUMBER = "15551234567";
const BUSINESS_NUMBER = "15550001111";

// Builds an incoming text message exactly as the WhatsApp Cloud API sends it.
function buildPayload(body: string, messageId: string) {
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
              contacts: [{ profile: { name: "Test Customer" }, wa_id: CUSTOMER_NUMBER }],
              messages: [
                {
                  from: CUSTOMER_NUMBER,
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
  const chatEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [bubbles]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if (!body || sending) return;

    const messageId = `wamid.${crypto.randomUUID()}`;
    setBubbles((b) => [...b, { id: messageId, from: "customer", text: body }]);
    setText("");
    setSending(true);

    try {
      const res = await fetch("/api/whatsapp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload(body, messageId)),
      });
      const data: { steps: Step[]; reply: string | null; classification?: Classification } =
        await res.json();
      setGroups((g) => [
        ...g,
        { id: messageId, message: body, steps: data.steps, classification: data.classification },
      ]);
      if (data.reply) {
        setBubbles((b) => [...b, { id: `${messageId}-reply`, from: "agent", text: data.reply! }]);
      }
    } catch {
      setGroups((g) => [
        ...g,
        {
          id: messageId,
          message: body,
          steps: [{ label: "Error", detail: "Could not reach /api/whatsapp" }],
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
            <div>
              <p className="text-sm font-semibold leading-tight">Liwan Desk</p>
              <p className="text-xs text-white/70">online</p>
            </div>
          </header>

          <div className="flex-1 space-y-2 overflow-y-auto p-3">
            {bubbles.length === 0 && (
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
                  {b.text}
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
              disabled={sending || !text.trim()}
              className="rounded-full bg-[#075e54] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              Send
            </button>
          </form>
        </div>
      </section>

      {/* Right: what the agent did */}
      <section className="mx-auto w-full max-w-md">
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
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}
