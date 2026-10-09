// Workstream 2, phase 3: ensureTwilioAccount (twilioProvision.ts) against a fake database and a
// fake Twilio that keep state between runs, so a run that stops part-way is followed by one that
// finishes, and every object is counted.
//
// What is pinned:
//   * SWITCH OFF MEANS NOTHING: no read, no write, no request (an untouchable client proves it);
//     the operator's Create is the one exception;
//   * who stays on the parent (a pin, our internal account, something already held there), with a
//     pin written for the last two and nothing asked of Twilio;
//   * a full run makes each object ONCE, in the sub, with the sub's own credentials (the fake refuses
//     the parent's API key on a sub's resources, as Twilio does), the status URL carrying the key;
//   * RESUME FROM EVERY STEP: a run that stops at any step is finished by the next, nothing twice;
//   * LOST RESPONSES: a create that happened but whose answer never came is ADOPTED by name (an API
//     key, whose secret cannot be read again, is deleted and replaced);
//   * the lock: a second caller while it is held is "busy" (409) and touches nothing;
//   * a Vault write that fails stops the run BEFORE the next create;
//   * parent API key without the auth token: refused (not_configured, parent_token_missing);
//   * missing push material is skipped and recorded, and the operator's Create fills it in later;
//   * the console helpers: masked view, token check (a Standard key is never asked for the
//     Accounts resource, which Twilio refuses it), suspend / reactivate, close refused while the
//     sub has a number; delete_client's read-only close plan (an orphan found by name, numbers,
//     duplicates) and its row removal on a database without 295;
//   * the review's fixes: "manual" uses existing subs and makes none; the sub's fallbacks are never
//     a Twilio Bin and are fetched with GET; event types carry versions; every write pushes the
//     lock forward and a Suspend clears it; a rotated auth token is re-read by the operator's
//     re-check, which also re-sets the app's URLs; the switch-off holding check.
// Every SID, key and token is made up. No network; no jsr imports (the preflight's offline group).
// Run: deno test --allow-env --node-modules-dir=none supabase/functions/_shared/twilioProvision.test.ts

import {
  A2P_EVENT_TYPES, closePlannedSub, ensureRefusalSentence, ensureTwilioAccount, fetchHttp, forgetTwilioAccount, maskSid,
  parseEventTypes, provisionConfig, pushName, setTwilioAccountStatus, subAccountWhileOff, twilioAccountView, twilioClosePlan,
  type BasicAuth, type ProvisionHttp,
} from "./twilioProvision.ts";
import { accountFetchableUrl, provisioningOn, subaccountsMode, subaccountsOn } from "./twilioAccount.ts";

const assert = (cond: unknown, msg = "assertion failed") => {
  if (!cond) throw new Error(msg);
};
const assertEquals = (a: unknown, b: unknown, msg?: string) => {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(msg ? `${msg}: ${sa} !== ${sb}` : `${sa} !== ${sb}`);
};

const TENANT = "acme-sheds";
const PARENT = "AC" + "0".repeat(32);
const PARENT_TOKEN = "parentauthtoken" + "p".repeat(17);
const PARENT_KEY = "SK" + "0".repeat(32);
const ENV: Record<string, string> = {
  TWILIO_SUBACCOUNTS: "on",
  TWILIO_ACCOUNT_SID: PARENT,
  TWILIO_AUTH_TOKEN: PARENT_TOKEN,
  TWILIO_API_KEY: PARENT_KEY,
  TWILIO_API_SECRET: "parent-api-secret",
  PHONE_API_BASE: "https://phone.example.test",
  PHONE_WEBHOOK_SECRET: "voicekey123",
  PHONE_FALLBACK_URL: "https://handler.twilio.com/twiml/EH" + "0".repeat(32),
  TWILIO_SUB_APP_FALLBACK_URL: "https://static.example.test/twiml/calling-problem.xml",
  TWILIO_SUB_VOICEMAIL_URL: "https://static.example.test/twiml/voicemail.xml",
  SUPABASE_URL: "https://project.example.test",
  TWILIO_EVENTS_SECRET: "eventskey456",
};
const envOf = (over: Record<string, string | undefined> = {}) => {
  const e: Record<string, string | undefined> = { ...ENV, ...over };
  return (k: string) => e[k];
};
const ON = envOf();
const OFF = envOf({ TWILIO_SUBACCOUNTS: undefined });

const untouchable = new Proxy({}, { get: (_t, prop) => { throw new Error(`the database was touched (${String(prop)})`); } });
const noHttp: ProvisionHttp = () => { throw new Error("Twilio was called"); };

// ── The fake database ────────────────────────────────────────────────────────────────────────
type Row = Record<string, unknown>;
class FakeDb {
  accounts = new Map<string, Row>();
  settings = new Map<string, Row>();
  holdings = new Map<string, string>();
  numbers: Row[] = [];
  vault = new Map<string, string>();
  material: Record<string, Row> = {
    apns_dev: { kind: "apns_dev", certificate: "-----BEGIN CERTIFICATE-----dev", private_key: "-----BEGIN KEY-----dev", secret: null },
    apns_prod: { kind: "apns_prod", certificate: "-----BEGIN CERTIFICATE-----prod", private_key: "-----BEGIN KEY-----prod", secret: null },
    fcm: { kind: "fcm", certificate: null, private_key: null, secret: '{"type":"service_account"}' },
  };
  /** rpc name (or "<rpc>:<kind>" for secret_put) → how many more calls fail. */
  failRpc = new Map<string, number>();
  /** twilio_accounts answers PostgREST's "no such table" (migration 292 not applied). */
  missingTable = false;
  /** twilio_account_forget answers "no such function" (migration 295 not applied). */
  missingForget = false;
  log: string[] = [];

  private trip(name: string): boolean {
    const n = this.failRpc.get(name) ?? 0;
    if (n > 0) { this.failRpc.set(name, n - 1); return true; }
    return false;
  }

  rpc(name: string, args: Record<string, string>) {
    this.log.push(`rpc ${name}`);
    const err = (code = "XX000") => Promise.resolve({ data: null, error: { code, message: "boom" } });
    if (name === "twilio_parent_holdings") return Promise.resolve({ data: this.holdings.get(args.p_client_id) ?? null, error: null });
    if (name === "twilio_account_secret_put") {
      if (this.trip(name) || this.trip(`${name}:${args.p_kind}`)) return err();
      const row = this.accounts.get(args.p_client_id)!;
      const vaultName = `twilio_${args.p_kind}_${row.account_sid}`;
      this.vault.set(vaultName, args.p_secret);
      row[args.p_kind === "auth_token" ? "auth_token_id" : "api_secret_id"] = vaultName;
      return Promise.resolve({ data: null, error: null });
    }
    if (name === "twilio_account_creds") {
      if (this.trip(name)) return err();
      const row = this.accounts.get(args.p_client_id);
      if (!row) return Promise.resolve({ data: [], error: null });
      const sid = String(row.account_sid);
      return Promise.resolve({
        data: [{
          ...row,
          auth_token: row.auth_token_id === `twilio_auth_token_${sid}` ? this.vault.get(`twilio_auth_token_${sid}`) ?? null : null,
          api_secret: row.api_secret_id === `twilio_api_secret_${sid}` ? this.vault.get(`twilio_api_secret_${sid}`) ?? null : null,
        }],
        error: null,
      });
    }
    if (name === "twilio_push_material") {
      if (this.trip(name)) return err();
      return Promise.resolve({ data: Object.values(this.material), error: null });
    }
    if (name === "twilio_account_forget") {
      if (this.missingForget) return err("PGRST202");
      const row = this.accounts.get(args.p_client_id);
      if (!row) return Promise.resolve({ data: "none", error: null });
      if (row.kind === "sub" && row.account_sid && row.status !== "closed") return err("55000");
      this.accounts.delete(args.p_client_id);
      return Promise.resolve({ data: row.kind === "parent" ? "parent_pin" : row.account_sid ? "closed_sub" : "never_created", error: null });
    }
    throw new Error(`unexpected rpc ${name}`);
  }

