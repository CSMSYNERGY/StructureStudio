// Admin → Support chats (2026-10-30), driven for real on the COMPILED portal.
//
// Supabase is stubbed at the network layer (no login, nothing leaves the machine), and admin-catalog's
// two chat actions are answered by the SERVER'S OWN module (supabase/functions/admin-catalog/
// supportChats.ts, imported directly; Node strips the types) over an in-memory database with the
// live columns. A stub that answered differently from the server would pass a check the real page
// fails.
//
//   A. an operator's /console/chats (a cold deep link): the tab is there and current, this month's
//      four numbers, every chat newest first with builder, person, first question, size and status
//   B. clicking a chat opens the whole conversation, oldest first, with who said it, the lookups an
//      answer used, and the ticket it became; HTML in a message is text, never markup; Escape closes
//   C. the builder filter and "Only chats that became tickets" ask the server, and say so when
//      nothing matches
//   D. "Load older chats" asks for the page before the last chat, adds it, and goes away at the end
//   E. a link to one chat (/console/chats?chat=<id>) opens it, asks with the chat id alone, and takes
//      ?chat= off the address so it does not ride onto the next page
//   F. a link to a chat that is gone says so inside the dialog
//   G. an admin-catalog older than this page ("Unknown action") hides the card, no error banner
//   H. at 375 px nothing scrolls sideways, list or dialog
//   I. a non-operator never sees the Admin tab and never asks for a chat
//
//   python -m http.server 8131 --bind 127.0.0.1   (repo root)
//   SS_BASE=http://127.0.0.1:8131 node tests/harness/supportChats.mjs   (exit 0 = every check held)
//
// SS_PORTAL_ARTIFACT=<path to an older portal.app.compiled.js> serves that file instead: against the
// artifact from before this tab, A fails and the run stops there.
//
// Every value here is an obviously fake fixture: this repo is public.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, reporter, BASE, REF, serveAppRoutes } from "./lib.mjs";
import { CHATS_PAGE, handleSupportChatsAction } from "../../supabase/functions/admin-catalog/supportChats.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORTAL_HTML = readFileSync(join(ROOT, "portal.html"), "utf8");
const ARTIFACT = process.env.SS_PORTAL_ARTIFACT ? readFileSync(process.env.SS_PORTAL_ARTIFACT, "utf8") : null;
// SS_SHOTS=<folder> saves screenshots of the list, a chat and the phone view there.
const SHOTS = process.env.SS_SHOTS || null;
const shot = (page, name) => (SHOTS ? page.screenshot({ path: join(SHOTS, name) }) : Promise.resolve());

const CLIENT = "harness-internal";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-0000000000a1", aud: "authenticated", role: "authenticated", email: "operator@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};

