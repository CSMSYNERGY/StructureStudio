// Deliberately dependency-free (no jsr:/npm: imports) so this suite still runs on a machine
// with no registry access — the same rule the other _shared tests follow.
//
// The property under test is the one that makes this module different from its neighbours:
// it NEVER degrades to no tax. Every failure lands on the tenant's own configured rate and
// says why, because a quote issued untaxed is a quote signed at the wrong number.
//
// Credentials are set here, before the import, so every case runs CONFIGURED — the live
// situation since 2026-09-16. salesTax.ts reads env at call time, so the few cases about an
// unconfigured deployment take the credentials away inside `withoutCredentials` and put them
// back. No case ever reaches the network: every fetch below is a stub, and the base URL is a
// reserved .test host, so a stub that failed to install could not bill anyone either.
Deno.env.set("AVALARA_ACCOUNT_ID", "test-account");
Deno.env.set("AVALARA_LICENSE_KEY", "test-key");
Deno.env.set("AVALARA_API_BASE", "https://avatax.test");

import type { AvalaraResult, ResolvedRate } from "./salesTax.ts";
const { resolveRate, taxOn, taxable, isConfigured, stateCode, pingAvalara, AVALARA_CLIENT_HEADER } =
  await import("./salesTax.ts");

function assertEquals(actual: unknown, expected: unknown, msg?: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg ?? "assertEquals"}\n  actual:   ${a}\n  expected: ${e}`);
}

const ADDR = { street: "100 Example Rd", city: "Macon", state: "GA", zip: "31201" };
const FALLBACK = 0.06;

/** Swap globalThis.fetch for one case, always restoring it. */
async function withFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response>,
  run: () => Promise<void>,
) {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => handler(String(input), init)) as typeof fetch;
  try { await run(); } finally { globalThis.fetch = original; }
}

/** Take the credentials away for one case, always putting them back. */
async function withoutCredentials(run: () => Promise<void>) {
  const id = Deno.env.get("AVALARA_ACCOUNT_ID"), key = Deno.env.get("AVALARA_LICENSE_KEY");
  Deno.env.delete("AVALARA_ACCOUNT_ID");
  Deno.env.delete("AVALARA_LICENSE_KEY");
  try { await run(); } finally {
    if (id) Deno.env.set("AVALARA_ACCOUNT_ID", id);
    if (key) Deno.env.set("AVALARA_LICENSE_KEY", key);
  }
}

const ok = (body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
const status = (code: number, body: unknown = "") =>
  Promise.resolve(new Response(typeof body === "string" ? body : JSON.stringify(body), { status: code }));
const timeout = () => Promise.reject(new DOMException("timed out", "TimeoutError"));
const dropped = () => Promise.reject(new TypeError("error sending request: connection reset"));

/** One opted-in lookup against a stub that answers request n (1-based). Collects every
 *  onResult call, so a case can prove it fired exactly once. */
async function lookup(respond: (n: number) => Promise<Response>) {
  let calls = 0;
  const results: AvalaraResult[] = [];
  let r: ResolvedRate | null = null;
  await withFetch(
    () => respond(++calls),
    async () => {
      r = await resolveRate(ADDR, FALLBACK, { allowLookup: true, onResult: (x) => { results.push(x); } });
    },
  );
  return { r: r! as ResolvedRate, calls, results };
}

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
      const r = await resolveRate(ADDR, FALLBACK, { allowLookup: true });
      assertEquals([r.rate, r.jurisdiction, r.source, r.reason], [0.0725, "BIBB, GA", "avalara", null]);
    },
  );
});

Deno.test("the request carries the delivery address, not the business address", async () => {
  let seen = "";
  await withFetch(
    (url) => { seen = url; return ok({ totalRate: 0.07, rates: [] }); },
    async () => { await resolveRate(ADDR, FALLBACK, { allowLookup: true }); },
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
    async () => assertEquals((await resolveRate(ADDR, FALLBACK, { allowLookup: true })).jurisdiction, "MACON, GA"),
  );
  await withFetch(
    () => ok({ totalRate: 0.04, rates: [] }),
    async () => assertEquals((await resolveRate(ADDR, FALLBACK, { allowLookup: true })).jurisdiction, "GA"),
  );
});

// ── Every failure lands on the fallback, and says why ────────────────────────────────────

Deno.test("a timeout falls back to the tenant's own rate", async () => {
  await withFetch(
    timeout,
    async () => {
      const r = await resolveRate(ADDR, FALLBACK, { allowLookup: true });
      assertEquals([r.rate, r.source, r.reason], [FALLBACK, "fallback", "avalara lookup failed"]);
    },
  );
});

Deno.test("a 4xx falls back WITHOUT retrying — bad credentials do not improve on a second ask", async () => {
  let calls = 0;
  await withFetch(
    () => { calls++; return Promise.resolve(new Response("nope", { status: 401 })); },
    async () => assertEquals((await resolveRate(ADDR, FALLBACK, { allowLookup: true })).source, "fallback"),
  );
  assertEquals(calls, 1, "a 401 must not be retried");
});

Deno.test("a 5xx IS retried once, and a second failure falls back", async () => {
  let calls = 0;
  await withFetch(
    () => { calls++; return Promise.resolve(new Response("boom", { status: 503 })); },
    async () => assertEquals((await resolveRate(ADDR, FALLBACK, { allowLookup: true })).source, "fallback"),
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
      const r = await resolveRate(ADDR, FALLBACK, { allowLookup: true });
      assertEquals([r.rate, r.source], [0.0725, "avalara"]);
    },
  );
});

Deno.test("a malformed body falls back rather than charging a garbage rate", async () => {
  for (const body of [{}, { totalRate: null }, { totalRate: "lots" }, { totalRate: -1 }]) {
    await withFetch(() => ok(body), async () => {
      assertEquals((await resolveRate(ADDR, FALLBACK, { allowLookup: true })).source, "fallback", JSON.stringify(body));
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
      const r = await resolveRate(ADDR, FALLBACK, { allowLookup: true });
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
        const r = await resolveRate(addr, FALLBACK, { allowLookup: true });
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

// ── The region code Avalara actually wants ───────────────────────────────────────────────
// The designer's state field is a full-name dropdown, so real contacts carry "Missouri", not
// "MO". Avalara's `region` wants the code. This was found against live contact rows on
// 2026-08-29, BEFORE Avalara was switched on — the failure mode is the nasty kind: the lookup
// quietly answers wrong or not at all, the fallback rate covers it, and everything looks fine.

Deno.test("a full state name becomes the code Avalara expects", () => {
  assertEquals(stateCode("Missouri"), "MO");
  assertEquals(stateCode("new york"), "NY");
  assertEquals(stateCode("  Tennessee  "), "TN");
  assertEquals(stateCode("District of Columbia"), "DC");
});

Deno.test("an already-correct code passes straight through", () => {
  assertEquals(stateCode("MO"), "MO");
  assertEquals(stateCode("mo"), "MO");
});

Deno.test("an unmappable state is empty, and that makes the address untaxable", () => {
  // Better to fall back on the tenant's own rate than to ask Avalara about a place it cannot
  // parse and bill the customer whatever comes back.
  assertEquals(stateCode("Freedonia"), "");
  assertEquals(stateCode(""), "");
  assertEquals(stateCode(null), "");
  assertEquals(taxable({ street: null, city: null, state: "Freedonia", zip: "63090" }), false);
  assertEquals(taxable({ street: null, city: null, state: "Missouri", zip: "63090" }), true);
});

Deno.test("the request carries the CODE, not the name — the whole point", async () => {
  let seen = "";
  await withFetch(
    (url) => { seen = url; return ok({ totalRate: 0.0725, rates: [] }); },
    async () => { await resolveRate({ street: null, city: "Washington", state: "Missouri", zip: "63090" }, FALLBACK, { allowLookup: true }); },
  );
  assertEquals(new URL(seen).searchParams.get("region"), "MO");
});

// ── Credentials present is NOT permission to spend (2026-09-16) ─────────────────────────────

Deno.test("with credentials set, a caller that does not opt in makes ZERO calls", async () => {
  // Every case in this file runs with credentials in env (set at the top), so this is the
  // exact live situation the day the real key went in: configured, and still no lookup
  // unless the caller asks. A lookup is a billed call with no sandbox behind it.
  assertEquals(isConfigured(), true);
  let calls = 0;
  await withFetch(
    () => { calls++; return ok({ totalRate: 0.0725, rates: [] }); },
    async () => {
      for (const opts of [undefined, {}, { allowLookup: false }]) {
        const r = await resolveRate(ADDR, FALLBACK, opts);
        assertEquals([r.rate, r.source, r.reason], [FALLBACK, "fallback", "not requested"], JSON.stringify(opts));
      }
    },
  );
  assertEquals(calls, 0, "no opt-in must mean no network call");
});

Deno.test("the opt-out gate fires no onResult either — nothing was asked, nothing is recorded", async () => {
  let calls = 0, results = 0;
  await withFetch(
    () => { calls++; return ok({ totalRate: 0.0725, rates: [] }); },
    async () => {
      for (const allowLookup of [undefined, false]) {
        await resolveRate(ADDR, FALLBACK, { allowLookup, onResult: () => { results++; } });
      }
    },
  );
  assertEquals([calls, results], [0, 0]);
});

Deno.test("with the credentials missing, an opted-in lookup makes ZERO calls and says why", async () => {
  let calls = 0, results = 0;
  await withoutCredentials(async () => {
    assertEquals(isConfigured(), false);
    await withFetch(
      () => { calls++; return ok({ totalRate: 0.0725, rates: [] }); },
      async () => {
        const r = await resolveRate(ADDR, FALLBACK, { allowLookup: true, onResult: () => { results++; } });
        assertEquals([r.rate, r.source, r.reason, r.failure ?? null], [FALLBACK, "fallback", "avalara not configured", null]);
      },
    );
  });
  assertEquals([calls, results], [0, 0], "no credentials must mean no request and no ledger outcome");
  assertEquals(isConfigured(), true, "the credentials were put back");
});

// ── What every request carries ─────────────────────────────────────────────────────────────

Deno.test("every request carries Basic auth, JSON, and the X-Avalara-Client identifier", async () => {
  const seen: Headers[] = [];
  await withFetch(
    (_url, init) => {
      seen.push(new Headers(init?.headers));
      return ok({ totalRate: 0.0725, rates: [], authenticated: true });
    },
    async () => {
      await resolveRate(ADDR, FALLBACK, { allowLookup: true });
      await pingAvalara();
    },
  );
  assertEquals(seen.length, 2, "one lookup and one ping");
  for (const h of seen) {
    assertEquals(h.get("X-Avalara-Client"), "StructureStudio; 1.0; CSM Synergy; 1.0;");
    assertEquals(h.get("Authorization"), `Basic ${btoa("test-account:test-key")}`);
    assertEquals(h.get("Accept"), "application/json");
  }
  assertEquals(AVALARA_CLIENT_HEADER, "StructureStudio; 1.0; CSM Synergy; 1.0;");
});

// ── The outcome the ledger records (onResult) ──────────────────────────────────────────────

Deno.test("a successful lookup reports ONE outcome: ok, the rate, the status and one attempt", async () => {
  const { r, calls, results } = await lookup(() =>
    ok({ totalRate: 0.0725, rates: [{ rate: 0.03, name: "BIBB", type: "County" }] })
  );
  assertEquals([r.rate, r.source, r.failure ?? null], [0.0725, "avalara", null]);
  assertEquals(calls, 1);
  assertEquals(results.length, 1, "onResult fires exactly once per lookup");
  const x = results[0];
  assertEquals([x.ok, x.rate, x.jurisdiction, x.httpStatus, x.attempts, x.failure], [true, 0.0725, "BIBB, GA", 200, 1, null]);
});

Deno.test("every failure kind is told apart, with the right retry count and one onResult", async () => {
  // [label, stub for request n, expected failure, requests made, httpStatus recorded]
  const cases: [string, (n: number) => Promise<Response>, string, number, number | null][] = [
    ["401, plain body", () => status(401, "nope"), "credentials_rejected", 1, 401],
    ["403, empty JSON", () => status(403, {}), "credentials_rejected", 1, 403],
    ["401 AuthenticationException", () => status(401, { error: { code: "AuthenticationException" } }), "credentials_rejected", 1, 401],
    ["401 SubscriptionRequired", () => status(401, { error: { code: "SubscriptionRequired" } }), "subscription", 1, 401],
    ["403 AuthorizationException", () => status(403, { error: { code: "AuthorizationException" } }), "subscription", 1, 403],
    ["403 PermissionRequired in details",
      () => status(403, { error: { code: "Other", details: [{ code: "PermissionRequired" }] } }), "subscription", 1, 403],
    ["400", () => status(400, { error: { code: "InvalidAddress" } }), "bad_address", 1, 400],
    ["404", () => status(404), "bad_address", 1, 404],
    ["422", () => status(422), "bad_address", 1, 422],
    ["429 twice", () => status(429), "rate_limited", 2, 429],
    ["503 twice", () => status(503), "network", 2, 503],
    ["500 then 400", (n) => (n === 1 ? status(500) : status(400)), "bad_address", 2, 400],
    ["timeout twice", timeout, "timeout", 2, null],
    ["dropped connection twice", dropped, "network", 2, null],
    ["200, not JSON", () => Promise.resolve(new Response("<html>oops</html>", { status: 200 })), "malformed", 1, 200],
    ["200, percent-shaped rate", () => ok({ totalRate: 7.25, rates: [] }), "malformed", 1, 200],
    ["200, no rate", () => ok({ rates: [] }), "malformed", 1, 200],
  ];
  for (const [label, respond, failure, requests, httpStatus] of cases) {
    const { r, calls, results } = await lookup(respond);
    assertEquals([r.rate, r.source, r.reason, r.failure], [FALLBACK, "fallback", "avalara lookup failed", failure], label);
    assertEquals(calls, requests, `${label}: requests made`);
    assertEquals(results.length, 1, `${label}: onResult must fire exactly once`);
    const x = results[0];
    assertEquals(
      [x.ok, x.rate, x.jurisdiction, x.failure, x.attempts, x.httpStatus],
      [false, null, null, failure, requests, httpStatus],
      label,
    );
  }
});

Deno.test("a 429 is retried once, and a success on the retry is an ok with two attempts", async () => {
  const { r, calls, results } = await lookup((n) => (n === 1 ? status(429) : ok({ totalRate: 0.0725, rates: [] })));
  assertEquals([r.rate, r.source], [0.0725, "avalara"]);
  assertEquals(calls, 2);
  assertEquals([results.length, results[0].ok, results[0].attempts, results[0].httpStatus], [1, true, 2, 200]);
});

Deno.test("a 5xx recovered on the retry records both attempts on its one outcome", async () => {
  const { calls, results } = await lookup((n) => (n === 1 ? status(502) : ok({ totalRate: 0.07, rates: [] })));
  assertEquals(calls, 2);
  assertEquals([results.length, results[0].ok, results[0].attempts], [1, true, 2]);
});

Deno.test("an unusable address fires no onResult — no request, no ledger outcome", async () => {
  let calls = 0, results = 0;
  await withFetch(
    () => { calls++; return ok({ totalRate: 0.07, rates: [] }); },
    async () => {
      const r = await resolveRate({ street: null, city: "Macon", state: "Freedonia", zip: "31201" }, FALLBACK,
        { allowLookup: true, onResult: () => { results++; } });
      assertEquals(r.reason, "no state/postcode on the delivery address");
    },
  );
  assertEquals([calls, results], [0, 0]);
});

Deno.test("a ledger callback that throws never changes the rate", async () => {
  const throwers: ((x: AvalaraResult) => void | Promise<void>)[] = [
    () => { throw new Error("ledger down"); },
    () => Promise.reject(new Error("ledger down")),
  ];
  for (const onResult of throwers) {
    await withFetch(
      () => ok({ totalRate: 0.0725, rates: [] }),
      async () => {
        const r = await resolveRate(ADDR, FALLBACK, { allowLookup: true, onResult });
        assertEquals([r.rate, r.source], [0.0725, "avalara"]);
      },
    );
  }
});

Deno.test("an async onResult is awaited before the rate is handed back", async () => {
  const order: string[] = [];
  await withFetch(
    () => ok({ totalRate: 0.0725, rates: [] }),
    async () => {
      await resolveRate(ADDR, FALLBACK, {
        allowLookup: true,
        onResult: async () => { await new Promise((r) => setTimeout(r, 5)); order.push("ledger"); },
      });
      order.push("returned");
    },
  );
  assertEquals(order, ["ledger", "returned"]);
});

// ── The operator's credential check (pingAvalara) ──────────────────────────────────────────

Deno.test("ping: accepted credentials, and NOTHING about the account comes back", async () => {
  let seen = "";
  let p: unknown = null;
  await withFetch(
    (url) => {
      seen = url;
      return ok({
        version: "26.9.0",
        authenticated: true,
        authenticationType: "AccountIdLicenseKey",
        authenticatedUserName: "someone@example.test",
        authenticatedUserId: 123456,
        authenticatedAccountId: 987654321,
        crmid: "0010000000ABCDE",
      });
    },
    async () => { p = await pingAvalara(); },
  );
  assertEquals(new URL(seen).pathname, "/api/v2/utilities/ping");
  assertEquals(p, { configured: true, authenticated: true, authenticationType: "AccountIdLicenseKey", httpStatus: 200 });
  const wire = JSON.stringify(p);
  for (const leak of ["someone@example.test", "123456", "987654321", "0010000000ABCDE", "26.9.0"]) {
    assertEquals(wire.includes(leak), false, `ping leaked ${leak}`);
  }
  assertEquals(Object.keys(p as object).sort(), ["authenticated", "authenticationType", "configured", "httpStatus"]);
});

Deno.test("ping: rejected credentials are authenticated FALSE, not an error", async () => {
  // Avalara documents ping as never erroring: a wrong key is a 200 saying so.
  await withFetch(
    () => ok({ authenticated: false, authenticationType: "None" }),
    async () => assertEquals(await pingAvalara(),
      { configured: true, authenticated: false, authenticationType: "None", httpStatus: 200 }),
  );
  await withFetch(
    () => status(401, { error: { code: "AuthenticationException" } }),
    async () => assertEquals(await pingAvalara(),
      { configured: true, authenticated: false, authenticationType: null, httpStatus: 401 }),
  );
});

Deno.test("ping: a non-2xx never reads as authenticated, whatever its body says", async () => {
  await withFetch(
    () => status(500, { authenticated: true, authenticationType: "AccountIdLicenseKey" }),
    async () => assertEquals((await pingAvalara()).authenticated, false),
  );
});

Deno.test("ping: an authenticationType that is not a plain word is dropped", async () => {
  for (const authenticationType of ["<img src=x>", "Account Id", "x".repeat(41), 7, null]) {
    await withFetch(
      () => ok({ authenticated: true, authenticationType }),
      async () => assertEquals((await pingAvalara()).authenticationType, null, JSON.stringify(authenticationType)),
    );
  }
});

Deno.test("ping: timeouts, dropped connections and junk bodies never throw", async () => {
  for (const respond of [timeout, dropped]) {
    await withFetch(respond, async () =>
      assertEquals(await pingAvalara(), { configured: true, authenticated: false, authenticationType: null, httpStatus: null }));
  }
  await withFetch(
    () => Promise.resolve(new Response("not json", { status: 200 })),
    async () => assertEquals(await pingAvalara(),
      { configured: true, authenticated: false, authenticationType: null, httpStatus: 200 }),
  );
});

Deno.test("ping: unconfigured makes no request and says so", async () => {
  let calls = 0;
  await withoutCredentials(async () => {
    await withFetch(
      () => { calls++; return ok({ authenticated: true }); },
      async () => assertEquals(await pingAvalara(),
        { configured: false, authenticated: false, authenticationType: null, httpStatus: null }),
    );
  });
  assertEquals(calls, 0);
});
