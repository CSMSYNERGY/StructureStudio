// deno test --allow-read supabase/functions/_shared/doorLook.test.ts
// The door spec's one table (DOOR_LOOK_FIELDS) and the cleaner generated from it (doorLook.ts): every
// key the table allows survives cleaning, nothing outside it does, clamps clamp, and the three copies of
// the table (this one and the designer twins' SS_DOOR_LOOK_FIELDS) are the same table.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  cleanDoorLook,
  DOOR_LOOK_BASE_DEFAULTS,
  DOOR_LOOK_BASES,
  DOOR_LOOK_FIELDS,
  DOOR_LOOK_MAX_BYTES,
  type DoorFieldNode,
  doorLookDefault,
  doorLookPaths,
  sanitizeDoorLook,
} from "./doorLook.ts";

type Rec = Record<string, unknown>;
const clean = (raw: unknown): { spec: Rec; dropped: string[]; clamped: string[] } => {
  const r = cleanDoorLook(raw);
  if (!r.ok) throw new Error(`refused: ${r.error} at ${r.path}`);
  return r;
};
const MIN = { v: 1, base: "zbrace", src: { leaves: 1, hinge: "left" } };
const withMin = (extra: Rec) => ({ ...MIN, ...extra });

// The plan's own example (section 3): a double barn door, one Z per leaf, black T-straps.
const EXAMPLE = {
  v: 1,
  base: "zbrace",
  src: { leaves: 2, hinge: "right" },
  frame: { fIn: 5.5, rails: [0.5] },
  field: { dir: "v", pitchIn: 5.5 },
  brace: { t: "z", from: "hinge" },
  panels: [{ fill: "none" }, { fill: "none" }],
  hinges: { type: "tstrap", count: 3, at: [0.12, 0.5, 0.88], lenIn: 16, finish: "black" },
  handle: { type: "barn", v: "rail", finish: "black" },
  meet: { type: "overlap", wIn: 2 },
  colors: { infill: "door", frame: "trim", members: "trim" },
};

// Every key the table allows, each at a value it keeps: 3 rails and 4 panels covering every fill's own
// keys, 12 parts covering every part type, custom finishes with their hex.
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const box = (u0: number, v0: number) => ({ u0, v0, u1: r3(u0 + 0.2), v1: r3(v0 + 0.1) });
const MAX = {
  v: 1,
  base: "classic",
  src: { leaves: 2, hinge: "right" },
  frame: { fIn: 5.5, railHIn: 3.5, rails: [0.25, 0.5, 0.75] },
  field: { dir: "grooved", pitchIn: 6.5 },
  brace: { t: "z", from: "strike", wIn: 5.5 },
  panels: [
    { fill: "z", zFrom: "strike", braceWIn: 4.5 },
    { fill: "pickets", count: 4 },
    { fill: "lite", rows: 3, cols: 2 },
    { fill: "diamond", braceWIn: 3.5 },
  ],
  parts: [
    { t: "board", u0: 0.05, v0: 0.05, u1: 0.95, v1: 0.45, wIn: 5.5, role: "members" },
    { t: "board", u0: 0.95, v0: 0.05, u1: 0.05, v1: 0.45, wIn: 4.5, role: "frame" },
    { t: "board", u0: 0.1, v0: 0.6, u1: 0.9, v1: 0.6, wIn: 3.5, role: "members" },
    { t: "lite", ...box(0.1, 0.55), rows: 3, cols: 3 },
    { t: "lite", ...box(0.4, 0.7), rows: 2, cols: 1 },
    { t: "lite", ...box(0.7, 0.85), rows: 1, cols: 6 },
    { t: "vent", ...box(0.3, 0.1) },
    { t: "vent", ...box(0.6, 0.2) },
    { t: "raised", ...box(0.1, 0.3) },
    { t: "raised", ...box(0.5, 0.35) },
    { t: "split", v: 0.45 },
    { t: "split", v: 0.65 },
  ],
  hinges: { type: "scroll", count: 4, at: [0.1, 0.4, 0.6, 0.9], lenIn: 18.5, finish: "custom", hex: "#112233" },
  handle: { type: "ring", v: 0.48, finish: "custom", hex: "#445566" },
  meet: { type: "overlap", wIn: 2.25 },
  colors: { infill: "door", frame: "trim", members: "#778899" },
};

