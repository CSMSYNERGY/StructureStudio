// The sizes table's PORTAL wiring (Settings → Sheds → "Open sizes & prices table", 2026-10-30), read
// from the SHIPPED portal source. The server half (size_table and save_pricing_cells through the real
// portal-settings handler) is pricingTableWiring_test.ts, beside this file; the drawn page is
// tests/harness/pricingTable.mjs, which drives the compiled portal.
//
// WHAT IS PINNED:
//   1. Dashboard draws the table below its last hook and its early returns, before the main return,
//      with no hook of its own, keyed on the tenant (React #310: a hook below an early return turns
//      the page white the moment its data lands, and neither the compile nor lint sees it).
//   2. PricingTableGate and PricingTablePage keep every hook above their first return, for the same
//      reason.
//   3. The gate holds on the ?open= rule (12-shell.jsx) while ?view= arms, and never draws the table
//      for any other account: its timeout says so instead. ?as= opens view-only.
//   4. ssPricingTableHref keeps ?view=, adds ?as= from ssTargetUserId and ?style=, and drops the rest.
//      The Sheds card and Add style's answer open it as REAL anchors in a new tab, never ssNavClick.
//   5. The page's two reads (ssPgFetch) go through ssStyleSaveCall filed as pricing_table_side_door,
//      with targetClientId ALWAYS on the body (the side door skips the invoke wrapper), and an answer
//      for any other account is a failure and a log row, never a table.
//   6. ssStyleSaveCall's new logCode defaults to the style saves' own code.
//   7. Every settings-saved event says which page load sent it (SS_PAGE_ID), so the table can tell
//      its own saves from another tab's.
//   8. Phase 3 (editing): saves go one call at a time through ssStyleSaveCall as save_pricing_cells
//      with targetClientId on the body and the answer's account checked by the page; every edit path
//      checks the page can still edit; no log row carries a value; leaving asks first while anything
//      is unsent or the editor holds changed text, and Back to Sheds sends first, as does the browser's
//      Back or Forward, which the page holds while anything is unsent; the editor and the overlay keep
//      their hooks above any return.
//   9. Phase 4a: adding and removing sizes, the refresh and the backup check the page can still edit
//      and go through the queue; the strip and the rows keep their memos.
//  10. Phase 4b: paste, fill down and clear check the page can still edit and go into the queue in
//      one event; copy works on a view-only page; Ctrl/Cmd+D is held from the browser; the confirm is
//      an accessible modal.
//
// Lifted with the xlsxCellText_test anchor idiom: the text between a signature and the next "\n}\n".
// No network, no DOM: the lifted functions get stubs for exactly the names they use.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";

const read = async (p: string) => (await Deno.readTextFile(new URL(`../../../../portal/${p}`, import.meta.url))).replace(/\r\n/g, "\n");
const CORE = await read("01-core.jsx");
const CATALOG = await read("03-catalog.jsx");
const SHELL = await read("12-shell.jsx");

