// Deliberately dependency-free (no jsr:/npm: imports) so this suite still runs on a machine with
// no registry access — the same rule the other _shared tests follow.
//
// What billing_webhook_events may keep of a gateway event. The fixtures are shaped like the LIVE
// NMI body (every key the 40 stored rows carried on 2026-10-05, values made up), plus the two older
// Deposyt shapes the webhook still accepts. Every person, card and tenant here is invented: the repo
// is public, and no real payer, card or client id belongs in a fixture.
//
// The last test reads migration 281's own patterns (pg_temp.m281_carries) and runs them over this
// module's output, so the webhook's new rows and the scrub's definition of "clean" cannot drift.

import { redactWebhookPayload } from "./billingWebhookRedact.ts";

const assert = (cond: unknown, msg = "assertion failed") => {
  if (!cond) throw new Error(msg);
};
const assertEquals = (a: unknown, b: unknown, msg?: string) => {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(msg ? `${msg}: ${sa} !== ${sb}` : `${sa} !== ${sb}`);
};

// Everything that identifies a payer or their card, as it would appear in the stored text.
const SECRETS = [
  "411111******1111", "411111", "1229", "visa",
  "Pat", "Example", "Acme Sheds LLC", "1 Example Road", "Suite 9", "Springfield", "62704",
  "pat@example.com", "5555550123", "5555550124", "5555550125",
  "merch-7781", "Example Merchant", "ext-31",
];

// The live NMI shape: every key present on 2026-10-05, in every row.
const nmiEvent = () => ({
  event_id: "evt-0001",
  event_type: "recurring.subscription.add",
  event_body: {
    subscription_id: "9000000001",
    order_id: "ss_acme-sheds_simple_layout_annual",
    order_description: "StructureStudio Simple Layout (annual)",
    ponumber: "",
    processor_id: "proc-1",
    subscription_type: "cc",
    next_charge_date: "2027-10-05",
    attempted_payments: "1",
    completed_payments: "1",
    remaining_payments: "0",
    plan: {
      id: "SS_SIMPLE_LAYOUT_ANNUAL", name: "Simple Layout annual", amount: "499.00", payments: "0",
      day_of_month: "5", month_frequency: "12", day_frequency: "",
    },
    card: {
      cc_number: "411111******1111", cc_bin: "411111", cc_exp: "1229", cc_type: "visa",
      cc_issue_number: "", cc_start_date: "", avs_response: "Y", csc_response: "M",
      cavv: "", cavv_result: "", xid: "", eci: "", entry_mode: "keyed", cardholder_auth: "",
      card_balance: "", card_available_balance: "",
    },
    billing_address: {
      first_name: "Pat", last_name: "Example", company: "Acme Sheds LLC",
      address_1: "1 Example Road", address_2: "Suite 9", city: "Springfield", state: "IL",
      postal_code: "62704", country: "US", email: "pat@example.com",
      phone: "5555550123", cell_phone: "5555550124", fax: "5555550125",
    },
    merchant: { id: "merch-7781", name: "Example Merchant", external_identifier: "ext-31" },
    shipping: "0.00",
    tax: "0.00",
    features: { is_test_mode: false },
    website: "",
  },
});

Deno.test("the live NMI shape: no card digit, expiry or contact detail survives", () => {
  const raw = nmiEvent();
  const text = JSON.stringify(redactWebhookPayload(raw));
  for (const s of SECRETS) assert(!text.includes(s), `"${s}" leaked into ${text}`);
  for (const k of ["card", "billing_address", "merchant", "shipping", "cc_number", "cc_exp", "email", "phone"]) {
    assert(!text.includes(`"${k}"`), `key "${k}" leaked into ${text}`);
  }
  // And the input is untouched: processing reads the parsed body AFTER this, in memory.
  assertEquals(raw, nmiEvent(), "the caller's payload is not mutated");
});

