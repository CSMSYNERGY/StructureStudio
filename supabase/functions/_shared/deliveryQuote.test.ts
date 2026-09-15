// The single delivery authority (2026-09-14): origin selection per mode, the flat short-cut,
// and every named reason. The database is an in-memory stub over the five tables the module
// reads; Google is a fetch stub that prices each origin by the address text it is sent, so
// "nearest picks the closer lot" is asserted on the ORIGIN NAME that comes back, not on
// arithmetic the deliveryFee tests already cover.
//
// Only jsr:@std/assert is imported — the pre-push gate runs _shared/*.test.ts with no import
// map, so anything else fails to resolve there.
Deno.env.set("GOOGLE_MAPS_SERVER_KEY", "test-key");
Deno.env.set("GOOGLE_ROUTES_API_BASE", "https://routes.test");

import { assertEquals } from "jsr:@std/assert@1";

const { quoteDelivery } = await import("./deliveryQuote.ts");

type Row = Record<string, unknown>;

/**
 * A supabase-js service client over plain rows: from(t).select().eq()…maybeSingle() and the
 * thenable list form, plus upsert (recorded, never applied). Enough for every read the
 * module makes, and nothing it does not.
 */
function adminStub(tables: Record<string, Row[]>) {
  const upserts: { table: string; rows: Row[] }[] = [];
  const admin = {
    from(table: string) {
      const rows = tables[table] ?? [];
      const filters: [string, unknown][] = [];
      const ins: [string, unknown[]][] = [];
      const matches = () =>
        rows.filter((r) => filters.every(([c, v]) => r[c] === v) && ins.every(([c, vs]) => vs.includes(r[c])));
      const chain = {
        select: (_cols: string) => chain,
        eq: (c: string, v: unknown) => { filters.push([c, v]); return chain; },
        in: (c: string, vs: unknown[]) => { ins.push([c, vs]); return chain; },
        maybeSingle: () => Promise.resolve({ data: matches()[0] ?? null, error: null }),
        then: (res: (v: { data: Row[]; error: null }) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve({ data: matches(), error: null }).then(res, rej),
      };
      return {
        select: chain.select,
        upsert: (rs: Row[]) => { upserts.push({ table, rows: rs }); return Promise.resolve({ error: null }); },
      };
    },
  };
  return { admin, upserts };
}

/**
 * Google, answering by the origin address it is sent: `meters` maps a substring of the
 * address line to a distance; an origin matching nothing is ROUTE_NOT_FOUND.
 */
function routesStub(meters: Record<string, number>) {
  const calls: { origins: string[] }[] = [];
  const impl = ((_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const origins: string[] = body.origins.map((o: { waypoint: { address: string } }) => o.waypoint.address);
    calls.push({ origins });
    const elements = origins.map((addr, originIndex) => {
      const hit = Object.entries(meters).find(([needle]) => addr.includes(needle));
      return hit
        ? { originIndex, destinationIndex: 0, distanceMeters: hit[1], condition: "ROUTE_EXISTS" }
        : { originIndex, destinationIndex: 0, condition: "ROUTE_NOT_FOUND" };
    });
    return Promise.resolve(new Response(JSON.stringify(elements), { status: 200, headers: { "content-type": "application/json" } }));
  }) as typeof fetch;
  return { impl, calls };
}

const CLIENT = "acme";
const DEST = { street: "9 Buyer Ln", city: "Warner Robins", state: "GA", zip: "31088" };

const BUSINESS = {
  client_id: CLIENT,
  business_name: "Acme Barns",
  ss_tax_delivery: false,
  business_address: { addressLine1: "1 Shop Rd", city: "Macon", state: "GA", postalCode: "31201", countryCode: "US" },
};
const LOT_PERRY = { id: "lot-perry", client_id: CLIENT, name: "Perry lot", street: "2 Lot Ave", city: "Perry", state: "GA", zip: "31069", active: true };
const LOT_DUBLIN = { id: "lot-dublin", client_id: CLIENT, name: "Dublin lot", street: "3 Lot Ave", city: "Dublin", state: "GA", zip: "31021", active: true };
const LOT_CLOSED = { id: "lot-closed", client_id: CLIENT, name: "Old lot", street: "4 Lot Ave", city: "Cochran", state: "GA", zip: "31014", active: false };

const BASE_PLUS = { client_id: CLIENT, automate: true, origin_mode: "nearest", rule_type: "base_plus", base_fee: 100, per_mile: 2, per_mile_counts: "beyond", bands: [] };

const MILES = 1609.344;

function db(over: { settings?: Row | null; clientSettings?: Row | null; lots?: Row[]; users?: Row[] } = {}) {
  return adminStub({
    delivery_settings: over.settings === null ? [] : [over.settings ?? BASE_PLUS],
    client_settings: over.clientSettings === null ? [] : [over.clientSettings ?? BUSINESS],
    builder_locations: over.lots ?? [LOT_PERRY, LOT_DUBLIN, LOT_CLOSED],
    client_users: over.users ?? [],
    delivery_distance_cache: [],
  });
}

// ── The flat short-cut ───────────────────────────────────────────────────────────────────

Deno.test("a flat rule never calls Google and never needs an origin", async () => {
  const { admin } = db({ settings: { ...BASE_PLUS, rule_type: "flat", flat_fee: 150 }, clientSettings: { ...BUSINESS, business_address: null } });
  const { impl, calls } = routesStub({});
  const q = await quoteDelivery(admin, { clientId: CLIENT, address: DEST, repUserId: null, fetchImpl: impl });
  assertEquals(calls.length, 0);
  assertEquals(q, {
    configured: true, automate: true, originMode: "nearest", ruleType: "flat",
    miles: null, originName: null, amount: 150, autoPriced: true, reason: null, desc: "Delivery",
    taxable: false, distanceConfigured: true,
  });
});

// ── Origin modes ─────────────────────────────────────────────────────────────────────────

Deno.test("nearest: business + every ACTIVE lot are sent, and the closest one prices the trip", async () => {
  const { admin } = db();
  const { impl, calls } = routesStub({ "Macon": 60 * MILES, "Perry": 12 * MILES, "Dublin": 40 * MILES });
  const q = await quoteDelivery(admin, { clientId: CLIENT, address: DEST, repUserId: null, fetchImpl: impl });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].origins, [
    "1 Shop Rd, Macon, GA 31201, USA",
    "2 Lot Ave, Perry, GA 31069, USA",
    "3 Lot Ave, Dublin, GA 31021, USA",
  ]);
  assertEquals([q.originName, q.miles, q.amount, q.autoPriced, q.reason], ["Perry lot", 12, 124, true, null]);
  assertEquals(q.desc, "Delivery — 12 miles from Perry lot");
});

