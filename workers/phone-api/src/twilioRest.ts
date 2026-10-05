// Twilio REST calls the Worker makes itself (texts go through _shared/twilioSms.ts instead).
//
// Auth is the API key pair when present, else AccountSid:AuthToken, the same order
// _shared/twilioSms.ts uses and for the same reason: the auth token has been an empty string on
// this deployment before, so it must never be the only door for REST.
//
// ⚠️ NO TWILIO ERROR MESSAGE IS EVER PROPAGATED. Their bodies echo phone numbers back; only the
// numeric code and the HTTP status travel (the twilioSms.ts rule).

import type { Env } from "./env";

const API = "https://api.twilio.com/2010-04-01";

export class TwilioError extends Error {
  readonly status: number;
  readonly code: number;
  constructor(op: string, status: number, code: number) {
    super(`Twilio ${op} failed (HTTP ${status}${code ? `, code ${code}` : ""})`);
    this.name = "TwilioError";
    this.status = status;
    this.code = code;
  }
}

export function twilioConfigured(env: Env): boolean {
  return !!env.TWILIO_ACCOUNT_SID && !!basicAuth(env);
}

function basicAuth(env: Env): string | null {
  if (env.TWILIO_API_KEY && env.TWILIO_API_SECRET) return `Basic ${btoa(`${env.TWILIO_API_KEY}:${env.TWILIO_API_SECRET}`)}`;
  if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) return `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`;
  return null;
}

function account(env: Env): string {
  if (!env.TWILIO_ACCOUNT_SID) throw new TwilioError("config", 0, 0);
  return env.TWILIO_ACCOUNT_SID;
}

async function codeOf(res: Response): Promise<number> {
  try {
    const body = (await res.json()) as { code?: unknown };
    return typeof body?.code === "number" ? body.code : 0;
  } catch {
    return 0;
  }
}

async function call(env: Env, op: string, path: string, init: RequestInit = {}): Promise<Response> {
  const auth = basicAuth(env);
  if (!auth) throw new TwilioError(`${op} (no credentials)`, 0, 0);
  let res: Response;
  try {
    res = await fetch(`${API}/Accounts/${account(env)}${path}`, {
      ...init,
      headers: { Accept: "application/json", Authorization: auth, ...(init.headers ?? {}) },
    });
  } catch {
    throw new TwilioError(`${op} (unreachable)`, 0, 0);
  }
  return res;
}

/** A form body. An array value is sent as the same name repeated (Twilio's list parameters). */
function form(fields: Record<string, string | string[]>): RequestInit {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    for (const one of Array.isArray(v) ? v : [v]) body.append(k, one);
  }
  return {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  };
}

/** Redirect or end a live call (Twiml, Url or Status=completed). */
export async function updateCall(env: Env, callSid: string, fields: Record<string, string>): Promise<void> {
  const res = await call(env, "update call", `/Calls/${encodeURIComponent(callSid)}.json`, form(fields));
  if (!res.ok) throw new TwilioError("update call", res.status, await codeOf(res));
}

export interface NewCall {
  /**
   * A number, or client:<identity>. A client address may carry custom parameters as a query
   * string (client:alice?name=value&...): Twilio hands them to the Voice SDK's CallInvite as
   * customParameters (Twilio "share information between your applications", 2020-09; keep the
   * whole set under about 800 bytes).
   */
  to: string;
  from: string;
  /** The TwiML Twilio fetches (POST) when the call is answered. */
  url: string;
  /** Seconds to ring before giving up (no-answer). */
  timeout: number;
  statusCallback: string;
  /** Default: every progress event (initiated ringing answered completed). */
  statusCallbackEvent?: string[];
}

