// Unit tests for _shared/leadImport.ts (the lead import, migration 381). Self-contained: no jsr: imports.
// Made-up people only (555-01xx numbers, example.invalid addresses): this repo is public.
import {
  autoMap, cleanLeadRow, detectHeaderField, headerIndex, IMPORT_PAGE_MAX, importSummary, LEAD_IMPORT_REASONS,
  mappingRefusal, pageRows, parseLeadImportRequest, parseSheetDay, planLeadImport, reasonFor, splitLabels,
  sumCounts, truthyCell, zeroCounts,
} from "./leadImport.ts";

/** Objects compare by their keys and values, not the order the keys were added in. */
const canon = (v: unknown): unknown => Array.isArray(v) ? v.map(canon)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v;
function eq(a: unknown, b: unknown, msg: string) {
  const x = JSON.stringify(canon(a)), y = JSON.stringify(canon(b));
  if (x !== y) throw new Error(`${msg}: ${x} !== ${y}`);
}
function ok(v: unknown, msg: string) { if (!v) throw new Error(msg); }

const S1 = "00000000-0000-4000-8000-0000000000a1";
const S2 = "00000000-0000-4000-8000-0000000000a2";
const P = "00000000-0000-4000-8000-0000000000b1";
const U1 = "00000000-0000-4000-8000-0000000000c1";
const U2 = "00000000-0000-4000-8000-0000000000c2";
const STAGES = [{ id: S1, name: "New Lead" }, { id: S2, name: "Demo Scheduled" }];
const TEAM = [{ userId: U1, name: "Pat Example" }, { userId: U2, name: "Sam Sample" }];
const CTX = { stages: STAGES, team: TEAM, ownOnly: false };

// GoHighLevel's contact export headers, as the export spells them.
const GHL = ["Contact Id", "First Name", "Last Name", "Business Name", "Phone", "Email", "Created", "Last Activity",
  "Tags", "Additional Emails", "Additional Phones", "Address", "City", "State", "Postal Code", "Country", "Source",
  "Type", "DND", "Assigned To", "Date Of Birth", "Website", "Timezone"];

Deno.test("GoHighLevel's export maps with no touch", () => {
  eq(autoMap(GHL), [
    "skip", "first_name", "last_name", "company", "phone", "email", "added_at", "skip",
    "labels", "skip", "skip", "street", "city", "state", "zip", "skip", "skip",
    "skip", "do_not_text", "owner", "skip", "skip", "skip",
  ], "GoHighLevel contact export");
  eq(mappingRefusal(autoMap(GHL)), null, "importable as is");
});

Deno.test("a cold-call list and a generic CRM export map too", () => {
  eq(autoMap(["Company Name", "Contact Name", "Phone Number", "E-mail", "Notes", "Sales Rep"]),
    ["company", "name", "phone", "email", "note", "owner"], "call list");
  eq(autoMap(["Full Name", "Mobile", "Email Address", "Street Address", "ZIP Code", "Deal Name", "Amount", "Stage", "Close Date", "Status"]),
    ["name", "phone", "email", "street", "zip", "title", "value", "stage", "expected_close", "skip"], "CRM export; Status is never imported");
  eq(detectHeaderField("  PHONE_number: "), "phone", "punctuation and case");
  eq(detectHeaderField(""), "skip", "a blank header");
  eq(detectHeaderField("Favourite colour"), "skip", "unknown");
});

Deno.test("custom fields take their own label or key, contact before deal, and beat a skipped column", () => {
  const defs = [
    { entity: "deal" as const, key: "building_size", label: "Building size" },
    { entity: "contact" as const, key: "source", label: "Source" },
    { entity: "contact" as const, key: "building_size", label: "Building size" },
  ];
  eq(detectHeaderField("Building Size", defs), "custom:contact:building_size", "contact wins a tie");
  eq(detectHeaderField("source", defs), "custom:contact:source", "a field the builder made beats our skip list");
  eq(detectHeaderField("Phone", defs), "phone", "our own fields first");
});

Deno.test("a column claimed twice: the first one keeps it", () => {
  eq(autoMap(["Phone", "Mobile", "Name"]), ["phone", "skip", "name"], "second phone column skipped");
});

Deno.test("mapping refusals", () => {
  ok(mappingRefusal(["skip", "skip"])?.includes("name or the company"), "nothing mapped");
  ok(mappingRefusal(["phone"])?.includes("name or the company"), "no name");
  ok(mappingRefusal(["company"])?.includes("phone or the email"), "no way to reach them");
  eq(mappingRefusal(["company", "email"]), null, "a company and an email is enough");
  ok(mappingRefusal(["name", "phone", "phone"])?.includes("same field"), "a field twice");
});

