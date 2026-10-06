// _shared/usageGate.ts — "may this tenant start something metered right now?" (migration 259)
//
// Phone usage (call minutes, text segments) is charged AFTER the fact, by the Worker's usage
// cron, from Twilio's own price for each leg. Nothing here charges anything. This module only
// answers the question asked BEFORE a text goes or a call is placed: is the wallet above the
// floor, or should the send be refused and the builder told to top up?
//
// The answer comes from ONE place, `public.wallet_usage_gate` (259), so the SMS path here and
// the Worker's call path (workers/phone-api/src/wallet.ts) cannot disagree about what "armed",
// "exempt" or "below the floor" means. This file adds only the two things the database cannot
// know: the deployment's env rail, and what to do when the question itself fails.
//
// ── THE ENV RAIL ───────────────────────────────────────────────────────────────────
// `PHONE_USAGE_METERS` must be exactly "on" before the database is even asked. Anything else —
// unset, "off", a typo — is disarmed, and a disarmed gate costs zero network. That is how this
// ships: deployed, reviewed and inert, with the meter row in usage_prices AND this variable
// both needing a deliberate human act. ⚠️ The Worker and the edge functions read it from
// DIFFERENT places (wrangler.jsonc vars; Supabase function secrets), so arming SMS on the edge
// means setting the secret there too. Setting it on the Worker alone arms calls and leaves
// texts free.
//
// ── FAILS OPEN ─────────────────────────────────────────────────────────────────────
// Any error — the RPC missing because 259 is not applied, a network blip, a malformed reply —
// ALLOWS the send. A builder who cannot text a customer because our billing query hiccuped
// has lost something real; us not refusing one text costs a few cents, and the cron still
// charges for it afterwards (the charge never depended on this gate). Same posture as
// portal-billing's entitlement read. The error is RETURNED, not logged here, so the caller
// can log it under its own name — this file stays a leaf.
//
// ── A LEAF, ON PURPOSE ─────────────────────────────────────────────────────────────
// Zero imports. smsSend.ts imports this, and smsSend.ts is ALSO bundled into the Cloudflare
// Worker (workers/phone-api/src/routes/sms.ts imports it by relative path; src/env.ts shims
// Deno.env over the Worker's env). So the only Deno API used here is `Deno.env.get`, and the
// only globals are fetch, AbortController and setTimeout, which both runtimes have. Adding a
// `jsr:`/`npm:` import or another Deno.* call here breaks the Worker's bundle, not this file.

// deno-lint-ignore no-explicit-any
type Admin = any;

/** The usage_prices kinds the gate is asked about. Outbound is all a refusal can stop. */
export type UsageMeter = "sms_segment" | "voice_minute";

/**
 * Why the gate answered as it did. The first four are the database's (wallet_usage_gate);
 * `error` is this file's, and always comes with `allow: true`.
 */
export type UsageGateReason = "disarmed" | "exempt" | "above_floor" | "below_floor" | "error";

export type UsageGate = {
  allow: boolean;
  reason: UsageGateReason;
  /** balance − held − the sub-cent remainder rounded up. Null when the database was not asked. */
  availableCents: number | null;
  floorCents: number | null;
  /** True only when the database said so. Drives "being topped up" vs "add funds". */
  autoTopupEnabled: boolean;
  /** Set only with reason 'error': what went wrong, for the caller's log. Never shown to a user. */
  error?: string;
};

const DB_REASONS: ReadonlySet<string> = new Set(["disarmed", "exempt", "above_floor", "below_floor"]);

const DISARMED: UsageGate = {
  allow: true, reason: "disarmed", availableCents: null, floorCents: null, autoTopupEnabled: false,
};

function openOnError(error: string): UsageGate {
  return { allow: true, reason: "error", availableCents: null, floorCents: null, autoTopupEnabled: false, error };
}

