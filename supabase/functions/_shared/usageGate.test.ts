// Unit tests for the wallet-floor gate in front of texts (migration 259).
//
// Deliberately dependency-free (no jsr:/npm: imports, and usageGate.ts has no imports at all)
// so this suite still runs on a machine with no registry access — the same rule the other
// _shared tests follow. Runs with --allow-env: the env rail is the thing under test.
//
// THE FAILURE THAT MATTERS IS A REFUSAL NOBODY ASKED FOR. This gate stands in front of a
// builder texting their customer. A gate that refuses while the meters are disarmed, or
// because our own billing query broke, stops real work for a few cents of usage that the cron
// would have charged for anyway. So most of what follows pins the paths that must ALLOW: the
// env rail, the exempt answer, and every way the question itself can fail.

import {
  AUTO_TOPUP_REQUEST_TIMEOUT_MS, checkUsageGate, keepAlive, requestAutoTopup, usageMetersOn,
} from "./usageGate.ts";

const assert = (cond: unknown, msg = "assertion failed") => {
  if (!cond) throw new Error(msg);
};
const assertEquals = (a: unknown, b: unknown, msg?: string) => {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(msg ? `${msg}: ${sa} !== ${sb}` : `${sa} !== ${sb}`);
};

/** Run `body` with these env vars set (undefined = deleted), restoring whatever was there. */
async function withEnv<T>(vars: Record<string, string | undefined>, body: () => Promise<T> | T): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(vars)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
  try {
    return await body();
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
  }
}

/** A service-role stub that answers wallet_usage_gate and records every call. */
function makeAdmin(answer: () => unknown) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const admin = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return answer();
    },
    from() {
      throw new Error("the gate must not read tables directly — the RPC is the one definition");
    },
  };
  return { admin, calls };
}

const ARMED = { PHONE_USAGE_METERS: "on" };
const verdict = (over: Record<string, unknown> = {}) => Promise.resolve({
  data: { allow: true, reason: "above_floor", available_cents: 4200, floor_cents: 500, auto_topup_enabled: false, ...over },
  error: null,
});

// ── The env rail ─────────────────────────────────────────────────────────────────────

Deno.test("DISARMED unless PHONE_USAGE_METERS is exactly \"on\" — and the database is never asked", async () => {
  for (const v of [undefined, "", "off", "ON", "true", "1", " on"]) {
    await withEnv({ PHONE_USAGE_METERS: v }, async () => {
      const { admin, calls } = makeAdmin(() => verdict({ allow: false, reason: "below_floor" }));
      const g = await checkUsageGate(admin, "tenant-a", "sms_segment");
      assertEquals(g, { allow: true, reason: "disarmed", availableCents: null, floorCents: null, autoTopupEnabled: false }, `value ${JSON.stringify(v)}`);
      assertEquals(calls.length, 0, `value ${JSON.stringify(v)} must cost zero network`);
      assert(!usageMetersOn(), `value ${JSON.stringify(v)} reads as off`);
    });
  }
});

Deno.test("armed, it asks wallet_usage_gate by its exact name and arguments", async () => {
  await withEnv(ARMED, async () => {
    const { admin, calls } = makeAdmin(() => verdict());
    await checkUsageGate(admin, "tenant-a", "sms_segment");
    assertEquals(calls, [{ name: "wallet_usage_gate", args: { p_client_id: "tenant-a", p_meter: "sms_segment" } }]);
  });
});

// ── The database's verdicts, carried through ─────────────────────────────────────────

Deno.test("above the floor: allowed, with the numbers in camelCase", async () => {
  await withEnv(ARMED, async () => {
    const { admin } = makeAdmin(() => verdict());
    assertEquals(await checkUsageGate(admin, "tenant-a", "sms_segment"),
      { allow: true, reason: "above_floor", availableCents: 4200, floorCents: 500, autoTopupEnabled: false });
  });
});

Deno.test("an EXEMPT tenant is allowed whatever its balance", async () => {
  await withEnv(ARMED, async () => {
    const { admin } = makeAdmin(() => verdict({ allow: true, reason: "exempt", available_cents: -900 }));
    const g = await checkUsageGate(admin, "tenant-a", "sms_segment");
    assert(g.allow && g.reason === "exempt", JSON.stringify(g));
  });
});

Deno.test("a database that says disarmed (meter inactive, not piloted) is allowed", async () => {
  await withEnv(ARMED, async () => {
    const { admin } = makeAdmin(() => verdict({ allow: true, reason: "disarmed", available_cents: 0 }));
    const g = await checkUsageGate(admin, "tenant-a", "sms_segment");
    assert(g.allow && g.reason === "disarmed", JSON.stringify(g));
  });
});

