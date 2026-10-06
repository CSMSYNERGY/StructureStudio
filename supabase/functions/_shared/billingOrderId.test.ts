// Deliberately dependency-free (no jsr:/npm: imports) so this suite still runs on a machine
// with no registry access — the same rule the other _shared tests follow.
//
// Getting this rule wrong is expensive in BOTH directions, which is why the cases below pin
// both edges and not just the bug that prompted them:
//
//   * Too NARROW and a foreign event throws, the gateway redelivers it for hours, and every
//     attempt files a `severity='error'` row. Observed twice — 40 rows for one Framed-UP
//     subscription (2026-08-24/25), then 18 rows in eleven hours for `sub-…-CPI_YEARLY-…`
//     (2026-09-01/02), because the first fix matched only an underscore separator.
//   * Too WIDE and we ack something that WAS ours, silently dropping a real subscription
//     change. billing-webhook owns every state change after the initial subscribe, so a
//     dropped cancellation leaves a lapsed tenant with full access indefinitely — the exact
//     failure that function's own file header was written about.

import { foreignOrderPrefixOf, ssClientIdOf } from "./billingOrderId.ts";

const assert = (cond: unknown, msg = "assertion failed") => {
  if (!cond) throw new Error(msg);
};
const assertEquals = (a: unknown, b: unknown, msg?: string) => {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(msg ? `${msg}: ${sa} !== ${sb}` : `${sa} !== ${sb}`);
};

const isForeign = (o: string) => foreignOrderPrefixOf(o) !== null;

// ── OURS: must never be acked, however it is shaped ──────────────────────────────────

Deno.test("our own order ids are never foreign", () => {
  // portal-billing mints `ss_<clientId>_<planId>`, and clientId is a DNS-safe slug, so it can
  // carry hyphens — the very character the fix widened on. Worth being explicit that a hyphen
  // INSIDE one of ours changes nothing.
  for (
    const o of [
      "ss_junior-barns_simple_layout_monthly",
      "ss_first_yoder-barns_crm_annual",
      "ss_structure-studio_full_suite_annual",
      "ss_a_b",
    ]
  ) {
    assertEquals(foreignOrderPrefixOf(o), null, o);
  }
});

Deno.test("case does not smuggle one of ours past the guard", () => {
  // The test is case-insensitive, so an upper-cased ours is still ours: it keeps the
  // throw-and-retry path rather than being silently acked.
  for (const o of ["SS_junior-barns_simple_layout_monthly", "Ss_x_y"]) {
    assertEquals(foreignOrderPrefixOf(o), null, o);
  }
});

// ── NOT OURS: must be acked, or the gateway retries for hours ────────────────────────

Deno.test("the shape that caused the 2026-09-02 retry loop is foreign", () => {
  // Hyphen-separated. The first version of this rule required an underscore and missed it
  // entirely: 18 redeliveries, 18 fault rows, for a subscription that was never ours.
  assert(isForeign("sub-AAAAAAAAAAAAAAAAAAAA-CPI_YEARLY-1700000000000"));
});

Deno.test("Framed-UP's shapes stay foreign — what the rule was first written for", () => {
  assert(isForeign("fu_00000000-0000-4000-8000-000000000002_starter_monthly"));
  assert(isForeign("cs_00000000-0000-4000-8000-000000000001_starter"));
});

Deno.test("either separator counts, because we do not get to choose theirs", () => {
  assert(isForeign("acme_123"), "underscore");
  assert(isForeign("acme-123"), "hyphen");
  assert(isForeign("ACME-123"), "and neither is case-sensitive");
});

// ── REFUSING TO GUESS: absent or unparseable keeps the retry ─────────────────────────

Deno.test("an order id with NO prefix is not called foreign", () => {
  // The safe direction, and deliberate. Acking something we cannot identify would drop a real
  // change; retrying it only costs a redelivery. A bare gateway id is exactly the shape an
  // update or delete arrives with.
  for (const o of ["", "4100009999", "noseparatorhere"]) {
    assertEquals(foreignOrderPrefixOf(o), null, JSON.stringify(o));
  }
});

Deno.test("a leading separator or digits do not read as a prefix", () => {
  for (const o of ["_leading", "-leading", "123_abc", "9-abc"]) {
    assertEquals(foreignOrderPrefixOf(o), null, o);
  }
});

Deno.test("null and undefined are survivable, not a crash", () => {
  // order_id is read straight off a third party's payload.
  assertEquals(foreignOrderPrefixOf(null as unknown as string), null);
  assertEquals(foreignOrderPrefixOf(undefined as unknown as string), null);
});

Deno.test("the returned prefix carries its separator, so a note reads correctly", () => {
  assertEquals(foreignOrderPrefixOf("fu_x"), "fu_");
  assertEquals(foreignOrderPrefixOf("sub-x"), "sub-");
});

// ── ssClientIdOf: which tenant one of OUR order ids names ────────────────────────────────────
//
// Its second reader decides whether billing-webhook ACKS a 0-row update/delete/pause (the tenant
// was deleted) or keeps retrying it (the add has not landed yet). So it must name the tenant exactly
// for ours, and return null for everything else: a null keeps the retry, which is the safe side.
// Tenant slugs below are made up.

Deno.test("ssClientIdOf reads the tenant out of portal-billing's two shapes", () => {
  assertEquals(ssClientIdOf("ss_acme-sheds_simple_layout_annual"), "acme-sheds");
  assertEquals(ssClientIdOf("ss_acme-sheds_crm_monthly"), "acme-sheds");
  // The first-charge variant. Without the optional hop the tenant came back as "first".
  assertEquals(ssClientIdOf("ss_first_x_plan"), "x");
  assertEquals(ssClientIdOf("ss_first_acme-sheds_full_suite_annual"), "acme-sheds");
  assertEquals(ssClientIdOf("ss_a1-b2_p"), "a1-b2", "digits and hyphens are slug characters");
});

Deno.test("ssClientIdOf is null for every order id that is not ours", () => {
  for (
    const o of [
      "cs_00000000-0000-4000-8000-000000000001_starter", // other products on the shared gateway
      "fu_00000000-0000-4000-8000-000000000002_starter_monthly",
      "sub-AAAAAAAAAAAAAAAAAAAA-CPI_YEARLY-1700000000000",
      "", "4100009999", "ss_", "ss_noplan", "ss__x", // absent, a bare gateway id, or no tenant segment
      "SS_acme-sheds_crm_monthly", "ss_Acme_crm", // only portal-billing mints these, always lowercase
    ]
  ) {
    assertEquals(ssClientIdOf(o), null, JSON.stringify(o));
  }
  assertEquals(ssClientIdOf(null as unknown as string), null);
  assertEquals(ssClientIdOf(undefined as unknown as string), null);
});

Deno.test("a positively foreign order id never also names a tenant of ours", () => {
  // The webhook tries foreignOrderPrefixOf first; the two rules must never both claim one id.
  for (const o of ["cs_x_y", "fu_x_y", "sub-x-y", "acme_x_y", "ss_acme-sheds_crm_monthly", "ss_first_x_plan"]) {
    assert(!(foreignOrderPrefixOf(o) !== null && ssClientIdOf(o) !== null), o);
  }
});
