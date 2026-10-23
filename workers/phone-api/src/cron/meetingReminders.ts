import type { Env } from "../env";
import { logFault } from "../log";

// Meeting reminders (migration 327, Meetings phase 2 of MEETINGS_SCOPE.md).
//
// ⚠️ WHY THIS LIVES IN THE PHONE WORKER, which is not an obvious home for it: **pg_cron is
// not installed on this Supabase project.** CLAUDE.md records it as verified absent on
// 2026-08-08, and records the cost — `sync_all` carries a comment saying "Run by pg_cron
// every 10 minutes" and has therefore never run once, which is why a webhook routing bug
// stayed invisible for twelve days.
//
// This Worker's one-minute tick is the only real scheduler in the product, so a feature that
// needs a clock asks it. The alternative — shipping a reminder runner with nothing calling it
// — is exactly the mistake above, and it fails silently in the direction that matters: the
// customer simply never hears from the builder again before the meeting.
//
// The work itself is NOT done here. This posts to the `meeting-reminders` edge function,
// which owns the query and the sending, because the email model (per-tenant Resend domains,
// the email_sends ledger, _shared/emailSend.ts) lives on the Supabase side. Re-implementing
// any of that here would be a second copy of it.

/** One tick's budget. The function caps its own batch too; this only bounds how long a slow
 *  answer can hold the invocation, which also carries the billing jobs. */
const TIMEOUT_MS = 20_000;

/**
 * Ask the edge function to send whatever reminders are due.
 *
 * NEVER THROWS: safe in `waitUntil` and in the cron, like requestAutoTopup. A failure is
 * logged (throttled) and the next tick asks again — five minutes later, which is well inside
 * the function's own lateness grace, so one bad tick costs nothing.
 */
export async function runMeetingReminders(env: Env): Promise<void> {
  const base = String(env.SUPABASE_URL ?? "").replace(/\/+$/, "");
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!base || !key) return;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/functions/v1/meeting-reminders`, {
      method: "POST",
      // apikey as well as the bearer: the functions gateway accepts the new-style secret key
      // there, where it is not a JWT. The function itself checks the bearer.
      headers: { "content-type": "application/json", authorization: `Bearer ${key}`, apikey: key },
      body: "{}",
      signal: ac.signal,
    });
    await res.arrayBuffer().catch(() => undefined);
    if (!res.ok) {
      await logFault({
        code: "meeting_reminders_failed",
        throttleMs: 15 * 60_000,
        message: `meeting-reminders answered HTTP ${res.status}.`,
      });
    }
  } catch (e) {
    await logFault({
      code: "meeting_reminders_failed",
      throttleMs: 15 * 60_000,
      message: ac.signal.aborted
        ? `meeting-reminders did not answer in ${TIMEOUT_MS / 1000} s.`
        : `meeting-reminders unreachable: ${(e as Error)?.message ?? String(e)}`,
    });
  } finally {
    clearTimeout(timer);
  }
}
