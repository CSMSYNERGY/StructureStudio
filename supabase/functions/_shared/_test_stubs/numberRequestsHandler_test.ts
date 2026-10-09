// Workstream 2, phases 6 and 8, driven through the SHIPPED portal-settings handler (review
// 2026-10-09: the new actions were pinned only by tests that read the source text, so a handler that
// ignored the operator gate's answer, or queried the wrong rows, would still have passed).
//
// What is pinned, request by request through the real Deno.serve handler:
//   * phone_port_request (a builder, phone:edit): a request is stored with the six fields only; a PIN
//     or an account number is refused BEFORE any database read; EVERY read and write it makes is
//     scoped to the caller's own client_id (no read across builders, so nothing tells a builder
//     whose a number is); a number already in one of their own open requests is refused;
//   * phone_adopt_number (an operator in view-as):
//       - a builder (no view-as) is refused by the operator gate with nothing read or sent;
//       - on Structure Studio's shared (parent) account with no open request of the builder's naming
//         the number: 409 no_open_request, nothing recorded, nothing sent to Twilio but the lookup;
//       - a number whose Twilio name is ANOTHER builder's client id: 409, nothing recorded;
//       - with an open request: recorded as a calling-only number, the request marked done, and the
//         number's FriendlyName set to the client id;
//   * phone_trust_profile (an operator in view-as) on the PARENT: Twilio refusing the primary link
//     writes NO customer_profile_sid (texting must never build on an unlinked draft) and says so.
//
// HOW. advancedModeSwitch_test's idiom: Deno.serve is stubbed while index.ts is imported, the import
// map swaps supabase-js for supabase_stub.ts, whose stubDb hook routes every table call into the fake
// below, and globalThis.fetch is the fake Twilio. No --allow-net: nothing here reaches a real
// database or Twilio. Tenants, numbers (555-01xx) and SIDs are made up; the repo is public.
//
// ⚠️ THE IMPORT SPECIFIER IS COMPUTED ON PURPOSE (see aiDraftStreamWiring_test).

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { stubAuth, stubDb, stubRpc } from "./supabase_stub.ts";

async function load(rel: string): Promise<(req: Request) => Promise<Response>> {
  const realServe = Deno.serve;
  let handler: ((req: Request) => Promise<Response>) | null = null;
  (Deno as any).serve = (h: (req: Request) => Promise<Response>) => {
    handler = h;
    return { finished: Promise.resolve() };
  };
  try {
    await import(new URL(rel, import.meta.url).href);
  } finally {
    (Deno as any).serve = realServe;
  }
  if (!handler) throw new Error(`${rel} did not hand Deno.serve a handler`);
  return handler;
}
const SETTINGS = await load("../../portal-settings/index.ts");

// ─── The world one request runs in ─────────────────────────────────────────────────────────────
const OWN = "acme-sheds";          // the caller's own tenant (a builder), or the tenant an operator views
const OTHER = "bravo-barns";       // another builder
const OPS_HOME = "harness-ops";    // an operator's own tenant
const USER_ID = "00000000-0000-4000-8000-0000000000b8";
const PARENT = "AC" + "0".repeat(32);
const PARENT_TOKEN = "parenttoken" + "z".repeat(21);
const PRIMARY = "BU" + "0".repeat(32);
const PROFILE = "BU" + "8".repeat(32);
const PN = "PN" + "8".repeat(32);
const E164 = "+18165550142";

type Row = Record<string, any>;
type World = {
  me?: { client_id: string; role: string; title: string | null; access: Record<string, string> | null };
  op?: { can_write: boolean; can_bill: boolean; support_only: boolean } | null;
  /** phone_number_requests rows. */
  requests?: Row[];
  /** sms_numbers rows (live unless released_at). */
  numbers?: Row[];
  /** client_configs ids that exist. */
  tenants?: string[];
  /** sms_registrations row for OWN. */
  registration?: Row | null;
  /** The number's FriendlyName at Twilio, or null = not in the parent at all. */
  twilioName?: string | null;
  /** Twilio refuses the primary profile link (phone_trust_profile). */
  refuseLink?: boolean;
};
type Trace = {
  db: Array<{ table: string; ops: any[][] }>;
  writes: Array<{ table: string; verb: string; row: any; ops: any[][] }>;
  twilio: Array<{ method: string; url: string; body: string }>;
  errors: Row[];
};
const has = (ops: any[][], op: string) => ops.some((o) => o[0] === op);
const argOf = (ops: any[][], op: string) => (ops.find((o) => o[0] === op) ?? []).slice(1);
const eqOf = (ops: any[][], col: string) => (ops.find((o) => o[0] === "eq" && o[1] === col) ?? [])[2];

