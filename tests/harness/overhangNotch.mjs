// The eave, MEASURED: notched against extended, at a 4 in and a 12 in overhang, on a FASCIA
// eave and on an OPEN one.
//
// WHAT THIS EXISTS TO SETTLE. Carolyn paused two walk-around videos on 2026-09-18 and drew the
// eave she builds: "that two by four they notch it ... so the top here goes straight out", and
// Preferred Structures' version of the same complaint, "your overhang keeps going down, and we
// actually sit it on the top". So there are three claims to check and they are not the same
// claim, which is exactly how the first cut of this script shipped a number that passed while
// the headline was false:
//
//   1. THE DECK DOES NOT MOVE. The framing choice may not touch the roof's top plane — same
//      projection, same y extent, to the float. "The top goes straight out."
//   2. A NOTCHED TAIL IS CUT BACK TO THE DECK. The finished eave must hang nothing below the
//      roof plane but the soffit board that closes it — stated as a RELATION to the deck's own
//      underside, so it holds at any pitch and any overhang rather than being a lucky constant.
//   3. ⚠️ AND THE ONE THAT CANNOT BE MET HERE, printed rather than asserted, because a reader
//      will otherwise assume it was forgotten. The eave still finishes BELOW THE WALL PLATE at
//      a deep overhang, and no eave detail can change that: d3RoofProfile puts the roof plane
//      THROUGH the plate at y = H, so the deck's own outer TOP corner is already below the
//      plate before anything is hung on it — this script prints that corner beside every
//      finish it measures. Lifting the eave back over the plate means giving the rafter its
//      depth above the plate (a birdsmouth seat), which moves the profile, the gable ends, the
//      rakes, the cap and every render that exists. It is a separate change.
//
//   4. AND NOTHING MOVES ON AN OPEN EAVE. Those rafter tails were measured off a real building;
//      "notched" is a fascia-eave distinction and must not reach them. Asserted by measuring
//      both framings on an open eave and requiring every number to be identical.
//
//   python -m http.server 8125 --bind 127.0.0.1 --directory <repo root>
//   node tests/harness/overhangNotch.mjs
//
// Exit 0 = every assertion held.
import { launch, stubSupabase, collectErrors, openDesigner, reporter, shotsDir } from "./lib.mjs";
import { pickStyle, openEditor, sceneMeshes, shot } from "./gableProbe.mjs";

const W = 12, L = 16, SIZE = `${W}x${L}`, H = 8, PITCH = 0.4;
const TRIM = "#b0a081", BODY = "#4a3327";
const TAIL_WOOD = "#8b7355";   // D3_COLORS.bench — the raw 2x stock an open eave's tails are cut from

// The slope, in the renderer's own terms: ny is the normal's vertical component (cos of the
// pitch angle), SIN is how much height a foot measured ALONG the slope gives up.
const NY = Math.cos(Math.atan(PITCH));
const SIN = Math.sin(Math.atan(PITCH));
const ROOF_T = 0.2, DECK_N = 0.02, SOFFIT_T = 0.05;

// st "absent" leaves the KEY OFF the roof object entirely, which is what every style shipped
// before 2026-09-18 actually has in its column. Writing `overhangStyle: undefined` would not do:
// this object is the shape the calibration panel posts back, and an undefined-valued key is still
// a key to the deep-equal that decides whether a save writes anything.
const d3 = (overhang, overhangStyle, eave) => ({
  roof: Object.assign(
    { type: "gable", pitch: PITCH, ridgeOffset: 0, eave, overhang, tailSpacingIn: 24 },
    overhangStyle === "absent" ? {} : { overhangStyle }),
  colors: { body: BODY, roof: "#8a8f94", trim: TRIM },
  siding: "panel", foundation: "slab", roofMaterial: "shingle", wallHeightFt: H,
});
const CLADS = ["panel"].map((id) => ({ id, rate: 0, basis: "sqft_option", label: null, charged: false }));
const style = (value, label, spec) => ({ value, label, img: null, sizes: [SIZE], sizeInclusions: {}, sizeInclusionQty: {}, d3: spec });

