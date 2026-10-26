// Synthetic door reads for the doorLook tests (doorMeasure, doorConsensus, doorCheck). Not a test file
// itself: the _test_stubs group runs only *_test.ts.
//
// A door is drawn in INCHES from its bottom-left corner as seen from outside, at 25 px to the inch, and
// turned into the answer a perfect model would give for its straightened photo (doorLook.ts's measure
// shape). `mirror` hangs the same door the other way: every x becomes width - x.
import type { DoorMeasureCtx, RGB, XY } from "../doorLook.ts";

export const PX_PER_IN = 25;
type Rec = Record<string, unknown>;

export function inches(widthIn: number, heightIn: number, mirror = false) {
  const x = (xIn: number) => (mirror ? widthIn - xIn : xIn) * PX_PER_IN;
  const p = (xIn: number, yIn: number): XY => [x(xIn), (heightIn - yIn) * PX_PER_IN];
  const line = (x0: number, y0: number, x1: number, y1: number): [XY, XY] => [p(x0, y0), p(x1, y1)];
  // A rail from y0 to y1 across [x0, x1].
  const rail = (x0: number, x1: number, y0: number, y1: number) => ({ top: line(x0, y1, x1, y1), bottom: line(x0, y0, x1, y0) });
  return { size: [widthIn * PX_PER_IN, heightIn * PX_PER_IN] as XY, x, p, line, rail };
}

export const PAINT: Record<string, RGB> = {
  infill: [150, 110, 70],
  frame: [240, 240, 235],
  members: [238, 236, 230],
  hardware: [30, 32, 36],
};
// A colour lookup that answers PAINT[role] at each colorAt point of `read` (photo pixels).
export function paintAt(read: Rec, photo: XY): (p: XY) => RGB | null {
  const m = read.measure as Rec, at = (m.colorAt ?? {}) as Record<string, XY>, size = m.size as XY;
  return (p: XY) => {
    for (const [role, q] of Object.entries(at)) {
      if (Math.hypot(q[0] / size[0] * photo[0] - p[0], q[1] / size[1] * photo[1] - p[1]) < 8) return PAINT[role] ?? null;
    }
    return null;
  };
}

export type DoorOpts = { mirror?: boolean; hinges?: boolean; brace?: "z" | "x" | "none"; handle?: boolean; lite?: boolean; base?: string };

// A 36 x 80 in single Z-brace door hinged on the LEFT (right with `mirror`): 5.5 in stiles and head and
// sill rails, a 3.5 in mid rail centred at 44 in (55%), boards on a 5 in pitch, one 5.5 in brace from low
// on the hinge side, three 16 in T-straps at 13 / 55 / 87%, a latch on the mid rail.
export function singleDoor(o: DoorOpts = {}): { read: Rec; ctx: DoorMeasureCtx } {
  const W = 36, H = 80, d = inches(W, H, o.mirror);
  const brace = o.brace ?? "z";
  const braces = brace === "z"
    ? [{ a: d.p(7, 7), b: d.p(29, 73), across: d.line(15, 40, 20.5, 40) }]
    : brace === "x"
    ? [{ a: d.p(7, 7), b: d.p(29, 73), across: d.line(15, 40, 20.5, 40) }, { a: d.p(29, 7), b: d.p(7, 73), across: d.line(15, 40, 20.5, 40) }]
    : [];
  const measure: Rec = {
    size: d.size,
    leaves: [[d.p(0, 0), d.p(W, 0), d.p(W, H), d.p(0, H)]],
    rails: [d.rail(5.5, 30.5, 0, 5.5), d.rail(5.5, 30.5, 42.25, 45.75), d.rail(5.5, 30.5, 74.5, 80)],
    stiles: [{ inner: d.line(5.5, 5, 5.5, 75) }, { inner: d.line(30.5, 5, 30.5, 75) }],
    seams: [10.5, 15.5, 20.5, 25.5].map(d.x),
    braces,
    hinges: o.hinges === false ? [] : [10.4, 44, 69.6].map((y) => ({ pivot: d.p(0.5, y), tip: d.p(16.5, y), across: d.line(8, y - 1, 8, y + 1) })),
    handle: o.handle === false ? null : d.p(34, 44),
    parts: o.lite ? [{ t: "lite", box: [d.p(10, 52), d.p(26, 70)], rows: 3, cols: 2 }] : [],
    colorAt: { infill: d.p(12, 20), frame: d.p(3, 60), members: d.p(18, 40), hardware: d.p(8, 44) },
  };
  const read: Rec = {
    measure,
    refuse: null,
    base: o.base ?? (brace === "z" ? "zbrace" : brace === "x" ? "xbrace" : "plank"),
    leaves: 1,
    hingeSide: o.mirror ? "right" : "left",
    field: "v",
    brace,
    panels: ["none", "none"],
    hinges: { type: "tstrap" },
    handle: { type: "barn" },
    meet: { type: "astragal" },
    observed: ["one leaf", "a Z brace"],
    unexplained: [],
  };
  return { read, ctx: { widthIn: W, heightIn: H, leaves: 1, photo: d.size } };
}

