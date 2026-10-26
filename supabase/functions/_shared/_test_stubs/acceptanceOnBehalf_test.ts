// The acceptance certificate's "On behalf of" row (quote to a business entity, 2026-10-21): a
// customer signing for a business has the business printed under "Signed by". Absent, the page is
// the one it always was. Made-up names only: this repo is public.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PDFDocument } from "npm:pdf-lib@1.17.1";
import { appendAcceptancePage, onBehalfOfFrom } from "../acceptancePdf.ts";
import { pdfText } from "./pdfText.ts";

async function blankPdf(): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  d.addPage([612, 792]);
  return await d.save();
}
// What the page DRAWS, for comparing two documents. pdf-lib writes CreationDate and ModDate, to
// the second, into an object stream that pdfText inflates too, so two certificates made either
// side of a second boundary differ in their dates alone. That failed this test on the promotion
// gate's runner on 2026-10-26. Re-saved without object streams, the info dictionary stays out of
// every stream: estimatePdf_test's drawn() does the same.
async function drawn(bytes: Uint8Array): Promise<string> {
  return await pdfText(await (await PDFDocument.load(bytes, { updateMetadata: false })).save({ useObjectStreams: false }));
}
const CERT = {
  businessName: "Acme Sheds",
  quoteNumber: "AS-1041",
  total: 8400,
  signerName: "Thomas Example",
  method: "typed" as const,
  typedSignature: "Thomas Example",
  acceptedAtIso: "2026-10-21T12:00:00Z",
  ip: "203.0.113.7",
  consentText: "I accept estimate AS-1041 for $8,400.00.",
};

Deno.test("On behalf of prints under Signed by when there is a business", async () => {
  const t = await pdfText(await appendAcceptancePage(await blankPdf(), { ...CERT, onBehalfOf: "Bear River Band" }));
  const signed = t.indexOf("Signed by"), behalf = t.indexOf("On behalf of"), at = t.indexOf("Signed at");
  assert(signed >= 0 && behalf > signed && at > behalf, "Signed by, On behalf of, Signed at, in that order");
  assert(t.includes("Bear River Band"), "the business prints");
});

Deno.test("no business: no row, and the page is the one it always was", async () => {
  const base = await drawn(await appendAcceptancePage(await blankPdf(), CERT));
  assert(!base.includes("On behalf of"));
  assert(base.includes("Signed by") && base.includes("Thomas Example"), "the page itself is read");
  for (const onBehalfOf of [null, undefined, "", "   "]) {
    assertEquals(await drawn(await appendAcceptancePage(await blankPdf(), { ...CERT, onBehalfOf })), base, String(onBehalfOf));
  }
});

Deno.test("a long business name keeps to one line", async () => {
  const t = await pdfText(await appendAcceptancePage(await blankPdf(), { ...CERT, onBehalfOf: "Very Long Farm ".repeat(20) }));
  assert(/Very Long Farm[^)\n]*\.\.\./.test(t), "cut with an ellipsis");
});

Deno.test("onBehalfOfFrom: the contact's company, never for a guessable code", () => {
  assertEquals(onBehalfOfFrom({ name: "Thomas", company: " Bear River Band " }, "SS-ABCD2345EF"), "Bear River Band");
  assertEquals(onBehalfOfFrom({ name: "Thomas", company: "Bear River Band" }, "SS-ABC234"), null, "a legacy six-character code");
  for (const c of [{ name: "Thomas" }, { company: "" }, null, undefined]) assertEquals(onBehalfOfFrom(c, "SS-ABCD2345EF"), null, JSON.stringify(c));
});
