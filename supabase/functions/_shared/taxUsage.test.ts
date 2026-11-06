// What the Avalara lookups cost and who made them (taxUsage.ts, migrations 244 + 319): the
// builder's month in the Sales tax box, and the operator's per-tenant report.
//
// The figures are read off the CALL LEDGER, so these pin that a call is counted whether or not it
// was charged (a disarmed or exempt call is still a call Avalara metered), that an unreadable
// figure is null and never $0, that a ping is never a builder's, and that the range an operator
// picks means what the date fields say. Dependency-free like the other _shared tests.

import {
  monthStartUtc, monthTaxUsage, parseTaxUsageRange, readTaxLookupsInRange, summarizeTaxUsage, TAX_USAGE_COLUMNS,
  TAX_USAGE_COLUMNS_PRE_319, TAX_USAGE_PAGE, type TaxUsageRow,
} from "./taxUsage.ts";

const assert = (cond: unknown, msg = "assertion failed") => {
  if (!cond) throw new Error(msg);
};
const assertEquals = (a: unknown, b: unknown, msg?: string) => {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(msg ? `${msg}: ${sa} !== ${sb}` : `${sa} !== ${sb}`);
};
const throwsWith = (fn: () => unknown, re: RegExp, msg: string) => {
  try { fn(); } catch (e) { assert(re.test((e as Error).message), `${msg}: ${(e as Error).message}`); return; }
  throw new Error(`${msg}: did not throw`);
};

const NOW = new Date("2026-10-21T15:30:00.000Z");

// ── The range ────────────────────────────────────────────────────────────────────────────

Deno.test("the range defaults to this UTC month so far, both ends inclusive", () => {
  assertEquals(monthStartUtc(NOW), "2026-10-01T00:00:00.000Z");
  assertEquals(parseTaxUsageRange({}, NOW), {
    from: "2026-10-01T00:00:00.000Z", to: "2026-10-22T00:00:00.000Z", fromDay: "2026-10-01", toDay: "2026-10-21", days: 21,
  });
  const one = parseTaxUsageRange({ from: "2026-09-30", to: "2026-09-30" }, NOW);
  assertEquals([one.from, one.to, one.days], ["2026-09-30T00:00:00.000Z", "2026-10-01T00:00:00.000Z", 1], "one day is that whole UTC day");
});

Deno.test("a range that cannot be read is refused in a sentence, never guessed", () => {
  throwsWith(() => parseTaxUsageRange({ from: "10/01/2026" }, NOW), /YYYY-MM-DD/, "a US date");
  throwsWith(() => parseTaxUsageRange({ from: "2026-02-31", to: "2026-03-02" }, NOW), /YYYY-MM-DD/, "a day that does not exist");
  throwsWith(() => parseTaxUsageRange({ from: "2026-10-05", to: "2026-10-04" }, NOW), /on or before/, "backwards");
  throwsWith(() => parseTaxUsageRange({ from: "2024-01-01", to: "2026-10-01" }, NOW), /at most 366 days/, "too long");
  assertEquals(parseTaxUsageRange({ from: "2025-10-21", to: "2026-10-21" }, NOW).days, 366, "a year and a day is the most");
});

// ── The report ───────────────────────────────────────────────────────────────────────────

const RANGE = parseTaxUsageRange({}, NOW);
const row = (client_id: string, kind: string, outcome: string | null, charge_state: string | null, charge_cents: number | null = null): TaxUsageRow =>
  ({ client_id, kind, outcome, charge_state, charge_cents, called_at: "2026-10-10T12:00:00Z" });

