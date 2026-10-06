// Contacts "Own · View" (2026-10-06, migration 286), driven for real on the COMPILED portal.
//
// Carolyn: "a per-user setting the builder controls: edit or view only." A rep limited to their own
// customers is either Own · Edit (contacts 'own', today's behaviour and the Dealer preset) or the
// new Own · View (contacts 'own_view'). The server enforces it (RLS, the edge gates, the phone
// Worker); this proves the screens tell the same story:
//
//   R  a rep on Own · View (status: contacts 'own_view', designs 'edit'):
//      R1 the Contacts tab is in their nav, and the list says why it is short AND that they may
//         look but not change ([data-ss-row-scope-note]);
//      R2 on a customer's record every customer-record write is greyed with the permission
//         reason — Activity, Notes, SMS, Email and Uploads — and there is no ✎ Edit;
//      R3 the Focus "complete" box is disabled with the reason (it used to be live and 403);
//   E  the control: the same record for a rep on Own · Edit — the same tabs live, ✎ Edit offered,
//      the Focus box live — so R's greying is the level and nothing else;
//   A  an ADMIN an owner narrowed to Own · View (the server's gates key on the map, not the role):
//      the same note, the same greyed tabs, no ✎ Edit, the Focus box disabled — R for role
//      'admin'; and the controls, an un-narrowed admin and an owner, with every write live and no
//      note, so the portal reads the resolved map rather than the role in both directions;
//   T  an owner on Settings → Team, with the grid built from the REAL access.ts metadata:
//      T1 the Contacts row reads No access / Own · View / Own · Edit / All · View / All · Edit,
//         and no raw level slug appears anywhere on the screen;
//      T2 no horizontal overflow at 1280 or 768 wide (scrollWidth against clientWidth, the page and
//         the grid card both);
//      T3 picking Own · View and saving sends access.contacts 'own_view' with the title unchanged;
//      T4 the Access column then summarises the person as "Contacts own, view only";
//   G  an admin who is on Own · View themselves: of the Contacts row only No access and Own · View
//      are offered — the server's mayGrant rules 3 and 4 (an own-scope holder passes on only an
//      own level; nobody passes on a write they do not hold);
//   U  the unpatched bundle (SS_PORTAL_BEFORE_REF, default 5412051a) FAILS: no Contacts tab or note
//      for an own_view rep, and a raw "own_view" button on the Team screen — so the checks above
//      can fail.
//
// Supabase is stubbed at the network layer (no login, nothing leaves the machine); the skeleton is
// contactsWithoutDesign.mjs's and crmContactDeal.mjs's.
//
//   python -m http.server 8881 --bind 127.0.0.1   (repo root)
//   SS_BASE=http://127.0.0.1:8881 node tests/harness/contactsOwnView.mjs   (exit 0 = every check held)
//
// ⚠️ EVERY CHECK IS GUARDED BY "the page rendered": nothing to find is not the same as nothing there.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launch, reporter, BASE, REF, shotsDir } from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORTAL_HTML = readFileSync(join(ROOT, "portal.html"), "utf8");
const BEFORE_REF = process.env.SS_PORTAL_BEFORE_REF || "5412051a";
const BEFORE = process.env.SS_PORTAL_BEFORE
  ? readFileSync(process.env.SS_PORTAL_BEFORE, "utf8")
  : execFileSync("git", ["show", `${BEFORE_REF}:portal.app.compiled.js`], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
// The real permission model: the Team grid renders what portal-commissions ships (accessMetadata),
// and the status call hands the portal effectiveAccess's map, so both come from the source of truth.
const access = await import(pathToFileURL(join(ROOT, "supabase/functions/_shared/access.ts")).href);

const TENANT = "acme-sheds";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000002", aud: "authenticated", role: "authenticated", email: "rep@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const REP_ID = "00000000-0000-4000-8000-000000000005";
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};

