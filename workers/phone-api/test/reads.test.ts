import { describe, expect, it } from "vitest";
import {
  Auth, BUSINESS_NUMBER, CLIENT, CONTACT_1, CONTACT_2, CUSTOMER, FakeNet, USER_A, USER_B, USER_C,
  appRequest, call, callerCtx, eventRows, filter, jsonRes, makeEnv, type Seen,
} from "./helpers";

const T = (min: number) => new Date(Date.UTC(2026, 8, 29, 12, 0) - min * 60_000).toISOString();
const CONTACT_3 = "00000000-0000-4000-8000-00000000c003";
const OTHER_TENANT = "other-tenant";

function callRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id, client_id: CLIENT, number_id: null, contact_id: null, direction: "in", from_e164: CUSTOMER, to_e164: BUSINESS_NUMBER,
    twilio_call_sid: null, client_call_sid: null, placed_by: null, answered_by: null, rang_user_ids: [],
    transferred_from: null, transfer_state: null, status: "completed", started_at: T(1), answered_at: null, ended_at: null,
    duration_s: 30, error_code: null, is_emergency: false, crm_contacts: null, phone_voicemails: null, ...over,
  };
}

// ── A table that answers the way PostgREST would ────────────────────────────────────
// The reply honours the filters the Worker sends (eq, in, lt, gte, is.null, not.is.null and
// `or` over those), its order, its limit and its column list. Rows the Worker must never see
// (another tenant's, sign-in codes) sit in the fixtures, so a filter the Worker forgets shows
// up as a wrong answer, not as a passing test.

