// Your own answer on AI transcripts, in Structure Studio's My Profile (2026-10-14). Ahsan: "so
// people (Carolyn especially) can say yes or no on the web today, without waiting for the app
// updates." The same answer as the phone app and the Chrome extension: one per account
// (phone_user_settings.ai_transcripts, migration 307), read by the phone-api Worker before it sends
// any recorded call to Cloudflare Workers AI or Anthropic's Claude. The rules are
// _shared/aiConsent.ts, the Worker's mirrored.
//
// TWO ACTIONS (index.ts):
//   ai_transcripts_get   the caller's own answer, and what their business does with calls now
//                        (recorded? transcribed?), for the card's plain lines.
//   ai_transcripts_save  { answer: "allowed" | "declined", version }: upserts the caller's OWN
//                        row, the way the Worker's POST /settings/me/ai-transcripts does, and
//                        answers with what the database then holds, so the page says "Saved."
//                        only when the answer really is the one asked for.
//
// THE PERSON IS THE SESSION'S, NEVER THE BODY'S. The service role bypasses RLS, so the row is
// picked by hand: the verified user id and the tenant resolveTenant settled on, nothing else. A
// body naming a user id is ignored (nothing here reads one). index.ts refuses the save for an
// operator in view-as before this runs: the person signed in is CSM Synergy staff, so the answer
// would be theirs, filed under the viewed builder.
//
// WIDER THAN THE WORKER ON PURPOSE. The Worker's save needs phone access (requireCaller); this one
// takes anyone on the team, because the question is about their own calls and a no can be given
// before they ever get the phone. Nothing is sent for someone with no calls either way.
//
// Injected (`db` is the service-role client, or a stub in tests/phone/aiTranscripts_test.ts), so
// every rule above is driven without a database.

import { AI_CONSENT_COLUMNS, consentOut, type AiChoice, type AiConsent, type AiConsentRow } from "../_shared/aiConsent.ts";
import { isUuid } from "./phone.ts";

/** The view-as refusal (index.ts), marked as a refusal so it isn't filed as a fault. */
export const AI_TRANSCRIPTS_VIEW_AS =
  "Your answer on AI transcripts belongs to the person signed in, so it can't be changed while you're viewing another account.";
/** Migration 307 not on this database: the card says so instead of failing. */
export const AI_TRANSCRIPTS_NOT_READY = "Choosing AI transcripts isn't set up on this server yet.";

/** A missing table or column (a database before 307): the same codes the phone tab treats as "not set up". */
const NOT_READY = new Set(["42P01", "42703", "PGRST204", "PGRST205"]);
export const aiNotReady = (e: unknown) => NOT_READY.has(String((e as { code?: string } | null)?.code ?? ""));

// deno-lint-ignore no-explicit-any
export type AiTranscriptsDb = { from: (table: string) => any };
/** The verified caller: the session's user and the tenant resolveTenant settled on. */
export type AiCaller = { userId: string; clientId: string };
type DbErr = { code?: string; message?: string };

/**
 * What the business does with calls right now, from its settings row and this function's mirror
 * of the Worker's two rails (phone.ts recordingServerOn / transcribeServerOn). The Worker's own
 * rule (routes/token.ts transcriptsFor): a call is recorded when the owner's switch AND the
 * CALL_RECORDING rail are on, and transcribed when it is recorded, the owner left transcripts on
 * (the column's default is on) AND the CALL_TRANSCRIBE rail is on.
 */
export function businessFacts(
  row: { phone_record_calls?: unknown; phone_transcribe_calls?: unknown } | null | undefined,
  rails: { recording: boolean; transcribe: boolean },
): { callRecording: boolean; businessTranscribes: boolean } {
  const callRecording = row?.phone_record_calls === true && rails.recording === true;
  return { callRecording, businessTranscribes: callRecording && row?.phone_transcribe_calls !== false && rails.transcribe === true };
}

/**
 * The caller's saved answer and their business's two facts, read at once. `own` false (an
 * operator in view-as) reads the business's facts only: the person signed in is not on this team,
 * so their own row is never read, and `consent` is null. `notReady`: this database has no 307
 * columns yet. `dbError`: a real fault, for dbFail.
 */
export async function readAiTranscripts(
  db: AiTranscriptsDb,
  who: AiCaller,
  rails: { recording: boolean; transcribe: boolean },
  own = true,
): Promise<
  | { consent: AiConsent | null; callRecording: boolean; businessTranscribes: boolean }
  | { notReady: true }
  | { dbError: DbErr }
> {
  if (own && !isUuid(who.userId)) return { dbError: { code: "bad_user", message: "the session's user id is not a uuid" } };
  const [mine, biz] = await Promise.all([
    own
      ? db.from("phone_user_settings").select(AI_CONSENT_COLUMNS).eq("user_id", who.userId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    db.from("client_settings").select("phone_record_calls, phone_transcribe_calls").eq("client_id", who.clientId).maybeSingle(),
  ]);
  if (mine.error) return aiNotReady(mine.error) ? { notReady: true } : { dbError: mine.error };
  // A database before 263 has no recording columns: nothing is recorded there, so nothing is sent.
  if (biz.error && !aiNotReady(biz.error)) return { dbError: biz.error };
  const facts = businessFacts(biz.error ? null : biz.data, rails);
  return { consent: own ? consentOut(mine.data as AiConsentRow | null) : null, ...facts };
}

/**
 * Save the caller's own answer: upsert by user_id (the table's key), stamped with the time, the
 * Worker's write exactly (client_id from the session, updated_at and ai_transcripts_at now). The
 * row the database answers with is read back through consentOut, so the caller compares what is
 * STORED with what was asked for.
 */
export async function saveAiTranscripts(
  db: AiTranscriptsDb,
  who: AiCaller,
  answer: { choice: AiChoice; version: number },
  now: Date = new Date(),
): Promise<{ consent: AiConsent } | { notReady: true } | { dbError: DbErr }> {
  if (!isUuid(who.userId)) return { dbError: { code: "bad_user", message: "the session's user id is not a uuid" } };
  const nowIso = now.toISOString();
  const res = await db.from("phone_user_settings").upsert({
    user_id: who.userId, client_id: who.clientId, updated_at: nowIso,
    ai_transcripts: answer.choice, ai_transcripts_version: answer.version, ai_transcripts_at: nowIso,
  }, { onConflict: "user_id" }).select(AI_CONSENT_COLUMNS).single();
  if (res.error) return aiNotReady(res.error) ? { notReady: true } : { dbError: res.error };
  return { consent: consentOut(res.data as AiConsentRow | null) };
}
