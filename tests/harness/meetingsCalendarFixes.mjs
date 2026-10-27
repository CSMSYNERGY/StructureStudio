// Two Meetings fixes from the 11-02 release review (2026-10-27), driven for real on the COMPILED
// portal.
//
// 1. CALENDAR CHOICES SEND THE HOST. portal-meetings lets only a person below meetings-edit leave
//    hostId out and mean themselves; an owner or admin got "Which person's calendar did you mean?"
//    from Choose calendars, from its Save, and from the "New bookings go on" switch.
// 2. A NEW MEET / TEAMS LINK PER BOOKING NEEDS ITS PROVIDER SWITCHED ON. Picked while it was off,
//    with no room link, every booking of the type was marked failed and the customer was told a
//    link would follow, which nobody could make.
//
//   C1 an owner's Choose calendars lists the calendars, and the request names their host
//   C2 Save sends the host with the choices, and says Saved
//   C3 with Google AND Outlook connected, "New bookings go on: Outlook" sends the host and says so
//   E1 Google Meet is not switched on: "a new link for every booking" is greyed and can't be picked
//   E2 a type already set that way with no room link: a red line says why, and Save is greyed
//   E3 a room link fixes it: the line goes, Save works, and the saved type carries the link
//   E4 Zoom, which is switched on: "a new meeting for every booking" can be picked
//   X  no uncaught page errors
//
// portal-meetings is stubbed with the server's own HOST_SCOPE rule for these two actions, so a
// build that leaves the host out gets the real refusal. Supabase is stubbed at the network layer;
// nothing leaves the machine. Names are made up (public repo).
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root; SS_BASE overrides the address)
//   node tests/harness/meetingsCalendarFixes.mjs   (exit 0 = every check held)
//
// SS_PORTAL_ARTIFACT=<an older portal.app.compiled.js> serves that file instead (before the fix:
// C1 to C3, E1 and E2 fail). Shots land in %TEMP%/ss-harness/meetings-calendar-fixes.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, reporter, BASE, REF, shotsDir, serveAppRoutes } from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORTAL_HTML = readFileSync(join(ROOT, "portal.html"), "utf8");
const ARTIFACT = process.env.SS_PORTAL_ARTIFACT ? readFileSync(process.env.SS_PORTAL_ARTIFACT, "utf8") : null;

const CLIENT = "acme-sheds";
const HOST_ID = "11111111-2222-4333-8444-5555555555c1";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-0000000000c1", aud: "authenticated", role: "authenticated", email: "pat@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const AREAS = ["designer", "designs", "contacts", "inventory", "orders", "change_orders", "change_order_approve", "build_schedule",
  "delivery_schedule", "repairs", "commissions", "reports", "projects", "phone", "meetings", "settings_structures", "settings_options",
  "settings_branding", "settings_crm", "settings_quickbooks", "settings_email", "settings_team", "settings_billing"];
const OWNER = Object.fromEntries(AREAS.map((k) => [k, "edit"]));
const TYPE = {
  id: "22222222-3333-4444-8555-6666666666c1", name: "Video consult", slug: "video-consult", description: "",
  durationMinutes: 30, locationKind: "video", locationDetail: "", bufferBeforeMinutes: 0, bufferAfterMinutes: 0,
  minNoticeHours: 4, maxDaysAhead: 30, slotIntervalMinutes: 30, color: "#3d3672", active: true,
  conferenceProvider: "google_meet", conferenceUrl: "", conferenceNote: "", conferenceMode: "generate",
};
const HOST = {
  id: HOST_ID, userId: USER.id, slug: "pat", publicName: "Pat Example", publicTitle: "Sales", photoUrl: null,
  timeZone: "America/Chicago", weeklyHours: {}, accepting: true, typeIds: [TYPE.id],
  zoom: null, google: "connected", microsoft: "connected", calendarProvider: "google",
};
const NO_HOST = "Which person's calendar did you mean?";

const { ok, failed } = reporter();
const shots = shotsDir("meetings-calendar-fixes");
const pageErrors = [];
const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });
const LOCAL = /^https?:\/\/(127\.0\.0\.1|(?:[a-z0-9-]+\.)*localhost)(:\d+)?\//;

