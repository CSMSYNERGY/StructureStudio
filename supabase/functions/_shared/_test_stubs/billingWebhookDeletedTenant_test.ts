// billing-webhook acks a 0-row update/delete/pause for a DELETED tenant, driven through the SHIPPED
// handler (2026-10-05).
//
// WHY THIS EXISTS. admin-catalog's delete_client now cancels a builder's subscriptions at the
// gateway and then wipes their billing_subscriptions rows. The gateway answers each cancellation
// with its own recurring.subscription.delete, which can never find a row. The webhook throws on a
// 0-row match (on purpose: a delete can arrive before its add, and the retry is what lets it land),
// so without this every deleted paying builder would start the 2026-08-24/25 redelivery storm: a
// 422 and a fault row per attempt, for hours. Pinned here, against the real handler:
//
//   1. All FOUR 0-row sites (update without a status, update with one, delete, pause) ack an event
//      whose order_id is ours (ss_<clientId>_…, or ss_first_…) when no client_configs row exists for
//      that tenant, with the note "ignored: tenant deleted (client_id=…)". The DELETE is quiet: it is
//      the cancellation delete_client asked for. An update or a pause files ONE error row, because it
//      means the gateway still holds a live subscription for a builder who is gone.
//   2. Anything short of that proof keeps the retry: the tenant still exists (the add really has not
//      landed), the client_configs read failed, or there is no order_id at all.
//   3. Foreign events keep their own ack and never cost a client_configs read; neither does an event
//      that found its row.
//   4. The add case still homes a gateway-created subscription from the order_id after
//      ssClientIdOf moved into _shared/billingOrderId.ts.
//
// HOW. The deleteDesignWiring_test idiom: Deno.serve is stubbed while billing-webhook/index.ts is
// imported, so a request goes through withErrorLog, the signature check and the switch as it does
// live. The import map swaps supabase-js for supabase_stub.ts, whose stubDb routes every table call
// into the fake below. The signing key is read at module load, so it is set before the import and
// restored straight after. Tenants and ids are made up (the repo is public).

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { stubDb } from "./supabase_stub.ts";

const SIGNING_KEY = "test-signing-key-not-a-secret";

// ─── The real handler ──────────────────────────────────────────────────────────────────────────
const realServe = Deno.serve;
let handler: ((req: Request) => Promise<Response>) | null = null;
(Deno as any).serve = (h: (req: Request) => Promise<Response>) => {
  handler = h;
  return { finished: Promise.resolve() };
};
const priorKey = Deno.env.get("DEPOSYT_WEBHOOK_SIGNING_KEY");
Deno.env.set("DEPOSYT_WEBHOOK_SIGNING_KEY", SIGNING_KEY);
try {
  await import(new URL("../../billing-webhook/index.ts", import.meta.url).href);
} finally {
  (Deno as any).serve = realServe;
  if (priorKey === undefined) Deno.env.delete("DEPOSYT_WEBHOOK_SIGNING_KEY");
  else Deno.env.set("DEPOSYT_WEBHOOK_SIGNING_KEY", priorKey);
}
if (!handler) throw new Error("billing-webhook did not hand Deno.serve a handler");
const HANDLER = handler as (req: Request) => Promise<Response>;

// ─── A fake database ───────────────────────────────────────────────────────────────────────────
interface Call {
  table: string;
  op: string;
  payload?: any;
  opts?: any;
  filters: [string, string, unknown][];
}
interface World {
  /** What a billing_subscriptions update matches. */
  subRows: number;
  /** client_configs for the tenant the order id names: present, absent, or a failing read. */
  tenant: "exists" | "gone" | "error";
}

function fakeFrom(world: World, trace: Call[]) {
  return (table: string) => {
    const call: Call = { table, op: "select", filters: [] };
    const answer = (): any => {
      trace.push(call);
      switch (`${table}:${call.op}`) {
        case "billing_subscriptions:update":
          return { error: null, count: world.subRows };
        case "client_configs:select":
          if (world.tenant === "error") return { data: null, error: { message: "connection refused" } };
          return { data: world.tenant === "exists" ? { client_id: call.filters[0]?.[2] } : null, error: null };
        default:
          return { data: null, error: null, count: 0 };
      }
    };
    const b: any = {
      select: (_c?: string, o?: any) => { if (call.op === "select") call.opts = o; return b; },
      insert: (p: any) => { call.op = "insert"; call.payload = p; return b; },
      update: (p: any, o?: any) => { call.op = "update"; call.payload = p; call.opts = o; return b; },
      upsert: (p: any, o?: any) => { call.op = "upsert"; call.payload = p; call.opts = o; return b; },
      delete: (o?: any) => { call.op = "delete"; call.opts = o; return b; },
      eq: (c: string, v: unknown) => { call.filters.push(["eq", c, v]); return b; },
      maybeSingle: () => Promise.resolve(answer()),
      then: (res: any, rej: any) => Promise.resolve(answer()).then(res, rej),
    };
    return b;
  };
}

