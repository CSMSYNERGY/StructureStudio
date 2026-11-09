// jack-agent: running what a person approved, and putting it back (apply_test.ts).
//
// Jack saves through the same route a person's screen uses: portal-settings, called with the signed-in
// person's own token, so its gates, its checks and its audit rows all apply as they do by hand. Each
// edit names the version and the old value it was made against, so a box someone changed during the
// review is left alone and reported, which is what the sizes table does today.
//
// `call` is the one way out, handed in so the tests can stand in for portal-settings.

import { chunkEdits, type CreateLine, type EditLine, type Payload } from "./preview.ts";

export type PortalCall = (action: string, body: Record<string, unknown>) => Promise<{ status: number; data: Record<string, unknown> | null }>;

export interface Report { label: string; status: string; reason: string }
export interface UndoSize { id: string; label: string; base: string; from: Record<string, unknown>; to: Record<string, unknown> }
export interface UndoPlan { removes: { id: string; label: string; base: string }[]; sizes: UndoSize[]; fixtureId?: string; fixtureBase?: string | null }
export interface ApplyResult {
  created: number;
  saved: number;
  /** Everything that did not land, in plain words. */
  reports: Report[];
  undo: UndoPlan;
}

const REASONS: Record<string, string> = {
  conflict: "Someone else changed this size during the review, so it was left alone.",
  exists: "Someone else added this size during the review, so it was left alone.",
  missing: "This size isn't on the account any more.",
  refused: "The save was refused.",
  changed: "This size changed after the upload, so it was left as it is.",
  used: "Saved designs already use this size, so it stays on the account.",
  bom: "A Real-Time Pricing materials list uses this size, so it stays.",
};
const reason = (status: string, why?: unknown) => (typeof why === "string" && why ? why : REASONS[status] ?? "That didn't save.");

/** One save call, with one retry when the route itself failed. A 4xx is an answer, never retried. */
async function save(call: PortalCall, body: Record<string, unknown>): Promise<{ created: Answer[]; results: Answer[]; removed: Answer[]; error: string | null }> {
  let res = await call("save_pricing_cells", body);
  // A 200 with no readable body is an answer that got lost, the same as a dropped connection.
  if (res.status >= 500 || res.status === 0 || (res.status === 200 && !res.data)) {
    await new Promise((r) => setTimeout(r, 1500));
    res = await call("save_pricing_cells", body);
  }
  if (res.status !== 200 || !res.data) {
    const said = res.data && typeof res.data.error === "string" ? res.data.error : "The save didn't go through.";
    return { created: [], results: [], removed: [], error: said };
  }
  const list = (x: unknown) => (Array.isArray(x) ? x as Answer[] : []);
  return { created: list(res.data.created), results: list(res.data.results), removed: list(res.data.removed), error: null };
}

interface Answer {
  id: string;
  status: string;
  version?: string;
  reason?: string;
  code?: string;
  existingId?: string;
  gone?: boolean;
  row?: { active?: boolean };
  cellErrors?: Record<string, string>;
}

/** The boxes of one side of an edit that weren't refused. An undo entry only ever names what landed,
 *  or the version check would fail on the box that never moved, and Undo would blame someone else. */
function landedOnly(side: EditLine["to"], refused: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if ("price" in side && !("price" in refused)) out.price = side.price;
  const cells = Object.entries(side.cells ?? {}).filter(([k]) => !(k in refused));
  if (cells.length) out.cells = Object.fromEntries(cells);
  return out;
}

/** Runs a price change. Sizes are created first, because a size can't be created and priced in one
 *  call, then every edit goes in calls the route accepts. `onProgress` hears after each call, so what
 *  has landed so far (and how to put it back) survives a worker that dies part way. */
