import type { Env } from "../env";
import { logFault } from "../log";

// Customer Hub rules (migration 355, Part D of the pipelines rework).
//
// ⚠️ WHY THIS LIVES IN THE PHONE WORKER, which is not an obvious home for it: **pg_cron is not
// installed on this Supabase project.** CLAUDE.md records it as verified absent on 2026-08-08,
// and records the cost — `sync_all` carries a comment saying "Run by pg_cron every 10 minutes"
// and has therefore never run once, which is why a webhook routing bug stayed invisible for
// twelve days.
//
// This Worker's one-minute tick is the only real scheduler in the product, so a feature that
// needs a clock asks it. meeting-reminders made the same choice for the same reason; this is the
// second borrower, and the comment is repeated rather than cross-referenced because anybody
// moving either one needs to read it where they are standing.
//
// The work itself is NOT done here. This posts to the `crm-rules-tick` edge function, which owns
// the sweep (a Postgres function) and the sending (per-tenant Twilio sub-accounts, per-tenant
// Resend domains, the sms_messages and email_sends ledgers, opt-outs, quiet hours and the usage
// wallet — all of it on the Supabase side). Re-implementing any of that here would be a second
// copy of it, and the opt-out half is a copy nobody should be making.
//
// A rule can text a builder's customer, so the failure that matters is the SILENT one: a tick
// that stops means messages sit in the outbox for ever and nobody is told. Hence the fault log
// below, which is the only thing standing between that and the twelve-day story above.

/** One tick's budget. The function caps its own batches (SWEEP_LIMIT, SEND_PER_RUN) too; this
 *  only bounds how long a slow answer can hold an invocation that also carries the billing jobs. */
const TIMEOUT_MS = 25_000;

/**
 * Ask the edge function to sweep the clock rules and drain the message queue.
 *
 * NEVER THROWS: safe in `waitUntil` and in the cron, like runMeetingReminders. A failure is
 * logged (throttled) and the next tick asks again five minutes later — the sweep is idempotent
 * (the once-per-card guard is an index in the database, not a decision made here) and a queued
 * message keeps its place, so one bad tick costs nothing but five minutes.
 */
export async function runCrmRules(env: Env): Promise<void> {
  const base = String(env.SUPABASE_URL ?? "").replace(/\/+$/, "");
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!base || !key) return;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/functions/v1/crm-rules-tick`, {
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
        code: "crm_rules_tick_failed",
        throttleMs: 15 * 60_000,
        message: `crm-rules-tick answered HTTP ${res.status}.`,
      });
    }
  } catch (e) {
    await logFault({
      code: "crm_rules_tick_failed",
      throttleMs: 15 * 60_000,
      message: ac.signal.aborted
        ? `crm-rules-tick did not answer in ${TIMEOUT_MS / 1000} s.`
        : `crm-rules-tick unreachable: ${(e as Error)?.message ?? String(e)}`,
    });
  } finally {
    clearTimeout(timer);
  }
}
