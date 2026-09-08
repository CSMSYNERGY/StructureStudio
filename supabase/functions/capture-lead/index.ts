import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { logEdgeError, withErrorLog } from "../_shared/logError.ts";
import { clientIp } from "../_shared/adminGate.ts";

// capture-lead: called by the PUBLIC designer's name+phone gate. Upserts a GHL contact
// (the lead) into the tenant's GHL location using the tenant's stored creds, so an
// interested visitor becomes a CRM contact the moment they pass the gate — even if they
// never finish/submit a design. BEST-EFFORT: never blocks the gate (returns ok on any GHL
// issue). clientId comes from the body (public endpoint) but is validated against
// client_configs; GHL creds are read service-role from client_settings (never exposed to
// the browser). This mirrors submit-estimate's existing anon->GHL exposure.
//
// RATE LIMITED per tenant since 2026-07-30 — see RATE_* below. Before that, anyone holding
// the public anon key could drive unlimited contact upserts into ANY configured tenant's
// GHL location. The real damage was never table growth: it was burning the tenant's GHL
// rate budget and polluting their CRM.

// ── Abuse guards (two, because there are two different attacks) ──────────────
// ⚠️ BOTH GUARDS RUN BEFORE EVERY WRITE, and that ordering is the whole point of them.
// They used to sit between the local writes and the outbound GHL call, on the reasoning
// that a real lead arriving during someone else's flood should still land in
// captured_leads. That reasoning only looked at the GHL leg: it left FOUR writes —
// captured_leads, crm_ensure_contact, the contact link and sms_consent_log — running once
// per request for an anonymous caller, with nothing bounding them. Two of those grow a
// table per request. A cap that lets the flood write is not a cap.
//
// The cost of the new order is honest and small: while a tenant is over the cap, a capture
// is dropped entirely rather than saved locally. At 30/minute that only happens during
// abuse, it is logged, and losing one capture beats handing an anonymous caller unbounded
// growth on three tables.
//
// GUARD 1 — per-tenant volume cap. Counts captured_leads rows updated inside the window,
// index-backed by `captured_leads_client (client_id, updated_at DESC)`. This catches the
// damaging shape: MANY DIFFERENT phones, which grows the table and floods the tenant's CRM
// with junk contacts.
//
// It does NOT catch one phone hammered — that is a single row, so the count stays at 1 no
// matter how many requests arrive. Guard 2 exists for exactly that, because a row count can
// never see it.
//
// Deliberately no GLOBAL cap. The vulnerability is per-tenant (whose GHL budget is burned),
// and a global cap needs an `updated_at`-only scan with no index to serve it — a seq scan on
// every public request, which becomes its own DoS surface as the table grows. Per-tenant,
// multiplied by the tenant count, already bounds the total.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_TENANT = 30;   // generous: a real gate sees single digits per minute
// A breach logs only while the count sits in [MAX, MAX+2], so a sustained flood writes ~3
// rows per window instead of one per request. app_errors has NO fingerprint dedupe in this
// project (unlike BuildBridge and Framed-UP), so self-limiting here is the only thing
// stopping an attacker from turning our own error log into the amplification.
const RATE_LOG_CEILING = RATE_MAX_PER_TENANT + 2;

// GUARD 2 — per-lead debounce, which is what actually stops one phone being hammered.
// If this exact (tenant, phone) was captured moments ago AND this request carries nothing
// new, the outbound GHL upsert would be a no-op write of identical data, so skip it.
// Enrichment is explicitly preserved: the gate sends name+phone, and the later Details-open
// capture adds email/address — that request DOES carry something new, so it always goes
// through regardless of how recent the previous one was.
//
// ⚠️ "NEW" MEANS A FIELD WE DID NOT HAVE, NOT A FIELD THAT CHANGED. A changed value is
// caller-controlled and infinitely repeatable, so judging novelty by difference meant one
// phone with a rotating name (or a rotating anything) passed this guard on every request
// while the row count Guard 1 watches sat at 1 — the two guards together let the flood
// straight through to the tenant's CRM. Empty→filled can happen once per field, so the
// number of times a single phone can pass this guard is now bounded by the field count for
// the life of the lead, whatever the caller sends. The enrichment case is untouched: the
// gate leaves email and address empty and the Details capture fills them.
//
// A genuine CORRECTION (a typo'd email retyped) no longer jumps the queue, but it is
// written to the local row by the very next capture outside the window, and the two real
// callers fire once per page load — well over 15s apart in any flow that corrects a field.
const LEAD_DEBOUNCE_MS = 15_000;

