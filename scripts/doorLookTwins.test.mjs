// node --test scripts/doorLookTwins.test.mjs   (preflight runs every scripts/*.test.mjs; Node 24, which strips
// the types off supabase/functions/_shared/doorLook.ts)
//
// Door looks P2 (2026-10-27): the designer twins carry the server's door-look table and run its cleaner in
// the browser (StructureStudio.jsx and structure-studio.component.js, the block between "DOOR LOOKS: A
// BUILDER'S OWN 3D DOOR" and "END DOOR LOOKS"). These hold that block to doorLook.ts without a browser:
//   - the block is the same text in both twins;
//   - its table, base defaults, finishes and size limit are doorLook.ts's;
//   - its cleaner gives exactly what sanitizeDoorLook gives, on hand-made specs and 3000 fuzzed ones (500+ distinct clean);
//   - a spec that says nothing measures a leaf exactly as the base does (ssDoorLeafPlan), and takes exactly
//     the windows and transoms its base takes (ssDoorWindowFit), at every catalog size here.
// (doorLook.test.ts, under Deno, holds the twins' table to the server's too; this runs where Deno does not.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { sanitizeDoorLook, DOOR_LOOK_FIELDS, DOOR_LOOK_BASE_DEFAULTS, DOOR_LOOK_BASES, DOOR_FINISH_HEX, DOOR_LOOK_MAX_BYTES } from "../supabase/functions/_shared/doorLook.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TWINS = ["StructureStudio.jsx", "structure-studio.component.js"];
const between = (src, from, to) => {
  const a = src.indexOf(from), b = src.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `${from} ... ${to} not found`);
  return src.slice(a, b + to.length);
};
const blocks = TWINS.map((f) => {
  const src = readFileSync(join(ROOT, f), "utf8").replace(/\r\n/g, "\n");
  return {
    looks: between(src, "// ── DOOR LOOKS: A BUILDER'S OWN 3D DOOR", "// ── END DOOR LOOKS ──"),
    windows: between(src, "// ── WINDOWS IN DOORS (migration 289) ──", "// ── END WINDOWS IN DOORS ──"),
  };
});
// Both blocks are pure: evaluated on their own, they need nothing from the rest of the designer.
const twin = (() => {
  const cx = vm.createContext({ TextEncoder });
  vm.runInContext(`${blocks[0].looks}\n${blocks[0].windows}\nthis.out = { SS_DOOR_LOOK_FIELDS, SS_DOOR_LOOK_BASE_DEFAULTS, SS_DOOR_FINISH_HEX,
    SS_DOOR_LOOK_MAX_BYTES, ssDoorLookClean, ssDoorLookSpecOfRow, ssDoorCustomLookOf, ssDoorLeafPlan, ssDoorWindowFit, ssDoorWindowCount, ssTrimDoorBoardFt };`, cx);
  return cx.out;
})();
const plain = (v) => JSON.parse(JSON.stringify(v));

test("the door-look block (and the window rules it feeds) is the same text in both twins", () => {
  assert.equal(blocks[1].looks, blocks[0].looks);
  assert.equal(blocks[1].windows, blocks[0].windows);
});

test("the twins' table, base defaults, finishes and size limit are doorLook.ts's", () => {
  assert.deepEqual(plain(twin.SS_DOOR_LOOK_FIELDS), plain(DOOR_LOOK_FIELDS));
  assert.deepEqual(plain(twin.SS_DOOR_LOOK_BASE_DEFAULTS), plain(DOOR_LOOK_BASE_DEFAULTS));
  assert.deepEqual(plain(twin.SS_DOOR_FINISH_HEX), plain(DOOR_FINISH_HEX));
  assert.equal(twin.SS_DOOR_LOOK_MAX_BYTES, DOOR_LOOK_MAX_BYTES);
});

