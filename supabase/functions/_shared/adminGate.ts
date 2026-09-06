// Shared brute-force-resistant gate for the two ADMIN_PASSWORD-protected functions
// (admin-catalog, admin-save-settings). BOTH must use it: they share the same secret, so
// throttling only one would leave the other as a free guessing oracle.
//
// What it adds on top of the constant-time compare:
//   * escalating per-IP lockout      (5 failures → 1 min, 10 → 5 min, 15 → 30 min, 20+ → 6 h)
//   * a fixed delay on every failure (turns "as fast as HTTP allows" into ~2.5 guesses/sec)
//   * a GLOBAL latency brake         (slows a rotating-IP attack without a hard lock, which
//                                     would hand an attacker a way to lock the operator out)
//   * an audit row for every failure and every lockout, so guessing is visible after the fact
//   * failures cleared on success, and the counter reset after an hour of quiet so an
//     operator's occasional typo never accumulates into a lockout
//
// Ledger: public.admin_auth_attempts (migration 053). Audit: public.admin_audit.

// deno-lint-ignore-file no-explicit-any

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let m = 0;
  for (let i = 0; i < a.length; i++) m |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return m === 0;
}

// Caller IP = the FIRST entry of x-forwarded-for. Verified empirically on this platform
// (2026-07-26): Supabase's inbound proxy appends its own hop, so the RIGHTMOST entry is a
// rotating 13.248.121.x proxy address — bucketing on it gave every request a fresh bucket
// and defeated the lockout entirely. The leftmost entry is the real caller.
//
// A client CAN prepend a forged value, so per-IP lockout is a brake on naive scripts —
// NOT the last line of defence. The defence that cannot be rotated away is the global
// failure brake below.
//
// ⚠️ AND THE BUCKET IS NOT TRUSTWORTHY ATTRIBUTION EITHER. This comment used to call it
// "the source of honest audit attribution"; it is not, because the value is chosen by the
// caller. An `admin_auth_failed` row naming an address is evidence that SOMEONE claimed
// that address, never that the request came from it — read a run of them as a pattern, and
// never as an accusation against whoever really owns the IP.
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for") || "";
  const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length) return parts[0].slice(0, 100);
  const cf = (req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || "").trim();
  return cf ? cf.slice(0, 100) : "unknown";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const FAIL_DELAY_MS = 400;          // per-failure slowdown
const GLOBAL_WINDOW_MIN = 15;       // rolling window for the distributed-attack brake
const QUIET_RESET_MIN = 60;         // no failures for this long → counter restarts
const GLOBAL_BUCKET = "GLOBAL";

// Escalating GLOBAL delay tiers, keyed on total failures in the window. This is the
// defence an attacker cannot rotate away by forging x-forwarded-for. It is delay-only —
// never a hard lock — because a global lock would hand an attacker a way to lock the
// operator out of their own admin tool. Crucially the delay applies ONLY to failures, so
// the legitimate operator entering the CORRECT password never waits at all, while sustained
// guessing collapses to a fraction of an attempt per second.
function globalExtraDelayMs(windowFailures: number): number {
  if (windowFailures >= 300) return 10000;
  if (windowFailures >= 100) return 5000;
  if (windowFailures >= 40) return 2000;
  return 0;
}

function lockMsFor(failures: number): number {
  if (failures >= 20) return 6 * 60 * 60 * 1000;
  if (failures >= 15) return 30 * 60 * 1000;
  if (failures >= 10) return 5 * 60 * 1000;
  if (failures >= 5) return 60 * 1000;
  return 0;
}

async function audit(admin: any, action: string, note: string) {
  try {
    await admin.from("admin_audit").insert({ action, note: note.slice(0, 500) });
  } catch (_e) { /* never block the gate on a logging failure */ }
}

export type GateOutcome =
  | { ok: true }
  | { ok: false; status: number; body: Record<string, unknown> };

/**
 * Verify the shared admin password with throttling, lockout and auditing.
 * `admin` must be a service-role Supabase client. `attemptedAction` is recorded in the
 * audit note so a guessing run shows WHAT the caller was reaching for.
 */
