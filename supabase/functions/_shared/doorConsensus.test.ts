// deno test --allow-read supabase/functions/_shared/doorConsensus.test.ts
// Three reads to one door (doorLook.ts consensusDoorLooks): medians and majorities, the refusals, the
// best-agreement base when the reads split, parts kept 2 of 3 (corner gussets given as diagonals or as
// boards among them), the hinge side's best source; then the
// close-ups and what stands in for a skipped one (settleCloseUps), always with a warning; then Stage B's
// parts, kept only when a Stage A read has them too.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  type DoorCloseUps,
  type DoorConsensus,
  type DoorConsensusResult,
  type DoorMeasureCtx,
  doorLookFromMeasure,
  keepStageBParts,
  settleCloseUps,
  stageADoorLook,
} from "./doorLook.ts";
import { doubleDoor, gussetDoor, inches, nudge, paintAt, PX_PER_IN, singleDoor } from "./_test_stubs/doorReads.ts";

type Rec = Record<string, unknown>;
const ok = (...votes: unknown[]) => ({ status: "ok" as const, votes });
const thrice = (v: unknown) => ok(v, v, v);
const ASKED: DoorCloseUps = { hinges: thrice({ type: "tstrap", finish: "black" }), handle: thrice({ type: "barn" }) };
function cons(r: DoorConsensusResult): DoorConsensus {
  if (!r.ok) throw new Error(`no consensus: ${JSON.stringify(r)}`);
  return r;
}
function settled(c: DoorConsensus, ups: DoorCloseUps = ASKED) {
  const d = settleCloseUps(c, ups);
  if (!d.ok) throw new Error(`did not clean: ${d.error} at ${d.path}`);
  return { spec: d.spec as Rec, codes: d.warnings.map((w) => w.code), warnings: d.warnings };
}
const withMeasure = (read: Rec, patch: Rec): Rec => ({ ...read, measure: { ...read.measure as Rec, ...patch } });
// Three reads of one door: one exact, two a few pixels to either side.
const three = (read: Rec) => [read, nudge(read, (p) => [p[0] + 3, p[1]]), nudge(read, (p) => [p[0] - 3, p[1]])];
const painted = (door: { read: Rec; ctx: DoorMeasureCtx }): DoorMeasureCtx => ({ ...door.ctx, colorAt: paintAt(door.read, door.ctx.photo) });

const SINGLE_SPEC = {
  v: 1,
  base: "zbrace",
  src: { leaves: 1, hinge: "left" },
  frame: { fIn: 5.5, railHIn: 3.5, rails: [0.55] },
  field: { dir: "v", pitchIn: 5 },
  brace: { t: "z", from: "hinge", wIn: 5.5 },
  panels: [{ fill: "none" }, { fill: "none" }],
  hinges: { type: "tstrap", count: 3, at: [0.13, 0.55, 0.87], lenIn: 16, finish: "black" },
  handle: { type: "barn", v: "rail", finish: "black" },
  colors: { infill: "door", frame: "trim", members: "trim" },
};

Deno.test("three reads of one door: numbers take the median, choices the majority, and the spec is clean", () => {
  const door = singleDoor();
  const c = cons(stageADoorLook(three(door.read), painted(door)));
  assertEquals([c.used, c.dropped, c.leaves, c.side, c.sideFrom], [[0, 1, 2], [], 1, "left", "hinges"]);
  const s = settled(c);
  assertEquals(s.spec, SINGLE_SPEC);
  assertEquals(s.codes, []);
  assertEquals(c.split, { base: false, rails: false, hingeCount: false });
  assertEquals(c.observed, ["one leaf", "a Z brace"]);
});

Deno.test("a read with no size echo is dropped and two still make the door; a second drop fails the press", () => {
  const door = singleDoor(), [a, b, c] = three(door.read);
  const noSize = withMeasure(b, { size: undefined });
  const one = cons(stageADoorLook([a, noSize, c], painted(door)));
  assertEquals(one.dropped, [{ read: 1, why: "no_size" }]);
  assertEquals(settled(one).spec, SINGLE_SPEC);
  assertEquals(stageADoorLook([a, noSize, withMeasure(c, { size: [1, 1] })], door.ctx), {
    ok: false,
    fail: "unparseable",
    dropped: [{ read: 1, why: "no_size" }, { read: 2, why: "size_aspect" }],
  });
});

