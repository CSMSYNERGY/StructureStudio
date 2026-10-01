// /quick-sends: each person's saved messages (plan section 2, migration 258). Scoping, validation,
// the 100 cap, and the starter-set seed on every list read.
import { describe, expect, it } from "vitest";
import {
  Auth, BASE, CLIENT, FakeNet, USER_A, USER_B, appRequest, call, callerCtx, filter, jsonRes, makeEnv, type Seen,
} from "./helpers";

const QS_1 = "00000000-0000-4000-8000-00000000d001";
const QS_2 = "00000000-0000-4000-8000-00000000d002";
const QS_3 = "00000000-0000-4000-8000-00000000d003";
const QS_B = "00000000-0000-4000-8000-00000000d0b2";
const QS_OTHER_TEAM = "00000000-0000-4000-8000-00000000d0c3";
const OTHER_CLIENT = "other-tenant";
const T0 = "2026-10-01T12:00:00.000Z";

interface Row {
  id: string;
  client_id: string;
  user_id: string;
  name: string;
  body: string;
  category: string | null;
  sort_order: number;
  usage_count: number;
  created_at: string;
  updated_at: string;
}

function row(id: string, over: Partial<Row> = {}): Row {
  return {
    id, client_id: CLIENT, user_id: USER_A, name: "Check in", body: "Hi {first_name}, just checking in.",
    category: "Follow-ups", sort_order: 0, usage_count: 0, created_at: T0, updated_at: T0, ...over,
  };
}

const out = ({ client_id: _c, user_id: _u, created_at: _t, ...r }: Row) => r;

/** phone_quick_sends on the fake network: honours the id/user_id/client_id filters, order and limit. */
function table(net: FakeNet, rows: Row[]) {
  const scoped = (s: Seen) => rows.filter((r) => (["id", "user_id", "client_id"] as const).every((col) => {
    const v = filter(s, col);
    return v === null || r[col] === v;
  }));
  net.rest("GET", "phone_quick_sends", (s) => {
    const order = s.url.searchParams.get("order") ?? "";
    const desc = order.startsWith("sort_order.desc");
    const sorted = [...scoped(s)].sort((a, b) => (desc ? b.sort_order - a.sort_order : a.sort_order - b.sort_order)
      || a.created_at.localeCompare(b.created_at));
    const limit = Number(s.url.searchParams.get("limit")) || sorted.length;
    return sorted.slice(0, limit);
  });
  net.rest("POST", "phone_quick_sends", (s) => {
    const r = row("00000000-0000-4000-8000-00000000dfff", { ...s.json, usage_count: 0, updated_at: T0 });
    rows.push(r);
    return [r];
  });
  net.rest("PATCH", "phone_quick_sends", (s) => {
    const hit = scoped(s);
    for (const r of hit) Object.assign(r, s.json);
    return hit;
  });
  net.rest("DELETE", "phone_quick_sends", (s) => {
    const hit = scoped(s);
    for (const r of hit) rows.splice(rows.indexOf(r), 1);
    return hit;
  });
  net.rpc("phone_quick_send_used", (s) => {
    const r = rows.find((x) => x.id === s.json.p_id && x.user_id === s.json.p_user && x.client_id === s.json.p_client);
    if (r) r.usage_count++;
    return !!r;
  });
  return rows;
}

async function setup(rows: Row[] = [], ctx: Record<string, unknown> = callerCtx()) {
  const net = new FakeNet().install();
  const auth = await new Auth().init();
  auth.serve(net);
  net.rpc("phone_caller_context", () => ctx);
  net.rpc("phone_seed_quick_sends", () => 0);
  net.rest("POST", "app_errors", () => []);
  return { net, rows: table(net, rows), token: await auth.token(USER_A), env: makeEnv() };
}

/** Someone else's (USER_B, same team) and the caller's own on another team: neither is theirs here. */
const strangers = () => [
  row(QS_B, { user_id: USER_B, name: "B's own" }),
  row(QS_OTHER_TEAM, { client_id: OTHER_CLIENT, name: "Other team" }),
];

