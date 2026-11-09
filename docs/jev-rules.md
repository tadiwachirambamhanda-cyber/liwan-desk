---
title: Jev rules
session: 3
type: concept
duration: reference
---

# Jev rules

Copy this file into any app that uses Jev, saved as `docs/jev-rules.md`. Claude reads it before writing any Jev code, and every lane that calls Jev follows it.

**Jev is a classifier you call like a function. Claude is a writer you call like a colleague. Code is the judge.**

## Setup

- SDK `@typesafe-ai/sdk` (0.6.0, Node 20 or newer). Model string `jev-1.13.0`, pinned in code.
- The key lives in `TYPESAFE_API_KEY`, server side only. Never give it a `NEXT_PUBLIC_` prefix.

## Questions

- All Jev questions live in one file, `lib/ai/jev.ts`.
- Questions are short and neutral. All context goes in state. Untrusted user text is always a state value, never part of a question.
- Every `choice` question has a `not_stated` or `unsure` option, and the options do not overlap.

## Answers

- `score` returns a 0-based, fractional index into the labels, not a 1 to 5 rating.
- `noul` is a probability, not a boolean.
- Always compare answers and confidence against a named threshold constant, such as `JEV_MIN_CONFIDENCE = 0.6`.

## Every call

- Sets `retry: { maxRetries: 0 }` and its own `AbortSignal.timeout(ms)`. The SDK timeout is per attempt.
- Has a low-confidence path and an error path.
- Shows the confidence next to every answer on screen.
- Logs the decision with engine, confidence and latency.

## Fallbacks and language

- Keep a templates mode (`AI_MODE=templates`) so the app still runs if the key fails.
- English first: route non-English text to Claude, or flag it for a person. Deciding which engine sees which text is part of the design.

## Cost

- $0.042 per million input tokens. Output is free.
- Field result: 15,593 bios scored for $0.18 in 24 seconds.

## Windows

- Set the key in PowerShell with `$env:TYPESAFE_API_KEY="..."`, not `export`.
- A pasted key with a trailing space or smart quotes gives an auth error that looks like a bad key.
