// A schedule row opens its CUSTOMER, tested against the SHIPPED portal source.
//
// Carolyn, 2026-08-28 @39:00, on the Build Schedule: "when I click this card here, it does the same
// thing as when I'm here, and I click the [contact] ... I think we'll do the same kind of structure
// from both the build schedule and the delivery schedule." Then: "We have a back button here. What
// happens when I hit the back button up here? I want to make sure that ... they function the same
// way."
//
//   1. schedCustomerDest (05-schedule.jsx): the contact record when there is a customer, the CRM and
//      Contacts; else the design's record when Pipeline is allowed; else nothing.
//   2. the shell's scheduleCustomerOpener, run with the REAL ssClampTab (01-core.jsx) for the job
//      titles that see a schedule: who gets which record, the deal picked on the contact record,
//      the record context's `from` pointing Back at the schedule, and no opener at all for a crew
//      member.
//   3. where each schedule was: kept per tab for today only, garbage and blocked storage ignored.
//   4. pins: the link sits in the popup header and not in the editor's canEdit block, both
//      schedules take and use the opener, both seed their view and week from storage, the shell
//      wires both, the record's Back honours the context's `from`, and the context rides in the
//      history entry (so the browser's Back onto the record restores it) instead of being spent.
//
// Same technique as tabClamp_test / crmCardOrder_test: slice the real blocks between stable
// anchors, guard loudly if they move, run them.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";

