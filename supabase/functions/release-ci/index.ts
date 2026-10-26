import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { withErrorLog } from "../_shared/logError.ts";
import { timingSafeEqual } from "../_shared/emailInbound.ts";
import { doneLabelIds, type PmColumn, statusColumnOf } from "../_shared/pmOverlay.ts";
import { propagateStatus } from "../_shared/pmStatus.ts";
import {
  builderNeedles, heldReason, isFullSha, namesBuilder, normTitle, parseReleaseTrailers, type ReleaseNote,
  uuidPrefixRange,
} from "../_shared/releaseTrailer.ts";

// release-ci: What's New entries and Projects "On Beta" moves, from the commits that land on beta.
//
// ══ THE RULE IT SERVES ══
// The words of a release note are always written by a PERSON, in the commit's `Release-note:`
// trailer (or by a hand INSERT for work with no commit). This function COPIES that trailer word for
// word into release_notes as status 'beta'. Nothing here generates, summarises or rewrites an entry:
// a trailer it cannot use as written is refused, and one that mentions pricing or names a builder is
// held for a person. The trailer format and the holds live in _shared/releaseTrailer.ts.
//
// ══ WHO CALLS IT ══
// .github/workflows/release-notes-on-beta.yml, on every push to beta, server to server. Never a
// browser (no CORS). verify_jwt = false (supabase/config.toml): GitHub cannot mint a Supabase JWT.
// The authentication is a shared secret in the `x-release-ci-key` HEADER (a header, not app-feedback's
// ?key=, so it stays out of URL logs) compared against RELEASE_CI_SECRET in constant time. An unset
// secret refuses everything: timingSafeEqual("", "") is TRUE, so the emptiness check is the real gate.
//
// ══ DARK BY DEFAULT ══ (one Supabase project serves beta AND production)
//   RELEASE_CI_SECRET      unset -> every call is 401.
//   RELEASE_CI_WRITES=1    the ONLY way anything is written. Unset (or a request with dryRun: true)
//                          means a dry run: the same reads and decisions, reported, nothing written.
//                          Every write goes through a write*() function whose first line is
//                          mustWrite(ctx); _test_stubs/releaseCiWiring_test.ts fails the push if a
//                          write appears anywhere else.
//   RELEASE_CI_MOVE_ITEMS=1  additionally lets `Projects:` refs move items (on_beta) and promotion
//                          move them on (released). Unset: notes only; item decisions are reported.
//
// ══ ACTIONS ══
//   on_beta  { commits: [{ sha, message }] }  at most 200, OLDEST FIRST (git log --reverse), so the
//            last activity recorded for an item is its newest commit. Per commit, one of:
//              inserted            the note was copied (or WOULD be, when dryRun / writes off)
//              exists              a note already carries this commit's sha (a re-run, a retry)
//              duplicate_title     a note with the same words already exists (a cherry-pick, or
//                                  someone wrote it by hand / another automation is still writing).
//                                  `why` says whether that row is a ROADMAP entry (roadmap /
//                                  planned / requested): a person then moves that row to beta by
//                                  hand (103's one line), rather than a second entry appearing.
//              held_commercial     the note mentions pricing or money: a person decides
//              held_names_builder  the note names a builder: a person decides. WHICH builder is
//                                  never returned: this response is printed to PUBLIC Actions logs
//              refused             the trailer cannot be used as written (the reason is a fixed
//                                  sentence; the text is never echoed)
//              none                no Release-note trailer, or `Release-note: none`
//            plus `newSection: true` on an inserted note whose Release-section no note has used
//            before (copied as written; flagged so a misspelt chip is seen in the run summary),
//            and per `Projects:` ref: moved | already_on_beta | exists (this commit already moved it) |
//            done_already | archived | not_found | ambiguous | no_onbeta_label | changed_meanwhile.
//            A moved item goes to l_onbeta through the shared propagateStatus (a linked builder
//            sees "In progress"), gets a pm_activity row `release_ci_on_beta` carrying the full sha,
//            and an internal note "On beta in <sha7>".
//   released { mergedShas: [...] }  the commits a promotion carried (the caller lists them). Moves an
//            item from l_onbeta to l_done ONLY when the newest commit that put it there is among
//            them, so an unshipped fix is never announced "Completed". Items set On Beta by hand,
//            or by a commit the promotion did not carry, stay where they are and are counted.
//            Per item: moved | not_in_merge | set_by_hand | no_done_label | changed_meanwhile.
//   changed_meanwhile: a person changed the item between release-ci's read and its write (writeMove
//            re-reads, then compare-and-swaps on updated_at). Nothing was written; their edit stands.
//   Results say what was DECIDED; `dryRun` and `moves` in the response say whether it was written.
//   Titles, item names and builder names never appear in a response.
//
// ══ IDS IT RELIES ON ══ l_onbeta and l_done on the bugs, features and working boards (migration
// 293's one list). If a board lacks one, the item is reported (no_onbeta_label / no_done_label)
// and nothing is guessed. release_notes.source_commit is migration 294.