/** Place a call (the device switch's ring to the person's own phone, handoff.ts). Returns its CallSid. */
export async function createCall(env: Env, c: NewCall): Promise<string> {
  const res = await call(env, "create call", "/Calls.json", form({
    To: c.to,
    From: c.from,
    Url: c.url,
    Method: "POST",
    Timeout: String(c.timeout),
    StatusCallback: c.statusCallback,
    StatusCallbackMethod: "POST",
    StatusCallbackEvent: c.statusCallbackEvent ?? ["initiated", "ringing", "answered", "completed"],
  }));
  if (!res.ok) throw new TwilioError("create call", res.status, await codeOf(res));
  const body = (await res.json().catch(() => ({}))) as { sid?: string };
  if (!body.sid) throw new TwilioError("create call (no sid)", res.status, 0);
  return String(body.sid);
}

export interface TwilioCall {
  sid: string;
  from: string;
  to: string;
  direction: string;
  status: string;
  start_time: string | null;
  parent_call_sid: string | null;
}

export async function fetchCall(env: Env, callSid: string): Promise<TwilioCall | null> {
  const res = await call(env, "fetch call", `/Calls/${encodeURIComponent(callSid)}.json`);
  if (res.status === 404) return null;
  if (!res.ok) throw new TwilioError("fetch call", res.status, await codeOf(res));
  return (await res.json()) as TwilioCall;
}

export interface TwilioRecording {
  sid: string;
  call_sid: string;
  status: string;
  duration: string | null;
  date_created: string;
  /**
   * How it was made: RecordVerb (<Record>, a voicemail), StartCallRecordingAPI (a call
   * recording), DialVerb, Conference, ... The sweep files RecordVerb only (cron/sweep.ts).
   */
  source?: string;
}

/**
 * Recordings created on or after `since` (a UTC date; Twilio filters by day), newest first,
 * up to `max`. Pages are followed with next_page_uri until there are no more or `max` is reached.
 */
export async function listRecordings(env: Env, since: string, max = 200): Promise<TwilioRecording[]> {
  const out: TwilioRecording[] = [];
  let path: string | null = `/Recordings.json?${new URLSearchParams({ "DateCreated>": since, PageSize: "100" })}`;
  while (path && out.length < max) {
    const res: Response = await call(env, "list recordings", path);
    if (!res.ok) throw new TwilioError("list recordings", res.status, await codeOf(res));
    const body = (await res.json()) as { recordings?: TwilioRecording[]; next_page_uri?: string | null };
    out.push(...(body.recordings ?? []));
    const next = body.next_page_uri ?? null;
    // next_page_uri is absolute from /2010-04-01/Accounts/AC.../ — keep only what follows the account.
    path = next ? next.replace(/^.*\/Accounts\/[^/]+/, "") : null;
  }
  return out.slice(0, max);
}

/** Delete a recording at Twilio. A recording already gone counts as deleted. */
export async function deleteRecording(env: Env, recordingSid: string): Promise<void> {
  const res = await call(env, "delete recording", `/Recordings/${encodeURIComponent(recordingSid)}.json`, { method: "DELETE" });
  if (res.status === 204 || res.status === 404) return;
  throw new TwilioError("delete recording", res.status, await codeOf(res));
}

/**
 * The recording's audio as an MP3 stream. A Range header is passed through for seeking.
 * `channels` 2 asks for both channels of a dual-channel call recording (RequestedChannels=2):
 * the transcriber needs them apart. Without it Twilio mixes them to one, which is what playback
 * wants (both people in both ears) and what a voicemail always is.
 */
export async function recordingMedia(env: Env, recordingSid: string, range: string | null, channels: 1 | 2 = 1): Promise<Response> {
  const q = channels === 2 ? "?RequestedChannels=2" : "";
  return call(env, "fetch recording", `/Recordings/${encodeURIComponent(recordingSid)}.mp3${q}`, {
    headers: range ? { Range: range } : {},
  });
}

// ── Call recordings (src/recording.ts) ──────────────────────────────────────────────
//
// Started, paused, resumed and stopped through the REST API on one call leg (the customer's),
// never by a TwiML `record` attribute: that is how one recording follows the call through hold,
// transfers and a device switch, and how nothing records a call that did not hear the notice.

export interface StartedRecording {
  sid: string;
  status: string;
  /** 2 for a dual-channel recording; null when Twilio does not say. */
  channels: number | null;
}

