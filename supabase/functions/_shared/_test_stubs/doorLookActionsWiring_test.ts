// The door-look actions (migration 337; plan "Door looks from a photo" phase P3), driven through the
// SHIPPED portal-settings handler, plus the pure rules in portal-settings/doorLooks.ts.
//
// WHAT IS PINNED:
//   1. Every action refuses unless client_settings.door_looks_beta is on: off, no settings row, a flag
//      we could not read, and a database without 337 all refuse, and nothing is written or signed.
//   2. GATES: list_door_looks at view, the four writes at edit, all under settings_options.
//   3. list_door_looks: this builder's looks only, archived ones only when asked, each with how many
//      door rows (and distinct doors) use it, and never the ledger row (only fromPhoto).
//   4. save_door_look with no id = "Start from a standard look": a Ready look, free, through the
//      cleaner; bad names, bases and specs refused in words, and one too big to store.
//   5. save_door_look with an id: the late-save guard (version): a stale save 409s with the current
//      look, the same save landing twice is answered as saved and writes nothing, the write is a
//      compare-and-swap on the version; an archived or another builder's look is refused.
//   6. The tile: only a path door_look_thumb_upload_url could have handed out, as its public URL.
//   7. "Replace <old look>": the old look's door rows move across, then the old look is archived.
//   8. archive_door_look: archived with its version bumped (the trigger in 337 releases the rows).
//   9. door_ref_upload_url: 1-4 private uploads at paths of the exact shape, never a public URL.
// Tenants and users are made up; the repo is public.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals, assertFalse } from "jsr:@std/assert";
import { call, FakeDb, OTHER, OWN, USER_ID, type Row } from "./doorLookFake.ts";
import {
  cleanSpec, doorLookStoredBytes, doorRefPathOk, doorThumbPathOk, resolveDoorLookWrite, type LookRef,
} from "../../portal-settings/doorLooks.ts";

const LOOK = "00000000-0000-4000-8000-00000000100a";
const OLDLOOK = "00000000-0000-4000-8000-00000000100e";
const ARCHIVED = "00000000-0000-4000-8000-0000000010ae";
const FOREIGN = "00000000-0000-4000-8000-00000000100b";
const SPEC = { v: 1, base: "zbrace", src: { leaves: 2, hinge: "right" }, brace: { t: "z", from: "hinge" } };
const ACTIONS = ["list_door_looks", "save_door_look", "archive_door_look", "door_ref_upload_url", "door_look_thumb_upload_url"];

function seed(flag: boolean | null = true): FakeDb {
  return new FakeDb({
    client_settings: flag === null ? [] : [{ client_id: OWN, door_looks_beta: flag }],
    door_looks: [
      { id: LOOK, client_id: OWN, name: "Our barn door", base: "zbrace", status: "ready", spec: SPEC, spec_version: 1, version: 3, thumb_url: null, ai_call_id: "00000000-0000-4000-8000-0000000c0001", updated_at: "2026-10-26T10:00:00Z" },
      { id: OLDLOOK, client_id: OWN, name: "Old barn door", base: "plank", status: "ready", spec: { v: 1, base: "plank" }, spec_version: 1, version: 1, thumb_url: null, ai_call_id: null, updated_at: "2026-10-20T10:00:00Z" },
      { id: ARCHIVED, client_id: OWN, name: "Retired", base: "basic", status: "archived", spec: { v: 1, base: "basic" }, spec_version: 1, version: 2, thumb_url: null, ai_call_id: null, updated_at: "2026-10-01T10:00:00Z" },
      { id: FOREIGN, client_id: OTHER, name: "Theirs", base: "classic", status: "ready", spec: { v: 1, base: "classic" }, spec_version: 1, version: 1, thumb_url: null, ai_call_id: null },
    ],
    fixture_items: [
      { id: "d1", client_id: OWN, category: "door", name: "Barn door", door_look_id: LOOK, door_style: "zbrace" },
      { id: "d2", client_id: OWN, category: "door", name: "Barn door", door_look_id: LOOK, door_style: "zbrace" },
      { id: "d3", client_id: OWN, category: "door", name: "Shop door", door_look_id: LOOK, door_style: "zbrace" },
      { id: "d4", client_id: OWN, category: "door", name: "Single door", door_look_id: OLDLOOK, door_style: "plank" },
      { id: "x1", client_id: OTHER, category: "door", name: "Their door", door_look_id: FOREIGN, door_style: "classic" },
    ],
  });
}
const nothingHappened = (db: FakeDb) => db.writes.length === 0 && db.storage.length === 0;

