// _shared/emailSignature.ts — a person's own email signature, and how it goes on an email.
//
// WHY THIS EXISTS. Carolyn, 2026-10-01: "The other thing that is like super, super important in
// this is to be able to set up email signatures in the settings ... if I'm sitting here typing a
// message, I want to see my signature right here." One signature PER PERSON (each rep has their
// own), kept in client_users.prefs.emailSignature and edited in My Profile.
//
// PLAIN TEXT, NEVER HTML. The signature is typed into a box and goes out as words. The HTML half
// of the email gets it ESCAPED, with its line breaks turned into <br>, so nobody's signature can
// carry markup, a tracking image or a script into a customer's inbox. A logo or a link in a
// signature is a later feature, and it needs its own sanitiser rather than a loosening of this.
//
// Applied to the emails a PERSON writes: crm_send_email (the record's Email tab and the phone app)
// and email_send_test. Not to quotes, invoices and the other document emails: they have their own
// branded template, and adding to them is a follow-up.
//
// Pure: no network, no database, no env.
//
// ⚠️ Importers, ALL of which must be redeployed together when this changes (_shared
//    bundles PER function):
//      portal-settings/index.ts

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
export function signText(text: string, signature: string | null | undefined): string {
  const sig = cleanSignature(signature);
  if (!sig) return text;
  const tail = /\n$/.test(text) ? "\n" : "";
  return `${text.replace(/\s+$/, "")}\n\n-- \n${sig}${tail}`;
}

const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The signature as a block for the HTML half: escaped, each line break a <br>, a little space
 * above it and a softer colour than the message. Empty string with no signature, so it can be
 * appended unconditionally.
 */
export function signatureHtml(signature: string | null | undefined): string {
  const sig = cleanSignature(signature);
  if (!sig) return "";
  return `<div style="margin-top:16px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;line-height:1.5;color:#475569">${esc(sig).replace(/\n/g, "<br>")}</div>`;
}
