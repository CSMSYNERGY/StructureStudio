// delete_client at the payment gateway, driven through the SHIPPED admin-catalog handler with the
// gateway configured (2026-10-05, "NMI card cleanup when a tenant is deleted").
//
// WHY THIS EXISTS. Deleting a builder used to wipe only our MIRRORS of their billing: their
// subscriptions kept charging their card at Deposyt/NMI and the card stayed in the gateway's vault,
// with no local row left to show either. And their wallet balance survived, so a recreated slug
// inherited it. Every mistake worth pinning here is quiet:
//
//   1. A gateway call moved below a wipe, so a refused cancellation leaves a half-deleted tenant who
//      is still being charged.
//   2. A refusal that wipes anything at all. It must refuse with NOTHING deleted, and say what did
//      happen at the gateway before it stopped (that part cannot be undone).
//   3. The vault id reaching the response or an audit note. It is a bearer capability for charging
//      that card.
//   4. Touching an id that is not this tenant's own (the gateway is shared with other products), a
//      cancelled subscription being cancelled again, or a vault another builder still uses being
//      deleted.
//   5. tax_code_assignments losing its place as the first wipe (taxCodesWiring_test), wallet_accounts
//      or client_feature_grants not being wiped (a recreated slug inherited the balance and a comped
//      view_3d), or wallet_transactions / usage_charges not being reported as retained.
//   6. The billing_customers row outliving the card. A wipe that throws after the gateway step leaves
//      the tenant alive; a vault id still on it shows a card on file the gateway no longer holds,
//      and the retry asks the gateway to delete it again.
//   7. The tenant's CRM, phone, text, email and customer-login rows outliving it UNREPORTED. Wiping
//      them is a retention call nobody has made, so they are counted as `leftBehind`.
//
// The unconfigured gateway is deleteClientGatewayUnconfigured_test.ts (nmi.ts reads its keys at
// load, so it needs its own module instance). The decision rules are tenantGatewayCleanup.test.ts.
// The harness is deleteClientHarness.ts.

import { assert, assertEquals } from "jsr:@std/assert";
import { deleteClient, firstWipe, loadAdminCatalog, SECURITY_KEY, TENANT } from "./deleteClientHarness.ts";
import { COUNTED_AFTER_DELETE, RETAINED_TABLES, TENANT_TABLES } from "../tenantTables.ts";

const HANDLER = await loadAdminCatalog(true);

const VAULT = "7766554433";
const SUBS = [
  { id: "4200000001", status: "active" },
  { id: "4200000002", status: "cancelled" },
  { id: "4200000003", status: "past_due" },
];
const ok = "response=1&responsetext=OK&response_code=100";
const declined = (text: string) => `response=3&responsetext=${encodeURIComponent(text)}&response_code=300`;

// ─── Behaviour ─────────────────────────────────────────────────────────────────────────────────

Deno.test("a builder with nothing at the gateway: zero gateway calls, one purge, ledgers reported", async () => {
  for (const subs of [[], [{ id: "4200000009", status: "cancelled" }]]) {
    const r = await deleteClient(HANDLER, {
      subs,
      vault: null,
      purge: { purged: { wallet_accounts: 1, tax_code_assignments: 2, client_feature_grants: 1, client_configs: 1 }, passes: 2 },
      // The harness's counts are static, so these also show what a purge that LEFT rows looks like.
      retained: { wallet_transactions: 2, usage_charges: 5, orders: 1, crm_contacts: 8, customer_sessions: 3 },
    });
    assertEquals(r.status, 200, r.raw);
    assertEquals(r.gatewayCalls, [], "nothing to do at the gateway, so it is never called");
    assertEquals(r.purges.map((p) => p.p_dry_run), [true, false], "a dry run, then the purge");
    for (const p of r.purges) assertEquals(p.p_keep, RETAINED_TABLES, "the keep list is the registry's");
    assertEquals(r.wipes, ["tenant_purge"], "the purge deletes; delete_client deletes no table itself");
    assertEquals(r.body.deleted.wallet_accounts, 1);
    assertEquals(r.body.deleted.client_feature_grants, 1);
    assertEquals(r.body.deleted.client_configs, 1);
    assertEquals(r.body.retained, { orders: 1, wallet_transactions: 2, usage_charges: 5 }, "money that moved is kept and reported");
    assertEquals(r.body.leftBehind, { crm_contacts: 8, customer_sessions: 3 }, "anything that survived the purge is reported");
    assertEquals(r.body.gateway, { subscriptionsCancelled: 0, vaultDeleted: false, alreadyGone: 0 });
    assertEquals(r.audits.length, 2, "the gateway's audit row, then the purge's");
    assertEquals(r.audits.map((a) => [a.action, a.target_client_id]), [["delete_client", TENANT], ["delete_client", TENANT]]);
    assert(/^via=password gateway none subscriptions_cancelled=0 of 0 vault_deleted=false already_gone=0$/.test(r.audits[0].note), r.audits[0].note);
    assert(/^via=password purge passes=2 rows=5 kept=8 export=none tax_charges_closed=0$/.test(r.audits[1].note), r.audits[1].note);
  }
});

