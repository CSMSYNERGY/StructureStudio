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
//   --mode recorded  (free) the real SERVER maths (doorLook.ts: stageADoorLook, settleCloseUps) over
//                    recorded model answers in <corpus>/reads/<id>.json, so a maths change is re-scored
//                    without paying for new reads. It cannot catch prompt drift: every prompt change
//                    gets a live rerun.
//   --mode live      the real pipeline (P4's generate_door_look). COSTS API MONEY. Refuses unless
//                    --batch <name> matches DOOR_SIM_LIVE_BATCH (Ahsan's yes for that one batch) and
//                    --max-dollars covers the batch at the $3.00 ceiling per press. P4 is not built yet,
//                    so today it stops there.
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
//                 "ms"?, "costCents"?, "skipped"?, "vocabGaps"? } ] }

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkTruthCase, formatReport, loadRuns, loadTruth, scoreCorpus, scoreRun } from "./doorScore.mjs";
import { cleanDoorLook, DOOR_REFUSALS, settleCloseUps, stageADoorLook } from "../../supabase/functions/_shared/doorLook.ts";

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
      const base = { case: t.id, run: k + 1, mode: "recorded", ms: r.ms, costCents: r.costCents, skipped: r.skipped, vocabGaps: r.vocabGaps ?? [] };
      const c = stageADoorLook(r.reads ?? [], ctx);
      if (!c.ok) {
        out.push("refuse" in c
          ? { ...base, outcome: "refused", refuse: { code: DOOR_REFUSALS[c.refuse].code, reason: c.refuse } }
          : { ...base, outcome: "failed", error: "ai_door_unparseable" });
        return;
      }
      const d = settleCloseUps(c, r.closeUps ?? {});
      out.push(d.ok
        ? { ...base, outcome: "draft", spec: d.spec, warnings: d.warnings, sideFrom: c.sideFrom }
        : { ...base, outcome: "failed", error: `spec_${d.error}`, warnings: d.warnings });
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
// One live press. P4 builds generate_door_look (and P6 the straightened upload); until then there is
// nothing to call, and nothing here guesses at an API that does not exist.
export async function liveGenerate() {
  throw new Error("--mode live: the pipeline is not built yet (P4's generate_door_look, P6's upload). Nothing was called and nothing was charged.");
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
    for (const t of cases) for (let k = 1; k <= perPhoto; k++) runs.push(await liveGenerate(t, k));
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