Deno.test("the live NMI shape: what the webhook acts on and a triage reads is kept", () => {
  const out = redactWebhookPayload(nmiEvent()) as any;
  assertEquals(out.event_id, "evt-0001");
  assertEquals(out.event_type, "recurring.subscription.add");
  const b = out.event_body;
  assertEquals(b.subscription_id, "9000000001");
  assertEquals(b.order_id, "ss_acme-sheds_simple_layout_annual");
  assertEquals(b.next_charge_date, "2027-10-05");
  assertEquals(b.order_description, "StructureStudio Simple Layout (annual)");
  assertEquals([b.attempted_payments, b.completed_payments, b.remaining_payments], ["1", "1", "0"]);
  assertEquals(b.plan, {
    id: "SS_SIMPLE_LAYOUT_ANNUAL", name: "Simple Layout annual", amount: "499.00", payments: "0",
    day_of_month: "5", month_frequency: "12", day_frequency: "",
  });
  // Exactly the whitelist, nothing more: tax, features and website were harmless but unasked for.
  assertEquals(Object.keys(b).sort(), [
    "attempted_payments", "completed_payments", "next_charge_date", "order_description", "order_id",
    "plan", "ponumber", "processor_id", "remaining_payments", "subscription_id", "subscription_type",
  ]);
  assertEquals(Object.keys(out).sort(), ["event_body", "event_id", "event_type"]);
});

Deno.test("the older data.subscription shape: rebuilt in place, tenant id kept, payer dropped", () => {
  const out = redactWebhookPayload({
    id: "evt-0002", type: "recurring.subscription.update",
    data: {
      subscription: {
        id: "9000000002", status: "past_due", current_period_end: "2026-11-05T00:00:00Z",
        metadata: { clientId: "acme-sheds", email: "pat@example.com", note: "call Pat" },
        card: { cc_number: "411111******1111", cc_exp: "1229" },
        billing_address: { email: "pat@example.com", phone: "5555550123" },
      },
      customer: { email: "pat@example.com" },
    },
  }) as any;
  assertEquals(out, {
    id: "evt-0002", type: "recurring.subscription.update",
    data: {
      subscription: {
        id: "9000000002", status: "past_due", current_period_end: "2026-11-05T00:00:00Z",
        metadata: { clientId: "acme-sheds" },
      },
    },
  });
});

Deno.test("the older subscription shape: merchant-defined field 1 only, and only a tenant slug", () => {
  const out = redactWebhookPayload({
    id: "evt-0003", type: "recurring.subscription.add",
    subscription: {
      subscription_id: "9000000003", order_id: "ss_first_acme-sheds_crm_annual", orderid: "x-1",
      merchant_defined_field_1: "acme-sheds",
      merchant_defined_fields: [{ id: "2", value: "pat@example.com" }, { id: "1", value: "acme-sheds" }],
      card: { cc_number: "411111******1111" },
    },
  }) as any;
  assertEquals(out.subscription, {
    subscription_id: "9000000003", order_id: "ss_first_acme-sheds_crm_annual", orderid: "x-1",
    merchant_defined_field_1: "acme-sheds",
    merchant_defined_fields: { "1": "acme-sheds" },
  });

  // The object form NMI may echo, keyed by field number.
  const obj = redactWebhookPayload({
    id: "e", type: "t", subscription: { merchant_defined_fields: { "1": "bravo-barns", "2": "Pat Example" } },
  }) as any;
  assertEquals(obj.subscription, { merchant_defined_fields: { "1": "bravo-barns" } });
});

Deno.test("a tenant field holding something that is not a tenant slug is dropped", () => {
  // Another product on the shared gateway may put anything in these; an email is the obvious guess.
  for (const v of ["pat@example.com", "Pat Example", "ACME-SHEDS", "acme_sheds", "", "-acme", 42, { x: 1 }, null]) {
    const out = redactWebhookPayload({
      id: "e", type: "t",
      event_body: {
        merchant_defined_field_1: v,
        merchant_defined_fields: [{ id: "1", value: v }],
        metadata: { clientId: v },
      },
    }) as any;
    assertEquals(out.event_body, {}, `value ${JSON.stringify(v)}`);
  }
});

