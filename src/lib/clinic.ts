// The clinic's rules as plain code. No AI in here: Jev sorts the message, and
// this file decides what happens next. Same input, same answer, every time.

import type { Classification } from "./jev";

// ---------------------------------------------------------------------------
// The clinic's facts
// ---------------------------------------------------------------------------

// Dubai has no daylight saving, so a fixed offset is enough.
const CLINIC_UTC_OFFSET_HOURS = 4;

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// Opening hours by weekday (0 = Sunday). Saturday to Thursday 9:00 to 21:00, Friday 16:00 to 21:00.
const OPENING_HOURS: Record<number, { open: string; close: string }> = {
  0: { open: "09:00", close: "21:00" },
  1: { open: "09:00", close: "21:00" },
  2: { open: "09:00", close: "21:00" },
  3: { open: "09:00", close: "21:00" },
  4: { open: "09:00", close: "21:00" },
  5: { open: "16:00", close: "21:00" },
  6: { open: "09:00", close: "21:00" },
};

type Treatment = {
  name: string;
  aed: number;
  from: boolean; // true means "from AED x"
  matches: RegExp[]; // how a customer might name it
};

const PRICE_LIST: Treatment[] = [
  { name: "Check-up", aed: 350, from: false, matches: [/\bcheck[\s-]?ups?\b/, /\bexam(?:ination)?s?\b/, /فحص|كشف/] },
  { name: "Cleaning", aed: 350, from: false, matches: [/\bclean(?:ing|ings)?\b/, /\bscale\b.*\bpolish\b/, /\bhygien/, /تنظيف/] },
  { name: "Filling", aed: 450, from: true, matches: [/\bfill(?:ing|ings)?\b/, /\bcavit(?:y|ies)\b/, /حشو|حشوة/] },
  { name: "Whitening", aed: 1200, from: false, matches: [/\bwhiten(?:ing)?\b/, /\bbleach(?:ing)?\b/, /تبييض/] },
  { name: "Root canal", aed: 2500, from: true, matches: [/\broot[\s-]?canals?\b/, /\bendodont/, /علاج العصب/] },
  { name: "Emergency visit", aed: 300, from: false, matches: [/\bemergency (?:visit|appointment)\b/] },
];

// This week's free appointment times (30 minutes each). Every one sits inside the
// opening hours above. They repeat weekly so the demo never goes stale.
const FREE_SLOT_PATTERN: { day: number; time: string }[] = [
  { day: 6, time: "10:00" }, // Saturday
  { day: 6, time: "15:30" }, // Saturday
  { day: 0, time: "09:30" }, // Sunday
  { day: 0, time: "18:00" }, // Sunday
  { day: 1, time: "11:00" }, // Monday
  { day: 2, time: "14:00" }, // Tuesday
  { day: 3, time: "10:30" }, // Wednesday
  { day: 3, time: "19:00" }, // Wednesday
  { day: 4, time: "17:30" }, // Thursday
  { day: 5, time: "17:00" }, // Friday
];

// ---------------------------------------------------------------------------
// What the rest of the app sees
// ---------------------------------------------------------------------------

export type Check = {
  label: string;
  result: string;
  status: "pass" | "flag" | "info";
};

// The facts the code found. These are the only facts Claude is allowed to use.
export type Facts =
  | { kind: "price"; treatments: { name: string; priceAed: number; from: boolean }[] }
  | { kind: "booking_free"; requested: string }
  | { kind: "booking_taken"; requested: string; nearestFree: string[] }
  | { kind: "hours"; hours: { day: string; open: string; close: string }[]; openNow?: boolean };

export type Decision = {
  action: "answer" | "flag";
  reason: string | null; // why a person is needed, when action is "flag"
  facts: Facts | null; // what the code found, when action is "answer"
  checks: Check[];
};

// ---------------------------------------------------------------------------
// Time helpers. "Wall time" = the clinic's clock, stored as if it were UTC.
// ---------------------------------------------------------------------------

function wallNow(now: Date): number {
  return now.getTime() + CLINIC_UTC_OFFSET_HOURS * 3_600_000;
}

function wallAt(baseWall: number, addDays: number, hhmm: string): number {
  const d = new Date(baseWall);
  const [h, m] = hhmm.split(":").map(Number);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + addDays, h, m);
}