Deno.test("BELOW the floor: refused, and auto top-up is reported exactly as the database said", async () => {
  await withEnv(ARMED, async () => {
    const off = makeAdmin(() => verdict({ allow: false, reason: "below_floor", available_cents: 120, auto_topup_enabled: false }));
    assertEquals(await checkUsageGate(off.admin, "tenant-a", "sms_segment"),
      { allow: false, reason: "below_floor", availableCents: 120, floorCents: 500, autoTopupEnabled: false });

    const on = makeAdmin(() => verdict({ allow: false, reason: "below_floor", available_cents: -40, auto_topup_enabled: true }));
    const g = await checkUsageGate(on.admin, "tenant-a", "sms_segment");
    assert(!g.allow && g.autoTopupEnabled === true && g.availableCents === -40, JSON.stringify(g));

    // Only a real `true` means on: a string or a 1 is not the database saying so.
    const odd = makeAdmin(() => verdict({ allow: false, reason: "below_floor", auto_topup_enabled: "true" }));
    assertEquals((await checkUsageGate(odd.admin, "tenant-a", "sms_segment")).autoTopupEnabled, false);
  });
});

Deno.test("an unrecognised reason keeps the database's allow and folds onto that side", async () => {
  await withEnv(ARMED, async () => {
    const no = makeAdmin(() => verdict({ allow: false, reason: "some_future_reason" }));
    const g1 = await checkUsageGate(no.admin, "tenant-a", "sms_segment");
    assert(!g1.allow && g1.reason === "below_floor", JSON.stringify(g1));
    const yes = makeAdmin(() => verdict({ allow: true, reason: "some_future_reason" }));
    const g2 = await checkUsageGate(yes.admin, "tenant-a", "sms_segment");
    assert(g2.allow && g2.reason === "above_floor", JSON.stringify(g2));
  });
});

// ── FAILS OPEN ───────────────────────────────────────────────────────────────────────

Deno.test("an RPC error ALLOWS the send and says why (259 not applied, a network blip)", async () => {
  await withEnv(ARMED, async () => {
    const { admin } = makeAdmin(() => Promise.resolve({ data: null, error: { message: "function public.wallet_usage_gate does not exist" } }));
    const g = await checkUsageGate(admin, "tenant-a", "sms_segment");
    assert(g.allow === true && g.reason === "error", JSON.stringify(g));
    assert(String(g.error).includes("does not exist"), "the error is carried for the caller's log");
    assertEquals(g.autoTopupEnabled, false, "an error never claims a top-up is coming");
  });
});

Deno.test("a THROWN RPC (sync or async) also allows, and checkUsageGate itself never throws", async () => {
  await withEnv(ARMED, async () => {
    const sync = makeAdmin(() => { throw new Error("socket closed"); });
    const g1 = await checkUsageGate(sync.admin, "tenant-a", "sms_segment");
    assert(g1.allow && g1.reason === "error" && String(g1.error).includes("socket closed"), JSON.stringify(g1));
    const async_ = makeAdmin(() => Promise.reject(new Error("fetch failed")));
    const g2 = await checkUsageGate(async_.admin, "tenant-a", "sms_segment");
    assert(g2.allow && g2.reason === "error", JSON.stringify(g2));
  });
});

Deno.test("a reply that is not a verdict allows: null, an array, a missing or non-boolean allow", async () => {
  await withEnv(ARMED, async () => {
    for (const data of [null, undefined, [], [{ allow: false }], "no", { reason: "below_floor" }, { allow: "false", reason: "below_floor" }]) {
      const { admin } = makeAdmin(() => Promise.resolve({ data, error: null }));
      const g = await checkUsageGate(admin, "tenant-a", "sms_segment");
      assert(g.allow === true && g.reason === "error", `${JSON.stringify(data)} → ${JSON.stringify(g)}`);
    }
  });
});

// ── requestAutoTopup ─────────────────────────────────────────────────────────────────

const EDGE = { SUPABASE_URL: "https://stub.supabase.test/", SUPABASE_SERVICE_ROLE_KEY: "test-service-key" };

type Sent = { url: string; init: RequestInit };
function fakeFetch(respond: (s: Sent) => Promise<Response> | Response) {
  const sent: Sent[] = [];
  const f = ((input: RequestInfo | URL, init?: RequestInit) => {
    const s = { url: String(input), init: init ?? {} };
    sent.push(s);
    return Promise.resolve().then(() => respond(s));
  }) as typeof fetch;
  return { f, sent };
}
const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.test("requestAutoTopup POSTs {client_id} to wallet-autotopup with the service-role bearer", async () => {
  await withEnv(EDGE, async () => {
    const { f, sent } = fakeFetch(() => jsonRes({ fired: true, ok: true, reason: "charged" }));
    const r = await requestAutoTopup("tenant-a", { fetchImpl: f });
    assertEquals(r, { requested: true, status: 200, fired: true, ok: true, reason: "charged" });
    assertEquals(sent.length, 1);
    // The trailing slash on SUPABASE_URL is not doubled.
    assertEquals(sent[0].url, "https://stub.supabase.test/functions/v1/wallet-autotopup");
    assertEquals(sent[0].init.method, "POST");
    const h = new Headers(sent[0].init.headers);
    assertEquals(h.get("authorization"), "Bearer test-service-key");
    assertEquals(JSON.parse(String(sent[0].init.body)), { client_id: "tenant-a" });
    assert(sent[0].init.signal instanceof AbortSignal, "the request is bounded");
  });
});

