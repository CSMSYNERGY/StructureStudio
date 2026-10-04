// My Synergy Phone — the pure half of portal-settings' calling actions (2026-09-29).
//
// Everything in here is a function of its arguments: no database, no Deno.env, no Twilio. The
// handlers in index.ts read the rows and write the results; this file decides whether a route
// the owner typed is valid and what the Calls report says about a pile of rows. It is a
// separate module for one reason — index.ts calls Deno.serve at import time, so nothing in it
// can be unit-tested, and these are exactly the rules that need tests.
//
// The contract these follow is the My Synergy Phone SPEC (structure-studio-phone/docs/SPEC.md,
// section 2): phone_routes' columns and CHECK constraints are mirrored here so a bad value is
// refused with a sentence the owner can act on, instead of a Postgres constraint name.

import { effectiveAccess, type Level } from "../_shared/access.ts";

/** The seven keys business_hours uses, in the order the Settings screen shows them. */
export const PHONE_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type PhoneDay = typeof PHONE_DAYS[number];
export type BusinessHours = Partial<Record<PhoneDay, [string, string][]>>;

/** Twilio rings at most ten <Client>s in one <Dial> (plan section 8). */
export const MAX_ROUTE_MEMBERS = 10;
/** phone_routes.ring_seconds CHECK (ring_seconds between 5 and 60). */
export const RING_MIN = 5;
export const RING_MAX = 60;
/** More opening periods than this in one day is a typo, not a timetable. */
const MAX_PERIODS_PER_DAY = 4;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/**
 * A US or Canadian number in E.164, or null.
 *
 * NANP only, on purpose: the plan turns Twilio's voice geo permissions down to the US and
 * Canada (section 14, toll fraud), so a forward to anywhere else would be accepted here and
 * then fail on every call. Refusing it at the door says why; failing at 2am does not.
 * Area codes and exchanges cannot start with 0 or 1, which also catches most mistyped digits.
 */
export function nanpE164(raw: unknown): string | null {
  const d = String(raw ?? "").replace(/\D/g, "");
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(ten)) return null;
  return `+1${ten}`;
}

/** Is this an IANA time zone this runtime can actually compute business hours in? */
export function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64 || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_LABEL: Record<PhoneDay, string> = {
  mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday",
};

/**
 * business_hours as the owner sent it → the stored jsonb, or a sentence saying what is wrong.
 *
 * null means ALWAYS OPEN (SPEC: "null = always open"), which is different from an object whose
 * every day is empty — that one is "closed all week", and every call goes to the after-hours
 * action. Both are legitimate, so the two are never collapsed into each other.
 *
 * A day that is missing or empty is closed. Periods must run forward within the day: an
 * overnight period (22:00-06:00) is written as two, one on each day, which is what a builder
 * with a night shift would expect the screen to show anyway.
 */
export function parseBusinessHours(raw: unknown): { ok: true; value: BusinessHours | null } | { ok: false; error: string } {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Business hours were not in a shape we recognise." };
  const out: BusinessHours = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(PHONE_DAYS as readonly string[]).includes(k)) return { ok: false, error: "Business hours were not in a shape we recognise." };
    const day = k as PhoneDay;
    if (!Array.isArray(v)) return { ok: false, error: `${DAY_LABEL[day]}'s hours were not in a shape we recognise.` };
    if (v.length > MAX_PERIODS_PER_DAY) return { ok: false, error: `${DAY_LABEL[day]} has more than ${MAX_PERIODS_PER_DAY} opening periods.` };
    const periods: [string, string][] = [];
    for (const p of v) {
      if (!Array.isArray(p) || p.length !== 2 || !HHMM.test(String(p[0])) || !HHMM.test(String(p[1]))) {
        return { ok: false, error: `${DAY_LABEL[day]} has a time that isn't in hours and minutes.` };
      }
      const [open, close] = [String(p[0]), String(p[1])];
      if (open >= close) return { ok: false, error: `On ${DAY_LABEL[day]}, the closing time has to be after the opening time.` };
      periods.push([open, close]);
    }
    periods.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    for (let i = 1; i < periods.length; i++) {
      if (periods[i][0] < periods[i - 1][1]) return { ok: false, error: `${DAY_LABEL[day]}'s opening periods overlap.` };
    }
    if (periods.length) out[day] = periods;
  }
  return { ok: true, value: out };
}