const ON_BETA = "l_onbeta";
const DONE = "l_done";
const BOARDS = ["bugs", "features", "working"];
const MAX_COMMITS = 200;
const MAX_MESSAGE = 20_000;
const MAX_MERGED = 5_000;
const ACTOR = "release-ci";
// release_notes statuses that are the ROADMAP (045/103), not a published note.
const ROADMAP_STATUSES = new Set(["roadmap", "planned", "requested"]);
const PAGE = 1000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// deno-lint-ignore no-explicit-any
type Admin = any;
type Ctx = { admin: Admin; dryRun: boolean; moves: boolean };
// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;
type Board = { id: string; slug: string; columns: PmColumn[]; status: PmColumn | null };

/** The writes gate. Every write*() below calls this first; nothing else in this file writes. */
function mustWrite(ctx: Ctx) {
  if (ctx.dryRun) throw new Error("release-ci: a write was attempted in a dry run");
}

// ── Writes (and only here) ───────────────────────────────────────────────────────────────

async function writeActivity(ctx: Ctx, boardId: string | null, itemId: string | null, action: string, detail: Record<string, unknown> = {}) {
  mustWrite(ctx);
  const { error } = await ctx.admin.from("pm_activity").insert({
    board_id: boardId, item_id: itemId, actor_user_id: null, actor_email: ACTOR, action, detail,
  });
  if (error) throw error;
}

/** Copy one person-written note. kind/title/detail come from parseReleaseTrailers, untouched. */
async function writeNote(ctx: Ctx, sha: string, note: ReleaseNote, section: string | null): Promise<"inserted" | "exists"> {
  mustWrite(ctx);
  const { error } = await ctx.admin.from("release_notes").insert({
    kind: note.kind,
    title: note.title,
    detail: note.detail,
    section: section ?? "",
    status: "beta",
    source_commit: sha,
  });
  if (error) {
    if (error.code === "23505") return "exists";   // a concurrent delivery of the same push won
    throw error;
  }
  return "inserted";
}

/** Move one item to `to` through the shared propagateStatus, then record the activity row that
 *  makes the move idempotent (moveRef's `exists`) and that `released` reads back, then the note.
 *
 *  RE-READ AND COMPARE-AND-SWAP. The caller decided on a snapshot that can be seconds old by now
 *  (`released` walks every On Beta item, several round trips each), and writing `values` back from
 *  it would silently undo an operator's edit to any other column. So the item is read again here,
 *  the move goes ahead only if its status is still the one the caller decided on, and the update
 *  is guarded on updated_at, which every pm_items values writer bumps (portal-projects update_item
 *  and its label reassign): the customer-accept / portal-settings casUpdatedAt idiom. Anything that
 *  changed answers "changed_meanwhile" with nothing written.
 *
 *  ORDER: item, builder mirror, activity row, internal note. The activity row is the idempotency
 *  key, so it goes straight after the move: a failure before it leaves neither key nor note, and
 *  re-running the workflow run finds the item already On Beta, writes nothing to it again, and
 *  records the key and the note once (`already_on_beta`). A failure after the key costs only the
 *  internal note. (Activity last left a moved item with no key: `released` then called it
 *  set_by_hand forever, and a re-run added a second note.) */
