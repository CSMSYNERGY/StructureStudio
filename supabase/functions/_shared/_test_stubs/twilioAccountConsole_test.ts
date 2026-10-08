// Workstream 2, phase 9: the operator console's Twilio sub-account actions, driven through the
// SHIPPED admin-catalog handler (the deleteClientHarness idiom: Deno.serve stubbed at import, the
// import map's supabase stub routing every table and rpc into a fake, globalThis.fetch a fake
// Twilio, no --allow-net), on the ADMIN_PASSWORD path.
//
// What is pinned:
//   * twilio_account_provision makes the first TEST sub while TWILIO_SUBACCOUNTS is OFF, but only
//     for a builder the operator typed (confirmClientId) and only one that is not pinned to the
//     parent (our internal account, or anything already held there); a sub the parent's API key
//     alone cannot make is refused with the secret to set; the same button reactivates a
//     suspended sub; every outcome is audited with a MASKED SID;
//   * twilio_account_get: masked SIDs and what exists, never a full SID or a secret; `check` asks
//     Twilio whether the stored credentials are accepted;
//   * twilio_account_suspend / _close: done with the parent's token; close is typed and REFUSED
//     while the sub still has a number;
//   * delete_client closes the sub FIRST (before the gateway and every wipe), refuses with nothing
//     done while it has a number, and removes the account row last, before client_configs;
//   * the money grant: provision and close need can_bill, get is a read (source checks).
// Tenants, SIDs and secrets are made up (the repo is public).

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert@1";
import { stubDb, stubRpc } from "./supabase_stub.ts";
import { deleteClient, firstWipe, loadAdminCatalog, TENANT } from "./deleteClientHarness.ts";

// One module instance per test file (nmi.ts reads its keys at load): loaded with the gateway
// configured, which the twilio_account_* actions never touch and delete_client needs.
const HANDLER = await loadAdminCatalog(true);
const ADMIN_PASSWORD = "admin-password-test";
const PARENT = "AC" + "0".repeat(32);
const PARENT_TOKEN = "parentauthtoken" + "p".repeat(17);
const BASE_ENV: Record<string, string> = {
  SUPABASE_URL: "https://project.example.test", SUPABASE_SERVICE_ROLE_KEY: "service-role-test", ADMIN_PASSWORD,
  TWILIO_ACCOUNT_SID: PARENT, TWILIO_AUTH_TOKEN: PARENT_TOKEN, TWILIO_API_KEY: "SK" + "0".repeat(32), TWILIO_API_SECRET: "parent-api-secret",
  PHONE_API_BASE: "https://phone.example.test", PHONE_WEBHOOK_SECRET: "voicekey123", PHONE_FALLBACK_URL: "https://fallback.example.test/bin",
  TWILIO_EVENTS_SECRET: "eventskey456",
};

// ── A small database: the tables these actions touch ────────────────────────────────────────
type Row = Record<string, any>;
class Db {
  accounts = new Map<string, Row>();
  settings = new Map<string, Row>();
  holdings = new Map<string, string>();
  liveNumbers = 0;
  vault = new Map<string, string>();
  audits: Row[] = [];

