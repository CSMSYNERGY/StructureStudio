// dev/score-generator.mjs — the acceptance instrument for video-to-3D.
//
// ⚠️ WHAT IT CANNOT MEASURE, so a green table is never read as the bar being met:
//   bar 2, "no run scores below its own first pass", needs the SECOND pass, and only
//     --replay can supply it — the self-check runs in a browser against renders this script
//     cannot produce, so a live pass here records the first read and nothing else. The
//     footer says so in those words whenever no run carried one.
//   bar 3, the refusal rate, has no runner at all: it needs the truth spec written into a
//     ledger row's `drafted` and rendered, five times, which is a database write.
//
// It puts drafts in front of dev/score.mjs and prints the table. Three ways to get the
// drafts, and the mode is always explicit because WHERE a draft came from is part of what
// the number means:
//
//   --recorded   score the runs PINNED in each corpus entry. No network, no session, no
//                spend, same answer on any machine, forever. This is the "before" table.
//   --replay     score ai_style_calls.drafted for the same style. No session, no spend, but
//                it needs the service key and it reads whatever is in the database today.
//                This is how a PROMPT change gets a before number over real history.
//   (neither)    LIVE. Calls the paid endpoint N times per building. Costs money the day
//                the meter arms, writes ledger rows, and needs a portal session. It is the
//                only mode that can measure a change which has not run yet, so it is the one
//                that has to send `dims` — a pass without them measures the OLD prompt.
//
//   node dev/score-generator.mjs --recorded
//   node dev/score-generator.mjs --replay --tenant "$SCORING_TENANT_ID" --runs 5
//   node dev/score-generator.mjs --tenant "$SCORING_TENANT_ID" --runs 3 --yes
//   node dev/score-generator.mjs --preflight        (the drift check on its own)
//
// It never SAVES. The style row is left exactly as it was, so a scoring run cannot quietly
// become the next run's "prior".
//
// ─── WHY dev/ AND NOT tests/harness/ ────────────────────────────────────────────────────
// Everything in tests/harness drives a browser against a STUBBED Supabase and is safe to run
// on any machine at any time. This script is the opposite: in its default mode it calls the
// live paid endpoint on a live tenant and writes ledger rows. Those two things must not sit
// in the same folder, because "run the harness" has to stay something anyone can do without
// spending money. dev/ already holds the live-touching tools (verify-cal3d.mjs), and dev/ is
// in .assetsignore, so nothing here is served from a tenant's site.
//
// ─── THE INPUTS ARE NOT IN THE CORPUS, AND THAT IS DELIBERATE ───────────────────────────
// THIS REPOSITORY IS PUBLIC. A corpus entry carries the truth, the priors, the recorded
// drafts and each run's timestamp — and nothing else — and says `"inputs": "local"`. The
// tenant id, the style key and the pinned frame URLs live beside it in <entry>.local.json,
// which .gitignore keeps out of the repo. --recorded needs none of it; --replay and LIVE
// refuse without it.
//
// The entries carried their ai_style_calls row `id` until 2026-09-19. Nothing read it — this
// file selects it and drops it, and scoreEntry never sees it — so eight production primary
// keys sat in a public repo to no end. `n` and `called_at` say which run is which without
// naming a row.
//
//   dev/score-corpus/lofted-barn-porch.local.json
//   { "client_id": "...", "style_value": "...", "frames": ["https://.../walk-1.jpg", ...],
//     "dims": { "widthFt": 16, "lengthFt": 24, "wallHeightFt": 9 } }
//
// `dims` IS AN INPUT AND THE SIDECAR IS WHERE INPUTS LIVE. It is the dimensions card's own
// three numbers, and they are what the server turns into the prompt's ruler. Beside `truth`
// in the corpus they would read as an expectation; here they read as what the builder typed,
// which is what they are. A LIVE run without them is refused — see the sidecar check below.
//
// ⚠️ THE FRAMES ARE PINNED IN THAT FILE rather than read from the style row, because the
// server does not read the style row either: calibrate_style_ai takes `photoUrls` from the
// CALLER. The cabin entry records what goes wrong otherwise — its style row was re-saved
// after its runs, so the inputs on file today are not provably the ones those runs read. A
// corpus whose inputs can be edited out from under it cannot compare a number this month
// against a number last month, which is the entire job.
//
// ─── THE AUTH PROBLEM, HONESTLY ─────────────────────────────────────────────────────────
// calibrate_style_ai is gated `settings_structures / edit` and resolves the caller through
// auth.getUser() -> user -> client. There is no service-role back door and there should not
// be one: adding a header that skips the session on a paid endpoint is a bigger hole than
// this script is worth. So it mints a real session at run time and hardcodes nothing:
//
//   POST {SUPABASE_URL}/auth/v1/admin/generate_link  { type: "magiclink", email }  -> hashed_token
//   POST {SUPABASE_URL}/auth/v1/verify               { type: "magiclink", token }  -> access_token
//
// The same admin API the vault already relies on for headless Supabase access. No password
// anywhere, and the token dies in an hour. SCORING_USER_EMAIL is a real portal user with
// settings_structures edit on ONE tenant that exists for this purpose and sells nothing.
//
// ─── WHAT A LIVE RUN COSTS, AND THE THREE RAILS ─────────────────────────────────────────
// TODAY: nothing but Anthropic tokens. usage_prices video_3d_generation is active=false, so
// wallet_hold returns meter_inactive, holdId stays null and the generation runs free.
// THE DAY THAT BOOLEAN FLIPS, a 12-building x 3-run pass becomes 36 x $20 = $720 of holds.
//   RAIL 1  refuses to start unless --tenant matches SCORING_TENANT_ID from the environment
//           AND every corpus sidecar names that same tenant. (Environment, not a constant:
//           the repo is public, so an allow-list here would publish a tenant id.) It covers
//           --replay too, because a replay reads one tenant's recorded history and a live
//           pass generates on another — a before/after across the two is a comparison of two
//           different rulers, which is the exact failure the preflight above exists to stop.
//   RAIL 2  ⚠️ ASKS THE SERVER WHICH TENANT IT RESOLVED, and refuses unless it is the same
//           one. This is the only rail that can answer the question that decides where the
//           money lands. NOTHING IN THE REQUEST BODY SELECTS A TENANT: portal-settings
//           resolves it from `client_users` for the session minted from SCORING_USER_EMAIL
//           (resolveTenant.ts), so `--tenant`, SCORING_TENANT_ID and the sidecar's client_id
//           are three strings the server never reads. A stale or borrowed SCORING_USER_EMAIL
//           put every hold, every ai_style_calls row and every daily-cap slot on whichever
//           tenant that account belongs to, and both of the other rails passed while it
//           happened. `action: "status"` echoes the resolved tenant — the same tripwire
//           portal/01-core.jsx already keys on — so the session is minted and questioned
//           BEFORE --yes is accepted, not after.
//   RAIL 3  prints the price the meter would charge and the run's total BEFORE the first
//           call, naming the tenant the server echoed rather than the one we typed, and
//           stops there without --yes.
// Serial, never parallel: wallet_hold returns hold_in_flight for a second concurrent
// generation on one tenant, and ai_style_daily_cap is per tenant per 24h - a 36-run pass
// needs the scoring tenant's cap raised or the pass split across days.

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { scoreEntry, printFooter, RENDERER_CONSTANTS } from "./score.mjs";

