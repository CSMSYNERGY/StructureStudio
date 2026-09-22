// Every writer of a replaced-in-place customer PDF, pinned against the SHIPPED handlers
// (review, 2026-09-17).
//
// documentUpload.test.ts proves what FIXED_PATH_PDF_UPLOAD puts on the wire. What it cannot see is
// whether each writer passes it, and the regression is one short edit that throws nothing: a
// writer going back to `{ contentType: "application/pdf", upsert: true }`, or a new writer of the
// quote or invoice document written that way. Either quietly puts the one-hour browser cache back
// on a document a re-price, a reissue or a countersignature overwrites, and the customer opens
// the old total from the new email.
//
// THE RULE PINNED. In every function, every Storage upload of a PDF passes FIXED_PATH_PDF_UPLOAD,
// with one named exception: the GHL-mode formal estimate (<code>-estimate.pdf), which this work
// leaves alone. Same technique as quoteWriteRaceWiring_test: read the source, so a drift fails the
// push. If an anchor moves, re-point it — do not delete the test.

import { assert, assertEquals } from "jsr:@std/assert@1";

const FUNCTIONS = new URL("../../", import.meta.url);

/** Source with whole-line comments removed, so a comment that NAMES a trap cannot trip it.
 *  Line endings are normalised first: a Windows checkout (core.autocrlf) reads CRLF. */
const code = (src: string) => src.replace(/\r\n/g, "\n").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");

const entrypoints: { name: string; src: string }[] = [];
for await (const e of Deno.readDir(FUNCTIONS)) {
  if (!e.isDirectory || e.name.startsWith("_")) continue;
  try {
    entrypoints.push({ name: e.name, src: code(await Deno.readTextFile(new URL(`${e.name}/index.ts`, FUNCTIONS))) });
  } catch (_) { /* a directory with no index.ts is not a function */ }
}
entrypoints.sort((a, b) => a.name.localeCompare(b.name));

type Upload = { fn: string; pathArg: string; bodyArg: string; options: string; at: number; src: string };

/** Every `.upload(path, body, options)` call, with its three arguments as written. */
function uploads(): Upload[] {
  const out: Upload[] = [];
  for (const { name, src } of entrypoints) {
    const re = /\.upload\(\s*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      // Split the argument list at top-level commas, up to the call's closing parenthesis.
      const args: string[] = [];
      let depth = 0, cur = "", i = m.index + m[0].length;
      let quote: string | null = null;
      for (; i < src.length; i++) {
        const ch = src[i];
        if (quote) {
          cur += ch;
          if (ch === "\\") { cur += src[++i]; continue; }
          if (ch === quote) quote = null;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") { quote = ch; cur += ch; continue; }
        if (ch === "(" || ch === "{" || ch === "[") depth++;
        if (ch === ")" || ch === "}" || ch === "]") {
          if (depth === 0) break;
          depth--;
        }
        if (ch === "," && depth === 0) { args.push(cur.trim()); cur = ""; continue; }
        cur += ch;
      }
      if (cur.trim()) args.push(cur.trim());
      out.push({ fn: name, pathArg: args[0] ?? "", bodyArg: args[1] ?? "", options: args[2] ?? "", at: m.index, src });
    }
  }
  return out;
}

/** The expression the path variable was last assigned before the call, when it is a plain `const`. */
function pathDefinition(u: Upload): string | null {
  if (!/^[A-Za-z_$][\w$]*$/.test(u.pathArg)) return u.pathArg;
  const before = u.src.slice(0, u.at);
  const re = new RegExp(`const\\s+${u.pathArg.replace(/\$/g, "\\$")}\\s*=\\s*([^;]+);`, "g");
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(before))) last = m[1].trim();
  return last;
}

const ALL = uploads();
const where = (u: Upload) => `${u.fn}: .upload(${u.pathArg}, ${u.bodyArg}, ${u.options})`;

Deno.test("the scan found the upload calls it is meant to police", () => {
  // A scan that matched nothing would pass every test below. These are the writers as of the fix.
  const fixed = ALL.filter((u) => u.options === "FIXED_PATH_PDF_UPLOAD").map((u) => u.fn);
  assertEquals(fixed.filter((f) => f === "portal-settings").length, 3, "portal-settings: the quote regenerate, reissue_invoice, send_invoice");
  assertEquals(fixed.filter((f) => f === "submit-estimate").length, 1, "submit-estimate: the quote");
  assertEquals(fixed.filter((f) => f === "customer-accept").length, 2, "customer-accept: the quote and invoice countersignatures");
});

Deno.test("every PDF upload in every function passes FIXED_PATH_PDF_UPLOAD, except the GHL-mode formal estimate", () => {
  const bad: string[] = [];
  let estimate = 0;
  for (const u of ALL) {
    if (u.options === "FIXED_PATH_PDF_UPLOAD") continue;
    const def = pathDefinition(u) ?? "";
    const isPdf = /application\/pdf/.test(u.options) || /\.pdf\b/.test(def) || /pdf/i.test(u.bodyArg) || /countersigned/.test(u.bodyArg);
    if (!isPdf) continue;
    if (u.fn === "submit-estimate" && /^`\$\{clientId\}\/\$\{designId\}-estimate\.pdf`$/.test(def)) { estimate++; continue; }
    bad.push(`${where(u)}  [path = ${def || "?"}]`);
  }
  // The exception has to be SEEN, or a scan that stopped recognising PDF uploads would pass.
  assertEquals(estimate, 1, "the GHL-mode formal estimate upload in submit-estimate was not found by the scan");
  assert(bad.length === 0, `a PDF upload without FIXED_PATH_PDF_UPLOAD — a browser can keep the old document for an hour:\n  ${bad.join("\n  ")}`);
});

Deno.test("the constant is only ever used for the quote and invoice documents", () => {
  // The other direction: max-age=0 on a document that is NOT replaced in place costs a revalidation
  // on every open for nothing, and would mean the list above has grown without anyone saying why.
  for (const u of ALL.filter((x) => x.options === "FIXED_PATH_PDF_UPLOAD")) {
    const def = pathDefinition(u) ?? "";
    const quoteOrInvoice = /-(quote|invoice)\.pdf`$/.test(def) ||
      /^(quotePdfUrl|invPdfUrl)\.slice\(`\$\{supabaseUrl\}\/storage\/v1\/object\/public\/floor-plans\/`\.length\)$/.test(def);
    assert(quoteOrInvoice, `${where(u)} uses FIXED_PATH_PDF_UPLOAD for a path that is not the quote or invoice document: ${def || "?"}`);
  }
});

Deno.test("each writer imports the constant from the one shared module", () => {
  for (const fn of ["portal-settings", "submit-estimate", "customer-accept"]) {
    const src = entrypoints.find((e) => e.name === fn)?.src ?? "";
    assert(/import \{ FIXED_PATH_PDF_UPLOAD \} from "\.\.\/_shared\/documentUpload\.ts";/.test(src), `${fn} no longer imports FIXED_PATH_PDF_UPLOAD from _shared/documentUpload.ts`);
  }
});