// ── Fixtures. Neutral names, example.test addresses and 555-01xx numbers only (the repo is public).
const CONTACT_ID = "00000000-0000-4000-8000-00000000c201";
const CONTACT = {
  id: CONTACT_ID, client_id: TENANT, name: "Jordan Example", phone: "+15125550142", email: "jordan@example.test",
  phone_digits: "15125550142", owner_user_id: USER.id, source: "design", first_seen_at: "2026-09-20T15:00:00Z",
  created_at: "2026-09-20T15:00:00Z", merged_into: null, sms_opt_out_at: null,
};
const DESIGN = {
  client_id: TENANT, short_code: "SS-JORD001A", created_at: "2026-09-21T15:00:00Z", updated_at: "2026-09-21T15:00:00Z",
  status: "sent", selections: { style: "Utility", size: "12x16" }, expected_close_date: null, total_cents: 812300,
  ghl_estimate_number: null, image_url: null, ss_quote_number: "1041", ss_quote_pdf_url: null, contact_id: CONTACT_ID,
  contact: { name: "Jordan Example", phone: "+15125550142", email: "jordan@example.test" },
};
const FOCUS = [{ id: "00000000-0000-4000-8000-00000000f001", subject: "Call about the door", due_at: "2026-10-09T15:00:00Z", short_code: DESIGN.short_code }];

const OWN_VIEW = access.effectiveAccess("user", "sales_rep", { contacts: "own_view" });
const OWN_EDIT = access.effectiveAccess("user", "sales_rep", { contacts: "own" });

const { ok, failed } = reporter();
const shots = shotsDir("contacts-own-view");
const { browser, ctx: unused } = await launch({ width: 1280, height: 1000 });
await unused.close();

const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });

// One fresh context per scenario. S: { role, access, team (portal-commissions list), artifact, width }.
async function open(label, S, path) {
  const calls = [];
  const pageErrors = [];
  const ctx = await browser.newContext({ viewport: { width: S.width || 1280, height: 1000 }, serviceWorkers: "block" });
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
    if (url.includes("/rest/v1/rpc/")) return json(route, /log_error/.test(url) ? null : false);
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: TENANT, role: S.role, user_id: USER.id }]);
    if (url.includes("/rest/v1/")) {
      const table = (url.match(/\/rest\/v1\/([a-z_]+)/) || [])[1];
      // What RLS answers an own-scope caller: their own customer, and its design.
      if (table === "crm_contacts") return json(route, [CONTACT]);
      if (table === "designs") return json(route, [{ ...DESIGN, sel_style: "Utility", sel_size: "12x16" }]);
      return json(route, []);
    }
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    const fn = /\/functions\/v1\/([a-z0-9-]+)/.exec(url);
    if (fn) calls.push({ fn: fn[1], body });
    if (url.includes("/portal-billing")) {
      return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: { crm: true }, status: "active" }, wallet: null });
    }
    if (url.includes("/sync-design-status")) return json(route, { statuses: {} });
    if (url.includes("/portal-commissions")) {
      if (body.action === "list") return json(route, S.team());
      if (body.action === "set_access") { S.saved = body; return json(route, { ok: true }); }
      return json(route, { ok: true });
    }
    if (url.includes("/portal-settings")) {
      if (body.action === "status") {
        return json(route, { ok: true, clientId: TENANT, role: S.role, access: S.access, prefs: null, configured: false, branding: {} });
      }
      if (body.action === "crm_record") {
        return json(route, {
          ok: true, kind: body.kind, clientId: TENANT, contact: CONTACT, designs: [DESIGN], orders: [], feed: [], focus: FOCUS,
          team: [], people: [], followers: [], sms: { ready: true, from: "+15125550100", optedOut: false, consented: true },
          build: [], stages: [], delivery: [], repairs: [], isDesign: false,
        });
      }
      return json(route, { ok: true });
    }
    return json(route, { ok: true });
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  await page.route(/\/portal\/[a-z]/, (r) => r.fulfill({ status: 200, contentType: "text/html", body: PORTAL_HTML }));
  if (S.artifact) await page.route(/portal\.app\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: S.artifact }));

  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  const booted = await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 })
    .then(() => true, () => false);
  await page.waitForTimeout(1500);
  return { page, ctx, calls, pageErrors, booted, label };
}