// Made-up specs: the plan's own example, a steel slab with glass and raised panels, a six-panel slab, a
// trim door with corner boards, and the ways a spec goes wrong.
const ZB = { v: 1, base: "zbrace", src: { leaves: 2, hinge: "right" }, frame: { fIn: 5.5, rails: [0.5] }, field: { dir: "v", pitchIn: 5.5 },
  brace: { t: "z", from: "hinge" }, panels: [{ fill: "none" }, { fill: "none" }],
  hinges: { type: "tstrap", count: 3, at: [0.12, 0.5, 0.88], lenIn: 16, finish: "black" }, handle: { type: "barn", v: "rail", finish: "black" },
  meet: { type: "overlap", wIn: 2 }, colors: { infill: "door", frame: "trim", members: "trim" } };
const STEEL = { v: 1, base: "basic", src: { leaves: 1, hinge: "left" }, frame: { rails: [] }, field: { dir: "smooth" }, panels: [{ fill: "none" }],
  parts: [{ t: "lite", u0: 0.18, v0: 0.48, u1: 0.79, v1: 0.93, rows: 3, cols: 3 }, { t: "raised", u0: 0.21, v0: 0.12, u1: 0.44, v1: 0.39 },
    { t: "raised", u0: 0.58, v0: 0.12, u1: 0.83, v1: 0.39 }], hinges: { type: "hidden", count: 0 }, handle: { v: 0.43, finish: "galv" }, colors: { infill: "door", frame: "door" } };
const SIX = { ...STEEL, parts: [0.05, 0.44, 0.82].flatMap((v) => [{ t: "raised", u0: 0.18, v0: v, u1: 0.43, v1: v + 0.3 }, { t: "raised", u0: 0.57, v0: v, u1: 0.82, v1: v + 0.3 }]),
  hinges: { type: "butt", count: 3, at: [0.11, 0.5, 0.9], finish: "galv" } };
const CORNERS = { v: 1, base: "basic", src: { leaves: 2, hinge: "right" }, frame: { fIn: 1.5, railHIn: 2, rails: [0.505] }, field: { dir: "grooved" },
  parts: [{ t: "board", u0: 0.975, v0: 0.89, u1: 0.78, v1: 0.98, wIn: 2, role: "members" }, { t: "board", u0: 0.21, v0: 0.98, u1: 0.02, v1: 0.89, wIn: 2 }],
  hinges: { type: "butt", count: 2, at: [0.09, 0.92], finish: "galv" }, handle: { type: "lever", v: 0.56 }, meet: { type: "astragal", wIn: 1.5 },
  colors: { infill: "door", frame: "trim", members: "trim" } };
