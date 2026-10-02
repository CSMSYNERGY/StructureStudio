// Operator side of phone & text usage billing — the pure half of admin-catalog's
// phone_billing_get / phone_billing_set / phone_billing_arm / phone_usage_report (usage billing
// Part 1 step 6, 2026-10-02). The portal card that drives them is AdmPhoneBilling in
// portal/07-admin.jsx.
//
// WHY A MODULE OF ITS OWN. Everything here decides money without touching a database: which
// settings an operator may write and in what range, what "charging is on" means for a given
// row of settings, what a call WOULD have cost a builder at today's markup, and how a month of
// usage_charges rows adds up against Twilio's own bill. Pure functions, so
// _shared/phoneBillingAdmin.test.ts pins them with no database and no registry imports.
// admin-catalog does the reads and writes and calls in here for every decision.
//
// ── THE UNITS ────────────────────────────────────────────────────────────────────────────
// micros = millionths of a dollar (1 cent = 10,000 micros). A call minute at 2× is about
// 28,000 micros and a text segment about 24,000, which is why none of this is in cents.
// floor_cents is the one cents field: it is compared with the wallet's balance_cents.
//
// ── WHAT "CHARGING IS ON" MEANS ─────────────────────────────────────────────────────────
// Mirrors wallet_usage_gate / phone_usage_armed in migration 259 — change them together.
// A tenant's meter is armed when the markup is set AND armed_at is set AND (the meter's
// usage_prices row is active OR the tenant is in pilot_client_ids). The env rail
// PHONE_USAGE_METERS=on sits on top of that and is checked by the callers (the phone-api
// worker and _shared/usageGate.ts), not by the database.
//
// ⚠️ armed_at is KEPT on disarm (the contract keeps it as the record of when charging last
// started). So "off" is expressed by the four meters being inactive AND the pilot list being
// EMPTY. A disarm that left the pilot list in place would keep charging every pilot tenant,
// because pilot membership alone satisfies the OR above. phone_billing_arm clears the list on
// every disarm for exactly that reason; chargingMode() below reads any leftover as "partial".

/** The four usage_prices rows phone usage is charged under (migration 259). Outbound keeps the
 *  pre-existing voice_minute / sms_segment kinds; inbound got its own two. */
export const PHONE_METERS = ["voice_minute", "voice_minute_in", "sms_segment", "sms_in"] as const;
export type PhoneMeter = typeof PHONE_METERS[number];

/** Plain names for the four meters, for the card and for audit notes. */
export const PHONE_METER_LABELS: Record<PhoneMeter, string> = {
  voice_minute: "Outgoing call minutes",
  voice_minute_in: "Incoming call minutes",
  sms_segment: "Texts sent",
  sms_in: "Texts received",
};

/** The phone_billing_settings columns every action reads. An explicit list rather than `*`, so
 *  a column added to the table later is not served to the console by accident. */
export const PHONE_SETTINGS_COLUMNS = [
  "markup", "floor_cents", "carrier_fee_out_micros", "carrier_fee_in_micros",
  "fallback_out_min_micros", "fallback_in_min_micros", "fallback_client_min_micros",
  "fallback_sms_seg_micros", "fallback_after_hours", "ceiling_min_micros", "ceiling_seg_micros",
  "bill_unanswered_calls", "pilot_client_ids", "armed_at", "updated_at", "updated_by",
].join(", ");

export interface PhoneBillingSettings {
  markup: number | null;
  floor_cents: number;
  carrier_fee_out_micros: number;
  carrier_fee_in_micros: number;
  fallback_out_min_micros: number;
  fallback_in_min_micros: number;
  fallback_client_min_micros: number;
  fallback_sms_seg_micros: number;
  fallback_after_hours: number;
  ceiling_min_micros: number | null;
  ceiling_seg_micros: number | null;
  bill_unanswered_calls: boolean;
  pilot_client_ids: string[];
  armed_at: string | null;
  updated_at: string | null;
  updated_by: string | null;
}

/** null/""/garbage → null, anything numeric (PostgREST serves numeric and bigint as JSON
 *  numbers, but a string "2.000" must not read as NaN) → a number. */