Deno.test("refusals: 3+ leaves or an unsupported kind from ANY read refuses; the rest need two reads", () => {
  const door = singleDoor(), [a, b] = three(door.read);
  const said = (refuse: string) => ({ ...a, refuse });
  assertEquals(stageADoorLook([a, said("open"), said("open")], door.ctx), { ok: false, refuse: "open" });
  assertEquals(stageADoorLook([said("open"), said("blocked"), a], door.ctx), { ok: false, refuse: "open" }, "two refusals, first code on a tie");
  const one = cons(stageADoorLook([a, b, said("blocked")], door.ctx));
  assertEquals(one.dropped, [{ read: 2, why: "refused:blocked" }]);
  assertEquals(stageADoorLook([a, b, { ...a, leaves: 3 }], door.ctx), { ok: false, refuse: "leaves", leaves: 3 });
  assertEquals(stageADoorLook([a, b, said("unsupported")], door.ctx), { ok: false, refuse: "unsupported" });
});

Deno.test("leaves: the majority, the typed count on a tie; a read of the other count measured another door", () => {
  const door = singleDoor(), [a, b] = three(door.read);
  const asDouble = { ...withMeasure(a, { leaves: [] }), leaves: 2 };
  const c = cons(stageADoorLook([a, b, asDouble], door.ctx));
  assertEquals([c.leaves, c.used, c.dropped], [1, [0, 1], [{ read: 2, why: "leaves" }]]);
  assertEquals(stageADoorLook([a, asDouble], door.ctx), { ok: false, fail: "unparseable", dropped: [{ read: 1, why: "leaves" }] });
  // The builder typed double; the photo shows one leaf: the photo wins, and says so.
  const typed = settled(cons(stageADoorLook(three(door.read), { ...door.ctx, leaves: 2 })));
  assertEquals((typed.spec.src as Rec).leaves, 1);
  assertEquals(typed.warnings.find((w) => w.code === "leaves_typed")?.text, "You said this is a double door, but we see one door. We've made it from what we see. Check it before you save.");
});

Deno.test("no majority on the base: the read whose points agreed most (ties: the first), with a warning", () => {
  const door = singleDoor(), d = inches(36, 80), [a, b, c] = three(door.read);
  // The first read puts its mid rail at 30% and so also misses the handle on it: it agrees least.
  const wrong = withMeasure({ ...a, base: "plank" }, { rails: [d.rail(5.5, 30.5, 22.25, 25.75)] });
  const split = cons(stageADoorLook([wrong, b, { ...c, base: "xbrace" }], door.ctx));
  assertEquals([split.spec.base, split.split.base, split.best], ["zbrace", true, 1]);
  assertEquals(split.warnings.find((w) => w.code === "base_split")?.text, "We weren't sure if this is a Z brace, a plank door or an X brace. Check the braces before you save.");
  // Two reads that differ: the plan's own words.
  const two = cons(stageADoorLook([a, { ...b, base: "xbrace" }], door.ctx));
  assertEquals(two.spec.base, "zbrace");
  assertEquals(two.warnings.map((w) => w.text), ["We weren't sure if this is a Z brace or an X brace. Check the braces before you save."]);
  const trim = cons(stageADoorLook([{ ...a, base: "american" }, { ...b, base: "basic" }], door.ctx));
  assertEquals(trim.warnings.map((w) => w.text), ["We weren't sure if this is an American door or a Basic door. Check the door's look before you save."]);
  // Two of three agree: no split.
  const most = cons(stageADoorLook([a, { ...b, base: "xbrace" }, c], door.ctx));
  assertEquals([most.spec.base, most.split.base, most.warnings], ["zbrace", false, []]);
});

Deno.test("parts: kept when two of the three reads have one, at the median corners; one read's part is not a part", () => {
  const lite = singleDoor({ lite: true }).read, bare = singleDoor().read, ctx = singleDoor().ctx;
  const two = settled(cons(stageADoorLook([lite, lite, bare], ctx)));
  assertEquals(two.spec.parts, [{ t: "lite", u0: 0.278, v0: 0.65, u1: 0.722, v1: 0.875, rows: 3, cols: 2 }]);
  assertEquals(settled(cons(stageADoorLook([lite, bare, bare], ctx))).spec.parts, undefined);
});

