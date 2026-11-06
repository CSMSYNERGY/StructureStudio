import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { withErrorLog, logEdgeError } from "../_shared/logError.ts";
import { sendMeetingEmail } from "../_shared/meetingSend.ts";
import { syncAllBusy } from "../_shared/meetingCalendar.ts";
import { denoVideoEnv } from "../_shared/meetingVideo.ts";

// MEETING-REMINDERS — the cron half of Meetings phase 2. Migration 327.
//
// ⚠️ WHAT ACTUALLY RUNS THIS, because it is the first question anyone will ask and the answer
// is NOT pg_cron: **pg_cron is not installed on this project** (CLAUDE.md records it as
// verified absent on 2026-08-08, and records what that cost — `sync_all` carries a comment
// saying "Run by pg_cron every 10 minutes" and has therefore never run once, which is why a
// webhook routing bug stayed invisible for twelve days).
//
// So this is driven by the **phone-api Cloudflare Worker's cron tick**, which is the real
// scheduler in this product: one trigger every minute, fanning out to jobs by minute
// arithmetic (see workers/phone-api/src/index.ts `scheduled`). The meeting job runs every
// five minutes, on a different offset from the usage charges so the two never compete for one
// invocation's subrequest budget.
//
// A reminder feature with no scheduler is dead on arrival, and shipping one anyway — a
// function that exists, looks right, and is called by nothing — is the exact shape of the
// pg_cron mistake above. If you move this off that tick, say where it runs in this comment.
//
// ── AUTH, AND A TRAP THIS FUNCTION WALKED INTO ONCE ──────────────────────────────────────
// `verify_jwt = true` in config.toml, so THE GATEWAY REQUIRES A VALID JWT IN `Authorization`
// BEFORE THIS CODE RUNS. Three doors:
//
//   1. Authorization: Bearer <service role key>, when that key is a JWT (the old format) —
//      the gateway verifies it, and the role claim is service_role. This is the door the
//      phone-api Worker uses, the same way it calls wallet-autotopup.
//   2. Authorization: Bearer <any valid JWT> PLUS `x-meeting-secret: <MEETING_REMINDER_SECRET>`.
//   3. Nothing else.
//
// ⛔ THE SECRET IS A HEADER OF ITS OWN, NOT THE BEARER, and that is not a style choice. A
// first version of this function compared MEETING_REMINDER_SECRET against the BEARER, exactly
// as phone-call-summary does — and that door was **unreachable**: a random secret is not a
// JWT, so the gateway answered `UNAUTHORIZED_INVALID_JWT_FORMAT` before the function was
// entered. CLAUDE.md records the same trap for phone-call-summary's own key ("an
// `sb_secret_…` key is NOT a JWT and the gateway 401s it before the function runs"). Verified
// live: with the secret as the bearer the gateway refused it; in its own header it works.
//
// So the bearer satisfies the GATEWAY and the header satisfies US. Both are still required —
// the anon key alone, which every visitor to book.html holds, passes the gateway and is then
// refused here.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-meeting-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

/** meeting_settings.reminder_hours is capped at 336 (14 days), so nothing further out can
 *  ever be due. Keeps the candidate read bounded however big this table gets. */
const HORIZON_MS = 15 * 86_400_000;

/**
 * How late a reminder may be and still go out.
 *
 * ⚠️ Without this, a cron outage turns into a lie: the tick comes back, finds a 24-hour
 * reminder whose moment passed while it was down, and emails "see you tomorrow" about a
 * meeting starting in an hour. Past the grace the offset is CLAIMED but NOT SENT, so it
 * neither misinforms the customer nor retries for ever — and it is logged, because a reminder
 * that silently did not go is exactly the kind of thing nobody notices for twelve days.
 */
const LATE_GRACE_MS = 2 * 3_600_000;

/**
 * The grace for ONE offset: two hours, or a quarter of the offset when that is shorter
 * (2026-11-06). A flat two hours is the whole of a 2-hour reminder, so "in 2 hours" could go out
 * minutes before the meeting — and with failed reminders now retried every tick, any email outage
 * up to two hours long would do exactly that. A quarter keeps the words roughly true: a 2-hour
 * reminder may be up to 30 minutes late, a 24-hour one up to two hours, as before.
 */
function lateGraceMs(hours: number): number {
  return Math.min(LATE_GRACE_MS, (hours * 3_600_000) / 4);
}

/** One invocation's cap. The tick is every five minutes, so a backlog drains quickly; an
 *  unbounded batch would risk the Worker's subrequest budget and the function's wall clock. */
const MAX_PER_RUN = 60;

/** And a time cap (2026-11-06): a hung send now ends at resend.ts's 30 s bound, but sixty of them
 *  could still outlast the wall clock. Stop starting new reminders once a run is this old; what is
 *  left is still unclaimed, and the next tick takes it. */
