// A card's LINK cells show in its drawer, under the Created line (Support ticket board, Carolyn
// 2026-10-29), driven for real on the COMPILED portal.
//
// The ask: a Support ticket handed off from the assistant carries a "Conversation" link column
// whose value is { url: <console chat address>, text: "Full chat" }. In the grid that cell is easy
// to miss once the card is open, so PMItemPanel now draws every link column of the card in its
// pinned header, http(s) values only, as the same anchor the grid cell uses.
//
//   A  a card whose Conversation value is { url: <a beta console chat>, text: "Full chat" }: the
//      drawer holds exactly one anchor with that href, target=_blank, rel=noreferrer, reading
//      "Full chat", labelled "Conversation:", under the Created line and above the note box.
//   B  cards on the same board with no link value (no key at all, and a null): no such anchor and
//      no "Conversation:" label in the drawer.
//   C  link values that are not http(s): javascript:, a path-relative /console/... and a
//      host-relative //example.test/...: none of them becomes an anchor in the drawer, and no
//      label is drawn for them.
//   D  a link value with a url and no text (the key missing, and text ""): the anchor reads the
//      address without its scheme, cut at 40 characters, and still points at the full address.
//
// Before any of that, the server at SS_BASE is checked to be serving THIS checkout: its
// portal.html carries the same portal.app.compiled.js ?v= as the file on disk, and the compiled
// file it serves hashes to that ?v=. On Windows a second http.server can bind a port that is
// already taken, and every request then goes to the first one, from some other checkout.
//
// Supabase is stubbed at the network layer (no login, nothing leaves the machine), the same shape
// projectsEmptyBoards.mjs uses; the board, the cards and the chat ids are made up (placeholder
// uuids only).
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/projectsItemLinks.mjs        (exit 0 = every check held)
//
// SS_BASE=http://127.0.0.1:<port> points it at a server on another port.
//
// SS_PORTAL_ARTIFACT=<an older portal.app.compiled.js> serves that file instead, which is how to
// prove these checks can fail: against origin/beta 9724a1f6's artifact (before the drawer drew
// link cells) 15 of the 37 fail, all in A and D: the drawer has no anchor at all, so A's href,
// target, rel, text, label and placement never hold (7), and D's shortened address is never drawn
// for either card (4 + 4). Every card still opens there and the grid cell still carries A's link,
// so the failures are the drawer and nothing else. The server checks, B and C pass there, which
// is their point: B and C are the "nothing drawn" half, and the old drawer drew nothing for any card.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, reporter, BASE, REF, serveAppRoutes } from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORTAL_HTML = readFileSync(join(ROOT, "portal.html"), "utf8");
const ARTIFACT = process.env.SS_PORTAL_ARTIFACT ? readFileSync(process.env.SS_PORTAL_ARTIFACT, "utf8") : null;

const CLIENT = "harness-internal";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000007", aud: "authenticated", role: "authenticated", email: "team@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const ACCESS = { designs: "edit", contacts: "edit", orders: "view" };

// ── One made-up Support board ──────────────────────────────────────────────────────────────
const BID = "board-support";
const BOARD = { id: BID, slug: "fictional-support", name: "Fictional Support", position: 0, settings: {}, archived_at: null };
const STATUS_COL = {
  id: `${BID}-status`, board_id: BID, name: "Status", type: "status", position: 0,
  settings: { labels: [{ id: "todo", label: "To do", color: "#64748B" }, { id: "done", label: "Done", color: "#0E9F6E", kind: "done" }] },
};
const CONV_COL = { id: `${BID}-conv`, board_id: BID, name: "Conversation", type: "link", position: 1, settings: {} };

const CHAT_A = "https://beta.structurestudiosuite.com/console/chats?chat=00000000-0000-4000-8000-000000000002";
const CHAT_D = "https://beta.structurestudiosuite.com/console/chats?chat=00000000-0000-4000-8000-000000000004";
const SHORT_D = "beta.structurestudiosuite.com/console/ch";   // CHAT_D without https://, cut at 40
const BAD_JS = "javascript:alert(1)";
const BAD_REL = "/console/chats?chat=00000000-0000-4000-8000-000000000003";
const BAD_HOSTREL = "//example.test/console/chats?chat=00000000-0000-4000-8000-000000000005";

