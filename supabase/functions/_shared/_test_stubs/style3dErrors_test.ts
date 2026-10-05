// The 3D-setup actions' failures (save_style_d3, save_style_media, the scan actions,
// upload_style_photo), pinned against the SHIPPED portal-settings source.
//
// Every other handler in portal-settings answers a database or storage failure through dbFail
// (an authored sentence + a `ref`, the raw Postgres text to app_errors). This block was the one
// left echoing `error.message` verbatim — table and constraint names, and whatever row values a
// Postgres message carries, on the builder's 3D panel — and a malformed `styleId` reached
// Postgres as a uuid and came back a 500 ("invalid input syntax for type uuid") instead of the
// "not found" it is.
//
// Lifted, not copied, so a drift fails the push. Same technique as tabClamp_test.

import { assert, assertEquals } from "jsr:@std/assert";

const SRC = (await Deno.readTextFile(new URL("../../portal-settings/index.ts", import.meta.url))).replace(/\r\n/g, "\n");

function between(start: string, end: string, label: string): string {
  const i = SRC.indexOf(start);
  const j = i < 0 ? -1 : SRC.indexOf(end, i + start.length);
  if (i < 0 || j < 0) {
    throw new Error(`style3dErrors_test: could not find ${label} (start=${i}, end=${j}). The anchors moved — re-point them rather than deleting this test.`);
  }
  return SRC.slice(i, j);
}

// From the style resolver to the first action after upload_style_photo: every 3D-setup write.
const BLOCK = between("const findStyleFor3D = async", 'if (action === "style_photo_upload_url")', "the 3D-setup actions");

Deno.test("no 3D-setup action hands a database or storage message to the browser", () => {
  for (const name of ["save_style_d3", "save_style_media", "save_style_model", "set_style_model_status", "style_model_url", "upload_style_photo"]) {
    assert(BLOCK.includes(`action === "${name}"`), `the lifted block is missing ${name}`);
  }
  // json({ error: error.message }, ...) and json({ error: `...${x.message}...` }, ...) alike.
  const raw = BLOCK.split("\n").filter((l) => /json\(\{\s*error:\s*[A-Za-z_.?]*\.message\b/.test(l) || /json\(\{\s*error:\s*`[^`]*\$\{[^}]*\.message/.test(l));
  assertEquals(raw, [], "a raw provider message reaches the browser; use dbFail");
});

// findStyleFor3D itself, run. Its two type annotations are taken off so it runs as plain JS.
const FIND = between("const findStyleFor3D = async", "\n  };\n", "findStyleFor3D") + "\n  };";
const FIND_JS = FIND
  .replace("async (styleValue: string, styleId: string) =>", "async (styleValue, styleId) =>")
  .replace("data as Style3D", "data");
assert(!/:\s*(string|Style3D)\b|\bas\s+Style3D/.test(FIND_JS), "findStyleFor3D gained a type annotation this test does not strip");

type R = { status: number; body: Record<string, unknown> };
function load(answer: { data: unknown; error: unknown }) {
  const calls: string[] = [];
  const fails: { where: string; err: unknown }[] = [];
  const q = {
    eq(col: string, v: string) { calls.push(`${col}=${v}`); return q; },
    maybeSingle: () => Promise.resolve(answer),
  };
  const admin = { from(t: string) { calls.push(`from ${t}`); return { select: () => q }; } };
  const json = (body: Record<string, unknown>, status = 200): R => ({ status, body });
  const dbFail = (_req: unknown, _c: unknown, where: string, err: unknown): R => {
    fails.push({ where, err });
    return { status: 500, body: { error: `Couldn't ${where}.`, ref: where } };
  };
  const isUuid = (v: unknown) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  const find = new Function("admin", "clientId", "json", "dbFail", "isUuid", "req", `${FIND_JS}\nreturn findStyleFor3D;`)(
    admin, "acme", json, dbFail, isUuid, null,
  ) as (v: string, id: string) => Promise<{ err?: R; style?: unknown }>;
  return { find, calls, fails };
}

const ID = "3f2b7c1e-8d4a-4b6e-9c1f-2a5d7e9b0c11";

Deno.test("findStyleFor3D: a styleId that is not a uuid is not found, and never reaches Postgres", async () => {
  const { find, calls } = load({ data: null, error: { code: "22P02", message: 'invalid input syntax for type uuid: "x"' } });
  const out = await find("", "not-a-uuid");
  assertEquals(out.err?.status, 404);
  assertEquals(calls, []);
});

Deno.test("findStyleFor3D: a database failure is dbFail's sentence, never Postgres's text", async () => {
  const pg = { code: "57014", message: "canceling statement due to statement timeout" };
  const { find, fails } = load({ data: null, error: pg });
  const out = await find("", ID);
  assertEquals(out.err?.status, 500);
  assertEquals(out.err?.body.ref, "find that style");
  assert(!JSON.stringify(out.err?.body).includes("statement timeout"));
  assertEquals(fails, [{ where: "find that style", err: pg }]);
});

Deno.test("findStyleFor3D: a real id and a style key still resolve, scoped to the tenant", async () => {
  const row = { id: ID, key: "urban" };
  const byId = load({ data: row, error: null });
  assertEquals((await byId.find("", ID)).style, row);
  assertEquals(byId.calls, ["from building_styles", "client_id=acme", `id=${ID}`]);
  const byKey = load({ data: row, error: null });
  assertEquals((await byKey.find("urban", "")).style, row);
  assertEquals(byKey.calls, ["from building_styles", "client_id=acme", "key=urban"]);
  const none = load({ data: null, error: null });
  assertEquals((await none.find("nope", "")).err?.status, 404);
});
