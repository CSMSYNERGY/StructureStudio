// jack-agent: insulation prices (insulation_test.ts). Carolyn, 11-09 call: "change my price of spray foam to
// $2.80" got "spray foam isn't one of your option columns" and a button to the wrong tab (Interior items).
//
// Insulation is its own tab, Settings > Options > Insulation: a grid of rates per square foot, batt, spray
// foam and rigid foam across floor, walls and roof (portal-settings save_insulation, migration 177/272). A
// blank cell is "not offered". The master switch (client_settings.insulation_enabled) is the page's, never
// Jack's.
//
// THE RULES
//   - A tool reads, or writes ONE card. Only Approve saves, through save_insulation with the person's own
//     token, and only the cells on the card. The switch is never sent, so it can't move.
//   - save_insulation writes taxable, active and internal-only on every row it's sent, with "yes, yes, no"
//     for a key left out. So each cell goes with the values it has right now, read again at the press.
//   - Before saving, every cell is read again. If one moved since the card was made, nothing is saved and
//     the card says to ask again.
//   - Undo puts a rate back only while it still holds what Jack saved. A cell Jack started offering is
//     blanked again (not offered), as the page does with a cleared cell.
//   - A correction is a new card: the older insulation card still waiting in this chat is put away.

import type { ApplyOutcome, Deps, KindSpec, Piece, ProposalRow, ToolSpec, UndoOutcome } from "./types.ts";
import { err, ok, putCard, SAID, saidBy } from "./common.ts";
import { replaceOlder } from "./drafts.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

export const INSULATION_KIND = "insulation_price";
/** The price switch: an insulation rate is a price, as a size's base price is. */
const PRICES_SWITCH = "prices";
const AREA = "settings_options";
export const WHERE = "Settings > Options > Insulation";
const ROUTE = { page: "settings", sub: "insulation" };

export const TYPES = ["batt", "spray_foam", "rigid_foam"] as const;
export const AREAS = ["floor", "walls", "roof"] as const;
type InsType = typeof TYPES[number];
type InsArea = typeof AREAS[number];
const TYPE_WORD: Record<InsType, string> = { batt: "Batt", spray_foam: "Spray foam", rigid_foam: "Rigid foam" };
/** A rate per square foot no insulation could have. The page itself takes any number of zero or more. */
const MAX_RATE = 1000;
export const INSULATION_REPLACED = "Replaced by your newer insulation card.";

export interface Cell { type: InsType; area: InsArea; rate: number | null; taxable: boolean; active: boolean; internalOnly: boolean }
interface CardCell { type: InsType; area: InsArea; from: number | null; to: number }

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} a sq ft`;
const label = (c: { type: InsType; area: InsArea }) => `${TYPE_WORD[c.type]}, ${c.area}`;
const key = (c: { type: string; area: string }) => `${c.type}/${c.area}`;
/** Two rates are the same to the cent: the column is numeric, and a float read back can carry noise. */
const sameRate = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.round(a * 100) === Math.round(b * 100));
const landed = (r: { status: number; data: Record<string, unknown> | null }) => r.status === 200 && !!r.data && r.data.ok !== false;
const unsure = (r: { status: number }) => r.status === 0 || r.status >= 500;

/** The grid as it is now, from the page's own catalog read. Every cell of the grid is in it; a cell with no
 *  row is not offered (rate null). */
export async function readGrid(deps: Deps): Promise<{ cells: Cell[]; enabled: boolean } | { error: string }> {
  const r = await deps.portal("catalog", {});
  if (r.status === 403) return { error: SAID.noSee };
  if (r.status !== 200 || !r.data || !Array.isArray(r.data.insulation)) return { error: SAID.readFailed };
  const rows = r.data.insulation as Any[];
  const cells: Cell[] = [];
  for (const type of TYPES) {
    for (const area of AREAS) {
      const row = rows.find((x) => x && x.ins_type === type && x.area === area);
      const rate = row ? Number(row.rate_per_sqft) : NaN;
      cells.push({
        type, area,
        rate: row && Number.isFinite(rate) ? rate : null,
        taxable: row ? row.taxable !== false : true,
        // A type's on/off is written to its three areas alike (the page's own rule), so a new cell takes
        // the type's switch from a sibling that has one.
        active: row ? row.active !== false : (rows.find((x) => x && x.ins_type === type)?.active ?? true) !== false,
        internalOnly: row ? row.internal_only === true : false,
      });
    }
  }
  return { cells, enabled: r.data.insulationEnabled === true };
}

const lookTool: ToolSpec = {
  def: {
    name: "look_at_my_insulation",
    description: `Read this builder's insulation rates per square foot (${WHERE}): batt, spray foam and rigid foam, each on the floor, walls and roof. A cell with no rate isn't offered. Use it before proposing an insulation price, and whenever they ask about insulation. Insulation is not an add-on item or an option column.`,
    strict: true,
    input_schema: { type: "object", additionalProperties: false, required: [], properties: {} },
  },
  needs: [{ area: AREA, level: "view" }],
  async run(deps) {
    const g = await readGrid(deps);
    if ("error" in g) return err(g.error);
    return ok({
      offeredToCustomers: g.enabled,
      rates: g.cells.map((c) => ({ type: c.type, area: c.area, perSqFt: c.rate, offered: c.rate !== null && c.active, ...(c.internalOnly ? { teamOnly: true } : {}) })),
      note: `Rates are dollars per square foot. When a type's areas have different rates and they name only the type ("spray foam to $2.80"), ask which areas: floor, walls, roof, or all of them.${g.enabled ? "" : " Insulation is switched off for customers on this account."}`,
    });
  },
};