async function writeMove(
  ctx: Ctx, item: Row, board: Board, to: string, sha: string, action: "release_ci_on_beta" | "release_ci_released",
): Promise<"written" | "changed_meanwhile"> {
  mustWrite(ctx);
  const col = board.status!;
  const { data: rows, error: rErr } = await ctx.admin.from("pm_items")
    .select("id, board_id, values, feedback_submission_id, archived_at, updated_at").eq("id", item.id).limit(1);
  if (rErr) throw rErr;
  const fresh = rows?.[0];
  const decidedOn = (item.values || {})[col.id];
  if (!fresh || fresh.archived_at || (fresh.values || {})[col.id] !== decidedOn) return "changed_meanwhile";
  const oldValues = (fresh.values || {}) as Record<string, unknown>;
  if (oldValues[col.id] !== to) {
    const newValues = { ...oldValues, [col.id]: to };
    let write = ctx.admin.from("pm_items").update({ values: newValues, updated_at: new Date().toISOString() }).eq("id", fresh.id);
    write = fresh.updated_at ? write.eq("updated_at", fresh.updated_at) : write.is("updated_at", null);
    const { data: wrote, error } = await write.select("id");
    if (error) throw error;
    if (!Array.isArray(wrote) || wrote.length !== 1) return "changed_meanwhile";
    await propagateStatus(ctx.admin, (b, i, a, d) => writeActivity(ctx, b, i, a, d), fresh, board.columns, newValues, oldValues);
  }
  await writeActivity(ctx, fresh.board_id, fresh.id, action, { sha, to });
  const { error: uErr } = await ctx.admin.from("pm_updates").insert({
    item_id: fresh.id, author_email: ACTOR, client_visible: false, attachments: [],
    body: `${to === ON_BETA ? "On beta" : "Released"} in ${sha.slice(0, 7)}`,
  });
  if (uErr) throw uErr;
  return "written";
}

// ── Reads ────────────────────────────────────────────────────────────────────────────────

/** Every row of a query, a page at a time (PostgREST caps one read at 1000 rows, silently). */
async function readAll(build: (from: number, to: number) => PromiseLike<{ data: Row[] | null; error: unknown }>): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

async function loadBoards(admin: Admin): Promise<Map<string, Board>> {
  const { data: boards, error } = await admin.from("pm_boards").select("id, slug").in("slug", BOARDS);
  if (error) throw error;
  const out = new Map<string, Board>();
  for (const b of boards || []) {
    const { data: columns, error: cErr } = await admin.from("pm_columns").select("*").eq("board_id", b.id).order("position");
    if (cErr) throw cErr;
    out.set(b.id, { id: b.id, slug: b.slug, columns: columns || [], status: statusColumnOf(columns || []) });
  }
  return out;
}

function hasLabel(col: PmColumn | null, id: string): boolean {
  const labels = (col?.settings as { labels?: Array<{ id?: string } | null> } | undefined)?.labels;
  return Array.isArray(labels) && labels.some((l) => l?.id === id);
}

/** Builders a note must not name: every tenant except our own (169's internal_account). */
async function loadNeedles(admin: Admin): Promise<string[]> {
  const settings = await readAll((a, b) => admin.from("client_settings").select("client_id, business_name, internal_account").order("client_id").range(a, b));
  const configs = await readAll((a, b) => admin.from("client_configs").select("client_id, company_name").order("client_id").range(a, b));
  const internal = new Set(settings.filter((s) => s.internal_account === true).map((s) => String(s.client_id)));
  const names = new Map<string, string[]>();
  for (const s of settings) if (!internal.has(String(s.client_id))) names.set(String(s.client_id), [s.business_name]);
  for (const c of configs) {
    if (internal.has(String(c.client_id))) continue;
    names.set(String(c.client_id), [...(names.get(String(c.client_id)) || []), c.company_name]);
  }
  return builderNeedles([...names].map(([client_id, n]) => ({ client_id, names: n })));
}

// ── on_beta ──────────────────────────────────────────────────────────────────────────────

type RefResult =
  | "moved" | "already_on_beta" | "exists" | "done_already" | "archived" | "not_found" | "ambiguous" | "no_onbeta_label"
  | "changed_meanwhile";
type CommitResult = "inserted" | "exists" | "duplicate_title" | "held_commercial" | "held_names_builder" | "refused" | "none";

