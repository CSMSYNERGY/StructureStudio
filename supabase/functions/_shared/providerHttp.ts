// providerHttp.ts — the HTTP plumbing Google Calendar and Microsoft Graph share (migration 341).
//
// One error class with a code we can store and show, never the provider's response text (the
// portal-settings dbFail rule: a third party's words are not ours to put on a screen). No
// jsr:/npm: imports, so the API modules built on it run in the offline test group.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class ProviderError extends Error {
  constructor(
    /** 'invalid_grant' (connection gone) | 'unauthorized' | 'not_found' | 'rate_limited' |
     *  'provider_error' (5xx, network, timeout) | 'refused' (another 4xx). */
    public code: string,
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Network failure or timeout → provider_error, so a hung provider never hangs a booking. */
export async function providerCall(
  f: FetchLike, url: string, init: RequestInit, timeoutMs: number, who: string,
): Promise<Response> {
  try {
    return await f(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new ProviderError("provider_error", 0, `${who} could not be reached: ${(e as Error)?.name || "error"}`);
  }
}

export async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export function classify(status: number, body: unknown, who: string): ProviderError {
  // deno-lint-ignore no-explicit-any
  const b = body as any;
  const reason = String(b?.error?.status ?? b?.error?.code ?? b?.error ?? b?.reason ?? "");
  if (status === 400 && /invalid_grant/i.test(reason)) {
    return new ProviderError("invalid_grant", status, `${who} no longer accepts this connection.`);
  }
  if (status === 401) return new ProviderError("unauthorized", status, `${who} refused the access token.`);
  if (status === 404 || status === 410) return new ProviderError("not_found", status, `${who} has no such item.`);
  if (status === 429) return new ProviderError("rate_limited", status, `${who} asked us to slow down.`);
  if (status >= 500) return new ProviderError("provider_error", status, `${who} answered ${status}.`);
  return new ProviderError("refused", status, `${who} refused the request (${status}).`);
}

export interface OAuthTokens {
  accessToken: string;
  /** Null when the provider did not rotate it (Google usually does not): keep the old one. */
  refreshToken: string | null;
  expiresAt: string;
}

/** Busy time, as instants. The sync stores these and nothing else (no titles, no attendees). */
export interface BusyBlock {
  startsAt: string;
  endsAt: string;
  /** A stable key for the row: the provider's event id where there is one. */
  key: string;
}

export interface CalendarSummary {
  id: string;
  name: string;
  primary: boolean;
  /** May bookings be written here? (A read-only shared calendar can block times, not hold events.) */
  canWrite: boolean;
}

/** The event we put on a host's calendar for one booking. */
export interface CalendarEventInput {
  title: string;
  description: string;
  location: string | null;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  /** The customer, as a guest. Null = no email on the booking, so nobody is invited. */
  attendee: { email: string; name: string } | null;
  /** Ask the provider for its own video link on this event (Meet on Google, Teams on Microsoft). */
  withVideo: boolean;
  /** Idempotency key for Google's conference request: the meeting id. */
  requestId: string;
}

export interface CreatedEvent {
  id: string;
  /** The Meet or Teams join link when one was asked for and made; null otherwise. */
  joinUrl: string | null;
}

/** Only an https link may come back out: it lands in a customer's email and a calendar invite. */
export function safeJoinUrl(u: unknown): string | null {
  const s = typeof u === "string" ? u.trim() : "";
  return s.toLowerCase().startsWith("https://") && s.length <= 500 ? s : null;
}
