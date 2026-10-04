// Your own voicemail greeting (migration 264): the recording ring (POST /settings/me/greeting/record),
// its TwiML and save (/voice/greeting), the audio <Play> fetches (GET /voice/greeting-audio), and
// Play / "Use the standard greeting" (GET /settings/me/greeting/audio, POST .../clear). No call is
// ever placed: Twilio is the fake network. Every sid here is a fake (RE + 32 hex).
import { beforeEach, describe, expect, it } from "vitest";
import {
  Auth, BASE, BUSINESS_NUMBER, CLIENT, FakeNet, USER_A, USER_B, WEBHOOK_KEY,
  appRequest, attr, call, callerCtx, filter, jsonRes, makeEnv, twilioPost,
} from "./helpers";
import { GREETING_SAY, greetingAudioUrl, saveGreeting } from "../src/greeting";
import { resetGreetingRings } from "../src/routes/greeting";
import { adminClient } from "../src/db";
import { FakeCtx } from "./helpers";

const RE = (n: number) => "RE" + n.toString(16).padStart(32, "0");
const OLD = RE(1);
const NEW = RE(2);
const TWILIO_CALLS = /api\.twilio\.com\/2010-04-01\/Accounts\/AC0+\/Calls\.json$/;
const recordingDeletes = (net: FakeNet) => net.seen.filter((s) => s.method === "DELETE" && /\/Recordings\/RE[0-9a-f]{32}\.json$/.test(s.url.pathname))
  .map((s) => s.url.pathname.split("/").pop()!.replace(".json", ""));

beforeEach(() => resetGreetingRings());

// ── POST /settings/me/greeting/record ───────────────────────────────────────────────

describe("POST /settings/me/greeting/record", () => {
  async function setup(ctx: Record<string, unknown> | null = callerCtx({ device_generation: 3 }), twilioStatus = 201) {
    const net = new FakeNet().install();
    const auth = await new Auth().init();
    auth.serve(net);
    net.rpc("phone_caller_context", () => ctx);
    net.rest("POST", "app_errors", () => []);
    net.on("POST", TWILIO_CALLS, () => (twilioStatus < 300 ? jsonRes({ sid: "CA" + "0".repeat(31) + "9" }, twilioStatus) : jsonRes({ code: 31005 }, twilioStatus)));
    return { net, auth, token: await auth.token(USER_A), env: makeEnv() };
  }
  const record = async (s: Awaited<ReturnType<typeof setup>>) => call(s.env, appRequest("POST", "/settings/me/greeting/record", s.token, {}));

  it("rings the person's own app from the business number, purpose=greeting, answered by /voice/greeting", async () => {
    const s = await setup();
    const before = Date.now();
    const { res, json } = await record(s);
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, ringing: true });
    const placed = s.net.to(TWILIO_CALLS);
    expect(placed).toHaveLength(1);
    const f = new URLSearchParams(placed[0].body);
    expect(f.get("To")).toBe(`client:u_${USER_A.replace(/-/g, "")}_g3?purpose=greeting`);
    expect(f.get("From")).toBe(BUSINESS_NUMBER);
    expect(f.get("Timeout")).toBe("25");
    expect(f.get("Method")).toBe("POST");
    const answer = new URL(f.get("Url")!);
    expect(answer.origin + answer.pathname).toBe(`${BASE}/voice/greeting`);
    expect(answer.searchParams.get("user")).toBe(USER_A);
    expect(answer.searchParams.get("stage")).toBe("ask");
    expect(answer.searchParams.get("key")).toBe(WEBHOOK_KEY);
    const t = Number(answer.searchParams.get("t"));
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(Date.now());
    expect(f.get("StatusCallback")).toBe(`${BASE}/voice/greeting?stage=status&key=${WEBHOOK_KEY}`);
    expect(f.getAll("StatusCallbackEvent")).toEqual(["completed"]);
    // Not a call: no phone_calls row, so nothing lists it or bills it.
    expect(s.net.writes("phone_calls")).toEqual([]);
  });

  it("refuses without a business number (no_number), and while calling is switched off", async () => {
    const none = await setup(callerCtx({ number: null }));
    const a = await record(none);
    expect(a.res.status).toBe(409);
    expect(a.json.error.code).toBe("no_number");
    expect(none.net.to(TWILIO_CALLS)).toEqual([]);

    const off = await setup(callerCtx({ phone_status: "off" }));
    const b = await record(off);
    expect(b.res.status).toBe(403);
    expect(b.json.error.code).toBe("phone_off");
    expect(off.net.to(TWILIO_CALLS)).toEqual([]);
  });

  it("someone without phone access is refused", async () => {
    const s = await setup(callerCtx({ phone_level: "none" }));
    const { res, json } = await record(s);
    expect(res.status).toBe(403);
    expect(json.error.code).toBe("no_phone_access");
  });

  it("one ring per person per half minute: a second press is refused (429) and rings nothing", async () => {
    const s = await setup();
    expect((await record(s)).res.status).toBe(200);
    const again = await record(s);
    expect(again.res.status).toBe(429);
    expect(again.json.error).toEqual({ code: "bad_request", message: "Your phone is already ringing for your greeting. Try again in half a minute." });
    expect(s.net.to(TWILIO_CALLS)).toHaveLength(1);
  });

  it("a ring Twilio refused rings nothing: says so (ring_failed), logs it, and the next press is allowed", async () => {
    const s = await setup(callerCtx(), 400);
    const { res, json } = await record(s);
    expect(res.status).toBe(502);
    expect(json.error).toEqual({ code: "ring_failed", message: "Couldn't ring your phone. Please try again." });
    expect(s.net.writes("app_errors").map((w) => w.json.code)).toContain("greeting_ring_failed");
    s.net.on("POST", TWILIO_CALLS, () => jsonRes({ sid: "CA" + "0".repeat(31) + "8" }, 201));
    expect((await record(s)).res.status).toBe(200);
  });
});

