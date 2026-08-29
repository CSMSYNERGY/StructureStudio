import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { withErrorLog, logEdgeError } from "../_shared/logError.ts";
import { timingSafeEqual } from "../_shared/emailInbound.ts";
import { normalizeBrandStatus, normalizeCampaignStatus } from "../_shared/twilioTrustHub.ts";

// Twilio Event Streams sink for A2P compliance events.
//
// This is not a nicety. Per-number A2P registration — the LAST step before a builder can
// text anyone — has NO polling API at all: the Messaging Service PhoneNumbers resource
// carries no A2P fields, and Twilio's only status readout is a Console CSV that "can take up
// to 24 hours to generate". These events are the only programmatic way to learn that a
// number went live. Everything else here (brand, campaign) is a faster echo of what the
// poller would eventually see anyway.
//
// ⚠️ verify_jwt MUST be false. Twilio cannot send a Supabase JWT, and with verification on
// the gateway 401s every delivery BEFORE this function runs — the billing-webhook failure
// mode, which was invisible from inside the database for weeks. Auth is the shared URL
// secret, compared in constant time.
//
// ⚠️ ANSWER FAST. The webhook sink response timeout is FIVE SECONDS, and a cold Supabase
// isolate spends ~2.5s before its first query. So: no Twilio round trips here, ever. Record
// the event, project it onto the row, return. Anything slower belongs in the poller.
//
// ⚠️ ALWAYS 200 ONCE AUTHENTICATED, like sms-inbound. Event Streams has no documented
// redelivery; a non-2xx buys nothing and can get the subscription disabled.

function ok(body: unknown = { ok: true }) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}
function deny() {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401, headers: { "Content-Type": "application/json" },
  });
}

/** The A2P compliance event types worth acting on. Anything else is recorded and ignored —
 *  Twilio adds event types, and an unknown one must never look like a failure. */
const NUMBER_EVENTS = new Set([
  "com.twilio.messaging.compliance.number-registration.pending",
  "com.twilio.messaging.compliance.number-registration.successful",
  "com.twilio.messaging.compliance.number-registration.failed",
]);