const HAND = [
  ZB, STEEL, SIX, CORNERS,
  { v: 1, base: "classic", src: { leaves: 1, hinge: "left" }, panels: [{ fill: "x", braceWIn: 4 }, { fill: "diamond" }] },
  { v: 1, base: "american", src: { leaves: 2, hinge: "left" }, frame: { rails: [0.3, 0.6] }, panels: [{ fill: "pickets", count: 4 }, { fill: "raised" }, { fill: "lite", rows: 2, cols: 3 }] },
  { v: 1, base: "dutch", src: { leaves: 1, hinge: "right" }, parts: [{ t: "vent", u0: 0.3, v0: 0.1, u1: 0.7, v1: 0.3 }, { t: "split", v: 0.5 }] },
  // What the cleaner clamps, drops or refuses.
  { v: "1", base: " Plank ", src: { leaves: "2", hinge: "RIGHT" }, frame: { fIn: 99, railHIn: "0.2", rails: [0.9, 0.1, 0.5, 0.52, 0.7] }, junk: 1 },
  { v: 1, base: "plank", src: { leaves: 1, hinge: "left" }, panels: [{ fill: "x" }, { fill: "z", zFrom: "strike", count: 3 }, { fill: "bogus" }, { fill: "lite" }] },
  { v: 1, base: "basic", src: { leaves: 1, hinge: "left" }, hinges: { count: 0, type: "tstrap", at: [0.2] } },
  { v: 1, base: "basic", src: { leaves: 1, hinge: "left" }, hinges: { at: [0.2, 0.5], count: 3, finish: "custom" }, handle: { finish: "custom", hex: "abcdef" } },
  { v: 1, base: "basic", src: { leaves: 1, hinge: "left" }, hinges: { finish: "custom", hex: "#00ff00" }, colors: { infill: "#ABCDEF", frame: "Trim", members: "blue" } },
  { v: 1, base: "basic", src: { leaves: 1, hinge: "left" }, parts: [{ t: "lite", u0: 0.5, v0: 0.5, u1: 0.55, v1: 0.9 }, { t: "board", u0: 0.1, v0: 0.1, u1: 0.12, v1: 0.12 }, null, 7, { t: "wat" }] },
  { v: 1, base: "basic", src: { leaves: 1, hinge: "left" }, parts: Array.from({ length: 20 }, (_, i) => ({ t: "split", v: 0.2 + i * 0.01 })) },
  { v: 2, base: "basic", src: { leaves: 1, hinge: "left" } },
  { v: 1, base: "basic", src: { leaves: 3, hinge: "left" } },
  { v: 1, base: "slab", src: { leaves: 1, hinge: "left" } },
  { v: 1, base: "basic", src: { leaves: 1 } },
  { v: 1, base: "basic" },
  null, [], "spec", 42,
];
const same = (raw) => assert.deepEqual(plain(twin.ssDoorLookClean(raw)), plain(sanitizeDoorLook(raw)), JSON.stringify(raw));

test("the twins' cleaner gives what sanitizeDoorLook gives, on hand-made specs", () => {
  HAND.forEach(same);
  assert.ok(twin.ssDoorLookClean(ZB), "the plan's example cleans");
  assert.equal(twin.ssDoorLookClean({ v: 1, base: "basic", src: { leaves: 3, hinge: "left" } }), null, "3 leaves are refused, never drawn as 2");
});

test("...and on a seeded fuzz of them: values swapped, dropped, stretched and retyped", () => {
  // mulberry32: exact in 32-bit integer steps (an LCG done in floats loses its low bits past 2^53 and cycles).
  let seed = 20261027;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  // Every word the table takes (a base, a fill, a part type, a hinge, a handle...), so a fuzzed value is as
  // often another VALID choice as junk.
  const words = new Set();
  const walk = (n) => { if (!n || typeof n !== "object") return; if (Array.isArray(n.of)) n.of.forEach((x) => (typeof x === "string" ? words.add(x) : walk(x)));
    if (n.of && !Array.isArray(n.of)) Object.values(n.of).forEach(walk); if (n.keys) Object.values(n.keys).forEach(walk); };
  walk(DOOR_LOOK_FIELDS);
  const WORDS = [...words, "left", "right", "door", "trim", "#123456", "Plank", " lite "];
  const JUNK = [null, undefined, -1, 0, 0.05, 0.5, 0.97, 1.4, 3, 12, 40, "0.3", "x", [], [0.2, 0.6], [0.3, 0.33, 0.6, 0.9, 0.95], {}, true];
  const noise = () => (rnd() < 0.5 ? pick(WORDS) : rnd() < 0.5 ? rnd() * 14 - 1 : pick(JUNK));
  const mutate = (v, depth, key) => {
    // The keys every spec needs are kept most of the time, or nearly every case would be refused at the door.
    const keep = depth === 0 ? 0.97 : 0.92;
    if (Array.isArray(v)) return rnd() < 0.15 ? noise() : v.filter(() => rnd() > 0.1).map((x) => mutate(x, depth + 1));
    if (v && typeof v === "object") {
      if (rnd() < 0.04) return noise();
      const o = {};
      for (const [k, x] of Object.entries(v)) if (rnd() < keep) o[k] = depth < 4 ? mutate(x, depth + 1, k) : x;
      if (rnd() < 0.15) o[pick(["extra", "fIn", "rails", "count", "at", "t", "fill", "rows", "v", "type", "finish", "hex", "u1", "wIn"])] = noise();
      return o;
    }
    if (depth === 1 && (key === "v" || key === "base") && rnd() < 0.9) return v;
    return rnd() < 0.3 ? noise() : typeof v === "number" && rnd() < 0.3 ? v * (0.5 + rnd()) : v;
  };
  let cleaned = 0;
  const distinct = new Set();
  for (let i = 0; i < 3000; i++) {
    const raw = mutate(pick(HAND.slice(0, 7)), 0);
    same(raw);
    const c = sanitizeDoorLook(raw);
    if (c) { cleaned++; distinct.add(JSON.stringify(c)); }
  }
  assert.ok(cleaned > 800 && distinct.size > 500, `the fuzz must reach many different clean specs too (${cleaned} clean, ${distinct.size} distinct)`);
});

