// A PHONE-ONLY account (migration 384) driven for real on the COMPILED portal, against a normal
// builder as the control. Carolyn 2026-11-10: "So it'll say customer hub, but all they have access to
// is contacts."
//
//   node tests/harness/phoneOnly.mjs           (exit 0 = every check held)
//
// What a phone-only owner is offered: Customer Hub (the contact list only, no pipeline tab, no Design
// list) and Calls in the rail, nothing else; a typed address to any other page lands on the contact
// list; Settings holds Company (Business Details, Team), Billing, Customer Hub (Phone, SMS - A2P) and
// My Profile; a contact's record shows the person and their calls with Note and Text usable and no
// deals, meetings or invoice. And EVERY portal-settings action the portal calls on the way is one the
// server allows a phone-only account — read from the real _shared/accountShape.ts through deno, so a
// screen that starts calling a refused action fails here, not on a customer's portal.
//
// Supabase is stubbed at the network layer (no login, nothing leaves the machine), the shape
// smartbuildTeam.mjs uses.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, reporter, BASE, REF, serveAppRoutes } from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORTAL_HTML = readFileSync(join(ROOT, "portal.html"), "utf8");
const ALLOWED = new Set(JSON.parse(execFileSync("deno", ["eval", "--quiet",
  'import { PHONE_ONLY_PORTAL_SETTINGS } from "./supabase/functions/_shared/accountShape.ts"; console.log(JSON.stringify([...PHONE_ONLY_PORTAL_SETTINGS]));'],
{ cwd: ROOT, encoding: "utf8" })));
const META = JSON.parse(execFileSync("deno", ["eval", "--quiet",
  'import { accessMetadata } from "./supabase/functions/_shared/access.ts"; console.log(JSON.stringify(accessMetadata()));'],
{ cwd: ROOT, encoding: "utf8" }));

const CLIENT = "harness-builder";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000001", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const OWNER = Object.fromEntries(META.areas.map((a) => [a.key, "edit"]));
const CONTACT = {
  id: "11111111-2222-4333-8444-555555555555", client_id: CLIENT, name: "Pat Caller", company: null,
  phone: "+15555550142", email: "pat@example.test", labels: [], first_seen_at: "2026-11-10T15:00:00Z",
  merged_into: null, owner_user_id: null, source: "call",
};
const FEED = [{ id: "pc:1", type: "call", at: "2026-11-10T16:00:00Z", title: "Call from +15555550142", body: "Talked 2m 05s · by Olive Owner", icon: "call" }];

// Every page a phone-only account must NOT be offered, by its rail label.
const BARRED_RAIL = ["Shed Designer", "Advanced", "Conversations", "Inventory", "Orders", "Build Schedule",
  "Delivery Schedule", "Repairs", "Commissions", "Jack", "Rent to Own", "Reports", "Project Management", "Self Serve Displays"];
const BARRED_PATHS = ["/designer", "/conversations", "/inventory", "/orders", "/build-schedule", "/delivery-schedule",
  "/repairs", "/commissions", "/reports", "/projects", "/quickbooks"];

const { ok, failed } = reporter();
const { browser, ctx: unused } = await launch({ width: 1400, height: 1000 });
await unused.close();

const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200, headers = {}) =>
  route.fulfill({ status, contentType: "application/json", headers: { ...H, ...headers }, body: JSON.stringify(body) });

async function open(phoneOnly) {
  const pageErrors = [];
  const calls = [];
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, serviceWorkers: "block" });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
  }, [REF, SESSION]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    const fn = /\/functions\/v1\/([a-z0-9-]+)/.exec(url);
    if (fn && !/[?&]warm=1/.test(url)) calls.push({ fn: fn[1], action: body.action || null });
    const rpc = /\/rest\/v1\/rpc\/([a-z_]+)/.exec(url);
    if (rpc) return json(route, rpc[1] === "log_error" ? null : false);
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: "owner" }]);
    if (url.includes("/rest/v1/crm_contacts")) return json(route, [CONTACT], 200, { "content-range": "0-0/1" });
    if (url.includes("/rest/v1/")) return json(route, [], 200, { "content-range": "*/0" });
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) {
      // A phone-only account has NO subscription: portal-billing lets it past the gate on the shape
      // (reason phone_only) and sends crm false. The control is a builder paying for the Customer Hub.
      return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], wallet: null,
        entitlement: phoneOnly
          ? { granted: [], paid: [], features: { crm: false }, state: "active", locked: false, reason: "phone_only", shedsOn: false, phoneOnly: true }
          : { granted: [], paid: ["crm"], features: { crm: true }, state: "active", locked: false, reason: "active", shedsOn: true, phoneOnly: false } });
    }
    if (url.includes("/portal-setup")) return json(route, { ok: true, items: [], progress: { done: 0, total: 0 } });
    if (url.includes("/portal-settings")) {
      if (body.action === "status") return json(route, { ok: true, clientId: CLIENT, role: "owner", access: OWNER, prefs: null, configured: false, branding: {}, phoneStatus: "on" });
      if (body.action === "get_profile") return json(route, { ok: true, fullName: "Olive Owner", phone: "+15555550100", needsDetails: false });
      if (body.action === "contact_activity") return json(route, { ok: true, designs: [], versions: [], estimates: {} });
      if (body.action === "crm_record") {
        return json(route, {
          ok: true, kind: body.kind, clientId: CLIENT, contact: { ...CONTACT, phone_digits: "15555550142", sms_opt_out_at: null },
          designs: [], orders: [], feed: FEED, focus: [], team: [], people: [], followers: [],
          sms: { ready: true, from: "+15555550100", optedOut: false, consented: true },
          build: [], stages: [], delivery: [], repairs: [], isDesign: false,
          pipeline: { pipelines: [], deals: [], statuses: [] },
        });
      }
      if (body.action === "phone_calls_report") return json(route, { ok: true, calls: [], totals: {} });
      return json(route, { ok: true });
    }
    return json(route, { ok: true });
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  await serveAppRoutes(page, PORTAL_HTML);
  return { ctx, page, pageErrors, calls };
}

