// The tax code wiring, pinned against the SHIPPED handlers (migration 246, 2026-09-17):
// portal-settings' tax_codes_get / tax_codes_search / tax_codes_save, and admin-catalog's
// avalara_sync_tax_codes and delete_client.
//
// taxCodes.test.ts and taxCodeSync.test.ts prove the decisions. What they cannot see is where the
// handlers call them, and every mistake worth pinning here is a short edit that throws nothing
// and passes every unit test and preflight:
//   1. avalara_sync_tax_codes added to READ_ONLY_ACTIONS — a read-only operator makes up to ten
//      authenticated Avalara requests and rewrites the catalog every builder searches;
//   2. the sync's refusal echoing the outcome's `status`/`ok` into the body;
//   3. a tax_codes_save check moved below a write — an unknown code or another tenant's style id
//      refused after part of the set was already written;
//   4. `.eq("client_id", clientId)` dropped from a tax_code_assignments or building_styles read or
//      write — one tenant's save deleting another tenant's heading rows, or accepting their styles;
//   5. the delete going back to the keys the stored read held (two saves at once leave a union of
//      both payloads), or the insert-if-missing losing ignoreDuplicates (updated_by rewritten on
//      every unchanged row);
//   6. the three gates leaving settings_crm:view/view/edit;
//   7. delete_client forgetting tax_code_assignments (a reused slug inherits the deleted company's
//      heading codes), or wiping it after other tables — deployed ahead of 246, that half-deletes;
//   8. a builder-side tax code action reaching Avalara;
//   9. avalara_tax_codes_status (the Admin console's catalog row) growing an Avalara call or a
//      read of anything but the catalog, while it sits on READ_ONLY_ACTIONS.
// Same technique as taxSpendWiring_test / locationTaxWiring_test: read the source, so a drift
// fails the push. If an anchor moves, re-point it — do not delete the test.

import { assert } from "jsr:@std/assert@1";

const FUNCTIONS = new URL("../../", import.meta.url);
const read = (rel: string) => Deno.readTextFile(new URL(rel, FUNCTIONS));

/** Source with whole-line comments removed, so a comment that NAMES a trap cannot trip it.
 *  Line endings are normalised first: a Windows checkout (core.autocrlf) reads CRLF. */
const code = (src: string) => src.replace(/\r\n/g, "\n").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");

const SETTINGS_RAW = await read("portal-settings/index.ts");
const SETTINGS = code(SETTINGS_RAW);
const CATALOG = code(await read("admin-catalog/index.ts"));

function block(src: string, start: string, end: string, label: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i + start.length);
  if (i < 0 || j < 0) {
    throw new Error(`taxCodesWiring_test: could not find the ${label} block (start=${i}, end=${j}). Re-point the anchors.`);
  }
  return src.slice(i, j);
}

const at = (src: string, needle: string, label: string, from = 0): number => {
  const i = src.indexOf(needle, from);
  assert(i >= 0, `taxCodesWiring_test: "${needle}" not found in ${label} — re-point this test`);
  return i;
};

/** One builder chain: from `admin.from("<table>")` to the end of its statement or array element. */
function chainOf(src: string, table: string, label: string, from = 0): string {
  const i = at(src, `admin.from("${table}")`, label, from);
  const ends = [";", "\n    admin.from(", "\n      admin.from(", "]);"].map((e) => src.indexOf(e, i + 1)).filter((e) => e > i);
  return src.slice(i, Math.min(...ends));
}

const GET = block(SETTINGS, "const taxCodesResponse = async", "\n  };\n", "taxCodesResponse");
const SEARCH = block(SETTINGS, 'if (action === "tax_codes_search") {', "\n  if (action ===", "tax_codes_search");
const SAVE = block(SETTINGS, 'if (action === "tax_codes_save") {', "\n  if (action ===", "tax_codes_save");

Deno.test("GATES: the three tax code actions sit on settings_crm, view/view/edit, beside the rates", () => {
  for (const [action, level] of [["tax_codes_get", "view"], ["tax_codes_search", "view"], ["tax_codes_save", "edit"]]) {
    const re = new RegExp(`\\n\\s*${action}:\\s*\\{\\s*area:\\s*"settings_crm",\\s*level:\\s*"${level}"\\s*\\}`);
    assert(re.test(SETTINGS), `${action}'s gate is no longer settings_crm:${level}`);
  }
  assert(/if \(action === "tax_codes_get"\) return await taxCodesResponse\(\);/.test(SETTINGS), "tax_codes_get no longer answers through taxCodesResponse");
});

