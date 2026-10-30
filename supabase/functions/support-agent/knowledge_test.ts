// knowledge.ts is generated from kb.md and faq.md (scripts/support-kb.mjs). This fails when the
// embedded string drifts from the two files, so an edited FAQ cannot ship without regenerating, and
// when the knowledge carries anything the public repo must not: an email address or our own consoles.
//
// Run: deno test --allow-env --allow-read --node-modules-dir=none support-agent/   (from supabase/functions)

import { KNOWLEDGE } from "./knowledge.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("knowledge.ts is exactly kb.md + faq.md (rerun scripts/support-kb.mjs after editing either)", async () => {
  const read = async (f: string) => (await Deno.readTextFile(new URL(f, import.meta.url))).replace(/\r/g, "");
  const want = `${(await read("./kb.md")).trimEnd()}\n\n${(await read("./faq.md")).trimEnd()}\n`;
  assert(KNOWLEDGE === want, "knowledge.ts is stale: run node scripts/support-kb.mjs");
});

Deno.test("the knowledge names no inbox and none of our own consoles", () => {
  assert(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(KNOWLEDGE), "no email address");
  for (const internal of ["(/accounts)", "(/admin)", "(/projects)", "(/advanced)", "Operator console"]) {
    assert(!KNOWLEDGE.includes(internal), `no ${internal}`);
  }
  assert(KNOWLEDGE.includes("24 hours"), "the reply promise is in the FAQ");
});
