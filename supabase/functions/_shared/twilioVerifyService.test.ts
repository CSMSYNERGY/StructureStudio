/**
 * Unit tests for each builder's own Verify service (twilioVerifyService.ts): which service a login
 * code uses (builderVerifyTarget) and how the service is made, adopted, renamed and recorded
 * (syncVerifyService). Twilio and the database are both fakes: no network, no Supabase, no text.
 *
 * What matters most: a builder's service is only ever made or renamed with the SUB's credentials
 * (the parent's only READ the parent's own settings), never made twice (adoption, the lock, a lost
 * lock deleting what it made), and a lookup that fails sends the code on the parent's service
 * rather than failing the customer's login.
 *
 * Run: deno test --allow-env --node-modules-dir=none twilioVerifyService.test.ts   (from _shared/)
 */

// deno-lint-ignore-file no-explicit-any
import {
  builderServiceName, builderVerifyTarget, copiedSettings, serviceForm, syncVerifyService,
  type VerifyHttp, verifySyncSentence,
} from "./twilioVerifyService.ts";
import { _resetTwilioAccountCaches } from "./twilioAccount.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}
function assertEquals<T>(actual: T, expected: T, msg = ""): void {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`Expected ${e}, got ${a}${msg ? ` — ${msg}` : ""}`);
}

// Clearly fake (this repo is PUBLIC): the right shapes, all zeros.
const hex = (n: number) => "0".repeat(31) + String(n);
const SUB_SID = "AC" + hex(1);
const SUB_KEY = "SK" + hex(2);
const SUB_SECRET = "sub-key-secret";
const PARENT_SVC = "VA" + hex(3);
const BUILDER_SVC = "VA" + hex(4);
const OTHER_SVC = "VA" + hex(5);
const MADE_SVC = "VA" + hex(6);
const TENANT = "example-builder";

const PARENT_SETTINGS = {
  sid: PARENT_SVC, friendly_name: "Structure Studio", code_length: 6, lookup_enabled: false,
  skip_sms_to_landlines: false, do_not_share_warning_enabled: false, dtmf_input_required: true,
  psd2_enabled: false, custom_code_enabled: false, default_template_sid: "", tts_name: "",
  totp: { issuer: "Somebody" },
};
const builderSvc = (sid: string, name: string, extra: Record<string, unknown> = {}) => ({
  ...PARENT_SETTINGS, sid, friendly_name: name, date_created: "2026-10-21T10:00:00Z", ...extra,
});

const ENV: Record<string, string> = {
  TWILIO_SUBACCOUNTS: "on",
  TWILIO_VERIFY_API_KEY: "SKparentverifykey",
  TWILIO_VERIFY_API_SECRET: "parent-verify-secret",
  TWILIO_VERIFY_SERVICE_SID: PARENT_SVC,
};
const getFrom = (env: Record<string, string>) => (k: string) => env[k];

/** Deno.env for parentVerifyTarget (twilioVerify.ts reads it at request time). */
function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const names = [...new Set([...Object.keys(ENV), ...Object.keys(env)])];
  const keep = Object.fromEntries(names.map((k) => [k, Deno.env.get(k)]));
  for (const k of names) {
    if (env[k] !== undefined) Deno.env.set(k, env[k]);
    else Deno.env.delete(k);
  }
  _resetTwilioAccountCaches();
  return fn().finally(() => {
    for (const [k, v] of Object.entries(keep)) {
      if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v);
    }
  });
}

// ── The fake database ──────────────────────────────────────────────────────────────────────

type Row = Record<string, any>;

class FakeAdmin {
  tables: Record<string, Row[]> = {
    twilio_accounts: [{
      client_id: TENANT, kind: "sub", status: "active", account_sid: SUB_SID,
      verify_service_sid: null, verify_service_name: null, provision_lock_until: null,
    }],
    client_settings: [{ client_id: TENANT, business_name: "Example Barns & Sheds, LLC" }],
    client_configs: [{ client_id: TENANT, company_name: "Example Builder" }],
  };
  creds: Row | null = { client_id: TENANT, kind: "sub", account_sid: SUB_SID, status: "active", api_key_sid: SUB_KEY, api_secret: SUB_SECRET, auth_token: "sub-token" };
  /** Make the next read of `table` fail with this Postgres code. */
  failRead: Record<string, string> = {};
  touched: string[] = [];
  get row(): Row { return this.tables.twilio_accounts[0]; }
  from = (table: string) => { this.touched.push(table); return new Q(this, table); };
  rpc = (fn: string, args: any) => {
    this.touched.push(`rpc:${fn}`);
    if (fn !== "twilio_account_creds") throw new Error(`unexpected rpc ${fn}`);
    return Promise.resolve({ data: this.creds && this.creds.client_id === args.p_client_id ? [{ ...this.creds }] : [], error: null });
  };
}

