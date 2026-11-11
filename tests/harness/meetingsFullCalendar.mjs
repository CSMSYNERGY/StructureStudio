// The Meeting scheduler tab's full calendar (Carolyn 2026-11-10: "The Meeting times we can see
// inside Customer Hub must be expanded to be able to see more days and more times... Really we
// need to be able to see full calendar"), driven for real on the COMPILED portal.
//
// The tab used to show the first twelve open times. It now draws the person's week or month:
//
//   F1 the tab draws a Sunday-to-Saturday week, and asks for that week with withCalendar
//   F2 "Previous week" is greyed on this week; "Next week" moves on and asks for the next seven days
//   F3 every open time shows: all sixteen on Monday, far more than the old twelve across the week
//   F4 a booked meeting shows with its customer and type; a cancelled one does not
//   F5 a Google busy block shows as Busy with its times; an all-day one fills the day
//   F6 the weekend, with no hours, says Day off
//   F7 picking a time fills the Book button with that day and time
//   F8 Month shows whole weeks with each day's open count; a day opens its week
//   F9 Full screen covers the window, and Escape closes it
//   F10 Book sends the picked instant, and the calendar reads the diary again afterwards
//   F11 at phone width the page itself does not scroll sideways; the calendar scrolls inside itself
//   X  no uncaught page errors
//
// portal-meetings and portal-settings are stubbed; Supabase is stubbed at the network layer and
// nothing leaves the machine. Names are made up (public repo).
//
//   node tests/harness/meetingsFullCalendar.mjs   (exit 0 = every check held)
//
// SS_PORTAL_ARTIFACT=<an older portal.app.compiled.js> serves that file instead (before the
// calendar, F1 fails and the rest are not reported as passes).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { launch, reporter, BASE, REF, shotsDir, serveAppRoutes } from "./lib.mjs";

const CLIENT = "harness-full-calendar";
const CONTACT_ID = "7d1f3a52-6c0b-4c8e-9a51-2f4e8b7c1d91";
const TZ = "America/Chicago";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-0000000000d1", aud: "authenticated", role: "authenticated", email: "pat@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const AREAS = ["designer", "designs", "contacts", "inventory", "orders", "change_orders", "change_order_approve", "build_schedule",
  "delivery_schedule", "repairs", "commissions", "reports", "projects", "phone", "meetings", "settings_structures", "settings_options",
  "settings_branding", "settings_crm", "settings_quickbooks", "settings_email", "settings_team", "settings_billing"];
const OWNER = Object.fromEntries(AREAS.map((k) => [k, "edit"]));
const CONTACT = { id: CONTACT_ID, name: "Riley Sample", phone: "+15125550178", email: "riley@example.test", phone_digits: "15125550178", owner_user_id: null, sms_opt_out_at: null, first_seen_at: "2026-06-01T12:00:00Z" };
const TYPE = {
  id: "22222222-3333-4444-8555-6666666666d1", name: "Site visit", slug: "site-visit", description: "",
  durationMinutes: 30, locationKind: "in_person", locationDetail: "", bufferBeforeMinutes: 0, bufferAfterMinutes: 0,
  minNoticeHours: 4, maxDaysAhead: 60, slotIntervalMinutes: 30, color: "#E67C73", active: true,
  conferenceProvider: null, conferenceUrl: "", conferenceNote: "", conferenceMode: "room",
};
const NINE_TO_FIVE = [["09:00", "17:00"]];
const HOST = {
  id: "11111111-2222-4333-8444-5555555555d1", userId: USER.id, slug: "pat", publicName: "Pat Example", publicTitle: "Sales", photoUrl: null,
  timeZone: TZ, weeklyHours: { mon: NINE_TO_FIVE, tue: NINE_TO_FIVE, wed: NINE_TO_FIVE, thu: NINE_TO_FIVE, fri: NINE_TO_FIVE },
  accepting: true, typeIds: [TYPE.id], zoom: null, google: "connected", microsoft: null, calendarProvider: "google",
};

