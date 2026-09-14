/**
 * Unit tests for customerSession — mint / check / revoke over customer_sessions.
 *
 * WHY THESE EXIST. The module's whole value is its guarantees: the raw token exists only
 * in mintSession's return value (the row stores the SHA-256, so a DB leak exposes no
 * usable credentials), garbage input never buys a database round-trip, a live hit
 * touches last_seen_at without letting that touch fail the verdict, and checkSession /
 * revokeSession resolve no matter what the database does. None of that is observable
 * from a happy-path manual run, so each guarantee is pinned here against a recording
 * fake of the supabase client. No network, no database.
 *
 * Run (from supabase/functions/_shared/):
 *   deno test --allow-env --node-modules-dir=none customerSession.test.ts
 * (the pre-push gate runs this for you with exactly those flags — see scripts/preflight.mjs)
 */

import {
  addIdentity,
  checkSession,
  identityForClient,
  mintSession,
  revokeSession,
  SESSION_TTL_DAYS,
  sha256Hex,
} from "./customerSession.ts";

// Local assertions rather than jsr:@std/assert, deliberately. The pre-push gate runs this
// file, and a gate that needs a registry fetch fails closed on an offline machine — which
// is the one thing scripts/preflight.mjs promises never to do.
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}
function assertEquals<T>(actual: T, expected: T, msg = ""): void {
  if (actual !== expected) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
      + (msg ? ` — ${msg}` : ""));
  }
}

// ── Admin stub ─────────────────────────────────────────────────────────────────────────────
// Records every .from() chain so a test can assert WHAT was queried/written — and, just as
// important, that nothing was. Shapes mirror the three supabase-js call patterns
// customerSession.ts uses:
//   from("customer_sessions").insert(row)                                ← awaited directly
//   from("customer_sessions").select(…).eq(…).is(…).gt(…).maybeSingle()
//   from("customer_sessions").update(patch).eq(…)                        ← thenable (fire-and-forget in check)

type DbCall = {
  table: string;
  op: "select" | "insert" | "update";
  payload?: Record<string, unknown>;
  filters: Record<string, unknown>;
};

type StubOpts = {
  /** The row maybeSingle() hands back (null = no live row: unknown, expired, or revoked —
   *  the WHERE clause makes those indistinguishable, which is the point). */
  selectRow?: Record<string, unknown> | null;
  /** Force the insert to fail. */
  insertError?: { message: string } | null;
  /** Make the select REJECT instead of resolving. */
  selectRejects?: boolean;
  /** Make every update REJECT instead of resolving. */
  updateRejects?: boolean;
  /** Make .from() itself throw synchronously. */
  fromThrows?: boolean;
  /** Rows an update(…).select() hands back ([] = the guarded fill matched nothing). */
  updateRows?: Record<string, unknown>[];
};

function stubAdmin(opts: StubOpts = {}) {
  const calls: DbCall[] = [];
  const admin = {
    from(table: string) {
      if (opts.fromThrows) throw new Error("client exploded before the query");
      return {
        insert(row: Record<string, unknown>) {
          calls.push({ table, op: "insert", payload: row, filters: {} });
          return Promise.resolve({ error: opts.insertError ?? null });
        },
        select(_cols: string) {
          const call: DbCall = { table, op: "select", filters: {} };
          calls.push(call);
          const builder = {
            eq(col: string, val: unknown) {
              call.filters[col] = val;
              return builder;
            },
            is(col: string, val: unknown) {
              call.filters[col] = val;
              return builder;
            },
            gt(col: string, val: unknown) {
              call.filters[col] = val;
              return builder;
            },
            maybeSingle() {
              if (opts.selectRejects) return Promise.reject(new Error("connection reset"));
              return Promise.resolve({ data: opts.selectRow ?? null, error: null });
            },
          };
          return builder;
        },
        update(patch: Record<string, unknown>) {
          const call: DbCall = { table, op: "update", payload: patch, filters: {} };
          calls.push(call);
          // Thenable builder: awaited straight after .eq() (revoke, the last_seen touch) OR
          // chained on through .is(…).select(…) (addIdentity's guarded fill). Nothing settles
          // until it is awaited, like the real client.
          const settle = () => opts.updateRejects
            ? Promise.reject(new Error("connection reset mid-update"))
            : Promise.resolve({ data: opts.updateRows ?? [{ client_id: "tenant-1" }], error: null });
          const builder = {
            eq(col: string, val: unknown) {
              call.filters[col] = val;
              return builder;
            },
            is(col: string, val: unknown) {
              call.filters[col] = val;
              return builder;
            },
            select(_cols: string) {
              return builder;
            },
            then(onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) {
              return settle().then(onOk, onErr);
            },
          };
          return builder;
        },
      };
    },
  };
  return { admin, calls };
}

