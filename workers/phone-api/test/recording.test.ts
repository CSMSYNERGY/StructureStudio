// Call recording (release B2, src/recording.ts): the announcement in every flow's TwiML, the
// per-call arm, the start on answer (once), pause on hold and resume, the stop before every
// voicemail redirect, Twilio's recording callback and the outbound whisper. Twilio and the
// database are stubs (helpers.ts); every id, number and SID is made up.
import { describe, expect, it } from "vitest";
import type { CallRow } from "../src/db";
import { adminClient } from "../src/db";
import { installDenoShim } from "../src/env";
import {
  armedFor, noticeText, pauseCallRecording, recordingBackstop, resumeCallRecording, STANDARD_NOTICE, STANDARD_NOTICE_TRANSCRIBED,
  startCallRecording, stopCallRecording,
} from "../src/recording";
import {
  Auth, BUSINESS_NUMBER, CALL_SID, CLIENT, CUSTOMER, FakeNet, NUMBER_ID, USER_A, USER_B, USER_C,
  appRequest, attr, call, callerCtx, clientsIn, filter, jsonRes, makeEnv, member, routeInfo, twilioPost, type Seen,
} from "./helpers";

const CALL_ID = "00000000-0000-4000-8000-0000000ca777";
const REC_ID = "00000000-0000-4000-8000-0000000ae001";
const REC_SID = "RE" + "0".repeat(31) + "7";
const MY_LEG = "CA" + "0".repeat(31) + "5";
const CONF = "CF" + "0".repeat(31) + "1";
const ACCOUNT = "AC" + "0".repeat(32);
const IDENTITY_A = `client:u_${USER_A.replace(/-/g, "")}_g1`;

const ON = { on: true, notice: true, notice_text: null, transcribe: true };
const recEnv = (over: Record<string, string> = {}) => makeEnv({ CALL_RECORDING: "on", ...over });

function liveCall(over: Partial<CallRow> = {}): CallRow {
  return {
    id: CALL_ID, client_id: CLIENT, number_id: NUMBER_ID, contact_id: null, direction: "in",
    from_e164: CUSTOMER, to_e164: BUSINESS_NUMBER, twilio_call_sid: CALL_SID, client_call_sid: MY_LEG,
    placed_by: null, answered_by: USER_A, rang_user_ids: [USER_A], transferred_from: null, transfer_state: null,
    status: "in_progress", started_at: new Date(Date.now() - 120_000).toISOString(), answered_at: new Date(Date.now() - 100_000).toISOString(),
    ended_at: null, duration_s: null, error_code: null, is_emergency: false, recording_armed: true, ...over,
  };
}

const recRow = (over: Record<string, unknown> = {}) => ({
  id: REC_ID, call_id: CALL_ID, client_id: CLIENT, recording_sid: REC_SID, status: "recording", ...over,
});

const api = /^https:\/\/api\.twilio\.com\/2010-04-01\/Accounts\/AC0+/;
const isStart = (u: URL) => api.test(u.href) && /\/Calls\/CA[0-9a-f]+\/Recordings\.json$/.test(u.pathname);
const isUpdate = (u: URL) => api.test(u.href) && /\/Calls\/CA[0-9a-f]+\/Recordings\/RE[0-9a-f]+\.json$/.test(u.pathname);
const form = (s: Seen) => Object.fromEntries(new URLSearchParams(s.body));
const recUpdates = (net: FakeNet) => net.seen.filter((s) => s.method === "POST" && isUpdate(s.url)).map((s) => form(s).Status);
const recPatches = (net: FakeNet) => net.writes("phone_call_recordings", "PATCH").map((s) => s.json);
const eventTypes = (net: FakeNet) => net.writes("phone_call_events").map((s) => s.json.type);

/** The recording stubs every lifecycle test needs; `existing` is the call's row, if it has one. */
function recordingNet(net: FakeNet, opts: { existing?: Record<string, unknown> | null; claim?: boolean; startStatus?: number; settings?: unknown[] } = {}) {
  net.rest("GET", "phone_call_recordings", () => (opts.existing ? [opts.existing] : []));
  net.rest("POST", "phone_call_recordings", () => (opts.claim === false ? [] : [{ id: REC_ID }]));
  net.rest("PATCH", "phone_call_recordings", () => [{ id: REC_ID }]);
  net.rest("GET", "client_settings", () => opts.settings ?? [{ phone_recording_notice_text: null, phone_transcribe_calls: true }]);
  net.on("POST", isStart, () => (opts.startStatus ? jsonRes({ code: 21220 }, opts.startStatus) : jsonRes({ sid: REC_SID, status: "in-progress", channels: 2 })));
  net.on("POST", isUpdate, () => jsonRes({ sid: REC_SID }));
  net.rest("POST", "phone_call_events", () => []);
  net.rest("POST", "app_errors", () => []);
  return net;
}

// ── The pure rules ──────────────────────────────────────────────────────────────────

