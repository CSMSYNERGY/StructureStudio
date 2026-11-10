// Carolyn's 11-09 call, in tests: a door's swing and operation (a garage door slides up, an entry door
// swings in), a typed correction that makes the card again, and the Revise button (agent.ts handleSend
// `revise`). Fakes only: one chat that keeps its messages, a portal, Claude scripted.

import { assert, assertEquals } from "./test_assert.ts";
import {
  type Deps, DOOR_REPLACED, doorWay, doorWayWords, handleProposalApprove, handleSend, NOT_REVISABLE, type ProposalRow, proposalView, REVISED,
  revisable, reviseNote, type Store, type StoredMessage, type Who,
} from "./agent.ts";

/** A wallet whose meter is off (agent_test.ts has the same one): nothing is charged. */
const quietWallet = (): Deps["wallet"] => ({
  meter: () => Promise.resolve({ active: false, markup: 1.5 }),
  exempt: () => Promise.resolve(false),
  account: () => Promise.resolve({ balanceCents: 5000, heldCents: 0, remainderMicros: 0, autoTopup: false, thresholdCents: null }),
  debit: () => Promise.resolve({ ok: true, txId: 1 }),
  grantOnce: () => Promise.resolve(true),
  requestTopup: () => {},
  mark: () => Promise.resolve(),
  pending: () => Promise.resolve([]),
});

const who: Who = { clientId: "builder-a", userId: "u1", operatorEmail: null };
const other: Who = { clientId: "builder-a", userId: "u2", operatorEmail: null };
const CATALOG = { items: [], fixtures: [{ id: "d1", name: "Single door", category: "door", width_in: 36, height_in: 80 }], insulation: [] };

/** One chat per person that keeps what's said in it, so a later turn sees the cards an earlier one made. */
function makeStore() {
  const proposals = new Map<string, ProposalRow>();
  const messages: (StoredMessage & { chat: string })[] = [];
  const chats = new Map<string, string>(); // userId -> chat id
  let seq = 0;
  const store = {
    settings: () => Promise.resolve({ on: true, off: [] }),
    setOff: () => Promise.resolve(),
    usage: () => Promise.resolve({ monthCostMicros: 0, tenant24h: 0, user10m: 0, sheets24h: 0 }),
    openChat: (w: Who) => Promise.resolve(chats.has(w.userId) ? { id: chats.get(w.userId)! } : null),
    createChat: (w: Who) => { const id = `chat-${w.userId}`; chats.set(w.userId, id); return Promise.resolve(id); },
    chats: () => Promise.resolve([]),
    messages: (_w: Who, chat: string) => Promise.resolve(messages.filter((m) => m.chat === chat)),
    addMessage: (m: { chatId: string; role: "user" | "assistant"; body: string; tools?: string[]; proposalIds?: string[] }) => {
      const r = { id: `m${++seq}`, chat: m.chatId, role: m.role, body: m.body, created_at: "now", proposal_ids: m.proposalIds ?? [], tools: m.tools ?? [] };
      messages.push(r);
      return Promise.resolve(r);
    },
    bumpChat: () => Promise.resolve(),
    closeChats: () => Promise.resolve(),
    reopenChat: () => Promise.resolve(true),
    accountLine: () => Promise.resolve({ firstName: "Carolyn", title: "Owner", business: "Ridgeline", role: "owner" }),
    insertProposal: (p: Partial<ProposalRow>) => {
      const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
      // Made a millisecond apart, as two turns are: madeBefore orders by created_at.
      const row = { id, conversation_id: null, file_name: null, source: {}, preview: {}, payload: {}, answers: {}, result: null, undo: null, shown_hash: null, failure: null, approved_by: null, approved_by_operator: null, approved_at: null, applied_at: null, undone_at: null, expires_at: new Date(Date.now() + 86_400_000).toISOString(), created_at: new Date(Date.now() + seq).toISOString(), updated_at: `u${seq}`, ...p } as ProposalRow;
      proposals.set(id, row);
      return Promise.resolve(row);
    },
    getProposal: (c: string, id: string) => { const r = proposals.get(id); return Promise.resolve(r && r.client_id === c ? r : null); },
    updateProposal: (c: string, id: string, patch: Record<string, unknown>, when?: string[], at?: string) => {
      const r = proposals.get(id);
      if (!r || r.client_id !== c || (when && !when.includes(r.status)) || (at && r.updated_at !== at)) return Promise.resolve(null);
      Object.assign(r, patch, { updated_at: `u${++seq}` });
      return Promise.resolve(r);
    },
    addProposalCost: () => Promise.resolve(),
    proposals: () => Promise.resolve([...proposals.values()]),
    proposalsById: (_c: string, ids: string[]) => Promise.resolve(ids.map((i) => proposals.get(i)!).filter(Boolean)),
    names: () => Promise.resolve({}),
    fixtureStamp: () => Promise.resolve("f1"),
    memory: () => Promise.resolve([]),
    putMemory: () => Promise.resolve(true),
    forgetMemory: () => Promise.resolve(true),
  } as unknown as Store;
  return { store, proposals, messages };
}

