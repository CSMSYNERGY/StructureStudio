// Unit tests for _shared/taxCodes.ts — the tax code mapping's pure half (migration 246,
// 2026-09-17).
//
// Deliberately dependency-free (no jsr:/npm: imports) so this suite still runs on a machine
// with no registry access — the same rule the other _shared tests follow.
//
// What is pinned here fails quietly in production. A heading key the database shape CHECK
// refuses fails every save that ticks it, after the builder pressed Save. A payload parser that
// lets one target into two rows stores whichever row the upsert reached last. A search pattern
// that leaves `%` or `_` live matches codes the builder never typed. A save plan that deletes
// instead of re-coding a moved target drops it for the instant between the two writes, and one
// that rewrites unchanged rows makes updated_by name somebody who changed nothing. And a sync row
// that keeps Avalara's company or user ids puts account details in a platform table.

const {
  COMMON_CODES, DESCRIPTION_MAX, headingsView, mapAvalaraTaxCode, MAX_ASSIGNMENT_ROWS, MAX_ASSIGNMENT_TARGETS,
  mergeCodeLists, normalizeTaxCode, orderCodes, parseAssignmentsPayload, planAssignments, SEARCH_MAX, searchQuery,
  TAX_CODE_SEARCH_LIMIT, TAX_HEADING_GROUPS, TAX_HEADINGS, taxCodeView, UNMATCHED_LINES, visibleAssignments,
} = await import("./taxCodes.ts");

const assertEquals = (a: unknown, b: unknown, msg?: string) => {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(msg ? `${msg}: ${sa} !== ${sb}` : `${sa} !== ${sb}`);
};
const assert = (cond: unknown, msg = "assertion failed") => {
  if (!cond) throw new Error(msg);
};

const STYLE_A = "3f0c2b1e-8a4d-4c2e-9b7a-1d2e3f4a5b6c";
const STYLE_B = "0b6f7c1d-2e3a-4b5c-8d9e-0f1a2b3c4d5e";

// ── The headings ────────────────────────────────────────────────────────────────────────────

Deno.test("the headings are the brief's, in its groups and order", () => {
  assertEquals(TAX_HEADINGS.map((h) => [h.group, h.key, h.label]), [
    ["building", "wall_heights", "Wall heights"],
    ["building", "colors", "Paint & roof colours"],
    ["exterior", "doors", "Doors"],
    ["exterior", "windows", "Windows"],
    ["exterior", "vents", "Vents"],
    ["exterior", "ramps", "Ramps"],
    ["exterior", "cladding", "Cladding"],
    ["interior", "interior_items", "Interior items (lofts, shelves, workbenches)"],
    ["interior", "electrical", "Electrical"],
    ["interior", "insulation", "Insulation"],
    ["other", "custom_options", "Custom options"],
    ["services", "build_on_site", "Built-on-site fee"],
    ["services", "foundation", "Foundation & site work"],
    ["services", "change_order_fee", "Change order fee"],
    ["delivery", "delivery", "Delivery"],
  ]);
  assertEquals(TAX_HEADING_GROUPS.map((g) => g.key), ["building", "exterior", "interior", "other", "services", "delivery"]);
  assertEquals(new Set(TAX_HEADINGS.map((h) => h.key)).size, TAX_HEADINGS.length, "heading keys are unique");
});

Deno.test("the portal gets key, label and group — lineMatch stays on the server", () => {
  const view = headingsView();
  assertEquals(view.length, TAX_HEADINGS.length);
  for (const h of view) assertEquals(Object.keys(h), ["key", "label", "group"]);
});

// Every line kind and layout_item key submit-estimate and estimateLines.ts emit as of 2026-09-17
// (kinds tagged at each tagLine site; layout_item keys including RO_KEYS). A kind nobody places
// is a line the calculation stage would tax by accident, so each is either matched by a heading
// or named in UNMATCHED_LINES with a reason.
const EMITTED_KINDS = [
  "building", "wall_height", "build_on_site", "cladding", "insulation", "foundation", "layout_item", "paint", "roof",
  "door", "electrical", "electrical_item", "ramp", "window", "custom_option", "delivery", "discount",
  "change_order", "change_order_fee", "adjustment", "fallback",
];
const LAYOUT_ITEM_KEYS = [
  "singleDoor", "doubleDoor", "window", "workbench", "shelf", "doubleShelf", "loft", "ramp", "shutters", "flowerBox",
  "roughOpening", "roughOpeningDoor", "roughOpeningWindow",
];

