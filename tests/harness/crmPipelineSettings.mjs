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
// FALSE is what portal-settings sends while migration 355 is not applied to the database it is
// talking to (beta and production share one project, so the function can be live before the
// migration). E11 flips it: the Rules section must then not be offered at all.
let rulesReady = true;
const rungs = (base) => LADDER.map(([name, color, triggerEvent], i) => ({ id: U(base + i), name, color, position: (i + 1) * 1024, triggerEvent }));
const SHED_STAGES = ["New Incoming", "Attempting Contact", "Nurturing - Cool", "Nurturing - Warm", "Nurturing - Hot", "Gone Cold Again"]
  .map((name, i) => ({ id: U(200 + i), name, color: "#64748B", kind: "open", position: (i + 1) * 1024 }));
// Shed Deals carries the whole ladder; the hand-made one keeps only what its cards use — which is
// exactly what 354's backfill does, and what Carolyn asked for ("I don't want any changes to my
// Builders pipeline").
// RULES (355), Part D. Carolyn's own example is the first one: ask for a review 30 days after the
// shed was delivered. The second is deliberately the awkward pair — no name, and PAUSED — because
// "why did nothing happen?" is a paused rule far more often than it is a bug.
const RULES = [
  { id: U(600), name: "Ask for a review", triggerKind: "elapsed", triggerEvent: null,
    elapsedAnchor: "delivered", elapsedDays: 30, oncePerCard: true, enabled: true, position: 1024,
    actions: [
      { id: U(610), kind: "set_status", params: { statusId: U(107) }, position: 1024 },
      { id: U(611), kind: "send_sms", params: { body: "Hi {{first_name}}, how is the shed?" }, position: 2048 },
    ] },
  { id: U(601), name: null, triggerKind: "event", triggerEvent: "contact_made",
    elapsedAnchor: null, elapsedDays: null, oncePerCard: false, enabled: false, position: 2048,
    actions: [{ id: U(620), kind: "add_note", params: { body: "Someone got through." }, position: 1024 }] },
];
const PIPELINES = [
  { id: U(1), name: "Shed Deals", position: 1024, lostReasons: ["Price", "Timing"], seedKind: "shed_deals", feedsDesigns: true,
    stages: SHED_STAGES, statuses: rungs(100), rules: RULES },
  { id: U(2), name: "Manufacturer Outreach", position: 2048, lostReasons: ["Not interested"], seedKind: "outreach", feedsDesigns: false,
    stages: [{ id: U(300), name: "New Lead", color: "#64748B", kind: "open", position: 1024 }, { id: U(301), name: "Connected", color: "#16A34A", kind: "open", position: 2048 }],
    statuses: [{ id: U(400), name: "Reached out", color: "#64748B", position: 1024, triggerEvent: null }], rules: [] },
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
      return json(route, { ok: true, pipelines: PIPELINES, statuses: live, team: [], canManage: true, canWrite: true, ownOnly: false, me: USER.id, rulesReady });
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
    // ── RULES (355) ───────────────────────────────────────────────────────────────────────
    case "crm_rule_save": {
      const owner = PIPELINES.find((p) => p.id === body.pipelineId) || PIPELINES.find((p) => (p.rules || []).some((r) => r.id === body.id));
      if (!owner) return json(route, { error: "That pipeline wasn't found." }, 404);
      if (!body.id) {
        const made = {
          id: U(700 + owner.rules.length), name: body.name || null, triggerKind: body.triggerKind,
          triggerEvent: body.triggerEvent || null, elapsedAnchor: body.elapsedAnchor || null,
          elapsedDays: body.elapsedDays == null ? null : body.elapsedDays,
          oncePerCard: body.oncePerCard !== false, enabled: body.enabled !== false,
          position: (owner.rules.length + 1) * 1024,
          actions: (body.actions || []).map((a, i) => ({ id: U(750 + i), kind: a.kind, params: a.params || {}, position: (i + 1) * 1024 })),
        };
        owner.rules.push(made);
        return json(route, { ok: true, id: made.id });
      }
      const r = owner.rules.find((x) => x.id === body.id);
      if (!r) return json(route, { error: "That rule wasn't found." }, 404);
      if (body.archive) owner.rules = owner.rules.filter((x) => x.id !== body.id);
      else {
        if (body.enabled !== undefined) r.enabled = body.enabled;
        if (body.name !== undefined) r.name = body.name || null;
        if (body.triggerKind) {
          r.triggerKind = body.triggerKind;
          r.triggerEvent = body.triggerEvent || null;
          r.elapsedAnchor = body.elapsedAnchor || null;
          r.elapsedDays = body.elapsedDays == null ? null : body.elapsedDays;
        }
        if (body.oncePerCard !== undefined) r.oncePerCard = body.oncePerCard;
        if (body.actions !== undefined) r.actions = body.actions.map((a, i) => ({ id: U(760 + i), kind: a.kind, params: a.params || {}, position: (i + 1) * 1024 }));
      }
      return json(route, { ok: true, id: body.id });
    }
    case "crm_rules_reorder": {
      const owner = PIPELINES.find((p) => p.id === body.pipelineId);
      if (owner) owner.rules = body.ids.map((id) => owner.rules.find((r) => r.id === id)).filter(Boolean);
      return json(route, { ok: true });
    }
    case "crm_rule_log":
      // The three answers to "why did nothing happen?" that are NOT a bug, which is the whole
      // point of the log: it was held by the once guard, it threw, or it is still queued.
      return json(route, { ok: true,
        runs: [
          { id: 3, ruleId: U(600), dealId: U(900), trigger: "elapsed:delivered+30d", outcome: "skipped",
            detail: { reason: "already run for this card" }, firedAt: "2026-11-02T10:00:00Z" },
          { id: 2, ruleId: U(600), dealId: U(901), trigger: "elapsed:delivered+30d", outcome: "failed",
            detail: { sqlstate: "P0002", error: "status not found" }, firedAt: "2026-11-02T09:00:00Z" },
          { id: 1, ruleId: U(600), dealId: U(902), trigger: "elapsed:delivered+30d", outcome: "done",
            detail: { actions: [] }, firedAt: "2026-11-02T08:00:00Z" },
        ],
        outbox: [{ id: 9, ruleId: U(600), dealId: U(903), kind: "send_sms", state: "queued", attempts: 0, lastError: null, queuedAt: "2026-11-02T10:05:00Z", sentAt: null }],
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

  // ── E: RULES (migration 355, Part D) ──────────────────────────────────────────────────
  // Shape and SAFETY, not wording. Two of these pin things that would be expensive to get
  // wrong in front of a builder's customers rather than merely untidy: a clock rule may not be
  // asked to repeat, and a rule that messages the customer says so before it is saved.
  // E0 FIRST, while the pipeline panel is still open: the rules are NOT in it any more.
  ok("E0 the pipeline panel carries no rules — they moved to their own tab",
    (await page.locator("[data-ss-pipeline-rules]").count()) === 0
    && !/Add rule/.test(await page.evaluate(() => document.body.innerText)));

  await go("/settings/automations");
  await page.waitForTimeout(600);
  const groups = page.locator("[data-ss-automations-group]");
  ok("E1 the rules have their own tab, one group per pipeline, inside the Automations card",
    (await page.locator("[data-ss-automations]").count()) === 1
    && (await groups.count()) === PIPELINES.length
    && (await page.locator("[data-ss-pipeline-rules]").count()) === PIPELINES.length
    && (await page.evaluate(() => {
      const card = document.querySelector("[data-ss-automations]");
      const g = document.querySelectorAll("[data-ss-automations-group]");
      return !!card && g.length > 0 && Array.from(g).every((x) => card.contains(x))
        && Array.from(g).every((x) => !!x.querySelector("[data-ss-pipeline-rules]"));
    })),
    `groups=${await groups.count()} of ${PIPELINES.length}`);
  // The tab bar says where you are, and a group is headed by the pipeline it belongs to — the
  // only thing on this page that says which pipeline a rule will act on.
  // ⚠️ innerText RESPECTS text-transform, and the group heading is uppercased in CSS (S.lbl), so
  // it comes back "SHED DEALS" while the fixture says "Shed Deals". Compare case-insensitively —
  // this check failed on exactly that the first time it ran, which is the harness earning its keep.
  const autoText = (await page.locator("[data-ss-automations]").innerText()).toLowerCase();
  const tab = await page.locator("a, button").evaluateAll((els) => els
    .filter((e) => e.style && e.style.borderBottom && /solid/.test(e.style.borderBottom))
    .map((e) => ({ label: (e.textContent || "").trim(), current: e.getAttribute("aria-current") === "page" })));
  ok("E1b Automations is the current sub-tab, and each group is headed by its own pipeline",
    tab.some((t) => t.label === "Automations" && t.current)
    && autoText.includes(PIPELINES[0].name.toLowerCase())
    && autoText.includes(PIPELINES[1].name.toLowerCase()),
    JSON.stringify(tab.map((t) => (t.current ? `[${t.label}]` : t.label))));
  // Every assertion below is about the FIRST pipeline's group: it is the one the fixture gives
  // rules to, and an unscoped selector would reach into the other pipeline's list.
  const rules = page.locator(`[data-ss-automations-group="${PIPELINES[0].id}"] [data-ss-pipeline-rules]`);
  ok("E1c a pipeline with no rules still gets a group, so a first rule can be added there",
    /No rules on this pipeline yet/.test(await page.locator(`[data-ss-automations-group="${PIPELINES[1].id}"]`).innerText()));
  const ruleText = (await rules.innerText()).replace(/\s+/g, " ");
  ok("E2 a rule reads back as a sentence, trigger and actions in order",
    /Ask for a review/.test(ruleText)
    && /When 30 days after it was delivered → Set the status to, then Send the customer a text/.test(ruleText),
    ruleText.slice(0, 220));
  ok("E3 a PAUSED rule says so — the commonest answer to 'why did nothing happen?'",
    (await page.locator("[data-ss-rule-paused]").count()) === 1
    && /Paused — it will not run/.test(ruleText), ruleText.slice(0, 260));
  // A rule with no name falls back to its own sentence, so a list of unnamed rules is still
  // readable; and a rule set to run every time says that too, because it is the other half of
  // "why did this customer hear from us twice?".
  ok("E4 an unnamed rule still reads as a sentence, and 'every time' is stated",
    /When contact is made.* → Add a note to the customer/.test(ruleText)
    && /Runs every time, not once per card/.test(ruleText), ruleText.slice(0, 400));

  // The editor opens IN PLACE, the way Carolyn asked the pipeline panel to (2026-11-02), one
  // level down: measured as position, not as a label.
  await rules.locator("button", { hasText: "+ Add rule" }).click();
  await page.waitForTimeout(400);
  ok("E5 the rule editor opens in place under the rules, not as a pop-up", await page.evaluate(() => {
    const ed = document.querySelector("[data-ss-rule-editor]");
    if (!ed) return false;
    const cs = getComputedStyle(ed);
    return cs.position === "static" && !ed.closest("[role=dialog]")
      && !!ed.closest("[data-ss-automations-group]");
  }));

  // A CLOCK RULE MAY NOT REPEAT (355's crm_rules_elapsed_is_once). Once it comes due it stays
  // due, so a repeating one would text the same customer every sweep.
  await page.locator("[data-ss-rule-editor] select[aria-label='When the rule runs']").selectOption("elapsed");
  await page.waitForTimeout(250);
  ok("E6 switching to a time rule locks 'only once per card' on",
    (await page.locator("[data-ss-rule-once-locked] input[type=checkbox]").count()) === 1
    && (await page.locator("[data-ss-rule-once-locked] input[type=checkbox]").isChecked())
    && (await page.locator("[data-ss-rule-once-locked] input[type=checkbox]").isDisabled()));

  await page.locator("[data-ss-rule-editor] button", { hasText: "+ Add action" }).click();
  await page.waitForTimeout(250);
  await page.locator("[data-ss-rule-actions] select[aria-label='What it does']").first().selectOption("send_sms");
  await page.waitForTimeout(250);
  ok("E7 an action that reaches the customer warns before it is saved",
    (await page.locator("[data-ss-rule-outbound-warning]").count()) === 1
    && /messages the customer by itself/.test(await page.locator("[data-ss-rule-outbound-warning]").innerText()));
  await page.locator("[data-ss-rule-editor] textarea[aria-label='Text message']").fill("Hi {{first_name}}, how did we do?");
  await page.locator("[data-ss-rule-editor] input[aria-label='Days']").fill("45");
  await page.locator("[data-ss-rule-editor] select[aria-label='Counted from']").selectOption("delivered");
  await page.screenshot({ path: join(shots, "rule-editor.png") });
  await page.locator("[data-ss-rule-editor] button", { hasText: "Save rule" }).click();
  await page.waitForTimeout(800);
  const saved = sent.filter((b) => b.action === "crm_rule_save").pop();
  ok("E8 the save posts the whole rule — trigger, days, once, and the actions in order",
    !!saved && saved.pipelineId === PIPELINES[0].id && saved.triggerKind === "elapsed"
    && saved.elapsedAnchor === "delivered" && saved.elapsedDays === 45 && saved.oncePerCard === true
    && Array.isArray(saved.actions) && saved.actions.length === 1 && saved.actions[0].kind === "send_sms"
    && /how did we do\?/.test(String(saved.actions[0].params.body)),
    JSON.stringify(saved));
  ok("E9 the new rule joins the list", /45 days after it was delivered/.test((await rules.innerText()).replace(/\s+/g, " ")),
    (await rules.innerText()).replace(/\s+/g, " ").slice(0, 300));

  await rules.locator("button", { hasText: "Recent runs" }).click();
  await page.waitForTimeout(600);
  const logText = (await page.locator("[data-ss-rule-log]").innerText()).replace(/\s+/g, " ");
  ok("E10 the run log explains a skip, a failure and a message still queued",
    /already run for this card/.test(logText) && /status not found/.test(logText)
    && /queued — waiting to go out/.test(logText), logText.slice(0, 300));
  await page.screenshot({ path: join(shots, "rule-log.png") });
  // ── E11: the database has no rules tables yet ───────────────────────────────────────────
  // The whole panel must keep working and simply not offer rules — not error, and not show a
  // "+ Add rule" that cannot save. This is the ordering trap: the function reaches production
  // the moment it is deployed, and the migration is a separate step.
  rulesReady = false;
  await go("/settings");
  await go("/settings/automations");
  await page.waitForTimeout(600);
  ok("E11 with no rules tables on the database, Automations says so and offers nothing",
    (await page.locator("[data-ss-automations-unready]").count()) === 1
    && (await page.locator("[data-ss-pipeline-rules]").count()) === 0
    && (await page.locator("[data-ss-automations-group]").count()) === 0
    && !/Add rule/.test(await page.evaluate(() => document.body.innerText)),
    (await page.locator("[data-ss-automations]").innerText()).replace(/\s+/g, " ").slice(0, 160));
  // And the pipeline panel is unaffected either way: it has nothing to drop any more.
  await go("/settings/pipelines");
  await page.waitForTimeout(400);
  await page.locator("[data-ss-pipeline-row] button", { hasText: "Edit" }).first().click();
  await page.waitForTimeout(700);
  ok("E12 the pipeline panel still edits statuses, with no rules to lose",
    (await page.locator("input[aria-label='Status name']").count()) > 0
    && (await page.locator("[data-ss-pipeline-rules]").count()) === 0);

  ok("Z no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await browser.close();
}

console.log(`\nshots: ${shots}`);
const bad = failed();
if (bad.length) { console.log(`\ncrmPipelineSettings: ${bad.length} FAILED`); process.exit(1); }
console.log("all checks held");
