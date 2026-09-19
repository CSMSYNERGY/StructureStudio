// The eave, MEASURED: notched against extended, at a 4 in and a 12 in overhang.
//
// Carolyn paused two walk-around videos on 2026-09-18 and drew the eave she builds. The claim
// this script exists to check is a geometric one and it is easy to believe without evidence:
// that the roof's TOP PLANE is untouched by the framing choice, and that ONLY what hangs under
// it moves. So it reads the real scene graph out of the real renderer (the COMPILED artifact the
// browser loads) and prints, for each variant: the slab's top face at the eave and at the ridge,
// the lowest point of the eave finish, and what that is relative to the wall plate.
//
//   python -m http.server 8125 --bind 127.0.0.1 --directory <repo root>
//   node tests/harness/overhangNotch.mjs
//
// Exit 0 = every assertion held.
import { launch, stubSupabase, collectErrors, openDesigner, reporter, shotsDir } from "./lib.mjs";
import { pickStyle, openEditor, sceneMeshes, shot } from "./gableProbe.mjs";

const W = 12, L = 16, SIZE = `${W}x${L}`, H = 8;
const TRIM = "#b0a081", BODY = "#4a3327";

const d3 = (overhang, overhangStyle) => ({
  roof: { type: "gable", pitch: 0.4, ridgeOffset: 0, eave: "fascia", overhang, overhangStyle },
  colors: { body: BODY, roof: "#8a8f94", trim: TRIM },
  siding: "panel", foundation: "slab", roofMaterial: "shingle", wallHeightFt: H,
});
const CLADS = ["panel"].map((id) => ({ id, rate: 0, basis: "sqft_option", label: null, charged: false }));
const style = (value, label, spec) => ({ value, label, img: null, sizes: [SIZE], sizeInclusions: {}, sizeInclusionQty: {}, d3: spec });

// Four variants: both framings at a 4 in tail and at a 12 in tail. The 4 in pair is the case
// Carolyn says builders really do just extend; the 12 in pair is where the two diverge visibly.
const VARIANTS = [
  { tag: "ext-4in", label: "Extended 4in", ov: 4 / 12, st: "extended" },
  { tag: "notch-4in", label: "Notched 4in", ov: 4 / 12, st: "notched" },
  { tag: "ext-12in", label: "Extended 12in", ov: 1.0, st: "extended" },
  { tag: "notch-12in", label: "Notched 12in", ov: 1.0, st: "notched" },
];