/** A greeting the phone can play: https, and a length Twilio will accept in <Play>. */
export function parseGreetingUrl(raw: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  const s = String(raw ?? "").trim();
  if (!s) return { ok: true, value: null };
  if (s.length > 500) return { ok: false, error: "That greeting link is too long." };
  try {
    const u = new URL(s);
    if (u.protocol !== "https:") return { ok: false, error: "The greeting has to be an https:// link to an audio file." };
    return { ok: true, value: u.toString() };
  } catch {
    return { ok: false, error: "The greeting link isn't a web address." };
  }
}

export type RouteRow = {
  mode: "all_at_once" | "in_order";
  members: string[];
  ring_seconds: number;
  no_answer: "voicemail" | "forward";
  forward_to: string | null;
  business_hours: BusinessHours | null;
  time_zone: string;
  after_hours: "voicemail" | "forward";
  greeting_url: string | null;
};

/**
 * The owner's setup form → a phone_routes row, or the first thing wrong with it.
 *
 * `eligible` is every user id on THIS tenant whose phone level is not 'none' (SPEC: "only
 * people with phone access (own or higher) can be assigned"). It is computed by the caller from
 * client_users, never taken from the request, so a member list cannot name somebody on another
 * builder's team or somebody whose access was switched off.
 *
 * `names` is only for the refusal sentence — a uuid means nothing to the person reading it.
 */
export function parseRoute(
  p: Record<string, unknown>,
  eligible: Set<string>,
  names: Map<string, string | null> = new Map(),
): { ok: true; row: RouteRow } | { ok: false; error: string } {
  const mode = p.mode === "in_order" ? "in_order" : p.mode === "all_at_once" || p.mode == null ? "all_at_once" : null;
  if (!mode) return { ok: false, error: "Choose whether the team rings all at once or one after another." };

  const rawMembers = Array.isArray(p.members) ? p.members : p.members == null ? [] : null;
  if (!rawMembers) return { ok: false, error: "The list of people who answer calls was not in a shape we recognise." };
  const members: string[] = [];
  for (const m of rawMembers) {
    if (!isUuid(m)) return { ok: false, error: "One of the people chosen to answer calls isn't on your team." };
    const id = m.toLowerCase();
    if (members.includes(id)) continue;                 // a double tick is not an error, just noise
    if (!eligible.has(id)) {
      const who = names.get(id);
      return {
        ok: false,
        error: who
          ? `${who} doesn't have Phone access, so their phone can't ring. Change it on the Team tab first.`
          : "One of the people chosen to answer calls isn't on your team, or doesn't have Phone access.",
      };
    }
    members.push(id);
  }
  if (members.length > MAX_ROUTE_MEMBERS) {
    return { ok: false, error: `Up to ${MAX_ROUTE_MEMBERS} people can answer one number.` };
  }

  const ring = Number(p.ringSeconds ?? 20);
  if (!Number.isInteger(ring) || ring < RING_MIN || ring > RING_MAX) {
    return { ok: false, error: `Ring time has to be between ${RING_MIN} and ${RING_MAX} seconds.` };
  }

  const noAnswer = p.noAnswer === "forward" ? "forward" : p.noAnswer === "voicemail" || p.noAnswer == null ? "voicemail" : null;
  if (!noAnswer) return { ok: false, error: "Choose what happens when nobody answers." };
  const afterHours = p.afterHours === "forward" ? "forward" : p.afterHours === "voicemail" || p.afterHours == null ? "voicemail" : null;
  if (!afterHours) return { ok: false, error: "Choose what happens outside business hours." };

  // A forward number is stored only when something forwards to it — an old number left in a
  // hidden field would otherwise ring a cell nobody meant to ring the day someone flips a switch.
  const wantsForward = noAnswer === "forward" || afterHours === "forward";
  const forwardRaw = String(p.forwardTo ?? "").trim();
  const forwardTo = forwardRaw ? nanpE164(forwardRaw) : null;
  if (forwardRaw && !forwardTo) return { ok: false, error: "The forwarding number has to be a US or Canadian phone number." };
  if (wantsForward && !forwardTo) return { ok: false, error: "Add the cell number calls should forward to." };

  const hours = parseBusinessHours(p.businessHours);
  if (!hours.ok) return hours;

  const tz = p.timeZone == null || p.timeZone === "" ? "America/Chicago" : p.timeZone;
  if (!validTimeZone(tz)) return { ok: false, error: "Choose your business's time zone." };

  const greeting = parseGreetingUrl(p.greetingUrl);
  if (!greeting.ok) return greeting;

  return {
    ok: true,
    row: {
      mode, members, ring_seconds: ring, no_answer: noAnswer,
      forward_to: wantsForward ? forwardTo : null,
      business_hours: hours.value, time_zone: tz, after_hours: afterHours,
      greeting_url: greeting.value,
    },
  };
}

