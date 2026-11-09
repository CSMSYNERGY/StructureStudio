// jack-agent: one team member's standing commission rate, the Commission % box on the Team screen
// (commissions_test.ts). Plan section 5.9, and Ahsan's defaults of 11-06.
//
// THE RULES
//   - One tool, propose_commission_rate, writes one card. Only a person's Approve sends portal-commissions
//     set_rate, once, with exactly the card's {userId, percent}, under that person's own token, so the
//     route's own gates still decide: rates belong to the owner and to anyone the owner gave full access,
//     nobody but the owner sets their own, and the person must be on the team.
//   - Matching the Team screen: an owner row has no rate box, so Jack sets no owner's rate.
//   - Operators can't change rates (Carolyn's 08-07 rule: portal-commissions refuses any call that names
//     another account, and jack-agent always names it for an operator; that is never stripped). Jack
//     refuses an operator before the card, at Approve and at Undo. An operator may still open a card, but
//     its figures (preview.rate and preview.ledger, COMMISSION_OPERATOR_HIDDEN) are taken off for them.
//     Titles, results and failures carry no figures at all: the activity page shows those more widely.
//     So does the card's hash, which is why the payload holds a nonce (propose_commission_rate).
//   - set_rate takes no version and answers only {ok: true}. So Approve reads the team again and saves only
//     while the rate stands where the card showed it. A lost answer is never sent again: the team is read
//     again and that decides. Undo puts the old rate back only while the rate still holds Jack's value.
//   - A new rate is not only for future sales. The next time someone opens the Commissions tab, compute
//     prices that person's lines that aren't approved yet again, past sales included. The card says so,
//     and, for someone who sees every payout, roughly how many lines and dollars that is. Approved, paid
//     and hand-changed lines keep their amount.
//   - Claude hears the person's name and the new rate (Ahsan, 11-06: the builder terms cover it). Never
//     the old rate, anyone else's rate, an email address or a pay figure. `list` carries every member's
//     email, so only the fields named in readTeam are copied out of it. list_entries carries customer names
//     and amounts: the card's ledger line is worked out here and neither reaches Claude.
//   - No rule event: nothing in Carolyn's rules starts on a commission rate, so there is no rule warning.

import type { ApplyOutcome, Deps, KindSpec, Piece, PortalFn, ProposalRow, ToolSpec, UndoOutcome, Who } from "./types.ts";
import { dollars, err, ok, putCard, SAID, saidBy } from "./common.ts";
import { safeName, scrub } from "./redact.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
type Res = { status: number; data: Record<string, unknown> | null };
type Progress = (patch: Record<string, unknown>) => Promise<void>;

export const COMMISSIONS_SWITCH = "commissions";
export const COMMISSION_KIND = "commission_rate";
export const WHERE = "Settings > Company > Team";
/** The preview keys that hold figures. Taken off the card for an operator (agent.ts, by the kind's
 *  operatorHidden). Nothing else on the card holds a rate or an amount. */
export const COMMISSION_OPERATOR_HIDDEN = ["rate", "ledger"];

/** portal-commissions, through deps.call with the caller's own token. Not in PortalFn yet (types.ts). */
const FN = "portal-commissions" as string as PortalFn;

export const COMM_SAID = {
  operator: "The Structure Studio team can't change commission rates on a builder's account. Ask the builder's owner to make the change.",
  noRates: "Only the owner, and people the owner gives full access, can see and change commission rates. Ask an owner.",
  ownerRow: "Owners don't have a commission rate on the Team screen, so I don't set one.",
  self: "You can't set your own commission rate. Ask an owner to change it.",
  notOnTeam: "That person isn't on your team any more, so nothing changed.",
  same: "That's already their rate. Nothing to change.",
  sameClear: "They already have no rate. Nothing to change.",
  range: "A commission rate is a percent from 0 to 100.",
  who: "Say whose rate to change.",
  readTeam: "I couldn't read your team just now, so nothing changed. Ask me again in a moment.",
  moved: "Their rate changed since I showed you this, so nothing was saved. Ask me again and I'll start from what's there now.",
  badCard: "That card can't be saved as it is. Ask me again.",
  unsure: `I couldn't tell if that saved. Check ${WHERE} before trying again.`,
  changedSince: "Their rate was changed since, so I left it.",
  ownerNow: "They're an owner now, and owners don't have a rate on the Team screen, so I left it.",
  goneUndo: "That person isn't on your team any more, so there's nothing to put back.",
  readAgain: "I couldn't read your team just now. Press Undo to try again.",
  tryAgain: "I couldn't tell if that went back. Press Undo to try again.",
  nothingRecorded: "I have no record of what this changed, so I left it.",
  off: "Commission tracking is off on this account, so the Commissions report won't change until it's turned on.",
};