describe("GET /quick-sends", () => {
  it("gives the starter set first, then lists only the caller's own on this team, in order", async () => {
    const { net, token, env } = await setup([
      row(QS_2, { name: "Second", sort_order: 1, category: null }),
      row(QS_1, { name: "First", sort_order: 0, usage_count: 3 }),
      ...strangers(),
    ]);
    const { json } = await call(env, appRequest("GET", "/quick-sends", token));
    expect(json).toEqual({
      ok: true,
      quick_sends: [
        { id: QS_1, name: "First", body: "Hi {first_name}, just checking in.", category: "Follow-ups", sort_order: 0, usage_count: 3, updated_at: T0 },
        { id: QS_2, name: "Second", body: "Hi {first_name}, just checking in.", category: null, sort_order: 1, usage_count: 0, updated_at: T0 },
      ],
    });

    const seed = net.rpcCalls("phone_seed_quick_sends");
    expect(seed).toHaveLength(1);
    expect(seed[0].json).toEqual({ p_user: USER_A, p_client: CLIENT });
    const read = net.reads("phone_quick_sends")[0];
    expect(net.seen.indexOf(seed[0])).toBeLessThan(net.seen.indexOf(read)); // seeded BEFORE the read
    expect(filter(read, "user_id")).toBe(USER_A);
    expect(filter(read, "client_id")).toBe(CLIENT);
    expect(read.url.searchParams.get("order")).toBe("sort_order.asc,created_at.asc");
  });

  it("a seed that fails still lists what they have, and is logged", async () => {
    const { net, token, env } = await setup([row(QS_1)]);
    net.rpc("phone_seed_quick_sends", () => jsonRes({ code: "XX000", message: "seed broke" }, 500));
    const { json } = await call(env, appRequest("GET", "/quick-sends", token));
    expect(json.ok).toBe(true);
    expect(json.quick_sends.map((q: { id: string }) => q.id)).toEqual([QS_1]);
    const logged = net.writes("app_errors").map((s) => s.json);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ code: "quick_send_seed_failed", client_id: CLIENT, severity: "error" });
    expect(logged[0].message).toContain("seed broke");
  });

  it("an empty list is an empty list", async () => {
    const { token, env } = await setup(strangers());
    expect((await call(env, appRequest("GET", "/quick-sends", token))).json).toEqual({ ok: true, quick_sends: [] });
  });

  it("works while the business's phone is still off (setting up before launch)", async () => {
    const { token, env } = await setup([row(QS_1)], callerCtx({ phone_status: "off" }));
    const { json } = await call(env, appRequest("GET", "/quick-sends", token));
    expect(json.quick_sends).toHaveLength(1);
  });
});

