// The pricing-sheet importer (importPricingRows) used to exist twice — admin-catalog (both operator
// consoles) and portal-settings (the builder's Structures upload) — and this test LIFTED each copy
// from the shipped source. Since 2026-10-28 there is one copy, _shared/pricingImport.ts, which both
// import (pricingImportBulk_test.ts pins that wiring); this test runs it against the in-memory
// tables of pricingImportFake.ts.
//
// What is pinned: a style name that more than one building style answers to (label OR key,
// hidden styles included) must not resolve to one of them. Last-writer-wins used to send the
// whole sheet's prices to whichever row the unordered select returned last — possibly a HIDDEN
// style — while the live style kept quoting its old prices and the banner reported success.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { importPricingRows } from "../pricingImport.ts";
import { fakeDb } from "./pricingImportFake.ts";

const STYLES = [
  { client_id: "acme", id: "st-hidden", key: "barn", label: "Barn" },     // the old one, hidden by the builder
  { client_id: "acme", id: "st-live", key: "barn-2", label: "Barn" },     // the fresh one customers see
  { client_id: "acme", id: "st-shed", key: "shed", label: "Shed" },
];
const SIZES = [
  { id: "sz-h", client_id: "acme", style_id: "st-hidden", label: "10x12", width_ft: 10, length_ft: 12, base_price: 4000, active: false, sort_order: 0 },
  { id: "sz-l", client_id: "acme", style_id: "st-live", label: "10x12", width_ft: 10, length_ft: 12, base_price: 4100, active: true, sort_order: 0 },
  { id: "sz-s", client_id: "acme", style_id: "st-shed", label: "8x10", width_ft: 8, length_ft: 10, base_price: 2000, active: true, sort_order: 0 },
];
const priceOf = (rows: any[], id: string) => rows.find((z) => z.id === id)?.base_price;

Deno.test("an ambiguous style name is skipped by name, never written to one of them", async () => {
  const { sb, tables } = fakeDb({ building_styles: STYLES, building_sizes: SIZES });
  const out = await importPricingRows(sb, "acme", [
    { style: "Barn", width: "10", length: "12", price: "5000", active: "yes", inclusions: {} },
    { style: "Shed", width: "8", length: "10", price: "2500", active: "yes", inclusions: {} },
  ]);
  assertEquals([priceOf(tables.building_sizes, "sz-h"), priceOf(tables.building_sizes, "sz-l")], [4000, 4100], "neither Barn may move");
  assertEquals(priceOf(tables.building_sizes, "sz-s"), 2500);
  assertEquals(tables.building_sizes.length, 3);
  assertEquals(out.updated, 1);
  assert(out.skipped.length === 1 && /more than one building style/.test(out.skipped[0]), JSON.stringify(out.skipped));
});

Deno.test("a negative price is refused and the size left alone; 0 is a real (free) price", async () => {
  const { sb, tables } = fakeDb({ building_styles: STYLES.slice(2), building_sizes: SIZES.slice(2) });
  const out = await importPricingRows(sb, "acme", [
    { style: "Shed", width: "8", length: "10", price: "-4995", active: "yes", inclusions: {} },
    { style: "Shed", width: "8", length: "12", price: "0", active: "yes", inclusions: {} },
  ]);
  assertEquals(priceOf(tables.building_sizes, "sz-s"), 2000, "the refused row leaves its size alone");
  const made = tables.building_sizes.find((z) => z.label === "8x12");
  assert(made, "the $0 size should be created");
  assertEquals([made.base_price, made.active], [0, true]);
  assertEquals(out.created, 1);
  assert(out.skipped.length === 1 && /invalid price "-4995"/.test(out.skipped[0]), JSON.stringify(out.skipped));
});

Deno.test("a style's own label and key are one claim, not two", async () => {
  const { sb, tables } = fakeDb({ building_styles: [{ client_id: "acme", id: "st-1", key: "shed", label: "Shed" }] });
  const out = await importPricingRows(sb, "acme", [{ style: "shed", width: "8", length: "10", price: "", active: "", inclusions: {} }]);
  assertEquals(out.skipped, []);
  const made = tables.building_sizes.find((z) => z.style_id === "st-1");
  assert(made, "the size should be created");
  // NULL-base-price contract: a blank price is NULL and never offered.
  assertEquals([made.base_price, made.active], [null, false]);
});
