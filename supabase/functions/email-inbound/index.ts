import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { logEdgeError, withErrorLog } from "../_shared/logError.ts";
import { timingSafeEqual, parseAddress, messageIds, stripQuoted, parseReplyToken } from "../_shared/emailInbound.ts";

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

  const toRaw = Array.isArray(m.to) ? m.to[0] : (m.to ?? m.To ?? m.recipient);
  const to = parseAddress(toRaw);

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
  // 1. In-Reply-To / References against what we sent. This is the ONLY signal that can put
  //    a reply on the right DESIGN, because a customer with three quotes replying "yes,
  //    let's do it" is otherwise unplaceable.
  let clientId: string | null = null;
  let contactId: string | null = null;
  let shortCode: string | null = null;

  // 0. THE ADDRESS IT WAS SENT TO. Strongest signal by far, and the reason a builder can
  //    hold a real conversation: we chose that address when we sent, so there is nothing to
  //    infer. Tried before the headers because headers are the thing clients mangle.
  const token = parseReplyToken(to.email);
  if (token) {
    const dom = to.email.split("@")[1] ?? "";
    const { data: cs } = await admin.from("client_settings")
      .select("client_id").eq("inbound_domain", dom).maybeSingle();
    if (cs?.client_id) {
      clientId = cs.client_id;
      if (token.kind === "design") {
        shortCode = token.id;
        // Carry the contact across too, so a design reply also shows on the person.
        const { data: d } = await admin.from("designs")
          .select("contact_id").eq("short_code", token.id).eq("client_id", clientId).maybeSingle();
        contactId = d?.contact_id ?? null;
      } else {
        contactId = token.id;
      }
    }
  }

  const candidates = clientId ? [] : [...messageIds(inReplyTo), ...messageIds(referencesRaw)];
  if (candidates.length) {
    const { data: sent } = await admin.from("email_sends")
      .select("client_id, short_code, contact_id, provider_message_id")
      .in("provider_message_id", candidates)
      .order("created_at", { ascending: false }).limit(1);
    const hit = (sent ?? [])[0];
    if (hit) { clientId = hit.client_id; shortCode = hit.short_code ?? null; contactId = hit.contact_id ?? null; }
  }

  // 2. Fall back to the sender's address. Weaker — it cannot know WHICH design — but it
  //    still lands the message on the right person, which is most of the value.
  if (!clientId || !contactId) {
    const { data: c } = await admin.from("crm_contacts")
      .select("id, client_id")
      .eq("email_lower", from.email).is("merged_into", null)
      .order("updated_at", { ascending: false }).limit(2);
    const rows = c ?? [];
    // Exactly one match, or one within the tenant we already identified. Two contacts across
    // two tenants sharing an address is ambiguous, and guessing would file a customer's reply
    // into another builder's account — the one outcome worse than not filing it.
    const pick = clientId ? rows.find((r: any) => r.client_id === clientId) : (rows.length === 1 ? rows[0] : null);
    if (pick) { clientId = clientId ?? pick.client_id; contactId = contactId ?? pick.id; }
  }

  // 3. Last resort: the address it arrived AT identifies the tenant, even if the sender is
  //    a stranger. Better an unmatched row on the right account than an orphan on none.
  if (!clientId && to.email.includes("@")) {
    const domain = to.email.split("@")[1] ?? "";
    if (domain) {
      const { data: s } = await admin.from("client_settings")
        .select("client_id").eq("email_domain", domain).limit(1);
      if ((s ?? [])[0]) clientId = (s as any)[0].client_id;
    }
  }

  if (!clientId) {
    // Nothing to attach it to at all. Log it so it is visible, and 200 so the provider does
    // not retry something a retry cannot fix.
    await logEdgeError({
      fn: "email-inbound", req, clientId: null, code: "inbound_no_tenant",
      message: "Inbound email could not be attributed to a tenant.",
      context: { hasInReplyTo: Boolean(inReplyTo), matchedNone: true },
    });
    return json({ ok: true, ignored: "no tenant" });
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