// Ten variants: both framings, at a 4 in tail and a 12 in tail, on both eave finishes, plus a
// STORED-NOTHING case on each open eave. The 4 in pair is what Carolyn says builders really do
// just extend; the 12 in pair is where the two diverge visibly; the OPEN rows are the regression
// guard — they must not diverge at all.
//
// The open "absent" row exists for the calibration panel (2026-09-19). That select used to render
// live on an open-eave style: it took a pick and persisted overhangStyle into the tenant's column
// while nothing in the 3D or the elevation moved. The select is disabled there now, and this row
// is what makes that the right fix rather than a cover-up — SET has to measure identical to
// ABSENT, or a value the panel already wrote is quietly changing a building and turning the
// control off would be hiding it.
const VARIANTS = [];
for (const eave of ["fascia", "open"]) {
  for (const [ovTag, ov] of [["4in", 4 / 12], ["12in", 1.0]]) {
    for (const st of eave === "open" ? ["extended", "notched", "absent"] : ["extended", "notched"]) {
      VARIANTS.push({ tag: `${eave}-${st}-${ovTag}`, label: `${eave} ${st} ${ovTag}`, ov, ovTag, st, eave });
    }
  }
}

export const CONFIG = {
  clientId: "harness-overhang",
  branding: { companyName: "Harness Sheds", accentColor: "#1D4ED8", headerBg: "#FFFFFF", tagline: null, logo: null },
  contactFields: ["name", "email", "phone"],
  buildingStyles: VARIANTS.map((v) => style(v.tag, v.label, d3(v.ov, v.st, v.eave))),
  defaultSizes: [SIZE],
  sizePricing: Object.fromEntries(VARIANTS.map((v) => [v.tag, { [SIZE]: { widthFt: W, lengthFt: L, basePrice: 9000 } }])),
  options: [], colors: [], claddingOptions: Object.fromEntries(VARIANTS.map((v) => [v.tag, CLADS])), wallHeightOptions: {},
  showPricing: true, view3d: true, layoutItems: {}, layoutPricing: {}, layoutPrices: {},
  electrical: null, electricalItems: [], insulation: [],
};
export const FIXTURES = {
  ramp: { mode: "simple", price: 0, method: "each", enabled: false, imageUrl: null, showImage: false },
  items: [], windowColors: [],
};

// The roof MESHES that matter, picked by shape rather than by name — nothing in the scene graph
// is labelled. On a 12x16 gable the ridge runs along z (the 16 ft axis), so a roof slab is a long
// box rotated about z, the fascia is the thin tall trim board at the outermost |x|, a soffit
// (notched only) is the thin FLAT trim board out there with it, and an open eave's rafter tails
// are the raw-wood boxes.
function eaveParts(meshes) {
  const roof = meshes.filter((m) => m.group === "roof" && m.geom === "BoxGeometry");
  const far = Math.max(...roof.map((m) => m.max[0]));
  // Everything living out at the right-hand eave, within a foot of the outermost face.
  const atEave = roof.filter((m) => m.max[0] > far - 1.0);
  // ⚠️ The RAKE boards are trim too, and they run the WHOLE slope, so their bbox reaches the
  // eave as surely as the fascia does. Everything below is bounded in x for that reason.
  const trim = atEave.filter((m) => m.color === TRIM);
  // The fascia is the tall, narrow trim board standing at the roof edge. ⚠️ BOUNDED ABOVE too:
  // on an open eave there IS no fascia, and without a ceiling this filter reported the gable
  // corner trim -- 0.14 wide and a full 8 ft tall, so "taller than it is wide" is true of it --
  // as one, which reads as the 3D building a fascia it does not build. A fascia is at most a
  // rafter deep.
  const tall = trim.filter((m) => m.max[1] - m.min[1] >= m.max[0] - m.min[0]
    && m.max[1] - m.min[1] < 1.0 && m.max[0] - m.min[0] < 0.5);
  // A soffit is a THIN, level board no longer than the overhang -- never a rake, which is 0.32 deep.
  const flat = trim.filter((m) => m.max[1] - m.min[1] < 0.12 && m.max[0] - m.min[0] < 2.5 && m.min[1] < 9);
  // The roof deck: the big non-trim box whose x extent reaches the eave (the ridge cap is the
  // same length but lives at the ridge, so `atEave` has already dropped it).
  const slab = atEave.filter((m) => m.color !== TRIM && m.color !== TAIL_WOOD)
    .sort((a, b) => (b.max[2] - b.min[2]) - (a.max[2] - a.min[2]))[0] || null;
  const tails = atEave.filter((m) => m.color === TAIL_WOOD);
  return {
    far,
    slab,
    fascia: tall.sort((a, b) => b.max[0] - a.max[0])[0] || null,
    soffit: flat.sort((a, b) => (b.max[0] - b.min[0]) - (a.max[0] - a.min[0]))[0] || null,
    tails,
    trimCount: trim.length,
  };
}

