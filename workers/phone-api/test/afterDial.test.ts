// Every branch of /voice/after-dial, in plan section 8's order.
import { describe, expect, it } from "vitest";
import {
  BUSINESS_NUMBER, CALL_SID, CLIENT, CUSTOMER, FakeNet, NUMBER_ID, USER_A, USER_B, USER_C,
  attr, call, clientsIn, filter, makeEnv, member, numbersIn, routeInfo, twilioPost,
} from "./helpers";

const CALL_ID = "00000000-0000-4000-8000-0000000ca111";
const id = (u: string) => `u_${u.replace(/-/g, "")}_g1`;

function row(over: Record<string, unknown> = {}) {
  return {
    id: CALL_ID, client_id: CLIENT, number_id: NUMBER_ID, contact_id: null, direction: "in",
    from_e164: CUSTOMER, to_e164: BUSINESS_NUMBER, twilio_call_sid: CALL_SID, client_call_sid: null,
    placed_by: null, answered_by: null, rang_user_ids: [USER_A], transferred_from: null, transfer_state: null,
    status: "ringing", started_at: new Date().toISOString(), answered_at: null, ended_at: null,
    duration_s: null, error_code: null, is_emergency: false, ...over,
  };
}

function setup(callRow: unknown, info: unknown = routeInfo()) {
  const net = new FakeNet().install();
  net.rest("GET", "phone_calls", () => (callRow ? [callRow] : []));
  net.rpc("phone_route_for_number", () => info);
  net.rest("PATCH", "phone_calls", () => [{ id: CALL_ID }]);
  net.rest("GET", "phone_user_settings", () => []);
  net.rest("POST", "app_errors", () => []);
  return net;
}

async function afterDial(query: Record<string, string>, params: Record<string, string>) {
  const env = makeEnv();
  return call(env, await twilioPost(env, "/voice/after-dial", {
    CallSid: CALL_SID, From: CUSTOMER, To: BUSINESS_NUMBER, Direction: "inbound", ...params,
  }, { call: CALL_ID, ...query }));
}

const patches = (net: FakeNet) => net.writes("phone_calls", "PATCH").map((s) => s.json);

