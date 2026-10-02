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
// Both dependencies are stubbed: globalThis.fetch (Twilio, wallet-autotopup and app_errors) and
// a recording fake of the supabase client. smsSend.ts reaches supabase-js through logError.ts,
// the same way emailSend.test.ts's subject does; no network is used.
// Run: deno test --allow-env --node-modules-dir=none supabase/functions/_shared/smsSend.test.ts

import { sendTenantSms, type TenantSms } from "./smsSend.ts";

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

type Fetched = { url: string; method: string; body: string | null };
type World = {
  meters: "on" | "off" | undefined;
  /** wallet_usage_gate's reply, or "error" for a PostgREST error. */
  gate?: Record<string, unknown> | "error";
  optedOut?: boolean;
};

async function inWorld(world: World, msg: Partial<TenantSms> = {}) {
  const env = { ...ENV, PHONE_USAGE_METERS: world.meters };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(env)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);

  const fetched: Fetched[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetched.push({ url, method: (init?.method ?? "GET").toUpperCase(), body: typeof init?.body === "string" ? init.body : null });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    if (url.includes("api.twilio.com")) return Promise.resolve(json({ sid: "SM" + "0".repeat(32), num_segments: "1", status: "queued" }, 201));
    if (url.endsWith("/functions/v1/wallet-autotopup")) return Promise.resolve(json({ fired: true, ok: true, reason: "charged" }));
    if (url.includes("/rest/v1/app_errors")) return Promise.resolve(json([], 201));
    return Promise.resolve(json({ message: `unexpected fetch ${url}` }, 500));
  }) as typeof fetch;

  const db: string[] = [];
  const rpcs: { name: string; args: unknown }[] = [];
  const admin = {
    rpc(name: string, args: unknown) {
      rpcs.push({ name, args });
      if (world.gate === "error") return Promise.resolve({ data: null, error: { message: "function public.wallet_usage_gate does not exist" } });
      return Promise.resolve({ data: world.gate ?? null, error: null });
    },
    from(table: string) {
      const ops: string[] = [];
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "limit", "upsert"]) q[m] = () => { ops.push(m); return q; };
      q.insert = () => { ops.push("insert"); return q; };
      q.update = () => { ops.push("update"); return q; };
      const row = (): unknown => {
        switch (table) {
          case "client_settings": return { sms_number: BUSINESS, sms_status: "active" };
          case "sms_registrations": return { status: "active", messaging_service_sid: "MG" + "0".repeat(32) };
          case "sms_numbers": return { registration_status: "registered" };
          case "sms_opt_outs": return world.optedOut ? { reason: "sms_stop" } : null;
          case "sms_consent_log": return { action: "granted" };
          case "crm_contacts": return { sms_opt_out_at: null };
          default: return null;
        }
      };
      q.maybeSingle = () => { db.push(`${table}:read`); return Promise.resolve({ data: row(), error: null }); };
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
    return { out, fetched, db, rpcs, kept };
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