const proposeTool: ToolSpec = {
  def: {
    name: "propose_insulation_prices",
    description: `Put a preview on the person's screen that changes insulation rates per square foot on ${WHERE}. It changes nothing: the person presses Approve. Each change is a type, an area (floor, walls, roof, or all for every area that type is offered on now) and the new rate in dollars a square foot, from what they told you. Read look_at_my_insulation first; if the type's areas have different rates and they didn't say which, ask. To change a card you made, call this again: the new card replaces the old one.`,
    strict: true,
    input_schema: {
      type: "object", additionalProperties: false, required: ["changes"],
      properties: {
        changes: {
          type: "array",
          items: {
            type: "object", additionalProperties: false, required: ["type", "area", "ratePerSqFt"],
            properties: {
              type: { type: "string", enum: [...TYPES] },
              area: { type: "string", enum: [...AREAS, "all"] },
              ratePerSqFt: { type: "number", description: "Dollars per square foot, e.g. 2.8." },
            },
          },
        },
      },
    },
  },
  needs: [{ area: AREA, level: "edit" }],
  switchKey: PRICES_SWITCH,
  proposesChange: true,
  async run(deps, s, input) {
    const asked = Array.isArray((input as Any)?.changes) ? (input as Any).changes as Any[] : [];
    if (!asked.length) return err("No changes were given.");
    if (asked.length > 12) return err("That's more changes than the grid has. Name each type and area once.");
    const g = await readGrid(deps);
    if ("error" in g) return err(g.error);
    // Later lines win, so "all spray foam $2.80, roof $3" is two lines with the roof last.
    const want = new Map<string, CardCell>();
    for (const a of asked) {
      const type = String(a?.type ?? "") as InsType;
      const area = String(a?.area ?? "");
      const rate = Number(a?.ratePerSqFt);
      if (!TYPES.includes(type)) return err("Say batt, spray foam or rigid foam.");
      if (area !== "all" && !(AREAS as readonly string[]).includes(area)) return err("Say floor, walls, roof, or all.");
      if (!Number.isFinite(rate) || rate < 0) return err("A rate needs to be a dollar amount of zero or more a square foot.");
      if (!(rate < MAX_RATE)) return err(`That rate looks off for insulation. It needs to be under $${MAX_RATE.toLocaleString("en-US")} a square foot. Check the number with them.`);
      const ofType = g.cells.filter((c) => c.type === type);
      const offered = ofType.filter((c) => c.rate !== null);
      // "all" is the areas offered now; a type offered nowhere yet is all three.
      const areas = area === "all" ? (offered.length ? offered : ofType).map((c) => c.area) : [area as InsArea];
      for (const ar of areas) {
        const now = g.cells.find((c) => c.type === type && c.area === ar)!;
        want.set(key({ type, area: ar }), { type, area: ar, from: now.rate, to: Math.round(rate * 100) / 100 });
      }
    }
    const cells = [...want.values()].filter((c) => !sameRate(c.from, c.to));
    if (!cells.length) return err("Those rates are already set, so nothing would change.");
    cells.sort((a, b) => TYPES.indexOf(a.type) - TYPES.indexOf(b.type) || AREAS.indexOf(a.area) - AREAS.indexOf(b.area));

    const notes: string[] = [];
    const fresh = cells.filter((c) => c.from === null);
    if (fresh.length) notes.push(`Customers will be offered ${fresh.map((c) => `${TYPE_WORD[c.type].toLowerCase()} on the ${c.area}`).join(", ")}, which isn't offered now.`);
    const off = [...new Set(cells.filter((c) => !g.cells.find((x) => x.type === c.type && x.area === c.area)!.active).map((c) => TYPE_WORD[c.type]))];
    if (off.length) notes.push(`${off.join(" and ")} is turned off for customers on ${WHERE}. The rate is saved, but they won't see it until it's turned on.`);
    if (!g.enabled) notes.push(`Insulation is switched off for customers right now. Turn it on at ${WHERE}.`);

    const title = cells.length === 1 ? `Insulation: ${label(cells[0])} to ${money(cells[0].to)}` : `Insulation prices: ${[...new Set(cells.map((c) => TYPE_WORD[c.type].toLowerCase()))].join(", ")}`;
    const card = await putCard(deps, s, {
      kind: INSULATION_KIND, title,
      preview: {
        lines: cells.map((c) => ({ label: label(c), from: c.from === null ? "" : money(c.from), to: money(c.to) })),
        notes, ticks: [], where: WHERE, route: ROUTE,
      },
      payload: { cells },
    });
    const { replaced, replacedByNewer, yielded, unchecked } = await replaceOlder(deps, s, card, (p) => p.kind === INSULATION_KIND, INSULATION_REPLACED);
    if (replacedByNewer) return ok({ shown: true, putAway: true, note: "A newer insulation card, made at the same time, replaces this one. Tell them only about the newer card." });
    if (yielded || unchecked) {
      return ok({ shown: true, putAway: true, note: yielded
        ? "Their earlier insulation card was being saved at that moment, so this one was put away. Tell them in a sentence, and to ask again once it has saved."
        : "The earlier insulation card couldn't be checked, so this one was put away to keep two versions from both being approved. Tell them to cancel the earlier card and ask again." });
    }
    return ok({
      shown: true, changing: cells.map((c) => ({ type: c.type, area: c.area, from: c.from, to: c.to })),
      ...(replaced ? { replacedOlderCard: true } : {}),
      note: `${SAID.onScreenApprove}${replaced ? " It replaces their earlier insulation card, which is put away." : ""}`,
    });
  },
};