const args = Object.fromEntries(process.argv.slice(2).flatMap((a, i, all) =>
  a.startsWith("--") ? [[a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]] : []));

const need = (k) => { const v = process.env[k]; if (!v) { console.error(`missing ${k}`); process.exit(2); } return v; };

// ─── PREFLIGHT: the mirrored constants have not drifted ─────────────────────────────────
// score.mjs re-implements the renderer's defaults so it can run anywhere, which means the
// copy is held to the original by nothing but this check. A default that moves in
// structure-studio.component.js and not here does not throw: it silently re-grades every
// historical run against a renderer that no longer exists, and the before/after it feeds is
// then a comparison of two different rulers. Loud, and it runs before every mode.
//
// `--root <dir>` points it at another checkout. Its real use is proving the check still
// bites: copy the bundle with one constant changed and watch this refuse.
function preflight(root = ".") {
  const cache = new Map();
  const bad = [];
  for (const c of RENDERER_CONSTANTS) {
    if (!cache.has(c.file)) {
      const p = join(root, c.file);
      cache.set(c.file, existsSync(p) ? readFileSync(p, "utf8") : null);
    }
    const src = cache.get(c.file);
    if (src === null) { bad.push(`${c.name}: cannot read ${c.file}`); continue; }
    if (!src.includes(c.needle)) bad.push(`${c.name} (${c.value}) - "${c.needle}" is no longer in ${c.file}`);
  }
  if (bad.length) {
    console.error("");
    console.error("RENDERER CONSTANT DRIFT - every number this scorer prints is suspect until this is fixed:");
    for (const b of bad) console.error(`   ${b}`);
    console.error("");
    console.error("Fix score.mjs's RENDERER_CONSTANTS to match the renderer, then re-run. Do NOT");
    console.error("compare a score taken after the drift against one taken before it.");
    return false;
  }
  console.log(`preflight OK - ${RENDERER_CONSTANTS.length} mirrored renderer constants still match the source`);
  return true;
}

