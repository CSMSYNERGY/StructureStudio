// The Google Routes call and its cache (2026-09-14). Nothing here reaches the network: every
// case hands `drivingMiles`/`resolveDistances` a fetch stub through `fetchImpl`, and the
// cache is a tiny in-test admin stub covering exactly the calls the module makes.
//
// Only jsr:@std/assert is imported — the pre-push gate runs _shared/*.test.ts with no import
// map, so anything else fails to resolve there.
//
// The key is read at call time, but it is set before the dynamic import anyway so this file
// keeps the same shape as salesTax.test.ts and keeps working if that ever changes.
Deno.env.set("GOOGLE_MAPS_SERVER_KEY", "test-key");
Deno.env.set("GOOGLE_ROUTES_API_BASE", "https://routes.test/");

import { assertEquals } from "jsr:@std/assert@1";

const { drivingMiles, resolveDistances, isConfigured } = await import("./deliveryDistance.ts");

const SHOP = { street: "1 Shop Rd", city: "Macon", state: "GA", zip: "31201" };
const LOT = { street: "2 Lot Ave", city: "Perry", state: "GA", zip: "31069" };
const DEST = { street: "9 Buyer Ln", city: "Warner Robins", state: "GA", zip: "31088" };

interface Seen { url: string; init: RequestInit }

/** A fetch stub that records each call and answers from the given sequence (last repeats). */
function fetchStub(answers: (() => Promise<Response>)[]) {
  const calls: Seen[] = [];
  const impl = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const i = Math.min(calls.length - 1, answers.length - 1);
    return answers[i]();
  }) as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200) => () =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

/** Two origins: the first has no route, the second is 99,999 m away (→ 63 miles). */
const MATRIX = [
  // proto3 JSON omits zero-valued fields: no originIndex/destinationIndex on element 0.
  { condition: "ROUTE_NOT_FOUND" },
  { originIndex: 1, destinationIndex: 0, distanceMeters: 99999, condition: "ROUTE_EXISTS" },
];

/** Run `fn` with the key unset, always restoring it. */
async function unconfigured(fn: () => Promise<void>) {
  const key = Deno.env.get("GOOGLE_MAPS_SERVER_KEY") ?? "";
  Deno.env.delete("GOOGLE_MAPS_SERVER_KEY");
  try { await fn(); } finally { Deno.env.set("GOOGLE_MAPS_SERVER_KEY", key); }
}

// ── drivingMiles ─────────────────────────────────────────────────────────────────────────

Deno.test("a matrix answer maps ROUTE_EXISTS to whole miles and everything else to null", async () => {
  const { impl, calls } = fetchStub([json(MATRIX)]);
  assertEquals(await drivingMiles([SHOP, LOT], DEST, impl), [null, 63]);
  assertEquals(calls.length, 1);
});

Deno.test("the request is ONE POST to computeRouteMatrix with the key, the field mask and the addresses", async () => {
  const { impl, calls } = fetchStub([json(MATRIX)]);
  await drivingMiles([SHOP, LOT], DEST, impl);
  const [{ url, init }] = calls;
  assertEquals(url, "https://routes.test/distanceMatrix/v2:computeRouteMatrix");
  assertEquals(init.method, "POST");
  const h = init.headers as Record<string, string>;
  assertEquals(h["Content-Type"], "application/json");
  assertEquals(h["X-Goog-Api-Key"], "test-key");
  assertEquals(h["X-Goog-FieldMask"], "originIndex,destinationIndex,distanceMeters,condition,status");
  assertEquals(JSON.parse(String(init.body)), {
    origins: [
      { waypoint: { address: "1 Shop Rd, Macon, GA 31201, USA" } },
      { waypoint: { address: "2 Lot Ave, Perry, GA 31069, USA" } },
    ],
    destinations: [{ waypoint: { address: "9 Buyer Ln, Warner Robins, GA 31088, USA" } }],
    travelMode: "DRIVE",
    regionCode: "us",
  });
  assertEquals(init.signal instanceof AbortSignal, true, "a timeout signal is attached");
});

Deno.test("a zero-length route (distanceMeters omitted by proto3 JSON) is 0 miles, not null", async () => {
  const { impl } = fetchStub([json([{ condition: "ROUTE_EXISTS" }])]);
  assertEquals(await drivingMiles([SHOP], DEST, impl), [0]);
});

Deno.test("a 4xx gives up immediately — all null, ONE fetch", async () => {
  const { impl, calls } = fetchStub([json({ error: { message: "API key not valid" } }, 403)]);
  assertEquals(await drivingMiles([SHOP, LOT], DEST, impl), [null, null]);
  assertEquals(calls.length, 1, "a 403 must not be retried");
});

Deno.test("a 5xx is retried once, and a 200 on the retry is used", async () => {
  const { impl, calls } = fetchStub([json("boom", 500), json(MATRIX)]);
  assertEquals(await drivingMiles([SHOP, LOT], DEST, impl), [null, 63]);
  assertEquals(calls.length, 2);
});

