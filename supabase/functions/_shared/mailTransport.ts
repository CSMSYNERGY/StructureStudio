/**
 * Which wire an email goes out on: Resend or Amazon SES.
 *
 * WHY THIS FILE EXISTS (2026-11-10). Email is moving from Resend to Amazon SES, and it cannot
 * move in one flip: a builder whose domain is verified at Resend must keep sending through
 * Resend until the same domain verifies at SES. So the wire is chosen PER SEND, from two things:
 *
 *   1. The builder's own pin, client_settings.email_transport ('resend' | 'ses' | NULL). A
 *      builder who holds a domain at a provider is pinned to that provider, and only an
 *      operator's cutover moves the pin.
 *   2. The platform default, the EMAIL_DEFAULT_TRANSPORT setting, for everyone with no pin and
 *      for mail that belongs to no builder's domain (login codes, receipts, team notes: the
 *      "platform senders" that call sendPlatformMail). Read on every request, so changing it
 *      needs no deploy, and changing it back is the rollback.
 *
 * Both leaves (resend.ts, ses.ts) stay untouched by each other. This file is the only place
 * that knows there are two, so the day Resend is cancelled the change is here and in the
 * imports, not across fifteen callers.
 *
 * ⚠️ THE DEFAULT ONLY BECOMES 'ses' WHEN SES CAN ACTUALLY SEND. A setting that says `ses` on a
 * deployment with no SES key would otherwise turn every login code and receipt into "platform
 * email is not configured". So an unconfigured SES leaves the default on Resend, and the
 * setting takes effect the moment the key is there.
 */

import { rsSendEmail, resendConfigured, ResendApiError, type RsSendInput } from "./resend.ts";
import { sesSendEmail, sesConfigured, SesApiError } from "./ses.ts";

export type MailTransport = "resend" | "ses";

/** One outgoing email, whichever wire carries it. `idempotencyKey` reaches Resend only: SES has
 *  no such thing (see ses.ts), and a caller that retries on SES must check its own ledger. */
export type MailInput = RsSendInput;

/** The platform default wire. See the header for why 'ses' needs a configured SES. */
export function defaultTransport(): MailTransport {
  const want = (Deno.env.get("EMAIL_DEFAULT_TRANSPORT") ?? "").trim().toLowerCase();
  return want === "ses" && sesConfigured() ? "ses" : "resend";
}

/** The wire for one builder: their pin when they have one, the platform default otherwise.
 *  Anything that is not exactly 'resend' or 'ses' (NULL, a column that does not exist yet) is
 *  "no pin". */
export function transportFor(pin: unknown): MailTransport {
  return pin === "ses" || pin === "resend" ? pin : defaultTransport();
}

/**
 * A builder's pin, read off their client_settings row.
 *
 * The explicit column wins. Without it, HOLDING A DOMAIN AT A PROVIDER IS THE PIN: a builder
 * with a Resend domain id sends through Resend whatever the platform default says, and one with
 * an SES identity sends through SES. That inference is what makes flipping the default safe on
 * a database where the column was never filled in (or does not exist yet): the default can only
 * ever move builders who have nothing at either provider to lose.
 */
export function pinOf(settings: unknown): MailTransport | null {
  const s = (settings ?? {}) as Record<string, unknown>;
  if (s.email_transport === "ses" || s.email_transport === "resend") return s.email_transport;
  if (typeof s.resend_domain_id === "string" && s.resend_domain_id) return "resend";
  if (typeof s.ses_identity === "string" && s.ses_identity) return "ses";
  return null;
}

/** Can this wire send at all on this deployment (its secrets are present)? */
export function transportConfigured(t: MailTransport): boolean {
  return t === "ses" ? sesConfigured() : resendConfigured();
}

/** Is ANY wire configured? The cheapest dark guard: when neither is, nothing can send and a
 *  caller need not even read the builder's settings. */
export function anyTransportConfigured(): boolean {
  return resendConfigured() || sesConfigured();
}

/**
 * Send one email on the named wire. Returns the provider's id for it. Throws that provider's
 * own error (ResendApiError or SesApiError); read it with mailErrText / mailErrorPermanent
 * rather than with instanceof, so a caller never has to know which wire it was.
 */
export async function sendMail(t: MailTransport, input: MailInput): Promise<{ id: string }> {
  if (t === "ses") {
    // The key is left behind on purpose (SES would have nowhere to put it). Everything else is
    // the same object; ses.ts drops the one header SES refuses (Message-ID).
    const { idempotencyKey: _unused, ...rest } = input;
    return await sesSendEmail(rest);
  }
  return await rsSendEmail(input);
}

/** May a platform sender send right now? (Its callers also check PLATFORM_EMAIL_DOMAIN_READY,
 *  which says the platform address's DNS is live; that flag is about the address, this is about
 *  the wire.) */
export function platformMailConfigured(): boolean {
  return transportConfigured(defaultTransport());
}

/** Send one email from the platform's own address on the platform default wire. */
export function sendPlatformMail(input: MailInput): Promise<{ id: string }> {
  return sendMail(defaultTransport(), input);
}

/** Was this thrown by one of the two wires (as opposed to our own code)? */
export function isMailApiError(e: unknown): e is ResendApiError | SesApiError {
  return e instanceof ResendApiError || e instanceof SesApiError;
}

/**
 * A wire error as the enum-ish text a ledger or app_errors may hold: `resend 403/validation_error`,
 * `ses 400/MessageRejected`. Never the provider's message, which on both wires can name a
 * recipient's address. null for anything that is not a wire error, so a caller that must not
 * echo an arbitrary exception can say its own fixed words instead (`mailErrCode(e) ?? "send
 * failed"`, what the platform senders always did).
 */
export function mailErrCode(e: unknown): string | null {
  if (e instanceof ResendApiError) return `resend ${e.status}/${e.name_ || "unknown"}`;
  if (e instanceof SesApiError) return `ses ${e.status}/${e.name_ || "unknown"}`;
  return null;
}

/** mailErrCode, or for anything else the error's own message, capped. `fallback` is what a
 *  caller wants to say when there is no message at all. */
export function mailErrText(e: unknown, fallback = "email send failed"): string {
  return mailErrCode(e) ?? String((e as Error)?.message || e || fallback).slice(0, 300);
}

/**
 * Did the provider refuse THIS EMAIL in a way that asking again cannot change?
 *
 * A 403 is never that, on either wire: it is about the account, the key or the domain (a
 * suspended key, a sending domain that lost its DNS in a zone move), and a person fixes those
 * within hours, which is what a day of retries is for. resend.ts's own verdict calls a 403
 * permanent, so it is taken out here; ses.ts already leaves it retryable. (The 2026-11-06
 * pre-ship review is why: stopping on a 403 dropped every queued automation at the first try of
 * an afternoon's account problem.)
 */
export function mailErrorPermanent(e: unknown): boolean {
  return isMailApiError(e) && e.permanent && e.status !== 403;
}