describe("armed and the announcement", () => {
  it("armed needs the rail exactly \"on\", the business on, the announcement on, and no emergency", () => {
    expect(armedFor(recEnv(), ON)).toBe(true);
    expect(armedFor(makeEnv(), ON)).toBe(false);
    expect(armedFor(makeEnv({ CALL_RECORDING: "On" }), ON)).toBe(false);
    expect(armedFor(recEnv(), { ...ON, on: false })).toBe(false);
    expect(armedFor(recEnv(), { ...ON, notice: false })).toBe(false); // locked on: no notice, no recording
    expect(armedFor(recEnv(), ON, true)).toBe(false);
  });

  it("the standard sentence is Carolyn's \"may be recorded\" (2026-10-06)", () => {
    expect(STANDARD_NOTICE).toBe("This call may be recorded.");
    expect(STANDARD_NOTICE_TRANSCRIBED).toBe("This call may be recorded and transcribed.");
    // The sentence 263 shipped is now a business's own wording like any other: it says "recorded".
    expect(noticeText(recEnv(), { ...ON, notice_text: "This call will be recorded." })).toBe("This call will be recorded.");
  });

  it("the standard sentence mentions transcription only while it will happen; a business's own wins", () => {
    expect(noticeText(recEnv(), ON)).toBe(STANDARD_NOTICE);
    expect(noticeText(recEnv({ CALL_TRANSCRIBE: "on" }), ON)).toBe(STANDARD_NOTICE_TRANSCRIBED);
    expect(noticeText(recEnv({ CALL_TRANSCRIBE: "on" }), { ...ON, transcribe: false })).toBe(STANDARD_NOTICE);
    expect(noticeText(recEnv(), { ...ON, notice_text: "  Demo Sheds records calls for training.  " })).toBe("Demo Sheds records calls for training.");
  });

  it("a stored sentence that doesn't say the call is recorded, or denies it, is never spoken: the standard one plays", () => {
    for (const bad of ["Calls on this line are not recorded.", "Thanks for calling Demo Sheds, the record-setting builder!", "This call won't be recorded."]) {
      expect(noticeText(recEnv(), { ...ON, notice_text: bad })).toBe(STANDARD_NOTICE);
    }
  });
});

// ── TwiML, per flow ─────────────────────────────────────────────────────────────────

describe("/voice/outbound", () => {
  function setup(ctx = callerCtx({ recording: ON })) {
    const net = new FakeNet().install();
    net.rpc("phone_caller_context", () => ctx);
    net.rest("GET", "crm_contacts", () => []);
    net.rest("GET", "phone_calls", () => []);
    net.rest("GET", "usage_prices", () => []);
    net.rest("GET", "wallet_accounts", () => []);
    net.rest("GET", "client_settings", () => []);
    net.rest("POST", "phone_calls", () => []);
    net.rest("POST", "phone_call_events", () => []);
    net.rest("POST", "app_errors", () => []);
    return net;
  }
  const dial = async (env = recEnv(), to = CUSTOMER) =>
    call(env, await twilioPost(env, "/voice/outbound", { CallSid: MY_LEG, From: IDENTITY_A, To: to, Direction: "inbound" }));

  it("armed: the customer's <Number> runs the announcement as its whisper, and the row is armed; never a record attribute", async () => {
    const net = setup();
    const { text } = await dial();
    const row = net.writes("phone_calls", "POST")[0].json;
    expect(attr(text, "Number", "url")).toBe(`https://phone.example.test/voice/notice?call=${row.id}&c=${CLIENT}&key=test-webhook-key`);
    expect(attr(text, "Number", "method")).toBe("POST");
    expect(row.recording_armed).toBe(true);
    expect(text).not.toMatch(/record=/i);
  });

  it.each([
    ["the rail off (the business on)", makeEnv(), callerCtx({ recording: ON })],
    ["the business off", recEnv(), callerCtx({ recording: { ...ON, on: false } })],
    ["the announcement off", recEnv(), callerCtx({ recording: { ...ON, notice: false } })],
    ["a database before 263 (no recording key)", recEnv(), callerCtx()],
  ])("not armed with %s: no whisper, no arm, no record attribute", async (_l, env, ctx) => {
    const net = setup(ctx as ReturnType<typeof callerCtx>);
    const { text } = await dial(env);
    expect(attr(text, "Number", "url")).toBeNull();
    expect(text).not.toMatch(/record=/i);
    expect(net.writes("phone_calls", "POST")[0].json).not.toHaveProperty("recording_armed");
  });

  it("an emergency call is never armed", async () => {
    const net = setup();
    const { text } = await dial(recEnv({ EMERGENCY_MODE: "allow" }), "911");
    expect(attr(text, "Number", "url")).toBeNull();
    expect(net.writes("phone_calls", "POST")[0].json).not.toHaveProperty("recording_armed");
  });
});

describe("/voice/inbound", () => {
  function setup(info: unknown) {
    const net = new FakeNet().install();
    net.rpc("phone_route_for_number", () => info);
    net.rest("GET", "crm_contacts", () => []);
    net.rest("GET", "phone_user_settings", () => []);
    net.rest("POST", "phone_calls", () => []);
    net.rest("POST", "phone_call_events", () => []);
    net.rest("POST", "app_errors", () => []);
    return net;
  }
  const ring = async (env = recEnv()) =>
    call(env, await twilioPost(env, "/voice/inbound", { CallSid: CALL_SID, From: CUSTOMER, To: BUSINESS_NUMBER, Direction: "inbound" }));

  it("armed: the announcement plays BEFORE the <Dial>, every <Client> says recorded=1, and the row is armed with a notice mark", async () => {
    const net = setup(routeInfo({ recording: ON }));
    const { text } = await ring();
    expect(text).toMatch(/^<\?xml[^>]*><Response><Say language="en-US">This call may be recorded\.<\/Say><Dial /);
    expect((text.match(/<Parameter name="recorded" value="1"\/>/g) ?? []).length).toBe(3);
    expect(text).not.toMatch(/record=/i);
    expect(net.writes("phone_calls", "POST")[0].json.recording_armed).toBe(true);
    expect(eventTypes(net)).toEqual(["twiml_served", "recording_notice"]);
  });

  it("says \"and transcribed\" while transcripts will be made, and a business's own sentence escaped", async () => {
    setup(routeInfo({ recording: ON }));
    expect((await ring(recEnv({ CALL_TRANSCRIBE: "on" }))).text).toContain("<Say language=\"en-US\">This call may be recorded and transcribed.</Say><Dial");
    setup(routeInfo({ recording: { ...ON, notice_text: "Calls with Bob & Sons <Sheds> are recorded." } }));
    expect((await ring()).text).toContain("<Say language=\"en-US\">Calls with Bob &amp; Sons &lt;Sheds&gt; are recorded.</Say><Dial");
  });

  it("after hours, forwarding: the announcement before the forward, and the cell's screen knows (r=1)", async () => {
    const closed = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
    setup(routeInfo({ recording: ON }, { business_hours: closed, after_hours: "forward", forward_to: "+15555550177" }));
    const { text } = await ring();
    expect(text).toMatch(/<Response><Say language="en-US">This call may be recorded\.<\/Say><Dial /);
    expect(attr(text, "Number", "url")).toMatch(/\/voice\/screen\?call=[0-9a-f-]{36}&b=Demo%20Sheds&r=1&key=/);
  });

  it.each([
    ["nobody can answer (straight to voicemail)", routeInfo({ recording: ON, members: [member(USER_A, { dnd: true })] }), recEnv()],
    ["the switch is off (voicemail)", routeInfo({ recording: ON, phone_status: "off" }), recEnv()],
    ["the 911 callback window", routeInfo({ recording: ON, recent_emergency_user: USER_A }), recEnv()],
    ["the rail off", routeInfo({ recording: ON }), makeEnv()],
    ["the business off", routeInfo({ recording: { ...ON, on: false } }), recEnv()],
  ])("no announcement and no arm when %s", async (_l, info, env) => {
    const net = setup(info);
    const { text } = await ring(env);
    expect(text).not.toContain("recorded");
    expect(text).not.toMatch(/record=/i);
    expect(net.writes("phone_calls", "POST")[0].json).not.toHaveProperty("recording_armed");
    expect(eventTypes(net)).not.toContain("recording_notice");
  });
});

