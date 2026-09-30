// Hold, resume and warm transfer (plan 9C, design b): the TwiML, the transfer_state machine,
// the three app endpoints, and the Twilio side (after-dial, the warm leg, the conference
// callback). Twilio's REST API is a stub here; what only a live call can prove is listed in
// DEVIATIONS ("Not verified here").
import { describe, expect, it } from "vitest";
import {
  conferenceTwiml, EMERGENCY_CALLBACK, HOLD_MUSIC, legsOf, nextTransferState, onTheCall, type CallAction,
} from "../src/conference";
import type { CallRow } from "../src/db";
import worker from "../src/index";
import { updateParticipant } from "../src/twilioRest";
import {
  Auth, BUSINESS_NUMBER, CALL_SID, CLIENT, CONTACT_1, CUSTOMER, FakeCtx, FakeNet, NUMBER_ID, USER_A, USER_B, USER_C,
  appRequest, attr, call, callerCtx, eventRows, filter, jsonRes, makeEnv, routeInfo, twilioPost, type EventFixture, type Seen,
} from "./helpers";

const CALL_ID = "00000000-0000-4000-8000-0000000ca444";
const MY_LEG = "CA" + "0".repeat(31) + "5";
const TEAMMATE_LEG = "CA" + "0".repeat(31) + "6";
const CONF = "CF" + "0".repeat(31) + "1";
const ACCOUNT = "AC" + "0".repeat(32);
const env = makeEnv();

function liveCall(over: Partial<CallRow> = {}): CallRow {
  return {
    id: CALL_ID, client_id: CLIENT, number_id: NUMBER_ID, contact_id: null, direction: "in",
    from_e164: CUSTOMER, to_e164: BUSINESS_NUMBER, twilio_call_sid: CALL_SID, client_call_sid: MY_LEG,
    placed_by: null, answered_by: USER_A, rang_user_ids: [USER_A], transferred_from: null, transfer_state: null,
    status: "in_progress", started_at: new Date(Date.now() - 120_000).toISOString(), answered_at: new Date(Date.now() - 100_000).toISOString(),
    ended_at: null, duration_s: null, error_code: null, is_emergency: false, ...over,
  };
}

const outboundCall = (over: Partial<CallRow> = {}) => liveCall({
  direction: "out", from_e164: BUSINESS_NUMBER, to_e164: CUSTOMER, placed_by: USER_A, answered_by: null, ...over,
});

type Participant = { call_sid: string; hold: boolean; muted: boolean; status: string; start_conference_on_enter?: boolean };

/** The Twilio REST stubs, recording what the Worker asked for. */
interface TwilioStub {
  conference?: { sid: string; friendly_name: string; status: string } | null;
  participants?: Participant[];
  callStatus?: Record<string, string>;
  /** `to` of a fetched call, by CallSid. */
  callTo?: Record<string, string>;
  failRedirect?: boolean;
  /** Only the Twiml redirects (a move): Twilio refuses (21220), or the request gets no answer. */
  move?: "refused" | "unreachable";
  /** HTTP status a Participants update (hold / unhold) answers with. */
  participantStatus?: number;
  failAdd?: boolean;
}

function stubTwilio(net: FakeNet, t: TwilioStub = {}) {
  const api = /^https:\/\/api\.twilio\.com\/2010-04-01\/Accounts\/AC0+/;
  net.on("POST", (u) => api.test(u.href) && /\/Calls\/CA[0-9a-f]+\.json$/.test(u.pathname), (s) => {
    const isMove = new URLSearchParams(s.body).has("Twiml");
    if (isMove && t.move === "unreachable") throw new Error("connection reset");
    if (t.failRedirect || (isMove && t.move === "refused")) return jsonRes({ code: 21220 }, 400);
    return jsonRes({ sid: s.url.pathname.split("/").pop()!.replace(".json", "") });
  });
  net.on("GET", (u) => api.test(u.href) && /\/Calls\/CA[0-9a-f]+\.json$/.test(u.pathname), (s) => {
    const sid = s.url.pathname.split("/").pop()!.replace(".json", "");
    return jsonRes({ sid, status: t.callStatus?.[sid] ?? "completed", to: t.callTo?.[sid] ?? "" });
  });
  net.on("GET", (u) => api.test(u.href) && u.pathname.endsWith("/Conferences.json"), () =>
    jsonRes({ conferences: t.conference ? [t.conference] : [] }));
  net.on("GET", (u) => api.test(u.href) && /\/Conferences\/CF[0-9a-f]+\.json$/.test(u.pathname), () =>
    (t.conference ? jsonRes(t.conference) : jsonRes({ code: 20404 }, 404)));
  net.on("GET", (u) => api.test(u.href) && /\/Conferences\/CF[0-9a-f]+\/Participants\.json$/.test(u.pathname), () =>
    jsonRes({ participants: t.participants ?? [] }));
  net.on("POST", (u) => api.test(u.href) && /\/Conferences\/CF[0-9a-f]+\/Participants\/CA[0-9a-f]+\.json$/.test(u.pathname), (s) => {
    if (t.participantStatus && t.participantStatus >= 400) return jsonRes({ code: 20404 }, t.participantStatus);
    // As Twilio answered live (2026-09-30): Hold=false on a leg that is not on a Participants
    // hold is refused, HTTP 400 with code 400.
    const leg = t.participants?.find((p) => s.url.pathname.endsWith(`/${p.call_sid}.json`));
    if (new URLSearchParams(s.body).get("Hold") === "false" && leg && leg.hold !== true) return jsonRes({ code: 400 }, 400);
    return jsonRes({});
  });
  net.on("POST", (u) => api.test(u.href) && /\/Conferences\/[0-9a-f-]{36}\/Participants\.json$/.test(u.pathname), () =>
    (t.failAdd ? jsonRes({ code: 21210 }, 400) : jsonRes({ call_sid: TEAMMATE_LEG })));
}

const customerIn = (hold = false): Participant => ({ call_sid: CALL_SID, hold, muted: false, status: "connected", start_conference_on_enter: false });
/** Whoever holds the call for us; `start` when they joined with startConferenceOnEnter=true (Resume). */
const agentIn = (start = false, sid = MY_LEG): Participant => ({ call_sid: sid, hold: false, muted: false, status: "connected", start_conference_on_enter: start });
const inProgress = { sid: CONF, friendly_name: CALL_ID, status: "in-progress" };

/**
 * A plain Hold as Twilio showed it on a live call (2026-09-30): the conference reads
 * in-progress, both legs connected, nobody held, nobody joined with start=true. It has NOT
 * started: the customer hears wait music and the two are not connected.
 */
const plainHold = (over: TwilioStub = {}): TwilioStub => ({ conference: inProgress, participants: [customerIn(), agentIn()], ...over });

/** After Resume: your leg re-joined with start=true, so the list itself proves it started. */
const resumedRoom = (customerHeld = false, over: TwilioStub = {}): TwilioStub =>
  ({ conference: inProgress, participants: [customerIn(customerHeld), agentIn(true)], ...over });

/** Twilio's `start` event for a conference, as the Worker records it. */
const startedEvent = (conferenceSid = CONF, data: Record<string, unknown> = {}): EventFixture => ({
  call_id: CALL_ID, type: "conference_started", at: new Date(Date.now() - 50_000).toISOString(), data: { conference_sid: conferenceSid, ...data },
});

const redirects = (net: FakeNet) => net.to(/\/Calls\/CA[0-9a-f]+\.json$/).filter((s) => s.method === "POST").map((s) => ({
  sid: s.url.pathname.split("/").pop()!.replace(".json", ""),
  twiml: new URLSearchParams(s.body).get("Twiml"),
  status: new URLSearchParams(s.body).get("Status"),
}));
const participantUpdates = (net: FakeNet) => net.to(/\/Participants\/CA[0-9a-f]+\.json$/).map((s) => ({
  sid: s.url.pathname.split("/").pop()!.replace(".json", ""),
  form: Object.fromEntries(new URLSearchParams(s.body)),
}));
const patches = (net: FakeNet) => net.writes("phone_calls", "PATCH").map((s: Seen) => ({ body: s.json, url: decodeURIComponent(s.url.search) }));
const events = (net: FakeNet) => net.writes("phone_call_events").map((s) => s.json.type);

// ── Pure parts ──────────────────────────────────────────────────────────────────────

describe("the transfer_state machine", () => {
  const table: [CallRow["transfer_state"], CallAction, string][] = [
    [null, "cold", "transferring"], [null, "hold", "conference+move"], [null, "warm", "conference+move"], [null, "resume", "refused"],
    ["conference", "cold", "transferring"], ["conference", "hold", "conference"], ["conference", "warm", "conference"], ["conference", "resume", "conference"],
    ["transferring", "cold", "refused"], ["transferring", "hold", "refused"], ["transferring", "warm", "refused"], ["transferring", "resume", "refused"],
  ];
  it.each(table)("%s + %s → %s", (from, action, expected) => {
    const step = nextTransferState(from, action);
    const got = !step.ok ? "refused" : `${step.next}${step.move ? "+move" : ""}`;
    expect(got).toBe(expected);
  });

  it("says why it refused, in plain English", () => {
    expect(nextTransferState("transferring", "cold")).toEqual({ ok: false, message: "A transfer is already under way." });
    expect(nextTransferState(null, "resume")).toEqual({ ok: false, message: "That call isn't on hold." });
  });
});

describe("which leg is which", () => {
  it("inbound: the customer is the parent, so the answering leg is the one moved", () => {
    expect(legsOf(liveCall())).toEqual({ customer: CALL_SID, agent: MY_LEG, child: MY_LEG, childRole: "agent" });
  });
  it("outbound: the customer is the child of the app's Dial", () => {
    expect(legsOf(outboundCall())).toEqual({ customer: CALL_SID, agent: MY_LEG, child: CALL_SID, childRole: "customer" });
  });
  it("outbound after a cold transfer: the customer now leads its own Dial, so the teammate's leg is moved", () => {
    const handed = outboundCall({ transferred_from: USER_A, answered_by: USER_B, client_call_sid: TEAMMATE_LEG });
    expect(legsOf(handed)).toEqual({ customer: CALL_SID, agent: TEAMMATE_LEG, child: TEAMMATE_LEG, childRole: "agent" });
  });
  it("who is on the call", () => {
    expect(onTheCall(USER_A, liveCall())).toBe(true);
    expect(onTheCall(USER_B, liveCall())).toBe(false);
    expect(onTheCall(USER_A, outboundCall())).toBe(true);
    // A warm transferrer may still act while the call is in its conference, not after.
    const warm = liveCall({ answered_by: USER_B, transferred_from: USER_A, transfer_state: "conference" });
    expect(onTheCall(USER_A, warm)).toBe(true);
    expect(onTheCall(USER_A, { ...warm, transfer_state: null })).toBe(false);
  });
});

describe("conference TwiML", () => {
  it("the customer waits on Twilio's default music, and their leaving ends it; never an action, never voicemail", () => {
    const xml = conferenceTwiml(env, CALL_ID, "customer");
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Dial><Conference beep="false" startConferenceOnEnter="false" endConferenceOnExit="true" '
      + `statusCallback="https://phone.example.test/voice/conference?call=${CALL_ID}&amp;key=test-webhook-key" statusCallbackEvent="start leave" statusCallbackMethod="POST">`
      + `${CALL_ID}</Conference></Dial></Response>`,
    );
    expect(xml).not.toContain("waitUrl");
    expect(attr(xml, "Dial", "action")).toBeNull();
  });

  it("every way in asks for Twilio's `start` event (the first leg in sets the events for the whole conference)", () => {
    for (const xml of [conferenceTwiml(env, CALL_ID, "customer"), conferenceTwiml(env, CALL_ID, "agent"), conferenceTwiml(env, CALL_ID, "agent", true)]) {
      expect(attr(xml, "Conference", "statusCallbackEvent")).toBe("start leave");
    }
  });

  it("the agent waits in silence and does not start it (that IS hold); resume joins with start=true", () => {
    const held = conferenceTwiml(env, CALL_ID, "agent");
    expect(attr(held, "Conference", "startConferenceOnEnter")).toBe("false");
    expect(attr(held, "Conference", "endConferenceOnExit")).toBe("false");
    expect(attr(held, "Conference", "waitUrl")).toBe("");
    const live = conferenceTwiml(env, CALL_ID, "agent", true);
    expect(attr(live, "Conference", "startConferenceOnEnter")).toBe("true");
  });
});