/** Start recording a live call. Fields are Twilio's (RecordingChannels, RecordingStatusCallback, ...). */
export async function startRecording(env: Env, callSid: string, fields: Record<string, string | string[]>): Promise<StartedRecording> {
  const res = await call(env, "start recording", `/Calls/${encodeURIComponent(callSid)}/Recordings.json`, form(fields));
  if (!res.ok) throw new TwilioError("start recording", res.status, await codeOf(res));
  const body = (await res.json().catch(() => ({}))) as { sid?: string; status?: string; channels?: number | string | null };
  if (!body.sid) throw new TwilioError("start recording (no sid)", res.status, 0);
  const ch = Number.parseInt(String(body.channels ?? ""), 10);
  return { sid: String(body.sid), status: String(body.status ?? ""), channels: Number.isFinite(ch) ? ch : null };
}

/** Pause, resume or stop a call recording: Status paused | in-progress | stopped (PauseBehavior skip). */
export async function updateRecording(env: Env, callSid: string, recordingSid: string, fields: Record<string, string>): Promise<void> {
  const res = await call(env, "update recording",
    `/Calls/${encodeURIComponent(callSid)}/Recordings/${encodeURIComponent(recordingSid)}.json`, form(fields));
  if (!res.ok) throw new TwilioError("update recording", res.status, await codeOf(res));
}

/** Every recording on one call (one page of 50 is far more than a call ever has). */
export async function listCallRecordings(env: Env, callSid: string): Promise<TwilioRecording[]> {
  const res = await call(env, "list call recordings", `/Calls/${encodeURIComponent(callSid)}/Recordings.json?PageSize=50`);
  if (res.status === 404) return [];
  if (!res.ok) throw new TwilioError("list call recordings", res.status, await codeOf(res));
  const body = (await res.json()) as { recordings?: TwilioRecording[] };
  return body.recordings ?? [];
}

// ── Conferences (hold and warm transfer, plan 9C design b) ──────────────────────────
//
// The conference for a call is named after its phone_calls id, so nothing about it has to be
// stored: the name is found again from the id, and the SID from the name.

export interface TwilioConference {
  sid: string;
  friendly_name: string;
  /**
   * init, in-progress or completed: whether the conference is live, NOT whether it has started.
   * A plain Hold (both legs joined with startConferenceOnEnter=false, the customer on wait
   * music) reads in-progress (seen on a live call, 2026-09-30). conference.ts hasStarted says.
   */
  status: string;
}

export interface TwilioParticipant {
  call_sid: string;
  /** A Participants-API hold only. A leg waiting in a conference nobody has started reads false. */
  hold: boolean;
  muted: boolean;
  /** How the leg joined (conference.ts participantsProveStart). */
  start_conference_on_enter?: boolean;
  /** queued, connecting, ringing, connected, complete, failed. */
  status: string;
}

/** The live (not completed) conference with this name, or null. */
export async function findConference(env: Env, name: string): Promise<TwilioConference | null> {
  const q = new URLSearchParams({ FriendlyName: name, PageSize: "20" });
  const res = await call(env, "list conferences", `/Conferences.json?${q}`);
  if (!res.ok) throw new TwilioError("list conferences", res.status, await codeOf(res));
  const body = (await res.json()) as { conferences?: TwilioConference[] };
  return (body.conferences ?? []).find((c) => c.friendly_name === name && c.status !== "completed") ?? null;
}

export async function listParticipants(env: Env, conferenceSid: string): Promise<TwilioParticipant[]> {
  const res = await call(env, "list participants", `/Conferences/${encodeURIComponent(conferenceSid)}/Participants.json?PageSize=50`);
  if (res.status === 404) return [];
  if (!res.ok) throw new TwilioError("list participants", res.status, await codeOf(res));
  const body = (await res.json()) as { participants?: TwilioParticipant[] };
  return body.participants ?? [];
}