const toolUse = (name: string, input: unknown) => ({ stop_reason: "tool_use", model: "claude-sonnet-5-5", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "tool_use", id: "t1", name, input }] });
const said = (text: string) => ({ stop_reason: "end_turn", model: "claude-sonnet-5-5", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "text", text }] });

function makeDeps(store: Store, claude: unknown[]) {
  const portalCalls: { action: string; body: Record<string, unknown> }[] = [];
  const claudeBodies: Record<string, unknown>[] = [];
  const deps: Deps = {
    env: (k) => (k === "JACK_ANTHROPIC_API_KEY" ? "key" : undefined),
    store,
    portal: (action, body) => {
      portalCalls.push({ action, body });
      if (action === "catalog") return Promise.resolve({ status: 200, data: CATALOG as unknown as Record<string, unknown> });
      if (action === "save_fixture") return Promise.resolve({ status: 200, data: { ok: true, id: "fx1" } });
      return Promise.resolve({ status: 200, data: { ok: true } });
    },
    call(fn, action, body) { return fn === "portal-settings" ? this.portal(action, body) : Promise.resolve({ status: 404, data: null }); },
    wallet: quietWallet(),
    fetch: (_u, init) => {
      claudeBodies.push(JSON.parse(String(init.body)));
      const next = claude.shift();
      if (!next) throw new Error("Claude was asked more times than this test expected");
      return Promise.resolve(new Response(JSON.stringify(next), { status: 200 }));
    },
    canRead: () => true,
    canEdit: () => true,
    background: () => {},
    budgetMs: () => 300_000,
    makeId: () => crypto.randomUUID(),
    hash: (t) => Promise.resolve(`h${t.length}`),
    log: () => Promise.resolve(),
    audit: () => Promise.resolve(),
    now: () => Date.now(),
    markSentWithJack: () => Promise.resolve(true),
  };
  return { deps, portalCalls, claudeBodies };
}

const garage = { name: "Garage Door 8x6'3\"", widthInches: 96, heightInches: 75, price: 752 };
const systemText = (b: Record<string, unknown>) => ((b.system ?? []) as { text: string }[]).map((x) => x.text).join("\n\n");
const cards = (proposals: Map<string, ProposalRow>) => [...proposals.values()];

// ── A door's swing and operation ──────────────────────────────────────────────────────────────────

Deno.test("a door's way: slide up has no swing or hinge, double stands alone, either lets the customer pick, and unknown is out and right", () => {
  assertEquals(doorWay("out", "slide_up"), { swingOut: false, swingIn: false, opRight: false, opLeft: false, opDouble: false, opSlideUp: true });
  assertEquals(doorWay("in", "right"), { swingOut: false, swingIn: true, opRight: true, opLeft: false, opDouble: false, opSlideUp: false });
  assertEquals(doorWay("in_or_out", "right_or_left"), { swingOut: true, swingIn: true, opRight: true, opLeft: true, opDouble: false, opSlideUp: false });
  assertEquals(doorWay("out", "double"), { swingOut: true, swingIn: false, opRight: false, opLeft: false, opDouble: true, opSlideUp: false });
  for (const [s, o] of [[undefined, undefined], ["sideways", "up"], [null, 3]]) {
    assertEquals(doorWay(s, o), { swingOut: true, swingIn: false, opRight: true, opLeft: false, opDouble: false, opSlideUp: false });
  }
  assertEquals(doorWayWords(doorWay("out", "slide_up")), "It slides up, with no swing or hinge.");
  assertEquals(doorWayWords(doorWay("in", "left")), "It swings in, with a left hinge.");
  assertEquals(doorWayWords(doorWay("in_or_out", "right_or_left")), "It swings in or out (the customer picks), with a right or left hinge (the customer picks).");
  assertEquals(doorWayWords(doorWay("out", "double")), "It swings out, as a double door.");
  for (const w of [doorWay("out", "slide_up"), doorWay("in", "left"), doorWay("in_or_out", "double")]) assert(!/[—–]/.test(doorWayWords(w)));
});

