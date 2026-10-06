// Unit tests for _shared/serverTiming.ts (moved out of portal-settings on 2026-10-05 so
// sync-design-status can send the same header).
//
// Deliberately dependency-free (no jsr:/npm: imports) so this suite still runs on a machine
// with no registry access, the same rule the other _shared tests follow.
//
// What matters: the move changed nothing for portal-settings (its header is the same string,
// byte for byte, built from the old template copied below), a function's own spans land between
// `db` and `total`, nothing a span says can break the header, and the wrapper still hands back
// the SAME Response (withErrorLog's alreadyFiled check is by identity).
//
// Run: deno test --allow-env --allow-read supabase/functions/_shared/serverTiming.test.ts

import { addPhase, serverTimingValue, timedFetch, withServerTiming, type ServerTiming } from "./serverTiming.ts";

const assert = (cond: unknown, msg = "assertion failed") => {
  if (!cond) throw new Error(msg);
};
const assertEquals = (a: unknown, b: unknown, msg?: string) => {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(msg ? `${msg}: ${sa} !== ${sb}` : `${sa} !== ${sb}`);
};

// The header portal-settings built inline until 2026-10-05, verbatim.
function oldHeader(st: { auth: number; authPath?: string; db: number; dbN: number }, total: number, region: string) {
  const ms = (n: number) => Math.round(n);
  return `auth;desc="${st.authPath ?? "none"}";dur=${ms(st.auth)}, db;desc="${st.dbN} queries";dur=${ms(st.db)}, ` +
    `total;dur=${ms(total)}, region;desc="${region}"`;
}

Deno.test("no extra spans: the exact header portal-settings has sent since 10-01", () => {
  for (const st of [
    { auth: 0, db: 0, dbN: 0 },
    { auth: 141.6, authPath: "local", db: 238.49, dbN: 6 },
    { auth: 1060.5, authPath: "network", db: 2100.2, dbN: 7 },
  ]) {
    for (const [total, region] of [[0, "unknown"], [412.5, "us-east-1"]] as const) {
      assertEquals(serverTimingValue({ ...st }, total, region), oldHeader(st, total, region));
    }
  }
});

Deno.test("a function's own spans sit between db and total, in the order they were added", () => {
  const st: ServerTiming = { auth: 120, authPath: "local", db: 300, dbN: 5 };
  addPhase(st, "est", 812.4, "2 pages");
  addPhase(st, "opp", 640, "3 pages, by stage");
  addPhase(st, "writes", 41.2, "0 rows");
  assertEquals(serverTimingValue(st, 1500, "us-east-1"),
    `auth;desc="local";dur=120, db;desc="5 queries";dur=300, est;desc="2 pages";dur=812, ` +
      `opp;desc="3 pages, by stage";dur=640, writes;desc="0 rows";dur=41, total;dur=1500, region;desc="us-east-1"`);
  const bare: ServerTiming = { auth: 0, db: 0, dbN: 0 };
  addPhase(bare, "x", 1);
  assert(serverTimingValue(bare, 1, "r").includes(", x;dur=1, total"), "a span with no desc carries no desc");
});

Deno.test("nothing a span says can end the header's quoted string early", () => {
  const st: ServerTiming = { auth: 0, db: 0, dbN: 0 };
  addPhase(st, 'e"vil, name', 1, 'a "quoted" \\ desc\r\nX-Injected: 1');
  const v = serverTimingValue(st, 2, "r");
  assertEquals(v.split('"').length % 2, 1, `balanced quotes: ${v}`);
  assert(!/[\r\n]/.test(v), "no line breaks");
  assert(v.includes(`evilname;desc="a quoted  descX-Injected: 1";dur=1`), v);
});

Deno.test("timedFetch counts and sums every query, the failed ones too", async () => {
  const real = globalThis.fetch;
  const st: ServerTiming = { auth: 0, db: 0, dbN: 0 };
  try {
    globalThis.fetch = ((input: string | URL | Request) =>
      String(input).includes("fail")
        ? Promise.reject(new Error("network down"))
        : new Promise((r) => setTimeout(() => r(new Response("[]")), 5))) as typeof fetch;
    const f = timedFetch(st);
    await f("https://db.test/rest/v1/designs");
    await f("https://db.test/rest/v1/orders");
    let threw = false;
    try { await f("https://db.test/fail"); } catch { threw = true; }
    assert(threw, "the failure still reaches the caller");
    assertEquals(st.dbN, 3);
    assert(st.db >= 9, `summed: ${st.db}`);
  } finally {
    globalThis.fetch = real;
  }
});

Deno.test("withServerTiming: POSTs carry the header and expose it; a preflight is untouched; the Response is the same object", async () => {
  let made: Response | null = null;
  const h = withServerTiming(async (req, st) => {
    st.auth = 10; st.authPath = "local";
    addPhase(st, "est", 5, "skipped");
    made = new Response("{}", { headers: req.method === "POST" ? { "Access-Control-Expose-Headers": "X-SS-Refusal" } : {} });
    return made;
  });
  const post = await h(new Request("https://fn.test/x", { method: "POST", body: "{}" }));
  assert(post === made, "the same Response object");
  const v = post.headers.get("Server-Timing") ?? "";
  assert(/^auth;desc="local";dur=10, db;desc="0 queries";dur=0, est;desc="skipped";dur=5, total;dur=\d+, region;desc="[^"]+"$/.test(v), v);
  assertEquals(post.headers.get("Access-Control-Expose-Headers"), "X-SS-Refusal, Server-Timing");
  assertEquals(post.headers.get("Timing-Allow-Origin"), "*");

  const pre = await h(new Request("https://fn.test/x", { method: "OPTIONS" }));
  assertEquals(pre.headers.get("Server-Timing"), null);
  assertEquals(pre.headers.get("Timing-Allow-Origin"), null);
});

Deno.test("withServerTiming: an immutable response (a redirect) still goes out, untimed", async () => {
  const redirect = Response.redirect("https://fn.test/elsewhere", 302);
  const res = await withServerTiming(() => Promise.resolve(redirect))(new Request("https://fn.test/x", { method: "POST" }));
  assert(res === redirect, "returned as is");
  assertEquals(res.status, 302);
});

Deno.test("both importers use the shared copy and neither keeps its own", async () => {
  for (const fn of ["portal-settings", "sync-design-status"]) {
    const src = (await Deno.readTextFile(new URL(`../${fn}/index.ts`, import.meta.url))).replace(/\r\n/g, "\n");
    assert(src.includes(`from "../_shared/serverTiming.ts"`), `${fn} imports _shared/serverTiming.ts`);
    assert(src.includes("withServerTiming(async (req: Request, st: ServerTiming)"), `${fn} wraps its handler`);
    assert(src.includes("{ global: { fetch: timedFetch(st) } }"), `${fn}'s admin client is the timed one`);
    assert(!/function withServerTiming|const timedFetch/.test(src), `${fn} has no copy of its own`);
  }
});
