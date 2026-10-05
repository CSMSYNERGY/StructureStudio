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
import { noticeSaysRecorded } from "../_shared/recordingNotice.ts";
import { type BusinessHours, parseBusinessHours, validTimeZone } from "../_shared/phoneHours.ts";

// The hours rules moved to _shared/phoneHours.ts (migration 264), because the phone-api Worker
// checks a person's own ring hours with them too. Re-exported, so everything that imported them
// from here (index.ts, tests/phone/phoneSettings_test.ts) is unchanged.
export {
  type BusinessHours, parseBusinessHours, PHONE_DAYS, type PhoneDay, validTimeZone,
} from "../_shared/phoneHours.ts";

/** Twilio rings at most ten <Client>s in one <Dial> (plan section 8). */
export const MAX_ROUTE_MEMBERS = 10;
/** phone_routes.ring_seconds CHECK (ring_seconds between 5 and 60). */
export const RING_MIN = 5;
export const RING_MAX = 60;

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

// ── Call recording (migration 263) ───────────────────────────────────────────────────────
//
// The settings card's form → the client_settings columns, or the first thing wrong with it.
// The columns' CHECKs are mirrored here so a bad value is refused in words the owner can act on.
// Decided for Ahsan on 2026-10-04 (Carolyn can change the settings later): recording off until the
// owner turns it on; the announcement on and LOCKED ON while calls are recorded (this refuses
// turning it off; the column stays for a later decision); transcripts on; recordings kept 365
// days unless the owner picks another of the five lengths. The standard wording is the phone-api
// Worker's (src/recording.ts STANDARD_NOTICE*), repeated here only to show the owner.

/** client_settings_phone_recording_retention_chk. */
export const RECORDING_RETENTION_DAYS = [30, 90, 180, 365, 730] as const;
export const DEFAULT_RECORDING_RETENTION_DAYS = 365;
/** client_settings_phone_recording_notice_text_chk, counted after trimming. */
export const NOTICE_MIN = 10;
export const NOTICE_MAX = 300;
export const STANDARD_NOTICE = "This call will be recorded.";
export const STANDARD_NOTICE_TRANSCRIBED = "This call will be recorded and transcribed.";

/** The sentence a business with no wording of its own hears (the Worker adds "and transcribed" only while it will happen). */
export function standardNotice(transcribe: boolean): string {
  return transcribe ? STANDARD_NOTICE_TRANSCRIBED : STANDARD_NOTICE;
}

export type RecordingRow = {
  phone_record_calls: boolean;
  phone_recording_notice: true;
  phone_recording_notice_text: string | null;
  phone_transcribe_calls: boolean;
  phone_recording_retention_days: number;
};

/**
 * { on, noticeText?, transcribe?, retentionDays?, notice? } → the columns to write.
 *   on            required, true or false
 *   notice        absent or true. false is refused: the announcement is locked on
 *   noticeText    blank, or either standard sentence, means the standard wording (stored NULL,
 *                 so it follows the transcripts switch); otherwise 10-300 characters once spaces
 *                 are tidied, one line, and it has to say the call is recorded and not deny it
 *                 (noticeSaysRecorded)
 *   transcribe    default true
 *   retentionDays one of 30, 90, 180, 365, 730; default 365
 */