// ── Rates ─────────────────────────────────────────────────────────────────────────────────────────

/** The route stores three decimals (numeric(6,3)), so every compare goes through the same rounding. */
const round3 = (n: number) => Math.round(n * 1000) / 1000;
/** A stored rate: a number from 0 to 100, null when blank, undefined when it isn't a rate at all. */
const rateIn = (v: unknown): number | null | undefined =>
  v === null ? null : typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100 ? round3(v) : undefined;
const sameRate = (a: number | null, b: number | null) => (a === null || b === null ? a === b : round3(a) === round3(b));
export const rateWords = (r: number | null) => (r === null ? "No rate" : `${r}%`);

/** What a new rate means beyond the number, on the card only (it names the rate). */
function rateNote(to: number | null): string | null {
  if (to === null) return "With no rate, their lines show no amount, and approving a period leaves those lines out.";
  if (to === 0) return "At 0%, their lines come to $0.";
  return null;
}

/** The rate Claude asked for. 0 is a rate; no rate at all is `clear`. */
function wantedRate(i: Any): { to: number | null } | { error: string } {
  if (i?.clear === true) return { to: null };
  const v = i?.percent;
  const raw = typeof v === "number" ? v : typeof v === "string" && /^\s*\d+(\.\d+)?\s*%?\s*$/.test(v) ? parseFloat(v) : NaN;
  if (!Number.isFinite(raw) || raw < 0 || raw > 100) return { error: COMM_SAID.range };
  return { to: round3(raw) };
}

// ── The team, as portal-commissions `list` answers it ─────────────────────────────────────────────

export interface Member { userId: string; name: string; role: string; isSelf: boolean; deactivated: boolean; rate: number | null | undefined }
export interface Team { canSeeRates: boolean; isOwner: boolean; members: Member[] }

/** A route's sentence, made plain: some use a dash as a pause. */
const plain = (s: string) => s.replace(/\s*—\s*/g, ": ").replace(/\s+/g, " ").trim();
const refusal = (r: Res, fallback: string) => plain(saidBy(r, fallback));
const lost = (r: Res) => r.status === 0 || r.status >= 500 || (r.status === 200 && r.data?.ok !== true);
const landed = (r: Res) => r.status === 200 && r.data?.ok === true;

/** The team, or the sentence to say. Only these fields are copied: `list` also carries every email. A
 *  refusal (4xx) is the route's own sentence; anything else is a read that failed. */
export async function readTeam(deps: Deps): Promise<{ team: Team } | { error: string; refused: boolean }> {
  const r = await deps.call(FN, "list", {});
  if (r.status >= 400 && r.status < 500) return { error: refusal(r, SAID.noSee), refused: true };
  const d = r.data as Any;
  if (r.status !== 200 || !d || d.ok !== true || !Array.isArray(d.members)) return { error: SAID.readFailed, refused: false };
  const canSeeRates = d.canSeeRates === true;
  const members = (d.members as Any[]).filter((m) => m && typeof m.userId === "string" && m.userId).map((m): Member => ({
    userId: m.userId,
    name: typeof m.fullName === "string" ? m.fullName.trim() : "",
    role: typeof m.role === "string" ? m.role : "user",
    isSelf: m.isSelf === true,
    deactivated: m.deactivated === true,
    rate: canSeeRates ? (m.commissionPercent === null ? null : rateIn(m.commissionPercent)) : undefined,
  }));
  return { team: { canSeeRates, isOwner: d.isOwner === true, members } };
}

