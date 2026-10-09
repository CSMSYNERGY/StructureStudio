// The customer's billing name, street and ZIP, driven through the SHIPPED customer-pay handler
// (2026-10, Fiserv certification, workstream 1 phase 1).
//
// WHY THIS EXISTS. The page tests stub the server and the invoicePayment tests call the helpers
// directly, so nothing ran the real handler for the billing change. Held here:
//
//   1. `pay` with billing:"delivery" puts the design contact's street and ZIP on /auth, filled in
//      HERE, and the answer the page gets carries neither (the 048 rule: a payment endpoint does
//      not hand out a contact's address). Whatever was typed for them is ignored.
//   2. `surcharge_probe` with billing:"delivery" asks the gateway with the delivery ZIP, and its
//      answer carries no address either.
//   3. `pay` with a typed street and ZIP sends those (ZIP+4 as nine digits), ecomind "E".
//   4. `pay` from production's page (no billing keys): the contact's name, no street, no ZIP, the
//      auth it always got.
//
// HOW. paymentsMerchantOfRecord_test's idiom: Deno.serve is stubbed while customer-pay/index.ts is
// imported, the import map swaps supabase-js for supabase_stub.ts, stubDb routes every table call
// into the fake below, and globalThis.fetch is the CardPointe gateway and nothing else. No
// --allow-net.
//
// ⚠️ THE IMPORT SPECIFIER IS COMPUTED ON PURPOSE (see aiDraftStreamWiring_test).
//
// Tenants, phones, addresses and merchant ids are made up. The repo is public.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { stubDb } from "./supabase_stub.ts";

const GATEWAY = "https://gateway.example.invalid/cardconnect/rest";
Deno.env.set("CARDPOINTE_BASE_URL", GATEWAY);
Deno.env.set("CARDPOINTE_API_USER", "u");
Deno.env.set("CARDPOINTE_API_PASS", "p");
Deno.env.set("CARDPOINTE_MERCHID", "100200300999");
Deno.env.set("CARDPOINTE_TOKENIZER_BASE", "https://gateway.example.invalid/itoke/ajax-tokenizer.html");

async function load(rel: string): Promise<(req: Request) => Promise<Response>> {
  const realServe = Deno.serve;
  let handler: ((req: Request) => Promise<Response>) | null = null;
  (Deno as any).serve = (h: (req: Request) => Promise<Response>) => {
    handler = h;
    return { finished: Promise.resolve() };
  };
  try {
    await import(new URL(rel, import.meta.url).href);
  } finally {
    (Deno as any).serve = realServe;
  }
  if (!handler) throw new Error(`${rel} did not hand Deno.serve a handler`);
  return handler;
}
const PAY = await load("../../customer-pay/index.ts");

const TENANT = "acme-sheds";
const MID = "100200300400";
const CODE = "SS-AAAAAAAAAA";
const SESSION = "s".repeat(64);
const STREET = "12 Main St";
const ZIP = "12345-6789";
const CONTACT = { name: "Pat Example", phone: "555-555-0101", street: STREET, city: "Springfield", zip: ZIP };

type Trace = {
  gateway: { path: string; body: any; url: URL }[];
  writes: { table: string; verb: string; row: any }[];
};
const eqOf = (ops: any[][], col: string) => (ops.find((o) => o[0] === "eq" && o[1] === col) ?? [])[2];
const argOf = (ops: any[][], op: string) => (ops.find((o) => o[0] === op) ?? []).slice(1);

function answer(trace: Trace, table: string, ops: any[][]): any {
  const verb = ["insert", "update", "delete", "upsert"].find((v) => ops.some((o) => o[0] === v));
  const cols = String(argOf(ops, "select")[0] ?? "");
  if (verb) {
    trace.writes.push({ table, verb, row: argOf(ops, verb)[0] });
    if (verb === "insert" && table === "payment_attempts") return { data: { id: 501 }, error: null };
    if (verb === "insert" && table === "payments") return { data: { id: "pay-new" }, error: null };
    return { data: null, error: null };
  }
  switch (table) {
    case "customer_sessions":
      return { data: { client_id: TENANT, phone_digits: "5555550101", email_lower: null, name: "Pat Example" }, error: null };
    case "client_settings":
      // Non-billable: the test system (no cardpointe_env = uat) takes payments only for such an account.
      return { data: { invoice_in_ghl: false, payments_online_enabled: true, cardpointe_merchid: MID, billing_exempt: true, business_name: "Acme Sheds" }, error: null };
    case "designs":
      // The gate's read carries the contact; readOrderMoney's reads the lines (none: the order total stands).
      return { data: cols.includes("contact") ? { short_code: CODE, status: "invoiced", contact: CONTACT, ss_quote_number: "Q-1", estimate_lines: null } : null, error: null };
    case "invoice_sends":
      return {
        data: { invoice_number: "1001", status: "sent", issued_by: "structurestudio", signed_at: "2026-10-01T10:00:00Z", updated_at: "2026-10-01T10:00:00Z", document_at: "2026-10-01T10:00:00Z", deposit_cents: null },
        error: null,
      };
    case "change_orders":
      return { data: [], error: null };
    case "orders":
      return { data: { id: "o-1", short_code: CODE, total_cents: 100000 }, error: null };
    case "payments":
      return { data: [], error: null };
    case "payment_attempts":
      // No unknown or open attempt, no declines this hour.
      return { data: [], error: null, count: 0 };
    case "app_errors":
      return { data: null, error: null };
  }
  throw new Error(`the fake database has no answer for ${table} ${JSON.stringify(ops)}`);
}

