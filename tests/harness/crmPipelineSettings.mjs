// Settings → Pipelines after migration 354, driven for real on the COMPILED portal.
//
// Carolyn, 2026-11-01: "I want to make specific statuses per pipeline and they will work the way it
// is now (internally you decide when the status changes). So in settings lets move the pipelines
// above the statuses. and then the statuses and pipelines and lost reasons all within that
// pipeline." Before 354 this page was TWO cards — a tenant-wide Statuses list first, then
// Pipelines — because one ladder served every board. What this proves now:
//
//   A  ONE card, and it is Pipelines. There is no account-level status list left; each row names
//      its pipeline, the "new designs" badge where it belongs, and how many stages AND statuses it
//      has. Nothing on the page offers a stage→status link or mentions Quotes.
//   B  Opening a pipeline shows its stages, its statuses and its lost reasons TOGETHER, and the
//      statuses shown are that pipeline's own — the other pipeline's rungs are not there.
//   C  A status may wait for its trigger (354): adding one with "Nothing yet" is allowed, the row
//      says nothing sets it, and the save names the pipeline. Before 354 a new status HAD to claim
//      an unused event, because a status no event set was unreachable; Carolyn is building a
//      SmartBuild pipeline whose rungs the webhooks will drive later.
//   D  A reorder names its pipeline (without it the server cannot tell a subset from a mismatch),
//      and nothing on either screen sends crm_deal_set_status or a statusId on a stage.
//   E  AUTOMATIONS (Carolyn 2026-11-04 moved the rules of migration 355 to their own tab): the
//      pipeline panel carries none of them any more, and the Automations page holds one group per
//      pipeline — including the pipelines with no rules, which is where a first rule gets added.
//      A rule reads back as a sentence; a PAUSED one says so and one set to run every time
//      says that too; the editor opens in place rather than as a pop-up; switching to a clock
//      rule LOCKS once-per-card on (355 makes that a CHECK — a repeating clock rule would text
//      the same customer on every sweep); an action that messages the customer warns before the
//      rule is saved; the save posts the whole rule with its actions in order; and the run log
//      gives the three non-bug answers to "why did nothing happen?" — held by the once guard,
//      it threw, or it is still queued.
//
// Supabase is stubbed at the network layer (no login, nothing leaves the machine); the skeleton is
// crmContactDeal.mjs's.
//
//   node tests/harness/crmPipelineSettings.mjs    (exit 0 = every check held)
//
// Shots land in %TEMP%/ss-harness/crm-pipeline-settings (SS_SHOTS overrides). SS_PORTAL_ARTIFACT=<an
// older portal.app.compiled.js> serves that file instead: against the build before 354, A fails on
// the second card and B finds no statuses inside the editor.
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { launch, reporter, BASE, REF, shotsDir } from "./lib.mjs";

const CLIENT = "harness-pipelines";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000002", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
// Carolyn's ladder, as 354 seeds it INTO ONE PIPELINE. Every pipeline owns a copy; two pipelines
// may each have an "Invoiced" rung, which is the whole change.
const LADDER = [
  ["New Lead", "#64748B", "design_submitted"], ["Contact Made", "#0EA5E9", "contact_made"], ["Estimate Sent", "#6366F1", "estimate_sent"],
  ["Accepted", "#16A34A", "estimate_accepted"], ["Invoiced", "#14B8A6", "invoiced"], ["Payment Received", "#84CC16", "paid_in_full"],
  ["Scheduling", "#F59E0B", "build_scheduled"], ["Delivered", "#0F766E", "delivered"],
];
// What crm_rules_list says the database can store: 2 with migration 363 applied, 1 with only 355,
// 0 with neither (beta and production share one project, so the function can be live before the
// migration). E15 drops it to 1: Automations must then offer nothing at all.
let rulesVersion = 2;
// E12 makes the fake server refuse the next save the way crm_rule_save does when a STORED action
// no longer fits — so the check proves the editor shows the server's sentence, not its own.
let force409 = false;
const rungs = (base) => LADDER.map(([name, color, triggerEvent], i) => ({ id: U(base + i), name, color, position: (i + 1) * 1024, triggerEvent }));
const SHED_STAGES = ["New Incoming", "Attempting Contact", "Nurturing - Cool", "Nurturing - Warm", "Nurturing - Hot", "Gone Cold Again"]
  .map((name, i) => ({ id: U(200 + i), name, color: "#64748B", kind: "open", position: (i + 1) * 1024 }));
// Shed Deals carries the whole ladder; the hand-made one keeps only what its cards use — which is
// exactly what 354's backfill does, and what Carolyn asked for ("I don't want any changes to my
// Builders pipeline").
// AUTOMATIONS (355 + 363). Since 2026-11-04 a rule says WHO it is for and the list is flat. Carolyn's
// own example is the first: ask for a review 30 days after the shed was delivered — on Shed Deals,
// only for cards worth over $10,000. The second is deliberately the awkward pair — no name, and
// PAUSED — because "why did nothing happen?" is a paused rule far more often than a bug. The third
// is the new kind: on EVERY pipeline, so it carries no pipeline and cannot set a status.
const RULES = [
  { id: U(600), name: "Ask for a review", scopeKind: "pipeline", pipelineId: U(1),
    triggerKind: "elapsed", triggerEvent: null, elapsedAnchor: "delivered", elapsedDays: 30,
    conditions: [{ field: "deal.value", op: "gt", value: 10000 }],
    oncePerCard: true, enabled: true, position: 1024, stale: [], lastRun: null,
    actions: [
      { id: U(610), kind: "set_status", params: { statusId: U(107) }, position: 1024 },
      { id: U(611), kind: "send_sms", params: { body: "Hi {{first_name}}, how is the shed?" }, position: 2048 },
    ] },
  { id: U(601), name: null, scopeKind: "pipeline", pipelineId: U(1),
    triggerKind: "event", triggerEvent: "contact_made", elapsedAnchor: null, elapsedDays: null,
    conditions: [], oncePerCard: false, enabled: false, position: 2048, stale: [], lastRun: null,
    actions: [{ id: U(620), kind: "add_note", params: { body: "Someone got through." }, position: 1024 }] },
  { id: U(602), name: "Chase a sent estimate", scopeKind: "all_pipelines", pipelineId: null,
    triggerKind: "event", triggerEvent: "estimate_sent", elapsedAnchor: null, elapsedDays: null,
    conditions: [], oncePerCard: true, enabled: true, position: 3072, stale: [], lastRun: null,
    actions: [{ id: U(630), kind: "set_follow_up", params: { days: 3 }, position: 1024 }] },
  // 365: a Monday text to lot visitors — saved, but NOT ARMED, so it must say it will not send.
  { id: U(603), name: "Monday lot text", scopeKind: "contacts", pipelineId: null,
    triggerKind: "schedule", triggerEvent: null, elapsedAnchor: null, elapsedDays: null,
    schedule: { freq: "weekly", at: "08:00", days: [1], every: 1 }, nextRunAt: "2026-11-09T14:00:00Z", armedCount: null,
    conditions: [{ field: "contact.label", op: "has", value: "Lot visitor" }], oncePerCard: true, enabled: true, position: 4096, stale: [], lastRun: null,
    actions: [{ id: U(640), kind: "send_sms", params: { body: "New sheds on the lot this week!" }, position: 1024 }] },
];
const PIPELINES = [
  { id: U(1), name: "Shed Deals", position: 1024, lostReasons: ["Price", "Timing"], seedKind: "shed_deals", feedsDesigns: true,
    stages: SHED_STAGES, statuses: rungs(100) },
  { id: U(2), name: "Manufacturer Outreach", position: 2048, lostReasons: ["Not interested"], seedKind: "outreach", feedsDesigns: false,
    stages: [{ id: U(300), name: "New Lead", color: "#64748B", kind: "open", position: 1024 }, { id: U(301), name: "Connected", color: "#16A34A", kind: "open", position: 2048 }],
    statuses: [{ id: U(400), name: "Reached out", color: "#64748B", position: 1024, triggerEvent: null }] },
];
// The flat UNION the server still sends for the pills, and what the stub mutates on a save.
const live = PIPELINES.flatMap((p) => p.statuses.map((t) => ({ ...t, pipelineId: p.id })));