// A 72 x 80 in double: two of singleDoor's leaves, each hinged on its own outer jamb with its Z rising
// from there, the handle on the RIGHT leaf just past the meeting line (left with `mirror`), and a 3 x 2
// lite high in each leaf when `lite`. `meetIn` moves the meeting line (the leaves are then unequal).
export function doubleDoor(o: DoorOpts & { meetIn?: number; oneLite?: boolean } = {}): { read: Rec; ctx: DoorMeasureCtx } {
  const W = 72, H = 80, d = inches(W, H, o.mirror), M = o.meetIn ?? 36;
  const leaf = (x0: number, x1: number) => [d.p(x0, 0), d.p(x1, 0), d.p(x1, H), d.p(x0, H)];
  const measure: Rec = {
    size: d.size,
    leaves: [leaf(0, M), leaf(M, W)],
    meet: d.line(M, 2, M, 78),
    rails: [d.rail(5.5, 30.5, 42.25, 45.75), d.rail(41.5, 66.5, 42.25, 45.75), d.rail(5.5, 30.5, 0, 5.5), d.rail(41.5, 66.5, 0, 5.5)],
    stiles: [5.5, 30.5, 41.5, 66.5].map((x) => ({ inner: d.line(x, 5, x, 75) })),
    seams: [10.5, 15.5, 20.5, 25.5, 46.5, 51.5, 56.5, 61.5].map(d.x),
    braces: o.brace === "none" ? [] : [
      { a: d.p(7, 7), b: d.p(29, 73), across: d.line(15, 40, 20.5, 40) },
      { a: d.p(65, 7), b: d.p(43, 73), across: d.line(51.5, 40, 57, 40) },
    ],
    hinges: o.hinges === false ? [] : [10.4, 44, 69.6].flatMap((y) => [
      { pivot: d.p(0.5, y), tip: d.p(16.5, y) },
      { pivot: d.p(71.5, y), tip: d.p(55.5, y) },
    ]),
    handle: o.handle === false ? null : d.p(38, 44),
    parts: [
      ...(o.lite || o.oneLite ? [{ t: "lite", box: [d.p(10, 52), d.p(26, 70)], rows: 3, cols: 2 }] : []),
      ...(o.lite ? [{ t: "lite", box: [d.p(46, 52), d.p(62, 70)], rows: 3, cols: 2 }] : []),
    ],
  };
  const read: Rec = {
    measure,
    refuse: null,
    base: o.base ?? "zbrace",
    leaves: 2,
    hingeSide: o.mirror ? "left" : "right",
    field: "v",
    brace: o.brace ?? "z",
    panels: ["none", "none"],
    hinges: { type: "tstrap" },
    handle: { type: "barn" },
    meet: { type: "overlap" },
    observed: ["two leaves"],
    unexplained: [],
  };
  return { read, ctx: { widthIn: W, heightIn: H, leaves: 2, photo: d.size } };
}

// The same read with every pixel point moved by `f` (a reader's small error), size echo untouched. The
// seams are x positions alone, so they move as points on the top edge.
export function nudge(read: Rec, f: (p: XY) => XY): Rec {
  const walk = (v: unknown, key: string): unknown => {
    if (key === "size") return v;
    if (key === "seams" && Array.isArray(v)) return v.map((x) => f([x as number, 0])[0]);
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === "number" && typeof v[1] === "number") return f(v as XY);
    if (Array.isArray(v)) return v.map((x) => walk(x, ""));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return { ...read, measure: walk(read.measure, "measure") };
}