export async function applyPayload(call: PortalCall, payload: Payload, onProgress?: (sofar: ApplyResult) => Promise<void>): Promise<ApplyResult> {
  const reports: Report[] = [];
  const undo: UndoPlan = { removes: [], sizes: [] };
  let created = 0, saved = 0;
  const label = new Map<string, string>();
  for (const c of payload.creates) label.set(c.id, c.label);
  for (const s of payload.sizes) label.set(s.id, s.label);

  type Edit = EditLine & { isNew?: boolean };
  const edits: Edit[] = [...payload.sizes];
  const newLines = new Map(payload.creates.map((c) => [c.id, c]));

  for (const group of chunk(payload.creates, 50)) {
    const a = await save(call, { creates: group.map((c: CreateLine) => ({ id: c.id, styleId: c.styleId, width: c.width, length: c.length })) });
    if (a.error) {
      for (const c of group) reports.push({ label: c.label, status: "error", reason: a.error });
      await onProgress?.({ created, saved, reports, undo });
      continue;
    }
    for (const r of a.created) {
      const line = newLines.get(r.id);
      if (!line) continue;
      if ((r.status === "created" || r.status === "duplicate") && r.version) {
        created++;
        undo.removes.push({ id: r.id, label: line.label, base: r.version });
        const to: EditLine["to"] = {};
        const from: EditLine["from"] = {};
        if (line.price !== null) { to.price = line.price; from.price = null; }
        if (Object.keys(line.cells).length) {
          to.cells = line.cells;
          from.cells = Object.fromEntries(Object.keys(line.cells).map((k) => [k, 0]));
        }
        if (Object.keys(to).length) edits.push({ id: r.id, label: line.label, base: r.version, from, to, wasActive: false, isNew: true });
      } else {
        reports.push({ label: line.label, status: r.status, reason: reason(r.status, r.reason) });
      }
    }
    await onProgress?.({ created, saved, reports, undo });
  }

  for (const group of chunkEdits(edits)) {
    const a = await save(call, { sizes: group.map((e) => ({ id: e.id, base: e.base, from: e.from, to: e.to })) });
    if (a.error) {
      for (const e of group) reports.push({ label: e.label, status: "error", reason: a.error });
      await onProgress?.({ created, saved, reports, undo });
      continue;
    }
    const byId = new Map(group.map((e) => [e.id, e]));
    for (const r of a.results) {
      const e = byId.get(r.id);
      if (!e) continue;
      // `duplicate` is a save whose first answer got lost: the retry finds the new values already
      // there. It counts, and it gets an Undo line, the same as any other save.
      if (r.status === "saved" || r.status === "duplicate") {
        const refused = r.cellErrors ?? {};
        const refusedKeys = Object.keys(refused);
        const asked = [...("price" in e.to ? ["price"] : []), ...Object.keys(e.to.cells ?? {})];
        const allRefused = asked.length > 0 && asked.every((k) => k in refused);
        if (!allRefused) saved++;
        if (refusedKeys.length) {
          const said = reason("refused", refused[refusedKeys[0]]);
          reports.push(allRefused
            ? { label: e.label, status: "refused", reason: said }
            : { label: e.label, status: "partial", reason: `Saved, except ${refusedKeys.length} ${refusedKeys.length === 1 ? "box" : "boxes"}: ${said}` });
        }
        if (e.isNew) {
          const made = undo.removes.find((x) => x.id === e.id);
          if (made && r.version) made.base = r.version;
        } else if (r.version) {
          const from = landedOnly(e.to, refused);
          const to = landedOnly(e.from, refused);
          // Taking a price off hides a size, and putting one on shows it, whatever it was before. So
          // Undo says what it was, whenever the two could differ.
          if ("price" in to && (e.to.price === null || e.from.price === null)) {
            from.active = r.row?.active === true;
            to.active = e.wasActive && e.from.price !== null;
          }
          if (Object.keys(to).length) undo.sizes.push({ id: e.id, label: e.label, base: r.version, from, to });
        }
      } else {
        reports.push({ label: e.label, status: r.status, reason: reason(r.status, r.reason) });
      }
    }
    await onProgress?.({ created, saved, reports, undo });
  }
  return { created, saved, reports, undo };
}

/** Puts back what applyPayload did. Same checks: a size changed since is left alone and reported.
 *  `failed` counts lines the route never answered for. A person can press Undo again, and running the
 *  plan twice is safe: what already went back answers `duplicate`, and what is already off answers
 *  `removed`. */
export async function undoPayload(call: PortalCall, plan: UndoPlan): Promise<{ restored: number; removed: number; failed: number; reports: Report[] }> {
  const reports: Report[] = [];
  let restored = 0, removed = 0, failed = 0;
  for (const group of chunkEdits(plan.sizes.map((s) => ({ ...s, to: s.to as { cells?: Record<string, number> } })))) {
    const a = await save(call, { sizes: group.map((e) => ({ id: e.id, base: e.base, from: e.from, to: e.to })) });
    if (a.error) {
      failed += group.length;
      for (const e of group) reports.push({ label: e.label, status: "error", reason: a.error });
      continue;
    }
    const byId = new Map(group.map((e) => [e.id, e]));
    for (const r of a.results) {
      const e = byId.get(r.id);
      if (!e) continue;
      if (r.status === "saved" || r.status === "duplicate") {
        restored++;
        const n = Object.keys(r.cellErrors ?? {}).length;
        if (n) reports.push({ label: e.label, status: "partial", reason: `Put back, except ${n} ${n === 1 ? "box" : "boxes"} the server refused.` });
      } else {
        reports.push({ label: e.label, status: r.status, reason: reason(r.status, r.reason) });
      }
    }
  }
  for (const group of chunk(plan.removes, 50)) {
    const a = await save(call, { removes: group.map((x) => ({ id: x.id, base: x.base })) });
    if (a.error) {
      failed += group.length;
      for (const x of group) reports.push({ label: x.label, status: "error", reason: a.error });
      continue;
    }
    const byId = new Map(group.map((x) => [x.id, x]));
    for (const r of a.removed) {
      const x = byId.get(r.id);
      if (!x) continue;
      if (r.status === "removed") removed++;
      else reports.push({ label: x.label, status: r.code ?? r.status, reason: reason(r.code ?? r.status, r.reason) });
    }
  }
  return { restored, removed, failed, reports };
}

function chunk<T>(list: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}