/** Hold, unhold (and anything else the Participant resource takes) for one leg. */
export async function updateParticipant(env: Env, conferenceSid: string, callSid: string, fields: Record<string, string>): Promise<void> {
  const res = await call(env, "update participant",
    `/Conferences/${encodeURIComponent(conferenceSid)}/Participants/${encodeURIComponent(callSid)}.json`, form(fields));
  if (!res.ok) throw new TwilioError("update participant", res.status, await codeOf(res));
}

/**
 * Dial someone into a conference. `conference` is the conference's NAME: Twilio accepts a
 * friendly name here (only when adding a participant) and joins the live conference of that
 * name, or starts it. Returns the new leg's CallSid.
 */
export async function addParticipant(env: Env, conference: string, fields: Record<string, string | string[]>): Promise<string> {
  const res = await call(env, "add participant", `/Conferences/${encodeURIComponent(conference)}/Participants.json`, form(fields));
  if (!res.ok) throw new TwilioError("add participant", res.status, await codeOf(res));
  const body = (await res.json()) as { call_sid?: string };
  return String(body.call_sid ?? "");
}

// ── MMS media ───────────────────────────────────────────────────────────────────────

export interface TwilioMedia {
  sid: string;
  content_type: string;
  date_created?: string;
}

/** The media on one message, in the order Twilio lists them. */
export async function listMessageMedia(env: Env, messageSid: string): Promise<TwilioMedia[]> {
  const res = await call(env, "list media", `/Messages/${encodeURIComponent(messageSid)}/Media.json?PageSize=20`);
  if (res.status === 404) return [];
  if (!res.ok) throw new TwilioError("list media", res.status, await codeOf(res));
  const body = (await res.json()) as { media_list?: TwilioMedia[] };
  return body.media_list ?? [];
}

/**
 * One media file's bytes. The path is built here from SIDs only, never from a stored URL, so
 * our credentials can only ever go to api.twilio.com. Twilio answers with a redirect to a
 * short-lived, already-signed file URL. The redirect is followed BY HAND and WITHOUT our
 * Authorization header: a signed storage URL refuses a request that carries a second
 * credential, and our key has no business travelling to another host anyway.
 */
export async function messageMediaContent(env: Env, messageSid: string, mediaSid: string): Promise<Response> {
  const first = await call(env, "fetch media", `/Messages/${encodeURIComponent(messageSid)}/Media/${encodeURIComponent(mediaSid)}`, {
    headers: { Accept: "*/*" },
    redirect: "manual",
  });
  if (first.status < 300 || first.status >= 400) return first;
  const location = first.headers.get("location");
  let target: URL;
  try {
    target = new URL(location ?? "", API);
  } catch {
    throw new TwilioError("fetch media (bad redirect)", first.status, 0);
  }
  if (!location || target.protocol !== "https:") throw new TwilioError("fetch media (bad redirect)", first.status, 0);
  try {
    return await fetch(target.href);
  } catch {
    throw new TwilioError("fetch media (unreachable)", 0, 0);
  }
}

// ── What things cost (cron/usageCharge.ts) ──────────────────────────────────────────
//
// Twilio states a price as a NEGATIVE decimal string in USD ("-0.01400"), filled in a while
// after the call or text ends: null until then. Usage Records state theirs as positive
// strings. Both come out of here as positive micros (millionths of a dollar), rounded half
// up, so the billing code never sees a sign or a float; null stays null ("not priced yet").
// Every price is assumed to be USD (the account's currency); priceUnit is carried through so
// cost_detail shows it if that ever changes.

/** A Twilio price string as positive micros, rounded half up. Null, blank or garbage → null. */
export function priceMicros(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  // Exact decimal arithmetic on the digits: 0.0000005 * 1e6 in floating point is
  // 0.49999999999999994, which Math.round takes down.
  const m = /^[+-]?(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (!m[1] && !m[2])) {
    const n = Number(s);
    return Number.isFinite(n) ? Math.round(Math.abs(n) * 1_000_000) : null;
  }
  const whole = Number(m[1] || "0");
  const frac = (m[2] ?? "").padEnd(7, "0");
  const micros = whole * 1_000_000 + Number(frac.slice(0, 6)) + (Number(frac[6]) >= 5 ? 1 : 0);
  return Number.isFinite(micros) ? micros : null;
}