// ── after-dial ──────────────────────────────────────────────────────────────────────

describe("/voice/after-dial with the conference", () => {
  function setup(row: CallRow | null) {
    const net = new FakeNet().install();
    net.rest("GET", "phone_calls", () => (row ? [row] : []));
    net.rpc("phone_route_for_number", () => routeInfo());
    net.rest("PATCH", "phone_calls", () => [{ id: CALL_ID }]);
    net.rest("POST", "app_errors", () => []);
    return net;
  }
  const post = async (query: Record<string, string>, params: Record<string, string>) =>
    call(env, await twilioPost(env, "/voice/after-dial", { CallSid: CALL_SID, AccountSid: ACCOUNT, ...params }, { call: CALL_ID, ...query }));

  it.each([
    ["bridged (the child left the bridge)", { DialCallStatus: "completed", DialBridged: "true" }],
    ["not bridged", { DialCallStatus: "no-answer", DialBridged: "false" }],
  ])("step 0: an inbound parent whose call is in its conference joins it, %s: never voicemail, never a hang-up", async (_l, dialParams) => {
    const net = setup(liveCall({ transfer_state: "conference" }));
    const { text } = await post({}, { From: CUSTOMER, To: BUSINESS_NUMBER, Direction: "inbound", ...dialParams });
    expect(text).toBe(conferenceTwiml(env, CALL_ID, "customer"));
    expect(text).not.toContain("<Record");
    expect(text).not.toContain("<Hangup");
    expect(patches(net)).toEqual([]);
  });

  it("step 0 wins over a transfer=1 or in-order Dial too (the customer is the parent of every inbound Dial)", async () => {
    setup(liveCall({ transfer_state: "conference" }));
    const dials: Record<string, string>[] = [{ transfer: "1" }, { stage: "order", p: "0" }, { stage: "fwd" }];
    for (const q of dials) {
      const { text } = await post(q, { From: CUSTOMER, To: BUSINESS_NUMBER, DialCallStatus: "completed", DialBridged: "true" });
      expect(text).toBe(conferenceTwiml(env, CALL_ID, "customer"));
    }
  });

  it("stage=out: the app's leg joins the conference its customer was moved into (held, silent)", async () => {
    const net = setup(outboundCall({ transfer_state: "conference" }));
    const { text } = await post({ stage: "out" }, { From: `client:u_${USER_A.replace(/-/g, "")}_g1`, To: CUSTOMER, Direction: "inbound", DialCallStatus: "completed", DialBridged: "true" });
    expect(text).toBe(conferenceTwiml(env, CALL_ID, "agent"));
    expect(net.rpcCalls("phone_route_for_number")).toEqual([]);
  });

  it.each([
    ["the customer hung up", null, { DialCallStatus: "completed", DialBridged: "true" }],
    ["no answer", null, { DialCallStatus: "no-answer", DialBridged: "false" }],
    ["a cold transfer moved the customer", "transferring", { DialCallStatus: "completed", DialBridged: "true" }],
  ] as const)("stage=out otherwise just hangs the app leg up (%s): never voicemail, no route lookup", async (_l, state, dialParams) => {
    const net = setup(outboundCall({ transfer_state: state }));
    const { text } = await post({ stage: "out" }, { From: "client:x", To: CUSTOMER, ...dialParams });
    expect(text).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    expect(net.rpcCalls("phone_route_for_number")).toEqual([]);
    expect(patches(net)).toEqual([]);
  });

  it("stage=out with no row yet (the insert race) hangs up, never voicemail", async () => {
    setup(null);
    const { text } = await post({ stage: "out" }, { DialCallStatus: "no-answer" });
    expect(text).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
  });
});

// ── The app endpoints ───────────────────────────────────────────────────────────────

async function appSetup(row: CallRow, t: TwilioStub = {}, opts: { claimed?: boolean; target?: unknown; targetSettings?: unknown[]; route?: unknown; events?: EventFixture[] } = {}) {
  const net = new FakeNet().install();
  const auth = await new Auth().init();
  auth.serve(net);
  net.rpc("phone_caller_context", (s) => (s.json.p_user_id === USER_A ? callerCtx() : (opts.target === undefined ? callerCtx({ device_generation: 3 }) : opts.target)));
  net.rest("GET", "phone_calls", () => [row]);
  net.rest("GET", "phone_user_settings", () => opts.targetSettings ?? []);
  net.rpc("phone_route_for_number", () => opts.route ?? routeInfo());
  net.rest("PATCH", "phone_calls", () => (opts.claimed === false ? [] : [{ id: CALL_ID }]));
  net.rest("POST", "phone_call_events", () => []);
  net.rest("GET", "phone_call_events", eventRows(opts.events ?? []));
  net.rest("POST", "app_errors", () => []);
  stubTwilio(net, t);
  return { net, token: await auth.token(USER_A) };
}

const press = async (token: string, what: "hold" | "resume" | "warm-transfer" | "transfer", body: unknown = {}, id = CALL_ID) =>
  call(env, appRequest("POST", `/calls/${id}/${what}`, token, body));

describe("POST /calls/:id/hold", () => {
  it("inbound, from a plain call: claims the conference state, then moves YOUR leg (the child) in, waiting; the customer follows via after-dial", async () => {
    const { net, token } = await appSetup(liveCall());
    const { res, json } = await press(token, "hold");
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, held: true, call_id: CALL_ID });
    const claim = patches(net)[0];
    expect(claim.body).toEqual({ transfer_state: "conference" });
    expect(claim.url).toContain("transfer_state=is.null");
    expect(redirects(net)).toEqual([{ sid: MY_LEG, twiml: conferenceTwiml(env, CALL_ID, "agent"), status: null }]);
    expect(events(net)).toEqual(["hold"]);
  });

  it("outbound, from a plain call: moves the CUSTOMER's leg (the child); your app follows via after-dial?stage=out", async () => {
    const { net, token } = await appSetup(outboundCall());
    await press(token, "hold");
    expect(redirects(net)).toEqual([{ sid: CALL_SID, twiml: conferenceTwiml(env, CALL_ID, "customer"), status: null }]);
  });

  it("a redirect Twilio refuses puts the state back: you are still on the plain call", async () => {
    const { net, token } = await appSetup(liveCall(), { move: "refused", callStatus: { [MY_LEG]: "in-progress" } });
    const { res, json } = await press(token, "hold");
    expect(res.status).toBe(502);
    expect(json.error).toEqual({ code: "twilio_error", message: "Hold didn't work. You're still on the call." });
    const restore = patches(net)[1];
    expect(restore.body).toEqual({ transfer_state: null });
    expect(restore.url).toContain("transfer_state=eq.conference");
    expect(redirects(net).filter((r) => r.status === "completed")).toEqual([]); // nobody hung up on
    expect(net.to(/Conferences\.json/)).toEqual([]); // Twilio answered: nothing to look for
  });

  it("the leg being moved had already hung up (a drop as Hold was pressed): the claim goes back and the customer's leg is ended, never left in a conference nobody joins", async () => {
    // after-dial may already have answered the customer with <Conference> while the claim was
    // visible; ending their leg is what a plain call does when our side hangs up.
    const { net, token } = await appSetup(liveCall(), { move: "refused", callStatus: { [MY_LEG]: "completed" } });
    const { res, json } = await press(token, "hold");
    expect(res.status).toBe(400);
    expect(json.error).toEqual({ code: "bad_request", message: "That call has already ended." });
    expect(patches(net)[1].body).toEqual({ transfer_state: null });
    expect(redirects(net).filter((r) => r.status === "completed")).toEqual([{ sid: CALL_SID, twiml: null, status: "completed" }]);
  });

  it("...but leaves the customer alone when a cold transfer took the call meanwhile (the claim was no longer ours)", async () => {
    const { net, token } = await appSetup(liveCall(), { move: "refused", callStatus: { [MY_LEG]: "completed" } });
    let n = 0;
    net.rest("PATCH", "phone_calls", () => (n++ === 0 ? [{ id: CALL_ID }] : [])); // claim wins, put-back finds nothing
    const { res } = await press(token, "hold");
    expect(res.status).toBe(400);
    expect(redirects(net).filter((r) => r.status === "completed")).toEqual([]);
  });

  it("outbound: the customer hung up as Hold was pressed: your app's leg is ended, not left alone in a conference", async () => {
    const { net, token } = await appSetup(outboundCall(), { move: "refused", callStatus: { [CALL_SID]: "completed" } });
    await press(token, "hold");
    expect(redirects(net).filter((r) => r.status === "completed")).toEqual([{ sid: MY_LEG, twiml: null, status: "completed" }]);
  });

  it("the redirect got no answer but Twilio did it (your leg is in the conference): the claim is KEPT, so after-dial brings the customer in", async () => {
    const { net, token } = await appSetup(liveCall(), {
      move: "unreachable", callStatus: { [MY_LEG]: "in-progress" },
      conference: inProgress,
      participants: [agentIn()],
    });
    const { res, json } = await press(token, "hold");
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, held: true, call_id: CALL_ID });
    expect(patches(net).map((p) => p.body)).toEqual([{ transfer_state: "conference" }]); // no put-back
    expect(net.writes("app_errors").map((s) => s.json.code)).toContain("hold_answer_lost");
  });

  it("the redirect got no answer and nothing moved: the state goes back (after a short look), you are still on the call", async () => {
    const { net, token } = await appSetup(liveCall(), { move: "unreachable", callStatus: { [MY_LEG]: "in-progress" } });
    const { res } = await press(token, "hold");
    expect(res.status).toBe(502);
    expect(patches(net)[1].body).toEqual({ transfer_state: null });
    expect(net.to(/Conferences\.json/)).toHaveLength(2);
  });

  it.each([
    ["after Resume (your leg is listed as the one who started it)", resumedRoom(), []],
    ["whose starter has left (a warm transfer the teammate took, then dropped): Twilio's recorded start event says so", plainHold(), [startedEvent()]],
  ] as const)("already in a STARTED conference, %s: puts the customer on hold through the Participants API, no move", async (_l, room, evs) => {
    const { net, token } = await appSetup(liveCall({ transfer_state: "conference" }), room, { events: [...evs] });
    const { json } = await press(token, "hold");
    expect(json).toEqual({ ok: true, held: true, call_id: CALL_ID });
    expect(patches(net)).toEqual([]);
    expect(redirects(net)).toEqual([]);
    expect(net.to(/Conferences\.json/)[0].url.searchParams.get("FriendlyName")).toBe(CALL_ID);
    expect(participantUpdates(net)).toEqual([{ sid: CALL_SID, form: { Hold: "true", HoldUrl: HOLD_MUSIC, HoldMethod: "GET" } }]);
  });

  it("a second Hold on a customer already on a Participants hold changes nothing at Twilio", async () => {
    const { net, token } = await appSetup(liveCall({ transfer_state: "conference" }), resumedRoom(true));
    const { json } = await press(token, "hold");
    expect(json).toEqual({ ok: true, held: true, call_id: CALL_ID });
    expect(participantUpdates(net)).toEqual([]);
  });

  it("a failed conference lookup is an error, not a pretend hold", async () => {
    const { net, token } = await appSetup(liveCall({ transfer_state: "conference" }));
    net.on("GET", (u) => u.pathname.endsWith("/Conferences.json"), () => jsonRes({ code: 20500 }, 500));
    const { res, json } = await press(token, "hold");
    expect(res.status).toBe(502);
    expect(json.error.code).toBe("twilio_error");
  });

  it("the legs still moving in (no conference yet): they arrive held, nothing more to do", async () => {
    const { net, token } = await appSetup(liveCall({ transfer_state: "conference" }), { conference: null });
    const { json } = await press(token, "hold");
    expect(json).toEqual({ ok: true, held: true, call_id: CALL_ID });
    expect(participantUpdates(net)).toEqual([]);
    expect(redirects(net)).toEqual([]);
  });

  // Not proven started is not "not started". A warm transfer from a plain call: B answered
  // (start=true) and all three talked, then B hung up. You and the customer are talking in a
  // started conference, and with Twilio's start never recorded the list reads exactly like a
  // plain Hold. Holding the customer is safe either way.
  it.each([
    ["the teammate who started it (a warm transfer from a plain call) has hung up, its start never recorded", liveCall({ transfer_state: "conference", answered_by: USER_B, transferred_from: USER_A, client_call_sid: TEAMMATE_LEG })],
    ["a plain Hold pressed again", liveCall({ transfer_state: "conference" })],
  ])("nothing proves it started (%s): the customer is held through the Participants API anyway, never left talking behind held:true", async (_l, row) => {
    const { net, token } = await appSetup(row, plainHold());
    const { json } = await press(token, "hold");
    expect(json).toEqual({ ok: true, held: true, call_id: CALL_ID });
    expect(participantUpdates(net)).toEqual([{ sid: CALL_SID, form: { Hold: "true", HoldUrl: HOLD_MUSIC, HoldMethod: "GET" } }]);
    expect(redirects(net)).toEqual([]);
  });

  it.each([
    // DEVIATIONS 55: if Twilio refuses Hold=true in a conference that has not started, that
    // refusal says where it stands, which is hold. 404: the customer's leg is not in yet.
    [400, 200], [404, 200], [500, 502],
  ])("...a hold Twilio refuses with HTTP %s, no Resume landing: answers %s", async (participantStatus, status) => {
    const { net, token } = await appSetup(liveCall({ transfer_state: "conference" }), plainHold({ participantStatus }));
    const { res, json } = await press(token, "hold");
    expect(res.status).toBe(status);
    if (status === 200) {
      expect(json).toEqual({ ok: true, held: true, call_id: CALL_ID });
      expect(net.writes("app_errors")).toEqual([]);
    } else {
      expect(json.error).toEqual({ code: "twilio_error", message: "Hold didn't work. You're still on the call." });
      expect(net.writes("app_errors").map((s) => s.json.code)).toContain("hold_failed");
    }
  });

  it.each([
    ["a cold transfer under way", liveCall({ transfer_state: "transferring" }), 400, "bad_request"],
    ["a call someone else holds", liveCall({ answered_by: USER_B }), 404, "not_found"],
    ["a call that ended", liveCall({ status: "completed", ended_at: new Date().toISOString() }), 400, "bad_request"],
    ["a 911 call", liveCall({ is_emergency: true }), 400, "bad_request"],
  ])("refuses %s, touching nothing at Twilio", async (_l, row, status, code) => {
    const { net, token } = await appSetup(row);
    const { res, json } = await press(token, "hold");
    expect(res.status).toBe(status);
    expect(json.error.code).toBe(code);
    expect(net.to(/api\.twilio\.com/)).toEqual([]);
  });

  it("two presses cannot both move the call: the loser of the claim touches nothing", async () => {
    const { net, token } = await appSetup(liveCall(), {}, { claimed: false });
    const { res } = await press(token, "hold");
    expect(res.status).toBe(400);
    expect(redirects(net)).toEqual([]);
  });

  it("within an hour of a 911 call from this number, an inbound call is not put on hold (plan 14: never voicemail)", async () => {
    const { net, token } = await appSetup(liveCall(), {}, { route: routeInfo({ recent_emergency_user: USER_A }) });
    const { res, json } = await press(token, "hold");
    expect(res.status).toBe(400);
    expect(json.error).toEqual({ code: "bad_request", message: EMERGENCY_CALLBACK });
    expect(net.to(/api\.twilio\.com/)).toEqual([]);
    expect(patches(net)).toEqual([]);
  });

  it("an outbound call has no 911 callback window to respect", async () => {
    const { net, token } = await appSetup(outboundCall(), {}, { route: routeInfo({ recent_emergency_user: USER_A }) });
    const { res } = await press(token, "hold");
    expect(res.status).toBe(200);
    expect(net.rpcCalls("phone_route_for_number")).toEqual([]);
  });
});