const booted = (page) => page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
// The rail's labels, workspace and settings sets apart (both are in the markup; CSS picks one).
const rail = (page) => page.evaluate(() => ({
  ws: [...document.querySelectorAll(".ss-ws-nav .ss-nav a, .ss-ws-nav .ss-nav button")].map((a) => a.textContent.replace(/\s+/g, " ").trim()).filter(Boolean),
  all: (document.querySelector(".ss-side") || document.body).innerText.split("\n").map((l) => l.trim()).filter(Boolean),
}));
const hubTabs = (page) => page.evaluate(() => {
  const hub = document.querySelector("[data-ss-contacts-hub]");
  return hub ? [...hub.querySelectorAll("a, button")].map((x) => x.textContent.replace(/\s+/g, " ").trim()).filter(Boolean) : null;
});
const hubView = (page) => page.evaluate(() => {
  const v = document.querySelector("[data-ss-hub-view]");
  return v ? v.getAttribute("data-ss-hub-view") : null;
});
const settle = async (page, path) => {
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  await booted(page);
  await page.waitForTimeout(1500);
  return page.evaluate(() => location.pathname);
};

try {
  // ── A: the phone-only owner ──────────────────────────────────────────────────────────────
  const A = await open(true);
  const p = A.page;
  const landed = await settle(p, "/");
  ok("A: a bare address lands on the contact list", /^\/contacts/.test(landed), landed);
  await p.waitForFunction(() => !!document.querySelector('[data-ss-hub-view="people"]'), null, { timeout: 20000 }).catch(() => {});
  ok("A: the hub opens the contact list (not the CRM padlock, not loading)", (await hubView(p)) === "people", String(await hubView(p)));
  const tabs = await hubTabs(p);
  ok("A: the hub offers Contacts and no Pipeline or Design list", !!tabs && tabs.includes("Contacts") && !tabs.some((t) => /Pipeline|Design list/.test(t)), JSON.stringify(tabs));
  ok("A: Pat Caller is on the list", (await p.evaluate(() => document.body.innerText)).includes("Pat Caller"));
  const r = await rail(p);
  ok("A: the rail says Customer Hub", r.all.includes("Customer Hub"), r.all.join(" | "));
  ok("A: the rail offers Calls", r.all.includes("Calls"), r.all.join(" | "));
  const leaked = BARRED_RAIL.filter((l) => r.all.includes(l));
  ok("A: the rail offers nothing else", leaked.length === 0, leaked.join(", "));

  for (const path of BARRED_PATHS) {
    const at = await settle(p, path);
    ok(`A: a typed ${path} lands on the contact list`, /^\/contacts/.test(at), at);
  }

  const calls = await settle(p, "/calls");
  ok("A: /calls stays put", calls === "/calls", calls);

  await settle(p, "/settings/company");
  const sr = await rail(p);
  const wantSettings = ["Company", "Billing", "Customer Hub", "My Profile"];
  const barredSettings = ["Sheds", "Options", "Colors", "Designer", "Online Inventory", "GHL Connection", "QuickBooks"];
  ok("A: Settings offers Company, Billing, Customer Hub and My Profile", wantSettings.every((l) => sr.all.includes(l)), sr.all.join(" | "));
  const sLeak = barredSettings.filter((l) => sr.all.includes(l));
  ok("A: …and none of the shed or integration pages", sLeak.length === 0, sLeak.join(", "));
  const companyTabs = await p.evaluate(() => document.body.innerText);
  ok("A: Company has no Branding, Locations, Sales Tax or Commissions tab",
    !/\bBranding\b|\bLocations\b|Sales Tax|\bCommissions\b/.test(companyTabs.split("Business Details")[1] || ""),
    (companyTabs.split("Business Details")[1] || "").slice(0, 200).replace(/\s+/g, " "));

  // What a Settings address renders: the page's own text (the rail is outside .ss-main).
  const main = () => p.evaluate(() => {
    const m = document.querySelector(".ss-main") || document.querySelector("main") || document.body;
    return m.innerText.replace(/\s+/g, " ").trim();
  });
  for (const [path, mark] of [["/settings/sheds", /Building styles|Shed styles/], ["/settings/branding", /Brand colou?rs|Logo and colou?rs|Branding/],
    ["/settings/quickbooks", /QuickBooks Online/], ["/settings/forms", /Lead forms|New form/], ["/settings/automations", /Rules that run|New rule/]]) {
    const at = await settle(p, path);
    const txt = await main();
    ok(`A: ${path} does not render its page`, !mark.test(txt), `${at} :: ${txt.slice(0, 140)}`);
  }
  const hubAt = await settle(p, "/settings/pipelines");
  const hubText = await main();
  ok("A: Settings > Customer Hub renders the phone tabs, not Pipelines", /SMS - A2P/.test(hubText) && !/Each pipeline's stages/.test(hubText), `${hubAt} :: ${hubText.slice(0, 160)}`);
  const hubTabRow = hubText.split("SMS - A2P")[0];
  ok("A: …and lists no Pipelines, Fields, Meetings, Automations, Email or Forms tab",
    !/\b(Pipelines|Fields|Meetings|Automations|Email Settings|Email Templates|Forms|Customer login)\b/.test(hubTabRow.slice(-200)),
    hubTabRow.slice(-200));

  // The record.
  await settle(p, `/contacts/c-${CONTACT.id}`);
  await p.waitForFunction(() => document.body.innerText.includes("Pat Caller") && !!document.querySelector("[data-ss-crm-section]"), null, { timeout: 20000 }).catch(() => {});
  const rec = await p.evaluate(() => ({
    sections: [...document.querySelectorAll("[data-ss-crm-section]")].map((s) => s.getAttribute("data-ss-crm-section")),
    buttons: [...document.querySelectorAll("button")].map((b) => ({ t: b.textContent.replace(/\s+/g, " ").trim(), d: b.disabled })),
    text: document.body.innerText,
  }));
  ok("A: the record opens, not the Customer Hub upsell", rec.text.includes("Pat Caller") && !/Add the Customer Hub/.test(rec.text));
  ok("A: its cards are the person only (no Deals, Orders, schedules)", rec.sections.length > 0 && rec.sections.every((k) => ["summary", "details", "overview"].includes(k)), rec.sections.join(","));
  const btn = (t) => rec.buttons.find((b) => b.t === t);
  ok("A: Write Note is usable with no deal picked", !!btn("Write Note") && !btn("Write Note").d, JSON.stringify(btn("Write Note")));
  ok("A: Send SMS is usable with no deal picked", !!btn("Send SMS") && !btn("Send SMS").d, JSON.stringify(btn("Send SMS")));
  ok("A: no Schedule Meeting or Invoice tab", !btn("Schedule Meeting") && !btn("Invoice"));
  ok("A: the call is in the record's history", rec.text.includes("Call from +15555550142"));

  const fns = [...new Set(A.calls.map((c) => c.fn))];
  ok("A: the portal never asks portal-meetings, portal-schedule, portal-payments or portal-commissions",
    !fns.some((f) => ["portal-meetings", "portal-schedule", "portal-payments", "portal-commissions"].includes(f)), fns.join(", "));
  // Jack: only "is Jack on?" (the one jack-agent action a phone-only account may call), never Jack itself.
  const jackAsks = [...new Set(A.calls.filter((c) => c.fn === "jack-agent").map((c) => c.action))];
  ok("A: it asks Jack only whether Jack is on", jackAsks.every((a) => a === "enabled"), jackAsks.join(", "));
  const refused = [...new Set(A.calls.filter((c) => c.fn === "portal-settings" && !ALLOWED.has(c.action || "status")).map((c) => c.action))];
  ok("A: every portal-settings action it called is on the phone-only allow-list", refused.length === 0, refused.join(", "));
  ok("A: no uncaught page errors", A.pageErrors.length === 0, A.pageErrors.join(" | "));
  await A.ctx.close();

  // ── B: the control, a builder with the whole product ─────────────────────────────────────
  const B = await open(false);
  await settle(B.page, "/contacts/people");
  const rb = await rail(B.page);
  ok("B: a normal builder's rail still has the Shed Designer, Conversations and Commissions",
    ["Shed Designer", "Conversations", "Commissions"].every((l) => rb.all.includes(l)), rb.all.join(" | "));
  const inv = await settle(B.page, "/inventory");
  ok("B: …and its /inventory opens", inv === "/inventory", inv);
  ok("B: no uncaught page errors", B.pageErrors.length === 0, B.pageErrors.join(" | "));
  await B.ctx.close();
} finally {
  await browser.close();
}
process.exit(failed().length ? 1 : 0);
