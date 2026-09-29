import { describe, expect, it } from "vitest";
import { isOpen } from "../src/hours";
import {
  BUSINESS_NUMBER, CALL_SID, CLIENT, CONTACT_1, CUSTOMER, FakeNet, NUMBER_ID, USER_A, USER_B, USER_C,
  attr, call, clientsIn, filter, makeEnv, member, numbersIn, routeInfo, twilioPost,
} from "./helpers";

const id = (u: string, g = 1) => `u_${u.replace(/-/g, "")}_g${g}`;

function setup(info: unknown, opts: { contacts?: unknown[]; settings?: unknown[] } = {}) {
  const net = new FakeNet().install();
  net.rpc("phone_route_for_number", () => info);
  net.rest("GET", "crm_contacts", () => opts.contacts ?? []);
  net.rest("GET", "phone_user_settings", () => opts.settings ?? []);
  net.rest("POST", "phone_calls", () => []);
  net.rest("POST", "phone_call_events", () => []);
  net.rest("POST", "app_errors", () => []);
  return net;
}

async function ringIn(env = makeEnv()) {
  return call(env, await twilioPost(env, "/voice/inbound", { CallSid: CALL_SID, From: CUSTOMER, To: BUSINESS_NUMBER, Direction: "inbound" }));
}

describe("/voice/inbound routing", () => {
  it("all_at_once rings every available member, each <Client> with a status callback and the call id", async () => {
    const net = setup(routeInfo(), { contacts: [{ id: CONTACT_1 }] });
    const { text } = await ringIn();
    expect(clientsIn(text)).toEqual([id(USER_A), id(USER_B), id(USER_C)]);
    expect(attr(text, "Dial", "timeout")).toBe("20");
    const row = net.writes("phone_calls", "POST")[0].json;
    expect(attr(text, "Dial", "action")).toBe(`https://phone.example.test/voice/after-dial?call=${row.id}&key=test-webhook-key`);
    expect(attr(text, "Client", "statusCallback")).toBe(`https://phone.example.test/voice/status?call=${row.id}&leg=client&key=test-webhook-key`);
    expect(attr(text, "Client", "statusCallbackEvent")).toBe("initiated ringing answered completed");
    expect(text).toContain(`<Parameter name="call_id" value="${row.id}"/>`);
    expect(row).toMatchObject({
      client_id: CLIENT, number_id: NUMBER_ID, direction: "in", from_e164: CUSTOMER, to_e164: BUSINESS_NUMBER,
      twilio_call_sid: CALL_SID, status: "ringing", rang_user_ids: [USER_A, USER_B, USER_C], contact_id: CONTACT_1,
    });
    // The caller's name comes from phone_digits.
    expect(filter(net.reads("crm_contacts")[0], "phone_digits")).toBe("5555550142");
    expect(net.rpcCalls("phone_route_for_number")[0].json).toEqual({ p_e164: BUSINESS_NUMBER });
  });

  it("drops anyone on DND, busy, or without access; an expired DND rings", async () => {
    setup(routeInfo({
      members: [
        member(USER_A, { dnd: true }),
        member(USER_B, { busy: true }),
        member(USER_C, { has_access: false }),
        member("00000000-0000-4000-8000-0000000000d4", { dnd: true, dnd_until: new Date(Date.now() - 60_000).toISOString() }),
      ],
    }, { members: [USER_A, USER_B, USER_C, "00000000-0000-4000-8000-0000000000d4"] }));
    const { text } = await ringIn();
    expect(clientsIn(text)).toEqual([id("00000000-0000-4000-8000-0000000000d4")]);
  });

  it("goes straight to voicemail with the standard greeting when nobody is available", async () => {
    const net = setup(routeInfo({ members: [member(USER_A, { dnd: true }), member(USER_B, { busy: true })] }));
    const { text } = await ringIn();
    expect(text).not.toContain("<Dial");
    expect(text).toContain("You've reached Demo Sheds. We can't take your call right now. Please leave your name, number and a short message after the tone.");
    const row = net.writes("phone_calls", "POST")[0].json;
    expect(attr(text, "Record", "action")).toBe(`https://phone.example.test/voice/voicemail?call=${row.id}&key=test-webhook-key`);
    expect(attr(text, "Record", "recordingStatusCallback")).toBe(`https://phone.example.test/voice/voicemail?call=${row.id}&cb=status&key=test-webhook-key`);
    expect(text).toMatch(/<\/Say><Record [^>]*\/><Hangup\/><\/Response>$/);
    expect(row.rang_user_ids).toEqual([]);
  });

  it("plays the builder's own greeting when there is one", async () => {
    setup(routeInfo({ members: [] }, { greeting_url: "https://cdn.example.test/greeting.mp3" }));
    const { text } = await ringIn();
    expect(text).toContain("<Play>https://cdn.example.test/greeting.mp3</Play>");
  });

  it("in_order rings one member per Dial and names its position for after-dial", async () => {
    setup(routeInfo({ members: [member(USER_A, { busy: true }), member(USER_B), member(USER_C)] }, { mode: "in_order" }));
    const { text } = await ringIn();
    expect(clientsIn(text)).toEqual([id(USER_B)]);
    expect(attr(text, "Dial", "action")).toMatch(/stage=order&p=1&key=/);
  });

  it("rings a member's cell too, through the press-1 screen, when they forward", async () => {
    setup(routeInfo({ members: [member(USER_A, { forward_to_cell: "+15555550177" })] }, { members: [USER_A] }));
    const { text } = await ringIn();
    expect(clientsIn(text)).toEqual([id(USER_A)]);
    expect(numbersIn(text)).toEqual(["+15555550177"]);
    expect(attr(text, "Number", "url")).toMatch(/\/voice\/screen\?call=[0-9a-f-]+&user=[0-9a-f-]+&b=Demo%20Sheds&key=/);
  });

  it("never puts more than 10 nouns in one Dial", async () => {
    const many = Array.from({ length: 8 }, (_, i) => `00000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`);
    setup(routeInfo({ members: many.map((u) => member(u, { forward_to_cell: "+15555550177" })) }, { members: many }));
    const { text } = await ringIn();
    expect(clientsIn(text).length + numbersIn(text).length).toBe(10);
  });

  it("after hours goes to voicemail, or to the forward number when the route says so", async () => {
    const closed = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
    setup(routeInfo({}, { business_hours: closed }));
    expect((await ringIn()).text).toContain("<Record");
    setup(routeInfo({}, { business_hours: closed, after_hours: "forward", forward_to: "+15555550166" }));
    const fwd = (await ringIn()).text;
    expect(numbersIn(fwd)).toEqual(["+15555550166"]);
    expect(attr(fwd, "Dial", "action")).toMatch(/stage=fwd/);
    expect(attr(fwd, "Number", "url")).toMatch(/\/voice\/screen\?/);
  });

  it("within 60 minutes of a 911 call rings ONLY that person, ignoring DND and busy", async () => {
    setup(routeInfo({
      recent_emergency_user: USER_B,
      members: [member(USER_A), member(USER_B, { dnd: true, busy: true })],
    }));
    const { text } = await ringIn();
    expect(clientsIn(text)).toEqual([id(USER_B)]);
    expect(attr(text, "Dial", "action")).toMatch(/stage=er&n=1/);
  });

  it("the 911 callback reaches someone who is not a route member, at their current generation", async () => {
    const net = setup(routeInfo({ recent_emergency_user: USER_C, members: [member(USER_A)] }), {
      settings: [{ device_generation: 3, forward_to_cell: null }],
    });
    const { text } = await ringIn();
    expect(clientsIn(text)).toEqual([id(USER_C, 3)]);
    expect(filter(net.reads("phone_user_settings")[0], "user_id")).toBe(USER_C);
  });

  it("takes a voicemail (and keeps the row) when the switch is off; nobody rings", async () => {
    const off = setup(routeInfo({ phone_status: "off", members: [member(USER_A)] }));
    const { text } = await ringIn();
    expect(text).toContain("<Record");
    expect(text).not.toContain("can't take calls right now");
    expect(clientsIn(text)).toEqual([]);
    const row = off.writes("phone_calls", "POST")[0].json;
    expect(row.rang_user_ids).toEqual([]);
    expect(row.direction).toBe("in");
  });

  it("answers 'not in service' only for a number with no sms_numbers row", async () => {
    const net = setup(null);
    expect((await ringIn()).text).toContain("can't take calls right now");
    expect(net.writes("phone_calls")).toEqual([]);
  });
});