if (!preflight(args.root || ".")) process.exit(1);
if (args.preflight) process.exit(0);

// ─── the corpus ─────────────────────────────────────────────────────────────────────────
const corpusDir = typeof args.corpus === "string" ? args.corpus : "dev/score-corpus";
const runsGiven = args.runs !== undefined;
const runsWanted = Number(args.runs || 3);
const entries = readdirSync(corpusDir)
  .filter((f) => f.endsWith(".json") && !f.endsWith(".local.json"))
  .map((f) => {
    const file = join(corpusDir, f);
    const entry = JSON.parse(readFileSync(file, "utf8"));
    const localPath = file.replace(/\.json$/, ".local.json");
    const local = existsSync(localPath) ? JSON.parse(readFileSync(localPath, "utf8")) : null;
    return { file, localPath, local, ...entry };
  });
if (!entries.length) { console.error(`no corpus entries in ${corpusDir}`); process.exit(2); }

const mode = args.recorded ? "recorded" : args.replay ? "replay" : "live";

// RAIL 1, and it goes before everything else in any mode that touches the live database: it
// is the one that stops a typo billing a real builder, so nothing — not even reading the
// corpus sidecars — happens ahead of it. RAIL 3 (the cost and the --yes gate) comes after the
// sidecar check, so a run that is going to fail on a missing file says so on the first attempt
// rather than the second.
//
// --replay IS COVERED, and that is not tidiness. It reads ai_style_calls for the sidecar's
// client_id with the service-role key, which reaches any tenant in the project; an unguarded
// replay against tenant A beside a live pass on tenant B is the two-rulers comparison the
// preflight above refuses in the other direction. --recorded reads nothing and is exempt.
const scoringTenant = mode === "recorded" ? null : need("SCORING_TENANT_ID");
if (mode !== "recorded") {
  if (!args.tenant) { console.error(`refusing: pass --tenant explicitly in ${mode} mode, and it must equal SCORING_TENANT_ID`); process.exit(2); }
  if (args.tenant !== scoringTenant) { console.error("refusing: --tenant is not the scoring tenant"); process.exit(2); }
}

// Both non-recorded modes need the sidecar. Refused up front, by name, rather than three
// buildings into a run.
if (mode !== "recorded") {
  const missing = entries.filter((e) => !e.local || !e.local.client_id || !e.local.style_value);
  if (missing.length) {
    console.error(`${mode} mode needs the inputs sidecar for each building. Missing or incomplete:`);
    for (const m of missing) console.error(`   ${m.localPath}`);
    console.error('   { "client_id": "...", "style_value": "...", "frames": ["https://...", ...],');
    console.error('     "dims": { "widthFt": 16, "lengthFt": 24, "wallHeightFt": 9 } }');
    process.exit(2);
  }
  // THE SECOND HALF OF RAIL 1. `client_id` is the id --replay reads history for, and the
  // tenant whose style the pinned frames belong to; a sidecar naming a different one is a
  // different building's history scored as this one's. Compared by name so the message says
  // which file is wrong rather than "refusing".
  const foreign = entries.filter((e) => String(e.local.client_id) !== String(scoringTenant));
  if (foreign.length) {
    console.error("refusing: these sidecars name a tenant that is not SCORING_TENANT_ID:");
    for (const f of foreign) console.error(`   ${f.localPath}`);
    console.error("   --replay would read that tenant's ledger, and a live pass would score its frames.");
    process.exit(2);
  }
}