Deno.test("unknown keys and non-scalar values under kept names are dropped", () => {
  const out = redactWebhookPayload({
    id: "e", type: "t", customer: { email: "pat@example.com" }, signature: "abc",
    event_body: {
      subscription_id: "1",
      status: { email: "pat@example.com" },           // a kept NAME holding a block
      order_id: ["pat@example.com"],                   // ... or an array
      payment_token: "tok_123", cvv: "123", account: "000123456789", routing: "011000015",
      plan: { id: "P1", customer_email: "pat@example.com", nested: { phone: "5555550123" } },
    },
  }) as any;
  assertEquals(out, { id: "e", type: "t", event_body: { subscription_id: "1", plan: { id: "P1" } } });
});

Deno.test("garbage never throws, and always yields an object the NOT NULL column accepts", () => {
  const cases: unknown[] = [
    null, undefined, 0, 42, "", "text", true, [], [1, 2], [{ event_body: {} }],
    {}, { event_body: null }, { event_body: "x" }, { event_body: [1] }, { data: 7 }, { data: { subscription: [] } },
    { subscription: "x" }, { id: { nested: true }, type: ["t"] }, Object.create(null),
  ];
  for (const c of cases) {
    let out: unknown;
    try { out = redactWebhookPayload(c); } catch (e) { throw new Error(`threw on ${String(c)}: ${(e as Error).message}`); }
    assert(out !== null && typeof out === "object" && !Array.isArray(out), `not an object for ${JSON.stringify(c)}`);
    JSON.stringify(out); // serialisable
  }
  // Ids that are not scalars are not kept either.
  assertEquals(redactWebhookPayload({ id: { nested: true }, type: ["t"] }), {});
});

Deno.test("an input that throws mid-rebuild falls back to the id+type stub", () => {
  const hostile = {
    event_id: "evt-0009", event_type: "recurring.subscription.delete",
    get event_body(): never { throw new Error("boom"); },
  };
  assertEquals(redactWebhookPayload(hostile), {
    id: "evt-0009", type: "recurring.subscription.delete", redacted: "failed",
  });
  // Even the fallback cannot read it: still no throw.
  const worse = { get id(): never { throw new Error("boom"); }, get event_body(): never { throw new Error("boom"); } };
  assertEquals(redactWebhookPayload(worse), { redacted: "failed" });
});

Deno.test("migration 281's own 'still carries' patterns pass the new output and catch the raw body", async () => {
  // The scrub's definition of clean (pg_temp.m281_carries) is what the read-back counts. A row the
  // redacting webhook writes must already pass it, or the first read-back after a real event
  // reports a leak that is not one — and a row it would catch must be caught here too.
  const sql = (await Deno.readTextFile(new URL("../../migrations/281_billing_webhook_redact.sql", import.meta.url)))
    .replace(/\r\n/g, "\n");
  const at = sql.indexOf("create or replace function pg_temp.m281_carries");
  assert(at > 0, "281 still defines pg_temp.m281_carries");
  const fn = sql.slice(at, sql.indexOf("$fn$;", at));
  const patterns = [...fn.matchAll(/p::text ~ '([^']+)'/g)].map((m) => new RegExp(m[1]));
  assertEquals(patterns.length, 3, "m281_carries has three patterns");
  const carries = (v: unknown) => patterns.some((re) => re.test(JSON.stringify(v)));

  assert(carries(nmiEvent()), "the raw live-shaped body is caught");
  assert(!carries(redactWebhookPayload(nmiEvent())), "the redacted live-shaped body passes");
  // Each pattern on its own, against its own kind of leak.
  assert(patterns[0].test(JSON.stringify({ x: { cc_exp: "1229" } })), "a card key, anywhere");
  assert(patterns[1].test(JSON.stringify({ note: "411111******1111" })), "a masked card number under any key");
  assert(patterns[2].test(JSON.stringify({ note: "pat@example.com" })), "an email address under any key");
  assert(!carries({ event_body: { order_id: "ss_acme-sheds_x", subscription_id: "9000000001", plan: { amount: "499.00" } } }),
    "the facts we keep are not mistaken for a leak");

  // And the header's read-only read-back spells out the same three patterns.
  const readBack = sql.slice(sql.indexOf("-- Read back after"), sql.indexOf("-- ── NUMBERING"));
  const rb = [...readBack.matchAll(/payload::text ~ '([^']+)'/g)].map((m) => m[1]);
  assertEquals(rb, patterns.map((re) => re.source), "the header's read-back query uses the function's patterns");
});