Deno.test("two 5xx in a row give up — all null, exactly two fetches", async () => {
  const { impl, calls } = fetchStub([json("boom", 503)]);
  assertEquals(await drivingMiles([SHOP, LOT], DEST, impl), [null, null]);
  assertEquals(calls.length, 2);
});

Deno.test("a timeout (fetch rejecting with an AbortError) never throws — all null", async () => {
  const { impl, calls } = fetchStub([() => Promise.reject(new DOMException("timed out", "TimeoutError"))]);
  assertEquals(await drivingMiles([SHOP, LOT], DEST, impl), [null, null]);
  assertEquals(calls.length, 2, "a timeout is retried once, like a 5xx");
});

Deno.test("a malformed body (not an array) is all null without a retry", async () => {
  const { impl, calls } = fetchStub([json({ elements: [] })]);
  assertEquals(await drivingMiles([SHOP], DEST, impl), [null]);
  assertEquals(calls.length, 1);
});

Deno.test("elements that point outside the request are ignored", async () => {
  const { impl } = fetchStub([json([
    { originIndex: 7, distanceMeters: 1, condition: "ROUTE_EXISTS" },      // no such origin
    { originIndex: 0, destinationIndex: 1, distanceMeters: 1, condition: "ROUTE_EXISTS" }, // no such destination
    "junk",
    { originIndex: 0, distanceMeters: "far", condition: "ROUTE_EXISTS" }, // not a number
  ])]);
  assertEquals(await drivingMiles([SHOP], DEST, impl), [null]);
});

Deno.test("empty origins never reach the network", async () => {
  const { impl, calls } = fetchStub([json(MATRIX)]);
  assertEquals(await drivingMiles([], DEST, impl), []);
  assertEquals(calls.length, 0);
});

Deno.test("not configured → all null, zero fetch calls", async () => {
  await unconfigured(async () => {
    assertEquals(isConfigured(), false);
    const { impl, calls } = fetchStub([json(MATRIX)]);
    assertEquals(await drivingMiles([SHOP, LOT], DEST, impl), [null, null]);
    assertEquals(calls.length, 0);
  });
  assertEquals(isConfigured(), true);
});

// ── resolveDistances ─────────────────────────────────────────────────────────────────────

interface CacheRow { origin_key: string; miles: number | null; resolved_at: string | null }