describe("POST /calls/:id/resume", () => {
  it("the stub answers as Twilio did live: Hold=false on a leg that is not held is refused, HTTP 400, code 400", async () => {
    const net = new FakeNet().install();
    stubTwilio(net, plainHold());
    await expect(updateParticipant(env, CONF, CALL_SID, { Hold: "false" })).rejects.toMatchObject({ status: 400, code: 400 });
  });

  it("a plain Hold as Twilio shows it live (in-progress, both legs connected, nobody held, nobody joined with start=true): brings YOUR leg back in as the one who starts it, and never sends Hold=false", async () => {
    // 2026-09-30: this read as 'started', sent Hold=false to the customer, Twilio answered 400
    // (resume_failed), and the customer stayed on wait music.
    const { net, token } = await appSetup(liveCall({ transfer_state: "conference" }), plainHold());
    const { res, json } = await press(token, "resume");
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, held: false, call_id: CALL_ID });
    expect(redirects(net)).toEqual([{ sid: MY_LEG, twiml: conferenceTwiml(env, CALL_ID, "agent", true), status: null }]);
    expect(participantUpdates(net)).toEqual([]);
    expect(net.writes("app_errors")).toEqual([]);
    expect(events(net)).toEqual(["resume"]);
  });

  it.each([
    ["an earlier conference of the call (before a cold transfer)", startedEvent("CF" + "0".repeat(31) + "9")],
    ["an app's own timing mark", startedEvent(CONF, { source: "app" })],
  ])("a start event for %s does not count: your leg is brought back in", async (_l, evt) => {
    const { net, token } = await appSetup(liveCall({ transfer_state: "conference" }), plainHold(), { events: [evt] });
    await press(token, "resume");
    expect(redirects(net)).toEqual([{ sid: MY_LEG, twiml: conferenceTwiml(env, CALL_ID, "agent", true), status: null }]);
  });

  it("a conference nobody has started, with the customer on a Participants hold (a warm transfer from hold): starts it, THEN takes them off hold", async () => {
    const { net, token } = await appSetup(liveCall({ transfer_state: "conference" }), {
      conference: inProgress,
      participants: [customerIn(true), agentIn()],
    });
    const { json } = await press(token, "resume");
    expect(json).toEqual({ ok: true, held: false, call_id: CALL_ID });
    expect(participantUpdates(net)).toEqual([{ sid: CALL_SID, form: { Hold: "false" } }]);
    expect(redirects(net)).toEqual([{ sid: MY_LEG, twiml: conferenceTwiml(env, CALL_ID, "agent", true), status: null }]);
    const unhold = net.seen.findIndex((s) => /\/Participants\/CA/.test(s.url.pathname));
    const start = net.seen.findIndex((s) => s.method === "POST" && /\/Calls\/CA/.test(s.url.pathname));
    expect(start).toBeLessThan(unhold);
  });

  it("...so a redirect Twilio refuses (the holder's leg has ended: a teammate who took a warm transfer and hung up, the start never recorded) leaves the customer ON HOLD, never connected to you behind the error", async () => {
    const { net, token } = await appSetup(
      liveCall({ transfer_state: "conference", answered_by: USER_B, transferred_from: USER_A, client_call_sid: TEAMMATE_LEG }),
      plainHold({ participants: [customerIn(true), agentIn()], move: "refused" }),
    );
    const { res, json } = await press(token, "resume");
    expect(res.status).toBe(502);
    expect(json.error).toEqual({ code: "twilio_error", message: "Couldn't take the call off hold. Please try again." });
    expect(redirects(net)).toEqual([{ sid: TEAMMATE_LEG, twiml: conferenceTwiml(env, CALL_ID, "agent", true), status: null }]);
    expect(participantUpdates(net)).toEqual([]);
    expect(events(net)).toEqual([]);
  });

  it("resume is never refused for the 911 callback window: bringing a customer back is always allowed", async () => {
    const { res } = await press((await appSetup(liveCall({ transfer_state: "conference" }), plainHold(),
      { route: routeInfo({ recent_emergency_user: USER_A }) })).token, "resume");
    expect(res.status).toBe(200);
  });

  it.each([
    ["after Resume (your leg is listed as the one who started it)", resumedRoom(true), []],
    ["whose starter has left: Twilio's recorded start event says so", plainHold({ participants: [customerIn(true), agentIn()] }), [startedEvent()]],
  ] as const)("a started conference, %s: takes the customer off hold (Participants API), no redirect", async (_l, room, evs) => {
    const { net, token } = await appSetup(liveCall({ transfer_state: "conference" }), room, { events: [...evs] });
    const { res } = await press(token, "resume");
    expect(res.status).toBe(200);
    expect(participantUpdates(net)).toEqual([{ sid: CALL_SID, form: { Hold: "false" } }]);
    expect(redirects(net)).toEqual([]);
  });

  it("a started conference whose customer is not held (you are already talking: a second press): nothing is sent to Twilio", async () => {
    const { net, token } = await appSetup(liveCall({ transfer_state: "conference" }), resumedRoom(false));
    const { res, json } = await press(token, "resume");
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, held: false, call_id: CALL_ID });
    expect(participantUpdates(net)).toEqual([]);
    expect(redirects(net)).toEqual([]);
  });

  it("a participant list Twilio won't give is an error, not a guess", async () => {
    const { net, token } = await appSetup(liveCall({ transfer_state: "conference" }), plainHold());
    net.on("GET", (u) => u.pathname.endsWith("/Participants.json"), () => jsonRes({ code: 20500 }, 500));
    const { res, json } = await press(token, "resume");
    expect(res.status).toBe(502);
    expect(json.error).toEqual({ code: "twilio_error", message: "Couldn't take the call off hold. Please try again." });
    expect(redirects(net)).toEqual([]);
  });

  it("refuses a call that isn't on hold, and asks for a moment while the legs are still moving", async () => {
    const plain = await appSetup(liveCall());
    const a = await press(plain.token, "resume");
    expect(a.json.error).toEqual({ code: "bad_request", message: "That call isn't on hold." });
    const moving = await appSetup(liveCall({ transfer_state: "conference" }), { conference: null });
    const b = await press(moving.token, "resume");
    expect(b.json.error.message).toContain("Try again in a moment");
  });
});