Deno.test("nothing left behind: neither `retained` nor `leftBehind` is in the response", async () => {
  const r = await deleteClient(HANDLER, { subs: [], vault: null });
  assertEquals(r.status, 200, r.raw);
  assert(!("retained" in r.body) && !("leftBehind" in r.body), r.raw);
});

Deno.test("open subscriptions, then the vault, ALL before the first wipe, and only this tenant's ids", async () => {
  const r = await deleteClient(HANDLER, { subs: SUBS, vault: VAULT, rows: { wallet_accounts: 1 } });
  assertEquals(r.status, 200, r.raw);
  assertEquals(r.gatewayCalls.map((c) => c.recurring ? `sub ${c.subscription_id}` : `${c.customer_vault} ${c.customer_vault_id}`), [
    "sub 4200000001",
    "sub 4200000003", // 4200000002 is already cancelled, so it is not cancelled again
    `delete_customer ${VAULT}`,
  ]);
  for (const c of r.gatewayCalls) {
    assertEquals(c.security_key, SECURITY_KEY, "through nmi.ts, with the configured key");
    assertEquals(Object.keys(c).length, 3, `exactly the delete's own parameters: ${JSON.stringify(Object.keys(c))}`);
  }
  const lastGateway = Math.max(...r.log.map((l, i) => (l.startsWith("gw ") ? i : -1)));
  assert(lastGateway < firstWipe(r), `a gateway call came after a wipe:\n${r.log.join("\n")}`);
  // Each mirror row is marked cancelled the moment the gateway confirms, scoped to this tenant.
  const marks = r.updates.filter((u) => u.table === "billing_subscriptions");
  assertEquals(marks.map((u) => u.filters), [
    [["eq", "id", "4200000001"], ["eq", "client_id", TENANT]],
    [["eq", "id", "4200000003"], ["eq", "client_id", TENANT]],
  ]);
  assertEquals(marks[0].payload.status, "cancelled");
  assertEquals(r.body.gateway, { subscriptionsCancelled: 2, vaultDeleted: true, alreadyGone: 0 });
  assert(/ gateway done subscriptions_cancelled=2 of 2 vault_deleted=true already_gone=0$/.test(r.audits[0].note), r.audits[0].note);
});

Deno.test("the vault id never reaches the response or an audit row", async () => {
  for (
    const gateway of [
      () => ok,
      (p: Record<string, string>) => (p.customer_vault ? declined(`Customer Vault ${VAULT} is locked`) : ok),
    ]
  ) {
    const r = await deleteClient(HANDLER, { subs: SUBS, vault: VAULT, gateway });
    assert(!r.raw.includes(VAULT), `the response carries the vault id: ${r.raw}`);
    assert(!JSON.stringify(r.audits).includes(VAULT), `an audit row carries the vault id: ${JSON.stringify(r.audits)}`);
    assert(!JSON.stringify(r.faultRows).includes(VAULT), "a fault row carries the vault id");
  }
});