/** The subset of a supabase-js client the module touches, over an in-memory row list. */
function adminStub(rows: CacheRow[], readError: unknown = null) {
  const reads: { filters: [string, unknown][]; keys: string[] }[] = [];
  const upserts: { rows: Record<string, unknown>[]; opts: { onConflict: string } }[] = [];
  const admin = {
    from(table: string) {
      assertEquals(table, "delivery_distance_cache");
      const filters: [string, unknown][] = [];
      const chain = {
        select: (_cols: string) => chain,
        eq: (c: string, v: unknown) => { filters.push([c, v]); return chain; },
        in: (_c: string, keys: string[]) => {
          reads.push({ filters, keys });
          const data = readError ? null : rows.filter((r) => keys.includes(r.origin_key));
          return Promise.resolve({ data, error: readError });
        },
      };
      return {
        select: chain.select,
        upsert: (rs: Record<string, unknown>[], opts: { onConflict: string }) => {
          upserts.push({ rows: rs, opts });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return { admin, reads, upserts };
}

const NOW = new Date("2026-09-14T12:00:00Z");
const SHOP_KEY = "1 shop rd|macon|ga|31201";
const LOT_KEY = "2 lot ave|perry|ga|31069";
const DEST_KEY = "9 buyer ln|warner robins|ga|31088";
const ORIGINS = [{ name: "shop", address: SHOP }, { name: "Perry lot", address: LOT }];

Deno.test("a full cache hit answers with zero fetch calls and no upsert", async () => {
  const { admin, reads, upserts } = adminStub([
    { origin_key: SHOP_KEY, miles: 20, resolved_at: "2026-09-01T00:00:00Z" },
    { origin_key: LOT_KEY, miles: 45, resolved_at: "2026-09-01T00:00:00Z" },
  ]);
  const { impl, calls } = fetchStub([json(MATRIX)]);
  const out = await resolveDistances(admin, "acme", ORIGINS, DEST, { fetchImpl: impl, now: NOW });
  assertEquals(out, [
    { name: "shop", address: SHOP, miles: 20, cached: true },
    { name: "Perry lot", address: LOT, miles: 45, cached: true },
  ]);
  assertEquals(calls.length, 0);
  assertEquals(upserts.length, 0);
  // One read, scoped to the tenant and the destination, over both origin keys.
  assertEquals(reads.length, 1);
  assertEquals(reads[0].filters, [["client_id", "acme"], ["dest_key", DEST_KEY]]);
  assertEquals(reads[0].keys, [SHOP_KEY, LOT_KEY]);
});

Deno.test("a row older than 90 days is a miss and is refetched", async () => {
  const { admin, upserts } = adminStub([
    { origin_key: SHOP_KEY, miles: 20, resolved_at: "2026-06-01T00:00:00Z" }, // 105 days old
  ]);
  const { impl, calls } = fetchStub([json([{ distanceMeters: 40000, condition: "ROUTE_EXISTS" }])]);
  const out = await resolveDistances(admin, "acme", [ORIGINS[0]], DEST, { fetchImpl: impl, now: NOW });
  assertEquals(out, [{ name: "shop", address: SHOP, miles: 25, cached: false }]);
  assertEquals(calls.length, 1);
  assertEquals(upserts.length, 1);
});

Deno.test("a row exactly inside the window is still a hit", async () => {
  const { admin } = adminStub([
    { origin_key: SHOP_KEY, miles: 20, resolved_at: "2026-06-17T00:00:00Z" }, // 89 days old
  ]);
  const { impl, calls } = fetchStub([json(MATRIX)]);
  const out = await resolveDistances(admin, "acme", [ORIGINS[0]], DEST, { fetchImpl: impl, now: NOW });
  assertEquals(out[0].miles, 20);
  assertEquals(out[0].cached, true);
  assertEquals(calls.length, 0);
});

Deno.test("a miss fetches and upserts the resolved row with the right keys", async () => {
  const { admin, upserts } = adminStub([]);
  const { impl, calls } = fetchStub([json([{ distanceMeters: 99999, condition: "ROUTE_EXISTS" }])]);
  const out = await resolveDistances(admin, "acme", [ORIGINS[0]], DEST, { fetchImpl: impl, now: NOW });
  assertEquals(out, [{ name: "shop", address: SHOP, miles: 63, cached: false }]);
  assertEquals(calls.length, 1);
  assertEquals(upserts, [{
    rows: [{
      client_id: "acme",
      origin_key: SHOP_KEY,
      dest_key: DEST_KEY,
      miles: 63,
      provider: "google_routes",
      resolved_at: "2026-09-14T12:00:00.000Z",
    }],
    opts: { onConflict: "client_id,origin_key,dest_key" },
  }]);
});

Deno.test("partial hits fetch ONLY the misses, in one call, and come back in input order", async () => {
  const { admin, upserts } = adminStub([
    { origin_key: LOT_KEY, miles: 45, resolved_at: "2026-09-01T00:00:00Z" },
  ]);
  const { impl, calls } = fetchStub([json([{ distanceMeters: 30000, condition: "ROUTE_EXISTS" }])]);
  const out = await resolveDistances(admin, "acme", ORIGINS, DEST, { fetchImpl: impl, now: NOW });
  assertEquals(out, [
    { name: "shop", address: SHOP, miles: 19, cached: false },
    { name: "Perry lot", address: LOT, miles: 45, cached: true },
  ]);
  assertEquals(calls.length, 1);
  const body = JSON.parse(String(calls[0].init.body));
  assertEquals(body.origins.length, 1, "only the shop was looked up");
  assertEquals(body.origins[0].waypoint.address, "1 Shop Rd, Macon, GA 31201, USA");
  assertEquals(upserts.length, 1);
  assertEquals(upserts[0].rows.map((r) => r.origin_key), [SHOP_KEY]);
});

Deno.test("an unresolved distance is NOT cached — an outage must not be remembered for 90 days", async () => {
  const { admin, upserts } = adminStub([]);
  const { impl } = fetchStub([json([{ condition: "ROUTE_NOT_FOUND" }])]);
  const out = await resolveDistances(admin, "acme", [ORIGINS[0]], DEST, { fetchImpl: impl, now: NOW });
  assertEquals(out, [{ name: "shop", address: SHOP, miles: null, cached: false }]);
  assertEquals(upserts.length, 0);
});

Deno.test("a cached null is a miss, not a hit", async () => {
  const { admin } = adminStub([{ origin_key: SHOP_KEY, miles: null, resolved_at: "2026-09-01T00:00:00Z" }]);
  const { impl, calls } = fetchStub([json([{ distanceMeters: 1609, condition: "ROUTE_EXISTS" }])]);
  const out = await resolveDistances(admin, "acme", [ORIGINS[0]], DEST, { fetchImpl: impl, now: NOW });
  assertEquals([out[0].miles, out[0].cached], [1, false]);
  assertEquals(calls.length, 1);
});

Deno.test("a cache read error is a miss — the lookup still happens", async () => {
  const { admin } = adminStub([], { message: "relation does not exist" });
  const { impl, calls } = fetchStub([json([{ distanceMeters: 1609, condition: "ROUTE_EXISTS" }])]);
  const out = await resolveDistances(admin, "acme", [ORIGINS[0]], DEST, { fetchImpl: impl, now: NOW });
  assertEquals([out[0].miles, out[0].cached], [1, false]);
  assertEquals(calls.length, 1);
});

Deno.test("empty origins → empty result, no reads, no fetch", async () => {
  const { admin, reads } = adminStub([]);
  const { impl, calls } = fetchStub([json(MATRIX)]);
  assertEquals(await resolveDistances(admin, "acme", [], DEST, { fetchImpl: impl, now: NOW }), []);
  assertEquals(reads.length, 0);
  assertEquals(calls.length, 0);
});
