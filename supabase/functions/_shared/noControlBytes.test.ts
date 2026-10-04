// No raw BACKSPACE bytes in edge-function source (2026-10-05).
//
// A patch script that types "\b" through a shell or a Python string writes byte 0x08, not the two
// characters a regex needs for a word boundary. The regex still parses, matches less than it
// should, and nothing fails: portal-settings' "was the address rejected?" check carried two of
// them from 7df087b until 2026-10-05, so a bare "resend 403" read as "the send didn't go through".
// This scans every .ts file under supabase/functions so the next one fails here instead.

const ROOT = new URL("../", import.meta.url);
const BACKSPACE = String.fromCharCode(8);

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
