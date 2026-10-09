// sendTenantSms's wallet floor (migration 259), driven through the REAL function.
//
// What is pinned is WHERE the gate sits and what it leaves behind, because both are invisible
// from a happy-path send:
//   * disarmed (PHONE_USAGE_METERS not "on") it costs zero network and the send is unchanged;
//   * a refusal happens BEFORE the claim row — no sms_messages row, no Twilio call, so nothing
//     for the usage cron to bill;
//   * with auto top-up on, wallet-autotopup is asked through the caller's waitUntil and the
//     sentence says a top-up is coming; without it, the sentence says where to add funds;
//   * a gate that errors lets the text go and leaves an app_errors row behind;
//   * an earlier refusal (STOP) wins over the wallet — paying would not have sent it.
//
// And the FROM number (migration 266): a reply may name another of the business's numbers, which
// must be the business's own, live, registered and in its Messaging Service, or the text is refused
// with a sentence (never sent from a different number); absent, it is the main number as before.
// pickReplyNumber / replyFromNumber choose that number: the customer's thread, then the sender's
// own number, then the main one.
//
// Both dependencies are stubbed: globalThis.fetch (Twilio, wallet-autotopup and app_errors) and
// a recording fake of the supabase client. smsSend.ts reaches supabase-js through logError.ts,
// the same way emailSend.test.ts's subject does; no network is used.
// Run: deno test --allow-env --node-modules-dir=none supabase/functions/_shared/smsSend.test.ts

import {
  FROM_NOT_OURS, FROM_NOT_READY, pickReplyNumber, replyFromNumber, sendTenantSms, type ReplyNumberRow, type TenantSms,
} from "./smsSend.ts";

const assert = (cond: unknown, msg = "assertion failed") => {
  if (!cond) throw new Error(msg);
};
const assertEquals = (a: unknown, b: unknown, msg?: string) => {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(msg ? `${msg}: ${sa} !== ${sb}` : `${sa} !== ${sb}`);
};

const ENV: Record<string, string> = {
  TWILIO_ACCOUNT_SID: "AC" + "0".repeat(32),
  TWILIO_API_KEY: "SK" + "0".repeat(32),
  TWILIO_API_SECRET: "test-api-secret",
  SUPABASE_URL: "https://stub.supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
};
const BUSINESS = "+15550100001";
const CUSTOMER = "(555) 010-0002";

type Fetched = { url: string; method: string; body: string | null; auth: string | null };
type World = {
  meters: "on" | "off" | undefined;
  /** wallet_usage_gate's reply, or "error" for a PostgREST error. */
  gate?: Record<string, unknown> | "error";
  optedOut?: boolean;
  /** What an sms_numbers read answers (default: the main number, registered). null = no row. */
  numberRow?: Record<string, unknown> | null;
  /** The sms_numbers read fails. */
  numberReadFails?: boolean;
  /** Workstream 2: TWILIO_SUBACCOUNTS, and what twilio_account_creds answers ("error" = a PostgREST error). */
  subaccounts?: "on" | "off";
  accountRows?: unknown[] | "error";
};