Deno.test("nearest: the business address wins a tie because it is listed first", async () => {
  const { admin } = db();
  const { impl } = routesStub({ "Macon": 12 * MILES, "Perry": 12 * MILES, "Dublin": 40 * MILES });
  const q = await quoteDelivery(admin, { clientId: CLIENT, address: DEST, repUserId: null, fetchImpl: impl });
  assertEquals(q.originName, "Acme Barns");
});

Deno.test("business: only the business address is sent, even when a lot is closer", async () => {
  const { admin } = db({ settings: { ...BASE_PLUS, origin_mode: "business" } });
  const { impl, calls } = routesStub({ "Macon": 60 * MILES, "Perry": 12 * MILES });
  const q = await quoteDelivery(admin, { clientId: CLIENT, address: DEST, repUserId: "rep-1", fetchImpl: impl });
  assertEquals(calls[0].origins, ["1 Shop Rd, Macon, GA 31201, USA"]);
  assertEquals([q.originMode, q.originName, q.miles, q.amount], ["business", "Acme Barns", 60, 220]);
});

Deno.test("business with no business address → no_origin, and Google is never called", async () => {
  const { admin } = db({ settings: { ...BASE_PLUS, origin_mode: "business" }, clientSettings: { ...BUSINESS, business_address: null } });
  const { impl, calls } = routesStub({ "Perry": 12 * MILES });
  const q = await quoteDelivery(admin, { clientId: CLIENT, address: DEST, repUserId: null, fetchImpl: impl });
  assertEquals(calls.length, 0);
  assertEquals([q.configured, q.reason, q.amount, q.autoPriced, q.desc], [true, "no_origin", null, false, "Delivery"]);
});

