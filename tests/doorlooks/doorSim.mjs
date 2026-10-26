// doorSim.mjs — the offline sim for door looks from a photo (plan of 2026-10-24, section 9; P7).
//
// Puts runs over the corpus in front of doorScore.mjs and writes what it found next to the corpus:
// runs.jsonl, score.json, report.txt and sheet.html (a contact sheet: the photo, the truth, each run's
// answer and what it got wrong, and the studio renders once a run carries them).
//
//   node tests/doorlooks/doorSim.mjs --corpus <dir> [--mode truth|replay|recorded|live] [options]
//
//   --mode truth     (default, free) every truth spec run 3 times as if the generator had answered it
//                    exactly. Proves the truth files clean and the scorer agrees with them, and shows
//                    which bars v1's vocabulary cannot reach on this corpus whatever the AI does.
//   --mode replay    (free) score recorded runs: --runs <runs.jsonl | dir>.
//   --mode recorded  (free) the real SERVER maths (doorGenerate.ts doorDraftFromReads: doorLook.ts's
//                    Stage A consensus and close-up fallbacks, the agreement check, the vocabulary gaps)
//                    over recorded model answers in <corpus>/reads/<id>.json, so a maths change is
//                    re-scored without paying for new reads. It cannot catch prompt drift: every prompt
//                    change gets a live rerun. scripts/doorLookLocal.mjs settle --record writes this file.
//   --mode live      the real pipeline (P4's runDoorDraft: the same prompt, maths, close-ups, Stage B,
//                    ceiling and lean retry as generate_door_look, run here against the API with
//                    ANTHROPIC_API_KEY; no database and no money ladder). COSTS API MONEY. Refuses unless
//                    --batch <name> matches DOOR_SIM_LIVE_BATCH (Ahsan's yes for that one batch) and
//                    --max-dollars covers the batch at the $3.00 ceiling per press. Each photo is
//                    straightened to its truth file's photo.quad when it has one (TL, TR, BR, BL), else
//                    sent as it is, and fitted to the photo limits in headless Chrome. A press's ledger
//                    rows become its run record through runFromDoorLedgerRows, the same mapping a live
//                    press in the app gets.
//   --runs-per <n>   presses per photo (default 3)    --set tune|holdout|refuse   --source video|catalog
//   --case a,b       only these photos                --out <dir> (default <corpus>/runs/<stamp>-<mode>)
//
// THE CORPUS AND EVERY OUTPUT STAY OUT OF THIS REPO, which is public: builders' catalog photos and their
// names never come in here. Both paths are refused when they resolve inside the repo.
//
// <corpus>/reads/<id>.json, for --mode recorded:
//   { "photo": [w, h],                      the straightened photo's size in pixels
//     "runs": [ { "reads": [<Stage A answer>, ...],   the model's own JSON, as doorLook.ts reads it
//                 "closeUps"?: {hinges?, handle?, meet?},   {status:"ok", votes:[...]} | {status:"skipped"}
//                 "stageB"?: <Stage B answer>,
//                 "ms"?, "costCents"?, "skipped"?, "vocabGaps"? } ] }

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkTruthCase, formatReport, loadRuns, loadTruth, scoreCorpus, scoreRun } from "./doorScore.mjs";
import { cleanDoorLook, samplePatch } from "../../supabase/functions/_shared/doorLook.ts";
import { DoorCeiling, DOOR_LEAN_MIN_LEFT_MS, DOOR_PRESS_CLOCK_MS, doorDraftFromReads, doorLedgerFields, runDoorDraft } from "../../supabase/functions/_shared/doorGenerate.ts";
import { playwrightImageOps, preparedSize } from "../../scripts/doorLookLocal.mjs";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PRESS_CEILING_DOLLARS = 3;

// True when `p` is the repo or anything under it (case-insensitive: Windows paths).
export function insideRepo(p, root = REPO_ROOT) {
  const a = resolve(p).toLowerCase(), r = resolve(root).toLowerCase();
  return a === r || a.startsWith(r.endsWith(sep) ? r : r + sep);
}

