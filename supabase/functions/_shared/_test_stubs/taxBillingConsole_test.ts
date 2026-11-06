// Sales tax lookups, operator side (2026-10-21, migration 319): admin-catalog's tax_usage_get and
// tax_charge_retry, driven through the SHIPPED handler (the deleteClientHarness idiom: Deno.serve
// stubbed at import, the import map's supabase stub routing every table and rpc into the fake
// below, no --allow-net).
//
// What is pinned:
//   * both actions are on the MONEY grant: an operator with can_write but not can_bill is refused
//     before any ledger read, and neither is a read-only action (source checks, phoneBillingGate's
//     idiom);
//   * tax_usage_get reports per builder from tax_lookups over the range asked for, with each
//     builder's tax_lookup_enabled switch and the meters' state; a bad range is a 400 sentence;
//   * tax_charge_retry needs confirm: true, is REFUSED 409 while a candidate's meter is disarmed
//     (the live state: nothing replayed, nothing written), replays an error row on the SAME ledger
//     key at the SAME price when armed, links a debit that already posted instead of charging,
//     skips a deleted builder's rows, and writes its own audit row either way;
//   * delete_client closes the builder's charges still waiting on a retry, before the wallet goes.
// Tenants and ids are made up (the repo is public).

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert@1";
import { stubAuth, stubDb, stubRpc } from "./supabase_stub.ts";
import { deleteClient, loadAdminCatalog } from "./deleteClientHarness.ts";

const HANDLER = await loadAdminCatalog(false);
const ADMIN_PASSWORD = "admin-password-test";
const ENV: Record<string, string> = {
  SUPABASE_URL: "https://project.example.test", SUPABASE_ANON_KEY: "anon-test", SUPABASE_SERVICE_ROLE_KEY: "service-role-test", ADMIN_PASSWORD,
};
const OPERATOR = "00000000-0000-4000-8000-00000000f0f0";
const L1 = "00000000-0000-4000-8000-000000000319";
const L2 = "00000000-0000-4000-8000-000000000320";

type Row = Record<string, any>;
class Db {
  lookups: Row[] = [
    { id: L1, client_id: "acme-sheds", kind: "verify", outcome: "ok", charge_state: "error", charge_cents: 10, short_code: "SS-AAAA1111", invoice_number: null, region: "OH", called_at: "2026-10-10T12:00:00.000Z" },
    { id: L2, client_id: "acme-sheds", kind: "invoice", outcome: "ok", charge_state: "inactive", charge_cents: null, short_code: "SS-AAAA1111", invoice_number: "1042", region: "OH", called_at: "2026-10-11T12:00:00.000Z" },
    { id: "00000000-0000-4000-8000-000000000321", client_id: "_platform", kind: "ping", outcome: "ok", charge_state: null, called_at: "2026-10-12T12:00:00.000Z" },
    { id: "00000000-0000-4000-8000-000000000322", client_id: "acme-sheds", kind: "verify", outcome: "ok", charge_state: "inactive", called_at: "2026-09-01T12:00:00.000Z" },
  ];
  prices: Row[] = [{ kind: "tax_lookup", active: false, price_cents: 0 }, { kind: "tax_invoice", active: false, price_cents: 0 }];
  operator: Row | null = null;
  audits: Row[] = [];
  reads: string[] = [];
  credits: Row[] = [];
  wallet: Row[] = [];

