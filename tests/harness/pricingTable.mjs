// THE SIZES & PRICES TABLE (/settings/sheds-table, build plan Phase 2: the shell and the read-only
// grid; Phase 3: editing and autosave; Phase 4a: adding sizes, Remove, refresh and the backup; Phase
// 4b: copy, paste, fill down, clear and the confirm), driven for real on the COMPILED portal.
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
//      while the operator check is out (no portal-settings call but the shell's own boot reads for the
//      operator), then makes every table read for that builder and saves an edit there (targetClientId
//      on every portal-settings body from then on) and draws the red operator strip with the builder's
//      name; ?as= opens view-only, naming the person (or "a team member" when the people list is
//      refused); a view-as page that is view-only for another reason says so in the strip too; a
//      non-operator holding ?view= is told 10 s after "Opening…" (by the page's own clock) that the
//      account could not be opened, and no table read ever goes out; a view-only access map opens
//      view-only; a billing lock shows the lock.
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
//      and Discard (a Discard whose call landed anyway reads the table again and says so; when that
//      read fails the badge says it may have saved, with Reload); a 403 makes the page view-only.
//      ?as= and a view-only access map refuse every edit path: every control the page draws is listed
//      (against the same rows editable, so the list is known to catch an edit control), none of them
//      edits, and using each, Back to Sheds last, sends nothing; Real-Time Pricing locks prices only.
//      The leave prompt fires for an editor holding changed text and for an unsent edit, and not once
//      saved; left anyway and reopened, the banner has the editor's text and Save them sends it; Back
//      to Sheds sends first, and stays on a box that goes red (text refused, or the save changed
//      elsewhere) or says why it stayed (saving stopped) with Leave anyway; Go to Options and
//      the browser's Back send first too. The browser's Back is held while anything waits (a
//      follow-up in the editor behind a call out, the editor's text alone), goes after it saves, and
//      stays on a box that went red or while saving is stopped; a box typed into while Back to Sheds
//      waits keeps the page. "1 box needs you" unfolds a hidden size to reach its box. An answer that
//      moves a box under the open editor turns what is then typed red, never sent.
//   R  ADDING SIZES, REMOVE, REFRESH, THE BACKUP (Phase 4a), against fakeServer, which answers creates
//      and removes as migration 350 does. "＋ Add sizes" opens a strip under its band; one bad entry
//      refuses the whole add and is named, with nothing sent; new sizes go after the style's last one
//      in the order typed, saying "Adding…", the size already there named; a price typed meanwhile
//      goes after the create's answer on its version; Offered greyed until priced. Add several: a
//      tick-box grid, the sizes already there greyed, one unticked. A style with no sizes: the list
//      box is already open. Remove goes through the queue (and one the server refuses keeps its row
//      and says why). ?style= opens with the add box focused. A save in another tab re-reads both
//      tables after 1 s (a new column, a new style, a new number); the page's own saves and another
//      account's do not; the same-window "ss:settings-saved" event from another source does, and so
//      does coming back to the tab. An Excel upload in the Sheds tab turns a box
//      waiting to save that the sheet changed amber, never sent. The backup: a closed tab's call out,
//      red box and editor text come back as "You have 2 changes from earlier…"; Save them sends them
//      on their stored version and starting values; a colleague's change since comes back amber;
//      Discard; 7 days; view-as offers only the viewed account's backup, ?as= none. Two tabs of one
//      account: the second offers nothing of the open first one's and its save leaves the first one's
//      draft stored; once the first is gone, the next tab offers it. A price typed on a size still
//      being added comes back with that size, which Save them adds again first. A "too big" first read offers
//      no backup; the Reload that clears it does. Alt+Enter opens a size's add strip and Delete on a
//      Size box removes a size added by mistake; the ring stays on its box while a strip grows above
//      it; a size being removed takes no typing. An open editor stays on its option when a read adds
//      an option in front of it (Enter saves that option) and closes, with the columns note, when its
//      option is archived. A save answered "changed elsewhere" reads the table again.
//   V  COPY, PASTE, FILL DOWN, CLEAR (Phase 4b), against fakeServer, through the browser's own clipboard
//      events (and one real Ctrl+C through the system clipboard): a range copies as TSV, as drawn; a
//      block pasted onto two sizes asks first (an accessible modal naming the first and last size,
//      focus on Continue and kept inside); Escape and Cancel send nothing; Continue sends one call with
//      only those boxes and leaves the block selected. A bad cell, a block crossing a band and one
//      skipping a folded hidden size are refused with nothing sent. Delete on a range and the
//      toolbar's Clear ask the same question; Ctrl+D (held from the browser) and Fill down fill the top
//      row down, one box from the size above without asking. A first price pasted with Offered "no"
//      goes with Offered unticked and the size stays out of the designer; with "yes" the server ticks
//      it. A view-only page copies and changes
//      nothing. A 20,000-box paste (500 sizes x 40 columns) is timed from the paste to the confirm and
//      from Continue to the commit drawn (longest task, rows re-rendered), then saved in calls of at
//      most 50 sizes and 2,500 boxes; 20,040 boxes are refused.
//   T  TIMING (always printed): first render, arrow-key and typing time at 1x (210 sizes x 41 columns,
//      about 8,600 cells) and 3x (630 x 41, about 25,800). Fails if an arrow key re-renders a row or a
//      commit re-renders more than the one it changed, and at 1x if the plan's targets are missed
//      (first render under 500 ms, an arrow key under 16 ms).
//
// PLAN 8.4, CASE BY CASE: where each of its cases is checked (section, then the check's own words).
//   Mount: a cold load renders, no React #310 ........ B "no page errors, no React #310" (and every
//                                                        section opens the page cold)
//   View-as: cold ?view= sends no portal-settings call before arming, then targetClientId on every
//            body ............................................ F "before ?view= arms…", "…and after it,
//                                                        every portal-settings body…", "an edit in view-as…"
//            NOT AS WORDED: the plan says "no portal-settings call"; F lets the shell's own boot reads
//            through (status and get_profile for the operator, with no targetClientId, and the ?warm=1
//            ping), which every portal page makes before any account can arm. What F holds to is that
//            no table read and nothing for the builder goes before arming. The plan's 8.4 wants a Build
//            note saying so.
//   View-as: a non-operator holding ?view= is told at 10 s ... F "…and 10 s after it, not sooner…"
//   View-as: ?as= is view-only, no save goes out ........ F "?as= opens view-only…"; P "view-only (?as=)…"
//                                                        (every control, every key, the clipboard)
//   Permissions: a view-only access map, controls enumerated  F "a view-only access map opens view-only";
//                                                        P "view-only (a view-only access map): every
//                                                        control drawn…", "…refuses every edit path",
//                                                        "…using every control"; V "view-only: paste…"
//   Grid 210 x 38, 46-character name, 1280 and 1440: no name cut, both axes pinned, "480"/"1200" fit
//                                                        C38@1280, C38@1440 (and C at 25 columns)
//   Narrow 390 px: no sideways page, header <= 90 px, >= 8 rows  G
//   Editing: one option edit = one size with only that box ... P "an option edit sends one size…"
//   Editing: 10 quick edits make at most 2 calls ........ P "10 quick edits make at most 2 calls…"
//   Editing: create, then a price on the create's version  R "the price typed while it was being added…"
//   Paste: a bad cell, a block across a band, the confirm  V "a block with one bad cell…", "…cross a
//                                                        style's band…", "a paste onto more than one size…"
//   Failure: hung main host -> side door, amber then green  P "a hung main host…"
//   Failure: a conflict on another box -> one resend ..... P "a colleague's change to another box…"
//   Failure: a conflict on the same box -> red + status .. P "a colleague's change to the same box…",
//                                                        "'1 box needs you' jumps to it…"
//   Failure: 5 failures -> saving stops, one info row .... P "five failures in a row…", "…one info row"
//   Leaving: the prompt with an edit unsent, and with only the editor's text; reopened, the banner has
//            that text ................................... P "leaving while…asks first", "…left anyway
//                                                        and opened again…"
//   Refresh: another source's broadcast re-reads both, a new column  R "a save in another tab…",
//                                                        "…a new option column appears…"
//   Timing at 1x and 3x .............................. T
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
// Phase 4a: creates and removes are answered as the function's rules 1 and 2 do: a style that is not
// this account's is refused; a size looked up by its dimensions first (the same id → duplicate,
// another → exists with existingId); otherwise inserted unpriced, not offered, at the end of its style
// (max sort_order + 1), with updated_at = created_at. A remove takes only a size never priced or
// edited with no inclusion row; one that exists nowhere is removed with gone.
function fakeServer(cat, table) {
  let clock = 0;
  const ver = () => `2026-10-31T00:00:00.${String(++clock).padStart(6, "0")}+00:00`;
  const sizes = new Map(table.sizes.map((z) => [z.id, { ...z }]));
  const inc = new Map();
  table.inclusions.forEach((x) => { if (x.included) { if (!inc.has(x.size_id)) inc.set(x.size_id, {}); inc.get(x.size_id)[x.item_key] = Number(x.qty) || 1; } });
  const priceOf = (z) => (z.base_price == null ? null : Number(z.base_price));
  const F = {
    script: [], refuse: [], delayMs: 0, rtp: !!table.rtpOn, bad: [], made: [],
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
      const rowOf = (z) => ({ price: priceOf(z), active: !!z.active, label: z.label, width_ft: z.width_ft, length_ft: z.length_ft, style_id: z.style_id, sort_order: z.sort_order, created_at: z.created_at });
      const created = (body.creates || []).map((c) => {
        if (!table.styles.some((s) => s.id === c.styleId)) return { id: c.id, status: "refused", reason: "That style isn't on this account." };
        const hit = [...sizes.values()].find((z) => z.style_id === c.styleId && Number(z.width_ft) === c.width && Number(z.length_ft) === c.length);
        if (hit) return { id: c.id, status: hit.id === c.id ? "duplicate" : "exists", version: hit.updated_at, row: rowOf(hit), cells: F.cells(hit.id), ...(hit.id === c.id ? {} : { existingId: hit.id }) };
        if (sizes.has(c.id)) return { id: c.id, status: "refused", reason: "That size id is already in use." };
        const mine = [...sizes.values()].filter((z) => z.style_id === c.styleId);
        const v = ver();
        const z = { id: c.id, style_id: c.styleId, label: `${String(c.width)}x${String(c.length)}`, width_ft: c.width, length_ft: c.length, base_price: null, active: false,
          sort_order: mine.reduce((m, x) => Math.max(m, Number(x.sort_order)), -1) + 1, created_at: v, updated_at: v };
        sizes.set(z.id, z);
        F.made.push(z.id);
        return { id: c.id, status: "created", version: v, row: rowOf(z), cells: {} };
      });
      const removed = (body.removes || []).map((id) => {
        const z = sizes.get(id);
        if (!z) return { id, status: "removed", gone: true };
        if (z.base_price == null && z.updated_at === z.created_at && !Object.keys(inc.get(id) || {}).length) { sizes.delete(id); inc.delete(id); return { id, status: "removed" }; }
        return { id, status: "refused", reason: "Only a size that was never priced or edited can be removed. Untick Offered to hide it." };
      });
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
        return { id: e.id, status, version: z.updated_at, cells, ...(Object.keys(errs).length ? { cellErrors: errs } : {}), row: rowOf(z) };
      });
      return { created, removed, results };
    },
  };
  return F;
}

// S: { own, operator, operatorDelayMs (is_operator answers late), role, access, locked, cat(clientId),
//      table(clientId), sizeTableDelayMs, sizeTableFailures, countSkew (size_table answers with counts
//      that never add up), createdStyleId, peopleRefused (list_users answers 403), fake (fakeServer:
//      size_table and save_pricing_cells answer from its rows), win (window.* values set before the
//      page's own scripts: __ssPgBackoffMs, __ssSaveDeadlineMs, __ssPgRefreshMs), onImport (runs on
//      an import_pricing_csv, before its answer), storage (localStorage entries set before the page's
//      own scripts, once per context) }
async function open(path, S0 = {}, { width = 1440, height = 900 } = {}) {
  const S = { own: OWN, operator: false, operatorDelayMs: 0, role: "owner", access: null, locked: false, sizeTableDelayMs: 0, sizeTableFailures: 0, countSkew: false, ...S0 };
  S.cat = S.cat || ((cid) => catalogFor(cid));
  S.table = S.table || (S.fake ? (cid) => S.fake.table(cid) : (cid) => tableFor(cid, S.cat(cid)));
  const ctx = await browser.newContext({ viewport: { width, height }, serviceWorkers: "block", acceptDownloads: true });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
  }, [REF, SESSION]);
  if (S.win) await ctx.addInitScript((w) => { Object.assign(window, w); }, S.win);
  // Stored once, by the first page: a reload or a second tab finds what the page left there.
  if (S.storage) {
    await ctx.addInitScript((kv) => {
      try {
        if (localStorage.getItem("__ssSeeded")) return;
        localStorage.setItem("__ssSeeded", "1");
        Object.entries(kv).forEach(([k, v]) => localStorage.setItem(k, v));
      } catch (_e) { /* no storage on this page (about:blank) */ }
    }, S.storage);
  }
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
        if (S.opAt == null) S.opAt = Date.now();   // the first answer: ?view= can arm only after it
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
    // `warm`: the shell's ?warm=1 ping (ssWarmFn), which carries no body and runs no tenant code.
    calls.push({ fn: name, action: body.action, body, host, at: Date.now(), warm: /[?&]warm=1(&|$)/.test(url) });
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
      if (a === "import_pricing_csv") {
        if (S.onImport) S.onImport(body);   // what the sheet changed, written into the fake's rows (section R)
        return json(route, { ok: true, clientId: tenant, imported: 2, created: 1, updated: 1, skipped: [] });
      }
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