const byId = (team: Team, userId: string) => team.members.find((m) => m.userId.toLowerCase() === userId.toLowerCase()) ?? null;
/** The route's own self check compares ids as typed, so Jack's ignores case, and the id it sends is always
 *  the one `list` gave. */
const isMe = (m: Member, who: Who) => m.isSelf || m.userId.toLowerCase() === who.userId.toLowerCase();

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** A person by full name, or by first name when only one person has it. Names only, never an id from Claude. */
export function memberByName(team: Team, name: string): { member: Member } | { error: string } {
  const n = norm(name);
  if (!n) return { error: COMM_SAID.who };
  const named = team.members.filter((m) => norm(m.name));
  const full = named.filter((m) => norm(m.name) === n);
  const hits = full.length ? full : named.filter((m) => norm(m.name).split(" ")[0] === n);
  if (hits.length === 1) return { member: hits[0] };
  const said = `"${scrub(name, 60)}"`;
  if (hits.length > 1) return { error: `More than one person on your team is called ${said}. Ask the person which one they mean. If two people share a name, set the rate on ${WHERE}.` };
  const names = named.filter((m) => m.role !== "owner").map((m) => safeName(m.name)).filter((x): x is string => !!x);
  return {
    error: `There's no one on your team called ${said}. ${names.length ? `The people who can have a rate are: ${names.slice(0, 40).join(", ")}.` : "Nobody on your team can have a rate yet."} Ask the person which one they mean, and don't guess.`,
  };
}

// ── What the next compute prices again (portal-commissions list_entries) ──────────────────────────

export interface Ledger { lines: number; say: string }

const linesWord = (n: number) => `${n} ${n === 1 ? "line" : "lines"}`;

/** This person's lines that compute would price again: their pending lines that nobody changed by hand,
 *  on sales where no line is approved, paid or changed by hand (compute leaves those sales whole). "Up
 *  to", because compute removes, rather than prices, a line on a sale that wasn't issued from Structure
 *  Studio, and list_entries doesn't say which sales those are. Counts and dollars only: no customer. */
export function ledgerFor(entries: Any[], userId: string, to: number | null): Ledger {
  const bySale = new Map<string, Any[]>();
  for (const e of entries) {
    if (!e || e.kind !== "commission") continue;
    const k = String(e.orderId ?? "");
    bySale.set(k, [...(bySale.get(k) ?? []), e]);
  }
  const me = userId.toLowerCase();
  let lines = 0, priced = 0, nowCents = 0, thenCents = 0, noBase = 0;
  for (const sale of bySale.values()) {
    if (sale.some((e) => e.status === "paid" || e.status === "payable" || e.isOverride === true)) continue;
    for (const e of sale) {
      if (e.status !== "pending" || e.isOverride === true || String(e.earnerUserId ?? "").toLowerCase() !== me) continue;
      lines++;
      if (typeof e.amountCents === "number") { priced++; nowCents += e.amountCents; }
      if (typeof e.baseCents === "number") { if (to !== null) thenCents += Math.round(e.baseCents * to / 100); }
      else noBase++;
    }
  }
  if (!lines) return { lines, say: "None of their lines are waiting to be approved right now." };
  const one = lines === 1;
  const now = priced ? `${one ? "It comes" : "Together they come"} to ${dollars(nowCents)} now` : `${one ? "It shows" : "They show"} no amount now`;
  let then: string;
  if (to === null) then = `, and with no rate ${one ? "it" : "they"} would show no amount.`;
  else if (noBase === lines) then = `. ${one ? "It has" : "They have"} no sale amount yet, so I can't work out the new figure.`;
  else {
    then = `, and about ${dollars(thenCents)} at the new rate.`;
    if (noBase) then += ` ${noBase} of them ${noBase === 1 ? "has" : "have"} no sale amount yet, so the new figure leaves ${noBase === 1 ? "it" : "them"} out.`;
  }
  return { lines, say: `That's up to ${linesWord(lines)} not yet approved. ${now}${then}` };
}