Deno.test("rows: names, companies, refusals and dropped values, by line number", () => {
  const m = ["first_name", "last_name", "company", "phone", "email", "value", "stage", "owner"];
  const sheet = [
    ["First", "Last", "Company", "Phone", "Email", "Value", "Stage", "Owner"],
    ["Pat", "Example", "", "(555) 010-0001", "", "$2,500", "new lead", "pat example"],
    ["", "", "Acme Sheds", "", "acme@example.invalid", "lots", "Somewhere", "Nobody"],
    [],
    ["", "", "", "555-010-0003", "", "", "", ""],
    ["Lee", "", "", "12", "", "", "", ""],
    ["Lee", "", "", "", "not-an-email", "", "", ""],
    ["Lee", "", "", "12", "nope", "", "", ""],
    ["Kim", "", "", "", "", "", "", ""],
    ["Ray", "", "", "123", "ray@example.invalid", "", "", ""],
  ];
  const plan = planLeadImport(sheet, m, CTX);
  eq(plan.headerRow, 1, "header on line 1");
  eq(plan.dataRows, 8, "the blank line is not a row");
  eq(plan.rows.map((r) => r.row), [2, 3, 10], "line numbers survive the blank line");
  eq(plan.rows[0], { row: 2, name: "Pat Example", phone: "(555) 010-0001", owner: U1, stage: S1, value_cents: 250000 }, "a person, matched stage and owner");
  eq(plan.rows[1], { row: 3, company: "Acme Sheds", email: "acme@example.invalid" }, "a company with no person");
  eq(plan.rows[2], { row: 10, name: "Ray", email: "ray@example.invalid" }, "short phone left off");
  eq(plan.refused, [
    { row: 5, code: "no_name" }, { row: 6, code: "bad_phone" }, { row: 7, code: "bad_email" },
    { row: 8, code: "bad_both" }, { row: 9, code: "no_identity" },
  ], "refusals");
  eq(plan.warnings, [
    { row: 3, code: "owner_unknown" }, { row: 3, code: "stage_unknown" }, { row: 3, code: "value_dropped" },
    { row: 10, code: "phone_dropped" },
  ], "warnings");
});

Deno.test("the header is the first line that holds anything", () => {
  const plan = planLeadImport([[], ["", ""], ["Name", "Email"], ["Pat", "pat@example.invalid"]], ["name", "email"], CTX);
  eq(plan.headerRow, 3, "header line");
  eq(plan.rows, [{ row: 4, name: "Pat", email: "pat@example.invalid" }], "row line");
  eq(headerIndex([]), -1, "empty sheet");
  eq(planLeadImport([], ["name"], CTX).rows, [], "nothing to plan");
});

Deno.test("the same person twice is one row; a second number stays its own row", () => {
  const m = ["name", "phone", "email", "labels", "note", "stage", "do_not_text"];
  const sheet = [
    ["Name", "Phone", "Email", "Tags", "Notes", "Stage", "DND"],
    ["Pat Example", "+1 555 010 0001", "", "a, b", "", "", ""],
    ["", "555-010-0001", "pat@example.invalid", "B; c", "called once", "Demo Scheduled", "yes"],
    ["Pat E", "", "PAT@example.invalid", "d", "", "New Lead", ""],
    ["Pat Example", "555-010-0009", "pat@example.invalid", "", "", "", ""],
  ];
  const plan = planLeadImport(sheet, m, CTX);
  eq(plan.rows.length, 2, "rows 2-4 are one person; row 5 carries a different phone");
  eq(plan.rows[0], {
    row: 2, name: "Pat Example", phone: "+1 555 010 0001", labels: ["a", "b", "c", "d"], do_not_text: true,
    email: "pat@example.invalid", note: "called once", stage: S2,
  }, "blanks filled from the later rows, tags added, first name kept");
  eq(plan.rows[1].row, 5, "the other-number row");
  eq(plan.warnings, [
    { row: 3, code: "repeat_in_file", into: 2 }, { row: 4, code: "repeat_in_file", into: 2 },
    { row: 5, code: "repeat_other_channel", into: 2 },
  ], "repeats point at the row they joined");
});