// Catalog door sizes (inches), single and double leaves, as ssDoorLeafFt cuts them.
const SIZES = [[30, 72], [36, 72], [36, 80], [36, 81], [42, 84], [48, 76], [60, 72], [72, 72], [72, 76], [72, 80], [96, 84], [24, 18]];
const leaves = SIZES.flatMap(([wi, hi]) => [false, true].map((dbl) => ({ w: dbl ? wi / 24 - 0.08 : wi / 12 - 0.1, h: hi / 12 - 0.25 })));
const bare = (base) => ({ v: 1, base, src: { leaves: 1, hinge: "left" } });

test("a spec that says nothing measures the leaf as its base does (ssDoorLeafPlan)", () => {
  for (const base of DOOR_LOOK_BASES) {
    for (const { w, h } of leaves) {
      assert.deepEqual(plain(twin.ssDoorLeafPlan(base, bare(base), w, h)), plain(twin.ssDoorLeafPlan(base, null, w, h)), `${base} ${w}x${h}`);
    }
  }
  // ...and today's numbers: the built looks' board everywhere, mid rail at 42%; the board door's 0.3 ft frame
  // and its 0.26 ft mid rail at 55%.
  const t = plain(twin.ssDoorLeafPlan("classic", null, 2.9, 6.4)), p = plain(twin.ssDoorLeafPlan("zbrace", null, 2.9, 6.4));
  assert.equal(t.F, Math.min(0.29, 2.9 * 0.16, 6.4 * 0.09));
  assert.equal(t.railH, t.F);
  assert.deepEqual(t.rails, [6.4 * 0.42]);
  assert.deepEqual(t.panels.map((q) => q.fill), ["x", "diamond"]);
  assert.equal(p.F, Math.min(0.3, 2.9 * 0.16, 6.4 * 0.09));
  assert.equal(p.railH, Math.min(0.26, 6.4 * 0.06));
  assert.deepEqual(p.rails, [6.4 * 0.55]);
});

test("a spec that says nothing takes exactly the windows and transoms its base takes (ssDoorWindowFit, ssDoorWindowCount)", () => {
  const wins = [[18, 24], [24, 36], [29, 10], [36, 12], [20, 14], [30, 40], [12, 12]];
  for (const base of DOOR_LOOK_BASES) {
    // A panel window goes only in the four built looks (ssDoorWindowLookOk), so only theirs is measured.
    const ats = DOOR_LOOK_BASE_DEFAULTS[base].rails[0] === 0.42 ? ["panel", "top"] : ["top"];
    for (const { w, h } of leaves) {
      for (const [ww, wh] of wins) {
        for (const at of ats) {
          assert.deepEqual(plain(twin.ssDoorWindowFit(w, h, ww, wh, at, bare(base))), plain(twin.ssDoorWindowFit(w, h, ww, wh, at)), `${base} ${w}x${h} ${ww}x${wh} ${at}`);
        }
      }
    }
    // ...and the whole rule a placed door's windows are counted (and charged) by.
    for (const [wi, hi] of SIZES) {
      for (const operation of ["right", "double", "slideup"]) {
        for (const [ww, wh] of wins) {
          for (const top of [false, true]) {
            const it = { type: "fixtureDoor", widthIn: wi, heightIn: hi, operation, doorWindowId: "w", doorWindowWidthIn: ww, doorWindowHeightIn: wh, doorWindowAt: top ? "top" : null };
            assert.equal(twin.ssDoorWindowCount(it, base, false, bare(base)), twin.ssDoorWindowCount(it, base, false), `${base} ${wi}x${hi} ${operation} ${ww}x${wh} ${top}`);
          }
        }
      }
    }
  }
});