// The table paths a spec actually holds, in doorLookPaths' form.
function pathsIn(node: DoorFieldNode, value: unknown, path = ""): string[] {
  const join = (k: string) => (path ? `${path}.${k}` : k);
  if (node.k === "obj") return Object.entries(value as Rec).flatMap(([k, v]) => pathsIn(node.keys[k], v, join(k)));
  if (node.k === "list") return (value as unknown[]).flatMap((v) => (v === null ? [] : pathsIn(node.of, v, `${path}[]`)));
  if (node.k === "union") {
    const { [node.by]: t, ...rest } = value as Rec;
    return [join(node.by), ...pathsIn(node.of[t as string], rest, join(t as string))];
  }
  return [path];
}

Deno.test("the table is plain JSON, so the designer twins can carry it verbatim", () => {
  assertEquals(JSON.parse(JSON.stringify(DOOR_LOOK_FIELDS)), DOOR_LOOK_FIELDS);
});

Deno.test("each base's defaults: today's mid rail, and one more panel than rails", () => {
  assertEquals(Object.keys(DOOR_LOOK_BASE_DEFAULTS), [...DOOR_LOOK_BASES]);
  for (const b of ["plank", "zbrace", "xbrace"] as const) assertEquals(DOOR_LOOK_BASE_DEFAULTS[b].rails, [0.55]);
  for (const b of ["american", "basic", "classic", "dutch"] as const) assertEquals(DOOR_LOOK_BASE_DEFAULTS[b].rails, [0.42]);
  for (const d of Object.values(DOOR_LOOK_BASE_DEFAULTS)) assertEquals(d.panels.length, d.rails.length + 1);
  assertEquals(DOOR_LOOK_BASE_DEFAULTS.zbrace.brace, "z", "the Z is across the whole leaf");
  assertEquals(DOOR_LOOK_BASE_DEFAULTS.xbrace.panels, ["x", "none"], "the X is in the lower panel only");
  assertEquals(DOOR_LOOK_BASE_DEFAULTS.classic.panels, ["x", "diamond"]);
});

Deno.test("the plan's example spec cleans to itself, key for key", () => {
  const r = clean(EXAMPLE);
  assertEquals(r.spec, EXAMPLE);
  assertEquals(JSON.stringify(r.spec), JSON.stringify(EXAMPLE), "and in the table's key order");
  assertEquals([r.dropped, r.clamped], [[], []]);
});

Deno.test("every key the table allows survives cleaning: nothing is clamped and then silently dropped", () => {
  const r = clean(MAX);
  assertEquals(r.spec, MAX);
  assertEquals([r.dropped, r.clamped], [[], []]);
  // The whitelist is the table's, and this spec reaches every path in it.
  assertEquals([...new Set(pathsIn(DOOR_LOOK_FIELDS, r.spec))].sort(), [...doorLookPaths()].sort());
});

Deno.test("the largest spec the table allows fits the 4096-byte limit with room to spare", () => {
  const big = structuredClone(MAX) as Rec;
  // Every number at its longest (the decimals the table keeps), every part a lite with rows and cols.
  big.parts = Array.from({ length: 12 }, (_, i) => ({ t: "lite", u0: 0.123, v0: 0.001 + i * 0.05, u1: 0.987, v1: 0.555 + i * 0.03, rows: 6, cols: 6 }));
  const r = clean(big);
  const bytes = new TextEncoder().encode(JSON.stringify(r.spec)).length;
  assert(bytes < DOOR_LOOK_MAX_BYTES / 2, `${bytes} bytes`);
});

