// ─── DOOR LOOKS FROM A PHOTO: THE SPEC, ITS CLEANER, AND THE MATHS ON THE AI'S READS (2026-10-26) ──
// Phase P1 of "door looks from a photo" (the plan of 2026-10-24, sections 3 and 4). A builder's own 3D
// door is not a new renderer. It is a small spec laid over one of today's built door looks (the "base",
// which is what `fixture_items.door_style` already holds): measured overrides plus a short list of extra
// parts. The AI reads the straightened photo and answers in PIXEL POINTS; this file turns the reads into
// one spec, and holds the one cleaner every spec goes through on its way in -- an AI answer, a
// self-check round and a builder's edit alike.
//
// PURE: no I/O and no imports. portal-settings is the only importer, and the designer twins carry a
// copy of the table (SS_DOOR_LOOK_FIELDS, the JSON of DOOR_LOOK_FIELDS; doorLook.test.ts holds the
// three copies equal).
//
// THE SPEC DESCRIBES ONE LEAF: the latch (active) leaf, the one with the handle. `u` runs across it from
// its HINGE edge (0) to its latch edge (1) -- on a double, the latch edge is the meeting edge -- and `v`
// up it from the bottom (0) to the top (1). Because `u` starts at the hinge, one spec draws a door hung
// either way, and the other leaf of a double is its mirror with no handle. Positions are fractions, so
// the layout scales with the door; board, brace and hardware widths are inches, because a real board
// does not get wider on a bigger door. An ABSENT key means "today's rule" (DOOR_LOOK_BASE_DEFAULTS and
// the renderer), never zero, which is why the cleaner never fills defaults in.

type Rec = Record<string, unknown>;
export type XY = [number, number];
export type RGB = [number, number, number];
export type DoorSide = "left" | "right";

export const DOOR_LOOK_VERSION = 1;
export const DOOR_LOOK_MAX_BYTES = 4096;

export const DOOR_LOOK_BASES = ["plank", "zbrace", "xbrace", "american", "basic", "classic", "dutch"] as const;
export type DoorLookBase = typeof DOOR_LOOK_BASES[number];
// The only bases the self-check may switch between: they are one leaf builder (plankDoorLeaf) told
// which brace to lay over the boards. The four trim looks are a different builder and a different door.
export const DOOR_PLANK_FAMILY: readonly DoorLookBase[] = ["plank", "zbrace", "xbrace"];
export const DOOR_PANEL_FILLS = ["none", "z", "x", "pickets", "vent", "raised", "diamond", "lite"] as const;
export type DoorPanelFill = typeof DOOR_PANEL_FILLS[number];
export const DOOR_PART_TYPES = ["board", "lite", "vent", "raised", "split"] as const;
export type DoorPartType = typeof DOOR_PART_TYPES[number];
export const DOOR_FIELD_DIRS = ["v", "h", "smooth", "grooved"] as const;
export const DOOR_BRACE_TYPES = ["none", "z", "x"] as const;
export const DOOR_HINGE_TYPES = ["tstrap", "strap", "scroll", "butt", "hidden", "pintle"] as const;
export const DOOR_HANDLE_TYPES = ["barn", "lever", "pull", "ring", "thumb", "none"] as const;
export const DOOR_FINISHES = ["black", "galv", "bronze", "custom"] as const;
export const DOOR_MEET_TYPES = ["astragal", "overlap"] as const;
// The three finishes a photo's hardware snaps to. The photo's own hex is never the colour.
export const DOOR_FINISH_HEX = { black: "#23272E", galv: "#9AA0A6", bronze: "#5A4632" } as const;

// What each base draws today, as the spec says it: the mid rails (centres, as fractions of the leaf's
// height), the fill of each panel from the bottom, and the brace across the whole leaf. Read off
// plankDoorLeaf and trimDoorLeaf: a mid rail at 55% on the plank family and 42% on the trim looks; the
// Z rises from the hinge side over the mid rail; xbrace's X is in the LOWER panel only (Carolyn,
// 2026-09-04); Classic's upper panel is the octagon round a diamond (`diamond`) over an X; Dutch is a
// small louvred vent low down. P2's leaf builders take these as the fills a spec overrides.
export const DOOR_LOOK_BASE_DEFAULTS: Record<DoorLookBase, { rails: number[]; panels: DoorPanelFill[]; brace: "none" | "z" | "x" }> = {
  plank: { rails: [0.55], panels: ["none", "none"], brace: "none" },
  zbrace: { rails: [0.55], panels: ["none", "none"], brace: "z" },
  xbrace: { rails: [0.55], panels: ["x", "none"], brace: "none" },
  american: { rails: [0.42], panels: ["pickets", "none"], brace: "none" },
  basic: { rails: [0.42], panels: ["none", "none"], brace: "none" },
  classic: { rails: [0.42], panels: ["x", "diamond"], brace: "none" },
  dutch: { rails: [0.42], panels: ["vent", "none"], brace: "none" },
};

// ─── THE TABLE ────────────────────────────────────────────────────────────────────────────────────
// One table defines every key's type, limits and (where it is a constant) default, and the cleaner below
// is an interpreter of it: there is no second list of keys to fall out of step. That is the styleD3 trap
// this rules out -- a key clamped in one table and then silently dropped by a whitelist kept elsewhere.
//
// Plain JSON on purpose, so the designer twins can carry it verbatim (SS_DOOR_LOOK_FIELDS) and run the
// same walker in the browser: a spec that fails cleaning there is ignored and the base look drawn.
//
//   k      int | num | enum | hex | role | nums | or | obj | list | union
//   req    required: a missing one fails the spec (inside a list item, it drops that item)
//   strict an int out of range is that error, never clamped (3 leaves is refused, not drawn as 2)
//   dp     decimals kept      most  longest list kept     gap  least gap between sorted numbers
//   when   kept only while a sibling key holds one of the listed values
//   pos    a positional list: a bad item becomes null ("the base's own for this place"), never shifts
//   rule   a named cross-key rule below (RULES), run after the keys are cleaned
//   def    the constant default, for the close-up fallbacks and the renderer; the cleaner never adds it
type When = { key: string; in: readonly string[] };
type NodeCommon = { req?: boolean; when?: When };
export type DoorFieldNode =
  | NodeCommon & { k: "int"; min: number; max: number; strict?: string; def?: number }
  | NodeCommon & { k: "num"; min: number; max: number; dp: number; def?: number }
  | NodeCommon & { k: "enum"; of: readonly string[]; def?: string }
  | NodeCommon & { k: "hex" }
  | NodeCommon & { k: "role" }
  | NodeCommon & { k: "nums"; min: number; max: number; dp: number; most: number; gap?: number }
  | NodeCommon & { k: "or"; of: readonly DoorFieldNode[]; def?: string | number }
  | NodeCommon & { k: "obj"; keys: Record<string, DoorFieldNode>; rule?: string }
  | NodeCommon & { k: "list"; most: number; of: DoorFieldNode; pos?: boolean }
  | NodeCommon & { k: "union"; by: string; of: Record<string, DoorFieldNode> };

const FRACTION: DoorFieldNode = { k: "num", min: 0, max: 1, dp: 3, req: true };
const BOX = { u0: FRACTION, v0: FRACTION, u1: FRACTION, v1: FRACTION };
const FINISH: DoorFieldNode = { k: "enum", of: DOOR_FINISHES, def: "black" };
const CUSTOM_HEX: DoorFieldNode = { k: "hex", when: { key: "finish", in: ["custom"] } };
const FROM: DoorFieldNode = { k: "enum", of: ["hinge", "strike"], def: "hinge" };

export const DOOR_LOOK_FIELDS: DoorFieldNode = {
  k: "obj",
  rule: "door",
  keys: {
    v: { k: "int", min: DOOR_LOOK_VERSION, max: DOOR_LOOK_VERSION, req: true, strict: "version" },
    base: { k: "enum", of: DOOR_LOOK_BASES, req: true },
    src: {
      k: "obj",
      req: true,
      keys: {
        leaves: { k: "int", min: 1, max: 2, req: true, strict: "unsupported" },
        hinge: { k: "enum", of: ["left", "right"], req: true }, // the hinge side of the latch leaf
      },
    },
    frame: {
      k: "obj",
      keys: {
        fIn: { k: "num", min: 1.5, max: 8, dp: 1 },
        railHIn: { k: "num", min: 1.5, max: 8, dp: 1 },
        rails: { k: "nums", min: 0.15, max: 0.85, dp: 3, most: 3, gap: 0.08 }, // mid-rail centres
      },
    },
    field: {
      k: "obj",
      keys: {
        dir: { k: "enum", of: DOOR_FIELD_DIRS },
        pitchIn: { k: "num", min: 3, max: 12, dp: 1 },
      },
    },
    brace: {
      k: "obj",
      keys: {
        t: { k: "enum", of: DOOR_BRACE_TYPES }, // one brace across the whole leaf, over the mid rail
        from: FROM, // which side a `z` rises from
        wIn: { k: "num", min: 2, max: 8, dp: 1 },
      },
    },
    panels: {
      k: "list",
      most: 4,
      pos: true,
      of: {
        k: "obj",
        keys: {
          fill: { k: "enum", of: DOOR_PANEL_FILLS, req: true },
          zFrom: { ...FROM, when: { key: "fill", in: ["z"] } },
          count: { k: "int", min: 2, max: 12, when: { key: "fill", in: ["pickets"] } },
          rows: { k: "int", min: 1, max: 6, def: 1, when: { key: "fill", in: ["lite"] } },
          cols: { k: "int", min: 1, max: 6, def: 1, when: { key: "fill", in: ["lite"] } },
          braceWIn: { k: "num", min: 2, max: 8, dp: 1, when: { key: "fill", in: ["z", "x", "diamond"] } },
        },
      },
    },
    parts: {
      k: "list",
      most: 12,
      of: {
        k: "union",
        by: "t",
        of: {
          board: {
            k: "obj",
            rule: "line",
            keys: { ...BOX, wIn: { k: "num", min: 2, max: 8, dp: 1 }, role: { k: "enum", of: ["frame", "members"] } },
          },
          lite: {
            k: "obj",
            rule: "box",
            keys: { ...BOX, rows: { k: "int", min: 1, max: 6, def: 1 }, cols: { k: "int", min: 1, max: 6, def: 1 } },
          },
          vent: { k: "obj", rule: "box", keys: BOX },
          raised: { k: "obj", rule: "box", keys: BOX },
          // A groove across both leaves; the door does not open in two.
          split: { k: "obj", keys: { v: { k: "num", min: 0.2, max: 0.8, dp: 3, req: true } } },
        },
      },
    },
    hinges: {
      k: "obj",
      rule: "hinges",
      keys: {
        type: { k: "enum", of: DOOR_HINGE_TYPES, def: "tstrap" },
        count: { k: "int", min: 0, max: 4 },
        // 0.01-0.99, not 0.05-0.95: the head and sill rails' hinges sit about 2.5% in from the leaf's ends,
        // and held at 0.05 / 0.95 they drew off their rails (P2 keeps every hinge on the leaf).
        at: { k: "or", of: [{ k: "enum", of: ["rails"] }, { k: "nums", min: 0.01, max: 0.99, dp: 3, most: 4 }] },
        lenIn: { k: "num", min: 3, max: 30, dp: 1 },
        finish: FINISH,
        hex: CUSTOM_HEX,
      },
    },
    handle: {
      k: "obj",
      rule: "finish",
      keys: {
        type: { k: "enum", of: DOOR_HANDLE_TYPES, def: "barn" },
        v: { k: "or", def: "rail", of: [{ k: "enum", of: ["rail"] }, { k: "num", min: 0.3, max: 0.7, dp: 3 }] },
        finish: FINISH,
        hex: CUSTOM_HEX,
      },
    },
    meet: {
      k: "obj",
      keys: {
        type: { k: "enum", of: DOOR_MEET_TYPES, def: "astragal" },
        wIn: { k: "num", min: 1, max: 3.5, dp: 2, def: 1.5 },
      },
    },
    colors: { k: "obj", keys: { infill: { k: "role" }, frame: { k: "role" }, members: { k: "role" } } },
  },
};

// Every key path the table allows ("parts[].lite.rows"): the whitelist, generated from the table.
export function doorLookPaths(node: DoorFieldNode = DOOR_LOOK_FIELDS, path = ""): string[] {
  switch (node.k) {
    case "obj":
      return Object.entries(node.keys).flatMap(([key, sub]) => doorLookPaths(sub, joinPath(path, key)));
    case "list":
      return doorLookPaths(node.of, `${path}[]`);
    case "union":
      return [joinPath(path, node.by), ...Object.entries(node.of).flatMap(([t, sub]) => doorLookPaths(sub, joinPath(path, t)))];
    default:
      return [path];
  }
}

// The table's constant default at a key path ("hinges.type"), or undefined when the default is a rule.
export function doorLookDefault(path: string): unknown {
  let node: DoorFieldNode | undefined = DOOR_LOOK_FIELDS;
  for (const key of path.split(".")) node = node?.k === "obj" && Object.hasOwn(node.keys, key) ? node.keys[key] : undefined;
  return node && "def" in node ? node.def : undefined;
}

