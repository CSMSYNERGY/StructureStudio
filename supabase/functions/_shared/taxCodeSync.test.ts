// Unit tests for _shared/taxCodeSync.ts — the operator's Avalara tax code sync (migration 246,
// 2026-09-17).
//
// Deliberately dependency-free (no jsr:/npm: imports) so this suite still runs on a machine
// with no registry access — the same rule the other _shared tests follow.
//
// No case reaches the network: every fetch is a stub and the base URL is a reserved .test host,
// so a stub that failed to install could not call Avalara either. The database is a fake client
// that records every call.
//
// The failures that matter are the ones that damage the catalog every builder searches: a
// partial list treated as complete deactivates every code it did not reach; an empty answer
// treated as complete deactivates all of them; refused credentials that still write leave a
// half-updated list nobody asked for. And a response that echoes credentials leaks them to the
// operator console.
Deno.env.set("AVALARA_ACCOUNT_ID", "test-account");
Deno.env.set("AVALARA_LICENSE_KEY", "test-key");
Deno.env.set("AVALARA_API_BASE", "https://avatax.test");

const {
  fetchTaxCodes, partialSyncText, SYNC_MAX_PAGES, SYNC_ORDER_BY, SYNC_PAGE_SIZE, SYNC_PAGE_TIMEOUT_MS, SYNC_UPSERT_CHUNK,
  syncFailureText, syncTaxCodes,
} = await import("./taxCodeSync.ts");
const { AVALARA_CLIENT_HEADER } = await import("./salesTax.ts");

const assertEquals = (a: unknown, b: unknown, msg?: string) => {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(msg ? `${msg}: ${sa} !== ${sb}` : `${sa} !== ${sb}`);
};
const assert = (cond: unknown, msg = "assertion failed") => {
  if (!cond) throw new Error(msg);
};

const NOW = new Date("2026-09-17T12:00:00.000Z");

/** Swap globalThis.fetch for one case, always restoring it. Records every request. */
async function withFetch(respond: (n: number, url: string) => Promise<Response>, run: () => Promise<void>) {
  const original = globalThis.fetch;
  const requests: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return respond(requests.length, String(input));
  }) as typeof fetch;
  try { await run(); } finally { globalThis.fetch = original; }
  return requests;
}

async function withoutCredentials(run: () => Promise<void>) {
  const id = Deno.env.get("AVALARA_ACCOUNT_ID"), key = Deno.env.get("AVALARA_LICENSE_KEY");
  Deno.env.delete("AVALARA_ACCOUNT_ID");
  Deno.env.delete("AVALARA_LICENSE_KEY");
  try { await run(); } finally {
    if (id) Deno.env.set("AVALARA_ACCOUNT_ID", id);
    if (key) Deno.env.set("AVALARA_LICENSE_KEY", key);
  }
}

const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
const status = (code: number, body: unknown = "") =>
  Promise.resolve(new Response(typeof body === "string" ? body : JSON.stringify(body), { status: code }));

/** `count` TaxCodeModel entries starting at `from`, shaped like Avalara's, company ids included. */
const entries = (from: number, count: number, extra: Record<string, unknown> = {}) =>
  Array.from({ length: count }, (_, i) => ({
    id: 900000 + from + i, companyId: 4242, createdUserId: 77, taxCode: `P${String(from + i).padStart(7, "0")}`,
    taxCodeTypeId: "P", description: `Code ${from + i}`, parentTaxCode: null, isActive: true, ...extra,
  }));
const page = (from: number, count: number, total: number | null) =>
  ok({ ...(total == null ? {} : { "@recordsetCount": total }), value: entries(from, count) });

/** A service-role client stub. Records every builder call; upserts and updates answer from the
 *  options (an upsert error on the Nth upsert, the update's count or error). */