// ── R/E: a rep's Contacts list and a customer's record ─────────────────────────────────────
async function repView(label, accessMap, artifact = null, role = "user") {
  const r = await open(label, { role, access: accessMap, artifact }, "/portal/contacts");
  const out = { label, booted: r.booted };
  out.navContacts = await r.page.locator('a[href="/portal/contacts"]').count() > 0;
  out.path = await r.page.evaluate(() => location.pathname);
  out.listRendered = await r.page.waitForFunction(() => /Jordan Example/.test(document.body.innerText), null, { timeout: 15000 }).then(() => true, () => false);
  out.note = await r.page.evaluate(() => {
    const n = document.querySelector("[data-ss-row-scope-note]");
    return n ? n.innerText.trim() : null;
  });
  await r.page.screenshot({ path: join(shots, `${label}-list.png`), fullPage: true });
  // The record, the way a row's name opens it.
  await r.page.evaluate((p) => { history.pushState({}, "", p); window.dispatchEvent(new PopStateEvent("popstate")); }, `/portal/contacts/c-${CONTACT_ID}`);
  out.recordRendered = await r.page.waitForFunction(() => /Call about the door/.test(document.body.innerText), null, { timeout: 20000 }).then(() => true, () => false);
  await r.page.waitForTimeout(600);
  // Pick the deal first: a contact's write tabs wait for one (needsPick), and that hint comes
  // AFTER the permission one, so with a deal picked the only thing left to grey a tab is the level.
  out.picked = await r.page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /Utility 12x16/.test(x.innerText || ""));
    if (b) b.click();
    return !!b;
  });
  await r.page.waitForTimeout(800);
  out.tabs = await r.page.evaluate(() => Object.fromEntries(["Activity", "Notes", "SMS", "Email", "Uploads"].map((t) => {
    const b = [...document.querySelectorAll("button")].find((x) => (x.innerText || "").trim() === t);
    return [t, b ? { disabled: b.disabled, title: b.getAttribute("title") || "" } : null];
  })));
  out.editOffered = await r.page.locator('button[title="Edit this contact\'s name, email and phone"]').count() > 0;
  out.focusBox = await r.page.evaluate(() => {
    const row = [...document.querySelectorAll("span")].find((s) => s.innerText === "Call about the door");
    const box = row && row.parentElement ? row.parentElement.querySelector('input[type="checkbox"]') : null;
    return box ? { disabled: box.disabled, title: box.getAttribute("title") || "" } : null;
  });
  await r.page.screenshot({ path: join(shots, `${label}-record.png`), fullPage: true });
  out.pageErrors = r.pageErrors;
  await r.ctx.close();
  return out;
}

