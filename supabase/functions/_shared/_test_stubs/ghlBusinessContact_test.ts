// What submit-estimate sends GoHighLevel for a quote to a BUSINESS (2026-10-21), run from the
// shipped source. Junior Barns' "Bear River Band" got "Hi Bear" because the contact upsert sent
// name = "Bear River Band" and GoHighLevel took its first word as the first name, and the CRM
// estimate was titled "Bear - <style size>".
//
// No tenant we may test in has GoHighLevel connected (structure-studio has none; Junior Barns and
// Yoder are real clients), so these payloads are proven here instead of live. Same technique as
// ghlAuthRefusal_test: lift the real code out of submit-estimate/index.ts by its anchors and run
// it, so the test fails when the shipped code changes, not when a copy of it does.
//
// What it pins: WITHOUT a company every payload is byte for byte the old one (`{ name }`, the
// first-word title, contactDetails.name). WITH one: firstName/lastName from the person, companyName,
// no `name`; the estimate titled by the company; contactDetails carrying companyName.
//
// Made-up people and businesses only: this repo is public.
// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert@1";
import { companyOf, ghlContactNameFields, personName } from "../customerNaming.ts";

const SUBMIT = Deno.readTextFileSync(new URL("../../submit-estimate/index.ts", import.meta.url)).replace(/\r\n/g, "\n");

/** The text from `open` (an opening bracket at index i) to its matching close, skipping strings,
 *  template literals and comments. */
function balanced(src: string, i: number): string {
  const pairs: Record<string, string> = { "{": "}", "(": ")", "[": "]" };
  const stack: string[] = [];
  for (let k = i; k < src.length; k++) {
    const c = src[k];
    if (c === "/" && src[k + 1] === "/") { k = src.indexOf("\n", k); continue; }
    if (c === "/" && src[k + 1] === "*") { k = src.indexOf("*/", k + 2) + 1; continue; }
    if (c === '"' || c === "'" || c === "`") {
      for (k++; k < src.length && src[k] !== c; k++) if (src[k] === "\\") k++;
      continue;
    }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === stack[stack.length - 1]) { stack.pop(); if (!stack.length) return src.slice(i, k + 1); }
  }
  throw new Error("ghlBusinessContact_test: unbalanced block");
}
function after(anchor: string, opener: string, from = 0): string {
  const a = SUBMIT.indexOf(anchor, from);
  if (a < 0) throw new Error(`ghlBusinessContact_test: anchor ${JSON.stringify(anchor)} is gone from submit-estimate — update the test`);
  return balanced(SUBMIT, SUBMIT.indexOf(opener, a));
}

// The upsert body: the object handed to JSON.stringify on the contacts/upsert call.
const upsertAt = SUBMIT.indexOf('"https://services.leadconnectorhq.com/contacts/upsert"');
const UPSERT_OBJ = after("body: JSON.stringify(", "{", upsertAt);
// The CRM estimate's title: the three statements ending at estimateName.
const titleStart = SUBMIT.indexOf("const customerCompany = companyOf(contact);");
const titleEnd = SUBMIT.indexOf("\n", SUBMIT.indexOf("const estimateName = ", titleStart));
const TITLE = SUBMIT.slice(titleStart, titleEnd);
// The estimate's contactDetails object.
const DETAILS_OBJ = after("contactDetails: {", "{");

const upsertBody = (contact: any) =>
  new Function("contact", "locationId", "upsertAddress", "ghlContactNameFields", `return (${UPSERT_OBJ});`)(
    contact, "loc-example", null, ghlContactNameFields);
const title = (contact: any) =>
  new Function("contact", "styleLabel", "size", "companyOf", `${TITLE}\nreturn estimateName;`)(
    contact, "Lofted Barn", "12x24", companyOf);
const details = (contact: any) =>
  new Function("contact", "customerCompany", "personName", "formattedPhone", "estimateAddress", "contactId", `return (${DETAILS_OBJ});`)(
    contact, companyOf(contact), personName, "+15550100142", null, "ghl-c-1");

// The payloads as they were before this change, verbatim from the pre-change source.
const OLD = {
  upsert: (contact: any) => ({ name: contact?.name || "", email: contact?.email || "", phone: contact?.phone || "", locationId: "loc-example" }),
  title: (contact: any) => `${contact?.name ? String(contact.name).split(" ")[0] : "Customer"} - Lofted Barn 12x24`.trim(),
  details: (contact: any) => ({ name: contact?.name || "Unknown", email: contact?.email || "", phoneNo: "+15550100142", id: "ghl-c-1" }),
};

Deno.test("the lifted blocks are the shipped ones", () => {
  assert(UPSERT_OBJ.includes("...ghlContactNameFields(contact)"), "the upsert reads its name fields from customerNaming.ts");
  assert(!/\bname: contact\?\.name/.test(UPSERT_OBJ), "the upsert no longer sends the raw name");
  assert(TITLE.includes("const estimateName = "), TITLE);
  assert(DETAILS_OBJ.includes("companyName"), DETAILS_OBJ);
});

Deno.test("no company: the upsert, the title and contactDetails are exactly the old ones", () => {
  for (const contact of [
    { name: "Pat Example", email: "pat@example.test", phone: "(555) 010-0199" },
    { name: "Bear River Band", email: "", phone: "(555) 010-0142" },
    { name: "", company: "", email: "x@example.test" },
    { name: "Pat", company: "   " },
    {},
    undefined,
  ]) {
    const tag = JSON.stringify(contact);
    assertEquals(JSON.stringify(upsertBody(contact)), JSON.stringify(OLD.upsert(contact)), `upsert ${tag}`);
    assertEquals(title(contact), OLD.title(contact), `title ${tag}`);
    assertEquals(JSON.stringify(details(contact)), JSON.stringify(OLD.details(contact)), `details ${tag}`);
  }
});

Deno.test("Bear River Band: the person and the business are told apart", () => {
  const thomas = { name: "Thomas Example", company: "Bear River Band", email: "thomas@example.test", phone: "(555) 010-0142" };
  assertEquals(upsertBody(thomas), {
    firstName: "Thomas", lastName: "Example", companyName: "Bear River Band",
    email: "thomas@example.test", phone: "(555) 010-0142", locationId: "loc-example",
  });
  assert(!("name" in upsertBody(thomas)), "no `name` for GoHighLevel to split");
  assertEquals(title(thomas), "Bear River Band - Lofted Barn 12x24");
  assertEquals(details(thomas), { name: "Thomas Example", companyName: "Bear River Band", email: "thomas@example.test", phoneNo: "+15550100142", id: "ghl-c-1" });
});

Deno.test("a company with no person: no first name is sent, and the estimate is the company's", () => {
  for (const name of ["", "Bear River Band"]) {
    const c = { name, company: "Bear River Band", email: "band@example.test" };
    const body = upsertBody(c);
    assert(!("firstName" in body) && !("lastName" in body) && !("name" in body), `${name}: nothing that could blank a name GoHighLevel holds`);
    assertEquals(body.companyName, "Bear River Band");
    assertEquals(title(c), "Bear River Band - Lofted Barn 12x24");
    assertEquals(details(c).name, "Bear River Band", "contactDetails needs a name: the company stands in");
  }
});
