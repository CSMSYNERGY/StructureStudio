// The CRM record page's tab gate, tested against the SHIPPED portal source.
//
// Why this test exists: portal-settings refuses every `crm_*` action without the CRM
// subscription, with ONE deliberate exception — `crm_record` when kind is "design", so the
// free Pipeline list's own rows still open. That exception meant a tenant without the CRM got
// the design record rendered in full: a live Notes box, an Activity form, Email, SMS and
// Customer Uploads, every one of which returned 403 on the first click. Carolyn, 2026-09-01:
// "I don't want them, if they are not paying for the CRM part in the billing, to be able to
// make these notes in any of this stuff here."
//
// The failure mode is SILENT in the way that matters — nothing throws, nothing logs, the
// button simply looks live and is not. A browser test would need a login on a tenant that
// does not hold the CRM; this pins the same rule at its source instead, so the browser and
// the server's crm_ prefix cannot drift apart without failing the push.
//
// Same technique as wallSlab_test / orderTotals_test: slice the real block between stable
// anchors, guard loudly if they move, run it.

import { assert, assertEquals } from "jsr:@std/assert";

const SRC = await Deno.readTextFile(
  new URL("../../../../portal/02-sales.jsx", import.meta.url),
);

const START = "const CRM_LOCKED_HINT =";
const END = "const CRM_CHIPS = [";
const i = SRC.indexOf(START);
const j = SRC.indexOf(END, i);
if (i < 0 || j < 0) {
  throw new Error(
    "crmRecordGate_test: could not find the CRM_TABS block in portal/02-sales.jsx " +
      `(start=${i}, end=${j}). The anchors moved — re-point them rather than deleting this test.`,
  );
}
const BLOCK = SRC.slice(i, j);

for (const name of ["CRM_LOCKED_HINT", "CRM_TABS", "crmUnlocked"]) {
  assert(BLOCK.includes(name), `extracted block is missing ${name}`);
}

type Ctx = Record<string, unknown>;
type Tab = {
  key: string;
  label: string;
  when?: (c: Ctx) => boolean;
  enabled: (c: Ctx) => boolean;
  hint?: string | ((c: Ctx) => string);
};

// `normStatus` lives in 01-core.jsx and only the Invoice tab reads it. Injected rather than
// sliced in: Invoice is send_invoice, NOT a crm_ action, and this test asserts it stays live.
const factory = new Function(
  "normStatus",
  `${BLOCK}; return { CRM_TABS, CRM_LOCKED_HINT, CRM_PICK_HINT };`,
);
const { CRM_TABS, CRM_LOCKED_HINT, CRM_PICK_HINT } = factory(
  (s: string) => String(s || "").toLowerCase(),
) as { CRM_TABS: Tab[]; CRM_LOCKED_HINT: string; CRM_PICK_HINT: (w: string) => string };

const ctxFor = (over: Ctx = {}): Ctx => ({
  kind: "design",
  record: { status: "accepted" },
  isAdmin: true,
  // What the shell now passes: canEdit is ALREADY `canEditProp && crmUnlocked`, so a locked
  // tenant arrives here with canEdit false. Both are set together on purpose — a fixture that
  // set only one would test a state the component cannot produce.
  canEdit: true,
  crmUnlocked: true,
  contact: { id: "c1", email: "a@b.com", phone: "+15555550123" },
  designs: [],
  sms: { ready: true, consented: true, optedOut: false },
  // A DESIGN record never needs a pick — it IS the deal. This default keeps every case above
  // testing exactly what it tested before the picker existed.
  selectedCode: "SS-AAAA1111",
  needsPick: false,
  ...over,
});

// A CONTACT record with nothing picked yet: everything held, everything permitted, and the
// five writable tabs still off because nobody has said WHICH building this is about.
const unpicked = (over: Ctx = {}) => ctxFor({
  kind: "contact", record: { id: "c1" }, selectedCode: null, needsPick: true, ...over,
});

const locked = () => ctxFor({ canEdit: false, crmUnlocked: false });

const tabsFor = (c: Ctx) => CRM_TABS.filter((t) => !t.when || t.when(c));
const tab = (key: string) => {
  const t = CRM_TABS.find((x) => x.key === key);
  assert(t, `CRM_TABS has no "${key}" tab — the tab was renamed or removed`);
  return t!;
};
const hintOf = (t: Tab, c: Ctx) => (typeof t.hint === "function" ? t.hint(c) : (t.hint || "Not available yet"));