// ── Days and instants in the host's zone, the way the server speaks them ──────────────────
const dayAdd = (day, n) => { const [y, m, d] = day.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const dow = (day) => new Date(day + "T00:00:00Z").getUTCDay();
const zonedParts = (ms) => {
  const t = {};
  for (const x of new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms))) t[x.type] = x.value;
  return t;
};
const wall = (day, h, mi) => {
  const [y, m, d] = day.split("-").map(Number);
  const want = Date.UTC(y, m - 1, d, h, mi);
  const t = zonedParts(want);
  const seen = Date.UTC(+t.year, +t.month - 1, +t.day, (+t.hour) % 24, +t.minute);
  return new Date(want + (want - seen)).toISOString();
};
const tp = zonedParts(Date.now());
const TODAY = `${tp.year}-${tp.month}-${tp.day}`;
const NEXT_SUN = dayAdd(TODAY, 7 - dow(TODAY));
const MON = dayAdd(NEXT_SUN, 1), TUE = dayAdd(NEXT_SUN, 2), WED = dayAdd(NEXT_SUN, 3), THU = dayAdd(NEXT_SUN, 4);

const MEETING_ID = "99999999-0000-4000-8000-0000000000d1";
const MEETINGS = [
  { id: MEETING_ID, hostId: HOST.id, typeId: TYPE.id, typeName: "Site visit", color: "#E67C73", contactId: null, status: "booked",
    startsAt: wall(TUE, 10, 0), endsAt: wall(TUE, 10, 30), customerName: "Jordan Sample", timeZone: TZ },
  { id: "99999999-0000-4000-8000-0000000000d2", hostId: HOST.id, typeId: TYPE.id, typeName: "Site visit", color: "#E67C73", contactId: null, status: "cancelled",
    startsAt: wall(TUE, 15, 0), endsAt: wall(TUE, 15, 30), customerName: "Casey Cancelled", timeZone: TZ },
];
const BUSY = [
  { startsAt: wall(WED, 13, 0), endsAt: wall(WED, 14, 30) },
  { startsAt: wall(THU, 0, 0), endsAt: wall(dayAdd(THU, 1), 0, 0) },
];
// What the availability engine would offer: 9:00 to 16:30 every 30 minutes on a weekday, later
// than four hours from now, and clear of the meeting and the busy blocks above.
function daysFor(fromDate, toDate) {
  const out = [];
  const earliest = Date.now() + 4 * 3600000;
  const blocked = [...MEETINGS.filter((m) => m.status === "booked"), ...BUSY].map((b) => [Date.parse(b.startsAt), Date.parse(b.endsAt)]);
  for (let d = fromDate; d <= toDate; d = dayAdd(d, 1)) {
    const slots = [];
    if (dow(d) >= 1 && dow(d) <= 5) {
      for (let mins = 9 * 60; mins + 30 <= 17 * 60; mins += 30) {
        const s = wall(d, Math.floor(mins / 60), mins % 60);
        const sMs = Date.parse(s), eMs = sMs + 30 * 60000;
        if (sMs < earliest || blocked.some(([bs, be]) => bs < eMs && be > sMs)) continue;
        slots.push({ startsAt: s, endsAt: new Date(eMs).toISOString() });
      }
    }
    out.push({ date: d, slots });
  }
  return out;
}

const { ok, failed } = reporter();
const shots = shotsDir("meetings-full-calendar");
const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });
const LOCAL = /^https?:\/\/(127\.0\.0\.1|(?:[a-z0-9-]+\.)*localhost)(:\d+)?\//;

