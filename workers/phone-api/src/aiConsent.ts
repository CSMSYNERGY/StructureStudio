// Each team member's yes or no to third-party AI on their calls (migration 307, 2026-10-13).
//
// App Store guideline 5.1.2(i) asks an app to say where personal data goes, third-party AI
// included, and to get explicit permission BEFORE it goes there. The phone app's transcripts notice
// (phone repo build 9) asks; this is where the answer lives and where it is obeyed:
//
//   * phone_user_settings.ai_transcripts: 'allowed', 'declined' or NULL (never answered), with the
//     notice version answered (ai_transcripts_version) and when (ai_transcripts_at). Saved by
//     POST /settings/me/ai-transcripts (routes/me.ts), read back on /token `ai_consent`.
//   * THE RULE (cron/transcribe.ts): a recorded call goes to Workers AI for a transcript, and its
//     transcript to Claude for a summary, only when EVERY team member on the call has allowed it.
//     Nobody known on the call, anyone who said no, anyone who never answered: not sent. It is read
//     at the moment of sending, so a no takes effect for every call not yet sent.
//   * Who is "on the call": placed_by, answered_by and transferred_from, and every teammate a
//     transfer (cold or warm, the Worker's own `transfer` / `warm_transfer` events) came from or
//     went to. A warm transfer's target counts even if they never picked up: the safe side.
//
// This sits on top of the business's own switch (client_settings.phone_transcribe_calls, the
// owner's) and the CALL_TRANSCRIBE rail, which both still have to be on. Voicemail transcripts
// are not under it: Twilio, which already records and keeps the voicemail, makes them (the
// TRANSCRIBE rail); the apps hide them for anyone who hasn't allowed.

import { must, type Admin } from "./db";
import { UUID_RE } from "./http";

/**
 * The oldest notice version whose "allowed" still counts. Raise it (with the apps'
 * AI_NOTICE_VERSION) when the notice changes in substance, such as a new service: everyone's
 * calls then wait for a new yes.
 */
export const AI_CONSENT_MIN_VERSION = 1;
/** The highest version a save accepts (migration 307's column is a smallint). */
export const AI_CONSENT_MAX_VERSION = 32767;

export type AiChoice = "allowed" | "declined";

/** The three columns (migration 307). ⚠️ Never in a select that must work before 307 is applied. */
export const AI_CONSENT_COLUMNS = "ai_transcripts, ai_transcripts_version, ai_transcripts_at";

export interface AiConsentRow {
  ai_transcripts?: string | null;
  ai_transcripts_version?: number | null;
  ai_transcripts_at?: string | null;
}

/** What the apps get (/token `ai_consent`, the save's answer): choice null = never answered. */
export interface AiConsent {
  choice: AiChoice | null;
  version: number | null;
  at: string | null;
}

export function consentOut(row: AiConsentRow | null | undefined): AiConsent {
  const c = row?.ai_transcripts;
  if (c !== "allowed" && c !== "declined") return { choice: null, version: null, at: null };
  return { choice: c, version: typeof row?.ai_transcripts_version === "number" ? row.ai_transcripts_version : null, at: row?.ai_transcripts_at ?? null };
}

/** This person's answer lets their calls go to the AI services. */
export function allowsAi(row: AiConsentRow | null | undefined): boolean {
  return row?.ai_transcripts === "allowed" && typeof row.ai_transcripts_version === "number" && row.ai_transcripts_version >= AI_CONSENT_MIN_VERSION;
}

interface CallTeam {
  id: string;
  placed_by: string | null;
  answered_by: string | null;
  transferred_from: string | null;
}

interface TransferEvent {
  call_id: string;
  type: string;
  data: Record<string, unknown> | null;
}

const asUser = (v: unknown): string | null => (typeof v === "string" && UUID_RE.test(v) ? v.toLowerCase() : null);

/** Every team member on each call (THE RULE's "on the call"), by call id. Pure, for the tests. */
export function teamsOf(calls: CallTeam[], events: TransferEvent[]): Map<string, Set<string>> {
  const teams = new Map<string, Set<string>>();
  for (const c of calls) {
    const t = new Set<string>();
    for (const u of [c.placed_by, c.answered_by, c.transferred_from]) {
      const id = asUser(u);
      if (id) t.add(id);
    }
    teams.set(c.id, t);
  }
  for (const e of events) {
    // The apps post timing marks with the same names (POST /calls/:id/events stamps them
    // source "app"): only the Worker's own say who a transfer involved.
    if (e.data?.source === "app") continue;
    const t = teams.get(e.call_id);
    if (!t) continue;
    for (const k of ["from", "to"]) {
      const id = asUser(e.data?.[k]);
      if (id) t.add(id);
    }
  }
  return teams;
}

/**
 * The calls among `callIds` that may go to the AI services: every team member on each has
 * allowed it (THE RULE). Three reads at most, whatever the number of calls. Throws (DbError) when
 * any read fails: the caller then sends nothing.
 */
export async function consentedCalls(admin: Admin, callIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(callIds.filter((id) => UUID_RE.test(id)))];
  if (!ids.length) return new Set();
  const [callsRes, eventsRes] = await Promise.all([
    admin.from("phone_calls").select("id, placed_by, answered_by, transferred_from").in("id", ids),
    admin.from("phone_call_events").select("call_id, type, data").in("call_id", ids).in("type", ["transfer", "warm_transfer"]),
  ]);
  const calls = (must(callsRes, "read who was on the calls") as CallTeam[] | null) ?? [];
  const events = (must(eventsRes, "read the calls' transfers") as TransferEvent[] | null) ?? [];
  const teams = teamsOf(calls, events);
  const people = [...new Set([...teams.values()].flatMap((t) => [...t]))];
  const rows = people.length
    ? ((must(
        await admin.from("phone_user_settings").select(`user_id, ${AI_CONSENT_COLUMNS}`).in("user_id", people),
        "read transcript consent",
      ) as (AiConsentRow & { user_id: string })[] | null) ?? [])
    : [];
  const yes = new Set(rows.filter(allowsAi).map((r) => r.user_id.toLowerCase()));
  const out = new Set<string>();
  for (const [id, team] of teams) {
    if (team.size && [...team].every((u) => yes.has(u))) out.add(id);
  }
  return out;
}

/**
 * This person's answer for /token. `consent` is missing when it can't be read (migration 307 not
 * applied yet, or a database fault; `error` says which database code): the apps then can't tell,
 * and keep transcripts hidden. Never throws.
 */
export async function readMyConsent(admin: Admin, userId: string): Promise<{ consent?: AiConsent; error?: string }> {
  try {
    const { data, error } = await admin.from("phone_user_settings").select(AI_CONSENT_COLUMNS).eq("user_id", userId).maybeSingle();
    if (error) return { error: error.code ?? "unknown" };
    return { consent: consentOut(data as AiConsentRow | null) };
  } catch {
    return { error: "unreachable" };
  }
}
