// THE SIZES & PRICES TABLE (/settings/sheds-table, build plan Phase 2: the shell and the read-only
// grid; Phase 3: editing and autosave), driven for real on the COMPILED portal. Phase 5 adds paste,
// adding sizes, refresh and the backup.
//
//   A  THE SHEDS CARD: retitled "Sizes, prices & included options"; "Open sizes & prices table ↗" is a
//      real anchor to /settings/sheds-table (target=_blank, rel=noopener); a "Prefer Excel?" row holds
//      Download and Upload; the warning sentence is in the instructions. An upload's answer draws
//      UNDER the buttons. Download reads catalog + size_table fresh (targetClientId on both bodies)
//      and the sheet is built from size_table; when the counts never add up it is refused, but past
//      the 1000-row cap or with an orphan row it is still built. A column added after Sheds loaded is
//      in the sheet, and uploading that sheet sends its boxes. Add style's answer links to the table
//      with ?style=<new id>.
//   B  THE NEW TAB: the link opens a tab whose cold load renders the table with no page error (no
//      React #310): its title, Back link, legend, three style bands, every size row; ?style= jumps to
//      that style and leaves the address.
//   C  HEADERS AT 1280 AND 1440: no option name is cut (each standing name fits its box in two lines
//      at most, and no header cell overflows), and a two-line name reads in order when the head is
//      tilted (its first line is the RIGHT one); "480" and "1200" fit a 44 px box, and a price wider
//      than its box reads whole in its title; the header, the frozen Size/Price/Offered and a style's
//      name stay pinned on both scroll axes; the page itself never scrolls. Run on the 25-column
//      fixture and again on the plan's 210 sizes x 38 columns. A header screenshot is kept at each
//      width (SS_PG_HEADER_SHOTS names a folder for them).
//   D  THE GRID: the active-column readout follows a click and the arrows; aria-selected moves;
//      "Show hidden sizes" folds hidden rows and is remembered, and a cursor on a folded size moves to
//      the next size still drawn; Jump to style scrolls the band under the header; ARIA roles and counts.
//   E  STATES: a slow size_table shows the skeleton and "Loading…"; a failed one says "Couldn't load
//      your sizes." and Retry recovers; no styles says so; no option columns shows the Options box;
//      a count that never adds up reads twice and opens view-only "too big"; Real-Time Pricing greys
//      every price and locks it, at 1440 and at 390 px.
//   F  VIEW-AS: an operator's cold ?view=<builder> load says "Opening <builder>…" and reads nothing
//      while the operator check is out, then makes every table read for that builder (targetClientId
//      on every body) and draws the red operator strip with the builder's name; ?as= opens view-only,
//      naming the person (or "a team member" when the people list is refused); a view-as page that is
//      view-only for another reason says so in the strip too; a non-operator holding ?view= is told
//      after 10 s that the account could not be opened, and no table read ever goes out; a view-only
//      access map opens view-only; a billing lock shows the lock.
//   G  NARROW (390 px): the page does not scroll sideways, the header is at most 90 px, at least 8 rows
//      show.
//   P  EDITING AND AUTOSAVE (Phase 3), against a fake of save_pricing_cells answering as migration 350
//      does (fakeServer): a digit opens the editor over the box holding it; Enter/Tab/Shift+Tab/Up/Down
//      commit and move, Left/Right stay in the text, Escape cancels, F2/Enter/double-click edit in place;
//      Delete clears one box; Space and a second click tick Offered; Ctrl+Z says no undo; the ring
//      stays on a frozen box while the grid scrolls sideways; Shift+arrows draw one range rectangle.
//      A price and an option box each send one size with only that field, from what was on file, on its
//      version; the badge goes not saved → saving → saved; 10 quick edits make at most 2 calls. A
//      colleague's change to the same box turns it amber with their number and the status line; to
//      another box it is resent once; a refused box is red with the server's reason; text the rules
//      refuse is red at once and never sent; conflict/refusal answers each log one info row, counts
//      only. A 500 goes amber then green (Retry now too); a hung main host goes through the side door;
//      a lost answer resends as a duplicate; five failures stop saving with one info row, then Retry
//      and Discard; a 403 makes the page view-only. ?as= and a view-only access map refuse every edit
//      path; Real-Time Pricing locks prices only. The leave prompt fires for an editor holding changed
//      text and for an unsent edit, and not once saved; Back to Sheds sends first.
//   T  TIMING (always printed): first render, arrow-key and typing time at 1x (210 sizes x 41 columns,
//      about 8,600 cells) and 3x (630 x 41, about 25,800). Fails only if an arrow key re-renders a row
//      or a commit re-renders more than the one it changed.
//
// Supabase is stubbed at the network layer (no login, nothing leaves the machine). Every style, size,
// option and account here is made up; this repo is public.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root, after npm run compile)
//   node tests/harness/pricingTable.mjs            (exit 0 = every check held)
//
// SS_BASE=http://127.0.0.1:<port> points it at another port. SKIP_TIMING=1 skips T; PG_ONLY=C,F runs
// only those sections. SHOTS go to %TEMP%/ss-harness/pricing-table unless SS_SHOTS says otherwise;
// the header pictures for Carolyn (C, at 1280 and 1440) go to SS_PG_HEADER_SHOTS when it is set.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { reporter, BASE, REF, shotsDir, serveAppRoutes } from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { ok, failed } = reporter();
const shots = shotsDir("pricing-table");
const headerShots = process.env.SS_PG_HEADER_SHOTS || shots;
mkdirSync(headerShots, { recursive: true });
// PG_ONLY=C,T runs those sections alone (the server check always runs).
const ONLY = (process.env.PG_ONLY || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const want = (s) => !ONLY.length || ONLY.includes(s);

// ── The server at BASE is this checkout (the Windows double-bind trap) ─────────────────────────
{
  const vOf = (html) => (/portal\.app\.compiled\.js\?v=([a-f0-9]+)/.exec(html) || [])[1] || null;
  const localV = vOf(readFileSync(join(ROOT, "portal.html"), "utf8"));
  let servedV = null, servedHash = null;
  try { servedV = vOf(await (await fetch(`${BASE}/portal.html`, { cache: "no-store" })).text()); } catch (_e) { /* not up */ }
  try { servedHash = createHash("sha256").update(Buffer.from(await (await fetch(`${BASE}/portal.app.compiled.js`, { cache: "no-store" })).arrayBuffer())).digest("hex").slice(0, 8); } catch (_e) { /* not up */ }
  ok(`Server: ${BASE} serves this checkout's portal (?v=${localV})`, !!localV && servedV === localV && servedHash === localV, `served ?v=${servedV}, sha ${servedHash}`);
}

// ── Made-up fixtures ─────────────────────────────────────────────────────────────────────────
const OWN = "harness-barns";
const OPS = "harness-ops";
const VIEWED = "harness-viewed";
const COMPANY = { [OWN]: "Harness Barns Co", [OPS]: "Harness Operators", [VIEWED]: "Harness Viewed Sheds" };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-0000000000a1", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: { full_name: "Pat Example" }, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const WEAR = "00000000-0000-4000-8000-0000000000b2";   // a made-up team member an operator wears
const WEAR_NAME = "Sam Example";
const WIDE_PRICE = 123456.78;                         // "$123,456.78": wider than the 76 px Price box
const LONG = "Double Door with Transom and Kickplate (6'x7')";   // 46 characters with its size

const hex = (n, w = 12) => n.toString(16).padStart(w, "0");
const uid = (kind, n) => `${kind}0000000-0000-4000-8000-${hex(n)}`;

// The option columns: built-ins (catalog items) and catalog fixtures. `extra` adds generated doors
// for the timing fixture (38 columns).
function catalogFor(clientId, { cols = "full", extra = 0, items = null } = {}) {
  const ITEMS = [
    { key: "loft", label: "Loft (sq ft)" }, { key: "workbench", label: "Workbench" }, { key: "shelving", label: "Shelving" },
    { key: "electricalPackage", label: "Electrical Package" }, { key: "floorInsulation", label: "Floor Insulation" },
    { key: "upgradedFlooring", label: "Upgraded Flooring (sq ft)" },
    { key: "ramp", label: "Ramp" }, { key: "partitionWall", label: "Partition wall" }, { key: "oldThing", label: "Old Thing", archived: true },
  ];
  let id = 100;
  const fx = (name, category, w, h) => ({ id: ++id, name, category, width_in: w, height_in: h, active: true, archived: false });
  const FIX = [
    fx("Single Door", "door", 36, 76), fx("Double Door", "door", 72, 76), fx("Double Door with Transom and Kickplate", "door", 72, 84),
    fx("Roll-Up Door", "door", 96, 84), fx("Roll-Up Door", "door", 108, 96), fx("Steel Entry Door with Half Glass", "door", 36, 80),
    fx("Barn Style Double Door", "door", 60, 72), fx("Garage Door Heavy Duty Insulated", "door", 120, 96),
    fx("Window", "window", 24, 36), fx("Window", "window", 36, 48), fx("Transom Window", "window", 48, 12),
    fx("Insulated Window with Grids", "window", 36, 36), fx("Horizontal Slider Window", "window", 48, 24), fx("Shutter Window", "window", 24, 36),
    fx("Gable Vent", "vent", 12, 12), fx("Ridge Vent Kit", "vent", null, null), fx("Soffit Vent", "vent", 12, 12),
    fx("Ramp Kit", "ramp", 48, 6), fx("Wide Ramp Kit", "ramp", 72, 12),
    { id: 999, name: "Retired Door", category: "door", active: false, archived: false },
  ];
  for (let i = 0; i < extra; i++) FIX.push(fx(`Extra Door Option ${i + 1} with Trim`, "door", 36 + i, 80));
  const it = items || (cols === "none" ? [] : ITEMS);
  const fixtures = cols === "none" ? [] : FIX;
  return { ok: true, clientId, items: it, fixtures, styles: [], sizes: [], inclusions: [], layoutPricing: [], colors: [], windowColors: [], wallHeights: [], cladding: [], insulation: [] };
}
// Option keys in column order, as ssPricingColumns builds them (built-ins, then doors, windows, vents, ramps).
const OPTION_KEYS = (cat) => {
  const layout = cat.items.filter((x) => !x.archived && x.key !== "ramp" && x.key !== "partitionWall").map((x) => x.key);
  const fx = cat.fixtures.filter((f) => f.active !== false && !f.archived);
  const by = (c) => fx.filter((f) => (f.category || "door") === c).map((f) => String(f.id));
  return [...layout, ...by("door"), ...by("window"), ...by("vent"), ...by("ramp")];
};

// Styles and sizes. `scale` multiplies the sizes per style (the timing fixtures).
function tableFor(clientId, cat, { styles = 3, perStyle = null, hiddenStyle = false, noStyles = false, rtpOn = false } = {}) {
  if (noStyles) return { ok: true, clientId, rtpOn: false, styles: [], sizes: [], inclusions: [], counts: { sizes: 0, inclusions: 0 } };
  const NAMES = ["Test Barn", "Test Lofted Barn", "Test Utility Shed"];
  const st = [];
  for (let i = 0; i < styles; i++) st.push({ id: uid("5", i + 1), key: `test-${i + 1}`, label: NAMES[i] || `Test Style ${i + 1}`, code: `T${i + 1}`, active: true, sort_order: i });
  if (hiddenStyle) st.push({ id: uid("5", 90), key: "test-hidden", label: "Test Retired Style", code: "TR", active: false, sort_order: 9 });
  const GRIDS = [[[8, 10, 12], [12, 16, 20, 24]], [[10, 12, 14], [16, 20, 24, 28, 32]], [[6, 8, 10], [8, 10, 12, 14, 16]]];
  const keys = OPTION_KEYS(cat);
  const sizes = [], incs = [];
  let n = 0;
  st.forEach((s, si) => {
    const [ws, ls] = GRIDS[si % 3];
    const want = perStyle || ws.length * ls.length;
    for (let k = 0; k < want; k++) {
      const w = ws[k % ws.length], l = ls[Math.floor(k / ws.length) % ls.length] + 4 * Math.floor(k / (ws.length * ls.length));
      n++;
      const unpriced = n % 11 === 0, untick = n % 13 === 0;
      const price = unpriced ? null : n === 2 ? WIDE_PRICE : 1200 + w * l * 9 + (n % 3 === 0 ? 0.5 : 0);
      const id = uid("7", n);
      sizes.push({ id, style_id: s.id, label: `${w}x${l}`, width_ft: w, length_ft: l, base_price: price, active: !unpriced && !untick,
        sort_order: k, created_at: "2026-10-01T00:00:00.000001+00:00", updated_at: `2026-10-20T00:00:00.${String(100000 + n)}+00:00` });
      // A few included options per size; Loft carries 480 and Upgraded Flooring 1200 (the widest numbers).
      if (n % 2 === 0) incs.push({ size_id: id, item_key: "loft", included: true, qty: 480 });
      if (n % 5 === 0) incs.push({ size_id: id, item_key: "upgradedFlooring", included: true, qty: 1200 });
      if (n % 3 === 0) incs.push({ size_id: id, item_key: keys[6 + (n % Math.max(1, keys.length - 6))] || "workbench", included: true, qty: 1 });
      if (n % 7 === 0) incs.push({ size_id: id, item_key: "workbench", included: false, qty: 2 });
    }
  });
  return { ok: true, clientId, rtpOn, styles: st, sizes, inclusions: incs, counts: { sizes: sizes.length, inclusions: incs.length } };
}

// ── The fake backend ─────────────────────────────────────────────────────────────────────────
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL === "bundled" ? undefined : "chrome", headless: !process.env.HEADED });
const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A fake of the save side (Phase 3): portal-settings' size_table and save_pricing_cells over one
// account's rows, answering exactly as _shared/pricingCells.ts and migration 350 do. Each size entry
// is judged by both checks (its version AND every `from`), and answered saved / duplicate / conflict /
// missing with the size's version, row (price, active, label, width_ft, length_ft, style_id,
// sort_order, created_at) and cells (the sent boxes only), plus cellErrors for a box the server will
// not take (an option that is no column, Real-Time Pricing, Offered with no price).
//   F.script   one step per save request, either host, in order: { status } fails it without
//              writing; { lose: true } writes, then answers 500 (an answer lost on the way back);
//              { hang: true } never answers; { before(F) } runs first (a colleague's save);
//              { delayMs } waits. F.delayMs waits on every save.
//   F.poke(id, { price?, active?, cells? })   a colleague's save straight into the rows.
//   F.refuse   option keys the server answers "no column" for.
function fakeServer(cat, table) {
  let clock = 0;
  const ver = () => `2026-10-31T00:00:00.${String(++clock).padStart(6, "0")}+00:00`;
  const sizes = new Map(table.sizes.map((z) => [z.id, { ...z }]));
  const inc = new Map();
  table.inclusions.forEach((x) => { if (x.included) { if (!inc.has(x.size_id)) inc.set(x.size_id, {}); inc.get(x.size_id)[x.item_key] = Number(x.qty) || 1; } });
  const priceOf = (z) => (z.base_price == null ? null : Number(z.base_price));
  const F = {
    script: [], refuse: [], delayMs: 0, rtp: !!table.rtpOn, bad: [],
    table: (clientId) => ({ ok: true, clientId, rtpOn: F.rtp, styles: table.styles, sizes: [...sizes.values()].map((z) => ({ ...z })),
      inclusions: [...inc.entries()].flatMap(([id, c]) => Object.entries(c).map(([k, q]) => ({ size_id: id, item_key: k, included: true, qty: q }))),
      counts: { sizes: sizes.size, inclusions: [...inc.values()].reduce((n, c) => n + Object.keys(c).length, 0) } }),
    size: (id) => sizes.get(id),
    cells: (id) => ({ ...(inc.get(id) || {}) }),
    poke: (id, change) => {
      const z = sizes.get(id);
      if ("price" in change) z.base_price = change.price;
      if ("active" in change) z.active = change.active;
      if (change.cells) { const c = inc.get(id) || {}; Object.entries(change.cells).forEach(([k, q]) => { if (q > 0) c[k] = q; else delete c[k]; }); inc.set(id, c); }
      z.updated_at = ver();
    },
    // The edge's shape check (validatePayload's core): a body it would answer 400 is a parity bug.
    malformed: (body) => {
      const list = [...(body.creates || []), ...(body.removes || []), ...(body.sizes || [])];
      if (!list.length || list.length > 50) return "entries";
      for (const s of body.sizes || []) {
        if (typeof s.base !== "string" || !s.from || !s.to) return "shape";
        if (("price" in s.to) !== ("price" in s.from) || ("active" in s.to) !== ("active" in s.from)) return "from/to";
        if (Object.keys(s.to.cells || {}).sort().join() !== Object.keys(s.from.cells || {}).sort().join()) return "cells";
        if (Object.values(s.to.cells || {}).some((q) => !Number.isInteger(q) || q < 0)) return "qty";
      }
      return null;
    },
    apply: (body) => {
      const allowed = new Set(OPTION_KEYS(cat).filter((k) => !F.refuse.includes(k)));
      const results = (body.sizes || []).map((e) => {
        const z = sizes.get(e.id);
        if (!z) return { id: e.id, status: "missing", version: null, row: null, cells: {}, reason: "That size isn't on this account any more." };
        const c = inc.get(e.id) || {};
        const cur = (k) => c[k] || 0;
        const same = (side) => (!("price" in side) || side.price === priceOf(z)) && (!("active" in side) || side.active === !!z.active)
          && Object.entries(side.cells || {}).every(([k, v]) => v === cur(k));
        const errs = {};
        let status;
        if (z.updated_at === e.base && same(e.from)) {
          let p = priceOf(z);
          if ("price" in e.to) { if (F.rtp) errs.price = "Real-Time Pricing sets prices on this account"; else p = e.to.price; }
          let act = "active" in e.to ? e.to.active : (priceOf(z) == null && p != null ? true : !!z.active);
          if (act && p == null) { if ("active" in e.to) errs.active = "Add a price first"; act = false; }
          z.base_price = p; z.active = act; z.updated_at = ver();
          Object.entries(e.to.cells || {}).forEach(([k, q]) => {
            if (!allowed.has(k)) { errs[k] = "That option has no column in your sizes table"; return; }
            if (q > 0) c[k] = q; else delete c[k];
          });
          inc.set(e.id, c);
          status = "saved";
        } else status = same(e.to) ? "duplicate" : "conflict";
        const cells = {};
        Object.keys(e.to.cells || {}).forEach((k) => { cells[k] = cur(k); });
        return { id: e.id, status, version: z.updated_at, cells, ...(Object.keys(errs).length ? { cellErrors: errs } : {}),
          row: { price: priceOf(z), active: !!z.active, label: z.label, width_ft: z.width_ft, length_ft: z.length_ft, style_id: z.style_id, sort_order: z.sort_order, created_at: z.created_at } };
      });
      return { created: [], removed: [], results };
    },
  };
  return F;
}