Deno.test("a gateway decline refuses the delete with NOTHING wiped, and says what did happen", async () => {
  const r = await deleteClient(HANDLER, {
    subs: [{ id: "4200000001", status: "active" }, { id: "4200000003", status: "active" }],
    vault: VAULT,
    gateway: (p) => (p.subscription_id === "4200000003" ? declined("Transaction declined REFID:3300000010") : ok),
  });
  assertEquals(r.status, 502, r.raw);
  assertEquals(r.wipes, [], `something was wiped on a refusal: ${r.wipes.join(", ")}`);
  assertEquals(r.gatewayCalls.length, 2, "the vault is never attempted after a refused cancellation");
  assertEquals(
    r.body.error,
    `The payment gateway wouldn't cancel this builder's plan or remove their saved card, so nothing was deleted. It said: "Transaction declined REFID:3300000010". 1 of their 2 paid plans was cancelled at the gateway before it stopped.`,
  );
  assertEquals(r.body.gateway, { subscriptionsCancelled: 1, vaultDeleted: false, alreadyGone: 0 });
  assertEquals(r.updates.filter((u) => u.table === "billing_subscriptions").length, 1, "the plan that went is marked cancelled");
  assertEquals(r.audits.length, 1);
  assert(/ gateway refused\(declined\) subscriptions_cancelled=1 of 2 vault_deleted=false /.test(r.audits[0].note), r.audits[0].note);
  assertEquals(r.faultRows.length, 1, "a refusal is a fault row for someone to look at");
});

Deno.test("a wrong gateway key is a refusal too, even though NMI says 'not found'", async () => {
  // The real sentence NMI answered with on 2026-10-05 for a key it does not hold.
  const r = await deleteClient(HANDLER, { subs: SUBS, vault: VAULT, gateway: () => declined("Specified API key not found REFID:3300000020") });
  assertEquals([r.status, r.wipes.length, r.gatewayCalls.length], [502, 0, 1]);
});

Deno.test("no answer from the gateway: refused, nothing wiped, the operator is sent to look", async () => {
  for (
    const gateway of [
      (): string => {
        throw new TypeError("error sending request: connection reset");
      },
      () => 502,
    ]
  ) {
    const r = await deleteClient(HANDLER, { subs: SUBS, vault: VAULT, gateway });
    assertEquals(r.status, 502, r.raw);
    assertEquals(r.wipes, []);
    assertEquals(
      r.body.error,
      "The payment gateway didn't answer, so nothing was deleted. A cancellation may still have gone through: check this builder's plans in the Deposyt portal before you try again.",
    );
    assert(/ gateway refused\(no_answer\) /.test(r.audits[0].note), r.audits[0].note);
  }
});

Deno.test("a vault the gateway no longer holds counts as removed, and the delete goes ahead", async () => {
  const r = await deleteClient(HANDLER, {
    subs: [],
    vault: VAULT,
    gateway: () => declined("Invalid Customer Vault Id Specified REFID:3300000011"),
  });
  assertEquals(r.status, 200, r.raw);
  assertEquals(r.body.gateway, { subscriptionsCancelled: 0, vaultDeleted: true, alreadyGone: 1 });
  assertEquals(r.wipes, ["billing_customers", "tenant_purge"]);
});

