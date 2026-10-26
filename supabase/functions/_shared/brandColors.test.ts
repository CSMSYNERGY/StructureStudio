import { assertEquals } from "jsr:@std/assert@1";
import { BRAND_COLOR_MAX, brandColorList, normalizeHex } from "./brandColors.ts";

Deno.test("normalizeHex takes #RGB and #RRGGBB and nothing else", () => {
  assertEquals(normalizeHex("#fff"), "#FFFFFF");
  assertEquals(normalizeHex("  #d97706 "), "#D97706");
  assertEquals(normalizeHex("#D97706AA"), null);   // alpha would be lost in an inbox
  assertEquals(normalizeHex("red"), null);
  assertEquals(normalizeHex("linear-gradient(#fff,#000)"), null);
  assertEquals(normalizeHex(null), null);
});

Deno.test("brandColorList rebuilds, drops junk, collapses duplicates and caps the list", () => {
  const got = brandColorList([
    { name: "  Barn red  ", hex: "#b91c1c", evil: "<script>" },
    { name: "Same again", hex: "#B91C1C" },          // duplicate of the first, dropped
    { name: "No hex" },
    { hex: "#fff" },                                  // unnamed is fine
    "#123456",                                        // a bare string is not an entry
    null,
    ["#000000"],
  ]);
  assertEquals(got, [{ name: "Barn red", hex: "#B91C1C" }, { name: "", hex: "#FFFFFF" }]);
  assertEquals((got[0] as unknown as Record<string, unknown>).evil, undefined);

  const many = Array.from({ length: 30 }, (_, i) => ({ name: `c${i}`, hex: `#${i.toString(16).padStart(2, "0")}0000` }));
  assertEquals(brandColorList(many).length, BRAND_COLOR_MAX);

  assertEquals(brandColorList(null), []);
  assertEquals(brandColorList({ hex: "#fff" }), []);
  assertEquals(brandColorList("#fff"), []);
});

Deno.test("brandColorList trims a long name rather than refusing the entry", () => {
  const got = brandColorList([{ name: "x".repeat(99), hex: "#000000" }]);
  assertEquals(got[0].name.length, 40);
});