  from(table: string) {
    // deno-lint-ignore no-this-alias
    const db = this;
    const q: { op: string; patch?: Row; filters: Array<(r: Row) => boolean>; select?: string; head?: boolean; opts?: Row } =
      { op: "select", filters: [] };
    const rowsOf = (): Row[] => {
      if (table === "twilio_accounts") return [...db.accounts.values()];
      if (table === "client_settings") return [...db.settings.values()];
      if (table === "sms_numbers") return db.numbers;
      throw new Error(`unexpected table ${table}`);
    };
    const run = (single: boolean) => {
      db.log.push(`${q.op} ${table}`);
      if (table === "twilio_accounts" && db.missingTable) return { data: null, error: { code: "PGRST205", message: "no such table" } };
      const hit = rowsOf().filter((r) => q.filters.every((f) => f(r)));
      if (q.op === "delete") {
        if (table !== "twilio_accounts") throw new Error("delete only on twilio_accounts");
        for (const r of hit) db.accounts.delete(String(r.client_id));
        return { data: null, error: null };
      }
      if (q.op === "select") {
        if (q.head) return { data: null, count: hit.length, error: null };
        return { data: single ? (hit[0] ? { ...hit[0] } : null) : hit.map((r) => ({ ...r })), error: null };
      }
      if (q.op === "update") {
        for (const r of hit) Object.assign(r, q.patch);
        const out = hit.map((r) => ({ ...r }));
        return { data: q.select ? (single ? out[0] ?? null : out) : null, error: null };
      }
      if (q.op === "upsert") {
        const row = q.patch!;
        const id = String(row.client_id);
        if (table !== "twilio_accounts") throw new Error("upsert only on twilio_accounts");
        if (db.accounts.has(id)) return { data: null, error: null };
        if (row.kind === "sub" && db.holdings.get(id)) return { data: null, error: { code: "23514", message: "twilio_accounts_no_split" } };
        db.accounts.set(id, {
          client_id: id, kind: row.kind, account_sid: null, status: row.status ?? "provisioning", api_key_sid: null, api_secret_id: null,
          auth_token_id: null, twiml_app_sid: null, push_apns_dev_sid: null, push_apns_prod_sid: null, push_fcm_sid: null,
          events_sink_sid: null, events_subscription_sid: null, provision_step: row.provision_step ?? null, provision_lock_until: null,
          last_error: null, push_skipped: null, created_at: "2026-10-09T00:00:00Z", updated_at: "2026-10-09T00:00:00Z",
        });
        return { data: null, error: null };
      }
      throw new Error(`unexpected op ${q.op}`);
    };
    const b = {
      select: (cols?: string, o?: Row) => { if (q.op === "select") { q.head = !!o?.head; } else q.select = cols ?? "*"; return b; },
      update: (patch: Row) => { q.op = "update"; q.patch = patch; return b; },
      upsert: (row: Row, o?: Row) => { q.op = "upsert"; q.patch = row; q.opts = o; return b; },
      delete: () => { q.op = "delete"; return b; },
      eq: (c: string, v: unknown) => { q.filters.push((r) => r[c] === v); return b; },
      is: (c: string, v: unknown) => { q.filters.push((r) => (r[c] ?? null) === v); return b; },
      or: (expr: string) => {
        // provision_lock_until.is.null,provision_lock_until.lt.<iso>
        const parts = expr.split(",").map((p) => p.split("."));
        q.filters.push((r) => parts.some(([c, op, ...rest]) => {
          const v = rest.join(".");
          if (op === "is" && v === "null") return (r[c] ?? null) === null;
          if (op === "lt") return r[c] != null && Date.parse(String(r[c])) < Date.parse(v);
          throw new Error(`or: ${op}`);
        }));
        return b;
      },
      maybeSingle: () => Promise.resolve(run(true)),
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(run(false)).then(res, rej),
    };
    return b;
  }
}

// ── The fake Twilio ──────────────────────────────────────────────────────────────────────────
type Op =
  | "list_accounts" | "create_account" | "fetch_account" | "update_account"
  | "list_keys" | "create_key" | "delete_key"
  | "list_apps" | "create_app" | "update_app"
  | "list_creds" | "create_cred"
  | "list_sinks" | "create_sink" | "test_sink"
  | "list_subs" | "create_sub"
  | "settings" | "list_numbers";

let seq = 0;
const sid = (prefix: string) => prefix + String(++seq).padStart(32, "a").slice(-32).replace(/[^0-9a-f]/g, "a");

class FakeTwilio {
  accounts = new Map<string, { sid: string; friendly_name: string; status: string; auth_token: string }>();
  keys = new Map<string, { sid: string; friendly_name: string; secret: string; account: string }>();
  apps = new Map<string, { sid: string; friendly_name: string; account: string; form: Record<string, string> }>();
  creds = new Map<string, { sid: string; friendly_name: string; account: string; form: Record<string, string> }>();
  sinks = new Map<string, { sid: string; description: string; account: string; config: string }>();
  subs = new Map<string, { sid: string; description: string; sink: string; account: string; types: string[]; versions: number[] }>();
  numbers = new Map<string, string[]>();
  inherit = true;
  /** op → remaining times the request never reaches Twilio (throws first). */
  down = new Map<Op, number>();
  /** op → remaining times Twilio ACTS and the answer is lost (throws after). */
  lose = new Map<Op, number>();
  calls: { op: Op; auth: BasicAuth; form: Record<string, string>; formPairs: Array<[string, string]> }[] = [];

  count(op: Op) { return this.calls.filter((c) => c.op === op).length; }

  private take(m: Map<Op, number>, op: Op): boolean {
    const n = m.get(op) ?? 0;
    if (n > 0) { m.set(op, n - 1); return true; }
    return false;
  }

  /** Which account these credentials ARE, or null: the parent's token, a sub's token, or a key. */
  private who(auth: BasicAuth): { account: string; main: boolean } | null {
    if (auth.user === PARENT && auth.pass === PARENT_TOKEN) return { account: PARENT, main: true };
    if (auth.user === PARENT_KEY) return { account: PARENT, main: false };
    const a = this.accounts.get(auth.user);
    if (a && a.auth_token === auth.pass) return { account: a.sid, main: true };
    const k = this.keys.get(auth.user);
    if (k && k.secret === auth.pass) return { account: k.account, main: false };
    return null;
  }

  http: ProvisionHttp = async (method, url, auth, formPairs = []) => {
    const u = new URL(url);
    const form = Object.fromEntries(formPairs);
    const op = this.opOf(method, u);
    this.calls.push({ op, auth, form, formPairs });
    if (this.take(this.down, op)) throw new Error("connection reset");
    const res = this.act(op, method, u, auth, form, formPairs);
    if (this.take(this.lose, op)) throw new Error("response lost");
    return await Promise.resolve(res);
  };

  private opOf(method: string, u: URL): Op {
    const p = u.pathname;
    if (u.host === "api.twilio.com") {
      if (/\/Accounts\.json$/.test(p)) return method === "GET" ? "list_accounts" : "create_account";
      if (/\/Accounts\/AC\w+\.json$/.test(p)) return method === "GET" ? "fetch_account" : "update_account";
      if (/\/Applications\.json$/.test(p)) return method === "GET" ? "list_apps" : "create_app";
      if (/\/Applications\/AP\w+\.json$/.test(p)) return "update_app";
      if (/\/IncomingPhoneNumbers\.json$/.test(p)) return "list_numbers";
    }
    if (u.host === "iam.twilio.com") return method === "GET" ? "list_keys" : method === "DELETE" ? "delete_key" : "create_key";
    if (u.host === "chat.twilio.com") return method === "GET" ? "list_creds" : "create_cred";
    if (u.host === "events.twilio.com") {
      if (/\/Test$/.test(p)) return "test_sink";
      if (/\/Sinks/.test(p)) return method === "GET" ? "list_sinks" : "create_sink";
      if (/\/Subscriptions/.test(p)) return method === "GET" ? "list_subs" : "create_sub";
    }
    if (u.host === "voice.twilio.com") return "settings";
    throw new Error(`fake Twilio: no route for ${method} ${u.href}`);
  }