/** The ledger line, for someone who may read the report and sees every payout. Anyone else gets the
 *  general sentence only: their report holds just their own lines. A read that fails says nothing. */
async function readLedger(deps: Deps, userId: string, to: number | null): Promise<{ ledger: Ledger | null; off: boolean }> {
  if (!deps.canRead("commissions")) return { ledger: null, off: false };
  const r = await deps.call(FN, "list_entries", {});
  const d = r.data as Any;
  if (r.status !== 200 || !d || d.ok !== true || !Array.isArray(d.entries)) return { ledger: null, off: false };
  if (d.enabled !== true) return { ledger: null, off: true };
  if (d.seesAll !== true) return { ledger: null, off: false };
  return { ledger: ledgerFor(d.entries, userId, to), off: false };
}

const repriceNote = (name: string) =>
  `A new rate also re-prices ${name ? `${name}'s` : "their"} lines that aren't approved yet, past sales included, the next time someone opens the Commissions tab. Lines already approved, paid or changed by hand keep their amount.`;

// ── propose_commission_rate ───────────────────────────────────────────────────────────────────────

const TITLE = "Change a team member's commission rate";

const proposeTool: ToolSpec = {
  def: {
    name: "propose_commission_rate",
    description: `Put a card on the person's screen that changes one team member's standing commission rate (the Commission % box on ${WHERE}). It changes nothing: the person presses Approve. Use the name and the rate they gave you, and never guess either. Owners have no rate, nobody sets their own, and the Structure Studio team can't change rates. A new rate also re-prices that person's lines that aren't approved yet, past sales included, and the card says so.`,
    strict: true,
    input_schema: {
      type: "object", additionalProperties: false, required: ["person", "percent", "clear"],
      properties: {
        person: { type: "string", description: "The team member's name, as the person said it." },
        percent: { type: "number", description: "The new rate in percent, from 0 to 100, like 7 or 6.5. 0 when clear is true." },
        clear: { type: "boolean", description: "true only to take their rate away, so their lines show no amount. 0% is a rate: for that, percent 0 and clear false." },
      },
    },
  },
  needs: [{ area: "settings_team", level: "view" }],
  switchKey: COMMISSIONS_SWITCH,
  proposesChange: true,
  noOperators: true,
  async run(deps, s, input) {
    if (s.who.operatorEmail) return err(COMM_SAID.operator);
    if (!deps.canRead("settings_team")) return err(SAID.noSee);
    const i = (input ?? {}) as Any;
    const person = typeof i.person === "string" ? i.person.trim() : "";
    if (!person) return err(COMM_SAID.who);
    const want = wantedRate(i);
    if ("error" in want) return err(want.error);
    const read = await readTeam(deps);
    if ("error" in read) return err(read.error);
    const { team } = read;
    if (!team.canSeeRates) return err(COMM_SAID.noRates);
    const found = memberByName(team, person);
    if ("error" in found) return err(found.error);
    const m = found.member;
    if (m.role === "owner") return err(COMM_SAID.ownerRow);
    if (isMe(m, s.who)) return err(COMM_SAID.self);
    if (m.rate === undefined) return err(SAID.readFailed);
    const from = m.rate, to = want.to;
    if (sameRate(from, to)) return ok({ shown: false, note: to === null ? COMM_SAID.sameClear : COMM_SAID.same });

    const { ledger, off } = await readLedger(deps, m.userId, to);
    const notes = [repriceNote(m.name), ...(off ? [COMM_SAID.off] : []), ...(m.deactivated ? [`${m.name || "Their"}${m.name ? "'s" : ""} login is switched off.`] : [])];
    await putCard(deps, s, {
      kind: COMMISSION_KIND,
      title: TITLE,
      preview: {
        member: { name: m.name || null, deactivated: m.deactivated },
        rate: { from, to, fromWords: rateWords(from), toWords: rateWords(to), note: rateNote(to) },
        ledger,
        notes,
        where: WHERE,
        route: { page: "settings", sub: "team" },
      },
      // The card's hash is SHA-256 of this payload with no key (index.ts), and it rides every view of the
      // card: the activity page shows it to every teammate with Jack view, private or not, and to operators.
      // Rates are a few hundred values, and `list` gives anyone with Team at view every userId, so without
      // something unguessable here, hashing each rate before and after gives both figures back in about a
      // second. The nonce is never sent: set_rate gets only userId and percent.
      payload: { userId: m.userId, percent: to, from, nonce: deps.makeId() },
    });
    return ok({
      shown: true,
      person: safeName(m.name) ?? "that person",
      newRate: rateWords(to),
      note: `${SAID.onScreenApprove} Also say that a new rate re-prices their lines that aren't approved yet, past sales included, and that approved and paid lines keep their amount.`,
    });
  },
};