// ─── THE CLEANER ──────────────────────────────────────────────────────────────────────────────────
// REBUILD a clean object from the table's keys; never store what the caller sent. Numbers out of range
// are clamped, unknown keys and bad values are dropped (and listed), and three things fail the whole
// spec: a missing required key, a version this code does not know, and 3 or more leaves (refused as
// unsupported, never clamped to 2).
export type DoorLook = { v: number; base: DoorLookBase; src: { leaves: 1 | 2; hinge: DoorSide } } & Rec;
export type DoorLookCleaned =
  | { ok: true; spec: DoorLook; dropped: string[]; clamped: string[] }
  | { ok: false; error: string; path: string };

type CleanCx = { dropped: string[]; clamped: string[]; err: { error: string; path: string } | null };
const newCx = (): CleanCx => ({ dropped: [], clamped: [], err: null });
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const joinPath = (path: string, key: string) => (path ? `${path}.${key}` : key);
const NUM_TEXT = /^\s*-?\d+(\.\d+)?\s*$/;
// A JSON number, or a string that is plainly one (an edit form's input). Anything else is no number.
function numOf(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && NUM_TEXT.test(v)) return Number(v);
  return undefined;
}
const roundTo = (x: number, dp: number) => {
  const f = 10 ** dp, r = Math.round(x * f) / f;
  return r === 0 ? 0 : r; // never -0
};
const clampTo = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const HEX = /^#?([0-9a-f]{6})$/i;
const hexOf = (v: unknown) => {
  const m = typeof v === "string" ? HEX.exec(v.trim()) : null;
  return m ? `#${m[1].toUpperCase()}` : undefined;
};
const drop = (cx: CleanCx, path: string): undefined => {
  if (!cx.dropped.includes(path)) cx.dropped.push(path);
  return undefined;
};
// A list is read this many times its limit at most, so an answer padded with thousands of entries costs
// nothing to clean.
const SCAN = 4;

function cleanNode(node: DoorFieldNode, raw: unknown, path: string, cx: CleanCx): unknown {
  if (raw === undefined || raw === null) return undefined;
  switch (node.k) {
    case "int":
    case "num": {
      const n = numOf(raw);
      if (n === undefined) return drop(cx, path);
      const x = node.k === "int" ? roundTo(n, 0) : roundTo(n, node.dp);
      if (x >= node.min && x <= node.max) return x;
      if (node.k === "int" && node.strict) {
        cx.err ??= { error: node.strict, path };
        return undefined;
      }
      cx.clamped.push(path);
      return clampTo(x, node.min, node.max);
    }
    case "enum": {
      const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
      return node.of.includes(s) ? s : drop(cx, path);
    }
    case "hex":
      return hexOf(raw) ?? drop(cx, path);
    case "role": {
      const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
      return s === "door" || s === "trim" ? s : hexOf(raw) ?? drop(cx, path);
    }
    case "nums": {
      if (!Array.isArray(raw)) return drop(cx, path);
      const xs = raw.slice(0, node.most * SCAN).map(numOf).filter((n): n is number => n !== undefined);
      const fit = xs.map((n) => clampTo(roundTo(n, node.dp), node.min, node.max)).sort((a, b) => a - b);
      if (xs.some((n) => n < node.min || n > node.max)) cx.clamped.push(path);
      const kept: number[] = [];
      for (const x of fit) {
        if (kept.length < node.most && (!kept.length || x - kept[kept.length - 1] >= (node.gap ?? 0) - 1e-9)) kept.push(x);
      }
      if (kept.length !== raw.length) drop(cx, path);
      return kept;
    }
    case "or": {
      for (const alt of node.of) {
        const tryCx = newCx();
        const v = cleanNode(alt, raw, path, tryCx);
        if (v !== undefined && !tryCx.err) {
          cx.dropped.push(...tryCx.dropped);
          cx.clamped.push(...tryCx.clamped);
          return v;
        }
      }
      return drop(cx, path);
    }
    case "obj":
      return cleanObj(node, raw, path, cx);
    case "list": {
      if (!Array.isArray(raw)) return drop(cx, path);
      const items = raw.slice(0, node.pos ? node.most : node.most * SCAN);
      if (items.length < raw.length) drop(cx, `${path}[${items.length}..]`);
      const out: unknown[] = [];
      items.forEach((item, i) => {
        const p = `${path}[${i}]`;
        if (!node.pos && out.length >= node.most) return void drop(cx, p);
        // An item's own failure (a missing corner, say) drops that item, not the spec.
        const itemCx = newCx();
        const v = cleanNode(node.of, item, p, itemCx);
        cx.dropped.push(...itemCx.dropped);
        cx.clamped.push(...itemCx.clamped);
        if (v === undefined || itemCx.err) {
          if (item !== null && item !== undefined) drop(cx, p);
          if (node.pos) out.push(null);
        } else out.push(v);
      });
      while (out.length && out[out.length - 1] === null) out.pop();
      return out.length ? out : undefined;
    }
    case "union": {
      if (!isRec(raw)) return drop(cx, path);
      const t = typeof raw[node.by] === "string" ? (raw[node.by] as string).trim().toLowerCase() : "";
      if (!Object.hasOwn(node.of, t)) return drop(cx, path);
      const rest = { ...raw };
      delete rest[node.by];
      const v = cleanNode(node.of[t], rest, path, cx);
      return isRec(v) ? { [node.by]: t, ...v } : undefined;
    }
  }
}

function cleanObj(node: Extract<DoorFieldNode, { k: "obj" }>, raw: unknown, path: string, cx: CleanCx): Rec | undefined {
  if (!isRec(raw)) return drop(cx, path);
  const keys = Object.keys(node.keys);
  let out: Rec = {};
  for (const key of keys) {
    const v = cleanNode(node.keys[key], raw[key], joinPath(path, key), cx);
    if (v !== undefined) out[key] = v;
  }
  for (const key of Object.keys(raw)) if (!Object.hasOwn(node.keys, key)) drop(cx, joinPath(path, key));
  for (const key of keys) {
    const w = node.keys[key].when;
    if (w && out[key] !== undefined && !w.in.includes(String(out[w.key]))) {
      delete out[key];
      drop(cx, joinPath(path, key));
    }
  }
  if (node.rule) {
    const ruled = RULES[node.rule](out, path, cx);
    if (!ruled) return undefined;
    out = ruled;
  }
  for (const key of keys) {
    if (node.keys[key].req && out[key] === undefined) {
      cx.err ??= { error: "missing", path: joinPath(path, key) };
      return undefined;
    }
  }
  const ordered: Rec = {};
  for (const key of keys) if (out[key] !== undefined) ordered[key] = out[key];
  return Object.keys(ordered).length ? ordered : undefined;
}

// A board whose ends are closer than this both ways (of the leaf's width across, of its height up) is no
// board. It was 0.08, which on an 80 in door is 6.4 in up: a real corner gusset read a little short
// (the first door generated from a photo: 0.06 by 0.04 of the leaf, about 2 by 3.5 in) was dropped.
export const DOOR_BOARD_MIN = 0.05;

// The rules one key's limits cannot say. Each gets the cleaned object and returns it (changed), or
// undefined when the object is not a thing that can be drawn.
const RULES: Record<string, (o: Rec, path: string, cx: CleanCx) => Rec | undefined> = {
  // Panels sit between the mid rails, so there is one more panel than rails (one rail when absent, as
  // every base has). Extra panels could never be drawn.
  door(o, _path, cx) {
    const rails = isRec(o.frame) ? o.frame.rails : undefined;
    const want = (Array.isArray(rails) ? rails.length : 1) + 1;
    if (Array.isArray(o.panels) && o.panels.length > want) {
      drop(cx, `panels[${want}..]`);
      const kept = o.panels.slice(0, want);
      while (kept.length && kept[kept.length - 1] === null) kept.pop();
      if (kept.length) o.panels = kept;
      else delete o.panels;
    }
    return o;
  },
  // `custom` is a finish only with its hex; the hex itself is kept only with `custom` (its `when`).
  finish(o, path, cx) {
    if (o.finish === "custom" && o.hex === undefined) {
      delete o.finish;
      drop(cx, joinPath(path, "finish"));
    }
    return o;
  },
  // One position per hinge, and no hinges at all only when they are hidden ones. Positions sent without
  // a count are the count.
  hinges(o, path, cx) {
    RULES.finish(o, path, cx);
    if (Array.isArray(o.at) && o.count === undefined) o.count = o.at.length;
    if (o.count === 0 && o.type !== "hidden") {
      delete o.count;
      drop(cx, joinPath(path, "count"));
      if (Array.isArray(o.at)) delete o.at;
    }
    if (Array.isArray(o.at) && o.at.length !== o.count) {
      delete o.at;
      drop(cx, joinPath(path, "at"));
    }
    return o;
  },
  // A lite, vent or raised panel: corners in either order, at least 0.08 of the leaf each way.
  box(o) {
    const [u0, u1, v0, v1] = [o.u0, o.u1, o.v0, o.v1];
    if (typeof u0 !== "number" || typeof u1 !== "number" || typeof v0 !== "number" || typeof v1 !== "number") return o;
    const box = { u0: Math.min(u0, u1), v0: Math.min(v0, v1), u1: Math.max(u0, u1), v1: Math.max(v0, v1) };
    if (box.u1 - box.u0 < 0.08 - 1e-9 || box.v1 - box.v0 < 0.08 - 1e-9) return undefined;
    return { ...o, ...box };
  },
  // A board runs between its two ends, which must be apart (DOOR_BOARD_MIN one way or the other).
  line(o) {
    const [u0, u1, v0, v1] = [o.u0, o.u1, o.v0, o.v1];
    if (typeof u0 !== "number" || typeof u1 !== "number" || typeof v0 !== "number" || typeof v1 !== "number") return o;
    return Math.max(Math.abs(u1 - u0), Math.abs(v1 - v0)) < DOOR_BOARD_MIN - 1e-9 ? undefined : o;
  },
};

// The cleaner with its working shown: what it dropped and clamped, or why it refused. `maxBytes`
// exists for the test of the size guard; nothing else passes it.
export function cleanDoorLook(raw: unknown, opts: { maxBytes?: number } = {}): DoorLookCleaned {
  if (!isRec(raw)) return { ok: false, error: "not_object", path: "" };
  const cx = newCx();
  const spec = cleanNode(DOOR_LOOK_FIELDS, raw, "", cx);
  if (cx.err) return { ok: false, ...cx.err };
  if (!isRec(spec)) return { ok: false, error: "missing", path: "v" };
  if (new TextEncoder().encode(JSON.stringify(spec)).length > (opts.maxBytes ?? DOOR_LOOK_MAX_BYTES)) {
    return { ok: false, error: "too_big", path: "" };
  }
  return { ok: true, spec: spec as DoorLook, dropped: cx.dropped, clamped: cx.clamped };
}

// The cleaner as portal-settings calls it on every save: the clean spec, or null when there is no spec
// to be had (not an object, a base outside the seven, another version, 3 or more leaves, too big).
// Never throws.
export function sanitizeDoorLook(raw: unknown): DoorLook | null {
  const r = cleanDoorLook(raw);
  return r.ok ? r.spec : null;
}

// ─── WARNINGS AND REFUSALS, IN THE BUILDER'S WORDS ────────────────────────────────────────────────
export type DoorWarning = { code: string; text: string };
export const DOOR_WARNINGS = {
  hinge_side_brace: "We couldn't see the hinges, so we guessed their side from the brace. Check the hinge side.",
  hinge_side_handle: "We couldn't see the hinges, so we put them opposite the handle. Check the hinge side.",
  hinge_side_default: "We couldn't see the hinges, so we put them on the left. Check the hinge side.",
  latch_leaf_default: "We couldn't see a handle, so we put it on the left door. Check which door has the handle.",
  unequal_leaves: "The two doors aren't the same width. We've drawn them equal.",
  hinge_count_split: "We weren't sure how many hinges there are. Check the hinges before you save.",
  hinge_type_split: "We weren't sure what kind of hinges these are. Check the hinge type before you save.",
  closeup_hinges: "We didn't get a close look at the hinges. Check the hinge type before you save.",
  closeup_handle: "We didn't get a close look at the handle. Check the handle before you save.",
  closeup_meet: "We didn't get a close look at where the two doors meet. Check how they meet before you save.",
  hinge_finish_unsure: "We couldn't tell the hinges' colour from the close look. Check their finish before you save.",
  handle_finish_unsure: "We couldn't tell the handle's colour from the close look. Check its finish before you save.",
} as const;
const warn = (code: keyof typeof DOOR_WARNINGS): DoorWarning => ({ code, text: DOOR_WARNINGS[code] });
const BASE_NAMES: Record<DoorLookBase, string> = {
  plank: "a plank door",
  zbrace: "a Z brace",
  xbrace: "an X brace",
  american: "an American door",
  basic: "a Basic door",
  classic: "a Classic door",
  dutch: "a Dutch door",
};
const PART_NAMES: Record<DoorPartType, string> = { board: "a board", lite: "a window", vent: "a vent", raised: "a raised panel", split: "a split line" };
const orList = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}`);
function baseSplitWarning(bases: DoorLookBase[]): DoorWarning {
  const check = bases.every((b) => DOOR_PLANK_FAMILY.includes(b)) ? "the braces" : "the door's look";
  return { code: "base_split", text: `We weren't sure if this is ${orList(bases.map((b) => BASE_NAMES[b]))}. Check ${check} before you save.` };
}
const leavesWarning = (typed: 1 | 2, seen: 1 | 2): DoorWarning => ({
  code: "leaves_typed",
  text: `You said this is a ${typed === 2 ? "double" : "single"} door, but we see ${seen === 2 ? "two doors" : "one door"}. ` +
    "We've made it from what we see. Check it before you save.",
});
const stageBWarning = (t: DoorPartType): DoorWarning => ({
  code: "stageb_part",
  text: `We may have seen ${PART_NAMES[t]} we couldn't confirm, so we left it out. Add it on the edit screen if it's there.`,
});
function pushWarning(list: DoorWarning[], w: DoorWarning) {
  if (!list.some((x) => x.code === w.code)) list.push(w);
}

