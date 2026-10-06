// No raw BACKSPACE bytes in edge-function source (2026-10-05).
//
// A patch script that types "\b" through a shell or a Python string writes byte 0x08, not the two
// characters a regex needs for a word boundary. The regex still parses, matches less than it
// should, and nothing fails: portal-settings' "was the address rejected?" check carried two of
// them from 7df087b until 2026-10-05, so a bare "resend 403" read as "the send didn't go through".
// This scans every .ts file under supabase/functions so the next one fails here instead.
//
// Widened 2026-10-06 to every control byte except tab, LF and CR (plus DEL): the bug sweep left
// raw NUL / 0x1f / 0x7f bytes in invoicePayment.ts's sanitising regex and a raw NUL separator in
// changeOrderDiff.ts. Those happened to behave like their escapes, but they make grep and diff
// treat the file as binary, and the same slip with another byte changes behaviour silently.
// Write the escape (\x00, \x1f, \x7f) instead.

const ROOT = new URL("../", import.meta.url);
const BACKSPACE = String.fromCharCode(8);
// Any C0 control byte other than tab (9), LF (10) and CR (13), and DEL (127).
const isStrayControl = (code: number) => (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127;

async function* tsFiles(dir: URL): AsyncGenerator<URL> {
  for await (const e of Deno.readDir(dir)) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const u = new URL(e.name + (e.isDirectory ? "/" : ""), dir);
    if (e.isDirectory) yield* tsFiles(u);
    else if (e.name.endsWith(".ts")) yield u;
  }
}

Deno.test("no edge-function source file contains a raw backspace byte (a \\b typed through a script)", async () => {
  const bad: string[] = [];
  for await (const f of tsFiles(ROOT)) {
    const text = await Deno.readTextFile(f);
    text.split("\n").forEach((line, i) => {
      if (line.includes(BACKSPACE)) bad.push(`${f.pathname.split("/functions/")[1]}:${i + 1}`);
    });
  }
  if (bad.length) throw new Error(`raw 0x08 bytes (use \\b in the regex): ${bad.join(", ")}`);
});

Deno.test("no edge-function source file contains any other raw control byte (write \\x00-style escapes)", async () => {
  const bad: string[] = [];
  for await (const f of tsFiles(ROOT)) {
    const text = await Deno.readTextFile(f);
    text.split("\n").forEach((line, i) => {
      for (let j = 0; j < line.length; j++) {
        const code = line.charCodeAt(j);
        if (isStrayControl(code)) {
          bad.push(`${f.pathname.split("/functions/")[1]}:${i + 1} (0x${code.toString(16).padStart(2, "0")})`);
          break;
        }
      }
    });
  }
  if (bad.length) throw new Error(`raw control bytes (write the escape instead): ${bad.join(", ")}`);
});