export function numOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** A settings row as the console and the arithmetic below expect it. Defaults are 259's column
 *  defaults, used only if a column comes back null where the table says it cannot. */
export function normalizeSettings(row: Record<string, unknown>): PhoneBillingSettings {
  const int = (k: string, dflt: number) => {
    const n = numOrNull(row[k]);
    return n == null ? dflt : Math.round(n);
  };
  const intOrNull = (k: string) => {
    const n = numOrNull(row[k]);
    return n == null ? null : Math.round(n);
  };
  return {
    markup: numOrNull(row.markup),
    floor_cents: int("floor_cents", 500),
    carrier_fee_out_micros: int("carrier_fee_out_micros", 4500),
    carrier_fee_in_micros: int("carrier_fee_in_micros", 3500),
    fallback_out_min_micros: int("fallback_out_min_micros", 14000),
    fallback_in_min_micros: int("fallback_in_min_micros", 8500),
    fallback_client_min_micros: int("fallback_client_min_micros", 4000),
    fallback_sms_seg_micros: int("fallback_sms_seg_micros", 8300),
    fallback_after_hours: int("fallback_after_hours", 6),
    ceiling_min_micros: intOrNull("ceiling_min_micros"),
    ceiling_seg_micros: intOrNull("ceiling_seg_micros"),
    bill_unanswered_calls: row.bill_unanswered_calls === true,
    pilot_client_ids: Array.isArray(row.pilot_client_ids) ? row.pilot_client_ids.map((x) => String(x)) : [],
    armed_at: typeof row.armed_at === "string" && row.armed_at ? row.armed_at : null,
    updated_at: typeof row.updated_at === "string" ? row.updated_at : null,
    updated_by: typeof row.updated_by === "string" ? row.updated_by : null,
  };
}

// ── phone_billing_set: what may be written, and in what range ───────────────────────────
// STRICT ON PURPOSE. These numbers price every call and text on the platform, and the
// failure mode of a lenient parser is silent: "2,5" coerced to NaN and stored as null, a
// ceiling typed in cents landing as micros (a 100× cheaper cap), a misspelt key that saves
// nothing while the console says "Saved". So: numbers must arrive as JSON numbers, integers
// must be integers, every value has a range, and an unknown key refuses the whole request.
//
// The caps are sanity rails, not prices. Today's real rates for scale: a US call minute is
// about 14,000 micros outbound and 8,500 inbound, a text segment about 8,300, and the carrier
// fee about 3,000–5,000 per segment.
type IntRule = { kind: "int"; min: number; max: number; nullable: boolean; what: string; unit: "micros" | "cents" | "hours" };
type Rule = { kind: "markup" } | { kind: "bool"; what: string } | IntRule;

export const PHONE_SETTING_RULES: Record<string, Rule> = {
  markup: { kind: "markup" },
  floor_cents: { kind: "int", min: 0, max: 50_000, nullable: false, unit: "cents", what: "The minimum balance" },
  carrier_fee_out_micros: { kind: "int", min: 0, max: 50_000, nullable: false, unit: "micros", what: "The carrier fee on a text sent" },
  carrier_fee_in_micros: { kind: "int", min: 0, max: 50_000, nullable: false, unit: "micros", what: "The carrier fee on a text received" },
  // A ceiling of 0 would make every call free, which nobody means by "a cap" — blank is how
  // you say "no cap", so the floor of the range is 1 micro.
  ceiling_min_micros: { kind: "int", min: 1, max: 1_000_000, nullable: true, unit: "micros", what: "The most per call minute" },
  ceiling_seg_micros: { kind: "int", min: 1, max: 1_000_000, nullable: true, unit: "micros", what: "The most per text segment" },
  bill_unanswered_calls: { kind: "bool", what: "Charge for missed calls" },
  fallback_out_min_micros: { kind: "int", min: 0, max: 500_000, nullable: false, unit: "micros", what: "The fallback rate for an outgoing call minute" },
  fallback_in_min_micros: { kind: "int", min: 0, max: 500_000, nullable: false, unit: "micros", what: "The fallback rate for an incoming call minute" },
  fallback_client_min_micros: { kind: "int", min: 0, max: 500_000, nullable: false, unit: "micros", what: "The fallback rate for an app call minute" },
  fallback_sms_seg_micros: { kind: "int", min: 0, max: 500_000, nullable: false, unit: "micros", what: "The fallback rate for a text segment" },
  fallback_after_hours: { kind: "int", min: 1, max: 72, nullable: false, unit: "hours", what: "The wait before using fallback rates" },
};