describe("/voice/screen (a forwarded cell)", () => {
  it("on a recorded call the sentence says so, and the accept keeps r=1", async () => {
    const env = recEnv();
    new FakeNet().install();
    const { text } = await call(env, await twilioPost(env, "/voice/screen", { CallSid: MY_LEG }, { call: CALL_ID, b: "Demo Sheds", r: "1" }));
    expect(text).toContain("My Synergy Phone call for Demo Sheds. This call is recorded. Press 1 to answer.");
    expect(attr(text, "Gather", "action")).toContain("&r=1&step=accept");
  });

  it("without r=1, the sentence is as before", async () => {
    const env = recEnv();
    new FakeNet().install();
    const { text } = await call(env, await twilioPost(env, "/voice/screen", { CallSid: MY_LEG }, { call: CALL_ID, b: "Demo Sheds" }));
    expect(text).toContain("My Synergy Phone call for Demo Sheds, press 1 to answer.");
  });

  it("pressing 1 on a recorded call starts the recording on the customer's leg", async () => {
    const env = recEnv();
    const net = recordingNet(new FakeNet().install());
    net.rest("GET", "phone_calls", () => [liveCall({ status: "ringing", answered_by: null })]);
    net.rest("PATCH", "phone_calls", () => [{ id: CALL_ID }]);
    await call(env, await twilioPost(env, "/voice/screen", { CallSid: MY_LEG, Digits: "1" }, { call: CALL_ID, r: "1", step: "accept" }));
    expect(net.seen.filter((s) => isStart(s.url))).toHaveLength(1);
    expect(net.seen.find((s) => isStart(s.url))!.url.pathname).toContain(`/Calls/${CALL_SID}/Recordings.json`);
  });
});

describe("/voice/after-dial on a recorded call", () => {
  function setup(row: CallRow, info = routeInfo({ recording: ON })) {
    const net = recordingNet(new FakeNet().install(), { existing: recRow() });
    net.rest("GET", "phone_calls", () => [row]);
    net.rpc("phone_route_for_number", () => info);
    net.rest("PATCH", "phone_calls", () => [{ id: CALL_ID }]);
    return net;
  }
  const post = async (query: Record<string, string>, params: Record<string, string> = {}) => {
    const env = recEnv();
    return call(env, await twilioPost(env, "/voice/after-dial", {
      CallSid: CALL_SID, AccountSid: ACCOUNT, From: CUSTOMER, To: BUSINESS_NUMBER, Direction: "inbound", DialCallStatus: "no-answer", DialBridged: "false", ...params,
    }, { call: CALL_ID, ...query }));
  };

  it("an in-order re-ring marks its <Client> recorded, and does not announce again", async () => {
    const net = setup(liveCall({ status: "ringing", answered_by: null, rang_user_ids: [USER_A] }), routeInfo({ recording: ON }, { mode: "in_order" }));
    const { text } = await post({ stage: "order", p: "0" });
    expect(clientsIn(text)).toEqual([`u_${USER_B.replace(/-/g, "")}_g1`]);
    expect(text).toContain("<Parameter name=\"recorded\" value=\"1\"/>");
    expect(text).not.toContain("<Say");
    expect(recUpdates(net)).toEqual([]);
  });

  it("a transfer nobody took (transfer=1): the recording is STOPPED before the voicemail TwiML is returned", async () => {
    const net = setup(liveCall({ answered_by: null, transfer_state: "transferring", transferred_from: USER_A }));
    const { text } = await post({ transfer: "1" });
    expect(text).toContain("<Record");
    expect(recUpdates(net)).toEqual(["stopped"]);
    expect(eventTypes(net)).toContain("recording_stopped");
  });

  it("an armed call nobody ever answered has no recording: its voicemail waits on no read", async () => {
    const net = setup(liveCall({ status: "ringing", answered_by: null, answered_at: null, client_call_sid: null }));
    const { text } = await post({});
    expect(text).toContain("<Record");
    expect(net.reads("phone_call_recordings")).toEqual([]);
  });

  it("a call that is not armed reads no recording at all on its way to voicemail", async () => {
    const net = setup(liveCall({ answered_by: null, recording_armed: false, transfer_state: "transferring" }));
    await post({ transfer: "1" });
    expect(net.reads("phone_call_recordings")).toEqual([]);
  });
});

