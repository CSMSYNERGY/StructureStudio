// The Contacts hub (Carolyn 2026-10-12), tested against the SHIPPED portal source.
//
// "Let's have one tab and we can have contacts, and we can have this instead of list is designs,
// and then we have pipelines." One sidebar item, Contacts, over a tab row: Contacts, Design list,
// then every pipeline in the account's order, at most five pipeline positions with the fifth a
// drop-down for the rest, and never a scroll bar.
//
//   1. ssParsePath / ssCanonRoute (01-core): every old address lands in the hub, the Settings
//      "pipelines" page and every other page untouched.
//   2. ssSavedHubView (01-core): the person's own pick, and the old Pipeline tab's choice honoured.
//   3. ssHubResolve (02-sales): which tab shows for whom — the first pipeline with the CRM, the
//      Design list without it or for a designs-only role, a padlocked card for an address that
//      asked for the CRM's, a wait (never a flash of the wrong tab) while the CRM answer is out.
//   4. ssHubFit (02-sales): how many pipeline tabs fit inline; the rest go in the drop-down.
//   5. pins on the wiring: no Pipeline nav item, the hub mounted under Contacts, records inside it,
//      the board's picker hidden when hosted, the old toggle gone, My Profile saving contactsView.
//
// Same technique as tabClamp_test / schedOpenCustomer_test: slice the real blocks between stable
// anchors, guard loudly if they move, run them.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";

