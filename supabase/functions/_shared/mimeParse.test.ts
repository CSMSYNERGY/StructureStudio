// Tests for the MIME reader behind inbound customer email (2026-11-10). SES stores the raw
// message in S3 and mimeParse.ts turns it into headers, a text body, an HTML body and a list of
// attached files. These pin the shapes that real replies arrive in (Gmail, Outlook, Apple Mail,
// Yahoo), and the promise that matters most for a function fed by strangers: whatever the bytes
// are, parseMime returns instead of throwing.
//
// Everything is offline and built in memory. Nothing is imported except the module under test:
// the pre-push gate runs _shared/*.test.ts with no import map, so the two assert helpers are
// local. Every name, address, host and message id is made up (example.com, documentation IP
// ranges); the repo is public.

import { parseMime } from "./mimeParse.ts";
import type { ParsedMail } from "./mimeParse.ts";

// ── Local helpers ─────────────────────────────────────────────────────────────────────────
function assertEquals(actual: unknown, expected: unknown, msg?: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg ?? "assertEquals"}\n  actual:   ${a}\n  expected: ${e}`);
}
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const CRLF = "\r\n";
/** Mail lines joined the way they travel: CRLF between them. */
const lines = (...l: string[]) => l.join(CRLF);

/** One byte per char. For text that is already "bytes as chars" (ASCII, or latin1 on purpose). */
function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
const utf8 = (s: string) => new TextEncoder().encode(s);

function binary(bytes: Uint8Array): string {
  const pieces: string[] = [];
  for (let i = 0; i < bytes.length; i += 0x4000) {
    pieces.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 0x4000) as unknown as number[]));
  }
  return pieces.join("");
}

/** Base64 in 76-column lines, the way every mailer writes an attachment. */
function base64Lines(bytes: Uint8Array): string[] {
  const b64 = btoa(binary(bytes));
  const out: string[] = [];
  for (let i = 0; i < b64.length; i += 76) out.push(b64.slice(i, i + 76));
  return out;
}

/** A small seeded generator, so the "random" cases are the same on every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stand-in file content: a recognisable first few bytes, then noise. */
function fakeBytes(length: number, seed: number, magic = ""): Uint8Array {
  const next = prng(seed);
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = i < magic.length ? magic.charCodeAt(i) : Math.floor(next() * 256);
  return out;
}

/** Runs the parser and turns a throw into a test failure that says which input did it. Also
 *  checks the result has the promised shape, since "did not throw" alone would let a half-built
 *  object through. */
function mustParse(label: string, input: Uint8Array | string): ParsedMail {
  let mail: ParsedMail;
  try {
    mail = parseMime(input);
  } catch (e) {
    throw new Error(`${label}: parseMime threw ${e}`);
  }
  for (const key of ["from", "to", "subject", "messageId", "inReplyTo", "references", "text", "html"] as const) {
    assert(typeof mail[key] === "string", `${label}: ${key} is not a string`);
  }
  assert(Array.isArray(mail.attachments), `${label}: attachments is not an array`);
  assert(typeof mail.headers === "object" && mail.headers !== null, `${label}: headers is not an object`);
  return mail;
}

// ── Fixtures shared by several tests ──────────────────────────────────────────────────────
const GMAIL_REPLY = lines(
  "MIME-Version: 1.0",
  "Date: Mon, 9 Nov 2026 10:15:00 -0500",
  "References: <CAF0001orig@mail.example.com>",
  "In-Reply-To: <CAF0001orig@mail.example.com>",
  "Message-ID: <CAF0002reply@mail.example.com>",
  "Subject: Re: Your shed quote",
  "From: Dana Carpenter <dana@example.com>",
  "To: Northfield Sheds <reply@inbound.example.com>",
  'Content-Type: multipart/alternative; boundary="000000000000a1b2c3061f4e5d6a"',
  "",
  "--000000000000a1b2c3061f4e5d6a",
  'Content-Type: text/plain; charset="UTF-8"',
  "",
  "Thanks, that works for me.",
  "",
  "On Mon, Nov 9, 2026 at 9:58 AM Northfield Sheds <reply@inbound.example.com> wrote:",
  "> Here is your quote.",
  "",
  "--000000000000a1b2c3061f4e5d6a",
  'Content-Type: text/html; charset="UTF-8"',
  "Content-Transfer-Encoding: quoted-printable",
  "",
  '<div dir=3D"ltr">Thanks, that=E2=80=99s great. It works for me and I would l=',
  'ike to go ahead.</div><br><div class=3D"gmail_quote"><div dir=3D"ltr" class=',
  '=3D"gmail_attr">On Mon, Nov 9, 2026 at 9:58 AM Northfield Sheds wrote:<br></d=',
  "iv><blockquote>Here is your quote.</blockquote></div>",
  "",
  "--000000000000a1b2c3061f4e5d6a--",
  "",
);

const PDF = fakeBytes(1234, 7, "%PDF-1.7\n");
const OUTLOOK_REPLY = lines(
  'From: "Morgan Fields" <morgan@example.com>',
  'To: "Northfield Sheds" <reply@inbound.example.com>',
  "Subject: RE: Your shed quote",
  "Thread-Topic: Your shed quote",
  "Date: Mon, 9 Nov 2026 15:20:11 +0000",
  "Message-ID: <BN0PR01MB0001F00D@BN0PR01MB0001.namprd01.prod.example.com>",
  "In-Reply-To: <CAF0001orig@mail.example.com>",
  "Content-Language: en-US",
  "Content-Type: multipart/mixed;",
  '\tboundary="_004_BN0PR01MB0001F00Dnamprd01prodexamplecom_"',
  "MIME-Version: 1.0",
  "",
  "--_004_BN0PR01MB0001F00Dnamprd01prodexamplecom_",
  "Content-Type: multipart/alternative;",
  '\tboundary="_000_BN0PR01MB0001F00Dnamprd01prodexamplecom_"',
  "",
  "--_000_BN0PR01MB0001F00Dnamprd01prodexamplecom_",
  'Content-Type: text/plain; charset="us-ascii"',
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "Please see the signed form attached.",
  "",
  "Morgan",
  "",
  "--_000_BN0PR01MB0001F00Dnamprd01prodexamplecom_",
  'Content-Type: text/html; charset="us-ascii"',
  "Content-Transfer-Encoding: quoted-printable",
  "",
  '<html><body><p class=3D"MsoNormal">Please see the signed form attached.</p>=',
  '<p class=3D"MsoNormal">Morgan</p></body></html>',
  "",
  "--_000_BN0PR01MB0001F00Dnamprd01prodexamplecom_--",
  "",
  "--_004_BN0PR01MB0001F00Dnamprd01prodexamplecom_",
  'Content-Type: application/pdf; name="Signed Form.pdf"',
  "Content-Description: Signed Form.pdf",
  'Content-Disposition: attachment; filename="Signed Form.pdf"; size=1234;',
  '\tcreation-date="Mon, 09 Nov 2026 15:19:00 GMT";',
  '\tmodification-date="Mon, 09 Nov 2026 15:19:00 GMT"',
  "Content-Transfer-Encoding: base64",
  "",
  ...base64Lines(PDF),
  "",
  "--_004_BN0PR01MB0001F00Dnamprd01prodexamplecom_--",
  "",
);
const OUTLOOK_TEXT = "Please see the signed form attached.\r\n\r\nMorgan\r\n";

// ── 1. Gmail ──────────────────────────────────────────────────────────────────────────────
Deno.test("Gmail reply: multipart/alternative gives the text and the quoted-printable html", () => {
  const mail = parseMime(latin1(GMAIL_REPLY));
  assertEquals(mail.from, "Dana Carpenter <dana@example.com>");
  assertEquals(mail.to, "Northfield Sheds <reply@inbound.example.com>");
  assertEquals(mail.subject, "Re: Your shed quote");
  assertEquals(mail.messageId, "<CAF0002reply@mail.example.com>");
  assertEquals(mail.inReplyTo, "<CAF0001orig@mail.example.com>");
  assertEquals(mail.references, "<CAF0001orig@mail.example.com>");
  // The quoted reply stays in. Stripping it is another module's job.
  assertEquals(
    mail.text,
    "Thanks, that works for me.\r\n\r\nOn Mon, Nov 9, 2026 at 9:58 AM Northfield Sheds <reply@inbound.example.com> wrote:\r\n> Here is your quote.\r\n",
  );
  // Soft line breaks are gone (one of them sits right before an =3D), and =E2=80=99 is one
  // curly apostrophe, not three odd characters.
  assertEquals(
    mail.html,
    '<div dir="ltr">Thanks, that\u2019s great. It works for me and I would like to go ahead.</div><br>' +
      '<div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Mon, Nov 9, 2026 at 9:58 AM Northfield Sheds wrote:<br></div>' +
      "<blockquote>Here is your quote.</blockquote></div>\r\n",
  );
  assertEquals(mail.attachments, []);
  // A string that is already "bytes as chars" gives the same answer as the bytes.
  assertEquals(parseMime(GMAIL_REPLY), mail, "string input");
});

// ── 2. Outlook ────────────────────────────────────────────────────────────────────────────
Deno.test("Outlook reply: multipart/mixed wrapping alternative, plus a base64 PDF", () => {
  const mail = parseMime(latin1(OUTLOOK_REPLY));
  assertEquals(mail.from, '"Morgan Fields" <morgan@example.com>');
  assertEquals(mail.subject, "RE: Your shed quote");
  assertEquals(mail.text, OUTLOOK_TEXT);
  assertEquals(
    mail.html,
    '<html><body><p class="MsoNormal">Please see the signed form attached.</p><p class="MsoNormal">Morgan</p></body></html>\r\n',
  );
  // 1234 is the size of the file, not of its base64 text (which is a third longer).
  assertEquals(mail.attachments, [
    { filename: "Signed Form.pdf", contentType: "application/pdf", size: 1234, inline: false },
  ]);
  // The tab-folded Content-Type came out as one line.
  assertEquals(mail.headers["content-type"], 'multipart/mixed; boundary="_004_BN0PR01MB0001F00Dnamprd01prodexamplecom_"');
});

// ── 3. Inline images ──────────────────────────────────────────────────────────────────────
Deno.test("multipart/related: an image with a Content-ID is inline", () => {
  const logo = fakeBytes(301, 11, "\x89PNG\r\n\x1a\n");
  const mail = parseMime(latin1(lines(
    "From: Dana Carpenter <dana@example.com>",
    "Subject: Re: Colours",
    'Content-Type: multipart/related; boundary="rel-0001"; type="multipart/alternative"',
    "",
    "--rel-0001",
    'Content-Type: multipart/alternative; boundary="alt-0001"',
    "",
    "--alt-0001",
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    "Sounds good. [image: logo.png]",
    "--alt-0001",
    'Content-Type: text/html; charset="UTF-8"',
    "",
    '<div>Sounds good.<img src="cid:ii_logo0001" alt="logo.png"></div>',
    "--alt-0001--",
    "--rel-0001",
    'Content-Type: image/png; name="logo.png"',
    "Content-Transfer-Encoding: base64",
    "Content-ID: <ii_logo0001>",
    "X-Attachment-Id: ii_logo0001",
    "",
    ...base64Lines(logo),
    "--rel-0001--",
  )));
  assertEquals(mail.text, "Sounds good. [image: logo.png]");
  assertEquals(mail.html, '<div>Sounds good.<img src="cid:ii_logo0001" alt="logo.png"></div>');
  assertEquals(mail.attachments, [{ filename: "logo.png", contentType: "image/png", size: 301, inline: true }]);
});

Deno.test("outside multipart/related only Content-Disposition: inline makes a file inline", () => {
  const mail = parseMime(lines(
    'Content-Type: multipart/mixed; boundary="mix-0002"',
    "",
    "--mix-0002",
    "Content-Type: text/plain",
    "",
    "Three files.",
    "--mix-0002",
    'Content-Type: image/jpeg; name="has-id.jpg"',
    "Content-ID: <photo1@example.com>",
    "",
    "12345",
    "--mix-0002",
    "Content-Type: image/jpeg",
    'Content-Disposition: INLINE; filename="shown.jpg"',
    "",
    "1234567",
    "--mix-0002",
    "Content-Type: Application/PDF",
    'Content-Disposition: Attachment; filename="plan.pdf"',
    "",
    "123",
    "--mix-0002--",
  ));
  assertEquals(mail.attachments, [
    { filename: "has-id.jpg", contentType: "image/jpeg", size: 5, inline: false },
    { filename: "shown.jpg", contentType: "image/jpeg", size: 7, inline: true },
    { filename: "plan.pdf", contentType: "application/pdf", size: 3, inline: false },
  ]);
});

// ── 4. Single-part base64 ─────────────────────────────────────────────────────────────────
Deno.test("single-part base64 text/plain in utf-8", () => {
  const body = "Grüße aus Köln. Größe: 3 × 4 m. 日本語のテキストも読めます。\r\n";
  const mail = parseMime(latin1(lines(
    "From: Kim Becker <kim@example.com>",
    "Subject: Masse",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    ...base64Lines(utf8(body)),
    "",
  )));
  assertEquals(mail.text, body);
  assertEquals(mail.html, "");
  assertEquals(mail.attachments, []);
});

Deno.test("single-part text/html lands in html, not text", () => {
  const mail = parseMime("Content-Type: TEXT/HTML; Charset=\"UTF-8\"\r\n\r\n<p>Only html here.</p>");
  assertEquals(mail.html, "<p>Only html here.</p>");
  assertEquals(mail.text, "");
});

// ── 5. Other charsets ─────────────────────────────────────────────────────────────────────
Deno.test("iso-8859-1 and windows-1252 bodies keep their accents", () => {
  // latin1() writes each accented letter as its single iso-8859-1 byte.
  const iso = parseMime(latin1(lines(
    "Content-Type: text/plain; charset=iso-8859-1",
    "Content-Transfer-Encoding: 8bit",
    "",
    "Café crème, façade, über",
  )));
  assertEquals(iso.text, "Café crème, façade, über");

  const isoQp = parseMime(latin1(lines(
    'Content-Type: text/html; charset="ISO-8859-1"',
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "<p>Caf=E9 cr=E8me</p>",
  )));
  assertEquals(isoQp.html, "<p>Café crème</p>");

  // 0x92, 0x80, 0x93 and 0x94 are the curly apostrophe, the euro sign and the curly quotes in
  // windows-1252. In strict iso-8859-1 they would be invisible control codes.
  const win = parseMime(latin1(lines(
    "Content-Type: text/plain; charset=windows-1252",
    "Content-Transfer-Encoding: 8bit",
    "",
    "It\x92s \x8050, \x93as agreed\x94",
  )));
  assertEquals(win.text, "It\u2019s \u20AC50, \u201Cas agreed\u201D");

  const winQp = parseMime(latin1(lines(
    "Content-Type: text/html; charset=Windows-1252",
    "Content-Transfer-Encoding: QUOTED-PRINTABLE",
    "",
    "<p>It=92s =8050</p>",
  )));
  assertEquals(winQp.html, "<p>It\u2019s \u20AC50</p>");
});

Deno.test("us-ascii, a missing charset and an unknown charset are guessed: utf-8 first, then windows-1252", () => {
  for (const type of ["text/plain; charset=us-ascii", "text/plain", "text/plain; charset=x-made-up-charset", ""]) {
    const head = type === "" ? [] : [`Content-Type: ${type}`];
    const asUtf8 = mustParse(`utf-8 bytes, ${type}`, utf8(lines(...head, "", "Größe: 3 × 4 m")));
    assertEquals(asUtf8.text, "Größe: 3 × 4 m", `utf-8 bytes, ${type}`);
    const asLatin = mustParse(`latin bytes, ${type}`, latin1(lines(...head, "", "Caf\xE9 \x80 5")));
    assertEquals(asLatin.text, "Café \u20AC 5", `latin bytes, ${type}`);
  }
});

// ── 6. Bare LF ────────────────────────────────────────────────────────────────────────────
Deno.test("a bare-LF message parses the same as its CRLF twin", () => {
  for (const [label, crlfRaw] of [["gmail", GMAIL_REPLY], ["outlook", OUTLOOK_REPLY]]) {
    const crlf = parseMime(latin1(crlfRaw));
    const lfRaw = crlfRaw.replace(/\r\n/g, "\n");
    assert(lfRaw.indexOf("\r") < 0, `${label}: the LF fixture still holds a CR`);
    const lf = parseMime(latin1(lfRaw));
    assertEquals(lf.headers, crlf.headers, `${label}: headers`);
    assertEquals(lf.attachments, crlf.attachments, `${label}: attachments`);
    // Body text is passed through untouched, so each keeps the line endings it was sent with.
    // Apart from that the two must be the same text.
    assertEquals(lf.text, crlf.text.replace(/\r\n/g, "\n"), `${label}: text`);
    assertEquals(lf.html, crlf.html.replace(/\r\n/g, "\n"), `${label}: html`);
    assert(lf.text.length > 0 && lf.html.length > 0, `${label}: the LF message lost a body`);
  }
});

// ── 7. RFC 2047 ───────────────────────────────────────────────────────────────────────────
Deno.test("RFC 2047: B and Q words, neighbours joined, display names", () => {
  const mail = parseMime(lines(
    // B then Q, one space between them. The space inside the first word is kept, the one
    // between the words is dropped.
    "Subject: =?UTF-8?B?QW5nZWJvdCBmw7xyIA==?= =?UTF-8?Q?Gartenh=C3=A4user_und_Carports?=",
    "From: =?UTF-8?Q?Ren=C3=A9e_Dubois?= <renee@example.com>",
    'To: "=?iso-8859-1?q?J=FCrgen_M=FCller?=" <juergen@example.com>',
    // Folded between two words: the line break and indent count as that whitespace.
    "X-Folded: =?utf-8?b?R3LDtsOfZQ==?=",
    " =?utf-8?b?IHBhc3N0?=",
    // The two bytes of one letter split across two words (not allowed, but mailers do it).
    "X-Split: =?utf-8?b?Q2Fmww==?= =?utf-8?b?qQ==?=",
    "X-Mixed: Re: =?UTF-8?Q?Gr=C3=B6=C3=9Fe?= (2 von 3)",
    "X-Unknown-Charset: =?x-made-up?Q?plain_words?=",
    "X-Language-Tag: =?utf-8*de?Q?Gr=C3=BC=C3=9Fe?=",
    "X-Not-A-Word: sum =?x?= done",
    // CR and LF hidden inside a word must not turn one header into several lines.
    "X-Hidden-Break: =?utf-8?Q?one=0D=0Atwo?=",
    "",
    "body",
  ));
  assertEquals(mail.subject, "Angebot für Gartenhäuser und Carports");
  assertEquals(mail.from, "Renée Dubois <renee@example.com>");
  assertEquals(mail.to, '"Jürgen Müller" <juergen@example.com>');
  assertEquals(mail.headers["x-folded"], "Größe passt");
  assertEquals(mail.headers["x-split"], "Café");
  assertEquals(mail.headers["x-mixed"], "Re: Größe (2 von 3)");
  assertEquals(mail.headers["x-unknown-charset"], "plain words");
  assertEquals(mail.headers["x-language-tag"], "Grüße");
  assertEquals(mail.headers["x-not-a-word"], "sum =?x?= done");
  assertEquals(mail.headers["x-hidden-break"], "one  two");
});

Deno.test("headers sent as raw 8-bit text are read as utf-8, or windows-1252 when they are not", () => {
  // A JS string with chars above 0xFF is real text, so it is encoded to utf-8 first.
  const fromString = parseMime(lines(
    "From: 山田 太郎 <taro@example.com>",
    "Subject: 見積もりの件",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "ありがとうございます。",
  ));
  assertEquals(fromString.from, "山田 太郎 <taro@example.com>");
  assertEquals(fromString.subject, "見積もりの件");
  assertEquals(fromString.text, "ありがとうございます。");

  // "à" ends in byte 0xA0, which String.trim() treats as a space. The value must survive.
  assertEquals(parseMime(utf8("Subject: Voilà\r\n\r\nx")).subject, "Voilà");
  assertEquals(parseMime(latin1("Subject: Caf\xE9 au lait\r\n\r\nx")).subject, "Café au lait");
});

// ── 8. Folding ────────────────────────────────────────────────────────────────────────────
Deno.test("folded headers unfold to one line", () => {
  const mail = parseMime(lines(
    "References: <CAF0001orig@mail.example.com>",
    " <CAF0002reply@mail.example.com>",
    "\t<CAF0003again@mail.example.com>",
    "Subject: A long subject line that the mail program",
    "    folded in the middle",
    "In-Reply-To:",
    " <CAF0003again@mail.example.com>",
    "",
    "body",
  ));
  assertEquals(
    mail.references,
    "<CAF0001orig@mail.example.com> <CAF0002reply@mail.example.com> <CAF0003again@mail.example.com>",
  );
  assertEquals(mail.subject, "A long subject line that the mail program folded in the middle");
  assertEquals(mail.inReplyTo, "<CAF0003again@mail.example.com>");
  for (const [name, value] of Object.entries(mail.headers)) {
    assert(value.indexOf("\r") < 0 && value.indexOf("\n") < 0 && value.indexOf("\t") < 0, `${name} is not one line`);
  }
});

// ── 9. Duplicates ─────────────────────────────────────────────────────────────────────────
Deno.test("a repeated header keeps its first value", () => {
  const mail = parseMime(lines(
    "X-SES-Spam-Verdict: PASS",
    "Subject: The real subject",
    "From: Dana Carpenter <dana@example.com>",
    // Lower down is where a sender can add lines of their own.
    "X-SES-Spam-Verdict: FAIL",
    "x-ses-spam-verdict: GRAY",
    "Subject: A second subject",
    "",
    "X-SES-Spam-Verdict: this one is body text",
  ));
  assertEquals(mail.headers["x-ses-spam-verdict"], "PASS");
  assertEquals(mail.subject, "The real subject");
  assertEquals(mail.text, "X-SES-Spam-Verdict: this one is body text");
});

// ── 10. Truncated mail ────────────────────────────────────────────────────────────────────
Deno.test("mail cut off inside a base64 attachment still gives the text", () => {
  const full = parseMime(OUTLOOK_REPLY);
  // Cut in the middle of the PDF's base64 lines: no closing boundary, not even a whole line.
  const start = OUTLOOK_REPLY.indexOf("JVBERi0");
  assert(start > 0, "fixture: the base64 block was not found");
  const cut = mustParse("truncated", latin1(OUTLOOK_REPLY.slice(0, start + 501)));
  assertEquals(cut.text, OUTLOOK_TEXT);
  assertEquals(cut.html, full.html);
  assertEquals(cut.attachments.length, 1);
  assertEquals(cut.attachments[0].filename, "Signed Form.pdf");
  // The size is that of the bytes that did arrive: some of the file, not all of it.
  assert(cut.attachments[0].size > 0 && cut.attachments[0].size < 1234, `size ${cut.attachments[0].size}`);
});

Deno.test("cutting a message at any byte never throws", () => {
  for (const [label, raw] of [["gmail", GMAIL_REPLY], ["outlook", OUTLOOK_REPLY]]) {
    for (let cut = 0; cut <= raw.length; cut++) mustParse(`${label} cut at ${cut}`, raw.slice(0, cut));
  }
});

// ── 11. Garbage ───────────────────────────────────────────────────────────────────────────
Deno.test("garbage in, empty result out, never a throw", () => {
  const blank = {
    headers: {}, from: "", to: "", subject: "", messageId: "", inReplyTo: "", references: "",
    text: "", html: "", attachments: [],
  };
  assertEquals(mustParse("empty bytes", new Uint8Array(0)), blank);
  assertEquals(mustParse("empty string", ""), blank);
  // No headers, and a body that is only line breaks. Body text is never trimmed.
  assertEquals(mustParse("only line breaks", "\r\n\r\n\r\n"), { ...blank, text: "\r\n\r\n" });
  // Callers are typed, but a fetch that failed can still hand over nothing at all.
  assertEquals(mustParse("null", null as unknown as string), blank);
  assertEquals(mustParse("undefined", undefined as unknown as string), blank);
  assertEquals(mustParse("a number", 42 as unknown as string), blank);

  const next = prng(20261110);
  for (const size of [1, 2, 17, 1000, 65536, 300000]) {
    const noise = new Uint8Array(size);
    for (let i = 0; i < size; i++) noise[i] = Math.floor(next() * 256);
    mustParse(`random ${size} bytes`, noise);
    // The same noise as the body of something that claims to be a multipart, and as base64.
    const opening = latin1('Content-Type: multipart/mixed; boundary="zz"\r\n\r\n--zz\r\n');
    const asMultipart = new Uint8Array(opening.length + size);
    asMultipart.set(opening);
    asMultipart.set(noise, opening.length);
    mustParse(`random ${size} bytes in a multipart`, asMultipart);
    mustParse(`random ${size} bytes as base64`, "Content-Transfer-Encoding: base64\r\n\r\n" + binary(noise));
  }

  // A header block and nothing after it.
  const headOnly = mustParse("headers only", lines("From: Dana Carpenter <dana@example.com>", "Subject: No body"));
  assertEquals(headOnly.subject, "No body");
  assertEquals(headOnly.text, "");
  assertEquals(headOnly.attachments, []);

  // Says multipart, names no boundary. It cannot be split, so the body is shown as it is.
  const noBoundary = mustParse("no boundary", lines(
    "Subject: Broken",
    "Content-Type: multipart/alternative",
    "",
    "--whatever",
    "Content-Type: text/plain",
    "",
    "Still readable.",
    "--whatever--",
  ));
  assertEquals(noBoundary.subject, "Broken");
  assert(noBoundary.text.includes("Still readable."), "the unsplit body should be kept as text");
  assertEquals(noBoundary.attachments, []);

  // Names a boundary that the body never uses.
  const wrongBoundary = mustParse("wrong boundary", lines(
    'Content-Type: multipart/mixed; boundary="declared"',
    "",
    "--used-instead",
    "",
    "Hello",
    "--used-instead--",
  ));
  assert(wrongBoundary.text.includes("Hello"), "wrong boundary: body kept as text");

  // Assorted nonsense where structure should be.
  for (const [label, raw] of [
    ["empty boundary", 'Content-Type: multipart/mixed; boundary=""\r\n\r\n--\r\n\r\nx\r\n----\r\n'],
    ["unclosed quote", 'Content-Type: multipart/mixed; boundary="abc\r\n\r\n--abc\r\n\r\nx'],
    ["only separators", "Content-Type: ;;;===;;; ; = ;\r\nContent-Disposition: ;filename\r\n\r\nx"],
    ["bad transfer encoding", "Content-Transfer-Encoding: rot13 (really)\r\n\r\nplain"],
    ["colons only", ":::::\r\n: :\r\n:\r\n\r\nx"],
    ["continuation first", " leading continuation\r\n\tanother\r\nSubject: ok\r\n\r\nx"],
    ["lone CRs", "Subject: a\rb\rc\r\r\rtext"],
    ["nul bytes", "Subject: a\0b\r\nContent-Type: text/plain; charset=\0\r\n\r\n\0\0\0"],
    ["bad 2231", "Content-Disposition: attachment; filename*=%%%'''%ZZ%4\r\n\r\nx"],
    ["bad 2231 pieces", "Content-Disposition: attachment; filename*0*=''; filename*2*=%41\r\n\r\nx"],
    ["bad encoded words", "Subject: =?utf-8?B?!!!?= =?utf-8?Q?=?= =?utf-8?Q??= =?utf-8?B??= =??Q?x?=\r\n\r\nx"],
  ]) {
    mustParse(label, raw);
    mustParse(label + " (bytes)", latin1(raw));
  }
});

Deno.test("damaged copies of real messages never throw", () => {
  const next = prng(424242);
  for (const [label, raw] of [["gmail", GMAIL_REPLY], ["outlook", OUTLOOK_REPLY]]) {
    for (let round = 0; round < 300; round++) {
      const bytes = latin1(raw);
      // Overwrite a handful of bytes, biased toward the characters MIME gives meaning to.
      const hits = 1 + Math.floor(next() * 8);
      for (let h = 0; h < hits; h++) {
        const special = [13, 10, 45, 61, 59, 34, 58, 63, 0, 255];
        const value = next() < 0.6 ? special[Math.floor(next() * special.length)] : Math.floor(next() * 256);
        bytes[Math.floor(next() * bytes.length)] = value;
      }
      mustParse(`${label} round ${round}`, bytes);
    }
  }
});

// ── 12. Depth and part caps ───────────────────────────────────────────────────────────────
/** `levels` multiparts inside each other, with one text part at the very bottom. With
 *  `textAtEveryLevel`, each level also has a text part of its own before the nested one. */
function nested(levels: number, textAtEveryLevel: boolean): string {
  const out: string[] = ["Subject: nested", 'Content-Type: multipart/mixed; boundary="b0"', ""];
  for (let i = 0; i < levels; i++) {
    out.push(`--b${i}`);
    if (textAtEveryLevel) out.push("Content-Type: text/plain", "", `level ${i}`, `--b${i}`);
    if (i + 1 < levels) out.push(`Content-Type: multipart/mixed; boundary="b${i + 1}"`, "");
    else out.push("Content-Type: text/plain", "", "innermost");
  }
  for (let i = levels - 1; i >= 0; i--) out.push(`--b${i}--`);
  return out.join(CRLF);
}

Deno.test("nesting past the depth cap neither throws nor hangs", () => {
  assertEquals(mustParse("3 levels", nested(3, false)).text, "innermost");
  // Eight multiparts are opened. The ninth is left closed, so its text is never reached.
  assertEquals(mustParse("8 levels", nested(8, false)).text, "innermost");
  assertEquals(mustParse("9 levels", nested(9, false)).text, "");
  for (const levels of [50, 5000]) {
    const deep = mustParse(`${levels} levels`, nested(levels, false));
    assertEquals(deep.text, "", `${levels} levels: text`);
    assertEquals(deep.attachments, [], `${levels} levels: the unopened multipart is not listed as a file`);
    assertEquals(mustParse(`${levels} levels with text`, nested(levels, true)).text, "level 0");
  }
});

Deno.test("a mail made of a thousand parts stops at the part cap", () => {
  const out: string[] = ['Content-Type: multipart/mixed; boundary="many"', ""];
  for (let i = 0; i < 1000; i++) {
    out.push("--many", `Content-Type: application/octet-stream; name="file-${i}.bin"`, "", "x");
  }
  out.push("--many--");
  const mail = mustParse("1000 parts", out.join(CRLF));
  // The message itself counts as one of the 200, which leaves 199 for what is inside it.
  assertEquals(mail.attachments.length, 199);
  assertEquals(mail.attachments[0].filename, "file-0.bin");
  assertEquals(mail.attachments[198].filename, "file-198.bin");
});

// ── 13. File names ────────────────────────────────────────────────────────────────────────
Deno.test("RFC 2231 file names, and the other ways mailers write a name", () => {
  const nameOf = (...head: string[]) => {
    const mail = mustParse(head.join(" | "), latin1(lines(...head, "", "12345")));
    assertEquals(mail.attachments.length, 1, head.join(" | "));
    assertEquals(mail.text, "", head.join(" | "));
    return mail.attachments[0].filename;
  };
  const pdf = "Content-Type: application/pdf";

  assertEquals(
    nameOf(pdf, "Content-Disposition: attachment; filename*=UTF-8''Angebot%20Gartenh%C3%A4user%202026.pdf"),
    "Angebot Gartenhäuser 2026.pdf",
  );
  // When both are given, the starred form is the real name and the plain one a fallback for
  // old mail programs.
  assertEquals(
    nameOf(pdf, `Content-Disposition: attachment; filename="Angebot.pdf"; filename*=utf-8'de'Angebot%20f%C3%BCr%20Sie.pdf`),
    "Angebot für Sie.pdf",
  );
  assertEquals(nameOf(pdf, "Content-Disposition: attachment; FileName*=iso-8859-1''Caf%E9.pdf"), "Café.pdf");
  // Split into numbered pieces, some percent-encoded and one plain.
  assertEquals(
    nameOf(
      pdf,
      "Content-Disposition: attachment;",
      " filename*0*=UTF-8''Sehr%20langer%20;",
      " filename*1*=Dateiname%20f%C3%BCr;",
      ' filename*2=" den Kunden.pdf"',
    ),
    "Sehr langer Dateiname für den Kunden.pdf",
  );
  assertEquals(
    nameOf(pdf, 'Content-Disposition: attachment; filename*0="part one "; filename*1="and two.pdf"'),
    "part one and two.pdf",
  );
  // RFC 2047 words inside a quoted name: against the rules, sent by Gmail and Outlook anyway.
  assertEquals(
    nameOf(pdf, 'Content-Disposition: attachment; filename="=?UTF-8?B?UmVjaG51bmcgTcOkcnoucGRm?="'),
    "Rechnung März.pdf",
  );
  // No Content-Disposition at all: the name on Content-Type is enough to make it a file.
  assertEquals(nameOf('Content-Type: application/pdf; name="From Type.pdf"'), "From Type.pdf");
  assertEquals(nameOf('Content-Type: text/plain; NAME="notes.txt"'), "notes.txt");
  assertEquals(nameOf(pdf, "Content-Disposition: attachment; filename=Site Plan.pdf"), "Site Plan.pdf");
  assertEquals(nameOf(pdf, 'Content-Disposition: attachment; filename="the \\"final\\" plan.pdf"'), 'the "final" plan.pdf');
  assertEquals(
    nameOf(pdf, 'Content-Disposition: attachment; filename="C:\\Users\\dana\\plan; v2.pdf"'),
    "C:\\Users\\dana\\plan; v2.pdf",
  );
  assertEquals(nameOf(pdf, "Content-Disposition: attachment"), "");
});

// ── 14. As SES stores it ──────────────────────────────────────────────────────────────────
Deno.test("an SES-stored message: the receiving server's headers on top are the ones kept", () => {
  const mail = parseMime(latin1(lines(
    "Return-Path: <dana@example.com>",
    "Received: from mail-out.example.com (mail-out.example.com [203.0.113.25])",
    " by inbound-smtp.us-east-2.amazonaws.com with SMTP id 0a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t",
    " for reply@inbound.example.com;",
    " Mon, 09 Nov 2026 15:15:02 +0000 (UTC)",
    "X-SES-Spam-Verdict: PASS",
    "X-SES-Virus-Verdict: PASS",
    "Received-SPF: pass (spfCheck: domain of example.com designates 203.0.113.25 as permitted sender) client-ip=203.0.113.25; envelope-from=dana@example.com; helo=mail-out.example.com;",
    "Authentication-Results: amazonses.com;",
    " spf=pass (spfCheck: domain of example.com designates 203.0.113.25 as permitted sender) client-ip=203.0.113.25; envelope-from=dana@example.com; helo=mail-out.example.com;",
    " dkim=pass header.i=@example.com;",
    " dmarc=pass header.from=example.com;",
    "X-SES-RECEIPT: AEFBQUFBQUFBQUFGbWFkZS11cC1yZWNlaXB0LXZhbHVlLW5vdC1yZWFs",
    "X-SES-DKIM-SIGNATURE: a=rsa-sha256; q=dns/txt; b=bWFkZS11cA==; c=relaxed/simple;",
    "\ts=abcdefghijklmnop; d=amazonses.com; t=1794237302; v=1;",
    "\tbh=bWFkZS11cC1ib2R5LWhhc2g=; h=X-SES-RECEIPT;",
    // From here down the sender wrote every line, including copies of the lines above.
    "Received: from laptop.example.net (laptop.example.net [198.51.100.7])",
    " by mail-out.example.com with ESMTPSA id made-up-id;",
    " Mon, 09 Nov 2026 15:15:00 +0000 (UTC)",
    "Authentication-Results: mx.example.net; dmarc=fail header.from=example.com",
    "X-SES-Spam-Verdict: FAIL",
    "MIME-Version: 1.0",
    "From: Dana Carpenter <dana@example.com>",
    "To: Northfield Sheds <reply@inbound.example.com>",
    "Subject: Re: Your shed quote",
    "Message-ID: <CAF0002reply@mail.example.com>",
    "In-Reply-To: <CAF0001orig@mail.example.com>",
    "References: <CAF0000first@mail.example.com>",
    " <CAF0001orig@mail.example.com>",
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    "Yes please, go ahead.",
    "",
  )));
  const auth = mail.headers["authentication-results"];
  assertEquals(
    auth,
    "amazonses.com; spf=pass (spfCheck: domain of example.com designates 203.0.113.25 as permitted sender) " +
      "client-ip=203.0.113.25; envelope-from=dana@example.com; helo=mail-out.example.com; " +
      "dkim=pass header.i=@example.com; dmarc=pass header.from=example.com;",
  );
  assert(auth.includes("dmarc=pass"), "dmarc=pass missing");
  assert(auth.indexOf("\r") < 0 && auth.indexOf("\n") < 0, "authentication-results is not one line");
  assertEquals(mail.headers["x-ses-spam-verdict"], "PASS");
  assertEquals(mail.headers["x-ses-virus-verdict"], "PASS");
  assertEquals(mail.headers["return-path"], "<dana@example.com>");
  assertEquals(
    mail.headers["received"],
    "from mail-out.example.com (mail-out.example.com [203.0.113.25]) by inbound-smtp.us-east-2.amazonaws.com " +
      "with SMTP id 0a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t for reply@inbound.example.com; Mon, 09 Nov 2026 15:15:02 +0000 (UTC)",
  );
  assert(mail.headers["received-spf"].startsWith("pass (spfCheck"), "received-spf");
  assertEquals(
    mail.headers["x-ses-dkim-signature"],
    "a=rsa-sha256; q=dns/txt; b=bWFkZS11cA==; c=relaxed/simple; s=abcdefghijklmnop; d=amazonses.com; t=1794237302; v=1; " +
      "bh=bWFkZS11cC1ib2R5LWhhc2g=; h=X-SES-RECEIPT;",
  );
  assertEquals(mail.from, "Dana Carpenter <dana@example.com>");
  assertEquals(mail.to, "Northfield Sheds <reply@inbound.example.com>");
  assertEquals(mail.subject, "Re: Your shed quote");
  assertEquals(mail.messageId, "<CAF0002reply@mail.example.com>");
  assertEquals(mail.inReplyTo, "<CAF0001orig@mail.example.com>");
  assertEquals(mail.references, "<CAF0000first@mail.example.com> <CAF0001orig@mail.example.com>");
  assertEquals(mail.text, "Yes please, go ahead.\r\n");
  assertEquals(mail.html, "");
  assertEquals(mail.attachments, []);
});

// ── 15. Size ──────────────────────────────────────────────────────────────────────────────
Deno.test("a 2 MB body parses and keeps every character", () => {
  const line = "The quick brown fox jumps over the lazy dog, again and again.\r\n";
  const body = line.repeat(Math.ceil((2 * 1024 * 1024) / line.length));
  const mail = parseMime(latin1("From: Dana Carpenter <dana@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n" + body));
  assertEquals(mail.text.length, body.length);
  assert(mail.text.endsWith("again and again.\r\n"), "the end of the body is missing");
  assertEquals(mail.from, "Dana Carpenter <dana@example.com>");
});

Deno.test("a 2 MB attachment and a 2 MB quoted-printable body parse too", () => {
  const file = fakeBytes(2 * 1024 * 1024 + 1, 99, "PK\x03\x04");
  const qpLine = '<p class=3D"x">caf=C3=A9 and more text to fill the line up a little further=\r\n</p>\r\n';
  const qpBody = qpLine.repeat(Math.ceil((2 * 1024 * 1024) / qpLine.length));
  const mail = parseMime(latin1(lines(
    'Content-Type: multipart/mixed; boundary="big-0001"',
    "",
    "--big-0001",
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    qpBody,
    "--big-0001",
    'Content-Type: application/zip; name="photos.zip"',
    "Content-Disposition: attachment",
    "Content-Transfer-Encoding: base64",
    "",
    // Joined here, not spread: 36,000 lines is more arguments than a call should be given.
    base64Lines(file).join(CRLF),
    "--big-0001--",
  )));
  const decodedLine = '<p class="x">café and more text to fill the line up a little further</p>\r\n';
  assertEquals(mail.html.length, decodedLine.length * (qpBody.length / qpLine.length));
  assert(mail.html.startsWith(decodedLine), "the html did not decode");
  assertEquals(mail.attachments, [
    { filename: "photos.zip", contentType: "application/zip", size: 2 * 1024 * 1024 + 1, inline: false },
  ]);
});

Deno.test("shapes built to waste time still finish", () => {
  // Each of these makes a careless parser rescan the same text over and over. There is no clock
  // in here on purpose (a slow laptop should not fail the gate): if one of them goes quadratic
  // the run visibly stalls on this test.
  const words = mustParse("many encoded words", "Subject: " + "=?utf-8?q?a?= ".repeat(50000) + "\r\n\r\nx");
  assertEquals(words.subject.length, 50000);
  mustParse("many word openers", "Subject: " + "=?".repeat(300000) + "\r\n\r\nx");
  mustParse("many question marks", "Subject: =?utf-8?q" + "?".repeat(300000) + "\r\n\r\nx");
  mustParse("many parameters", "Content-Type: text/plain; " + "a=b;".repeat(100000) + "\r\n\r\nx");
  mustParse("many quotes", 'Content-Type: text/plain; a="' + '\\"'.repeat(200000) + "\r\n\r\nx");
  mustParse("many header lines", "X-Line: 1\r\n".repeat(100000) + "\r\nx");
  mustParse("many folds", "X-Line: 1\r\n" + " more\r\n".repeat(200000) + "\r\nx");
  const nearMiss = mustParse(
    "many near-miss boundaries",
    'Content-Type: multipart/mixed; boundary="b"\r\n\r\n' + "--bx\r\n x--b\r\n--b \t x\r\n".repeat(100000) +
      "--b\r\n\r\nfound\r\n--b--",
  );
  assertEquals(nearMiss.text, "found");
  const equals = mustParse("many equals signs", "Content-Transfer-Encoding: quoted-printable\r\n\r\n" + "=".repeat(1000000));
  // One short: the very last "=" is read as a soft line break whose newline never arrived.
  assertEquals(equals.text.length, 999999);
  mustParse("many padded soft breaks", "Content-Transfer-Encoding: quoted-printable\r\n\r\n" + "= \t ".repeat(300000));
});

// ── Rules the list above does not name ────────────────────────────────────────────────────
Deno.test("what counts as an attachment, and which body wins", () => {
  const forwarded = lines(
    "From: Someone Else <someone@example.net>",
    "Subject: Original",
    'Content-Type: multipart/mixed; boundary="inner-1"',
    "",
    "--inner-1",
    "Content-Type: text/html",
    "",
    "<p>forwarded html</p>",
    "--inner-1",
    'Content-Type: application/zip; name="inner.zip"',
    "Content-Transfer-Encoding: base64",
    "",
    "UEsDBA==",
    "--inner-1--",
  );
  const notes = "These are notes.", log = "log line", calendar = lines("BEGIN:VCALENDAR", "END:VCALENDAR");
  const mail = parseMime(lines(
    "From: Dana Carpenter <dana@example.com>",
    "Subject: Fwd: site photos",
    'Content-Type: multipart/mixed; boundary="mix-1"',
    "",
    "This is a multi-part message in MIME format.",
    "--mix-1",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "First body.",
    "--mix-1",
    "Content-Type: text/plain; charset=utf-8",
    'Content-Disposition: attachment; filename="notes.txt"',
    "",
    notes,
    "--mix-1",
    'Content-Type: text/plain; name="site.log"',
    "",
    log,
    "--mix-1",
    'Content-Type: text/calendar; charset="utf-8"; method=REQUEST',
    "",
    calendar,
    "--mix-1",
    "Content-Type: message/rfc822",
    "",
    forwarded,
    "--mix-1",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Second body, after the files.",
    "--mix-1",
    "Content-Type: text/html; charset=utf-8",
    "Content-Disposition: inline",
    "",
    "<p>First html.</p>",
    "--mix-1--",
    "This text comes after the closing line and is ignored.",
    "--mix-1",
    "Content-Type: text/html",
    "",
    "<p>after the end</p>",
  ));
  assertEquals(mail.text, "First body.");
  // Not the forwarded mail's html: a message/rfc822 part is listed, never opened.
  assertEquals(mail.html, "<p>First html.</p>");
  assertEquals(mail.attachments, [
    { filename: "notes.txt", contentType: "text/plain", size: notes.length, inline: false },
    { filename: "site.log", contentType: "text/plain", size: log.length, inline: false },
    { filename: "", contentType: "text/calendar", size: calendar.length, inline: false },
    { filename: "", contentType: "message/rfc822", size: forwarded.length, inline: false },
  ]);
});

Deno.test("a boundary only matches as a whole line", () => {
  // Outer "abc", inner "abcdef": the inner delimiter lines start with the outer one.
  const mail = parseMime(lines(
    "Content-Type: multipart/mixed; boundary=abc",
    "",
    "--abc",
    "Content-Type: multipart/alternative; boundary=abcdef",
    "",
    "--abcdef",
    "Content-Type: text/plain",
    "",
    "inner text, with --abc in the middle of a line",
    "--abcdef",
    "Content-Type: text/html",
    "",
    "<b>inner html</b>",
    "--abcdef--",
    "--abc   ",
    "Content-Type: application/octet-stream",
    "Content-Disposition: attachment; filename=data.bin",
    "",
    "12345",
    "--abc--",
  ));
  assertEquals(mail.text, "inner text, with --abc in the middle of a line");
  assertEquals(mail.html, "<b>inner html</b>");
  assertEquals(mail.attachments, [{ filename: "data.bin", contentType: "application/octet-stream", size: 5, inline: false }]);

  // A boundary is plain text to search for, even when it looks like a pattern.
  const odd = "=_Part(1)+[x].*?^$";
  const special = parseMime(lines(
    `Content-Type: multipart/mixed; boundary="${odd}"`,
    "",
    `--${odd}`,
    "",
    "A part with no headers of its own is plain text.",
    `--${odd}--`,
  ));
  assertEquals(special.text, "A part with no headers of its own is plain text.");
});

Deno.test("quoted-printable and base64 forgive what mail in the wild does to them", () => {
  const qp = parseMime(
    "Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: Quoted-Printable\r\n\r\n" +
      "price =3D 10=\r\n0 EUR, caf=c3=a9, odd =ZZ and =4 stay, soft LF=\nbreak, padded= \t\r\nline, end=",
  );
  assertEquals(qp.text, "price = 100 EUR, café, odd =ZZ and =4 stay, soft LFbreak, paddedline, end");

  const b64 = (body: string) => parseMime("Content-Transfer-Encoding: BASE64\r\n\r\n" + body).text;
  assertEquals(b64("SGVs bG8s\r\n IHdv*cmxk"), "Hello, world", "spaces, line breaks and a stray character");
  assertEquals(b64("SGVsbG8"), "Hello", "no padding");
  assertEquals(b64("SGVsbG8====="), "Hello", "too much padding");
  assertEquals(b64("SGVsbG8=Q"), "Hello", "one character left over");
  assertEquals(b64("SGk=SGk="), "HiHi", "two padded blocks glued together");
  assertEquals(b64("!!!!"), "", "nothing usable");
});

Deno.test("header names that match built-in object members are just headers", () => {
  const mail = mustParse("prototype names", lines(
    "__proto__: one",
    "constructor: two",
    "toString: three",
    "hasOwnProperty: four",
    "Subject: still here",
    "",
    "body",
  ));
  assertEquals(mail.headers["__proto__"], "one");
  assertEquals(mail.headers["constructor"], "two");
  assertEquals(mail.headers["tostring"], "three");
  assertEquals(mail.headers["hasownproperty"], "four");
  assertEquals(mail.subject, "still here");
  assertEquals(mail.text, "body");
  // And a mail without them does not appear to have them.
  const clean = parseMime("Subject: clean\r\n\r\nbody");
  assertEquals(clean.headers["constructor"], undefined);
  assertEquals(Object.keys(clean.headers), ["subject"]);
});
