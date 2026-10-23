// Settings → Customer Hub → Forms and Email Templates (migration 325, Carolyn 2026-10-22).
//
// Every action is a crm_* name ON PURPOSE: index.ts's CRM entitlement guard gates by that prefix,
// so the paid-CRM check covers all of these without a hand-kept list. Their GATES lines are
// settings_crm (view for reads, edit for writes) — the area the Customer Hub already carries.
// None of them is a contacts:'edit' gate, so CONTACT_ROW_SCOPE has nothing to say about them:
// they write forms and templates, never a contact (lead-form does that, for the public).
//
// The tenant is resolveTenant's; nothing here reads a client id from the body. Every row is
// matched on (client_id, id), so an id from another builder simply finds nothing.

import { cleanDefinition, cleanSettings, isUuid, recommendations, starterDefinition, STARTERS, FORM_NAME_MAX } from "../_shared/leadForms.ts";
import { cleanDesign, EMAIL_STARTERS, MERGE_TAGS, renderEmailDesign, type Tokens } from "../_shared/emailBlocks.ts";
import { companyTokens, loadTemplate, sendLeadAlert } from "../_shared/leadFormMail.ts";
import { smsConsentSentence } from "../_shared/smsConsentText.ts";

export const LEAD_FORM_ACTIONS = new Set([
  "crm_forms_list", "crm_form_create", "crm_form_get", "crm_form_save", "crm_form_publish", "crm_form_unpublish",
  "crm_form_duplicate", "crm_form_archive", "crm_form_delete", "crm_form_submissions", "crm_form_stats",
  "crm_form_upload_url", "crm_form_test_email",
  "crm_email_tpl_list", "crm_email_tpl_create", "crm_email_tpl_get", "crm_email_tpl_save", "crm_email_tpl_duplicate",
  "crm_email_tpl_delete", "crm_email_tpl_preview", "crm_email_tpl_test",
]);

// deno-lint-ignore no-explicit-any
type Db = any;
export type LeadFormCtx = {
  admin: Db; req: Request; clientId: string; userId: string | null; userEmail: string | null;
  action: string; payload: Record<string, unknown>;
  json: (b: unknown, s?: number) => Response;
  dbFail: (req: Request, clientId: string | null, where: string, err: unknown, status?: number) => Response;
  audit: (what: string, n: number, detail?: string) => Promise<unknown>;
};

const SB_URL = () => Deno.env.get("SUPABASE_URL") ?? "";
const name = (v: unknown, dflt: string) => (typeof v === "string" ? v.trim().slice(0, FORM_NAME_MAX) : "") || dflt;
const FORM_COLS = "id, name, status, definition, published_definition, published_version, published_at, settings, created_at, updated_at";
const SAMPLE: Tokens = {
  contact: { first_name: "Pat", name: "Pat Lee", email: "pat@example.com", phone: "(555) 555-0100" },
  form: { name: "Contact us", answers: [{ label: "Full name", value: "Pat Lee" }, { label: "Email", value: "pat@example.com" }, { label: "How can we help?", value: "Looking for a 10x16 lofted barn." }] },
};

