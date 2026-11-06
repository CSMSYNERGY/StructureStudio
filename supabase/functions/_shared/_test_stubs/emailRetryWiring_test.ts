// Automated emails and meeting reminders survive a Resend outage (2026-11-06), driven through the
// SHIPPED crm-rules-tick and meeting-reminders handlers against a fake database and a fake Resend.
//
// WHY THIS EXISTS. Two ways an automated email used to be lost for good:
//
//   1. crm-rules-tick tried a queued message four times, five minutes apart, then gave up. Any
//      outage longer than twenty minutes dropped every email and text queued in it.
//   2. meeting-reminders claimed a reminder, tried once, and never again.
//
// Both now retry, and both pass an idempotency key so a retry of an email that DID go out (its
// answer lost to a timeout) is answered by Resend instead of sent twice. resend.test.ts and
// emailSend.test.ts prove the key and the one bounded try; this proves the two handlers use
// them: the waits grow and stay inside Resend's 24-hour key memory, a wait rides on leased_until
// (never hold_until, which the run log reads as quiet hours), a refusal no retry changes stops at
// once, a paused or removed rule stops its queued messages, and a reminder that failed transiently
// is given back for the next tick only while it is still roughly on time.
//
// The pre-ship reviews of 2026-11-06 added the paused-rule (and its failed read), subject-proof,
// hold_until, team-note, per-offset-grace and read-error cases; each one failed against the code
// it fixed.
//
// HOW. The ghlEmailCheckWiring_test idiom: Deno.serve is stubbed while each function is imported,
// the import map swaps supabase-js for supabase_stub.ts, and fetch is a fake Resend. No --allow-net.
// The import specifiers are computed on purpose (see aiDraftStreamWiring_test).
//
// Tenants, people and ids are made up. The repo is public.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { stubDb, stubRpc } from "./supabase_stub.ts";
import { sendTeamNote } from "../leadFormMail.ts";

const SERVICE = "stub-service-key";
Deno.env.set("SUPABASE_URL", "https://stub.supabase.test");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE);
Deno.env.set("RESEND_API_KEY", "re_stub");

async function load(rel: string): Promise<(req: Request) => Promise<Response>> {
  const realServe = Deno.serve;
  let handler: ((req: Request) => Promise<Response>) | null = null;
  (Deno as any).serve = (h: (req: Request) => Promise<Response>) => {
    handler = h;
    return { finished: Promise.resolve() };
  };
  await import(new URL(rel, import.meta.url).href);
  (Deno as any).serve = realServe;
  if (!handler) throw new Error(`${rel} did not hand Deno.serve a handler`);
  return handler;
}
const TICK = await load("../../crm-rules-tick/index.ts");
const REMINDERS = await load("../../meeting-reminders/index.ts");

// ── A fake PostgREST: every chain is recorded, and `answer` decides what it resolves to ────────

type Q = { table: string; op: "select" | "update" | "insert"; cols: string; payload: any; calls: [string, unknown[]][] };
function fakeDb(answer: (q: Q) => { data: any; error: any }) {
  const log: Q[] = [];
  const from = (table: string) => {
    const q: Q = { table, op: "select", cols: "", payload: null, calls: [] };
    log.push(q);
    const b: any = {};
    for (const m of ["eq", "neq", "lt", "lte", "gt", "gte", "in", "is", "not", "or", "order", "limit", "contains", "range"]) {
      b[m] = (...a: unknown[]) => { q.calls.push([m, a]); return b; };
    }
    b.select = (cols: string) => { if (q.op === "select") q.cols = cols; return b; };
    b.update = (p: any) => { q.op = "update"; q.payload = p; return b; };
    b.insert = (p: any) => { q.op = "insert"; q.payload = p; return b; };
    b.maybeSingle = () => Promise.resolve(answer(q));
    b.single = () => Promise.resolve(answer(q));
    b.then = (res: any, rej: any) => Promise.resolve(answer(q)).then(res, rej);
    return b;
  };
  return { from, log };
}
const arg = (q: Q, m: string, col: string) => q.calls.find(([n, a]) => n === m && a[0] === col)?.[1][1];

// ── A fake Resend: answers every send with `status`, records the key, swallows everything else ─

