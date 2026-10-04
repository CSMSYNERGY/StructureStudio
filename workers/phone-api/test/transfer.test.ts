import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Auth, BUSINESS_NUMBER, CALL_SID, CLIENT, CUSTOMER, FakeNet, NUMBER_ID, USER_A, USER_B, USER_C,
  appRequest, attr, call, callerCtx, clientsIn, filter, jsonRes, makeEnv, routeInfo,
} from "./helpers";

const CALL_ID = "00000000-0000-4000-8000-0000000ca333";
const MY_LEG = "CA" + "0".repeat(31) + "5";

function liveCall(over: Record<string, unknown> = {}) {
  return {
    id: CALL_ID, client_id: CLIENT, number_id: NUMBER_ID, contact_id: null, direction: "in",
    from_e164: CUSTOMER, to_e164: BUSINESS_NUMBER, twilio_call_sid: CALL_SID, client_call_sid: MY_LEG,
    placed_by: null, answered_by: USER_A, rang_user_ids: [USER_A], transferred_from: null, transfer_state: null,
    status: "in_progress", started_at: new Date().toISOString(), answered_at: new Date().toISOString(), ended_at: null,
    duration_s: null, error_code: null, is_emergency: false, ...over,
  };
}

async function setup(opts: { call?: unknown; target?: unknown; targetSettings?: unknown[]; twilioStatus?: number; claimed?: boolean } = {}) {
  const net = new FakeNet().install();
  const auth = await new Auth().init();
  auth.serve(net);
  const env = makeEnv();
  const order: string[] = [];
  net.rpc("phone_caller_context", (s) => (s.json.p_user_id === USER_A ? callerCtx() : (opts.target === undefined ? callerCtx({ device_generation: 5 }) : opts.target)));
  net.rest("GET", "phone_calls", () => [opts.call ?? liveCall()]);
  net.rest("GET", "phone_user_settings", () => opts.targetSettings ?? []);
  net.rpc("phone_route_for_number", () => routeInfo());
  net.rest("PATCH", "phone_calls", (s) => {
    order.push(s.json.transfer_state === "transferring" ? "mark" : "restore");
    return opts.claimed === false ? [] : [{ id: CALL_ID }];
  });
  net.rest("POST", "phone_call_events", () => []);
  net.rest("POST", "app_errors", () => []);
  net.on("POST", /api\.twilio\.com\/2010-04-01\/Accounts\/AC0+\/Calls\/CA0+\d\.json$/, (s) => {
    const sid = s.url.pathname.split("/").pop()!.replace(".json", "");
    order.push(sid === CALL_SID ? "redirect-customer" : "end-my-leg");
    if (sid === CALL_SID && opts.twilioStatus) return jsonRes({ code: 21220 }, opts.twilioStatus);
    return jsonRes({ sid });
  });
  return { net, auth, env, order };
}

