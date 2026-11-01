// Self-contained on purpose: no jsr:/npm: imports, so the gate does not need a registry
// fetch and cannot fail closed on an offline machine. Preflight runs this group.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  PM_SYS_CREATED, PM_SYS_REQUESTOR, pmCreatedOn, pmDecorateItems, pmRequestorOf,
  pmSystemColumns, pmSystemValues, pmWithSystemValues,
} from "./pmSystemColumns.ts";

const names = new Map([["ahsan@csmsynergy.com", "Ahsan"], ["carolyn@csmsynergy.com", "Carolyn"]]);

Deno.test("the two columns are read-only and named the way Carolyn asked", () => {
  const cols = pmSystemColumns();
  assertEquals(cols.map((c) => c.name), ["Created", "Requestor"]);
  // `date` and `text` so the WHEN filter, sorting and search need no new cases.
  assertEquals(cols.map((c) => c.type), ["date", "text"]);
  for (const c of cols) {
    assert(c.readOnly === true, c.name + " must be read-only");
    assert(c.system === true);
    assert(c.id.startsWith("sys_"), "a reserved id cannot collide with a pm_columns uuid");
  }
});

Deno.test("created reads the row, and an imported row keeps its ORIGINAL date", () => {
  assertEquals(pmCreatedOn({ created_at: "2026-10-19T14:02:11.000Z" }), "2026-10-19");
  // The import ran on 2026-08-27; the monday item was filed in May. Reading created_at here
  // would rewrite three months of history.
  assertEquals(
    pmCreatedOn({ created_at: "2026-08-27T11:00:00.000Z", source_created_at: "2026-05-14T00:00:00.000Z" }),
    "2026-05-14",
  );
  assertEquals(pmCreatedOn({}), null);
  assertEquals(pmCreatedOn({ created_at: "not a date" }), null);
});

Deno.test("requestor: a client submission names the person, then the builder", () => {
  assertEquals(pmRequestorOf({}, { submitter_name: "Dave Hall", client_id: "junior-barns" }), "Dave Hall");
  // No name given: the email's local part, then the slug — which is what the retired
  // "Client" column held, so triage keeps reading what it read before.
  assertEquals(pmRequestorOf({}, { submitter_email: "dave@juniorbarns.com", client_id: "junior-barns" }), "dave");
  assertEquals(pmRequestorOf({}, { client_id: "junior-barns" }), "junior-barns");
  // A cross-app row (migration 161) carries no tenant at all.
  assertEquals(pmRequestorOf({}, { submitter_name: "Mel", source_app: "framedup" }), "Mel");
  assertEquals(pmRequestorOf({}, {}), "Client");
});

Deno.test("requestor: an item the team added names the team member", () => {
  assertEquals(pmRequestorOf({ created_by_email: "ahsan@csmsynergy.com" }, null, names), "Ahsan");
  assertEquals(pmRequestorOf({ created_by_email: "carolyn@csmsynergy.com" }, null, names), "Carolyn");
  // Case-insensitive on the email, and an unknown address degrades to its local part rather
  // than printing a whole address into the cell.
  assertEquals(pmRequestorOf({ created_by_email: "Ahsan@CSMSynergy.com" }, null, names), "Ahsan");
  assertEquals(pmRequestorOf({ created_by_email: "someone@elsewhere.com" }, null, names), "someone");
  // No roster at all still works.
  assertEquals(pmRequestorOf({ created_by_email: "ahsan@csmsynergy.com" }, null), "ahsan");
});

Deno.test("requestor: the machine-made rows say what made them", () => {
  assertEquals(pmRequestorOf({ created_by_email: "roadmap" }, null, names), "Roadmap");
  assertEquals(pmRequestorOf({ release_note_id: "r1", created_by_email: "x@y.com" }, null, names), "Roadmap");
  assertEquals(pmRequestorOf({ created_by_email: "expo-runway" }, null, names), "Expo Runway");
  assertEquals(pmRequestorOf({ monday_item_id: "999" }, null, names), "monday.com");
  assertEquals(pmRequestorOf({}, null, names), "");
});

Deno.test("a submission outranks created_by_email", () => {
  // mirrorToProjects writes both; the person who reported it is the requestor, not the
  // function that filed the card.
  const item = { created_by_email: "ahsan@csmsynergy.com", monday_item_id: "7" };
  assertEquals(pmRequestorOf(item, { submitter_name: "Dave Hall" }, names), "Dave Hall");
});

Deno.test("derived cells are merged OVER the stored values, never under", () => {
  const item = {
    id: "i1", created_at: "2026-10-19T00:00:00.000Z", created_by_email: "ahsan@csmsynergy.com",
    // A hostile or stale write cannot pre-fill a reserved id and win.
    values: { col_a: "keep me", [PM_SYS_CREATED]: "1999-01-01", [PM_SYS_REQUESTOR]: "Someone else" },
  };
  const out = pmWithSystemValues(item, null, names);
  assertEquals(out.values[PM_SYS_CREATED], "2026-10-19");
  assertEquals(out.values[PM_SYS_REQUESTOR], "Ahsan");
  assertEquals(out.values.col_a, "keep me");
  // The original object is untouched (the caller may still hold it).
  assertEquals(item.values[PM_SYS_CREATED], "1999-01-01");
});

Deno.test("an empty requestor is null, not an empty string", () => {
  // The table engine's text cell prints "—" for a falsy value; "" would render as a blank gap.
  assertEquals(pmSystemValues({ created_at: "2026-10-19T00:00:00Z" }, null)[PM_SYS_REQUESTOR], null);
});

Deno.test("pmDecorateItems looks each submission up by id, once", () => {
  const subs = new Map([["s1", { submitter_name: "Dave Hall", client_id: "junior-barns" }]]);
  const out = pmDecorateItems([
    { id: "a", created_at: "2026-10-01T00:00:00Z", feedback_submission_id: "s1" },
    { id: "b", created_at: "2026-10-02T00:00:00Z", created_by_email: "carolyn@csmsynergy.com" },
    // A link to a submission that no longer exists must not blank the row out.
    { id: "c", created_at: "2026-10-03T00:00:00Z", feedback_submission_id: "gone", created_by_email: "roadmap" },
  ], subs, names);
  assertEquals(out.map((i) => i.values[PM_SYS_REQUESTOR]), ["Dave Hall", "Carolyn", "Roadmap"]);
  assertEquals(out.map((i) => i.values[PM_SYS_CREATED]), ["2026-10-01", "2026-10-02", "2026-10-03"]);
  assertEquals(pmDecorateItems([], subs, names), []);
});