Deno.test("every emitted line kind and layout item key is covered by a heading or named as unmatched", () => {
  const kinds = new Set(TAX_HEADINGS.flatMap((h) => h.lineMatch.kinds));
  const items = new Set(TAX_HEADINGS.flatMap((h) => h.lineMatch.layoutItems ?? []));
  const unmatchedKinds = new Set(UNMATCHED_LINES.filter((u) => !u.itemKey).map((u) => u.kind));
  const unmatchedItems = new Set(UNMATCHED_LINES.filter((u) => u.itemKey).map((u) => u.itemKey));
  for (const k of EMITTED_KINDS) {
    if (k === "layout_item") continue;
    assert(kinds.has(k) !== unmatchedKinds.has(k), `line kind ${k} must be matched by exactly one of a heading or UNMATCHED_LINES`);
  }
  for (const k of LAYOUT_ITEM_KEYS) {
    assert(items.has(k) !== unmatchedItems.has(k), `layout item ${k} must be matched by exactly one of a heading or UNMATCHED_LINES`);
  }
  for (const u of UNMATCHED_LINES) assert(u.why.length > 10, `${u.kind} needs a reason`);
});

Deno.test("vents and windows share kind window, told apart only by fixture category — and the vent note says so", () => {
  const vents = TAX_HEADINGS.find((h) => h.key === "vents")!.lineMatch;
  const windows = TAX_HEADINGS.find((h) => h.key === "windows")!.lineMatch;
  assertEquals([vents.kinds, vents.fixtureCategory], [["window"], "vent"]);
  assertEquals([windows.kinds, windows.fixtureCategory], [["window"], "window"]);
  assert(/tag vent lines/.test(vents.note ?? ""), "the calculation stage must be told vents are not tagged today");
  assertEquals(TAX_HEADINGS.find((h) => h.key === "interior_items")!.lineMatch.layoutItems, ["loft", "shelf", "doubleShelf", "workbench"]);
  assertEquals(TAX_HEADINGS.find((h) => h.key === "doors")!.lineMatch.layoutItems, ["singleDoor", "doubleDoor", "roughOpeningDoor"]);
});

// ── The starter codes ───────────────────────────────────────────────────────────────────────

Deno.test("the common codes are the twelve starter codes, in seed order, each with a hint", () => {
  assertEquals(COMMON_CODES.map((c) => c.code), [
    "P0000000", "NT", "ON030000", "SI020100", "SI020200", "SC150100",
    "FR010000", "FR010100", "FR010200", "FR020100", "FR030000", "OH010000",
  ]);
  for (const c of COMMON_CODES) {
    assertEquals(normalizeTaxCode(c.code), c.code, `${c.code} is a well-formed code`);
    assert(c.hint.length > 5 && c.hint.length <= 120, `${c.code} needs a short hint`);
  }
});

// ── The migration agrees ────────────────────────────────────────────────────────────────────
// Read the SHIPPED migration, not a copy. Needs --allow-read (preflight grants it, scoped to the
// repo); ignored where it is not granted.

const MIGRATION = new URL("../../migrations/246_avalara_tax_codes.sql", import.meta.url);
const canRead = Deno.permissions.querySync({ name: "read", path: MIGRATION }).state === "granted";

Deno.test({
  name: "migration 246 seeds exactly COMMON_CODES, in order",
  ignore: !canRead,
  fn: async () => {
    const sql = (await Deno.readTextFile(MIGRATION)).replace(/\r\n/g, "\n");
    const start = sql.indexOf("insert into public.avalara_tax_codes (code, description, source, north_america) values");
    assert(start >= 0, "the seed insert moved");
    const block = sql.slice(start, sql.indexOf("on conflict (code) do nothing;", start));
    const seeded = [...block.matchAll(/^\s*\('([A-Z0-9]+)',\s*'((?:[^']|'')*)',\s*'seed',\s*true\)/gm)];
    assertEquals(seeded.map((m) => m[1]), COMMON_CODES.map((c) => c.code));
    for (const m of seeded) assert(m[2].length > 0 && m[2].length <= DESCRIPTION_MAX, `${m[1]} has a description within the cap`);
  },
});

