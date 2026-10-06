// Unit tests for the email signature (_shared/emailSignature.ts).
//
// WHY THESE EXIST. The signature is typed by a rep and lands in a customer's inbox under every
// email they send, so the two things that must never happen are pinned: markup in it reaching
// the HTML (it is plain text, escaped), and a stored value that breaks the save or the send (line
// endings, control characters, half an emoji, a value over the cap). The text form is pinned too,
// because the "-- " line is what mail programs key on and body_text keeps exactly this text.
//
// Run: deno test --node-modules-dir=none supabase/functions/_shared/emailSignature.test.ts

import { cleanSignature, EMAIL_SIGNATURE_MAX, signatureHtml, signText } from "./emailSignature.ts";

function check(name: string, cond: boolean, detail?: string) {
  if (!cond) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
}
function same<T>(name: string, actual: T, expected: T) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

Deno.test("cleanSignature: trimmed, line endings to \\n, and nothing that isn't a string", () => {
  same("trimmed", cleanSignature("  Jane Doe\nAcme Barns  \n"), "Jane Doe\nAcme Barns");
  same("CRLF and lone CR", cleanSignature("Jane\r\nAcme\rBarns"), "Jane\nAcme\nBarns");
  same("empty is none", cleanSignature(""), null);
  same("blank is none", cleanSignature(" \n\t "), null);
  same("a number is none", cleanSignature(42), null);
  same("null is none", cleanSignature(null), null);
  same("an object is none", cleanSignature({ text: "Jane" }), null);
});

Deno.test("cleanSignature: control characters go, tabs and newlines stay", () => {
  same("controls dropped", cleanSignature("Jane\u0000 Doe\u0007\u001B\u007F"), "Jane Doe");
  same("tab kept", cleanSignature("Jane\tDoe\nSales"), "Jane\tDoe\nSales");
});

Deno.test("cleanSignature: half an emoji becomes U+FFFD, a whole one is kept", () => {
  same("whole emoji", cleanSignature("Jane 😀"), "Jane 😀");
  same("lone high surrogate", cleanSignature("Jane \uD83D"), "Jane �");
  same("lone low surrogate", cleanSignature("\uDE00 Jane"), "� Jane");
});

Deno.test("cleanSignature: cut to the cap in characters, never through an emoji", () => {
  same("cap", EMAIL_SIGNATURE_MAX, 1000);
  same("at the cap is kept whole", cleanSignature("a".repeat(1000)), "a".repeat(1000));
  same("over the cap is cut", cleanSignature("a".repeat(1200))?.length, 1000);
  // 999 letters and then emoji: 1,000 characters is the 999 letters and one whole emoji.
  const cut = cleanSignature("a".repeat(999) + "😀😀") ?? "";
  same("emoji counted as one character", Array.from(cut).length, 1000);
  check("no half emoji at the end", cut.endsWith("😀"), JSON.stringify(cut.slice(-4)));
});

Deno.test("signText: the body, a blank line, \"-- \", then the signature", () => {
  same("signed", signText("Hi Cam,\nthe shed is ready.", "Jane Doe\nAcme Barns"), "Hi Cam,\nthe shed is ready.\n\n-- \nJane Doe\nAcme Barns");
  same("no signature leaves it alone", signText("Hi Cam", null), "Hi Cam");
  same("blank signature leaves it alone", signText("Hi Cam", "   "), "Hi Cam");
  same("trailing space before the line is dropped", signText("Hi Cam\n\n", "Jane"), "Hi Cam\n\n-- \nJane\n");
  same("a trailing newline stays at the end", signText("Hi Cam\n", "Jane"), "Hi Cam\n\n-- \nJane\n");
  same("the signature is cleaned on the way out too", signText("Hi", "  Jane\r\nAcme  "), "Hi\n\n-- \nJane\nAcme");
});

Deno.test("signatureHtml: escaped, line breaks as <br>, nothing when there is none", () => {
  const h = signatureHtml(`Jane <script>alert("x")</script> & Co\nSales`);
  check("no raw tag", !h.includes("<script>"), h);
  check("escaped tag", h.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; Co<br>Sales"), h);
  check("a block of its own", h.startsWith("<div ") && h.endsWith("</div>"), h);
  same("none", signatureHtml(null), "");
  same("blank", signatureHtml(" \n "), "");
});
