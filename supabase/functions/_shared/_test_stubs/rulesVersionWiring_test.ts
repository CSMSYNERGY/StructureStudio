// Automations are offered only when the SERVER says its database can store a rule of this shape.
//
// `crm_rules_list` computes `rulesVersion` from its own read: 0 when migration 355's tables are
// missing, 1 when 363's columns are, 2 when both are applied. That is a real state, because beta
// and production share ONE Supabase project and portal-settings goes live for both the moment it
// deploys. The browser tests it POSITIVELY (`rulesVersion >= SS_RULE_VERSION_MIN`), so the
// migration, the function and the bundle may go out in any order without an editor that cannot
// save.
//
// WHY THIS TEST EXISTS (2026-11-03, and still true): the old flag (`rulesReady`) was computed,
// documented and returned by readPipelines, and the crm_pipelines_list handler — which builds its
// response field by field rather than spreading — did not pass it on. To the browser that was
// indistinguishable from a database without rules, so the whole section was silently absent on
// beta while every unit test and every harness check passed: the harness stubs the server, so it
// proved the stub's shape, not the function's. This reads the shipped source instead.
//
// 2026-11-04 (migration 363): the rules moved off the pipelines read entirely (a rule may belong
// to no pipeline now, so grouping them by pipeline would drop it), onto their own action.
//
// Same technique as smsQuietHoursWiring_test: if an anchor moves, re-point it; do not delete it.

import { assert } from "jsr:@std/assert@1";

const FUNCTIONS = new URL("../../", import.meta.url);
const strip = (src: string) =>
  src.replace(/\r\n/g, "\n").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");

const settings = strip(await Deno.readTextFile(new URL("portal-settings/index.ts", FUNCTIONS)));
const sales = (await Deno.readTextFile(new URL("../../portal/02-sales.jsx", FUNCTIONS))).replace(/\r\n/g, "\n");

const handler = (name: string, next: string) => {
  const at = settings.indexOf(`if (action === "${name}")`);
  assert(at >= 0, `the ${name} handler moved; re-point this test`);
  const end = settings.indexOf(`if (action === "${next}")`, at);
  assert(end > at, `the handler after ${name} moved; re-point this test`);
  return settings.slice(at, end);
};

Deno.test("crm_rules_list computes rulesVersion from its own read, and a missing table or column is not a failure", () => {
  const body = handler("crm_rules_list", "crm_rule_save");
  assert(/const rulesVersion = /.test(body), "crm_rules_list no longer computes rulesVersion; re-point this test");
  assert(/RULES_MISSING_TABLE/.test(body) && /RULES_MISSING_COLUMN/.test(body),
    "the missing-table/column allowance is gone: a database without 355 or 363 would fail the read "
    + "and take Automations down for every tenant on beta AND production");
});

Deno.test("crm_rules_list SENDS rulesVersion — the 2026-11-03 bug, pinned", () => {
  const body = handler("crm_rules_list", "crm_rule_save");
  assert(/const base = \{[\s\S]*?\brulesVersion,[\s\S]*?\};/.test(body),
    "crm_rules_list does not send rulesVersion. The browser tests it positively, so omitting it hides "
    + "Automations entirely — exactly as if the migration were missing.");
});

Deno.test("the browser's test stays POSITIVE, so any order of deploys is safe", () => {
  assert(/const SS_RULE_VERSION_MIN = 2;/.test(sales), "SS_RULE_VERSION_MIN moved or changed; re-point this test");
  assert(/const rulesReady = rulesVersion >= SS_RULE_VERSION_MIN;/.test(sales),
    "the Automations gate is no longer `rulesVersion >= SS_RULE_VERSION_MIN`. A negative test treats a "
    + "function that predates 363 as ready, and offers an editor that cannot save.");
  assert(/\{!rulesReady && \(/.test(sales) && /data-ss-automations-unready/.test(sales),
    "the Automations page no longer says anything when the database cannot store a rule; a silent empty "
    + "page reads as broken, so re-point this test rather than deleting it");
  assert(/ssPipeCall\("crm_rules_list"\)/.test(sales), "AutomationsSettings no longer reads crm_rules_list; re-point this test");
});

Deno.test("the rules are NOT on the board's pipelines read any more", () => {
  // A rule may belong to every pipeline, or (round 2) to none; grouping them per pipeline would
  // silently drop those from the only page that edits them. And the board never read them.
  const body = handler("crm_pipelines_list", "crm_deals_list");
  assert(!/rulesReady|rules:/.test(body), "crm_pipelines_list carries rules again; they are crm_rules_list's");
  const at = settings.indexOf("const readPipelines = async");
  assert(at >= 0, "readPipelines moved; re-point this test");
  const rp = settings.slice(at, settings.indexOf("const writeRuleActions", at));
  assert(!/from\("crm_rules"\)/.test(rp), "readPipelines reads crm_rules again — every board open pays for it, and the grouping drops every-pipeline rules");
});

Deno.test("the list is gated like the rest of the rules, not like the board", () => {
  assert(/crm_rules_list:\s*\{\s*area:\s*"settings_crm",\s*level:\s*"view"\s*\}/.test(settings),
    "crm_rules_list is not settings_crm:view. The board's read is contacts:view, which a sales rep holds — "
    + "and a rep has no business reading the account's automations.");
});

// ⚠️ RULES RENDER IN EXACTLY ONE PLACE (Carolyn 2026-11-04 moved them to their own tab, then made it
// one flat list). The pipeline panel is reachable from the BOARD's "Edit stages" as well as from
// Settings — so a copy there would break her standing rule about settings living under Settings,
// and give one list two editors, which is how a saved rule shows up in one place and not the other.
Deno.test("the rules list is rendered by the Automations page and by nothing else", () => {
  const hosts = sales.match(/<SsRulesList/g) || [];
  assert(hosts.length === 1, `SsRulesList is rendered in ${hosts.length} places, expected exactly 1`);
  const at = sales.indexOf("function AutomationsSettings");
  assert(at >= 0, "AutomationsSettings moved; re-point this test");
  assert(sales.indexOf("<SsRulesList") > at,
    "SsRulesList is rendered outside AutomationsSettings — most likely back inside the pipeline panel");
  const ed = sales.slice(sales.indexOf("function SsPipelineEditor"), at);
  assert(!/<SsRulesList|<SsRuleEditor/.test(ed) && !/rulesVersion/.test(ed),
    "the pipeline panel carries rules again. They belong on Settings → Customer Hub → Automations.");
  assert(!/function SsPipeRules\(/.test(sales), "the per-pipeline rules list is back; there is one list now");
});
