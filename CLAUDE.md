# Liwan Desk

Project type: AI solution (a WhatsApp agent for Liwan Dental, tested on the /phone simulator). Stack: Next.js (read `AGENTS.md`: look in `node_modules/next/dist/docs/` before writing Next.js code), Jev (rules in `docs/jev-rules.md`), Claude, Supabase.

## Rules
- Code decides, models propose. Jev sorts the message, the clinic rules in `src/lib/clinic.ts` decide, Claude only writes wording, and every reply is checked in code (`src/lib/reply.ts`) before it is sent. Anything unsure goes to a person.
- Voice: warm and human, in the customer's language (English or Arabic), with tidy lists for prices, times and opening hours.
- Secrets stay on the server. Never `NEXT_PUBLIC_` on a key. Names go in `.env.example`, values in `.env.local`, which is never read or printed.
- The Supabase tables are locked (row-level security on, no public access). Only the server uses the secret key.
- Made-up data only, marked `is_synthetic`. No real patients yet.