// ── T/G: Settings → Team, with one rep ─────────────────────────────────────────────────────
const member = (over = {}) => ({
  userId: REP_ID, email: "rory@example.test", fullName: "Rory Rep", role: "user", title: "sales_rep", access: null,
  effective: access.effectiveAccess("user", "sales_rep", null), isSelf: false, lastActive: "2026-10-05T15:00:00Z",
  commissionPercent: null, seesAllPayouts: false, fullAccess: false, locationId: null, ...over,
});
const self = (role, title, acc) => ({
  userId: USER.id, email: USER.email, fullName: "Olive Owner", role, title, access: acc,
  effective: access.effectiveAccess(role, title, acc), isSelf: true, lastActive: "2026-10-06T15:00:00Z",
  commissionPercent: null, seesAllPayouts: false, fullAccess: false, locationId: null,
});
async function teamView(label, { role, title, myAccessMap, width = 1280, artifact = null, after = null }) {
  const S = { role, access: role === "owner" ? null : myAccessMap, width, artifact, saved: null };
  let saved = false;
  S.team = () => ({
    ok: true, clientId: TENANT, role, canSeeRates: role === "owner", isOwner: role === "owner", locations: [],
    members: [self(role, title, role === "owner" ? null : myAccessMap),
      saved && after ? member({ access: after, effective: access.effectiveAccess("user", "sales_rep", after) }) : member()],
    meta: access.accessMetadata(), isInternal: false, canManageTeam: true,
    myAccess: role === "owner" ? access.effectiveAccess("owner", "owner", null) : myAccessMap,
  });
  const r = await open(label, S, "/portal/settings/team");
  const out = { label, booted: r.booted };
  out.listed = await r.page.waitForFunction(() => /Rory Rep/.test(document.body.innerText), null, { timeout: 20000 }).then(() => true, () => false);
  if (out.listed) {
    await r.page.locator("tr", { hasText: "Rory Rep" }).locator("button", { hasText: /^Edit$/ }).first().click();
    await r.page.waitForTimeout(600);
  }
  // The Contacts row of the grid: its label cell reads exactly "Contacts".
  const contactsRow = () => r.page.evaluate(() => {
    const label = [...document.querySelectorAll("div")].find((d) => d.innerText === "Contacts" && d.parentElement
      && d.parentElement.querySelectorAll("button").length >= 2);
    if (!label) return null;
    return [...label.parentElement.querySelectorAll("button")].map((b) => ({
      text: (b.innerText || "").trim(), disabled: b.disabled, title: b.getAttribute("title") || "",
    }));
  });
  out.row = await contactsRow();
  out.gridOpen = !!out.row;
  out.slugOnScreen = await r.page.evaluate(() => /\bown_view\b/.test(document.body.innerText));
  out.overflow = await r.page.evaluate(() => {
    const de = document.documentElement;
    const card = [...document.querySelectorAll("button")].find((b) => (b.innerText || "").trim() === "Save access");
    let grid = card;
    while (grid && grid.parentElement && !(grid.style && grid.style.borderRadius === "12px")) grid = grid.parentElement;
    return {
      page: { scroll: de.scrollWidth, client: de.clientWidth },
      grid: grid ? { scroll: grid.scrollWidth, client: grid.clientWidth } : null,
    };
  });
  await r.page.screenshot({ path: join(shots, `${label}-grid.png`), fullPage: true });
  if (out.gridOpen && role === "owner" && !artifact) {
    saved = true;
    await r.page.locator("button", { hasText: /^Own · View$/ }).first().click();
    await r.page.locator("button", { hasText: /^Save access$/ }).first().click();
    await r.page.waitForTimeout(1200);
    out.saved = S.saved;
    out.summary = await r.page.evaluate(() => {
      const row = [...document.querySelectorAll("tr")].find((t) => /Rory Rep/.test(t.innerText));
      return row ? row.innerText.replace(/\s+/g, " ") : null;
    });
  }
  out.pageErrors = r.pageErrors;
  await r.ctx.close();
  return out;
}

const LABELS = ["No access", "Own · View", "Own · Edit", "All · View", "All · Edit"];
const fits = (o) => !!o && o.page.scroll <= o.page.client + 1 && !!o.grid && o.grid.scroll <= o.grid.client + 1;

