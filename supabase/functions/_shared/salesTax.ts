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
 * WHY A RATE LOOKUP AND NOT A TRANSACTION (Carolyn 2026-08-27): we ask Avalara what the rate
 * is; the builder files their own returns. Nothing is recorded on Avalara's side, so there is
 * no filing obligation riding on a dropped call, and no per-transaction cost. That is why this
 * uses /taxrates/byaddress rather than an uncommitted SalesOrder CreateTransaction — byaddress
 * needs no company profile or nexus configured per tenant, which keeps tenant onboarding at
 * zero. Its limitation is the trade: it returns the jurisdiction's general rate and applies no
 * product-taxability rules. We supply those ourselves from the per-item `taxable` flags the
 * builder sets on their own catalog, which is the more defensible place for them anyway.
 * Swapping to SalesOrder later is confined to avalaraRate() below.
 */

const API_BASE = (Deno.env.get("AVALARA_API_BASE") || "https://rest.avatax.com").replace(/\/+$/, "");
const ACCOUNT_ID = Deno.env.get("AVALARA_ACCOUNT_ID") || "";
const LICENSE_KEY = Deno.env.get("AVALARA_LICENSE_KEY") || "";

/** Matches _shared/contactAddress.ts' StopAddress — the delivery address off designs.contact. */
export interface TaxAddress {
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

export interface ResolvedRate {
  /** Combined rate as a FRACTION (0.0725 = 7.25%). */
  rate: number;
  /** "Bibb County, GA" — for the tax row on the document. Null when unknown. */
  jurisdiction: string | null;
  source: "avalara" | "fallback";
  /** Why the fallback was used. Telemetry and support only — never shown to a customer. */
  reason: string | null;
}

/** One retry, because a single dropped connection should not tax a whole sale at the fallback;
 *  more than one would put a customer in front of a spinner while a quote is being issued. */
const TIMEOUT_MS = 6_000;
const ATTEMPTS = 2;

/** A rate must be a real fraction. Avalara returns 0.0725; a percent-shaped 7.25 slipping
 *  through would multiply a bill by eight. Bounded to the same 25% ceiling migration 127 puts
 *  on the stored fallback, so a nonsense value is refused rather than charged.
 *
 *  null/undefined/"" are rejected BEFORE Number(), which turns all three into 0 — and a
 *  missing rate is not a 0% rate. A genuine numeric 0 is still accepted: Oregon and Delaware
 *  are real answers, and the whole point of the mandatory setting is that 0 be sayable. */
function sane(rate: unknown): number | null {
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
  return !!(ACCOUNT_ID && LICENSE_KEY);
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

/**
 * The Avalara call. Returns null on ANY failure — not configured, timeout, non-2xx, malformed
 * body, insane rate — so the single caller below has one fallback path rather than a ladder.
 * Errors are swallowed here and reported through ResolvedRate.reason; nothing about tax should
 * be able to throw out of a quote submission.
 */
async function avalaraRate(addr: TaxAddress): Promise<{ rate: number; jurisdiction: string | null } | null> {
  const qs = new URLSearchParams({
    line1: addr.street || "",
    city: addr.city || "",
    region: stateCode(addr.state),
    postalCode: addr.zip || "",
    country: "US",
  });
  const auth = btoa(`${ACCOUNT_ID}:${LICENSE_KEY}`);

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${API_BASE}/api/v2/taxrates/byaddress?${qs}`, {
        headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      // 4xx is a bad address or bad credentials — retrying changes neither, so stop.
      if (!res.ok) {
        if (res.status < 500) return null;
        continue;
      }
      const body = await res.json();
      const rate = sane(body?.totalRate);
      if (rate == null) return null;
      return { rate, jurisdiction: jurisdictionOf(body?.rates, addr) };
    } catch {
      // Timeout or network. Fall through to the next attempt; the last one gives up.
    }
  }
  return null;
}

/**
 * The rate for one quote's delivery address.
 *
 * `fallbackRate` is client_settings.ss_tax_rate, which portal-settings guarantees is set
 * before a tenant can issue their own paperwork. A caller that cannot supply one has a
 * misconfigured tenant and should refuse the quote rather than ask this function to invent a
 * number — hence the explicit 0 rather than an optional parameter.
 */
export async function resolveRate(addr: TaxAddress, fallbackRate: number): Promise<ResolvedRate> {
  const fallback = sane(fallbackRate) ?? 0;
  const give = (reason: string): ResolvedRate =>
    ({ rate: fallback, jurisdiction: null, source: "fallback", reason });

  if (!isConfigured()) return give("avalara not configured");
  if (!taxable(addr)) return give("no state/postcode on the delivery address");

  const hit = await avalaraRate(addr);
  if (!hit) return give("avalara lookup failed");
  return { rate: hit.rate, jurisdiction: hit.jurisdiction, source: "avalara", reason: null };
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