// ── The start ───────────────────────────────────────────────────────────────────────

describe("starting the one recording", () => {
  const answer = async (env = recEnv(), params: Record<string, string> = {}, query: Record<string, string> = {}) => call(env, await twilioPost(env, "/voice/status", {
    CallSid: MY_LEG, CallStatus: "in-progress", To: IDENTITY_A, AccountSid: ACCOUNT, ...params,
  }, { call: CALL_ID, leg: "client", ...query }));

  function setup(row: CallRow, opts: Parameters<typeof recordingNet>[1] = {}) {
    const net = recordingNet(new FakeNet().install(), opts);
    net.rest("GET", "phone_calls", () => [row]);
    net.rest("PATCH", "phone_calls", () => [{ id: CALL_ID }]);
    return net;
  }

  it("an app answering an armed call: claims the row, asks Twilio for a dual-channel recording of the CUSTOMER's leg, and marks it recording", async () => {
    const net = setup(liveCall({ status: "ringing", answered_by: null, client_call_sid: null }));
    const { res } = await answer();
    expect(res.status).toBe(204);
    const claim = net.writes("phone_call_recordings", "POST")[0];
    expect(claim.json).toEqual({ call_id: CALL_ID, client_id: CLIENT, status: "starting", notice_text: STANDARD_NOTICE });
    expect(claim.url.searchParams.get("on_conflict")).toBe("call_id");
    expect(claim.headers.get("prefer")).toContain("resolution=ignore-duplicates");
    const start = net.seen.find((s) => isStart(s.url))!;
    expect(start.url.pathname).toContain(`/Calls/${CALL_SID}/Recordings.json`);
    const params = new URLSearchParams(start.body);
    expect(params.get("RecordingChannels")).toBe("dual");
    expect(params.get("RecordingTrack")).toBe("both");
    expect(params.get("RecordingStatusCallback")).toBe(`https://phone.example.test/voice/recording?rec=${REC_ID}&key=test-webhook-key`);
    expect(params.getAll("RecordingStatusCallbackEvent")).toEqual(["in-progress", "completed", "absent"]);
    expect(start.body).not.toMatch(/Record=/);
    const moved = net.writes("phone_call_recordings", "PATCH")[0];
    expect(moved.json).toMatchObject({ status: "recording", recording_sid: REC_SID, channels: 2, channel_map: { 0: "customer", 1: "team" } });
    expect(moved.url.searchParams.get("status")).toBe("eq.starting");
    expect(eventTypes(net)).toContain("recording_started");
  });

  it("a second answer (or a duplicate callback) claims nothing and starts nothing", async () => {
    const net = setup(liveCall(), { claim: false, existing: recRow() });
    await answer();
    expect(net.seen.filter((s) => isStart(s.url))).toEqual([]);
    expect(recUpdates(net)).toEqual([]);
  });

  it("a cold-transfer teammate taking a customer who was on hold resumes the paused recording", async () => {
    const net = setup(liveCall({ answered_by: null, transferred_from: USER_B }), { claim: false, existing: recRow({ status: "paused" }) });
    await answer();
    expect(net.seen.filter((s) => isStart(s.url))).toEqual([]);
    expect(recUpdates(net)).toEqual(["in-progress"]);
    expect(recPatches(net)).toContainEqual({ status: "recording" });
  });

  it.each([
    ["an emergency call", liveCall({ is_emergency: true }), recEnv()],
    ["a call that was not armed", liveCall({ recording_armed: false }), recEnv()],
    ["the rail switched off since", liveCall(), makeEnv()],
  ])("never for %s: not even a read", async (_l, row, env) => {
    const net = setup(row);
    await answer(env);
    expect(net.writes("phone_call_recordings")).toEqual([]);
    expect(net.reads("phone_call_recordings")).toEqual([]);
    expect(net.seen.filter((s) => isStart(s.url))).toEqual([]);
  });

  it("Twilio refusing: the row says failed, the fault is logged (code and status only), and the call goes on", async () => {
    const net = setup(liveCall({ status: "ringing", answered_by: null }), { startStatus: 400 });
    const { res } = await answer();
    expect(res.status).toBe(204);
    expect(recPatches(net)[0]).toMatchObject({ status: "failed" });
    const fault = net.writes("app_errors")[0].json;
    expect(fault.code).toBe("recording_start_failed");
    expect(fault.message).toMatch(/HTTP 400, code 21220/);
    // The answer itself still landed.
    expect(net.writes("phone_calls", "PATCH")[0].json).toMatchObject({ status: "in_progress", answered_by: USER_A });
  });

  it.each([
    ["no answer at all (the POST may have landed)", 0],
    ["a 5xx", 503],
  ])("a start whose answer was lost or broken (%s) leaves the row starting, for Twilio's callback or the backstop", async (_l, status) => {
    const net = setup(liveCall({ status: "ringing", answered_by: null }));
    if (status === 0) net.on("POST", isStart, () => { throw new TypeError("network connection lost"); });
    else net.on("POST", isStart, () => jsonRes({ code: 20500 }, status));
    const { res } = await answer();
    expect(res.status).toBe(204);
    const patch = net.writes("phone_call_recordings", "PATCH")[0];
    expect(patch.json).not.toHaveProperty("status");
    expect(patch.json.last_error).toMatch(/Twilio start recording/);
    expect(patch.url.searchParams.get("status")).toBe("eq.starting");
    expect(net.writes("app_errors")[0].json.message).toMatch(/lost or broken/);
    expect(eventTypes(net)).not.toContain("recording_failed");
  });

  it("a 2xx with no SID is the same: Twilio may be recording", async () => {
    const net = setup(liveCall({ status: "ringing", answered_by: null }));
    net.on("POST", isStart, () => jsonRes({ status: "in-progress" }, 201));
    await answer();
    expect(net.writes("phone_call_recordings", "PATCH")[0].json).not.toHaveProperty("status");
  });

  it("a start that failed before is tried again by the next answer (a transfer)", async () => {
    const env = recEnv();
    const net = setup(liveCall(), { claim: false, existing: recRow({ status: "failed", recording_sid: null }) });
    expect(await startCallRecording(env, adminClient(env), liveCall())).toBe("started");
    expect(recPatches(net)[0]).toEqual({ status: "starting", last_error: null });
    expect(net.seen.filter((s) => isStart(s.url))).toHaveLength(1);
  });

  it("an OUTBOUND call starts when the customer picks up, on the leg the callback names", async () => {
    const net = setup(liveCall({ direction: "out", from_e164: BUSINESS_NUMBER, to_e164: CUSTOMER, placed_by: USER_A, answered_by: null, twilio_call_sid: null, status: "ringing" }));
    await answer(recEnv(), { CallSid: CALL_SID, To: CUSTOMER }, { leg: "pstn" });
    expect(net.seen.find((s) => isStart(s.url))!.url.pathname).toContain(`/Calls/${CALL_SID}/Recordings.json`);
  });
});

