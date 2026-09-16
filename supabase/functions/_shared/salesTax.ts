/**
 * Sales-tax rate lookup for StructureStudio-issued documents (migration 127).
 *
 * TAX IS MONEY, NOT COSMETICS. Every other best-effort module in this directory —
 * quotePdf.ts, emailSend.ts, qboInvoice.ts — follows the same contract: a failure degrades to
 * NOTHING and the money path continues, because a missing plan sheet or a slow bookkeeping
 * push must never cost a sale. This module deliberately does NOT follow that contract. There
 * is no "no tax" state to degrade to: a quote issued with no tax is a quote the customer signs
 * at the wrong number and an invoice the builder under-collects on. So every failure path here
 * degrades to the tenant's OWN configured rate (client_settings.ss_tax_rate) and says so, and
 * that setting is mandatory before invoice_in_ghl can go false precisely so this fallback can
 * never be empty.
 *
 * The caller records `source` on the document and on the acceptance. "avalara" means the
 * delivery address resolved; "fallback" means it did not and the builder's own rate was used —
 * which the portal surfaces, because a quote taxed at the wrong jurisdiction is invisible
 * otherwise.
 *
 * WHY A RATE LOOKUP AND NOT A TRANSACTION (decided 2026-08-27): we ask Avalara what the rate
 * is; the builder files their own returns. Nothing is recorded on Avalara's side, so there is
 * no filing obligation riding on a dropped call. That is why this uses /taxrates/byaddress
 * rather than an uncommitted SalesOrder CreateTransaction — byaddress needs no company profile
 * or nexus configured per tenant, which keeps tenant onboarding at zero. Its limitation is the
 * trade: it returns the jurisdiction's general rate and applies no product-taxability rules. We
 * supply those ourselves from the per-item `taxable` flags the builder sets on their own
 * catalog, which is the more defensible place for them anyway. Swapping to SalesOrder later is
 * confined to avalaraRate() below.
 *
 * EVERY CALL IS METERED BY AVALARA. This comment used to say a rate lookup carried "no
 * per-transaction cost", and that was wrong: a byaddress request is metered against the volume
 * the account was bought with, and there is no sandbox — the first request made with the
 * production credentials is a billed one. Treat every request that leaves this file as money
 * spent. Three things below exist because of that:
 *   • resolveRate() never calls out unless the caller opts in (`allowLookup`), however the
 *     credentials are set;
 *   • a 4xx other than 429 is never retried — asking again changes nothing and costs again;
 *   • every lookup that reached the network is reported back through `onResult`, so the caller
 *     can write it to its ledger (tax_lookups, migration 242) whatever the outcome.
 * The answer is also APPROXIMATE: a general rate for the address, no product taxability and no
 * origin/destination sourcing. Anything a builder or customer reads says "verified against the
 * delivery address", never "exact".
 *
 * Deliberately import-free, so its tests run offline with no import map, and so the ledger
 * write stays with the caller's own admin client rather than hidden in here.
 */

/** Read at CALL time, not module load, so a rotated secret is seen by a warm isolate and a
 *  test can take the credentials away without re-importing the module. */
function creds() {
  return {
    base: (Deno.env.get("AVALARA_API_BASE") || "https://rest.avatax.com").replace(/\/+$/, ""),
    accountId: Deno.env.get("AVALARA_ACCOUNT_ID") || "",
    licenseKey: Deno.env.get("AVALARA_LICENSE_KEY") || "",
  };
}

/** Avalara's integration identifier, sent on every request:
 *  `AppName; AppVersion; AdapterName; AdapterVersion; MachineName` (machine name left empty).
 *  It is how Avalara support tells our traffic apart from anyone else's on the same account. */
export const AVALARA_CLIENT_HEADER = "StructureStudio; 1.0; CSM Synergy; 1.0;";

