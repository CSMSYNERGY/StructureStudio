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
  const base = await pdfText(await appendAcceptancePage(await blankPdf(), CERT));
  assert(!base.includes("On behalf of"));
  for (const onBehalfOf of [null, undefined, "", "   "]) {
    assertEquals(await pdfText(await appendAcceptancePage(await blankPdf(), { ...CERT, onBehalfOf })), base, String(onBehalfOf));
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