Deno.test("a contacts-only import drops deal columns; someone narrowed never names an owner", () => {
  const m = ["name", "email", "stage", "title", "value", "owner", "custom:deal:size", "custom:contact:farm"];
  const sheet = [["n", "e", "s", "t", "v", "o", "ds", "cf"], ["Pat", "pat@example.invalid", "New Lead", "Shed", "10", "Sam Sample", "12x16", "Bear Creek"]];
  eq(planLeadImport(sheet, m, { stages: null, team: TEAM, ownOnly: false }).rows,
    [{ row: 2, name: "Pat", email: "pat@example.invalid", owner: U2, contact_custom: { farm: "Bear Creek" } }], "no deal fields without a pipeline");
  eq(planLeadImport(sheet, m, { stages: STAGES, team: TEAM, ownOnly: true }).rows,
    [{ row: 2, name: "Pat", email: "pat@example.invalid", stage: S1, title: "Shed", value_cents: 1000, contact_custom: { farm: "Bear Creek" }, deal_custom: { size: "12x16" } }],
    "an own-scoped importer's owner column is ignored");
});

Deno.test("owner and stage names match exactly one, case and spacing aside", () => {
  const twins = [{ userId: U1, name: "Pat Example" }, { userId: U2, name: "pat  example" }];
  const plan = planLeadImport([["n", "e", "o"], ["A", "a@example.invalid", "Pat Example"]], ["name", "email", "owner"], { stages: STAGES, team: twins, ownOnly: false });
  eq(plan.rows[0].owner, undefined, "two people with one name");
  eq(plan.warnings, [{ row: 2, code: "owner_unknown" }], "said so");
  const dupStage = [{ id: S1, name: "New" }, { id: S2, name: "new" }];
  eq(planLeadImport([["n", "e", "s"], ["A", "a@example.invalid", "NEW"]], ["name", "email", "stage"], { stages: dupStage, team: [], ownOnly: false }).warnings,
    [{ row: 2, code: "stage_unknown" }], "two stages with one name");
});

Deno.test("dates, ticks and tags", () => {
  eq(parseSheetDay("2026-11-10"), "2026-11-10", "iso day");
  eq(parseSheetDay("2026-11-10T07:00:00.000Z"), "2026-11-10", "iso instant keeps its own day");
  eq(parseSheetDay("11/10/2026"), "2026-11-10", "US");
  eq(parseSheetDay("1/2/26"), "2026-01-02", "short year");
  eq(parseSheetDay("2/30/2026"), null, "not a real day");
  eq(parseSheetDay("Tuesday"), null, "words");
  eq(parseSheetDay(""), null, "blank");
  for (const y of ["yes", "Y", "TRUE", "x", "1", "DND", "Opted out"]) ok(truthyCell(y), `ticks: ${y}`);
  for (const n of ["", "no", "false", "0", "maybe"]) ok(!truthyCell(n), `does not tick: ${n}`);
  eq(splitLabels(" Hot ; hot, Warm ,, " + "x".repeat(70)), ["Hot", "Warm", "x".repeat(60)], "split, unique, capped");
  eq(splitLabels(Array.from({ length: 30 }, (_, i) => `t${i}`).join(",")).length, 25, "25 tags at most");
  const plan = planLeadImport([["n", "e", "a", "c"], ["A", "a@example.invalid", "13/45/2026", "soon"]], ["name", "email", "added_at", "expected_close"], CTX);
  eq(plan.warnings, [{ row: 2, code: "date_dropped" }, { row: 2, code: "date_dropped" }], "unreadable dates left off");
});

