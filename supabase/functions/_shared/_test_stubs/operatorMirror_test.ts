// Operator view-as mirrors the builder, pinned against the SHIPPED sources.
//
// Carolyn, 2026-09-15: "when I access another account as an operator or admin that account
// should show for me exactly as it shows for that user. if there are parts of the software
// they haven't paid for and it isn't accessible for them, then it shouldn't be accessible to
// me either in their account."
//
// Until that day the portal shell carried an `isOperator ||` blanket over every paid add-on
// (featureOn), the 3D grant (view3dUnlocked) and the billing lock (gateLocked was `!viewing`),
// and portal-settings carried an `entitlementExempt` flag that waved platform operators past
// the server-side RTP / CRM / QuickBooks checks. Each of those is one short token that a
// future "operators need to fix things" change would put straight back — silently, because
// nothing throws when an operator sees more than the builder does. These tests make that a
// failed push instead. Same technique as tabClamp_test / crmRecordGate_test: lifted from the
// source, so a drift fails rather than a copy going stale.

import { assert } from "jsr:@std/assert";

const SHELL = await Deno.readTextFile(
  new URL("../../../../portal/12-shell.jsx", import.meta.url),
);
const SETTINGS = await Deno.readTextFile(
  new URL("../../portal-settings/index.ts", import.meta.url),
);

/** The slice of Dashboard between two anchors, with comment lines stripped so a comment that
 *  NAMES the old blanket (to say it is gone) cannot fail the test the way the code would. */
function codeBetween(src: string, start: string, end: string, label: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i);
  if (i < 0 || j < 0) {
    throw new Error(
      `operatorMirror_test: could not find the ${label} block ` +
        `(start=${i}, end=${j}). The anchors moved — re-point them rather than deleting this test.`,
    );
  }
  return src.slice(i, j).split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
}

Deno.test("the mirror fetch runs for EVERY operator in view-as, not only support", () => {
  const block = codeBetween(SHELL, "const mirrorView = !!viewing;", "// Keep the address bar honest", "viewedCtx effect");
  assert(block.includes("if (!mirrorView) { setViewedCtx(null); return; }"), "viewedCtx effect must key on mirrorView");
  assert(!block.includes("if (!supportView)"), "viewedCtx effect has gone back to support-only");
});

Deno.test("view3dUnlocked reads the viewed tenant's grant, with no operator blanket", () => {
  const block = codeBetween(SHELL, "const view3dUnlocked =", "const effClientId =", "view3dUnlocked");
  assert(block.includes("viewedCtx.entitlement.granted"), "must read the viewed tenant's granted list");
  assert(!/isOperator\s*\|\|/.test(block), "view3dUnlocked has grown an `isOperator ||` blanket again");
});

Deno.test("gateLocked and featureOn read gateEnt / viewedCtx, with no operator blanket", () => {
  const block = codeBetween(SHELL, "const gateEnt =", "const schedUnlocked =", "gateEnt/featureOn");
  assert(block.includes("const gateEnt = viewing ? (viewedCtx ? viewedCtx.entitlement : null) : entitlement;"));
  assert(block.includes("const gateLocked = !!gateEnt && gateEnt.locked;"));
  assert(!block.includes("!viewing"), "a `!viewing` escape hatch is back in the gate block");
  assert(!/isOperator\s*\|\|/.test(block), "featureOn has grown an `isOperator ||` blanket again");
});

Deno.test("the grace / transition banners read the viewed tenant's entitlement too", () => {
  const block = codeBetween(SHELL, "const gateGrace =", "const billingActor =", "banners");
  assert(!block.includes("!viewing"), "a banner is `!viewing`-gated again");
  assert(!/[^.]\bentitlement\./.test(block), "a banner reads the operator's own entitlement instead of gateEnt");
});

