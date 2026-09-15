/**
 * Delivery-fee rules: the PURE half of distance-priced delivery (Carolyn, 2026-09-14).
 *
 * No I/O in this file. It takes a rule card and a whole number of miles and answers with a
 * dollar figure, or with a NAMED reason it could not — so the money logic can be tested to
 * the cent without a database or a Google key, and so both callers (the quote endpoint and
 * the estimate submit) price the same miles the same way. The external call lives in
 * _shared/deliveryDistance.ts; the orchestration in _shared/deliveryQuote.ts.
 *
 * ── THE FOUR RULE SHAPES ─────────────────────────────────────────────────────────────
 * Carolyn's builders price delivery four different ways and every one of them is real:
 *   flat         — one price, distance ignored ("$150 delivery, anywhere we go").
 *   base_plus    — a base fee plus so much per mile, from mile one.
 *   free_radius  — free inside N miles; past that, per mile. `perMileCounts` says whether
 *                  the per-mile part counts only the miles BEYOND the radius or ALL of them
 *                  (both exist: "free within 30, then $3/mi after that" versus "free within
 *                  30, otherwise $3/mi for the whole trip").
 *   bands        — a table: 0–25 miles $100, 26–50 $175, … A destination past the last band
 *                  is NOT priced (reason "beyond_last_band"); the builder quotes it by hand.
 *
 * ── WHY MILES ARE WHOLE AND ROUNDED UP ────────────────────────────────────────────────
 * Bands are written by people as "0–25, 26–50". With integer miles those are unambiguous;
 * with fractional miles a 25.4-mile trip belongs to neither band. Rounding UP from meters
 * (never to nearest) means the customer is never charged for fewer miles than the truck
 * drives, which is the direction a builder will accept and the one nobody has to explain.
 *
 * ── WHY normalizeRules DOES NOT CHECK COMPLETENESS ────────────────────────────────────
 * A builder may save a half-filled card with automation switched off ("I'll finish the
 * bands tomorrow"). Refusing the save would lose their work. So normalizeRules refuses only
 * what is WRONG (negative money, a band table with a hole in it) and feeFor reports
 * "rule_incomplete" at quote time for what is merely MISSING. Wrong is never saveable;
 * missing is saveable but never priced.
 */

export type PerMileCounts = "beyond" | "all";
export type RuleType = "flat" | "base_plus" | "free_radius" | "bands";

export interface Band {
  /** Inclusive, whole miles. */
  minMiles: number;
  /** Inclusive, whole miles. */
  maxMiles: number;
  fee: number;
}

export interface DeliveryRules {
  ruleType: RuleType;
  flatFee: number | null;
  baseFee: number | null;
  perMile: number | null;
  freeMiles: number | null;
  perMileCounts: PerMileCounts;
  /** Sorted by minMiles, first min 0, contiguous. Empty unless ruleType is "bands". */
  bands: Band[];
}

export type FeeReason = "beyond_last_band" | "no_distance" | "rule_incomplete" | null;

export interface FeeResult {
  /** Dollars, rounded to cents. Null when the rule could not price this trip. */
  amount: number | null;
  /** True exactly when `amount` is a number — the line was priced by the rule, not by hand. */
  autoPriced: boolean;
  reason: FeeReason;
  /** The line-item description the customer sees, e.g. "Delivery — 62 miles from Springfield lot". */
  desc: string;
}

const RULE_TYPES: readonly RuleType[] = ["flat", "base_plus", "free_radius", "bands"];
const METERS_PER_MILE = 1609.344;

/** Cents, rounded once. Every figure that leaves this module goes through here. */
const cents = (x: number): number => Math.round(x * 100) / 100;

/**
 * A dollar amount from whatever the row or the portal sent. Numeric STRINGS are coerced
 * because the portal's inputs are text fields and a `numeric` column comes back from
 * PostgREST as a string. null/undefined/"" mean "not filled in" and stay null — they are
 * not zero, and a free delivery is an explicit 0.
 */
function money(v: unknown, field: string): { n: number | null } | { error: string } {
  if (v == null || v === "") return { n: null };
  const n = typeof v === "number" ? v : Number(String(v).trim());
  if (!Number.isFinite(n)) return { error: `${field} must be a number` };
  if (n < 0) return { error: `${field} cannot be negative` };
  return { n };
}

/** A whole, non-negative mile count. Same coercion rules as money(). */
function wholeMiles(v: unknown, field: string): { n: number | null } | { error: string } {
  if (v == null || v === "") return { n: null };
  const n = typeof v === "number" ? v : Number(String(v).trim());
  if (!Number.isFinite(n)) return { error: `${field} must be a number` };
  if (n < 0) return { error: `${field} cannot be negative` };
  if (!Number.isInteger(n)) return { error: `${field} must be a whole number of miles` };
  return { n };
}