// What a read may refuse with (the prompt's REFUSE list). `leaves` is 3 or more leaves or a bi-fold; a
// read that counts 3 or more leaves refuses with it whatever it says. Nothing here is charged.
export const DOOR_REFUSE_CODES = ["not_door", "open", "blocked", "angled", "unsupported", "leaves"] as const;
export type DoorRefuseCode = typeof DOOR_REFUSE_CODES[number];
export const DOOR_REFUSALS: Record<DoorRefuseCode, { code: "ai_door_refused" | "ai_door_unsupported"; text: string }> = {
  not_door: { code: "ai_door_refused", text: "We couldn't find a door in this photo." },
  open: { code: "ai_door_refused", text: "Close the door and take the photo again." },
  blocked: { code: "ai_door_refused", text: "Something is in front of the door. Clear it and take the photo again." },
  angled: { code: "ai_door_refused", text: "This photo was taken too far to one side. Stand straight in front of the door and try again." },
  unsupported: {
    code: "ai_door_unsupported",
    text: "We can't make this kind of door from a photo yet. For garage and roll-up doors, use the Roll-up look.",
  },
  leaves: { code: "ai_door_unsupported", text: "We can only make single and double doors from a photo for now." },
};

// ─── SMALL HELPERS ────────────────────────────────────────────────────────────────────────────────
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isXY = (v: unknown): v is XY => Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]);
const isLine = (v: unknown): v is [XY, XY] => Array.isArray(v) && v.length === 2 && isXY(v[0]) && isXY(v[1]);
const isQuad = (v: unknown): v is XY[] => Array.isArray(v) && v.length === 4 && v.every(isXY);
function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const medianOf = (v: (number | null | undefined)[]) => {
  const xs = v.filter(isNum);
  return xs.length ? median(xs) : null;
};
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
function enumIn<T extends string>(v: unknown, of: readonly T[]): T | null {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return (of as readonly string[]).includes(s) ? s as T : null;
}
// Values within `tol` of their neighbour, grouped (one rail seen on both leaves of a double, say).
function groups<T>(items: T[], key: (t: T) => number, tol: number): T[][] {
  const out: T[][] = [];
  for (const it of [...items].sort((a, b) => key(a) - key(b))) {
    const last = out[out.length - 1];
    if (last && key(it) - key(last[last.length - 1]) <= tol) last.push(it);
    else out.push([it]);
  }
  return out;
}

// A vote: the most common value, ties to the first one seen (the first read).
export type DoorVote<T> = { value: T | null; n: number; of: number; unanimous: boolean };
function vote<T>(vals: (T | null | undefined)[]): DoorVote<T> {
  const seen = vals.filter((v): v is T => v !== null && v !== undefined);
  const counts = new Map<T, number>();
  for (const v of seen) counts.set(v, (counts.get(v) ?? 0) + 1);
  let value: T | null = null, n = 0;
  for (const [v, c] of counts) if (c > n) [value, n] = [v, c];
  return { value, n, of: seen.length, unanimous: seen.length > 0 && n === seen.length };
}

// ─── POINTS TO NUMBERS ────────────────────────────────────────────────────────────────────────────
// One read of the door, the model's own JSON (section 4's answer shape), to the numbers of a spec in the
// latch leaf's u, v. Every point is normalised by the size the model ECHOED, because that is the image
// the points were read off; a read whose echoed size is more than 2% off the photo's own shape read some
// other image, and is dropped. The photo is straightened to the leaves' outer edges, so a point's y over
// the height is its fraction down the door. Across, the photo also shows a strip ctx.padIn inches wide
// past each side edge (DOOR_LOOK_V2: the knuckles of butt hinges sit ON the edge, so a photo cut there
// halves them), so the door runs from padIn to padIn + widthIn of the photo's widthIn + 2 x padIn inches;
// with padIn 0, a point's x over the width is its fraction across the door.
//
// The measure shape (the P4 prompt asks for exactly this; points are [x, y] pixels):
//   size [w, h]                       the image's size, echoed first
//   leaves [[4 corners] per leaf]     meet [p, p]  the meeting line of a double
//   rails [{top: [p, p], bottom: [p, p]}]  every horizontal rail, head and sill included
//   stiles [{inner: [p, p]}]          seams [x, ...]  board joints (y on a door of level boards)
//   braces [{a, b, across: [p, p]}]   every diagonal, across its width
//   hinges [{pivot, tip, across}]     handle p
//   parts [{t: "lite"|"vent"|"raised", box: [p, p], rows, cols} | {t: "board", a, b, across, role}
//          | {t: "split", line: [p, p]}]
//   colorAt {infill, frame, members, hardware}
//
// Where the points and the model's own words disagree (its rail count, its brace), the points win.
export const DOOR_SIZE_ASPECT_TOL = 0.02;
export const DOOR_UNEQUAL_TOL = 0.1; // a meeting line further off centre than this, of the door's width
const DOOR_RAIL_TOL = 0.04; // one rail; a handle "on the rail"; one split line (the section 9 bar)
const DOOR_HINGE_TOL = 0.05; // one hinge
const DOOR_FRAME_BAND = 0.12; // a rail centred this close to the head or sill is the frame's own rail
const DOOR_MATCH = 0.08; // two boards' ends this close are one board
// A diagonal in a panel is that panel's Z or X only when it rises at least DOOR_PANEL_DIAG_RISE of the
// panel's height (rail centre to rail centre) AND runs at least DOOR_PANEL_DIAG_RUN of the panel's
// opening (its leaf less the two stiles, never under half the leaf). Shorter, it is a board part (a
// corner gusset). The corpus (2026-10-27): a panel's Z or X rises >= 0.75 and runs >= 0.61 of its leaf;
// a corner gusset or Classic's octagon brace rises <= 0.22 and runs <= 0.22.
export const DOOR_PANEL_DIAG_RISE = 0.5;
export const DOOR_PANEL_DIAG_RUN = 0.4;
// Two diagonals are one board cut in two (an X's second board is usually butted against the first) when,
// measured against the board they would join into (their two farthest ends): every end of both lies
// within a board's width of its line, each runs along it within DOOR_CUT_SIN (the sine of the angle,
// about 8 degrees), and the gap between them along it is no more than the crossing board's footprint
// (w / sin 2a for a board at angle a, sin 2a never under DOOR_CUT_SIN2_MIN) plus a board width, and never
// under two widths. Overlapping pieces have no gap. A board whose width the read did not give counts as
// DOOR_CUT_W_IN.
const DOOR_CUT_SIN = 0.14;
const DOOR_CUT_SIN2_MIN = 0.25;
const DOOR_CUT_W_IN = 4;

export type DoorHingeSideSource = "hinges" | "brace" | "handle" | "latch" | "default" | "given";
export type DoorMeasureCtx = {
  widthIn: number; // the door's real size: both leaves, inside the casing, threshold to head
  heightIn: number;
  leaves: 1 | 2; // what the builder typed
  photo: XY; // the straightened photo's own size in pixels
  // Inches of photo past each side edge of the door (the edge strips); 0 or absent: the photo's own side
  // edges are the leaves'.
  padIn?: number;
  // The 5 x 5 median at a photo pixel (samplePatch over the decoded photo). Absent: no colour roles.
  colorAt?: (p: XY) => RGB | null;
  // Measure in a frame already decided (Stage B, against the consensus): no side or leaf inference.
  frame?: { leaves: 1 | 2; side: DoorSide; meetX: number | null };
};
type DraftPart = { t: DoorPartType; u0?: number; v0?: number; u1?: number; v1?: number; v?: number; rows?: number; cols?: number; wIn?: number; role?: string };
type DraftPanel = { fill: DoorPanelFill | null; zFrom?: "hinge" | "strike"; count?: number; rows?: number; cols?: number; braceWIn?: number };
export type DoorReadDraft = {
  base: DoorLookBase | null;
  leaves: 1 | 2;
  side: DoorSide;
  sideFrom: DoorHingeSideSource;
  meetX: number | null; // the meeting line, a fraction of the door's width (doubles)
  rails: number[] | null; // mid-rail centres; null when the read gave no rail points
  railHIn: number | null;
  fIn: number | null;
  fieldDir: string | null;
  pitchIn: number | null;
  brace: { t: "none" | "z" | "x"; from: "hinge" | "strike" | null; wIn: number | null } | null;
  panels: DraftPanel[] | null;
  hingeCount: number | null;
  hingeAt: number[] | null;
  hingeLenIn: number | null;
  handleV: number | "rail" | null;
  parts: DraftPart[];
  colors: { infill?: string; frame?: string; members?: string } | null;
  finish: "black" | "galv" | "bronze" | null;
  handleFinish: "black" | "galv" | "bronze" | null; // the snap at measure.handle
  stageA: { hingeType: string | null; handleType: string | null; meetType: string | null };
  px: { hinges: XY[]; handle: XY | null }; // photo pixels, where the close-ups are cut
  observed: string[];
  unexplained: string[];
};
export type DoorReadResult =
  | { ok: true; draft: DoorReadDraft; warnings: DoorWarning[] }
  | { ok: false; refuse: DoorRefuseCode; leaves?: number }
  | { ok: false; drop: "unreadable" | "no_size" | "size_aspect" };

// The hinge side of the latch leaf, and how it was found. Only hinge points are a reading; every other
// way is a guess, and every guess warns (sideWarning). A single: the hinge points' side; else the low
// end of a lone Z brace, taken to rise from the hinge side (today's build and the common one); else
// opposite the handle; else left. A double hinges on both outer jambs, so the hinges cannot say which
// leaf is the latch leaf: the handle does. Seen hinges and a handle are a reading; a handle alone is the
// "opposite the handle" guess; hinges with no handle leave the latch leaf to the left default.
function hingeSideOf(leaves: 1 | 2, meetX: number, pivots: XY[], loneZLow: XY | null, handle: XY | null): { side: DoorSide; from: DoorHingeSideSource } {
  if (leaves === 1) {
    if (pivots.length) return { side: mean(pivots.map((p) => p[0])) < 0.5 ? "left" : "right", from: "hinges" };
    if (loneZLow) return { side: loneZLow[0] < 0.5 ? "left" : "right", from: "brace" };
    if (handle) return { side: handle[0] < 0.5 ? "right" : "left", from: "handle" };
    return { side: "left", from: "default" };
  }
  if (handle) return { side: handle[0] < meetX ? "left" : "right", from: pivots.length ? "hinges" : "handle" };
  return { side: "left", from: pivots.length ? "latch" : "default" };
}
export function sideWarning(from: DoorHingeSideSource): DoorWarning | null {
  if (from === "brace") return warn("hinge_side_brace");
  if (from === "handle") return warn("hinge_side_handle");
  if (from === "latch") return warn("latch_leaf_default");
  if (from === "default") return warn("hinge_side_default");
  return null;
}

