#!/usr/bin/env node
// Builds the support assistant's knowledge from the product's own words (Carolyn 10-26 call, support
// plan step 3). Rerun with each weekly release, after the release notes are written:
//
//   node scripts/support-kb.mjs           write supabase/functions/support-agent/kb.md and knowledge.ts
//   node scripts/support-kb.mjs --check   exit 1 when either file is not what this script would write
//
// WHERE THE WORDS COME FROM. Nothing here is typed twice: every line of kb.md is lifted from the
// source a builder already sees, so a renamed page reaches the assistant the next time this runs.
//   portal/01-core.jsx            TAB_META (the sidebar pages and their one-line descriptions) and the
//                                 Settings tab lists: ssSettingsTabs, ssCompanyTabs, ssColorTabs,
//                                 ssBillingTabs, ssCustomerHubTabs, ssOptionTabs.
//   _shared/access.ts             AREAS (what each access switch on the Team page covers) and TITLES.
//   migrations/160_setup_v2.sql   the "Getting set up" checklist template.
//   support-agent/faq.md          the hand-written answers, checked against beta by Ahsan.
// Release notes are NOT copied: the assistant reads them live (search_whats_new), so they are never
// a week stale.
//
// WHAT IS LEFT OUT. Our own consoles (Accounts, Admin, Projects) and Advanced mode, which is limited
// to the internal account (Ahsan 10-27), and every access area marked internalOnly. A builder must not
// be told about a page they can never reach.
//
// WHY knowledge.ts AND NOT kb.md AT RUNTIME. An edge function bundle carries what it imports; a
// Markdown file beside it is not deployed. knowledge.ts embeds kb.md + faq.md as one string, and
// support-agent/knowledge_test.ts fails when it drifts from the two files.
//
// The repo is public: the output must never name a builder, a tenant id or an inbox. The check below
// refuses any email address, and Ahsan greps kb.md for every live client id before a release.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8").replace(/\r/g, "");
const OUT_DIR = "supabase/functions/support-agent";
const KB_FILE = `${OUT_DIR}/kb.md`;
const FAQ_FILE = `${OUT_DIR}/faq.md`;
const TS_FILE = `${OUT_DIR}/knowledge.ts`;
/** The plan's ceiling for the cached prefix. ~3.6 characters per token for this English. */
const MAX_TOKENS = 30000;
const CHARS_PER_TOKEN = 3.6;

/** Pages builders never see (our consoles), and Advanced mode, limited to the internal account. */
const HIDDEN_PAGES = new Set(["accounts", "admin", "projects", "advanced"]);

function fail(msg) {
  console.error(`support-kb: ${msg}`);
  process.exit(1);
}

/** The text of one top-level `function NAME(` in a source file, up to the next top-level function. */
function fnBody(src, name) {
  const i = src.indexOf(`\nfunction ${name}(`);
  if (i < 0) fail(`function ${name} not found in portal/01-core.jsx; re-point the generator`);
  const j = src.indexOf("\nfunction ", i + 10);
  return src.slice(i, j < 0 ? undefined : j);
}

