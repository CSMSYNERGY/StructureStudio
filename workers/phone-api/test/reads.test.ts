import { describe, expect, it } from "vitest";
import {
  Auth, BUSINESS_NUMBER, CLIENT, CONTACT_1, CONTACT_2, CUSTOMER, FakeNet, USER_A, USER_B, USER_C,
  appRequest, call, callerCtx, eventRows, filter, jsonRes, makeEnv,
} from "./helpers";

const T = (min: number) => new Date(Date.UTC(2026, 8, 29, 12, 0) - min * 60_000).toISOString();

function callRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id, client_id: CLIENT, number_id: null, contact_id: null, direction: "in", from_e164: CUSTOMER, to_e164: BUSINESS_NUMBER,
    twilio_call_sid: null, client_call_sid: null, placed_by: null, answered_by: null, rang_user_ids: [],
    transferred_from: null, transfer_state: null, status: "completed", started_at: T(1), answered_at: null, ended_at: null,
    duration_s: 30, error_code: null, is_emergency: false, crm_contacts: null, phone_voicemails: null, ...over,
  };
}

async function setup(ctx: Record<string, unknown>, visible: string[] | null = null) {
  const net = new FakeNet().install();
  const auth = await new Auth().init();
  auth.serve(net);
  net.rpc("phone_caller_context", () => ctx);
  net.rpc("crm_visible_contact_ids", (s) => (visible ?? s.json.p_ids));
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