Deno.test({
  name: "migration 246's CHECKs accept what this module writes, and nothing looser",
  ignore: !canRead,
  fn: async () => {
    const sql = (await Deno.readTextFile(MIGRATION)).replace(/\r\n/g, "\n");
    assert(sql.includes("code          text        primary key check (code ~ '^[A-Z0-9]{1,25}$')"), "the code CHECK moved or changed");
    assert(sql.includes(`check (char_length(description) <= ${DESCRIPTION_MAX})`), "DESCRIPTION_MAX and the description CHECK differ");
    assert(sql.includes("check (target_type in ('style', 'heading'))"), "the target_type CHECK changed");
    const heading = sql.match(/target_type = 'heading' and target_key ~ '([^']+)'/);
    const style = sql.match(/target_type = 'style'\s+and target_key ~ '([^']+)'/);
    assert(heading && style, "the target key shape CHECK moved");
    const headingShape = new RegExp(heading![1]), styleShape = new RegExp(style![1]);
    for (const h of TAX_HEADINGS) assert(headingShape.test(h.key), `heading key ${h.key} fails the database's shape CHECK`);
    assert(styleShape.test(STYLE_A), "a lowercase uuid fails the style CHECK");
    assert(!styleShape.test(STYLE_A.toUpperCase()), "the style CHECK accepts an uppercase uuid the parser never writes");
    // The parser lowercases every style id it accepts, so what it returns always passes.
    const parsed = parseAssignmentsPayload({ rows: [{ code: "P0000000", targets: [{ type: "style", key: STYLE_A.toUpperCase() }] }] });
    assert(parsed.ok && styleShape.test(parsed.rows[0].targets[0].key), "a parsed style id would fail the CHECK");
    assert(sql.includes("check (type_id is null or type_id ~ '^[A-Z]{1,2}$')"), "the type_id CHECK and mapAvalaraTaxCode's shape differ");
    assert(sql.includes("check (parent_code is null or parent_code ~ '^[A-Z0-9]{1,25}$')"), "the parent_code CHECK changed");
    // RLS on, and the PUBLIC revoke present for both tables.
    for (const t of ["avalara_tax_codes", "tax_code_assignments"]) {
      assert(sql.includes(`alter table public.${t} enable row level security;`), `${t}: RLS`);
      assert(sql.includes(`revoke all on public.${t} from public;`), `${t}: the PUBLIC revoke`);
      assert(sql.includes(`revoke all on public.${t} from anon, authenticated;`), `${t}: the browser-role revoke`);
      assert(!new RegExp(`create policy[^;]*on public\\.${t}`, "i").test(sql), `${t}: no policies`);
    }
  },
});

// ── normalizeTaxCode ────────────────────────────────────────────────────────────────────────

Deno.test("a code is trimmed and uppercased, and anything else that is not letters and digits is refused", () => {
  assertEquals(normalizeTaxCode(" fr010000 "), "FR010000");
  assertEquals(normalizeTaxCode("NT"), "NT");
  assertEquals(normalizeTaxCode("A".repeat(25)), "A".repeat(25), "25 characters is Avalara's limit");
  for (const bad of ["", "   ", "A".repeat(26), "FR 010000", "FR-01", "P0000000;", "é1", null, undefined, 12345, ["NT"], { code: "NT" }]) {
    assertEquals(normalizeTaxCode(bad), null, `${JSON.stringify(bad)} must be refused`);
  }
});

// ── parseAssignmentsPayload ─────────────────────────────────────────────────────────────────

Deno.test("a mapping parses to its rows, with style ids lowercased and headings kept", () => {
  const r = parseAssignmentsPayload({
    rows: [
      { code: "p0000000", targets: [{ type: "style", key: STYLE_A.toUpperCase() }, { type: "heading", key: "doors" }] },
      { code: "FR010000", targets: [{ type: "heading", key: "delivery" }] },
    ],
  });
  assertEquals(r, {
    ok: true,
    rows: [
      { code: "P0000000", targets: [{ type: "style", key: STYLE_A }, { type: "heading", key: "doors" }] },
      { code: "FR010000", targets: [{ type: "heading", key: "delivery" }] },
    ],
  });
});

Deno.test("a row that covers nothing is dropped, whatever its code — the suggested rows start that way", () => {
  const r = parseAssignmentsPayload({
    rows: [
      { code: "", targets: [] },
      { code: null, targets: [] },
      { code: "P0000000" },
      { code: "not a code!", targets: [] },
      { code: "NT", targets: [{ type: "heading", key: "colors" }] },
    ],
  });
  assertEquals(r, { ok: true, rows: [{ code: "NT", targets: [{ type: "heading", key: "colors" }] }] });
  assertEquals(parseAssignmentsPayload({ rows: [] }), { ok: true, rows: [] }, "an empty mapping clears everything");
});