Deno.test("GATES: the five actions sit under settings_options (list at view, the rest at edit)", async () => {
  const src = await Deno.readTextFile(new URL("../../portal-settings/index.ts", import.meta.url));
  assert(/\blist_door_looks:\s*\{ area: "settings_options", level: "view" \}/.test(src));
  for (const a of ACTIONS.slice(1)) assert(new RegExp(`\\b${a}:\\s*\\{ area: "settings_options", level: "edit" \\}`).test(src), a);
  for (const a of ACTIONS) assert(src.includes(`action === "${a}"`), `${a} is a named branch`);
});

Deno.test("every action refuses unless the tenant flag is on, and does nothing", async () => {
  for (const a of ACTIONS) {
    for (const [flag, status, code] of [[false, 403, "door_looks_off"], [null, 403, "door_looks_off"]] as const) {
      const db = seed(flag);
      const r = await call(db, { action: a, id: LOOK, name: "X", base: "zbrace", version: 3 });
      assertEquals([r.status, r.body.code], [status, code], `${a} / ${flag}: ${JSON.stringify(r.body)}`);
      assert(nothingHappened(db), a);
    }
    const unread = seed();
    unread.failing.add("client_settings");
    const r = await call(unread, { action: a, id: LOOK, name: "X", base: "zbrace", version: 3 });
    assertEquals(r.status, 503, `${a} with an unreadable flag: ${JSON.stringify(r.body)}`);
    assert(nothingHappened(unread));
    const old = seed();
    old.missingColumns.add("client_settings.door_looks_beta");
    const o = await call(old, { action: a, name: "X", base: "zbrace" });
    assertEquals([o.status, o.body.code], [503, "door_looks_unavailable"], `${a} before 337`);
    assert(nothingHappened(old));
  }
});

Deno.test("list_door_looks: own looks, newest first, archived only when asked, with usage and no ledger", async () => {
  const db = seed();
  const r = await call(db, { action: "list_door_looks" });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(r.body.looks.map((l: any) => l.id).sort(), [LOOK, OLDLOOK].sort());
  const look = r.body.looks.find((l: any) => l.id === LOOK);
  assertEquals(look.usedOn, { rows: 3, doors: 2 }, "three rows, two doors (Barn door in two sizes, Shop door)");
  assertEquals(r.body.looks.find((l: any) => l.id === OLDLOOK).usedOn, { rows: 1, doors: 1 });
  assertEquals([look.fromPhoto, look.version, look.v, look.base, look.status], [true, 3, 1, "zbrace", "ready"]);
  assertFalse(JSON.stringify(r.body).includes("0000000c0001"), "the ledger id never leaves");
  assertFalse(JSON.stringify(r.body).includes(FOREIGN), "another builder's look never shows");
  const all = await call(db, { action: "list_door_looks", includeArchived: true });
  assert(all.body.looks.some((l: any) => l.id === ARCHIVED));
});

Deno.test("save_door_look, no id: start from a standard look (Ready, free, cleaned)", async () => {
  const db = seed();
  const r = await call(db, { action: "save_door_look", name: "  Our   Z  door ", base: "zbrace", leaves: 2, hinge: "right" });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const ins = db.writesTo("door_looks", "insert")[0].row;
  assertEquals([ins.client_id, ins.name, ins.base, ins.status, ins.spec_version, ins.created_by], [OWN, "Our Z door", "zbrace", "ready", 1, USER_ID]);
  assertEquals(ins.spec.base, "zbrace");
  assertEquals(ins.spec.src, { leaves: 2, hinge: "right" });
  assert(!("ai_call_id" in ins), "no AI, no ledger row");
  assertEquals([r.body.look.status, r.body.look.fromPhoto, r.body.look.version], ["ready", false, 1]);
  // A single hinged left is the default.
  const d = seed();
  await call(d, { action: "save_door_look", name: "Plain", base: "plank" });
  assertEquals(d.writesTo("door_looks", "insert")[0].row.spec.src, { leaves: 1, hinge: "left" });
  // Or the edited spec itself.
  const e = seed();
  const er = await call(e, { action: "save_door_look", name: "Edited", spec: { ...SPEC, base: "xbrace" } });
  assertEquals(er.status, 200, JSON.stringify(er.body));
  assertEquals(e.writesTo("door_looks", "insert")[0].row.base, "xbrace");
});

