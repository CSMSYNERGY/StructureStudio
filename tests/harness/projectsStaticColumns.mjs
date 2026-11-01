// CREATED AND REQUESTOR ARE STATIC, driven for real on the COMPILED portal.
//
// The ask (Carolyn 2026-11-01): "I need to see all the dates things were added. this should be a
// static field and not changeable. I also need to see who added it. ... both also say CLIENT ... I
// want the title of it changed to requestor ... I need the created date in Ongoing projects as well
// and all of this in the roadmap and support."
//
// The server now serves two SYNTHETIC columns on every board (_shared/pmSystemColumns.ts) under the
// reserved ids sys_created / sys_requestor, derived from each row, and the browser must treat them
// as facts about the card rather than cells. The board below carries NO Created/Client column of
// its own — it is shaped like the roadmap, which never had either — so everything seen here comes
// from the two synthetic columns alone.
//
//   A  the header reads Created, Requestor, then the board's own columns, and every card shows its
//      own date and requestor: a client report names the submitter, a card the team added names the
//      team member, a roadmap-synced row reads "Roadmap", and a row with no requestor shows "—".
//   B  clicking a Created or Requestor cell opens NO editor, opens no card drawer, and sends no
//      update_item — four cells, both columns.
//   C  the control: clicking the Status cell on the same row DOES open its menu, and picking a
//      label DOES send update_item. So B is these two columns being locked, not a dead grid.
//   D  the Created header does not drag (no draggable attribute) while Status's does, and clicking
//      Created sorts the rows by date — it is a real column that cannot be rearranged or retyped.
//   E  Board settings lists both as filled in automatically, with no rename box and no Delete for
//      either, while the board's own columns keep theirs.
//
// Before any of that, the server at SS_BASE is checked to be serving THIS checkout: its portal.html
// carries the same portal.app.compiled.js ?v= as the file on disk, and the compiled file it serves
// hashes to that ?v=. On Windows a second http.server can bind a port that is already taken, and
// every request then goes to the first one, from some other checkout.
//
// Supabase is stubbed at the network layer (no login, nothing leaves the machine), the same shape
// projectsItemLinks.mjs uses; the board, the cards and the people are made up.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/projectsStaticColumns.mjs   (exit 0 = every check held)
//
// SS_BASE=http://127.0.0.1:<port> points it at a server on another port.
//
// SS_PORTAL_ARTIFACT=<an older portal.app.compiled.js> serves that file instead, which is how to
// prove these checks can fail: against the artifact from before this change (origin/beta c450d5cf)
// 9 of the 40 fail. The grid still DRAWS both columns there — the server sends them — and A, C and
// D's sort all pass, which is the point: what the old build lacks is the locking. Its cells open an
// editor (B, 4), both headers drag (D, 2), and Board settings offers a rename box and a Delete for
// each of them with no "filled in automatically" line (E, 3).
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

// ── One made-up board with NO Created / Client column of its own ────────────────────────────
const BID = "board-fictional-roadmap";
const BOARD = { id: BID, slug: "fictional-roadmap", name: "Fictional Roadmap", position: 0, settings: {}, archived_at: null };
const STATUS_COL = {
  id: `${BID}-status`, board_id: BID, name: "Status", type: "status", position: 1024,
  settings: { labels: [{ id: "todo", label: "To do", color: "#64748B" }, { id: "done", label: "Done", color: "#0E9F6E", kind: "done" }] },
};
const DUE_COL = { id: `${BID}-due`, board_id: BID, name: "Due", type: "date", position: 2048, settings: {} };

// What the server prepends to every board, exactly as pmSystemColumns() builds it.
const SYS_CREATED = { id: "sys_created", name: "Created", type: "date", settings: {}, width: 118, system: true, readOnly: true };
const SYS_REQUESTOR = { id: "sys_requestor", name: "Requestor", type: "text", settings: {}, width: 170, system: true, readOnly: true };