Deno.test("a row that covers something must carry a real code", () => {
  const blank = parseAssignmentsPayload({ rows: [{ code: " ", targets: [{ type: "heading", key: "doors" }] }] });
  assertEquals(blank.ok ? null : [blank.status, blank.reason], [400, "bad_code"]);
  assert(!blank.ok && /Pick a tax code/.test(blank.error));
  const bad = parseAssignmentsPayload({ rows: [{ code: "FR-01", targets: [{ type: "heading", key: "doors" }] }] });
  assertEquals(bad.ok ? null : [bad.status, bad.reason], [400, "bad_code"]);
  assert(!bad.ok && bad.error.includes("FR-01"), "the refusal names what was sent");
});

Deno.test("an unknown heading, a malformed style id and an unknown target type are refused", () => {
  const cases: [unknown, string][] = [
    [{ type: "heading", key: "roofing" }, "unknown_heading"],
    [{ type: "heading", key: "DOORS" }, "unknown_heading"],
    [{ type: "heading", key: "__proto__" }, "unknown_heading"],
    [{ type: "style", key: "lofted-barn" }, "bad_style"],
    [{ type: "style", key: STYLE_A + "0" }, "bad_style"],
    [{ type: "line_kind", key: "door" }, "bad_payload"],
    [{ key: "doors" }, "bad_payload"],
    ["doors", "bad_payload"],
    [null, "bad_payload"],
  ];
  for (const [target, reason] of cases) {
    const r = parseAssignmentsPayload({ rows: [{ code: "P0000000", targets: [target] }] });
    assertEquals(r.ok ? null : [r.status, r.reason], [400, reason], JSON.stringify(target));
  }
});

Deno.test("the same target in two rows is refused; repeated inside one row it is kept once", () => {
  const two = parseAssignmentsPayload({
    rows: [
      { code: "P0000000", targets: [{ type: "heading", key: "doors" }] },
      { code: "NT", targets: [{ type: "heading", key: "doors" }] },
    ],
  });
  assertEquals(two.ok ? null : [two.status, two.reason], [400, "duplicate_target"]);
  const styleTwice = parseAssignmentsPayload({
    rows: [
      { code: "P0000000", targets: [{ type: "style", key: STYLE_A }] },
      { code: "NT", targets: [{ type: "style", key: STYLE_A.toUpperCase() }] },
    ],
  });
  assertEquals(styleTwice.ok ? null : styleTwice.reason, "duplicate_target", "case does not make a style a different target");
  const once = parseAssignmentsPayload({
    rows: [{ code: "P0000000", targets: [{ type: "heading", key: "doors" }, { type: "heading", key: "doors" }] }],
  });
  assertEquals(once, { ok: true, rows: [{ code: "P0000000", targets: [{ type: "heading", key: "doors" }] }] });
  const sameKeyOtherType = parseAssignmentsPayload({
    rows: [{ code: "P0000000", targets: [{ type: "heading", key: "doors" }, { type: "style", key: STYLE_B }] }],
  });
  assert(sameKeyOtherType.ok, "a style and a heading are different targets");
});

Deno.test("more than 50 rows or 200 targets is refused before anything is dropped", () => {
  const rows = Array.from({ length: MAX_ASSIGNMENT_ROWS + 1 }, () => ({ code: "", targets: [] }));
  const many = parseAssignmentsPayload({ rows });
  assertEquals(many.ok ? null : [many.status, many.reason], [400, "too_many_rows"]);
  assert(parseAssignmentsPayload({ rows: rows.slice(1) }).ok, "exactly 50 rows is allowed");

  const targets = Array.from({ length: MAX_ASSIGNMENT_TARGETS + 1 }, () => ({ type: "heading", key: "doors" }));
  const wide = parseAssignmentsPayload({ rows: [{ code: "P0000000", targets }] });
  assertEquals(wide.ok ? null : [wide.status, wide.reason], [400, "too_many_targets"]);
  const atCap = parseAssignmentsPayload({ rows: [{ code: "P0000000", targets: targets.slice(1) }] });
  assert(atCap.ok, "200 targets is allowed (and a repeat inside a row collapses)");
});

Deno.test("a body that is not a mapping is refused, not read as 'clear everything'", () => {
  for (const body of [null, undefined, "rows", 7, {}, { rows: "x" }, { rows: { 0: {} } }]) {
    const r = parseAssignmentsPayload(body);
    assertEquals(r.ok ? null : [r.status, r.reason], [400, "bad_payload"], JSON.stringify(body));
  }
  for (const rows of [[null], ["P0000000"], [{ code: "NT", targets: "doors" }]]) {
    const r = parseAssignmentsPayload({ rows });
    assertEquals(r.ok ? null : r.reason, "bad_payload", JSON.stringify(rows));
  }
});

