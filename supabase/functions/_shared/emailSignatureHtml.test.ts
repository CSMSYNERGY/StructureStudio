// The security contract for rich email signatures. Every case here is something that reaches a
// customer's inbox if it gets through, so a failure means the design is wrong, not the test.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  cleanSignatureHtml,
  signatureHtmlToText,
  signatureLinkUrl,
  signatureImageUrl,
  SIGNATURE_HTML_MAX,
} from "./emailSignatureHtml.ts";
import { cleanRichText } from "./emailBlocks.ts";

const ORIGIN = "https://jzeamjbhdrsbygdnphbm.supabase.co";
const IMG = `${ORIGIN}/storage/v1/object/public/form-assets/junior-barns/0f8c9a21-4b3e-4a51-9f2d-7c1e5a9b3d04.png`;
const clean = (h: string) => cleanSignatureHtml(h, ORIGIN) ?? "";

Deno.test("script, style and their contents never survive", () => {
  for (const bad of [
    `<p>Jane</p><script>alert(1)</script>`,
    `<p>Jane</p><SCRIPT>alert(1)</SCRIPT>`,
    `<p>Jane</p><script >alert(1)</script >`,
    `<p>Jane</p><script\n>alert(1)</script>`,
    `<p>Jane</p><style>body{color:red}</style>`,
    `<p>Jane</p><noscript>x</noscript>`,
    `<p>Jane</p><iframe src="https://evil.test"></iframe>`,
    `<p>Jane</p><object data="x"></object>`,
    `<p>Jane</p><svg onload="alert(1)"></svg>`,
  ]) {
    const got = clean(bad);
    assert(!/alert\(1\)/.test(got), `script body survived: ${bad} -> ${got}`);
    assert(!/<(script|style|iframe|object|svg|noscript)/i.test(got), `tag survived: ${bad} -> ${got}`);
    assert(/Jane/.test(got), `real content lost: ${bad} -> ${got}`);
  }
  // An unclosed killer must not leave its body behind either.
  assert(!/alert/.test(clean(`<p>Jane</p><script>alert(1)`)));
  // The spliced form: stripping the inner tag must not weld a working one back together.
  assert(!/<script/i.test(clean(`<scr<script>ipt>alert(1)</script>`)));
});

Deno.test("event handlers and every un-allow-listed attribute are dropped", () => {
  const got = clean(`<img src="${IMG}" onerror="alert(1)" onload="x()" class="MsoNormal" id="a" data-x="y">`);
  assert(/<img /.test(got), got);
  assert(!/onerror|onload|class=|id=|data-x/i.test(got), got);
  const p = clean(`<p onclick="alert(1)" class="MsoNormal" lang="en" dir="rtl" bgcolor="red">Jane</p>`);
  assertEquals(p, "<p>Jane</p>");
});

Deno.test("an img src is only ever our own public bucket", () => {
  assertEquals(signatureImageUrl(IMG, ORIGIN), IMG);
  for (const bad of [
    "https://evil.example.com/pixel.gif",
    `${ORIGIN}.evil.com/storage/v1/object/public/form-assets/x/0f8c9a21-4b3e-4a51-9f2d-7c1e5a9b3d04.png`,
    `${ORIGIN}/storage/v1/object/public/branding/x/0f8c9a21-4b3e-4a51-9f2d-7c1e5a9b3d04.png`,
    `${ORIGIN}/storage/v1/object/public/form-assets/../../secret.png`,
    "data:image/png;base64,iVBORw0KGgo=",
    "data:image/svg+xml,<svg onload=alert(1)>",
    "cid:image001.jpg@01DA",
    "file:///C:/Users/carol/AppData/Local/Temp/msohtmlclip1/01/clip_image001.jpg",
    "//evil.example.com/pixel.gif",
    "x",
  ]) {
    assertEquals(signatureImageUrl(bad, ORIGIN), "", bad);
    assert(!/<img/i.test(clean(`<img src="${bad}">`)), `img kept for ${bad}`);
  }
  // No configured origin means no images at all, rather than a looser rule.
  assertEquals(signatureImageUrl(IMG, ""), "");
});