/** micros → "$0.05", "$0.0045", "$0.000001": as many decimals as the number needs, never fewer than 2. */
export function microsToDollars(micros: number): string {
  const [i, f = ""] = (micros / 1_000_000).toFixed(6).split(".");
  const frac = f.replace(/0+$/, "");
  return "$" + i + "." + (frac.length < 2 ? frac.padEnd(2, "0") : frac);
}
const dollars = microsToDollars;
function rangeWords(r: IntRule): string {
  if (r.unit === "micros") return `between ${dollars(r.min)} and ${dollars(r.max)}`;
  if (r.unit === "cents") return `between $${(r.min / 100).toFixed(2)} and $${(r.max / 100).toFixed(2)}`;
  return `a whole number of hours from ${r.min} to ${r.max}`;
}

/**
 * Validate a phone_billing_set body into a column patch. Throws an Error whose message is
 * the operator's sentence (admin-catalog turns a throw into a 400 with that message).
 * `passthrough` names the envelope keys the console always sends (action, adminPassword) —
 * every OTHER key must be a known setting.
 */
export function parseSettingsPatch(
  body: Record<string, unknown>,
  passthrough: ReadonlySet<string>,
): Partial<PhoneBillingSettings> {
  const patch: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(body ?? {})) {
    if (passthrough.has(key) || v === undefined) continue;
    if (key === "pilot_client_ids" || key === "armed_at") {
      // Who is charged, and from when, is an ARMING decision with its own confirm and its own
      // audit row. Letting it ride along on a price save would turn charging on for a builder
      // through the Save prices button.
      throw new Error("Who is charged is changed with Start charging / Stop charging, not with the prices.");
    }
    const rule = PHONE_SETTING_RULES[key];
    if (!rule) throw new Error(`Unknown setting "${key.slice(0, 60)}". Nothing was saved.`);
    if (rule.kind === "markup") {
      if (v === null) { patch.markup = null; continue; }
      if (typeof v !== "number" || !Number.isFinite(v) || v < 1 || v > 10) {
        throw new Error("The markup must be a number from 1 to 10 (for example 2 or 2.5), or blank.");
      }
      // numeric(6,3): a fourth decimal would be rounded away by the column, so the number on
      // screen and the number charged would differ. Refuse rather than round silently.
      const r = Math.round(v * 1000) / 1000;
      if (Math.abs(r - v) > 1e-9) throw new Error("The markup can have at most three decimal places.");
      patch.markup = r;
      continue;
    }
    if (rule.kind === "bool") {
      if (typeof v !== "boolean") throw new Error(`${rule.what} must be on or off.`);
      patch[key] = v;
      continue;
    }
    if (v === null) {
      if (!rule.nullable) throw new Error(`${rule.what} can't be blank.`);
      patch[key] = null;
      continue;
    }
    if (typeof v !== "number" || !Number.isInteger(v) || v < rule.min || v > rule.max) {
      throw new Error(`${rule.what} must be ${rangeWords(rule)}.`);
    }
    patch[key] = v;
  }
  if (Object.keys(patch).length === 0) throw new Error("Nothing to save.");
  return patch as Partial<PhoneBillingSettings>;
}

/** "markup 2 -> 2.5; floor_cents 500 -> 600" for the audit row. Only keys that changed. */
export function describeSettingsChange(before: PhoneBillingSettings, after: PhoneBillingSettings): string[] {
  const out: string[] = [];
  for (const key of Object.keys(PHONE_SETTING_RULES)) {
    const a = (before as unknown as Record<string, unknown>)[key];
    const b = (after as unknown as Record<string, unknown>)[key];
    if (a !== b) out.push(`${key} ${a ?? "(none)"} -> ${b ?? "(none)"}`);
  }
  return out;
}

// ── phone_billing_arm: the pilot list ───────────────────────────────────────────────────
export const MAX_PILOT_CLIENTS = 50;

