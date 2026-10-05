// delete_client with NO payment gateway configured, driven through the SHIPPED admin-catalog
// handler (2026-10-05). The configured half, and why any of this exists, is
// deleteClientGateway_test.ts. This half lives in its own file because nmi.ts reads its keys once at
// load and each test file gets its own module instance.
//
// Two rules, both quiet if broken:
//   1. A builder with a live subscription or a saved card is NOT deleted when the gateway cannot be
//      reached: wiping them would leave the subscription charging with nothing on our side to show it.
//   2. A builder with nothing at the gateway IS still deletable. Test and demo tenants have no
//      billing at all, and a missing key must not make them undeletable.

import { assert, assertEquals } from "jsr:@std/assert";
import { deleteClient, loadAdminCatalog, TENANT } from "./deleteClientHarness.ts";

const HANDLER = await loadAdminCatalog(false);

Deno.test("an open subscription or a saved card, no gateway: 503 and nothing deleted", async () => {
  for (
    const [subs, vault] of [
      [[{ id: "4200000001", status: "active" }], null],
      [[{ id: "4200000001", status: "paused" }, { id: "4200000002", status: "cancelled" }], null],
      [[], "7766554433"],
    ] as const
  ) {
    const r = await deleteClient(HANDLER, { subs: [...subs], vault });
    assertEquals(r.status, 503, r.raw);
    assertEquals(r.body, { error: "Can't reach the payment gateway; nothing was deleted." });
    assertEquals(r.wipes, [], `wiped without a gateway: ${r.wipes.join(", ")}`);
    assertEquals(r.gatewayCalls, []);
    assertEquals(r.updates, [], "no mirror row is touched either");
    assert(!r.raw.includes("7766554433"));
  }
});

Deno.test("nothing at the gateway, no gateway needed: the builder is still deleted", async () => {
  for (const subs of [[], [{ id: "4200000002", status: "cancelled" }]]) {
    const r = await deleteClient(HANDLER, { subs, vault: null, rows: { wallet_accounts: 1 } });
    assertEquals(r.status, 200, r.raw);
    assertEquals(r.gatewayCalls, []);
    assertEquals(r.wipes.slice(0, 3), ["tax_code_assignments", "wallet_accounts", "client_feature_grants"]);
    assert(r.wipes.includes("client_configs"));
    assertEquals(r.body.gateway, { subscriptionsCancelled: 0, vaultDeleted: false, alreadyGone: 0 });
    assertEquals(r.audits.map((a) => a.target_client_id), [TENANT]);
  }
});
