// deno test supabase/functions/_shared/doorCheck.test.ts
// The self-check's rules (doorLook.ts applyDoorCheck): only the allowed paths change, the base and the
// leaf brace only within the plank family, the rails only when the Stage A reads split on them, parts
// only MOVED (never added, removed or retyped), at most 6 fields a round, and the result cleaned again.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { applyDoorCheck, cleanDoorLook, DOOR_CHECK_MAX_FIELDS, doorCheckOscillates, type DoorLook } from "./doorLook.ts";

type Rec = Record<string, unknown>;
function spec(raw: Rec): DoorLook {
  const r = cleanDoorLook(raw);
  if (!r.ok) throw new Error(`${r.error} at ${r.path}`);
  return r.spec;
}
const ZBRACE = spec({
  v: 1,
  base: "zbrace",
  src: { leaves: 1, hinge: "left" },
  frame: { fIn: 5.5, railHIn: 3.5, rails: [0.55] },
  field: { dir: "v", pitchIn: 5 },
  brace: { t: "z", from: "hinge", wIn: 5.5 },
  panels: [{ fill: "none" }, { fill: "none" }],
  parts: [{ t: "lite", u0: 0.3, v0: 0.6, u1: 0.7, v1: 0.85, rows: 3, cols: 2 }, { t: "split", v: 0.5 }],
  hinges: { type: "tstrap", count: 3, at: [0.13, 0.55, 0.87], lenIn: 16, finish: "black" },
  handle: { type: "barn", v: "rail", finish: "black" },
  colors: { infill: "door", frame: "trim", members: "trim" },
});
const CLASSIC = spec({ v: 1, base: "classic", src: { leaves: 2, hinge: "right" } });
const NOT_SPLIT = { railsSplit: false };
const check = (s: DoorLook, corrections: unknown[], ctx = NOT_SPLIT) => applyDoorCheck(s, { corrections }, ctx);
const at = (s: Rec, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o as Rec | undefined)?.[k], s);

Deno.test("the allowed changes: base and brace within the plank family, a panel's fill and its Z, the board direction", () => {
  const r = check(ZBRACE, [
    { path: "base", to: "xbrace" },
    { path: "brace.t", to: "none" },
    { path: "panels[0].fill", to: "x" },
    { path: "panels[1].fill", to: "z" },
    { path: "panels[1].zFrom", to: "strike" },
    { path: "field.dir", to: "H" },
  ]);
  assertEquals(r.rejected, []);
  assertEquals(r.applied, ["base", "brace.t", "panels[0].fill", "panels[1].fill", "panels[1].zFrom", "field.dir"]);
  assertEquals([r.spec.base, at(r.spec, "brace.t"), r.spec.panels, at(r.spec, "field.dir")], [
    "xbrace",
    "none",
    [{ fill: "x" }, { fill: "z", zFrom: "strike" }],
    "h",
  ]);
  assertEquals(check(ZBRACE, [{ path: "brace.from", to: "strike" }]).spec.brace, { t: "z", from: "strike", wIn: 5.5 });
});

Deno.test("locked: the leaves, the hinge side, everything measured, and the hardware the close-ups set", () => {
  const locked = [
    ["src.leaves", 2], ["src.hinge", "right"], ["frame.fIn", 3], ["frame.railHIn", 2], ["field.pitchIn", 8],
    ["hinges.type", "butt"], ["hinges.count", 2], ["hinges.at", [0.2, 0.8]], ["hinges.lenIn", 9], ["hinges.finish", "galv"],
    ["handle.type", "lever"], ["handle.v", 0.4], ["handle.finish", "bronze"], ["meet.type", "overlap"], ["meet.wIn", 3],
    ["colors.frame", "door"], ["brace.wIn", 3], ["panels[0].braceWIn", 3], ["v", 2],
  ];
  const r = check(ZBRACE, locked.map(([path, to]) => ({ path, to })));
  assertEquals(r.applied, []);
  assertEquals(r.rejected.map((x) => x.why), locked.map(() => "locked"));
  assertEquals(r.spec, ZBRACE);
  // A rail move is locked too while the reads agreed on the rails.
  assertEquals(check(ZBRACE, [{ path: "frame.rails", to: [0.4] }]).rejected, [{ path: "frame.rails", why: "locked" }]);
});

