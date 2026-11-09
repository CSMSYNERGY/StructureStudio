// jack-agent: every piece of Jack, in one list. agent.ts routes tools and cards through it; nothing else
// needs to know which pieces exist. Order is the order the tools are offered to Claude.

import type { KindSpec, Piece, ToolSpec } from "./types.ts";

export const PIECES: Piece[] = [];

export const PIECE_TOOLS = new Map<string, ToolSpec>();
export const PIECE_KINDS = new Map<string, KindSpec>();

/** Adds pieces to the registry. Called once at load by agent.ts with the real list, and by tests. */
export function register(pieces: Piece[]): void {
  for (const p of pieces) {
    if (PIECES.some((x) => x.name === p.name)) continue;
    PIECES.push(p);
    for (const t of p.tools) {
      if (PIECE_TOOLS.has(t.def.name)) throw new Error(`two tools are called ${t.def.name}`);
      PIECE_TOOLS.set(t.def.name, t);
    }
    for (const k of p.kinds) {
      if (PIECE_KINDS.has(k.kind)) throw new Error(`two cards are called ${k.kind}`);
      PIECE_KINDS.set(k.kind, k);
    }
  }
}