function makeAdmin(opts: { upsertErrorOn?: number; updateCount?: number; updateError?: unknown; throwOnFrom?: boolean } = {}) {
  const ops: unknown[][] = [];
  let upserts = 0;
  const admin = {
    from(table: string) {
      if (opts.throwOnFrom) throw new Error("connection refused");
      ops.push(["from", table]);
      let kind = "";
      // deno-lint-ignore no-explicit-any
      const chain: any = {};
      chain.upsert = (rows: unknown, o: unknown) => { kind = "upsert"; upserts++; ops.push(["upsert", rows, o]); return chain; };
      chain.update = (patch: unknown, o: unknown) => { kind = "update"; ops.push(["update", patch, o]); return chain; };
      for (const m of ["eq", "lt"]) chain[m] = (...args: unknown[]) => { ops.push([m, ...args]); return chain; };
      chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
        const answer = kind === "upsert"
          ? { error: opts.upsertErrorOn === upserts ? { message: "value too long" } : null }
          : { error: opts.updateError ?? null, count: opts.updateError ? null : (opts.updateCount ?? 0) };
        return Promise.resolve(answer).then(resolve, reject);
      };
      return chain;
    },
  };
  return { admin, ops };
}
const named = (ops: unknown[][], name: string) => ops.filter((o) => o[0] === name);

// ── Paging ──────────────────────────────────────────────────────────────────────────────────

Deno.test("one page that reaches @recordsetCount is a complete sync: one request, with the auth and client headers", async () => {
  let got: Awaited<ReturnType<typeof fetchTaxCodes>> | null = null;
  const requests = await withFetch(() => page(0, 3, 3), async () => { got = await fetchTaxCodes(); });
  assertEquals(requests.map((r) => r.url), [
    `https://avatax.test/api/v2/definitions/taxcodes?$top=${SYNC_PAGE_SIZE}&$skip=0&$orderBy=taxCode%20ASC`,
  ]);
  const headers = requests[0].init?.headers as Record<string, string>;
  assertEquals(headers.Authorization, `Basic ${btoa("test-account:test-key")}`);
  assertEquals(headers["X-Avalara-Client"], AVALARA_CLIENT_HEADER);
  assertEquals(headers.Accept, "application/json");
  assert(requests[0].init?.signal instanceof AbortSignal, "every page carries a timeout signal");
  assertEquals(SYNC_PAGE_TIMEOUT_MS, 10_000);
  const r = got! as Extract<Awaited<ReturnType<typeof fetchTaxCodes>>, { ok: true }>;
  assertEquals([r.ok, r.complete, r.stoppedBy, r.fetched, r.skipped, r.pages, r.codes.length], [true, true, null, 3, 0, 1, 3]);
});

Deno.test("pages advance $skip by what was received and stop at @recordsetCount", async () => {
  let got: Awaited<ReturnType<typeof fetchTaxCodes>> | null = null;
  const requests = await withFetch(
    (n) => n === 1 ? page(0, 1000, 2400) : n === 2 ? page(1000, 1000, 2400) : page(2000, 400, 2400),
    async () => { got = await fetchTaxCodes(); },
  );
  assertEquals(requests.map((r) => new URL(r.url).searchParams.get("$skip")), ["0", "1000", "2000"]);
  assertEquals(requests.map((r) => new URL(r.url).searchParams.get("$orderBy")), [SYNC_ORDER_BY, SYNC_ORDER_BY, SYNC_ORDER_BY],
    "every page walks the same fixed order — $skip over an unordered list can repeat one code and never show another");
  assertEquals(SYNC_ORDER_BY, "taxCode ASC");
  const r = got! as Extract<Awaited<ReturnType<typeof fetchTaxCodes>>, { ok: true }>;
  assertEquals([r.complete, r.fetched, r.codes.length, r.pages], [true, 2400, 2400, 3]);
});

Deno.test("with no @recordsetCount, a short page is not the end — an empty page is", async () => {
  let got: Awaited<ReturnType<typeof fetchTaxCodes>> | null = null;
  const requests = await withFetch(
    (n) => n === 1 ? page(0, 600, null) : n === 2 ? page(600, 250, null) : page(850, 0, null),
    async () => { got = await fetchTaxCodes(); },
  );
  assertEquals(requests.map((r) => new URL(r.url).searchParams.get("$skip")), ["0", "600", "850"]);
  const r = got! as Extract<Awaited<ReturnType<typeof fetchTaxCodes>>, { ok: true }>;
  assertEquals([r.complete, r.fetched, r.pages], [true, 850, 3]);
});