/** Split on the commas that are not inside parentheses or quotes. */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted && ch === "\\") { cur += ch + s[++i]; continue; }
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "(") depth++;
    else if (!quoted && ch === ")") depth--;
    else if (!quoted && ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

const unquote = (v: string) => (v.startsWith('"') ? v.slice(1, -1).replace(/\\(.)/g, "$1") : v);

function holds(val: unknown, expr: string): boolean {
  if (expr === "is.null") return val == null;
  if (expr === "not.is.null") return val != null;
  const i = expr.indexOf(".");
  const op = expr.slice(0, i);
  const arg = expr.slice(i + 1);
  if (op === "eq") return val != null && String(val) === arg;
  if (op === "lt") return val != null && String(val) < arg;
  if (op === "gte") return val != null && String(val) >= arg;
  if (op === "in") return val != null && splitTop(arg.slice(1, -1)).map(unquote).includes(String(val));
  throw new Error(`table(): the fake has no "${op}" filter`);
}

function table(rows: Record<string, unknown>[]) {
  return (s: Seen) => {
    const p = s.url.searchParams;
    let out = rows.filter((r) => [...p.entries()].every(([k, v]) => {
      if (k === "select" || k === "order" || k === "limit") return true;
      if (k === "or") return splitTop(v.slice(1, -1)).some((part) => holds(r[part.slice(0, part.indexOf("."))], part.slice(part.indexOf(".") + 1)));
      return holds(r[k], v);
    }));
    const order = p.get("order");
    if (order) {
      const [col, dir] = order.split(".");
      const sign = dir === "desc" ? -1 : 1;
      out = [...out].sort((a, b) => (String(a[col]) < String(b[col]) ? -sign : String(a[col]) > String(b[col]) ? sign : 0));
    }
    const limit = p.get("limit");
    if (limit) out = out.slice(0, Number(limit));
    const cols = (p.get("select") ?? "*").split(",");
    return cols.includes("*") ? out : out.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
  };
}

/** Email is switched on for the tenant (its own domain, verified) and the CRM is paid for. */
const READY = { client_id: CLIENT, internal_account: false, billing_exempt: false, email_provider: "resend", invoice_in_ghl: true, email_domain_status: "verified" };
const CRM_PLAN = { id: "plan-crm", feature: "crm", billing_interval: "month" };
const CRM_SUB = { client_id: CLIENT, plan_id: "plan-crm", status: "active", current_period_start: null, current_period_end: null, canceled_at: null, created_at: T(9000), past_due_since: null };

async function setup(ctx: Record<string, unknown>, visible: string[] | null = null) {
  const net = new FakeNet().install();
  const auth = await new Auth().init();
  auth.serve(net);
  net.rpc("phone_caller_context", () => ctx);
  net.rpc("crm_visible_contact_ids", (s) => (visible ?? s.json.p_ids));
  // A thread read also reads the contact's email and whether they can send one. By default
  // there is none, and email is set up and paid for; a test overrides what it is about.
  net.rest("GET", "designs", () => []);
  net.rest("GET", "email_sends", () => []);
  net.rest("GET", "email_inbound", () => []);
  net.rest("GET", "client_settings", table([READY]));
  net.rest("GET", "billing_plans", table([CRM_PLAN]));
  net.rest("GET", "billing_subscriptions", table([CRM_SUB]));
  return { net, token: await auth.token(USER_A), env: makeEnv() };
}

const ids = (list: { id: string }[]) => list.map((c) => c.id);

describe("GET /calls", () => {
  it("own level gets 'mine': placed, answered, rung for a missed call with no owner, and missed calls on MY customers", async () => {
    const { net, token, env } = await setup(callerCtx({ phone_level: "own" }));
    const mine = [
      callRow("c1", { placed_by: USER_A, direction: "out", started_at: T(1) }),
      callRow("c2", { answered_by: USER_A, started_at: T(2) }),
      callRow("c3", { status: "missed", rang_user_ids: [USER_A, USER_B], started_at: T(3) }),
      // Rang me, but the customer belongs to B: B's missed call, not mine.
      callRow("c4", { status: "missed", rang_user_ids: [USER_A], contact_id: CONTACT_2, crm_contacts: { name: "Casey", owner_user_id: USER_B }, started_at: T(4) }),
      // Rang me, but C answered it: C's call.
      callRow("c5", { status: "completed", rang_user_ids: [USER_A], answered_by: USER_C, started_at: T(5) }),
    ];
    const owned = [callRow("c6", { status: "voicemail", contact_id: CONTACT_1, crm_contacts: { name: "Jordan", owner_user_id: USER_A }, started_at: T(6), phone_voicemails: [{ id: "v6", duration_s: 12, listened_at: null, deleted_at: null }] })];
    net.rest("GET", "phone_calls", (s) => (s.url.searchParams.get("crm_contacts.owner_user_id") ? owned : mine));
    const { json } = await call(env, appRequest("GET", "/calls?scope=team", token));
    expect(ids(json.calls)).toEqual(["c1", "c2", "c3", "c6"]); // scope=team is ignored for own
    expect(json.calls[0]).toMatchObject({ direction: "out", e164: BUSINESS_NUMBER });
    expect(json.calls[3]).toMatchObject({ contact_name: "Jordan", voicemail: { id: "v6", duration_s: 12, listened: false } });

    const [a, b] = net.reads("phone_calls");
    expect(filter(a, "client_id")).toBe(CLIENT);
    expect(a.url.searchParams.get("or")).toBe(`(placed_by.eq.${USER_A},answered_by.eq.${USER_A},transferred_from.eq.${USER_A},rang_user_ids.cs.{${USER_A}})`);
    expect(b.url.searchParams.get("select")).toContain("crm_contacts!inner");
  });

  it("view level may ask for the team's calls", async () => {
    const { net, token, env } = await setup(callerCtx({ phone_level: "view" }));
    net.rest("GET", "phone_calls", () => [callRow("t1", { answered_by: USER_B }), callRow("t2", { placed_by: USER_C })]);
    const { json } = await call(env, appRequest("GET", "/calls?scope=team", token));
    expect(ids(json.calls)).toEqual(["t1", "t2"]);
    expect(net.reads("phone_calls")).toHaveLength(1);
    expect(net.reads("phone_calls")[0].url.searchParams.get("or")).toBeNull();
  });

  it("drops calls about customers the caller can't see, and unknown numbers for own-scoped users unless they took part", async () => {
    const { net, token, env } = await setup(callerCtx({ phone_level: "view", contacts_level: "own", own_contacts_only: true }), [CONTACT_1]);
    net.rest("GET", "phone_calls", () => [
      callRow("s1", { contact_id: CONTACT_1 }),
      callRow("s2", { contact_id: CONTACT_2 }),
      callRow("s3", { contact_id: null, answered_by: USER_B }),
      callRow("s4", { contact_id: null, answered_by: USER_A }),
    ]);
    const { json } = await call(env, appRequest("GET", "/calls?scope=team", token));
    expect(ids(json.calls)).toEqual(["s1", "s4"]);
    expect(net.rpcCalls("crm_visible_contact_ids")[0].json).toEqual({ p_client_id: CLIENT, p_user_id: USER_A, p_ids: [CONTACT_1, CONTACT_2] });
  });

  describe("where a warm transfer stands (warm, on live calls in their conference)", () => {
    const leg = (n: number) => "CA" + "0".repeat(31) + String(n);
    const live = (id: string, over: Record<string, unknown> = {}) =>
      callRow(id, { status: "in_progress", transfer_state: "conference", answered_by: USER_A, ...over });
    const wev = (call_id: string, type: string, data: Record<string, unknown>, min: number) => ({ call_id, type, at: T(min), data });

    it("ringing, missed and answered, from the Worker's own events, in ONE read for the live conference calls only", async () => {
      const { net, token, env } = await setup(callerCtx({ phone_level: "view" }));
      net.rest("GET", "phone_calls", () => [
        live("w1"), live("w2"), live("w3", { answered_by: USER_B, transferred_from: USER_A }), live("w4"),
        live("plain", { transfer_state: null }),
        callRow("done", { status: "completed", transfer_state: null }),
      ]);
      net.rest("GET", "phone_call_events", eventRows([
        wev("w1", "warm_transfer", { from: USER_A, to: USER_B, sid: leg(1) }, 1),
        // The app's own timing mark (POST /calls/:id/events) is newer, and never counts.
        wev("w1", "warm_transfer", { to_user_id: USER_C, source: "app", user: USER_A }, 0.5),
        // A decline written before the warm_transfer event itself: the leg ties them together.
        wev("w2", "warm_transfer_missed", { user: USER_B, status: "busy", sid: leg(2) }, 2),
        wev("w2", "warm_transfer", { from: USER_A, to: USER_B, sid: leg(2) }, 1),
        wev("w3", "warm_transfer", { from: USER_A, to: USER_B, sid: leg(3) }, 1),
        // Missed, then a second try to someone else: that one is ringing.
        wev("w4", "warm_transfer", { from: USER_A, to: USER_B, sid: leg(4) }, 5),
        wev("w4", "warm_transfer_missed", { user: USER_B, status: "no-answer", sid: leg(4) }, 4),
        wev("w4", "warm_transfer", { from: USER_A, to: USER_C, sid: leg(5) }, 1),
      ]));
      const { json } = await call(env, appRequest("GET", "/calls?scope=team", token));
      const byId = Object.fromEntries(json.calls.map((r: { id: string }) => [r.id, r]));
      expect(byId.w1.warm).toEqual({ to_user_id: USER_B, state: "ringing", at: T(1) });
      expect(byId.w2.warm).toEqual({ to_user_id: USER_B, state: "missed", at: T(1) });
      expect(byId.w3.warm).toEqual({ to_user_id: USER_B, state: "answered", at: T(1) });
      expect(byId.w4.warm).toEqual({ to_user_id: USER_C, state: "ringing", at: T(1) });
      expect(byId.plain).not.toHaveProperty("warm");
      expect(byId.done).not.toHaveProperty("warm");
      const reads = net.reads("phone_call_events");
      expect(reads).toHaveLength(1);
      expect(reads[0].url.searchParams.get("call_id")).toBe("in.(w1,w2,w3,w4)");
      expect(reads[0].url.searchParams.get("type")).toBe("in.(warm_transfer,warm_transfer_missed,transfer)");
    });

    it("a warm transfer from before a cold transfer was in a conference that is over: not reported for the new one", async () => {
      const { net, token, env } = await setup(callerCtx({ phone_level: "view" }));
      // B took a warm transfer, then cold-transferred the call to C, who pressed Hold: the call
      // is in a NEW conference under the same name. B's warm transfer is not this one's.
      net.rest("GET", "phone_calls", () => [live("w6", { answered_by: USER_C, transferred_from: USER_B }), live("w7", { answered_by: USER_C })]);
      net.rest("GET", "phone_call_events", eventRows([
        wev("w6", "warm_transfer", { from: USER_A, to: USER_B, sid: leg(6) }, 9),
        wev("w6", "transfer", { from: USER_B, to: USER_C, dnd: false }, 5),
        wev("w6", "hold", { user: USER_C, moved: true }, 2),
        // An app's own mark called 'transfer' is not a cold transfer.
        wev("w7", "warm_transfer", { from: USER_A, to: USER_B, sid: leg(7) }, 9),
        wev("w7", "warm_transfer_missed", { user: USER_B, status: "busy", sid: leg(7) }, 8),
        wev("w7", "transfer", { source: "app", user: USER_A }, 5),
      ]));
      const { json } = await call(env, appRequest("GET", "/calls?scope=team", token));
      const byId = Object.fromEntries(json.calls.map((r: { id: string }) => [r.id, r]));
      expect(byId.w6).not.toHaveProperty("warm");
      expect(byId.w7.warm).toEqual({ to_user_id: USER_B, state: "missed", at: T(9) });
    });

    it("a page with no live conference call reads no events", async () => {
      const { net, token, env } = await setup(callerCtx({ phone_level: "view" }));
      net.rest("GET", "phone_calls", () => [callRow("a"), callRow("b", { status: "in_progress" })]);
      const { json } = await call(env, appRequest("GET", "/calls?scope=team", token));
      expect(ids(json.calls)).toEqual(["a", "b"]);
      expect(net.reads("phone_call_events")).toEqual([]);
    });

    it("a failed events read leaves warm off; the list still loads", async () => {
      const { net, token, env } = await setup(callerCtx({ phone_level: "view" }));
      net.rest("GET", "phone_calls", () => [live("w1")]);
      net.rest("GET", "phone_call_events", () => jsonRes({ message: "boom" }, 500));
      const { res, json } = await call(env, appRequest("GET", "/calls?scope=team", token));
      expect(res.status).toBe(200);
      expect(json.calls[0]).not.toHaveProperty("warm");
    });
  });

  it("pages with a started_at cursor", async () => {
    const { net, token, env } = await setup(callerCtx({ phone_level: "edit" }));
    net.rest("GET", "phone_calls", () => Array.from({ length: 50 }, (_, i) => callRow(`p${i}`, { started_at: T(i + 1) })));
    const first = await call(env, appRequest("GET", "/calls?scope=team", token));
    expect(first.json.cursor).toBe(T(50));
    await call(env, appRequest("GET", `/calls?scope=team&cursor=${encodeURIComponent(first.json.cursor)}`, token));
    expect(net.reads("phone_calls")[1].url.searchParams.get("started_at")).toBe(`lt.${T(50)}`);
  });
});

describe("GET /threads", () => {
  function msg(id: string, over: Record<string, unknown>) {
    return { id, contact_id: null, direction: "in", body: `body ${id}`, status: "received", created_at: T(1), from_number: CUSTOMER, to_number: BUSINESS_NUMBER, sent_by: null, ...over };
  }
  // sms_messages has no foreign key to crm_contacts, so names and owners come from a second read.
  function contacts(net: FakeNet, rows: { id: string; name: string; owner_user_id: string | null }[]) {
    net.rest("GET", "crm_contacts", () => rows);
  }

  it("groups by contact (or number), newest first, applying 'mine' for own level", async () => {
    const { net, token, env } = await setup(callerCtx({ phone_level: "own", contacts_level: "edit" }));
    net.rest("GET", "sms_messages", () => [
      msg("m1", { contact_id: CONTACT_1, created_at: T(1) }),
      msg("m2", { contact_id: CONTACT_2, created_at: T(2) }),
      msg("m3", { contact_id: null, from_number: "+15555550150", created_at: T(3) }),
      msg("m4", { contact_id: CONTACT_1, created_at: T(4) }),
    ]);
    contacts(net, [{ id: CONTACT_1, name: "Jordan", owner_user_id: USER_A }, { id: CONTACT_2, name: "Casey", owner_user_id: USER_B }]);
    const { json } = await call(env, appRequest("GET", "/threads", token));
    // Casey belongs to B and I sent nothing there: not mine. The unknown number has no owner.
    expect(json.threads).toEqual([
      { key: CONTACT_1, contact_id: CONTACT_1, contact_name: "Jordan", e164: CUSTOMER, last: { body: "body m1", direction: "in", at: T(1) } },
      { key: "n:+15555550150", contact_id: null, contact_name: null, e164: "+15555550150", last: { body: "body m3", direction: "in", at: T(3) } },
    ]);
    // No embed on sms_messages (it has no foreign key); the contact read is tenant-scoped.
    expect(net.reads("sms_messages")[0].url.searchParams.get("select")).not.toContain("crm_contacts");
    const cq = net.reads("crm_contacts")[0];
    expect(filter(cq, "client_id")).toBe(CLIENT);
    expect(cq.url.searchParams.get("id")).toBe(`in.(${CONTACT_1},${CONTACT_2})`);
  });

  it("a scan that filters down to a short page still hands back a cursor to older texts", async () => {
    const { net, token, env } = await setup(callerCtx({ phone_level: "own" }));
    // 500 texts from one customer who belongs to someone else: nothing is mine on this page.
    net.rest("GET", "sms_messages", () => Array.from({ length: 500 }, (_, i) => msg(`x${i}`, { contact_id: CONTACT_2, created_at: T(i + 1) })));
    contacts(net, [{ id: CONTACT_2, name: "Casey", owner_user_id: USER_B }]);
    const { json } = await call(env, appRequest("GET", "/threads", token));
    expect(json.threads).toEqual([]);
    expect(json.cursor).toBe(T(500));
  });

  it("a thread I sent a text in is mine even when the customer belongs to someone else", async () => {
    const { net, token, env } = await setup(callerCtx({ phone_level: "own" }));
    net.rest("GET", "sms_messages", () => [
      msg("m1", { contact_id: CONTACT_2, created_at: T(1) }),
      msg("m2", { contact_id: CONTACT_2, direction: "out", sent_by: USER_A, from_number: BUSINESS_NUMBER, to_number: CUSTOMER, created_at: T(2) }),
    ]);
    contacts(net, [{ id: CONTACT_2, name: "Casey", owner_user_id: USER_B }]);
    const { json } = await call(env, appRequest("GET", "/threads", token));
    expect(json.threads.map((t: { key: string }) => t.key)).toEqual([CONTACT_2]);
  });

  it("own-scoped contacts: only visible customers, and no unknown numbers", async () => {
    const { net, token, env } = await setup(callerCtx({ phone_level: "view", contacts_level: "own", own_contacts_only: true }), [CONTACT_1]);
    net.rest("GET", "sms_messages", () => [
      msg("m1", { contact_id: CONTACT_1 }),
      msg("m2", { contact_id: CONTACT_2 }),
      msg("m3", { contact_id: null, from_number: "+15555550150" }),
    ]);
    contacts(net, [{ id: CONTACT_1, name: "Jordan", owner_user_id: USER_A }, { id: CONTACT_2, name: "Casey", owner_user_id: null }]);
    const { json } = await call(env, appRequest("GET", "/threads", token));
    expect(json.threads.map((t: { key: string }) => t.key)).toEqual([CONTACT_1]);
  });

  it("contacts none sees no threads at all", async () => {
    const { net, token, env } = await setup(callerCtx({ contacts_level: "none" }));
    const { json } = await call(env, appRequest("GET", "/threads", token));
    expect(json.threads).toEqual([]);
    expect(net.reads("sms_messages")).toEqual([]);
  });
});

describe("GET /threads?channels=sms,email (email joins the list)", () => {
  type Row = Record<string, unknown>;
  const text = (id: string, over: Row): Row => ({
    id, client_id: CLIENT, contact_id: null, direction: "in", body: `text ${id}`, status: "received", created_at: T(1),
    from_number: CUSTOMER, to_number: BUSINESS_NUMBER, sent_by: null, ...over,
  });
  const mailIn = (id: string, over: Row): Row => ({ id, client_id: CLIENT, contact_id: null, short_code: null, subject: `subject ${id}`, received_at: T(1), ...over });
  const mailOut = (id: string, over: Row): Row => ({
    id, client_id: CLIENT, contact_id: null, short_code: null, kind: "conversation", subject: `subject ${id}`, created_at: T(1), sent_by: null, ...over,
  });
  const person = (id: string, name: string, over: Row = {}): Row => ({ id, client_id: CLIENT, name, owner_user_id: null, phone: null, ...over });

  interface World { sms?: Row[]; inbound?: Row[]; sent?: Row[]; contacts?: Row[] }
  function world(net: FakeNet, w: World) {
    net.rest("GET", "sms_messages", table(w.sms ?? []));
    net.rest("GET", "email_inbound", table(w.inbound ?? []));
    net.rest("GET", "email_sends", table(w.sent ?? []));
    net.rest("GET", "crm_contacts", table(w.contacts ?? []));
  }
  const list = (token: string, query = "?channels=sms,email") => appRequest("GET", `/threads${query}`, token);

  it("a contact who has only emailed is listed, with the number on their record (e164_source contact) or none; paperwork and other tenants' mail move nothing", async () => {
    const { net, token, env } = await setup(callerCtx({ phone_level: "view" }));
    world(net, {
      contacts: [person(CONTACT_1, "Jordan"), person(CONTACT_2, "Casey", { phone: "(555) 555-0143" }), person(CONTACT_3, "Riley")],
      sms: [text("s1", { contact_id: CONTACT_1, created_at: T(3) })],
      inbound: [
        mailIn("i1", { contact_id: CONTACT_2, subject: "Shed sizes", received_at: T(1) }),
        // Mail from someone who isn't a contact, and another tenant's: never listed.
        mailIn("i2", { contact_id: null, received_at: T(0.5) }),
        mailIn("i3", { client_id: OTHER_TENANT, contact_id: CONTACT_1, received_at: T(0.5) }),
      ],
      sent: [
        mailOut("o1", { contact_id: CONTACT_3, subject: "Your delivery date", sent_by: USER_B, created_at: T(2) }),
        // A quote, a sign-in code and another tenant's mail are newer than Jordan's text, and move nothing.
        mailOut("o2", { contact_id: CONTACT_1, kind: "estimate", created_at: T(0.5) }),
        mailOut("o3", { contact_id: CONTACT_1, kind: "login_code", created_at: T(0.4) }),
        mailOut("o4", { client_id: OTHER_TENANT, contact_id: CONTACT_1, created_at: T(0.3) }),
      ],
    });
    const { json } = await call(env, list(token));
    expect(json.threads).toEqual([
      { key: CONTACT_2, contact_id: CONTACT_2, contact_name: "Casey", e164: "+15555550143", e164_source: "contact", last: { body: "Shed sizes", direction: "in", at: T(1), channel: "email" } },
      { key: CONTACT_3, contact_id: CONTACT_3, contact_name: "Riley", e164: null, e164_source: "contact", last: { body: "Your delivery date", direction: "out", at: T(2), channel: "email" } },
      { key: CONTACT_1, contact_id: CONTACT_1, contact_name: "Jordan", e164: CUSTOMER, e164_source: "sms", last: { body: "text s1", direction: "in", at: T(3), channel: "sms" } },
    ]);
    expect(json).not.toHaveProperty("cursor");
    const [ins] = net.reads("email_inbound");
    expect(filter(ins, "client_id")).toBe(CLIENT);
    expect(ins.url.searchParams.get("contact_id")).toBe("not.is.null");
    const [outs] = net.reads("email_sends");
    expect(outs.url.searchParams.get("kind")).toBe("in.(conversation,test)");
    expect(outs.url.searchParams.get("contact_id")).toBe("not.is.null");
  });

  it("the newest activity across texts and email wins, and the number still comes from the texts (e164_source sms)", async () => {
    const { net, token, env } = await setup(callerCtx({ phone_level: "view" }));
    world(net, {
      contacts: [person(CONTACT_1, "Jordan", { phone: "(555) 555-0199" }), person(CONTACT_2, "Casey")],
      sms: [
        text("s1", { contact_id: CONTACT_1, created_at: T(5) }),
        text("s2", { contact_id: CONTACT_2, direction: "out", from_number: BUSINESS_NUMBER, to_number: "+15555550143", sent_by: USER_A, body: "On my way", created_at: T(1) }),
      ],
      inbound: [mailIn("i1", { contact_id: CONTACT_1, subject: "Re: Your quote", received_at: T(2) })],
      sent: [mailOut("o1", { contact_id: CONTACT_2, created_at: T(4) })],
    });
    const { json } = await call(env, list(token));
    expect(json.threads).toEqual([
      { key: CONTACT_2, contact_id: CONTACT_2, contact_name: "Casey", e164: "+15555550143", e164_source: "sms", last: { body: "On my way", direction: "out", at: T(1), channel: "sms" } },
      { key: CONTACT_1, contact_id: CONTACT_1, contact_name: "Jordan", e164: CUSTOMER, e164_source: "sms", last: { body: "Re: Your quote", direction: "in", at: T(2), channel: "email" } },
    ]);
  });

  it("a thread I emailed is mine even when the customer belongs to someone else", async () => {
    const { net, token, env } = await setup(callerCtx({ phone_level: "own" }));
    world(net, {
      contacts: [person(CONTACT_2, "Casey", { owner_user_id: USER_B }), person(CONTACT_3, "Riley", { owner_user_id: USER_B })],
      inbound: [mailIn("i1", { contact_id: CONTACT_2, received_at: T(1) }), mailIn("i2", { contact_id: CONTACT_3, received_at: T(2) })],
      sent: [mailOut("o1", { contact_id: CONTACT_2, sent_by: USER_A, created_at: T(3) }), mailOut("o2", { contact_id: CONTACT_3, sent_by: USER_B, created_at: T(4) })],
    });
    const { json } = await call(env, list(token));
    expect(json.threads.map((t: { key: string }) => t.key)).toEqual([CONTACT_2]);
  });

  it("channels=email lists email alone and reads no texts", async () => {
    const { net, token, env } = await setup(callerCtx({ phone_level: "view" }));
    world(net, {
      contacts: [person(CONTACT_1, "Jordan"), person(CONTACT_2, "Casey")],
      sms: [text("s1", { contact_id: CONTACT_1 })],
      inbound: [mailIn("i1", { contact_id: CONTACT_2 })],
    });
    const { json } = await call(env, list(token, "?channels=email"));
    expect(json.threads.map((t: { key: string; last: { channel: string } }) => [t.key, t.last.channel])).toEqual([[CONTACT_2, "email"]]);
    expect(net.reads("sms_messages")).toEqual([]);
  });

  it("without the param (or with nothing it knows) the list is the texts-only one, byte for byte, and no email is read", async () => {
    const { net, token, env } = await setup(callerCtx({ phone_level: "view" }));
    world(net, {
      contacts: [person(CONTACT_1, "Jordan", { phone: "(555) 555-0199" }), person(CONTACT_2, "Casey")],
      sms: [text("s1", { contact_id: CONTACT_1, created_at: T(3) })],
      inbound: [mailIn("i1", { contact_id: CONTACT_1, received_at: T(1) }), mailIn("i2", { contact_id: CONTACT_2, received_at: T(2) })],
      sent: [mailOut("o1", { contact_id: CONTACT_2, created_at: T(0.5) })],
    });
    const today = JSON.stringify({
      ok: true,
      threads: [{ key: CONTACT_1, contact_id: CONTACT_1, contact_name: "Jordan", e164: CUSTOMER, last: { body: "text s1", direction: "in", at: T(3) } }],
    });
    for (const query of ["", "?channels=", "?channels=fax"]) {
      const { text: body } = await call(env, list(token, query));
      expect(body).toBe(today);
    }
    expect(net.reads("email_inbound")).toEqual([]);
    expect(net.reads("email_sends")).toEqual([]);
    // Neither is the contact's phone: the contact read is the one it always was.
    for (const r of net.reads("crm_contacts")) expect(r.url.searchParams.get("select")).toBe("id,name,owner_user_id");
    // Asking for texts by name opts in to the channel and e164_source fields, and still reads no email.
    const { json } = await call(env, list(token, "?channels=sms"));
    expect(json.threads[0].last).toEqual({ body: "text s1", direction: "in", at: T(3), channel: "sms" });
    expect(json.threads[0].e164_source).toBe("sms");
    expect(net.reads("email_inbound")).toEqual([]);
  });

  // ── paging over three tables ──────────────────────────────────────────────────────

  const S = (sec: number) => new Date(Date.UTC(2026, 8, 29, 12, 0) - sec * 1000).toISOString();

  /** Every page, in order, until there is no cursor. */
  async function walk(env: ReturnType<typeof makeEnv>, token: string) {
    const threads: { key: string; last: { at: string; channel: string } }[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const { json } = await call(env, list(token, `?channels=sms,email${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`));
      expect(json.ok).toBe(true);
      threads.push(...json.threads);
      cursor = json.cursor ?? null;
      pages++;
    } while (cursor && pages < 100);
    return { threads, pages };
  }

  /** The answer the slow way: each thread's newest event in any table, newest first. */
  function expected(w: World): [string, string, string][] {
    const newest = new Map<string, { at: string; channel: string }>();
    const see = (key: string, at: string, channel: string) => {
      const n = newest.get(key);
      if (!n || at > n.at) newest.set(key, { at, channel });
    };
    for (const m of w.sms ?? []) {
      if (m.client_id !== CLIENT) continue;
      see(String(m.contact_id ?? `n:${m.direction === "in" ? m.from_number : m.to_number}`), String(m.created_at), "sms");
    }
    for (const r of w.inbound ?? []) if (r.client_id === CLIENT && r.contact_id) see(String(r.contact_id), String(r.received_at), "email");
    for (const r of w.sent ?? []) {
      if (r.client_id === CLIENT && r.contact_id && (r.kind === "conversation" || r.kind === "test")) see(String(r.contact_id), String(r.created_at), "email");
    }
    return [...newest.entries()].sort((a, b) => (a[1].at < b[1].at ? 1 : -1)).map(([k, v]) => [k, v.at, v.channel]);
  }

  it("a text just past the end of a full text scan is not beaten by an older email: the thread shows once, with the text", async () => {
    const { net, token, env } = await setup(callerCtx({ phone_level: "view" }));
    // Jordan's 600 texts fill the text scan (500), which ends at S(500). Casey's text at S(650)
    // is past that end; Casey's email at S(700) is older still, but the email scan isn't full,
    // so page 1 reads it. Shown there, Casey would come back on page 2 with the text.
    const w: World = {
      contacts: [person(CONTACT_1, "Jordan"), person(CONTACT_2, "Casey")],
      sms: [
        ...Array.from({ length: 600 }, (_, i) => text(`j${i}`, { contact_id: CONTACT_1, created_at: S(i + 1) })),
        text("c1", { contact_id: CONTACT_2, created_at: S(650) }),
      ],
      inbound: [mailIn("ci", { contact_id: CONTACT_2, received_at: S(700) })],
    };
    world(net, w);
    const { threads, pages } = await walk(env, token);
    expect(threads.map((t) => [t.key, t.last.at, t.last.channel])).toEqual([[CONTACT_1, S(1), "sms"], [CONTACT_2, S(650), "sms"]]);
    expect(pages).toBe(2);
  });

  it("two full scans: the window ends where the SHORTER one ends, so an email just past it still wins its thread", async () => {
    const { net, token, env } = await setup(callerCtx({ phone_level: "view" }));
    // Jordan's texts (every even second) fill the text scan, which ends at S(998). Casey's mail
    // (odd seconds 3 to 501) fills the email scan, which ends at S(401). Riley's text at S(801)
    // is inside the text scan, but Riley's newer email at S(701) is past the email scan's end.
    // Page 1 may only show what both scans covered (back to S(401)), or Riley shows the text.
    const w: World = {
      contacts: [person(CONTACT_1, "Jordan"), person(CONTACT_2, "Casey"), person(CONTACT_3, "Riley")],
      sms: [
        ...Array.from({ length: 600 }, (_, i) => text(`j${i}`, { contact_id: CONTACT_1, created_at: S(2 * (i + 1)) })),
        text("r1", { contact_id: CONTACT_3, created_at: S(801) }),
      ],
      inbound: [
        ...Array.from({ length: 250 }, (_, i) => mailIn(`c${i}`, { contact_id: CONTACT_2, received_at: S(2 * (i + 1) + 1) })),
        mailIn("r2", { contact_id: CONTACT_3, received_at: S(701) }),
      ],
    };
    world(net, w);
    const { threads } = await walk(env, token);
    expect(threads.map((t) => [t.key, t.last.at, t.last.channel])).toEqual(expected(w));
    expect(threads.map((t) => t.key)).toEqual([CONTACT_1, CONTACT_2, CONTACT_3]);
    expect(threads[2].last).toMatchObject({ at: S(701), channel: "email" });
  });

  it("pages over texts and email together: every thread once, in order, each with its true newest event", async () => {
    const { net, token, env } = await setup(callerCtx({ phone_level: "view" }));
    // A fixed seed, so a failure is the same failure every run.
    let seed = 0x5eed;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pick = <V>(list: V[]) => list[Math.floor(rand() * list.length)];
    const people = Array.from({ length: 90 }, (_, i) => `00000000-0000-4000-8000-${(0xd000 + i).toString(16).padStart(12, "0")}`);
    const numbers = Array.from({ length: 6 }, (_, i) => `+1555555020${i}`);
    // Every event gets its own second (no ties), in shuffled order.
    const secs = Array.from({ length: 1400 }, (_, i) => i + 1);
    for (let i = secs.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [secs[i], secs[j]] = [secs[j], secs[i]];
    }
    let n = 0;
    const at = () => S(secs[n++]);
    const w: World = { contacts: people.map((id, i) => person(id, `Person ${i}`)), sms: [], inbound: [], sent: [] };
    for (let i = 0; i < 640; i++) {
      const out = rand() < 0.4;
      w.sms!.push(text(`s${i}`, { contact_id: pick(people.slice(0, 70)), direction: out ? "out" : "in", created_at: at() }));
    }
    for (let i = 0; i < 60; i++) w.sms!.push(text(`u${i}`, { from_number: pick(numbers), created_at: at() }));
    for (let i = 0; i < 260; i++) w.inbound!.push(mailIn(`i${i}`, { contact_id: pick(people.slice(30)), received_at: at() }));
    for (let i = 0; i < 20; i++) w.inbound!.push(mailIn(`iz${i}`, { contact_id: null, received_at: at() }));
    for (let i = 0; i < 300; i++) {
      const r = rand();
      w.sent!.push(mailOut(`o${i}`, { contact_id: pick(people.slice(50)), kind: r < 0.8 ? "conversation" : r < 0.9 ? "test" : "estimate", created_at: at() }));
    }
    for (let i = 0; i < 10; i++) w.sent!.push(mailOut(`ol${i}`, { contact_id: pick(people), kind: "login_code", created_at: at() }));
    for (let i = 0; i < 10; i++) w.sent!.push(mailOut(`ox${i}`, { client_id: OTHER_TENANT, contact_id: pick(people), created_at: at() }));
    world(net, w);

    const { threads, pages } = await walk(env, token);
    expect(threads.map((t) => [t.key, t.last.at, t.last.channel])).toEqual(expected(w));
    expect(new Set(threads.map((t) => t.key)).size).toBe(threads.length);
    expect(pages).toBeGreaterThan(2);
  });
});

describe("GET /threads/:key", () => {
  it("returns a visible contact's texts oldest-first with client_temp_id and num_media", async () => {
    const { net, token, env } = await setup(callerCtx({ phone_level: "own" }));
    net.rest("GET", "crm_contacts", () => [{ id: CONTACT_1, owner_user_id: USER_A }]);
    net.rest("GET", "sms_messages", () => [
      { id: "m2", direction: "out", body: "Thanks", status: "delivered", created_at: T(1), sent_by: USER_A, client_temp_id: "tmp-2", num_media: 0 },
      { id: "m1", direction: "in", body: "", status: "received", created_at: T(2), sent_by: null, client_temp_id: null, num_media: 2 },
    ]);
    net.rest("GET", "phone_calls", () => [callRow("k1", { placed_by: USER_A, contact_id: CONTACT_1 }), callRow("k2", { answered_by: USER_B, contact_id: CONTACT_1 })]);
    const { json } = await call(env, appRequest("GET", `/threads/${CONTACT_1}`, token));
    expect(json.messages.map((m: { id: string }) => m.id)).toEqual(["m1", "m2"]);
    expect(json.messages[0]).toEqual({ id: "m1", direction: "in", body: "", status: "received", at: T(2), sent_by: null, client_temp_id: null, num_media: 2 });
    expect(json.calls.map((c: { id: string }) => c.id)).toEqual(["k1"]); // own level: my calls only
    expect(filter(net.reads("sms_messages")[0], "client_id")).toBe(CLIENT);
  });

  it("a customer outside an own-scoped user's list is not found", async () => {
    const { net, token, env } = await setup(callerCtx({ contacts_level: "own", own_contacts_only: true }), []);
    net.rest("GET", "crm_contacts", () => [{ id: CONTACT_2, owner_user_id: USER_B }]);
    const { res, json } = await call(env, appRequest("GET", `/threads/${CONTACT_2}`, token));
    expect(res.status).toBe(404);
    expect(json.error.code).toBe("not_found");
  });

  it("an unknown-number thread by n:+1... key", async () => {
    const { net, token, env } = await setup(callerCtx({ contacts_level: "view" }));
    net.rest("GET", "sms_messages", () => [{ id: "u1", direction: "in", body: "hello?", status: "received", created_at: T(1), sent_by: null, client_temp_id: null, num_media: 0 }]);
    net.rest("GET", "phone_calls", () => []);
    const { json } = await call(env, appRequest("GET", `/threads/${encodeURIComponent("n:+15555550150")}`, token));
    expect(json.messages).toHaveLength(1);
    const q = net.reads("sms_messages")[0];
    expect(q.url.searchParams.get("contact_id")).toBe("is.null");
    expect(q.url.searchParams.get("or")).toBe("(from_number.eq.+15555550150,to_number.eq.+15555550150)");
  });
});

describe("GET /threads/:key email (emails and compose)", () => {
  type Row = Record<string, unknown>;
  const sentRow = (id: string, over: Row): Row => ({
    id, client_id: CLIENT, contact_id: null, short_code: null, kind: "conversation", subject: `subject ${id}`, status: "sent",
    created_at: T(1), to_email: "jordan@example.test", intended_email: null, body_text: `words ${id}`, sent_by: USER_A, client_temp_id: null, ...over,
  });
  const gotRow = (id: string, over: Row): Row => ({
    id, client_id: CLIENT, contact_id: null, short_code: null, from_email: "jordan@example.test", from_name: "Jordan",
    subject: `subject ${id}`, body_text: `words ${id}`, body_html: null, received_at: T(1), spam_verdict: null, ...over,
  });

  interface Thread { contact?: Row | null; designs?: Row[]; sent?: Row[]; inbound?: Row[] }
  function thread(net: FakeNet, w: Thread = {}) {
    const contact = w.contact === null ? [] : [{ id: CONTACT_1, client_id: CLIENT, owner_user_id: USER_A, email: "jordan@example.test", ...w.contact }];
    net.rest("GET", "crm_contacts", table(contact));
    net.rest("GET", "sms_messages", () => []);
    net.rest("GET", "phone_calls", () => []);
    net.rest("GET", "designs", table(w.designs ?? []));
    net.rest("GET", "email_sends", table(w.sent ?? []));
    net.rest("GET", "email_inbound", table(w.inbound ?? []));
  }
  const read = (token: string, key: string = CONTACT_1) => appRequest("GET", `/threads/${encodeURIComponent(key)}`, token);
  const emailReads = (net: FakeNet) => [...net.reads("designs"), ...net.reads("email_sends"), ...net.reads("email_inbound")];

  it("finds email by the contact AND by their designs' codes, both ways, oldest first; never another tenant's or a sign-in code", async () => {
    const { net, token, env } = await setup(callerCtx({ phone_level: "own" }));
    thread(net, {
      designs: [
        { client_id: CLIENT, contact_id: CONTACT_1, short_code: "SS-1" },
        { client_id: CLIENT, contact_id: CONTACT_1, short_code: null },
        { client_id: CLIENT, contact_id: CONTACT_2, short_code: "SS-2" },
        { client_id: OTHER_TENANT, contact_id: CONTACT_1, short_code: "SS-9" },
      ],
      sent: [
        sentRow("o1", { contact_id: CONTACT_1, subject: "About your shed", body_text: "Hi Jordan", client_temp_id: "tmp-1", created_at: T(30) }),
        // A quote: keyed on the design, not the person. Sent before migration 261, so no words.
        sentRow("o2", { short_code: "SS-1", kind: "estimate", subject: "Your quote", body_text: null, sent_by: null, created_at: T(40) }),
        // Under the tenant's beta redirect: to_email is where it went, intended_email who it was for.
        sentRow("o3", { contact_id: CONTACT_1, status: "claimed", to_email: "beta@example.test", intended_email: "jordan@example.test", created_at: T(5) }),
        sentRow("x1", { contact_id: CONTACT_1, kind: "login_code", subject: "Your sign-in code", created_at: T(20) }),
        sentRow("x2", { client_id: OTHER_TENANT, contact_id: CONTACT_1, created_at: T(10) }),
        sentRow("x3", { contact_id: CONTACT_2, created_at: T(15) }),
        sentRow("x4", { short_code: "SS-2", kind: "invoice", created_at: T(16) }),
        sentRow("x5", { short_code: "SS-9", kind: "invoice", created_at: T(17) }),
      ],
      inbound: [
        gotRow("i1", { contact_id: CONTACT_1, subject: "Re: About your shed", body_text: "Sounds good", spam_verdict: "spf=pass dkim=pass", received_at: T(25) }),
        gotRow("i2", { short_code: "SS-1", subject: "Question on the quote", spam_verdict: "spf=fail dkim=pass", received_at: T(35) }),
        gotRow("y1", { client_id: OTHER_TENANT, contact_id: CONTACT_1, received_at: T(12) }),
        gotRow("y2", { contact_id: CONTACT_2, received_at: T(13) }),
      ],
    });
    const { res, json } = await call(env, read(token));
    expect(res.status).toBe(200);
    expect(json.emails.map((e: { id: string }) => e.id)).toEqual(["o2", "i2", "o1", "i1", "o3"]);
    const byId = Object.fromEntries(json.emails.map((e: { id: string }) => [e.id, e]));
    expect(byId.o1).toEqual({
      id: "o1", direction: "out", at: T(30), kind: "conversation", subject: "About your shed", body: "Hi Jordan", body_truncated: false,
      status: "sent", sent_by: USER_A, client_temp_id: "tmp-1", from: null, to_email: "jordan@example.test", sender_verified: null,
    });
    expect(byId.o2).toMatchObject({ kind: "estimate", subject: "Your quote", body: null, sent_by: null });
    expect(byId.o3).toMatchObject({ status: "sending", to_email: "jordan@example.test" });
    expect(byId.i1).toEqual({
      id: "i1", direction: "in", at: T(25), kind: "conversation", subject: "Re: About your shed", body: "Sounds good", body_truncated: false,
      status: null, sent_by: null, client_temp_id: null, from: { name: "Jordan", email: "jordan@example.test" }, to_email: null, sender_verified: true,
    });
    expect(byId.i2.sender_verified).toBe(false);

    // What was asked: the tenant's designs for this contact, and both email tables by the same `or`.
    const [d] = net.reads("designs");
    expect(filter(d, "client_id")).toBe(CLIENT);
    expect(filter(d, "contact_id")).toBe(CONTACT_1);
    const [s] = net.reads("email_sends");
    expect(filter(s, "client_id")).toBe(CLIENT);
    expect(s.url.searchParams.get("kind")).toBe("in.(conversation,test,estimate,invoice,change_order,acceptance)");
    expect(s.url.searchParams.get("or")).toBe(`(contact_id.eq.${CONTACT_1},short_code.in.("SS-1"))`);
    const [i] = net.reads("email_inbound");
    expect(filter(i, "client_id")).toBe(CLIENT);
    expect(i.url.searchParams.get("or")).toBe(`(contact_id.eq.${CONTACT_1},short_code.in.("SS-1"))`);
    // Every body had a text part, so no HTML was read at all.
    expect(net.reads("email_inbound")).toHaveLength(1);
    expect(i.url.searchParams.get("select")).not.toContain("body_html");
  });

  it("a contact with no designs is found by the contact alone", async () => {
    const { net, token, env } = await setup(callerCtx());
    thread(net, { sent: [sentRow("o1", { contact_id: CONTACT_1 })] });
    const { json } = await call(env, read(token));
    expect(json.emails.map((e: { id: string }) => e.id)).toEqual(["o1"]);
    expect(net.reads("email_sends")[0].url.searchParams.get("or")).toBe(`(contact_id.eq.${CONTACT_1})`);
  });

  it("mail that came in as HTML only is read as text, its HTML fetched by id for those rows alone", async () => {
    const { net, token, env } = await setup(callerCtx());
    const html = "<html><head><style>p{color:red}</style><title>Newsletter</title></head><body>"
      + "<p>Hello&nbsp;there &amp; welcome</p><div>Line two<br>Line three</div><script>alert(1)</script></body></html>";
    thread(net, {
      inbound: [
        gotRow("i1", { contact_id: CONTACT_1, body_text: null, body_html: html, received_at: T(2) }),
        gotRow("i2", { contact_id: CONTACT_1, body_text: "   ", body_html: "<p>Only &lt;this&gt;</p>", received_at: T(1) }),
        gotRow("i3", { contact_id: CONTACT_1, body_text: "Plain words", body_html: "<p>Ignored</p>", received_at: T(0.5) }),
        gotRow("i4", { contact_id: CONTACT_1, body_text: null, body_html: null, received_at: T(0.4) }),
      ],
    });
    const { json } = await call(env, read(token));
    expect(json.emails.map((e: { id: string; body: string | null }) => [e.id, e.body])).toEqual([
      ["i1", "Hello there & welcome\nLine two\nLine three"],
      ["i2", "Only <this>"],
      ["i3", "Plain words"],
      ["i4", null],
    ]);
    const [first, second] = net.reads("email_inbound");
    expect(first.url.searchParams.get("select")).not.toContain("body_html");
    expect(second.url.searchParams.get("select")).toBe("id,body_html");
    expect(second.url.searchParams.get("id")).toBe("in.(i4,i2,i1)"); // as the first read returned them, newest first
    expect(filter(second, "client_id")).toBe(CLIENT);
  });

  it("a body longer than 8000 characters is cut there, and says so", async () => {
    const { net, token, env } = await setup(callerCtx());
    thread(net, {
      sent: [sentRow("o1", { contact_id: CONTACT_1, body_text: "a".repeat(9000), created_at: T(2) })],
      inbound: [
        gotRow("i1", { contact_id: CONTACT_1, body_text: "b".repeat(8000), received_at: T(1) }),
        gotRow("i2", { contact_id: CONTACT_1, body_text: null, body_html: `<p>${"c".repeat(8001)}</p>`, received_at: T(0.5) }),
      ],
    });
    const { json } = await call(env, read(token));
    const got = json.emails.map((e: { id: string; body: string; body_truncated: boolean }) => [e.id, e.body.length, e.body_truncated]);
    expect(got).toEqual([["o1", 8000, true], ["i1", 8000, false], ["i2", 8000, true]]);
  });

  it("an unknown number has no email, and can't be emailed until it is saved", async () => {
    const { net, token, env } = await setup(callerCtx({ contacts_level: "view" }));
    thread(net);
    const { json } = await call(env, read(token, "n:+15555550150"));
    expect(json.emails).toEqual([]);
    expect(json.compose).toEqual({ email_to: null, email_block: "unknown_number" });
    expect(emailReads(net)).toEqual([]);
    expect(net.reads("billing_plans")).toEqual([]);
  });

  it("contacts none is not found, and reads no email", async () => {
    const { net, token, env } = await setup(callerCtx({ contacts_level: "none" }));
    thread(net, { sent: [sentRow("o1", { contact_id: CONTACT_1 })] });
    const { res, json } = await call(env, read(token));
    expect(res.status).toBe(404);
    expect(json.error.code).toBe("not_found");
    expect(emailReads(net)).toEqual([]);
  });

  it("someone else's customer is not found for an own-scoped user, and reads no email", async () => {
    const { net, token, env } = await setup(callerCtx({ contacts_level: "own", own_contacts_only: true }), []);
    thread(net, { contact: { owner_user_id: USER_B }, sent: [sentRow("o1", { contact_id: CONTACT_1 })] });
    const { res, json } = await call(env, read(token));
    expect(res.status).toBe(404);
    expect(json.error.code).toBe("not_found");
    expect(emailReads(net)).toEqual([]);
  });

  it("another tenant's contact is not found", async () => {
    const { net, token, env } = await setup(callerCtx());
    thread(net, { contact: { client_id: OTHER_TENANT } });
    const { res } = await call(env, read(token));
    expect(res.status).toBe(404);
    expect(emailReads(net)).toEqual([]);
  });

  describe("compose: whether this person can email this contact, and why not", () => {
    interface Case { ctx?: Row; settings?: Row[]; subs?: Row[]; email?: string | null }
    const cases: [string, Case, { email_to: string | null; email_block: string | null }][] = [
      ["everything in place", {}, { email_to: "jordan@example.test", email_block: null }],
      ["the address is trimmed", { email: "  jordan@example.test " }, { email_to: "jordan@example.test", email_block: null }],
      ["contacts view: no_edit", { ctx: { contacts_level: "view" } }, { email_to: "jordan@example.test", email_block: "no_edit" }],
      ["no CRM on the plan: no_crm", { subs: [] }, { email_to: "jordan@example.test", email_block: "no_crm" }],
      ["email still goes through the old CRM: not_set_up", { settings: [{ ...READY, email_provider: "ghl" }] }, { email_to: "jordan@example.test", email_block: "not_set_up" }],
      ["the domain isn't verified yet: not_set_up", { settings: [{ ...READY, email_domain_status: "pending" }] }, { email_to: "jordan@example.test", email_block: "not_set_up" }],
      ["no settings row: not_set_up", { settings: [] }, { email_to: "jordan@example.test", email_block: "not_set_up" }],
      ["paperwork mode with a verified domain can send", { settings: [{ ...READY, email_provider: "ghl", invoice_in_ghl: false }] }, { email_to: "jordan@example.test", email_block: null }],
      ["no address on the contact: no_address", { email: null }, { email_to: null, email_block: "no_address" }],
      ["an address that isn't one: no_address", { email: "jordan at example" }, { email_to: null, email_block: "no_address" }],
      ["the first reason wins", { ctx: { contacts_level: "view" }, subs: [], settings: [], email: null }, { email_to: null, email_block: "no_edit" }],
      ["no_crm before not_set_up and no_address", { subs: [], settings: [], email: null }, { email_to: null, email_block: "no_crm" }],
      ["not_set_up before no_address", { settings: [], email: null }, { email_to: null, email_block: "not_set_up" }],
    ];
    it.each(cases)("%s", async (_name, w, want) => {
      const { net, token, env } = await setup(callerCtx(w.ctx ?? {}));
      thread(net, { contact: w.email === undefined ? {} : { email: w.email } });
      if (w.settings) net.rest("GET", "client_settings", table(w.settings));
      if (w.subs) net.rest("GET", "billing_subscriptions", table(w.subs));
      const { res, json } = await call(env, read(token));
      expect(res.status).toBe(200);
      expect(json.compose).toEqual(want);
    });

    it("someone who can't write is told so without a billing read", async () => {
      const { net, token, env } = await setup(callerCtx({ contacts_level: "view" }));
      thread(net);
      await call(env, read(token));
      expect(net.reads("billing_plans")).toEqual([]);
      expect(net.reads("client_settings")).toEqual([]);
    });

    it("a billing read that fails fails the read (closed), never offering a composer that can't send", async () => {
      const { net, token, env } = await setup(callerCtx());
      thread(net);
      net.rest("GET", "billing_plans", () => jsonRes({ message: "boom" }, 500));
      net.rest("POST", "app_errors", () => []);
      const { res, json } = await call(env, read(token));
      expect(res.status).toBe(500);
      expect(json.error.code).toBe("internal");
    });
  });
});

describe("GET /search and /team", () => {
  it("searches by name or digits with the row scope applied", async () => {
    const { net, token, env } = await setup(callerCtx({ contacts_level: "own", own_contacts_only: true }), [CONTACT_1]);
    net.rest("GET", "crm_contacts", () => [
      { id: CONTACT_1, name: "Jordan Demo", phone: "(555) 555-0142", phone_digits: "5555550142" },
      { id: CONTACT_2, name: "Jordan Other", phone: "555-555-0143", phone_digits: "5555550143" },
    ]);
    const { json } = await call(env, appRequest("GET", "/search?q=jord", token));
    expect(json.contacts).toEqual([{ id: CONTACT_1, name: "Jordan Demo", e164: "+15555550142" }]);
    const q = net.reads("crm_contacts")[0];
    expect(q.url.searchParams.get("or")).toBe("(name.ilike.*jord*)");
    expect(filter(q, "client_id")).toBe(CLIENT);
  });

  it("strips filter syntax out of the search text", async () => {
    const { net, token, env } = await setup(callerCtx());
    net.rest("GET", "crm_contacts", () => []);
    await call(env, appRequest("GET", `/search?q=${encodeURIComponent("a,b(c)*d 555")}`, token));
    expect(net.reads("crm_contacts")[0].url.searchParams.get("or")).toBe("(name.ilike.*a b c d 555*,phone_digits.like.*555*)");
  });

  it("lists teammates with phone access and their identity base", async () => {
    const { net, token, env } = await setup(callerCtx());
    net.rest("GET", "client_users", () => [
      { user_id: USER_A, full_name: "Avery", role: "owner", title: "owner", access: {} },
      { user_id: USER_B, full_name: "Blake", role: "user", title: "crew_member", access: {} },
    ]);
    net.rest("GET", "phone_user_settings", () => [{ user_id: USER_A, device_generation: 2 }]);
    const { json } = await call(env, appRequest("GET", "/team", token));
    // Owners are always edit; a crew member has no phone access.
    expect(json.members).toEqual([{ user_id: USER_A, full_name: "Avery", identity_base: `u_${USER_A.replace(/-/g, "")}_g2` }]);
  });
});