const { ok, failed } = reporter();
const shots = shotsDir("crm-pipeline-settings");
const { browser, ctx } = await launch({ width: 1400, height: 1000 });
await ctx.addInitScript(([ref, s]) => {
  try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
}, [REF, SESSION]);
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
const sent = [];

const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });
await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
const handler = async (route) => {
  const req = route.request();
  const url = req.url();
  if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
  let body = {};
  try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
  if (url.includes("/rest/v1/rpc/log_error")) return json(route, null);
  if (url.includes("/rest/v1/rpc/")) return json(route, false);
  if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: "owner", user_id: USER.id }]);
  if (url.includes("/rest/v1/")) return json(route, []);
  if (url.includes("/auth/v1/user")) return json(route, USER);
  if (url.includes("/auth/v1/")) return json(route, SESSION);
  if (url.includes("/portal-billing")) {
    return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: { crm: true }, status: "active" }, wallet: null });
  }
  if (!url.includes("/portal-settings")) return json(route, { ok: true });
  if (String(body.action || "").startsWith("crm_")) sent.push(body);
  switch (body.action) {
    case "status":
      return json(route, { ok: true, clientId: CLIENT, role: "owner", access: null, prefs: null, configured: false, invoiceInGhl: false,
        ghlInvoicingAllowed: false, ssQuoteNext: 1042, ssInvoiceNext: 2001, ssTaxRate: 6.5, ssTaxLabel: "Sales tax", businessAddress: {}, branding: {}, emailReady: true });
    case "crm_pipelines_list":
      // 363: the board's read carries no rules any more; they are crm_rules_list's.
      return json(route, { ok: true, pipelines: PIPELINES, statuses: live, team: [], canManage: true, canWrite: true, ownOnly: false, me: USER.id });
    case "crm_rules_list":
      return json(route, {
        ok: true, rulesVersion,
        rules: rulesVersion >= 2 ? RULES : [],
        pipelines: PIPELINES.map((x) => ({ id: x.id, name: x.name, lostReasons: x.lostReasons,
          stages: x.stages.map((t) => ({ id: t.id, name: t.name })), statuses: x.statuses.map((t) => ({ id: t.id, name: t.name, color: t.color })) })),
        team: [{ userId: USER.id, name: "Pat Owner", title: "Owner" }],
        labels: ["Lot visitor", "VIP"], timeZone: "America/Chicago", timeZoneSet: true,
        dateFields: [{ key: "custom:install_date", label: "Install date" }],
        canManage: true, me: USER.id,
      });
    case "crm_status_save": {
      if (!body.id) {
        // 354: a new rung names its pipeline, and lands on THAT pipeline only.
        const owner = PIPELINES.find((p) => p.id === body.pipelineId);
        if (!owner) return json(route, { error: "That pipeline wasn't found." }, 404);
        const made = { id: U(500 + live.length), name: body.name, color: "#64748B", position: (owner.statuses.length + 1) * 1024, triggerEvent: body.triggerEvent || null };
        owner.statuses.push(made);
        live.push({ ...made, pipelineId: owner.id });
        return json(route, { ok: true, id: made.id });
      }
      for (const p of PIPELINES) {
        const t = p.statuses.find((x) => x.id === body.id);
        if (!t) continue;
        if (body.triggerEvent !== undefined) t.triggerEvent = body.triggerEvent || null;
        if (body.name) t.name = body.name;
        if (body.archive) p.statuses = p.statuses.filter((x) => x.id !== body.id);
      }
      return json(route, { ok: true, id: body.id });
    }
    case "crm_stage_save": return json(route, { ok: true, id: body.id || U(399) });
    // ── AUTOMATIONS (355 + 363): one flat list ───────────────────────────────────────────
    case "crm_rule_save": {
      if (force409) {
        force409 = false;
        return json(route, { error: "Action 1 (Add a note to the customer) points at a pipeline that has been removed. Pick another.",
          code: "actions_stale", offending: [{ index: 0, kind: "add_note", why: "pipeline" }] }, 409);
      }
      if (!body.id) {
        const made = {
          id: U(700 + RULES.length), name: body.name || null, scopeKind: body.scopeKind || "pipeline",
          pipelineId: body.scopeKind === "pipeline" || !body.scopeKind ? body.pipelineId : null,
          triggerKind: body.triggerKind, triggerEvent: body.triggerEvent || null, elapsedAnchor: body.elapsedAnchor || null,
          elapsedDays: body.elapsedDays == null ? null : body.elapsedDays, conditions: body.conditions || [],
          oncePerCard: body.oncePerCard !== false, enabled: body.enabled !== false, position: (RULES.length + 1) * 1024,
          stale: [], lastRun: null,
          actions: (body.actions || []).map((a, i) => ({ id: U(750 + i), kind: a.kind, params: a.params || {}, position: (i + 1) * 1024 })),
        };
        RULES.push(made);
        return json(route, { ok: true, id: made.id });
      }
      const r = RULES.find((x) => x.id === body.id);
      if (!r) return json(route, { error: "That rule wasn't found." }, 404);
      if (body.archive) RULES.splice(RULES.indexOf(r), 1);
      else {
        if (body.enabled !== undefined) r.enabled = body.enabled;
        if (body.name !== undefined) r.name = body.name || null;
        if (body.scopeKind) { r.scopeKind = body.scopeKind; r.pipelineId = body.scopeKind === "pipeline" ? body.pipelineId : null; }
        if (body.triggerKind) {
          r.triggerKind = body.triggerKind;
          r.triggerEvent = body.triggerEvent || null;
          r.elapsedAnchor = body.elapsedAnchor || null;
          r.elapsedDays = body.elapsedDays == null ? null : body.elapsedDays;
        }
        if (body.conditions !== undefined) r.conditions = body.conditions;
        if (body.oncePerCard !== undefined) r.oncePerCard = body.oncePerCard;
        if (body.actions !== undefined) r.actions = body.actions.map((a, i) => ({ id: U(760 + i), kind: a.kind, params: a.params || {}, position: (i + 1) * 1024 }));
      }
      return json(route, { ok: true, id: body.id });
    }
    case "crm_rule_audience":
      // 365: who a draft would reach now — the number a schedule is armed with.
      return json(route, { ok: true, count: 312, sample: ["Dale Smith", "Pat Lee"] });
    case "crm_rules_time_zone":
      return json(route, { ok: true, timeZone: body.timeZone });
    case "crm_rules_reorder": {
      // 363: the ACCOUNT's whole list, every id, and no pipeline.
      const next = (body.ids || []).map((id) => RULES.find((r) => r.id === id)).filter(Boolean);
      if (next.length === RULES.length) { RULES.length = 0; RULES.push(...next); }
      return json(route, { ok: true });
    }
    case "crm_rule_log":
      // The answers to "why did nothing happen?" that are NOT a bug, which is the whole point of
      // the log: held by the once guard, the conditions did not match, it threw, it is still
      // queued — or, since 363, it is WAITING for the morning where the customer lives.
      return json(route, { ok: true,
        runs: [
          { id: 4, ruleId: U(600), ruleName: "Ask for a review", dealId: U(904), contactId: U(954), who: "Lee Card — 12x20 Lofted",
            trigger: "elapsed:delivered+30d", occurrence: "", outcome: "skipped", detail: { reason: "conditions" }, firedAt: "2026-11-02T11:00:00Z" },
          { id: 3, ruleId: U(600), ruleName: "Ask for a review", dealId: U(900), contactId: U(950), who: "Dale Smith — 10x16 Barn",
            trigger: "elapsed:delivered+30d", occurrence: "", outcome: "skipped", detail: { reason: "already run for this card" }, firedAt: "2026-11-02T10:00:00Z" },
          { id: 2, ruleId: U(600), ruleName: "Ask for a review", dealId: U(901), contactId: U(951), who: null,
            trigger: "elapsed:delivered+30d", occurrence: "", outcome: "failed", detail: { sqlstate: "P0002", error: "status not found" }, firedAt: "2026-11-02T09:00:00Z" },
          { id: 1, ruleId: U(600), ruleName: "Ask for a review", dealId: U(902), contactId: U(952), who: null,
            trigger: "elapsed:delivered+30d", occurrence: "", outcome: "done", detail: { actions: [] }, firedAt: "2026-11-02T08:00:00Z" },
        ],
        outbox: [
          { id: 9, ruleId: U(600), ruleName: "Ask for a review", dealId: U(903), contactId: U(953), who: "Pat Lee", kind: "send_sms", state: "queued",
            attempts: 0, lastError: null, holdUntil: null, queuedAt: "2026-11-02T10:05:00Z", sentAt: null },
          { id: 8, ruleId: U(600), ruleName: "Ask for a review", dealId: U(905), contactId: U(955), who: "Sam Night", kind: "send_sms", state: "queued",
            attempts: 0, lastError: "Waiting for 8am where the customer lives.", holdUntil: "2026-11-03T14:00:00Z", queuedAt: "2026-11-02T03:05:00Z", sentAt: null },
        ],
      });
    default: return json(route, { ok: true });
  }
};
await page.route(`**/${REF}.supabase.co/**`, handler);
await page.route(`**/${REF}.functions.supabase.co/**`, handler);
if (process.env.SS_PORTAL_ARTIFACT) {
  const src = readFileSync(process.env.SS_PORTAL_ARTIFACT, "utf8");
  await page.route(/portal\.app\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: src }));
}
const go = async (path) => {
  await page.evaluate((p) => { history.pushState({}, "", p); window.dispatchEvent(new PopStateEvent("popstate")); }, path);
  await page.waitForTimeout(1200);
};