async function inWorld(world: World, msg: Partial<TenantSms> = {}) {
  const env = { ...ENV, PHONE_USAGE_METERS: world.meters, TWILIO_SUBACCOUNTS: world.subaccounts };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(env)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);

  const fetched: Fetched[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetched.push({
      url, method: (init?.method ?? "GET").toUpperCase(), body: typeof init?.body === "string" ? init.body : null,
      auth: new Headers(init?.headers).get("authorization"),
    });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    if (url.includes("api.twilio.com")) return Promise.resolve(json({ sid: "SM" + "0".repeat(32), num_segments: "1", status: "queued" }, 201));
    if (url.endsWith("/functions/v1/wallet-autotopup")) return Promise.resolve(json({ fired: true, ok: true, reason: "charged" }));
    if (url.includes("/rest/v1/app_errors")) return Promise.resolve(json([], 201));
    return Promise.resolve(json({ message: `unexpected fetch ${url}` }, 500));
  }) as typeof fetch;

  const db: string[] = [];
  /** Every filter each table was read with, e.g. "sms_numbers" → ["eq:client_id=tenant-a", ...]. */
  const filters: Record<string, string[][]> = {};
  const inserted: { table: string; row: Record<string, unknown> }[] = [];
  const rpcs: { name: string; args: unknown }[] = [];
  const admin = {
    rpc(name: string, args: unknown) {
      rpcs.push({ name, args });
      if (name === "twilio_account_creds") {
        if (world.accountRows === "error") return Promise.resolve({ data: null, error: { code: "42883", message: "function does not exist" } });
        return Promise.resolve({ data: world.accountRows ?? [], error: null });
      }
      if (world.gate === "error") return Promise.resolve({ data: null, error: { message: "function public.wallet_usage_gate does not exist" } });
      return Promise.resolve({ data: world.gate ?? null, error: null });
    },
    from(table: string) {
      const ops: string[] = [];
      const seen: string[] = [];
      (filters[table] ??= []).push(seen);
      const q: Record<string, unknown> = {};
      for (const m of ["select", "limit", "upsert"]) q[m] = () => { ops.push(m); return q; };
      for (const m of ["eq", "is"]) q[m] = (col: string, val: unknown) => { ops.push(m); seen.push(`${m}:${col}=${val}`); return q; };
      q.insert = (r: Record<string, unknown>) => { ops.push("insert"); inserted.push({ table, row: r }); return q; };
      q.update = () => { ops.push("update"); return q; };
      const row = (): unknown => {
        switch (table) {
          case "client_settings": return { sms_number: BUSINESS, sms_status: "active" };
          case "sms_registrations": return { status: "active", messaging_service_sid: "MG" + "0".repeat(32) };
          case "sms_numbers": return world.numberRow === undefined ? { registration_status: "registered" } : world.numberRow;
          case "sms_opt_outs": return world.optedOut ? { reason: "sms_stop" } : null;
          case "sms_consent_log": return { action: "granted" };
          case "crm_contacts": return { sms_opt_out_at: null };
          default: return null;
        }
      };
      q.maybeSingle = () => {
        db.push(`${table}:read`);
        if (table === "sms_numbers" && world.numberReadFails) return Promise.resolve({ data: null, error: { code: "57014", message: "canceling statement" } });
        return Promise.resolve({ data: row(), error: null });
      };
      q.single = () => {
        db.push(`${table}:${ops.includes("insert") ? "insert" : "read"}`);
        return Promise.resolve({ data: { id: "msg-1" }, error: null });
      };
      q.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => {
        db.push(`${table}:${ops.includes("update") ? "update" : ops.includes("upsert") ? "upsert" : "other"}`);
        return Promise.resolve({ data: null, error: null }).then(ok, bad);
      };
      return q;
    },
  };

  const kept: Promise<unknown>[] = [];
  try {
    const out = await sendTenantSms(admin, "tenant-a", {
      toPhone: CUSTOMER, body: "On our way", contactId: "contact-1", bypassQuietHours: true,
      waitUntil: (p) => { kept.push(p); },
      ...msg,
    });
    await Promise.all(kept); // let the background top-up request finish inside the stubs
    return { out, fetched, db, rpcs, kept, filters, inserted };
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
  }
}

const twilioCalls = (f: Fetched[]) => f.filter((c) => c.url.includes("api.twilio.com"));
const topupCalls = (f: Fetched[]) => f.filter((c) => c.url.endsWith("/functions/v1/wallet-autotopup"));
const errorRows = (f: Fetched[]) => f.filter((c) => c.url.includes("/rest/v1/app_errors")).map((c) => JSON.parse(String(c.body)));
const BELOW = { allow: false, reason: "below_floor", available_cents: 120, floor_cents: 500 };

Deno.test("DISARMED: no gate RPC at all, and the text goes exactly as before", async () => {
  for (const meters of [undefined, "off"] as const) {
    const w = await inWorld({ meters, gate: BELOW });
    assertEquals(w.out, { sent: true, id: "msg-1" }, `meters ${meters}`);
    assertEquals(w.rpcs.length, 0, "zero network for the gate while disarmed");
    assert(w.db.includes("sms_messages:insert"), "the claim row is written");
    assertEquals(twilioCalls(w.fetched).length, 1);
  }
});

Deno.test("armed and above the floor: asked once with the sms_segment meter, then sent", async () => {
  const w = await inWorld({ meters: "on", gate: { allow: true, reason: "above_floor", available_cents: 9000, floor_cents: 500 } });
  assertEquals(w.out, { sent: true, id: "msg-1" });
  assertEquals(w.rpcs, [{ name: "wallet_usage_gate", args: { p_client_id: "tenant-a", p_meter: "sms_segment" } }]);
});