Deno.test("corner gussets, two reads giving them as diagonals and one as boards: plain panels and the four boards", () => {
  const door = gussetDoor(), diag = door.read, boards = gussetDoor({ asParts: true }).read;
  const c = cons(stageADoorLook([diag, nudge(boards, (p) => [p[0] + 3, p[1]]), nudge(diag, (p) => [p[0] - 3, p[1]])], door.ctx));
  const s = settled(c, { hinges: thrice({ type: "butt", finish: "black" }), handle: thrice({ type: "lever" }) });
  assertEquals([s.spec.brace, s.spec.panels], [{ t: "none" }, [{ fill: "none" }, { fill: "none" }]]);
  const board = (u0: number, v0: number, u1: number, v1: number) => ({ t: "board", u0, v0, u1, v1, wIn: 2, role: "members" });
  assertEquals(s.spec.parts, [
    board(0.042, 0.094, 0.208, 0.019),
    board(0.792, 0.019, 0.958, 0.094),
    board(0.042, 0.906, 0.208, 0.981),
    board(0.792, 0.981, 0.958, 0.906),
  ]);
  assertEquals(s.codes, []);
});

Deno.test("edge strips: the meeting edge's close-ups are cut at the joint in the photo, past the strip", () => {
  const door = doubleDoor({ meetIn: 30 }), px = 2 * PX_PER_IN, photo: [number, number] = [door.ctx.photo[0] + 2 * px, door.ctx.photo[1]];
  const read = withMeasure(nudge(door.read, (p) => [p[0] + px, p[1]]), { size: photo });
  const c = cons(stageADoorLook([read, read, read], { ...door.ctx, photo, padIn: 2 }));
  assertEquals(Math.round(c.meetX! * 1000) / 1000, 0.417, "30 of the door's 72 in, not of the photo's 76");
  assertEquals(c.closeUpAt.meet.map((p) => p.map((v) => Math.round(v * 10) / 10)), [[800, 1000], [800, 1880]], "30 in of 72, 2 in strips: x = 25 px x 32 in");
});

Deno.test("an X brace whose second board two of three reads give in two pieces: the panel's X, no stray boards", () => {
  const door = singleDoor({ brace: "none", base: "xbrace" }), d = inches(36, 80);
  const board = (x0: number, y0: number, x1: number, y1: number) => ({ a: d.p(x0, y0), b: d.p(x1, y1), across: d.line(0, 20, 4, 20) });
  const read = (braces: Rec[]) => ({ ...withMeasure(door.read, { braces }), panels: ["x", "none"] });
  const cut = read([board(7, 7, 29, 40), board(29, 7, 19.7, 20.9), board(16.3, 26.1, 7, 40)]);
  const whole = read([board(7, 7, 29, 40), board(29, 7, 7, 40)]);
  const s = settled(cons(stageADoorLook([cut, nudge(cut, (p) => [p[0] + 3, p[1]]), whole], door.ctx)));
  assertEquals([s.spec.panels, s.spec.parts], [[{ fill: "x", braceWIn: 4 }, { fill: "none" }], undefined]);
});

Deno.test("rails: the count the reads agree on, and a split recorded for the self-check", () => {
  const door = singleDoor(), d = inches(36, 80), [a, b, c] = three(door.read);
  const rails = (c.measure as Rec).rails as unknown[];
  const extra = withMeasure(c, { rails: [...rails, d.rail(5.5, 30.5, 58.25, 61.75)] });
  const r = cons(stageADoorLook([a, b, extra], door.ctx));
  assertEquals([(r.spec.frame as Rec).rails, r.split.rails], [[0.55], true]);
});

