// customer-auth's send slots on a refused text, driven through the SHIPPED request handler.
//
// Why this test exists. request_code claims three send slots (the phone, the caller's IP and
// the tenant) before it asks Twilio for a code. What happens to them when Twilio refuses is
// the whole of the cap:
//
//  * A refusal about THIS number (60200 bad number, 60205 landline) sent nothing and gives the
//    slots back, so cheap failing requests cannot spend a real tenant's budget.
//  * A CONFIG refusal (60204 twice, 20404, 21608) refuses every send for the tenant until an
//    operator fixes it. Until 2026-09-17 it gave the slots back too, which left nothing capping
//    an anonymous caller: unlimited refused Twilio calls, invocations and 503 log rows. It now
//    keeps them, so the per-phone, IP and tenant caps bound it.
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
// stubbed for Twilio and nothing else, and no --allow-net is granted, so nothing leaves the box.

// deno-lint-ignore-file no-explicit-any
import { stubDb } from "./supabase_stub.ts";

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
await import("../../customer-auth/index.ts");
(Deno as any).serve = realServe;

// ── In-memory database ─────────────────────────────────────────────────────────────────────
// Just the calls the SMS request_code path makes: select · insert · update(...).select ·
// upsert · .eq · .maybeSingle · await. customer_otp_throttle is keyed on `bucket`, so a second
// insert of the same bucket fails with 23505 the way Postgres answers the claim race.

type Row = Record<string, unknown>;

class FakeDb {
  tables: Record<string, Row[]> = {
    client_configs: [{ client_id: TENANT, company_name: "Example Builder" }],
    client_settings: [{ client_id: TENANT, business_name: "Example Barns" }],
    customer_otp_throttle: [],
    app_errors: [],
  };
  from = (table: string) => new Query(this, table);
  sendCounts(): number[] {
    return this.tables.customer_otp_throttle.map((r) => Number(r.send_count));
  }
}

class Query {
  private op: "select" | "insert" | "update" | "upsert" = "select";
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
  upsert(row: Row) { this.op = "upsert"; this.payload = row; return this; }
  eq(col: string, val: unknown) { this.filters.push((r) => r[col] === val); return this; }
  maybeSingle() {
    return this.run().then((res) => ({ data: (res.data as Row[] | null)?.[0] ?? null, error: res.error }));
  }
  then<T>(ok: (v: { data: unknown; error: Row | null }) => T, bad?: (e: unknown) => T) {
    return this.run().then(ok, bad);
  }

  private run(): Promise<{ data: unknown; error: Row | null }> {
    const rows = this.db.tables[this.table];
    if (!rows) throw new Error(`FakeDb: the SMS send path is not expected to touch ${this.table}`);
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
    } else {
      const i = rows.findIndex((r) => r.bucket === this.payload!.bucket);
      if (i >= 0) rows[i] = { ...this.payload };
      else rows.push({ ...this.payload });
    }
    return Promise.resolve(out);
  }
}

// ── Twilio, the environment and one request ────────────────────────────────────────────────
// Clearly-fake values (this repo is PUBLIC). The TWILIO_VERIFY_* names win over the platform
// ones in twilioVerify.ts, so a developer's real TWILIO_* env can never be the pair in use.

const TENANT = "example-builder";
const PHONE = "(500) 555-0006"; // Twilio's own magic test number
const ENV: Record<string, string> = {
  SUPABASE_URL: "http://supabase.stub.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "stub-service-role-key",
  TWILIO_VERIFY_API_KEY: "SKtestapikeysid",
  TWILIO_VERIFY_API_SECRET: "test-api-secret",
  TWILIO_VERIFY_SERVICE_SID: "VAtestservicesid",
};

function twilioRefusal(code: number, status: number): Response {
  return new Response(JSON.stringify({ code, message: "refused", status }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Install a fresh database, the env and a Twilio that answers every send with `answer`. */
async function withStubs(
  answer: () => Response,
  body: (db: FakeDb, twilioCalls: string[]) => Promise<void>,
): Promise<void> {
  const db = new FakeDb();
  const twilioCalls: string[] = [];
  const realFetch = globalThis.fetch;
  const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  stubDb.from = db.from;
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://verify.twilio.com/v2/Services/")) {
      throw new Error(`unexpected fetch outside Twilio Verify: ${url}`);
    }
    twilioCalls.push(url);
    return Promise.resolve(answer());
  }) as typeof fetch;
  try {
    await body(db, twilioCalls);
  } finally {
    globalThis.fetch = realFetch;
    stubDb.from = null;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

async function requestCode(): Promise<Response> {
  const res = await handler!(new Request("http://localhost/functions/v1/customer-auth", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.7" },
    body: JSON.stringify({ action: "request_code", clientId: TENANT, phone: PHONE }),
  }));
  await res.body?.cancel();
  return res;
}

// ── The tests ──────────────────────────────────────────────────────────────────────────────

Deno.test("module registered exactly one handler through Deno.serve", () => {
  assertEquals(typeof handler, "function");
});

Deno.test("a config refusal KEEPS its three slots, so the per-phone cap stops the fourth request before Twilio", async () => {
  // 60204 on the branded send and again on the unbranded resend: two Twilio calls a request.
  await withStubs(() => twilioRefusal(60204, 403), async (db, twilioCalls) => {
    const first = await requestCode();
    assertEquals(first.status, 503, "config refusal answers not-available");
    assertEquals(db.sendCounts(), [1, 1, 1], "phone, IP and tenant slots all stay claimed");
    assertEquals(twilioCalls.length, 2);

    assertEquals((await requestCode()).status, 503);
    assertEquals((await requestCode()).status, 503);
    assertEquals(db.sendCounts(), [3, 3, 3]);

    const fourth = await requestCode();
    assertEquals(fourth.status, 429, "the per-phone cap (3) now binds");
    assertEquals(twilioCalls.length, 6, "the capped request never reached Twilio");
  });
});

Deno.test("21608 and 20404 are config refusals too: slots kept", async () => {
  for (const [code, status] of [[21608, 403], [20404, 404]]) {
    await withStubs(() => twilioRefusal(code, status), async (db, twilioCalls) => {
      const res = await requestCode();
      assertEquals(res.status, 503, `${status}/${code}`);
      assertEquals(db.sendCounts(), [1, 1, 1], `${status}/${code}: slots kept`);
      assertEquals(twilioCalls.length, 1, `${status}/${code}: sent once, never resent`);
    });
  }
});

Deno.test("a bad-number or landline refusal gives all three slots back", async () => {
  for (const [code, status] of [[60200, 400], [60205, 403]]) {
    await withStubs(() => twilioRefusal(code, status), async (db) => {
      const res = await requestCode();
      assertEquals(res.status, 400, `${status}/${code}: "we couldn't text that number"`);
      assertEquals(db.sendCounts(), [0, 0, 0], `${status}/${code}: slots released`);
    });
  }
});
