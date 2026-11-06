// An email to the support team for every problem report, feature request and ticket a builder sends
// from the portal (support plan step 6, migration 340). Before this, nothing told anyone a submission
// had arrived: it sat on the Projects board until somebody looked. Carolyn, 10-26: a person follows up
// within about 24 hours, "where we have to watch it", so the inbox has to hear about it.
//
// WHO GETS IT: the addresses in the SUPPORT_NOTIFY_TO secret, comma-separated, at most five. Never
// in source: this repo is public. Unset means no alert, and the submission is unaffected.
//
// GATED LIKE sendLeadAlert (leadFormMail.ts): Resend configured AND PLATFORM_EMAIL_DOMAIN_READY is
// "true", sent from the platform's own no-reply address. Bounded to 8 s, and it NEVER throws: the
// builder's submission is already saved before this runs, and an email fault must not turn a saved
// report into an error on their screen. portal-feedback hands it to EdgeRuntime.waitUntil, so the
// builder does not wait for it either.
//
// NO CONSOLE LINKS. The full-chat link of a ticket lives on its Projects item only; this email says
// where it is. Reply-To is the builder, and a reply must not carry an operator-only address to them.

import { rsSendEmail, resendConfigured } from "./resend.ts";
import { PLATFORM_NOTIFY_FROM } from "./leadFormMail.ts";
import { esc } from "./emailTemplates.ts";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_TO = 5;
const SEND_MS = 8_000;

export const KIND_LABEL: Record<string, string> = { bug: "problem report", feature: "feature request", ticket: "ticket" };

/** SUPPORT_NOTIFY_TO, parsed: valid addresses only, de-duplicated, at most five. */
export function supportRecipients(raw: string | undefined | null): string[] {
  return [...new Set(String(raw ?? "").split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter((s) => EMAIL.test(s)))].slice(0, MAX_TO);
}

export interface SupportAlert {
  kind: string;
  title: string;
  detail: string | null;
  severity: string | null;
  clientId: string;
  businessName: string | null;
  submitterName: string;
  submitterEmail: string | null;
  submissionId: string;
  /** A ticket handed off from the assistant: how many chat messages were attached to the item. */
  chatMessages?: number;
  /** And whether the item holds the "Full chat" link (only a Support board with a Conversation column). */
  chatLinked?: boolean;
}

export function supportAlertContent(a: SupportAlert): { subject: string; text: string; html: string } {
  const label = KIND_LABEL[a.kind] ?? "request";
  const who = a.businessName ? `${a.businessName} (${a.clientId})` : a.clientId;
  const subject = `New ${label} from ${who}: ${a.title}`.replace(/[\r\n]+/g, " ").slice(0, 200);
  const lines = [
    `A builder sent a ${label} from the Structure Studio portal.`,
    "",
    `Business: ${who}`,
    `From: ${a.submitterName}${a.submitterEmail ? ` <${a.submitterEmail}>` : ""}`,
    `Title: ${a.title}`,
    ...(a.severity ? [`${a.kind === "feature" ? "Importance" : "Severity"}: ${a.severity}`] : []),
    // Says WHERE the full chat is, never the link itself: Reply-To is the builder, so a reply from the
    // inbox would quote an operator-only console address back to them.
    ...(a.chatMessages ? [`Handed off from the assistant: the last ${a.chatMessages} chat messages${a.chatLinked ? " and a link to the full chat" : ""} are on the Projects item.`] : []),
    "",
    (a.detail || "(no details)").slice(0, 4000),
    "",
    `Reply from the Projects board; the builder sees it under Support > My Requests. Portal ref: ${a.submissionId}`,
    "We promised a reply within 24 hours.",
  ];
  const text = lines.join("\n");
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#1E293B">${
    lines.map((l) => (l ? `<div>${esc(l)}</div>` : "<div>&nbsp;</div>")).join("")
  }</div>`;
  return { subject, text, html };
}

/** Never throws. Returns how many went out and, when not all did, why (no addresses in it). */
export async function sendSupportAlert(a: SupportAlert, env: (k: string) => string | undefined = (k) => Deno.env.get(k)): Promise<{ sent: number; error: string | null }> {
  try {
    const to = supportRecipients(env("SUPPORT_NOTIFY_TO"));
    if (!to.length) return { sent: 0, error: "SUPPORT_NOTIFY_TO is not set" };
    if (!resendConfigured() || env("PLATFORM_EMAIL_DOMAIN_READY") !== "true") return { sent: 0, error: "platform email is not configured" };
    const c = supportAlertContent(a);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = Promise.allSettled(to.map((addr) => rsSendEmail({
      from: PLATFORM_NOTIFY_FROM, to: addr, subject: c.subject, html: c.html, text: c.text,
      ...(a.submitterEmail && EMAIL.test(a.submitterEmail) ? { replyTo: a.submitterEmail } : {}),
      tags: [{ name: "kind", value: "support_alert" }, { name: "client_id", value: a.clientId }],
    })));
    const results = await Promise.race([
      work,
      new Promise<null>((r) => { timer = setTimeout(() => r(null), SEND_MS); }),
    ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
    if (!results) return { sent: 0, error: "timed out waiting for the email provider" };
    const failed = results.filter((x) => x.status === "rejected").length;
    return { sent: to.length - failed, error: failed ? `${failed} of ${to.length} not sent` : null };
  } catch {
    return { sent: 0, error: "alert failed unexpectedly" };
  }
}
