// Stand-in for _shared/doorLook.ts (the door-look spec module, plan "Door looks from a photo" phase
// P1, built on its own branch), wired in through import_map.json ("../doorLook.ts") so the door-look
// wiring tests here can load portal-settings before P1 is merged.
//
// ⚠️ WHEN P1 LANDS, DELETE THIS FILE AND ITS import_map.json LINE. The map shadows the real module for
// every test in this folder, so leaving it would test portal-settings against this stand-in forever.
// The tests that use it send only specs the real cleaner accepts (a base from the seven, v 1, one or
// two leaves) or junk it must refuse, so they keep passing on the real one.
//
// The contract portal-settings/doorLooks.ts relies on, and all this implements: sanitizeDoorLook
// returns the cleaned spec (an object carrying v: 1, a base from the seven, src.leaves 1 or 2 and
// src.hinge) or null when the input cannot be cleaned (not an object, an unknown base, 3+ leaves).
// It never throws. The real one also fills every default and clamps every number (plan §3).

const BASES = ["plank", "zbrace", "xbrace", "american", "basic", "classic", "dutch"];

export function sanitizeDoorLook(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.base !== "string" || !BASES.includes(r.base)) return null;
  const src = (r.src && typeof r.src === "object" ? r.src : {}) as Record<string, unknown>;
  const leaves = src.leaves === undefined ? 1 : src.leaves;
  if (leaves !== 1 && leaves !== 2) return null;
  const out: Record<string, unknown> = { v: 1, base: r.base, src: { leaves, hinge: src.hinge === "right" ? "right" : "left" } };
  // The rest as sent, minus the keys a spec never holds (the real cleaner whitelists and clamps it all).
  for (const [k, v] of Object.entries(r)) if (!(k in out) && k !== "measure" && k !== "observed") out[k] = v;
  return out;
}
