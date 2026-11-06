// _shared/cardRequestEmail.ts — the note an operator sends a builder's owners asking them to put a
// card on their wallet (2026-11-05).
//
// A builder who pays for StructureStudio by bank transfer has nothing at the gateway, so their
// usage wallet has no card. An operator can never enter one (the cardholder uses the gateway's
// secure form, every card path refuses an operator's token), so the most CSM Synergy can do from
// the operator view is ASK: portal-billing's request_card_email sends this to the tenant's OWNERS
// (billing is the owners' area), at most once a day per tenant. The throttle is portal-billing's,
// on the admin_audit row it writes after a send.
//
// Same posture as walletReceipt.ts, whose owner lookup it shares: NEVER THROWS, an 8 s race, the
// platform's Resend key and sender, not ledgered in email_sends (that is the tenant's own business
// mail). No builder name, no operator name, no amounts: a plain note with the one link. The link
// is built by the caller (customerPortalUrl.ts portalWalletUrl) so this module knows no hosts.

import { rsSendEmail, resendConfigured, ResendApiError } from "./resend.ts";
import { logEdgeError } from "./logError.ts";
import { ownerEmails } from "./walletReceipt.ts";

const FROM = "StructureStudio <no-reply@mail.structurestudiosuite.com>";
const SEND_MS = 8_000;

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]!));

export type CardRequestInput = { link: string };

/** The message itself. Pure, so the wording is testable without a provider. */
export function cardRequestEmail(i: CardRequestInput): { subject: string; text: string; html: string } {
  const link = String(i.link || "").trim();
  const lines = [
    "Your StructureStudio usage wallet (calls, texts, AI photo work) has no card on file yet, so funds cannot be added to it.",
    `To add one, sign in and open Settings > Billing > Wallet, then press "Add a card": ${link}`,
    "Your bank checks the card for $0. Nothing is charged until you add funds.",
    "Only an owner, or an admin you have given Billing, can do this.",
    "",
    "Sent at CSM Synergy's request. Questions? Email support@csmsynergy.com.",
  ];
  const subject = "Please add a card to your StructureStudio wallet";
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1E293B;max-width:560px">`
    + lines.map((l) => {
      if (!l) return "";
      // The one line that carries the link gets it as a real anchor; everything else is text.
      if (l.endsWith(link) && link) {
        return `<p style="margin:0 0 10px">${esc(l.slice(0, -link.length))}<a href="${esc(link)}">${esc(link)}</a></p>`;
      }
      return `<p style="margin:0 0 10px">${esc(l)}</p>`;
    }).join("")
    + `</div>`;
  return { subject, text: lines.join("\n"), html };
}

// deno-lint-ignore no-explicit-any
type Admin = any;

export type CardRequestDeps = { send?: typeof rsSendEmail; configured?: () => boolean; log?: typeof logEdgeError; fn?: string };

/** Send the note to the tenant's owners. Resolves with how many got it; never throws. */
export async function sendCardRequestEmail(
  admin: Admin,
  clientId: string,
  input: CardRequestInput,
  req: Request | null = null,
  deps: CardRequestDeps = {},
): Promise<{ sent: number; error: string | null }> {
  const send = deps.send ?? rsSendEmail;
  const configured = deps.configured ?? (() => resendConfigured() && Deno.env.get("PLATFORM_EMAIL_DOMAIN_READY") === "true");
  const log = deps.log ?? logEdgeError;
  let outcome: { sent: number; error: string | null } = { sent: 0, error: "not attempted" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    outcome = await Promise.race([
      (async () => {
        if (!configured()) return { sent: 0, error: "platform email is not configured" };
        const to = await ownerEmails(admin, clientId);
        if (!to.length) return { sent: 0, error: "no owner email on file" };
        const mail = cardRequestEmail(input);
        const results = await Promise.allSettled(to.map((addr) => send({
          from: FROM, to: addr, subject: mail.subject, html: mail.html, text: mail.text,
          tags: [{ name: "kind", value: "card_request" }, { name: "client_id", value: clientId }],
        })));
        const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
        if (!failed.length) return { sent: to.length, error: null };
        // Resend's message can echo the recipient, so only its status/name travels.
        const why = [...new Set(failed.map((r) => r.reason instanceof ResendApiError ? `resend ${r.reason.status}/${r.reason.name_ || "unknown"}` : "send failed"))];
        return { sent: to.length - failed.length, error: `${failed.length} of ${to.length} not sent: ${why.join(", ")}` };
      })(),
      new Promise<{ sent: number; error: string }>((resolve) => {
        timer = setTimeout(() => resolve({ sent: 0, error: "timed out waiting for the email provider" }), SEND_MS);
      }),
    ]);
  } catch (_) {
    outcome = { sent: 0, error: "card request failed unexpectedly" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (outcome.sent === 0) {
    // The operator is told in the response; this row is for the pattern ("every tenant says
    // no owner email") rather than the one click. A missing provider is the product declining.
    await log({
      fn: deps.fn ?? "portal-billing", req, clientId, code: "card_request_unsent",
      message: `add-a-card reminder not emailed: ${outcome.error ?? "not sent"}`,
      severity: outcome.error === "platform email is not configured" ? "info" : "error",
    }).catch(() => {});
  }
  return outcome;
}
