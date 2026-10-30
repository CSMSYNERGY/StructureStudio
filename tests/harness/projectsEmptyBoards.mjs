// Projects with NO boards shows an empty state, not "Loading board…" forever (2026-10-16), driven
// for real on the COMPILED portal.
//
// The bug: when portal-projects list_boards answered `boards: []`, ProjectsTab had no active
// board, so get_board was never asked and `data` never arrived, and the placeholder
// `boards && !data && !err` ("Loading board…") stayed up for good. The same happened after
// archiving the last board, with the archived board's table left on screen under it.
//
//   A  zero boards, an account that can write: the empty state is drawn, "Loading board…" NEVER
//      appears (a witness from the first render on, not a look at the end), no get_board goes out,
//      and "＋ New board" opens the strip's own input. Creating one from there sends create_board,
//      re-lists, opens the new board and the empty state goes away.
//   B  zero boards, read-only: the empty state without any create control.
//   C  boards exist (get_board held back 800 ms): the normal path is unchanged. "Loading board…"
//      shows while get_board is out, the first board's table renders with its items, the empty
//      state never appears, and ⚙ Board settings is offered.
//   D  archive the only board from ⚙ Board settings: the empty state replaces the table.
//   E  archive the only board, then make a new one from the empty state, with a late get_board
//      for the archived board still out and the new board's get_board held back: the archived
//      board's table never comes back, not even while the new board loads, and neither its
//      ⚙ Board settings nor its ＋ Add item is offered under the new tab meanwhile.
//   F  list_boards FAILS: its error is shown and the empty state is not (a failed list is not an
//      empty one, so "No boards yet / ＋ New board" must never sit under an error).
//
// Supabase is stubbed at the network layer (no login, nothing leaves the machine), the same shape
// supportConsoles.mjs uses; every board, item and person here is made up.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/projectsEmptyBoards.mjs      (exit 0 = every check held)
//
// SS_PORTAL_ARTIFACT=<an older portal.app.compiled.js> serves that file instead, which is how to
// prove these checks can fail: against e01c8757's artifact 21 of the 50 fail, in A, B, D and E (A:
// no empty state, "Loading board…" up for good, no way to create a board; B the same; D: the
// archived board's table and its ⚙ Board settings stay up under "Loading board…"; E: no way to
// create a board). Against the first fix (9b9be979, which only HID the archived board while the
// list was empty) 4 fail, all in E: the archived table, its ⚙ Board settings and ＋ Add item came
// back under the new board's tab while its get_board was out. C and F pass on
// every real build, which is their point: the path with boards did not move, and an error never
// turned into an empty state. F was proved able to fail with an artifact whose list_boards catch
// also set boards to [].
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

// ── Made-up boards ──────────────────────────────────────────────────────────────────────────
const mkBoard = (id, slug, name, position = 0) => ({ id, slug, name, position, settings: {}, archived_at: null });
const STATUS = (bid) => ({
  id: `${bid}-status`, board_id: bid, name: "Status", type: "status", position: 0,
  settings: { labels: [{ id: "todo", label: "To do", color: "#64748B" }, { id: "done", label: "Done", color: "#0E9F6E", kind: "done" }] },
});
function boardBody(board, names, canWrite) {
  const bid = board.id;
  return {
    board,
    columns: [STATUS(bid)],
    groups: [{ id: `${bid}-g1`, board_id: bid, name: "Intake", color: "#3D3672", position: 0 }],
    items: names.map((name, i) => ({
      id: `${bid}-i${i}`, board_id: bid, group_id: `${bid}-g1`, name, position: i,
      values: { [`${bid}-status`]: "todo" }, created_at: "2026-10-01T12:00:00Z", updated_at: "2026-10-01T12:00:00Z",
    })),
    people: [], views: [], canWrite,
  };
}

const { ok, failed, results } = reporter();
const { browser, ctx: unused } = await launch({ width: 1400, height: 1000 });
await unused.close();

const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });

// S: { canWrite, boards: [board], itemsOf: { [boardId]: [names] }, getBoardDelayMs,
//      getBoardDelay(boardId, S) (per call; overrides getBoardDelayMs), listBoardsError }
// act(page): drives the scenario and returns extra readings.
async function run(label, S, act) {
  const calls = [];   // { action, body, at }
  const pageErrors = [];
  const t0 = Date.now();
  const all = new Map(S.boards.map((b) => [b.id, b]));   // archived boards still answer get_board, as live
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, serviceWorkers: "block" });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
    // "Never shown" needs a witness from the first render on, not a look at the end.
    // __watch: strings a scenario arms part-way through; any of them on screen after that is a hit.
    window.__seen = { loadingBoard: false, empty: false, watchHits: [] };
    window.__watch = [];
    const scan = () => {
      const body = document.body;
      if (!body) return;
      const t = body.textContent;
      if (t.includes("Loading board…")) window.__seen.loadingBoard = true;
      if (document.querySelector("[data-ss-projects-empty]")) window.__seen.empty = true;
      for (const w of window.__watch) if (t.includes(w) && !window.__seen.watchHits.includes(w)) window.__seen.watchHits.push(w);
    };
    const attach = () => {
      if (!document.documentElement) { setTimeout(attach, 5); return; }
      new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    };
    attach();
  }, [REF, SESSION]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("dialog", (d) => d.accept());   // the Archive confirm()

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
          if (S.listBoardsError) return json(route, { error: S.listBoardsError }, 500);
          return json(route, {
            boards: S.boards, counts: Object.fromEntries(S.boards.map((b) => [b.id, (S.itemsOf[b.id] || []).length])),
            canWrite: S.canWrite, columns: {}, people: [],
          });
        case "get_board": {
          const delay = typeof S.getBoardDelay === "function" ? S.getBoardDelay(body.boardId, S) : S.getBoardDelayMs;
          if (delay) await new Promise((r) => setTimeout(r, delay));
          const b = all.get(body.boardId);
          if (!b) return json(route, { error: "Board not found." }, 404);
          return json(route, boardBody(b, S.itemsOf[b.id] || [], S.canWrite));
        }
        case "create_board": {
          const slug = String(body.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
          const b = mkBoard("board-created", slug, body.name, S.boards.length);
          S.boards = [...S.boards, b]; all.set(b.id, b); S.itemsOf[b.id] = [];
          return json(route, { ok: true, board: b });
        }
        case "board_access":   // since e4cefc8e (10-23) ⚙ Board settings loads who can see the board
          return json(route, { visibility: "everyone", board: (all.get(body.boardId) || {}).name || "", people: [], iOwn: true });
        case "archive_board":
          S.boards = S.boards.filter((b) => b.id !== body.id);
          S.archived = [...(S.archived || []), body.id];
          return json(route, { ok: true });
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
  // list_boards answers at once; give get_board (held up to 800 ms) and the render after it time to land.
  await page.waitForFunction(() => !document.body.innerText.includes("Loading boards…"), null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout((S.getBoardDelayMs || 0) + 2500);
  const read = async () => ({
    seen: await page.evaluate(() => ({ ...window.__seen })),
    empty: await page.locator("[data-ss-projects-empty]").count(),
    emptyText: await page.locator("[data-ss-projects-empty]").first().innerText().catch(() => ""),
    loadingNow: await page.evaluate(() => document.body.innerText.includes("Loading board…")),
    newBoardBtn: await page.locator("[data-ss-projects-empty]").getByRole("button", { name: "＋ New board" }).count(),
    errText: await page.evaluate(() => document.body.innerText.includes("Fictional list failure.")),
    stripPlus: await page.locator('[role="tablist"][aria-label="Boards"] button[title="New board"]').count(),
    tabs: await page.locator('[role="tablist"][aria-label="Boards"] [role="tab"]').allInnerTexts(),
    settingsBtn: await page.getByRole("button", { name: /Board settings/ }).count(),
    text: await page.evaluate(() => document.body.innerText),
  });
  const first = await read();
  // A scenario that cannot be driven (its button is missing, on an older artifact) is a failed
  // check below, not a crash that hides every other result.
  let extra = {};
  try { extra = act ? await act(page, calls) : {}; } catch (e) { extra = { actError: String(e.message || e).split(/\r?\n/)[0] }; }
  const out = { label, calls, pageErrors, first, last: await read(), ...extra };
  await ctx.close();
  return out;
}
const sent = (r, action) => r.calls.filter((c) => c.action === action);

try {
  // ── A: zero boards, an account that can write ──
  const A = await run("A", { canWrite: true, boards: [], itemsOf: {} }, async (page, calls) => {
    const before = calls.length;
    await page.locator("[data-ss-projects-empty]").getByRole("button", { name: "＋ New board" }).click({ timeout: 5000 });
    const input = page.getByPlaceholder("Board name — Enter to create");
    const inputShown = await input.isVisible().catch(() => false);
    const focused = await input.evaluate((el) => document.activeElement === el).catch(() => false);
    await input.fill("Fictional Punch List");
    await input.press("Enter");
    await page.waitForFunction(() => !document.querySelector("[data-ss-projects-empty]"), null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    return { inputShown, focused, afterCreate: calls.slice(before).map((c) => c.action) };
  });
  ok("A: list_boards was asked", sent(A, "list_boards").length >= 1);
  ok("A: the empty state is drawn", A.first.empty === 1, A.first.empty === 1 ? "" : A.first.text.slice(-200));
  ok("A: …saying there are no boards yet", /No boards yet/.test(A.first.emptyText));
  ok("A: \"Loading board…\" is never shown, not even for a frame", !A.first.seen.loadingBoard);
  ok("A: no get_board is sent while there is no board", sent(A, "get_board").filter((c) => c.at < (sent(A, "create_board")[0] || { at: Infinity }).at).length === 0,
    JSON.stringify(sent(A, "get_board")));
  ok("A: the empty state offers ＋ New board", A.first.newBoardBtn === 1);
  ok("A: the strip's own ＋ is still there too", A.first.stripPlus === 1);
  ok("A: Client Setup is still offered", A.first.tabs.some((t) => /Client Setup/.test(t)), JSON.stringify(A.first.tabs));
  ok("A: no ⚙ Board settings with no board", A.first.settingsBtn === 0);
  ok("A: ＋ New board opens the strip's name input, focused", A.inputShown && A.focused, A.actError || `shown ${A.inputShown}, focused ${A.focused}`);
  ok("A: Enter sends create_board with the typed name", sent(A, "create_board").length === 1 && sent(A, "create_board")[0].body.name === "Fictional Punch List",
    JSON.stringify(sent(A, "create_board").map((c) => c.body)));
  ok("A: …then re-lists and opens the new board", (A.afterCreate || []).includes("list_boards") && sent(A, "get_board").some((c) => c.body.boardId === "board-created"),
    JSON.stringify(A.afterCreate || null));
  ok("A: the new board's tab is drawn and the empty state is gone", A.last.tabs.some((t) => /Fictional Punch List/.test(t)) && A.last.empty === 0,
    JSON.stringify(A.last.tabs));
  ok("A: no uncaught page errors", A.pageErrors.length === 0, A.pageErrors.join(" | "));

  // ── B: zero boards, read-only ──
  const B = await run("B", { canWrite: false, boards: [], itemsOf: {} });
  ok("B: the empty state is drawn", B.first.empty === 1, B.first.empty === 1 ? "" : B.first.text.slice(-200));
  ok("B: …and says who can add a board", /Someone who can edit Projects/.test(B.first.emptyText));
  ok("B: no create control in it, and no ＋ in the strip", B.first.newBoardBtn === 0 && B.first.stripPlus === 0);
  ok("B: \"Loading board…\" is never shown", !B.first.seen.loadingBoard);
  ok("B: no get_board", sent(B, "get_board").length === 0);
  ok("B: no uncaught page errors", B.pageErrors.length === 0, B.pageErrors.join(" | "));

  // ── C: boards exist: the normal path, unchanged ──
  const C = await run("C", {
    canWrite: true, getBoardDelayMs: 800,
    boards: [mkBoard("board-a", "fictional-roadmap", "Fictional Roadmap", 0), mkBoard("board-b", "fictional-bugs", "Fictional Bugs", 1)],
    itemsOf: { "board-a": ["Paint the sample shed", "Order made-up hinges"], "board-b": ["A pretend bug"] },
  });
  ok("C: get_board is sent for the first board", sent(C, "get_board").length >= 1 && sent(C, "get_board")[0].body.boardId === "board-a",
    JSON.stringify(sent(C, "get_board").map((c) => c.body.boardId)));
  ok("C: \"Loading board…\" shows while get_board is out", C.first.seen.loadingBoard);
  ok("C: …and is gone once it answers", !C.first.loadingNow);
  ok("C: both board tabs are drawn", C.first.tabs.some((t) => /Fictional Roadmap/.test(t)) && C.first.tabs.some((t) => /Fictional Bugs/.test(t)), JSON.stringify(C.first.tabs));
  ok("C: the first board's items render", /Paint the sample shed/.test(C.first.text) && /Order made-up hinges/.test(C.first.text));
  ok("C: the other board's items do not", !/A pretend bug/.test(C.first.text));
  ok("C: the empty state never appears", !C.first.seen.empty && C.first.empty === 0);
  ok("C: ⚙ Board settings is offered", C.first.settingsBtn === 1);
  ok("C: ＋ Add item is offered", /＋ Add item/.test(C.first.text));
  ok("C: no uncaught page errors", C.pageErrors.length === 0, C.pageErrors.join(" | "));

  // ── D: archive the only board ──
  const D = await run("D", {
    canWrite: true,
    boards: [mkBoard("board-only", "fictional-only", "Fictional Only Board", 0)],
    itemsOf: { "board-only": ["The last made-up item"] },
  }, async (page) => {
    await page.getByRole("button", { name: /Board settings/ }).click({ timeout: 5000 });
    await page.getByRole("button", { name: "Archive this board" }).click({ timeout: 5000 });
    await page.waitForFunction(() => !!document.querySelector("[data-ss-projects-empty]"), null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    return {};
  });
  ok("D: the board rendered first", /The last made-up item/.test(D.first.text) && D.first.empty === 0);
  ok("D: archive_board was sent for it", sent(D, "archive_board").length === 1 && sent(D, "archive_board")[0].body.id === "board-only", D.actError);
  ok("D: the empty state replaces the board", D.last.empty === 1, D.last.empty === 1 ? "" : D.last.text.slice(-200));
  ok("D: the archived board's table is gone", !/The last made-up item/.test(D.last.text));
  ok("D: no ⚙ Board settings and no \"Loading board…\" left", D.last.settingsBtn === 0 && !D.last.loadingNow);
  ok("D: no uncaught page errors", D.pageErrors.length === 0, D.pageErrors.join(" | "));

  // ── E: archive the only board, then make a new one ──
  // After the archive, ⚙ settings' own reload asks get_board for the archived board again; that
  // answer is held 1200 ms so it lands AFTER the empty list. The new board's get_board is held
  // 2000 ms, and the screen is read in the middle of that wait.
  const ARCHIVED_ITEM = "The last made-up item";
  const E = await run("E", {
    canWrite: true,
    boards: [mkBoard("board-only", "fictional-only", "Fictional Only Board", 0)],
    itemsOf: { "board-only": [ARCHIVED_ITEM] },
    getBoardDelay: (id, s) => (id === "board-created" ? 2000 : ((s.archived || []).includes(id) ? 1200 : 0)),
  }, async (page, calls) => {
    await page.getByRole("button", { name: /Board settings/ }).click({ timeout: 5000 });
    await page.getByRole("button", { name: "Archive this board" }).click({ timeout: 5000 });
    await page.waitForFunction(() => !!document.querySelector("[data-ss-projects-empty]"), null, { timeout: 15000 });
    // From here on the archived board's item must never be on screen again.
    await page.evaluate((w) => { window.__watch = [w]; }, ARCHIVED_ITEM);
    await page.waitForTimeout(2000);   // the late get_board for the archived board lands in here
    const archivedAt = (calls.find((x) => x.action === "archive_board") || { at: Infinity }).at;
    const lateArchivedGet = calls.some((c) => c.action === "get_board" && c.body.boardId === "board-only" && c.at > archivedAt);
    const emptyAfterLate = await page.locator("[data-ss-projects-empty]").count();
    await page.locator("[data-ss-projects-empty]").getByRole("button", { name: "＋ New board" }).click({ timeout: 5000 });
    const input = page.getByPlaceholder("Board name — Enter to create");
    await input.fill("Fictional Fresh Board");
    await input.press("Enter");
    await page.waitForFunction(() => [...document.querySelectorAll('[role="tablist"][aria-label="Boards"] [role="tab"]')]
      .some((t) => t.textContent.includes("Fictional Fresh Board")), null, { timeout: 15000 });
    await page.waitForTimeout(700);   // inside the 2000 ms the new board's get_board is held
    const mid = {
      loading: await page.evaluate(() => document.body.innerText.includes("Loading board…")),
      settingsBtn: await page.getByRole("button", { name: /Board settings/ }).count(),
      addItem: await page.evaluate(() => document.body.innerText.includes("＋ Add item")),
      archivedText: await page.evaluate((w) => document.body.innerText.includes(w), ARCHIVED_ITEM),
      empty: await page.locator("[data-ss-projects-empty]").count(),
    };
    await page.waitForFunction(() => document.body.innerText.includes("＋ Add item"), null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(500);
    return { lateArchivedGet, emptyAfterLate, mid };
  });
  ok("E: archiving drew the empty state", E.emptyAfterLate === 1, E.actError);
  ok("E: a get_board for the archived board was still out after the archive (the race is real)", E.lateArchivedGet,
    JSON.stringify(sent(E, "get_board").map((c) => [c.body.boardId, c.at])));
  ok("E: create_board was sent", sent(E, "create_board").length === 1, E.actError);
  ok("E: while the new board loads, \"Loading board…\" shows", !!(E.mid && E.mid.loading), JSON.stringify(E.mid || null));
  ok("E: …and the archived board's table is NOT under the new tab", !!(E.mid && !E.mid.archivedText && E.mid.empty === 0), JSON.stringify(E.mid || null));
  ok("E: …nor its ⚙ Board settings or ＋ Add item", !!(E.mid && E.mid.settingsBtn === 0 && !E.mid.addItem), JSON.stringify(E.mid || null));
  ok("E: the archived board's item never came back after the archive, not for a frame", !E.last.seen.watchHits.includes(ARCHIVED_ITEM),
    JSON.stringify(E.last.seen.watchHits));
  ok("E: the new board opens once its get_board answers",
    /＋ Add item/.test(E.last.text) && E.last.tabs.some((t) => /Fictional Fresh Board/.test(t)) && E.last.settingsBtn === 1, JSON.stringify(E.last.tabs));
  ok("E: no uncaught page errors", E.pageErrors.length === 0, E.pageErrors.join(" | "));

  // ── F: list_boards fails ──
  const F = await run("F", { canWrite: true, boards: [], itemsOf: {}, listBoardsError: "Fictional list failure." });
  ok("F: list_boards was asked", sent(F, "list_boards").length >= 1);
  ok("F: its error is shown", F.first.errText, F.first.text.slice(-200));
  ok("F: the empty state never appears under the error, not for a frame", !F.first.seen.empty && F.first.empty === 0 && F.first.newBoardBtn === 0);
  ok("F: no \"Loading board…\" and no get_board", !F.first.seen.loadingBoard && sent(F, "get_board").length === 0);
  ok("F: no uncaught page errors", F.pageErrors.length === 0, F.pageErrors.join(" | "));
} finally {
  await browser.close();
}
const bad = failed();
console.log(`\n${results.length - bad.length} passed, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