const between = (src: string, a: string, b: string, what: string) => {
  const i = src.indexOf(a);
  const j = i < 0 ? -1 : src.indexOf(b, i + a.length);
  if (i < 0 || j < 0) throw new Error(`pricingTableWiringPortal_test: could not find ${what} (start=${i}, end=${j}) — re-point the anchors rather than deleting this test.`);
  return src.slice(i, j);
};
const fnText = (src: string, sig: string) => between(src, sig, "\n}\n", sig) + "\n}\n";
const HOOK = /\b(?:React\.)?use[A-Z]\w*\(/g;
const hookAt = (body: string) => [...body.matchAll(HOOK)].map((m) => m.index as number);

// ── 1. The Dashboard branch ──────────────────────────────────────────────────────────────────
Deno.test("Dashboard draws the table below its last hook and early return, with no hook of its own, keyed on the tenant", () => {
  const dash = fnText(SHELL, "function Dashboard({ session }) {");
  const at = dash.indexOf(`if (tab === "settings" && sub === SS_PRICING_TABLE_SUB) {`);
  assert(at > 0, "the sheds-table branch is gone from Dashboard");
  const hooks = hookAt(dash);
  assert(hooks.length > 0 && hooks.every((i) => i < at), "a hook sits below the table's branch: React #310 on the first load");
  // Dashboard's own early returns (`if (…) return` / `if (…) {\n    return`) all come before it.
  const early = [...dash.matchAll(/\n  if \([^\n]*\) return\b|\n  if \([^\n]*\) \{\n    return\b/g)].map((m) => m.index as number).filter((i) => i < at - 3);
  assert(early.length > 0 && early.every((i) => i > Math.max(...hooks)), "Dashboard's early returns moved above a hook");
  assert(at > dash.indexOf("const gateLocked = "), "the branch must see gateLocked, so it sits below it");
  const main = dash.indexOf(`<div className="ss-shell">`);
  assert(main > at, "the branch must come before the main return, or the rail and top bar draw around the table");
  const branch = between(dash, `if (tab === "settings" && sub === SS_PRICING_TABLE_SUB) {`, "\n  }\n", "the branch");
  assert(branch.includes(`<PricingTableGate key={"t-" + effClientId} clientId={effClientId}`), "keyed on the tenant, so a change of account remounts it");
  for (const prop of ["viewing={viewing}", "isSupportOp={isSupportOp}", "supportCheckGaveUp={supportCheckGaveUp}", "viewedCtx={viewedCtx}",
    "canAdmin={canAdmin}", "access={myAccess}", "gateLocked={gateLocked}"]) {
    assert(branch.includes(prop), `the gate needs ${prop}`);
  }
  // The viewed builder's own name, not the slug a cold ?view= seeds `viewing` with.
  assert(branch.includes("viewedCtx.clientId === viewing.clientId && viewedCtx.companyName) || shownBusiness"), "the company name comes from the viewed tenant's own answer");
  assert(between(SHELL, "const [viewedCtx, setViewedCtx] = useState(null);", "load(0);", "the viewedCtx effect").includes("companyName: (st.data.branding && st.data.branding.companyName) || null"));
  assertEquals(hookAt(branch), [], "the branch itself calls no hook");
});

// ── 2. Hooks above the first return in the new components ────────────────────────────────────
for (const sig of [
  "function PricingTableGate({ clientId, viewing, isSupportOp, supportCheckGaveUp, viewedCtx, canAdmin, access, gateLocked, billingActor, companyName, onNav }) {",
  "function PricingTablePage({ clientId, target, companyName, operatorView, viewOnly, styleParam, onNav }) {",
]) {
  const name = sig.slice(9, sig.indexOf("("));
  Deno.test(`${name}: every hook is above its first return (React #310)`, () => {
    const body = fnText(CATALOG, sig);
    // The first statement at the body's own indent that returns or branches to a return.
    const first = body.search(/\n  (?:return\b|if \()/);
    assert(first > 0, `${name}: no return found`);
    const hooks = hookAt(body);
    assert(hooks.length > 0, `${name}: no hooks found; the anchor is wrong`);
    const late = hooks.filter((i) => i > first).map((i) => body.slice(i, i + 30));
    assertEquals(late, [], `${name}: a hook below the first return`);
  });
}

// ── 3. The gate ──────────────────────────────────────────────────────────────────────────────
Deno.test("the gate holds on the ?open= rule, times out at 10 s without falling back, and ?as= opens view-only", () => {
  const gate = fnText(CATALOG, "function PricingTableGate(");
  // The same two conditions Dashboard's ?open= effect waits for.
  const openRule = between(SHELL, "const want = openParamRef.current;", "openParamRef.current = null;", "the ?open= effect");
  assert(openRule.includes("viewing && viewing.clientId === v && (isSupportOp !== null || supportCheckGaveUp)"));
  assert(openRule.includes("isSupportOp && !(viewedCtx && viewedCtx.clientId === v)"));
  assert(gate.includes("const held = !!v && (!(viewing && viewing.clientId === v && (isSupportOp !== null || supportCheckGaveUp))"), "the gate's hold drifted from the ?open= rule");
  assert(gate.includes("|| (!!isSupportOp && !(viewedCtx && viewedCtx.clientId === v)));"), "a support operator must also wait for the viewed tenant's own answer");
  assert(CATALOG.includes("const SS_PRICING_HOLD_MS = 10000;"));
  // While held: a message, and NOTHING else is mounted (its reads would go to the operator's own tenant).
  const heldBlock = between(gate, "if (held) {", "\n  }\n", "the held branch");
  assert(heldBlock.includes("Couldn't open that account here. Close this tab and use the button on Sheds again."));
  assert(!heldBlock.includes("PricingTablePage"), "the held branch must never mount the table");
  // The table is mounted once, after the hold, the billing lock and the read check.
  assertEquals((gate.match(/<PricingTablePage /g) || []).length, 1);
  const page = gate.indexOf("<PricingTablePage ");
  for (const guard of ["if (held) {", "if (gateLocked) {", "if (!canRead) return"]) assert(gate.indexOf(guard) > 0 && gate.indexOf(guard) < page, `${guard} must come before the table`);
  // Booleans, never compared with "edit" (memory disabled-ui-fails-silently).
  assert(gate.includes(`const canRead = !!canAdmin || ssCanRead(access, "settings_structures");`));
  assert(gate.includes(`const canEdit = !!canAdmin || ssCanWrite(access, "settings_structures");`));
  assert(/const viewOnly = params\.as\s*\n\s*\? \{ as: true,/.test(gate), "?as= must open view-only, whatever the rights");
  // …naming the person (plan 5) from the switcher's people list once the hold lets go; this tab has
  // only their id. "a team member" until that answers, or if it is refused.
  const named = between(gate, "const [asName, setAsName] = useState(null);", "if (held) {", "the ?as= name lookup");
  assert(named.includes("if (held || !v || !params.as) return undefined;"), "the name is read for the viewed account only, after the hold");
  assert(named.includes(`sb.functions.invoke("operator-portal", { body: { action: "list_users", clientId: v } })`));
  assert(gate.includes("long: `You're viewing as ${asName || \"a team member\"}. The table is view-only here;"), "the view-only message names the person");
});

Deno.test("the operator strip says view-only whenever the badge does, never 'Changes are live' beside it", () => {
  const page = fnText(CATALOG, "function PricingTablePage(");
  assert(page.includes("const readOnly = !!viewOnly || tooBig;"), "readOnly is every reason the badge says View only");
  assert(page.includes(`const editable = load.phase === "ready" && !readOnly;`));
  // Phase 3: a 403 on a save, or an answer for another account, ends editing too (lostEdit).
  assert(page.includes(`const lostEdit = !!(q && (q.viewOnly || (q.stopped && q.stopped.kind === "tenant")));`));
  const strip = between(page, `<div className="ss-pg-op" role="note">`, "</div>", "the operator strip");
  assert(/\{\(readOnly \|\| lostEdit\)\s*\n\s*\? `Viewing \$\{companyName\} as operator\. This table is view-only\.`/.test(strip), strip);
});

// ── 8. Phase 3: editing and the save path ────────────────────────────────────────────────────
Deno.test("saves go one at a time through ssStyleSaveCall as save_pricing_cells, targetClientId always on the body, the answer's account checked", () => {
  const page = fnText(CATALOG, "function PricingTablePage(");
  assert(page.includes(`const body = { action: "save_pricing_cells", targetClientId: target || null, creates: flight.body.creates, removes: flight.body.removes, sizes: flight.body.sizes };`),
    "the side door skips the invoke wrapper: the view-as target must be on the body");
  assert(page.includes(`ssStyleSaveCall(body, "Pricing table", "pricing_table_side_door")`));
  assert(page.includes("const v = ssPgAnswerKind(r, clientId);"), "the answer's clientId is the page's to check (the wrapper's tripwire never runs on the side door)");
  // Every edit path goes through canEditNow (view-only, a 403, another account's answer).
  for (const fn of ["const startEdit = (cell, key) => {\n    if (!cell || !canEditNow()) return;", "const toggleOffered = (cell) => {\n    if (!canEditNow()", "const clearCell = (cell) => {\n    if (!canEditNow()"]) {
    assert(page.includes(fn), `an edit path without the view-only check: ${fn.split("\n")[0]}`);
  }
  // Only these three start a change in Phase 3, and each goes into the queue (apply), never to the network.
  assertEquals((page.match(/ssStyleSaveCall\(/g) || []).length, 1, "one transport call site");
  // Logs carry counts and statuses, never a price or what was typed.
  for (const m of page.matchAll(/ssLogError\(([\s\S]*?)\);/g)) assert(!/typed|\.price|\bto\b|draft/.test(m[1]), `a log row that could carry a value: ${m[1].slice(0, 120)}`);
});

Deno.test("leaving asks first while anything is unsent or in flight, or the editor holds changed text; Back to Sheds and the browser's Back send first", () => {
  const page = fnText(CATALOG, "function PricingTablePage(");
  const leave = between(page, "const onLeave = (e) => {", "\n    };", "the beforeunload handler");
  assert(leave.includes("if (!(c.pending + c.inflight + c.creating + c.removing) && !dirtyRef.current) return undefined;"), leave);
  assert(leave.includes("e.preventDefault();") && leave.includes(`e.returnValue = "";`));
  assert(page.includes(`window.addEventListener("beforeunload", onLeave);`));
  // The editor's text counts from its first different keystroke, without re-rendering per keystroke.
  const input = between(page, "const onEditInput = (e) => {", "\n  };", "onEditInput");
  assert(input.includes("draftRef.current = e.target.value;") && input.includes("if (d !== dirtyRef.current) { dirtyRef.current = d; setDraftDirty(d); }"));
  assert(page.includes("const unsent = counts.pending + counts.creating + counts.removing + (draftDirty ? 1 : 0);"), "the badge counts an open editor's changed text");
  // Back to Sheds and Go to Options leave the same way: commit, send, wait. A box the editor's commit
  // turned red keeps the page open; a click that cannot send first says so (Leave anyway), never
  // silently.
  const leaveFor = between(page, "const leaveFor = (to) => {", "\n  };", "leaveFor");
  assert(leaveFor.includes("if (!commitEdit()) { focusGrid(); return; }"), "the editor's red box must keep the page open");
  assert(leaveFor.includes("setLeaving({ to, was: cur.fields });") && leaveFor.includes("flushNow();"));
  assert(leaveFor.includes("if (cur.viewOnly || cur.stopped || cur.failures) { setStuck({ to }); return; }"));
  assert(leaveFor.includes("{ go(to); return; }"), leaveFor);
  assert(page.includes("const leaveTo = (sub) => ssNavClick(() => leaveFor(sub));"));
  assert(page.includes(`const toSheds = leaveTo("sheds");`));
  assert(page.includes(`onClick={leaveTo("options")}>Go to Options →</a>`), "Go to Options must send first too");
  assert(!/ssNavClick\(\(\) => onNav\(/.test(page), "an in-app link out of the table that skips leaveTo");
  // Pressing the link must not blur the editor first (the blur would commit it before the click).
  assert(page.includes(`onMouseDown={holdEditor} onClick={toSheds}>← Back to Sheds</a>`) && page.includes(`onMouseDown={holdEditor} onClick={leaveTo("options")}>`));
  // The wait: a box gone red since the click stays on screen; a failure, a stop or a 403 says so.
  const wait = between(page, "useEffect(() => {\n    if (!leaving || !q) return;", "}, [leaving, q, counts]);", "the leaving effect");
  assert(wait.includes("if (red) { setLeaving(null); fnRef.current.jumpRed(isNew); return; }"), wait);
  assert(wait.includes("if (q.viewOnly || q.stopped || q.failures) { setLeaving(null); setStuck({ to: leaving.to }); return; }"), wait);
  assert(wait.includes("fnRef.current.go(leaving.to);") && !wait.includes("onNav("), "the wait goes the way the click asked (a tab, or where a held Back was going)");
  // Hiding the tab sends what is waiting at once, and so does any other way out of the page, the
  // editor's text included.
  assert(page.includes(`const onVis = () => { if (document.visibilityState === "hidden") fnRef.current.flushNow(); };`));
  assert(page.includes("try { fnRef.current.commitEdit(); } catch (_c) { /* best effort: the page is going */ }\n      try { fnRef.current.flushNow(); } catch (_f) { /* best effort: the page is going */ }"),
    "the unmount commits the editor, then flushes");
  // Review round 2 (2026-10-31). The browser's Back or Forward while anything is unsent, in flight or
  // in the editor is held and leaves through leaveFor. Let through, the page unmounted with a
  // follow-up behind a call out and that call's answer unread. The shell's popstate handler asks the
  // hold before it routes anything: a listener of the page's own runs after the shell's, which has
  // unmounted the table by then (Chrome runs window's popstate listeners in the order they were added).
  assert(/\nlet ssPgPopHold = null;\n/.test(CATALOG), "the hold is a module-level hook the page installs");
  const shellPop = between(SHELL, "const onPop = () => {", "const p = ssParsePath();", "Dashboard's popstate handler");
  assert(shellPop.includes("if (ssPgPopHold && ssPgPopHold()) return;"), "the shell must ask the table's hold before it routes a pop");
  assert(page.includes("ssPgPopHold = holdPop;") && page.includes("if (ssPgPopHold === holdPop) ssPgPopHold = null;"), "installed while mounted, and only its own taken down");
  const hold = between(page, "const holdPop = () => {", "\n    };", "the popstate hold");
  const run = (o: { pass?: boolean; counts?: Record<string, number>; dirty?: boolean; back?: unknown }) => {
    const did: any = { pushed: null, left: null, said: 0 };
    const win = { location: { pathname: "/settings/sheds", search: "", hash: "" }, history: { state: { page: "settings", sub: "sheds" }, pushState: (st: unknown, _t: string, url: string) => { did.pushed = { st, url }; } } };
    const zero = { pending: 0, inflight: 0, creating: 0, removing: 0 };
    const held = new Function("window", "passRef", "qRef", "addrRef", "dirtyRef", "fnRef", "ssPgCount", "ssPhonePortMoved", `${hold}\n    };\n    return holdPop();`)(
      win, { current: !!o.pass }, { current: {} }, { current: o.back === undefined ? { url: "/settings/sheds-table", state: null } : o.back }, { current: !!o.dirty },
      { current: { leaveFor: (to: unknown) => { did.left = to; } } }, () => ({ ...zero, ...(o.counts || {}) }), () => { did.said++; });
    return { held, ...did };
  };
  assertEquals(run({ counts: { inflight: 1 } }), { held: true, pushed: { st: null, url: "/settings/sheds-table" }, left: { url: "/settings/sheds", state: { page: "settings", sub: "sheds" } }, said: 1 });
  assertEquals(run({ dirty: true }).held, true, "the editor's text alone holds it");
  for (const k of ["pending", "creating", "removing"]) assertEquals(run({ counts: { [k]: 1 } }).held, true, k);
  assertEquals(run({}), { held: false, pushed: null, left: null, said: 0 }, "nothing waiting: the shell routes it");
  assertEquals(run({ pass: true, counts: { pending: 1 } }).held, false, "the page's own way out (go) is let through");
  assertEquals(run({ back: null, counts: { pending: 1 } }).held, false, "no address to put back: never half-held");
  const go = between(page, "const go = (to) => {", "\n  };", "go");
  assert(go.includes(`if (typeof to === "string") { onNav(to); return; }`) && go.includes("passRef.current = true;") && go.includes("finally { passRef.current = false; }"), go);
  assertEquals((page.match(/\bonNav\(/g) || []).length, 1, "every way out of the table goes through go (and so through leaveFor or Leave anyway)");
  assert(page.includes("setStuck(null); go(to); }}>Leave anyway</button>"));
  // Starting another edit while a leave waits calls it off: the page never goes with the editor open.
  assert(page.includes("const backToWork = () => { if (leaving) setLeaving(null); };"));
  for (const fn of ["const startEdit = (cell, key) => {", "const toggleOffered = (cell) => {", "const clearCell = (cell) => {"]) {
    assert(between(page, fn, "\n  };", fn).includes("backToWork();"), `${fn} must call a waiting leave off`);
  }
  // The editor's commit carries what the box showed when typing began (the queue's `seen` check).
  assert(page.includes("seen: shownOf(cell.sizeId, f) };") && page.includes("commitText(ed.sizeId, ed.col, text, { seen: ed.seen })"));
});

Deno.test("the editor and the overlay keep every hook above any return, and PgRow takes primitive marks", () => {
  for (const sig of ["function PgEditor({ inputRef, init, label, price, onKeyDown, onInput, onBlur }) {", "function PgSelectionOverlay({ lane = false, ringRef, rangeRef, children = null }) {"]) {
    const body = fnText(CATALOG, sig);
    const first = body.search(/\n  (?:return\b|if \()/);
    assert(first > 0, sig);
    assertEquals(hookAt(body).filter((i) => i > first), [], `${sig}: a hook below the first return`);
  }
  const ed = fnText(CATALOG, "function PgEditor(");
  assert(ed.includes(`type="text"`) && ed.includes(`inputMode={price ? "decimal" : "numeric"}`) && ed.includes("aria-label={label}"), "plan 3.5 and 3.17");
  assert(CATALOG.includes("const PgRow = React.memo(function PgRow({ rowIndex, sizeId, label, title, priceText, offered, noPrice, hidden, values, rtp, marks = \"\",\n  busy = \"\", removable = false }) {"));
});

// ── 4. The address, and the anchors that open it ─────────────────────────────────────────────
Deno.test("ssPricingTableHref keeps ?view=, adds ?as= and ?style=, and drops everything else", () => {
  const router = between(CORE, "const SS_TAB_ALIASES =", "// Is this deployment a beta/preview surface?", "the router");
  const href = between(CORE, "const SS_PRICING_TABLE_SUB = ", "\n}\n", "ssPricingTableHref") + "\n}\n";
  const win = { location: { pathname: "/settings/sheds", search: "" } };
  const make = (as: string | null) => new Function("window", "ssTargetUserId", `${router}\n${href}\nreturn ssPricingTableHref;`)(win, as) as (o?: any) => string;
  win.location.search = "?view=test-barns&open=ABC123&version=2&tab=x";
  assertEquals(make(null)(), "/settings/sheds-table?view=test-barns");
  assertEquals(make("00000000-0000-4000-8000-0000000000b2")(), "/settings/sheds-table?view=test-barns&as=00000000-0000-4000-8000-0000000000b2");
  assertEquals(make(null)({ style: "s-1" }), "/settings/sheds-table?view=test-barns&style=s-1");
  win.location.search = "";
  assertEquals(make(null)(), "/settings/sheds-table");
  assertEquals(make(null)({ style: "s-1" }), "/settings/sheds-table?style=s-1");
  assertEquals(make(null)({ style: "" }), "/settings/sheds-table");
});

Deno.test("the Sheds card and Add style's answer open the table as real anchors in a new tab, never ssNavClick", () => {
  const card = fnText(CATALOG, "function PricingCsv({ viewingLabel = null, onGoToOptions = null }) {");
  assert(card.includes(`<a href={ssPricingTableHref()} target="_blank" rel="noopener"`), "the card's link");
  assert(card.includes(`<a href={ssPricingTableHref({ style: msg.added.styleId })} target="_blank" rel="noopener"`), "Add style's link, jumped to the new style");
  assert(card.includes("setMsg({ added: { name: added, styleId: (data && data.styleId) || null } });"), "create_style answers styleId");
  for (const line of card.split("\n").filter((l) => l.includes("ssPricingTableHref("))) assert(!line.includes("ssNavClick"), line);
  assert(card.includes("Sizes, prices &amp; included options"), "the card's new title");
  assert(card.includes(">Prefer Excel?</span>"), "the Excel row");
  assert(card.includes("Changed numbers in the table? Download a fresh template before you use Excel again."), "the warning sentence");
  // The template is built from fresh reads with the guard, never from the `cat` Sheds mounted with.
  const dl = between(card, "const downloadTemplate = async () => {", "const onUpload = async (file) => {", "downloadTemplate");
  assert(dl.includes("await ssPgFetch(target, cat.clientId || null)") && dl.includes("ssPgModel(r.cat, r.table).guard") && dl.includes("ssPgTemplate(fresh.cat, fresh.table)"));
  assert(!/cat\.(sizes|inclusions)/.test(dl), "the template reads sizes or inclusions off the mounted catalog again");
  // Only a list that does not add up refuses the sheet (plan 4.8). "cap" and an orphan row build it:
  // the table sends a builder who trips them to Excel, so Excel must not refuse them too.
  assert(dl.includes(`if (ssPgModel(r.cat, r.table).guard !== "count") fresh = r;`), "the template refuses on a guard other than \"count\" again");
  // …and the upload maps headers through the columns that sheet was built from: a column added since
  // Sheds mounted is in the sheet, and onUpload reads `cat`, so `cat` must become fresh.cat first.
  const adopt = dl.indexOf("setCat(fresh.cat);");
  assert(adopt > dl.indexOf("if (!fresh) {") && adopt < dl.indexOf("ssPgTemplate(fresh.cat, fresh.table)"), "the sheet's catalog must become `cat` once the read is accepted, before the sheet is built");
  const up = between(card, "const onUpload = async (file) => {", "\n  };\n", "onUpload");
  assert(up.includes("optionCols().forEach((it) => { labelToKey[it.label.toLowerCase()] = it.key;"), "the upload's column map moved off `cat`: re-check that it matches the sheet's columns");
  assert(card.includes("const optionSections = () => ssPricingColumns(cat);"));
});

// ── 5. The page's reads ──────────────────────────────────────────────────────────────────────
type Call = { body: any; label: string; logCode: string };
function fetchWith(answer: (body: any) => any) {
  const calls: Call[] = [];
  const logs: any[][] = [];
  const ssStyleSaveCall = (body: any, label: string, logCode: string) => { calls.push({ body, label, logCode }); return Promise.resolve(answer(body)); };
  const ssLogError = (...a: any[]) => { logs.push(a); };
  const fn = new Function("ssStyleSaveCall", "ssLogError", `${fnText(CATALOG, "async function ssPgFetch(target, expect) {")}; return ssPgFetch;`)(ssStyleSaveCall, ssLogError);
  return { calls, logs, fetch: fn as (target: string | null, expect: string | null) => Promise<any> };
}
const TABLE = (clientId: string) => ({ ok: true, clientId, styles: [], sizes: [], inclusions: [], counts: { sizes: 0, inclusions: 0 }, rtpOn: false });
const CAT = (clientId: string) => ({ ok: true, clientId, items: [], fixtures: [] });

Deno.test("ssPgFetch: catalog and size_table through ssStyleSaveCall as pricing_table_side_door, targetClientId always on the body", async () => {
  const own = fetchWith((b) => ({ data: b.action === "catalog" ? CAT("test-barns") : TABLE("test-barns"), error: null }));
  const r = await own.fetch(null, "test-barns");
  assert(r.ok);
  assertEquals(own.calls.map((c) => c.body), [{ action: "catalog", withUnpriced: true, targetClientId: null }, { action: "size_table", targetClientId: null }]);
  assert(own.calls.every((c) => c.label === "Pricing table" && c.logCode === "pricing_table_side_door"));
  assert(own.calls.every((c) => "targetClientId" in c.body), "the side door is a raw fetch: an absent target would be the operator's own tenant");
  const viewed = fetchWith((b) => ({ data: b.action === "catalog" ? CAT("test-barns") : TABLE("test-barns"), error: null }));
  assert((await viewed.fetch("test-barns", "test-barns")).ok);
  assert(viewed.calls.every((c) => c.body.targetClientId === "test-barns"));
});

Deno.test("ssPgFetch: an answer for another account is a failure and one log row, never a table", async () => {
  for (const wrong of ["catalog", "size_table"]) {
    const f = fetchWith((b) => ({ data: b.action === wrong ? (wrong === "catalog" ? CAT("other-barns") : TABLE("other-barns")) : (b.action === "catalog" ? CAT("test-barns") : TABLE("test-barns")), error: null }));
    const r = await f.fetch("test-barns", "test-barns");
    assertEquals(r.ok, false, wrong);
    assertEquals(f.logs.length, 1);
    assertEquals(f.logs[0][2], "pricing_table_wrong_tenant");
  }
});

Deno.test("ssPgFetch: a refusal keeps its status and the server's words; a size_table without its lists is a failure", async () => {
  const refused = fetchWith((b) => b.action === "size_table" ? { data: null, error: { message: "You don't have access to that.", ssStatus: 403 } } : { data: CAT("test-barns"), error: null });
  assertEquals(await refused.fetch(null, "test-barns"), { ok: false, status: 403, error: "You don't have access to that." });
  const bodyErr = fetchWith((b) => ({ data: b.action === "size_table" ? { error: "Couldn't load your sizes." } : CAT("test-barns"), error: null }));
  const r2 = await bodyErr.fetch(null, "test-barns");
  assertEquals([r2.ok, r2.error], [false, "Couldn't load your sizes."]);
  const short = fetchWith((b) => ({ data: b.action === "size_table" ? { ok: true, clientId: "test-barns", styles: [] } : CAT("test-barns"), error: null }));
  assertEquals((await short.fetch(null, "test-barns")).ok, false);
});

// ── 6. ssStyleSaveCall's log code ────────────────────────────────────────────────────────────
Deno.test("ssStyleSaveCall: logCode is optional, defaults to the style saves' code, and names the side-door row", () => {
  const fn = fnText(SHELL, "async function ssStyleSaveCall(body, label, logCode = \"style_save_side_door\") {");
  assert(/retrying through the functions host`,\s*\n\s*logCode, \{ fn: "portal-settings", action: body\.action \}, "info"\);/.test(fn), "the side-door row must be filed under logCode");
  assert(!fn.includes(`"style_save_side_door", {`), "the code is hard-wired again");
});

// ── 7. Who sent a settings-saved event ───────────────────────────────────────────────────────
Deno.test("SS_PAGE_ID: one id per page load, and ssSettingsSaved stamps it on both the event and the channel", () => {
  const idSrc = between(CORE, "const SS_PAGE_ID = ", "})();", "SS_PAGE_ID") + "})();";
  const mkId = (win: any) => new Function("window", `${idSrc}; return SS_PAGE_ID;`)(win) as string;
  assertEquals(mkId({ crypto: { randomUUID: () => "uuid-1" } }), "uuid-1");
  const a = mkId({}), b = mkId({});
  assert(/^p-[a-z0-9]+-[a-z0-9]+$/.test(a) && a !== b, `${a} / ${b}`);
  const events: any[] = [], posts: any[] = [];
  class FakeCustomEvent { type: string; detail: any; constructor(t: string, o: any) { this.type = t; this.detail = o.detail; } }
  class FakeChannel { constructor(public name: string) {} postMessage(d: any) { posts.push(d); } close() {} }
  const saved = new Function("window", "CustomEvent", "BroadcastChannel", "SS_PAGE_ID",
    `${fnText(CORE, "function ssSettingsSaved(clientId) {")}; return ssSettingsSaved;`)(
    { dispatchEvent: (e: any) => events.push(e) }, FakeCustomEvent, FakeChannel, "page-1") as (c: string | null) => void;
  saved("test-barns");
  assertEquals(events.length, 1);
  assertEquals(events[0].type, "ss:settings-saved");
  assertEquals([events[0].detail.clientId, events[0].detail.source], ["test-barns", "page-1"]);
  assertEquals([posts[0].clientId, posts[0].source], ["test-barns", "page-1"]);
});

// ── 9. Phase 4a: adding sizes, Remove, the refresh, the backup ───────────────────────────────
Deno.test("PgAddSizes keeps every hook above its return; the bands and rows take no function, so their memos hold", () => {
  const sig = "function PgAddSizes({ rowIndex, styleId, styleLabel, existing, ncols, empty, focusKey = 0, onAdd, onClose }) {";
  const body = fnText(CATALOG, sig);
  const first = body.search(/\n  (?:return\b|if \()/);
  assert(first > 0, sig);
  assert(hookAt(body).length >= 5, "the strip's hooks were not found: the anchor is wrong");
  assertEquals(hookAt(body).filter((i) => i > first), [], `${sig}: a hook below the first return`);
  assert(body.includes("ssPgParseSizeList(text, existing)") && body.includes("ssPgSizeGrid(widths, lengths, existing, off)"), "the strip checks before anything is sent");
  // ＋ Add sizes and ✕ Remove are the grid's own clicks (data-pg-act), so PgStyleBand and PgRow stay primitive.
  assert(CATALOG.includes("const PgStyleBand = React.memo(function PgStyleBand({ rowIndex, styleId, label, total, hidden, folded, ncols, canAdd = false, open = false }) {"));
  assert(CATALOG.includes(`data-pg-act="add" data-pg-id={styleId} aria-expanded={open}>＋ Add sizes</button>`), "the button's words are the FAQ's");
  assert(CATALOG.includes(`data-pg-act="remove" data-pg-id={sizeId} tabIndex={-1}`));
  const page = fnText(CATALOG, "function PricingTablePage(");
  assert(page.includes("onClick={onAct}>"), "the grid's click handles both buttons");
  assert(page.includes("const onAddSizes = useCallback((styleId, sizes, skipped) => fnRef.current.addSizes(styleId, sizes, skipped), []);"), "a stable callback for the strip");
  // Keys typed in a strip are the strip's, never the grid's.
  assert(page.includes("const onKeyDown = (e) => {\n    if (e.target !== e.currentTarget) return;"), "the grid must ignore keys pressed inside an add strip");
});

Deno.test("every way to add or remove a size, or put a backup back, checks the page can still edit, and goes through the queue", () => {
  const page = fnText(CATALOG, "function PricingTablePage(");
  for (const fn of ["const addSizes = (styleId, sizes, skipped) => {\n    if (!canEditNow()", "const toggleAdd = (styleId) => {\n    if (!canEditNow()",
    "const removeSize = (id) => {\n    if (!canEditNow() || !ssPgCanRemove(qRef.current, id, byId[id] ? byId[id].size : null)) return;"]) {
    assert(page.includes(fn), `an add/remove path without the view-only check: ${fn.split("\n")[0]}`);
  }
  assert(between(page, "const saveEarlier = () => {", "\n  };", "saveEarlier").includes("if (!b || !canEditNow()) return;"));
  const add = between(page, "const addSizes = (styleId, sizes, skipped) => {", "\n  };", "addSizes");
  assert(add.includes(`apply({ type: "create", id: a.id, styleId, width: a.width, length: a.length, at: Date.now() })`) && add.includes("sendNow();") && add.includes("backToWork();"));
  const rm = between(page, "const removeSize = (id) => {", "\n  };", "removeSize");
  assert(rm.includes(`apply({ type: "remove", id, at: Date.now() });`) && rm.includes("backToWork();"));
  // The add strip and Remove are only drawn when the page can edit (plan 3.16).
  assert(page.includes("adding: canEdit ? addOpen : null, addEmpty: canEdit, keep: keepIds"));
  assert(page.includes("busy={busy} removable={canEdit && ssPgCanRemove(q, z.id, z)} />"));
  assert(page.includes("canAdd={canEdit} open={!!addOpen[r.style.id] || !r.total} />"));
  assertEquals((page.match(/ssStyleSaveCall\(/g) || []).length, 1, "still one transport call site: adds and removes ride the save queue");
});

Deno.test("the refresh: another page's save for this account, or the tab coming back into view, re-reads both tables through the queue's rules", () => {
  const page = fnText(CATALOG, "function PricingTablePage(");
  const fx = between(page, "  useEffect(() => {\n    const hear = (d) => {", "}, [clientId]);", "the refresh triggers");
  assert(fx.includes("if (d && d.source === SS_PAGE_ID) return;"), "its own saves never refresh it");
  assert(fx.includes("if (d && d.clientId && clientId && String(d.clientId) !== String(clientId)) return;"), "another account's save is ignored");
  assert(fx.includes(`window.addEventListener("ss:settings-saved", onSaved);`) && fx.includes(`bc = new BroadcastChannel("ss-settings");`));
  assert(fx.includes(`const onShown = () => { if (document.visibilityState === "visible") fnRef.current.pokeRefresh(); };`), "every return to the tab, with no minimum time away");
  assert(fx.includes("clearTimeout(refreshTimerRef.current);"), "the wait is cleared on the way out");
  const poke = between(page, "const pokeRefresh = () => {", "\n  };", "pokeRefresh");
  assert(poke.includes("if (refreshTimerRef.current) return;") && poke.includes(": 1000;"), "waits 1 s and coalesces");
  const now = between(page, "const refreshNow = async () => {", "\n  };", "refreshNow");
  assert(now.includes("r = await ssPgFetch(target, clientId);"), "both tables, through the checked read");
  const adopt = between(page, "const adoptRead = (m, okAt) => {", "\n  };", "adoptRead");
  assert(adopt.includes("if (cur.oks !== okAt) { pokeRefresh(); return; }"), "a read asked for before the latest answer is dropped and asked again");
  assert(adopt.indexOf(`apply({ type: "columns"`) > 0 && adopt.indexOf(`apply({ type: "columns"`) < adopt.indexOf(`apply({ type: "refresh"`), "columns first, then the refresh rule");
  assert(adopt.includes("if (m.guard && !was.guard) return;"), "a read that does not add up never replaces one that did");
  // The queue is initialised once, by the first load; every later read keeps its red boxes and edits.
  assertEquals((page.match(/type: "init"/g) || []).length, 1);
  assert(page.includes("const fetchAll = useCallback(async () => {\n    if (qRef.current) { fnRef.current.refreshNow(); return; }"), "Reload and Retry must not re-initialise a queue that exists");
  assert(between(page, "const discard = () => {", "\n  };", "discard").includes("if (st.unsure) refreshNow();"));
  // The pinned hide handler is unchanged: hiding the tab still sends what is waiting.
  assert(page.includes(`const onVis = () => { if (document.visibilityState === "hidden") fnRef.current.flushNow(); };`));
});

Deno.test("the backup: keyed by person and account, written only by a page that can edit, offered back once, red entries listed and never sent", () => {
  const page = fnText(CATALOG, "function PricingTablePage(");
  assert(page.includes("const backupKey = ssCurrentUserId && clientId ? `ss-pg-pending:${ssCurrentUserId}:${clientId}` : null;"), "plan 4.9's key: the person and the effective account");
  const save = between(page, "const saveBackup = () => {", "\n  };", "saveBackup");
  assert(save.includes("if (!backupKey || !editable || !qRef.current) return;"), "a view-only page never writes one");
  assert(save.includes("try {") && save.includes("catch (_e)"), "storage can be blocked: try/catch");
  assert(save.includes("else if (ownBackupRef.current) { localStorage.removeItem(backupKey); ownBackupRef.current = false; }"), "cleared only by the page that wrote it");
  const offer = between(page, "const offerEarlier = (m) => {", "\n  };", "offerEarlier");
  assert(offer.includes("if (!backupKey || viewOnly || (m && m.guard)) return;"), "a view-only page never offers (or sends) a backup");
  assert(offer.includes("ssPgBackupLoad(raw, Date.now())") && offer.includes("localStorage.removeItem(backupKey)"), "older than 7 days or unreadable: dropped");
  const restore = between(page, "const saveEarlier = () => {", "\n  };", "saveEarlier");
  assert(restore.includes(`apply({ type: "restore", sizes: b.sizes, at: Date.now() });`), "Save them puts the stored edits back through the queue");
  assert(!/red/.test(restore.replace("keepRef.current = { sizes: null, red: earlierRed };", "")), "red entries never go back into the queue");
  // Rewritten on every change of the queue, and on every keystroke in the editor.
  assert(page.includes("useEffect(() => { fnRef.current.saveBackup(); }, [q, draftDirty, earlier, earlierRed]);"));
  assert(between(page, "const onEditInput = (e) => {", "\n  };", "onEditInput").includes("saveBackup();"));
  assert(page.includes("fnRef.current.offerEarlier(m);"), "the first load reads the backup before anything can write over it");
  assert(page.includes("You have 1 change from earlier that wasn't saved.") && page.includes("`You have ${earlier.count} changes from earlier that weren't saved.`"));
  assert(page.includes(">Save them</button>") && page.includes(">Discard</button>"));
});

// ── 10. Phase 4b: copy, paste, fill down, clear and the confirm ──────────────────────────────
Deno.test("paste, fill down and clear check the page can still edit and go through the queue in one event; copy works on a view-only page", () => {
  const page = fnText(CATALOG, "function PricingTablePage(");
  // Every way to change boxes in bulk refuses on a view-only page (?as=, no edit access, a 403, another
  // account's answer) and sends nothing.
  for (const fn of ["const pasteFrom = (e) => {\n    e.preventDefault();\n    if (!canEditNow()) return;", "const fillDown = () => {\n    if (!canEditNow()) return;",
    "const clearSel = () => {\n    if (!canEditNow()) return;", "const applyChange = (edits, area) => {\n    if (!canEditNow()) return;"]) {
    assert(page.includes(fn), `a bulk edit path without the view-only check: ${fn.split("\n")[0]}`);
  }
  const copy = between(page, "const copySel = (e) => {", "\n  };", "copySel");
  assert(!copy.includes("canEditNow"), "copy works on a view-only page too");
  assert(copy.includes(`e.clipboardData.setData("text/plain", ssPgToTsv(ssPgSelectionBlock(`), "the selection goes out as TSV, as drawn");
  const change = between(page, "const applyChange = (edits, area) => {", "\n  };", "applyChange");
  assert(change.includes(`apply({ type: "commits", edits, at: Date.now() });`) && change.includes("sendNow();") && change.includes("backToWork();"),
    "one queue event, sent at once, and a waiting leave is called off");
  assertEquals((page.match(/type: "commits"/g) || []).length, 1, "the only way in for a paste, a fill or a clear");
  // The planners decide; more than one size asks first.
  const propose = between(page, "const propose = (plan) => {", "\n  };", "propose");
  assert(propose.includes("if (!plan.ok) { setSaid({ tone: \"amber\", text: plan.error }); return; }"), "a refusal changes nothing and says why");
  assert(propose.includes("if (sum.ask) { setConfirm({ text: sum.text, edits: plan.edits, area: plan.area || null }); return; }"));
  assert(between(page, "const pasteFrom = (e) => {", "\n  };", "pasteFrom").includes("ssPgPastePlan(viewOf(), { sizeId: order[sel.r0], col: sel.c0 }, ssPgParseTsv(text))"));
  assert(between(page, "const fillDown = () => {", "\n  };", "fillDown").includes("ssPgFillPlan(viewOf(), selRect())"));
  assert(between(page, "const clearSel = () => {", "\n  };", "clearSel").includes("ssPgClearPlan(viewOf(), selRect())"));
  // Cancel changes nothing.
  assert(page.includes("const confirmNo = () => { setConfirm(null); focusGrid(); };"));
  assert(page.includes("{confirm && canEdit && <PgConfirm text={confirm.text} onYes={confirmYes} onNo={confirmNo} />}"), "the confirm goes if the page stops being able to edit");
});

Deno.test("the keys: Ctrl/Cmd+D fills down, held from the browser; Delete on a range clears; copy and paste are the browser's own events while the grid has the focus", () => {
  const page = fnText(CATALOG, "function PricingTablePage(");
  const keys = between(page, "const onKeyDown = (e) => {", "\n  };", "onKeyDown");
  const d = keys.indexOf(`if ((e.ctrlKey || e.metaKey) && !e.altKey && (k === "d" || k === "D")) { e.preventDefault(); fillDown(); return; }`);
  assert(d > 0 && d < keys.indexOf("if (e.altKey || e.ctrlKey || e.metaKey) return;"), "Ctrl+D must be handled before the modifier keys are let go (else it bookmarks the page)");
  assert(keys.includes(`if (k === "Delete" || k === "Backspace") { e.preventDefault(); if (!extentRef.current) clearCell(a); else clearSel(); return; }`));
  const fx = between(page, "  useEffect(() => {\n    const mine = () =>", "}, []);", "the copy and paste listeners");
  assert(fx.includes("const mine = () => !!gridRef.current && document.activeElement === gridRef.current;"), "only while the grid itself has the focus: the editor and the add strips paste their own way");
  assert(fx.includes(`document.addEventListener("copy", onCopy);`) && fx.includes(`document.addEventListener("paste", onPaste);`));
  assert(fx.includes(`document.removeEventListener("copy", onCopy);`) && fx.includes(`document.removeEventListener("paste", onPaste);`));
  // The toolbar's buttons are drawn only while the page can edit.
  const bar = between(page, "{canEdit && (\n          <>", "</>", "the toolbar's buttons");
  assert(bar.includes(">Fill down</button>") && bar.includes(">Clear</button>"));
});

Deno.test("PgConfirm: an accessible modal: every hook above its return, focus on Continue and kept inside, Escape cancels", () => {
  const sig = "function PgConfirm({ text, onYes, onNo }) {";
  const body = fnText(CATALOG, sig);
  const first = body.search(/\n  (?:return\b|if \()/);
  assert(first > 0 && hookAt(body).length >= 3, sig);
  assertEquals(hookAt(body).filter((i) => i > first), [], `${sig}: a hook below the first return`);
  assert(body.includes(`role="alertdialog" aria-modal="true" aria-labelledby="ss-pg-confirm-q"`) && body.includes(`<p id="ss-pg-confirm-q">{text}</p>`), "named by its own question");
  assert(body.includes("yesRef.current.focus({ preventScroll: true })"), "the focus goes into it");
  assert(body.includes(`if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onNo(); return; }`), "Escape is Cancel");
  assert(body.includes(`if (e.key === "Tab") {`), "Tab stays inside");
  assert(body.includes(">Cancel</button>") && body.includes(">Continue</button>"));
});