Deno.test("the base and the leaf brace move only within plank / zbrace / xbrace", () => {
  assertEquals(check(ZBRACE, [{ path: "base", to: "classic" }]).rejected, [{ path: "base", why: "base_family" }]);
  assertEquals(check(CLASSIC, [{ path: "base", to: "basic" }]).rejected, [{ path: "base", why: "base_family" }]);
  assertEquals(check(CLASSIC, [{ path: "base", to: "zbrace" }]).rejected, [{ path: "base", why: "base_family" }]);
  assertEquals(check(CLASSIC, [{ path: "brace.t", to: "z" }, { path: "brace.from", to: "strike" }]).rejected.map((x) => x.why), ["brace_family", "brace_family"]);
  // A trim look's panels may still change: "panels[i].fill" is not a base move.
  assertEquals(check(CLASSIC, [{ path: "panels[1].fill", to: "lite" }]).spec.panels, [{ fill: "x" }, { fill: "lite" }]);
});

Deno.test("at most 6 fields a round; a correction that changes nothing does not count", () => {
  const eight = [
    { path: "base", to: "zbrace" }, // no change
    { path: "base", to: "plank" },
    { path: "brace.t", to: "x" },
    { path: "panels[0].fill", to: "pickets" },
    { path: "panels[1].fill", to: "vent" },
    { path: "field.dir", to: "smooth" },
    { path: "parts[1]", move: { dv: 0.05 } },
    { path: "parts[0]", move: { du: 0.05 } },
    { path: "brace.from", to: "strike" },
  ];
  const r = check(ZBRACE, eight);
  assertEquals(r.applied.length, DOOR_CHECK_MAX_FIELDS);
  assertEquals(r.rejected, [{ path: "base", why: "no_change" }, { path: "parts[0]", why: "cap" }, { path: "brace.from", why: "cap" }]);
});

Deno.test("parts move by the measured difference, capped, and are never added, removed, replaced or retyped", () => {
  const moved = check(ZBRACE, [{ path: "parts[0]", move: { du: 0.05, dv: -0.1 } }, { path: "parts[1]", move: { dv: -0.05 } }]);
  assertEquals(moved.spec.parts, [{ t: "lite", u0: 0.35, v0: 0.5, u1: 0.75, v1: 0.75, rows: 3, cols: 2 }, { t: "split", v: 0.45 }]);
  const corner = check(ZBRACE, [{ path: "parts[0]", move: { du1: 0.1, dv1: 0.5 } }]);
  assertEquals(corner.spec.parts && (corner.spec.parts as Rec[])[0], { t: "lite", u0: 0.3, v0: 0.6, u1: 0.8, v1: 1, rows: 3, cols: 2 }, "0.5 capped at 0.2, and kept on the leaf");
  const refused = check(ZBRACE, [
    { path: "parts[2]", move: { du: 0.1 } },
    { path: "parts", to: [] },
    { path: "parts[0]", to: null },
    { path: "parts[0]", to: { t: "vent", u0: 0, v0: 0, u1: 0.5, v1: 0.5 } },
    { path: "parts[1].t", to: "board" },
    { path: "parts[0]", move: { du1: -0.2, du0: 0.2 } }, // would leave the lite 0 wide
    { path: "parts[0]", move: {} },
  ]);
  assertEquals(refused.rejected.map((x) => x.why), ["no_part", "move_only", "move_only", "move_only", "move_only", "bad_move", "no_change"]);
  assertEquals(refused.spec, ZBRACE);
});