Deno.test("the page cap stops a list that never ends, and says it is partial", async () => {
  let got: Awaited<ReturnType<typeof fetchTaxCodes>> | null = null;
  const requests = await withFetch((n) => page((n - 1) * 1000, 1000, 50_000), async () => { got = await fetchTaxCodes(); });
  assertEquals(requests.length, SYNC_MAX_PAGES);
  const r = got! as Extract<Awaited<ReturnType<typeof fetchTaxCodes>>, { ok: true }>;
  assertEquals([r.ok, r.complete, r.stoppedBy, r.pages], [true, false, "page_cap", SYNC_MAX_PAGES]);
});

Deno.test("a repeated code keeps its last copy, and an unusable code is counted, not stored", async () => {
  let got: Awaited<ReturnType<typeof fetchTaxCodes>> | null = null;
  await withFetch(
    (n) => n === 1
      ? ok({ "@recordsetCount": 3, value: [{ taxCode: "NT", description: "old" }, { taxCode: "bad code!", description: "x" }] })
      : ok({ "@recordsetCount": 3, value: [{ taxCode: "NT", description: "new" }, { taxCode: "FR010000", description: "Delivery" }] }),
    async () => { got = await fetchTaxCodes(); },
  );
  const r = got! as Extract<Awaited<ReturnType<typeof fetchTaxCodes>>, { ok: true }>;
  assertEquals([r.complete, r.fetched, r.skipped], [true, 4, 1], "three distinct entries account for a count of three");
  assertEquals(r.codes.map((c) => [c.code, c.description]), [["NT", "new"], ["FR010000", "Delivery"]]);
});

Deno.test("pages that repeat a code and miss another reach @recordsetCount but are NOT complete", async () => {
  // Codes 0–999, then 999–1998: code 999 twice, code 1999 never. 2,000 entries for a count of
  // 2,000 — the raw count says complete, the distinct count (1,999) says something was missed.
  let got: Awaited<ReturnType<typeof fetchTaxCodes>> | null = null;
  const requests = await withFetch(
    (n) => n === 1 ? page(0, 1000, 2000) : page(999, 1000, 2000),
    async () => { got = await fetchTaxCodes(); },
  );
  assertEquals(requests.length, 2);
  const r = got! as Extract<Awaited<ReturnType<typeof fetchTaxCodes>>, { ok: true }>;
  assertEquals([r.ok, r.complete, r.stoppedBy, r.fetched, r.codes.length], [true, false, "inconsistent_pages", 2000, 1999]);
  assert(!r.codes.some((c) => c.code === "P0001999"), "the missed code cannot have been read");
});

Deno.test("an empty page ends the list, but once a count was sent, a repeat or a short list is still partial", async () => {
  let got: Awaited<ReturnType<typeof fetchTaxCodes>> | null = null;
  await withFetch(
    (n) => n === 1 ? page(0, 1000, 2001) : n === 2 ? page(999, 1000, 2001) : ok({ value: [] }),
    async () => { got = await fetchTaxCodes(); },
  );
  const r = got! as Extract<Awaited<ReturnType<typeof fetchTaxCodes>>, { ok: true }>;
  assertEquals([r.complete, r.stoppedBy, r.pages, r.codes.length], [false, "inconsistent_pages", 3, 1999]);

  // Pages that run out before the count does, with no repeat, are just as unfinished.
  let short: Awaited<ReturnType<typeof fetchTaxCodes>> | null = null;
  await withFetch((n) => n === 1 ? page(0, 600, 700) : ok({ "@recordsetCount": 700, value: [] }), async () => { short = await fetchTaxCodes(); });
  const s = short! as Extract<Awaited<ReturnType<typeof fetchTaxCodes>>, { ok: true }>;
  assertEquals([s.complete, s.stoppedBy, s.codes.length], [false, "inconsistent_pages", 600]);
});