function hhmm(wall: number): string {
  const d = new Date(wall);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

function describe(wall: number): string {
  const d = new Date(wall);
  return `${DAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]} at ${hhmm(wall)}`;
}

// The next time a weekday and clock time happens, from now (up to a week ahead).
function nextOccurrence(day: number, time: string, now: Date): number {
  const base = wallNow(now);
  for (let add = 0; add <= 7; add++) {
    const candidate = wallAt(base, add, time);
    if (new Date(candidate).getUTCDay() === day && candidate > base) return candidate;
  }
  return wallAt(base, 7, time);
}

function freeSlots(now: Date): number[] {
  return FREE_SLOT_PATTERN.map((s) => nextOccurrence(s.day, s.time, now)).sort((a, b) => a - b);
}

function openingHoursFor(day: number): string {
  const h = OPENING_HOURS[day];
  return `${h.open} to ${h.close}`;
}

function hoursEntry(day: number): { day: string; open: string; close: string } {
  return { day: DAY_NAMES[day], ...OPENING_HOURS[day] };
}

function isOpenAt(wall: number): boolean {
  const h = OPENING_HOURS[new Date(wall).getUTCDay()];
  const t = hhmm(wall);
  return t >= h.open && t < h.close;
}

// ---------------------------------------------------------------------------
// Reading the customer's words (plain patterns, no AI)
// ---------------------------------------------------------------------------

const DAY_PATTERNS: [RegExp, number][] = [
  [/\bsun(?:day)?\b/, 0],
  [/\bmon(?:day)?\b/, 1],
  [/\btue(?:s|sday)?\b/, 2],
  [/\bwed(?:nesday)?\b/, 3],
  [/\bthu(?:r|rs|rsday)?\b/, 4],
  [/\bfri(?:day)?\b/, 5],
  [/\bsat(?:urday)?\b/, 6],
];

// Returns the weekday (0 = Sunday) and how many days from today it is, or null.
function readDay(text: string, now: Date): { day: number; addDays: number } | null {
  const t = text.toLowerCase();
  const todayDay = new Date(wallNow(now)).getUTCDay();
  if (/\btoday\b|\btonight\b/.test(t)) return { day: todayDay, addDays: 0 };
  if (/\btomorrow\b/.test(t)) return { day: (todayDay + 1) % 7, addDays: 1 };
  for (const [pattern, day] of DAY_PATTERNS) {
    if (pattern.test(t)) return { day, addDays: (day - todayDay + 7) % 7 };
  }
  return null;
}

// Clinic hours start at 9, so a bare "at 5" means 17:00.
function readTime(text: string): string | null {
  const t = text.toLowerCase();
  if (/\bnoon\b/.test(t)) return "12:00";
  const m =
    t.match(/(?:\bat|\baround|@)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/) ??
    t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/) ??
    t.match(/\b(\d{1,2}):(\d{2})\b/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ampm = m[3];
  if (h > 23 || min > 59) return null;
  if (ampm === "pm" && h < 12) h += 12;
  if (ampm === "am" && h === 12) h = 0;
  if (!ampm && h >= 1 && h <= 8) h += 12;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function readTreatments(text: string): Treatment[] {
  const t = text.toLowerCase();
  return PRICE_LIST.filter((item) => item.matches.some((pattern) => pattern.test(t)));
}

function formatPrice(item: Treatment): string {
  return `${item.from ? "from " : ""}AED ${item.aed.toLocaleString("en-US")}`;
}

// ---------------------------------------------------------------------------
// The rules, one per kind of message
// ---------------------------------------------------------------------------

function flag(reason: string, checks: Check[]): Decision {
  return { action: "flag", reason, facts: null, checks };
}

function priceRule(message: string, checks: Check[]): Decision {
  const found = readTreatments(message);
  if (found.length === 0) {
    checks.push({ label: "Is the treatment on the price list?", result: "No treatment from the list was named", status: "flag" });
    return flag("The treatment is not on the price list", checks);
  }
  checks.push({
    label: "Is the treatment on the price list?",
    result: found.map((f) => `${f.name}: ${formatPrice(f)}`).join("; "),
    status: "pass",
  });
  return {
    action: "answer",
    reason: null,
    facts: { kind: "price", treatments: found.map((f) => ({ name: f.name, priceAed: f.aed, from: f.from })) },
    checks,
  };
}

function hoursRule(message: string, now: Date, checks: Check[]): Decision {
  const day = readDay(message, now);
  if (!day) {
    checks.push({ label: "Opening hours", result: "No day named, so the full week applies", status: "info" });
    return {
      action: "answer",
      reason: null,
      facts: { kind: "hours", hours: DAY_NAMES.map((_, d) => hoursEntry(d)) },
      checks,
    };
  }
  const name = DAY_NAMES[day.day];
  const wantsNow = /\bnow\b/.test(message.toLowerCase()) && day.addDays === 0;
  checks.push({ label: `Opening hours on ${name}`, result: openingHoursFor(day.day), status: "pass" });
  let openNow: boolean | undefined;
  if (wantsNow) {
    openNow = isOpenAt(wallNow(now));
    checks.push({ label: "Open right now?", result: openNow ? "Yes" : "No", status: "info" });
  }
  return {
    action: "answer",
    reason: null,
    facts: { kind: "hours", hours: [hoursEntry(day.day)], openNow },
    checks,
  };
}

function bookingRule(message: string, now: Date, checks: Check[]): Decision {
  const day = readDay(message, now);
  const time = readTime(message);
  if (!day || !time) {
    const missing = !day && !time ? "day or time" : !day ? "day" : "time";
    checks.push({ label: "Read the requested day and time", result: `Could not find a ${missing}`, status: "flag" });
    return flag(`The booking request has no clear ${missing}`, checks);
  }
  const wanted = wallAt(wallNow(now), day.addDays, time);
  checks.push({ label: "Read the requested day and time", result: describe(wanted), status: "pass" });

  const open = isOpenAt(wanted);
  checks.push({
    label: "Is the clinic open then?",
    result: open ? `Yes (${openingHoursFor(day.day)})` : `No (open ${openingHoursFor(day.day)})`,
    status: "info",
  });

  const free = freeSlots(now);
  if (free.includes(wanted)) {
    checks.push({ label: "Is that time free?", result: "Yes, it is free", status: "pass" });
    return {
      action: "answer",
      reason: null,
      facts: { kind: "booking_free", requested: describe(wanted) },
      checks,
    };
  }

  checks.push({ label: "Is that time free?", result: "No, it is not available", status: "info" });
  const nearest = [...free].sort((a, b) => Math.abs(a - wanted) - Math.abs(b - wanted) || a - b).slice(0, 2);
  if (nearest.length === 0) {
    checks.push({ label: "Two nearest free times", result: "No free times left this week", status: "flag" });
    return flag("No free times are left this week", checks);
  }
  const options = nearest.sort((a, b) => a - b).map(describe);
  checks.push({ label: "Two nearest free times", result: options.join(" or "), status: "pass" });
  return {
    action: "answer",
    reason: null,
    facts: { kind: "booking_taken", requested: describe(wanted), nearestFree: options },
    checks,
  };
}

// ---------------------------------------------------------------------------
// The one function the rest of the app calls
// ---------------------------------------------------------------------------

export function applyClinicRules(
  message: string,
  classification: Classification,
  now: Date = new Date(),
): Decision {
  const checks: Check[] = [];

  if (!classification.ok) {
    checks.push({ label: "Message sorted?", result: "No, the classifier failed", status: "flag" });
    return flag("The message could not be sorted", checks);
  }

  const answer = (q: string) => classification.answers.find((a) => a.question === q)!;
  const intent = answer("intent");
  const person = answer("wants_person");

  checks.push({ label: "Asked for a person?", result: person.answer.replaceAll("_", " "), status: person.answer === "yes" ? "flag" : "pass" });
  if (person.answer === "yes") return flag("The customer asked for a person", checks);

  checks.push({
    label: "What does the customer want?",
    result: intent.answer.replaceAll("_", " "),
    status: ["price_question", "booking", "opening_hours"].includes(intent.answer) ? "pass" : "flag",
  });

  switch (intent.answer) {
    case "price_question":
      return priceRule(message, checks);
    case "booking":
      return bookingRule(message, now, checks);
    case "opening_hours":
      return hoursRule(message, now, checks);
    case "emergency":
      return flag("Possible emergency", checks);
    case "complaint":
      return flag("The customer is making a complaint", checks);
    case "other":
      return flag("The request is not something the rules cover", checks);
    default: // "not sure", including any answer under the confidence threshold
      return flag("The message was not clear enough to act on", checks);
  }
}