const read = async (p: string) =>
  (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const CORE = await read("../../../../portal/01-core.jsx");
const SCHED = await read("../../../../portal/05-schedule.jsx");
const SHELL = await read("../../../../portal/12-shell.jsx");

const slice = (src: string, a: string, b: string, what: string) => {
  const i = src.indexOf(a);
  const j = i < 0 ? -1 : src.indexOf(b, i + a.length);
  if (i < 0 || j < 0) {
    throw new Error(
      `schedOpenCustomer_test: could not find ${what} (start=${i}, end=${j}). ` +
        "The anchors moved — re-point them rather than deleting this test.",
    );
  }
  return src.slice(i, j);
};

// ─── The shipped pieces ────────────────────────────────────────────────────────────────────────
type Link = { code: string; contactId: string | null } | null | undefined;
type Reach = { crm: boolean; contacts: boolean; designs: boolean };
type Dest = { page: string; sub: string; contactId: string | null; code: string } | null;

const DEST_SRC = slice(SCHED, "function schedCustomerDest(", "// The customer's name as the way into their record.", "schedCustomerDest");
const schedCustomerDest = new Function(`${DEST_SRC}; return schedCustomerDest;`)() as (l: Link, r: Reach | null) => Dest;

// The clamp, exactly as tabClamp_test lifts it (window pinned to a production host).
const CLAMP_SRC = slice(CORE, "function ssIsBetaHost()", "const ACCENT =", "the clamp block");
const { ssClampTab } = new Function("window", `${CLAMP_SRC}; return { ssClampTab };`)(
  { location: { hostname: "app.structurestudiosuite.com" } },
) as { ssClampTab: (...a: unknown[]) => string };

const OPENER_SRC = slice(SHELL, "const scheduleCustomerOpener = (fromPage) => {", "// Mirrors portal-settings' own gate", "scheduleCustomerOpener");
type World = { crm?: boolean; isOperator?: boolean; canAdmin?: boolean; access?: Record<string, string> | null; supportView?: boolean };
function opener(w: World, fromPage = "build-schedule") {
  const did: { nav: unknown[][] } = { nav: [] };
  const make = new Function(
    "crmUnlocked", "isOperator", "canAdmin", "myAccess", "supportView", "ssClampTab", "schedCustomerDest", "navigate",
    `${OPENER_SRC}; return scheduleCustomerOpener;`,
  );
  const scheduleCustomerOpener = make(
    w.crm ?? true, w.isOperator ?? false, w.canAdmin ?? false, w.access ?? null, w.supportView ?? false, ssClampTab, schedCustomerDest,
    (...a: unknown[]) => did.nav.push(a),
  );
  return { open: scheduleCustomerOpener(fromPage) as null | ((l: Link) => null | (() => void)), did };
}

// Resolved access maps, as the status call hands them to the shell (access.ts PRESETS).
const OWNER = { designs: "edit", contacts: "edit", build_schedule: "edit", delivery_schedule: "edit" };
const SCHEDULER = { build_schedule: "edit", delivery_schedule: "edit", repairs: "edit", designs: "view", contacts: "view", inventory: "view", orders: "view" };
const OFFICE = { designer: "edit", designs: "edit", contacts: "edit", build_schedule: "view", delivery_schedule: "view", repairs: "view" };
const CREW_LEADER = { build_schedule: "edit", repairs: "edit", designs: "view", inventory: "view", orders: "view" };
const CREW_MEMBER = { build_schedule: "view", repairs: "view" };
const DRIVER = { delivery_schedule: "edit", inventory: "view", orders: "view" };
const CONTACTS_ONLY = { build_schedule: "view", contacts: "view" };
const OWN_DEALER = { build_schedule: "view", designs: "edit", contacts: "own" };

const C1 = "00000000-0000-4000-8000-0000000000c1";
const WITH = { code: "SS-AAAA1111", contactId: C1 };
const WITHOUT = { code: "SS-BBBB2222", contactId: null };

// ─── 1. Where a link goes ──────────────────────────────────────────────────────────────────────
Deno.test("schedCustomerDest: contact, else design, else nothing", () => {
  const all = { crm: true, contacts: true, designs: true };
  assertEquals(schedCustomerDest(WITH, all), { page: "contacts", sub: "c-" + C1, contactId: C1, code: WITH.code });
  assertEquals(schedCustomerDest(WITHOUT, all), { page: "designs", sub: "d-" + WITHOUT.code, contactId: null, code: WITHOUT.code });
  // No CRM, or no Contacts: the design's own record.
  assertEquals(schedCustomerDest(WITH, { ...all, crm: false })!.sub, "d-" + WITH.code);
  assertEquals(schedCustomerDest(WITH, { ...all, contacts: false })!.sub, "d-" + WITH.code);
  // Contacts but no Pipeline: the customer, and nothing for a design with no customer.
  assertEquals(schedCustomerDest(WITH, { crm: true, contacts: true, designs: false })!.sub, "c-" + C1);
  assertEquals(schedCustomerDest(WITHOUT, { crm: true, contacts: true, designs: false }), null);
  // Neither: nothing.
  assertEquals(schedCustomerDest(WITH, { crm: true, contacts: false, designs: false }), null);
  // Nothing to go on.
  for (const bad of [null, undefined, { code: "", contactId: C1 }, { contactId: C1 } as any, { code: 42, contactId: C1 } as any]) {
    assertEquals(schedCustomerDest(bad, all), null, JSON.stringify(bad));
  }
  assertEquals(schedCustomerDest(WITH, null), null);
});

// ─── 2. The shell's opener, for the people who see a schedule ──────────────────────────────────
Deno.test("an owner opens the customer's record on that deal, and Back goes to the schedule", () => {
  const { open, did } = opener({ canAdmin: true, access: OWNER }, "build-schedule");
  const click = open!(WITH)!;
  click();
  // ONE navigate, pushed (never a replace), carrying the deal and the way Back.
  assertEquals(did.nav, [["contacts", "c-" + C1, false, { deal: WITH.code, from: { page: "build-schedule", pageSub: null } }]]);
  // A design with no customer: its own record, no deal to pick, Back still to the schedule.
  const d = opener({ canAdmin: true, access: OWNER }, "delivery-schedule");
  d.open!(WITHOUT)!();
  assertEquals(d.did.nav, [["designs", "d-" + WITHOUT.code, false, { deal: null, from: { page: "delivery-schedule", pageSub: null } }]]);
});

Deno.test("no CRM: the design's record, for everyone, even with a customer", () => {
  const { open, did } = opener({ crm: false, canAdmin: true, access: OWNER });
  open!(WITH)!();
  assertEquals(did.nav.map((n) => n.slice(0, 2)), [["designs", "d-" + WITH.code]]);
  assertEquals((did.nav[0][3] as any).deal, null, "a deal was queued for a record that won't open");
});

Deno.test("each title that sees a schedule gets the record it may open, and a crew member gets none", () => {
  const dest = (access: Record<string, string>, link: Link, crm = true) => {
    const { open, did } = opener({ access, crm });
    if (!open) return "no opener";
    const click = open(link);
    if (!click) return "plain text";
    click();
    return did.nav[0][1];
  };
  assertEquals(dest(SCHEDULER, WITH), "c-" + C1);
  assertEquals(dest(OFFICE, WITH), "c-" + C1);
  assertEquals(dest(CREW_LEADER, WITH), "d-" + WITH.code);          // designs:'view', no contacts
  assertEquals(dest(OWN_DEALER, WITH), "c-" + C1);                   // 'own' reads (the server only links their own)
  assertEquals(dest(CONTACTS_ONLY, WITH), "c-" + C1);
  assertEquals(dest(CONTACTS_ONLY, WITHOUT), "plain text");          // no Pipeline, no customer: nothing to open
  assertEquals(dest(CONTACTS_ONLY, WITH, false), "no opener");       // and without the CRM, nothing at all
  assertEquals(dest(CREW_MEMBER, WITH), "no opener");
  assertEquals(dest(DRIVER, WITH), "no opener");
});

Deno.test("a support operator follows the builder's own rules; a platform operator opens everything", () => {
  const support = opener({ isOperator: true, canAdmin: false, supportView: true, access: CREW_LEADER });
  support.open!(WITH)!();
  assertEquals(support.did.nav.map((n) => n.slice(0, 2)), [["designs", "d-" + WITH.code]]);
  const op = opener({ isOperator: true, canAdmin: true, access: null });
  op.open!(WITH)!();
  assertEquals(op.did.nav.map((n) => n.slice(0, 2)), [["contacts", "c-" + C1]]);
});

Deno.test("a row without a customer_link gets no click", () => {
  const { open } = opener({ canAdmin: true, access: OWNER });
  assertEquals(open!(null), null);
  assertEquals(open!(undefined), null);
});

// ─── 3. Where each schedule was ────────────────────────────────────────────────────────────────
const VIEW_SRC = slice(SCHED, "const SCHED_VIEW_KEYS =", "// ── The WHEN filter", "the schedule view-state block");
function viewKit(storage: any) {
  return new Function("window", "ssLocalIso", `${VIEW_SRC}; return { SCHED_VIEW_KEYS, schedViewLoad, schedViewSave, schedViewPick };`)(
    { sessionStorage: storage },
    (d: Date) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"),
  ) as {
    SCHED_VIEW_KEYS: Record<string, string>;
    schedViewLoad: (k: string, today?: string) => Record<string, unknown>;
    schedViewSave: (k: string, s: Record<string, unknown>, today?: string) => void;
    schedViewPick: (s: unknown, k: string, ok: (v: unknown) => boolean, fb: unknown) => unknown;
  };
}
const memory = () => {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => (m.has(k) ? m.get(k)! : null), setItem: (k: string, v: string) => void m.set(k, String(v)) };
};

