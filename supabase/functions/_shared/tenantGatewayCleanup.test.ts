// Deliberately dependency-free (no jsr:/npm: imports) so this suite still runs on a machine with no
// registry access, the same rule the other _shared tests follow. It needs --allow-env and nothing
// else: tenantGatewayCleanup.ts imports nmi.ts for isGatewayUnknown, and nmi.ts reads its keys at
// load. The gateway itself is a fake, so nothing leaves the box.
//
// Getting this wrong is expensive in BOTH directions, so both edges are pinned:
//   * Too EAGER (a decline read as "already gone", or a step skipped): the tenant is wiped while a
//     subscription keeps charging their card at the gateway, and nothing on our side shows it.
//   * Too STRICT (a genuinely gone id read as a failure): the builder cannot be deleted. That one
//     is visible: the refusal carries the gateway's own sentence.
//
// The gateway sentences used as NEGATIVES are real: the first two came back from NMI on 2026-10-05
// (its retired public demo key and demo login), "Duplicate transaction" is in our own app_errors,
// and the Customer Vault one is a documented NMI answer. Ids and tenants are made up (public repo).

import {
  cleanupTenantGateway,
  GatewayCleanupError,
  gatewaySaysGone,
  needsGateway,
  type NmiPost,
  openSubscriptions,
} from "./tenantGatewayCleanup.ts";

const assert = (cond: unknown, msg = "assertion failed") => {
  if (!cond) throw new Error(msg);
};
const assertEquals = (a: unknown, b: unknown, msg?: string) => {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(msg ? `${msg}: ${sa} !== ${sb}` : `${sa} !== ${sb}`);
};
async function rejects(fn: () => Promise<unknown>, msg: string): Promise<GatewayCleanupError> {
  try {
    await fn();
  } catch (e) {
    assert(e instanceof GatewayCleanupError, `${msg}: threw ${String(e)} instead of a GatewayCleanupError`);
    return e as GatewayCleanupError;
  }
  throw new Error(`${msg}: did not throw`);
}

// The shapes nmi.ts throws: a decline is the gateway's responsetext; no answer is GATEWAY_UNKNOWN:.
const decline = (text: string) => new Error(text);
const noAnswer = (text = "connection reset") => new Error(`GATEWAY_UNKNOWN: ${text}`);

const VAULT = "8877665544";

/** A fake gateway: records every call, answers from `answer` (throw to decline). */
function gateway(answer: (p: Record<string, string>) => void = () => {}) {
  const calls: Record<string, string>[] = [];
  const post: NmiPost = (p) => {
    calls.push({ ...p });
    try {
      answer(p);
    } catch (e) {
      return Promise.reject(e);
    }
    return Promise.resolve({ response: "1", responsetext: "OK" });
  };
  return { calls, post };
}
const op = (c: Record<string, string>) =>
  c.recurring ? `delete_subscription ${c.subscription_id}` : `delete_customer ${c.customer_vault_id}`;

// ── Nothing at the gateway: zero calls ───────────────────────────────────────────────────────

Deno.test("no vault and no subscriptions makes zero gateway calls", async () => {
  for (const [subs, vaultId] of [[[], null], [null, undefined], [[], ""], [[], "   "]] as const) {
    const g = gateway();
    const out = await cleanupTenantGateway({ subs, vaultId, nmiPost: g.post });
    assertEquals(g.calls, [], `subs=${JSON.stringify(subs)} vault=${JSON.stringify(vaultId)}`);
    assertEquals(out, { subscriptionsCancelled: 0, vaultDeleted: false, alreadyGone: 0 });
    assert(!needsGateway(subs, vaultId), "needsGateway agrees there is nothing to do");
  }
});

Deno.test("only cancelled subscriptions and no vault: zero calls, nothing needed", async () => {
  // A 'cancelled' row was deleted at the gateway BEFORE it was marked (portal-billing's cancel and
  // its upgrade path both call delete_subscription first). Deleting it again is pointless at best.
  const subs = [{ id: "4000000001", status: "cancelled" }, { id: "4000000002", status: "cancelled" }];
  const g = gateway();
  assert(!needsGateway(subs, null));
  assertEquals(await cleanupTenantGateway({ subs, vaultId: null, nmiPost: g.post }), {
    subscriptionsCancelled: 0, vaultDeleted: false, alreadyGone: 0,
  });
  assertEquals(g.calls, []);
});

// ── The order and the exact calls ────────────────────────────────────────────────────────────

