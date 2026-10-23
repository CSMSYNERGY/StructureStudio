import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { logEdgeError, withErrorLog } from "../_shared/logError.ts";
import { clientIp } from "../_shared/adminGate.ts";
import { smsConsentSentence } from "../_shared/smsConsentText.ts";
import { checkSubmission, cleanDefinition, cleanSettings, isUuid, submissionNote, type FormDefinition } from "../_shared/leadForms.ts";
import { companyTokens, loadTemplate, sendAutoreply, sendLeadAlert, teamEmails } from "../_shared/leadFormMail.ts";

// lead-form: the PUBLIC side of website lead forms (migration 325, Settings → Customer Hub →
// Forms). verify_jwt = false: a builder's website visitor has no session. Three actions, all keyed
// by (clientId, formId) and both checked against the database before anything is read or written:
//
//   load    the PUBLISHED definition (never the draft), the builder's name and logo, the texting
//           consent sentence, and the live catalog labels for Building style / size. Counts a view.
//   start   the visitor touched a field. Counts a start (no PII).
//   submit  validate against the published definition ON THE SERVER, store the submission FIRST,
//           then contact → note → deal → consent → GHL → emails, each best-effort.
//
// THE CONSENT SENTENCE IS OURS, NOT THE BROWSER'S. load returns smsConsentSentence(name) and submit
// files the same server-built sentence as evidence — a public caller never chooses the words that
// get stored as this builder's proof of permission (capture-lead accepts browser text and has to
// police it; this function never needs to).
//
// ABUSE: the capture-lead Guard 1 shape — a per-tenant cap on submissions per minute, checked
// BEFORE any write, index-backed by lead_form_submissions_client. Plus a honeypot field and a
// minimum time-to-submit: a submission failing either is stored with spam = true (so a builder can
// see what was caught) and creates no contact, sends no email, touches no CRM.

const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_TENANT = 30;
const MIN_FILL_MS = 2_500;
const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";

const ten = (digits: string) => digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits.slice(-10);
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

// deno-lint-ignore no-explicit-any
type Db = any;

async function catalogLabels(sb: Db, clientId: string, def: FormDefinition) {
  const wantStyles = def.fields.some((f) => f.type === "building_style");
  const wantSizes = def.fields.some((f) => f.type === "building_size");
  const [styles, sizes] = await Promise.all([
    wantStyles ? sb.from("building_styles").select("label, sort_order").eq("client_id", clientId).eq("active", true).order("sort_order") : { data: [] },
    wantSizes ? sb.from("building_sizes").select("label, width_ft, length_ft").eq("client_id", clientId).eq("active", true).order("width_ft").order("length_ft") : { data: [] },
  ]);
  const uniq = (xs: string[]) => [...new Set(xs.map((x) => String(x || "").trim()).filter(Boolean))].slice(0, 200);
  return {
    styles: uniq((styles.data ?? []).map((r: { label: string }) => r.label)),
    sizes: uniq((sizes.data ?? []).map((r: { label: string }) => r.label)),
  };
}