function answer(w: World, t: Trace, table: string, ops: any[][]): any {
  const one = (row: unknown) => ({ data: row ?? null, error: null });
  const verb = ["upsert", "insert", "update", "delete"].find((v) => has(ops, v));
  if (verb && table !== "admin_audit" && table !== "app_errors") t.writes.push({ table, verb, row: argOf(ops, verb)[0], ops });
  switch (table) {
    case "client_users":
      if (eqOf(ops, "role") === "owner") return { data: [{ role: "owner", title: "owner", access: null }], error: null };
      return { data: w.me ? [{ ...w.me, user_id: USER_ID }] : [], error: null };
    case "app_operators":
      return one(w.op ? { user_id: USER_ID, email: "ops@example.test", ...w.op } : null);
    case "client_configs": {
      const id = eqOf(ops, "client_id");
      if (id && !(w.tenants ?? [OWN, OTHER, OPS_HOME]).includes(id)) return one(null);
      return one({ client_id: id ?? OWN, company_name: "Example" });
    }
    case "admin_audit":
      return { data: null, error: null };
    case "app_errors":
      t.errors.push(argOf(ops, "insert")[0]);
      return { data: null, error: null };
    case "client_settings":
      if (verb) return { data: null, error: null };
      return one({ internal_account: false, phone_status: "off", billing_exempt: false });
    case "twilio_accounts":
      return one(null);
    case "phone_number_requests": {
      const rows = (w.requests ?? []).filter((r) => {
        const cid = eqOf(ops, "client_id");
        if (cid && r.client_id !== cid) return false;
        const st = argOf(ops, "in");
        if (st[0] === "status" && !st[1].includes(r.status)) return false;
        const ov = argOf(ops, "overlaps");
        if (ov[0] === "numbers" && !r.numbers.some((n: string) => ov[1].includes(n))) return false;
        const ct = argOf(ops, "contains");
        if (ct[0] === "numbers" && !ct[1].every((n: string) => r.numbers.includes(n))) return false;
        return true;
      });
      if (verb === "insert") {
        const row = { id: "00000000-0000-4000-8000-00000000r001", created_at: "2026-10-09T12:00:00Z", handled_at: null, ...argOf(ops, "insert")[0] };
        (w.requests ??= []).push(row);
        return one(row);
      }
      if (verb === "update") {
        for (const r of rows) Object.assign(r, argOf(ops, "update")[0]);
        return { data: null, error: null };
      }
      const sel = argOf(ops, "select");
      if (sel[1]?.head) return { data: null, count: rows.length, error: null };
      return { data: rows, error: null };
    }
    case "sms_numbers": {
      if (verb === "insert") {
        const row = { id: "n-new", ...argOf(ops, "insert")[0] };
        (w.numbers ??= []).push(row);
        return one({ id: row.id, phone_number: row.phone_number, twilio_sid: row.twilio_sid });
      }
      if (verb) return { data: null, error: null };
      const rows = (w.numbers ?? []).filter((r) => {
        const cid = eqOf(ops, "client_id");
        if (cid && r.client_id !== cid) return false;
        const pn = eqOf(ops, "phone_number");
        if (pn && r.phone_number !== pn) return false;
        const inn = argOf(ops, "in");
        if (inn[0] === "phone_number" && !inn[1].includes(r.phone_number)) return false;
        return !r.released_at;
      });
      return has(ops, "maybeSingle") ? one(rows[0] ?? null) : { data: rows, error: null };
    }
    case "sms_registrations": {
      if (verb === "insert") { w.registration = { ...argOf(ops, "insert")[0] }; return { data: null, error: null }; }
      if (verb === "update") {
        const patch = argOf(ops, "update")[0];
        // The lock claim (.or(...).select(...)) answers the row it took.
        if ("advance_lock_until" in patch && has(ops, "select")) return { data: [{ client_id: OWN }], error: null };
        Object.assign(w.registration ??= {}, patch);
        return { data: null, error: null };
      }
      return one(w.registration ?? null);
    }
  }
  throw new Error(`the fake database has no answer for ${table} ${JSON.stringify(ops)}`);
}