// ─── THE MODES ────────────────────────────────────────────────────────────────────────────────────
// The truth answered exactly. A photo whose hinges do not show is answered the way the pipeline must
// answer it, with the side guessed opposite the handle and its warning; the truth's own vocabulary
// gaps are filed, as the pipeline must file them.
export function truthRuns(cases, perPhoto = 3) {
  return cases.flatMap((t) => Array.from({ length: perPhoto }, (_, k) => {
    const run = { case: t.id, run: k + 1, mode: "truth" };
    if (t.expect === "refuse") return { ...run, outcome: "refused", refuse: t.refuse };
    const guessed = t.hingesVisible === false;
    return {
      ...run,
      outcome: "draft",
      spec: t.spec,
      warnings: guessed ? [{ code: "hinge_side_handle" }] : [],
      sideFrom: guessed ? "handle" : "hinges",
      vocabGaps: t.vocabGaps ?? [],
    };
  }));
}

// Recorded Stage A answers through the server's own maths. A case with no size cannot be measured:
// the reads are pixel points, and the size is what turns them into inches.
export function recordedRuns(cases, corpusDir) {
  const out = [], skipped = [];
  for (const t of cases) {
    const file = join(corpusDir, "reads", `${t.id}.json`);
    if (!existsSync(file)) continue;
    if (!Array.isArray(t.sizeIn)) {
      skipped.push(`${t.id}: needs size`);
      continue;
    }
    const rec = JSON.parse(readFileSync(file, "utf8"));
    const ctx = { widthIn: t.sizeIn[0], heightIn: t.sizeIn[1], leaves: t.leaves, photo: rec.photo };
    (rec.runs ?? []).forEach((r, k) => {
      const d = doorDraftFromReads(r.reads ?? [], ctx, { closeUps: r.closeUps, stageB: r.stageB });
      // The gaps the maths finds, and any the record carries.
      const vocabGaps = [...new Set([...(d.vocabGaps ?? []), ...(r.vocabGaps ?? [])])];
      const base = { case: t.id, run: k + 1, mode: "recorded", ms: r.ms, costCents: r.costCents, skipped: r.skipped, vocabGaps };
      if (d.outcome === "refused") out.push({ ...base, outcome: "refused", refuse: { code: d.refuse.code, reason: d.refuse.reason } });
      else if (d.outcome === "failed") out.push({ ...base, outcome: "failed", error: d.error, warnings: d.warnings });
      else out.push({ ...base, outcome: "draft", spec: d.spec, warnings: d.warnings, sideFrom: d.sideFrom });
    });
  }
  return { runs: out, skipped };
}

// The gate on paid runs. Throws with the reason; returns nothing when the batch may go ahead.
export function liveGate({ batch, maxDollars, presses, env = process.env }) {
  if (!batch) throw new Error("--mode live needs --batch <name>: every paid batch has a name, and Ahsan says yes to that name.");
  if (env.DOOR_SIM_LIVE_BATCH !== batch) {
    throw new Error(`--mode live refuses: DOOR_SIM_LIVE_BATCH is not "${batch}". Live runs cost API money; set it only after Ahsan's yes for this batch.`);
  }
  const worst = presses * PRESS_CEILING_DOLLARS;
  if (!(Number(maxDollars) >= worst)) {
    throw new Error(`--mode live refuses: ${presses} presses can cost up to $${worst.toFixed(2)} at the $${PRESS_CEILING_DOLLARS.toFixed(2)} ceiling; --max-dollars is ${maxDollars ?? "not set"}.`);
  }
}
// ─── A PRESS'S LEDGER ROWS TO ITS RUN RECORD ──────────────────────────────────────────────────────
// What the scorer reads, from what a press leaves in ai_door_calls (P4's doorLedgerFields): the rows
// of one key, its first try and its lean retry. The last row decides the outcome; the costs and the
// times add up. Self-check rounds (P5) are `self_check_rounds: [{spec, costCents, skipped, ...}]`: the
// last round's spec is the final one and the drafted spec is the pre-check one.
export function runFromDoorLedgerRows(rows, { case: id, run }) {
  const list = [...(Array.isArray(rows) ? rows : [rows])].filter(Boolean)
    .sort((a, b) => (Date.parse(a.created_at ?? "") || 0) - (Date.parse(b.created_at ?? "") || 0));
  if (!list.length) return { case: id, run, outcome: "failed", error: "no_row", warnings: [] };
  const last = list[list.length - 1], t = last.tokens ?? {};
  const rounds = Array.isArray(last.self_check_rounds) ? last.self_check_rounds : [];
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const roundsCost = (r) => (Array.isArray(r.self_check_rounds) ? r.self_check_rounds : []).reduce((a, x) => a + num(x?.costCents), 0);
  const costCents = list.reduce((s, r) => s + num(r.tokens?.costCents) + roundsCost(r), 0);
  const ms = list.reduce((s, r) => s + num(r.draft_ms), 0);
  const skipped = {
    ...(list.some((r) => r.tokens?.skipped?.ceiling) ? { ceiling: true } : {}),
    ...(list.some((r) => r.tokens?.skipped?.leanRetryClock) ? { leanRetryClock: true } : {}),
    ...(rounds.some((r) => r?.skipped === "clock") ? { selfCheckClock: true } : {}),
  };
  const base = {
    case: id, run, ms: ms || undefined, costCents: Math.round(costCents * 100) / 100, warnings: Array.isArray(last.warnings) ? last.warnings : [],
    vocabGaps: Array.isArray(t.vocabGaps) ? t.vocabGaps : [], ...(t.sideFrom ? { sideFrom: t.sideFrom } : {}), skipped, tries: list.length,
  };
  if (last.status === "done" && last.drafted) {
    const checked = [...rounds].reverse().find((r) => r && r.spec)?.spec;
    return { ...base, outcome: "draft", spec: checked ?? last.drafted, ...(checked ? { preCheck: last.drafted } : {}) };
  }
  if (t.refuse) return { ...base, outcome: "refused", refuse: { code: t.refuse.code, reason: t.refuse.reason } };
  return { ...base, outcome: "failed", error: t.failure?.code ?? "unknown" };
}
export const runFromDoorLedgerRow = (row, at) => runFromDoorLedgerRows([row], at);

