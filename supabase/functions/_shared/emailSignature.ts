// _shared/emailSignature.ts — a person's own email signature, and how it goes on an email.
//
// WHY THIS EXISTS. Carolyn, 2026-10-01: "The other thing that is like super, super important in
// this is to be able to set up email signatures in the settings ... if I'm sitting here typing a
// message, I want to see my signature right here." One signature PER PERSON (each rep has their
// own), kept in client_users.prefs.emailSignature and edited in My Profile.
//
// TWO SHAPES, AND WHICH ONE A PERSON HAS DECIDES EVERYTHING HERE.
//
// v1 (2026-10-01) was PLAIN TEXT, NEVER HTML: the signature was typed into a box, and the HTML
// half of the email got it escaped with its line breaks turned into <br>, so nobody's signature
// could carry markup, a tracking image or a script into a customer's inbox. That paragraph ended
// "A logo or a link in a signature is a later feature, and it needs its own sanitiser rather than
// a loosening of this."
//
// v2 (2026-11-01) is that later feature, and it was built the way that sentence demanded.
// Carolyn, pasting her own signature in: "We need rich text / html for signatures. I tried to
// paste this in for my signature and it doesn't work." So a signature may now be RICH — a
// headshot, fonts, colours, links, a rule, a grey disclaimer — and it is held to its OWN
// sanitiser, _shared/emailSignatureHtml.ts, whose allow-list is written for signatures alone.
// cleanRichText (emailBlocks.ts), which guards every builder-authored email template, was NOT
// widened to do this and must not be; emailSignatureHtml.test.ts fails if anyone widens it.
//
// ⚠️ THE TWO SHAPES LIVE IN TWO SEPARATE PREFS KEYS, and that is the whole backward-compatibility
// story: `emailSignature` (plain text, every rep who has not opened the new editor) and
// `emailSignatureHtml` (the rich one). A rich save writes BOTH — the HTML, and the plain-text
// twin DERIVED from it server-side — so the text/plain half of the email and the email_sends
// ledger copy always have words. Nothing sniffs a stored value for tags: thousands of legitimate
// plain-text signatures contain "<" and "&" ("Jane <jane@acme.com>", "Sales & Service"), and any
// heuristic over customer data mangles those silently, in a customer's inbox, in one direction or
// the other. With no `emailSignatureHtml`, every function below behaves EXACTLY as v1 did.
//
// Applied to the emails a PERSON writes: crm_send_email (the record's Email tab and the phone app)
// and email_send_test. Not to quotes, invoices and the other document emails: they have their own
// branded template, and adding to them is a follow-up.
//
// Pure: no network, no database, no env.
//
// Pure: no network, no database, no env. The storage origin an <img src> must sit under is passed
// in by the caller, so every rule stays testable offline.
//
// ⚠️ Importers, ALL of which must be redeployed together when this changes (_shared
//    bundles PER function):
//      portal-settings/index.ts
//    This file imports _shared/emailSignatureHtml.ts, which adds NO importer of its own — that is
//    deliberate, and it is why testEmail takes a pre-rendered block rather than the cleaner
//    (emailTemplates.ts is bundled into four functions).

import { cleanSignatureHtml, signatureHtmlToText } from "./emailSignatureHtml.ts";

/** The longest signature kept, in characters (code points). The My Profile box stops at this. */
export const EMAIL_SIGNATURE_MAX = 1000;

/**
 * The signature as it is stored and sent, or null when there is none. save_prefs runs every
 * value through this on the way in, and the senders run the stored value through it again on
 * the way out, so a row written by anything else is held to the same rules.
 *
 * Line endings become \n; control characters other than newline and tab are dropped; the whole
 * thing is trimmed and cut to EMAIL_SIGNATURE_MAX. A lone half of an emoji (a cut in the wrong
 * place by whatever sent it) becomes U+FFFD, because jsonb refuses one and a refused write would
 * lose the person's other preferences with it. Anything that is not a string is "no signature".
 */
export function cleanSignature(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�")
    .trim();
  // .length counts UTF-16 units, never fewer than code points, so only a long one pays for the split.
  if (s.length > EMAIL_SIGNATURE_MAX) s = Array.from(s).slice(0, EMAIL_SIGNATURE_MAX).join("").trimEnd();
  return s ? s : null;
}

/**
 * The plain-text email with the signature under it, after the usual "-- " line (dash, dash,
 * space: the separator mail programs recognise, so a reply can leave the signature out). With no
 * signature the text comes back unchanged. A trailing newline on the text is kept at the end.
 */
export function signText(text: string, signature: string | null | undefined, html?: string | null): string {
  // A rich signature's words come from the HTML, so the text half can never drift from what the
  // customer sees. With no HTML this is byte for byte what v1 did.
  const sig = html ? cleanSignature(signatureHtmlToText(html)) : cleanSignature(signature);
  if (!sig) return text;
  const tail = /\n$/.test(text) ? "\n" : "";
  return `${text.replace(/\s+$/, "")}\n\n-- \n${sig}${tail}`;
}

const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The signature as a block for the HTML half. Empty string with no signature, so it can be
 * appended unconditionally.
 *
 * PLAIN (no `html`): escaped, each line break a <br>, a little space above it and a softer colour
 * than the message — byte for byte v1's output, which is what keeps every existing rep's emails
 * identical and what emailSignature.test.ts still asserts.
 *
 * RICH (`html` given): the stored, already-sanitised signature inside a wrapper that carries
 * margin and a width guard ONLY. No font, size or colour on the wrapper: the signature brings its
 * own, and an inherited #475569 would fight a pasted one. max-width keeps a wide pasted table
 * from blowing out a phone client.
 */
export function signatureHtml(signature: string | null | undefined, html?: string | null): string {
  if (html) {
    const rich = cleanSignatureHtml(html, signatureImageOrigin());
    if (rich) return `<div style="margin-top:16px;max-width:100%">${rich}</div>`;
    // A stored value the cleaner now refuses falls back to the words rather than to nothing.
  }
  const sig = cleanSignature(html ? signatureHtmlToText(html) : signature);
  if (!sig) return "";
  return `<div style="margin-top:16px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;line-height:1.5;color:#475569">${esc(sig).replace(/\n/g, "<br>")}</div>`;
}

/**
 * The project origin an <img src> in a signature must sit under. Read from the environment here
 * rather than passed down from every call site; the cleaner itself stays pure and takes it as an
 * argument, so the rules are testable offline.
 */
export function signatureImageOrigin(): string {
  try { return (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get("SUPABASE_URL") || ""; }
  catch { return ""; }
}

/**
 * ONE place that reads a person's prefs and answers both shapes, so the precedence rule — rich
 * when there is one, else the plain text — exists exactly once. Both send sites and get_profile
 * go through it.
 *
 * `text` is always words a customer could read: derived from the HTML when there is HTML, so the
 * text/plain half and the email_sends ledger copy can never show tags.
 */
export function signaturePair(prefs: unknown): { text: string | null; html: string | null } {
  const p = (prefs && typeof prefs === "object" ? prefs : {}) as Record<string, unknown>;
  const html = cleanSignatureHtml(p.emailSignatureHtml, signatureImageOrigin());
  if (html) return { text: cleanSignature(signatureHtmlToText(html)), html };
  return { text: cleanSignature(p.emailSignature), html: null };
}
