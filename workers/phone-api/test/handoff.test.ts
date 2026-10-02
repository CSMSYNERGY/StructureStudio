// Moving a live call to the person's other device (src/handoff.ts, src/routes/handoff.ts,
// migration 260): the four app endpoints, the two ways to answer (/voice/handoff for the phone,
// /voice/outbound's HandoffCall branch for the computer), make before break, and what the
// rest of the Worker does while a move is under way.
//
// The phone_calls row here is STATEFUL: every PATCH is applied only when its PostgREST filters
// match the row as it stands (eq / is / gt / lt / in / or), so the guards that make two answers,
// a stale ring or a lost race harmless are exercised, not assumed. Twilio's REST API is a stub
// that records what the Worker asked for, in order, beside the row writes. What only a live
// call can prove is in DEVIATIONS (items 57 to 60).
//
// ⚠️ PUBLIC REPO: every value is fake (555-01xx numbers, all-zero SIDs, demo-tenant).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { conferenceTwiml } from "../src/conference";
import { HANDOFF_POLL } from "../src/handoff";
import {
  Auth, BUSINESS_NUMBER, CALL_SID, CLIENT, CONTACT_1, CUSTOMER, FakeNet, NUMBER_ID, USER_A, USER_B,
  appRequest, call, callerCtx, jsonRes, makeEnv, routeInfo, twilioPost, type EventFixture, type Seen,
} from "./helpers";

const CALL_ID = "00000000-0000-4000-8000-0000000ca555";
const KEY = "00000000-0000-4000-8000-0000000000ee";
const OTHER_KEY = "00000000-0000-4000-8000-0000000000ef";
/** The leg holding the call now (the device the move starts on). */
const OLD = "CA" + "0".repeat(31) + "5";
/** The leg that answers on the other device (for the phone: the ring the Worker placed). */
const NEW = "CA" + "0".repeat(31) + "7";
const STRAY = "CA" + "0".repeat(31) + "9";
const CONF = "CF" + "0".repeat(31) + "1";
const ACCOUNT = "AC" + "0".repeat(32);
const HEX_A = USER_A.replace(/-/g, "");
const env = makeEnv();

type Row = Record<string, any>;

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function liveCall(over: Row = {}): Row {
  return {
    id: CALL_ID, client_id: CLIENT, number_id: NUMBER_ID, contact_id: null, direction: "in",
    from_e164: CUSTOMER, to_e164: BUSINESS_NUMBER, twilio_call_sid: CALL_SID, client_call_sid: OLD,
    placed_by: null, answered_by: USER_A, rang_user_ids: [USER_A], transferred_from: null, transfer_state: null,
    status: "in_progress", started_at: ago(120_000), answered_at: ago(100_000), ended_at: null,
    duration_s: null, error_code: null, is_emergency: false,
    handoff_state: null, handoff_to: null, handoff_key: null, handoff_at: null, handoff_sid: null, handoff_from_sid: null,
    ...over,
  };
}

const outboundCall = (over: Row = {}) => liveCall({
  direction: "out", from_e164: BUSINESS_NUMBER, to_e164: CUSTOMER, placed_by: USER_A, answered_by: null, ...over,
});

/** A move to `to` that started ringing `age` ms ago. */
const ringing = (to: "mobile" | "chrome" = "mobile", age = 5_000, over: Row = {}): Row => ({
  handoff_state: "ringing", handoff_to: to, handoff_key: KEY, handoff_at: ago(age),
  handoff_sid: to === "mobile" ? NEW : null, handoff_from_sid: OLD, ...over,
});

// ── PostgREST filters, evaluated against one row ────────────────────────────────────

function valueOf(row: Row, col: string): unknown {
  const [base, key] = col.split("->>");
  return key ? row[base]?.[key] : row[base];
}

function test1(row: Row, col: string, expr: string): boolean {
  const i = expr.indexOf(".");
  const op = expr.slice(0, i);
  const val = expr.slice(i + 1);
  const v = valueOf(row, col);
  switch (op) {
    case "eq":
      return v !== null && v !== undefined && String(v) === val;
    case "is":
      return val === "null" ? v === null || v === undefined : String(v) === val;
    case "gt":
    case "lt": {
      if (v === null || v === undefined) return false;
      const a = Date.parse(String(v));
      const b = Date.parse(val);
      const cmp = Number.isFinite(a) && Number.isFinite(b) ? a - b : String(v).localeCompare(val);
      return op === "gt" ? cmp > 0 : cmp < 0;
    }
    case "in":
      return val.replace(/^\(|\)$/g, "").split(",").map((x) => x.replace(/^"|"$/g, "")).includes(String(v));
    default:
      throw new Error(`test filter: unsupported ${op}`);
  }
}

function matches(row: Row, url: URL): boolean {
  for (const [k, v] of url.searchParams) {
    if (["select", "order", "limit", "offset"].includes(k)) continue;
    if (k === "or") {
      const parts = v.replace(/^\(|\)$/g, "").split(",");
      if (!parts.some((part) => {
        const j = part.indexOf(".");
        return test1(row, part.slice(0, j), part.slice(j + 1));
      })) return false;
      continue;
    }
    if (!test1(row, k, v)) return false;
  }
  return true;
}

// ── The fakes ───────────────────────────────────────────────────────────────────────

const NAMES: Record<string, string> = { [OLD]: "old", [NEW]: "new", [CALL_SID]: "customer", [STRAY]: "stray" };
const nameOf = (sid: string) => NAMES[sid] ?? sid;

/** What a phone_calls PATCH was for, for the order log. */
function label(b: Row): string {
  const keys = Object.keys(b);
  if (b.handoff_state === "ringing") return "offer";
  if (b.handoff_state === "connecting") return b.transfer_state === "conference" ? "claim+conference" : "claim";
  if ("client_call_sid" in b && "handoff_state" in b) return "swap";
  if (keys.length === 1 && "handoff_sid" in b) return "store-ring";
  if (keys.length === 1 && b.handoff_state === null) return "clear";
  if (keys.length === 1 && b.transfer_state === null) return "unclaim";
  return `patch:${keys.sort().join(",")}`;
}

class Calls {
  writes: { body: Row; query: string; won: boolean }[] = [];
  /** Make the next PATCH lose whatever its guard says (another writer got there first). */
  loseNext = false;
  /** Called after each PATCH that won, with its label (something happening on Twilio's side meanwhile). */
  onWrite?: (label: string) => void;
  constructor(public row: Row, private log: string[], private contact: Row | null = null) {}
  install(net: FakeNet): void {
    net.rest("GET", "phone_calls", (s) => (matches(this.row, s.url) ? [{ ...this.row, crm_contacts: this.contact }] : []));
    net.rest("PATCH", "phone_calls", (s) => {
      const won = !this.loseNext && matches(this.row, s.url);
      this.loseNext = false;
      this.writes.push({ body: s.json, query: decodeURIComponent(s.url.search), won });
      this.log.push(`${label(s.json)}${won ? "" : " (lost)"}`);
      if (!won) return [];
      Object.assign(this.row, s.json);
      this.onWrite?.(label(s.json));
      return [{ ...this.row }];
    });
  }
  won(): string[] {
    return this.writes.filter((w) => w.won).map((w) => label(w.body));
  }
}

class Events {
  rows: EventFixture[];
  private seq = 0;
  constructor(seed: EventFixture[] = []) {
    this.rows = [...seed];
  }
  install(net: FakeNet): void {
    net.rest("POST", "phone_call_events", (s) => {
      // Later writes are later, to the millisecond, as clock_timestamp() makes them.
      this.rows.push({ call_id: s.json.call_id, type: s.json.type, at: s.json.at ?? new Date(Date.now() + this.seq++).toISOString(), data: s.json.data });
      return [];
    });
    net.rest("GET", "phone_call_events", (s) => this.rows.filter((r) => matches(r as unknown as Row, s.url)));
  }
  switches(): Record<string, unknown>[] {
    return this.rows.filter((r) => r.type === "device_switch").map((r) => r.data ?? {});
  }
  phases(): unknown[] {
    return this.switches().map((d) => d.phase);
  }
}

type Participant = { call_sid: string; hold: boolean; muted: boolean; status: string; start_conference_on_enter?: boolean };
const inRoom = (sid: string, o: Partial<Participant> = {}): Participant => ({ call_sid: sid, hold: false, muted: false, status: "connected", start_conference_on_enter: false, ...o });