type Sent = { key: string | null; body: any };
function fakeResend(status: number, name = "") {
  const sent: Sent[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://api.resend.com/emails")) {
      sent.push({ key: new Headers(init?.headers ?? {}).get("Idempotency-Key"), body: JSON.parse(String(init?.body ?? "{}")) });
      return Promise.resolve(status < 300
        ? new Response(JSON.stringify({ id: `em_${sent.length}` }), { status })
        : new Response(JSON.stringify({ statusCode: status, name, message: "stub" }), { status }));
    }
    // app_errors writes and anything else: accepted, and not this test's business.
    return Promise.resolve(new Response("[]", { status: 201 }));
  }) as typeof fetch;
  return sent;
}
const realFetch = globalThis.fetch;
const reset = () => { globalThis.fetch = realFetch; stubDb.from = null; stubRpc.rpc = null; };

const post = (h: (req: Request) => Promise<Response>) =>
  h(new Request("https://stub.supabase.test/functions/v1/x", { method: "POST", headers: { authorization: `Bearer ${SERVICE}` }, body: "{}" }));

const CLIENT = "demo-builder";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const RULE = "55555555-5555-4555-8555-555555555555";
const SETTINGS = {
  email_provider: "resend", email_domain_status: "verified", email_domain: "mail.demo-builder.test",
  email_from_local: "info", email_from_name: "Demo Builder", business_name: "Demo Builder",
  beta_mode: false, beta_email: null, invoice_in_ghl: true,
};

// ── crm-rules-tick ─────────────────────────────────────────────────────────────────────────

type TickOpts = {
  /** The crm_rules row the outbox row names. Default: switched on, not removed. */
  rule?: Record<string, unknown> | null;
  /** What an email_sends read (any) answers. Default: nothing. */
  priorSends?: unknown[];
  /** The outbox row's own hold_until (a text that waited for the morning). */
  holdUntil?: string | null;
  /** Make the crm_rules read itself fail (a blip, not a missing rule). */
  ruleReadFails?: boolean;
};

/** Run one tick with one queued "email the customer" row that has already had `before` tries. */
async function tickOnce(before: number, resendStatus: number, resendName = "", o: TickOpts = {}) {
  const sent = fakeResend(resendStatus, resendName);
  const db = fakeDb((q) => {
    if (q.table === "crm_rule_outbox" && q.op === "select" && q.cols.startsWith("id, rule_id")) {
      return { data: [{ id: 41, rule_id: RULE, client_id: CLIENT, deal_id: null, contact_id: CONTACT, kind: "send_email",
        params: { subject: "An update from {{business}}", body: "Hi {{first_name}}" }, attempts: before,
        queued_at: "2026-11-06T10:00:00Z", hold_until: o.holdUntil ?? null }], error: null };
    }
    if (q.table === "crm_rule_outbox" && q.op === "update" && "attempts" in (q.payload ?? {})) return { data: [{ id: 41 }], error: null };
    if (q.table === "crm_rules") {
      if (o.ruleReadFails) return { data: null, error: { message: "upstream connect error" } };
      return { data: "rule" in o ? o.rule : { enabled: true, archived_at: null }, error: null };
    }
    if (q.table === "crm_contacts") return { data: { id: CONTACT, name: "Sam Lee", company: "", phone: "", email: "sam@example.test", dnd_all_at: null, dnd_email_at: null }, error: null };
    if (q.table === "client_settings") return { data: SETTINGS, error: null };
    if (q.table === "email_sends" && q.op === "insert") return { data: { id: "es-1" }, error: null };
    if (q.table === "email_sends" && q.op === "select") return { data: o.priorSends ?? [], error: null };
    return { data: [], error: null };
  });
  stubDb.from = db.from;
  stubRpc.rpc = () => Promise.resolve({ data: 0, error: null });
  const t0 = Date.now();
  const res = await post(TICK);
  const body = await res.json();
  const outcome = db.log.filter((q) => q.table === "crm_rule_outbox" && q.op === "update" && "last_error" in (q.payload ?? {})).pop();
  const queueRead = db.log.find((q) => q.table === "crm_rule_outbox" && q.op === "select" && q.cols.startsWith("id, rule_id"))!;
  return { body, sent, outcome, queueRead, t0, db };
}