/** A client_users row → that person's phone level, through the ONE resolver (access.ts). */
export function phoneLevelOf(row: { role?: string | null; title?: unknown; access?: unknown }): Level {
  const acc = effectiveAccess(row.role ?? null, row.title, (row.access ?? null) as Record<string, unknown> | null);
  return (acc.phone as Level | undefined) ?? "none";
}

// ── The Calls report ─────────────────────────────────────────────────────────────────────

export type ReportCall = {
  id: string;
  direction: "in" | "out" | string;
  status: string | null;
  placed_by: string | null;
  answered_by: string | null;
  rang_user_ids: string[] | null;
  duration_s: number | null;
  answered_at: string | null;
  contact_id: string | null;
};
export type ReportText = { direction: "in" | "out" | string; sent_by: string | null; contact_id: string | null };

export type ReportLine = {
  userId: string | null;
  name: string;
  callsIn: number;
  callsOut: number;
  answered: number;
  missed: number;
  voicemails: number;
  talkSeconds: number;
  avgSeconds: number | null;
  textsSent: number;
  textsReceived: number;
};

/** Still ringing or on the line: not yet answered OR missed, so it counts as neither. */
const LIVE = new Set(["ringing", "in_progress"]);

const blank = (userId: string | null, name: string): ReportLine => ({
  userId, name, callsIn: 0, callsOut: 0, answered: 0, missed: 0, voicemails: 0,
  talkSeconds: 0, avgSeconds: null, textsSent: 0, textsReceived: 0,
});

/**
 * Rows → one line per person, plus the business-wide totals.
 *
 * THE COUNTING RULES (plan section 7, "What makes a call or text mine"):
 *   • Calls out     — outbound calls they PLACED.
 *   • Calls in      — inbound calls that RANG them (rang_user_ids) or that they answered (a
 *                     transfer lands on someone the number never rang).
 *   • Answered      — inbound calls they answered.
 *   • Missed        — inbound calls that rang them and that NOBODY answered, counted against
 *                     every person rung. A call a teammate picked up is not a miss for the
 *                     others; it rang them and was handled.
 *   • Voicemails    — the missed calls above that ended in a voicemail.
 *   • Avg length    — over the calls they actually talked on (answered inbound, and outbound
 *                     that connected), so a wall of unanswered dials does not drag it to zero.
 *   • Texts sent    — sms_messages.sent_by.
 *   • Texts received— inbound texts on customers ASSIGNED to them (crm_contacts.owner_user_id).
 *                     An inbound text on nobody's customer belongs to the whole team, so it is
 *                     in the totals and on no one's line.
 *
 * THE TOTALS ARE NOT THE SUM OF THE LINES, deliberately: a call that rang three people is one
 * missed call for the business and one miss on each of three lines.
 *
 * `people` is who gets a line even with nothing to show (the team, or just "me"). Anyone else
 * who appears in the rows — somebody who has since left, or lost Phone access — still gets a
 * line when `includeOthers` is set, named by `nameOf`, so the business totals add up to
 * something a reader can see.
 */