interface Tw {
  conference: boolean;
  parts: Participant[];
  status: Record<string, string>;
  /** HTTP status the ring (POST /Calls.json) answers with. */
  createStatus?: number;
  /** Twilio refuses a Twiml redirect (21220). */
  refuseMove?: boolean;
  /** What a redirect does to the conference (a leg moving in, the parent following). */
  onRedirect?: (sid: string, tw: Tw) => void;
  /** Called before each participant list is answered, with its count (1, 2, ...). */
  onList?: (tw: Tw, n: number) => void;
}

function stubTwilio(net: FakeNet, log: string[], t: Partial<Tw> = {}): Tw {
  const tw: Tw = { conference: false, parts: [], status: {}, ...t };
  let lists = 0;
  const api = /^https:\/\/api\.twilio\.com\/2010-04-01\/Accounts\/AC0+/;
  const sidOf = (s: Seen) => s.url.pathname.split("/").pop()!.replace(".json", "");
  net.on("POST", (u) => api.test(u.href) && u.pathname.endsWith("/Calls.json"), () => {
    log.push("ring");
    return tw.createStatus ? jsonRes({ code: 21217 }, tw.createStatus) : jsonRes({ sid: NEW, status: "queued" }, 201);
  });
  net.on("POST", (u) => api.test(u.href) && /\/Calls\/CA[0-9a-f]+\.json$/.test(u.pathname), (s) => {
    const sid = sidOf(s);
    const form = new URLSearchParams(s.body);
    if (form.has("Twiml")) {
      if (tw.refuseMove) {
        log.push(`redirect:${nameOf(sid)} (refused)`);
        return jsonRes({ code: 21220 }, 400);
      }
      log.push(`redirect:${nameOf(sid)}`);
      tw.onRedirect?.(sid, tw);
      return jsonRes({ sid });
    }
    const status = form.get("Status") ?? "";
    log.push(`${status === "canceled" ? "cancel" : "end"}:${nameOf(sid)}`);
    tw.status[sid] = status === "canceled" ? "canceled" : "completed";
    for (const p of tw.parts) if (p.call_sid === sid) p.status = "complete";
    return jsonRes({ sid });
  });
  net.on("GET", (u) => api.test(u.href) && /\/Calls\/CA[0-9a-f]+\.json$/.test(u.pathname), (s) =>
    jsonRes({ sid: sidOf(s), status: tw.status[sidOf(s)] ?? "in-progress", to: "" }));
  net.on("GET", (u) => api.test(u.href) && u.pathname.endsWith("/Conferences.json"), () =>
    jsonRes({ conferences: tw.conference ? [{ sid: CONF, friendly_name: CALL_ID, status: "in-progress" }] : [] }));
  net.on("GET", (u) => api.test(u.href) && /\/Conferences\/CF[0-9a-f]+\/Participants\.json$/.test(u.pathname), () => {
    tw.onList?.(tw, ++lists);
    return jsonRes({ participants: tw.parts });
  });
  net.on("POST", (u) => api.test(u.href) && /\/Participants\/CA[0-9a-f]+\.json$/.test(u.pathname), (s) => {
    log.push(`participant:${nameOf(sidOf(s))}`);
    return jsonRes({});
  });
  return tw;
}

interface Opts {
  row?: Row;
  devices?: Row[];
  route?: unknown;
  contact?: Row | null;
  events?: EventFixture[];
  tw?: Partial<Tw>;
}

async function setup(o: Opts = {}) {
  const net = new FakeNet().install();
  const auth = await new Auth().init();
  auth.serve(net);
  const log: string[] = [];
  const calls = new Calls(o.row ?? liveCall(), log, o.contact ?? null);
  calls.install(net);
  const events = new Events(o.events);
  events.install(net);
  net.rpc("phone_caller_context", () => callerCtx());
  net.rpc("phone_route_for_number", () => o.route ?? routeInfo());
  net.rest("GET", "phone_devices", () => o.devices ?? [
    { platform: "android", build_type: "prod", push_token: "fake-push-token" },
    { platform: "chrome", build_type: "prod", push_token: null },
  ]);
  net.rest("GET", "phone_user_settings", () => []);
  net.rest("POST", "phone_calls", () => []);
  net.rest("POST", "app_errors", () => []);
  const tw = stubTwilio(net, log, o.tw);
  return { net, auth, token: await auth.token(USER_A), calls, events, tw, log };
}

const twilioWrites = (net: FakeNet) => net.to(/api\.twilio\.com/).filter((s) => s.method === "POST");
const faults = (net: FakeNet) => net.writes("app_errors").map((s) => s.json.code);

const startMove = (token: string, body: Row, id = CALL_ID, headers: Record<string, string> = {}) =>
  call(env, appRequest("POST", `/calls/${id}/handoff`, token, body, headers));

/** The phone answering the ring (the REST call's answer URL). */
const phoneAnswers = async (key = KEY, sid = NEW) => call(env, await twilioPost(env, "/voice/handoff", {
  CallSid: sid, AccountSid: ACCOUNT, From: BUSINESS_NUMBER, To: `client:u_${HEX_A}_g1`, Direction: "outbound-api", CallStatus: "in-progress",
}, { call: CALL_ID, k: key }));

/** The computer answering: device.connect({To:'handoff', HandoffCall, HandoffKey}). */
const computerAnswers = async (params: Record<string, string> = {}) => call(env, await twilioPost(env, "/voice/outbound", {
  CallSid: NEW, AccountSid: ACCOUNT, From: `client:u_${HEX_A}_g1`, To: "handoff", Direction: "inbound",
  HandoffCall: CALL_ID, HandoffKey: KEY, ...params,
}));

const statusOf = async (params: Record<string, string>, query: Record<string, string>) =>
  call(env, await twilioPost(env, "/voice/status", { AccountSid: ACCOUNT, ...params }, query));

let savedPoll = { ...HANDOFF_POLL };
beforeEach(() => {
  savedPoll = { ...HANDOFF_POLL };
  // Real waits are 250 ms up to 8 s; the tests need the shape, not the seconds.
  HANDOFF_POLL.everyMs = 2;
  HANDOFF_POLL.limitMs = 30;
});
afterEach(() => {
  Object.assign(HANDOFF_POLL, savedPoll);
});

// ── POST /calls/:id/handoff ─────────────────────────────────────────────────────────