class Q {
  private op: "select" | "update" = "select";
  private patch: Row | null = null;
  private returning = false;
  private filters: ((r: Row) => boolean)[] = [];
  constructor(private db: FakeAdmin, private table: string) {}
  select(_c?: string) { if (this.op === "update") this.returning = true; return this; }
  update(p: Row) { this.op = "update"; this.patch = p; return this; }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
  // Only the lock's shape: "provision_lock_until.is.null,provision_lock_until.lt.<iso>".
  or(expr: string) {
    const m = /^provision_lock_until\.is\.null,provision_lock_until\.lt\.(.+)$/.exec(expr);
    if (!m) throw new Error(`FakeAdmin: unexpected or(${expr})`);
    const iso = m[1];
    this.filters.push((r) => r.provision_lock_until == null || String(r.provision_lock_until) < iso);
    return this;
  }
  maybeSingle() { return this.run().then((r) => ({ data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error })); }
  then<T>(ok: (v: any) => T, bad?: (e: unknown) => T) { return this.run().then(ok, bad); }
  private run(): Promise<{ data: any; error: any }> {
    const code = this.db.failRead[this.table];
    if (code && this.op === "select") { delete this.db.failRead[this.table]; return Promise.resolve({ data: null, error: { code } }); }
    const rows = this.db.tables[this.table];
    if (!rows) throw new Error(`FakeAdmin: unexpected table ${this.table}`);
    const hit = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.op === "select") return Promise.resolve({ data: hit.map((r) => ({ ...r })), error: null });
    for (const r of hit) Object.assign(r, this.patch);
    return Promise.resolve({ data: this.returning ? hit.map((r) => ({ ...r })) : null, error: null });
  }
}

// ── The fake Twilio ────────────────────────────────────────────────────────────────────────

type Req = { method: string; url: string; user: string; form: Record<string, string> };

/** Twilio's Verify API over an in-memory set of the SUB's services. */
function fakeTwilio(subServices: Row[], opts: {
  parent?: () => { status: number; body: any };
  create?: () => { status: number; body: any };
  onCreate?: () => void;
} = {}): { http: VerifyHttp; reqs: Req[]; services: Row[] } {
  const reqs: Req[] = [];
  const services = subServices;
  const http: VerifyHttp = (method, url, auth, form) => {
    reqs.push({ method, url, user: auth.user, form: Object.fromEntries(form ?? []) });
    const base = "https://verify.twilio.com/v2/Services";
    if (method === "GET" && url === `${base}/${PARENT_SVC}`) {
      if (auth.user !== "SKparentverifykey") return Promise.resolve({ status: 404, body: { code: 20404 } });
      return Promise.resolve(opts.parent ? opts.parent() : { status: 200, body: PARENT_SETTINGS });
    }
    if (auth.user !== SUB_KEY) return Promise.resolve({ status: 404, body: { code: 20404 } });
    if (method === "GET" && url === `${base}?PageSize=50`) return Promise.resolve({ status: 200, body: { services: services.map((s) => ({ ...s })) } });
    if (method === "POST" && url === base) {
      opts.onCreate?.();
      if (opts.create) return Promise.resolve(opts.create());
      const made = builderSvc(MADE_SVC, String(form?.find(([k]) => k === "FriendlyName")?.[1] ?? ""), { date_created: "2026-10-21T12:00:00Z" });
      services.push(made);
      return Promise.resolve({ status: 201, body: made });
    }
    const one = new RegExp(`^${base}/(VA[0-9a-f]{32})$`).exec(url);
    if (one) {
      const svc = services.find((s) => s.sid === one[1]);
      if (!svc) return Promise.resolve({ status: 404, body: { code: 20404 } });
      if (method === "DELETE") { services.splice(services.indexOf(svc), 1); return Promise.resolve({ status: 204, body: {} }); }
      if (method === "POST") { if (form?.some(([k]) => k === "FriendlyName")) svc.friendly_name = form.find(([k]) => k === "FriendlyName")![1]; return Promise.resolve({ status: 200, body: svc }); }
    }
    return Promise.resolve({ status: 599, body: {} });
  };
  return { http, reqs, services };
}