describe("POST /calls/:id/warm-transfer", () => {
  it("from a plain call: moves it into the conference, then rings the teammate INTO it (Participants API)", async () => {
    const { net, token } = await appSetup(liveCall());
    const { res, json } = await press(token, "warm-transfer", { to_user_id: USER_B });
    expect(res.status).toBe(200);
    // Moved: the customer waits on music, not held as a participant, and is connected when the
    // teammate answers (customer_held false).
    expect(json).toEqual({ ok: true, held: true, call_id: CALL_ID, customer_held: false });
    expect(redirects(net)).toEqual([{ sid: MY_LEG, twiml: conferenceTwiml(env, CALL_ID, "agent"), status: null }]);

    const add = net.to(/\/Conferences\/[0-9a-f-]{36}\/Participants\.json$/)[0];
    expect(add.url.pathname).toContain(`/Conferences/${CALL_ID}/Participants.json`); // by name
    const form = new URLSearchParams(add.body);
    expect(form.get("From")).toBe(BUSINESS_NUMBER);
    // The leg rings From the business's own number: the customer's number rides along, encoded.
    expect(form.get("To")).toBe(`client:u_${USER_B.replace(/-/g, "")}_g3?call_id=${CALL_ID}&transferred_by=${USER_A}&customer_e164=%2B15555550142`);
    expect(form.get("StartConferenceOnEnter")).toBe("true");
    expect(form.get("EndConferenceOnExit")).toBe("false");
    expect(form.get("Timeout")).toBe("20");
    expect(form.get("StatusCallback")).toBe(`https://phone.example.test/voice/status?call=${CALL_ID}&leg=warm&user=${USER_B}&key=test-webhook-key`);
    expect(form.getAll("StatusCallbackEvent")).toEqual(["initiated", "ringing", "answered", "completed"]);
    expect(form.get("ConferenceStatusCallback")).toBe(`https://phone.example.test/voice/conference?call=${CALL_ID}&key=test-webhook-key`);
    // If this add is what creates the conference (the moved leg not in yet), its events are the
    // conference's: `start` must be among them.
    expect(form.getAll("ConferenceStatusCallbackEvent")).toEqual(["start", "leave"]);
    expect(form.toString()).not.toMatch(/Record/i);

    expect(net.writes("phone_calls", "PATCH").map((s) => s.json)).toContainEqual({ rang_user_ids: [USER_A, USER_B] });
    expect(events(net)).toContain("warm_transfer");
  });

  const addIndex = (net: FakeNet) => net.seen.findIndex((s) => s.method === "POST" && /\/Conferences\/[0-9a-f-]{36}\/Participants\.json$/.test(s.url.pathname));
  const adds = (net: FakeNet) => net.to(/\/Conferences\/[0-9a-f-]{36}\/Participants\.json$/).filter((s) => s.method === "POST");

  it("ON HOLD (a plain Hold as Twilio shows it live: in-progress, but nobody has started it): the customer is put on a Participants hold BEFORE the teammate is rung, so starting the conference does not connect them into your private talk", async () => {
    // The teammate joins with startConferenceOnEnter=true, which connects everyone WAITING.
    // A customer who is only waiting (plain Hold) would hear the consult; a held one does not.
    const { net, token } = await appSetup(liveCall({ transfer_state: "conference" }), plainHold());
    const { res, json } = await press(token, "warm-transfer", { to_user_id: USER_B });
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, held: null, call_id: CALL_ID, customer_held: true }); // stays on hold; Resume brings them in
    expect(participantUpdates(net)).toEqual([{ sid: CALL_SID, form: { Hold: "true", HoldUrl: HOLD_MUSIC, HoldMethod: "GET" } }]);
    const held = net.seen.findIndex((s) => /\/Participants\/CA/.test(s.url.pathname));
    expect(held).toBeGreaterThanOrEqual(0);
    expect(held).toBeLessThan(addIndex(net));
    expect(new URLSearchParams(adds(net)[0].body).get("StartConferenceOnEnter")).toBe("true");
    expect(redirects(net)).toEqual([]);
  });

  it.each([
    ["the customer already on a Participants hold", true],
    ["you talking to the customer in the conference (after Resume): the teammate joins the two of you", false],
  ])("a STARTED conference, %s: no hold change, just the teammate (held: null), and customer_held says which", async (_l, hold) => {
    const { net, token } = await appSetup(liveCall({ transfer_state: "conference" }), resumedRoom(hold));
    const { json } = await press(token, "warm-transfer", { to_user_id: USER_B });
    expect(json).toEqual({ ok: true, held: null, call_id: CALL_ID, customer_held: hold });
    expect(participantUpdates(net)).toEqual([]);
    expect(redirects(net)).toEqual([]);
    expect(adds(net)).toHaveLength(1);
  });

  it("ON HOLD with the customer already on a Participants hold (an earlier warm transfer from hold was missed): kept, no second hold, customer_held true", async () => {
    const { net, token } = await appSetup(liveCall({ transfer_state: "conference" }), plainHold({ participants: [customerIn(true), agentIn()] }));
    const { json } = await press(token, "warm-transfer", { to_user_id: USER_B });
    expect(json).toEqual({ ok: true, held: null, call_id: CALL_ID, customer_held: true });
    expect(participantUpdates(net)).toEqual([]);
    expect(adds(net)).toHaveLength(1);
  });

  it.each([
    ["no conference yet (the legs are still moving in after Hold)", null, undefined],
    ["the customer's leg not in it yet (the hold answers 404)", inProgress, 404],
  ])("%s: asks for a moment and rings nobody", async (_l, conference, participantStatus) => {
    const { net, token } = await appSetup(liveCall({ transfer_state: "conference" }), { conference, participantStatus });
    const { res, json } = await press(token, "warm-transfer", { to_user_id: USER_B });
    expect(res.status).toBe(400);
    expect(json.error.message).toBe("The call is still being put on hold. Try again in a moment.");
    expect(adds(net)).toEqual([]);
  });

  // 400: if Twilio refuses Hold=true in a conference nobody has started (DEVIATIONS 55, unverified).
  it.each([500, 400])("a hold Twilio refuses (HTTP %s) rings nobody (the customer is never connected into the consult)", async (participantStatus) => {
    const { net, token } = await appSetup(liveCall({ transfer_state: "conference" }), plainHold({ participantStatus }));
    const { res, json } = await press(token, "warm-transfer", { to_user_id: USER_B });
    expect(res.status).toBe(502);
    expect(json.error.message).toBe("Your teammate couldn't be rung. You're still on the call.");
    expect(adds(net)).toEqual([]);
  });

  it("within an hour of a 911 call from this number, an inbound call is not warm-transferred", async () => {
    const { net, token } = await appSetup(liveCall(), {}, { route: routeInfo({ recent_emergency_user: USER_A }) });
    const { res, json } = await press(token, "warm-transfer", { to_user_id: USER_B });
    expect(res.status).toBe(400);
    expect(json.error.message).toBe(EMERGENCY_CALLBACK);
    expect(net.to(/api\.twilio\.com/)).toEqual([]);
  });

  it("a teammate on DND is refused (you're still on the line to choose), nothing moved", async () => {
    const { net, token } = await appSetup(liveCall(), {}, { targetSettings: [{ dnd: true, dnd_until: null }] });
    const { res, json } = await press(token, "warm-transfer", { to_user_id: USER_B });
    expect(res.status).toBe(400);
    expect(json.error.message).toBe("That teammate is on Do Not Disturb.");
    expect(net.to(/api\.twilio\.com/)).toEqual([]);
  });

  it("a teammate on another tenant is not found", async () => {
    const { net, token } = await appSetup(liveCall(), {}, { target: callerCtx({ client_id: "other-tenant" }) });
    const { res } = await press(token, "warm-transfer", { to_user_id: USER_B });
    expect(res.status).toBe(404);
    expect(net.to(/api\.twilio\.com/)).toEqual([]);
  });

  it("if the teammate can't be rung after the move, says the customer is on hold and how to get them back, with held:true in the body", async () => {
    const { token } = await appSetup(liveCall(), { failAdd: true });
    const { res, json } = await press(token, "warm-transfer", { to_user_id: USER_B });
    expect(res.status).toBe(502);
    expect(json).toEqual({
      ok: false, held: true, call_id: CALL_ID,
      error: { code: "twilio_error", message: "Your teammate couldn't be rung. The customer is on hold; press Resume to talk to them." },
    });
  });

  it("if the teammate can't be rung from a conference, the body carries the hold state it found (a customer it held stays held)", async () => {
    const onHold = await appSetup(liveCall({ transfer_state: "conference" }), plainHold({ failAdd: true }));
    const a = await press(onHold.token, "warm-transfer", { to_user_id: USER_B });
    expect(a.json).toMatchObject({ ok: false, held: true, error: { message: "Your teammate couldn't be rung. You're still on the call." } });
    const talking = await appSetup(liveCall({ transfer_state: "conference" }), resumedRoom(false, { failAdd: true }));
    const b = await press(talking.token, "warm-transfer", { to_user_id: USER_B });
    expect(b.json).toMatchObject({ ok: false, held: false });
  });

  it("a started conference (Twilio's start event recorded) whose participant list can't be read still rings the teammate; customer_held is null (unknown)", async () => {
    const { net, token } = await appSetup(liveCall({ transfer_state: "conference" }), plainHold(), { events: [startedEvent()] });
    net.on("GET", (u) => u.pathname.endsWith("/Participants.json"), () => jsonRes({ code: 20500 }, 500));
    const { res, json } = await press(token, "warm-transfer", { to_user_id: USER_B });
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, held: null, call_id: CALL_ID, customer_held: null });
    expect(participantUpdates(net)).toEqual([]);
    expect(adds(net)).toHaveLength(1);
  });

  it("an unreadable participant list and nothing proving it started: the customer is held first anyway (safe either way)", async () => {
    const { net, token } = await appSetup(liveCall({ transfer_state: "conference" }), plainHold());
    net.on("GET", (u) => u.pathname.endsWith("/Participants.json"), () => jsonRes({ code: 20500 }, 500));
    const { json } = await press(token, "warm-transfer", { to_user_id: USER_B });
    expect(json).toEqual({ ok: true, held: null, call_id: CALL_ID, customer_held: true });
    expect(participantUpdates(net)).toEqual([{ sid: CALL_SID, form: { Hold: "true", HoldUrl: HOLD_MUSIC, HoldMethod: "GET" } }]);
  });

  describe("the teammate's client address names the real caller (customer_e164, contact_id)", () => {
    const toOf = async (row: CallRow) => {
      const { net, token } = await appSetup(row);
      await press(token, "warm-transfer", { to_user_id: USER_B });
      const to = new URLSearchParams(adds(net)[0].body).get("To")!;
      return new URLSearchParams(to.slice(to.indexOf("?") + 1));
    };

    it("an inbound call with a contact: the caller's number and the contact", async () => {
      const q = await toOf(liveCall({ contact_id: CONTACT_1 }));
      expect(Object.fromEntries(q)).toEqual({ call_id: CALL_ID, transferred_by: USER_A, customer_e164: CUSTOMER, contact_id: CONTACT_1 });
    });

    it("an outbound call: the number that was dialed, never the business's own", async () => {
      const q = await toOf(outboundCall());
      expect(q.get("customer_e164")).toBe(CUSTOMER);
      expect(q.has("contact_id")).toBe(false);
    });

    it("a withheld caller: no customer_e164 at all (the app looks the call up instead)", async () => {
      const q = await toOf(liveCall({ from_e164: "anonymous" }));
      expect(q.has("customer_e164")).toBe(false);
      expect(q.get("call_id")).toBe(CALL_ID);
    });
  });
});

describe("POST /calls/:id/transfer (cold) from the conference", () => {
  it("claims from 'conference' (not null) and redirects the customer, which ends the conference for the rest", async () => {
    const { net, token } = await appSetup(liveCall({ transfer_state: "conference" }));
    const { res } = await press(token, "transfer", { to_user_id: USER_B });
    expect(res.status).toBe(200);
    const claim = patches(net)[0];
    expect(claim.body).toMatchObject({ transfer_state: "transferring", transferred_from: USER_A });
    expect(claim.url).toContain("transfer_state=eq.conference");
    expect(redirects(net)[0].sid).toBe(CALL_SID);
  });

  it("the teammate's <Client> carries the real caller too (customer_e164, contact_id), as <Parameter>s", async () => {
    const { net, token } = await appSetup(outboundCall({ contact_id: CONTACT_1, transfer_state: "conference" }));
    await press(token, "transfer", { to_user_id: USER_B });
    const xml = redirects(net)[0].twiml!;
    const params = Object.fromEntries([...xml.matchAll(/<Parameter name="([^"]+)" value="([^"]*)"\/>/g)].map((m) => [m[1], m[2]]));
    expect(params).toEqual({ call_id: CALL_ID, transferred_by: USER_A, customer_e164: CUSTOMER, contact_id: CONTACT_1 });
  });

  it("a failed redirect puts it back into the conference state, not null", async () => {
    const { net, token } = await appSetup(liveCall({ transfer_state: "conference" }), { failRedirect: true });
    await press(token, "transfer", { to_user_id: USER_B });
    expect(patches(net)[1].body).toMatchObject({ transfer_state: "conference", answered_by: USER_A });
  });

  it("within an hour of a 911 call from this number, an inbound call is not cold-transferred either (a teammate on DND would mean voicemail)", async () => {
    const { net, token } = await appSetup(liveCall(), {}, { route: routeInfo({ recent_emergency_user: USER_A }) });
    const { res, json } = await press(token, "transfer", { to_user_id: USER_B });
    expect(res.status).toBe(400);
    expect(json.error.message).toBe(EMERGENCY_CALLBACK);
    expect(patches(net)).toEqual([]);
    expect(net.to(/api\.twilio\.com/)).toEqual([]);
  });
});

