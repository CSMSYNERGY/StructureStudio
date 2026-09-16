// Deliberately dependency-free (no jsr:/npm: imports) so this suite still runs on a machine
// with no registry access — the same rule the other _shared tests follow.
//
// The ledger is the SPEND CAP for Avalara calls, so the failures that matter are the quiet
// ones: a count that cannot be read and is treated as zero, an insert that failed and is
// treated as written, a finished row that a second callback rewrites. Every one of those lets
// calls through that nothing counted. Most of the effort below is on those paths.

import {
  countLookups24h,
  DAILY_TAX_LOOKUP_CAP,
  finishedColumns,
  finishLookup,
  insertLookup,
  PING_CLIENT_ID,
  pingResponse,
} from "./taxLookups.ts";
import { pingAvalara } from "./salesTax.ts";
import type { AvalaraPing, AvalaraResult } from "./salesTax.ts";

const assertEquals = (a: unknown, b: unknown, msg?: string) => {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(msg ? `${msg}: ${sa} !== ${sb}` : `${sa} !== ${sb}`);
};
const assert = (cond: unknown, msg = "assertion failed") => {
  if (!cond) throw new Error(msg);
};

const ROW_ID = "3f0c2b1e-8a4d-4c2e-9b7a-1d2e3f4a5b6c";
const USER_ID = "0b6f7c1d-2e3a-4b5c-8d9e-0f1a2b3c4d5e";

/** A service-role client stub: records every builder call, resolves to one canned answer. */
function makeAdmin(answer: { data?: unknown; error?: unknown; count?: unknown }) {
  const ops: unknown[][] = [];
  // deno-lint-ignore no-explicit-any
  const chain: any = {};
  for (const m of ["insert", "update", "select", "eq", "is", "in", "gt", "single"]) {
    chain[m] = (...args: unknown[]) => { ops.push([m, ...args]); return chain; };
  }
  chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve({ data: null, error: null, count: null, ...answer }).then(resolve, reject);
  const admin = { from(table: string) { ops.push(["from", table]); return chain; } };
  return { admin, ops };
}
const throwingAdmin = { from() { throw new Error("network"); } };
const op = (ops: unknown[][], name: string) => ops.find((o) => o[0] === name);

// ── insertLookup: the row IS the cap ─────────────────────────────────────────────────────

Deno.test("insertLookup writes the in-flight row and returns its id", async () => {
  const { admin, ops } = makeAdmin({ data: { id: ROW_ID } });
  const id = await insertLookup(admin, {
    clientId: "acme", kind: "verify", shortCode: "SS-ABCDEFGH", actorUserId: USER_ID,
    operator: true, region: "MO", postalCode: "63090",
  });
  assertEquals(id, ROW_ID);
  assertEquals(op(ops, "from"), ["from", "tax_lookups"]);
  assertEquals(op(ops, "insert"), ["insert", {
    client_id: "acme", kind: "verify", short_code: "SS-ABCDEFGH", invoice_number: null,
    actor_user_id: USER_ID, operator: true, region: "MO", postal_code: "63090",
  }]);
});

Deno.test("insertLookup clips free text to the migration's lengths instead of failing the insert", async () => {
  const { admin, ops } = makeAdmin({ data: { id: ROW_ID } });
  await insertLookup(admin, {
    clientId: "acme", kind: "invoice", shortCode: "S".repeat(100), invoiceNumber: 1042,
    region: "R".repeat(30), postalCode: "  63090-1234-EXTRA-LONG  ", actorUserId: "not-a-uuid",
  });
  const row = (op(ops, "insert") as [string, Record<string, unknown>])[1];
  assertEquals([String(row.short_code).length, row.invoice_number, String(row.region).length, row.postal_code],
    [64, "1042", 16, "63090-1234-EXTRA"]);
  assertEquals(row.actor_user_id, null, "a non-UUID actor is stored as null, not refused");
  assertEquals(row.operator, false, "operator is strictly boolean");
});

