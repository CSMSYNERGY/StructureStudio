// The builder's wallet ledger as the Billing tab shows it: the Transactions view, its CSV
// export, and the labels the wallet card's short list uses (usage billing, migration 259).
//
// Carolyn 2026-10-02: every call minute and every text a builder uses comes out of the wallet,
// "each charge is its own line under Transactions, like GoHighLevel". So the ledger stops being
// a handful of top-ups and 3D generations and becomes hundreds of sub-cent lines a month, which
// needs paging, filters, a date range and an export, and amounts to four decimals ($0.0280).
//
// portal-billing does the reading; everything in here is a pure function or a constant, so the
// rules a builder is billed and shown by are testable without a database
// (walletLedger.test.ts, and _test_stubs/walletTransactions_test.ts drives the real handler).
//
// ⚠️ DUPLICATION LEDGER: this module is bundled per function, so a change here means redeploying
// EVERY importer in the same push. Today that is `portal-billing` alone. Derive the list before
// deploying with the import-parsing command in taxMeter.ts's header (swap in walletLedger\.ts).
//
// ⛔ WHAT A TENANT MAY READ OFF wallet_transactions. That table holds OUR cost next to THEIR
// charge: `cost_cents` (128), `cost_micros` (259) and `usage` (token counts, and for a call the
// units we priced). Those are our gross margin, which 128 calls "the single worst thing in this
// schema for a tenant to read". Every select a tenant-facing read makes goes through
// LEDGER_COLUMNS below and nothing else; FORBIDDEN_LEDGER_COLUMNS is what the tests refuse to see
// in it, in portal-billing's source and on the wire.

// deno-lint-ignore no-explicit-any
type Query = any;

/** Columns the Transactions view reads. NEVER cost_cents, cost_micros or usage. */
export const LEDGER_COLUMNS =
  "id, created_at, kind, meter_kind, state, memo, amount_cents, balance_after_cents, amount_exact_micros, balance_after_exact_micros";
/**
 * The same read against a database migration 259 has not reached yet (no exact columns).
 * portal-billing falls back to it on Postgres 42703 (undefined column), so deploying the
 * function ahead of the migration costs the four-decimal amounts, not the whole view. That
 * ordering has bitten this function before: migration 109's grants read hard-500'd every
 * billing call for two minutes on 2026-08-19.
 */
export const LEDGER_COLUMNS_PRE_259 =
  "id, created_at, kind, meter_kind, state, memo, amount_cents, balance_after_cents";
/** Never in a tenant-facing select. The tests read this list; do not trim it. */
export const FORBIDDEN_LEDGER_COLUMNS = ["cost_cents", "cost_micros", "usage"] as const;

/** Posted lines, plus 3D holds still in flight (shown as pending, as the card always did). */
export const LEDGER_STATES = ["posted", "held"] as const;

export const LEDGER_PAGE_MAX = 50;
export const LEDGER_CSV_MAX_ROWS = 10_000;
/** PostgREST answers at most db-max-rows (1000 on this project) per request. */
export const LEDGER_CSV_PAGE = 1000;

// ── Categories: the filter chips ───────────────────────────────────────────────────────────
// Outbound and inbound are separate meters (259): `voice_minute` / `sms_segment` are what the
// builder starts, `voice_minute_in` / `sms_in` what their customers start.
export const CALL_METERS = ["voice_minute", "voice_minute_in"] as const;
export const TEXT_METERS = ["sms_segment", "sms_in"] as const;
/** Money in or out that is not usage. `debit` is the only kind left over (128's check). */
export const FUNDS_KINDS = ["topup", "refund", "grant", "adjustment", "reversal"] as const;
const USAGE_METERS: readonly string[] = [...CALL_METERS, ...TEXT_METERS];

export type LedgerFilter = "all" | "calls" | "texts" | "funds" | "other";
export type LedgerCategory = Exclude<LedgerFilter, "all">;
export const LEDGER_FILTERS: readonly LedgerFilter[] = ["all", "calls", "texts", "funds", "other"];

/**
 * Which chip a line belongs to. EXACTLY ONE, which is what makes the four chips add up to All:
 * the meter wins over the kind, so a refund of a call (should one ever be posted) sits with the
 * calls it corrects rather than being counted under both Calls and Funds.
 * applyLedgerFilter below is the same rule written for PostgREST, and walletLedger.test.ts
 * proves the two agree on every kind × meter pair.
 */
export function ledgerCategory(t: { kind?: string | null; meter_kind?: string | null }): LedgerCategory {
  const m = t.meter_kind ?? "";
  if ((CALL_METERS as readonly string[]).includes(m)) return "calls";
  if ((TEXT_METERS as readonly string[]).includes(m)) return "texts";
  if ((FUNDS_KINDS as readonly string[]).includes(t.kind ?? "")) return "funds";
  return "other";
}