/** The rows save_insulation is sent: each cell's new rate, and its taxable, on/off and team-only as they
 *  are now, so the save changes only the rate. A null rate blanks the cell (not offered). */
function rowsFor(set: { type: InsType; area: InsArea; rate: number | null }[], grid: Cell[]) {
  return set.map((c) => {
    const now = grid.find((x) => x.type === c.type && x.area === c.area)!;
    return { type: c.type, area: c.area, ratePerSqft: c.rate === null ? "" : String(c.rate), taxable: now.taxable, active: now.active, internalOnly: now.internalOnly };
  });
}

async function applyInsulation(deps: Deps, p: ProposalRow): Promise<ApplyOutcome> {
  const cells = (p.payload?.cells ?? []) as CardCell[];
  const g = await readGrid(deps);
  if ("error" in g) return { patch: { status: "failed", failure: `${g.error} Nothing changed.` } };
  const moved = cells.filter((c) => !sameRate(g.cells.find((x) => x.type === c.type && x.area === c.area)?.rate ?? null, c.from));
  if (moved.length) {
    return { patch: { status: "failed", failure: `${moved.map(label).join(", ")} changed since I made this card, so I saved nothing. Ask me again and I'll start from what's there now.` } };
  }
  const r = await deps.portal("save_insulation", { rows: rowsFor(cells.map((c) => ({ type: c.type, area: c.area, rate: c.to })), g.cells) });
  const skipped = r.data && Array.isArray(r.data.skipped) ? (r.data.skipped as unknown[]).map(String) : [];
  if (!landed(r)) {
    const reason = unsure(r) ? `I couldn't tell if that saved. Check ${WHERE} before trying again.` : saidBy(r, "That didn't save.");
    // A lost answer may have saved, so Undo stays: it puts a rate back only where it reads what this saved.
    const undo = unsure(r) ? { cells: cells.map((c) => ({ type: c.type, area: c.area, before: c.from, after: c.to })) } : null;
    return { patch: { status: "partly_applied", result: { saved: 0, created: 0, reports: [{ label: p.title, status: unsure(r) ? "error" : "refused", reason }] }, undo } };
  }
  const missed = cells.filter((c) => skipped.some((x) => x.startsWith(key(c) + ":")));
  const saved = cells.filter((c) => !missed.includes(c));
  return {
    patch: {
      status: missed.length ? "partly_applied" : "applied",
      result: { saved: saved.length, created: 0, reports: missed.map((c) => ({ label: label(c), status: "refused", reason: "That one didn't save." })) },
      undo: saved.length ? { cells: saved.map((c) => ({ type: c.type, area: c.area, before: c.from, after: c.to })) } : null,
    },
  };
}