Deno.test("insertLookup returns null — so the caller refuses — on every failure", async () => {
  for (const answer of [{ error: { message: "boom" } }, { data: null }, { data: { id: 42 } }]) {
    const { admin } = makeAdmin(answer);
    assertEquals(await insertLookup(admin, { clientId: "acme", kind: "verify" }), null, JSON.stringify(answer));
  }
  assertEquals(await insertLookup(throwingAdmin, { clientId: "acme", kind: "verify" }), null, "thrown client");
});

Deno.test("insertLookup refuses a row it could never count, without writing", async () => {
  for (const row of [
    { clientId: "", kind: "verify" },
    // deno-lint-ignore no-explicit-any
    { clientId: "acme", kind: "estimate" as any },
  ]) {
    const { admin, ops } = makeAdmin({ data: { id: ROW_ID } });
    assertEquals(await insertLookup(admin, row), null, JSON.stringify(row));
    assertEquals(ops.length, 0, "no write for an uncountable row");
  }
});

// ── finishLookup: a row closes once, with what really happened ───────────────────────────

const okResult: AvalaraResult = { ok: true, rate: 0.0725, jurisdiction: "BIBB, GA", httpStatus: 200, attempts: 1, failure: null };

Deno.test("finishedColumns: an ok lookup carries its rate, jurisdiction, status and attempts", () => {
  assertEquals(finishedColumns(okResult),
    { outcome: "ok", http_status: 200, attempts: 1, rate: 0.0725, jurisdiction: "BIBB, GA" });
});

Deno.test("finishedColumns: every failure kind lands as its own outcome, with no rate", () => {
  const kinds = ["credentials_rejected", "subscription", "bad_address", "rate_limited", "timeout", "network", "malformed"] as const;
  for (const failure of kinds) {
    const r: AvalaraResult = { ok: false, rate: null, jurisdiction: null, httpStatus: failure === "timeout" ? null : 503, attempts: 2, failure };
    assertEquals(finishedColumns(r),
      { outcome: failure, http_status: failure === "timeout" ? null : 503, attempts: 2, rate: null, jurisdiction: null }, failure);
  }
});

Deno.test("finishedColumns: not configured is zero attempts and no status", () => {
  assertEquals(finishedColumns("not_configured"),
    { outcome: "not_configured", http_status: null, attempts: 0, rate: null, jurisdiction: null });
});

Deno.test("finishedColumns: values the CHECKs would refuse are nulled or clamped, never sent", () => {
  const cols = finishedColumns({ ...okResult, httpStatus: 42, attempts: 99, rate: 7.25, jurisdiction: "J".repeat(300) });
  assertEquals([cols.http_status, cols.attempts, cols.rate, String(cols.jurisdiction).length], [null, 10, null, 200]);
});

Deno.test("finishedColumns: a ping maps to ok / credentials_rejected / network / not_configured", () => {
  const ping = (authenticated: boolean, httpStatus: number | null, configured = true) =>
    finishedColumns({ configured, authenticated, authenticationType: null, httpStatus });
  assertEquals(ping(true, 200).outcome, "ok");
  assertEquals(ping(false, 200).outcome, "credentials_rejected", "ping answers a wrong key with 200 + false");
  assertEquals(ping(false, 401).outcome, "credentials_rejected");
  assertEquals(ping(false, 429).outcome, "rate_limited");
  assertEquals(ping(false, 503).outcome, "network");
  assertEquals(ping(false, null).outcome, "network");
  assertEquals(ping(false, null, false), { outcome: "not_configured", http_status: null, attempts: 0, rate: null, jurisdiction: null });
  assertEquals([ping(true, 200).attempts, ping(true, 200).rate], [1, null]);
});

Deno.test("finishLookup closes exactly the in-flight row and stamps finished_at", async () => {
  const { admin, ops } = makeAdmin({ data: [{ id: ROW_ID }] });
  assertEquals(await finishLookup(admin, ROW_ID, okResult), true);
  const patch = (op(ops, "update") as [string, Record<string, unknown>])[1];
  assertEquals([patch.outcome, patch.rate, patch.attempts], ["ok", 0.0725, 1]);
  assert(typeof patch.finished_at === "string" && !Number.isNaN(Date.parse(patch.finished_at as string)), "finished_at is a timestamp");
  assertEquals(op(ops, "eq"), ["eq", "id", ROW_ID]);
  assertEquals(op(ops, "is"), ["is", "finished_at", null], "only an in-flight row may be closed");
});