// ── The Twilio side ─────────────────────────────────────────────────────────────────

function twilioSetup(row: CallRow | null, t: TwilioStub = {}, opts: { claimed?: boolean; events?: EventFixture[] } = {}) {
  const net = new FakeNet().install();
  net.rest("GET", "phone_calls", () => (row ? [row] : []));
  net.rest("PATCH", "phone_calls", () => (opts.claimed === false ? [] : [{ id: CALL_ID }]));
  net.rest("POST", "phone_call_events", () => []);
  net.rest("GET", "phone_call_events", eventRows(opts.events ?? []));
  net.rest("POST", "app_errors", () => []);
  net.rpc("phone_route_for_number", () => routeInfo());
  stubTwilio(net, t);
  return net;
}

const warmStatus = async (status: string) => call(env, await twilioPost(env, "/voice/status", {
  CallSid: TEAMMATE_LEG, CallStatus: status, AccountSid: ACCOUNT, To: `client:u_${USER_B.replace(/-/g, "")}_g3`,
}, { call: CALL_ID, leg: "warm", user: USER_B }));

const leave = async (leaving: string) => call(env, await twilioPost(env, "/voice/conference", {
  StatusCallbackEvent: "participant-leave", ConferenceSid: CONF, FriendlyName: CALL_ID, CallSid: leaving, AccountSid: ACCOUNT,
}, { call: CALL_ID }));

describe("the warm-transfer teammate's leg (/voice/status?leg=warm)", () => {
  it("answering hands them the call: answered_by, transferred_from and client_call_sid move, only while in the conference", async () => {
    const net = twilioSetup(liveCall({ transfer_state: "conference" }));
    const { res } = await warmStatus("in-progress");
    expect(res.status).toBe(204);
    const p = patches(net)[0];
    expect(p.body).toEqual({ answered_by: USER_B, transferred_from: USER_A, client_call_sid: TEAMMATE_LEG });
    expect(p.url).toContain("transfer_state=eq.conference");
  });

  it("on an OUTBOUND call, the one handing it on is the placer", async () => {
    const net = twilioSetup(outboundCall({ transfer_state: "conference" }));
    await warmStatus("in-progress");
    expect(patches(net)[0].body).toMatchObject({ transferred_from: USER_A, answered_by: USER_B });
  });

  it("answering after the call has left its conference (ended, or cold-transferred) hangs the teammate up: no empty conference", async () => {
    const net = twilioSetup(liveCall({ transfer_state: "transferring" }));
    await warmStatus("in-progress");
    expect(patches(net)).toEqual([]);
    expect(redirects(net)).toEqual([{ sid: TEAMMATE_LEG, twiml: null, status: "completed" }]);
  });

  it("answering while you are still there (the consult) leaves the customer's hold alone", async () => {
    const net = twilioSetup(liveCall({ transfer_state: "conference" }), {
      conference: { sid: CONF, friendly_name: CALL_ID, status: "in-progress" },
      participants: [customerIn(true), { call_sid: MY_LEG, hold: false, muted: false, status: "connected" }, { call_sid: TEAMMATE_LEG, hold: false, muted: false, status: "connected" }],
    });
    await warmStatus("in-progress");
    expect(patches(net)[0].body).toMatchObject({ answered_by: USER_B });
    expect(participantUpdates(net)).toEqual([]);
  });

  it("answering after you already hung up, with the customer on hold: the customer comes off hold, so the two talk (SPEC: hanging up hands them over)", async () => {
    const net = twilioSetup(liveCall({ transfer_state: "conference" }), {
      conference: { sid: CONF, friendly_name: CALL_ID, status: "in-progress" },
      participants: [customerIn(true), { call_sid: TEAMMATE_LEG, hold: false, muted: false, status: "connected" }],
    });
    await warmStatus("in-progress");
    expect(patches(net)[0].body).toMatchObject({ answered_by: USER_B, client_call_sid: TEAMMATE_LEG });
    expect(participantUpdates(net)).toEqual([{ sid: CALL_SID, form: { Hold: "false" } }]);
    expect(events(net)).toContain("handed_over");
  });

  it("answering records that the conference STARTED (they joined with start=true beside the customer), so it stays proven after they hang up, without Twilio's start callback", async () => {
    const net = twilioSetup(liveCall({ transfer_state: "conference" }), {
      conference: inProgress, participants: [customerIn(true), agentIn(), agentIn(false, TEAMMATE_LEG)],
    });
    await warmStatus("in-progress");
    expect(net.writes("phone_call_events").filter((s) => s.json.type === "conference_started").map((s) => s.json.data)).toEqual([{ conference_sid: CONF }]);
  });

  it("a start that can't be written is logged, and never stops the call being handed over", async () => {
    const net = twilioSetup(liveCall({ transfer_state: "conference" }), {
      conference: inProgress, participants: [customerIn(true), agentIn(false, TEAMMATE_LEG)],
    });
    net.rest("POST", "phone_call_events", () => jsonRes({ message: "boom" }, 500));
    await warmStatus("in-progress");
    expect(participantUpdates(net)).toEqual([{ sid: CALL_SID, form: { Hold: "false" } }]);
    expect(net.writes("app_errors").map((s) => s.json.code)).toContain("conference_start_record_failed");
  });

  describe("accepted on ?key= alone (no TWILIO_AUTH_TOKEN): the user in the URL is not trusted", () => {
    const keyOnly = makeEnv({ TWILIO_AUTH_TOKEN: undefined });
    const unsignedAnswer = async (user: string) => call(keyOnly, await twilioPost(keyOnly, "/voice/status", {
      CallSid: TEAMMATE_LEG, CallStatus: "in-progress", AccountSid: ACCOUNT,
    }, { call: CALL_ID, leg: "warm", user }));
    const room = {
      conference: { sid: CONF, friendly_name: CALL_ID, status: "in-progress" },
      participants: [customerIn(), { call_sid: MY_LEG, hold: false, muted: false, status: "connected" }, { call_sid: TEAMMATE_LEG, hold: false, muted: false, status: "connected" }],
      callStatus: { [TEAMMATE_LEG]: "in-progress" },
    };

    it("a forged answer naming someone the leg did not ring moves nothing (and says so)", async () => {
      const net = twilioSetup(liveCall({ transfer_state: "conference" }), { ...room, callTo: { [TEAMMATE_LEG]: `client:u_${USER_B.replace(/-/g, "")}_g3` } });
      await unsignedAnswer(USER_C);
      expect(patches(net)).toEqual([]);
      expect(events(net)).not.toContain("conference_started");
      expect(net.writes("app_errors").map((s) => s.json.code)).toContain("warm_answer_unverified");
    });

    it("a leg that is not in this call's conference moves nothing", async () => {
      const net = twilioSetup(liveCall({ transfer_state: "conference" }), {
        ...room, participants: [customerIn()], callTo: { [TEAMMATE_LEG]: `client:u_${USER_B.replace(/-/g, "")}_g3` },
      });
      await unsignedAnswer(USER_B);
      expect(patches(net)).toEqual([]);
    });

    it("an answer Twilio's records agree with hands the call over", async () => {
      const net = twilioSetup(liveCall({ transfer_state: "conference" }), {
        ...room, callTo: { [TEAMMATE_LEG]: `client:u_${USER_B.replace(/-/g, "")}_g3?call_id=${CALL_ID}&transferred_by=${USER_A}` },
      });
      await unsignedAnswer(USER_B);
      expect(patches(net)[0].body).toEqual({ answered_by: USER_B, transferred_from: USER_A, client_call_sid: TEAMMATE_LEG });
    });
  });

  it("no answer while you are still there: nothing changes for the customer", async () => {
    const net = twilioSetup(liveCall({ transfer_state: "conference" }), plainHold());
    await warmStatus("no-answer");
    expect(redirects(net)).toEqual([]);
    expect(events(net)).toContain("warm_transfer_missed");
  });

  it("no answer after you already dropped: the customer, alone, goes to voicemail (never hung up on)", async () => {
    const net = twilioSetup(liveCall({ transfer_state: "conference" }), {
      conference: { sid: CONF, friendly_name: CALL_ID, status: "in-progress" },
      participants: [customerIn()],
    });
    await warmStatus("busy");
    const claim = patches(net)[0];
    expect(claim.body).toEqual({ transfer_state: null });
    expect(claim.url).toContain("transfer_state=eq.conference");
    const r = redirects(net);
    expect(r).toHaveLength(1);
    expect(r[0].sid).toBe(CALL_SID);
    expect(r[0].twiml).toContain("<Record");
    expect(r[0].twiml).toContain("You've reached Demo Sheds.");
  });
});