// One live press, as generate_door_look runs it minus the database and the money: the photo straightened
// and fitted, Stage A, the close-ups cut from it, the agreement check and Stage B, under the $3.00
// ceiling, and the one lean retry when the first try asks for it and the press clock allows. COSTS API
// MONEY: only main's live mode calls it, after liveGate. The options stand in for the API, the browser
// and the clock in its tests.
export async function liveGenerate(t, k, { corpusDir, env = process.env, fetchImpl = globalThis.fetch, makeOps = playwrightImageOps, now = Date.now } = {}) {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("--mode live needs ANTHROPIC_API_KEY. Nothing was called.");
  if (!t.photo?.file) return { case: t.id, run: k, outcome: "failed", error: "no_photo", warnings: [] };
  const leaves = t.leaves === 2 ? 2 : 1;
  // A case with no real size (a refusal photo) is pressed at a typical door's size.
  const [widthIn, heightIn] = Array.isArray(t.sizeIn) ? t.sizeIn : leaves === 2 ? [72, 80] : [36, 80];
  const ops = await makeOps();
  try {
    const file = join(corpusDir, t.photo.file);
    const quad = Array.isArray(t.photo.quad) ? t.photo.quad : null;
    const photo = preparedSize({ src: await ops.size(file), quad, widthIn, heightIn });
    const jpeg = await ops.render({ file, quad, out: photo });
    const prepared = join(corpusDir, "runs", ".live-photo.jpg");
    mkdirSync(dirname(prepared), { recursive: true });
    writeFileSync(prepared, jpeg);
    const px = await ops.pixels(prepared);
    const colorAt = px.w === photo[0] && px.h === photo[1] ? (p) => samplePatch(px.rgba, px.w, px.h, p) : undefined;
    const deps = {
      fetch: (url, init) => fetchImpl(url, init), apiKey,
      cut: (windows, zoom) => ops.crop({ file: prepared, windows, zoom }), ...(colorAt ? { colorAt } : {}),
    };
    const input = { widthIn, heightIn, leaves, photo, front: { base64: Buffer.from(jpeg).toString("base64"), mediaType: "image/jpeg" } };
    const pressStart = now();
    const rows = [];
    const tryOnce = async (lean) => {
      const at = now();
      const r = await runDoorDraft(deps, {
        ...input, lean, ceiling: new DoorCeiling(rows.reduce((s, x) => s + (x.tokens?.ceilingCents ?? 0), 0)),
        deadlineAt: at + Math.max(0, Math.min(300_000, pressStart + DOOR_PRESS_CLOCK_MS - 15_000 - at)),
      });
      rows.push({ ...doorLedgerFields(r), created_at: new Date(at).toISOString() });
      return r;
    };
    const first = await tryOnce(false);
    if (first.outcome === "failed" && first.failure?.retryable) {
      if (pressStart + DOOR_PRESS_CLOCK_MS - now() >= DOOR_LEAN_MIN_LEFT_MS) await tryOnce(true);
      else rows[0].tokens.skipped = { ...rows[0].tokens.skipped, leanRetryClock: true };
    }
    return { ...runFromDoorLedgerRows(rows, { case: t.id, run: k }), mode: "live", ...(quad ? {} : { note: "not straightened (no photo.quad)" }) };
  } finally {
    await ops.close?.();
  }
}