/** One call leg, with what it cost. */
export interface TwilioLegCost {
  sid: string;
  /** queued, ringing, in-progress, completed, busy, failed, no-answer, canceled. */
  status: string;
  /** Seconds, once the leg has ended. */
  duration: number | null;
  /** Positive micros, or null while Twilio has not priced it. */
  price: number | null;
  priceUnit: string | null;
  parentCallSid: string | null;
  /** inbound, outbound-api or outbound-dial. */
  direction: string;
  /** "client:..." for an app leg; otherwise a number. Never logged or stored. */
  from: string;
  to: string;
}

interface RawCall {
  sid?: string;
  status?: string;
  duration?: string | number | null;
  price?: string | null;
  price_unit?: string | null;
  parent_call_sid?: string | null;
  direction?: string;
  from?: string;
  to?: string;
}

function legCost(c: RawCall): TwilioLegCost {
  const d = Number.parseInt(String(c.duration ?? ""), 10);
  return {
    sid: String(c.sid ?? ""),
    status: String(c.status ?? ""),
    duration: Number.isFinite(d) ? d : null,
    price: priceMicros(c.price),
    priceUnit: c.price_unit ?? null,
    parentCallSid: c.parent_call_sid ?? null,
    direction: String(c.direction ?? ""),
    from: String(c.from ?? ""),
    to: String(c.to ?? ""),
  };
}

/**
 * One leg's price, duration and status. A separate function from fetchCall on purpose: that
 * one hands conference.ts and the sweep Twilio's raw resource, and they read it by Twilio's
 * own field names. Null when Twilio has no such call.
 */
export async function fetchCallCost(env: Env, callSid: string): Promise<TwilioLegCost | null> {
  const res = await call(env, "fetch call", `/Calls/${encodeURIComponent(callSid)}.json`);
  if (res.status === 404) return null;
  if (!res.ok) throw new TwilioError("fetch call", res.status, await codeOf(res));
  return legCost((await res.json()) as RawCall);
}

/**
 * The legs a call's TwiML dialed (its <Dial> children), with their prices. A cold transfer
 * dials again from the same parent, or from a child for an outbound call, so the billing code
 * walks this more than one level down. One page of 50 is far more than one call ever makes.
 */
export async function listChildCalls(env: Env, parentSid: string): Promise<TwilioLegCost[]> {
  const q = new URLSearchParams({ ParentCallSid: parentSid, PageSize: "50" });
  const res = await call(env, "list child calls", `/Calls.json?${q}`);
  if (res.status === 404) return [];
  if (!res.ok) throw new TwilioError("list child calls", res.status, await codeOf(res));
  const body = (await res.json()) as { calls?: RawCall[] };
  return (body.calls ?? []).map(legCost).filter((c) => c.sid);
}

export interface TwilioMessageCost {
  sid: string;
  /** queued, sending, sent, delivered, undelivered, failed, receiving, received, ... */
  status: string;
  numSegments: number | null;
  /** Positive micros, or null while Twilio has not priced it. Carrier fees are NOT in it. */
  price: number | null;
  priceUnit: string | null;
  direction: string;
}

/** One text's status, segments and price. Null when Twilio has no such message. */
export async function fetchMessage(env: Env, messageSid: string): Promise<TwilioMessageCost | null> {
  const res = await call(env, "fetch message", `/Messages/${encodeURIComponent(messageSid)}.json`);
  if (res.status === 404) return null;
  if (!res.ok) throw new TwilioError("fetch message", res.status, await codeOf(res));
  const m = (await res.json()) as { sid?: string; status?: string; num_segments?: string | number | null; price?: string | null; price_unit?: string | null; direction?: string };
  const seg = Number.parseInt(String(m.num_segments ?? ""), 10);
  return {
    sid: String(m.sid ?? messageSid),
    status: String(m.status ?? ""),
    numSegments: Number.isFinite(seg) ? seg : null,
    price: priceMicros(m.price),
    priceUnit: m.price_unit ?? null,
    direction: String(m.direction ?? ""),
  };
}