Deno.test("unusable entries count once each toward @recordsetCount, so they cannot hide a missed code either", async () => {
  let got: Awaited<ReturnType<typeof fetchTaxCodes>> | null = null;
  await withFetch(
    (n) => n === 1
      ? ok({ "@recordsetCount": 3, value: [{ taxCode: "bad code!" }, { taxCode: "NT", description: "Non-taxable product" }] })
      : ok({ "@recordsetCount": 3, value: [{ taxCode: "bad code!" }] }),
    async () => { got = await fetchTaxCodes(); },
  );
  const r = got! as Extract<Awaited<ReturnType<typeof fetchTaxCodes>>, { ok: true }>;
  assertEquals([r.complete, r.stoppedBy, r.skipped], [false, "inconsistent_pages", 2]);
});

// ── The write rules ─────────────────────────────────────────────────────────────────────────

Deno.test("a complete sync upserts in chunks of 500 as source avalara, then deactivates what it did not see", async () => {
  const { admin, ops } = makeAdmin({ updateCount: 7 });
  let out: Awaited<ReturnType<typeof syncTaxCodes>> | null = null;
  await withFetch(
    (n) => n === 1 ? page(0, 1000, 1200) : page(1000, 200, 1200),
    async () => { out = await syncTaxCodes(admin, NOW); },
  );
  assertEquals(out, {
    ok: true, fetched: 1200, upserted: 1200, skipped: 0, deactivated: 7, pages: 2, complete: true, syncedAt: NOW.toISOString(),
  });
  const upserts = named(ops, "upsert");
  assertEquals(upserts.map((u) => (u[1] as unknown[]).length), [SYNC_UPSERT_CHUNK, SYNC_UPSERT_CHUNK, 200]);
  assertEquals(upserts[0][2], { onConflict: "code" });
  assertEquals((upserts[0][1] as unknown[])[0], {
    code: "P0000000", description: "Code 0", type_id: "P", parent_code: null, is_active: true, north_america: true,
    source: "avalara", synced_at: NOW.toISOString(),
  }, "the row carries the catalog columns only — no Avalara company or user ids");
  assertEquals(named(ops, "update"), [["update", { is_active: false }, { count: "exact" }]]);
  assertEquals([...named(ops, "eq"), ...named(ops, "lt")], [
    ["eq", "source", "avalara"], ["eq", "is_active", true], ["lt", "synced_at", NOW.toISOString()],
  ], "only synced rows this sync did not write are deactivated; seed rows are never touched");
  assert(new Set(named(ops, "from").map((f) => f[1])).size === 1 && named(ops, "from")[0][1] === "avalara_tax_codes");
});

Deno.test("a sync stopped by the page cap upserts what it read and deactivates NOTHING", async () => {
  const { admin, ops } = makeAdmin({ updateCount: 999 });
  let out: Awaited<ReturnType<typeof syncTaxCodes>> | null = null;
  await withFetch((n) => page((n - 1) * 1000, 1000, 50_000), async () => { out = await syncTaxCodes(admin, NOW); });
  assert(out!.ok, "a partial sync still saves what it read");
  const r = out! as Extract<Awaited<ReturnType<typeof syncTaxCodes>>, { ok: true }>;
  assertEquals([r.complete, r.upserted, r.deactivated], [false, 10_000, 0]);
  assertEquals(named(ops, "update"), [], "no deactivation from a partial list");
  assertEquals(r.stoppedBy, "page_cap");
  assertEquals(r.warning, partialSyncText("page_cap", null, 10_000));
  assert(/10000 codes were saved and none were marked inactive/.test(r.warning!), `the warning says what was kept: ${r.warning}`);
  assert(/page limit/.test(r.warning!) && !/run the sync again/.test(r.warning!), "pressing again cannot finish a capped list, and the warning must not say it will");
});

