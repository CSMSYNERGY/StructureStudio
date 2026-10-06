// Voicemail transcription behind env TRANSCRIBE=on (release 2).
import { describe, expect, it } from "vitest";
import { voicemailTwiml } from "../src/voicemail";
import {
  Auth, BUSINESS_NUMBER, CALL_SID, CLIENT, CUSTOMER, FakeNet, USER_A, appRequest, attr, call, callerCtx, filter, makeEnv, member,
  routeInfo, twilioPost,
} from "./helpers";

const CALL_ID = "00000000-0000-4000-8000-0000000ca777";
const RE = "RE" + "0".repeat(31) + "7";
const ACCOUNT = "AC" + "0".repeat(32);

describe("<Record transcribe>", () => {
  it("is off unless TRANSCRIBE is exactly on (any case)", () => {
    for (const v of [undefined, "", "off", "yes", "true"]) {
      const xml = voicemailTwiml(makeEnv({ TRANSCRIBE: v }), CALL_ID, null);
      expect(xml).not.toContain("transcribe");
    }
    expect(voicemailTwiml(makeEnv({ TRANSCRIBE: " ON " }), CALL_ID, null)).toContain('transcribe="true"');
  });

  it("with TRANSCRIBE=on, every voicemail asks for a transcript sent to /voice/transcription", async () => {
    const net = new FakeNet().install();
    net.rpc("phone_route_for_number", () => routeInfo({ members: [member(USER_A, { dnd: true })] }));
    net.rest("GET", "crm_contacts", () => []);
    net.rest("POST", "phone_calls", () => []);
    net.rest("POST", "phone_call_events", () => []);
    const env = makeEnv({ TRANSCRIBE: "on" });
    const { text } = await call(env, await twilioPost(env, "/voice/inbound", { CallSid: CALL_SID, From: CUSTOMER, To: BUSINESS_NUMBER }));
    const id = net.writes("phone_calls", "POST")[0].json.id;
    expect(attr(text, "Record", "transcribe")).toBe("true");
    expect(attr(text, "Record", "transcribeCallback")).toBe(`https://phone.example.test/voice/transcription?call=${id}&key=test-webhook-key`);
    // The recording itself is unchanged.
    expect(attr(text, "Record", "action")).toBe(`https://phone.example.test/voice/voicemail?call=${id}&key=test-webhook-key`);
  });
});

describe("/voice/transcription", () => {
  function setup(opts: { updated?: boolean; call?: boolean } = {}) {
    const net = new FakeNet().install();
    net.rest("PATCH", "phone_voicemails", () => (opts.updated === false ? [] : [{ id: "vm1" }]));
    net.rest("POST", "phone_voicemails", () => []);
    net.rest("GET", "phone_calls", () => (opts.call === false ? [] : [{ id: CALL_ID, client_id: CLIENT, rang_user_ids: [], transfer_state: null }]));
    net.rest("POST", "phone_call_events", () => []);
    net.rest("POST", "app_errors", () => []);
    return net;
  }
  const post = async (params: Record<string, string>) => {
    const env = makeEnv({ TRANSCRIBE: "on" });
    return call(env, await twilioPost(env, "/voice/transcription", { CallSid: CALL_SID, RecordingSid: RE, AccountSid: ACCOUNT, ...params }, { call: CALL_ID }));
  };

  it("answers 204 and stores the text on the call's voicemail", async () => {
    const net = setup();
    const { res } = await post({ TranscriptionStatus: "completed", TranscriptionText: "  Hi, it's Jordan about the 10x12 shed.  " });
    expect(res.status).toBe(204);
    const w = net.writes("phone_voicemails", "PATCH")[0];
    expect(w.json).toEqual({ transcript: "Hi, it's Jordan about the 10x12 shed." });
    expect(filter(w, "call_id")).toBe(CALL_ID);
    expect(net.writes("phone_call_events").map((s) => s.json.type)).toEqual(["transcribed"]);
  });

  it("a transcript that beats the voicemail row files the row with it (the later voicemail upsert keeps it)", async () => {
    const net = setup({ updated: false });
    await post({ TranscriptionStatus: "completed", TranscriptionText: "Call me back" });
    expect(net.writes("phone_voicemails", "PATCH")).toHaveLength(3); // tried, waited, tried again
    const up = net.writes("phone_voicemails", "POST")[0];
    expect(up.json).toEqual({ call_id: CALL_ID, client_id: CLIENT, recording_sid: RE, transcript: "Call me back" });
    expect(up.url.searchParams.get("on_conflict")).toBe("call_id");
  });

  it("a failed or empty transcription writes nothing but a mark; the message is still there to play", async () => {
    for (const params of [{ TranscriptionStatus: "failed", TranscriptionText: "" }, { TranscriptionStatus: "completed", TranscriptionText: "   " }]) {
      const net = setup();
      const { res } = await post(params);
      expect(res.status).toBe(204);
      expect(net.writes("phone_voicemails")).toEqual([]);
      expect(net.writes("phone_call_events").map((s) => s.json.type)).toEqual(["transcription_failed"]);
    }
  });

  it("is a Twilio endpoint: a wrong key is refused", async () => {
    const net = setup();
    const env = makeEnv();
    const { res } = await call(env, await twilioPost(env, "/voice/transcription", { TranscriptionStatus: "completed", TranscriptionText: "x" }, { call: CALL_ID }, { key: "nope" }));
    expect(res.status).toBe(403);
    expect(net.writes("phone_voicemails")).toEqual([]);
  });
});

describe("GET /calls shows the transcript", () => {
  it("on the voicemail summary", async () => {
    const net = new FakeNet().install();
    const auth = await new Auth().init();
    auth.serve(net);
    net.rpc("phone_caller_context", () => callerCtx({ phone_level: "edit" }));
    net.rest("GET", "phone_calls", () => [{
      id: CALL_ID, client_id: CLIENT, number_id: null, contact_id: null, direction: "in", from_e164: CUSTOMER, to_e164: BUSINESS_NUMBER,
      twilio_call_sid: CALL_SID, client_call_sid: null, placed_by: null, answered_by: null, rang_user_ids: [USER_A],
      transferred_from: null, transfer_state: null, status: "voicemail", started_at: new Date().toISOString(), answered_at: null,
      ended_at: null, duration_s: 20, error_code: null, is_emergency: false, crm_contacts: null,
      phone_voicemails: [{ id: "vm1", duration_s: 14, listened_at: null, deleted_at: null, transcript: "Call me back" }],
    }]);
    const { json } = await call(makeEnv(), appRequest("GET", "/calls?scope=team", await auth.token(USER_A)));
    expect(json.calls[0].voicemail).toEqual({ id: "vm1", duration_s: 14, listened: false, transcript: "Call me back" });
    expect(net.reads("phone_calls")[0].url.searchParams.get("select")).toContain("phone_voicemails(id,duration_s,listened_at,deleted_at,transcript)");
  });
});
