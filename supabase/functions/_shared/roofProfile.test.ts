// The metal roof profile, per design (2026-10-06): roofProfile.ts, the order screen's Roof line
// (attributeLines.ts computeRoofLine) and the CRM History's version diff (crmFeed.ts).
//
// Carolyn, 10-06: "there is no standard it is per individual design". A design carries its own
// AG Panel / Standing Seam pick, its style's value is the starting one, and AG Panel is the default.
// The property pinned hardest here is the one that keeps signed orders quiet: every input except a
// metal roof on standing seam gives the Roof line the words it has always had, byte for byte,
// because a Roof description that moves on a signed order raises "Roof: options updated".
//
// Deliberately dependency-free (no jsr:/npm: imports), the rule the other _shared tests follow.
// Run: deno test --node-modules-dir=none supabase/functions/_shared/roofProfile.test.ts

import { agreedRoofProfile, effectiveRoofProfile, normRoofProfile, roofLineDesc, roofTypeLabel } from "./roofProfile.ts";
import { computeRoofLine } from "./attributeLines.ts";
import { buildCrmFeed } from "./crmFeed.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures++; throw new Error(`${name}${detail ? `: ${detail}` : ""}`); }
}
const eq = (name: string, got: unknown, want: unknown) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/** The Roof line's words exactly as submit-estimate and computeRoofLine built them before
 *  2026-10-06 (ea0a0de0), for the byte-for-byte comparison. */
const legacyDesc = (roofType: unknown, roofColor: unknown) => {
  const type = String(roofType ?? "").trim();
  const color = String(roofColor ?? "").trim();
  if (!type) return "No roof selected";
  return color ? `${type} — ${color}` : `${type} — (color TBD)`;
};

// ── normRoofProfile ────────────────────────────────────────────────────────────────────────────
Deno.test("normRoofProfile: case, spaces, underscores and hyphens; junk is null, never AG Panel", () => {
  for (const v of ["agpanel", "AGPanel", "AG Panel", " ag panel ", "ag_panel", "ag-panel", "A G\tPanel"]) eq(JSON.stringify(v), normRoofProfile(v), "agpanel");
  for (const v of ["standingseam", "Standing Seam", "STANDING-SEAM", "standing_seam", "  standing  seam "]) eq(JSON.stringify(v), normRoofProfile(v), "standingseam");
  for (const v of [undefined, null, "", "   ", "metal", "standing", "seam", "agpanelx", "panel", "ag", 0, 1, true, false, {}, [], NaN]) {
    eq(`junk ${JSON.stringify(v)}`, normRoofProfile(v), null);
  }
});

// ── effectiveRoofProfile ───────────────────────────────────────────────────────────────────────
Deno.test("effectiveRoofProfile: the design's pick, then the style's starting value, then AG Panel", () => {
  const SS = { roofProfile: "standingseam", roofMaterial: "metal" };
  const AG = { roofProfile: "agpanel" };
  // The pick wins, in both directions.
  eq("pick SS over an AG style", effectiveRoofProfile("standingseam", AG), "standingseam");
  eq("pick AG over an SS style", effectiveRoofProfile("agpanel", SS), "agpanel");
  eq("pick spelled loosely", effectiveRoofProfile("Standing Seam", {}), "standingseam");
  // No pick: the style's value.
  for (const pick of [undefined, null, "", "  "]) {
    eq(`no pick (${JSON.stringify(pick)}), SS style`, effectiveRoofProfile(pick, SS), "standingseam");
    eq(`no pick (${JSON.stringify(pick)}), AG style`, effectiveRoofProfile(pick, AG), "agpanel");
  }
  // A JUNK pick falls through to the style; it is never AG Panel by itself.
  eq("junk pick, SS style", effectiveRoofProfile("shiny", SS), "standingseam");
  eq("junk pick, no style", effectiveRoofProfile("shiny", null), "agpanel");
  // Neither says: AG Panel, the default everywhere. A style that is not an object says nothing.
  for (const d3 of [null, undefined, {}, { roofProfile: null }, { roofProfile: "nope" }, "standingseam", 7, []]) {
    eq(`nothing said (${JSON.stringify(d3)})`, effectiveRoofProfile(undefined, d3), "agpanel");
  }
});