Deno.test("a business address without city+state+zip is not an origin", async () => {
  const { admin } = db({
    settings: { ...BASE_PLUS, origin_mode: "business" },
    clientSettings: { ...BUSINESS, business_address: { addressLine1: "1 Shop Rd", city: "Macon", state: "GA", postalCode: null } },
  });
  const { impl, calls } = routesStub({ "Macon": 10 * MILES });
  const q = await quoteDelivery(admin, { clientId: CLIENT, address: DEST, repUserId: null, fetchImpl: impl });
  assertEquals([q.reason, calls.length], ["no_origin", 0]);
});

Deno.test("rep with a home lot: ONLY that lot is sent", async () => {
  const { admin } = db({
    settings: { ...BASE_PLUS, origin_mode: "rep" },
    users: [{ client_id: CLIENT, user_id: "rep-1", location_id: "lot-dublin" }],
  });
  const { impl, calls } = routesStub({ "Macon": 5 * MILES, "Perry": 12 * MILES, "Dublin": 40 * MILES });
  const q = await quoteDelivery(admin, { clientId: CLIENT, address: DEST, repUserId: "rep-1", fetchImpl: impl });
  assertEquals(calls[0].origins, ["3 Lot Ave, Dublin, GA 31021, USA"]);
  assertEquals([q.originMode, q.originName, q.miles, q.amount], ["rep", "Dublin lot", 40, 180]);
});

Deno.test("rep without a home lot falls through to nearest", async () => {
  const { admin } = db({
    settings: { ...BASE_PLUS, origin_mode: "rep" },
    users: [{ client_id: CLIENT, user_id: "rep-1", location_id: null }],
  });
  const { impl, calls } = routesStub({ "Macon": 60 * MILES, "Perry": 12 * MILES, "Dublin": 40 * MILES });
  const q = await quoteDelivery(admin, { clientId: CLIENT, address: DEST, repUserId: "rep-1", fetchImpl: impl });
  assertEquals(calls[0].origins.length, 3);
  assertEquals([q.originMode, q.originName, q.miles], ["rep", "Perry lot", 12]);
});

Deno.test("rep whose home lot is INACTIVE falls through to nearest — a closed lot is not an origin", async () => {
  const { admin } = db({
    settings: { ...BASE_PLUS, origin_mode: "rep" },
    users: [{ client_id: CLIENT, user_id: "rep-1", location_id: "lot-closed" }],
  });
  const { impl, calls } = routesStub({ "Cochran": 1 * MILES, "Perry": 12 * MILES });
  const q = await quoteDelivery(admin, { clientId: CLIENT, address: DEST, repUserId: "rep-1", fetchImpl: impl });
  assertEquals(calls[0].origins.includes("4 Lot Ave, Cochran, GA 31014, USA"), false);
  assertEquals(q.originName, "Perry lot");
});

Deno.test("rep mode with no rep at all (the public designer) is nearest", async () => {
  const { admin } = db({ settings: { ...BASE_PLUS, origin_mode: "rep" } });
  const { impl, calls } = routesStub({ "Perry": 12 * MILES });
  const q = await quoteDelivery(admin, { clientId: CLIENT, address: DEST, repUserId: null, fetchImpl: impl });
  assertEquals(calls[0].origins.length, 3);
  assertEquals(q.originName, "Perry lot");
});