  private act(op: Op, _method: string, u: URL, auth: BasicAuth, form: Record<string, string>, pairs: Array<[string, string]>) {
    const who = this.who(auth);
    const no = { status: 401, body: { code: 20003, message: "Authenticate" } };
    if (!who) return no;
    const acctInPath = /\/Accounts\/(AC\w{32})/.exec(u.pathname)?.[1] ?? null;
    // Twilio: a MAIN account's credentials reach its subs on api.twilio.com; a key only its own
    // account; subdomain resources only the account's own credentials.
    const reaches = (target: string) =>
      who.account === target || (who.account === PARENT && who.main && u.host === "api.twilio.com" && this.accounts.has(target));
    switch (op) {
      case "list_accounts": {
        if (!(who.account === PARENT && who.main)) return no;
        const fn = u.searchParams.get("FriendlyName");
        return { status: 200, body: { accounts: [...this.accounts.values()].filter((a) => !fn || a.friendly_name === fn) } };
      }
      case "create_account": {
        if (!(who.account === PARENT && who.main)) return no;
        const a = { sid: sid("AC"), friendly_name: form.FriendlyName, status: "active", auth_token: "subtoken" + String(seq).padStart(24, "0") };
        this.accounts.set(a.sid, a);
        return { status: 201, body: a };
      }
      case "fetch_account": {
        // Twilio: a Standard API key can reach everything EXCEPT the Accounts resource and Keys.
        if (!who.main) return no;
        if (!reaches(acctInPath!)) return no;
        const a = this.accounts.get(acctInPath!);
        return a ? { status: 200, body: a } : { status: 404, body: { code: 20404 } };
      }
      case "update_account": {
        if (!(who.account === PARENT && who.main)) return no;
        const a = this.accounts.get(acctInPath!)!;
        a.status = form.Status;
        return { status: 200, body: a };
      }
      case "list_keys": {
        const acct = u.searchParams.get("AccountSid")!;
        if (!(who.account === acct && who.main)) return no;
        return { status: 200, body: { keys: [...this.keys.values()].filter((k) => k.account === acct).map(({ secret: _s, ...k }) => k) } };
      }
      case "create_key": {
        if (!(who.account === form.AccountSid && who.main)) return no;
        const k = { sid: sid("SK"), friendly_name: form.FriendlyName, secret: "keysecret" + String(seq).padStart(23, "0"), account: form.AccountSid };
        this.keys.set(k.sid, k);
        return { status: 201, body: k };
      }
      case "delete_key": {
        const id = u.pathname.split("/").pop()!;
        const k = this.keys.get(id);
        if (!k) return { status: 404, body: { code: 20404 } };
        if (who.account !== k.account) return no;
        this.keys.delete(id);
        return { status: 204, body: {} };
      }
      case "list_apps": {
        if (!reaches(acctInPath!)) return no;
        const fn = u.searchParams.get("FriendlyName");
        return { status: 200, body: { applications: [...this.apps.values()].filter((a) => a.account === acctInPath && (!fn || a.friendly_name === fn)) } };
      }
      case "create_app": {
        if (!reaches(acctInPath!)) return no;
        const a = { sid: sid("AP"), friendly_name: form.FriendlyName, account: acctInPath!, form };
        this.apps.set(a.sid, a);
        return { status: 201, body: a };
      }
      case "update_app": {
        if (!reaches(acctInPath!)) return no;
        const a = this.apps.get(u.pathname.split("/").pop()!.replace(".json", ""))!;
        a.form = { ...a.form, ...form };
        return { status: 200, body: a };
      }
      case "list_creds":
        return { status: 200, body: { credentials: [...this.creds.values()].filter((c) => c.account === who.account) } };
      case "create_cred": {
        const c = { sid: sid("CR"), friendly_name: form.FriendlyName, account: who.account, form };
        this.creds.set(c.sid, c);
        return { status: 201, body: c };
      }
      case "list_sinks":
        return { status: 200, body: { sinks: [...this.sinks.values()].filter((s) => s.account === who.account) } };
      case "create_sink": {
        const s = { sid: sid("DG"), description: form.Description, account: who.account, config: form.SinkConfiguration };
        this.sinks.set(s.sid, s);
        return { status: 201, body: s };
      }
      case "test_sink":
        return { status: 200, body: { result: "submitted" } };
      case "list_subs": {
        const sink = u.searchParams.get("SinkSid");
        return { status: 200, body: { subscriptions: [...this.subs.values()].filter((s) => s.account === who.account && (!sink || s.sink === sink)) } };
      }
      case "create_sub": {
        const s = {
          sid: sid("DF"), description: form.Description, sink: form.SinkSid, account: who.account,
          types: pairs.filter(([k]) => k === "Types").map(([, v]) => JSON.parse(v).type),
          versions: pairs.filter(([k]) => k === "Types").map(([, v]) => JSON.parse(v).schema_version),
        };
        this.subs.set(s.sid, s);
        return { status: 201, body: s };
      }
      case "settings":
        return { status: 200, body: { dialing_permissions_inheritance: this.inherit } };
      case "list_numbers":
        if (!reaches(acctInPath!)) return no;
        return { status: 200, body: { incoming_phone_numbers: (this.numbers.get(acctInPath!) ?? []).map((n) => ({ phone_number: n })) } };
    }
  }
}

const world = () => ({ db: new FakeDb(), tw: new FakeTwilio() });
const ensure = (w: ReturnType<typeof world>, over: Partial<Parameters<typeof ensureTwilioAccount>[2]> = {}) =>
  ensureTwilioAccount(w.db, TENANT, { get: ON, http: w.tw.http, ...over });
const row = (w: ReturnType<typeof world>) => w.db.accounts.get(TENANT)!;

/** Every object a finished run should have made, exactly once, in the sub. */
function assertComplete(w: ReturnType<typeof world>, what = "") {
  const r = row(w);
  const sub = String(r.account_sid);
  assertEquals([r.kind, r.status, r.provision_step, r.last_error, r.provision_lock_until], ["sub", "active", "done", null, null], `${what} row`);
  assertEquals([...w.tw.accounts.values()].filter((a) => a.friendly_name === TENANT).length, 1, `${what} one sub-account`);
  assertEquals([...w.tw.keys.values()].filter((k) => k.account === sub).length, 1, `${what} one key in the sub`);
  assertEquals([...w.tw.apps.values()].filter((a) => a.account === sub).length, 1, `${what} one TwiML App in the sub`);
  assertEquals([...w.tw.creds.values()].filter((c) => c.account === sub).length, 3, `${what} three push credentials in the sub`);
  assertEquals([...w.tw.sinks.values()].filter((s) => s.account === sub).length, 1, `${what} one sink in the sub`);
  assertEquals([...w.tw.subs.values()].filter((s) => s.account === sub).length, 1, `${what} one subscription in the sub`);
  // And every SID on the row is the one Twilio holds.
  const key = [...w.tw.keys.values()].find((k) => k.account === sub)!;
  assertEquals(r.api_key_sid, key.sid, `${what} the row's key is the live one`);
  assertEquals(w.db.vault.get(`twilio_api_secret_${sub}`), key.secret, `${what} and Vault holds its secret`);
  assertEquals(w.db.vault.get(`twilio_auth_token_${sub}`), w.tw.accounts.get(sub)!.auth_token, `${what} Vault holds the sub's token`);
}

// ── The switch ───────────────────────────────────────────────────────────────────────────────
Deno.test("switch off: the parent, with no database read, no write and no Twilio request", async () => {
  for (const v of [undefined, "", "off", "ON", "true"]) {
    const r = await ensureTwilioAccount(untouchable, TENANT, { get: envOf({ TWILIO_SUBACCOUNTS: v }), http: noHttp });
    assertEquals(r, { ok: true, kind: "parent", reason: "switch_off" }, `"${v}"`);
  }
});

Deno.test("switch off, the operator's Create: it runs anyway (the first test sub)", async () => {
  const w = world();
  const r = await ensureTwilioAccount(w.db, TENANT, { get: OFF, http: w.tw.http, operator: true });
  assert(r.ok && r.kind === "sub", JSON.stringify(r));
  assertComplete(w);
});