/** Matches _shared/contactAddress.ts' StopAddress — the delivery address off designs.contact. */
export interface TaxAddress {
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

/** Why a lookup that reached the network did not produce a rate. Mirrors the `outcome` CHECK on
 *  tax_lookups (migration 242), which adds 'ok' and 'not_configured'. */
export type AvalaraFailure =
  | "credentials_rejected" // 401/403: the account id or licence key is wrong
  | "subscription"         // 401/403 naming a missing entitlement — right key, wrong plan
  | "bad_address"          // any other 4xx: Avalara could not place the address
  | "rate_limited"         // 429, after its one retry
  | "timeout"              // no answer inside TIMEOUT_MS, after its one retry
  | "network"              // connection failure, or a 5xx after its one retry
  | "malformed";           // a 2xx whose body carried no usable rate

/** One lookup's outcome, as the ledger records it. `attempts` counts HTTP requests made, so a
 *  retried 5xx reads 2 — the row is one lookup, the attempts are what Avalara may have counted. */
export type AvalaraResult =
  | { ok: true; rate: number; jurisdiction: string | null; httpStatus: number; attempts: number; failure: null }
  | { ok: false; rate: null; jurisdiction: null; httpStatus: number | null; attempts: number; failure: AvalaraFailure };

export interface ResolvedRate {
  /** Combined rate as a FRACTION (0.0725 = 7.25%). */
  rate: number;
  /** "Bibb County, GA" — for the tax row on the document. Null when unknown. */
  jurisdiction: string | null;
  source: "avalara" | "fallback";
  /** Why the fallback was used. Telemetry and support only — never shown to a customer. */
  reason: string | null;
  /** Present only when a lookup was made and failed — which kind of failure. Additive. */
  failure?: AvalaraFailure;
}

export interface AvalaraPing {
  /** Both credentials are present in env. False means no request was made. */
  configured: boolean;
  /** Avalara accepted the credentials. */
  authenticated: boolean;
  /** "AccountIdLicenseKey", "None", … — a word, never an identity. */
  authenticationType: string | null;
  /** Null when no HTTP answer arrived (not configured, timeout, network). */
  httpStatus: number | null;
}

/** One retry, because a single dropped connection should not tax a whole sale at the fallback;
 *  more than one would put a customer in front of a spinner while a quote is being issued. */
const TIMEOUT_MS = 6_000;
const ATTEMPTS = 2;
/** A 429 is retried once, after this pause. Asking again immediately would most likely be
 *  refused inside the same window; waiting longer holds a staff member at a spinner. */
const RATE_LIMIT_PAUSE_MS = 500;
const PING_TIMEOUT_MS = 5_000;

/** Error codes Avalara puts on a 401/403 when the credentials are RIGHT but the account is not
 *  entitled to the endpoint. Told apart from a wrong key because the fix is a phone call to
 *  Avalara, not a new secret. */
const SUBSCRIPTION_CODES = new Set(["SubscriptionRequired", "AuthorizationException", "PermissionRequired"]);

/** A rate must be a real fraction. Avalara returns 0.0725; a percent-shaped 7.25 slipping
 *  through would multiply a bill by eight. Bounded to the same 25% ceiling migration 127 puts
 *  on the stored fallback, so a nonsense value is refused rather than charged.
 *
 *  null/undefined/"" are rejected BEFORE Number(), which turns all three into 0 — and a
 *  missing rate is not a 0% rate. A genuine numeric 0 is still accepted: Oregon and Delaware
 *  are real answers, and the whole point of the mandatory setting is that 0 be sayable.
 *
 *  Exported for taxChain.ts, which applies the same test to a location's rate and a stored
 *  verified one — imported rather than copied, because this arithmetic already exists in four
 *  hand-copies that nothing compares. */
export function sane(rate: unknown): number | null {
  if (rate == null || rate === "") return null;
  const n = Number(rate);
  if (!Number.isFinite(n) || n < 0 || n > 0.25) return null;
  return Math.round(n * 100000) / 100000; // numeric(7,5), the column it is stored in
}

/**
 * US state NAME -> two-letter code.
 *
 * The designer's state field is a full-name dropdown ("Missouri"), not a code — see the
 * contact rows in production, and the commit that replaced the 2-letter input. Avalara's
 * `region` parameter wants the CODE. Passing "Missouri" is not a hard error, it is worse:
 * the lookup quietly fails or answers for the wrong place, and because a failed lookup falls
 * back to the tenant's own rate the whole thing looks like it is working. Found while testing
 * against real contacts on 2026-08-29, before Avalara was ever switched on.
 *
 * An already-correct 2-letter code passes through untouched, so both shapes are accepted for
 * as long as both exist in the data.
 */
const STATE_CODES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", "district of columbia": "DC",
  florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN",
  iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO",
  montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND",
  ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
  vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI",
  wyoming: "WY", "puerto rico": "PR",
};