  from(table: string) {
    // deno-lint-ignore no-this-alias
    const db = this;
    const q: { op: string; patch?: Row; f: Array<(r: Row) => boolean>; sel?: boolean; head?: boolean } = { op: "select", f: [] };
    const rows = (): Row[] => {
      if (table === "twilio_accounts") return [...db.accounts.values()];
      if (table === "client_settings") return [...db.settings.values()];
      if (table === "client_configs") return [{ client_id: TENANT }];
      return [];
    };
    const run = (single: boolean) => {
      if (table === "admin_audit" && q.op === "insert") { db.audits.push(q.patch!); return { data: null, error: null }; }
      if (table === "admin_auth_attempts") return { data: null, error: null };
      if (table === "sms_numbers") return { data: null, count: db.liveNumbers, error: null };
      const hit = rows().filter((r) => q.f.every((fn) => fn(r)));
      if (q.op === "select") return { data: single ? (hit[0] ? { ...hit[0] } : null) : hit, count: hit.length, error: null };
      if (q.op === "update") {
        for (const r of hit) Object.assign(r, q.patch);
        return { data: q.sel ? (single ? hit[0] ?? null : hit.map((r) => ({ ...r }))) : null, error: null };
      }
      if (q.op === "upsert") {
        const r = q.patch!;
        if (!db.accounts.has(r.client_id)) {
          db.accounts.set(r.client_id, {
            client_id: r.client_id, kind: r.kind, account_sid: null, status: r.status, api_key_sid: null, api_secret_id: null, auth_token_id: null,
            twiml_app_sid: null, push_apns_dev_sid: null, push_apns_prod_sid: null, push_fcm_sid: null, events_sink_sid: null,
            events_subscription_sid: null, provision_step: r.provision_step ?? null, provision_lock_until: null, last_error: null, push_skipped: null,
          });
        }
        return { data: null, error: null };
      }
      return { data: null, error: null };
    };
    const b: any = {
      select: (_c?: string, o?: Row) => { if (q.op === "select") q.head = !!o?.head; else q.sel = true; return b; },
      insert: (p: Row) => { q.op = "insert"; q.patch = p; return b; },
      update: (p: Row) => { q.op = "update"; q.patch = p; return b; },
      upsert: (p: Row) => { q.op = "upsert"; q.patch = p; return b; },
      delete: () => { q.op = "delete"; return b; },
      eq: (c: string, v: unknown) => { q.f.push((r) => r[c] === v); return b; },
      is: (c: string, v: unknown) => { q.f.push((r) => (r[c] ?? null) === v); return b; },
      lt: () => b,
      or: (expr: string) => {
        q.f.push((r) => expr.split(",").some((part) => {
          const [c, op, ...rest] = part.split(".");
          if (op === "is") return (r[c] ?? null) === null;
          return r[c] != null && Date.parse(String(r[c])) < Date.parse(rest.join("."));
        }));
        return b;
      },
      maybeSingle: () => Promise.resolve(run(true)),
      single: () => Promise.resolve(run(true)),
      then: (res: any, rej: any) => Promise.resolve(run(false)).then(res, rej),
    };
    return b;
  }

  rpc(fn: string, args: Row) {
    if (fn === "twilio_parent_holdings") return Promise.resolve({ data: this.holdings.get(args.p_client_id) ?? null, error: null });
    if (fn === "twilio_account_secret_put") {
      const row = this.accounts.get(args.p_client_id)!;
      const name = `twilio_${args.p_kind}_${row.account_sid}`;
      this.vault.set(name, args.p_secret);
      row[args.p_kind === "auth_token" ? "auth_token_id" : "api_secret_id"] = name;
      return Promise.resolve({ data: null, error: null });
    }
    if (fn === "twilio_account_creds") {
      const row = this.accounts.get(args.p_client_id);
      if (!row) return Promise.resolve({ data: [], error: null });
      return Promise.resolve({ data: [{ ...row, auth_token: this.vault.get(String(row.auth_token_id)) ?? null, api_secret: this.vault.get(String(row.api_secret_id)) ?? null }], error: null });
    }
    if (fn === "twilio_push_material") {
      return Promise.resolve({ data: [
        { kind: "apns_dev", certificate: "cert-dev", private_key: "key-dev", secret: null },
        { kind: "apns_prod", certificate: null, private_key: null, secret: null },
        { kind: "fcm", certificate: null, private_key: null, secret: '{"type":"service_account"}' },
      ], error: null });
    }
    return Promise.reject(new Error(`unexpected rpc ${fn}`));
  }
}

// ── A small Twilio: one sub, made and changed through the REST calls provisioning sends ───────
class Twilio {
  calls: { method: string; url: URL; auth: string; form: URLSearchParams }[] = [];
  sub: { sid: string; token: string; status: string } | null = null;
  key: { sid: string; secret: string } | null = null;
  numbers: string[] = [];
  private seq = 0;
  private id(prefix: string) { return prefix + String(++this.seq).padStart(32, "1"); }