async function scenario(browser, { width = 1440, height = 1000 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, serviceWorkers: "block" });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
  }, [REF, SESSION]);
  const page = await ctx.newPage();
  const pageErrors = [];
  const meet = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
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
      if (action === "overview") {
        return json(route, {
          ok: true, settings: { enabled: true, heading: "Book a time", intro: "", sendConfirmation: true, reminderHours: [24], createContact: true },
          types: [TYPE], myHost: HOST, team: [HOST], connections: [], videoReady: { zoom: false, google_meet: false, teams: false },
          calendarReady: { google: true, microsoft: false }, overrides: [], canManageBusiness: true, viewing: false,
        });
      }
      if (action === "availability") {
        return json(route, { ok: true, timeZone: TZ, accepting: true, days: daysFor(body.fromDate, body.toDate), ...(body.withCalendar ? { busy: BUSY } : {}) });
      }
      if (action === "list") {
        return json(route, { ok: true, meetings: MEETINGS.filter((m) => m.startsAt >= body.from && m.startsAt <= body.to) });
      }
      if (action === "contact_meetings") return json(route, { ok: true, meetings: [] });
      if (action === "book") return json(route, { ok: true, meetingId: "99999999-0000-4000-8000-0000000000d9" });
      return json(route, { ok: true });
    }
    if (!url.includes("/portal-settings")) return json(route, { ok: true });
    switch (body.action) {
      case "status":
        return json(route, { ok: true, clientId: CLIENT, role: "owner", operatorMode: false, access: OWNER, prefs: null, phoneStatus: "off", configured: false,
          invoiceInGhl: false, ghlInvoicingAllowed: false, businessAddress: {}, branding: { companyName: "Acme Sheds" }, emailReady: true });
      case "get_profile":
        return json(route, { fullName: "Pat Example", phone: "5550100100", role: "owner", email: USER.email, needsDetails: false, emailSignature: "" });
      case "crm_record":
        return json(route, {
          ok: true, kind: body.kind, contact: CONTACT, designs: [], orders: [], feed: [], focus: [], team: [], people: [], followers: [],
          sms: { ready: false, from: null, optedOut: false, consented: false }, build: [], stages: [], delivery: [], repairs: [],
        });
      case "crm_contacts": return json(route, { ok: true, contacts: [CONTACT] });
      default: return json(route, { ok: true });
    }
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  if (process.env.SS_PORTAL_ARTIFACT) {
    const src = readFileSync(process.env.SS_PORTAL_ARTIFACT, "utf8");
    await page.route(/portal\.app\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: src }));
  }
  await serveAppRoutes(page);
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 90000 });
  await page.waitForTimeout(600);
  await page.evaluate((p) => { history.pushState({}, "", p); window.dispatchEvent(new PopStateEvent("popstate")); }, `/contacts/c-${CONTACT_ID}`);
  await page.waitForFunction(() => document.body.innerText.includes("Schedule Meeting"), null, { timeout: 30000 }).catch(() => {});
  await page.getByRole("button", { name: "Schedule Meeting", exact: true }).first().click().catch(() => {});
  await page.waitForSelector("[data-ss-cal-week], [data-ss-cal-empty]", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500);
  return { ctx, page, pageErrors, meet };
}

const of = (calls, action) => calls.filter((c) => c.action === action);
const settle = (page, ms = 700) => page.waitForTimeout(ms);

