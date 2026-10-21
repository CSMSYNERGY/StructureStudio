// delete_client since Track G part 2 (2026-10-21, migration 321), driven through the shipped handler:
// a dry run of tenant_purge, the customer-data export, the gateway and Twilio steps, ONE purge, the
// recursive storage sweep, then Resend and QuickBooks, and a report of everything. Ahsan's retention
// answers: customer data is exported, then deleted; money and signed records are kept forever; SMS
// consent is kept; the id is blocked for good; nothing on our parent Twilio account is released
// automatically. Each mistake here is quiet:
//
//   1. Customer data deleted without its export: a failed upload, or a database without 321, must
//      refuse with NOTHING deleted, before the gateway or Twilio are touched.
//   2. A purge the database refused, reported as a delete; the export's link lost with it.
//   3. Files the export could not take swept anyway (lost), or files below the first folder left
//      behind by a one-level sweep.
//   4. Resend domains and QuickBooks removed before the purge committed, a domain another builder
//      also uses removed, or an id or token in the response.
//   5. A builder's numbers on our parent Twilio account dropped from our records without the
//      operator being told which numbers to release.
//   6. A count that failed read as "nothing there".
//
// Harness: deleteClientHarness.ts. Tenants, ids and keys are made up (the repo is public).

import { assert, assertEquals } from "jsr:@std/assert";
import { deleteClient, loadAdminCatalog, TENANT } from "./deleteClientHarness.ts";

const HANDLER = await loadAdminCatalog(true);
const at = (log: string[], line: string) => {
  const i = log.indexOf(line);
  assert(i >= 0, `"${line}" is not in the log:\n${log.join("\n")}`);
  return i;
};

Deno.test("dry run, export, then ONE purge, then a recursive sweep; the report names what stayed", async () => {
  const r = await deleteClient(HANDLER, {
    subs: [],
    vault: null,
    exportRows: { crm_contacts: [{ id: 1, client_id: TENANT, name: "Ann" }, { id: 2, client_id: TENANT, name: "Bo" }] },
    files: { "customer-uploads": ["c1/site.jpg"], "floor-plans": ["plan.png", "deep/a/b.png"], signatures: ["sig.png"] },
    purge: { purged: { crm_contacts: 2, tenant_setup_items: 25, client_configs: 1 }, passes: 2 },
    retained: { orders: 2, design_acceptances: 1 },
  });
  assertEquals(r.status, 200, r.raw);
  const dry = at(r.log, "db rpc tenant_purge (dry run)");
  const upload = at(r.log, "storage upload tenant-exports");
  const purge = at(r.log, "db rpc tenant_purge");
  assert(dry < upload && upload < purge, "the dry run, then the export, then the purge");
  assertEquals(r.uploads.length, 1);
  assert(r.uploads[0].path.startsWith(`${TENANT}/`) && r.uploads[0].opts?.contentType === "application/zip", JSON.stringify(r.uploads[0]));
  assertEquals(r.body.export.rows, 2);
  assertEquals(r.body.export.files, 1, "the customer upload is in the ZIP");
  assert(/^https:\/\/storage\.test\/sign\/tenant-exports\//.test(r.body.export.url), r.body.export.url);
  assertEquals(r.body.deleted.crm_contacts, 2);
  assertEquals(r.body.deleted.client_configs, 1);
  assertEquals(r.removed["floor-plans"]?.sort(), [`${TENANT}/deep/a/b.png`, `${TENANT}/plan.png`], "files below the first folder go too");
  assertEquals(r.removed["customer-uploads"], [`${TENANT}/c1/site.jpg`], "exported, then swept");
  assertEquals(r.removed.signatures, undefined, "signature images are kept");
  assertEquals(r.body.deleted.storage_files, 3);
  assertEquals(r.body.retained, { orders: 2, design_acceptances: 1 });
  assertEquals(r.body.files, { retained: ["signatures"] }, "only the kept bucket still holds files");
  assert(!("leftBehind" in r.body) && !("cleanup" in r.body) && !("notCounted" in r.body), r.raw);
  assert(/ export=acme-sheds\/[^ ]+\.zip /.test(r.audits.at(-1).note) && !r.audits.at(-1).note.includes("token="), r.audits.at(-1).note);
});

Deno.test("no export, no delete: a failed upload refuses with nothing deleted, before the gateway", async () => {
  const r = await deleteClient(HANDLER, {
    subs: [{ id: "4200000001", status: "active" }], vault: "7766554433",
    exportRows: { sms_messages: [{ id: 1, client_id: TENANT, body: "hi" }] },
    uploadError: "The resource was not found",
  });
  assertEquals(r.status, 502, r.raw);
  assertEquals(r.body.error, "The export of this builder's customer data could not be saved (export: could not save the file (The resource was not found)), so nothing was deleted.");
  assertEquals([r.wipes, r.gatewayCalls.length, r.purges.map((p) => p.p_dry_run)], [[], 0, [true]], "only the dry run ran");
});

Deno.test("a database without migration 321 refuses at the dry run, before the export and the gateway", async () => {
  const r = await deleteClient(HANDLER, { subs: [{ id: "4200000001", status: "active" }], vault: null, purge: { missing: true } });
  assertEquals(r.status, 503, r.raw);
  assert(/migration 321\), so nothing was deleted\.$/.test(r.body.error), r.body.error);
  assertEquals([r.wipes, r.gatewayCalls.length, r.uploads.length], [[], 0, 0]);
  const failing = await deleteClient(HANDLER, { subs: [], vault: null, purge: { dryError: "canceling statement due to statement timeout" } });
  assertEquals(failing.status, 500, failing.raw);
  assertEquals([failing.wipes, failing.uploads.length], [[], 0]);
});