const pgList = (xs: readonly string[]) => `(${xs.join(",")})`;
// `not in` drops NULLs in SQL, and a top-up has no meter, so "no usage meter" must say so.
const NOT_USAGE = `meter_kind.is.null,meter_kind.not.in.${pgList(USAGE_METERS)}`;

/** Narrow a wallet_transactions query to one chip. `all` (or anything unknown) narrows nothing. */
export function applyLedgerFilter(q: Query, filter: LedgerFilter): Query {
  switch (filter) {
    case "calls": return q.in("meter_kind", [...CALL_METERS]);
    case "texts": return q.in("meter_kind", [...TEXT_METERS]);
    case "funds": return q.in("kind", [...FUNDS_KINDS]).or(NOT_USAGE);
    case "other": return q.not("kind", "in", pgList(FUNDS_KINDS)).or(NOT_USAGE);
    default: return q;
  }
}

// ── Labels ─────────────────────────────────────────────────────────────────────────────────
// Authored HERE, server-side, so the browser never maps a `kind` enum to English and drifts
// from it. These were inline in portal-billing's `status` (the card's ten-row list) until the
// Transactions view needed the same words; both now call this, so the card and the view can
// never name one line two ways.
//
// A call or text line carries its own wording in `memo`, written by the phone-api worker when it
// posts the charge: "Outbound call to (555) 123-4567 · 3 min", "Text from … · 1 segment". The
// fallbacks only show for a line posted without one.
const METER_LABELS: Record<string, string> = {
  voice_minute: "Outbound call",
  voice_minute_in: "Incoming call",
  sms_segment: "Text sent",
  sms_in: "Text received",
  phone_line_monthly: "Phone line",
  voicemail_transcription: "Voicemail transcription",
  sms_number_monthly: "Text messaging number",
  sms_registration: "Text messaging setup",
  video_3d_generation: "3D generation from a video",
  // The two sales-tax meters (179). Only reachable since migration 244 taught wallet_credit to
  // record meter_kind — before it every direct-post debit landed with a null kind and read
  // "Usage", which is exactly the row a builder cannot explain.
  tax_lookup: "Tax verification",
  tax_invoice: "Invoice tax check",
};
// Meters whose memo is the better description, because the poster wrote one per line (the
// number dialled, the minutes, the month a line fee covers).
const MEMO_METERS = new Set([...USAGE_METERS, "phone_line_monthly", "voicemail_transcription"]);

export function walletLineLabel(t: { kind?: string | null; meter_kind?: string | null; memo?: string | null }): string {
  const memo = typeof t.memo === "string" ? t.memo.trim() : "";
  if (t.kind === "topup") return memo === "Automatic top-up" ? "Added funds · automatic top-up" : "Added funds";
  if (t.kind === "grant") return "Credit from CSM Synergy";
  if (t.kind === "adjustment") return memo ? `Adjustment — ${memo}` : "Adjustment";
  if (t.kind === "refund") return "Refund";
  if (t.kind === "reversal") return memo ? `Reversal — ${memo}` : "Reversal";
  const m = t.meter_kind ?? "";
  if (MEMO_METERS.has(m) && memo) return memo;
  return METER_LABELS[m] ?? "Usage";
}

/**
 * The wallet card's line for a cost-plus meter (259: Twilio's real cost × the markup), shown
 * instead of a price. There is no fixed price to show — usage_prices.price_cents is 0 for these
 * and the card used to print that as "No charge", which is the opposite of true.
 */
export function costPlusNote(kind: string, unitLabel?: string | null): string {
  if ((CALL_METERS as readonly string[]).includes(kind)) return "Billed per call minute";
  if ((TEXT_METERS as readonly string[]).includes(kind)) return "Billed per text";
  if (unitLabel === "minute") return "Billed per minute";
  if (unitLabel === "segment") return "Billed per text";
  return "Billed per use";
}

// ── The request ────────────────────────────────────────────────────────────────────────────
export type LedgerQuery = {
  filter: LedgerFilter;
  limit: number;
  /** Rows older than this id. Lines are ordered by id, newest first (see portal-billing). */
  before: number | null;
  /** ISO instants: from inclusive, to EXCLUSIVE. The browser sends its own local midnights. */
  from: string | null;
  to: string | null;
  csv: boolean;
  /** IANA zone the CSV's Date column is written in. UTC when absent or unknown. */
  tz: string;
};