export function doorLookFromMeasure(read: unknown, ctx: DoorMeasureCtx): DoorReadResult {
  if (!isRec(read)) return { ok: false, drop: "unreadable" };
  const refuse = typeof read.refuse === "string" ? read.refuse.trim().toLowerCase() : "";
  if (refuse) {
    const code = enumIn(refuse, DOOR_REFUSE_CODES);
    return code ? { ok: false, refuse: code } : { ok: false, drop: "unreadable" };
  }
  const m: Rec = isRec(read.measure) ? read.measure : {};
  const quads = Array.isArray(m.leaves) ? m.leaves.filter(isQuad) : [];
  const said = Math.round(numOf(read.leaves) ?? 0);
  // 3 or more, by its points OR its word, refuses: drawing it as 2 would be clamping it.
  if (Math.max(quads.length, said) >= 3) return { ok: false, refuse: "leaves", leaves: Math.max(quads.length, said) };
  const counted = quads.length || said;
  const leaves: 1 | 2 = ctx.frame?.leaves ?? (counted === 1 || counted === 2 ? counted : ctx.leaves);

  const size = m.size;
  if (!isXY(size) || size[0] <= 0 || size[1] <= 0) return { ok: false, drop: "no_size" };
  if (Math.abs(size[0] / size[1] / (ctx.photo[0] / ctx.photo[1]) - 1) > DOOR_SIZE_ASPECT_TOL + 1e-9) return { ok: false, drop: "size_aspect" };
  // Image to door fractions, and back to photo pixels. Across, the photo is the door plus a strip of padIn
  // inches each side: a point in a strip (a butt hinge's knuckle) lands on the door's edge.
  const pad = Math.max(0, ctx.padIn ?? 0), spanIn = ctx.widthIn + 2 * pad;
  const rawX = (x: number) => ((x / size[0]) * spanIn - pad) / ctx.widthIn; // under 0 or over 1: in a strip
  const frX = (x: number) => clampTo(rawX(x), 0, 1);
  const fr = (p: XY): XY => [frX(p[0]), clampTo(p[1] / size[1], 0, 1)];
  const toPhoto = (f: XY): XY => [((pad + f[0] * ctx.widthIn) / spanIn) * ctx.photo[0], f[1] * ctx.photo[1]];
  const midX = (l: [XY, XY]) => (fr(l[0])[0] + fr(l[1])[0]) / 2;
  const midY = (l: [XY, XY]) => (fr(l[0])[1] + fr(l[1])[1]) / 2;
  // A width measured across two points, in inches (the door's own scale both ways).
  const acrossIn = (l: unknown) => {
    if (!isLine(l)) return null;
    const [a, b] = [fr(l[0]), fr(l[1])];
    return Math.hypot((b[0] - a[0]) * ctx.widthIn, (b[1] - a[1]) * ctx.heightIn);
  };

  const base = enumIn(read.base, DOOR_LOOK_BASES);
  const fieldDir = enumIn(read.field, DOOR_FIELD_DIRS);

  // The meeting line: its own points, else between the two leaves' inner edges, else the centre.
  let meetX: number | null = null;
  if (leaves === 2) {
    let own: number | null = isLine(m.meet) ? midX(m.meet) : null;
    if (own === null && quads.length === 2) {
      const [l, r] = quads.map((q) => q.map(fr)).sort((a, b) => mean(a.map((p) => p[0])) - mean(b.map((p) => p[0])));
      const inner = (q: XY[], right: boolean) => mean(q.map((p) => p[0]).sort((a, b) => (right ? b - a : a - b)).slice(0, 2));
      own = (inner(l, true) + inner(r, false)) / 2;
    }
    meetX = clampTo(ctx.frame?.meetX ?? own ?? 0.5, 0.2, 0.8);
  }
  const mx = meetX ?? 0.5;
  const leafOfX = (x: number): 0 | 1 => (leaves === 2 && x >= mx ? 1 : 0);

  // Rails. Head and sill rails are the frame's own; the rest are mid rails, one per height (a double
  // shows each rail once per leaf). railHIn is the mid rails' height: on the plank family that is the
  // mid rail alone (plankDoorLeaf's midH), on the trim looks every rail is the frame board.
  const defRails = DOOR_LOOK_BASE_DEFAULTS[base ?? "plank"].rails;
  let rails: number[] | null = null, railHIn: number | null = null;
  if (Array.isArray(m.rails)) {
    const seen = m.rails.filter((r): r is Rec => isRec(r) && isLine(r.top) && isLine(r.bottom)).map((r) => {
      const top = 1 - midY(r.top as [XY, XY]), bottom = 1 - midY(r.bottom as [XY, XY]);
      return { c: (top + bottom) / 2, hIn: Math.abs(top - bottom) * ctx.heightIn };
    });
    const mids = groups(seen.filter((r) => r.c > DOOR_FRAME_BAND && r.c < 1 - DOOR_FRAME_BAND), (r) => r.c, DOOR_RAIL_TOL);
    rails = mids.map((g) => median(g.map((r) => r.c)));
    railHIn = medianOf(mids.flat().map((r) => r.hIn));
  }
  const effRails = rails ?? defRails;
  const panelAt = (v: number) => effRails.filter((r) => r <= v).length;

  // Diagonals. One that crosses a mid rail and runs at least half the leaf's height is a brace across
  // the whole leaf; the rest belong to the panel their middle is in. Whether one of those is the panel's
  // Z or X or a short corner gusset is decided with the panels, since it needs the stiles' width.
  const braceList = Array.isArray(m.braces) ? m.braces.filter((b): b is Rec => isRec(b) && isXY(b.a) && isXY(b.b)) : null;
  const diagOf = (a: XY, c: XY, wIn: number | null) => {
    const [lo, hi] = a[1] >= c[1] ? [a, c] : [c, a]; // a larger y is lower in the image
    const vLo = 1 - lo[1], vHi = 1 - hi[1], panel = panelAt((vLo + vHi) / 2);
    return {
      a,
      c,
      lo,
      leaf: leafOfX((a[0] + c[0]) / 2),
      span: vHi - vLo >= 0.5 && effRails.some((r) => r > vLo && r < vHi),
      panel,
      rise: (vHi - vLo) / ((effRails[panel] ?? 1) - (effRails[panel - 1] ?? 0) || 1), // of its panel's height
      runIn: Math.abs(c[0] - a[0]) * ctx.widthIn,
      wIn,
    };
  };
  const braces = (braceList ?? []).map((b) => diagOf(fr(b.a as XY), fr(b.b as XY), acrossIn(b.across)));
  // A board cut in two is one diagonal (DOOR_CUT_SIN): join such a pair in one leaf, end to end, and
  // measure the joined board again. In one panel always; across panels only when the joined board is a
  // brace across the leaf (an X over the whole leaf, its second board butted at the crossing). Gussets at
  // opposite corners are parallel but on lines far apart; a Z in each panel is two lines too.
  const inIn = (p: XY): XY => [p[0] * ctx.widthIn, p[1] * ctx.heightIn];
  const apartIn = (p: XY, q: XY) => Math.hypot((p[0] - q[0]) * ctx.widthIn, (p[1] - q[1]) * ctx.heightIn);
  for (let i = 0; i < braces.length; i++) {
    for (let j = i + 1; j < braces.length; j++) {
      const p = braces[i], q = braces[j];
      if (p.span || q.span || p.leaf !== q.leaf) continue;
      const w = Math.max(p.wIn ?? 0, q.wIn ?? 0) || DOOR_CUT_W_IN;
      const pairs: [XY, XY][] = [[p.a, p.c], [q.a, q.c], [p.a, q.a], [p.a, q.c], [p.c, q.a], [p.c, q.c]];
      const [e0, e1] = pairs.reduce((best, e) => (apartIn(e[0], e[1]) > apartIn(best[0], best[1]) ? e : best));
      const [E0, E1] = [inIn(e0), inIn(e1)], E = [E1[0] - E0[0], E1[1] - E0[1]], L = Math.hypot(E[0], E[1]) || 1;
      const off = (x: XY) => { const P = inIn(x); return Math.abs(E[0] * (E0[1] - P[1]) - (E0[0] - P[0]) * E[1]) / L; };
      const along = (x: XY) => { const P = inIn(x); return ((P[0] - E0[0]) * E[0] + (P[1] - E0[1]) * E[1]) / L; };
      const sinTo = (a: XY, c: XY) => { const [A, C] = [inIn(a), inIn(c)]; return Math.abs((C[0] - A[0]) * E[1] - (C[1] - A[1]) * E[0]) / ((Math.hypot(C[0] - A[0], C[1] - A[1]) || 1) * L); };
      if ([p.a, p.c, q.a, q.c].some((x) => off(x) > w) || sinTo(p.a, p.c) > DOOR_CUT_SIN || sinTo(q.a, q.c) > DOOR_CUT_SIN) continue;
      const [p0, p1] = [along(p.a), along(p.c)].sort((x, y) => x - y), [q0, q1] = [along(q.a), along(q.c)].sort((x, y) => x - y);
      const sin2 = Math.max((2 * Math.abs(E[0] * E[1])) / (L * L), DOOR_CUT_SIN2_MIN);
      if (Math.max(q0 - p1, p0 - q1, 0) > Math.max(2 * w, w / sin2 + w)) continue;
      const joined = diagOf(e0, e1, medianOf([p.wIn, q.wIn]));
      if (p.panel !== q.panel && !joined.span) continue;
      braces[i] = joined;
      braces.splice(j, 1);
      j = i; // the joined board may meet a third piece
    }
  }
  const hingeList = Array.isArray(m.hinges) ? m.hinges.filter((h): h is Rec => isRec(h) && isXY(h.pivot)) : [];
  const pivots = hingeList.map((h) => ({ p: fr(h.pivot as XY), tip: isXY(h.tip) ? fr(h.tip) : null, raw: h.pivot as XY, rawTip: isXY(h.tip) ? h.tip : null, leaf: 0 as 0 | 1 }));
  for (const h of pivots) h.leaf = leafOfX(h.p[0]);
  const handle = isXY(m.handle) ? fr(m.handle) : null;

  const spans = braces.filter((b) => b.span);
  const found = ctx.frame
    ? { side: ctx.frame.side, from: "given" as const }
    : hingeSideOf(leaves, mx, pivots.map((h) => h.p), leaves === 1 && spans.length === 1 ? spans[0].lo : null, handle);
  const side = found.side;

  // Into the latch leaf: u from each leaf's own hinge edge. On a double that is each leaf's outer jamb,
  // so a point on the other leaf lands mirrored into the latch leaf with no extra step.
  const latchLeaf: 0 | 1 = leaves === 2 && side === "right" ? 1 : 0;
  const uOf = (x: number, leaf: 0 | 1) =>
    clampTo(leaves === 1 ? (side === "left" ? x : 1 - x) : leaf === 0 ? x / mx : (1 - x) / (1 - mx), 0, 1);
  const leafWIn = (leaf: 0 | 1) => (leaves === 1 ? 1 : leaf === 0 ? mx : 1 - mx) * ctx.widthIn;
  // The latch leaf's own items when it has any, else the other leaf's (mirrored by uOf).
  const latchFirst = <T extends { leaf: 0 | 1 }>(xs: T[]) => {
    const own = xs.filter((x) => x.leaf === latchLeaf);
    return own.length ? own : xs.filter((x) => x.leaf !== latchLeaf);
  };
  const fromOf = (lo: XY, leaf: 0 | 1) => (uOf(lo[0], leaf) < 0.5 ? "hinge" as const : "strike" as const);

  // Frame: each stile's width is its inner edge's distance from its leaf's nearest edge. An edge read in an
  // edge strip is on the jamb or casing, not the door: it is no stile (clamped, it would be one 0 in wide).
  const inStrip = (l: [XY, XY]) => { const x = (rawX(l[0][0]) + rawX(l[1][0])) / 2; return x < 0 || x > 1; };
  const stiles = Array.isArray(m.stiles) ? m.stiles.filter((s): s is Rec => isRec(s) && isLine(s.inner) && !inStrip(s.inner)) : [];
  const fIn = medianOf(stiles.map((s) => {
    const x = midX(s.inner as [XY, XY]), leaf = leafOfX(x), u = uOf(x, leaf);
    return Math.min(u, 1 - u) * leafWIn(leaf);
  }));

  // Board pitch: the gaps between neighbouring seams on each leaf (heights, on level boards).
  let pitchIn: number | null = null;
  if (Array.isArray(m.seams)) {
    const seams = m.seams.slice(0, 64).map(numOf).filter(isNum);
    const gaps: number[] = [];
    const runs = fieldDir === "h"
      ? [{ at: seams.map((y) => 1 - clampTo(y / size[1], 0, 1)), scale: ctx.heightIn }]
      : ([0, 1] as const).map((leaf) => ({
        at: seams.map(frX).filter((x) => leafOfX(x) === leaf).map((x) => uOf(x, leaf)),
        scale: leafWIn(leaf),
      }));
    for (const run of runs) {
      const s = [...run.at].sort((a, b) => a - b);
      for (let i = 1; i < s.length; i++) if (s[i] - s[i - 1] > 0.02) gaps.push((s[i] - s[i - 1]) * run.scale);
    }
    pitchIn = medianOf(gaps);
  }

  // The brace across the leaf: one diagonal is a Z, two an X; none, when the read gave diagonals but
  // none spans, is no brace (the points win). No diagonals key at all: the read's own word.
  let brace: DoorReadDraft["brace"] = null;
  if (braceList) {
    const across = latchFirst(spans);
    const t = across.length === 0 ? "none" : across.length === 1 ? "z" : "x";
    brace = { t, from: t === "z" ? fromOf(across[0].lo, across[0].leaf) : null, wIn: medianOf(across.map((b) => b.wIn)) };
  } else {
    const t = enumIn(read.brace, DOOR_BRACE_TYPES);
    if (t) brace = { t, from: null, wIn: null };
  }

  // Panels: the read's own fills, bottom first, fitted to the rails the points found (one more panel
  // than rails), then the full diagonals in each panel overrule a none / z / x fill -- only when the
  // rails were measured, since they are what says which panel a diagonal is in. A short diagonal in such
  // a panel is a corner gusset and becomes a board part. Diamond, pickets and the rest have no point of
  // their own, so the read's word stands and its diagonals stay its own (a diamond's octagon braces).
  const said2 = Array.isArray(read.panels) ? read.panels.slice(0, 8).map(panelOfAnswer) : null;
  const nPanels = rails ? rails.length + 1 : said2?.length ? Math.min(said2.length, 4) : 0;
  let panels: DraftPanel[] | null = null;
  const gussets: typeof braces = [];
  if (nPanels) {
    const src = said2 ?? [];
    // Too many: keep the bottom ones and the top one (the top panel is the one a look is known by).
    const fit = src.length <= nPanels ? src : [...src.slice(0, nPanels - 1), src[src.length - 1]];
    panels = Array.from({ length: nPanels }, (_, i) => (fit[i] ? { ...fit[i] } : { fill: null }));
    if (braceList && rails) {
      // A panel's diagonal is its Z or X when it rises most of the panel and runs most of the panel's
      // opening: its leaf less the two stiles, never under half the leaf (a bad stile read cannot shrink
      // the opening to nothing). The rest are corner gussets.
      type Diag = (typeof braces)[number];
      const full = (b: Diag) =>
        b.rise >= DOOR_PANEL_DIAG_RISE && b.runIn >= DOOR_PANEL_DIAG_RUN * Math.max(leafWIn(b.leaf) - 2 * (fIn ?? 0), leafWIn(b.leaf) / 2);
      // Which corner of its panel a gusset is at: the hinge or latch half, the top or bottom half.
      const cornerOf = (b: Diag) =>
        (uOf((b.a[0] + b.c[0]) / 2, b.leaf) < 0.5 ? 1 : 0) + (1 - (b.a[1] + b.c[1]) / 2 >= ((rails[b.panel - 1] ?? 0) + (rails[b.panel] ?? 1)) / 2 ? 2 : 0);
      panels.forEach((p, i) => {
        const own = braces.filter((b) => !b.span && b.panel === i);
        const decides = p.fill === null || p.fill === "none" || p.fill === "z" || p.fill === "x";
        const inside = latchFirst(decides ? own.filter(full) : own);
        if (decides) {
          p.fill = inside.length === 0 ? (p.fill === null ? null : "none") : inside.length === 1 ? "z" : "x";
          // The latch leaf's own gussets, and the other leaf's only at a corner where the latch leaf has none:
          // mirrored by fraction, the two leaves' copies of one gusset do not meet when the leaves are unequal.
          const short = own.filter((b) => !full(b)), mine = short.filter((b) => b.leaf === latchLeaf);
          gussets.push(...mine, ...short.filter((b) => b.leaf !== latchLeaf && !mine.some((q) => cornerOf(q) === cornerOf(b))));
        }
        if (p.fill === "z" && inside.length === 1) p.zFrom = fromOf(inside[0].lo, inside[0].leaf);
        const w = medianOf(inside.map((b) => b.wIn));
        if (w !== null && (p.fill === "z" || p.fill === "x" || p.fill === "diamond")) p.braceWIn = w;
      });
    }
  }

  // Hinges: positions up the latch leaf, one per hinge (both leaves of a double show the same ones);
  // the strap's length from pivot to tip on every hinge that shows one. The length is taken from the
  // points as read, held to the photo, since a T-strap's pivot sits on the jamb, in the edge strip, and
  // clamped to the leaf it would lose that much. A strap reads short far more often than long (cut off by
  // the photo's edge, hidden, foreshortened), so the upper median of the straps decides; the single
  // longest never does on its own. A strap longer than its own leaf is no strap, and a tip given at its
  // pivot (the prompt's "no strap") counts only when no hinge shows one.
  const hingeType = enumIn(isRec(read.hinges) ? read.hinges.type : null, DOOR_HINGE_TYPES);
  let hingeCount: number | null = null, hingeAt: number[] | null = null;
  const ownHinges = latchFirst(pivots);
  if (ownHinges.length) {
    hingeAt = groups(ownHinges.map((h) => 1 - h.p[1]), (v) => v, DOOR_HINGE_TOL).map(median);
    hingeCount = hingeAt.length;
  } else if (hingeType === "hidden") [hingeCount, hingeAt] = [0, []];
  const inPhoto = (p: XY): XY => [clampTo(rawX(p[0]), -pad / ctx.widthIn, 1 + pad / ctx.widthIn), clampTo(p[1] / size[1], 0, 1)];
  const lens = pivots.flatMap((h) => {
    if (!h.rawTip) return [];
    const [a, b] = [inPhoto(h.raw), inPhoto(h.rawTip)];
    const len = Math.hypot((b[0] - a[0]) * ctx.widthIn, (b[1] - a[1]) * ctx.heightIn);
    return len <= leafWIn(h.leaf) ? [len] : [];
  });
  const straps = (lens.some((v) => v >= 1) ? lens.filter((v) => v >= 1) : lens).sort((a, b) => a - b);
  const hingeLenIn = straps.length ? straps[Math.floor(straps.length / 2)] : null;

  const handleV = handle ? (effRails.some((r) => Math.abs(1 - handle[1] - r) <= DOOR_RAIL_TOL) ? "rail" : 1 - handle[1]) : null;

  // Parts, in the latch leaf. On a double the other leaf's copy of a part is the same part mirrored, so
  // it is kept only when the latch leaf has nothing there.
  const placed: (DraftPart & { leaf: 0 | 1 })[] = [];
  for (const raw of Array.isArray(m.parts) ? m.parts.slice(0, 48) : []) {
    if (!isRec(raw)) continue;
    const t = enumIn(raw.t, DOOR_PART_TYPES);
    if (t === "split") {
      const l = isLine(raw.line) ? raw.line : isLine(raw.box) ? raw.box : null;
      if (l) placed.push({ t, v: 1 - midY(l), leaf: latchLeaf });
    } else if (t === "board") {
      const ends = isXY(raw.a) && isXY(raw.b) ? [fr(raw.a), fr(raw.b)] : isLine(raw.box) ? raw.box.map(fr) : null;
      if (!ends) continue;
      const leaf = leafOfX((ends[0][0] + ends[1][0]) / 2);
      const part: DraftPart & { leaf: 0 | 1 } = { t, u0: uOf(ends[0][0], leaf), v0: 1 - ends[0][1], u1: uOf(ends[1][0], leaf), v1: 1 - ends[1][1], leaf };
      const w = acrossIn(raw.across), role = enumIn(raw.role, ["frame", "members"]);
      if (w !== null) part.wIn = w;
      if (role) part.role = role;
      placed.push(part);
    } else if (t && isLine(raw.box)) {
      const [a, b] = raw.box.map(fr), leaf = leafOfX((a[0] + b[0]) / 2);
      const [ua, ub] = [uOf(a[0], leaf), uOf(b[0], leaf)];
      const part: DraftPart & { leaf: 0 | 1 } = { t, u0: Math.min(ua, ub), v0: 1 - Math.max(a[1], b[1]), u1: Math.max(ua, ub), v1: 1 - Math.min(a[1], b[1]), leaf };
      if (t === "lite") {
        const rows = numOf(raw.rows), cols = numOf(raw.cols);
        if (rows !== undefined) part.rows = Math.round(rows);
        if (cols !== undefined) part.cols = Math.round(cols);
      }
      placed.push(part);
    }
  }
  // Where the rails were measured, a part its panel's fill already draws is that fill (fillDraws): an
  // upright board in a pickets panel is one of its pickets, and in Stage A the one vent near the middle
  // of a plain panel, sized like the fill's, is that panel's vent (dutch's). Any other vent keeps its own
  // box, and then a panel the read called "vent" (or a dutch's unsaid one) is plain, or the fill would
  // draw a second vent over it. (Stage B, measured in ctx.frame, may only add parts, so its vents stay
  // parts and keepStageBParts judges them against the spec's own fills.)
  if (panels && rails) {
    const fills = panels, rs = rails, midV = (p: DraftPart) => ((p.v0 ?? 0) + (p.v1 ?? 0)) / 2;
    const geom = (leaf: 0 | 1): FillGeom => ({ rails: rs, leafWIn: leafWIn(leaf), heightIn: ctx.heightIn, fIn, railHIn });
    const ventsIn = (leaf: 0 | 1, i: number) => placed.filter((q) => q.t === "vent" && q.leaf === leaf && panelAt(midV(q)) === i).length;
    const folded = new Set<number>(), keptVent = new Set<number>();
    const kept = placed.filter((p) => {
      const i = panelAt(midV(p)), pn = fills[i];
      if (!pn) return true;
      if (p.t === "board") return !fillDraws(p, pn.fill, geom(p.leaf));
      if (p.t !== "vent" || ctx.frame) return true;
      const plain = pn.fill === null || pn.fill === "none" || pn.fill === "vent";
      if (plain && ventsIn(p.leaf, i) === 1 && fillDraws(p, "vent", geom(p.leaf))) {
        folded.add(i);
        return false;
      }
      if (plain) keptVent.add(i);
      return true;
    });
    placed.splice(0, placed.length, ...kept);
    for (const i of folded) fills[i].fill = "vent";
    for (const i of keptVent) {
      const pn = fills[i];
      if (!folded.has(i) && (pn.fill === "vent" || (pn.fill === null && DOOR_LOOK_BASE_DEFAULTS[base ?? "plank"].panels[i] === "vent"))) pn.fill = "none";
    }
  }
  // The corner gussets, as the board a read gives one as. After the read's own parts, so a gusset given
  // both ways is kept once (the read's own copy).
  for (const b of gussets) {
    const part: DraftPart & { leaf: 0 | 1 } = { t: "board", u0: uOf(b.a[0], b.leaf), v0: 1 - b.a[1], u1: uOf(b.c[0], b.leaf), v1: 1 - b.c[1], role: "members", leaf: b.leaf };
    if (b.wIn !== null) part.wIn = b.wIn;
    placed.push(part);
  }
  const parts: DraftPart[] = [];
  for (const p of [...placed.filter((q) => q.leaf === latchLeaf), ...placed.filter((q) => q.leaf !== latchLeaf)]) {
    const { leaf: _leaf, ...part } = p;
    if (!parts.some((q) => samePart(q, part))) parts.push(part);
  }

  // Colour roles and the hardware's finish, from the photo's own patches.
  let colors: DoorReadDraft["colors"] = null, finish: DoorReadDraft["finish"] = null;
  const colorAt = ctx.colorAt, at = m.colorAt;
  if (colorAt && isRec(at)) {
    const sample = (k: string) => (isXY(at[k]) ? colorAt(toPhoto(fr(at[k] as XY))) : null);
    const roles = colorRolesOf({ infill: sample("infill"), frame: sample("frame"), members: sample("members") });
    if (Object.keys(roles).length) colors = roles;
    const hw = sample("hardware");
    if (hw) finish = snapFinish(hw);
  }
  // The handle's own finish, at its own point: colorAt.hardware is a hinge, and a steel door pairs silver
  // butt hinges with a black handle.
  let handleFinish: DoorReadDraft["handleFinish"] = null;
  if (colorAt && handle) {
    const hc = colorAt(toPhoto(handle));
    if (hc) handleFinish = snapFinish(hc);
  }

  const words = (v: unknown) =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.trim() !== "").slice(0, 20).map((s) => s.trim().slice(0, 120)) : [];
  const draft: DoorReadDraft = {
    base,
    leaves,
    side,
    sideFrom: found.from,
    meetX,
    rails,
    railHIn,
    fIn,
    fieldDir,
    pitchIn,
    brace,
    panels,
    hingeCount,
    hingeAt,
    hingeLenIn,
    handleV,
    parts,
    colors,
    finish,
    handleFinish,
    stageA: {
      hingeType,
      handleType: enumIn(isRec(read.handle) ? read.handle.type : null, DOOR_HANDLE_TYPES),
      meetType: leaves === 2 ? enumIn(isRec(read.meet) ? read.meet.type : null, DOOR_MEET_TYPES) : null,
    },
    px: { hinges: ownHinges.map((h) => toPhoto(h.p)), handle: handle ? toPhoto(handle) : null },
    observed: words(read.observed),
    unexplained: words(read.unexplained),
  };
  const warnings: DoorWarning[] = [];
  const sw = sideWarning(found.from);
  if (sw) warnings.push(sw);
  if (meetX !== null && Math.abs(meetX - 0.5) > DOOR_UNEQUAL_TOL) warnings.push(warn("unequal_leaves"));
  return { ok: true, draft, warnings };
}

