// What delete_client REPORTS, driven through the shipped handler (2026-10-21, board item
// "delete_client leaves 7 per-tenant tables behind, including crm_contacts").
//
// The delete itself did not change that day; what changed is that it now says, from the tenant
// data registry (_shared/tenantTables.ts), everything that outlived it. Each mistake here is quiet,
// because a report that leaves something out still looks like a clean delete:
//
//   1. A table outside the old hand-kept lists (tenant_setup_items, electrical_items, which
//      seed-test-electrical left behind on 10-13) missing from `leftBehind`.
//   2. A signed record (design_acceptances) reported as left behind instead of retained.
//   3. A count that failed read as "nothing there". It is named in `notCounted`.
//   4. Files still under the builder's folder (a bucket the sweep does not cover, sub-folders the
//      one-level sweep cannot remove, a sweep that stopped) not reported.
//   5. What is still connected outside the database (Resend domains, QuickBooks, numbers on our
//      parent Twilio account) not named, or named with an id.
//
// Harness: deleteClientHarness.ts. Tenants and ids are made up (the repo is public).

import { assert, assertEquals } from "jsr:@std/assert";
import { deleteClient, loadAdminCatalog } from "./deleteClientHarness.ts";

const HANDLER = await loadAdminCatalog(true);

Deno.test("every tenant table counts: setup tables left behind, signed records retained", async () => {
  const r = await deleteClient(HANDLER, {
    subs: [],
    vault: null,
    retained: { tenant_setup_items: 25, electrical_items: 7, crm_contacts: 8, design_acceptances: 2, commission_entries: 1, invoice_sends: 3 },
  });
  assertEquals(r.status, 200, r.raw);
  assertEquals(r.body.retained, { invoice_sends: 3, design_acceptances: 2, commission_entries: 1 });
  assertEquals(r.body.leftBehind, { tenant_setup_items: 25, electrical_items: 7, crm_contacts: 8 });
  assert(!("cleanup" in r.body) && !("files" in r.body) && !("notCounted" in r.body), r.raw);
});

Deno.test("a count that fails is named, never read as zero", async () => {
  const r = await deleteClient(HANDLER, { subs: [], vault: null, countErrors: ["crm_contacts", "orders"], retained: { sms_messages: 4 } });
  assertEquals(r.status, 200, r.raw);
  assertEquals([...r.body.notCounted].sort(), ["crm_contacts", "orders"]);
  assertEquals(r.body.leftBehind, { sms_messages: 4 });
});

Deno.test("files: swept buckets empty out; the rest are reported, signatures as retained", async () => {
  const r = await deleteClient(HANDLER, {
    subs: [],
    vault: null,
    storage: { branding: 2, "floor-plans": 3, fixtures: 1, "inventory-photos": 4, signatures: 2, "pm-attachments": 9 },
    folders: ["fixtures"],
  });
  assertEquals(r.status, 200, r.raw);
  assertEquals(r.body.deleted.storage_files, 5, "branding and floor-plans were swept");
  assertEquals(r.body.files, { retained: ["signatures"], leftBehind: ["fixtures", "inventory-photos"] },
    "fixtures held only sub-folders the one-level sweep cannot remove; inventory-photos is not swept");
  assert(!r.log.includes("storage list pm-attachments"), "a global bucket was looked at per builder");
});

Deno.test("a sweep or a check that cannot list is a failed step, and the delete still finishes", async () => {
  const r = await deleteClient(HANDLER, { subs: [], vault: null, failList: ["branding", "models"] });
  assertEquals(r.status, 200, r.raw);
  assertEquals(r.body.cleanup, { failed: ["storage:branding", "storage:models"] });
  assert(r.wipes.includes("client_configs"));
});

Deno.test("what is still connected outside the database is named, with no id", async () => {
  const r = await deleteClient(HANDLER, {
    subs: [],
    vault: null,
    settings: { resend_domain_id: "rs-dom-0001", resend_inbound_domain_id: "rs-dom-0002", qbo_realm_id: "9000000001", qbo_connected_at: "2026-09-01T00:00:00Z" },
    retained: { sms_numbers: 1 },
  });
  assertEquals(r.status, 200, r.raw);
  assertEquals(r.body.cleanup, { byHand: ["resend_domain", "resend_inbound_domain", "quickbooks", "twilio_numbers"] });
  for (const id of ["rs-dom-0001", "rs-dom-0002", "9000000001"]) assert(!r.raw.includes(id), `the response carries ${id}`);
  // A realm left from a disconnect is not a live connection.
  const gone = await deleteClient(HANDLER, { subs: [], vault: null, settings: { qbo_realm_id: "9000000001", qbo_connected_at: null } });
  assert(!("cleanup" in gone.body), gone.raw);
});

Deno.test("numbers on our parent Twilio account are a step by hand; a closed sub-account is not", async () => {
  // A sub-account with numbers refuses the delete (twilioClosePlan), so after a close there are none.
  const sub = await deleteClient(HANDLER, {
    subs: [],
    vault: null,
    twilio: { row: { kind: "sub", status: "active", account_sid: "AC" + "1".repeat(32) } },
  });
  assertEquals(sub.status, 200, sub.raw);
  assertEquals(sub.body.twilio, { closed: true });
  assert(!("cleanup" in sub.body), sub.raw);
  const parent = await deleteClient(HANDLER, {
    subs: [],
    vault: null,
    retained: { sms_numbers: 2 },
    twilio: { row: { kind: "parent", status: "active", account_sid: null } },
  });
  assertEquals(parent.status, 200, parent.raw);
  assert(!("twilio" in parent.body), parent.raw);
  assertEquals(parent.body.leftBehind, { sms_numbers: 2 });
  assertEquals(parent.body.cleanup, { byHand: ["twilio_numbers"] });
});