// The tabs whose every write is a crm_* action portal-settings refuses without the
// subscription. Keep this list identical to the prefix's reach.
const CRM_ONLY = ["activity", "note", "sms", "email", "files"];

Deno.test("with the CRM, the writable tabs are all enabled", () => {
  const c = ctxFor();
  for (const key of CRM_ONLY) {
    assertEquals(tab(key).enabled(c), true, `${key} should be enabled for a paying tenant`);
  }
});

Deno.test("without the CRM, every crm_ tab is disabled", () => {
  const c = locked();
  for (const key of CRM_ONLY) {
    assertEquals(tab(key).enabled(c), false, `${key} must be disabled without the CRM`);
  }
});

Deno.test("without the CRM, each disabled tab blames the subscription, not the reader", () => {
  // An owner holds every permission there is. Telling them "you don't have permission" sends
  // them to Team looking for a switch that is not there, which is the whole point of a
  // separate hint.
  const c = locked();
  for (const key of CRM_ONLY) {
    const h = hintOf(tab(key), c);
    assertEquals(h, CRM_LOCKED_HINT, `${key} hint should name the subscription`);
    assert(!/permission/i.test(h), `${key} hint must not blame permissions`);
  }
});

Deno.test("the subscription hint points at Billing, matching the server's 403", () => {
  assert(/billing/i.test(CRM_LOCKED_HINT), "hint should send the reader to Billing");
  assert(/subscription/i.test(CRM_LOCKED_HINT), "hint should name the subscription");
});

Deno.test("a permission refusal still reads as a permission refusal when the CRM IS held", () => {
  // The regression guard for the fix itself: folding crmUnlocked into canEdit must not make
  // every disabled tab claim a billing problem. A rep without contacts:edit on a paying
  // tenant gets the old wording.
  const c = ctxFor({ canEdit: false, crmUnlocked: true });
  for (const key of ["activity", "note"]) {
    const h = hintOf(tab(key), c);
    assert(/permission/i.test(h), `${key} should still name permissions, got: ${h}`);
    assert(h !== CRM_LOCKED_HINT, `${key} must not claim a subscription problem`);
  }
});

Deno.test("Invoice is Simple Layout, not CRM, and survives the lock", () => {
  // send_invoice carries no crm_ prefix and is not gated by the subscription. Gating it here
  // would take away something the tenant already paid for.
  const t = tab("invoice");
  const c = locked();
  assert(!t.when || t.when(c), "invoice tab should still be offered on a design record");
  assertEquals(t.enabled(c), true, "invoice must stay enabled without the CRM");
});

Deno.test("the tabs that were never built stay off for a reason of their own", () => {
  const c = ctxFor();
  for (const key of ["scheduler", "call"]) {
    assertEquals(tab(key).enabled(c), false);
    assert(!/subscription/i.test(hintOf(tab(key), c)), `${key} is unbuilt, not unpaid`);
  }
});

Deno.test("locking removes no tab from the strip — they grey, they do not vanish", () => {
  // A tab that disappears teaches the reader the feature does not exist. Greyed-with-a-reason
  // is what makes the CRM discoverable to someone who has not bought it yet.
  const before = tabsFor(ctxFor()).map((t) => t.key);
  const after = tabsFor(locked()).map((t) => t.key);
  assertEquals(after, before);
});

Deno.test("SMS still distinguishes its four other reasons when the CRM is held", () => {
  const held = (over: Ctx) => hintOf(tab("sms"), ctxFor({ crmUnlocked: true, ...over }));
  assert(/permission/i.test(held({ canEdit: false })));
  assert(/no phone number/i.test(held({ contact: { id: "c1", email: "a@b.com" } })));
  assert(/predates contact records/i.test(held({ contact: { email: "a@b.com", phone: "+15555550123" } })));
  assert(/carrier registration/i.test(held({ sms: { ready: false } })));
});

// ── THE DEAL PICKER (Carolyn, 2026-09-02) ──────────────────────────────────────────────
// "there's three, four quotes in here. Which one the heck is it when I'm in a contact? ...
// you have to have one of these selected for anything to show up here ... Right now, it's
// Greek, you have no idea."
//
// Every one of these five writes carries a short_code. Filed against the wrong deal, a note
// about one customer's building lands in another's history — which is why the tab closes
// rather than the code being quietly sent as null, as it was before.