Deno.test("save_door_look refuses, in words: names, bases, specs, sizes", async () => {
  const cases: [Record<string, unknown>, number, string][] = [
    [{ name: "", base: "zbrace" }, 400, "door_look_name"],
    [{ name: "   ", base: "zbrace" }, 400, "door_look_name"],
    [{ name: "x".repeat(61), base: "zbrace" }, 400, "door_look_name"],
    [{ name: "Slab", base: "slab" }, 400, "door_look_base"],
    [{ name: "Roll-up", base: "rollup" }, 400, "door_look_base"],
    [{ name: "None" }, 400, "door_look_base"],
    [{ name: "Junk", spec: "zbrace" }, 400, "door_look_invalid"],
    [{ name: "Junk", spec: { v: 1, base: "garage" } }, 400, "door_look_invalid"],
    [{ name: "Three", spec: { v: 1, base: "plank", src: { leaves: 3 } } }, 400, "door_look_invalid"],
    [{ name: "Bad id", id: "nope", spec: SPEC, version: 1 }, 400, "door_look_id"],
  ];
  for (const [body, status, code] of cases) {
    const db = seed();
    const r = await call(db, { action: "save_door_look", ...body });
    assertEquals([r.status, r.body.code], [status, code], `${JSON.stringify(body).slice(0, 80)}: ${JSON.stringify(r.body)}`);
    assert(typeof r.body.error === "string" && !/constraint|relation|column/i.test(r.body.error), r.body.error);
    assertEquals(db.writesTo("door_looks").length, 0);
  }
  const ok60 = await call(seed(), { action: "save_door_look", name: "x".repeat(60), base: "zbrace" });
  assertEquals(ok60.status, 200);
});

Deno.test("save_door_look with an id: Ready, version bumped, compare-and-swap on the version", async () => {
  const db = seed();
  const r = await call(db, { action: "save_door_look", id: LOOK, version: 3, name: "Our barn door", spec: { ...SPEC, base: "xbrace" } });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const w = db.writesTo("door_looks", "update")[0];
  assertEquals([w.row.status, w.row.version, w.row.base, w.row.spec.base], ["ready", 4, "xbrace", "xbrace"]);
  assert(w.filters.some((f) => f[0] === "eq" && f[1] === "version" && f[2] === 3), "only while the row is still at version 3");
  assert(w.filters.some((f) => f[0] === "eq" && f[1] === "client_id" && f[2] === OWN));
  assertEquals(r.body.look.version, 4);
  // A rename alone keeps the stored spec.
  const n = seed();
  await call(n, { action: "save_door_look", id: LOOK, version: 3, name: "Renamed" });
  const nr = n.writesTo("door_looks", "update")[0].row;
  assert(nr.name === "Renamed" && !("spec" in nr) && !("base" in nr), JSON.stringify(nr));
});

Deno.test("the late-save guard: stale saves 409 with the current look; a duplicate writes nothing", async () => {
  const db = seed();
  const stale = await call(db, { action: "save_door_look", id: LOOK, version: 2, name: "Older edit", spec: { ...SPEC, base: "plank" } });
  assertEquals([stale.status, stale.body.code], [409, "door_look_conflict"], JSON.stringify(stale.body));
  assertEquals(stale.body.look.version, 3, "the current look comes back");
  assertEquals(db.writesTo("door_looks").length, 0);
  // The same save twice: the first lands (v3 -> v4), the retry carries v3 and the same content.
  const body = { action: "save_door_look", id: LOOK, version: 3, name: "Our barn door", spec: SPEC };
  assertEquals((await call(db, body)).status, 200);
  const dup = await call(db, body);
  assertEquals([dup.status, dup.body.duplicate], [200, true], JSON.stringify(dup.body));
  assertEquals(db.writesTo("door_looks", "update").length, 1, "the retry wrote nothing");
  const missing = await call(seed(), { action: "save_door_look", id: LOOK, name: "No version", spec: SPEC });
  assertEquals([missing.status, missing.body.code], [400, "door_look_version"]);
});

