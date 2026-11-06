// The quote email check, driven through the SHIPPED handler against a fake database and a fake CRM
// (2026-11-04, migration 357).
//
// WHY THIS EXISTS. _shared/ghlEmailCheck.test.ts proves the rules. This proves the two ends around
// them are wired:
//
//   1. ghl-email-check/index.ts refuses a caller with no service key, and with one it reads the queue,
//      asks the CRM and writes a real app_errors row through logEdgeError.
//   2. An unreadable queue answers 500, so withErrorLog files it and the Worker's fault log fires.
//   3. submit-estimate queues a check only on the CRM email path, only after a 2xx, and takes the
//      send's start time before the POST. Read from the shipped source: the handler is thousands of
//      lines of quote logic, and what matters here is where these few lines sit.
//
// HOW. The aiDraftStreamWiring_test idiom: Deno.serve is stubbed while the function is imported, the
// import map swaps supabase-js for supabase_stub.ts, and fetch is ghlFake and nothing else. No
// --allow-net is granted, so nothing leaves the box.
//
// ⚠️ THE IMPORT SPECIFIER IS COMPUTED ON PURPOSE (see aiDraftStreamWiring_test): a literal one would
// type-check the function against the stub's partial client type.
//
// Tenants and CRM ids are made up. The repo is public.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { stubDb } from "./supabase_stub.ts";
import { CUSTOMER, ghlFake, type GhlWorld } from "./ghlFake.ts";

const realServe = Deno.serve;
let handler: ((req: Request) => Promise<Response>) | null = null;
(Deno as any).serve = (h: (req: Request) => Promise<Response>) => {
  handler = h;
  return { finished: Promise.resolve() };
};
await import(new URL("../../ghl-email-check/index.ts", import.meta.url).href);
(Deno as any).serve = realServe;
if (!handler) throw new Error("ghl-email-check did not hand Deno.serve a handler");
const HANDLER = handler as (req: Request) => Promise<Response>;

const SERVICE = "stub-service-key";
const SENT = new Date(Date.now() - 10 * 60_000).toISOString();

type Db = { checks: Record<string, any>[]; rows: Record<string, any>[]; failQueue?: boolean };

/** Enough of the query builder for this function: every statement resolves when awaited. */
function table(db: Db, name: string): any {
  const ops: any[][] = [];
  const q: any = {};
  for (const m of ["select", "update", "insert", "eq", "not", "lte", "order", "limit", "maybeSingle"]) {
    q[m] = (...a: unknown[]) => { ops.push([m, ...a]); return q; };
  }
  q.then = (ok: any, bad: any) => {
    const has = (m: string) => ops.find((o) => o[0] === m);
    const answer = () => {
      if (name === "app_errors") { db.rows.push(has("insert")![1]); return { error: null }; }
      if (name === "client_settings") return { data: { ghl_api_key: "harness-key", ghl_location_id: "loc-acme" }, error: null };
      if (name !== "ghl_email_checks") throw new Error(`the fake database has no answer for ${name}`);
      if (has("update")) {
        const id = ops.find((o) => o[0] === "eq" && o[1] === "id")?.[2];
        const row = db.checks.find((c) => c.id === id);
        if (row) Object.assign(row, has("update")![1]);
        return { data: row ? [{ id }] : [], error: null };
      }
      if (has("lte")) return db.failQueue ? { data: null, error: { message: "queue unreadable" } } : { data: db.checks.filter((c) => c.state === "pending"), error: null };
      return { data: [], error: null };
    };
    return Promise.resolve().then(answer).then(ok, bad);
  };
  return q;
}

async function call(db: Db, crm: GhlWorld, auth: string | null) {
  const envNow: Record<string, string> = { SUPABASE_URL: "https://stub.supabase.co", SUPABASE_SERVICE_ROLE_KEY: SERVICE };
  for (const [k, v] of Object.entries(envNow)) Deno.env.set(k, v);
  stubDb.from = (name: string) => table(db, name);
  const fake = ghlFake(crm);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fake.fetch;
  try {
    const res = await HANDLER(new Request("https://stub.supabase.co/functions/v1/ghl-email-check", {
      method: "POST",
      headers: auth ? { authorization: auth } : {},
      body: "{}",
    }));
    return { status: res.status, body: await res.json(), trace: fake.trace };
  } finally {
    globalThis.fetch = realFetch;
    stubDb.from = null;
  }
}