describe("/voice/conference (a participant left)", () => {
  it("answers 204 at once", async () => {
    twilioSetup(null);
    const { res, text } = await leave(MY_LEG);
    expect(res.status).toBe(204);
    expect(text).toBe("");
  });

  it.each([
    ["Twilio's start event recorded, your leg gone from the list", [customerIn(false)], [startedEvent()]],
    ["your leg, which re-joined with start=true, still listed", [customerIn(false), agentIn(true)], []],
  ] as const)("you hang up while TALKING to the customer (nobody else there; %s): the call ends for them too", async (_l, participants, evs) => {
    const net = twilioSetup(liveCall({ transfer_state: "conference" }), {
      conference: inProgress, participants: [...participants], callStatus: { [MY_LEG]: "completed" },
    }, { events: [...evs] });
    await leave(MY_LEG);
    expect(redirects(net)).toEqual([{ sid: CALL_SID, twiml: null, status: "completed" }]);
    expect(events(net)).toContain("conference_ended");
  });

  it.each([
    ["on hold (Participants API)", [customerIn(true)]],
    ["waiting on a plain Hold (in-progress, but nobody ever started it: seen live)", [customerIn(false), agentIn(false)]],
    ["waiting, and Twilio no longer lists your leg", [customerIn(false)]],
  ] as const)("you hang up while the customer is %s: voicemail, not a dead line", async (_l, participants) => {
    const net = twilioSetup(liveCall({ transfer_state: "conference" }), {
      conference: inProgress, participants: [...participants], callStatus: { [MY_LEG]: "completed" },
    });
    await leave(MY_LEG);
    const r = redirects(net);
    expect(r).toHaveLength(1);
    expect(r[0].sid).toBe(CALL_SID);
    expect(r[0].twiml).toContain("<Record");
    expect(events(net)).toContain("conference_voicemail");
  });

  it("a leg that was only REDIRECTED (resume re-joining) is still live: ignored, nothing listed", async () => {
    const net = twilioSetup(liveCall({ transfer_state: "conference" }), { callStatus: { [MY_LEG]: "in-progress" }, participants: [customerIn()] });
    await leave(MY_LEG);
    expect(net.to(/Participants\.json/)).toEqual([]);
    expect(redirects(net)).toEqual([]);
  });

  it("you drop after the teammate joined: the customer is not alone, nothing happens", async () => {
    const net = twilioSetup(liveCall({ transfer_state: "conference", answered_by: USER_B, transferred_from: USER_A, client_call_sid: TEAMMATE_LEG }), {
      conference: { sid: CONF, friendly_name: CALL_ID, status: "in-progress" },
      participants: [customerIn(), { call_sid: TEAMMATE_LEG, hold: false, muted: false, status: "connected" }],
    });
    await leave(MY_LEG);
    expect(redirects(net)).toEqual([]);
    expect(participantUpdates(net)).toEqual([]);
  });

  it("you drop MID-CONSULT (the customer on hold, the teammate took the call): the customer comes off hold and is left with the teammate", async () => {
    const net = twilioSetup(liveCall({ transfer_state: "conference", answered_by: USER_B, transferred_from: USER_A, client_call_sid: TEAMMATE_LEG }), {
      conference: { sid: CONF, friendly_name: CALL_ID, status: "in-progress" },
      participants: [customerIn(true), { call_sid: TEAMMATE_LEG, hold: false, muted: false, status: "connected" }],
      callStatus: { [MY_LEG]: "completed" },
    });
    await leave(MY_LEG);
    expect(participantUpdates(net)).toEqual([{ sid: CALL_SID, form: { Hold: "false" } }]);
    expect(redirects(net)).toEqual([]);
    expect(patches(net)).toEqual([]); // still in its conference
  });

  it("the TEAMMATE drops mid-consult: the customer stays on hold for you (Resume is yours to press)", async () => {
    const net = twilioSetup(liveCall({ transfer_state: "conference", answered_by: USER_B, transferred_from: USER_A, client_call_sid: TEAMMATE_LEG }), {
      conference: { sid: CONF, friendly_name: CALL_ID, status: "in-progress" },
      participants: [customerIn(true), { call_sid: MY_LEG, hold: false, muted: false, status: "connected" }],
      callStatus: { [TEAMMATE_LEG]: "completed" },
    });
    await leave(TEAMMATE_LEG);
    expect(participantUpdates(net)).toEqual([]);
    expect(redirects(net)).toEqual([]);
  });

  // Twilio also sends a leave for a Participants-API leg that never answered (its changelog added
  // ParticipantCallStatus and ReasonParticipantLeft to that event for it). client_call_sid is
  // still yours then, so the hand-over check read "the transferrer left" and took the customer
  // off hold, to talk to you while your app said On hold.
  it.each(["no-answer", "busy", "canceled", "failed"])("a teammate who never answered (%s) leaving: the customer on hold stays on hold for you, nothing handed over", async (status) => {
    const net = twilioSetup(liveCall({ transfer_state: "conference" }), resumedRoom(true, { callStatus: { [TEAMMATE_LEG]: status } }));
    await leave(TEAMMATE_LEG);
    expect(participantUpdates(net)).toEqual([]);
    expect(redirects(net)).toEqual([]);
    expect(events(net)).not.toContain("handed_over");
  });

  it("...and a customer that leaves alone goes to voicemail, as the leg's own status callback sends them (warmLegStatus), never hung up", async () => {
    const net = twilioSetup(liveCall({ transfer_state: "conference" }), {
      conference: inProgress, participants: [customerIn(false)], callStatus: { [TEAMMATE_LEG]: "no-answer" },
    }, { events: [startedEvent()] });
    await leave(TEAMMATE_LEG);
    const r = redirects(net);
    expect(r).toHaveLength(1);
    expect(r[0].twiml).toContain("<Record");
    expect(net.writes("phone_call_events").find((s) => s.json.type === "conference_voicemail")?.json.data).toEqual({ prefer: "voicemail" });
  });

  it("Twilio's list still showing the leg that left does not stop the customer being finished", async () => {
    const net = twilioSetup(liveCall({ transfer_state: "conference" }), plainHold({ callStatus: { [MY_LEG]: "completed" } }));
    await leave(MY_LEG);
    expect(redirects(net)[0].twiml).toContain("<Record");
  });

  it.each([
    ["the customer leaving (the conference ends by itself)", liveCall({ transfer_state: "conference" }), CALL_SID],
    ["a call no longer in its conference", liveCall({ transfer_state: null }), MY_LEG],
    ["a call that has ended", liveCall({ transfer_state: "conference", ended_at: new Date().toISOString() }), MY_LEG],
  ])("ignores %s", async (_l, row, leaving) => {
    const net = twilioSetup(row, { participants: [customerIn()], conference: { sid: CONF, friendly_name: CALL_ID, status: "in-progress" } });
    await leave(leaving);
    expect(net.to(/api\.twilio\.com/)).toEqual([]);
  });

  it("if finishing the customer fails at Twilio, the row goes back to the conference state and the failure is logged", async () => {
    const net = twilioSetup(liveCall({ transfer_state: "conference" }), {
      conference: { sid: CONF, friendly_name: CALL_ID, status: "in-progress" },
      participants: [customerIn(false)],
      failRedirect: true,
    });
    await leave(MY_LEG);
    const bodies = patches(net);
    expect(bodies[0].body).toEqual({ transfer_state: null });
    expect(bodies[1].body).toEqual({ transfer_state: "conference" });
    expect(bodies[1].url).toContain("transfer_state=is.null");
    expect(net.writes("app_errors").map((s) => s.json.code)).toContain("conference_event_failed");
  });

  it("two leave events racing: only the one that wins the claim finishes the customer", async () => {
    const net = twilioSetup(liveCall({ transfer_state: "conference" }), {
      conference: { sid: CONF, friendly_name: CALL_ID, status: "in-progress" }, participants: [customerIn()],
    }, { claimed: false });
    await leave(MY_LEG);
    expect(redirects(net)).toEqual([]);
  });
});

describe("/voice/conference (the conference started)", () => {
  const start = async (e = env, params: Record<string, string> = {}) => call(e, await twilioPost(e, "/voice/conference", {
    StatusCallbackEvent: "conference-start", ConferenceSid: CONF, FriendlyName: CALL_ID, AccountSid: ACCOUNT, SequenceNumber: "1", ...params,
  }, { call: CALL_ID }));
  const recorded = (net: FakeNet) => net.writes("phone_call_events").filter((s) => s.json.type === "conference_started").map((s) => s.json.data);

  it("records Twilio's start event under the call, keyed by the ConferenceSid; 204 at once, nothing asked of Twilio", async () => {
    const net = twilioSetup(liveCall({ transfer_state: "conference" }), resumedRoom());
    const { res, text } = await start();
    expect(res.status).toBe(204);
    expect(text).toBe("");
    expect(recorded(net)).toEqual([{ conference_sid: CONF }]);
    expect(net.writes("phone_call_events")[0].json.call_id).toBe(CALL_ID);
    expect(net.to(/api\.twilio\.com/)).toEqual([]);
  });

  it("...which is what the next Resume reads: the customer comes off hold, your leg is not moved", async () => {
    // The leg that started it (a teammate who took a warm transfer) has left: the list alone
    // cannot prove it any more.
    const { net, token } = await appSetup(liveCall({ transfer_state: "conference" }), plainHold({ participants: [customerIn(true), agentIn()] }), { events: [startedEvent()] });
    await press(token, "resume");
    const read = net.reads("phone_call_events").find((s) => s.url.searchParams.get("type") === "eq.conference_started")!;
    expect(filter(read, "call_id")).toBe(CALL_ID);
    expect(read.url.searchParams.get("data->>conference_sid")).toBe(`eq.${CONF}`);
    expect(participantUpdates(net)).toEqual([{ sid: CALL_SID, form: { Hold: "false" } }]);
    expect(redirects(net)).toEqual([]);
  });

  it("a start that can't be written is an error (conference_event_failed), never a silent 'started'", async () => {
    const net = twilioSetup(liveCall({ transfer_state: "conference" }), resumedRoom());
    net.rest("POST", "phone_call_events", () => jsonRes({ message: "boom" }, 500));
    await start();
    expect(net.writes("app_errors").map((s) => s.json.code)).toContain("conference_event_failed");
  });

  it("no ConferenceSid, or no call id: nothing recorded", async () => {
    const net = twilioSetup(liveCall({ transfer_state: "conference" }));
    expect((await start(env, { ConferenceSid: "" })).res.status).toBe(204);
    const noCall = await call(env, await twilioPost(env, "/voice/conference", { StatusCallbackEvent: "conference-start", ConferenceSid: CONF, AccountSid: ACCOUNT }, {}));
    expect(noCall.res.status).toBe(204);
    expect(recorded(net)).toEqual([]);
  });

  describe("accepted on ?key= alone (no TWILIO_AUTH_TOKEN)", () => {
    const keyOnly = makeEnv({ TWILIO_AUTH_TOKEN: undefined });

    it("counts when Twilio's participant list proves it (a connected leg that joined with start=true, beside another)", async () => {
      const net = twilioSetup(liveCall({ transfer_state: "conference" }), resumedRoom());
      await start(keyOnly);
      expect(recorded(net)).toEqual([{ conference_sid: CONF }]);
    });

    it("a forged one for a conference nobody has started (a plain Hold) is not recorded, and says so", async () => {
      const net = twilioSetup(liveCall({ transfer_state: "conference" }), plainHold());
      await start(keyOnly);
      expect(recorded(net)).toEqual([]);
      expect(net.writes("app_errors").map((s) => s.json.code)).toContain("conference_start_unverified");
    });
  });
});

describe("/voice/status while the call is in its conference", () => {
  const legEnds = async (sid: string, query: Record<string, string>) =>
    call(env, await twilioPost(env, "/voice/status", { CallSid: sid, CallStatus: "completed", CallDuration: "40", AccountSid: ACCOUNT }, query));

  it("your (inbound, child) leg ending does NOT close the call: the customer may still be talking to a teammate", async () => {
    const net = twilioSetup(liveCall({ transfer_state: "conference" }), {
      conference: { sid: CONF, friendly_name: CALL_ID, status: "in-progress" },
      participants: [customerIn(), { call_sid: TEAMMATE_LEG, hold: false, muted: false, status: "connected" }],
    });
    await legEnds(MY_LEG, { call: CALL_ID, leg: "client" });
    expect(patches(net)).toEqual([]);
    expect(redirects(net)).toEqual([]);
  });

  // The backstop: the leave event is skipped when Twilio still reports the leaving leg live, and
  // only logged when a REST read fails. The holder's own final status must also finish a
  // customer it left alone, or they hear hold music until they give up.
  it.each([
    ["leg=client (inbound, the answering app)", { call: CALL_ID, leg: "client" }, liveCall({ transfer_state: "conference" }), MY_LEG],
    ["leg=cell (a forwarded cell that pressed 1)", { call: CALL_ID, leg: "cell", user: USER_A }, liveCall({ transfer_state: "conference" }), MY_LEG],
    ["leg=warm (the teammate who took a warm transfer)", { call: CALL_ID, leg: "warm", user: USER_B }, liveCall({ transfer_state: "conference", answered_by: USER_B, transferred_from: USER_A, client_call_sid: TEAMMATE_LEG }), TEAMMATE_LEG],
    ["the outbound app leg (TwiML App callback, no call id)", { leg: "client" }, outboundCall({ transfer_state: "conference" }), MY_LEG],
  ] as const)("the holder's leg ending, %s, finishes a customer left on hold: voicemail, even with no leave event", async (_l, query, row, sid) => {
    const net = twilioSetup(row, {
      conference: { sid: CONF, friendly_name: CALL_ID, status: "in-progress" },
      // Twilio's list may still show the leg that just ended; its own status proves it gone.
      participants: [customerIn(true), { call_sid: sid, hold: false, muted: false, status: "connected" }],
    });
    await legEnds(sid, { ...query });
    const claim = patches(net)[0];
    expect(claim.body).toEqual({ transfer_state: null });
    expect(claim.url).toContain("transfer_state=eq.conference");
    const r = redirects(net);
    expect(r).toHaveLength(1);
    expect(r[0].sid).toBe(CALL_SID);
    expect(r[0].twiml).toContain("<Record");
  });

  it("the holder's leg ending while you were talking hangs the customer up, as a plain call ends", async () => {
    const net = twilioSetup(liveCall({ transfer_state: "conference" }), {
      conference: inProgress, participants: [customerIn(false)],
    }, { events: [startedEvent()] });
    await legEnds(MY_LEG, { call: CALL_ID, leg: "client" });
    expect(redirects(net)).toEqual([{ sid: CALL_SID, twiml: null, status: "completed" }]);
  });

  it("the holder's leg ending on a plain Hold (in-progress, never started) sends the customer to voicemail, not a hang-up", async () => {
    const net = twilioSetup(liveCall({ transfer_state: "conference" }), plainHold());
    await legEnds(MY_LEG, { call: CALL_ID, leg: "client" });
    const r = redirects(net);
    expect(r).toHaveLength(1);
    expect(r[0].sid).toBe(CALL_SID);
    expect(r[0].twiml).toContain("<Record");
  });

  it("a leg that only RANG (not the holder) ending is not a reason to finish anyone", async () => {
    const other = "CA" + "0".repeat(31) + "9";
    const net = twilioSetup(liveCall({ transfer_state: "conference" }), {
      conference: { sid: CONF, friendly_name: CALL_ID, status: "in-progress" }, participants: [customerIn(true)],
    });
    await call(env, await twilioPost(env, "/voice/status", { CallSid: other, CallStatus: "canceled", AccountSid: ACCOUNT }, { call: CALL_ID, leg: "client" }));
    expect(net.to(/Conferences/)).toEqual([]);
    expect(redirects(net)).toEqual([]);
  });

  it("the leave event having finished the customer first: the backstop loses the claim and does nothing", async () => {
    const net = twilioSetup(liveCall({ transfer_state: "conference" }), {
      conference: { sid: CONF, friendly_name: CALL_ID, status: "in-progress" }, participants: [customerIn(true)],
    }, { claimed: false });
    await legEnds(MY_LEG, { call: CALL_ID, leg: "client" });
    expect(redirects(net)).toEqual([]);
  });

  it("accepted on ?key= alone, a 'completed' Twilio does not agree with (the leg is live) hangs nobody up", async () => {
    const keyOnly = makeEnv({ TWILIO_AUTH_TOKEN: undefined });
    // Talking after Resume: your leg re-joined with start=true, and Twilio's list still shows it.
    const room = resumedRoom(false);
    const forged = twilioSetup(liveCall({ transfer_state: "conference" }), { ...room, callStatus: { [MY_LEG]: "in-progress" } });
    await call(keyOnly, await twilioPost(keyOnly, "/voice/status", { CallSid: MY_LEG, CallStatus: "completed", AccountSid: ACCOUNT }, { call: CALL_ID, leg: "client" }));
    expect(redirects(forged)).toEqual([]);
    expect(patches(forged)).toEqual([]);
    // ...while a real one (Twilio says completed) still finishes the customer.
    const real = twilioSetup(liveCall({ transfer_state: "conference" }), { ...room, callStatus: { [MY_LEG]: "completed" } });
    await call(keyOnly, await twilioPost(keyOnly, "/voice/status", { CallSid: MY_LEG, CallStatus: "completed", AccountSid: ACCOUNT }, { call: CALL_ID, leg: "client" }));
    expect(redirects(real)).toEqual([{ sid: CALL_SID, twiml: null, status: "completed" }]);
  });

  it("a failed backstop is logged under its own code", async () => {
    const net = twilioSetup(liveCall({ transfer_state: "conference" }));
    net.on("GET", (u) => u.pathname.endsWith("/Conferences.json"), () => jsonRes({ code: 20500 }, 500));
    await legEnds(MY_LEG, { call: CALL_ID, leg: "client" });
    expect(net.writes("app_errors").map((s) => s.json.code)).toContain("conference_backstop_failed");
  });

  it("the outbound customer's leg ending closes the call and clears the conference state", async () => {
    const net = twilioSetup(outboundCall({ transfer_state: "conference" }));
    await call(env, await twilioPost(env, "/voice/status", { CallSid: CALL_SID, CallStatus: "completed", CallDuration: "95", AccountSid: ACCOUNT }, { call: CALL_ID, leg: "pstn" }));
    const bodies = patches(net).map((p) => p.body);
    expect(bodies[0]).toMatchObject({ status: "completed" });
    expect(bodies).toContainEqual({ transfer_state: null });
  });

  it("the inbound customer's leg ending closes it too (the existing parent-leg path)", async () => {
    const net = twilioSetup(liveCall({ transfer_state: "conference", answered_by: USER_C }));
    await call(env, await twilioPost(env, "/voice/status", { CallSid: CALL_SID, CallStatus: "completed", AccountSid: ACCOUNT }, { leg: "pstn" }));
    const bodies = patches(net).map((p) => p.body);
    expect(bodies[0]).toMatchObject({ status: "completed" });
    expect(bodies).toContainEqual({ transfer_state: null });
    expect(filter(net.reads("phone_calls")[0], "twilio_call_sid")).toBe(CALL_SID);
  });
});

