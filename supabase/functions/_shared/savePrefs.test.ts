// Unit tests for one person's prefs as save_prefs keeps them (_shared/savePrefs.ts).
//
// Two rules (2026-10-12): the Contacts tab's own default (contactsView) is kept only in its one
// shape, and a save MERGES with what is stored instead of replacing it, so a screen that knows
// only some prefs cannot wipe another card's choice. The second pins the bug the Contacts hub
// would otherwise have shipped: its picker saving contactsView alone would have erased the old
// Pipeline default, the reply-to address, the signature and the card order. Also pinned: that
// portal-settings really runs both, at the end of the whitelist, before the one write.
//
// Run: deno test --node-modules-dir=none --allow-read supabase/functions/_shared/savePrefs.test.ts

import { assert, assertEquals } from "jsr:@std/assert@1";
import { cleanContactsView, mergePrefs, PREF_KEYS } from "./savePrefs.ts";

const PIPE = "0f7c4b2e-8a1d-4c3b-9e6f-2a5d7c8b9e01";

Deno.test("contactsView: the contact list, the Design list or one pipeline, and nothing else", () => {
  assertEquals(cleanContactsView("people"), "people");
  assertEquals(cleanContactsView("designs"), "designs");
  assertEquals(cleanContactsView("p-" + PIPE), "p-" + PIPE);
  assertEquals(cleanContactsView("P-" + PIPE.toUpperCase()), "p-" + PIPE, "lower-cased, so it matches the tab's id");
  for (const bad of ["", "pipeline", "list", "contacts", "p-", "p-123", "p-" + PIPE + "x", " people", "people ",
    "p-" + PIPE + "/x", null, undefined, 7, true, ["people"], { v: "people" }]) {
    assertEquals(cleanContactsView(bad), null, JSON.stringify(bad));
  }
});

Deno.test("a key the save does not name keeps what is stored", () => {
  const stored = { designsView: "list", replyToEmail: "rep@example.test", replyCopy: true, emailSignature: "Pat", cardOrder: { contact: ["deals"] } };
  // The Contacts tab's picker, saving its own key only.
  const out = mergePrefs({ contactsView: "designs" }, { contactsView: "designs" }, stored);
  assertEquals(out, { ...stored, contactsView: "designs" });
});

Deno.test("a key the save names is decided by the save alone: set, changed or cleared", () => {
  const stored = { replyToEmail: "rep@example.test", replyCopy: true, emailSignature: "Pat", contactsView: "people" };
  // Cleared: named, failed its check (or is how a card clears it), so it is not in `clean`.
  const cleared = mergePrefs({}, { replyToEmail: "", replyCopy: false, emailSignature: "", contactsView: null }, stored);
  assertEquals(cleared, {});
  // Changed.
  assertEquals(mergePrefs({ contactsView: "p-" + PIPE }, { contactsView: "p-" + PIPE }, stored).contactsView, "p-" + PIPE);
  // My Profile names every key on every save, so nothing stored can come back under it.
  const full = { designsView: "pipeline", contactsView: "people" };
  const raw = { designsView: "pipeline", contactsView: "people", replyToEmail: "", replyCopy: false, emailSignature: "", cardOrder: null };
  assertEquals(mergePrefs(full, raw, stored), full);
});

Deno.test("only listed keys are carried from the stored blob", () => {
  const out = mergePrefs({}, {}, { designsView: "list", stray: "x", __proto__x: 1, contactsView: "designs" });
  assertEquals(out, { designsView: "list", contactsView: "designs" });
  assertEquals([...PREF_KEYS].sort(), ["cardOrder", "contactsView", "designsView", "emailSignature", "replyCopy", "replyToEmail"]);
});

Deno.test("nothing stored, or a stored value that isn't a map, adds nothing", () => {
  for (const stored of [null, undefined, "x", 7, ["designsView"], { designsView: null }]) {
    assertEquals(mergePrefs({ replyCopy: true }, { replyCopy: true }, stored), { replyCopy: true }, JSON.stringify(stored));
  }
  // `clean` itself is not changed.
  const clean = { contactsView: "people" };
  mergePrefs(clean, {}, { designsView: "list" });
  assertEquals(clean, { contactsView: "people" });
});

Deno.test("portal-settings save_prefs keeps contactsView through cleanContactsView and merges before its one write", async () => {
  const src = (await Deno.readTextFile(new URL("../portal-settings/index.ts", import.meta.url))).replace(/\r\n/g, "\n");
  assert(src.includes(`import { cleanContactsView, mergePrefs } from "../_shared/savePrefs.ts";`));
  const at = src.indexOf(`if (action === "save_prefs") {`);
  const save = src.slice(at, src.indexOf(`if (action === "save") {`, at));
  assert(at > 0 && save.length > 1000, "save_prefs not found");
  assert(save.includes("const view = cleanContactsView(raw.contactsView);\n      if (view) clean.contactsView = view;"), "contactsView is not kept through its check");
  assert(!/clean\.contactsView\s*=\s*raw\./.test(save), "the raw value reaches the row");
  // The merge reads the caller's own row (as `status` does) and runs after every key's check...
  const merge = save.indexOf("Object.assign(clean, mergePrefs(clean, raw, cur?.prefs));");
  assert(merge > save.indexOf("clean.cardOrder = co;"), "the merge must come after the last key's check");
  assert(/\.from\("client_users"\)\s*\.select\("prefs"\)\.eq\("user_id", userId\)\.limit\(1\)\.maybeSingle\(\);/.test(save), "the stored prefs are not the caller's own row");
  // ...and before the one write, which still writes `clean`.
  const write = save.indexOf(".update({ prefs: Object.keys(clean).length ? clean : null })");
  assert(write > merge, "the write must come after the merge");
  assertEquals((save.match(/\.update\(\{ prefs:/g) ?? []).length, 1, "one write");
});