  from(table: string) {
    // deno-lint-ignore no-this-alias
    const db = this;
    const q: { op: string; patch?: Row; f: ((r: Row) => boolean)[]; lim?: number } = { op: "select", f: [] };
    const rows = (): Row[] => {
      if (table === "tax_lookups") return db.lookups;
      if (table === "usage_prices") return db.prices;
      if (table === "client_settings") return [
        { client_id: "acme-sheds", tax_lookup_enabled: true, invoice_in_ghl: false, billing_exempt: false },
        { client_id: "quiet-barns", tax_lookup_enabled: true, invoice_in_ghl: false, billing_exempt: false },
        { client_id: "off-barns", tax_lookup_enabled: false, invoice_in_ghl: true, billing_exempt: false },
      ];
      if (table === "client_configs") return [{ client_id: "acme-sheds", company_name: "Acme Sheds" }, { client_id: "quiet-barns", company_name: "Quiet Barns" }];
      if (table === "wallet_accounts") return [];
      if (table === "wallet_transactions") return db.wallet;
      if (table === "app_operators") return db.operator ? [db.operator] : [];
      return [];
    };
    const run = (single: boolean) => {
      if (q.op === "select") db.reads.push(table);
      if (table === "admin_audit" && q.op === "insert") { db.audits.push(q.patch!); return { data: null, error: null }; }
      if (table === "admin_auth_attempts") return { data: null, error: null };
      const hit = rows().filter((r) => q.f.every((fn) => fn(r))).slice(0, q.lim ?? 1000);
      if (q.op === "update") {
        for (const r of hit) Object.assign(r, q.patch);
        return { data: hit.map((r) => ({ id: r.id })), error: null };
      }
      return { data: single ? (hit[0] ?? null) : hit.map((r) => ({ ...r })), error: null };
    };
    const b: any = {
      select: () => b,
      insert: (p: Row) => { q.op = "insert"; q.patch = p; return b; },
      update: (p: Row) => { q.op = "update"; q.patch = p; return b; },
      eq: (c: string, v: unknown) => { q.f.push((r) => r[c] === v); return b; },
      in: (c: string, v: unknown[]) => { q.f.push((r) => v.includes(r[c])); return b; },
      is: (c: string, v: unknown) => { q.f.push((r) => (r[c] ?? null) === v); return b; },
      gte: (c: string, v: string) => { q.f.push((r) => String(r[c]) >= v); return b; },
      lt: (c: string, v: string) => { q.f.push((r) => String(r[c]) < v); return b; },
      not: (c: string, op: string, v: unknown) => { q.f.push((r) => (op === "is" && v === null ? r[c] != null : true)); return b; },
      or: () => { q.f.push((r) => r.charge_state == null || r.charge_state === "pending" || r.charge_state === "error"); return b; },
      order: () => b,
      limit: (n: number) => { q.lim = n; return b; },
      range: (a: number, z: number) => { q.lim = z - a + 1; return b; },
      maybeSingle: () => Promise.resolve(run(true)),
      single: () => Promise.resolve(run(true)),
      then: (res: any, rej: any) => Promise.resolve(run(false)).then(res, rej),
    };
    return b;
  }

  rpc(fn: string, args: Row) {
    if (fn === "wallet_credit") {
      this.credits.push(args);
      const existing = this.wallet.find((w) => w.idempotency_key === args.p_idem);
      if (!existing) this.wallet.push({ id: 900 + this.wallet.length, client_id: args.p_client_id, idempotency_key: args.p_idem, state: "posted" });
      return Promise.resolve({ data: 990, error: null });
    }
    return Promise.reject(new Error(`unexpected rpc ${fn}`));
  }
}