describe("POST /calls/:id/handoff", () => {
  it("to the phone: claims the move from the holding leg, records it, then rings the person's own identity with the call's details", async () => {
    const { net, token, calls, events, log } = await setup({ row: liveCall({ contact_id: CONTACT_1 }) });
    const { res, json } = await startMove(token, { to: "mobile", leg_sid: OLD });
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, state: "ringing", to: "mobile", call_id: CALL_ID });
    expect(json.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(log).toEqual(["offer", "ring", "store-ring"]);

    const claim = calls.writes[0];
    expect(claim.body).toMatchObject({ handoff_state: "ringing", handoff_to: "mobile", handoff_key: json.key, handoff_sid: null, handoff_from_sid: OLD });
    // One at a time, only from the leg holding the call, only on a live call; a stale move may be replaced.
    expect(claim.query).toContain(`client_call_sid=eq.${OLD}`);
    expect(claim.query).toContain("status=eq.in_progress");
    expect(claim.query).toContain("ended_at=is.null");
    expect(claim.query).toMatch(/or=\(handoff_state\.is\.null,handoff_at\.lt\.[0-9T:.\-]+Z\)/);
    expect(calls.row.handoff_sid).toBe(NEW);

    const ring = net.to(/\/Calls\.json$/)[0];
    const form = new URLSearchParams(ring.body);
    const to = form.get("To")!;
    expect(to.startsWith(`client:u_${HEX_A}_g1?`)).toBe(true);
    expect(Object.fromEntries(new URLSearchParams(to.split("?")[1]))).toEqual({
      handoff: "1", call_id: CALL_ID, key: json.key, customer: CUSTOMER, contact_id: CONTACT_1,
      direction: "in", answered_at: calls.row.answered_at, held: "0",
    });
    expect(to).toContain("customer=%2B1555"); // URL-encoded on the address, decoded by the SDK
    expect(form.get("From")).toBe(BUSINESS_NUMBER);
    expect(form.get("Url")).toBe(`https://phone.example.test/voice/handoff?call=${CALL_ID}&k=${json.key}&key=test-webhook-key`);
    expect(form.get("Method")).toBe("POST");
    expect(form.get("Timeout")).toBe("25");
    expect(form.get("StatusCallback")).toBe(`https://phone.example.test/voice/status?call=${CALL_ID}&leg=handoff&key=test-webhook-key`);
    expect(form.getAll("StatusCallbackEvent")).toEqual(["initiated", "ringing", "answered", "completed"]);

    // The key is a capability: never in an event.
    expect(events.switches()).toEqual([{ phase: "offered", to: "mobile", held: false, user: USER_A }]);
    expect(JSON.stringify(events.rows)).not.toContain(json.key);
  });

  it("an outbound call is found by its app leg's CallSid (all an outbound app knows)", async () => {
    const { token, calls } = await setup({ row: outboundCall() });
    const { res, json } = await startMove(token, { to: "mobile", leg_sid: OLD }, OLD);
    expect(res.status).toBe(200);
    expect(json.call_id).toBe(CALL_ID);
    expect(calls.row.handoff_state).toBe("ringing");
  });

  it("to the computer: the claim alone is the signal (it broadcasts); Twilio rings nothing", async () => {
    const { net, token, calls, events } = await setup();
    const { res, json } = await startMove(token, { to: "chrome", leg_sid: OLD });
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ state: "ringing", to: "chrome" });
    expect(calls.row).toMatchObject({ handoff_state: "ringing", handoff_to: "chrome", handoff_key: json.key, handoff_sid: null });
    expect(twilioWrites(net)).toEqual([]);
    expect(events.phases()).toEqual(["offered"]);
  });

  it("a call on hold: the ring says so (held=1), so the phone shows it held", async () => {
    const { net, token } = await setup({
      row: liveCall({ transfer_state: "conference" }),
      tw: { conference: true, parts: [inRoom(CALL_SID), inRoom(OLD)] }, // a plain Hold: nothing proves it started
    });
    const { json } = await startMove(token, { to: "mobile", leg_sid: OLD });
    const to = new URLSearchParams(net.to(/\/Calls\.json$/)[0].body).get("To")!;
    expect(new URLSearchParams(to.split("?")[1]).get("held")).toBe("1");
    expect(json.state).toBe("ringing");
  });

  it("an iPhone development build is rung on its _dev identity when it is the only phone", async () => {
    const { net, token } = await setup({ devices: [{ platform: "ios", build_type: "dev", push_token: "fake-apns" }] });
    await startMove(token, { to: "mobile", leg_sid: OLD });
    expect(new URLSearchParams(net.to(/\/Calls\.json$/)[0].body).get("To")).toMatch(new RegExp(`^client:u_${HEX_A}_g1_dev\\?`));
  });

  it("Twilio refusing the ring releases the claim: nothing changed, and the app says so (ring_failed)", async () => {
    const { net, token, calls, events, log } = await setup({ tw: { createStatus: 400 } });
    const { res, json } = await startMove(token, { to: "mobile", leg_sid: OLD });
    expect(res.status).toBe(502);
    expect(json.error).toEqual({ code: "ring_failed", message: "Couldn't ring your phone. You're still on the call." });
    expect(log).toEqual(["offer", "ring", "clear"]);
    expect(calls.row.handoff_state).toBeNull();
    expect(calls.row.transfer_state).toBeNull();
    expect(calls.row.client_call_sid).toBe(OLD);
    expect(events.phases()).toEqual(["offered", "failed"]);
    expect(events.switches()[1]).toMatchObject({ reason: "ring_failed" });
    expect(faults(net)).toContain("handoff_ring_failed");
  });

  it("a ring missed or canceled before Twilio's answer reached us is stopped at once", async () => {
    const { net, token, calls, log } = await setup();
    // The cancel lands between the ring and the store.
    net.on("POST", (u) => u.pathname.endsWith("/Calls.json"), () => {
      log.push("ring");
      calls.row.handoff_state = null;
      return jsonRes({ sid: NEW }, 201);
    });
    await startMove(token, { to: "mobile", leg_sid: OLD });
    expect(log).toEqual(["offer", "ring", "store-ring (lost)", "cancel:new"]);
  });

  it.each([
    ["someone else's call", { row: liveCall({ answered_by: USER_B }) }, { to: "mobile", leg_sid: OLD }, 403, "not_your_call"],
    ["a leg that is not the one holding the call", {}, { to: "mobile", leg_sid: STRAY }, 403, "not_your_call"],
    ["a warm transferrer still consulting (the teammate holds it now)", { row: liveCall({ answered_by: USER_B, transferred_from: USER_A, transfer_state: "conference" }) }, { to: "mobile", leg_sid: OLD }, 403, "not_your_call"],
    ["a call that ended", { row: liveCall({ status: "completed", ended_at: ago(1000) }) }, { to: "mobile", leg_sid: OLD }, 409, "not_live"],
    ["a call still ringing", { row: liveCall({ status: "ringing" }) }, { to: "mobile", leg_sid: OLD }, 409, "not_live"],
    ["a 911 call", { row: outboundCall({ is_emergency: true, to_e164: "911" }) }, { to: "mobile", leg_sid: OLD }, 409, "emergency"],
    ["an inbound call within an hour of a 911 call from the number", { route: routeInfo({ recent_emergency_user: USER_A }) }, { to: "mobile", leg_sid: OLD }, 409, "emergency"],
    ["a cold transfer under way", { row: liveCall({ transfer_state: "transferring" }) }, { to: "mobile", leg_sid: OLD }, 409, "transfer_in_progress"],
    ["a warm transfer still ringing a teammate", {
      row: liveCall({ transfer_state: "conference" }),
      events: [{ call_id: CALL_ID, type: "warm_transfer", at: ago(3000), data: { from: USER_A, to: USER_B, sid: STRAY } }],
    }, { to: "mobile", leg_sid: OLD }, 409, "transfer_in_progress"],
    ["a move already ringing", { row: liveCall(ringing("chrome", 10_000)) }, { to: "mobile", leg_sid: OLD }, 409, "handoff_in_progress"],
    ["a move already connecting", { row: liveCall(ringing("mobile", 2_000, { handoff_state: "connecting" })) }, { to: "chrome", leg_sid: OLD }, 409, "handoff_in_progress"],
    ["no phone signed in", { devices: [{ platform: "chrome", build_type: "prod", push_token: null }] }, { to: "mobile", leg_sid: OLD }, 409, "no_target_device"],
    ["a phone that never registered for notifications", { devices: [{ platform: "android", build_type: "prod", push_token: null }] }, { to: "mobile", leg_sid: OLD }, 409, "no_target_device"],
    ["no computer signed in", { devices: [{ platform: "android", build_type: "prod", push_token: "fake-push-token" }] }, { to: "chrome", leg_sid: OLD }, 409, "no_target_device"],
    ["an unknown destination", {}, { to: "tablet", leg_sid: OLD }, 400, "bad_request"],
    ["no leg", {}, { to: "mobile" }, 400, "bad_request"],
  ] as [string, Opts, Row, number, string][])("refuses %s, and changes nothing", async (_l, o, body, status, code) => {
    const { net, token, calls } = await setup(o);
    const { res, json } = await startMove(token, body);
    expect(res.status).toBe(status);
    expect(json.error.code).toBe(code);
    expect(calls.writes).toEqual([]);
    expect(twilioWrites(net)).toEqual([]);
  });

  it("the no-device refusal names the device", async () => {
    const { token } = await setup({ devices: [] });
    expect((await startMove(token, { to: "mobile", leg_sid: OLD })).json.error.message).toBe("Your phone isn't signed in to My Synergy Phone.");
    expect((await startMove(token, { to: "chrome", leg_sid: OLD })).json.error.message).toBe("My Synergy Phone isn't signed in on your computer.");
  });

  it("a warm transfer the teammate missed does not block a move", async () => {
    const { token } = await setup({
      row: liveCall({ transfer_state: "conference" }),
      events: [
        { call_id: CALL_ID, type: "warm_transfer", at: ago(9000), data: { from: USER_A, to: USER_B, sid: STRAY } },
        { call_id: CALL_ID, type: "warm_transfer_missed", at: ago(4000), data: { user: USER_B, sid: STRAY } },
      ],
      tw: { conference: true, parts: [inRoom(CALL_SID), inRoom(OLD, { start_conference_on_enter: true })] },
    });
    expect((await startMove(token, { to: "mobile", leg_sid: OLD })).res.status).toBe(200);
  });

  it("a move past its 45 s (a lost callback) is over: a new one replaces it", async () => {
    const { token, calls } = await setup({ row: liveCall(ringing("mobile", 50_000)) });
    const { res, json } = await startMove(token, { to: "mobile", leg_sid: OLD });
    expect(res.status).toBe(200);
    expect(calls.row.handoff_key).toBe(json.key);
    expect(json.key).not.toBe(KEY);
  });

  it("two presses at once: the second claim loses and is refused, ringing nothing", async () => {
    const { net, token, calls } = await setup();
    calls.loseNext = true;
    const { res, json } = await startMove(token, { to: "mobile", leg_sid: OLD });
    expect(res.status).toBe(409);
    expect(json.error.code).toBe("handoff_in_progress");
    expect(twilioWrites(net)).toEqual([]);
  });
});

