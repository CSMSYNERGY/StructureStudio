// The Contacts list shows contacts with no design and no browsing visit (2026-10-06, batch B8),
// driven for real on the COMPILED portal.
//
// Until now the list (portal/02-sales.jsx, LeadsTable) was built from designs and browsing leads,
// so a contact with neither appeared in no list at all: one imported from GoHighLevel (282), one
// saved from My Synergy Phone, one added by hand, one whose design was deleted. The GoHighLevel
// import waits on this. What this proves:
//
//   A  a builder's own Contacts: each contact with no design or visit is listed ONCE, with its
//      source in plain words; nobody who already has a row (a design, a browsing visit, a visit
//      hidden under its person's design) gets a second; a nameless one shows its phone and opens
//      its record; search and the "Contact only" chip include them. The read is PostgREST under
//      the caller's own token: newest first, bounded, live contacts of this tenant only.
//   B  thousands of contacts: the first load reads ONE page, "Show more" reads the next ones, the
//      "N older contacts" sentence counts what is left, a contact with a design on a later page
//      still gets no second row, and the sentence goes once everything is in.
//   C  a person limited to their own customers (contacts:'own'): the list is exactly what RLS
//      answers (the stub answers as 193's rule would), read with their token, nothing wider.
//   D  an operator's view-as: the contacts come through operator-portal get_portal (the first page
//      with everything else when the list asks with `withContacts`, "Show more" as `contactsFrom`),
//      never a PostgREST read of the tenant.
//   E  NO CHANGE for a tenant whose contacts all have a design or visit: the rendered list (table,
//      chips, count) is byte-identical to the artifact before this change, and no "Show more".
//   F  the control: the artifact before this change shows none of A's contacts, so A can fail.
//   G  a browsing visit linked to a contact that no longer exists does not hide the last unread
//      contacts: "Show more" stays while the server has rows left, and brings them in.
//   H  "Show more" pressed while the GoHighLevel status sync is running keeps the synced statuses.
//
// Supabase is stubbed at the network layer (no login, nothing leaves the machine); the stub
// skeleton is crmContactDeal.mjs's and the cold deep links supportConsoles.mjs's.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/contactsWithoutDesign.mjs   (exit 0 = every check held)
//
// SS_BASE overrides the server (lib.mjs). The "before" artifact for E and F is
// portal.app.compiled.js at SS_PORTAL_BEFORE_REF (default 9e409073, the commit this change was
// built on), read with git; SS_PORTAL_BEFORE=<file> uses a file instead.
//
// ⚠️ EVERY CHECK IS GUARDED BY "the list rendered": nothing to find is not the same as nothing there.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, reporter, BASE, REF, shotsDir } from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORTAL_HTML = readFileSync(join(ROOT, "portal.html"), "utf8");
const BEFORE_REF = process.env.SS_PORTAL_BEFORE_REF || "9e409073";
const BEFORE = process.env.SS_PORTAL_BEFORE
  ? readFileSync(process.env.SS_PORTAL_BEFORE, "utf8")
  : execFileSync("git", ["show", `${BEFORE_REF}:portal.app.compiled.js`], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const TENANT = "acme-sheds";
const OWN_OPS = "harness-ops";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000002", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const OTHER_USER = "00000000-0000-4000-8000-000000000009";
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};

// ── Fixtures. Neutral names, example.test addresses and 555-01xx numbers only (the repo is public).
const cid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const contact = (n, name, phone, email, source, seen, owner = null) => ({
  id: cid(n), client_id: TENANT, name, phone, email, source, first_seen_at: seen, created_at: seen,
  merged_into: null, owner_user_id: owner,
});
const CP = cid(101), CQ = cid(102), CL = cid(103);
// The three people who already have a row: two by design, one by browsing visit.
const LINKED = [
  contact(101, "Pat Example", "+15125550101", "pat@example.test", "design", "2026-09-01T15:00:00Z"),
  contact(102, "Quinn Example", "+15125550102", null, "design", "2026-09-05T15:00:00Z"),
  contact(103, "Lee Browser", "+15125550103", null, "captured_lead", "2026-09-10T15:00:00Z"),
];
// The ones this change is about.
const ONLY = [
  contact(201, "Gale Imported", "+15125550201", "gale@example.test", "ghl_import", "2026-08-15T15:00:00Z"),
  contact(202, null, "+15125550202", null, "ghl_import", "2025-12-01T15:00:00Z"),
  contact(203, "Phoebe Caller", "+15125550203", null, "phone", "2026-09-20T15:00:00Z"),
  contact(204, "Max Manual", null, "max@example.test", "manual", "2026-07-01T15:00:00Z"),
  contact(205, "Dee Deleted", "+15125550205", null, "design", "2026-06-01T15:00:00Z"),
  // Assigned to a teammate: invisible to someone limited to their own customers (C).
  contact(206, "Oscar Other", "+15125550206", null, "ghl_import", "2026-08-01T15:00:00Z", OTHER_USER),
];
// How the nameless import (202) is listed: its phone, written the way the portal writes one.
const NAMELESS = "(512) 555-0202";
// A merged contact is a tombstone and must never be listed.
const MERGED = { ...contact(207, "Mia Merged", "+15125550207", null, "ghl_import", "2026-09-25T15:00:00Z"), merged_into: CP };

