// What the Avalara lookups cost and who made them, read off the call ledger (tax_lookups,
// migrations 244 + 319) — for the builder's Sales tax box (portal-settings tax_settings: this
// month's lookups and what they took from the wallet) and the operator's "Sales tax lookups" card
// (admin-catalog tax_usage_get: per tenant over a date range).
//
// The ledger is the source, not the wallet. The wallet cannot count calls: a disarmed, unpriced or
// exempt charge writes no wallet row, and every one of those was still a request Avalara metered.
// Since 319 each row also says what its charge did (charge_state), so one read answers both
// "how many calls" and "what was billed".
//
// Everything here is a pure function or a read that NEVER THROWS (an unreadable figure is null —
// unknown, never zero), so the rules are testable without a database (taxUsage.test.ts).
//
// ⚠️ Bundled per function like every _shared module. Importers today: portal-settings and
// admin-catalog. Derive them before a deploy rather than trusting this line:
//     find supabase/functions -name '*.ts' ! -name '*.test.ts' ! -path '*_test_stubs*' -print0 \
//       | xargs -0 -I{} perl -0777 -ne 'print "$ARGV\n" if m{import[^;]*?from\s+"[^"]*taxUsage\.ts"}s' {}

// deno-lint-ignore no-explicit-any
type Admin = any;

/** PostgREST answers at most db-max-rows (1000 on this project) per request. */
export const TAX_USAGE_PAGE = 1000;
/** The operator report reads at most this many rows and says so when it stops short. */
export const TAX_USAGE_MAX_ROWS = 20_000;
/** A builder's month can hold at most 31 × the daily cap (100) = 3,100 rows. */
const MONTH_MAX_PAGES = 4;
export const TAX_USAGE_MAX_DAYS = 366;

const BILLED_KINDS = ["verify", "invoice"] as const;
export const TAX_USAGE_COLUMNS = "client_id, kind, outcome, charge_state, charge_cents, called_at";
/** The same read against a database migration 319 has not reached (no charge columns). */
export const TAX_USAGE_COLUMNS_PRE_319 = "client_id, kind, outcome, called_at";

const isMissingColumn = (e: unknown) => (e as { code?: string } | null)?.code === "42703";

// ── The builder's month (tax_settings) ─────────────────────────────────────────────────────

/** The first instant of `now`'s UTC month. UTC, as the operator's report and Twilio's days are. */
export function monthStartUtc(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/**
 * This UTC month's lookups (verify + invoice, in-flight rows included, the same rows the cap
 * counts) and what their charges took from the wallet, in cents. Either figure is null when it
 * cannot be read: before migration 319 the spend has no column to read, and is unknown, not $0.
 */
export async function monthTaxUsage(admin: Admin, clientId: string, now: Date = new Date()): Promise<{
  monthStart: string;
  lookups: number | null;
  spendCents: number | null;
}> {
  const monthStart = monthStartUtc(now);
  const out = { monthStart, lookups: null as number | null, spendCents: null as number | null };
  if (!clientId) return out;
  const [count, spend] = await Promise.all([
    (async () => {
      try {
        const { count, error } = await admin.from("tax_lookups")
          .select("id", { count: "exact", head: true })
          .eq("client_id", clientId).in("kind", [...BILLED_KINDS]).gte("called_at", monthStart);
        return !error && typeof count === "number" && Number.isFinite(count) ? count : null;
      } catch { return null; }
    })(),
    (async () => {
      try {
        let cents = 0;
        for (let page = 0; page < MONTH_MAX_PAGES; page++) {
          const { data, error } = await admin.from("tax_lookups")
            .select("charge_cents")
            .eq("client_id", clientId).eq("charge_state", "charged").gte("called_at", monthStart)
            .order("called_at", { ascending: true })
            .range(page * TAX_USAGE_PAGE, (page + 1) * TAX_USAGE_PAGE - 1);
          if (error || !Array.isArray(data)) return null;
          for (const r of data) cents += centsOf(r?.charge_cents);
          if (data.length < TAX_USAGE_PAGE) return cents;
        }
        return null; // more rows than a month can hold: something is wrong, say unknown
      } catch { return null; }
    })(),
  ]);
  out.lookups = count;
  out.spendCents = spend;
  return out;
}

const centsOf = (v: unknown): number => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};