function chain(w: World, t: Trace, table: string, ops: any[][]): any {
  const next = (op: any[]) => chain(w, t, table, [...ops, op]);
  const q: any = {};
  for (const m of ["select", "insert", "update", "delete", "upsert", "eq", "neq", "gt", "gte", "lt", "lte", "is", "in", "not", "or", "limit", "order", "range", "overlaps", "contains", "single", "maybeSingle"]) {
    q[m] = (...a: unknown[]) => next([m, ...a]);
  }
  q.then = (ok: any, bad: any) => {
    t.db.push({ table, ops });
    return Promise.resolve().then(() => answer(w, t, table, ops)).then(ok, bad);
  };
  return q;
}

/** The fake Twilio: the parent account's numbers and Trust Hub, and nothing else. */
function twilio(w: World, t: Trace) {
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = String(init?.method ?? "GET");
    const body = String(init?.body ?? "");
    t.twilio.push({ method, url, body });
    if (url.startsWith(`https://api.twilio.com/2010-04-01/Accounts/${PARENT}/IncomingPhoneNumbers.json?`)) {
      return json({ incoming_phone_numbers: w.twilioName === null || w.twilioName === undefined ? [] : [{ sid: PN, phone_number: E164, friendly_name: w.twilioName }] });
    }
    if (method === "POST" && url === `https://api.twilio.com/2010-04-01/Accounts/${PARENT}/IncomingPhoneNumbers/${PN}.json`) return json({ sid: PN });
    if (url.endsWith("/EndUsers")) return json({ sid: "IT" + "8".repeat(32) }, 201);
    if (url.endsWith("/Addresses.json")) return json({ sid: "AD" + "8".repeat(32) }, 201);
    if (url.endsWith("/SupportingDocuments")) return json({ sid: "RD" + "8".repeat(32) }, 201);
    if (url.endsWith("/CustomerProfiles")) return json({ sid: PROFILE, status: "draft" }, 201);
    if (url.endsWith(`/CustomerProfiles/${PROFILE}/EntityAssignments`)) {
      return new URLSearchParams(body).get("ObjectSid") === PRIMARY && w.refuseLink
        ? json({ code: 20403, message: "echoes what was sent" }, 403)
        : json({ sid: "BV" + "8".repeat(32) }, 201);
    }
    throw new Error(`TEST FAILURE: unexpected fetch ${method} ${url}`);
  };
}

const ENV: Record<string, string> = {
  SUPABASE_URL: "https://stub.supabase.co",
  SUPABASE_ANON_KEY: "stub-anon",
  SUPABASE_SERVICE_ROLE_KEY: "stub-service",
  TWILIO_ACCOUNT_SID: PARENT,
  TWILIO_AUTH_TOKEN: PARENT_TOKEN,
  TWILIO_PRIMARY_PROFILE_SID: PRIMARY,
  SMS_INBOUND_SECRET: "stub-inbound-secret",
  PHONE_API_BASE: "https://phone-api.example.test",
  PHONE_WEBHOOK_SECRET: "stub-phone-webhook-secret",
  PHONE_FALLBACK_URL: "https://fallback.example.test/voicemail.xml",
};
const UNSET = ["TWILIO_SUBACCOUNTS", "TWILIO_API_KEY", "TWILIO_API_SECRET", "PHONE_SELF_SERVE"];