/** The two-letter region Avalara expects, from whatever shape the contact holds. */
export function stateCode(state: unknown): string {
  const raw = String(state ?? "").trim();
  if (!raw) return "";
  if (/^[A-Za-z]{2}$/.test(raw)) return raw.toUpperCase();
  return STATE_CODES[raw.toLowerCase()] ?? "";
}

/** Is there enough address to ask about? A rate lookup needs the jurisdiction, and postcode +
 *  region is the least that identifies one. `hasDestination` in contactAddress.ts is a LOOSER
 *  test (city OR zip) because a delivery stop can be placed from a town name; tax cannot. */
export function taxable(addr: TaxAddress): boolean {
  // The state must be one we can turn into a REGION CODE. A name Avalara would not
  // understand is not a jurisdiction we can ask about, and asking anyway buys a wrong
  // answer dressed as a right one.
  return !!(addr?.zip && stateCode(addr?.state));
}

export function isConfigured(): boolean {
  const { accountId, licenseKey } = creds();
  return !!(accountId && licenseKey);
}

/** The headers every Avalara request carries. Basic auth is base64(accountId:licenseKey). */
function requestHeaders(): Record<string, string> {
  const { accountId, licenseKey } = creds();
  return {
    Authorization: `Basic ${btoa(`${accountId}:${licenseKey}`)}`,
    Accept: "application/json",
    "X-Avalara-Client": AVALARA_CLIENT_HEADER,
  };
}

/**
 * Compose the human-readable jurisdiction from Avalara's rate breakdown. Prefers the county —
 * it is what a builder recognizes and what differs across a delivery radius — then the city,
 * then the state. Null rather than a guess: the document simply shows the rate without a
 * place, which is honest, where a wrong county name on a tax line is not.
 */
function jurisdictionOf(rates: unknown, addr: TaxAddress): string | null {
  const list = Array.isArray(rates) ? rates : [];
  const pick = (type: string) => {
    for (const r of list) {
      const t = String((r as Record<string, unknown>)?.type ?? "");
      const n = String((r as Record<string, unknown>)?.name ?? "").trim();
      if (t.toLowerCase() === type && n) return n;
    }
    return null;
  };
  const place = pick("county") || pick("city") || null;
  const region = (addr?.state || "").trim();
  if (place && region) return `${place}, ${region}`;
  return place || (region || null);
}

const isTimeout = (e: unknown) =>
  (e as { name?: string })?.name === "TimeoutError" || (e as { name?: string })?.name === "AbortError";

/** Read a body we are not going to use, so the connection is released. Never throws. */
async function discard(res: Response): Promise<void> {
  try { await res.body?.cancel(); } catch { /* already consumed or closed */ }
}

/** The `code`s on an Avalara error body — the top-level one and each detail's. Empty when the
 *  body is not the documented `{ error: { code, details: [{ code }] } }` shape. Never throws. */
async function errorCodes(res: Response): Promise<string[]> {
  try {
    const body = JSON.parse(await res.text());
    const err = body?.error;
    const codes = [err?.code, ...(Array.isArray(err?.details) ? err.details.map((d: { code?: unknown }) => d?.code) : [])];
    return codes.filter((c): c is string => typeof c === "string");
  } catch {
    return [];
  }
}

