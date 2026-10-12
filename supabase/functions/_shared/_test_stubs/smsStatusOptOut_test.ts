// sms-status and Twilio's 21610 (2026-10-13), driven through the SHIPPED request handler.
//
// Through a Messaging Service, Twilio usually takes a text and only LATER fails it with 21610
// ("the recipient has opted out"), in a delivery status. Until 2026-10-13 sms-status only marked
// that text failed, so nothing recorded the opt-out: the record page said nothing and the composer
// kept offering a number Twilio would never deliver to (asked 2026-10-12: "Can we see if a
// customer has opted out?"). Now the late 21610 is recorded exactly as smsSend.ts records it at
// send time, through the one helper both use (_shared/smsOptOut.ts recordTwilioOptOut):
//   * sms_opt_outs on the NUMBER of our own row for that text (never the callback's), reason sms_stop;
//   * crm_contacts.sms_opt_out_at on the row's contact, when it has one;
//   * a sub-account's callback only finds its own business's row (the update's own rule);
//   * any other status or code writes nothing more than before, and a write that fails is
//     logged with the database's code, never the number, and still answers 200.
//
// Run (from supabase/functions/):
//   deno test --quiet --allow-env --node-modules-dir=none \
//     --import-map=_shared/_test_stubs/import_map.json \
//     _shared/_test_stubs/smsStatusOptOut_test.ts
//
// Same loading trick as postmarkEvents_test.ts: index.ts ends in Deno.serve(...), so serve is
// stubbed first and the module is imported dynamically, which hands us the real handler. The
// import map swaps supabase-js for supabase_stub.ts, whose stubDb / stubRpc hooks route every
// createClient(...) call (the handler's and logEdgeError's) into the fake below.

// deno-lint-ignore-file no-explicit-any
import { stubDb, stubRpc } from "./supabase_stub.ts";
import { _resetTwilioAccountCaches } from "../twilioAccount.ts";
import { TWILIO_OPT_OUT_NOTE } from "../smsOptOut.ts";

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
const smsStatus = await import("../../sms-status/index.ts");
(Deno as any).serve = realServe;

const SECRET = "test-sms-secret";
const BASE = "https://stub.supabase.test";
const PARENT = "AC" + "0".repeat(32);
const SUB = "AC" + "1".repeat(32);
const SID = "SM" + "0".repeat(32);
const TENANT = "tenant-a";
const SUB_TENANT = "tenant-b";
const CONTACT = "00000000-0000-4000-8000-00000000c001";
const CUSTOMER = "+15550100002";
const DIGITS = "5550100002";

// ── In-memory database ─────────────────────────────────────────────────────────────────────
// What the handler and recordTwilioOptOut call: select · update · upsert · insert · eq · is ·
// limit · maybeSingle · await. Every call is recorded with its table, operation, payload and filters.

type Row = Record<string, unknown>;
type Op = { table: string; op: string; payload: unknown; opts: unknown; filters: [string, unknown][] };

class FakeDb {
  ops: Op[] = [];
  /** Our own sms_messages rows, as a lookup by provider_sid would find them. */
  rows: Row[] = [];
  /** A table whose writes fail, with this Postgres code. */
  failWrites: Record<string, string> = {};
  from = (table: string) => {
    const op: Op = { table, op: "select", payload: null, opts: null, filters: [] };
    this.ops.push(op);
    const result = () => {
      if (op.op !== "select") {
        const code = this.failWrites[table];
        return { data: null, error: code ? { code, message: `write failed for phone_digits ${DIGITS}` } : null };
      }
      const hits = table === "sms_messages"
        ? this.rows.filter((r) => op.filters.every(([c, v]) => String(r[c]) === String(v)))
        : [];
      return { data: hits, error: null };
    };
    const q: any = {
      select: () => q,
      update: (p: unknown) => { op.op = "update"; op.payload = p; return q; },
      upsert: (p: unknown, o: unknown) => { op.op = "upsert"; op.payload = p; op.opts = o; return q; },
      insert: (p: unknown) => { op.op = "insert"; op.payload = p; return q; },
      eq: (c: string, v: unknown) => { op.filters.push([c, v]); return q; },
      is: (c: string, v: unknown) => { op.filters.push([c, `is.${v}`]); return q; },
      limit: () => q,
      maybeSingle: () => {
        const r = result();
        return Promise.resolve({ data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error });
      },
      then: (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, bad),
    };
    return q;
  };
  writes(table: string): Op[] {
    return this.ops.filter((o) => o.table === table && o.op !== "select");
  }
  reads(table: string): Op[] {
    return this.ops.filter((o) => o.table === table && o.op === "select");
  }
}

