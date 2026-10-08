// The Release-note trailer parser and the holds release-ci applies before it copies a note.
// Self-contained on purpose: no jsr:/npm: imports. Preflight runs this group.
// Builder names and slugs below are MADE UP. The repo is public.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  builderNeedles, heldReason, isFullSha, namesBuilder, normTitle, parseReleaseTrailers, projectRef, trailerBlock,
  uuidPrefixRange,
} from "./releaseTrailer.ts";

const CO = "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>";
const msg = (...trailers: string[]) => `Subject line of the commit\n\nBody paragraph explaining the change.\n\n${trailers.join("\n")}\n`;

Deno.test("a feature note with section, detail and a Projects ref, in the Co-Authored-By block", () => {
  const p = parseReleaseTrailers(msg(
    "Release-note: feature: Estimates can now carry a second contact",
    "Release-section: Contacts",
    "Release-detail: Add a co-buyer from the contact card; both get the estimate.",
    "Projects: 3f2a9c1e",
    CO,
  ));
  assertEquals(p.refused, null);
  assertEquals(p.note, {
    kind: "feature", title: "Estimates can now carry a second contact", section: "Contacts",
    detail: "Add a co-buyer from the contact card; both get the estimate.",
  });
  assertEquals(p.projects, ["3f2a9c1e"]);
  assertEquals(p.badProjects, 0);
});

Deno.test("the title is copied exactly as written: case, punctuation and spacing inside it untouched", () => {
  const t = "Fix: the  Door picker remembers your LAST look (again)";
  const p = parseReleaseTrailers(msg(`Release-note: fix: ${t}   `, CO));
  assertEquals(p.note && p.note !== "none" ? p.note.title : null, t);
  assertEquals(p.note && p.note !== "none" ? p.note.kind : null, "fix");
});

Deno.test("keys are case-insensitive, and the kind is normalised to the column's values", () => {
  const p = parseReleaseTrailers(msg("release-NOTE: FEATURE: Saved views now remember the sort", CO));
  assertEquals(p.note && p.note !== "none" ? p.note.kind : null, "feature");
});

Deno.test("Release-note: none, and no trailer at all, are different answers", () => {
  assertEquals(parseReleaseTrailers(msg("Release-note: none", CO)).note, "none");
  assertEquals(parseReleaseTrailers(msg("Release-note: NONE", CO)).note, "none");
  const absent = parseReleaseTrailers(msg(CO));
  assertEquals([absent.note, absent.refused], [null, null]);
});

Deno.test("the trailer block is the LAST paragraph, and only when every line in it is a trailer", () => {
  // In the body, not the final block: not a trailer.
  assertEquals(parseReleaseTrailers("Subject\n\nRelease-note: fix: The body is not the trailer block\n\n" + CO).note, null);
  // A final paragraph with prose in it is not a trailer block (git's rule, kept strict).
  assertEquals(parseReleaseTrailers("Subject\n\nRelease-note: fix: Mixed with prose is not a block\nsee above\n").note, null);
  // A one-paragraph message has no trailers: the subject is never one.
  assertEquals(parseReleaseTrailers("Release-note: fix: A subject line is not a trailer").note, null);
  // CRLF and trailing blank lines are fine.
  const p = parseReleaseTrailers("Subject\r\n\r\nRelease-note: fix: Works with CRLF line endings\r\n" + CO + "\r\n\r\n");
  assertEquals(p.note && p.note !== "none" ? p.note.title : null, "Works with CRLF line endings");
  assertEquals(trailerBlock("Subject\n\nKey: v\n  more of v\nOther: w").map(([k, v, c]) => [k, v, c]), [["key", "v more of v", 1], ["other", "w", 0]]);
});

Deno.test("refusals: bad kind, length, URL, two notes, multi-line title, control characters", () => {
  const why = (...t: string[]) => parseReleaseTrailers(msg(...t, CO)).refused;
  assert(/feature: <title>/.test(why("Release-note: improvement: Something nicer than before") || ""));
  assert(/10-120 characters/.test(why("Release-note: fix: Too short") || ""));
  assert(/10-120 characters/.test(why(`Release-note: fix: ${"x".repeat(121)}`) || ""));
  assertEquals(why(`Release-note: fix: ${"é".repeat(120)}`), null, "120 accented characters are 120, not 240");
  assert(/URL/.test(why("Release-note: fix: Try it at https://example.invalid/portal now") || ""));
  assert(/URL/.test(why("Release-note: fix: Try it on beta.structurestudio.app today") || ""));
  assert(/URL/.test(why("Release-note: fix: Docs are at www.example.invalid for now") || ""));
  assert(/More than one Release-note/.test(why("Release-note: fix: First note of two here", "Release-note: none") || ""));
  assert(/one line/.test(why("Release-note: fix: A title that wraps", "  onto a second line") || ""));
  assert(/control character/.test(why("Release-note: fix: Has a\u0007 bell in the title") || ""));
  // A refused note is never half-used.
  assertEquals(parseReleaseTrailers(msg("Release-note: fix: Too short", CO)).note, null);
});

