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
  { name: "Check-up", aed: 350, from: false, matches: [/\bcheck[\s-]?ups?\b/, /\bexamination\b/, /فحص|كشف/] },
  { name: "Cleaning", aed: 350, from: false, matches: [/\bclean(?:ing|ings)?\b/, /\bscale\b[^.!?]{0,40}\bpolish\b/, /\bhygien/, /تنظيف/] },
  { name: "Filling", aed: 450, from: true, matches: [/\bfill(?:ing|ings)?\b/, /\bcavit(?:y|ies)\b/, /حشو|حشوة/] },
  { name: "Whitening", aed: 1200, from: false, matches: [/\bwhiten(?:ing)?\b/, /\bbleach(?:ing)?\b/, /تبييض/] },
  { name: "Root canal", aed: 2500, from: true, matches: [/\broot[\s-]?canals?\b/, /\bendodont/, /علاج العصب/] },
  { name: "Emergency visit", aed: 300, from: false, matches: [/\bemergency (?:visit|appointment)\b/] },
];

// Treatments the clinic does that are NOT on the price list. Naming one means a person
// must quote it, even when a listed treatment is named too.
const UNLISTED_TREATMENTS = [
  /\bextract(?:ion|ions)?\b/, /\btooth removal\b/, /\bwisdom\b/, /\bimplants?\b/, /\bbraces\b/, /\baligners?\b/,
  /\binvisalign\b/, /\bcrowns?\b/, /\bveneers?\b/, /\bbridges?\b/, /\bdentures?\b/, /\bx-?rays?\b/, /\borthodont/,
  /\bgum (?:surgery|treatment)\b/, /\bsurgery\b/, /خلع|زراعة|تقويم|تاج|قشور|جراحة/,
];

// Words that suggest pain or an emergency. Checked before any price, booking or hours
// answer, so an emergency hidden next to a price word still reaches a person.
export const URGENT_WORDS =
  /\b(?:bleed(?:ing)?|blood|swell(?:ing)?|swollen|pain(?:ful)?|hurt(?:s|ing)?|ache|aching|toothache|broke|broken|chipped|cracked|knocked out|abscess|infect(?:ed|ion)|fever|emergency|urgent(?:ly)?)\b|ألم|وجع|نزيف|تورم|منتفخ|كسر|مكسور|طارئ|عاجل/;

// Cancelling or changing is not a new booking.
export const CANCEL_OR_CHANGE_WORDS =
  /\b(?:cancel(?:l?ed|l?ing|lation)?|resched\w*|postpone\w*|change (?:my|the|our) (?:appointment|booking|time|slot)|move (?:my|the) (?:appointment|booking))\b|إلغاء|الغاء|تغيير الموعد|تأجيل|أجل الموعد/;