Deno.test("a purge the database refuses deletes nothing, says so, and still hands over the export", async () => {
  const r = await deleteClient(HANDLER, {
    subs: [], vault: null,
    exportRows: { crm_contacts: [{ id: 1, client_id: TENANT }] },
    purge: { error: 'tenant_purge: acme-sheds was not purged (nothing deleted): still referenced from {crm_contacts}' },
  });
  assertEquals(r.status, 500, r.raw);
  assert(/^The database refused the delete \(tenant_purge: .*\), so none of this builder's data was deleted\.$/.test(r.body.error), r.body.error);
  assertEquals(r.wipes, []);
  assert(r.body.export?.url, "the export's link is lost with the refusal");
  assertEquals(Object.keys(r.removed), [], "nothing was swept");
});

Deno.test("files too big for the export are KEPT, not swept, and named", async () => {
  const r = await deleteClient(HANDLER, {
    subs: [], vault: null,
    files: { "customer-uploads": ["video.mov"], branding: ["logo.png"] },
    fileSize: 50 * 1024 * 1024,
  });
  assertEquals(r.status, 200, r.raw);
  assertEquals(r.removed["customer-uploads"], undefined, "a file the export could not take was swept");
  assertEquals(r.removed.branding, [`${TENANT}/logo.png`]);
  assertEquals(r.body.files, { leftBehind: ["customer-uploads"], notExported: ["customer-uploads"] });
});

Deno.test("Resend domains and QuickBooks go AFTER the purge, reported by name, with no id or token", async () => {
  const settings = { resend_domain_id: "rs-dom-0001", resend_inbound_domain_id: "rs-dom-0002", qbo_realm_id: "9000000001", qbo_connected_at: "2026-09-01T00:00:00Z", qbo_refresh_token: "rt-not-a-real-token" };
  const r = await deleteClient(HANDLER, { subs: [], vault: null, settings });
  assertEquals(r.status, 200, r.raw);
  assertEquals(r.outsideCalls, ["DELETE /domains/rs-dom-0001", "DELETE /domains/rs-dom-0002", "POST developer.api.intuit.com/v2/oauth2/tokens/revoke"]);
  const purge = at(r.log, "db rpc tenant_purge");
  assert(r.log.findIndex((l) => l.startsWith("out ")) > purge, "a provider call came before the purge committed");
  assertEquals(r.body.cleanup, { done: ["resend_domain", "resend_inbound_domain", "quickbooks"] });
  for (const secret of ["rs-dom-0001", "rs-dom-0002", "9000000001", "rt-not-a-real-token"]) assert(!r.raw.includes(secret), `the response carries ${secret}`);

  const shared = await deleteClient(HANDLER, { subs: [], vault: null, settings: { resend_domain_id: "rs-dom-0001" }, sharedDomain: 1 });
  assertEquals([shared.outsideCalls, "cleanup" in shared.body], [[], false], "a domain another builder names is not ours to remove");
  const refused = await deleteClient(HANDLER, { subs: [], vault: null, settings, resendStatus: 500, qboRevokeStatus: 400 });
  assertEquals(refused.status, 200, refused.raw);
  assertEquals(refused.body.cleanup, { failed: ["resend_domain", "resend_inbound_domain", "quickbooks"] }, "a provider refusal is a failed step, and the delete still finishes");
  const disconnected = await deleteClient(HANDLER, { subs: [], vault: null, settings: { qbo_realm_id: "9000000001", qbo_connected_at: null } });
  assertEquals([disconnected.outsideCalls, "cleanup" in disconnected.body], [[], false], "a realm left from a disconnect is not a live connection");
});

Deno.test("numbers on our parent Twilio account are a step by hand, WITH the numbers; a closed sub-account's are not", async () => {
  const parent = await deleteClient(HANDLER, {
    subs: [], vault: null,
    parentNumbers: ["+15550100001", "+15550100002"],
    a2p: { brand_sid: "BN" + "0".repeat(32), campaign_sid: null },
    twilio: { row: { kind: "parent", status: "active", account_sid: null } },
  });
  assertEquals(parent.status, 200, parent.raw);
  assertEquals(parent.body.cleanup.byHand, ["twilio_numbers", "twilio_a2p"]);
  assertEquals(parent.body.cleanup.numbers, ["+15550100001", "+15550100002"]);
  assertEquals(parent.body.cleanup.a2p, { brandSid: "BN" + "0".repeat(32), campaignSid: null });
  const sub = await deleteClient(HANDLER, {
    subs: [], vault: null,
    parentNumbers: ["+15550100001"],
    twilio: { row: { kind: "sub", status: "active", account_sid: "AC" + "1".repeat(32) } },
  });
  assertEquals(sub.status, 200, sub.raw);
  assertEquals(sub.body.twilio, { closed: true });
  assert(!("cleanup" in sub.body), "a closed sub-account released its own numbers");
});

Deno.test("a count that fails is named, never read as zero", async () => {
  const r = await deleteClient(HANDLER, { subs: [], vault: null, countErrors: ["crm_contacts", "orders"], retained: { sms_messages: 4 } });
  assertEquals(r.status, 200, r.raw);
  assertEquals([...r.body.notCounted].sort(), ["crm_contacts", "orders"]);
  assertEquals(r.body.leftBehind, { sms_messages: 4 }, "rows the purge did not take are reported");
});