describe("POST /quick-sends", () => {
  it("adds one after the last, trimmed, owned by the caller on their team", async () => {
    const { net, token, env } = await setup([row(QS_1, { sort_order: 0 }), row(QS_2, { sort_order: 4 }), ...strangers().map((r) => ({ ...r, sort_order: 50 }))]);
    const { json } = await call(env, appRequest("POST", "/quick-sends", token, {
      name: "  Running late  ", body: "  Hi {first_name}, I'm running about 10 minutes late.\n", category: " Follow-ups ",
    }));
    expect(json.ok).toBe(true);
    expect(json.quick_send).toMatchObject({ name: "Running late", body: "Hi {first_name}, I'm running about 10 minutes late.", category: "Follow-ups", sort_order: 5, usage_count: 0 });
    const ins = net.writes("phone_quick_sends", "POST");
    expect(ins).toHaveLength(1);
    expect(ins[0].json).toEqual({
      name: "Running late", body: "Hi {first_name}, I'm running about 10 minutes late.", category: "Follow-ups",
      user_id: USER_A, client_id: CLIENT, sort_order: 5,
    });
    const count = net.reads("phone_quick_sends")[0];
    expect(filter(count, "user_id")).toBe(USER_A);
    expect(filter(count, "client_id")).toBe(CLIENT);
  });

  it.each([[undefined], [null], ["   "]])("the first one is sort_order 0, and category %j is none", async (category) => {
    const { net, token, env } = await setup(strangers());
    const { json } = await call(env, appRequest("POST", "/quick-sends", token, { name: "Thanks", body: "Thank you!", category }));
    expect(json.quick_send).toMatchObject({ sort_order: 0, category: null });
    expect(net.writes("phone_quick_sends", "POST")[0].json.category).toBeNull();
  });

  it("tidies runs of spaces in a category, so it can't make a second chip", async () => {
    const { net, token, env } = await setup();
    await call(env, appRequest("POST", "/quick-sends", token, { name: "x", body: "y", category: "Follow   ups" }));
    expect(net.writes("phone_quick_sends", "POST")[0].json.category).toBe("Follow ups");
  });

  it("counts characters the way the database does (an emoji is one)", async () => {
    const { net, token, env } = await setup();
    const { json } = await call(env, appRequest("POST", "/quick-sends", token, { name: "😀".repeat(60), body: "👍".repeat(1600), category: "é".repeat(30) }));
    expect(json.ok).toBe(true);
    expect(net.writes("phone_quick_sends", "POST")).toHaveLength(1);
  });

  it.each([
    [{ body: "Hello" }, "Give the quick send a name (up to 60 characters)."],
    [{ name: "   ", body: "Hello" }, "Give the quick send a name (up to 60 characters)."],
    [{ name: 42, body: "Hello" }, "Give the quick send a name (up to 60 characters)."],
    [{ name: "x".repeat(61), body: "Hello" }, "Give the quick send a name (up to 60 characters)."],
    [{ name: "Hi" }, "Write the message this quick send puts in the text box."],
    [{ name: "Hi", body: " \n " }, "Write the message this quick send puts in the text box."],
    [{ name: "Hi", body: "b".repeat(1601) }, "That message is too long. Keep it to 1,600 characters."],
    [{ name: "Hi", body: "Hello", category: "c".repeat(31) }, "Keep the category to 30 characters or fewer."],
    [{ name: "Hi", body: "Hello", category: ["Follow-ups"] }, "The category must be text."],
  ])("refuses %j in plain English, writing nothing", async (body, message) => {
    const { net, token, env } = await setup();
    const { res, json } = await call(env, appRequest("POST", "/quick-sends", token, body));
    expect(res.status).toBe(400);
    expect(json.error).toEqual({ code: "bad_request", message });
    expect(net.writes("phone_quick_sends")).toHaveLength(0);
  });

  it("refuses a body that isn't a JSON object", async () => {
    const { token, env } = await setup();
    const { json } = await call(env, appRequest("POST", "/quick-sends", token, ["name"]));
    expect(json.error.code).toBe("bad_request");
  });

  it("stops at 100 per person, and says what to do", async () => {
    const full = Array.from({ length: 100 }, (_, i) => row(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, { sort_order: i }));
    const { net, token, env } = await setup([...full, ...strangers()]);
    const { json } = await call(env, appRequest("POST", "/quick-sends", token, { name: "One more", body: "Hello" }));
    expect(json.error).toEqual({
      code: "bad_request",
      message: "You have 100 quick sends, which is the most you can keep. Delete one you don't use, then add this one.",
    });
    expect(net.writes("phone_quick_sends", "POST")).toHaveLength(0);
  });

  it("the 100th still fits, and other people's quick sends don't count against the caller", async () => {
    const mine = Array.from({ length: 99 }, (_, i) => row(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, { sort_order: i }));
    const theirs = Array.from({ length: 5 }, (_, i) => row(`00000000-0000-4000-8000-0000000b${String(i).padStart(4, "0")}`, { user_id: USER_B, sort_order: 200 + i }));
    const { token, env } = await setup([...mine, ...theirs]);
    const { json } = await call(env, appRequest("POST", "/quick-sends", token, { name: "Last", body: "Hello" }));
    expect(json.ok).toBe(true);
    expect(json.quick_send.sort_order).toBe(99);
  });
});

