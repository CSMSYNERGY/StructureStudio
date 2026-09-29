// /voice/screen, /voice/status and /voice/voicemail.
import { describe, expect, it } from "vitest";
import {
  BUSINESS_NUMBER, CALL_SID, CLIENT, CUSTOMER, FakeNet, NUMBER_ID, USER_A, USER_B,
  attr, call, filter, makeEnv, twilioPost,
} from "./helpers";

const CALL_ID = "00000000-0000-4000-8000-0000000ca222";
const LEG = "CA" + "0".repeat(31) + "7";

function row(over: Record<string, unknown> = {}) {
  return {
    id: CALL_ID, client_id: CLIENT, number_id: NUMBER_ID, contact_id: null, direction: "in",
    from_e164: CUSTOMER, to_e164: BUSINESS_NUMBER, twilio_call_sid: CALL_SID, client_call_sid: null,
    placed_by: null, answered_by: null, rang_user_ids: [USER_A, USER_B], transferred_from: null, transfer_state: null,
    status: "ringing", started_at: new Date(Date.now() - 60_000).toISOString(), answered_at: null, ended_at: null,
    duration_s: null, error_code: null, is_emergency: false, ...over,
  };
}

function setup(callRow: Record<string, unknown> | null = row()) {
  const net = new FakeNet().install();
  net.rest("GET", "phone_calls", (s) => {
    if (!callRow) return [];
    // Lookup by a leg's SID (parent callbacks) or by id.
    const bySid = filter(s, "twilio_call_sid") ?? filter(s, "client_call_sid");
    if (bySid) return bySid === callRow.twilio_call_sid || bySid === callRow.client_call_sid ? [{ id: callRow.id }] : [];
    return [callRow];
  });
  net.rest("PATCH", "phone_calls", () => [{ id: CALL_ID }]);
  net.rest("POST", "phone_call_events", () => []);
  net.rest("POST", "phone_voicemails", () => []);
  net.rest("POST", "app_errors", () => []);
  return net;
}

const env = makeEnv();
const patches = (net: FakeNet) => net.writes("phone_calls", "PATCH").map((s) => ({ body: s.json, url: s.url.search }));

describe("/voice/screen (press 1 to answer)", () => {
  it("asks the cell to press 1, naming the business, and hangs up on silence", async () => {
    setup();
    const { text } = await call(env, await twilioPost(env, "/voice/screen", { CallSid: LEG }, { call: CALL_ID, user: USER_A, b: "Demo Sheds" }));
    expect(text).toContain("<Say language=\"en-US\">SSS Phone call for Demo Sheds, press 1 to answer.</Say>");
    expect(attr(text, "Gather", "numDigits")).toBe("1");
    expect(attr(text, "Gather", "action")).toBe(`https://phone.example.test/voice/screen?call=${CALL_ID}&user=${USER_A}&b=Demo%20Sheds&step=accept&key=test-webhook-key`);
    expect(text).toMatch(/<\/Gather><Hangup\/><\/Response>$/);
  });

  it("pressing 1 bridges (empty response) and marks who answered on the cell", async () => {
    const net = setup();
    const { text } = await call(env, await twilioPost(env, "/voice/screen", { CallSid: LEG, Digits: "1" }, { call: CALL_ID, user: USER_A, b: "Demo Sheds", step: "accept" }));
    expect(text).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    expect(patches(net)[0].body).toMatchObject({ status: "in_progress", answered_by: USER_A, client_call_sid: LEG });
  });

  it("any other key hangs the cell up (the forward's action then takes the customer to voicemail)", async () => {
    const net = setup();
    const { text } = await call(env, await twilioPost(env, "/voice/screen", { CallSid: LEG, Digits: "2" }, { call: CALL_ID, step: "accept" }));
    expect(text).toContain("<Hangup/>");
    expect(patches(net)).toEqual([]);
  });

  it("survives an apostrophe in the business name (strict URL encoding keeps signatures valid)", async () => {
    setup();
    const { res, text } = await call(env, await twilioPost(env, "/voice/screen", { CallSid: LEG }, { call: CALL_ID, b: "Bob's Sheds & Barns" }));
    expect(res.status).toBe(200);
    expect(text).toContain("SSS Phone call for Bob's Sheds &amp; Barns, press 1");
    expect(attr(text, "Gather", "action")).toContain("b=Bob%27s%20Sheds%20%26%20Barns");
  });
});