// Each card as the server now answers it: the derived cells already merged into `values`.
const CARDS = [
  { key: "client", name: "Fictional client report", created: "2026-06-20", requestor: "Dave Hall", shown: "Jun 20, 2026" },
  { key: "team", name: "Fictional card the team added", created: "2026-11-01", requestor: "Ahsan", shown: "Nov 1, 2026" },
  { key: "roadmap", name: "Fictional roadmap entry", created: "2026-09-15", requestor: "Roadmap", shown: "Sep 15, 2026" },
  { key: "nobody", name: "Fictional card from nobody", created: "2026-08-27", requestor: null, shown: "Aug 27, 2026" },
];
const ITEMS = CARDS.map((c, i) => ({
  id: `${BID}-i${i}`, board_id: BID, group_id: `${BID}-g1`, name: c.name, position: i * 1024,
  values: { [STATUS_COL.id]: "todo", sys_created: c.created, sys_requestor: c.requestor },
  created_at: `${c.created}T15:00:00Z`, updated_at: `${c.created}T15:00:00Z`,
}));
const itemOf = (key) => ITEMS[CARDS.findIndex((c) => c.key === key)];

const { ok, failed, results } = reporter();

// ── The server at BASE is this checkout (the Windows double-bind trap) ───────────────────────
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

const { browser, ctx: unused } = await launch({ width: 1500, height: 1000 });
await unused.close();

const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });
const DRAWER = '[role="dialog"][aria-labelledby="pm-item-title"]';

const calls = [];   // { action, body }
const pageErrors = [];
let header = [];
let grid = [];          // [{ name, cells: { Created, Requestor, … } }]
let locked = [];        // B's attempts
let control = { menu: false, sent: false };
let drag = { created: null, status: null };
let sortedByCreated = null;
let settings = null;