async function undoInsulation(deps: Deps, p: ProposalRow): Promise<UndoOutcome> {
  const plan = ((p.undo ?? {}) as { cells?: { type: InsType; area: InsArea; before: number | null; after: number }[] }).cells ?? [];
  const g = await readGrid(deps);
  if ("error" in g) return { restored: 0, removed: 0, failed: plan.length || 1, reports: [{ label: p.title, status: "error", reason: "I couldn't read your insulation just now. Please try again." }] };
  const reports: UndoOutcome["reports"] = [];
  const back = plan.filter((c) => {
    const now = g.cells.find((x) => x.type === c.type && x.area === c.area)?.rate ?? null;
    if (sameRate(now, c.before)) return false; // already back
    if (!sameRate(now, c.after)) {
      reports.push({ label: label(c), status: "changed", reason: `This was changed since I saved it, so I left it. Set it on ${WHERE} if you need to.` });
      return false;
    }
    return true;
  });
  const already = plan.length - back.length - reports.length;
  if (!back.length) return { restored: already, removed: 0, failed: 0, reports };
  const r = await deps.portal("save_insulation", { rows: rowsFor(back.map((c) => ({ type: c.type, area: c.area, rate: c.before })), g.cells) });
  if (!landed(r)) {
    return { restored: already, removed: 0, failed: unsure(r) ? back.length : 0, reports: [...reports, ...back.map((c) => ({ label: label(c), status: unsure(r) ? "error" : "refused", reason: saidBy(r, "That didn't undo.") }))] };
  }
  const skipped = r.data && Array.isArray(r.data.skipped) ? (r.data.skipped as unknown[]).map(String) : [];
  const missed = back.filter((c) => skipped.some((x) => x.startsWith(key(c) + ":")));
  const done = back.filter((c) => !missed.includes(c));
  return {
    restored: already + done.filter((c) => c.before !== null).length,
    removed: done.filter((c) => c.before === null).length,
    failed: missed.length,
    reports: [...reports, ...missed.map((c) => ({ label: label(c), status: "error", reason: "That one didn't go back. Press Undo to try again." }))],
  };
}

const kind: KindSpec = {
  kind: INSULATION_KIND,
  areas: () => [AREA],
  switches: () => [PRICES_SWITCH],
  where: WHERE,
  nothingToDo: (p) => ((p.payload?.cells ?? []).length ? null : "Nothing would change, so there's nothing to approve."),
  apply: (deps, _who, p) => applyInsulation(deps, p),
  undo: (deps, _who, p) => undoInsulation(deps, p),
};

export const insulationPiece: Piece = {
  name: "insulation",
  tools: [lookTool, proposeTool],
  kinds: [kind],
  can: [
    `Read their insulation rates with look_at_my_insulation, and change them with propose_insulation_prices (${WHERE}).`,
  ],
  rules: [
    "Batt, spray foam and rigid foam are insulation, priced per square foot on the floor, walls and roof. They are never add-on items or option columns: read look_at_my_insulation, and if a type's areas have different rates and they name only the type, ask which areas.",
  ],
};

/** Exposed for tests. */
export const _test = { rowsFor, sameRate, money };
