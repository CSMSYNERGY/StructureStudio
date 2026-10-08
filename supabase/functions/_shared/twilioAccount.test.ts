// Workstream 2: which Twilio account a tenant's calls run in (twilioAccount.ts), every path.
//
// What is pinned, because each one is invisible from a happy-path send:
//   * SWITCH OFF MEANS NO DATABASE: with TWILIO_SUBACCOUNTS anything but "on", every function
//     answers from the environment and the `admin` it is handed is never touched (a client that
//     throws on any property access proves it);
//   * with it on: no row or a parent row is the parent; an active sub is its Vault credentials;
//     any other status is not_ready; a lookup that fails is lookup_failed (fail closed);
//   * the webhook helpers: the parent is answered without a lookup, a known active sub with one
//     (cached), anything else is refused, and a tenant may only be touched by its own account.
// Every SID, key and token is made up. No network; no jsr imports (the preflight's offline group).
// Run: deno test --allow-env --node-modules-dir=none supabase/functions/_shared/twilioAccount.test.ts

import {
  _resetTwilioAccountCaches, accountBySid, eventAccountSid, parentCreds, requestAccount, resolveTwilioAccount,
  subaccountsOn, tenantAccountSid, TwilioAccountError, webhookMatchesTenant, type WebhookAccount,
} from "./twilioAccount.ts";

const assert = (cond: unknown, msg = "assertion failed") => {
  if (!cond) throw new Error(msg);
};
const assertEquals = (a: unknown, b: unknown, msg?: string) => {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(msg ? `${msg}: ${sa} !== ${sb}` : `${sa} !== ${sb}`);
};
async function rejects(p: Promise<unknown>): Promise<TwilioAccountError> {
  try {
    await p;
  } catch (e) {
    assert(e instanceof TwilioAccountError, `expected a TwilioAccountError, got ${e}`);
    return e as TwilioAccountError;
  }
  throw new Error("expected a rejection");
}

const PARENT = "AC" + "0".repeat(32);
const SUB = "AC" + "5".repeat(32);
const KEY = "SK" + "5".repeat(32);
const SECRET = "subkeysecret" + "x".repeat(20);
const TOKEN = "subauthtoken" + "y".repeat(20);

const ENV: Record<string, string> = {
  TWILIO_ACCOUNT_SID: PARENT,
  TWILIO_API_KEY: "SK" + "0".repeat(32),
  TWILIO_API_SECRET: "parent-api-secret",
  TWILIO_AUTH_TOKEN: "parent-auth-token",
};
const envOf = (over: Record<string, string | undefined> = {}) => {
  const e = { ...ENV, ...over };
  return (k: string) => e[k];
};
const ON = envOf({ TWILIO_SUBACCOUNTS: "on" });

/** A client that fails the test the moment anything is asked of it. */
const untouchable = new Proxy({}, { get: (_t, prop) => { throw new Error(`the database was touched (${String(prop)})`); } });

/** A fake client answering twilio_account_creds and twilio_accounts, recording every call. */
function fakeAdmin(o: {
  creds?: (args: Record<string, string>) => unknown[] | { error: { code: string } } | "throw";
  accounts?: (clientId: string) => unknown | { error: { code: string } };
} = {}) {
  const calls: string[] = [];
  const admin = {
    rpc(name: string, args: Record<string, string>) {
      calls.push(`rpc:${name}:${JSON.stringify(args)}`);
      const out = o.creds ? o.creds(args) : [];
      if (out === "throw") return Promise.reject(new Error("network down"));
      if (out && !Array.isArray(out) && "error" in (out as object)) return Promise.resolve({ data: null, error: (out as { error: unknown }).error });
      return Promise.resolve({ data: out, error: null });
    },
    from(table: string) {
      let id = "";
      const q = {
        select: () => q,
        eq: (_c: string, v: string) => { id = v; return q; },
        maybeSingle: () => {
          calls.push(`from:${table}:${id}`);
          const out = o.accounts ? o.accounts(id) : null;
          if (out && typeof out === "object" && "error" in (out as object)) return Promise.resolve({ data: null, error: (out as { error: unknown }).error });
          return Promise.resolve({ data: out ?? null, error: null });
        },
      };
      return q;
    },
  };
  return { admin, calls };
}

