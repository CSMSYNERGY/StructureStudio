import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { withErrorLog } from "../_shared/logError.ts";
import { sendTenantSms } from "../_shared/smsSend.ts";
import { sendTenantEmail } from "../_shared/emailSend.ts";
import { fillMergeFields } from "../_shared/crmRules.ts";

// CRM-RULES-TICK — the half of per-pipeline rules (migration 355) that needs a clock and a
// network. Two jobs, in this order:
//
//   1. THE SWEEP. crm_rules_sweep() finds cards whose elapsed rule has come due and runs it.
//      Nothing happens at the moment a rule becomes due, so somebody has to come and ask.
//   2. THE OUTBOX. A rule's "text the customer" / "email the customer" action is QUEUED by the
//      evaluator inside the database transaction and sent here.
//
// ⚠️ WHY THE SENDING IS NOT IN POSTGRES, which is where the rest of the evaluator lives: the
// evaluator runs inside the trigger that fired the event, whose exception handler ROLLS THE BLOCK
// BACK (302's designs_pipeline_sync is the pattern). A Twilio timeout in there would undo the
// card's status advance — the product's events would start failing because a text was slow. The
// queue cuts that tie: the Hub's writes commit, and the send is this function's problem, later.
//
// ⚠️ AND WHY IT IS CALLED BY THE PHONE WORKER: **pg_cron is not installed on this Supabase
// project.** CLAUDE.md records it as verified absent, and records the cost — `sync_all` carries a
// comment saying "Run by pg_cron every 10 minutes" and has therefore never run once, which is why
// a webhook routing bug stayed invisible for twelve days. The phone-api Worker's one-minute tick
// is the only real scheduler in the product; meeting-reminders borrows it and so does this. If you
// move this off that tick, say where it runs in this comment.
//
// ── AUTH ─────────────────────────────────────────────────────────────────────────────────────
// Door 1: Authorization: Bearer <service role key> verbatim. Door 2: a gateway-verified JWT whose
// role is service_role. `verify_jwt = true` in config.toml is what makes door 2 safe — the
// gateway checked the signature before this function was entered. There is no secret-header door,
// because the only caller is the Worker, which holds the service key; meeting-reminders' second
// door exists for a reason this function does not have.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

/** One invocation's caps. The tick is every five minutes, so a backlog drains quickly; an
 *  unbounded batch would risk the Worker's subrequest budget and this function's wall clock. */
const SWEEP_LIMIT = 200;
const SEND_PER_RUN = 40;
/**
 * How many times a queued message is retried before it is given up on.
 *
 * ⚠️ A CAP IS LOAD-BEARING HERE, in the direction that is easy to get backwards: a message with
 * no cap retries every five minutes for ever, and the failures that last are the ones where the
 * provider ACCEPTED something each time — a number that is billed on every attempt. Four tries
 * over twenty minutes is enough for a blip; past that a person needs to look, and the run log
 * says so.
 */
const MAX_ATTEMPTS = 4;

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function jwtRole(token: string): string | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const pad = part.replace(/-/g, "+").replace(/_/g, "/");
    const body = JSON.parse(atob(pad + "=".repeat((4 - pad.length % 4) % 4)));
    return typeof body?.role === "string" ? body.role : null;
  } catch {
    return null;
  }
}

function callerAllowed(authorization: string | null): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(String(authorization ?? "").trim());
  const presented = m ? m[1].trim() : "";
  if (!presented) return false;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (serviceKey && timingSafeEqual(presented, serviceKey)) return true;
  return jwtRole(presented) === "service_role";
}

/** The merge values for one card. Deliberately only the contact and the card — see
 *  RULE_MERGE_FIELDS: a field naming anything else is a way to put one customer's data in
 *  another's message. */
function mergeValues(contact: Record<string, unknown>, deal: Record<string, unknown>, business: string) {
  const name = String(contact?.name ?? "").trim();
  return {
    first_name: name ? name.split(/\s+/)[0] : "",
    name,
    company: String(contact?.company ?? "").trim(),
    business,
    deal_title: String(deal?.title ?? "").trim(),
  };
}

