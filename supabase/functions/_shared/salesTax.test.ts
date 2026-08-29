// Deliberately dependency-free (no jsr:/npm: imports) so this suite still runs on a machine
// with no registry access — the same rule the other _shared tests follow.
//
// The property under test is the one that makes this module different from its neighbours:
// it NEVER degrades to no tax. Every failure lands on the tenant's own configured rate and
// says why, because a quote issued untaxed is a quote signed at the wrong number.
//
// Env is read at module load, so the credential-dependent cases set it BEFORE the dynamic
// import below and every case afterwards runs configured.
Deno.env.set("AVALARA_ACCOUNT_ID", "test-account");
Deno.env.set("AVALARA_LICENSE_KEY", "test-key");
Deno.env.set("AVALARA_API_BASE", "https://avatax.test");

const { resolveRate, taxOn, taxable, isConfigured } = await import("./salesTax.ts");

function assertEquals(actual: unknown, expected: unknown, msg?: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg ?? "assertEquals"}\n  actual:   ${a}\n  expected: ${e}`);
}

const ADDR = { street: "100 Example Rd", city: "Macon", state: "GA", zip: "31201" };
const FALLBACK = 0.06;

/** Swap globalThis.fetch for one case, always restoring it. */
async function withFetch(handler: (url: string) => Promise<Response>, run: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => handler(String(input))) as typeof fetch;
  try { await run(); } finally { globalThis.fetch = original; }
}

const ok = (body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));

// ── The happy path ───────────────────────────────────────────────────────────────────────

Deno.test("a resolved address gives the Avalara rate and names the county", async () => {
  await withFetch(
    () => ok({
      totalRate: 0.0725,
      rates: [
        { rate: 0.04, name: "GEORGIA", type: "State" },
        { rate: 0.03, name: "BIBB", type: "County" },
        { rate: 0.0025, name: "MACON", type: "City" },
      ],
    }),
    async () => {
      const r = await resolveRate(ADDR, FALLBACK);
      assertEquals([r.rate, r.jurisdiction, r.source, r.reason], [0.0725, "BIBB, GA", "avalara", null]);
    },
  );
});

Deno.test("the request carries the delivery address, not the business address", async () => {
  let seen = "";
  await withFetch(
    (url) => { seen = url; return ok({ totalRate: 0.07, rates: [] }); },
    async () => { await resolveRate(ADDR, FALLBACK); },
  );
  const q = new URL(seen).searchParams;
  assertEquals(
    [q.get("postalCode"), q.get("region"), q.get("city"), q.get("country")],
    ["31201", "GA", "Macon", "US"],
  );
});

Deno.test("with no county, the jurisdiction falls back to city then state, never a guess", async () => {
  await withFetch(
    () => ok({ totalRate: 0.04, rates: [{ rate: 0.04, name: "MACON", type: "City" }] }),
    async () => assertEquals((await resolveRate(ADDR, FALLBACK)).jurisdiction, "MACON, GA"),
  );
  await withFetch(
    () => ok({ totalRate: 0.04, rates: [] }),
    async () => assertEquals((await resolveRate(ADDR, FALLBACK)).jurisdiction, "GA"),
  );
});

// ── Every failure lands on the fallback, and says why ────────────────────────────────────

Deno.test("a timeout falls back to the tenant's own rate", async () => {
  await withFetch(
    () => Promise.reject(new DOMException("timed out", "TimeoutError")),
    async () => {
      const r = await resolveRate(ADDR, FALLBACK);
      assertEquals([r.rate, r.source, r.reason], [FALLBACK, "fallback", "avalara lookup failed"]);
    },
  );
});

Deno.test("a 4xx falls back WITHOUT retrying — bad credentials do not improve on a second ask", async () => {
  let calls = 0;
  await withFetch(
    () => { calls++; return Promise.resolve(new Response("nope", { status: 401 })); },
    async () => assertEquals((await resolveRate(ADDR, FALLBACK)).source, "fallback"),
  );
  assertEquals(calls, 1, "a 401 must not be retried");
});

Deno.test("a 5xx IS retried once, and a second failure falls back", async () => {
  let calls = 0;
  await withFetch(
    () => { calls++; return Promise.resolve(new Response("boom", { status: 503 })); },
    async () => assertEquals((await resolveRate(ADDR, FALLBACK)).source, "fallback"),
  );
  assertEquals(calls, 2, "a 503 gets exactly one retry");
});

Deno.test("a 5xx that succeeds on the retry uses the real rate", async () => {
  let calls = 0;
  await withFetch(
    () => (++calls === 1
      ? Promise.resolve(new Response("boom", { status: 503 }))
      : ok({ totalRate: 0.0725, rates: [] })),
    async () => {
      const r = await resolveRate(ADDR, FALLBACK);
      assertEquals([r.rate, r.source], [0.0725, "avalara"]);
    },
  );
});

Deno.test("a malformed body falls back rather than charging a garbage rate", async () => {
  for (const body of [{}, { totalRate: null }, { totalRate: "lots" }, { totalRate: -1 }]) {
    await withFetch(() => ok(body), async () => {
      assertEquals((await resolveRate(ADDR, FALLBACK)).source, "fallback", JSON.stringify(body));
    });
  }
});

Deno.test("a percent-shaped rate is REFUSED, not charged", async () => {
  // Avalara returns 0.0725. A 7.25 arriving here — an API change, a different endpoint, a
  // mock — would multiply every bill by a hundred. The 25% ceiling is the same one migration
  // 127 puts on the stored fallback.
  await withFetch(
    () => ok({ totalRate: 7.25, rates: [] }),
    async () => {
      const r = await resolveRate(ADDR, FALLBACK);
      assertEquals([r.rate, r.source], [FALLBACK, "fallback"]);
    },
  );
});

Deno.test("an unusable address never reaches the network", async () => {
  let called = false;
  await withFetch(
    () => { called = true; return ok({ totalRate: 0.07, rates: [] }); },
    async () => {
      for (const addr of [
        { street: null, city: "Macon", state: "GA", zip: null },   // no postcode
        { street: null, city: "Macon", state: null, zip: "31201" }, // no region
        { street: null, city: null, state: null, zip: null },
      ]) {
        const r = await resolveRate(addr, FALLBACK);
        assertEquals([r.rate, r.source, r.reason],
          [FALLBACK, "fallback", "no state/postcode on the delivery address"]);
      }
    },
  );
  assertEquals(called, false, "an address with no jurisdiction must not cost a lookup");
});

Deno.test("taxable() is stricter than contactAddress' hasDestination", async () => {
  // A delivery stop can be placed from a town name alone; a tax jurisdiction cannot.
  assertEquals(taxable({ street: null, city: "Macon", state: null, zip: null }), false);
  assertEquals(taxable({ street: null, city: null, state: "GA", zip: "31201" }), true);
  assertEquals(isConfigured(), true); // env set at the top of this file
});

// ── The tax figure ───────────────────────────────────────────────────────────────────────

Deno.test("taxOn rounds to cents once — the mock-up figures", () => {
  assertEquals(taxOn(12450, 0.0725), 902.63);   // 902.625 rounds up once, here and nowhere else
  assertEquals(taxOn(11950, 0.0725), 866.38);   // 866.375
});

Deno.test("taxOn is 0 for a zero base or a zero rate, never NaN", () => {
  for (const [base, rate] of [[0, 0.07], [12450, 0], [-5, 0.07], [NaN, 0.07], [12450, NaN]]) {
    assertEquals(taxOn(base as number, rate as number), 0, `${base} @ ${rate}`);
  }
});