export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Validate the body of a `wallet_transactions` call. Errors are sentences a builder can read. */
export function parseLedgerQuery(p: Record<string, unknown> | null | undefined):
  | { ok: true; query: LedgerQuery }
  | { ok: false; error: string } {
  const body = p ?? {};
  const filter = (body.filter ?? "all") as LedgerFilter;
  if (!LEDGER_FILTERS.includes(filter)) return { ok: false, error: "Choose All, Calls, Texts, Funds or Other." };

  let limit = LEDGER_PAGE_MAX;
  if (body.limit != null) {
    const n = Number(body.limit);
    if (!Number.isInteger(n) || n < 1) return { ok: false, error: "That page size isn't valid." };
    limit = Math.min(n, LEDGER_PAGE_MAX);
  }

  let before: number | null = null;
  if (body.cursor != null && body.cursor !== "") {
    const c = String(body.cursor);
    if (!/^[1-9][0-9]{0,15}$/.test(c)) return { ok: false, error: "That page link has expired. Reload the list." };
    before = Number(c);
  }

  const instant = (v: unknown): string | null | undefined => {
    if (v == null || v === "") return null;
    const ms = Date.parse(String(v));
    return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
  };
  const from = instant(body.from);
  const to = instant(body.to);
  if (from === undefined || to === undefined) return { ok: false, error: "Those dates aren't valid." };
  if (from && to && from >= to) return { ok: false, error: "The start date must be before the end date." };

  if (body.format != null && body.format !== "csv") return { ok: false, error: "Only CSV export is available." };

  return {
    ok: true,
    query: { filter, limit, before, from, to, csv: body.format === "csv", tz: isTimeZone(body.tz) ? body.tz : "UTC" },
  };
}

// ── The response row ───────────────────────────────────────────────────────────────────────
export type LedgerRaw = {
  id: number | string;
  created_at: string;
  kind: string;
  meter_kind?: string | null;
  state?: string | null;
  memo?: string | null;
  amount_cents: number | string;
  balance_after_cents: number | string | null;
  amount_exact_micros?: number | string | null;
  balance_after_exact_micros?: number | string | null;
};

export type LedgerRow = {
  id: number;
  created_at: string;
  description: string;
  /** wallet_transactions.kind: topup | debit | refund | grant | adjustment | reversal. */
  kind: string;
  /** The chip this line is counted under. */
  category: LedgerCategory;
  /** A 3D hold still in flight: money set aside, not yet taken. */
  pending: boolean;
  amount_cents: number;
  amount_exact_micros: number | null;
  /** Null on a pending line — a hold records the balance it was taken against, not one it left. */
  balance_after_cents: number | null;
  /** Null when it is not this line's balance (a captured 3D hold, see exactBalance below). */
  balance_after_exact_micros: number | null;
  /**
   * Show this line's AMOUNT to four decimals: a call or text, or any amount that is not whole
   * cents. The balance beside it has its own rule (four places whenever it carries a fraction of a
   * cent, the number the CSV prints), because a top-up after three texts leaves a sub-cent balance
   * on a whole-cent amount; the Billing tab applies that rule to balance_after_exact_micros.
   */
  precise: boolean;
};

const numOrNull = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * The exact balance, or null when it does not describe the balance_after_cents beside it.
 *
 * STALE ON A CAPTURED 3D HOLD. Migration 259's trigger fills balance_after_exact_micros when a
 * line is INSERTED. wallet_hold inserts the hold carrying the balance it was taken against, and
 * wallet_capture (128) later UPDATEs that row's balance_after_cents to the balance after the
 * capture, which an insert trigger never sees. The exact column then still holds the hold-time
 * balance, $20.00 too high after a $20 generation, and the four-place column (and the CSV) would
 * print it. A true pair is cents × 10,000 less a remainder under one cent (259's
 * usage_remainder_micros), so a pair a whole cent or more apart is the stale one, and the line
 * falls back to its whole cents, which capture did write. A capture moves the balance by whole
 * cents, so every one that moves it at all is caught. The proper fix is in the database (the
 * column refreshed when capture writes the cents); this keeps the page right until it is.
 */
export function exactBalance(cents: number | null, exact: number | null): number | null {
  if (cents == null || exact == null) return null;
  return Math.abs(cents * 10_000 - exact) < 10_000 ? exact : null;
}