export async function checkAdminPassword(
  req: Request,
  supplied: unknown,
  admin: any,
  attemptedAction = "",
): Promise<GateOutcome> {
  const expected = Deno.env.get("ADMIN_PASSWORD");
  if (!expected) {
    return { ok: false, status: 500, body: { error: "ADMIN_PASSWORD is not configured on the server." } };
  }

  const bucket = clientIp(req);
  const nowMs = Date.now();

  // 1. Locked out? Refuse before doing any comparison at all.
  const { data: row } = await admin
    .from("admin_auth_attempts")
    .select("failures, last_failure_at, locked_until")
    .eq("bucket", bucket)
    .maybeSingle();

  const lockedUntilMs = row?.locked_until ? new Date(row.locked_until).getTime() : 0;
  const locked = lockedUntilMs > nowMs;

  // 2. COMPARE FIRST, AND REFUSE THE LOCKOUT ONLY ON A WRONG PASSWORD.
  //
  // ⚠️ THE ORDER IS THE WHOLE FIX. This used to refuse a locked bucket BEFORE comparing, and
  // the bucket is `x-forwarded-for`, which the CLIENT CHOOSES. So twenty failures carrying
  // `X-Forwarded-For: <the operator's IP>` locked the OPERATOR out of admin-catalog and
  // admin-save-settings for six hours, from anywhere, at a cost of twenty requests. The
  // attacker never needed the password — the lockout was the weapon.
  //
  // This is the identical reasoning the GLOBAL brake below already states — "delay-only,
  // never a hard lock, because a global lock would hand an attacker a way to lock the
  // operator out of their own admin tool" — which was simply never applied to the per-IP
  // lock sitting above it.
  //
  // Comparing first gives an attacker NOTHING: without the password they are still refused,
  // still counted, still delayed, and the lockout still costs them every escalation tier. It
  // only stops a lockout someone else provoked from refusing a person who holds the secret.
  // No new oracle either — the only state a correct password reveals is that it was correct,
  // which is already the end of the game.
  const ok = typeof supplied === "string" && supplied.length > 0 && safeEqual(supplied, expected);

  if (ok) {
    // Clear this bucket's history so a successful operator never carries old failures — and,
    // now, so a lockout an attacker planted on their address does not outlive their next
    // successful sign-in.
    if (row) { try { await admin.from("admin_auth_attempts").delete().eq("bucket", bucket); } catch (_e) { /* non-fatal */ } }
    return { ok: true };
  }

  // 3. Wrong password on a locked bucket: refuse without spending another escalation. The
  //    counter is deliberately NOT advanced here — the lock is already at its tier, and a
  //    caller hammering a locked bucket must not be able to push a bucket that may not be
  //    theirs deeper into the 6-hour tier.
  if (locked) {
    const retryAfter = Math.ceil((lockedUntilMs - nowMs) / 1000);
    await audit(admin, "admin_auth_locked", `bucket=${bucket} action=${attemptedAction} retry_after_s=${retryAfter}`);
    await sleep(FAIL_DELAY_MS);
    return {
      ok: false,
      status: 429,
      body: { error: `Too many incorrect attempts. Try again in ${retryAfter >= 60 ? Math.ceil(retryAfter / 60) + " min" : retryAfter + "s"}.`, retryAfterSeconds: retryAfter },
    };
  }

  // 3. Failure: count it, escalate, audit, and slow the caller down.
  const quiet = row?.last_failure_at
    ? (nowMs - new Date(row.last_failure_at).getTime()) > QUIET_RESET_MIN * 60 * 1000
    : false;
  const failures = (quiet || !row) ? 1 : (Number(row.failures) || 0) + 1;
  const lockMs = lockMsFor(failures);
  const nowIso = new Date(nowMs).toISOString();

  try {
    await admin.from("admin_auth_attempts").upsert({
      bucket,
      failures,
      first_failure_at: (quiet || !row) ? nowIso : undefined,
      last_failure_at: nowIso,
      locked_until: lockMs ? new Date(nowMs + lockMs).toISOString() : null,
    }, { onConflict: "bucket" });
  } catch (_e) { /* if the ledger write fails we still delay + refuse below */ }

  await audit(admin, "admin_auth_failed", `bucket=${bucket} action=${attemptedAction} failures=${failures}${lockMs ? ` locked_for_s=${Math.round(lockMs / 1000)}` : ""}`);

  // Global brake (cannot be evaded by forging x-forwarded-for): count failures across ALL
  // buckets in the rolling window and escalate the delay. Delay-only, failures-only.
  let extra = 0;
  try {
    const since = new Date(nowMs - GLOBAL_WINDOW_MIN * 60 * 1000).toISOString();
    const g = await admin
      .from("admin_auth_attempts")
      .select("failures")
      .neq("bucket", GLOBAL_BUCKET)
      .gte("last_failure_at", since);
    const windowFailures = (g.data ?? []).reduce((n: number, r: any) => n + (Number(r.failures) || 0), 0);
    extra = globalExtraDelayMs(windowFailures);
    // Housekeeping: forged/rotating buckets would otherwise grow this table forever.
    if (failures === 1) {
      const stale = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
      await admin.from("admin_auth_attempts").delete().lt("last_failure_at", stale).is("locked_until", null);
    }
  } catch (_e) { /* brake + housekeeping are best-effort */ }

  await sleep(FAIL_DELAY_MS + extra);

  const remaining = Math.max(0, 5 - failures);
  return {
    ok: false,
    status: 401,
    body: {
      error: lockMs
        ? `Incorrect admin password. Too many attempts — locked for ${lockMs >= 60000 ? Math.round(lockMs / 60000) + " min" : "1 min"}.`
        : `Incorrect admin password.${remaining > 0 && failures > 1 ? ` (${remaining} more before a temporary lockout.)` : ""}`,
    },
  };
}