// ── Reviewer follow-ups (2026-09-29) ────────────────────────────────────────────────

/** A phone_call_events row for this call, `secondsAgo` old. */
const ev = (type: string, data: Record<string, unknown> | null, secondsAgo: number): EventFixture => ({
  call_id: CALL_ID, type, at: new Date(Date.now() - secondsAgo * 1000).toISOString(), data,
});

describe("Hold pressed while a Resume is still landing (nothing proves the conference started yet)", () => {
  // Resume redirects your leg back in with startConferenceOnEnter=true. Until it lands nothing
  // proves the conference started (it reads in-progress either way), and "not started is
  // already hold" would answer held:true while the conference is about to start and connect
  // the customer.
  const landing = { conference: inProgress, participants: [customerIn()] }; // your leg on its way back in
  const resumed = [ev("hold", { user: USER_A, moved: true }, 30), ev("resume", { user: USER_A }, 1)];
  const inConference = () => liveCall({ transfer_state: "conference" });

  it("holds the customer through the Participants API first, so the conference starting leaves them on hold: held:true is true", async () => {
    const { net, token } = await appSetup(inConference(), landing, { events: resumed });
    const { res, json } = await press(token, "hold");
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, held: true, call_id: CALL_ID });
    expect(participantUpdates(net)).toEqual([{ sid: CALL_SID, form: { Hold: "true", HoldUrl: HOLD_MUSIC, HoldMethod: "GET" } }]);
    expect(redirects(net)).toEqual([]);
    expect(net.writes("phone_call_events").find((s) => s.json.type === "hold")?.json.data).toEqual({ user: USER_A, moved: false, after_resume: true });
    const reads = net.reads("phone_call_events");
    expect(reads.map((s) => s.url.searchParams.get("type"))).toEqual(["eq.conference_started", "in.(hold,resume,transfer)"]);
    expect(reads.every((s) => filter(s, "call_id") === CALL_ID)).toBe(true);
  });

  // The customer is held through the Participants API whether or not a Resume is landing (safe
  // either way); what the events decide is what a refusal means. 404 below: their leg is not in.
  it("a Resume from before a cold transfer was in the conference that ended: Hold in the new one (entered by a warm-transfer move) is not 'still landing', so a 404 answers held:true", async () => {
    // Conference 1 (C's): hold, resume. C cold-transfers to you. You warm-transfer to B, which
    // moves the call into conference 2 (not started until someone starts it), and B misses. You
    // press Hold. Before, C's old Resume read as "still landing": the customer, on music, was
    // Participants-held, and a 404 answered held:false although they were on hold.
    const { net, token } = await appSetup(inConference(), { ...landing, participantStatus: 404 }, {
      events: [
        ev("hold", { user: USER_C, moved: true }, 90), ev("resume", { user: USER_C }, 80),
        ev("transfer", { from: USER_C, to: USER_A, dnd: false }, 60),
        ev("warm_transfer", { from: USER_A, to: USER_B, sid: TEAMMATE_LEG, moved: true }, 30),
        ev("warm_transfer_missed", { user: USER_B, status: "no-answer", sid: TEAMMATE_LEG }, 5),
      ],
    });
    const { res, json } = await press(token, "hold");
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, held: true, call_id: CALL_ID });
    expect(participantUpdates(net)).toHaveLength(1);
    expect(net.writes("phone_call_events").find((x) => x.json.type === "hold")?.json.data).toEqual({ user: USER_A, moved: false });
  });

  it("...while a Resume in THIS conference (after the cold transfer) still counts: the 404 says the customer is NOT held", async () => {
    const { token } = await appSetup(inConference(), { ...landing, participantStatus: 404 }, {
      events: [
        ev("transfer", { from: USER_C, to: USER_A, dnd: false }, 90),
        ev("hold", { user: USER_A, moved: true }, 30), ev("resume", { user: USER_A }, 1),
      ],
    });
    const { res, json } = await press(token, "hold");
    expect(res.status).toBe(400);
    expect(json.held).toBe(false);
  });

  it.each([
    ["a Hold since that Resume (it has landed)", [ev("resume", { user: USER_A }, 60), ev("hold", { user: USER_A, moved: false }, 2)]],
    ["an app's own timing mark called 'resume' (only the Worker's events count)", [ev("hold", { user: USER_A, moved: true }, 30), ev("resume", { source: "app", user: USER_A }, 1)]],
  ])("no Resume landing, %s: a 404 answers held:true", async (_l, evs) => {
    const { net, token } = await appSetup(inConference(), { ...landing, participantStatus: 404 }, { events: evs });
    const { res, json } = await press(token, "hold");
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, held: true, call_id: CALL_ID });
    expect(participantUpdates(net)).toHaveLength(1);
  });

  it("the customer's leg not in the conference either (404): refused, and the body says the customer is NOT held", async () => {
    const { net, token } = await appSetup(inConference(), { ...landing, participantStatus: 404 }, { events: resumed });
    const { res, json } = await press(token, "hold");
    expect(res.status).toBe(400);
    expect(json).toEqual({
      ok: false, held: false, call_id: CALL_ID,
      error: { code: "bad_request", message: "The call is still coming off hold. Press Hold again in a moment." },
    });
    expect(events(net)).not.toContain("hold");
  });

  it("Twilio refusing the hold: twilio_error with held:false (the conference starts with the two of you talking)", async () => {
    const { net, token } = await appSetup(inConference(), { ...landing, participantStatus: 500 }, { events: resumed });
    const { res, json } = await press(token, "hold");
    expect(res.status).toBe(502);
    expect(json).toMatchObject({ ok: false, held: false, call_id: CALL_ID, error: { code: "twilio_error", message: "Hold didn't work. You're still on the call." } });
    expect(net.writes("app_errors").map((s) => s.json.code)).toContain("hold_failed");
  });

  it("a failed event read counts as no Resume landing: the customer is still held, and a 404 answers held:true", async () => {
    const { net, token } = await appSetup(inConference(), { ...landing, participantStatus: 404 });
    net.rest("GET", "phone_call_events", () => jsonRes({ message: "boom" }, 500));
    const { res, json } = await press(token, "hold");
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, held: true, call_id: CALL_ID });
    expect(participantUpdates(net)).toHaveLength(1);
  });

  it("a conference the participant list proves STARTED (your leg landed with start=true) never reads the events: the Participants hold is the whole answer", async () => {
    const { net, token } = await appSetup(inConference(), resumedRoom(), { events: resumed });
    await press(token, "hold");
    expect(net.reads("phone_call_events")).toEqual([]);
    expect(participantUpdates(net)).toHaveLength(1);
  });
});

describe("Resume into a conference nobody has started", () => {
  it("writes its event BEFORE it answers, so a Hold pressed right after sees it", async () => {
    const { net, token } = await appSetup(liveCall({ transfer_state: "conference" }), plainHold());
    const ctx = new FakeCtx();
    const res = await worker.fetch(appRequest("POST", `/calls/${CALL_ID}/resume`, token, {}), env, ctx as unknown as ExecutionContext);
    expect(res.status).toBe(200);
    // Nothing in the background has been waited for yet.
    expect(events(net)).toEqual(["resume"]);
    await ctx.settle();
  });
});