export function buildCallsReport(opts: {
  calls: ReportCall[];
  texts: ReportText[];
  voicemailCallIds: Set<string>;
  contactOwner: Map<string, string | null>;
  people: { userId: string; name: string }[];
  includeOthers: boolean;
  nameOf: (userId: string) => string;
}): { lines: ReportLine[]; totals: ReportLine } {
  const lines = new Map<string, ReportLine>();
  for (const p of opts.people) lines.set(p.userId, blank(p.userId, p.name));
  const line = (uid: string | null | undefined): ReportLine | null => {
    if (!uid) return null;
    const hit = lines.get(uid);
    if (hit) return hit;
    if (!opts.includeOthers) return null;
    const made = blank(uid, opts.nameOf(uid));
    lines.set(uid, made);
    return made;
  };
  const talked = new Map<string, number>();     // userId → calls they talked on
  const totals = blank(null, "Everyone");
  let totalTalked = 0;

  for (const c of opts.calls) {
    const dur = Math.max(0, Number(c.duration_s) || 0);
    const live = LIVE.has(String(c.status ?? ""));
    const hadVoicemail = opts.voicemailCallIds.has(c.id) || c.status === "voicemail";
    if (c.direction === "out") {
      totals.callsOut++;
      const who = line(c.placed_by);
      if (who) who.callsOut++;
      if (c.answered_at && dur > 0) {
        totals.talkSeconds += dur; totalTalked++;
        if (who) { who.talkSeconds += dur; talked.set(who.userId!, (talked.get(who.userId!) ?? 0) + 1); }
      }
      continue;
    }
    if (c.direction !== "in") continue;
    totals.callsIn++;
    const rang = new Set((c.rang_user_ids ?? []).filter(Boolean));
    if (c.answered_by) rang.add(c.answered_by);        // a transferred-to teammate was rung too
    for (const uid of rang) { const l = line(uid); if (l) l.callsIn++; }
    // ANSWERED IS answered_at, NOT ONLY answered_by — the timeline's rule (crmFeed callFeedEvents).
    // The Worker stamps answered_at with NO answered_by on two real paths: the route's forward
    // number picking up (/voice/screen has no user for it), and a cold transfer nobody took
    // (the transfer clears answered_by; fileVoicemail: "an answered call that ended in voicemail
    // stays answered"). Keyed on answered_by alone, both read as MISSED — for the business, and
    // on the line of every person rung, including the one who talked to the customer.
    if (c.answered_by || (c.answered_at && !live)) {
      totals.answered++;
      const who = line(c.answered_by);
      if (who) who.answered++;
      if (dur > 0) {
        totals.talkSeconds += dur; totalTalked++;
        if (who) { who.talkSeconds += dur; talked.set(who.userId!, (talked.get(who.userId!) ?? 0) + 1); }
      }
    } else if (!live) {
      totals.missed++;
      if (hadVoicemail) totals.voicemails++;
      for (const uid of (c.rang_user_ids ?? [])) {
        const l = line(uid);
        if (!l) continue;
        l.missed++;
        if (hadVoicemail) l.voicemails++;
      }
    }
  }

  for (const t of opts.texts) {
    if (t.direction === "out") {
      totals.textsSent++;
      const who = line(t.sent_by);
      if (who) who.textsSent++;
    } else if (t.direction === "in") {
      totals.textsReceived++;
      const owner = t.contact_id ? (opts.contactOwner.get(t.contact_id) ?? null) : null;
      const who = line(owner);
      if (who) who.textsReceived++;
    }
  }

  for (const l of lines.values()) {
    const n = talked.get(l.userId!) ?? 0;
    l.avgSeconds = n ? Math.round(l.talkSeconds / n) : null;
  }
  totals.avgSeconds = totalTalked ? Math.round(totals.talkSeconds / totalTalked) : null;

  // The people the report was ASKED about keep their order; anyone found in the rows follows,
  // busiest first, so a former employee's history is visible without pushing the team down.
  const asked = new Set(opts.people.map((p) => p.userId));
  const found = [...lines.values()].filter((l) => !asked.has(l.userId!))
    .sort((a, b) => (b.callsIn + b.callsOut + b.textsSent) - (a.callsIn + a.callsOut + a.textsSent));
  return { lines: [...opts.people.map((p) => lines.get(p.userId)!), ...found], totals };
}