const sync = (db: FakeAdmin, http: VerifyHttp, env = ENV) =>
  withEnv(env, () => syncVerifyService(db, TENANT, { get: getFrom(env), http }));

// ── Names and settings ─────────────────────────────────────────────────────────────────────

Deno.test("builderServiceName: business name first, company name when it has nothing usable", () => {
  assertEquals(builderServiceName("Example Barns & Sheds, LLC", "Other"), "Example Barns Sheds LLC");
  assertEquals(builderServiceName("!!!", "Example Builder"), "Example Builder");
  assertEquals(builderServiceName(null, ""), "");
});

Deno.test("copiedSettings + serviceForm: the parent's flags and code length, only what differs on an update", () => {
  const s = copiedSettings(PARENT_SETTINGS);
  assertEquals([...s.keys()], ["code_length", "lookup_enabled", "skip_sms_to_landlines", "do_not_share_warning_enabled",
    "dtmf_input_required", "psd2_enabled", "custom_code_enabled"], "empty strings and nested blocks are not copied");
  const create = serviceForm("Example Barns", s);
  assertEquals(create[0], ["FriendlyName", "Example Barns"]);
  assertEquals(Object.fromEntries(create).CodeLength, "6");
  assertEquals(Object.fromEntries(create).LookupEnabled, "false");
  assertEquals(serviceForm("Example Barns", s, builderSvc(BUILDER_SVC, "Example Barns")), [], "nothing differs");
  assertEquals(serviceForm("New Name", s, builderSvc(BUILDER_SVC, "Old Name", { code_length: 4 })),
    [["FriendlyName", "New Name"], ["CodeLength", "6"]]);
  assertEquals(Object.fromEntries(serviceForm("X", copiedSettings({ ...PARENT_SETTINGS, default_template_sid: "HJ" + hex(7) }))).DefaultTemplateSid,
    "HJ" + hex(7), "a template the parent has set is copied");
});

// ── syncVerifyService ──────────────────────────────────────────────────────────────────────

Deno.test("sync: a sub with no service gets ONE, made with the SUB's key, named after the builder, recorded", async () => {
  const db = new FakeAdmin();
  const tw = fakeTwilio([]);
  const r = await sync(db, tw.http);
  assertEquals(r, { ok: true, outcome: "created", sid: MADE_SVC, name: "Example Barns Sheds LLC" });
  const creates = tw.reqs.filter((q) => q.method === "POST");
  assertEquals(creates.length, 1);
  assertEquals(creates[0].user, SUB_KEY, "made inside the sub, with the sub's own key");
  assertEquals(creates[0].form.FriendlyName, "Example Barns Sheds LLC");
  assertEquals(creates[0].form.CodeLength, "6", "the parent's code length");
  assertEquals(creates[0].form.DoNotShareWarningEnabled, "false");
  assert(!("DefaultTemplateSid" in creates[0].form), "an empty parent template is not sent");
  assertEquals(tw.reqs.filter((q) => q.user === "SKparentverifykey").map((q) => q.method), ["GET"], "the parent is only read");
  assertEquals([db.row.verify_service_sid, db.row.verify_service_name], [MADE_SVC, "Example Barns Sheds LLC"]);
  assertEquals(db.row.provision_lock_until, null, "the lock is released by the same write");
});

Deno.test("sync again: unchanged, no write to Twilio at all", async () => {
  const db = new FakeAdmin();
  Object.assign(db.row, { verify_service_sid: BUILDER_SVC, verify_service_name: "Example Barns Sheds LLC" });
  const tw = fakeTwilio([builderSvc(BUILDER_SVC, "Example Barns Sheds LLC")]);
  const r = await sync(db, tw.http);
  assertEquals(r, { ok: true, outcome: "unchanged", sid: BUILDER_SVC, name: "Example Barns Sheds LLC" });
  assertEquals(tw.reqs.filter((q) => q.method !== "GET").length, 0);
  assertEquals(db.row.provision_lock_until, null);
});

Deno.test("sync: a renamed builder renames their service in ONE update carrying only the name; the SID stays", async () => {
  const db = new FakeAdmin();
  Object.assign(db.row, { verify_service_sid: BUILDER_SVC, verify_service_name: "Old Name" });
  const tw = fakeTwilio([builderSvc(BUILDER_SVC, "Old Name")]);
  const r = await sync(db, tw.http);
  assertEquals(r, { ok: true, outcome: "renamed", sid: BUILDER_SVC, name: "Example Barns Sheds LLC" });
  const posts = tw.reqs.filter((q) => q.method === "POST");
  assertEquals(posts.map((q) => q.url), [`https://verify.twilio.com/v2/Services/${BUILDER_SVC}`]);
  assertEquals(posts[0].form, { FriendlyName: "Example Barns Sheds LLC" });
  assertEquals(tw.services[0].friendly_name, "Example Barns Sheds LLC");
  assertEquals(db.row.verify_service_name, "Example Barns Sheds LLC");
});