// gableProbe's chooseSize is pinned to its own 12x32 label, so this harness carries its own.
async function chooseSize(page) {
  const sel = page.locator("select").filter({ has: page.locator("option", { hasText: SIZE }) });
  await sel.first().selectOption({ label: SIZE });
  await page.waitForTimeout(500);
}

const f4 = (n) => (n === null ? "  (none)" : (n >= 0 ? " " : "") + n.toFixed(4));

async function probe(v, ok, shots) {
  const { browser, ctx } = await launch({ width: 1280, height: 900 });
  const page = await ctx.newPage();
  collectErrors(page);
  await page.addInitScript(() => { window.__SS3D_DEBUG = true; });
  await stubSupabase(page, { config: CONFIG, fixtures: FIXTURES });
  try {
    await openDesigner(page, CONFIG.clientId);
    await page.waitForFunction(() => [...document.querySelectorAll("svg rect")].some((r) => r.getAttribute("stroke") === "#1E293B"), null, { timeout: 30000 });
    await pickStyle(page, v.label);
    await chooseSize(page);   // gableProbe's own is pinned to ITS size label
    await openEditor(page);
    const meshes = await sceneMeshes(page);
    const p = eaveParts(meshes);
    // THE DECK'S OWN OUTER CORNERS. The slab is ONE rotated box that rises away from the eave,
    // so its lowest bbox corner IS the deck's underside at the outer edge, and the top corner
    // out there is one deck thickness further up the normal.
    const deckUnder = p.slab ? p.slab.min[1] : null;
    const deckTopOuter = deckUnder === null ? null : deckUnder + ROOF_T * NY;
    // THE FINISH: the lowest point of whatever the renderer actually built out there. On a
    // fascia eave that is the fascia board; on an open eave it is the rafter tails.
    const finish = v.eave === "open"
      ? (p.tails.length ? Math.min(...p.tails.map((t) => t.min[1])) : null)
      : (p.fascia ? p.fascia.min[1] : null);
    const out = {
      tag: v.tag, ov: v.ov, ovTag: v.ovTag, st: v.st, eave: v.eave,
      deckOutX: p.slab ? p.slab.max[0] : null,
      deckUnder, deckTopOuter,
      deckLowY: p.slab ? p.slab.min[1] : null,
      deckHighY: p.slab ? p.slab.max[1] : null,
      finish,
      fascia: p.fascia ? { x: p.fascia.max[0], top: p.fascia.max[1], bottom: p.fascia.min[1], h: p.fascia.max[1] - p.fascia.min[1] } : null,
      soffit: p.soffit ? { fromX: p.soffit.min[0], toX: p.soffit.max[0], y: p.soffit.max[1] } : null,
      tailCount: p.tails.length,
      trimCount: p.trimCount,
    };
    console.log(`\n[${v.tag}] eave ${v.eave}, overhang ${(v.ov * 12).toFixed(0)} in, ${v.st}`);
    console.log(`  deck outer face x        ${f4(out.deckOutX)}   (wall plate at x = ${(W / 2).toFixed(2)})`);
    console.log(`  deck bbox y              ${f4(out.deckLowY)} .. ${f4(out.deckHighY)}`);
    console.log(`  deck TOP corner vs plate ${f4(out.deckTopOuter - H)} ft   <- nothing hung here can finish above this`);
    console.log(`  eave finish y            ${f4(out.finish)}`);
    console.log(`  EAVE FINISH VS PLATE     ${f4(out.finish - H)} ft`);
    console.log(`  below the deck underside ${f4(out.deckUnder - out.finish)} ft`);
    console.log(`  fascia                   ${out.fascia ? `x ${f4(out.fascia.x)}  y ${f4(out.fascia.bottom)}..${f4(out.fascia.top)}  (${out.fascia.h.toFixed(4)} tall)` : "(none)"}`);
    console.log(`  soffit                   ${out.soffit ? `x ${f4(out.soffit.fromX)}..${f4(out.soffit.toX)} at y ${f4(out.soffit.y)}` : "(none)"}`);
    console.log(`  rafter tails             ${out.tailCount}`);
    await shot(page, `${shots}/${v.tag}.png`, { eye: [W / 2 + 9, H + 0.6, 4], at: [W / 2 - 0.5, H - 0.2, 0] });

    if (v.eave === "open") {
      ok(`[${v.tag}] an open eave builds rafter tails`, out.tailCount > 0, `${out.tailCount} tails`);
      ok(`[${v.tag}] an open eave builds NO fascia`, !out.fascia);
      ok(`[${v.tag}] an open eave builds NO soffit`, !out.soffit);
    } else {
      ok(`[${v.tag}] the eave has a fascia`, !!out.fascia);
      ok(`[${v.tag}] a soffit closes the underside iff the tail is notched`, !!out.soffit === (v.st === "notched"),
        out.soffit ? "soffit present" : "no soffit");
      ok(`[${v.tag}] a fascia eave builds NO rafter tails`, out.tailCount === 0, `${out.tailCount} tails`);
    }
    return out;
  } finally {
    await ctx.close(); await browser.close();
  }
}