Deno.test("crm-rules-tick: a failed email waits longer each time, on leased_until, and the last try is inside a day", async () => {
  try {
    let totalMin = 0;
    let last = 0;
    for (let before = 0; before < 8; before++) {
      const { outcome, sent, t0 } = await tickOnce(before, 503);
      assert(outcome, `try ${before + 1}: the row must be written back`);
      assertEquals(outcome.payload.state, "queued", `try ${before + 1} of 9 is not the last, so it stays queued`);
      assertEquals(outcome.payload.hold_until, null, "a retry is not quiet hours: hold_until is cleared, never set");
      const waitMin = (Date.parse(outcome.payload.leased_until) - t0) / 60_000;
      assert(waitMin > last, `the waits must grow (try ${before + 1}: ${waitMin.toFixed(1)} min after ${last.toFixed(1)})`);
      last = waitMin;
      totalMin += Math.round(waitMin);
      // One try per tick, keyed on the row: the tick's schedule is the retry.
      assertEquals(sent.length, 1, "one try per tick");
      assert(sent.every((s) => s.key?.startsWith("crm-outbox/41/")), `keyed on the outbox row: ${sent.map((s) => s.key)}`);
    }
    assert(totalMin > 20 * 60, `retries must cover most of a day, got ${totalMin} min`);
    assert(totalMin < 23 * 60, `the last try must be inside Resend's 24 h key memory, got ${totalMin} min`);
  } finally {
    reset();
  }
});

Deno.test("crm-rules-tick: the ninth try is the last; a malformed email stops at the first; a 403 keeps retrying", async () => {
  try {
    const nine = await tickOnce(8, 503);
    assertEquals(nine.outcome?.payload.state, "failed", "nine tries, then a person looks");
    assertEquals(nine.outcome?.payload.leased_until, null);
    assertEquals(arg(nine.queueRead, "lte", "attempts"), 8, "the queue read lets a row with eight tries have its ninth");

    const refused = await tickOnce(0, 422, "invalid_parameter");
    assertEquals(refused.outcome?.payload.state, "failed", "a 422 does not change on a retry");
    assertEquals(refused.sent.length, 1, "one try");

    // An account or domain problem (a suspended key, lost DNS) is fixed by a person within hours.
    const suspended = await tickOnce(0, 403, "suspended_api_key");
    assertEquals(suspended.outcome?.payload.state, "queued", "a 403 must not end the row at its first try");

    const ok = await tickOnce(3, 200);
    const sentRow = ok.db.log.filter((q) => q.table === "crm_rule_outbox" && q.op === "update" && q.payload?.state === "sent");
    assertEquals(sentRow.length, 1, "a later try that goes through is marked sent");
    assertEquals(ok.body.sent, 1);
  } finally {
    reset();
  }
});

Deno.test("crm-rules-tick: two tries of one email carry the same Idempotency-Key and the same body", async () => {
  try {
    const a = await tickOnce(1, 503);
    const b = await tickOnce(2, 200);
    assertEquals(b.sent[0].key, a.sent[0].key, "one message, one key, whichever tick sends it");
    assertEquals(JSON.stringify(b.sent[0].body), JSON.stringify(a.sent[0].body), "byte-identical, so Resend matches it");
  } finally {
    reset();
  }
});

Deno.test("crm-rules-tick: a paused or removed rule sends nothing more", async () => {
  try {
    for (const rule of [{ enabled: false, archived_at: null }, { enabled: true, archived_at: "2026-11-06T11:00:00Z" }, null]) {
      const r = await tickOnce(2, 200, "", { rule });
      assertEquals(r.sent.length, 0, `nothing reaches Resend for rule ${JSON.stringify(rule)}`);
      assertEquals(r.outcome?.payload.state, "skipped", "ended, not failed: the builder switched it off");
      assert(String(r.outcome?.payload.last_error).includes("paused or removed"), r.outcome?.payload.last_error);
    }
    // A read that FAILED is not a rule that is gone (second review, 2026-11-06).
    const blip = await tickOnce(2, 200, "", { ruleReadFails: true });
    assertEquals(blip.sent.length, 0);
    assertEquals(blip.outcome?.payload.state, "queued", "back on the retry schedule, not skipped");
    assert(String(blip.outcome?.payload.last_error).includes("Could not check the rule"), blip.outcome?.payload.last_error);
  } finally {
    reset();
  }
});

Deno.test("crm-rules-tick: another rule's sent email with the same subject does NOT count as this one", async () => {
  // The old proof check marked a retrying row "Recovered" when ANY sent email to the customer had the
  // same subject since it was queued, so a different rule's "An update from …" swallowed this one.
  try {
    const r = await tickOnce(3, 200, "", { priorSends: [{ id: "es-other-rule" }] });
    assertEquals(r.sent.length, 1, "this row's own words go out");
    assertEquals(r.body.recovered, 0);
    assertEquals(r.outcome?.payload.state, "sent");
    assertEquals(r.outcome?.payload.last_error, null, "and it is not labelled Recovered");
  } finally {
    reset();
  }
});