async function scenario(browser, { name, path }) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1100 }, serviceWorkers: "block" });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
  }, [REF, SESSION]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(`${name}: ${e.message}`));
  page.on("dialog", (d) => d.accept());
  const meet = [];
  await page.route((u) => !LOCAL.test(u.href), (route) => route.abort());
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    if (url.includes("/rest/v1/rpc/")) return json(route, url.includes("log_error") ? null : false);
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: "owner", user_id: USER.id }]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) {
      return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: { crm: true }, status: "active" }, wallet: null, clientId: CLIENT });
    }
    if (url.includes("/portal-meetings")) {
      const action = body.action || "overview";
      meet.push(body);
      // HOST_SCOPE, as portal-meetings has it: meetings:'edit' must name the host.
      if ((action === "list_calendars" || action === "save_calendar_prefs") && typeof body.hostId !== "string") {
        return json(route, { error: NO_HOST }, 400);
      }
      if (action === "list_calendars") {
        return json(route, { ok: true, calendars: [
          { id: "pat@example.test", name: "Pat Example", primary: true, canWrite: true },
          { id: "family-cal", name: "Family", primary: false, canWrite: true },
        ] });
      }
      if (action === "overview") {
        return json(route, {
          ok: true, settings: { enabled: true, heading: "Book a time", intro: "", sendConfirmation: true, reminderHours: [24], createContact: true },
          types: [TYPE], myHost: HOST, team: [HOST],
          connections: [
            { provider: "google", status: "connected", calendarId: null, lastSyncedAt: null, accountEmail: "pat@example.test", accountName: null, lastError: null, busyCalendarIds: [], writeCalendarId: null },
            { provider: "microsoft", status: "connected", calendarId: null, lastSyncedAt: null, accountEmail: "pat@example.test", accountName: null, lastError: null, busyCalendarIds: [], writeCalendarId: null },
          ],
          videoReady: { zoom: true, google_meet: false, teams: false }, calendarReady: { google: true, microsoft: true },
          overrides: [], canManageBusiness: true, viewing: false,
        });
      }
      return json(route, { ok: true });
    }
    if (!url.includes("/portal-settings")) return json(route, { ok: true });
    switch (body.action) {
      case "status":
        return json(route, { ok: true, clientId: CLIENT, role: "owner", operatorMode: false, access: OWNER, prefs: null, phoneStatus: "off", configured: false,
          invoiceInGhl: false, ghlInvoicingAllowed: false, businessAddress: {}, branding: { companyName: "Acme Sheds" }, emailReady: true });
      case "get_profile":
        return json(route, { fullName: "Pat Example", phone: "5550100100", role: "owner", email: USER.email, needsDetails: false, emailSignature: "" });
      default: return json(route, { ok: true });
    }
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  await serveAppRoutes(page, PORTAL_HTML);
  if (ARTIFACT) await page.route(/portal\.app\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: ARTIFACT }));
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  await page.waitForTimeout(2500);
  return { ctx, page, meet, text: () => page.locator("body").innerText().catch(() => "") };
}

const of = (calls, action) => calls.filter((c) => c.action === action);
const settle = (page, ms = 600) => page.waitForTimeout(ms);

