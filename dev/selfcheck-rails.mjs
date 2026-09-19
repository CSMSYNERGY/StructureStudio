#!/usr/bin/env node
// Drive `calibrate_style_check` against a live deployment and prove its rails.
//
// WHY THIS IS A SCRIPT AND NOT A TEST. The deno suite proves the pure half — what the prompt
// says, what a reply parses to, which corrections survive the three gates — and the wiring test
// runs the claim against a hand-rolled client. Neither can prove the two things that only exist
// once the function is deployed: that the ACTION IS REACHABLE behind its gate, and that the
// claim really refuses at the database rather than in a fake. Both are one HTTP call each, and
// both cost nothing.
//
// ⚠️ dev/, NOT tests/harness/, for the reason score-generator.mjs is here: this one talks to a
// real deployment with a real session. `dev` is in .assetsignore, so nothing here ships.
//
// ── TWO MODES ────────────────────────────────────────────────────────────────────────────
//
// --rails   (the default) FREE, and the one to run first. Every request here is refused before
//           the model call: four of them never get past input parsing, one is refused by the
//           claim itself, and one is skipped because no frame survived the whitelist. Nothing
//           is generated, no row is claimed, no tokens are spent. Run it after every deploy.
//
// --live    The whole path, once, against a generation that ALREADY EXISTS and is less than
//           fifteen minutes old. It needs real renders, and only the browser half can make
//           those — so it reads them off disk rather than pretending. This is what proves the
//           model call, the merge and the ledger writes; it costs about four cents of our own
//           Anthropic budget and no builder money at all, because the generation it checks was
//           already paid for. Running it twice on one checkId is itself a test: the second is
//           a 409.
//
// ── ENVIRONMENT ──────────────────────────────────────────────────────────────────────────
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
//   SCORING_USER_EMAIL   the portal user the session is minted for
//   SCORING_TENANT_ID    the tenant, and --tenant must match it (score-generator's rail)
// Nothing is hardcoded: this repo is PUBLIC and none of the above belongs in it.
//
// ── RUNNING IT ───────────────────────────────────────────────────────────────────────────
//   node dev/selfcheck-rails.mjs --tenant "$SCORING_TENANT_ID" --style "<style key>"
//   node dev/selfcheck-rails.mjs --tenant "$SCORING_TENANT_ID" --style "<style key>" \
//        --live --inputs /path/outside/the/repo/selfcheck-inputs.json
//
// The --live inputs file, which must NOT live in this repo:
//   {
//     "checkId":  "<the checkId the generation returned, under 15 minutes old>",
//     "photoUrls": ["<the EXACT array that generation was sent, in that order>"],
//     "renders": [
//       { "viewpoint": "front",      "frame": 1, "file": "/path/front.jpg" },
//       { "viewpoint": "side",       "frame": 3, "file": "/path/side.jpg" },
//       { "viewpoint": "eaveCorner", "frame": 5, "file": "/path/eave.jpg" },
//       { "viewpoint": "corner",     "frame": 7, "file": "/path/corner.jpg" }
//     ]
//   }
// `frame` is a 1-BASED INDEX INTO photoUrls, which is what the first pass's frameMap indices
// mean. It is not an index into the style's stored frame list, and the two differ whenever the
// generation strided or the builder's own photographs came along.

import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};
const need = (k) => {
  const v = process.env[k];
  if (!v) { console.error(`missing env ${k}`); process.exit(2); }
  return v;
};

const live = flag("live");
const styleValue = opt("style");
if (!styleValue) { console.error("refusing: pass --style <the style key the generation used>"); process.exit(2); }
// score-generator's rail, repeated here for the same reason: an explicit tenant that has to
// match the environment is what stops this being pointed at a real builder by a stale shell.
// It is HALF the rail on its own — see the `status` echo below, which is the half that asks
// the server where the session actually landed rather than comparing two of our own strings.
const tenant = need("SCORING_TENANT_ID");
if (opt("tenant") !== tenant) { console.error("refusing: pass --tenant explicitly and it must equal SCORING_TENANT_ID"); process.exit(2); }

const URL_BASE = need("SUPABASE_URL");
const ANON = need("SUPABASE_ANON_KEY");

// Four bytes that ARE a JPEG as far as the server's sniff is concerned (SOI + the start of an
// APP0 marker) and are not a picture of anything. Deliberate: every request that uses this is
// refused before the model ever sees it, and a repo that ships a real image to make a refusal
// happen is a repo where somebody will later reuse it for a request that is NOT refused.
const STUB_JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]).toString("base64");
const NOT_A_JPEG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]).toString("base64");
const NOWHERE = "00000000-0000-4000-8000-000000000000";