// A word the customer says they do NOT want ("no whitening, just cleaning").
const NEGATION_BEFORE = /\b(?:no|not|without|except|instead of|rather than|don['’]?t (?:want|need)|do not (?:want|need))\s+(?:\w+\s+){0,2}$/;

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
  | { kind: "greeting" }
  | { kind: "closing" }
  | { kind: "price"; treatments: { name: string; priceAed: number; from: boolean }[] }
  | { kind: "booking_free"; requested: string }
  | { kind: "booking_taken"; requested: string; nearestFree: string[] }
  // The customer wants to book but did not give a full day and time: offer what is free.
  | { kind: "booking_options"; times: string[]; day: string | null; dayIsFull: boolean }
  | { kind: "hours"; hours: { day: string; open: string; close: string }[]; openNow?: boolean };

// Why a person is needed. It decides how the holding reply sounds.
export type Situation =
  | "emergency"
  | "complaint"
  | "wants_person"
  | "cancel_change"
  | "price_unlisted"
  | "booking_unclear"
  | "other";

export type Decision = {
  action: "answer" | "flag";
  reason: string | null; // why a person is needed, when action is "flag"
  situation: Situation | null; // the kind of handover, when action is "flag"
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
  // A named weekday beats "today" or "tomorrow" ("not today, Friday at 5").
  for (const [pattern, day] of DAY_PATTERNS) {
    if (pattern.test(t)) return { day, addDays: (day - todayDay + 7) % 7 };
  }
  if (/\btoday\b|\btonight\b/.test(t)) return { day: todayDay, addDays: 0 };
  if (/\btomorrow\b/.test(t)) return { day: (todayDay + 1) % 7, addDays: 1 };
  return null;
}

// How many different weekdays the message names. More than one is ambiguous.
function countNamedDays(text: string): number {
  const t = text.toLowerCase();
  return DAY_PATTERNS.filter(([pattern]) => pattern.test(t)).length;
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
  if (!ampm && h >= 9 && h <= 11 && /\b(?:tonight|evening|night)\b/.test(t)) h += 12; // "tonight at 9"
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

// Listed treatments the customer asks about, skipping any they say they do not want.
function readTreatments(text: string): { found: Treatment[]; skipped: string[] } {
  const t = text.toLowerCase();
  const found: Treatment[] = [];
  const skipped: string[] = [];
  for (const item of PRICE_LIST) {
    const mentions = item.matches.flatMap((pattern) => {
      const m = pattern.exec(t);
      return m ? [m.index] : [];
    });
    if (mentions.length === 0) continue;
    // A "no" only reaches back to the last comma, "just", "only" or "but".
    const wanted = mentions.some((index) => {
      const nearby = t.slice(Math.max(0, index - 30), index);
      const clause = nearby.split(/[,.;!?]|\b(?:just|only|but)\b/).pop() ?? "";
      return !NEGATION_BEFORE.test(clause);
    });
    if (wanted) found.push(item);
    else skipped.push(item.name);
  }
  return { found, skipped };
}

function mentionsUnlistedTreatment(text: string): string | null {
  const t = text.toLowerCase();
  for (const pattern of UNLISTED_TREATMENTS) {
    const m = t.match(pattern);
    if (m) return m[0];
  }
  return null;
}

function formatPrice(item: Treatment): string {
  return `${item.from ? "from " : ""}AED ${item.aed.toLocaleString("en-US")}`;
}

// ---------------------------------------------------------------------------
// The rules, one per kind of message
// ---------------------------------------------------------------------------

function flag(reason: string, checks: Check[], situation: Situation = "other"): Decision {
  return { action: "flag", reason, situation, facts: null, checks };
}

// A greeting gets a fixed welcome. A long message that Jev called a greeting probably
// holds a request too, so it goes to a person instead.
const MAX_GREETING_CHARS = 60;

// Words a thank-you, a simple "ok" or a goodbye is made of. Jev proposes "closing", but
// code decides: every word must be on this list, so "ok book it" or "yes please" never
// counts and still goes to a person.
const CLOSING_WORDS = new Set(
  (
    "ok okay okey okk k kk alright all right great perfect awesome nice cool good fine noted got it understood " +
    "thanks thank thankyou thx ty tysm cheers you so very much a lot appreciate appreciated again " +
    "bye goodbye see later take care sir dr doctor team " +
    "شكرا شكر جزيلا مشكور مشكورة تسلم يعطيك العافية تمام حسنا اوكي اوك ماشي طيب ممتاز رائع الى اللقاء مع السلامة الله يعافيك"
  ).split(" "),
);

export function isOnlyClosing(message: string): boolean {
  if (message.length > MAX_GREETING_CHARS) return false;
  const words = message
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0640]/g, "") // Arabic vowel marks and stretching
    .replace(/[أإآ]/g, "ا")
    .replace(/(.)\1{2,}/g, "$1") // "thankssss" -> "thanks"
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  return words.length > 0 && words.every((w) => CLOSING_WORDS.has(w));
}

function closingRule(message: string, checks: Check[]): Decision {
  if (!isOnlyClosing(message)) {
    checks.push({ label: "Only a thank-you or goodbye?", result: "No, there may be more in the message", status: "flag" });
    return flag("The message looks like a thank-you but may hold a request", checks);
  }
  checks.push({ label: "Only a thank-you or goodbye?", result: "Yes", status: "pass" });
  return { action: "answer", reason: null, situation: null, facts: { kind: "closing" }, checks };
}
const MAX_TIMES_OFFERED = 5; // free times listed when the customer names no full day and time

function greetingRule(message: string, checks: Check[]): Decision {
  if (message.length > MAX_GREETING_CHARS) {
    checks.push({ label: "Only a greeting?", result: "No, the message is long and may hold a request", status: "flag" });
    return flag("The message starts like a greeting but is long enough to hold a request", checks);
  }
  checks.push({ label: "Only a greeting?", result: "Yes", status: "pass" });
  return { action: "answer", reason: null, situation: null, facts: { kind: "greeting" }, checks };
}

// Words a plain "what are your prices?" is made of. Jev says it is a price question, but
// code decides it is general: every word must be on this list and one must be about price.
// Any other word ("botox", "straightening") means a specific treatment, so it is not general.
const PRICE_ASK_WORDS = new Set(
  (
    "i we want wanna need would like to know see get have ask about the your ur a an of all what whats are is how much " +
    "do does you it cost costs price prices pricing rate rates fee fees charge charges list treatment treatments " +
    "service services please pls can could me tell give send show share hi hello hey there for and on info information " +
    "details menu per visit dental clinic " +
    "اريد ابغى ابي احتاج عن ما هي هل كم الاسعار اسعار سعر الاسعار التكلفة تكلفة قائمة لو سمحت من فضلك ممكن تفاصيل العلاجات الخدمات"
  ).split(" "),
);
const PRICE_WORDS = /\b(?:price|prices|pricing|cost|costs|rate|rates|fee|fees|charge|charges)\b|how much|اسعار|الاسعار|سعر|تكلفة|التكلفة|كم/;

function isGeneralPriceAsk(message: string): boolean {
  const normalised = message
    .toLowerCase()
    .replace(/[أإآ]/g, "ا")
    .replace(/[\u064B-\u065F\u0640]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalised || normalised.length > 80 || !PRICE_WORDS.test(normalised)) return false;
  return normalised.split(" ").every((w) => PRICE_ASK_WORDS.has(w));
}

function priceRule(message: string, checks: Check[]): Decision {
  const unlisted = mentionsUnlistedTreatment(message);
  if (unlisted) {
    checks.push({ label: "Is every treatment on the price list?", result: `"${unlisted}" is not on the list`, status: "flag" });
    return flag(`A treatment that is not on the price list was mentioned (${unlisted})`, checks, "price_unlisted");
  }
  const { found, skipped } = readTreatments(message);
  if (skipped.length > 0) {
    checks.push({ label: "Treatments the customer does not want", result: skipped.join(", "), status: "info" });
  }
  if (found.length === 0 && skipped.length === 0 && isGeneralPriceAsk(message)) {
    // "I want prices": no treatment named, so show the whole price list.
    checks.push({ label: "Which treatment?", result: "None named, so the whole price list is shown", status: "pass" });
    return {
      action: "answer",
      reason: null,
      situation: null,
      facts: { kind: "price", treatments: PRICE_LIST.map((t) => ({ name: t.name, priceAed: t.aed, from: t.from })) },
      checks,
    };
  }
  if (found.length === 0) {
    checks.push({ label: "Is the treatment on the price list?", result: "No treatment from the list was named", status: "flag" });
    return flag("The treatment is not on the price list", checks, "price_unlisted");
  }
  checks.push({
    label: "Is the treatment on the price list?",
    result: found.map((f) => `${f.name}: ${formatPrice(f)}`).join("; "),
    status: "pass",
  });
  return {
    action: "answer",
    reason: null,
    situation: null,
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
      situation: null,
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
    situation: null,
    facts: { kind: "hours", hours: [hoursEntry(day.day)], openNow },
    checks,
  };
}

function bookingRule(message: string, now: Date, checks: Check[]): Decision {
  if (CANCEL_OR_CHANGE_WORDS.test(message.toLowerCase())) {
    checks.push({ label: "New booking?", result: "No, this is a cancel or change request", status: "flag" });
    return flag("The customer wants to cancel or change an appointment", checks, "cancel_change");
  }
  if (countNamedDays(message) > 1) {
    checks.push({ label: "Read the requested day and time", result: "More than one day was named", status: "flag" });
    return flag("The booking request names more than one day", checks, "booking_unclear");
  }
  const day = readDay(message, now);
  const time = readTime(message);
  if (!day || !time) {
    // No full day and time: offer what is free instead of giving up.
    const missing = !day && !time ? "day or time" : !day ? "day" : "time";
    checks.push({ label: "Read the requested day and time", result: `No ${missing} given, so free times will be offered`, status: "info" });
    const upcoming = freeSlots(now);
    const onDay = day ? upcoming.filter((slot) => new Date(slot).getUTCDay() === day.day) : [];
    const times = (onDay.length > 0 ? onDay : upcoming).slice(0, MAX_TIMES_OFFERED).map(describe);
    if (times.length === 0) {
      checks.push({ label: "Free times to offer", result: "No free times left this week", status: "flag" });
      return flag("No free times are left this week", checks, "booking_unclear");
    }
    checks.push({
      label: onDay.length > 0 ? `Free times on ${DAY_NAMES[day!.day]}` : "Next free times",
      result: times.join(", "),
      status: "pass",
    });
    return {
      action: "answer",
      reason: null,
      situation: null,
      facts: {
        kind: "booking_options",
        times,
        day: day ? DAY_NAMES[day.day] : null,
        dayIsFull: Boolean(day) && onDay.length === 0,
      },
      checks,
    };
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
      situation: null,
      facts: { kind: "booking_free", requested: describe(wanted) },
      checks,
    };
  }

  checks.push({ label: "Is that time free?", result: "No, it is not available", status: "info" });
  const nearest = [...free].sort((a, b) => Math.abs(a - wanted) - Math.abs(b - wanted) || a - b).slice(0, 2);
  if (nearest.length === 0) {
    checks.push({ label: "Two nearest free times", result: "No free times left this week", status: "flag" });
    return flag("No free times are left this week", checks, "booking_unclear");
  }
  const options = nearest.sort((a, b) => a - b).map(describe);
  checks.push({ label: "Two nearest free times", result: options.join(" or "), status: "pass" });
  return {
    action: "answer",
    reason: null,
    situation: null,
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
  const language = answer("language");

  // "Yes" counts at any confidence: a person is never the wrong answer here.
  const wantsPerson = person.label === "yes";
  checks.push({
    label: "Asked for a person?",
    result: wantsPerson && person.unsure ? "yes (low confidence, so a person looks anyway)" : person.answer.replaceAll("_", " "),
    status: wantsPerson ? "flag" : "pass",
  });
  if (wantsPerson) return flag("The customer asked for a person", checks, "wants_person");

  // The reply checks only understand English and Arabic, so other languages go to a person.
  const supportedLanguage = !language.unsure && (language.label === "english" || language.label === "arabic");
  checks.push({
    label: "Language the reply checks understand?",
    result: supportedLanguage ? language.label : `${language.answer.replaceAll("_", " ")} (English and Arabic only)`,
    status: supportedLanguage ? "pass" : "flag",
  });
  if (!supportedLanguage) return flag("The message is not clearly English or Arabic", checks);

  const urgent = message.toLowerCase().match(URGENT_WORDS)?.[0];
  checks.push({
    label: "Urgent or pain words in the message?",
    result: urgent ? `Yes ("${urgent}")` : "None found",
    status: urgent ? "flag" : "pass",
  });
  if (urgent) return flag("Possible emergency (urgent words in the message)", checks, "emergency");

  checks.push({
    label: "What does the customer want?",
    result: intent.answer.replaceAll("_", " "),
    status: ["greeting", "closing", "price_question", "booking", "opening_hours"].includes(intent.answer) ? "pass" : "flag",
  });

  switch (intent.answer) {
    case "greeting":
      return greetingRule(message, checks);
    case "closing":
      return closingRule(message, checks);
    case "price_question":
      return priceRule(message, checks);
    case "booking":
      return bookingRule(message, now, checks);
    case "opening_hours":
      return hoursRule(message, now, checks);
    case "emergency":
      return flag("Possible emergency", checks, "emergency");
    case "complaint":
      return flag("The customer is making a complaint", checks, "complaint");
    case "other":
      // Jev often says "other" or "not sure" for a plain "ok" or "thanks"; code recognises those.
      if (isOnlyClosing(message)) return closingRule(message, checks);
      return flag("The request is not something the rules cover", checks);
    default: // "not sure", including any answer under the confidence threshold
      if (isOnlyClosing(message)) return closingRule(message, checks);
      return flag("The message was not clear enough to act on", checks);
  }
}