// ── Approve and Undo ──────────────────────────────────────────────────────────────────────────────

interface Plan { userId: string; from: number | null; to: number | null }

/** The card's run: who, the rate it sets, and the rate it was shown. The payload names the new rate
 *  `percent`, as set_rate does; the undo record names it `to`. Null when it can't be run. */
function planOf(v: Any, toKey: "percent" | "to"): Plan | null {
  const userId = typeof v?.userId === "string" ? v.userId : "";
  const to = rateIn(v?.[toKey]), from = rateIn(v?.from);
  if (!userId || to === undefined || from === undefined) return null;
  return { userId, from, to };
}

// No rate and no amount in a result or a failure: operators and the activity page read those.
const failed = (failure: string): ApplyOutcome => ({ patch: { status: "failed", failure, result: { rates: 0, reports: [] }, undo: null } });

/** Why this person may not set this rate now, or null. The card's guard: it runs before anything is sent. */
function standing(team: Team, who: Who, plan: Plan): string | null {
  if (!team.canSeeRates) return COMM_SAID.noRates;
  const m = byId(team, plan.userId);
  if (!m) return COMM_SAID.notOnTeam;
  if (m.role === "owner") return COMM_SAID.ownerRow;
  if (isMe(m, who)) return COMM_SAID.self;
  if (m.rate === undefined) return COMM_SAID.readTeam;
  if (!sameRate(m.rate, plan.from)) return COMM_SAID.moved;
  return null;
}

/** ONE set_rate, with exactly the card's userId and percent, and only while the rate stands where the
 *  card showed it. */
async function applyRate(deps: Deps, who: Who, p: ProposalRow, progress: Progress): Promise<ApplyOutcome> {
  if (who.operatorEmail) return failed(COMM_SAID.operator);
  const plan = planOf(p.payload, "percent");
  if (!plan || sameRate(plan.from, plan.to)) return failed(COMM_SAID.badCard);
  const read = await readTeam(deps);
  if ("error" in read) return failed(read.refused ? `${read.error} Nothing changed.` : COMM_SAID.readTeam);
  const why = standing(read.team, who, plan);
  if (why) return failed(why);
  // Undo is recorded before the send, so a worker that dies here still leaves Undo to read and decide.
  await progress({ undo: plan });
  const r = await deps.call(FN, "set_rate", { userId: plan.userId, percent: plan.to });
  const done: ApplyOutcome = { patch: { status: "applied", result: { rates: 1, reports: [] }, undo: plan } };
  if (landed(r)) return done;
  // Every refusal set_rate gives comes before it writes, so a 4xx saved nothing.
  if (!lost(r)) return failed(`${refusal(r, "That didn't save.")} Nothing was saved.`);
  // The answer was lost, so it may have landed. It is never sent again: the team says what stands.
  const again = await readTeam(deps);
  const m = "team" in again ? byId(again.team, plan.userId) : null;
  if (m && m.rate !== undefined && sameRate(m.rate, plan.to)) return done;
  return { patch: { status: "partly_applied", result: { rates: 0, reports: [{ label: p.title, status: "error", reason: COMM_SAID.unsure }] }, undo: plan } };
}