// ── searchQuery ─────────────────────────────────────────────────────────────────────────────

Deno.test("a search is trimmed, capped, and its ILIKE metacharacters are literal", () => {
  assertEquals(searchQuery("  delivery "), "delivery");
  assertEquals(searchQuery("10%"), "10\\%");
  assertEquals(searchQuery("fr_01"), "fr\\_01");
  assertEquals(searchQuery("a\\b"), "a\\\\b", "the escape character itself is escaped first");
  assertEquals(searchQuery("lumber*"), "lumber", "PostgREST turns * into % before Postgres sees it, so it is dropped");
  assertEquals(searchQuery("x".repeat(SEARCH_MAX + 20)), "x".repeat(SEARCH_MAX));
  for (const blank of ["", "   ", "***", null, undefined, 42, ["fr"]]) assertEquals(searchQuery(blank), "", JSON.stringify(blank));
});

// ── Views, ordering, merging ────────────────────────────────────────────────────────────────

Deno.test("a catalog row reads as the portal's shape, with a hint only on a common code", () => {
  assertEquals(taxCodeView({ code: "FR010000", description: "Delivery by company vehicle", type_id: "F", is_active: true }), {
    code: "FR010000", description: "Delivery by company vehicle", typeId: "F", isActive: true, hint: "Delivery on your own truck",
  });
  assertEquals(taxCodeView({ code: "PA3000400", description: "Lumber", type_id: "", is_active: false }), {
    code: "PA3000400", description: "Lumber", typeId: null, isActive: false, hint: null,
  });
  assertEquals(taxCodeView({ code: "X1", is_active: "true" }).isActive, false, "only a real true is active");
});

Deno.test("common codes lead in their own order, then everything else by code", () => {
  const got = orderCodes([{ code: "ZZ1" }, { code: "OH010000" }, { code: "AA1" }, { code: "P0000000" }, { code: "FR010000" }]);
  assertEquals(got.map((c) => c.code), ["P0000000", "FR010000", "OH010000", "AA1", "ZZ1"]);
});

Deno.test("merged results keep the first list's order, drop repeats and stop at the limit", () => {
  const a = [{ code: "FR010000" }, { code: "FR010100" }];
  const b = [{ code: "FR010100" }, { code: "OH010000" }, { code: "FR030000" }];
  assertEquals(mergeCodeLists(a, b).map((c) => c.code), ["FR010000", "FR010100", "OH010000", "FR030000"]);
  assertEquals(mergeCodeLists(a, b, 3).map((c) => c.code), ["FR010000", "FR010100", "OH010000"]);
  const many = Array.from({ length: 80 }, (_, i) => ({ code: `C${i}` }));
  assertEquals(mergeCodeLists(many, many).length, TAX_CODE_SEARCH_LIMIT);
});

Deno.test("stored assignments for a deleted style or a retired heading are not shown", () => {
  const got = visibleAssignments([
    { target_type: "style", target_key: STYLE_A, tax_code: "P0000000" },
    { target_type: "style", target_key: STYLE_B, tax_code: "P0000000" },
    { target_type: "heading", target_key: "doors", tax_code: "P0000000" },
    { target_type: "heading", target_key: "roofing", tax_code: "P0000000" },
    { target_type: "line_kind", target_key: "door", tax_code: "P0000000" },
  ], new Set([STYLE_A]));
  assertEquals(got, [
    { targetType: "style", targetKey: STYLE_A, code: "P0000000" },
    { targetType: "heading", targetKey: "doors", code: "P0000000" },
  ]);
  assertEquals(visibleAssignments(null as never, new Set()), []);
});

// ── planAssignments ─────────────────────────────────────────────────────────────────────────