const { browser, ctx: unused } = await launch({ width: 1400, height: 1100 });
await unused.close();
try {
  // ── C: My Profile → My connections → Calendars, an owner (meetings:edit) ──
  {
    const s = await scenario(browser, { name: "calendars", path: "/settings/myprofile" });
    const choose = s.page.getByRole("button", { name: "Choose calendars", exact: true }).first();
    const shown = ok("C0 My connections shows Choose calendars for the connected Google calendar", (await choose.count()) > 0);
    if (!shown) throw new Error("My connections never showed Choose calendars; refusing to report the rest as passes");
    await choose.click();
    await settle(s.page, 900);
    const lists = of(s.meet, "list_calendars");
    const t1 = await s.text();
    ok("C1 Choose calendars lists them (Family is offered), and the request names the host",
      t1.includes("Family") && lists.length > 0 && lists.every((c) => c.hostId === HOST_ID) && !t1.includes(NO_HOST), JSON.stringify(lists));
    await s.page.getByText("Family", { exact: true }).first().click().catch(() => {});
    // The panel's own Save: "Put new bookings on" and the Save button share the panel as parent
    // (My Profile has other Save buttons, so a page-wide lookup would press the wrong one).
    const pressed = await s.page.evaluate(() => {
      const head = [...document.querySelectorAll("div")].find((d) => d.textContent.trim() === "Put new bookings on" && d.children.length === 0);
      const btn = head && [...head.parentElement.querySelectorAll("button")].find((b) => b.textContent.trim() === "Save");
      if (btn) btn.click();
      return !!btn;
    });
    if (!pressed) ok("C2a the calendar panel has its own Save button", false);
    await settle(s.page, 900);
    const saves = of(s.meet, "save_calendar_prefs").filter((c) => c.provider === "google");
    const t2 = await s.text();
    ok("C2 Save sends the host with the choices, and says Saved",
      saves.length === 1 && saves[0].hostId === HOST_ID && (saves[0].busyCalendarIds || []).includes("family-cal") && /Saved\. Your Google choices apply/.test(t2) && !t2.includes(NO_HOST),
      JSON.stringify(saves));
    await s.page.screenshot({ path: join(shots, "C-calendar-choices.png"), fullPage: true });
    const outlook = s.page.locator('input[name="ss-bookings-to"]').nth(1);
    if (await outlook.count()) { await outlook.check({ force: true }).catch(() => {}); await settle(s.page, 900); }
    const switches = of(s.meet, "save_calendar_prefs").filter((c) => c.bookingsTo);
    const t3 = await s.text();
    ok("C3 \"New bookings go on: Outlook\" sends the host, and says so",
      switches.length === 1 && switches[0].hostId === HOST_ID && switches[0].bookingsTo === "microsoft" && t3.includes("New bookings now go on your Outlook calendar") && !t3.includes(NO_HOST),
      JSON.stringify(switches));
    await s.ctx.close();
  }

  // ── E: Customer Hub → Meetings, the meeting type editor ──
  {
    const s = await scenario(browser, { name: "types", path: "/settings/meetings" });
    const row = s.page.locator("div").filter({ hasText: "Video consult" }).filter({ has: s.page.getByRole("button", { name: "Edit", exact: true }) }).last();
    const edit = row.getByRole("button", { name: "Edit", exact: true });
    const opened = ok("E0 the Video consult type has an Edit button", (await edit.count()) > 0);
    if (!opened) throw new Error("Customer Hub → Meetings never listed the type; refusing to report the rest as passes");
    await edit.click();
    await settle(s.page, 700);
    const genLabel = s.page.locator("label", { hasText: "for every booking" }).first();
    const genRadio = genLabel.locator('input[type="radio"]');
    ok("E1 Google Meet is not switched on: \"a new link for every booking\" is greyed and can't be picked",
      (await genRadio.count()) === 1 && await genRadio.isDisabled() && (await genLabel.innerText()).includes("not available until Google is switched on"),
      await genLabel.innerText().catch(() => "?"));
    const needs = s.page.locator("[data-ss-conf-needs-room]");
    const save = s.page.getByRole("button", { name: "Save meeting type", exact: true });
    ok("E2 set that way with no room link: a red line says why, and Save is greyed",
      (await needs.count()) === 1 && await save.isDisabled());
    await s.page.screenshot({ path: join(shots, "E-needs-room-link.png"), fullPage: true });
    await s.page.locator('input[placeholder="https://zoom.us/j/1234567890"]').fill("https://meet.google.com/abc-defg-hij");
    await settle(s.page, 300);
    const freed = (await needs.count()) === 0 && await save.isEnabled();
    if (freed) { await save.click(); await settle(s.page, 900); }
    const types = of(s.meet, "save_type");
    ok("E3 a room link fixes it: the line goes, Save works, and the saved type carries the link",
      freed && types.length === 1 && types[0].conferenceUrl === "https://meet.google.com/abc-defg-hij", JSON.stringify(types.map((t) => t.conferenceUrl)));
    // Zoom is switched on: its "new meeting" option is offered.
    await row.getByRole("button", { name: "Edit", exact: true }).click().catch(() => {});
    await settle(s.page, 700);
    const provider = s.page.locator("select").filter({ has: s.page.locator('option[value="google_meet"]') }).first();
    await provider.selectOption("zoom").catch(() => {});
    await settle(s.page, 400);
    const zLabel = s.page.locator("label", { hasText: "for every booking" }).first();
    ok("E4 Zoom is switched on: \"a new meeting for every booking\" can be picked",
      (await zLabel.locator('input[type="radio"]').count()) === 1 && await zLabel.locator('input[type="radio"]').isEnabled(),
      await zLabel.innerText().catch(() => "?"));
    await s.ctx.close();
  }
  ok("X no uncaught page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
} catch (e) {
  ok("harness ran to the end", false, String(e && e.message || e));
} finally {
  await browser.close();
}
console.log(`\nshots: ${shots}`);
process.exitCode = failed().length ? 1 : 0;