Deno.test("hinge side: the best source any read has wins, and a read that guessed the other side is mirrored first", () => {
  const door = singleDoor({ mirror: true }), d = inches(36, 80, true);
  const vent = [{ t: "vent", box: [d.p(4, 10), d.p(12, 20)] }];
  const seen = withMeasure(door.read, { parts: vent });
  // Saw no hinges, no brace and no handle, so it guessed left and measured u from the wrong edge.
  const blind = withMeasure(door.read, { parts: vent, hinges: [], braces: [], handle: null });
  const alone = doorLookFromMeasure(blind, door.ctx);
  assert(alone.ok);
  assertEquals(alone.draft.side, "left");
  const c = cons(stageADoorLook([seen, blind, seen], door.ctx));
  assertEquals([c.side, c.sideFrom, c.aligned[1].side], ["right", "hinges", "right"]);
  // The blind read's vent, measured from the wrong edge (u 0.67-0.89), now sits where the others saw it.
  assertEquals(c.aligned[1].parts.map((p) => [p.u0, p.u1].map((u) => Math.round((u ?? 0) * 1000) / 1000)), [[0.111, 0.333]]);
  const s = settled(c);
  assertEquals(s.spec.parts, [{ t: "vent", u0: 0.111, v0: 0.125, u1: 0.333, v1: 0.25 }]);
  assertEquals(s.codes, [], "the side was read off the hinges");
  // Every read guessed: the best guess (the brace) warns, and its brace rises from the hinge side.
  const guessed = cons(stageADoorLook(three(withMeasure(door.read, { hinges: [] })), door.ctx));
  assertEquals([guessed.side, guessed.sideFrom, (guessed.spec.brace as Rec).from], ["right", "brace", "hinge"]);
  assertEquals(guessed.warnings.map((w) => w.code), ["hinge_side_brace"]);
});

Deno.test("hinges: the count the reads agree on, and a warning whenever they did not all agree", () => {
  const door = singleDoor(), [a, b, c] = three(door.read);
  const hinges = (c.measure as Rec).hinges as unknown[];
  const r = cons(stageADoorLook([a, b, withMeasure(c, { hinges: hinges.slice(0, 2) })], door.ctx));
  assertEquals([(r.spec.hinges as Rec).count, r.split.hingeCount], [3, true]);
  assertEquals(r.warnings.map((w) => w.code), ["hinge_count_split"]);
});

Deno.test("a double: the meeting line's warning, and where the close-ups are cut", () => {
  const door = doubleDoor({ meetIn: 28 });
  const c = cons(stageADoorLook(three(door.read), door.ctx));
  assert(c.warnings.some((w) => w.code === "unequal_leaves"));
  assertEquals(c.closeUpAt.meet.map((p) => p.map((v) => Math.round(v))), [[700, 1000], [700, 1880]]);
  assertEquals(c.closeUpAt.hinges.map((p) => p.map((v) => Math.round(v * 10) / 10)), [[1787.5, 1740], [1787.5, 900], [1787.5, 260]]);
  assertEquals(c.closeUpAt.handle?.map(Math.round), [950, 900]);
  assertEquals(cons(stageADoorLook(three(singleDoor().read), singleDoor().ctx)).closeUpAt.meet, []);
});

// ─── Close-ups and their fallbacks ───────────────────────────────────────────────────────────────
const singleC = () => cons(stageADoorLook(three(singleDoor().read), painted(singleDoor())));
const hardware = (s: Rec) => [(s.hinges as Rec).type, (s.hinges as Rec).finish, (s.handle as Rec).type, (s.handle as Rec).finish];

Deno.test("close-ups decide the hardware when more than half their asks agree", () => {
  const s = settled(singleC(), { hinges: thrice({ type: "Strap", finish: "galv" }), handle: thrice({ type: "ring" }) });
  assertEquals(hardware(s.spec), ["strap", "galv", "ring", "black"]);
  assertEquals(s.codes, []);
  const twoOne = settled(singleC(), { hinges: ok({ type: "scroll" }, { type: "scroll" }, { type: "strap" }), handle: thrice({ type: "barn" }) });
  assertEquals([hardware(twoOne.spec)[0], twoOne.codes], ["scroll", ["hinge_type_split"]]);
});