// S: { own, operator, operatorDelayMs (is_operator answers late), role, access, locked, cat(clientId),
//      table(clientId), sizeTableDelayMs, sizeTableFailures, countSkew (size_table answers with counts
//      that never add up), createdStyleId, peopleRefused (list_users answers 403), fake (fakeServer:
//      size_table and save_pricing_cells answer from its rows), win (window.* values set before the
//      page's own scripts: __ssPgBackoffMs, __ssSaveDeadlineMs) }
async function open(path, S0 = {}, { width = 1440, height = 900 } = {}) {
  const S = { own: OWN, operator: false, operatorDelayMs: 0, role: "owner", access: null, locked: false, sizeTableDelayMs: 0, sizeTableFailures: 0, countSkew: false, ...S0 };
  S.cat = S.cat || ((cid) => catalogFor(cid));
  S.table = S.table || (S.fake ? (cid) => S.fake.table(cid) : (cid) => tableFor(cid, S.cat(cid)));
  const ctx = await browser.newContext({ viewport: { width, height }, serviceWorkers: "block", acceptDownloads: true });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
  }, [REF, SESSION]);
  if (S.win) await ctx.addInitScript((w) => { Object.assign(window, w); }, S.win);
  const calls = [];
  const errors = [];
  const logs = [];      // every log_error row the page wrote (the stub keeps them here)
  const dialogs = [];   // the type of every dialog the page raised (beforeunload included), each dismissed
  await ctx.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    const rpc = /\/rest\/v1\/rpc\/([a-z_]+)/.exec(url);
    if (rpc) {
      if (rpc[1] === "log_error") { logs.push(body); return json(route, null); }
      if (rpc[1] === "is_operator") {
        if (S.operatorDelayMs) await sleep(S.operatorDelayMs);
        return json(route, !!S.operator);
      }
      if (rpc[1] === "is_support_operator") return json(route, false);
      if (rpc[1] === "can_open_projects") return json(route, false);
      return json(route, null);
    }
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: S.own, role: S.role, user_id: USER.id }]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    const fn = /\/(?:functions\/v1\/)?(portal-[a-z]+|operator-portal|support-agent)(?:[/?]|$)/.exec(new URL(url).pathname);
    const name = fn ? fn[1] : null;
    const host = new URL(url).host.includes(".functions.") ? "side" : "main";
    calls.push({ fn: name, action: body.action, body, host, at: Date.now() });
    if (name === "portal-billing") {
      return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], paid: [], features: { crm: true }, status: S.locked ? "past_due" : "active", locked: !!S.locked, reason: S.locked ? "unpaid" : null }, wallet: null });
    }
    // The people on an account (the switcher's list; the table's ?as= message names one of them).
    if (name === "operator-portal" && body.action === "list_users") {
      return S.peopleRefused ? json(route, { error: "Not allowed (test)." }, 403)
        : json(route, { ok: true, users: [{ userId: USER.id, fullName: "Pat Example", role: "owner" }, { userId: WEAR, fullName: WEAR_NAME, email: "sam@example.test", role: "user", title: "sales_rep" }] });
    }
    if (name === "operator-portal") return json(route, { ok: true, clientId: VIEWED, companyName: COMPANY[VIEWED], designs: [], versions: [], capturedLeads: [], crmContacts: [], crmContactsTotal: 0, clients: [] });
    if (name === "support-agent") return json(route, { ok: true, on: false });
    if (name === "portal-settings") {
      const tenant = body.targetClientId || S.own;
      const a = body.action;
      if (a === "status") return json(route, { ok: true, clientId: tenant, role: S.role, access: S.access, prefs: null, configured: true, branding: { companyName: COMPANY[tenant] || tenant }, businessAddress: {} });
      if (a === "catalog") {
        const c = S.cat(tenant);
        // PricingCsv reads styles off the catalog: hand it size_table's styles.
        const t = S.table(tenant);
        return json(route, { ...c, styles: t.styles.map((s) => ({ ...s, image_url: null, taxable: true, show_image_on_estimate: true })), sizes: t.sizes, inclusions: t.inclusions });
      }
      if (a === "size_table") {
        if (S.sizeTableDelayMs) await sleep(S.sizeTableDelayMs);
        if (S.sizeTableFailures > 0) { S.sizeTableFailures--; return json(route, { error: "Couldn't load your sizes (test)." }, 500); }
        const t = S.table(tenant);
        return json(route, S.countSkew ? { ...t, counts: { sizes: t.sizes.length + 1, inclusions: t.inclusions.length } } : t);
      }
      if (a === "save_pricing_cells" && S.fake) {
        const F = S.fake;
        const step = F.script.length ? F.script.shift() : {};
        if (step.hang) return undefined;   // never answered: the page's deadline gives up on it
        if (step.delayMs) await sleep(step.delayMs);
        if (F.delayMs) await sleep(F.delayMs);
        const bad = F.malformed(body);
        if (bad) { F.bad.push(bad); return json(route, { error: `Malformed save (${bad}).` }, 400); }
        if (step.before) step.before(F);
        if (step.status && !step.lose) return json(route, { error: step.error || `Test failure (${step.status}).` }, step.status);
        const out = F.apply(body);
        if (step.lose) return json(route, { error: "The answer was lost on the way back (test)." }, 500);
        return json(route, { ok: true, clientId: tenant, ...out });
      }
      if (a === "create_style") return json(route, { ok: true, clientId: tenant, styleId: S.createdStyleId || uid("5", 77) });
      if (a === "import_pricing_csv") return json(route, { ok: true, clientId: tenant, imported: 2, created: 1, updated: 1, skipped: [] });
      return json(route, { ok: true, clientId: tenant });
    }
    return json(route, { ok: true });
  };
  await ctx.route(`**/${REF}.supabase.co/**`, handler);
  await ctx.route(`**/${REF}.functions.supabase.co/**`, handler);
  await serveAppRoutes(ctx);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && /Minified React error|#310|Rendered more hooks/.test(m.text())) errors.push(m.text()); });
  page.on("dialog", (d) => { dialogs.push(d.type()); d.dismiss().catch(() => {}); });
  if (path) await page.goto(`${BASE}${path}`);
  return { ctx, page, calls, errors, S, logs, dialogs };
}
const tableCalls = (calls) => calls.filter((c) => c.fn === "portal-settings" && (c.action === "size_table" || (c.action === "catalog" && "targetClientId" in c.body)));
const waitGrid = (page, timeout = 20000) => page.waitForSelector(".ss-pg-grid tbody tr", { timeout });