// ── agreedRoofProfile: a signed design is held to the words it was signed with ─────────────────
// Review 2026-10-07. The style's value is a STARTING value: a builder who later sets a style to
// Standing Seam for future quotes must not reword the Roof line of orders already signed on it as
// "Metal — Black". For a signed design with no pick of its own, the agreed Roof line decides.
const roofSnap = (desc: string | null) => ({
  version: 1, discount: 0, lines: [
    { kind: "building", itemKey: "", name: "Deluxe (10x12)", desc: "", qty: 1, amount: 9000 },
    ...(desc == null ? [] : [{ kind: "roof", itemKey: "", name: "Roof", desc, qty: 1, amount: 300 }]),
  ],
});
Deno.test("agreedRoofProfile: the profile the signed Roof line names; null when it names none", () => {
  eq("agreed AG Panel", agreedRoofProfile(roofSnap("Metal — Black")), "agpanel");
  eq("agreed standing seam", agreedRoofProfile(roofSnap("Metal (Standing Seam) — Black")), "standingseam");
  eq("no colour yet", agreedRoofProfile(roofSnap("Metal (Standing Seam) — (color TBD)")), "standingseam");
  eq("a bare array of lines", agreedRoofProfile(roofSnap("Metal — Black").lines), "agpanel");
  eq("the type as the designer printed it", agreedRoofProfile(roofSnap("metal — Black")), "agpanel");
  // Nothing to go on: no snapshot, no Roof line, no roof, a roof that was not metal, a junk line.
  for (const v of [null, undefined, {}, [], "Metal — Black", 7, roofSnap(null), roofSnap("No roof selected"),
    roofSnap("Shingle — Weathered Wood"), roofSnap("Shingle (Standing Seam) — X"), roofSnap(""), roofSnap("Metal Black"),
    { lines: [{ kind: "roof", desc: null }] }, { lines: [null, 3, "roof"] }]) {
    eq(`nothing agreed (${JSON.stringify(v)})`, agreedRoofProfile(v), null);
  }
});

Deno.test("effectiveRoofProfile: a signed design's agreed line beats the live style; its own pick beats both", () => {
  const SS = { roofProfile: "standingseam" };
  const signedAG = roofSnap("Metal — Black");
  const signedSS = roofSnap("Metal (Standing Seam) — Black");
  // THE DEFECT: signed as AG Panel, then the style was set to Standing Seam for future quotes.
  eq("signed AG, style flipped to SS", effectiveRoofProfile("", SS, signedAG), "agpanel");
  eq("signed SS, style back to AG Panel", effectiveRoofProfile(undefined, {}, signedSS), "standingseam");
  // The design's own pick is a real change and still wins.
  eq("signed AG, rep picks SS", effectiveRoofProfile("standingseam", {}, signedAG), "standingseam");
  eq("signed SS, rep picks AG", effectiveRoofProfile("agpanel", SS, signedSS), "agpanel");
  // An agreement that says nothing about the metal falls through to the style, as an unsigned one does.
  eq("signed shingle, now metal", effectiveRoofProfile("", SS, roofSnap("Shingle — Weathered Wood")), "standingseam");
  eq("signed with no roof line", effectiveRoofProfile("", SS, roofSnap(null)), "standingseam");
  // Left out (an unsigned design), the rule is exactly the two-argument one.
  for (const pick of [undefined, "", "agpanel", "standingseam", "shiny"]) {
    for (const d3 of [null, {}, SS, { roofProfile: "agpanel" }]) {
      eq(`unsigned ${JSON.stringify([pick, d3])}`, effectiveRoofProfile(pick, d3, null), effectiveRoofProfile(pick, d3));
    }
  }
  // End to end: the order keeps the words it was signed with.
  eq("words", roofLineDesc("Metal", "Black", effectiveRoofProfile("", SS, signedAG)), "Metal — Black");
});