Deno.test("tax_codes_save refuses everything before its first write: shape, then codes, then styles", () => {
  const parse = at(SAVE, "parseAssignmentsPayload(payload)", "tax_codes_save");
  const codeRead = at(SAVE, 'admin.from("avalara_tax_codes")', "tax_codes_save");
  const unknownCode = at(SAVE, '"unknown_code"', "tax_codes_save");
  const styleRead = at(SAVE, 'admin.from("building_styles")', "tax_codes_save");
  const unknownStyle = at(SAVE, '"unknown_style"', "tax_codes_save");
  const firstWrite = Math.min(at(SAVE, ".upsert(", "tax_codes_save"), at(SAVE, ".delete(", "tax_codes_save"));
  assert(parse < codeRead, "the catalog is read before the payload is parsed");
  assert(codeRead < unknownCode && unknownCode < styleRead, "the code refusal moved below the style check");
  assert(styleRead < unknownStyle && unknownStyle < firstWrite, "a refusal sits below a write — a refused save would already have changed the set");
  assert(/if \(!parsed\.ok\) return json\(\{ error: parsed\.error, reason: parsed\.reason \}, parsed\.status\);/.test(SAVE),
    "a parse refusal no longer answers with its own sentence, reason and status");
});

Deno.test("tax_codes_save is scoped to the resolved tenant on every read and write", () => {
  assert(/\.eq\("client_id", clientId\)/.test(chainOf(SAVE, "building_styles", "tax_codes_save")),
    "the style check is not limited to this tenant's styles — another tenant's style id would be accepted");
  assert(/\.eq\("client_id", clientId\)/.test(chainOf(SAVE, "tax_code_assignments", "tax_codes_save")),
    "the stored read is not limited to this tenant");

  // Every row written goes through stamp, which sets client_id AFTER the spread so nothing in a
  // planned row can override it.
  assert(/const stamp = \(a: PlannedAssignment\) => \(\{ \.\.\.a, client_id: clientId, updated_at: now, updated_by: userId \?\? null \}\);/.test(SAVE),
    "stamp no longer pins client_id (after the spread) and updated_by to the caller");
  const upserts = [...SAVE.matchAll(/\.upsert\(([\s\S]*?)\);/g)].map((m) => m[1]);
  assert(upserts.length === 2, `expected the changed-rows upsert and the insert-if-missing, found ${upserts.length}`);
  for (const u of upserts) {
    assert(/\.map\(stamp\)/.test(u), `an upsert writes rows that did not go through stamp: ${u}`);
    assert(/onConflict: "client_id,target_type,target_key"/.test(u), `an upsert's conflict target changed: ${u}`);
  }
  assert(/plan\.upserts\.map\(stamp\)/.test(upserts[0]) && !/ignoreDuplicates/.test(upserts[0]), "the changed rows must overwrite");
  assert(/plan\.kept\.map\(stamp\)/.test(upserts[1]) && /ignoreDuplicates: true/.test(upserts[1]),
    "the kept rows must be insert-if-missing — without ignoreDuplicates every unchanged row's updated_by is rewritten");

  assert((SAVE.match(/\.delete\(/g) ?? []).length === 1, "tax_codes_save deletes somewhere other than its one scoped delete");
  const del = SAVE.slice(at(SAVE, ".delete(", "tax_codes_save"), at(SAVE, "const { error, count } = await del;", "tax_codes_save"));
  assert(/\.eq\("client_id", clientId\)\.eq\("target_type", type\)/.test(del), "the delete is not limited to this tenant and this type");
});

Deno.test("tax_codes_save deletes by exclusion from the payload, after both writes, whatever the read held", () => {
  const lastUpsert = SAVE.lastIndexOf(".upsert(");
  const del = at(SAVE, ".delete(", "tax_codes_save");
  assert(lastUpsert < del, "the delete runs before an upsert — a failure between them loses an assignment the builder kept");
  assert(/for \(const \[type, keys\] of \[\["style", plan\.keepStyles\], \["heading", plan\.keepHeadings\]\] as const\)/.test(SAVE),
    "the delete no longer walks the payload's keep lists");
  assert(/if \(keys\.length\) del = del\.not\("target_key", "in", /.test(SAVE), "the delete no longer excludes the payload's keys");
  assert(!/\.in\("target_key"/.test(SAVE), "a delete by the stored read's keys is back — two saves at once leave both payloads");
  assert(!/deleteStyles|deleteHeadings/.test(SAVE), "the save plans its delete from the stored read again");
});

Deno.test("tax_codes_get reads only this tenant's settings, styles and assignments", () => {
  for (const table of ["client_settings", "building_styles", "tax_code_assignments"]) {
    assert(/\.eq\("client_id", clientId\)/.test(chainOf(GET, table, "taxCodesResponse")), `taxCodesResponse reads ${table} across tenants`);
  }
  assert(/visibleAssignments\(storedRes\.data \?\? \[\], new Set\(styles\.map/.test(GET),
    "stored assignments reach the builder without the style/heading visibility filter");
});

Deno.test("tax_codes_search reads the stored catalog only: active codes, North America unless asked", () => {
  assert(/admin\.from\("avalara_tax_codes"\)\.select\(columns\)\.eq\("is_active", true\)/.test(SEARCH), "the search no longer limits itself to active codes");
  assert(/return includeAll \? b : b\.eq\("north_america", true\);/.test(SEARCH), "the North America filter no longer defaults on");
  assert(/const q = searchQuery\(payload\?\.q\);/.test(SEARCH), "the typed text reaches ilike without searchQuery's escaping");
  for (const t of SEARCH.matchAll(/admin\.from\("([^"]+)"\)/g)) assert(t[1] === "avalara_tax_codes", `the search reads ${t[1]}`);
});

Deno.test("no builder-side tax code action reaches Avalara", () => {
  const builderSide = GET + SEARCH + SAVE;
  for (const needle of ["fetch(", "avalaraUrl", "avalaraHeaders", "syncTaxCodes", "fetchTaxCodes", "resolveRate(", "paidLookup("]) {
    assert(!builderSide.includes(needle), `a portal-settings tax code action calls ${needle}`);
  }
  assert(!/from\s+"\.\.\/_shared\/taxCodeSync\.ts"/.test(SETTINGS_RAW), "portal-settings imports the Avalara sync");
});

Deno.test("admin-catalog avalara_sync_tax_codes: never read-only, and its refusal carries no status or ok", () => {
  const readOnly = block(CATALOG, "const READ_ONLY_ACTIONS = new Set([", "]);", "READ_ONLY_ACTIONS");
  assert(!readOnly.includes("avalara_sync_tax_codes"),
    "avalara_sync_tax_codes is on the read-only list — a read-only operator could call Avalara and rewrite the catalog");
  const sync = block(CATALOG, 'case "avalara_sync_tax_codes": {', "\n      case ", "avalara_sync_tax_codes");
  assert(/const out = await syncTaxCodes\(sb\);/.test(sync), "the sync no longer runs through syncTaxCodes");
  assert(/const \{ status, ok: _ok, \.\.\.body \} = out;\s*return json\(body, status\);/.test(sync),
    "the refusal no longer strips status and ok before answering with the outcome's own status");
  const replies = [...sync.matchAll(/return json\(([^;]*)\);/g)].map((m) => m[1]);
  assert(replies.length === 2 && replies.includes("body, status") && replies.includes("out"), `unexpected answers: ${replies.join(" | ")}`);
});

Deno.test("admin-catalog avalara_tax_codes_status: read-only, reads the catalog and nothing else, never calls Avalara", () => {
  const readOnly = block(CATALOG, "const READ_ONLY_ACTIONS = new Set([", "]);", "READ_ONLY_ACTIONS");
  assert(readOnly.includes('"avalara_tax_codes_status"'), "the catalog status read is no longer on the read-only list");
  const status = block(CATALOG, 'case "avalara_tax_codes_status": {', "\n      case ", "avalara_tax_codes_status");
  const tables = [...status.matchAll(/sb\.from\("([^"]+)"\)/g)].map((m) => m[1]);
  assert(tables.length === 3 && tables.every((t) => t === "avalara_tax_codes"), `the status read touches ${tables.join(", ")}`);
  for (const needle of ["fetch(", "syncTaxCodes", "fetchTaxCodes", ".upsert(", ".update(", ".insert(", ".delete("]) {
    assert(!status.includes(needle), `the read-only catalog status calls ${needle}`);
  }
});

Deno.test("admin-catalog delete_client wipes tax_code_assignments, before anything else", () => {
  const del = block(CATALOG, 'case "delete_client": {', "\n      default:", "delete_client");
  const wipes = [...del.matchAll(/await wipe\("([^"]+)"\)/g)].map((m) => m[1]);
  assert(wipes.includes("tax_code_assignments"), "delete_client no longer wipes tax_code_assignments — a reused slug inherits the heading codes");
  assert(wipes[0] === "tax_code_assignments",
    `tax_code_assignments is wiped after ${wipes[0]} — deployed ahead of 246, the delete would fail half-way`);
  assert(/const \{ error, count \} = await sb\.from\(table\)\.delete\(\{ count: "exact" \}\)\.eq\("client_id", clientId\);/.test(del),
    "wipe is no longer scoped to the deleted tenant");
});