/**
 * Does a row survive the contacts row scope (contacts:'own', migration 193)?
 *
 * SPEC/plan section 7: a call or text about a contact is shown only to someone whose contacts
 * access lets them see that contact — "whether in the app, the Team view, the report or a
 * live update". A report is aggregates, but a count is still information about a customer, so
 * it is filtered the same way the lists are:
 *   • a row about a contact they can see       → kept;
 *   • a row about a contact they cannot see    → dropped;
 *   • a row about NO contact (an unknown number)→ kept only if it is their own call or text.
 *     Plan: an unknown number belongs to people whose contacts access is view or edit, and a
 *     user limited to their own customers sees it once someone saves and assigns the contact.
 */
export function keepForOwnScope(contactId: string | null, visible: Set<string>, isMine: boolean): boolean {
  if (contactId) return visible.has(contactId);
  return isMine;
}

// ── "Save as contact" (crm_create_contact) ───────────────────────────────────────────────

/** The sentence crm_save_contact answers a duplicate phone with. ONE copy, so the two actions
 *  can never drift into two different refusals for the same fact. */
export const DUPLICATE_PHONE_SENTENCE =
  "Another contact already has that phone number. Open that contact instead, or clear the number there first.";

/**
 * The My Synergy Phone apps' "Save as contact" body → what crm_create_contact is called with, or a
 * sentence. Contract (extension/src/ui/client.ts, mobile/src/lib/portalActions.ts):
 * `{ name, phone: "<E.164>", source: "phone" }`.
 *
 *   name    required: the apps refuse a blank one before sending, and a contact saved with no
 *           name reads as a number in every list, which is the thing the person was fixing.
 *           Runs of whitespace collapse; 200 characters, crm_save_contact's cap.
 *   phone   E.164 only (the SPEC's shape), as the apps show it. A US or Canadian number is
 *           STORED the way the rest of the CRM stores phones, "(816) 555-0142", so a saved
 *           contact looks like every other one; crm_phone_key keys both forms identically, so
 *           the re-link and the duplicate check are unaffected. Anything else is stored as sent.
 *   source  "phone", or absent. Any other value is refused rather than stored: this action is
 *           the phone's door, and a second source through it would be a mislabelled row.
 */