const RUN_BUDGET_MS = 150_000;

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function jwtRole(token: string): string | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const pad = part.replace(/-/g, "+").replace(/_/g, "/");
    const body = JSON.parse(atob(pad + "=".repeat((4 - pad.length % 4) % 4)));
    return typeof body?.role === "string" ? body.role : null;
  } catch {
    return null;
  }
}

function callerAllowed(authorization: string | null, secretHeader: string | null): boolean {
  // Door 2 first: the secret in its own header. See the header comment for why it cannot be
  // the bearer. Constant-time, and an unset secret can never be matched by an absent header.
  const configured = Deno.env.get("MEETING_REMINDER_SECRET") ?? "";
  const presentedSecret = String(secretHeader ?? "").trim();
  if (configured && presentedSecret && timingSafeEqual(presentedSecret, configured)) return true;

  const m = /^Bearer\s+(.+)$/i.exec(String(authorization ?? "").trim());
  const presented = m ? m[1].trim() : "";
  if (!presented) return false;

  // Door 1a: the bearer IS the service role key verbatim.
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (serviceKey && timingSafeEqual(presented, serviceKey)) return true;

  // Door 1b: a JWT whose role is service_role. Safe ONLY because config.toml keeps
  // verify_jwt = true, so the gateway checked the signature before this function ran. With
  // verification off, anyone could forge the claim.
  return jwtRole(presented) === "service_role";
}

/**
 * Give one reminder offset back, so the next tick tries it again (2026-11-06). True when it was
 * given back.
 *
 * A read and a write, not one UPDATE: there is no un-claim function and this is not worth a
 * migration. Two ticks overlapping on the same meeting could in theory put back an offset the
 * other just claimed, which would only mean that offset is tried twice — and its idempotency key
 * makes the second try an answer from Resend, not a second email.
 */
// deno-lint-ignore no-explicit-any
async function unclaimReminder(admin: any, meetingId: string, hours: number): Promise<boolean> {
  const { data: row, error } = await admin.from("meetings").select("reminders_sent").eq("id", meetingId).maybeSingle();
  if (error || !row) return false;
  const cur: number[] = Array.isArray(row.reminders_sent) ? row.reminders_sent.map(Number) : [];
  if (!cur.includes(hours)) return false;
  const { error: ue } = await admin.from("meetings")
    .update({ reminders_sent: cur.filter((x) => x !== hours) }).eq("id", meetingId);
  return !ue;
}