Deno.serve(withErrorLog("lead-form", async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  // deno-lint-ignore no-explicit-any
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  const action = ["load", "start", "submit"].includes(body?.action) ? body.action as string : "";
  const clientId = str(body?.clientId, 64).toLowerCase();
  const formId = str(body?.formId, 40);
  if (!action) return json({ error: "Unknown action." }, 400);
  if (!/^[a-z0-9-]{1,64}$/.test(clientId) || !isUuid(formId)) return json({ ok: false, reason: "not_found" }, 404);

  const sb = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: form } = await sb.from("lead_forms")
    .select("id, client_id, name, status, published_definition, published_version, settings")
    .eq("client_id", clientId).eq("id", formId).maybeSingle();
  if (!form || form.status !== "published" || !form.published_definition) return json({ ok: false, reason: "not_found" }, 404);

  const def = cleanDefinition(form.published_definition, SB_URL);
  const settings = cleanSettings(form.settings);
  const closed = !!settings.closesAt && settings.closesAt < new Date().toISOString().slice(0, 10);
  const bump = (kind: "views" | "starts" | "submits") =>
    sb.rpc("lead_form_bump", { p_form_id: form.id, p_client_id: clientId, p_kind: kind }).then(() => undefined, () => undefined);

  // ── load ───────────────────────────────────────────────────────────────────────────────────
  if (action === "load") {
    const [{ data: cs }, catalog, company] = await Promise.all([
      sb.from("client_settings").select("lead_sms_consent_box").eq("client_id", clientId).maybeSingle(),
      catalogLabels(sb, clientId, def),
      companyTokens(sb, clientId),
    ]);
    const smsBoxOn = cs?.lead_sms_consent_box !== false;
    // A builder who switched the texting box off (Settings, migration 242) gets no box here either.
    const fields = smsBoxOn ? def.fields : def.fields.filter((f) => f.type !== "sms_consent");
    await bump("views");
    return json({
      ok: true,
      form: {
        id: form.id, name: form.name, version: form.published_version, closed,
        definition: { ...def, fields },
        afterSubmit: settings.afterSubmit,
        captureUtm: settings.captureUtm,
      },
      branding: { companyName: company.name, logoUrl: company.logoUrl },
      consentSentence: smsBoxOn ? smsConsentSentence(company.name) : null,
      catalog,
    });
  }

  if (action === "start") {
    await bump("starts");
    return json({ ok: true });
  }

  // ── submit ─────────────────────────────────────────────────────────────────────────────────
  if (closed) return json({ ok: false, reason: "closed", error: "This form is no longer taking submissions." }, 410);

  // Guard 1, before ANY write.
  const since = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
  const { count: recent } = await sb.from("lead_form_submissions").select("id", { count: "exact", head: true })
    .eq("client_id", clientId).gte("created_at", since);
  if ((recent ?? 0) >= RATE_MAX_PER_TENANT) {
    if ((recent ?? 0) <= RATE_MAX_PER_TENANT + 2) {
      await logEdgeError({ fn: "lead-form", req, clientId, code: "rate_limited", severity: "info", message: `lead form submissions over ${RATE_MAX_PER_TENANT}/min for this builder - refused` });
    }
    return json({ ok: false, reason: "busy", error: "We're getting a lot of requests right now. Please try again in a minute." }, 429);
  }

  const startedAt = new Date().toISOString();
  const [{ data: cs }, catalog] = await Promise.all([
    sb.from("client_settings").select("lead_sms_consent_box, ghl_location_id, ghl_api_key").eq("client_id", clientId).maybeSingle(),
    catalogLabels(sb, clientId, def),
  ]);
  const smsBoxOn = cs?.lead_sms_consent_box !== false;
  const checked = checkSubmission(def, body?.answers, catalog);
  if (Object.keys(checked.errors).length) return json({ ok: false, reason: "invalid", errors: checked.errors }, 422);

  const pageUrlRaw = str(body?.pageUrl, 500);
  const pageUrl = /^https?:\/\//i.test(pageUrlRaw) ? pageUrlRaw : null;
  const refRaw = str(body?.referrer, 500);
  const referrer = /^https?:\/\//i.test(refRaw) ? refRaw : null;
  const utm: Record<string, string> = {};
  if (settings.captureUtm && body?.utm && typeof body.utm === "object") {
    for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid"]) {
      const v = str(body.utm[k], 200);
      if (v) utm[k] = v;
    }
  }
  // Hidden fields fill from the page's own query string (or a fixed value), never from free text.
  for (const f of def.fields) {
    if (f.type !== "hidden") continue;
    const v = f.source === "static" ? (f.value || "") : (utm[f.source || ""] || "");
    if (v) checked.answers.push({ id: f.id, label: f.label, type: "hidden", value: v });
  }
  const honeypot = str(body?.hp, 200);
  const elapsed = Number(body?.elapsedMs);
  const spamReason = honeypot ? "honeypot" : (Number.isFinite(elapsed) && elapsed < MIN_FILL_MS ? "too_fast" : null);

  // The submission FIRST, so a lead survives any later failure.
  const { data: sub, error: subErr } = await sb.from("lead_form_submissions").insert({
    client_id: clientId, form_id: form.id, form_version: form.published_version,
    answers: checked.answers, page_url: pageUrl, referrer, utm, spam: !!spamReason, spam_reason: spamReason,
  }).select("id").single();
  if (subErr || !sub) {
    await logEdgeError({ fn: "lead-form", req, clientId, code: "submission_insert", message: `lead form submission not saved: ${subErr?.message ?? "no row"}` });
    return json({ ok: false, error: "We couldn't send that. Please try again." }, 500);
  }
  await bump("submits");
  if (spamReason) return json({ ok: true, afterSubmit: settings.afterSubmit });

  const c = checked.contact;
  const phoneDigits = (c.phone || "").replace(/\D/g, "");
  let contactId: string | null = null;
  let dealId: string | null = null;

  // ── contact, note, deal ────────────────────────────────────────────────────────────────────
  if (c.email || phoneDigits.length >= 10) {
    try {
      const { data: crmId, error: crmErr } = await sb.rpc("crm_ensure_contact", {
        p_client_id: clientId, p_name: c.name || null, p_phone: phoneDigits.length >= 10 ? c.phone : null, p_email: c.email || null,
      });
      if (crmErr) throw crmErr;
      contactId = crmId || null;
      if (contactId) {
        const { data: row } = await sb.from("crm_contacts").select("street, city, state, zip, company, owner_user_id, created_at").eq("id", contactId).maybeSingle();
        // Enrich, never blank, never clobber (crm_ensure_contact's own rule, for the fields it does not take).
        const patch: Record<string, unknown> = {};
        for (const k of ["street", "city", "state", "zip", "company"] as const) if (c[k] && !row?.[k]) patch[k] = c[k];
        if (row && row.created_at >= startedAt) patch.source = "form";
        if (settings.assignUserId && !row?.owner_user_id) {
          const { data: member } = await sb.from("client_users").select("user_id").eq("client_id", clientId).eq("user_id", settings.assignUserId).maybeSingle();
          if (member) patch.owner_user_id = settings.assignUserId;
        }
        if (Object.keys(patch).length) await sb.from("crm_contacts").update(patch).eq("id", contactId).eq("client_id", clientId);
        const { error: noteErr } = await sb.from("crm_notes").insert({
          client_id: clientId, contact_id: contactId, body: submissionNote(form.name, checked.answers, pageUrl), pinned: false, created_by: null,
        });
        if (noteErr) await logEdgeError({ fn: "lead-form", req, clientId, code: "note", message: `lead form note failed: ${noteErr.message}` });
        if (settings.pipelineId && settings.stageId) {
          const { data: stage } = await sb.from("crm_pipeline_stages").select("id, pipeline_id, archived_at")
            .eq("client_id", clientId).eq("id", settings.stageId).eq("pipeline_id", settings.pipelineId).maybeSingle();
          const { data: pipe } = await sb.from("crm_pipelines").select("id, archived_at").eq("client_id", clientId).eq("id", settings.pipelineId).maybeSingle();
          if (stage && !stage.archived_at && pipe && !pipe.archived_at) {
            const { data: deal, error: dealErr } = await sb.from("crm_deals").insert({
              client_id: clientId, pipeline_id: settings.pipelineId, stage_id: settings.stageId, contact_id: contactId,
              title: `${form.name}${c.name ? ` — ${c.name}` : ""}`.slice(0, 200), source: "form",
            }).select("id").single();
            if (dealErr) await logEdgeError({ fn: "lead-form", req, clientId, code: "deal", message: `lead form deal failed: ${dealErr.message}` });
            dealId = deal?.id ?? null;
          } else {
            await logEdgeError({ fn: "lead-form", req, clientId, code: "deal_stage_gone", severity: "info", message: "lead form's pipeline stage is archived or gone - no card made" });
          }
        }
        await sb.from("lead_form_submissions").update({ contact_id: contactId, deal_id: dealId }).eq("id", sub.id);
      }
    } catch (e) {
      await logEdgeError({ fn: "lead-form", req, clientId, code: "crm_link", message: `lead form contact failed - submission saved unlinked: ${(e as Error).message}` });
    }
  }

  // ── texting consent (the capture-lead rules: one grant per tenant+phone, never touches opt-outs) ──
  if (checked.smsConsent && smsBoxOn && phoneDigits.length >= 10) {
    const company = await companyTokens(sb, clientId);
    const tenDigits = ten(phoneDigits);
    const { data: prior } = await sb.from("sms_consent_log").select("id")
      .eq("client_id", clientId).eq("phone_digits", tenDigits).eq("action", "granted").limit(1).maybeSingle();
    if (!prior) {
      const { error: consentErr } = await sb.from("sms_consent_log").insert({
        client_id: clientId, phone_digits: tenDigits, action: "granted", source: "web_form",
        disclosure_text: smsConsentSentence(company.name), consent_url: pageUrl,
        ip: clientIp(req), user_agent: (req.headers.get("user-agent") || "").slice(0, 300),
        detail: { name: c.name || null, formId: form.id, submissionId: sub.id },
      });
      if (consentErr) await logEdgeError({ fn: "lead-form", req, clientId, code: "consent_insert", message: `sms_consent_log insert failed: ${consentErr.message}` });
    }
  }

  // ── GHL, best-effort, when the builder has it connected ────────────────────────────────────
  const ghlWork = (async () => {
    if (!cs?.ghl_location_id || !cs?.ghl_api_key || !(c.email || phoneDigits.length >= 10)) return;
    try {
      const r = await fetch("https://services.leadconnectorhq.com/contacts/upsert", {
        method: "POST",
        headers: { "Version": "2021-07-28", "Authorization": `Bearer ${cs.ghl_api_key}`, "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({
          ...(c.name ? { name: c.name } : {}), ...(c.first_name ? { firstName: c.first_name } : {}), ...(c.last_name ? { lastName: c.last_name } : {}),
          ...(phoneDigits.length >= 10 ? { phone: c.phone } : {}), ...(c.email ? { email: c.email } : {}),
          ...(c.street ? { address1: c.street } : {}), ...(c.city ? { city: c.city } : {}), ...(c.state ? { state: c.state } : {}),
          ...(c.zip ? { postalCode: c.zip } : {}), ...(c.company ? { companyName: c.company } : {}),
          locationId: cs.ghl_location_id, source: `Website form: ${form.name}`.slice(0, 100),
          tags: ["structurestudio-lead", "website-form"],
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) {
        await logEdgeError({ fn: "lead-form", req, clientId, code: `ghl_${r.status}`, severity: (r.status === 401 || r.status === 403) ? "info" : "error",
          message: `GHL contact upsert failed (${r.status}) - lead saved locally only` });
      }
    } catch (e) {
      await logEdgeError({ fn: "lead-form", req, clientId, code: "ghl_error", message: `GHL contact upsert threw - lead saved locally only: ${(e as Error).message}` });
    }
  })();

  // ── emails ─────────────────────────────────────────────────────────────────────────────────
  const mailWork = (async () => {
    const company = await companyTokens(sb, clientId);
    const tokens = {
      contact: { first_name: c.first_name || (c.name || "").split(/\s+/)[0] || "", name: c.name || c.email || "", email: c.email || "", phone: c.phone || "" },
      company,
      form: { name: form.name, answers: checked.answers.filter((a) => a.type !== "hidden").map((a) => ({ label: a.label, value: a.value })) },
    };
    const errors: string[] = [];
    if (settings.notify.enabled) {
      const to = await teamEmails(sb, clientId, settings.notify.userIds, settings.notify.emails);
      const tpl = await loadTemplate(sb, clientId, settings.notify.templateId, "notification");
      const out = await sendLeadAlert(clientId, to, tpl, tokens, c.email);
      if (out.sent === 0 && out.error) errors.push(`alert: ${out.error}`);
    }
    if (settings.autoreply.enabled && c.email) {
      const tpl = await loadTemplate(sb, clientId, settings.autoreply.templateId, "autoreply");
      const out = await sendAutoreply(sb, clientId, c.email, contactId, tpl, tokens);
      if (!out.sent) errors.push(`auto-reply: ${out.reason ?? "not sent"}`);
    }
    if (errors.length) {
      await sb.from("lead_form_submissions").update({ notify_error: errors.join("; ").slice(0, 500) }).eq("id", sub.id);
      if (errors.some((e) => e.startsWith("alert"))) {
        await logEdgeError({ fn: "lead-form", req, clientId, code: "notify", severity: "info", message: `lead form email not sent: ${errors.join("; ")}` });
      }
    }
  })();

  await Promise.allSettled([ghlWork, mailWork]);
  return json({ ok: true, afterSubmit: settings.afterSubmit });
}));