Deno.test("every open subscription is cancelled, in row order, and the vault goes LAST", async () => {
  const subs = [
    { id: "4000000001", status: "active" },
    { id: "4000000002", status: "cancelled" },
    { id: "4000000003", status: "past_due" },
    { id: "4000000004", status: "paused" },
    { id: "4000000005", status: null }, // unknown or missing status: when unsure, cancel
  ];
  const marked: string[] = [];
  const g = gateway();
  const out = await cleanupTenantGateway({ subs, vaultId: VAULT, nmiPost: g.post, onCancelled: (id) => { marked.push(id); } });
  assertEquals(g.calls.map(op), [
    "delete_subscription 4000000001",
    "delete_subscription 4000000003",
    "delete_subscription 4000000004",
    "delete_subscription 4000000005",
    `delete_customer ${VAULT}`,
  ]);
  // Exactly the gateway's parameters, nothing else: no lookup, no list, no other id.
  assertEquals(g.calls[0], { recurring: "delete_subscription", subscription_id: "4000000001" });
  assertEquals(g.calls[4], { customer_vault: "delete_customer", customer_vault_id: VAULT });
  assertEquals(out, { subscriptionsCancelled: 4, vaultDeleted: true, alreadyGone: 0 });
  assertEquals(marked, ["4000000001", "4000000003", "4000000004", "4000000005"], "each mirror row is marked as it goes");
  assert(needsGateway(subs, null) && needsGateway([], VAULT), "needsGateway: open subscriptions OR a vault");
  assertEquals(openSubscriptions(subs).map((s) => s.id), ["4000000001", "4000000003", "4000000004", "4000000005"]);
});

Deno.test("a vault with no subscriptions is still removed", async () => {
  const g = gateway();
  const out = await cleanupTenantGateway({ subs: [], vaultId: ` ${VAULT} `, nmiPost: g.post });
  assertEquals(g.calls.map(op), [`delete_customer ${VAULT}`], "trimmed, and the only call");
  assertEquals(out, { subscriptionsCancelled: 0, vaultDeleted: true, alreadyGone: 0 });
});

// ── "That id is already gone" counts as done ─────────────────────────────────────────────────

Deno.test("an unknown-subscription decline counts as done and the cleanup carries on", async () => {
  const g = gateway((p) => {
    if (p.subscription_id === "4000000001") throw decline("Invalid Subscription ID Specified REFID:3300000001");
  });
  const out = await cleanupTenantGateway({
    subs: [{ id: "4000000001", status: "active" }, { id: "4000000002", status: "active" }],
    vaultId: VAULT,
    nmiPost: g.post,
  });
  assertEquals(g.calls.map(op), ["delete_subscription 4000000001", "delete_subscription 4000000002", `delete_customer ${VAULT}`]);
  assertEquals(out, { subscriptionsCancelled: 2, vaultDeleted: true, alreadyGone: 1 });
});

Deno.test("NMI's documented unknown-vault sentence counts as done", async () => {
  const g = gateway((p) => {
    if (p.customer_vault) throw decline("Invalid Customer Vault Id Specified REFID:3300000002");
  });
  const out = await cleanupTenantGateway({ subs: [], vaultId: VAULT, nmiPost: g.post });
  assertEquals(out, { subscriptionsCancelled: 0, vaultDeleted: true, alreadyGone: 1 });
});

Deno.test("the gone-matcher: each object's own sentences, and nothing else", () => {
  const goneSub = [
    "Invalid Subscription ID Specified REFID:3300000003",
    "Invalid subscription_id",
    "Unknown subscription id",
    "Subscription not found",
    "Subscription ID 4000000009 not found REFID:1",
    "Subscription #4000000009 does not exist",
    "Subscription is already deleted",
    "Subscription has been cancelled",
    "No subscription found",
    "No such subscription",
  ];
  const goneVault = [
    "Invalid Customer Vault Id Specified REFID:3300000004",
    "invalid customer_vault_id",
    "Customer Vault Id 8877665544 not found",
    "Customer vault id does not exist",
  ];
  for (const t of goneSub) {
    assert(gatewaySaysGone("subscription", decline(t)), `subscription should read as gone: ${t}`);
    assert(!gatewaySaysGone("vault", decline(t)), `a SUBSCRIPTION sentence must not satisfy the vault step: ${t}`);
  }
  for (const t of goneVault) {
    assert(gatewaySaysGone("vault", decline(t)), `vault should read as gone: ${t}`);
    assert(!gatewaySaysGone("subscription", decline(t)), `a VAULT sentence must not satisfy a subscription step: ${t}`);
  }
});

