// Each team member's yes or no to third-party AI on their calls (migration 307), as Structure
// Studio's own screens read and save it. Since 2026-10-14 My Profile asks it too, so a person can
// answer on the web without waiting for the phone app or extension update. ONE answer per account:
// phone_user_settings.ai_transcripts, which the phone-api Worker reads at the moment it would send
// a recorded call to Cloudflare Workers AI (transcript) and the transcript to Anthropic's Claude
// (summary). A yes given here is a yes in the phone app and the extension, and the other way round.
//
// THE WORKER'S RULES, MIRRORED. workers/phone-api/src/aiConsent.ts and routes/me.ts
// (aiTranscriptsMe) import the Worker's own db and http modules, so they can't be imported here.
// tests/phone/aiTranscripts_test.ts reads the Worker's source and fails if any of these drift:
//   * the answer is "allowed" or "declined"; anything else is refused with AI_CHOICE_REFUSED,
//     the Worker's sentence word for word;
//   * the version is a whole number from 1 to AI_CONSENT_MAX_VERSION (migration 307's smallint),
//     refused with AI_VERSION_REFUSED, word for word;
//   * the three columns (AI_CONSENT_COLUMNS) and the answer's shape (consentOut);
//   * an "allowed" counts only at a version >= AI_CONSENT_MIN_VERSION (allowsAi).
//
// THE APPS' NOTICE VERSION. AI_NOTICE_VERSION is phone-core's (structure-studio-phone
// packages/phone-core/src/aiTranscripts.ts). The apps count a saved answer only when its version
// is exactly theirs (currentChoice), so a save from here at another number would read in the apps
// as "never answered". Raise all three together when the notice changes in substance (a new
// service, a new use): phone-core's AI_NOTICE_VERSION, this one, and the Worker's
// AI_CONSENT_MIN_VERSION, so everyone is asked again and their calls wait for the new yes.
//
// Pure, no imports: the _shared Deno tests run it as it is.

/** The notice's version, saved with every answer given here (phone-core's AI_NOTICE_VERSION). */
export const AI_NOTICE_VERSION = 1;
/** The oldest version whose "allowed" still counts (the Worker's AI_CONSENT_MIN_VERSION). */
export const AI_CONSENT_MIN_VERSION = 1;
/** The highest version a save accepts (migration 307's column is a smallint). */
export const AI_CONSENT_MAX_VERSION = 32767;

export type AiChoice = "allowed" | "declined";

/** The three columns (migration 307). */
export const AI_CONSENT_COLUMNS = "ai_transcripts, ai_transcripts_version, ai_transcripts_at";

export interface AiConsentRow {
  ai_transcripts?: string | null;
  ai_transcripts_version?: number | null;
  ai_transcripts_at?: string | null;
}

/** The saved answer as the Worker hands it to the apps (/token `ai_consent`): choice null = never answered. */
export interface AiConsent {
  choice: AiChoice | null;
  version: number | null;
  at: string | null;
}

/** The Worker's refusals, word for word (routes/me.ts). */
export const AI_CHOICE_REFUSED = "Choose Allow or Don't allow.";
export const AI_VERSION_REFUSED = "That notice version isn't one we know.";
/** A page showing an older (or newer) notice than this server asks about: the person must read the current one. */
export const AI_NOTICE_STALE = "This page is out of date. Reload it, read the notice again, then choose.";

/** A phone_user_settings row → the saved answer (the Worker's consentOut). */
export function consentOut(row: AiConsentRow | null | undefined): AiConsent {
  const c = row?.ai_transcripts;
  if (c !== "allowed" && c !== "declined") return { choice: null, version: null, at: null };
  return { choice: c, version: typeof row?.ai_transcripts_version === "number" ? row.ai_transcripts_version : null, at: row?.ai_transcripts_at ?? null };
}

/** This person's answer lets their calls go to the AI services (the Worker's allowsAi). */
export function allowsAi(row: AiConsentRow | null | undefined): boolean {
  return row?.ai_transcripts === "allowed" && typeof row.ai_transcripts_version === "number" && row.ai_transcripts_version >= AI_CONSENT_MIN_VERSION;
}

/**
 * The answer to show: the saved one when it was given to this version of the notice, else null
 * (phone-core's currentChoice). An answer to another version reads as "not chosen yet", exactly as
 * it does in the apps, so the screen asks again rather than showing a choice the apps ignore.
 */
export function currentAnswer(consent: AiConsent | null | undefined): AiChoice | null {
  if (!consent || consent.version !== AI_NOTICE_VERSION) return null;
  return consent.choice === "allowed" || consent.choice === "declined" ? consent.choice : null;
}

/**
 * A save's body → what to store. `answer` and `version` are checked the way the Worker checks
 * `choice` and `version` (same order, same sentences), and then the version must be the notice
 * this server asks about: the page sends the version of the notice it showed, so a page left open
 * across a notice change can't record a yes to words the person never saw.
 */
export function parseAiAnswer(body: Record<string, unknown> | null | undefined):
  | { ok: true; choice: AiChoice; version: number }
  | { ok: false; error: string } {
  const choice = body?.answer;
  if (choice !== "allowed" && choice !== "declined") return { ok: false, error: AI_CHOICE_REFUSED };
  const version = body?.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1 || version > AI_CONSENT_MAX_VERSION) {
    return { ok: false, error: AI_VERSION_REFUSED };
  }
  if (version !== AI_NOTICE_VERSION) return { ok: false, error: AI_NOTICE_STALE };
  return { ok: true, choice, version };
}
