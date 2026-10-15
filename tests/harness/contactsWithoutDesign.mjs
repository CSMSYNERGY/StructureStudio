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
//   I  THE COMPANY (Carolyn 2026-10-14: a lead entered with a company was listed under the person's
//      name alone). Every row kind leads with its contact's company, the person under it: a contact
//      with no design, a design (from crm_contacts by contact_id, never the design's blob), a browsing
//      visit, a design whose contact sits on a page not read yet. Search finds a row by company and a
//      search that matches nothing hides it; sorting by Customer sorts on what the cell shows; the
//      second line sits under the head at desktop and phone widths. The control (the artifact before
//      this change) shows none of it. THE COMPANY READ IS BOUNDED BY THE ROWS THAT NEED IT: none when
//      every linked contact is on the page; with 1200 imported contacts that ALL have a company, one
//      request for the one design contact the page lacks; it never holds up the first paint (the row
//      shows the name, then its company); and a Refresh keeps the company on screen while the read
//      runs, then shows the read's answer.
//   J  view-as: the companies come with get_portal's first page (crmContactCompanies: those of the
//      linked contacts the page lacks), and an operator-portal from before them (no companies
//      anywhere) still lists every row by name.
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
import { launch, reporter, BASE, REF, shotsDir, serveAppRoutes, legacyAppPath } from "./lib.mjs";

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
    if (u.searchParams.get("company") === "not.is.null") rows = rows.filter((r) => r.company != null);
    const inIds = /^in\.\((.*)\)$/.exec(u.searchParams.get("id") || "");
    if (inIds) { const want = new Set(inIds[1].split(",").map((x) => x.replace(/^"|"$/g, ""))); rows = rows.filter((r) => want.has(r.id)); }
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
      // I: a company read (any shape: the targeted one, or a read of every contact that has one),
      // answered late.
      if (S.companyDelay && isCompanyRead({ url })) {
        await new Promise((res) => setTimeout(res, S.companyDelay));
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
  // What _redirects does in production: every app address is portal.html (and an old /portal one 301s).
  // An older artifact (the "before" runs) reads /portal addresses only: it gets the host as it was.
  await serveAppRoutes(page, PORTAL_HTML, { legacy: !!S.artifact });
  if (S.artifact) await page.route(/portal\.app\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: S.artifact }));

  await page.goto(`${BASE}${S.artifact ? legacyAppPath("/contacts/people") : "/contacts/people"}${S.query || ""}`, { waitUntil: "domcontentloaded" });
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
  // The Customer cell's two lines: what it leads with, and the person under it (null when none).
  const heads = t ? [...t.tBodies[0].rows].map((r) => (r.cells[0] ? r.cells[0].innerText.trim().split("\n")[0] : "")) : null;
  const persons = t ? [...t.tBodies[0].rows].map((r) => { const p = r.cells[0] && r.cells[0].querySelector("[data-ss-contact-person]"); return p ? p.innerText.trim() : null; }) : null;
  const chips = [...document.querySelectorAll('[role="group"][aria-label="Filter by status"] button')].map((b) => b.innerText.replace(/\s+/g, " ").trim());
  const title = [...document.querySelectorAll("div")].find((d) => d.innerText === "Contacts" && d.nextElementSibling && d.nextElementSibling.tagName === "SPAN");
  const more = document.querySelector("[data-ss-contacts-more]");
  return {
    rows, heads, persons, chips, count: title ? title.nextElementSibling.innerText.trim() : null,
    tableHtml: t ? t.outerHTML : null, more: more ? more.innerText.replace(/\s+/g, " ").trim() : null,
  };
});
const rowsNamed = (snap, name) => (snap.rows || []).filter((r) => r[0] === name);
const search = async (page, q) => {
  await page.fill('input[aria-label^="Search contacts"]', q);
  await page.waitForTimeout(400);
};
const qp = (url) => Object.fromEntries(new URL(url).searchParams);
// The list's pages of contacts, and (I) the company reads: `id, company` of named contacts only.
const isCompanyRead = (c) => /\/rest\/v1\/crm_contacts/.test(c.url) && (qp(c.url).company === "not.is.null" || /^in\./.test(qp(c.url).id || ""));
const crmReads = (calls) => calls.rest.filter((c) => /\/rest\/v1\/crm_contacts/.test(c.url) && !isCompanyRead(c));
const companyReads = (calls) => calls.rest.filter(isCompanyRead);
// The ids a company read asked for.
const askedIds = (c) => { const m = /^in\.\((.*)\)$/.exec(qp(c.url).id || ""); return m ? m[1].split(",").map((x) => x.replace(/^"|"$/g, "")) : []; };

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
    ok("A9b and NO company read: every contact a design or a visit links to is on that page",
      companyReads(r.calls).length === 0, JSON.stringify(companyReads(r.calls).map((c) => qp(c.url))));
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
    ok("A14 a nameless contact's phone is the link to its record", path === `/contacts/c-${cid(202)}`, path);
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
      && companyReads(r.calls).every((c) => c.auth === `Bearer ${SESSION.access_token}`)
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
    ok("D3 the tenant's contacts were never read from PostgREST", ![...crmReads(r.calls), ...companyReads(r.calls)].some((c) => qp(c.url).client_id === `eq.${TENANT}`),
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

  // ── I. the company leads the row ────────────────────────────────────────────────────────
  // Fictional companies only (the repo is public). Pat's newer design blob carries a company of its
  // own that crm_contacts does not: the list must show crm_contacts' and never the blob's.
  const COMPANY = {
    [cid(204)]: "Example Barn Co.",         // Max Manual: added by hand, no design (Carolyn's case)
    [CP]: "Sample Shed Works",              // Pat: two designs
    [CL]: "Example Outbuildings",           // Lee: a browsing visit
    [cid(202)]: "Nameless Barn Supply",     // the nameless import: the company, no second line
    [CQ]: "   ",                            // Quinn: spaces are no company
    [cid(10700)]: "Faraway Barn Co.",       // Bulk 0700: a design whose contact is on page two
  };
  const withCompanies = (rows) => rows.map((c) => (COMPANY[c.id] !== undefined ? { ...c, company: COMPANY[c.id] } : c));
  const STALE = "Stale Blob Barns";
  const designsWithBlob = DESIGNS.map((d) => (d.short_code === "SS-PAT0002A" ? { ...d, contact: { ...d.contact, company: STALE } } : d));
  const companyTables = (extra = {}) => baseTables({ designs: designsWithBlob, crm_contacts: withCompanies([...LINKED, ...ONLY, MERGED]), ...extra });
  let phoneScroll = null;   // I's sideways page scroll at phone width, for I26
  const rowOf = (snap, head) => {
    const i = (snap.heads || []).indexOf(head);
    return i < 0 ? null : { head, person: snap.persons[i], cells: snap.rows[i], n: snap.heads.filter((h) => h === head).length };
  };
  {
    const r = await run("I", { tables: companyTables(), pageSize: 100 });
    if (!ok("I0 the list rendered", r.rendered)) throw new Error("I: the list never rendered");
    const s = await snapshot(r.page);
    await r.page.screenshot({ path: join(shots, "I-company.png"), fullPage: true });
    const max = rowOf(s, "Example Barn Co.");
    ok("I1 a contact added by hand with a company: the company leads, the person under it, still Added by hand",
      max && max.n === 1 && max.person === "Max Manual" && max.cells[5] === "Added by hand" && !s.heads.includes("Max Manual"),
      JSON.stringify(max));
    const pat = rowOf(s, "Sample Shed Works");
    ok("I2 a design's row takes its contact's company (crm_contacts by contact_id), never the design's blob",
      pat && pat.n === 1 && pat.person === "Pat Example" && pat.cells[2] === "2" && !s.tableHtml.includes(STALE),
      JSON.stringify(pat));
    const lee = rowOf(s, "Example Outbuildings");
    ok("I3 a browsing visit's row takes its contact's company",
      lee && lee.n === 1 && lee.person === "Lee Browser" && /^Browsing/.test(lee.cells[5]), JSON.stringify(lee));
    const nameless = rowOf(s, "Nameless Barn Supply");
    ok("I4 a company with no person: the company alone (no second line), the phone stays in Contact",
      nameless && nameless.person === null && /\(512\) 555-0202/.test(nameless.cells[1]) && !s.heads.includes(NAMELESS), JSON.stringify(nameless));
    const quinn = rowOf(s, "Quinn Example");
    ok("I5 a company of only spaces is no company: the name leads, no second line", quinn && quinn.person === null, JSON.stringify(quinn));
    const plain = rowOf(s, "Gale Imported");
    ok("I6 a contact with no company is unchanged: the name, no second line", plain && plain.person === null, JSON.stringify(plain));
    ok("I7 the same ten rows as A, no row added or lost", s.rows.length === 10 && s.count === "10", `${s.rows.length} rows, count ${s.count}: ${JSON.stringify(s.heads)}`);
    // The head is still the record link.
    const link = await r.page.locator("table button", { hasText: "Example Barn Co." }).count();
    ok("I8 the company is the link to the record", link === 1, `buttons=${link}`);
    // Search.
    const ph = await r.page.getAttribute('input[aria-label^="Search contacts"]', "placeholder");
    ok("I9 the search box says it searches company", /company/i.test(ph || ""), ph);
    await search(r.page, "example barn");
    const s1 = await snapshot(r.page);
    ok("I10 search by company finds the row", s1.rows && s1.rows.length === 1 && s1.heads[0] === "Example Barn Co." && s1.persons[0] === "Max Manual", JSON.stringify(s1.heads));
    await search(r.page, "sample shed");
    const s2 = await snapshot(r.page);
    ok("I11 search by a design row's company finds that person's row", s2.rows && s2.rows.length === 1 && s2.heads[0] === "Sample Shed Works", JSON.stringify(s2.heads));
    await search(r.page, "Max Manual");
    const s3 = await snapshot(r.page);
    ok("I12 search by the person under a company still finds the row", s3.rows && s3.rows.length === 1 && s3.heads[0] === "Example Barn Co.", JSON.stringify(s3.heads));
    await search(r.page, "Zzyzx Barns");
    const s4 = await snapshot(r.page);
    const none = await r.page.evaluate(() => /No contacts match/.test(document.body.innerText));
    ok("I13 a search no company or name matches hides every row", s4.rows === null && none, `rows=${JSON.stringify(s4.rows)} message=${none}`);
    await search(r.page, STALE);
    const s5 = await snapshot(r.page);
    ok("I14 the design blob's stale company finds nothing", s5.rows === null, JSON.stringify(s5.heads));
    await search(r.page, "");
    // Sorting by Customer sorts on what the cell shows: companies among names, blanks last.
    const th = r.page.locator("table thead th", { hasText: "Customer" });
    await th.click(); await r.page.waitForTimeout(300);
    const asc = (await snapshot(r.page)).heads;
    const want = ["Dee Deleted", "Example Barn Co.", "Example Outbuildings", "Gale Imported", "Nameless Barn Supply", "Oscar Other", "Phoebe Caller", "Quinn Example", "Sample Shed Works", "—"];
    ok("I15 Customer A to Z sorts by the company where one leads", JSON.stringify(asc) === JSON.stringify(want), JSON.stringify(asc));
    await th.click(); await r.page.waitForTimeout(300);
    const desc = (await snapshot(r.page)).heads;
    ok("I16 Customer Z to A is the reverse, the blank row still last",
      JSON.stringify(desc) === JSON.stringify([...want.slice(0, -1)].reverse().concat("—")), JSON.stringify(desc));
    // The second line sits under the company, where the company starts, at desktop and at phone
    // width; the dot is level with the company; nothing spills out of the cell.
    const geometry = () => r.page.evaluate(() => {
      const out = [];
      document.querySelectorAll("[data-ss-contact-person]").forEach((p) => {
        const cell = p.closest("td");
        const btn = cell && cell.querySelector("button");
        const dot = cell && cell.querySelector("span[title]");
        if (!btn || !btn.firstChild || btn.firstChild.nodeType !== 3) { out.push(null); return; }
        const range = document.createRange();
        range.selectNodeContents(btn.firstChild);
        const lines = [...range.getClientRects()];
        const head = range.getBoundingClientRect();
        const pr = p.getBoundingClientRect();
        const dr = dot ? dot.getBoundingClientRect() : null;
        const dotMid = dr ? (dr.top + dr.bottom) / 2 : null;
        out.push({
          person: p.innerText.trim(),
          leftGap: Math.round(Math.abs(pr.left - head.left)),
          below: pr.top >= head.bottom - 1,
          // On the company's first line, or (narrow) on a line of its own above it.
          dotLevel: dotMid !== null && lines.length > 0 && ((dotMid >= lines[0].top && dotMid <= lines[0].bottom) || dr.bottom <= lines[0].top + 1),
          dotBeside: dotMid !== null && lines.length > 0 && dotMid >= lines[0].top && dotMid <= lines[0].bottom,
          spill: cell.scrollWidth - cell.clientWidth,
        });
      });
      return { cells: out, pageScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    const g1 = await geometry();
    ok("I17 desktop: each person line starts under its company, below it, the dot beside the company, nothing spills",
      g1.cells.length === 3 && g1.cells.every((c) => c && c.leftGap <= 1 && c.below && c.dotBeside && c.spill <= 0) && g1.pageScroll <= 0,
      JSON.stringify(g1));
    await r.page.setViewportSize({ width: 375, height: 800 });
    await r.page.waitForTimeout(500);
    const g2 = await geometry();
    phoneScroll = g2.pageScroll;
    await r.page.screenshot({ path: join(shots, "I-company-375.png"), fullPage: false });
    ok("I18 phone width: still under the company where it starts, the dot level with it or above, nothing spills",
      g2.cells.length === 3 && g2.cells.every((c) => c && c.leftGap <= 1 && c.below && c.dotLevel && c.spill <= 0),
      JSON.stringify(g2));
    ok("I19 no uncaught page errors", r.pageErrors.length === 0, r.pageErrors.join(" | "));
    await r.ctx.close();
  }
  // A design whose contact is on a page the list has not read: the company is there on first load.
  // Every one of the 1200 bulk contacts has a company too, as an imported call list (Pipelines'
  // Import CSV) would give them: the company read must still ask for the ONE contact it needs, not
  // page through every contact that has a company.
  const importedCompanies = (rows) => rows.map((c) => (/^Bulk Lead/.test(c.name || "") && c.id !== cid(10700) ? { ...c, company: `Prospect Barns ${c.name.slice(10)}` } : c));
  const laterTables = () => companyTables({ designs: [...designsWithBlob, BULK_DESIGN], crm_contacts: importedCompanies(withCompanies([...LINKED, ...ONLY, MERGED, ...BULK])) });
  const faraway = async (page, q = "Faraway") => { await search(page, q); const x = await snapshot(page); await search(page, ""); return x; };
  {
    const r = await run("I-later-page", { tables: laterTables() });
    if (!ok("I20 the list rendered", r.rendered)) throw new Error("I-later-page: the list never rendered");
    const s1 = await snapshot(r.page);
    const s2 = await faraway(r.page);
    ok("I21 before Show more, Bulk 0700's design row leads with its company (its contact is on page two)",
      /^708 older/.test(s1.more || "") && s2.rows && s2.rows.length === 1 && s2.heads[0] === "Faraway Barn Co." && s2.persons[0] === "Bulk Lead 0700" && s2.rows[0][2] === "1",
      `more=${s1.more} rows=${JSON.stringify(s2.rows)}`);
    const co = companyReads(r.calls);
    const cq = co[0] ? qp(co[0].url) : {};
    ok("I22 1200 contacts with a company, ONE company read, for the ONE linked contact the page lacks",
      crmReads(r.calls).length === 1 && co.length === 1 && JSON.stringify(askedIds(co[0])) === JSON.stringify([cid(10700)]),
      `pages=${crmReads(r.calls).length} companies=${JSON.stringify(co.map(askedIds))}`);
    ok("I22b that read is id and company only, this tenant's live contacts that have one, under the caller's token",
      cq.select === "id,company" && cq.client_id === `eq.${TENANT}` && cq.merged_into === "is.null" && cq.company === "not.is.null"
      && !("offset" in cq) && co[0].auth === `Bearer ${SESSION.access_token}`, JSON.stringify(cq));
    // (Searched by company, then picked out by its head: a four-digit number also matches the ids
    // and phones of other bulk rows, so the search alone does not narrow to one.)
    const imported = rowOf(await faraway(r.page, "Prospect Barns 0001"), "Prospect Barns 0001");
    ok("I22c an imported contact on the page leads with its own row's company",
      imported && imported.n === 1 && imported.person === "Bulk Lead 0001", JSON.stringify(imported));
    ok("I23 no uncaught page errors", r.pageErrors.length === 0, r.pageErrors.join(" | "));
    await r.ctx.close();
  }
  // The company read never holds up the first paint: answered 5 s late, the list is on screen with
  // the person's name, and the company arrives with the read.
  {
    const S = { tables: laterTables(), companyDelay: 5000 };
    const r = await run("I-paint-first", S);
    if (!ok("I27 the list rendered", r.rendered)) throw new Error("I-paint-first: the list never rendered");
    await search(r.page, "Bulk Lead 0700");
    const early = await snapshot(r.page);
    const asked = companyReads(r.calls).length;
    // Then the read answers, and the row takes its company without a reload.
    const arrived = await r.page.waitForFunction(() => {
      const t = [...document.querySelectorAll("table")].find((x) => /first seen/i.test(x.tHead ? x.tHead.textContent : ""));
      const row = t && t.tBodies[0] && t.tBodies[0].rows[0];
      return !!(row && row.cells[0] && row.cells[0].innerText.trim().split("\n")[0] === "Faraway Barn Co.");
    }, null, { timeout: 15000 }).then(() => true, () => false);
    const late = await snapshot(r.page);
    await search(r.page, "");
    ok("I28 painted before the company read answered: the row shows the name, then its company",
      asked === 1 && early.heads && early.heads[0] === "Bulk Lead 0700" && early.persons[0] === null
      && arrived && late.heads[0] === "Faraway Barn Co." && late.persons[0] === "Bulk Lead 0700",
      `asked=${asked} early=${JSON.stringify(early.heads)} arrived=${arrived} late=${JSON.stringify(late.heads)}`);
    ok("I29 no uncaught page errors", r.pageErrors.length === 0, r.pageErrors.join(" | "));
    await r.ctx.close();
  }
  // A Refresh keeps the company on screen while its read runs (no drop back to the name), then
  // shows what the read answered: a company renamed since is shown renamed.
  {
    const S = { tables: laterTables() };
    const r = await run("I-refresh", S);
    if (!ok("I30 the list rendered", r.rendered)) throw new Error("I-refresh: the list never rendered");
    await search(r.page, "Bulk Lead 0700");
    const head = () => r.page.evaluate(() => {
      const t = [...document.querySelectorAll("table")].find((x) => /first seen/i.test(x.tHead ? x.tHead.textContent : ""));
      const row = t && t.tBodies[0] && t.tBodies[0].rows[0];
      return row && row.cells[0] ? row.cells[0].innerText.trim().split("\n")[0] : null;
    });
    const first = await head();
    S.companyDelay = 4000;
    S.tables.crm_contacts = S.tables.crm_contacts.map((c) => (c.id === cid(10700) ? { ...c, company: "Renamed Barn Co." } : c));
    const refresh = r.page.locator("button", { hasText: "↻ Refresh" });
    const n = await refresh.count();
    const readsBefore = companyReads(r.calls).length;
    await refresh.first().click();
    const seen = [];
    for (let i = 0; i < 30; i++) { seen.push(await head()); await r.page.waitForTimeout(100); }
    await r.page.waitForTimeout(4000);
    const last = await head();
    ok("I31 during the Refresh's company read the row kept its company, never the bare name",
      n === 1 && first === "Faraway Barn Co." && companyReads(r.calls).length === readsBefore + 1
      && seen.every((h) => h === "Faraway Barn Co." || h === null) && seen.includes("Faraway Barn Co."),
      `refresh buttons=${n} first=${first} seen=${JSON.stringify([...new Set(seen)])}`);
    ok("I32 then the read's answer: the renamed company", last === "Renamed Barn Co.", String(last));
    ok("I33 no uncaught page errors", r.pageErrors.length === 0, r.pageErrors.join(" | "));
    await r.ctx.close();
  }
  // The control: the artifact before this change shows none of the companies, so I1 to I4 can fail.
  {
    const r = await run("I-control", { tables: companyTables(), artifact: BEFORE, pageSize: 100 });
    if (!ok("I24 the old list rendered", r.rendered)) throw new Error("I-control: the old list never rendered");
    const s = await snapshot(r.page);
    ok("I25 before this change no company was shown", !["Example Barn Co.", "Sample Shed Works", "Example Outbuildings", "Nameless Barn Supply"].some((c) => s.tableHtml.includes(c)),
      JSON.stringify(s.heads));
    // The page's own sideways scroll at phone width (the date filter is wider than a phone) is the
    // same before and after: the company line adds none.
    await r.page.setViewportSize({ width: 375, height: 800 });
    await r.page.waitForTimeout(500);
    const beforeScroll = await r.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok("I26 phone width: the page scrolls sideways no further than before this change",
      phoneScroll !== null && phoneScroll <= beforeScroll, `after=${phoneScroll} before=${beforeScroll}`);
    await r.ctx.close();
  }

  // ── J. view-as: the companies come with get_portal; an older operator-portal degrades ────
  {
    const contacts = withCompanies([...LINKED, ...ONLY]).sort((a, b) => (a.first_seen_at < b.first_seen_at ? 1 : a.first_seen_at > b.first_seen_at ? -1 : (a.id < b.id ? 1 : -1)));
    // As operator-portal answers: the companies of the linked contacts the page lacks. Every one is
    // on this page, so none (the rows take their companies from the page's own rows).
    const companies = [];
    const portal = (withCo) => (body) => ({
      ok: true, clientId: TENANT, companyName: "Acme Sheds",
      designs: designsWithBlob, versions: [], capturedLeads: LEADS,
      ...(body.withContacts === true ? {
        // An operator-portal from before this change sends neither the column nor the list.
        crmContacts: withCo ? contacts : contacts.map(({ company: _c, ...rest }) => rest),
        crmContactsTotal: contacts.length,
        ...(withCo ? { crmContactCompanies: companies } : {}),
      } : {}),
    });
    const r = await run("J", { tables: { designs: [], captured_leads: [], crm_contacts: [] }, operator: true, query: `?view=${TENANT}`, getPortal: portal(true), pageSize: 100 });
    if (!ok("J0 the view-as list rendered", r.rendered)) throw new Error("J: the view-as list never rendered");
    const s = await snapshot(r.page);
    const pat = rowOf(s, "Sample Shed Works"), max = rowOf(s, "Example Barn Co."), lee = rowOf(s, "Example Outbuildings");
    ok("J1 view-as: design, visit and contact-only rows lead with their companies",
      pat && pat.person === "Pat Example" && max && max.person === "Max Manual" && lee && lee.person === "Lee Browser" && !s.tableHtml.includes(STALE),
      JSON.stringify(s.heads));
    ok("J2 view-as never read the tenant's contacts from PostgREST",
      ![...crmReads(r.calls), ...companyReads(r.calls)].some((c) => qp(c.url).client_id === `eq.${TENANT}`));
    await r.page.screenshot({ path: join(shots, "J-view-as-company.png") });
    ok("J3 no uncaught page errors", r.pageErrors.length === 0, r.pageErrors.join(" | "));
    await r.ctx.close();
    const old = await run("J-old", { tables: { designs: [], captured_leads: [], crm_contacts: [] }, operator: true, query: `?view=${TENANT}`, getPortal: portal(false), pageSize: 100 });
    if (!ok("J4 the view-as list rendered against an older operator-portal", old.rendered)) throw new Error("J-old: the view-as list never rendered");
    const so = await snapshot(old.page);
    ok("J5 older operator-portal: every row listed by name, no company, no second line",
      so.rows.length === 10 && ["Pat Example", "Max Manual", "Lee Browser", NAMELESS].every((n) => so.heads.includes(n)) && so.persons.every((p) => p === null),
      JSON.stringify(so.heads));
    ok("J6 no uncaught page errors", old.pageErrors.length === 0, old.pageErrors.join(" | "));
    await old.ctx.close();
    // View-as with a design whose contact is past the first page: get_portal sends that contact's
    // company (and only that one), and the design row leads with it.
    const all = importedCompanies(withCompanies([...LINKED, ...ONLY, ...BULK]))
      .sort((a, b) => (a.first_seen_at < b.first_seen_at ? 1 : a.first_seen_at > b.first_seen_at ? -1 : (a.id < b.id ? 1 : -1)));
    const designsLater = [...designsWithBlob, BULK_DESIGN];
    const getPortal = (body) => {
      const from = body.contactsFrom || 0;
      const pageRows = all.slice(from, from + 500);
      if (from > 0) return { ok: true, clientId: TENANT, crmContacts: pageRows, crmContactsTotal: all.length };
      const onPage = new Set(pageRows.map((c) => c.id));
      const need = [...new Set([...designsLater.map((d) => d.contact_id), ...LEADS.map((l) => l.contact_id)].filter((id) => id && !onPage.has(id)))];
      return {
        ok: true, clientId: TENANT, companyName: "Acme Sheds", designs: designsLater, versions: [], capturedLeads: LEADS,
        crmContacts: pageRows, crmContactsTotal: all.length,
        crmContactCompanies: all.filter((c) => need.includes(c.id) && c.company).map((c) => ({ id: c.id, company: c.company })),
      };
    };
    const later = await run("J-later", { tables: { designs: [], captured_leads: [], crm_contacts: [] }, operator: true, query: `?view=${TENANT}`, getPortal });
    if (!ok("J7 the view-as list rendered with a contact past the first page", later.rendered)) throw new Error("J-later: the view-as list never rendered");
    const sl = await faraway(later.page);
    ok("J8 view-as: the design row whose contact is past the first page leads with its company",
      sl.rows && sl.rows.length === 1 && sl.heads[0] === "Faraway Barn Co." && sl.persons[0] === "Bulk Lead 0700", JSON.stringify(sl.heads));
    ok("J9 no uncaught page errors", later.pageErrors.length === 0, later.pageErrors.join(" | "));
    await later.ctx.close();
  }
} finally {
  await browser.close();
}

console.log(`\nshots: ${shots}`);
const bad = failed();
if (bad.length) { console.log(`\ncontactsWithoutDesign: ${bad.length} FAILED`); process.exit(1); }
console.log("all checks held");
