// customer-auth's send slots on a refused text, driven through the SHIPPED request handler.
//
// Why this test exists. request_code claims three send slots (the phone, the caller's IP and
// the tenant) before it asks Twilio for a code. What happens to them when Twilio refuses is the
// whole of the cap, and two of the three buckets (IP and tenant) are SHARED with the email login
// route, which refuses when either is full and locks the IP bucket for 15 minutes:
//
//  * number (60200 bad number, 60205 landline) and locked (60203, 60202): Twilio sent nothing,
//    so all three slots go back.
//  * config (60204, 20404, 21608): Twilio refuses every text for the tenant until an
//    operator fixes the setup. ONLY THE PHONE SLOT is kept. Giving all three back left nothing
//    capping repeat requests; keeping all three (the version before this one) meant twenty
//    refused texts from one venue Wi-Fi locked EMAIL login for that IP, and sixty closed email
//    for the whole tenant, while the 503 sends those same shoppers to email.
//  * transient (429, 5xx, network): all three are kept, since a text may have gone out.
//  * Twilio not configured after the claim: all three go back.
//  * the builder's own Verify service (migration 323): the code goes out on it with the sub's key;
//    when it refuses as unusable the same request goes once to the parent's service (one text,
//    each slot charged once); a transient refusal is never resent; the check asks the parent's
//    service once more when the builder's says expired; a moved name renames the service in the
//    background without holding up the code. Nothing ever carries CustomFriendlyName.
//
// It also pins the log volume of a config refusal: at most one app_errors row per isolate per
// Twilio code, and no per-request info row from withErrorLog, because only the per-number cap
// bounds those requests now.
//
// Run (from supabase/functions/):
//   deno test --quiet --allow-env --node-modules-dir=none \
//     --import-map=_shared/_test_stubs/import_map.json \
//     _shared/_test_stubs/customerAuthSlots_test.ts
//
// Same loading trick as postmarkEvents_test.ts: index.ts ends in Deno.serve(...), so serve is
// stubbed first and the module is imported dynamically, which hands us the real handler. The
// import map swaps supabase-js for supabase_stub.ts, whose stubDb hook routes every
// createClient(...).from(...) (the handler's and logEdgeError's) into the fake below. fetch is
// stubbed for Twilio Verify and Resend and nothing else, and no --allow-net is granted, so no
// text or email can leave the box.

// deno-lint-ignore-file no-explicit-any
import { stubDb, stubRpc } from "./supabase_stub.ts";
import { _resetTwilioAccountCaches } from "../twilioAccount.ts";
import { EMAIL_OTP_MAX_ATTEMPTS, hashEmailOtp } from "../emailOtp.ts";

function assertEquals<T>(actual: T, expected: T, msg = ""): void {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`Expected ${e}, got ${a}${msg ? ` — ${msg}` : ""}`);
}
function assert(v: unknown, msg = ""): void {
  if (!v) throw new Error(`Assertion failed${msg ? ` — ${msg}` : ""}`);
}

const realServe = Deno.serve;
let handler: ((req: Request) => Promise<Response>) | null = null;
(Deno as any).serve = (h: (req: Request) => Promise<Response>) => {
  handler = h;
  return { finished: Promise.resolve() };
};
const customerAuth = await import("../../customer-auth/index.ts");
(Deno as any).serve = realServe;

// ── In-memory database ─────────────────────────────────────────────────────────────────────
// Just the calls request_code makes on both channels: select · insert · update(...).select ·
// upsert · delete · .eq/.lt/.is · .maybeSingle · await. customer_otp_throttle is keyed on
// `bucket`, so a second insert of the same bucket fails with 23505 the way Postgres answers the
// claim race.

type Row = Record<string, unknown>;

class FakeDb {
  tables: Record<string, Row[]> = {
    client_configs: [{ client_id: TENANT, company_name: "Example Builder" }],
    client_settings: [{ client_id: TENANT, business_name: "Example Barns" }],
    customer_otp_throttle: [],
    customer_email_otps: [],
    app_errors: [],
  };
  /** Called with the table name on every from(); lets a test act between two steps. */
  onFrom: ((table: string) => void) | null = null;
  from = (table: string) => {
    this.onFrom?.(table);
    return new Query(this, table);
  };
  sendCount(bucket: string): number {
    return Number(this.tables.customer_otp_throttle.find((r) => r.bucket === bucket)?.send_count ?? 0);
  }
  lockedUntil(bucket: string): unknown {
    return this.tables.customer_otp_throttle.find((r) => r.bucket === bucket)?.locked_until ?? null;
  }
}