// ── Pause, resume, stop ─────────────────────────────────────────────────────────────

describe("hold, resume and voicemail", () => {
  async function appSetup(row: CallRow, existing: Record<string, unknown> | null = recRow(), conference: unknown = null) {
    const net = recordingNet(new FakeNet().install(), { existing });
    const auth = await new Auth().init();
    auth.serve(net);
    net.rpc("phone_caller_context", (s) => (s.json.p_user_id === USER_A ? callerCtx() : callerCtx({ device_generation: 3 })));
    net.rest("GET", "phone_calls", () => [row]);
    net.rest("GET", "phone_user_settings", () => []);
    net.rpc("phone_route_for_number", () => routeInfo());
    net.rest("PATCH", "phone_calls", () => [{ id: CALL_ID }]);
    net.rest("GET", "phone_call_events", () => []);
    net.on("POST", (u) => api.test(u.href) && /\/Calls\/CA[0-9a-f]+\.json$/.test(u.pathname), (s) => jsonRes({ sid: s.url.pathname.split("/").pop() }));
    net.on("GET", (u) => api.test(u.href) && /\/Calls\/CA[0-9a-f]+\.json$/.test(u.pathname), (s) => jsonRes({ sid: s.url.pathname.split("/").pop()!.replace(".json", ""), status: "completed" }));
    net.on("GET", (u) => api.test(u.href) && u.pathname.endsWith("/Conferences.json"), () => jsonRes({ conferences: conference ? [conference] : [] }));
    net.on("GET", (u) => api.test(u.href) && /\/Participants\.json$/.test(u.pathname), () =>
      jsonRes({ participants: [{ call_sid: CALL_SID, hold: false, muted: false, status: "connected", start_conference_on_enter: false }] }));
    net.on("POST", (u) => api.test(u.href) && /\/Participants\/CA[0-9a-f]+\.json$/.test(u.pathname), () => jsonRes({}));
    return { net, token: await auth.token(USER_A) };
  }
  const press = (token: string, what: string, body: unknown = {}) => call(recEnv(), appRequest("POST", `/calls/${CALL_ID}/${what}`, token, body));

  it("Hold pauses the recording (PauseBehavior skip), so hold music never reaches the audio or the transcript", async () => {
    const { net, token } = await appSetup(liveCall());
    const { res } = await press(token, "hold");
    expect(res.status).toBe(200);
    const upd = net.seen.find((s) => s.method === "POST" && isUpdate(s.url))!;
    expect(upd.url.pathname).toContain(`/Calls/${CALL_SID}/Recordings/${REC_SID}.json`);
    expect(form(upd)).toEqual({ Status: "paused", PauseBehavior: "skip" });
    expect(recPatches(net)).toEqual([{ status: "paused" }]);
    expect(eventTypes(net)).toContain("recording_paused");
  });

  it("Resume picks it up again", async () => {
    const { net, token } = await appSetup(liveCall({ transfer_state: "conference" }), recRow({ status: "paused" }), { sid: CONF, friendly_name: CALL_ID, status: "in-progress" });
    const { res } = await press(token, "resume");
    expect(res.status).toBe(200);
    expect(recUpdates(net)).toEqual(["in-progress"]);
    expect(recPatches(net)).toEqual([{ status: "recording" }]);
  });

  it("a second Hold (already paused) and a call not armed change nothing at Twilio", async () => {
    const a = await appSetup(liveCall({ transfer_state: "conference" }), recRow({ status: "paused" }), { sid: CONF, friendly_name: CALL_ID, status: "in-progress" });
    await press(a.token, "hold");
    expect(recUpdates(a.net)).toEqual([]);
    const b = await appSetup(liveCall({ recording_armed: false }));
    await press(b.token, "hold");
    expect(b.net.reads("phone_call_recordings")).toEqual([]);
  });

  it("a cold transfer to a teammate on DND: the recording is paused BEFORE the customer is sent to voicemail, and stopped once they are", async () => {
    const { net, token } = await appSetup(liveCall());
    net.rest("GET", "phone_user_settings", () => [{ dnd: true, dnd_until: null }]);
    const { res } = await press(token, "transfer", { to_user_id: USER_B });
    expect(res.status).toBe(200);
    const updates = net.seen.map((s, i) => ({ s, i })).filter(({ s }) => s.method === "POST" && isUpdate(s.url));
    const redirect = net.seen.findIndex((s) => s.method === "POST" && s.url.pathname.endsWith(`/Calls/${CALL_SID}.json`));
    expect(updates.map(({ s }) => form(s).Status)).toEqual(["paused", "stopped"]);
    expect(form(updates[0].s)).toEqual({ Status: "paused", PauseBehavior: "skip" });
    expect(updates[0].i).toBeLessThan(redirect);
    expect(updates[1].i).toBeGreaterThan(redirect);
    expect(new URLSearchParams(net.seen[redirect].body).get("Twiml")).toContain("<Record");
  });

  it("a DND transfer whose redirect fails: the recording is resumed, never stopped, and the rest of the call is recorded", async () => {
    const { net, token } = await appSetup(liveCall());
    net.rest("GET", "phone_user_settings", () => [{ dnd: true, dnd_until: null }]);
    // The row as the database keeps it: the pause writes paused, which the resume then reads.
    let status = "recording";
    net.rest("GET", "phone_call_recordings", () => [recRow({ status })]);
    net.rest("PATCH", "phone_call_recordings", (s) => { if (s.json?.status) status = s.json.status; return [{ id: REC_ID }]; });
    net.on("POST", (u) => api.test(u.href) && u.pathname.endsWith(`/Calls/${CALL_SID}.json`), () => jsonRes({ code: 20500 }, 500));
    const { res, json } = await press(token, "transfer", { to_user_id: USER_B });
    expect(res.status).toBe(502);
    expect(json.error.message).toBe("The transfer didn't go through. You're still on the call.");
    expect(recUpdates(net)).toEqual(["paused", "in-progress"]);
    expect(status).toBe("recording");
  });

  it("a cold transfer rings the teammate with recorded=1", async () => {
    const { net, token } = await appSetup(liveCall());
    await press(token, "transfer", { to_user_id: USER_B });
    const xml = new URLSearchParams(net.seen.find((s) => s.method === "POST" && s.url.pathname.endsWith(`/Calls/${CALL_SID}.json`))!.body).get("Twiml")!;
    expect(xml).toContain("<Parameter name=\"recorded\" value=\"1\"/>");
    expect(recUpdates(net)).toEqual([]); // the recording goes on through the ring
  });

  it("a cold transfer to a teammate on DND who chose a cover rings the cover, recorded=1, and never pauses (migration 264)", async () => {
    const { net, token } = await appSetup(liveCall());
    net.rest("GET", "phone_user_settings", (s) => (filter(s, "user_id") === USER_B ? [{ dnd: true, dnd_until: null, dnd_cover_user_id: USER_C }] : []));
    const { res } = await press(token, "transfer", { to_user_id: USER_B });
    expect(res.status).toBe(200);
    const xml = new URLSearchParams(net.seen.find((s) => s.method === "POST" && s.url.pathname.endsWith(`/Calls/${CALL_SID}.json`))!.body).get("Twiml")!;
    expect(clientsIn(xml)).toEqual([`u_${USER_C.replace(/-/g, "")}_g3`]);
    expect(xml).toContain("<Parameter name=\"recorded\" value=\"1\"/>");
    expect(recUpdates(net)).toEqual([]);
  });

  it("a customer left alone in the conference: stopped BEFORE the voicemail redirect", async () => {
    const env = recEnv();
    const { net } = await appSetup(liveCall({ transfer_state: "conference" }), recRow(), { sid: CONF, friendly_name: CALL_ID, status: "in-progress" });
    await call(env, await twilioPost(env, "/voice/conference", {
      StatusCallbackEvent: "participant-leave", ConferenceSid: CONF, FriendlyName: CALL_ID, CallSid: MY_LEG, AccountSid: ACCOUNT,
    }, { call: CALL_ID }));
    const stop = net.seen.findIndex((s) => s.method === "POST" && isUpdate(s.url));
    const redirect = net.seen.findIndex((s) => s.method === "POST" && s.url.pathname.endsWith(`/Calls/${CALL_SID}.json`));
    expect(stop).toBeGreaterThan(-1);
    expect(stop).toBeLessThan(redirect);
    expect(new URLSearchParams(net.seen[redirect].body).get("Twiml")).toContain("<Record");
  });

  it("each change is best effort: Twilio refusing a pause is logged and the press still answers ok", async () => {
    const env = recEnv();
    const net = recordingNet(new FakeNet().install(), { existing: recRow() });
    net.on("POST", isUpdate, () => jsonRes({ code: 21220 }, 400));
    expect(await pauseCallRecording(env, adminClient(env), liveCall())).toBe("failed");
    expect(net.writes("app_errors")[0].json.code).toBe("recording_pause_failed");
    // A recording already finished (404) is what a stop wanted: nothing to log.
    const net2 = recordingNet(new FakeNet().install(), { existing: recRow() });
    net2.on("POST", isUpdate, () => jsonRes({ code: 20404 }, 404));
    expect(await stopCallRecording(env, adminClient(env), liveCall())).toBe("none");
    expect(net2.writes("app_errors")).toEqual([]);
    expect(await resumeCallRecording(env, adminClient(env), liveCall({ recording_armed: false }))).toBe("none");
  });
});