Deno.test("per builder: calls by kind and outcome, charged count and cents, exempt, errors", () => {
  const out = summarizeTaxUsage({
    range: RANGE,
    rows: [
      row("acme-sheds", "verify", "ok", "charged", 10),
      row("acme-sheds", "invoice", "ok", "charged", 10),
      row("acme-sheds", "invoice", "ok", "error"),
      row("acme-sheds", "verify", "timeout", "no_rate"),
      row("acme-sheds", "verify", "bad_address", null),          // a Verify that failed is never recorded
      row("acme-sheds", "verify", null, null),                   // in flight
      row("demo-barns", "verify", "ok", "exempt"),
      row("demo-barns", "invoice", "ok", "inactive"),
      row("demo-barns", "invoice", "ok", "unpriced"),
      row("demo-barns", "invoice", "ok", "pending"),
      row("_platform", "ping", "ok", null),
      row("_platform", "ping", "credentials_rejected", null),
    ],
    switches: [
      { client_id: "acme-sheds", tax_lookup_enabled: true, invoice_in_ghl: false, billing_exempt: false },
      { client_id: "demo-barns", tax_lookup_enabled: true, invoice_in_ghl: false, billing_exempt: true },
      { client_id: "quiet-sheds", tax_lookup_enabled: true, invoice_in_ghl: false },
      { client_id: "off-barns", tax_lookup_enabled: false, invoice_in_ghl: true },
    ],
    names: new Map([["acme-sheds", "Acme Sheds"], ["demo-barns", "Demo Barns"]]),
    meters: [{ kind: "tax_lookup", active: true, price_cents: 10 }, { kind: "tax_invoice", active: false, price_cents: 10 }],
  });
  assertEquals(out.tenants.map((t) => t.clientId), ["acme-sheds", "demo-barns", "quiet-sheds"],
    "busiest first; a builder switched on with no calls is listed; one switched off with none is not; a ping is nobody's");
  const a = out.tenants[0];
  assertEquals([a.companyName, a.calls, a.verify, a.invoice, a.ok, a.failed, a.inFlight], ["Acme Sheds", 6, 4, 2, 3, 2, 1]);
  assertEquals(a.failures, { timeout: 1, bad_address: 1 });
  assertEquals([a.charged, a.chargedCents, a.errors, a.noRate, a.unstated], [2, 20, 1, 1, 1]);
  assertEquals([a.lookupEnabled, a.ssMode, a.billingExempt], [true, true, false]);
  const d = out.tenants[1];
  assertEquals([d.calls, d.exempt, d.inactive, d.unpriced, d.pending, d.charged, d.billingExempt], [4, 1, 1, 1, 1, 0, true]);
  const q = out.tenants[2];
  assertEquals([q.companyName, q.calls, q.lookupEnabled], ["quiet-sheds", 0, true], "no name on file: the id");
  assertEquals([out.totals.calls, out.totals.charged, out.totals.chargedCents, out.totals.errors, out.totals.pending], [10, 2, 20, 1, 1]);
  assertEquals(out.totals.failures, { timeout: 1, bad_address: 1 });
  assertEquals(out.platform, { pings: 2, pingsFailed: 1 });
  assertEquals(out.meters, [
    { kind: "tax_lookup", exists: true, active: true, priceCents: 10, armed: true },
    { kind: "tax_invoice", exists: true, active: false, priceCents: 10, armed: false },
  ]);
  assertEquals([out.range, out.rowCount, out.truncated, out.chargesUnknown], [{ from: "2026-10-01", to: "2026-10-21", days: 21 }, 12, false, false]);
});

Deno.test("a missing meter row is reported missing, and a bad cents value counts as nothing", () => {
  const out = summarizeTaxUsage({
    range: RANGE, rows: [row("acme-sheds", "verify", "ok", "charged", "abc" as unknown as number)], switches: [], names: new Map(), meters: [],
    pre319: true, truncated: true,
  });
  assertEquals(out.meters.map((m) => [m.exists, m.armed]), [[false, false], [false, false]]);
  assertEquals(out.tenants[0].chargedCents, 0);
  assertEquals([out.chargesUnknown, out.truncated], [true, true]);
});

// ── The reads ────────────────────────────────────────────────────────────────────────────

/** A recording tax_lookups client: `pages` answers each range() call in turn. */
function reader(answers: { data?: unknown[]; error?: unknown; count?: number | null }[]) {
  const chains: unknown[][][] = [];
  let i = 0;
  const admin = {
    from(table: string) {
      const ops: unknown[][] = [["table", table]];
      chains.push(ops);
      // deno-lint-ignore no-explicit-any
      const q: any = {};
      for (const m of ["select", "eq", "in", "gte", "lt", "order", "range"]) q[m] = (...a: unknown[]) => (ops.push([m, ...a]), q);
      q.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => {
        const a = answers[Math.min(i++, answers.length - 1)];
        return Promise.resolve({ data: a.data ?? null, error: a.error ?? null, count: a.count ?? null }).then(ok, bad);
      };
      return q;
    },
  };
  return { admin, chains };
}
const page = (n: number) => Array.from({ length: n }, () => row("acme-sheds", "verify", "ok", "inactive"));