const subRow = (over: Record<string, unknown> = {}) => ({
  client_id: "sub-builder", kind: "sub", account_sid: SUB, status: "active",
  api_key_sid: KEY, api_secret: SECRET, auth_token: TOKEN,
  twiml_app_sid: "AP" + "5".repeat(32), push_apns_dev_sid: null, push_apns_prod_sid: null, push_fcm_sid: null, ...over,
});

// ── The switch ──────────────────────────────────────────────────────────────────────────────
Deno.test("the switch is exactly \"on\"", () => {
  assert(subaccountsOn(ON));
  for (const v of [undefined, "", "off", "ON", "true", " on"]) assert(!subaccountsOn(envOf({ TWILIO_SUBACCOUNTS: v })), `"${v}" must be off`);
});

// ── parentCreds (moved from portal-settings/phoneNumber.ts) ────────────────────────────────
Deno.test("parentCreds: the API key pair first, then AccountSid:AuthToken, else null", () => {
  assertEquals(parentCreds(envOf()), { accountSid: PARENT, user: ENV.TWILIO_API_KEY, pass: ENV.TWILIO_API_SECRET });
  assertEquals(parentCreds(envOf({ TWILIO_API_KEY: "" })), { accountSid: PARENT, user: PARENT, pass: ENV.TWILIO_AUTH_TOKEN });
  assertEquals(parentCreds(envOf({ TWILIO_API_KEY: "", TWILIO_AUTH_TOKEN: "" })), null);
  assertEquals(parentCreds(envOf({ TWILIO_ACCOUNT_SID: "" })), null);
});

// ── resolveTwilioAccount ────────────────────────────────────────────────────────────────────
Deno.test("OFF: the parent from the environment, and the database is never touched", async () => {
  for (const v of [undefined, "off", "ON"]) {
    const a = await resolveTwilioAccount(untouchable, "any-builder", envOf({ TWILIO_SUBACCOUNTS: v }));
    assertEquals(a && { accountSid: a.accountSid, user: a.user, pass: a.pass, source: a.source },
      { accountSid: PARENT, user: ENV.TWILIO_API_KEY, pass: ENV.TWILIO_API_SECRET, source: "parent" });
  }
  // Not configured is still null, the old "not switched on", with no lookup either.
  assertEquals(await resolveTwilioAccount(untouchable, "any-builder", envOf({ TWILIO_ACCOUNT_SID: "" })), null);
});

Deno.test("ON, no row or a parent row: the parent, after exactly one lookup by tenant", async () => {
  const none = fakeAdmin({ creds: () => [] });
  assertEquals((await resolveTwilioAccount(none.admin, "new-builder", ON))?.source, "parent");
  assertEquals(none.calls, ['rpc:twilio_account_creds:{"p_client_id":"new-builder"}']);
  const pinned = fakeAdmin({ creds: () => [{ client_id: "pinned", kind: "parent", account_sid: null, status: "active" }] });
  const p = await resolveTwilioAccount(pinned.admin, "pinned", ON);
  assertEquals(p && [p.source, p.accountSid, p.user], ["parent", PARENT, ENV.TWILIO_API_KEY]);
});

Deno.test("ON, an active sub: its SID on the path, its key pair (else its token), its token for signatures", async () => {
  const { admin } = fakeAdmin({ creds: () => [subRow()] });
  const a = await resolveTwilioAccount(admin, "sub-builder", ON);
  assertEquals(a && [a.source, a.accountSid, a.user, a.pass, a.authToken, a.clientId, a.twimlAppSid],
    ["sub", SUB, KEY, SECRET, TOKEN, "sub-builder", "AP" + "5".repeat(32)]);
  const tokenOnly = fakeAdmin({ creds: () => [subRow({ api_key_sid: null, api_secret: null })] });
  const t = await resolveTwilioAccount(tokenOnly.admin, "sub-builder", ON);
  assertEquals(t && [t.user, t.pass], [SUB, TOKEN]);
});