// ── roofLineDesc / roofTypeLabel ───────────────────────────────────────────────────────────────
Deno.test("roofLineDesc: today's words, byte for byte, for every roof but a metal one on standing seam", () => {
  const cases: Array<[unknown, unknown]> = [
    ["", ""], ["", "Black"], [null, null], [undefined, "Black"], ["  ", "Black"],
    ["Metal", "Black"], ["Metal", ""], ["Metal", null], [" Metal ", " Black "], ["Metal", "TBD"],
    ["Shingle", "Weathered Wood"], ["Shingle", ""], ["metal", "Black"],
  ];
  for (const [t, c] of cases) {
    for (const profile of [undefined, null, "agpanel", "AG Panel", "", "nonsense"]) {
      eq(`${JSON.stringify([t, c, profile])}`, roofLineDesc(t, c, profile), legacyDesc(t, c));
    }
  }
  // The exact strings, written out once so a reader sees them.
  eq("no roof", roofLineDesc("", "Black", "standingseam"), "No roof selected");
  eq("metal and colour", roofLineDesc("Metal", "Black", "agpanel"), "Metal — Black");
  eq("metal, no colour", roofLineDesc("Metal", "", "agpanel"), "Metal — (color TBD)");
  eq("shingle", roofLineDesc("Shingle", "X", "agpanel"), "Shingle — X");
});

Deno.test("roofLineDesc: \"(Standing Seam)\" only for a metal roof on standing seam", () => {
  eq("metal + SS", roofLineDesc("Metal", "Black", "standingseam"), "Metal (Standing Seam) — Black");
  eq("metal + SS, no colour", roofLineDesc("Metal", "", "standingseam"), "Metal (Standing Seam) — (color TBD)");
  eq("metal + SS, colour TBD", roofLineDesc("Metal", "TBD", "standingseam"), "Metal (Standing Seam) — TBD");
  eq("trimmed first", roofLineDesc(" Metal ", " Black ", "standingseam"), "Metal (Standing Seam) — Black");
  // The type is matched loosely and printed as given.
  eq("lower-case type", roofLineDesc("metal", "Black", "standingseam"), "metal (Standing Seam) — Black");
  // A shingle roof never takes the profile, whatever it says.
  eq("shingle + SS", roofLineDesc("Shingle", "X", "standingseam"), "Shingle — X");
  eq("shingle + SS, no colour", roofLineDesc("Shingle", "", "standingseam"), "Shingle — (color TBD)");
  // The profile must already be an id: roofLineDesc is handed effectiveRoofProfile's answer.
  eq("an unnormalised spelling is not standing seam", roofLineDesc("Metal", "Black", "Standing Seam"), "Metal — Black");
  // The crew card's type, the same rule.
  eq("card: metal + SS", roofTypeLabel("Metal", "standingseam"), "Metal (Standing Seam)");
  eq("card: metal + AG", roofTypeLabel("Metal", "agpanel"), "Metal");
  eq("card: shingle + SS", roofTypeLabel("Shingle", "standingseam"), "Shingle");
});

Deno.test("end to end: the words a design gets from its pick and its style", () => {
  const line = (pick: unknown, d3: unknown, type = "Metal") => roofLineDesc(type, "Black", effectiveRoofProfile(pick, d3));
  eq("no pick, no style profile (every design today)", line(undefined, { roofMaterial: "metal" }), "Metal — Black");
  eq("AG pick on an SS style", line("agpanel", { roofProfile: "standingseam" }), "Metal — Black");
  eq("SS pick on a plain style", line("standingseam", {}), "Metal (Standing Seam) — Black");
  eq("no pick on an SS style", line("", { roofProfile: "standingseam" }), "Metal (Standing Seam) — Black");
  eq("SS pick, shingle roof", line("standingseam", {}, "Shingle"), "Shingle — Black");
});

// ── computeRoofLine (the order screen's attribute change orders) ───────────────────────────────
const CTX = { buildingPrice: 9000, buildingArea: 120, buildingPerimeter: 44, styleLabel: "Deluxe" };
const PALETTE = [
  { id: "m1", label: "Black", rate: 2.5, pricing_method: "sqft_building", allow_custom: false, metal: true, shingle: false },
  { id: "m2", label: "Custom metal", rate: 300, pricing_method: "each", allow_custom: true, metal: true, shingle: false },
  { id: "s1", label: "Weathered Wood", rate: 150, pricing_method: "each", allow_custom: false, metal: false, shingle: true },
];