Deno.test("finishLookup reports false for an already-closed row, an error, a bad id or a thrown client", async () => {
  assertEquals(await finishLookup(makeAdmin({ data: [] }).admin, ROW_ID, okResult), false, "already finished");
  assertEquals(await finishLookup(makeAdmin({ error: { message: "boom" } }).admin, ROW_ID, okResult), false, "error");
  const bad = makeAdmin({ data: [{ id: ROW_ID }] });
  assertEquals(await finishLookup(bad.admin, "", okResult), false, "empty id");
  assertEquals(bad.ops.length, 0, "no write without a row id — an unscoped update would close every row");
  assertEquals(await finishLookup(throwingAdmin, ROW_ID, okResult), false, "thrown client");
});

// ── countLookups24h: fails CLOSED ──────────────────────────────────────────────────────────

Deno.test("the daily cap is 100", () => {
  assertEquals(DAILY_TAX_LOOKUP_CAP, 100);
});

Deno.test("countLookups24h counts this tenant's verify + invoice rows over the last 24 hours", async () => {
  const { admin, ops } = makeAdmin({ count: 37 });
  const before = Date.now();
  assertEquals(await countLookups24h(admin, "acme"), 37);
  assertEquals(op(ops, "select"), ["select", "id", { count: "exact", head: true }]);
  assertEquals(op(ops, "eq"), ["eq", "client_id", "acme"]);
  assertEquals(op(ops, "in"), ["in", "kind", ["verify", "invoice"]], "pings spend no builder's allowance");
  const since = Date.parse((op(ops, "gt") as unknown[])[2] as string);
  const hours = (before - since) / 3_600_000;
  assert(hours > 23.99 && hours < 24.01, `window is 24h, got ${hours}`);
  assertEquals((op(ops, "gt") as unknown[])[1], "called_at");
});

Deno.test("countLookups24h returns null — so the caller REFUSES — whenever it cannot count", async () => {
  // A blind zero here is an uncapped run of billed calls. Null is the only honest answer.
  for (const answer of [{ error: { message: "boom" }, count: 0 }, { count: null }, { count: "12" }, { count: NaN }]) {
    assertEquals(await countLookups24h(makeAdmin(answer).admin, "acme"), null, JSON.stringify(answer));
  }
  assertEquals(await countLookups24h(throwingAdmin, "acme"), null, "thrown client");
  const empty = makeAdmin({ count: 0 });
  assertEquals(await countLookups24h(empty.admin, ""), null, "no tenant");
  assertEquals(empty.ops.length, 0);
});

Deno.test("a zero count is a real zero, not a failure", async () => {
  assertEquals(await countLookups24h(makeAdmin({ count: 0 }).admin, "acme"), 0);
});

// ── The vocabulary matches migration 242 ───────────────────────────────────────────────────
// The outcome and kind lists live in three places: salesTax.ts' AvalaraFailure, this module,
// and the CHECKs in 242. A value the CHECK does not know fails the ledger write at runtime —
// on the finish, after the call was already paid for. Read the SHIPPED migration, not a copy.
// Needs --allow-read (preflight grants it, scoped to the repo); ignored where it is not granted.

const MIGRATION = new URL("../../migrations/242_avalara_tax_lookups.sql", import.meta.url);
const canRead = Deno.permissions.querySync({ name: "read", path: MIGRATION }).state === "granted";

Deno.test({
  name: "every outcome and kind this module can write is allowed by migration 242's CHECKs",
  ignore: !canRead,
  fn: async () => {
    const sql = await Deno.readTextFile(MIGRATION);
    const list = (re: RegExp) => {
      const m = sql.match(re);
      assert(m, `could not find ${re} in 242`);
      return [...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
    };
    const outcomes = list(/outcome is null or outcome in \(([^)]*)\)/);
    const kinds = list(/kind\s+text\s+not null check \(kind in \(([^)]*)\)\)/);

    const failures = ["credentials_rejected", "subscription", "bad_address", "rate_limited", "timeout", "network", "malformed"];
    assertEquals(outcomes, [...failures, "ok", "not_configured"].sort(), "outcome CHECK vs the code's vocabulary");
    assertEquals(kinds, ["invoice", "ping", "verify"], "kind CHECK");

    // And every outcome finishedColumns actually produces is in the list.
    const produced = new Set<string>([
      finishedColumns(okResult).outcome,
      finishedColumns("not_configured").outcome,
      ...failures.map((f) => finishedColumns({ ok: false, rate: null, jurisdiction: null, httpStatus: null, attempts: 1, failure: f as never }).outcome),
      ...[200, 401, 429, 503, null].map((s) => finishedColumns({ configured: true, authenticated: false, authenticationType: null, httpStatus: s }).outcome),
    ]);
    for (const o of produced) assert(outcomes.includes(o), `${o} is not allowed by 242`);
  },
});

