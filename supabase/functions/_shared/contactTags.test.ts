// contactTags.ts: the rules a tag typed on a customer's record follows. Made-up tags only.
import { assertEquals } from "jsr:@std/assert@1";
import { changeTags, storedTags, TAG_MAX_LEN, tagsFromInput, tagsText, TAGS_PER_CONTACT_MAX } from "./contactTags.ts";

Deno.test("a typed value is split, trimmed, capped and named once, like the import's Tags column", () => {
  assertEquals(tagsFromInput(" Wave 1 , hot; HOT ,, "), ["Wave 1", "hot"]);
  assertEquals(tagsFromInput(""), []);
  assertEquals(tagsFromInput(null), []);
  assertEquals(tagsFromInput("x".repeat(80))[0].length, TAG_MAX_LEN);
});

Deno.test("adding keeps what is there, skips a tag already there in any case, and appends the rest", () => {
  const r = changeTags(["Wave 1", "VIP"], ["vip", "Lot buyer"], true);
  assertEquals(r, { ok: true, labels: ["Wave 1", "VIP", "Lot buyer"], added: ["Lot buyer"], removed: [] });
  // Nothing new: nothing added, so no "tag added" automation would run.
  assertEquals(changeTags(["Wave 1"], ["WAVE 1"], true), { ok: true, labels: ["Wave 1"], added: [], removed: [] });
  // A list that was never set.
  assertEquals(changeTags(null, ["New"], true), { ok: true, labels: ["New"], added: ["New"], removed: [] });
});

Deno.test("removing drops the tag whatever its case, and says when there was nothing to drop", () => {
  assertEquals(changeTags(["Wave 1", "VIP"], ["wave 1"], false), { ok: true, labels: ["VIP"], added: [], removed: ["Wave 1"] });
  assertEquals(changeTags(["VIP"], ["Gone"], false), { ok: true, labels: ["VIP"], added: [], removed: [] });
});

Deno.test("a blank tag is refused, and so is a list past the cap", () => {
  assertEquals(changeTags(["a"], ["  "], true), { ok: false, code: "no_tag" });
  assertEquals(changeTags(["a"], [], false), { ok: false, code: "no_tag" });
  const full = Array.from({ length: TAGS_PER_CONTACT_MAX }, (_, i) => `t${i}`);
  assertEquals(changeTags(full, ["one more"], true), { ok: false, code: "too_many" });
  // Re-adding one already there is not "one more".
  assertEquals(changeTags(full, ["T3"], true).ok, true);
});

Deno.test("a stored list keeps only real tags, and reads as a line for the Changelog", () => {
  assertEquals(storedTags(["a", "", "  ", 3, null, "b"]), ["a", "b"]);
  assertEquals(storedTags("a,b"), []);
  assertEquals(tagsText(["a", "b"]), "a, b");
  assertEquals(tagsText([]), null);
});