Deno.test("sendTeamNote: with a key, each person gets their own stable key and no address in the clear", async () => {
  Deno.env.set("PLATFORM_EMAIL_DOMAIN_READY", "true");
  try {
    // The sends run side by side, so the order they reach Resend in varies: compare as sorted sets.
    let sent = fakeResend(200);
    await sendTeamNote(CLIENT, ["dale@demo-builder.test", "kim@demo-builder.test"], "Card moved", "Sam Lee is in production", "crm-outbox/77");
    const first = sent.map((s) => s.key).sort();
    assertEquals(first.length, 2);
    assert(first.every((k) => /^crm-outbox\/77\/[0-9a-f]{12}\/[0-9a-f]{16}$/.test(String(k))), `shape: ${first}`);
    assert(first[0] !== first[1], "one key per person");
    assert(first.every((k) => !String(k).includes("@")), "an address never rides in a header");

    sent = fakeResend(200);
    await sendTeamNote(CLIENT, ["dale@demo-builder.test", "kim@demo-builder.test"], "Card moved", "Sam Lee is in production", "crm-outbox/77");
    assertEquals(JSON.stringify(sent.map((s) => s.key).sort()), JSON.stringify(first), "the next try of the same note: the same keys");

    sent = fakeResend(200);
    await sendTeamNote(CLIENT, ["dale@demo-builder.test"], "Card moved", "Sam Lee is in production");
    assertEquals(sent[0].key, null, "without a key (lead alerts and the rest) nothing changes");
  } finally {
    Deno.env.delete("PLATFORM_EMAIL_DOMAIN_READY");
    reset();
  }
});

Deno.test("crm-rules-tick hands sendTeamNote its row's key", async () => {
  const src = await Deno.readTextFile(new URL("../../crm-rules-tick/index.ts", import.meta.url));
  const call = src.slice(src.indexOf("await sendTeamNote("), src.indexOf("await sendTeamNote(") + 400);
  assert(call.includes("`crm-outbox/${id}`"), `the team note must be keyed on the outbox row: ${call.slice(0, 300)}`);
});

// ── meeting-reminders ──────────────────────────────────────────────────────────────────────

const MEETING = "44444444-4444-4444-8444-444444444444";

type RemindOpts = {
  sentAlready?: number[];
  /** The offset the tenant asked for (hours). Default 24. */
  hours?: number;
  /** How late the reminder is, in minutes. Default 30. */
  lateMin?: number;
  /** The meeting start, so two runs in one test build the same email (one minute apart would not). */
  startsAt?: string;
  /** Make the big meeting read inside meetingSend fail. */
  readFails?: boolean;
};

const startFor = (hours: number, lateMin: number) =>
  new Date(Date.now() + hours * 3_600_000 - lateMin * 60_000).toISOString();

async function remindOnce(resendStatus: number, resendName = "", o: RemindOpts = {}) {
  const sent = fakeResend(resendStatus, resendName);
  const hours = o.hours ?? 24;
  const startsAt = o.startsAt ?? startFor(hours, o.lateMin ?? 30);
  const sentAlready = o.sentAlready ?? [];
  const db = fakeDb((q) => {
    if (q.table === "meeting_settings" && q.cols.includes("reminder_hours")) return { data: [{ client_id: CLIENT, reminder_hours: [hours] }], error: null };
    if (q.table === "meeting_settings") return { data: { send_confirmation: true }, error: null };
    if (q.table === "meetings" && q.op === "select" && q.cols === "reminders_sent") return { data: { reminders_sent: [...sentAlready, hours] }, error: null };
    if (q.table === "meetings" && q.op === "select" && q.cols.startsWith("id, client_id, starts_at, reminders_sent")) {
      return { data: [{ id: MEETING, client_id: CLIENT, starts_at: startsAt, reminders_sent: sentAlready, customer_email: "sam@example.test" }], error: null };
    }
    if (q.table === "meetings" && q.op === "select") {
      if (o.readFails) return { data: null, error: { message: "canceling statement due to statement timeout" } };
      return { data: { id: MEETING, client_id: CLIENT, starts_at: startsAt, ends_at: new Date(Date.parse(startsAt) + 3_600_000).toISOString(),
        booked_time_zone: "America/New_York", status: "booked", customer_name: "Sam Lee", customer_email: "sam@example.test",
        customer_notes: null, cancel_token: null, rescheduled_from: null, ics_sequence: 0, conference_provider: null,
        conference_url: null, conference_note: null, conference_status: null, calendar_invited: false,
        meeting_types: { name: "Site visit", location_kind: "custom", location_detail: "The lot" },
        meeting_hosts: { public_name: "Dale" } }, error: null };
    }
    if (q.table === "client_configs") return { data: { company_name: "Demo Builder", logo_url: null }, error: null };
    if (q.table === "client_settings") return { data: SETTINGS, error: null };
    if (q.table === "email_sends" && q.op === "insert") return { data: { id: "es-2" }, error: null };
    return { data: [], error: null };
  });
  stubDb.from = db.from;
  stubRpc.rpc = (fn: string) => Promise.resolve({ data: fn === "claim_meeting_reminder" ? true : null, error: null });
  const body = await (await post(REMINDERS)).json();
  const giveBack = db.log.filter((q) => q.table === "meetings" && q.op === "update" && "reminders_sent" in (q.payload ?? {}));
  return { body, sent, giveBack };
}

