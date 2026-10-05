// Operator view-as reads the SAME columns the owner's Designs and Contacts lists read
// (2026-10-04), pinned against the shipped sources.
//
// DesignsTable and LeadsTable take their rows from a direct PostgREST read on the owner's own
// portal and from operator-portal's get_portal in view-as, and operator-portal's own comment
// says it: "Adding a column to either owner read means adding it here too." Nothing checked
// it. The Pipeline gained total_cents and expected_close_date (migration 206) on the owner
// read only, so in view-as every card read "No quote yet" with no close date — silently,
// because a missing column is just an undefined field.
//
// If an anchor moves, re-point it — do not delete the test.

import { assert } from "jsr:@std/assert@1";

const SALES = (await Deno.readTextFile(new URL("../../../../portal/02-sales.jsx", import.meta.url))).replace(/\r\n/g, "\n");
const OP = (await Deno.readTextFile(new URL("../../operator-portal/index.ts", import.meta.url))).replace(/\r\n/g, "\n");

const cols = (s: string) => s.split(",").map((c) => c.trim()).filter(Boolean);

/** The designs select inside a component, by its function header. */
function ownerDesignsSelect(fn: string): string[] {
  const i = SALES.indexOf(`function ${fn}(`);
  assert(i >= 0, `viewAsDesignColumns_test: ${fn} not found in portal/02-sales.jsx — re-point`);
  const j = SALES.indexOf('sb.from("designs")', i);
  assert(j >= 0, `viewAsDesignColumns_test: ${fn}'s designs read not found — re-point`);
  const m = /\.select\(`([^`]*)`\)/.exec(SALES.slice(j, j + 4000));
  assert(m, `viewAsDesignColumns_test: ${fn}'s designs select not found — re-point`);
  // ${SEL_LIST_COLS} projects two keys out of `selections`; view-as ships the whole column.
  return cols(m![1]).map((c) => (c === "${SEL_LIST_COLS}" ? "selections" : c));
}

function operatorDesignsSelect(): string[] {
  const i = OP.indexOf('admin.from("designs")');
  assert(i >= 0, "viewAsDesignColumns_test: operator-portal's designs read not found — re-point");
  const m = /\.select\("([^"]*)"\)/.exec(OP.slice(i, i + 2000));
  assert(m, "viewAsDesignColumns_test: operator-portal's designs select not found — re-point");
  return cols(m![1]);
}

for (const fn of ["DesignsTable", "LeadsTable"]) {
  Deno.test(`view-as serves every column ${fn} reads`, () => {
    const op = new Set(operatorDesignsSelect());
    const missing = ownerDesignsSelect(fn).filter((c) => !op.has(c));
    assert(missing.length === 0, `operator-portal get_portal does not select ${missing.join(", ")} — ${fn} renders them empty in view-as`);
  });
}