/** ["slug", "Label", "Description", maybe "Group"] tuples, comments dropped. */
function tuples(body) {
  const code = body.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  const out = [];
  const re = /\[\s*"([a-z0-9-]+)",\s*"([^"]+)",\s*"([^"]*)"(?:,\s*(?:"([^"]*)"|null))?\s*\]/g;
  let m;
  while ((m = re.exec(code))) out.push({ slug: m[1], label: m[2], desc: m[3], group: m[4] || null });
  return out;
}

function tabMeta(src) {
  const i = src.indexOf("const TAB_META = {");
  const j = src.indexOf("\n};", i);
  if (i < 0 || j < 0) fail("TAB_META not found in portal/01-core.jsx");
  const out = [];
  const re = /^\s*"?([a-z0-9-]+)"?:\s*\["([^"]+)",\s*"([^"]+)"\]/;
  for (const line of src.slice(i, j).split("\n")) {
    const m = re.exec(line);
    if (m && !HIDDEN_PAGES.has(m[1])) out.push({ key: m[1], label: m[2], desc: m[3] });
  }
  if (out.length < 10) fail(`TAB_META parsed only ${out.length} pages; the generator's pattern is stale`);
  return out;
}

function accessAreas(src) {
  const i = src.indexOf("export const AREAS: Area[] = [");
  const j = src.indexOf("\n];", i);
  if (i < 0 || j < 0) fail("AREAS not found in _shared/access.ts");
  const block = src.slice(i, j);
  const out = [];
  for (const chunk of block.split(/\n\s*\{ key: /).slice(1)) {
    const key = /^"([a-z_]+)"/.exec(chunk);
    const label = /label:\s*"([^"]+)"/.exec(chunk);
    const group = /group:\s*"([a-z]+)"/.exec(chunk);
    const hint = /hint:\s*"((?:[^"\\]|\\.)*)"/.exec(chunk);
    if (!key || !label || !hint) continue;
    if (/internalOnly:\s*true/.test(chunk.split("\n  {")[0])) continue;
    out.push({ key: key[1], label: label[1], group: group ? group[1] : "", hint: hint[1].replace(/\\'/g, "'") });
  }
  if (out.length < 15) fail(`AREAS parsed only ${out.length} areas; the generator's pattern is stale`);
  return out;
}

function titles(src) {
  const i = src.indexOf("export const TITLES");
  const j = src.indexOf("\n];", i);
  const out = [];
  const re = /\{ key: "([a-z_]+)",\s*label: "([^"]+)",\s*blurb: "([^"]+)" \}/g;
  let m;
  const block = src.slice(i, j);
  while ((m = re.exec(block))) out.push({ label: m[2], blurb: m[3] });
  if (out.length < 5) fail("TITLES not parsed from _shared/access.ts");
  return out;
}

function setupSteps(sql) {
  const i = sql.indexOf("insert into public.setup_template_items");
  if (i < 0) fail("160_setup_v2.sql: setup_template_items insert not found");
  const body = sql.slice(i);
  const out = [];
  // ('Section', 'Title',\n   'Detail', link, position, active)
  const re = /\(\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)',/g;
  let m;
  while ((m = re.exec(body))) {
    const un = (s) => s.replace(/''/g, "'").replace(/\s+/g, " ").trim();
    out.push({ section: un(m[1]), title: un(m[2]), detail: un(m[3]) });
  }
  if (out.length < 10) fail(`160_setup_v2.sql parsed only ${out.length} setup steps`);
  return out;
}

function build() {
  const core = read("portal/01-core.jsx");
  const access = read("supabase/functions/_shared/access.ts");
  const setup = read("supabase/migrations/160_setup_v2.sql");

  const pages = tabMeta(core);
  const settings = tuples(fnBody(core, "ssSettingsTabs"));
  const company = tuples(fnBody(core, "ssCompanyTabs"));
  const colors = tuples(fnBody(core, "ssColorTabs"));
  const billing = tuples(fnBody(core, "ssBillingTabs"));
  const hub = tuples(fnBody(core, "ssCustomerHubTabs"));
  const options = tuples(fnBody(core, "ssOptionTabs"));
  const areas = accessAreas(access);
  const jobTitles = titles(access);
  const steps = setupSteps(setup);

  const L = [];
  L.push("# Structure Studio: what is where");
  L.push("");
  L.push("GENERATED by scripts/support-kb.mjs from the portal's own source. Do not edit by hand; rerun the script.");
  L.push("");
  L.push("Structure Studio is the portal builders of sheds, barns, garages and other buildings use to design");
  L.push("buildings with their customers, send estimates, take orders, schedule builds and deliveries, and run");
  L.push("their sales. Their customers design on the builder's own customer link; the builder and their team");
  L.push("work in the portal. Navigation below is written as Page > Tab > Card, and each page's address is in");
  L.push("brackets, e.g. (/settings/branding). Support's tabs are /support/setup (Getting set up), /support/mine");
  L.push("(My Requests), /support/features, /support/fixes and /support/roadmap.");
  L.push("");
  L.push("## Pages in the left sidebar");
  L.push("Some pages are paid add-ons and show a padlock until bought (Settings > Billing). Pages marked");
  L.push("\"coming soon\" are not available yet.");
  L.push("");
  for (const p of pages) L.push(`- **${p.label}** (/${p.key}): ${p.desc}`);
  L.push("");
  L.push("## Settings");
  L.push("The Settings page has a rail of sections. Some sections are hubs with their own tabs, listed under them.");
  L.push("");
  const hubs = { company, colors, billing, pipelines: hub, options };
  for (const s of settings) {
    L.push(`- **${s.label}** (/settings/${s.slug}): ${s.desc}`);
    const kids = hubs[s.slug];
    if (!kids) continue;
    if (s.slug === "pipelines") {
      L.push("  (Customer Hub is being reworked; this list is as of the last knowledge build and may have moved.)");
    }
    let group = null;
    for (const k of kids) {
      if (k.group && k.group !== group) { group = k.group; L.push(`  - ${group}:`); }
      L.push(`${group ? "    " : "  "}- **${k.label}** (/settings/${k.slug}): ${k.desc}`);
    }
  }
  // Settings > Options has no rail entry of its own in some layouts; its tab list is always listed.
  if (!settings.some((s) => s.slug === "options")) {
    L.push("- **Options**");
    for (const k of options) L.push(`  - **${k.label}** (/settings/${k.slug}): ${k.desc}`);
  }
  L.push("");
  L.push("## Team access");
  L.push("Owners and admins add people in Settings > Company > Team. Each person has a job title, which sets");
  L.push("their starting access; an owner or admin can then change any area to None, View or Edit (some areas");
  L.push("also offer \"Own\": only that person's own customers or payouts). Owners always have everything.");
  L.push("");
  L.push("Job titles:");
  for (const t of jobTitles) L.push(`- **${t.label}**: ${t.blurb}`);
  L.push("");
  L.push("Access areas (what each switch on the Team page covers):");
  for (const a of areas) L.push(`- **${a.label}** (${a.group === "settings" ? "Settings" : "workspace"}): ${a.hint}`);
  L.push("");
  L.push("## The \"Getting set up\" checklist (Support > Getting set up)");
  L.push("A new account gets this ordered list. Steps for add-ons the builder has not bought show a padlock.");
  L.push("The account tool get_account_overview says which steps THIS builder still has open.");
  L.push("");
  let sec = null;
  for (const s of steps) {
    if (s.section !== sec) { sec = s.section; L.push(`### ${sec}`); }
    L.push(`- **${s.title}**: ${s.detail}`);
  }
  L.push("");
  return L.join("\n");
}

// A template literal, one source line per knowledge line, rather than one JSON string: a review
// diff then shows which line of the FAQ changed, and the file can be read (or pasted into a deploy)
// like the Markdown it came from. Backslashes, backticks and "${" are escaped so the literal holds
// exactly the text, whatever the FAQ grows to contain.
function knowledgeTs(kb, faq) {
  const text = `${kb.trimEnd()}\n\n${faq.trimEnd()}\n`;
  const literal = text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
  return [
    "// GENERATED by scripts/support-kb.mjs from kb.md and faq.md. Do not edit; rerun the script.",
    "// knowledge_test.ts fails when this string drifts from the two files.",
    `export const KNOWLEDGE = \`${literal}\`;`,
    "",
  ].join("\n");
}

function guard(text) {
  const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.exec(text);
  if (email) fail(`the knowledge contains an email address (${email[0]}); the repo is public`);
  const tokens = Math.ceil(text.length / CHARS_PER_TOKEN);
  if (tokens > MAX_TOKENS) fail(`the knowledge is about ${tokens} tokens, over the ${MAX_TOKENS} ceiling`);
  return tokens;
}

const kb = build();
const faq = read(FAQ_FILE);
const ts = knowledgeTs(kb, faq);
const tokens = guard(`${kb}\n${faq}`);

if (process.argv.includes("--check")) {
  const stale = [];
  if (read(KB_FILE) !== kb) stale.push(KB_FILE);
  if (read(TS_FILE) !== ts) stale.push(TS_FILE);
  if (stale.length) fail(`out of date: ${stale.join(", ")}. Run: node scripts/support-kb.mjs`);
  console.log(`support-kb: up to date (about ${tokens} tokens)`);
} else {
  writeFileSync(join(root, KB_FILE), kb);
  writeFileSync(join(root, TS_FILE), ts);
  console.log(`support-kb: wrote ${KB_FILE} and ${TS_FILE} (about ${tokens} tokens)`);
}