Deno.test("computeRoofLine: four arguments are exactly what they were; the profile moves the words only", () => {
  const cases: Array<[string, string]> = [["Metal", "Black"], ["Metal", "Nope"], ["Metal", ""], ["Metal", "TBD"], ["Shingle", "Weathered Wood"], ["", ""]];
  for (const [t, c] of cases) {
    const four = computeRoofLine(PALETTE, CTX, t, c);
    const ag = computeRoofLine(PALETTE, CTX, t, c, "agpanel");
    const ss = computeRoofLine(PALETTE, CTX, t, c, "standingseam");
    eq(`${t}/${c}: four-argument words are today's`, four.desc, legacyDesc(t, c));
    eq(`${t}/${c}: agpanel is the four-argument call`, ag, four);
    eq(`${t}/${c}: the amount never moves`, ss.amount, four.amount);
    eq(`${t}/${c}: the words come from roofLineDesc`, ss.desc, roofLineDesc(t, c, "standingseam"));
  }
  // The amounts themselves, so a broken colorAmount cannot hide behind equal-to-itself checks.
  eq("Black by the square foot", computeRoofLine(PALETTE, CTX, "Metal", "Black", "standingseam"), { amount: 300, desc: "Metal (Standing Seam) — Black" });
  eq("an unknown colour at the allow-custom rate", computeRoofLine(PALETTE, CTX, "Metal", "Nope", "standingseam").amount, 300);
  eq("shingle", computeRoofLine(PALETTE, CTX, "Shingle", "Weathered Wood", "standingseam"), { amount: 150, desc: "Shingle — Weathered Wood" });
  eq("no roof", computeRoofLine(PALETTE, CTX, "", "", "standingseam"), { amount: 0, desc: "No roof selected" });
});

// ── The CRM History's version diff names the profile, not its ids ──────────────────────────────
/** A PostgREST stand-in that returns ONLY the selected columns (crmFeedDocuments.test.ts's). */
function projectingAdmin(tables: Record<string, Record<string, unknown>[]>) {
  const builder = (table: string) => {
    let cols: string[] | null = null;
    const b: Record<string, unknown> = {};
    b.select = (s: string) => {
      cols = String(s).replace(/\([^)]*\)/g, "").split(",").map((c) => c.trim()).filter(Boolean);
      return b;
    };
    for (const m of ["eq", "in", "or", "is", "order", "limit"]) b[m] = () => b;
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
      const rows = (tables[table] ?? []).map((r) =>
        cols ? Object.fromEntries(cols.filter((c) => c in r).map((c) => [c, r[c]])) : r
      );
      return Promise.resolve({ data: rows, error: null }).then(res, rej);
    };
    return b;
  };
  return { from: builder, storage: { from: () => ({ createSignedUrls: () => Promise.resolve({ data: [] }) }) } };
}

Deno.test("CRM History: a profile switch reads AG Panel → Standing Seam, and the new empty key is no change", async () => {
  const sel = { style: "deluxe", size: "10x12", roofType: "Metal", roofColor: "Black" };
  const v = (version: number, selections: Record<string, unknown>) =>
    ({ short_code: "SS-DEMO7788", version, created_at: `2026-10-0${version}T15:00:00Z`, selections });
  const admin = projectingAdmin({
    designs: [{ short_code: "SS-DEMO7788", created_at: "2026-10-01T15:00:00Z", status: "sent", selections: sel }],
    design_versions: [
      v(1, sel),
      // The designer now always names the key, "" when nothing is picked: not a change.
      v(2, { ...sel, roofProfile: "" }),
      v(3, { ...sel, roofProfile: "standingseam" }),
      v(4, { ...sel, roofProfile: "agpanel", cladding: "vinyl" }),
    ],
  });
  const feed = await buildCrmFeed(admin, "demo", { codes: ["SS-DEMO7788"], contactId: null });
  const body = (n: number) => feed.find((e) => e.id === `v:SS-DEMO7788:${n}`)?.body ?? null;
  eq("v2: a design that gained the empty key changed nothing", body(2), null);
  eq("v3: the pick, in words", body(3), "roofProfile: — → Standing Seam");
  eq("v4: back to AG Panel, beside the vinyl's own name", body(4), "roofProfile: Standing Seam → AG Panel; cladding: — → 4.5\" Vinyl Siding");
});

Deno.test("roofProfile.test: no failures recorded", () => {
  if (failures) throw new Error(`${failures} failed`);
});