const { browser } = await launch({ width: 1440, height: 1000 });
try {
  {
    const { ctx, page, pageErrors, meet } = await scenario(browser);
    const drawn = ok("F1 the tab draws a Sunday-to-Saturday week", (await page.locator("[data-ss-cal-head]").count()) === 7,
      await page.evaluate(() => document.body.innerText.slice(0, 400)));
    if (!drawn) throw new Error("the Meeting scheduler drew no calendar; refusing to report the rest as passes");
    const firstAsk = of(meet, "availability")[0] || {};
    const heads = await page.evaluate(() => [...document.querySelectorAll("[data-ss-cal-head]")].map((h) => h.getAttribute("data-ss-cal-head")));
    ok("F1b it asked for that week with withCalendar, and read the booked meetings for the same person",
      firstAsk.withCalendar === true && firstAsk.fromDate === heads[0] && firstAsk.toDate === heads[6] && dow(heads[0]) === 0
        && of(meet, "list").some((c) => c.hostId === HOST.id), JSON.stringify({ firstAsk, heads }));

    const prev = page.getByRole("button", { name: "Previous week", exact: true });
    ok("F2 Previous week is greyed on this week", await prev.isDisabled());
    await page.getByRole("button", { name: "Next week", exact: true }).click();
    await page.waitForFunction((d) => !!document.querySelector(`[data-ss-cal-head="${d}"]`), NEXT_SUN, { timeout: 10000 }).catch(() => {});
    await settle(page);
    const ask2 = of(meet, "availability").at(-1) || {};
    ok("F2b Next week moves on and asks for the next seven days", ask2.fromDate === NEXT_SUN && ask2.toDate === dayAdd(NEXT_SUN, 6), JSON.stringify(ask2));
    await page.screenshot({ path: join(shots, "F-week.png"), fullPage: true });

    const perDay = await page.evaluate(() => {
      const heads = [...document.querySelectorAll("[data-ss-cal-head]")].map((h) => h.getAttribute("data-ss-cal-head"));
      const count = {};
      for (const b of document.querySelectorAll("[data-ss-cal-slot]")) {
        // A slot's column is its cell's place in the row: 8 cells a row, the time label first.
        const cell = b.parentElement;
        const idx = [...cell.parentElement.children].indexOf(cell) % 8;
        const d = heads[idx - 1];
        count[d] = (count[d] || 0) + 1;
      }
      return count;
    });
    const total = Object.values(perDay).reduce((a, n) => a + n, 0);
    ok("F3 every open time shows: all sixteen on Monday, and far more than twelve across the week",
      perDay[MON] === 16 && total > 40, JSON.stringify(perDay));

    const meetingText = await page.locator(`[data-ss-cal-meeting="${MEETING_ID}"]`).innerText().catch(() => "");
    const body = await page.evaluate(() => document.body.innerText);
    ok("F4 the booked meeting shows with its customer and type; the cancelled one does not",
      meetingText.includes("Jordan Sample") && meetingText.includes("Site visit") && /10:00–10:30\s?AM/.test(meetingText) && !body.includes("Casey Cancelled"),
      meetingText);

    const busy = await page.locator("[data-ss-cal-busy]").allInnerTexts();
    const thuHead = await page.locator(`[data-ss-cal-head="${THU}"]`).innerText().catch(() => "");
    ok("F5 a Google busy block shows as Busy with its times; the all-day one fills Thursday",
      busy.some((t) => t.includes("Busy") && /1:00–2:30\s?PM/.test(t)) && busy.length >= 2 && thuHead.includes("Busy all day"),
      JSON.stringify({ busy, thuHead }));

    const sunHead = await page.locator(`[data-ss-cal-head="${NEXT_SUN}"]`).innerText().catch(() => "");
    ok("F6 the weekend, with no hours, says Day off", sunHead.includes("Day off"), sunHead);

    const pickAt = wall(TUE, 14, 0);
    await page.locator(`[data-ss-cal-slot="${pickAt}"]`).click();
    await settle(page, 300);
    const bookBtn = page.getByRole("button", { name: /^Book / }).first();
    const bookText = await bookBtn.innerText().catch(() => "");
    ok("F7 picking a time fills the Book button with that day and time",
      /2:00\s?PM/.test(bookText) && (await page.locator(`[data-ss-cal-slot="${pickAt}"]`).getAttribute("aria-pressed")) === "true", bookText);

    await page.getByRole("button", { name: "Month", exact: true }).click();
    await page.waitForSelector("[data-ss-cal-month]", { timeout: 10000 }).catch(() => {});
    await settle(page);
    const cells = await page.locator("[data-ss-cal-day]").count();
    const monCell = await page.locator(`[data-ss-cal-day="${MON}"]`).innerText().catch(() => "");
    const monthAsk = of(meet, "availability").at(-1) || {};
    await page.screenshot({ path: join(shots, "F-month.png"), fullPage: true });
    await page.locator(`[data-ss-cal-day="${WED}"]`).click();
    await settle(page);
    ok("F8 Month shows whole weeks with each day's open count; a day opens its week",
      cells % 7 === 0 && cells >= 28 && monCell.includes("16 open") && monthAsk.withCalendar === true
        && (await page.locator(`[data-ss-cal-head="${WED}"]`).count()) === 1,
      JSON.stringify({ cells, monCell, monthAsk }));

    await page.getByRole("button", { name: "Full screen", exact: true }).click();
    await settle(page, 300);
    const dlg = await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"][aria-modal="true"]');
      if (!d) return null;
      const r = d.getBoundingClientRect();
      return { w: r.width, h: r.height, vw: innerWidth, vh: innerHeight, pos: getComputedStyle(d).position, cal: !!d.querySelector("[data-ss-meeting-calendar]") };
    });
    await page.screenshot({ path: join(shots, "F-full-screen.png") });
    await page.keyboard.press("Escape");
    await settle(page, 300);
    const closed = (await page.locator('[role="dialog"][aria-modal="true"] [data-ss-meeting-calendar]').count()) === 0;
    ok("F9 Full screen covers the window, and Escape closes it",
      !!dlg && dlg.pos === "fixed" && dlg.cal && dlg.w >= dlg.vw - 1 && dlg.h >= dlg.vh - 1 && closed, JSON.stringify({ dlg, closed }));

    const asksBefore = of(meet, "availability").length;
    await page.getByRole("button", { name: /^Book / }).first().click();
    await settle(page, 900);
    const book = of(meet, "book").at(-1) || {};
    ok("F10 Book sends the picked instant, and the calendar reads the diary again afterwards",
      book.startsAt === pickAt && book.hostId === HOST.id && book.typeId === TYPE.id && of(meet, "availability").length > asksBefore,
      JSON.stringify({ book, asksBefore, after: of(meet, "availability").length }));

    ok("X no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
    await ctx.close();
  }

  {
    const { ctx, page, pageErrors } = await scenario(browser, { width: 390, height: 844 });
    const m = await page.evaluate(() => {
      const main = document.querySelector("main") || document.body;
      const week = document.querySelector("[data-ss-cal-week]");
      return { main: [main.scrollWidth, main.clientWidth], doc: [document.documentElement.scrollWidth, innerWidth],
        week: week ? [week.scrollWidth, week.clientWidth] : null,
        // The widest things past the right edge, named, so a failure says what to fix.
        wide: [...document.querySelectorAll("main *")].filter((e) => e.getBoundingClientRect().right > innerWidth + 1 && !e.closest("[data-ss-cal-week]"))
          .slice(0, 6).map((e) => `${e.tagName.toLowerCase()}${e.getAttribute("data-ss-meeting-calendar") !== null ? "[cal]" : ""} ${Math.round(e.getBoundingClientRect().right)} ${(e.innerText || "").slice(0, 40).replace(/\s+/g, " ")}`) };
    });
    await page.screenshot({ path: join(shots, "F-phone.png"), fullPage: true });
    ok("F11 at phone width the page does not scroll sideways; the calendar scrolls inside itself",
      !!m.week && m.main[0] <= m.main[1] + 1 && m.doc[0] <= m.doc[1] + 1 && m.week[0] > m.week[1], JSON.stringify(m));
    ok("X2 no uncaught page errors at phone width", pageErrors.length === 0, pageErrors.join(" | "));
    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log(`\nshots: ${shots}`);
const bad = failed();
if (bad.length) { console.log(`\nmeetingsFullCalendar: ${bad.length} FAILED`); process.exit(1); }
console.log("all checks held");
