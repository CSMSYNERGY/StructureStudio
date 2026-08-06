/**
 * Intuit OAuth endpoint discovery.
 *
 * Intuit publishes an OpenID discovery document naming the authorize, token and revoke
 * endpoints. Reading it means a rotation on Intuit's side does not need a redeploy here, and it
 * is what their App Assessment questionnaire asks for ("did you use the Intuit discovery
 * document to get the latest endpoints required in the OAuth2.0 flow?"). Before this module the
 * three URLs were hardcoded string literals in four separate places.
 *
 * ── THE RULE THIS MODULE EXISTS TO KEEP ────────────────────────────────────────────────────
 * **Discovery must never be able to break the OAuth flow.** It is a nicety; connecting a
 * QuickBooks company is the product. So every failure path — network error, timeout, non-200,
 * unparsable JSON, a missing or untrustworthy endpoint — resolves to the SAME pinned constants
 * that were hardcoded before, and `qboEndpoints()` never rejects. The worst case is exactly
 * today's behaviour. Anything else would trade a theoretical problem (Intuit moves an endpoint,
 * which has not happened in years) for a real one (an outage at Intuit's metadata host takes
 * down connecting, refreshing and disconnecting all at once).
 *
 * ── WHY THE VALIDATION IS NOT PARANOIA ─────────────────────────────────────────────────────
 * `token_endpoint` is where we send `Authorization: Basic base64(client_id:client_secret)`.
 * A document that could redirect it anywhere is a credential-exfiltration primitive, and
 * `authorization_endpoint` is where we send the customer, so a bad one is a phishing primitive.
 * TLS covers the transport; what it does not cover is us *believing* a response that parsed.
 * So each endpoint must be https and must live on intuit.com — see `validEndpoint`. The check
 * is a suffix match rather than an allowlist of today's hosts on purpose: an allowlist would
 * reject Intuit moving to a new subdomain, which is the entire scenario this module exists for.
 *
 * The discovery fetch itself is a bare GET. It sends no Authorization header, no client id, and
 * no tenant identifier — there is nothing in it to leak, and nothing tenant-specific about the
 * answer, which is why one process-wide cache is correct.
 */

// Pinned fallbacks — byte-identical to the constants these replaced, so a discovery failure is
// a no-op rather than a behaviour change. Do NOT "tidy" these away: they are the floor.
const FALLBACK = {
  authorize: "https://appcenter.intuit.com/connect/oauth2",
  token: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
  revoke: "https://developer.api.intuit.com/v2/oauth2/tokens/revoke",
} as const;

const PROD_DISCOVERY = "https://developer.api.intuit.com/.well-known/openid_configuration";
const SANDBOX_DISCOVERY = "https://developer.api.intuit.com/.well-known/openid_sandbox_configuration";

/** Hard cap on the FETCH. qbo-oauth-callback runs while the customer's browser waits on a
 *  redirect, so a hung metadata host must cost 4s and a fallback, never the connection.
 *
 *  Precisely: this bounds the metadata request only. A failing lookup additionally awaits one
 *  best-effort `app_errors` insert (see reportUnavailable), which is not separately timed — the
 *  same untimed-PostgREST-await shape as every other logEdgeError call site in this codebase,
 *  including the two nonce queries qbo-oauth-callback already makes before it reaches here. So
 *  "4s" is the metadata budget, not a total wall-clock guarantee. The insert is awaited rather
 *  than fired-and-forgotten on purpose: its absence is how we confirm discovery actually worked,
 *  and an un-awaited insert can be lost when the isolate is torn down. */
const TIMEOUT_MS = 4000;

/** Long, because this document changes on the order of never, and short enough that a real
 *  rotation propagates the same working day. Isolates recycle far more often than this anyway,
 *  so in practice the fetch happens about once per cold start. */
const TTL_MS = 6 * 60 * 60 * 1000;

export type QboEndpoints = {
  authorize: string;
  token: string;
  revoke: string;
  /** false when these are the pinned fallbacks — i.e. discovery was not usable this cycle. */
  discovered: boolean;
};

/**
 * Read at call time, not module load: the same reason `qboToken.clientCreds()` does. Deliberately
 * NOT imported from qboToken — that module imports this one, and a cycle between two modules that
 * both run during an OAuth callback is not worth the saved line.
 *
 * Today both discovery documents return the same authorize and token endpoints, so this choice is
 * currently cosmetic for the three URLs we read. It is still derived rather than pinned to
 * production, because the day Intuit diverges them a silently-production-only lookup would send
 * sandbox traffic to production endpoints and the failure would be baffling.
 */
function discoveryUrl(): string {
  const base = Deno.env.get("QBO_API_BASE") ?? "";
  return /sandbox/i.test(base) ? SANDBOX_DISCOVERY : PROD_DISCOVERY;
}

/**
 * An endpoint we are willing to send credentials or customers to: absolute, https, on intuit.com,
 * and free of a fragment.
 *
 * `new URL()` does the load-bearing work — a string-contains check would accept
 * "https://intuit.com.example.net/..." and a `startsWith` check would accept
 * "https://evil.example.net/?x=https://intuit.com". Comparing the PARSED hostname makes both
 * impossible: "intuit.com.example.net".endsWith(".intuit.com") is false.
 *
 * The fragment rejection is not cosmetic. RFC 6749 §3.1 says the authorization endpoint "MUST NOT
 * include a fragment component", and a fragment is never sent to a server — so a fragment-bearing
 * authorize URL would swallow every parameter appended after it (client_id, scope, redirect_uri,
 * state) and every connect attempt would fail at Intuit. A fragment on a POST target is equally
 * meaningless. Rejecting it means the document is treated as malformed and we use the pinned
 * endpoints, which is the module's whole posture.
 *
 * A QUERY component is deliberately ALLOWED: the same RFC clause permits one and requires clients
 * to retain it when adding parameters. Retaining it correctly is the CALLER's job — see the
 * composition in qbo-oauth-connect, which uses URL.searchParams rather than string concatenation
 * precisely so a query here cannot corrupt the request.
 */