/** Puts the old rate back, only while the rate still holds Jack's value. A rate already back where it was
 *  counts as put back, with nothing sent. A press that couldn't decide stays undoable (failed 1). */
async function undoRate(deps: Deps, who: Who, p: ProposalRow): Promise<UndoOutcome> {
  const label = p.title;
  const keep = (reason: string, status = "refused"): UndoOutcome => ({ restored: 0, removed: 0, failed: 1, reports: [{ label, status, reason }] });
  const leave = (reason: string, status = "changed"): UndoOutcome => ({ restored: 0, removed: 0, failed: 0, reports: [{ label, status, reason }] });
  const back: UndoOutcome = { restored: 1, removed: 0, failed: 0, reports: [] };
  if (who.operatorEmail) return keep(COMM_SAID.operator);
  const plan = planOf(p.undo, "to");
  if (!plan) return leave(COMM_SAID.nothingRecorded, "kept");
  const read = await readTeam(deps);
  if ("error" in read) return read.refused ? keep(read.error) : keep(COMM_SAID.readAgain, "error");
  const { team } = read;
  if (!team.canSeeRates) return keep(COMM_SAID.noRates);
  const m = byId(team, plan.userId);
  if (!m) return leave(COMM_SAID.goneUndo, "gone");
  if (m.rate === undefined) return keep(COMM_SAID.readAgain, "error");
  if (sameRate(m.rate, plan.from)) return back;
  if (!sameRate(m.rate, plan.to)) return leave(COMM_SAID.changedSince);
  if (m.role === "owner") return leave(COMM_SAID.ownerNow);
  if (isMe(m, who)) return keep(COMM_SAID.self);
  const r = await deps.call(FN, "set_rate", { userId: m.userId, percent: plan.from });
  if (landed(r)) return back;
  if (!lost(r)) return keep(refusal(r, "That didn't go back."));
  // Lost: read again rather than send again. The next press reads first too.
  const again = await readTeam(deps);
  const now = "team" in again ? byId(again.team, plan.userId) : null;
  if (now && now.rate !== undefined && sameRate(now.rate, plan.from)) return back;
  return keep(COMM_SAID.tryAgain, "error");
}

function nothingToDo(p: ProposalRow): string | null {
  const plan = planOf(p.payload, "percent");
  if (!plan) return "There's nothing to change on that one.";
  return sameRate(plan.from, plan.to) ? "Nothing would change, so there's nothing to approve." : null;
}

/** canSeeRates is a grant on commission_members, not an area, so `areas` is empty and apply and undo
 *  check it from a live `list` (which itself needs Team at view). Opening the card needs Team at view.
 *  Private: only the person who asked, and the Structure Studio team, may open it. */
export const rateKind: KindSpec & { operatorHidden: string[] } = {
  kind: COMMISSION_KIND,
  areas: () => [],
  readAreas: () => ["settings_team"],
  switches: () => [COMMISSIONS_SWITCH],
  private: true,
  where: WHERE,
  operatorHidden: COMMISSION_OPERATOR_HIDDEN,
  noOperators: COMM_SAID.operator,
  nothingToDo,
  apply: (deps, who, p, progress) => applyRate(deps, who, p, progress),
  undo: (deps, who, p) => undoRate(deps, who, p),
};

export const COMMISSION_KINDS = [COMMISSION_KIND];

export const commissionsPiece: Piece = {
  name: "commissions",
  can: [
    `Change one team member's standing commission rate with propose_commission_rate (the Commission % box on ${WHERE}), for someone allowed to see rates.`,
  ],
  rules: [
    "Commission rates: you only change one person's standing rate. Owners have no rate, nobody sets their own, and the Structure Studio team can't change rates. Who sees rates or payouts, approving or paying out, and one line's amount are done by hand on the Commissions tab.",
    "Use the rate the person said, never a guess. 0% pays nothing. No rate at all is different: their lines then show no amount.",
  ],
  tools: [proposeTool],
  kinds: [rateKind],
};