async function sign(token: string, url: string, params: Record<string, string>): Promise<string> {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(token), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)))));
}

interface Case {
  status: string;
  code?: string;
  rows?: Row[];
  failWrites?: Record<string, string>;
  /** TWILIO_SUBACCOUNTS on, the callback from this business's sub-account. */
  sub?: boolean;
}

async function post(c: Case) {
  const env: Record<string, string | undefined> = {
    SMS_INBOUND_SECRET: SECRET, SUPABASE_URL: BASE, SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
    TWILIO_ACCOUNT_SID: PARENT, TWILIO_AUTH_TOKEN: undefined, TWILIO_SUBACCOUNTS: c.sub ? "on" : undefined,
  };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(env)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
  _resetTwilioAccountCaches();
  const db = new FakeDb();
  db.rows = c.rows ?? [{ provider_sid: SID, client_id: TENANT, contact_id: CONTACT, direction: "out", to_number: CUSTOMER }];
  db.failWrites = c.failWrites ?? {};
  stubDb.from = db.from;
  stubRpc.rpc = (fn: string) => Promise.resolve(fn === "twilio_account_creds"
    ? { data: [{ client_id: SUB_TENANT, kind: "sub", account_sid: SUB, status: "active", auth_token: "sub-token" }], error: null }
    : { data: null, error: { code: "42883" } });
  try {
    const params: Record<string, string> = {
      MessageSid: SID, MessageStatus: c.status, AccountSid: c.sub ? SUB : PARENT,
      // The callback's own To is never used: the number comes from our row.
      To: "+15550109999",
      ...(c.code ? { ErrorCode: c.code } : {}),
    };
    const url = `${BASE}/functions/v1/sms-status?key=${SECRET}`;
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    if (c.sub) headers["X-Twilio-Signature"] = await sign("sub-token", url, params);
    const res = await handler!(new Request(url, { method: "POST", headers, body: new URLSearchParams(params).toString() }));
    return { res, db };
  } finally {
    stubDb.from = null;
    stubRpc.rpc = null;
    for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
  }
}

// ── optedOutByStatus ───────────────────────────────────────────────────────────────────────

Deno.test("optedOutByStatus: a failed or undelivered status with 21610, and nothing else", () => {
  const { mapStatus, optedOutByStatus } = smsStatus;
  assert(optedOutByStatus(mapStatus("failed", "21610")));
  assert(optedOutByStatus(mapStatus("undelivered", "21610")));
  assert(!optedOutByStatus(mapStatus("failed", "30007")));
  assert(!optedOutByStatus(mapStatus("failed", null)));
  assert(!optedOutByStatus(mapStatus("delivered", "21610")));
  assert(!optedOutByStatus(mapStatus("sent", "21610")));
});

// ── The handler ────────────────────────────────────────────────────────────────────────────

