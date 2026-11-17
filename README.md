# Liwan Desk: WhatsApp front-desk agent for a dental clinic

An AI agent that answers a Dubai dental clinic's WhatsApp messages in **English and Arabic**: prices, opening hours, free appointment times, greetings and thanks. Anything it should not answer is handed to a person with a kind holding reply. It runs on a phone-style simulator at `/phone` and uses **made-up data only**.

**Live demo:** https://liwan-desk.vercel.app/phone

## How a message is handled
1. **Jev** sorts the message into a label (price, booking, emergency, complaint, ...), with a Claude fallback.
2. **Clinic rules in plain code** (`src/lib/clinic.ts`) decide what happens. Same input, same answer, every time.
3. **Claude** writes only a warm opening and closing around lists that code builds (prices, times, hours).
4. A **reply checker** (`src/lib/reply.ts`) approves every reply against an allow-list of prices, times and claims before it is sent.
5. Emergencies, complaints, cancellations, unlisted treatments and anything unclear go to a person.

## Built-in safety
Webhook signature check, rate limiting, a templates-only mode that runs without any AI (`AI_MODE=templates`), secrets only on the server, and a simulator switch (`SIMULATOR_ENABLED`) that must be off on any deployment with real patient data.

## Run it
```bash
npm install
npm run dev        # http://localhost:3000/phone
npm run typecheck
```
Copy `.env.example` to `.env.local`. Without keys the agent still runs in templates mode.

## Status
Agent, rules, reply checks, hosting and database tables are on `main`. The conversation memory step (every message, step, cost and hand-over saved in Supabase) is in an open pull request. Staff inbox and real WhatsApp are planned next.

## Stack
Next.js 16, React 19, TypeScript, Zod, Claude (Anthropic SDK), Jev classifier, Supabase, Vercel (Mumbai region, next to the database).