/** Trim, dedupe and shape-check a pilot list. Existence is checked by the caller (it needs the
 *  database); this refuses anything that could not be a client id at all. */
export function normalizePilotIds(v: unknown): string[] {
  if (!Array.isArray(v)) throw new Error("pilot_client_ids must be a list of builder ids.");
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string") throw new Error("pilot_client_ids must be a list of builder ids.");
    const id = x.trim().toLowerCase();
    if (!id) continue;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || id.length > 80) throw new Error(`"${id.slice(0, 80)}" isn't a builder id.`);
    if (!out.includes(id)) out.push(id);
  }
  if (out.length > MAX_PILOT_CLIENTS) throw new Error(`A pilot can have at most ${MAX_PILOT_CLIENTS} builders. Charge every builder instead.`);
  return out;
}

// ── What is switched on right now ───────────────────────────────────────────────────────
export type ChargingMode = "off" | "pilot" | "all" | "partial";
export interface MeterRow { kind: string; active?: boolean | null }
export interface ChargingView {
  mode: ChargingMode;
  activeMeters: string[];
  pilotIds: string[];
  armedAt: string | null;
  /** Why the mode is "partial", in a sentence the console shows as-is. */
  problem: string | null;
}

/**
 * The console's reading of the arming state. "partial" is anything our own two buttons cannot
 * produce — some meters active but not all, or meters/pilots switched on with no markup or no
 * armed_at — which means a hand edit in the database. It is shown as a warning, and Stop
 * charging (which writes every piece back to off) is always offered to clear it.
 */
export function chargingMode(s: PhoneBillingSettings, meters: MeterRow[]): ChargingView {
  const activeMeters = PHONE_METERS.filter((k) => meters.some((m) => m.kind === k && m.active === true));
  const pilotIds = s.pilot_client_ids;
  const base = { activeMeters: [...activeMeters], pilotIds, armedAt: s.armed_at };
  const anythingOn = activeMeters.length > 0 || pilotIds.length > 0;
  if (s.markup == null || !s.armed_at) {
    return anythingOn
      ? { ...base, mode: "partial", problem: s.markup == null
        ? "Meters or pilot builders are switched on in the database, but there's no markup, so nothing is charged. Press Stop charging to reset, then start again."
        : "Meters or pilot builders are switched on in the database without a start time, so nothing is charged. Press Stop charging to reset, then start again." }
      : { ...base, mode: "off", problem: null };
  }
  if (activeMeters.length === PHONE_METERS.length) return { ...base, mode: "all", problem: null };
  if (activeMeters.length > 0) {
    const on = activeMeters.map((k) => PHONE_METER_LABELS[k]).join(", ");
    return { ...base, mode: "partial", problem: `Only some kinds of usage are switched on for everyone (${on}). Press Stop charging to reset, then start again.` };
  }
  if (pilotIds.length > 0) return { ...base, mode: "pilot", problem: null };
  return { ...base, mode: "off", problem: null };
}

// ── What a call or text would have charged ──────────────────────────────────────────────
/**
 * The worker's charge rule (contract: charge = round(cost × markup), capped at ceiling × units
 * when a ceiling is set), recomputed at TODAY'S settings for the report's "would have charged"
 * column. Integer arithmetic on the markup's thousandths so 0.1 + 0.2 never reaches a price.
 * Returns null when no markup is set (nothing can be priced).
 */
export function previewChargeMicros(
  costMicros: number | null,
  units: number | null,
  unit: string | null,
  s: Pick<PhoneBillingSettings, "markup" | "ceiling_min_micros" | "ceiling_seg_micros">,
): number | null {
  if (s.markup == null || costMicros == null) return null;
  const milli = Math.round(s.markup * 1000);
  let charge = Math.floor((Math.max(0, costMicros) * milli + 500) / 1000);   // round half up
  const ceiling = unit === "minute" ? s.ceiling_min_micros : unit === "segment" ? s.ceiling_seg_micros : null;
  if (ceiling != null && units != null) charge = Math.min(charge, Math.round(ceiling * units));
  return charge;
}