  fetch = (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const form = new URLSearchParams(String(init?.body ?? ""));
    this.calls.push({ method, url, auth, form });
    const j = (v: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(v), { status }));
    const p = url.pathname;
    if (url.host === "api.twilio.com") {
      if (p.endsWith("/Accounts.json")) {
        if (method === "GET") return j({ accounts: this.sub ? [{ sid: this.sub.sid, friendly_name: TENANT, status: this.sub.status, auth_token: this.sub.token }] : [] });
        this.sub = { sid: this.id("AC"), token: "subtoken" + "t".repeat(24), status: "active" };
        return j({ sid: this.sub.sid, auth_token: this.sub.token }, 201);
      }
      if (/\/IncomingPhoneNumbers\.json$/.test(p)) return j({ incoming_phone_numbers: this.numbers.map((n) => ({ phone_number: n })) });
      if (/\/Applications\.json$/.test(p)) return method === "GET" ? j({ applications: [] }) : j({ sid: this.id("AP") }, 201);
      if (/\/Accounts\/AC\w+\.json$/.test(p)) {
        if (method === "POST") { this.sub!.status = form.get("Status")!; return j({ status: this.sub!.status }); }
        const ok = auth === `Basic ${btoa(`${this.sub?.sid}:${this.sub?.token}`)}` || auth === `Basic ${btoa(`${this.key?.sid}:${this.key?.secret}`)}` || auth.includes(btoa(`${PARENT}:`).slice(0, 10));
        return ok ? j({ sid: this.sub?.sid, auth_token: this.sub?.token }) : j({ code: 20003 }, 401);
      }
    }
    if (url.host === "iam.twilio.com") {
      if (method === "GET") return j({ keys: [] });
      this.key = { sid: this.id("SK"), secret: "keysecret" + "k".repeat(23) };
      return j({ sid: this.key.sid, secret: this.key.secret }, 201);
    }
    if (url.host === "chat.twilio.com") return method === "GET" ? j({ credentials: [] }) : j({ sid: this.id("CR") }, 201);
    if (url.host === "events.twilio.com") {
      if (p.endsWith("/Test")) return j({ result: "submitted" });
      if (p.endsWith("/Sinks")) return method === "GET" ? j({ sinks: [] }) : j({ sid: this.id("DG") }, 201);
      if (p.endsWith("/Subscriptions")) return method === "GET" ? j({ subscriptions: [] }) : j({ sid: this.id("DF") }, 201);
    }
    if (url.host === "voice.twilio.com") return j({ dialing_permissions_inheritance: true });
    return Promise.reject(new Error(`unexpected fetch ${method} ${url.href}`));
  };
}

async function act(db: Db, tw: Twilio, body: Record<string, unknown>, env: Record<string, string | undefined> = {}) {
  const all: Record<string, string | undefined> = { ...BASE_ENV, ...env };
  const prior = Object.fromEntries(Object.keys(all).concat("TWILIO_SUBACCOUNTS").map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(all)) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
  if (!("TWILIO_SUBACCOUNTS" in env)) Deno.env.delete("TWILIO_SUBACCOUNTS");
  const realFetch = globalThis.fetch;
  globalThis.fetch = tw.fetch as typeof fetch;
  stubDb.from = (t: string) => db.from(t);
  stubRpc.rpc = (fn: string, a?: any) => db.rpc(fn, a ?? {});
  try {
    const res = await HANDLER(new Request("http://localhost/functions/v1/admin-catalog", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.9" },
      body: JSON.stringify({ adminPassword: ADMIN_PASSWORD, clientId: TENANT, ...body }),
    }));
    const raw = await res.text();
    return { status: res.status, body: JSON.parse(raw), raw };
  } finally {
    globalThis.fetch = realFetch;
    stubDb.from = null;
    stubRpc.rpc = null;
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
  }
}

// ── provision ────────────────────────────────────────────────────────────────────────────────
Deno.test("provision: makes the first test sub with the switch OFF, only for the builder typed; audited with a masked SID", async () => {
  const db = new Db(), tw = new Twilio();
  const wrong = await act(db, tw, { action: "twilio_account_provision", confirmClientId: "someone-else" });
  assertEquals(wrong.status, 400);
  assert(/Confirmation text does not match/.test(wrong.body.error));
  assertEquals(tw.calls.length, 0, "nothing reached Twilio");

  const r = await act(db, tw, { action: "twilio_account_provision", confirmClientId: TENANT });
  assertEquals(r.status, 200, r.raw);
  assertEquals([r.body.account.kind, r.body.account.status, r.body.account.step, r.body.account.switchOn], ["sub", "active", "done", false]);
  assertEquals(r.body.pushSkipped, ["apns_prod"], "material missing in Vault is skipped and said");
  assertEquals(r.body.account.accountSid, `AC…${tw.sub!.sid.slice(-4)}`);
  assert(!r.raw.includes(tw.sub!.sid) && !r.raw.includes(tw.sub!.token) && !r.raw.includes(tw.key!.secret), "no full SID or secret in the response");
  const audit = db.audits.find((a) => a.action === "twilio_account_provision");
  assert(audit && /^via=password provisioned sid=AC…\w{4} push_skipped=apns_prod$/.test(audit.note), JSON.stringify(db.audits));
  assert(!JSON.stringify(db.audits).includes(tw.sub!.sid), "the audit row carries a masked SID only");
  // Made with the parent's SID + auth token, named for the client id.
  const made = tw.calls.find((c) => c.method === "POST" && c.url.pathname.endsWith("/Accounts.json"))!;
  assertEquals([made.auth, made.form.get("FriendlyName")], [`Basic ${btoa(`${PARENT}:${PARENT_TOKEN}`)}`, TENANT]);
});