Deno.test("a garage door is a slide-up card, and Approve saves it slide up with no swing, through the Doors screen's route", async () => {
  const { store, proposals } = makeStore();
  const { deps, portalCalls } = makeDeps(store, [toolUse("propose_new_door", { ...garage, swing: "out", operation: "slide_up" }), said("Here it is.")]);
  await handleSend(deps, who, { text: "Add a garage door 6'3\" tall by 8' wide, 752" });
  const [p] = cards(proposals);
  assertEquals(p.payload.row, { name: garage.name, widthIn: 96, heightIn: 75, price: 752, swingOut: false, swingIn: false, opRight: false, opLeft: false, opDouble: false, opSlideUp: true });
  assertEquals(p.preview.fixture.wayLine, "It slides up, with no swing or hinge.");
  await handleProposalApprove(deps, who, { id: p.id, hash: p.shown_hash });
  assertEquals(portalCalls.at(-1), { action: "save_fixture", body: { category: "door", ...p.payload.row } });
  assertEquals(p.status, "applied");
});

Deno.test("the door tool asks Claude for swing and operation, and says a garage door slides up", async () => {
  const { store } = makeStore();
  const { deps, claudeBodies } = makeDeps(store, [said("Hi.")]);
  await handleSend(deps, who, { text: "hi" });
  const tool = ((claudeBodies[0].tools ?? []) as { name: string; description: string; input_schema: { required: string[]; properties: Record<string, { enum?: string[] }> } }[]).find((t) => t.name === "propose_new_door")!;
  assertEquals(tool.input_schema.required, ["name", "widthInches", "heightInches", "price", "swing", "operation"]);
  assertEquals(tool.input_schema.properties.operation.enum, ["right", "left", "right_or_left", "double", "slide_up"]);
  assertEquals(tool.input_schema.properties.swing.enum, ["out", "in", "in_or_out"]);
  assert(/garage, overhead or roll-up door is operation slide_up/.test(tool.description), tool.description);
  assert(/slides up: no swing, no hinge/.test(systemText(claudeBodies[0])));
  assert(/make the card again with the change/.test(systemText(claudeBodies[0])));
});

// ── A typed correction ────────────────────────────────────────────────────────────────────────────

Deno.test("\"it should swing in\": a new card for the same door puts the older one away, so only one can be approved", async () => {
  const { store, proposals } = makeStore();
  const entry = { name: "9-lite entry door", widthInches: 36, heightInches: 80, price: 1200 };
  const { deps } = makeDeps(store, [
    toolUse("propose_new_door", { ...entry, swing: "out", operation: "right" }), said("On your screen."),
    toolUse("propose_new_door", { ...entry, swing: "in", operation: "right" }), said("Redone: it swings in."),
  ]);
  await handleSend(deps, who, { text: "add a 9-lite entry door 36 x 80, 1200" });
  const r = await handleSend(deps, who, { text: "it should swing in" });
  const [first, second] = cards(proposals);
  assertEquals([first.status, first.failure], ["cancelled", DOOR_REPLACED]);
  assertEquals([second.status, second.payload.row.swingIn, second.payload.row.swingOut], ["ready", true, false]);
  assertEquals(second.preview.fixture.wayLine, "It swings in, with a right hinge.");
  // The older card is refused at the press, even from a page that still shows its Approve.
  assertEquals((await handleProposalApprove(deps, who, { id: first.id, hash: first.shown_hash })).status, 409);
  assertEquals((r.body.proposals as { id: string }[]).map((x) => x.id), [second.id]);
});

Deno.test("a different door in the same chat is its own card, and nothing is put away", async () => {
  const { store, proposals } = makeStore();
  const { deps } = makeDeps(store, [
    toolUse("propose_new_door", { ...garage, swing: "out", operation: "slide_up" }), said("One."),
    toolUse("propose_new_door", { name: "Walk door", widthInches: 36, heightInches: 80, price: 300, swing: "out", operation: "left" }), said("Two."),
  ]);
  await handleSend(deps, who, { text: "garage door" });
  await handleSend(deps, who, { text: "and a walk door" });
  assertEquals(cards(proposals).map((p) => p.status), ["ready", "ready"]);
});

// ── The Revise button ─────────────────────────────────────────────────────────────────────────────

