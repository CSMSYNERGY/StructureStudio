// 2026-10-12 (C55): creating a builder makes their own Twilio sub-account when TWILIO_SUBACCOUNTS is
// "on" (admin-catalog create_client + admin-catalog/twilioAtCreate.ts).
//
// Two halves:
//   * provisionAtCreate on its own, with the run, the wait and waitUntil injected: what each answer of
//     ensureTwilioAccount becomes, the audit and app_errors rows, and above all that it never rejects
//     and never holds the create past its wait (a longer run is handed to waitUntil: "pending");
//   * the SHIPPED admin-catalog handler (the deleteClientHarness idiom: Deno.serve stubbed at import,
//     the import map's supabase stub routing every table and rpc into a fake, globalThis.fetch a fake
//     Twilio, no --allow-net), on the ADMIN_PASSWORD path: the create answers 200 whatever happens at
//     Twilio, the sub is made only with the switch "on", only AFTER the tenant exists, with the parent's
//     credentials and the client id as its name, and the audit row carries a MASKED SID;
//   * the dead end a run left unfinished would make (review of 2026-10-13): create_client with Twilio
//     refusing leaves the sub 'failed', and then the SHIPPED portal-settings phone_search_numbers and
//     portal-sms search_numbers handlers, on the same fake database and Twilio, finish the sub and
//     answer numbers found IN it (before, the Phone tab's search refused "still being set up" for
//     good, and it is the only way to a number the Phone tab can buy); delete_client waits while a
//     provisioning run holds its lock.
// Tenants, SIDs and secrets are made up (the repo is public).

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert@1";
import { stubAuth, stubDb, stubRpc } from "./supabase_stub.ts";
import { loadAdminCatalog } from "./deleteClientHarness.ts";
import { AT_CREATE_WAIT_MS, provisionAtCreate, type AtCreateDeps } from "../../admin-catalog/twilioAtCreate.ts";
import type { EnsureOpts, EnsureResult } from "../twilioProvision.ts";

const NEW = "acme-sheds-two";
const SUB = "AC" + "5".repeat(32);

// ── provisionAtCreate on its own ─────────────────────────────────────────────────────────────
function harness(env: Record<string, string | undefined>, ensure?: (opts: EnsureOpts) => Promise<EnsureResult>) {
  const audits: any[] = [];
  const logs: any[] = [];
  const kept: Promise<unknown>[] = [];
  const calls: EnsureOpts[] = [];
  let auditFails = false;
  let logFails = false;
  const admin = {
    from: (table: string) => ({
      insert: (row: any) => {
        if (table !== "admin_audit") throw new Error(`unexpected insert into ${table}`);
        if (auditFails) return Promise.reject(new Error("audit write failed"));
        audits.push(row);
        return Promise.resolve({ error: null });
      },
    }),
  };
  const deps = (over: Partial<AtCreateDeps> = {}): AtCreateDeps => ({
    get: (k) => env[k],
    actor: { via: "password" },
    log: (row) => { if (logFails) return Promise.reject(new Error("log failed")); logs.push(row); return Promise.resolve(); },
    ensure: ensure ? (_a, _c, opts) => { calls.push(opts); return ensure(opts); } : undefined,
    keepAlive: (p) => { kept.push(p); },
    ...over,
  });
  return {
    admin, audits, logs, kept, calls, deps,
    failAudit: () => { auditFails = true; },
    failLog: () => { logFails = true; },
  };
}
const ON = { TWILIO_SUBACCOUNTS: "on" };
const later = <T>(ms: number, v: () => T) => new Promise<T>((resolve, reject) => setTimeout(() => { try { resolve(v()); } catch (e) { reject(e); } }, ms));

Deno.test("at create: only the switch \"on\" makes a sub; off, unset, \"manual\" and near-misses are skipped with nothing run", async () => {
  for (const [v, reason] of [[undefined, "switch_off"], ["", "switch_off"], ["off", "switch_off"], ["ON", "switch_off"], ["true", "switch_off"], ["manual", "manual"]] as const) {
    const h = harness({ TWILIO_SUBACCOUNTS: v }, () => Promise.reject(new Error("must not run")));
    const r = await provisionAtCreate(h.admin, NEW, h.deps());
    assertEquals(r, { outcome: "skipped", reason }, `"${v}"`);
    assertEquals([h.calls.length, h.kept.length, h.audits.length, h.logs.length], [0, 0, 0, 0], `"${v}"`);
  }
});

Deno.test("at create: a finished run is \"created\", run with the console's options; the audit row names the operator and a MASKED SID", async () => {
  const h = harness(ON, () => Promise.resolve({ ok: true, kind: "sub", accountSid: SUB, ran: true, pushSkipped: ["apns_prod"] }));
  const r = await provisionAtCreate(h.admin, NEW, h.deps({ actor: { via: "operator", email: "operator@example.test", userId: "u-1" } }));
  assertEquals(r, { outcome: "created" });
  assertEquals(h.calls.length, 1);
  assertEquals(h.calls[0].operator, true, "the console's Create options");
  assertEquals(h.calls[0].get("TWILIO_SUBACCOUNTS"), "on", "the same environment");
  assertEquals(h.kept.length, 1, "handed to waitUntil, so the audit row is written even past the wait");
  assertEquals(h.audits, [{
    action: "twilio_account_provision", target_client_id: NEW, actor_email: "operator@example.test", actor_user_id: "u-1",
    note: "via=operator at=create_client provisioned sid=AC…5555 push_skipped=apns_prod",
  }]);
  assert(!JSON.stringify(h.audits).includes(SUB), "never the full SID");
  assertEquals(h.logs, []);
});