export function parseRecording(p: Record<string, unknown>): { ok: true; row: RecordingRow } | { ok: false; error: string } {
  if (typeof p.on !== "boolean") return { ok: false, error: "Say whether calls should be recorded." };
  if (p.notice === false) {
    return { ok: false, error: "The announcement can't be turned off: callers are always told a call is recorded." };
  }
  if (p.transcribe !== undefined && p.transcribe !== null && typeof p.transcribe !== "boolean") {
    return { ok: false, error: "Say whether recorded calls should be transcribed." };
  }
  const transcribe = p.transcribe !== false;

  const days = p.retentionDays === undefined || p.retentionDays === null || p.retentionDays === ""
    ? DEFAULT_RECORDING_RETENTION_DAYS
    : Number(p.retentionDays);
  if (!(RECORDING_RETENTION_DAYS as readonly number[]).includes(days)) {
    return { ok: false, error: "Choose how long recordings are kept: 30, 90, 180, 365 or 730 days." };
  }

  if (p.noticeText !== undefined && p.noticeText !== null && typeof p.noticeText !== "string") {
    return { ok: false, error: "The announcement wasn't in a shape we recognise." };
  }
  // Tidied the way it will be spoken: one line, single spaces.
  const raw = String(p.noticeText ?? "").replace(/\s+/g, " ").trim();
  let text: string | null = raw;
  if (!raw || raw === STANDARD_NOTICE || raw === STANDARD_NOTICE_TRANSCRIBED) text = null;
  if (text !== null) {
    // deno-lint-ignore no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(text)) return { ok: false, error: "The announcement has a character that can't be spoken." };
    if (text.length < NOTICE_MIN) return { ok: false, error: `The announcement has to be at least ${NOTICE_MIN} characters.` };
    if (text.length > NOTICE_MAX) return { ok: false, error: `The announcement can be at most ${NOTICE_MAX} characters.` };
    // A word of its own, and not denied ("not recorded"): _shared/recordingNotice.ts.
    if (!noticeSaysRecorded(text)) return { ok: false, error: "The announcement has to tell callers the call is recorded." };
  }

  return {
    ok: true,
    row: {
      phone_record_calls: p.on,
      phone_recording_notice: true,
      phone_recording_notice_text: text,
      phone_transcribe_calls: transcribe,
      phone_recording_retention_days: days,
    },
  };
}

/**
 * Whether calls can be recorded on this server at all: the phone-api Worker's CALL_RECORDING rail,
 * mirrored as this function's own secret of the same name (set together, workers/phone-api
 * SETUP.md 7c). Exactly "on", as the Worker reads it. The database can't see the Worker's rail,
 * so without this the card would say calls are recorded while nothing records.
 */
export function recordingServerOn(env: (k: string) => string | undefined): boolean {
  return env("CALL_RECORDING") === "on";
}

/**
 * A client_settings row's recording columns → what the Settings card shows. Missing columns read
 * as the defaults. `serverOn` is recordingServerOn: calls are recorded only while the owner's
 * `on` AND it are true; with the owner's on and the server's off, the card says recording hasn't
 * started yet.
 */
export function recordingView(row: Record<string, unknown> | null | undefined, serverOn = false) {
  const r = row ?? {};
  const transcribe = r.phone_transcribe_calls !== false;
  const days = Number(r.phone_recording_retention_days);
  const text = typeof r.phone_recording_notice_text === "string" && r.phone_recording_notice_text.trim() ? r.phone_recording_notice_text : null;
  return {
    on: r.phone_record_calls === true,
    serverOn: serverOn === true,
    notice: true,
    noticeText: text,
    standardText: standardNotice(transcribe),
    transcribe,
    retentionDays: (RECORDING_RETENTION_DAYS as readonly number[]).includes(days) ? days : DEFAULT_RECORDING_RETENTION_DAYS,
    retentionChoices: [...RECORDING_RETENTION_DAYS],
    updatedAt: typeof r.phone_recording_updated_at === "string" ? r.phone_recording_updated_at : null,
    updatedBy: typeof r.phone_recording_updated_by === "string" ? r.phone_recording_updated_by : null,
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

// ── More than one number (migration 266) ──────────────────────────────────────────────────
//
// Carolyn, 2026-09-30: "What if they want more than one number?" and "all of these settings ...
// needs to be for that individual number." The settings already were per number (phone_routes has
// one row per sms_numbers row); what follows is the part of the Phone tab that names a number,
// says whose it is, and decides which number a request is about. Safe defaults (contract):
//   * a number is a TEAM LINE unless assigned to a person; one personal number per person;
//   * at most MAX_NUMBERS live numbers per business;
//   * a request that names no number means the FIRST (oldest) one, the number every screen before
//     266 showed, so an older portal bundle keeps working unchanged.

/** At most this many live numbers per business. */
export const MAX_NUMBERS = 10;
/** sms_numbers_label_len (migration 266). */
export const NUMBER_LABEL_MAX = 40;

/** The 23505 on sms_numbers_one_per_person, in words. */
export const ONE_NUMBER_PER_PERSON =
  "That person already has their own number. Make that one a team line first, or choose someone else.";
/** A numberId that is not one of this business's live numbers (released meanwhile, or never ours). */
export const NUMBER_GONE = "That number isn't on this account any more. Reload the page.";

/**
 * The number a request is about: `raw` (payload.numberId) when it is given, which must be one of
 * `rows` (this business's live numbers, read by the caller on clientId), else the FIRST row, or
 * null when there is none. A given id that matches nothing is refused, never read as "the first":
 * changing the wrong number's settings is worse than asking for a reload.
 */
export function pickNumber<T extends { id: string }>(rows: T[], raw: unknown):
  { ok: true; n: T | null } | { ok: false; error: string } {
  const list = (rows ?? []).filter(Boolean);
  if (raw === undefined || raw === null || raw === "") return { ok: true, n: list[0] ?? null };
  if (!isUuid(raw)) return { ok: false, error: NUMBER_GONE };
  const n = list.find((r) => String(r.id).toLowerCase() === raw.toLowerCase());
  return n ? { ok: true, n } : { ok: false, error: NUMBER_GONE };
}

/** A number's name as typed → what is stored: spaces tidied, NULL for none, 1 to 40 characters. */
export function parseNumberLabel(raw: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, error: "A number's name has to be text." };
  const s = raw.replace(/\s+/g, " ").trim();
  if (!s) return { ok: true, value: null };
  // deno-lint-ignore no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) return { ok: false, error: "A number's name can't have that character in it." };
  if (s.length > NUMBER_LABEL_MAX) return { ok: false, error: `A number's name can be at most ${NUMBER_LABEL_MAX} characters.` };
  return { ok: true, value: s };
}

/**
 * "Whose number": empty / null = a team line; otherwise someone in `eligible` (every user id on
 * THIS business with phone access, computed by the caller from client_users, never from the
 * request), so a number can't be given to someone on another builder's team or with no phone.
 */
export function parseAssignee(
  raw: unknown,
  eligible: Set<string>,
  names: Map<string, string | null> = new Map(),
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === null || raw === undefined || raw === "") return { ok: true, value: null };
  if (!isUuid(raw)) return { ok: false, error: "The person this number is for isn't on your team." };
  const id = raw.toLowerCase();
  if (!eligible.has(id)) {
    const who = names.get(id);
    return {
      ok: false,
      error: who
        ? `${who} doesn't have Phone access, so a number can't be theirs. Change it on the Team tab first.`
        : "The person this number is for isn't on your team, or doesn't have Phone access.",
    };
  }
  return { ok: true, value: id };
}