Deno.test("sync: settings that drifted from the parent's are put back (updated), the name left alone", async () => {
  const db = new FakeAdmin();
  db.tables.client_settings[0].business_name = "Example Barns";
  Object.assign(db.row, { verify_service_sid: BUILDER_SVC, verify_service_name: "Example Barns" });
  const tw = fakeTwilio([builderSvc(BUILDER_SVC, "Example Barns", { code_length: 4, do_not_share_warning_enabled: true })]);
  const r = await sync(db, tw.http);
  assertEquals(r.ok && r.outcome, "updated");
  assertEquals(tw.reqs.find((q) => q.method === "POST")?.form, { CodeLength: "6", DoNotShareWarningEnabled: "false" });
});

Deno.test("sync: a service already in the sub that the row does not know is ADOPTED (the oldest), never made twice", async () => {
  const db = new FakeAdmin();
  const tw = fakeTwilio([
    builderSvc(OTHER_SVC, "Example Barns Sheds LLC", { date_created: "2026-10-21T11:00:00Z" }),
    builderSvc(BUILDER_SVC, "Something Else", { date_created: "2026-10-20T09:00:00Z" }),
  ]);
  const r = await sync(db, tw.http);
  assertEquals(r, { ok: true, outcome: "adopted", sid: BUILDER_SVC, name: "Example Barns Sheds LLC" });
  assertEquals(tw.reqs.filter((q) => q.method === "POST" && q.url.endsWith("/Services")).length, 0, "no create");
  assertEquals(tw.services.find((s) => s.sid === BUILDER_SVC)?.friendly_name, "Example Barns Sheds LLC", "and renamed");
  assertEquals(db.row.verify_service_sid, BUILDER_SVC);
});

Deno.test("sync: the row's service deleted in Twilio's console, nothing else in the sub: a new one is made", async () => {
  const db = new FakeAdmin();
  Object.assign(db.row, { verify_service_sid: BUILDER_SVC, verify_service_name: "Example Barns Sheds LLC" });
  const tw = fakeTwilio([]);
  const r = await sync(db, tw.http);
  assertEquals(r.ok && r.outcome, "created");
  assertEquals(db.row.verify_service_sid, MADE_SVC);
});

Deno.test("sync: the lock held by a provisioning run → busy, and nothing is made", async () => {
  const db = new FakeAdmin();
  db.row.provision_lock_until = new Date(Date.now() + 60_000).toISOString();
  const tw = fakeTwilio([]);
  const r = await sync(db, tw.http);
  assertEquals(r.ok ? "ok" : [r.reason, r.status], ["busy", 409]);
  assertEquals(tw.reqs.filter((q) => q.user === SUB_KEY).length, 0, "the sub is never asked");
});

Deno.test("sync: the lock lost under the create (row suspended) → nothing written, and the service it made is deleted", async () => {
  const db = new FakeAdmin();
  const tw = fakeTwilio([], { onCreate: () => { db.row.provision_lock_until = null; db.row.status = "suspended"; } });
  const r = await sync(db, tw.http);
  assertEquals(r.ok ? "ok" : r.reason, "lock_lost");
  assertEquals(db.row.verify_service_sid, null);
  assertEquals(tw.reqs.filter((q) => q.method === "DELETE").map((q) => q.url), [`https://verify.twilio.com/v2/Services/${MADE_SVC}`]);
  assertEquals(tw.services.length, 0, "the sub is left with no orphan");
});

Deno.test("sync: Twilio refusing the name (60248) is a coded failure, the lock released, the row untouched", async () => {
  const db = new FakeAdmin();
  const tw = fakeTwilio([], { create: () => ({ status: 400, body: { code: 60248, message: "restricted word" } }) });
  const r = await sync(db, tw.http);
  assertEquals(r.ok ? "ok" : [r.reason, r.code], ["twilio_failed", "create_60248"]);
  assertEquals(db.row.provision_lock_until, null);
  assertEquals(db.row.verify_service_sid, null);
  assert(!r.ok && !verifySyncSentence(r).includes("restricted"), "Twilio's message never reaches the sentence");
});