export interface TwilioRecordingCost {
  sid: string;
  duration: number | null;
  price: number | null;
  /** The call it is a recording of, and how it was made (StartCallRecordingAPI for a call recording, RecordVerb for a voicemail). */
  callSid: string | null;
  source: string | null;
}

/** A recording's duration and price, and whose it is. Null when it is gone (retention deletes them). */
export async function fetchRecording(env: Env, recordingSid: string): Promise<TwilioRecordingCost | null> {
  const res = await call(env, "fetch recording", `/Recordings/${encodeURIComponent(recordingSid)}.json`);
  if (res.status === 404) return null;
  if (!res.ok) throw new TwilioError("fetch recording", res.status, await codeOf(res));
  const r = (await res.json()) as { sid?: string; duration?: string | number | null; price?: string | null; call_sid?: string | null; source?: string | null };
  const d = Number.parseInt(String(r.duration ?? ""), 10);
  return {
    sid: String(r.sid ?? recordingSid), duration: Number.isFinite(d) ? d : null, price: priceMicros(r.price),
    callSid: r.call_sid ? String(r.call_sid) : null, source: r.source ? String(r.source) : null,
  };
}

/**
 * The Usage Records categories the daily snapshot keeps (twilio_usage_daily): what calls and
 * texts cost the account as a whole, so the per-item costs and the carrier-fee estimate can be
 * checked against Twilio's own totals. Any conference category is kept as well (Twilio names
 * it differently across products).
 */
export const USAGE_CATEGORIES = new Set([
  "calls", "calls-inbound", "calls-outbound", "calls-client",
  "sms-inbound", "sms-outbound", "sms-messages-carrierfees", "recordings",
]);

export interface TwilioUsageRecord {
  category: string;
  count: number | null;
  usage: number | null;
  /** Positive micros. */
  priceMicros: number | null;
  priceUnit: string | null;
}

/**
 * One UTC day's Usage Records (Daily.json, StartDate = EndDate = day), the categories above
 * only. Every category comes back on one or two pages, so this follows next_page_uri a few
 * times at most.
 */
export async function listUsageDaily(env: Env, day: string): Promise<TwilioUsageRecord[]> {
  const out: TwilioUsageRecord[] = [];
  let path: string | null = `/Usage/Records/Daily.json?${new URLSearchParams({ StartDate: day, EndDate: day, PageSize: "1000" })}`;
  for (let page = 0; path && page < 5; page++) {
    const res: Response = await call(env, "list usage", path);
    if (!res.ok) throw new TwilioError("list usage", res.status, await codeOf(res));
    const body = (await res.json()) as {
      usage_records?: { category?: string; count?: string | number | null; usage?: string | number | null; price?: string | null; price_unit?: string | null }[];
      next_page_uri?: string | null;
    };
    for (const r of body.usage_records ?? []) {
      const category = String(r.category ?? "");
      if (!USAGE_CATEGORIES.has(category) && !/conference/i.test(category)) continue;
      const count = Number(r.count);
      const usage = Number(r.usage);
      out.push({
        category,
        count: r.count === null || r.count === undefined || !Number.isFinite(count) ? null : count,
        usage: r.usage === null || r.usage === undefined || !Number.isFinite(usage) ? null : usage,
        priceMicros: priceMicros(r.price),
        priceUnit: r.price_unit ?? null,
      });
    }
    const next = body.next_page_uri ?? null;
    path = next ? next.replace(/^.*\/Accounts\/[^/]+/, "") : null;
  }
  return out;
}

/** Network Traversal Service: short-lived STUN/TURN credentials. */
export async function ntsToken(env: Env, ttlSeconds = 3600): Promise<unknown[]> {
  const res = await call(env, "nts token", "/Tokens.json", form({ Ttl: String(ttlSeconds) }));
  if (!res.ok) throw new TwilioError("nts token", res.status, await codeOf(res));
  const body = (await res.json()) as { ice_servers?: unknown[] };
  return Array.isArray(body.ice_servers) ? body.ice_servers : [];
}
