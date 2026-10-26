// _shared/walletReceipt.ts — the email a builder gets after a top-up they did not press (317).
//
// The auto top-up agreement says "I will get an email receipt for each charge", and the card
// networks expect a cardholder to hear about every merchant-initiated charge on a stored card. So
// every MIT top-up (automatic, or an operator's the builder did not ask for) sends one, to the
// tenant's OWNERS: billing is the owners' area, and an admin without Billing should not learn the
// card's last 4 from their inbox.
//
// NEVER THROWS, never blocks the money path: the charge has already happened and been credited
// when this runs. The outcome is written onto the attempt row (receipt_sent_at / receipt_error)
// so "did they get a receipt?" has an answer, and a miss is filed in app_errors.
//
// Platform mail, on the platform's Resend key: the same gate and sender as shop-checkout's builder
// notices (PLATFORM_EMAIL_DOMAIN_READY + RESEND_API_KEY). Not ledgered in email_sends, which is the
// tenant's own business mail (customer-auth's reasoning for its sign-in codes).

import { rsSendEmail, resendConfigured, ResendApiError } from "./resend.ts";
import { logEdgeError } from "./logError.ts";
import { cofMoney } from "./cofConsent.ts";

const RECEIPT_FROM = "StructureStudio <no-reply@mail.structurestudiosuite.com>";
const MAX_RECIPIENTS = 5;
const RECEIPT_MS = 8_000;

export type ReceiptInput = {
  amountCents: number;
  balanceCents: number | null;
  last4: string | null;
  saleTxn: string | null;
  at: Date;
  /** Automatic (the balance fell below thresholdCents) or an operator charge. */
  trigger: "auto" | "operator";
  thresholdCents?: number | null;
  /** The card was charged but the wallet credit failed; support is putting it right. */
  pendingCredit?: boolean;
};

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]!));

/** The message itself. Pure, so the wording is testable without a provider. */
export function topupReceiptEmail(i: ReceiptInput): { subject: string; text: string; html: string } {
  const amount = cofMoney(i.amountCents);
  const card = i.last4 && /^\d{4}$/.test(i.last4) ? `your card ending ${i.last4}` : "your card on file";
  const when = i.at.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "America/Chicago" });
  const why = i.trigger === "auto"
    ? `your available wallet balance fell below ${i.thresholdCents ? cofMoney(i.thresholdCents) : "your top-up threshold"}, so your automatic top-up ran`
    : "CSM Synergy added funds to your wallet for you";
  const lines = [
    i.pendingCredit
      ? `We charged ${card} ${amount} on ${when} for your StructureStudio wallet. It has not shown up in your balance yet: CSM Synergy has been told and will add it. Please do not add the same funds again.`
      : `We charged ${card} ${amount} on ${when} and added it to your StructureStudio wallet.`,
    `Why: ${why}.`,
    ...(i.balanceCents != null && !i.pendingCredit ? [`Wallet balance now: ${cofMoney(i.balanceCents)}.`] : []),
    ...(i.saleTxn ? [`Reference: ${i.saleTxn}`] : []),
    "",
    ...(i.trigger === "auto" ? ["To change or turn off automatic top-ups, open Billing > Wallet in StructureStudio."] : []),
    "Didn't expect this charge, or have a question about it? Email support@csmsynergy.com.",
  ];
  const subject = `Receipt: ${amount} ${i.trigger === "auto" ? "automatic " : ""}wallet top-up`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1E293B;max-width:560px">`
    + lines.map((l) => (l ? `<p style="margin:0 0 10px">${esc(l)}</p>` : "")).join("")
    + `</div>`;
  return { subject, text: lines.join("\n"), html };
}

// deno-lint-ignore no-explicit-any
type Admin = any;

export type ReceiptDeps = { send?: typeof rsSendEmail; configured?: () => boolean; log?: typeof logEdgeError; fn?: string };

/** Send the receipt to the tenant's owners and record the outcome on the attempt row. */
export async function sendTopupReceipt(
  admin: Admin,
  clientId: string,
  attemptId: string | number | null,
  input: ReceiptInput,
  req: Request | null = null,
  deps: ReceiptDeps = {},
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
        const { data: users } = await admin.from("client_users").select("user_id, role")
          .eq("client_id", clientId).eq("role", "owner");
        const emails = await Promise.all((users ?? []).slice(0, MAX_RECIPIENTS * 2).map(async (u: { user_id: string }) => {
          try { const { data } = await admin.auth.admin.getUserById(u.user_id); return String(data?.user?.email ?? "").trim().toLowerCase(); } catch { return ""; }
        }));
        const to = [...new Set(emails.filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)))].slice(0, MAX_RECIPIENTS);
        if (!to.length) return { sent: 0, error: "no owner email on file" };
        const mail = topupReceiptEmail(input);
        const results = await Promise.allSettled(to.map((addr) => send({
          from: RECEIPT_FROM, to: addr, subject: mail.subject, html: mail.html, text: mail.text,
          tags: [{ name: "kind", value: "wallet_receipt" }, { name: "client_id", value: clientId }],
        })));
        const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
        if (!failed.length) return { sent: to.length, error: null };
        // Resend's message can echo the recipient, so only its status/name travels.
        const why = [...new Set(failed.map((r) => r.reason instanceof ResendApiError ? `resend ${r.reason.status}/${r.reason.name_ || "unknown"}` : "send failed"))];
        return { sent: to.length - failed.length, error: `${failed.length} of ${to.length} not sent: ${why.join(", ")}` };
      })(),
      new Promise<{ sent: number; error: string }>((resolve) => {
        timer = setTimeout(() => resolve({ sent: 0, error: "timed out waiting for the email provider" }), RECEIPT_MS);
      }),
    ]);
  } catch (_) {
    outcome = { sent: 0, error: "receipt failed unexpectedly" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (attemptId != null) {
    await admin.from("billing_charge_attempts").update(outcome.sent > 0
      ? { receipt_sent_at: new Date().toISOString(), receipt_error: outcome.error }
      : { receipt_error: (outcome.error ?? "not sent").slice(0, 300) }).eq("id", attemptId)
      .then(() => undefined, () => undefined);
  }
  if (outcome.sent === 0) {
    await log({
      fn: deps.fn ?? "wallet-autotopup", req, clientId, code: "wallet_receipt_unsent",
      message: `top-up receipt not emailed (attempt ${attemptId ?? "?"}): ${outcome.error ?? "not sent"}`,
    }).catch(() => {});
  }
  return outcome;
}