async function hmacHex(key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig)).map((x) => x.toString(16).padStart(2, "0")).join("");
}

let seq = 0;
async function deliver(world: World, type: string, body: Record<string, unknown>) {
  const trace: Call[] = [];
  const eventId = `evt_test_${++seq}`;
  const raw = JSON.stringify({ id: eventId, type, event_body: { subscription_id: "4100000001", ...body } });
  const env = { SUPABASE_URL: "http://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "service-role-test" };
  const prior = Object.fromEntries(Object.keys(env).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
  stubDb.from = fakeFrom(world, trace);
  try {
    const res = await HANDLER(new Request("http://localhost/functions/v1/billing-webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-deposyt-signature": `sha256=${await hmacHex(SIGNING_KEY, raw)}` },
      body: raw,
    }));
    const json = await res.json();
    const status = trace.filter((c) => c.table === "billing_webhook_events" && c.op === "update").map((c) => c.payload).at(-1);
    return {
      status: res.status,
      json,
      trace,
      eventStatus: status?.status as string | undefined,
      eventNote: status?.error as string | null | undefined,
      tenantReads: trace.filter((c) => c.table === "client_configs"),
      faultRows: trace.filter((c) => c.table === "app_errors" && c.op === "insert"),
    };
  } finally {
    stubDb.from = null;
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

// The four 0-row sites, as the gateway would send each.
const ZERO_ROW_SITES: [string, string, Record<string, unknown>][] = [
  ["update, no status", "recurring.subscription.update", {}],
  ["update, with a status", "recurring.subscription.update", { status: "active" }],
  ["delete", "recurring.subscription.delete", {}],
  ["pause", "recurring.subscription.pause", {}],
];
const OURS = "ss_acme-sheds_crm_monthly";
const RETRY = "No billing_subscriptions row for 4100000001 — retry once the add lands";

Deno.test("module registered exactly one handler through Deno.serve", () => {
  assertEquals(typeof handler, "function");
});

Deno.test("all four 0-row sites ACK an event for a deleted tenant, with a note", async () => {
  for (const [label, type, body] of ZERO_ROW_SITES) {
    for (const [orderId, tenant] of [[OURS, "acme-sheds"], ["ss_first_acme-sheds_full_suite_annual", "acme-sheds"]]) {
      const r = await deliver({ subRows: 0, tenant: "gone" }, type, { ...body, order_id: orderId });
      assertEquals(r.status, 200, `${label} / ${orderId}: ${JSON.stringify(r.json)}`);
      assertEquals(r.json, { ok: true, ignored: "tenant deleted" }, label);
      assertEquals(r.eventStatus, "processed", label);
      assertEquals(r.eventNote, `ignored: tenant deleted (client_id=${tenant})`, label);
      assertEquals(r.tenantReads.length, 1, `${label}: one client_configs read`);
      assertEquals(r.tenantReads[0].filters, [["eq", "client_id", tenant]], `${label}: the read is for the tenant the order id names`);
    }
  }
});

Deno.test("a deleted tenant's DELETE is quiet; its update or pause files one error row to cancel it by hand", async () => {
  for (const [label, type, body] of ZERO_ROW_SITES) {
    const r = await deliver({ subRows: 0, tenant: "gone" }, type, { ...body, order_id: OURS });
    assertEquals(r.status, 200, label);
    if (type === "recurring.subscription.delete") {
      assertEquals(r.faultRows.length, 0, `${label}: the cancellation delete_client asked for files nothing`);
      continue;
    }
    assertEquals(r.faultRows.length, 1, `${label}: a live subscription for a deleted builder must be visible`);
    const row = r.faultRows[0].payload;
    assertEquals([row.source, row.severity, row.code, row.client_id], ["edge:billing-webhook", "error", "deleted_tenant_live_subscription", "acme-sheds"], label);
    assertEquals(row.context, { subscription_id: "4100000001", event_type: type }, label);
    assert(/Cancel it in the Deposyt portal\.$/.test(row.message), row.message);
  }
  // An update that itself says the subscription is cancelled is not a live one.
  for (const status of ["cancelled", "canceled", "deleted"]) {
    const r = await deliver({ subRows: 0, tenant: "gone" }, "recurring.subscription.update", { status, order_id: OURS });
    assertEquals([r.status, r.faultRows.length], [200, 0], status);
  }
});

Deno.test("a tenant that still exists keeps the retry: the add has not landed yet", async () => {
  for (const [label, type, body] of ZERO_ROW_SITES) {
    const r = await deliver({ subRows: 0, tenant: "exists" }, type, { ...body, order_id: OURS });
    assertEquals(r.status, 422, label);
    assertEquals(r.json, { error: RETRY }, label);
    assertEquals([r.eventStatus, r.eventNote], ["failed", RETRY], label);
    assertEquals(r.faultRows.length, 1, `${label}: the retry is still a fault row`);
  }
});

Deno.test("a client_configs read that FAILS keeps the retry: no proof, no ack", async () => {
  for (const [label, type, body] of ZERO_ROW_SITES) {
    const r = await deliver({ subRows: 0, tenant: "error" }, type, { ...body, order_id: OURS });
    assertEquals([r.status, r.eventStatus], [422, "failed"], label);
  }
});

Deno.test("no order_id (or one that is not ours) keeps the retry and never reads client_configs", async () => {
  for (const [label, type, body] of ZERO_ROW_SITES) {
    for (const orderId of [undefined, "", "4100009999", "SS_acme-sheds_crm_monthly"]) {
      const r = await deliver({ subRows: 0, tenant: "gone" }, type, orderId === undefined ? body : { ...body, order_id: orderId });
      assertEquals([r.status, r.eventStatus], [422, "failed"], `${label} / ${JSON.stringify(orderId)}`);
      assertEquals(r.tenantReads.length, 0, `${label} / ${JSON.stringify(orderId)}: nothing to look up`);
    }
  }
});

Deno.test("a foreign event keeps its own ack and costs no client_configs read", async () => {
  for (const [label, type, body] of ZERO_ROW_SITES) {
    const orderId = "fu_00000000-0000-4000-8000-000000000002_starter_monthly";
    const r = await deliver({ subRows: 0, tenant: "gone" }, type, { ...body, order_id: orderId });
    assertEquals(r.status, 200, label);
    assertEquals(r.json, { ok: true, ignored: "foreign-product subscription" }, label);
    assertEquals(r.eventNote, `ignored: foreign-product subscription (order_id=${orderId})`, label);
    assertEquals(r.tenantReads.length, 0, label);
  }
});

Deno.test("an event that found its row is processed normally and never asks about the tenant", async () => {
  for (const [label, type, body] of ZERO_ROW_SITES) {
    const r = await deliver({ subRows: 1, tenant: "gone" }, type, { ...body, order_id: OURS });
    assertEquals(r.status, 200, label);
    assertEquals(r.json, { ok: true }, label);
    assertEquals([r.eventStatus, r.eventNote], ["processed", null], label);
    assertEquals(r.tenantReads.length, 0, label);
  }
});

Deno.test("the add still homes a gateway-created subscription from the order id (ssClientIdOf)", async () => {
  const r = await deliver({ subRows: 0, tenant: "exists" }, "recurring.subscription.add", { order_id: "ss_first_acme-sheds_full_suite_annual" });
  assertEquals(r.status, 200, JSON.stringify(r.json));
  const upsert = r.trace.find((c) => c.table === "billing_subscriptions" && c.op === "upsert");
  assert(upsert, "the add wrote the subscription");
  assertEquals(upsert!.payload.client_id, "acme-sheds", "the first_ hop is skipped, the tenant is the slug");
  assertEquals(upsert!.payload.id, "4100000001");
});

Deno.test("source: every 0-row site goes through the one noRow decision", async () => {
  const src = (await Deno.readTextFile(new URL("../../billing-webhook/index.ts", import.meta.url))).replace(/\r\n/g, "\n");
  assertEquals((src.match(/if \(!count\) return await noRow\(\);/g) ?? []).length, 4, "four 0-row sites, each through noRow");
  assertEquals((src.match(/No billing_subscriptions row for/g) ?? []).length, 1, "the retry error is thrown in exactly one place");
  assert(/import \{[^}]*\bssClientIdOf\b[^}]*\} from "\.\.\/_shared\/billingOrderId\.ts";/.test(src), "ssClientIdOf comes from _shared");
  assert(!/\/\^ss_/.test(src), "the order-id regex is not copied back inline");
});

Deno.test("no tenant can be slugged 'first': its order ids would name a different tenant", async () => {
  // ss_first_<plan> is how a tenant called "first" would mint its normal order id, and the
  // first-charge hop reads the plan's first word as the slug. Acked as "tenant deleted", that
  // event would be dropped for good, so create_client refuses the slug instead.
  const { ssClientIdOf } = await import("../billingOrderId.ts");
  assertEquals(ssClientIdOf("ss_first_simple_layout_annual"), "simple", "the ambiguity this guards against");
  const src = (await Deno.readTextFile(new URL("../../admin-catalog/index.ts", import.meta.url))).replace(/\r\n/g, "\n");
  const create = src.slice(src.indexOf('case "create_client": {'));
  const reserved = /const reserved = \[([^\]]+)\];/.exec(create)?.[1] ?? "";
  assert(reserved.includes('"first"'), `create_client does not reserve "first": [${reserved}]`);
});
