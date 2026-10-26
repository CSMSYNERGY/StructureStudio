// The two emails a website lead form sends (migration 325), shared by the public lead-form function
// (real submissions) and portal-settings (the builder's "Send me a test").
//
//   ALERT      to the builder's own team: the recipients chosen on the form's Notifications tab, or
//              the owners and admins when none are chosen. Sent from the PLATFORM address, the
//              shop-checkout notifyBuilder pattern: it is our product telling the builder something,
//              not the builder writing to a customer, so it never lands in a contact's conversation.
//   AUTO-REPLY to the visitor, from the builder's OWN sending through sendTenantEmail (kind
//              form_autoreply): the ledger row, the builder's From and Reply-To, and beta mode's
//              redirect to their test inbox all come with it.
//
// Both are best-effort and bounded: a slow provider never holds the visitor's submit, and neither
// call ever throws to its caller. Never an email address in a log line.

import { cleanDesign, EMAIL_STARTERS, fillText, renderEmailDesign, type EmailDesign, type Tokens } from "./emailBlocks.ts";
import { rsSendEmail, resendConfigured, ResendApiError } from "./resend.ts";
import { sendTenantEmail } from "./emailSend.ts";

export const PLATFORM_NOTIFY_FROM = "StructureStudio <no-reply@mail.structurestudiosuite.com>";
const MAX_RECIPIENTS = 10;
const SEND_MS = 8_000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type Tpl = { subject: string; preheader: string; design: EmailDesign };

// deno-lint-ignore no-explicit-any
type Db = any;

/** The builder's own details for {{company.*}}. */
export type CompanyTokens = { name: string; phone: string; website: string; address: string; logoUrl: string };
export async function companyTokens(admin: Db, clientId: string): Promise<CompanyTokens> {
  const [{ data: cs }, { data: cc }] = await Promise.all([
    admin.from("client_settings").select("business_name, business_phone, business_website, business_address, business_logo_url").eq("client_id", clientId).maybeSingle(),
    admin.from("client_configs").select("company_name, logo_url").eq("client_id", clientId).maybeSingle(),
  ]);
  const a = (cs?.business_address && typeof cs.business_address === "object") ? cs.business_address as Record<string, string | null> : {};
  const address = [a.addressLine1, [a.city, a.state].filter(Boolean).join(", "), a.postalCode].filter(Boolean).join(" ").trim();
  const site = String(cs?.business_website ?? "").trim();
  return {
    name: String(cs?.business_name || cc?.company_name || "").trim(),
    phone: String(cs?.business_phone ?? "").trim(),
    website: site && !/^https?:\/\//i.test(site) ? `https://${site}` : site,
    address,
    logoUrl: /^https:\/\//i.test(String(cs?.business_logo_url || cc?.logo_url || "")) ? String(cs?.business_logo_url || cc?.logo_url) : "",
  };
}

/** A saved template of this builder's, or the built-in starter when there is none (or it was deleted). */
export async function loadTemplate(admin: Db, clientId: string, id: string | null, fallback: "autoreply" | "notification"): Promise<Tpl> {
  if (id) {
    const { data } = await admin.from("email_templates").select("subject, preheader, design").eq("client_id", clientId).eq("id", id).maybeSingle();
    if (data) return { subject: data.subject || EMAIL_STARTERS[fallback].subject, preheader: data.preheader || "", design: cleanDesign(data.design) };
  }
  const st = EMAIL_STARTERS[fallback];
  return { subject: st.subject, preheader: st.preheader, design: st.design };
}

/** Team members' sign-in emails: the chosen people, or the owners and admins when none are chosen.
 *  Only people on THIS builder's team, whatever ids arrive. */
export async function teamEmails(admin: Db, clientId: string, userIds: string[], extra: string[] = []): Promise<string[]> {
  let q = admin.from("client_users").select("user_id, role, created_at").eq("client_id", clientId);
  q = userIds.length ? q.in("user_id", userIds) : q.in("role", ["owner", "admin"]);
  const { data: users } = await q.order("created_at", { ascending: true });
  const emails = await Promise.all((users ?? []).slice(0, MAX_RECIPIENTS).map(async (u: { user_id: string }) => {
    try { const { data } = await admin.auth.admin.getUserById(u.user_id); return String(data?.user?.email ?? "").trim().toLowerCase(); } catch { return ""; }
  }));
  return [...new Set([...emails, ...extra.map((e) => e.toLowerCase())].filter((e) => EMAIL.test(e)))].slice(0, MAX_RECIPIENTS);
}

function bounded<T>(work: Promise<T>, onTimeout: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work, new Promise<T>((r) => { timer = setTimeout(() => r(onTimeout), SEND_MS); })])
    .finally(() => { if (timer !== undefined) clearTimeout(timer); });
}

export async function sendLeadAlert(clientId: string, to: string[], tpl: Tpl, tokens: Tokens, replyTo?: string): Promise<{ sent: number; error: string | null }> {
  try {
    if (!resendConfigured() || Deno.env.get("PLATFORM_EMAIL_DOMAIN_READY") !== "true") return { sent: 0, error: "platform email is not configured" };
    if (!to.length) return { sent: 0, error: "no recipient" };
    const r = renderEmailDesign(tpl.design, tokens, tpl.preheader);
    const subject = fillText(tpl.subject, tokens).replace(/[\r\n]+/g, " ").slice(0, 200) || "New website lead";
    return await bounded((async () => {
      const results = await Promise.allSettled(to.map((addr) => rsSendEmail({
        from: PLATFORM_NOTIFY_FROM, to: addr, subject, html: r.html, text: r.text,
        ...(replyTo && EMAIL.test(replyTo) ? { replyTo } : {}),
        tags: [{ name: "kind", value: "form_notification" }, { name: "client_id", value: clientId }],
      })));
      const failed = results.filter((x): x is PromiseRejectedResult => x.status === "rejected");
      if (!failed.length) return { sent: to.length, error: null };
      const why = [...new Set(failed.map((x) => x.reason instanceof ResendApiError ? `resend ${x.reason.status}` : "send failed"))];
      return { sent: to.length - failed.length, error: `${failed.length} of ${to.length} not sent: ${why.join(", ")}` };
    })(), { sent: 0, error: "timed out waiting for the email provider" });
  } catch {
    return { sent: 0, error: "alert failed unexpectedly" };
  }
}

export async function sendAutoreply(admin: Db, clientId: string, to: string, contactId: string | null, tpl: Tpl, tokens: Tokens): Promise<{ sent: boolean; reason?: string }> {
  try {
    const r = renderEmailDesign(tpl.design, tokens, tpl.preheader);
    const subject = fillText(tpl.subject, tokens).replace(/[\r\n]+/g, " ").slice(0, 200) || `Thanks from ${tokens.company?.name || "us"}`;
    const out = await bounded(
      sendTenantEmail(admin, clientId, { kind: "form_autoreply", contactId, to, subject, html: r.html, text: r.text }),
      { sent: false, reason: "failed", error: "timed out" } as Awaited<ReturnType<typeof sendTenantEmail>>,
    );
    return out.sent ? { sent: true } : { sent: false, reason: out.reason };
  } catch {
    return { sent: false, reason: "failed" };
  }
}