/** The deployment-wide rail. Exactly "on" arms; anything else, including unreadable, does not. */
export function usageMetersOn(): boolean {
  try {
    return Deno.env.get("PHONE_USAGE_METERS") === "on";
  } catch {
    return false;
  }
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Ask whether `clientId` may start a metered `meter` action. NEVER THROWS, and never refuses
 * on its own failure: every path that is not a clear "below the floor" from the database
 * answers `allow: true`.
 */
export async function checkUsageGate(admin: Admin, clientId: string, meter: UsageMeter): Promise<UsageGate> {
  if (!usageMetersOn()) return DISARMED;
  try {
    const { data, error } = await admin.rpc("wallet_usage_gate", { p_client_id: clientId, p_meter: meter });
    if (error) return openOnError(`wallet_usage_gate failed: ${String(error.message ?? error)}`);
    // jsonb comes back as an object. Anything else — null from a function that returned
    // nothing, an array from a future `returns table` — is not a verdict.
    const d = (data && typeof data === "object" && !Array.isArray(data)) ? data as Record<string, unknown> : null;
    if (!d || typeof d.allow !== "boolean") return openOnError("wallet_usage_gate returned no verdict");

    // `allow` is the database's decision and is kept as given. An unrecognised reason (a
    // later migration adding one) is folded onto the side `allow` already chose, so the type
    // stays closed without overruling the verdict.
    const raw = typeof d.reason === "string" ? d.reason : "";
    const reason = (DB_REASONS.has(raw) ? raw : (d.allow ? "above_floor" : "below_floor")) as UsageGateReason;
    return {
      allow: d.allow,
      reason,
      availableCents: num(d.available_cents),
      floorCents: num(d.floor_cents),
      autoTopupEnabled: d.auto_topup_enabled === true,
    };
  } catch (e) {
    return openOnError(`wallet_usage_gate threw: ${(e as Error)?.message ?? String(e)}`);
  }
}

// ── Asking for an automatic top-up ─────────────────────────────────────────────────
//
// A refusal on a tenant with auto top-up switched on should not be a dead end: the refusal
// says "your wallet is being topped up, try again in a minute", and this is what makes that
// sentence true. It does not charge anything itself. It asks the `wallet-autotopup` function,
// which runs the SAME code portal-settings runs after a 3D hold (_shared/walletAutoTopup.ts):
// the threshold, the hour's cooldown, the card on file, the decline switch-off. So a burst of
// refused texts is one charge at most, decided there, not here.
//
// Why over HTTP rather than calling runAutoTopup directly: this file is bundled into the
// Worker, and the top-up path is not (it needs the NMI gateway secrets, which live only on
// the edge). One door, used by both runtimes.

/** Long enough for wallet-autotopup to finish a card sale (nmiPost gives the gateway 30 s). */
export const AUTO_TOPUP_REQUEST_TIMEOUT_MS = 35_000;

export type AutoTopupRequestResult = {
  /** False when nothing was sent (not configured, or no client id). */
  requested: boolean;
  /** HTTP status from wallet-autotopup; null when the request never completed. */
  status: number | null;
  /** The function's own answer: did it charge, and did that work. Null without one. */
  fired: boolean | null;
  ok: boolean;
  reason: string | null;
};

/**
 * POST `{client_id}` to wallet-autotopup with the service-role bearer and report what came
 * back. NEVER THROWS — every failure is a resolved result with `ok: false`, so the caller can
 * hand the promise to a `waitUntil` and log a failure without guarding it.
 */
export function requestAutoTopup(
  clientId: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<AutoTopupRequestResult> {
  const notSent = (reason: string): AutoTopupRequestResult =>
    ({ requested: false, status: null, fired: null, ok: false, reason });
  return (async () => {
    let url = "", key = "";
    try {
      url = String(Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
      key = String(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
    } catch {
      return notSent("env_unreadable");
    }
    if (!url || !key) return notSent("not_configured");
    if (!clientId) return notSent("no_client");

    const f = opts.fetchImpl ?? fetch;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? AUTO_TOPUP_REQUEST_TIMEOUT_MS);
    try {
      const res = await f(`${url}/functions/v1/wallet-autotopup`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId }),
        signal: ctrl.signal,
      });
      let body: Record<string, unknown> | null = null;
      try {
        const parsed = await res.json();
        body = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
      } catch { /* a gateway 401/504 page is not JSON — status says enough */ }
      return {
        requested: true,
        status: res.status,
        fired: typeof body?.fired === "boolean" ? body.fired : null,
        ok: res.ok && body?.ok !== false,
        reason: typeof body?.reason === "string" ? body.reason.slice(0, 100) : (res.ok ? null : `http_${res.status}`),
      };
    } catch (e) {
      const aborted = (e as Error)?.name === "AbortError";
      return { requested: true, status: null, fired: null, ok: false, reason: aborted ? "timeout" : "network" };
    } finally {
      clearTimeout(timer);
    }
  })();
}

/**
 * Keep a background promise alive past the response. The caller's own `waitUntil` wins (the
 * Worker passes ctx.waitUntil); on the edge, EdgeRuntime.waitUntil; otherwise it floats, with
 * its rejection swallowed. Never throws.
 */
export function keepAlive(p: Promise<unknown>, waitUntil?: ((p: Promise<unknown>) => void) | null): void {
  const quiet = p.catch(() => undefined);
  try {
    if (waitUntil) { waitUntil(quiet); return; }
    // deno-lint-ignore no-explicit-any
    const rt = (globalThis as any).EdgeRuntime;
    if (rt && typeof rt.waitUntil === "function") rt.waitUntil(quiet);
  } catch { /* the request is already in flight; keeping it alive is best effort */ }
}