Deno.test("save_door_look: archived and other builders' looks are refused", async () => {
  const a = await call(seed(), { action: "save_door_look", id: ARCHIVED, version: 2, name: "Retired", spec: { v: 1, base: "basic" } });
  assertEquals([a.status, a.body.code], [409, "door_look_archived"]);
  const db = seed();
  const f = await call(db, { action: "save_door_look", id: FOREIGN, version: 1, name: "Mine now", spec: { v: 1, base: "classic" } });
  assertEquals([f.status, f.body.code], [404, "door_look_not_found"]);
  assertEquals(db.writesTo("door_looks").length, 0);
});

Deno.test("the tile: only a path of the exact shape, stored as its public URL; null takes it off", async () => {
  const path = `${OWN}/door-look-00000000-0000-4000-8000-0000000000f1.png`;
  const db = seed();
  const r = await call(db, { action: "save_door_look", id: LOOK, version: 3, name: "Our barn door", thumbPath: path });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(db.writesTo("door_looks", "update")[0].row.thumb_url, `https://stub.supabase.co/storage/v1/object/public/fixtures/${path}`);
  for (const bad of [`${OTHER}/door-look-00000000-0000-4000-8000-0000000000f1.png`, `${OWN}/../${OTHER}/door-look-00000000-0000-4000-8000-0000000000f1.png`,
    `${OWN}/door-look-00000000-0000-4000-8000-0000000000f1.jpg`, `https://evil.example/x.png`, `${OWN}/door-ref-00000000-0000-4000-8000-0000000000f1.png`]) {
    const b = seed();
    const br = await call(b, { action: "save_door_look", id: LOOK, version: 3, name: "Our barn door", thumbPath: bad });
    assertEquals([br.status, br.body.code], [400, "door_look_thumb"], bad);
    assertEquals(b.writesTo("door_looks").length, 0);
  }
  const off = seed();
  await call(off, { action: "save_door_look", id: LOOK, version: 3, name: "Our barn door", thumbPath: null });
  assertEquals(off.writesTo("door_looks", "update")[0].row.thumb_url, null);
});

Deno.test("Replace <old look>: its rows move to this look, then the old look is archived", async () => {
  const db = seed();
  const r = await call(db, { action: "save_door_look", id: LOOK, version: 3, name: "Our barn door", spec: SPEC, replaceId: OLDLOOK });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(r.body.moved, 1);
  const d4 = db.rows("fixture_items").find((x) => x.id === "d4")!;
  assertEquals([d4.door_look_id, d4.door_style], [LOOK, "zbrace"]);
  assertEquals(db.rows("door_looks").find((l) => l.id === OLDLOOK)!.status, "archived");
  const order = db.writes.map((w) => `${w.table}.${w.verb}`);
  assert(order.indexOf("fixture_items.update") < order.lastIndexOf("door_looks.update"), "rows first, then the archive: " + order.join(", "));
  for (const bad of [FOREIGN, ARCHIVED, LOOK]) {
    const b = seed();
    const br = await call(b, { action: "save_door_look", id: LOOK, version: 3, name: "Our barn door", spec: SPEC, replaceId: bad });
    assert(br.status === 404 || br.status === 400, `${bad}: ${br.status}`);
    assertEquals(b.writesTo("fixture_items").length + b.writesTo("door_looks").length, 0);
  }
});

Deno.test("archive_door_look: archived, version bumped, rows counted; already archived is done; another builder's is not found", async () => {
  const db = seed();
  const r = await call(db, { action: "archive_door_look", id: LOOK });
  assertEquals([r.status, r.body.rowsReset], [200, 3], JSON.stringify(r.body));
  const w = db.writesTo("door_looks", "update")[0];
  assertEquals([w.row.status, w.row.version], ["archived", 4]);
  const again = await call(db, { action: "archive_door_look", id: LOOK });
  assertEquals([again.status, again.body.already], [200, true]);
  const f = await call(db, { action: "archive_door_look", id: FOREIGN });
  assertEquals(f.status, 404);
  assertEquals(db.rows("door_looks").find((l: Row) => l.id === FOREIGN)!.status, "ready");
});

