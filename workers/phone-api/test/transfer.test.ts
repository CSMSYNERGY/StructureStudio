import { describe, expect, it } from "vitest";
import {
  Auth, BUSINESS_NUMBER, CALL_SID, CLIENT, CUSTOMER, FakeNet, NUMBER_ID, USER_A, USER_B,
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
    expect(attr(xml, "Dial", "action")).toBe(`https://phone.example.test/voice/after-dial?call=${CALL_ID}&transfer=1&key=test-webhook-key`);
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