// ── The helpers the editing sections share (P first; F, R and V too) ──
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
  editable: (document.querySelector(".ss-pg") || { getAttribute: () => null }).getAttribute("data-ss-pg-editable"),   // null: the table is gone
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
// A fourth style with no sizes: its placeholder is the add strip, list box open (R, and the view-only
// control count in P, where the strip must NOT be drawn).
const EMPTY_STYLE = uid("5", 4);
const withEmpty = (t) => ({ ...t, styles: [...t.styles, { id: EMPTY_STYLE, key: "test-empty", label: "Test Empty Shed", code: "TE", active: true, sort_order: 3 }] });
// The local backup (plan 4.9), keyed by user and account: each table writes its own key under that
// (`:<its mount id>`), and one under the plain key is a backup no open table owns (the fixtures seed
// those). `stored` is the newest of them as stored (null when there is none); `storedAll` every one,
// { key: value }.
const BACKUP_KEY = (clientId) => `ss-pg-pending:${USER.id}:${clientId}`;
const storedAll = (page, clientId) => page.evaluate((p) => {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k === p || k.startsWith(p + ":")) out[k] = localStorage.getItem(k); }
  return out;
}, BACKUP_KEY(clientId));
const stored = async (page, clientId) => {
  const all = Object.values(await storedAll(page, clientId));
  if (!all.length) return null;
  const at = (v) => { try { return Number(JSON.parse(v).savedAt) || 0; } catch (_e) { return 0; } };
  return all.sort((a, b) => at(b) - at(a))[0];
};
// The browser's own clipboard events, as a Ctrl/Cmd+C or V on the grid hands them to the page.
const clip = {
  paste: (page, text) => page.evaluate((t) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", t);
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    (document.activeElement || document.body).dispatchEvent(ev);
    return ev.defaultPrevented;
  }, text),
  copy: (page) => page.evaluate(() => {
    const dt = new DataTransfer();
    const ev = new ClipboardEvent("copy", { clipboardData: dt, bubbles: true, cancelable: true });
    (document.activeElement || document.body).dispatchEvent(ev);
    return { prevented: ev.defaultPrevented, text: dt.getData("text/plain") };
  }),
};
const confirmOf = (page) => page.evaluate(() => {
  const d = document.querySelector(".ss-pg-confirm [role=alertdialog]");
  if (!d) return null;
  const p = d.querySelector("p");
  return { text: p ? p.textContent : "", modal: d.getAttribute("aria-modal"), named: !!p && d.getAttribute("aria-labelledby") === p.id,
    focus: document.activeElement && d.contains(document.activeElement) ? document.activeElement.textContent : null };
});
const statusText = (page) => page.evaluate(() => [...document.querySelectorAll(".ss-pg-status > span")].map((d) => d.textContent).join(" | "));
const tsvOf = (rows) => rows.map((r) => r.join("\t") + "\r\n").join("");

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
  ok(`${tag}: the longest name is the 46-character door, drawn whole`, h.longest === LONG && LONG.length === 46, `${h.longest} (${h.longest.length})`);
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
  // At 1000 px, and on the plan's 210 x 38 at both widths (38 columns are wider than 1440), the grid
  // MUST scroll sideways, so the pin is proved there; 25 columns may fit across 1280 and 1440.
  const mustScroll = width === 1000 || run.big;
  if (mustScroll) ok(`${tag}: the grid scrolls sideways, and Size, Price and Offered stay pinned while it does`, sideways, JSON.stringify(pin));
  else ok(`${tag}: the grid fits across without a sideways scroll, or stays pinned in one`, pin.scrollLeft === 0 || sideways, JSON.stringify(pin));
  // The style's name, too (plan 3.6): a band cell that is a scroll container would let it scroll away.
  ok(`${tag}: a style's name stays at the left edge while the grid scrolls sideways`, mustScroll ? pin.scrollLeft > 0 && pin.bandX[0] === pin.bandX[1] : pin.scrollLeft === 0 || pin.bandX[0] === pin.bandX[1], JSON.stringify({ scrollLeft: pin.scrollLeft, bandX: pin.bandX }));
  ok(`${tag}: the header stays pinned while it scrolls down`, pin.scrollTop > 0 && pin.headTop === pin.boxTop + 22, JSON.stringify({ headTop: pin.headTop, boxTop: pin.boxTop }));
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
  // account until it answers, and nothing may be read for it. The viewed builder's rows are a
  // fakeServer, so an edit made in view-as is saved and read back too.
  const cat = catalogFor(VIEWED);
  const F = fakeServer(cat, tableFor(VIEWED, cat));
  const { ctx, page, calls, errors, S } = await open(`/settings/sheds-table?view=${VIEWED}`,
    { own: OPS, operator: true, operatorDelayMs: 2500, cat: (cid) => ({ ...cat, clientId: cid }), fake: F });
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
  // An edit in view-as: the save goes to the viewed builder, and the answer is checked to be theirs.
  const zv = barnOf(F.table(VIEWED))[0];
  const nv = saveCalls(calls).length;
  await typeIn(page, zv.id, 1, "4321");
  const vSaved = await saved(page, calls, nv);
  const vs = saveCalls(calls).slice(nv);
  ok("F: an edit in view-as saves to the viewed builder: targetClientId on the save's body, the answer theirs, the box saved",
    vSaved && vs.length === 1 && vs[0].body.targetClientId === VIEWED && F.size(zv.id).base_price === 4321 && /^All changes saved/.test((await state(page)).badge),
    JSON.stringify(vs.map((c) => ({ t: c.body.targetClientId, sizes: c.body.sizes }))));
  // Plan 8.4: a cold ?view= makes no portal-settings call before arming, and every one after carries
  // targetClientId. ?view= can arm only once is_operator has answered (S.opAt). What may go before it
  // is the shell's own boot for the person signed in, on every portal page: `status` and
  // `get_profile` (12-shell.jsx: issued when nothing is armed, so the answer is provably the caller's
  // own account and never the builder's), and the bodiless ?warm=1 ping. The table sends nothing then.
  const ps = calls.filter((c) => c.fn === "portal-settings");
  const pre = ps.filter((c) => c.at < S.opAt), post = ps.filter((c) => c.at >= S.opAt);
  const SHELL_BOOT = ["status", "get_profile"];
  const what = (c) => (c.warm ? "warm" : c.action) + (c.body.targetClientId !== undefined ? `->${c.body.targetClientId}` : "");
  ok("F: before ?view= arms, no table call and nothing for the builder goes to portal-settings: only the shell's own boot reads for the operator",
    S.opAt != null && pre.every((c) => c.warm || (SHELL_BOOT.includes(c.action) && !c.body.targetClientId)), `before: ${pre.map(what).join(" ")}`);
  ok("F: …and after it, every portal-settings body carries targetClientId: the viewed builder (table reads, the save, the shell's own)",
    post.length >= 3 && post.filter((c) => !c.warm).every((c) => c.body.targetClientId === VIEWED), `after: ${post.map(what).join(" ")}`);
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
  const { ctx, page, calls, errors } = await open(null, { own: OWN, operator: false });
  // The page's own clock: when "Opening…" is first drawn and when the timeout replaces it.
  await page.addInitScript(() => {
    window.__ssHold = {};
    new MutationObserver(() => {
      const t = (document.querySelector(".ss-pg-msg") || {}).textContent || "";
      if (/^Opening /.test(t) && window.__ssHold.opening == null) window.__ssHold.opening = performance.now();
      if (/^Couldn't open that account here\./.test(t) && window.__ssHold.gaveUp == null) window.__ssHold.gaveUp = performance.now();
    }).observe(document, { subtree: true, childList: true, characterData: true });   // the document: its <html> may not exist yet
  });
  await page.goto(`${BASE}/settings/sheds-table?view=${VIEWED}`);
  await page.waitForSelector(".ss-pg-msg", { timeout: 15000 }).catch(() => {});
  const early = await page.locator(".ss-pg-msg").textContent().catch(() => "");
  await page.waitForSelector("text=Couldn't open that account here.", { timeout: 14000 }).catch(() => {});
  const late = await page.locator(".ss-pg-msg").textContent().catch(() => "");
  const hold = await page.evaluate(() => window.__ssHold);
  const took = hold && hold.opening != null && hold.gaveUp != null ? Math.round(hold.gaveUp - hold.opening) : null;
  ok("F: a non-operator holding ?view= sees 'Opening…'", early === `Opening ${VIEWED}…`, early);
  ok("F: …and 10 s after it, not sooner, 'Couldn't open that account here.'", late === "Couldn't open that account here. Close this tab and use the button on Sheds again."
    && took != null && took >= 9950 && took <= 10600, `${late} ${took} ms after 'Opening…' was drawn`);
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

// ── P: editing and autosave (Phase 3) ── (its helpers are above section A: F uses them too)
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
  const { ctx, page, calls, errors, logs, S: srv } = await open("/settings/sheds-table", { cat: () => cat, fake: F, win: { __ssPgBackoffMs: [150, 150, 150, 150] } }, { width: 1280, height: 860 });
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
  // The call landed although every answer was lost: Discard reads the table again, the box shows what
  // is on file, and the status line says part of what was discarded had saved.
  const reads = () => calls.filter((c) => c.fn === "portal-settings" && c.action === "size_table").length;
  for (let i = 0; i < 5; i++) F.script.push({ lose: true });
  let r0 = reads();
  await typeIn(page, barn[2].id, 1, "6161");
  await waitBadge(page, /^Saving stopped/, 20000);
  await page.locator(".ss-pg-bact", { hasText: "Discard these changes" }).click();
  await waitBadge(page, /^All changes saved/, 10000);
  s = await state(page);
  ok("P: Discard after a call that landed anyway: the table is read again, the box shows $6,161 (what is on file), and the status line says so",
    (await look(page, barn[2].id, 1)).text === "$6,161" && F.size(barn[2].id).base_price === 6161 && reads() === r0 + 1
    && s.status === "Part of what you discarded had already saved. The table shows what's on file now.", JSON.stringify({ s, reads: reads() - r0 }));
  await page.locator(".ss-pg-status button", { hasText: "Dismiss" }).click({ timeout: 3000 }).catch(() => {});
  // …and when that read fails too, the badge never says saved: Reload settles it.
  for (let i = 0; i < 5; i++) F.script.push({ lose: true });
  await typeIn(page, barn[3].id, 1, "6262");
  await waitBadge(page, /^Saving stopped/, 20000);
  srv.sizeTableFailures = 1;
  r0 = reads();
  await page.locator(".ss-pg-bact", { hasText: "Discard these changes" }).click();
  const unsure = await waitBadge(page, /^Discarded, but the last try may have saved$/, 8000);
  s = await state(page);
  ok("P: …when that read fails: 'Discarded, but the last try may have saved', with Reload", unsure && reads() === r0 + 1 && s.actions.includes("Reload"), JSON.stringify(s));
  await page.locator(".ss-pg-bact", { hasText: "Reload" }).click({ timeout: 3000 }).catch(() => {});
  ok("P: …and Reload shows what is on file", await waitBadge(page, /^All changes saved/) && (await look(page, barn[3].id, 1)).text === "$6,262" && F.size(barn[3].id).base_price === 6262);
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
//
// Plan 8.4 (Permissions): "enumerate the controls" (memory disabled-ui-fails-silently: a control that
// is missing or disabled raises nothing). Every control the page draws is listed, first on the same
// rows while the page can edit, so the list is known to catch an edit control, then view-only: what
// is left must be a subset with no edit control in it, and every one of them is then used, Back to
// Sheds last, with no save call. The rows carry a size added by mistake (Remove is drawn for it while
// the page can edit) and a style with no sizes (its add strip, while the page can edit).
const REMOVABLE = uid("7", 900);
const withRemovable = (t) => ({ ...t,
  sizes: [...t.sizes, { id: REMOVABLE, style_id: t.styles[0].id, label: "20x40", width_ft: 20, length_ft: 40, base_price: null, active: false, sort_order: 99,
    created_at: "2026-10-25T00:00:00.000001+00:00", updated_at: "2026-10-25T00:00:00.000001+00:00" }],
  counts: { ...t.counts, sizes: t.counts.sizes + 1 } });
// "<kind>:<name>" for every control drawn in the table's frame (the grid itself included: it takes the
// keys). A name is the control's aria-label, its text, its label's text, or its placeholder.
const controlsOf = (page) => page.evaluate(() => {
  const root = document.querySelector(".ss-pg");
  if (!root) return [];
  return [...root.querySelectorAll("button, input, select, textarea, a[href], [contenteditable], [tabindex]")]
    .filter((el) => el.getClientRects().length > 0)
    .map((el) => {
      const tag = el.tagName.toLowerCase();
      // A control inside an add strip is an edit control whatever it is called (List, Add several, ✕).
      const kind = (el.closest("tr[data-add]") ? "strip-" : "") + (tag === "input" ? `input-${el.type}` : tag === "table" ? "grid" : tag);
      const lab = el.closest("label");
      const name = el.getAttribute("aria-label") || (tag === "select" || tag === "table" ? "" : el.textContent)
        || (lab ? lab.textContent : "") || el.getAttribute("placeholder") || el.title || "";
      return `${kind}:${name.trim().replace(/\s+/g, " ").slice(0, 48)}${el.disabled ? " (disabled)" : ""}`;
    });
});
const EDIT_CONTROL = /^(strip-|textarea|input-text|input-number)|:(＋ Add sizes|Remove size .+|Fill down|Clear|Save them)$/;
let editableControls = null;
if (want("P")) {
  const cat = catalogFor(OWN);
  const F = fakeServer(cat, withRemovable(withEmpty(tableFor(OWN, cat))));
  const { ctx, page, errors } = await open("/settings/sheds-table", { cat: () => cat, fake: F }, { width: 1280, height: 860 });
  await waitGrid(page).catch(() => {});
  await page.locator(sel(barnOf(F.table(OWN))[0].id, 1)).click();
  editableControls = await controlsOf(page);
  const edits = [...new Set(editableControls.filter((c) => EDIT_CONTROL.test(c)))];
  ok("P: (set-up) while it can edit, the page draws its edit controls: ＋ Add sizes on every band, Remove on the size added by mistake, the empty style's list box, Fill down and Clear",
    editableControls.filter((c) => c === "button:＋ Add sizes").length === F.table(OWN).styles.length && edits.includes("button:Remove size 20x40") && edits.some((c) => /^strip-textarea/.test(c))
    && edits.includes("button:Fill down") && edits.includes("button:Clear"), `${editableControls.filter((c) => c === "button:＋ Add sizes").length} × Add sizes; ${JSON.stringify(edits)}`);
  ok("P: no page errors (the editable control count)", errors.length === 0, errors.join(" | "));
  await ctx.close();
}
for (const [what, path, S0] of want("P") ? [
  ["?as=", `/settings/sheds-table?view=${VIEWED}&as=${WEAR}`, { own: OPS, operator: true }],
  ["a view-only access map", "/settings/sheds-table", { role: "user", access: { settings_structures: "view", designs: "view" } }],
] : []) {
  const cat = catalogFor(OWN);
  const F = fakeServer(cat, withRemovable(withEmpty(tableFor(OWN, cat))));
  const barn = barnOf(F.table(OWN));
  const LOFT = keyCol(cat, "loft");
  const { ctx, page, calls, errors } = await open(path, { ...S0, cat: (cid) => ({ ...cat, clientId: cid }), fake: F }, { width: 1280, height: 860 });
  await waitGrid(page).catch(() => {});
  const z = barn[0];
  await page.locator(sel(z.id, 1)).click();
  const controls = await controlsOf(page);
  const kinds = [...new Set(controls)];
  ok(`P: view-only (${what}): every control drawn is one the editable page draws too, and none of them edits (no Add sizes, Remove, list box, Fill down, Clear, editor)`,
    !!editableControls && kinds.length > 0 && kinds.every((c) => editableControls.includes(c)) && !kinds.some((c) => EDIT_CONTROL.test(c))
    && !controls.some((c) => / \(disabled\)$/.test(c)), JSON.stringify(kinds));
  // Each control left is then used. Back to Sheds (the link) goes last, below.
  const used = await page.evaluate(async () => {
    const out = [];
    const tick = () => new Promise((r) => setTimeout(r, 120));
    const els = [...document.querySelector(".ss-pg").querySelectorAll("button, input, select")].filter((el) => el.getClientRects().length > 0);
    for (const el of els) {
      const name = (el.getAttribute("aria-label") || el.textContent || (el.closest("label") || {}).textContent || el.tagName).trim();
      if (el.tagName === "SELECT") {
        for (const o of [...el.options].filter((x) => x.value)) { el.value = o.value; el.dispatchEvent(new Event("change", { bubbles: true })); await tick(); }
        out.push(`select ${el.options.length}`);
      } else if (el.isConnected) {
        el.click(); await tick();
        if (el.isConnected && (el.type === "checkbox" || /^\?$/.test(name))) { el.click(); await tick(); }   // put a toggle back
        out.push(name.slice(0, 24));
      }
    }
    return out;
  });
  const z0 = barn[0];
  await page.locator(sel(z0.id, 1)).click();
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
  // The clipboard's and the range's ways in (section V3 tries them on a view-only access map).
  if (what === "?as=") {
    await page.locator(sel(z.id, 1)).click();
    await page.keyboard.press("Shift+ArrowDown");
    await clip.paste(page, "1\t\r\n2\t\r\n"); tries.push(`paste:${(await confirmOf(page)) ? 1 : 0}`);
    await page.keyboard.press("Control+D"); tries.push(`Ctrl+D:${(await confirmOf(page)) ? 1 : 0}`);
    await page.keyboard.press("Delete"); tries.push(`Delete on a range:${(await confirmOf(page)) ? 1 : 0}`);
  }
  await page.waitForTimeout(1300);
  const after = await page.evaluate(() => [...document.querySelectorAll(".ss-pg-grid tbody td")].map((td) => td.textContent).join("|"));
  ok(`P: view-only (${what}) refuses every edit path: no editor, no change, no save call`,
    tries.every((t) => t.endsWith(":0")) && before === after && saveCalls(calls).length === 0 && (await state(page)).badge.startsWith("View only"), tries.join(" "));
  ok(`P: …and using every control it draws sends no save either`, used.length >= 3 && saveCalls(calls).length === 0, used.join(", "));
  await page.locator(".ss-pg-back").click();
  await page.waitForURL((u) => u.pathname === "/settings/sheds", { timeout: 8000 }).catch(() => {});
  ok(`P: …Back to Sheds, last, leaves at once, sending nothing`, new URL(page.url()).pathname === "/settings/sheds" && saveCalls(calls).length === 0, page.url());
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
  // Plan 8.4: that page, left anyway, then opened again: the banner counts the text that was only ever
  // in the editor, and Save them sends it from what was on file. "Left anyway" is the browser going
  // with the page's storage kept: Chrome will not close a page here once its beforeunload was
  // answered "stay" (page.close hangs), so the next browser starts with what this one stored.
  if (asks && /editor holds changed text/.test(what)) {
    const z = barn[0], loft0 = F.cells(z.id).loft || 0;
    const left = await stored(page, OWN);
    ok(`P: no page errors (leaving ${what})`, errors.length === 0, errors.join(" | "));
    await ctx.close();
    const re = await open("/settings/sheds-table", { cat: () => cat, fake: F, storage: left ? { [BACKUP_KEY(OWN)]: left } : {} }, { width: 1280, height: 860 });
    await waitGrid(re.page).catch(() => {});
    await re.page.waitForSelector(".ss-pg-earlier", { timeout: 8000 }).catch(() => {});
    const banner = await re.page.locator(".ss-pg-earlier span").textContent({ timeout: 1000 }).catch(() => null);
    await re.page.locator(".ss-pg-earlier button", { hasText: "Save them" }).click({ timeout: 3000 }).catch(() => {});
    const went = await saved(re.page, re.calls, 0, 1, 15000);
    const sent = (saveCalls(re.calls)[0] || { body: { sizes: [] } }).body.sizes;
    ok("P: …left anyway and opened again: the banner offers the editor's text back, and Save them sends it from what was on file",
      !!left && banner === "You have 1 change from earlier that wasn't saved." && went
      && JSON.stringify(sent) === JSON.stringify([{ id: z.id, base: z.updated_at, from: { cells: { loft: loft0 } }, to: { cells: { loft: 77 } } }]) && F.cells(z.id).loft === 77,
      JSON.stringify({ banner, sent, left: left && JSON.parse(left).draft }));
    ok(`P: no page errors (reopened after leaving ${what})`, re.errors.length === 0, re.errors.join(" | "));
    await re.ctx.close();
    continue;
  }
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

// Leaving never drops a box that didn't save unseen (review 2026-10-31): Back with text the rules
// refuse stays on that box; Back whose save comes back changed elsewhere stays and jumps to it; Back
// while saving is stopped says the page stayed, and Leave anyway leaves.
if (want("P")) {
  const cat = catalogFor(OWN);
  const F = fakeServer(cat, tableFor(OWN, cat));
  const barn = barnOf(F.table(OWN));
  const LOFT = keyCol(cat, "loft");
  const { ctx, page, calls, errors } = await open("/settings/sheds-table", { cat: () => cat, fake: F, win: { __ssPgBackoffMs: [150, 150, 150, 150] } }, { width: 1280, height: 860 });
  await waitGrid(page).catch(() => {});
  const here = () => new URL(page.url()).pathname === "/settings/sheds-table";
  // Each step starts on the table: a page that left wrongly is opened again, so the next step still runs.
  const reopen = async () => { if (!here()) { await page.goto(`${BASE}/settings/sheds-table`); await waitGrid(page).catch(() => {}); } };
  await page.locator(sel(barn[0].id, LOFT)).click();
  await page.keyboard.type("abc");
  await page.locator(".ss-pg-back").click();
  await page.waitForTimeout(500);
  let s = await state(page);
  ok("P: Back with 'abc' in the editor stays, on that box, red, with the reason on the status line; nothing is sent",
    here() && s.readout === `Loft (sq ft) · ${named(barn[0])}` && /ss-pg-m-r/.test((await look(page, barn[0].id, LOFT)).cls)
    && s.status === `${named(barn[0])} · Loft (sq ft): “abc” wasn't saved. Whole numbers only, 0 or more.` && saveCalls(calls).length === 0, JSON.stringify({ url: page.url(), s }));
  await page.locator(".ss-pg-status button", { hasText: "Dismiss" }).click({ timeout: 3000 }).catch(() => {});
  await reopen();
  F.script.push({ before: (f) => f.poke(barn[1].id, { price: 4950 }) });
  await typeIn(page, barn[1].id, 1, "4800");
  await page.locator(".ss-pg-back").click();
  await waitBadge(page, /^1 box needs you$/);
  await page.waitForTimeout(300);
  s = await state(page);
  ok("P: Back whose save comes back changed elsewhere stays, jumps to that box, and the status line gives both numbers",
    here() && s.readout === `Price · ${named(barn[1])}` && saveCalls(calls).length === 1
    && s.status === `${named(barn[1])} · Price: changed elsewhere to $4,950 while you typed $4,800. Type it again if yours is right.`, JSON.stringify({ url: page.url(), s }));
  await page.locator(".ss-pg-status button", { hasText: "Dismiss" }).click({ timeout: 3000 }).catch(() => {});
  await reopen();
  for (let i = 0; i < 5; i++) F.script.push({ status: 500 });
  await typeIn(page, barn[2].id, 1, "1234");
  await waitBadge(page, /^Saving stopped/, 20000);
  await page.locator(".ss-pg-back").click();
  await page.waitForTimeout(300);
  s = await state(page);
  const btns = await page.evaluate(() => [...document.querySelectorAll(".ss-pg-status button")].map((b) => b.textContent));
  ok("P: Back while saving is stopped stays and says so, with Leave anyway (the click is never swallowed)",
    here() && s.status === "1 change isn't saved yet, so you're still on this page." && btns.join() === "Leave anyway,Dismiss", JSON.stringify({ s, btns }));
  await page.locator(".ss-pg-status button", { hasText: "Leave anyway" }).click({ timeout: 3000 }).catch(() => {});
  await page.waitForURL(/\/settings\/sheds$/, { timeout: 5000 }).catch(() => {});
  ok("P: …and Leave anyway leaves", new URL(page.url()).pathname === "/settings/sheds", page.url());
  ok("P: no page errors (leaving stays)", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// Go to Options (shown when there are no option columns, where Price and Offered still save) sends
// first, as Back does; leaving any other way inside the app (the browser's Back) sends what waits on
// the way out.
for (const how of want("P") ? ["Go to Options", "the browser's Back"] : []) {
  const cat = catalogFor(OWN, { cols: "none" });
  const F = fakeServer(cat, tableFor(OWN, cat));
  const barn = barnOf(F.table(OWN));
  const { ctx, page, calls, errors } = await open("/settings/sheds-table", { cat: () => cat, fake: F }, { width: 1280, height: 860 });
  await waitGrid(page).catch(() => {});
  await page.locator(sel(barn[0].id, 1)).click();
  await page.keyboard.type("7777");
  let dest;
  if (how === "Go to Options") {
    await page.locator(".ss-pg-optbox a", { hasText: "Go to Options" }).click();
    dest = "/settings/options";
  } else {
    await page.keyboard.press("Enter");
    await page.evaluate(() => { window.history.pushState({}, "", "/settings/sheds"); window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state })); });
    dest = "/settings/sheds";
  }
  await page.waitForURL((u) => u.pathname === dest, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(800);
  const sc = saveCalls(calls);
  ok(`P: leaving by ${how} with a price just typed sends it on the way (one call), and the table is gone`,
    new URL(page.url()).pathname === dest && sc.length === 1 && JSON.stringify(sc[0].body.sizes[0].to) === '{"price":7777}' && F.size(barn[0].id).base_price === 7777
    && (await page.locator(".ss-pg-grid").count()) === 0, JSON.stringify({ url: page.url(), saves: sc.map((x) => x.body.sizes) }));
  ok(`P: no page errors (${how})`, errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// The browser's own Back inside the app (review round 2, 2026-10-31). The entry before the table
// becomes Sheds (as after Back to Sheds, then Forward), and history.back() moves the address bar
// before any script sees it, as a real Back does. Resolves once that popstate has been handled. The
// cases below read the page's own location: Playwright's page.url() can still be on the Sheds
// address written here a moment before.
const browserBack = (page) => page.evaluate(() => new Promise((done) => {
  const st = window.history.state;
  window.history.replaceState(null, "", "/settings/sheds");
  window.history.pushState(st, "", "/settings/sheds-table");
  window.addEventListener("popstate", () => setTimeout(done, 50), { once: true });
  window.history.back();
}));
const pathOf = (page) => page.evaluate(() => window.location.pathname).catch(() => null);
const waitPath = (page, path, timeout) => page.waitForFunction((p) => window.location.pathname === p, path, { timeout }).then(() => true, () => false);
// Held while anything waits: a follow-up still in the editor behind a call out goes after that call's
// answer, then the page goes where Back was going; a Back whose save comes back changed elsewhere
// stays on that box; a Back while saving is stopped says the page stayed, and Leave anyway goes where
// Back was going. Before, the page unmounted at once: the follow-up was never sent, a red answer was
// never read.
if (want("P")) {
  const cat = catalogFor(OWN);
  const F = fakeServer(cat, tableFor(OWN, cat));
  const barn = barnOf(F.table(OWN));
  F.delayMs = 1500;
  const { ctx, page, calls, errors, dialogs } = await open("/settings/sheds-table", { cat: () => cat, fake: F, win: { __ssPgBackoffMs: [150, 150, 150, 150] } }, { width: 1280, height: 860 });
  await waitGrid(page).catch(() => {});
  const here = async () => (await pathOf(page)) === "/settings/sheds-table";
  const gone = async () => (await pathOf(page)) === "/settings/sheds" && (await page.locator(".ss-pg-grid").count()) === 0;
  await typeIn(page, barn[0].id, 1, "5150");
  await waitBadge(page, /^Saving/);
  await page.locator(sel(barn[0].id, 1)).click();
  await page.keyboard.type("6000");                 // a follow-up of the same box, still in the editor
  await browserBack(page);
  let s = await state(page);
  ok("P: the browser's Back while a save is out, with a follow-up in the editor, keeps the table (and its address) while it saves",
    await here() && s.editable === "1" && /^Saving/.test(s.badge) && !s.editor, JSON.stringify({ at: await pathOf(page), s }));
  await waitPath(page, "/settings/sheds", 10000);
  await page.waitForTimeout(300);
  const sc = saveCalls(calls);
  ok("P: …sends the follow-up after the answer, then goes where Back was going",
    await gone() && sc.map((x) => JSON.stringify(x.body.sizes[0].to)).join() === '{"price":5150},{"price":6000}' && F.size(barn[0].id).base_price === 6000 && !dialogs.length,
    JSON.stringify({ at: await pathOf(page), saves: sc.map((x) => x.body.sizes), dialogs }));
  await page.goto(`${BASE}/settings/sheds-table`);
  await waitGrid(page).catch(() => {});
  F.script.push({ before: (f) => f.poke(barn[1].id, { price: 4950 }) });
  await typeIn(page, barn[1].id, 1, "4800");
  await waitBadge(page, /^Saving/);
  await browserBack(page);
  await waitBadge(page, /^1 box needs you$/);
  await page.waitForTimeout(300);
  s = await state(page);
  ok("P: the browser's Back whose save comes back changed elsewhere stays, jumps to that box, and the status line gives both numbers",
    await here() && s.readout === `Price · ${named(barn[1])}` && F.size(barn[1].id).base_price === 4950
    && s.status === `${named(barn[1])} · Price: changed elsewhere to $4,950 while you typed $4,800. Type it again if yours is right.`, JSON.stringify({ at: await pathOf(page), s }));
  F.delayMs = 0;
  for (let i = 0; i < 5; i++) F.script.push({ status: 500 });
  await typeIn(page, barn[2].id, 1, "1234");
  await waitBadge(page, /^Saving stopped/, 20000);
  await browserBack(page);
  await page.waitForTimeout(300);
  s = await state(page);
  ok("P: the browser's Back while saving is stopped stays and says so, with Leave anyway",
    await here() && s.status === "1 change isn't saved yet, so you're still on this page.", JSON.stringify({ at: await pathOf(page), s }));
  await page.locator(".ss-pg-status button", { hasText: "Leave anyway" }).click({ timeout: 3000 }).catch(() => {});
  await waitPath(page, "/settings/sheds", 5000);
  await page.waitForTimeout(300);
  ok("P: …and Leave anyway goes where Back was going", await gone(), String(await pathOf(page)));
  ok("P: no page errors (the browser's Back, held)", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// Back to Sheds waits for its save; a box clicked and typed into meanwhile calls the leave off, so the
// editor's text is never dropped by the page going (review round 2). The editor's text alone holds
// the browser's Back too, and goes first; with nothing waiting, Back leaves at once.
if (want("P")) {
  const cat = catalogFor(OWN);
  const F = fakeServer(cat, tableFor(OWN, cat));
  const barn = barnOf(F.table(OWN));
  const LOFT = keyCol(cat, "loft");
  F.delayMs = 1500;
  const { ctx, page, calls, errors, dialogs } = await open("/settings/sheds-table", { cat: () => cat, fake: F }, { width: 1280, height: 860 });
  await waitGrid(page).catch(() => {});
  const here = async () => (await pathOf(page)) === "/settings/sheds-table";
  await typeIn(page, barn[0].id, 1, "5151");
  await page.locator(".ss-pg-back").click();       // waits for that save
  await page.waitForTimeout(300);
  await page.locator(sel(barn[1].id, 1)).click();
  await page.keyboard.type("4321");                 // back to work: the editor holds 4321
  await page.waitForTimeout(2500);                  // the first save has landed meanwhile
  let s = await state(page);
  ok("P: a box typed into while Back to Sheds waits for its save keeps the page, and the editor its text",
    await here() && !!s.editor && s.editor.value === "4321" && s.editor.focused && F.size(barn[0].id).base_price === 5151 && s.badge === "1 change not saved yet",
    JSON.stringify({ at: await pathOf(page), s }));
  const n0 = saveCalls(calls).length;
  await page.keyboard.press("Enter");
  ok("P: …and that text saves like any other edit", await saved(page, calls, n0) && F.size(barn[1].id).base_price === 4321 && await here(), String(await pathOf(page)));
  await page.locator(sel(barn[2].id, LOFT)).click();
  await page.keyboard.type("99");                   // never committed
  await browserBack(page);
  s = await state(page);
  const held = await here() && /^Saving/.test(s.badge) && !s.editor;
  await waitPath(page, "/settings/sheds", 10000);
  await page.waitForTimeout(300);
  const sc = saveCalls(calls);
  ok("P: the browser's Back with only the editor's text holds the page, sends that text, then goes",
    held && (await pathOf(page)) === "/settings/sheds" && (await page.locator(".ss-pg-grid").count()) === 0
    && sc.length === n0 + 2 && JSON.stringify(sc[sc.length - 1].body.sizes[0].to) === '{"cells":{"loft":99}}' && F.cells(barn[2].id).loft === 99,
    JSON.stringify({ held, at: await pathOf(page), saves: sc.slice(n0).map((x) => x.body.sizes) }));
  await page.goto(`${BASE}/settings/sheds-table`);
  await waitGrid(page).catch(() => {});
  const n1 = saveCalls(calls).length;
  await browserBack(page);
  await page.waitForTimeout(200);
  ok("P: with nothing waiting, the browser's Back leaves at once and sends nothing",
    (await pathOf(page)) === "/settings/sheds" && (await page.locator(".ss-pg-grid").count()) === 0 && saveCalls(calls).length === n1, String(await pathOf(page)));
  ok("P: no page errors (back to work while leaving)", errors.length === 0 && !dialogs.length, errors.join(" | ") + JSON.stringify(dialogs));
  await ctx.close();
}

// "1 box needs you" reaches a red box that is folded away: on a hidden size with "Show hidden sizes"
// off, it unfolds it first.
if (want("P")) {
  const cat = catalogFor(OWN);
  const F = fakeServer(cat, tableFor(OWN, cat));
  const barn = barnOf(F.table(OWN));
  const LOFT = keyCol(cat, "loft");
  const hid = barn.find((z) => z.base_price == null || !z.active);
  const { ctx, page, errors } = await open("/settings/sheds-table", { cat: () => cat, fake: F }, { width: 1280, height: 860 });
  await waitGrid(page).catch(() => {});
  await typeIn(page, hid.id, LOFT, "abc");
  await page.locator(".ss-pg-tog input").uncheck();
  await page.waitForTimeout(200);
  const folded = (await page.locator(`tr[data-s="${hid.id}"]`).count()) === 0;
  await page.locator(".ss-pg-badge-btn").click();
  await page.waitForTimeout(300);
  const s = await state(page);
  ok("P: '1 box needs you' unfolds a hidden size to reach its red box, and the status line says why",
    folded && (await page.locator(".ss-pg-tog input").isChecked()) && s.readout === `Loft (sq ft) · ${named(hid)}`
    && s.status === `${named(hid)} · Loft (sq ft): “abc” wasn't saved. Whole numbers only, 0 or more.`, JSON.stringify({ folded, s }));
  ok("P: no page errors (red box folded away)", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// The editor open while an answer moves its box: Offered goes out, a colleague's price lands first,
// and the conflict on Offered brings that price in under the editor. What is then typed was typed
// against the old price: it goes red with both numbers and is never sent; the colleague's stands.
if (want("P")) {
  const cat = catalogFor(OWN);
  const F = fakeServer(cat, tableFor(OWN, cat));
  const z = barnOf(F.table(OWN))[0];
  const { ctx, page, calls, errors } = await open("/settings/sheds-table", { cat: () => cat, fake: F }, { width: 1280, height: 860 });
  await waitGrid(page).catch(() => {});
  F.script.push({ before: (f) => f.poke(z.id, { price: 4950 }) });
  await page.locator(sel(z.id, 2)).click();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Enter");
  const opened = (await state(page)).editor;
  const until = Date.now() + 10000;
  while (Date.now() < until && !(saveCalls(calls).length >= 2 && /^All changes saved/.test((await state(page)).badge))) await sleep(60);
  const under = (await look(page, z.id, 1)).text;
  await page.keyboard.press("Control+a");
  await page.keyboard.type("5000");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1300);
  const s = await state(page);
  const c = await look(page, z.id, 1);
  ok("P: the editor open while an answer brought a colleague's price: what was typed goes red with both numbers, is never sent, and the colleague's price stands",
    !!opened && opened.value === String(z.base_price) && under === "$4,950" && saveCalls(calls).length === 2 && F.size(z.id).base_price === 4950 && F.size(z.id).active === false
    && c.text === "$4,950" && /ss-pg-m-c/.test(c.cls) && s.readout === `Price · ${named(z)}`
    && s.status === `${named(z)} · Price: changed elsewhere to $4,950 while you typed $5,000. Type it again if yours is right.`, JSON.stringify({ opened, under, s, c, saves: saveCalls(calls).map((x) => x.body.sizes) }));
  ok("P: no page errors (editor open under an answer)", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// ── R: adding sizes, Remove, the refresh and the backup (Phase 4a) ──
// Against fakeServer, which answers creates and removes as migration 350 does. A fourth style has no
// sizes: its placeholder is the add strip, list box open (withEmpty, above section A).
const UUIDV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// The rows under a band, down to the next band: sizes ({ id, label, price, rm, wait, off, offTitle }),
// the add strip ({ kind: "add" }) and placeholders ({ kind: "note" }).
const bandRows = (page, styleId) => page.evaluate((id) => {
  const band = document.querySelector(`tr[data-band="${id}"]`);
  const out = [];
  for (let tr = band && band.nextElementSibling; tr && !tr.hasAttribute("data-band") && !tr.classList.contains("ss-pg-hs"); tr = tr.nextElementSibling) {
    if (tr.hasAttribute("data-s")) {
      out.push({ id: tr.getAttribute("data-s"), label: tr.children[0].childNodes[0] ? tr.children[0].childNodes[0].textContent : "", price: tr.children[1].textContent,
        rm: !!tr.querySelector(".ss-pg-rm"), wait: (tr.querySelector(".ss-pg-wait") || {}).textContent || "", off: tr.children[2].className, offTitle: tr.children[2].title });
    } else out.push({ kind: tr.hasAttribute("data-add") ? "add" : "note", text: tr.textContent });
  }
  return out;
}, styleId);
const reads = (calls) => calls.filter((c) => c.fn === "portal-settings" && (c.action === "size_table" || (c.action === "catalog" && "targetClientId" in c.body)));
// Another tab of the same browser, on the same origin (BroadcastChannel reaches it).
async function tabOf(ctx, path) {
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  p.on("console", (m) => { if (m.type() === "error" && /Minified React error|#310|Rendered more hooks/.test(m.text())) errs.push(m.text()); });
  p.on("dialog", (d) => d.dismiss().catch(() => {}));
  await p.goto(`${BASE}${path}`);
  return { p, errs };
}
// The page sees its tab hidden and shown again (headless Chrome never hides a tab by itself).
const hideAndShow = (page) => page.evaluate(() => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  document.dispatchEvent(new Event("visibilitychange"));
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  document.dispatchEvent(new Event("visibilitychange"));
});

// R1: add from a list, Adding…, a price typed meanwhile, Add several with an untick, the empty
// style's placeholder, Remove (and one the server refuses).
if (want("R")) {
  const cat = catalogFor(OWN);
  const t0 = withEmpty(tableFor(OWN, cat));
  const F = fakeServer(cat, t0);
  F.delayMs = 700;   // long enough to see "Adding…"
  const { ctx, page, calls, errors } = await open("/settings/sheds-table", { cat: () => cat, fake: F }, { width: 1280, height: 860 });
  await waitGrid(page).catch(() => {});
  const barn = t0.styles[0], lofted = t0.styles[1];
  const before = barnOf(F.table(OWN));
  const strip = `tr[data-add="${barn.id}"]`;

  await page.locator(`tr[data-band="${barn.id}"] .ss-pg-addbtn`).click();
  let st = await page.evaluate((id) => {
    const row = document.querySelector(`tr[data-add="${id}"]`);
    const a = document.activeElement;
    return row ? { text: row.textContent, focused: !!a && a.tagName === "TEXTAREA" && row.contains(a), afterBand: !!row.previousElementSibling && row.previousElementSibling.getAttribute("data-band") === id,
      label: document.querySelector(`tr[data-band="${id}"] .ss-pg-addbtn`).getAttribute("aria-expanded") } : null;
  }, barn.id);
  ok("R: '＋ Add sizes' opens the strip right under its band, the cursor in its list box", !!st && st.focused && st.afterBand && /^Add sizes to Test Barn/.test(st.text) && st.label === "true", JSON.stringify(st));
  let n0 = saveCalls(calls).length;
  await page.keyboard.type("14x20, 10y12");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  let err = await page.locator(`${strip} .ss-pg-adderr`).textContent().catch(() => "");
  ok("R: one bad entry refuses the whole add and names it; nothing is sent", err === "Nothing added. “10y12” isn't a size like 10x12." && saveCalls(calls).length === n0 && !(await page.$(`${strip} ~ tr[data-s] .ss-pg-wait`)), err);
  await page.locator(`${strip} textarea`).fill("600x12");
  await page.keyboard.press("Enter");
  err = await page.locator(`${strip} .ss-pg-adderr`).textContent().catch(() => "");
  ok("R: …a size past the server's rule is refused the same way", err === "Nothing added. “600x12”: a width or length is above 0, at most 500, with at most 2 decimals.", err);
  await page.locator(`${strip} textarea`).fill("14x20, 14 x 24; 10x12, 14X20");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(120);
  await page.mouse.move(2, 2);   // off the header, whose names would take over the readout
  let rows = await bandRows(page, barn.id);
  const news = rows.filter((r) => r.id && !before.some((z) => z.id === r.id));
  ok("R: the new sizes go after the style's last size, in the order typed, each saying 'Adding…'; the strip closes",
    JSON.stringify(news.map((r) => [r.label, r.wait])) === JSON.stringify([["14x20", "Adding…"], ["14x24", "Adding…"]]) && rows[rows.length - 1].id === (news[1] || {}).id
    && !rows.some((r) => r.kind === "add"), JSON.stringify(rows.slice(-3)));
  let s = await state(page);
  ok("R: …the size already there is named; repeats collapse", s.status === "10x12 is already in Test Barn, so it was skipped.", s.status);
  ok("R: …and the cursor is on the first new price", s.readout === "Price · Test Barn 14x20", s.readout);
  await page.keyboard.type("3000");
  await page.keyboard.press("Enter");
  ok("R: …saved", await saved(page, calls, n0, 2, 20000));
  const sc = saveCalls(calls).slice(n0);
  const c1 = sc[0] && sc[0].body, c2 = sc[1] && sc[1].body;
  ok("R: the first call carries the two creates, in the order typed, with ids minted here, and nothing else",
    !!c1 && c1.creates.length === 2 && c1.creates.every((c) => UUIDV4.test(c.id) && c.styleId === barn.id) && c1.creates.map((c) => `${c.width}x${c.length}`).join() === "14x20,14x24"
    && c1.creates.map((c) => c.id).join() === news.map((r) => r.id).join() && !c1.removes.length && !c1.sizes.length && sc.length === 2, JSON.stringify(sc.map((x) => x.body)));
  const z20 = F.size(news[0] && news[0].id), z24 = F.size(news[1] && news[1].id);
  ok("R: the price typed while it was being added waited for the answer, then went on the create's version, from blank",
    !!c2 && !!z20 && JSON.stringify(c2.sizes) === JSON.stringify([{ id: z20.id, base: z20.created_at, from: { price: null }, to: { price: 3000 } }]) && !c2.creates.length, JSON.stringify(c2));
  const maxSort = Math.max(...before.map((z) => z.sort_order));
  ok("R: the server put them at the end of Test Barn (max + 1, in order); the first price ticked Offered",
    !!z20 && !!z24 && z20.sort_order === maxSort + 1 && z24.sort_order === maxSort + 2 && z20.base_price === 3000 && z20.active === true && z24.label === "14x24", JSON.stringify([z20, z24]));
  rows = await bandRows(page, barn.id);
  const r20 = rows.find((r) => r.id === (z20 || {}).id), r24 = rows.find((r) => r.id === (z24 || {}).id);
  ok("R: answered: no more 'Adding…'; the unpriced new size has Offered greyed ('Add a price to offer it') and a Remove",
    !!r24 && !r24.wait && /ss-pg-dis/.test(r24.off) && r24.offTitle === "Add a price to offer it" && r24.rm, JSON.stringify(r24));
  ok("R: …the priced one has none, nor does any size the server had already (edited since it was added)",
    !!r20 && !r20.rm && rows.filter((r) => r.id && before.some((z) => z.id === r.id)).every((r) => !r.rm), JSON.stringify(rows.map((r) => [r.label, r.rm])));
  await page.screenshot({ path: join(shots, "R-added.png") });

  // Remove: through the queue, sent at once; the row goes with the answer.
  n0 = saveCalls(calls).length;
  await page.locator(`tr[data-s="${z24.id}"] .ss-pg-rm`).click();
  const went = await page.waitForFunction((id) => !document.querySelector(`tr[data-s="${id}"]`), z24.id, { timeout: 10000 }).then(() => true, () => false);
  const rc = saveCalls(calls).slice(n0);
  ok("R: Remove sends one remove, and the row goes once it is answered; the size is gone from the server",
    went && rc.length === 1 && JSON.stringify(rc[0].body.removes) === JSON.stringify([z24.id]) && !rc[0].body.creates.length && !rc[0].body.sizes.length && !F.size(z24.id),
    JSON.stringify(rc.map((c) => c.body)));
  // A remove the server refuses (the size was changed elsewhere since): the row stays, the status line
  // says why, and a fresh read takes its Remove away.
  await page.locator(`tr[data-band="${barn.id}"] .ss-pg-addbtn`).click();
  await page.locator(`${strip} textarea`).fill("16x40");
  n0 = saveCalls(calls).length;
  await page.keyboard.press("Enter");
  await saved(page, calls, n0, 1);
  const r40 = (await bandRows(page, barn.id)).find((r) => r.label === "16x40");
  F.script.push({ before: (FF) => FF.poke(r40.id, {}) });
  await page.locator(`tr[data-s="${r40.id}"] .ss-pg-rm`).click();
  await page.waitForFunction(() => /Only a size that was never priced or edited can be removed/.test([...document.querySelectorAll(".ss-pg-status > span")].map((d) => d.textContent).join(" ")), null, { timeout: 10000 }).catch(() => {});
  s = await state(page);
  const stays = !!(await page.$(`tr[data-s="${r40.id}"]`));
  const rmGone = await page.waitForFunction((id) => { const tr = document.querySelector(`tr[data-s="${id}"]`); return !!tr && !tr.querySelector(".ss-pg-rm"); }, r40.id, { timeout: 8000 }).then(() => true, () => false);
  ok("R: a remove the server refuses keeps the row and says why; the re-read then takes its Remove away",
    stays && s.status.includes("Only a size that was never priced or edited can be removed. Untick Offered to hide it.") && rmGone && !!F.size(r40.id), s.status);
  await page.locator(".ss-pg-status button", { hasText: "Dismiss" }).click({ timeout: 3000 }).catch(() => {});

  // Add several: widths × lengths, a tick-box grid, sizes already there greyed, one unticked.
  const ls = `tr[data-add="${lofted.id}"]`;
  await page.locator(`tr[data-band="${lofted.id}"] .ss-pg-addbtn`).click();
  await page.locator(`${ls} button`, { hasText: "Add several" }).click();
  await page.locator(`${ls} input.ss-pg-addnum`).nth(0).fill("10, 12, 16");
  await page.locator(`${ls} input.ss-pg-addnum`).nth(1).fill("16, 40");
  const grid = await page.evaluate((sx) => {
    const g = document.querySelector(`${sx} .ss-pg-tick`);
    return g ? { cols: getComputedStyle(g).gridTemplateColumns.split(" ").length, heads: [...g.querySelectorAll(".ss-pg-tickh")].map((x) => x.textContent),
      there: [...g.querySelectorAll(".ss-pg-there")].map((x) => `${x.textContent}: ${x.title}`), boxes: [...g.querySelectorAll("input[type=checkbox]")].map((b) => [b.getAttribute("aria-label"), b.checked]),
      go: (document.querySelector(`${sx} .ss-pg-addgo`) || {}).textContent } : null;
  }, ls);
  ok("R: Add several: a tick-box grid, widths down and lengths across, every new size ticked, the ones already in the style greyed 'already there'",
    !!grid && grid.cols === 3 && grid.heads.join() === "16,40,10,12,16" && JSON.stringify(grid.boxes) === JSON.stringify([["10x40", true], ["12x40", true], ["16x16", true], ["16x40", true]])
    && grid.there.join(" | ") === "already there: 10x16 is already in Test Lofted Barn | already there: 12x16 is already in Test Lofted Barn" && grid.go === "Add 4 sizes", JSON.stringify(grid));
  await page.locator(`${ls} input[aria-label="16x40"]`).uncheck();
  await page.locator(ls).screenshot({ path: join(shots, "R-several.png") });
  const go = await page.locator(`${ls} .ss-pg-addgo`).textContent();
  n0 = saveCalls(calls).length;
  await page.locator(`${ls} .ss-pg-addgo`).click();
  await saved(page, calls, n0, 1);
  const sev = saveCalls(calls).slice(n0)[0];
  rows = await bandRows(page, lofted.id);
  ok("R: …untick one and it says Add 3 sizes; they go in grid order, row by row, at the end of the style, and the strip closes",
    go === "Add 3 sizes" && !!sev && sev.body.creates.map((c) => `${c.width}x${c.length}`).join() === "10x40,12x40,16x16"
    && rows.slice(-3).map((r) => r.label).join() === "10x40,12x40,16x16" && !rows.some((r) => r.kind === "add"), JSON.stringify([go, sev && sev.body.creates, rows.slice(-4)]));

  // The empty style: its placeholder is the strip, list box already open; Enter adds.
  const es = `tr[data-add="${EMPTY_STYLE}"]`;
  const ph = await page.evaluate((sx) => { const row = document.querySelector(sx); return row ? { text: row.textContent, box: !!row.querySelector("textarea"), close: !!row.querySelector(".ss-pg-addx") } : null; }, es);
  await page.locator(es).scrollIntoViewIfNeeded().catch(() => {});
  await page.locator(es).screenshot({ path: join(shots, "R-empty.png") }).catch(() => {});
  ok("R: a style with no sizes shows 'No sizes yet. Type sizes like 10x12, 12x16 and press Enter' with the list box already open",
    !!ph && ph.text.startsWith("No sizes yet. Type sizes like 10x12, 12x16 and press Enter") && ph.box && !ph.close, JSON.stringify(ph));
  await page.locator(`${es} textarea`).fill("8x8\n8x10");
  n0 = saveCalls(calls).length;
  await page.keyboard.press("Enter");
  await saved(page, calls, n0, 1);
  rows = await bandRows(page, EMPTY_STYLE);
  ok("R: …sizes typed there (one per line) are added under the band, and the placeholder makes way", rows.map((r) => r.label || r.kind).join() === "8x8,8x10", JSON.stringify(rows));
  // Escape closes a strip; the server never saw a 400.
  await page.locator(`tr[data-band="${barn.id}"] .ss-pg-addbtn`).click();
  await page.keyboard.press("Escape");
  ok("R: Escape closes the strip", !(await page.$(strip)));
  ok("R: no call was malformed (the browser's checks are the server's)", F.bad.length === 0, F.bad.join());
  ok("R: no page errors (adding and removing)", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// R2: ?style= (Add style's link) opens the table jumped to that style with its add box open and the
// cursor in it: the empty style's placeholder, or a strip under a style that has sizes.
for (const which of want("R") ? ["empty", "sized"] : []) {
  const cat = catalogFor(OWN);
  const F = fakeServer(cat, withEmpty(tableFor(OWN, cat)));
  const target = which === "empty" ? EMPTY_STYLE : uid("5", 2);
  const { ctx, page, errors } = await open(`/settings/sheds-table?style=${target}`, { cat: () => cat, fake: F });
  await waitGrid(page).catch(() => {});
  const got = await page.waitForFunction((id) => { const a = document.activeElement; const row = document.querySelector(`tr[data-add="${id}"]`); return !!row && !!a && row.contains(a) && a.tagName === "TEXTAREA"; }, target, { timeout: 8000 }).then(() => true, () => false);
  ok(`R: ?style= opens the table on that style with its add box open and the cursor in it (${which === "empty" ? "a style with no sizes" : "a style with sizes"})`, got);
  ok(`R: no page errors (?style=, ${which})`, errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// R1b: the keyboard's ways to "＋ Add sizes" and to Remove (the band's button and the ✕ sit past every
// box Tab moves through): Alt+Enter on a size opens its style's strip, Delete on a Size box removes a
// size added by mistake. The ring stays on its box while the strip above it grows (Add several, its
// tick-box grid). A size whose Remove is out takes no edit, and says why.
if (want("R")) {
  const cat = catalogFor(OWN);
  const t0 = tableFor(OWN, cat);
  const F = fakeServer(cat, t0);
  const { ctx, page, calls, errors } = await open("/settings/sheds-table", { cat: () => cat, fake: F }, { width: 1280, height: 860 });
  await waitGrid(page).catch(() => {});
  const barn = t0.styles[0];
  const z1 = barnOf(F.table(OWN))[1];
  const strip = `tr[data-add="${barn.id}"]`;
  const ringOn = (a) => page.evaluate((s0) => {
    const r = [...document.querySelectorAll(".ss-pg-ring")].find((x) => x.style.display === "block");
    const td = document.querySelector(s0);
    return r && td ? [r.getBoundingClientRect(), td.getBoundingClientRect()].map((b) => [b.left, b.top, b.width, b.height].map(Math.round).join()) : null;
  }, a);
  await page.locator(sel(z1.id, 1)).click();
  await page.keyboard.press("Alt+Enter");
  const opened = await page.waitForFunction((sx) => { const row = document.querySelector(sx), a = document.activeElement; return !!row && !!a && row.contains(a) && a.tagName === "TEXTAREA"; }, strip, { timeout: 4000 }).then(() => true, () => false);
  ok("R: Alt+Enter on a size opens its style's '＋ Add sizes', the cursor in the list box", opened);
  // The strip opened by its button from here on, so a failure above does not hide what follows.
  if (!(await page.$(strip))) await page.locator(`tr[data-band="${barn.id}"] .ss-pg-addbtn`).click();
  const r0 = await ringOn(sel(z1.id, 1));
  await page.locator(`${strip} button`, { hasText: "Add several" }).click();
  await page.locator(`${strip} input.ss-pg-addnum`).nth(0).fill("8, 10, 12, 14");
  await page.locator(`${strip} input.ss-pg-addnum`).nth(1).fill("30, 40");
  await page.waitForSelector(`${strip} .ss-pg-tick`, { timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(150);
  const r1 = await ringOn(sel(z1.id, 1));
  ok("R: the ring stays on its box while the add strip above it grows (Add several, its tick-box grid)",
    !!r0 && !!r1 && r0[0] === r0[1] && r1[0] === r1[1] && r1[1] !== r0[1], JSON.stringify({ r0, r1 }));
  await page.keyboard.press("Escape");
  ok("R: …Escape closes it", !(await page.$(strip)));
  await page.keyboard.press("Alt+Enter");
  await page.waitForSelector(`${strip} textarea`, { timeout: 4000 }).catch(() => {});
  if (!(await page.$(strip))) await page.locator(`tr[data-band="${barn.id}"] .ss-pg-addbtn`).click();
  await page.locator(`${strip} textarea`).fill("16x44");
  let n0 = saveCalls(calls).length;
  await page.keyboard.press("Enter");
  await saved(page, calls, n0, 1);
  const added = (await bandRows(page, barn.id)).find((r) => r.label === "16x44") || { id: "missing" };
  ok("R: (set-up) a size added by mistake, with its Remove", added.rm, JSON.stringify(added));
  // Delete on its Size box: the keyboard's Remove, held a moment on the way so its row says Removing….
  F.script.push({ delayMs: 1500 });
  await page.locator(sel(added.id, 0)).click({ timeout: 3000 }).catch(() => {});
  n0 = saveCalls(calls).length;
  await page.keyboard.press("Delete");
  const out = await page.waitForFunction((id) => /Removing/.test((document.querySelector(`tr[data-s="${id}"]`) || {}).textContent || ""), added.id, { timeout: 4000 }).then(() => true, () => false);
  // (Without the keyboard's Remove, the ✕ starts it, so the check below still runs.)
  if (!out) await page.locator(`tr[data-s="${added.id}"] .ss-pg-rm`).click({ timeout: 3000 }).catch(() => {});
  await page.locator(sel(added.id, 1)).click({ timeout: 3000 }).catch(() => {});
  await page.keyboard.type("5");
  const s = await state(page);
  ok("R: a size being removed takes no typing: no editor, and the status line says why", !s.editor && s.status === "This size is being removed.", JSON.stringify(s));
  const gone = await page.waitForFunction((id) => !document.querySelector(`tr[data-s="${id}"]`), added.id, { timeout: 10000 }).then(() => true, () => false);
  const rc = saveCalls(calls).slice(n0);
  ok("R: Delete on a Size box removes a size added by mistake, through the queue; nothing else went for it",
    out && gone && rc.length === 1 && JSON.stringify(rc[0].body.removes) === JSON.stringify([added.id]) && !rc[0].body.sizes.length && !F.size(added.id), JSON.stringify(rc.map((c) => c.body)));
  // Delete on a priced size's Size box removes nothing, and says why.
  await page.locator(sel(z1.id, 0)).click();
  n0 = saveCalls(calls).length;
  await page.keyboard.press("Delete");
  await page.waitForTimeout(1200);
  ok("R: …on a size that was priced or changed, it removes nothing and says why",
    (await state(page)).status === "Only a size that was never priced or edited can be removed. Untick Offered to hide it." && saveCalls(calls).length === n0 && !!F.size(z1.id));
  ok("R: no page errors (the keyboard's Add sizes and Remove)", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// R3: the refresh. Another tab's save (BroadcastChannel) re-reads both tables after a 1 s wait: a new
// option column appears, a new style appears, a box changed elsewhere shows its new number (grey
// flash). This page's own saves, and another account's, do not refresh it. Every return to the tab
// does.
if (want("R")) {
  const cat = catalogFor(OWN);
  const t0 = tableFor(OWN, cat);
  const F = fakeServer(cat, t0);
  const { ctx, page, calls, errors } = await open("/settings/sheds-table", { cat: () => cat, fake: F }, { width: 1440, height: 900 });
  await waitGrid(page).catch(() => {});
  // Another tab on the same origin that reads nothing itself, so every read counted is this table's.
  const { p: other, errs: otherErrs } = await tabOf(ctx, "/manifest.json");
  const z = barnOf(F.table(OWN))[0];
  const ncols0 = await page.evaluate(() => document.querySelectorAll(".ss-pg-names th").length);
  // What the other tab changed: a new window in Options, a new style, a price.
  cat.fixtures.push({ id: 555, name: "Harness New Window", category: "window", width_in: 30, height_in: 40, active: true, archived: false });
  t0.styles.push({ id: uid("5", 55), key: "test-new", label: "Test New Style", code: "TN", active: true, sort_order: 8 });
  F.poke(z.id, { price: 7777 });
  let r0 = reads(calls).length;
  await other.evaluate((cid) => { const bc = new BroadcastChannel("ss-settings"); bc.postMessage({ clientId: cid, at: Date.now(), source: "another-tab" }); bc.close(); }, OWN);
  await page.waitForTimeout(600);
  const early = reads(calls).length - r0;
  const col = await page.waitForFunction(() => [...document.querySelectorAll(".ss-pg-names th")].some((th) => /^Harness New Window/.test(th.getAttribute("aria-label") || "")), null, { timeout: 8000 }).then(() => true, () => false);
  const got = reads(calls).slice(r0);
  ok("R: a save in another tab (the 'ss-settings' channel) re-reads catalog and size_table, after a 1 s wait",
    early === 0 && got.filter((c) => c.action === "catalog").length >= 1 && got.filter((c) => c.action === "size_table").length >= 1 && got.every((c) => c.body.targetClientId === null),
    JSON.stringify({ early, got: got.map((c) => c.action) }));
  const after = await page.evaluate(() => ({ ncols: document.querySelectorAll(".ss-pg-names th").length, band: !!document.querySelector('tr[data-band] b') && [...document.querySelectorAll("tr[data-band] b")].map((b) => b.textContent) }));
  ok("R: …a new option column appears, and so does the new style", col && after.ncols === ncols0 + 1 && after.band.includes("Test New Style"), JSON.stringify(after));
  const cz = await look(page, z.id, 1);
  ok("R: …and a box changed elsewhere shows the new number", cz.text === "$7,777", JSON.stringify(cz));
  await page.screenshot({ path: join(shots, "R-refreshed.png") });
  // This page's own save says so on the same channel, and is told apart by its source: no re-read.
  r0 = reads(calls).length;
  const n0 = saveCalls(calls).length;
  await typeIn(page, z.id, 1, "7800");
  await saved(page, calls, n0, 1);
  await page.waitForTimeout(1600);
  ok("R: its own saves never refresh it", reads(calls).length === r0, String(reads(calls).length - r0));
  // Another account's save: ignored.
  await other.evaluate(() => { const bc = new BroadcastChannel("ss-settings"); bc.postMessage({ clientId: "some-other-builder", at: Date.now(), source: "another-tab" }); bc.close(); });
  await page.waitForTimeout(1600);
  ok("R: a save for another account is ignored", reads(calls).length === r0, String(reads(calls).length - r0));
  // The same-window event (ssSettingsSaved's other half) from another source re-reads both too.
  await page.evaluate((cid) => window.dispatchEvent(new CustomEvent("ss:settings-saved", { detail: { clientId: cid, at: Date.now(), source: "another-page" } })), OWN);
  let evRead = false;
  for (const until = Date.now() + 6000; !evRead && Date.now() < until; await sleep(100)) {
    const g = reads(calls).slice(r0);
    evRead = g.some((c) => c.action === "catalog") && g.some((c) => c.action === "size_table");
  }
  ok("R: the 'ss:settings-saved' event from another source re-reads catalog and size_table too", evRead, JSON.stringify(reads(calls).slice(r0).map((c) => c.action)));
  await page.waitForTimeout(400);
  r0 = reads(calls).length;
  // Every return to the tab, however short the time away.
  F.poke(z.id, { cells: { workbench: 4 } });
  await hideAndShow(page);
  const vis = await page.waitForFunction((sx) => (document.querySelector(sx) || {}).textContent === "4", sel(z.id, keyCol(cat, "workbench")), { timeout: 8000 }).then(() => true, () => false);
  const vr = reads(calls).slice(r0);
  ok("R: coming back to the tab re-reads both tables and shows what changed meanwhile",
    vis && vr.some((c) => c.action === "catalog") && vr.some((c) => c.action === "size_table"), JSON.stringify(vr.map((c) => c.action)));
  ok("R: no page errors (refresh)", errors.length === 0 && otherErrs.length === 0, [...errors, ...otherErrs].join(" | "));
  await ctx.close();
}

// R3b: an open editor across a column change (plan 4.6). A new built-in option sorted first moves every
// option column one to the right while the editor holds 7 in Workbench: the editor, the cursor and
// the readout stay on Workbench, and Enter saves Workbench, never the option now standing where it
// was. An editor whose option is archived meanwhile closes, its text counted in the columns note, and
// nothing is sent.
const tellFrom = (page, cid) => page.evaluate((c) => window.dispatchEvent(new CustomEvent("ss:settings-saved", { detail: { clientId: c, at: Date.now(), source: "another-page" } })), cid);
if (want("R")) {
  const cat = catalogFor(OWN);
  const F = fakeServer(cat, tableFor(OWN, cat));
  const { ctx, page, calls, errors } = await open("/settings/sheds-table", { cat: () => cat, fake: F, win: { __ssPgRefreshMs: 100 } }, { width: 1440, height: 900 });
  await waitGrid(page).catch(() => {});
  const [z, z2] = barnOf(F.table(OWN));
  const WB = keyCol(cat, "workbench");
  const wb0 = F.cells(z.id).workbench || 0;
  await page.locator(sel(z.id, WB)).click();
  await page.keyboard.type("7");
  const before = (await state(page)).editor;
  cat.items.unshift({ key: "atticFan", label: "Attic Fan" });
  let n0 = saveCalls(calls).length;
  await tellFrom(page, OWN);
  const moved = await page.waitForFunction(() => [...document.querySelectorAll(".ss-pg-names th")].some((th) => th.getAttribute("aria-label") === "Attic Fan"), null, { timeout: 8000 }).then(() => true, () => false);
  await page.waitForTimeout(150);
  const geo = await page.evaluate((a) => {
    const td = document.querySelector(a), ed = document.querySelector(".ss-pg-ed");
    if (!td || !ed) return null;
    const t = td.getBoundingClientRect(), e = ed.getBoundingClientRect();
    return { box: [t.left, t.top, t.width, t.height].map(Math.round).join(), ed: [e.left, e.top, e.width, e.height].map(Math.round).join(), value: ed.value, focused: document.activeElement === ed };
  }, sel(z.id, WB + 1));
  let s = await state(page);
  ok("R: a read that puts a new option in front of the open editor leaves it on its own option: its name, over the Workbench box one column on, its text and the focus kept; the readout says Workbench",
    moved && !!s.editor && !!before && s.editor.label === before.label && /, Workbench$/.test(s.editor.label) && !!geo && geo.box === geo.ed && geo.value === "7" && geo.focused
    && s.readout.startsWith("Workbench · ") && saveCalls(calls).length === n0, JSON.stringify({ moved, before, s, geo }));
  await page.keyboard.press("Enter");
  ok("R: …Enter saves it", await saved(page, calls, n0, 1));
  const sent = (saveCalls(calls).slice(n0)[0] || { body: { sizes: [] } }).body.sizes;
  ok("R: …into Workbench, from what was on file; the new option is untouched",
    sent.length === 1 && sent[0].id === z.id && JSON.stringify(sent[0].from) === JSON.stringify({ cells: { workbench: wb0 } }) && JSON.stringify(sent[0].to) === JSON.stringify({ cells: { workbench: 7 } })
    && F.cells(z.id).workbench === 7 && !("atticFan" in F.cells(z.id)), JSON.stringify(sent));
  // Archived while the editor holds text in it: closed, counted in the note, nothing sent.
  await page.locator(sel(z2.id, WB + 1)).click();
  await page.keyboard.type("5");
  cat.items.find((x) => x.key === "workbench").archived = true;
  n0 = saveCalls(calls).length;
  await tellFrom(page, OWN);
  const closed = await page.waitForFunction(() => !document.querySelector(".ss-pg-ed"), null, { timeout: 8000 }).then(() => true, () => false);
  await page.waitForTimeout(1200);
  s = await state(page);
  ok("R: an editor whose option is archived meanwhile closes, says so in the status line, and sends nothing",
    closed && s.status === "Workbench was archived in Options; 1 unsaved box in that column was dropped." && saveCalls(calls).length === n0 && /^All changes saved/.test(s.badge), JSON.stringify(s));
  ok("R: no page errors (an editor across a column change)", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// R3c: a save answered "changed elsewhere" carries back only the boxes that call named; the table
// reads again, so the size's other boxes show what the colleague saved too.
if (want("R")) {
  const cat = catalogFor(OWN);
  const F = fakeServer(cat, tableFor(OWN, cat));
  const { ctx, page, calls, errors } = await open("/settings/sheds-table", { cat: () => cat, fake: F, win: { __ssPgRefreshMs: 100 } }, { width: 1280, height: 860 });
  await waitGrid(page).catch(() => {});
  const z = barnOf(F.table(OWN))[0];
  const LOFT = keyCol(cat, "loft"), WB = keyCol(cat, "workbench");
  F.script.push({ before: (FF) => FF.poke(z.id, { cells: { loft: 30, workbench: 2 } }) });   // a colleague, just before this save lands
  const r0 = reads(calls).length, n0 = saveCalls(calls).length;
  await typeIn(page, z.id, LOFT, "60");
  const amber = await page.waitForFunction((sx) => /ss-pg-m-c/.test((document.querySelector(sx) || {}).className || ""), sel(z.id, LOFT), { timeout: 10000 }).then(() => true, () => false);
  const wb = await page.waitForFunction((sx) => (document.querySelector(sx) || {}).textContent === "2", sel(z.id, WB), { timeout: 8000 }).then(() => true, () => false);
  ok("R: a save that comes back changed elsewhere re-reads the table, so the size's other boxes show what the colleague saved too",
    amber && wb && reads(calls).slice(r0).some((c) => c.action === "size_table") && saveCalls(calls).length === n0 + 1 && F.cells(z.id).loft === 30,
    JSON.stringify({ amber, wb, reads: reads(calls).slice(r0).map((c) => c.action) }));
  ok("R: no page errors (a conflict, then the read)", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// R4: an Excel upload in the Sheds tab while the table is open: the box waiting to save that the
// sheet changed turns amber with the sheet's number and is never sent; what was out still lands.
if (want("R")) {
  const cat = catalogFor(OWN);
  const F = fakeServer(cat, tableFor(OWN, cat));
  const { ctx, page, calls, errors, S } = await open("/settings/sheds-table", { cat: () => cat, fake: F }, { width: 1280, height: 860 });
  await waitGrid(page).catch(() => {});
  const { p: sheds, errs: shedsErrs } = await tabOf(ctx, "/settings/sheds");
  await sheds.waitForSelector("text=Open sizes & prices table", { timeout: 20000 }).catch(() => {});
  const LOFT = keyCol(cat, "loft");
  const barn = barnOf(F.table(OWN));
  const za = barn[0], zb = barn[1];
  const loft0 = F.cells(zb.id).loft || 0;
  F.script.push({ delayMs: 6000 });          // za's save stays out a while
  const n0 = saveCalls(calls).length;
  await typeIn(page, za.id, 1, "5100");
  await waitBadge(page, /^Saving 1 change…$/, 4000);
  await typeIn(page, zb.id, LOFT, "77");      // waits behind the call out
  let s = await state(page);
  ok("R: (set-up) one box out, one waiting behind it", /^Saving 1 change…$/.test(s.badge) && /ss-pg-m-p/.test((await look(page, zb.id, LOFT)).cls), s.badge);
  S.onImport = () => F.poke(zb.id, { cells: { loft: 33 } });   // what the sheet says for that box
  await sheds.locator('input[type="file"][accept*=".xlsx"]').setInputFiles({ name: "sheet.csv", mimeType: "text/csv", buffer: Buffer.from("style,width,length,price,active\nTest Barn,10,12,1500,yes\n") });
  await sheds.waitForSelector('[data-ss-xl-msg="ok"]', { timeout: 10000 }).catch(() => {});
  const amber = await page.waitForFunction((sx) => /ss-pg-m-c/.test((document.querySelector(sx) || {}).className || ""), sel(zb.id, LOFT), { timeout: 8000 }).then(() => true, () => false);
  const cb = await look(page, zb.id, LOFT);
  ok("R: the upload's broadcast refreshes the table: the waiting box the sheet changed turns amber with the sheet's number, not overwritten",
    amber && cb.text === "33" && cb.invalid === "true" && F.cells(zb.id).loft === 33, JSON.stringify(cb));
  await page.locator(sel(zb.id, LOFT)).click();
  s = await state(page);
  ok("R: …the status line has both numbers", s.status === `${named(zb)} · Loft (sq ft): changed elsewhere to 33 while you typed 77. Type it again if yours is right.`, s.status);
  await page.waitForFunction(() => /box needs you/.test((document.querySelector(".ss-pg-badge") || {}).textContent || ""), null, { timeout: 15000 }).catch(() => {});
  const sent = saveCalls(calls).slice(n0);
  ok("R: …what was out lands; the changed box is never sent", F.size(za.id).base_price === 5100 && sent.every((c) => !c.body.sizes.some((x) => x.id === zb.id)) && loft0 !== 33,
    JSON.stringify(sent.map((c) => c.body.sizes.map((x) => x.id))));
  ok("R: no page errors (Excel upload while open)", errors.length === 0 && shedsErrs.length === 0, [...errors, ...shedsErrs].join(" | "));
  await ctx.close();
}

// R5: the backup. A tab closed with a call out, a red box and an editor holding text: reopened, the
// banner offers them back; Save them sends them on their stored version and starting values; the red
// box is listed, never sent; Dismiss lets the backup go.
if (want("R")) {
  const cat = catalogFor(OWN);
  const F = fakeServer(cat, tableFor(OWN, cat));
  const LOFT = keyCol(cat, "loft");
  const barn = barnOf(F.table(OWN));
  const z1 = barn[3], z2 = barn[4], z3 = barn[5];
  const loft2 = F.cells(z2.id).loft || 0;
  const { ctx, page, calls, errors } = await open("/settings/sheds-table", { cat: () => cat, fake: F }, { width: 1280, height: 860 });
  await waitGrid(page).catch(() => {});
  F.script.push({ hang: true });             // the first save is never answered
  let n0 = saveCalls(calls).length;
  await typeIn(page, z1.id, 1, "5555");
  const until = Date.now() + 5000;
  while (saveCalls(calls).length === n0 && Date.now() < until) await sleep(60);
  await typeIn(page, z3.id, 1, "abc");        // refused here: red
  await page.locator(sel(z2.id, LOFT)).click();
  await page.keyboard.type("42");             // the editor holds 42 and is never left
  const b = JSON.parse((await stored(page, OWN)) || "null");
  ok("R: the backup holds the edit out (on its version, from what was on file), the red box and the editor's text",
    !!b && JSON.stringify(b.sizes) === JSON.stringify({ [z1.id]: { base: z1.updated_at, fields: { price: { to: 5555, from: z1.base_price } } } })
    && b.red.length === 1 && b.red[0].sizeId === z3.id && b.red[0].kind === "invalid" && b.red[0].typed === "abc"
    && JSON.stringify(b.draft) === JSON.stringify({ sizeId: z2.id, key: "c:loft", text: "42", base: z2.updated_at, from: loft2 }), JSON.stringify(b));
  await page.close({ runBeforeUnload: false });   // the tab closes (or the browser dies) with all of that unsaved
  n0 = saveCalls(calls).length;
  const { p, errs } = await tabOf(ctx, "/settings/sheds-table");
  await waitGrid(p).catch(() => {});
  await p.waitForSelector(".ss-pg-earlier", { timeout: 8000 }).catch(() => {});
  const banner = await p.evaluate(() => { const e = document.querySelector(".ss-pg-earlier"); return e ? { text: e.querySelector("span").textContent, btns: [...e.querySelectorAll("button")].map((x) => x.textContent) } : null; });
  ok("R: reopened: 'You have 2 changes from earlier that weren't saved.' [Save them] [Discard], the editor's text counted", !!banner && banner.text === "You have 2 changes from earlier that weren't saved." && banner.btns.join() === "Save them,Discard", JSON.stringify(banner));
  let s = await state(p);
  ok("R: …the red box from earlier is listed in the status line", s.status === `This didn't save before you left: ${named(z3)} · Price (“abc”). Type it again if it's right.`, s.status);
  await p.waitForTimeout(1200);
  ok("R: …and nothing is sent until the builder says so", saveCalls(calls).length === n0, String(saveCalls(calls).length - n0));
  await p.screenshot({ path: join(shots, "R-banner.png") });
  await p.locator(".ss-pg-earlier button", { hasText: "Save them" }).click();
  ok("R: Save them sends them", await saved(p, calls, n0, 1));
  const sent = (saveCalls(calls).slice(n0)[0] || { body: { sizes: [] } }).body.sizes;
  ok("R: …on their STORED version and from the values they were made against (the editor's text as an ordinary edit)", JSON.stringify(sent) === JSON.stringify([
    { id: z1.id, base: z1.updated_at, from: { price: z1.base_price }, to: { price: 5555 } },
    { id: z2.id, base: z2.updated_at, from: { cells: { loft: loft2 } }, to: { cells: { loft: 42 } } }]), JSON.stringify(sent));
  const left = JSON.parse((await stored(p, OWN)) || "null");
  ok("R: …they landed; the banner is gone; the red entry is never sent, and is all the backup still holds",
    F.size(z1.id).base_price === 5555 && F.cells(z2.id).loft === 42 && !(await p.$(".ss-pg-earlier")) && !saveCalls(calls).some((c) => c.body.sizes.some((x) => x.id === z3.id))
    && !!left && Object.keys(left.sizes).length === 0 && left.red.length === 1 && !left.draft, JSON.stringify(left));
  await p.locator(".ss-pg-status button", { hasText: "Dismiss" }).click({ timeout: 3000 }).catch(() => {});
  await p.waitForTimeout(200);
  ok("R: Dismiss lets the backup go", (await stored(p, OWN)) === null);
  ok("R: no page errors (backup, Save them)", errors.length === 0 && errs.length === 0, [...errors, ...errs].join(" | "));
  await ctx.close();
}

// R5b: two tabs of one account (plan 8.5 step 10). Each table keeps its backup under its own key: a
// second tab opened beside the first offers nothing of the first one's (it is open, and answers for
// it), and its own save, which empties its own queue, leaves the first one's draft where it is. Once
// the first tab is gone, the next one opened offers that draft back.
if (want("R")) {
  const cat = catalogFor(OWN);
  const F = fakeServer(cat, tableFor(OWN, cat));
  const { ctx, page, calls, errors } = await open("/settings/sheds-table", { cat: () => cat, fake: F }, { width: 1280, height: 860 });
  await waitGrid(page).catch(() => {});
  const barn = barnOf(F.table(OWN));
  const za = barn[3], zb = barn[4];
  await page.locator(sel(za.id, 1)).click();
  await page.keyboard.type("4800");                // tab A: the editor holds 4800 and is never left
  await page.waitForTimeout(200);
  const a0 = await storedAll(page, OWN);
  const aKey = Object.keys(a0).find((k) => (JSON.parse(a0[k]).draft || {}).text === "4800");
  const { p: b, errs: bErrs } = await tabOf(ctx, "/settings/sheds-table");
  await waitGrid(b).catch(() => {});
  await b.waitForTimeout(1200);                     // past the "who's open?" wait
  const bannerB = !!(await b.$(".ss-pg-earlier"));
  const n0 = saveCalls(calls).length;
  await typeIn(b, zb.id, 1, "2500");
  const bSaved = await saved(b, calls, n0, 1);
  await b.waitForTimeout(400);
  const after = await storedAll(b, OWN);
  const draftNow = aKey && after[aKey] ? JSON.parse(after[aKey]).draft : null;
  ok("R: a second tab of the same account offers nothing of the first one's while it is open, and its own save leaves the first one's draft where it is",
    !!aKey && !bannerB && bSaved && F.size(zb.id).base_price === 2500 && !!draftNow && draftNow.text === "4800" && draftNow.sizeId === za.id && Object.keys(after).length === 1,
    JSON.stringify({ aKey, keys: Object.keys(after), bannerB, draftNow }));
  ok("R: …and the first tab's editor still holds it", (await state(page)).editor && (await state(page)).editor.value === "4800");
  await page.close({ runBeforeUnload: false });     // the first tab goes (closed, or the browser dies)
  const { p: c, errs: cErrs } = await tabOf(ctx, "/settings/sheds-table");
  await waitGrid(c).catch(() => {});
  await c.waitForSelector(".ss-pg-earlier", { timeout: 8000 }).catch(() => {});
  const bannerC = await c.locator(".ss-pg-earlier span").textContent({ timeout: 1000 }).catch(() => null);
  const n1 = saveCalls(calls).length;
  await c.locator(".ss-pg-earlier button", { hasText: "Save them" }).click({ timeout: 3000 }).catch(() => {});
  const cSaved = await saved(c, calls, n1, 1);
  ok("R: …once the first tab is gone, the next one opened offers its draft back, and Save them sends it",
    bannerC === "You have 1 change from earlier that wasn't saved." && cSaved && F.size(za.id).base_price === 4800 && Object.keys(await storedAll(c, OWN)).length === 0, String(bannerC));
  ok("R: no page errors (two tabs)", errors.length === 0 && bErrs.length === 0 && cErrs.length === 0, [...errors, ...bErrs, ...cErrs].join(" | "));
  await ctx.close();
}

// R5c: a price typed on a size still being added ("Adding…", its create never answered), then the tab
// closed: the backup keeps the size with it; Save them adds it again, then the price goes.
if (want("R")) {
  const cat = catalogFor(OWN);
  const F = fakeServer(cat, tableFor(OWN, cat));
  const barn = F.table(OWN).styles[0];
  const { ctx, page, calls, errors } = await open("/settings/sheds-table", { cat: () => cat, fake: F }, { width: 1280, height: 860 });
  await waitGrid(page).catch(() => {});
  F.script.push({ hang: true });                    // the create is never answered
  await page.locator(`tr[data-band="${barn.id}"] .ss-pg-addbtn`).click();
  await page.locator(`tr[data-add="${barn.id}"] textarea`).fill("16x48");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => /Price · Test Barn 16x48/.test((document.querySelector(".ss-pg-readout") || {}).textContent || ""), null, { timeout: 4000 }).catch(() => {});
  await page.keyboard.type("3300");
  await page.keyboard.press("Enter");                // waits for the create's answer
  await page.waitForTimeout(300);
  const b = JSON.parse((await stored(page, OWN)) || "null");
  const id = b && b.creates ? Object.keys(b.creates)[0] : null;
  ok("R: the backup keeps a size still being added, with the price typed on it",
    !!id && b.creates[id].styleId === barn.id && b.creates[id].width === 16 && b.creates[id].length === 48 && JSON.stringify(b.creates[id].fields) === JSON.stringify({ price: { to: 3300, from: null } }) && !F.size(id),
    JSON.stringify(b));
  await page.close({ runBeforeUnload: false });
  const { p, errs } = await tabOf(ctx, "/settings/sheds-table");
  await waitGrid(p).catch(() => {});
  await p.waitForSelector(".ss-pg-earlier", { timeout: 8000 }).catch(() => {});
  const banner = await p.locator(".ss-pg-earlier span").textContent({ timeout: 1000 }).catch(() => null);
  const n0 = saveCalls(calls).length;
  await p.locator(".ss-pg-earlier button", { hasText: "Save them" }).click({ timeout: 3000 }).catch(() => {});
  const went = await saved(p, calls, n0, 2, 20000);
  const sc = saveCalls(calls).slice(n0).map((c) => c.body);
  const row = id ? (await bandRows(p, barn.id)).find((r) => r.id === id) : null;
  ok("R: …reopened, the banner offers it; Save them adds the size again, then its price goes on the create's version",
    banner === "You have 1 change from earlier that wasn't saved." && went && sc.length === 2 && sc[0].creates.length === 1 && sc[0].creates[0].id === id && !sc[0].sizes.length
    && sc[1].sizes.length === 1 && sc[1].sizes[0].id === id && sc[1].sizes[0].base === (F.size(id) || {}).created_at && F.size(id).base_price === 3300 && !!row && row.price === "$3,300",
    JSON.stringify({ banner, sc, row }));
  ok("R: no page errors (a size being added, through a closed tab)", errors.length === 0 && errs.length === 0, [...errors, ...errs].join(" | "));
  await ctx.close();
}

// R6: Save them after a colleague changed the same box: conflict, amber with their number, never
// overwritten. Discard sends nothing and clears it. Older than 7 days: dropped. View-as: a backup is
// offered only to the account it was made on, and a view-only page never offers or sends one.
const backupOf = (savedAt, z, to, extra = {}) => JSON.stringify({ savedAt, sizes: { [z.id]: { base: z.updated_at, fields: { price: { to, from: z.base_price } } } }, red: [], draft: null, ...extra });
if (want("R")) {
  const cat = catalogFor(OWN);
  const F = fakeServer(cat, tableFor(OWN, cat));
  const z = barnOf(F.table(OWN))[3];
  F.poke(z.id, { price: 9999 });             // a colleague, after the backup was made
  const { ctx, page, calls, errors } = await open("/settings/sheds-table", { cat: () => cat, fake: F, storage: { [BACKUP_KEY(OWN)]: backupOf(Date.now() - 3600e3, z, 5555) } });
  await waitGrid(page).catch(() => {});
  await page.waitForSelector(".ss-pg-earlier", { timeout: 8000 }).catch(() => {});
  const text = await page.locator(".ss-pg-earlier span").textContent().catch(() => "");
  const n0 = saveCalls(calls).length;
  await page.locator(".ss-pg-earlier button", { hasText: "Save them" }).click().catch(() => {});
  const red = await waitBadge(page, /^1 box needs you$/, 10000);
  await page.locator(sel(z.id, 1)).click();
  const s = await state(page);
  const c = await look(page, z.id, 1);
  ok("R: Save them after a colleague changed that box: it goes on the stored version, comes back changed elsewhere, amber with their number",
    text === "You have 1 change from earlier that wasn't saved." && red && c.text === "$9,999" && /ss-pg-m-c/.test(c.cls) && F.size(z.id).base_price === 9999
    && s.status === `${named(z)} · Price: changed elsewhere to $9,999 while you typed $5,555. Type it again if yours is right.`
    && saveCalls(calls).slice(n0).length === 1 && saveCalls(calls)[n0].body.sizes[0].base === z.updated_at, JSON.stringify({ text, s, c }));
  ok("R: no page errors (Save them, conflict)", errors.length === 0, errors.join(" | "));
  await ctx.close();
}
if (want("R")) {
  const cat = catalogFor(OWN);
  const F = fakeServer(cat, tableFor(OWN, cat));
  const z = barnOf(F.table(OWN))[3];
  const { ctx, page, calls, errors } = await open("/settings/sheds-table", { cat: () => cat, fake: F, storage: { [BACKUP_KEY(OWN)]: backupOf(Date.now() - 60e3, z, 5555) } });
  await waitGrid(page).catch(() => {});
  await page.waitForSelector(".ss-pg-earlier", { timeout: 8000 }).catch(() => {});
  await page.locator(".ss-pg-earlier button", { hasText: "Discard" }).click().catch(() => {});
  await page.waitForTimeout(1500);
  ok("R: Discard sends nothing, the banner goes, and so does the backup",
    saveCalls(calls).length === 0 && !(await page.$(".ss-pg-earlier")) && (await stored(page, OWN)) === null && F.size(z.id).base_price === z.base_price);
  ok("R: no page errors (Discard)", errors.length === 0, errors.join(" | "));
  await ctx.close();
}
if (want("R")) {
  const cat = catalogFor(OWN);
  const F = fakeServer(cat, tableFor(OWN, cat));
  const z = barnOf(F.table(OWN))[3];
  const { ctx, page, calls, errors } = await open("/settings/sheds-table", { cat: () => cat, fake: F, storage: { [BACKUP_KEY(OWN)]: backupOf(Date.now() - 8 * 24 * 3600e3, z, 5555) } });
  await waitGrid(page).catch(() => {});
  await page.waitForTimeout(1200);
  ok("R: a backup older than 7 days is dropped: no banner, nothing sent, nothing kept",
    !(await page.$(".ss-pg-earlier")) && saveCalls(calls).length === 0 && (await stored(page, OWN)) === null);
  ok("R: no page errors (7 days)", errors.length === 0, errors.join(" | "));
  await ctx.close();
}
for (const as of want("R") ? [false, true] : []) {
  // An operator viewing a builder: the backup made on the operator's own account is never offered
  // here; the one made on the viewed builder is (unless the page is view-only: ?as=).
  const cat = catalogFor(VIEWED);
  const F = fakeServer(cat, tableFor(VIEWED, cat));
  const barn = barnOf(F.table(VIEWED));
  const own = backupOf(Date.now() - 60e3, barn[3], 1111, { sizes: { [barn[3].id]: { base: barn[3].updated_at, fields: { price: { to: 1111, from: barn[3].base_price } } }, [barn[4].id]: { base: barn[4].updated_at, fields: { price: { to: 2222, from: barn[4].base_price } } } } });
  const viewed = backupOf(Date.now() - 60e3, barn[5], 3333);
  const path = `/settings/sheds-table?view=${VIEWED}${as ? `&as=${WEAR}` : ""}`;
  const { ctx, page, calls, errors } = await open(path, { own: OPS, operator: true, cat: () => cat, fake: F, storage: { [BACKUP_KEY(OPS)]: own, [BACKUP_KEY(VIEWED)]: viewed } });
  await waitGrid(page).catch(() => {});
  await page.waitForTimeout(1500);
  const banner = await page.locator(".ss-pg-earlier span").textContent({ timeout: 1000 }).catch(() => null);
  const keys = { own: await stored(page, OPS), viewed: await stored(page, VIEWED) };
  if (!as) {
    ok("R: view-as: only the viewed builder's backup is offered (1 change), never the operator's own account's (2)",
      banner === "You have 1 change from earlier that wasn't saved." && keys.own === own && saveCalls(calls).length === 0, JSON.stringify({ banner, own: !!keys.own }));
    await page.locator(".ss-pg-earlier button", { hasText: "Save them" }).click().catch(() => {});
    await page.waitForFunction(() => /^All changes saved/.test((document.querySelector(".ss-pg-badge") || {}).textContent || ""), null, { timeout: 10000 }).catch(() => {});
    const sc = saveCalls(calls);
    ok("R: …and Save them sends it to the viewed builder (targetClientId), leaving the operator's own backup alone",
      sc.length === 1 && sc[0].body.targetClientId === VIEWED && sc[0].body.sizes[0].id === barn[5].id && (await stored(page, OPS)) === own, JSON.stringify(sc.map((c) => c.body)));
  } else {
    ok("R: ?as= (view-only): no banner, nothing sent, and both backups left as they were",
      banner === null && saveCalls(calls).length === 0 && keys.own === own && keys.viewed === viewed, JSON.stringify({ banner, keys: Object.keys(keys).filter((k) => keys[k]) }));
  }
  ok(`R: no page errors (view-as backup${as ? ", ?as=" : ""})`, errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// R6b: a first read that trips the "too big" guard opens view-only and cannot offer the backup; the
// Reload that clears the guard offers it, before the first edit could write over it.
if (want("R")) {
  const cat = catalogFor(OWN);
  const F = fakeServer(cat, tableFor(OWN, cat));
  const z = barnOf(F.table(OWN))[3];
  const { ctx, page, calls, errors, S } = await open("/settings/sheds-table", { cat: () => cat, fake: F, countSkew: true, storage: { [BACKUP_KEY(OWN)]: backupOf(Date.now() - 60e3, z, 5555) } });
  await waitGrid(page).catch(() => {});
  const big = await page.waitForFunction((t) => (document.body.textContent || "").includes(t), "This catalog is too big for the table right now.", { timeout: 8000 }).then(() => true, () => false);
  await page.waitForTimeout(800);
  const early = !!(await page.$(".ss-pg-earlier"));
  S.countSkew = false;
  await page.locator(".ss-pg-status button", { hasText: "Reload" }).click({ timeout: 3000 }).catch(() => {});
  await page.waitForSelector(".ss-pg-earlier", { timeout: 8000 }).catch(() => {});
  const text = await page.locator(".ss-pg-earlier span").textContent({ timeout: 1000 }).catch(() => null);
  await page.waitForTimeout(300);
  const kept = await stored(page, OWN);
  ok("R: no backup is offered while the catalog reads 'too big'; the Reload that clears it offers it, and it stays stored until answered",
    big && !early && text === "You have 1 change from earlier that wasn't saved." && !!kept && JSON.parse(kept).sizes[z.id].fields.price.to === 5555 && saveCalls(calls).length === 0,
    JSON.stringify({ big, early, text, kept }));
  ok("R: no page errors (too big, then Reload)", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// ── V: copy, paste, fill down, clear and the confirm (Phase 4b) ──
// Against fakeServer. Copy and paste are the browser's own clipboard events (clip, above section A):
// dispatched with a DataTransfer, which is what a Ctrl/Cmd+C or V on the grid hands the page (one real
// Ctrl+C and Ctrl+V through the system clipboard too, when this browser lets the harness read it).
const gridFocused = (page) => page.evaluate(() => document.activeElement === document.querySelector(".ss-pg-grid"));
const rangeShown = (page) => page.evaluate(() => [...document.querySelectorAll(".ss-pg-range")].filter((x) => x.style.display === "block").length);
// A box's text as copying it gives it, from the fake's rows.
const copied = (F, cat, z, col) => {
  const s = F.size(z.id);
  if (col === 0) return s.label;
  if (col === 1) return s.base_price == null ? "" : String(s.base_price);
  if (col === 2) return s.active && s.base_price != null ? "yes" : "no";
  return String(F.cells(z.id)[OPTION_KEYS(cat)[col - 3]] || "");
};

// V1: copy a range (as TSV, as drawn), paste a block (the confirm names the first and last size; Escape
// and Cancel send nothing; Continue sends one call with only those boxes), a bad cell sends nothing, a
// block crossing a band and one skipping a folded hidden size are refused.
if (want("V")) {
  const cat = catalogFor(OWN);
  const F = fakeServer(cat, tableFor(OWN, cat));
  const t = F.table(OWN);
  const barn = barnOf(t);
  const LOFT = keyCol(cat, "loft"), WB = keyCol(cat, "workbench");
  const { ctx, page, calls, errors } = await open("/settings/sheds-table", { cat: () => cat, fake: F }, { width: 1280, height: 860 });
  await waitGrid(page).catch(() => {});

  // Copy: Price, Offered and Loft of the first three sizes.
  await page.locator(sel(barn[0].id, 1)).click();
  for (const k of ["Shift+ArrowRight", "Shift+ArrowRight", "Shift+ArrowDown", "Shift+ArrowDown"]) await page.keyboard.press(k);
  const want3 = tsvOf([0, 1, 2].map((i) => [1, 2, LOFT].map((c) => copied(F, cat, barn[i], c))));
  const cp = await clip.copy(page);
  ok("V: Ctrl/Cmd+C copies the selection as TSV, as drawn: plain numbers, yes/no, blank for nothing included",
    cp.prevented && cp.text === want3 && /^\d/.test(cp.text), JSON.stringify(cp));
  ok("V: …and says so", (await statusText(page)) === "Copied 9 boxes.", await statusText(page));
  // The real keys, through the system clipboard.
  let real = null;
  try {
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
    await page.evaluate(() => navigator.clipboard.writeText("before"));
    await page.keyboard.press("Control+C");
    real = await page.evaluate(() => navigator.clipboard.readText());
  } catch (e) { real = `unavailable: ${e.message}`; }
  ok("V: a real Ctrl+C on the grid puts the same TSV on the system clipboard", real === want3, JSON.stringify(real));
  // …and a real Ctrl+V reads it back from there: one box of one size, so it goes at once.
  {
    const z = barn[3], LK = OPTION_KEYS(cat)[LOFT - 3];
    await page.locator(sel(z.id, LOFT)).click();
    const n = saveCalls(calls).length;
    let pasted = false;
    try {
      await page.evaluate(() => navigator.clipboard.writeText("33\r\n"));
      await page.keyboard.press("Control+V");
      pasted = await saved(page, calls, n);
    } catch (_e) { pasted = false; }
    ok("V: a real Ctrl+V on the grid pastes from the system clipboard", pasted && F.cells(z.id)[LK] === 33 && !(await confirmOf(page)), String(F.cells(z.id)[LK]));
  }

  // Paste a 2 x 2 block at Loft of the first size: two sizes, so the confirm asks first.
  await page.locator(sel(barn[0].id, LOFT)).click();
  const block = [["10", "11"], ["12", "13"]];
  const was = [0, 1].flatMap((i) => [LOFT, WB].map((c) => copied(F, cat, barn[i], c)));
  const changes = [0, 1].flatMap((i) => [LOFT, WB].map((c, j) => copied(F, cat, barn[i], c) !== block[i][j])).filter(Boolean).length;
  let n0 = saveCalls(calls).length;
  await clip.paste(page, tsvOf(block));
  let cf = await confirmOf(page);
  ok("V: a paste onto more than one size asks first, naming the first and last size and counting what changes",
    !!cf && cf.text === `Change 2 sizes, ${named(barn[0])} to ${named(barn[1])}: ${changes} included options. Continue?`, JSON.stringify(cf));
  ok("V: …an accessible modal (alertdialog, aria-modal, named by its question), the focus on Continue", !!cf && cf.modal === "true" && cf.named && cf.focus === "Continue", JSON.stringify(cf));
  await page.keyboard.press("Tab");
  const f1 = (await confirmOf(page)).focus;
  await page.keyboard.press("Tab");
  const f2 = (await confirmOf(page)).focus;
  ok("V: …Tab goes round its two buttons and stays inside", f1 === "Cancel" && f2 === "Continue", `${f1} / ${f2}`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1200);
  const kept = () => Promise.all([0, 1].flatMap((i) => [LOFT, WB].map((c) => look(page, barn[i].id, c).then((x) => x.text))));
  ok("V: Escape is Cancel: the confirm goes, the focus is back on the grid, nothing changed and nothing was sent",
    !(await confirmOf(page)) && (await gridFocused(page)) && JSON.stringify(await kept()) === JSON.stringify(was) && saveCalls(calls).length === n0, JSON.stringify(await kept()));
  await clip.paste(page, tsvOf(block));
  await page.locator(".ss-pg-confirm button", { hasText: "Cancel" }).click();
  await page.waitForTimeout(1200);
  ok("V: …and so is the Cancel button", !(await confirmOf(page)) && saveCalls(calls).length === n0 && JSON.stringify(await kept()) === JSON.stringify(was));
  await clip.paste(page, tsvOf(block));
  await page.keyboard.press("Enter");   // Continue has the focus
  ok("V: Continue: saved", await saved(page, calls, n0));
  let sc = saveCalls(calls).slice(n0);
  const cellsOf = (b) => b.sizes.map((s) => ({ id: s.id, from: s.from, to: s.to }));
  const k1 = OPTION_KEYS(cat)[LOFT - 3], k2 = OPTION_KEYS(cat)[WB - 3];
  const wantSizes = [0, 1].map((i) => {
    const from = { cells: {} }, to = { cells: {} };
    [k1, k2].forEach((k, j) => { const v = Number(was[i * 2 + j] || 0), b = Number(block[i][j]); if (v !== b) { from.cells[k] = v; to.cells[k] = b; } });
    return { id: barn[i].id, from, to };
  });
  ok("V: …in ONE call: both sizes, only the pasted boxes, from what was on file", sc.length === 1 && JSON.stringify(cellsOf(sc[0].body)) === JSON.stringify(wantSizes), JSON.stringify(sc.map((c) => c.body.sizes)));
  ok("V: …the server holds the block, the grid shows it, and the pasted block is selected",
    F.cells(barn[0].id)[k1] === 10 && F.cells(barn[1].id)[k2] === 13 && JSON.stringify(await kept()) === JSON.stringify(["10", "11", "12", "13"]) && (await rangeShown(page)) === 1);

  // A bad cell: nothing at all is pasted, and the status line names it.
  await page.locator(sel(barn[0].id, LOFT)).click();
  n0 = saveCalls(calls).length;
  await clip.paste(page, "1\tabc\r\n");
  await page.waitForTimeout(1200);
  ok("V: a block with one bad cell pastes nothing and sends nothing, naming it",
    (await statusText(page)) === `Row 1 (${named(barn[0])}), Workbench: 'abc' isn't a whole number.` && !(await confirmOf(page)) && saveCalls(calls).length === n0
    && (await look(page, barn[0].id, LOFT)).text === "10", await statusText(page));
  // Crossing into the next style's band.
  const last = barn[barn.length - 1];
  await page.locator(sel(last.id, 1)).click();
  await clip.paste(page, "100\r\n200\r\n");
  await page.waitForTimeout(900);
  ok("V: a block that would cross a style's band is refused: \"Paste one style at a time.\"",
    (await statusText(page)) === "Paste one style at a time." && saveCalls(calls).length === n0 && (await look(page, last.id, 1)).text === ssPgFmtPriceFor(last), await statusText(page));
  // Skipping a hidden size folded away.
  const hi = barn.findIndex((z, i) => i > 0 && i < barn.length - 1 && (z.base_price == null || !z.active));
  await page.locator(".ss-pg-tog input").uncheck();
  await page.waitForTimeout(300);
  await page.locator(sel(barn[hi - 1].id, 1)).click();
  await clip.paste(page, "100\r\n200\r\n");
  await page.waitForTimeout(900);
  ok("V: a block that would skip a folded hidden size is refused, counting it", hi > 0 && (await statusText(page)) === "Show hidden sizes first. This block would skip 1 hidden size." && saveCalls(calls).length === n0, `${hi}: ${await statusText(page)}`);
  await page.locator(".ss-pg-tog input").check();
  // A move clears what the paste said (the grid takes the keys again first: the tick box had them).
  await page.locator(".ss-pg-grid").focus();
  ok("V: …while it says why until then", /^Show hidden sizes first/.test(await statusText(page)), await statusText(page));
  await page.keyboard.press("ArrowDown");
  ok("V: the next move clears the status line", (await statusText(page)) === "", await statusText(page));
  ok("V: no page errors (copy and paste)", errors.length === 0, errors.join(" | "));
  await ctx.close();
}
function ssPgFmtPriceFor(z) {
  if (z.base_price == null) return "";
  const n = Number(z.base_price);
  const [i, d = ""] = String(n).split(".");
  return "$" + i.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (d ? "." + (d.length === 1 ? d + "0" : d) : "");
}

// V1b: the round trip through a sheet. An unpriced size's Offered copies as "no"; pasted back with a
// first price, it stays out of the designer (plan 4.11: Excel's own rule, and plan 3.11: each box
// takes what was pasted), where "yes" lets the server tick it with the price.
if (want("V")) {
  const cat = catalogFor(OWN);
  const F = fakeServer(cat, tableFor(OWN, cat));
  const t = F.table(OWN);
  const barn = barnOf(t), lofted = t.sizes.filter((z) => z.style_id === t.styles[1].id).sort((a, b) => a.sort_order - b.sort_order);
  const za = barn[9], zb = barn[10], zc = lofted.find((z) => z.base_price == null);
  const { ctx, page, calls, errors } = await open("/settings/sheds-table", { cat: () => cat, fake: F }, { width: 1280, height: 860 });
  await waitGrid(page).catch(() => {});
  ok("V: (set-up) a priced size above an unpriced one, and another unpriced one", za.base_price != null && zb.base_price == null && !!zc, JSON.stringify([za.base_price, zb.base_price, !!zc]));
  await page.locator(sel(za.id, 1)).click();
  let n0 = saveCalls(calls).length;
  await clip.paste(page, tsvOf([["1000", "yes"], ["900", "no"]]));
  const cf = await confirmOf(page);
  ok("V: a block giving an unpriced size its first price with Offered 'no' does not count it as joining the designer",
    !!cf && cf.text === `Change 2 sizes, ${named(za)} to ${named(zb)}: 2 prices. Continue?`, JSON.stringify(cf));
  await page.keyboard.press("Enter");
  await saved(page, calls, n0);
  const sent = (saveCalls(calls).slice(n0)[0] || { body: { sizes: [] } }).body.sizes.find((x) => x.id === zb.id);
  ok("V: …its price goes with Offered unticked beside it, and the size stays out of the designer",
    !!sent && JSON.stringify(sent.from) === JSON.stringify({ price: null, active: false }) && JSON.stringify(sent.to) === JSON.stringify({ price: 900, active: false })
    && F.size(zb.id).base_price === 900 && F.size(zb.id).active === false && (await look(page, zb.id, 2)).text === "" && F.bad.length === 0, JSON.stringify({ sent, z: F.size(zb.id) }));
  await page.locator(sel(zc.id, 1)).click();
  n0 = saveCalls(calls).length;
  await clip.paste(page, tsvOf([["800", "yes"]]));
  await saved(page, calls, n0);
  const yes = (saveCalls(calls).slice(n0)[0] || { body: { sizes: [] } }).body.sizes[0];
  ok("V: …with 'yes', the price goes alone and the server ticks Offered",
    !!yes && JSON.stringify(yes.to) === JSON.stringify({ price: 800 }) && F.size(zc.id).active === true && (await look(page, zc.id, 2)).text === "✓", JSON.stringify(yes));
  ok("V: no page errors (a first price with Offered)", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// V2: Clear (Delete on a range, then the toolbar's Clear) and Fill down (Ctrl+D, the toolbar's Fill
// down, a single box from the size above, and the first size, which has none).
if (want("V")) {
  const cat = catalogFor(OWN);
  const F = fakeServer(cat, tableFor(OWN, cat));
  const barn = barnOf(F.table(OWN));
  const LOFT = keyCol(cat, "loft"), k1 = OPTION_KEYS(cat)[LOFT - 3];
  const { ctx, page, calls, errors } = await open("/settings/sheds-table", { cat: () => cat, fake: F }, { width: 1280, height: 860 });
  await waitGrid(page).catch(() => {});
  const three = [2, 3, 4].map((i) => barn[i]);
  const shownBefore = three.filter((z) => z.active && z.base_price != null).length;
  await page.locator(sel(three[0].id, 1)).click();
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  let n0 = saveCalls(calls).length;
  await page.keyboard.press("Delete");
  let cf = await confirmOf(page);
  const clearText = `Change 3 sizes, ${named(three[0])} to ${named(three[2])}: 3 prices${shownBefore ? `, ${shownBefore === 1 ? "1 size" : `${shownBefore} sizes`} hidden from your designer` : ""}. Continue?`;
  ok("V: Delete on a range asks first (three sizes), naming them and counting the prices and the sizes leaving the designer", !!cf && cf.text === clearText, JSON.stringify(cf));
  await page.locator(".ss-pg-confirm button", { hasText: "Cancel" }).click();
  await page.waitForTimeout(1200);
  ok("V: …Cancel: nothing cleared, nothing sent", saveCalls(calls).length === n0 && (await look(page, three[1].id, 1)).text === ssPgFmtPriceFor(three[1]));
  const tb = await page.evaluate(() => [...document.querySelectorAll(".ss-pg-tbtn")].map((b) => ({ text: b.textContent, title: b.title, disabled: b.disabled })));
  ok("V: the toolbar has Fill down and Clear, enabled, each naming its key", JSON.stringify(tb.map((b) => b.text)) === '["Fill down","Clear"]' && tb.every((b) => !b.disabled && /\((Ctrl\+D|Delete)\)$/.test(b.title)), JSON.stringify(tb));
  await page.locator(".ss-pg-tbtn", { hasText: "Clear" }).click();
  cf = await confirmOf(page);
  ok("V: the toolbar's Clear asks the same question about the same range", !!cf && cf.text === clearText, JSON.stringify(cf));
  await page.locator(".ss-pg-confirm button", { hasText: "Continue" }).click();
  ok("V: …Continue: saved", await saved(page, calls, n0));
  let sc = saveCalls(calls).slice(n0);
  ok("V: …one call, each size's price going to blank from what was on file",
    sc.length === 1 && JSON.stringify(sc[0].body.sizes.map((s) => [s.id, s.from, s.to])) === JSON.stringify(three.map((z) => [z.id, { price: z.base_price }, { price: null }])), JSON.stringify(sc.map((c) => c.body.sizes)));
  ok("V: …the boxes are empty and the server holds no price", (await Promise.all(three.map((z) => look(page, z.id, 1)))).every((c) => c.text === "") && three.every((z) => F.size(z.id).base_price === null));

  // Fill down: Loft 77 on barn[5] (one size: no confirm), then Ctrl+D over barn[5..7].
  await page.locator(sel(barn[5].id, LOFT)).click();
  n0 = saveCalls(calls).length;
  await clip.paste(page, "77\r\n");
  ok("V: a paste onto one size never asks (as typing never does): saved", !(await confirmOf(page)) && await saved(page, calls, n0));
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  // The D keydown as the window sees it, after the page's own handler (React's, on the root); the
  // Control keydown before it is not the one.
  await page.evaluate(() => {
    window.__ssKeyHeld = null;
    const on = (e) => { if (e.key !== "d" && e.key !== "D") return; window.removeEventListener("keydown", on); window.__ssKeyHeld = e.defaultPrevented; };
    window.addEventListener("keydown", on);
  });
  n0 = saveCalls(calls).length;
  await page.keyboard.press("Control+D");
  ok("V: Ctrl+D is the table's, held back from the browser (its own is a bookmark)", (await page.evaluate(() => window.__ssKeyHeld)) === true);
  cf = await confirmOf(page);
  const fills = [6, 7].filter((i) => Number(F.cells(barn[i].id)[k1] || 0) !== 77).length;
  ok("V: Ctrl+D fills the top row down the range, asking first", !!cf && cf.text === `Change 2 sizes, ${named(barn[6])} to ${named(barn[7])}: ${fills} included options. Continue?`, JSON.stringify(cf));
  await page.locator(".ss-pg-confirm button", { hasText: "Continue" }).click();
  ok("V: …saved", await saved(page, calls, n0));
  ok("V: …both sizes below now include 77, on the server and on screen", [6, 7].every((i) => F.cells(barn[i].id)[k1] === 77)
    && (await Promise.all([6, 7].map((i) => look(page, barn[i].id, LOFT)))).every((c) => c.text === "77"));
  // One box: the toolbar's Fill down copies the size above, at once.
  await page.locator(sel(barn[8].id, LOFT)).click();
  n0 = saveCalls(calls).length;
  await page.locator(".ss-pg-tbtn", { hasText: "Fill down" }).click();
  ok("V: Fill down on one box copies the size above it, without asking", !(await confirmOf(page)) && await saved(page, calls, n0) && F.cells(barn[8].id)[k1] === 77);
  ok("V: …and the focus is back on the grid, so the keys go on working", await gridFocused(page));
  await page.locator(sel(barn[0].id, 1)).click();
  n0 = saveCalls(calls).length;
  await page.keyboard.press("Control+D");
  await page.waitForTimeout(900);
  ok("V: the first size has nothing above it to fill from, and says so", (await statusText(page)) === `There's no size above this one in Test Barn to fill down from.` && saveCalls(calls).length === n0, await statusText(page));
  ok("V: no page errors (clear and fill)", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// V3: a view-only page copies, and pastes, fills and clears nothing, sending nothing.
if (want("V")) {
  const cat = catalogFor(OWN);
  const F = fakeServer(cat, tableFor(OWN, cat));
  const barn = barnOf(F.table(OWN));
  const LOFT = keyCol(cat, "loft");
  const { ctx, page, calls, errors } = await open("/settings/sheds-table", { role: "user", access: { settings_structures: "view", designs: "view" }, cat: () => cat, fake: F }, { width: 1280, height: 860 });
  await waitGrid(page).catch(() => {});
  const before = await page.evaluate(() => [...document.querySelectorAll(".ss-pg-grid tbody td")].map((td) => td.textContent).join("|"));
  await page.locator(sel(barn[0].id, 1)).click();
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowRight");
  const cp = await clip.copy(page);
  ok("V: view-only: copy still works", cp.prevented && cp.text === tsvOf([0, 1].map((i) => [1, 2].map((c) => copied(F, cat, barn[i], c)))), JSON.stringify(cp));
  await clip.paste(page, "1\tyes\r\n2\tyes\r\n");
  const afterPaste = await confirmOf(page);
  await page.keyboard.press("Control+D");
  await page.keyboard.press("Delete");
  await page.locator(sel(barn[1].id, LOFT)).click();
  await clip.paste(page, "5\r\n");
  await page.keyboard.press("Control+D");
  await page.waitForTimeout(1300);
  const after = await page.evaluate(() => [...document.querySelectorAll(".ss-pg-grid tbody td")].map((td) => td.textContent).join("|"));
  const tb = await page.locator(".ss-pg-tbtn").count();
  ok("V: view-only: paste, Ctrl+D and Delete on a range do nothing and send nothing; no Fill down or Clear in the toolbar",
    !afterPaste && !(await confirmOf(page)) && before === after && saveCalls(calls).length === 0 && tb === 0 && (await state(page)).badge.startsWith("View only"), JSON.stringify({ tb, calls: saveCalls(calls).length }));
  ok("V: no page errors (view-only)", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// V4: THE 20,000-BOX PASTE (500 sizes x 40 option columns, one style): the plan and the confirm, then
// the commit, timed, with the longest task the page ran meanwhile and the rows it re-rendered; then
// every call it takes to save (at most 50 sizes and 2,500 boxes each). A block of 20,040 is refused.
if (want("V")) {
  const cat = catalogFor(OWN, { extra: 15 });
  const W = OPTION_KEYS(cat).length;
  const table = tableFor(OWN, cat, { styles: 1, perStyle: 510 });
  const F = fakeServer(cat, table);
  F.script = [{ delayMs: 1500 }];   // the first call is held a moment, so every box is still waiting when the commit is drawn
  const barn = barnOf(F.table(OWN));
  const ROWS = Math.floor(20000 / W);
  const { ctx, page, calls, errors } = await open("/settings/sheds-table", { cat: () => cat, fake: F }, { width: 1440, height: 900 });
  await waitGrid(page, 60000).catch(() => {});
  await page.waitForTimeout(800);
  const text = tsvOf(Array.from({ length: ROWS }, (_, r) => Array.from({ length: W }, (_, c) => String(((r + c) % 9) + 1))));
  await page.locator(sel(barn[0].id, 3)).click();
  // Too many boxes first: refused before a value is looked at.
  const tooMany = tsvOf(Array.from({ length: ROWS + 1 }, () => Array.from({ length: W }, () => "1")));
  await clip.paste(page, tooMany);
  ok(`V: a block of ${((ROWS + 1) * W).toLocaleString("en-US")} boxes is refused`,
    (await statusText(page)) === `This block has ${((ROWS + 1) * W).toLocaleString("en-US")} boxes. Paste at most 20,000 at a time.` && !(await confirmOf(page)), await statusText(page));
  const n0 = saveCalls(calls).length;
  const plan = await page.evaluate(async (t) => {
    const long = [];
    const po = new PerformanceObserver((l) => l.getEntries().forEach((e) => long.push(e.duration)));
    try { po.observe({ type: "longtask" }); } catch (_e) { /* no longtask */ }
    const dt = new DataTransfer();
    dt.setData("text/plain", t);
    const t0 = performance.now();
    document.activeElement.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    const handled = performance.now() - t0;
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    const shown = performance.now() - t0;
    await new Promise((r) => setTimeout(r, 200));
    po.disconnect();
    const p = document.querySelector(".ss-pg-confirm p");
    return { handled: Math.round(handled), shown: Math.round(shown), longest: Math.round(Math.max(0, ...long)), text: p ? p.textContent : null };
  }, text);
  const changed = barn.slice(0, ROWS).reduce((n, z, r) => n + OPTION_KEYS(cat).filter((k, c) => Number(F.cells(z.id)[k] || 0) !== ((r + c) % 9) + 1).length, 0);
  ok(`V: the ${(ROWS * W).toLocaleString("en-US")}-box paste asks first, naming the first and last size`,
    plan.text === `Change ${ROWS} sizes, ${named(barn[0])} to ${named(barn[ROWS - 1])}: ${changed.toLocaleString("en-US")} included options. Continue?`, JSON.stringify(plan));
  const commit = await page.evaluate(async (rows) => {
    const long = [];
    const po = new PerformanceObserver((l) => l.getEntries().forEach((e) => long.push(e.duration)));
    try { po.observe({ type: "longtask" }); } catch (_e) { /* no longtask */ }
    const touched = new Set();
    const mo = new MutationObserver((ms) => ms.forEach((m) => {
      if (m.type === "attributes" && m.attributeName === "aria-selected") return;
      const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      const tr = el && el.closest("tr");
      if (tr) touched.add(tr);
    }));
    mo.observe(document.querySelector(".ss-pg-grid tbody"), { subtree: true, childList: true, characterData: true, attributes: true });
    const btn = [...document.querySelectorAll(".ss-pg-confirm button")].find((b) => b.textContent === "Continue");
    const t0 = performance.now();
    btn.click();
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    const painted = performance.now() - t0;
    const marked = document.querySelectorAll(".ss-pg-grid td.ss-pg-m-p").length;
    mo.disconnect();
    const sizesTouched = [...touched].filter((tr) => tr.hasAttribute("data-s")).length;
    const others = [...touched].filter((tr) => !tr.hasAttribute("data-s")).length;
    await new Promise((r) => setTimeout(r, 300));
    po.disconnect();
    return { painted: Math.round(painted), marked, sizesTouched, others, longest: Math.round(Math.max(0, ...long)), rows };
  }, ROWS);
  ok(`V: Continue commits it at once: every changed box waits to save, and only the ${ROWS} pasted rows re-render`,
    commit.marked >= changed - 10 && commit.sizesTouched <= ROWS && commit.others === 0, JSON.stringify(commit));
  // The saving, watched for long tasks too: each answer redraws its 50 rows and rewrites the backup.
  await page.evaluate(() => {
    window.__ssLong = [];
    window.__ssPo = new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__ssLong.push(e.duration)));
    try { window.__ssPo.observe({ type: "longtask" }); } catch (_e) { /* no longtask */ }
  });
  const t0 = Date.now();
  const done = await waitBadge(page, /^All changes saved/, 120000);
  const took = Date.now() - t0;
  const saving = await page.evaluate(() => { window.__ssPo.disconnect(); const l = window.__ssLong; return { n: l.length, longest: Math.round(Math.max(0, ...l)) }; });
  const sc = saveCalls(calls).slice(n0);
  const cellsIn = (b) => b.sizes.reduce((n, s) => n + Object.keys(s.to.cells || {}).length, 0);
  ok(`V: …and saves in calls of at most 50 sizes and 2,500 boxes, every box exactly once`,
    done && sc.every((c) => c.body.sizes.length <= 50 && cellsIn(c.body) <= 2500) && sc.reduce((n, c) => n + cellsIn(c.body), 0) === changed && F.bad.length === 0
    && barn.slice(0, ROWS).every((z, r) => OPTION_KEYS(cat).every((k, c) => F.cells(z.id)[k] === ((r + c) % 9) + 1)),
    JSON.stringify({ done, calls: sc.length, bad: F.bad, perCall: sc.map((c) => [c.body.sizes.length, cellsIn(c.body)]) }));
  const responsive = await page.evaluate(async () => { const t0 = performance.now(); await new Promise((r) => requestAnimationFrame(() => r())); return Math.round(performance.now() - t0); });
  console.log(`TIMING V (20,000-box paste): ${ROWS} sizes x ${W} columns = ${(ROWS * W).toLocaleString("en-US")} boxes (${changed.toLocaleString("en-US")} changing); `
    + `paste event -> planned and the confirm drawn: handler ${plan.handled} ms, next frame ${plan.shown} ms, longest task ${plan.longest} ms; `
    + `Continue -> committed and drawn: ${commit.painted} ms, longest task ${commit.longest} ms, ${commit.sizesTouched} rows re-rendered, ${commit.marked} boxes marked waiting; `
    + `saving: ${sc.length} calls in ${took} ms (fake server answering at once after the first, held 1.5 s), ${saving.n} long tasks, the longest ${saving.longest} ms, per call ${JSON.stringify(sc.map((c) => [c.body.sizes.length, cellsIn(c.body)]))}; a frame after it all ${responsive} ms`);
  ok("V: the page never freezes: no single task over 1 s planning, committing or saving 20,000 boxes",
    plan.longest < 1000 && commit.longest < 1000 && saving.longest < 1000 && plan.shown < 1500 && commit.painted < 1500, JSON.stringify({ plan, commit, saving }));
  ok("V: no page errors (20,000 boxes)", errors.length === 0, errors.join(" | "));
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
    // Plan 8.4's targets, at 1x on Ahsan's machine: first render under 500 ms (data in -> the frame after
    // the grid is committed at its measured height), an arrow key under 16 ms (keydown -> laid out, at
    // the 95th percentile), and so the move is on the very next frame (keydown -> next frame waits for
    // the frame itself, so it is held under two frames, 33 ms, never one). 3x is printed, not judged.
    if (tag === "1x") {
      ok("T1x: first render under 500 ms (plan 8.4's target)", first.painted != null && first.painted < 500, `${first.painted} ms`);
      ok("T1x: an arrow key under 16 ms (plan 8.4's target), drawn on the next frame", keys.syncP95 < 16 && keys.frameP95 < 33.4, `p95 ${keys.syncP95} ms; next frame p95 ${keys.frameP95} ms`);
    }
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