// ── The answer, and make before break ───────────────────────────────────────────────

describe("the phone answers (/voice/handoff)", () => {
  /** The new leg is in the conference as soon as it has its TwiML. */
  const newLegIn = (o: Partial<Tw> = {}): Partial<Tw> => ({ conference: true, parts: [inRoom(NEW, { start_conference_on_enter: true })], ...o });

  it("a plain INBOUND call, in order: claim (with the conference) → move the other side in → swap the holder → end the old leg", async () => {
    const s = await setup({
      row: liveCall(ringing("mobile")),
      // Redirecting the child (the old leg) brings it in, and the customer follows (after-dial step 0).
      tw: newLegIn({ onRedirect: (sid, tw) => tw.parts.push(inRoom(sid), inRoom(CALL_SID)) }),
    });
    const { text } = await phoneAnswers();
    // A plain call: the new leg starts the conference when the customer arrives.
    expect(text).toBe(conferenceTwiml(env, CALL_ID, "agent", true));
    expect(s.log).toEqual(["claim+conference", "redirect:old", "swap", "end:old"]);
    // The old device, cut off by that last step, asks how its call ended: already "done".
    expect(s.events.phases()).toEqual(["done"]);
    expect(s.calls.row).toMatchObject({
      client_call_sid: NEW, handoff_state: null, handoff_sid: NEW, handoff_from_sid: OLD, transfer_state: "conference",
      answered_by: USER_A, status: "in_progress",
    });
    // The claim's guards: this key, still ringing, inside the window, the same holder, a plain call.
    const [claim, swap] = s.calls.writes;
    for (const g of [`handoff_key=eq.${KEY}`, "handoff_state=eq.ringing", "handoff_to=eq.mobile", `client_call_sid=eq.${OLD}`, "transfer_state=is.null", "status=eq.in_progress", "ended_at=is.null"]) {
      expect(claim.query).toContain(g);
    }
    expect(claim.query).toMatch(/handoff_at=gt\./);
    // The swap is guarded on the old leg still holding it, and comes before the old leg ends.
    expect(swap.body).toEqual({ client_call_sid: NEW, handoff_state: null });
    expect(swap.query).toContain(`client_call_sid=eq.${OLD}`);
    expect(swap.query).toContain("handoff_state=eq.connecting");
    // Billing finds the new leg in data.sid.
    expect(s.events.switches()).toEqual([expect.objectContaining({ phase: "done", to: "mobile", sid: NEW, from_sid: OLD })]);
    expect(typeof s.events.switches()[0].ms).toBe("number");
  });

  it("a call on HOLD stays held: start=false, nothing redirected, no Participants change, the customer never connected", async () => {
    const s = await setup({
      row: liveCall({ ...ringing("mobile"), transfer_state: "conference" }),
      tw: { conference: true, parts: [inRoom(CALL_SID), inRoom(OLD), inRoom(NEW)] },
    });
    const { text } = await phoneAnswers();
    expect(text).toBe(conferenceTwiml(env, CALL_ID, "agent", false));
    expect(s.log).toEqual(["claim", "swap", "end:old"]);
    expect(s.calls.writes[0].query).toContain("transfer_state=eq.conference");
    expect(s.calls.row).toMatchObject({ client_call_sid: NEW, transfer_state: "conference", handoff_state: null });
    expect(s.events.phases()).toEqual(["done"]);
  });

  it.each([
    ["a wrong key (an older attempt)", { row: liveCall(ringing("mobile")) }, OTHER_KEY, NEW],
    ["a ring past its 45 s", { row: liveCall(ringing("mobile", 46_000)) }, KEY, NEW],
    ["a move already answered", { row: liveCall(ringing("mobile", 3_000, { handoff_state: "connecting" })) }, KEY, NEW],
    ["a move canceled", { row: liveCall(ringing("mobile", 3_000, { handoff_state: null })) }, KEY, NEW],
    ["a call that has ended", { row: liveCall({ ...ringing("mobile"), status: "completed", ended_at: ago(500) }) }, KEY, NEW],
    ["a move to the computer", { row: liveCall(ringing("chrome")) }, KEY, NEW],
    ["a leg that is not the ring placed", { row: liveCall(ringing("mobile")) }, KEY, STRAY],
  ] as [string, Opts, string, string][])("%s: \"That call has already moved or ended.\", and nothing moves", async (_l, o, key, sid) => {
    const { net, calls } = await setup({ ...o, tw: newLegIn() });
    const { text } = await phoneAnswers(key, sid);
    expect(text).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Say language="en-US">That call has already moved or ended.</Say><Hangup/></Response>');
    expect(calls.writes.filter((w) => w.won)).toEqual([]);
    expect(twilioWrites(net)).toEqual([]);
  });

  it("a lost race (the row changed between the read and the claim): refused, nothing moves", async () => {
    const { net, calls, log } = await setup({ row: liveCall(ringing("mobile")), tw: newLegIn() });
    calls.loseNext = true;
    const { text } = await phoneAnswers();
    expect(text).toContain("That call has already moved or ended.");
    expect(log).toEqual(["claim+conference (lost)"]);
    expect(twilioWrites(net)).toEqual([]);
  });

  it("the new leg never shows up in the conference: it is hung up, the conference claim goes back, the old device keeps the call", async () => {
    const { net, calls, events, log } = await setup({ row: liveCall(ringing("mobile")), tw: { conference: false } });
    await phoneAnswers();
    expect(log).toEqual(["claim+conference", "end:new", "unclaim", "clear"]);
    expect(calls.row).toMatchObject({ client_call_sid: OLD, transfer_state: null, handoff_state: null });
    expect(events.switches()).toEqual([expect.objectContaining({ phase: "failed", reason: "new_leg_not_connected", sid: NEW })]);
    expect(faults(net)).toContain("handoff_failed");
  });

  it("Twilio refusing to move the other side: same rollback, the plain call is as it was", async () => {
    const { calls, events, log } = await setup({ row: liveCall(ringing("mobile")), tw: newLegIn({ refuseMove: true }) });
    await phoneAnswers();
    expect(log).toEqual(["claim+conference", "redirect:old (refused)", "end:new", "unclaim", "clear"]);
    expect(calls.row).toMatchObject({ client_call_sid: OLD, transfer_state: null, handoff_state: null });
    expect(events.switches()[0]).toMatchObject({ phase: "failed", reason: "move_failed" });
  });

  it("the customer hung up as the move connected: the new leg and the old one are both ended", async () => {
    const { calls, events, log } = await setup({
      row: outboundCall(ringing("mobile")),
      tw: newLegIn({ status: { [CALL_SID]: "completed" } }), // redirect "succeeds" but they never arrive
    });
    await phoneAnswers();
    expect(log).toEqual(["claim+conference", "redirect:customer", "end:new", "end:old", "clear"]);
    expect(calls.row.client_call_sid).toBe(OLD);
    expect(events.switches()[0]).toMatchObject({ phase: "failed", reason: "call_over" });
  });

  it("the old device hung up during a held move that then failed: the customer is not stranded (voicemail, as any customer left waiting)", async () => {
    const { calls, log } = await setup({
      row: liveCall({ ...ringing("mobile"), transfer_state: "conference" }),
      tw: { conference: true, parts: [inRoom(CALL_SID, { hold: true }), inRoom(OLD, { status: "complete" })], status: { [OLD]: "completed" } },
    });
    await phoneAnswers();
    expect(log).toEqual(["claim", "end:new", "clear", "unclaim", "redirect:customer"]);
    expect(calls.row.transfer_state).toBeNull();
  });

  // ── The new leg ending before the swap (review 2026-10-03) ──

  /** The last redirect the Worker asked for on `sid`, as TwiML. */
  const lastRedirect = (net: FakeNet, sid: string) => new URLSearchParams(
    net.to(new RegExp(`/Calls/${sid}\\.json$`)).filter((x) => x.method === "POST" && x.body.includes("Twiml")).pop()?.body ?? "",
  ).get("Twiml");

  it("plain INBOUND: the new leg hangs up while the other side is on its way in: no swap, the old leg is not ended, and the conference is started for it (never voicemail mid-call)", async () => {
    const s = await setup({
      row: liveCall(ringing("mobile")),
      tw: newLegIn({
        onRedirect: (sid, tw) => {
          // The person ends the new device (it heard silence) as the old leg and the customer come
          // in: before anyone joined it, so nothing started the conference.
          tw.parts = [inRoom(NEW, { status: "complete", start_conference_on_enter: true }), inRoom(sid), inRoom(CALL_SID)];
          tw.status[NEW] = "completed";
        },
      }),
    });
    await phoneAnswers();
    expect(s.log).toEqual(["claim+conference", "redirect:old", "end:new", "clear", "redirect:old"]);
    expect(s.calls.row).toMatchObject({ client_call_sid: OLD, transfer_state: "conference", handoff_state: null });
    expect(s.events.switches()).toEqual([expect.objectContaining({ phase: "failed", reason: "new_leg_gone", sid: NEW })]);
    // The old leg back in as the one who starts it (Resume's TwiML): the two talk again.
    expect(lastRedirect(s.net, OLD)).toBe(conferenceTwiml(env, CALL_ID, "agent", true));
    expect(s.log).not.toContain("redirect:customer");
  });

  it("...and one that hangs up before the other side was moved: nothing moved, the claim goes back, the plain call is as it was", async () => {
    const s = await setup({
      row: liveCall(ringing("mobile")),
      // Listed connected once (step 1), then gone.
      tw: newLegIn({ onList: (tw, n) => {
        if (n === 2) {
          tw.status[NEW] = "completed";
          tw.parts[0].status = "complete";
        }
      } }),
    });
    await phoneAnswers();
    expect(s.log).toEqual(["claim+conference", "end:new", "unclaim", "clear"]);
    expect(s.calls.row).toMatchObject({ client_call_sid: OLD, transfer_state: null, handoff_state: null });
    expect(s.events.switches()[0]).toMatchObject({ phase: "failed", reason: "new_leg_gone" });
  });

  it("a HELD call whose new leg hangs up before the swap: the old device keeps it, the customer stays held (nothing started for them)", async () => {
    const s = await setup({
      row: liveCall({ ...ringing("mobile"), transfer_state: "conference" }),
      tw: {
        conference: true, parts: [inRoom(CALL_SID, { hold: true }), inRoom(OLD), inRoom(NEW)],
        onList: (tw, n) => {
          if (n === 2) {
            tw.status[NEW] = "completed";
            tw.parts[2].status = "complete";
          }
        },
      },
    });
    await phoneAnswers();
    expect(s.log).toEqual(["claim", "end:new", "clear"]);
    expect(s.calls.row).toMatchObject({ client_call_sid: OLD, transfer_state: "conference", handoff_state: null });
  });

  it("the new leg gone in the moment after the last check: once the old leg is ended, a customer left on their own is finished, not left in the conference", async () => {
    const s = await setup({
      row: liveCall({ ...ringing("mobile"), transfer_state: "conference" }),
      events: [{ call_id: CALL_ID, type: "conference_started", at: ago(30_000), data: { conference_sid: CONF } }],
      tw: { conference: true, parts: [inRoom(CALL_SID), inRoom(OLD), inRoom(NEW)] },
    });
    s.calls.onWrite = (l) => {
      if (l !== "swap") return;
      s.tw.status[NEW] = "completed";
      s.tw.parts[2].status = "complete";
    };
    await phoneAnswers();
    // They were talking (the conference had started): hung up, as any call whose other side hangs up.
    expect(s.log).toEqual(["claim", "swap", "end:old", "unclaim", "end:customer"]);
  });

  it("plain INBOUND: the old device hangs up while the new leg connects and the switch then fails: the customer, whom after-dial has taken into the conference, is finished (voicemail), never left on hold music", async () => {
    const s = await setup({
      row: liveCall(ringing("mobile")),
      // The old leg (the Dial's child) ended, so after-dial step 0 took the customer in; the new
      // leg is never listed.
      tw: { conference: true, parts: [inRoom(CALL_SID)], status: { [OLD]: "completed" } },
    });
    await phoneAnswers();
    expect(s.log).toEqual(["claim+conference", "end:new", "clear", "unclaim", "redirect:customer"]);
    expect(s.events.switches()[0]).toMatchObject({ phase: "failed", reason: "new_leg_not_connected" });
    expect(lastRedirect(s.net, CALL_SID)).toContain("<Record");
    expect(s.calls.row.transfer_state).toBeNull();
  });
});