Deno.test("nothing a refusal or a warning carries is a cell", () => {
  const m = ["name", "phone", "email", "value", "stage", "owner"];
  const sheet = [["n", "p", "e", "v", "s", "o"]];
  for (let i = 0; i < 40; i++) sheet.push([i % 5 ? `Person ${i}` : "", `555010${String(i).padStart(4, "0")}`, `p${i}@example.invalid`, "abc", "Nope", "Nobody"]);
  sheet.push(["Short", "12", "", "", "", ""]);
  const plan = planLeadImport(sheet, m, CTX);
  const text = JSON.stringify([plan.refused, plan.warnings]);
  ok(!/@/.test(text) && !/\d{7,}/.test(text), `no email or phone in ${text.slice(0, 200)}`);
  for (const i of [...plan.refused, ...plan.warnings]) ok(LEAD_IMPORT_REASONS[i.code], `a sentence for ${i.code}`);
  for (const s of Object.values(LEAD_IMPORT_REASONS)) ok(!/\{|\$\{/.test(s), "reasons are fixed sentences");
  eq(reasonFor("whatever"), "It couldn't be imported.", "an unknown code still reads");
});

Deno.test("pages, sums and summaries", () => {
  eq(pageRows([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]], "pages");
  eq(pageRows(Array.from({ length: 401 }), IMPORT_PAGE_MAX).map((p) => p.length), [200, 200, 1], "server-sized pages");
  const sum = sumCounts([
    { rows: 3, contacts_created: 2, contacts_matched: 1, deals_created: 2, refused: [{ row: 4, code: "not_yours" }] },
    { rows: 2, contacts_created: "x", already_in_pipeline: 2, refused: [{ row: 9, code: "conflict", name: "dropped" }, "junk"] },
    null,
  ]);
  eq([sum.rows, sum.contacts_created, sum.contacts_matched, sum.deals_created, sum.already_in_pipeline], [5, 2, 1, 2, 2], "numbers add");
  eq(sum.refused, [{ row: 4, code: "not_yours" }, { row: 9, code: "conflict" }], "refusals keep only row and code");

  const dry = importSummary(sum, { dryRun: true, withDeals: true, onMatch: "attach", refusedInFile: 1 });
  eq(dry, "Nothing has been saved yet. This file would add 2 new contacts. 1 person is already in Contacts, and their blank details would be filled in. 2 deals would go on the pipeline; 2 people are already on it. 3 rows can't be imported.", "dry run");
  const done = importSummary(sum, { dryRun: false, withDeals: false, onMatch: "skip" });
  eq(done, "Done. 2 new contacts were added. 1 person was already in Contacts and left as they were. 2 rows weren't imported.", "real run, contacts only");
  const rerun = zeroCounts(); rerun.contacts_matched = 1200; rerun.already_in_pipeline = 1200;
  eq(importSummary(rerun, { dryRun: true, withDeals: true, onMatch: "attach" }),
    "Nothing has been saved yet. This file would add 0 new contacts. 1,200 people are already in Contacts, and their blank details would be filled in. 0 deals would go on the pipeline; 1,200 people are already on it.",
    "a re-run of the same file adds nothing");
});

Deno.test("the request: dry run unless told, a page at most, rows cleaned", () => {
  const row = { row: 2, name: "  Pat ", phone: 5550100001, email: "pat@example.invalid", labels: ["a", 5, "A"], owner: U1.toUpperCase(),
    stage: "nope", value_cents: -1, expected_close_date: "11/10/2026", added_at: "2026-01-02", do_not_text: "yes",
    contact_custom: { farm: "Bear Creek", BAD: "x", n: 4, o: { deep: 1 } }, extra: "dropped" };
  const r = parseLeadImportRequest({ pipelineId: P, rows: [row] });
  ok(r.ok, "accepted");
  if (!r.ok) return;
  eq([r.dryRun, r.pipelineId, r.defaultStageId, r.onMatch, r.defaultOwnerUserId], [true, P, null, "attach", null], "defaults");
  eq(r.rows[0], { row: 2, name: "Pat", phone: "5550100001", email: "pat@example.invalid", labels: ["a"], owner: U1, added_at: "2026-01-02", contact_custom: { farm: "Bear Creek", n: 4 } }, "cleaned");
  const real = parseLeadImportRequest({ dryRun: false, pipelineId: null, onMatch: "skip", rows: [{ row: 1 }], page: 2, pages: 3 });
  ok(real.ok && !real.dryRun && real.pipelineId === null && real.onMatch === "skip" && real.page === 2 && real.pages === 3, "a real contacts-only page");

  const refuse = (p: Record<string, unknown>, has: string) => {
    const x = parseLeadImportRequest(p);
    ok(!x.ok && x.error.includes(has), `${JSON.stringify(p).slice(0, 80)} → ${has}`);
  };
  refuse({ rows: [] }, "no rows");
  refuse({ rows: Array.from({ length: IMPORT_PAGE_MAX + 1 }, (_, i) => ({ row: i + 2 })) }, "at most 200");
  refuse({ rows: [{ name: "x" }] }, "line number");
  refuse({ rows: ["x"] }, "set of fields");
  refuse({ pipelineId: "board", rows: [{ row: 2 }] }, "pipeline");
  refuse({ defaultStageId: S1, rows: [{ row: 2 }] }, "pipeline that stage");
  refuse({ pipelineId: P, defaultOwnerUserId: "pat", rows: [{ row: 2 }] }, "owner");
  refuse({ pipelineId: P, onMatch: "overwrite", rows: [{ row: 2 }] }, "already in Contacts");
  eq(cleanLeadRow({ row: 3, note: " line one\r\nline two ", value_cents: 1250, expected_close_date: "2026-12-01" }),
    { row: 3, note: "line one\nline two", value_cents: 1250, expected_close_date: "2026-12-01" }, "note keeps its lines");
});