Deno.test("rep mode when the client_users read THROWS (column not migrated yet) still prices from nearest", async () => {
  const { admin } = db({ settings: { ...BASE_PLUS, origin_mode: "rep" } });
  const real = admin.from.bind(admin);
  // deno-lint-ignore no-explicit-any
  (admin as any).from = (table: string) => {
    if (table === "client_users") throw new Error("column client_users.location_id does not exist");
    return real(table);
  };
  const { impl } = routesStub({ "Perry": 12 * MILES });
  const q = await quoteDelivery(admin, { clientId: CLIENT, address: DEST, repUserId: "rep-1", fetchImpl: impl });
  assertEquals([q.originName, q.amount], ["Perry lot", 124]);
});

// ── Named reasons ────────────────────────────────────────────────────────────────────────

Deno.test("no delivery_settings row → configured false, not_configured, taxable still reported", async () => {
  const { admin } = db({ settings: null, clientSettings: { ...BUSINESS, ss_tax_delivery: true } });
  const { impl, calls } = routesStub({ "Perry": 12 * MILES });
  const q = await quoteDelivery(admin, { clientId: CLIENT, address: DEST, repUserId: null, fetchImpl: impl });
  assertEquals(calls.length, 0);
  assertEquals(q, {
    configured: false, automate: false, originMode: null, ruleType: null,
    miles: null, originName: null, amount: null, autoPriced: false, reason: "not_configured", desc: "Delivery",
    taxable: true, distanceConfigured: true,
  });
});

Deno.test("no Google key → distance_not_configured, and the fetch stub is never reached", async () => {
  Deno.env.delete("GOOGLE_MAPS_SERVER_KEY");
  try {
    const { admin } = db();
    const { impl, calls } = routesStub({ "Perry": 12 * MILES });
    const q = await quoteDelivery(admin, { clientId: CLIENT, address: DEST, repUserId: null, fetchImpl: impl });
    assertEquals(calls.length, 0);
    assertEquals([q.configured, q.distanceConfigured, q.reason, q.amount, q.originMode, q.ruleType],
      [true, false, "distance_not_configured", null, "nearest", "base_plus"]);
  } finally {
    Deno.env.set("GOOGLE_MAPS_SERVER_KEY", "test-key");
  }
});

Deno.test("no Google key with a FLAT rule still prices — distance was never needed", async () => {
  Deno.env.delete("GOOGLE_MAPS_SERVER_KEY");
  try {
    const { admin } = db({ settings: { ...BASE_PLUS, rule_type: "flat", flat_fee: 95 } });
    const q = await quoteDelivery(admin, { clientId: CLIENT, address: DEST, repUserId: null });
    assertEquals([q.amount, q.autoPriced, q.distanceConfigured], [95, true, false]);
  } finally {
    Deno.env.set("GOOGLE_MAPS_SERVER_KEY", "test-key");
  }
});

Deno.test("bands beyond the last band → autoPriced false WITH the miles and origin set", async () => {
  const { admin } = db({
    settings: {
      ...BASE_PLUS, rule_type: "bands",
      bands: [{ minMiles: 0, maxMiles: 25, fee: 100 }, { minMiles: 26, maxMiles: 50, fee: 175 }],
    },
  });
  const { impl } = routesStub({ "Macon": 80 * MILES, "Perry": 62 * MILES, "Dublin": 90 * MILES });
  const q = await quoteDelivery(admin, { clientId: CLIENT, address: DEST, repUserId: null, fetchImpl: impl });
  assertEquals([q.amount, q.autoPriced, q.reason, q.miles, q.originName, q.ruleType],
    [null, false, "beyond_last_band", 62, "Perry lot", "bands"]);
  assertEquals(q.desc, "Delivery — 62 miles from Perry lot");
});

Deno.test("bands inside a band price normally", async () => {
  const { admin } = db({
    settings: { ...BASE_PLUS, rule_type: "bands", bands: [{ min_miles: 0, max_miles: 25, fee: "100" }, { min_miles: 26, max_miles: 50, fee: "175" }] },
  });
  const { impl } = routesStub({ "Perry": 26 * MILES });
  const q = await quoteDelivery(admin, { clientId: CLIENT, address: DEST, repUserId: null, fetchImpl: impl });
  assertEquals([q.amount, q.autoPriced, q.miles], [175, true, 26]);
});