Deno.test("on a contact with no deal picked, exactly the five writable tabs close", () => {
  const c = unpicked();
  for (const key of CRM_ONLY) {
    assertEquals(tab(key).enabled(c), false, `${key} must be disabled until a deal is picked`);
  }
  // Nothing ELSE moves. scheduler/call were already off for their own reasons, and invoice is
  // a design-only tab that never sees a contact — a picker must not quietly change either.
  for (const t of tabsFor(c)) {
    if (CRM_ONLY.indexOf(t.key) === -1) {
      assertEquals(t.enabled(c), false, `${t.key} unexpectedly enabled on a contact`);
    }
  }
  assert(!tabsFor(c).some((t) => t.key === "invoice"), "invoice should not be offered on a contact");
});

Deno.test("picking a deal re-opens all five — the guard against over-gating", () => {
  const c = unpicked({ selectedCode: "SS-AAAA1111", needsPick: false });
  for (const key of CRM_ONLY) {
    assertEquals(tab(key).enabled(c), true, `${key} should re-enable once a deal is picked`);
  }
});

Deno.test("each closed tab says to pick a deal, and says why", () => {
  const c = unpicked();
  for (const key of CRM_ONLY) {
    const h = hintOf(tab(key), c);
    assert(/pick a deal or order/i.test(h), `${key} hint should ask for a pick, got: ${h}`);
    assert(h !== CRM_LOCKED_HINT, `${key} must not claim a subscription problem`);
    assert(!/permission/i.test(h), `${key} must not blame permissions`);
    // It names the consequence, not just the instruction. "Pick one" without "so it is filed
    // against the right one" reads as busywork.
    assert(/filed against the right one/i.test(h), `${key} hint should say why it matters`);
  }
});

Deno.test("HINT PRECEDENCE: subscription, then permission, then the tab's own data, then the pick", () => {
  // ⚠️ THE ORDER IS THE POINT, and it is exactly the sort of thing a later edit inverts
  // without noticing. needsPick goes LAST everywhere: if a contact has no email address,
  // picking a deal still leaves Email disabled, so leading with "pick a deal" would be a lie
  // by omission — it sends the reader off doing something that changes nothing. Every hint
  // must name a reason that is STILL TRUE after the reader acts on every reason above it.
  assertEquals(
    hintOf(tab("note"), unpicked({ canEdit: false, crmUnlocked: false })),
    CRM_LOCKED_HINT,
    "a locked tenant hears about the subscription, not the pick",
  );
  assert(
    /permission/i.test(hintOf(tab("note"), unpicked({ canEdit: false }))),
    "a reader without permission hears about permission, not the pick",
  );
  assert(
    /email address/i.test(hintOf(tab("email"), unpicked({ contact: { id: "c1", phone: "+15555550123" } }))),
    "a contact with no email hears about the address, not the pick",
  );
  assert(
    /phone number/i.test(hintOf(tab("sms"), unpicked({ contact: { id: "c1", email: "a@b.com" } }))),
    "a contact with no phone hears about the number, not the pick",
  );
  assert(
    /carrier registration/i.test(hintOf(tab("sms"), unpicked({ sms: { ready: false } }))),
    "an unregistered number is still its own reason, ahead of the pick",
  );
});

Deno.test("a DESIGN record is untouched by the picker", () => {
  // The free Pipeline list opens design records on tenants without the CRM. If a design
  // record could ever read needsPick true, this change would close tabs on a surface the
  // picker has nothing to do with.
  const c = ctxFor();
  assertEquals(c.needsPick, false);
  for (const key of CRM_ONLY) {
    assertEquals(tab(key).enabled(c), true, `${key} should be unaffected on a design record`);
  }
});

Deno.test("the pick hint names the thing being filed", () => {
  // One shared builder, five nouns — so the five cannot drift into five hand-written
  // sentences that slowly stop agreeing.
  assert(/\bnote\b/.test(CRM_PICK_HINT("note")));
  assert(/\btext\b/.test(CRM_PICK_HINT("text")));
  assert(/\bupload\b/.test(CRM_PICK_HINT("upload")));
});