Deno.test("the vault row goes the moment the card does, so a purge that is refused leaves no dead card on file", async () => {
  const world: Parameters<typeof deleteClient>[1] = {
    subs: [{ id: "4200000001", status: "active" }], vault: VAULT,
    purge: { error: 'update or delete on table "crm_contacts" violates foreign key constraint' },
  };
  const first = await deleteClient(HANDLER, world);
  assertEquals(first.status, 500, first.raw);
  assert(/^The database refused the delete \(.*\), so none of this builder's data was deleted\. The payment gateway step had already run \(1 paid plan cancelled, the saved card removed\)\. Delete again to finish\.$/.test(first.body.error), first.raw);
  assertEquals(first.gatewayCalls.length, 2, "the plan and the card are gone at the gateway");
  const cardCall = first.log.lastIndexOf(`gw delete_customer ${VAULT}`);
  assertEquals(first.log[cardCall + 1], "db delete billing_customers", `the vault row did not go straight after the card:\n${first.log.join("\n")}`);
  assertEquals(first.wipes, ["billing_customers"], "only the vault row went; the refused purge took nothing");
  assertEquals(world.vault, null, "no vault id is left for Billing to show as a card on file");
  assertEquals(world.subs.map((s) => s.status), ["cancelled"]);
  assert(!first.raw.includes(VAULT));

  // The operator retries: nothing is left to send to the gateway, and the delete completes.
  const retry = await deleteClient(HANDLER, { ...world, purge: {} });
  assertEquals(retry.status, 200, retry.raw);
  assertEquals(retry.gatewayCalls, [], "a retry must never ask the gateway to delete the card again");
  assertEquals(retry.body.gateway, { subscriptionsCancelled: 0, vaultDeleted: false, alreadyGone: 0 });
});

Deno.test("billing_customers is counted once: the gateway hook's delete, then the purge as the backstop", async () => {
  const r = await deleteClient(HANDLER, { subs: [], vault: VAULT, purge: { purged: {} } });
  assertEquals(r.status, 200, r.raw);
  assertEquals(r.wipes, ["billing_customers", "tenant_purge"], "the hook, then the backstop");
  assertEquals(r.body.deleted.billing_customers, 1);
});

Deno.test("a vault another builder still uses is never deleted; their plans still are", async () => {
  const r = await deleteClient(HANDLER, { subs: SUBS, vault: VAULT, sharedVault: 1 });
  assertEquals(r.status, 200, r.raw);
  assert(r.gatewayCalls.every((c) => !c.customer_vault), "delete_customer was called on a shared vault");
  assertEquals(r.gatewayCalls.length, 2);
  assertEquals(r.body.gateway, { subscriptionsCancelled: 2, vaultDeleted: false, alreadyGone: 0, vaultKept: "in use by another builder" });
  assert(/ vault_kept=shared$/.test(r.audits[0].note), r.audits[0].note);
});

// ─── Source: the shape the behaviour above depends on ──────────────────────────────────────────

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const SRC = await read("../../admin-catalog/index.ts");
/** Whole-line comments removed, so a comment that names a trap cannot trip it. */
const CODE = SRC.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");
const DEL = (() => {
  const i = CODE.indexOf('case "delete_client": {');
  const j = CODE.indexOf("\n      default:", i);
  if (i < 0 || j < 0) throw new Error("deleteClientGateway_test: delete_client block not found — re-point the anchors");
  return CODE.slice(i, j);
})();
const at = (needle: string) => {
  const i = DEL.indexOf(needle);
  assert(i >= 0, `"${needle}" not found in delete_client — re-point this test`);
  return i;
};

const PURGE_CALL = 'sb.rpc("tenant_purge", { p_client_id: clientId, p_keep: RETAINED_TABLES, p_actor: actor, p_dry_run: false })';

Deno.test("source: read, refuse-if-unconfigured, clean up, and only then purge", () => {
  const firstWipeAt = at(PURGE_CALL);
  const reads = at('sb.from("billing_subscriptions").select("id, status").eq("client_id", clientId)');
  assert(DEL.includes('sb.from("billing_customers").select("vault_id").eq("client_id", clientId).maybeSingle()'), "the vault read is not scoped to this tenant");
  const unconfigured = at("if (!nmiConfigured) {");
  const cleanup = at("await cleanupTenantGateway({");
  assert(reads < unconfigured && unconfigured < cleanup && cleanup < firstWipeAt, "the gateway step is not ahead of every wipe");
  // The one wipe inside the gateway step: the vault row, through the hook that runs only once the
  // gateway has confirmed the card is gone.
  const early = [...DEL.slice(0, firstWipeAt).matchAll(/\bwipe\("([^"]+)"\)/g)].map((m) => m[1]);
  assertEquals(early, ["billing_customers"], "a wipe runs inside the gateway step");
  assert(/onVaultDeleted: \(\) => wipe\("billing_customers"\),/.test(DEL), "the vault row is not dropped by onVaultDeleted");
  assert(at("onVaultDeleted:") > cleanup, "onVaultDeleted is not handed to cleanupTenantGateway");
  assert(/if \(!nmiConfigured\) \{\s*return json\(\{ error: "Can't reach the payment gateway; nothing was deleted\." \}, 503\);/.test(DEL),
    "the unconfigured refusal changed");
  // Every refusal returns before the purge, except the purge's own: a refused purge deleted nothing.
  const refusals = [...DEL.matchAll(/return json\(\{\s*error:/g)].map((m) => m.index!);
  const late = refusals.filter((i) => i > firstWipeAt);
  assert(refusals.length >= 4, "the refusals moved");
  assertEquals(late.length, 1, "a refusal sits below the purge, after something was deleted");
  assert(/^;\s*if \(purge\.error\) \{\s*$/.test(DEL.slice(firstWipeAt + PURGE_CALL.length, late[0])), "the one refusal after the purge call is not its own failure");
});

Deno.test("source: the dry run and the export come before anything irreversible; the purge keeps the ledgers", () => {
  // Since 2026-10-21 tenant_purge (migration 321) deletes, in one transaction, everything but
  // RETAINED_TABLES. Customer data is exported first, and a database without 321 refuses at the dry
  // run, before the gateway or Twilio are touched.
  const dry = at('sb.rpc("tenant_purge", { p_client_id: clientId, p_keep: RETAINED_TABLES, p_actor: actor, p_dry_run: true })');
  const exportAt = at("await buildTenantExport(sb, clientId, { tables: EXPORT_TABLES, buckets: EXPORTED_BUCKETS })");
  const gatewayAt = at("await cleanupTenantGateway({");
  const twilioClose = at("await closePlannedSub(");
  const purgeAt = at(PURGE_CALL);
  assert(at("await twilioClosePlan(") < dry && dry < exportAt && exportAt < gatewayAt && gatewayAt < twilioClose && twilioClose < purgeAt,
    "the order is: Twilio plan (read only), dry run, export, gateway, Twilio close, purge");
  assertEquals([...DEL.matchAll(/await wipe\("([^"]+)"\)/g)].length, 0, "delete_client deletes a table itself again");
  assertEquals([...DEL.matchAll(/\.from\("([^"]+)"\)\.delete\(/g)].map((m) => m[1]), [], "delete_client deletes a table itself again");
  for (const t of ["orders", "payments", "invoice_sends", "billing_charge_attempts", "wallet_transactions", "usage_charges", "billing_consents", "design_acceptances", "sms_consent_log"]) {
    assert(RETAINED_TABLES.includes(t), `${t} is missing from the keep list`);
  }
  for (const t of ["crm_contacts", "sms_messages", "phone_calls", "email_sends", "customer_sessions", "customer_email_otps", "tenant_setup_items"]) {
    assert(COUNTED_AFTER_DELETE.includes(t) && TENANT_TABLES[t].fate !== "retain", `${t} is purged`);
  }
  assert(/const retained = await countTenantRows\(RETAINED_TABLES\.filter\(\(t\) => t !== "deleted_clients"\)\);/.test(DEL), "retained is not counted");
  assert(/const leftBehind = await countTenantRows\(COUNTED_AFTER_DELETE\);/.test(DEL), "leftBehind is not counted");
  assert(at("countTenantRows(COUNTED_AFTER_DELETE)") > purgeAt, "leftBehind is counted before the purge");
  assert(/\.\.\.\(Object\.keys\(leftBehind\)\.length \? \{ leftBehind \} : \{\}\)/.test(DEL), "leftBehind is not in the response");
});

Deno.test("source: the vault id is never put in a response or the audit note", () => {
  for (const m of DEL.matchAll(/json\(([\s\S]*?)\);/g)) {
    assert(!/vault_id|tenantVault|vaultId/.test(m[1]), `a response carries the vault: json(${m[1]})`);
  }
  const audit = DEL.slice(at('sb.from("admin_audit").insert({'), at("best-effort: the gateway outcome"));
  assert(!/vault_id|tenantVault|vaultId/.test(audit), `the audit row carries the vault:\n${audit}`);
});

Deno.test("source: admin-catalog uses nmi.ts's client, and nmi.ts lists it as an importer", async () => {
  assert(/import \{ nmiConfigured, nmiPost \} from "\.\.\/_shared\/nmi\.ts";/.test(SRC), "admin-catalog's gateway client is not nmi.ts");
  assert(!/fetch\([^)]*transact/.test(SRC), "admin-catalog calls the gateway directly");
  const nmi = await read("../nmi.ts");
  assert(/^\/\/\s+admin-catalog\/index\.ts\s+\(delete_client/m.test(nmi), "nmi.ts's importer ledger does not list admin-catalog");
  assert(/^\/\/\s+_shared\/tenantGatewayCleanup\.ts/m.test(nmi), "nmi.ts's importer ledger does not list tenantGatewayCleanup.ts");
});
