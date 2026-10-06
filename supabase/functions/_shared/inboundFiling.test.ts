/**
 * Unit tests for the two filing rules email-inbound uses (inboundFiling.ts).
 *
 * WHY THESE EXIST. Since 2026-10-07 reply copies are opt-in, so for most reps the customer's
 * record is the only place a reply lands. A reply to a merged-away contact has to reach the live
 * record, and a reply's attached files, which nothing stores yet, have to be said out loud on it
 * rather than vanish. Both are pinned here with an in-memory contacts table; no network, no
 * database.
 *
 * Run: deno test --allow-env --node-modules-dir=none supabase/functions/_shared/inboundFiling.test.ts
 * (the pre-push gate runs this for you — see scripts/preflight.mjs)
 */

import { attachmentNote, type ContactLink, followMerged } from "./inboundFiling.ts";

// Local assertions rather than jsr:@std/assert: the pre-push gate must not need a registry fetch.
function assertEquals<T>(actual: T, expected: T, msg = ""): void {
  if (actual !== expected) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
      + (msg ? ` — ${msg}` : ""));
  }
}

/** A tenant's contacts as the caller's scoped lookup sees them, recording every id asked for. */
function table(rows: ContactLink[]) {
  const asked: string[] = [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const lookup = (id: string) => {
    asked.push(id);
    return Promise.resolve(byId.get(id) ?? null);
  };
  return { lookup, asked };
}

Deno.test("followMerged: a live contact is filed on itself, with one read", async () => {
  const t = table([{ id: "A", merged_into: null }]);
  assertEquals(await followMerged(t.lookup, "A"), "A");
  assertEquals(t.asked.join(","), "A");
});

Deno.test("followMerged: a token for a merged contact files the reply on the one it was merged into", async () => {
  const t = table([{ id: "A", merged_into: "B" }, { id: "B", merged_into: null }]);
  assertEquals(await followMerged(t.lookup, "A"), "B");
});

Deno.test("followMerged: a chain of merges is followed to the end", async () => {
  const t = table([
    { id: "A", merged_into: "B" }, { id: "B", merged_into: "C" }, { id: "C", merged_into: null },
  ]);
  assertEquals(await followMerged(t.lookup, "A"), "C");
});

Deno.test("followMerged: an unknown token links nothing, exactly as before", async () => {
  const t = table([{ id: "A", merged_into: null }]);
  assertEquals(await followMerged(t.lookup, "Z"), null);
});

Deno.test("followMerged: a merged_into the tenant-scoped lookup can't see stops at the last contact found", async () => {
  // e.g. a hand-edited row pointing at another tenant's contact: the scoped lookup doesn't find
  // it, and the reply stays on this tenant's own (tombstoned) contact, never the foreign id.
  const t = table([{ id: "A", merged_into: "OTHER-TENANT" }]);
  assertEquals(await followMerged(t.lookup, "A"), "A");
});

Deno.test("followMerged: a loop or an over-long chain ends, with a bounded number of reads", async () => {
  const loop = table([{ id: "A", merged_into: "B" }, { id: "B", merged_into: "A" }]);
  assertEquals(await followMerged(loop.lookup, "A"), "B");
  assertEquals(loop.asked.length, 2, "a loop is not walked twice");

  const rows: ContactLink[] = [];
  for (let i = 0; i < 20; i++) rows.push({ id: `C${i}`, merged_into: `C${i + 1}` });
  const long = table(rows);
  assertEquals(await followMerged(long.lookup, "C0", 5), "C5");
  assertEquals(long.asked.length, 6, "at most maxHops + 1 reads");
});

Deno.test("attachmentNote: no list, an empty list or a non-array is no files and no note", () => {
  for (const v of [undefined, null, [], "a.jpg", { filename: "a.jpg" }, 3]) {
    const r = attachmentNote(v);
    assertEquals(r.count, 0, JSON.stringify(v));
    assertEquals(r.note, null, JSON.stringify(v));
  }
});

Deno.test("attachmentNote: says how many files weren't kept, names them, and who to ask", () => {
  assertEquals(attachmentNote([{ id: "1", filename: "site.jpg", content_type: "image/jpeg" }]).note,
    "[1 attached file wasn't kept: site.jpg. Ask CSM Synergy if you need it.]");
  const two = attachmentNote([{ filename: "site.jpg" }, { filename: "plan.pdf" }]);
  assertEquals(two.count, 2);
  assertEquals(two.note, "[2 attached files weren't kept: site.jpg, plan.pdf. Ask CSM Synergy if you need them.]");
});

Deno.test("attachmentNote: a long list shows five names and counts the rest; nameless files still count", () => {
  const seven = attachmentNote(Array.from({ length: 7 }, (_, i) => ({ filename: `p${i}.jpg` })));
  assertEquals(seven.count, 7);
  assertEquals(seven.note, "[7 attached files weren't kept: p0.jpg, p1.jpg, p2.jpg, p3.jpg, p4.jpg and 2 more. Ask CSM Synergy if you need them.]");
  assertEquals(attachmentNote([{}, { id: "x" }, null]).note,
    "[3 attached files weren't kept. Ask CSM Synergy if you need them.]");
  assertEquals(attachmentNote([{ filename: "a.jpg" }, {}, {}]).note,
    "[3 attached files weren't kept: a.jpg and 2 more. Ask CSM Synergy if you need them.]");
});

Deno.test("attachmentNote: a file name can't break the line (control characters, newlines, length)", () => {
  const r = attachmentNote([{ filename: "bad\nname\u0000\t.jpg" }, { Name: "x".repeat(200) }]);
  assertEquals(r.note!.includes("\n"), false, "no newline from a file name");
  assertEquals(r.note!.includes("\u0000"), false, "no control character");
  assertEquals(r.note!.startsWith("[2 attached files weren't kept: bad name .jpg, "), true, r.note!);
  assertEquals(r.note!.includes("x".repeat(79) + "…"), true, "a long name is cut at 80 characters");
  assertEquals(r.note!.includes("x".repeat(80)), false, "and no longer");
});
