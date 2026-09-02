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

import { foreignOrderPrefixOf } from "./billingOrderId.ts";

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
  assert(isForeign("sub-zW4xVuZ5K7yWubw6Z4ot-CPI_YEARLY-1788299064953"));
});

Deno.test("Framed-UP's shapes stay foreign — what the rule was first written for", () => {
  assert(isForeign("fu_19c4bccd-1866-47ec-9884-bc58b6078b25_starter_monthly"));
  assert(isForeign("cs_db589321-45f5-4801-8d15-1ce4b87dd3bb_starter"));
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
  for (const o of ["", "12463916652", "noseparatorhere"]) {
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