function chain(trace: Trace, table: string, ops: any[][]): any {
  const next = (op: any[]) => chain(trace, table, [...ops, op]);
  const q: any = {};
  for (const m of ["select", "insert", "update", "delete", "upsert", "eq", "neq", "gt", "gte", "lt", "is", "in", "not", "or", "limit", "order", "range", "single", "maybeSingle"]) {
    q[m] = (...a: unknown[]) => next([m, ...a]);
  }
  q.then = (ok: any, bad: any) => Promise.resolve().then(() => answer(trace, table, ops)).then(ok, bad);
  return q;
}

const ENV: Record<string, string> = {
  SUPABASE_URL: "https://stub.supabase.co",
  SUPABASE_ANON_KEY: "stub-anon",
  SUPABASE_SERVICE_ROLE_KEY: "stub-service",
};

async function call(body: Record<string, unknown>) {
  const trace: Trace = { gateway: [], writes: [] };
  const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const realFetch = globalThis.fetch;
  stubDb.from = (table: string) => chain(trace, table, []);
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!href.startsWith(GATEWAY + "/")) return Promise.reject(new Error(`TEST FAILURE: unexpected fetch to ${href}`));
    const url = new URL(href);
    const path = url.pathname.replace(new URL(GATEWAY).pathname, "");
    const sent = init?.body ? JSON.parse(String(init.body)) : null;
    trace.gateway.push({ path, body: sent, url });
    const out = path === "/auth"
      ? { respstat: "A", respcode: "000", retref: "rt-new", amount: "1000.00", token: "9413948780281111", authcode: "123456", avsresp: "Y", cvvresp: "M" }
      : { surcharge: "N" };
    return Promise.resolve(new Response(JSON.stringify(out), { status: 200 }));
  }) as typeof fetch;
  try {
    const res = await PAY(new Request("https://stub.supabase.co/functions/v1/customer-pay", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "harness/1.0" },
      body: JSON.stringify({ token: SESSION, quoteRef: CODE, ...body }),
    }));
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text), trace };
  } finally {
    globalThis.fetch = realFetch;
    stubDb.from = null;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

const authBody = (t: Trace) => (t.gateway.find((g) => g.path === "/auth") ?? { body: null }).body;
const PAY_BODY = { action: "pay", rail: "card", payToken: "9413948780281111", confirmChargeCents: 100000 };
/** Neither the street nor any form of the ZIP may be in what the page reads. */
function noAddressIn(text: string) {
  for (const v of [STREET, "12345", "6789", "Springfield"]) assert(!text.includes(v), `${v} went back to the page: ${text}`);
}

Deno.test("pay, billing:\"delivery\": the server fills the street and ZIP from the estimate, and never sends them back", async () => {
  const r = await call({ ...PAY_BODY, name: "Card Holder", billing: "delivery", address: "999 Typed Rd", postal: "99999" });
  assertEquals(r.status, 200, r.text);
  assertEquals(r.body.ok, true);
  const b = authBody(r.trace);
  // ZIP+4 as nine digits; the typed street and ZIP lose to the box.
  assertEquals([b.name, b.address, b.postal, b.ecomind, b.merchid], ["Card Holder", STREET, "123456789", "E", MID]);
  noAddressIn(r.text);
  const att = r.trace.writes.find((w) => w.table === "payment_attempts" && w.verb === "insert")?.row;
  for (const k of ["address", "name", "postal"]) assert(att?.sent_fields.includes(k), String(att?.sent_fields));
});

Deno.test("surcharge_probe, billing:\"delivery\": asks with the delivery ZIP, and the answer carries no address", async () => {
  const r = await call({ action: "surcharge_probe", payToken: "9413948780281111", billing: "delivery" });
  assertEquals(r.status, 200, r.text);
  const probe = r.trace.gateway.find((g) => g.path === "/surcharge");
  assertEquals(probe?.url.searchParams.get("postal"), "123456789");
  noAddressIn(r.text);
  // A typed ZIP is used as typed (cleaned); a malformed one is left off.
  const typed = await call({ action: "surcharge_probe", payToken: "9413948780281111", postal: " 54321 " });
  assertEquals(typed.trace.gateway[0].url.searchParams.get("postal"), "54321");
  const bad = await call({ action: "surcharge_probe", payToken: "9413948780281111", postal: "5432" });
  assertEquals(bad.trace.gateway[0].url.searchParams.has("postal"), false);
});

Deno.test("pay with a typed street and ZIP: those reach /auth, not the delivery address", async () => {
  const r = await call({ ...PAY_BODY, name: "Card Holder", address: "9 Elm Rd", postal: "54321-0001" });
  assertEquals(r.status, 200, r.text);
  const b = authBody(r.trace);
  assertEquals([b.name, b.address, b.postal, b.ecomind], ["Card Holder", "9 Elm Rd", "543210001", "E"]);
});

Deno.test("pay from production's page (no billing keys): the contact's name, no street, no ZIP", async () => {
  const r = await call(PAY_BODY);
  assertEquals(r.status, 200, r.text);
  const b = authBody(r.trace);
  assertEquals([b.name, "address" in b, "postal" in b, b.ecomind], ["Pat Example", false, false, "E"]);
});