// ── The operator ping: what leaves admin-catalog ─────────────────────────────────────────────
// Avalara's ping body names the account id, the user and the user id behind the key. The
// console is told five fields and nothing else — pinned end to end from a stubbed ping body, and
// again against an AvalaraPing that has somehow grown a field, because a spread is the one-word
// edit that would ship the account id to a browser.

const SECRETS = ["2000123456", "ops@example.test", "987654", "test-key", "test-account"];

Deno.test("pingResponse: a real ping body's account id, user and key never reach the response", async () => {
  const saved = ["AVALARA_ACCOUNT_ID", "AVALARA_LICENSE_KEY", "AVALARA_API_BASE"].map((k) => [k, Deno.env.get(k)] as const);
  Deno.env.set("AVALARA_ACCOUNT_ID", "test-account");
  Deno.env.set("AVALARA_LICENSE_KEY", "test-key");
  Deno.env.set("AVALARA_API_BASE", "https://avatax.test");
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls++;
    return Promise.resolve(new Response(JSON.stringify({
      version: "26.9.0", authenticated: true, authenticationType: "AccountIdLicenseKey",
      authenticatedUserName: "ops@example.test", authenticatedUserId: 987654, authenticatedAccountId: 2000123456,
      crmid: "0010000000", licenseKey: "test-key",
    }), { status: 200 }));
  }) as typeof fetch;
  try {
    const out = pingResponse(await pingAvalara());
    assertEquals(calls, 1);
    assertEquals(out, { ok: true, configured: true, authenticated: true, authenticationType: "AccountIdLicenseKey", httpStatus: 200 });
    const wire = JSON.stringify(out);
    for (const secret of SECRETS) assert(!wire.includes(secret), `the response carries ${secret}`);
  } finally {
    globalThis.fetch = original;
    for (const [k, v] of saved) v == null ? Deno.env.delete(k) : Deno.env.set(k, v);
  }
});

Deno.test("pingResponse: a whitelist, not a spread — extra fields, an identity-shaped type and a bad status are dropped", () => {
  const grown = {
    configured: true, authenticated: true, authenticationType: "ops@example.test", httpStatus: 42,
    authenticatedAccountId: 2000123456, authenticatedUserName: "ops@example.test",
  } as unknown as AvalaraPing;
  const out = pingResponse(grown);
  assertEquals(Object.keys(out).sort(), ["authenticated", "authenticationType", "configured", "httpStatus", "ok"]);
  assertEquals([out.authenticationType, out.httpStatus], [null, null]);
  for (const secret of SECRETS) assert(!JSON.stringify(out).includes(secret), `the response carries ${secret}`);

  // Not configured: nothing was asked, so nothing can read as authenticated.
  assertEquals(pingResponse({ configured: false, authenticated: true, authenticationType: "None", httpStatus: null }),
    { ok: true, configured: false, authenticated: false, authenticationType: null, httpStatus: null });
  assertEquals(pingResponse({ configured: true, authenticated: false, authenticationType: "None", httpStatus: 200 }),
    { ok: true, configured: true, authenticated: false, authenticationType: "None", httpStatus: 200 });
});

Deno.test("PING_CLIENT_ID is never a tenant slug, and fits migration 242's client_id CHECK", () => {
  assert(!/^[a-z0-9][a-z0-9-]*$/.test(PING_CLIENT_ID), "a tenant could be created with this slug");
  assert(PING_CLIENT_ID.length >= 1 && PING_CLIENT_ID.length <= 100);
});
