import { assert, assertEquals } from "jsr:@std/assert@1";
import { cleanDesign, cleanRichText, EMAIL_STARTERS, fillText, renderEmailDesign } from "./emailBlocks.ts";

Deno.test("rich text keeps bold/italic/links/lists and drops everything else", () => {
  const out = cleanRichText(`<p onclick="x()">Hi <b>there</b> <script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">bad</a> <a href="https://ok.example" target="_blank">ok</a></p><style>p{}</style>`);
  assertEquals(out, `<p>Hi <b>there</b> <a>bad</a> <a href="https://ok.example">ok</a></p>`);
});

Deno.test("divs become paragraphs and attributes never survive", () => {
  assertEquals(cleanRichText(`<div style="color:red" class="x">Line</div>`), "<p>Line</p>");
});

Deno.test("merge tags are filled with escaped values in HTML and raw values in text", () => {
  const d = cleanDesign({ blocks: [{ id: "t", type: "text", html: "<p>Hi {{contact.first_name}}</p>" }] });
  const r = renderEmailDesign(d, { contact: { first_name: "<Pat>" } });
  assert(r.html.includes("Hi &lt;Pat&gt;"));
  assert(!r.html.includes("<Pat>"));
  assert(r.text.includes("Hi <Pat>"));
  assertEquals(fillText("{{unknown.tag}} stays", {}), "{{unknown.tag}} stays");
});

Deno.test("a button link filled from a token must still be a safe link", () => {
  const d = cleanDesign({ blocks: [{ id: "b", type: "button", text: "Visit", href: "{{company.website}}" }] });
  const good = renderEmailDesign(d, { company: { website: "https://acme.example" } });
  assert(good.html.includes(`href="https://acme.example"`));
  const bad = renderEmailDesign(d, { company: { website: "javascript:alert(1)" } });
  assert(!bad.html.includes("javascript:"));
});

Deno.test("the answers block renders every answer escaped", () => {
  const d = cleanDesign({ blocks: [{ id: "a", type: "answers" }] });
  const r = renderEmailDesign(d, { form: { answers: [{ label: "Notes", value: "<b>hi</b>" }] } });
  assert(r.html.includes("&lt;b&gt;hi&lt;/b&gt;"));
});

Deno.test("cleanDesign rebuilds blocks and refuses unknown types", () => {
  const d = cleanDesign({ blocks: [{ id: "x", type: "iframe", url: "https://x" }, { id: "s", type: "spacer", height: 9999 }], style: { bg: "url(x)", width: 5000 } });
  assertEquals(d.blocks.length, 1);
  assertEquals(d.blocks[0].height, 80);
  assertEquals(d.style.bg, "#F3F4F6");
  assertEquals(d.style.width, 800);
});

Deno.test("every starter renders", () => {
  for (const st of Object.values(EMAIL_STARTERS)) {
    const r = renderEmailDesign(st.design, { contact: { first_name: "Pat", name: "Pat Lee" }, company: { name: "Acme Barns" }, form: { name: "Contact us", answers: [{ label: "Email", value: "pat@example.com" }] } }, st.preheader);
    assert(r.html.startsWith("<!doctype html>"));
    assert(!r.html.toLowerCase().includes("structurestudio"), "white-label");
  }
});