Deno.serve(withErrorLog("twilio-events", async (req: Request) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });

  const secret = Deno.env.get("TWILIO_EVENTS_SECRET") ?? "";
  const key = new URL(req.url).searchParams.get("key") ?? "";
  // Unset secret ⇒ refuse everything. Inert, never open — the same posture email-inbound and
  // sms-inbound ship with, so this can be deployed long before the sink is created.
  if (!secret || !timingSafeEqual(key, secret)) return deny();

  let events: any[] = [];
  try {
    const body = await req.json();
    // Event Streams posts a CloudEvents ARRAY. A single object is accepted too so a manual
    // curl probe behaves the same as the real thing.
    events = Array.isArray(body) ? body : [body];
  } catch {
    return ok({ ok: true, ignored: "unparseable" });
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  let handled = 0;
  for (const ev of events) {
    const eventId = String(ev?.id ?? "");
    const type = String(ev?.type ?? "");
    const d = (ev?.data ?? {}) as Record<string, any>;

    // ── Resolve the tenant ────────────────────────────────────────────────────────────
    // ⚠️ NEVER on the campaign SID. The event payload's `campaignsid` is a CM… SID, a
    // DIFFERENT SID SPACE from the QE… the REST API returns and stores in campaign_sid.
    // Joining those two is a bug that silently matches nothing. brandsid (BN…) and
    // messagingservicesid (MG…) DO match what we store.
    const brandSid = String(d.brandsid ?? d.brandSid ?? "");
    const serviceSid = String(d.messagingservicesid ?? d.messagingServiceSid ?? "");
    const phoneNumber = String(d.phonenumber ?? d.phoneNumber ?? "");

    let reg: any = null;
    if (brandSid) {
      const { data } = await admin.from("sms_registrations").select("*").eq("brand_sid", brandSid).maybeSingle();
      reg = data;
    }
    if (!reg && serviceSid) {
      const { data } = await admin.from("sms_registrations").select("*").eq("messaging_service_sid", serviceSid).maybeSingle();
      reg = data;
    }

    // ── Record first, act second ──────────────────────────────────────────────────────
    // The CloudEvents id is the idempotency key. A 23505 on redelivery is a SUCCESS — the
    // event is already recorded — so it must not look like a failure or provoke a retry.
    const { error: insErr } = await admin.from("sms_registration_events").insert({
      client_id: reg?.client_id ?? null,
      event_id: eventId || null,
      event_type: type,
      detail: d,
    });
    if (insErr && String((insErr as { code?: string }).code) === "23505") continue; // already seen
    if (!reg) continue;

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

    // ── Per-number registration: the reason this function exists ─────────────────────
    if (NUMBER_EVENTS.has(type) && phoneNumber) {
      // Twilio's own vocabulary, kept verbatim on the number row.
      const external = String(d.externalstatus ?? d.externalStatus ?? "").toLowerCase();
      const status = type.endsWith(".successful") || external === "registered"
        ? "registered"
        : type.endsWith(".failed") ? "failed" : "pending_registration";
      await admin.from("sms_numbers")
        .update({ registration_status: status })
        .eq("client_id", reg.client_id).eq("phone_number", phoneNumber).is("released_at", null);

      if (status === "registered") {
        // THE MOMENT TEXTING BECOMES LEGAL for this builder. Both switches flip together:
        // sms_registrations.status gates the feature, client_settings.sms_status is what
        // smsSend reads on every send.
        patch.status = "active";
        patch.next_poll_at = null;
        patch.needs_attention = false;
        patch.attention_note = null;
        await admin.from("client_settings")
          .update({ sms_status: "active" }).eq("client_id", reg.client_id);
      } else if (status === "failed") {
        patch.needs_attention = true;
        patch.attention_note = "The carriers refused to register this number. It may need to be released and replaced.";
      }
      handled++;
    }

    // ── Brand and campaign: a faster echo of what the poller would find ──────────────
    // ⚠️ Event statuses are lowercase and DISJOINT from the REST enum ("registered",
    // "vetting_failed"). Normalising here is what stops one column meaning two things
    // depending on which code path wrote it last.
    const brandStatusRaw = String(d.brandstatus ?? d.brandStatus ?? "");
    if (brandStatusRaw) {
      const s = normalizeBrandStatus(brandStatusRaw);
      patch.brand_status = s;
      if (s === "APPROVED" && reg.status === "brand_pending") {
        patch.status = "brand_approved";
        patch.next_poll_at = new Date(Date.now() + 60_000).toISOString();
      }
      if (s === "FAILED" || s === "SUSPENDED") {
        patch.status = "brand_failed";
        patch.next_poll_at = null;
        patch.needs_attention = true;
        patch.attention_note = s === "SUSPENDED"
          ? "The carriers suspended this brand. Only Twilio support can lift it."
          : "The carriers rejected this registration.";
      }
      handled++;
    }
    const identityRaw = String(d.identitystatus ?? d.identityStatus ?? "");
    if (identityRaw) patch.brand_identity_status = identityRaw.toUpperCase();

    const campaignRaw = String(d.campaignregistrationstatus ?? d.campaignStatus ?? "");
    if (campaignRaw) {
      const s = normalizeCampaignStatus(campaignRaw);
      patch.campaign_status = s;
      if (s === "APPROVED" && reg.status === "campaign_pending") {
        patch.status = "campaign_approved";
        patch.next_poll_at = null;
      }
      if (s === "FAILED") {
        patch.status = "campaign_failed";
        patch.next_poll_at = null;
        patch.needs_attention = true;
        // No campaign update API exists — the free fix is the Console.
        patch.attention_note = "The carriers rejected the campaign. It has to be corrected in the Twilio Console.";
      }
      handled++;
    }
    // The CM… campaign SID, kept in its own column so it can never be confused with the QE…
    const cm = String(d.campaignsid ?? d.campaignSid ?? "");
    if (cm) patch.campaign_cm_sid = cm;

    if (Object.keys(patch).length > 1) {
      await admin.from("sms_registrations").update(patch).eq("client_id", reg.client_id);
    }
  }

  if (!handled && events.length) {
    // Not an error — Twilio adds event types, and an unrecognised one is recorded above and
    // deliberately ignored. Logged as info so a flood of them is still visible.
    await logEdgeError({
      fn: "twilio-events",
      code: "twilio_event_unhandled",
      message: `Received ${events.length} event(s) with no recognised A2P fields.`,
      severity: "info",
      context: { types: events.map((e) => String(e?.type ?? "")).slice(0, 5) },
    }).catch(() => {});
  }

  return ok({ ok: true, received: events.length, handled });
}));