Deno.test("a late 21610 marks the text failed AND records the opt-out on our row's number and contact, as smsSend does", async () => {
  for (const status of ["failed", "undelivered"]) {
    const { res, db } = await post({ status, code: "21610" });
    assertEquals(res.status, 200, status);
    const [update] = db.writes("sms_messages");
    assertEquals((update.payload as Row).status, status);
    assertEquals((update.payload as Row).error_code, "21610");
    const [oo] = db.writes("sms_opt_outs");
    assertEquals(oo.op, "upsert");
    assertEquals(oo.payload, { client_id: TENANT, phone_digits: DIGITS, reason: "sms_stop", note: TWILIO_OPT_OUT_NOTE });
    // A number already opted out (a STOP that came in first, the team's, an import's) keeps its
    // row, and the contact its first time: recordTwilioOptOut adds, never rewrites.
    assertEquals(oo.opts, { onConflict: "client_id,phone_digits", ignoreDuplicates: true });
    const [contact] = db.writes("crm_contacts");
    assertEquals(contact.op, "update");
    assert(typeof (contact.payload as Row).sms_opt_out_at === "string", "the contact's flag is set");
    assertEquals(contact.filters, [["client_id", TENANT], ["id", CONTACT], ["sms_opt_out_at", "is.null"]]);
    // Found by the text's sid, with the columns the opt-out needs.
    const [lookup] = db.reads("sms_messages");
    assertEquals(lookup.filters, [["provider_sid", SID]]);
    assertEquals(db.writes("app_errors"), []);
  }
});

Deno.test("a text to a number with no contact records the number only", async () => {
  const { db } = await post({ status: "failed", code: "21610", rows: [{ provider_sid: SID, client_id: TENANT, contact_id: null, direction: "out", to_number: CUSTOMER }] });
  assertEquals(db.writes("sms_opt_outs").length, 1);
  assertEquals(db.writes("crm_contacts"), []);
});

Deno.test("anything but a 21610 writes nothing more than the status, and reads nothing more", async () => {
  for (const c of [{ status: "failed", code: "30007" }, { status: "undelivered" }, { status: "delivered" }] as Case[]) {
    const { res, db } = await post(c);
    assertEquals(res.status, 200);
    assertEquals(db.writes("sms_opt_outs"), [], JSON.stringify(c));
    assertEquals(db.writes("crm_contacts"), []);
    assertEquals(db.reads("sms_messages"), [], "no row lookup");
  }
});

Deno.test("no row of ours for the sid, or a row that isn't a text we sent: nothing recorded", async () => {
  for (const rows of [[], [{ provider_sid: SID, client_id: TENANT, contact_id: CONTACT, direction: "in", to_number: "+15550100001" }]]) {
    const { res, db } = await post({ status: "failed", code: "21610", rows });
    assertEquals(res.status, 200);
    assertEquals(db.writes("sms_opt_outs"), []);
    assertEquals(db.writes("crm_contacts"), []);
  }
});

Deno.test("a sub-account's 21610 only finds its own business's row, and records it there", async () => {
  // Our row for this sid belongs to the sub's business.
  const mine = await post({ sub: true, status: "failed", code: "21610", rows: [{ provider_sid: SID, client_id: SUB_TENANT, contact_id: CONTACT, direction: "out", to_number: CUSTOMER }] });
  assertEquals(mine.res.status, 200);
  assertEquals(mine.db.reads("sms_messages")[0].filters, [["provider_sid", SID], ["client_id", SUB_TENANT]]);
  assertEquals((mine.db.writes("sms_opt_outs")[0].payload as Row).client_id, SUB_TENANT);
  // Another business's row under the same sid: not found through this sub, nothing recorded.
  const theirs = await post({ sub: true, status: "failed", code: "21610" });
  assertEquals(theirs.res.status, 200);
  assertEquals(theirs.db.writes("sms_opt_outs"), []);
  assertEquals(theirs.db.writes("crm_contacts"), []);
});

Deno.test("a write that fails is logged by the database's code, never the number, and still answers 200", async () => {
  const { res, db } = await post({ status: "failed", code: "21610", failWrites: { sms_opt_outs: "42501" } });
  assertEquals(res.status, 200);
  const rows = db.writes("app_errors").map((o) => o.payload as Row);
  assertEquals(rows.map((r) => r.code), ["sms_opt_out_record_failed"]);
  const said = JSON.stringify(rows);
  assert(said.includes("42501"), "the code is there");
  assert(!said.includes(DIGITS) && !said.includes(CUSTOMER), "the number is not");
  // The contact's flag is still set: one failed write doesn't stop the other.
  assertEquals(db.writes("crm_contacts").length, 1);
});