function validEndpoint(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.hash) return null;
  const host = url.hostname.toLowerCase();
  if (host !== "intuit.com" && !host.endsWith(".intuit.com")) return null;
  return url.toString();
}

let cached: { at: number; value: QboEndpoints } | null = null;
let inFlight: Promise<QboEndpoints> | null = null;
/** Bounds the noise: one app_errors row per isolate per outage, not one per request. */
let loggedFailure = false;

async function reportUnavailable(reason: string): Promise<void> {
  if (loggedFailure) return;
  loggedFailure = true;
  // Imported lazily so the happy path never pulls in a Supabase client it will not use, and so
  // this leaf module stays importable by anything.
  try {
    const { logEdgeError } = await import("./logError.ts");
    await logEdgeError({
      fn: "qbo-discovery",
      code: "qbo_discovery_unavailable",
      // Worded so nobody triages this as an incident: the flow is fine, we are simply on the
      // pinned endpoints. It matters only because it means Auth Q5 is effectively "No" again.
      message: "Intuit's OAuth discovery document was unusable; falling back to the pinned "
        + `endpoints (OAuth is unaffected). Reason: ${reason}`,
      context: { reason, discoveryUrl: discoveryUrl(), fallback: true },
    });
  } catch {
    // Reporting a benign fallback must not become a real failure.
  }
}

async function load(): Promise<QboEndpoints> {
  const url = discoveryUrl();
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      await reportUnavailable(`HTTP ${res.status}`);
      return { ...FALLBACK, discovered: false };
    }
    const doc = await res.json() as Record<string, unknown>;

    const authorize = validEndpoint(doc?.authorization_endpoint);
    const token = validEndpoint(doc?.token_endpoint);
    const revoke = validEndpoint(doc?.revocation_endpoint);

    // ALL-OR-NOTHING, deliberately. Per-field fallback would let us mix sources — a production
    // authorize URL with a sandbox token URL, say — and produce a mismatch far harder to read
    // than a clean fallback. A document with one bad field is also simply not evidence worth
    // trusting for the other two.
    if (!authorize || !token || !revoke) {
      await reportUnavailable(
        `endpoint(s) missing or not on intuit.com over https: ${[
          authorize ? null : "authorization_endpoint",
          token ? null : "token_endpoint",
          revoke ? null : "revocation_endpoint",
        ].filter(Boolean).join(", ")}`);
      return { ...FALLBACK, discovered: false };
    }

    // Re-arm the reporter: without this, `loggedFailure` would stay set for the isolate's whole
    // life after one bad cycle, so a LATER outage would go unrecorded and the comment on that
    // flag ("per isolate per outage") would be false. Cleared only on a fully successful lookup.
    loggedFailure = false;
    return { authorize, token, revoke, discovered: true };
  } catch (e) {
    // Includes the AbortSignal timeout and any JSON parse failure.
    await reportUnavailable((e as Error)?.name === "TimeoutError"
      ? `timed out after ${TIMEOUT_MS}ms`
      : ((e as Error)?.message ?? "unknown error"));
    return { ...FALLBACK, discovered: false };
  }
}

/**
 * The authorize / token / revoke endpoints to use right now. Never throws, never rejects, and
 * never returns a URL that is not https-on-intuit.com.
 *
 * A FAILED lookup is cached like a successful one, on purpose: without that, every request during
 * an Intuit metadata outage pays the full 4s timeout, which would turn a cosmetic degradation into
 * a latency incident on the OAuth callback. `discovered: false` is the signal that it happened.
 */
export async function qboEndpoints(): Promise<QboEndpoints> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;

  // Share one in-flight fetch between concurrent callers rather than stampeding Intuit. `load()`
  // resolves rather than rejecting, so this promise cannot poison the memo with a rejection —
  // which is the classic bug in this pattern.
  if (!inFlight) {
    inFlight = load().then((value) => {
      cached = { at: Date.now(), value };
      inFlight = null;
      return value;
    });
  }
  return await inFlight;
}

/**
 * Append query parameters to a discovered endpoint, retaining any query it already carries.
 *
 * Lives here rather than inline at the call site so it is unit-testable: the composition is the
 * other half of `validEndpoint` deliberately ALLOWING a query component. RFC 6749 §3.1 permits one
 * on the authorization endpoint and requires clients to retain it when adding parameters.
 *
 * The bug this exists to prevent: `${authorize}?${new URLSearchParams(params)}` emits a SECOND
 * "?" when the endpoint already has a query, so a spec-conformant
 * "…/connect/oauth2?locale=en" produces "…?locale=en?client_id=…" — locale swallows client_id,
 * and every connect attempt fails at Intuit. That was invisible while the left-hand side was a
 * hardcoded constant; it stopped being one the moment endpoints came from a document Intuit
 * controls, which is precisely the day this module is supposed to help.
 */
export function withParams(endpoint: string, params: Record<string, string>): string {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/** Test seam: drop the cache so the next call re-reads. Not used in request paths. */
export function _resetQboDiscoveryCache(): void {
  cached = null;
  inFlight = null;
  loggedFailure = false;
}