describe("a warm transfer nobody answers tells the apps at once", () => {
  const room = (participants: Participant[]) => ({ conference: inProgress, participants });
  const me = { call_sid: MY_LEG, hold: false, muted: false, status: "connected" };
  const touches = (net: FakeNet) => patches(net).filter((p) => p.body.transfer_state === "conference");

  it("you are still there: the missed event (with the teammate's leg) goes in FIRST, then transfer_state is written back to 'conference', guarded, so the row's broadcast fires", async () => {
    const net = twilioSetup(liveCall({ transfer_state: "conference" }), room([customerIn(true), me]));
    await warmStatus("no-answer");
    const missed = net.writes("phone_call_events").find((s) => s.json.type === "warm_transfer_missed")!;
    expect(missed.json.data).toEqual({ user: USER_B, status: "no-answer", sid: TEAMMATE_LEG });
    expect(patches(net)).toEqual([{ body: { transfer_state: "conference" }, url: expect.stringContaining("transfer_state=eq.conference") }]);
    const touch = net.seen.findIndex((s) => s.method === "PATCH" && s.url.pathname === "/rest/v1/phone_calls");
    expect(net.seen.indexOf(missed)).toBeLessThan(touch);
    expect(redirects(net)).toEqual([]);
    expect(participantUpdates(net)).toEqual([]);
  });

  it("the customer alone goes to voicemail, which changes the row by itself: no second write", async () => {
    const net = twilioSetup(liveCall({ transfer_state: "conference" }), room([customerIn()]));
    await warmStatus("no-answer");
    expect(patches(net).map((p) => p.body)).toEqual([{ transfer_state: null }]);
    expect(redirects(net)[0].twiml).toContain("<Record");
  });

  it("Twilio's list still showing the teammate's leg (it has ended) does not keep the customer, alone, from voicemail", async () => {
    const net = twilioSetup(liveCall({ transfer_state: "conference" }), room([customerIn(), { call_sid: TEAMMATE_LEG, hold: false, muted: false, status: "ringing" }]));
    await warmStatus("busy");
    const r = redirects(net);
    expect(r).toHaveLength(1);
    expect(r[0].sid).toBe(CALL_SID);
    expect(r[0].twiml).toContain("<Record");
  });

  it("no conference to be found: still touched, so the apps re-read", async () => {
    const net = twilioSetup(liveCall({ transfer_state: "conference" }), { conference: null });
    await warmStatus("no-answer");
    expect(touches(net)).toHaveLength(1);
  });

  it("a failure finishing the customer is logged, and the row is still touched", async () => {
    const net = twilioSetup(liveCall({ transfer_state: "conference" }));
    net.on("GET", (u) => u.pathname.endsWith("/Conferences.json"), () => jsonRes({ code: 20500 }, 500));
    await warmStatus("failed");
    expect(net.writes("app_errors").map((s) => s.json.code)).toContain("warm_transfer_finish_failed");
    expect(touches(net)).toHaveLength(1);
  });

  it.each([
    ["the call left its conference meanwhile", liveCall({ transfer_state: null })],
    ["the call has ended", liveCall({ transfer_state: "conference", ended_at: new Date().toISOString() })],
  ])("%s: nothing written at all", async (_l, row) => {
    const net = twilioSetup(row, room([customerIn()]));
    await warmStatus("no-answer");
    expect(patches(net)).toEqual([]);
    expect(events(net)).not.toContain("warm_transfer_missed");
  });
});

describe("a customer left alone after a warm transfer is finished as any call is (SPEC section 3: after a miss, hanging up is an ordinary end)", () => {
  // For a few hours the Worker read the call's warm transfers here and sent a customer who was
  // talking to voicemail if the latest one had not been taken. That outlived the transfer: a
  // miss, then Resume, then an ordinary goodbye played the greeting (DEVIATIONS 52, withdrawn).
  const rang = ev("warm_transfer", { from: USER_A, to: USER_B, sid: TEAMMATE_LEG, moved: false }, 60);
  const missed = ev("warm_transfer_missed", { user: USER_B, status: "no-answer", sid: TEAMMATE_LEG }, 40);
  // Talking: the conference started (Twilio's start event recorded) and the customer is not held.
  const talking = (holderLeg = MY_LEG) => ({
    conference: inProgress, participants: [customerIn(false)], callStatus: { [holderLeg]: "completed" },
  });
  const started = startedEvent();
  const hungUp = [{ sid: CALL_SID, twiml: null, status: "completed" }];

  it("B misses, you press Resume, finish the conversation and hang up first: the call simply ends, never the voicemail greeting", async () => {
    const net = twilioSetup(liveCall({ transfer_state: "conference" }), talking(), {
      events: [ev("hold", { user: USER_A, moved: true }, 90), rang, missed, ev("resume", { user: USER_A }, 30), started],
    });
    await leave(MY_LEG);
    expect(redirects(net)).toEqual(hungUp);
    expect(events(net)).toEqual(["conference_ended"]);
    // Only whether the conference started; never the warm transfers.
    expect(net.reads("phone_call_events").map((s) => s.url.searchParams.get("type"))).toEqual(["eq.conference_started"]);
  });

  it("B's missed callback was lost (the transfer still reads 'ringing') and B is no longer listed: hung up, not voicemail", async () => {
    const net = twilioSetup(liveCall({ transfer_state: "conference" }), talking(), { events: [rang, started] });
    await leave(MY_LEG);
    expect(redirects(net)).toEqual(hungUp);
  });

  it("the holder's own leg ending (the backstop) after a miss: hung up the same way", async () => {
    const net = twilioSetup(liveCall({ transfer_state: "conference" }), talking(), { events: [rang, missed, started] });
    await call(env, await twilioPost(env, "/voice/status", { CallSid: MY_LEG, CallStatus: "completed", AccountSid: ACCOUNT }, { call: CALL_ID, leg: "client" }));
    expect(redirects(net)).toEqual(hungUp);
  });

  it("a plain Hold, B missed, nobody pressed Resume (nothing ever started): the customer was waiting, so you hanging up sends them to voicemail", async () => {
    const net = twilioSetup(liveCall({ transfer_state: "conference" }), talking(), { events: [ev("hold", { user: USER_A, moved: true }, 90), rang, missed] });
    await leave(MY_LEG);
    const r = redirects(net);
    expect(r).toHaveLength(1);
    expect(r[0].twiml).toContain("<Record");
  });

  it("you hang up while B is still ringing: B is in the list, so the customer is not alone and nothing happens; B then missing sends them to voicemail", async () => {
    const ringing = { call_sid: TEAMMATE_LEG, hold: false, muted: false, status: "ringing" };
    const room = { ...talking(), participants: [customerIn(false), ringing] };
    const first = twilioSetup(liveCall({ transfer_state: "conference" }), room, { events: [rang] });
    await leave(MY_LEG);
    expect(redirects(first)).toEqual([]);
    expect(patches(first)).toEqual([]);
    const then = twilioSetup(liveCall({ transfer_state: "conference" }), room, { events: [rang] });
    await warmStatus("no-answer");
    const r = redirects(then);
    expect(r).toHaveLength(1);
    expect(r[0].sid).toBe(CALL_SID);
    expect(r[0].twiml).toContain("<Record");
  });

  it("a warm transfer the teammate TOOK: when they hang up on the customer they were talking to, the call simply ends", async () => {
    const net = twilioSetup(liveCall({ transfer_state: "conference", answered_by: USER_B, transferred_from: USER_A, client_call_sid: TEAMMATE_LEG }), talking(TEAMMATE_LEG), { events: [rang, started] });
    await leave(TEAMMATE_LEG);
    expect(redirects(net)).toEqual(hungUp);
  });

  it("a customer who was waiting (held) still goes to voicemail", async () => {
    const net = twilioSetup(liveCall({ transfer_state: "conference" }), { ...talking(), participants: [customerIn(true)] }, { events: [rang, missed] });
    await leave(MY_LEG);
    expect(redirects(net)[0].twiml).toContain("<Record");
    expect(net.writes("phone_call_events").find((s) => s.json.type === "conference_voicemail")?.json.data).toEqual({ prefer: "auto" });
  });
});

describe("a missed warm leg accepted on ?key= alone (no TWILIO_AUTH_TOKEN) counts only when Twilio agrees", () => {
  // The miss leaves its CallSid out of the participant count. Unchecked, a forged one naming a
  // leg still in the call made the customer look alone: voicemail mid-conversation.
  const keyOnly = makeEnv({ TWILIO_AUTH_TOKEN: undefined });
  const unsignedMiss = async (sid: string, user: string, status = "no-answer") => call(keyOnly, await twilioPost(keyOnly, "/voice/status", {
    CallSid: sid, CallStatus: status, AccountSid: ACCOUNT,
  }, { call: CALL_ID, leg: "warm", user }));
  const identity = (u: string) => `client:u_${u.replace(/-/g, "")}_g3`;
  const me = { call_sid: MY_LEG, hold: false, muted: false, status: "connected" };
  const ringing = { call_sid: TEAMMATE_LEG, hold: false, muted: false, status: "ringing" };
  const touched = (net: FakeNet) => patches(net).filter((p) => p.body.transfer_state === "conference");

  it("B took the call and dropped; you are talking to the customer again. A forged miss naming YOUR live leg sends nobody to voicemail and records nothing", async () => {
    // Your leg is not client_call_sid any more (B's is), so the holder backstop never sees it.
    const net = twilioSetup(liveCall({ transfer_state: "conference", answered_by: USER_B, transferred_from: USER_A, client_call_sid: TEAMMATE_LEG }), {
      conference: inProgress, participants: [customerIn(false), me],
      callStatus: { [MY_LEG]: "in-progress" }, callTo: { [MY_LEG]: identity(USER_A) },
    });
    await unsignedMiss(MY_LEG, USER_A);
    expect(redirects(net)).toEqual([]);
    expect(patches(net)).toEqual([]);
    expect(events(net)).not.toContain("warm_transfer_missed");
    expect(net.writes("app_errors").map((s) => s.json.code)).toContain("warm_miss_unverified");
  });

  it("you hung up while B rings: a forged miss for B's leg, still ringing, does not send the customer to voicemail", async () => {
    const net = twilioSetup(liveCall({ transfer_state: "conference" }), {
      conference: inProgress, participants: [customerIn(false), ringing],
      callStatus: { [TEAMMATE_LEG]: "ringing" }, callTo: { [TEAMMATE_LEG]: identity(USER_B) },
    });
    await unsignedMiss(TEAMMATE_LEG, USER_B);
    expect(redirects(net)).toEqual([]);
    expect(events(net)).not.toContain("warm_transfer_missed");
  });

  it("a leg that has ended but rang someone else is not recorded as that user's miss", async () => {
    const net = twilioSetup(liveCall({ transfer_state: "conference" }), {
      conference: inProgress, participants: [customerIn(false), me],
      callStatus: { [TEAMMATE_LEG]: "no-answer" }, callTo: { [TEAMMATE_LEG]: identity(USER_C) },
    });
    await unsignedMiss(TEAMMATE_LEG, USER_B);
    expect(events(net)).not.toContain("warm_transfer_missed");
    expect(touched(net)).toEqual([]);
  });

  it("a real miss Twilio agrees with, you still there: recorded with the leg, and the row touched", async () => {
    const net = twilioSetup(liveCall({ transfer_state: "conference" }), {
      conference: inProgress, participants: [customerIn(true), me],
      callStatus: { [TEAMMATE_LEG]: "no-answer" }, callTo: { [TEAMMATE_LEG]: `${identity(USER_B)}?call_id=${CALL_ID}&transferred_by=${USER_A}` },
    });
    await unsignedMiss(TEAMMATE_LEG, USER_B);
    expect(net.writes("phone_call_events").find((s) => s.json.type === "warm_transfer_missed")?.json.data)
      .toEqual({ user: USER_B, status: "no-answer", sid: TEAMMATE_LEG });
    expect(touched(net)).toHaveLength(1);
    expect(redirects(net)).toEqual([]);
  });

  it("a real miss with the customer alone: voicemail, even while Twilio's list still shows the ended leg", async () => {
    const net = twilioSetup(liveCall({ transfer_state: "conference" }), {
      conference: inProgress, participants: [customerIn(false), ringing],
      callStatus: { [TEAMMATE_LEG]: "busy" }, callTo: { [TEAMMATE_LEG]: identity(USER_B) },
    });
    await unsignedMiss(TEAMMATE_LEG, USER_B, "busy");
    const r = redirects(net);
    expect(r).toHaveLength(1);
    expect(r[0].sid).toBe(CALL_SID);
    expect(r[0].twiml).toContain("<Record");
  });

  it("Twilio's record can't be read: not recorded, and the list is taken as Twilio gives it (a customer Twilio lists alone still goes to voicemail)", async () => {
    const net = twilioSetup(liveCall({ transfer_state: "conference" }), { conference: inProgress, participants: [customerIn(false)] });
    net.on("GET", (u) => /\/Calls\/CA[0-9a-f]+\.json$/.test(u.pathname), () => jsonRes({ code: 20500 }, 500));
    await unsignedMiss(TEAMMATE_LEG, USER_B);
    expect(events(net)).not.toContain("warm_transfer_missed");
    expect(redirects(net)[0].twiml).toContain("<Record");
  });
});