// ── Anything else fails CLOSED ───────────────────────────────────────────────────────────────

const NOT_GONE = [
  "Specified API key not found REFID:3300000020", // real, 2026-10-05: a wrong key says "not found" too
  "Authentication Failed", // real, 2026-10-05
  "Duplicate transaction REFID:3300000005", // real, in app_errors
  "Your account is not set up to use the Customer Vault. REFID:3300000021", // documented
  "Invalid subscription amount", // names the subscription, but not its id
  "Subscription plan not found", // a plan, not this subscription
  "Customer Vault not found", // the account's vault feature, not this id
  "Transaction was rejected by gateway",
  "transaction declined",
  "",
];

Deno.test("any other decline throws, before the vault, with the progress so far", async () => {
  for (const text of NOT_GONE) {
    assert(!gatewaySaysGone("subscription", decline(text)) && !gatewaySaysGone("vault", decline(text)), `must not read as gone: "${text}"`);
    const g = gateway((p) => {
      if (p.subscription_id === "4000000002") throw decline(text);
    });
    const e = await rejects(() =>
      cleanupTenantGateway({
        subs: [{ id: "4000000001", status: "active" }, { id: "4000000002", status: "active" }, { id: "4000000003", status: "active" }],
        vaultId: VAULT,
        nmiPost: g.post,
      }), `"${text}"`);
    assertEquals(g.calls.map(op), ["delete_subscription 4000000001", "delete_subscription 4000000002"], `stops at the decline: "${text}"`);
    assertEquals(e.step, "delete_subscription");
    assertEquals(e.unknown, false);
    assertEquals(e.progress, { subscriptionsCancelled: 1, vaultDeleted: false, alreadyGone: 0 }, "progress is what really happened");
    assertEquals(e.said, text || "no reason given");
  }
});

Deno.test("a vault decline throws too, after the subscriptions went", async () => {
  const g = gateway((p) => {
    if (p.customer_vault) throw decline("Your account is not set up to use the Customer Vault. REFID:3300000021");
  });
  const e = await rejects(() =>
    cleanupTenantGateway({ subs: [{ id: "4000000001", status: "active" }], vaultId: VAULT, nmiPost: g.post }), "vault decline");
  assertEquals(e.step, "delete_customer");
  assertEquals(e.progress, { subscriptionsCancelled: 1, vaultDeleted: false, alreadyGone: 0 });
});

Deno.test("GATEWAY_UNKNOWN throws as unknown, even when its text sounds like 'gone'", async () => {
  for (const text of ["connection reset", "gateway returned HTTP 502", "Subscription not found", "Invalid Customer Vault Id"]) {
    assert(!gatewaySaysGone("subscription", noAnswer(text)) && !gatewaySaysGone("vault", noAnswer(text)), `no answer is not an answer: ${text}`);
    const g = gateway(() => {
      throw noAnswer(text);
    });
    const e = await rejects(() =>
      cleanupTenantGateway({ subs: [{ id: "4000000001", status: "active" }], vaultId: VAULT, nmiPost: g.post }), text);
    assertEquals(e.unknown, true);
    assertEquals(e.progress, { subscriptionsCancelled: 0, vaultDeleted: false, alreadyGone: 0 });
    assertEquals(g.calls.length, 1, "the vault is never attempted after an unanswered subscription delete");
  }
  // And on the vault step itself.
  const g = gateway((p) => {
    if (p.customer_vault) throw noAnswer("timed out");
  });
  const e = await rejects(() => cleanupTenantGateway({ subs: [], vaultId: VAULT, nmiPost: g.post }), "vault no answer");
  assertEquals([e.step, e.unknown, e.progress.vaultDeleted], ["delete_customer", true, false]);
});

// ── The vault id never leaves ────────────────────────────────────────────────────────────────

Deno.test("the vault id is scrubbed from every refusal, even if the gateway echoes it", async () => {
  const g = gateway((p) => {
    if (p.customer_vault) throw decline(`Customer Vault ${VAULT} is locked (${VAULT})`);
  });
  const e = await rejects(() => cleanupTenantGateway({ subs: [], vaultId: VAULT, nmiPost: g.post }), "echo");
  assert(!e.message.includes(VAULT) && !e.said.includes(VAULT), `the vault id leaked: ${e.message}`);
  assert(e.said.includes("[saved card]"), e.said);
  // The result type has no room for it either.
  const ok = await cleanupTenantGateway({ subs: [], vaultId: VAULT, nmiPost: gateway().post });
  assert(!JSON.stringify(ok).includes(VAULT));
});

