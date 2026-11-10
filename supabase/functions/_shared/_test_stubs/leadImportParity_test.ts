// The portal's copy of the lead import's sheet rules (portal/02-sales.jsx, between the
// ⟦lead-import:start⟧ and ⟦lead-import:end⟧ markers) answers what _shared/leadImport.ts answers, for
// every sheet below. The block is lifted out of the shipped portal source and run, so this fails when
// either copy moves alone. Made-up people only: this repo is public.
// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  autoMap, detectHeaderField, headerIndex, IMPORT_PAGE_MAX, importSummary, LEAD_COUNT_KEYS, LEAD_IMPORT_ALIASES,
  LEAD_IMPORT_FIELDS, LEAD_IMPORT_REASONS, LEAD_IMPORT_MAX_ROWS, mappingRefusal, normaliseHeader, pageRows,
  parseSheetDay, planLeadImport, reasonFor, splitLabels, sumCounts, truthyCell,
} from "../leadImport.ts";
import { parseMoneyCents } from "../crmPipelines.ts";
import { phoneKey } from "../phoneKey.ts";

const SALES = Deno.readTextFileSync(new URL("../../../../portal/02-sales.jsx", import.meta.url)).replace(/\r\n/g, "\n");
const start = SALES.indexOf("// ⟦lead-import:start⟧");
const end = SALES.indexOf("// ⟦lead-import:end⟧");
const BLOCK = SALES.slice(start, end);

const portal = new Function(`${BLOCK}\nreturn { SS_LEAD_PAGE_MAX, SS_LEAD_MAX_ROWS, SS_LEAD_FIELDS, SS_LEAD_ALIASES, SS_LEAD_COUNT_KEYS,
  SS_LEAD_REASONS, ssLeadHeader, ssLeadDetect, ssLeadAutoMap, ssLeadMappingRefusal, ssLeadSplitLabels, ssLeadSheetDay,
  ssLeadTruthy, ssLeadHeaderIndex, ssLeadPlan, ssLeadPages, ssLeadSum, ssLeadReason, ssLeadSummary, ssLeadMoneyCents,
  ssLeadPhoneKey };`)() as Record<string, any>;

const S1 = "00000000-0000-4000-8000-0000000000a1";
const S2 = "00000000-0000-4000-8000-0000000000a2";
const U1 = "00000000-0000-4000-8000-0000000000c1";
const U2 = "00000000-0000-4000-8000-0000000000c2";
const STAGES = [{ id: S1, name: "New Lead" }, { id: S2, name: "Demo Scheduled" }];
const TEAM = [{ userId: U1, name: "Pat Example" }, { userId: U2, name: "Sam Sample" }, { userId: "x", name: null }];
const DEFS = [{ entity: "contact" as const, key: "farm", label: "Farm" }, { entity: "deal" as const, key: "size", label: "Building size" }];

const SHEETS: unknown[][][] = [
  // GoHighLevel's contact export.
  [["Contact Id", "First Name", "Last Name", "Business Name", "Phone", "Email", "Created", "Tags", "Address", "City", "State", "Postal Code", "DND", "Assigned To", "Farm"],
   ["c1", "Pat", "Example", "", "+1 555 010 0001", "pat@example.invalid", "2025-03-04T05:06:07Z", "a, b", "1 Main St", "Town", "ID", "83701", "true", "Sam Sample", "Bear Creek"],
   ["c2", "", "", "Acme Sheds", "555-010-0002", "", "11/10/2026", "", "", "", "", "", "", "Nobody", ""],
   [],
   ["c3", "Pat", "", "", "555.010.0001", "PAT@example.invalid", "", "B; c", "", "", "", "", "", "", "Willow"],
   ["c4", "", "", "", "12", "nope", "", "", "", "", "", "", "", "", ""],
   ["c5", "Lee", "New", "", "555-010-0055", "lee@example.invalid", "not a date", "", "", "", "", "", "yes", "pat example", ""],
   ["c6", "Lee", "Work", "", "555-010-0077", "lee@example.invalid", "", "", "", "", "", "", "", "", ""]],
  // A cold-call list with deals.
  [["Company Name", "Contact Name", "Phone Number", "E-mail", "Stage", "Deal Name", "Amount", "Close Date", "Notes", "Building Size"],
   ["Bear River Barns", "", "(555) 010-0101", "", "demo scheduled", "Annual", "$2,500", "2026-12-01", "Called\nonce", "12x16"],
   ["Willow Sheds", "Robin", "5550100102", "robin@example.invalid", "Nowhere", "", "lots", "soon", "", ""],
   ["", "", "", "", "", "", "", "", "", ""],
   ["", "", "5550100101", "", "New Lead", "Second", "", "", "", "10x12"],
   ["No Contact Way", "", "", "", "", "", "", "", "", ""]],
  // Nothing but a header two lines down.
  [[], ["", ""], ["Name", "Email"]],
];

const CTXS = [
  { stages: STAGES, team: TEAM, ownOnly: false, customDefs: DEFS },
  { stages: null, team: TEAM, ownOnly: false, customDefs: DEFS },
  { stages: STAGES, team: TEAM, ownOnly: true, customDefs: [] },
];