Deno.test("BELOW the floor, no auto top-up: refused BEFORE the claim row, with where to add funds", async () => {
  const w = await inWorld({ meters: "on", gate: { ...BELOW, auto_topup_enabled: false } });
  assertEquals(w.out, { sent: false, reason: "wallet_empty", error: "Your wallet is empty. Add funds in Settings, Billing." });
  assert(!w.db.includes("sms_messages:insert"), "no ledger row: nothing for the usage cron to bill");
  assertEquals(twilioCalls(w.fetched).length, 0, "Twilio is never called");
  assertEquals(topupCalls(w.fetched).length, 0, "no top-up is asked for when it is off");
  assertEquals(w.kept.length, 0);
});

Deno.test("BELOW the floor WITH auto top-up: wallet-autotopup is asked via waitUntil, and the sentence says so", async () => {
  const w = await inWorld({ meters: "on", gate: { ...BELOW, auto_topup_enabled: true } });
  assertEquals(w.out, { sent: false, reason: "wallet_empty", error: "Your wallet is being topped up. Try again in a minute." });
  assertEquals(w.kept.length, 1, "the request is handed to the caller's waitUntil");
  const t = topupCalls(w.fetched);
  assertEquals(t.length, 1);
  assertEquals(t[0].method, "POST");
  assertEquals(JSON.parse(String(t[0].body)), { client_id: "tenant-a" });
  assert(!w.db.includes("sms_messages:insert"), "still no ledger row");
  assertEquals(twilioCalls(w.fetched).length, 0);
  assertEquals(errorRows(w.fetched).length, 0, "a 200 from wallet-autotopup logs nothing");
});

Deno.test("a gate that ERRORS lets the text go, and leaves an app_errors row saying so", async () => {
  const w = await inWorld({ meters: "on", gate: "error" });
  assertEquals(w.out, { sent: true, id: "msg-1" });
  const rows = errorRows(w.fetched);
  assertEquals(rows.map((r) => [r.code, r.source]), [["usage_gate_failed", "edge:sms-send"]]);
  assert(String(rows[0].message).includes("does not exist"), "the cause is in the row");
});

Deno.test("an earlier refusal wins: a STOP is answered as a STOP, never as an empty wallet", async () => {
  const w = await inWorld({ meters: "on", gate: { ...BELOW, auto_topup_enabled: true }, optedOut: true });
  assertEquals(w.out.reason, "opted_out");
  assertEquals(w.rpcs.length, 0, "the gate is not even asked");
  assertEquals(topupCalls(w.fetched).length, 0, "and no card is charged for a text that could never go");
});

// ── The FROM number (migration 266) ─────────────────────────────────────────────────────────
const SERVICE = "MG" + "0".repeat(32);
const OTHER_LINE = "+15550100003";
const twilioFrom = (f: Fetched[]) => twilioCalls(f).map((c) => new URLSearchParams(String(c.body)).get("From"));

Deno.test("fromNumber ABSENT: the main number, read as before (registered), and nothing else asked", async () => {
  const w = await inWorld({ meters: "off" });
  assertEquals(w.out, { sent: true, id: "msg-1" });
  assertEquals(twilioFrom(w.fetched), [BUSINESS]);
  assertEquals(w.inserted.find((i) => i.table === "sms_messages")?.row.from_number, BUSINESS);
  assertEquals(w.filters.sms_numbers, [["eq:client_id=tenant-a", `eq:phone_number=${BUSINESS}`, "is:released_at=null"]]);
  // The main number named explicitly is the same path, byte for byte.
  const same = await inWorld({ meters: "off" }, { fromNumber: BUSINESS });
  assertEquals(same.out, { sent: true, id: "msg-1" });
  assertEquals(same.filters.sms_numbers, w.filters.sms_numbers);
});

