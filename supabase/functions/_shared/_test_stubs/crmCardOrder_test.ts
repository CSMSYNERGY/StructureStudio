// Each person's order for the cards down the side of a contact or deal record, tested against the
// SHIPPED portal source.
//
// Carolyn, 2026-08-28 @39:00: "they can put their cards in the order that they want them, and
// they can have a different order under a contact, and a different order under a deal." My Profile
// saves client_users.prefs.cardOrder = { contact: [...keys], design: [...keys] }; CrmRecord reads it
// through crmOrderSections, and My Profile builds the list it saves with crmMergeCardOrder.
//
// The saved list outlives the build that wrote it, which is what these cases are about: a card
// added since (it has to turn up, at the bottom), a key this build has never heard of (ignored on
// screen, kept in its slot when an older tab saves), a card that only shows sometimes (Sales tax
// keeps its place), and the CRM_SECTIONS `kinds` tags agreeing with each card's `when`, because a
// card a kind can show but doesn't list can never be moved.
//
// Same technique as crmRecordGate_test: slice the real block between stable anchors, guard loudly
// if they move, run it.

import { assert, assertEquals } from "jsr:@std/assert";

const read = async (p: string) =>
  (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const SRC = await read("../../../../portal/02-sales.jsx");
const INTEG = await read("../../../../portal/08-integrations.jsx");
const SHELL = await read("../../../../portal/12-shell.jsx");
const SETTINGS = await read("../../portal-settings/index.ts");

const slice = (src: string, a: string, b: string, what: string) => {
  const i = src.indexOf(a);
  const j = i < 0 ? -1 : src.indexOf(b, i + a.length);
  if (i < 0 || j < 0) {
    throw new Error(
      `crmCardOrder_test: could not find ${what} (start=${i}, end=${j}). ` +
        "The anchors moved — re-point them rather than deleting this test.",
    );
  }
  return src.slice(i, j);
};

// crmContextDesign and crmSsQuoteDesign come along because the Sales tax card's `when` calls them;
// a hand-written stand-in could drift from the shipped resolver (crmRecordGate_test says why).
const BLOCK = slice(SRC, "function crmContextDesign(", "// The ACTION BAR", "the CRM_SECTIONS block");
for (const name of ["CRM_SECTIONS", "function crmOrderSections(", "function crmMergeCardOrder("]) {
  assert(BLOCK.includes(name), `extracted block is missing ${name}`);
}

type Ctx = Record<string, unknown>;
type Section = { key: string; title: string; kinds: string[]; when: (c: Ctx) => boolean; note?: string };
const { CRM_SECTIONS, crmOrderSections, crmMergeCardOrder } = new Function(
  `${BLOCK}; return { CRM_SECTIONS, crmOrderSections, crmMergeCardOrder };`,
)() as {
  CRM_SECTIONS: Section[];
  crmOrderSections: (visible: Section[], saved: unknown) => Section[];
  crmMergeCardOrder: (saved: unknown, known: string[]) => string[];
};

const keys = (list: Section[]) => list.map((s) => s.key);
const REGISTRY = keys(CRM_SECTIONS);

// A StructureStudio-issued quote, so the Sales tax card shows. On a contact it has to be picked.
const SS_DEAL = { short_code: "SS-AAAA1111", ss_quote_number: "SSQ-1001", ghl_estimate_number: null };
const contactCtx = (over: Ctx = {}): Ctx => ({
  kind: "contact", record: { id: "c1" }, designs: [SS_DEAL], selectedCode: null, ...over,
});
const designCtx = (over: Ctx = {}): Ctx => ({
  kind: "design", record: SS_DEAL, designs: [SS_DEAL], selectedCode: SS_DEAL.short_code, ...over,
});
const showing = (c: Ctx) => CRM_SECTIONS.filter((s) => s.when(c));
const ofKind = (kind: string) => CRM_SECTIONS.filter((s) => s.kinds.indexOf(kind) !== -1);

Deno.test("no saved order (null, empty, not a list) is the registry order", () => {
  const visible = showing(contactCtx());
  for (const saved of [null, undefined, [], "summary", { contact: ["overview"] }]) {
    assertEquals(keys(crmOrderSections(visible, saved)), keys(visible), JSON.stringify(saved));
  }
});

Deno.test("the saved keys that are showing come first, in saved order, then the rest in registry order", () => {
  const visible = showing(contactCtx());
  const got = keys(crmOrderSections(visible, ["overview", "repairs", "summary"]));
  assertEquals(got, ["overview", "repairs", "summary", "details", "deals", "salesPipelines", "orders", "build", "delivery"]);
});

Deno.test("a key this build doesn't know is ignored, and a repeated key draws its card once", () => {
  const visible = showing(contactCtx());
  const got = keys(crmOrderSections(visible, ["ghost", "overview", 42, "overview", "summary", "ghost"]));
  assertEquals(got[0], "overview");
  assertEquals(got[1], "summary");
  assertEquals(got.length, visible.length, "every card drawn exactly once");
  assertEquals(new Set(got).size, got.length);
  assert(!got.includes("ghost"));
});

Deno.test("a card added since the order was saved turns up at the bottom, not nowhere", () => {
  const visible = showing(contactCtx());
  // Saved before "repairs" existed, everything else reversed.
  const saved = keys(visible).filter((k) => k !== "repairs").reverse();
  const got = keys(crmOrderSections(visible, saved));
  assertEquals(got, [...saved, "repairs"]);
});

Deno.test("kind filtering: a deal-only key in a contact's list draws nothing, and the other way round", () => {
  const onContact = keys(crmOrderSections(showing(contactCtx()), ["person", "overview"]));
  assert(!onContact.includes("person"), "Person is a deal's card");
  assertEquals(onContact[0], "overview");
  const onDeal = keys(crmOrderSections(showing(designCtx()), ["deals", "orders", "build"]));
  assert(!onDeal.includes("deals") && !onDeal.includes("orders"), "Deals and Orders are a contact's cards");
  assertEquals(onDeal[0], "build");
});

Deno.test("a card that only shows sometimes keeps its saved place when it shows, and is skipped when it doesn't", () => {
  const saved = ["tax", "overview", "summary"];
  // Nothing picked on the contact: no Sales tax card.
  const unpicked = keys(crmOrderSections(showing(contactCtx()), saved));
  assert(!unpicked.includes("tax"));
  assertEquals(unpicked.slice(0, 2), ["overview", "summary"]);
  // The SS deal picked: Sales tax shows, at the top where it was put.
  const picked = keys(crmOrderSections(showing(contactCtx({ selectedCode: SS_DEAL.short_code })), saved));
  assertEquals(picked.slice(0, 3), ["tax", "overview", "summary"]);
});

Deno.test("`kinds` agrees with `when`: every card a kind can show is one My Profile lets you move", () => {
  for (const s of CRM_SECTIONS) {
    assert(Array.isArray(s.kinds) && s.kinds.length > 0, `${s.key} has no kinds`);
    for (const k of s.kinds) assert(k === "contact" || k === "design", `${s.key} has an unknown kind ${k}`);
  }
  // The richest context of each kind, so the conditional Sales tax card is showing too.
  const cases: [string, Ctx][] = [
    ["contact", contactCtx({ selectedCode: SS_DEAL.short_code })],
    ["design", designCtx()],
  ];
  for (const [kind, ctx] of cases) {
    for (const s of CRM_SECTIONS) {
      if (s.when(ctx)) assert(s.kinds.includes(kind), `${s.key} shows on a ${kind} but isn't listed for it`);
      else assert(!s.kinds.includes(kind), `${s.key} is listed for a ${kind} but never shows on one`);
    }
  }
});

Deno.test("the two lists My Profile shows", () => {
  assertEquals(keys(ofKind("contact")), ["summary", "details", "deals", "salesPipelines", "orders", "tax", "build", "delivery", "repairs", "overview"]);
  assertEquals(keys(ofKind("design")), ["summary", "details", "person", "tax", "build", "delivery", "repairs", "overview"]);
  // The only card that comes and goes says when it shows.
  const notes = CRM_SECTIONS.filter((s) => s.note).map((s) => s.key);
  assertEquals(notes, ["tax"]);
});

Deno.test("crmMergeCardOrder: nothing saved is the new order as it is", () => {
  const known = keys(ofKind("design")).reverse();
  for (const saved of [null, undefined, [], "x"]) assertEquals(crmMergeCardOrder(saved, known), known);
});

Deno.test("crmMergeCardOrder: a key this build doesn't know keeps its slot, the known keys fill the rest", () => {
  const saved = ["summary", "newer-card", "details", "build", "ghost"];
  const known = ["details", "summary", "build", "delivery"];
  // Slots 0, 2 and 3 were known; they take the new order. "delivery" was never saved, so it goes
  // on the end.
  assertEquals(crmMergeCardOrder(saved, known), ["details", "newer-card", "summary", "build", "ghost", "delivery"]);
});

Deno.test("crmMergeCardOrder: repeats and non-strings in the saved list are dropped", () => {
  const got = crmMergeCardOrder(["summary", 7, "summary", null, "ghost", "ghost"], ["details", "summary"]);
  assertEquals(got, ["details", "ghost", "summary"]);
});

Deno.test("crmMergeCardOrder then crmOrderSections round-trips: what is saved is what the record draws", () => {
  const visible = ofKind("contact");
  const arranged = keys(visible).reverse();
  for (const saved of [null, ["ghost", "overview"], keys(visible), ["deals", "zzz", "summary", "zzz"]]) {
    const stored = crmMergeCardOrder(saved, arranged);
    assertEquals(keys(crmOrderSections(visible, stored)), arranged, JSON.stringify(saved));
    for (const k of arranged) assert(stored.includes(k), `the stored list lost ${k}`);
  }
});

// ── The wiring, read off the shipped source ──────────────────────────────────────────────────
Deno.test("CrmRecord draws its cards through crmOrderSections, with the order for its own kind", () => {
  // The props, without pinning which one comes last: the next prop added would break that.
  const head = slice(SRC, "function CrmRecord(", "const [data, setData] = useState(null);", "CrmRecord's props");
  assert(/\bcardOrder = null[,\s}]/.test(head), "CrmRecord takes a cardOrder prop, null by default");
  assert(
    SRC.includes("crmOrderSections(CRM_SECTIONS.filter((s) => s.when(ctx)), cardOrder && cardOrder[kind]).map((s) => ("),
    "the section column is ordered by the reader's saved list",
  );
  assertEquals(SRC.split("CRM_SECTIONS.filter((s) => s.when(ctx))").length - 1, 1, "and nothing else draws the column");
});

