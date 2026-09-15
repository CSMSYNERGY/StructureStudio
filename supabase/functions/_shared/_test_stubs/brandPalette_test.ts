// The designer's brand palette, tested against the SHIPPED designer source.
//
// Every builder embeds the designer under their own two brand colours (accentColor, headerBg), and
// the redesign derives every accent, tint and text colour on the page from them. A light yellow or
// a white header must still give readable text, and a tenant with no branding must get the
// mockup's own palette back. Nothing in the browser would notice if the contrast pass broke: the
// page would just quietly print unreadable buttons for some builders. Same lift-the-real-code
// technique as insulation_test and wallSlab_test.

import { assert, assertEquals } from "jsr:@std/assert";

const SRC = await Deno.readTextFile(
  new URL("../../../../structure-studio.component.js", import.meta.url),
);

const START = "// ss-brand-palette:start";
const END = "// ss-brand-palette:end";
const i = SRC.indexOf(START);
const j = SRC.indexOf(END, i);
if (i < 0 || j < 0) {
  throw new Error(
    `brandPalette_test: could not find the palette block (start=${i}, end=${j}). ` +
      "The anchors moved — re-point them rather than deleting this test.",
  );
}
const BLOCK = SRC.slice(i, j);
for (const name of ["ssBrandPalette", "checkPalette", "ssPal", "ssPalInput", "ssOnFill", "toCssVars"]) {
  assert(BLOCK.includes(name), `extracted block is missing ${name}`);
}

// deno-lint-ignore no-explicit-any
type Pal = Record<string, any>;
const P = new Function(
  `${BLOCK}; return { ssBrandPalette, checkPalette, ssPal, ssPalInput, ssOnFill, toCssVars, contrast, hexToRgb, colorStops };`,
)() as {
  ssBrandPalette: (b: unknown) => Pal;
  checkPalette: (t: Pal) => string[];
  ssPal: (b: unknown) => Pal;
  ssPalInput: (b: unknown) => Pal;
  ssOnFill: (css: string) => string;
  toCssVars: (t: Pal) => Record<string, string>;
  contrast: (a: unknown, b: unknown) => number;
  hexToRgb: (h: string) => unknown;
  colorStops: (css: string) => unknown[];
};

// The "none" column of DESIGN-SPEC §2.4: the mockup palette after the AA pass.
const FALLBACK: Pal = {
  ink: "#2b2745", muted: "#6f6a8e", subtle: "#766f94", placeholder: "#9791b0",
  line: "#d9d5e8", lineCard: "#e6e3f0", lineSoft: "#eceaf4", lineFaint: "#f2f0f8",
  panel: "#fbfaff", surface: "#ffffff", tileArtTop: "#f4f6fa", tileArtBottom: "#e8edf6",
  primary: "#3d3672", onPrimary: "#ffffff", primaryFaint: "#f7f5ff", primarySoft: "#f4f1fd",
  primaryWash: "#f0edfb", primaryRail: "#dcd7ee", primaryLine: "#cdc7e4", primaryDash: "#9c94c4", planGrid: "#edeaf6",
  accentFill: "#1b7895", onAccent: "#ffffff", accentText: "#1b7895", accentDeep: "#136075", accentMuted: "#457b8a",
  accentWash: "#f2fcfb", accentLine: "#9fe0d6", accentChipLine: "#7fcfc4", accentRail: "#d6e6ec",
  tileSelTop: "#eef3fb", tileSelBottom: "#dbeaff", accentShadow: "rgba(27, 120, 149, 0.22)",
  cta: "#75e6da", onCta: "#10303a",
  danger: "#a8342f", dangerWash: "#fdf4f4", dangerLine: "#efc9c9", bolt: "#e0a11b",
  headerBg: "linear-gradient(97deg, #3d3672 0%, #2f4a7f 52%, #1b7895 100%)",
  onHeader: "#ffffff", onHeaderMuted: "rgba(255, 255, 255, 0.94)",
  headerChipBg: "rgba(255, 255, 255, 0.16)", headerChipLine: "rgba(255, 255, 255, 0.28)", headerLine: "transparent",
};

const SLATE = "linear-gradient(135deg, #1E293B 0%, #334155 100%)";

// The six brands the render harness draws (redesign harness BRANDS), as get_config delivers them.
const HARNESS_BRANDS: Pal[] = [
  { headerBg: "#3d3672", accentColor: "#75e6da" },   // structure
  { headerBg: "#FFFFFF", accentColor: "#E8590C" },   // orange
  { headerBg: "#14213D", accentColor: "#1B2A4A" },   // navy
  { headerBg: "#FFFBEA", accentColor: "#FFF3A3" },   // paleyellow
  { headerBg: "#FFFFFF", accentColor: "#2F7D32" },   // green
  { headerBg: null, accentColor: null },             // none
];

Deno.test("no branding returns the mockup palette (after the contrast pass)", () => {
  assertEquals(P.ssBrandPalette({}), FALLBACK);
  assertEquals(P.ssBrandPalette(null), FALLBACK);
});