Deno.test("door_ref_upload_url: 1 to 4 private uploads at server-picked paths, no public URL", async () => {
  const db = seed();
  const r = await call(db, { action: "door_ref_upload_url", contentTypes: ["image/jpeg", "image/png", "image/webp", "image/jpeg"], clientId: OTHER });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(r.body.uploads.length, 4);
  assert(r.body.uploads.every((u: any) => doorRefPathOk(OWN, u.path) && u.token), JSON.stringify(r.body.uploads));
  assertEquals(new Set(r.body.uploads.map((u: any) => u.path)).size, 4);
  assert(db.storage.every((s) => s.bucket === "door-refs" && s.op === "sign-upload"));
  assertFalse(JSON.stringify(r.body).includes("/object/public/"), "never a public URL");
  assert(r.body.uploads.map((u: any) => u.path.split(".").pop()).join() === "jpg,png,webp,jpg");
  for (const bad of [{ contentTypes: [] }, { contentTypes: ["image/jpeg", "image/jpeg", "image/jpeg", "image/jpeg", "image/jpeg"] }, { contentType: "image/gif" }, { contentTypes: ["image/heic"] }]) {
    const b = seed();
    const br = await call(b, { action: "door_ref_upload_url", ...bad });
    assertEquals(br.status, 400, JSON.stringify(bad));
    assertEquals(b.storage.length, 0);
  }
  const one = await call(seed(), { action: "door_ref_upload_url" });
  assert(one.body.uploads.length === 1 && one.body.uploads[0].path.endsWith(".jpg"));
});

Deno.test("door_look_thumb_upload_url: one PNG path in fixtures that save_door_look accepts", async () => {
  const db = seed();
  const r = await call(db, { action: "door_look_thumb_upload_url" });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assert(doorThumbPathOk(OWN, r.body.path), r.body.path);
  assertEquals(db.storage[0].bucket, "fixtures");
  assertEquals(r.body.url, `https://stub.supabase.co/storage/v1/object/public/fixtures/${r.body.path}`);
  const s = await call(db, { action: "save_door_look", id: LOOK, version: 3, name: "Our barn door", thumbPath: r.body.path });
  assertEquals(s.status, 200, JSON.stringify(s.body));
});

// ── The pure rules ──────────────────────────────────────────────────────────────────────────────

Deno.test("paths: exact shape only; the tenant id is escaped, never a prefix", () => {
  const u = "00000000-0000-4000-8000-0000000000f1";
  assert(doorRefPathOk("acme-sheds", `acme-sheds/door-ref-${u}.jpg`));
  assert(doorRefPathOk("acme-sheds", `acme-sheds/door-ref-${u}.webp`));
  for (const bad of [`acme-sheds/door-ref-${u}.gif`, `acme-sheds/../bravo/door-ref-${u}.jpg`, `acme-sheds/%2e%2e/door-ref-${u}.jpg`,
    `acme-sheds/x/door-ref-${u}.jpg`, `acme-sheds/door-ref-${u}.jpg?x`, `acme-shedsX/door-ref-${u}.jpg`, `/acme-sheds/door-ref-${u}.jpg`, `acme-sheds/door-ref-${u.slice(1)}.jpg`]) {
    assertFalse(doorRefPathOk("acme-sheds", bad), bad);
  }
  // A slug with regex characters cannot widen the match.
  assertFalse(doorRefPathOk("a.c", `abc/door-ref-${u}.jpg`));
  assert(doorRefPathOk("a.c", `a.c/door-ref-${u}.jpg`));
  assert(doorThumbPathOk("acme-sheds", `acme-sheds/door-look-${u}.png`));
  assertFalse(doorThumbPathOk("acme-sheds", `acme-sheds/door-look-${u}.jpg`));
  assertFalse(doorThumbPathOk("acme-sheds", `acme-sheds/door-ref-${u}.png`));
  assertFalse(doorThumbPathOk("acme-sheds", 42));
});