describe("business hours", () => {
  // 2026-09-29 is a Tuesday. 15:00 UTC = 10:00 in Chicago (CDT).
  const at = new Date("2026-09-29T15:00:00Z");
  it("reads the clock in the route's time zone", () => {
    expect(isOpen({ tue: [["08:00", "17:00"]] }, "America/Chicago", at)).toBe(true);
    expect(isOpen({ tue: [["11:00", "17:00"]] }, "America/Chicago", at)).toBe(false);
    expect(isOpen({ tue: [["08:00", "17:00"]] }, "Asia/Karachi", at)).toBe(false); // 20:00 there
  });
  it("null is always open; a missing day is closed", () => {
    expect(isOpen(null, "America/Chicago", at)).toBe(true);
    expect(isOpen({ mon: [["00:00", "24:00"]] }, "America/Chicago", at)).toBe(false);
  });
  it("handles ranges that run past midnight", () => {
    const late = new Date("2026-09-30T06:30:00Z"); // Wed 01:30 in Chicago
    expect(isOpen({ tue: [["22:00", "02:00"]] }, "America/Chicago", late)).toBe(true);
    expect(isOpen({ tue: [["22:00", "01:00"]] }, "America/Chicago", late)).toBe(false);
  });
  it("falls back to Chicago for an unknown time zone instead of failing the call", () => {
    expect(isOpen({ tue: [["08:00", "17:00"]] }, "Not/AZone", at)).toBe(true);
  });
});