Deno.test("fromNumber that passes all four checks: the text goes out FROM it, through the business's own service", async () => {
  const w = await inWorld({ meters: "off", numberRow: { registration_status: "registered", messaging_service_sid: SERVICE } }, { fromNumber: OTHER_LINE });
  assertEquals(w.out, { sent: true, id: "msg-1" });
  assertEquals(twilioFrom(w.fetched), [OTHER_LINE]);
  assertEquals(new URLSearchParams(String(twilioCalls(w.fetched)[0].body)).get("MessagingServiceSid"), SERVICE);
  assertEquals(w.inserted.find((i) => i.table === "sms_messages")?.row.from_number, OTHER_LINE, "the ledger row says which number it left from");
  // Read on THIS business, live rows only: another builder's number can never match.
  assertEquals(w.filters.sms_numbers, [["eq:client_id=tenant-a", `eq:phone_number=${OTHER_LINE}`, "is:released_at=null"]]);
});

Deno.test("fromNumber ANOTHER business's (or released, or made up): refused in words, no claim row, no send", async () => {
  const w = await inWorld({ meters: "off", numberRow: null }, { fromNumber: OTHER_LINE });
  assertEquals(w.out, { sent: false, reason: "not_active", error: FROM_NOT_OURS });
  assert(!w.db.includes("sms_messages:insert"), "no ledger row");
  assertEquals(twilioCalls(w.fetched).length, 0, "and never sent from the main number instead");
});

Deno.test("fromNumber not registered, or outside the business's Messaging Service: refused (30034 is silent)", async () => {
  for (const row of [
    { registration_status: "pending_registration", messaging_service_sid: SERVICE },
    { registration_status: "failed", messaging_service_sid: SERVICE },
    { registration_status: "registered", messaging_service_sid: null },
    { registration_status: "registered", messaging_service_sid: "MG" + "1".repeat(32) },
  ]) {
    const w = await inWorld({ meters: "off", numberRow: row }, { fromNumber: OTHER_LINE });
    assertEquals(w.out, { sent: false, reason: "not_active", error: FROM_NOT_READY }, JSON.stringify(row));
    assertEquals(twilioCalls(w.fetched).length, 0, JSON.stringify(row));
    assert(!w.db.includes("sms_messages:insert"), JSON.stringify(row));
  }
});

Deno.test("fromNumber whose check cannot be read: refused, never guessed", async () => {
  const w = await inWorld({ meters: "off", numberReadFails: true }, { fromNumber: OTHER_LINE });
  assertEquals(w.out.sent, false);
  assertEquals(w.out.reason, "failed");
  assertEquals(twilioCalls(w.fetched).length, 0);
});

// ── pickReplyNumber: the customer's thread, then the sender's own number, then the main one ──
const MAIN = "+15550100001", SALES = "+15550100003", MIKE = "+15550100004", CALLS_ONLY = "+15550100005";
const ME = "00000000-0000-4000-8000-0000000000a1";
const NUMS: ReplyNumberRow[] = [
  { phone_number: MAIN, registration_status: "registered", messaging_service_sid: SERVICE, assigned_user_id: null },
  { phone_number: SALES, registration_status: "registered", messaging_service_sid: SERVICE, assigned_user_id: null },
  { phone_number: MIKE, registration_status: "registered", messaging_service_sid: SERVICE, assigned_user_id: ME },
  { phone_number: CALLS_ONLY, registration_status: "pending_registration", messaging_service_sid: null, assigned_user_id: null },
];
type Thread = { direction: string | null; from_number: string | null; to_number: string | null };
const pick = (thread: Thread | null, over: Partial<Parameters<typeof pickReplyNumber>[0]> = {}) =>
  pickReplyNumber({ thread, numbers: NUMS, mainNumber: MAIN, serviceSid: SERVICE, userId: ME, ...over });

Deno.test("pickReplyNumber: the number the customer last texted, or we last texted them from", () => {
  assertEquals(pick({ direction: "in", from_number: "+15550100099", to_number: SALES }), SALES, "they texted the sales line");
  assertEquals(pick({ direction: "out", from_number: SALES, to_number: "+15550100099" }), SALES, "we last texted them from it");
  assertEquals(pick({ direction: "in", from_number: "+15550100099", to_number: MAIN }), null, "the main number is null: sendTenantSms's own path");
  assertEquals(pick({ direction: "out", from_number: MAIN, to_number: "+15550100099" }), null, "and the sender's own number does not override the customer's thread");
});

Deno.test("pickReplyNumber: no thread → the sender's own number; nobody's → the main number", () => {
  assertEquals(pick(null), MIKE);
  assertEquals(pick(null, { userId: "00000000-0000-4000-8000-0000000000b2" }), null);
  assertEquals(pick(null, { userId: null }), null);
  assertEquals(pick(null, { userId: ME.toUpperCase() }), MIKE, "ids compare without case");
});