async function act(db: Db, body: Record<string, unknown>, as: "password" | { canWrite: boolean; canBill: boolean } = "password") {
  const prior = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  stubDb.from = (t: string) => db.from(t);
  stubRpc.rpc = (fn: string, a?: any) => db.rpc(fn, a ?? {});
  const headers: Record<string, string> = { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.9" };
  if (as !== "password") {
    db.operator = { user_id: OPERATOR, email: "op@example.test", can_write: as.canWrite, can_bill: as.canBill, support_only: false };
    stubAuth.user = { id: OPERATOR, email: "op@example.test" };
    stubAuth.error = null;
    headers.Authorization = "Bearer operator-jwt";
  }
  try {
    const res = await HANDLER(new Request("http://localhost/functions/v1/admin-catalog", {
      method: "POST", headers,
      body: JSON.stringify({ ...(as === "password" ? { adminPassword: ADMIN_PASSWORD } : {}), ...body }),
    }));
    const raw = await res.text();
    return { status: res.status, body: JSON.parse(raw), raw };
  } finally {
    stubDb.from = null;
    stubRpc.rpc = null;
    stubAuth.user = null;
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
  }
}

// ── the money grant ────────────────────────────────────────────────────────────────────────
Deno.test("an operator without can_bill is refused both actions before any ledger read", async () => {
  for (const action of ["tax_usage_get", "tax_charge_retry"]) {
    const db = new Db();
    const r = await act(db, { action, confirm: true }, { canWrite: true, canBill: false });
    assertEquals(r.status, 403, r.raw);
    assertEquals(r.body.error, "This operator account cannot see or change sales tax billing.");
    assert(!db.reads.includes("tax_lookups"), `${action}: the ledger was read before the refusal`);
  }
  const db = new Db();
  const ok = await act(db, { action: "tax_usage_get", from: "2026-10-01", to: "2026-10-21" }, { canWrite: true, canBill: true });
  assertEquals(ok.status, 200, ok.raw);
});

Deno.test("both actions are on the money gate in the source, and neither is read-only", async () => {
  const code = (s: string) => s.replace(/\r\n/g, "\n").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");
  const src = code(await Deno.readTextFile(new URL("../../admin-catalog/index.ts", import.meta.url)));
  const setOf = (name: string) => [...(new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]`).exec(src)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const handled = [...src.matchAll(/case "(tax_(?:usage|charge)_[a-z_]+)":/g)].map((m) => m[1]);
  assertEquals(handled.sort(), ["tax_charge_retry", "tax_usage_get"]);
  for (const a of handled) {
    assert(setOf("TAX_BILLING_ACTIONS").includes(a), `${a} is not on TAX_BILLING_ACTIONS`);
    assert(!setOf("READ_ONLY_ACTIONS").includes(a), `${a} is on READ_ONLY_ACTIONS`);
  }
  const check = src.indexOf('TAX_BILLING_ACTIONS.has(String(action ?? "")) && !identity.canBill');
  const gate = src.indexOf('identity.via === "operator" && !READ_ONLY_ACTIONS.has(');
  assert(check > gate && gate > 0 && src.indexOf("switch (action)") > check, "the can_bill check is not inside the operator gate, before the switch");
});

// ── tax_usage_get ──────────────────────────────────────────────────────────────────────────
Deno.test("tax_usage_get: per builder over the range, with the switch and the meters", async () => {
  const db = new Db();
  const r = await act(db, { action: "tax_usage_get", from: "2026-10-01", to: "2026-10-21" });
  assertEquals(r.status, 200, r.raw);
  assertEquals(r.body.range, { from: "2026-10-01", to: "2026-10-21", days: 21 });
  assertEquals(r.body.tenants.map((t: any) => [t.clientId, t.companyName, t.calls, t.lookupEnabled]),
    [["acme-sheds", "Acme Sheds", 2, true], ["quiet-barns", "Quiet Barns", 0, true]],
    "September's row is outside the range; the ping is nobody's; a switched-off builder with no calls is not listed");
  const a = r.body.tenants[0];
  assertEquals([a.verify, a.invoice, a.errors, a.inactive, a.charged], [1, 1, 1, 1, 0]);
  assertEquals(r.body.platform, { pings: 1, pingsFailed: 0 });
  assertEquals(r.body.meters.map((m: any) => [m.kind, m.armed]), [["tax_lookup", false], ["tax_invoice", false]]);
  assertEquals(db.credits.length, 0, "a report charges nobody");
});

Deno.test("tax_usage_get: a range it cannot read is a 400 sentence", async () => {
  const r = await act(new Db(), { action: "tax_usage_get", from: "2026-10-21", to: "2026-10-01" });
  assertEquals([r.status, r.body.error], [400, "The start date must be on or before the end date."]);
});

// ── tax_charge_retry ───────────────────────────────────────────────────────────────────────
Deno.test("tax_charge_retry: asks for confirm: true before anything", async () => {
  const db = new Db();
  const r = await act(db, { action: "tax_charge_retry" });
  assertEquals(r.status, 400, r.raw);
  assert(/confirm: true/.test(r.body.error), r.body.error);
  assertEquals([db.credits.length, db.audits.filter((x) => x.action === "tax_charge_retry").length], [0, 0]);
});

Deno.test("tax_charge_retry: REFUSED 409 while the meter is disarmed — nothing replayed, nothing written, audited", async () => {
  const db = new Db();
  const r = await act(db, { action: "tax_charge_retry", confirm: true });
  assertEquals(r.status, 409, r.raw);
  assertEquals([r.body.reason, r.body.candidates], ["meter_disarmed", 1]);
  assert(/Tax verification meter is off/.test(r.body.error), r.body.error);
  assertEquals(db.credits.length, 0);
  assertEquals(db.lookups[0].charge_state, "error", "the failed charge stays recorded as failed");
  const audit = db.audits.find((x) => x.action === "tax_charge_retry");
  assert(audit && audit.note === "via=password refused=meter_disarmed linked=0 orphaned=0", JSON.stringify(db.audits));
});

Deno.test("tax_charge_retry: armed, the error row is replayed on its OWN key and recorded charged", async () => {
  const db = new Db();
  db.prices = [{ kind: "tax_lookup", active: true, price_cents: 10 }, { kind: "tax_invoice", active: true, price_cents: 10 }];
  const r = await act(db, { action: "tax_charge_retry", confirm: true, clientId: "acme-sheds" });
  assertEquals(r.status, 200, r.raw);
  assertEquals([r.body.candidates, r.body.charged, r.body.stillFailed], [1, 1, 0]);
  assertEquals(db.credits.map((c) => [c.p_idem, c.p_meter_kind, c.p_amount_cents]), [[`tax_ledger:tax_lookup:${L1}`, "tax_lookup", -10]]);
  assertEquals([db.lookups[0].charge_state, db.lookups[0].charge_cents, db.lookups[0].wallet_tx_id], ["charged", 10, 900]);
  assertEquals(db.lookups[1].charge_state, "inactive", "a row that is not waiting on its charge is not touched");
  const audit = db.audits.find((x) => x.action === "tax_charge_retry");
  assert(audit && audit.target_client_id === "acme-sheds"
    && audit.note === "via=password candidates=1 charged=1 linked=0 exempt=0 still_failed=0 price_changed=0 orphaned=0", JSON.stringify(audit));
  // Pressed again: nothing left to do, nothing charged twice.
  const again = await act(db, { action: "tax_charge_retry", confirm: true });
  assertEquals([again.status, again.body.candidates], [200, 0]);
  assertEquals(db.credits.length, 1);
});

Deno.test("tax_charge_retry: a debit that already posted is linked, with the meters still OFF, and nothing is charged", async () => {
  const db = new Db();   // the live meters: disarmed
  db.wallet = [{ id: 77, client_id: "acme-sheds", idempotency_key: `tax_ledger:tax_lookup:${L1}`, state: "posted", amount_cents: -10, posted_at: "2026-10-10T12:00:05.000Z" }];
  const r = await act(db, { action: "tax_charge_retry", confirm: true });
  assertEquals(r.status, 200, r.raw);
  assertEquals([r.body.candidates, r.body.linked, r.body.charged], [1, 1, 0]);
  assertEquals(db.credits.length, 0, "the charge path never ran");
  assertEquals([db.lookups[0].charge_state, db.lookups[0].charge_cents, db.lookups[0].wallet_tx_id, db.lookups[0].charged_at],
    ["charged", 10, 77, "2026-10-10T12:00:05.000Z"]);
});

Deno.test("tax_charge_retry: a deleted builder's failed charge is orphaned, never replayed into a new wallet", async () => {
  const db = new Db();
  db.prices = [{ kind: "tax_lookup", active: true, price_cents: 10 }, { kind: "tax_invoice", active: true, price_cents: 10 }];
  db.lookups[0].client_id = "gone-barns";   // no client_configs row: delete_client ran
  const r = await act(db, { action: "tax_charge_retry", confirm: true });
  assertEquals(r.status, 200, r.raw);
  assertEquals([r.body.candidates, r.body.orphaned, r.body.charged], [1, 1, 0]);
  assertEquals(db.credits.length, 0);
  assertEquals(db.lookups[0].charge_state, "error", "left as it was, for a person");
});

Deno.test("tax_charge_retry: a meter repriced since the attempt is not replayed at the new price", async () => {
  const db = new Db();
  db.prices = [{ kind: "tax_lookup", active: true, price_cents: 25 }, { kind: "tax_invoice", active: true, price_cents: 25 }];
  const r = await act(db, { action: "tax_charge_retry", confirm: true });
  assertEquals(r.status, 200, r.raw);
  assertEquals([r.body.priceChanged, r.body.charged], [1, 0]);
  assertEquals(db.credits.length, 0, "never a price the builder did not see when they pressed Verify");
});

Deno.test("delete_client closes the builder's tax charges still waiting on a retry, before the purge takes the wallet", async () => {
  const r = await deleteClient(HANDLER, { subs: [], vault: null, taxOpenCharges: 2 });
  assertEquals(r.status, 200, r.raw);
  assertEquals(r.body.taxChargesClosed, 2, "reported, as a count");
  const close = r.updates.filter((u) => u.table === "tax_lookups");
  assertEquals(close.length, 1);
  assertEquals(close[0].payload, { charge_state: "error", charge_cents: null, wallet_tx_id: null, charged_at: null }, "an error with no price: never replayed");
  assertEquals(close[0].filters, [["eq", "client_id", "acme-sheds"], ["in", "charge_state", ["pending", "error"]]]);
  // Since migration 321 the wallet goes with everything else in tenant_purge's one transaction.
  const at = r.log.indexOf("db update tax_lookups");
  assert(at > 0 && at < r.log.indexOf("db rpc tenant_purge"), `the close runs before the purge takes the wallet: ${r.log.join(" | ")}`);
  // Nothing to close is not a report line; and a database without 319 does not stop the delete.
  const none = await deleteClient(HANDLER, { subs: [], vault: null });
  assertEquals([none.status, "taxChargesClosed" in none.body], [200, false], none.raw);
});