Deno.test("Revise on a door card: Claude hears the card's own values, and the revised card replaces it", async () => {
  const { store, proposals, messages } = makeStore();
  const { deps, claudeBodies } = makeDeps(store, [
    toolUse("propose_new_door", { ...garage, swing: "out", operation: "right" }), said("On your screen."),
    toolUse("propose_new_door", { ...garage, swing: "out", operation: "slide_up" }), said("Redone: it slides up."),
  ]);
  await handleSend(deps, who, { text: "Add a garage door 6'3\" tall by 8' wide, 752" });
  const [old] = cards(proposals);
  assertEquals(proposalView(old).canRevise, true);
  const r = await handleSend(deps, who, { text: "it's a slide up door, no hinge", chatId: old.conversation_id, revise: old.id });
  assertEquals(r.status, 200);
  // What was said, with the card it was about.
  assertEquals(messages.at(-2)?.body, `Revise "Add a door: ${garage.name}": it's a slide up door, no hinge`);
  const sys = systemText(claudeBodies[2]);
  assert(sys.includes("pressed Revise on a card you made"), sys);
  assert(sys.includes(`It adds a door: ${garage.name}, 96 by 75 inches, $752. It swings out, with a right hinge.`), sys);
  const [, made] = cards(proposals);
  assertEquals([old.status, made.status, made.payload.row.opSlideUp], ["cancelled", "ready", true]);
  // The door tool put it away first (its own sentence); the answer carries both cards.
  assertEquals(old.failure, DOOR_REPLACED);
  assertEquals((r.body.proposals as { id: string; status: string }[]).map((x) => [x.id, x.status]), [[made.id, "ready"], [old.id, "cancelled"]]);
});

Deno.test("Revise on a sizes card: the new card of its kind replaces it with the revised sentence", async () => {
  const { store, proposals } = makeStore();
  const rule = (pct: number) => ({ title: `Raise ${pct}%`, rules: [{ styles: [], widths: [], minWidth: null, maxWidth: null, minLength: null, maxLength: null, setPrice: null, raisePercent: pct, raiseDollars: null, setOptions: [] }] });
  const table = { styles: [{ id: "garden", label: "Garden Shed" }], sizes: [{ id: "s1", style_id: "garden", label: "10x12", width_ft: 10, length_ft: 12, base_price: 4000, active: true, updated_at: "v1" }], inclusions: [], counts: { sizes: 1, inclusions: 0 } };
  const { deps } = makeDeps(store, [toolUse("propose_size_changes", rule(5)), said("Raised 5%."), toolUse("propose_size_changes", rule(6)), said("Now 6%.")]);
  const portal = deps.portal;
  deps.portal = (a, b) => (a === "size_table" ? Promise.resolve({ status: 200, data: table as unknown as Record<string, unknown> }) : portal(a, b));
  await handleSend(deps, who, { text: "raise everything 5%" });
  const [old] = cards(proposals);
  await handleSend(deps, who, { text: "make it 6%", chatId: old.conversation_id, revise: old.id });
  const [, made] = cards(proposals);
  assertEquals([old.status, old.failure, made.status, made.payload.sizes[0].to], ["cancelled", REVISED, "ready", { price: 4240 }]);
});

Deno.test("Revise where Jack makes no new card: the old card stays as it was", async () => {
  const { store, proposals } = makeStore();
  const { deps } = makeDeps(store, [toolUse("propose_new_door", { ...garage, swing: "out", operation: "slide_up" }), said("On your screen."), said("I can't make it a window. The door card is still there.")]);
  await handleSend(deps, who, { text: "garage door" });
  const [old] = cards(proposals);
  await handleSend(deps, who, { text: "make it a window", chatId: old.conversation_id, revise: old.id });
  assertEquals([cards(proposals).length, old.status, old.failure], [1, "ready", null]);
});

