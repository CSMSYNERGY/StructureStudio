import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { withErrorLog } from "../_shared/logError.ts";
import { sendTenantSms } from "../_shared/smsSend.ts";
import { sendTenantEmail } from "../_shared/emailSend.ts";
import { fillMergeFields } from "../_shared/crmRules.ts";
import { sendTeamNote, teamEmails } from "../_shared/leadFormMail.ts";
import { unsubscribeUrl } from "../_shared/unsubscribe.ts";

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
 * A claim lasts this long (migration 363's leased_until). Shorter than the five-minute tick, so a
 * row whose tick died comes back on the next one; long enough that the tick that holds it always
 * finishes first. It replaced the attempts-claim, which could only ever move FORWARD — so a
 * refusal that is not a failure (quiet hours) had nowhere to go but towards "gave up".
 */
const LEASE_MS = 4 * 60_000;
/**
 * How long a message waits after each failed try before the next one, in minutes (2026-11-06).
 *
 * ⚠️ WHY IT CHANGED: it used to be four tries five minutes apart, so any outage longer than
 * twenty minutes (Resend's or Twilio's) dropped every automated email and text queued in it, for
 * good. Now the waits grow, and the last try is about 22 hours after the first. That stays inside
 * Resend's 24-hour memory of an Idempotency-Key, which is what stops a retry of an email that did
 * go out (its answer lost to a timeout) from sending a second copy.
 *
 * Each wait is a minute short of a whole number of five-minute ticks, so the row is free again
 * just before the tick that should pick it up rather than just after it.
 *
 * The wait rides on `leased_until`, the claim lease, and NOT on `hold_until`: the run log reads
 * hold_until as "outside texting hours where they live", which a retry is not. A row waiting for
 * its next try shows as "queued — waiting to go out", which it is.
 */
const RETRY_AFTER_MIN = [4, 14, 29, 59, 119, 239, 359, 479];
/**
 * How many times a queued message is tried before it is given up on: one first try plus one per
 * wait above, so nine.
 *
 * ⚠️ A CAP IS STILL LOAD-BEARING HERE, in the direction that is easy to get backwards: a message
 * with no cap retries for ever, and the failures that last are the ones where the provider
 * ACCEPTED something each time — a number that is billed on every attempt. The text's proof check
 * below (an earlier try that already went out is marked sent, not sent again) and the email and
 * team-note keys keep that rare; the cap bounds it. Past the last try a person needs to look, and
 * the run log says so. A refusal that no retry can change stops at once (see `permanent` below),
 * and a rule paused or removed meanwhile stops its queued messages.
 */
const MAX_ATTEMPTS = RETRY_AFTER_MIN.length + 1;
/**
 * Stop starting new messages once this run is this old (2026-11-06). A send that hangs now ends at
 * resend.ts's 30 s bound instead of running on, but forty hung sends would still outlast the edge
 * runtime's wall clock. A row this run never claimed loses nothing: it keeps its attempts and its
 * place, and the next tick takes it.
 */
const RUN_BUDGET_MS = 150_000;

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
function mergeValues(contact: Record<string, unknown>, deal: Record<string, unknown> | null, business: string) {
  const name = String(contact?.name ?? "").trim();
  return {
    first_name: name ? name.split(/\s+/)[0] : "",
    name,
    company: String(contact?.company ?? "").trim(),
    business,
    // A customer rule's message has no card, so this is blank rather than missing.
    deal_title: String(deal?.title ?? "").trim(),
  };
}

Deno.serve(withErrorLog("crm-rules-tick", async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!callerAllowed(req.headers.get("authorization"))) return json({ error: "unauthorized" }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let sweepErrorPre: string | null = null;

  // ── 0. THE FACTS (migration 365) ───────────────────────────────────────────────────────────
  // A missed call, a text in, a tag added, a meeting booked… are QUEUED by triggers on the tables
  // that record them (never evaluated in that write — the phone Worker is waiting on it) and fired
  // here. Before the sweep, so a fact and a clock due on the same tick run in the order they came.
  let drained: number | null = null;
  try {
    const { data, error } = await admin.rpc("crm_rules_drain_events", { p_limit: 300 });
    if (error) throw error;
    drained = Number(data ?? 0);
  } catch (e) {
    sweepErrorPre = (e as Error)?.message ?? String(e);
  }

  // ── 1. THE SWEEP ───────────────────────────────────────────────────────────────────────────
  // crm_rules_sweep raises nothing a caller has to handle and records every firing itself. A
  // failure here must not stop the outbox: the two jobs are independent, and a message already
  // queued has nothing to do with whether new ones were found.
  let swept: number | null = null;
  let sweepError: string | null = sweepErrorPre;
  try {
    const { data, error } = await admin.rpc("crm_rules_sweep", { p_limit: SWEEP_LIMIT });
    if (error) throw error;
    swept = typeof data === "number" ? data : Number(data ?? 0);
  } catch (e) {
    sweepError = (e as Error)?.message ?? String(e);
  }

  // ── 2. THE OUTBOX ──────────────────────────────────────────────────────────────────────────
  // Due = queued, not waiting for a customer's morning (hold_until), not claimed by a tick that is
  // still running (leased_until), and not out of attempts.
  const nowIso = new Date().toISOString();
  const { data: queued, error: qErr } = await admin.from("crm_rule_outbox")
    .select("id, rule_id, client_id, deal_id, contact_id, kind, params, attempts, queued_at")
    .eq("state", "queued").lte("attempts", MAX_ATTEMPTS - 1)
    .or(`hold_until.is.null,hold_until.lte.${nowIso}`)
    .or(`leased_until.is.null,leased_until.lt.${nowIso}`)
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
      .update({ state: "failed", last_error: `Gave up after ${MAX_ATTEMPTS} tries.`, leased_until: null })
      .in("id", spent.map((r: { id: number }) => r.id));
  }

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let held = 0;
  let recovered = 0;
  let deferred = 0;
  const runStarted = Date.now();
  for (const row of (queued ?? [])) {
    // See RUN_BUDGET_MS: what is left waits for the next tick, unclaimed and untouched.
    if (Date.now() - runStarted > RUN_BUDGET_MS) { deferred++; continue; }
    const r = row as Record<string, unknown>;
    const id = r.id as number;
    const clientId = String(r.client_id);
    const before = Number(r.attempts ?? 0);
    const attempts = before + 1;
    const params = (r.params ?? {}) as Record<string, unknown>;

    // CLAIM IT FIRST, with a lease and one attempt. Two ticks overlapping (a slow run and the
    // next one) would otherwise both read the row and send the customer the message twice.
    const leaseIso = new Date(Date.now() + LEASE_MS).toISOString();
    const { data: claimed } = await admin.from("crm_rule_outbox")
      .update({ attempts, leased_until: leaseIso })
      .eq("id", id).eq("state", "queued").eq("attempts", before)
      .or(`leased_until.is.null,leased_until.lt.${new Date().toISOString()}`)
      .select("id");
    if (!claimed || !claimed.length) continue;

    const done = async (patch: Record<string, unknown>) => {
      await admin.from("crm_rule_outbox").update({ ...patch, leased_until: null }).eq("id", id);
    };
    // `permanent`: the provider refused in a way no retry changes, so stop now (2026-11-06).
    const fail = async (why: string, state: "failed" | "skipped" = "failed", permanent = false) => {
      const last_error = why.slice(0, 500);
      if (state === "failed" && !permanent && attempts < MAX_ATTEMPTS) {
        // Back in the queue, but not before its next try is due (see RETRY_AFTER_MIN). hold_until is
        // cleared: a text that waited for the morning and then failed is retrying now, and the run
        // log would otherwise keep calling it "outside texting hours" all day.
        const waitMin = RETRY_AFTER_MIN[Math.min(attempts, RETRY_AFTER_MIN.length) - 1];
        await admin.from("crm_rule_outbox").update({
          state: "queued",
          last_error,
          hold_until: null,
          leased_until: new Date(Date.now() + waitMin * 60_000).toISOString(),
        }).eq("id", id);
      } else {
        await done({ state, last_error });
      }
      if (state === "skipped") skipped++; else failed++;
    };
    const markSent = async (note: string | null = null) => {
      await done({ state: "sent", sent_at: new Date().toISOString(), last_error: note });
    };

    // ⛔ A PAUSED OR REMOVED RULE SENDS NOTHING MORE (2026-11-06). The row was queued while the rule
    // was on; if the builder has since paused it ("it will not run") or removed it, its queued
    // messages stop here. This mattered little while a failing message gave up in twenty minutes;
    // with a day of retries, a builder who switches off a rule that texted the wrong people during
    // an outage would otherwise see every one of those messages go out when sending came back.
    if (r.rule_id) {
      const { data: rule, error: ruleErr } = await admin.from("crm_rules").select("enabled, archived_at")
        .eq("client_id", clientId).eq("id", r.rule_id).maybeSingle();
      // A read that FAILED is not a rule that is gone: back on the retry schedule, never "skipped".
      if (ruleErr) {
        await fail(`Could not check the rule: ${ruleErr.message ?? "read failed"}`);
        continue;
      }
      if (!rule || rule.enabled === false || rule.archived_at) {
        await fail("The rule was paused or removed, so this was not sent.", "skipped");
        continue;
      }
    }

    // A customer rule's message has no card (363); a card is read only when the row names one.
    const { data: deal } = r.deal_id
      ? await admin.from("crm_deals").select("id, title, short_code, contact_id").eq("client_id", clientId).eq("id", r.deal_id).maybeSingle()
      : { data: null };
    const { data: contact } = r.contact_id
      ? await admin.from("crm_contacts").select("id, name, company, phone, email, dnd_all_at, dnd_email_at").eq("client_id", clientId).eq("id", r.contact_id).maybeSingle()
      : { data: null };
    // "Email your team" (365) may have no customer at all — a rule for nobody.
    if ((r.contact_id && !contact) || (r.deal_id && !deal) || (r.kind !== "notify_team" && !contact)) {
      // The card or the customer was deleted between the rule firing and this tick. Not a
      // failure to retry — there is nobody to send to.
      await fail("The card or the customer is no longer there.", "skipped");
      continue;
    }

    const { data: settings } = await admin.from("client_settings")
      .select("business_name").eq("client_id", clientId).maybeSingle();
    const vals = mergeValues((contact ?? {}) as Record<string, unknown>, deal as Record<string, unknown> | null,
      String(settings?.business_name ?? ""));
    const shortCode = ((deal as Record<string, unknown> | null)?.short_code as string | null) ?? null;

    // ⛔ DO NOT DISTURB (366): the customer's own panel, checked before anything goes to them. A
    // refusal, not a failure — nothing about it changes on a retry. (Texting's own STOP is smsSend's.)
    const cc = (contact ?? {}) as Record<string, unknown>;
    if ((r.kind === "send_sms" || r.kind === "send_email") && cc.dnd_all_at) {
      await fail("Do Not Disturb is on for this customer.", "skipped");
      continue;
    }
    if (r.kind === "send_email" && cc.dnd_email_at) {
      await fail("Email is off for this customer (Do Not Disturb).", "skipped");
      continue;
    }

    try {
      if (r.kind === "notify_team") {
        // To the people the rule names, or the owners and admins when it names none.
        const to = await teamEmails(admin, clientId, Array.isArray(params.userIds) ? (params.userIds as string[]) : []);
        const c = (contact ?? null) as Record<string, unknown> | null;
        const about = c ? `\n\nCustomer: ${[c.name, c.phone, c.email].filter(Boolean).join(" · ")}` : "";
        // Keyed on this row (2026-11-06), so a retry after a lost answer is not a second copy.
        const out = await sendTeamNote(clientId, to,
          fillMergeFields(String(params.subject ?? ""), vals),
          fillMergeFields(String(params.body ?? ""), vals) + about,
          `crm-outbox/${id}`);
        if (out.sent > 0) { await markSent(out.error); sent++; }
        else if (out.error === "platform email is not configured" || out.error === "no recipient") {
          await fail(out.error === "no recipient" ? "Nobody on your team has an email address to send to." : "Team email isn't switched on yet.", "skipped");
        } else await fail(out.error ?? "Not sent.");
      } else if (r.kind === "send_sms") {
        const phone = String((contact as Record<string, unknown>).phone ?? "").trim();
        if (!phone) { await fail("That customer has no phone number.", "skipped"); continue; }
        const body = fillMergeFields(String(params.body ?? ""), vals);
        // ⚠️ DID THE LAST ATTEMPT ACTUALLY GO OUT? A tick that died after Twilio accepted the text
        // but before it marked this row sent leaves it queued, and the lease hands it to the next
        // tick. Twilio's message id on a matching row is the proof; without this, that customer
        // gets the same text twice.
        if (before > 0) {
          const { data: prior } = await admin.from("sms_messages").select("id")
            .eq("client_id", clientId).eq("contact_id", contact!.id).eq("direction", "out")
            .eq("body", body).gte("created_at", String(r.queued_at)).not("provider_sid", "is", null).limit(1);
          if (prior && prior.length) { await markSent("Recovered: it had already gone out."); recovered++; continue; }
        }
        // ⚠️ bypassQuietHours IS FALSE, and must stay false. smsSend.ts says so in as many
        // words: the flag is for a person pressing a button on one customer, "never for
        // automation". A rule is automation by definition, so a rule's text waits for the
        // morning. It is written out rather than left absent because absent already means
        // gated, and `smsQuietHoursWiring_test` requires every sender to say which it is — so
        // that a new caller has to decide instead of inheriting a default.
        const out = await sendTenantSms(admin, clientId, {
          toPhone: phone,
          body,
          contactId: String(contact!.id),
          shortCode,
          bypassQuietHours: false,
        });
        if (out.sent) {
          await markSent();
          sent++;
        } else if (out.reason === "quiet_hours") {
          // ⚠️ WAITING IS NOT FAILING (the 2026-11-04 bug). Park it until 8am where the customer
          // lives, and hand back the attempt this pass took: before 363 this went down the retry
          // path, used all four attempts in twenty minutes, and the text was silently dropped.
          await done({
            attempts: before,
            hold_until: out.retryAt ?? new Date(Date.now() + 60 * 60_000).toISOString(),
            last_error: "Waiting for 8am where the customer lives.",
          });
          held++;
        } else if (out.reason === "opted_out" || out.reason === "no_consent" || out.reason === "bad_number"
                   || out.reason === "damaged_number" || out.reason === "not_active") {
          // A REFUSAL IS NOT A FAILURE. Opted out, no consent, a number that cannot be dialled,
          // texting not switched on for this builder: retrying changes none of them, and marking
          // them 'failed' would fill a builder's log with alarm about the product working
          // correctly.
          await fail(out.error ?? `Not sent: ${out.reason}.`, "skipped");
        } else {
          await fail(out.error ?? `Not sent: ${out.reason ?? "unknown"}.`);
        }
      } else {
        const email = String((contact as Record<string, unknown>).email ?? "").trim();
        if (!email) { await fail("That customer has no email address.", "skipped"); continue; }
        const subject = fillMergeFields(String(params.subject ?? ""), vals);
        // ⚠️ NO SUBJECT-MATCH PROOF FOR EMAIL ANY MORE (2026-11-06). There used to be one, like the
        // text's above: any sent email to this customer with the same subject since this row was
        // queued counted as this one. It matched on nothing unique to the row, so a DIFFERENT rule's
        // email with the same subject wording — common, "An update from {{business}}" — sent while this
        // one was retrying marked it "Recovered" and its words never went. With a day of retries that
        // overlap stopped being rare. The Idempotency-Key below does the proof's job exactly: a try of
        // THIS email that did go out is answered by Resend with its first id and is not sent again.
        // ⚠️ THE UNSUBSCRIBE LINK (366), on every automated email: in the footer, and as the
        // List-Unsubscribe header Gmail and Apple Mail turn into their own button. It sets this
        // customer's Email box, which the check above refuses on. The builder never writes it.
        const unsub = await unsubscribeUrl(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, clientId, String(contact!.id));
        const biz = String(settings?.business_name ?? "").trim() || "us";
        // kind 'conversation': a rule's email IS a message to the customer and belongs in their
        // thread. There is no 'rule' kind, and adding one would mean a migration on
        // email_sends.kind plus the union in emailSend.ts — for a send that is exactly a
        // conversation email with nobody typing it.
        const body = fillMergeFields(String(params.body ?? ""), vals);
        const out = await sendTenantEmail(admin, clientId, {
          kind: "conversation",
          to: email,
          subject,
          // The builder typed plain text, and `html` is required. ESCAPED, not interpolated: the
          // body is builder-authored but the MERGE VALUES are a customer's own name and company,
          // so an apostrophe or an angle bracket in somebody's business name must not become
          // markup in every other customer's email.
          html: `<div style="font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#1E293B">${
            body.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string))
              .replace(/\r?\n/g, "<br>")
          }</div><p style="font:12px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#94A3B8;margin-top:24px">You're getting this from ${
            biz.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string))
          }. <a href="${unsub}" style="color:#64748B">Unsubscribe</a></p>`,
          text: `${body}\n\n--\nYou're getting this from ${biz}. Unsubscribe: ${unsub}`,
          headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
          contactId: String(contact!.id),
          shortCode,
          // ONE KEY FOR EVERY TRY OF THIS ROW (2026-11-06). Whether a try went out and was recorded,
          // or went out while we stopped listening (a timeout, which leaves no id anywhere), Resend
          // answers the next try with the first send instead of a second email. The schedule's last
          // try (about 22 h) is inside the 24 h Resend remembers a key for.
          idempotencyKey: `crm-outbox/${id}`,
        });
        if (out.sent) {
          await markSent();
          sent++;
        } else if (out.reason === "not_active") {
          await fail("Email isn't switched on for this account yet.", "skipped");
        } else {
          await fail(out.error ?? `Not sent: ${out.reason ?? "unknown"}.`, "failed", out.permanent === true);
        }
      }
    } catch (e) {
      await fail((e as Error)?.message ?? String(e));
    }
  }

  return json({ ok: true, drained, swept, sweepError, sent, failed, skipped, held, recovered, deferred, considered: (queued ?? []).length });
}));