export function parseCreateContact(raw: Record<string, unknown>):
  { ok: true; name: string; phone: string } | { ok: false; error: string } {
  const name = String(raw?.name ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (!name) return { ok: false, error: "Type the customer's name." };
  const e164 = String(raw?.phone ?? "").trim();
  if (!/^\+[1-9]\d{6,14}$/.test(e164)) {
    return { ok: false, error: "That phone number isn't complete. Save it from the number My Synergy Phone shows." };
  }
  const src = raw?.source ?? "phone";
  if (src !== "phone") return { ok: false, error: "Contacts saved here come from My Synergy Phone." };
  const nanp = /^\+1([2-9]\d{2})([2-9]\d{2})(\d{4})$/.exec(e164);
  return { ok: true, name, phone: nanp ? `(${nanp[1]}) ${nanp[2]}-${nanp[3]}` : e164 };
}

// ── The rollout switch, on the server (plan D9, review SSB-1) ───────────────────────────────

/**
 * Is My Synergy Phone open to every builder yet? PHONE_SELF_SERVE=on in the edge environment is the
 * builder-launch switch (plan phase 6, "self-serve switch-on in Settings"). Until it is set,
 * every action that turns calling on, points a number at My Synergy Phone, or rents a number needs a
 * CSM Synergy operator (app_operators) — the browser's ssPhoneOffered() only decides what is
 * DRAWN, and beta hosts draw the Phone tab for everyone on the one database and the one Twilio
 * account production uses.
 *
 * The blocker this comment used to name is gone (2026-09-29): portal-sms's buy_number now
 * ADOPTS a calling-only number (portal-sms/adoptNumber.ts) instead of refusing a second live one,
 * so a number bought on the Phone tab no longer strands the builder's texting setup. Setting it is
 * now only the builder-launch decision. Caller-ID registration (phone_trust_*) stays operator-only
 * whatever this says.
 */
export function phoneSelfServeOn(get: (name: string) => string | undefined | null): boolean {
  return String(get("PHONE_SELF_SERVE") ?? "").trim().toLowerCase() === "on";
}

/** The sentence every rollout refusal answers with. */
export const PHONE_ROLLOUT_SENTENCE =
  "My Synergy Phone isn't open to every builder yet. Structure Studio switches it on for your account when it's ready.";

/** null = allowed; otherwise the sentence to refuse with. Turning calling OFF is never gated:
 *  the switch is also the safety control. */
export function phoneRolloutRefusal(o: { selfServe: boolean; operator: boolean }): string | null {
  return o.selfServe || o.operator ? null : PHONE_ROLLOUT_SENTENCE;
}

// ── "Sign out all devices": who may, and what it ends (review SSB-9) ────────────────────────

/**
 * Ending someone's Supabase sessions signs them out of Structure Studio EVERYWHERE, not only
 * My Synergy Phone. Two people must therefore not be at a builder's mercy:
 *   * the business's owner, from an admin (an owner may, their own lost phone; so may an
 *     operator repairing the account) — refused outright, as before;
 *   * a CSM Synergy operator who has a team row on this tenant (live: 4 app_operators do, two
 *     as owner, two as user). Their sign-ins cover every tenant they support and the operator
 *     tools, so a builder's admin or co-owner may retire their My Synergy Phone devices on THIS team
 *     (the generation bump and the device rows) but never end those sessions. Only another
 *     operator may. The answer says which happened.
 */
export function signoutPlan(o: {
  targetRole: string | null;
  callerRole: string | null;
  callerIsOperator: boolean;
  targetIsOperator: boolean;
}): { ok: false; status: 403; error: string } | { ok: true; endSessions: boolean } {
  if (o.targetRole === "owner" && o.callerRole !== "owner" && !o.callerIsOperator) {
    return { ok: false, status: 403, error: "Only an owner can sign out an owner's devices." };
  }
  return { ok: true, endSessions: !o.targetIsOperator || o.callerIsOperator };
}

/**
 * Bump one person's device_generation by compare-and-swap, so two owners pressing "Sign out all
 * devices" together bump it twice rather than both writing the same number. No row yet means
 * generation 1 (the column default), so the first sign-out writes 2; an insert that loses the
 * race to another insert (23505) goes round again and bumps that row.
 * Returns the new generation, `{ conflict: true }` after three lost races, or the first error.
 */
export async function bumpDeviceGeneration(db: {
  read: () => Promise<{ gen: number | null; error: unknown }>;
  insert: (gen: number) => Promise<{ error: { code?: string } | null }>;
  update: (from: number, to: number) => Promise<{ swapped: boolean; error: unknown }>;
}): Promise<{ generation: number } | { conflict: true } | { error: unknown }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await db.read();
    if (cur.error) return { error: cur.error };
    if (cur.gen === null) {
      const ins = await db.insert(2);
      if (!ins.error) return { generation: 2 };
      if (String(ins.error.code) === "23505") continue;
      return { error: ins.error };
    }
    const g = Number(cur.gen) || 1;
    const up = await db.update(g, g + 1);
    if (up.error) return { error: up.error };
    if (up.swapped) return { generation: g + 1 };
  }
  return { conflict: true };
}

/**
 * crm_create_contact's database error → the answer. null = not one of the known refusals (the
 * caller files it as a fault).
 */
export function createContactRefusal(error: { code?: unknown; message?: unknown } | null):
  { status: number; error: string; refusal?: boolean } | null {
  if (!error) return null;
  const code = String(error.code ?? "");
  const msg = String(error.message ?? "");
  // crm_contacts_tenant_phone: that number is already a contact. crm_save_contact's sentence.
  if (code === "23505") return { status: 409, error: DUPLICATE_PHONE_SENTENCE };
  if (code === "PGRST202" || code === "42883") {
    return { status: 503, refusal: true, error: "Saving a contact from My Synergy Phone isn't available on this server yet. Add this customer in Structure Studio for now." };
  }
  if (/a phone number is required/i.test(msg)) {
    return { status: 400, error: "That phone number can't be saved. Save it from the number My Synergy Phone shows." };
  }
  if (/owner is not on this team/i.test(msg)) {
    return { status: 403, error: "Your account isn't on this team any more. Sign in again." };
  }
  return null;
}
