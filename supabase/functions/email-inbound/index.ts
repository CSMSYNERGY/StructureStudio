import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { logEdgeError, withErrorLog } from "../_shared/logError.ts";
import {
  timingSafeEqual, parseAddress, messageIds, stripQuoted, parseReplyToken,
  envelopeRecipients, parseThreadMessageId,
} from "../_shared/emailInbound.ts";

// Inbound email → the CRM conversation. The return leg that makes a conversation two-way.
//
// Carolyn asked for a conversations tab that shows "my emails and only emails in a quick and
// easy way" (2026-08-21). Until this existed the record page showed only what we SENT — a
// customer's reply went to a staff member's own inbox and disappeared from the product,
// which makes a conversation a monologue.
//
// AUTH: the provider posts server-to-server and cannot send a Supabase JWT, so this deploys
// with verify_jwt = false and authenticates on a shared secret in the URL
// (?key= ⇄ EMAIL_INBOUND_SECRET) compared in constant time — the postmark-events /
// feedback-monday-webhook pattern. An UNSET secret refuses everything with a 401: until the
// secret is minted this function is deliberately inert, and "refuse everything" is the right
// inert state. A webhook that accepted unauthenticated posts because configuration was
// missing would be an open write path into a customer-visible conversation — someone could
// forge a message from a customer onto a builder's record page.
//
// ALWAYS 200 ONCE AUTHENTICATED. Providers retry non-2xx and eventually disable a webhook
// that keeps failing, so a non-2xx is reserved for failures a retry can actually fix. An
// unparseable payload, an unknown tenant, an unmatchable thread — none of those improve on
// the second attempt, and a retry storm helps nobody.
//
// ⚠️ THE TENANT COMES FROM THE SMTP ENVELOPE AND NOTHING ELSE. Stage A below may read only
// envelopeRecipients(); the `To:` header, the reply token, a Message-ID and the sender
// address are all attacker-controlled and may only narrow WITHIN a tenant already proved
// (stage B). Collapsing the two stages is how a stranger writes onto a builder's record.
//
// ⚠️ THIS FUNCTION MUST NEVER SEND MAIL. It stores a row and returns 200. An auto-reply, a
// forward or a generated bounce would turn a spam run at a published reply address into US
// mailing strangers, and the complaints would land on the shared sending account that every
// other builder depends on. That property is currently free; keep it deliberate.
//
// ⚠️ AN UNMATCHED REPLY IS STILL STORED. That is the load-bearing decision in this file. A
// customer's words are worth more than our ability to file them: an unfiled row is visible
// to an operator and can be re-linked, a dropped one is gone forever. email_inbound_unmatched_idx
// exists for exactly that query.
//
// Never echo the payload back in a response or an error — inbound mail is customer content,
// and webhook responses are visible in the provider's dashboard.
//
// Required secrets: EMAIL_INBOUND_SECRET (+ the platform SUPABASE_* pair).

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(withErrorLog("email-inbound", async (req: Request) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const secret = Deno.env.get("EMAIL_INBOUND_SECRET") ?? "";
  const key = new URL(req.url).searchParams.get("key") ?? "";
  // Unset secret ⇒ refuse everything. Deliberately inert, never open.
  if (!secret || !timingSafeEqual(key, secret)) return json({ error: "unauthorized" }, 401);

  let payload: any;
  try { payload = await req.json(); } catch { return json({ ok: true, ignored: "unparseable" }); }

  // Providers wrap the message differently (`data`, `email`, or the root). Take the first
  // shape that carries a sender rather than hard-coding one vendor's envelope.
  const m = payload?.data ?? payload?.email ?? payload ?? {};
  const from = parseAddress(m.from ?? m.sender ?? m.From);
  if (!from.email || !from.email.includes("@")) return json({ ok: true, ignored: "no sender" });

  // Display only. NEVER used to choose a tenant — see envelopeRecipients' header comment.
  const toRaw = Array.isArray(m.to) ? m.to[0] : (m.to ?? m.To ?? m.recipient);
  const to = parseAddress(toRaw);
  const envelope = envelopeRecipients(payload, m);

  const headers = (m.headers && typeof m.headers === "object") ? m.headers as Record<string, unknown> : {};
  const hdr = (name: string) => {
    const k = Object.keys(headers).find((h) => h.toLowerCase() === name);
    return k ? String(headers[k] ?? "") : "";
  };
  const inReplyTo = String(m.in_reply_to ?? m.inReplyTo ?? hdr("in-reply-to") ?? "");
  const referencesRaw = String(m.references ?? hdr("references") ?? "");
  const ownMessageId = messageIds(m.message_id ?? m.messageId ?? hdr("message-id"))[0] ?? null;

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  // ── THREADING ──────────────────────────────────────────────────────────────────────
  //
  // TWO STAGES, AND THE ORDER IS THE SECURITY PROPERTY. Stage A picks the TENANT and may
  // use only the SMTP envelope — the one field a sender cannot forge. Stage B picks the
  // design/contact WITHIN that tenant and may use anything, because by then the blast
  // radius is one account that genuinely received the mail.
  //
  // It used to be one stage, and every signal could assign client_id. That was wrong twice
  // over: the `To:` header is written by the sender, and the In-Reply-To join ran with no
  // tenant filter at all, so a Message-ID (which every recipient of the original mail holds)
  // could pull a forged message into someone else's account. Short codes and Message-IDs are
  // capabilities for READING; neither is a capability for writing to a builder's record.
  let clientId: string | null = null;
  let contactId: string | null = null;
  let shortCode: string | null = null;
  let matchedRecipient = "";

  // ── STAGE A: the tenant, from the envelope, and from nothing else. ────────────────
  // An inbound_domain must also be ACTIVE. A tenant who has typed the domain but not yet
  // proved MX control is in `pending`, and that is precisely the state an attacker would
  // aim at — the outbound side already gates on this (portal-settings' Reply-To stamping)
  // and the webhook must agree with it.
  const envDomains = envelope.map((e) => e.split("@")[1] ?? "").filter(Boolean);
  if (envDomains.length) {
    const { data: inb } = await admin.from("client_settings")
      .select("client_id, inbound_domain")
      .in("inbound_domain", envDomains).eq("inbound_status", "active").limit(1);
    const hit = (inb ?? [])[0] as { client_id: string; inbound_domain: string } | undefined;
    if (hit) {
      clientId = hit.client_id;
      matchedRecipient = envelope.find((e) => e.endsWith("@" + hit.inbound_domain)) ?? "";
    }
    if (!clientId) {
      // The tenant's SENDING domain. Lands an unmatched row on the right account when a
      // stranger writes to a published address rather than to a reply token.
      const { data: snd } = await admin.from("client_settings")
        .select("client_id, email_domain")
        .in("email_domain", envDomains).limit(1);
      const s = (snd ?? [])[0] as { client_id: string; email_domain: string } | undefined;
      if (s) {
        clientId = s.client_id;
        matchedRecipient = envelope.find((e) => e.endsWith("@" + s.email_domain)) ?? "";
      }
    }
  }

  if (!clientId) {
    // Nothing to attach it to at all. Log it so it is visible, and 200 so the provider does
    // not retry something a retry cannot fix.
    await logEdgeError({
      fn: "email-inbound", req, clientId: null, code: "inbound_no_tenant",
      message: "Inbound email could not be attributed to a tenant.",
      context: {
        hasInReplyTo: Boolean(inReplyTo),
        // Shapes only, never addresses — this row is read by operators and inbound mail is
        // customer content. The count alone separates "provider sent no envelope" (a wiring
        // bug on our side) from "envelope present, domain unknown" (mail we should ignore).
        envelopeCount: envelope.length,
        envelopeDomains: envDomains.length,
      },
    });
    return json({ ok: true, ignored: "no tenant" });
  }

  // ── STAGE B: which design/contact, WITHIN the tenant Stage A already proved. ──────
  // Every branch below is scoped to `clientId`. None of them may widen it.

  // B1. The reply token in the address it actually arrived at. Strongest signal: we chose
  //     that address when we sent, so there is nothing to infer, and it survives the header
  //     mangling that Outlook does to References.
  const token = parseReplyToken(matchedRecipient);
  if (token) {
    if (token.kind === "design") {
      // Only if the design really belongs to this tenant. Short codes are guessable-ish and
      // appear in forwarded quote links, so this filter is load-bearing, not decoration.
      const { data: d } = await admin.from("designs")
        .select("contact_id, short_code")
        .eq("short_code", token.id).eq("client_id", clientId).maybeSingle();
      if (d) { shortCode = d.short_code ?? token.id; contactId = d.contact_id ?? null; }
    } else {
      // Same rule for a contact uuid: email_inbound.contact_id has no foreign key, so an
      // unchecked token would write a dangling id onto the tenant's feed.
      const { data: c } = await admin.from("crm_contacts")
        .select("id").eq("id", token.id).eq("client_id", clientId).maybeSingle();
      if (c) contactId = c.id;
    }
  }

  // B2. Our own Message-ID, echoed back in In-Reply-To/References.
  //     This REPLACES the join against email_sends.provider_message_id, which could never
  //     match: that column holds the provider's API id (a bare uuid) while In-Reply-To
  //     always carries an RFC 5322 id ending `@domain`. See buildThreadMessageId.
  //     The id names its own tenant; a mismatch means a forged or forwarded header, so it is
  //     ignored rather than followed.
  if (!shortCode && !contactId) {
    for (const cand of [...messageIds(inReplyTo), ...messageIds(referencesRaw)]) {
      const t = parseThreadMessageId(cand);
      if (!t || t.clientId !== clientId) continue;
      if (t.kind === "design") {
        const { data: d } = await admin.from("designs")
          .select("contact_id, short_code")
          .eq("short_code", t.id).eq("client_id", clientId).maybeSingle();
        if (d) { shortCode = d.short_code ?? t.id; contactId = d.contact_id ?? null; break; }
      } else {
        const { data: c } = await admin.from("crm_contacts")
          .select("id").eq("id", t.id).eq("client_id", clientId).maybeSingle();
        if (c) { contactId = c.id; break; }
      }
    }
  }

  // B3. The sender's address. Weakest — it cannot know WHICH design — but it still lands the
  //     message on the right person, which is most of the value. Scoped to the tenant, so the
  //     old cross-tenant ambiguity cannot arise: two builders may both know this address, and
  //     only the one that received the mail is considered.
  if (!contactId) {
    const { data: c } = await admin.from("crm_contacts")
      .select("id")
      .eq("client_id", clientId).eq("email_lower", from.email).is("merged_into", null)
      .order("updated_at", { ascending: false }).limit(2);
    const rows = c ?? [];
    // Still refuse to guess between two live contacts sharing an address inside one tenant:
    // an unfiled row an operator can re-link beats a confidently misfiled one.
    if (rows.length === 1) contactId = rows[0].id;
  }

  const bodyText = stripQuoted(String(m.text ?? m.body_plain ?? m.plain ?? ""));
  const { error } = await admin.from("email_inbound").insert({
    client_id: clientId,
    contact_id: contactId,
    short_code: shortCode,
    from_email: from.email,
    from_name: from.name,
    to_email: to.email || null,
    subject: String(m.subject ?? "").slice(0, 500) || null,
    body_text: bodyText.slice(0, 40000) || null,
    body_html: String(m.html ?? m.body_html ?? "").slice(0, 200000) || null,
    message_id: ownMessageId,
    in_reply_to: messageIds(inReplyTo)[0] ?? null,
    references_raw: referencesRaw.slice(0, 2000) || null,
    spam_verdict: String(m.spam_verdict ?? m.spamVerdict ?? "").slice(0, 40) || null,
  });

  // 23505 is the idempotency index doing its job on a provider retry — a success, not a
  // failure, and it must not be logged as one or every retry becomes noise.
  if (error && (error as any).code !== "23505") {
    await logEdgeError({
      fn: "email-inbound", req, clientId, code: "inbound_insert_failed",
      message: `Could not store an inbound email: ${error.message}`,
      context: { matchedContact: Boolean(contactId), matchedDesign: Boolean(shortCode) },
    });
    return json({ ok: true, stored: false });
  }

  return json({ ok: true, stored: true, matched: contactId ? "contact" : (shortCode ? "design" : "tenant") });
}));
