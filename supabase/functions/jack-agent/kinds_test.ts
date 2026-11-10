import { assert, assertEquals } from "./test_assert.ts";
import { type Deps, toolsFor, type TurnState } from "./agent.ts";
import { PIECE_KINDS, PIECE_TOOLS } from "./pieces.ts";
import { PRIVATE_KINDS } from "./common.ts";

// The database's list of card kinds and the code's must be the same list: a kind the code writes that the
// database refuses fails every card of it, and a kind the database allows that no code knows is a card
// nobody can approve or undo. The newest migration that sets the constraint is the one that counts.
const LATEST = "379_jack_insulation.sql";
/** The newest migration that defines jack_clear_old_private (376 made it, 378 widened its kinds). */
const SWEEP = "378_jack_sends.sql";
const read = (f: string) => Deno.readTextFileSync(new URL(`../../migrations/${f}`, import.meta.url)).replace(/\r\n/g, "\n");

Deno.test("the newest kind list (379) is exactly the kinds the code knows", () => {
  const sql = read(LATEST);
  const a = sql.indexOf("add constraint jack_proposals_kind_check check (kind in (");
  const b = sql.indexOf("));", a);
  assert(a >= 0 && b > a, `${LATEST} no longer sets jack_proposals_kind_check`);
  const inSql = [...sql.slice(a, b).replace(/--.*$/gm, "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  const inCode = ["price_sheet", "size_rule", "new_fixture", ...PIECE_KINDS.keys()].sort();
  assertEquals(inSql, inCode);
});

// The sweep that clears old customer contents (378's) must name exactly the kinds that hold them. Every one
// of those is private; a private card without customer contents (a commission rate) is not cleared.
Deno.test("the newest sweep (378) clears exactly the customer-content kinds, and each of them is private", () => {
  const sql = read(SWEEP);
  const a = sql.indexOf("create or replace function public.jack_clear_old_private(");
  const b = sql.indexOf("$fn$;", a);
  const m = /kind in \(([^)]*)\)/.exec(sql.slice(a, b));
  const inSql = [...(m ? m[1] : "").matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
  assertEquals(inSql, [...PRIVATE_KINDS].sort());
  for (const k of PRIVATE_KINDS) assert(PIECE_KINDS.get(k)?.private === true, `${k} holds customer contents but isn't private`);
  // Every private kind is cleared after 30 days except the ones kept on purpose: a new private kind with
  // customer words must join PRIVATE_KINDS (and the newest sweep), or this fails.
  const kept = [...PIECE_KINDS.values()].filter((k) => k.private && !(PRIVATE_KINDS as readonly string[]).includes(k.kind)).map((k) => k.kind).sort();
  assertEquals(kept, ["commission_rate"]);
});

// After a customer's words in a turn, no tool that would change settings, prices, rules or a work record
// is offered (agent.ts offered/toolsFor). The record tools are change tools too (11-09): marking a load
// delivered can't be undone, and marking built or delivered sets off rules that text the customer. Only a
// reply draft and an estimate emailed again stay, by design: each is a message a person reads on its card.
Deno.test("after a customer's words, the only propose tools left are the reply draft and the estimate emailed again", () => {
  const deps = { canRead: () => true, canEdit: () => true } as unknown as Deps;
  const turn = (customerWordsRead: boolean): TurnState => ({ who: { clientId: "c", userId: "u", operatorEmail: null }, chatId: "chat1", off: [], proposalIds: [], customerWordsRead });
  const proposeNames = (s: TurnState) => toolsFor(deps, s).map((t) => t.name).filter((n) => n.startsWith("propose_")).sort();
  const before = proposeNames(turn(false));
  for (const n of ["propose_delivery_change", "propose_build_schedule", "propose_change_order", "propose_inventory_change", "propose_commission_rate"]) {
    assert(before.includes(n), `${n} is offered before any customer words`);
    assertEquals([n, PIECE_TOOLS.get(n)?.proposesChange], [n, true]);
  }
  assertEquals(proposeNames(turn(true)), ["propose_estimate_resend", "propose_reply_draft"]);
  // Every piece's propose tool is a change tool unless it is one of those two.
  const open = [...PIECE_TOOLS.values()].filter((t) => t.def.name.startsWith("propose_") && !t.proposesChange).map((t) => t.def.name).sort();
  assertEquals(open, ["propose_estimate_resend", "propose_reply_draft"]);
});

// A card that sends a customer something runs only from a page that shows what it sends (send: true on
// its Approve, agent.ts approvePiece), and says it may have gone when a press stalls (gaveUp).
Deno.test("every kind that emails or texts a customer on Approve is marked sends, with its own stalled sentence", () => {
  const sending = [...PIECE_KINDS.values()].filter((k) => k.sends).map((k) => k.kind).sort();
  assertEquals(sending, ["changeorder_attrs", "estimate_resend", "reply_send"]);
  for (const k of sending) assert(PIECE_KINDS.get(k)!.gaveUp, `${k} says in its own words that a stalled press may have sent it`);
});