describe("/voice/after-dial", () => {
  it("1. the original Dial ending because of a transfer redirect: empty response, nothing changed", async () => {
    const net = setup(row({ transfer_state: "transferring", status: "in_progress", answered_by: null }));
    const { text } = await afterDial({}, { DialCallStatus: "completed", DialBridged: "true" });
    expect(text).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    expect(patches(net)).toEqual([]);
  });

  it("2. someone talked to the customer (DialBridged): hang up cleanly, no voicemail", async () => {
    const net = setup(row({ status: "in_progress", answered_by: USER_A }));
    const { text } = await afterDial({}, { DialCallStatus: "completed", DialBridged: "true" });
    expect(text).toContain("<Hangup/>");
    expect(text).not.toContain("<Record");
    expect(patches(net)).toEqual([]);
  });

  it("2. a bridged transfer clears transfer_state", async () => {
    const net = setup(row({ transfer_state: "transferring" }));
    const { text } = await afterDial({ transfer: "1" }, { DialCallStatus: "completed", DialBridged: "true" });
    expect(text).toContain("<Hangup/>");
    expect(patches(net)).toEqual([{ transfer_state: null }]);
  });

  it("2. goes by DialBridged, not DialCallStatus: a screened cell that hung up without pressing 1 is NOT answered", async () => {
    setup(row());
    const { text } = await afterDial({ stage: "fwd" }, { DialCallStatus: "completed", DialBridged: "false" });
    expect(text).toContain("<Record");
  });

  it("3. within 60 minutes of a 911 call: never voicemail, ring that person again", async () => {
    setup(row(), routeInfo({ recent_emergency_user: USER_B, members: [member(USER_A), member(USER_B, { dnd: true })] }));
    const { text } = await afterDial({ stage: "er", n: "1" }, { DialCallStatus: "no-answer", DialBridged: "false" });
    expect(clientsIn(text)).toEqual([id(USER_B)]);
    expect(attr(text, "Dial", "action")).toMatch(/stage=er&n=2/);
    expect(text).not.toContain("<Record");
  });

  it("3. gives up after 10 rounds with a message, still never voicemail", async () => {
    setup(row(), routeInfo({ recent_emergency_user: USER_B }));
    const { text } = await afterDial({ stage: "er", n: "10" }, { DialCallStatus: "no-answer", DialBridged: "false" });
    expect(text).toContain("We could not reach anyone");
    expect(text).not.toContain("<Record");
  });

  it.each(["no-answer", "busy", "failed", "canceled"])("4. %s goes to the greeting and voicemail", async (status) => {
    setup(row());
    const { text } = await afterDial({}, { DialCallStatus: status, DialBridged: "false" });
    expect(text).toContain("You've reached Demo Sheds.");
    expect(attr(text, "Record", "action")).toContain(`/voice/voicemail?call=${CALL_ID}`);
  });

  it("4. forwards (screened) when the route says so; the forward's own action ends in voicemail", async () => {
    setup(row(), routeInfo({}, { no_answer: "forward", forward_to: "+15555550166" }));
    const { text } = await afterDial({}, { DialCallStatus: "no-answer", DialBridged: "false" });
    expect(numbersIn(text)).toEqual(["+15555550166"]);
    expect(attr(text, "Number", "url")).toMatch(/\/voice\/screen\?call=/);
    expect(attr(text, "Dial", "action")).toMatch(/stage=fwd/);

    setup(row(), routeInfo({}, { no_answer: "forward", forward_to: "+15555550166" }));
    const second = await afterDial({ stage: "fwd" }, { DialCallStatus: "no-answer", DialBridged: "false" });
    expect(second.text).toContain("<Record");
    expect(numbersIn(second.text)).toEqual([]);
  });

  it("4. in_order chains to the next available member, and records who was rung", async () => {
    const net = setup(row({ rang_user_ids: [USER_A] }), routeInfo({ members: [member(USER_A), member(USER_B, { dnd: true }), member(USER_C)] }, { mode: "in_order" }));
    const { text } = await afterDial({ stage: "order", p: "0" }, { DialCallStatus: "no-answer", DialBridged: "false" });
    expect(clientsIn(text)).toEqual([id(USER_C)]);
    expect(attr(text, "Dial", "action")).toMatch(/stage=order&p=2/);
    expect(patches(net)).toEqual([{ rang_user_ids: [USER_A, USER_C] }]);
  });

  it("4. in_order with nobody left goes to voicemail", async () => {
    setup(row(), routeInfo({}, { mode: "in_order" }));
    const { text } = await afterDial({ stage: "order", p: "2" }, { DialCallStatus: "no-answer", DialBridged: "false" });
    expect(text).toContain("<Record");
  });

  it("4. a transfer nobody took: clears transfer_state and goes to voicemail, never back to the team", async () => {
    const net = setup(row({ transfer_state: "transferring", status: "in_progress", transferred_from: USER_A }), routeInfo({}, { mode: "in_order" }));
    const { text } = await afterDial({ transfer: "1" }, { DialCallStatus: "no-answer", DialBridged: "false" });
    expect(text).toContain("<Record");
    expect(clientsIn(text)).toEqual([]);
    expect(patches(net)).toEqual([{ transfer_state: null }]);
  });

  it("routes a transferred OUTBOUND call by its caller-ID number", async () => {
    const net = setup(row({ direction: "out", from_e164: BUSINESS_NUMBER, to_e164: CUSTOMER, transfer_state: "transferring" }));
    const { text } = await afterDial({ transfer: "1" }, {
      From: BUSINESS_NUMBER, To: CUSTOMER, Direction: "outbound-dial", DialCallStatus: "no-answer", DialBridged: "false",
    });
    expect(text).toContain("<Record");
    expect(net.rpcCalls("phone_route_for_number")[0].json).toEqual({ p_e164: BUSINESS_NUMBER });
    expect(filter(net.reads("phone_calls")[0], "id")).toBe(CALL_ID);
  });
});