Deno.test("whatever a round sends, the parts that come back are the parts that went in", () => {
  const paths = ["parts[0]", "parts[1]", "parts[2]", "parts", "parts[0].u0", "base", "panels[0].fill"];
  for (let seed = 1; seed < 200; seed++) {
    let x = seed;
    const rnd = () => ((x = (x * 16807) % 2147483647) / 2147483647);
    const corrections = Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => ({
      path: paths[Math.floor(rnd() * paths.length)],
      move: { du: rnd() - 0.5, dv: rnd() - 0.5 },
      ...(rnd() < 0.3 ? { to: rnd() < 0.5 ? null : { t: "vent" } } : {}),
    }));
    const r = check(ZBRACE, corrections);
    assertEquals((r.spec.parts as Rec[]).map((p) => p.t), ["lite", "split"], `seed ${seed}`);
  }
});

Deno.test("the mid rails change only when the Stage A reads split on them, and the panels follow", () => {
  const split = { railsSplit: true };
  const r = check(ZBRACE, [{ path: "frame.rails", to: [0.7, 0.4] }, { path: "panels[2].fill", to: "lite" }], split);
  assertEquals(r.applied, ["frame.rails", "panels[2].fill"]);
  assertEquals(at(r.spec, "frame.rails"), [0.4, 0.7]);
  assertEquals(r.spec.panels, [{ fill: "none" }, { fill: "none" }, { fill: "lite" }]);
  assertEquals(check(ZBRACE, [{ path: "frame.rails", to: [0.55] }], split).rejected, [{ path: "frame.rails", why: "no_change" }]);
  assertEquals(check(ZBRACE, [{ path: "frame.rails", to: "two" }], split).rejected, [{ path: "frame.rails", why: "bad_value" }]);
  const fewer = check(ZBRACE, [{ path: "frame.rails", to: [] }], split);
  assertEquals([at(fewer.spec, "frame.rails"), fewer.spec.panels], [[], [{ fill: "none" }]]);
});

Deno.test("a Z's direction only on a Z panel; no panel past the last; bad values and odd answers change nothing", () => {
  const r = check(ZBRACE, [
    { path: "panels[0].zFrom", to: "strike" },
    { path: "panels[2].fill", to: "x" },
    { path: "panels[0].fill", to: "glass" },
    { path: "frame", to: {} },
    { path: 7 },
    "base",
  ]);
  assertEquals(r.rejected.map((x) => x.why), ["not_z", "no_panel", "bad_value", "unknown", "unreadable", "unreadable"]);
  assertEquals(r.spec, ZBRACE);
  for (const answer of [null, "fix it", { corrections: "base" }, 42]) assertEquals(applyDoorCheck(ZBRACE, answer, NOT_SPLIT), { spec: ZBRACE, applied: [], rejected: [] });
  // The bare list is read like {corrections: [...]}.
  assertEquals(applyDoorCheck(ZBRACE, [{ path: "base", to: "plank" }], NOT_SPLIT).spec.base, "plank");
});

Deno.test("the round's result is cleaned again, so it is a spec the renderer accepts", () => {
  const r = check(ZBRACE, [{ path: "panels[0].fill", to: "z" }]);
  assertEquals(r.spec.panels, [{ fill: "z" }, { fill: "none" }]);
  const again = cleanDoorLook(r.spec);
  assert(again.ok);
  assertEquals(again.spec, r.spec);
});

Deno.test("oscillation: a round that brings back a draft an earlier round had", () => {
  const a = ZBRACE, b = check(a, [{ path: "base", to: "xbrace" }]).spec, c = check(b, [{ path: "base", to: "plank" }]).spec;
  assertEquals(doorCheckOscillates([a], b), false);
  assertEquals(doorCheckOscillates([a, b], a), true, "A -> B -> A");
  assertEquals(doorCheckOscillates([a, b, c], a), true);
  assertEquals(doorCheckOscillates([a, b], b), false, "no change is not an oscillation");
  assertEquals(doorCheckOscillates([a, b], c), false);
});