export async function handleLeadFormAction(x: LeadFormCtx): Promise<Response> {
  const { admin, req, clientId, action, payload: p, json, dbFail, audit } = x;
  const sbUrl = SB_URL();
  const id = isUuid(p.id) ? p.id : null;

  // ── Forms ─────────────────────────────────────────────────────────────────────────────────
  if (action === "crm_forms_list") {
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const [forms, subs, tpls, team, pipes, stages, cs, cfg, styles, sizes, company] = await Promise.all([
      admin.from("lead_forms").select("id, name, status, published_version, published_at, updated_at, created_at").eq("client_id", clientId).order("updated_at", { ascending: false }).limit(200),
      admin.from("lead_form_submissions").select("form_id, created_at").eq("client_id", clientId).eq("spam", false).gte("created_at", since).limit(5000),
      admin.from("email_templates").select("id, name, purpose, subject, updated_at").eq("client_id", clientId).order("updated_at", { ascending: false }).limit(200),
      admin.from("client_users").select("user_id, full_name, role").eq("client_id", clientId).order("created_at"),
      admin.from("crm_pipelines").select("id, name, position").eq("client_id", clientId).is("archived_at", null).order("position"),
      admin.from("crm_pipeline_stages").select("id, pipeline_id, name, position, kind").eq("client_id", clientId).is("archived_at", null).order("position"),
      admin.from("client_settings").select("lead_sms_consent_box").eq("client_id", clientId).maybeSingle(),
      admin.from("client_configs").select("accent_color").eq("client_id", clientId).maybeSingle(),
      admin.from("building_styles").select("label").eq("client_id", clientId).eq("active", true).order("sort_order"),
      admin.from("building_sizes").select("label, width_ft, length_ft").eq("client_id", clientId).eq("active", true).order("width_ft").order("length_ft"),
      companyTokens(admin, clientId),
    ]);
    for (const r of [forms, subs, tpls, team, pipes, stages]) if (r.error) return dbFail(req, clientId, "load your forms", r.error);
    const counts = new Map<string, { n: number; last: string | null }>();
    for (const s of subs.data ?? []) {
      const c = counts.get(s.form_id) ?? { n: 0, last: null };
      c.n++; if (!c.last || s.created_at > c.last) c.last = s.created_at;
      counts.set(s.form_id, c);
    }
    return json({
      ok: true,
      forms: (forms.data ?? []).map((f: Record<string, unknown>) => ({ ...f, submissions30d: counts.get(f.id as string)?.n ?? 0, lastSubmission: counts.get(f.id as string)?.last ?? null })),
      templates: tpls.data ?? [],
      team: (team.data ?? []).map((t: { user_id: string; full_name: string | null; role: string }) => ({ userId: t.user_id, name: t.full_name || "Unnamed team member", role: t.role })),
      pipelines: (pipes.data ?? []).map((pp: { id: string; name: string }) => ({ id: pp.id, name: pp.name, stages: (stages.data ?? []).filter((s: { pipeline_id: string }) => s.pipeline_id === pp.id).map((s: { id: string; name: string }) => ({ id: s.id, name: s.name })) })),
      starters: Object.entries(STARTERS).map(([key, v]) => ({ key, name: v.name })),
      smsBoxOn: cs.data?.lead_sms_consent_box !== false,
      // What the designer canvas needs to draw a form the way the public page will.
      consentSentence: smsConsentSentence(company.name),
      catalog: {
        styles: [...new Set((styles.data ?? []).map((r: { label: string }) => r.label).filter(Boolean))],
        sizes: [...new Set((sizes.data ?? []).map((r: { label: string }) => r.label).filter(Boolean))],
      },
      brand: {
        companyName: company.name, logoUrl: company.logoUrl,
        accent: /^#[0-9a-fA-F]{6}$/.test(String(cfg.data?.accent_color ?? "")) ? cfg.data.accent_color : null,
      },
    });
  }

  if (action === "crm_form_create") {
    const st = starterDefinition(typeof p.starter === "string" ? p.starter : "blank", sbUrl);
    const { data, error } = await admin.from("lead_forms").insert({
      client_id: clientId, name: name(p.name, st.name), definition: st.definition,
      settings: cleanSettings({}), created_by: x.userId,
    }).select(FORM_COLS).single();
    if (error) return dbFail(req, clientId, "create that form", error);
    audit("crm_form_create", 1, `form=${data.id}`).catch(() => {});
    return json({ ok: true, form: withRecs(data, sbUrl) });
  }

  if (action === "crm_form_get") {
    if (!id) return json({ error: "Which form?" }, 400);
    const { data, error } = await admin.from("lead_forms").select(FORM_COLS).eq("client_id", clientId).eq("id", id).maybeSingle();
    if (error) return dbFail(req, clientId, "load that form", error);
    if (!data) return json({ error: "That form no longer exists." }, 404);
    return json({ ok: true, form: withRecs(data, sbUrl) });
  }

  if (action === "crm_form_save") {
    if (!id) return json({ error: "Which form?" }, 400);
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if ("name" in p) patch.name = name(p.name, "Untitled form");
    if ("definition" in p) patch.definition = cleanDefinition(p.definition, sbUrl);
    if ("settings" in p) patch.settings = cleanSettings(p.settings);
    const { data, error } = await admin.from("lead_forms").update(patch).eq("client_id", clientId).eq("id", id).select(FORM_COLS).maybeSingle();
    if (error) return dbFail(req, clientId, "save that form", error);
    if (!data) return json({ error: "That form no longer exists." }, 404);
    return json({ ok: true, form: withRecs(data, sbUrl) });
  }

  if (action === "crm_form_publish") {
    if (!id) return json({ error: "Which form?" }, 400);
    const { data: cur, error: e1 } = await admin.from("lead_forms").select(FORM_COLS).eq("client_id", clientId).eq("id", id).maybeSingle();
    if (e1) return dbFail(req, clientId, "publish that form", e1);
    if (!cur) return json({ error: "That form no longer exists." }, 404);
    const def = cleanDefinition(cur.definition, sbUrl);
    const blocking = recommendations(def, null).filter((r) => r.blocking);
    if (blocking.length) return json({ error: blocking.map((r) => r.text).join(" ") }, 400);
    const { data, error } = await admin.from("lead_forms").update({
      published_definition: def, published_version: (cur.published_version ?? 0) + 1, published_at: new Date().toISOString(),
      status: "published", updated_at: new Date().toISOString(),
    }).eq("client_id", clientId).eq("id", id).select(FORM_COLS).single();
    if (error) return dbFail(req, clientId, "publish that form", error);
    audit("crm_form_publish", 1, `form=${id} v=${data.published_version}`).catch(() => {});
    return json({ ok: true, form: withRecs(data, sbUrl) });
  }

  if (action === "crm_form_unpublish" || action === "crm_form_archive") {
    if (!id) return json({ error: "Which form?" }, 400);
    const restore = action === "crm_form_archive" && p.archived === false;
    const { data: cur } = await admin.from("lead_forms").select("published_definition").eq("client_id", clientId).eq("id", id).maybeSingle();
    if (!cur) return json({ error: "That form no longer exists." }, 404);
    const status = action === "crm_form_unpublish" ? "draft" : restore ? "draft" : "archived";
    const { data, error } = await admin.from("lead_forms").update({ status, updated_at: new Date().toISOString() })
      .eq("client_id", clientId).eq("id", id).select(FORM_COLS).single();
    if (error) return dbFail(req, clientId, "update that form", error);
    audit(action, 1, `form=${id} status=${status}`).catch(() => {});
    return json({ ok: true, form: withRecs(data, sbUrl) });
  }

  if (action === "crm_form_duplicate") {
    if (!id) return json({ error: "Which form?" }, 400);
    const { data: cur } = await admin.from("lead_forms").select("name, definition, settings").eq("client_id", clientId).eq("id", id).maybeSingle();
    if (!cur) return json({ error: "That form no longer exists." }, 404);
    const { data, error } = await admin.from("lead_forms").insert({
      client_id: clientId, name: `${cur.name} (copy)`.slice(0, FORM_NAME_MAX), definition: cleanDefinition(cur.definition, sbUrl),
      settings: cleanSettings(cur.settings), created_by: x.userId,
    }).select(FORM_COLS).single();
    if (error) return dbFail(req, clientId, "copy that form", error);
    return json({ ok: true, form: withRecs(data, sbUrl) });
  }

  if (action === "crm_form_delete") {
    if (!id) return json({ error: "Which form?" }, 400);
    // A form with submissions is archived, never deleted: the submissions cascade with it, and
    // those are leads.
    const { count } = await admin.from("lead_form_submissions").select("id", { count: "exact", head: true }).eq("client_id", clientId).eq("form_id", id);
    if ((count ?? 0) > 0) return json({ error: "This form has submissions, so it can't be deleted. Archive it instead — that takes it off your website and keeps the leads." }, 409);
    const { error } = await admin.from("lead_forms").delete().eq("client_id", clientId).eq("id", id);
    if (error) return dbFail(req, clientId, "delete that form", error);
    audit("crm_form_delete", 1, `form=${id}`).catch(() => {});
    return json({ ok: true });
  }

  if (action === "crm_form_submissions") {
    if (!id) return json({ error: "Which form?" }, 400);
    let q = admin.from("lead_form_submissions").select("id, answers, contact_id, deal_id, page_url, referrer, utm, spam, spam_reason, notify_error, created_at, form_version")
      .eq("client_id", clientId).eq("form_id", id).eq("spam", p.spam === true).order("created_at", { ascending: false }).limit(200);
    if (typeof p.before === "string" && /^\d{4}-\d{2}-\d{2}T/.test(p.before)) q = q.lt("created_at", p.before);
    const { data, error } = await q;
    if (error) return dbFail(req, clientId, "load submissions", error);
    return json({ ok: true, submissions: data ?? [], more: (data ?? []).length === 200 });
  }

  if (action === "crm_form_stats") {
    if (!id) return json({ error: "Which form?" }, 400);
    const days = p.days === 90 ? 90 : 30;
    const from = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
    const [stats, pages] = await Promise.all([
      admin.from("lead_form_daily_stats").select("day, views, starts, submits").eq("client_id", clientId).eq("form_id", id).gte("day", from).order("day"),
      admin.from("lead_form_submissions").select("page_url").eq("client_id", clientId).eq("form_id", id).eq("spam", false).gte("created_at", from).limit(5000),
    ]);
    if (stats.error) return dbFail(req, clientId, "load form analytics", stats.error);
    const byPage = new Map<string, number>();
    for (const r of pages.data ?? []) {
      let key = "Direct link";
      try { if (r.page_url) { const u = new URL(r.page_url); key = u.host + u.pathname; } } catch { /* keep */ }
      byPage.set(key, (byPage.get(key) ?? 0) + 1);
    }
    return json({ ok: true, days, from, rows: stats.data ?? [], pages: [...byPage.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([page, n]) => ({ page, n })) });
  }

  if (action === "crm_form_upload_url") {
    const ext = typeof p.ext === "string" ? p.ext.toLowerCase().replace(/^\./, "") : "";
    if (!["jpg", "jpeg", "png", "webp", "gif"].includes(ext)) return json({ error: "Images only: JPG, PNG, WebP or GIF." }, 400);
    const path = `${clientId}/${crypto.randomUUID()}.${ext}`;
    const { data, error } = await admin.storage.from("form-assets").createSignedUploadUrl(path);
    if (error || !data) return dbFail(req, clientId, "start that upload", error);
    return json({ ok: true, path, token: data.token, publicUrl: `${sbUrl.replace(/\/+$/, "")}/storage/v1/object/public/form-assets/${path}` });
  }

  if (action === "crm_form_test_email") {
    // To the person signed in, never anyone else: proof of what the alert or auto-reply looks like.
    if (!id) return json({ error: "Which form?" }, 400);
    const to = String(x.userEmail ?? "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return json({ error: "Your sign-in has no email address to send a test to." }, 400);
    const { data: f } = await admin.from("lead_forms").select("name, settings").eq("client_id", clientId).eq("id", id).maybeSingle();
    if (!f) return json({ error: "That form no longer exists." }, 404);
    const st = cleanSettings(f.settings);
    const which = p.which === "autoreply" ? "autoreply" : "notification";
    const tpl = await loadTemplate(admin, clientId, which === "autoreply" ? st.autoreply.templateId : st.notify.templateId, which);
    const tokens: Tokens = { ...SAMPLE, company: await companyTokens(admin, clientId), form: { ...SAMPLE.form!, name: f.name } };
    const out = await sendLeadAlert(clientId, [to], { ...tpl, subject: `[Test] ${tpl.subject}` }, tokens);
    if (!out.sent) return json({ error: `The test wasn't sent: ${out.error ?? "unknown reason"}.` }, 502);
    return json({ ok: true, sentTo: to });
  }

  // ── Email templates ───────────────────────────────────────────────────────────────────────
  const TPL_COLS = "id, name, purpose, subject, preheader, design, created_at, updated_at";
  if (action === "crm_email_tpl_list") {
    const { data, error } = await admin.from("email_templates").select("id, name, purpose, subject, updated_at").eq("client_id", clientId).order("updated_at", { ascending: false }).limit(200);
    if (error) return dbFail(req, clientId, "load your email templates", error);
    return json({ ok: true, templates: data ?? [], starters: Object.entries(EMAIL_STARTERS).map(([key, v]) => ({ key, name: v.name, purpose: v.purpose })), mergeTags: MERGE_TAGS });
  }

  if (action === "crm_email_tpl_create") {
    const st = EMAIL_STARTERS[typeof p.starter === "string" && EMAIL_STARTERS[p.starter] ? p.starter : "blank"];
    const { data, error } = await admin.from("email_templates").insert({
      client_id: clientId, name: name(p.name, st.name), purpose: st.purpose, subject: st.subject, preheader: st.preheader, design: st.design, created_by: x.userId,
    }).select(TPL_COLS).single();
    if (error) return dbFail(req, clientId, "create that template", error);
    return json({ ok: true, template: data });
  }

  if (action === "crm_email_tpl_get") {
    if (!id) return json({ error: "Which template?" }, 400);
    const { data, error } = await admin.from("email_templates").select(TPL_COLS).eq("client_id", clientId).eq("id", id).maybeSingle();
    if (error) return dbFail(req, clientId, "load that template", error);
    if (!data) return json({ error: "That template no longer exists." }, 404);
    return json({ ok: true, template: { ...data, design: cleanDesign(data.design) }, mergeTags: MERGE_TAGS });
  }

  if (action === "crm_email_tpl_save") {
    if (!id) return json({ error: "Which template?" }, 400);
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if ("name" in p) patch.name = name(p.name, "Untitled email");
    if ("purpose" in p) patch.purpose = ["form_autoreply", "form_notification", "general"].includes(p.purpose as string) ? p.purpose : "general";
    if ("subject" in p) patch.subject = typeof p.subject === "string" ? p.subject.replace(/[\r\n]+/g, " ").trim().slice(0, 200) : "";
    if ("preheader" in p) patch.preheader = typeof p.preheader === "string" ? p.preheader.replace(/[\r\n]+/g, " ").trim().slice(0, 200) : "";
    if ("design" in p) patch.design = cleanDesign(p.design);
    const { data, error } = await admin.from("email_templates").update(patch).eq("client_id", clientId).eq("id", id).select(TPL_COLS).maybeSingle();
    if (error) return dbFail(req, clientId, "save that template", error);
    if (!data) return json({ error: "That template no longer exists." }, 404);
    return json({ ok: true, template: data });
  }

  if (action === "crm_email_tpl_duplicate") {
    if (!id) return json({ error: "Which template?" }, 400);
    const { data: cur } = await admin.from("email_templates").select("name, purpose, subject, preheader, design").eq("client_id", clientId).eq("id", id).maybeSingle();
    if (!cur) return json({ error: "That template no longer exists." }, 404);
    const { data, error } = await admin.from("email_templates").insert({ ...cur, client_id: clientId, name: `${cur.name} (copy)`.slice(0, FORM_NAME_MAX), design: cleanDesign(cur.design), created_by: x.userId }).select(TPL_COLS).single();
    if (error) return dbFail(req, clientId, "copy that template", error);
    return json({ ok: true, template: data });
  }

  if (action === "crm_email_tpl_delete") {
    if (!id) return json({ error: "Which template?" }, 400);
    const { error } = await admin.from("email_templates").delete().eq("client_id", clientId).eq("id", id);
    if (error) return dbFail(req, clientId, "delete that template", error);
    // A form pointing at it falls back to the built-in email (loadTemplate), so nothing breaks.
    return json({ ok: true });
  }

  if (action === "crm_email_tpl_preview") {
    const design = cleanDesign(p.design);
    const tokens: Tokens = { ...SAMPLE, company: await companyTokens(admin, clientId) };
    const r = renderEmailDesign(design, tokens, typeof p.preheader === "string" ? p.preheader.slice(0, 200) : "");
    const subj = typeof p.subject === "string" ? p.subject.slice(0, 200) : "";
    return json({ ok: true, html: r.html, text: r.text, subject: subj.replace(/\{\{\s*([a-z_]+\.[a-z_]+)\s*\}\}/g, (m, k: string) => {
      const [ns, f] = k.split(".");
      // deno-lint-ignore no-explicit-any
      const v = (tokens as any)?.[ns]?.[f];
      return typeof v === "string" ? v : m;
    }) });
  }

  if (action === "crm_email_tpl_test") {
    const to = String(x.userEmail ?? "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return json({ error: "Your sign-in has no email address to send a test to." }, 400);
    const tokens: Tokens = { ...SAMPLE, company: await companyTokens(admin, clientId) };
    const out = await sendLeadAlert(clientId, [to], {
      subject: `[Test] ${typeof p.subject === "string" && p.subject.trim() ? p.subject.slice(0, 180) : "Your email template"}`,
      preheader: typeof p.preheader === "string" ? p.preheader.slice(0, 200) : "",
      design: cleanDesign(p.design),
    }, tokens);
    if (!out.sent) return json({ error: `The test wasn't sent: ${out.error ?? "unknown reason"}.` }, 502);
    return json({ ok: true, sentTo: to });
  }

  return json({ error: "Unknown action." }, 400);
}

// deno-lint-ignore no-explicit-any
function withRecs(row: any, sbUrl: string) {
  const def = cleanDefinition(row.definition, sbUrl);
  return {
    ...row, definition: def, settings: cleanSettings(row.settings),
    // jsonb reorders keys, so the published copy is rebuilt the same way before comparing.
    recommendations: recommendations(def, row.status === "published" && row.published_definition ? cleanDefinition(row.published_definition, sbUrl) : null),
  };
}