try {
  // ── R. a rep on Own · View ──────────────────────────────────────────────────────────────
  {
    const v = await repView("R-own-view", OWN_VIEW);
    if (!ok("R0 the portal booted and the record rendered", v.booted && v.recordRendered, JSON.stringify({ booted: v.booted, record: v.recordRendered, path: v.path })))
      throw new Error("R: nothing rendered; refusing to report the rest as passes");
    ok("R1a the Contacts tab is in their nav", v.navContacts);
    ok("R1b their list rendered (their own customer)", v.listRendered);
    ok("R1c the list says why it is short, and that they can look but not change",
      !!v.note && /assigned to you or that you're following/.test(v.note) && /You can view their details but not change them\./.test(v.note), v.note);
    const want = { Activity: "log activities", Notes: "add notes", SMS: "text contacts", Email: "email contacts", Uploads: "add files to contacts" };
    for (const [tab, verb] of Object.entries(want)) {
      const t = v.tabs[tab];
      ok(`R2 ${tab} is greyed with the permission reason`, !!t && t.disabled && t.title === `You don't have permission to ${verb}.`, JSON.stringify(t));
    }
    ok("R2 (with the deal picked, so only the level can grey them)", v.picked === true);
    ok("R2 no ✎ Edit on the contact", v.editOffered === false);
    ok("R3 the Focus complete box is disabled, with the reason",
      !!v.focusBox && v.focusBox.disabled && v.focusBox.title === "You don't have permission to complete activities.", JSON.stringify(v.focusBox));
    ok("R4 no uncaught page errors", v.pageErrors.length === 0, v.pageErrors.join(" | "));
  }

  // ── E. the control: Own · Edit, today's behaviour ───────────────────────────────────────
  {
    const v = await repView("E-own-edit", OWN_EDIT);
    if (!ok("E0 rendered", v.booted && v.recordRendered)) throw new Error("E: nothing rendered");
    ok("E1 the note is there without the view-only sentence",
      !!v.note && !/not change them/.test(v.note), v.note);
    ok("E2 with the deal picked, Activity, Notes, SMS, Email and Uploads are all live",
      ["Activity", "Notes", "SMS", "Email", "Uploads"].every((t) => v.tabs[t] && !v.tabs[t].disabled), JSON.stringify(v.tabs));
    ok("E3 ✎ Edit is offered", v.editOffered === true);
    ok("E4 the Focus box is live", !!v.focusBox && !v.focusBox.disabled, JSON.stringify(v.focusBox));
  }

  // ── A. an admin narrowed to Own · View, and the un-narrowed controls ────────────────────
  {
    const v = await repView("A-admin-own-view", access.effectiveAccess("admin", "admin", { contacts: "own_view" }), null, "admin");
    if (!ok("A0 rendered for an admin on Own · View", v.booted && v.recordRendered, JSON.stringify({ booted: v.booted, record: v.recordRendered, path: v.path })))
      throw new Error("A: nothing rendered");
    ok("A1 the admin's list says why it is short, and that they can look but not change",
      !!v.note && /You can view their details but not change them\./.test(v.note), v.note);
    ok("A2 with the deal picked, Activity, Notes, SMS, Email and Uploads are all greyed",
      v.picked === true && ["Activity", "Notes", "SMS", "Email", "Uploads"].every((t) => v.tabs[t] && v.tabs[t].disabled), JSON.stringify(v.tabs));
    ok("A3 no ✎ Edit on the contact", v.editOffered === false);
    ok("A4 the Focus complete box is disabled", !!v.focusBox && v.focusBox.disabled, JSON.stringify(v.focusBox));
    ok("A5 no uncaught page errors", v.pageErrors.length === 0, v.pageErrors.join(" | "));
  }
  for (const [label, role, title] of [["A-admin-control", "admin", "admin"], ["A-owner-control", "owner", "owner"]]) {
    const v = await repView(label, access.effectiveAccess(role, title, null), null, role);
    if (!ok(`A6 (${role}) rendered`, v.booted && v.recordRendered)) throw new Error(`${label}: nothing rendered`);
    ok(`A6 (${role}) no row-scope note`, v.note === null, v.note);
    ok(`A6 (${role}) with the deal picked, every write tab is live, ✎ Edit offered, the Focus box live`,
      ["Activity", "Notes", "SMS", "Email", "Uploads"].every((t) => v.tabs[t] && !v.tabs[t].disabled) && v.editOffered === true
      && !!v.focusBox && !v.focusBox.disabled, JSON.stringify({ tabs: v.tabs, edit: v.editOffered, focus: v.focusBox }));
  }

  // ── T. an owner on Settings → Team ──────────────────────────────────────────────────────
  for (const width of [1280, 768]) {
    const t = await teamView(`T-owner-${width}`, { role: "owner", title: "owner", width, after: { contacts: "own_view" } });
    if (!ok(`T0 (${width}) the Team list rendered and the grid opened`, t.booted && t.listed && t.gridOpen, JSON.stringify({ booted: t.booted, listed: t.listed, grid: t.gridOpen })))
      throw new Error(`T ${width}: nothing rendered`);
    ok(`T1 (${width}) the Contacts row reads ${LABELS.join(" / ")}`,
      JSON.stringify(t.row.map((b) => b.text)) === JSON.stringify(LABELS), JSON.stringify(t.row.map((b) => b.text)));
    ok(`T1 (${width}) an owner may pick any of them`, t.row.every((b) => !b.disabled), JSON.stringify(t.row));
    ok(`T1 (${width}) no raw level slug on screen`, t.slugOnScreen === false);
    ok(`T2 (${width}) no horizontal overflow (page and grid card)`, fits(t.overflow), JSON.stringify(t.overflow));
    if (width === 1280) {
      ok("T3 picking Own · View and saving sends access.contacts 'own_view', title unchanged",
        !!t.saved && t.saved.action === "set_access" && t.saved.userId === REP_ID && t.saved.title === "sales_rep"
        && t.saved.access && t.saved.access.contacts === "own_view", JSON.stringify(t.saved));
      ok("T3 ...and only that: nothing else changed from the title", !!t.saved && Object.keys(t.saved.access).length === 1, JSON.stringify(t.saved && t.saved.access));
      ok("T4 the Access column summarises them as own, view only", !!t.summary && /Contacts own, view only/.test(t.summary), t.summary);
    }
    ok(`T5 (${width}) no uncaught page errors`, t.pageErrors.length === 0, t.pageErrors.join(" | "));
  }

  // ── G. an admin who is on Own · View themselves ─────────────────────────────────────────
  {
    const mine = access.effectiveAccess("admin", "admin", { contacts: "own_view" });
    const t = await teamView("G-admin-own-view", { role: "admin", title: "admin", myAccessMap: mine });
    if (!ok("G0 the grid opened for the admin", t.booted && t.listed && t.gridOpen)) throw new Error("G: nothing rendered");
    const offered = t.row.filter((b) => !b.disabled).map((b) => b.text);
    ok("G1 only No access and Own · View are offered (mayGrant rules 3 and 4)",
      JSON.stringify(offered) === JSON.stringify(["No access", "Own · View"]), JSON.stringify(t.row));
    const own = t.row.find((b) => b.text === "Own · Edit");
    ok("G2 a refused level says why", !!own && /can't give more Contacts access than you have yourself/.test(own.title), JSON.stringify(own));
    // The server agrees, cell by cell (the same rule, from the real access.ts).
    ok("G3 ...and that is exactly what the server's mayGrant allows",
      LABELS.every((l, i) => {
        const lv = ["none", "own_view", "own", "view", "edit"][i];
        return (lv === "none" || access.mayGrant("admin", mine, "contacts", lv)) === offered.includes(l);
      }));
  }

  // ── U. the unpatched bundle fails ───────────────────────────────────────────────────────
  {
    const v = await repView("U-rep-before", OWN_VIEW, BEFORE);
    ok("U1 before: an own_view rep has no Contacts tab or no view-only note (R1 can fail)",
      !v.navContacts || !v.note || !/not change them/.test(v.note), JSON.stringify({ nav: v.navContacts, note: v.note }));
    const t = await teamView("U-team-before", { role: "owner", title: "owner", artifact: BEFORE });
    ok("U2 before: the Team grid shows a raw 'own_view' button (T1 can fail)",
      !!t.row && (t.slugOnScreen || JSON.stringify(t.row.map((b) => b.text)) !== JSON.stringify(LABELS)), JSON.stringify(t.row && t.row.map((b) => b.text)));
  }
} finally {
  await browser.close();
}

console.log(`\nshots: ${shots}`);
const bad = failed();
if (bad.length) { console.log(`\ncontactsOwnView: ${bad.length} FAILED`); process.exit(1); }
console.log("all checks held");
