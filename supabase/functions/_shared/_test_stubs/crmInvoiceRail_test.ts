// "Does this deal have an invoice?" — tested against the SHIPPED portal source.
//
// Carolyn, 2026-09-02, on a record with nothing billed: "can we make this like hide this if
// it doesn't have an invoice?" This pins the predicate that answers her, and it exists
// because BOTH halves of it are counter-intuitive and each has a live counter-example:
//
//   * ss_invoice_sent_at alone is wrong. Its only writer is send_invoice, so it marks a
//     StructureStudio-issued invoice and nothing else. sync-design-status, which is what
//     flips a GHL-quoted design to 'invoiced', writes {status, updated_at} and never touches
//     it; migration 136's backfill was narrowed to issued_by='structurestudio'. On live that
//     leaves FOURTEEN of junior-barns' invoiced buildings with the column NULL — every one
//     of them physically on the build board. Since invoice_in_ghl defaults true, this half
//     alone would hide the rails on most real tenants' sold work.
//
//   * status alone is also wrong. Since 136, send_invoice deliberately stopped flipping it,
//     so an SS invoice that is OUT BUT UNSIGNED reads 'accepted' with only the column set.
//     One such row on structure-studio today. An invoice sitting in the customer's inbox is
//     one they HAVE.
//
// Neither half is redundant, and a future reader tidying one away is exactly what this
// catches. Same technique as wallSlab_test / crmRecordGate_test: slice the real code between
// stable anchors, guard loudly if they move, run it.

import { assert, assertEquals } from "jsr:@std/assert";

const SALES = await Deno.readTextFile(
  new URL("../../../../portal/02-sales.jsx", import.meta.url),
);
const CORE = await Deno.readTextFile(
  new URL("../../../../portal/01-core.jsx", import.meta.url),
);

// ⚠️ THE REAL normStatus, NOT A STUB. crmRecordGate_test injects
// `(s) => String(s||"").toLowerCase()`, which is NOT what 01-core.jsx does — the real one is
// `STATUS_LABELS[s] ? s : "sent"`, a WHITELIST that falls back rather than a lowercaser.
// This whole test is about status classification, so stubbing it would test the stub. That
// difference is load-bearing: it is why 'inventory' and 'INVOICED' both read false below.
const LBL_START = "const STATUS_LABELS = {";
const NORM = "const normStatus = (s) =>";
const li = CORE.indexOf(LBL_START);
const ni = CORE.indexOf(NORM);
if (li < 0 || ni < 0) {
  throw new Error(
    `crmInvoiceRail_test: could not find STATUS_LABELS (${li}) or normStatus (${ni}) in ` +
      "portal/01-core.jsx. The anchors moved — re-point them rather than deleting this test.",
  );
}
const LABELS = CORE.slice(li, CORE.indexOf("\n", li) + 1);
const NORM_LINE = CORE.slice(ni, CORE.indexOf("\n", ni) + 1);

// The slice runs to the statement's own closing "\n);" — the multi-line shape it is written
// in. Written explicitly rather than as the first ");" after the start, because that form
// silently swallows hundreds of unrelated lines the moment the predicate is rewritten as a
// one-liner, and then fails deep inside `new Function` with a syntax error that says nothing
// about what actually changed.
const PRED_START = "const crmHasInvoice = (d) =>";
const PRED_END = "\n);";
const pi = SALES.indexOf(PRED_START);
const pj = pi < 0 ? -1 : SALES.indexOf(PRED_END, pi);
if (pi < 0 || pj < 0) {
  throw new Error(
    `crmInvoiceRail_test: could not extract crmHasInvoice from portal/02-sales.jsx ` +
      `(start=${pi}, end=${pj}). It moved, was renamed, or was reshaped onto one line — ` +
      "re-point this test rather than deleting it.",
  );
}
const PRED = SALES.slice(pi, pj + PRED_END.length);