const crmWith = (status: string, error?: string): GhlWorld => ({
  estimates: [],
  opportunities: [],
  conversations: [{
    id: "conv-1",
    contactId: "contact-1",
    emails: [{ rowId: "row-1", emailId: "email-1", dateAdded: new Date(Date.parse(SENT) + 1500).toISOString(), rowStatus: status, status, error }],
  }],
});
const dbWithOneDue = (): Db => ({
  rows: [],
  checks: [{
    id: 1, client_id: "acme-sheds", short_code: "SS-TEST1", ghl_estimate_id: "est-1", ghl_contact_id: "contact-1",
    send_started_at: SENT, next_check_at: SENT, looks: 0, state: "pending", ghl_conversation_id: null, ghl_email_id: null, test_inbox: false,
  }],
});

Deno.test("no service key: refused, and neither the queue nor the CRM is touched", async () => {
  const db = dbWithOneDue();
  for (const auth of [null, "Bearer not-the-key"]) {
    const out = await call(db, crmWith("failed"), auth);
    assertEquals(out.status, 401);
    assertEquals(out.trace.calls.length, 0);
  }
  assertEquals(db.checks[0].looks, 0);
});

Deno.test("a failed email becomes a real app_errors row, with no customer data in it", async () => {
  const db = dbWithOneDue();
  const out = await call(db, crmWith("failed", `Could not send to ${CUSTOMER.email}`), `Bearer ${SERVICE}`);
  assertEquals(out.status, 200);
  assertEquals(out.body.filed, 1);
  assertEquals(db.rows.length, 1);
  const row = db.rows[0];
  assertEquals(row.source, "edge:ghl-email-check");
  assertEquals(row.severity, "error");
  assertEquals(row.code, "ghl_quote_email_failed");
  assertEquals(row.client_id, "acme-sheds");
  assertEquals(row.context.designId, "SS-TEST1");
  assertEquals(db.checks[0].state, "failed");
  const text = JSON.stringify(row);
  for (const value of Object.values(CUSTOMER)) assert(!text.includes(value), `${value} reached app_errors`);
});

Deno.test("a healthy email files nothing", async () => {
  const db = dbWithOneDue();
  const out = await call(db, crmWith("delivered"), `Bearer ${SERVICE}`);
  assertEquals(out.status, 200);
  assertEquals(db.rows.length, 0);
  assertEquals(db.checks[0].state, "pending");
  assertEquals(db.checks[0].ghl_email_id, "email-1");
});

Deno.test("an unreadable queue answers 500, which is what withErrorLog and the Worker's fault log act on", async () => {
  const db = { ...dbWithOneDue(), failQueue: true };
  const out = await call(db, crmWith("failed"), `Bearer ${SERVICE}`);
  assertEquals(out.status, 500);
  assertEquals(db.rows.map((r) => r.source), ["edge:ghl-email-check"], "withErrorLog filed it");
});

// ─── submit-estimate ─────────────────────────────────────────────────────────────────────────
const SOURCE = Deno.readTextFileSync(new URL("../../submit-estimate/index.ts", import.meta.url)).replace(/\r/g, "");

/** The CRM email path: from where it builds the recipients to where the step ends. */
function crmEmailPath(): string {
  const start = SOURCE.indexOf("const recipients = redirectToTestInbox ? [betaEmail]");
  const end = SOURCE.indexOf("// 11. Persist GHL IDs", start);
  assert(start > 0 && end > start, "the send step moved; update this test");
  return SOURCE.slice(start, end);
}

Deno.test("submit-estimate takes the send's start time before the POST", () => {
  const path = crmEmailPath();
  const stamp = path.indexOf("const sendStartedAt = new Date().toISOString()");
  const post = path.indexOf("/invoices/estimate/${estimateId}/send");
  assert(stamp > 0 && post > stamp, "the stamp must come before the POST: the check finds the email row by this time");
});

Deno.test("submit-estimate queues a check only after a 2xx on the CRM email path", () => {
  assertEquals(SOURCE.split("enqueueGhlEmailCheck(supabase").length - 1, 1, "one call site");
  const path = crmEmailPath();
  const refused = path.indexOf("if (!r.ok) {");
  const ok = path.indexOf('console.log("Estimate send OK:", r.status);');
  const queued = path.indexOf("enqueueGhlEmailCheck(supabase");
  assert(refused > 0 && ok > refused && queued > ok, "the call belongs in the branch after the refusal");
  assert(path.slice(ok, queued).includes("if (contactId && recipients.length)"), "no contact or no recipient means no email to look for");
});

Deno.test("a failure to queue is logged and goes no further", () => {
  const path = crmEmailPath();
  const queued = path.indexOf("enqueueGhlEmailCheck(supabase");
  const after = path.slice(queued);
  assert(after.includes('code: "ghl_email_check_enqueue_failed"'));
  assert(!/queued\.ok[\s\S]{0,300}\b(return|throw)\b/.test(after), "must not change what the send step does");
});