describe("the computer answers (/voice/outbound with HandoffCall)", () => {
  it("a plain OUTBOUND call: the customer (the child) is moved in, then the holder swaps, then the old app leg ends — and no new call row, minute count or wallet read", async () => {
    const { net, calls, events, log } = await setup({
      row: outboundCall(ringing("chrome")),
      tw: { conference: true, parts: [inRoom(NEW, { start_conference_on_enter: true })], onRedirect: (sid, tw) => tw.parts.push(inRoom(sid)) },
    });
    const { text } = await computerAnswers();
    expect(text).toBe(conferenceTwiml(env, CALL_ID, "agent", true));
    expect(log).toEqual(["claim+conference", "redirect:customer", "swap", "end:old"]);
    expect(calls.row).toMatchObject({ client_call_sid: NEW, handoff_sid: NEW, handoff_state: null, placed_by: USER_A });
    expect(events.switches()).toEqual([expect.objectContaining({ phase: "done", to: "chrome", sid: NEW, from_sid: OLD })]);
    // Not an outbound call: no row, no daily minute count, no wallet floor.
    expect(net.writes("phone_calls", "POST")).toEqual([]);
    expect(net.reads("phone_calls").filter((s) => s.url.searchParams.has("started_at"))).toEqual([]);
    expect(net.reads("usage_prices")).toEqual([]);
    expect(net.reads("wallet_accounts")).toEqual([]);
    expect(net.reads("client_settings")).toEqual([]);
  });

  it("with usage billing armed, a wallet under the floor and the day's minute cap spent, the computer still takes the call: a move never meets the wallet floor or the cap", async () => {
    // makeEnv ships PHONE_USAGE_METERS off, where walletFloorCheck asks nothing at all, so the
    // test above cannot see the gate. Here it is on, and the gate would refuse.
    const armed = makeEnv({ PHONE_USAGE_METERS: "on", DAILY_MINUTE_CAP: "1" });
    const { net, calls, log } = await setup({
      row: outboundCall(ringing("chrome")),
      tw: { conference: true, parts: [inRoom(NEW, { start_conference_on_enter: true })], onRedirect: (sid, tw) => tw.parts.push(inRoom(sid)) },
    });
    net.rpc("wallet_usage_gate", () => ({ allow: false, reason: "below_floor", available_cents: 0, floor_cents: 500, auto_topup_enabled: true }));
    const { text } = await call(armed, await twilioPost(armed, "/voice/outbound", {
      CallSid: NEW, AccountSid: ACCOUNT, From: `client:u_${HEX_A}_g1`, To: "handoff", Direction: "inbound", HandoffCall: CALL_ID, HandoffKey: KEY,
    }));
    expect(text).toBe(conferenceTwiml(armed, CALL_ID, "agent", true));
    expect(log).toEqual(["claim+conference", "redirect:customer", "swap", "end:old"]);
    expect(calls.row.client_call_sid).toBe(NEW);
    expect(net.rpcCalls("wallet_usage_gate")).toEqual([]);
    expect(net.to(/\/functions\/v1\/wallet-autotopup$/)).toEqual([]);
    expect(net.writes("phone_calls", "POST")).toEqual([]);
    expect(net.reads("phone_calls").filter((s) => s.url.searchParams.has("started_at"))).toEqual([]);
  });

  it("a plain OUTBOUND call: the customer leaves the old leg's Dial before anything waits on the new leg, so the old device hanging up meanwhile cannot take them down", async () => {
    const s = await setup({
      row: outboundCall(ringing("chrome")),
      tw: {
        conference: true, parts: [],
        // The new leg is listed only after the customer was moved (the old code waited for it
        // first, and the customer was still the child of the old leg's Dial all that time).
        onRedirect: (sid, tw) => {
          tw.parts.push(inRoom(sid), inRoom(NEW, { start_conference_on_enter: true }));
          tw.status[OLD] = "completed"; // the person hangs up the old device meanwhile
        },
      },
    });
    await computerAnswers();
    expect(s.log).toEqual(["claim+conference", "redirect:customer", "swap", "end:old"]);
    expect(s.events.phases()).toEqual(["done"]);
    expect(s.calls.row).toMatchObject({ client_call_sid: NEW, transfer_state: "conference", handoff_state: null });
  });

  it("a plain OUTBOUND call whose new leg never arrives: the old device keeps the customer, and the conference they were both moved into is started for it", async () => {
    const s = await setup({
      row: outboundCall(ringing("chrome")),
      // The customer moves in; the old app leg follows (after-dial stage=out); the new leg never does.
      tw: { conference: true, parts: [], onRedirect: (sid, tw) => tw.parts.push(inRoom(sid), inRoom(OLD)) },
    });
    await computerAnswers();
    expect(s.log).toEqual(["claim+conference", "redirect:customer", "end:new", "clear", "redirect:old"]);
    expect(s.calls.row).toMatchObject({ client_call_sid: OLD, transfer_state: "conference", handoff_state: null });
    expect(s.events.switches()[0]).toMatchObject({ phase: "failed", reason: "new_leg_not_connected" });
    const restart = s.net.to(new RegExp(`/Calls/${OLD}\\.json$`)).filter((x) => x.method === "POST").pop()!;
    expect(new URLSearchParams(restart.body).get("Twiml")).toBe(conferenceTwiml(env, CALL_ID, "agent", true));
  });

  it.each([
    ["someone who does not hold the call", { row: liveCall({ ...ringing("chrome"), answered_by: USER_B }) }, {}, "That call has already moved or ended."],
    ["a wrong key", { row: liveCall(ringing("chrome")) }, { HandoffKey: OTHER_KEY }, "That call has already moved or ended."],
    ["a move to the phone", { row: liveCall(ringing("mobile")) }, {}, "That call has already moved or ended."],
    ["a call id that isn't one", { row: liveCall(ringing("chrome")) }, { HandoffCall: "nope" }, "That call has already moved or ended."],
  ] as [string, Opts, Record<string, string>, string][])("refuses %s, without dialing anyone", async (_l, o, params, words) => {
    const { net, calls } = await setup(o);
    const { text } = await computerAnswers(params);
    expect(text).toContain(words);
    expect(text).toContain("<Hangup/>");
    expect(text).not.toContain("<Number");
    expect(calls.writes).toEqual([]);
    expect(net.writes("phone_calls", "POST")).toEqual([]);
  });

  it("re-checks the caller like every outbound call: a retired device is refused", async () => {
    const { net, calls } = await setup({ row: liveCall(ringing("chrome")) });
    net.rpc("phone_caller_context", () => callerCtx({ device_generation: 2 }));
    const { text } = await computerAnswers();
    expect(text).toContain("This device was signed out");
    expect(calls.writes).toEqual([]);
  });
});