Deno.test("a link is https, mailto or tel — nothing else, after entity decoding", () => {
  assertEquals(signatureLinkUrl("https://www.csmsynergy.com"), "https://www.csmsynergy.com");
  assertEquals(signatureLinkUrl("mailto:carolyn@csmsynergy.com"), "mailto:carolyn@csmsynergy.com");
  assertEquals(signatureLinkUrl("tel:+1 816 300 3600"), "tel:+1 816 300 3600");
  for (const bad of [
    "javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "java\tscript:alert(1)",
    "vbscript:msgbox(1)", "data:text/html,<script>alert(1)</script>", "file:///etc/passwd",
    "cid:x", "//evil.example.com", "http://insecure.test",
  ]) {
    assertEquals(signatureLinkUrl(bad), "", bad);
  }
  // Entity-encoded javascript: must be decoded BEFORE the check, not after.
  const got = clean(`<a href="jav&#x0A;ascript:alert(1)">Site</a>`);
  assert(!/href=/.test(got), got);
  assert(/Site/.test(got), got);
  assertEquals(clean(`<a href="https://www.csmsynergy.com">Site</a>`), `<a href="https://www.csmsynergy.com">Site</a>`);
});

Deno.test("styles: url(), expression() and the positioning properties never pass", () => {
  for (const bad of [
    `background-color:url(javascript:alert(1))`,
    `width:expression(alert(1))`,
    `-moz-binding:url(http://evil.test/x.xml)`,
    `behavior:url(#default#time2)`,
    `color:red;position:fixed;top:0;z-index:9999`,
    `color:red;transform:scale(99)`,
    `color:\\72 ed`,
    `color:red;/*x*/background-color:url(x)`,
  ]) {
    const got = clean(`<span style="${bad}">Jane</span>`);
    assert(!/url\(|expression|position|z-index|transform|binding|behavior/i.test(got), `${bad} -> ${got}`);
    assert(/Jane/.test(got));
  }
  // The good ones survive, which is the whole point of the feature.
  const ok = clean(`<span style="color:#475569;font-family:Georgia, serif;font-size:14px;font-weight:700">Carolyn</span>`);
  assert(/color:#475569/.test(ok), ok);
  assert(/font-family:Georgia, serif/.test(ok), ok);
  assert(/font-size:14px/.test(ok), ok);
  // Out-of-range lengths are refused rather than clamped silently into something odd.
  assert(!/font-size/.test(clean(`<span style="font-size:400px">x</span>`)));
  assert(!/width/.test(clean(`<table style="width:9999px"><tr><td>x</td></tr></table>`)));
});

Deno.test("tables, hr and font survive — the three things a real signature needs", () => {
  const got = clean(
    `<table cellpadding="0"><tr><td valign="top"><img src="${IMG}" alt="Carolyn Miller" width="120"></td>` +
    `<td><font size="5" color="#3D3672" face="Georgia">Carolyn Miller</font></td></tr></table><hr>`,
  );
  assert(/<table cellpadding="0">/.test(got), got);
  assert(/<td valign="top">/.test(got), got);
  assert(/<img src="[^"]+" alt="Carolyn Miller" width="120">/.test(got), got);
  assert(/<hr>/.test(got), got);
  // <font> is normalised to a span, not kept and not dropped.
  assert(!/<font/i.test(got), got);
  assert(/<span style="color:#3D3672;font-family:Georgia;font-size:24px">Carolyn Miller<\/span>/.test(got), got);
});

Deno.test("output is always balanced — an unclosed table cannot eat the email", () => {
  const cases = [
    `<table><tr><td>Jane`,
    `<div><span><b>Jane`,
    `</div></div></div>Jane`,
    `<p>Jane</div>`,
    `<table><tr><td>a</table>`,
    `<b>a<i>b</b>c</i>`,
    `<ul><li>a<li>b`,
  ];
  for (const c of cases) {
    const got = clean(c);
    const stack: string[] = [];
    const re = /<(\/?)([a-z0-9]+)[^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(got)) !== null) {
      const name = m[2].toLowerCase();
      if (["br", "img", "hr"].includes(name)) continue;
      if (m[1] === "/") { assertEquals(stack.pop(), name, `unbalanced close in ${got}`); }
      else stack.push(name);
    }
    assertEquals(stack.length, 0, `tags left open in ${got}`);
  }
  // A pathological nest is cut off and still closed.
  const deep = clean("<div>".repeat(200) + "Jane");
  assert(deep.length < SIGNATURE_HTML_MAX, "deep nest should not blow the cap");
});

Deno.test("Word and Outlook cruft is removed", () => {
  const word = `<!--[if gte mso 9]><xml><o:OfficeDocumentSettings><o:AllowPNG/></o:OfficeDocumentSettings></xml><![endif]-->` +
    `<!DOCTYPE html><p class="MsoNormal" style="mso-margin-top-alt:auto;color:#1f1f1f"><o:p>&nbsp;</o:p>Carolyn</p>` +
    `<![if !mso]><span>Miller</span><![endif]>`;
  const got = clean(word);
  assert(!/mso|o:p|OfficeDocumentSettings|DOCTYPE|\[if/i.test(got), got);
  assert(/Carolyn/.test(got) && /Miller/.test(got), got);
  assert(/color:#1f1f1f/.test(got), got);
});

Deno.test("over the cap is REFUSED, never truncated", () => {
  const big = `<p>${"word ".repeat(4000)}</p>`;
  assertEquals(cleanSignatureHtml(big, ORIGIN), null);
  // And something just inside it still saves.
  const ok = cleanSignatureHtml(`<p>${"a".repeat(500)}</p>`, ORIGIN);
  assert(ok && ok.length < SIGNATURE_HTML_MAX);
});

Deno.test("nothing, markup-only and non-strings are 'no signature'", () => {
  for (const nil of [null, undefined, 42, {}, "", "   ", "<p></p>", "<table><tr><td></td></tr></table>", "<br><br>"]) {
    assertEquals(cleanSignatureHtml(nil as unknown, ORIGIN), null, JSON.stringify(nil));
  }
});

Deno.test("cleaning is idempotent — a stored value is cleaned again on the way out", () => {
  const fixtures = [
    `<table><tr><td><img src="${IMG}" alt="Carolyn"></td><td><b>Carolyn Miller</b><br><a href="mailto:carolyn@csmsynergy.com">carolyn@csmsynergy.com</a></td></tr></table><hr><p style="color:#8a8a8a;font-size:11px">Disclaimer.</p>`,
    `<div style="font-family:Arial;font-size:14px">Jane Smith<br>Sales<br><a href="tel:+15552018890">(555) 201-8890</a></div>`,
    `<p><font size="4">Big</font> and <span style="font-weight:bold">bold</span></p>`,
  ];
  for (const f of fixtures) {
    const once = clean(f);
    assertEquals(clean(once), once, `not idempotent: ${f}`);
    assert(once.length > 0);
  }
});

Deno.test("signatureHtmlToText: the rules a customer actually sees", () => {
  // mailto whose text IS the address must not print the URL twice.
  assertEquals(
    signatureHtmlToText(`<a href="mailto:carolyn@csmsynergy.com">carolyn@csmsynergy.com</a>`),
    "carolyn@csmsynergy.com",
  );
  assertEquals(
    signatureHtmlToText(`<a href="mailto:carolyn@csmsynergy.com">Email me</a>`),
    "Email me (carolyn@csmsynergy.com)",
  );
  assertEquals(
    signatureHtmlToText(`<a href="https://www.csmsynergy.com">https://www.csmsynergy.com</a>`),
    "https://www.csmsynergy.com",
  );
  // An image is its alt, or nothing — never the URL.
  assertEquals(signatureHtmlToText(`<img src="${IMG}" alt="Carolyn Miller">`), "[Carolyn Miller]");
  assertEquals(signatureHtmlToText(`<img src="${IMG}">`), "");
  assert(!signatureHtmlToText(`<img src="${IMG}" alt="x">`).includes("supabase"));
  // A rule survives as a rule.
  assert(/-{10,}/.test(signatureHtmlToText(`<p>a</p><hr><p>b</p>`)));
  // Cells join with a space, rows with a newline.
  assertEquals(
    signatureHtmlToText(`<table><tr><td>Carolyn</td><td>Miller</td></tr><tr><td>CSM</td></tr></table>`),
    "Carolyn Miller\nCSM",
  );
  // Entities decode, and a decoded "<" does not become a tag.
  assertEquals(signatureHtmlToText(`<p>Sales &amp; Service</p>`), "Sales & Service");
  assertEquals(signatureHtmlToText(`<p>Jane &lt;jane@acme.com&gt;</p>`), "Jane <jane@acme.com>");
  assertEquals(signatureHtmlToText(`<p>a&lt;b&gt;c</p>`), "a<b>c");
  // Blank lines collapse.
  assertEquals(signatureHtmlToText(`<p>a</p><p></p><p></p><p>b</p>`), "a\n\nb");
  assertEquals(signatureHtmlToText(""), "");
  assertEquals(signatureHtmlToText(null), "");
});

Deno.test("Carolyn's own signature survives end to end", () => {
  const pasted =
    `<table cellpadding="0" cellspacing="0"><tbody><tr>` +
    `<td valign="top"><img src="${IMG}" alt="Carolyn Miller" width="150" height="190"></td>` +
    `<td valign="top" style="padding-left:14px">` +
    `<p style="margin:0;font-family:Arial;font-size:15px;color:#1f1f1f">Respectfully,</p>` +
    `<p style="margin:0;font-family:Georgia;font-size:26px;color:#1f1f1f">Carolyn Miller</p>` +
    `<p style="margin:0;font-family:Arial;font-size:13px;font-weight:700">Business Consultant &amp; Success Coach</p>` +
    `<p style="margin:8px 0 0 0;font-family:Arial;font-size:13px">Phone: (816) 300-3600<br>` +
    `Email: <a href="mailto:carolyn@csmsynergy.com">carolyn@csmsynergy.com</a></p>` +
    `<p style="margin:8px 0 0 0"><a href="https://www.csmsynergy.com"><b>https://www.csmsynergy.com</b></a></p>` +
    `</td></tr></tbody></table>` +
    `<p style="text-align:center;font-weight:700;font-size:16px">—Streamlined Construction System™—</p>` +
    `<hr>` +
    `<p style="color:#8a8a8a;font-size:12px">Disclaimer: Any and all information provided is for ` +
    `informational and educational purposes only and should not be construed as legal advice.</p>`;
  const got = clean(pasted);
  assert(got.length > 0 && got.length <= SIGNATURE_HTML_MAX, String(got.length));
  // The picture, the fonts, the colours, the links, the rule and the disclaimer all live.
  assert(got.includes(`<img src="${IMG}" alt="Carolyn Miller" width="150" height="190">`), got);
  assert(/font-family:Georgia/.test(got) && /font-size:26px/.test(got), got);
  assert(/<a href="mailto:carolyn@csmsynergy.com">/.test(got), got);
  assert(/<a href="https:\/\/www\.csmsynergy\.com">/.test(got), got);
  assert(/<hr>/.test(got), got);
  assert(/color:#8a8a8a/.test(got), got);
  assert(/Streamlined Construction System™/.test(got), got);

  const text = signatureHtmlToText(got);
  assert(/\[Carolyn Miller\]/.test(text), text);
  assert(/Respectfully,/.test(text), text);
  assert(/Business Consultant & Success Coach/.test(text), text);
  assert(/carolyn@csmsynergy\.com/.test(text), text);
  assert(!/mailto:carolyn@csmsynergy\.com\)/.test(text), `address printed twice:\n${text}`);
  assert(/-{10,}/.test(text), text);
  assert(/should not be construed as legal advice/.test(text), text);
  assert(!/supabase|storage|<|>/.test(text), text);
});

Deno.test("cleanRichText — the STRICT cleaner — has not been widened to serve signatures", () => {
  // If this fails, somebody loosened the cleaner that guards every builder-authored template
  // instead of using this file. That is the thing this split exists to prevent.
  assert(!/<img/i.test(cleanRichText(`<img src="${IMG}">`)), "cleanRichText now keeps images");
  assert(!/style=/i.test(cleanRichText(`<p style="color:red">x</p>`)), "cleanRichText now keeps styles");
  assert(!/<span/i.test(cleanRichText(`<span>x</span>`)), "cleanRichText now keeps spans");
  assert(!/<table/i.test(cleanRichText(`<table><tr><td>x</td></tr></table>`)), "cleanRichText now keeps tables");
  assertEquals(cleanRichText(`<b>a</b>`), `<b>a</b>`);
});