Deno.test("the shell passes the signed-in person's order, and none in view-as", () => {
  assert(SHELL.includes("cardOrder={viewing ? null : ((tenant.prefs && tenant.prefs.cardOrder) || null)}"));
});

Deno.test("My Profile saves the full list for a kind with crmMergeCardOrder, through the one commit", () => {
  const card = slice(INTEG, "function MyProfileSettings(", "// (OptionsGroup lived here", "MyProfileSettings");
  assert(card.includes("CRM_SECTIONS.filter((s) => s.kinds.indexOf(kind) !== -1)"), "both lists come from the registry, by kind");
  assert(card.includes("crmMergeCardOrder(cardOrder[kind], keys)"), "a move saves the full merged list");
  assert(card.includes("await commit({ cardOrder: send })"), "through commit, which carries the other prefs");
  // ...the LATEST other prefs: commit spreads what the page last asked for (a ref), not the `prefs`
  // of the render the queue started in, which would put back a card saved mid-run (review 2026-10-05).
  assert(/prefsWant\.current = \{ \.\.\.prefsWant\.current, \.\.\.patch \};\s*const body = \{ action: "save_prefs", prefs: prefsWant\.current \};/.test(card),
    "commit spreads the latest asked-for prefs");
  assert(!card.includes("prefs: { ...(prefs || {}), ...patch }"), "commit spreads the render's stale prefs again");
  assert(card.includes("const kept = seedOrder(back);"), "and checks what the server kept");
  // A disabled arrow loses keyboard focus the moment its card reaches the end (see the card's
  // comment), so the ends are aria-disabled and moveCard ignores the step instead.
  assert(card.includes("aria-disabled={off}") && !card.includes(" disabled={off}"), "the arrows use aria-disabled, never disabled");
  assert(card.includes("if (i < 0 || j < 0 || j >= keys.length) return;"), "and a step past either end does nothing");
});

Deno.test("save_prefs still keeps cardOrder for both kinds", () => {
  const save = slice(SETTINGS, `if (action === "save_prefs") {`, `if (action === "save") {`, "save_prefs");
  assert(save.includes(`for (const k of ["contact", "design"])`), "both kinds are kept");
  assert(save.includes("clean.cardOrder = co;"), "and written back into the whitelist-rebuilt blob");
});