async function onBeta(ctx: Ctx, commits: Array<{ sha: string; message: string }>) {
  const { admin } = ctx;
  const notes = await readAll((a, b) => admin.from("release_notes").select("id, title, section, status, source_commit").order("id").range(a, b));
  const knownShas = new Set(notes.map((n) => n.source_commit).filter(Boolean));
  // title -> "roadmap" when every row with those words is a roadmap entry, else "note".
  const knownTitles = new Map<string, "note" | "roadmap">();
  for (const n of notes) {
    const t = normTitle(n.title);
    if (knownTitles.get(t) !== "note") knownTitles.set(t, ROADMAP_STATUSES.has(n.status) ? "roadmap" : "note");
  }
  // An existing section's spelling wins when only the case differs, so the Support page's chips
  // (rendered upper-case, grouped by exact value) stay one group. The person's word is kept.
  const sectionSpelling = new Map<string, string>();
  for (const n of notes) {
    const s = String(n.section || "").trim();
    if (s && !sectionSpelling.has(s.toLowerCase())) sectionSpelling.set(s.toLowerCase(), s);
  }
  const sectionsBefore = new Set(sectionSpelling.keys());
  const needles = await loadNeedles(admin);
  const boards = await loadBoards(admin);
  const boardIds = [...boards.keys()];

  const results: Array<{
    sha: string; result: CommitResult; why?: string; kind?: string; newSection?: true;
    refs: Array<{ ref: string; result: RefResult }>; badRefs?: number;
  }> = [];
  for (const c of commits) {
    const sha = c.sha;
    const parsed = parseReleaseTrailers(c.message);
    const r: (typeof results)[number] = { sha: sha.slice(0, 7), result: "none", refs: [] };
    if (parsed.badProjects) r.badRefs = parsed.badProjects;

    if (knownShas.has(sha)) {
      r.result = "exists";
    } else if (parsed.refused) {
      r.result = "refused";
      r.why = parsed.refused;
    } else if (parsed.note === null || parsed.note === "none") {
      r.result = "none";
      r.why = parsed.note === "none" ? "Release-note: none" : "no Release-note trailer";
    } else {
      const note = parsed.note;
      // Every word that would be published: title, detail AND section. A hold that read only the
      // title would publish a builder's name or a price written in the detail line.
      const text = [note.title, note.detail || "", note.section || ""].join(" \n ");
      const held = heldReason(text);
      r.kind = note.kind;
      if (held) {
        r.result = "held_commercial";
        r.why = held;
      } else if (namesBuilder(text, needles)) {
        r.result = "held_names_builder";
        r.why = "names a builder";
      } else if (knownTitles.has(normTitle(note.title))) {
        r.result = "duplicate_title";
        r.why = knownTitles.get(normTitle(note.title)) === "roadmap"
          ? "the same words as a roadmap entry: a person moves that entry to beta"
          : "the same words as an existing note";
      } else {
        const section = note.section ? (sectionSpelling.get(note.section.toLowerCase()) ?? note.section) : null;
        r.result = ctx.dryRun ? "inserted" : await writeNote(ctx, sha, parsed.note, section);
        if (section && !sectionsBefore.has(section.toLowerCase())) r.newSection = true;
        if (section && !sectionSpelling.has(section.toLowerCase())) sectionSpelling.set(section.toLowerCase(), section);
        knownTitles.set(normTitle(note.title), "note");
        knownShas.add(sha);
      }
    }

    for (const ref of parsed.projects) {
      r.refs.push({ ref, result: await moveRef(ctx, boards, boardIds, ref, sha) });
    }
    results.push(r);
  }

  const counts: Record<string, number> = {};
  for (const r of results) counts[r.result] = (counts[r.result] || 0) + 1;
  return { commits: results, counts };
}

async function moveRef(ctx: Ctx, boards: Map<string, Board>, boardIds: string[], ref: string, sha: string): Promise<RefResult> {
  const range = uuidPrefixRange(ref);
  if (!range || !boardIds.length) return "not_found";
  // A uuid range, because PostgREST cannot `like` a uuid column; two hits means the prefix is too
  // short to say which item, and guessing would move the wrong one.
  const { data, error } = await ctx.admin.from("pm_items")
    .select("id, board_id, values, feedback_submission_id, archived_at")
    .in("board_id", boardIds).gte("id", range.lo).lte("id", range.hi).order("id").limit(2);
  if (error) throw error;
  if (!data || !data.length) return "not_found";
  if (data.length > 1) return "ambiguous";
  const item = data[0];
  if (item.archived_at) return "archived";
  const board = boards.get(item.board_id)!;
  if (!board.status || !hasLabel(board.status, ON_BETA)) return "no_onbeta_label";
  const current = (item.values || {})[board.status.id];
  if (typeof current === "string" && doneLabelIds(board.status).has(current)) return "done_already";
  // THIS commit already moved this item (a re-run of the workflow, a retried push): nothing more,
  // and never back onto On Beta if a person has moved it on since.
  const { data: seen, error: sErr } = await ctx.admin.from("pm_activity").select("id")
    .eq("item_id", item.id).eq("action", "release_ci_on_beta").eq("detail->>sha", sha).limit(1);
  if (sErr) throw sErr;
  if (seen && seen.length) return "exists";
  const result: RefResult = current === ON_BETA ? "already_on_beta" : "moved";
  // Already on beta still records THIS commit, so promotion waits for the newest one.
  let wrote = "decided";
  if (ctx.moves && !ctx.dryRun) wrote = await writeMove(ctx, item, board, ON_BETA, sha, "release_ci_on_beta");
  return wrote === "changed_meanwhile" ? "changed_meanwhile" : result;
}

// ── released ─────────────────────────────────────────────────────────────────────────────