// ── phone_usage_report ──────────────────────────────────────────────────────────────────
export interface MonthRange { month: string; from: string; to: string; firstDay: string; nextFirstDay: string; days: number; daysExpected: number }

/**
 * 'YYYY-MM' → the UTC month. UTC because Twilio's daily usage records are UTC days and the
 * report sets its total against ours day by day; a local-time month would shift both ends.
 * `daysExpected` is how many of Twilio's daily snapshots can exist yet: the worker fetches
 * YESTERDAY's at 09:00 UTC, so the current month has at most today − 1, and a future month 0.
 */
export function monthRange(month: unknown, now: Date): MonthRange {
  const m = typeof month === "string" ? /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month.trim()) : null;
  if (!m || Number(m[1]) < 2024 || Number(m[1]) > 2100) throw new Error("Pick a month as YYYY-MM.");
  const y = Number(m[1]), mo = Number(m[2]) - 1;
  const from = new Date(Date.UTC(y, mo, 1));
  const to = new Date(Date.UTC(y, mo + 1, 1));
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const daysExpected = Math.max(0, Math.min(days, Math.round((today - from.getTime()) / 86_400_000)));
  const day = (d: Date) => d.toISOString().slice(0, 10);
  return { month: `${m[1]}-${m[2]}`, from: from.toISOString(), to: to.toISOString(), firstDay: day(from), nextFirstDay: day(to), days, daysExpected };
}

export interface UsageChargeRow {
  client_id: string;
  source: string;
  direction?: string | null;
  state: string;
  occurred_at: string;
  cost_micros?: number | string | null;
  cost_source?: string | null;
  units?: number | string | null;
  unit?: string | null;
  charge_micros?: number | string | null;
}
export interface TwilioDailyRow { day: string; category: string; count?: number | string | null; usage?: number | string | null; price_micros?: number | string | null }

export interface TenantUsage {
  clientId: string;
  companyName: string;
  calls: number; callsOut: number; callsIn: number;
  texts: number; textsOut: number; textsIn: number;
  minutes: number; segments: number;
  /** Our cost, all states. Split by where the number came from: Twilio's own price, our
   *  fallback estimate, or a call priced by Twilio with an estimated conference part. */
  costMicros: number; costTwilioMicros: number; costEstimateMicros: number; costMixedMicros: number;
  chargedMicros: number;
  /** Shadow rows (charging off for them) priced at TODAY's markup and caps. null when there are
   *  shadow rows but no markup to price them with. */
  wouldChargeMicros: number | null;
  /** Cost of rows nobody pays for: not billable (missed calls, failed texts) and exempt tenants. */
  absorbedMicros: number;
  /** charged − all our cost. Real money: during the cost-only period it is minus the cost. */
  marginMicros: number;
  /** charged + would-have-charged − all our cost: the margin had charging been on. */
  projectedMarginMicros: number | null;
  counts: { charged: number; shadow: number; exempt: number; notBillable: number; pending: number; failed: number };
}

export interface TwilioCategory { category: string; count: number; usage: number; priceMicros: number; inTotal: boolean; days: number }

export interface PhoneUsageReport {
  month: string;
  from: string;
  to: string;
  markup: number | null;
  tenants: TenantUsage[];
  totals: TenantUsage;
  account: {
    twilioMicros: number | null;
    categories: TwilioCategory[];
    daysCovered: number;
    daysExpected: number;
    days: number;
    /** Our cost on the days Twilio's totals cover — the like-for-like side of the gap. */
    ourCostCoveredMicros: number;
    /** Twilio's bill − what we matched to a call or text, over the covered days. null with no
     *  Twilio rows for the month. */
    gapMicros: number | null;
  };
  rowCount: number;
  truncated: boolean;
}

/**
 * Twilio's account totals for the month from twilio_usage_daily, WITHOUT double counting.
 * Twilio's usage categories nest: `calls` already includes `calls-inbound`, `calls-outbound`
 * and `calls-client`. The worker may store a parent and its children side by side, so a
 * category counts toward the total only when no OTHER stored category is its parent — a
 * parent being any stored category P where this one starts with "P-". With no parent stored
 * (the contract stores sms-inbound / sms-outbound / sms-messages-carrierfees, not `sms`), the
 * children are the total.
 */
