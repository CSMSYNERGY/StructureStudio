// Every branch of /voice/after-dial, in plan section 8's order.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  // Migration 264: a cover rang in an away member's place (p = that member's position).
  const COVER = "00000000-0000-4000-8000-0000000000e5";
  const coverRow = member(COVER, { cover_only: true });

  it("4. in_order carries on past a cover's place to the next member, and records them", async () => {
    const info = routeInfo({ members: [member(USER_A, { dnd: true, dnd_cover: COVER }), member(USER_B), member(USER_C), coverRow] }, { mode: "in_order" });
    const net = setup(row({ rang_user_ids: [COVER] }), info);
    const { text } = await afterDial({ stage: "order", p: "0" }, { DialCallStatus: "no-answer", DialBridged: "false" });
    expect(clientsIn(text)).toEqual([id(USER_B)]);
    expect(attr(text, "Dial", "action")).toMatch(/stage=order&p=1/);
    expect(patches(net)).toEqual([{ rang_user_ids: [COVER, USER_B] }]);
  });

  it("4. in_order reaches a later away member's cover in that member's place", async () => {
    const info = routeInfo({ members: [member(USER_A), member(USER_B, { dnd: true, dnd_cover: COVER }), member(USER_C), coverRow] }, { mode: "in_order" });
    const net = setup(row({ rang_user_ids: [USER_A] }), info);
    const { text } = await afterDial({ stage: "order", p: "0" }, { DialCallStatus: "no-answer", DialBridged: "false" });
    expect(clientsIn(text)).toEqual([id(COVER)]);
    expect(attr(text, "Dial", "action")).toMatch(/stage=order&p=1/);
    expect(patches(net)).toEqual([{ rang_user_ids: [USER_A, COVER] }]);
  });

  it("4. in_order never rings one cover twice for two away members: after them, voicemail", async () => {
    const info = routeInfo({
      members: [member(USER_A, { dnd: true, dnd_cover: COVER }), member(USER_B, { dnd: true, dnd_cover: COVER }), coverRow],
    }, { mode: "in_order", members: [USER_A, USER_B] });
    setup(row({ rang_user_ids: [COVER] }), info);
    const { text } = await afterDial({ stage: "order", p: "0" }, { DialCallStatus: "no-answer", DialBridged: "false" });
    expect(clientsIn(text)).toEqual([]);
    expect(text).toContain("<Record");
  });

  // Migration 264: outside their own hours is away, like DND, when after-dial picks the next place.
  describe("someone outside their own hours", () => {
    const outsideHours = { ring_hours: { tue: [["13:00", "17:00"]] }, hours_tz: "America/Chicago" };
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-29T15:00:00Z")); // Tuesday 10:00 in Chicago
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("4. in_order passes over them to the next member, and records who rang", async () => {
      const info = routeInfo({ members: [member(USER_A), member(USER_B, outsideHours), member(USER_C)] }, { mode: "in_order" });
      const net = setup(row({ rang_user_ids: [USER_A] }), info);
      const { text } = await afterDial({ stage: "order", p: "0" }, { DialCallStatus: "no-answer", DialBridged: "false" });
      expect(clientsIn(text)).toEqual([id(USER_C)]);
      expect(attr(text, "Dial", "action")).toMatch(/stage=order&p=2/);
      expect(patches(net)).toEqual([{ rang_user_ids: [USER_A, USER_C] }]);
    });

    it("4. in_order rings their cover in their place", async () => {
      const info = routeInfo({ members: [member(USER_A), member(USER_B, { ...outsideHours, dnd_cover: COVER }), member(USER_C), coverRow] }, { mode: "in_order" });
      const net = setup(row({ rang_user_ids: [USER_A] }), info);
      const { text } = await afterDial({ stage: "order", p: "0" }, { DialCallStatus: "no-answer", DialBridged: "false" });
      expect(clientsIn(text)).toEqual([id(COVER)]);
      expect(attr(text, "Dial", "action")).toMatch(/stage=order&p=1/);
      expect(patches(net)).toEqual([{ rang_user_ids: [USER_A, COVER] }]);
    });

    it("4. nobody else left: the route's no-answer forward, as before", async () => {
      const info = routeInfo({ members: [member(USER_A), member(USER_B, outsideHours)] }, {
        mode: "in_order", members: [USER_A, USER_B], no_answer: "forward", forward_to: "+15555550166",
      });
      setup(row({ rang_user_ids: [USER_A] }), info);
      const { text } = await afterDial({ stage: "order", p: "0" }, { DialCallStatus: "no-answer", DialBridged: "false" });
      expect(clientsIn(text)).toEqual([]);
      expect(numbersIn(text)).toEqual(["+15555550166"]);
    });
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

  // Migration 264: a transfer's voicemail is the teammate's (`vt`): their own greeting plays.
  describe("4. a transfer nobody took plays the teammate's own greeting (vt)", () => {
    const SID = "RE" + "0".repeat(31) + "e";
    const LINE_SID = "RE" + "0".repeat(31) + "f";
    const transferred = () => row({ transfer_state: "transferring", status: "in_progress", transferred_from: USER_A });
    const own = (u: string, sid: string) => `<Play>https://phone.example.test/voice/greeting-audio?u=${u}&amp;v=${sid}&amp;key=test-webhook-key</Play>`;

    it("the teammate's greeting, read from their own row, over the number's link and the line owner's", async () => {
      const net = setup(transferred(), routeInfo({ members: [member(USER_A, { greeting_sid: LINE_SID })] }, { members: [USER_A], greeting_url: "https://cdn.example.test/g.mp3" }));
      net.rest("GET", "phone_user_settings", (s) => (filter(s, "user_id") === USER_B ? [{ client_id: CLIENT, greeting_recording_sid: SID }] : []));
      const { text } = await afterDial({ transfer: "1", vt: USER_B }, { DialCallStatus: "no-answer", DialBridged: "false" });
      expect(text).toContain(own(USER_B, SID));
      expect(text).toContain("<Record");
      expect(net.reads("phone_user_settings").map((r) => filter(r, "user_id"))).toEqual([USER_B]);
    });

    it("a teammate with no greeting: the number's link, never the line owner's greeting", async () => {
      const net = setup(transferred(), routeInfo({ members: [member(USER_A, { greeting_sid: LINE_SID })] }, { members: [USER_A], greeting_url: "https://cdn.example.test/g.mp3" }));
      net.rest("GET", "phone_user_settings", () => [{ client_id: CLIENT, greeting_recording_sid: null }]);
      const { text } = await afterDial({ transfer: "1", vt: USER_B }, { DialCallStatus: "no-answer", DialBridged: "false" });
      expect(text).toContain("<Play>https://cdn.example.test/g.mp3</Play>");
      expect(text).not.toContain("greeting-audio");
    });

    it("someone on another business, an after-dial URL without vt, or a failed read: nobody's greeting", async () => {
      const info = routeInfo({ members: [member(USER_A, { greeting_sid: LINE_SID })] }, { members: [USER_A] });
      let net = setup(transferred(), info);
      net.rest("GET", "phone_user_settings", () => [{ client_id: "other-tenant", greeting_recording_sid: SID }]);
      expect((await afterDial({ transfer: "1", vt: USER_B }, { DialCallStatus: "no-answer", DialBridged: "false" })).text).not.toContain("greeting-audio");
      net = setup(transferred(), info);
      const old = await afterDial({ transfer: "1" }, { DialCallStatus: "no-answer", DialBridged: "false" });
      expect(old.text).not.toContain("greeting-audio");
      expect(old.text).toContain("You've reached Demo Sheds.");
      expect(net.reads("phone_user_settings")).toEqual([]);
      net = setup(transferred(), info);
      net.rest("GET", "phone_user_settings", () => new Response(JSON.stringify({ message: "boom" }), { status: 500 }));
      const failed = await afterDial({ transfer: "1", vt: USER_B }, { DialCallStatus: "no-answer", DialBridged: "false" });
      expect(failed.text).toContain("<Record");
      expect(failed.text).not.toContain("greeting-audio");
    });

    it("a plain call nobody answered on a one-person line plays that person's greeting (no vt read)", async () => {
      const net = setup(row(), routeInfo({ members: [member(USER_A, { greeting_sid: LINE_SID })] }, { members: [USER_A] }));
      const { text } = await afterDial({}, { DialCallStatus: "no-answer", DialBridged: "false" });
      expect(text).toContain(own(USER_A, LINE_SID));
      expect(net.reads("phone_user_settings")).toEqual([]);
    });
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