Deno.test("provision: a builder pinned to the parent (our internal account, or anything held there) stays there: 409, Twilio never asked", async () => {
  for (const setup of [(db: Db) => db.settings.set(TENANT, { client_id: TENANT, internal_account: true }), (db: Db) => db.holdings.set(TENANT, "a live number")]) {
    const db = new Db(), tw = new Twilio();
    setup(db);
    const r = await act(db, tw, { action: "twilio_account_provision", confirmClientId: TENANT });
    assertEquals(r.status, 409, r.raw);
    assert(/stays on the parent account/.test(r.body.error), r.body.error);
    assertEquals(tw.calls.length, 0);
  }
});

Deno.test("provision: the parent's API key without its auth token is refused, naming the secret to set", async () => {
  const db = new Db(), tw = new Twilio();
  const r = await act(db, tw, { action: "twilio_account_provision", confirmClientId: TENANT }, { TWILIO_AUTH_TOKEN: undefined });
  assertEquals(r.status, 503, r.raw);
  assertEquals([r.body.reason, r.body.code, r.body.missing], ["not_configured", "parent_token_missing", ["TWILIO_AUTH_TOKEN"]]);
  assert(/set TWILIO_AUTH_TOKEN/.test(r.body.error), r.body.error);
  assertEquals(tw.calls.length, 0);
  assert(!db.accounts.has(TENANT), "no row was made");
});

// ── get, suspend, reactivate, close ──────────────────────────────────────────────────────────
Deno.test("get with check: masked, and Twilio says whether the stored credentials are accepted", async () => {
  const db = new Db(), tw = new Twilio();
  await act(db, tw, { action: "twilio_account_provision", confirmClientId: TENANT });
  const r = await act(db, tw, { action: "twilio_account_get", check: true });
  assertEquals(r.status, 200, r.raw);
  assertEquals(r.body.account.tokenCheck, { authToken: "ok", apiKey: "ok" });
  assertEquals(r.body.account.push, { apns_dev: true, apns_prod: false, fcm: true });
  assert(!r.raw.includes(tw.sub!.sid) && !r.raw.includes(tw.sub!.token));
  const none = await act(new Db(), new Twilio(), { action: "twilio_account_get" });
  assertEquals([none.status, none.body.account.kind], [200, "none"]);
});

Deno.test("suspend, then the same Create button reactivates; close is typed, refused while the sub has a number, then final", async () => {
  const db = new Db(), tw = new Twilio();
  await act(db, tw, { action: "twilio_account_provision", confirmClientId: TENANT });
  const s = await act(db, tw, { action: "twilio_account_suspend" });
  assertEquals([s.status, s.body.status, tw.sub!.status], [200, "suspended", "suspended"]);
  const back = await act(db, tw, { action: "twilio_account_provision", confirmClientId: TENANT });
  assertEquals([back.status, back.body.reactivated, tw.sub!.status], [200, true, "active"]);

  assertEquals((await act(db, tw, { action: "twilio_account_close", confirmClientId: "nope" })).status, 400);
  db.liveNumbers = 1;
  const held = await act(db, tw, { action: "twilio_account_close", confirmClientId: TENANT });
  assertEquals(held.status, 409, held.raw);
  assert(/still has 1 number/.test(held.body.error), held.body.error);
  db.liveNumbers = 0;
  tw.numbers = ["+15555550100"];
  assertEquals((await act(db, tw, { action: "twilio_account_close", confirmClientId: TENANT })).status, 409, "a number only Twilio knows about refuses it too");
  assertEquals(tw.sub!.status, "active", "nothing was closed");
  tw.numbers = [];
  const closed = await act(db, tw, { action: "twilio_account_close", confirmClientId: TENANT });
  assertEquals([closed.status, closed.body.status, tw.sub!.status, db.accounts.get(TENANT)!.status], [200, "closed", "closed", "closed"]);
  const again = await act(db, tw, { action: "twilio_account_provision", confirmClientId: TENANT });
  assertEquals(again.status, 403, "a closed sub is final");
  // Each Twilio-touching outcome has its own audit row.
  assert(db.audits.some((a) => a.action === "twilio_account_close" && /refused has_numbers/.test(a.note)));
  assert(db.audits.some((a) => a.action === "twilio_account_close" && /done$/.test(a.note)));
});

// ── delete_client ────────────────────────────────────────────────────────────────────────────
const SUB = "AC" + "7".repeat(32);
const DELETE_HANDLER = HANDLER;