// ── Who stays on the parent ──────────────────────────────────────────────────────────────────
Deno.test("a parent pin, our internal account, or anything held on the parent: the parent, and Twilio is never asked", async () => {
  const pinned = world();
  pinned.db.accounts.set(TENANT, { client_id: TENANT, kind: "parent", status: "active" });
  assertEquals(await ensure(pinned, { http: noHttp }), { ok: true, kind: "parent", reason: "pinned" });
  for (const operator of [false, true]) {
    const internal = world();
    internal.db.settings.set(TENANT, { client_id: TENANT, internal_account: true });
    assertEquals(await ensure(internal, { http: noHttp, operator }), { ok: true, kind: "parent", reason: "internal" });
    assertEquals([row(internal).kind, row(internal).account_sid], ["parent", null], "a pin is written for next time");
    const holds = world();
    holds.db.holdings.set(TENANT, "a live number");
    assertEquals(await ensure(holds, { http: noHttp, operator }), { ok: true, kind: "parent", reason: "parent_holdings" });
    assertEquals(row(holds).kind, "parent");
  }
});

Deno.test("the database guard refusing a sub row (twilio_accounts_no_split) is the parent, not a sub", async () => {
  const w = world();
  // Holdings appear between the check and the insert.
  let n = 0;
  const realRpc = w.db.rpc.bind(w.db);
  w.db.rpc = (name: string, args: Record<string, string>) => {
    if (name === "twilio_parent_holdings" && n++ === 0) return Promise.resolve({ data: null, error: null });
    return realRpc(name, args);
  };
  w.db.holdings.set(TENANT, "a texting registration");
  assertEquals(await ensure(w, { http: noHttp }), { ok: true, kind: "parent", reason: "parent_holdings" });
  assert(!w.db.accounts.has(TENANT));
});

// ── A full run ───────────────────────────────────────────────────────────────────────────────
Deno.test("a full run: every object once, inside the sub, with the sub's own credentials", async () => {
  const w = world();
  const r = await ensure(w);
  assert(r.ok && r.kind === "sub" && r.ran, JSON.stringify(r));
  assertComplete(w);
  const sub = String(row(w).account_sid);
  assertEquals((r as { accountSid: string }).accountSid, sub);
  // The sub-account: made with the PARENT's Account SID + auth token, named for the client_id only.
  const made = w.tw.calls.find((c) => c.op === "create_account")!;
  assertEquals([made.auth.user, made.auth.pass, made.form.FriendlyName], [PARENT, PARENT_TOKEN, TENANT]);
  // Nothing after the account step ever carries the parent's credentials.
  const after = w.tw.calls.slice(w.tw.calls.indexOf(made) + 1);
  assert(after.every((c) => c.auth.user !== PARENT && c.auth.user !== PARENT_KEY), "a parent credential was used inside the sub");
  // The key: minted inside the sub with the sub's SID + token.
  const key = w.tw.calls.find((c) => c.op === "create_key")!;
  assertEquals([key.auth.user, key.form.AccountSid, key.form.FriendlyName], [sub, sub, TENANT]);
  // The TwiML App: the Worker's URLs, each carrying the key; the status callback is the client leg.
  const app = [...w.tw.apps.values()][0];
  assertEquals(app.form.VoiceUrl, "https://phone.example.test/voice/outbound?key=voicekey123");
  assertEquals(app.form.StatusCallback, "https://phone.example.test/voice/status?leg=client&key=voicekey123");
  // Never the parent's Bin (a Bin answers only its owner): the sub's own static TwiML, by GET.
  assertEquals([app.form.VoiceFallbackUrl, app.form.VoiceFallbackMethod], ["https://static.example.test/twiml/calling-problem.xml", "GET"]);
  assertEquals(app.friendly_name, TENANT);
  // Push: both APNs credentials with Sandbox unticked, FCM with the service account; named for the tenant.
  const creds = [...w.tw.creds.values()].sort((a, b) => a.friendly_name.localeCompare(b.friendly_name));
  assertEquals(creds.map((c) => [c.friendly_name, c.form.Type, c.form.Sandbox ?? null]),
    [[pushName(TENANT, "apns_dev"), "apn", "false"], [pushName(TENANT, "apns_prod"), "apn", "false"], [pushName(TENANT, "fcm"), "fcm", null]]);
  assertEquals(row(w).push_skipped, null);
  // Events: the sink to twilio-events with the key; the subscription to every A2P type.
  const sink = [...w.tw.sinks.values()][0];
  assertEquals(JSON.parse(sink.config), { destination: "https://project.example.test/functions/v1/twilio-events?key=eventskey456", method: "POST", batch_events: false });
  assertEquals([...w.tw.subs.values()][0].types, [...A2P_EVENT_TYPES]);
  assert([...w.tw.subs.values()][0].versions.every((v) => v === 1), "A2P events have schema version 1 only");
  assertEquals(w.tw.count("test_sink"), 1, "the new sink is sent Twilio's test event once");
  // The lock was taken and given back.
  assertEquals(row(w).provision_lock_until, null);
});

Deno.test("an active sub: the fast path, one read, no lock and no Twilio", async () => {
  const w = world();
  await ensure(w);
  w.db.log.length = 0;
  const r = await ensure(w, { http: noHttp });
  assert(r.ok && r.kind === "sub" && !r.ran);
  assertEquals(w.db.log, ["select twilio_accounts"]);
});

Deno.test("TWILIO_EVENT_TYPES replaces the list (the parent's, copied, versions included); a malformed one is refused as configuration", async () => {
  const w = world();
  await ensure(w, { get: envOf({ TWILIO_EVENT_TYPES: "com.twilio.messaging.compliance.number-registration.successful, com.twilio.x.y@2" }) });
  assertEquals([...w.tw.subs.values()][0].types, ["com.twilio.messaging.compliance.number-registration.successful", "com.twilio.x.y"]);
  assertEquals([...w.tw.subs.values()][0].versions, [1, 2], "type@version keeps the parent's schema version");
  for (const bad of ["com.twilio.x@0", "com.twilio.x@v2", "com.twilio.x@", ""]) assertEquals(parseEventTypes(bad), null, bad);
  const bad = world();
  const r = await ensure(bad, { get: envOf({ TWILIO_EVENT_TYPES: "brand-registered" }), http: noHttp });
  assert(!r.ok && r.reason === "not_configured" && r.missing?.includes("TWILIO_EVENT_TYPES"), JSON.stringify(r));
});

// ── Configuration ────────────────────────────────────────────────────────────────────────────
Deno.test("the parent's API key without its auth token: refused, nothing written, Twilio never asked", async () => {
  const w = world();
  const r = await ensure(w, { get: envOf({ TWILIO_AUTH_TOKEN: undefined }), http: noHttp });
  assertEquals(r.ok, false);
  if (r.ok) return;
  assertEquals([r.reason, r.status, r.code, r.parentKeyOnly], ["not_configured", 503, "parent_token_missing", true]);
  assertEquals(r.missing, ["TWILIO_AUTH_TOKEN"]);
  assert(!w.db.accounts.has(TENANT), "no row was made");
  assertEquals(ensureRefusalSentence(r), "Phone numbers aren't available on this server yet.");
});

Deno.test("each missing setting is named (never its value)", () => {
  const c = provisionConfig(envOf({ PHONE_WEBHOOK_SECRET: "", TWILIO_SUB_VOICEMAIL_URL: "http://insecure", TWILIO_EVENTS_SECRET: undefined }));
  assert(!c.ok);
  if (!c.ok) assertEquals(c.missing, ["PHONE_WEBHOOK_SECRET", "TWILIO_SUB_VOICEMAIL_URL", "TWILIO_EVENTS_SECRET"]);
  const app = provisionConfig(envOf({ PHONE_API_BASE: "" }));
  assert(app.ok && app.config.fallbackUrl === "https://static.example.test/twiml/calling-problem.xml", "the sub's own app fallback");
  assert(app.ok && app.config.voiceUrl.startsWith("https://phone.structurestudiosuite.com/voice/outbound?key="), "the default Worker base");
});

