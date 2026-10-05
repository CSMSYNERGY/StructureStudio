import { afterEach, describe, expect, it, vi } from "vitest";
import { inRingHours, isOpen } from "../src/hours";
import { awayFromSettings, isAway, offHours } from "../src/routes/voice";
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

  // Migration 264: each person's own greeting, recorded by phone. Precedence: theirs (on a line
  // that is only theirs), then the number's link, then the standard sentence.
  describe("whose greeting plays (migration 264)", () => {
    const SID = "RE" + "0".repeat(31) + "c";
    const OTHER_SID = "RE" + "0".repeat(31) + "d";
    const LINK = "https://cdn.example.test/greeting.mp3";
    const own = (u: string, sid = SID) => `<Play>https://phone.example.test/voice/greeting-audio?u=${u}&amp;v=${sid}&amp;key=test-webhook-key</Play>`;

    it("a line that is only one person's plays their own greeting, over the number's link", async () => {
      setup(routeInfo({ members: [member(USER_A, { dnd: true, greeting_sid: SID })] }, { members: [USER_A], greeting_url: LINK }));
      const { text } = await ringIn();
      expect(text).toContain(own(USER_A));
      expect(text).not.toContain(LINK);
      expect(text).not.toContain("<Say");
      expect(text).toMatch(/<\/Play><Record [^>]*\/><Hangup\/><\/Response>$/);
    });

    it("after hours on that line too", async () => {
      const closed = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
      setup(routeInfo({ members: [member(USER_A, { greeting_sid: SID })] }, { members: [USER_A], business_hours: closed }));
      expect((await ringIn()).text).toContain(own(USER_A));
    });

    it("a shared number never plays one person's greeting: the number's link, else the standard one", async () => {
      setup(routeInfo({ members: [member(USER_A, { dnd: true, greeting_sid: SID }), member(USER_B, { dnd: true, greeting_sid: OTHER_SID })] }, { members: [USER_A, USER_B], greeting_url: LINK }));
      const linked = (await ringIn()).text;
      expect(linked).toContain(`<Play>${LINK}</Play>`);
      expect(linked).not.toContain("greeting-audio");
      setup(routeInfo({ members: [member(USER_A, { dnd: true, greeting_sid: SID }), member(USER_B, { dnd: true })] }, { members: [USER_A, USER_B] }));
      const plain = (await ringIn()).text;
      expect(plain).not.toContain("<Play");
      expect(plain).toContain("You've reached Demo Sheds.");
    });

    it("someone who lost phone access, a cover, or a sid that isn't one never plays", async () => {
      setup(routeInfo({ members: [member(USER_A, { has_access: false, greeting_sid: SID })] }, { members: [USER_A] }));
      expect((await ringIn()).text).not.toContain("greeting-audio");
      // The one member is away and their cover (not on the list) has a greeting: still nobody's line
      // but theirs, wherever the cover's row sits, and even a cover row under their own id.
      setup(routeInfo({ members: [member(USER_C, { cover_only: true, dnd: true, greeting_sid: SID }), member(USER_A, { dnd: true, dnd_cover: USER_C })] }, { members: [USER_A] }));
      expect((await ringIn()).text).not.toContain("greeting-audio");
      setup(routeInfo({ members: [member(USER_A, { cover_only: true, dnd: true, greeting_sid: SID })] }, { members: [USER_A] }));
      expect((await ringIn()).text).not.toContain("greeting-audio");
      setup(routeInfo({ members: [member(USER_A, { dnd: true, greeting_sid: "https://cdn.example.test/x.mp3" })] }, { members: [USER_A] }));
      expect((await ringIn()).text).not.toContain("<Play");
    });

    it("a database before 264 (no greeting_sid) reads as none", async () => {
      setup(routeInfo({ members: [member(USER_A, { dnd: true })] }, { members: [USER_A], greeting_url: LINK }));
      expect((await ringIn()).text).toContain(`<Play>${LINK}</Play>`);
    });

    // Migration 266: a number that is someone's own plays THEIR greeting, whoever its answer list
    // names (264 could only guess the owner from a list of exactly one).
    it("someone's own number plays their greeting, even with a teammate on its answer list too", async () => {
      setup(routeInfo({
        members: [member(USER_A, { dnd: true, greeting_sid: SID }), member(USER_B, { dnd: true, greeting_sid: OTHER_SID })],
        number_owner: { user_id: USER_A, greeting_sid: SID, has_access: true },
      }, { members: [USER_A, USER_B], greeting_url: LINK }));
      const text = (await ringIn()).text;
      expect(text).toContain(own(USER_A));
      expect(text).not.toContain(OTHER_SID);
      expect(text).not.toContain(LINK);
    });

    it("...and even when its person isn't on the answer list at all (their greeting comes with number_owner)", async () => {
      setup(routeInfo({ members: [member(USER_B, { dnd: true, greeting_sid: OTHER_SID })], number_owner: { user_id: USER_A, greeting_sid: SID, has_access: true } }, { members: [USER_B] }));
      expect((await ringIn()).text).toContain(own(USER_A));
    });

    it("its person with no greeting: the number's link (never the one member's); its person without phone access: nobody's line", async () => {
      setup(routeInfo({ members: [member(USER_B, { dnd: true, greeting_sid: OTHER_SID })], number_owner: { user_id: USER_A, greeting_sid: null, has_access: true } }, { members: [USER_B], greeting_url: LINK }));
      const noGreeting = (await ringIn()).text;
      expect(noGreeting).toContain(`<Play>${LINK}</Play>`);
      expect(noGreeting).not.toContain("greeting-audio");
      setup(routeInfo({ members: [member(USER_B, { dnd: true, greeting_sid: OTHER_SID })], number_owner: { user_id: USER_A, greeting_sid: SID, has_access: false } }, { members: [USER_B] }));
      expect((await ringIn()).text).not.toContain("greeting-audio");
      // A malformed number_owner (or none, a database before 266) is a team line: 264's rule.
      setup(routeInfo({ members: [member(USER_B, { dnd: true, greeting_sid: OTHER_SID })], number_owner: { greeting_sid: SID } }, { members: [USER_B] }));
      expect((await ringIn()).text).toContain(own(USER_B, OTHER_SID));
    });
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

// Migration 264: someone away (on DND) can choose a teammate to ring in their place. The RPC lists
// that cover with cover_only when they aren't on the answer list themselves.
describe("/voice/inbound covers while someone is away", () => {
  const COVER = "00000000-0000-4000-8000-0000000000e5";
  const COVER_2 = "00000000-0000-4000-8000-0000000000f6";
  const coverRow = (u: string, over: Record<string, unknown> = {}) => member(u, { cover_only: true, full_name: "Cora Cover", ...over });
  const away = (u: string, cover: string | null, over: Record<string, unknown> = {}) => member(u, { dnd: true, dnd_cover: cover, ...over });

  it("rings the cover in the away member's place (with the others), and records who rang", async () => {
    const net = setup(routeInfo({ members: [away(USER_A, COVER), member(USER_B), coverRow(COVER)] }, { members: [USER_A, USER_B] }));
    const { text } = await ringIn();
    expect(clientsIn(text)).toEqual([id(COVER), id(USER_B)]);
    expect(net.writes("phone_calls", "POST")[0].json.rang_user_ids).toEqual([COVER, USER_B]);
    // A cover's <Client> is a member's: the status callback and the call id.
    expect(text).toContain(`<Parameter name="call_id" value="${net.writes("phone_calls", "POST")[0].json.id}"/>`);
  });

  it("rings the cover's cell too, through the press-1 screen, as theirs", async () => {
    setup(routeInfo({ members: [away(USER_A, COVER), coverRow(COVER, { forward_to_cell: "+15555550179" })] }, { members: [USER_A] }));
    const { text } = await ringIn();
    expect(clientsIn(text)).toEqual([id(COVER)]);
    expect(numbersIn(text)).toEqual(["+15555550179"]);
    expect(attr(text, "Number", "url")).toContain(`user=${COVER}`);
  });

  it.each([
    ["on a call", { busy: true }],
    ["on DND themselves", { dnd: true }],
    ["without phone access (or on another business)", { has_access: false }],
  ])("skips a cover who is %s: the place stays empty", async (_l, over) => {
    setup(routeInfo({ members: [away(USER_A, COVER), member(USER_B), coverRow(COVER, over)] }, { members: [USER_A, USER_B] }));
    expect(clientsIn((await ringIn()).text)).toEqual([id(USER_B)]);
  });

  it("an expired DND is not away: the member rings themselves and the cover doesn't", async () => {
    setup(routeInfo({
      members: [away(USER_A, COVER, { dnd_until: new Date(Date.now() - 60_000).toISOString() }), coverRow(COVER)],
    }, { members: [USER_A] }));
    expect(clientsIn((await ringIn()).text)).toEqual([id(USER_A)]);
  });

  it("goes to voicemail when the only member is away and their cover can't take it", async () => {
    const net = setup(routeInfo({ members: [away(USER_A, COVER), coverRow(COVER, { busy: true })] }, { members: [USER_A] }));
    const { text } = await ringIn();
    expect(text).toContain("<Record");
    expect(net.writes("phone_calls", "POST")[0].json.rang_user_ids).toEqual([]);
  });

  it("a cover who is on the answer list already rings once, in their own place", async () => {
    setup(routeInfo({ members: [away(USER_A, USER_C), member(USER_B), member(USER_C)] }));
    expect(clientsIn((await ringIn()).text)).toEqual([id(USER_B), id(USER_C)]);
  });

  it("two away members with the same cover ring them once", async () => {
    setup(routeInfo({ members: [away(USER_A, COVER), away(USER_B, COVER), member(USER_C), coverRow(COVER)] }));
    expect(clientsIn((await ringIn()).text)).toEqual([id(COVER), id(USER_C)]);
  });

  it("busy is not away: a member on a call never hands their place to their cover", async () => {
    setup(routeInfo({ members: [member(USER_A, { busy: true, dnd_cover: COVER }), member(USER_B), coverRow(COVER)] }, { members: [USER_A, USER_B] }));
    expect(clientsIn((await ringIn()).text)).toEqual([id(USER_B)]);
  });

  it("a member without phone access is off the phone, not away: no cover rings for them", async () => {
    setup(routeInfo({ members: [away(USER_A, COVER, { has_access: false }), member(USER_B), coverRow(COVER)] }, { members: [USER_A, USER_B] }));
    expect(clientsIn((await ringIn()).text)).toEqual([id(USER_B)]);
  });

  it("a cover_only row never rings on its own (its member is not away)", async () => {
    setup(routeInfo({ members: [member(USER_A, { dnd_cover: COVER }), coverRow(COVER)] }, { members: [USER_A] }));
    expect(clientsIn((await ringIn()).text)).toEqual([id(USER_A)]);
  });

  it("one level only: an away cover's own cover is not rung", async () => {
    // Even if a row for the cover's cover were there, it is not rung in the first member's place.
    setup(routeInfo({ members: [away(USER_A, COVER), coverRow(COVER, { dnd: true, dnd_cover: COVER_2 }), coverRow(COVER_2)] }, { members: [USER_A] }));
    expect((await ringIn()).text).toContain("<Record");
  });

  it("in_order: the cover rings in the away member's place, with that place's position", async () => {
    setup(routeInfo({ members: [away(USER_A, COVER), member(USER_B), member(USER_C), coverRow(COVER)] }, { mode: "in_order" }));
    const { text } = await ringIn();
    expect(clientsIn(text)).toEqual([id(COVER)]);
    expect(attr(text, "Dial", "action")).toMatch(/stage=order&p=0&key=/);
  });

  it("in_order: a later away member's cover rings at that member's position", async () => {
    setup(routeInfo({ members: [member(USER_A, { busy: true }), away(USER_B, COVER), member(USER_C), coverRow(COVER)] }, { mode: "in_order" }));
    const { text } = await ringIn();
    expect(clientsIn(text)).toEqual([id(COVER)]);
    expect(attr(text, "Dial", "action")).toMatch(/stage=order&p=1&key=/);
  });

  it("the 911 callback still rings only the person who dialed 911, never their cover", async () => {
    setup(routeInfo({ recent_emergency_user: USER_A, members: [away(USER_A, COVER), member(USER_B), coverRow(COVER)] }, { members: [USER_A, USER_B] }));
    const { text } = await ringIn();
    expect(clientsIn(text)).toEqual([id(USER_A)]);
    expect(attr(text, "Dial", "action")).toMatch(/stage=er&n=1/);
  });

  it("the 911 callback reads a cover_only person's line directly, as anyone off the list", async () => {
    const net = setup(routeInfo({ recent_emergency_user: COVER, members: [away(USER_A, COVER), coverRow(COVER)] }, { members: [USER_A] }), {
      settings: [{ device_generation: 2, forward_to_cell: null }],
    });
    expect(clientsIn((await ringIn()).text)).toEqual([id(COVER, 2)]);
    expect(filter(net.reads("phone_user_settings")[0], "user_id")).toBe(COVER);
  });

  it("after hours, a cover changes nothing: the route's after-hours answer", async () => {
    const closed = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
    setup(routeInfo({ members: [away(USER_A, COVER), coverRow(COVER)] }, { members: [USER_A], business_hours: closed }));
    const { text } = await ringIn();
    expect(text).toContain("<Record");
    expect(clientsIn(text)).toEqual([]);
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

// Migration 264: each person's own hours ("when my phone rings"). Outside them they count as away,
// exactly like DND: their cover rings in their place, or nobody does. Read in their own zone, else
// the number's. The number's business hours stay the outer gate. Proved on the TwiML only.
describe("/voice/inbound: each person's own hours", () => {
  // 2026-09-29 is a Tuesday. 15:00 UTC = 10:00 in Chicago, 11:00 in New York, 20:00 in Karachi.
  const TUESDAY_10AM_CHICAGO = new Date("2026-09-29T15:00:00Z");
  const WORKDAY = { tue: [["08:00", "17:00"]] };
  const COVER = "00000000-0000-4000-8000-0000000000e5";
  const coverRow = (over: Record<string, unknown> = {}) => member(COVER, { cover_only: true, ...over });
  const at = (d: Date) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(d);
  };
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rings someone inside their hours and skips someone outside theirs; the rest ring as before", async () => {
    at(TUESDAY_10AM_CHICAGO);
    const net = setup(routeInfo({
      members: [
        member(USER_A, { ring_hours: WORKDAY, hours_tz: "America/Chicago" }),
        member(USER_B, { ring_hours: { tue: [["12:00", "17:00"]] }, hours_tz: "America/Chicago" }),
        member(USER_C),
      ],
    }));
    const { text } = await ringIn();
    expect(clientsIn(text)).toEqual([id(USER_A), id(USER_C)]);
    expect(net.writes("phone_calls", "POST")[0].json.rang_user_ids).toEqual([USER_A, USER_C]);
  });

  it("a day they didn't add is outside their hours", async () => {
    at(TUESDAY_10AM_CHICAGO);
    setup(routeInfo({ members: [member(USER_A, { ring_hours: { mon: [["08:00", "17:00"]] }, hours_tz: "America/Chicago" }), member(USER_B)] }));
    expect(clientsIn((await ringIn()).text)).toEqual([id(USER_B)]);
  });

  it("outside their hours, their cover rings in their place", async () => {
    at(TUESDAY_10AM_CHICAGO);
    const net = setup(routeInfo({
      members: [member(USER_A, { ring_hours: { tue: [["13:00", "17:00"]] }, hours_tz: "America/Chicago", dnd_cover: COVER }), member(USER_B), coverRow()],
    }, { members: [USER_A, USER_B] }));
    const { text } = await ringIn();
    expect(clientsIn(text)).toEqual([id(COVER), id(USER_B)]);
    expect(net.writes("phone_calls", "POST")[0].json.rang_user_ids).toEqual([COVER, USER_B]);
  });

  it("inside their hours, the cover stays out of it", async () => {
    at(TUESDAY_10AM_CHICAGO);
    setup(routeInfo({ members: [member(USER_A, { ring_hours: WORKDAY, hours_tz: "America/Chicago", dnd_cover: COVER }), coverRow()] }, { members: [USER_A] }));
    expect(clientsIn((await ringIn()).text)).toEqual([id(USER_A)]);
  });

  it("a cover outside their own hours isn't rung either: the place stays empty", async () => {
    at(TUESDAY_10AM_CHICAGO);
    setup(routeInfo({
      members: [member(USER_A, { dnd: true, dnd_cover: COVER }), member(USER_B), coverRow({ ring_hours: { wed: [["08:00", "17:00"]] }, hours_tz: "America/Chicago" })],
    }, { members: [USER_A, USER_B] }));
    expect(clientsIn((await ringIn()).text)).toEqual([id(USER_B)]);
  });

  it("reads each person's hours in their own time zone", async () => {
    at(TUESDAY_10AM_CHICAGO);
    // The same 8 to 5: 10:00 for the Chicago member, 20:00 for the one in Karachi.
    setup(routeInfo({
      members: [
        member(USER_A, { ring_hours: WORKDAY, hours_tz: "America/Chicago" }),
        member(USER_B, { ring_hours: WORKDAY, hours_tz: "Asia/Karachi" }),
      ],
    }, { members: [USER_A, USER_B] }));
    expect(clientsIn((await ringIn()).text)).toEqual([id(USER_A)]);
  });

  it("hours with no zone, or one the runtime doesn't know, are read in the NUMBER's zone", async () => {
    at(TUESDAY_10AM_CHICAGO);
    // 11:00 in New York (the number's zone), 10:00 in Chicago (the Worker's last resort).
    const fromHalfTen = { tue: [["10:30", "17:00"]] };
    setup(routeInfo({
      members: [member(USER_A, { ring_hours: fromHalfTen, hours_tz: null }), member(USER_B, { ring_hours: fromHalfTen, hours_tz: "Not/AZone" })],
    }, { members: [USER_A, USER_B], time_zone: "America/New_York" }));
    expect(clientsIn((await ringIn()).text)).toEqual([id(USER_A), id(USER_B)]);
  });

  it("hours that run past midnight ring until they end, written either way", async () => {
    at(new Date("2026-09-30T06:00:00Z")); // Wednesday 01:00 in Chicago
    setup(routeInfo({
      members: [
        member(USER_A, { ring_hours: { tue: [["22:00", "02:00"]] }, hours_tz: "America/Chicago" }),
        member(USER_B, { ring_hours: { tue: [["22:00", "23:59"]], wed: [["00:00", "06:00"]] }, hours_tz: "America/Chicago" }),
        member(USER_C, { ring_hours: { tue: [["22:00", "00:30"]] }, hours_tz: "America/Chicago" }),
      ],
    }));
    expect(clientsIn((await ringIn()).text)).toEqual([id(USER_A), id(USER_B)]);
  });

  it("everyone outside their hours, with nobody to cover: straight to voicemail", async () => {
    at(TUESDAY_10AM_CHICAGO);
    const net = setup(routeInfo({ members: [member(USER_A, { ring_hours: { wed: [["08:00", "17:00"]] }, hours_tz: "America/Chicago" })] }, { members: [USER_A] }));
    const { text } = await ringIn();
    expect(text).not.toContain("<Dial");
    expect(text).toContain("<Record");
    expect(net.writes("phone_calls", "POST")[0].json.rang_user_ids).toEqual([]);
  });

  it("the business hours stay the outer gate: own hours never ring anyone after the business closes", async () => {
    at(TUESDAY_10AM_CHICAGO);
    // The business is open 8 to 9; this member's own hours cover the whole day.
    setup(routeInfo({ members: [member(USER_A, { ring_hours: { tue: [["00:00", "23:59"]] }, hours_tz: "America/Chicago" })] }, {
      members: [USER_A], business_hours: { tue: [["08:00", "09:00"]] }, after_hours: "forward", forward_to: "+15555550166",
    }));
    const { text } = await ringIn();
    expect(clientsIn(text)).toEqual([]);
    expect(numbersIn(text)).toEqual(["+15555550166"]);
    expect(attr(text, "Dial", "action")).toMatch(/stage=fwd/);
  });

  it("in_order skips a member outside their hours and names the next one's position", async () => {
    at(TUESDAY_10AM_CHICAGO);
    setup(routeInfo({
      members: [member(USER_A, { ring_hours: { tue: [["13:00", "17:00"]] }, hours_tz: "America/Chicago" }), member(USER_B), member(USER_C)],
    }, { mode: "in_order" }));
    const { text } = await ringIn();
    expect(clientsIn(text)).toEqual([id(USER_B)]);
    expect(attr(text, "Dial", "action")).toMatch(/stage=order&p=1&key=/);
  });

  it("the 911 callback ignores the person's own hours, as it ignores DND", async () => {
    at(TUESDAY_10AM_CHICAGO);
    setup(routeInfo({
      recent_emergency_user: USER_A,
      members: [member(USER_A, { ring_hours: { wed: [["08:00", "17:00"]] }, hours_tz: "America/Chicago", dnd_cover: COVER }), member(USER_B), coverRow()],
    }, { members: [USER_A, USER_B] }));
    const { text } = await ringIn();
    expect(clientsIn(text)).toEqual([id(USER_A)]);
    expect(attr(text, "Dial", "action")).toMatch(/stage=er&n=1/);
  });

  it("an RPC from before 264 (no hours keys) rings everyone as before", async () => {
    at(TUESDAY_10AM_CHICAGO);
    setup(routeInfo());
    expect(clientsIn((await ringIn()).text)).toEqual([id(USER_A), id(USER_B), id(USER_C)]);
  });
});

describe("own hours, the rule", () => {
  const at = new Date("2026-09-29T15:00:00Z"); // Tuesday 10:00 in Chicago
  it("null is always; otherwise their zone, else the number's", () => {
    expect(inRingHours(null, null, "America/Chicago", at)).toBe(true);
    expect(inRingHours({ tue: [["08:00", "17:00"]] }, "Asia/Karachi", "America/Chicago", at)).toBe(false);
    expect(inRingHours({ tue: [["10:30", "17:00"]] }, null, "America/New_York", at)).toBe(true);
    expect(inRingHours({ tue: [["10:30", "17:00"]] }, "Not/AZone", "America/New_York", at)).toBe(true);
    expect(inRingHours({ tue: [["10:30", "17:00"]] }, "Not/AZone", "America/Chicago", at)).toBe(false);
    // A stored {} (the Worker never saves one) reads as no day at all.
    expect(inRingHours({}, "America/Chicago", "America/Chicago", at)).toBe(false);
  });
  it("away is DND or outside their hours; an ended DND inside their hours is not away", () => {
    const now = at.getTime();
    const m = member(USER_A, { ring_hours: { tue: [["08:00", "17:00"]] }, hours_tz: "America/Chicago" });
    const away = (over: Record<string, unknown> = {}) => isAway({ ...m, ...over } as Parameters<typeof isAway>[0], now, "America/Chicago");
    expect(away()).toBe(false);
    expect(away({ dnd: true })).toBe(true);
    expect(away({ dnd: true, dnd_until: new Date(now - 60_000).toISOString() })).toBe(false);
    expect(away({ hours_tz: "Asia/Karachi" })).toBe(true);
    expect(offHours({ ring_hours: null }, "America/Chicago", now)).toBe(false);
  });
  it("a transfer target read straight from phone_user_settings", () => {
    const now = at.getTime();
    expect(awayFromSettings(null, "America/Chicago", now)).toEqual({ dnd: false, offHours: false });
    expect(awayFromSettings({ dnd: false, ring_hours: { wed: [["08:00", "17:00"]] }, ring_hours_tz: "America/Chicago" }, "America/Chicago", now))
      .toEqual({ dnd: false, offHours: true });
    expect(awayFromSettings({ dnd: true, dnd_until: null, ring_hours: null }, "America/Chicago", now)).toEqual({ dnd: true, offHours: false });
  });
});