Deno.test("sync: the parent's settings unreadable → nothing locked or made", async () => {
  const db = new FakeAdmin();
  const tw = fakeTwilio([], { parent: () => ({ status: 500, body: {} }) });
  const r = await sync(db, tw.http);
  assertEquals(r.ok ? "ok" : [r.reason, r.code], ["twilio_failed", "parent_http_500"]);
  assertEquals(db.row.provision_lock_until, null);
  assertEquals(tw.reqs.length, 1);
});

Deno.test("sync refuses without touching Twilio: switch off (no read at all), parent pin, not active, no name, 323 missing", async () => {
  const off = new FakeAdmin();
  const tw0 = fakeTwilio([]);
  const r0 = await sync(off, tw0.http, { ...ENV, TWILIO_SUBACCOUNTS: "" });
  assertEquals(r0.ok ? "ok" : r0.reason, "switch_off");
  assertEquals(off.touched, [], "off means nothing is read");

  const cases: Array<[string, (db: FakeAdmin) => void, string]> = [
    ["parent", (db) => { db.row.kind = "parent"; }, "not_sub"],
    ["suspended", (db) => { db.row.status = "suspended"; }, "not_active"],
    ["no name", (db) => { db.tables.client_settings[0].business_name = "!!!"; db.tables.client_configs[0].company_name = ""; }, "no_name"],
    ["323 missing", (db) => { db.failRead.twilio_accounts = "42703"; }, "not_configured"],
  ];
  for (const [label, arrange, reason] of cases) {
    const db = new FakeAdmin();
    arrange(db);
    const tw = fakeTwilio([]);
    const r = await sync(db, tw.http);
    assertEquals(r.ok ? "ok" : r.reason, reason, label);
    assertEquals(tw.reqs.length, 0, `${label}: Twilio never asked`);
  }
});

// ── builderVerifyTarget ────────────────────────────────────────────────────────────────────

const target = (db: FakeAdmin, env = ENV, checkName = false) =>
  withEnv(env, () => builderVerifyTarget(db, TENANT, getFrom(env), { checkName }));

Deno.test("target: an active sub with a service → that service with the SUB's key pair", async () => {
  const db = new FakeAdmin();
  Object.assign(db.row, { verify_service_sid: BUILDER_SVC, verify_service_name: "Example Barns Sheds LLC" });
  const t = await target(db, ENV, true);
  assertEquals(t, { target: { serviceSid: BUILDER_SVC, user: SUB_KEY, pass: SUB_SECRET }, needsSync: false });
});

Deno.test("target: the name moved → needsSync (send path only); NO service → the parent's and never a sync (the rollback holds)", async () => {
  const db = new FakeAdmin();
  Object.assign(db.row, { verify_service_sid: BUILDER_SVC, verify_service_name: "Old Name" });
  assertEquals((await target(db, ENV, true)).needsSync, true);
  assertEquals((await target(db, ENV, false)).needsSync, false, "the check path never reads the name");

  const none = new FakeAdmin();
  assertEquals(await target(none, ENV, true), { target: null, needsSync: false },
    "a cleared SID is the rollback: the next login must not make a service again");
});

Deno.test("target: the parent's service for the switch off (nothing read), a pin, a suspended sub and every failed lookup", async () => {
  const off = new FakeAdmin();
  Object.assign(off.row, { verify_service_sid: BUILDER_SVC, verify_service_name: "x" });
  assertEquals(await target(off, { ...ENV, TWILIO_SUBACCOUNTS: "" }, true), { target: null, needsSync: false });
  assertEquals(off.touched, []);

  const cases: Array<[string, (db: FakeAdmin) => void]> = [
    ["pin", (db) => { db.row.kind = "parent"; }],
    ["suspended", (db) => { db.row.status = "suspended"; }],
    ["row read fails", (db) => { db.failRead.twilio_accounts = "57014"; }],
    ["323 missing", (db) => { db.failRead.twilio_accounts = "42703"; }],
    ["creds missing", (db) => { db.creds = null; }],
    ["creds rpc throws", (db) => { db.rpc = () => { throw new Error("vault down"); }; }],
  ];
  for (const [label, arrange] of cases) {
    const db = new FakeAdmin();
    Object.assign(db.row, { verify_service_sid: BUILDER_SVC, verify_service_name: "Example Barns Sheds LLC" });
    arrange(db);
    const t = await target(db, ENV, true);
    assertEquals(t.target, null, label);
  }
});