Deno.test("pages that repeat one code and miss another save what they read, deactivate NOTHING, and say so", async () => {
  // The finding this guards: a sync that looks complete by raw count would mark the missed code
  // inactive — out of every builder's picker, and every save that uses it refused.
  const { admin, ops } = makeAdmin({ updateCount: 1 });
  let out: Awaited<ReturnType<typeof syncTaxCodes>> | null = null;
  await withFetch(
    (n) => n === 1 ? page(0, 1000, 2000) : page(999, 1000, 2000),
    async () => { out = await syncTaxCodes(admin, NOW); },
  );
  const r = out! as Extract<Awaited<ReturnType<typeof syncTaxCodes>>, { ok: true }>;
  assertEquals([r.ok, r.complete, r.fetched, r.upserted, r.deactivated, r.stoppedBy], [true, false, 2000, 1999, 0, "inconsistent_pages"]);
  assertEquals(named(ops, "update"), [], "the missed code must not be deactivated");
  assert(/fewer different codes than the total/.test(r.warning!) && /1999 codes were saved and none were marked inactive — run the sync again/.test(r.warning!),
    `the operator is told it stopped short: ${r.warning}`);
});

Deno.test("a failure after some pages keeps what was read, and deactivates nothing", async () => {
  const { admin, ops } = makeAdmin();
  let out: Awaited<ReturnType<typeof syncTaxCodes>> | null = null;
  const requests = await withFetch(
    (n) => n === 1 ? page(0, 1000, 3000) : status(503),
    async () => { out = await syncTaxCodes(admin, NOW); },
  );
  assertEquals(requests.length, 2, "no retry: the operator can press again");
  const r = out! as Extract<Awaited<ReturnType<typeof syncTaxCodes>>, { ok: true }>;
  assertEquals([r.ok, r.complete, r.upserted, r.deactivated], [true, false, 1000, 0]);
  assertEquals(named(ops, "update"), []);
  // An ok answer alone reads as a finished sync. The partial one names what stopped it — with the
  // failed page's status — and never claims "Nothing was changed", because 1,000 codes were.
  assertEquals(r.stoppedBy, "network");
  assertEquals(r.warning,
    "Couldn't reach Avalara (HTTP 503). The sync stopped partway: 1000 codes were saved and none were marked inactive — run the sync again.");
});

Deno.test("a later page rate-limited or timing out reports its own cause on the partial answer", async () => {
  for (const [stop, respond, cause] of [
    ["rate_limited", () => status(429), "Avalara is limiting requests right now (HTTP 429)."],
    ["timeout", () => Promise.reject(new DOMException("timed out", "TimeoutError")), "Avalara didn't answer within 10 seconds."],
    ["malformed", () => ok({ nope: true }), "Avalara's answer wasn't the tax code list this sync reads (HTTP 200)."],
  ] as const) {
    const { admin } = makeAdmin();
    let out: Awaited<ReturnType<typeof syncTaxCodes>> | null = null;
    await withFetch((n) => n === 1 ? page(0, 1000, 3000) : (respond as () => Promise<Response>)(), async () => {
      out = await syncTaxCodes(admin, NOW);
    });
    const r = out! as Extract<Awaited<ReturnType<typeof syncTaxCodes>>, { ok: true }>;
    assertEquals([r.ok, r.complete, r.stoppedBy], [true, false, stop], stop);
    assert(r.warning!.startsWith(cause), `${stop}: ${r.warning}`);
    assert(!/Nothing was changed/.test(r.warning!), `${stop}: a partial sync changed something`);
  }
});

Deno.test("a complete sync's answer carries no stoppedBy or warning", async () => {
  const { admin } = makeAdmin();
  let out: Awaited<ReturnType<typeof syncTaxCodes>> | null = null;
  await withFetch(() => page(0, 5, 5), async () => { out = await syncTaxCodes(admin, NOW); });
  assert(out!.ok && !("stoppedBy" in out!) && !("warning" in out!), JSON.stringify(out));
});

Deno.test("the failure sentences are word for word what they were before partial syncs shared them", () => {
  assertEquals([
    syncFailureText("credentials_rejected", 401), syncFailureText("subscription", 403), syncFailureText("rate_limited", 429),
    syncFailureText("timeout", null), syncFailureText("network", 503), syncFailureText("rejected", 400), syncFailureText("malformed", 200),
  ], [
    "Avalara refused the platform's credentials (HTTP 401). Check AVALARA_ACCOUNT_ID and AVALARA_LICENSE_KEY. Nothing was changed.",
    "Avalara accepted the credentials but this account isn't entitled to list tax codes (HTTP 403). Nothing was changed.",
    "Avalara is limiting requests right now (HTTP 429). Nothing was changed — try again in a minute.",
    "Avalara didn't answer within 10 seconds. Nothing was changed — try again.",
    "Couldn't reach Avalara (HTTP 503). Nothing was changed — try again.",
    "Avalara refused the tax code request (HTTP 400). Nothing was changed.",
    "Avalara's answer wasn't the tax code list this sync reads (HTTP 200). Nothing was changed.",
  ]);
});