class Query {
  private op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
  private payload: Row | null = null;
  private returning = false;
  private filters: ((r: Row) => boolean)[] = [];
  constructor(private db: FakeDb, private table: string) {}

  select(_cols?: string) {
    if (this.op === "update") this.returning = true;
    else this.op = "select";
    return this;
  }
  insert(row: Row) { this.op = "insert"; this.payload = row; return this; }
  update(patch: Row) { this.op = "update"; this.payload = patch; return this; }
  upsert(row: Row, _opts?: unknown) { this.op = "upsert"; this.payload = row; return this; }
  delete() { this.op = "delete"; return this; }
  eq(col: string, val: unknown) { this.filters.push((r) => r[col] === val); return this; }
  // Only the provisioning lock's shape (twilioVerifyService.ts's sync takes it).
  or(expr: string) {
    const m = /^provision_lock_until\.is\.null,provision_lock_until\.lt\.(.+)$/.exec(expr);
    if (!m) throw new Error(`FakeDb: unexpected or(${expr})`);
    this.filters.push((r) => r.provision_lock_until == null || String(r.provision_lock_until) < m[1]);
    return this;
  }
  lt(col: string, val: string) { this.filters.push((r) => String(r[col]) < val); return this; }
  is(col: string, val: null) { this.filters.push((r) => (r[col] ?? null) === val); return this; }
  maybeSingle() {
    return this.run().then((res) => ({ data: (res.data as Row[] | null)?.[0] ?? null, error: res.error }));
  }
  then<T>(ok: (v: { data: unknown; error: Row | null }) => T, bad?: (e: unknown) => T) {
    return this.run().then(ok, bad);
  }

  /** The row an upsert replaces: the primary key of the two tables that are upserted. */
  private sameKey(r: Row): boolean {
    const p = this.payload!;
    if (this.table === "customer_email_otps") return r.client_id === p.client_id && r.email_lower === p.email_lower;
    return r.bucket === p.bucket;
  }

  private run(): Promise<{ data: unknown; error: Row | null }> {
    const rows = this.db.tables[this.table];
    if (!rows) throw new Error(`FakeDb: request_code is not expected to touch ${this.table}`);
    const match = (r: Row) => this.filters.every((f) => f(r));
    const keyed = this.table === "customer_otp_throttle";
    let out: { data: unknown; error: Row | null } = { data: null, error: null };
    if (this.op === "select") {
      out = { data: rows.filter(match).map((r) => ({ ...r })), error: null };
    } else if (this.op === "insert") {
      if (keyed && rows.some((r) => r.bucket === this.payload!.bucket)) {
        out = { data: null, error: { code: "23505", message: "duplicate key" } };
      } else {
        rows.push({ ...this.payload });
      }
    } else if (this.op === "update") {
      const hit = rows.filter(match);
      for (const r of hit) Object.assign(r, this.payload);
      out = { data: this.returning ? hit.map((r) => ({ ...r })) : null, error: null };
    } else if (this.op === "delete") {
      this.db.tables[this.table] = rows.filter((r) => !match(r));
    } else {
      const i = rows.findIndex((r) => this.sameKey(r));
      if (i >= 0) rows[i] = { ...this.payload };
      else rows.push({ ...this.payload });
    }
    return Promise.resolve(out);
  }
}

// ── Twilio, Resend, the environment and one request ────────────────────────────────────────
// Clearly-fake values (this repo is PUBLIC). The TWILIO_VERIFY_* names win over the platform
// ones in twilioVerify.ts, so a developer's real TWILIO_* env can never be the pair in use.