Deno.test("a schedule comes back on its view and week, the same day, in the same tab", () => {
  const s = memory();
  const k = viewKit(s);
  assertEquals(k.SCHED_VIEW_KEYS, { build: "ss.sched.build.view", delivery: "ss.sched.delivery.view" });
  k.schedViewSave(k.SCHED_VIEW_KEYS.build, { view: "table", calView: "month", cursorMs: 1790000000000 }, "2026-10-05");
  assertEquals(k.schedViewLoad(k.SCHED_VIEW_KEYS.build, "2026-10-05"), { view: "table", calView: "month", cursorMs: 1790000000000, day: "2026-10-05" });
  // The next morning it starts on this week again.
  assertEquals(k.schedViewLoad(k.SCHED_VIEW_KEYS.build, "2026-10-06"), {});
  // The two schedules keep their own.
  assertEquals(k.schedViewLoad(k.SCHED_VIEW_KEYS.delivery, "2026-10-05"), {});
  // It holds which view and which week, nothing else.
  assertEquals(Object.keys(JSON.parse(s.m.get(k.SCHED_VIEW_KEYS.build)!)).sort(), ["calView", "cursorMs", "day", "view"]);
});

Deno.test("garbage or blocked storage is ignored, never thrown", () => {
  const s = memory();
  const k = viewKit(s);
  for (const junk of ["{", "null", "42", '"week"', "[]"]) {
    s.m.set("ss.sched.build.view", junk);
    assertEquals(k.schedViewLoad("ss.sched.build.view", "2026-10-05"), {}, junk);
  }
  const blocked = viewKit({ getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("QuotaExceededError"); } });
  assertEquals(blocked.schedViewLoad("ss.sched.build.view"), {});
  blocked.schedViewSave("ss.sched.build.view", { view: "board" });   // does not throw
  // A value this build doesn't know falls back.
  const isView = (v: unknown) => ["calendar", "board", "table"].includes(v as string);
  assertEquals(k.schedViewPick({ view: "kanban" }, "view", isView, "calendar"), "calendar");
  assertEquals(k.schedViewPick({ view: "board" }, "view", isView, "calendar"), "board");
  assertEquals(k.schedViewPick({}, "cursorMs", Number.isFinite, 7), 7);
  assertEquals(k.schedViewPick(null, "cursorMs", Number.isFinite, 7), 7);
});