describe("POST /quick-sends/:id", () => {
  it("changes only the fields sent, on the caller's own row", async () => {
    const { net, rows, token, env } = await setup([row(QS_1, { name: "Old name", category: "Reminders" }), ...strangers()]);
    const { json } = await call(env, appRequest("POST", `/quick-sends/${QS_1}`, token, { body: "  New words for {first_name}  " }));
    expect(json.ok).toBe(true);
    expect(json.quick_send).toMatchObject({ id: QS_1, name: "Old name", body: "New words for {first_name}", category: "Reminders" });
    const patch = net.writes("phone_quick_sends", "PATCH")[0];
    expect(Object.keys(patch.json).sort()).toEqual(["body", "updated_at"]);
    expect(filter(patch, "id")).toBe(QS_1);
    expect(filter(patch, "user_id")).toBe(USER_A);
    expect(filter(patch, "client_id")).toBe(CLIENT);
    expect(rows.find((r) => r.id === QS_B)?.body).toBe("Hi {first_name}, just checking in.");
  });

  it.each([[null], [""]])("category %j takes the category away", async (category) => {
    const { net, token, env } = await setup([row(QS_1)]);
    const { json } = await call(env, appRequest("POST", `/quick-sends/${QS_1}`, token, { category }));
    expect(json.quick_send.category).toBeNull();
    expect(net.writes("phone_quick_sends", "PATCH")[0].json).toMatchObject({ category: null });
  });

  it("someone else's quick send, or the caller's own on another team, is not_found, like one that doesn't exist", async () => {
    const { rows, token, env } = await setup([row(QS_1), ...strangers()]);
    const answers = [];
    for (const id of [QS_B, QS_OTHER_TEAM, QS_3]) {
      const { res, json } = await call(env, appRequest("POST", `/quick-sends/${id}`, token, { name: "Mine now" }));
      expect(res.status).toBe(404);
      answers.push(json);
    }
    expect(answers).toEqual(Array(3).fill({ ok: false, error: { code: "not_found", message: "That quick send wasn't found." } }));
    expect(rows.map((r) => r.name)).not.toContain("Mine now");
  });

  it("an id that isn't a uuid is not_found, without asking the database", async () => {
    const { net, token, env } = await setup([row(QS_1)]);
    for (const id of ["not-a-uuid", "1", "00000000-0000-4000-8000-00000000d001%27%20or%201=1"]) {
      const { json } = await call(env, appRequest("POST", `/quick-sends/${id}`, token, { name: "x" }));
      expect(json.error.code).toBe("not_found");
    }
    expect(net.to(/\/rest\/v1\/phone_quick_sends/)).toHaveLength(0);
  });

  it("refuses an empty change and a bad field, writing nothing", async () => {
    const { net, token, env } = await setup([row(QS_1)]);
    expect((await call(env, appRequest("POST", `/quick-sends/${QS_1}`, token, {}))).json.error).toEqual({
      code: "bad_request", message: "There's nothing to change. Send a new name, message or category.",
    });
    expect((await call(env, appRequest("POST", `/quick-sends/${QS_1}`, token, { name: "" }))).json.error.message)
      .toBe("Give the quick send a name (up to 60 characters).");
    expect((await call(env, appRequest("POST", `/quick-sends/${QS_1}`, token, { body: null }))).json.error.message)
      .toBe("Write the message this quick send puts in the text box.");
    expect(net.writes("phone_quick_sends")).toHaveLength(0);
  });
});

describe("POST /quick-sends/:id/delete", () => {
  it("deletes the caller's own", async () => {
    const { net, rows, token, env } = await setup([row(QS_1), row(QS_2), ...strangers()]);
    const { json } = await call(env, appRequest("POST", `/quick-sends/${QS_1}/delete`, token));
    expect(json).toEqual({ ok: true });
    expect(rows.map((r) => r.id)).toEqual([QS_2, QS_B, QS_OTHER_TEAM]);
    const del = net.writes("phone_quick_sends", "DELETE")[0];
    expect(filter(del, "id")).toBe(QS_1);
    expect(filter(del, "user_id")).toBe(USER_A);
    expect(filter(del, "client_id")).toBe(CLIENT);
  });

  it("someone else's is not_found and stays", async () => {
    const { rows, token, env } = await setup(strangers());
    for (const id of [QS_B, QS_OTHER_TEAM]) {
      const { json } = await call(env, appRequest("POST", `/quick-sends/${id}/delete`, token));
      expect(json.error).toEqual({ code: "not_found", message: "That quick send wasn't found." });
    }
    expect(rows).toHaveLength(2);
  });

  it("a malformed id is not_found without asking the database", async () => {
    const { net, token, env } = await setup();
    expect((await call(env, appRequest("POST", "/quick-sends/abc/delete", token))).json.error.code).toBe("not_found");
    expect(net.to(/\/rest\/v1\/phone_quick_sends/)).toHaveLength(0);
  });
});