Deno.test("the sub's fallbacks are never a Twilio Bin (a Bin answers only the account that owns it), nor the parent's PHONE_FALLBACK_URL", () => {
  const bin = "https://handler.twilio.com/twiml/EH" + "1".repeat(32);
  for (const name of ["TWILIO_SUB_APP_FALLBACK_URL", "TWILIO_SUB_VOICEMAIL_URL"]) {
    const c = provisionConfig(envOf({ [name]: bin }));
    assert(!c.ok && c.missing.includes(name), `${name} = a Bin: ${JSON.stringify(c)}`);
    const studio = provisionConfig(envOf({ [name]: "https://webhooks.twilio.com/v1/Accounts/AC" + "1".repeat(32) + "/Flows/FW" + "1".repeat(32) }));
    assert(!studio.ok && studio.missing.includes(name), `${name} = a Studio flow`);
  }
  // Unset, the parent's Bin is never borrowed.
  const none = provisionConfig(envOf({ TWILIO_SUB_APP_FALLBACK_URL: undefined }));
  assert(!none.ok && none.missing.includes("TWILIO_SUB_APP_FALLBACK_URL"), JSON.stringify(none));
  assertEquals(accountFetchableUrl("https://my-service-1234.twil.io/voicemail.xml"), "https://my-service-1234.twil.io/voicemail.xml");
  assertEquals(accountFetchableUrl("https://HANDLER.twilio.com/twiml/EHx"), null);
  assertEquals(accountFetchableUrl("http://static.example.test/x.xml"), null);
});

// ── Resume from every step ───────────────────────────────────────────────────────────────────
const STOPS: Array<[string, Parameters<FakeTwilio["down"]["set"]>[0], string]> = [
  ["account", "create_account", "account"],
  ["auth token (re-read)", "fetch_account", "verify"],
  ["api key", "create_key", "api_key"],
  ["twiml app", "create_app", "twiml_app"],
  ["push", "create_cred", "push"],
  ["events: sink", "create_sink", "events"],
  ["events: subscription", "create_sub", "events"],
  ["verify: dialing permissions", "settings", "verify"],
];
for (const [label, op, step] of STOPS) {
  Deno.test(`resume from ${label}: the run that stops there is finished by the next, nothing made twice`, async () => {
    const w = world();
    w.tw.down.set(op, 1);
    const first = await ensure(w);
    assert(!first.ok && first.reason === "failed" && first.step === step && first.code === "unreachable", `${label}: ${JSON.stringify(first)}`);
    assertEquals([row(w).status, row(w).provision_step, row(w).last_error, row(w).provision_lock_until],
      ["failed", step, `${step}:unreachable`, null], `${label}: recorded and unlocked`);
    const second = await ensure(w);
    assert(second.ok && second.kind === "sub", `${label}: ${JSON.stringify(second)}`);
    assertComplete(w, label);
  });
}

// ── Lost responses ───────────────────────────────────────────────────────────────────────────
const LOST: Array<[Parameters<FakeTwilio["lose"]["set"]>[0], string]> = [
  ["create_account", "account"], ["create_key", "api_key"], ["create_app", "twiml_app"], ["create_cred", "push"],
  ["create_sink", "events"], ["create_sub", "events"],
];
for (const [op, step] of LOST) {
  Deno.test(`a lost response on ${op}: Twilio made it, the next run finds it by name instead of making another`, async () => {
    const w = world();
    w.tw.lose.set(op, 1);
    const first = await ensure(w);
    assert(!first.ok && first.step === step, JSON.stringify(first));
    const second = await ensure(w);
    assert(second.ok && second.kind === "sub", JSON.stringify(second));
    assertComplete(w, op);
    if (op === "create_key") {
      // The orphan's secret was never seen: it is deleted, and one fresh key made in its place.
      assertEquals(w.tw.count("delete_key"), 1, "the orphaned key is deleted");
      assertEquals(w.tw.count("create_key"), 2);
    } else {
      // One per object: three push kinds, one of everything else.
      assertEquals(w.tw.count(op), op === "create_cred" ? 3 : 1, `${op} happened once per object`);
    }
  });
}

Deno.test("a lost create_account answer: the token is taken from the found account (or re-read with the parent's)", async () => {
  const w = world();
  w.tw.lose.set("create_account", 1);
  await ensure(w);
  assertEquals(row(w).account_sid, null, "nothing was written: the SID never came back");
  await ensure(w);
  assertComplete(w);
});

// ── The lock ─────────────────────────────────────────────────────────────────────────────────
Deno.test("the lock: a second caller while it is held is busy (409) and touches nothing", async () => {
  const w = world();
  w.db.accounts.set(TENANT, {
    client_id: TENANT, kind: "sub", account_sid: null, status: "provisioning", provision_step: "account",
    provision_lock_until: new Date(Date.now() + 60_000).toISOString(),
  });
  const r = await ensure(w, { http: noHttp });
  assert(!r.ok && r.reason === "busy" && r.status === 409, JSON.stringify(r));
  assertEquals(ensureRefusalSentence(r as Extract<typeof r, { ok: false }>), "Your phone account is being set up right now. Try again in a minute.");
  // An EXPIRED lock (a run that died) is taken over.
  row(w).provision_lock_until = new Date(Date.now() - 1000).toISOString();
  const again = await ensure(w);
  assert(again.ok && again.kind === "sub", JSON.stringify(again));
});

Deno.test("a run whose lock was taken over stops at its next write (lock_lost → busy), never writes past it", async () => {
  const w = world();
  // Twilio is slow on the key; meanwhile another run takes the (expired) lock.
  const real = w.tw.http;
  w.tw.http = async (m, u, a, f) => {
    if (u.startsWith("https://iam.twilio.com/v1/Keys") && m === "POST") row(w).provision_lock_until = "2099-01-01T00:00:00.000Z";
    return await real(m, u, a, f);
  };
  const r = await ensure(w);
  assert(!r.ok && r.reason === "busy" && r.code === "lock_lost", JSON.stringify(r));
  assertEquals(row(w).api_key_sid, null, "the stolen row was not written");
  assertEquals(row(w).provision_lock_until, "2099-01-01T00:00:00.000Z", "and the other run's lock is not released");
});

// ── Vault ────────────────────────────────────────────────────────────────────────────────────
Deno.test("Vault refusing the auth token stops the run BEFORE the API key is made", async () => {
  const w = world();
  w.db.failRpc.set("twilio_account_secret_put:auth_token", 1);
  const r = await ensure(w);
  assert(!r.ok && r.step === "auth_token" && r.code === "vault", JSON.stringify(r));
  assertEquals(w.tw.count("create_key"), 0, "no key was made");
  assert(row(w).account_sid, "the account SID was written the moment it existed");
  const again = await ensure(w);
  assert(again.ok, JSON.stringify(again));
  assertEquals(w.tw.count("create_account"), 1, "the account is not made twice");
  assertEquals(w.tw.count("fetch_account") >= 1, true, "its token is re-read with the parent's credentials");
  assertComplete(w);
});

Deno.test("Vault refusing the key's secret stops BEFORE the TwiML App; the next run replaces the key", async () => {
  const w = world();
  w.db.failRpc.set("twilio_account_secret_put:api_secret", 1);
  const r = await ensure(w);
  assert(!r.ok && r.step === "api_key" && r.code === "vault", JSON.stringify(r));
  assertEquals([w.tw.count("create_app"), w.tw.count("list_apps")], [0, 0], "nothing after the key was asked for");
  assert(row(w).api_key_sid, "the key's SID was written the moment it existed");
  await ensure(w);
  assertEquals(w.tw.count("delete_key"), 1, "the key whose secret was never stored is deleted");
  assertComplete(w);
});

Deno.test("Vault unreadable (twilio_account_creds failing): stopped, nothing more is made", async () => {
  const w = world();
  w.db.failRpc.set("twilio_account_creds", 1);
  const r = await ensure(w);
  assert(!r.ok && r.step === "auth_token" && r.code === "vault", JSON.stringify(r));
  assertEquals(w.tw.count("create_key"), 0);
});