async function portalToken() {
  const svc = need("SUPABASE_SERVICE_ROLE_KEY"), email = need("SCORING_USER_EMAIL");
  const h = { apikey: svc, Authorization: `Bearer ${svc}`, "Content-Type": "application/json" };
  const link = await fetch(`${URL_BASE}/auth/v1/admin/generate_link`, {
    method: "POST", headers: h, body: JSON.stringify({ type: "magiclink", email }),
  }).then((r) => r.json());
  if (!link?.hashed_token) throw new Error(`could not mint a link for ${email}: ${JSON.stringify(link).slice(0, 200)}`);
  const sess = await fetch(`${URL_BASE}/auth/v1/verify`, {
    method: "POST", headers: { apikey: svc, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "magiclink", token: link.hashed_token }),
  }).then((r) => r.json());
  if (!sess?.access_token) throw new Error("verify returned no access_token");
  return sess.access_token;
}

async function post(token, body) {
  const r = await fetch(`${URL_BASE}/functions/v1/portal-settings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let parsed = null;
  try { parsed = JSON.parse(await r.text()); } catch { /* a non-JSON body is itself the finding */ }
  return { status: r.status, body: parsed };
}

let failures = 0;
function expect(name, got, want) {
  const ok = want(got);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) {
    failures++;
    console.log(`        got ${got.status}: ${JSON.stringify(got.body).slice(0, 220)}`);
  }
}

const token = await portalToken();

// ⚠️ WHICH TENANT IS THIS SESSION ON? Nothing in a request body answers that: portal-settings
// resolves the tenant from `client_users` for the account SCORING_USER_EMAIL names, so
// `--tenant` and SCORING_TENANT_ID are two strings the server never reads. The self-check claim
// is scoped `.eq("client_id", …)` server-side, so a wrong tenant here answers 409 rather than
// burning a real builder's one free check — but a rail that cannot say WHICH tenant it proved
// anything about is not a rail. `status` echoes the resolved id; refuse if it disagrees.
const statusEcho = await post(token, { action: "status" });
if (statusEcho.status !== 200 || !statusEcho.body?.clientId) {
  console.error(`could not read the session's tenant: ${statusEcho.status} ${JSON.stringify(statusEcho.body).slice(0, 200)}`);
  process.exit(1);
}
if (String(statusEcho.body.clientId) !== tenant) {
  console.error(`refusing: SCORING_USER_EMAIL's session resolves to tenant "${statusEcho.body.clientId}", not "${tenant}".`);
  console.error("   Every request below would be answered about that tenant, not the scoring one.");
  process.exit(2);
}

// The style's OWN stored images, read back through the catalog the panel reads. These are what
// the whitelist will accept, so a rail that needs a real pair has to use them.
const catalog = await post(token, { action: "catalog" });
if (catalog.status !== 200) { console.error(`catalog failed: ${catalog.status}`); process.exit(1); }
const style = (catalog.body?.styles || []).find((s) => s.key === styleValue || s.value === styleValue);
if (!style) { console.error(`no style "${styleValue}" on this tenant`); process.exit(2); }
const own = [...(style.d3VideoFrames || style.d3_video_frames || []), ...(style.d3Photos || style.d3_photos || [])];
if (!own.length) { console.error(`style "${styleValue}" has no stored frames or photos — nothing can be paired`); process.exit(2); }
console.log(`style "${styleValue}" stores ${own.length} image(s)\n`);

const render = (viewpoint, frame, base64 = STUB_JPEG) => ({ viewpoint, frame, base64 });

// ── THE FREE RAILS ───────────────────────────────────────────────────────────────────────
console.log("RAILS (free — nothing below reaches the model)\n");

expect("a checkId that is not a uuid is a 400, not a database fault",
  await post(token, { action: "calibrate_style_check", styleValue, checkId: "nope", photoUrls: own, renders: [render("front", 1)] }),
  (r) => r.status === 400 && /checkId/.test(r.body?.error || ""));

expect("no photoUrls is refused by name",
  await post(token, { action: "calibrate_style_check", styleValue, checkId: NOWHERE, renders: [render("front", 1)] }),
  (r) => r.status === 400 && /photoUrls/.test(r.body?.error || ""));

expect("seven renders are refused, not sliced to four",
  await post(token, {
    action: "calibrate_style_check", styleValue, checkId: NOWHERE, photoUrls: own,
    renders: ["front", "side", "eaveCorner", "corner", "front", "side", "corner"].map((v, i) => render(v, (i % own.length) + 1)),
  }),
  (r) => r.status === 400 && /at most 4/.test(r.body?.error || ""));

expect("a PNG is refused however it is labelled",
  await post(token, {
    action: "calibrate_style_check", styleValue, checkId: NOWHERE, photoUrls: own,
    renders: [{ viewpoint: "front", frame: 1, base64: NOT_A_JPEG }],
  }),
  (r) => r.status === 400 && /not a JPEG/.test(r.body?.error || ""));

expect("⚠️ a URL the style does not own is dropped, so nothing pairs and the check is skipped",
  await post(token, {
    action: "calibrate_style_check", styleValue, checkId: NOWHERE,
    photoUrls: ["https://example.invalid/not-ours.jpg"], renders: [render("front", 1)],
  }),
  (r) => r.status === 200 && r.body?.verdict === "skipped" && r.body?.reason === "no_frames");

const claim = await post(token, {
  action: "calibrate_style_check", styleValue, checkId: NOWHERE,
  photoUrls: own, renders: [render("front", 1)],
});
expect("⚠️ THE CLAIM: a generation that does not exist is a 409, with no model call",
  claim, (r) => r.status === 409 && r.body?.code === "check_unavailable");
// READ THIS BEFORE BLAMING THE CLAIM. `client_settings.ai_style_self_check = false` short-
// circuits every request above the claim, so a tenant with the kill switch thrown fails the
// last two rails with a perfectly healthy function. Named here because the first guess on a
// 200-where-a-409-belongs is always the claim, and it would be the wrong guess.
if (claim.body?.reason === "off") {
  console.log("\n⚠️ THE KILL SWITCH IS THROWN for this tenant (client_settings.ai_style_self_check = false).");
  console.log("   Nothing above reached the claim. Set it back to null and run this again.");
}

// ── THE WHOLE PATH, ONCE ─────────────────────────────────────────────────────────────────
if (live) {
  const inputsPath = opt("inputs");
  if (!inputsPath) { console.error("\n--live needs --inputs <file.json>; see the header for its shape"); process.exit(2); }
  const inputs = JSON.parse(readFileSync(inputsPath, "utf8"));
  for (const k of ["checkId", "photoUrls", "renders"]) {
    if (!inputs[k]) { console.error(`the inputs file has no ${k}`); process.exit(2); }
  }
  const renders = inputs.renders.map((r) => ({
    viewpoint: r.viewpoint,
    frame: r.frame,
    base64: readFileSync(r.file).toString("base64"),
  }));
  const kb = renders.reduce((n, r) => n + Buffer.from(r.base64, "base64").length, 0) / 1000;
  console.log(`\nLIVE — ${renders.length} render(s), ${kb.toFixed(0)} KB total, against generation ${inputs.checkId}`);

  const t0 = Date.now();
  const first = await post(token, {
    action: "calibrate_style_check", styleValue,
    checkId: inputs.checkId, photoUrls: inputs.photoUrls, renders,
  });
  console.log(`   ${Date.now() - t0} ms  status ${first.status}`);
  console.log(`   ${JSON.stringify(first.body, null, 2)}`);
  expect("the check ran and answered with a verdict",
    first, (r) => r.status === 200 && ["matches", "corrections", "rejected_too_many", "failed", "skipped"].includes(r.body?.verdict));

  // The single-use guard, live. This is the one assertion that cannot be made anywhere else:
  // one paid generation buys exactly one free check, and the row is what remembers.
  expect("⚠️ SINGLE-USE: the same generation cannot be checked twice",
    await post(token, {
      action: "calibrate_style_check", styleValue,
      checkId: inputs.checkId, photoUrls: inputs.photoUrls, renders,
    }),
    (r) => r.status === 409 && r.body?.code === "check_unavailable");

  console.log("\nThen read the row back, which is the half this script cannot see:");
  console.log(`  select self_check_at, self_check_verdict, self_check_renders, self_check_ms,`);
  console.log(`         self_check_tokens, jsonb_array_length(coalesce(self_check_changed,'[]')) as changed,`);
  console.log(`         (self_check_after is not null) as has_after, (drafted is not null) as drafted_kept`);
  console.log(`  from ai_style_calls where id = '${inputs.checkId}';`);
  console.log("  -- drafted_kept MUST be true: the first pass is never overwritten.");
}

console.log(`\n${failures ? `${failures} FAILED` : "all rails passed"}`);
process.exit(failures ? 1 : 0);