Deno.test("the portal block is there, between its markers, with the same constants", () => {
  assert(start >= 0 && end > start, "the ⟦lead-import⟧ markers are gone from portal/02-sales.jsx");
  assertEquals(portal.SS_LEAD_PAGE_MAX, IMPORT_PAGE_MAX);
  assertEquals(portal.SS_LEAD_MAX_ROWS, LEAD_IMPORT_MAX_ROWS);
  assertEquals(portal.SS_LEAD_FIELDS, LEAD_IMPORT_FIELDS);
  assertEquals(portal.SS_LEAD_ALIASES, LEAD_IMPORT_ALIASES);
  assertEquals(portal.SS_LEAD_COUNT_KEYS, [...LEAD_COUNT_KEYS]);
  assertEquals(portal.SS_LEAD_REASONS, LEAD_IMPORT_REASONS);
});

Deno.test("the small rules agree", () => {
  for (const h of ["Phone Number:", "e-mail", " ", "Building Size", "SOURCE", "Contact Id", 7, null]) {
    assertEquals(portal.ssLeadHeader(h), normaliseHeader(h), `header ${h}`);
    assertEquals(portal.ssLeadDetect(h, DEFS), detectHeaderField(h, DEFS), `detect ${h}`);
  }
  for (const v of ["$12,500", "12.5", "12.345", "", null, undefined, 40, "ten", "-1"]) assertEquals(portal.ssLeadMoneyCents(v), parseMoneyCents(v), `money ${v}`);
  for (const v of ["+1 (555) 010-0101", "15550100101", "555 0101", "", null, 5550100101]) assertEquals(portal.ssLeadPhoneKey(v), phoneKey(v), `phone ${v}`);
  for (const v of ["2026-11-10", "2026-11-10T07:00:00Z", "11/10/2026", "1/2/26", "2/30/2026", "13.01.2026", "", "Tuesday"]) assertEquals(portal.ssLeadSheetDay(v), parseSheetDay(v), `day ${v}`);
  for (const v of ["yes", "No", "X", "", "dnd", "0", "Opted Out"]) assertEquals(portal.ssLeadTruthy(v), truthyCell(v), `tick ${v}`);
  for (const v of ["a, b;A", "", " x ,, y", Array.from({ length: 30 }, (_, i) => `t${i}`).join(",")]) assertEquals(portal.ssLeadSplitLabels(v), splitLabels(v), `labels ${v}`);
  for (const code of [...Object.keys(LEAD_IMPORT_REASONS), "unknown"]) assertEquals(portal.ssLeadReason(code), reasonFor(code), `reason ${code}`);
  assertEquals(portal.ssLeadPages([1, 2, 3, 4, 5], 2), pageRows([1, 2, 3, 4, 5], 2));
  for (const m of [["skip"], ["company", "email"], ["phone"], ["name", "phone", "phone"], ["first_name", "skip"]]) {
    assertEquals(portal.ssLeadMappingRefusal(m), mappingRefusal(m), `refusal ${m}`);
  }
});

Deno.test("every sheet plans the same rows, refusals and warnings in both copies", () => {
  for (const sheet of SHEETS) {
    assertEquals(portal.ssLeadHeaderIndex(sheet), headerIndex(sheet));
    const h = Math.max(0, headerIndex(sheet));
    const mapping = autoMap(sheet[h] ?? [], DEFS);
    assertEquals(portal.ssLeadAutoMap(sheet[h] ?? [], DEFS), mapping, `mapping of ${JSON.stringify(sheet[h])}`);
    for (const ctx of CTXS) {
      const a = planLeadImport(sheet, mapping, ctx);
      const b = portal.ssLeadPlan(sheet, mapping, ctx);
      assertEquals(JSON.parse(JSON.stringify(b)), JSON.parse(JSON.stringify(a)), `plan of ${JSON.stringify(sheet[h])} with ${JSON.stringify({ ...ctx, team: "…" })}`);
    }
  }
  // The fixtures exercise what they claim to: a merge, a second channel, refusals, deal fields.
  const p = planLeadImport(SHEETS[0], autoMap(SHEETS[0][0], DEFS), CTXS[0]);
  assert(p.warnings.some((w) => w.code === "repeat_in_file") && p.warnings.some((w) => w.code === "repeat_other_channel"));
  assert(p.refused.length > 0 && p.rows.some((r) => r.contact_custom));
  const q = planLeadImport(SHEETS[1], autoMap(SHEETS[1][0], DEFS), CTXS[0]);
  assert(q.rows.some((r) => r.deal_custom && r.value_cents && r.expected_close_date && r.stage));
});

Deno.test("sums and summaries agree", () => {
  const pages = [
    { rows: 3, contacts_created: 2, contacts_matched: 1, deals_created: 2, refused: [{ row: 4, code: "not_yours" }], warnings: [{ row: 2, code: "custom_dropped" }] },
    { rows: 2, contacts_created: "x", already_in_pipeline: 1200, matched_skipped: 1, refused: [{ row: 9, code: "conflict", name: "dropped" }, "junk"] },
    null,
  ];
  const a = sumCounts(pages);
  assertEquals(portal.ssLeadSum(pages), JSON.parse(JSON.stringify(a)));
  for (const dryRun of [true, false]) for (const withDeals of [true, false]) for (const onMatch of ["attach", "skip"] as const) {
    const o = { dryRun, withDeals, onMatch, refusedInFile: 2 };
    assertEquals(portal.ssLeadSummary(a, o), importSummary(a, o), JSON.stringify(o));
  }
});
