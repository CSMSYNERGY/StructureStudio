// doorLookLocal.mjs — door looks from a photo, the LOCAL path (plan of 2026-10-24, phase P4).
//
// Runs the press's EXACT Stage A prompt where there is no API key and nothing may be deployed: a person
// (or Claude Code) is the model. Two steps:
//
//   1. prepare: the photo straightened (optional) and fitted to the plan's limits (1568 px on the long
//      side, 1.15 MP), the exact Stage A prompt, the request body the server would send, and the size
//      the model must echo back.
//
//        node scripts/doorLookLocal.mjs prepare --photo <file> --width <in> --height <in> --leaves 1|2 --out <dir>
//             [--quad x,y,x,y,x,y,x,y]    the leaves' four outer corners in the photo, top-left, top-right,
//                                         bottom-right, bottom-left (inside the casing, the bottom ones on
//                                         the threshold): the photo is straightened to them, its shape the
//                                         typed width over height. Without it the photo is taken as already
//                                         straightened, and only shrunk.
//             [--hinge <file>] [--handle <file>] [--meet <file>]   the builder's own close-ups
//
//   2. settle: the answers through the REAL server maths (_shared/doorGenerate.ts doorDraftFromReads:
//      doorLook.ts's Stage A consensus, the close-up fallbacks, the agreement check, the vocabulary gaps
//      and the 6-panel rule, the refusal codes). Close-ups and Stage B are skipped unless given, each with
//      the plan's warning; when Stage B is wanted, its exact prompt is written beside the result.
//
//        node scripts/doorLookLocal.mjs settle --prep <dir> --reads <a.json> <b.json> <c.json> [--out <file>]
//             [--closeups <file.json>]    {"hinges": {"status": "ok", "votes": [...]}, "handle": ..., "meet": ...}
//             [--stageb <file.json>]      the Stage B answer, when one was asked by hand
//             [--record <corpus>/reads/<id>.json]   append the run in the sim's --mode recorded format
//             [--no-colors]               skip the colour patches (no browser needed)
//
// Each read file is the model's answer: its JSON, or its whole reply (the JSON is found in it).
//
// THE PHOTOS ARE BUILDERS' DATA AND THE REPO IS PUBLIC: every output path is refused inside the repo. The
// image work (decode, straighten, fit, the colour patches) runs in Playwright's headless Chromium, which
// the repo already has for its harnesses; nothing here reaches the network.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { doorFitSize, doorRequestBody, doorStageAPrompt, doorStageBPrompt, DOOR_LOOK_PROMPT_ID } from "../supabase/functions/_shared/doorLookPrompt.ts";
import { DOOR_READ_MAX_TOKENS, DOOR_READS, doorDraftFromReads } from "../supabase/functions/_shared/doorGenerate.ts";
import { samplePatch } from "../supabase/functions/_shared/doorLook.ts";
import { AI_MODEL_V2 } from "../supabase/functions/_shared/styleD3.ts";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The real path (junctions, symlinks and 8.3 short names resolved) of `p`, or of its nearest existing
// folder with the rest of `p` joined on: a path that does not exist yet is judged by where it would land.
export function realPathOf(p) {
  let cur = resolve(p);
  const rest = [];
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) break;
    rest.unshift(basename(cur));
    cur = up;
  }
  let real = cur;
  try {
    real = realpathSync.native(cur);
  } catch { /* keep the resolved path */ }
  return join(real, ...rest);
}
export function insideRepo(p, root = REPO_ROOT) {
  const a = realPathOf(p).toLowerCase(), r = realPathOf(root).toLowerCase();
  return a === r || a.startsWith(r.endsWith(sep) ? r : r + sep);
}
// Inside ANY git work tree: this repo's other checkouts and worktrees too, which a path test against this
// checkout alone would miss. A builder's photo never goes into one.
export function insideGitWorkTree(p) {
  let cur = realPathOf(p);
  while (!existsSync(cur) && dirname(cur) !== cur) cur = dirname(cur);
  const r = spawnSync("git", ["-C", cur, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  return r.status === 0 && String(r.stdout).trim() === "true";
}
export const outsideRepos = (p) => !insideRepo(p) && !insideGitWorkTree(p);
const outside = (p, what) => {
  if (!outsideRepos(p)) throw new Error(`${what} must be outside the repo and any git checkout (it holds a builder's photo, and the repo is public): ${p}`);
  return resolve(p);
};

// ─── THE IMAGE WORK, IN HEADLESS CHROMIUM ─────────────────────────────────────────────────────────
// size(file) -> [w, h]; render({file, quad?, out}) -> JPEG bytes at exactly `out`; pixels(file) ->
// {w, h, rgba}; crop({file, windows, zoom}) -> base64 JPEGs. One browser for the whole run; close() it.
const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
const dataUrl = (file) => `data:${MIME[(file.match(/\.[a-z]+$/i)?.[0] ?? "").toLowerCase()] ?? "image/jpeg"};base64,${readFileSync(file).toString("base64")}`;

export async function playwrightImageOps() {
  const { chromium } = await import("playwright");
  // The installed Chrome, as tests/harness/lib.mjs launches it (PW_CHANNEL=bundled for Playwright's own).
  const browser = await chromium.launch({ headless: true, channel: process.env.PW_CHANNEL === "bundled" ? undefined : "chrome" });
  const page = await browser.newPage();
  await page.setContent("<!doctype html><body></body>");
  const load = `async (src) => { const img = new Image(); img.src = src; await img.decode(); return img; }`;
  return {
    async size(file) {
      return await page.evaluate(async ([src, l]) => {
        const img = await (0, eval)(l)(src);
        return [img.naturalWidth, img.naturalHeight];
      }, [dataUrl(file), load]);
    },
    async render({ file, quad = null, out }) {
      const b64 = await page.evaluate(async ([src, l, quad, out]) => {
        const img = await (0, eval)(l)(src);
        const [W, H] = out;
        const canvas = document.createElement("canvas");
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext("2d");
        if (!quad) {
          ctx.imageSmoothingQuality = "high";
          ctx.drawImage(img, 0, 0, W, H);
        } else {
          // Shrink the source first so the warp samples about 2 source pixels per output pixel.
          const edge = Math.max(...quad.map((p, i) => Math.hypot(p[0] - quad[(i + 1) % 4][0], p[1] - quad[(i + 1) % 4][1])));
          const k = Math.min(1, (2 * Math.max(W, H)) / edge);
          const sw = Math.round(img.naturalWidth * k), sh = Math.round(img.naturalHeight * k);
          const s = document.createElement("canvas");
          s.width = sw;
          s.height = sh;
          const sctx = s.getContext("2d");
          sctx.imageSmoothingQuality = "high";
          sctx.drawImage(img, 0, 0, sw, sh);
          const src = sctx.getImageData(0, 0, sw, sh).data;
          const q = quad.map(([x, y]) => [x * k, y * k]);
          // The homography from the output rectangle to the quad: 8 unknowns, Gaussian elimination.
          const dst = [[0, 0], [W, 0], [W, H], [0, H]];
          const A = [];
          for (let i = 0; i < 4; i++) {
            const [x, y] = dst[i], [u, v] = q[i];
            A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
            A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
          }
          for (let c = 0; c < 8; c++) {
            let p = c;
            for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
            [A[c], A[p]] = [A[p], A[c]];
            for (let r = 0; r < 8; r++) {
              if (r === c) continue;
              const f = A[r][c] / A[c][c];
              for (let j = c; j < 9; j++) A[r][j] -= f * A[c][j];
            }
          }
          const h = A.map((row, i) => row[8] / row[i]);
          const outImg = ctx.createImageData(W, H);
          const o = outImg.data;
          for (let Y = 0; Y < H; Y++) {
            for (let X = 0; X < W; X++) {
              const x = X + 0.5, y = Y + 0.5, d = h[6] * x + h[7] * y + 1;
              const sx = (h[0] * x + h[1] * y + h[2]) / d - 0.5, sy = (h[3] * x + h[4] * y + h[5]) / d - 0.5;
              const x0 = Math.max(0, Math.min(sw - 1, Math.floor(sx))), y0 = Math.max(0, Math.min(sh - 1, Math.floor(sy)));
              const x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
              const fx = Math.max(0, Math.min(1, sx - x0)), fy = Math.max(0, Math.min(1, sy - y0));
              const at = (Y * W + X) * 4;
              for (let ch = 0; ch < 3; ch++) {
                const v00 = src[(y0 * sw + x0) * 4 + ch], v10 = src[(y0 * sw + x1) * 4 + ch];
                const v01 = src[(y1 * sw + x0) * 4 + ch], v11 = src[(y1 * sw + x1) * 4 + ch];
                o[at + ch] = (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
              }
              o[at + 3] = 255;
            }
          }
          ctx.putImageData(outImg, 0, 0);
        }
        return canvas.toDataURL("image/jpeg", 0.92).split(",")[1];
      }, [dataUrl(file), load, quad, out]);
      return Buffer.from(b64, "base64");
    },
    async pixels(file) {
      const r = await page.evaluate(async ([src, l]) => {
        const img = await (0, eval)(l)(src);
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let bin = "";
        for (let i = 0; i < d.length; i += 0x8000) bin += String.fromCharCode(...d.subarray(i, i + 0x8000));
        return { w: c.width, h: c.height, b64: btoa(bin) };
      }, [dataUrl(file), load]);
      return { w: r.w, h: r.h, rgba: new Uint8Array(Buffer.from(r.b64, "base64")) };
    },
    async crop({ file, windows, zoom }) {
      return await page.evaluate(async ([src, l, windows, zoom]) => {
        const img = await (0, eval)(l)(src);
        return windows.map((w) => {
          const c = document.createElement("canvas");
          c.width = w.w * zoom;
          c.height = w.h * zoom;
          const ctx = c.getContext("2d");
          ctx.imageSmoothingEnabled = false; // nearest neighbour, as closeUp.ts's resize
          ctx.drawImage(img, w.x, w.y, w.w, w.h, 0, 0, c.width, c.height);
          return c.toDataURL("image/jpeg", 0.9).split(",")[1];
        });
      }, [dataUrl(file), load, windows, zoom]);
    },
    async close() {
      await browser.close();
    },
  };
}

// ─── PREPARE ──────────────────────────────────────────────────────────────────────────────────────
// The straightened photo's own size: the typed shape at the largest size inside the limits that the
// quad's own pixels can fill (never enlarged), or the photo's own shape, shrunk to fit.
export function preparedSize({ src, quad, widthIn, heightIn }) {
  if (!quad) return doorFitSize(src);
  const len = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const w = Math.max(len(quad[0], quad[1]), len(quad[3], quad[2])), h = Math.max(len(quad[0], quad[3]), len(quad[1], quad[2]));
  const aspect = widthIn / heightIn;
  // The quad's pixels at the typed shape: its height, or its width, whichever runs out first.
  const natural = h * aspect <= w ? [h * aspect, h] : [w, w / aspect];
  return doorFitSize([Math.round(natural[0]), Math.round(natural[1])], aspect);
}

export function parseQuad(s) {
  if (!s) return null;
  const n = String(s).split(",").map(Number);
  if (n.length !== 8 || n.some((v) => !Number.isFinite(v))) throw new Error("--quad needs eight numbers: x,y of the top-left, top-right, bottom-right and bottom-left corners");
  return [[n[0], n[1]], [n[2], n[3]], [n[4], n[5]], [n[6], n[7]]];
}

export async function prepare(o, ops) {
  const out = outside(o.out, "--out");
  const widthIn = Number(o.width), heightIn = Number(o.height), leaves = Number(o.leaves);
  if (!(widthIn > 0) || !(heightIn > 0)) throw new Error("--width and --height are the door's real size in inches");
  if (leaves !== 1 && leaves !== 2) throw new Error("--leaves is 1 or 2");
  if (!o.photo || !existsSync(o.photo)) throw new Error(`no photo at ${o.photo}`);
  mkdirSync(out, { recursive: true });
  const quad = parseQuad(o.quad);
  const src = await ops.size(o.photo);
  const photo = preparedSize({ src, quad, widthIn, heightIn });
  writeFileSync(join(out, "photo.jpg"), await ops.render({ file: o.photo, quad, out: photo }));
  const closeUps = [];
  for (const k of ["hinge", "handle", "meet"]) {
    if (!o[k]) continue;
    if (k === "meet" && leaves !== 2) continue; // a single door has no meeting edge
    const s = await ops.size(o[k]);
    writeFileSync(join(out, `closeup-${k}.jpg`), await ops.render({ file: o[k], out: doorFitSize(s) }));
    closeUps.push(k);
  }
  const text = doorStageAPrompt({ widthIn, heightIn, leaves, photo, closeUps });
  const images = ["photo.jpg", ...closeUps.map((k) => `closeup-${k}.jpg`)];
  // The request the server would send, the images named by their files here (the server sends signed URLs).
  const body = doorRequestBody({ model: AI_MODEL_V2, maxTokens: DOOR_READ_MAX_TOKENS, effort: "high", images: images.map((f) => ({ url: `file:${f}` })), text });
  const request = {
    prompt: DOOR_LOOK_PROMPT_ID, model: AI_MODEL_V2, effort: "high", maxTokens: DOOR_READ_MAX_TOKENS, reads: DOOR_READS,
    widthIn, heightIn, leaves, photo, expectSize: photo, images, closeUps,
    // Not the photo's own path: a vault path can name the builder.
    source: { size: src, ...(quad ? { quad } : {}) }, body,
  };
  writeFileSync(join(out, "prompt.txt"), text);
  writeFileSync(join(out, "request.json"), JSON.stringify(request, null, 2) + "\n");
  writeFileSync(join(out, "HOW-TO-RUN.txt"), [
    `Door look, local Stage A (${DOOR_LOOK_PROMPT_ID}).`,
    "",
    `1. In a FRESH conversation each time, give the model ${images.join(", then ")} (in that order), then the whole of prompt.txt as the message.`,
    `   The model must answer with JSON only, and its measure.size must be [${photo[0]}, ${photo[1]}] (this photo's size in pixels).`,
    `2. Save each answer as read-1.json, read-2.json, read-3.json (${DOOR_READS} reads; the server needs 2 that agree).`,
    `3. node scripts/doorLookLocal.mjs settle --prep "${out}" --reads "${join(out, "read-1.json")}" "${join(out, "read-2.json")}" "${join(out, "read-3.json")}"`,
    "",
  ].join("\n"));
  return { out, photo, request };
}

// ─── SETTLE ───────────────────────────────────────────────────────────────────────────────────────
const readAnswer = (file) => {
  const raw = readFileSync(file, "utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // a whole reply: doorDraftFromReads finds the JSON in it
  }
};

export async function settle(o, ops = null) {
  const prep = resolve(o.prep);
  const request = JSON.parse(readFileSync(join(prep, "request.json"), "utf8"));
  const files = o.reads ?? [];
  if (!files.length) throw new Error("--reads needs the model's answers (one file each)");
  const answers = files.map(readAnswer);
  const ctx = { widthIn: request.widthIn, heightIn: request.heightIn, leaves: request.leaves, photo: request.photo };
  let colorNote = "colours skipped (--no-colors)";
  if (ops) {
    const px = await ops.pixels(join(prep, "photo.jpg"));
    if (px.w === ctx.photo[0] && px.h === ctx.photo[1]) {
      ctx.colorAt = (p) => samplePatch(px.rgba, px.w, px.h, p);
      colorNote = "colours from the photo's 5 x 5 patches";
    } else colorNote = `colours skipped: photo.jpg is ${px.w} x ${px.h}, not ${ctx.photo.join(" x ")}`;
  }
  const closeUps = o.closeups ? JSON.parse(readFileSync(o.closeups, "utf8")) : undefined;
  const stageB = o.stageb ? readAnswer(o.stageb) : undefined;
  const r = doorDraftFromReads(answers, ctx, { closeUps, stageB });
  // The run record, as the scorer reads one (tests/doorlooks/doorScore.mjs).
  const run = {
    outcome: r.outcome,
    ...(r.spec ? { spec: r.spec } : {}),
    warnings: r.warnings,
    vocabGaps: r.vocabGaps,
    ...(r.sideFrom ? { sideFrom: r.sideFrom } : {}),
    ...(r.refuse ? { refuse: { code: r.refuse.code, reason: r.refuse.reason, text: r.refuse.text } } : {}),
    ...(r.error ? { error: r.error } : {}),
    skipped: { closeUps: !closeUps, stageB: !!r.stageB?.needed && stageB === undefined },
    prompt: request.prompt,
  };
  const result = {
    ...run,
    reads: files.length,
    used: r.consensus?.used ?? null,
    dropped: r.consensus?.dropped ?? null,
    closeUpAt: r.consensus?.closeUpAt ?? null,
    stageBWanted: r.stageB ?? null,
    colorNote,
  };
  const outFile = outside(o.out ?? join(prep, "result.json"), "--out");
  writeFileSync(outFile, JSON.stringify(result, null, 2) + "\n");
  // Stage B, when the agreement check wants it and none was given: its exact prompt, for a hand run.
  if (r.spec && r.stageB?.needed && stageB === undefined) {
    writeFileSync(join(dirname(outFile), "stageB-prompt.txt"), doorStageBPrompt({ photo: ctx.photo, widthIn: ctx.widthIn, heightIn: ctx.heightIn, spec: r.spec, missing: r.stageB.missing, unexplained: r.stageB.unexplained }));
  }
  if (o.record) {
    const recFile = outside(o.record, "--record");
    const rec = existsSync(recFile) ? JSON.parse(readFileSync(recFile, "utf8")) : { photo: ctx.photo, runs: [] };
    if (JSON.stringify(rec.photo) !== JSON.stringify(ctx.photo)) throw new Error(`--record ${recFile} is for a ${rec.photo?.join(" x ")} photo, not ${ctx.photo.join(" x ")}`);
    rec.runs.push({ reads: answers, ...(closeUps ? { closeUps } : {}), ...(stageB !== undefined ? { stageB } : {}), vocabGaps: r.vocabGaps, prompt: request.prompt });
    mkdirSync(dirname(recFile), { recursive: true });
    writeFileSync(recFile, JSON.stringify(rec, null, 2) + "\n");
  }
  return { out: outFile, result };
}

// ─── RUN ──────────────────────────────────────────────────────────────────────────────────────────
export function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      o._.push(a);
      continue;
    }
    const k = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (k === "noColors") o.noColors = true;
    else if (k === "reads") {
      o.reads = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) o.reads.push(argv[++i]);
    } else o[k] = argv[++i];
  }
  return o;
}