const failed = (failure: AvalaraFailure, httpStatus: number | null, attempts: number): AvalaraResult =>
  ({ ok: false, rate: null, jurisdiction: null, httpStatus, attempts, failure });

/**
 * The Avalara call. Returns a result for EVERY outcome — nothing about tax may throw out of a
 * quote submission — and says precisely what happened, because the ledger and the staff member
 * who pressed the button both need to know whether to fix the address, the key, or wait.
 *
 * RETRIES ARE A BILLING DECISION, so they are spelled out:
 *   401/403        never retried — `subscription` when the body names a missing entitlement,
 *                  otherwise `credentials_rejected`;
 *   429            retried once after a short pause — `rate_limited` if it persists;
 *   other 4xx      never retried — `bad_address`;
 *   5xx            retried once — `network` if it persists (the ledger keeps the status);
 *   timeout/network retried once (unchanged from before the ledger existed). A timed-out
 *                  request may still have been answered and counted on Avalara's side, which
 *                  is why `attempts` travels with the result;
 *   2xx, bad body  never retried — `malformed`. Avalara answered; asking again costs again.
 */
async function avalaraRate(addr: TaxAddress): Promise<AvalaraResult> {
  const qs = new URLSearchParams({
    line1: addr.street || "",
    city: addr.city || "",
    region: stateCode(addr.state),
    postalCode: addr.zip || "",
    country: "US",
  });
  const url = `${creds().base}/api/v2/taxrates/byaddress?${qs}`;
  const headers = requestHeaders();

  let last: AvalaraResult = failed("network", null, 0);
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      last = failed(isTimeout(e) ? "timeout" : "network", null, attempt);
      continue;
    }

    const status = res.status;
    if (res.ok) {
      let body: { totalRate?: unknown; rates?: unknown } | null;
      try {
        body = JSON.parse(await res.text());
      } catch (e) {
        return failed(isTimeout(e) ? "timeout" : "malformed", status, attempt);
      }
      const rate = sane(body?.totalRate);
      if (rate == null) return failed("malformed", status, attempt);
      return { ok: true, rate, jurisdiction: jurisdictionOf(body?.rates, addr), httpStatus: status, attempts: attempt, failure: null };
    }

    if (status === 401 || status === 403) {
      const codes = await errorCodes(res);
      return failed(codes.some((c) => SUBSCRIPTION_CODES.has(c)) ? "subscription" : "credentials_rejected", status, attempt);
    }
    await discard(res);
    if (status === 429) {
      last = failed("rate_limited", status, attempt);
      if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, RATE_LIMIT_PAUSE_MS));
      continue;
    }
    if (status < 500) return failed("bad_address", status, attempt);
    last = failed("network", status, attempt);
  }
  return last;
}

/**
 * The rate for one quote's delivery address.
 *
 * `fallbackRate` is the free default the caller already chose through taxChain.ts — the quote's
 * sales location rate, or client_settings.ss_tax_rate, which portal-settings guarantees is set
 * before a tenant can issue their own paperwork. A caller that cannot supply one has a
 * misconfigured tenant and should refuse the quote rather than ask this function to invent a
 * number — hence the explicit 0 rather than an optional parameter.
 *
 * `allowLookup` DEFAULTS TO FALSE (2026-09-16, the day the real credentials were set). A
 * lookup is a live call Avalara bills per request and there is no sandbox, so the credentials
 * being present must never be what decides whether money is spent. Before this, setting the
 * two secrets silently turned every quote submit and every change order into a billed call,
 * with no button and no consent. Only a deliberate, staff-initiated path may pass true; the
 * automatic paths pass false and get the tenant's own rate, exactly as before the key existed.
 * The early return sits ABOVE isConfigured() so a test with junk credentials in env proves it.
 *
 * `onResult` is called EXACTLY ONCE for every resolveRate that reached the network, after the
 * retries are done, with the full outcome — and never for "not requested", "not configured" or
 * an untaxable address, none of which made a request. So a ledger written from it holds ONE ROW
 * PER resolveRate, and that row's `attempts` records how many HTTP requests the lookup took.
 * It is awaited, so the caller's ledger update lands before the rate is handed back, and a
 * callback that throws is swallowed: a ledger fault must never change the rate on a document.
 */