// ─── 4. Pins on the shipped wiring ─────────────────────────────────────────────────────────────
Deno.test("the build popup's link is in its header, outside the editor's canEdit block", () => {
  const editor = slice(SCHED, "function SchedJobEditor(", "\nfunction SchedStageEditor(", "SchedJobEditor");
  assert(!/customerOpener|SchedCustomerButton|customer_link/.test(editor), "the customer link moved inside SchedJobEditor (its form is canEdit-only)");
  assert(/dirtyRef\.current = dirty/.test(editor), "SchedJobEditor no longer reports unsaved edits");
  const modal = slice(SCHED, "const detailModal = () => {", "// ── The week as an ORDERED LIST", "the build popup");
  assert(/customerOpener && job\.customer_link \? customerOpener\(job\.customer_link\) : null/.test(modal), "the popup does not ask the opener for this job");
  assert(/<SchedCustomerButton [^>]*open=\{openCustomer\}/.test(modal), "the popup header has no customer link");
  assert(/beforeLeave=\{\(\) => !editorDirty\.current \|\| window\.confirm\(/.test(modal), "leaving with unsaved edits no longer asks");
  // The card click is still the popup (decisions 24/25; the crew drag relies on it).
  assert(/onClick=\{\(\) => setExpandedId\(open \? null : job\.id\)\}/.test(SCHED), "a card click no longer opens the popup");
});

Deno.test("both schedules take the opener and seed their view and week from where they were", () => {
  assert(/function BuildScheduleTab\(\{[^}]*customerOpener = null \}\)/.test(SCHED), "BuildScheduleTab lost customerOpener");
  assert(/function DeliveryScheduleTab\(\{[^}]*customerOpener = null \}\)/.test(SCHED), "DeliveryScheduleTab lost customerOpener");
  const build = slice(SCHED, "function BuildScheduleTab(", "const [crewFilter, setCrewFilter]", "BuildScheduleTab's view state");
  for (const k of ["view", "calView", "cursorMs"]) {
    assert(new RegExp(`schedViewLoad\\(SCHED_VIEW_KEYS\\.build\\), "${k}"`).test(build), `build ${k} is not seeded`);
  }
  assert(/schedViewSave\(SCHED_VIEW_KEYS\.build, \{ view, calView, cursorMs \}\)/.test(build), "build view state is not saved");
  const del = slice(SCHED, "function DeliveryScheduleTab(", "const [showWeekends, setShowWeekends]", "DeliveryScheduleTab's view state");
  for (const k of ["view", "weekOffset", "monthCursor", "calView"]) {
    assert(new RegExp(`schedViewLoad\\(SCHED_VIEW_KEYS\\.delivery\\), "${k}"`).test(del), `delivery ${k} is not seeded`);
  }
  assert(/schedViewSave\(SCHED_VIEW_KEYS\.delivery, \{ view, weekOffset, monthCursor, calView \}\)/.test(del), "delivery view state is not saved");
  // The Loads view's stop rows and the Table view both link the name.
  const uses = SCHED.match(/<SchedCustomerButton name=\{s\.customer_name\} code=\{s\.customer_link\.code\} open=\{stopCustomer\(s\)\} beforeLeave=\{leaveOk\} \/>/g) ?? [];
  assertEquals(uses.length, 2, "the Loads and Table views should each link a stop's customer");
});

