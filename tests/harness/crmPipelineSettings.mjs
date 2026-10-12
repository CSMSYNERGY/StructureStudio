// Settings → Pipelines and the stage editor after migration 303 (Carolyn's 2026-10-12 call), driven
// for real on the COMPILED portal.
//
// Carolyn: "I want quotes gone", and "the statuses are system-driven, 100%". What this proves:
//
//   A  Settings → Pipelines: the Statuses card says the system sets a status and nobody changes one
//      by hand; each status keeps its "Set automatically when" drop-down (a status no event sets
//      reads "Nothing yet", never "set by hand"); the Pipelines card names no stage→status link,
//      and Shed Deals carries the "new designs" badge.
//   B  the stage editor (Edit stages on Shed Deals): every stage keeps name, colour, kind, order
//      and remove (C16), and there is no "Linked status" drop-down; the help says a move never
//      changes a status and new designs land in the first open stage; Shed Deals (the pipeline new
//      designs land in) offers no "Remove pipeline", another pipeline still does.
//   C  nothing on either screen sends crm_deal_set_status, and saving a stage name sends no
//      statusId.
//
// Supabase is stubbed at the network layer (no login, nothing leaves the machine); the skeleton is
// crmContactDeal.mjs's.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/crmPipelineSettings.mjs    (exit 0 = every check held)
//
// Shots land in %TEMP%/ss-harness/crm-pipeline-settings (SS_SHOTS overrides). SS_PORTAL_ARTIFACT=<an
// older portal.app.compiled.js> serves that file instead: against the artifact from before 303, A
// and B fail on the "set by hand" copy and the Linked status drop-down.
//
// ⚠️ EVERY CHECK IS GUARDED BY "the card rendered": nothing to find is not the same as nothing there.
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
// Carolyn's status set, as 302 seeded it (Appt Set has no event).
const STATUSES = [
  ["New Lead", "#64748B", "design_submitted"], ["Appt Set", "#0EA5E9", null], ["Estimate Sent", "#6366F1", "estimate_sent"],
  ["Accepted", "#16A34A", "estimate_accepted"], ["Invoiced", "#14B8A6", "invoiced"], ["Payment Received", "#84CC16", "paid_in_full"],
  ["Scheduling", "#F59E0B", "build_scheduled"], ["Delivered", "#0F766E", "delivered"],
].map(([name, color, triggerEvent], i) => ({ id: U(100 + i), name, color, position: (i + 1) * 1024, triggerEvent }));
const SHED_STAGES = ["New Incoming", "Attempting Contact", "Nurturing - Cool", "Nurturing - Warm", "Nurturing - Hot", "Gone Cold Again"]
  .map((name, i) => ({ id: U(200 + i), name, color: "#64748B", kind: "open", position: (i + 1) * 1024 }));