export function twilioAccountTotals(rows: TwilioDailyRow[]): { totalMicros: number | null; categories: TwilioCategory[]; daysCovered: number } {
  const byCat = new Map<string, TwilioCategory & { daySet: Set<string> }>();
  const days = new Set<string>();
  for (const r of rows) {
    const category = String(r.category || "");
    if (!category) continue;
    const day = String(r.day || "").slice(0, 10);
    if (day) days.add(day);
    const c = byCat.get(category) ?? { category, count: 0, usage: 0, priceMicros: 0, inTotal: true, days: 0, daySet: new Set<string>() };
    c.count += numOrNull(r.count) ?? 0;
    c.usage += numOrNull(r.usage) ?? 0;
    c.priceMicros += Math.round(numOrNull(r.price_micros) ?? 0);
    if (day) c.daySet.add(day);
    byCat.set(category, c);
  }
  const names = [...byCat.keys()];
  let total = 0;
  const categories: TwilioCategory[] = [];
  for (const c of [...byCat.values()].sort((a, b) => a.category.localeCompare(b.category))) {
    const inTotal = !names.some((p) => p !== c.category && c.category.startsWith(p + "-"));
    if (inTotal) total += c.priceMicros;
    categories.push({
      category: c.category, count: Math.round(c.count * 100) / 100, usage: Math.round(c.usage * 100) / 100,
      priceMicros: c.priceMicros, inTotal, days: c.daySet.size,
    });
  }
  return { totalMicros: rows.length ? total : null, categories, daysCovered: days.size };
}

function emptyTenant(clientId: string, companyName: string): TenantUsage {
  return {
    clientId, companyName,
    calls: 0, callsOut: 0, callsIn: 0, texts: 0, textsOut: 0, textsIn: 0, minutes: 0, segments: 0,
    costMicros: 0, costTwilioMicros: 0, costEstimateMicros: 0, costMixedMicros: 0,
    chargedMicros: 0, wouldChargeMicros: 0, absorbedMicros: 0, marginMicros: 0, projectedMarginMicros: 0,
    counts: { charged: 0, shadow: 0, exempt: 0, notBillable: 0, pending: 0, failed: 0 },
  };
}