export const CONFIG = {
  clientId: "harness-overhang",
  branding: { companyName: "Harness Sheds", accentColor: "#1D4ED8", headerBg: "#FFFFFF", tagline: null, logo: null },
  contactFields: ["name", "email", "phone"],
  buildingStyles: VARIANTS.map((v) => style(v.tag, v.label, d3(v.ov, v.st))),
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
// box rotated about z, the fascia is the thin tall trim board at the outermost |x|, and a soffit
// (notched only) is the thin FLAT trim board out there with it.
function eaveParts(meshes) {
  const roof = meshes.filter((m) => m.group === "roof" && m.geom === "BoxGeometry");
  const far = Math.max(...roof.map((m) => m.max[0]));
  // Everything living out at the right-hand eave, within a foot of the outermost face.
  const atEave = roof.filter((m) => m.max[0] > far - 1.0);
  // ⚠️ The RAKE boards are trim too, and they run the WHOLE slope, so their bbox reaches the
  // eave as surely as the fascia does. Everything below is bounded in x for that reason.
  const trim = atEave.filter((m) => m.color === TRIM);
  // The fascia is the tall, narrow trim board standing at the roof edge.
  const tall = trim.filter((m) => m.max[1] - m.min[1] >= m.max[0] - m.min[0] && m.max[0] - m.min[0] < 0.5);
  // A soffit is a THIN, level board no longer than the overhang -- never a rake, which is 0.32 deep.
  const flat = trim.filter((m) => m.max[1] - m.min[1] < 0.12 && m.max[0] - m.min[0] < 2.5 && m.min[1] < 9);
  // The roof deck: the big non-trim box whose x extent reaches the eave.
  const slab = atEave.filter((m) => m.color !== TRIM).sort((a, b) => (b.max[2] - b.min[2]) - (a.max[2] - a.min[2]))[0] || null;
  return {
    far,
    slab,
    fascia: tall.sort((a, b) => b.max[0] - a.max[0])[0] || null,
    soffit: flat.sort((a, b) => (b.max[0] - b.min[0]) - (a.max[0] - a.min[0]))[0] || null,
    trimCount: trim.length,
  };
}

// gableProbe's chooseSize is pinned to its own 12x32 label, so this harness carries its own.
async function chooseSize(page) {
  const sel = page.locator("select").filter({ has: page.locator("option", { hasText: SIZE }) });
  await sel.first().selectOption({ label: SIZE });
  await page.waitForTimeout(500);
}

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
    // The deck's top face, at the outermost eave and back at the ridge: two points that pin the
    // plane. The slab is ONE rotated box, so its world bbox gives both corners directly.
    const out = {
      tag: v.tag, ov: v.ov, st: v.st,
      deckOutX: p.slab ? p.slab.max[0] : null,
      deckTopAtEave: p.slab ? p.slab.min[1] : null,   // low corner of the rotated slab = the eave end
      deckTopAtRidge: p.slab ? p.slab.max[1] : null,
      fascia: p.fascia ? { x: p.fascia.max[0], top: p.fascia.max[1], bottom: p.fascia.min[1], h: p.fascia.max[1] - p.fascia.min[1] } : null,
      soffit: p.soffit ? { fromX: p.soffit.min[0], toX: p.soffit.max[0], y: p.soffit.max[1] } : null,
      trimCount: p.trimCount,
    };
    console.log(`\n[${v.tag}] overhang ${(v.ov * 12).toFixed(0)} in, ${v.st}`);
    console.log(`  deck outer face x      ${out.deckOutX.toFixed(4)}   (wall plate at x = ${(W / 2).toFixed(2)})`);
    console.log(`  deck bbox y            ${out.deckTopAtEave.toFixed(4)} .. ${out.deckTopAtRidge.toFixed(4)}`);
    console.log(`  fascia                 x ${out.fascia.x.toFixed(4)}  y ${out.fascia.bottom.toFixed(4)}..${out.fascia.top.toFixed(4)}  (${out.fascia.h.toFixed(4)} tall)`);
    console.log(`  fascia bottom vs plate ${(out.fascia.bottom - H >= 0 ? "+" : "")}${(out.fascia.bottom - H).toFixed(4)} ft`);
    console.log(`  soffit                 ${out.soffit ? `x ${out.soffit.fromX.toFixed(4)}..${out.soffit.toX.toFixed(4)} at y ${out.soffit.y.toFixed(4)}` : "(none)"}`);
    await shot(page, `${shots}/${v.tag}.png`, { eye: [W / 2 + 9, H + 0.6, 4], at: [W / 2 - 0.5, H - 0.2, 0] });
    ok(`[${v.tag}] the eave has a fascia`, !!out.fascia);
    ok(`[${v.tag}] a soffit closes the underside iff the tail is notched`, !!out.soffit === (v.st === "notched"),
      out.soffit ? "soffit present" : "no soffit");
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

  // THE CLAIM: the framing choice does not touch the deck. Same overhang, both framings — the
  // slab's outer face and its whole y extent must be identical to the float.
  for (const ov of ["4in", "12in"]) {
    const e = got[`ext-${ov}`], n = got[`notch-${ov}`];
    ok(`${ov}: the deck projects exactly as far either way`, Math.abs(e.deckOutX - n.deckOutX) < 1e-6,
      `ext ${e.deckOutX.toFixed(6)} notched ${n.deckOutX.toFixed(6)}`);
    ok(`${ov}: the deck's top plane is untouched by the framing`,
      Math.abs(e.deckTopAtEave - n.deckTopAtEave) < 1e-6 && Math.abs(e.deckTopAtRidge - n.deckTopAtRidge) < 1e-6,
      `ext ${e.deckTopAtEave.toFixed(6)}..${e.deckTopAtRidge.toFixed(6)} notched ${n.deckTopAtEave.toFixed(6)}..${n.deckTopAtRidge.toFixed(6)}`);
    ok(`${ov}: a notched tail hangs LESS below the deck than an extended one`,
      n.fascia.bottom > e.fascia.bottom + 0.05,
      `ext bottom ${e.fascia.bottom.toFixed(4)} notched ${n.fascia.bottom.toFixed(4)} (plate ${H})`);
  }
  // ⚠️ MEASURED, AND IT CORRECTS THE OBVIOUS GUESS. The first draft of this script asserted that
  // an extended eave drops FURTHER as the overhang grows than a notched one does. It does not, and
  // it cannot: both eaves ride the SAME deck plane, so the height the eave finish loses between a
  // 4 in and a 12 in tail is the slope, and the slope is shared. What the notch removes is a
  // CONSTANT — the rafter depth cut off the underside — so the two run parallel, offset by that one
  // number at every overhang. Pinned as an equality, because drift in either direction would mean
  // the framing had started moving the deck.
  const dExt = got["ext-4in"].fascia.bottom - got["ext-12in"].fascia.bottom;
  const dNot = got["notch-4in"].fascia.bottom - got["notch-12in"].fascia.bottom;
  const gap4 = got["notch-4in"].fascia.bottom - got["ext-4in"].fascia.bottom;
  const gap12 = got["notch-12in"].fascia.bottom - got["ext-12in"].fascia.bottom;
  console.log(`\nhow much lower the eave finish sits when the overhang goes 4in -> 12in:`);
  console.log(`  extended ${dExt.toFixed(4)} ft   notched ${dNot.toFixed(4)} ft   (the shared deck slope)`);
  console.log(`how much the notch lifts the eave finish:`);
  console.log(`  at 4in +${gap4.toFixed(4)} ft   at 12in +${gap12.toFixed(4)} ft   (constant: the rafter cut away)`);
  ok("both framings lose the SAME height to the slope — the deck is shared", Math.abs(dExt - dNot) < 1e-6,
    `extended ${dExt.toFixed(4)} vs notched ${dNot.toFixed(4)}`);
  ok("the notch lifts the eave finish by a constant, whatever the overhang", Math.abs(gap4 - gap12) < 1e-6 && gap4 > 0.1,
    `4in +${gap4.toFixed(4)} ft, 12in +${gap12.toFixed(4)} ft`);

  console.log(`\nshots in ${shots}`);
  if (failed().length) { console.error(`\n${failed().length} check(s) FAILED`); process.exit(1); }
  console.log("\nall checks held");
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1].endsWith("overhangNotch.mjs")) await main();