const inserts = (calls: DbCall[]) => calls.filter((c) => c.op === "insert");
const selects = (calls: DbCall[]) => calls.filter((c) => c.op === "select");
const updates = (calls: DbCall[]) => calls.filter((c) => c.op === "update");

/** A shape-valid token: 43 chars of the base64url alphabet, same length as a real mint. */
const FAKE_TOKEN = "a".repeat(43);

const LIVE_ROW = { client_id: "tenant-1", phone_digits: "5551234567", email_lower: null, name: "Jo Customer" };
const EMAIL_ROW = { client_id: "tenant-1", phone_digits: null, email_lower: "jo@example.com", name: "Jo Customer" };
const PHONE = { phoneDigits: "5551234567" };

// ── sha256Hex ──────────────────────────────────────────────────────────────────────────────

Deno.test("sha256Hex matches the published SHA-256 test vectors", async () => {
  assertEquals(
    await sha256Hex(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assertEquals(
    await sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

// ── mintSession ────────────────────────────────────────────────────────────────────────────

Deno.test("mint: token is base64url, at least 43 chars, and unique across two mints", async () => {
  const db = stubAdmin();
  const t1 = await mintSession(db.admin, "tenant-1", PHONE, "Jo Customer");
  const t2 = await mintSession(db.admin, "tenant-1", PHONE, "Jo Customer");
  assert(/^[A-Za-z0-9_-]+$/.test(t1), "token must be pure base64url (no +, /, or = padding)");
  assert(t1.length >= 43, `32 random bytes encode to 43 base64url chars; got ${t1.length}`);
  assert(t1 !== t2, "two mints must never produce the same token");
  assertEquals(inserts(db.calls).length, 2, "each mint writes exactly one row");
});

Deno.test("mint stores the HASH, and the raw token appears nowhere in the row", async () => {
  const db = stubAdmin();
  const token = await mintSession(db.admin, "tenant-1", PHONE, "Jo Customer");
  const ins = inserts(db.calls);
  assertEquals(ins.length, 1);
  assertEquals(ins[0].table, "customer_sessions");
  const row = ins[0].payload as Record<string, unknown>;
  assertEquals(row.token_hash, await sha256Hex(token),
    "the hash is the stored credential — a DB leak must expose no usable tokens");
  assert(!JSON.stringify(row).includes(token), "the raw token leaked into the stored row");
  assertEquals(row.client_id, "tenant-1");
  assertEquals(row.phone_digits, "5551234567");
  assertEquals(row.email_lower, null, "a text-verified session proves no address");
  assertEquals(row.name, "Jo Customer");
  const exp = Date.parse(String(row.expires_at));
  const want = Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
  assert(Math.abs(exp - want) < 60_000,
    `expires_at must be ~now + ${SESSION_TTL_DAYS} days; was off by ${Math.abs(exp - want)}ms`);
});

Deno.test("mint: a null name is stored as null", async () => {
  const db = stubAdmin();
  await mintSession(db.admin, "tenant-1", PHONE, null);
  assertEquals((inserts(db.calls)[0].payload as Record<string, unknown>).name, null);
});

Deno.test("mint THROWS when the row cannot be written — a token with no row would fail every later check silently", async () => {
  const db = stubAdmin({ insertError: { message: "permission denied" } });
  let threw = false;
  try {
    await mintSession(db.admin, "tenant-1", PHONE, null);
  } catch {
    threw = true;
  }
  assert(threw, "a failed insert must surface at mint time, not as a dead credential later");
});

Deno.test("mint an EMAIL session: email_lower stored, phone_digits null — never a phone from anywhere", async () => {
  const db = stubAdmin();
  await mintSession(db.admin, "tenant-1", { emailLower: "jo@example.com" }, "Jo");
  const row = inserts(db.calls)[0].payload as Record<string, unknown>;
  assertEquals(row.email_lower, "jo@example.com");
  assertEquals(row.phone_digits, null);
});

Deno.test("mint THROWS before any write when no identity is given — a session for nobody", async () => {
  for (const who of [{}, { phoneDigits: null, emailLower: null }, { phoneDigits: "  ", emailLower: "" }]) {
    const db = stubAdmin();
    let threw = false;
    try {
      await mintSession(db.admin, "tenant-1", who, null);
    } catch {
      threw = true;
    }
    assert(threw, `mint with ${JSON.stringify(who)} must throw`);
    assertEquals(db.calls.length, 0, "nothing may reach the database for an identity-less mint");
  }
});

// ── checkSession ───────────────────────────────────────────────────────────────────────────

Deno.test("check: non-string / absent / short tokens → null with ZERO database calls", async () => {
  const db = stubAdmin({ selectRow: LIVE_ROW });
  for (const bad of [undefined, null, 12345, {}, ["x"], "", "short", "a".repeat(42)]) {
    assertEquals(await checkSession(db.admin, bad), null,
      `garbage token ${JSON.stringify(bad)} must be null`);
  }
  assertEquals(db.calls.length, 0,
    "every request carries this check — garbage must die before any database round-trip");
});

Deno.test("check: live row → identity, looked up by hash, and the last_seen_at touch fires", async () => {
  const db = stubAdmin({ selectRow: LIVE_ROW });
  const res = await checkSession(db.admin, FAKE_TOKEN);
  assert(res !== null, "a live row must resolve to an identity");
  assertEquals(res?.clientId, "tenant-1");
  assertEquals(res?.phoneDigits, "5551234567");
  assertEquals(res?.emailLower, null);
  assertEquals(res?.name, "Jo Customer");

  const sel = selects(db.calls);
  assertEquals(sel.length, 1);
  assertEquals(sel[0].table, "customer_sessions");
  assertEquals(sel[0].filters.token_hash, await sha256Hex(FAKE_TOKEN),
    "the lookup must be by hash — the raw token never reaches the database");
  assertEquals(sel[0].filters.revoked_at, null, "the WHERE must exclude revoked rows");
  assert(
    typeof sel[0].filters.expires_at === "string" &&
      !Number.isNaN(Date.parse(String(sel[0].filters.expires_at))),
    "the WHERE must exclude expired rows by comparing expires_at to now",
  );

  const upd = updates(db.calls);
  assertEquals(upd.length, 1, "a hit must touch last_seen_at");
  assert("last_seen_at" in (upd[0].payload ?? {}), "the touch must set last_seen_at");
  assertEquals(upd[0].filters.token_hash, await sha256Hex(FAKE_TOKEN));
  await Promise.resolve(); // let the fire-and-forget settle inside the test's lifetime
});

Deno.test("check: an email-only row resolves to phoneDigits null — never the string \"null\"", async () => {
  const db = stubAdmin({ selectRow: EMAIL_ROW });
  const res = await checkSession(db.admin, FAKE_TOKEN);
  assert(res !== null, "an email session is a session");
  assertEquals(res?.phoneDigits, null);
  assertEquals(res?.emailLower, "jo@example.com");
});

Deno.test("check: a row proving neither identity is NO session", async () => {
  const db = stubAdmin({ selectRow: { client_id: "tenant-1", phone_digits: null, email_lower: "", name: "x" } });
  assertEquals(await checkSession(db.admin, FAKE_TOKEN), null);
});

Deno.test("identityForClient names only what was proven", () => {
  const base = { clientId: "t", name: null };
  assertEquals(JSON.stringify(identityForClient({ ...base, phoneDigits: "5551234567", emailLower: null })), JSON.stringify({ phone: "5551234567" }));
  assertEquals(JSON.stringify(identityForClient({ ...base, phoneDigits: null, emailLower: "jo@example.com" })), JSON.stringify({ email: "jo@example.com" }));
  assertEquals(JSON.stringify(identityForClient({ ...base, phoneDigits: "5551234567", emailLower: "jo@example.com" })), JSON.stringify({ phone: "5551234567", email: "jo@example.com" }));
});

Deno.test("check: a row with a null name resolves to name null", async () => {
  const db = stubAdmin({ selectRow: { ...LIVE_ROW, name: null } });
  const res = await checkSession(db.admin, FAKE_TOKEN);
  assert(res !== null, "must resolve");
  assertEquals(res?.name, null);
});

Deno.test("check: expired/revoked/unknown (empty select) → null, and NO last_seen touch", async () => {
  const db = stubAdmin({ selectRow: null });
  assertEquals(await checkSession(db.admin, FAKE_TOKEN), null);
  assertEquals(selects(db.calls).length, 1, "a shape-valid token does reach the database");
  assertEquals(updates(db.calls).length, 0, "a miss must not touch last_seen_at");
});

Deno.test("check: a FAILING last_seen touch does not fail the verdict", async () => {
  const db = stubAdmin({ selectRow: LIVE_ROW, updateRejects: true });
  const res = await checkSession(db.admin, FAKE_TOKEN);
  assert(res !== null,
    "the touch is bookkeeping — its rejection must not turn a valid session into a rejected request");
  assertEquals(res?.clientId, "tenant-1");
  assertEquals(updates(db.calls).length, 1, "the touch was attempted");
  await Promise.resolve(); // the swallowed rejection must not surface after the test either
});

Deno.test("check never throws: a rejecting select resolves to null", async () => {
  const db = stubAdmin({ selectRejects: true });
  assertEquals(await checkSession(db.admin, FAKE_TOKEN), null);
});

Deno.test("check never throws: a client that explodes in from() resolves to null", async () => {
  const db = stubAdmin({ fromThrows: true });
  assertEquals(await checkSession(db.admin, FAKE_TOKEN), null);
});

// ── revokeSession ──────────────────────────────────────────────────────────────────────────

Deno.test("revoke sets revoked_at on the row matching the token's hash", async () => {
  const db = stubAdmin();
  const token = "b".repeat(43);
  await revokeSession(db.admin, token);
  const upd = updates(db.calls);
  assertEquals(upd.length, 1);
  assertEquals(upd[0].table, "customer_sessions");
  assert("revoked_at" in (upd[0].payload ?? {}), "revoke must set revoked_at");
  assertEquals(upd[0].filters.token_hash, await sha256Hex(token),
    "revoke targets by hash — the raw token never reaches the database");
});

Deno.test("revoke: garbage token is a no-op with zero database calls", async () => {
  const db = stubAdmin();
  await revokeSession(db.admin, undefined);
  await revokeSession(db.admin, 42);
  await revokeSession(db.admin, "short");
  assertEquals(db.calls.length, 0, "garbage must not reach the database");
});

Deno.test("revoke never throws: a rejecting update and an exploding client both resolve", async () => {
  const db1 = stubAdmin({ updateRejects: true });
  await revokeSession(db1.admin, "b".repeat(43)); // resolving IS the assertion
  assertEquals(updates(db1.calls).length, 1, "the revoke was attempted");
  const db2 = stubAdmin({ fromThrows: true });
  await revokeSession(db2.admin, "b".repeat(43)); // resolving IS the assertion
});

// ── addIdentity ────────────────────────────────────────────────────────────────────────────

Deno.test("addIdentity: a phone session that proves an email gains it — guarded fill, same tenant, merged identity back", async () => {
  const db = stubAdmin({ selectRow: LIVE_ROW });
  const res = await addIdentity(db.admin, FAKE_TOKEN, "tenant-1", { emailLower: "jo@example.com" });
  assert(res !== null, "the upgrade must land");
  assertEquals(res?.phoneDigits, "5551234567");
  assertEquals(res?.emailLower, "jo@example.com");
  const upd = updates(db.calls);
  assertEquals(upd.length, 1);
  assertEquals(upd[0].payload?.email_lower, "jo@example.com");
  assert(!("phone_digits" in (upd[0].payload ?? {})), "the fill must never touch the identity it already holds");
  assertEquals(upd[0].filters.token_hash, await sha256Hex(FAKE_TOKEN));
  assertEquals(upd[0].filters.email_lower, null, "the fill must match only while the column is still empty");
});

Deno.test("addIdentity: an email session that proves a phone gains it", async () => {
  const db = stubAdmin({ selectRow: EMAIL_ROW });
  const res = await addIdentity(db.admin, FAKE_TOKEN, "tenant-1", PHONE);
  assertEquals(res?.phoneDigits, "5551234567");
  assertEquals(res?.emailLower, "jo@example.com");
  assertEquals(updates(db.calls)[0].filters.phone_digits, null);
});

Deno.test("addIdentity: proving what the session already holds is a no-op with no write", async () => {
  const db = stubAdmin({ selectRow: LIVE_ROW });
  const res = await addIdentity(db.admin, FAKE_TOKEN, "tenant-1", PHONE);
  assertEquals(res?.phoneDigits, "5551234567");
  assertEquals(updates(db.calls).length, 0);
});

Deno.test("addIdentity: a DIFFERENT phone on a phone session is someone else — null, nothing written", async () => {
  const db = stubAdmin({ selectRow: LIVE_ROW });
  assertEquals(await addIdentity(db.admin, FAKE_TOKEN, "tenant-1", { phoneDigits: "5550000000" }), null);
  assertEquals(updates(db.calls).length, 0);
  const db2 = stubAdmin({ selectRow: EMAIL_ROW });
  assertEquals(await addIdentity(db2.admin, FAKE_TOKEN, "tenant-1", { emailLower: "other@example.com" }), null);
  assertEquals(updates(db2.calls).length, 0);
});

Deno.test("addIdentity: another tenant's session is never upgraded", async () => {
  const db = stubAdmin({ selectRow: LIVE_ROW });
  assertEquals(await addIdentity(db.admin, FAKE_TOKEN, "tenant-2", { emailLower: "jo@example.com" }), null);
  assertEquals(updates(db.calls).length, 0);
});

Deno.test("addIdentity: garbage token, or not exactly one identity → null with ZERO database calls", async () => {
  const db = stubAdmin({ selectRow: LIVE_ROW });
  assertEquals(await addIdentity(db.admin, undefined, "tenant-1", PHONE), null);
  assertEquals(await addIdentity(db.admin, "short", "tenant-1", PHONE), null);
  assertEquals(await addIdentity(db.admin, FAKE_TOKEN, "tenant-1", {}), null);
  assertEquals(await addIdentity(db.admin, FAKE_TOKEN, "tenant-1", { phoneDigits: "5551234567", emailLower: "jo@example.com" }), null);
  assertEquals(db.calls.length, 0);
});

Deno.test("addIdentity: unknown/expired/revoked token → null, and nothing written", async () => {
  const db = stubAdmin({ selectRow: null });
  assertEquals(await addIdentity(db.admin, FAKE_TOKEN, "tenant-1", { emailLower: "jo@example.com" }), null);
  assertEquals(updates(db.calls).length, 0);
});

Deno.test("addIdentity: a fill that lost the race (matched no row) → null, so the caller mints fresh", async () => {
  const db = stubAdmin({ selectRow: LIVE_ROW, updateRows: [] });
  assertEquals(await addIdentity(db.admin, FAKE_TOKEN, "tenant-1", { emailLower: "jo@example.com" }), null);
});

Deno.test("addIdentity never throws: rejecting select, rejecting update, exploding client", async () => {
  assertEquals(await addIdentity(stubAdmin({ selectRejects: true }).admin, FAKE_TOKEN, "tenant-1", PHONE), null);
  assertEquals(await addIdentity(stubAdmin({ selectRow: EMAIL_ROW, updateRejects: true }).admin, FAKE_TOKEN, "tenant-1", PHONE), null);
  assertEquals(await addIdentity(stubAdmin({ fromThrows: true }).admin, FAKE_TOKEN, "tenant-1", PHONE), null);
});

Deno.test("addIdentity fills the name only where the session had none", async () => {
  const named = stubAdmin({ selectRow: LIVE_ROW });
  const r1 = await addIdentity(named.admin, FAKE_TOKEN, "tenant-1", { emailLower: "jo@example.com" }, "Someone Else");
  assertEquals(r1?.name, "Jo Customer");
  assert(!("name" in (updates(named.calls)[0].payload ?? {})), "an existing name is never overwritten");
  const unnamed = stubAdmin({ selectRow: { ...LIVE_ROW, name: null } });
  const r2 = await addIdentity(unnamed.admin, FAKE_TOKEN, "tenant-1", { emailLower: "jo@example.com" }, "Jo");
  assertEquals(r2?.name, "Jo");
  assertEquals(updates(unnamed.calls)[0].payload?.name, "Jo");
});