const design = (code, cId, c, at, status = "sent") => ({
  client_id: TENANT, short_code: code, created_at: at, updated_at: at, status, contact: c,
  selections: { style: "Utility", size: "12x16" }, ghl_estimate_number: null, contact_id: cId,
});
const DESIGNS = [
  design("SS-PAT0001A", CP, { name: "Pat Example", phone: "+15125550101", email: "pat@example.test" }, "2026-09-02T15:00:00Z"),
  design("SS-PAT0002A", CP, { name: "Pat Example", phone: "(512) 555-0101", email: "" }, "2026-09-12T15:00:00Z", "accepted"),
  design("SS-QUI0001A", CQ, { name: "Quinn Example", phone: "+15125550102" }, "2026-09-06T15:00:00Z"),
  // No phone and no email: no contact, a row keyed by its short code (unchanged by this work).
  design("SS-NOB0001A", null, { name: "" }, "2026-08-20T15:00:00Z", "draft"),
  // A lot building, never a contact row.
  design("SS-INV0001A", null, {}, "2026-08-21T15:00:00Z", "inventory"),
];
const LEADS = [
  { client_id: TENANT, id: 1, name: "Lee Browser", phone: "+15125550103", phone_digits: "15125550103", email: null, source: "gate", created_at: "2026-09-10T15:00:00Z", updated_at: "2026-09-11T15:00:00Z", contact_id: CL },
  // Pat browsed too: hidden under Pat's designs, and Pat's contact must still count as having a row.
  { client_id: TENANT, id: 2, name: "Pat Example", phone: "5125550101", phone_digits: "5125550101", email: null, source: "details", created_at: "2026-08-30T15:00:00Z", updated_at: "2026-08-31T15:00:00Z", contact_id: CP },
];

// B and D: 1200 more imported contacts, all older than A's, newest first one hour apart. Number 700
// lands on the second page and has a design, so it must never become a "Contact only" row.
// Their numbers stay inside the fictional 555-0100..0199 block: a hundred per area code, twelve
// area codes, so all 1200 are distinct and none can ring anybody.
const BULK_AREAS = [201, 202, 203, 205, 206, 207, 208, 209, 210, 212, 213, 214];
const bulkPhone = (i) => `+1${BULK_AREAS[Math.floor(i / 100)]}55501${String(i % 100).padStart(2, "0")}`;
const BULK = Array.from({ length: 1200 }, (_, i) =>
  contact(10000 + i, `Bulk Lead ${String(i).padStart(4, "0")}`, bulkPhone(i), null, "ghl_import",
    new Date(Date.parse("2025-11-30T12:00:00Z") - i * 3600_000).toISOString()));
const BULK_DESIGN = design("SS-BLK0700A", cid(10700), { name: "Bulk Lead 0700", phone: bulkPhone(700) }, "2026-09-15T15:00:00Z");

const { ok, failed } = reporter();
const shots = shotsDir("contacts-without-design");
const { browser, ctx: unused } = await launch({ width: 1400, height: 1000 });
await unused.close();

const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200, extra = {}) =>
  route.fulfill({ status, contentType: "application/json", headers: { ...H, ...extra }, body: JSON.stringify(body) });

// PostgREST as far as these reads go: client_id=eq., merged_into=is.null, offset/limit, and the
// count in content-range when the request asks for it. crm_contacts is ordered the way the real
// read asks (first_seen_at desc, id desc) so the pages are the pages the database would answer.
function restAnswer(url, req, S) {
  const u = new URL(url);
  const table = (u.pathname.match(/\/rest\/v1\/([a-z_]+)/) || [])[1];
  const client = (u.searchParams.get("client_id") || "").replace(/^eq\./, "");
  let rows = (S.tables[table] || []).filter((r) => !client || r.client_id === client);
  if (table === "crm_contacts") {
    if (u.searchParams.get("merged_into") === "is.null") rows = rows.filter((r) => !r.merged_into);
    // RLS for a contacts:'own' caller (193): unassigned, theirs, or followed (no follows here).
    if (S.ownScope) rows = rows.filter((r) => !r.owner_user_id || r.owner_user_id === USER.id);
    rows = [...rows].sort((a, b) => (a.first_seen_at < b.first_seen_at ? 1 : a.first_seen_at > b.first_seen_at ? -1 : (a.id < b.id ? 1 : -1)));
  }
  if (table === "designs") {
    rows = rows.map((r) => ({ ...r, sel_style: r.selections.style, sel_size: r.selections.size }));
  }
  const total = rows.length;
  const off = Number(u.searchParams.get("offset") || 0);
  const lim = u.searchParams.has("limit") ? Number(u.searchParams.get("limit")) : rows.length;
  const page = rows.slice(off, off + lim);
  const wantCount = /count=exact/.test(req.headers()["prefer"] || "");
  const range = page.length ? `${off}-${off + page.length - 1}` : "*";
  return { page, headers: { "content-range": `${range}/${wantCount ? total : "*"}` } };
}