Deno.test("a skipped, failed or split close-up falls back to Stage A's vote, then the default, and always warns", () => {
  // Skipped: the reads' own words (tstrap, barn), the finish from the colour snap.
  const skipped = settled(singleC(), {});
  assertEquals(hardware(skipped.spec), ["tstrap", "black", "barn", "black"]);
  assertEquals(skipped.codes, ["closeup_hinges", "closeup_handle"]);
  assertEquals(skipped.warnings[0].text, "We didn't get a close look at the hinges. Check the hinge type before you save.");
  // The asks split three ways: no decision, so the same fallback.
  const split = settled(singleC(), { hinges: ok({ type: "strap" }, { type: "scroll" }, { type: "butt" }), handle: { status: "failed" } });
  assertEquals([hardware(split.spec)[0], split.codes], ["tstrap", ["closeup_hinges", "closeup_handle"]]);
  // The reads split too: the table's default.
  const door = singleDoor(), [a, b, c] = three(door.read);
  const mixed = cons(stageADoorLook([{ ...a, hinges: { type: "strap" } }, { ...b, hinges: { type: "scroll" } }, { ...c, hinges: { type: "butt" } }], door.ctx));
  const fallback = settled(mixed, { hinges: { status: "skipped" }, handle: thrice({ type: "lever" }) });
  assertEquals(hardware(fallback.spec), ["tstrap", "black", "lever", "black"], "no colour sampler: black");
  assertEquals(fallback.codes, ["closeup_hinges"]);
});

Deno.test("the meeting edge is asked about on doubles only: its type and width, else Stage A's at 1.5 in, warned", () => {
  const c = cons(stageADoorLook(three(doubleDoor().read), doubleDoor().ctx));
  const asked = settled(c, { ...ASKED, meet: ok({ type: "astragal", wIn: 1.75 }, { type: "astragal", wIn: 2.25 }, { type: "overlap", wIn: 9 }) });
  assertEquals(asked.spec.meet, { type: "astragal", wIn: 2 }, "the width the astragal votes measured");
  const skipped = settled(c, ASKED);
  assertEquals(skipped.spec.meet, { type: "overlap", wIn: 1.5 }, "the reads said overlap");
  assertEquals(skipped.codes, ["closeup_meet"]);
  assertEquals(skipped.warnings[0].text, "We didn't get a close look at where the two doors meet. Check how they meet before you save.");
  assertEquals(settled(singleC(), ASKED).spec.meet, undefined);
});

Deno.test("every close-up that did not decide warns, in every combination", () => {
  const c = cons(stageADoorLook(three(doubleDoor().read), doubleDoor().ctx));
  // Not asked, skipped, failed, asked with no valid answer, and asked and decided.
  const undecided = [undefined, { status: "skipped" as const }, { status: "failed" as const }, ok({ type: "x" }, { type: "x" }, { type: "x" })];
  const answers = (decided: DoorCloseUps[keyof DoorCloseUps]) => [...undecided.map((a) => ({ a, decided: false })), { a: decided, decided: true }];
  for (const h of answers(thrice({ type: "tstrap" }))) {
    for (const k of answers(thrice({ type: "barn" }))) {
      for (const m of answers(thrice({ type: "astragal" }))) {
        const codes = settled(c, { hinges: h.a, handle: k.a, meet: m.a }).codes;
        const at = JSON.stringify({ h, k, m });
        assertEquals(codes.includes("closeup_hinges"), !h.decided, at);
        assertEquals(codes.includes("closeup_handle"), !k.decided, at);
        assertEquals(codes.includes("closeup_meet"), !m.decided, at);
      }
    }
  }
});

// ─── Stage B ─────────────────────────────────────────────────────────────────────────────────────
Deno.test("Stage B's parts: kept only when a Stage A read also has them, else a warning, not a part", () => {
  const lite = singleDoor({ lite: true }), bare = singleDoor().read, d = inches(36, 80);
  const c = cons(stageADoorLook([lite.read, bare, bare], lite.ctx));
  const spec = settleCloseUps(c, ASKED);
  if (!spec.ok) throw new Error("did not clean");
  assertEquals(spec.spec.parts, undefined, "one read of three is not a part");
  const kept = keepStageBParts(c, spec.spec, lite.read, lite.ctx);
  assertEquals([kept.added, (kept.spec.parts as Rec[]).map((p) => p.t), kept.warnings], [1, ["lite"], []]);
  const vent = withMeasure(lite.read, { parts: [{ t: "vent", box: [d.p(14, 8), d.p(22, 16)] }] });
  const refused = keepStageBParts(c, spec.spec, vent, lite.ctx);
  assertEquals([refused.added, refused.spec], [0, spec.spec]);
  assertEquals(refused.warnings.map((w) => w.text), ["We may have seen a vent we couldn't confirm, so we left it out. Add it on the edit screen if it's there."]);
  assertEquals(keepStageBParts(c, spec.spec, { refuse: "open" }, lite.ctx), { spec: spec.spec, added: 0, warnings: [] });
});