// ── After-dial, the conference and the status callbacks during and after a move ────

describe("the rest of the Worker around a move", () => {
  const afterDialOut = async (sid: string) => call(env, await twilioPost(env, "/voice/after-dial", {
    CallSid: sid, AccountSid: ACCOUNT, From: `client:u_${HEX_A}_g1`, To: CUSTOMER, DialCallStatus: "completed", DialBridged: "true",
  }, { call: CALL_ID, stage: "out" }));

  it("after-dial stage=out: the leg a move took the call FROM hangs up; before the swap it still joins (so a failed move leaves it the call)", async () => {
    await setup({ row: outboundCall({ transfer_state: "conference", client_call_sid: NEW, handoff_from_sid: OLD, handoff_sid: NEW }) });
    expect((await afterDialOut(OLD)).text).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');

    await setup({ row: outboundCall({ ...ringing("chrome", 2_000, { handoff_state: "connecting", handoff_sid: NEW }), transfer_state: "conference" }) });
    expect((await afterDialOut(OLD)).text).toBe(conferenceTwiml(env, CALL_ID, "agent"));
  });

  const leave = async (sid = OLD) => call(env, await twilioPost(env, "/voice/conference", {
    AccountSid: ACCOUNT, ConferenceSid: CONF, StatusCallbackEvent: "participant-leave", CallSid: sid,
  }, { call: CALL_ID }));

  it("while a move is connecting, the old leg leaving the conference does not finish the customer", async () => {
    // The new leg has answered but is not listed yet; the customer is alone in the list.
    const tw = { conference: true, parts: [inRoom(CALL_SID, { hold: true })], status: { [OLD]: "completed" } };
    const moving = await setup({ row: liveCall({ ...ringing("mobile", 1_000, { handoff_state: "connecting" }), transfer_state: "conference" }), tw });
    await leave();
    expect(moving.log).toEqual([]);

    // The same leave with no move under way sends the waiting customer to voicemail.
    const plain = await setup({ row: liveCall({ transfer_state: "conference" }), tw: { ...tw, parts: [inRoom(CALL_SID, { hold: true })] } });
    await leave();
    expect(plain.log).toEqual(["unclaim", "redirect:customer"]);
  });

  /** After a finished move: the new leg holds the call, the old one is on its way out. */
  const afterMove = (over: Row = {}) => liveCall({
    transfer_state: "conference", client_call_sid: NEW, handoff_from_sid: OLD, handoff_sid: NEW,
    handoff_key: KEY, handoff_to: "mobile", handoff_at: ago(3_000), ...over,
  });

  it("after a move, the old leg leaving never takes a customer on hold off hold: it was the same person's other device, not a transferrer", async () => {
    const s = await setup({
      row: afterMove(),
      tw: { conference: true, parts: [inRoom(CALL_SID, { hold: true }), inRoom(NEW)], status: { [OLD]: "completed" } },
    });
    await leave(OLD);
    expect(s.log).toEqual([]);
  });

  it("a failed move's new leg leaving does not either; a teammate who handed the call on leaving still does (HANDED OVER ON HOLD)", async () => {
    const failed = { transfer_state: "conference", client_call_sid: OLD, handoff_from_sid: OLD, handoff_sid: NEW, handoff_key: KEY, handoff_to: "chrome", handoff_at: ago(3_000) };
    const s = await setup({
      row: liveCall(failed),
      tw: { conference: true, parts: [inRoom(CALL_SID, { hold: true }), inRoom(OLD)], status: { [NEW]: "completed", [STRAY]: "completed" } },
    });
    await leave(NEW);
    expect(s.log).toEqual([]);
    await leave(STRAY);
    expect(s.log).toEqual(["participant:customer"]);
  });

  // The handoff_* columns outlive the move. Once the call has been handed on since (a warm
  // transfer the teammate answered), the leg that hands it on is a transferrer like any other.
  it.each([
    ["a move to the phone that was missed", { handoff_sid: NEW, handoff_to: "mobile" }, OLD],
    ["a move to the computer nobody answered", { handoff_sid: null, handoff_to: "chrome" }, OLD],
    ["a move that was done (the transferrer is the leg it moved to)", { handoff_sid: NEW, handoff_to: "mobile" }, NEW],
  ] as [string, Row, string][])("after %s, then Hold and a warm transfer the teammate answered: the transferrer hanging up takes the held customer off hold (HANDED OVER ON HOLD)", async (_l, move, transferrer) => {
    const s = await setup({
      row: liveCall({
        transfer_state: "conference", answered_by: USER_B, transferred_from: USER_A, client_call_sid: STRAY,
        handoff_state: null, handoff_key: KEY, handoff_at: ago(120_000), handoff_from_sid: OLD, ...move,
      }),
      tw: { conference: true, parts: [inRoom(CALL_SID, { hold: true }), inRoom(STRAY)], status: { [transferrer]: "completed" } },
    });
    await leave(transferrer);
    expect(s.log).toEqual(["participant:customer"]);
    expect(s.events.rows.map((e) => e.type)).toContain("handed_over");
  });

  it("...but a customer both of the person's legs have left is still finished (voicemail, they were waiting)", async () => {
    const s = await setup({
      row: afterMove(),
      tw: { conference: true, parts: [inRoom(CALL_SID, { hold: true })], status: { [OLD]: "completed", [NEW]: "completed" } },
    });
    await leave(OLD);
    expect(s.log).toEqual(["unclaim", "redirect:customer"]);
  });

  it("after a move, the old leg ending never closes the call; the customer's leg does, with the customer's talk time", async () => {
    // Whole seconds: Twilio's Timestamp has none.
    const answeredAt = new Date(Math.floor((Date.now() - 300_000) / 1000) * 1000).toISOString();
    const s = await setup({
      row: liveCall({ transfer_state: "conference", client_call_sid: NEW, handoff_from_sid: OLD, handoff_sid: NEW, answered_at: answeredAt }),
      tw: { conference: true, parts: [inRoom(CALL_SID), inRoom(NEW)] },
    });
    await statusOf({ CallSid: OLD, CallStatus: "completed", CallDuration: "200", To: `client:u_${HEX_A}_g1` }, { call: CALL_ID, leg: "client" });
    expect(s.calls.writes).toEqual([]);
    expect(s.calls.row.status).toBe("in_progress");

    const end = new Date(Date.parse(answeredAt) + 300_000);
    await statusOf({ CallSid: CALL_SID, CallStatus: "completed", CallDuration: "301", Timestamp: end.toUTCString() }, { leg: "pstn" });
    expect(s.calls.row).toMatchObject({ status: "completed", duration_s: 300 });
    expect(s.calls.row.ended_at).toBeTruthy();
  });

  it.each(["no-answer", "busy", "failed"])("the phone's ring ends %s: the move is cleared and recorded as missed (the asking device hears at once)", async (status) => {
    const s = await setup({ row: liveCall(ringing("mobile")) });
    await statusOf({ CallSid: NEW, CallStatus: status }, { call: CALL_ID, leg: "handoff" });
    expect(s.log).toEqual(["clear"]);
    expect(s.calls.writes[0].query).toContain(`handoff_key=eq.${KEY}`);
    expect(s.events.switches()).toEqual([{ phase: "missed", to: "mobile", sid: NEW, status }]);
    expect(s.calls.row.client_call_sid).toBe(OLD);
  });

  it("a ring's status for another attempt, or once answered, changes nothing", async () => {
    const s = await setup({ row: liveCall(ringing("mobile")) });
    await statusOf({ CallSid: STRAY, CallStatus: "no-answer" }, { call: CALL_ID, leg: "handoff" });
    await statusOf({ CallSid: NEW, CallStatus: "ringing" }, { call: CALL_ID, leg: "handoff" });
    expect(s.calls.writes).toEqual([]);
    s.calls.row.handoff_state = "connecting";
    await statusOf({ CallSid: NEW, CallStatus: "canceled" }, { call: CALL_ID, leg: "handoff" });
    expect(s.calls.writes).toEqual([]);
    expect(s.events.phases()).toEqual([]);
  });

  it("the customer hangs up while the phone rings: the ring is canceled (nobody answers a call that is gone), and no voicemail", async () => {
    const s = await setup({ row: liveCall(ringing("mobile")) });
    await statusOf({ CallSid: CALL_SID, CallStatus: "completed", Timestamp: new Date().toUTCString() }, { leg: "pstn" });
    expect(s.log.slice(0, 2)).toEqual(["clear", "cancel:new"]);
    expect(s.events.switches()).toEqual([{ phase: "canceled", to: "mobile", sid: NEW, reason: "call_ended" }]);
    expect(s.calls.row.status).toBe("completed");
    expect(s.log.some((l) => l.startsWith("redirect"))).toBe(false);
  });

  it("the old device hangs up while the computer is being rung: the call ends normally and the offer is withdrawn", async () => {
    const s = await setup({ row: liveCall(ringing("chrome")) });
    await statusOf({ CallSid: OLD, CallStatus: "completed", CallDuration: "40", To: `client:u_${HEX_A}_g1` }, { call: CALL_ID, leg: "client" });
    expect(s.calls.row).toMatchObject({ handoff_state: null, status: "completed" });
    expect(s.events.switches()).toEqual([{ phase: "canceled", to: "chrome", sid: null, reason: "call_ended" }]);
  });

  it.each([
    ["hold", {}],
    ["resume", {}],
    ["warm-transfer", { to_user_id: USER_B }],
    ["transfer", { to_user_id: USER_B }],
  ])("%s is refused while a move is under way (409 handoff_in_progress), and allowed once it is stale", async (what, body) => {
    const conf = what === "resume" ? { transfer_state: "conference" } : {};
    const moving = await setup({ row: liveCall({ ...ringing("mobile", 5_000), ...conf }) });
    const refused = await call(env, appRequest("POST", `/calls/${CALL_ID}/${what}`, moving.token, body));
    expect(refused.res.status).toBe(409);
    expect(refused.json.error.code).toBe("handoff_in_progress");
    expect(moving.calls.writes).toEqual([]);
    expect(twilioWrites(moving.net)).toEqual([]);

    const stale = await setup({ row: liveCall({ ...ringing("mobile", 60_000), ...conf }) });
    const allowed = await call(env, appRequest("POST", `/calls/${CALL_ID}/${what}`, stale.token, body));
    expect(allowed.json.error?.code).not.toBe("handoff_in_progress");
  });

  it("/voice/handoff is a Twilio path: a request without the webhook key is refused", async () => {
    await setup();
    const { res } = await call(env, await twilioPost(env, "/voice/handoff", { CallSid: NEW }, { call: CALL_ID, k: KEY }, { key: "wrong" }));
    expect(res.status).toBe(403);
  });
});