Deno.test("a rule card that fails validation → rule_incomplete, no Google call", async () => {
  const { admin } = db({ settings: { ...BASE_PLUS, base_fee: -5 } });
  const { impl, calls } = routesStub({ "Perry": 12 * MILES });
  const q = await quoteDelivery(admin, { clientId: CLIENT, address: DEST, repUserId: null, fetchImpl: impl });
  assertEquals(calls.length, 0);
  assertEquals([q.configured, q.reason, q.ruleType, q.originMode, q.amount], [true, "rule_incomplete", null, "nearest", null]);
});

Deno.test("a half-filled card → rule_incomplete AFTER the distance, so the miles are still shown", async () => {
  const { admin } = db({ settings: { ...BASE_PLUS, base_fee: null } });
  const { impl } = routesStub({ "Perry": 12 * MILES });
  const q = await quoteDelivery(admin, { clientId: CLIENT, address: DEST, repUserId: null, fetchImpl: impl });
  assertEquals([q.reason, q.miles, q.originName, q.amount, q.desc],
    ["rule_incomplete", 12, "Perry lot", null, "Delivery — 12 miles from Perry lot"]);
});

Deno.test("Google answers but no origin reaches the address → no_route", async () => {
  const { admin } = db();
  const { impl, calls } = routesStub({}); // every origin ROUTE_NOT_FOUND
  const q = await quoteDelivery(admin, { clientId: CLIENT, address: DEST, repUserId: null, fetchImpl: impl });
  assertEquals(calls.length, 1);
  assertEquals([q.reason, q.miles, q.originName, q.amount, q.desc], ["no_route", null, null, null, "Delivery"]);
});

Deno.test("free_radius inside the radius → $0, priced, with the note", async () => {
  const { admin } = db({ settings: { ...BASE_PLUS, rule_type: "free_radius", free_miles: 30, per_mile: 3 } });
  const { impl } = routesStub({ "Perry": 12 * MILES });
  const q = await quoteDelivery(admin, { clientId: CLIENT, address: DEST, repUserId: null, fetchImpl: impl });
  assertEquals([q.amount, q.autoPriced, q.desc], [0, true, "Delivery — 12 miles from Perry lot (free within 30 miles)"]);
});

Deno.test("automate is REPORTED, not enforced — an automate-off tenant still gets the preview figure", async () => {
  const { admin } = db({ settings: { ...BASE_PLUS, automate: false } });
  const { impl } = routesStub({ "Perry": 12 * MILES });
  const q = await quoteDelivery(admin, { clientId: CLIENT, address: DEST, repUserId: null, fetchImpl: impl });
  assertEquals([q.automate, q.amount, q.autoPriced], [false, 124, true]);
});

Deno.test("taxable mirrors client_settings.ss_tax_delivery", async () => {
  const { admin } = db({ clientSettings: { ...BUSINESS, ss_tax_delivery: true } });
  const { impl } = routesStub({ "Perry": 12 * MILES });
  const q = await quoteDelivery(admin, { clientId: CLIENT, address: DEST, repUserId: null, fetchImpl: impl });
  assertEquals(q.taxable, true);
  const { admin: none } = db({ clientSettings: null });
  const q2 = await quoteDelivery(none, { clientId: CLIENT, address: DEST, repUserId: null, fetchImpl: impl });
  assertEquals(q2.taxable, false);
});

Deno.test("a resolved distance is written to the cache for next time", async () => {
  const { admin, upserts } = db();
  const { impl } = routesStub({ "Macon": 60 * MILES, "Perry": 12 * MILES, "Dublin": 40 * MILES });
  await quoteDelivery(admin, { clientId: CLIENT, address: DEST, repUserId: null, fetchImpl: impl });
  assertEquals(upserts.length, 1);
  assertEquals(upserts[0].table, "delivery_distance_cache");
  assertEquals(upserts[0].rows.map((r) => [r.origin_key, r.miles]), [
    ["1 shop rd|macon|ga|31201", 60],
    ["2 lot ave|perry|ga|31069", 12],
    ["3 lot ave|dublin|ga|31021", 40],
  ]);
});