// ── /voice/greeting ─────────────────────────────────────────────────────────────────

describe("/voice/greeting", () => {
  const RING_AT = Date.parse("2026-10-05T15:00:00Z");

  function setup(opts: { row?: Record<string, unknown> | null; ctx?: Record<string, unknown> | null; casWins?: boolean } = {}) {
    const net = new FakeNet().install();
    let row: Record<string, unknown> | null = opts.row === undefined ? { greeting_recording_sid: OLD, greeting_updated_at: "2026-09-01T12:00:00Z" } : opts.row;
    net.rpc("phone_caller_context", () => (opts.ctx === undefined ? callerCtx() : opts.ctx));
    net.rest("GET", "phone_user_settings", () => (row ? [row] : []));
    net.rest("PATCH", "phone_user_settings", (s) => {
      if (opts.casWins === false) return [];
      row = { ...row, ...s.json };
      return [{ user_id: USER_A }];
    });
    net.rest("POST", "phone_user_settings", (s) => {
      row = { ...s.json };
      return [];
    });
    net.on("DELETE", /\/Recordings\/RE[0-9a-f]{32}\.json$/, () => new Response(null, { status: 204 }));
    net.rest("POST", "app_errors", () => []);
    return { net, row: () => row };
  }

  async function hit(query: Record<string, string>, params: Record<string, string> = {}) {
    const env = makeEnv();
    return call(env, await twilioPost(env, "/voice/greeting", { CallSid: "CA" + "0".repeat(31) + "9", AccountSid: "AC" + "0".repeat(32), ...params }, query));
  }
  const saved = (params: Record<string, string>, extra: Record<string, string> = {}) =>
    hit({ user: USER_A, t: String(RING_AT), stage: "saved", ...extra }, { RecordingSid: NEW, RecordingDuration: "7", ...params });

  it("ask: says what to do, then records up to 60 s (# to finish, a beep, silence trimmed), saving through stage=saved", async () => {
    setup();
    const { res, text } = await hit({ user: USER_A, t: String(RING_AT), stage: "ask" });
    expect(res.headers.get("content-type")).toContain("text/xml");
    expect(text).toContain(`<Say language="en-US">${GREETING_SAY.ask.replace(/'/g, "'")}</Say>`);
    expect(GREETING_SAY.ask).toBe("After the tone, say the greeting your callers will hear. Press pound when you're done.");
    expect(attr(text, "Record", "maxLength")).toBe("60");
    expect(attr(text, "Record", "finishOnKey")).toBe("#");
    expect(attr(text, "Record", "playBeep")).toBe("true");
    expect(attr(text, "Record", "trim")).toBe("trim-silence");
    expect(attr(text, "Record", "action")).toBe(`${BASE}/voice/greeting?user=${USER_A}&t=${RING_AT}&stage=saved&key=${WEBHOOK_KEY}`);
    expect(attr(text, "Record", "recordingStatusCallback")).toBe(`${BASE}/voice/greeting?user=${USER_A}&t=${RING_AT}&stage=saved&cb=status&key=${WEBHOOK_KEY}`);
    expect(attr(text, "Record", "transcribe")).toBeNull();
    // Silence skips the action: the next verbs say so and hang up.
    expect(text).toMatch(/<Record [^>]*\/><Say language="en-US">We didn't hear a greeting\. Please try again\.<\/Say><Hangup\/><\/Response>$/);
  });

  it("saved: stores the new sid over the old one (compare-and-swap), deletes the old one at Twilio, and says so", async () => {
    const { net, row } = setup();
    const { text } = await saved({});
    expect(text).toBe(`<?xml version="1.0" encoding="UTF-8"?><Response><Say language="en-US">Your greeting is saved. Goodbye.</Say><Hangup/></Response>`);
    const patch = net.writes("phone_user_settings", "PATCH")[0];
    expect(patch.json).toMatchObject({ greeting_recording_sid: NEW });
    expect(Date.parse(patch.json.greeting_updated_at)).toBeGreaterThan(0);
    expect(filter(patch, "user_id")).toBe(USER_A);
    expect(filter(patch, "greeting_recording_sid")).toBe(OLD);
    expect(row()!.greeting_recording_sid).toBe(NEW);
    expect(recordingDeletes(net)).toEqual([OLD]);
  });

  it("a first greeting (no settings row yet) is inserted with the person's business", async () => {
    const { net } = setup({ row: null });
    const { text } = await saved({});
    expect(text).toContain("Your greeting is saved.");
    expect(net.writes("phone_user_settings", "POST")[0].json).toMatchObject({ user_id: USER_A, client_id: CLIENT, greeting_recording_sid: NEW });
    expect(recordingDeletes(net)).toEqual([]);
  });

  it("a row with no greeting yet is swapped from NULL, and nothing is deleted", async () => {
    const { net } = setup({ row: { greeting_recording_sid: null, greeting_updated_at: null } });
    await saved({});
    const patch = net.writes("phone_user_settings", "PATCH")[0];
    expect(patch.url.searchParams.get("greeting_recording_sid")).toBe("is.null");
    expect(recordingDeletes(net)).toEqual([]);
  });

  it("the second of the action and the status callback finds the sid stored and changes nothing", async () => {
    const { net } = setup({ row: { greeting_recording_sid: NEW, greeting_updated_at: new Date().toISOString() } });
    const { res } = await saved({ RecordingStatus: "completed" }, { cb: "status" });
    expect(res.status).toBe(204);
    expect(net.writes("phone_user_settings")).toEqual([]);
    expect(recordingDeletes(net)).toEqual([]);
  });

  it("the status callback alone saves it too (the person hung up instead of pressing #), answering 204", async () => {
    const { net, row } = setup();
    const { res, text } = await saved({ RecordingStatus: "completed" }, { cb: "status" });
    expect(res.status).toBe(204);
    expect(text).toBe("");
    expect(row()!.greeting_recording_sid).toBe(NEW);
    expect(recordingDeletes(net)).toEqual([OLD]);
  });

  it("a status callback that isn't `completed` changes nothing", async () => {
    const { net } = setup();
    const { res } = await saved({ RecordingStatus: "absent" }, { cb: "status" });
    expect(res.status).toBe(204);
    expect(net.writes("phone_user_settings")).toEqual([]);
  });

  it("too short (under 2 s): nothing stored, the recording deleted at Twilio, and the person told", async () => {
    const { net } = setup();
    const { text } = await saved({ RecordingDuration: "1" });
    expect(text).toContain(`<Say language="en-US">That was too short. Please try again.</Say><Hangup/>`);
    expect(net.writes("phone_user_settings")).toEqual([]);
    expect(recordingDeletes(net)).toEqual([NEW]);
  });

  it("a greeting saved after this ring began is newer: it is kept, and this recording dropped", async () => {
    const { net } = setup({ row: { greeting_recording_sid: OLD, greeting_updated_at: new Date(RING_AT + 60_000).toISOString() } });
    const { text } = await saved({});
    expect(text).toContain(GREETING_SAY.newer);
    expect(net.writes("phone_user_settings")).toEqual([]);
    expect(recordingDeletes(net)).toEqual([NEW]);
  });

  it("a greeting cleared after this ring began stays cleared: a late callback doesn't bring it back", async () => {
    const { net } = setup({ row: { greeting_recording_sid: null, greeting_updated_at: new Date(RING_AT + 90_000).toISOString() } });
    const { res } = await saved({ RecordingStatus: "completed" }, { cb: "status" });
    expect(res.status).toBe(204);
    expect(net.writes("phone_user_settings")).toEqual([]);
    expect(recordingDeletes(net)).toEqual([NEW]);
  });

  it("someone who lost phone access gets nothing stored, and their recording is deleted", async () => {
    const { net } = setup({ ctx: callerCtx({ phone_level: "none" }) });
    const { text } = await saved({});
    expect(text).toContain(GREETING_SAY.failed);
    expect(net.writes("phone_user_settings")).toEqual([]);
    expect(recordingDeletes(net)).toEqual([NEW]);
  });

  it("a swap that keeps losing (the row changing under it) is not a save: logged with the sid, said, and the recording KEPT", async () => {
    const { net } = setup({ casWins: false });
    const { text } = await saved({});
    expect(text).toContain(GREETING_SAY.failed);
    expect(net.writes("phone_user_settings", "PATCH")).toHaveLength(3);
    const log = net.writes("app_errors").find((w) => w.json.code === "greeting_save_failed");
    expect(log?.json.context).toMatchObject({ userId: USER_A, recording: NEW });
    // Never deleted on a failure: the other callback for this same recording may have stored it.
    expect(recordingDeletes(net)).toEqual([]);
  });

  it("the action saves it, then the status callback fails: the saved greeting is never deleted", async () => {
    const { net, row } = setup();
    expect((await saved({})).text).toContain(GREETING_SAY.saved);
    expect(row()!.greeting_recording_sid).toBe(NEW);
    net.rpc("phone_caller_context", () => jsonRes({ message: "upstream unavailable" }, 503));
    const { res } = await saved({ RecordingStatus: "completed" }, { cb: "status" });
    expect(res.status).toBe(204);
    expect(net.writes("app_errors").map((w) => w.json.code)).toContain("greeting_save_failed");
    expect(row()!.greeting_recording_sid).toBe(NEW);
    expect(recordingDeletes(net)).toEqual([OLD]);
  });

  it("a sid that isn't a recording sid, a missing user or ring time: nothing stored", async () => {
    const { net } = setup();
    expect((await saved({ RecordingSid: "RE123" })).text).toContain(GREETING_SAY.failed);
    expect((await hit({ t: String(RING_AT), stage: "saved" }, { RecordingSid: NEW, RecordingDuration: "7" })).text).toContain(GREETING_SAY.failed);
    expect((await hit({ user: USER_A, stage: "saved" }, { RecordingSid: NEW, RecordingDuration: "7" })).text).toContain(GREETING_SAY.failed);
    expect(net.writes("phone_user_settings")).toEqual([]);
  });

  it("stage=status (the ring's own callback) answers 204 and touches nothing", async () => {
    const { net } = setup();
    const { res } = await hit({ stage: "status" }, { CallStatus: "completed" });
    expect(res.status).toBe(204);
    expect(net.seen.filter((s) => !s.url.pathname.includes("app_errors"))).toEqual([]);
  });

  it("is a Twilio path like the others: a wrong key is refused before anything is read", async () => {
    const { net } = setup();
    const env = makeEnv();
    const { res } = await call(env, await twilioPost(env, "/voice/greeting", { RecordingSid: NEW, RecordingDuration: "7" }, { user: USER_A, t: String(RING_AT), stage: "saved" }, { key: "wrong" }));
    expect(res.status).toBe(403);
    expect(net.writes("phone_user_settings")).toEqual([]);
  });

  it("saveGreeting never throws: a database fault is 'failed'", async () => {
    const net = new FakeNet().install();
    net.rpc("phone_caller_context", () => callerCtx());
    net.rest("GET", "phone_user_settings", () => jsonRes({ message: "boom" }, 500));
    net.rest("POST", "app_errors", () => []);
    const env = makeEnv();
    const ctx = new FakeCtx();
    expect(await saveGreeting(env, ctx as never, adminClient(env), USER_A, NEW, RING_AT)).toBe("failed");
  });
});

// ── GET /voice/greeting-audio ───────────────────────────────────────────────────────

describe("GET /voice/greeting-audio", () => {
  function setup(stored: string | null = NEW, mediaStatus = 200) {
    const net = new FakeNet().install();
    net.rest("GET", "phone_user_settings", () => [{ greeting_recording_sid: stored }]);
    net.on("GET", /\/Recordings\/RE[0-9a-f]{32}\.mp3$/, () => new Response(mediaStatus === 200 ? "ID3-mp3-bytes" : null, {
      status: mediaStatus, headers: { "content-length": "13" },
    }));
    net.rest("POST", "app_errors", () => []);
    return net;
  }
  const get = (q: Record<string, string>, init: RequestInit = {}, env = makeEnv()) =>
    call(env, new Request(`${BASE}/voice/greeting-audio?${new URLSearchParams(q)}`, init));

  it("is the URL voicemail plays: our own path, the person and the sid as its version, and the key", () => {
    expect(greetingAudioUrl(makeEnv(), USER_A, NEW)).toBe(`${BASE}/voice/greeting-audio?u=${USER_A}&v=${NEW}&key=${WEBHOOK_KEY}`);
  });

  it("streams the stored recording from Twilio as audio/mpeg, Range passed through", async () => {
    const net = setup();
    const { res, text } = await get({ u: USER_A, v: NEW, key: WEBHOOK_KEY }, { headers: { range: "bytes=0-" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(res.headers.get("content-length")).toBe("13");
    expect(text).toBe("ID3-mp3-bytes");
    const fetched = net.to(/\/Recordings\/RE[0-9a-f]{32}\.mp3$/)[0];
    expect(fetched.url.pathname).toMatch(new RegExp(`/Recordings/${NEW}\\.mp3$`));
    expect(fetched.headers.get("range")).toBe("bytes=0-");
    expect(filter(net.reads("phone_user_settings")[0], "user_id")).toBe(USER_A);
  });

  it("HEAD answers the headers only", async () => {
    setup();
    const { res, text } = await get({ u: USER_A, v: NEW, key: WEBHOOK_KEY }, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(text).toBe("");
  });

  it("a wrong or missing key is 403, before anything is read", async () => {
    const net = setup();
    expect((await get({ u: USER_A, v: NEW, key: "wrong" })).res.status).toBe(403);
    expect((await get({ u: USER_A, v: NEW })).res.status).toBe(403);
    expect(net.reads("phone_user_settings")).toEqual([]);
    expect(net.to(/\.mp3$/)).toEqual([]);
  });

  it("no webhook secret at all is 503", async () => {
    setup();
    expect((await get({ u: USER_A, v: NEW, key: "" }, {}, makeEnv({ PHONE_WEBHOOK_SECRET: "" }))).res.status).toBe(503);
  });

  it("only the sid stored for that person plays: a replaced, cleared or guessed one is 404, and Twilio isn't asked", async () => {
    for (const stored of [OLD, null]) {
      const net = setup(stored);
      expect((await get({ u: USER_A, v: NEW, key: WEBHOOK_KEY })).res.status).toBe(404);
      expect(net.to(/\.mp3$/)).toEqual([]);
    }
    const net = setup();
    expect((await get({ u: "not-a-user", v: NEW, key: WEBHOOK_KEY })).res.status).toBe(404);
    expect((await get({ u: USER_A, v: "RE" + "Z".repeat(32), key: WEBHOOK_KEY })).res.status).toBe(404);
    expect(net.reads("phone_user_settings")).toEqual([]);
  });

  it("Twilio without the recording is 404; Twilio failing is 502 (the <Play> is skipped, the beep still comes)", async () => {
    setup(NEW, 404);
    expect((await get({ u: USER_A, v: NEW, key: WEBHOOK_KEY })).res.status).toBe(404);
    setup(NEW, 500);
    expect((await get({ u: USER_A, v: NEW, key: WEBHOOK_KEY })).res.status).toBe(502);
  });

  it("only GET and HEAD", async () => {
    setup();
    expect((await get({ u: USER_A, v: NEW, key: WEBHOOK_KEY }, { method: "POST" })).res.status).toBe(405);
  });
});

// ── GET /settings/me/greeting/audio and POST /settings/me/greeting/clear ────────────

describe("your own greeting: Play and Use the standard greeting", () => {
  async function setup(row: Record<string, unknown> | null, opts: { casWins?: boolean; deleteStatus?: number } = {}) {
    const net = new FakeNet().install();
    const auth = await new Auth().init();
    auth.serve(net);
    let current = row;
    net.rpc("phone_caller_context", () => callerCtx({ phone_status: "off" }));
    net.rest("GET", "phone_user_settings", () => (current ? [current] : []));
    net.rest("PATCH", "phone_user_settings", (s) => {
      if (opts.casWins === false) return [];
      current = { ...current, ...s.json };
      return [current];
    });
    net.on("GET", /\/Recordings\/RE[0-9a-f]{32}\.mp3$/, () => new Response("ID3", { status: 200 }));
    net.on("DELETE", /\/Recordings\/RE[0-9a-f]{32}\.json$/, () => new Response(null, { status: opts.deleteStatus ?? 204 }));
    net.rest("POST", "app_errors", () => []);
    return { net, token: await auth.token(USER_A), env: makeEnv() };
  }
  const mine = { dnd: false, dnd_until: null, forward_to_cell: null, greeting_recording_sid: OLD, greeting_updated_at: "2026-10-05T15:01:00Z" };

  it("Play streams your own recording with the header login only, even while calling is off", async () => {
    const s = await setup(mine);
    const { res, text } = await call(s.env, appRequest("GET", "/settings/me/greeting/audio", s.token));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(text).toBe("ID3");
    expect(s.net.to(/\.mp3$/)[0].url.pathname).toContain(`/Recordings/${OLD}.mp3`);
    expect(filter(s.net.reads("phone_user_settings")[0], "user_id")).toBe(USER_A);
    // ?access_token= is never taken here.
    const q = await call(s.env, new Request(`${BASE}/settings/me/greeting/audio?access_token=${s.token}`));
    expect(q.res.status).toBe(401);
  });

  it("Play with no greeting is 404 with a sentence", async () => {
    const s = await setup({ ...mine, greeting_recording_sid: null, greeting_updated_at: null });
    const { res, json } = await call(s.env, appRequest("GET", "/settings/me/greeting/audio", s.token));
    expect(res.status).toBe(404);
    expect(json.error).toEqual({ code: "not_found", message: "You haven't recorded a greeting." });
  });

  it("Use the standard greeting forgets the recording (only that one), deletes it at Twilio, and answers your settings", async () => {
    const s = await setup(mine);
    const { res, json } = await call(s.env, appRequest("POST", "/settings/me/greeting/clear", s.token, {}));
    expect(res.status).toBe(200);
    expect(json.settings.greeting).toEqual({ set: false, updated_at: null });
    const patch = s.net.writes("phone_user_settings", "PATCH")[0];
    expect(patch.json).toMatchObject({ greeting_recording_sid: null });
    // Stamped with the clear (so a late recording callback can't bring it back), never shown as a time.
    expect(Date.parse(patch.json.greeting_updated_at)).toBeGreaterThan(Date.now() - 60_000);
    expect(filter(patch, "user_id")).toBe(USER_A);
    expect(filter(patch, "greeting_recording_sid")).toBe(OLD);
    expect(recordingDeletes(s.net)).toEqual([OLD]);
  });

  it("nothing to clear is not an error, and deletes nothing", async () => {
    const s = await setup(null);
    const { res, json } = await call(s.env, appRequest("POST", "/settings/me/greeting/clear", s.token, {}));
    expect(res.status).toBe(200);
    expect(json.settings.greeting).toEqual({ set: false, updated_at: null });
    expect(s.net.writes("phone_user_settings")).toEqual([]);
    expect(recordingDeletes(s.net)).toEqual([]);
  });

  it("a new recording landing meanwhile is left alone", async () => {
    const s = await setup(mine, { casWins: false });
    const { json } = await call(s.env, appRequest("POST", "/settings/me/greeting/clear", s.token, {}));
    expect(json.settings.greeting).toEqual({ set: true, updated_at: "2026-10-05T15:01:00Z" });
    expect(recordingDeletes(s.net)).toEqual([]);
  });

  it("a delete Twilio refuses is logged with the sid (to delete by hand); the greeting is still cleared", async () => {
    const s = await setup(mine, { deleteStatus: 500 });
    const { json } = await call(s.env, appRequest("POST", "/settings/me/greeting/clear", s.token, {}));
    expect(json.settings.greeting.set).toBe(false);
    const logged = s.net.writes("app_errors").map((w) => w.json).find((r) => r.code === "greeting_delete_failed");
    expect(logged).toMatchObject({ severity: "warn", context: { recording: OLD } });
  });

  it("GET /settings/me says whether you have one and when it was recorded, never the sid", async () => {
    const s = await setup(mine);
    const { json, text } = await call(s.env, appRequest("GET", "/settings/me", s.token));
    expect(json.settings.greeting).toEqual({ set: true, updated_at: "2026-10-05T15:01:00Z" });
    expect(text).not.toContain(OLD);
    expect(s.net.reads("phone_user_settings")[0].url.searchParams.get("select")).toContain("greeting_recording_sid");
  });

  it("each endpoint acts on the signed-in person only: another person's row is never asked for", async () => {
    const s = await setup(mine);
    await call(s.env, appRequest("GET", "/settings/me/greeting/audio", s.token));
    await call(s.env, appRequest("POST", "/settings/me/greeting/clear", s.token, { user_id: USER_B }));
    expect(s.net.seen.filter((x) => x.url.pathname === "/rest/v1/phone_user_settings").every((x) => filter(x, "user_id") === USER_A)).toBe(true);
  });
});