Deno.test("at create: a builder who stays on the parent (pin, internal, parent holdings) is \"skipped\" with the reason; nothing filed", async () => {
  for (const reason of ["pinned", "internal", "parent_holdings"] as const) {
    const h = harness(ON, () => Promise.resolve({ ok: true, kind: "parent", reason }));
    assertEquals(await provisionAtCreate(h.admin, NEW, h.deps()), { outcome: "skipped", reason });
    assertEquals([h.audits.length, h.logs.length], [0, 0]);
  }
});

Deno.test("at create: another run holding the lock is \"pending\", not a failure", async () => {
  const h = harness(ON, () => Promise.resolve({ ok: false, reason: "busy", status: 409, step: "lock", code: "busy" }));
  assertEquals(await provisionAtCreate(h.admin, NEW, h.deps()), { outcome: "pending", reason: "busy" });
  assertEquals([h.audits.length, h.logs.length], [0, 0]);
});

Deno.test("at create: missing edge secrets are \"failed\", filed at info with their NAMES only", async () => {
  const h = harness(ON, () => Promise.resolve({
    ok: false, reason: "not_configured", status: 503, step: "config", code: "parent_token_missing", missing: ["TWILIO_AUTH_TOKEN"], parentKeyOnly: true,
  }));
  const r = await provisionAtCreate(h.admin, NEW, h.deps());
  assertEquals(r, { outcome: "failed", reason: "not_configured", step: "config", code: "parent_token_missing" });
  assertEquals(h.logs.length, 1);
  assertEquals([h.logs[0].fn, h.logs[0].clientId, h.logs[0].code, h.logs[0].severity], ["admin-catalog", NEW, "twilio_provision_not_configured", "info"]);
  assert(/needs TWILIO_AUTH_TOKEN \(the parent's API key cannot create sub-accounts; set TWILIO_AUTH_TOKEN\)/.test(h.logs[0].message), h.logs[0].message);
  assertEquals(h.logs[0].context, { at: "create_client", reason: "not_configured", step: "config", code: "parent_token_missing" });
  assertEquals(h.audits.map((a) => a.note), ["via=password at=create_client refused not_configured step=config code=parent_token_missing"]);
});

Deno.test("at create: a run Twilio stopped is \"failed\", filed at error with the step and code only, and said to finish later", async () => {
  const h = harness(ON, () => Promise.resolve({ ok: false, reason: "failed", status: 502, step: "api_key", code: "20003" }));
  const r = await provisionAtCreate(h.admin, NEW, h.deps());
  assertEquals(r, { outcome: "failed", reason: "failed", step: "api_key", code: "20003" });
  assertEquals([h.logs[0].code, h.logs[0].severity], ["twilio_provision_failed", "error"]);
  assert(/stopped at api_key, 20003\); the builder's number search, a purchase, a texting submit or the console card's Create finishes it$/.test(h.logs[0].message), h.logs[0].message);
  assertEquals(h.audits.map((a) => a.note), ["via=password at=create_client refused failed step=api_key code=20003"]);
});

Deno.test("at create: a run that throws (sync or async) is \"failed\" and filed; provisionAtCreate never rejects", async () => {
  for (const ensure of [
    (): Promise<EnsureResult> => { throw new Error("boom"); },
    (): Promise<EnsureResult> => Promise.reject(new Error("boom")),
  ]) {
    const h = harness(ON, ensure);
    const r = await provisionAtCreate(h.admin, NEW, h.deps());
    assertEquals(r, { outcome: "failed", reason: "error", step: null, code: "threw" });
    assertEquals([h.logs.length, h.logs[0].code, h.logs[0].severity], [1, "twilio_provision_failed", "error"]);
    assert(!h.logs[0].message.includes("boom"), "no raw error text in the row");
  }
});

Deno.test("at create: an audit or log write that fails changes nothing about the answer", async () => {
  const ok = harness(ON, () => Promise.resolve({ ok: true, kind: "sub", accountSid: SUB, ran: true, pushSkipped: [] }));
  ok.failAudit();
  assertEquals(await provisionAtCreate(ok.admin, NEW, ok.deps()), { outcome: "created" });
  const bad = harness(ON, () => Promise.resolve({ ok: false, reason: "failed", status: 502, step: "push", code: "vault" }));
  bad.failAudit();
  bad.failLog();
  assertEquals((await provisionAtCreate(bad.admin, NEW, bad.deps())).outcome, "failed");
});

Deno.test("at create: a run longer than the wait answers \"pending\" at once and finishes under waitUntil, audit row and all", async () => {
  const h = harness(ON, () => later(120, () => ({ ok: true, kind: "sub", accountSid: SUB, ran: true, pushSkipped: [] }) as EnsureResult));
  const t0 = Date.now();
  const r = await provisionAtCreate(h.admin, NEW, h.deps({ waitMs: 10 }));
  assertEquals(r, { outcome: "pending" });
  assert(Date.now() - t0 < 100, "the create did not wait for the run");
  assertEquals(h.audits.length, 0, "not finished yet");
  assertEquals(h.kept.length, 1, "the run was handed to waitUntil");
  assertEquals(await h.kept[0], { outcome: "created" });
  assertEquals(h.audits.map((a) => a.note), ["via=password at=create_client provisioned sid=AC…5555"]);

  // A long run that then fails is still filed, after the answer went.
  const f = harness(ON, () => later(60, () => ({ ok: false, reason: "failed", status: 502, step: "events", code: "http_500" }) as EnsureResult));
  assertEquals(await provisionAtCreate(f.admin, NEW, f.deps({ waitMs: 5 })), { outcome: "pending" });
  assertEquals(f.logs.length, 0);
  await f.kept[0];
  assertEquals([f.logs.length, f.logs[0].context.step], [1, "events"]);
});

Deno.test("at create: without an injected keepAlive the runtime's EdgeRuntime.waitUntil gets the run; the default wait is short", async () => {
  const g = globalThis as any;
  const prior = g.EdgeRuntime;
  const handed: Promise<unknown>[] = [];
  g.EdgeRuntime = { waitUntil: (p: Promise<unknown>) => { handed.push(p); } };
  try {
    const h = harness(ON, () => Promise.resolve({ ok: true, kind: "parent", reason: "internal" }));
    const r = await provisionAtCreate(h.admin, NEW, h.deps({ keepAlive: undefined }));
    assertEquals(r, { outcome: "skipped", reason: "internal" });
    assertEquals(handed.length, 1);
  } finally {
    if (prior === undefined) delete g.EdgeRuntime; else g.EdgeRuntime = prior;
  }
  assert(AT_CREATE_WAIT_MS > 0 && AT_CREATE_WAIT_MS <= 2_000, "the create is never held up materially");
});

// ── Through the shipped admin-catalog handler ────────────────────────────────────────────────
const HANDLER = await loadAdminCatalog(true);
const ADMIN_PASSWORD = "admin-password-test";
const PARENT = "AC" + "0".repeat(32);
const PARENT_TOKEN = "parentauthtoken" + "p".repeat(17);
const BASE_ENV: Record<string, string> = {
  SUPABASE_URL: "https://project.example.test", SUPABASE_SERVICE_ROLE_KEY: "service-role-test", ADMIN_PASSWORD,
  TWILIO_ACCOUNT_SID: PARENT, TWILIO_AUTH_TOKEN: PARENT_TOKEN, TWILIO_API_KEY: "SK" + "0".repeat(32), TWILIO_API_SECRET: "parent-api-secret",
  PHONE_API_BASE: "https://phone.example.test", PHONE_WEBHOOK_SECRET: "voicekey123", PHONE_FALLBACK_URL: "https://fallback.example.test/bin",
  TWILIO_SUB_APP_FALLBACK_URL: "https://static.example.test/calling-problem.xml", TWILIO_SUB_VOICEMAIL_URL: "https://static.example.test/voicemail.xml",
  TWILIO_EVENTS_SECRET: "eventskey456",
};

type Row = Record<string, any>;
/** The tables create_client and a provisioning run touch, with one ordered log of both. */
class Db {
  configs = new Map<string, Row>([["template-client", { client_id: "template-client" }]]);
  accounts = new Map<string, Row>();
  settings = new Map<string, Row>();
  holdings = new Map<string, string>();
  vault = new Map<string, string>();
  audits: Row[] = [];
  errors: Row[] = [];
  setupRows: Row[] = [];
  /** client_users: the new builder's owner, once a portal request is made as them. */
  users: Row[] = [];
  /** twilio_accounts reads throw (a client that blew up mid-run). */
  throwOnAccounts = false;
  constructor(readonly log: string[]) {}

  from(table: string) {
    // deno-lint-ignore no-this-alias
    const db = this;
    if (table === "twilio_accounts" && db.throwOnAccounts) throw new Error("connection reset");
    const q: { op: string; patch?: any; f: Array<(r: Row) => boolean>; sel?: boolean } = { op: "select", f: [] };
    const rows = (): Row[] => {
      if (table === "twilio_accounts") return [...db.accounts.values()];
      if (table === "client_settings") return [...db.settings.values()];
      if (table === "client_configs") return [...db.configs.values()];
      if (table === "client_users") return db.users;
      if (table === "setup_template_items") return [{ id: "t1", active: true, title: "Add your logo", detail: null, link_page: null, section: null, image_url: null }];
      return [];
    };
    const run = (single: boolean) => {
      db.log.push(`db ${q.op} ${table}`);
      if (q.op === "insert") {
        if (table === "admin_audit") db.audits.push(q.patch);
        else if (table === "app_errors") db.errors.push(q.patch);
        else if (table === "client_configs") db.configs.set(q.patch.client_id, { ...q.patch });
        else if (table === "tenant_setup_items") db.setupRows.push(...q.patch);
        return { data: null, error: null };
      }
      if (table === "admin_auth_attempts") return { data: null, error: null };
      const hit = rows().filter((r) => q.f.every((fn) => fn(r)));
      if (q.op === "select") return { data: single ? (hit[0] ? { ...hit[0] } : null) : hit, count: hit.length, error: null };
      if (q.op === "update") {
        for (const r of hit) Object.assign(r, q.patch);
        return { data: q.sel ? (single ? hit[0] ?? null : hit.map((r) => ({ ...r }))) : null, error: null };
      }
      if (q.op === "upsert" && table === "twilio_accounts") {
        const r = q.patch;
        if (!db.accounts.has(r.client_id)) {
          db.accounts.set(r.client_id, {
            client_id: r.client_id, kind: r.kind, account_sid: null, status: r.status, api_key_sid: null, api_secret_id: null, auth_token_id: null,
            twiml_app_sid: null, push_apns_dev_sid: null, push_apns_prod_sid: null, push_fcm_sid: null, events_sink_sid: null,
            events_subscription_sid: null, provision_step: r.provision_step ?? null, provision_lock_until: null, last_error: null, push_skipped: null,
          });
        }
      }
      return { data: null, error: null };
    };
    const b: any = {
      select: (_c?: string) => { if (q.op !== "select") q.sel = true; return b; },
      insert: (p: any) => { q.op = "insert"; q.patch = p; return b; },
      update: (p: any) => { q.op = "update"; q.patch = p; return b; },
      upsert: (p: any) => { q.op = "upsert"; q.patch = p; return b; },
      delete: () => { q.op = "delete"; return b; },
      eq: (c: string, v: unknown) => { q.f.push((r) => r[c] === v); return b; },
      is: () => b, lt: () => b, gte: () => b, order: () => b, limit: () => b,
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
    this.log.push(`db rpc ${fn}`);
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

/** A small Twilio (twilioAccountConsole_test's, for a builder being created). */
class Twilio {
  calls: { method: string; url: URL; auth: string; form: URLSearchParams }[] = [];
  sub: { sid: string; token: string; status: string } | null = null;
  key: { sid: string; secret: string } | null = null;
  /** The parent's create is refused (a parent auth token Twilio does not accept). */
  refuseCreate = false;
  private seq = 0;
  constructor(readonly log: string[]) {}
  private id(prefix: string) { return prefix + String(++this.seq).padStart(32, "1"); }

  fetch = (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const form = new URLSearchParams(String(init?.body ?? ""));
    this.calls.push({ method, url, auth, form });
    this.log.push(`tw ${method} ${url.host}${url.pathname}`);
    const j = (v: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(v), { status }));
    const p = url.pathname;
    if (url.host === "api.twilio.com") {
      if (p.endsWith("/Accounts.json")) {
        if (method === "GET") return j({ accounts: this.sub ? [{ sid: this.sub.sid, friendly_name: NEW, status: this.sub.status, auth_token: this.sub.token }] : [] });
        if (this.refuseCreate) return j({ code: 20003, message: "Authenticate" }, 401);
        this.sub = { sid: this.id("AC"), token: "subtoken" + "t".repeat(24), status: "active" };
        return j({ sid: this.sub.sid, auth_token: this.sub.token }, 201);
      }
      const subToken = auth === `Basic ${btoa(`${this.sub?.sid}:${this.sub?.token}`)}`;
      const subKey = auth === `Basic ${btoa(`${this.key?.sid}:${this.key?.secret}`)}`;
      // The number search, answered only to the sub's own credentials inside the sub (a parent key
      // cannot reach a sub's resources, and a search on the parent is not the builder's).
      const avail = /^\/2010-04-01\/Accounts\/(AC\w+)\/AvailablePhoneNumbers\/US\/Local\.json$/.exec(p);
      if (avail && method === "GET") {
        if (avail[1] !== this.sub?.sid || !(subToken || subKey)) return j({ code: 20003 }, 401);
        return j({ available_phone_numbers: [{ phone_number: "+18165550101", friendly_name: "(816) 555-0101", locality: null, region: "MO" }] });
      }
      if (/\/Applications\.json$/.test(p)) {
        if (method !== "GET") return j({ sid: this.id("AP") }, 201);
        return subToken || subKey ? j({ applications: [] }) : j({ code: 20003 }, 401);
      }
      if (/\/Accounts\/AC\w+\.json$/.test(p)) {
        const ok = subToken || auth.includes(btoa(`${PARENT}:`).slice(0, 10));
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

async function create(db: Db, tw: Twilio, env: Record<string, string | undefined> = {}, body: Record<string, unknown> = {}) {
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
      headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.11" },
      body: JSON.stringify({ adminPassword: ADMIN_PASSWORD, action: "create_client", clientId: NEW, companyName: "Acme Sheds Two", templateClientId: "__none__", ...body }),
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

Deno.test("create_client: with the switch off (unset) or \"manual\" the builder is made and Twilio is never asked", async () => {
  for (const [env, reason] of [[{}, "switch_off"], [{ TWILIO_SUBACCOUNTS: "manual" }, "manual"]] as const) {
    const log: string[] = [];
    const db = new Db(log), tw = new Twilio(log);
    const r = await create(db, tw, env);
    assertEquals(r.status, 200, r.raw);
    assertEquals([r.body.ok, r.body.clientId, r.body.twilio, r.body.twilioReason], [true, NEW, "skipped", reason]);
    assert(db.configs.has(NEW), "the builder exists");
    assertEquals(tw.calls.length, 0);
    assert(!log.some((l) => l.endsWith(" twilio_accounts")), `twilio_accounts was touched:\n${log.join("\n")}`);
  }
});

Deno.test("create_client: with the switch \"on\" the new builder's sub is made AFTER the tenant exists, named for its id, audited masked", async () => {
  const log: string[] = [];
  const db = new Db(log), tw = new Twilio(log);
  const r = await create(db, tw, { TWILIO_SUBACCOUNTS: "on" });
  assertEquals(r.status, 200, r.raw);
  assertEquals([r.body.ok, r.body.twilio, r.body.twilioReason, r.body.twilioCode, r.body.setupAssigned], [true, "created", undefined, undefined, 1]);
  const row = db.accounts.get(NEW)!;
  assertEquals([row.kind, row.status, row.provision_step, row.account_sid], ["sub", "active", "done", tw.sub!.sid]);
  // Made with the parent's SID + auth token, named for the client id (never the business name).
  const made = tw.calls.find((c) => c.method === "POST" && c.url.pathname.endsWith("/Accounts.json"))!;
  assertEquals([made.auth, made.form.get("FriendlyName")], [`Basic ${btoa(`${PARENT}:${PARENT_TOKEN}`)}`, NEW]);
  // Order: the tenant row and its checklist first, then anything about Twilio.
  const tenant = log.indexOf("db insert client_configs");
  const checklist = log.indexOf("db insert tenant_setup_items");
  const firstTwilio = log.findIndex((l) => l.endsWith(" twilio_accounts") || l.startsWith("tw "));
  assert(tenant >= 0 && checklist > tenant && firstTwilio > checklist, `the order was:\n${log.join("\n")}`);
  const audit = db.audits.find((a) => a.action === "twilio_account_provision");
  assert(audit && audit.target_client_id === NEW && /^via=password at=create_client provisioned sid=AC…\w{4} push_skipped=apns_prod$/.test(audit.note), JSON.stringify(db.audits));
  assert(!r.raw.includes(tw.sub!.sid) && !JSON.stringify(db.audits).includes(tw.sub!.sid), "no full SID in the answer or the audit");
  assert(!r.raw.includes(tw.sub!.token) && !r.raw.includes(tw.key!.secret), "no secret in the answer");
  assertEquals(db.errors, []);
});

Deno.test("create_client: missing edge secrets still create the builder (200); the run is \"failed\", filed at info with names only", async () => {
  const log: string[] = [];
  const db = new Db(log), tw = new Twilio(log);
  const r = await create(db, tw, { TWILIO_SUBACCOUNTS: "on", TWILIO_AUTH_TOKEN: undefined });
  assertEquals(r.status, 200, r.raw);
  assertEquals([r.body.ok, r.body.twilio, r.body.twilioReason, r.body.twilioCode], [true, "failed", "not_configured", "config:parent_token_missing"]);
  assert(db.configs.has(NEW));
  assertEquals(tw.calls.length, 0);
  assertEquals(db.errors.length, 1, JSON.stringify(db.errors));
  assertEquals([db.errors[0].source, db.errors[0].code, db.errors[0].severity, db.errors[0].client_id], ["edge:admin-catalog", "twilio_provision_not_configured", "info", NEW]);
  assert(/TWILIO_AUTH_TOKEN/.test(db.errors[0].message), db.errors[0].message);
  assert(!JSON.stringify(db.errors).includes("parent-api-secret") && !JSON.stringify(db.errors).includes("voicekey123"), "never a secret value");
});

Deno.test("create_client: Twilio refusing the sub still creates the builder (200); \"failed\", filed at error, the row left to resume", async () => {
  const log: string[] = [];
  const db = new Db(log), tw = new Twilio(log);
  tw.refuseCreate = true;
  const r = await create(db, tw, { TWILIO_SUBACCOUNTS: "on" });
  assertEquals(r.status, 200, r.raw);
  assertEquals([r.body.ok, r.body.twilio, r.body.twilioReason, r.body.twilioCode], [true, "failed", "failed", "account:20003"]);
  const row = db.accounts.get(NEW)!;
  assertEquals([row.status, row.provision_step, row.last_error, row.provision_lock_until], ["failed", "account", "account:20003", null],
    "recorded where it stopped, the lock released: the builder's number search resumes from here (tests below)");
  assertEquals([db.errors.length, db.errors[0].code, db.errors[0].severity], [1, "twilio_provision_failed", "error"]);
  assertEquals(db.errors[0].context, { at: "create_client", reason: "failed", step: "account", code: "20003" });
  assert(!JSON.stringify(db.errors).includes("Authenticate"), "never Twilio's message");
  assert(db.audits.some((a) => a.note === "via=password at=create_client refused failed step=account code=20003"), JSON.stringify(db.audits));
});

Deno.test("create_client: a builder holding something on the parent already stays there: \"skipped\", pinned, Twilio never asked", async () => {
  const log: string[] = [];
  const db = new Db(log), tw = new Twilio(log);
  db.holdings.set(NEW, "a live number");
  const r = await create(db, tw, { TWILIO_SUBACCOUNTS: "on" });
  assertEquals(r.status, 200, r.raw);
  assertEquals([r.body.twilio, r.body.twilioReason], ["skipped", "parent_holdings"]);
  assertEquals(tw.calls.length, 0);
  assertEquals(db.accounts.get(NEW)?.kind, "parent", "the pin is recorded, as ensureTwilioAccount always does");
});

Deno.test("create_client: a database client that throws during the run still answers 200 with the builder made", async () => {
  const log: string[] = [];
  const db = new Db(log), tw = new Twilio(log);
  db.throwOnAccounts = true;
  const r = await create(db, tw, { TWILIO_SUBACCOUNTS: "on" });
  assertEquals(r.status, 200, r.raw);
  assertEquals([r.body.ok, r.body.twilio, r.body.twilioReason], [true, "failed", "error"]);
  assert(db.configs.has(NEW));
  assertEquals([db.errors.length, db.errors[0].code], [1, "twilio_provision_failed"]);
});

Deno.test("create_client: a refused create (the id is taken) never reaches Twilio", async () => {
  const log: string[] = [];
  const db = new Db(log), tw = new Twilio(log);
  db.configs.set(NEW, { client_id: NEW });
  const r = await create(db, tw, { TWILIO_SUBACCOUNTS: "on" });
  assertEquals(r.status, 400, r.raw);
  assert(/already exists/.test(r.body.error), r.body.error);
  assertEquals(tw.calls.length, 0);
  assert(!log.some((l) => l.endsWith(" twilio_accounts")));
});

// ── The dead end, closed: a run left unfinished is finished by the builder's number search ──────
// Before this, a sub left 'failed' (or 'provisioning') at creation made resolveTwilioAccount refuse
// every Phone-tab search ("still being set up"), and the Phone tab can only buy a number its search
// found, so the builder never reached phone_buy_number, the one step that resumed the run.
async function loadHandler(rel: string): Promise<(req: Request) => Promise<Response>> {
  const realServe = Deno.serve;
  let handler: ((req: Request) => Promise<Response>) | null = null;
  (Deno as any).serve = (h: (req: Request) => Promise<Response>) => {
    handler = h;
    return { finished: Promise.resolve() };
  };
  try {
    // Computed specifier, as deleteClientHarness explains.
    await import(new URL(rel, import.meta.url).href);
  } finally {
    (Deno as any).serve = realServe;
  }
  if (!handler) throw new Error(`${rel} did not hand Deno.serve a handler`);
  return handler;
}
const SETTINGS = await loadHandler("../../portal-settings/index.ts");
const SMS = await loadHandler("../../portal-sms/index.ts");
const OWNER_ID = "00000000-0000-4000-8000-0000000000c7";
/** The builder's own request, as the new builder's owner, with the Phone tab's self-serve open. */
async function asBuilder(handler: (req: Request) => Promise<Response>, fn: string, db: Db, tw: Twilio, body: Record<string, unknown>) {
  const all: Record<string, string> = { ...BASE_ENV, SUPABASE_ANON_KEY: "anon-test", TWILIO_SUBACCOUNTS: "on", PHONE_SELF_SERVE: "on" };
  const prior = Object.fromEntries(Object.keys(all).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(all)) Deno.env.set(k, v);
  if (!db.users.length) db.users.push({ user_id: OWNER_ID, client_id: NEW, role: "owner", title: "owner", access: null });
  const realFetch = globalThis.fetch;
  globalThis.fetch = tw.fetch as typeof fetch;
  stubAuth.user = { id: OWNER_ID, email: "owner@example.test" };
  stubAuth.error = null;
  stubDb.from = (t: string) => db.from(t);
  stubRpc.rpc = (name: string, a?: any) => db.rpc(name, a ?? {});
  try {
    const res = await handler(new Request(`https://project.example.test/functions/v1/${fn}`, {
      method: "POST",
      headers: { authorization: "Bearer harness", "content-type": "application/json", "user-agent": "harness/1.0" },
      body: JSON.stringify(body),
    }));
    const raw = await res.text();
    return { status: res.status, body: JSON.parse(raw), raw };
  } finally {
    globalThis.fetch = realFetch;
    stubDb.from = null;
    stubRpc.rpc = null;
    stubAuth.user = null;
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
  }
}
/** A builder created while Twilio refused the sub: the row is left 'failed' at 'account'. */
async function createdUnfinished() {
  const log: string[] = [];
  const db = new Db(log), tw = new Twilio(log);
  tw.refuseCreate = true;
  const made = await create(db, tw, { TWILIO_SUBACCOUNTS: "on" });
  assertEquals([made.status, made.body.twilio], [200, "failed"], made.raw);
  assertEquals([db.accounts.get(NEW)!.kind, db.accounts.get(NEW)!.status], ["sub", "failed"]);
  assertEquals(db.errors.map((e) => e.code), ["twilio_provision_failed"], "the creation's own row");
  tw.refuseCreate = false;
  tw.calls = [];
  db.errors = [];
  log.length = 0;
  return { log, db, tw };
}
const searched = (tw: Twilio) => tw.calls.filter((c) => c.url.pathname.endsWith("/AvailablePhoneNumbers/US/Local.json"));

Deno.test("Phone tab: a sub left unfinished at creation is FINISHED by the number search, which then searches inside it", async () => {
  const { log, db, tw } = await createdUnfinished();
  const r = await asBuilder(SETTINGS, "portal-settings", db, tw, { action: "phone_search_numbers", areaCode: "816" });
  assertEquals(r.status, 200, r.raw);
  assertEquals(r.body.numbers, [{ e164: "+18165550101", locality: null, region: "MO" }]);
  const row = db.accounts.get(NEW)!;
  assertEquals([row.kind, row.status, row.provision_step, row.account_sid, row.provision_lock_until], ["sub", "active", "done", tw.sub!.sid, null]);
  // The run resumed from 'account' (made it with the parent's token), and only then was a number looked for.
  const made = log.indexOf("tw POST api.twilio.com/2010-04-01/Accounts.json");
  const search = log.findIndex((l) => l.includes("/AvailablePhoneNumbers/"));
  assert(made >= 0 && search > made, `the order was:\n${log.join("\n")}`);
  const q = searched(tw);
  assertEquals(q.length, 1);
  assertEquals(q[0].url.pathname, `/2010-04-01/Accounts/${tw.sub!.sid}/AvailablePhoneNumbers/US/Local.json`, "inside the builder's own sub");
  assertEquals(q[0].auth, `Basic ${btoa(`${tw.key!.sid}:${tw.key!.secret}`)}`, "with the sub's own key, never the parent's");
  assertEquals(db.errors, [], "nothing filed: it worked");
  assert(!r.raw.includes(tw.sub!.sid) && !r.raw.includes(tw.key!.secret), "no SID or secret in the answer");
});

Deno.test("Text Messaging tab: search_numbers finishes an unfinished sub the same way", async () => {
  const { db, tw } = await createdUnfinished();
  const r = await asBuilder(SMS, "portal-sms", db, tw, { action: "search_numbers", areaCode: "816" });
  assertEquals(r.status, 200, r.raw);
  assertEquals(r.body.numbers.map((n: any) => n.phoneNumber), ["+18165550101"]);
  assertEquals([db.accounts.get(NEW)!.status, db.accounts.get(NEW)!.provision_step], ["active", "done"]);
  assertEquals(searched(tw)[0]?.url.pathname, `/2010-04-01/Accounts/${tw.sub!.sid}/AvailablePhoneNumbers/US/Local.json`);
});

// Integration (c1012 U5 + U7 in one handler): the 3-6 digit prefix search and the resumed
// provisioning must both hold on the same request, on both tabs.
Deno.test("both tabs: a 6-digit prefix search finishes an unfinished sub, then searches that prefix inside it", async () => {
  for (const [fn, mod, body] of [
    ["portal-settings", SETTINGS, { action: "phone_search_numbers", startsWith: "(816) 300", areaCode: "816" }],
    ["portal-sms", SMS, { action: "search_numbers", startsWith: "816300", areaCode: "816" }],
  ] as const) {
    const { db, tw } = await createdUnfinished();
    const r = await asBuilder(mod, fn, db, tw, body);
    assertEquals(r.status, 200, `${fn}: ${r.raw}`);
    assertEquals([db.accounts.get(NEW)!.status, db.accounts.get(NEW)!.provision_step], ["active", "done"], `${fn}: the sub was not finished`);
    const q = searched(tw);
    assertEquals(q.length, 1, fn);
    assertEquals(q[0].url.pathname, `/2010-04-01/Accounts/${tw.sub!.sid}/AvailablePhoneNumbers/US/Local.json`, `${fn}: not inside the builder's sub`);
    assertEquals([q[0].url.searchParams.get("AreaCode"), q[0].url.searchParams.get("Contains")], ["816", "+1816300"], `${fn}: ${q[0].url.search}`);
    // The fake answers +18165550101 whatever is asked; it does not start with 816-300, so the
    // server's own prefix filter drops it rather than offering a number that doesn't match.
    assertEquals(r.body.numbers, [], `${fn}: a number outside the prefix was offered`);
  }
  // And a partial prefix is refused with a sentence, as U5 built it, after the same resume.
  const { db, tw } = await createdUnfinished();
  const bad = await asBuilder(SETTINGS, "portal-settings", db, tw, { action: "phone_search_numbers", startsWith: "81" });
  assertEquals(bad.status, 400, bad.raw);
  assertEquals(searched(tw).length, 0, "Twilio was asked for a partial prefix");
});

Deno.test("Phone tab: an active, finished sub searches with no provisioning call at all", async () => {
  const log: string[] = [];
  const db = new Db(log), tw = new Twilio(log);
  assertEquals((await create(db, tw, { TWILIO_SUBACCOUNTS: "on" })).body.twilio, "created");
  tw.calls = [];
  const r = await asBuilder(SETTINGS, "portal-settings", db, tw, { action: "phone_search_numbers", areaCode: "816" });
  assertEquals(r.status, 200, r.raw);
  assertEquals(tw.calls.map((c) => `${c.method} ${c.url.pathname}`), [`GET /2010-04-01/Accounts/${tw.sub!.sid}/AvailablePhoneNumbers/US/Local.json`]);
});

Deno.test("Phone tab: while the creation's run still holds its lock the search says so (409) and asks Twilio nothing", async () => {
  const { db, tw } = await createdUnfinished();
  db.accounts.get(NEW)!.provision_lock_until = new Date(Date.now() + 60_000).toISOString();
  const r = await asBuilder(SETTINGS, "portal-settings", db, tw, { action: "phone_search_numbers", areaCode: "816" });
  assertEquals(r.status, 409, r.raw);
  assert(/being set up right now/.test(r.body.error), r.body.error);
  assertEquals(tw.calls, []);
});

Deno.test("Phone tab: a resume Twilio refuses again is filed once and says to try again (502), never Twilio's words", async () => {
  const { db, tw } = await createdUnfinished();
  tw.refuseCreate = true;
  const r = await asBuilder(SETTINGS, "portal-settings", db, tw, { action: "phone_search_numbers", areaCode: "816" });
  assertEquals(r.status, 502, r.raw);
  assert(/Couldn't set up your phone account just now/.test(r.body.error), r.body.error);
  assert(!r.raw.includes("Authenticate"));
  const filed = db.errors.filter((e) => e.code === "twilio_provision_failed");
  assertEquals(filed.length, 1, JSON.stringify(db.errors));
  assertEquals(searched(tw), [], "no search while the account is not ready");
});

// ── delete_client while a provisioning run holds its lock ─────────────────────────────────────
async function deleteNew(db: Db, tw: Twilio) {
  const all: Record<string, string> = { ...BASE_ENV, TWILIO_SUBACCOUNTS: "on" };
  const prior = Object.fromEntries(Object.keys(all).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(all)) Deno.env.set(k, v);
  const realFetch = globalThis.fetch;
  globalThis.fetch = tw.fetch as typeof fetch;
  stubDb.from = (t: string) => db.from(t);
  stubRpc.rpc = (fn: string, a?: any) => db.rpc(fn, a ?? {});
  try {
    const res = await HANDLER(new Request("http://localhost/functions/v1/admin-catalog", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.12" },
      body: JSON.stringify({ adminPassword: ADMIN_PASSWORD, action: "delete_client", clientId: NEW, confirmClientId: NEW }),
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

Deno.test("delete_client: refused (409, nothing deleted) while a provisioning run holds the lock; nothing asked of Twilio", async () => {
  const log: string[] = [];
  const db = new Db(log), tw = new Twilio(log);
  db.configs.set(NEW, { client_id: NEW });
  db.accounts.set(NEW, {
    client_id: NEW, kind: "sub", status: "provisioning", account_sid: null, provision_step: "account",
    provision_lock_until: new Date(Date.now() + 60_000).toISOString(),
  });
  const r = await deleteNew(db, tw);
  assertEquals(r.status, 409, r.raw);
  assertEquals(r.body.error, "This builder's phone account is still being set up. Try again in a few minutes. Nothing was deleted.");
  assertEquals(r.body.twilio, { reason: "busy", code: "provisioning" });
  assert(db.configs.has(NEW) && db.accounts.has(NEW), "nothing deleted");
  assert(!log.some((l) => l.startsWith("db delete")), `a delete ran:\n${log.join("\n")}`);
  assertEquals(tw.calls, []);
  assert(db.audits.some((a) => a.action === "delete_client" && a.note === "via=password twilio refused busy code=provisioning"), JSON.stringify(db.audits));
});

Deno.test("at create: a lock lost MID-run is filed (a sub may exist that no row records); one held from the start is \"pending\"", async () => {
  const h = harness(ON, () => Promise.resolve({ ok: false, reason: "busy", status: 409, step: "auth_token", code: "lock_lost" }));
  const r = await provisionAtCreate(h.admin, NEW, h.deps());
  assertEquals(r, { outcome: "failed", reason: "busy", step: "auth_token", code: "lock_lost" });
  assertEquals([h.logs.length, h.logs[0].code, h.logs[0].severity], [1, "twilio_provision_failed", "error"]);
  assert(/lost its lock at auth_token .* look in Twilio for a sub-account named for this client id/.test(h.logs[0].message), h.logs[0].message);
  assertEquals(h.audits.map((a) => a.note), ["via=password at=create_client refused busy step=auth_token code=lock_lost"]);
});

// ── Source: where it sits ────────────────────────────────────────────────────────────────────
const SRC = (await Deno.readTextFile(new URL("../../admin-catalog/index.ts", import.meta.url))).replace(/\r\n/g, "\n");
const AT = (await Deno.readTextFile(new URL("../../admin-catalog/twilioAtCreate.ts", import.meta.url))).replace(/\r\n/g, "\n");
Deno.test("source: create_client provisions after the checklist, before its answer; the switch is checked before the run", () => {
  const body = SRC.slice(SRC.indexOf('case "create_client": {'), SRC.indexOf("// ── link a user login to a client"));
  const checklist = body.indexOf('sb.from("tenant_setup_items").insert(rows)');
  const call = body.indexOf("await provisionAtCreate(sb, clientId, {");
  const answer = body.indexOf("return json({\n          ok: true, clientId, blank, cloned: clonedCounts, setupAssigned,");
  assert(checklist > 0 && call > checklist && answer > call, "provisionAtCreate runs after the checklist and before the answer");
  assert(body.slice(call, answer).includes("log: logEdgeError"), "failures are filed in app_errors");
  const gate = AT.indexOf("if (!provisioningOn(deps.get))");
  const run = AT.indexOf("await ensure(admin, clientId, { get: deps.get, operator: true })");
  assert(gate > 0 && run > gate, "only the switch \"on\" reaches the console's options (which run whatever the switch says)");
});

Deno.test("source: the money grant covers the console's Create and Close, and names create_client as its one deliberate exception", () => {
  const i = SRC.indexOf("// Workstream 2, phase 9: making a builder's Twilio sub-account starts a bill at Twilio");
  const block = SRC.slice(i, SRC.indexOf("\n    }\n", i));
  assert(i > 0, "the can_bill block moved");
  assert(block.includes('(String(action ?? "") === "twilio_account_provision" || String(action ?? "") === "twilio_account_close") && !identity.canBill'));
  assert(!/"create_client"[^\n]*canBill/.test(block), "create_client stays on can_write (decided 2026-10-13: an empty sub costs nothing)");
  assert(block.includes("ONE DELIBERATE EXCEPTION (2026-10-12, C55): create_client (can_write) makes the new builder's"), "the exception is written down where the rule is");
});

const PS = (await Deno.readTextFile(new URL("../../portal-settings/index.ts", import.meta.url))).replace(/\r\n/g, "\n");
const PSMS = (await Deno.readTextFile(new URL("../../portal-sms/index.ts", import.meta.url))).replace(/\r\n/g, "\n");
Deno.test("source: both number searches make or finish the account first, as the builder (never the operator path)", () => {
  const helper = PS.slice(PS.indexOf("const ensureTenantAccount = async (): Promise<Response | null> => {"), PS.indexOf("\n  };\n", PS.indexOf("const ensureTenantAccount")));
  assert(helper.includes("const prov = await ensureTwilioAccount(admin, clientId, { get: (k) => Deno.env.get(k) });"));
  assert(!helper.includes("operator"), "the builder's path: the switch decides, never the console's options");
  const search = PS.slice(PS.indexOf('if (action === "phone_search_numbers") {'), PS.indexOf('if (action === "phone_enable_number") {'));
  const gate = search.indexOf("const refused = await phoneRolloutGate();");
  const ensure = search.indexOf("const notReady = await ensureTenantAccount();");
  const resolve = search.indexOf("const tw = await tenantTwilio();");
  assert(gate >= 0 && ensure > gate && resolve > ensure, "rollout gate, then the account, then the account it resolves to");
  const sms = PSMS.slice(PSMS.indexOf('case "search_numbers": {'), PSMS.indexOf('case "buy_number": {'));
  const smsEnsure = sms.indexOf("const notReady = await ensureAccount();");
  assert(smsEnsure > 0 && sms.indexOf("await tenantCreds()") > smsEnsure, "portal-sms: the account before the search's credentials");
});

Deno.test("source: delete_client checks the provisioning lock before it plans anything at Twilio", () => {
  const del = SRC.slice(SRC.indexOf('case "delete_client": {'));
  const lock = del.indexOf('sb.from("twilio_accounts").select("provision_lock_until")');
  const plan = del.indexOf("await twilioClosePlan(sb, clientId, { get: twGet })");
  // Since migration 321 nothing is deleted before the gateway hook and the one tenant_purge call.
  const firstWipe = Math.min(...[del.indexOf("wipe(\"billing_customers\")"), del.indexOf("p_dry_run: false")].filter((i) => i >= 0));
  assert(lock > 0 && plan > lock && firstWipe > plan, "the lock read sits before the plan, and both before any wipe");
});