// link: undefined = no key in values at all.
const CARDS = [
  { key: "A", name: "Fictional ticket with a chat", link: { url: CHAT_A, text: "Full chat" } },
  { key: "B", name: "Fictional ticket without a chat", link: undefined },
  { key: "Bnull", name: "Fictional ticket with a cleared link", link: null },
  { key: "Cjs", name: "Fictional script link", link: { url: BAD_JS, text: "Full chat" } },
  { key: "Crel", name: "Fictional path-relative link", link: { url: BAD_REL, text: "Full chat" } },
  { key: "Chost", name: "Fictional host-relative link", link: { url: BAD_HOSTREL, text: "Full chat" } },
  { key: "D", name: "Fictional link without text", link: { url: CHAT_D } },
  { key: "Dempty", name: "Fictional link with empty text", link: { url: CHAT_D, text: "" } },
];
const ITEMS = CARDS.map((c, i) => ({
  id: `${BID}-i${i}`, board_id: BID, group_id: `${BID}-g1`, name: c.name, position: i,
  values: { [STATUS_COL.id]: "todo", ...(c.link !== undefined ? { [CONV_COL.id]: c.link } : {}) },
  created_at: "2026-10-29T15:00:00Z", updated_at: "2026-10-29T15:00:00Z",
}));
const itemOf = (key) => ITEMS[CARDS.findIndex((c) => c.key === key)];

const { ok, failed, results } = reporter();

// ── The server at BASE is this checkout (the Windows double-bind trap) ─────────────────────────
const vOf = (html) => (/portal\.app\.compiled\.js\?v=([a-f0-9]+)/.exec(html) || [])[1] || null;
const localV = vOf(PORTAL_HTML);
let servedHtml = "";
let servedJs = null;
try { servedHtml = await (await fetch(`${BASE}/portal.html`, { cache: "no-store" })).text(); } catch (e) { servedHtml = `fetch failed: ${e.message}`; }
try { servedJs = Buffer.from(await (await fetch(`${BASE}/portal.app.compiled.js`, { cache: "no-store" })).arrayBuffer()); } catch (_e) { servedJs = null; }
const servedV = vOf(servedHtml);
const servedHash = servedJs ? createHash("sha256").update(servedJs).digest("hex").slice(0, 8) : null;
ok(`Server: ${BASE}/portal.html carries this checkout's ?v=${localV}`, !!localV && servedV === localV, `served ?v=${servedV}`);
ok("Server: …and the portal.app.compiled.js it serves hashes to that ?v=", !!servedHash && servedHash === localV, `sha256 ${servedHash}`);
if (ARTIFACT) console.log(`(serving SS_PORTAL_ARTIFACT=${process.env.SS_PORTAL_ARTIFACT} in the browser instead, sha256 ${createHash("sha256").update(ARTIFACT).digest("hex").slice(0, 8)})`);

const { browser, ctx: unused } = await launch({ width: 1400, height: 1000 });
await unused.close();

const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });

const DRAWER = '[role="dialog"][aria-labelledby="pm-item-title"]';