Deno.test("the shell wires both schedules, and the record's Back honours the context's from", () => {
  assert(/<BuildScheduleTab [\s\S]{0,400}customerOpener=\{scheduleCustomerOpener\("build-schedule"\)\} \/>/.test(SHELL), "Build Schedule is not wired");
  assert(/<DeliveryScheduleTab [\s\S]{0,300}customerOpener=\{scheduleCustomerOpener\("delivery-schedule"\)\} \/>/.test(SHELL), "Delivery Schedule is not wired");
  assert(/onBack=\{\(\) => \(recordCtx && recordCtx\.sub === sub && recordCtx\.from\s*\? navigate\(recordCtx\.from\.page, recordCtx\.from\.pageSub \|\| null\)/.test(SHELL), "the record's Back ignores recordCtx.from");
  assert(/initialDeal=\{recordCtx && recordCtx\.sub === sub && sub\.charAt\(0\) === "c" \? \(recordCtx\.deal \|\| null\) : null\}/.test(SHELL), "the record mount does not pass the deal");
});

// The context lives in the HISTORY ENTRY (review 2026-10-05). An earlier draft spent it whenever
// `sub` moved, so Open in designer and then the browser's Back reopened the record with no deal and
// a Back to Contacts. These run the shipped navigate() and onPop's restore against a fake history.
Deno.test("the record context rides in the history entry, and every other navigation clears it", () => {
  assert(!/useEffect\(\(\) => \{\s*if \(record\w+ && sub !==/.test(SHELL), "a [sub] effect spends the record context again");
  const NAV_SRC = slice(SHELL, "const navigate = useCallback(", "}, []);", "navigate");
  const state: { ctx: unknown; tab: unknown; sub: unknown; entries: any[] } = { ctx: "unset", tab: null, sub: null, entries: [] };
  const fakeWindow = {
    history: {
      pushState: (s: unknown, _t: string, u: string) => state.entries.push({ s, u, replace: false }),
      replaceState: (s: unknown, _t: string, u: string) => state.entries.push({ s, u, replace: true }),
    },
  };
  const navigate = new Function(
    "useCallback", "wanted", "setRecordCtx", "setTab", "setSub", "ssPagePath", "window",
    `${NAV_SRC}}, []); return navigate;`,
  )(
    (f: unknown) => f, { current: "x" }, (v: unknown) => { state.ctx = v; }, (v: unknown) => { state.tab = v; },
    (v: unknown) => { state.sub = v; }, (p: string, s: string | null) => "/portal/" + p + (s ? "/" + s : ""), fakeWindow,
  ) as (...a: unknown[]) => void;
  const from = { page: "build-schedule", pageSub: null };
  navigate("contacts", "c-" + C1, false, { deal: WITH.code, from });
  const rec = { deal: WITH.code, from, sub: "c-" + C1 };
  assertEquals(state.ctx, rec);
  assertEquals(state.entries.pop(), { s: { page: "contacts", sub: "c-" + C1, rec }, u: "/portal/contacts/c-" + C1, replace: false });
  // Open in designer, the rail, a filter: no context, and the entry carries none.
  navigate("designer");
  assertEquals(state.ctx, null);
  assertEquals(state.entries.pop(), { s: { page: "designer", sub: null }, u: "/portal/designer", replace: false });
  navigate("conversations", "texts", true);
  assertEquals([state.ctx, state.entries.pop()!.s], [null, { page: "conversations", sub: "texts" }]);

  // Back/forward: restored from the entry it lands on, and only for the record it was captured for.
  const POP_SRC = slice(SHELL, "const st = window.history.state;\n      setRecordCtx(", ";\n", "onPop's restore");
  const restore = (entry: unknown, sub: string | null) => {
    let got: unknown = "unset";
    new Function("window", "p", "setRecordCtx", POP_SRC + ";")({ history: { state: entry } }, { sub }, (v: unknown) => { got = v; });
    return got;
  };
  assertEquals(restore({ page: "contacts", sub: "c-" + C1, rec }, "c-" + C1), rec);
  assertEquals(restore({ page: "contacts", sub: "c-" + C1, rec }, "c-other"), null);
  assertEquals(restore({ page: "contacts", sub: "c-" + C1 }, "c-" + C1), null);
  assertEquals(restore({}, "c-" + C1), null);          // a hand-pushed entry (the harness's go())
  assertEquals(restore(null, null), null);
});