// ── Cancel, status and the computer's pending offer ─────────────────────────────────

describe("POST /calls/:id/handoff/cancel", () => {
  it("the holder giving up: cleared, the phone's ring canceled, recorded as canceled", async () => {
    const s = await setup({ row: liveCall(ringing("mobile")) });
    const { json } = await call(env, appRequest("POST", `/calls/${CALL_ID}/handoff/cancel`, s.token, { key: KEY }, { origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" }));
    expect(json).toEqual({ ok: true, state: "canceled", call_id: CALL_ID });
    expect(s.log).toEqual(["clear", "cancel:new"]);
    expect(s.events.switches()).toEqual([{ phase: "canceled", to: "mobile", sid: NEW, reason: "canceled", user: USER_A }]);
  });

  it("the computer declining its ring (Leave on phone): canceled, reason declined, so the phone says the call stayed there", async () => {
    const s = await setup({ row: liveCall(ringing("chrome")) });
    const { json } = await call(env, appRequest("POST", `/calls/${CALL_ID}/handoff/cancel`, s.token, { key: KEY }, { origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" }));
    expect(json).toEqual({ ok: true, state: "canceled", call_id: CALL_ID });
    expect(s.events.switches()).toEqual([{ phase: "canceled", to: "chrome", sid: null, reason: "declined", user: USER_A }]);
    expect(twilioWrites(s.net)).toEqual([]);
    const status = await call(env, appRequest("GET", `/calls/${CALL_ID}/handoff`, s.token));
    expect(status.json).toMatchObject({ state: "canceled", to: "chrome" });
  });

  it("the phone declining its ring (Leave on computer, before it rejects): canceled, reason declined, the ring stopped", async () => {
    const s = await setup({ row: liveCall(ringing("mobile")) });
    const { json } = await call(env, appRequest("POST", `/calls/${CALL_ID}/handoff/cancel`, s.token, { key: KEY }));
    expect(json).toEqual({ ok: true, state: "canceled", call_id: CALL_ID });
    expect(s.log).toEqual(["clear", "cancel:new"]);
    expect(s.events.switches()).toEqual([{ phase: "canceled", to: "mobile", sid: NEW, reason: "declined", user: USER_A }]);
    // The reject that follows ends the ring; with the move already cleared it records nothing more.
    await statusOf({ CallSid: NEW, CallStatus: "busy" }, { call: CALL_ID, leg: "handoff" });
    expect(s.events.phases()).toEqual(["canceled"]);
  });

  it("by the CallSid of the leg the move took the call from, after the move (an outbound app that never learned the call id)", async () => {
    const s = await setup({
      row: outboundCall({ transfer_state: "conference", client_call_sid: NEW, handoff_sid: NEW, handoff_from_sid: OLD, handoff_to: "mobile", handoff_key: KEY }),
      events: [
        { call_id: CALL_ID, type: "device_switch", at: ago(9000), data: { phase: "offered", to: "mobile" } },
        { call_id: CALL_ID, type: "device_switch", at: ago(2000), data: { phase: "done", to: "mobile", sid: NEW, from_sid: OLD } },
      ],
    });
    const status = await call(env, appRequest("GET", `/calls/${OLD}/handoff`, s.token));
    expect(status.json).toEqual({ ok: true, state: "done", to: "mobile", call_id: CALL_ID });
    const cancel = await call(env, appRequest("POST", `/calls/${OLD}/handoff/cancel`, s.token, { key: KEY }));
    expect(cancel.json).toEqual({ ok: true, state: "done", to: "mobile", call_id: CALL_ID });
    expect(s.calls.won()).toEqual([]);
    // Starting a move still needs the leg that holds the call.
    const start = await startMove(s.token, { to: "mobile", leg_sid: OLD }, OLD);
    expect(start.res.status).toBe(404);
    // A CallSid that was never on the call is still not found.
    const stray = await call(env, appRequest("GET", `/calls/${STRAY}/handoff`, s.token));
    expect(stray.res.status).toBe(404);
  });

  it("a wrong or stale key cancels nothing and says how it stands", async () => {
    const s = await setup({ row: liveCall(ringing("mobile", 2_000, { handoff_state: "connecting" })) });
    const { json } = await call(env, appRequest("POST", `/calls/${CALL_ID}/handoff/cancel`, s.token, { key: KEY }));
    expect(json).toEqual({ ok: true, state: "connecting", to: "mobile", call_id: CALL_ID });
    const other = await call(env, appRequest("POST", `/calls/${CALL_ID}/handoff/cancel`, s.token, { key: OTHER_KEY }));
    expect(other.json.state).toBe("connecting");
    expect(s.calls.writes.filter((w) => w.won)).toEqual([]);
  });

  it("only the call's person may cancel", async () => {
    const s = await setup({ row: liveCall({ ...ringing("mobile"), answered_by: USER_B }) });
    const { res, json } = await call(env, appRequest("POST", `/calls/${CALL_ID}/handoff/cancel`, s.token, { key: KEY }));
    expect(res.status).toBe(403);
    expect(json.error.code).toBe("not_your_call");
  });
});

describe("GET /calls/:id/handoff", () => {
  const ev = (phase: string, msAgo: number, data: Row = {}): EventFixture => ({ call_id: CALL_ID, type: "device_switch", at: ago(msAgo), data: { phase, to: "mobile", ...data } });

  it.each([
    ["ringing", liveCall(ringing("mobile", 3_000)), [], { state: "ringing", to: "mobile" }],
    ["connecting", liveCall(ringing("chrome", 3_000, { handoff_state: "connecting" })), [], { state: "connecting", to: "chrome" }],
    ["a ring past its 45 s (nobody said)", liveCall(ringing("chrome", 50_000)), [], { state: "missed", to: "chrome" }],
    ["done", liveCall({ client_call_sid: NEW }), [ev("offered", 9000), ev("done", 2000)], { state: "done", to: "mobile" }],
    ["missed", liveCall(), [ev("offered", 9000), ev("missed", 2000)], { state: "missed", to: "mobile" }],
    ["failed", liveCall(), [ev("offered", 9000), ev("failed", 2000)], { state: "failed", to: "mobile" }],
    ["canceled", liveCall(), [ev("offered", 9000), ev("canceled", 2000)], { state: "canceled", to: "mobile" }],
    ["the latest attempt, not an older one", liveCall(), [ev("offered", 30_000), ev("done", 25_000), ev("offered", 9000), ev("missed", 2000)], { state: "missed", to: "mobile" }],
    ["never moved", liveCall(), [], { state: "none", to: null }],
    ["handed over, in the moment before its event is written", liveCall({ client_call_sid: NEW, handoff_sid: NEW, handoff_to: "chrome", handoff_from_sid: OLD }), [ev("offered", 3000, { to: "chrome" })], { state: "done", to: "chrome" }],
    ["a later move, canceled, after one that was done", liveCall({ client_call_sid: NEW, handoff_sid: null, handoff_to: "chrome" }), [ev("done", 30_000), ev("offered", 9000), ev("canceled", 2000)], { state: "canceled", to: "mobile" }],
    ["an app's own mark never counts", liveCall(), [ev("done", 2000, { source: "app" })], { state: "none", to: null }],
  ] as [string, Row, EventFixture[], Row][])("%s", async (_l, row, events, expected) => {
    const s = await setup({ row, events });
    const { json } = await call(env, appRequest("GET", `/calls/${CALL_ID}/handoff`, s.token));
    expect(json).toEqual({ ok: true, ...expected, call_id: CALL_ID });
  });
});

describe("GET /handoff/pending", () => {
  it("offers the computer the move ringing for it, with what it needs to show and answer it", async () => {
    const s = await setup({
      row: liveCall({ ...ringing("chrome"), contact_id: CONTACT_1, transfer_state: "conference" }),
      contact: { name: "Jordan Demo" },
      events: [{ call_id: CALL_ID, type: "device_switch", at: ago(5000), data: { phase: "offered", to: "chrome", held: true, user: USER_A } }],
    });
    const { json } = await call(env, appRequest("GET", "/handoff/pending?for=chrome", s.token));
    expect(json).toEqual({
      ok: true,
      offer: {
        call_id: CALL_ID, key: KEY, customer_e164: CUSTOMER, contact_id: CONTACT_1, contact_name: "Jordan Demo",
        direction: "in", answered_at: s.calls.row.answered_at, held: true,
        expires_at: new Date(Date.parse(s.calls.row.handoff_at) + 45_000).toISOString(),
      },
    });
    // Narrowed to the caller's tenant and their own calls.
    const q = decodeURIComponent(s.net.reads("phone_calls")[0].url.search);
    expect(q).toContain(`client_id=eq.${CLIENT}`);
    expect(q).toContain(`or=(answered_by.eq.${USER_A},placed_by.eq.${USER_A})`);
  });

  it.each([
    ["nothing ringing", liveCall()],
    ["a move to the phone", liveCall(ringing("mobile"))],
    ["a ring past its 45 s", liveCall(ringing("chrome", 50_000))],
    ["someone else's call", liveCall({ ...ringing("chrome"), answered_by: USER_B })],
  ])("no offer for %s", async (_l, row) => {
    const s = await setup({ row });
    const { json } = await call(env, appRequest("GET", "/handoff/pending?for=chrome", s.token));
    expect(json).toEqual({ ok: true, offer: null });
  });
});

describe("POST /token", () => {
  it("says this Worker can move calls (features.handoff), so the apps show the button", async () => {
    const s = await setup();
    const { json } = await call(env, appRequest("POST", "/token", s.token, { platform: "chrome", build_type: "prod", app_version: "1" }));
    expect(json.features).toEqual({ handoff: true });
  });
});

describe("GET /calls", () => {
  it("rows carry the move under way (and nothing once it is stale)", async () => {
    const s = await setup({ row: liveCall(ringing("chrome")) });
    s.net.rpc("crm_visible_contact_ids", (r) => r.json.p_ids);
    const { json } = await call(env, appRequest("GET", "/calls", s.token));
    expect(json.calls[0]).toMatchObject({ id: CALL_ID, handoff_state: "ringing", handoff_to: "chrome" });

    const stale = await setup({ row: liveCall(ringing("chrome", 50_000)) });
    const again = await call(env, appRequest("GET", "/calls", stale.token));
    expect(again.json.calls[0]).toMatchObject({ handoff_state: null, handoff_to: null });
  });
});