// Whether a panel with this fill already draws the part p (u, v in its leaf): a board standing upright
// in a pickets panel is one of its pickets; a vent in a vent panel is that panel's vent when it sits in
// the middle half of the panel and is about the size and shape the fill draws (P2's ventFill: a third of
// the opening's width, square, capped at 70% of its height). A louvre, a tall vent or a small one keeps
// its own box. Inches: the leaf's width, the frame boards' width and the mid rails' height (the frame's
// own when the read gave none).
type FillGeom = { rails: number[]; leafWIn: number; heightIn: number; fIn: number | null; railHIn: number | null };
const DOOR_VENT_FILL_TOL = 1.7; // each side within this factor of the fill's side, either way
const DOOR_VENT_FILL_ASPECT = 1.4; // long side over short side
function fillDraws(p: DraftPart, fill: DoorPanelFill | null, g: FillGeom): boolean {
  const wIn = Math.abs((p.u1 ?? 0) - (p.u0 ?? 0)) * g.leafWIn, hIn = Math.abs((p.v1 ?? 0) - (p.v0 ?? 0)) * g.heightIn;
  if (p.t === "board") return fill === "pickets" && wIn <= 0.25 * hIn;
  if (p.t !== "vent" || fill !== "vent") return false;
  const cu = ((p.u0 ?? 0) + (p.u1 ?? 0)) / 2, cv = ((p.v0 ?? 0) + (p.v1 ?? 0)) / 2;
  const i = g.rails.filter((r) => r <= cv).length, lo = g.rails[i - 1] ?? 0, hi = g.rails[i] ?? 1, q = (hi - lo) / 4;
  if (cu < 0.25 || cu > 0.75 || cv < lo + q || cv > hi - q) return false;
  const f = g.fIn ?? 4, rh = g.railHIn ?? f;
  const openHIn = (hi - lo) * g.heightIn - (i > 0 ? rh / 2 : f) - (i < g.rails.length ? rh / 2 : f);
  const side = Math.min(0.3 * (g.leafWIn - 2 * f), 0.7 * openHIn);
  const [short, long] = wIn < hIn ? [wIn, hIn] : [hIn, wIn];
  return side > 0 && short >= side / DOOR_VENT_FILL_TOL && long <= side * DOOR_VENT_FILL_TOL && long <= DOOR_VENT_FILL_ASPECT * short;
}