// ── Twilio's callback, the whisper, the backstop ────────────────────────────────────

describe("/voice/recording (Twilio's recording status callback)", () => {
  function setup(row: Record<string, unknown>, settings: unknown[] = [{ phone_transcribe_calls: true }]) {
    const net = new FakeNet().install();
    net.rest("GET", "phone_call_recordings", () => [{ ...row, phone_calls: { twilio_call_sid: CALL_SID } }]);
    net.rest("PATCH", "phone_call_recordings", () => [{ id: REC_ID }]);
    net.rest("GET", "client_settings", () => settings);
    net.rest("POST", "phone_call_events", () => []);
    net.rest("POST", "app_errors", () => []);
    return net;
  }
  const cb = async (params: Record<string, string>, env = recEnv(), opts: { signWith?: string } = {}) =>
    call(env, await twilioPost(env, "/voice/recording", { AccountSid: ACCOUNT, CallSid: CALL_SID, RecordingSid: REC_SID, ...params }, { rec: REC_ID }, opts));

  it("answers 204, and in-progress on a row still starting takes the SID", async () => {
    const net = setup(recRow({ status: "starting", recording_sid: null }));
    const { res } = await cb({ RecordingStatus: "in-progress", RecordingStartTime: "Sun, 04 Oct 2026 10:00:00 +0000" });
    expect(res.status).toBe(204);
    expect(recPatches(net)[0]).toEqual({ status: "recording", recording_sid: REC_SID, started_at: "2026-10-04T10:00:00.000Z" });
  });

  it("completed: the length, and the transcript queued (the rail on, the business transcribing)", async () => {
    const net = setup(recRow());
    await cb({ RecordingStatus: "completed", RecordingDuration: "125" }, recEnv({ CALL_TRANSCRIBE: "on" }));
    const p = net.writes("phone_call_recordings", "PATCH")[0];
    expect(p.json).toMatchObject({ status: "completed", recording_sid: REC_SID, duration_s: 125, transcript_status: "pending" });
    expect(p.url.searchParams.get("status")).toBe("in.(starting,recording,paused)"); // a repeat changes nothing
    expect(eventTypes(net)).toContain("recording_completed");
  });

  it.each([
    ["the rail off", recEnv(), [{ phone_transcribe_calls: true }], "125"],
    ["the business not transcribing", recEnv({ CALL_TRANSCRIBE: "on" }), [{ phone_transcribe_calls: false }], "125"],
    ["a recording too short to say anything", recEnv({ CALL_TRANSCRIBE: "on" }), [{ phone_transcribe_calls: true }], "3"],
  ])("completed with %s: no transcript", async (_l, env, settings, duration) => {
    const net = setup(recRow(), settings);
    await cb({ RecordingStatus: "completed", RecordingDuration: duration }, env);
    expect(recPatches(net)[0]).toMatchObject({ status: "completed", transcript_status: "off", next_try_at: null });
  });

  it("absent: Twilio heard nothing", async () => {
    const net = setup(recRow());
    await cb({ RecordingStatus: "absent" });
    expect(recPatches(net)[0]).toMatchObject({ status: "absent", recording_sid: REC_SID });
  });

  it("a callback about another recording is ignored (and said so, once)", async () => {
    const net = setup(recRow({ recording_sid: "RE" + "0".repeat(31) + "9" }));
    await cb({ RecordingStatus: "completed", RecordingDuration: "60" });
    expect(recPatches(net)).toEqual([]);
    expect(net.writes("app_errors")[0].json.code).toBe("recording_callback_mismatch");
  });

  it("unsigned (TWILIO_AUTH_TOKEN unset): completed counts only when Twilio has the recording, with Twilio's length", async () => {
    const env = recEnv({ TWILIO_AUTH_TOKEN: "" });
    const net = setup(recRow());
    net.on("GET", (u) => api.test(u.href) && u.pathname.endsWith(`/Recordings/${REC_SID}.json`), () => jsonRes({ code: 20404 }, 404));
    await cb({ RecordingStatus: "completed", RecordingDuration: "9999" }, env);
    expect(recPatches(net)).toEqual([]);
    net.on("GET", (u) => api.test(u.href) && u.pathname.endsWith(`/Recordings/${REC_SID}.json`), () =>
      jsonRes({ sid: REC_SID, duration: "61", price: null, call_sid: CALL_SID, source: "StartCallRecordingAPI" }));
    await cb({ RecordingStatus: "completed", RecordingDuration: "9999" }, env);
    expect(recPatches(net)[0]).toMatchObject({ status: "completed", duration_s: 61 });
  });

  it.each([
    ["another call's recording (another business's, say)", { call_sid: "CA" + "0".repeat(31) + "e", source: "StartCallRecordingAPI" }],
    ["a voicemail, not a call recording", { call_sid: CALL_SID, source: "RecordVerb" }],
  ])("unsigned, a row still starting never takes %s", async (_l, twilio) => {
    const env = recEnv({ TWILIO_AUTH_TOKEN: "" });
    const net = setup(recRow({ status: "starting", recording_sid: null }));
    net.on("GET", (u) => api.test(u.href) && u.pathname.endsWith(`/Recordings/${REC_SID}.json`), () => jsonRes({ sid: REC_SID, duration: "61", price: null, ...twilio }));
    for (const s of ["in-progress", "completed", "absent"]) await cb({ RecordingStatus: s, RecordingDuration: "61" }, env);
    expect(recPatches(net)).toEqual([]);
    expect(net.writes("app_errors").map((w) => w.json.code)).toContain("recording_callback_unverified");
  });

  it("unsigned, in-progress binds the SID once Twilio says it is this call's recording", async () => {
    const env = recEnv({ TWILIO_AUTH_TOKEN: "" });
    const net = setup(recRow({ status: "starting", recording_sid: null }));
    net.on("GET", (u) => api.test(u.href) && u.pathname.endsWith(`/Recordings/${REC_SID}.json`), () =>
      jsonRes({ sid: REC_SID, duration: null, price: null, call_sid: CALL_SID, source: "StartCallRecordingAPI" }));
    await cb({ RecordingStatus: "in-progress" }, env);
    expect(recPatches(net)[0]).toMatchObject({ status: "recording", recording_sid: REC_SID });
  });
});