const read = async (p: string) =>
  (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const CORE = await read("../../../../portal/01-core.jsx");
const SALES = await read("../../../../portal/02-sales.jsx");
const SHELL = await read("../../../../portal/12-shell.jsx");
const INTEG = await read("../../../../portal/08-integrations.jsx");

const slice = (src: string, a: string, b: string, what: string) => {
  const i = src.indexOf(a);
  const j = i < 0 ? -1 : src.indexOf(b, i + a.length);
  if (i < 0 || j < 0) {
    throw new Error(
      `contactsHub_test: could not find ${what} (start=${i}, end=${j}). ` +
        "The anchors moved — re-point them rather than deleting this test.",
    );
  }
  return src.slice(i, j);
};

// ─── The shipped pieces ────────────────────────────────────────────────────────────────────────
const ROUTE_SRC = slice(CORE, "const SS_TAB_ALIASES =", "// Is this deployment a beta/preview surface?", "the router");
const SAVED_SRC = slice(CORE, "function ssSavedDesignsView(", "// What an operator may tag a setup step with.", "ssSavedHubView");
const HUB_SRC = slice(SALES, "const SS_HUB_MAX_PIPES = 5;", "// The account's pipelines, for the tab row and for My Profile's picker.", "the hub's rules");

type Route = { page: string | null; sub: string | null };
function parse(pathname: string): Route {
  return new Function("window", `${ROUTE_SRC}; return ssParsePath();`)({ location: { pathname } }) as Route;
}
const K = new Function(`${ROUTE_SRC}; ${SAVED_SRC}; ${HUB_SRC};
  return { ssCanonRoute, ssHubPipeId, ssSavedHubView, ssHubResolve, ssHubFit, ssHubPipes, SS_HUB_MAX_PIPES };`)() as any;

const A = "0f7c4b2e-8a1d-4c3b-9e6f-2a5d7c8b9e01";
const B = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const C = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
const PIPES = [{ id: A, name: "Shed Deals" }, { id: B, name: "Manufacturer Outreach" }];
const ALL = { people: true, designs: true };
const CREW_LEADER = { people: false, designs: true };
const CONTACTS_ONLY = { people: true, designs: false };

// ─── 1. Every old address lands in the hub ─────────────────────────────────────────────────────
Deno.test("old Pipeline, Leads and Contacts addresses all land in the hub, on the view they meant", () => {
  // Each address at its ROOT form (the app's address since 2026-10-13) AND with the old /portal in
  // front, which the router still reads for any address no host redirected.
  const cases: [string, Route][] = [
    ["/contacts", { page: "contacts", sub: null }],
    ["/contacts/people", { page: "contacts", sub: "people" }],
    ["/contacts/designs", { page: "contacts", sub: "designs" }],
    ["/contacts/p-" + A, { page: "contacts", sub: "p-" + A }],
    ["/contacts/c-" + B, { page: "contacts", sub: "c-" + B }],
    // The separate Pipeline page, every one of its views, and its record links.
    ["/designs", { page: "contacts", sub: null }],
    ["/designs/list", { page: "contacts", sub: "designs" }],
    ["/designs/pipeline", { page: "contacts", sub: "pipeline" }],
    ["/designs/people", { page: "contacts", sub: "people" }],
    ["/designs/deals", { page: "contacts", sub: null }],
    ["/designs/d-SS-ABCD2345", { page: "contacts", sub: "d-SS-ABCD2345" }],
    ["/designs/c-" + A, { page: "contacts", sub: "c-" + A }],
    ["/designs/billing", { page: "contacts", sub: null }],
    ["/designs/constructor", { page: "contacts", sub: null }],
    // The Leads tab's board (migration 301): the pipeline it named, or the board.
    ["/pipelines", { page: "contacts", sub: "pipeline" }],
    ["/pipelines/" + A.toUpperCase(), { page: "contacts", sub: "p-" + A }],
    ["/pipelines/not-a-pipeline", { page: "contacts", sub: "pipeline" }],
    // The pre-09-02 Contacts address.
    ["/leads", { page: "contacts", sub: null }],
    ["/leads/c-" + A, { page: "contacts", sub: "c-" + A }],
    // Untouched: Settings → Pipelines is a settings page, and every other page keeps its address.
    ["/settings/pipelines", { page: "settings", sub: "pipelines" }],
    ["/settings/myview", { page: "settings", sub: "myprofile" }],
    ["/orders/o-12", { page: "orders", sub: "o-12" }],
    ["/releases/mine", { page: "support", sub: "mine" }],
    ["/designer", { page: "designer", sub: null }],
  ];
  for (const [path, want] of cases) {
    assertEquals(parse(path), want, path);
    assertEquals(parse("/portal" + path), want, "/portal" + path);
  }
  // The bare app address, both shapes, and the file itself: no page in it.
  for (const path of ["/login", "/portal", "/portal.html", "/"]) assertEquals(parse(path), { page: null, sub: null }, path);
  // The Admin page: /console now (and /portal/admin before); /admin is admin.html, never the app's.
  assertEquals(parse("/console/clients"), { page: "admin", sub: "clients" });
  assertEquals(parse("/portal/admin/clients"), { page: "admin", sub: "clients" });
  assertEquals(parse("/admin"), { page: null, sub: null });
});

Deno.test("the app writes root addresses and heals an old /portal one to the same place", () => {
  const R = new Function("window", `${ROUTE_SRC}; return { ssRootPath, ssPageBase, ssPagePath };`)({ location: { pathname: "/", search: "?view=acme" } }) as any;
  assertEquals(R.ssPagePath("contacts", "p-" + A), "/contacts/p-" + A + "?view=acme");
  assertEquals(R.ssPageBase("admin", "clients"), "/console/clients");
  assertEquals(R.ssPageBase(null, "x"), "/login");
  for (const [from, to] of [["/portal", "/login"], ["/portal/", "/login"], ["/portal.html", "/login"],
    ["/portal/contacts/c-" + B, "/contacts/c-" + B], ["/portal/admin", "/console"], ["/portal/admin/clients", "/console/clients"],
    ["/portal/designs/list", "/designs/list"]]) assertEquals(R.ssRootPath(from), to, from);
  for (const p of ["/", "/login", "/contacts", "/console", "/portalx", "/my-quotes"]) assertEquals(R.ssRootPath(p), null, p);
});

Deno.test("ssCanonRoute maps an old page id the shell is handed, and nothing else", () => {
  assertEquals(K.ssCanonRoute("designs", "d-SS-ABCD2345"), { page: "contacts", sub: "d-SS-ABCD2345" });
  assertEquals(K.ssCanonRoute("designs", null), { page: "contacts", sub: null });
  assertEquals(K.ssCanonRoute("pipelines", B), { page: "contacts", sub: "p-" + B });
  for (const [p, s] of [["contacts", "people"], ["orders", null], ["settings", "pipelines"], ["conversations", "texts"]]) {
    assertEquals(K.ssCanonRoute(p, s), { page: p, sub: s });
  }
  assertEquals(K.ssHubPipeId("p-" + A.toUpperCase()), A);
  for (const bad of [null, "", "p-", "p-12", "pipeline", "people", "x-" + A]) assertEquals(K.ssHubPipeId(bad), null, String(bad));
});

// ─── 2. The person's own pick ──────────────────────────────────────────────────────────────────
Deno.test("ssSavedHubView: contactsView, else the old Pipeline tab's choice, else never picked", () => {
  const v = (prefs: unknown) => K.ssSavedHubView({ prefs });
  assertEquals(v({ contactsView: "people" }), "people");
  assertEquals(v({ contactsView: "designs" }), "designs");
  assertEquals(v({ contactsView: "p-" + A }), "p-" + A);
  // The old Pipeline tab's choice: its list is the Design list, its board is the board.
  assertEquals(v({ designsView: "list" }), "designs");
  assertEquals(v({ designsView: "pipeline" }), "pipeline");
  assertEquals(v({ contactsView: "people", designsView: "list" }), "people", "the new pick wins");
  for (const p of [null, {}, { contactsView: "junk" }, { contactsView: "p-12" }, { designsView: "board" }]) assertEquals(v(p), null, JSON.stringify(p));
  assertEquals(K.ssSavedHubView("none"), null);
  assertEquals(K.ssSavedHubView(null), null);
});

// ─── 3. Which tab shows ────────────────────────────────────────────────────────────────────────
const resolve = (o: Record<string, unknown>) =>
  K.ssHubResolve({ sub: null, saved: null, reach: ALL, crm: true, crmKnown: true, pipelines: PIPES, remembered: null, ...o });

Deno.test("with the CRM and nothing picked, Contacts opens on the first pipeline (C24)", () => {
  assertEquals(resolve({}), { view: "pipe", pipeId: A, canon: "p-" + A });
});

Deno.test("without the CRM, or for a designs-only role, it opens on the Design list (C14, C24)", () => {
  assertEquals(resolve({ crm: false }), { view: "designs", canon: "designs" });
  assertEquals(resolve({ reach: CREW_LEADER }), { view: "designs", canon: "designs" });
  assertEquals(resolve({ reach: CREW_LEADER, crm: false }), { view: "designs", canon: "designs" });
  // A crew leader never gets the contact list or a board, even by address or by a saved pick.
  for (const sub of ["people", "pipeline", "p-" + A]) {
    assertEquals(resolve({ reach: CREW_LEADER, sub }), { view: "designs", canon: "designs" }, sub);
    assertEquals(resolve({ reach: CREW_LEADER, saved: sub }), { view: "designs", canon: "designs" }, sub);
  }
  // With the CRM but no pipeline at all yet: the Design list too.
  assertEquals(resolve({ pipelines: [] }), { view: "designs", canon: "designs" });
});

Deno.test("an address asking for the CRM's tabs without it gets the card that sells it", () => {
  assertEquals(resolve({ crm: false, sub: "people" }), { view: "locked", canon: "people" });
  assertEquals(resolve({ crm: false, sub: "pipeline" }), { view: "locked", canon: "pipeline" });
  assertEquals(resolve({ crm: false, sub: "p-" + A }), { view: "locked", canon: "pipeline" });
  // A contacts-only role without the CRM has nothing else to show.
  assertEquals(resolve({ crm: false, reach: CONTACTS_ONLY }), { view: "locked", canon: "people" });
  // ...but a SAVED pick of one falls back quietly to the Design list (no card nobody asked for).
  assertEquals(resolve({ crm: false, saved: "people" }), { view: "designs", canon: "designs" });
  assertEquals(resolve({ crm: false, saved: "p-" + A }), { view: "designs", canon: "designs" });
});

Deno.test("while the CRM answer is out it waits, and never paints the Design list first", () => {
  assertEquals(resolve({ crm: false, crmKnown: false }), { view: "loading", canon: null });
  assertEquals(resolve({ crm: false, crmKnown: false, saved: "p-" + A }), { view: "loading", canon: null });
  // An address that named a CRM tab keeps its address while it waits.
  assertEquals(resolve({ crm: false, crmKnown: false, sub: "people" }), { view: "loading", canon: "people" });
  // The Design list needs no CRM answer, and a designs-only role never waits for one.
  assertEquals(resolve({ crm: false, crmKnown: false, sub: "designs" }), { view: "designs", canon: "designs" });
  assertEquals(resolve({ crm: false, crmKnown: false, reach: CREW_LEADER }), { view: "designs", canon: "designs" });
  // With the CRM, the pipelines still loading: wait for the first one rather than guess.
  assertEquals(resolve({ pipelines: null }), { view: "loading", canon: null });
});

Deno.test("the person's own pick wins over the default (C25), and the address over both", () => {
  assertEquals(resolve({ saved: "people" }), { view: "people", canon: "people" });
  assertEquals(resolve({ saved: "designs" }), { view: "designs", canon: "designs" });
  assertEquals(resolve({ saved: "p-" + B }), { view: "pipe", pipeId: B, canon: "p-" + B });
  assertEquals(resolve({ saved: "designs", sub: "p-" + B }), { view: "pipe", pipeId: B, canon: "p-" + B });
  assertEquals(resolve({ saved: "p-" + B, sub: "people" }), { view: "people", canon: "people" });
  // A picked pipeline that has since been removed: the default, not an empty board.
  assertEquals(resolve({ saved: "p-" + C }), { view: "pipe", pipeId: A, canon: "p-" + A });
});

Deno.test("an address names its pipeline at once, and one that is gone falls back to the default", () => {
  // Named before the list has answered: shown straight away (the board loads its own).
  assertEquals(resolve({ sub: "p-" + B, pipelines: null }), { view: "pipe", pipeId: B, canon: "p-" + B });
  // The list has answered and it isn't there.
  assertEquals(resolve({ sub: "p-" + C }), { view: "pipe", pipeId: A, canon: "p-" + A });
  // Junk: the default, and the address is put right.
  assertEquals(resolve({ sub: "nonsense" }), { view: "pipe", pipeId: A, canon: "p-" + A });
});

Deno.test("\"the board\" is the pipeline picked last, else the first", () => {
  assertEquals(resolve({ sub: "pipeline", remembered: B }), { view: "pipe", pipeId: B, canon: "p-" + B });
  assertEquals(resolve({ sub: "pipeline", remembered: C }), { view: "pipe", pipeId: A, canon: "p-" + A });
  assertEquals(resolve({ sub: "pipeline" }), { view: "pipe", pipeId: A, canon: "p-" + A });
  assertEquals(resolve({ sub: "pipeline", pipelines: null }), { view: "loading", canon: null });
  // The old Pipeline tab's "board" choice behaves the same.
  assertEquals(resolve({ saved: "pipeline", remembered: B }), { view: "pipe", pipeId: B, canon: "p-" + B });
});

Deno.test("nobody who may open neither list is shown either", () => {
  assertEquals(resolve({ reach: { people: false, designs: false } }), { view: "none", canon: null });
});

Deno.test("ssHubPipes keeps the account's order and what a tab needs", () => {
  assertEquals(K.ssHubPipes([{ id: A.toUpperCase(), name: "Shed Deals", stages: [] }, null, { name: "no id" }, { id: B }]),
    [{ id: A, name: "Shed Deals" }, { id: B, name: "Pipeline" }]);
  assertEquals(K.ssHubPipes(undefined), []);
});

// ─── 4. How many pipeline tabs fit ─────────────────────────────────────────────────────────────
// Widths in px. Contacts + Design list = 220; every pipeline tab 150; the ▾ 30; gap 2.
const fit = (n: number, avail: number, activeIdx = -1, widths: number[] | null = null) =>
  K.ssHubFit({ avail, fixedW: 220, pipeW: widths ?? Array.from({ length: n }, () => 150), caretW: 30, activeIdx });

Deno.test("five pipelines or fewer: all of them, when there is room (C27)", () => {
  assertEquals(K.SS_HUB_MAX_PIPES, 5);
  assertEquals(fit(2, 1400), 2);
  assertEquals(fit(3, 1400), 3);
  assertEquals(fit(5, 1400), 5);
});

Deno.test("more than five: four tabs and the fifth is the drop-down, however wide the screen (C27)", () => {
  assertEquals(fit(6, 4000), 4);
  assertEquals(fit(8, 4000), 4);
  assertEquals(fit(30, 4000), 4);
});

Deno.test("a narrow row folds more into the drop-down instead of scrolling (C29)", () => {
  // 3 pipelines need 220 + 3*152 = 676. At 600 only two fit beside a drop-down: 220 + 2*152 + 150 + 30 + 2 = 706 > 600,
  // one fits: 220 + 152 + 182 = 554.
  assertEquals(fit(3, 676), 3);
  assertEquals(fit(3, 675), 1);
  assertEquals(fit(3, 600), 1);
  // 8 pipelines at 1280 (the row ~1000 wide): 220 + 4*152 + 182 = 1010 > 1000, three fit.
  assertEquals(fit(8, 1000), 3);
  assertEquals(fit(8, 1010), 4);
  // Nothing fits beside the fixed tabs: everything in the drop-down.
  assertEquals(fit(3, 300), 0);
  assertEquals(fit(8, 100), 0);
});

Deno.test("the drop-down wears the open pipeline's name, so ITS width is what must fit", () => {
  const widths = [150, 150, 150, 150, 150, 400, 150, 150];
  // Nothing from the drop-down open: it shows the fifth (150 wide), four fit at 1010.
  assertEquals(fit(8, 1010, -1, widths), 4);
  // The 400-wide sixth one open: four no longer fit beside it.
  assertEquals(fit(8, 1010, 5, widths), 2);
  // An inline one open changes nothing.
  assertEquals(fit(8, 1010, 1, widths), 4);
});

// ─── 5. Pins on the wiring ─────────────────────────────────────────────────────────────────────
Deno.test("one sidebar item: Contacts, and no Pipeline", () => {
  assert(SHELL.includes('{navItem("contacts", "Contacts")}'), "the Contacts item is gone");
  assert(!/navItem\("designs"/.test(SHELL), "the Pipeline item is back in the sidebar");
  const meta = slice(CORE, "const TAB_META = {", "\n};", "TAB_META");
  assert(/\n {2}contacts: \["Contacts", "[^"]+"\],/.test(meta), "TAB_META has no Contacts page");
  assert(!/\n {2}designs: \[/.test(meta) && !/\n {2}pipelines: \[/.test(meta), "Pipeline is a page of its own again");
  const area = slice(CORE, "const TAB_AREA = {", "};", "TAB_AREA");
  assert(/\n {2}contacts: \["contacts", "designs"\],/.test(area), "the hub must open with either area");
});

Deno.test("the hub is mounted under Contacts, with records opening inside it", () => {
  assert(/\{!gateLocked && activeTab === "contacts" && !\(sub && \/\^\[cd\]-\/\.test\(sub\)\) && \(\s*<ContactsHub /.test(SHELL), "the hub is not mounted");
  assert(/!gateLocked && activeTab === "contacts" && sub && \/\^\[cd\]-\/\.test\(sub\) \? \(\s*<CrmRecord/.test(SHELL), "records do not open under Contacts");
  assert(!/activeTab === "designs"/.test(SHELL), "something still renders under the old Pipeline page");
  // A card or a Design list row opens the record with the hub tab it came from as its Back (C22).
  const open = slice(SHELL, "const hubOpenRecord = (code, contactId, fromSub, dealId) => {", "\n  };", "hubOpenRecord");
  assert(open.includes('const from = { page: "contacts", pageSub: fromSub || null };'), "the record's Back loses the hub tab");
  assert(open.includes('navigate("contacts", "c-" + contactId, false, { deal: code || dealId || null, from })'), "a card does not open its customer on the deal");
  assert(open.includes('navigate("contacts", "d-" + code, false, { from })'), "a design without a customer does not open its record");
  assert(!open.includes('"d-" + dealId') && !open.includes('"d-" + (code || dealId)'), "a lead card's id is used as a design address");
  assert(/onOpenRecord=\{\(code, contactId, dealId\) => onOpenRecord\(code, contactId, fromPipe, dealId\)\}/.test(SALES), "a board card does not say which pipeline it came from");
  // A lead card has no short code, so it names its customer's deal by the card id (C22).
  assert(SALES.includes("onOpenRecord(d.short_code || null, d.contact_id || null, d.id)"), "a lead card opens its customer with nothing picked");
  assert(SHELL.includes("onOpenRecord={(code, contactId) => hubOpenRecord(code, contactId, SS_HUB_DESIGNS)}"), "a Design list row does not say it came from there");
  // The navigate() every caller goes through maps the old page ids (the schedules' "designs").
  const nav = slice(SHELL, "const navigate = useCallback(", "}, []);", "navigate");
  assert(nav.includes("const canon = ssCanonRoute(page, nextSub);"), "navigate() no longer maps old page ids");
});

Deno.test("the board's own picker hides when the hub hosts it, and the old toggle is gone", () => {
  assert(/\{pipelines\.length > 0 && !hosted && \(\s*<select aria-label="Pipeline"/.test(SALES), "the pipeline <select> still shows inside the hub");
  assert(/<SalesPipelines embedded hosted clientId=\{clientId\}/.test(SALES), "the hub does not host the board");
  assert(/if \(onPipelines\) onPipelines\(m\.pipelines \|\| \[\]\);/.test(SALES), "a pipeline added on the board does not reach the tab row");
  const designs = slice(SALES, "function DesignsTable(", "\nfunction ", "DesignsTable");
  assert(!designs.includes('[["list", "List"], ["pipeline", "Pipeline"]]'), "the List | Pipeline toggle is back");
  assert(!designs.includes("<SalesPipelines"), "the Design list draws a board again");
  assert(SALES.includes('fixed.push({ id: SS_HUB_DESIGNS, label: "Design list" });'), "the tab is not called Design list (C23)");
});

Deno.test("My Profile saves which tab Contacts opens on, through the one commit", () => {
  const card = slice(INTEG, "function MyProfileSettings(", "\n}\n", "MyProfileSettings");
  assert(card.includes("const [picked, setVal] = useState(ssSavedHubView({ prefs }));"), "the card does not start on the saved pick");
  assert(card.includes("await commit({ contactsView: next, designsView: mirror })"), "the pick is not saved as contactsView");
  assert(card.includes("ssHubResolve({ sub: null, saved: picked, reach,"), "the card does not use the hub's own rule");
  assert(card.includes("How the Contacts tab opens"), "the card is not named for the Contacts tab");
  assert(INTEG.includes("clientId={clientId} hubReach={hubReach} />}"), "Settings does not hand My Profile the hub's reach");
  assert(SHELL.includes("hubReach={hubReach}"), "the shell does not hand Settings the hub's reach");
});