function panelOfAnswer(v: unknown): DraftPanel {
  if (!isRec(v)) return { fill: enumIn(v, DOOR_PANEL_FILLS) };
  const p: DraftPanel = { fill: enumIn(v.fill, DOOR_PANEL_FILLS) };
  for (const k of ["count", "rows", "cols"] as const) {
    const n = numOf(v[k]);
    if (n !== undefined) p[k] = Math.round(n);
  }
  return p;
}

const PART_BOX = (p: DraftPart) => [p.u0 ?? 0, p.v0 ?? 0, p.u1 ?? 0, p.v1 ?? 0];
function iou(a: DraftPart, b: DraftPart): number {
  const [a0, b0, a1, b1] = PART_BOX(a), [c0, d0, c1, d1] = PART_BOX(b);
  const iw = Math.max(0, Math.min(a1, c1) - Math.max(a0, c0)), ih = Math.max(0, Math.min(b1, d1) - Math.max(b0, d0));
  const inter = iw * ih, union = (a1 - a0) * (b1 - b0) + (c1 - c0) * (d1 - d0) - inter;
  return union > 0 ? inter / union : 0;
}
// One part seen twice: the same type, and boxes overlapping by more than half (IoU), boards with both
// ends together (either way round), split lines at one height.
function samePart(a: DraftPart, b: DraftPart): boolean {
  if (a.t !== b.t) return false;
  if (a.t === "split") return Math.abs((a.v ?? 0) - (b.v ?? 0)) <= DOOR_RAIL_TOL;
  if (a.t === "board") {
    const near = (u: number, v: number, s: number, w: number) => Math.abs(u - s) <= DOOR_MATCH && Math.abs(v - w) <= DOOR_MATCH;
    const [u0, v0, u1, v1] = PART_BOX(a), [s0, w0, s1, w1] = PART_BOX(b);
    return (near(u0, v0, s0, w0) && near(u1, v1, s1, w1)) || (near(u0, v0, s1, w1) && near(u1, v1, s0, w0));
  }
  return iou(a, b) > 0.5;
}

// ─── COLOURS ──────────────────────────────────────────────────────────────────────────────────────
// The photo decides only which pick each part follows (does the brace match the frame or the boards?)
// and which of three finishes the hardware is. Its own hex never becomes a colour.
export const DOOR_SAME_PAINT = 60; // sRGB distance under which two patches are one paint (P7 tunes it)
const rgbDist = (a: RGB, b: RGB) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// The median of an n x n patch (clipped to the image) at a pixel of RGBA bytes, channel by channel.
export function samplePatch(rgba: ArrayLike<number>, w: number, h: number, at: XY, n = 5): RGB | null {
  const cx = Math.round(at[0]), cy = Math.round(at[1]), r = Math.floor(n / 2);
  const ch: number[][] = [[], [], []];
  for (let y = Math.max(0, cy - r); y <= Math.min(h - 1, cy + r); y++) {
    for (let x = Math.max(0, cx - r); x <= Math.min(w - 1, cx + r); x++) {
      for (let c = 0; c < 3; c++) ch[c].push(rgba[(y * w + x) * 4 + c]);
    }
  }
  return ch[0].length ? ch.map((v) => Math.round(median(v))) as RGB : null;
}

// The boards follow the Door pick. The frame follows it too when it is the boards' paint, else Door
// trim. The braces and pickets follow the frame when they are its paint, else the Door pick when they
// are the boards' paint, else Door trim (a third paint has nowhere else to go).
export function colorRolesOf(s: { infill?: RGB | null; frame?: RGB | null; members?: RGB | null }): { infill?: "door"; frame?: "door" | "trim"; members?: "door" | "trim" } {
  const out: { infill?: "door"; frame?: "door" | "trim"; members?: "door" | "trim" } = {};
  if (s.infill) out.infill = "door";
  if (s.frame) out.frame = s.infill && rgbDist(s.frame, s.infill) < DOOR_SAME_PAINT ? "door" : "trim";
  if (s.members) {
    if (s.frame && rgbDist(s.members, s.frame) < DOOR_SAME_PAINT) out.members = out.frame;
    else if (s.infill && rgbDist(s.members, s.infill) < DOOR_SAME_PAINT) out.members = "door";
    else out.members = "trim";
  }
  return out;
}

// Bronze is a brown, so only a warm patch (red clearly over blue) may snap to it. Black iron in daylight
// photographs as a neutral grey of 55-85, which is nearer #5A4632 than #23272E; bronze itself is 40 warm.
export const DOOR_BRONZE_WARMTH = 20;
export function snapFinish(rgb: RGB): "black" | "galv" | "bronze" {
  const hex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
  const of = rgb[0] - rgb[2] >= DOOR_BRONZE_WARMTH ? (["black", "galv", "bronze"] as const) : (["black", "galv"] as const);
  const all = of.map((f) => ({ f, d: rgbDist(rgb, hex(DOOR_FINISH_HEX[f])) }));
  return all.sort((a, b) => a.d - b.d)[0].f;
}

// ─── CONSENSUS ────────────────────────────────────────────────────────────────────────────────────
// Three reads (a quorum of two) to one spec: numbers take the median, choices the majority, each
// panel's fill its own majority, and a part is kept only when `quorum` reads have it (median corners).
//
// REFUSALS. A read that counts 3 or more leaves, or calls the door a kind this feature does not make
// (garage, roll-up, sliding, bi-fold), refuses the press on its own: the plan's "if a read says 3 or
// more leaves ... the press is refused", taken for the whole unsupported class because the prompt's one
// `unsupported` word covers a bi-fold too. Never clamped. The other refusals (not a door, open, blocked,
// angled) need `quorum` refusing reads; fewer are left out, and the press goes on without them.
//
// THE HINGE SIDE takes the best source any read has (hinge points, then the brace, the handle, the
// left default) and the majority of the reads with it; a single read on the other side is mirrored
// across before anything is merged. Its warning is the source's, so a guessed side always warns.
//
// NO MAJORITY ON THE BASE (no `quorum` reads agree): the base of the read whose points passed the most
// consensus checks (ties: the first read), with a warning. Never a failure.
export type DoorConsensus = {
  ok: true;
  spec: Rec; // spec-shaped; the hardware types are settled by settleCloseUps, which cleans it
  leaves: 1 | 2;
  side: DoorSide;
  sideFrom: DoorHingeSideSource;
  meetX: number | null;
  warnings: DoorWarning[];
  // The reads split on these. `rails` is the one the self-check may then change (DOOR_CHECK_ALLOW).
  split: { base: boolean; rails: boolean; hingeCount: boolean };
  stageA: { hingeType: DoorVote<string>; handleType: DoorVote<string>; meetType: DoorVote<string>; finish: DoorVote<string>; handleFinish: DoorVote<string> };
  // Photo pixels: each hinge pivot (latch leaf), the handle, and the meeting edge at mid-height and at
  // the bottom (doubles). P4 cuts the close-ups here with closeUpWindow; the strips are div 8.
  closeUpAt: { hinges: XY[]; handle: XY | null; meet: XY[] };
  aligned: DoorReadDraft[]; // the reads used, mirrored into the consensus side (Stage B matches these)
  used: number[];
  dropped: { read: number; why: string }[];
  best: number; // index into `used` of the read whose points agreed most
  observed: string[];
  unexplained: string[];
};
export type DoorConsensusResult =
  | DoorConsensus
  | { ok: false; refuse: DoorRefuseCode; leaves?: number }
  | { ok: false; fail: "unparseable"; dropped: { read: number; why: string }[] };
// `edge`: the photo's edge strips (DoorMeasureCtx.padIn) and the door's width, for the meeting edge's
// close-up points in photo pixels; absent, the photo's own side edges are the leaves'.
export type DoorConsensusOpts = { typedLeaves: 1 | 2; photo: XY; quorum?: number; edge?: { padIn: number; widthIn: number } };

const swapFrom = <T extends string | null | undefined>(f: T) => (f === "hinge" ? "strike" : f === "strike" ? "hinge" : f) as T;
// The same read with the hinge on the other side of a single: u becomes 1 - u.
function flipDraft(d: DoorReadDraft): DoorReadDraft {
  return {
    ...d,
    side: d.side === "left" ? "right" : "left",
    brace: d.brace && { ...d.brace, from: swapFrom(d.brace.from) },
    panels: d.panels && d.panels.map((p) => (p.zFrom ? { ...p, zFrom: swapFrom(p.zFrom) } : { ...p })),
    parts: d.parts.map((p) =>
      p.t === "split" ? { ...p } : p.t === "board"
        ? { ...p, u0: 1 - (p.u0 ?? 0), u1: 1 - (p.u1 ?? 0) }
        : { ...p, u0: 1 - (p.u1 ?? 0), u1: 1 - (p.u0 ?? 0) }
    ),
  };
}

function mergeParts(ps: DraftPart[]): DraftPart {
  const first = ps[0];
  if (first.t === "split") return { t: "split", v: median(ps.map((p) => p.v ?? 0)) };
  // Boards: every copy turned to run the way the first one does before its ends are merged.
  const lined = first.t === "board"
    ? ps.map((p) => (Math.hypot((p.u0 ?? 0) - (first.u0 ?? 0), (p.v0 ?? 0) - (first.v0 ?? 0)) <= Math.hypot((p.u1 ?? 0) - (first.u0 ?? 0), (p.v1 ?? 0) - (first.v0 ?? 0)) ? p : { ...p, u0: p.u1, v0: p.v1, u1: p.u0, v1: p.v0 }))
    : ps;
  const out: DraftPart = { t: first.t };
  for (const k of ["u0", "v0", "u1", "v1"] as const) out[k] = median(lined.map((p) => p[k] ?? 0));
  if (first.t === "lite") {
    const rows = vote(ps.map((p) => p.rows)).value, cols = vote(ps.map((p) => p.cols)).value;
    if (rows !== null) out.rows = rows;
    if (cols !== null) out.cols = cols;
  }
  if (first.t === "board") {
    const w = medianOf(ps.map((p) => p.wIn)), role = vote(ps.map((p) => p.role)).value;
    if (w !== null) out.wIn = w;
    if (role) out.role = role;
  }
  return out;
}