describe("/voice/notice (the outbound whisper)", () => {
  it("says the business's own sentence, escaped, and marks the call", async () => {
    const env = recEnv();
    const net = new FakeNet().install();
    net.rest("GET", "client_settings", (s) => (filter(s, "client_id") === CLIENT ? [{ phone_recording_notice_text: "Calls with Bob & Sons are recorded.", phone_transcribe_calls: true }] : []));
    net.rest("POST", "phone_call_events", () => []);
    const { res, text } = await call(env, await twilioPost(env, "/voice/notice", { CallSid: CALL_SID, AccountSid: ACCOUNT }, { call: CALL_ID, c: CLIENT }));
    expect(res.headers.get("content-type")).toContain("text/xml");
    expect(text).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Say language="en-US">Calls with Bob &amp; Sons are recorded.</Say></Response>');
    expect(net.writes("phone_call_events")[0].json).toMatchObject({ call_id: CALL_ID, type: "recording_notice", data: { leg: "out" } });
  });

  it("with no business on the URL it says the standard sentence and reads nothing", async () => {
    const env = recEnv();
    const net = new FakeNet().install();
    net.rest("GET", "client_settings", () => []);
    const { text } = await call(env, await twilioPost(env, "/voice/notice", { CallSid: CALL_SID }, { call: CALL_ID }));
    expect(text).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Say language="en-US">This call may be recorded.</Say></Response>');
    expect(net.reads("client_settings")).toHaveLength(0);
  });

  it("a read that fails still announces, in the standard words", async () => {
    const env = recEnv();
    const net = new FakeNet().install();
    net.rest("GET", "client_settings", () => new Response(JSON.stringify({ message: "down" }), { status: 500 }));
    net.rest("POST", "app_errors", () => []);
    const { text } = await call(env, await twilioPost(env, "/voice/notice", { CallSid: CALL_SID }, { call: CALL_ID, c: CLIENT }));
    expect(text).toContain(`<Say language="en-US">${STANDARD_NOTICE}</Say>`);
  });
});

