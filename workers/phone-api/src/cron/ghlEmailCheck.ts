import type { Env } from "../env";
import { logFault } from "../log";

// The quote email check (migration 357): what became of a quote email after GHL accepted it.
//
// ⚠️ WHY THIS LIVES IN THE PHONE WORKER, which is not an obvious home for it: **pg_cron is not
// installed on this Supabase project.** This Worker's one-minute tick is the only real scheduler in
// the product, so a feature that needs a clock asks it. meeting-reminders and crm-rules-tick made
// the same choice for the same reason, and the comment is repeated because anybody moving one of
// them needs to read it where they are standing.
//
// The work itself is NOT done here. This posts to the `ghl-email-check` edge function, which owns
// the queue and the tenant's GHL key.
//
// The failure that matters is the SILENT one: a tick that stops means quote emails go unchecked and
// nobody is told, which is the same four-week story this check exists to end. Hence the fault log.

/** One tick's budget. The function caps its own batch too; this only bounds how long a slow answer
 *  can hold an invocation that also carries the billing jobs. */
const TIMEOUT_MS = 25_000;

/**
 * Ask the edge function to read the quote emails that have come due.
 *
 * NEVER THROWS: safe in `waitUntil` and in the cron, like runCrmRules. A failure is logged
 * (throttled) and the next tick asks again five minutes later. The function's claim stops two
 * ticks filing one failure twice, so one bad tick costs nothing but five minutes.
 */
export async function runGhlEmailCheck(env: Env): Promise<void> {
  const base = String(env.SUPABASE_URL ?? "").replace(/\/+$/, "");
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!base || !key) return;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/functions/v1/ghl-email-check`, {
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
        code: "ghl_email_check_failed",
        throttleMs: 15 * 60_000,
        message: `ghl-email-check answered HTTP ${res.status}.`,
      });
    }
  } catch (e) {
    await logFault({
      code: "ghl_email_check_failed",
      throttleMs: 15 * 60_000,
      message: ac.signal.aborted
        ? `ghl-email-check did not answer in ${TIMEOUT_MS / 1000} s.`
        : `ghl-email-check unreachable: ${(e as Error)?.message ?? String(e)}`,
    });
  } finally {
    clearTimeout(timer);
  }
}