Deno.test("refused credentials write nothing — on the first page or after earlier ones", async () => {
  for (const [label, respond] of [
    ["first page", () => status(401, { error: { code: "AuthenticationException" } })],
    ["third page", (n: number) => n < 3 ? page((n - 1) * 1000, 1000, 5000) : status(401)],
  ] as const) {
    const { admin, ops } = makeAdmin();
    let out: Awaited<ReturnType<typeof syncTaxCodes>> | null = null;
    await withFetch((n) => (respond as (n: number) => Promise<Response>)(n), async () => { out = await syncTaxCodes(admin, NOW); });
    assertEquals(ops, [], `${label}: no database call at all`);
    const r = out! as Extract<Awaited<ReturnType<typeof syncTaxCodes>>, { ok: false }>;
    assertEquals([r.ok, r.status, r.reason], [false, 502, "credentials_rejected"], label);
    assert(/AVALARA_LICENSE_KEY/.test(r.error) && /Nothing was changed/.test(r.error), `${label}: says what to check`);
  }
});

Deno.test("a 403 naming a missing entitlement is told apart from a wrong key", async () => {
  const { admin, ops } = makeAdmin();
  let out: Awaited<ReturnType<typeof syncTaxCodes>> | null = null;
  await withFetch(
    () => status(403, { error: { code: "PermissionRequired", details: [{ code: "SubscriptionRequired" }] } }),
    async () => { out = await syncTaxCodes(admin, NOW); },
  );
  const r = out! as Extract<Awaited<ReturnType<typeof syncTaxCodes>>, { ok: false }>;
  assertEquals([r.status, r.reason, ops.length], [502, "subscription", 0]);
});

Deno.test("every first-page failure is a 502 with its own reason, one request, and no writes", async () => {
  const cases: [Parameters<typeof syncFailureText>[0], number | null, () => Promise<Response>][] = [
    ["rate_limited", 429, () => status(429)],
    ["network", 500, () => status(500)],
    ["rejected", 400, () => status(400, { error: { code: "InvalidParameter" } })],
    ["timeout", null, () => Promise.reject(new DOMException("timed out", "TimeoutError"))],
    ["network", null, () => Promise.reject(new TypeError("error sending request"))],
    ["malformed", 200, () => Promise.resolve(new Response("<html>", { status: 200 }))],
    ["malformed", 200, () => ok({ "@recordsetCount": 3, items: [] })],
  ];
  for (const [reason, httpStatus, respond] of cases) {
    const { admin, ops } = makeAdmin();
    let out: Awaited<ReturnType<typeof syncTaxCodes>> | null = null;
    const requests = await withFetch(() => respond(), async () => { out = await syncTaxCodes(admin, NOW); });
    const r = out! as Extract<Awaited<ReturnType<typeof syncTaxCodes>>, { ok: false }>;
    assertEquals([r.ok, r.status, r.reason, requests.length, ops.length], [false, 502, reason, 1, 0], reason);
    assertEquals(r.error, syncFailureText(reason, httpStatus), `${reason}: the operator's sentence`);
    assert(/Nothing was changed/.test(r.error), `${reason}: the sentence says nothing changed`);
  }
});

Deno.test("an empty list is refused — it would otherwise deactivate every synced code", async () => {
  for (const body of [{ "@recordsetCount": 0, value: [] }, { value: [] }, { "@recordsetCount": 1, value: [{ taxCode: "not a code" }] }]) {
    const { admin, ops } = makeAdmin({ updateCount: 3000 });
    let out: Awaited<ReturnType<typeof syncTaxCodes>> | null = null;
    await withFetch(() => ok(body), async () => { out = await syncTaxCodes(admin, NOW); });
    const r = out! as Extract<Awaited<ReturnType<typeof syncTaxCodes>>, { ok: false }>;
    assertEquals([r.ok, r.status, r.reason, ops.length], [false, 502, "empty", 0], JSON.stringify(body));
  }
});