test("a look's own glass up top refuses a panel window, and a rail too high refuses a transom", () => {
  const leaf = { w: 2.9, h: 6.42 };
  const fit = (spec, at, ww = 18, wh = 24) => twin.ssDoorWindowFit(leaf.w, leaf.h, ww, wh, at, spec);
  assert.ok(fit(bare("american"), "panel"), "a plain American takes the lite");
  assert.equal(fit({ ...bare("american"), panels: [{ fill: "pickets" }, { fill: "lite", rows: 2, cols: 2 }] }, "panel"), null, "a lite panel up top");
  assert.equal(fit({ ...bare("basic"), parts: [{ t: "lite", u0: 0.2, v0: 0.6, u1: 0.8, v1: 0.9 }] }, "panel"), null, "a lite part up top");
  assert.ok(fit({ ...bare("basic"), parts: [{ t: "lite", u0: 0.2, v0: 0.1, u1: 0.8, v1: 0.35 }] }, "panel"), "a lite part below the mid rail leaves the top panel free");
  assert.ok(fit(bare("basic"), "top", 29, 10), "a plain Basic takes the transom");
  assert.equal(fit({ ...bare("basic"), frame: { rails: [0.8] } }, "top", 29, 10), null, "a rail at 80% leaves no room for the band");
  // At the edge (this leaf: the band's bottom is 4.927 ft up, a rail's top is its centre + 0.145 ft): 74% fits, 75% does not.
  assert.ok(fit({ ...bare("basic"), frame: { rails: [0.74] } }, "top", 29, 10), "a rail at 74% still leaves room");
  assert.equal(fit({ ...bare("basic"), frame: { rails: [0.75] } }, "top", 29, 10), null, "a rail at 75% does not");
  // A brace across the whole leaf would run across a panel window's glass: none there.
  assert.equal(fit({ ...bare("basic"), brace: { t: "z" } }, "panel"), null, "a leaf brace takes the top panel");
  assert.equal(fit({ ...bare("basic"), parts: [{ t: "lite", u0: 0.2, v0: 0.5, u1: 0.8, v1: 0.9 }] }, "top", 29, 10), null, "nor does glass of its own up there");
  assert.ok(fit(bare("zbrace"), "top", 29, 10), "the board doors still take one");
});

test("a row's look is its own only when its base is the row's door_style; never on a slide-up", () => {
  const row = { id: "d1", doorStyle: "basic", doorLook: { id: "l1", v: 1, spec: STEEL, thumbUrl: null } };
  assert.ok(twin.ssDoorLookSpecOfRow(row));
  assert.equal(twin.ssDoorLookSpecOfRow({ ...row, doorStyle: "classic" }), null);
  assert.equal(twin.ssDoorLookSpecOfRow({ ...row, doorLook: { ...row.doorLook, spec: { ...STEEL, v: 2 } } }), null);
  assert.equal(twin.ssDoorLookSpecOfRow({ id: "d2", doorStyle: "basic" }), null);
  assert.ok(twin.ssDoorCustomLookOf([row], { fixtureItemId: "d1", operation: "left" }));
  assert.equal(twin.ssDoorCustomLookOf([row], { fixtureItemId: "d1", operation: "slideup" }), null);
});