try {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 }, serviceWorkers: "block" });
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
      calls.push({ action: body.action, body });
      switch (body.action) {
        case "list_boards":
          return json(route, {
            boards: [BOARD], counts: { [BID]: ITEMS.length }, canWrite: true,
            columns: { [BID]: [SYS_CREATED, SYS_REQUESTOR, STATUS_COL, DUE_COL] }, people: [],
          });
        case "get_board":
          if (body.boardId !== BID) return json(route, { error: "Board not found." }, 404);
          return json(route, {
            board: BOARD,
            // The server's order: the two static columns, then the board's own rows.
            columns: [SYS_CREATED, SYS_REQUESTOR, STATUS_COL, DUE_COL],
            groups: [{ id: `${BID}-g1`, board_id: BID, name: "Intake", color: "#3D3672", position: 0, intake: true }],
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
        case "update_item": {
          const item = ITEMS.find((i) => i.id === body.id);
          return json(route, { item: { ...item, values: { ...item.values, ...(body.values || {}) } } });
        }
        case "board_access":
          // The real shape (portal-projects board_access, public board): the modal reads
          // access.people / access.iOwn directly, so a near-miss here is an undefined.map.
          return json(route, { visibility: "everyone", board: BOARD.name, people: [], iOwn: true });
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
  await page.waitForTimeout(600);

  // ── A: the header and every row, read off the rendered table ──────────────────────────────
  const readGrid = () => page.evaluate(() => {
    const table = document.querySelector("table");
    if (!table) return { header: [], grid: [] };
    const header = [...table.querySelectorAll("thead th")].map((th) => th.innerText.replace(/[▲▼↑↓\s]+$/, "").trim());
    const names = header.map((h) => h.toLowerCase());   // the header is UPPERCASED by CSS
    const grid = [...table.querySelectorAll("tbody tr")].map((tr) => {
      const tds = [...tr.querySelectorAll("td")];
      const nameCell = tds.find((td) => td.getAttribute("title") === "Open notes and updates");
      if (!nameCell) return null;
      const from = tds.indexOf(nameCell);
      const cells = {};
      tds.slice(from + 1).forEach((td, i) => { const k = names[from + 1 + i]; if (k) cells[k] = td.innerText.trim(); });
      return { name: nameCell.innerText.trim(), cells };
    }).filter(Boolean);
    return { header: header.map((h) => h.toLowerCase()), grid };
  });
  ({ header, grid } = await readGrid());

  // ── B: the static cells cannot be opened ──────────────────────────────────────────────────
  // Each attempt: click the cell, then look for an editor anywhere in the table, a drawer, and
  // any update_item the click might have sent.
  const cellOf = (rowName, colName) => page.evaluate(([rn, cn]) => {
    const table = document.querySelector("table");
    const header = [...table.querySelectorAll("thead th")].map((th) => th.innerText.replace(/[▲▼↑↓\s]+$/, "").trim().toLowerCase());
    const idx = header.indexOf(cn.toLowerCase());
    const tr = [...table.querySelectorAll("tbody tr")].find((r) => {
      const n = [...r.querySelectorAll("td")].find((td) => td.getAttribute("title") === "Open notes and updates");
      return n && n.innerText.trim() === rn;
    });
    if (!tr || idx < 0) return null;
    const tds = [...tr.querySelectorAll("td")];
    const td = tds[idx];
    if (!td) return null;
    const r = td.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: td.innerText.trim() };
  }, [rowName, colName]);

  for (const [rowKey, colName] of [["client", "Created"], ["client", "Requestor"], ["team", "Created"], ["roadmap", "Requestor"]]) {
    const card = CARDS.find((c) => c.key === rowKey);
    const before = calls.length;
    const box = await cellOf(card.name, colName);
    if (!box) { locked.push({ rowKey, colName, error: "no such cell" }); continue; }
    await page.mouse.click(box.x, box.y);
    await page.waitForTimeout(350);
    const after = await page.evaluate((sel) => ({
      editors: document.querySelectorAll("table input:not([type=checkbox]), table textarea, table select").length,
      drawer: !!document.querySelector(sel),
      menu: [...document.querySelectorAll("table div")].filter((d) => /^(— none|Unassigned)/.test(d.innerText || "")).length,
    }), DRAWER);
    locked.push({
      rowKey, colName, text: box.text, ...after,
      wrote: calls.slice(before).some((c) => c.action === "update_item"),
    });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
  }

  // ── C: the control — the same row's Status cell still edits ───────────────────────────────
  {
    const card = CARDS.find((c) => c.key === "client");
    const before = calls.length;
    const box = await cellOf(card.name, "Status");
    if (box) {
      await page.mouse.click(box.x, box.y);
      await page.waitForTimeout(350);
      // PMChoiceMenu is the box whose first row reads "— none"; clicking "Done" anywhere else
      // on the page would hit the date filter's own Done button.
      control.menu = await page.evaluate(() => {
        const none = [...document.querySelectorAll("button")].find((b) => /^—\s*none$/.test(b.innerText.trim()));
        return !!(none && none.parentElement);
      });
      if (control.menu) {
        await page.evaluate(() => {
          const none = [...document.querySelectorAll("button")].find((b) => /^—\s*none$/.test(b.innerText.trim()));
          const menu = none && none.parentElement;
          const done = menu && [...menu.querySelectorAll("button")].find((b) => b.innerText.trim() === "Done");
          if (done) done.click();
        });
        await page.waitForTimeout(500);
      }
      control.sent = calls.slice(before).some((c) => c.action === "update_item" && c.body.values && c.body.values[STATUS_COL.id] === "done");
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  }

  // ── D: the header does not drag, and it does sort ──────────────────────────────────────────
  drag = await page.evaluate(() => {
    const ths = [...document.querySelectorAll("thead th")];
    const find = (n) => ths.find((th) => th.innerText.replace(/[▲▼↑↓\s]+$/, "").trim().toLowerCase() === n.toLowerCase());
    const attr = (th) => (th ? th.getAttribute("draggable") : "missing th");
    return { created: attr(find("Created")), requestor: attr(find("Requestor")), own: attr(find("Due")) };
  });
  await page.evaluate(() => {
    const th = [...document.querySelectorAll("thead th")].find((t) => /^created/i.test(t.innerText.trim()));
    if (th) (th.querySelector("button") || th).click();
  });
  await page.waitForTimeout(500);
  {
    const g = (await readGrid()).grid;
    sortedByCreated = g.map((r) => r.cells.created);
  }

  // ── E: Board settings offers nothing to change about them ────────────────────────────────
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /board settings|⚙/i.test(x.innerText + " " + (x.getAttribute("title") || "")));
    if (b) b.click();
  });
  await page.waitForTimeout(700);
  settings = await page.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"]');
    if (!dlg) return { open: false };
    const text = dlg.innerText;
    const inputs = [...dlg.querySelectorAll("input")].map((i) => i.value);
    const buttons = [...dlg.querySelectorAll("button")].map((b) => b.innerText.trim());
    // The row a column is edited on: its rename box sits beside a Delete button.
    const rows = [...dlg.querySelectorAll("div")].filter((d) => d.querySelector(":scope > input") && /Delete/.test(d.innerText))
      .map((d) => (d.querySelector(":scope > input") || {}).value);
    return { open: true, text, inputs, buttons, rows };
  });
  await page.keyboard.press("Escape");
  await ctx.close();
} finally {
  await browser.close();
}