// ⚠️ A LIVE RUN WITHOUT DIMS MEASURES THE OLD PROMPT. The server does not require them —
// parseKnownDims(undefined) is {ok, dims: null}, deliberately, so production's older bundle
// keeps working — so a pass with no dims SUCCEEDS and silently takes the no-ruler branch:
// videoShapePrompt(null) is byte-identical to the pre-dims prompt, still asking the model for
// a wall height it gets wrong in 74 % of generations, applyKnownDims is a no-op, and
// ai_style_calls.dims is written null. The number that comes back is an "after" for a pipeline
// with the ruler switched off, and the wall-height assertion — the dimensions card's own
// acceptance test — is null for every run of it. A run that will not start is better than a
// table that quietly grades the thing the change replaced.
const dimOf = (e) => (e.local && e.local.dims) || null;
const dimOk = (d) => !!d && Number(d.widthFt) > 0 && Number(d.lengthFt) > 0 && Number(d.wallHeightFt) > 0;
if (mode === "live") {
  const noDims = entries.filter((e) => !dimOk(dimOf(e)));
  if (noDims.length) {
    console.error("refusing: a LIVE pass measures the dimensions prompt, so every building needs its");
    console.error("three measurements in the sidecar. Missing or incomplete:");
    for (const m of noDims) console.error(`   ${m.localPath}  ->  "dims": { "widthFt": _, "lengthFt": _, "wallHeightFt": _ }`);
    console.error("(--recorded and --replay do not need them: they read dims off what was already run.)");
    process.exit(2);
  }
}

async function portalToken() {
  const url = need("SUPABASE_URL"), svc = need("SUPABASE_SERVICE_ROLE_KEY"), email = need("SCORING_USER_EMAIL");
  const h = { apikey: svc, Authorization: `Bearer ${svc}`, "Content-Type": "application/json" };
  const link = await fetch(`${url}/auth/v1/admin/generate_link`, {
    method: "POST", headers: h, body: JSON.stringify({ type: "magiclink", email }),
  }).then((r) => r.json());
  if (!link?.hashed_token) throw new Error(`could not mint a link for ${email}: ${JSON.stringify(link).slice(0, 200)}`);
  const sess = await fetch(`${url}/auth/v1/verify`, {
    method: "POST", headers: { apikey: svc, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "magiclink", token: link.hashed_token }),
  }).then((r) => r.json());
  if (!sess?.access_token) throw new Error("verify returned no access_token");
  return sess.access_token;
}

// ⚠️ RAIL 2: WHICH WALLET IS THIS SESSION? `status` returns the tenant resolveTenant picked for
// the caller, which is the id every costing line in calibrate_style_ai keys on — the daily-cap
// read, the ai_style_calls insert and wallet_hold. Asking is the only way to know: the request
// body cannot select a tenant, so nothing this script types is capable of being wrong in a way
// the server would notice.
//
// It is also the only rail that catches a DUPLICATE client_users row. resolveTenant's lookup is
// `.limit(1)` with no ORDER BY and its own comment records duplicates as a real condition, so a
// scoring account linked to two tenants can resolve differently between runs. That cannot be
// prevented from here; it can be seen, and a run that sees it stops.
async function resolvedTenant(token) {
  const r = await fetch(`${need("SUPABASE_URL")}/functions/v1/portal-settings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, apikey: need("SUPABASE_ANON_KEY"), "Content-Type": "application/json" },
    body: JSON.stringify({ action: "status" }),
  });
  let body = null;
  try { body = await r.json(); } catch { /* a non-JSON body is itself the finding */ }
  if (!r.ok || !body?.clientId) {
    throw new Error(`could not read the session's tenant (${r.status}): ${JSON.stringify(body).slice(0, 200)}`);
  }
  return String(body.clientId);
}