Deno.test("ON, a sub in any other status: not_ready (never the parent's credentials)", async () => {
  for (const status of ["provisioning", "suspended", "closed", "failed"]) {
    const { admin } = fakeAdmin({ creds: () => [subRow({ status })] });
    const e = await rejects(resolveTwilioAccount(admin, "sub-builder", ON));
    assertEquals([e.kind, e.accountStatus], ["not_ready", status]);
  }
});

Deno.test("ON, a lookup that fails: lookup_failed for that tenant (fail closed), the code only in the message", async () => {
  for (const creds of [() => ({ error: { code: "42883" } }), () => "throw" as const]) {
    const { admin } = fakeAdmin({ creds });
    const e = await rejects(resolveTwilioAccount(admin, "sub-builder", ON));
    assertEquals(e.kind, "lookup_failed");
  }
  // An active sub with nothing usable in Vault is refused too, never run as the parent.
  const empty = fakeAdmin({ creds: () => [subRow({ api_key_sid: null, api_secret: null, auth_token: null })] });
  assertEquals((await rejects(resolveTwilioAccount(empty.admin, "sub-builder", ON))).kind, "lookup_failed");
  const noSid = fakeAdmin({ creds: () => [subRow({ account_sid: null })] });
  assertEquals((await rejects(resolveTwilioAccount(noSid.admin, "sub-builder", ON))).kind, "lookup_failed");
});

// ── Webhooks ────────────────────────────────────────────────────────────────────────────────
Deno.test("accountBySid: the parent with no lookup (on or off); off, anything else is null with no lookup", async () => {
  _resetTwilioAccountCaches();
  for (const get of [ON, envOf()]) {
    assertEquals(await accountBySid(untouchable, PARENT, get), { source: "parent", accountSid: PARENT, clientId: null, authToken: "parent-auth-token" });
  }
  assertEquals(await accountBySid(untouchable, SUB, envOf()), null);
  assertEquals(await accountBySid(untouchable, "not-a-sid", ON), null);
});

Deno.test("accountBySid ON: an active sub with its token; anything else null; kept 5 minutes, a miss 30 seconds", async () => {
  _resetTwilioAccountCaches();
  const t0 = 1_000_000;
  const f = fakeAdmin({ creds: (a) => (a.p_account_sid === SUB ? [subRow()] : []) });
  assertEquals(await accountBySid(f.admin, SUB, ON, t0), { source: "sub", accountSid: SUB, clientId: "sub-builder", authToken: TOKEN });
  await accountBySid(f.admin, SUB, ON, t0 + 4 * 60_000);
  assertEquals(f.calls.length, 1, "a known sub is answered from the cache inside 5 minutes");
  await accountBySid(f.admin, SUB, ON, t0 + 6 * 60_000);
  assertEquals(f.calls.length, 2, "and looked up again after");
  const other = "AC" + "9".repeat(32);
  assertEquals(await accountBySid(f.admin, other, ON, t0), null);
  await accountBySid(f.admin, other, ON, t0 + 20_000);
  assertEquals(f.calls.length, 3, "a miss is kept 30 seconds");
  await accountBySid(f.admin, other, ON, t0 + 31_000);
  assertEquals(f.calls.length, 4, "then asked again (a sub made active a moment ago is found)");
  for (const status of ["provisioning", "suspended"]) {
    _resetTwilioAccountCaches();
    const g = fakeAdmin({ creds: () => [subRow({ status })] });
    assertEquals(await accountBySid(g.admin, SUB, ON), null, `a ${status} sub is not one of ours for webhooks`);
  }
  _resetTwilioAccountCaches();
  const noToken = fakeAdmin({ creds: () => [subRow({ auth_token: null })] });
  assertEquals(await accountBySid(noToken.admin, SUB, ON), null, "a sub with no token can never sign");
});