// ── The operator's report (tax_usage_get) ──────────────────────────────────────────────────

export type TaxUsageRange = { from: string; to: string; fromDay: string; toDay: string; days: number };

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const dayMs = (s: string): number | null => {
  const m = DAY.exec(s);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // Round trip, so 2026-02-31 is refused rather than rolled into March.
  return new Date(ms).toISOString().slice(0, 10) === s ? ms : null;
};

/**
 * The report's range, from the body's `from` / `to` as UTC days (YYYY-MM-DD), BOTH INCLUSIVE.
 * Defaults: the first of this UTC month to today. Throws a sentence an operator can read for
 * anything else (the catalog's convention: a thrown Error is a 400 with its message).
 */
export function parseTaxUsageRange(p: Record<string, unknown> | null | undefined, now: Date): TaxUsageRange {
  const today = now.toISOString().slice(0, 10);
  const fromDay = p?.from == null || p.from === "" ? monthStartUtc(now).slice(0, 10) : String(p.from).trim();
  const toDay = p?.to == null || p.to === "" ? today : String(p.to).trim();
  const a = dayMs(fromDay), b = dayMs(toDay);
  if (a == null || b == null) throw new Error("Pick the dates as YYYY-MM-DD.");
  if (a > b) throw new Error("The start date must be on or before the end date.");
  const days = Math.round((b - a) / 86_400_000) + 1;
  if (days > TAX_USAGE_MAX_DAYS) throw new Error(`Pick a range of at most ${TAX_USAGE_MAX_DAYS} days.`);
  return { from: new Date(a).toISOString(), to: new Date(b + 86_400_000).toISOString(), fromDay, toDay, days };
}

export type TaxUsageRow = {
  client_id: string;
  kind: string;
  outcome?: string | null;
  charge_state?: string | null;
  charge_cents?: number | string | null;
  called_at?: string;
};

/** Every row in [from, to), oldest first, paged; `pre319` when the charge columns do not exist yet
 *  (the report then counts calls and says the charges are unknown). */
export async function readTaxLookupsInRange(admin: Admin, from: string, to: string, maxRows = TAX_USAGE_MAX_ROWS): Promise<
  { ok: true; rows: TaxUsageRow[]; truncated: boolean; pre319: boolean } | { ok: false; error: unknown }
> {
  const read = async (cols: string) => {
    const rows: TaxUsageRow[] = [];
    for (let start = 0; start < maxRows; start += TAX_USAGE_PAGE) {
      const { data, error } = await admin.from("tax_lookups").select(cols)
        .gte("called_at", from).lt("called_at", to)
        .order("called_at", { ascending: true }).order("id", { ascending: true })
        .range(start, Math.min(start + TAX_USAGE_PAGE, maxRows) - 1);
      if (error) return { error };
      rows.push(...(data ?? []));
      if ((data ?? []).length < TAX_USAGE_PAGE) return { rows, truncated: false };
    }
    return { rows, truncated: true };
  };
  try {
    let r = await read(TAX_USAGE_COLUMNS);
    let pre319 = false;
    if ("error" in r && isMissingColumn(r.error)) {
      r = await read(TAX_USAGE_COLUMNS_PRE_319);
      pre319 = true;
    }
    if ("error" in r) return { ok: false, error: r.error };
    return { ok: true, rows: r.rows!, truncated: r.truncated!, pre319 };
  } catch (e) {
    return { ok: false, error: e };
  }
}

export type TenantTaxUsage = {
  clientId: string;
  companyName: string;
  /** client_settings.tax_lookup_enabled — the per-tenant switch (244). Read-only here. */
  lookupEnabled: boolean;
  /** invoice_in_ghl false: the tenant issues StructureStudio paperwork, so its paths can call. */
  ssMode: boolean;
  billingExempt: boolean;
  calls: number;
  verify: number;
  invoice: number;
  ok: number;
  failed: number;
  inFlight: number;
  /** Failed lookups by Avalara's (or our) failure, e.g. { timeout: 2 }. */
  failures: Record<string, number>;
  charged: number;
  chargedCents: number;
  exempt: number;
  inactive: number;
  unpriced: number;
  noRate: number;
  pending: number;
  errors: number;
  /** A closed lookup with no charge state: before 319, or an answer that reached no document. */
  unstated: number;
};