describe("POST /calls/:id/transfer", () => {
  it("marks the call, redirects the CUSTOMER's leg to a 20 s Dial to the teammate, and only then ends your leg", async () => {
    const { net, auth, env, order } = await setup();
    const { res, json } = await call(env, appRequest("POST", `/calls/${CALL_ID}/transfer`, await auth.token(USER_A), { to_user_id: USER_B }));
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true });
    expect(order).toEqual(["mark", "redirect-customer", "end-my-leg"]);

    const mark = net.writes("phone_calls", "PATCH")[0];
    expect(mark.json).toMatchObject({ transfer_state: "transferring", transferred_from: USER_A, answered_by: null, client_call_sid: null, rang_user_ids: [USER_A, USER_B] });
    expect(mark.url.search).toContain("transfer_state=is.null"); // two presses cannot both win

    const redirect = net.to(new RegExp(`Calls/${CALL_SID}\\.json$`))[0];
    const xml = new URLSearchParams(redirect.body).get("Twiml")!;
    expect(attr(xml, "Dial", "timeout")).toBe("20");
    expect(attr(xml, "Dial", "action")).toBe(`https://phone.example.test/voice/after-dial?call=${CALL_ID}&transfer=1&vt=${USER_B}&key=test-webhook-key`);
    expect(clientsIn(xml)).toEqual([`u_${USER_B.replace(/-/g, "")}_g5`]);
    expect(xml).not.toContain("<Number"); // never the teammate's personal cell

    const end = net.to(new RegExp(`Calls/${MY_LEG}\\.json$`))[0];
    expect(new URLSearchParams(end.body).get("Status")).toBe("completed");
  });

  it("if the redirect fails, puts the row back and leaves you on the call", async () => {
    const { net, auth, env, order } = await setup({ twilioStatus: 400 });
    const { res, json } = await call(env, appRequest("POST", `/calls/${CALL_ID}/transfer`, await auth.token(USER_A), { to_user_id: USER_B }));
    expect(res.status).toBe(502);
    expect(json.error).toEqual({ code: "twilio_error", message: "The transfer didn't go through. You're still on the call." });
    expect(order).toEqual(["mark", "redirect-customer", "restore"]);
    expect(net.writes("phone_calls", "PATCH")[1].json).toMatchObject({ transfer_state: null, answered_by: USER_A, client_call_sid: MY_LEG });
  });

  it("a teammate on DND is not rung: the customer goes straight to voicemail", async () => {
    const { net, auth, env } = await setup({ targetSettings: [{ dnd: true, dnd_until: null }] });
    await call(env, appRequest("POST", `/calls/${CALL_ID}/transfer`, await auth.token(USER_A), { to_user_id: USER_B }));
    const xml = new URLSearchParams(net.to(new RegExp(`Calls/${CALL_SID}\\.json$`))[0].body).get("Twiml")!;
    expect(xml).toContain("<Record");
    expect(xml).not.toContain("<Dial");
  });

  it("the voicemail a teammate on DND gets is theirs: their own greeting plays when they recorded one (migration 264)", async () => {
    const SID = "RE" + "0".repeat(31) + "b";
    const { net, auth, env } = await setup({ targetSettings: [{ dnd: true, dnd_until: null, greeting_recording_sid: SID }] });
    await call(env, appRequest("POST", `/calls/${CALL_ID}/transfer`, await auth.token(USER_A), { to_user_id: USER_B }));
    const xml = new URLSearchParams(net.to(new RegExp(`Calls/${CALL_SID}\\.json$`))[0].body).get("Twiml")!;
    expect(xml).toContain(`<Play>https://phone.example.test/voice/greeting-audio?u=${USER_B}&amp;v=${SID}&amp;key=test-webhook-key</Play>`);
    expect(xml).toContain("<Record");
    expect(net.reads("phone_user_settings")[0].url.searchParams.get("select")).toContain("greeting_recording_sid");
    // No greeting of their own: the number's (here the standard sentence), never anyone else's.
    const plain = await setup({ targetSettings: [{ dnd: true, dnd_until: null, greeting_recording_sid: null }] });
    await call(plain.env, appRequest("POST", `/calls/${CALL_ID}/transfer`, await plain.auth.token(USER_A), { to_user_id: USER_B }));
    const plainXml = new URLSearchParams(plain.net.to(new RegExp(`Calls/${CALL_SID}\\.json$`))[0].body).get("Twiml")!;
    expect(plainXml).not.toContain("greeting-audio");
    expect(plainXml).toContain("You've reached Demo Sheds.");
  });

  // Migration 264: a teammate on DND who chose a cover hands the transfer to them.
  describe("to a teammate on DND with a cover", () => {
    async function coverSetup(cover: { ctx?: unknown; settings?: unknown[]; id?: string } = {}) {
      const s = await setup();
      const coverId = cover.id ?? USER_C;
      s.net.rpc("phone_caller_context", (q) => {
        if (q.json.p_user_id === USER_A) return callerCtx();
        if (q.json.p_user_id === USER_B) return callerCtx({ device_generation: 5 });
        return cover.ctx === undefined ? callerCtx({ device_generation: 7 }) : cover.ctx;
      });
      s.net.rest("GET", "phone_user_settings", (q) => (filter(q, "user_id") === USER_B
        ? [{ dnd: true, dnd_until: null, dnd_cover_user_id: coverId }]
        : cover.settings ?? []));
      return s;
    }
    const redirectXml = (net: FakeNet) => new URLSearchParams(net.to(new RegExp(`Calls/${CALL_SID}\\.json$`))[0].body).get("Twiml")!;
    const identityOf = (u: string, g: number) => `u_${u.replace(/-/g, "")}_g${g}`;

    it("rings the cover instead, with transfer=1 as the safety net, and records both", async () => {
      const { net, auth, env, order } = await coverSetup();
      const { res } = await call(env, appRequest("POST", `/calls/${CALL_ID}/transfer`, await auth.token(USER_A), { to_user_id: USER_B }));
      expect(res.status).toBe(200);
      expect(order).toEqual(["mark", "redirect-customer", "end-my-leg"]);
      const xml = redirectXml(net);
      expect(clientsIn(xml)).toEqual([identityOf(USER_C, 7)]);
      expect(attr(xml, "Dial", "timeout")).toBe("20");
      expect(attr(xml, "Dial", "action")).toBe(`https://phone.example.test/voice/after-dial?call=${CALL_ID}&transfer=1&vt=${USER_B}&key=test-webhook-key`);
      expect(xml).toContain(`<Parameter name="transferred_by" value="${USER_A}"/>`);
      expect(xml).not.toContain("<Number"); // never anyone's personal cell
      expect(xml).not.toContain("<Record");
      expect(net.writes("phone_calls", "PATCH")[0].json.rang_user_ids).toEqual([USER_A, USER_B, USER_C]);
      expect(net.writes("phone_call_events")[0].json).toMatchObject({ type: "transfer", data: { from: USER_A, to: USER_B, dnd: true, cover: USER_C } });
      // The cover's own settings were read, to see they aren't on DND too.
      expect(net.reads("phone_user_settings").map((r) => filter(r, "user_id"))).toEqual([USER_B, USER_C]);
    });

    it.each([
      ["is on DND too", { settings: [{ dnd: true, dnd_until: null }] }],
      ["is on another business", { ctx: callerCtx({ client_id: "other-tenant" }) }],
      ["has no phone access", { ctx: callerCtx({ phone_level: "none" }) }],
      ["is on no team any more", { ctx: null }],
      ["is the person handing the call on", { id: USER_A }],
    ])("goes to voicemail when the cover %s, as with no cover", async (_l, cover) => {
      const { net, auth, env } = await coverSetup(cover as { ctx?: unknown; settings?: unknown[]; id?: string });
      const { res } = await call(env, appRequest("POST", `/calls/${CALL_ID}/transfer`, await auth.token(USER_A), { to_user_id: USER_B }));
      expect(res.status).toBe(200);
      const xml = redirectXml(net);
      expect(xml).toContain("<Record");
      expect(xml).not.toContain("<Dial");
      expect(net.writes("phone_calls", "PATCH")[0].json.rang_user_ids).toEqual([USER_A, USER_B]);
      expect(net.writes("phone_call_events")[0].json.data).toMatchObject({ to: USER_B, dnd: true, cover: null });
    });

    it("a cover whose DND has run out takes it", async () => {
      const { net, auth, env } = await coverSetup({ settings: [{ dnd: true, dnd_until: "2000-01-01T00:00:00Z" }] });
      await call(env, appRequest("POST", `/calls/${CALL_ID}/transfer`, await auth.token(USER_A), { to_user_id: USER_B }));
      expect(clientsIn(redirectXml(net))).toEqual([identityOf(USER_C, 7)]);
    });

    it("a teammate who is NOT on DND is rung themselves; their cover is never asked about", async () => {
      const { net, auth, env } = await coverSetup();
      net.rest("GET", "phone_user_settings", () => [{ dnd: false, dnd_until: null, dnd_cover_user_id: USER_C }]);
      await call(env, appRequest("POST", `/calls/${CALL_ID}/transfer`, await auth.token(USER_A), { to_user_id: USER_B }));
      expect(clientsIn(redirectXml(net))).toEqual([identityOf(USER_B, 5)]);
      expect(net.rpcCalls("phone_caller_context").map((r) => r.json.p_user_id)).not.toContain(USER_C);
    });
  });

  // Migration 264: outside their own hours is away, exactly like DND: their cover, or voicemail.
  describe("to a teammate outside their own hours", () => {
    const OUTSIDE = { ring_hours: { tue: [["13:00", "17:00"]] }, ring_hours_tz: "America/Chicago" };
    const INSIDE = { ring_hours: { tue: [["08:00", "17:00"]] }, ring_hours_tz: "America/Chicago" };
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-29T15:00:00Z")); // Tuesday 10:00 in Chicago, 11:00 in New York
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    async function hoursSetup(target: Record<string, unknown>, cover: Record<string, unknown> = {}, route: unknown = routeInfo()) {
      const s = await setup();
      s.net.rpc("phone_caller_context", (q) => {
        if (q.json.p_user_id === USER_A) return callerCtx();
        if (q.json.p_user_id === USER_B) return callerCtx({ device_generation: 5 });
        return callerCtx({ device_generation: 7 });
      });
      s.net.rest("GET", "phone_user_settings", (q) => (filter(q, "user_id") === USER_B
        ? [{ dnd: false, dnd_until: null, dnd_cover_user_id: null, ...target }]
        : [{ dnd: false, dnd_until: null, ...cover }]));
      s.net.rpc("phone_route_for_number", () => route);
      return s;
    }
    const redirectXml = (net: FakeNet) => new URLSearchParams(net.to(new RegExp(`Calls/${CALL_SID}\\.json$`))[0].body).get("Twiml")!;
    const transferTo = async (s: Awaited<ReturnType<typeof hoursSetup>>) =>
      call(s.env, appRequest("POST", `/calls/${CALL_ID}/transfer`, await s.auth.token(USER_A), { to_user_id: USER_B }));

    it("with no cover: not rung, straight to voicemail, and the event says why", async () => {
      const s = await hoursSetup(OUTSIDE);
      const { res } = await transferTo(s);
      expect(res.status).toBe(200);
      const xml = redirectXml(s.net);
      expect(xml).toContain("<Record");
      expect(xml).not.toContain("<Dial");
      expect(s.net.writes("phone_call_events")[0].json.data).toEqual({ from: USER_A, to: USER_B, dnd: false, off_hours: true, cover: null });
      expect(s.net.reads("phone_user_settings")[0].url.searchParams.get("select")).toContain("ring_hours_tz");
    });

    it("with a cover inside their own hours: the cover rings, with transfer=1", async () => {
      const s = await hoursSetup({ ...OUTSIDE, dnd_cover_user_id: USER_C }, INSIDE);
      await transferTo(s);
      const xml = redirectXml(s.net);
      expect(clientsIn(xml)).toEqual([`u_${USER_C.replace(/-/g, "")}_g7`]);
      expect(attr(xml, "Dial", "action")).toBe(`https://phone.example.test/voice/after-dial?call=${CALL_ID}&transfer=1&vt=${USER_B}&key=test-webhook-key`);
      expect(s.net.writes("phone_calls", "PATCH")[0].json.rang_user_ids).toEqual([USER_A, USER_B, USER_C]);
      expect(s.net.writes("phone_call_events")[0].json.data).toMatchObject({ dnd: false, off_hours: true, cover: USER_C });
    });

    it("a cover outside THEIR own hours isn't rung either: voicemail", async () => {
      const s = await hoursSetup({ ...OUTSIDE, dnd_cover_user_id: USER_C }, OUTSIDE);
      await transferTo(s);
      expect(redirectXml(s.net)).toContain("<Record");
      expect(s.net.writes("phone_call_events")[0].json.data).toMatchObject({ off_hours: true, cover: null });
    });

    it("inside their hours: they ring themselves, and the cover is never asked about", async () => {
      const s = await hoursSetup({ ...INSIDE, dnd_cover_user_id: USER_C });
      await transferTo(s);
      expect(clientsIn(redirectXml(s.net))).toEqual([`u_${USER_B.replace(/-/g, "")}_g5`]);
      expect(s.net.rpcCalls("phone_caller_context").map((r) => r.json.p_user_id)).not.toContain(USER_C);
      expect(s.net.writes("phone_call_events")[0].json.data).toMatchObject({ dnd: false, off_hours: false, cover: null });
    });

    it("hours saved with no zone are read in the number's zone", async () => {
      // 10:30 to 5: inside at 11:00 in New York (the number's), outside at 10:00 in Chicago.
      const s = await hoursSetup({ ring_hours: { tue: [["10:30", "17:00"]] }, ring_hours_tz: null }, {}, routeInfo({}, { time_zone: "America/New_York" }));
      await transferTo(s);
      expect(clientsIn(redirectXml(s.net))).toEqual([`u_${USER_B.replace(/-/g, "")}_g5`]);
    });
  });

  it("transfers an outbound call by redirecting the customer's (child) leg", async () => {
    const { net, auth, env } = await setup({
      call: liveCall({ direction: "out", from_e164: BUSINESS_NUMBER, to_e164: CUSTOMER, placed_by: USER_A, answered_by: null }),
    });
    const { res } = await call(env, appRequest("POST", `/calls/${MY_LEG}/transfer`, await auth.token(USER_A), { to_user_id: USER_B }));
    expect(res.status).toBe(200);
    // Looked up by the app leg's CallSid, which is all an outbound caller knows.
    expect(net.reads("phone_calls")[0].url.searchParams.get("or")).toContain(`client_call_sid.eq.${MY_LEG}`);
    expect(net.to(new RegExp(`Calls/${CALL_SID}\\.json$`))).toHaveLength(1);
  });

  it.each([
    ["a teammate on another tenant", { target: callerCtx({ client_id: "other-tenant" }) }, 404, "not_found"],
    ["a teammate without phone access", { target: callerCtx({ phone_level: "none" }) }, 404, "not_found"],
    ["a call someone else answered", { call: liveCall({ answered_by: USER_B }) }, 404, "not_found"],
    ["a call that already ended", { call: liveCall({ status: "completed", ended_at: new Date().toISOString() }) }, 400, "bad_request"],
    ["a transfer already under way", { call: liveCall({ transfer_state: "transferring" }) }, 400, "bad_request"],
  ])("refuses %s", async (_l, opts, status, code) => {
    const { net, auth, env } = await setup(opts);
    const { res, json } = await call(env, appRequest("POST", `/calls/${CALL_ID}/transfer`, await auth.token(USER_A), { to_user_id: USER_B }));
    expect(res.status).toBe(status);
    expect(json.error.code).toBe(code);
    expect(net.to(/api\.twilio\.com/)).toEqual([]);
  });

  it("scopes the call lookup to the caller's tenant", async () => {
    const { net, auth, env } = await setup();
    await call(env, appRequest("POST", `/calls/${CALL_ID}/transfer`, await auth.token(USER_A), { to_user_id: USER_B }));
    expect(filter(net.reads("phone_calls")[0], "client_id")).toBe(CLIENT);
  });
});