const TENANT = "example-builder";
const IP = "203.0.113.7"; // TEST-NET-3
const EMAIL = "shopper@example.com";
const TENANT_KEY = `sends:tenant:${TENANT}`;
const ipKey = (ip: string) => `ip:${TENANT}:${ip}`;
/** A distinct valid US number per index, all in Twilio's 500-555 magic range. */
const phone = (i: number) => `(500) 555-${String(i).padStart(4, "0")}`;
const phoneKey = (i: number) => `${TENANT}:500555${String(i).padStart(4, "0")}`;

const ENV: Record<string, string> = {
  SUPABASE_URL: "http://supabase.stub.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "stub-service-role-key",
  TWILIO_VERIFY_API_KEY: "SKtestapikeysid",
  TWILIO_VERIFY_API_SECRET: "test-api-secret",
  TWILIO_VERIFY_SERVICE_SID: "VAtestservicesid",
  RESEND_API_KEY: "re_test_stub_key",
  PLATFORM_EMAIL_DOMAIN_READY: "true",
};

function twilioRefusal(code: number, status: number): Response {
  return new Response(JSON.stringify({ code, message: "refused", status }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const twilioSent = () =>
  new Response(JSON.stringify({ sid: "VEteststubsid", status: "pending" }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });

/** One code request to Twilio Verify (a start or a check): which service, with whose key. */
type TwilioCall = { branded: boolean; service: string; endpoint: string; user: string };
/** Any other Verify request (the background sync reading or naming a service). */
type AdminCall = { method: string; url: string; user: string; form: Record<string, string> };
type Stubs = {
  db: FakeDb; twilio: TwilioCall[]; resend: number[]; admin: AdminCall[];
  /** Answers the AdminCalls; by default Twilio is down for them (500). */
  adminAnswer: (c: AdminCall) => Response;
  /** twilio_account_creds' row for the tenant (the sub's credentials), or null for none. */
  creds: Row | null;
};

const userOf = (init?: RequestInit) => {
  const h = new Headers(init?.headers ?? {}).get("Authorization") ?? "";
  try { return atob(h.replace(/^Basic /, "")).split(":")[0]; } catch { return ""; }
};

/** Install a fresh database, the env, and fakes for Twilio (answering code request n with
 *  `answer(n, call)`, 1-based) and Resend (always accepts). Module state the handler keeps between
 *  requests (the config faults already logged, the builder fallbacks and syncs tried) is reset
 *  first, so every test starts from a fresh isolate whatever ran before it. */
async function withStubs(
  answer: (n: number, call: TwilioCall) => Response | Promise<Response>,
  body: (s: Stubs) => Promise<void>,
  env: Record<string, string> = {},
): Promise<void> {
  customerAuth._resetConfigFaultLoggedForTests();
  customerAuth._takeBackgroundWorkForTests();
  _resetTwilioAccountCaches();
  const s: Stubs = { db: new FakeDb(), twilio: [], resend: [], admin: [], adminAnswer: () => new Response("down", { status: 500 }), creds: null };
  const realFetch = globalThis.fetch;
  const allEnv = { ...ENV, ...env };
  const savedEnv = Object.fromEntries([...Object.keys(allEnv), "TWILIO_SUBACCOUNTS"].map((k) => [k, Deno.env.get(k)]));
  stubDb.from = s.db.from;
  stubRpc.rpc = (fn: string, args: any) => {
    if (fn !== "twilio_account_creds") throw new Error(`unexpected rpc ${fn}`);
    return Promise.resolve({ data: s.creds && s.creds.client_id === args?.p_client_id ? [{ ...s.creds }] : [], error: null });
  };
  Deno.env.delete("TWILIO_SUBACCOUNTS");
  for (const [k, v] of Object.entries(allEnv)) Deno.env.set(k, v);
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const code = /^https:\/\/verify\.twilio\.com\/v2\/Services\/([^/]+)\/(Verifications|VerificationCheck)$/.exec(url);
    if (code) {
      const form = new URLSearchParams(String(init?.body ?? ""));
      const call = { branded: form.has("CustomFriendlyName"), service: code[1], endpoint: code[2], user: userOf(init) };
      s.twilio.push(call);
      try {
        return Promise.resolve(answer(s.twilio.length, call));
      } catch (e) {
        return Promise.reject(e);
      }
    }
    if (url.startsWith("https://verify.twilio.com/v2/Services")) {
      const call = {
        method: String(init?.method ?? "GET"), url, user: userOf(init),
        form: Object.fromEntries(new URLSearchParams(String(init?.body ?? ""))),
      };
      s.admin.push(call);
      return Promise.resolve(s.adminAnswer(call));
    }
    if (url === "https://api.resend.com/emails") {
      s.resend.push(1);
      return Promise.resolve(new Response(JSON.stringify({ id: "stub-email-id" }), { status: 200 }));
    }
    throw new Error(`unexpected fetch outside Twilio Verify and Resend: ${url}`);
  }) as typeof fetch;
  try {
    await body(s);
    await Promise.all(customerAuth._takeBackgroundWorkForTests());
  } finally {
    globalThis.fetch = realFetch;
    stubDb.from = null;
    stubRpc.rpc = null;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

async function post(payload: Record<string, unknown>, ip = IP): Promise<{ status: number; body: any }> {
  const res = await handler!(new Request("http://localhost/functions/v1/customer-auth", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(payload),
  }));
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

const textMeACode = (i = 6, ip = IP) => post({ action: "request_code", clientId: TENANT, phone: phone(i) }, ip);
const emailMeACode = (ip = IP) =>
  post({ action: "request_code", channel: "email", clientId: TENANT, email: EMAIL }, ip);

/** [phone, IP, tenant] send counts for phone index `i` from `ip`. */
const slots = (db: FakeDb, i = 6, ip = IP) => [db.sendCount(phoneKey(i)), db.sendCount(ipKey(ip)), db.sendCount(TENANT_KEY)];

// ── The tests ──────────────────────────────────────────────────────────────────────────────

Deno.test("module registered exactly one handler through Deno.serve", () => {
  assertEquals(typeof handler, "function");
});

// config ─────────────────────────────────────────────────────────────────────────────────────

Deno.test("config 60204: phone slot kept, IP and tenant slots back to 0, and nothing is resent", async () => {
  await withStubs(() => twilioRefusal(60204, 403), async ({ db, twilio }) => {
    const res = await textMeACode();
    assertEquals(res.status, 503, "config refusal answers not-available");
    assertEquals(slots(db), [1, 0, 0], "phone kept; IP and tenant released");
    assertEquals(twilio.map((c) => c.branded), [false], "one plain send, no brand, no resend");
  });
});

Deno.test("config 20404 and 21608: phone slot kept, IP and tenant slots back to 0", async () => {
  for (const [code, status] of [[20404, 404], [21608, 403]]) {
    await withStubs(() => twilioRefusal(code, status), async ({ db, twilio }) => {
      const res = await textMeACode();
      assertEquals(res.status, 503, `${status}/${code}`);
      assertEquals(slots(db), [1, 0, 0], `${status}/${code}: phone kept; IP and tenant released`);
      assertEquals(twilio.length, 1, `${status}/${code}: sent once, never resent`);
    });
  }
});

Deno.test("config: the kept phone slot is the cap, so a fourth tap on one number is refused before Twilio", async () => {
  await withStubs(() => twilioRefusal(60204, 403), async ({ db, twilio }) => {
    for (let n = 1; n <= 3; n++) assertEquals((await textMeACode()).status, 503, `tap ${n}`);
    assertEquals(slots(db), [3, 0, 0]);
    assertEquals(twilio.length, 3);

    assertEquals((await textMeACode()).status, 429, "the per-phone cap (3) binds");
    assertEquals(twilio.length, 3, "the capped request never reached Twilio");
    assertEquals(db.lockedUntil(ipKey(IP)), null, "the IP bucket is not locked");
  });
});

Deno.test("20 refused texts from one venue IP leave a following email request_code NOT throttled", async () => {
  await withStubs(() => twilioRefusal(60204, 403), async ({ db, resend }) => {
    for (let i = 0; i < 20; i++) assertEquals((await textMeACode(100 + i)).status, 503, `shopper ${i + 1}`);
    assertEquals(db.sendCount(ipKey(IP)), 0, "no IP slot spent by a refused text");
    assertEquals(db.sendCount(TENANT_KEY), 0, "no tenant slot spent by a refused text");

    const email = await emailMeACode();
    assertEquals(email.status, 200, "email login still works from the same IP");
    assertEquals(email.body, { ok: true });
    assertEquals(resend.length, 1, "the email code went to the (stubbed) provider");
    assertEquals(db.lockedUntil(ipKey(IP)), null, "the shared IP bucket was never locked");
  });
});

Deno.test("60 refused texts across the tenant leave email request_code NOT throttled tenant-wide", async () => {
  await withStubs(() => twilioRefusal(21608, 403), async ({ db, resend }) => {
    for (let i = 0; i < 60; i++) {
      assertEquals((await textMeACode(200 + i, `198.51.100.${i}`)).status, 503, `shopper ${i + 1}`);
    }
    assertEquals(db.sendCount(TENANT_KEY), 0, "no tenant slot spent by a refused text");

    const email = await emailMeACode("192.0.2.10");
    assertEquals(email.status, 200, "email login still works for the tenant");
    assertEquals(resend.length, 1);
  });
});

Deno.test("config: one app_errors row per isolate per Twilio code, and no info row per request", async () => {
  let code = 60204;
  await withStubs(() => twilioRefusal(code, 403), async ({ db }) => {
    for (let i = 0; i < 5; i++) assertEquals((await textMeACode(300 + i)).status, 503);
    assertEquals(
      db.tables.app_errors.map((r) => [r.code, r.severity]),
      [["twilio_config", "error"]],
      "five refused requests file the fault once, and withErrorLog adds nothing",
    );

    code = 21608;
    for (let i = 5; i < 8; i++) assertEquals((await textMeACode(300 + i)).status, 503);
    assertEquals(
      db.tables.app_errors.map((r) => [r.code, (r.context as Row)?.twilioCode]),
      [["twilio_config", 60204], ["twilio_config", 21608]],
      "a different code is a different fault, filed once",
    );
  });
});

// number and locked ──────────────────────────────────────────────────────────────────────────

Deno.test("number refusals (60200, 60205) give all three slots back", async () => {
  for (const [code, status] of [[60200, 400], [60205, 403]]) {
    await withStubs(() => twilioRefusal(code, status), async ({ db }) => {
      const res = await textMeACode();
      assertEquals(res.status, 400, `${status}/${code}: "we couldn't text that number"`);
      assertEquals(slots(db), [0, 0, 0], `${status}/${code}: all released`);
    });
  }
});

Deno.test("Twilio's attempt locks (60203, 60202) give all three slots back", async () => {
  for (const code of [60203, 60202]) {
    await withStubs(() => twilioRefusal(code, 429), async ({ db }) => {
      const res = await textMeACode();
      assertEquals(res.status, 429, `${code}: "too many codes"`);
      assertEquals(slots(db), [0, 0, 0], `${code}: all released`);
    });
  }
});

// transient ──────────────────────────────────────────────────────────────────────────────────

Deno.test("transient failures (429, 500, network error) keep all three slots", async () => {
  const cases: [string, () => Response][] = [
    ["429/20429", () => twilioRefusal(20429, 429)],
    ["500", () => new Response("upstream fell over", { status: 500 })],
    ["network", () => { throw new TypeError("connection reset"); }],
  ];
  for (const [label, answer] of cases) {
    await withStubs(answer, async ({ db, twilio }) => {
      const res = await textMeACode();
      assertEquals(res.status, 502, `${label}: "try again"`);
      assertEquals(slots(db), [1, 1, 1], `${label}: all kept`);
      assertEquals(twilio.length, 1, `${label}: never resent`);
    });
  }
});

// not configured ─────────────────────────────────────────────────────────────────────────────

Deno.test("Twilio not configured after the claim gives all three slots back", async () => {
  await withStubs(() => twilioSent(), async ({ db, twilio }) => {
    // The builder-service read (twilio_accounts, switch on) sits after the configured check and
    // before the claim; losing the service SID there makes twStartVerification throw
    // TwilioNotConfigured with the slots claimed. The tenant is pinned to the parent, so the
    // parent's service is the one in use.
    db.tables.twilio_accounts = [{ client_id: TENANT, kind: "parent", status: "active" }];
    db.onFrom = (table) => {
      if (table === "twilio_accounts") Deno.env.delete("TWILIO_VERIFY_SERVICE_SID");
    };
    const res = await textMeACode();
    assertEquals(res.status, 503);
    assertEquals(slots(db), [0, 0, 0], "all released");
    assertEquals(twilio.length, 0, "nothing reached Twilio");
  }, { TWILIO_SUBACCOUNTS: "on" });
});

// the builder's own Verify service ─────────────────────────────────────────────────────────
// Fake SIDs in the right shapes (the transport and the sync check them), all zeros.

const z = (n: number) => "0".repeat(31) + String(n);
const BUILDER_SVC = "VA" + z(4);
const SUB_KEY = "SK" + z(2);
const SUB = { client_id: TENANT, kind: "sub", status: "active", account_sid: "AC" + z(1), api_key_sid: SUB_KEY, api_secret: "sub-secret", auth_token: "sub-token" };
const ON = { TWILIO_SUBACCOUNTS: "on" };

/** The tenant as an active sub whose service is `BUILDER_SVC`, named `name`. */
function asBuilder(s: Stubs, name = "Example Barns"): void {
  s.db.tables.twilio_accounts = [{
    client_id: TENANT, kind: "sub", status: "active", account_sid: SUB.account_sid,
    verify_service_sid: BUILDER_SVC, verify_service_name: name, provision_lock_until: null,
  }];
  s.creds = { ...SUB };
}

Deno.test("builder service: the code goes out on the BUILDER's service with the sub's key, once, no brand", async () => {
  await withStubs(() => twilioSent(), async (s) => {
    asBuilder(s);
    const res = await textMeACode();
    assertEquals(res.status, 200);
    assertEquals(s.twilio.map((c) => [c.service, c.endpoint, c.user, c.branded]), [[BUILDER_SVC, "Verifications", SUB_KEY, false]]);
    assertEquals(slots(s.db), [1, 1, 1]);
    assertEquals(s.admin, [], "the name matches: no sync");
    assertEquals(s.db.tables.app_errors, []);
  }, ON);
});

Deno.test("builder service: structure-studio's shape (a parent pin) and the switch off both use the parent's service", async () => {
  await withStubs(() => twilioSent(), async (s) => {
    s.db.tables.twilio_accounts = [{ client_id: TENANT, kind: "parent", status: "active" }];
    assertEquals((await textMeACode()).status, 200);
    assertEquals(s.twilio.map((c) => [c.service, c.user]), [["VAtestservicesid", "SKtestapikeysid"]]);
  }, ON);
  await withStubs(() => twilioSent(), async (s) => {
    // No twilio_accounts table at all: with the switch off it is never read.
    assertEquals((await textMeACode()).status, 200);
    assertEquals(s.twilio.map((c) => c.service), ["VAtestservicesid"]);
  });
});

Deno.test("rollback: a builder whose SID was cleared uses the parent's service, and no login makes a service again", async () => {
  await withStubs(() => twilioSent(), async (s) => {
    asBuilder(s);
    Object.assign(s.db.tables.twilio_accounts[0], { verify_service_sid: null, verify_service_name: null });
    s.db.tables.client_settings[0].business_name = "A Brand New Name";
    assertEquals((await textMeACode()).status, 200);
    assertEquals(s.twilio.map((c) => c.service), ["VAtestservicesid"]);
    assertEquals(customerAuth._takeBackgroundWorkForTests().length, 0, "no background sync");
    assertEquals(s.admin, [], "Twilio was never asked to make or name a service");
  }, ON);
});

Deno.test("builder service unusable (404/20404 deleted, 401 key revoked): resent ONCE on the parent's, one text, slots once, one warn row", async () => {
  for (const [code, status] of [[20404, 404], [20003, 401]]) {
    await withStubs((n) => n === 1 ? twilioRefusal(code, status) : twilioSent(), async (s) => {
      asBuilder(s);
      const res = await textMeACode();
      assertEquals(res.status, 200, `${status}/${code}`);
      assertEquals(s.twilio.map((c) => c.service), [BUILDER_SVC, "VAtestservicesid"], `${status}/${code}: the builder's, then the parent's`);
      assertEquals(slots(s.db), [1, 1, 1], `${status}/${code}: one text, charged once`);
      await Promise.all(customerAuth._takeBackgroundWorkForTests());
      assertEquals(
        s.db.tables.app_errors.map((r) => [r.code, r.severity]),
        [["twilio_verify_builder_fallback", "warn"], ["twilio_verify_sync_failed", "warn"]],
        `${status}/${code}: the fallback said once, and the repair (Twilio down for it here) said once`,
      );
      const again = await textMeACode(7);
      assertEquals(again.status, 200);
      assertEquals(s.db.tables.app_errors.length, 2, "the same fallback is not filed twice in an isolate");
    }, ON);
  }
});

Deno.test("builder service transient (429, 500): NOT resent on the parent's (a text may have gone), slots kept", async () => {
  for (const [code, status] of [[20429, 429], [0, 500]]) {
    await withStubs(() => code ? twilioRefusal(code, status) : new Response("down", { status }), async (s) => {
      asBuilder(s);
      const res = await textMeACode();
      assertEquals(res.status, 502);
      assertEquals(s.twilio.length, 1, `${status}: one request only`);
      assertEquals(slots(s.db), [1, 1, 1]);
    }, ON);
  }
});

Deno.test("builder service: a number refusal (60200) is not resent either, and gives the slots back", async () => {
  await withStubs(() => twilioRefusal(60200, 400), async (s) => {
    asBuilder(s);
    assertEquals((await textMeACode()).status, 400);
    assertEquals(s.twilio.length, 1);
    assertEquals(slots(s.db), [0, 0, 0]);
  }, ON);
});

const approved = () => new Response(JSON.stringify({ status: "approved" }), { status: 200, headers: { "Content-Type": "application/json" } });
const checkCode = () => post({ action: "verify_code", clientId: TENANT, phone: phone(6), code: "123456" });

Deno.test("check: on the builder's service with the sub's key; the parent's is never asked when it answers", async () => {
  await withStubs(() => approved(), async (s) => {
    asBuilder(s);
    s.db.tables.customer_sessions = [];
    const res = await checkCode();
    assertEquals(res.status, 200);
    assertEquals(s.twilio.map((c) => [c.service, c.endpoint, c.user]), [[BUILDER_SVC, "VerificationCheck", SUB_KEY]]);
  }, ON);
});

Deno.test("check: the builder's service says expired (a code started on the parent's before) → the parent's approves it", async () => {
  await withStubs((n) => n === 1 ? twilioRefusal(20404, 404) : approved(), async (s) => {
    asBuilder(s);
    s.db.tables.customer_sessions = [];
    const res = await checkCode();
    assertEquals(res.status, 200, "the customer is signed in");
    assertEquals(s.twilio.map((c) => c.service), [BUILDER_SVC, "VAtestservicesid"]);
    assertEquals(s.db.tables.customer_sessions.length, 1);
  }, ON);
});

Deno.test("check: a wrong code on the builder's service is NOT asked of the parent's, and counts as a fail", async () => {
  const pendingCheck = () => new Response(JSON.stringify({ status: "pending" }), { status: 200, headers: { "Content-Type": "application/json" } });
  await withStubs(() => pendingCheck(), async (s) => {
    asBuilder(s);
    s.db.tables.customer_otp_throttle.push({ bucket: phoneKey(6), send_count: 1, fail_count: 0, window_started_at: new Date().toISOString(), locked_until: null });
    const res = await checkCode();
    assertEquals(res.status, 401);
    assertEquals(s.twilio.length, 1);
    assertEquals(s.db.tables.customer_otp_throttle.find((r) => r.bucket === phoneKey(6))?.fail_count, 1);
  }, ON);
});

Deno.test("rename: a moved name still gets its code at once, and the service is renamed in the background", async () => {
  const parentSvc = { sid: "VAtestservicesid", friendly_name: "Structure Studio", code_length: 6, lookup_enabled: false };
  await withStubs(() => twilioSent(), async (s) => {
    asBuilder(s, "Old Name");
    s.adminAnswer = (c) => {
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
      if (c.method === "GET" && c.url.endsWith("/Services/VAtestservicesid")) return ok(parentSvc);
      if (c.method === "GET" && c.url.endsWith("/Services?PageSize=50")) {
        return ok({ services: [{ sid: BUILDER_SVC, friendly_name: "Old Name", code_length: 6, lookup_enabled: false }] });
      }
      if (c.method === "POST" && c.url.endsWith(`/Services/${BUILDER_SVC}`)) return ok({ sid: BUILDER_SVC, friendly_name: c.form.FriendlyName });
      return new Response("unexpected", { status: 599 });
    };
    const res = await textMeACode();
    assertEquals(res.status, 200, "the customer is not held up");
    assertEquals(s.twilio.map((c) => c.service), [BUILDER_SVC], "this code still goes on their service (old name)");
    await Promise.all(customerAuth._takeBackgroundWorkForTests());
    const renames = s.admin.filter((c) => c.method === "POST");
    assertEquals(renames.map((c) => [c.url.endsWith(BUILDER_SVC), c.user, c.form]), [[true, SUB_KEY, { FriendlyName: "Example Barns" }]]);
    assertEquals(s.db.tables.twilio_accounts[0].verify_service_name, "Example Barns");
    assertEquals(s.db.tables.twilio_accounts[0].provision_lock_until, null, "the lock is released");
    assertEquals(s.db.tables.app_errors, []);

    // Already tried in this isolate: a second code within the window starts no second sync.
    s.db.tables.twilio_accounts[0].verify_service_name = "Older Still";
    assertEquals((await textMeACode(7)).status, 200);
    assertEquals(customerAuth._takeBackgroundWorkForTests().length, 0);
  }, ON);
});

// email code guesses ────────────────────────────────────────────────────────────────────────
// The email channel holds its OWN code (Twilio Verify counts attempts for the SMS path; nothing
// counts them here but customer_email_otps.attempts), so that counter is the whole brute-force
// bound on a 6-digit secret: EMAIL_OTP_MAX_ATTEMPTS guesses per issued code. It used to be read
// once and written back as read+1 after the compare, so guesses sent TOGETHER all read the same
// count, all reached the compare, and together cost one attempt: ten parallel wrong guesses left
// the code alive at attempts 1, and a thousand would have too.

const CODE = "482916";

/** A live code for EMAIL, as request_code stores it. */
async function seedEmailCode(db: FakeDb, attempts = 0): Promise<void> {
  db.tables.customer_sessions = [];
  db.tables.customer_email_otps.push({
    client_id: TENANT, email_lower: EMAIL, code_hash: await hashEmailOtp(TENANT, EMAIL, CODE),
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(), attempts, consumed_at: null,
    created_at: new Date().toISOString(),
  });
}
const guess = (code: string) => post({ action: "verify_code", channel: "email", clientId: TENANT, email: EMAIL, code });
const wrong = (i: number) => String(100000 + i);

Deno.test("email codes: guesses sent together each cost an attempt, so the sixth guess never reaches the code", async () => {
  await withStubs(() => twilioSent(), async ({ db }) => {
    await seedEmailCode(db);
    // Ten wrong guesses at once, then the right code.
    const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => guess(wrong(i))));
    assertEquals(burst.map((r) => r.status), Array(10).fill(401));
    assertEquals(db.tables.customer_email_otps[0].attempts, EMAIL_OTP_MAX_ATTEMPTS, "five guesses were judged, and counted");
    const right = await guess(CODE);
    assertEquals(right.status, 401, "the code died at five guesses, however they were sent");
    assertEquals(db.tables.customer_sessions, [], "no session");
  });
});

Deno.test("email codes: the right code still signs in, once, and a dead code costs no attempt", async () => {
  await withStubs(() => twilioSent(), async ({ db }) => {
    await seedEmailCode(db, 3);
    assertEquals((await guess(wrong(1))).status, 401);
    assertEquals(db.tables.customer_email_otps[0].attempts, 4);
    const ok = await guess(CODE);
    assertEquals(ok.status, 200);
    assertEquals(typeof ok.body.token, "string");
    assertEquals(db.tables.customer_sessions.length, 1);
    assert(db.tables.customer_email_otps[0].consumed_at, "the code is burnt");
    // Consumed: refused without touching the counter.
    const before = db.tables.customer_email_otps[0].attempts;
    const again = await guess(CODE);
    assertEquals(again.status, 401);
    assertEquals(db.tables.customer_email_otps[0].attempts, before);
    assertEquals(db.tables.customer_sessions.length, 1);
  });
});