type ReleasedResult = "moved" | "not_in_merge" | "set_by_hand" | "no_done_label" | "changed_meanwhile";

async function released(ctx: Ctx, merged: Set<string>) {
  const { admin } = ctx;
  const boards = await loadBoards(admin);
  const onBeta: Row[] = [];
  for (const board of boards.values()) {
    if (!board.status || !hasLabel(board.status, ON_BETA)) continue;
    const items = await readAll((a, b) => admin.from("pm_items")
      .select("id, board_id, values, feedback_submission_id").eq("board_id", board.id).is("archived_at", null).order("id").range(a, b));
    for (const it of items) if ((it.values || {})[board.status.id] === ON_BETA) onBeta.push(it);
  }
  // The NEWEST commit that put each item on beta (pm_activity.id is a bigserial: strictly ordered).
  const latest = new Map<string, string>();
  // 100 ids per `.in()`: each is ~37 characters of URL, and 200 came to ~7.5 KB.
  for (let i = 0; i < onBeta.length; i += 100) {
    const ids = onBeta.slice(i, i + 100).map((it) => it.id);
    const acts = await readAll((a, b) => admin.from("pm_activity").select("id, item_id, detail")
      .eq("action", "release_ci_on_beta").in("item_id", ids).order("id", { ascending: false }).range(a, b));
    for (const a of acts) {
      const s = a.detail?.sha;
      if (!latest.has(a.item_id) && typeof s === "string") latest.set(a.item_id, s);
    }
  }
  const items: Array<{ item: string; result: ReleasedResult }> = [];
  for (const it of onBeta) {
    const board = boards.get(it.board_id)!;
    const sha = latest.get(it.id);
    let result: ReleasedResult;
    if (!sha) result = "set_by_hand";
    else if (!merged.has(sha)) result = "not_in_merge";
    else if (!doneLabelIds(board.status).has(DONE)) result = "no_done_label";
    else {
      result = "moved";
      let wrote = "decided";
      if (ctx.moves && !ctx.dryRun) wrote = await writeMove(ctx, it, board, DONE, sha, "release_ci_released");
      if (wrote === "changed_meanwhile") result = "changed_meanwhile";
    }
    items.push({ item: String(it.id).slice(0, 8), result });
  }
  const counts: Record<string, number> = {};
  for (const r of items) counts[r.result] = (counts[r.result] || 0) + 1;
  return { onBeta: onBeta.length, items, counts };
}

// ── The door ─────────────────────────────────────────────────────────────────────────────

Deno.serve(withErrorLog("release-ci", async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const secret = Deno.env.get("RELEASE_CI_SECRET") ?? "";
  const key = req.headers.get("x-release-ci-key") ?? "";
  if (!secret || !timingSafeEqual(key, secret)) return json({ error: "unauthorized" }, 401);

  // deno-lint-ignore no-explicit-any
  let payload: any;
  try { payload = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const action = String(payload?.action || "");

  const writes = Deno.env.get("RELEASE_CI_WRITES") === "1";
  const dryRun = !writes || payload?.dryRun === true;
  const moves = Deno.env.get("RELEASE_CI_MOVE_ITEMS") === "1";
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const ctx: Ctx = { admin, dryRun, moves };

  if (action === "on_beta") {
    const raw = payload?.commits;
    if (!Array.isArray(raw) || raw.length > MAX_COMMITS) {
      return json({ error: `commits must be an array of at most ${MAX_COMMITS} { sha, message }.` }, 400);
    }
    const commits: Array<{ sha: string; message: string }> = [];
    const seen = new Set<string>();
    for (const c of raw) {
      if (!c || !isFullSha(c.sha) || typeof c.message !== "string") {
        return json({ error: "Every commit needs a full lowercase sha and a message string." }, 400);
      }
      if (seen.has(c.sha)) continue;   // the same commit twice in one call is one commit
      seen.add(c.sha);
      commits.push({ sha: c.sha, message: c.message.slice(0, MAX_MESSAGE) });
    }
    return json({ ok: true, action, dryRun, writes, moves, ...(await onBeta(ctx, commits)) });
  }

  if (action === "released") {
    const raw = payload?.mergedShas;
    if (!Array.isArray(raw) || raw.length > MAX_MERGED || !raw.every(isFullSha)) {
      return json({ error: `mergedShas must be an array of at most ${MAX_MERGED} full lowercase shas.` }, 400);
    }
    return json({ ok: true, action, dryRun, writes, moves, ...(await released(ctx, new Set(raw as string[]))) });
  }

  return json({ error: `Unknown action "${action.slice(0, 40)}".` }, 400);
}));