Deno.test("cleanSpec: the cleaner's answer is checked again, and one too big to store is refused in words", () => {
  const big = { ...SPEC, parts: Array.from({ length: 60 }, () => ({ t: "board", u0: 0.1, v0: 0.1, u1: 0.9, v1: 0.9, wIn: 5.5, role: "members" })) };
  assert(doorLookStoredBytes(big) > 4096);
  assertEquals((cleanSpec(big, (r) => r) as any).refuse.code, "door_look_too_big");
  const near = { ...SPEC, note: "x".repeat(4096 - doorLookStoredBytes({ ...SPEC, note: "" })) };
  assertEquals(doorLookStoredBytes(near), 4096);
  assertEquals((cleanSpec(near, (r) => r) as any).base, "zbrace", "exactly 4096 bytes as stored is allowed (337's <= 4096)");
  for (const answer of [null, "zbrace", [SPEC], { ...SPEC, base: "slab" }, { ...SPEC, v: 2 }, { v: 1 }]) {
    assertEquals((cleanSpec(SPEC, () => answer) as any).refuse.code, "door_look_invalid", JSON.stringify(answer));
  }
  assertEquals((cleanSpec(SPEC, () => { throw new Error("boom"); }) as any).refuse.code, "door_look_invalid", "a cleaner that throws is a refusal, not a 500");
});

Deno.test("doorLookStoredBytes measures jsonb's own text, the size 337's check reads", () => {
  // What Postgres prints for these values (jsonb::text), written out by hand.
  const cases: [unknown, string][] = [
    [{ a: 1 }, '{"a": 1}'],
    [{ a: [1, 2], b: { c: "x" } }, '{"a": [1, 2], "b": {"c": "x"}}'],
    [{ s: "a, b: c" }, '{"s": "a, b: c"}'],
    [{ q: 'say "hi", ok' }, '{"q": "say \\"hi\\", ok"}'],
    [{ é: "ü" }, '{"é": "ü"}'],
  ];
  for (const [v, pg] of cases) assertEquals(doorLookStoredBytes(v), new TextEncoder().encode(pg).length, pg);
});

Deno.test("resolveDoorLookWrite: the whole rule as a table", () => {
  const looks = new Map<string, LookRef>([[LOOK, { base: "zbrace", status: "ready" }], [OLDLOOK, { base: "plank", status: "draft" }], [ARCHIVED, { base: "basic", status: "archived" }]]);
  const r = (sent: { id: string | null } | undefined, styleSent: string | undefined, currentLookId: string | null, flagOn = true) =>
    resolveDoorLookWrite({ sent, styleSent, currentLookId, looks, flagOn });
  assertEquals(r(undefined, undefined, LOOK), { write: {} }, "nothing sent: nothing changes");
  assertEquals(r(undefined, "zbrace", LOOK), { write: {} }, "the base as doorStyle keeps the look");
  assertEquals(r(undefined, "plank", LOOK), { write: { door_look_id: null } }, "another standard look clears it");
  assertEquals(r(undefined, "plank", null), { write: {} }, "no look on file: nothing to clear");
  assertEquals(r(undefined, "plank", "00000000-0000-4000-8000-000000009999"), { write: {} }, "a look we could not find is never cleared on a guess");
  assertEquals(r({ id: null }, "zbrace", LOOK, false), { write: { door_look_id: null } }, "an explicit null clears, flag or not");
  assertEquals(r({ id: null }, undefined, null), { write: {} });
  assertEquals(r({ id: LOOK }, "plank", null), { write: { door_look_id: LOOK, door_style: "zbrace" } }, "a look forces its base");
  assertEquals((r({ id: LOOK }, undefined, null, false) as any).refuse.code, "door_looks_off");
  assertEquals((r({ id: OLDLOOK }, undefined, null) as any).refuse.code, "door_look_not_ready");
  assertEquals((r({ id: ARCHIVED }, undefined, null) as any).refuse.code, "door_look_archived");
  assertEquals((r({ id: FOREIGN }, undefined, null) as any).refuse.code, "door_look_not_found");
});
