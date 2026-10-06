// Email in the apps' conversations: what GET /threads/:key says about a contact's email, and
// whether the person reading it can send one from there (plan: unified conversation, section 1).
//
// reads.ts does the reading and the scope checks; this file only shapes rows and decides. Mail
// is SENT through portal-settings `crm_send_email`, never here, so `compose` is advice for the
// composer: the portal action re-checks every rule below before anything goes out.
//
// Bodies are PLAIN TEXT, always. Mail that arrived with no text part is turned into text here,
// and the apps render it as text, never as HTML, so nothing a sender put in an email can run
// or load anything in the app.

import { senderVerifiedFrom } from "../../../supabase/functions/_shared/crmFeed.ts";

/** Every email kind a conversation shows. `login_code` (sign-in codes) never is. */
export const THREAD_EMAIL_KINDS = ["conversation", "test", "estimate", "invoice", "change_order", "acceptance"];
/** The kinds that move a conversation up the list: what someone wrote, not paperwork. */
export const LIST_EMAIL_KINDS = ["conversation", "test"];
/** Newest rows read per table for one conversation (as crmFeed reads them). */
export const EMAIL_PAGE = 80;
/** Characters of one body handed to the apps. The rest stays in Structure Studio. */
export const EMAIL_BODY_CAP = 8000;

/** migration 261 adds body_text, sent_by and client_temp_id; 262 adds opened_at (delivered_at is
 *  107's). */
export const SEND_COLS = "id, kind, subject, status, created_at, to_email, intended_email, body_text, sent_by, client_temp_id, delivered_at, opened_at";
/** The same read without 262's opened_at, for a database 262 has not reached yet (reads.ts asks
 *  again with this on "no such column", so the thread still opens; its emails just never read
 *  "opened"). */
export const SEND_COLS_BEFORE_262 = "id, kind, subject, status, created_at, to_email, intended_email, body_text, sent_by, client_temp_id, delivered_at";
/** body_html is left out on purpose: it is read again, by id, only for mail with no text part. */
export const INBOUND_COLS = "id, from_email, from_name, subject, body_text, received_at, spam_verdict";

export interface EmailSendRow {
  id: string;
  kind: string;
  subject: string | null;
  status: string | null;
  created_at: string;
  to_email: string | null;
  intended_email: string | null;
  body_text?: string | null;
  sent_by?: string | null;
  client_temp_id?: string | null;
  delivered_at?: string | null;
  /** Migration 262: the earliest open Resend reported. Absent on a read from before 262. */
  opened_at?: string | null;
}

export interface EmailInboundRow {
  id: string;
  from_email: string | null;
  from_name: string | null;
  subject: string | null;
  body_text: string | null;
  received_at: string;
  spam_verdict: string | null;
}

export interface ThreadEmail {
  id: string;
  direction: "in" | "out";
  at: string;
  kind: string;
  subject: string;
  body: string | null;
  body_truncated: boolean;
  status: "sending" | "sent" | "delivered" | "opened" | "failed" | null;
  /** Sent mail only: when the customer first opened it (migration 262), else null. */
  opened_at: string | null;
  sent_by: string | null;
  client_temp_id: string | null;
  from: { name: string | null; email: string } | null;
  to_email: string | null;
  sender_verified: boolean | null;
}

export type EmailBlock = "unknown_number" | "no_edit" | "no_crm" | "not_set_up" | "no_address";

export interface Compose {
  email_to: string | null;
  email_block: EmailBlock | null;
}

// ── bodies ──────────────────────────────────────────────────────────────────────────

// A Map, not an object literal: "&constructor;" must not find Object.prototype.
const ENTITIES = new Map([["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", '"'], ["apos", "'"], ["nbsp", " "]]);

function decodeEntity(whole: string, name: string): string {
  if (name[0] === "#") {
    const hex = name[1] === "x" || name[1] === "X";
    const n = parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
    // A code point that isn't one (or a NUL) is left exactly as written.
    return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
  }
  return ENTITIES.get(name.toLowerCase()) ?? whole;
}

/**
 * An HTML-only email as readable text: comments and style, script and title blocks dropped,
 * line breaks kept where the layout had them, every other tag removed, the basic entities
 * decoded (in ONE pass, so "&amp;lt;" stays "&lt;"), and whitespace collapsed.
 *
 * Only blocks whose end tag HTML requires are dropped whole. <head> is not one of them (its end
 * tag may be left out), so it is stripped tag by tag like the rest, or a mail that omits it
 * would lose its whole body.
 *
 * Every pattern stops at the next "<" or matches to the end, so a sender's malformed markup
 * costs one pass over the string, never a pass per "<".
 */
export function htmlToText(html: string): string {
  return String(html ?? "")
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<(script|style|title)(?:\s[^<>]*)?>[\s\S]*?(?:<\/\1\s*>|$)/gi, "")
    .replace(/<(?:br|\/(?:p|div|tr|li|h[1-6]|blockquote|table))(?:\s[^<>]*)?\/?>/gi, "\n")
    .replace(/<\/t[dh]\s*>/gi, " ")
    // A tag starts with a letter, "/", "!" or "?": "1 < 2 and 3 > 2" is words, not a tag.
    .replace(/<[a-z!\/?][^<>]*>/gi, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, decodeEntity)
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A body cut to EMAIL_BODY_CAP, never through the middle of an emoji. */
export function capBody(text: string): { body: string; truncated: boolean } {
  if (text.length <= EMAIL_BODY_CAP) return { body: text, truncated: false };
  let body = text.slice(0, EMAIL_BODY_CAP);
  if (/[\uD800-\uDBFF]$/.test(body)) body = body.slice(0, -1);
  return { body, truncated: true };
}