// ── The in-memory database: the live columns only (read 2026-10-30), like supportChats_test.ts ──
const COLUMNS = {
  support_conversations: ["id", "client_id", "user_id", "status", "submission_id", "model", "message_count", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "cost_micros", "created_at", "updated_at", "last_message_at"],
  support_messages: ["id", "conversation_id", "client_id", "user_id", "role", "body", "tools", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "cost_micros", "stop_reason", "model", "created_at"],
  client_configs: ["client_id", "updated_at", "company_name"],
  feedback_submissions: ["id", "client_id", "kind", "title", "status", "created_at", "support_conversation_id"],
  admin_audit: ["id", "created_at", "action", "target_client_id", "row_count", "note", "actor_email", "actor_user_id"],
};
const cmp = (a, b) => {
  const da = typeof a === "string" ? Date.parse(a) : NaN, db = typeof b === "string" ? Date.parse(b) : NaN;
  if (!Number.isNaN(da) && !Number.isNaN(db)) return da - db;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
};
function fakeDb(W) {
  const q = (table) => {
    const st = { filters: [], orders: [], lim: Infinity, cols: [], head: false, single: false, err: null };
    const col = (c) => { if (!st.err && !COLUMNS[table].includes(c)) st.err = { code: "42703", message: `column ${table}.${c} does not exist` }; };
    const run = () => {
      if (st.err) return { data: null, error: st.err, count: null };
      let rows = (W.rows[table] || []).filter((r) => st.filters.every((f) => f(r)));
      rows = [...rows].sort((a, b) => { for (const [c, asc] of st.orders) { const d = cmp(a[c], b[c]); if (d) return asc ? d : -d; } return 0; });
      const count = rows.length;
      const out = rows.slice(0, st.lim).map((r) => Object.fromEntries(st.cols.map((c) => [c, r[c] ?? null])));
      if (st.head) return { data: null, error: null, count };
      if (st.single) return { data: out[0] ?? null, error: null, count: null };
      return { data: out, error: null, count };
    };
    const b = {
      select(cols, opts) { st.cols = cols.split(",").map((s) => s.trim()); st.cols.forEach(col); if (opts && opts.head) st.head = true; return b; },
      eq(c, v) { col(c); st.filters.push((r) => r[c] === v); return b; },
      in(c, vs) { col(c); st.filters.push((r) => vs.includes(r[c])); return b; },
      lt(c, v) { col(c); st.filters.push((r) => cmp(r[c], v) < 0); return b; },
      gte(c, v) { col(c); st.filters.push((r) => cmp(r[c], v) >= 0); return b; },
      not(c, op, v) { col(c); st.filters.push((r) => r[c] != null); return b; },
      order(c, o) { col(c); st.orders.push([c, !o || o.ascending !== false]); return b; },
      limit(n) { st.lim = n; return b; },
      maybeSingle() { st.single = true; return b; },
      insert(row) { Object.keys(row).forEach(col); if (!st.err) W.audit.push(row); return Promise.resolve({ data: null, error: st.err }); },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return b;
  };
  return {
    from: q,
    rpc: (name) => Promise.resolve(name === "support_usage" ? { data: { month_cost_micros: W.monthCost, tenant_24h: 0, user_10m: 0 }, error: null } : { data: null, error: { code: "42883" } }),
    auth: { admin: { getUserById: (id) => Promise.resolve(W.users[id] ? { data: { user: { id, ...W.users[id] } }, error: null } : { data: { user: null }, error: { message: "User not found" } }) } },
  };
}

const U1 = "00000000-0000-4000-8000-0000000000b1";
const U2 = "00000000-0000-4000-8000-0000000000b2";
const cid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const TICKET = "20000000-0000-4000-8000-000000000001";
// Times relative to now, so "this month" holds whenever the harness runs (the 1st included: minutes ago).
const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
let mid = 0;
const msg = (n, role, body, minutesAgo, o = {}) => ({
  id: `10000000-0000-4000-8000-${String(++mid).padStart(12, "0")}`, conversation_id: cid(n), client_id: o.client_id || "demo-builder",
  user_id: U1, role, body, tools: o.tools || [], cost_micros: role === "assistant" ? 2400 : 0, model: role === "assistant" ? "claude-sonnet-5-5" : null,
  stop_reason: null, created_at: ago(minutesAgo),
});
const conv = (n, minutesAgo, o = {}) => ({
  id: cid(n), client_id: "demo-builder", user_id: U1, status: "open", submission_id: null, model: "claude-sonnet-5-5",
  message_count: 2, cost_micros: 4800, created_at: ago(minutesAgo + 5), updated_at: ago(minutesAgo), last_message_at: ago(minutesAgo), ...o,
});
function baseWorld() {
  mid = 0;
  return {
    monthCost: 480_000,
    users: { [U1]: { email: "owner@demo.test", user_metadata: { full_name: "Pat Example" } }, [U2]: { email: "staff@acme.test", user_metadata: {} } },
    audit: [],
    rows: {
      client_configs: [{ client_id: "demo-builder", company_name: "Demo Sheds" }, { client_id: "acme-barns", company_name: "Acme Barns" }],
      feedback_submissions: [{ id: TICKET, client_id: "acme-barns", kind: "ticket", title: "Prices look wrong", status: "submitted", created_at: ago(30), support_conversation_id: cid(2) }],
      support_conversations: [
        conv(1, 10, { message_count: 4 }),
        conv(2, 30, { client_id: "acme-barns", user_id: U2, status: "handed_off", submission_id: TICKET, message_count: 2, cost_micros: 9000 }),
        conv(3, 60, { status: "closed" }),
      ],
      support_messages: [
        msg(1, "user", "Which styles have no prices yet?", 14),
        msg(1, "assistant", "Two styles have no prices: Utility and Lofted Barn.\nOpen Settings > Pricing to add them.", 13, { tools: ["get_account_overview", "get_catalog_summary"] }),
        msg(1, "user", "Can I paste <b>bold</b> here?", 12),
        msg(1, "assistant", "Yes, it shows as plain text.", 10),
        msg(2, "user", "My prices look wrong on the 12x16", 32, { client_id: "acme-barns" }),
        msg(2, "assistant", "I'll pass this to the team.", 30, { client_id: "acme-barns", tools: ["offer_handoff"] }),
        msg(3, "user", "Thanks, that's all", 61),
      ],
    },
  };
}

const { ok, failed, results } = reporter();
const { browser, ctx: unused } = await launch({ width: 1400, height: 1000 });
await unused.close();
const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });
const DEPS = { env: () => undefined, now: () => new Date() };
const respond = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

