// The Rules section is offered only when the SERVER says it can store a rule (2026-11-03).
//
// `readPipelines` computes `rulesReady` — false when migration 355 is not on the database it is
// talking to, which is a real state because beta and production share ONE Supabase project and
// portal-settings goes live for both the moment it deploys. The browser tests it POSITIVELY
// (`meta.rulesReady === true`), so the migration, the function and the bundle may go out in any
// order without a + Add rule that cannot save.
//
// WHY THIS TEST EXISTS: the field was computed, documented and returned by readPipelines, and the
// crm_pipelines_list handler — which builds its response field by field rather than spreading —
// did not pass it on. To the browser that is indistinguishable from a pre-355 database, so the
// whole section was silently absent on beta while every unit test and all 26 harness checks
// passed: the harness stubs the server, so it was proving the stub's shape, not the function's.
// A deploy is the only thing that could have caught it. This reads the shipped source instead.
//
// Same technique as smsQuietHoursWiring_test: if an anchor moves, re-point it; do not delete it.

import { assert } from "jsr:@std/assert@1";

const FUNCTIONS = new URL("../../", import.meta.url);
const strip = (src: string) =>
  src.replace(/\r\n/g, "\n").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");

const settings = strip(await Deno.readTextFile(new URL("portal-settings/index.ts", FUNCTIONS)));
const sales = (await Deno.readTextFile(new URL("../../portal/02-sales.jsx", FUNCTIONS))).replace(/\r\n/g, "\n");

Deno.test("readPipelines computes rulesReady, and does not fail the read on a missing table", () => {
  assert(/const rulesReady = /.test(settings), "readPipelines no longer computes rulesReady; re-point this test");
  assert(/MISSING_TABLE/.test(settings),
    "the missing-table allowance is gone: a pre-355 database would fail the whole pipelines read "
    + "and take Settings → Pipelines down for every tenant on beta AND production");
});

Deno.test("crm_pipelines_list passes rulesReady to the browser", () => {
  // The response object for that action, from its `ok: true` to the close of the json() call.
  const at = settings.indexOf('if (action === "crm_pipelines_list")');
  assert(at >= 0, "the crm_pipelines_list handler moved; re-point this test");
  const body = settings.slice(at, settings.indexOf('if (action === "crm_deals_list")', at));
  assert(/rulesReady:\s*r\.rulesReady/.test(body),
    "crm_pipelines_list does not send rulesReady. The browser tests it positively, so omitting it "
    + "hides the Rules section entirely — exactly as if migration 355 were missing.");
});

Deno.test("the browser's test stays POSITIVE, so any order of deploys is safe", () => {
  assert(/const rulesReady = !!\(meta && meta\.rulesReady === true\);/.test(sales),
    "the Automations gate is no longer `meta.rulesReady === true`. A negative test (`!== false`) treats a "
    + "function that predates rules as ready, and offers a + Add rule that cannot save.");
  assert(/\{!rulesReady && \(/.test(sales) && /data-ss-automations-unready/.test(sales),
    "the Automations page no longer says anything when the database cannot store a rule; a silent empty "
    + "page reads as broken, so re-point this test rather than deleting it");
});

// ⚠️ RULES RENDER IN EXACTLY ONE PLACE (Carolyn 2026-11-04 moved them to their own tab). They were
// a section of the pipeline panel for a day, and that panel is reachable from the BOARD's "Edit
// stages" as well as from Settings — so a copy there would both break her standing rule about
// settings living under Settings, and give one list two editors, which is how a saved rule shows
// up in one place and not the other.
Deno.test("the rules list is rendered by the Automations page and by nothing else", () => {
  const hosts = sales.match(/<SsPipeRules/g) || [];
  assert(hosts.length === 1, `SsPipeRules is rendered in ${hosts.length} places, expected exactly 1`);
  const at = sales.indexOf("function AutomationsSettings");
  assert(at >= 0, "AutomationsSettings moved; re-point this test");
  assert(sales.indexOf("<SsPipeRules") > at,
    "SsPipeRules is rendered outside AutomationsSettings — most likely back inside the pipeline panel");
  const ed = sales.slice(sales.indexOf("function SsPipelineEditor"), at);
  assert(!/<SsPipeRules/.test(ed) && !/rulesReady/.test(ed),
    "the pipeline panel carries rules again. They belong on Settings → Customer Hub → Automations.");
});