Deno.test("meeting-reminders: a reminder Resend failed on is given back for the next tick, under one key", async () => {
  try {
    // ONE start time for both runs: the email names it to the minute, so two runs that worked it out
    // separately could straddle a minute and build different emails (a flake the review found).
    const startsAt = startFor(24, 30);
    const r = await remindOnce(503, "", { sentAlready: [2], startsAt });
    assertEquals(r.body.failed, 1);
    assertEquals(r.body.retrying, 1, "a transient failure is retried now");
    assertEquals(r.giveBack.length, 1, "the 24 h offset is un-claimed");
    assertEquals(JSON.stringify(r.giveBack[0].payload.reminders_sent), "[2]", "only that offset; the 2 h one stays claimed");
    assert(r.sent.length === 1 && r.sent.every((s) => s.key?.startsWith(`meeting-reminder/${MEETING}/24/`)),
      `keyed on the meeting and the offset: ${r.sent.map((s) => s.key)}`);

    const again = await remindOnce(200, "", { startsAt });
    assertEquals(again.sent[0].key, r.sent[0].key, "the next tick's try carries the same key, so a try that did go out is not sent twice");
  } finally {
    reset();
  }
});

Deno.test("meeting-reminders: a refusal no retry changes stays claimed, and a sent one is left alone", async () => {
  try {
    const refused = await remindOnce(422, "invalid_parameter");
    assertEquals(refused.body.failed, 1);
    assertEquals(refused.body.retrying, 0);
    assertEquals(refused.giveBack.length, 0, "a permanent refusal is not given back");

    const ok = await remindOnce(200);
    assertEquals(ok.body.sent, 1);
    assertEquals(ok.giveBack.length, 0);
  } finally {
    reset();
  }
});

Deno.test("meeting-reminders: a 2-hour reminder may be 30 minutes late, not two hours; a 24-hour one still two", async () => {
  // A flat two-hour grace is all of a 2-hour reminder, so retries could send "in 2 hours" minutes
  // before the meeting. The grace is now two hours or a quarter of the offset, whichever is shorter.
  try {
    const onTime = await remindOnce(200, "", { hours: 2, lateMin: 25 });
    assertEquals([onTime.body.sent, onTime.body.skippedLate].join(","), "1,0", "25 min late: still goes");

    const late = await remindOnce(200, "", { hours: 2, lateMin: 35 });
    assertEquals([late.body.sent, late.body.skippedLate].join(","), "0,1", "35 min late: claimed, not sent");
    assertEquals(late.sent.length, 0);

    const day = await remindOnce(200, "", { hours: 24, lateMin: 100 });
    assertEquals([day.body.sent, day.body.skippedLate].join(","), "1,0", "a 24-hour reminder keeps its two hours");
  } finally {
    reset();
  }
});

Deno.test("meeting-reminders: a failed meeting read after the claim is given back, not lost", async () => {
  try {
    const r = await remindOnce(200, "", { readFails: true });
    assertEquals(r.sent.length, 0, "nothing reached Resend");
    assertEquals(r.body.retrying, 1, "a read that failed is safe to try again");
    assertEquals(r.giveBack.length, 1);
  } finally {
    reset();
  }
});
