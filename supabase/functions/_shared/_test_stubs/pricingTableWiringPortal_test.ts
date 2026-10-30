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