try {
  await page.goto(`${BASE}/portal.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  await page.waitForTimeout(600);
  await go("/settings/pipelines");
  await page.waitForFunction(() => !!document.querySelector("[data-ss-pipeline-settings] [data-ss-pipeline-row]"), null, { timeout: 20000 })
    .catch(() => { /* the guard below reports it */ });
  await page.waitForTimeout(500);

  // THE GUARD: refuse to report the rest as passes if the page never rendered.
  const card = page.locator("[data-ss-pipeline-settings]");
  const rowCount = await page.locator("[data-ss-pipeline-row]").count();
  const rendered = ok("the Pipelines card rendered with both pipelines", (await card.count()) === 1 && rowCount === PIPELINES.length, `${rowCount} row(s)`);
  if (!rendered) throw new Error("Settings → Pipelines never rendered; refusing to report the rest as passes");
  await page.screenshot({ path: join(shots, "settings-pipelines.png"), fullPage: true });

  // ── A: one card, and it is Pipelines ───────────────────────────────────────────────────
  const text = await page.evaluate(() => document.body.innerText);
  const headings = await page.evaluate(() =>
    [...document.querySelectorAll("[data-ss-pipeline-settings]")].map((c) => (c.querySelector("div") || {}).textContent));
  ok("A1 the page is ONE card, headed Pipelines — the account-wide Statuses card is gone",
    headings.length === 1 && headings[0] === "Pipelines", JSON.stringify(headings));
  ok("A2 no status list outside a pipeline: nothing on the page edits a status until one is opened",
    (await page.locator("[data-ss-pipeline-settings] input[aria-label='Status name']").count()) === 0);
  ok("A3 each row says how many stages AND statuses its pipeline has",
    /6 stages · 8 statuses/.test(text) && /2 stages · 1 status/.test(text),
    (text.match(/\d+ stages? · \d+ status(es)?/g) || []).join(" | "));
  ok("A4 Shed Deals carries the 'new designs' badge", await page.evaluate(() =>
    [...document.querySelectorAll("span")].some((s) => /^Shed Deals/.test((s.innerText || "").trim()) && /new designs/.test(s.innerText || ""))));
  ok("A5 nothing names a stage→status link, nor Quotes", !/link stages to statuses|Link a stage/i.test(text) && !/\bQuotes\b/.test(text));
  ok("A6 the copy says a pipeline owns its own stages, statuses and lost reasons",
    /its own stages, its own statuses and its own lost reasons/.test(text), text.slice(0, 400));

  // ── B: a pipeline owns its stages, statuses and lost reasons, together ──────────────────
  await page.locator("[data-ss-pipeline-row] button", { hasText: "Edit" }).first().click();
  await page.waitForTimeout(700);
  const modal = await page.evaluate(() => document.body.innerText);

  // B0: IN PLACE, UNDER THE LIST — NOT A POP-UP (Carolyn 2026-11-02). The editor is a card in
  // the document flow below the pipelines card, nothing is laid over the page, and the page is
  // not scroll-locked (the modal shell locks the body; a locked page with no overlay reads as a
  // frozen tab). The pipelines stay on screen and the open row says which one it is.
  const shape = await page.evaluate(() => {
    const ed = document.querySelector("[data-ss-pipeline-editor]");
    const list = document.querySelector("[data-ss-pipeline-settings]");
    if (!ed || !list) return { ed: !!ed, list: !!list };
    const pos = getComputedStyle(ed).position;
    return {
      ed: true, list: true, pos,
      dialog: !!ed.closest('[role="dialog"]') || !!document.querySelector('[role="dialog"][aria-modal="true"]'),
      belowList: list.compareDocumentPosition(ed) === Node.DOCUMENT_POSITION_FOLLOWING,
      listVisible: list.getBoundingClientRect().height > 0,
      bodyLocked: getComputedStyle(document.body).overflow === "hidden",
      openRows: document.querySelectorAll("[data-ss-pipeline-open]").length,
    };
  });
  ok("B0 the editor opens IN PLACE under the list, not as a pop-up",
    shape.ed && shape.list && !shape.dialog && shape.pos !== "fixed" && shape.belowList
    && shape.listVisible && !shape.bodyLocked && shape.openRows === 1, JSON.stringify(shape));
  const stageNames = await page.locator("input[aria-label='Stage name']").evaluateAll((els) => els.map((e) => e.value));
  const statusNames = await page.locator("input[aria-label='Status name']").evaluateAll((els) => els.map((e) => e.value));
  ok("B1 the editor shows Shed Deals' six stages", JSON.stringify(stageNames) === JSON.stringify(SHED_STAGES.map((s) => s.name)), stageNames.join(" | "));
  ok("B2 and its EIGHT statuses, in the same panel", JSON.stringify(statusNames) === JSON.stringify(LADDER.map(([n]) => n)), statusNames.join(" | "));
  ok("B3 and its lost reasons, in the same panel", (await page.evaluate(() => {
    const el = [...document.querySelectorAll("textarea")].pop(); return el ? el.value : "";
  })).includes("Price"));
  ok("B4 the other pipeline's status is NOT here — a ladder belongs to one pipeline",
    !statusNames.includes("Reached out"), statusNames.join(" | "));
  ok("B5 every status keeps its 'Set automatically when'",
    (await page.locator("select[aria-label='Set automatically when']").count()) === 8);
  ok("B6 no 'Linked status' drop-down, and no Kind on a stage",
    (await page.locator("select[aria-label='Linked status']").count()) === 0
    && (await page.locator("select[aria-label='Kind']").count()) === 0);
  ok("B7 the copy says these belong to this pipeline and renaming leaves the others alone",
    /belong to .*Shed Deals.* — another pipeline has its own/.test(modal.replace(/\s+/g, " ")),
    (modal.replace(/\s+/g, " ").match(/These belong to[^.]*\./) || [])[0] || "not found");
  await page.screenshot({ path: join(shots, "pipeline-editor.png") });

  // ── C: a status may wait for its trigger (354) ─────────────────────────────────────────
  const beforeAdd = sent.filter((b) => b.action === "crm_status_save").length;
  await page.locator("[data-ss-status-add] input[aria-label='New status name']").fill("Waiting on SmartBuild");
  await page.locator("[data-ss-status-add] button", { hasText: "Add status" }).click();
  await page.waitForTimeout(700);
  const add = sent.filter((b) => b.action === "crm_status_save").slice(beforeAdd)[0];
  ok("C1 a status with NO trigger is allowed, and the save names its pipeline",
    !!add && add.name === "Waiting on SmartBuild" && !add.triggerEvent && add.pipelineId === PIPELINES[0].id, JSON.stringify(add));
  const after = await page.locator("input[aria-label='Status name']").evaluateAll((els) => els.map((e) => e.value));
  ok("C2 it joins this pipeline's ladder", after.includes("Waiting on SmartBuild"), after.join(" | "));
  ok("C3 and the row says nothing sets it yet",
    /Nothing sets this yet, so no card will reach it/.test(await page.evaluate(() => document.body.innerText)));

  // ── D: a reorder names its pipeline, and nothing sets a status by hand ─────────────────
  // Scoped to the STATUS list: the stage rows above have the same control, and an unscoped
  // selector reorders the stages instead (which is what this check caught the first time).
  await page.locator("[data-ss-pipeline-statuses] button[title='Move down']").first().click();
  await page.waitForTimeout(700);
  const reorder = sent.filter((b) => b.action === "crm_statuses_reorder").pop();
  ok("D1 a reorder names the pipeline whose ladder it is, and posts that ladder whole",
    !!reorder && reorder.pipelineId === PIPELINES[0].id && Array.isArray(reorder.ids) && reorder.ids.length === after.length,
    JSON.stringify(reorder && { pipelineId: reorder.pipelineId, n: reorder.ids.length }));
  const stageSave = sent.find((b) => b.action === "crm_stage_save");
  ok("D2 no stage save carries a statusId", !stageSave || !("statusId" in stageSave), JSON.stringify(stageSave || null));
  ok("D3 nothing sent crm_deal_set_status", !sent.some((b) => b.action === "crm_deal_set_status"), JSON.stringify(sent.map((b) => b.action)));

  // ── E: AUTOMATIONS (migrations 355 + 363) ────────────────────────────────────────────
  // Shape and SAFETY, not wording. Several of these pin things that would be expensive to get
  // wrong in front of a builder's customers rather than merely untidy: a clock rule may not be
  // asked to repeat, a rule that messages the customer says so before it is saved, and a rule
  // MOVED to another pipeline cannot be saved while an action still names the old one's status.
  // E0 FIRST, while the pipeline panel is still open: the rules are NOT in it.
  ok("E0 the pipeline panel carries no rules — they have their own tab",
    (await page.locator("[data-ss-rules-list], [data-ss-rule-row]").count()) === 0
    && !/Add rule/.test(await page.evaluate(() => document.body.innerText)));

  await go("/settings/automations");
  await page.waitForFunction(() => !!document.querySelector("[data-ss-rules-list]"), null, { timeout: 15000 }).catch(() => {});
  const list = page.locator("[data-ss-rules-list]");
  const rowsOf = async () => page.locator("[data-ss-rule-row]").count();
  // Carolyn, 2026-11-04: "one flat list" — not one group per pipeline.
  ok("E1 the rules are ONE flat list inside the Automations card, every rule a row",
    (await page.locator("[data-ss-automations]").count()) === 1
    && (await list.count()) === 1
    && (await rowsOf()) === RULES.length
    && (await page.locator("[data-ss-automations-group], [data-ss-pipeline-rules]").count()) === 0
    && (await page.evaluate(() => document.querySelector("[data-ss-automations]").contains(document.querySelector("[data-ss-rules-list]")))),
    `rows=${await rowsOf()} of ${RULES.length}`);
  const tab = await page.locator("a, button").evaluateAll((els) => els
    .filter((e) => e.style && e.style.borderBottom && /solid/.test(e.style.borderBottom))
    .map((e) => ({ label: (e.textContent || "").trim(), current: e.getAttribute("aria-current") === "page" })));
  ok("E1b Automations is the current sub-tab",
    tab.some((t) => t.label === "Automations" && t.current), JSON.stringify(tab.map((t) => (t.current ? `[${t.label}]` : t.label))));
  // WHO EACH RULE IS FOR is on its own row now — it is no longer implied by a group heading.
  const pill = async (id) => {
    const el = page.locator(`[data-ss-rule-row="${id}"] [data-ss-rule-audience]`);
    return { kind: await el.getAttribute("data-ss-rule-audience"), text: (await el.innerText()).trim() };
  };
  const pA = await pill(U(600));
  const pC = await pill(U(602));
  ok("E2 each row says who its rule is for: a pipeline by name, or every pipeline",
    pA.kind === "pipeline" && /shed deals/i.test(pA.text) && pC.kind === "all_pipelines" && /every pipeline/i.test(pC.text),
    JSON.stringify([pA, pC]));
  const listText = (await list.innerText()).replace(/\s+/g, " ");
  ok("E3 a PAUSED rule says so — the commonest answer to 'why did nothing happen?'",
    (await page.locator("[data-ss-rule-paused]").count()) === 1 && /Paused — it will not run/.test(listText), listText.slice(0, 260));
  ok("E4 a rule reads back as a sentence, an unnamed one too, and 'every time' is stated",
    /When 30 days after it was delivered → Set the status to, then Send the customer a text/.test(listText)
    && /When contact is made.* → Add a note to the customer/.test(listText)
    && /Runs every time, not once per card/.test(listText), listText.slice(0, 400));
  ok("E4b its 'only if' reads back in words",
    /Only if the card's value is more than \$10,000/i.test(listText), listText.slice(0, 400));

  // THE FILTER narrows the list, and ↑↓ go off while it does: the order is the ACCOUNT's (it is
  // the order rules run in), and moving a rule among ones you cannot see would be a silent move.
  await page.locator("[data-ss-rules-filter]").selectOption("paused");
  await page.waitForTimeout(250);
  const pausedRows = await rowsOf();
  const upOff = await page.locator("[data-ss-rule-row] button[title='Move up']").first().isDisabled();
  await page.locator("[data-ss-rules-filter]").selectOption("all_pipelines");
  await page.waitForTimeout(250);
  const everyRows = await page.locator(`[data-ss-rule-row="${U(602)}"]`).count();
  const allRows = await rowsOf();
  await page.locator("[data-ss-rules-filter]").selectOption("all");
  await page.waitForTimeout(250);
  ok("E5 the filter narrows the list, and reordering is off while it does",
    pausedRows === 1 && upOff && everyRows === 1 && allRows === 1 && (await rowsOf()) === RULES.length,
    JSON.stringify({ pausedRows, upOff, everyRows, allRows }));

  // A NEW RULE. The editor opens IN PLACE under the list (Carolyn 2026-11-02, "not a pop-up").
  await page.locator("[data-ss-rules-add]").click();
  await page.waitForTimeout(400);
  const ed = page.locator("[data-ss-rule-editor]");
  ok("E6 the rule editor opens in place under the list, not as a pop-up", await page.evaluate(() => {
    const e = document.querySelector("[data-ss-rule-editor]");
    const l = document.querySelector("[data-ss-rules-list] > div:nth-of-type(2)");
    if (!e) return false;
    return getComputedStyle(e).position === "static" && !e.closest("[role=dialog]")
      && !!e.closest("[data-ss-automations]") && !!l && !!(l.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING);
  }));
  // RUNS ON — her four cards, the pipeline drop-down inside the first, the round-2 two disabled.
  const scopeState = await page.evaluate(() => [...document.querySelectorAll("[data-ss-rule-scope-option]")].map((l) => ({
    k: l.getAttribute("data-ss-rule-scope-option"), off: l.querySelector("input").disabled, on: l.querySelector("input").checked })));
  ok("E7 'Runs on' offers Carolyn's four choices, all of them live (365), one pipeline first and picked",
    JSON.stringify(scopeState.map((x) => x.k)) === JSON.stringify(["pipeline", "all_pipelines", "contacts", "none"])
    && scopeState[0].on && scopeState.every((x) => !x.off)
    && (await ed.locator("[data-ss-rule-pipeline]").inputValue()) === PIPELINES[0].id,
    JSON.stringify(scopeState));
  // THE PICKER DRIVES WHAT CAN BE DONE. One pipeline can set a status; every pipeline cannot —
  // a status belongs to one pipeline — so switching marks that action and holds Save.
  await ed.locator("button", { hasText: "+ Add action" }).click();
  await page.waitForTimeout(200);
  const kinds = async () => ed.locator("[data-ss-rule-actions] select[aria-label='What it does']").first()
    .evaluate((s) => [...s.options].map((o) => o.value));
  const onePipe = await kinds();
  await ed.locator("[data-ss-rule-scope-option='all_pipelines'] input").check();
  await page.waitForTimeout(250);
  const everyPipe = await kinds();
  const staleNow = await ed.locator("[data-ss-rule-action-stale]").count();
  const saveTxt = (await ed.locator("[data-ss-rule-save]").innerText()).trim();
  const saveOff = await ed.locator("[data-ss-rule-save]").isDisabled();
  ok("E8 picking 'every pipeline' takes away status and stage, marks the one already chosen, and holds Save",
    onePipe.includes("set_status") && onePipe.includes("move_stage")
    && !everyPipe.slice(1).includes("set_status") && !everyPipe.includes("move_stage")
    && staleNow === 1 && saveOff && /Re-pick 1 item first/.test(saveTxt)
    && (await ed.locator("[data-ss-rule-pipeline]").count()) === 0,
    JSON.stringify({ onePipe, everyPipe, staleNow, saveTxt }));
  await ed.locator("[data-ss-rule-scope-option='pipeline'] input").check();
  await page.waitForTimeout(250);
  ok("E8b back on one pipeline, the action is fine again", (await ed.locator("[data-ss-rule-action-stale]").count()) === 0);

  // A CLOCK RULE MAY NOT REPEAT (355's crm_rules_elapsed_is_once).
  await ed.locator("select[aria-label='When the rule runs']").selectOption("elapsed");
  await page.waitForTimeout(250);
  ok("E9 switching to a time rule locks 'only once per card' on",
    (await page.locator("[data-ss-rule-once-locked] input[type=checkbox]").count()) === 1
    && (await page.locator("[data-ss-rule-once-locked] input[type=checkbox]").isChecked())
    && (await page.locator("[data-ss-rule-once-locked] input[type=checkbox]").isDisabled()));
  // ONLY IF: the card's stage, picked from THIS pipeline's stages.
  await ed.locator("[data-ss-rule-conditions] button", { hasText: "+ Add condition" }).click();
  await page.waitForTimeout(200);
  await ed.locator("[data-ss-rule-condition='0'] select[aria-label='Condition field']").selectOption("deal.stage");
  await page.waitForTimeout(150);
  const stageOpts = await ed.locator("[data-ss-rule-condition='0'] select[aria-label='Condition value']").evaluate((s) => [...s.options].map((o) => o.textContent));
  await ed.locator("[data-ss-rule-condition='0'] select[aria-label='Condition value']").selectOption(SHED_STAGES[0].id);
  ok("E10 a stage condition offers this pipeline's stages and no other's",
    stageOpts.includes(SHED_STAGES[0].name) && !stageOpts.includes("Connected"), JSON.stringify(stageOpts));
  // THEN: text the customer — and be told, before saving, that it does so on its own.
  await ed.locator("[data-ss-rule-actions] select[aria-label='What it does']").first().selectOption("send_sms");
  await page.waitForTimeout(200);
  ok("E11 an action that reaches the customer warns before it is saved",
    (await page.locator("[data-ss-rule-outbound-warning]").count()) === 1
    && /messages the customer by itself/.test(await page.locator("[data-ss-rule-outbound-warning]").innerText()));
  await ed.locator("textarea[aria-label='Text message']").fill("Hi {{first_name}}, how did we do?");
  await ed.locator("input[aria-label='Days']").first().fill("45");
  await ed.locator("select[aria-label='Counted from']").selectOption("delivered");
  await page.screenshot({ path: join(shots, "rule-editor.png") });
  await ed.locator("[data-ss-rule-save]").click();
  await page.waitForTimeout(800);
  const saved = sent.filter((b) => b.action === "crm_rule_save").pop();
  ok("E12 the save posts the whole rule — who it is for, trigger, once, the condition and the actions",
    !!saved && !saved.id && saved.scopeKind === "pipeline" && saved.pipelineId === PIPELINES[0].id
    && saved.triggerKind === "elapsed" && saved.elapsedAnchor === "delivered" && saved.elapsedDays === 45 && saved.oncePerCard === true
    && JSON.stringify(saved.conditions) === JSON.stringify([{ field: "deal.stage", op: "eq", value: SHED_STAGES[0].id }])
    && Array.isArray(saved.actions) && saved.actions.length === 1 && saved.actions[0].kind === "send_sms"
    && /how did we do\?/.test(String(saved.actions[0].params.body)),
    JSON.stringify(saved));
  ok("E12b the new rule joins the list", /45 days after it was delivered/.test((await list.innerText()).replace(/\s+/g, " ")));

  // ── THE MOVE (Carolyn's decision 2, 2026-11-04) ─────────────────────────────────────────
  // "Ask for a review" sets Shed Deals' Delivered status. Moved to Manufacturer Outreach, that
  // action names a status that is not there: it goes red, Save waits, and re-picking clears it.
  await page.locator(`[data-ss-rule-row="${U(600)}"] button`, { hasText: "Edit" }).click();
  await page.waitForTimeout(400);
  await ed.locator("[data-ss-rule-pipeline]").selectOption(PIPELINES[1].id);
  await page.waitForTimeout(250);
  const mvStale = await ed.locator("[data-ss-rule-action-stale]").count();
  const mvCondStale = await ed.locator("[data-ss-rule-condition-stale]").count();
  const mvNote = await ed.locator("[data-ss-rule-moved]").count();
  const mvSave = (await ed.locator("[data-ss-rule-save]").innerText()).trim();
  ok("E13 moving a rule marks the action that still names the old pipeline, says the rule starts fresh, and holds Save",
    mvStale === 1 && mvCondStale === 0 && mvNote === 1 && /Re-pick 1 item first/.test(mvSave)
    && (await ed.locator("[data-ss-rule-save]").isDisabled()),
    JSON.stringify({ mvStale, mvCondStale, mvNote, mvSave }));
  await ed.locator("[data-ss-rule-action='0'] select[aria-label='Status to set']").selectOption(U(400));
  await page.waitForTimeout(250);
  await ed.locator("[data-ss-rule-save]").click();
  await page.waitForTimeout(800);
  const moved = sent.filter((b) => b.action === "crm_rule_save").pop();
  ok("E14 re-picked, the move saves — the new pipeline, and the status from IT",
    !!moved && moved.id === U(600) && moved.scopeKind === "pipeline" && moved.pipelineId === PIPELINES[1].id
    && moved.actions[0].kind === "set_status" && moved.actions[0].params.statusId === U(400)
    && (await pill(U(600))).text.toLowerCase().includes("manufacturer outreach"),
    JSON.stringify(moved));
  // And when the SERVER refuses (it re-checks what was stored), its sentence is what you read.
  force409 = true;
  await page.locator(`[data-ss-rule-row="${U(601)}"] button`, { hasText: "Edit" }).click();
  await page.waitForTimeout(400);
  await ed.locator("[data-ss-rule-save]").click();
  await page.waitForTimeout(600);
  ok("E15 a refusal from the server is shown in its own words, and the editor stays open",
    (await page.locator("[data-ss-rule-save-error]").count()) === 1
    && /Action 1 \(Add a note to the customer\)/.test(await page.locator("[data-ss-rule-save-error]").innerText())
    && (await ed.count()) === 1);
  await ed.locator("button", { hasText: "Cancel" }).click();
  await page.waitForTimeout(300);

  // THE ORDER IS THE ACCOUNT'S: a reorder posts every rule, and names no pipeline.
  await page.locator("[data-ss-rule-row] button[title='Move down']").first().click();
  await page.waitForTimeout(500);
  const ro = sent.filter((b) => b.action === "crm_rules_reorder").pop();
  ok("E16 a reorder posts the whole account's list, with no pipeline",
    !!ro && Array.isArray(ro.ids) && ro.ids.length === RULES.length && !("pipelineId" in ro), JSON.stringify(ro));

  // WHY A RULE DID NOTHING — per rule, and for the whole account.
  await page.locator(`[data-ss-rule-row="${U(600)}"] [data-ss-rule-runs-toggle]`).click();
  await page.waitForTimeout(600);
  const logText = (await page.locator("[data-ss-rule-log]").innerText()).replace(/\s+/g, " ");
  ok("E17 a rule's runs explain a skip, a miss on its conditions, a failure, a queued text and one waiting for morning",
    /already run for this card/.test(logText) && /its conditions did not match/.test(logText) && /status not found/.test(logText)
    && /queued — waiting to go out/.test(logText) && /outside texting hours where they live/.test(logText)
    && /Dale Smith/.test(logText),
    logText.slice(0, 400));
  const lastLog = sent.filter((b) => b.action === "crm_rule_log").pop();
  await page.locator("[data-ss-rules-recent]").click();
  await page.waitForTimeout(600);
  const pageLog = sent.filter((b) => b.action === "crm_rule_log").pop();
  ok("E18 the log is asked for by RULE, and the page-wide one by nothing at all",
    !!lastLog && lastLog.ruleId === U(600) && !("pipelineId" in lastLog)
    && !!pageLog && !("ruleId" in pageLog) && !("pipelineId" in pageLog)
    && (await page.locator("[data-ss-rules-recent-log]").count()) === 1
    && /Ask for a review:/.test(await page.locator("[data-ss-rules-recent-log]").innerText()),
    JSON.stringify([lastLog, pageLog]));
  await page.screenshot({ path: join(shots, "rule-log.png"), fullPage: true });

  // ── ROUND 2a (365): customers, team-only, schedules, the arm ───────────────────────────
  const unarmedRow = page.locator(`[data-ss-rule-row="${U(603)}"]`);
  ok("E21 a scheduled text that is not armed says so on its row, with its next run, and who it is for",
    (await unarmedRow.locator("[data-ss-rule-unarmed]").count()) === 1
    && (await unarmedRow.locator("[data-ss-rule-next]").count()) === 1
    && /every Monday at 8:00 am/.test(await unarmedRow.innerText())
    && /customers tagged lot visitor/i.test(await unarmedRow.locator("[data-ss-rule-audience]").innerText()),
    (await unarmedRow.innerText()).replace(/\s+/g, " ").slice(0, 200));

  await page.locator("[data-ss-rules-add]").click();
  await page.waitForTimeout(400);
  // CUSTOMERS: the customer facts are offered, card-only actions are not, and the count appears.
  await ed.locator("[data-ss-rule-scope-option='contacts'] input").check();
  await page.waitForTimeout(900);
  const evs = await ed.locator("select[aria-label='Which event']").evaluate((s) => [...s.options].map((o) => o.value));
  await ed.locator("button", { hasText: "+ Add action" }).click();
  await page.waitForTimeout(200);
  const cKinds = await kinds();
  ok("E22 a rule on customers hears customer facts, offers tags and tasks, and no card actions",
    evs.includes("label_added") && evs.includes("call_missed") && evs.includes("meeting_no_show")
    && cKinds.includes("add_label") && cKinds.includes("create_task") && cKinds.includes("assign_owner")
    && !cKinds.includes("set_status") && !cKinds.includes("mark_lost"),
    JSON.stringify({ evs: evs.length, cKinds }));
  // 367: the facts after the estimate, and email + the shop, each in its own group of the list.
  const groups = await ed.locator("select[aria-label='Which event']").evaluate((s) =>
    [...s.querySelectorAll("optgroup")].map((g) => ({ label: g.label, keys: [...g.querySelectorAll("option")].map((o) => o.value) })));
  const grp = (re) => (groups.find((g) => re.test(g.label)) || { keys: [] }).keys;
  const evSel = ed.locator("select[aria-label='Which event']");
  await evSel.selectOption("email_opened");
  await page.waitForTimeout(150);
  const emailNote = (await ed.locator("[data-ss-rule-inbound-note]").innerText().catch(() => "")).replace(/\s+/g, " ");
  await evSel.selectOption("call_missed");
  await page.waitForTimeout(150);
  const phoneNote = (await ed.locator("[data-ss-rule-inbound-note]").innerText().catch(() => "")).replace(/\s+/g, " ");
  await evSel.selectOption("payment_received");
  await page.waitForTimeout(150);
  ok("E26 (367) payments, change orders, builds, repairs, the lot, email and the shop are offered in their own groups; email facts run once a day",
    groups.length === 4
    && JSON.stringify(grp(/^Payments/)) === JSON.stringify(["payment_received", "change_order_sent", "change_order_signed",
      "build_completed", "delivery_scheduled", "lot_sold", "repair_requested", "repair_completed"])
    && JSON.stringify(grp(/^Email/)) === JSON.stringify(["email_received", "email_opened", "email_bounced", "shop_request", "shop_purchase"])
    && grp(/^Customers/).includes("call_missed") && !grp(/^Customers/).includes("email_opened")
    && /once a day/.test(emailNote) && /hint, not proof/.test(emailNote) && !/missed callers/.test(emailNote)
    && /missed callers/.test(phoneNote)
    && (await ed.locator("[data-ss-rule-inbound-note]").count()) === 0,
    JSON.stringify({ groups: groups.map((g) => g.label + ":" + g.keys.length), emailNote, phoneNote }));
  // THE MONDAY TEXT: tagged Lot visitor, weekly Mon + Thu at 08:00, a text — armed with the count.
  await ed.locator("select[aria-label='When the rule runs']").selectOption("schedule");
  await page.waitForTimeout(250);
  const thu = ed.locator("[data-ss-rule-weekday='4']");
  await thu.click();
  await ed.locator("input[aria-label='At']").fill("08:00");
  await ed.locator("[data-ss-rule-conditions] button", { hasText: "+ Add condition" }).click();
  await page.waitForTimeout(150);
  await ed.locator("[data-ss-rule-condition='0'] select[aria-label='Condition field']").selectOption("contact.label");
  await page.waitForTimeout(150);
  await ed.locator("[data-ss-rule-condition='0'] input[aria-label='Condition value']").fill("Lot visitor");
  await ed.locator("[data-ss-rule-actions] select[aria-label='What it does']").first().selectOption("send_sms");
  await page.waitForTimeout(200);
  await ed.locator("textarea[aria-label='Text message']").fill("New sheds on the lot this week, {{first_name}}!");
  await page.waitForTimeout(1200);
  const schedOpts = await ed.locator("[data-ss-rule-actions] select[aria-label='What it does']").first().evaluate((s) => [...s.options].map((o) => o.value));
  const tzVal = await ed.locator("[data-ss-rule-timezone] select").inputValue();
  const prev = (await ed.locator("[data-ss-rule-audience-preview]").innerText()).replace(/\s+/g, " ");
  ok("E23 a schedule names the time zone, counts who it reaches, and (366) may send email",
    tzVal === "America/Chicago" && /312 customers now/.test(prev) && /Dale Smith/.test(prev)
    && schedOpts.includes("send_email") && (await ed.locator("[data-ss-rule-arm]").count()) === 1,
    JSON.stringify({ tzVal, prev, schedOpts }));
  await ed.locator("[data-ss-rule-arm] input").check();
  await page.screenshot({ path: join(shots, "rule-schedule.png") });
  await ed.locator("[data-ss-rule-save]").click();
  await page.waitForTimeout(800);
  const sched = sent.filter((b) => b.action === "crm_rule_save").pop();
  ok("E24 the Monday text posts its schedule, its filter, and the arm WITH the count on screen",
    !!sched && sched.scopeKind === "contacts" && !("pipelineId" in sched) && sched.triggerKind === "schedule"
    && JSON.stringify(sched.schedule) === JSON.stringify({ freq: "weekly", at: "08:00", days: [1, 4], every: 1 })
    && JSON.stringify(sched.conditions) === JSON.stringify([{ field: "contact.label", op: "has", value: "Lot visitor" }])
    && sched.arm === true && sched.armedCount === 312 && sched.oncePerCard === true,
    JSON.stringify(sched));

  // NOBODY — JUST THE TEAM: a schedule, and the only thing it can do is email the team.
  await page.locator("[data-ss-rules-add]").click();
  await page.waitForTimeout(400);
  await ed.locator("[data-ss-rule-scope-option='none'] input").check();
  await page.waitForTimeout(250);
  const whenOpts = await ed.locator("select[aria-label='When the rule runs']").evaluate((s) => [...s.options].map((o) => o.value));
  await ed.locator("button", { hasText: "+ Add action" }).click();
  await page.waitForTimeout(200);
  const teamKinds = await kinds();
  ok("E25 a rule for nobody runs only on a schedule, and can only email the team — with no arm to press",
    JSON.stringify(whenOpts) === JSON.stringify(["schedule"]) && JSON.stringify(teamKinds) === JSON.stringify(["notify_team"])
    && (await ed.locator("[data-ss-rule-arm]").count()) === 0,
    JSON.stringify({ whenOpts, teamKinds }));
  await ed.locator("button", { hasText: "Cancel" }).click();
  await page.waitForTimeout(300);

  // ── E19: the database cannot store this shape of rule yet ───────────────────────────────
  // The function reaches production the moment it is deployed, and the migration is a separate
  // step. Version 1 (355 only) must offer NOTHING — not error, not a "+ Add rule" that cannot save.
  rulesVersion = 1;
  await go("/settings");
  await go("/settings/automations");
  await page.waitForTimeout(700);
  ok("E19 without migration 363 on the database, Automations says so and offers nothing",
    (await page.locator("[data-ss-automations-unready]").count()) === 1
    && (await page.locator("[data-ss-rules-list], [data-ss-rule-row]").count()) === 0
    && !/Add rule/.test(await page.evaluate(() => document.body.innerText)),
    (await page.locator("[data-ss-automations]").innerText()).replace(/\s+/g, " ").slice(0, 160));
  // And the pipeline panel is unaffected either way: it has nothing to drop any more.
  await go("/settings/pipelines");
  await page.waitForTimeout(400);
  await page.locator("[data-ss-pipeline-row] button", { hasText: "Edit" }).first().click();
  await page.waitForTimeout(700);
  ok("E20 the pipeline panel still edits statuses, with no rules to lose",
    (await page.locator("input[aria-label='Status name']").count()) > 0
    && (await page.locator("[data-ss-rules-list], [data-ss-rule-row]").count()) === 0);

  ok("Z no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await browser.close();
}

console.log(`\nshots: ${shots}`);
const bad = failed();
if (bad.length) { console.log(`\ncrmPipelineSettings: ${bad.length} FAILED`); process.exit(1); }
console.log("all checks held");
