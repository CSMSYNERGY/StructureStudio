// Unit tests for _shared/ruleWebhook.ts (migration 370). Self-contained: no registry imports, and
// the fetch is a fake, so nothing here touches the network.
import { postWebhook, webhookPayload, webhookSignature, WEBHOOK_USER_AGENT } from "./ruleWebhook.ts";

function eq(a: unknown, b: unknown, msg: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

const SECRET = "0123456789abcdef".repeat(4);

Deno.test("the signature is HMAC-SHA256 over t.body keyed by the secret as typed (known answer)", async () => {
  // Worked out independently with Node's crypto.createHmac, so a receiver following the editor's
  // sentence gets the same hex.
  eq(await webhookSignature(SECRET, 1700000000, '{"hello":"world"}'),
    "t=1700000000,v1=e4191e4d7f858f980dccb8ed39ab083eb8b321e233d22339fbc45b25c816c3e3", "known answer");
});

const RULE = { id: "r1", name: "Review ask", trigger_kind: "event", trigger_event: "delivered", elapsed_anchor: null, elapsed_days: null, schedule: null };

Deno.test("the payload says who, which rule and when, and nothing else", () => {
  const p = webhookPayload({
    deliveryId: "crm-outbox-7", firedAt: "2026-11-06T15:00:00.000Z", business: "Acme Barns",
    rule: RULE,
    contact: { id: "c1", name: "  Dee  Tester ", email: "dee@example.invalid", phone: "(555) 010-0000", company: null, labels: ["Lot visitor"] },
    card: { id: "d1", title: "10x12 Lofted", short_code: "SS-ABCDEFGHJK", value_cents: 650000 },
  });
  eq(p, {
    type: "automation.fired", id: "crm-outbox-7", firedAt: "2026-11-06T15:00:00.000Z",
    rule: { id: "r1", name: "Review ask", trigger: { kind: "event", event: "delivered" } },
    contact: { id: "c1", name: "Dee  Tester", firstName: "Dee", email: "dee@example.invalid", phone: "(555) 010-0000", company: null, tags: ["Lot visitor"] },
    card: { id: "d1", title: "10x12 Lofted", code: "SS-ABCDEFGHJK", valueCents: 650000 },
    business: { name: "Acme Barns" },
  }, "shape");
  // A rule for nobody (a schedule) has no customer and no card.
  const n = webhookPayload({ deliveryId: "x", firedAt: "t", business: "", rule: { ...RULE, trigger_kind: "schedule", trigger_event: null, schedule: { freq: "weekly" } }, contact: null, card: null });
  eq([n.contact, n.card, n.rule.trigger, n.business.name], [null, null, { kind: "schedule", freq: "weekly" }, null], "nobody");
});

type Seen = { url: string; init: RequestInit };
function fakeFetch(status: number, opts: { type?: string; throws?: string } = {}) {
  const seen: Seen[] = [];
  let cancelled = false;
  const fn = (url: string, init: RequestInit) => {
    seen.push({ url, init });
    if (opts.throws) { const e = new Error("x"); e.name = opts.throws; return Promise.reject(e); }
    // A body that is cancelled while still unread calls cancel(); one a reader consumed first is
    // locked, so its cancel() rejects and this never runs.
    const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("what the far end said")); }, cancel() { cancelled = true; } });
    const res = new Response(status === 204 ? null : body, { status: status === 0 ? 200 : status });
    if (opts.type) Object.defineProperty(res, "type", { value: opts.type });
    if (status === 0) Object.defineProperty(res, "status", { value: 0 });
    return Promise.resolve(res);
  };
  return { fn, seen, cancelledUnread: () => cancelled };
}

Deno.test("a 2xx is sent, signed, with the delivery id, and never follows a redirect", async () => {
  const f = fakeFetch(200);
  const out = await postWebhook(f.fn, "https://hooks.example.com/catch/1", SECRET, { a: 1 }, "crm-outbox-9", 1700000000_000);
  eq(out, { ok: true, status: 200 }, "sent");
  const h = f.seen[0].init.headers as Record<string, string>;
  eq([f.seen[0].init.method, f.seen[0].init.redirect, h["Content-Type"], h["User-Agent"], h["X-SS-Delivery"]],
    ["POST", "manual", "application/json", WEBHOOK_USER_AGENT, "crm-outbox-9"], "request");
  eq(h["X-SS-Signature"], await webhookSignature(SECRET, 1700000000, '{"a":1}'), "signed over the exact body sent");
  eq(f.seen[0].init.body, '{"a":1}', "body");
});

Deno.test("no secret, no signature header", async () => {
  const f = fakeFetch(204);
  eq((await postWebhook(f.fn, "https://hooks.example.com/x", null, {}, "d")).ok, true, "sent");
  eq("X-SS-Signature" in (f.seen[0].init.headers as Record<string, string>), false, "unsigned");
});

Deno.test("the guard runs again at send: nothing is fetched for a refused address", async () => {
  for (const url of ["http://hooks.example.com/x", "https://127.0.0.1/x", "https://hooks.example.com:8443/x", "https://localhost/x", "https://user:pw@hooks.example.com/"]) {
    const f = fakeFetch(200);
    const out = await postWebhook(f.fn, url, SECRET, {}, "d");
    eq([out.ok, (out as { retry?: boolean }).retry, f.seen.length], [false, false, 0], url);
  }
});

Deno.test("what an answer means: redirect and 4xx stop, 408/429/5xx and no answer try again", async () => {
  const cases: [number, string | undefined, string | undefined, boolean][] = [
    [301, undefined, undefined, false], [0, "opaqueredirect", undefined, false],
    [400, undefined, undefined, false], [404, undefined, undefined, false], [410, undefined, undefined, false],
    [408, undefined, undefined, true], [429, undefined, undefined, true], [500, undefined, undefined, true], [503, undefined, undefined, true],
    [0, undefined, "TimeoutError", true], [0, undefined, "TypeError", true],
  ];
  for (const [st, type, throws, retry] of cases) {
    const f = fakeFetch(st, { type, throws });
    const out = await postWebhook(f.fn, "https://hooks.example.com/x", SECRET, {}, "d");
    eq([out.ok, (out as { retry: boolean }).retry], [false, retry], `${st} ${type ?? ""} ${throws ?? ""}`);
  }
});

Deno.test("the answer's body is never read (the exfiltration invariant)", async () => {
  const f = fakeFetch(500);
  await postWebhook(f.fn, "https://hooks.example.com/x", SECRET, {}, "d");
  eq(f.cancelledUnread(), true, "body cancelled, not read");
});