Deno.serve(withErrorLog("meeting-reminders", async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!callerAllowed(req.headers.get("authorization"), req.headers.get("x-meeting-secret"))) {
    return json({ error: "unauthorized" }, 401);
  }

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // ── Busy times from hosts' Google / Outlook calendars (migration 341) ─────────────────────
  // This tick (the phone-api Worker's, every 5 minutes) is the only scheduler on the project, so
  // the calendar sync rides it rather than needing a Worker change. It runs AFTER the reminders
  // and can never stop them: syncAllBusy never throws, and it has its own time budget.
  const finish = async (body: Record<string, unknown>) => {
    let busy: unknown = null;
    try { busy = await syncAllBusy(admin, denoVideoEnv(), { limit: 40, budgetMs: 25_000 }); } catch { busy = { error: true }; }
    return json({ ...body, busy });
  };

  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const horizonIso = new Date(now + HORIZON_MS).toISOString();

  // ⚠️ TWO QUERIES, NOT A JOIN, and not by preference: `meetings` and `meeting_settings` are
  // both keyed on a `client_id` TEXT column with NO foreign key between them (326 follows the
  // house style — no table has an FK to client_configs), so PostgREST cannot infer the
  // relationship. A first version asked for `meeting_settings!inner(reminder_hours)` and every
  // run 500'd with "Could not find a relationship between 'meetings' and 'meeting_settings'
  // in the schema cache". There are a few dozen tenants at most; this is one small read.
  const { data: settingsRows, error: se } = await admin.from("meeting_settings")
    .select("client_id, reminder_hours").eq("enabled", true);
  if (se) throw se;
  const wants = new Map<string, number[]>();
  // deno-lint-ignore no-explicit-any
  for (const row of ((settingsRows ?? []) as any[])) {
    const hours = Array.isArray(row.reminder_hours)
      ? row.reminder_hours.map((h: unknown) => Math.trunc(Number(h))).filter((h: number) => Number.isFinite(h) && h > 0)
      : [];
    if (hours.length) wants.set(row.client_id, hours);
  }
  // Nobody has asked for a reminder: stop before touching the meetings table at all.
  if (!wants.size) return await finish({ ok: true, considered: 0, sent: 0, skippedLate: 0, noEmail: 0, failed: 0, candidates: 0 });

  // Candidates: booked meetings starting between now and the horizon, on a tenant that asked
  // for at least one reminder. The `meetings_reminder_due` index (327) serves the time window,
  // which is the whole of the selectivity.
  const { data: rows, error } = await admin.from("meetings")
    .select("id, client_id, starts_at, reminders_sent, customer_email")
    .eq("status", "booked")
    .in("client_id", [...wants.keys()])
    .gt("starts_at", nowIso)
    .lt("starts_at", horizonIso)
    .order("starts_at")
    .limit(500);
  if (error) throw error;

  let sent = 0, skippedLate = 0, noEmail = 0, failed = 0, retrying = 0;
  let considered = 0;

  // deno-lint-ignore no-explicit-any
  for (const m of ((rows ?? []) as any[])) {
    if (sent + skippedLate + failed >= MAX_PER_RUN) break;
    if (Date.now() - now > RUN_BUDGET_MS) break; // see RUN_BUDGET_MS

    const hours: number[] = wants.get(m.client_id) ?? [];
    if (!hours.length) continue;

    const already: number[] = Array.isArray(m.reminders_sent) ? m.reminders_sent.map(Number) : [];
    const startMs = Date.parse(m.starts_at);
    if (!Number.isFinite(startMs)) continue;

    // Largest offset first: if both a 24h and a 2h reminder came due in the same tick (a
    // backlog), the one that fires is the one whose moment came first, and the other is
    // claimed as late. Sending both in one minute would be two emails about one meeting.
    for (const h of hours.slice().sort((a, b) => b - a)) {
      if (already.includes(h)) continue;
      const dueAt = startMs - h * 3_600_000;
      if (dueAt > now) continue; // not yet
      considered++;

      // CLAIM FIRST, in the UPDATE itself: `not (h = any(reminders_sent))` is what stops two
      // overlapping ticks both sending. A read-then-write would let both see it unsent.
      const { data: claimed, error: ce } = await admin.rpc("claim_meeting_reminder", {
        p_meeting_id: m.id,
        p_hours: h,
      });
      if (ce) {
        failed++;
        await logEdgeError({
          fn: "meeting-reminders", req, clientId: m.client_id, code: "claim_failed",
          message: `Could not claim the ${h}h reminder for meeting ${m.id}: ${ce.message}`,
        });
        break;
      }
      if (!claimed) break; // somebody else took it in this same tick

      // The clock read NOW, not at the top of the run: a run slowed by a slow provider must not
      // judge a reminder by a time that has already passed.
      const lateBy = Date.now() - dueAt;
      const grace = lateGraceMs(h);
      if (lateBy > grace) {
        // Claimed so it never retries, deliberately NOT sent — see LATE_GRACE_MS and lateGraceMs.
        skippedLate++;
        await logEdgeError({
          fn: "meeting-reminders", req, clientId: m.client_id, code: "reminder_too_late",
          message: `The ${h}h reminder for meeting ${m.id} came due ${Math.round(lateBy / 60000)} min ago, past its ${Math.round(grace / 60000)} min grace, so it was marked done WITHOUT being sent. A cron or email outage is the usual cause.`,
        });
        break;
      }

      if (!m.customer_email) { noEmail++; break; }

      const out = await sendMeetingEmail(admin, {
        meetingId: m.id, which: "reminder", reminderHours: h, req,
        // The same on every try of this one reminder: see the retry below.
        idempotencyKey: `meeting-reminder/${m.id}/${h}`,
      });
      if (out.sent) sent++; else failed++;
      // ⚠️ A FAILED REMINDER IS RETRIED NOW (2026-11-06). It used to stay claimed and never go:
      // un-claiming risked a double-send, and a missing reminder was the lesser harm. The key
      // above removes that risk — if the try that "failed" did reach Resend, the retry gets the
      // first answer back and the customer one email — so a failure the provider may recover from
      // (out.transient) is un-claimed, and the next tick tries again. The late grace still ends it:
      // once the reminder is later than its grace (two hours, or a quarter of the offset) it is
      // claimed without sending, so a long outage never turns into "see you tomorrow" an hour
      // before the meeting, or "in 2 hours" minutes before it.
      // A refusal no retry changes (no address, switched off, a permanent provider verdict) stays
      // claimed. meetingSend logs every failure.
      if (!out.sent && out.transient) {
        if (await unclaimReminder(admin, m.id, h)) retrying++;
      }
      // One reminder per meeting per tick, whatever happened.
      break;
    }
  }

  return await finish({ ok: true, considered, sent, skippedLate, noEmail, failed, retrying, candidates: (rows ?? []).length });
}));