// ── A: the Sheds card ────────────────────────────────────────────────────────────────────────
if (want("A") || want("B")) {
  const { ctx, page, calls, errors, S } = await open("/settings/sheds");
  await page.waitForSelector("text=Sizes, prices & included options", { timeout: 20000 });
  await page.waitForSelector("text=Open sizes & prices table", { timeout: 20000 });
  const link = page.locator("a", { hasText: "Open sizes & prices table" });
  const attrs = await link.evaluate((a) => ({ href: a.getAttribute("href"), target: a.getAttribute("target"), rel: a.getAttribute("rel"), text: a.textContent }));
  ok("A: one 'Open sizes & prices table ↗' anchor", (await link.count()) === 1 && /↗/.test(attrs.text), attrs.text);
  ok("A: it points at /settings/sheds-table, in a new tab, noopener", attrs.href === "/settings/sheds-table" && attrs.target === "_blank" && /noopener/.test(attrs.rel || ""), JSON.stringify(attrs));
  ok("A: the old '(Excel)' title is gone", !(await page.getByText("Pricing & included options (Excel)").count()));
  const row = await page.evaluate(() => {
    const lab = [...document.querySelectorAll("span")].find((s) => s.textContent === "Prefer Excel?");
    const box = lab && lab.parentElement;
    return box ? { text: box.textContent, afterLink: !!(document.querySelector('a[href="/settings/sheds-table"]').compareDocumentPosition(lab) & Node.DOCUMENT_POSITION_FOLLOWING) } : null;
  });
  ok("A: a 'Prefer Excel?' row holds Download and Upload, below the link", !!row && /Download Excel template/.test(row.text) && /Upload filled sheet/.test(row.text) && row.afterLink, JSON.stringify(row));
  ok("A: the warning sentence is in the instructions", await page.getByText("Changed numbers in the table? Download a fresh template before you use Excel again.").count() === 1);

  // Upload: the answer draws under the buttons, in the same card.
  await page.locator('input[type="file"][accept*=".xlsx"]').setInputFiles({ name: "sheet.csv", mimeType: "text/csv", buffer: Buffer.from("style,width,length,price,active\nTest Barn,10,12,1500,yes\nTest Barn,10,16,1700,yes\n") });
  await page.waitForSelector('[data-ss-xl-msg="ok"]', { timeout: 10000 }).catch(() => {});
  const banner = await page.evaluate(() => {
    const b = document.querySelector('[data-ss-xl-msg="ok"]');
    const lab = [...document.querySelectorAll("span")].find((s) => s.textContent === "Prefer Excel?");
    if (!b || !lab) return null;
    const card = lab.closest("div[style*='border-radius: 12px']") || lab.parentElement.parentElement;
    return { text: b.textContent, below: !!(lab.parentElement.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING), sameCard: card.contains(b),
      topBanner: [...document.querySelectorAll("div")].some((d) => d !== b && /^Imported/.test(d.textContent || "") && !card.contains(d)) };
  });
  ok("A: the upload's answer draws under the Excel buttons, inside the card", !!banner && /Imported 2 size\(s\)/.test(banner.text) && banner.below && banner.sameCard && !banner.topBanner, JSON.stringify(banner));

  // Download: fresh catalog + size_table, the sheet built from size_table (exceljs is unreachable here,
  // so the card's own fallback hands back a CSV, which is easy to read).
  const before = calls.length;
  const dlP = page.waitForEvent("download", { timeout: 15000 }).catch(() => null);
  await page.getByRole("button", { name: /Download Excel template/ }).click();
  const dl = await dlP;
  const fresh = calls.slice(before).filter((c) => c.fn === "portal-settings");
  ok("A: Download reads catalog and size_table afresh, targetClientId on both bodies",
    fresh.some((c) => c.action === "size_table" && "targetClientId" in c.body) && fresh.some((c) => c.action === "catalog" && "targetClientId" in c.body && c.body.withUnpriced === true),
    fresh.map((c) => `${c.action}:${JSON.stringify(c.body.targetClientId)}`).join(" "));
  let csv = "";
  if (dl) { try { csv = readFileSync(await dl.path(), "utf8"); } catch (_e) { /* no file */ } }
  const lines = csv.trim().split(/\r?\n/);
  const t = S.table(OWN);
  ok("A: the sheet has a row per size, from size_table", lines.length === 1 + t.sizes.length && /^style,width,length,price,Loft \(sq ft\),/.test(lines[0]), `${lines.length} lines; ${lines[0] && lines[0].slice(0, 80)}`);
  ok("A: the sheet's option header carries the long door name whole", lines[0] && lines[0].includes(LONG.replace(/"/g, '""')), lines[0] && lines[0].slice(0, 400));
  ok("A: a size's included 480 and 1200 reach the sheet", lines.some((l) => /,480,/.test(l)) && lines.some((l) => /,1200,/.test(l)));

  // The guard: counts that never add up refuse the download.
  S.countSkew = true;
  const before2 = calls.length;
  const dl2P = page.waitForEvent("download", { timeout: 4000 }).catch(() => null);
  await page.getByRole("button", { name: /Download Excel template/ }).click();
  await page.waitForSelector('[data-ss-xl-msg="err"]', { timeout: 10000 }).catch(() => {});
  const refused = await page.locator('[data-ss-xl-msg="err"]').textContent().catch(() => "");
  ok("A: a read that never adds up is refused, after one more try", /Couldn't read your whole catalog just now/.test(refused || "") && calls.slice(before2).filter((c) => c.action === "size_table").length === 2, refused);
  ok("A: …and nothing was downloaded", !(await dl2P));
  S.countSkew = false;

  // …but ONLY a count refuses it. Past the 1000-row cap, or with an orphan row, the table opens
  // view-only and sends the builder here, so the sheet must still be built: the importer never
  // touches a column or a size the sheet does not carry, so neither can put a false 0 in it.
  const builds = async (what) => {
    const from = calls.length;
    const p = page.waitForEvent("download", { timeout: 15000 }).catch(() => null);
    await page.getByRole("button", { name: /Download Excel template/ }).click();
    const d = await p;
    await page.waitForTimeout(200);
    // exceljs is unreachable here, so the card says it handed back a CSV instead; that is not a refusal.
    const msg = (await page.locator('[data-ss-xl-msg="err"]').textContent().catch(() => "")) || "";
    ok(`A: ${what}: the sheet is still built, from one read`, !!d && !/Couldn't read your/.test(msg) && calls.slice(from).filter((c) => c.action === "size_table").length === 1,
      `${d ? "downloaded" : "no download"}; ${msg}`);
  };
  const plainCat = S.cat, plainTable = S.table;
  const capped = catalogFor(OWN);
  capped.items = [...capped.items, ...Array.from({ length: 1000 }, (_, i) => ({ key: `bulk${i}`, label: `Bulk Item ${i}`, archived: true }))];
  S.cat = (cid) => ({ ...capped, clientId: cid });
  await builds("past the 1000-row cap");
  S.cat = plainCat;
  S.table = (cid) => {
    const tt = plainTable(cid);
    const incs = [...tt.inclusions, { size_id: uid("7", 9999), item_key: "loft", included: true, qty: 5 }];
    return { ...tt, inclusions: incs, counts: { sizes: tt.sizes.length, inclusions: incs.length } };
  };
  await builds("an inclusion on a size that is not there");
  S.table = plainTable;

  // A column added after Sheds loaded (Options, in another tab) is in the sheet Download builds, so
  // uploading that same sheet must carry its boxes too. The card's own catalog was last read before
  // this door existed; an upload that maps headers through it drops the column and still says "Imported".
  const LATE = { id: 555, name: "Test Late Door", category: "door", width_in: 36, height_in: 76, active: true, archived: false };
  S.cat = (cid) => { const c = plainCat(cid); return { ...c, fixtures: [...c.fixtures, LATE] }; };
  const lateP = page.waitForEvent("download", { timeout: 15000 }).catch(() => null);
  await page.getByRole("button", { name: /Download Excel template/ }).click();
  const lateDl = await lateP;
  let lateCsv = "";
  if (lateDl) { try { lateCsv = readFileSync(await lateDl.path(), "utf8"); } catch (_e) { /* no file */ } }
  ok("A: a column added since Sheds loaded is in the downloaded sheet", lateCsv.split(/\r?\n/)[0].includes("Test Late Door"), lateCsv.slice(0, 120));
  const upFrom = calls.length;
  await page.locator('input[type="file"][accept*=".xlsx"]').setInputFiles({ name: "sheet.csv", mimeType: "text/csv", buffer: Buffer.from(lateCsv) });
  await page.waitForSelector('[data-ss-xl-msg="ok"]', { timeout: 10000 }).catch(() => {});
  const imp = calls.slice(upFrom).find((c) => c.action === "import_pricing_csv");
  const impRows = (imp && imp.body.rows) || [];
  ok("A: …and uploading that sheet sends the new column's boxes, not just the columns Sheds loaded with",
    impRows.length > 0 && impRows.every((r) => r.inclusions && String(LATE.id) in r.inclusions),
    imp ? `${impRows.length} rows; first row's keys: ${Object.keys((impRows[0] || {}).inclusions || {}).join(",")}` : "no import_pricing_csv call");
  S.cat = plainCat;

  // Add style: the answer links to the table, jumped to the new style.
  S.createdStyleId = uid("5", 42);
  await page.getByPlaceholder("Building style name (e.g. Lofted Barn)").fill("Test Garden Shed");
  await page.getByPlaceholder("Serial code *").fill("TGS");
  await page.getByRole("button", { name: "Add style" }).click();
  await page.waitForSelector("text=Open the sizes & prices table", { timeout: 10000 }).catch(() => {});
  const added = await page.evaluate(() => {
    const a = [...document.querySelectorAll("a")].find((x) => x.textContent === "Open the sizes & prices table");
    return a ? { href: a.getAttribute("href"), target: a.getAttribute("target"), text: a.parentElement.textContent } : null;
  });
  ok("A: Add style's answer links to the table with ?style=<new id>", !!added && added.href === `/settings/sheds-table?style=${uid("5", 42)}` && added.target === "_blank" && /Building style “Test Garden Shed” added\./.test(added.text), JSON.stringify(added));
  await page.screenshot({ path: join(shots, "A-sheds-card.png"), fullPage: true });
  ok("A: no page errors", errors.length === 0, errors.join(" | "));

  // ── B: the new tab ──
  const popupP = ctx.waitForEvent("page", { timeout: 10000 }).catch(() => null);
  await page.getByText("Open sizes & prices table").click();
  const tab = await popupP;
  ok("B: the link opens a new tab", !!tab);
  if (tab) {
    const tabErrors = [];
    tab.on("pageerror", (e) => tabErrors.push(e.message));
    tab.on("console", (m) => { if (m.type() === "error" && /Minified React error|#310/.test(m.text())) tabErrors.push(m.text()); });
    await tab.waitForURL(/sheds-table/, { timeout: 10000 }).catch(() => {});
    const url = new URL(tab.url() || "about:blank");
    ok("B: the new tab's address is /settings/sheds-table", url.pathname === "/settings/sheds-table", tab.url());
    // A tab Chrome opens sends its first request before context routes attach: load it again.
    await tab.goto(`${BASE}/settings/sheds-table`);
    await waitGrid(tab).catch(() => {});
    const t2 = await tab.evaluate(() => ({
      path: location.pathname,
      title: document.title,
      back: (() => { const a = document.querySelector(".ss-pg-back"); return a ? { text: a.textContent, href: a.getAttribute("href") } : null; })(),
      legend: (document.querySelector(".ss-pg-legend") || {}).textContent || "",
      bands: [...document.querySelectorAll(".ss-pg-band b")].map((b) => b.textContent),
      rows: document.querySelectorAll(".ss-pg-grid tbody tr[data-s]").length,
      shell: !!document.querySelector(".ss-shell"),
      badge: (document.querySelector(".ss-pg-badge") || {}).textContent || "",
    }));
    ok("B: the address stays /settings/sheds-table once the shell has settled", t2.path === "/settings/sheds-table", t2.path);
    ok("B: the tab's title names the account", t2.title === `Sizes & prices · ${COMPANY[OWN]} · Structure Studio`, t2.title);
    ok("B: chromeless (no rail, no top bar), with Back to Sheds", !t2.shell && t2.back && /Back to Sheds/.test(t2.back.text) && t2.back.href === "/settings/sheds", JSON.stringify(t2.back));
    ok("B: the legend reads as the plan says", t2.legend === "Empty = not included. A number = how many come included (loft = sq ft). Blank price = size not offered. $0 = free.", t2.legend);
    ok("B: three style bands, in order", JSON.stringify(t2.bands) === JSON.stringify(["Test Barn", "Test Lofted Barn", "Test Utility Shed"]), JSON.stringify(t2.bands));
    ok("B: every size is a row (hidden ones shown by default)", t2.rows === t.sizes.length, `${t2.rows} of ${t.sizes.length}`);
    ok("B: the badge says all changes saved", /^All changes saved · /.test(t2.badge), t2.badge);
    ok("B: no page errors, no React #310", tabErrors.length === 0, tabErrors.join(" | "));
    await tab.close();
  }
  await ctx.close();
}

// ── B2: ?style= jumps and leaves the address ──
if (want("B")) {
  const { ctx, page, errors, S } = await open(`/settings/sheds-table?style=${uid("5", 3)}`, {}, { width: 1440, height: 700 });
  await waitGrid(page).catch(() => {});
  await page.waitForTimeout(300);
  const r = await page.evaluate((id) => {
    const box = document.querySelector(".ss-pg-box");
    const band = document.querySelector(`tr[data-band="${id}"]`);
    const head = document.querySelector(".ss-pg-names th.ss-pg-f0");   // sticky: <thead>'s own box scrolls away
    const bb = band && band.getBoundingClientRect(), hb = head && head.getBoundingClientRect();
    return { search: location.search, scrollTop: box.scrollTop, bandTop: bb && Math.round(bb.top), headBottom: hb && Math.round(hb.bottom),
      readout: (document.querySelector(".ss-pg-readout") || {}).textContent || "" };
  }, uid("5", 3));
  ok("B: ?style= jumps that style's band to just under the header", r.scrollTop > 0 && Math.abs(r.bandTop - r.headBottom) <= 2, JSON.stringify(r));
  ok("B: …lands on its first price", /^Price · Test Utility Shed /.test(r.readout), r.readout);
  ok("B: …and ?style= leaves the address", r.search === "", r.search);
  ok("B: no page errors", errors.length === 0, errors.join(" | "));
  void S;
  await ctx.close();
}

// ── C: headers at 1280 and 1440, pinned panes, fitting numbers. 25 option columns fit across 1280,
// so the sideways pin is proved at 1000 px, where the grid has to scroll; the plan's 210 x 38 fixture
// scrolls sideways at both widths. ──
const C_RUNS = [
  { width: 1280, shot: "pricing-table-headers-1280.png" },
  { width: 1440, shot: "pricing-table-headers-1440.png" },
  { width: 1000 },
  { width: 1280, big: true, shot: "pricing-table-headers-38-columns-1280.png" },
  { width: 1440, big: true, shot: "pricing-table-headers-38-columns-1440.png" },
];
for (const run of want("C") ? C_RUNS : []) {
  const { width } = run;
  const tag = (run.big ? "C38@" : "C@") + width;
  const bigCat = run.big ? catalogFor(OWN, { extra: 13 }) : null;
  const S0 = run.big ? { cat: () => bigCat, table: (() => { const t = tableFor(OWN, bigCat, { perStyle: 70 }); return () => t; })() } : {};
  const nCols = OPTION_KEYS(run.big ? bigCat : catalogFor(OWN)).length;
  const { ctx, page, errors } = await open("/settings/sheds-table", S0, { width, height: 900 });
  await waitGrid(page).catch(() => {});
  await page.waitForTimeout(400);
  const h = await page.evaluate(() => {
    const spans = [...document.querySelectorAll(".ss-pg-grid thead .ss-pg-vh")];
    const cut = spans.filter((sp) => {
      const th = sp.closest("th"), r = sp.getBoundingClientRect(), tr = th.getBoundingClientRect();
      const lines = Math.round(r.width / 15);
      // The cell must not overflow at all (the plan's test); the name may not run past its own box or
      // onto a third line. A bold glyph's ink can stand 1 px proud of its 15 px line: that clips nothing.
      return lines > 2 || sp.scrollHeight > sp.clientHeight + 1 || sp.scrollWidth > sp.clientWidth + 1
        || th.scrollHeight > th.clientHeight || th.scrollWidth > th.clientWidth || r.bottom > tr.bottom + 0.5 || r.right > tr.right + 0.5;
    }).map((sp) => sp.textContent);
    const names = document.querySelector(".ss-pg-names th.ss-pg-oh");
    const longest = spans.reduce((a, sp) => (sp.textContent.length > a.length ? sp.textContent : a), "");
    const two = spans.filter((sp) => Math.round(sp.getBoundingClientRect().width / 15) === 2);
    // Read with the head tilted right, line one must be the upper line, i.e. the RIGHT one on screen:
    // the name's first letter stands right of its last.
    const charX = (t, i) => { const rg = document.createRange(); rg.setStart(t, i); rg.setEnd(t, i + 1); const b = rg.getBoundingClientRect(); return b.left + b.width / 2; };
    const backwards = two.filter((sp) => { const t = sp.firstChild; return !(charX(t, 0) > charX(t, t.length - 1)); }).map((sp) => sp.textContent);
    return { n: spans.length, cut, headH: names ? Math.round(names.getBoundingClientRect().height) : 0, longest, twoLine: two.length, backwards,
      ellipsis: spans.some((sp) => getComputedStyle(sp).textOverflow === "ellipsis") };
  });
  ok(`${tag}: ${nCols} option headers plus Offered, none cut`, h.n === nCols + 1 && h.cut.length === 0, `cut: ${JSON.stringify(h.cut)}; header ${h.headH}px; ${h.twoLine} on two lines`);
  ok(`${tag}: a two-line name reads in order (first line on the right, top to bottom)`, h.twoLine > 0 && h.backwards.length === 0, JSON.stringify(h.backwards));
  ok(`${tag}: the longest name is the 46-character door, drawn whole`, h.longest === LONG, h.longest);
  ok(`${tag}: no ellipsis on the headers at this width`, !h.ellipsis);
  const fit = await page.evaluate(() => {
    const cells = [...document.querySelectorAll(".ss-pg-grid tbody td[data-c]")].filter((td) => td.textContent === "480" || td.textContent === "1200");
    return { n: cells.length, over: cells.filter((td) => td.scrollWidth > td.clientWidth).map((td) => td.textContent), w: cells[0] ? Math.round(cells[0].getBoundingClientRect().width) : 0 };
  });
  ok(`${tag}: "480" and "1200" fit their 44 px boxes`, fit.n > 0 && fit.over.length === 0 && fit.w === 44, JSON.stringify(fit));
  // A price can outgrow the 76 px Price box ("$123,456.78", or three decimals shown as stored): it
  // ends in an ellipsis there, so its title must carry it whole. Every cut price, not just this one.
  const wide = await page.evaluate((text) => {
    const tds = [...document.querySelectorAll(".ss-pg-grid tbody td.ss-pg-price")];
    const td = tds.find((x) => x.textContent === text);
    return { found: !!td, cutHere: td ? td.scrollWidth > td.clientWidth : null, title: td ? td.title : null,
      unreadable: tds.filter((x) => x.scrollWidth > x.clientWidth && !(x.title || "").includes(x.textContent)).map((x) => x.textContent) };
  }, "$123,456.78");
  ok(`${tag}: a price wider than its box reads whole in its title`, wide.found && wide.title === "$123,456.78" && wide.unreadable.length === 0, JSON.stringify(wide));
  // Pinned on both axes: scroll the box right and down; Size/Price/Offered and the header stay put.
  const pin = await page.evaluate(async () => {
    const box = document.querySelector(".ss-pg-box");
    const bb = box.getBoundingClientRect();
    const first = document.querySelector(".ss-pg-grid tbody tr[data-s]");
    const band = document.querySelector(".ss-pg-grid .ss-pg-band .ss-pg-bandin");
    const at = () => ({ size: first.children[0].getBoundingClientRect(), price: first.children[1].getBoundingClientRect(), off: first.children[2].getBoundingClientRect(),
      opt: document.querySelector(".ss-pg-names th.ss-pg-oh").getBoundingClientRect(), band: band.getBoundingClientRect() });
    const a = at();
    box.scrollLeft = 400; box.scrollTop = 0;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const b = at();
    box.scrollTop = 300;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const headRow = document.querySelector(".ss-pg-names th.ss-pg-f0").getBoundingClientRect();
    const res = { scrollLeft: box.scrollLeft, scrollTop: box.scrollTop, sizeX: [Math.round(a.size.left), Math.round(b.size.left)], priceX: [Math.round(a.price.left), Math.round(b.price.left)],
      offX: [Math.round(a.off.left), Math.round(b.off.left)], optX: [Math.round(a.opt.left), Math.round(b.opt.left)], bandX: [Math.round(a.band.left), Math.round(b.band.left)], headTop: Math.round(headRow.top), boxTop: Math.round(bb.top), boxLeft: Math.round(bb.left),
      pageX: document.documentElement.scrollWidth <= window.innerWidth, pageY: document.documentElement.scrollHeight <= window.innerHeight };
    box.scrollLeft = 0; box.scrollTop = 0;
    return res;
  });
  const sideways = pin.scrollLeft > 0 && pin.sizeX[0] === pin.sizeX[1] && pin.priceX[0] === pin.priceX[1] && pin.offX[0] === pin.offX[1] && pin.optX[1] < pin.optX[0];
  if (width === 1000) ok(`${tag}: Size, Price and Offered stay pinned while the grid scrolls sideways`, sideways, JSON.stringify(pin));
  else ok(`${tag}: the grid fits across without a sideways scroll, or stays pinned in one`, pin.scrollLeft === 0 || sideways, JSON.stringify(pin));
  // The style's name, too (plan 3.6): a band cell that is a scroll container would let it scroll away.
  ok(`${tag}: a style's name stays at the left edge while the grid scrolls sideways`, pin.scrollLeft === 0 || pin.bandX[0] === pin.bandX[1], JSON.stringify({ scrollLeft: pin.scrollLeft, bandX: pin.bandX }));  ok(`${tag}: the header stays pinned while it scrolls down`, pin.scrollTop > 0 && pin.headTop === pin.boxTop + 22, JSON.stringify({ headTop: pin.headTop, boxTop: pin.boxTop }));
  ok(`${tag}: the page itself never scrolls, either way`, pin.pageX && pin.pageY);
  const thead = await page.locator(".ss-pg-grid thead").boundingBox();
  if (run.shot) await page.screenshot({ path: join(headerShots, run.shot), clip: { x: 0, y: 0, width, height: Math.min(900, Math.round(thead.y + thead.height + 28 * 6)) } });
  await page.screenshot({ path: join(shots, `${tag.replace("@", "-")}-full.png`) });
  ok(`${tag}: no page errors`, errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// ── D: the grid's moves, readout, folding, jump, ARIA ──
if (want("D")) {
  const { ctx, page, errors, S } = await open("/settings/sheds-table", {}, { width: 1440, height: 800 });
  await waitGrid(page).catch(() => {});
  const t = S.table(OWN);
  const firstId = t.sizes.filter((z) => z.style_id === t.styles[0].id)[0].id;
  await page.locator(`tr[data-s="${firstId}"] td[data-c="1"]`).click();
  const read = () => page.evaluate(() => ({ readout: document.querySelector(".ss-pg-readout").textContent,
    sel: [...document.querySelectorAll('[aria-selected="true"]')].map((td) => `${td.parentElement.getAttribute("data-s")}:${td.getAttribute("data-c")}`),
    focus: document.activeElement && document.activeElement.className }));
  const r1 = await read();
  ok("D: a click makes that cell active: the readout names the column and size", r1.readout === "Price · Test Barn 8x12" && r1.sel.length === 1 && r1.sel[0] === `${firstId}:1` && /ss-pg-grid/.test(r1.focus), JSON.stringify(r1));
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  const r2 = await read();
  ok("D: arrows move it; one cell is selected at a time", r2.readout === "Shelving · Test Barn 10x12" && r2.sel.length === 1 && r2.sel[0].endsWith(":5"), JSON.stringify(r2));
  await page.keyboard.press("Home");
  const r3 = await read();
  ok("D: Home goes to the row's Size", /^Size · Test Barn /.test(r3.readout), r3.readout);
  await page.hover(".ss-pg-names th.ss-pg-oh >> nth=2");
  const peek = await page.locator(".ss-pg-readout").textContent();
  ok("D: pointing at a header shows its full name in the readout", peek === "Shelving", peek);
  const aria = await page.evaluate(() => {
    const g = document.querySelector(".ss-pg-grid");
    const row = g.querySelector("tbody tr[data-s]");
    return { role: g.getAttribute("role"), rows: Number(g.getAttribute("aria-rowcount")), cols: Number(g.getAttribute("aria-colcount")),
      rowRole: row.getAttribute("role"), rowIdx: row.getAttribute("aria-rowindex"), cellRole: row.children[3].getAttribute("role"), cellIdx: row.children[3].getAttribute("aria-colindex"),
      th: document.querySelector(".ss-pg-names th.ss-pg-oh").getAttribute("aria-label"), live: document.querySelector(".ss-pg-badge").getAttribute("aria-live"),
      trs: g.querySelectorAll("tr").length };
  });
  ok("D: ARIA: grid with row and column counts, rows and gridcells indexed, named headers, a polite badge",
    aria.role === "grid" && aria.rows === aria.trs && aria.cols === 28 && aria.rowRole === "row" && aria.rowIdx === "4" && aria.cellRole === "gridcell" && aria.cellIdx === "4" && aria.th === "Loft (sq ft)" && aria.live === "polite", JSON.stringify(aria));
  // Show hidden sizes: off folds them away, and is remembered.
  const isHid = (z) => z.base_price == null || !z.active;
  const hiddenN = t.sizes.filter(isHid).length;
  // The cursor on a hidden size when they fold: it moves to the next size still drawn, and the
  // arrows carry on from there, not from the top-left of the grid. (The toggle takes focus, so the
  // grid is focused again by hand, as Tab back into it would; that keeps the cursor where it is.)
  const full = t.styles.flatMap((s) => t.sizes.filter((z) => z.style_id === s.id).sort((a, b) => a.sort_order - b.sort_order));
  const hi = full.findIndex((z, i) => i > 0 && isHid(z));
  const below = full.slice(hi + 1).filter((z) => !isHid(z));
  const named = (z) => `Loft (sq ft) · ${t.styles.find((s) => s.id === z.style_id).label} ${z.label}`;
  await page.locator(`tr[data-s="${full[hi].id}"] td[data-c="3"]`).click();
  // Leaving the header clears its peek in the readout a beat after the click (not a discrete event).
  await page.waitForFunction((x) => document.querySelector(".ss-pg-readout").textContent === x, named(full[hi]), { timeout: 3000 }).catch(() => {});
  const r4a = await read();
  await page.getByLabel("Show hidden sizes").uncheck();
  const r4 = await read();
  await page.locator(".ss-pg-grid").focus();
  await page.keyboard.press("ArrowDown");
  const r5 = await read();
  ok("D: a cursor on a hidden size that folds away moves to the next size still drawn",
    r4a.readout === named(full[hi]) && r4.readout === named(below[0]) && r4.sel.length === 1 && r4.sel[0] === `${below[0].id}:3`, JSON.stringify({ was: r4a.readout, now: r4 }));
  ok("D: …and the next arrow key carries on from there", r5.readout === named(below[1]) && r5.sel[0] === `${below[1].id}:3`, JSON.stringify(r5));
  const folded = await page.locator(".ss-pg-grid tbody tr[data-s]").count();
  ok("D: 'Show hidden sizes' off folds the hidden sizes away", folded === t.sizes.length - hiddenN && hiddenN > 0, `${folded} rows, ${hiddenN} hidden`);
  await page.reload();
  await waitGrid(page).catch(() => {});
  const remembered = await page.locator(".ss-pg-grid tbody tr[data-s]").count();
  ok("D: …and it is remembered on the next load", remembered === t.sizes.length - hiddenN && !(await page.getByLabel("Show hidden sizes").isChecked()), String(remembered));
  await page.getByLabel("Show hidden sizes").check();
  // Hidden rows are drawn at 55% text.
  const dim = await page.evaluate(() => { const tr = document.querySelector("tr.ss-pg-hid"); return tr ? getComputedStyle(tr.children[0]).color : null; });
  ok("D: a hidden size is drawn at 55%", dim === "rgba(30, 41, 59, 0.55)", dim);
  // Jump to style. The middle style's band lands just under the header. The last style has too few
  // rows under it to reach the top, so the box goes to its end and the band shows below the header.
  const jumpTo = async (label, id) => {
    await page.locator(".ss-pg-jump").selectOption({ label });
    await page.waitForTimeout(250);
    return page.evaluate((sid) => {
      const box = document.querySelector(".ss-pg-box");
      const band = document.querySelector(`tr[data-band="${sid}"]`).getBoundingClientRect();
      const head = document.querySelector(".ss-pg-names th.ss-pg-f0").getBoundingClientRect();
      return { band: Math.round(band.top), head: Math.round(head.bottom), atEnd: Math.abs(box.scrollTop + box.clientHeight - box.scrollHeight) <= 1,
        boxBottom: Math.round(box.getBoundingClientRect().bottom), readout: document.querySelector(".ss-pg-readout").textContent, val: document.querySelector(".ss-pg-jump").value };
    }, id);
  };
  const j = await jumpTo("Test Lofted Barn", t.styles[1].id);
  ok("D: Jump to style puts the band just under the header and lands on its first price", Math.abs(j.band - j.head) <= 2 && /^Price · Test Lofted Barn /.test(j.readout) && j.val === "", JSON.stringify(j));
  const jl = await jumpTo("Test Utility Shed", t.styles[2].id);
  ok("D: …the last style scrolls as far as the grid goes, its band in view under the header", (Math.abs(jl.band - jl.head) <= 2 || (jl.atEnd && jl.band >= jl.head - 2 && jl.band < jl.boxBottom))
    && /^Price · Test Utility Shed /.test(jl.readout), JSON.stringify(jl));
  // The legend folds.
  await page.locator(".ss-pg-q").click();
  ok("D: '?' folds the legend", !(await page.locator(".ss-pg-legend").count()));
  await page.screenshot({ path: join(shots, "D-grid.png") });
  ok("D: no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// ── D2: hidden styles fold into their own section ──
if (want("D")) {
  const { ctx, page, errors } = await open("/settings/sheds-table", { table: (cid) => tableFor(cid, catalogFor(cid), { hiddenStyle: true }) });
  await waitGrid(page).catch(() => {});
  const before = await page.locator(".ss-pg-band b").allTextContents();
  const hs = page.locator(".ss-pg-hs button");
  ok("D: a hidden style is folded into 'Hidden styles (not in your designer)'", (await hs.count()) === 1 && !before.includes("Test Retired Style") && /Hidden styles \(not in your designer\) · 1/.test(await hs.textContent()), JSON.stringify(before));
  await hs.click();
  ok("D: …which opens to show it", (await page.locator(".ss-pg-band b").allTextContents()).includes("Test Retired Style"));
  ok("D: no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// ── E: loading, failure, empty, no columns, too big ──
if (want("E")) {
  const { ctx, page, errors, S } = await open(null, { sizeTableDelayMs: 1500 });
  await page.goto(`${BASE}/settings/sheds-table`);
  await page.waitForSelector(".ss-pg-skel", { timeout: 15000 }).catch(() => {});
  ok("E: while it loads: a skeleton grid and 'Loading…'", (await page.locator(".ss-pg-skel").count()) === 1 && (await page.locator(".ss-pg-badge").textContent()) === "Loading…");
  await page.screenshot({ path: join(shots, "E-loading.png") });
  await waitGrid(page).catch(() => {});
  ok("E: …then the grid", (await page.locator(".ss-pg-grid tbody tr[data-s]").count()) > 0);
  S.sizeTableDelayMs = 0; S.sizeTableFailures = 2;   // the first read and its retry by the user both fail once each
  await page.reload();
  await page.waitForSelector(".ss-pg-fail", { timeout: 15000 }).catch(() => {});
  const fail = await page.locator(".ss-pg-fail").textContent().catch(() => "");
  ok("E: a failed read says so, with Retry", /Couldn't load your sizes\./.test(fail) && /Retry/.test(fail) && (await page.locator(".ss-pg-badge").textContent()) === "Couldn't load", fail);
  await page.screenshot({ path: join(shots, "E-failed.png") });
  await page.getByRole("button", { name: "Retry" }).click();
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Retry" }).click().catch(() => {});
  await waitGrid(page).catch(() => {});
  ok("E: Retry recovers", (await page.locator(".ss-pg-grid tbody tr[data-s]").count()) > 0);
  ok("E: no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}
if (want("E")) {
  const { ctx, page, errors } = await open("/settings/sheds-table", { table: (cid) => tableFor(cid, catalogFor(cid), { noStyles: true }) });
  await page.waitForSelector("text=No building styles yet.", { timeout: 15000 }).catch(() => {});
  const t = await page.locator(".ss-pg-msg-inline").textContent().catch(() => "");
  ok("E: no styles: 'No building styles yet. Add one on Sheds.' with the link", /No building styles yet\. Add one on Sheds\./.test(t) && (await page.locator('.ss-pg-msg-inline a[href="/settings/sheds"]').count()) === 1, t);
  ok("E: no page errors (no styles)", errors.length === 0, errors.join(" | "));
  await ctx.close();
}
if (want("E")) {
  const { ctx, page, errors } = await open("/settings/sheds-table", { cat: (cid) => catalogFor(cid, { cols: "none" }) });
  await waitGrid(page).catch(() => {});
  const box = await page.locator(".ss-pg-optbox").textContent().catch(() => "");
  const heads = await page.locator(".ss-pg-names th").count();
  ok("E: no option columns: Size, Price and Offered still show, under the Options box", /Set up your Options first\./.test(box) && heads === 3 && (await page.locator('.ss-pg-optbox a[href="/settings/options"]').count()) === 1, `${heads} headers; ${box}`);
  ok("E: no page errors (no columns)", errors.length === 0, errors.join(" | "));
  await page.screenshot({ path: join(shots, "E-no-columns.png") });
  await ctx.close();
}
if (want("E")) {
  const { ctx, page, calls, errors } = await open(null, { countSkew: true });
  await page.goto(`${BASE}/settings/sheds-table`);
  await waitGrid(page).catch(() => {});
  await page.waitForSelector(".ss-pg-status-amber", { timeout: 10000 }).catch(() => {});
  const st = await page.locator(".ss-pg-status-amber").textContent().catch(() => "");
  const reads = calls.filter((c) => c.action === "size_table").length;
  ok("E: counts that never add up: read twice, then 'too big' and view-only", reads === 2 && /This catalog is too big for the table right now\. Use the Excel sheet, and let us know\./.test(st) && /Reload/.test(st)
    && (await page.locator(".ss-pg").getAttribute("data-ss-pg-editable")) === "0" && /^View only/.test(await page.locator(".ss-pg-badge").textContent()), `${reads} reads; ${st}`);
  ok("E: no page errors (too big)", errors.length === 0, errors.join(" | "));
  await ctx.close();
}
// Real-Time Pricing on: every price is grey AND locked (plan 3.9, 3.13: a shape as well as a colour).
// The lock is the cell's ::before, placed in its corner, so the cell must be its box at both widths:
// sticky when frozen, relative below 700 px where the price is not frozen.
for (const width of want("E") ? [1440, 390] : []) {
  const { ctx, page, errors } = await open("/settings/sheds-table", { table: (cid) => tableFor(cid, catalogFor(cid), { rtpOn: true }) }, { width, height: 844 });
  await waitGrid(page).catch(() => {});
  const r = await page.evaluate(() => {
    const tds = [...document.querySelectorAll(".ss-pg-grid tbody td.ss-pg-price")];
    const lock = (x) => getComputedStyle(x, "::before");
    const priced = tds.find((x) => x.textContent);
    // A relative cell still takes `left`: it must stay under its own header, not shift right.
    const col = Math.round(document.querySelector(".ss-pg-names th.ss-pg-f1").getBoundingClientRect().left);
    return { n: tds.length, rtp: tds.filter((x) => x.classList.contains("ss-pg-rtp")).length,
      offColumn: tds.filter((x) => Math.round(x.getBoundingClientRect().left) !== col).length,
      locked: tds.filter((x) => /\u{1F512}/u.test(lock(x).content) && lock(x).position === "absolute").length,
      boxed: tds.filter((x) => getComputedStyle(x).position !== "static").length,
      grey: priced ? getComputedStyle(priced).backgroundColor : null, title: priced ? priced.title : null,
      head: (document.querySelector(".ss-pg-names th.ss-pg-f1") || {}).textContent || "" };
  });
  ok(`E@${width}: Real-Time Pricing greys every price and locks it in its own cell, and the title says why`,
    r.n > 0 && r.rtp === r.n && r.locked === r.n && r.boxed === r.n && r.offColumn === 0 && r.grey === "rgb(241, 245, 249)"
    && /^\$[\d,.]+ · Real-Time Pricing sets prices on this account$/.test(r.title || "") && /\u{1F512}/u.test(r.head), JSON.stringify(r));
  await page.screenshot({ path: join(shots, `E-rtp-${width}.png`) });
  ok(`E@${width}: no page errors (RTP)`, errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// ── F: view-as and permissions ──
if (want("F")) {
  // is_operator answers 2.5 s late, so the hold is long enough to see: the tab is the operator's OWN
  // account until it answers, and nothing may be read for it.
  const { ctx, page, calls, errors } = await open(`/settings/sheds-table?view=${VIEWED}`, { own: OPS, operator: true, operatorDelayMs: 2500 });
  await page.waitForSelector(".ss-pg-msg", { timeout: 15000 }).catch(() => {});
  const holding = await page.locator(".ss-pg-msg").textContent().catch(() => "");
  const readsWhileHeld = tableCalls(calls).length + calls.filter((c) => c.action === "size_table").length;
  ok("F: while the operator check is out, the tab says 'Opening <builder>…' and reads no table", holding === `Opening ${VIEWED}…` && readsWhileHeld === 0, `${holding}; ${readsWhileHeld} reads`);
  await waitGrid(page).catch(() => {});
  await page.waitForFunction((name) => (document.querySelector(".ss-pg-op") || {}).textContent === `Editing ${name} as operator. Changes are live.`, COMPANY[VIEWED], { timeout: 10000 }).catch(() => {});
  const tc = tableCalls(calls);
  ok("F: an operator's cold ?view= load reads the table for the viewed builder only",
    tc.length >= 2 && tc.every((c) => c.body.targetClientId === VIEWED), tc.map((c) => `${c.action}->${c.body.targetClientId}`).join(" "));
  const f = await page.evaluate(() => ({ strip: (document.querySelector(".ss-pg-op") || {}).textContent || "", co: (document.querySelector(".ss-pg-co") || {}).textContent || "",
    title: document.title, editable: document.querySelector(".ss-pg").getAttribute("data-ss-pg-editable"), back: document.querySelector(".ss-pg-back").getAttribute("href") }));
  ok("F: the red operator strip names the builder (their company name, not the address's slug)", f.strip === `Editing ${COMPANY[VIEWED]} as operator. Changes are live.` && f.co === COMPANY[VIEWED], JSON.stringify(f));
  ok("F: …and so does the tab's title", f.title === `Sizes & prices · ${COMPANY[VIEWED]} · Structure Studio`, f.title);
  ok("F: Back to Sheds keeps ?view=", f.back === `/settings/sheds?view=${VIEWED}`, f.back);
  ok("F: an operator in view-as may edit", f.editable === "1");
  await page.screenshot({ path: join(shots, "F-view-as.png") });
  ok("F: no page errors (view-as)", errors.length === 0, errors.join(" | "));
  await ctx.close();
}
for (const refused of want("F") ? [false, true] : []) {
  const { ctx, page, calls, errors } = await open(`/settings/sheds-table?view=${VIEWED}&as=${WEAR}`, { own: OPS, operator: true, peopleRefused: refused });
  await waitGrid(page).catch(() => {});
  // The person's name comes from the people list after the grid's reads; give it a moment.
  if (!refused) await page.waitForFunction((n) => ((document.querySelector(".ss-pg-status") || {}).textContent || "").includes(n), WEAR_NAME, { timeout: 5000 }).catch(() => {});
  else await page.waitForTimeout(800);
  const f = await page.evaluate(() => ({ strip: (document.querySelector(".ss-pg-op") || {}).textContent || "", badge: document.querySelector(".ss-pg-badge").textContent,
    status: (document.querySelector(".ss-pg-status") || {}).textContent || "", editable: document.querySelector(".ss-pg").getAttribute("data-ss-pg-editable"),
    ro: document.querySelector(".ss-pg-grid").getAttribute("aria-readonly") }));
  const who = refused ? "a team member" : WEAR_NAME;
  const people = calls.filter((c) => c.fn === "operator-portal" && c.action === "list_users");
  ok(`F: ?as= opens view-only, and says why, naming ${refused ? "nobody when the people list is refused" : "the person"}`,
    f.editable === "0" && f.ro === "true" && f.badge === "View only: viewing as a team member"
    && f.status.includes(`You're viewing as ${who}. The table is view-only here;`) && f.strip === `Viewing ${COMPANY[VIEWED]} as operator. This table is view-only.`, JSON.stringify(f));
  ok("F: …the name is read for the viewed builder, once", people.length === 1 && people[0].body.clientId === VIEWED, JSON.stringify(people.map((c) => c.body)));
  ok("F: …and its reads still go to the viewed builder", tableCalls(calls).every((c) => c.body.targetClientId === VIEWED));
  ok("F: no page errors (as)", errors.length === 0, errors.join(" | "));
  await ctx.close();
}
// View-only for a reason other than ?as= (here the read never adds up): the strip must not say
// "Changes are live" beside a "View only" badge.
if (want("F")) {
  const { ctx, page, errors } = await open(`/settings/sheds-table?view=${VIEWED}`, { own: OPS, operator: true, countSkew: true });
  await waitGrid(page).catch(() => {});
  await page.waitForSelector(".ss-pg-status-amber", { timeout: 15000 }).catch(() => {});
  const f = await page.evaluate(() => ({ strip: (document.querySelector(".ss-pg-op") || {}).textContent || "", badge: document.querySelector(".ss-pg-badge").textContent,
    editable: document.querySelector(".ss-pg").getAttribute("data-ss-pg-editable") }));
  ok("F: a view-as page that is view-only because it is too big says view-only in the strip too",
    f.editable === "0" && /^View only/.test(f.badge) && f.strip === `Viewing ${COMPANY[VIEWED]} as operator. This table is view-only.`, JSON.stringify(f));
  ok("F: no page errors (view-as, too big)", errors.length === 0, errors.join(" | "));
  await ctx.close();
}
if (want("F")) {
  const t0 = Date.now();
  const { ctx, page, calls, errors } = await open(`/settings/sheds-table?view=${VIEWED}`, { own: OWN, operator: false });
  await page.waitForSelector(".ss-pg-msg", { timeout: 15000 }).catch(() => {});
  const early = await page.locator(".ss-pg-msg").textContent().catch(() => "");
  await page.waitForSelector("text=Couldn't open that account here.", { timeout: 14000 }).catch(() => {});
  const late = await page.locator(".ss-pg-msg").textContent().catch(() => "");
  const took = Date.now() - t0;
  ok("F: a non-operator holding ?view= sees 'Opening…'", early === `Opening ${VIEWED}…`, early);
  ok("F: …and after 10 s 'Couldn't open that account here.'", late === "Couldn't open that account here. Close this tab and use the button on Sheds again." && took >= 9500, `${late} after ${took} ms`);
  ok("F: …and no table read ever went out (never the user's own account)", tableCalls(calls).length === 0 && !calls.some((c) => c.action === "size_table"), tableCalls(calls).map((c) => c.action).join(","));
  ok("F: no page errors (hold)", errors.length === 0, errors.join(" | "));
  await ctx.close();
}
if (want("F")) {
  const { ctx, page, errors } = await open("/settings/sheds-table", { role: "user", access: { settings_structures: "view", designs: "view" } });
  await waitGrid(page).catch(() => {});
  const f = await page.evaluate(() => ({ badge: document.querySelector(".ss-pg-badge").textContent, editable: document.querySelector(".ss-pg").getAttribute("data-ss-pg-editable"),
    inputs: document.querySelectorAll(".ss-pg-grid input, .ss-pg-grid textarea, .ss-pg-grid [contenteditable]").length }));
  ok("F: a view-only access map opens view-only, with no editor", f.badge === "View only: no edit access" && f.editable === "0" && f.inputs === 0, JSON.stringify(f));
  ok("F: no page errors (view access)", errors.length === 0, errors.join(" | "));
  await ctx.close();
}
if (want("F")) {
  const { ctx, page, calls, errors } = await open("/settings/sheds-table", { role: "user", access: { designs: "view" } });
  await page.waitForTimeout(2500);
  const here = await page.evaluate(() => location.pathname);
  ok("F: no Sheds access: the table is not shown and no table read goes out", (await page.locator(".ss-pg-grid").count()) === 0 && !calls.some((c) => c.action === "size_table"), here);
  ok("F: no page errors (no access)", errors.length === 0, errors.join(" | "));
  await ctx.close();
}
if (want("F")) {
  const { ctx, page, calls, errors } = await open("/settings/sheds-table", { locked: true });
  await page.waitForSelector("text=This account's subscription needs attention.", { timeout: 15000 }).catch(() => {});
  const m = await page.locator(".ss-pg-msg").textContent().catch(() => "");
  ok("F: a billing lock shows the lock with a Billing link, not the table", /This account's subscription needs attention\./.test(m) && (await page.locator('.ss-pg-msg a[href="/settings/billing"]').count()) === 1 && !calls.some((c) => c.action === "size_table"), m);
  ok("F: no page errors (locked)", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// ── G: narrow ──
if (want("G")) {
  const { ctx, page, errors } = await open("/settings/sheds-table", {}, { width: 390, height: 844 });
  await waitGrid(page).catch(() => {});
  await page.waitForTimeout(300);
  const g = await page.evaluate(() => {
    const box = document.querySelector(".ss-pg-box").getBoundingClientRect();
    const rows = [...document.querySelectorAll(".ss-pg-grid tbody tr[data-s]")].filter((tr) => { const r = tr.getBoundingClientRect(); return r.top >= box.top && r.bottom <= box.bottom; });
    const head = document.querySelector(".ss-pg-names th.ss-pg-oh").getBoundingClientRect().height;
    return { pageW: document.documentElement.scrollWidth, vw: window.innerWidth, head: Math.round(head), visibleRows: rows.length,
      note: (document.querySelector(".ss-pg-narrow") || {}).textContent || "", legend: !!document.querySelector(".ss-pg-legend"),
      priceSticky: getComputedStyle(document.querySelector(".ss-pg-grid tbody td.ss-pg-f1")).position };
  });
  ok("G: 390 px: the page does not scroll sideways", g.pageW <= g.vw, `${g.pageW} vs ${g.vw}`);
  ok("G: the header is at most 90 px", g.head <= 90, String(g.head));
  ok("G: at least 8 rows show", g.visibleRows >= 8, String(g.visibleRows));
  ok("G: only Size stays frozen, the legend starts folded, and the computer note shows", g.priceSticky === "static" && !g.legend && /Easiest on a computer\./.test(g.note), JSON.stringify(g));
  await page.screenshot({ path: join(shots, "G-390.png") });
  ok("G: no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// ── P: editing and autosave (Phase 3) ──
const sel = (id, col) => `tr[data-s="${id}"] td[data-c="${col}"]`;
const saveCalls = (calls) => calls.filter((c) => c.fn === "portal-settings" && c.action === "save_pricing_cells");
const barnOf = (t) => t.sizes.filter((z) => z.style_id === t.styles[0].id).sort((a, b) => a.sort_order - b.sort_order);
const keyCol = (cat, key) => 3 + OPTION_KEYS(cat).indexOf(key);
const named = (z) => `Test Barn ${z.label}`;
const look = (page, id, col) => page.evaluate((s) => { const td = document.querySelector(s); return td ? { text: td.textContent, cls: td.className, invalid: td.getAttribute("aria-invalid") } : null; }, sel(id, col));
const state = (page) => page.evaluate(() => ({
  badge: (document.querySelector(".ss-pg-badge") || {}).textContent || "",
  readout: (document.querySelector(".ss-pg-readout") || {}).textContent || "",
  status: [...document.querySelectorAll(".ss-pg-status > span")].map((d) => d.textContent).join(" | "),
  editor: (() => { const i = document.querySelector(".ss-pg-ed"); return i ? { value: i.value, label: i.getAttribute("aria-label"), mode: i.inputMode, focused: document.activeElement === i } : null; })(),
  editable: document.querySelector(".ss-pg").getAttribute("data-ss-pg-editable"),
  actions: [...document.querySelectorAll(".ss-pg-bact")].map((b) => b.textContent),
}));
const waitBadge = (page, re, timeout = 12000) => page.waitForFunction((src) => new RegExp(src).test((document.querySelector(".ss-pg-badge") || {}).textContent || ""), re.source, { timeout }).then(() => true, () => false);
// Every badge text in order, from now on (a MutationObserver on the toolbar).
const watchBadge = (page) => page.evaluate(() => {
  window.__ssBadges = [];
  const rec = () => { const t = (document.querySelector(".ss-pg-badge") || {}).textContent || ""; if (window.__ssBadges[window.__ssBadges.length - 1] !== t) window.__ssBadges.push(t); };
  rec();
  new MutationObserver(rec).observe(document.querySelector(".ss-pg-bar"), { subtree: true, childList: true, characterData: true });
});
const badgesSeen = (page) => page.evaluate(() => window.__ssBadges || []);
// Waits until `k` more save calls have gone out since `n0` and the badge is green again.
const saved = async (page, calls, n0, k = 1, timeout = 15000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (saveCalls(calls).length >= n0 + k && /^All changes saved · /.test((await state(page)).badge)) return true;
    await sleep(60);
  }
  return false;
};
const typeIn = async (page, id, col, text, key = "Enter") => {
  await page.locator(sel(id, col)).click();
  await page.keyboard.type(text);
  if (key) await page.keyboard.press(key);
};

if (want("P")) {
  const cat = catalogFor(OWN);
  const F = fakeServer(cat, tableFor(OWN, cat));
  const barn = barnOf(F.table(OWN));
  const LOFT = keyCol(cat, "loft"), WB = keyCol(cat, "workbench");
  F.delayMs = 500;   // long enough to see "Saving…"
  const { ctx, page, calls, errors, logs } = await open("/settings/sheds-table", { cat: () => cat, fake: F }, { width: 1280, height: 860 });
  await waitGrid(page).catch(() => {});
  await watchBadge(page);

  // A price: a digit opens the editor holding it; Enter commits and moves down; one call.
  const z1 = barn[0], z2 = barn[1], z3 = barn[2];
  await page.locator(sel(z1.id, 1)).click();
  await page.keyboard.type("5150");
  let s = await state(page);
  ok("P: a digit opens the editor over the price, holding what was typed, focused, named for a screen reader",
    !!s.editor && s.editor.value === "5150" && s.editor.focused && s.editor.label === `${named(z1)}, Price` && s.editor.mode === "decimal", JSON.stringify(s.editor));
  ok("P: an open editor holding changed text counts as a change not saved yet", s.badge === "1 change not saved yet", s.badge);
  const geo = await page.evaluate((a) => { const td = document.querySelector(a).getBoundingClientRect(), ed = document.querySelector(".ss-pg-ed").getBoundingClientRect(); return [td.left, td.top, td.width, td.height, ed.left, ed.top, ed.width, ed.height].map(Math.round); }, sel(z1.id, 1));
  ok("P: …and sits exactly over its box", geo.slice(0, 4).join() === geo.slice(4).join(), JSON.stringify(geo));
  let n0 = saveCalls(calls).length;
  await page.keyboard.press("Enter");
  s = await state(page);
  let c = await look(page, z1.id, 1);
  ok("P: Enter commits and moves down; the box shows $5,150 with the waiting mark (a blue corner)",
    s.readout === `Price · ${named(z2)}` && !s.editor && c.text === "$5,150" && /ss-pg-m-p/.test(c.cls), JSON.stringify({ readout: s.readout, c }));
  ok("P: …saved", await saved(page, calls, n0));
  const seen = await badgesSeen(page);
  const iNot = seen.indexOf("1 change not saved yet"), iSav = seen.indexOf("Saving 1 change…");
  const iOk = seen.findIndex((x, i) => i > iSav && /^All changes saved · \d/.test(x));
  ok("P: the badge goes '1 change not saved yet' → 'Saving 1 change…' → 'All changes saved · <time>'", iNot >= 0 && iSav > iNot && iOk > iSav, JSON.stringify(seen));
  let sc = saveCalls(calls).slice(n0);
  const want1 = { action: "save_pricing_cells", targetClientId: null, creates: [], removes: [], sizes: [{ id: z1.id, base: z1.updated_at, from: { price: z1.base_price }, to: { price: 5150 } }] };
  ok("P: one call: one size, only the price, from what was on file, on the version read, targetClientId on the body",
    sc.length === 1 && JSON.stringify(sc[0].body) === JSON.stringify(want1), JSON.stringify(sc.map((x) => x.body)));
  c = await look(page, z1.id, 1);
  ok("P: saved: the mark clears and the server holds it", !/ss-pg-m-/.test(c.cls) && F.size(z1.id).base_price === 5150, JSON.stringify(c));

  // An option box: numeric editor; Tab commits and moves right; only that box travels.
  n0 = saveCalls(calls).length;
  await page.locator(sel(z3.id, LOFT)).click();
  await page.keyboard.type("50");
  s = await state(page);
  ok("P: an option box's editor is numeric and named for its column", !!s.editor && s.editor.mode === "numeric" && s.editor.label === `${named(z3)}, Loft (sq ft)`, JSON.stringify(s.editor));
  await page.keyboard.press("Tab");
  s = await state(page);
  ok("P: Tab commits and moves right", s.readout === `Workbench · ${named(z3)}` && (await look(page, z3.id, LOFT)).text === "50", s.readout);
  ok("P: …saved", await saved(page, calls, n0));
  sc = saveCalls(calls).slice(n0);
  ok("P: an option edit sends one size with only that box in `from` and `to`",
    sc.length === 1 && JSON.stringify(sc[0].body.sizes) === JSON.stringify([{ id: z3.id, base: z3.updated_at, from: { cells: { loft: 0 } }, to: { cells: { loft: 50 } } }]), JSON.stringify(sc.map((x) => x.body.sizes)));
  await page.keyboard.press("Shift+Tab");
  ok("P: Shift+Tab moves left", (await state(page)).readout === `Loft (sq ft) · ${named(z3)}`);

  // Enter, F2, double-click edit in place; Escape cancels; Left/Right stay in the text; a box left as
  // it was sends nothing.
  n0 = saveCalls(calls).length;
  await page.locator(sel(z2.id, 1)).click();
  await page.keyboard.press("Enter");
  s = await state(page);
  ok("P: Enter on a box edits it in place, as a plain number", !!s.editor && s.editor.value === String(z2.base_price), JSON.stringify(s.editor));
  await page.keyboard.type("9");
  await page.keyboard.press("Escape");
  s = await state(page);
  ok("P: Escape cancels: the editor closes and the box keeps its value", !s.editor && (await look(page, z2.id, 1)).text === "$123,456.78" && /^All changes saved/.test(s.badge), JSON.stringify(s));
  await page.keyboard.press("F2");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowRight");
  s = await state(page);
  ok("P: F2 edits in place; Left and Right move the caret, not the cell", !!s.editor && s.readout === `Price · ${named(z2)}`, JSON.stringify(s));
  await page.keyboard.press("ArrowDown");
  s = await state(page);
  ok("P: Down commits and moves", !s.editor && s.readout === `Price · ${named(z3)}`, s.readout);
  await page.locator(sel(z3.id, LOFT)).dblclick();
  s = await state(page);
  ok("P: a double-click edits in place", !!s.editor && s.editor.value === "50", JSON.stringify(s.editor));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1300);
  ok("P: …and none of that sent anything", saveCalls(calls).length === n0, String(saveCalls(calls).length - n0));
  // Delete clears one box (a 0, not included), and never asks.
  n0 = saveCalls(calls).length;
  await page.keyboard.press("Delete");
  ok("P: Delete clears the box", (await look(page, z3.id, LOFT)).text === "");
  ok("P: …saved as 0 (nothing included), with no question asked", await saved(page, calls, n0) && JSON.stringify(saveCalls(calls)[n0].body.sizes[0].to) === '{"cells":{"loft":0}}'
    && F.cells(z3.id).loft === undefined, JSON.stringify(saveCalls(calls).slice(n0).map((x) => x.body.sizes)));
  // Space on Offered; typing on Offered opens nothing; a click on the selected Offered box ticks it back.
  n0 = saveCalls(calls).length;
  await page.locator(sel(z1.id, 2)).click();
  await page.keyboard.press("Space");
  ok("P: Space on Offered unticks it", (await look(page, z1.id, 2)).text === "");
  await page.keyboard.type("x");
  ok("P: typing on Offered opens no editor", !(await state(page)).editor);
  const offOk = await saved(page, calls, n0);
  const offSent = saveCalls(calls)[n0] && saveCalls(calls)[n0].body.sizes[0];
  ok("P: …saved as Offered off alone, from ticked", offOk && !!offSent && JSON.stringify([offSent.from, offSent.to]) === '[{"active":true},{"active":false}]' && F.size(z1.id).active === false,
    JSON.stringify(saveCalls(calls).slice(n0).map((x) => x.body.sizes)));
  n0 = saveCalls(calls).length;
  await page.locator(sel(z1.id, 2)).click();
  ok("P: a click on the Offered box already selected ticks it again", (await look(page, z1.id, 2)).text === "✓" && await saved(page, calls, n0) && F.size(z1.id).active === true);
  await page.keyboard.press("Control+z");
  ok("P: Ctrl+Z says undo isn't in this version", (await state(page)).status === "Undo isn't in this version yet. Type the old value back.", (await state(page)).status);
  // The overlay: a ring over a frozen box stays on it while the grid scrolls sideways (the sticky
  // lane), and one rectangle covers a Shift+arrows range.
  const ringOn = (a) => page.evaluate((s0) => {
    const r = [...document.querySelectorAll(".ss-pg-ring")].find((x) => x.style.display === "block");
    const td = document.querySelector(s0).getBoundingClientRect();
    return r ? [r.getBoundingClientRect(), td].map((b) => [b.left, b.top, b.width, b.height].map(Math.round).join()) : null;
  }, a);
  // 25 option columns fit across 1280 px; at 1000 the grid scrolls sideways.
  await page.setViewportSize({ width: 1000, height: 860 });
  await page.locator(sel(z2.id, 1)).click();
  const rp0 = await ringOn(sel(z2.id, 1));
  await page.evaluate(() => { document.querySelector(".ss-pg-box").scrollLeft = 300; });
  await page.waitForTimeout(100);
  const rp = await ringOn(sel(z2.id, 1));
  const sl = await page.evaluate(() => document.querySelector(".ss-pg-box").scrollLeft);
  ok("P: the ring over a frozen Price box stays on it while the grid scrolls sideways", !!rp && rp[0] === rp[1] && rp0[0] === rp[0] && sl > 0, JSON.stringify({ rp0, rp, sl }));
  await page.locator(sel(z2.id, 1 + 6)).click();
  const rs = await ringOn(sel(z2.id, 1 + 6));
  ok("P: …and the ring over an option box scrolled into view sits on it too", !!rs && rs[0] === rs[1], JSON.stringify(rs));
  await page.evaluate(() => { document.querySelector(".ss-pg-box").scrollLeft = 0; });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.locator(sel(z3.id, LOFT)).click();
  const ro = await ringOn(sel(z3.id, LOFT));
  ok("P: …and over an option box", !!ro && ro[0] === ro[1], JSON.stringify(ro));
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowDown");
  const rng = await page.evaluate(([a, b]) => {
    const r = [...document.querySelectorAll(".ss-pg-range")].filter((x) => x.style.display === "block");
    const ta = document.querySelector(a).getBoundingClientRect(), tb = document.querySelector(b).getBoundingClientRect();
    return { n: r.length, rr: r[0] ? [r[0].getBoundingClientRect()].map((x) => [x.left, x.top, x.right, x.bottom].map(Math.round).join())[0] : null,
      want: [ta.left, ta.top, tb.right, tb.bottom].map(Math.round).join(), selected: document.querySelectorAll('[aria-selected="true"]').length,
      readout: document.querySelector(".ss-pg-readout").textContent };
  }, [sel(z3.id, LOFT), sel(barn[3].id, LOFT + 2)]);
  ok("P: Shift+arrows stretch one rectangle over the range; the active cell stays the one selected", rng.n === 1 && rng.rr === rng.want && rng.selected === 1 && rng.readout === `Loft (sq ft) · ${named(z3)}`, JSON.stringify(rng));
  await page.keyboard.press("Escape");
  ok("P: Escape drops the range", (await page.evaluate(() => [...document.querySelectorAll(".ss-pg-range")].filter((x) => x.style.display === "block").length)) === 0);

  // Ten quick edits make at most two calls.
  F.delayMs = 0;
  n0 = saveCalls(calls).length;
  await page.locator(sel(barn[3].id, LOFT)).click();
  for (let i = 0; i < 10; i++) { await page.keyboard.type(String(11 + i)); await page.keyboard.press("Enter"); }
  ok("P: …saved", await saved(page, calls, n0));
  sc = saveCalls(calls).slice(n0);
  const entries = sc.reduce((n, x) => n + x.body.sizes.length, 0);
  ok("P: 10 quick edits make at most 2 calls, with all 10 boxes", sc.length <= 2 && entries === 10, `${sc.length} call(s), ${entries} entries`);

  // Changed elsewhere: a colleague's price lands first. Amber with ↺, their number shown, not resent;
  // the badge jumps to it; the status line says both numbers; Dismiss clears it.
  F.delayMs = 300;
  const z5 = barn[4];
  F.script.push({ before: (f) => f.poke(z5.id, { price: 4950 }) });
  n0 = saveCalls(calls).length;
  await typeIn(page, z5.id, 1, "4800");
  await waitBadge(page, /^1 box needs you$/);
  c = await look(page, z5.id, 1);
  ok("P: a colleague's change to the same box: amber with ↺, their $4,950 shown, nothing resent",
    c.text === "$4,950" && /ss-pg-m-c/.test(c.cls) && c.invalid === "true" && saveCalls(calls).length - n0 === 1 && F.size(z5.id).base_price === 4950, JSON.stringify(c));
  await page.locator(sel(z1.id, 1)).click();
  await page.locator(".ss-pg-badge-btn").click();
  s = await state(page);
  ok("P: '1 box needs you' jumps to it, and the status line gives both numbers",
    s.readout === `Price · ${named(z5)}` && s.status === `${named(z5)} · Price: changed elsewhere to $4,950 while you typed $4,800. Type it again if yours is right.`, JSON.stringify(s));
  await page.locator(".ss-pg-status button", { hasText: "Dismiss" }).click();
  s = await state(page);
  ok("P: Dismiss clears it", !s.status && /^All changes saved/.test(s.badge) && !/ss-pg-m-c/.test((await look(page, z5.id, 1)).cls), JSON.stringify(s));
  await page.screenshot({ path: join(shots, "P-after-conflict.png") });

  // A colleague changed ANOTHER box of the same size: one resend on the new version, nothing red.
  const z6 = barn[5];
  F.script.push({ before: (f) => f.poke(z6.id, { cells: { workbench: 3 } }) });
  n0 = saveCalls(calls).length;
  await typeIn(page, z6.id, 1, "3333");
  ok("P: …saved", await saved(page, calls, n0, 2));
  sc = saveCalls(calls).slice(n0);
  ok("P: a colleague's change to another box of the size: exactly one resend, on the new version, the price alone, nothing red",
    sc.length === 2 && sc[1].body.sizes[0].base !== sc[0].body.sizes[0].base && JSON.stringify(sc[1].body.sizes[0].to) === '{"price":3333}'
    && F.size(z6.id).base_price === 3333 && F.cells(z6.id).workbench === 3 && !/ss-pg-m-/.test((await look(page, z6.id, 1)).cls), JSON.stringify(sc.map((x) => x.body.sizes)));

  // A box the server refuses (here: Workbench is no column any more): red with !, the server's value
  // kept, the reason on the status line, never resent.
  F.refuse = ["workbench"];
  const z7 = barn[6];
  n0 = saveCalls(calls).length;
  await typeIn(page, z7.id, WB, "2");
  await waitBadge(page, /^1 box needs you$/);
  await page.keyboard.press("ArrowUp");
  s = await state(page);
  c = await look(page, z7.id, WB);
  ok("P: a refused box goes red with !, keeps the server's value, and the status line gives the server's reason",
    c.text === "" && /ss-pg-m-r/.test(c.cls) && c.invalid === "true" && s.status === `${named(z7)} · Workbench: That option has no column in your sizes table.` && saveCalls(calls).length - n0 === 1, JSON.stringify({ c, s }));
  F.refuse = [];
  await page.locator(".ss-pg-status button", { hasText: "Dismiss" }).click();
  const cl = logs.filter((l) => l.p_code === "pricing_table_conflicts");
  ok("P: each answer with a conflict or a refusal wrote one info row, counts only (no prices, nothing typed)",
    cl.length === 3 && cl.every((l) => l.p_severity === "info" && !/4800|4950|3333|"2"/.test(JSON.stringify(l.p_context))), JSON.stringify(cl.map((l) => l.p_context)));

  // Text the rules refuse: red at once, the cursor stays, nothing is sent.
  const z8 = barn[7];
  n0 = saveCalls(calls).length;
  await typeIn(page, z8.id, LOFT, "abc");
  s = await state(page);
  c = await look(page, z8.id, LOFT);
  ok("P: 'abc' in an option box goes red at once, the cursor stays on it, and the status line says why",
    s.readout === `Loft (sq ft) · ${named(z8)}` && /ss-pg-m-r/.test(c.cls) && s.status === `${named(z8)} · Loft (sq ft): “abc” wasn't saved. Whole numbers only, 0 or more.`, JSON.stringify({ s, c }));
  await page.keyboard.type("yes");
  await page.keyboard.press("Enter");
  ok("P: …so does 'yes'", (await state(page)).status === `${named(z8)} · Loft (sq ft): “yes” wasn't saved. Whole numbers only, 0 or more.`, (await state(page)).status);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.type("-5");
  await page.keyboard.press("Enter");
  ok("P: …and '-5' in a price", (await state(page)).status === `${named(z8)} · Price: “-5” wasn't saved. A price is a number, 0 or more.`, (await state(page)).status);
  await page.waitForTimeout(1300);
  ok("P: none of them was sent", saveCalls(calls).length === n0);
  await page.keyboard.type("1999");
  await page.keyboard.press("Enter");
  await waitBadge(page, /^1 box needs you$/);
  ok("P: a valid number typed over it goes, and only the box still wrong stays red", saveCalls(calls).length === n0 + 1 && F.size(z8.id).base_price === 1999
    && !/ss-pg-m-r/.test((await look(page, z8.id, 1)).cls) && /ss-pg-m-r/.test((await look(page, z8.id, LOFT)).cls));
  ok("P: the grid is a writable grid while editable", (await page.locator(".ss-pg-grid").getAttribute("aria-readonly")) === null);
  ok("P: no malformed save ever reached the server", F.bad.length === 0, F.bad.join(","));
  await page.screenshot({ path: join(shots, "P-editing.png") });
  ok("P: no page errors (editing)", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// Transport: a 500 then the retry (and Retry now), a hung main host through the side door, an answer
// lost on the way back, five failures in a row stopping saving, Retry, and Discard.
if (want("P")) {
  const cat = catalogFor(OWN);
  const F = fakeServer(cat, tableFor(OWN, cat));
  const barn = barnOf(F.table(OWN));
  const { ctx, page, calls, errors, logs } = await open("/settings/sheds-table", { cat: () => cat, fake: F,
    win: { __ssPgBackoffMs: [1500, 1500, 1500, 1500], __ssSaveDeadlineMs: 1200 } }, { width: 1280, height: 860 });
  await waitGrid(page).catch(() => {});
  await watchBadge(page);
  F.script.push({ status: 500 });
  let n0 = saveCalls(calls).length;
  await typeIn(page, barn[0].id, 1, "777");
  const amber = await waitBadge(page, /^Can't reach the server\. Retrying in \d+ s; your changes are kept$/);
  let s = await state(page);
  ok("P: a 500: amber 'Can't reach the server. Retrying in N s; your changes are kept', with Retry now", amber && s.actions.includes("Retry now"), JSON.stringify(s));
  const tRetry = Date.now();
  await page.locator(".ss-pg-bact", { hasText: "Retry now" }).click();
  ok("P: …saved", await saved(page, calls, n0, 2));
  let sc = saveCalls(calls).slice(n0);
  ok("P: Retry now sends the very same call at once, and it lands", sc.length === 2 && JSON.stringify(sc[0].body) === JSON.stringify(sc[1].body) && sc[1].at - tRetry < 1000
    && F.size(barn[0].id).base_price === 777, JSON.stringify(sc.map((x) => [x.host, x.at - tRetry])));
  // The main host hangs: after the deadline the side door is used; its 500 shows amber; the backoff
  // resends (straight to the side door while the main host is remembered as stalled); green.
  F.script.push({ hang: true }, { status: 500 });
  await page.evaluate(() => { window.__ssBadges = []; });
  n0 = saveCalls(calls).length;
  await typeIn(page, barn[1].id, 1, "888");
  ok("P: …saved", await saved(page, calls, n0, 3, 20000));
  sc = saveCalls(calls).slice(n0);
  const seen = await badgesSeen(page);
  ok("P: a hung main host: the side door is used, the badge goes amber, then green",
    sc.map((x) => x.host).join() === "main,side,side" && seen.some((x) => /^Can't reach the server/.test(x)) && /^All changes saved/.test(seen[seen.length - 1]) && F.size(barn[1].id).base_price === 888,
    `${sc.map((x) => x.host).join()} | ${JSON.stringify(seen)}`);
  ok("P: …and the side door was filed as pricing_table_side_door (info)", logs.some((l) => l.p_code === "pricing_table_side_door" && l.p_severity === "info"));
  // An answer lost on the way back: the call landed, the resend comes back duplicate; nothing red.
  F.script.push({ lose: true });
  n0 = saveCalls(calls).length;
  await typeIn(page, barn[2].id, 1, "999");
  ok("P: …saved", await saved(page, calls, n0, 2, 20000));
  ok("P: a lost answer: the same call again lands as a duplicate, the box saved, nothing red",
    saveCalls(calls).length - n0 === 2 && F.size(barn[2].id).base_price === 999 && !/ss-pg-m-/.test((await look(page, barn[2].id, 1)).cls) && (await state(page)).badge.startsWith("All changes saved"));
  ok("P: no page errors (transport)", errors.length === 0, errors.join(" | "));
  await ctx.close();
}
if (want("P")) {
  const cat = catalogFor(OWN);
  const F = fakeServer(cat, tableFor(OWN, cat));
  const barn = barnOf(F.table(OWN));
  const { ctx, page, calls, errors, logs } = await open("/settings/sheds-table", { cat: () => cat, fake: F, win: { __ssPgBackoffMs: [150, 150, 150, 150] } }, { width: 1280, height: 860 });
  await waitGrid(page).catch(() => {});
  for (let i = 0; i < 5; i++) F.script.push({ status: 500 });
  let n0 = saveCalls(calls).length;
  await typeIn(page, barn[0].id, 1, "1234");
  const stopped = await waitBadge(page, /^Saving stopped: couldn't reach the server$/, 20000);
  let s = await state(page);
  const stops = logs.filter((l) => l.p_code === "pricing_table_saving_stopped");
  ok("P: five failures in a row: 'Saving stopped', with Retry and Discard these changes", stopped && s.actions.join() === "Retry,Discard these changes" && saveCalls(calls).length - n0 === 5, JSON.stringify(s));
  ok("P: …and one info row, its status only", stops.length === 1 && stops[0].p_severity === "info" && JSON.stringify(stops[0].p_context) === '{"status":500}', JSON.stringify(stops));
  ok("P: …the box keeps what was typed, marked unsaved", (await look(page, barn[0].id, 1)).text === "$1,234" && /ss-pg-m-p/.test((await look(page, barn[0].id, 1)).cls));
  await page.locator(".ss-pg-bact", { hasText: "Retry" }).first().click();
  ok("P: Retry sends it again, and it lands", await saved(page, calls, n0, 6) && F.size(barn[0].id).base_price === 1234);
  for (let i = 0; i < 5; i++) F.script.push({ status: 500 });
  n0 = saveCalls(calls).length;
  const was = (await look(page, barn[1].id, 1)).text;
  await typeIn(page, barn[1].id, 1, "4321");
  await waitBadge(page, /^Saving stopped/, 20000);
  await page.locator(".ss-pg-bact", { hasText: "Discard these changes" }).click();
  await page.waitForTimeout(1300);
  s = await state(page);
  ok("P: Discard these changes: the box shows what the server holds again, the badge is green, nothing more goes",
    (await look(page, barn[1].id, 1)).text === was && /^All changes saved/.test(s.badge) && saveCalls(calls).length - n0 === 5 && F.size(barn[1].id).base_price !== 4321, JSON.stringify(s));
  ok("P: no page errors (stopped)", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// A 403 on a save: view-only from then on; nothing more is sent, nothing more can be typed.
if (want("P")) {
  const cat = catalogFor(OWN);
  const F = fakeServer(cat, tableFor(OWN, cat));
  const barn = barnOf(F.table(OWN));
  const { ctx, page, calls, errors } = await open("/settings/sheds-table", { cat: () => cat, fake: F }, { width: 1280, height: 860 });
  await waitGrid(page).catch(() => {});
  F.script.push({ status: 403, error: "You don't have access to that (test)." });
  const n0 = saveCalls(calls).length;
  await typeIn(page, barn[0].id, 1, "2222");
  const vo = await waitBadge(page, /^View only: You can't change Sheds on this account$/);
  await page.locator(sel(barn[1].id, 1)).click();
  await page.keyboard.type("5");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Delete");
  await page.waitForTimeout(1500);
  const s = await state(page);
  ok("P: a 403 stops saving: 'View only: You can't change Sheds on this account', no editor, nothing more sent",
    vo && s.editable === "0" && !s.editor && saveCalls(calls).length - n0 === 1 && (await page.locator(".ss-pg-grid").getAttribute("aria-readonly")) === "true", JSON.stringify(s));
  ok("P: …the edit that was refused stays on screen marked unsaved", (await look(page, barn[0].id, 1)).text === "$2,222" && /ss-pg-m-p/.test((await look(page, barn[0].id, 1)).cls));
  ok("P: no page errors (403)", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// View-only refuses every edit path: an operator wearing a team member (?as=), and a view-only
// access map. Then Real-Time Pricing, which locks the price column alone.
for (const [what, path, S0] of want("P") ? [
  ["?as=", `/settings/sheds-table?view=${VIEWED}&as=${WEAR}`, { own: OPS, operator: true }],
  ["a view-only access map", "/settings/sheds-table", { role: "user", access: { settings_structures: "view", designs: "view" } }],
] : []) {
  const cat = catalogFor(OWN);
  const F = fakeServer(cat, tableFor(OWN, cat));
  const barn = barnOf(F.table(OWN));
  const LOFT = keyCol(cat, "loft");
  const { ctx, page, calls, errors } = await open(path, { ...S0, cat: (cid) => ({ ...cat, clientId: cid }), fake: F }, { width: 1280, height: 860 });
  await waitGrid(page).catch(() => {});
  const z = barn[0];
  const before = await page.evaluate(() => [...document.querySelectorAll(".ss-pg-grid tbody td")].map((td) => td.textContent).join("|"));
  const tries = [];
  const note = async (label) => tries.push(`${label}:${await page.locator(".ss-pg-ed").count()}`);
  await page.locator(sel(z.id, 1)).click();
  await page.keyboard.type("9"); await note("type");
  await page.keyboard.press("$"); await note("$");
  await page.keyboard.press("Enter"); await note("Enter");
  await page.keyboard.press("F2"); await note("F2");
  await page.locator(sel(z.id, 1)).dblclick(); await note("dblclick");
  await page.keyboard.press("Delete"); await note("Delete");
  await page.keyboard.press("Backspace"); await note("Backspace");
  await page.locator(sel(z.id, LOFT)).click();
  await page.keyboard.type("5"); await note("type option");
  await page.locator(sel(z.id, LOFT)).dblclick(); await note("dblclick option");
  await page.locator(sel(z.id, 2)).click();
  await page.keyboard.press("Space"); await note("Space on Offered");
  await page.locator(sel(z.id, 2)).click(); await note("click Offered again");
  await page.waitForTimeout(1300);
  const after = await page.evaluate(() => [...document.querySelectorAll(".ss-pg-grid tbody td")].map((td) => td.textContent).join("|"));
  ok(`P: view-only (${what}) refuses every edit path: no editor, no change, no save call`,
    tries.every((t) => t.endsWith(":0")) && before === after && saveCalls(calls).length === 0 && (await state(page)).badge.startsWith("View only"), tries.join(" "));
  ok(`P: no page errors (view-only, ${what})`, errors.length === 0, errors.join(" | "));
  await ctx.close();
}
if (want("P")) {
  const cat = catalogFor(OWN);
  const F = fakeServer(cat, tableFor(OWN, cat, { rtpOn: true }));
  const barn = barnOf(F.table(OWN));
  const { ctx, page, calls, errors } = await open("/settings/sheds-table", { cat: () => cat, fake: F }, { width: 1280, height: 860 });
  await waitGrid(page).catch(() => {});
  await page.locator(sel(barn[0].id, 1)).click();
  await page.keyboard.type("5");
  let s = await state(page);
  ok("P: Real-Time Pricing: typing on a price opens no editor and says why", !s.editor && s.status === "Real-Time Pricing sets prices on this account.", JSON.stringify(s));
  const n0 = saveCalls(calls).length;
  await typeIn(page, barn[0].id, keyCol(cat, "loft"), "12");
  ok("P: …while the option boxes still save", await saved(page, calls, n0) && F.cells(barn[0].id).loft === 12);
  ok("P: no page errors (RTP)", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// Leaving: the browser asks first while the editor holds changed text (never committed), and while
// an edit is unsent or in flight; once everything is saved it does not. Back to Sheds sends first.
// One page per case: Chrome does not raise a second beforeunload on a page whose first was dismissed.
for (const [what, prep, asks] of want("P") ? [
  ["while the editor holds changed text (the box never left)", async (page) => { await page.keyboard.type("77"); }, true],
  ["while an edit is unsent or saving", async (page) => { await page.keyboard.type("77"); await page.keyboard.press("Enter"); }, true],
  ["once everything is saved", async (page, calls) => { await page.keyboard.type("77"); await page.keyboard.press("Enter"); await saved(page, calls, 0, 1, 15000); }, false],
  ["after an edit opened and closed unchanged", async (page) => { await page.keyboard.press("Enter"); await page.keyboard.press("Escape"); }, false],
] : []) {
  const cat = catalogFor(OWN);
  const F = fakeServer(cat, tableFor(OWN, cat));
  const barn = barnOf(F.table(OWN));
  F.delayMs = 2500;
  const { ctx, page, calls, errors, dialogs } = await open("/settings/sheds-table", { cat: () => cat, fake: F }, { width: 1280, height: 860 });
  await waitGrid(page).catch(() => {});
  await page.locator(sel(barn[0].id, keyCol(cat, "loft"))).click();
  await prep(page, calls);
  const before = await state(page);
  await page.close({ runBeforeUnload: true });
  await sleep(700);
  const asked = dialogs.includes("beforeunload");
  ok(`P: leaving ${what} ${asks ? "asks first" : "does not ask"}`, asks ? asked && !page.isClosed() : !asked && page.isClosed(),
    JSON.stringify({ dialogs, badge: before.badge, editor: !!before.editor }));
  ok(`P: no page errors (leaving ${what})`, errors.length === 0, errors.join(" | "));
  await ctx.close();
}
if (want("P")) {
  const cat = catalogFor(OWN);
  const F = fakeServer(cat, tableFor(OWN, cat));
  const barn = barnOf(F.table(OWN));
  F.delayMs = 600;
  const { ctx, page, calls, errors } = await open("/settings/sheds-table", { cat: () => cat, fake: F }, { width: 1280, height: 860 });
  await waitGrid(page).catch(() => {});
  await typeIn(page, barn[0].id, 1, "6060");
  const t0 = Date.now();
  await page.locator(".ss-pg-back").click();
  await page.waitForURL(/\/settings\/sheds$/, { timeout: 10000 }).catch(() => {});
  const sc = saveCalls(calls);
  ok("P: Back to Sheds sends the unsent edit at once, waits for it, then leaves",
    new URL(page.url()).pathname === "/settings/sheds" && sc.length === 1 && sc[0].at - t0 < 500 && F.size(barn[0].id).base_price === 6060, `${page.url()} ${sc.map((x) => x.at - t0)}`);
  ok("P: no page errors (Back)", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// ── T: timing ──
if (!process.env.SKIP_TIMING && want("T")) {
  for (const [tag, perStyle] of [["1x", 70], ["3x", 210]]) {
    const cat = catalogFor(OWN, { extra: 13 });                    // 25 + 13 = 38 option columns
    const table = tableFor(OWN, cat, { perStyle });                 // 3 styles x perStyle sizes
    const cells = table.sizes.length * (3 + OPTION_KEYS(cat).length);
    const F = fakeServer(cat, table);   // the typing below saves; answers held back past the measuring
    F.delayMs = 4000;
    const { ctx, page, errors } = await open(null, { cat: () => cat, fake: F }, { width: 1440, height: 900 });
    await page.goto(`${BASE}/settings/sheds-table`);
    await waitGrid(page, 60000).catch(() => {});
    await page.waitForTimeout(800);
    const first = await page.evaluate(() => {
      const m = (n) => performance.getEntriesByName(n);
      const data = m("ss-pg-data")[0], grids = m("ss-pg-grid"), painted = m("ss-pg-painted");
      return { grid: grids.length ? Math.round(grids[grids.length - 1].startTime - data.startTime) : null,
        painted: painted.length ? Math.round(painted[painted.length - 1].startTime - data.startTime) : null, passes: grids.length,
        nav: Math.round((painted.length ? painted[painted.length - 1].startTime : 0)) };
    });
    // Arrow keys: dispatched on the grid in the page, timed from the keydown to the update laid out
    // (React's microtask flush, the overlay placed, then a forced layout), and to the next frame. A
    // MutationObserver on the body counts the size rows whose content changed (aria-selected, which
    // the overlay sets on the active cell by hand, aside): an arrow key should change none.
    await page.locator(".ss-pg-grid tbody tr[data-s] td[data-c='1']").first().click();
    const keys = await page.evaluate(async () => {
      const g = document.querySelector(".ss-pg-grid");
      const sync = [], frame = [], touched = new Set();
      const mo = new MutationObserver((ms) => ms.forEach((m) => {
        if (m.type === "attributes" && m.attributeName === "aria-selected") return;
        const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
        const tr = el && el.closest("tr[data-s]");
        if (tr) touched.add(tr);
      }));
      mo.observe(g.querySelector("tbody"), { subtree: true, childList: true, characterData: true, attributes: true });
      const press = async (key) => {
        const t0 = performance.now();
        g.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
        await new Promise((r) => queueMicrotask(r));
        const ring = [...document.querySelectorAll(".ss-pg-ring")].find((r) => r.style.display === "block");
        if (ring) ring.getBoundingClientRect();
        sync.push(performance.now() - t0);
        await new Promise((r) => requestAnimationFrame(() => r()));
        frame.push(performance.now() - t0);
      };
      for (let i = 0; i < 30; i++) await press("ArrowRight");
      for (let i = 0; i < 40; i++) await press("ArrowDown");
      for (let i = 0; i < 30; i++) await press("ArrowLeft");
      mo.disconnect();
      const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 100) / 100; };
      return { n: sync.length, syncMed: q(sync, 0.5), syncP95: q(sync, 0.95), syncMax: q(sync, 1), frameMed: q(frame, 0.5), frameP95: q(frame, 0.95),
        readout: document.querySelector(".ss-pg-readout").textContent, rows: touched.size };
    });
    // Typing: a digit on the grid opens the editor holding it (keydown -> editor laid out); three
    // keystrokes go into it (each an input event: the page keeps the text out of React state, so
    // nothing renders); Enter commits and moves down (keydown -> laid out, and the next frame), and
    // the rows whose content changed are counted: one, the committed row.
    await page.locator(".ss-pg-grid tbody tr[data-s] td[data-c='4']").first().click();
    const typing = await page.evaluate(async () => {
      const g = document.querySelector(".ss-pg-grid");
      const open = [], key = [], commit = [], frame = [], rows = [];
      const tick = () => new Promise((r) => queueMicrotask(r));
      for (let i = 0; i < 20; i++) {
        let t0 = performance.now();
        g.dispatchEvent(new KeyboardEvent("keydown", { key: String((i % 8) + 1), bubbles: true, cancelable: true }));
        await tick();
        const ed = document.querySelector(".ss-pg-ed");
        if (!ed) return { broken: `no editor after keydown ${i}` };
        ed.getBoundingClientRect();
        open.push(performance.now() - t0);
        for (let k = 0; k < 3; k++) {
          t0 = performance.now();
          ed.value += String(k + 1);
          ed.dispatchEvent(new Event("input", { bubbles: true }));
          await tick();
          ed.getBoundingClientRect();
          key.push(performance.now() - t0);
        }
        const touched = new Set();
        const mo = new MutationObserver((ms) => ms.forEach((m) => {
          if (m.type === "attributes" && m.attributeName === "aria-selected") return;
          const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
          const tr = el && el.closest("tr[data-s]");
          if (tr) touched.add(tr);
        }));
        mo.observe(g.querySelector("tbody"), { subtree: true, childList: true, characterData: true, attributes: true });
        t0 = performance.now();
        ed.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        await tick();
        g.getBoundingClientRect();
        commit.push(performance.now() - t0);
        await new Promise((r) => requestAnimationFrame(() => r()));
        frame.push(performance.now() - t0);
        mo.disconnect();
        rows.push(touched.size);
      }
      const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 100) / 100; };
      return { n: open.length, openMed: q(open, 0.5), openP95: q(open, 0.95), keyMed: q(key, 0.5), keyP95: q(key, 0.95),
        commitMed: q(commit, 0.5), commitP95: q(commit, 0.95), frameMed: q(frame, 0.5), frameP95: q(frame, 0.95), rows: [...new Set(rows)] };
    });
    console.log(`TIMING ${tag}: ${table.sizes.length} sizes x ${3 + OPTION_KEYS(cat).length} columns = ${cells} cells; first render (data in -> grid committed and measured) ${first.grid} ms over ${first.passes} commit(s), -> next frame ${first.painted} ms (page load -> table painted ${first.nav} ms, shell boot and stubbed reads included); ` +
      `arrow key (keydown -> laid out) median ${keys.syncMed} ms, p95 ${keys.syncP95} ms, max ${keys.syncMax} ms; keydown -> next frame median ${keys.frameMed} ms, p95 ${keys.frameP95} ms (${keys.n} keys, ${keys.rows} rows changed); ` +
      `typing: digit -> editor open median ${typing.openMed} ms, p95 ${typing.openP95} ms; keystroke in the editor median ${typing.keyMed} ms, p95 ${typing.keyP95} ms; ` +
      `Enter -> committed and moved median ${typing.commitMed} ms, p95 ${typing.commitP95} ms, -> next frame median ${typing.frameMed} ms, p95 ${typing.frameP95} ms; rows changed per commit ${JSON.stringify(typing.rows)} (${typing.n} commits)`);
    ok(`T${tag}: the grid rendered and the arrows moved (${cells} cells)`, first.grid != null && keys.n === 100 && /· Test /.test(keys.readout), keys.readout);
    ok(`T${tag}: an arrow key re-renders no row`, keys.rows === 0, String(keys.rows));
    ok(`T${tag}: a commit re-renders one row (the committed one)`, !typing.broken && JSON.stringify(typing.rows) === "[1]", typing.broken || JSON.stringify(typing.rows));
    ok(`T${tag}: no page errors`, errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
}

await browser.close();
const bad = failed();
console.log(bad.length ? `\n${bad.length} check(s) FAILED` : "\nALL CHECKS PASSED");
process.exitCode = bad.length ? 1 : 0;