/** One month of usage_charges, per builder and in total, against Twilio's bill. */
export function summarizePhoneUsage(input: {
  range: MonthRange;
  rows: UsageChargeRow[];
  twilio: TwilioDailyRow[];
  settings: Pick<PhoneBillingSettings, "markup" | "ceiling_min_micros" | "ceiling_seg_micros">;
  names: Map<string, string>;
  truncated?: boolean;
}): PhoneUsageReport {
  const { range, rows, twilio, settings, names } = input;
  const byTenant = new Map<string, TenantUsage & { _shadowUnpriced: number }>();
  const tw = twilioAccountTotals(twilio);
  const coveredDays = new Set<string>(twilio.map((r) => String(r.day || "").slice(0, 10)).filter(Boolean));
  let ourCostCovered = 0;

  for (const r of rows) {
    const id = String(r.client_id || "");
    if (!id) continue;
    let t = byTenant.get(id);
    if (!t) { t = { ...emptyTenant(id, names.get(id) ?? id), _shadowUnpriced: 0 }; byTenant.set(id, t); }
    const out = r.direction === "out";
    if (r.source === "call") { t.calls++; if (out) t.callsOut++; else t.callsIn++; }
    else if (r.source === "sms") { t.texts++; if (out) t.textsOut++; else t.textsIn++; }
    const units = numOrNull(r.units);
    if (units != null) {
      if (r.unit === "minute") t.minutes += units;
      else if (r.unit === "segment") t.segments += units;
    }
    const cost = numOrNull(r.cost_micros);
    if (cost != null) {
      t.costMicros += cost;
      if (r.cost_source === "estimate") t.costEstimateMicros += cost;
      else if (r.cost_source === "mixed") t.costMixedMicros += cost;
      else t.costTwilioMicros += cost;
      // occurred_at comes back as an offset timestamp; normalise to the UTC day Twilio uses.
      const t0 = Date.parse(r.occurred_at);
      if (Number.isFinite(t0) && coveredDays.has(new Date(t0).toISOString().slice(0, 10))) ourCostCovered += cost;
    }
    switch (r.state) {
      case "charged":
        t.counts.charged++;
        t.chargedMicros += numOrNull(r.charge_micros) ?? 0;
        break;
      case "shadow": {
        t.counts.shadow++;
        // No markup = nothing can be priced, and the column says so (null) rather than $0.
        // A shadow row with no cost is not something the worker writes; it adds nothing.
        if (settings.markup == null) t._shadowUnpriced++;
        else t.wouldChargeMicros = (t.wouldChargeMicros ?? 0) + (previewChargeMicros(cost, units, r.unit ?? null, settings) ?? 0);
        break;
      }
      case "exempt": t.counts.exempt++; t.absorbedMicros += cost ?? 0; break;
      case "not_billable": t.counts.notBillable++; t.absorbedMicros += cost ?? 0; break;
      case "failed": t.counts.failed++; break;
      default: t.counts.pending++; break;
    }
  }

  const finish = (t: TenantUsage & { _shadowUnpriced?: number }): TenantUsage => {
    const { _shadowUnpriced, ...rest } = t;
    const would = _shadowUnpriced ? null : rest.wouldChargeMicros;
    return {
      ...rest,
      minutes: Math.round(rest.minutes * 100) / 100,
      segments: Math.round(rest.segments * 100) / 100,
      wouldChargeMicros: would,
      marginMicros: rest.chargedMicros - rest.costMicros,
      projectedMarginMicros: would == null ? null : rest.chargedMicros + would - rest.costMicros,
    };
  };
  const tenants = [...byTenant.values()].map(finish).sort((a, b) => b.costMicros - a.costMicros || a.clientId.localeCompare(b.clientId));

  const totals = emptyTenant("", "All builders");
  let anyUnpricedShadow = false;
  for (const t of tenants) {
    for (const k of ["calls", "callsOut", "callsIn", "texts", "textsOut", "textsIn", "minutes", "segments",
      "costMicros", "costTwilioMicros", "costEstimateMicros", "costMixedMicros", "chargedMicros", "absorbedMicros"] as const) {
      totals[k] += t[k];
    }
    if (t.wouldChargeMicros == null) anyUnpricedShadow = true;
    else totals.wouldChargeMicros = (totals.wouldChargeMicros ?? 0) + t.wouldChargeMicros;
    for (const k of Object.keys(totals.counts) as (keyof TenantUsage["counts"])[]) totals.counts[k] += t.counts[k];
  }
  totals.minutes = Math.round(totals.minutes * 100) / 100;
  totals.segments = Math.round(totals.segments * 100) / 100;
  if (anyUnpricedShadow) totals.wouldChargeMicros = null;
  totals.marginMicros = totals.chargedMicros - totals.costMicros;
  totals.projectedMarginMicros = totals.wouldChargeMicros == null ? null : totals.chargedMicros + totals.wouldChargeMicros - totals.costMicros;

  return {
    month: range.month,
    from: range.from,
    to: range.to,
    markup: settings.markup,
    tenants,
    totals,
    account: {
      twilioMicros: tw.totalMicros,
      categories: tw.categories,
      daysCovered: tw.daysCovered,
      daysExpected: range.daysExpected,
      days: range.days,
      ourCostCoveredMicros: ourCostCovered,
      gapMicros: tw.totalMicros == null ? null : tw.totalMicros - ourCostCovered,
    },
    rowCount: rows.length,
    truncated: Boolean(input.truncated),
  };
}

/** A PostgREST/Postgres error from one of 259's objects, as the operator's sentence. Before
 *  migration 259 is applied the tables and the `pricing` column do not exist, and the raw
 *  message ("relation … does not exist") reads like a crash rather than "not set up yet". */
export function phoneBillingDbError(e: { code?: string; message?: string } | null | undefined): Error {
  const code = String(e?.code ?? "");
  if (["42P01", "PGRST205", "42703", "PGRST204", "42883", "PGRST202"].includes(code)) {
    return new Error("Phone billing isn't set up in the database yet (migration 259 hasn't been applied).");
  }
  return new Error(e?.message || "The database refused the request.");
}