describe("POST /quick-sends/:id/used", () => {
  it("counts one Insert on the caller's own, in the database", async () => {
    const { net, rows, token, env } = await setup([row(QS_1, { usage_count: 2 })]);
    const { json } = await call(env, appRequest("POST", `/quick-sends/${QS_1}/used`, token));
    expect(json).toEqual({ ok: true });
    expect(net.rpcCalls("phone_quick_send_used")[0].json).toEqual({ p_id: QS_1, p_user: USER_A, p_client: CLIENT });
    expect(rows[0].usage_count).toBe(3);
    expect(net.writes("phone_quick_sends")).toHaveLength(0); // the RPC, never a read-then-write
  });

  it("someone else's is not_found and isn't counted", async () => {
    const { rows, token, env } = await setup(strangers());
    for (const id of [QS_B, QS_OTHER_TEAM]) {
      expect((await call(env, appRequest("POST", `/quick-sends/${id}/used`, token))).json.error.code).toBe("not_found");
    }
    expect(rows.map((r) => r.usage_count)).toEqual([0, 0]);
  });

  it("a malformed id is not_found without asking the database", async () => {
    const { net, token, env } = await setup();
    expect((await call(env, appRequest("POST", "/quick-sends/nope/used", token))).json.error.code).toBe("not_found");
    expect(net.rpcCalls("phone_quick_send_used")).toHaveLength(0);
  });
});

describe("who may use /quick-sends", () => {
  const all: [string, string][] = [
    ["GET", "/quick-sends"],
    ["POST", "/quick-sends"],
    ["POST", `/quick-sends/${QS_1}`],
    ["POST", `/quick-sends/${QS_1}/delete`],
    ["POST", `/quick-sends/${QS_1}/used`],
  ];

  it.each(all)("%s %s needs a login", async (method, path) => {
    const { net, env } = await setup([row(QS_1)]);
    const { res, json } = await call(env, new Request(`${BASE}${path}`, { method, ...(method === "POST" ? { body: JSON.stringify({ name: "x", body: "y" }) } : {}) }));
    expect(res.status).toBe(401);
    expect(json.error.code).toBe("unauthorized");
    expect(net.to(/\/rest\/v1\/(phone_quick_sends|rpc\/phone_(seed_quick_sends|quick_send_used))/)).toHaveLength(0);
  });

  it.each(all)("%s %s needs phone access", async (method, path) => {
    const { net, token, env } = await setup([row(QS_1)], callerCtx({ phone_level: "none" }));
    const { res, json } = await call(env, appRequest(method, path, token, method === "POST" ? { name: "x", body: "y" } : undefined));
    expect(res.status).toBe(403);
    expect(json.error.code).toBe("no_phone_access");
    expect(net.to(/\/rest\/v1\/(phone_quick_sends|rpc\/phone_(seed_quick_sends|quick_send_used))/)).toHaveLength(0);
  });

  it("someone on no team is refused", async () => {
    const { token, env } = await setup([], null as unknown as Record<string, unknown>);
    expect((await call(env, appRequest("GET", "/quick-sends", token))).json.error.code).toBe("no_phone_access");
  });

  it("the wrong method is a 405, not an update", async () => {
    const { net, token, env } = await setup([row(QS_1)]);
    for (const path of [`/quick-sends/${QS_1}`, `/quick-sends/${QS_1}/delete`, `/quick-sends/${QS_1}/used`]) {
      expect((await call(env, appRequest("GET", path, token))).res.status).toBe(405);
    }
    expect(net.writes("phone_quick_sends")).toHaveLength(0);
  });
});