describe("retention (daily): each business's own days", () => {
  it("deletes the audio at Twilio, then the transcript with it, and keeps the summary; a failure is retried tomorrow", async () => {
    const env = recEnv();
    installDenoShim(env);
    const net = new FakeNet().install();
    const R = (n: number) => "RE" + String(n).padStart(32, "0");
    net.rpc("phone_recordings_expired", () => [
      { id: "r1", call_id: CALL_ID, client_id: CLIENT, recording_sid: R(1) },
      { id: "r2", call_id: CALL_ID, client_id: CLIENT, recording_sid: R(2) },
      { id: "r3", call_id: CALL_ID, client_id: CLIENT, recording_sid: R(3) },
      { id: "r4", call_id: CALL_ID, client_id: CLIENT, recording_sid: null },
    ]);
    net.on("DELETE", /Recordings\/RE0+1\.json$/, () => new Response(null, { status: 204 }));
    net.on("DELETE", /Recordings\/RE0+2\.json$/, () => jsonRes({ code: 20404 }, 404)); // already gone
    net.on("DELETE", /Recordings\/RE0+3\.json$/, () => jsonRes({ code: 20500 }, 500));
    net.rest("PATCH", "phone_call_recordings", () => []);
    net.rest("POST", "app_errors", () => []);
    const now = new Date("2026-10-04T09:00:00Z");
    const { recordingRetention } = await import("../src/cron/retention");
    expect(await recordingRetention(env, now)).toEqual({ deleted: 3, failed: 1 });
    expect(net.rpcCalls("phone_recordings_expired")[0].json).toEqual({ p_now: now.toISOString(), p_limit: 200 });
    const patches = net.writes("phone_call_recordings", "PATCH");
    expect(patches.map((s) => filter(s, "id"))).toEqual(["r1", "r2", "r4"]);
    for (const p of patches) {
      expect(Object.keys(p.json).sort()).toEqual(["deleted_at", "transcript", "transcript_json"]); // the summary is not touched
      expect(p.json).toMatchObject({ transcript: null, transcript_json: null });
      expect(p.url.searchParams.get("deleted_at")).toBe("is.null");
    }
    expect(net.writes("app_errors")[0].json.code).toBe("call_recording_retention_failed");
  });
});

describe("the sweep's backstop (a lost completed callback)", () => {
  const ended = (minutesAgo: number) => new Date(Date.parse("2026-10-04T12:00:00Z") - minutesAgo * 60_000).toISOString();
  const now = new Date("2026-10-04T12:00:00Z");

  it("completes a recording Twilio finished, queues nothing when transcripts are off, and leaves a live call alone", async () => {
    const env = recEnv();
    installDenoShim(env);
    const net = new FakeNet().install();
    net.rest("GET", "phone_call_recordings", () => [
      { ...recRow({ id: REC_ID }), created_at: ended(30), phone_calls: { twilio_call_sid: CALL_SID, ended_at: ended(20) } },
      { ...recRow({ id: "00000000-0000-4000-8000-0000000ae002", recording_sid: null, status: "starting" }), created_at: ended(90), phone_calls: { twilio_call_sid: "CA" + "0".repeat(31) + "2", ended_at: ended(80) } },
      { ...recRow({ id: "00000000-0000-4000-8000-0000000ae003" }), created_at: ended(15), phone_calls: { twilio_call_sid: "CA" + "0".repeat(31) + "3", ended_at: null } },
    ]);
    net.on("GET", (u) => u.pathname.endsWith(`/Calls/${CALL_SID}/Recordings.json`), () =>
      jsonRes({ recordings: [{ sid: REC_SID, call_sid: CALL_SID, source: "StartCallRecordingAPI", status: "completed", duration: "300", date_created: "x" }] }));
    net.on("GET", (u) => u.pathname.endsWith("/Recordings.json") && u.pathname.includes("CA" + "0".repeat(31) + "2"), () => jsonRes({ recordings: [] }));
    net.rest("PATCH", "phone_call_recordings", () => [{ id: REC_ID }]);
    net.rest("POST", "phone_call_events", () => []);
    net.rest("POST", "app_errors", () => []);
    const out = await recordingBackstop(env, adminClient(env), now);
    expect(out).toEqual({ checked: 2, completed: 1, failed: 1 });
    const p = recPatches(net);
    expect(p[0]).toMatchObject({ status: "completed", duration_s: 300, transcript_status: "off" });
    expect(p[1]).toMatchObject({ status: "failed", last_error: "Twilio has no recording for this call." });
    expect(net.to(/CA0+3\/Recordings/)).toEqual([]);
  });
});