async function open(S, path, { width = 1400, height = 1000 } = {}) {
  const calls = [];
  const pageErrors = [];
  const ctx = await browser.newContext({ viewport: { width, height }, serviceWorkers: "block" });
  await ctx.addInitScript(([ref, s]) => { try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ } }, [REF, SESSION]);
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
      if (rpc[1] === "is_operator") return json(route, S.operator);
      if (rpc[1] === "is_support_operator") return json(route, false);
      if (rpc[1] === "can_open_projects") return json(route, false);
      return json(route, rpc[1] === "log_error" ? null : false);
    }
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: "owner" }]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) {
      return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: {}, status: "active" }, wallet: null });
    }
    if (url.includes("/portal-settings")) {
      if (body.action === "status") return json(route, { ok: true, clientId: CLIENT, role: "owner", access: null, prefs: null, configured: false, branding: {} });
      return json(route, { ok: true });
    }
    if (url.includes("/admin-catalog")) {
      if (body.action) calls.push({ action: body.action, body });
      if (body.action === "list_clients") return json(route, { ok: true, clients: [{ client_id: "demo-builder", company_name: "Demo Sheds" }, { client_id: "acme-barns", company_name: "Acme Barns" }], features: [] });
      if (body.action === "get_master") return json(route, { ok: true, layoutItemTypes: [] });
      if (body.action === "support_chats_list" || body.action === "support_chat_get") {
        if (S.old) return json(route, { error: `Unknown action: ${body.action}` }, 400);
        const r = await handleSupportChatsAction(fakeDb(S.world), body.action, body, { via: "operator", userId: USER.id, email: USER.email }, respond, DEPS);
        return json(route, await r.json(), r.status);
      }
      return json(route, { ok: true });
    }
    return json(route, { ok: true });
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  await serveAppRoutes(page, PORTAL_HTML);
  if (ARTIFACT) await page.route(/portal\.app\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: ARTIFACT }));
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  return { page, ctx, calls, pageErrors };
}
const waitFor = (page, fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
const waitText = (page, s, timeout = 15000) => waitFor(page, (x) => document.body.innerText.includes(x), s, timeout);
const rows = (page) => page.locator("[data-adm-chat-row]");
const of = (calls, action) => calls.filter((c) => c.action === action);
const dialogText = (page) => page.locator('[role="dialog"]').innerText().catch(() => "");
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

try {
  // ── A ──
  let S = { operator: true, world: baseWorld() };
  let t = await open(S, "/console/chats");
  const { page } = t;
  ok("A: the Support chats card renders on /console/chats", await waitFor(page, () => document.querySelector("[data-adm-support-chats]") && document.querySelector("[data-adm-support-chats]").getAttribute("data-adm-support-chats") !== "loading"));
  if (!failed().length) {
    const tab = page.getByRole("button", { name: "Support chats", exact: true });
    ok("A: the tab is there and current", (await tab.count()) === 1 && (await tab.getAttribute("aria-current")) === "page");
    const month = await page.locator("[data-adm-chat-month]").innerText();
    ok("A: this month's numbers: 3 chats, 4 questions, 1 ticket", /CHATS THIS MONTH\s*3/i.test(month) && /QUESTIONS\s*4/i.test(month) && /BECAME TICKETS\s*1/i.test(month), month.replace(/\s+/g, " "));
    ok("A: spend against the monthly limit", /\$0\.48/.test(month) && month.includes("of the $200.00 monthly limit"), month.replace(/\s+/g, " "));
    const list = await rows(page).allInnerTexts();
    ok("A: three chats, newest first", list.length === 3 && list[0].includes("Which styles have no prices yet?") && list[1].includes("My prices look wrong") && list[2].includes("Thanks, that's all"), JSON.stringify(list.map((s) => s.slice(0, 40))));
    ok("A: each row names the builder and the person", list[0].includes("Demo Sheds") && list[0].includes("Pat Example") && list[1].includes("Acme Barns") && list[1].includes("staff@acme.test"));
    ok("A: size, cost and status on each row", list[0].includes("4 messages") && list[1].includes("$0.01") && list[1].includes("Became a ticket") && list[2].includes("Closed") && list[0].includes("Open"));
    ok("A: one list call, unfiltered", of(t.calls, "support_chats_list").length === 1 && !of(t.calls, "support_chats_list")[0].body.clientId && !of(t.calls, "support_chats_list")[0].body.status);
    await shot(page, "01-list.png");

    // ── B ──
    await rows(page).nth(0).click();
    ok("B: clicking a chat opens it", await waitFor(page, () => document.querySelector("[data-adm-chat-messages]")));
    const get = of(t.calls, "support_chat_get")[0];
    ok("B: asks for that chat with its builder", get && get.body.chatId === cid(1) && get.body.clientId === "demo-builder", JSON.stringify(get && get.body));
    const bubbles = await page.locator("[data-adm-chat-msg]").evaluateAll((els) => els.map((e) => ({ role: e.getAttribute("data-adm-chat-msg"), text: e.innerText, align: getComputedStyle(e).alignSelf })));
    ok("B: four messages, oldest first, builder right and assistant left", bubbles.length === 4 && bubbles.map((b) => b.role).join() === "user,assistant,user,assistant"
      && bubbles[0].align === "flex-end" && bubbles[1].align === "flex-start", JSON.stringify(bubbles.map((b) => [b.role, b.align])));
    ok("B: who said it", bubbles[0].text.includes("Pat Example") && bubbles[1].text.includes("Studio Assistant"));
    ok("B: the lookups an answer used, in words", bubbles[1].text.includes("looked at their account, their catalog"), bubbles[1].text.split("\n")[0]);
    ok("B: line breaks in an answer are kept", bubbles[1].text.includes("Lofted Barn.\nOpen Settings"));
    ok("B: HTML in a message is text, not markup", bubbles[2].text.includes("<b>bold</b>") && (await page.locator('[data-adm-chat-msg] b').count()) === 0);
    const head = await dialogText(page);
    ok("B: the dialog names the builder, person and email", head.includes("Demo Sheds") && head.includes("Pat Example <owner@demo.test>"));
    ok("B: opening the chat was audited with whose it is", S.world.audit.some((a) => a.action === "support_chat_read" && a.target_client_id === "demo-builder" && a.note === `chat=${cid(1)}`));
    await shot(page, "02-chat.png");
    await page.keyboard.press("Escape");
    ok("B: Escape closes it", await waitFor(page, () => !document.querySelector('[role="dialog"]')));
    await rows(page).nth(1).click();
    ok("B: a chat that became a ticket says so, with its title", await waitFor(page, () => {
      const t = document.querySelector("[data-adm-chat-ticket]"); return t && t.innerText.includes("Prices look wrong") && t.innerText.includes("(submitted)");
    }));
    const handoff = await dialogText(page);
    ok("B: an answer that offered a ticket says so, not as a lookup", handoff.includes("· offered a ticket") && !handoff.includes("looked at offered"));
    await page.getByRole("button", { name: "Close", exact: true }).click();
    ok("B: the × closes it", await waitFor(page, () => !document.querySelector('[role="dialog"]')));

    // ── C ──
    await page.getByLabel("Builder").selectOption("acme-barns");
    ok("C: the builder filter asks the server", await waitFor(page, () => document.querySelectorAll("[data-adm-chat-row]").length === 1));
    const byBuilder = of(t.calls, "support_chats_list").at(-1);
    ok("C: …with that builder's id", byBuilder && byBuilder.body.clientId === "acme-barns", JSON.stringify(byBuilder && byBuilder.body));
    const opts = await page.getByLabel("Builder").locator("option").allInnerTexts();
    ok("C: the filter lists builders with their counts", opts.includes("Acme Barns (1)") && opts.includes("Demo Sheds (2)"), JSON.stringify(opts));
    await page.getByLabel("Builder").selectOption("demo-builder");
    await page.getByLabel("Only chats that became tickets").check();
    ok("C: none of Demo Sheds' chats became tickets: says so", await waitText(page, "No chats match."));
    const last = of(t.calls, "support_chats_list").at(-1);
    ok("C: …asked with the builder and handed_off", last.body.clientId === "demo-builder" && last.body.status === "handed_off", JSON.stringify(last.body));
    ok("C: no page errors", t.pageErrors.length === 0, t.pageErrors.join(" | "));
    await t.ctx.close();

    // ── D ──
    S = { operator: true, world: baseWorld() };
    S.world.rows.support_conversations = Array.from({ length: CHATS_PAGE + 3 }, (_, i) => conv(100 + i, 10 + i * 3));
    t = await open(S, "/console/chats");
    ok("D: the first page holds 50", await waitFor(t.page, (n) => document.querySelectorAll("[data-adm-chat-row]").length === n, CHATS_PAGE));
    const more = t.page.getByRole("button", { name: "Load older chats" });
    ok("D: there are older chats to load", (await more.count()) === 1);
    await more.click();
    ok("D: the older page is added", await waitFor(t.page, (n) => document.querySelectorAll("[data-adm-chat-row]").length === n, CHATS_PAGE + 3));
    const older = of(t.calls, "support_chats_list").at(-1);
    ok("D: it asked for chats before the 50th", older && typeof older.body.before === "string" && Date.parse(older.body.before) > 0, JSON.stringify(older && older.body));
    ok("D: nothing older left: the button goes", (await t.page.getByRole("button", { name: "Load older chats" }).count()) === 0);
    await t.ctx.close();

    // ── E ──
    S = { operator: true, world: baseWorld() };
    t = await open(S, `/console/chats?chat=${cid(2)}`);
    ok("E: a link to one chat opens it", await waitFor(t.page, () => document.querySelector("[data-adm-chat-messages]")));
    const linked = of(t.calls, "support_chat_get")[0];
    ok("E: asked with the chat id alone", linked && linked.body.chatId === cid(2) && !linked.body.clientId, JSON.stringify(linked && linked.body));
    ok("E: it is Acme Barns' chat", (await dialogText(t.page)).includes("Acme Barns"));
    ok("E: ?chat= is off the address", await waitFor(t.page, () => !location.search.includes("chat=")), await t.page.evaluate(() => location.pathname + location.search));
    await t.page.keyboard.press("Escape");
    await t.page.getByRole("button", { name: "Billing", exact: true }).click();
    await t.page.waitForTimeout(500);
    ok("E: …and does not ride onto the next page", !(await t.page.evaluate(() => location.search)).includes("chat="), await t.page.evaluate(() => location.href));
    await t.ctx.close();

    // ── F ──
    S = { operator: true, world: baseWorld() };
    t = await open(S, `/console/chats?chat=${cid(99)}`);
    ok("F: a link to a chat that is gone says so in the dialog", await waitFor(t.page, () => {
      const d = document.querySelector('[role="dialog"]'); return d && d.innerText.includes("That chat isn't here. Chats are deleted after 180 days without a message.");
    }));
    await t.ctx.close();

    // ── G ──
    S = { operator: true, world: baseWorld(), old: true };
    t = await open(S, "/console/chats");
    await t.page.waitForTimeout(2500);
    ok("G: an older admin-catalog hides the card", (await t.page.locator("[data-adm-support-chats]").count()) === 0);
    ok("G: …with no error banner", !(await t.page.evaluate(() => document.body.innerText)).includes("Unknown action"));
    await t.ctx.close();

    // ── H ──
    S = { operator: true, world: baseWorld() };
    t = await open(S, "/console/chats", { width: 375, height: 812 });
    ok("H: 375 px: the list renders", await waitFor(t.page, () => document.querySelectorAll("[data-adm-chat-row]").length === 3));
    ok("H: 375 px: nothing scrolls sideways (list)", await noSideScroll(t.page), String(await t.page.evaluate(() => document.documentElement.scrollWidth)));
    await t.page.locator("[data-adm-support-chats]").scrollIntoViewIfNeeded();
    await shot(t.page, "03-phone-list.png");
    await rows(t.page).nth(0).click();
    await waitFor(t.page, () => document.querySelector("[data-adm-chat-messages]"));
    await shot(t.page, "04-phone-chat.png");
    ok("H: 375 px: nothing scrolls sideways (dialog)", await noSideScroll(t.page));
    const box = await t.page.locator('[role="dialog"]').boundingBox();
    ok("H: 375 px: the dialog fits the screen", box && box.x >= 0 && box.x + box.width <= 375 + 1, JSON.stringify(box));
    ok("H: no page errors", t.pageErrors.length === 0, t.pageErrors.join(" | "));
    await t.ctx.close();

    // ── I ──
    S = { operator: false, world: baseWorld() };
    t = await open(S, "/console/chats");
    await t.page.waitForTimeout(3000);
    ok("I: a non-operator gets no chats card", (await t.page.locator("[data-adm-support-chats]").count()) === 0);
    ok("I: …and never asks for a chat", of(t.calls, "support_chats_list").length === 0 && of(t.calls, "support_chat_get").length === 0);
    await t.ctx.close();
  }
} finally {
  await browser.close();
}
const bad = failed();
console.log(`\n${results.length - bad.length} passed, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