Deno.test("not configured: 409, and no request is made", async () => {
  const { admin, ops } = makeAdmin();
  let out: Awaited<ReturnType<typeof syncTaxCodes>> | null = null;
  let requests: unknown[] = [];
  await withoutCredentials(async () => {
    requests = await withFetch(() => page(0, 1, 1), async () => { out = await syncTaxCodes(admin, NOW); });
  });
  const r = out! as Extract<Awaited<ReturnType<typeof syncTaxCodes>>, { ok: false }>;
  assertEquals([r.ok, r.status, r.reason, requests.length, ops.length], [false, 409, "not_configured", 0, 0]);
});

Deno.test("a failed upsert stops the sync before any deactivation and reports what was saved", async () => {
  const { admin, ops } = makeAdmin({ upsertErrorOn: 2, updateCount: 5 });
  let out: Awaited<ReturnType<typeof syncTaxCodes>> | null = null;
  await withFetch(() => page(0, 1200, 1200), async () => { out = await syncTaxCodes(admin, NOW); });
  const r = out! as Extract<Awaited<ReturnType<typeof syncTaxCodes>>, { ok: false }>;
  assertEquals([r.ok, r.status, r.reason, r.upserted], [false, 500, "db", SYNC_UPSERT_CHUNK]);
  assertEquals(named(ops, "upsert").length, 2, "no chunk after the failed one");
  assertEquals(named(ops, "update"), []);
  assert(/none were deactivated/.test(r.error));
});

Deno.test("a failed deactivation is a 500 that still reports the saved count", async () => {
  const { admin } = makeAdmin({ updateError: { message: "timeout" } });
  let out: Awaited<ReturnType<typeof syncTaxCodes>> | null = null;
  await withFetch(() => page(0, 10, 10), async () => { out = await syncTaxCodes(admin, NOW); });
  const r = out! as Extract<Awaited<ReturnType<typeof syncTaxCodes>>, { ok: false }>;
  assertEquals([r.status, r.reason, r.upserted], [500, "db", 10]);
});

Deno.test("a client that throws reads as a database failure, never an exception", async () => {
  const { admin } = makeAdmin({ throwOnFrom: true });
  let out: Awaited<ReturnType<typeof syncTaxCodes>> | null = null;
  await withFetch(() => page(0, 10, 10), async () => { out = await syncTaxCodes(admin, NOW); });
  const r = out! as Extract<Awaited<ReturnType<typeof syncTaxCodes>>, { ok: false }>;
  assertEquals([r.status, r.reason, r.upserted], [500, "db", 0]);
});

Deno.test("no outcome ever carries the credentials or Avalara's account ids", async () => {
  const bodies: unknown[] = [];
  for (const respond of [() => page(0, 5, 5), () => status(401), () => status(503)]) {
    const { admin } = makeAdmin();
    await withFetch(() => respond(), async () => { bodies.push(await syncTaxCodes(admin, NOW)); });
  }
  const { admin } = makeAdmin({ upsertErrorOn: 1 });
  await withFetch(() => page(0, 5, 5), async () => { bodies.push(await syncTaxCodes(admin, NOW)); });
  const text = JSON.stringify(bodies);
  for (const secret of ["test-account", "test-key", btoa("test-account:test-key"), "4242"]) {
    assert(!text.includes(secret), `an outcome contains ${secret}`);
  }
});

Deno.test("a North America exclusion in the description reaches the stored row", async () => {
  const { admin, ops } = makeAdmin();
  await withFetch(
    () => ok({ "@recordsetCount": 1, value: [{ taxCode: "PC040100", description: "Clothing (not applicable to north america)", taxCodeTypeId: "P" }] }),
    async () => { await syncTaxCodes(admin, NOW); },
  );
  assertEquals((named(ops, "upsert")[0][1] as { north_america: boolean }[])[0].north_america, false);
});