Deno.test("sanitizeDoorLook, as portal-settings calls it: the clean spec, or null, and never a throw", () => {
  assertEquals(sanitizeDoorLook({ ...EXAMPLE, extra: 1 }) as Rec | null, EXAMPLE);
  for (const junk of [null, undefined, "zbrace", 7, [EXAMPLE], { ...EXAMPLE, base: "slab" }, { ...EXAMPLE, v: 2 }, { v: 1 }, { ...MIN, src: { leaves: 3, hinge: "left" } }]) {
    assertEquals(sanitizeDoorLook(junk), null, JSON.stringify(junk));
  }
});

Deno.test("the size guard refuses a spec over the limit rather than trimming it", () => {
  assertEquals(cleanDoorLook(EXAMPLE, { maxBytes: 100 }), { ok: false, error: "too_big", path: "" });
});

Deno.test("numbers: clamped to the table's limits, rounded to its decimals, numeric strings read, junk dropped", () => {
  const r = clean(withMin({
    frame: { fIn: 40, railHIn: "2.345", rails: [0.9, 0.05] },
    field: { pitchIn: Number.NaN },
    hinges: { lenIn: 1, count: 2.6 },
    meet: { wIn: "wide" },
  }));
  assertEquals(r.spec.frame, { fIn: 8, railHIn: 2.3, rails: [0.15, 0.85] });
  assertEquals(r.spec.hinges, { count: 3, lenIn: 3 });
  assertEquals(r.spec.field, undefined, "NaN is no number");
  assertEquals(r.spec.meet, undefined);
  assertEquals(r.clamped.sort(), ["frame.fIn", "frame.rails", "hinges.lenIn"]);
  assert(r.dropped.includes("meet.wIn"));
});

