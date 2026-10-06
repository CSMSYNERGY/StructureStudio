// The wallet ledger a builder reads: what it may select, how it is filtered, labelled and
// exported (usage billing, migration 259; portal-billing's `wallet_transactions`).
//
// WHY THESE EXIST. wallet_transactions holds OUR cost on the same row as THEIR charge —
// cost_cents (128), cost_micros (259) and the usage jsonb. A tenant reading any of them reads
// our margin, which migration 128 calls the worst leak available in this schema. The view that
// reads that table for a tenant is new and will be edited by people adding columns to it, so the
// first group here reads the SHIPPED portal-billing source and fails the push if a cost column,
// `usage`, or a `*` ever reaches one of its wallet_transactions selects. The handler itself, with
// what it actually puts on the wire, is driven in _test_stubs/walletTransactions_test.ts.
//
// The rest pin the rules a builder sees: the four chips partition the ledger (so All is their
// sum), the labels the wallet card already showed did not change, amounts to four places, and
// the CSV export cannot carry a spreadsheet formula.
//
// Dependency-free like the other _shared tests (no jsr:/npm: imports). The source-reading cases
// need --allow-read on the repo (preflight passes it); without it they report ignored.

import {
  applyLedgerFilter, CALL_METERS, centsToDecimal, costPlusNote, csvCell, exactBalance, FORBIDDEN_LEDGER_COLUMNS, FUNDS_KINDS,
  isTimeZone, LEDGER_COLUMNS, LEDGER_COLUMNS_PRE_259, LEDGER_CSV_HEADER, LEDGER_FILTERS, LEDGER_PAGE_MAX, ledgerCategory,
  ledgerCsv, ledgerDate, type LedgerFilter, type LedgerRaw, microsToDecimal, parseLedgerQuery, TEXT_METERS, toLedgerRow,
  walletLineLabel,
} from "./walletLedger.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}
function eq(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}\n  expected ${e}\n  got      ${a}`);
}

const BILLING = new URL("../portal-billing/index.ts", import.meta.url);
const canRead = (u: URL) => Deno.permissions.querySync({ name: "read", path: u }).state === "granted";
const read = async (u: URL) => (await Deno.readTextFile(u)).replace(/\r\n/g, "\n");
// Code only: a comment that names a forbidden column (to say it is forbidden) must not fail a pin.
const codeOnly = (src: string) => src.split("\n").map((l) => l.replace(/^\s*\/\/.*$/, "")).join("\n");
const columnsOf = (sel: string) => sel.split(",").map((c) => c.trim()).filter(Boolean);
const FORBIDDEN_WORD = new RegExp(`\\b(${FORBIDDEN_LEDGER_COLUMNS.join("|")})\\b`);

// ── 1. What may be selected ────────────────────────────────────────────────────────────────
Deno.test("the ledger's column lists name no cost column, no usage and no wildcard", () => {
  for (const [name, sel] of [["LEDGER_COLUMNS", LEDGER_COLUMNS], ["LEDGER_COLUMNS_PRE_259", LEDGER_COLUMNS_PRE_259]] as const) {
    const cols = columnsOf(sel);
    for (const bad of [...FORBIDDEN_LEDGER_COLUMNS, "*"]) {
      assert(!cols.includes(bad), `${name} selects ${bad} — that is our cost/margin and must never reach a tenant`);
    }
    assert(!FORBIDDEN_WORD.test(sel), `${name} mentions a forbidden column: ${sel}`);
    // No embedded resource or rename either: `foo:cost_cents` or `x(*)` would smuggle one in.
    assert(cols.every((c) => /^[a-z_]+$/.test(c)), `${name} has a column that is not a bare name: ${sel}`);
  }
  eq(FORBIDDEN_LEDGER_COLUMNS, ["cost_cents", "cost_micros", "usage"], "the forbidden list was trimmed");
});

Deno.test("the pre-259 fallback is the same read minus the exact columns, nothing else", () => {
  const full = columnsOf(LEDGER_COLUMNS), old = columnsOf(LEDGER_COLUMNS_PRE_259);
  eq(full.filter((c) => !old.includes(c)), ["amount_exact_micros", "balance_after_exact_micros"], "the fallback drops more than the 259 columns");
  assert(old.every((c) => full.includes(c)), "the fallback reads a column the full read does not");
});

function liftBranch(src: string): string {
  const start = src.indexOf('if (action === "wallet_transactions") {');
  assert(start >= 0, "portal-billing has no wallet_transactions branch — re-point this pin rather than deleting it");
  // The branch ends at the first line that closes a block at the handler's own indent.
  const end = src.indexOf("\n  }\n", start);
  assert(end > start, "could not find the end of the wallet_transactions branch");
  return src.slice(start, end);
}

Deno.test({
  name: "portal-billing's wallet_transactions action selects LEDGER_COLUMNS and nothing else",
  ignore: !canRead(BILLING),
  fn: async () => {
    const branch = codeOnly(liftBranch(await read(BILLING)));
    assert(branch.includes('admin.from("wallet_transactions")'), "the branch no longer reads wallet_transactions — re-point this pin");
    assert(!FORBIDDEN_WORD.test(branch), `the wallet_transactions branch names a forbidden column: ${branch.match(FORBIDDEN_WORD)?.[0]}`);
    // Every select in the branch goes through `cols`, and `cols` is only ever one of the two lists.
    const selects = [...branch.matchAll(/\.select\(([^)]*)\)/g)].map((m) => m[1].trim());
    assert(selects.length > 0, "the branch makes no select at all — re-point this pin");
    eq([...new Set(selects)], ["cols"], "a select in the branch does not go through `cols` (an inline column list or `*`)");
    const assigns = [...branch.matchAll(/\bcols\b\s*(?::\s*string\s*)?=(?!=)\s*([A-Za-z0-9_]+)/g)].map((m) => m[1]);
    assert(assigns.length >= 2, `expected the initial read and the 42703 fallback to assign cols, found ${JSON.stringify(assigns)}`);
    assert(assigns.every((a) => a === "LEDGER_COLUMNS" || a === "LEDGER_COLUMNS_PRE_259"),
      `cols is assigned something other than the ledger column lists: ${JSON.stringify(assigns)}`);
  },
});

Deno.test({
  name: "every literal wallet_transactions select in portal-billing (the card's ten-line list too) is clean",
  ignore: !canRead(BILLING),
  fn: async () => {
    const src = codeOnly(await read(BILLING));
    const hits = [...src.matchAll(/\.from\("wallet_transactions"\)\s*\.select\("([^"]*)"/g)].map((m) => m[1]);
    assert(hits.length >= 1, "found no literal wallet_transactions select — the status list moved; re-point this pin");
    for (const sel of hits) {
      assert(!FORBIDDEN_WORD.test(sel) && !columnsOf(sel).includes("*"), `a wallet_transactions select reads our cost: "${sel}"`);
    }
    // And nothing else in the file selects the ledger by any other route (a variable, a template).
    const all = [...src.matchAll(/\.from\("wallet_transactions"\)\s*\.select\(([^)]*)\)/g)].map((m) => m[1].trim());
    assert(all.every((a) => a === "cols" || /^"[^"]*"$/.test(a)), `a wallet_transactions select this pin cannot read: ${JSON.stringify(all)}`);
  },
});

// ── 2. The chips partition the ledger ──────────────────────────────────────────────────────
// A tiny PostgREST: records what applyLedgerFilter asks for and answers it for one row.
type Row = { kind: string; meter_kind: string | null };
function recorder() {
  const ops: [string, ...unknown[]][] = [];
  const q = {
    in: (col: string, vals: string[]) => (ops.push(["in", col, vals]), q),
    not: (col: string, op: string, val: string) => (ops.push(["not", col, op, val]), q),
    or: (expr: string) => (ops.push(["or", expr]), q),
  };
  return { q, ops };
}
const listOf = (s: string) => s.replace(/^\(|\)$/g, "").split(",");
function orClause(row: Row, term: string): boolean {
  const m = term.match(/^([a-z_]+)\.(is\.null|not\.in\.\((.*)\))$/);
  if (!m) throw new Error(`the fake cannot read the or() term ${term}`);
  const v = (row as Record<string, string | null>)[m[1]];
  if (m[2] === "is.null") return v == null;
  return v != null && !m[3].split(",").includes(v);   // SQL: NULL NOT IN (...) is not true
}
function matches(row: Row, ops: [string, ...unknown[]][]): boolean {
  return ops.every((o) => {
    if (o[0] === "in") return (o[2] as string[]).includes((row as Record<string, string | null>)[o[1] as string] as string);
    if (o[0] === "not") {
      assert(o[2] === "in", `the fake only reads not.in, got ${o[2]}`);
      const v = (row as Record<string, string | null>)[o[1] as string];
      return v != null && !listOf(o[3] as string).includes(v);
    }
    if (o[0] === "or") return splitTop(o[1] as string).some((t) => orClause(row, t));
    throw new Error(`unknown op ${o[0]}`);
  });
}
// Split an or() expression on its top-level commas (the not.in list has commas inside parens).
function splitTop(expr: string): string[] {
  const out: string[] = []; let depth = 0, cur = "";
  for (const c of expr) {
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) { out.push(cur); cur = ""; } else cur += c;
  }
  return [...out, cur];
}

const KINDS = ["topup", "debit", "refund", "grant", "adjustment", "reversal"];
const METERS = [null, ...CALL_METERS, ...TEXT_METERS, "video_3d_generation", "tax_lookup", "phone_line_monthly", "sms_number_monthly"];

Deno.test("every kind × meter lands under exactly one chip, and it is the one ledgerCategory names", () => {
  const filters = LEDGER_FILTERS.filter((f) => f !== "all");
  for (const kind of KINDS) {
    for (const meter_kind of METERS) {
      const row = { kind, meter_kind };
      const hits = filters.filter((f) => {
        const r = recorder();
        applyLedgerFilter(r.q, f);
        return matches(row, r.ops);
      });
      eq(hits, [ledgerCategory(row)], `${kind} / ${meter_kind} is counted under ${JSON.stringify(hits)}`);
      const all = recorder();
      applyLedgerFilter(all.q, "all");
      eq(all.ops, [], "All narrows something");
    }
  }
});

Deno.test("the chips mean what the Billing tab says they mean", () => {
  eq(ledgerCategory({ kind: "debit", meter_kind: "voice_minute" }), "calls", "an outbound call");
  eq(ledgerCategory({ kind: "debit", meter_kind: "voice_minute_in" }), "calls", "an incoming call");
  eq(ledgerCategory({ kind: "debit", meter_kind: "sms_segment" }), "texts", "a text sent");
  eq(ledgerCategory({ kind: "debit", meter_kind: "sms_in" }), "texts", "a text received");
  for (const k of FUNDS_KINDS) eq(ledgerCategory({ kind: k, meter_kind: null }), "funds", `a ${k}`);
  eq(ledgerCategory({ kind: "debit", meter_kind: "video_3d_generation" }), "other", "a 3D generation");
  eq(ledgerCategory({ kind: "debit", meter_kind: "phone_line_monthly" }), "other", "the line fee");
  eq(ledgerCategory({ kind: "debit", meter_kind: null }), "other", "an unlabelled debit");
});

// ── 3. Labels ──────────────────────────────────────────────────────────────────────────────
Deno.test("the labels the wallet card already showed are unchanged", () => {
  eq(walletLineLabel({ kind: "topup", memo: "Card top-up" }), "Added funds", "a card top-up");
  eq(walletLineLabel({ kind: "grant", memo: "anything" }), "Credit from CSM Synergy", "a grant");
  eq(walletLineLabel({ kind: "adjustment", memo: "goodwill" }), "Adjustment — goodwill", "an adjustment with a memo");
  eq(walletLineLabel({ kind: "adjustment", memo: null }), "Adjustment", "an adjustment without one");
  eq(walletLineLabel({ kind: "refund" }), "Refund", "a refund");
  eq(walletLineLabel({ kind: "debit", meter_kind: "video_3d_generation" }), "3D generation from a video", "3D");
  eq(walletLineLabel({ kind: "debit", meter_kind: "tax_lookup" }), "Tax verification", "tax lookup");
  eq(walletLineLabel({ kind: "debit", meter_kind: "tax_invoice" }), "Invoice tax check", "invoice tax");
  eq(walletLineLabel({ kind: "debit", meter_kind: null }), "Usage", "an unknown debit");
});

Deno.test("a call or text line reads the wording the worker wrote, with a fallback per direction", () => {
  const memo = "Outbound call to (555) 010-0001 · 3 min";
  eq(walletLineLabel({ kind: "debit", meter_kind: "voice_minute", memo }), memo, "the memo is the line");
  eq(walletLineLabel({ kind: "debit", meter_kind: "voice_minute", memo: null }), "Outbound call", "no memo, outbound");
  eq(walletLineLabel({ kind: "debit", meter_kind: "voice_minute_in", memo: "  " }), "Incoming call", "a blank memo is no memo");
  eq(walletLineLabel({ kind: "debit", meter_kind: "sms_segment" }), "Text sent", "no memo, text out");
  eq(walletLineLabel({ kind: "debit", meter_kind: "sms_in" }), "Text received", "no memo, text in");
  eq(walletLineLabel({ kind: "debit", meter_kind: "phone_line_monthly", memo: "Phone line for 2026-10" }), "Phone line for 2026-10", "the line fee's month");
  eq(walletLineLabel({ kind: "topup", memo: "Automatic top-up" }), "Added funds · automatic top-up", "an unattended charge says so");
  // A memo on a meter that does not author one per line is not trusted as the description.
  eq(walletLineLabel({ kind: "debit", meter_kind: "video_3d_generation", memo: "whatever" }), "3D generation from a video", "3D ignores memo");
});

Deno.test("cost-plus meters are described, not priced", () => {
  eq(costPlusNote("voice_minute"), "Billed per call minute", "outbound minutes");
  eq(costPlusNote("voice_minute_in"), "Billed per call minute", "incoming minutes");
  eq(costPlusNote("sms_segment"), "Billed per text", "texts out");
  eq(costPlusNote("sms_in"), "Billed per text", "texts in");
  eq(costPlusNote("something_new", "minute"), "Billed per minute", "an unknown minute meter");
  eq(costPlusNote("something_new", "generation"), "Billed per use", "anything else");
});

// ── 4. The request ─────────────────────────────────────────────────────────────────────────
Deno.test("a bare request is the newest 50 lines of everything", () => {
  const r = parseLedgerQuery({ action: "wallet_transactions" });
  assert(r.ok, "a bare request was refused");
  if (r.ok) eq(r.query, { filter: "all", limit: LEDGER_PAGE_MAX, before: null, from: null, to: null, csv: false, tz: "UTC" }, "defaults");
});

Deno.test("limits, cursors, dates and formats are validated, and the page size is capped at 50", () => {
  const ok = (p: Record<string, unknown>) => {
    const r = parseLedgerQuery(p);
    if (!r.ok) throw new Error(`refused ${JSON.stringify(p)}: ${r.error}`);
    return r.query;
  };
  const bad = (p: Record<string, unknown>) => {
    const r = parseLedgerQuery(p);
    assert(!r.ok, `accepted ${JSON.stringify(p)}`);
    if (!r.ok) assert(/^[A-Z].*\.$/.test(r.error), `not a sentence: ${r.error}`);
  };
  eq(ok({ limit: 500 }).limit, 50, "a large page is capped, not refused");
  eq(ok({ limit: "10" }).limit, 10, "a string number");
  bad({ limit: 0 }); bad({ limit: 2.5 }); bad({ limit: "ten" });
  eq(ok({ cursor: "12345" }).before, 12345, "a cursor is the id to page below");
  bad({ cursor: "0" }); bad({ cursor: "12;drop" }); bad({ cursor: "-4" }); bad({ cursor: "1e3" });
  for (const f of LEDGER_FILTERS) eq(ok({ filter: f }).filter, f, `filter ${f}`);
  bad({ filter: "everything" });
  const q = ok({ from: "2026-10-01T05:00:00.000Z", to: "2026-11-01T05:00:00.000Z" });
  eq([q.from, q.to], ["2026-10-01T05:00:00.000Z", "2026-11-01T05:00:00.000Z"], "dates pass through as instants");
  bad({ from: "next tuesday" });
  bad({ from: "2026-11-01T00:00:00Z", to: "2026-10-01T00:00:00Z" });
  bad({ from: "2026-10-01T00:00:00Z", to: "2026-10-01T00:00:00Z" });
  eq(ok({ format: "csv" }).csv, true, "csv");
  bad({ format: "xlsx" });
  eq(ok({ format: "csv", tz: "America/Chicago" }).tz, "America/Chicago", "a real zone");
  eq(ok({ format: "csv", tz: "Mars/Olympus_Mons" }).tz, "UTC", "an unknown zone falls back to UTC");
  eq(ok({ format: "csv", tz: "UTC'); drop" }).tz, "UTC", "junk falls back to UTC");
  assert(isTimeZone("America/Argentina/Buenos_Aires") && isTimeZone("Etc/GMT+5"), "real zones with / + _ are accepted");
});

// ── 5. Rows and money ──────────────────────────────────────────────────────────────────────
const raw = (over: Partial<LedgerRaw>): LedgerRaw => ({
  id: 7, created_at: "2026-10-02T19:05:00.000Z", kind: "debit", meter_kind: "voice_minute", state: "posted",
  memo: "Outbound call to (555) 010-0001 · 2 min", amount_cents: -2, balance_after_cents: 2498,
  amount_exact_micros: -28_000, balance_after_exact_micros: 24_972_000, ...over,
});

Deno.test("a call line is precise, carries both amounts, and names its chip", () => {
  eq(toLedgerRow(raw({})), {
    id: 7, created_at: "2026-10-02T19:05:00.000Z", description: "Outbound call to (555) 010-0001 · 2 min", kind: "debit",
    category: "calls", pending: false, amount_cents: -2, amount_exact_micros: -28_000,
    balance_after_cents: 2498, balance_after_exact_micros: 24_972_000, precise: true,
  }, "call row");
});

Deno.test("whole-cent lines show two places; sub-cent ones four; pre-259 rows never claim precision", () => {
  const topup = toLedgerRow(raw({ kind: "topup", meter_kind: null, memo: "Card top-up", amount_cents: 10000, amount_exact_micros: 100_000_000 }));
  eq([topup.category, topup.precise], ["funds", false], "a top-up is whole cents");
  const odd = toLedgerRow(raw({ kind: "adjustment", meter_kind: null, memo: null, amount_cents: 0, amount_exact_micros: 4_150 }));
  eq(odd.precise, true, "an amount that is not whole cents is shown exactly, whatever its kind");
  const old = toLedgerRow(raw({ amount_exact_micros: undefined, balance_after_exact_micros: undefined }));
  eq([old.amount_exact_micros, old.balance_after_exact_micros, old.precise], [null, null, false], "a pre-259 call row");
});

Deno.test("a pending 3D hold has no balance yet", () => {
  const r = toLedgerRow(raw({ kind: "debit", meter_kind: "video_3d_generation", state: "held", amount_cents: -2000, amount_exact_micros: -20_000_000 }));
  eq([r.pending, r.balance_after_cents, r.balance_after_exact_micros], [true, null, null], "hold");
});

// A true pair is cents × 10,000 less 259's remainder (under one cent). wallet_capture rewrites a
// 3D hold's cents and nothing refreshes the exact column, so it keeps the hold-time balance.
Deno.test("an exact balance is kept only while it matches the cents beside it", () => {
  eq(exactBalance(2498, 24_972_000), 24_972_000, "a call: 8,000 micros owed");
  eq(exactBalance(2500, 24_990_001), 24_990_001, "the largest remainder the column allows");
  eq(exactBalance(2500, 25_000_000), 25_000_000, "whole cents");
  eq(exactBalance(-4500, -45_000_000), -45_000_000, "below zero");
  eq(exactBalance(798, 9_980_000), null, "a whole cent or more apart is not this line's balance");
  eq(exactBalance(798, null), null, "no exact value");
  eq(exactBalance(null, 9_980_000), null, "nothing to check it against");
});

Deno.test("a captured 3D hold shows the balance capture wrote, not the one it was held against", () => {
  // Held on a $10.00 wallet (the trigger stamped 10,000,000); a call took 2¢ while the video was
  // read; capture took $2.00 and wrote $7.98. The exact column still says $10.00.
  const r = toLedgerRow(raw({
    id: 9, kind: "debit", meter_kind: "video_3d_generation", state: "posted", memo: null, amount_cents: -200,
    amount_exact_micros: -2_000_000, balance_after_cents: 798, balance_after_exact_micros: 10_000_000,
  }));
  eq([r.pending, r.balance_after_cents, r.balance_after_exact_micros, r.precise], [false, 798, null, false], "captured hold");
  eq(ledgerCsv([r], "UTC").split("\r\n")[1], "2026-10-02 19:05,3D generation from a video,-2.0000,7.98", "the CSV prints the cents");
});

Deno.test("a whole-cent top-up keeps the sub-cent balance it lands on", () => {
  // Three 4,150-micro texts from $10.00 took one cent and owe 2,450 micros; then $25.00 in.
  const r = toLedgerRow(raw({
    kind: "topup", meter_kind: null, memo: "Card top-up", amount_cents: 2500, amount_exact_micros: 25_000_000,
    balance_after_cents: 3499, balance_after_exact_micros: 34_987_550,
  }));
  eq([r.precise, r.balance_after_exact_micros], [false, 34_987_550], "two places for the amount, the exact balance kept");
  eq(ledgerCsv([r], "UTC").split("\r\n")[1], "2026-10-02 19:05,Added funds,25.0000,34.9876", "the CSV's balance");
});

Deno.test("micros print to four places and cents to two, half away from zero, no float drift", () => {
  eq(microsToDecimal(28_000, 4), "0.0280", "$0.028");
  eq(microsToDecimal(-28_000, 4), "-0.0280", "a debit");
  eq(microsToDecimal(-4_150, 4), "-0.0042", "half away from zero");
  eq(microsToDecimal(-40, 4), "0.0000", "no negative zero");
  eq(microsToDecimal(1_234_567_890, 4), "1234.5679", "large");
  eq(microsToDecimal(24_972_000, 2), "24.97", "two places");
  eq(centsToDecimal(-12345), "-123.45", "cents");
  eq(centsToDecimal(5), "0.05", "a nickel");
  // 0.1 + 0.2 territory: 10 cents built from floats would print 0.1000000001 somewhere.
  eq(microsToDecimal(100_000 + 200_000, 4), "0.3000", "integer arithmetic");
});

// ── 6. CSV ─────────────────────────────────────────────────────────────────────────────────
Deno.test("a cell that starts like a formula is defused; a number we formatted is left a number", () => {
  eq(csvCell("=HYPERLINK(\"http://x.test\")"), `"'=HYPERLINK(""http://x.test"")"`, "= formula, quoted for the quotes");
  eq(csvCell("+1+cmd|' /C calc'!A0"), "'+1+cmd|' /C calc'!A0", "+");
  eq(csvCell("-2+3"), "'-2+3", "- that is not a plain number");
  eq(csvCell("@SUM(A1)"), "'@SUM(A1)", "@");
  eq(csvCell("\t=1"), "'\t=1", "tab");
  eq(csvCell("-0.0280"), "-0.0280", "a debit stays summable");
  eq(csvCell("24.9720"), "24.9720", "a balance");
  eq(csvCell("+5"), "'+5", "a signed-plus value is not one of ours, so it is defused");
  eq(csvCell("Text to (555) 010-0001 · 1 segment"), "Text to (555) 010-0001 · 1 segment", "plain text");
  eq(csvCell("a, b"), '"a, b"', "comma");
  eq(csvCell("line\nbreak"), '"line\nbreak"', "newline");
  eq(csvCell(null), "", "null");
});

Deno.test("the export: header, CRLF, local dates, four places, pending lines, an injected memo", () => {
  const rows = [
    toLedgerRow(raw({})),
    toLedgerRow(raw({ id: 6, kind: "topup", meter_kind: null, memo: "Card top-up", amount_cents: 2500, balance_after_cents: 2500, amount_exact_micros: 25_000_000, balance_after_exact_micros: 25_000_000, created_at: "2026-10-01T04:30:00.000Z" })),
    toLedgerRow(raw({ id: 5, kind: "debit", meter_kind: "video_3d_generation", state: "held", amount_cents: -2000, amount_exact_micros: -20_000_000 })),
    toLedgerRow(raw({ id: 4, kind: "adjustment", meter_kind: null, memo: "=1+1", amount_cents: -100, amount_exact_micros: null, balance_after_cents: 0, balance_after_exact_micros: null })),
  ];
  const csv = ledgerCsv(rows, "America/Chicago");
  const lines = csv.split("\r\n");
  eq(lines[0], LEDGER_CSV_HEADER.join(","), "header");
  eq(LEDGER_CSV_HEADER, ["Date", "Description", "Amount", "Balance"], "the columns Carolyn asked for");
  eq(lines[1], "2026-10-02 14:05,Outbound call to (555) 010-0001 · 2 min,-0.0280,24.9720", "a call, in Chicago time");
  eq(lines[2], "2026-09-30 23:30,Added funds,25.0000,25.0000", "a top-up the evening before, local day");
  eq(lines[3], "2026-10-02 14:05,3D generation from a video (pending),-20.0000,", "pending: no balance");
  eq(lines[4], "2026-10-02 14:05,Adjustment — =1+1,-1.00,0.00", "a pre-259 row has two places; the label prefix defuses the memo");
  eq(lines.length, 6, "one line per row plus the header and a final CRLF");
  eq(lines[5], "", "ends with CRLF");
  assert(!/\r(?!\n)|(?<!\r)\n/.test(csv), "a bare CR or LF in the file");
});

Deno.test("dates fall back to UTC when the zone cannot be used", () => {
  eq(ledgerDate("2026-10-02T19:05:00.000Z", "UTC"), "2026-10-02 19:05", "UTC");
  eq(ledgerDate("2026-10-02T00:05:00.000Z", "UTC"), "2026-10-02 00:05", "midnight is 00, not 24");
  eq(ledgerDate("not a date", "UTC"), "", "garbage");
});

// Keep the filter type honest: a chip added to the list without a category would make All more
// than the sum of the chips.
Deno.test("the chip list is All plus exactly the four categories", () => {
  const chips: LedgerFilter[] = [...LEDGER_FILTERS];
  eq(chips, ["all", "calls", "texts", "funds", "other"], "chips");
});