Deno.test("Release-section and Release-detail rules", () => {
  const why = (...t: string[]) => parseReleaseTrailers(msg("Release-note: feature: A perfectly good title here", ...t, CO)).refused;
  assertEquals(why("Release-section: Build Schedule"), null);
  assertEquals(why("Release-section: Orders & Invoices"), null);
  // The product has a 3D area: a section may start with a digit, but it needs a letter.
  assertEquals(why("Release-section: 3D Design"), null);
  assertEquals(why("Release-section: 3D"), null);
  assert(/product area/.test(why("Release-section: 2026") || ""));
  assert(/product area/.test(why("Release-section: -Designer") || ""));
  assert(/product area/.test(why("Release-section: X") || ""));
  assert(/product area/.test(why(`Release-section: ${"A".repeat(33)}`) || ""));
  assert(/product area/.test(why("Release-section: <b>Designer</b>") || ""));
  assert(/More than one Release-section/.test(why("Release-section: Designer", "Release-section: Contacts") || ""));
  assert(/URL/.test(why("Release-detail: More at https://example.invalid") || ""));
  assert(/1-1000/.test(why(`Release-detail: ${"d".repeat(1001)}`) || ""));
  const p = parseReleaseTrailers(msg("Release-note: feature: A perfectly good title here", "Release-detail: First line of detail", "  and its continuation.", CO));
  assertEquals(p.note && p.note !== "none" ? p.note.detail : null, "First line of detail and its continuation.");
  // Section/detail with no note is reported, so the author sees it.
  assert(/without a Release-note/.test(parseReleaseTrailers(msg("Release-section: Designer", CO)).refused || ""));
});

Deno.test("Projects refs: whole uuids and 8+ hex prefixes, de-duplicated, capped, bad ones counted", () => {
  const p = parseReleaseTrailers(msg(
    "Release-note: none",
    "Projects: 3F2A9C1E, 0123abcd-ef01-4abc-8def-0123456789ab 3f2a9c1e",
    "Projects: 1234567 nothex!! 3f2a-9c1e abcdef01-",
    CO,
  ));
  assertEquals(p.projects, ["3f2a9c1e", "0123abcdef014abc8def0123456789ab"]);
  assertEquals(p.badProjects, 4);
  const many = parseReleaseTrailers(msg(`Projects: ${Array.from({ length: 12 }, (_, i) => `aaaaaaa${i.toString(16)}`).join(" ")}`, CO));
  assertEquals([many.projects.length, many.badProjects], [10, 2]);
  assertEquals(projectRef("3f2a9c1e-1b2c"), "3f2a9c1e1b2c");
  assertEquals(projectRef("3f2a9c1"), null);
});

Deno.test("uuidPrefixRange covers exactly the uuids that start with the prefix", () => {
  assertEquals(uuidPrefixRange("3f2a9c1e"), { lo: "3f2a9c1e-0000-0000-0000-000000000000", hi: "3f2a9c1e-ffff-ffff-ffff-ffffffffffff" });
  assertEquals(uuidPrefixRange("0123abcdef014abc8def0123456789ab"),
    { lo: "0123abcd-ef01-4abc-8def-0123456789ab", hi: "0123abcd-ef01-4abc-8def-0123456789ab" });
  assertEquals(uuidPrefixRange("zzzzzzzz"), null);
});

Deno.test("heldReason: pricing words and dollar amounts, on whole words only", () => {
  for (const t of ["New price list for sheds", "Prices now round", "Pricing tab moved", "Lower cost on metal",
    "Billing page is faster", "Discounts show on the estimate", "Margin report", "Delivery fee per mile", "Save $5 on",
    "Costs line up"]) {
    assert(heldReason(t), `should hold: ${t}`);
  }
  for (const t of ["Feedback replies arrive faster", "Costume-free fix for the 3D view", "Fixed the bill-of-lading label",
    "Estimates email again", "Page margins no longer clip"] as const) {
    if (t === "Page margins no longer clip") { assert(heldReason(t), "margins is on the list; a person decides"); continue; }
    assertEquals(heldReason(t), null, t);
  }
  assertEquals(heldReason("Pricing tab moved"), 'mentions pricing ("pricing")');
  assertEquals(heldReason("Now $10 less"), "mentions a dollar amount");
});

Deno.test("builder names: whole words, slugs read with or without hyphens, never which one", () => {
  const needles = builderNeedles([
    { client_id: "acme-sheds", names: ["Acme Sheds & Barns", null] },
    { client_id: "zed", names: ["Zed"] },          // under 4 characters: dropped, too easy to hit by accident
    { client_id: "bravo-barns", names: ["  "] },
  ]);
  assertEquals(needles.sort(), ["acme sheds", "acme sheds barns", "bravo barns"]);
  assert(namesBuilder("Fixed the estimate for Acme Sheds", needles));
  assert(namesBuilder("Fixed acme-sheds' door picker", needles));
  assert(namesBuilder("BRAVO BARNS asked for this", needles));
  assert(!namesBuilder("Fixed the acmesheds label", needles), "not a whole-word match");
  assert(!namesBuilder("Zed's request: wider doors", needles), "short names are not needles");
  assert(!namesBuilder("Bravo, the barns look better", needles), "words apart are not the name");
  // The answer is a boolean: there is nothing to echo.
  assertEquals(typeof namesBuilder("x", needles), "boolean");
});

Deno.test("normTitle and isFullSha", () => {
  assertEquals(normTitle("  Estimates   now carry\ta second Contact "), "estimates now carry a second contact");
  assert(isFullSha("a".repeat(40)) && isFullSha("b".repeat(64)));
  assert(!isFullSha("A".repeat(40)) && !isFullSha("a".repeat(39)) && !isFullSha(42));
});