// ── Push material ────────────────────────────────────────────────────────────────────────────
Deno.test("missing push material is skipped and recorded; the operator's Create fills it in once it is loaded", async () => {
  const w = world();
  w.db.material.apns_dev = { kind: "apns_dev", certificate: "-----BEGIN CERTIFICATE-----dev", private_key: null, secret: null };
  w.db.material.fcm = { kind: "fcm", certificate: null, private_key: null, secret: null };
  const r = await ensure(w);
  assert(r.ok && r.kind === "sub", JSON.stringify(r));
  assertEquals((r as { pushSkipped: string[] }).pushSkipped, ["apns_dev", "fcm"]);
  assertEquals([row(w).status, row(w).push_skipped], ["active", ["apns_dev", "fcm"]], "active anyway: calls work without push");
  assertEquals([...w.tw.creds.values()].length, 1);
  // A builder's call does not retry it (the fast path) ...
  assert((await ensure(w, { http: noHttp })).ok);
  // ... the operator's Create does, once the material is in Vault.
  w.db.material.apns_dev.private_key = "-----BEGIN KEY-----dev";
  w.db.material.fcm.secret = '{"type":"service_account"}';
  const refill = await ensure(w, { operator: true });
  assert(refill.ok && refill.kind === "sub" && refill.ran, JSON.stringify(refill));
  assertComplete(w, "refill");
  assertEquals(w.tw.count("create_account"), 1);
});

Deno.test("twilio_push_material failing is a stop, not a silent skip", async () => {
  const w = world();
  w.db.failRpc.set("twilio_push_material", 1);
  const r = await ensure(w);
  assert(!r.ok && r.step === "push" && r.code === "vault", JSON.stringify(r));
  assertEquals(w.tw.count("create_cred"), 0);
});

// ── Verify ───────────────────────────────────────────────────────────────────────────────────
Deno.test("dialing permissions NOT inherited: stopped at verify (409), never active", async () => {
  const w = world();
  w.tw.inherit = false;
  const r = await ensure(w);
  assert(!r.ok && r.step === "verify" && r.code === "dialing_permissions_not_inherited" && r.status === 409, JSON.stringify(r));
  assertEquals(row(w).status, "failed");
  w.tw.inherit = true;
  assert((await ensure(w)).ok);
  assertComplete(w);
});

Deno.test("a stored token Twilio rejects: stopped at verify, never active", async () => {
  const w = world();
  // Vault ends up with the wrong token.
  const realRpc = w.db.rpc.bind(w.db);
  w.db.rpc = (name: string, args: Record<string, string>) =>
    realRpc(name, name === "twilio_account_secret_put" && args.p_kind === "auth_token" ? { ...args, p_secret: "wrongtoken" + "z".repeat(22) } : args);
  const r = await ensure(w);
  // The run itself used the token Twilio handed it; the check reads back what Vault HOLDS.
  assert(!r.ok && r.step === "verify" && r.code === "20003", JSON.stringify(r));
  assertEquals([row(w).status, row(w).last_error], ["failed", "verify:20003"]);
});

Deno.test("a suspended or closed sub: refused (403), Twilio never asked", async () => {
  for (const status of ["suspended", "closed"]) {
    const w = world();
    w.db.accounts.set(TENANT, { client_id: TENANT, kind: "sub", account_sid: "AC" + "9".repeat(32), status, provision_step: "done" });
    const r = await ensure(w, { http: noHttp });
    assert(!r.ok && r.reason === status && r.status === 403, JSON.stringify(r));
    assertEquals(ensureRefusalSentence(r as Extract<typeof r, { ok: false }>), "Your phone account is paused. Contact Structure Studio.");
  }
});

Deno.test("a database that cannot be read: lookup_failed, nothing made", async () => {
  const broken = {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { code: "42P01" } }) }) }) }),
    rpc: () => { throw new Error("no rpc expected"); },
  };
  const r = await ensureTwilioAccount(broken, TENANT, { get: ON, http: noHttp });
  assert(!r.ok && r.reason === "lookup_failed" && r.code === "lookup_failed_42P01", JSON.stringify(r));
});

// ── The console ──────────────────────────────────────────────────────────────────────────────
Deno.test("the console view: masked SIDs, what exists, and the token check", async () => {
  const w = world();
  await ensure(w);
  const v = await twilioAccountView(w.db, TENANT, { get: ON, http: w.tw.http, check: true });
  const sub = String(row(w).account_sid);
  assertEquals([v.kind, v.status, v.step, v.switchOn], ["sub", "active", "done", true]);
  assertEquals(v.accountSid, `AC…${sub.slice(-4)}`);
  assert(!JSON.stringify(v).includes(sub), "the full SID never leaves");
  assert(!JSON.stringify(v).includes(w.tw.accounts.get(sub)!.auth_token), "nor a secret");
  assertEquals([v.push, v.sink, v.subscription], [{ apns_dev: true, apns_prod: true, fcm: true }, true, true]);
  assertEquals(v.tokenCheck, { authToken: "ok", apiKey: "ok" });
  w.tw.accounts.get(sub)!.auth_token = "rotated" + "r".repeat(25);
  assertEquals((await twilioAccountView(w.db, TENANT, { get: ON, http: w.tw.http, check: true })).tokenCheck?.authToken, "rejected");
  const none = world();
  none.db.holdings.set(TENANT, "a live number");
  const nv = await twilioAccountView(none.db, TENANT, { get: OFF, http: noHttp });
  assertEquals([nv.kind, nv.parentReason, nv.switchOn], ["none", "a live number", false]);
  assertEquals(maskSid(null), null);
});

Deno.test("suspend, reactivate and close: with the parent's token; close refused while the sub has a number", async () => {
  const w = world();
  await ensure(w);
  const sub = String(row(w).account_sid);
  const s = await setTwilioAccountStatus(w.db, TENANT, "suspended", { get: ON, http: w.tw.http });
  assertEquals(s, { ok: true, status: "suspended", already: false });
  assertEquals([w.tw.accounts.get(sub)!.status, row(w).status], ["suspended", "suspended"]);
  assert(!(await ensure(w, { http: noHttp })).ok, "a suspended sub provisions nothing and buys nothing");
  assertEquals(await setTwilioAccountStatus(w.db, TENANT, "active", { get: ON, http: w.tw.http }), { ok: true, status: "active", already: false });
  // Close: a number in our rows refuses it ...
  w.db.numbers.push({ client_id: TENANT, released_at: null });
  const byRow = await setTwilioAccountStatus(w.db, TENANT, "closed", { get: ON, http: w.tw.http });
  assert(!byRow.ok && byRow.reason === "has_numbers" && byRow.numbers === 1, JSON.stringify(byRow));
  w.db.numbers[0].released_at = "2026-10-09T00:00:00Z";
  // ... and so does one only Twilio knows about.
  w.tw.numbers.set(sub, ["+15555550100"]);
  const byTwilio = await setTwilioAccountStatus(w.db, TENANT, "closed", { get: ON, http: w.tw.http });
  assert(!byTwilio.ok && byTwilio.reason === "has_numbers", JSON.stringify(byTwilio));
  assertEquals(w.tw.accounts.get(sub)!.status, "active", "nothing was closed");
  w.tw.numbers.set(sub, []);
  assertEquals(await setTwilioAccountStatus(w.db, TENANT, "closed", { get: ON, http: w.tw.http }), { ok: true, status: "closed", already: false });
  assertEquals([w.tw.accounts.get(sub)!.status, row(w).status], ["closed", "closed"]);
  const again = await setTwilioAccountStatus(w.db, TENANT, "active", { get: ON, http: w.tw.http });
  assert(!again.ok && again.code === "closed", "closed is final");
  // The parent's token is required for all of it.
  const w2 = world();
  await ensure(w2);
  const noTok = await setTwilioAccountStatus(w2.db, TENANT, "suspended", { get: envOf({ TWILIO_AUTH_TOKEN: undefined }), http: noHttp });
  assert(!noTok.ok && noTok.code === "parent_token_missing", JSON.stringify(noTok));
  // No sub at all.
  const w3 = world();
  assertEquals((await setTwilioAccountStatus(w3.db, TENANT, "closed", { get: ON, http: noHttp })).ok, false);
});