/** Has this text part anything in it? Mail with an empty one is read as HTML instead. */
export function hasText(v: string | null | undefined): v is string {
  return typeof v === "string" && v.trim() !== "";
}

// ── rows ────────────────────────────────────────────────────────────────────────────

/**
 * The ledger's status for the apps, now that Resend's delivery events are recorded (migration 262):
 * claimed → "sending"; sent → "sent"; delivered → "delivered"; opened at least once → "opened",
 * whether or not the delivery receipt arrived (one can go missing while the open still lands);
 * failed or bounced → "failed". A bounce stays "failed" even after an open: it is the thing to act on.
 *
 * A spam complaint is not a status at all: migration 262 keeps it in complained_at and leaves the
 * status alone, because the email ARRIVED. So it reads "delivered" or "opened" here, which is true,
 * and the portal is where the complaint itself is shown (crmFeed's "Marked as spam").
 *
 * "delivered" and "opened" are new to the apps. An app built before them shows anything it does
 * not know as "Sent" (phone repo threads.ts statusLabel), which is still true of both — and why a
 * bounce is NOT given a word of its own here: an older app would show "Sent" for it.
 */
export function sendStatus(status: string | null | undefined, openedAt?: string | null): ThreadEmail["status"] {
  switch (status) {
    case "claimed": return "sending";
    case "sent":
    case "delivered": return openedAt ? "opened" : status;
    case "failed":
    case "bounced": return "failed";
    default: return null;
  }
}

/**
 * One email we sent. `to_email` is who it was meant for: under a tenant's beta redirect the
 * ledger's to_email is the redirect address and intended_email is the customer. A send from
 * before migration 261 kept no words, so its body is null and the apps show the subject alone.
 */
export function sentEmail(r: EmailSendRow): ThreadEmail {
  const text = hasText(r.body_text) ? capBody(r.body_text) : null;
  return {
    id: r.id,
    direction: "out",
    at: r.created_at,
    kind: r.kind,
    subject: r.subject ?? "",
    body: text?.body ?? null,
    body_truncated: text?.truncated ?? false,
    status: sendStatus(r.status, r.opened_at),
    opened_at: r.opened_at ?? null,
    sent_by: r.sent_by ?? null,
    client_temp_id: r.client_temp_id ?? null,
    from: null,
    to_email: r.intended_email ?? r.to_email ?? null,
    sender_verified: null,
  };
}

/**
 * One email the customer sent. It is part of the conversation, so its kind is "conversation".
 * `html` is the stored body_html, read only when the text part is empty.
 * `sender_verified` is crmFeed's three states: false is a caution, null is "nothing to say".
 */
export function receivedEmail(r: EmailInboundRow, html?: string | null): ThreadEmail {
  const raw = hasText(r.body_text) ? r.body_text : html ? htmlToText(html) : "";
  const text = raw ? capBody(raw) : null;
  return {
    id: r.id,
    direction: "in",
    at: r.received_at,
    kind: "conversation",
    subject: r.subject ?? "",
    body: text?.body ?? null,
    body_truncated: text?.truncated ?? false,
    status: null,
    opened_at: null,
    sent_by: null,
    client_temp_id: null,
    from: r.from_email ? { name: r.from_name ?? null, email: r.from_email } : null,
    to_email: null,
    sender_verified: senderVerifiedFrom(r.spam_verdict),
  };
}

/** Both directions, oldest first like `messages`. `html` maps an inbound id to its body_html. */
export function threadEmails(sent: EmailSendRow[], received: EmailInboundRow[], html: Map<string, string>): ThreadEmail[] {
  const all = [...sent.map(sentEmail), ...received.map((r) => receivedEmail(r, html.get(r.id)))];
  return all.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The PostgREST `or` that finds a contact's email: rows stamped with the contact, and rows
 * about any of their designs (quotes and invoices are keyed on the design, not the person).
 * Each code is quoted, so a character PostgREST reserves can't change the filter.
 */
export function contactEmailFilter(contactId: string, codes: (string | null | undefined)[]): string {
  const quoted = [...new Set(codes.filter((v): v is string => typeof v === "string" && v !== ""))]
    .map((v) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  return [`contact_id.eq.${contactId}`, ...(quoted.length ? [`short_code.in.(${quoted.join(",")})`] : [])].join(",");
}

// ── compose ─────────────────────────────────────────────────────────────────────────

/** The contact's address when it is one crm_send_email would send to (its own check), else null. */
export function emailAddress(v: string | null | undefined): string | null {
  const t = String(v ?? "").trim();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t) ? t : null;
}

export interface EmailSettings {
  email_provider: string | null;
  invoice_in_ghl: boolean | null;
  email_domain_status: string | null;
}

/**
 * Is email switched on for this company? Its own domain is verified, and either it moved its
 * email to Structure Studio or it runs in paperwork mode (invoice_in_ghl = false), where
 * sendTenantEmail treats it as opted in. A missing settings row is not set up.
 */
export function emailSendingReady(s: EmailSettings | null): boolean {
  if (!s) return false;
  return (s.email_provider === "resend" || s.invoice_in_ghl === false) && s.email_domain_status === "verified";
}

/**
 * Why this person can't email this contact from the thread, or null when they can. The first
 * that applies wins, in the order the plan gives. The apps word each one (phone repo compose.ts).
 * An unknown number is decided by the caller: it has no contact to ask about.
 */
export function emailBlock(f: { canEdit: boolean; crmPaid: boolean; settings: EmailSettings | null; address: string | null }): EmailBlock | null {
  if (!f.canEdit) return "no_edit";
  if (!f.crmPaid) return "no_crm";
  if (!emailSendingReady(f.settings)) return "not_set_up";
  if (!f.address) return "no_address";
  return null;
}
