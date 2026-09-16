// customer-auth's send slots on a refused text, driven through the SHIPPED request handler.
//
// Why this test exists. request_code claims three send slots (the phone, the caller's IP and
// the tenant) before it asks Twilio for a code. What happens to them when Twilio refuses is the
// whole of the cap, and two of the three buckets (IP and tenant) are SHARED with the email login
// route, which refuses when either is full and locks the IP bucket for 15 minutes:
//
//  * number (60200 bad number, 60205 landline) and locked (60203, 60202): Twilio sent nothing,
//    so all three slots go back.
//  * config (60204 twice, 20404, 21608): Twilio refuses every text for the tenant until an
//    operator fixes the setup. ONLY THE PHONE SLOT is kept. Giving all three back left nothing
//    capping repeat requests; keeping all three (the version before this one) meant twenty
//    refused texts from one venue Wi-Fi locked EMAIL login for that IP, and sixty closed email
//    for the whole tenant, while the 503 sends those same shoppers to email.
//  * transient (429, 5xx, network): all three are kept, since a text may have gone out.
//  * Twilio not configured after the claim: all three go back.
//  * the brand fallback (60204 on the branded send, then the unbranded resend works): one text,
//    each slot charged once.
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
import { stubDb } from "./supabase_stub.ts";
import { _resetBrandRefusedForTests } from "../twilioVerify.ts";

function assertEquals<T>(actual: T, expected: T, msg = ""): void {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`Expected ${e}, got ${a}${msg ? ` — ${msg}` : ""}`);
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

type TwilioCall = { branded: boolean };
type Stubs = { db: FakeDb; twilio: TwilioCall[]; resend: number[] };

/** Install a fresh database, the env, and fakes for Twilio (answering call n with
 *  `answer(n)`, 1-based) and Resend (always accepts). Module state the handler keeps between
 *  requests (the learned brand refusal, the config faults already logged) is reset first, so
 *  every test starts from a fresh isolate whatever ran before it. */
async function withStubs(
  answer: (n: number) => Response | Promise<Response>,
  body: (s: Stubs) => Promise<void>,
): Promise<void> {
  _resetBrandRefusedForTests();
  customerAuth._resetConfigFaultLoggedForTests();
  const s: Stubs = { db: new FakeDb(), twilio: [], resend: [] };
  const realFetch = globalThis.fetch;
  const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  stubDb.from = s.db.from;
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://verify.twilio.com/v2/Services/")) {
      const form = new URLSearchParams(String(init?.body ?? ""));
      s.twilio.push({ branded: form.has("CustomFriendlyName") });
      try {
        return Promise.resolve(answer(s.twilio.length));
      } catch (e) {
        return Promise.reject(e);
      }
    }
    if (url === "https://api.resend.com/emails") {
      s.resend.push(1);
      return Promise.resolve(new Response(JSON.stringify({ id: "stub-email-id" }), { status: 200 }));
    }
    throw new Error(`unexpected fetch outside Twilio Verify and Resend: ${url}`);
  }) as typeof fetch;
  try {
    await body(s);
  } finally {
    globalThis.fetch = realFetch;
    stubDb.from = null;
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

Deno.test("config 60204 (branded send and the unbranded resend both refused): phone slot kept, IP and tenant slots back to 0", async () => {
  await withStubs(() => twilioRefusal(60204, 403), async ({ db, twilio }) => {
    const res = await textMeACode();
    assertEquals(res.status, 503, "config refusal answers not-available");
    assertEquals(slots(db), [1, 0, 0], "phone kept; IP and tenant released");
    assertEquals(twilio.map((c) => c.branded), [true, false], "the branded send, then the one resend");
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
    assertEquals(twilio.length, 6);

    assertEquals((await textMeACode()).status, 429, "the per-phone cap (3) binds");
    assertEquals(twilio.length, 6, "the capped request never reached Twilio");
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
    // The brand read sits after the configured check and before the claim; losing the service
    // SID there makes twStartVerification throw TwilioNotConfigured with the slots claimed.
    db.onFrom = (table) => {
      if (table === "client_settings") Deno.env.delete("TWILIO_VERIFY_SERVICE_SID");
    };
    const res = await textMeACode();
    assertEquals(res.status, 503);
    assertEquals(slots(db), [0, 0, 0], "all released");
    assertEquals(twilio.length, 0, "nothing reached Twilio");
  });
});

// brand fallback ─────────────────────────────────────────────────────────────────────────────

Deno.test("brand fallback (60204, then the unbranded resend succeeds): one text, each slot charged once", async () => {
  await withStubs((n) => n === 1 ? twilioRefusal(60204, 403) : twilioSent(), async ({ db, twilio }) => {
    const res = await textMeACode();
    assertEquals(res.status, 200);
    assertEquals(res.body, { ok: true });
    assertEquals(twilio.map((c) => c.branded), [true, false], "refused branded send, then one unbranded send");
    assertEquals(slots(db), [1, 1, 1], "the resend is the same text, charged once");
    assertEquals(
      db.tables.app_errors.map((r) => [r.code, r.severity]),
      [["twilio_brand_refused", "warn"]],
    );

    // The isolate has learned: the next send goes unbranded straight away, one call, one charge.
    const next = await textMeACode(7);
    assertEquals(next.status, 200);
    assertEquals(twilio.map((c) => c.branded), [true, false, false]);
    assertEquals(slots(db, 7), [1, 2, 2]);
  });
});