Deno.test("a refill that fails leaves the working sub active and 'done' (only the error is recorded)", async () => {
  const w = world();
  w.db.material.fcm = { kind: "fcm", certificate: null, private_key: null, secret: null };
  await ensure(w);
  assertEquals(row(w).push_skipped, ["fcm"]);
  w.db.material.fcm.secret = '{"type":"service_account"}';
  w.tw.down.set("create_cred", 1);
  const r = await ensure(w, { operator: true });
  assert(!r.ok && r.step === "push", JSON.stringify(r));
  assertEquals([row(w).status, row(w).provision_step, row(w).last_error], ["active", "done", "push:unreachable"]);
  // Builders keep the fast path meanwhile.
  assert((await ensure(w, { http: noHttp })).ok);
  // And the next Create finishes it, the step still 'done' throughout.
  assert((await ensure(w, { operator: true })).ok);
  assertEquals([row(w).status, row(w).provision_step, row(w).push_skipped], ["active", "done", null]);
});

Deno.test("suspend only an active sub; reactivate only a suspended one", async () => {
  const w = world();
  w.tw.inherit = false;
  await ensure(w);
  assertEquals(row(w).status, "failed");
  const s = await setTwilioAccountStatus(w.db, TENANT, "suspended", { get: ON, http: w.tw.http });
  assert(!s.ok && s.reason === "wrong_state" && s.code === "failed", JSON.stringify(s));
  const a = await setTwilioAccountStatus(w.db, TENANT, "active", { get: ON, http: w.tw.http });
  assert(!a.ok && a.reason === "wrong_state", JSON.stringify(a));
});

// ── Review fixes ─────────────────────────────────────────────────────────────────────────────
const MANUAL = envOf({ TWILIO_SUBACCOUNTS: "manual" });

Deno.test("the switch's three modes: off is today, manual uses existing subs, on also makes them", () => {
  for (const v of [undefined, "", "off", "ON", "Manual", " on", "true"]) {
    const g = envOf({ TWILIO_SUBACCOUNTS: v });
    assertEquals([subaccountsMode(g), subaccountsOn(g), provisioningOn(g)], ["off", false, false], `"${v}"`);
  }
  assertEquals([subaccountsMode(MANUAL), subaccountsOn(MANUAL), provisioningOn(MANUAL)], ["manual", true, false]);
  assertEquals([subaccountsMode(ON), subaccountsOn(ON), provisioningOn(ON)], ["on", true, true]);
});

Deno.test("manual: nothing is made for a builder without an account (refused, Twilio never asked); one on the parent by decision stays there", async () => {
  const w = world();
  const r = await ensure(w, { get: MANUAL, http: noHttp });
  assert(!r.ok && r.reason === "manual" && r.code === "not_made" && r.status === 409, JSON.stringify(r));
  assert(!w.db.accounts.has(TENANT), "no row was made");
  assertEquals(ensureRefusalSentence(r as Extract<typeof r, { ok: false }>), "Your phone account isn't set up yet. Structure Studio will set it up for you.");
  const internal = world();
  internal.db.settings.set(TENANT, { client_id: TENANT, internal_account: true });
  assertEquals(await ensure(internal, { get: MANUAL, http: noHttp }), { ok: true, kind: "parent", reason: "internal" });
  const holds = world();
  holds.db.holdings.set(TENANT, "a live number");
  assertEquals(await ensure(holds, { get: MANUAL, http: noHttp }), { ok: true, kind: "parent", reason: "parent_holdings" });
});

Deno.test("manual: a sub the operator made is used (the fast path); an unfinished one is not finished here; the operator's Create still runs", async () => {
  const w = world();
  const made = await ensure(w, { get: MANUAL, operator: true });
  assert(made.ok && made.kind === "sub", JSON.stringify(made));
  const r = await ensure(w, { get: MANUAL, http: noHttp });
  assert(r.ok && r.kind === "sub" && !r.ran, JSON.stringify(r));
  const half = world();
  half.tw.inherit = false;
  await ensure(half, { get: MANUAL, operator: true });
  assertEquals(row(half).status, "failed");
  const u = await ensure(half, { get: MANUAL, http: noHttp });
  assert(!u.ok && u.reason === "manual" && u.code === "unfinished", JSON.stringify(u));
});

Deno.test("every write pushes the lock forward: a slow run is never taken over while it is still making progress", async () => {
  const w = world();
  let t = Date.parse("2026-10-09T12:00:00Z");
  const now = () => t;
  let second: unknown = null;
  const real = w.tw.http;
  w.tw.http = async (m, u, a, f) => {
    t += 90_000; // every Twilio request takes 90 seconds: the run outlives its first lock many times over
    if (u.startsWith("https://events.twilio.com/v1/Subscriptions") && m === "POST") {
      second = await ensureTwilioAccount(w.db, TENANT, { get: ON, http: noHttp, now });
    }
    return await real(m, u, a, f);
  };
  const r = await ensure(w, { now });
  assert(r.ok && r.kind === "sub", JSON.stringify(r));
  assert(second && !(second as { ok: boolean }).ok && (second as { reason: string }).reason === "busy", `a second caller mid-run: ${JSON.stringify(second)}`);
  assertComplete(w);
});