// deno-lint-ignore no-explicit-any
const pick = (o: any, camel: string, snake: string): unknown =>
  o?.[camel] !== undefined ? o[camel] : o?.[snake];

/**
 * Validate and canonicalise a rule card. Accepts BOTH the database row (snake_case:
 * rule_type / flat_fee / base_fee / per_mile / free_miles / per_mile_counts / bands) and the
 * portal's camelCase payload, so portal-settings can validate what it is about to save with
 * the same function the quote path uses to read it back — one validator, no drift.
 *
 * Returns the first problem as a sentence naming the field; the portal shows it verbatim.
 */
export function normalizeRules(raw: unknown): { rules: DeliveryRules; error: null } | { rules: null; error: string } {
  const fail = (error: string) => ({ rules: null, error }) as const;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("delivery rules are missing");
  // deno-lint-ignore no-explicit-any
  const r = raw as any;

  const ruleType = String(pick(r, "ruleType", "rule_type") ?? "").trim() as RuleType;
  if (!RULE_TYPES.includes(ruleType)) {
    return fail(`rule type must be one of ${RULE_TYPES.join(", ")}`);
  }

  const flat = money(pick(r, "flatFee", "flat_fee"), "flat fee");
  if ("error" in flat) return fail(flat.error);
  const base = money(pick(r, "baseFee", "base_fee"), "base fee");
  if ("error" in base) return fail(base.error);
  const perMile = money(pick(r, "perMile", "per_mile"), "per-mile rate");
  if ("error" in perMile) return fail(perMile.error);
  const free = wholeMiles(pick(r, "freeMiles", "free_miles"), "free miles");
  if ("error" in free) return fail(free.error);

  const countsRaw = pick(r, "perMileCounts", "per_mile_counts");
  const perMileCounts: PerMileCounts = countsRaw == null || countsRaw === "" ? "beyond" : (String(countsRaw) as PerMileCounts);
  if (perMileCounts !== "beyond" && perMileCounts !== "all") {
    return fail('per-mile counting must be "beyond" or "all"');
  }

  // Bands are validated whenever any are present, whatever the rule type. A malformed band
  // is malformed in every mode, and the portal keeps its band editor's state consistent
  // with what it sends; only the EMPTY case is mode-dependent.
  const bandsRaw = pick(r, "bands", "bands");
  if (bandsRaw != null && !Array.isArray(bandsRaw)) return fail("bands must be a list");
  const list: unknown[] = Array.isArray(bandsRaw) ? bandsRaw : [];
  const bands: Band[] = [];
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    const label = `band ${i + 1}`;
    if (!b || typeof b !== "object") return fail(`${label} is not a band`);
    const min = wholeMiles(pick(b, "minMiles", "min_miles"), `${label} minimum`);
    if ("error" in min) return fail(min.error);
    const max = wholeMiles(pick(b, "maxMiles", "max_miles"), `${label} maximum`);
    if ("error" in max) return fail(max.error);
    const fee = money(pick(b, "fee", "fee"), `${label} fee`);
    if ("error" in fee) return fail(fee.error);
    if (min.n == null || max.n == null) return fail(`${label} needs a minimum and a maximum`);
    if (fee.n == null) return fail(`${label} needs a fee`);
    if (min.n > max.n) return fail(`${label}: minimum is above its maximum`);
    bands.push({ minMiles: min.n, maxMiles: max.n, fee: fee.n });
  }
  bands.sort((a, b) => a.minMiles - b.minMiles);

  if (ruleType === "bands" && bands.length === 0) return fail("add at least one mileage band");
  if (bands.length) {
    // The table must start at zero and have no holes and no overlaps, or some trips fall
    // between bands and get priced by whichever band happened to be checked first. With
    // whole miles, contiguity is exactly "the next band starts one mile after this one ends".
    if (bands[0].minMiles !== 0) return fail("the first band must start at 0 miles");
    for (let i = 1; i < bands.length; i++) {
      const prev = bands[i - 1], next = bands[i];
      if (next.minMiles !== prev.maxMiles + 1) {
        return fail(`bands must be contiguous: ${prev.minMiles}–${prev.maxMiles} is followed by ${next.minMiles}–${next.maxMiles}`);
      }
    }
  }

  return {
    rules: {
      ruleType,
      flatFee: flat.n,
      baseFee: base.n,
      perMile: perMile.n,
      freeMiles: free.n,
      perMileCounts,
      bands,
    },
    error: null,
  };
}

