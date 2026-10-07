// The "Show the building from all four corners on page 2 of my quotes" switch (Settings → Company), driven
// for real on the COMPILED portal (migration 276). Carolyn, 2026-08-20: the four-sided 3D page is
// "optional for them"; the Monday card asks for a per-builder toggle, off by default.
//
//   A. a builder with 3D: the switch is under "Quotes are good for", off, in plain words
//   B. ticking it and pressing Save Settings sends quoteCornerViews: true (a real boolean) with the
//      rest of the form, the screen says "Settings saved." and the re-read shows it ticked; unticking
//      sends false
//   C. a save that does not touch it sends no quoteCornerViews at all, so a save from another tab
//      or section never writes back a value nobody on this screen chose
//   D. a builder WITHOUT 3D sees no switch (no 3D, no 3D page), and their saves never name it
//   E. a server older than this page (no quoteCornerViews in status) or a database without 276
//      (quoteCornerViews: null) shows no switch, and Save Settings sends nothing for it
//   F. at a phone's width the switch fits on screen
//   H. the re-read after a save fails (a blip, a cold start): ticking it, saving, then unticking it
//      and saving again still sends quoteCornerViews: false, and the server ends up off. The page
//      compares the box with `status`, so `status` has to learn what was stored without the re-read
//
// The stub answers `save` with portal-settings' rule (a real boolean or a 400). Supabase is stubbed at
// the network layer; nothing leaves the machine and NOTHING IS SAVED anywhere.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root, after npm run compile)
//   node tests/harness/quoteCornerSwitch.mjs        (exit 0 = every check held)
//
// Shots land in %TEMP%/ss-harness/quote-corner-switch (SS_SHOTS overrides). Against the portal before
// this change (git archive 135699d, served as SS_BASE) 6 checks fail, A1-A4, B-C and F1; D and E hold,
// as they should (an older page never sent the field). H's second save fails against the page
// before its save() learned the stored value without the re-read (nothing is sent; the server
// stays on).
//
// Fixtures are made up (example.test, a made-up tenant), per the public-repo rule.
import { join } from "node:path";
import { launch, reporter, BASE, REF, shotsDir } from "./lib.mjs";

const CLIENT = "acme-sheds";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000005", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const OWNER_ACCESS = Object.fromEntries(["designer", "designs", "contacts", "inventory", "orders", "change_orders",
  "change_order_approve", "build_schedule", "delivery_schedule", "repairs", "commissions", "reports", "phone",
  "settings_structures", "settings_options", "settings_branding", "settings_crm", "settings_quickbooks",
  "settings_email", "settings_team", "settings_billing"].map((k) => [k, "edit"]));
const LABEL = "Show the building from all four corners on page 2 of my estimates";
const HINT = "Page 2 of your estimates shows four 3D pictures of the building, one from each corner, in place of the single 3D view.";
const REFUSED = "The four-corner page setting has to be on or off.";
const TERMS_LABEL = "estimate terms";

const { ok, failed } = reporter();
const shots = shotsDir("quote-corner-switch");
const pageErrors = [];
const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });

/** `server`: "new" answers quoteCornerViews; "old" predates the field; "no276" is a database without
 *  the column (status answers null). `has3d`: the entitlement grants view_3d. `failReread`: every
 *  status call after the first save answers 503, as a blip or a cold start would. */