const PIPELINES = [
  { id: U(1), name: "Shed Deals", position: 1024, lostReasons: ["Price", "Timing"], seedKind: "shed_deals", feedsDesigns: true, stages: SHED_STAGES },
  { id: U(2), name: "Manufacturer Outreach", position: 2048, lostReasons: [], seedKind: "outreach", feedsDesigns: false,
    stages: [{ id: U(300), name: "New Lead", color: "#64748B", kind: "open", position: 1024 }, { id: U(301), name: "Won", color: "#16A34A", kind: "won", position: 2048 }] },
];

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
      return json(route, { ok: true, pipelines: PIPELINES, statuses: STATUSES, team: [], canManage: true, canWrite: true, ownOnly: false, me: USER.id });
    case "crm_stage_save": return json(route, { ok: true, id: body.id || U(399) });
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
  await go("/portal/settings/pipelines");
  await page.waitForFunction(() => !!document.querySelector("[data-ss-pipeline-settings] input[aria-label='Status name']"), null, { timeout: 20000 })
    .catch(() => { /* the guard below reports it */ });
  await page.waitForTimeout(500);

  // THE GUARD.
  const card = page.locator("[data-ss-pipeline-settings]");
  const names = await page.locator("[data-ss-pipeline-settings] input[aria-label='Status name']").evaluateAll((els) => els.map((e) => e.value));
  const rendered = ok("the Statuses card rendered with the 8 statuses", (await card.count()) === 1 && names.length === 8, JSON.stringify(names));
  if (!rendered) throw new Error("Settings → Pipelines never rendered; refusing to report the rest as passes");
  await page.screenshot({ path: join(shots, "settings-pipelines.png"), fullPage: true });

  // ── A ──
  const text = await page.evaluate(() => document.body.innerText);
  ok("A1 Carolyn's status set is kept, Appt Set and Delivered included (C13)", JSON.stringify(names) === JSON.stringify(STATUSES.map((s) => s.name)));
  ok("A2 the card says the system sets a status and nobody changes one by hand", /the system sets it/.test(text) && /nobody\s+changes one by hand/.test(text));
  ok("A3 nothing says a status can be set by hand", !/set by hand\)|can still change a status by hand|by hand, or automatically/i.test(text));
  const triggers = await page.locator("[data-ss-pipeline-settings] select[aria-label='Set automatically when']").evaluateAll((els) =>
    els.map((e) => e.options[e.selectedIndex] ? e.options[e.selectedIndex].text : null));
  ok("A4 every status keeps its 'Set automatically when'; Appt Set reads 'Nothing yet'", triggers.length === 8 && triggers[1] === "Nothing yet" && triggers[0] === "A design is submitted", JSON.stringify(triggers));
  ok("A5 the Pipelines card names no stage→status link, nor Quotes", !/link stages to statuses|Link a stage/i.test(text) && !/\bQuotes\b/.test(text));
  ok("A6 Shed Deals carries the 'new designs' badge", await page.evaluate(() =>
    [...document.querySelectorAll("span")].some((s) => /^Shed Deals/.test((s.innerText || "").trim()) && /new designs/.test(s.innerText || ""))));

  // ── B ──
  await page.locator("button", { hasText: "Edit stages" }).first().click();
  await page.waitForTimeout(700);
  const stageNames = await page.locator("input[aria-label='Stage name']").evaluateAll((els) => els.map((e) => e.value));
  const editorUp = ok("B0 the Shed Deals stage editor opened with its 6 stages", stageNames.length === 6 && stageNames[0] === "New Incoming", JSON.stringify(stageNames));
  if (editorUp) {
    await page.screenshot({ path: join(shots, "stage-editor.png") });
    const modal = await page.evaluate(() => document.body.innerText);
    ok("B1 no 'Linked status' drop-down on any stage", (await page.locator("select[aria-label='Linked status']").count()) === 0
      && !/No status link/.test(modal));
    ok("B2 each stage keeps colour, kind, up/down and remove (C16)",
      (await page.locator("select[aria-label='Colour']").count()) >= 6 && (await page.locator("select[aria-label='Kind']").count()) === 6
      && (await page.locator("button[title='Move up']").count()) >= 6 && (await page.locator("button[title='Remove stage']").count()) === 6);
    ok("B3 the help says a move never changes a status, and where new designs land",
      /Moving a card between stages never changes its\s+status/.test(modal) && /New designs land in this pipeline, in its first open stage/.test(modal));
    // Rename a stage: the save carries the name and no statusId.
    const first = page.locator("input[aria-label='Stage name']").first();
    await first.fill("New Incoming Leads");
    await first.blur();
    await page.waitForTimeout(600);
    const save = sent.find((b) => b.action === "crm_stage_save");
    ok("C1 renaming a stage saves the name with no statusId", !!save && save.name === "New Incoming Leads" && !("statusId" in save), JSON.stringify(save));
    ok("B4 the pipeline new designs land in offers no Remove pipeline", (await page.locator("button", { hasText: "Remove pipeline" }).count()) === 0);
    await page.locator("button", { hasText: "Done" }).first().click();
    await page.waitForTimeout(500);
    await page.locator("button", { hasText: "Edit stages" }).nth(1).click();
    await page.waitForTimeout(700);
    ok("B5 another pipeline still can be removed", (await page.locator("button", { hasText: "Remove pipeline" }).count()) === 1);
  }
  ok("C2 nothing sent crm_deal_set_status", !sent.some((b) => b.action === "crm_deal_set_status"), JSON.stringify(sent.map((b) => b.action)));
  ok("Z no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await browser.close();
}

console.log(`\nshots: ${shots}`);
const bad = failed();
if (bad.length) { console.log(`\ncrmPipelineSettings: ${bad.length} FAILED`); process.exit(1); }
console.log("all checks held");