// One generation, exactly the call the panel makes.
async function generate(token, entry, n) {
  const local = entry.local;
  const frames = local.frames || [];
  if (!frames.length) throw new Error(`${entry.name}: the sidecar pins no frames`);
  // Refused above for the whole set, and again here: this is the line that spends the money,
  // and the panel's own handler takes the same belt-and-braces posture for the same reason.
  const dims = dimOf(entry);
  if (!dimOk(dims)) throw new Error(`${entry.name}: the sidecar carries no dims — a live pass would measure the old prompt`);
  const r = await fetch(`${need("SUPABASE_URL")}/functions/v1/portal-settings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, apikey: need("SUPABASE_ANON_KEY"), "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "calibrate_style_ai",
      // NO `clientId` HERE, DELIBERATELY. It used to ride along and read like a tenant
      // selector; portal-settings never looks at it (the only body-derived tenant is
      // `targetClientId`, for operator view-as). A key that looks like it aims the money and
      // does not is worse than no key: RAIL 2 above is what actually knows where this lands.
      styleValue: local.style_value,          // only labels the ledger row; it selects nothing
      source: entry.source || "video",        // "video" | "combined" | "photos"
      photoUrls: frames,                      // PINNED in the sidecar, walk order first
      videoCount: local.video_count ?? entry.video_count ?? frames.length,
      // THE RULER. Exactly what the dimensions card sends, so the prompt this pass measures
      // is the one a builder gets. Sent as three numbers rather than the whole sidecar
      // object, so a stray key in a local file cannot reach the server's parser.
      //
      // ⚠️ THREE NUMBERS AND NOT THE OVERHANG CHIP, and that is a measurement decision rather
      // than an oversight. `dims.overhangIn` is builder-owned exactly as the wall height is:
      // applyKnownDims writes it in before the sanitiser and the self-check may not touch it,
      // so sending it turns acceptance bar 4 ("roof.overhang <= 0.35 ft in >=4/5") from a
      // measurement of the generator into an assertion about our own plumbing. The eave is
      // the field the prompt rewrite exists to fix; a scoring pass has to let the model
      // answer it. score.mjs treats it as given whenever a run's `dims` carries it, so a
      // --replay over rows where a real builder pressed the chip still reports honestly.
      dims: { widthFt: Number(dims.widthFt), lengthFt: Number(dims.lengthFt), wallHeightFt: Number(dims.wallHeightFt) },
      // A fresh key per run, deliberately: reusing one would make wallet_hold refuse every
      // run after the first and the "three runs" would be one run printed thrice.
      idempotencyKey: `score-${Date.now()}-${n}-${Math.random().toString(36).slice(2, 8)}`,
    }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`${r.status}: ${body?.error || "no message"}`);
  // `dropped` > 0 means sanitizePhotoUrls threw inputs away - a sidecar with a dead bucket
  // URL would otherwise score a generator for reading five frames instead of eight and look
  // like a regression. Refuse rather than record it.
  if (body.dropped > 0 || body.frames !== frames.length) {
    throw new Error(`${entry.name}: server read ${body.frames} of ${frames.length} frames - fix the sidecar, do not score this`);
  }
  return body; // { ok, d3, frames, dropped, observed, balanceCents }
}

// ai_style_calls.drafted for this style, newest first. Free, instant, no session. It cannot
// measure a change that has not run yet, which is the whole reason the live path exists.
async function replay(local, limit) {
  const svc = need("SUPABASE_SERVICE_ROLE_KEY");
  const r = await fetch(
    `${need("SUPABASE_URL")}/rest/v1/ai_style_calls?client_id=eq.${encodeURIComponent(local.client_id)}`
    + `&style_key=eq.${encodeURIComponent(local.style_value)}&drafted=not.is.null`
    + `&order=called_at.desc&limit=${limit}`
    + "&select=id,called_at,drafted,observed,frames,video_count,source,dims,self_check_after,self_check_verdict",
    { headers: { apikey: svc, Authorization: `Bearer ${svc}` } },
  );
  if (!r.ok) throw new Error(`replay read failed: ${r.status}`);
  const rows = await r.json();
  if (!Array.isArray(rows)) throw new Error(`replay read returned ${JSON.stringify(rows).slice(0, 200)}`);
  // Oldest first, so "run 1" means the same thing it means in a live pass.
  return rows.reverse().map((row) => ({
    drafted: row.drafted, observed: row.observed, source: row.source, dims: row.dims,
    // THE SECOND PASS, when the row has one. `drafted` deliberately keeps the first read and
    // `self_check_after` is written only when something actually moved, so a null here means
    // the check ran and changed nothing, or did not run at all — either way the first pass IS
    // the answer and there is nothing to compare it with. That is why the footer counts
    // checked runs rather than assuming every row can answer bar 2.
    after: row.self_check_after || null, verdict: row.self_check_verdict || null,
    label: `${String(row.called_at || "").slice(5, 16)}`,
  }));
}

// ─── RAILS 2 AND 3, before anything is spent ────────────────────────────────────────────
// The session is minted HERE, above the --yes gate, and questioned before the cost is even
// printed. It used to be minted after the operator had already authorised the spend, which
// made the one fact that decides where the money goes unavailable at the moment of deciding.
const token = mode === "live" ? await portalToken() : null;
// ⚠️ NO process.exit() PAST THIS LINE. Once a request has gone out, exiting explicitly aborts
// inside libuv on Windows + Node 24 — "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"
// and an exit code of 127 — while undici still holds the keep-alive socket. A rail that
// refuses correctly and then dies with somebody else's crash message reads as the rail being
// broken. So the rails set `stop` and the code, and the script falls off the end instead;
// natural exit is immediate (the sockets are unref'd) and quiet.
let stop = false;
if (mode === "live") {
  const resolved = await resolvedTenant(token);
  if (resolved !== args.tenant) {
    console.error(`refusing: SCORING_USER_EMAIL's session resolves to tenant "${resolved}", not "${args.tenant}".`);
    console.error("   That is the tenant this pass would hold money against, write ai_style_calls rows on");
    console.error("   and spend daily-cap slots from. Point SCORING_USER_EMAIL at the scoring tenant's own");
    console.error("   portal user, or check for a duplicate client_users row for that account.");
    process.exitCode = 2;
    stop = true;
  } else {
    const total = entries.length * runsWanted;
    console.log(`about to run ${entries.length} building(s) x ${runsWanted} = ${total} live generations on tenant ${resolved} (the server's own answer, not the flag)`);
    for (const e of entries) {
      const d = dimOf(e);
      console.log(`   ${e.name}: measured against ${d.widthFt} x ${d.lengthFt} ft, ${d.wallHeightFt} ft walls`);
    }
    console.log(`if the meter is ARMED this holds $${(total * 20).toFixed(2)}. Re-run with --yes to proceed.`);
    if (!args.yes) stop = true;
  }
}