Deno.test("each Twilio request is given up after PROVISION_HTTP_TIMEOUT_MS (fetchHttp passes an abort signal)", async () => {
  const realFetch = globalThis.fetch;
  let signal: AbortSignal | null | undefined;
  globalThis.fetch = ((_u: string, init?: RequestInit) => {
    signal = init?.signal;
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof fetch;
  try {
    await fetchHttp("GET", "https://api.twilio.com/2010-04-01/Accounts.json", { user: "u", pass: "p" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert(signal instanceof AbortSignal, "a timeout signal is passed");
});

Deno.test("an auth token rotated in Twilio: the builder's fast path is untouched; the operator's re-check reads it again and stores it", async () => {
  const w = world();
  await ensure(w);
  const sub = String(row(w).account_sid);
  w.tw.accounts.get(sub)!.auth_token = "rotatedtoken" + "r".repeat(20);
  assert((await ensure(w, { http: noHttp })).ok, "builders keep the fast path");
  const created = w.tw.calls.filter((c) => c.op.startsWith("create_")).length;
  const r = await ensure(w, { operator: true });
  assert(r.ok && r.kind === "sub" && r.ran, JSON.stringify(r));
  assertEquals(w.db.vault.get(`twilio_auth_token_${sub}`), "rotatedtoken" + "r".repeat(20), "Vault holds the new token");
  assertEquals(w.tw.calls.filter((c) => c.op.startsWith("create_")).length, created, "nothing was made");
  assertEquals([row(w).status, row(w).provision_step, row(w).last_error, row(w).provision_lock_until], ["active", "done", null, null]);
  assertEquals((await twilioAccountView(w.db, TENANT, { get: ON, http: w.tw.http, check: true })).tokenCheck, { authToken: "ok", apiKey: "ok" });
});

Deno.test("the operator's re-check of an active sub sets the app's URLs again and makes nothing", async () => {
  const w = world();
  await ensure(w);
  const before = w.tw.calls.length;
  const r = await ensure(w, { operator: true, get: envOf({ TWILIO_SUB_APP_FALLBACK_URL: "https://static.example.test/twiml/v2.xml" }) });
  assert(r.ok && r.kind === "sub" && r.ran, JSON.stringify(r));
  const after = w.tw.calls.slice(before);
  assertEquals(after.filter((c) => c.op.startsWith("create_") || c.op === "delete_key").length, 0, "nothing made or deleted");
  assertEquals(after.filter((c) => c.op === "update_app").length, 1);
  assertEquals([...w.tw.apps.values()][0].form.VoiceFallbackUrl, "https://static.example.test/twiml/v2.xml");
  assertComplete(w, "re-check");
});

Deno.test("a Suspend while the operator's re-check is running: the run stops at its next write and the sub stays suspended", async () => {
  const w = world();
  w.db.material.fcm = { kind: "fcm", certificate: null, private_key: null, secret: null };
  await ensure(w);
  w.db.material.fcm.secret = '{"type":"service_account"}';
  const real = w.tw.http;
  let suspended: unknown = null;
  w.tw.http = async (m, u, a, f) => {
    const out = await real(m, u, a, f);
    if (!suspended && u.startsWith("https://chat.twilio.com/v2/Credentials") && m === "POST") {
      suspended = await setTwilioAccountStatus(w.db, TENANT, "suspended", { get: ON, http: real });
    }
    return out;
  };
  const r = await ensure(w, { operator: true });
  assertEquals(suspended, { ok: true, status: "suspended", already: false });
  assert(!r.ok && r.reason === "busy" && r.code === "lock_lost", JSON.stringify(r));
  assertEquals([row(w).status, row(w).provision_lock_until], ["suspended", null], "the operator's Suspend stands");
});

Deno.test("the console's token check never asks a Standard key for the Accounts resource (Twilio refuses it: 20003)", async () => {
  const w = world();
  await ensure(w);
  const before = w.tw.calls.length;
  const v = await twilioAccountView(w.db, TENANT, { get: ON, http: w.tw.http, check: true });
  assertEquals(v.tokenCheck, { authToken: "ok", apiKey: "ok" });
  const key = String(row(w).api_key_sid);
  const keyCalls = w.tw.calls.slice(before).filter((c) => c.auth.user === key);
  assertEquals(keyCalls.map((c) => c.op), ["list_apps"], "the key is asked for something under the account");
  // And a key Twilio no longer knows reads "rejected".
  w.tw.keys.delete(key);
  assertEquals((await twilioAccountView(w.db, TENANT, { get: ON, http: w.tw.http, check: true })).tokenCheck?.apiKey, "rejected");
});

Deno.test("the console view on a database without 292: not installed, no error", async () => {
  const w = world();
  w.db.missingTable = true;
  const v = await twilioAccountView(w.db, TENANT, { get: OFF, http: noHttp, check: true });
  assertEquals([v.installed, v.kind, v.switchMode, v.tokenCheck], [false, "none", "off", undefined]);
});

// ── delete_client's close plan (review M1, finding 6) ────────────────────────────────────────
Deno.test("close plan: nothing to close for no row, a pin, a closed sub, or no table; the planned SID once it holds no number", async () => {
  const none = world();
  assertEquals(await twilioClosePlan(none.db, TENANT, { get: ON, http: noHttp }), { ok: true, row: null, closeSid: null, orphan: false });
  none.db.missingTable = true;
  assertEquals(await twilioClosePlan(none.db, TENANT, { get: ON, http: noHttp }), { ok: true, row: null, closeSid: null, orphan: false });
  const pin = world();
  pin.db.accounts.set(TENANT, { client_id: TENANT, kind: "parent", status: "active", account_sid: null });
  const p = await twilioClosePlan(pin.db, TENANT, { get: ON, http: noHttp });
  assert(p.ok && p.closeSid === null && p.row?.kind === "parent", JSON.stringify(p));
  const w = world();
  await ensure(w);
  const sub = String(row(w).account_sid);
  w.tw.numbers.set(sub, ["+15555550100"]);
  const held = await twilioClosePlan(w.db, TENANT, { get: ON, http: w.tw.http });
  assert(!held.ok && held.reason === "has_numbers", JSON.stringify(held));
  assertEquals(w.tw.accounts.get(sub)!.status, "active", "the plan only reads");
  w.tw.numbers.set(sub, []);
  const plan = await twilioClosePlan(w.db, TENANT, { get: ON, http: w.tw.http });
  assert(plan.ok && plan.closeSid === sub && !plan.orphan, JSON.stringify(plan));
  assertEquals(w.tw.accounts.get(sub)!.status, "active", "still only read");
  if (plan.ok) assertEquals(await closePlannedSub(w.db, TENANT, plan, { get: ON, http: w.tw.http }), { ok: true, status: "closed", already: false });
  assertEquals([w.tw.accounts.get(sub)!.status, row(w).status], ["closed", "closed"]);
  assertEquals(await forgetTwilioAccount(w.db, TENANT, plan.ok ? plan.row : null), { ok: true, outcome: "closed_sub" });
});

Deno.test("close plan: a sub whose create answer was lost is found by its name and closed; two are refused; no parent token is refused", async () => {
  const w = world();
  w.tw.lose.set("create_account", 1);
  await ensure(w);
  assertEquals(row(w).account_sid, null, "the row never saw the SID");
  const orphanSid = [...w.tw.accounts.values()][0].sid;
  const plan = await twilioClosePlan(w.db, TENANT, { get: ON, http: w.tw.http });
  assert(plan.ok && plan.closeSid === orphanSid && plan.orphan, JSON.stringify(plan));
  if (plan.ok) assertEquals((await closePlannedSub(w.db, TENANT, plan, { get: ON, http: w.tw.http })).ok, true);
  assertEquals(w.tw.accounts.get(orphanSid)!.status, "closed", "the orphan is closed at Twilio");
  assertEquals(await forgetTwilioAccount(w.db, TENANT, plan.ok ? plan.row : null), { ok: true, outcome: "never_created" });
  // Two open accounts by that name: an operator looks first.
  const two = world();
  two.tw.lose.set("create_account", 1);
  await ensure(two);
  two.tw.accounts.set("AC" + "8".repeat(32), { sid: "AC" + "8".repeat(32), friendly_name: TENANT, status: "active", auth_token: "x".repeat(32) });
  const dup = await twilioClosePlan(two.db, TENANT, { get: ON, http: two.tw.http });
  assert(!dup.ok && dup.reason === "duplicate", JSON.stringify(dup));
  const noTok = await twilioClosePlan(two.db, TENANT, { get: envOf({ TWILIO_AUTH_TOKEN: undefined }), http: noHttp });
  assert(!noTok.ok && noTok.code === "parent_token_missing", JSON.stringify(noTok));
});

Deno.test("forget on a database without 295: a pin or a never-made sub is deleted directly; a closed sub with secrets is refused", async () => {
  const w = world();
  w.db.missingForget = true;
  w.db.accounts.set(TENANT, { client_id: TENANT, kind: "parent", status: "active", account_sid: null });
  assertEquals(await forgetTwilioAccount(w.db, TENANT, { kind: "parent", account_sid: null }), { ok: true, outcome: "parent_pin" });
  assert(!w.db.accounts.has(TENANT));
  w.db.accounts.set(TENANT, { client_id: TENANT, kind: "sub", status: "failed", account_sid: null });
  assertEquals(await forgetTwilioAccount(w.db, TENANT, { kind: "sub", account_sid: null }), { ok: true, outcome: "never_created" });
  w.db.accounts.set(TENANT, { client_id: TENANT, kind: "sub", status: "closed", account_sid: "AC" + "9".repeat(32) });
  assertEquals(await forgetTwilioAccount(w.db, TENANT, { kind: "sub", account_sid: "AC" + "9".repeat(32) }), { ok: false, code: "PGRST202" });
  assert(w.db.accounts.has(TENANT), "kept: only 295's definer can remove its secrets");
});

// ── One tenant, one account while the switch is off (review H1) ──────────────────────────────
Deno.test("subAccountWhileOff: on or manual, no read; off, a sub row says 'sub', no row or no table 'no', an error 'lookup_failed'", async () => {
  assertEquals(await subAccountWhileOff(untouchable, TENANT, ON), "no");
  assertEquals(await subAccountWhileOff(untouchable, TENANT, MANUAL), "no");
  const w = world();
  assertEquals(await subAccountWhileOff(w.db, TENANT, OFF), "no");
  await ensure(w, { get: OFF, operator: true });
  assertEquals(await subAccountWhileOff(w.db, TENANT, OFF), "sub");
  w.db.accounts.set(TENANT, { client_id: TENANT, kind: "parent", status: "active" });
  assertEquals(await subAccountWhileOff(w.db, TENANT, OFF), "no");
  w.db.missingTable = true;
  assertEquals(await subAccountWhileOff(w.db, TENANT, OFF), "no");
  const broken = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { code: "57014" } }) }) }) }) };
  assertEquals(await subAccountWhileOff(broken, TENANT, OFF), "lookup_failed");
});

Deno.test("a rotated auth token when the key has to be made again: refreshed at the auth-token step, so the key step is not refused", async () => {
  const w = world();
  await ensure(w);
  const sub = String(row(w).account_sid);
  w.tw.accounts.get(sub)!.auth_token = "rotatedtoken" + "q".repeat(20);
  w.db.vault.delete(`twilio_api_secret_${sub}`);
  const r = await ensure(w, { operator: true });
  assert(r.ok && r.kind === "sub" && r.ran, JSON.stringify(r));
  assertEquals(w.tw.count("create_key"), 2, "the key whose secret was lost is replaced");
  assertComplete(w, "rotated + key");
});