// Opens one card by its name cell, reads the drawer once get_item has answered (the Created line
// is drawn), then closes it again. A card that cannot be opened returns { error }, which fails
// that card's checks below instead of crashing the run.
async function openCard(page, calls, card) {
  const item = itemOf(card.key);
  const before = calls.length;
  try {
    await page.getByTitle("Open notes and updates").filter({ has: page.getByText(card.name, { exact: true }) }).first().click({ timeout: 5000 });
    await page.locator(DRAWER).waitFor({ state: "visible", timeout: 10000 });
    await page.waitForFunction((sel) => { const d = document.querySelector(sel); return !!d && /Created /.test(d.innerText); }, DRAWER, { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(300);
    const r = await page.evaluate((sel) => {
      const d = document.querySelector(sel);
      if (!d) return null;
      const title = d.querySelector("#pm-item-title");
      const created = [...d.querySelectorAll("span")].find((s) => /^Created /.test(s.textContent));
      const noteBox = d.querySelector("textarea");
      const FOLLOWS = Node.DOCUMENT_POSITION_FOLLOWING;
      const anchors = [...d.querySelectorAll("a")].map((a) => {
        const pt = a.parentElement ? a.parentElement.textContent : "";
        return {
          href: a.getAttribute("href"), target: a.getAttribute("target"), rel: a.getAttribute("rel"), text: a.textContent,
          label: pt.endsWith(a.textContent) ? pt.slice(0, pt.length - a.textContent.length).trim() : pt.trim(),
          afterCreated: !!created && !!(created.compareDocumentPosition(a) & FOLLOWS),
          beforeNoteBox: !noteBox || !!(a.compareDocumentPosition(noteBox) & FOLLOWS),
        };
      });
      return {
        title: title ? (title.value != null && title.tagName === "INPUT" ? title.value : title.textContent) : "",
        text: d.innerText, anchors, created: !!created,
      };
    }, DRAWER);
    const gotItem = calls.slice(before).some((c) => c.action === "get_item" && c.body.id === item.id);
    await page.keyboard.press("Escape");
    const closed = await page.waitForFunction((sel) => !document.querySelector(sel), DRAWER, { timeout: 4000 }).then(() => true).catch(() => false);
    if (!closed) {
      await page.locator(DRAWER).getByRole("button", { name: "Close" }).click({ timeout: 3000 }).catch(() => {});
      await page.waitForFunction((sel) => !document.querySelector(sel), DRAWER, { timeout: 4000 }).catch(() => {});
    }
    await page.waitForTimeout(250);
    return { ...(r || { title: "", text: "", anchors: [], created: false }), drawer: !!r, gotItem };
  } catch (e) {
    await page.keyboard.press("Escape").catch(() => {});
    return { error: String(e.message || e).split(/\r?\n/)[0], drawer: false, gotItem: false, title: "", text: "", anchors: [], created: false };
  }
}

const calls = [];   // { action, body, at }
const pageErrors = [];
const t0 = Date.now();
const opened = {};
let gridLinks = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, serviceWorkers: "block" });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
  }, [REF, SESSION]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("dialog", (d) => d.dismiss());

  await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    const rpc = /\/rest\/v1\/rpc\/([a-z_]+)/.exec(url);
    if (rpc) {
      const name = rpc[1];
      if (name === "is_operator") return json(route, false);
      if (name === "is_support_operator") return json(route, false);
      if (name === "can_open_projects") return json(route, true);
      return json(route, false);
    }
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: "user" }]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) {
      return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: {}, status: "active" }, wallet: null });
    }
    if (url.includes("/portal-settings")) {
      if (body.action === "status") return json(route, { ok: true, clientId: CLIENT, role: "user", access: ACCESS, prefs: null, configured: false, branding: {} });
      return json(route, { ok: true });
    }
    if (url.includes("/portal-projects")) {
      if (/[?&]warm=1/.test(url) || !body.action) return json(route, { ok: true });
      calls.push({ action: body.action, body, at: Date.now() - t0 });
      switch (body.action) {
        case "list_boards":
          return json(route, { boards: [BOARD], counts: { [BID]: ITEMS.length }, canWrite: true, columns: {}, people: [] });
        case "get_board":
          if (body.boardId !== BID) return json(route, { error: "Board not found." }, 404);
          return json(route, {
            board: BOARD,
            columns: [STATUS_COL, CONV_COL],
            groups: [{ id: `${BID}-g1`, board_id: BID, name: "Intake", color: "#3D3672", position: 0 }],
            items: ITEMS, people: [], views: [], canWrite: true,
          });
        case "get_item": {
          const item = ITEMS.find((i) => i.id === body.id);
          if (!item) return json(route, { error: "Item not found." }, 404);
          return json(route, {
            item, updates: [], activity: [], submission: null, canWrite: true,
            origin: { createdAt: item.created_at, label: "Added on this board" },
          });
        }
        default:
          return json(route, { ok: true });
      }
    }
    if (url.includes("/functions/v1/")) return json(route, { ok: true });
    return json(route, { ok: true });
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  await serveAppRoutes(page, PORTAL_HTML);
  if (ARTIFACT) await page.route(/portal\.app\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: ARTIFACT }));

  await page.goto(`${BASE}/projects`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  await page.waitForFunction((n) => document.body.innerText.includes(n), CARDS[CARDS.length - 1].name, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(800);
  gridLinks = await page.evaluate((sel) => [...document.querySelectorAll("a")].filter((a) => !a.closest(sel)).map((a) => a.getAttribute("href")), DRAWER);

  for (const card of CARDS) opened[card.key] = await openCard(page, calls, card);
  await ctx.close();
} finally {
  await browser.close();
}

const cardOk = (key) => {
  const r = opened[key];
  const card = CARDS.find((c) => c.key === key);
  return ok(`${key}: the card opens in the drawer and get_item is asked for it`, r.drawer && r.title === card.name && r.gotItem && r.created,
    r.error || `drawer ${r.drawer}, title ${JSON.stringify(r.title)}, get_item ${r.gotItem}, Created line ${r.created}`);
};
const show = (r) => JSON.stringify(r.anchors);
const linkish = (a) => a.text === "Full chat" || /console\/chats/.test(a.href || "") || /^\s*javascript:/i.test(a.href || "");

// ── A ──
{
  const r = opened.A;
  cardOk("A");
  ok("A: the grid's Conversation cell carries the link (the value is on the card)", gridLinks.includes(CHAT_A),
    gridLinks.includes(CHAT_A) ? "" : JSON.stringify(gridLinks));
  const hits = r.anchors.filter((a) => a.href === CHAT_A);
  ok("A: the drawer holds exactly one anchor with the chat's href", hits.length === 1, show(r));
  const a = hits[0] || {};
  ok("A: …opening a new tab (target=_blank)", a.target === "_blank", JSON.stringify(a.target));
  ok("A: …with rel=noreferrer", a.rel === "noreferrer", JSON.stringify(a.rel));
  ok("A: …reading \"Full chat\"", a.text === "Full chat", JSON.stringify(a.text));
  ok("A: …labelled \"Conversation:\"", a.label === "Conversation:", JSON.stringify(a.label));
  ok("A: …under the Created line and above the note box", !!a.afterCreated && !!a.beforeNoteBox, `afterCreated ${a.afterCreated}, beforeNoteBox ${a.beforeNoteBox}`);
  ok("A: no other anchor in the drawer reads \"Full chat\"", r.anchors.filter((x) => x.text === "Full chat").length === 1, show(r));
}

// ── B ──
for (const key of ["B", "Bnull"]) {
  const r = opened[key];
  cardOk(key);
  ok(`${key}: no link anchor in the drawer`, !r.anchors.some(linkish), show(r));
  ok(`${key}: no "Conversation:" label in the drawer`, !/Conversation:/.test(r.text));
}

// ── C ──
for (const [key, bad, what] of [["Cjs", BAD_JS, "a javascript: url"], ["Crel", BAD_REL, "a path-relative url"], ["Chost", BAD_HOSTREL, "a host-relative // url"]]) {
  const r = opened[key];
  cardOk(key);
  ok(`${key}: ${what} is not an anchor in the drawer`, !r.anchors.some((a) => a.href === bad) && !r.anchors.some(linkish), show(r));
  ok(`${key}: …and no "Conversation:" label is drawn for it`, !/Conversation:/.test(r.text));
}

// ── D ──
for (const key of ["D", "Dempty"]) {
  const r = opened[key];
  cardOk(key);
  const hits = r.anchors.filter((a) => a.href === CHAT_D);
  const a = hits[0] || {};
  ok(`${key}: the drawer holds exactly one anchor with the full address`, hits.length === 1, show(r));
  ok(`${key}: …reading the address without its scheme, cut at 40 characters`, a.text === SHORT_D, JSON.stringify(a.text));
  ok(`${key}: …(no https://, at most 40 characters)`, typeof a.text === "string" && !/^https?:/i.test(a.text) && a.text.length > 0 && a.text.length <= 40,
    JSON.stringify(a.text));
  ok(`${key}: …target=_blank, rel=noreferrer, labelled "Conversation:"`, a.target === "_blank" && a.rel === "noreferrer" && a.label === "Conversation:",
    JSON.stringify({ target: a.target, rel: a.rel, label: a.label }));
}

ok("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));

const bad = failed();
console.log(`\n${results.length - bad.length} passed, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