export async function main(argv, makeOps = playwrightImageOps) {
  const o = parseArgs(argv);
  const cmd = o._[0];
  if (cmd !== "prepare" && cmd !== "settle") throw new Error("usage: node scripts/doorLookLocal.mjs prepare|settle ... (see the header)");
  const ops = cmd === "settle" && o.noColors ? null : await makeOps();
  try {
    return cmd === "prepare" ? await prepare(o, ops) : await settle(o, ops);
  } finally {
    await ops?.close?.();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then((r) => {
    if (r.request) {
      console.log(`Prepared ${r.out}: photo.jpg is ${r.photo.join(" x ")} px. Next: see HOW-TO-RUN.txt there.`);
    } else {
      const x = r.result;
      console.log(`${x.outcome}${x.spec ? `: ${x.spec.base}, ${x.spec.src.leaves === 2 ? "double" : "single"}, hinge ${x.spec.src.hinge}` : x.refuse ? `: ${x.refuse.code} (${x.refuse.reason})` : `: ${x.error}`}`);
      for (const w of x.warnings) console.log(`  warning ${w.code}: ${w.text}`);
      if (x.vocabGaps.length) console.log(`  vocabulary gaps: ${x.vocabGaps.join(", ")}`);
      console.log(`  ${x.colorNote}\nWritten to ${r.out}`);
    }
  }, (e) => {
    console.error(e.message);
    process.exitCode = 2;
  });
}
