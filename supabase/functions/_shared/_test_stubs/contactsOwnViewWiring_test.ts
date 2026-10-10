// contacts:'own_view' (2026-10-06, migration 286: own customers, view only), pinned against the
// SHIPPED gate tables and narrowing calls.
//
// "View only" is not a check anybody wrote: it is canEdit() saying no to own_view, met at every
// contacts:'edit' gate. So the property worth pinning is that every customer-record write really
// sits behind one — the contact editor, notes, activities, texts, emails, consent and files in
// portal-settings, and the opt-out switch in portal-sms — and that each of those gates refuses an
// own_view caller while the reads they need still open. The narrowing half is the same story the
// other way round: every edge reader and the phone Worker must ask ownContactsOnly(), never the
// literal 'own', or an own_view person reads the whole customer list there.
//
// Same technique as designRowScopeWiring_test: read the source, so a drift fails the push. If an
// anchor moves, re-point it — do not delete the test.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { checkGate, effectiveAccess, type Gate } from "../access.ts";

const read = (p: string) => Deno.readTextFile(new URL(p, import.meta.url)).then((s) => s.replace(/\r\n/g, "\n"));
const SETTINGS = await read("../../portal-settings/index.ts");
const SMS = await read("../../portal-sms/index.ts");
const SCHEDULE = await read("../../portal-schedule/index.ts");
const WORKER_PUSH = await read("../../../../workers/phone-api/src/routes/push.ts");
const WORKER_SCOPE = await read("../../../../workers/phone-api/src/scope.ts");
const WORKER_DB = await read("../../../../workers/phone-api/src/db.ts");

/** Source with whole-line `//` comments removed, so a comment that NAMES a call cannot pass. */
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

/** The `const GATES: GateTable = { ... };` block of one function, evaluated into a table. */
function gates(src: string, fn: string): Record<string, Gate> {
  const start = src.indexOf("const GATES: GateTable = {");
  const end = start < 0 ? -1 : src.indexOf("\n};", start);
  if (start < 0 || end < 0) throw new Error(`contactsOwnViewWiring_test: ${fn}'s GATES table moved (start=${start}, end=${end}) — re-point it`);
  const body = code(src.slice(start + "const GATES: GateTable = ".length, end + 2));
  return new Function(`return (${body.replace(/;\s*$/, "")});`)() as Record<string, Gate>;
}

const OWN_VIEW = effectiveAccess("user", "sales_rep", { contacts: "own_view" });
const OWN = effectiveAccess("user", "sales_rep", { contacts: "own" });

const isContactsEdit = (g: Gate) => typeof g === "object" && "area" in g && g.area === "contacts" && g.level === "edit";

// Every customer-record write the decision names (Carolyn's default for "view only", 2026-10-06).
const SETTINGS_WRITES = [
  "crm_save_contact", "crm_create_contact", "crm_save_note", "crm_delete_note", "crm_save_activity",
  "crm_complete_activity", "crm_send_email", "crm_send_sms", "crm_record_consent", "crm_file_sign",
  "crm_file_attach", "crm_file_delete", "crm_import_ghl_contacts",
  // Sales pipelines (migration 301): a lead and its deal are customer-record writes, so a
  // view-only person adds and moves nothing.
  "crm_create_lead", "crm_deal_create", "crm_deal_update", "crm_deal_move", "crm_deal_archive",
];

Deno.test("portal-settings: every customer-record write is a contacts:'edit' gate, and own_view fails each one", () => {
  const g = gates(SETTINGS, "portal-settings");
  for (const action of SETTINGS_WRITES) {
    assert(g[action], `${action} is no longer in portal-settings' GATES — re-point this test`);
    assert(isContactsEdit(g[action]), `${action} is not gated contacts:'edit' any more, so own_view would not stop it`);
    assertEquals(checkGate(g[action], OWN_VIEW), "Your access does not let you change Contacts. Ask an owner or admin.", action);
    assertEquals(checkGate(g[action], OWN), null, `${action}: 'own' (Own · Edit) must still pass`);
  }
  // And the table holds no contacts:'edit' write this list does not know about.
  const all = Object.entries(g).filter(([, v]) => isContactsEdit(v)).map(([k]) => k).sort();
  assertEquals(all, [...SETTINGS_WRITES].sort(), "a new contacts:'edit' action: add it here after deciding it is a customer-record write");
});

Deno.test("portal-settings: the reads an own_view person needs still open", () => {
  const g = gates(SETTINGS, "portal-settings");
  for (const action of ["crm_record", "crm_feed", "crm_inbox", "crm_pipelines_list", "crm_deals_list", "crm_contact_deals"]) {
    assertEquals(checkGate(g[action], OWN_VIEW), null, `${action} refused own_view — they could not see their own customers`);
  }
});

Deno.test("portal-sms: the opt-out switch refuses own_view; the list it reads does not", () => {
  const g = gates(SMS, "portal-sms");
  assert(isContactsEdit(g.set_opt_out), "set_opt_out is not gated contacts:'edit' any more");
  assert(checkGate(g.set_opt_out, OWN_VIEW) !== null, "own_view can change a texting opt-out");
  assertEquals(checkGate(g.opt_outs, OWN_VIEW), null);
});

Deno.test("every edge reader narrows through ownContactsOnly(), never the literal 'own'", () => {
  assert(/const ownContacts = ownContactsOnly\(access\);/.test(code(SETTINGS)), "portal-settings' row scope no longer comes from ownContactsOnly");
  assert(/ownContactsOnly\(r\.ctx\.access\)/.test(code(SMS)), "portal-sms no longer asks ownContactsOnly");
  assert(/ownContactsOnly\(r\.ctx\.access\)/.test(code(SCHEDULE)), "portal-schedule no longer asks ownContactsOnly");
  for (const [name, src] of [["portal-settings", SETTINGS], ["portal-sms", SMS], ["portal-schedule", SCHEDULE]] as const) {
    assert(!/contacts\s*===?\s*["']own["']/.test(code(src)), `${name} compares the contacts level to 'own' literally — own_view would read everyone there`);
  }
});

Deno.test("the phone Worker keeps own_view and narrows it", () => {
  assert(/ownContactsOnly\(\{ contacts: lvl \}\)/.test(code(WORKER_PUSH)), "push.ts no longer asks ownContactsOnly for text alerts");
  assert(!/lvl === "own"/.test(code(WORKER_PUSH)), "push.ts compares the contacts level to 'own' literally again");
  assert(/lvl === "own_view"/.test(code(WORKER_SCOPE)), "scope.ts contactsLevelOf drops own_view");
  assert(/contacts_level: normContactsLevel\(data\.contacts_level\)/.test(code(WORKER_DB)), "db.ts maps own_view to 'none'");
});