Deno.serve(withErrorLog("crm-rules-tick", async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!callerAllowed(req.headers.get("authorization"))) return json({ error: "unauthorized" }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // ── 1. THE SWEEP ───────────────────────────────────────────────────────────────────────────
  // crm_rules_sweep raises nothing a caller has to handle and records every firing itself. A
  // failure here must not stop the outbox: the two jobs are independent, and a message already
  // queued has nothing to do with whether new ones were found.
  let swept: number | null = null;
  let sweepError: string | null = null;
  try {
    const { data, error } = await admin.rpc("crm_rules_sweep", { p_limit: SWEEP_LIMIT });
    if (error) throw error;
    swept = typeof data === "number" ? data : Number(data ?? 0);
  } catch (e) {
    sweepError = (e as Error)?.message ?? String(e);
  }

  // ── 2. THE OUTBOX ──────────────────────────────────────────────────────────────────────────
  const { data: queued, error: qErr } = await admin.from("crm_rule_outbox")
    .select("id, client_id, deal_id, contact_id, kind, params, attempts")
    .eq("state", "queued").lte("attempts", MAX_ATTEMPTS - 1)
    .order("queued_at", { ascending: true }).limit(SEND_PER_RUN);
  if (qErr) {
    return json({ ok: false, swept, sweepError, error: "outbox unreadable", detail: qErr.message }, 500);
  }

  // Anything over the cap is given up on in the same pass, so it stops being picked up and the
  // run log says why rather than showing a message that is permanently "queued".
  const { data: spent } = await admin.from("crm_rule_outbox")
    .select("id").eq("state", "queued").gte("attempts", MAX_ATTEMPTS).limit(100);
  if (spent && spent.length) {
    await admin.from("crm_rule_outbox")
      .update({ state: "failed", last_error: `Gave up after ${MAX_ATTEMPTS} tries.` })
      .in("id", spent.map((r: { id: number }) => r.id));
  }

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (const row of (queued ?? [])) {
    const r = row as Record<string, unknown>;
    const id = r.id as number;
    const clientId = String(r.client_id);
    const attempts = Number(r.attempts ?? 0) + 1;
    const params = (r.params ?? {}) as Record<string, unknown>;

    // Claim it first. Two ticks overlapping (a slow run and the next one) would otherwise both
    // read the same row and send the customer the message twice.
    const { data: claimed } = await admin.from("crm_rule_outbox")
      .update({ attempts }).eq("id", id).eq("state", "queued").eq("attempts", attempts - 1)
      .select("id");
    if (!claimed || !claimed.length) continue;

    const fail = async (why: string, state: "failed" | "skipped" = "failed") => {
      await admin.from("crm_rule_outbox").update({
        state: attempts >= MAX_ATTEMPTS || state === "skipped" ? state : "queued",
        last_error: why.slice(0, 500),
      }).eq("id", id);
      if (state === "skipped") skipped++; else failed++;
    };

    const { data: deal } = await admin.from("crm_deals")
      .select("id, title, short_code, contact_id").eq("client_id", clientId).eq("id", r.deal_id).maybeSingle();
    const { data: contact } = await admin.from("crm_contacts")
      .select("id, name, company, phone, email").eq("client_id", clientId).eq("id", r.contact_id).maybeSingle();
    if (!deal || !contact) {
      // The card or the customer was deleted between the rule firing and this tick. Not a
      // failure to retry — there is nobody to send to.
      await fail("The card or the customer is no longer there.", "skipped");
      continue;
    }

    const { data: settings } = await admin.from("client_settings")
      .select("business_name").eq("client_id", clientId).maybeSingle();
    const vals = mergeValues(contact as Record<string, unknown>, deal as Record<string, unknown>,
      String(settings?.business_name ?? ""));

    try {
      if (r.kind === "send_sms") {
        const phone = String((contact as Record<string, unknown>).phone ?? "").trim();
        if (!phone) { await fail("That customer has no phone number.", "skipped"); continue; }
        // ⚠️ bypassQuietHours IS FALSE, and must stay false. smsSend.ts says so in as many
        // words: the flag is for a person pressing a button on one customer, "never for
        // automation". A rule is automation by definition, so a rule's text waits for the
        // morning. It is written out rather than left absent because absent already means
        // gated, and `smsQuietHoursWiring_test` requires every sender to say which it is — so
        // that a new caller has to decide instead of inheriting a default.
        const out = await sendTenantSms(admin, clientId, {
          toPhone: phone,
          body: fillMergeFields(String(params.body ?? ""), vals),
          contactId: String(contact.id),
          shortCode: (deal as Record<string, unknown>).short_code as string | null,
          bypassQuietHours: false,
        });
        if (out.sent) {
          await admin.from("crm_rule_outbox").update({ state: "sent", sent_at: new Date().toISOString(), last_error: null }).eq("id", id);
          sent++;
        } else if (out.reason === "opted_out" || out.reason === "no_consent" || out.reason === "bad_number"
                   || out.reason === "damaged_number" || out.reason === "not_active") {
          // A REFUSAL IS NOT A FAILURE. Opted out, no consent, a number that cannot be dialled,
          // texting not switched on for this builder: retrying changes none of them, and marking
          // them 'failed' would fill a builder's log with alarm about the product working
          // correctly. Quiet hours is the one that IS retried — it is true now and false later.
          await fail(out.error ?? `Not sent: ${out.reason}.`, "skipped");
        } else {
          await fail(out.error ?? `Not sent: ${out.reason ?? "unknown"}.`);
        }
      } else {
        const email = String((contact as Record<string, unknown>).email ?? "").trim();
        if (!email) { await fail("That customer has no email address.", "skipped"); continue; }
        // kind 'conversation': a rule's email IS a message to the customer and belongs in their
        // thread. There is no 'rule' kind, and adding one would mean a migration on
        // email_sends.kind plus the union in emailSend.ts — for a send that is exactly a
        // conversation email with nobody typing it.
        const body = fillMergeFields(String(params.body ?? ""), vals);
        const out = await sendTenantEmail(admin, clientId, {
          kind: "conversation",
          to: email,
          subject: fillMergeFields(String(params.subject ?? ""), vals),
          // The builder typed plain text, and `html` is required. ESCAPED, not interpolated: the
          // body is builder-authored but the MERGE VALUES are a customer's own name and company,
          // so an apostrophe or an angle bracket in somebody's business name must not become
          // markup in every other customer's email.
          html: `<div style="font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#1E293B">${
            body.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string))
              .replace(/\r?\n/g, "<br>")
          }</div>`,
          text: body,
          contactId: String(contact.id),
          shortCode: (deal as Record<string, unknown>).short_code as string | null,
        });
        if (out.sent) {
          await admin.from("crm_rule_outbox").update({ state: "sent", sent_at: new Date().toISOString(), last_error: null }).eq("id", id);
          sent++;
        } else if (out.reason === "not_active") {
          await fail("Email isn't switched on for this account yet.", "skipped");
        } else {
          await fail(out.error ?? `Not sent: ${out.reason ?? "unknown"}.`);
        }
      }
    } catch (e) {
      await fail((e as Error)?.message ?? String(e));
    }
  }

  return json({ ok: true, swept, sweepError, sent, failed, skipped, considered: (queued ?? []).length });
}));