Deno.test("delete_client: a sub that still has a number refuses the whole delete with NOTHING done (no close, no gateway, no wipe)", async () => {
  const r = await deleteClient(DELETE_HANDLER, {
    subs: [{ id: "4000000001", status: "active" }], vault: null,
    twilio: { row: { kind: "sub", status: "active", account_sid: SUB }, numbers: ["+15555550100"] },
  });
  assertEquals(r.status, 409, r.raw);
  assert(/Nothing was deleted\./.test(r.body.error), r.body.error);
  assertEquals([r.wipes, r.gatewayCalls.length], [[], 0]);
  assert(!r.twilioCalls.some((c) => c.startsWith("POST ")), `the sub was changed: ${r.twilioCalls.join(", ")}`);
});

Deno.test("delete_client: the sub is closed FIRST, before the gateway and every wipe; its row goes last, before client_configs", async () => {
  const r = await deleteClient(DELETE_HANDLER, {
    subs: [{ id: "4000000001", status: "active" }], vault: null,
    twilio: { row: { kind: "sub", status: "active", account_sid: SUB } },
  });
  assertEquals(r.status, 200, r.raw);
  const close = r.log.indexOf(`tw POST /2010-04-01/Accounts/${SUB}.json`);
  const firstGateway = r.log.findIndex((l) => l.startsWith("gw "));
  assert(close >= 0 && close < firstGateway && close < firstWipe(r), `order:\n${r.log.join("\n")}`);
  const forget = r.log.indexOf("db rpc twilio_account_forget");
  const configs = r.log.lastIndexOf("db delete client_configs");
  assert(forget > firstWipe(r) && forget < configs, `the row goes last, before client_configs:\n${r.log.join("\n")}`);
  assertEquals(r.body.twilio, { closed: true });
  assertEquals(r.body.deleted.twilio_accounts, 1);
  assert(r.audits.some((a) => /twilio closed sid=AC…7777$/.test(a.note)), JSON.stringify(r.audits));
});

Deno.test("delete_client: Twilio refusing the close refuses the delete (502), nothing else done", async () => {
  const r = await deleteClient(DELETE_HANDLER, {
    subs: [], vault: null, twilio: { row: { kind: "sub", status: "suspended", account_sid: SUB }, closeStatus: 400 },
  });
  assertEquals(r.status, 502, r.raw);
  assertEquals([r.wipes, r.gatewayCalls.length], [[], 0]);
});

Deno.test("delete_client: a parent pin closes nothing at Twilio; the pin goes with the tenant", async () => {
  const r = await deleteClient(DELETE_HANDLER, { subs: [], vault: null, twilio: { row: { kind: "parent", status: "active", account_sid: null } } });
  assertEquals(r.status, 200, r.raw);
  assertEquals(r.twilioCalls, []);
  assert(r.log.includes("db rpc twilio_account_forget"));
  assertEquals(r.body.twilio, undefined);
});

// ── Source: the money grant and the read ─────────────────────────────────────────────────────
const SRC = (await Deno.readTextFile(new URL("../../admin-catalog/index.ts", import.meta.url))).replace(/\r\n/g, "\n");
Deno.test("source: provision and close are on can_bill, get is a read, suspend needs can_write", () => {
  assert(/\(String\(action \?\? ""\) === "twilio_account_provision" \|\| String\(action \?\? ""\) === "twilio_account_close"\) && !identity\.canBill/.test(SRC),
    "provision and close must require can_bill");
  const reads = /const READ_ONLY_ACTIONS = new Set\(\[([\s\S]*?)\]\);/.exec(SRC)?.[1] ?? "";
  assert(reads.includes('"twilio_account_get"'), "twilio_account_get is a read");
  for (const a of ["twilio_account_provision", "twilio_account_suspend", "twilio_account_close"]) assert(!reads.includes(`"${a}"`), `${a} must not be a read`);
  // Typed confirmation on the two that cannot be taken back lightly.
  const prov = SRC.slice(SRC.indexOf('case "twilio_account_provision": {'), SRC.indexOf('case "twilio_account_suspend":'));
  assert(prov.includes('if (reqStr(p.confirmClientId, "confirmClientId") !== clientId) {'));
  assert(prov.includes("ensureTwilioAccount(sb, clientId, { get, operator: true })"), "the operator path is the only one that runs with the switch off");
  const close = SRC.slice(SRC.indexOf('case "twilio_account_close": {'), SRC.indexOf('case "delete_client": {'));
  assert(close.includes('if (closing && reqStr(p.confirmClientId, "confirmClientId") !== clientId) {'));
});