if (!stop) {
  const out = [];
  const record = [];
  for (const e of entries) {
    let runs = [];
    if (mode === "recorded") {
      // ALL of them unless --runs says otherwise: the pinned set is the whole recorded history
      // for that building, and silently dropping the fourth and fifth run would change what the
      // "before" number means depending on a flag nobody passed.
      runs = (e.runs || []).slice(0, runsGiven ? runsWanted : Infinity).map((r, i) => ({ ...r, label: `run ${i + 1}` }));
    } else if (mode === "replay") {
      runs = await replay(e.local, runsWanted);
    } else {
      for (let i = 0; i < runsWanted; i++) {
        const body = await generate(token, e, i + 1);   // SERIAL: wallet_hold refuses a second one
        runs.push({ drafted: body.d3, observed: body.observed, source: e.source || "video", dims: body.dims || null, label: `run ${i + 1}` });
      }
    }
    if (!runs.length) { console.log(`\n(no runs for ${e.name} in ${mode} mode - skipped)`); continue; }
    out.push(...scoreEntry(e.file, e, runs));
    record.push({ file: e.file, name: e.name, mode, runs: runs.map((r) => ({ label: r.label, drafted: r.drafted, observed: r.observed, source: r.source, dims: r.dims, after: r.after || null, verdict: r.verdict || null })) });
  }

  const headline = printFooter(out);

  mkdirSync("dev/score-runs", { recursive: true });
  const stamp = `${new Date().toISOString().slice(0, 10)}-${mode}`;
  const path = join("dev/score-runs", `${stamp}.json`);
  writeFileSync(path, JSON.stringify({ at: new Date().toISOString(), mode, headline, buildings: record, scored: out }, null, 1));
  console.log(`wrote ${path}`);
}