// The 10-digit NANP key, matching public.crm_phone_key / _shared/phoneKey.ts. Used for
// every identity compare here (consent, email ownership, the GHL round-trip) so a stored
// "+1 816…" and a typed "816…" are the same person in all of them.
const ten = (digits: string) =>
  digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits.slice(-10);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(withErrorLog("capture-lead", async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  const clientId = typeof body?.clientId === "string" ? body.clientId.trim() : "";
  const name = typeof body?.name === "string" ? body.name.trim().slice(0, 200) : "";
  const phoneRaw = typeof body?.phone === "string" ? body.phone.trim().slice(0, 40) : "";
  const email = typeof body?.email === "string" ? body.email.trim().slice(0, 200) : "";
  // Optional address — sent by the designer's silent Details-open capture, where the
  // visitor has just filled the whole contact form. All best-effort, same as email.
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const street = str(body?.street, 200);
  const city = str(body?.city, 100);
  const state = str(body?.state, 60);
  const zip = str(body?.zip, 12);
  const phoneDigits = phoneRaw.replace(/\D/g, "");
  const phoneKey10 = ten(phoneDigits);

  // ── SMS consent, from the public gate's checkbox ──────────────────────────
  // ⚠️ The DISCLOSURE SENTENCE IS STORED VERBATIM, not a template id. The wording will be
  // edited; today's copy is not evidence of what was on screen last March, and the whole
  // value of a consent record is being able to show exactly what someone agreed to.
  //
  // ⚠️ Consent is OPTIONAL at the gate — it is a lead-gen funnel, and blocking the designer
  // on a texting opt-in would cost the builder leads. So `false` here is the normal case,
  // not a failure, and it simply records nothing.
  const smsConsent = body?.smsConsent === true;
  const consentText = typeof body?.consentText === "string" ? body.consentText.trim().slice(0, 1000) : "";
  const consentUrlRaw = typeof body?.consentUrl === "string" ? body.consentUrl.trim().slice(0, 500) : "";
  // Stored as evidence of WHERE the box was ticked, so it has to be a page address. Anything
  // else (a javascript: URI, a sentence, an empty string) is dropped rather than filed.
  const consentUrl = /^https?:\/\//i.test(consentUrlRaw) ? consentUrlRaw : "";
  // ⚠️ VERBATIM, BUT STILL A DISCLOSURE. The text is stored exactly as sent — that is the
  // point of the column — which also means a public caller chooses the words that get filed
  // as this tenant's proof of permission. These two clauses are carrier-mandated (CTIA, and
  // Twilio 30924 for the rates line) and appear in every version of the sentence in
  // _shared/smsConsentText.ts, so requiring them rejects free text without pinning wording
  // we may still edit. Nothing here reformats or replaces what is stored.
  const consentTextOk =
    consentText.length >= 40 &&
    /message and data rates may apply/i.test(consentText) &&
    /reply\s+stop/i.test(consentText);

  // Basic validation — don't spam the CRM with empty/garbage. Not fatal: skip quietly.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(clientId)) return json({ ok: false, skipped: "bad_client" });
  if (!name || phoneDigits.length < 10) return json({ ok: false, skipped: "incomplete" });

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Validate the tenant exists (same guard the public RPCs use).
  const { data: cfg } = await sb.from("client_configs").select("client_id").eq("client_id", clientId).maybeSingle();
  if (!cfg) return json({ ok: false, skipped: "unknown_client" });

  // The lead as it stands BEFORE this request. Read once and used three times: by Guard 2
  // to judge novelty, by the upsert below to enrich-never-blank, and by the GHL leg to find
  // the contact it already linked.
  const source = body?.source === "details" ? "details" : "gate";
  const { data: existingLead } = await sb.from("captured_leads")
    .select("id, name, email, street, city, state, zip, ghl_contact_id, source, updated_at")
    .eq("client_id", clientId).eq("phone_digits", phoneDigits).maybeSingle();

  // ── GUARD 2: per-lead debounce (the same-phone flood) ───────────────────────
  // Judged against the row as it stands right now, before anything is written. "Adds
  // something" is a field that was EMPTY and is now filled — see the note on
  // LEAD_DEBOUNCE_MS for why novelty is not "differs from what we had".
  if (existingLead?.updated_at) {
    const sinceLast = Date.now() - Date.parse(existingLead.updated_at);
    const addsSomething =
      (!!email && !existingLead.email) ||
      (!!street && !existingLead.street) ||
      (!!city && !existingLead.city) ||
      (!!state && !existingLead.state) ||
      (!!zip && !existingLead.zip) ||
      (!!name && !existingLead.name) ||
      (source === "details" && existingLead.source !== "details");
    if (Number.isFinite(sinceLast) && sinceLast >= 0 && sinceLast < LEAD_DEBOUNCE_MS && !addsSomething) {
      // No log: this is the ordinary double-fire case (a visitor re-submitting the gate, a
      // double-click, a retry) as much as it is abuse. Logging it would be noise.
      return json({ ok: true, captured: false, reason: "debounced" });
    }
  }

  // ── GUARD 1: per-tenant volume cap ─────────────────────────────────────────
  // Returns ok:true like every other soft path here: the public gate must never block, so a
  // cap breach is invisible to the visitor by design.
  // ⚠️ `>=`, not `>`. The count no longer includes this request's own row (nothing has been
  // written yet), so the comparison shifts by one to keep the same effective ceiling.
  {
    const since = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
    const { count, error: rateErr } = await sb.from("captured_leads")
      .select("id", { count: "exact", head: true })
      .eq("client_id", clientId).gt("updated_at", since);
    // A failed count must not become a free pass OR an outage: fall through and allow.
    // Failing closed here would let one bad query silence a tenant's lead capture entirely.
    if (!rateErr && (count ?? 0) >= RATE_MAX_PER_TENANT) {
      if ((count ?? 0) <= RATE_LOG_CEILING) {
        await logEdgeError({
          fn: "capture-lead", req, clientId, code: "rate_limited",
          message: `capture-lead rate cap hit — ${count} captures in ${RATE_WINDOW_MS / 1000}s; ` +
                   `capture skipped`,
          context: { count, limit: RATE_MAX_PER_TENANT, windowMs: RATE_WINDOW_MS },
        });
      }
      return json({ ok: true, captured: false, reason: "rate_limited" });
    }
  }

  // ── Whose email is this? ───────────────────────────────────────────────────
  // The PHONE is the identity this whole function is keyed on: captured_leads is unique on
  // (client_id, phone_digits), consent is filed against the phone, and the gate verifies
  // nothing else. Email is enrichment — but both CRM writes below treat it as a MATCH key.
  // `crm_ensure_contact` resolves by phone THEN email, and GHL's /contacts/upsert matches on
  // phone OR email. So a visitor who types an address that belongs to someone else — a typo,
  // a shared household mailbox, or a deliberate one — gets handed that person's contact
  // record, which is then rewritten with this visitor's name, phone and address, and linked
  // back onto this lead locally.
  //
  // The email is still KEPT on the lead row (it is what the visitor typed and the builder
  // may want to see it); it is simply not allowed to decide WHO this is.
  let emailMatchable = !!email;
  if (email) {
    const { data: owners } = await sb.from("crm_contacts")
      .select("phone_digits")
      .eq("client_id", clientId).eq("email_lower", email.toLowerCase())
      .is("merged_into", null).limit(5);
    const claimedByAnother = (owners || []).some((o: any) => {
      const k = ten(String(o?.phone_digits || "").replace(/\D/g, ""));
      return !!k && k !== phoneKey10;
    });
    if (claimedByAnother) {
      emailMatchable = false;
      // ⚠️ No email address or phone digits in the message — the PII rule this function keeps.
      await logEdgeError({
        fn: "capture-lead", req, clientId, code: "email_conflict",
        message: "captured email already belongs to a different contact in this tenant — " +
                 "kept on the lead, not used as a CRM match key",
      });
    }
  }
  const ghlEmail = emailMatchable ? email : "";

  // ── Local record (migration 062) ───────────────────────────────────────────────
  // The portal's browsing-leads view reads THIS table, so a lead must exist here even when
  // GHL is unconfigured, down, or rejects the upsert — previously those leads evaporated.
  // One row per (tenant, phone); later captures ENRICH, never blank: the gate sends only
  // name+phone, and a Details-open capture adds email/address onto the same row. COALESCE
  // against the existing row so the fuller value always wins over an empty resend.
  const leadRow = {
    client_id: clientId,
    name,
    phone_digits: phoneDigits,
    phone: phoneRaw,
    email: email || existingLead?.email || null,
    street: street || existingLead?.street || null,
    city: city || existingLead?.city || null,
    state: state || existingLead?.state || null,
    zip: zip || existingLead?.zip || null,
    // 'details' outranks 'gate': it means they went as far as asking for prices.
    source: source === "details" || existingLead?.source === "details" ? "details" : "gate",
    ghl_contact_id: existingLead?.ghl_contact_id || null,
    updated_at: new Date().toISOString(),
  };
  const { data: savedLead, error: leadErr } = await sb.from("captured_leads")
    .upsert(leadRow, { onConflict: "client_id,phone_digits" })
    .select("id").maybeSingle();
  if (leadErr) {
    // The local row is the one the tenant SEES — its failure is worth a durable error even
    // though the GHL leg below may still succeed.
    await logEdgeError({ fn: "capture-lead", req, clientId, code: "local_upsert",
      message: `captured_leads upsert failed: ${leadErr.message}` });
  }

  // ── The built-in CRM contact (migration 130) ──────────────────────────────
  // The portal's Contacts list opens a person's record through crm_contacts, and it finds
  // the id on THIS row — so a captured lead with no contact_id is a name that cannot be
  // clicked. 130 stamped every lead that existed when it ran and nothing has stamped one
  // since, which is why the newest browsing lead (the top row of the list, the one anyone
  // clicks first) was always the dead one.
  //
  // BEST-EFFORT, like every other leg here: the public gate must never fail because
  // bookkeeping did, so this is wrapped and only logged. `crm_ensure_contact` is
  // service-role-only and resolves-or-creates by phone then email, so a lead who already
  // has a record (from a design, or from an earlier visit) links to that same record
  // rather than a second one. `source` is deliberately left alone — flipping it would
  // relabel an existing customer as a browsing lead the day they come back to look again.
  //
  // The email handed to the resolver is the vetted one: a contested address falls back to
  // whatever we already had against this phone, so the resolver cannot match on somebody
  // else's mailbox and return their contact.
  if (savedLead) {
    try {
      const { data: crmId, error: crmErr } = await sb.rpc("crm_ensure_contact", {
        p_client_id: clientId,
        p_name: name,
        p_phone: phoneRaw,
        p_email: emailMatchable ? leadRow.email : (existingLead?.email || null),
      });
      if (crmErr) throw crmErr;
      if (crmId) {
        const { error: linkErr } = await sb.from("captured_leads")
          .update({ contact_id: crmId }).eq("id", savedLead.id);
        if (linkErr) throw linkErr;
      }
    } catch (e) {
      await logEdgeError({ fn: "capture-lead", req, clientId, code: "crm_link",
        message: `crm_contacts link failed - lead saved unlinked: ${(e as Error).message}` });
    }
  }

  // ── The consent record ────────────────────────────────────────────────────
  // Keyed on the PHONE, not the lead row: consent belongs to the person and has to survive
  // their contact being merged, renamed or re-created. Append-only — a later opt-out is a
  // second row, never an edit of this one, so the history stays readable.
  //
  // ⚠️ REFUSED WITHOUT THE SENTENCE. A consent record that cannot say what was shown is not
  // evidence, so a `true` flag with no text is dropped rather than stored as a half-record
  // that looks like proof until someone reads it.
  if (smsConsent && consentTextOk && phoneDigits.length >= 10) {
    const tenDigits = phoneKey10;
    // ⚠️ ONE GRANT PER (TENANT, PHONE). Append-only is about HISTORY, not about repetition:
    // re-ticking the same box adds no fact, and this is a public endpoint, so an insert on
    // every request means a table an anonymous caller grows without limit. The row that is
    // already there is the evidence — the first time permission was given, with the words
    // that were on screen then, which is the version an auditor asks for.
    //
    // Revocation is unaffected: a STOP writes sms_opt_outs (and its own 'revoked' row) and
    // the send path checks that table first, so skipping a duplicate grant can never
    // un-block someone who asked us to stop.
    const { data: priorGrant } = await sb.from("sms_consent_log")
      .select("id")
      .eq("client_id", clientId).eq("phone_digits", tenDigits).eq("action", "granted")
      .limit(1).maybeSingle();
    if (!priorGrant) {
      const { error: consentErr } = await sb.from("sms_consent_log").insert({
        client_id: clientId,
        phone_digits: tenDigits,
        action: "granted",
        source: "web_form",
        disclosure_text: consentText,
        consent_url: consentUrl || null,
        ip: clientIp(req),
        user_agent: (req.headers.get("user-agent") || "").slice(0, 300),
        detail: { name: name || null, leadId: savedLead?.id ?? null },
      });
      if (consentErr) {
        // Worth a durable row: a consent we failed to record is a text we later cannot justify
        // sending. ⚠️ No phone digits in the message — the PII rule this function already keeps.
        await logEdgeError({ fn: "capture-lead", req, clientId, code: "consent_insert",
          message: `sms_consent_log insert failed: ${consentErr.message}` });
      }
    }
    // The opt-out ledger is deliberately NOT touched here. Granting consent must never clear
    // an earlier STOP — that instruction outranks a checkbox on a later visit, and quietly
    // un-blocking someone who asked us to stop is the one mistake with a statutory penalty.
  } else if (smsConsent && consentText && !consentTextOk) {
    // A ticked box whose sentence we refused. Durable, because the innocent cause is an edit
    // to the disclosure wording that dropped a mandatory clause — and the symptom of that is
    // silence: real consent quietly not recorded, and texting refused months later with no
    // trace of why. Bounded by Guard 1 above, which has already run.
    await logEdgeError({ fn: "capture-lead", req, clientId, code: "consent_text_rejected",
      message: "sms consent not recorded - the disclosure sentence is missing a mandatory clause " +
               "(see _shared/smsConsentText.ts)" });
  }

  // GHL creds (service-role only). If unset the lead still exists locally — skip quietly.
  const { data: settings } = await sb.from("client_settings")
    .select("ghl_location_id, ghl_api_key").eq("client_id", clientId).maybeSingle();
  const locationId = settings?.ghl_location_id || "";
  const apiKey = settings?.ghl_api_key || "";
  if (!locationId || !apiKey) return json({ ok: true, captured: false, reason: "ghl_not_configured" });

  try {
    const r = await fetch("https://services.leadconnectorhq.com/contacts/upsert", {
      method: "POST",
      headers: {
        "Version": "2021-07-28",
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        name,
        phone: phoneRaw,
        ...(ghlEmail ? { email: ghlEmail } : {}),
        ...(street ? { address1: street } : {}),
        ...(city ? { city } : {}),
        ...(state ? { state } : {}),
        ...(zip ? { postalCode: zip } : {}),
        locationId,
        source: "StructureStudio Designer",
        tags: ["structurestudio-lead"],
      }),
    });
    if (!r.ok) {
      const detail = (await r.text().catch(() => "")).slice(0, 300);
      console.warn("capture-lead: GHL upsert non-OK", r.status, detail);
      // Logged explicitly: this returns HTTP 200 by design (the gate must never block),
      // so withErrorLog cannot see it — yet a lead was just lost.
      await logEdgeError({
        fn: "capture-lead", req, clientId, code: `ghl_${r.status}`,
        message: `GHL contact upsert failed (${r.status}) — lead saved locally only`,
        context: { ghlStatus: r.status, ghlBody: detail },
      });
      return json({ ok: true, captured: false, reason: `ghl_${r.status}` });
    }
    const d = await r.json();
    const contactId = (d && d.contact && d.contact.id) || null;
    // ⚠️ CHECK WHO CAME BACK. /contacts/upsert matches on phone OR email and tells us nothing
    // about which one it used, so the contact in the response is not guaranteed to be the
    // person we sent. The email above is vetted against our own book, but GHL holds contacts
    // we have never seen, so this is the second half of the same guard: if the returned
    // contact carries a different number, it is somebody else's record and its id must not be
    // stamped onto this lead — that link is what the portal calls "in your CRM", and pointing
    // it at a stranger is worse than leaving it empty.
    const retKey = ten(String((d && d.contact && d.contact.phone) || "").replace(/\D/g, ""));
    if (contactId && retKey && retKey !== phoneKey10) {
      await logEdgeError({
        fn: "capture-lead", req, clientId, code: "ghl_contact_mismatch",
        message: "GHL upsert returned a contact whose phone is not the captured lead's — " +
                 "matched on another key; local link not written",
      });
      return json({ ok: true, captured: false, reason: "ghl_contact_mismatch" });
    }
    // Link the local row to the CRM contact — the portal shows this as "in your CRM".
    if (contactId && savedLead) {
      await sb.from("captured_leads").update({ ghl_contact_id: contactId }).eq("id", savedLead.id)
        .then(() => undefined, () => undefined);
    }
    return json({ ok: true, captured: true, contactId });
  } catch (e) {
    console.warn("capture-lead: GHL upsert error", (e as Error).message);
    await logEdgeError({
      fn: "capture-lead", req, clientId, code: "ghl_error",
      message: `GHL contact upsert threw — lead saved locally only: ${(e as Error).message}`,
    });
    return json({ ok: true, captured: false, reason: "ghl_error" });
  }
}));