Deno.test("junk colour values are ignored and give the fallback", () => {
  assertEquals(P.ssBrandPalette({ accentColor: "url(x)", headerBg: "not a colour;" }), FALLBACK);
});

Deno.test("the reference pair returns the mockup's own primary, fill and a three-stop header", () => {
  const t = P.ssBrandPalette({ accentColor: "#1b7895", headerBg: "#3d3672" });
  assertEquals(t.primary, "#3d3672");
  assertEquals(t.accentFill, "#1b7895");
  assert(/^linear-gradient\(97deg, #3d3672 0%, #[0-9a-f]{6} 52%, #1b7895 100%\)$/.test(t.headerBg), t.headerBg);
});

Deno.test("checkPalette is clean for the named spec cases", () => {
  const cases: Pal[] = [
    {}, { accentColor: "#D97706" }, { accentColor: "#1E293B" }, { accentColor: "#FDE047" }, { accentColor: "#15803D" },
    { accentColor: "#D97706", headerBg: "#1E293B" },
    { accentColor: "#FDE047", headerBg: SLATE },
    { accentColor: "#15803D", headerBg: "#FFFFFF" },
    { accentColor: "#DC2626", headerBg: "#111827" },
    { accentColor: "#1b7895", headerBg: "#3d3672" },
  ];
  for (const b of cases) assertEquals(P.checkPalette(P.ssBrandPalette(b)), [], JSON.stringify(b));
});

Deno.test("checkPalette is clean for 2,000 seeded random accent/header pairs", () => {
  let seed = 0x5eed1234;
  const rand = () => { // mulberry32
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rhex = () => "#" + Math.floor(rand() * 0xffffff).toString(16).padStart(6, "0");
  for (let n = 0; n < 2000; n++) {
    const accentColor = rand() < 0.85 ? rhex() : undefined;
    const r = rand();
    const headerBg = r < 0.4 ? rhex() : r < 0.55 ? `linear-gradient(135deg, ${rhex()} 0%, ${rhex()} 100%)` : r < 0.65 ? "nonsense;" : undefined;
    const b = P.ssPalInput({ accentColor, headerBg });
    const t = P.ssBrandPalette(b);
    assertEquals(P.checkPalette(t), [], JSON.stringify(b));
  }
});

Deno.test("every harness brand passes after the one-colour normaliser", () => {
  for (const raw of HARNESS_BRANDS) {
    const t = P.ssPal(P.ssPalInput(raw));
    assertEquals(P.checkPalette(t), [], JSON.stringify(raw));
    // Text on the builder's accent fill and on the header must be readable.
    assert(P.contrast(P.hexToRgb(t.onAccent), P.hexToRgb(t.accentFill)) >= 4.5, JSON.stringify(raw));
    for (const stop of P.colorStops(t.headerBg)) {
      assert(P.contrast(P.hexToRgb(t.onHeader), stop) >= 4.5, `header text on ${t.headerBg}`);
    }
  }
});

Deno.test("ssPalInput: one colour set keeps today's fallback for the other half", () => {
  assertEquals(P.ssPalInput({ accentColor: "#E8590C" }).headerBg, SLATE);
  assertEquals(P.ssPalInput({ accentColor: "#E8590C" }).accentColor, "#E8590C");
  assertEquals(P.ssPalInput({ headerBg: "#14213D" }).accentColor, "#D97706");
  assertEquals(P.ssPalInput({ headerBg: "#14213D" }).headerBg, "#14213D");
  // Neither or both: passed straight through (the no-branding tenant gets the mockup palette).
  const none = {};
  assertEquals(P.ssPalInput(none), none);
  const both = { accentColor: "#123456", headerBg: "#654321", companyName: "X" };
  assertEquals(P.ssPalInput(both), both);
  assertEquals(P.ssPal(P.ssPalInput({})), FALLBACK);
});

Deno.test("ssPal caches by the two inputs", () => {
  const a = P.ssPal({ accentColor: "#2F7D32", headerBg: "#FFFFFF" });
  const b = P.ssPal({ accentColor: "#2F7D32", headerBg: "#FFFFFF", companyName: "other" });
  assert(a === b, "same colours, same object");
});

Deno.test("ssOnFill picks readable text for light and dark fills", () => {
  const onYellow = P.ssOnFill("#FFF3A3");
  assert(P.contrast(P.hexToRgb(onYellow), P.hexToRgb("#FFF3A3")) >= 4.5, onYellow);
  assertEquals(P.ssOnFill("#1B2A4A"), "#ffffff");
  assertEquals(P.ssOnFill("#1b7895"), "#ffffff");
  assert(/^#[0-9a-f]{6}$/.test(P.ssOnFill("not a colour")));
});

Deno.test("toCssVars names every token as a --ss- custom property", () => {
  const v = P.toCssVars(FALLBACK);
  assertEquals(v["--ss-accent-fill"], "#1b7895");
  assertEquals(v["--ss-on-header-muted"], "rgba(255, 255, 255, 0.94)");
  assertEquals(Object.keys(v).length, Object.keys(FALLBACK).length);
});