Deno.test("the operator consoles stay reachable from a locked tenant", () => {
  assert(
    SHELL.includes('const gateLockedFor = (id) => gateLocked && id !== "accounts" && id !== "admin" && id !== "projects";'),
    "gateLockedFor must exempt exactly the three operator consoles",
  );
  assert(
    /\{activeTab === "accounts" && isOperator && \(/.test(SHELL) && !/!gateLocked && activeTab === "accounts"/.test(SHELL),
    "the Accounts switcher is behind the billing gate again — an operator could not leave a locked tenant",
  );
});

// ── The SUPPORT half of the mirror (2026-09-15, second pass) ──────────────────
// A support operator wears the VIEWED tenant's owner map. Three things stopped that map
// reaching the screen, and all three failed silently, so they are pinned here.

Deno.test("a failed view-as lookup is never stored as an answer", () => {
  const block = codeBetween(SHELL, "const load = async (attempt) =>", "load(0);", "viewedCtx load");
  // supabase-js RESOLVES {data,error}; without these tests a 403 was written in as "this
  // tenant has no access map and no entitlement" and never revisited.
  assert(/st\.error/.test(block) && /bl\.error/.test(block), "the load must treat a resolved {error} as a failure");
  assert(block.includes("load(attempt + 1)"), "a failed lookup must be retried, not accepted");
  assert(block.includes("viewed_ctx_unreadable"), "a definitive failure must be logged, not swallowed");
  assert(
    !/access:\s*\(st\.data\s*&&/.test(block),
    "the old `(st.data && st.data.access) || null` shape is back — it records a non-answer",
  );
});

Deno.test("support never falls back to the OPERATOR'S OWN access map", () => {
  const block = codeBetween(SHELL, "const myAccess = supportView", "const mirrorAccess", "myAccess");
  assert(block.includes("? (viewedCtx ? viewedCtx.access : null)"), "support must read only the viewed tenant's map");
  // The NON-support branch reads tenant.access and should — that is the caller's own portal.
  // What must never come back is the `|| tenant.access` fallback ON the support branch.
  assert(
    !/viewedCtx && viewedCtx\.access\)\s*\|\|/.test(block),
    "support falls back to the operator's own tenant map again — that is the god view",
  );
});

Deno.test("content surfaces get the mirrored access map, so the builder's own rules govern", () => {
  assert(SHELL.includes("const mirrorAccess = supportView ? myAccess : (viewing ? null : myAccess);"));
  assert(SHELL.includes("const settingsAccess = mirrorAccess;"),
    "the settings rail is back on a null map — that offers a support operator Billing, Wallet and SMS");
  // The three schedule boards derive their own canEdit from this prop.
  const n = (SHELL.match(/access=\{mirrorAccess\}/g) || []).length;
  assert(n >= 3, `expected the three schedule boards to take mirrorAccess, found ${n}`);
  assert(!SHELL.includes("access={viewing ? null : myAccess}"), "a content surface still nulls the map in view-as");
});

Deno.test("owner-level row actions follow the owner, not the tab clamp", () => {
  assert(SHELL.includes("const mirrorAdmin = supportView ? true : canAdmin;"));
  // canAdmin must still be the thing ssClampTab is given, or the narrowed map governs nothing.
  assert(/ssClampTab\(tab, isOperator, canAdmin, myAccess, supportView/.test(SHELL),
    "ssClampTab must keep receiving canAdmin, never mirrorAdmin");
  assert(!/isAdmin=\{canAdmin\}/.test(SHELL), "a row-action surface still keys on canAdmin");
});

Deno.test("admin-import-monday refuses a support account", async () => {
  const src = await Deno.readTextFile(new URL("../../admin-import-monday/index.ts", import.meta.url));
  const code = src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  assert(/select\([^)]*support_only/.test(code), "the operator lookup must select support_only");
  assert(/if \(op\.support_only\)/.test(code), "a support account must be refused the Projects import");
});

Deno.test("portal-settings has no operator exemption from the paid-feature checks", () => {
  const code = SETTINGS.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  assert(!code.includes("entitlementExempt"), "entitlementExempt is back in portal-settings");
  for (const line of ["if (RTP_ACTIONS.has(action)) {", "if (crmGated || action === \"crm_record\") {", "if (QBO_ACTIONS.has(action)) {"]) {
    assert(code.includes(line), `paid-feature gate has changed shape: ${line}`);
  }
});