Deno.test("pickReplyNumber: a number that can't text right now is skipped, so the reply still goes (from the next one)", () => {
  assertEquals(pick({ direction: "in", from_number: "+15550100099", to_number: CALLS_ONLY }), MIKE, "calling-only: the sender's own number next");
  assertEquals(pick({ direction: "in", from_number: "+15550100099", to_number: CALLS_ONLY }, { userId: null }), null, "then the main number");
  assertEquals(pick({ direction: "in", from_number: "+15550100099", to_number: "+15550100077" }, { userId: null }), null, "released (not live): the main number");
  assertEquals(pick({ direction: "in", from_number: "+15550100099", to_number: SALES }, { serviceSid: "MG" + "1".repeat(32) }), null, "outside the business's service");
  assertEquals(pick({ direction: "in", from_number: "+15550100099", to_number: SALES }, { serviceSid: null }), null, "no texting setup at all");
  assertEquals(pick({ direction: null, from_number: SALES, to_number: SALES }, { userId: null }), null, "a row with no direction says nothing");
});

// replyFromNumber's reads, against a fake that answers each table and records the filters.
function replyAdmin(o: { thread?: unknown[]; numbers?: unknown[] | "error"; main?: string | null; service?: string | null } = {}) {
  const asked: Record<string, string[]> = {};
  const admin = {
    from(table: string) {
      const seen: string[] = (asked[table] = []);
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "or", "order", "limit"]) {
        q[m] = (...a: unknown[]) => { seen.push(`${m}:${a.map((x) => typeof x === "object" && x !== null ? JSON.stringify(x) : String(x)).join(",")}`); return q; };
      }
      const rows = (): { data: unknown; error: unknown } => {
        if (table === "sms_messages") return { data: o.thread ?? [], error: null };
        if (table === "sms_numbers") return o.numbers === "error" ? { data: null, error: { code: "42703" } } : { data: o.numbers ?? NUMS, error: null };
        return { data: null, error: null };
      };
      q.maybeSingle = () => Promise.resolve(table === "client_settings"
        ? { data: { sms_number: o.main === undefined ? MAIN : o.main }, error: null }
        : table === "sms_registrations" ? { data: { messaging_service_sid: o.service === undefined ? SERVICE : o.service }, error: null } : rows());
      q.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(rows()).then(ok, bad);
      return q;
    },
  };
  return { admin, asked };
}

Deno.test("replyFromNumber: a saved customer's thread is read by contact, on this business, newest first", async () => {
  const { admin, asked } = replyAdmin({ thread: [{ direction: "in", from_number: "+15550100099", to_number: SALES }] });
  assertEquals(await replyFromNumber(admin, "tenant-a", { contactId: "contact-1", userId: ME }), SALES);
  assertEquals(asked.sms_messages, ["select:direction, from_number, to_number", "eq:client_id,tenant-a", "eq:contact_id,contact-1", 'order:created_at,{"ascending":false}', "limit:1"]);
  assert(asked.sms_numbers.includes("eq:client_id,tenant-a") && asked.sms_numbers.includes("is:released_at,null"), "only this business's live numbers");
});

Deno.test("replyFromNumber: an unknown number's thread is read by that number, among texts with no contact", async () => {
  const { admin, asked } = replyAdmin({ thread: [{ direction: "out", from_number: SALES, to_number: "+15550100099" }] });
  assertEquals(await replyFromNumber(admin, "tenant-a", { customerE164: "+15550100099" }), SALES);
  assert(asked.sms_messages.includes("is:contact_id,null"));
  assert(asked.sms_messages.includes("or:from_number.eq.+15550100099,to_number.eq.+15550100099"));
  // Anything that isn't a US number never reaches the filter (the filter is built from it).
  const bad = replyAdmin();
  assertEquals(await replyFromNumber(bad.admin, "tenant-a", { customerE164: "+15550100099,to_number.neq.x", userId: ME }), MIKE);
  assertEquals(bad.asked.sms_messages, undefined, "no thread read at all");
});