// ─── THE CONTACT SHEET ────────────────────────────────────────────────────────────────────────────
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
// Relative, so the sheet still opens when the corpus folder moves; a file URL across drives.
const fileHref = (from, to) => {
  const rel = relative(from, to);
  return isAbsolute(rel) ? pathToFileURL(to).href : rel.split(sep).map(encodeURIComponent).join("/");
};
function truthLine(t) {
  if (t.expect === "refuse") return `refuse: ${t.refuse.code} (${t.refuse.reason ?? "?"})`;
  const s = t.spec;
  const panels = (s.panels ?? []).map((p) => p?.fill ?? "base").join(" / ");
  return `${s.base}, ${s.src.leaves === 2 ? "double" : "single"}, hinge ${s.src.hinge}, rails ${JSON.stringify(s.frame?.rails ?? "base")}, panels ${panels || "base"}, ` +
    `${(s.parts ?? []).length} parts, hinges ${s.hinges?.count ?? "rule"} ${s.hinges?.type ?? "tstrap"}`;
}
export function contactSheet({ cases, runs, result, corpusDir, outDir }) {
  const byCase = new Map(cases.map((c) => [c.id, []]));
  for (const r of runs) byCase.get(r.case)?.push(r);
  const bars = result.bars.map((b) => `<tr class="${b.ok === null ? "nd" : b.ok ? "ok" : "bad"}"><td>${esc(b.label)}</td><td>${esc(b.value === null ? "-" : Math.round(b.value * 1000) / 1000)}</td><td>${esc(b.ok === null ? "no data" : b.ok ? "pass" : "FAIL")}</td><td>${esc(b.detail)}</td></tr>`).join("");
  const cards = cases.map((t) => {
    const img = t.photo?.file ? `<img src="${esc(fileHref(outDir, join(corpusDir, t.photo.file)))}" alt="">` : "";
    const rs = (byCase.get(t.id) ?? []).map((r) => {
      const s = scoreRun(t, r);
      const wrong = s.rows.filter((x) => x.status === "fail" && x.bar).map((x) => `${x.path}: ${JSON.stringify(x.got)} (truth ${JSON.stringify(x.truth)})${x.warned ? " [warned]" : ""}`);
      const renders = r.renders ? Object.entries(r.renders).map(([k, p]) => `<figure><img src="${esc(fileHref(outDir, resolve(outDir, p)))}" alt=""><figcaption>${esc(k)}</figcaption></figure>`).join("") : "";
      const what = r.outcome === "draft" ? (wrong.length ? `<ul>${wrong.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : "<p>every scored field right</p>")
        : `<p>${esc(r.outcome)} ${esc(r.refuse?.code ?? r.error ?? "")}${s.refusal ? (s.refusal.ok ? " (right)" : " (WRONG)") : ""}</p>`;
      return `<div class="run"><b>run ${esc(r.run)}</b>${s.matched && s.matched !== "spec" ? ` matched ${esc(s.matched)}` : ""}${r.ms ? `, ${esc(Math.round(r.ms / 1000))} s` : ""}${r.costCents != null ? `, ${esc(r.costCents)}c` : ""}${what}${renders || (r.outcome === "draft" ? '<p class="nd">no renders yet (the studio preview hook is P2/P6)</p>' : "")}</div>`;
    }).join("");
    return `<section><h2>${esc(t.id)} <small>${esc(t.set)} / ${esc(t.source)} / ${esc(t.sizeIn ? t.sizeIn.join(" x ") + " in" : "size unknown")}</small></h2><div class="row">${img}<div><p class="truth">${esc(truthLine(t))}</p>${rs}</div></div></section>`;
  }).join("");
  return `<!doctype html><meta charset="utf-8"><title>Door looks sim</title><style>
body{font:14px system-ui,sans-serif;margin:16px;background:#fff;color:#222}table{border-collapse:collapse}td{border:1px solid #ddd;padding:3px 6px}
.ok td:nth-child(3){color:#176b2c}.bad td:nth-child(3){color:#b00020;font-weight:600}.nd{color:#888}
section{border-top:1px solid #ccc;margin-top:16px}.row{display:flex;gap:16px;align-items:flex-start}.row>img{max-width:260px;max-height:360px}
.run{margin:6px 0;padding:6px;background:#f6f6f6}figure{display:inline-block;margin:4px}figure img{max-width:200px}.truth{font-family:monospace}
</style><h1>Door looks sim: ${esc(result.ok ? "PASS" : "not passing")}</h1><table>${bars}</table>${cards}`;
}

// ─── RUN ──────────────────────────────────────────────────────────────────────────────────────────
function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

export async function main(argv, env = process.env) {
  const corpus = arg(argv, "--corpus");
  const mode = arg(argv, "--mode") ?? "truth";
  if (!corpus) throw new Error("usage: node tests/doorlooks/doorSim.mjs --corpus <dir> [--mode truth|replay|recorded|live] (see the header)");
  if (insideRepo(corpus)) throw new Error("the corpus must live outside the repo (the repo is public)");
  const out = resolve(arg(argv, "--out") ?? join(corpus, "runs", `${stamp()}-${mode}`));
  if (insideRepo(out)) throw new Error("--out must be outside the repo (the repo is public)");

  const truth = loadTruth(corpus);
  const problems = truth.flatMap(checkTruthCase);
  if (problems.length) throw new Error(`truth files need fixing:\n${problems.join("\n")}`);
  const only = arg(argv, "--case")?.split(",");
  const filter = { set: arg(argv, "--set"), source: arg(argv, "--source") };
  const cases = truth.filter((c) => (!only || only.includes(c.id)) && Object.entries(filter).every(([k, v]) => v == null || c[k] === v));
  const perPhoto = Number(arg(argv, "--runs-per") ?? 3);

  let runs, notes = [];
  if (mode === "truth") runs = truthRuns(cases, perPhoto);
  else if (mode === "replay") {
    const p = arg(argv, "--runs");
    if (!p) throw new Error("--mode replay needs --runs <runs.jsonl | dir>");
    runs = loadRuns(p);
  } else if (mode === "recorded") {
    const r = recordedRuns(cases, corpus);
    [runs, notes] = [r.runs, r.skipped];
  } else if (mode === "live") {
    liveGate({ batch: arg(argv, "--batch"), maxDollars: arg(argv, "--max-dollars"), presses: cases.length * perPhoto, env });
    runs = [];
    for (const t of cases) for (let k = 1; k <= perPhoto; k++) runs.push(await liveGenerate(t, k, { corpusDir: corpus, env }));
  } else throw new Error(`unknown --mode ${mode}`);

  for (const r of runs) if (r.outcome === "draft" && !cleanDoorLook(r.spec).ok) notes.push(`${r.case}#${r.run}: spec does not clean`);
  const result = scoreCorpus(cases, runs);
  const groups = [
    formatReport(result, `Door looks sim, ${mode}`),
    formatReport(scoreCorpus(cases, runs, { filter: { set: "holdout" } }), "Held-out photos"),
    formatReport(scoreCorpus(cases, runs, { filter: { source: "catalog" } }), "Catalog photos"),
  ];
  const report = [...groups, ...(notes.length ? [`Notes:\n  ${notes.join("\n  ")}`] : [])].join("\n\n---\n\n");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "runs.jsonl"), runs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(join(out, "score.json"), JSON.stringify({ ...result, rows: undefined }, null, 2) + "\n");
  writeFileSync(join(out, "report.txt"), report + "\n");
  writeFileSync(join(out, "sheet.html"), contactSheet({ cases, runs, result, corpusDir: resolve(corpus), outDir: out }));
  return { out, result, report };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then(({ out, report }) => {
    console.log(report);
    console.log(`\nWritten to ${out}`);
  }, (e) => {
    console.error(e.message);
    process.exitCode = 2;
  });
}