// ── A ────────────────────────────────────────────────────────────────────────────────────────
ok("A: the first two columns are Created then Requestor, before the board's own",
  header.join(",").includes("created,requestor,status"), header.join(" | "));
ok("A: the board's own columns are still there, after them",
  header.includes("status") && header.includes("due") && header.indexOf("status") > header.indexOf("requestor"),
  header.join(" | "));
for (const c of CARDS) {
  const row = grid.find((r) => r.name.startsWith(c.name));
  ok(`A: ${c.key}: Created reads ${c.shown}`, !!row && row.cells.created === c.shown, row ? JSON.stringify(row.cells) : "row not found");
  ok(`A: ${c.key}: Requestor reads ${c.requestor === null ? "—" : c.requestor}`,
    !!row && row.cells.requestor === (c.requestor === null ? "—" : c.requestor), row ? JSON.stringify(row.cells) : "row not found");
}

// ── B ────────────────────────────────────────────────────────────────────────────────────────
for (const a of locked) {
  const where = `${a.rowKey}/${a.colName}`;
  ok(`B: ${where}: clicking it opens no editor`, a.editors === 0, a.error || `editors ${a.editors}`);
  ok(`B: ${where}: …opens no card drawer`, a.drawer === false, a.error || `drawer ${a.drawer}`);
  ok(`B: ${where}: …opens no choice menu`, a.menu === 0, a.error || `menus ${a.menu}`);
  ok(`B: ${where}: …and sends no update_item`, a.wrote === false, a.error || "an update_item was sent");
}

// ── C ────────────────────────────────────────────────────────────────────────────────────────
ok("C: the control — the same row's Status cell DOES open its menu", control.menu === true, JSON.stringify(control));
ok("C: …and picking a label DOES send update_item", control.sent === true, JSON.stringify(control));

// ── D ────────────────────────────────────────────────────────────────────────────────────────
ok("D: the Created header is not draggable", drag.created === null, `draggable=${drag.created}`);
ok("D: the Requestor header is not draggable", drag.requestor === null, `draggable=${drag.requestor}`);
ok("D: the board's own Due header still is", drag.own === "true", `draggable=${drag.own}`);
{
  const want = CARDS.map((c) => c.shown).sort((a, b) => new Date(a) - new Date(b)).join(",");
  ok("D: clicking Created sorts the rows by date", (sortedByCreated || []).join(",") === want,
    `${(sortedByCreated || []).join(",")} (wanted ${want})`);
}

// ── E ────────────────────────────────────────────────────────────────────────────────────────
ok("E: Board settings opened", !!settings && settings.open === true, JSON.stringify(settings));
if (settings && settings.open) {
  ok("E: it says the two are filled in automatically", /filled in automatically/.test(settings.text) && /Created\s*·\s*Requestor/i.test(settings.text),
    settings.text.slice(0, 400));
  ok("E: no rename box holds Created or Requestor", !settings.inputs.includes("Created") && !settings.inputs.includes("Requestor"),
    JSON.stringify(settings.inputs));
  ok("E: no column row for either (a rename box beside a Delete)",
    !(settings.rows || []).includes("Created") && !(settings.rows || []).includes("Requestor"), JSON.stringify(settings.rows));
  ok("E: the board's own columns still have theirs", (settings.rows || []).includes("Status") && (settings.rows || []).includes("Due"),
    JSON.stringify(settings.rows));
}

ok("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));

const bad = failed();
console.log(`\n${results.length - bad.length} passed, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