// ── The mirror-row hook ──────────────────────────────────────────────────────────────────────

Deno.test("a failing onCancelled never stops the cleanup: the gateway step already happened", async () => {
  const g = gateway();
  const out = await cleanupTenantGateway({
    subs: [{ id: "4000000001", status: "active" }, { id: "4000000002", status: "active" }],
    vaultId: VAULT,
    nmiPost: g.post,
    onCancelled: () => {
      throw new Error("database unavailable");
    },
  });
  assertEquals(g.calls.length, 3);
  assertEquals(out, { subscriptionsCancelled: 2, vaultDeleted: true, alreadyGone: 0 });
});

Deno.test("onCancelled is called for an already-gone subscription too, and never for a refused one", async () => {
  const marked: string[] = [];
  const g = gateway((p) => {
    if (p.subscription_id === "4000000001") throw decline("Subscription not found");
    if (p.subscription_id === "4000000002") throw decline("transaction declined");
  });
  await rejects(() =>
    cleanupTenantGateway({
      subs: [{ id: "4000000001", status: "active" }, { id: "4000000002", status: "active" }],
      vaultId: null,
      nmiPost: g.post,
      onCancelled: (id) => { marked.push(id); },
    }), "second refused");
  assertEquals(marked, ["4000000001"]);
});

// ── The vault-row hook ───────────────────────────────────────────────────────────────────────
//
// onVaultDeleted lets the caller drop the row holding the vault id the moment the card is gone, so
// a delete that fails further down leaves no dead vault id behind (a card "on file" that the gateway
// no longer holds) and a retry has nothing to send to the gateway again.

Deno.test("onVaultDeleted runs once, after the vault call, for removed AND already-gone", async () => {
  for (const answer of [() => {}, () => { throw decline("Invalid Customer Vault Id Specified REFID:3300000011"); }]) {
    const order: string[] = [];
    const g = gateway((p) => {
      order.push(op(p));
      if (p.customer_vault) answer();
    });
    const out = await cleanupTenantGateway({
      subs: [{ id: "4000000001", status: "active" }],
      vaultId: VAULT,
      nmiPost: g.post,
      onCancelled: (id) => { order.push(`marked ${id}`); },
      onVaultDeleted: () => { order.push("vault row dropped"); },
    });
    assertEquals(order, ["delete_subscription 4000000001", "marked 4000000001", `delete_customer ${VAULT}`, "vault row dropped"]);
    assert(out.vaultDeleted);
  }
});

Deno.test("onVaultDeleted never runs when the vault was refused, unanswered or absent", async () => {
  for (const answer of [() => { throw decline("Your account is not set up to use the Customer Vault"); }, () => { throw noAnswer(); }]) {
    let dropped = 0;
    const g = gateway((p) => { if (p.customer_vault) answer(); });
    await rejects(() =>
      cleanupTenantGateway({ subs: [], vaultId: VAULT, nmiPost: g.post, onVaultDeleted: () => { dropped++; } }), "vault refused");
    assertEquals(dropped, 0, "the row must outlive a card the gateway still holds");
  }
  // A refused subscription stops before the vault, so the hook never runs either.
  let dropped = 0;
  const g = gateway((p) => { if (p.recurring) throw decline("transaction declined"); });
  await rejects(() =>
    cleanupTenantGateway({ subs: [{ id: "4000000001", status: "active" }], vaultId: VAULT, nmiPost: g.post, onVaultDeleted: () => { dropped++; } }),
    "subscription refused");
  assertEquals([dropped, g.calls.length], [0, 1]);
  // No vault id, nothing to drop.
  let none = 0;
  await cleanupTenantGateway({ subs: [{ id: "4000000001", status: "active" }], vaultId: null, nmiPost: gateway().post, onVaultDeleted: () => { none++; } });
  assertEquals(none, 0);
});

Deno.test("a failing onVaultDeleted never fails the cleanup: the card is gone either way", async () => {
  const out = await cleanupTenantGateway({
    subs: [],
    vaultId: VAULT,
    nmiPost: gateway().post,
    onVaultDeleted: () => Promise.reject(new Error("database unavailable")),
  });
  assertEquals(out, { subscriptionsCancelled: 0, vaultDeleted: true, alreadyGone: 0 });
});