Deno.test("accountBySid ON: a failed lookup throws and is NOT cached", async () => {
  _resetTwilioAccountCaches();
  let down = true;
  const f = fakeAdmin({ creds: () => (down ? { error: { code: "57014" } } : [subRow()]) });
  assertEquals((await rejects(accountBySid(f.admin, SUB, ON))).kind, "lookup_failed");
  down = false;
  assertEquals((await accountBySid(f.admin, SUB, ON))?.source, "sub");
});

Deno.test("tenantAccountSid: off null with no lookup; on, the sub's SID or null (the parent); failures throw", async () => {
  _resetTwilioAccountCaches();
  assertEquals(await tenantAccountSid(untouchable, "sub-builder", envOf()), null);
  const f = fakeAdmin({ accounts: (id) => (id === "sub-builder" ? { kind: "sub", account_sid: SUB } : id === "pinned" ? { kind: "parent", account_sid: null } : null) });
  assertEquals(await tenantAccountSid(f.admin, "sub-builder", ON), SUB);
  assertEquals(await tenantAccountSid(f.admin, "pinned", ON), null);
  assertEquals(await tenantAccountSid(f.admin, "nobody", ON), null);
  await tenantAccountSid(f.admin, "sub-builder", ON);
  assertEquals(f.calls.filter((c) => c === "from:twilio_accounts:sub-builder").length, 1, "cached");
  _resetTwilioAccountCaches();
  const down = fakeAdmin({ accounts: () => ({ error: { code: "57014" } }) });
  assertEquals((await rejects(tenantAccountSid(down.admin, "sub-builder", ON))).kind, "lookup_failed");
});

Deno.test("webhookMatchesTenant: a sub touches only its tenant; the parent only tenants with no sub", () => {
  const parent: WebhookAccount = { source: "parent", accountSid: PARENT, clientId: null, authToken: null };
  const sub: WebhookAccount = { source: "sub", accountSid: SUB, clientId: "sub-builder", authToken: TOKEN };
  assert(webhookMatchesTenant(parent, null));
  assert(!webhookMatchesTenant(parent, SUB));
  assert(webhookMatchesTenant(sub, SUB));
  assert(!webhookMatchesTenant(sub, null));
  assert(!webhookMatchesTenant(sub, "AC" + "9".repeat(32)));
});

Deno.test("requestAccount: off is 'off' with no lookup; on, parent / sub / refused", async () => {
  _resetTwilioAccountCaches();
  assertEquals(await requestAccount(untouchable, SUB, envOf()), { kind: "off" });
  assertEquals((await requestAccount(untouchable, PARENT, ON)), { kind: "account", account: { source: "parent", accountSid: PARENT, clientId: null, authToken: "parent-auth-token" } });
  assertEquals((await requestAccount(untouchable, "", ON)).kind, "account", "no AccountSid: the parent's own check");
  const f = fakeAdmin({ creds: (a) => (a.p_account_sid === SUB ? [subRow()] : []) });
  const r = await requestAccount(f.admin, SUB, ON);
  assertEquals(r.kind === "account" && r.account.source, "sub");
  assertEquals(await requestAccount(f.admin, "AC" + "9".repeat(32), ON), { kind: "refused", reason: "wrong_account" });
  _resetTwilioAccountCaches();
  const down = fakeAdmin({ creds: () => "throw" });
  assertEquals(await requestAccount(down.admin, SUB, ON), { kind: "refused", reason: "lookup_failed" });
});

Deno.test("eventAccountSid reads Event Streams' accountsid, and only a real SID", () => {
  assertEquals(eventAccountSid({ accountsid: SUB }), SUB);
  assertEquals(eventAccountSid({ accountSid: SUB }), SUB);
  assertEquals(eventAccountSid({ accountsid: "AC123" }), "");
  assertEquals(eventAccountSid(null), "");
});