// Sanity: a bad anchor yielding an empty slice would make every case below pass vacuously.
assert(LABELS.includes("invoiced"), "STATUS_LABELS slice looks wrong");
assert(NORM_LINE.includes("STATUS_LABELS[s]"), "normStatus slice looks wrong");
// This one catches TWO different mistakes, so it says both. A bad slice is the obvious one;
// the other is a reader deleting the ss_invoice_sent_at half as redundant — the exact
// "simplification" the header argues against, which would hide the rails on every
// StructureStudio invoice that is out but not yet signed.
assert(
  PRED.includes("ss_invoice_sent_at"),
  "crmHasInvoice no longer mentions ss_invoice_sent_at — either the slice is wrong, or that " +
    "half of the predicate was removed. It is NOT redundant: it is the only signal for an SS " +
    "invoice that has been sent and not yet signed, which `status` cannot express.",
);
assert(
  PRED.includes("normStatus"),
  "crmHasInvoice no longer consults normStatus — either the slice is wrong, or the status " +
    "half was removed. It is NOT redundant: a GHL-issued invoice never writes " +
    "ss_invoice_sent_at, and 14 live junior-barns buildings depend on this half alone.",
);

type Design = Record<string, unknown> | null | undefined;
const crmHasInvoice = new Function(
  `${LABELS}\n${NORM_LINE}\n${PRED}\nreturn crmHasInvoice;`,
)() as (d: Design) => boolean;

const SENT_AT = "2026-09-02T10:00:00Z";

Deno.test("an SS invoice that is OUT BUT UNSIGNED counts — the case status alone misses", () => {
  // send_invoice writes the column and deliberately leaves status alone (migration 136).
  // One row on structure-studio is in exactly this state today.
  assertEquals(crmHasInvoice({ status: "accepted", ss_invoice_sent_at: SENT_AT }), true);
});

Deno.test("a GHL-invoiced design counts on status alone — the case the column misses", () => {
  // ⚠️ 14 live rows on junior-barns look exactly like this. If someone ever "simplifies"
  // crmHasInvoice down to the column, this is the assertion that stops it, and the number is
  // why: those are buildings on the build board whose rails would silently disappear.
  assertEquals(crmHasInvoice({ status: "invoiced", ss_invoice_sent_at: null }), true);
  assertEquals(crmHasInvoice({ status: "delivered", ss_invoice_sent_at: null }), true);
});

Deno.test("both signals together still count once", () => {
  assertEquals(crmHasInvoice({ status: "invoiced", ss_invoice_sent_at: SENT_AT }), true);
});

Deno.test("nothing billed yet reads false", () => {
  assertEquals(crmHasInvoice({ status: "sent", ss_invoice_sent_at: null }), false);
  // Accepted is a signed QUOTE, not a bill. This is the Orders tab's "Needs invoice" state,
  // and it is the main thing Carolyn wanted the rails off for.
  assertEquals(crmHasInvoice({ status: "accepted", ss_invoice_sent_at: null }), false);
  assertEquals(crmHasInvoice({ status: "draft" }), false);
});

Deno.test("normStatus is a WHITELIST, not a lowercaser — pinned so nobody 'fixes' it", () => {
  // 'inventory' is a real designs.status value that is NOT in STATUS_LABELS, so it falls
  // through to "sent" and reads false. And 'INVOICED' is not 'invoiced': the real normStatus
  // does no case folding, so an upper-case value is unrecognised rather than matched. A
  // helpful lowercase() added to normStatus one day would flip this, which is the point.
  assertEquals(crmHasInvoice({ status: "inventory" }), false);
  assertEquals(crmHasInvoice({ status: "INVOICED" }), false);
});

Deno.test("a missing design never throws — the pre-deploy window", () => {
  // The portal auto-deploys on push; portal-settings is deployed separately. Between those
  // two moments ss_invoice_sent_at is undefined on every record, and on a contact with
  // nothing picked the subject is null outright. Neither may throw on a customer's screen.
  assertEquals(crmHasInvoice(null), false);
  assertEquals(crmHasInvoice(undefined), false);
  assertEquals(crmHasInvoice({}), false);
  // Mid-window, a GHL-invoiced design still shows its rails on status alone. That is the
  // deploy-order argument made executable: the union degrades, the column alone would not.
  assertEquals(crmHasInvoice({ status: "invoiced" }), true);
});

Deno.test("an empty column is not a truthy one", () => {
  // PostgREST returns null, but a "" would sneak past a bare `!!d.ss_invoice_sent_at ||`
  // if the column ever became a text default. It does not today; asserted so it stays so.
  assertEquals(crmHasInvoice({ status: "accepted", ss_invoice_sent_at: "" }), false);
});
