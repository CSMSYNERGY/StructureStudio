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
  source?: string;
}

/**
 * Recordings created on or after `since` (a UTC date; Twilio filters by day), newest first,
 * up to `max`. Pages are followed with next_page_uri.
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

/** The recording's audio as an MP3 stream. A Range header is passed through for seeking. */
export async function recordingMedia(env: Env, recordingSid: string, range: string | null): Promise<Response> {
  return call(env, "fetch recording", `/Recordings/${encodeURIComponent(recordingSid)}.mp3`, {
    headers: range ? { Range: range } : {},
  });
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

/** Network Traversal Service: short-lived STUN/TURN credentials. */
export async function ntsToken(env: Env, ttlSeconds = 3600): Promise<unknown[]> {
  const res = await call(env, "nts token", "/Tokens.json", form({ Ttl: String(ttlSeconds) }));
  if (!res.ok) throw new TwilioError("nts token", res.status, await codeOf(res));
  const body = (await res.json()) as { ice_servers?: unknown[] };
  return Array.isArray(body.ice_servers) ? body.ice_servers : [];
}