Deno.test("a considered no (cooling down) is a 200 with ok, not a failure", async () => {
  await withEnv(EDGE, async () => {
    const { f } = fakeFetch(() => jsonRes({ fired: false, ok: true, reason: "cooling down" }));
    assertEquals(await requestAutoTopup("tenant-a", { fetchImpl: f }),
      { requested: true, status: 200, fired: false, ok: true, reason: "cooling down" });
  });
});

Deno.test("a gateway 401 (not JSON) is ok:false with the status as the reason, never a throw", async () => {
  await withEnv(EDGE, async () => {
    const { f } = fakeFetch(() => new Response("Invalid JWT", { status: 401 }));
    assertEquals(await requestAutoTopup("tenant-a", { fetchImpl: f }),
      { requested: true, status: 401, fired: null, ok: false, reason: "http_401" });
  });
});

Deno.test("a 200 whose body says ok:false (a decline) is reported as not ok", async () => {
  await withEnv(EDGE, async () => {
    const { f } = fakeFetch(() => jsonRes({ fired: true, ok: false, reason: "declined" }));
    const r = await requestAutoTopup("tenant-a", { fetchImpl: f });
    assert(r.status === 200 && r.ok === false && r.reason === "declined", JSON.stringify(r));
  });
});

Deno.test("a network failure and a timeout both resolve — requestAutoTopup never rejects", async () => {
  await withEnv(EDGE, async () => {
    const down = fakeFetch(() => Promise.reject(new TypeError("error sending request")));
    assertEquals(await requestAutoTopup("tenant-a", { fetchImpl: down.f }),
      { requested: true, status: null, fired: null, ok: false, reason: "network" });

    // A fetch that only ever ends by being aborted, with a 5 ms budget.
    const hang = fakeFetch((s) => new Promise<Response>((_, reject) => {
      s.init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    assertEquals(await requestAutoTopup("tenant-a", { fetchImpl: hang.f, timeoutMs: 5 }),
      { requested: true, status: null, fired: null, ok: false, reason: "timeout" });
  });
});

Deno.test("nothing is sent without a URL, a key or a client id", async () => {
  for (const [vars, id, reason] of [
    [{ SUPABASE_URL: undefined, SUPABASE_SERVICE_ROLE_KEY: "k" }, "tenant-a", "not_configured"],
    [{ SUPABASE_URL: "https://stub.supabase.test", SUPABASE_SERVICE_ROLE_KEY: undefined }, "tenant-a", "not_configured"],
    [EDGE, "", "no_client"],
  ] as const) {
    await withEnv(vars, async () => {
      const { f, sent } = fakeFetch(() => jsonRes({}));
      const r = await requestAutoTopup(id, { fetchImpl: f });
      assertEquals(r, { requested: false, status: null, fired: null, ok: false, reason });
      assertEquals(sent.length, 0);
    });
  }
});

Deno.test("the default budget outlasts the card sale it waits on (nmiPost gives the gateway 30 s)", () => {
  assert(AUTO_TOPUP_REQUEST_TIMEOUT_MS > 30_000, String(AUTO_TOPUP_REQUEST_TIMEOUT_MS));
});

// ── keepAlive ────────────────────────────────────────────────────────────────────────

Deno.test("keepAlive hands the work to the caller's waitUntil first, then EdgeRuntime's", async () => {
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  const saved = g.EdgeRuntime;
  try {
    const edge: Promise<unknown>[] = [];
    g.EdgeRuntime = { waitUntil: (p: Promise<unknown>) => edge.push(p) };

    const mine: Promise<unknown>[] = [];
    keepAlive(Promise.resolve(1), (p) => mine.push(p));
    assertEquals([mine.length, edge.length], [1, 0], "the caller's own waitUntil wins");

    keepAlive(Promise.resolve(2));
    assertEquals(edge.length, 1, "otherwise the edge runtime's");

    // A rejected job is swallowed in what is handed over, so it can never become an
    // unhandled rejection that takes the isolate down.
    keepAlive(Promise.reject(new Error("boom")));
    await Promise.all(edge);

    // And a waitUntil that throws does not throw out of keepAlive.
    keepAlive(Promise.resolve(3), () => { throw new Error("ctx is gone"); });
  } finally {
    g.EdgeRuntime = saved;
  }
});