export async function main() {
  const { ok, failed } = reporter();
  const shots = shotsDir("overhang-notch");
  const got = {};
  for (const v of VARIANTS) got[v.tag] = await probe(v, ok, shots);

  for (const eave of ["fascia", "open"]) {
    for (const [ovTag, ov] of [["4in", 4 / 12], ["12in", 1.0]]) {
      const e = got[`${eave}-extended-${ovTag}`], n = got[`${eave}-notched-${ovTag}`];

      // ── CLAIM 1: THE FRAMING CHOICE DOES NOT TOUCH THE DECK ──────────────────────────────
      ok(`${eave} ${ovTag}: the deck projects exactly as far either way`, Math.abs(e.deckOutX - n.deckOutX) < 1e-6,
        `ext ${f4(e.deckOutX)} notched ${f4(n.deckOutX)}`);
      ok(`${eave} ${ovTag}: the deck's top plane is untouched by the framing`,
        Math.abs(e.deckLowY - n.deckLowY) < 1e-6 && Math.abs(e.deckHighY - n.deckHighY) < 1e-6,
        `ext ${f4(e.deckLowY)}..${f4(e.deckHighY)} notched ${f4(n.deckLowY)}..${f4(n.deckHighY)}`);

      if (eave === "open") {
        // ── CLAIM 4: AN OPEN EAVE IS NOT A NOTCH'S BUSINESS ────────────────────────────────
        // The regression that shipped once: OV_NOTCHED is DERIVED from overhang > 0.5 ft, so
        // tying the tail dimensions to it re-cut the exposed tails of every shipped open-eave
        // style — the Urban's signature look — with nobody touching a setting. Every measured
        // number here has to be identical, not merely close.
        ok(`open ${ovTag}: naming a framing changes NOTHING about an open eave`,
          Math.abs(e.finish - n.finish) < 1e-6 && e.tailCount === n.tailCount && e.trimCount === n.trimCount,
          `ext finish ${f4(e.finish)} (${e.tailCount} tails) notched ${f4(n.finish)} (${n.tailCount} tails)`);

        // ── AND SET vs ABSENT, which is the claim the disabled select rests on ──────────────
        // Naming a framing on an open eave has to be indistinguishable from naming none. Every
        // number this harness collects, not a chosen subset, and at 1e-12 rather than the 1e-6
        // above: these are meant to be the SAME FLOATS off the same branch, not two numbers that
        // agree to a tolerance. If this ever parts, a stored overhangStyle is live on an open eave
        // after all, and disabling the control would be concealing a real difference.
        const a = got[`open-absent-${ovTag}`];
        for (const [who, g] of [["extended", e], ["notched", n]]) {
          ok(`open ${ovTag}: a stored "${who}" renders identically to nothing stored at all`,
            Math.abs(g.finish - a.finish) < 1e-12 && Math.abs(g.deckOutX - a.deckOutX) < 1e-12
              && Math.abs(g.deckLowY - a.deckLowY) < 1e-12 && Math.abs(g.deckHighY - a.deckHighY) < 1e-12
              && Math.abs(g.deckUnder - a.deckUnder) < 1e-12
              && g.tailCount === a.tailCount && g.trimCount === a.trimCount,
            `${who} finish ${f4(g.finish)} (${g.tailCount} tails, ${g.trimCount} trim) vs absent ${f4(a.finish)} (${a.tailCount} tails, ${a.trimCount} trim)`);
        }

        // …and the tails hang where the building was measured: 3.5 in below the deck underside.
        for (const g of [e, n, a]) {
          // 3.5 in measured ALONG THE SLOPE NORMAL, which is how the renderer drops them
          // (eaveY + ny * (DECK_N - TAIL_DROP)) -- so the VERTICAL gap is ny times that.
          ok(`[${g.tag}] the tails hang the MEASURED 3.5 in below the deck`,
            Math.abs((g.deckUnder - g.finish) - NY * (3.5 / 12)) < 2e-3,
            `${f4(g.deckUnder - g.finish)} ft below the deck underside, expected ${f4(NY * (3.5 / 12))}`);
        }
        continue;
      }

      // ── CLAIM 2: A NOTCHED TAIL IS CUT BACK TO THE DECK ──────────────────────────────────
      // Stated as a RELATION: the finish is the deck's own underside, less one soffit board,
      // whatever the overhang. That is what "the underside is cut back" means, and it is why
      // this is not a constant lifted off the extended case.
      ok(`fascia ${ovTag}: a notched tail finishes ONE SOFFIT BOARD below the deck, nothing more`,
        Math.abs((n.deckUnder - n.finish) - SOFFIT_T) < 2e-3,
        `${f4(n.deckUnder - n.finish)} ft below the deck underside (soffit is ${SOFFIT_T})`);
      ok(`fascia ${ovTag}: an extended tail still carries the full rafter below the deck`,
        (e.deckUnder - e.finish) > 0.15,
        `${f4(e.deckUnder - e.finish)} ft below the deck underside`);
      ok(`fascia ${ovTag}: the soffit is hung ON the deck's underside`,
        !!n.soffit && Math.abs(n.soffit.y - n.deckUnder) < 2e-3,
        n.soffit ? `soffit top ${f4(n.soffit.y)} vs deck underside ${f4(n.deckUnder)}` : "no soffit");
      ok(`fascia ${ovTag}: the soffit reaches the wall`, !!n.soffit && Math.abs(n.soffit.fromX - W / 2) < 2e-3,
        n.soffit ? `soffit starts at x ${f4(n.soffit.fromX)}, wall at ${W / 2}` : "no soffit");

      // ── CLAIM 3: WHAT IS LEFT BELOW THE PLATE IS THE ROOF'S OWN DESCENT, AND NOTHING ELSE ─
      // The notch removes the framing depth from what hangs below the plate. What remains is
      // arithmetic on the roof plane itself: the height the projection gives up to the slope,
      // less the deck's own normal offset, plus the one soffit board. An identity, at both
      // overhangs — so it cannot be satisfied by a number that happens to land right.
      const predicted = ov * SIN - NY * DECK_N + SOFFIT_T;
      ok(`fascia ${ovTag}: below the plate, a notched eave leaves ONLY the roof plane's own drop`,
        Math.abs((H - n.finish) - predicted) < 3e-3,
        `measured ${f4(H - n.finish)} ft, roof-plane arithmetic ${f4(predicted)} ft`);
      // And the honest limit, asserted rather than left implied: NOTHING hung at this eave can
      // finish above the deck's own outer top corner, which is already below the plate at 12 in.
      ok(`fascia ${ovTag}: the finish is at or below the deck's own outer top corner`,
        n.finish <= n.deckTopOuter + 1e-6 && e.finish <= e.deckTopOuter + 1e-6,
        `notched ${f4(n.finish)} / extended ${f4(e.finish)} vs deck top ${f4(n.deckTopOuter)}`);
    }
  }

  // ── THE TABLE THE WRITE-UP QUOTES ──────────────────────────────────────────────────────
  console.log(`\n  eave     framing    overhang   eave finish vs plate   deck TOP corner vs plate`);
  for (const v of VARIANTS) {
    const g = got[v.tag];
    console.log(`  ${v.eave.padEnd(8)} ${v.st.padEnd(10)} ${v.ovTag.padEnd(10)} ${f4(g.finish - H)} ft            ${f4(g.deckTopOuter - H)} ft`);
  }
  console.log(`\n⚠️ Every row finishes BELOW the plate, and the right-hand column is why: the deck's own`);
  console.log(`   outer corner is already under it. The notch removes the FRAMING depth from what hangs`);
  console.log(`   below — it cannot lift the roof plane, which is where the remaining drop comes from.`);

  console.log(`\nshots in ${shots}`);
  if (failed().length) { console.error(`\n${failed().length} check(s) FAILED`); process.exit(1); }
  console.log("\nall checks held");
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1].endsWith("overhangNotch.mjs")) await main();