export function consensusDoorLooks(results: DoorReadResult[], opts: DoorConsensusOpts): DoorConsensusResult {
  const quorum = opts.quorum ?? 2;
  const dropped: { read: number; why: string }[] = [];
  for (const r of results) if (!r.ok && "refuse" in r && (r.refuse === "leaves" || r.refuse === "unsupported")) return r;
  const refusing = results.map((r) => (!r.ok && "refuse" in r ? r.refuse : null));
  const rv = vote(refusing);
  if (rv.value && rv.of >= quorum) return { ok: false, refuse: rv.value };
  results.forEach((r, i) => {
    if (!r.ok) dropped.push({ read: i, why: "refuse" in r ? `refused:${r.refuse}` : r.drop });
  });

  // Leaves: the majority, the typed count on a tie. A read of the other count measured another door.
  let reads = results.flatMap((r, i) => (r.ok ? [{ i, d: r.draft }] : []));
  const lv = vote(reads.map((x) => x.d.leaves));
  const leaves = lv.value !== null && lv.n * 2 > lv.of ? lv.value : opts.typedLeaves;
  for (const x of reads) if (x.d.leaves !== leaves) dropped.push({ read: x.i, why: "leaves" });
  reads = reads.filter((x) => x.d.leaves === leaves);
  if (reads.length < quorum || !reads.some((x) => x.d.base)) return { ok: false, fail: "unparseable", dropped };

  const TIERS: DoorHingeSideSource[] = ["given", "hinges", "brace", "handle", "latch", "default"];
  const sideFrom = TIERS.find((t) => reads.some((x) => x.d.sideFrom === t)) ?? "default";
  const side = vote(reads.filter((x) => x.d.sideFrom === sideFrom).map((x) => x.d.side)).value ?? "left";
  const ds = reads.map((x) => (leaves === 1 && x.d.side !== side ? flipDraft(x.d) : { ...x.d, side }));

  // Measured numbers.
  const measured = ds.filter((d) => d.rails !== null);
  const rc = vote(measured.map((d) => d.rails!.length));
  const railCount = rc.value;
  const rails = railCount === null
    ? null
    : Array.from({ length: railCount }, (_, k) => median(measured.filter((d) => d.rails!.length === railCount).map((d) => d.rails![k])));
  const fIn = medianOf(ds.map((d) => d.fIn)), railHIn = medianOf(ds.map((d) => d.railHIn)), pitchIn = medianOf(ds.map((d) => d.pitchIn));
  const counted = ds.filter((d) => d.hingeCount !== null);
  const hc = vote(counted.map((d) => d.hingeCount!));
  const hingeCount = hc.value;
  const hingeAt = hingeCount === null
    ? null
    : Array.from({ length: hingeCount }, (_, k) => median(counted.filter((d) => d.hingeCount === hingeCount).map((d) => d.hingeAt![k])));
  const lenIn = medianOf(ds.map((d) => d.hingeLenIn));
  const hvs = ds.map((d) => d.handleV).filter((v): v is number | "rail" => v !== null);
  const onRail = hvs.filter((v) => v === "rail").length;
  const handleV = !hvs.length ? null : onRail * 2 > hvs.length ? "rail" : medianOf(hvs.map((v) => (v === "rail" ? null : v))) ?? "rail";
  const meetX = leaves === 2 ? medianOf(ds.map((d) => d.meetX)) ?? 0.5 : null;

  // Parts: kept when `quorum` reads have one, a read counting once per part.
  const clusters: { members: { r: number; p: DraftPart }[] }[] = [];
  ds.forEach((d, r) =>
    d.parts.forEach((p) => {
      const c = clusters.find((c) => !c.members.some((m) => m.r === r) && samePart(c.members[0].p, p));
      if (c) c.members.push({ r, p });
      else clusters.push({ members: [{ r, p }] });
    })
  );
  const kept = clusters.filter((c) => c.members.length >= quorum);
  const biggest = [...kept].sort((a, b) => b.members.length - a.members.length).slice(0, 12);
  const parts = kept.filter((c) => biggest.includes(c)).map((c) => mergeParts(c.members.map((m) => m.p)));

  // How many of each read's points the consensus agrees with, to the section 9 bars.
  const near = (a: number | null, b: number | null, tol: number) => (a !== null && b !== null && Math.abs(a - b) <= tol ? 1 : 0);
  const score = ds.map((d, r) => {
    let s = near(d.fIn, fIn, 1) + near(d.railHIn, railHIn, 1) + near(d.pitchIn, pitchIn, 1) + near(d.hingeLenIn, lenIn, 2);
    if (d.rails && rails && d.rails.length === rails.length) s += d.rails.filter((v, k) => Math.abs(v - rails[k]) <= DOOR_RAIL_TOL).length;
    if (d.hingeAt && hingeAt && d.hingeAt.length === hingeAt.length) s += 1 + d.hingeAt.filter((v, k) => Math.abs(v - hingeAt[k]) <= DOOR_HINGE_TOL).length;
    if (d.handleV !== null && handleV !== null) s += d.handleV === handleV || near(d.handleV === "rail" ? null : d.handleV, handleV === "rail" ? null : handleV, DOOR_HINGE_TOL) ? 1 : 0;
    return s + kept.filter((c) => c.members.some((m) => m.r === r)).length;
  });
  const best = score.indexOf(Math.max(...score));

  const warnings: DoorWarning[] = [];
  const sw = sideWarning(sideFrom);
  if (sw) warnings.push(sw);
  if (meetX !== null && Math.abs(meetX - 0.5) > DOOR_UNEQUAL_TOL) warnings.push(warn("unequal_leaves"));
  if (leaves !== opts.typedLeaves) warnings.push(leavesWarning(opts.typedLeaves, leaves));

  const bv = vote(ds.map((d) => d.base));
  let base = bv.value as DoorLookBase;
  const baseSplit = bv.n < quorum;
  if (baseSplit) {
    const withBase = ds.map((d, r) => ({ d, r })).filter((x) => x.d.base);
    const top = withBase.reduce((a, b) => (score[b.r] > score[a.r] ? b : a));
    base = top.d.base!;
    const others = ds.map((d) => d.base).filter((b): b is DoorLookBase => !!b && b !== base);
    pushWarning(warnings, baseSplitWarning([base, ...new Set(others)]));
  }
  if (counted.length && !hc.unanimous) warnings.push(warn("hinge_count_split"));

  // Choices.
  const braced = ds.filter((d) => d.brace);
  const bt = vote(braced.map((d) => d.brace!.t)).value;
  let brace: Rec | null = null;
  if (bt) {
    brace = { t: bt };
    if (bt === "z") {
      // A side guessed from the brace took the brace to rise from the hinge side.
      brace.from = sideFrom === "brace" ? "hinge" : vote(braced.filter((d) => d.brace!.t === "z").map((d) => d.brace!.from)).value ?? "hinge";
    }
    const w = medianOf(braced.filter((d) => d.brace!.t === bt).map((d) => d.brace!.wIn));
    if (w !== null) brace.wIn = w;
  }
  const nPanels = railCount !== null ? railCount + 1 : vote(ds.filter((d) => d.panels).map((d) => d.panels!.length)).value;
  const pool = nPanels ? ds.filter((d) => d.panels && d.panels.length === nPanels) : [];
  const panels = !nPanels || !pool.length ? null : Array.from({ length: nPanels }, (_, i) => {
    const ps = pool.map((d) => d.panels![i]);
    const fill = vote(ps.map((p) => p.fill)).value ?? DOOR_LOOK_BASE_DEFAULTS[base].panels[i] ?? "none";
    const same = ps.filter((p) => p.fill === fill);
    const out: Rec = { fill };
    if (fill === "z") out.zFrom = vote(same.map((p) => p.zFrom)).value ?? "hinge";
    if (fill === "pickets") {
      const n = medianOf(same.map((p) => p.count));
      if (n !== null) out.count = Math.round(n);
    }
    if (fill === "lite") {
      const rows = vote(same.map((p) => p.rows)).value, cols = vote(same.map((p) => p.cols)).value;
      if (rows !== null) out.rows = rows;
      if (cols !== null) out.cols = cols;
    }
    const w = medianOf(same.map((p) => p.braceWIn));
    if (w !== null) out.braceWIn = w;
    return out;
  });

  const spec: Rec = { v: DOOR_LOOK_VERSION, base, src: { leaves, hinge: side } };
  const frame: Rec = {};
  if (fIn !== null) frame.fIn = fIn;
  if (railHIn !== null) frame.railHIn = railHIn;
  if (rails) frame.rails = rails;
  if (Object.keys(frame).length) spec.frame = frame;
  const field: Rec = {};
  // A trim look's field is one sheet (the prompt says so): when the reads settle on vertical boards there,
  // they read the sheet's grooves. Mapped after the vote, so a split keeps its own tie-break.
  const said = vote(ds.map((d) => d.fieldDir)).value;
  const dir = said === "v" && !DOOR_PLANK_FAMILY.includes(base) ? "grooved" : said;
  if (dir) field.dir = dir;
  if (pitchIn !== null) field.pitchIn = pitchIn;
  if (Object.keys(field).length) spec.field = field;
  if (brace) spec.brace = brace;
  if (panels) spec.panels = panels;
  if (parts.length) spec.parts = parts;
  const hinges: Rec = {};
  if (hingeCount !== null) [hinges.count, hinges.at] = [hingeCount, hingeAt];
  if (lenIn !== null) hinges.lenIn = lenIn;
  spec.hinges = hinges;
  spec.handle = handleV === null ? {} : { v: handleV };
  const colors: Rec = {};
  for (const role of ["infill", "frame", "members"] as const) {
    const c = vote(ds.map((d) => d.colors?.[role])).value;
    if (c) colors[role] = c;
  }
  if (Object.keys(colors).length) spec.colors = colors;

  const b = ds[best];
  const [W, H] = opts.photo;
  const pad = Math.max(0, opts.edge?.padIn ?? 0), spanIn = (opts.edge?.widthIn ?? 1) + 2 * pad;
  const meetPx = meetX === null ? null : ((pad + meetX * (spanIn - 2 * pad)) / spanIn) * W;
  return {
    ok: true,
    spec,
    leaves,
    side,
    sideFrom,
    meetX,
    warnings,
    split: { base: baseSplit, rails: measured.length > 0 && !rc.unanimous, hingeCount: counted.length > 0 && !hc.unanimous },
    stageA: {
      hingeType: vote(ds.map((d) => d.stageA.hingeType)),
      handleType: vote(ds.map((d) => d.stageA.handleType)),
      meetType: vote(ds.map((d) => d.stageA.meetType)),
      finish: vote(ds.map((d) => d.finish)),
      handleFinish: vote(ds.map((d) => d.handleFinish)),
    },
    closeUpAt: { hinges: b.px.hinges, handle: b.px.handle, meet: meetPx === null ? [] : [[meetPx, 0.5 * H], [meetPx, 0.94 * H]] },
    aligned: ds,
    used: reads.map((x) => x.i),
    dropped,
    best,
    observed: [...new Set(ds.flatMap((d) => d.observed))],
    unexplained: [...new Set(ds.flatMap((d) => d.unexplained))],
  };
}

// Stage A end to end: each raw read measured, then merged.
export function stageADoorLook(raws: unknown[], ctx: DoorMeasureCtx, quorum = 2): DoorConsensusResult {
  return consensusDoorLooks(raws.map((r) => doorLookFromMeasure(r, ctx)), {
    typedLeaves: ctx.leaves,
    photo: ctx.photo,
    quorum,
    edge: { padIn: ctx.padIn ?? 0, widthIn: ctx.widthIn },
  });
}

// ─── CLOSE-UPS, AND WHAT STANDS IN WHEN ONE IS SKIPPED ────────────────────────────────────────────
// The hinge, handle and meeting-edge close-ups (3 asks each) decide those types, by a majority of the
// asks. When one is skipped (time, the cost ceiling, nothing to cut), fails, or splits, its fields come
// from Stage A's own answer by a majority of the reads, then the table's default -- and it ALWAYS warns.
// The hinge finish is the close-up's, else the colour snap at the hardware, else black. The meeting
// edge is asked about on doubles only. Whatever set these fields, the self-check cannot change them.
export type DoorCloseUpAnswer = { status: "ok"; votes: unknown[] } | { status: "skipped" | "failed" };
export type DoorCloseUps = { hinges?: DoorCloseUpAnswer; handle?: DoorCloseUpAnswer; meet?: DoorCloseUpAnswer };
export type DoorLookDraft =
  | { ok: true; spec: DoorLook; warnings: DoorWarning[]; dropped: string[] }
  | { ok: false; error: string; path: string; warnings: DoorWarning[] };

// The asks' choice for one key, when more than half of the asks made agree on one valid value.
function decided<T extends string>(ans: DoorCloseUpAnswer | undefined, key: string, of: readonly T[]): { value: T; unanimous: boolean } | null {
  if (!ans || ans.status !== "ok" || !ans.votes.length) return null;
  const v = vote(ans.votes.map((x) => (isRec(x) ? enumIn(x[key], of) : null)));
  return v.value !== null && v.n * 2 > ans.votes.length ? { value: v.value, unanimous: v.n === ans.votes.length } : null;
}
const stageAPick = (v: DoorVote<string>) => (v.value !== null && v.n * 2 > v.of ? v.value : null);

export function settleCloseUps(c: DoorConsensus, ups: DoorCloseUps = {}): DoorLookDraft {
  const spec = structuredClone(c.spec);
  const warnings = [...c.warnings];
  const snap = c.stageA.finish.value;

  const hinges: Rec = isRec(spec.hinges) ? spec.hinges : {};
  const ht = decided(ups.hinges, "type", DOOR_HINGE_TYPES);
  if (ht && !ht.unanimous) pushWarning(warnings, warn("hinge_type_split"));
  if (!ht) pushWarning(warnings, warn("closeup_hinges"));
  hinges.type = ht?.value ?? stageAPick(c.stageA.hingeType) ?? doorLookDefault("hinges.type");
  // A close-up that settled the type but not the finish (split, or left out) also warns: the finish then
  // falls back to the colour snap, which closeup_hinges would have flagged had the close-up not run.
  const hf = decided(ups.hinges, "finish", DOOR_FINISHES.slice(0, 3));
  if (ht && ht.value !== "hidden" && !hf) pushWarning(warnings, warn("hinge_finish_unsure")); // hidden: nothing to colour
  hinges.finish = hf?.value ?? snap ?? doorLookDefault("hinges.finish");
  spec.hinges = hinges;

  const handle: Rec = isRec(spec.handle) ? spec.handle : {};
  const hd = decided(ups.handle, "type", DOOR_HANDLE_TYPES);
  if (!hd) pushWarning(warnings, warn("closeup_handle"));
  handle.type = hd?.value ?? stageAPick(c.stageA.handleType) ?? doorLookDefault("handle.type");
  // The handle's own snap before the hinge's: with DOOR_LOOK_V2's strips the hardware point is often a
  // silver butt-hinge knuckle, beside a black handle.
  const hdf = decided(ups.handle, "finish", DOOR_FINISHES.slice(0, 3));
  if (hd && hd.value !== "none" && !hdf) pushWarning(warnings, warn("handle_finish_unsure")); // none: nothing to colour
  handle.finish = hdf?.value ?? stageAPick(c.stageA.handleFinish) ?? snap ?? doorLookDefault("handle.finish");
  spec.handle = handle;

  if (c.leaves === 2) {
    const mt = decided(ups.meet, "type", DOOR_MEET_TYPES);
    if (!mt) pushWarning(warnings, warn("closeup_meet"));
    // The width the asks that chose that type measured.
    const wIn = mt && ups.meet?.status === "ok"
      ? medianOf(ups.meet.votes.map((x) => (isRec(x) && enumIn(x.type, DOOR_MEET_TYPES) === mt.value ? numOf(x.wIn) ?? null : null)))
      : null;
    spec.meet = {
      type: mt?.value ?? stageAPick(c.stageA.meetType) ?? doorLookDefault("meet.type"),
      wIn: wIn ?? doorLookDefault("meet.wIn"),
    };
  }

  const clean = cleanDoorLook(spec);
  return clean.ok ? { ok: true, spec: clean.spec, warnings, dropped: clean.dropped } : { ...clean, warnings };
}