// One fresh context per scenario: nothing the portal caches in memory or storage leaks between them.
async function run(label, S) {
  const calls = { rest: [], fns: [] };
  const pageErrors = [];
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, serviceWorkers: "block" });
  await ctx.addInitScript(([ref, s, size]) => {
    try {
      localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s));
      if (size) localStorage.setItem("ss.pageSize.contacts", String(size));
    } catch (_e) { /* storage blocked */ }
  }, [REF, SESSION, S.pageSize || null]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    const rpc = /\/rest\/v1\/rpc\/([a-z_]+)/.exec(url);
    if (rpc) {
      if (rpc[1] === "is_operator") return json(route, !!S.operator);
      if (rpc[1] === "log_error") return json(route, null);
      return json(route, false);
    }
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: S.operator ? OWN_OPS : TENANT, role: S.role || "owner", user_id: USER.id }]);
    if (url.includes("/rest/v1/")) {
      calls.rest.push({ url, auth: req.headers()["authorization"] || "", prefer: req.headers()["prefer"] || "" });
      // H: a later page of contacts that comes back slowly (after the GoHighLevel sync).
      if (S.pageDelay && /\/rest\/v1\/crm_contacts/.test(url) && Number(new URL(url).searchParams.get("offset") || 0) > 0) {
        await new Promise((res) => setTimeout(res, S.pageDelay));
      }
      const { page: rows, headers } = restAnswer(url, req, S);
      return json(route, rows, 200, headers);
    }
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    const fn = /\/functions\/v1\/([a-z0-9-]+)/.exec(url);
    if (fn) calls.fns.push({ fn: fn[1], body });
    if (url.includes("/portal-billing")) {
      return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: { crm: true }, status: "active" }, wallet: null });
    }
    if (url.includes("/sync-design-status")) {
      if (S.syncDelay) await new Promise((res) => setTimeout(res, S.syncDelay));
      return json(route, { statuses: S.syncStatuses || {} });
    }
    if (url.includes("/operator-portal")) {
      if (body.action === "get_portal") return json(route, S.getPortal(body));
      return json(route, { ok: true, clients: [] });
    }
    if (url.includes("/portal-settings")) {
      if (body.action === "status") {
        return json(route, { ok: true, clientId: S.operator ? OWN_OPS : TENANT, role: S.role || "owner", access: S.access || null, prefs: null, configured: false, branding: {} });
      }
      // The record a row's name opens (A14), in crmContactDeal.mjs's shape.
      if (body.action === "crm_record") {
        const c = (S.tables.crm_contacts || []).find((x) => x.id === body.id) || null;
        return json(route, {
          ok: true, kind: body.kind, clientId: TENANT, contact: c && { ...c, phone_digits: (c.phone || "").replace(/\D/g, ""), sms_opt_out_at: null },
          designs: [], orders: [], feed: [], focus: [], team: [], people: [], followers: [],
          sms: { ready: false, from: null, optedOut: false, consented: false },
          build: [], stages: [], delivery: [], repairs: [], isDesign: false,
        });
      }
      return json(route, { ok: true });
    }
    return json(route, { ok: true });
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  // What _redirects does in production: every /portal/<page> is portal.html.
  await page.route(/\/portal\/[a-z]/, (r) => r.fulfill({ status: 200, contentType: "text/html", body: PORTAL_HTML }));
  if (S.artifact) await page.route(/portal\.app\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: S.artifact }));

  await page.goto(`${BASE}/portal/contacts${S.query || ""}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  // The list, with its rows (not the skeleton): a tbody row whose first cell has text.
  const rendered = await page.waitForFunction(() => {
    const t = [...document.querySelectorAll("table")].find((x) => /first seen/i.test(x.tHead ? x.tHead.textContent : ""));
    return !!(t && t.tBodies[0] && [...t.tBodies[0].rows].some((r) => (r.cells[0] && r.cells[0].innerText.trim()) && !r.querySelector("[data-skel], .ss-skel")));
  }, null, { timeout: 30000 }).then(() => true, () => false);
  await page.waitForTimeout(1500);   // the second paint, after sync-design-status
  if (!rendered) {
    // What WAS on screen, so a failure here says why instead of only that.
    await page.screenshot({ path: join(shots, `${label}-not-rendered.png`) }).catch(() => {});
    const text = await page.evaluate(() => document.body.innerText.slice(0, 600)).catch(() => "");
    console.log(`      [${label}] at ${await page.evaluate(() => location.href)}: ${text.replace(/\s+/g, " ")} | errors: ${pageErrors.join(" | ")}`);
  }
  return { page, ctx, calls, pageErrors, rendered, label };
}

// The list as rendered: every row's cells, the chips, the count, and whether Show more is offered.
const snapshot = (page) => page.evaluate(() => {
  const t = [...document.querySelectorAll("table")].find((x) => /first seen/i.test(x.tHead ? x.tHead.textContent : ""));
  const rows = t ? [...t.tBodies[0].rows].map((r) => [...r.cells].map((c) => c.innerText.trim())) : null;
  const chips = [...document.querySelectorAll('[role="group"][aria-label="Filter by status"] button')].map((b) => b.innerText.replace(/\s+/g, " ").trim());
  const title = [...document.querySelectorAll("div")].find((d) => d.innerText === "Contacts" && d.nextElementSibling && d.nextElementSibling.tagName === "SPAN");
  const more = document.querySelector("[data-ss-contacts-more]");
  return {
    rows, chips, count: title ? title.nextElementSibling.innerText.trim() : null,
    tableHtml: t ? t.outerHTML : null, more: more ? more.innerText.replace(/\s+/g, " ").trim() : null,
  };
});
const rowsNamed = (snap, name) => (snap.rows || []).filter((r) => r[0] === name);
const search = async (page, q) => {
  await page.fill('input[aria-label^="Search contacts"]', q);
  await page.waitForTimeout(400);
};
const crmReads = (calls) => calls.rest.filter((c) => /\/rest\/v1\/crm_contacts/.test(c.url));
const qp = (url) => Object.fromEntries(new URL(url).searchParams);

const baseTables = (extra = {}) => ({
  designs: DESIGNS, captured_leads: LEADS, crm_contacts: [...LINKED, ...ONLY, MERGED], ...extra,
});

try {
  // ── A. a builder's own Contacts ─────────────────────────────────────────────────────────
  {
    const r = await run("A", { tables: baseTables(), pageSize: 100 });
    if (!ok("A0 the list rendered", r.rendered)) throw new Error("A: the list never rendered; refusing to report the rest as passes");
    const s = await snapshot(r.page);
    await r.page.screenshot({ path: join(shots, "A-contacts.png"), fullPage: true });
    const names = (s.rows || []).map((row) => row[0]);
    ok("A1 every contact with no design is listed once",
      ["Gale Imported", NAMELESS, "Phoebe Caller", "Max Manual", "Dee Deleted", "Oscar Other"].every((n) => rowsNamed(s, n).length === 1), JSON.stringify(names));
    ok("A2 nobody with a design or visit gets a second row",
      rowsNamed(s, "Pat Example").length === 1 && rowsNamed(s, "Quinn Example").length === 1 && rowsNamed(s, "Lee Browser").length === 1, JSON.stringify(names));
    ok("A3 ten rows in all: 3 people + 1 contactless design + 6 contacts with no design (no tombstone, no lot building)",
      s.rows.length === 10 && !names.includes("Mia Merged"), `${s.rows.length} rows: ${JSON.stringify(names)}`);
    const status = (n) => (rowsNamed(s, n)[0] || [])[5];
    ok("A4 the source reads in plain words",
      status("Gale Imported") === "Imported from GoHighLevel" && status("Phoebe Caller") === "Saved from My Synergy Phone"
      && status("Max Manual") === "Added by hand" && status("Dee Deleted") === "Contact only",
      JSON.stringify(["Gale Imported", "Phoebe Caller", "Max Manual", "Dee Deleted"].map(status)));
    const gale = rowsNamed(s, "Gale Imported")[0] || [];
    ok("A5 a contact row: phone and email, no design count, first seen as both dates, No design yet",
      /gale@example\.test/.test(gale[1]) && /\(512\) 555-0201/.test(gale[1]) && gale[2] === "—" && gale[3] === gale[4] && gale[3] !== "" && /No design yet/.test(gale[6]),
      JSON.stringify(gale));
    ok("A6 newest first by first seen: Phoebe (09-20) above Gale (08-15) above the nameless import (2025)",
      names.indexOf("Phoebe Caller") < names.indexOf("Gale Imported") && names.indexOf("Gale Imported") < names.indexOf(NAMELESS), JSON.stringify(names));
    ok("A7 the Contact only chip counts them", s.chips.some((c) => /^Contact only 6$/.test(c)), JSON.stringify(s.chips));
    ok("A8 the count includes them, and nothing more to show", s.count === "10" && s.more === null, `count=${s.count} more=${s.more}`);
    // The read itself: PostgREST, the caller's token, this tenant's live contacts, newest first, one page.
    const reads = crmReads(r.calls);
    const q = reads[0] ? qp(reads[0].url) : {};
    ok("A9 one bounded read: client_id, live only, first_seen_at desc then id, offset 0 limit 500, exact count",
      reads.length === 1 && q.client_id === `eq.${TENANT}` && q.merged_into === "is.null" && q.order === "first_seen_at.desc,id.desc"
      && q.offset === "0" && q.limit === "500" && /count=exact/.test(reads[0].prefer), JSON.stringify(reads.map((c) => ({ q: qp(c.url), prefer: c.prefer }))));
    ok("A10 under the caller's own token, and no operator route", reads.every((c) => c.auth === `Bearer ${SESSION.access_token}`)
      && !r.calls.fns.some((c) => c.fn === "operator-portal"), JSON.stringify(r.calls.fns.map((c) => c.fn)));
    // Search, the chip, and the name link.
    await search(r.page, "GoHighLevel");
    const sg = await snapshot(r.page);
    ok("A11 search finds them by source", sg.rows.length === 3 && ["Gale Imported", NAMELESS, "Oscar Other"].every((n) => rowsNamed(sg, n).length === 1),
      JSON.stringify(sg.rows.map((x) => x[0])));
    await search(r.page, "max@example");
    const sm = await snapshot(r.page);
    ok("A12 search finds one by email", sm.rows.length === 1 && sm.rows[0][0] === "Max Manual", JSON.stringify(sm.rows.map((x) => x[0])));
    await search(r.page, "");
    await r.page.locator('[role="group"][aria-label="Filter by status"] button', { hasText: "Contact only" }).click();
    await r.page.waitForTimeout(400);
    const sc = await snapshot(r.page);
    ok("A13 the Contact only chip lists exactly those six", sc.rows.length === 6 && sc.rows.every((x) => x[2] === "—"), JSON.stringify(sc.rows.map((x) => x[0])));
    await r.page.locator("table button", { hasText: NAMELESS }).click();
    await r.page.waitForTimeout(600);
    const path = await r.page.evaluate(() => location.pathname);
    ok("A14 a nameless contact's phone is the link to its record", path === `/portal/contacts/c-${cid(202)}`, path);
    ok("A15 no uncaught page errors", r.pageErrors.length === 0, r.pageErrors.join(" | "));
    await r.ctx.close();
  }

  // ── B. thousands: one page at a time ────────────────────────────────────────────────────
  {
    const tables = baseTables({ designs: [...DESIGNS, BULK_DESIGN], crm_contacts: [...LINKED, ...ONLY, MERGED, ...BULK] });
    const r = await run("B", { tables });
    if (!ok("B0 the list rendered", r.rendered)) throw new Error("B: the list never rendered");
    const s1 = await snapshot(r.page);
    // 1209 live contacts. Page one: A's 9 + Bulk 0000-0490. 4 people have a row (Pat, Quinn, Lee,
    // Bulk 0700 by design) and Bulk 0700 is not read yet, so 1209 - 500 - 1 = 708 still to come.
    ok("B1 the first load reads ONE page of 500", crmReads(r.calls).length === 1 && qp(crmReads(r.calls)[0].url).limit === "500",
      JSON.stringify(crmReads(r.calls).map((c) => qp(c.url))));
    ok("B2 count 502 (4 people + the contactless design + 497 contacts) and 708 older still to come",
      s1.count === "502" && /^708 older contacts with no design aren't listed yet\. Show more$/.test(s1.more || ""), `count=${s1.count} more=${s1.more}`);
    await r.page.screenshot({ path: join(shots, "B-first-page.png") });
    await r.page.locator("[data-ss-contacts-more]").screenshot({ path: join(shots, "B-show-more.png") }).catch(() => {});
    await r.page.locator("[data-ss-contacts-more] button", { hasText: "Show more" }).click();
    await r.page.waitForFunction(() => !/Loading…/.test((document.querySelector("[data-ss-contacts-more]") || {}).innerText || ""), null, { timeout: 15000 }).catch(() => {});
    await r.page.waitForTimeout(500);
    const s2 = await snapshot(r.page);
    const reads2 = crmReads(r.calls).map((c) => qp(c.url));
    ok("B3 Show more read the NEXT page (offset 500, limit 500) and stopped: it had 100 new rows",
      reads2.length === 2 && reads2[1].offset === "500" && reads2[1].limit === "500", JSON.stringify(reads2));
    ok("B4 count 1001 and 209 older to come", s2.count === "1001" && /^209 older contacts/.test(s2.more || ""), `count=${s2.count} more=${s2.more}`);
    // They sort past the last page (older than everything listed), so the table goes to the page
    // they start on: row 503 of 1001, page 17 at 30 a page. Staying on page 1 looked like nothing.
    ok("B4b the table moved to the page the added contacts start on",
      rowsNamed(s2, "Bulk Lead 0491").length === 1 && rowsNamed(s2, "Pat Example").length === 0,
      JSON.stringify((s2.rows || []).map((x) => x[0])));
    await search(r.page, "Bulk Lead 0700");
    const s700 = await snapshot(r.page);
    ok("B5 a contact with a design on the second page still has ONE row, its design's",
      s700.rows.length === 1 && s700.rows[0][2] === "1" && !/Contact only|GoHighLevel/.test(s700.rows[0][5]), JSON.stringify(s700.rows));
    await search(r.page, "");
    await r.page.locator("[data-ss-contacts-more] button", { hasText: "Show more" }).click();
    await r.page.waitForFunction(() => !document.querySelector("[data-ss-contacts-more]"), null, { timeout: 15000 }).catch(() => {});
    await r.page.waitForTimeout(400);
    const s3 = await snapshot(r.page);
    const reads3 = crmReads(r.calls).map((c) => qp(c.url));
    ok("B6 the last page (offset 1000) brings everything in and the sentence goes",
      reads3.length === 3 && reads3[2].offset === "1000" && s3.count === "1210" && s3.more === null, `count=${s3.count} more=${s3.more} reads=${JSON.stringify(reads3)}`);
    ok("B7 no read ever asked for more than 500", crmReads(r.calls).every((c) => Number(qp(c.url).limit) <= 500));
    ok("B8 no uncaught page errors", r.pageErrors.length === 0, r.pageErrors.join(" | "));
    await r.ctx.close();
  }

  // ── C. contacts:'own' ───────────────────────────────────────────────────────────────────
  {
    const r = await run("C", { tables: baseTables(), ownScope: true, role: "user", access: { designs: "edit", contacts: "own" }, pageSize: 100 });
    if (!ok("C0 the list rendered", r.rendered)) throw new Error("C: the list never rendered");
    const s = await snapshot(r.page);
    const names = (s.rows || []).map((row) => row[0]);
    ok("C1 a teammate's contact is not listed (RLS answered without it)", !names.includes("Oscar Other"), JSON.stringify(names));
    ok("C2 the unassigned ones they can open are", ["Gale Imported", NAMELESS, "Phoebe Caller", "Max Manual", "Dee Deleted"].every((n) => rowsNamed(s, n).length === 1), JSON.stringify(names));
    const reads = crmReads(r.calls);
    ok("C3 read from PostgREST with their own token, no other route", reads.length === 1 && reads[0].auth === `Bearer ${SESSION.access_token}`
      && !r.calls.fns.some((c) => c.fn === "operator-portal" || (c.fn === "portal-settings" && /contact/.test(String(c.body.action || "")))),
      JSON.stringify(r.calls.fns.map((c) => `${c.fn}:${c.body.action || ""}`)));
    ok("C4 nothing more to show (RLS's total, not the tenant's)", s.more === null && s.count === "9", `count=${s.count} more=${s.more}`);
    ok("C5 no uncaught page errors", r.pageErrors.length === 0, r.pageErrors.join(" | "));
    await r.ctx.close();
  }

  // ── D. an operator's view-as ────────────────────────────────────────────────────────────
  {
    const all = [...LINKED, ...ONLY, ...BULK].sort((a, b) => (a.first_seen_at < b.first_seen_at ? 1 : a.first_seen_at > b.first_seen_at ? -1 : (a.id < b.id ? 1 : -1)));
    // As operator-portal answers: contacts only when the caller asks (withContacts, or a later page).
    const getPortal = (body) => {
      const from = body.contactsFrom || 0;
      const pageRows = all.slice(from, from + 500);
      if (from > 0) return { ok: true, clientId: TENANT, crmContacts: pageRows, crmContactsTotal: all.length };
      return {
        ok: true, clientId: TENANT, companyName: "Acme Sheds",
        designs: [...DESIGNS, BULK_DESIGN], versions: [], capturedLeads: LEADS,
        ...(body.withContacts === true ? { crmContacts: pageRows, crmContactsTotal: all.length } : {}),
      };
    };
    const r = await run("D", { tables: { designs: [], captured_leads: [], crm_contacts: [] }, operator: true, query: `?view=${TENANT}`, getPortal });
    if (!ok("D0 the view-as list rendered", r.rendered)) throw new Error("D: the view-as list never rendered");
    const s1 = await snapshot(r.page);
    ok("D1 the contacts came with get_portal: count 502, 708 older to come",
      s1.count === "502" && /^708 older contacts/.test(s1.more || ""), `count=${s1.count} more=${s1.more}`);
    await r.page.locator("[data-ss-contacts-more] button", { hasText: "Show more" }).click();
    await r.page.waitForFunction(() => !/Loading…/.test((document.querySelector("[data-ss-contacts-more]") || {}).innerText || ""), null, { timeout: 15000 }).catch(() => {});
    await r.page.waitForTimeout(500);
    const s2 = await snapshot(r.page);
    const gp = r.calls.fns.filter((c) => c.fn === "operator-portal" && c.body.action === "get_portal" && c.body.clientId === TENANT);
    ok("D2 Show more asked get_portal for contactsFrom 500", gp.some((c) => c.body.contactsFrom === 500) && s2.count === "1001",
      `count=${s2.count} calls=${JSON.stringify(gp.map((c) => c.body.contactsFrom ?? null))}`);
    ok("D3 the tenant's contacts were never read from PostgREST", !crmReads(r.calls).some((c) => qp(c.url).client_id === `eq.${TENANT}`),
      JSON.stringify(crmReads(r.calls).map((c) => qp(c.url).client_id)));
    // The Pipeline reads get_portal too and shows no contacts, so only the Contacts list asks.
    ok("D5 the first page was asked for by name (withContacts), Show more by page alone",
      gp.some((c) => c.body.withContacts === true && !c.body.contactsFrom) && gp.filter((c) => c.body.contactsFrom > 0).every((c) => c.body.withContacts === undefined),
      JSON.stringify(gp.map((c) => ({ withContacts: c.body.withContacts ?? null, contactsFrom: c.body.contactsFrom ?? null }))));
    ok("D4 no uncaught page errors", r.pageErrors.length === 0, r.pageErrors.join(" | "));
    await r.page.screenshot({ path: join(shots, "D-view-as.png") });
    await r.ctx.close();
  }

  // ── E. no change for a tenant with no contact-only rows ─────────────────────────────────
  {
    const S = { tables: baseTables({ crm_contacts: [...LINKED, MERGED] }) };
    const before = await run("E-before", { ...S, artifact: BEFORE });
    const after = await run("E-after", S);
    const ok0 = ok("E0 both lists rendered", before.rendered && after.rendered, `before=${before.rendered} after=${after.rendered}`);
    if (!ok0) throw new Error("E: a list never rendered");
    const sb = await snapshot(before.page);
    const sa = await snapshot(after.page);
    ok("E1 the same rows, cell for cell", JSON.stringify(sa.rows) === JSON.stringify(sb.rows),
      `before=${JSON.stringify(sb.rows)} after=${JSON.stringify(sa.rows)}`);
    ok("E2 the same table markup, byte for byte", sa.tableHtml === sb.tableHtml, `${sb.tableHtml?.length} vs ${sa.tableHtml?.length} chars`);
    ok("E3 the same chips and count", JSON.stringify(sa.chips) === JSON.stringify(sb.chips) && sa.count === sb.count, `before=${sb.count} ${JSON.stringify(sb.chips)} after=${sa.count} ${JSON.stringify(sa.chips)}`);
    ok("E4 no Show more", sa.more === null, sa.more || "");
    ok("E5 the new list did read contacts (so the sameness is not because it skipped them)", crmReads(after.calls).length === 1);
    ok("E6 no uncaught page errors", before.pageErrors.length === 0 && after.pageErrors.length === 0, [...before.pageErrors, ...after.pageErrors].join(" | "));
    console.log(`      (${sa.rows.length} rows compared: ${JSON.stringify(sa.rows.map((x) => x[0]))})`);
    await before.ctx.close(); await after.ctx.close();
  }

  // ── F. the control: the artifact before this change cannot pass A ───────────────────────
  {
    const r = await run("F", { tables: baseTables(), artifact: BEFORE, pageSize: 100 });
    if (!ok("F0 the old list rendered", r.rendered)) throw new Error("F: the old list never rendered");
    const s = await snapshot(r.page);
    const names = (s.rows || []).map((row) => row[0]);
    ok("F1 before this change none of A's six contacts was listed (A1 can fail)",
      ["Gale Imported", NAMELESS, "Phoebe Caller", "Max Manual", "Dee Deleted", "Oscar Other"].every((n) => !names.includes(n)), JSON.stringify(names));
    await r.ctx.close();
  }

  // ── G. a visit linked to a contact that is gone never hides the last ones ───────────────
  // captured_leads.contact_id has no foreign key, and production has such rows. 502 live contacts,
  // two visits pointing at contacts that do not exist: after page one, "older contacts with no
  // design" works out to 502 - 500 - 2 = 0, though Bulk 0491 and 0492 are still unread. Show more
  // must still be offered, and must bring them in.
  {
    const gone = [
      { client_id: TENANT, id: 91, name: "Gone One", phone: "+15125550191", phone_digits: "15125550191", email: null, source: "gate", created_at: "2026-09-03T15:00:00Z", updated_at: "2026-09-03T15:00:00Z", contact_id: cid(99001) },
      { client_id: TENANT, id: 92, name: "Gone Two", phone: "+15125550192", phone_digits: "15125550192", email: null, source: "gate", created_at: "2026-09-04T15:00:00Z", updated_at: "2026-09-04T15:00:00Z", contact_id: cid(99002) },
    ];
    const tables = baseTables({ captured_leads: [...LEADS, ...gone], crm_contacts: [...LINKED, ...ONLY, MERGED, ...BULK.slice(0, 493)] });
    const r = await run("G", { tables });
    if (!ok("G0 the list rendered", r.rendered)) throw new Error("G: the list never rendered");
    const s1 = await snapshot(r.page);
    ok("G1 contacts still unread, so Show more is offered (without a count it can't know)",
      /^Some older contacts aren't loaded yet\. Show more$/.test(s1.more || ""), `count=${s1.count} more=${s1.more}`);
    await r.page.locator("[data-ss-contacts-more] button", { hasText: "Show more" }).click();
    await r.page.waitForFunction(() => !document.querySelector("[data-ss-contacts-more]"), null, { timeout: 15000 }).catch(() => {});
    await r.page.waitForTimeout(400);
    const s2 = await snapshot(r.page);
    await search(r.page, "Bulk Lead 049");
    const s3 = await snapshot(r.page);
    const n = (x) => rowsNamed(s3, x).length;
    ok("G2 Show more brought the last two in, once each, and the sentence went",
      s2.more === null && n("Bulk Lead 0491") === 1 && n("Bulk Lead 0492") === 1, `more=${s2.more} rows=${JSON.stringify((s3.rows || []).map((x) => x[0]))}`);
    ok("G3 no uncaught page errors", r.pageErrors.length === 0, r.pageErrors.join(" | "));
    await r.ctx.close();
  }

  // ── H. Show more pressed while the GoHighLevel sync is still running ────────────────────
  // The owner's list paints twice: cached statuses, then the sync's. Show more pressed between the
  // two, whose page lands after the sync, must repaint from the NEWEST paint: Quinn's design moved
  // to Accepted in the sync and must stay Accepted, not go back to the cached Sent.
  {
    const tables = baseTables({ designs: [...DESIGNS, BULK_DESIGN], crm_contacts: [...LINKED, ...ONLY, MERGED, ...BULK] });
    const r = await run("H", { tables, syncDelay: 4000, syncStatuses: { "SS-QUI0001A": "accepted" }, pageDelay: 6000 });
    if (!ok("H0 the list rendered", r.rendered)) throw new Error("H: the list never rendered");
    const quinn = async () => { await search(r.page, "Quinn Example"); const x = await snapshot(r.page); await search(r.page, ""); return ((x.rows || [])[0] || [])[5]; };
    const before = await quinn();
    await r.page.locator("[data-ss-contacts-more] button", { hasText: "Show more" }).click();
    await r.page.waitForFunction(() => /^209 older/.test(((document.querySelector("[data-ss-contacts-more]") || {}).innerText || "").trim()), null, { timeout: 20000 }).catch(() => {});
    await r.page.waitForTimeout(500);
    const s2 = await snapshot(r.page);
    const after = await quinn();
    const syncs = r.calls.fns.filter((c) => c.fn === "sync-design-status").length;
    ok("H1 the press landed before the sync (Quinn still Sent), the page after it", before === "Sent" && syncs >= 1, `before=${before} syncs=${syncs}`);
    ok("H2 after Show more Quinn keeps the synced status, and the page was added", after === "Accepted" && s2.count === "1001", `after=${after} count=${s2.count} more=${s2.more}`);
    ok("H3 no uncaught page errors", r.pageErrors.length === 0, r.pageErrors.join(" | "));
    await r.ctx.close();
  }
} finally {
  await browser.close();
}

console.log(`\nshots: ${shots}`);
const bad = failed();
if (bad.length) { console.log(`\ncontactsWithoutDesign: ${bad.length} FAILED`); process.exit(1); }
console.log("all checks held");