/** The keys of the answer-list form. A save that carries none of them changes no route. */
export const ROUTE_KEYS = [
  "mode", "members", "ringSeconds", "noAnswer", "forwardTo", "businessHours", "timeZone", "afterHours", "greetingUrl",
] as const;
export function carriesRoute(p: Record<string, unknown>): boolean {
  return ROUTE_KEYS.some((k) => Object.prototype.hasOwnProperty.call(p ?? {}, k));
}

/**
 * Who a number with no saved route is offered to ring (the Phone tab's first-time setup; nothing
 * is saved until the owner presses Save): its person, when it is someone's and they have phone
 * access, else the business's owners (plan section 7: "the list starts with the owner").
 */
export function suggestedMembersFor(
  assignedUserId: string | null | undefined,
  team: { userId: string; role: string | null; phoneLevel: string }[],
): string[] {
  const who = String(assignedUserId ?? "").toLowerCase();
  if (who && team.some((t) => t.userId === who && t.phoneLevel !== "none")) return [who];
  return team.filter((t) => t.role === "owner" && t.phoneLevel !== "none").map((t) => t.userId);
}

export type CallerNumberRow = { id: string; phone_number: string; purchased_at?: string | null; assigned_user_id?: string | null };

/**
 * The number a person's calls show, phone_caller_context's pick (migration 266) as the Phone tab
 * tells someone with their own calls only: their own number, else a team line (the texting number
 * first), else the oldest; somebody else's own number only when nothing else is live. `rows` are
 * live and oldest first (phoneNumberRows), so "the oldest" is the first that qualifies.
 */
export function callerNumberFor<T extends CallerNumberRow>(rows: T[], userId: string | null | undefined, smsNumber: string | null | undefined): T | null {
  const list = (rows ?? []).filter(Boolean);
  const me = String(userId ?? "").toLowerCase();
  const own = me ? list.find((n) => String(n.assigned_user_id ?? "").toLowerCase() === me) : undefined;
  if (own) return own;
  const team = list.filter((n) => !n.assigned_user_id);
  return team.find((n) => smsNumber && n.phone_number === smsNumber) ?? team[0] ?? list[0] ?? null;
}