Deno.test("replyFromNumber: before migration 266, or with no texting setup, it is always the main number", async () => {
  assertEquals(await replyFromNumber(replyAdmin({ numbers: "error" }).admin, "tenant-a", { contactId: "c", userId: ME }), null);
  assertEquals(await replyFromNumber(replyAdmin({ service: null }).admin, "tenant-a", { contactId: "c", userId: ME }), null);
  const throws = { from() { throw new Error("boom"); } };
  assertEquals(await replyFromNumber(throws, "tenant-a", { contactId: "c" }), null, "never throws");
});

// ── Workstream 2: the account the text is sent from ─────────────────────────────────────────
// sendTenantSms resolves the tenant's Twilio account ONCE and hands it to sendSms as a value.
// Switch off: the parent from the environment and no lookup (the DISARMED test above already
// asserts zero RPCs with TWILIO_SUBACCOUNTS unset). On: the sub's path and the sub's key pair.
const SUB = "AC" + "5".repeat(32);
const SUB_KEY = "SK" + "5".repeat(32);
const SUB_SECRET = "subkeysecret" + "x".repeat(20);
const subRow = (status = "active") => ({
  client_id: "tenant-a", kind: "sub", account_sid: SUB, status, api_key_sid: SUB_KEY, api_secret: SUB_SECRET,
  auth_token: "subauthtoken" + "y".repeat(20), twiml_app_sid: null, push_apns_dev_sid: null, push_apns_prod_sid: null, push_fcm_sid: null,
});

Deno.test("switch OFF: the parent's path and pair, exactly as before, and no account lookup", async () => {
  for (const subaccounts of [undefined, "off"] as const) {
    const w = await inWorld({ meters: "off", subaccounts, accountRows: [subRow()] });
    assertEquals(w.out, { sent: true, id: "msg-1" });
    assertEquals(w.rpcs.length, 0, "twilio_account_creds is never asked while the switch is off");
    const tw = twilioCalls(w.fetched);
    assertEquals(tw.map((c) => c.url), [`https://api.twilio.com/2010-04-01/Accounts/${ENV.TWILIO_ACCOUNT_SID}/Messages.json`]);
    assertEquals(tw[0].auth, `Basic ${btoa(`${ENV.TWILIO_API_KEY}:${ENV.TWILIO_API_SECRET}`)}`);
  }
});

Deno.test("switch ON, a tenant on its own sub-account: sent from the sub's path with the sub's key, after one lookup", async () => {
  const w = await inWorld({ meters: "off", subaccounts: "on", accountRows: [subRow()] });
  assertEquals(w.out, { sent: true, id: "msg-1" });
  assertEquals(w.rpcs, [{ name: "twilio_account_creds", args: { p_client_id: "tenant-a" } }]);
  const tw = twilioCalls(w.fetched);
  assertEquals(tw.map((c) => c.url), [`https://api.twilio.com/2010-04-01/Accounts/${SUB}/Messages.json`]);
  assertEquals(tw[0].auth, `Basic ${btoa(`${SUB_KEY}:${SUB_SECRET}`)}`);
});

Deno.test("switch ON, no row: still the parent's", async () => {
  const w = await inWorld({ meters: "off", subaccounts: "on", accountRows: [] });
  assertEquals(w.out, { sent: true, id: "msg-1" });
  assertEquals(twilioCalls(w.fetched)[0].url, `https://api.twilio.com/2010-04-01/Accounts/${ENV.TWILIO_ACCOUNT_SID}/Messages.json`);
});

Deno.test("switch ON, a sub that is not active yet: not switched on, nothing claimed, nothing sent", async () => {
  const w = await inWorld({ meters: "off", subaccounts: "on", accountRows: [subRow("provisioning")] });
  assertEquals(w.out, { sent: false, reason: "not_active" });
  assertEquals(twilioCalls(w.fetched).length, 0);
  assert(!w.db.includes("sms_messages:insert"));
});

Deno.test("switch ON, the lookup fails: this tenant's text fails CLOSED (never the parent's credentials) and is logged", async () => {
  const w = await inWorld({ meters: "off", subaccounts: "on", accountRows: "error" });
  assertEquals(w.out, { sent: false, reason: "failed", error: "The text could not be sent. Try again." });
  assertEquals(twilioCalls(w.fetched).length, 0);
  assert(!w.db.includes("sms_messages:insert"));
  assertEquals(errorRows(w.fetched).map((r) => r.code), ["twilio_account_lookup_failed"]);
});