export async function resolveRate(
  addr: TaxAddress,
  fallbackRate: number,
  opts: { allowLookup?: boolean; onResult?: (result: AvalaraResult) => void | Promise<void> } = {},
): Promise<ResolvedRate> {
  const fallback = sane(fallbackRate) ?? 0;
  const give = (reason: string): ResolvedRate =>
    ({ rate: fallback, jurisdiction: null, source: "fallback", reason });

  if (opts.allowLookup !== true) return give("not requested");
  if (!isConfigured()) return give("avalara not configured");
  if (!taxable(addr)) return give("no state/postcode on the delivery address");

  const hit = await avalaraRate(addr);
  if (opts.onResult) {
    try {
      await opts.onResult(hit);
    } catch {
      // The caller's ledger is the caller's problem to report; the rate stands either way.
    }
  }
  if (!hit.ok) return { ...give("avalara lookup failed"), failure: hit.failure };
  return { rate: hit.rate, jurisdiction: hit.jurisdiction, source: "avalara", reason: null };
}

/**
 * Are the credentials accepted? `GET /api/v2/utilities/ping` — an operator's deliberate check.
 *
 * Avalara documents ping as never erroring: wrong credentials come back 200 with
 * `authenticated: false`. Whether a ping is metered is not documented, so treat it as a counted
 * call and let the caller write it to the ledger like any other.
 *
 * The response body names the account id and user behind the key. NONE of that leaves this
 * function: the return value is a whitelist of four fields, and `authenticationType` must look
 * like a single word or it is dropped. NEVER THROWS, and makes no request when unconfigured.
 */
export async function pingAvalara(): Promise<AvalaraPing> {
  if (!isConfigured()) return { configured: false, authenticated: false, authenticationType: null, httpStatus: null };
  try {
    const res = await fetch(`${creds().base}/api/v2/utilities/ping`, {
      headers: requestHeaders(),
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    let body: { authenticated?: unknown; authenticationType?: unknown } | null = null;
    try {
      body = JSON.parse(await res.text());
    } catch {
      body = null;
    }
    const type = body?.authenticationType;
    return {
      configured: true,
      authenticated: res.ok && body?.authenticated === true,
      authenticationType: typeof type === "string" && /^[A-Za-z]{1,40}$/.test(type) ? type : null,
      httpStatus: res.status,
    };
  } catch {
    return { configured: true, authenticated: false, authenticationType: null, httpStatus: null };
  }
}

/**
 * The tax on a taxable base, at a rate. Rounded to cents ONCE, here, so the figure stamped
 * into the snapshot is the figure on the PDF, on the customer's screen and in the books —
 * every one of which reads the stored amount rather than recomputing it (see
 * _shared/estimateLines.ts::taxFromSnapshot).
 */
export function taxOn(taxableBase: number, rate: number): number {
  const b = Number(taxableBase) || 0;
  const r = sane(rate) ?? 0;
  if (b <= 0 || r <= 0) return 0;
  // The base is scaled to integer CENTS before the rate is applied, rather than rounding
  // dollars*rate*100 at the end. That is not a style preference — it is a real half-cent bug:
  // 12450 * 0.0725 = 902.625, but (902.625 * 100) evaluates to 90262.49999999999 in binary
  // floating point, so Math.round takes it DOWN and the customer is billed 902.62 while every
  // hand-check of the document says 902.63. Multiplying the exact integer 1245000 by the rate
  // lands on 90262.5, which rounds half-up the way a tax figure is expected to.
  return Math.round(Math.round(b * 100) * r) / 100;
}