Deno.test("unknown keys are dropped and listed, at every level, and never reach the spec", () => {
  // Parsed, as an answer is: "__proto__" is then an own key, not the prototype.
  const r = clean(JSON.parse(JSON.stringify({
    ...MIN,
    measure: { size: [1, 1] },
    observed: ["a Z brace"],
    src: { leaves: 1, hinge: "left", photo: "door-refs/x.jpg" },
    hinges: { type: "tstrap", glow: true },
    parts: [{ t: "vent", ...box(0.3, 0.1), note: "x" }],
    constructor: "x",
  }).replace(/^\{/, '{"__proto__":{"polluted":true},')));
  assertEquals(r.spec, { ...MIN, parts: [{ t: "vent", ...box(0.3, 0.1) }], hinges: { type: "tstrap" } });
  for (const p of ["__proto__", "measure", "observed", "src.photo", "hinges.glow", "parts[0].note", "constructor"]) assert(r.dropped.includes(p), p);
  assertEquals(({} as Rec).polluted, undefined);
});

Deno.test("refused, never repaired: a missing required key, an unknown version, 3 or more leaves", () => {
  assertEquals(cleanDoorLook({ base: "zbrace", src: { leaves: 1, hinge: "left" } }), { ok: false, error: "missing", path: "v" });
  assertEquals(cleanDoorLook({ ...MIN, base: "slab" }), { ok: false, error: "missing", path: "base" });
  assertEquals(cleanDoorLook({ ...MIN, src: { leaves: 1 } }), { ok: false, error: "missing", path: "src.hinge" });
  assertEquals(cleanDoorLook({ ...MIN, v: 2 }), { ok: false, error: "version", path: "v" });
  assertEquals(cleanDoorLook({ ...MIN, src: { leaves: 3, hinge: "left" } }), { ok: false, error: "unsupported", path: "src.leaves" });
  assertEquals(cleanDoorLook({ ...MIN, src: { leaves: 0, hinge: "left" } }), { ok: false, error: "unsupported", path: "src.leaves" });
  assertEquals(cleanDoorLook([MIN]), { ok: false, error: "not_object", path: "" });
  assertEquals(cleanDoorLook(null), { ok: false, error: "not_object", path: "" });
});

Deno.test("choices: case and spaces forgiven; a value off the list is dropped, so today's rule applies", () => {
  const r = clean({ ...MIN, base: " ZBrace ", hinges: { type: "T-Strap", finish: "BLACK" }, handle: { type: "Lever" } });
  assertEquals(r.spec.base, "zbrace");
  assertEquals(r.spec.hinges, { finish: "black" });
  assertEquals(r.spec.handle, { type: "lever" });
  assert(r.dropped.includes("hinges.type"));
});

Deno.test("keys that mean something only beside their sibling are dropped without it", () => {
  const r = clean(withMin({
    panels: [
      { fill: "x", zFrom: "strike", count: 5, rows: 2, braceWIn: 4 },
      { fill: "pickets", count: 5, braceWIn: 4 },
    ],
    hinges: { finish: "black", hex: "#123456" },
    handle: { finish: "custom" },
  }));
  assertEquals(r.spec.panels, [{ fill: "x", braceWIn: 4 }, { fill: "pickets", count: 5 }]);
  assertEquals(r.spec.hinges, { finish: "black" }, "a hex only with a custom finish");
  assertEquals(r.spec.handle, undefined, "and a custom finish only with its hex");
  for (const p of ["panels[0].zFrom", "panels[0].count", "panels[0].rows", "panels[1].braceWIn", "hinges.hex", "handle.finish"]) {
    assert(r.dropped.includes(p), p);
  }
});

Deno.test("hinges: none only when hidden, one position per hinge, positions alone are the count", () => {
  assertEquals(clean(withMin({ hinges: { type: "hidden", count: 0, at: [] } })).spec.hinges, { type: "hidden", count: 0, at: [] });
  assertEquals(clean(withMin({ hinges: { type: "strap", count: 0 } })).spec.hinges, { type: "strap" });
  assertEquals(clean(withMin({ hinges: { count: 3, at: [0.2, 0.8] } })).spec.hinges, { count: 3 });
  assertEquals(clean(withMin({ hinges: { at: [0.8, 0.2] } })).spec.hinges, { count: 2, at: [0.2, 0.8] });
  assertEquals(clean(withMin({ hinges: { at: "rails", count: 2 } })).spec.hinges, { count: 2, at: "rails" });
  assertEquals(clean(withMin({ hinges: { at: [0.01, 0.99] } })).spec.hinges, { count: 2, at: [0.05, 0.95] });
  assertEquals(clean(withMin({ handle: { v: 0.2 } })).spec.handle, { v: 0.3 });
  assertEquals(clean(withMin({ handle: { v: "Rail" } })).spec.handle, { v: "rail" });
});

Deno.test("rails: sorted, at least 0.08 apart, at most 3; panels fitted to them, bad ones held in place", () => {
  assertEquals(clean(withMin({ frame: { rails: [0.6, 0.3, 0.35, 0.8, 0.82] } })).spec.frame, { rails: [0.3, 0.6, 0.8] });
  assertEquals(clean(withMin({ frame: { rails: [0.3, 0.38] } })).spec.frame, { rails: [0.3, 0.38] }, "0.08 exactly is apart");
  assertEquals(clean(withMin({ frame: { rails: [0.4, 0.2, 0.6, 0.8] } })).spec.frame, { rails: [0.2, 0.4, 0.6] });
  // No mid rail: one panel. Absent rails: today's one, so two panels.
  assertEquals(clean(withMin({ frame: { rails: [] }, panels: [{ fill: "x" }, { fill: "lite" }] })).spec.panels, [{ fill: "x" }]);
  assertEquals(clean(withMin({ panels: ["x", { fill: "x" }, { fill: "x" }] })).spec.panels, [null, { fill: "x" }]);
  // A bad panel holds its place as null (the base's own fill there), and trailing nulls go.
  assertEquals(clean(withMin({ panels: [{ fill: "glass" }, { fill: "lite" }] })).spec.panels, [null, { fill: "lite" }]);
  assertEquals(clean(withMin({ panels: [{ fill: "lite" }, { fill: "glass" }] })).spec.panels, [{ fill: "lite" }]);
  assertEquals(clean(withMin({ panels: [{}, {}, {}, {}, {}] })).spec.panels, undefined);
});

Deno.test("parts: at most 12, boxes put the right way up, too small or shapeless ones dropped", () => {
  const vents = Array.from({ length: 20 }, (_, i) => ({ t: "vent", u0: 0.1, v0: i * 0.04, u1: 0.3, v1: i * 0.04 + 0.1 }));
  const r = clean(withMin({ parts: [{ t: "door" }, { t: "lite", u0: 0.1, v0: 0.1, u1: 0.15, v1: 0.5 }, ...vents] }));
  assertEquals((r.spec.parts as unknown[]).length, 12);
  assert(r.dropped.includes("parts[0]") && r.dropped.includes("parts[1]"), "the unknown type and the 0.05-wide lite");
  assertEquals(clean(withMin({ parts: [{ t: "raised", u0: 0.6, v0: 0.5, u1: 0.2, v1: 0.1 }] })).spec.parts, [{ t: "raised", u0: 0.2, v0: 0.1, u1: 0.6, v1: 0.5 }]);
  assertEquals(clean(withMin({ parts: [{ t: "board", u0: 0.5, v0: 0.5, u1: 0.52, v1: 0.55 }] })).spec.parts, undefined, "a board with no length");
  assertEquals(clean(withMin({ parts: [{ t: "lite", u0: 0.2, v0: 0.2, u1: 0.6 }] })).spec.parts, undefined, "a missing corner drops the part");
  assertEquals(clean(withMin({ parts: [{ t: "split", v: 0.95 }] })).spec.parts, [{ t: "split", v: 0.8 }]);
  // A list padded with thousands of entries is cut short before it is read.
  const flood = Array.from({ length: 100_000 }, () => ({ t: "vent", ...box(0.3, 0.1) }));
  assertEquals((clean(withMin({ parts: flood })).spec.parts as unknown[]).length, 12);
});

Deno.test("colours: the Door or Door trim pick, or a hex from the edit form", () => {
  const r = clean(withMin({ colors: { infill: "Door", frame: "a2b3c4", members: "#ZZZ" } }));
  assertEquals(r.spec.colors, { infill: "door", frame: "#A2B3C4" });
  assert(r.dropped.includes("colors.members"));
});

Deno.test("cleaning a clean spec changes nothing", () => {
  for (const s of [EXAMPLE, MAX, MIN]) assertEquals(clean(clean(s).spec).spec, clean(s).spec);
});

Deno.test("the table's constant defaults, for the close-up fallbacks and the renderer", () => {
  assertEquals(
    ["hinges.type", "hinges.finish", "handle.type", "handle.v", "meet.type", "meet.wIn", "brace.from", "frame.fIn", "nope"].map(doorLookDefault),
    ["tstrap", "black", "barn", "rail", "astragal", 1.5, "hinge", undefined, undefined],
  );
});

// The designer twins carry the table as SS_DOOR_LOOK_FIELDS: `const SS_DOOR_LOOK_FIELDS = <the JSON of
// DOOR_LOOK_FIELDS>;`. Until P2 adds it, neither twin has it; from then on both must, and all three
// copies must be the same table.
function twinTable(src: string): unknown {
  const at = src.indexOf("SS_DOOR_LOOK_FIELDS =");
  if (at < 0) return null;
  const start = src.indexOf("{", at);
  let depth = 0, inString = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return JSON.parse(src.slice(start, i + 1));
  }
  throw new Error("SS_DOOR_LOOK_FIELDS is not closed");
}

Deno.test("the designer twins' SS_DOOR_LOOK_FIELDS: in both or neither, and the same table as this one", async () => {
  const twins = await Promise.all(
    ["StructureStudio.jsx", "structure-studio.component.js"].map((f) => Deno.readTextFile(new URL(`../../../${f}`, import.meta.url))),
  );
  const tables = twins.map(twinTable);
  assertEquals(tables[0] === null, tables[1] === null, "one twin has the table and the other does not");
  if (tables[0] === null) return; // before P2: nothing to compare yet
  const ours = JSON.parse(JSON.stringify(DOOR_LOOK_FIELDS));
  assertEquals(tables[0], ours, "StructureStudio.jsx");
  assertEquals(tables[1], ours, "structure-studio.component.js");
});