describe("/voice/status", () => {
  it("answers 204 and writes in the background", async () => {
    const net = setup();
    const { res } = await call(env, await twilioPost(env, "/voice/status", {
      CallSid: LEG, CallStatus: "in-progress", To: `client:u_${USER_B.replace(/-/g, "")}_g1`,
    }, { call: CALL_ID, leg: "client" }));
    expect(res.status).toBe(204);
    const p = patches(net)[0];
    expect(p.body).toMatchObject({ status: "in_progress", answered_by: USER_B, client_call_sid: LEG });
    expect(p.url).toContain("answered_by=is.null"); // first answer wins
    expect(net.writes("phone_call_events")[0].json).toMatchObject({ call_id: CALL_ID, type: "answered" });
  });

  it("an inbound call's answered leg completing sets the talk time", async () => {
    const net = setup(row({ status: "in_progress", answered_by: USER_B, client_call_sid: LEG, answered_at: new Date().toISOString() }));
    await call(env, await twilioPost(env, "/voice/status", { CallSid: LEG, CallStatus: "completed", CallDuration: "95" }, { call: CALL_ID, leg: "client" }));
    expect(patches(net)[0].body).toMatchObject({ status: "completed", duration_s: 95 });
  });

  it("a rung leg that was not answered changes nothing on the call", async () => {
    const net = setup(row({ status: "in_progress", answered_by: USER_B, client_call_sid: LEG }));
    await call(env, await twilioPost(env, "/voice/status", { CallSid: "CA" + "0".repeat(31) + "9", CallStatus: "canceled" }, { call: CALL_ID, leg: "client" }));
    expect(patches(net)).toEqual([]);
  });

  it("outbound customer leg: records its SID, the answer, then the outcome", async () => {
    const out = row({ direction: "out", from_e164: BUSINESS_NUMBER, to_e164: CUSTOMER, twilio_call_sid: null, placed_by: USER_A, client_call_sid: CALL_SID });
    let net = setup(out);
    await call(env, await twilioPost(env, "/voice/status", { CallSid: LEG, CallStatus: "initiated" }, { call: CALL_ID, leg: "pstn" }));
    expect(patches(net)[0].body).toEqual({ twilio_call_sid: LEG });
    net = setup({ ...out, twilio_call_sid: LEG });
    await call(env, await twilioPost(env, "/voice/status", { CallSid: LEG, CallStatus: "busy" }, { call: CALL_ID, leg: "pstn" }));
    expect(patches(net)[0].body).toMatchObject({ status: "busy" });
  });

  it("the inbound customer hanging up while it still rang makes a missed call", async () => {
    const net = setup();
    await call(env, await twilioPost(env, "/voice/status", { CallSid: CALL_SID, CallStatus: "completed" }, { leg: "pstn" }));
    const first = patches(net)[0];
    expect(first.body).toMatchObject({ status: "missed" });
    expect(first.url).toContain("status=eq.ringing");
    expect(filter(net.reads("phone_calls")[0], "twilio_call_sid")).toBe(CALL_SID);
  });

  it("the customer's leg ending closes a call still marked in progress (a transfer that ended in voicemail)", async () => {
    // Whole seconds: Twilio's Timestamp (RFC 2822) carries no milliseconds.
    const answeredAt = new Date(Math.floor(Date.now() / 1000) * 1000 - 90_000).toISOString();
    const net = setup(row({ status: "in_progress", answered_by: null, transferred_from: USER_A, answered_at: answeredAt }));
    await call(env, await twilioPost(env, "/voice/status", { CallSid: CALL_SID, CallStatus: "completed", Timestamp: new Date(Date.parse(answeredAt) + 90_000).toUTCString() }, { leg: "pstn" }));
    const first = patches(net)[0];
    expect(first.body).toMatchObject({ status: "completed", duration_s: 90 });
    expect(first.url).toContain("status=eq.in_progress");
  });

  it("ignores a leg it never recorded", async () => {
    const net = setup(null);
    await call(env, await twilioPost(env, "/voice/status", { CallSid: "CA" + "0".repeat(31) + "8", CallStatus: "completed" }, { leg: "pstn" }));
    expect(net.writes("phone_calls")).toEqual([]);
    expect(net.writes("phone_call_events")).toEqual([]);
  });
});

describe("/voice/voicemail", () => {
  it("the Record action hangs up and files the message against the call", async () => {
    const net = setup();
    const { text } = await call(env, await twilioPost(env, "/voice/voicemail", {
      CallSid: CALL_SID, RecordingSid: "RE" + "0".repeat(32), RecordingDuration: "14", RecordingUrl: "https://api.example.test/rec",
    }, { call: CALL_ID }));
    expect(text).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    const vm = net.writes("phone_voicemails", "POST")[0];
    expect(vm.json).toEqual({ call_id: CALL_ID, client_id: CLIENT, recording_sid: "RE" + "0".repeat(32), duration_s: 14 });
    expect(vm.url.searchParams.get("on_conflict")).toBe("call_id");
    const status = patches(net).find((p) => p.body.status === "voicemail")!;
    expect(status.url).toContain("answered_by=is.null");
  });

  it("the recording status callback answers 204 and files it too", async () => {
    const net = setup();
    const { res } = await call(env, await twilioPost(env, "/voice/voicemail", {
      CallSid: CALL_SID, RecordingSid: "RE" + "0".repeat(32), RecordingDuration: "9", RecordingStatus: "completed",
    }, { call: CALL_ID, cb: "status" }));
    expect(res.status).toBe(204);
    expect(net.writes("phone_voicemails")).toHaveLength(1);
  });

  it("a hang-up at the beep (0 s) is not a voicemail", async () => {
    const net = setup();
    await call(env, await twilioPost(env, "/voice/voicemail", { CallSid: CALL_SID, RecordingSid: "RE" + "0".repeat(32), RecordingDuration: "0" }, { call: CALL_ID }));
    expect(net.writes("phone_voicemails")).toEqual([]);
  });

  it("reaching voicemail ends a transfer", async () => {
    const net = setup(row({ transfer_state: "transferring", answered_by: null }));
    await call(env, await twilioPost(env, "/voice/voicemail", { CallSid: CALL_SID, RecordingSid: "RE" + "0".repeat(32), RecordingDuration: "5" }, { call: CALL_ID }));
    expect(patches(net).map((p) => p.body)).toContainEqual({ transfer_state: null });
  });
});
