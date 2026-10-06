// The Monday → tenant feedback reconcile, pinned against the SHIPPED handlers (2026-10-04).
//
// portal-feedback's `refresh` (the tenant's "Check for updates" button — the ONLY reconcile
// path that runs, since pg_cron is not installed) and feedback-monday-webhook's `sync_all` both
// ask Monday for a batch of items by id. Every way of breaking them is a short edit that throws
// nothing and passes every other test, and the failure is invisible: a status that never moves,
// a /client comment that can never be retracted. Same technique as quoteWriteRaceWiring_test:
// read the source, so a drift fails the push. If an anchor moves, re-point it — do not delete
// the test.

import { assert } from "jsr:@std/assert@1";

const FUNCTIONS = new URL("../../", import.meta.url);

/** Source with whole-line comments removed, so a comment that NAMES a trap cannot trip it.
 *  Line endings are normalised first: a Windows checkout (core.autocrlf) reads CRLF. */
const code = (src: string) => src.replace(/\r\n/g, "\n").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");

const FEEDBACK = code(await Deno.readTextFile(new URL("portal-feedback/index.ts", FUNCTIONS)));
const WEBHOOK = code(await Deno.readTextFile(new URL("feedback-monday-webhook/index.ts", FUNCTIONS)));

function block(src: string, start: string, end: string, label: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i + start.length);
  if (i < 0 || j < 0) {
    throw new Error(`feedbackSync_test: could not find the ${label} block (start=${i}, end=${j}). Re-point the anchors.`);
  }
  return src.slice(i, j);
}

const REFRESH = block(FEEDBACK, 'if (action === "refresh") {', 'return json({ ok: true, refreshed });', "portal-feedback refresh");
const SYNC_ALL = block(WEBHOOK, 'if (payload?.action === "sync_all") {', "return json({ ok: true, checked: rows.length", "webhook sync_all");

/** The row cap a handler reads before asking Monday (`.limit(N)` on feedback_submissions). */
function rowCap(src: string, label: string): number {
  const m = src.match(/\.from\("feedback_submissions"\)[\s\S]*?\.limit\((\d+)\)/);
  assert(m, `feedbackSync_test: no feedback_submissions .limit(N) in ${label} — re-point this test`);
  return Number(m[1]);
}

/** The `limit:` on Monday's `items (ids: …)` query, or 25 (Monday's default) when absent. */
function mondayItemsLimit(src: string, label: string): number {
  const m = src.match(/items\s*\(\s*ids:\s*\$ids([^)]*)\)/);
  assert(m, `feedbackSync_test: no Monday items(ids:) query in ${label} — re-point this test`);
  const lim = m[1].match(/limit:\s*(\d+)/);
  return lim ? Number(lim[1]) : 25;
}

// Monday's `items` query defaults to limit 25 EVEN WITH `ids`, returning the matches in
// ascending id order — so an uncapped query silently drops the NEWEST rows. Verified against
// the live API 2026-10-04 (30 ids in, 25 back; `limit: 100` returned all 30). 100 is Monday's
// maximum, so neither handler may read more rows than that.
for (const [label, src] of [["portal-feedback refresh", REFRESH], ["webhook sync_all", SYNC_ALL]] as const) {
  Deno.test(`${label}: Monday is asked for every row it read, not its default 25`, () => {
    const cap = rowCap(src, label);
    const lim = mondayItemsLimit(src, label);
    assert(lim >= cap, `${label} reads up to ${cap} submissions but asks Monday for only ${lim} items — the newest ${cap - lim} are never reconciled`);
    assert(cap <= 100, `${label} reads ${cap} rows; Monday returns at most 100 items per query`);
  });
}

// A /client REPLY is mirrored by the webhook under its OWN id (replyId). Both reconcile paths
// must read replies back, or a mirrored reply can never be edited or retracted: the webhook is
// not subscribed to edits, and `refresh` is the only reconcile that runs.
for (const [label, src] of [["portal-feedback refresh", REFRESH], ["webhook sync_all", SYNC_ALL]] as const) {
  Deno.test(`${label}: replies are fetched and reconciled like their parent updates`, () => {
    assert(/updates\s*\(limit:\s*\d+\)\s*\{[\s\S]*?replies\s*\{\s*id\s+text_body/.test(src),
      `${label} does not ask Monday for each update's replies`);
    assert(/for \(const node of \[u, \.\.\.\(u\.replies \?\? \[\]\)\]\)/.test(src),
      `${label} does not walk replies alongside their parent update`);
    assert(/\.delete\([^)]*\)\.eq\("monday_update_id", String\(node\.id\)\)/.test(src),
      `${label} does not retract an unmarked reply by its own id`);
    assert(/monday_update_id: String\(node\.id\)/.test(src),
      `${label} does not upsert a marked reply under its own id`);
  });
}