export function toLedgerRow(t: LedgerRaw): LedgerRow {
  const category = ledgerCategory(t);
  const pending = t.state === "held";
  const exact = numOrNull(t.amount_exact_micros);
  const balanceCents = pending ? null : numOrNull(t.balance_after_cents);
  return {
    id: Number(t.id),
    created_at: t.created_at,
    description: walletLineLabel(t),
    kind: t.kind,
    category,
    pending,
    amount_cents: Number(t.amount_cents),
    amount_exact_micros: exact,
    balance_after_cents: balanceCents,
    balance_after_exact_micros: pending ? null : exactBalance(balanceCents, numOrNull(t.balance_after_exact_micros)),
    precise: exact != null && (category === "calls" || category === "texts" || exact % 10_000 !== 0),
  };
}

// ── Money and dates as text ────────────────────────────────────────────────────────────────
/**
 * Micros (millionths of a dollar) as a plain decimal with `decimals` places, half away from
 * zero, integer arithmetic only: 28_000 → "0.0280", -4_150 → "-0.0042" (4 places).
 */
export function microsToDecimal(micros: number, decimals: 2 | 4): string {
  const step = decimals === 4 ? 100 : 10_000;
  const units = Math.round(Math.abs(micros) / step);
  const scale = decimals === 4 ? 10_000 : 100;
  const whole = Math.floor(units / scale);
  const frac = String(units % scale).padStart(decimals, "0");
  return `${micros < 0 && units !== 0 ? "-" : ""}${whole}.${frac}`;
}

export function centsToDecimal(cents: number): string {
  return microsToDecimal(cents * 10_000, 2);
}

/**
 * A formatter for "2026-10-02 14:05" in `tz`, falling back to UTC with the zone named if the
 * runtime cannot format that zone.
 *
 * Built ONCE per export, not per line: constructing an Intl.DateTimeFormat costs far more than
 * using one, and at 10,000 lines that difference is seconds of CPU an edge function does not
 * have (the platform's CPU budget per request is a couple of seconds).
 */
export function ledgerDateFormatter(tz: string): (iso: string) => string {
  let fmt: Intl.DateTimeFormat | null = null;
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });
  } catch {
    fmt = null;
  }
  return (iso: string) => {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return "";
    if (!fmt) return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
    const p: Record<string, string> = {};
    for (const x of fmt.formatToParts(d)) p[x.type] = x.value;
    return `${p.year}-${p.month}-${p.day} ${p.hour === "24" ? "00" : p.hour}:${p.minute}`;
  };
}

/** One date, for a caller with one line. ledgerCsv uses the formatter above directly. */
export function ledgerDate(iso: string, tz: string): string {
  return ledgerDateFormatter(tz)(iso);
}

// ── CSV ────────────────────────────────────────────────────────────────────────────────────
// RFC 4180: CRLF lines, a cell quoted when it holds a comma, quote or line break.
//
// CSV INJECTION. A spreadsheet runs a cell that starts with = + - @ as a formula, and the
// Description column carries text an operator typed (an adjustment memo). Such a cell gets an
// apostrophe in front, the same guard portal/03-catalog.jsx's csvEscape applies to price sheets.
// The ONE exception is a cell that is exactly a number we formatted ourselves (-12.3400): a bare
// signed decimal cannot carry a formula, and prefixing it would turn every debit into text that
// a builder's spreadsheet can no longer add up. Tab and carriage return are guarded too, as
// csvEscape does, because some spreadsheets strip them and then see the character after.
const PLAIN_NUMBER = /^-?[0-9]+(\.[0-9]+)?$/;

export function csvCell(v: unknown): string {
  let s = v == null ? "" : String(v);
  if (!PLAIN_NUMBER.test(s) && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const LEDGER_CSV_HEADER = ["Date", "Description", "Amount", "Balance"] as const;

/**
 * The export. Amounts carry four decimals whenever the line has its exact micros (every line
 * once 259 has run, since its trigger and backfill fill them), two otherwise. A uniform
 * four-place column is deliberate: it is what a spreadsheet sums without a rounding surprise.
 * A pending hold has no balance yet, so that cell is empty. A captured 3D hold's balance is its
 * whole cents (toLedgerRow drops the stale exact value), so that one cell has two places.
 */
export function ledgerCsv(rows: LedgerRow[], tz: string): string {
  const lines = [LEDGER_CSV_HEADER.map(csvCell).join(",")];
  const when = ledgerDateFormatter(tz);
  for (const r of rows) {
    const amount = r.amount_exact_micros != null ? microsToDecimal(r.amount_exact_micros, 4) : centsToDecimal(r.amount_cents);
    const balance = r.pending ? ""
      : r.balance_after_exact_micros != null ? microsToDecimal(r.balance_after_exact_micros, 4)
      : r.balance_after_cents != null ? centsToDecimal(r.balance_after_cents)
      : "";
    lines.push([when(r.created_at), r.pending ? `${r.description} (pending)` : r.description, amount, balance]
      .map(csvCell).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