async function scenario(browser, { name, server = "new", corner = false, has3d = true, failReread = false, viewport = { width: 1400, height: 1000 } }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
  }, [REF, SESSION]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(`${name}: ${e.message}`));
  page.on("dialog", (d) => d.accept());
  const calls = [];
  const state = { corner, saves: 0 };
  await ctx.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    if (url.includes("/rest/v1/rpc/is_operator")) return json(route, false);
    if (url.includes("/rest/v1/rpc/")) return json(route, url.includes("log_error") ? null : false);
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: "owner", user_id: USER.id }]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) {
      return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], wallet: null, clientId: CLIENT,
        entitlement: { granted: has3d ? ["view_3d"] : [], paid: [], features: { crm: true }, status: "active" } });
    }
    if (!url.includes("/portal-settings")) return json(route, { ok: true });
    calls.push(body);
    switch (body.action) {
      case "status": {
        if (failReread && state.saves > 0) return json(route, { error: "Service unavailable" }, 503);
        const st = { ok: true, clientId: CLIENT, role: "owner", operatorMode: false, access: OWNER_ACCESS, prefs: null,
          phoneStatus: "off", configured: false, invoiceInGhl: false, ghlInvoicingAllowed: false,
          businessName: "Acme Sheds", businessPhone: "(555) 010-0100", businessAddress: {}, quoteTerms: "Deposit due at signing.",
          quoteValidDays: 30, branding: { companyName: "Acme Sheds" }, emailReady: true };
        if (server === "new") st.quoteCornerViews = state.corner;
        if (server === "no276") st.quoteCornerViews = null;
        return json(route, st);
      }
      case "save": {
        state.saves++;
        // portal-settings' rule: a real boolean, or a refusal with its sentence.
        if ("quoteCornerViews" in body) {
          if (typeof body.quoteCornerViews !== "boolean") return json(route, { error: REFUSED }, 400);
          state.corner = body.quoteCornerViews;
        }
        return json(route, { ok: true });
      }
      default: return json(route, { ok: true });
    }
  };
  await ctx.route(`**/${REF}.supabase.co/**`, handler);
  await ctx.route(`**/${REF}.functions.supabase.co/**`, handler);
  await page.goto(`${BASE}/portal.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  await page.waitForTimeout(600);
  await page.evaluate(() => { history.pushState({}, "", "/portal/settings/company"); window.dispatchEvent(new PopStateEvent("popstate")); });
  await page.waitForFunction((x) => document.body.innerText.toLowerCase().includes(x), TERMS_LABEL, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(500);
  return { ctx, page, calls, state };
}

const box = (page) => page.locator("input[data-ss-quote-corners]");
const saveBtn = (page) => page.getByRole("button", { name: /^Save Settings$/ });
const saves = (s) => s.calls.filter((c) => c.action === "save");
const bodyText = (page) => page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
const waitText = (page, t, timeout = 6000) => page.waitForFunction((x) => document.body.innerText.includes(x), t, { timeout }).then(() => true, () => false);
async function save(s) {
  const before = saves(s).length;
  await saveBtn(s.page).click({ timeout: 3000 });
  await s.page.waitForTimeout(700);
  return saves(s).slice(before);
}

const { browser } = await launch({ width: 1400, height: 1000 });
try {
  // ── A + B + C on a current server, a builder with 3D ──
  {
    const s = await scenario(browser, { name: "new" });
    const first = await bodyText(s.page);
    const loaded = ok("A0 the Company settings rendered", first.toLowerCase().includes(TERMS_LABEL), first.slice(0, 400).replace(/\s+/g, " "));
    if (!loaded) throw new Error("the Company settings never rendered; refusing to report the rest as passes");
    ok("A1 the switch is there, off", (await box(s.page).count()) === 1 && !(await box(s.page).isChecked()));
    const label = await box(s.page).locator("xpath=..").innerText({ timeout: 3000 }).catch(() => "");
    ok("A2 it says what it does, in plain words", label.trim() === LABEL && (await bodyText(s.page)).includes(HINT), label);
    const order = await s.page.evaluate(() => {
      const days = document.getElementById("ss-quote-valid-days");
      const sw = document.querySelector("input[data-ss-quote-corners]");
      return days && sw ? Boolean(days.compareDocumentPosition(sw) & Node.DOCUMENT_POSITION_FOLLOWING) : null;
    });
    ok("A3 it sits under 'Estimates are good for'", order === true, String(order));
    await box(s.page).scrollIntoViewIfNeeded().catch(() => {});
    await s.page.screenshot({ path: join(shots, "A-company-card.png") }).catch(() => {});

    if ((await box(s.page).count()) === 1) {
      // C first: an untouched switch is not sent.
      let sent = await save(s);
      ok("C1 a save that does not touch the switch sends no quoteCornerViews", sent.length === 1 && !("quoteCornerViews" in sent[0]) && sent[0].businessName === "Acme Sheds", JSON.stringify(sent));

      // B. on
      await box(s.page).check({ timeout: 3000 });
      sent = await save(s);
      ok("B1 ticked, Save Settings sends quoteCornerViews: true (a boolean) with the rest of the form",
        sent.length === 1 && sent[0].quoteCornerViews === true && sent[0].quoteTerms === "Deposit due at signing.", JSON.stringify(sent));
      ok("B2 the screen says Settings saved.", await waitText(s.page, "Settings saved."));
      ok("B3 the server stored it", s.state.corner === true);
      ok("B4 the switch is still ticked after the re-read", await box(s.page).isChecked());
      await s.page.screenshot({ path: join(shots, "B-switched-on.png") }).catch(() => {});
      sent = await save(s);
      ok("C2 saving again with nothing changed sends nothing for it", sent.length === 1 && !("quoteCornerViews" in sent[0]), JSON.stringify(sent));
      // B. off again
      await box(s.page).uncheck({ timeout: 3000 });
      sent = await save(s);
      ok("B5 unticked, Save Settings sends quoteCornerViews: false", sent.length === 1 && sent[0].quoteCornerViews === false, JSON.stringify(sent));
      ok("B6 the server stored off", s.state.corner === false);
    } else {
      ok("B-C the switch is missing, so saving it cannot be checked", false);
    }
    await s.ctx.close();
  }

  // ── A builder who already has it on: it loads ticked ──
  {
    const s = await scenario(browser, { name: "on", corner: true });
    ok("A4 a builder who switched it on sees it ticked", (await box(s.page).count()) === 1 && (await box(s.page).isChecked()));
    await s.ctx.close();
  }

  // ── D. no 3D ──
  {
    const s = await scenario(browser, { name: "no3d", has3d: false, corner: true });
    ok("D0 the Company settings rendered", (await bodyText(s.page)).toLowerCase().includes(TERMS_LABEL));
    ok("D1 a builder without 3D sees no switch", (await box(s.page).count()) === 0 && !(await bodyText(s.page)).includes(LABEL));
    const sent = await save(s);
    ok("D2 and their saves never name it", sent.length === 1 && !("quoteCornerViews" in sent[0]), JSON.stringify(sent));
    await s.ctx.close();
  }

  // ── E. an older server, and a database without 276 ──
  for (const server of ["old", "no276"]) {
    const s = await scenario(browser, { name: server, server });
    ok(`E ${server}: the Company settings rendered`, (await bodyText(s.page)).toLowerCase().includes(TERMS_LABEL));
    ok(`E ${server}: no switch`, (await box(s.page).count()) === 0);
    const sent = await save(s);
    ok(`E ${server}: Save Settings still saves, and sends no quoteCornerViews`, sent.length === 1 && !("quoteCornerViews" in sent[0]), JSON.stringify(sent));
    ok(`E ${server}: and says Settings saved.`, await waitText(s.page, "Settings saved."));
    await s.ctx.close();
  }

  // ── H. the re-read after a save fails ──
  {
    const s = await scenario(browser, { name: "reread", failReread: true });
    ok("H0 the switch is there, off", (await box(s.page).count()) === 1 && !(await box(s.page).isChecked()));
    if ((await box(s.page).count()) === 1) {
      await box(s.page).check({ timeout: 3000 });
      let sent = await save(s);
      ok("H1 ticked and saved (the re-read after it fails)", sent.length === 1 && sent[0].quoteCornerViews === true && s.state.corner === true, JSON.stringify(sent));
      ok("H2 the screen still says Settings saved.", await waitText(s.page, "Settings saved."));
      await box(s.page).uncheck({ timeout: 3000 });
      sent = await save(s);
      ok("H3 unticked, Save Settings still sends quoteCornerViews: false", sent.length === 1 && sent[0].quoteCornerViews === false, JSON.stringify(sent));
      ok("H4 and the server ends up off, as the box says", s.state.corner === false, String(s.state.corner));
    }
    await s.ctx.close();
  }

  // ── F. a phone ──
  {
    const s = await scenario(browser, { name: "phone", viewport: { width: 390, height: 844 } });
    await box(s.page).scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await s.page.waitForTimeout(300);
    const r = await s.page.evaluate(() => {
      const el = document.querySelector("input[data-ss-quote-corners]");
      const row = el && el.closest("div");
      const b = row && row.getBoundingClientRect();
      return b ? { right: Math.round(b.right), vw: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth } : null;
    });
    ok("F1 the switch and its note fit on a phone's screen", !!r && r.right <= r.vw && r.scroll <= r.vw, JSON.stringify(r));
    await s.page.screenshot({ path: join(shots, "F-phone.png") }).catch(() => {});
    await s.ctx.close();
  }
} finally {
  await browser.close();
}

ok("G no page errors", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 400));
const f = failed();
console.log(f.length ? `\n${f.length} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
process.exit(f.length ? 1 : 0);