Deno.test("the report reads every page of the range, oldest first, and says when it stopped short", async () => {
  const { admin, chains } = reader([{ data: page(TAX_USAGE_PAGE) }, { data: page(3) }]);
  const r = await readTaxLookupsInRange(admin, RANGE.from, RANGE.to);
  assert(r.ok && r.rows.length === TAX_USAGE_PAGE + 3 && !r.truncated && !r.pre319, JSON.stringify(r).slice(0, 200));
  assertEquals(chains[0], [
    ["table", "tax_lookups"], ["select", TAX_USAGE_COLUMNS], ["gte", "called_at", RANGE.from], ["lt", "called_at", RANGE.to],
    ["order", "called_at", { ascending: true }], ["order", "id", { ascending: true }], ["range", 0, TAX_USAGE_PAGE - 1],
  ], "from inclusive, to exclusive, a stable order to page on");
  assertEquals(chains[1].find((o) => o[0] === "range"), ["range", TAX_USAGE_PAGE, 2 * TAX_USAGE_PAGE - 1]);
  const capped = reader([{ data: page(TAX_USAGE_PAGE) }]);
  const c = await readTaxLookupsInRange(capped.admin, RANGE.from, RANGE.to, 2 * TAX_USAGE_PAGE);
  assert(c.ok && c.truncated && c.rows.length === 2 * TAX_USAGE_PAGE, "stopped at the cap and said so");
});

Deno.test("before migration 319 the report still counts calls, and says charges are unknown", async () => {
  const { admin, chains } = reader([{ error: { code: "42703", message: "column charge_state does not exist" } }, { data: page(2) }]);
  const r = await readTaxLookupsInRange(admin, RANGE.from, RANGE.to);
  assert(r.ok && r.pre319 && r.rows.length === 2, JSON.stringify(r));
  assertEquals(chains[1][1], ["select", TAX_USAGE_COLUMNS_PRE_319]);
  // Any other error is an error, not a fallback.
  const down = reader([{ error: { code: "08006", message: "connection reset" } }]);
  const d = await readTaxLookupsInRange(down.admin, RANGE.from, RANGE.to);
  assert(!d.ok, "a dead database is not an empty report");
  assertEquals(down.chains.length, 1);
});

Deno.test("the builder's month: the cap's rows counted, the charged cents summed, from the 1st (UTC)", async () => {
  const charged = [{ charge_cents: 10 }, { charge_cents: 10 }, { charge_cents: 25 }];
  const { admin, chains } = reader([{ count: 7 }, { data: charged }]);
  const m = await monthTaxUsage(admin, "acme-sheds", NOW);
  assertEquals(m, { monthStart: "2026-10-01T00:00:00.000Z", lookups: 7, spendCents: 45 });
  const countRead = chains.find((c) => c.some((o) => o[0] === "select" && o[1] === "id"))!;
  assertEquals(countRead.filter((o) => o[0] !== "table"), [
    ["select", "id", { count: "exact", head: true }], ["eq", "client_id", "acme-sheds"], ["in", "kind", ["verify", "invoice"]],
    ["gte", "called_at", "2026-10-01T00:00:00.000Z"],
  ]);
  const spendRead = chains.find((c) => c.some((o) => o[0] === "select" && o[1] === "charge_cents"))!;
  assert(spendRead.some((o) => o[0] === "eq" && o[1] === "charge_state" && o[2] === "charged"), "only charged rows are spend");
});

Deno.test("an unreadable month is null, never $0 or 0 lookups", async () => {
  const pre319 = reader([{ count: 3 }, { error: { code: "42703", message: "no column" } }]);
  assertEquals(await monthTaxUsage(pre319.admin, "acme-sheds", NOW), { monthStart: "2026-10-01T00:00:00.000Z", lookups: 3, spendCents: null });
  const down = reader([{ error: { message: "down" } }]);
  assertEquals(await monthTaxUsage(down.admin, "acme-sheds", NOW), { monthStart: "2026-10-01T00:00:00.000Z", lookups: null, spendCents: null });
  const throwing = { from: () => { throw new Error("socket"); } };
  assertEquals(await monthTaxUsage(throwing, "acme-sheds", NOW), { monthStart: "2026-10-01T00:00:00.000Z", lookups: null, spendCents: null });
  assertEquals((await monthTaxUsage(reader([{ count: 1 }]).admin, "", NOW)).lookups, null, "no tenant, no read");
  // More pages than a month can hold is a wrong answer: unknown.
  const flood = reader([{ count: 1 }, { data: Array.from({ length: TAX_USAGE_PAGE }, () => ({ charge_cents: 10 })) }]);
  assertEquals((await monthTaxUsage(flood.admin, "acme-sheds", NOW)).spendCents, null);
});
