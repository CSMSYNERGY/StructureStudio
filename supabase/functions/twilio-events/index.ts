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
// ⚠️ ANSWER FIRST, WORK AFTER — and this is not a precaution, it is a fix. The sink timeout
// is FIVE SECONDS and a cold Supabase isolate spends ~2.5s before its first query. The first
// version did the database work inline and Twilio's own test event came back **504 Timed out
// waiting for a response** — while the event itself had been received and stored perfectly.
// The work was never the problem; being still busy when Twilio gave up was.
//
// So the handler now authenticates, parses, and RETURNS 200 immediately, handing the
// processing to EdgeRuntime.waitUntil() so the isolate stays alive to finish it.
//
// ⚠️ The trade this makes, deliberately: a failure after the response cannot be reported to
// Twilio. That costs nothing here, because Event Streams has no documented redelivery — a
// non-2xx would not have earned a retry anyway, and could get the subscription disabled. The
// real safety nets for the signal that matters (per-number registration) are the poller and
// the probe send, both of which exist for exactly this reason.
//
// Still true: NO Twilio round trips in here, ever. Anything that needs one belongs in the poller.
//
// ⚠️ ALWAYS 200 ONCE AUTHENTICATED, like sms-inbound. Event Streams has no documented
// redelivery; a non-2xx buys nothing and can get the subscription disabled.

// Supabase's runtime provides this; the type is not in the edge-runtime .d.ts, so declare the
// one member used. Guarded at the call site — if it is ever absent the work is awaited inline,
// which is the pre-fix behaviour rather than silently dropping the event.
// deno-lint-ignore no-explicit-any
declare const EdgeRuntime: { waitUntil?: (p: Promise<unknown>) => void } | undefined;

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

  // ── Respond NOW, process after ───────────────────────────────────────────────────────
  // Everything above is cheap and synchronous: a constant-time secret compare and a JSON
  // parse. Everything below touches the database, and that is what blew the five-second
  // budget. Twilio gets its 200 while the work runs on.
  const work = processEvents(admin, events);
  try {
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime && typeof EdgeRuntime.waitUntil === "function") {
      EdgeRuntime.waitUntil(work);
    } else {
      // No waitUntil in this runtime — finishing the work matters more than the deadline,
      // because a dropped event has no redelivery to save it.
      await work;
    }
  } catch {
    await work.catch(() => {});
  }
  return ok({ ok: true, received: events.length });
}));

// deno-lint-ignore no-explicit-any
async function processEvents(admin: any, events: any[]): Promise<void> {
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
      // ⚠️ A DECIDED CAMPAIGN NEVER GOES BACK TO PENDING. Twilio delivers these events out of
      // order — on 2026-09-02 the failure landed at 18:01:12.969 and the SUBMITTED event that
      // preceded it by Twilio's own clock arrived 246ms LATER, overwriting FAILED with PENDING.
      // The row then disagreed with itself for hours (`status` rejected, `campaign_status`
      // pending) and the screen it produced could not be reasoned about. A verdict is terminal
      // until our own code resubmits, which is the only thing that writes PENDING back.
      const settled = reg.campaign_status === "APPROVED" || reg.campaign_status === "FAILED";
      if (!(s === "PENDING" && settled)) patch.campaign_status = s;
      // ⚠️ PROMOTE FROM `campaign_failed` TOO. A rectified campaign is approved FROM the failed
      // state — that is the whole point of the free in-place resubmit — and gating this on
      // `campaign_pending` alone left the builder staring at "the carriers turned this one
      // down" over an APPROVED campaign, with no route to the number step, forever.
      if (s === "APPROVED" && ["campaign_pending", "campaign_failed"].includes(String(reg.status))) {
        patch.status = "campaign_approved";
        patch.next_poll_at = null;
        patch.needs_attention = false;
        patch.attention_note = null;
        patch.last_errors = [];
      }
      if (s === "FAILED") {
        patch.status = "campaign_failed";
        patch.next_poll_at = null;
        patch.needs_attention = true;
        patch.attention_note = "The carriers turned down the way this campaign describes its texting. Fix the wording and send it again — resending costs nothing.";
      }
      handled++;
    }
    // ⚠️ THE ONE THING THE BUILDER ACTUALLY NEEDS, AND IT USED TO BE THROWN AWAY. Twilio names
    // the failing fields (30908 PRIVACY_POLICY_URL, 30882 TERMS_AND_CONDITIONS_URL, …) right
    // here, and nothing stored them: `last_errors` was only ever written on the BRAND path, so
    // the rejection card rendered "They told us why. Fix what they named" over an empty list.
    // Two campaigns were refused for the same two fields without that ever reaching a screen.
    const campErrs = d.campaignregistrationerrors ?? d.campaignRegistrationErrors ?? null;
    if (Array.isArray(campErrs)) patch.last_errors = campErrs;
    // The CM… campaign SID, kept in its own column so it can never be confused with the QE…
    const cm = String(d.campaignsid ?? d.campaignSid ?? "");
    if (cm) patch.campaign_cm_sid = cm;

    if (Object.keys(patch).length > 1) {
      await admin.from("sms_registrations").update(patch).eq("client_id", reg.client_id);
    }
  }

  // ⚠️ Twilio's OWN connectivity test carries no A2P fields by design, and someone will press
  // that button many times while wiring a sink. Logging it as "unhandled" would turn a
  // healthy setup step into a repeating info row — and a repeating info row is the signal this
  // project uses to find real bugs, so polluting it has a cost beyond noise.
  const onlyTestEvents = events.every((e) => String(e?.type ?? "").endsWith(".test-event"));
  if (!handled && events.length && !onlyTestEvents) {
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
}