/** Whole miles, rounded UP. Nothing (0, negative, NaN, undefined) is 0 miles. */
export function milesFromMeters(m: number): number {
  if (!Number.isFinite(m) || m <= 0) return 0;
  return Math.ceil(m / METERS_PER_MILE);
}

/**
 * The description on the delivery line. `note` (e.g. "free within 30 miles") is appended in
 * parentheses so the customer can see WHY the number is what it is.
 */
export function deliveryDesc(miles: number | null, originName: string | null, note?: string): string {
  let base = "Delivery";
  if (miles != null) {
    // "1 mile", not "1 miles" — this line is printed on the customer's quote.
    const unit = miles === 1 ? "mile" : "miles";
    base = originName ? `Delivery — ${miles} ${unit} from ${originName}` : `Delivery — ${miles} ${unit}`;
  }
  return note ? `${base} (${note})` : base;
}

/**
 * Price one trip. `miles` may be null when distance was not resolved (or, for a flat rule,
 * never asked for); `originName` is only used for the description.
 *
 * Reason precedence: a rule with a hole in it ("rule_incomplete") is reported BEFORE a
 * missing distance ("no_distance"), because the rule is the thing the builder can fix from
 * their settings screen, and it is broken regardless of what Google says.
 */
export function feeFor(rules: DeliveryRules, miles: number | null, originName: string | null): FeeResult {
  const incomplete = (): FeeResult =>
    ({ amount: null, autoPriced: false, reason: "rule_incomplete", desc: deliveryDesc(miles, originName) });
  const noDistance = (): FeeResult =>
    ({ amount: null, autoPriced: false, reason: "no_distance", desc: deliveryDesc(null, null) });
  const priced = (amount: number, note?: string): FeeResult =>
    ({ amount: cents(amount), autoPriced: true, reason: null, desc: deliveryDesc(miles, originName, note) });

  switch (rules.ruleType) {
    case "flat": {
      if (rules.flatFee == null) return incomplete();
      return priced(rules.flatFee);
    }
    case "base_plus": {
      if (rules.baseFee == null || rules.perMile == null) return incomplete();
      if (miles == null) return noDistance();
      return priced(rules.baseFee + rules.perMile * miles);
    }
    case "free_radius": {
      if (rules.freeMiles == null || rules.perMile == null) return incomplete();
      if (miles == null) return noDistance();
      if (miles <= rules.freeMiles) return priced(0, `free within ${rules.freeMiles} miles`);
      const billable = rules.perMileCounts === "beyond" ? miles - rules.freeMiles : miles;
      return priced(rules.perMile * billable);
    }
    case "bands": {
      if (rules.bands.length === 0) return incomplete();
      if (miles == null) return noDistance();
      const band = rules.bands.find((b) => miles >= b.minMiles && miles <= b.maxMiles);
      if (!band) {
        // Past the last band is not an error and not free: the builder prices it by hand.
        return { amount: null, autoPriced: false, reason: "beyond_last_band", desc: deliveryDesc(miles, originName) };
      }
      return priced(band.fee);
    }
  }
}

/**
 * The closest of several origins by resolved miles. Nulls (unresolved) never win; on a tie
 * the FIRST wins, which is why callers list the business address first — it is the
 * builder's default shop when two lots are equally far.
 */
export function nearestOrigin<T extends { miles: number | null }>(list: T[]): T | null {
  let best: T | null = null;
  for (const o of list) {
    if (o.miles == null) continue;
    if (best == null || o.miles < (best.miles as number)) best = o;
  }
  return best;
}

interface KeyableAddress {
  street?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}

const norm = (v: unknown): string => String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * The cache key for an address: lowercase, trimmed, whitespace collapsed, field-separated.
 * Two spellings that differ only in case or spacing are the same trip and must share one
 * cached distance — that is the whole point of the cache, since each miss is a paid call.
 */
export function addressKey(a: KeyableAddress): string {
  return [norm(a?.street), norm(a?.city), norm(a?.state), norm(a?.zip)].join("|");
}

/**
 * The single line sent to Google: "street, city, state zip, USA". Blank parts are skipped
 * rather than left as empty commas, and the country is pinned because every tenant is a US
 * builder and a bare "Springfield" resolves to a dozen places without it.
 */
export function addressLine(a: KeyableAddress): string {
  const clean = (v: unknown) => String(v ?? "").trim().replace(/\s+/g, " ");
  const stateZip = [clean(a?.state), clean(a?.zip)].filter(Boolean).join(" ");
  return [clean(a?.street), clean(a?.city), stateZip, "USA"].filter(Boolean).join(", ");
}