// ─── STAGE B'S PARTS ──────────────────────────────────────────────────────────────────────────────
// Stage B is one read, so a part it proposes would skip the 2-of-3 rule. It is kept only when a Stage A
// read also has it (same type, overlapping as consensus counts it); otherwise it is a warning, not a part.
// A part the spec's own fill already draws (the vent or pickets Stage A folded into a fill) is neither.
export function keepStageBParts(c: DoorConsensus, spec: DoorLook, stageB: unknown, ctx: DoorMeasureCtx): { spec: DoorLook; added: number; warnings: DoorWarning[] } {
  const r = doorLookFromMeasure(stageB, { ...ctx, frame: { leaves: c.leaves, side: c.side, meetX: c.meetX } });
  const warnings: DoorWarning[] = [];
  if (!r.ok) return { spec, added: 0, warnings };
  const have = (Array.isArray(spec.parts) ? spec.parts : []) as DraftPart[];
  const next = [...have];
  const def = DOOR_LOOK_BASE_DEFAULTS[spec.base as DoorLookBase] ?? DOOR_LOOK_BASE_DEFAULTS.plank;
  const frame = isRec(spec.frame) ? spec.frame : {}, own = Array.isArray(spec.panels) ? spec.panels : [];
  const rails = Array.isArray(frame.rails) ? frame.rails as number[] : def.rails;
  const mx = c.meetX ?? 0.5, latchW = c.leaves === 1 ? 1 : c.side === "right" ? 1 - mx : mx;
  const geom: FillGeom = { rails, leafWIn: latchW * ctx.widthIn, heightIn: ctx.heightIn, fIn: numOf(frame.fIn) ?? null, railHIn: numOf(frame.railHIn) ?? null };
  const fillAt = (v: number) => {
    const i = rails.filter((x) => x <= v).length, p = own[i];
    return (isRec(p) ? enumIn(p.fill, DOOR_PANEL_FILLS) : null) ?? def.panels[i] ?? "none";
  };
  for (const p of r.draft.parts) {
    if (next.some((q) => samePart(q, p))) continue;
    if (fillDraws(p, fillAt(((p.v0 ?? 0) + (p.v1 ?? 0)) / 2), geom)) continue;
    if (next.length < 12 && c.aligned.some((d) => d.parts.some((q) => samePart(q, p)))) next.push(p);
    else pushWarning(warnings, stageBWarning(p.t));
  }
  if (next.length === have.length) return { spec, added: 0, warnings };
  // Counted after cleaning: a part the cleaner drops (too small, say) was not added.
  const clean = cleanDoorLook({ ...spec, parts: next });
  const kept = clean.ok && Array.isArray(clean.spec.parts) ? clean.spec.parts.length : 0;
  return clean.ok && kept > have.length ? { spec: clean.spec, added: kept - have.length, warnings } : { spec, added: 0, warnings };
}

// ─── THE SELF-CHECK'S RULES ───────────────────────────────────────────────────────────────────────
// A round compares our render with the photo and may correct the draft, but only by MOVING what is
// there: it may switch the base and the leaf brace within the plank family, change a panel's fill or
// its Z's direction, the board direction, and -- only when the Stage A reads split on it -- the mid
// rails; and it may move a part (or flip which end a Z rises from) by the measured difference. It never
// adds or removes a part: one it added would skip the 2-of-3 rule. Everything measured from points that
// passed consensus (frame, rails, pitch, hinge positions and length, handle height) is locked, as are
// the leaves, the hinge side and the hardware the close-ups (or their fallbacks) set. At most 6 fields
// change in a round. Corrections come as
//   {"corrections": [{"path": "base", "to": "xbrace"}, {"path": "panels[0].fill", "to": "x"},
//                    {"path": "parts[2]", "move": {"du": 0.02, "dv": -0.01}}, ...]}
// where a move is du/dv for the whole part, or du0/dv0/du1/dv1 per corner (a split takes dv).
export const DOOR_CHECK_ALLOW = ["base", "brace.t", "brace.from", "panels[].fill", "panels[].zFrom", "field.dir", "frame.rails", "parts[]"] as const;
export const DOOR_CHECK_MAX_FIELDS = 6;
export const DOOR_CHECK_MAX_MOVE = 0.2; // a "move" further than this is a different part, not a correction
export type DoorCheckCtx = { railsSplit: boolean };
export type DoorCheckResult = { spec: DoorLook; applied: string[]; rejected: { path: string; why: string }[] };

const PART_NODE = (DOOR_LOOK_FIELDS as Extract<DoorFieldNode, { k: "obj" }>).keys.parts as Extract<DoorFieldNode, { k: "list" }>;
const RAILS_NODE = ((DOOR_LOOK_FIELDS as Extract<DoorFieldNode, { k: "obj" }>).keys.frame as Extract<DoorFieldNode, { k: "obj" }>).keys.rails;

export function applyDoorCheck(spec: DoorLook, answer: unknown, ctx: DoorCheckCtx): DoorCheckResult {
  const list = Array.isArray(answer) ? answer : isRec(answer) && Array.isArray(answer.corrections) ? answer.corrections : [];
  const next = structuredClone(spec) as Rec;
  const applied: string[] = [], rejected: { path: string; why: string }[] = [];
  const family = DOOR_PLANK_FAMILY.includes(spec.base);
  const sub = (k: string): Rec => (isRec(next[k]) ? next[k] as Rec : (next[k] = {}) as Rec);
  const effRails = () => {
    const r = isRec(next.frame) ? next.frame.rails : undefined;
    return Array.isArray(r) ? r as number[] : DOOR_LOOK_BASE_DEFAULTS[next.base as DoorLookBase].rails;
  };
  // The panels as drawn: the spec's own, the base's fill where it says nothing.
  const effPanels = (): Rec[] => {
    const own = Array.isArray(next.panels) ? next.panels : [];
    return Array.from({ length: effRails().length + 1 }, (_, i) =>
      isRec(own[i]) ? { ...own[i] as Rec } : { fill: DOOR_LOOK_BASE_DEFAULTS[next.base as DoorLookBase].panels[i] ?? "none" }
    );
  };

  for (const c of list.slice(0, 64)) {
    const path = isRec(c) && typeof c.path === "string" ? c.path.trim() : "";
    const to = isRec(c) ? c.to : undefined;
    const reject = (why: string) => void rejected.push({ path, why });
    if (!path) {
      reject("unreadable");
      continue;
    }
    // Only the allowed paths go further. A part's own keys, or the list itself, are never set: a part
    // is only moved.
    const shape = path.replace(/\[\d+\]/g, "[]");
    if (!(DOOR_CHECK_ALLOW as readonly string[]).includes(shape)) {
      if (shape === "parts" || shape.startsWith("parts[]")) reject("move_only");
      else reject(doorLookPaths().some((p) => p.replace(/\[\]/g, "") === shape.replace(/\[\]/g, "")) ? "locked" : "unknown");
      continue;
    }
    if (applied.length >= DOOR_CHECK_MAX_FIELDS) {
      reject("cap");
      continue;
    }
    const set = (holder: Rec, key: string, value: unknown) => {
      if (holder[key] === value) return reject("no_change");
      holder[key] = value;
      applied.push(path);
    };
    const panel = /^panels\[(\d+)\]\.(fill|zFrom)$/.exec(path);
    const part = /^parts\[(\d+)\]$/.exec(path);
    if (path === "base") {
      const b = enumIn(to, DOOR_LOOK_BASES);
      if (!family || !b || !DOOR_PLANK_FAMILY.includes(b)) reject("base_family");
      else set(next, "base", b);
    } else if (path === "brace.t" || path === "brace.from") {
      const v = path === "brace.t" ? enumIn(to, DOOR_BRACE_TYPES) : enumIn(to, ["hinge", "strike"] as const);
      if (!family) reject("brace_family");
      else if (!v) reject("bad_value");
      else {
        const brace = sub("brace");
        const now = path === "brace.t" ? brace.t ?? DOOR_LOOK_BASE_DEFAULTS[next.base as DoorLookBase].brace : brace.from ?? "hinge";
        if (now === v) reject("no_change");
        else set(brace, path.slice(6), v);
      }
    } else if (panel) {
      const i = Number(panel[1]), ps = effPanels();
      if (i >= ps.length) reject("no_panel");
      else {
        const v = panel[2] === "fill" ? enumIn(to, DOOR_PANEL_FILLS) : enumIn(to, ["hinge", "strike"] as const);
        if (!v) reject("bad_value");
        else if (panel[2] === "zFrom" && ps[i].fill !== "z") reject("not_z");
        else if ((ps[i][panel[2]] ?? (panel[2] === "zFrom" ? "hinge" : undefined)) === v) reject("no_change");
        else {
          ps[i][panel[2]] = v;
          next.panels = ps;
          applied.push(path);
        }
      }
    } else if (path === "field.dir") {
      const v = enumIn(to, DOOR_FIELD_DIRS);
      if (!v) reject("bad_value");
      else if (v === "v" && !family) reject("sheet_field"); // a trim look's field is one sheet, never boards
      else set(sub("field"), "dir", v);
    } else if (path === "frame.rails") {
      if (!ctx.railsSplit) {
        reject("locked");
        continue;
      }
      const v = cleanNode(RAILS_NODE, to, path, newCx()) as number[] | undefined;
      if (!v) reject("bad_value");
      else if (JSON.stringify(v) === JSON.stringify(effRails())) reject("no_change");
      else {
        const ps = effPanels();
        sub("frame").rails = v;
        // One more panel than rails: the fills kept bottom first, the base's own past them.
        next.panels = Array.from({ length: v.length + 1 }, (_, k) => ps[k] ?? { fill: DOOR_LOOK_BASE_DEFAULTS[next.base as DoorLookBase].panels[k] ?? "none" });
        applied.push(path);
      }
    } else if (part) {
      const j = Number(part[1]), parts = Array.isArray(next.parts) ? next.parts as Rec[] : [];
      const mv = isRec(c) ? c.move : undefined;
      if (j >= parts.length) reject("no_part");
      else if (to !== undefined || !isRec(mv)) reject("move_only");
      else {
        const d = (k: string, whole: string) => clampTo(numOf(mv[k]) ?? numOf(mv[whole]) ?? 0, -DOOR_CHECK_MAX_MOVE, DOOR_CHECK_MAX_MOVE);
        const p = { ...parts[j] };
        if (p.t === "split") p.v = (p.v as number) + d("dv", "dv");
        else {
          for (const [k, dk, whole] of [["u0", "du0", "du"], ["v0", "dv0", "dv"], ["u1", "du1", "du"], ["v1", "dv1", "dv"]]) {
            p[k] = clampTo((p[k] as number) + d(dk, whole), 0, 1);
          }
        }
        const moved = cleanNode(PART_NODE.of, p, path, newCx());
        if (!isRec(moved)) reject("bad_move");
        else if (JSON.stringify(moved) === JSON.stringify(parts[j])) reject("no_change");
        else {
          parts[j] = moved;
          applied.push(path);
        }
      }
    }
  }

  const clean = cleanDoorLook(next);
  // A round that would not clean, or would lose a part on the way, changes nothing.
  const partsOf = (s: Rec) => (Array.isArray(s.parts) ? s.parts.length : 0);
  if (!clean.ok || partsOf(clean.spec) !== partsOf(spec)) {
    return { spec, applied: [], rejected: [...rejected, ...applied.map((path) => ({ path, why: "unclean" }))] };
  }
  return { spec: clean.spec, applied, rejected };
}

// True when a round's draft is one an EARLIER round already had (A -> B -> A): the values oscillate and
// the browser stops. The last entry of `history` is the draft the round started from.
export function doorCheckOscillates(history: DoorLook[], next: DoorLook): boolean {
  const key = JSON.stringify(next);
  return history.slice(0, -1).some((s) => JSON.stringify(s) === key);
}