Deno.test("the save plan writes new and changed targets, skips unchanged ones and deletes the rest", () => {
  const stored = [
    { target_type: "style", target_key: STYLE_A, tax_code: "P0000000" },   // unchanged
    { target_type: "heading", target_key: "delivery", tax_code: "FR010000" }, // moved to another code
    { target_type: "heading", target_key: "doors", tax_code: "P0000000" },    // unticked
    { target_type: "style", target_key: STYLE_B, tax_code: "P0000000" },    // unticked
  ];
  const plan = planAssignments(stored, [
    { code: "P0000000", targets: [{ type: "style", key: STYLE_A }, { type: "heading", key: "windows" }] },
    { code: "ON030000", targets: [{ type: "heading", key: "delivery" }] },
  ]);
  assertEquals(plan, {
    upserts: [
      { target_type: "heading", target_key: "windows", tax_code: "P0000000" },
      { target_type: "heading", target_key: "delivery", tax_code: "ON030000" },
    ],
    deleteStyles: [STYLE_B],
    deleteHeadings: ["doors"],
    unchanged: 1,
  });
});

Deno.test("a target moved between rows is re-coded, never deleted", () => {
  const stored = [{ target_type: "heading", target_key: "foundation", tax_code: "P0000000" }];
  const plan = planAssignments(stored, [{ code: "SC150100", targets: [{ type: "heading", key: "foundation" }] }]);
  assertEquals(plan.upserts, [{ target_type: "heading", target_key: "foundation", tax_code: "SC150100" }]);
  assertEquals([plan.deleteStyles, plan.deleteHeadings, plan.unchanged], [[], [], 0]);
});

Deno.test("an empty mapping deletes every stored target, and an identical one writes nothing", () => {
  const stored = [
    { target_type: "style", target_key: STYLE_A, tax_code: "P0000000" },
    { target_type: "heading", target_key: "delivery", tax_code: "FR010000" },
  ];
  assertEquals(planAssignments(stored, []), { upserts: [], deleteStyles: [STYLE_A], deleteHeadings: ["delivery"], unchanged: 0 });
  const same = planAssignments(stored, [
    { code: "P0000000", targets: [{ type: "style", key: STYLE_A }] },
    { code: "FR010000", targets: [{ type: "heading", key: "delivery" }] },
  ]);
  assertEquals(same, { upserts: [], deleteStyles: [], deleteHeadings: [], unchanged: 2 });
});

// ── mapAvalaraTaxCode ───────────────────────────────────────────────────────────────────────

Deno.test("a ListTaxCodes entry maps to the five catalog columns and nothing else", () => {
  const row = mapAvalaraTaxCode({
    id: 12345, companyId: 67890, createdUserId: 111, modifiedUserId: 222, isSSTCertified: true,
    taxCode: "FR010000", description: "Delivery by company vehicle", taxCodeTypeId: "F",
    parentTaxCode: "FR000000", isActive: true, isPhysical: false,
  });
  assertEquals(row, {
    code: "FR010000", description: "Delivery by company vehicle", type_id: "F", parent_code: "FR000000",
    is_active: true, north_america: true,
  });
});

Deno.test("an entry whose code cannot be a code is skipped; odd fields degrade to unknown", () => {
  for (const taxCode of [null, "", "FR 01", "x".repeat(26), 42]) {
    assertEquals(mapAvalaraTaxCode({ taxCode, description: "d" }), null, JSON.stringify(taxCode));
  }
  assertEquals(mapAvalaraTaxCode(null), null);
  const odd = mapAvalaraTaxCode({ taxCode: "pa3000400", description: null, taxCodeTypeId: "Product", parentTaxCode: "n/a" })!;
  assertEquals(odd, { code: "PA3000400", description: "", type_id: null, parent_code: null, is_active: true, north_america: true });
});

Deno.test("only an explicit isActive false deactivates", () => {
  assertEquals(mapAvalaraTaxCode({ taxCode: "NT", description: "d", isActive: false })!.is_active, false);
  assertEquals(mapAvalaraTaxCode({ taxCode: "NT", description: "d" })!.is_active, true);
  assertEquals(mapAvalaraTaxCode({ taxCode: "NT", description: "d", isActive: "false" })!.is_active, true);
});

Deno.test("a code whose description says it is not applicable to North America is marked so", () => {
  const vat = mapAvalaraTaxCode({ taxCode: "PC040100", description: "Clothing - children (NOT APPLICABLE TO NORTH AMERICA)" })!;
  assertEquals(vat.north_america, false);
  assertEquals(mapAvalaraTaxCode({ taxCode: "P0000000", description: "Tangible personal property (tpp)" })!.north_america, true);
});

Deno.test("a long description is clipped to the column's cap rather than failing a chunk", () => {
  const row = mapAvalaraTaxCode({ taxCode: "P1", description: "  " + "d".repeat(DESCRIPTION_MAX + 50) })!;
  assertEquals(row.description.length, DESCRIPTION_MAX);
});