async function call(body: Record<string, unknown>, w: World) {
  const t: Trace = { db: [], writes: [], twilio: [], errors: [] };
  const saved = Object.fromEntries([...Object.keys(ENV), ...UNSET].map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  for (const k of UNSET) Deno.env.delete(k);
  const realFetch = globalThis.fetch;
  stubAuth.user = { id: USER_ID, email: "someone@example.test" };
  stubAuth.error = null;
  stubDb.from = (table: string) => chain(w, t, table, []);
  stubRpc.rpc = (fn: string) => {
    t.db.push({ table: `rpc:${fn}`, ops: [] });
    // twilio_parent_holdings: the builder lives on the parent (it holds a number there).
    return Promise.resolve({ data: fn === "twilio_parent_holdings" ? true : null, error: null });
  };
  globalThis.fetch = twilio(w, t) as typeof fetch;
  try {
    const res = await SETTINGS(new Request("https://stub.supabase.co/functions/v1/portal-settings", {
      method: "POST",
      headers: { authorization: "Bearer harness", "content-type": "application/json", "user-agent": "harness/1.0" },
      body: JSON.stringify(body),
    }));
    return { status: res.status, body: await res.json(), t };
  } finally {
    globalThis.fetch = realFetch;
    stubDb.from = null;
    stubRpc.rpc = null;
    stubAuth.user = null;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

const OWNER = { client_id: OWN, role: "owner", title: "owner", access: null };
const OPERATOR: World = { me: { client_id: OPS_HOME, role: "user", title: null, access: null }, op: { can_write: true, can_bill: true, support_only: false } };
const REQUEST = {
  numbers: ["(816) 555-0142"], currentCarrier: "Verizon", isLcPhone: false,
  contactName: "Pat Example", contactEmail: "pat@builder.example.test", cutoverWindow: "after 10/20/2026, 9am-5pm",
};
/** Every phone_number_requests / sms_numbers query in the trace names the caller's own tenant. */
function onlyOwnRows(t: Trace, tenant: string) {
  for (const q of t.db.filter((x) => x.table === "phone_number_requests" || x.table === "sms_numbers")) {
    const scoped = eqOf(q.ops, "client_id") === tenant || (has(q.ops, "insert") && argOf(q.ops, "insert")[0]?.client_id === tenant);
    assert(scoped, `a ${q.table} query not scoped to ${tenant}: ${JSON.stringify(q.ops)}`);
  }
}

// ─── phone_port_request ─────────────────────────────────────────────────────────────────────────
Deno.test("phone_port_request: a builder's request is stored, and every row it reads or writes is their own", async () => {
  const w: World = {
    me: OWNER,
    // Another builder's live number and open request for the SAME number: never read, never a refusal.
    numbers: [{ id: "n-other", client_id: OTHER, phone_number: E164, released_at: null }],
    requests: [{ id: "r-other", client_id: OTHER, numbers: [E164], status: "new" }],
  };
  const r = await call({ action: "phone_port_request", request: REQUEST }, w);
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals([r.body.request.status, r.body.request.numbers], ["new", [E164]]);
  const ins = r.t.writes.filter((x) => x.table === "phone_number_requests");
  assertEquals(ins.length, 1);
  assertEquals(Object.keys(ins[0].row).sort(), ["client_id", "contact_email", "contact_name", "current_carrier", "cutover_window", "is_lc_phone", "numbers", "requested_by", "status"]);
  assertEquals(ins[0].row.client_id, OWN);
  onlyOwnRows(r.t, OWN);
  assertEquals(r.t.twilio, [], "nothing is sent anywhere");
});

Deno.test("phone_port_request: a PIN or an account number is refused before anything is read", async () => {
  for (const [field, v] of [["cutoverWindow", "PIN 4829"], ["currentCarrier", "Verizon 1234-5678-9012"], ["contactName", "Pat acct 287-123-456"]] as const) {
    const r = await call({ action: "phone_port_request", request: { ...REQUEST, [field]: v } }, { me: OWNER });
    assertEquals(r.status, 400, `${field}: ${JSON.stringify(r.body)}`);
    assert(/Don't put a PIN, password or account number here/.test(r.body.error), r.body.error);
    assertEquals(r.t.db.filter((x) => x.table === "phone_number_requests" || x.table === "sms_numbers"), [], `${field}: nothing read`);
    assertEquals(r.t.writes.filter((x) => x.table === "phone_number_requests"), []);
  }
});

Deno.test("phone_port_request: a number already in one of the builder's OWN open requests is refused", async () => {
  const w: World = { me: OWNER, requests: [{ id: "r-mine", client_id: OWN, numbers: [E164], status: "in_progress" }] };
  const r = await call({ action: "phone_port_request", request: REQUEST }, w);
  assertEquals(r.status, 409, JSON.stringify(r.body));
  assert(/already in one of your open requests/.test(r.body.error), r.body.error);
  assertEquals(r.t.writes.filter((x) => x.table === "phone_number_requests"), []);
});

// ─── phone_adopt_number ─────────────────────────────────────────────────────────────────────────
const ADOPT = { action: "phone_adopt_number", phoneNumber: "(816) 555-0142", targetClientId: OWN };

Deno.test("phone_adopt_number: a builder is refused by the operator gate, nothing read from Twilio", async () => {
  const r = await call({ action: "phone_adopt_number", phoneNumber: "(816) 555-0142" }, { me: OWNER, twilioName: "(816) 555-0142" });
  assertEquals(r.status, 403, JSON.stringify(r.body));
  assertEquals(r.t.twilio, []);
  assertEquals(r.t.writes.filter((x) => x.table === "sms_numbers"), []);
});

Deno.test("phone_adopt_number on the shared account: refused without an open request of the builder's naming it (review 2026-10-09)", async () => {
  const w: World = {
    ...OPERATOR, twilioName: "(816) 555-0142",
    // Someone else's request for the number does not count.
    requests: [{ id: "r-other", client_id: OTHER, numbers: [E164], status: "new" }],
  };
  const r = await call(ADOPT, w);
  assertEquals([r.status, r.body.code], [409, "no_open_request"], JSON.stringify(r.body));
  assertEquals(r.t.writes.filter((x) => x.table === "sms_numbers"), [], "nothing recorded");
  assertEquals(r.t.twilio.map((x) => x.method), ["GET"], "only the lookup reached Twilio");
});

Deno.test("phone_adopt_number: a number named at Twilio for ANOTHER builder is refused (review 2026-10-09)", async () => {
  const w: World = { ...OPERATOR, twilioName: OTHER, requests: [{ id: "r-mine", client_id: OWN, numbers: [E164], status: "in_progress" }] };
  const r = await call(ADOPT, w);
  assertEquals([r.status, r.body.code], [409, "number_named_for_other"], JSON.stringify(r.body));
  assertEquals(r.t.writes.filter((x) => x.table === "sms_numbers"), []);
  assertEquals(r.t.twilio.map((x) => x.method), ["GET"]);
});

Deno.test("phone_adopt_number with an open request: recorded calling-only, the request done, its Twilio name set", async () => {
  const w: World = { ...OPERATOR, twilioName: "(816) 555-0142", requests: [{ id: "r-mine", client_id: OWN, numbers: [E164], status: "in_progress" }] };
  const r = await call(ADOPT, w);
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const ins = r.t.writes.filter((x) => x.table === "sms_numbers" && x.verb === "insert");
  assertEquals(ins.length, 1);
  assertEquals([ins[0].row.client_id, ins[0].row.phone_number, ins[0].row.twilio_sid], [OWN, E164, PN]);
  assertEquals(w.requests![0].status, "done", "the request naming it is marked done");
  const named = r.t.twilio.find((x) => x.method === "POST" && new URLSearchParams(x.body).get("FriendlyName") === OWN);
  assert(named, `FriendlyName set to the client id: ${JSON.stringify(r.t.twilio)}`);
});

// ─── phone_trust_profile on the parent ──────────────────────────────────────────────────────────
const INTAKE = {
  legalBusinessName: "Example Calls Only LLC", ein: "12-3456789", businessType: "Limited Liability Corporation",
  businessIndustry: "CONSTRUCTION", websiteUrl: "https://calls.example.test", street: "1 Test Way", city: "Testville",
  region: "MO", postalCode: "64101", isoCountry: "US", repFirstName: "Pat", repLastName: "Example",
  repEmail: "pat@calls.example.test", repPhone: "+15555550100", repBusinessTitle: "Owner", repJobPosition: "CEO",
};

Deno.test("phone_trust_profile on the parent: a refused primary link writes no customer_profile_sid (review 2026-10-09)", async () => {
  const w: World = {
    ...OPERATOR, refuseLink: true, registration: { status: "none" },
    numbers: [{ id: "n-1", client_id: OWN, phone_number: E164, twilio_sid: PN, released_at: null, purchased_at: "2026-10-01T00:00:00Z" }],
  };
  const r = await call({ action: "phone_trust_profile", intake: INTAKE, targetClientId: OWN }, w);
  assertEquals(r.status, 502, JSON.stringify(r.body));
  assert(/refused to link .* Nothing was saved: press it again to start over\./.test(r.body.error), r.body.error);
  assert(!("customer_profile_sid" in (w.registration ?? {})), `no profile recorded: ${JSON.stringify(w.registration)}`);
  assert(!r.t.writes.some((x) => x.table === "sms_registrations" && x.row && "customer_profile_sid" in x.row), "never written");
  assert(!JSON.stringify(r.body).includes("12-3456789") && !JSON.stringify(r.body).includes("echoes"), "no submitted detail travels back");
});