type Switch = { client_id: string; tax_lookup_enabled?: boolean | null; invoice_in_ghl?: boolean | null; billing_exempt?: boolean | null };

const emptyTenant = (clientId: string, companyName: string, sw: Switch | undefined): TenantTaxUsage => ({
  clientId, companyName,
  lookupEnabled: sw?.tax_lookup_enabled === true,
  ssMode: sw?.invoice_in_ghl === false,
  billingExempt: sw?.billing_exempt === true,
  calls: 0, verify: 0, invoice: 0, ok: 0, failed: 0, inFlight: 0, failures: {},
  charged: 0, chargedCents: 0, exempt: 0, inactive: 0, unpriced: 0, noRate: 0, pending: 0, errors: 0, unstated: 0,
});

/**
 * The per-tenant report. A tenant is listed when it made a lookup in the range OR has the switch
 * on (so a builder switched on and never calling is visible), busiest first, then by name. Pings
 * are the platform's own credential checks and are counted apart, never under a tenant.
 */
export function summarizeTaxUsage(input: {
  range: TaxUsageRange;
  rows: TaxUsageRow[];
  switches: Switch[];
  names: Map<string, string>;
  meters: { kind: string; active?: boolean | null; price_cents?: number | string | null }[];
  truncated?: boolean;
  pre319?: boolean;
}) {
  const sw = new Map(input.switches.map((s) => [String(s.client_id), s]));
  const by = new Map<string, TenantTaxUsage>();
  const tenant = (id: string) => {
    let t = by.get(id);
    if (!t) { t = emptyTenant(id, input.names.get(id) ?? id, sw.get(id)); by.set(id, t); }
    return t;
  };
  let pings = 0, pingsFailed = 0;
  for (const r of input.rows) {
    if (r.kind === "ping") { pings++; if (r.outcome != null && r.outcome !== "ok") pingsFailed++; continue; }
    if (r.kind !== "verify" && r.kind !== "invoice") continue;
    const t = tenant(String(r.client_id));
    t.calls++;
    if (r.kind === "verify") t.verify++; else t.invoice++;
    if (r.outcome == null) t.inFlight++;
    else if (r.outcome === "ok") t.ok++;
    else { t.failed++; t.failures[r.outcome] = (t.failures[r.outcome] ?? 0) + 1; }
    switch (r.charge_state) {
      case "charged": t.charged++; t.chargedCents += centsOf(r.charge_cents); break;
      case "exempt": t.exempt++; break;
      case "inactive": t.inactive++; break;
      case "unpriced": t.unpriced++; break;
      case "no_rate": t.noRate++; break;
      case "pending": t.pending++; break;
      case "error": t.errors++; break;
      default: if (r.outcome != null) t.unstated++;
    }
  }
  for (const s of input.switches) if (s.tax_lookup_enabled === true) tenant(String(s.client_id));

  const tenants = [...by.values()].sort((a, b) => b.calls - a.calls || a.companyName.localeCompare(b.companyName));
  const totals = emptyTenant("", "All builders", undefined);
  for (const t of tenants) {
    for (const k of ["calls", "verify", "invoice", "ok", "failed", "inFlight", "charged", "chargedCents", "exempt", "inactive",
      "unpriced", "noRate", "pending", "errors", "unstated"] as const) totals[k] += t[k];
    for (const [f, n] of Object.entries(t.failures)) totals.failures[f] = (totals.failures[f] ?? 0) + n;
  }
  const meter = (kind: string) => {
    const m = input.meters.find((x) => x.kind === kind);
    const price = Number(m?.price_cents) || 0;
    return { kind, exists: !!m, active: m?.active === true, priceCents: price, armed: m?.active === true && price > 0 };
  };
  return {
    range: { from: input.range.fromDay, to: input.range.toDay, days: input.range.days },
    meters: [meter("tax_lookup"), meter("tax_invoice")],
    tenants,
    totals,
    platform: { pings, pingsFailed },
    rowCount: input.rows.length,
    truncated: input.truncated === true,
    /** True when the database has no charge columns yet (319 not applied): charges are unknown. */
    chargesUnknown: input.pre319 === true,
  };
}