Deno.test("Revise is refused, with nothing stored and Claude never asked, on a card past changing or not this person's", async () => {
  const { store, proposals, messages } = makeStore();
  const { deps, claudeBodies } = makeDeps(store, [toolUse("propose_new_door", { ...garage, swing: "out", operation: "slide_up" }), said("On your screen.")]);
  await handleSend(deps, who, { text: "garage door" });
  const [card] = cards(proposals);
  const asked = claudeBodies.length, stored = messages.length;
  // Not this person's: another person's chat, even on the same builder.
  await handleSend(makeDeps(store, [said("hi")]).deps, other, { text: "hello" });
  const theirs = await handleSend(deps, other, { text: "swing in", revise: card.id });
  assertEquals([theirs.status, theirs.body.error], [409, NOT_REVISABLE]);
  // A made-up id, or not an id at all.
  assertEquals((await handleSend(deps, who, { text: "x", revise: "00000000-0000-4000-8000-999999999999" })).status, 409);
  assertEquals((await handleSend(deps, who, { text: "x", revise: "card-1" })).status, 400);
  // Approved, then Revise: refused, and the card comes back as it is now.
  await handleProposalApprove(deps, who, { id: card.id, hash: card.shown_hash });
  const after = await handleSend(deps, who, { text: "swing in", revise: card.id });
  assertEquals([after.status, after.body.error, (after.body.proposal as { status: string; canRevise: boolean }).status, (after.body.proposal as { canRevise: boolean }).canRevise], [409, NOT_REVISABLE, "applied", false]);
  assertEquals([claudeBodies.length, messages.filter((m) => m.chat === card.conversation_id).length], [asked, stored]);
});

Deno.test("which cards can be revised: waiting ones Jack made from a sentence, and a reply draft; never a price list, a guide, a look-up list or a question", () => {
  const row = (kind: string, status = "ready") => ({ kind, status } as ProposalRow);
  for (const k of ["new_fixture", "size_rule", "setup_fixture", "setup_company", "automation_rule", "reply_send", "reply_draft", "insulation_price", "inventory_price"]) assertEquals([k, revisable(row(k))], [k, true]);
  for (const k of ["price_sheet", "setup_guide", "lookup", "memory", "made_up"]) assertEquals([k, revisable(row(k))], [k, false]);
  for (const st of ["applying", "applied", "partly_applied", "undone", "cancelled", "expired", "failed", "needs_answers", "reading"]) assertEquals([st, revisable(row("new_fixture", st))], [st, false]);
});

Deno.test("Revise on a text card: Jack gets the customer by id and the words, and the turn offers no settings or price card", async () => {
  const { store, proposals } = makeStore();
  const { deps, claudeBodies } = makeDeps(store, [said("Hi."), said("Which part should be shorter?")]);
  await handleSend(deps, who, { text: "hi" });
  const contactId = "7d1f3b9e-2c4a-4e8b-9f10-3a5b6c7d8e9f";
  const card = await store.insertProposal({
    client_id: who.clientId, user_id: who.userId, conversation_id: "chat-u1", kind: "reply_send", status: "ready", title: "A reply by text",
    payload: { contactId, dealKey: "SS-1042", channel: "sms", subject: null, body: "Hi Dana, your 10x12 is ready to pick a color. Which one?", to: "+18165550142" },
  } as Partial<ProposalRow> as ProposalRow);
  const r = await handleSend(deps, who, { text: "make it shorter", chatId: "chat-u1", revise: card.id });
  assertEquals(r.status, 200);
  const body = claudeBodies.at(-1)!;
  const sys = systemText(body);
  assert(sys.includes(`their ref is ${contactId}, with list null`) && sys.includes("dealKey SS-1042") && sys.includes("your 10x12 is ready to pick a color"), sys);
  assert(!/8165550142|555-0142/.test(sys), "the number never reaches Claude");
  const names = ((body.tools ?? []) as { name: string }[]).map((t) => t.name);
  for (const n of ["propose_size_changes", "propose_new_door", "propose_insulation_prices", "propose_company_details"]) assert(!names.includes(n), `${n} offered in a customer card's revise turn`);
  assert(names.includes("propose_reply_draft"), names.join(","));
  // No new card: the text card stays as it was.
  assertEquals([proposals.get(card.id)?.status, proposals.get(card.id)?.failure], ["ready", null]);
});

Deno.test("the Revise note never carries a contact detail, and names a card that holds one by its title only", () => {
  const company = { kind: "setup_company", status: "ready", title: "Business details", payload: { fields: [{ key: "businessPhone", to: "(816) 555-0142" }] } } as unknown as ProposalRow;
  const n = reviseNote(company);
  assert(n.includes('"Business details"') && n.includes("Read what you need again with your tools"), n);
  assert(!/555|0142/.test(n), n);
  const door = { kind: "new_fixture", status: "ready", title: "Add a door: Call 816-555-0142", payload: { row: { name: "Call 816-555-0142", widthIn: 36, heightIn: 80, price: 100, swingOut: true, opRight: true } } } as unknown as ProposalRow;
  assert(!/555-0142/.test(reviseNote(door)), reviseNote(door));
  assert(!/[—–]/.test(reviseNote(door) + n));
});
