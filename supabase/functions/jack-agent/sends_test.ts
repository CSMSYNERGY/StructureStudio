// sends.ts and the send half of drafts.ts: cards whose Approve sends. No network: portal-settings is a
// fake that answers crm_record (contact and design records, modelled on the real selects), the rules
// list, and the three send routes, and counts every call. The fixture holds phone numbers, emails and a
// street line, so a leak to Claude shows.

import { assert, assertEquals } from "./test_assert.ts";
import { handleActivity, handleProposalApprove, handleProposalCancel, handleProposalGet, handleProposalUndo, READ_GIVE_UP_MS, SENTENCES, STRICT_LIMITS, strictCost, toolsFor } from "./agent.ts";
import type { Deps, MemoryRow, ProposalRow, Store, StoredMessage, ToolSpec, TurnState, Who } from "./types.ts";
import { PIECE_KINDS, PIECE_TOOLS } from "./pieces.ts";
import { PRIVATE_KINDS, SAID } from "./common.ts";
import { leaksContactDetails } from "./redact.ts";
import { DRAFT_SAID, OLD_PAGE_NOTE, REPLACED, REPLACED_ESTIMATE, SENDS_SWITCH, UNCHECKED, UNPROVEN_DAYS, YIELDED } from "./drafts.ts";
import { classifyEmail, classifyResend, classifySms, makeSentWithJack, RESEND_SAID, SEND_KINDS, SEND_SAID, type SendAnswer, sendsPiece } from "./sends.ts";
import { SEND_RULE_SAID } from "./ruleWarn.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
type Res = { status: number; data: Record<string, unknown> | null };

// 15:00 UTC on Nov 6 is 9am in Missouri (816, Central, standard time): texting hours are open.
const DAY = Date.parse("2026-11-06T15:00:00.000Z");
// 04:00 UTC on Nov 7 is 10pm on Nov 6 in Missouri: closed until 8am Central, 14:00 UTC.
const NIGHT = Date.parse("2026-11-07T04:00:00.000Z");
const OPENS = "2026-11-07T14:00:00.000Z";
const daysAgo = (n: number, from = DAY) => new Date(from - n * 86_400_000).toISOString();

const CID = "11111111-2222-4333-8444-555555555555";
const LEAD = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SMS_ROW = "5a5a5a5a-0000-4000-8000-000000000001";
const EMAIL_ROW = "e1e1e1e1-0000-4000-8000-000000000002";
const who: Who = { clientId: "builder-a", userId: "11111111-0000-4000-8000-0000000000a1", operatorEmail: null };
const teammate: Who = { clientId: "builder-a", userId: "11111111-0000-4000-8000-0000000000a2", operatorEmail: null };
const operator: Who = { clientId: "builder-a", userId: "11111111-0000-4000-8000-0000000000f1", operatorEmail: "ops@example.test" };

const draftTool = PIECE_TOOLS.get("propose_reply_draft") as ToolSpec;
const resendTool = PIECE_TOOLS.get("propose_estimate_resend") as ToolSpec;

// ── The world ─────────────────────────────────────────────────────────────────────────────────────

/** A design row as crm_record's contact branch selects it (no contact snapshot, no contact_id). */
const designRow = (code: string, o: Any) => ({
  short_code: code, created_at: daysAgo(20), updated_at: daysAgo(18), status: "sent", selections: { style: "Lofted Barn", size: "12x24" },
  expected_close_date: null, total_cents: 845000, ghl_estimate_number: null, image_url: null, ss_quote_number: null, ss_quote_pdf_url: null,
  ss_invoice_sent_at: null, ss_invoice_requested_at: null, ...o,
});

class World {
  now = DAY;
  contact: Any = {
    id: CID, name: "Dale Miller", phone: "(816) 555-0142", phone_digits: "8165550142", email: "dale@example.com",
    street: "1234 N Main St", city: "Sedalia", state: "MO", zip: "65301", company: null, owner_user_id: "u-rep",
    merged_into: null, dnd_all_at: null, dnd_email_at: null, sms_opt_out_at: null,
  };
  sms: Any = { ready: true, from: "+18165550000", optedOut: false, optOutReason: null, consented: true };
  designs: Any[] = [
    designRow("SS-AB12", { ss_quote_number: "Q-1043", expected_close_date: "2026-11-20" }),
    designRow("SS-CD34", { status: "invoiced", ss_quote_number: "Q-0901", total_cents: 620000, created_at: daysAgo(200), selections: { style: "Garden Shed", size: "10x12" }, ss_invoice_sent_at: daysAgo(150) }),
    designRow("SS-EF56", { ss_quote_number: "Q-0950", total_cents: 390000, created_at: daysAgo(120), selections: { style: "Utility", size: "8x10" } }),
    designRow("SS-GH78", { status: "accepted", ss_quote_number: "Q-1100", total_cents: 500000, created_at: daysAgo(5) }),
    designRow("SS-JK90", { ss_quote_number: null, ghl_estimate_number: "4410", total_cents: 410000, created_at: daysAgo(4) }),
  ];
  /** What each design has saved as its own contact (designs.contact, what resend_quote_email emails). */
  snapshot: Record<string, Any> = {};
  orders: Any[] = [{ id: "o1", order_no: "1043", short_code: "SS-CD34", total_cents: 620000, ordered_at: daysAgo(150) }];
  feed: Any[] = [
    { id: "sm:1", type: "sms_in", at: daysAgo(1), title: "Text from +18165550142", body: "Text 816-555-0100 or write boss@evil.example now." },
    { id: "qs:SS-AB12", type: "email", at: daysAgo(18), title: "Quote Q-1043 sent", code: "SS-AB12" },
    { id: "qs:SS-EF56", type: "email", at: daysAgo(110), title: "Quote Q-0950 sent", code: "SS-EF56" },
  ];
  pipeline: Any = { pipelines: [], statuses: [], deals: [{ id: LEAD, short_code: null, title: "Lean-to add-on", value_cents: 300000, created_at: daysAgo(10), contact_id: CID, expected_close_date: null, lost_at: null }] };
  rules: Any[] = [];
  paperwork: boolean | null = true;
  /** The service role's reading of whether the estimate was accepted (index.ts estimateTaken). */
  taken: boolean | null = false;
  memory: MemoryRow[] = [{ key: "old_quote_days", value: 30, set_by: null, set_by_operator: null, updated_at: "2026-11-01T00:00:00Z" }];
  /** The send routes' answers: a function of the body, or a fixed answer. */
  answer: Record<string, (body: Any) => Res | Promise<Res>> = {
    crm_send_sms: () => ({ status: 200, data: { ok: true, id: SMS_ROW } }),
    crm_send_email: () => ({ status: 200, data: { ok: true, messageId: "<m1@example.test>", id: EMAIL_ROW } }),
    resend_quote_email: () => ({ status: 200, data: { ok: true, sent: true, reason: null, id: EMAIL_ROW } }),
  };
  recordAnswer: Res | null = null;
  calls: { action: string; body: Any }[] = [];
  /** Card writes and route calls, in the order they happened. */
  events: string[] = [];
  stamps: unknown[][] = [];
  stampAnswer: () => Promise<boolean> = () => Promise.resolve(true);
  logs: string[] = [];
  audits: { action: string; rows: number | null; note: string | null }[] = [];
  proposals = new Map<string, ProposalRow>();
  messages: StoredMessage[] = [];
  seq = 0;
  deps: Deps;

  constructor() {
    // The fakes below are plain functions that reach this world's state.
    // deno-lint-ignore no-this-alias
    const w = this;
    const stamp = () => new Date(w.now).toISOString();
    const store: Store = {
      settings: () => Promise.resolve({ on: true, off: [] }),
      setOff: () => Promise.resolve(),
      usage: () => Promise.resolve({ monthCostMicros: 0, tenant24h: 0, user10m: 0, sheets24h: 0 }),
      openChat: () => Promise.resolve({ id: "chat1" }),
      createChat: () => Promise.resolve("chat1"),
      chats: () => Promise.resolve([]),
      messages: (_who, chatId) => Promise.resolve(w.messages.filter((m) => (m as Any).chatId === chatId)),
      addMessage: (m) => Promise.resolve({ id: `m${++w.seq}`, role: m.role, body: m.body, created_at: stamp(), proposal_ids: m.proposalIds ?? [] }),
      bumpChat: () => Promise.resolve(),
      closeChats: () => Promise.resolve(),
      reopenChat: () => Promise.resolve(true),
      accountLine: () => Promise.resolve({ firstName: "Mike", title: "Owner", business: "Ridgeline", role: "owner" }),
      insertProposal: (p) => {
        const id = `00000000-0000-4000-8000-${String(++w.seq).padStart(12, "0")}`;
        const row = { id, conversation_id: null, file_name: null, source: {}, preview: {}, payload: {}, answers: {}, result: null, undo: null, shown_hash: null, failure: null, approved_by: null, approved_by_operator: null, approved_at: null, applied_at: null, undone_at: null, expires_at: new Date(w.now + 86_400_000).toISOString(), created_at: stamp(), updated_at: stamp(), ...structuredClone(p) } as ProposalRow;
        w.proposals.set(id, row);
        return Promise.resolve(structuredClone(row));
      },
      getProposal: (c, id) => { const r = w.proposals.get(id); return Promise.resolve(r && r.client_id === c ? structuredClone(r) : null); },
      updateProposal: (c, id, patch, when, at) => {
        const r = w.proposals.get(id);
        if (!r || r.client_id !== c || (when && !when.includes(r.status)) || (at && r.updated_at !== at)) return Promise.resolve(null);
        w.events.push(`write ${Object.keys(patch).sort().join(",")}`);
        Object.assign(r, structuredClone(patch), { updated_at: stamp() });
        return Promise.resolve(structuredClone(r));
      },
      addProposalCost: () => Promise.resolve(),
      proposals: () => Promise.resolve([...w.proposals.values()].map((r) => structuredClone(r))),
      proposalsById: (_c, ids) => Promise.resolve(ids.map((i) => w.proposals.get(i)).filter(Boolean).map((r) => structuredClone(r!))),
      names: () => Promise.resolve({}),
      fixtureStamp: () => Promise.resolve(null),
      memory: () => Promise.resolve(structuredClone(w.memory)),
      putMemory: () => Promise.resolve(true),
      forgetMemory: () => Promise.resolve(true),
      paperworkInSS: () => Promise.resolve(w.paperwork),
      estimateTaken: () => Promise.resolve(w.taken),
    };
    this.deps = {
      env: () => undefined,
      store,
      portal: (action, body) => w.route(action, body),
      call(fn, action, body) { return fn === "portal-settings" ? this.portal(action, body) : Promise.resolve({ status: 404, data: null }); },
      wallet: {
        meter: () => Promise.resolve({ active: false, markup: 1.5 }), exempt: () => Promise.resolve(false),
        account: () => Promise.resolve(null), debit: () => Promise.resolve({ ok: true, txId: 1 }), grantOnce: () => Promise.resolve(true),
        requestTopup: () => {}, mark: () => Promise.resolve(), pending: () => Promise.resolve([]),
      },
      fetch: () => { throw new Error("no network in these tests"); },
      canRead: () => true,
      canEdit: () => true,
      background: () => {},
      budgetMs: () => 300_000,
      makeId: () => crypto.randomUUID(),
      // The real hash, so two cards share one only if their payloads are the same.
      hash: async (t) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, "0")).join(""),
      log: (e) => { w.logs.push(e.code); return Promise.resolve(); },
      audit: (action, rows, note) => { w.audits.push({ action, rows, note }); return Promise.resolve(); },
      now: () => w.now,
      markSentWithJack: (table, id, by) => { w.stamps.push([table, id, by]); return w.stampAnswer(); },
    };
  }

  async route(action: string, body: Any): Promise<Res> {
    this.calls.push({ action, body: structuredClone(body) });
    this.events.push(`call ${action}`);
    if (action === "crm_record") {
      if (this.recordAnswer) return structuredClone(this.recordAnswer);
      return { status: 200, data: body.kind === "design" ? this.designRecord(String(body.id)) : this.contactRecord() } as Res;
    }
    if (action === "crm_rules_list") {
      return { status: 200, data: { ok: true, rulesVersion: 2, pipelines: [], team: [], canManage: true, rules: this.rules, labels: [], timeZone: "America/Chicago" } };
    }
    const a = this.answer[action];
    if (a) return await a(body);
    return { status: 500, data: { error: `${action} must never be called` } };
  }

  contactRecord(): Any {
    return {
      ok: true, kind: "contact", contact: { ...this.contact, owner_name: "Mike Rep" },
      designs: this.designs.map((d) => structuredClone(d)), orders: this.orders, feed: this.feed, focus: [], sms: this.sms,
      build: [], delivery: [], people: [], followers: [], team: [], pipeline: this.pipeline,
    };
  }

  designRecord(code: string): Any {
    const d = this.designs.find((x) => x.short_code === code);
    if (!d) return null;
    const snap = this.snapshot[code] ?? { name: "Dale Miller", email: "dale@example.com", phone: "(816) 555-0142" };
    return {
      ok: true, kind: "design", contact: { ...this.contact, owner_name: "Mike Rep" },
      designs: [{ ...structuredClone(d), contact: snap, contact_id: CID }],
      orders: this.orders.filter((o) => o.short_code === code), feed: this.feed.filter((e) => !e.code || e.code === code), sms: this.sms,
    };
  }

  turn(by: Who = who, off: string[] = []): TurnState {
    return { who: by, chatId: "chat1", off, proposalIds: [], memory: Object.fromEntries(this.memory.map((m) => [m.key, { value: m.value, updatedAt: m.updated_at }])) };
  }
  /** The turn's answer is stored with its cards, as handleSend does. */
  endTurn(s: TurnState) {
    this.messages.push({ id: `m${++this.seq}`, role: "assistant", body: "ok", created_at: "now", proposal_ids: [...s.proposalIds], chatId: s.chatId } as Any);
  }
  row(id: string) { return this.proposals.get(id)!; }
  last(kind?: string) { return [...this.proposals.values()].filter((p) => !kind || p.kind === kind).at(-1)!; }
  sends() { return this.calls.filter((c) => /^(crm_send_|resend_quote_email)/.test(c.action)); }
  /** A press of the card's Approve, which says send: true on a send card (portal useJackSend). */
  async press(id: string, by: Who = who) {
    return await handleProposalApprove(this.deps, by, { id, hash: this.row(id).shown_hash, send: true });
  }
  /** The person's own answer to the old_quote_days question card in this chat (memory.ts handleMemoryPick
   *  writes it so), stored with the turn that asked it. */
  async answered(value: number, by: Who = who, chatId = "chat1") {
    const q = await this.deps.store.insertProposal({
      client_id: by.clientId, user_id: by.userId, conversation_id: chatId, kind: "memory", status: "applied", title: "How old",
      preview: { key: "old_quote_days" }, payload: { key: "old_quote_days", basedOn: null }, shown_hash: null,
      approved_by: by.userId, result: { value, label: `${value} days`, remembered: false, notKeptWhy: "role" },
    } as never);
    this.messages.push({ id: `m${++this.seq}`, role: "assistant", body: "ok", created_at: "now", proposal_ids: [q.id], chatId } as Any);
    return q;
  }
}

const GOOD = "Hi Dale, checking in on your 12x24 Lofted Barn estimate at $8,450. Mike at Ridgeline";
const text = (body = GOOD, dealKey: string | null = "SS-AB12") => ({ list: null, ref: CID, dealKey, channel: "sms", subject: null, body, oldQuoteDays: null });
const email = (body = GOOD, subject = "Your barn estimate", dealKey: string | null = "SS-AB12") => ({ list: null, ref: CID, dealKey, channel: "email", subject, body, oldQuoteDays: null });
const resend = (dealKey = "SS-AB12", oldQuoteDays: number | null = null) => ({ list: null, ref: CID, dealKey, oldQuoteDays });

async function sendCard(w: World, input: Any = text(), by: Who = who, off: string[] = []): Promise<ProposalRow> {
  const s = w.turn(by, off);
  const out = await draftTool.run(w.deps, s, input);
  assert(!out.isError, out.content);
  w.endTurn(s);
  return w.last();
}
async function resendCard(w: World, input: Any = resend(), by: Who = who): Promise<ProposalRow> {
  const s = w.turn(by);
  const out = await resendTool.run(w.deps, s, input);
  assert(!out.isError, out.content);
  w.endTurn(s);
  return w.last();
}

/** What may never reach Claude: the customer's numbers, addresses and street. */
function assertNothingPrivate(content: string) {
  assert(!leaksContactDetails(content), content);
  for (const bad of ["8165550142", "555-0142", "555-0100", "@", "Main St", "65301", "evil"]) assert(!content.includes(bad), `${bad} reached Claude: ${content}`);
}

// ── Which card a reply makes ──────────────────────────────────────────────────────────────────────

Deno.test("a reply makes a card with Approve when this person may send it, and v1's Copy card when not", async () => {
  // On by default: text and email both send.
  for (const input of [text(), email()]) {
    const w = new World();
    const s = w.turn();
    const out = await draftTool.run(w.deps, s, input);
    assert(!out.isError, out.content);
    assertNothingPrivate(out.content);
    const p = w.last();
    assertEquals([p.kind, p.preview.sendable, p.status], ["reply_send", true, "ready"]);
    const said = JSON.parse(out.content);
    assertEquals(said.sendable, true);
    assert(/presses Approve on the card/.test(said.note) && /can't press it/.test(said.note) && !/\bSend\b/.test(said.note), said.note);
    assertEquals(w.sends().length, 0, "making a card sent something");
  }
  // The switch off: v1's card, and Claude is told there is no Approve button.
  const off = new World();
  const out = await draftTool.run(off.deps, off.turn(who, ["sends"]), text());
  assertEquals([off.last().kind, off.last().preview.sendable, off.last().preview.ruleNotes, off.last().preview.quiet], ["reply_draft", false, [], null]);
  assert(/no Approve button/.test(JSON.parse(out.content).note));
  // The team in view-as: a text is v1's card (the record page hides texting there), an email sends.
  const op = new World();
  await draftTool.run(op.deps, op.turn(operator), text());
  assertEquals(op.last().kind, "reply_draft");
  assert(op.last().preview.notes.includes("Texting from their record isn't available while you're viewing another account."));
  await draftTool.run(op.deps, op.turn(operator), email());
  assertEquals(op.last().kind, "reply_send");
  assert(op.last().preview.notes.includes("No signature is added while you're viewing another account."));
  // Without contacts edit there's no card at all, as in v1.
  const viewer = new World();
  viewer.deps = { ...viewer.deps, canEdit: (a: string) => a !== "contacts" };
  assertEquals((await draftTool.run(viewer.deps, viewer.turn(), text())).content, DRAFT_SAID.noSend);
});

Deno.test("a send card's preview: v1's keys plus sendable, ruleNotes and quiet; the payload holds a nonce, so the same words never share a hash", async () => {
  const w = new World();
  w.rules = [{ id: "r1", name: "Made contact", scopeKind: "pipeline", triggerKind: "event", triggerEvent: "contact_made", elapsedAnchor: null, actions: [{ kind: "send_email", params: {} }], enabled: true, stale: [] }];
  const a = await sendCard(w);
  assertEquals(Object.keys(a.preview).sort(), ["body", "channel", "company", "contactId", "dealKey", "dealLabel", "factsUsed", "firstName", "fullName", "notes", "quiet", "ruleNotes", "sendable", "subject", "town"]);
  // Who it goes to, whole: one press sends.
  assertEquals([a.preview.fullName, a.preview.town, a.preview.company], ["Dale Miller", "Sedalia, MO", null]);
  assertEquals(a.preview.ruleNotes, ['This text can set off your rule "Made contact" (it starts when contact is made), which texts or emails the customer by itself.']);
  // A page from before round 2 shows only the notes, and its Approve sends nothing: the note says reload,
  // never that Approve sends.
  assert(a.preview.notes.includes(OLD_PAGE_NOTE.text), JSON.stringify(a.preview.notes));
  assert(!a.preview.notes.some((n: string) => /Approve (sends|emails)/.test(n)), JSON.stringify(a.preview.notes));
  assertEquals(Object.keys(a.payload).sort(), ["body", "channel", "contactId", "daysCard", "dealKey", "nonce", "oldQuoteDays", "subject"]);
  const b = await sendCard(w, email());
  const c = await sendCard(w, email());
  assert(b.shown_hash !== c.shown_hash, "two identical drafts share a hash");
  // Nothing private on the card either: no number, no address.
  for (const p of [a, b, c]) assert(!/555-0142|8165550142|@example|Main St/.test(JSON.stringify([p.preview, p.payload, p.title])), p.kind);
  // An email can't set off the contact-made rule; someone who can't open Automations hears no names.
  assertEquals(b.preview.ruleNotes, []);
  const blind = new World();
  blind.rules = w.rules;
  blind.deps = { ...blind.deps, canRead: (x: string) => x !== "settings_crm" };
  assertEquals((await sendCard(blind)).preview.ruleNotes, [SEND_RULE_SAID.text]);
});

Deno.test("a text drafted at night says when texting hours open; an email doesn't", async () => {
  const w = new World();
  w.now = NIGHT;
  const s = w.turn();
  const out = await draftTool.run(w.deps, s, text());
  const p = w.last();
  assertEquals(p.preview.quiet.opensAt, OPENS);
  // The rule's window, which stays true while the card waits; never "It is 10pm", wrong by morning.
  assertEquals(p.preview.quiet.sentence, "Texts can only go out between 8am and 9pm where this customer lives.");
  // Claude hears only that it's quiet, not the hour or the number, and never "8am their time".
  const said = JSON.parse(out.content);
  assertEquals(said.quietHoursNow, true);
  assert(!out.content.includes("10pm") && !out.content.includes(OPENS) && !/8am/.test(said.note), said.note);
  assert(/once texting hours open there/.test(said.note), said.note);
  // Nothing is scheduled: a press before then sends nothing, so Claude never says it will go by itself.
  assert(!/will go/.test(said.note) && /Approve sends nothing until they open, and nothing goes by itself later/.test(said.note), said.note);
  assert(!/right away/.test(said.note) && /only inside texting hours where they live/.test(said.note), said.note);
  assertEquals((await sendCard(w, email())).preview.quiet, null);
});

// ── Send: a text and an email, once ───────────────────────────────────────────────────────────────

Deno.test("Approve on a text: one crm_send_sms with exactly the card's words, stamped with Jack, no Undo, and never again", async () => {
  const w = new World();
  const p = await sendCard(w);
  w.events = [];
  const r = await w.press(p.id);
  assertEquals(r.status, 200);
  assertEquals(w.sends(), [{ action: "crm_send_sms", body: { contactId: CID, shortCode: "SS-AB12", body: GOOD } }]);
  // The claim, the fresh read, then Undo cleared off the row BEFORE the one send, then the last write.
  assertEquals(w.events, [
    "write approved_at,approved_by,approved_by_operator,status", "call crm_record", "write undo", "call crm_send_sms",
    "write applied_at,result,status,undo",
  ]);
  const row = w.row(p.id);
  assertEquals(row.status, "applied");
  assertEquals(row.result, { sent: 1, channel: "sms", at: new Date(DAY).toISOString(), ledgerId: SMS_ROW });
  assertEquals(row.undo, null);
  assertEquals(row.approved_by, who.userId);
  assertEquals((r.body.proposal as Any).canUndo, false);
  assertEquals(w.stamps, [["sms_messages", SMS_ROW, who.userId]]);
  assertEquals(w.audits.find((a) => a.action === "jack_approve")?.rows, 1);
  // It was read again as the caller right before the send.
  assertEquals(w.calls.filter((c) => c.action === "crm_record").length, 2);
  // A second press, and Undo, reach nothing.
  assertEquals((await w.press(p.id)).status, 409);
  assertEquals((await handleProposalUndo(w.deps, who, { id: p.id })).status, 409);
  assertEquals(w.sends().length, 1);
});

Deno.test("Approve on an email: one crm_send_email with the subject and words, stamped on email_sends", async () => {
  const w = new World();
  const p = await sendCard(w, email("Hi Dale,\n\nAny questions on the barn?", "Your barn", null));
  await w.press(p.id);
  // No deal picked: no shortCode, the route files it by the contact.
  assertEquals(w.sends(), [{ action: "crm_send_email", body: { contactId: CID, subject: "Your barn", body: "Hi Dale,\n\nAny questions on the barn?" } }]);
  assertEquals(w.row(p.id).result, { sent: 1, channel: "email", at: new Date(DAY).toISOString(), ledgerId: EMAIL_ROW });
  assertEquals(w.stamps, [["email_sends", EMAIL_ROW, who.userId]]);
});

Deno.test("Send files a reply under the deal's design: a pipeline card of a design is that design, a lead has none", async () => {
  const w = new World();
  w.pipeline.deals.push({ id: "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee", short_code: "SS-AB12", title: "12x24 barn", value_cents: 845000, created_at: daysAgo(20), contact_id: CID, expected_close_date: null, lost_at: null });
  await w.press((await sendCard(w, text("Hi Dale, any questions?", "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee"))).id);
  await w.press((await sendCard(w, email("Hi Dale, about the lean-to.", "Lean-to", LEAD))).id);
  await w.press((await sendCard(w, text("Hi Dale, your shed order.", "SS-CD34"))).id);
  assertEquals(w.sends().map((c) => c.body.shortCode ?? null), ["SS-AB12", null, "SS-CD34"]);
});

Deno.test("a stamp that fails, or a route answer with no row id, still counts as sent", async () => {
  const w = new World();
  w.stampAnswer = () => Promise.reject(new Error("column sent_with does not exist"));
  const p = await sendCard(w);
  await w.press(p.id);
  assertEquals([w.row(p.id).status, w.row(p.id).result.sent], ["applied", 1]);
  assert(w.logs.includes("jack_sent_with_failed"));
  const w2 = new World();
  w2.stampAnswer = () => Promise.resolve(false);
  w2.answer.crm_send_email = () => ({ status: 200, data: { ok: true, messageId: "x" } });
  const q = await sendCard(w2, email());
  await w2.press(q.id);
  assertEquals([w2.row(q.id).status, w2.row(q.id).result.ledgerId], ["applied", null]);
  assertEquals(w2.stamps, [], "a row without an id was stamped");
  // ...and the gap is said once, so it shows (a route deployed ahead of this jack-agent).
  assertEquals(w2.logs.filter((l) => l === "jack_sent_with_no_id").length, 1);
  assert(!w.logs.includes("jack_sent_with_no_id"), "a sent answer with an id was logged as having none");
  // A deps with no stamp at all (an old harness) still sends once and counts it.
  const w3 = new World();
  // deno-lint-ignore no-explicit-any
  (w3.deps as any).markSentWithJack = undefined;
  const r = await sendCard(w3);
  await w3.press(r.id);
  assertEquals([w3.row(r.id).status, w3.sends().length], ["applied", 1]);
});

// ── The checks repeat right before the send ───────────────────────────────────────────────────────

Deno.test("at the press, a fresh read refuses what changed since the card: nothing is sent and the card says why", async () => {
  const nothing = (s: string) => `${s} ${SEND_SAID.nothingSent}`;
  const cases: [string, (w: World) => void, Any, string][] = [
    ["Do Not Disturb", (w) => { w.contact.dnd_all_at = daysAgo(0); }, text(), "They're on Do Not Disturb for everything now, so nothing was sent. That's set on their record."],
    ["Do Not Disturb on email", (w) => { w.contact.dnd_email_at = daysAgo(0); }, email(), "They've turned off email from you since this was written (Email Do Not Disturb), so nothing was sent."],
    ["merged", (w) => { w.contact.merged_into = "33333333-2222-4333-8444-555555555555"; }, email(), "That customer was merged into another record, so nothing was sent. Look them up again and ask me to write it there."],
    ["STOP", (w) => { w.sms.optedOut = true; }, text(), "They've opted out of texts since this was written, so nothing was sent."],
    ["consent gone", (w) => { w.sms.consented = false; }, text(), "There's no consent to text on file for them now, so nothing was sent."],
    ["deal gone", (w) => { w.designs = w.designs.filter((d) => d.short_code !== "SS-AB12"); }, text("Hi Dale, any questions on the barn?"), "That deal isn't on this customer's record any more, so nothing was sent."],
    ["texting off", (w) => { w.sms.ready = false; }, text(), nothing(DRAFT_SAID.smsNotReady)],
    ["no email now", (w) => { w.contact.email = null; }, email(), nothing(DRAFT_SAID.noEmail)],
    ["no phone now", (w) => { w.contact.phone = null; w.contact.phone_digits = null; }, text(), nothing(DRAFT_SAID.noPhone)],
    // The fact guard again: the estimate's total moved, so $8,450 is no longer on the record. Said
    // without the amounts: a card's failure is kept for good.
    ["price moved", (w) => { w.designs[0].total_cents = 860000; }, text(), SEND_SAID.factsMoved],
    ["date moved", (w) => { w.designs[0].expected_close_date = "2026-11-27"; }, text("Hi Dale, we could have it by Nov 20. Mike"), SEND_SAID.factsMoved],
    // ...and the builder's rule tightened: an 18-day-old estimate's price is past 10 days now.
    ["old rule", (w) => { w.memory[0].value = 10; }, text(), SEND_SAID.priceTooOld],
  ];
  for (const [name, change, input, said] of cases) {
    const w = new World();
    const p = await sendCard(w, input);
    change(w);
    const r = await w.press(p.id);
    assertEquals(r.status, 200, name);
    const row = w.row(p.id);
    assertEquals(row.status, "failed", name);
    assertEquals(row.failure, said, name);
    // Never the drafting words Claude was given: who writes what, or a dealKey.
    assert(!/I won't write|dealKey|Use one from their record|leave it out for the rep/.test(String(row.failure)), `${name}: ${row.failure}`);
    assert(!/\$|Nov 20/.test(String(row.failure)), `${name} kept the record's amounts or the draft's words: ${row.failure}`);
    assertEquals(w.sends().length, 0, `${name} still sent`);
    assertEquals(w.stamps.length, 0);
  }
});

Deno.test("at the press, a read that fails or a customer no longer theirs ('own' reps) sends nothing", async () => {
  for (const [answer, said] of [
    [{ status: 404, data: { error: "That contact no longer exists." } }, `${DRAFT_SAID.notFound} ${SEND_SAID.nothingSent}`],
    // The card is done, so a failed read says to ask again, never "Please try again" with nothing to press.
    [{ status: 500, data: null }, SEND_SAID.readAtPress],
    [{ status: 403, data: { error: "The Customer Hub is not part of your subscription - add it under Settings -> Billing." } }, `${SAID.noCrm} ${SEND_SAID.nothingSent}`],
  ] as [Res, string][]) {
    const w = new World();
    const p = await sendCard(w);
    w.recordAnswer = answer;
    await w.press(p.id);
    assertEquals([w.row(p.id).status, w.row(p.id).failure, w.sends().length], ["failed", said, 0]);
    assert(!/try again/i.test(String(w.row(p.id).failure)), String(w.row(p.id).failure));
  }
  // The record still opens, and the send route's own row scope refuses: that 404 is the answer, once.
  const w = new World();
  w.answer.crm_send_sms = () => ({ status: 404, data: { error: "That customer is not one of yours." } });
  const p = await sendCard(w);
  await w.press(p.id);
  assertEquals([w.row(p.id).status, w.row(p.id).failure, w.sends().length], ["failed", "That customer is not one of yours. Nothing was sent.", 1]);
  assertEquals(w.stamps.length, 0);
});

Deno.test("quiet hours: a text pressed at night goes back to ready with when it opens, and a press in the morning sends it", async () => {
  const w = new World();
  const p = await sendCard(w);
  w.now = NIGHT;
  const r = await w.press(p.id);
  assertEquals(r.status, 200);
  const row = w.row(p.id);
  assertEquals(row.status, "ready");
  assertEquals(row.result.waiting.reason, "quiet_hours");
  assertEquals(row.result.waiting.retryAt, OPENS);
  assertEquals(row.result.waiting.sentence, `${SEND_SAID.nothingSent} Texts can only go out between 8am and 9pm where this customer lives.`);
  assertEquals([row.approved_by, row.approved_at, row.applied_at], [null, null, null]);
  assertEquals(w.sends().length, 0, "a text went out in quiet hours");
  assertEquals((r.body.proposal as Any).hash, p.shown_hash);
  // 8:30am their time, inside the card's 24 hours: the same card and hash send it, once.
  w.now = Date.parse(OPENS) + 30 * 60_000;
  await w.press(p.id);
  assertEquals([w.row(p.id).status, w.sends().length], ["applied", 1]);
  // Email has no quiet hours.
  const e = new World();
  e.now = NIGHT;
  const q = await sendCard(e, email());
  await e.press(q.id);
  assertEquals(e.row(q.id).status, "applied");
});

Deno.test("quiet hours use every number the record holds: quiet on either is quiet", async () => {
  const w = new World();
  // At 04:30 UTC the texted number (a Pacific one) reads 8:30pm, still open; the stored digits (a
  // Central one) read 10:30pm, closed.
  w.contact.phone = "(415) 555-0142";
  w.now = Date.parse("2026-11-07T04:30:00.000Z");
  const p = await sendCard(w, text("Hi Dale, any questions?", null));
  await w.press(p.id);
  assertEquals([w.row(p.id).status, w.row(p.id).result?.waiting?.reason, w.sends().length], ["ready", "quiet_hours", 0]);
});

Deno.test("a wallet topping up waits and a later press sends; an empty wallet, STOP and the rest are refusals said in a sentence", async () => {
  const w = new World();
  let topped = false;
  w.answer.crm_send_sms = () => topped
    ? { status: 200, data: { ok: true, id: SMS_ROW } }
    : { status: 400, data: { error: "Your wallet is being topped up. Try again in a minute.", reason: "wallet_empty" } };
  const p = await sendCard(w);
  await w.press(p.id);
  assertEquals(w.row(p.id).status, "ready");
  assertEquals(w.row(p.id).result.waiting, { reason: "wallet_topping_up", sentence: "Nothing was sent. Your wallet is being topped up. Try again in a minute.", retryAt: null });
  topped = true;
  await w.press(p.id);
  assertEquals([w.row(p.id).status, w.sends().length], ["applied", 2]);
  assertEquals(w.row(p.id).result, { sent: 1, channel: "sms", at: new Date(DAY).toISOString(), ledgerId: SMS_ROW });

  // A card that waited and is then pressed into a send that stalls: the old wait is gone from it, and
  // the give-up says it may have gone, nothing else.
  const st = new World();
  let hang = false;
  st.answer.crm_send_sms = () => hang ? new Promise(() => {}) : { status: 400, data: { error: "Your wallet is being topped up. Try again in a minute.", reason: "wallet_empty" } };
  const sp = await sendCard(st);
  await st.press(sp.id);
  assertEquals(st.row(sp.id).result.waiting.reason, "wallet_topping_up");
  hang = true;
  void st.press(sp.id);
  await new Promise((r) => setTimeout(r, 0));
  assertEquals([st.row(sp.id).status, st.row(sp.id).result], ["applying", null]);
  st.now += READ_GIVE_UP_MS + 60_000;
  const gone = (await handleProposalGet(st.deps, who, { id: sp.id })).body.proposal as Any;
  assertEquals([gone.status, gone.result], ["partly_applied", { reports: [{ label: sp.title, status: "error", reason: SEND_SAID.unsure }] }]);
  assertEquals(st.sends().length, 2);

  const refusals: [string, Res, string][] = [
    ["sms", { status: 400, data: { error: "Your wallet is empty. Add funds in Settings, Billing.", reason: "wallet_empty" } }, "Your wallet is empty. Add funds in Settings, Billing. Nothing was sent."],
    ["sms", { status: 400, data: { error: "This customer replied STOP, so we cannot text them. They can reply START to that same number to opt back in.", reason: "opted_out" } }, "This customer replied STOP, so we cannot text them. They can reply START to that same number to opt back in. Nothing was sent."],
    ["sms", { status: 400, data: { error: "We don't have this customer's permission to text them yet.", reason: "no_consent" } }, "We don't have this customer's permission to text them yet. Nothing was sent."],
    ["sms", { status: 409, data: { error: "This number is still being registered with the carriers. Texting switches on by itself once that clears.", reason: "not_active" } }, "This number is still being registered with the carriers. Texting switches on by itself once that clears. Nothing was sent."],
    // A carrier's no and a damaged number: Jack's own sentence, since the card has no Approve to try again with.
    ["sms", { status: 400, data: { error: "The text could not be sent (carrier code 30007). Try again, or call them instead.", reason: "failed" } }, "The carrier refused the text (carrier code 30007), so nothing was sent. Ask me to write it again, or call them instead."],
    ["sms", { status: 400, data: { error: "This phone number looks damaged — its last digit was lost when it was first saved. Re-enter it on the contact, then try again.", reason: "damaged_number" } }, SEND_SAID.damagedNumber],
    ["sms", { status: 403, data: { error: "This operator account is read-only." } }, "This operator account is read-only. Nothing was sent."],
    ["email", { status: 400, data: { error: "A reply to this email would reach nobody. Assign the customer to someone on the team first." } }, "A reply to this email would reach nobody. Assign the customer to someone on the team first. Nothing was sent."],
    ["email", { status: 503, data: { error: "Email sending isn't switched on for your account yet — connect your sending domain in Settings → Email Sending." } }, SEND_SAID.emailOff],
  ];
  for (const [ch, answer, said] of refusals) {
    const x = new World();
    x.answer[ch === "sms" ? "crm_send_sms" : "crm_send_email"] = () => answer;
    const q = await sendCard(x, ch === "sms" ? text() : email());
    await x.press(q.id);
    assertEquals([x.row(q.id).status, x.row(q.id).failure, x.sends().length, x.stamps.length], ["failed", said, 1, 0], said);
    assertEquals((await x.press(q.id)).status, 409);
    assertEquals(x.sends().length, 1);
  }
  // Not switched on names the page as it is in Settings (setup.ts says it the same way), not the route's
  // old name for it.
  assert(SEND_SAID.emailOff.endsWith("Set up your sending domain on Settings > Customer Hub > Email Settings.") && !/Email Sending/.test(SEND_SAID.emailOff), SEND_SAID.emailOff);
});

Deno.test("an unclear answer says check their record first, has no Approve and no Undo, and the route is never called again", async () => {
  const cases: [string, () => Res | Promise<Res>][] = [
    ["sms", () => ({ status: 0, data: null })],
    ["sms", () => ({ status: 500, data: { error: "Something went wrong" } })],
    ["sms", () => ({ status: 504, data: null })],
    ["sms", () => ({ status: 200, data: null })],
    ["sms", () => ({ status: 200, data: { sent: true } })],
    ["sms", () => ({ status: 400, data: { error: "The text could not be sent. Try again, or call them instead.", reason: "failed" } })],
    ["sms", () => Promise.reject(new Error("network"))],
    ["email", () => ({ status: 502, data: { error: "That email didn't send (resend 500). Try again." } })],
    ["email", () => ({ status: 503, data: null })],
    ["email", () => ({ status: 0, data: null })],
  ];
  for (const [ch, answer] of cases) {
    const w = new World();
    w.answer[ch === "sms" ? "crm_send_sms" : "crm_send_email"] = answer;
    const p = await sendCard(w, ch === "sms" ? text() : email());
    const r = await w.press(p.id);
    const row = w.row(p.id);
    assertEquals(row.status, "partly_applied", String(answer));
    assertEquals(row.result.reports.map((x: Any) => x.reason), [SEND_SAID.unsure]);
    assertEquals([row.undo, (r.body.proposal as Any).canUndo, w.stamps.length], [null, false, 0]);
    assertEquals((await w.press(p.id)).status, 409);
    assertEquals(w.sends().length, 1, "an unclear send was tried again");
  }
});

Deno.test("a send still going past the give-up time says it may have gone, never 'saved', and isn't sent again", async () => {
  const w = new World();
  w.answer.crm_send_sms = () => new Promise(() => {});
  const p = await sendCard(w);
  void w.press(p.id);
  await new Promise((r) => setTimeout(r, 0));
  assertEquals([w.row(p.id).status, w.row(p.id).undo, w.sends().length], ["applying", null, 1]);
  w.now += READ_GIVE_UP_MS + 60_000;
  const got = await handleProposalGet(w.deps, who, { id: p.id });
  const v = got.body.proposal as Any;
  assertEquals(v.status, "partly_applied");
  assertEquals(v.result.reports.map((x: Any) => x.reason), [SEND_SAID.unsure]);
  assert(!/saved/.test(JSON.stringify(v.result)));
  assertEquals(v.canUndo, false);
  assertEquals((await w.press(p.id)).status, 409);
  assertEquals(w.sends().length, 1);
});

Deno.test("a press that throws after the route was called says it may have gone, with the send kind's own sentence", async () => {
  const w = new World();
  // The route answered, and reading the answer threw: the text may well have gone.
  w.answer.crm_send_sms = () => ({ status: 200, get data(): Any { throw new Error("boom"); } });
  const p = await sendCard(w);
  await w.press(p.id);
  assertEquals(w.row(p.id).status, "partly_applied");
  assertEquals(w.row(p.id).result.reports.map((x: Any) => x.reason), [SEND_SAID.unsure]);
  assertEquals([w.row(p.id).undo, w.stamps.length], [null, 0]);
  assert(w.logs.includes("jack_apply_fault"));
  assertEquals(w.sends().length, 1);
  assertEquals((await w.press(p.id)).status, 409);
  assertEquals(w.sends().length, 1);
});

Deno.test("a read that throws before the send sent nothing, and says so", async () => {
  for (const kind of ["reply", "estimate"]) {
    const w = new World();
    const p = kind === "reply" ? await sendCard(w) : await resendCard(w);
    const real = w.deps.portal;
    w.deps = { ...w.deps, portal: (a, b) => (a === "crm_record" ? Promise.reject(new Error("boom")) : real(a, b)) };
    await w.press(p.id);
    assertEquals([w.row(p.id).status, w.row(p.id).failure, w.sends().length], ["failed", SEND_SAID.readAtPress, 0], kind);
  }
  // What the builder remembers, read again at the press, failing: the same, on both kinds.
  for (const kind of ["reply", "estimate"]) {
    const w = new World();
    const p = kind === "reply" ? await sendCard(w) : await resendCard(w);
    w.deps.store.memory = () => Promise.reject(new Error("boom"));
    await w.press(p.id);
    assertEquals([w.row(p.id).status, w.row(p.id).failure, w.sends().length], ["failed", SEND_SAID.readAtPress, 0], `memory, ${kind}`);
  }
  // The press-time sentence names the next step a person can take, and never the drafting words.
  assert(/nothing was sent/.test(SEND_SAID.readAtPress) && /Ask me again/.test(SEND_SAID.readAtPress) && !/try again/i.test(SEND_SAID.readAtPress));
});

// ── Who may press it ──────────────────────────────────────────────────────────────────────────────

Deno.test("the team in view-as may send an email and never a text; a refused press leaves the card ready for its asker", async () => {
  const w = new World();
  const t = await sendCard(w);
  const r = await w.press(t.id, operator);
  assertEquals([r.status, r.body.error], [403, SEND_SAID.operatorText]);
  assertEquals([w.row(t.id).status, w.row(t.id).approved_by, w.sends().length], ["ready", null, 0]);
  // The asker still can.
  await w.press(t.id);
  assertEquals(w.row(t.id).status, "applied");
  // An email: the operator's press sends, as the operator, and the stamp names them.
  const e = await sendCard(w, email());
  await w.press(e.id, operator);
  assertEquals([w.row(e.id).status, w.row(e.id).approved_by_operator], ["applied", operator.operatorEmail]);
  assertEquals(w.stamps.at(-1), ["email_sends", EMAIL_ROW, operator.userId]);
});

Deno.test("a teammate can't see, press or cancel someone's send card, and the activity page gives no hash on a send card, the asker's own included", async () => {
  const w = new World();
  const p = await sendCard(w);
  assertEquals((await handleProposalApprove(w.deps, teammate, { id: p.id, hash: p.shown_hash })).status, 404);
  assertEquals((await handleProposalCancel(w.deps, teammate, { id: p.id })).status, 404);
  const theirs = ((await handleActivity(w.deps, teammate)).body.activity as Any[]).find((x) => x.id === p.id);
  assertEquals([theirs.private, theirs.hash, theirs.result], [true, null, null]);
  assert(!JSON.stringify(theirs).includes("Dale"));
  // The asker's own row keeps what it says, and still no hash: the page has no button there, and a press
  // echoes the hash (11-09).
  const mine = ((await handleActivity(w.deps, who)).body.activity as Any[]).find((x) => x.id === p.id);
  assertEquals([mine.private ?? false, mine.hash, mine.status], [false, null, "ready"]);
  assertEquals(w.sends().length, 0);
});

Deno.test("switches and access at the press: sends off or customers off refuses before the claim; no contacts edit refuses", async () => {
  // agent.ts approvePiece names sending by this key.
  assertEquals(SENDS_SWITCH, "sends");
  for (const off of [["sends"], ["customers"]]) {
    const w = new World();
    const p = await sendCard(w);
    w.deps.store.settings = () => Promise.resolve({ on: true, off });
    const r = await w.press(p.id);
    // Sending alone names sending (11-09): the person can see the other switches are on. Customers off is the plain sentence.
    assertEquals([r.status, r.body.error, w.row(p.id).status, w.sends().length], [403, off[0] === "sends" ? SENTENCES.sendsOff : SAID.switchedOff, "ready", 0]);
  }
  const w = new World();
  const p = await sendCard(w);
  w.deps = { ...w.deps, canEdit: (a: string) => a !== "contacts" };
  assertEquals((await w.press(p.id)).status, 403);
  assertEquals(w.sends().length, 0);
  // A card a day old has expired: nothing to press.
  const old = new World();
  const q = await sendCard(old);
  old.now += 25 * 3_600_000;
  assertEquals((await old.press(q.id)).status, 409);
  assertEquals(old.sends().length, 0);
});

// ── A newer draft replaces an older one ───────────────────────────────────────────────────────────

Deno.test("a newer draft for the same customer and channel cancels the older one waiting in the chat, so only one can be sent", async () => {
  const w = new World();
  const first = await sendCard(w, text("Hi Dale, any questions?"));
  const other = await sendCard(w, email());
  const second = await sendCard(w, text("Hi Dale, any questions on the barn?"));
  assertEquals([w.row(first.id).status, w.row(first.id).failure], ["cancelled", REPLACED]);
  assertEquals(w.row(other.id).status, "ready", "an email was replaced by a text");
  assertEquals(w.row(second.id).status, "ready");
  assertEquals((await w.press(first.id)).status, 409);
  assertEquals(w.sends().length, 0);
  await w.press(second.id);
  assertEquals(w.sends().map((c) => c.body.body), ["Hi Dale, any questions on the barn?"]);

  // Two in one turn: the second replaces the first too, and Claude hears it.
  const x = new World();
  const s = x.turn();
  await draftTool.run(x.deps, s, text("Hi Dale, one."));
  const out = await draftTool.run(x.deps, s, text("Hi Dale, two."));
  assertEquals(JSON.parse(out.content).replacedOlderDrafts, 1);
  assertEquals([...x.proposals.values()].map((p) => p.status), ["cancelled", "ready"]);

  // Two in the same round run side by side: they never cancel each other, so exactly one stays, the newest,
  // and one of the two answers tells Claude (the newer replaced the older, or the older was put away).
  for (const make of [() => text("Hi Dale, one."), () => email("Hi Dale, one.")]) {
    const pw = new World();
    const ps = pw.turn();
    const outs = (await Promise.all([draftTool.run(pw.deps, ps, make()), draftTool.run(pw.deps, ps, { ...make(), body: "Hi Dale, two." })])).map((o) => JSON.parse(o.content));
    assertEquals([...pw.proposals.values()].map((p) => p.status), ["cancelled", "ready"]);
    assert(outs.some((o) => o.replacedOlderDrafts === 1 || o.replacedByNewer === true), JSON.stringify(outs));
    assertEquals(outs.filter((o) => o.putAway).length <= 1, true);
  }
  const pr = new World();
  const prs = pr.turn();
  await Promise.all([resendTool.run(pr.deps, prs, resend()), resendTool.run(pr.deps, prs, resend())]);
  assertEquals([...pr.proposals.values()].map((p) => p.status), ["cancelled", "ready"]);

  // A card already being sent is left alone, and the new one is put away instead; another chat's is left.
  const y = new World();
  y.answer.crm_send_sms = () => new Promise(() => {});
  const going = await sendCard(y);
  void y.press(going.id);
  await new Promise((r) => setTimeout(r, 0));
  const held = await sendCard(y, text("Hi Dale, again."));
  assertEquals(y.row(going.id).status, "applying");
  assertEquals([y.row(held.id).status, y.row(held.id).failure], ["cancelled", YIELDED]);
  const z = new World();
  const elsewhere = await sendCard(z);
  z.row(elsewhere.id).conversation_id = "chat2";
  await sendCard(z, text("Hi Dale, again."));
  assertEquals(z.row(elsewhere.id).status, "ready");
});

// ── Estimates, sent again ─────────────────────────────────────────────────────────────────────────

Deno.test("estimate card: what it shows, what it holds, and nothing private to Claude", async () => {
  const w = new World();
  w.rules = [{ id: "r1", name: "They opened it", scopeKind: "pipeline", triggerKind: "event", triggerEvent: "email_opened", elapsedAnchor: null, actions: [{ kind: "add_note", params: {} }], enabled: true, stale: [] }];
  const s = w.turn();
  const out = await resendTool.run(w.deps, s, resend());
  assert(!out.isError, out.content);
  assertNothingPrivate(out.content);
  const p = w.last();
  assertEquals([p.kind, p.status, p.title], ["estimate_resend", "ready", "An estimate to send again"]);
  assertEquals(p.preview, {
    contactId: CID, dealKey: "SS-AB12", firstName: "Dale", fullName: "Dale Miller", company: null, town: "Sedalia, MO", dealLabel: "12x24 Lofted Barn, estimate Q-1043",
    // Its age is from when it was made (20 days), not from its last send (18): a send never re-prices it.
    estimateNumber: "Q-1043", total: "$8,450", lastSentOn: daysAgo(18), ageDays: 20,
    notes: [OLD_PAGE_NOTE.email, "Its sent date moves to today, so the count of days with no answer starts again today."],
    ruleNotes: ['If they open the estimate email, that can set off your rule "They opened it" later, which runs by itself.'],
  });
  const { nonce, ...rest } = p.payload;
  // What the card showed, pinned: the total and the design's own stamp, so a press sends this estimate.
  assertEquals(rest, { contactId: CID, dealKey: "SS-AB12", estimateNumber: "Q-1043", totalCents: 845000, updatedAt: daysAgo(18), oldQuoteDays: null, daysCard: null });
  assert(typeof nonce === "string");
  assert(!/@|555-0142/.test(JSON.stringify([p.preview, p.payload])));
  assertEquals(w.calls.map((c) => c.action), ["crm_record", "crm_record", "crm_rules_list"]);
  assertEquals(w.calls[1].body, { kind: "design", id: "SS-AB12" });
  assertEquals(w.sends().length, 0);
  const said = JSON.parse(out.content);
  assertEquals([said.shown, said.estimate, said.ageDays], [true, "Q-1043", 20]);
  assert(/presses Approve on the card/.test(said.note) && !/\bSend\b/.test(said.note), said.note);
  assertEquals(said.lastSentOn, daysAgo(18).slice(0, 10));
  // Their record's history can leave an older send out (it keeps the newest events): no date there is no
  // "never sent", so Claude isn't told one and the card shows no row.
  const unknown = new World();
  unknown.feed = unknown.feed.filter((e) => e.id !== "qs:SS-AB12");
  const out2 = await resendTool.run(unknown.deps, unknown.turn(), resend());
  assert(!out2.isError, out2.content);
  assertEquals(unknown.last().preview.lastSentOn, null);
  assert(!("lastSentOn" in JSON.parse(out2.content)) && !/never|not sent before/i.test(out2.content), out2.content);
  // A design with no total says none, never "$0".
  const nt = new World();
  nt.designs[0].total_cents = null;
  await resendCard(nt);
  assertEquals(nt.last().preview.total, null);
});

Deno.test("estimate Send: one resend_quote_email with the design's code, stamped with the person, never again", async () => {
  const w = new World();
  const p = await resendCard(w);
  await w.press(p.id);
  assertEquals(w.sends(), [{ action: "resend_quote_email", body: { shortCode: "SS-AB12" } }]);
  assertEquals(w.row(p.id).result, { sent: 1, channel: "email", at: new Date(DAY).toISOString(), ledgerId: EMAIL_ROW });
  // The route leaves sent_by null on a resend; the stamp fills it with whoever pressed.
  assertEquals(w.stamps, [["email_sends", EMAIL_ROW, who.userId]]);
  assertEquals((await w.press(p.id)).status, 409);
  assertEquals(w.sends().length, 1);
  // Before the route returns an id, it still counts as sent and nothing is stamped.
  const old = new World();
  old.answer.resend_quote_email = () => ({ status: 200, data: { ok: true, sent: true, reason: null } });
  const q = await resendCard(old);
  await old.press(q.id);
  assertEquals([old.row(q.id).status, old.row(q.id).result.ledgerId, old.stamps.length], ["applied", null, 0]);
});

Deno.test("estimate card refusals: accepted, sold, old, CRM mode, no Structure Studio number, a different address, Do Not Disturb", async () => {
  const cases: [string, (w: World) => void, Any, string][] = [
    ["accepted", () => {}, resend("SS-GH78"), RESEND_SAID.accepted],
    ["accepted on the feed", (w) => { w.feed.push({ id: "ac:SS-AB12", type: "accepted", at: daysAgo(1), code: "SS-AB12" }); }, resend(), RESEND_SAID.accepted],
    ["sold", () => {}, resend("SS-CD34"), RESEND_SAID.sold],
    ["old", () => {}, resend("SS-EF56"), RESEND_SAID.old(120, 30)],
    // Sent again 5 days ago, but priced 40 days ago: a resend never made the price new.
    ["old, resent lately", (w) => { w.designs[0].created_at = daysAgo(40); w.feed[1].at = daysAgo(5); }, resend(), RESEND_SAID.old(40, 30)],
    ["orders unread", (w) => { w.orders = undefined as Any; }, resend(), SAID.readFailed],
    ["accepted, by the service role", (w) => { w.taken = true; }, resend(), RESEND_SAID.accepted],
    ["acceptance unread", (w) => { w.taken = null; }, resend(), SAID.readFailed],
    ["no name on the record", (w) => { w.contact.name = null; }, resend(), RESEND_SAID.noName],
    ["CRM mode", (w) => { w.paperwork = false; }, resend(), RESEND_SAID.crm],
    ["CRM mode unread", (w) => { w.paperwork = null; }, resend(), SAID.readFailed],
    ["a CRM estimate", () => {}, resend("SS-JK90"), RESEND_SAID.notSS],
    ["a lead", () => {}, resend(LEAD), RESEND_SAID.notEstimate],
    ["not theirs", () => {}, resend("SS-ZZ99"), RESEND_SAID.notTheirs],
    ["another address", (w) => { w.snapshot["SS-AB12"] = { name: "Dale Miller", email: "dale.old@example.com" }; }, resend(), RESEND_SAID.mismatch],
    ["no address on it", (w) => { w.snapshot["SS-AB12"] = { name: "Dale Miller", email: "" }; }, resend(), RESEND_SAID.noEmail],
    ["no address on the record", (w) => { w.contact.email = null; }, resend(), RESEND_SAID.mismatch],
    ["Do Not Disturb", (w) => { w.contact.dnd_all_at = daysAgo(2); }, resend(), RESEND_SAID.dndAll],
    ["Email Do Not Disturb", (w) => { w.contact.dnd_email_at = daysAgo(2); }, resend(), RESEND_SAID.dndEmail],
    ["merged", (w) => { w.contact.merged_into = "33333333-2222-4333-8444-555555555555"; }, resend(), RESEND_SAID.merged],
  ];
  for (const [name, change, input, said] of cases) {
    const w = new World();
    change(w);
    const out = await resendTool.run(w.deps, w.turn(), input);
    assertEquals(out, { content: said, isError: true }, name);
    assertEquals(w.proposals.size, 0, name);
    assert(!/@|555-0142/.test(out.content), name);
  }
  // The same address in other case and spacing is the same address.
  const w = new World();
  w.snapshot["SS-AB12"] = { name: "Dale Miller", email: " Dale@Example.com " };
  assert(!(await resendTool.run(w.deps, w.turn(), resend())).isError);
});

Deno.test("estimate age: unset old_quote_days asks first; the person's answer is used for that card; a kept answer wins", async () => {
  const w = new World();
  w.memory = [];
  const out = await resendTool.run(w.deps, w.turn(), resend());
  const said = JSON.parse(out.content);
  assertEquals([said.needsAnswer, said.shown, w.proposals.size], ["old_quote_days", false, 0]);
  // A number with no answer behind it (Claude's own, or a customer's words) is no rule: it asks.
  const made = JSON.parse((await resendTool.run(w.deps, w.turn(), resend("SS-AB12", 365))).content);
  assertEquals([made.needsAnswer, made.unproven, w.proposals.size], ["old_quote_days", UNPROVEN_DAYS, 0]);
  // A teammate's answer, or one in another chat, isn't this person's answer here.
  await w.answered(365, teammate);
  await w.answered(365, who, "chat2");
  assertEquals(JSON.parse((await resendTool.run(w.deps, w.turn(), resend("SS-AB12", 365))).content).needsAnswer, "old_quote_days");
  const q30 = await w.answered(30);
  assert(!(await resendTool.run(w.deps, w.turn(), resend("SS-AB12", 30))).isError);
  assertEquals([w.last().payload.oldQuoteDays, w.last().payload.daysCard], [30, q30.id]);
  await w.answered(7);
  assertEquals((await resendTool.run(w.deps, w.turn(), resend("SS-AB12", 7))).content, RESEND_SAID.old(20, 7));
  // At Send the card's own answer still holds while nothing is kept.
  await w.press(w.last("estimate_resend").id);
  assertEquals(w.sends().length, 1);
  // Out of the question's range is refused before any read.
  const x = new World();
  assertEquals((await resendTool.run(x.deps, x.turn(), resend("SS-AB12", 3))).content, DRAFT_SAID.badDays);
  assertEquals(x.calls.length, 0);
});

Deno.test("estimate Send re-checks on fresh reads: a new estimate number, acceptance or Do Not Disturb since stops it", async () => {
  const cases: [string, (w: World) => void, string][] = [
    ["new number", (w) => { w.designs[0].ss_quote_number = "Q-1050"; }, RESEND_SAID.changed],
    // A revised or re-taxed estimate keeps its number (submit-estimate, restampQuoteTax): what goes out is
    // the design as it stands at the press, so a total the card didn't show sends nothing.
    ["re-priced under the same number", (w) => { w.designs[0].total_cents = 990000; }, RESEND_SAID.changed],
    ["revised: another building, same number", (w) => { w.designs[0].selections = { style: "Garden Shed", size: "16x40" }; w.designs[0].updated_at = daysAgo(0); }, RESEND_SAID.changed],
    ["any write to the design since", (w) => { w.designs[0].updated_at = daysAgo(0); }, RESEND_SAID.changed],
    ["moved to another customer", (w) => { w.designs = w.designs.filter((d) => d.short_code !== "SS-AB12"); }, RESEND_SAID.notTheirsNow],
    // A read that fails at the press: the card is done, so it says to ask again.
    ["orders unread", (w) => { w.orders = undefined as Any; }, SEND_SAID.readAtPress],
    ["acceptance unread", (w) => { w.taken = null; }, SEND_SAID.readAtPress],
    ["CRM mode unread", (w) => { w.paperwork = null; }, SEND_SAID.readAtPress],
    ["accepted since, by the service role", (w) => { w.taken = true; }, `${RESEND_SAID.accepted} ${SEND_SAID.nothingSent}`],
    ["accepted since", (w) => { w.designs[0].status = "accepted"; }, `${RESEND_SAID.accepted} ${SEND_SAID.nothingSent}`],
    ["DND since", (w) => { w.contact.dnd_email_at = daysAgo(0); }, `${RESEND_SAID.dndEmail} ${SEND_SAID.nothingSent}`],
    ["address since", (w) => { w.contact.email = "new@example.com"; }, `${RESEND_SAID.mismatch} ${SEND_SAID.nothingSent}`],
    ["CRM since", (w) => { w.paperwork = false; }, `${RESEND_SAID.crm} ${SEND_SAID.nothingSent}`],
  ];
  for (const [name, change, said] of cases) {
    const w = new World();
    const p = await resendCard(w);
    change(w);
    await w.press(p.id);
    assertEquals([w.row(p.id).status, w.row(p.id).failure, w.sends().length], ["failed", said, 0], name);
  }
});

Deno.test("estimate Send answers: sent:false 'failed' is unclear, not switched on and no address are refusals, the route's CRM words say estimate", async () => {
  const cases: [Res, "failed" | "partly_applied", string][] = [
    [{ status: 200, data: { ok: true, sent: false, reason: "failed" } }, "partly_applied", SEND_SAID.unsure],
    [{ status: 200, data: { ok: true, sent: false, reason: "something new" } }, "partly_applied", SEND_SAID.unsure],
    [{ status: 200, data: { ok: true } }, "partly_applied", SEND_SAID.unsure],
    [{ status: 0, data: null }, "partly_applied", SEND_SAID.unsure],
    [{ status: 500, data: { error: "Could not find that design." } }, "partly_applied", SEND_SAID.unsure],
    [{ status: 200, data: { ok: true, sent: false, reason: "not_active" } }, "failed", SEND_SAID.emailOff],
    [{ status: 200, data: { ok: true, sent: false, reason: "no email address on this design" } }, "failed", `${RESEND_SAID.noEmail} ${SEND_SAID.nothingSent}`],
    [{ status: 400, data: { error: "This account quotes through the CRM — re-send it from there." } }, "failed", `${RESEND_SAID.crm} ${SEND_SAID.nothingSent}`],
    [{ status: 400, data: { error: "This design has no StructureStudio quote yet — submit it from the designer first." } }, "failed", `${RESEND_SAID.notSS} ${SEND_SAID.nothingSent}`],
    [{ status: 404, data: { error: "That design is not one of yours." } }, "failed", "That design is not one of yours. Nothing was sent."],
    [{ status: 403, data: { error: "This operator account is read-only." } }, "failed", "This operator account is read-only. Nothing was sent."],
  ];
  for (const [answer, status, said] of cases) {
    const w = new World();
    w.answer.resend_quote_email = () => answer;
    const p = await resendCard(w);
    await w.press(p.id);
    const row = w.row(p.id);
    assertEquals(row.status, status, JSON.stringify(answer));
    assertEquals(status === "failed" ? row.failure : row.result.reports[0].reason, said);
    assert(!/\bquot(e|es|ed|ing)\b/i.test(String(row.failure ?? "")), String(row.failure));
    assertEquals([w.sends().length, w.stamps.length, row.undo], [1, 0, null]);
    assertEquals((await w.press(p.id)).status, 409);
    assertEquals(w.sends().length, 1);
  }
});

Deno.test("estimate cards: a newer one for the same estimate replaces the older; the team may send one; access and switches", async () => {
  const w = new World();
  const a = await resendCard(w);
  const b = await resendCard(w);
  assertEquals([w.row(a.id).status, w.row(b.id).status], ["cancelled", "ready"]);
  // In the estimate's own words: no draft is involved.
  assertEquals(w.row(a.id).failure, REPLACED_ESTIMATE);
  await w.press(b.id, operator);
  assertEquals([w.row(b.id).status, w.sends().length], ["applied", 1]);
  assertEquals(w.stamps.at(-1), ["email_sends", EMAIL_ROW, operator.userId]);
  // designs edit is the route's gate: without it, no card and no Approve.
  const x = new World();
  x.deps = { ...x.deps, canEdit: (a2: string) => a2 !== "designs" };
  assertEquals((await resendTool.run(x.deps, x.turn(), resend())).content, RESEND_SAID.noAccess);
  const y = new World();
  const p = await resendCard(y);
  y.deps = { ...y.deps, canEdit: (a2: string) => a2 !== "designs" };
  assertEquals((await y.press(p.id)).status, 403);
  assertEquals(y.sends().length, 0);
});

// ── The tools, the kinds, the budget ──────────────────────────────────────────────────────────────

Deno.test("the resend tool is offered only with sends and customers on and the right access, and stays after a customer's words", () => {
  const w = new World();
  const names = (s: TurnState, deps: Deps = w.deps) => toolsFor(deps, s).map((t) => t.name);
  assert(names(w.turn()).includes("propose_estimate_resend"));
  assert(!names(w.turn(who, ["sends"])).includes("propose_estimate_resend"));
  assert(!names(w.turn(who, ["customers"])).includes("propose_estimate_resend"));
  // The reply tool stays with sends off: it makes v1's card then.
  assert(names(w.turn(who, ["sends"])).includes("propose_reply_draft"));
  const read = w.turn();
  read.customerWordsRead = true;
  assert(names(read).includes("propose_estimate_resend") && names(read).includes("propose_reply_draft"));
  assert(!names(w.turn(), { ...w.deps, canEdit: (a: string) => a !== "designs" }).includes("propose_estimate_resend"));
  assert(!names(w.turn(), { ...w.deps, canRead: (a: string) => a !== "contacts" }).includes("propose_estimate_resend"));
});

Deno.test("an owner with every switch on stays inside the strict limits, and the send tools keep strict", () => {
  const w = new World();
  const tools = toolsFor(w.deps, w.turn());
  const c = strictCost(tools);
  assert(c.tools <= STRICT_LIMITS.tools && c.optional <= STRICT_LIMITS.optional && c.unions <= STRICT_LIMITS.unions, JSON.stringify(c));
  for (const n of ["propose_reply_draft", "propose_estimate_resend"]) assert(tools.some((t) => t.name === n && t.strict === true), `${n} lost strict`);
});

Deno.test("the send kinds: private, cleared after 30 days, no Undo, their own give-up sentence; nothing Claude reads has a dash", () => {
  assertEquals(SEND_KINDS, ["reply_send", "estimate_resend"]);
  for (const k of SEND_KINDS) {
    const spec = PIECE_KINDS.get(k)!;
    assertEquals([spec.private, spec.showOnly, typeof spec.apply, spec.undo, spec.gaveUp, spec.sends], [true, undefined, "function", undefined, SEND_SAID.unsure, true]);
    assert((PRIVATE_KINDS as readonly string[]).includes(k));
    assertEquals(spec.switches({} as ProposalRow), ["customers", "sends"]);
  }
  assertEquals(PIECE_KINDS.get("reply_send")!.areas({} as ProposalRow), ["contacts"]);
  assertEquals(PIECE_KINDS.get("estimate_resend")!.areas({} as ProposalRow), ["designs"]);
  assertEquals(PIECE_KINDS.get("estimate_resend")!.readAreas!({} as ProposalRow), ["contacts", "designs"]);
  const t = sendsPiece.tools[0];
  assertEquals([t.def.name, t.switchKey, t.customerWords, t.proposesChange ?? false], ["propose_estimate_resend", "sends", true, false]);
  const words = [...sendsPiece.can, ...(sendsPiece.rules ?? []), t.def.description, draftTool.def.description];
  for (const s of words) assert(!/[—–]/.test(s), s);
  // A send card's button is Approve, like every other card's, and Claude is told so: pressing it sends,
  // Claude can't press it, and "yes, send it" in the chat doesn't send. The old buttons are never named.
  assert(/Approve/.test(t.def.description) && /Approve/.test(sendsPiece.can[0]) && /Approve/.test(sendsPiece.rules![0]) && /Approve/.test(draftTool.def.description), "the Approve button isn't named");
  assert(/has Approve like every other card/.test(sendsPiece.rules![0]) && /you can't/.test(sendsPiece.rules![0]) && /"yes, send it" in the chat doesn't send it/.test(sendsPiece.rules![0]), sendsPiece.rules![0]);
  for (const s of words) assert(!/Send text|Send email|Resend estimate|Send button/.test(s), s);
  assert(!/can't send it|sends nothing/i.test(draftTool.def.description), draftTool.def.description);
});

// ── The stamp (index.ts hands it the service-role client) ─────────────────────────────────────────

/** A PostgREST-shaped client over in-memory rows: update(...).eq(...).is(...)[.select()], awaited. */
function stampClient(rows: Record<string, Any[]>, o: { fail?: { code: string; message: string }; failBy?: { code: string; message: string }; throws?: boolean } = {}) {
  const writes: { table: string; patch: Any; filters: [string, string, unknown][] }[] = [];
  const admin = {
    from(table: string) {
      if (o.throws) throw new Error("connection reset");
      return {
        update(patch: Any) {
          const filters: [string, string, unknown][] = [];
          let rowsBack = false;
          const run = () => {
            writes.push({ table, patch, filters });
            if (o.fail && "sent_with" in patch) return { data: null, error: o.fail };
            if (o.failBy && "sent_by" in patch) return { data: null, error: o.failBy };
            const hit = (rows[table] ?? []).filter((r) => filters.every(([op, k, v]) => (op === "eq" ? r[k] === v : r[k] === v)));
            for (const r of hit) Object.assign(r, patch);
            return { data: rowsBack ? hit.map((r) => ({ id: r.id })) : null, error: null };
          };
          const b: Any = {
            eq(k: string, v: unknown) { filters.push(["eq", k, v]); return b; },
            is(k: string, v: unknown) { filters.push(["is", k, v]); return b; },
            select() { rowsBack = true; return b; },
            then(ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) { return Promise.resolve().then(run).then(ok, bad); },
          };
          return b;
        },
      };
    },
  };
  return { admin, writes };
}

Deno.test("the stamp marks only this builder's row, only where it's still empty, and names the person only where nobody is named", async () => {
  const logs: Any[] = [];
  const log = (e: Any) => { logs.push(e); return Promise.resolve(); };
  const rows = {
    sms_messages: [
      { id: SMS_ROW, client_id: "builder-a", sent_by: who.userId, sent_with: null },
      // The same id on another builder never moves.
      { id: SMS_ROW, client_id: "builder-b", sent_by: null, sent_with: null },
    ],
    email_sends: [{ id: EMAIL_ROW, client_id: "builder-a", sent_by: null, sent_with: null }],
  };
  const { admin, writes } = stampClient(rows);
  const stamp = makeSentWithJack(admin, "builder-a", log);
  assertEquals(await stamp("sms_messages", SMS_ROW, operator.userId), true);
  // The route already named who sent the text: it stays theirs.
  assertEquals(rows.sms_messages[0], { id: SMS_ROW, client_id: "builder-a", sent_by: who.userId, sent_with: "jack" });
  assertEquals(rows.sms_messages[1], { id: SMS_ROW, client_id: "builder-b", sent_by: null, sent_with: null });
  // A resend leaves sent_by empty: the stamp fills it with whoever pressed Approve.
  assertEquals(await stamp("email_sends", EMAIL_ROW, who.userId), true);
  assertEquals(rows.email_sends[0], { id: EMAIL_ROW, client_id: "builder-a", sent_by: who.userId, sent_with: "jack" });
  // Every write is by id, on this builder, and only where the column is still empty.
  for (const w of writes) {
    const col = Object.keys(w.patch)[0];
    assertEquals(w.filters, [["eq", "id", w.table === "sms_messages" ? SMS_ROW : EMAIL_ROW], ["eq", "client_id", "builder-a"], ["is", col, null]]);
  }
  // A second stamp changes nothing and says so.
  assertEquals(await stamp("email_sends", EMAIL_ROW, teammate.userId), false);
  assertEquals(rows.email_sends[0].sent_by, who.userId);
  // Not a ledger table, not a row id, or no person: no write of that part.
  const n = writes.length;
  assertEquals(await stamp("jack_proposals" as Any, EMAIL_ROW, who.userId), false);
  assertEquals(await stamp("email_sends", "e:1; drop table", who.userId), false);
  assertEquals(writes.length, n);
  await stamp("email_sends", EMAIL_ROW, "not-a-person");
  assertEquals(writes.slice(n).map((w) => Object.keys(w.patch)[0]), ["sent_with"]);
  assertEquals(logs, []);
});

Deno.test("the stamp never throws: a missing column is the deploy window, any other failure is a warning, and neither carries words", async () => {
  for (const [fail, code, severity] of [
    [{ code: "PGRST204", message: "Could not find the 'sent_with' column of 'sms_messages' in the schema cache" }, "jack_sent_with_unapplied", "info"],
    [{ code: "42703", message: "column \"sent_with\" does not exist" }, "jack_sent_with_unapplied", "info"],
    [{ code: "23514", message: "new row violates check constraint" }, "jack_sent_with_failed", "warn"],
  ] as const) {
    const logs: Any[] = [];
    const rows = { sms_messages: [{ id: SMS_ROW, client_id: "builder-a", sent_by: null, sent_with: null, body: GOOD }] };
    const stamp = makeSentWithJack(stampClient(rows, { fail }).admin, "builder-a", (e) => { logs.push(e); return Promise.resolve(); });
    assertEquals(await stamp("sms_messages", SMS_ROW, who.userId), false);
    assertEquals(logs.map((l) => [l.code, l.severity]), [[code, severity]]);
    assertEquals(logs[0].context, { table: "sms_messages", id: SMS_ROW, dbCode: fail.code });
    assert(!JSON.stringify(logs).includes("Hi Dale"));
    // sent_by still landed: who sent it is there before 378 is.
    assertEquals(rows.sms_messages[0].sent_by, who.userId);
  }
  // A resend whose person couldn't be named: still marked with Jack, and logged as an error to look at.
  const byLogs: Any[] = [];
  const byRows = { email_sends: [{ id: EMAIL_ROW, client_id: "builder-a", sent_by: null, sent_with: null }] };
  const byStamp = makeSentWithJack(stampClient(byRows, { failBy: { code: "57014", message: "canceling statement" } }).admin, "builder-a", (e) => { byLogs.push(e); return Promise.resolve(); });
  assertEquals(await byStamp("email_sends", EMAIL_ROW, who.userId), true);
  assertEquals(byLogs.map((l) => [l.code, l.severity]), [["jack_sent_with_failed", "error"]]);
  assertEquals(byRows.email_sends[0].sent_with, "jack");
  const logs: Any[] = [];
  const stamp = makeSentWithJack(stampClient({}, { throws: true }).admin, "builder-a", (e) => { logs.push(e); return Promise.reject(new Error("log down")); });
  assertEquals(await stamp("email_sends", EMAIL_ROW, who.userId), false);
  assertEquals(logs.map((l) => l.code), ["jack_sent_with_failed"]);
});

Deno.test("the route answers, one by one", () => {
  const sms = (status: number, data: Any) => classifySms({ status, data });
  assertEquals(sms(200, { ok: true, id: SMS_ROW }), { kind: "sent", id: SMS_ROW });
  assertEquals(sms(200, { ok: true, id: "not-a-uuid" }), { kind: "sent", id: null });
  assertEquals(sms(200, { ok: false }).kind, "unclear");
  assertEquals(sms(400, { error: "sms ledger write failed", reason: "failed" }), { kind: "refused", sentence: SEND_SAID.textFailed });
  // Before the claim (the texting account or number couldn't be read): nothing reached the carrier.
  assertEquals(sms(400, { error: "The text could not be sent. Try again.", reason: "failed" }), { kind: "refused", sentence: SEND_SAID.textFailed });
  // A throw part way, or the carrier call breaking off with no code: it may have gone.
  assertEquals(sms(400, { error: "The text could not be sent.", reason: "failed" }).kind, "unclear");
  assertEquals(sms(400, { error: "The text could not be sent. Try again, or call them instead.", reason: "failed" }).kind, "unclear");
  assertEquals(sms(400, { error: "The text could not be sent (carrier code 30007). Try again, or call them instead.", reason: "failed" }), { kind: "refused", sentence: SEND_SAID.carrier("30007") });
  // Twilio's own 5xx answers carry 20500 or 20503: they don't prove the message wasn't created.
  for (const code of [20500, 20503]) assertEquals(sms(400, { error: `The text could not be sent (carrier code ${code}). Try again, or call them instead.`, reason: "failed" }).kind, "unclear", String(code));
  assertEquals(sms(400, { error: "The text could not be sent (carrier code 20429). Try again, or call them instead.", reason: "failed" }).kind, "refused");
  assertEquals(sms(409, { error: "Texting isn't switched on for this account yet.", reason: "not_active" }), { kind: "refused", sentence: "Texting isn't switched on for this account yet. Nothing was sent." });
  assertEquals(sms(400, { error: "It is 10pm where this customer lives.", reason: "quiet_hours" }).kind, "waiting");
  assertEquals(sms(400, { error: "The message is empty." }).kind, "refused");
  assertEquals(classifyEmail({ status: 200, data: { ok: true, id: EMAIL_ROW } }), { kind: "sent", id: EMAIL_ROW });
  assertEquals(classifyEmail({ status: 502, data: { error: "x" } }).kind, "unclear");
  assertEquals(classifyEmail({ status: 400, data: { error: "Give the email a subject." } }), { kind: "refused", sentence: "Give the email a subject. Nothing was sent." });
  assertEquals(classifyResend({ status: 200, data: { ok: true, sent: true, reason: null, id: EMAIL_ROW } }), { kind: "sent", id: EMAIL_ROW });
  assertEquals(classifyResend({ status: 409, data: { error: "Something about a quote." } }), { kind: "refused", sentence: "Something about an estimate. Nothing was sent." });
});

// ── The senders' own words (the drift guard) ──────────────────────────────────────────────────────
// classifySms, classifyEmail and classifyResend tell "nothing went" from "it may have gone" by the
// routes' words and statuses, which are written by hand in _shared/smsSend.ts, _shared/emailSend.ts and
// portal-settings/index.ts. These tests read those files as text. A change there that would make a
// maybe-sent read as a refusal (and so invite a second press, and a second message) fails here first.

const sourceOf = (rel: string) => Deno.readTextFile(new URL(rel, import.meta.url));
/** The source from `from` up to the next `until` after it. */
function between(src: string, from: string, until: string): string {
  const i = src.indexOf(from);
  assert(i >= 0, `${from} isn't in the file any more`);
  const j = src.indexOf(until, i + from.length);
  assert(j > i, `${until} isn't after ${from} any more`);
  return src.slice(i, j);
}
/** Split at the one provider call: what's said before it went nowhere, what's said after it may have gone. */
function aroundCall(block: string, call: string): { before: string; after: string } {
  const i = block.indexOf(call);
  assert(i >= 0, `${call} isn't in the block any more`);
  assertEquals(block.indexOf(call, i + call.length), -1, `${call} is made once`);
  return { before: block.slice(0, i), after: block.slice(i) };
}
/** The code without its // comments (a URL's "://" stays), so words in a comment never count as said. */
const code = (src: string) => src.replace(/(^|[^:])\/\/.*$/gm, "$1");
const stringsIn = (src: string) => [...code(src).matchAll(/"((?:[^"\\\r\n]|\\.)*)"/g)].map((m) => m[1]);
const reasons = (src: string) => new Set([...code(src).matchAll(/reason:\s*"(\w+)"/g)].map((m) => m[1]));
// The carrier's answer, exactly as smsSend.ts writes it. It's the one sentence classifySms reads a number out of.
const CARRIER_SRC = '`The text could not be sent${code ? ` (carrier code ${code})` : ""}. Try again, or call them instead.`';
const carrierSaid = (code: number) => `The text could not be sent${code ? ` (carrier code ${code})` : ""}. Try again, or call them instead.`;

Deno.test("the text sender's words: what reads as 'not sent' is only said before the carrier is called", async () => {
  const src = await sourceOf("../_shared/smsSend.ts");
  const fn = between(src, "export async function sendTenantSms(", "\n// ── Which number a person's reply goes out from");
  const { before, after } = aroundCall(fn, "await sendSms(");
  const sms = (data: Any) => classifySms({ status: 400, data });
  // Every sentence classifySms takes as a definite no (or a wait) is still smsSend's own, before the call.
  const definite: [string, string, SendAnswer["kind"]][] = [
    ["The text could not be sent. Try again.", "failed", "refused"],
    ["sms ledger write failed", "failed", "refused"],
    ["The message is empty.", "failed", "refused"],
    ["Your wallet is being topped up. Try again in a minute.", "wallet_empty", "waiting"],
  ];
  for (const [said, reason, kind] of definite) {
    assertEquals(sms({ error: said, reason }).kind, kind, said);
    assert(stringsIn(before).includes(said), `smsSend.ts no longer says "${said}" before the carrier call`);
    assert(!stringsIn(after).includes(said), `smsSend.ts now says "${said}" after the carrier call, where it may have gone`);
  }
  assert(/reason:\s*"wallet_empty",\s*error:\s*"Your wallet is being topped up/.test(before), "the top-up wait is the wallet's answer");
  assert(!/topped up/i.test(after), "a top-up wait is never said after the carrier call");
  // The waits and the damaged number are refusals from before the call only.
  for (const r of ["quiet_hours", "damaged_number", "no_consent", "bad_number", "wallet_empty"]) {
    assert(reasons(before).has(r), `${r} is gone from before the call`);
    assert(!reasons(after).has(r), `${r} is now answered after the carrier call`);
  }
  // After the call: an opt-out (21610) and an unregistered number (30034) are the carrier's own no; every
  // other ending is "failed", and only the carrier's code makes that a definite no. A new reason here
  // has to be sorted in classifySms first.
  assertEquals([...reasons(after)].sort(), ["failed", "not_active", "opted_out"]);
  assert(/code === TWILIO_OPTED_OUT\)[\s\S]*?reason: "opted_out"/.test(after) && /code === 30034\)[\s\S]*?reason: "not_active"/.test(after), "an opt-out or not_active after the call is keyed on the carrier's code");
  // Every plain sentence after the call, read as a "failed" answer, is "may have gone".
  for (const said of stringsIn(after)) assertEquals(sms({ error: said, reason: "failed" }).kind, "unclear", `"${said}" after the carrier call`);
  // The one built sentence after the call is the carrier's, and only a code in it (outside 20500-20599)
  // makes it a definite no.
  assert(after.includes(CARRIER_SRC), "the carrier sentence changed: check classifySms reads it the same way");
  assertEquals([...after.matchAll(/error:\s*`/g)].length, 1, "one built sentence after the call");
  assertEquals(sms({ error: carrierSaid(0), reason: "failed" }).kind, "unclear");
  assertEquals(sms({ error: carrierSaid(30007), reason: "failed" }), { kind: "refused", sentence: SEND_SAID.carrier("30007") });
  for (const code of [20500, 20503, 20599]) assertEquals(sms({ error: carrierSaid(code), reason: "failed" }).kind, "unclear", String(code));
});

Deno.test("the text route passes smsSend's words through as they are", async () => {
  const src = await sourceOf("../portal-settings/index.ts");
  const block = between(src, 'if (action === "crm_send_sms") {', 'if (action === "crm_record_consent") {');
  const { after } = aroundCall(block, "await sendTenantSms(");
  // After the send, the route says smsSend's own sentence and reason, or a default that reads as "may have gone".
  assert(after.includes('error: out.error ?? "The text could not be sent.", reason: out.reason }, 400)'), "the route rewrites smsSend's answer");
  assert(/out\.reason === "not_active"[\s\S]*?reason: "not_active",\s*\}, 409\)/.test(after), "not_active is a 409 with its reason");
  assertEquals(stringsIn(after).filter((s) => !["not_active"].includes(s)).sort(), ["Texting isn't switched on for this account yet.", "The text could not be sent."]);
  assertEquals(classifySms({ status: 400, data: { error: "The text could not be sent.", reason: "failed" } }).kind, "unclear");
});

Deno.test("the email senders' words: a refusal is only said before the provider is called", async () => {
  const emailSrc = await sourceOf("../_shared/emailSend.ts");
  // sendTenantEmail is the file's last export: it runs to the end.
  const at = emailSrc.indexOf("export async function sendTenantEmail(");
  assert(at >= 0, "sendTenantEmail isn't in emailSend.ts any more");
  const send = emailSrc.slice(at);
  const e = aroundCall(send, "await rsSendEmail(");
  // classifyEmail's 503 and classifyResend's not_active are refusals because not_active never follows the call.
  assert(reasons(e.before).has("not_active"), "not_active is gone from before the provider call");
  assert(!reasons(e.after).has("not_active"), "emailSend.ts now answers not_active after the provider call, where it may have gone");

  const portal = await sourceOf("../portal-settings/index.ts");
  const route = between(portal, 'if (action === "crm_send_email") {', 'if (action === "crm_save_note") {');
  const r = aroundCall(route, "await sendTenantEmail(");
  // After the send: the ok answer, the not-switched-on 503 (only for not_active), and a 5xx for the rest.
  assertEquals([...code(r.after).matchAll(/\},\s*(\d{3})\)/g)].map((m) => m[1]), ["503", "502"]);
  const off = /if \(out\.reason === "not_active"\) \{[\s\S]*?json\(\{ error: "([^"]*)" \}, 503\)/.exec(code(r.after));
  assert(off && /switched on/i.test(off[1]), "the 503 is no longer the not_active answer");
  assertEquals(classifyEmail({ status: 503, data: { error: off![1] } }), { kind: "refused", sentence: SEND_SAID.emailOff });
  assertEquals(classifyEmail({ status: 502, data: { error: "That email didn't send (x). Try again." } }).kind, "unclear");
  // Every 4xx the route answers is before the send.
  assertEquals([...code(r.after).matchAll(/\},\s*4\d\d\)/g)].length, 0, "a 4xx after the send would read as nothing sent");
  assert([...code(r.before).matchAll(/\},\s*4\d\d\)/g)].length >= 5, "the route's refusals are where they were");

  // resend_quote_email: the refusals classifyResend names in its own words are all said before the send.
  const resendFn = between(portal, "const sendQuoteEmail = async (", 'if (action === "resend_quote_email") {');
  const q = aroundCall(resendFn, "await sendTenantEmail(");
  for (const [re, said] of [[/through the CRM/i, RESEND_SAID.crm], [/no StructureStudio/i, RESEND_SAID.notSS], [/design not found/i, RESEND_SAID.gone]] as [RegExp, string][]) {
    const line = stringsIn(q.before).find((s) => re.test(s));
    assert(line, `${re} is no longer one of resend_quote_email's refusals`);
    assert(!stringsIn(q.after).some((s) => re.test(s)), `${re} is now said after the send`);
    assertEquals(classifyResend({ status: 400, data: { error: line } }), { kind: "refused", sentence: `${said} ${SEND_SAID.nothingSent}` });
  }
  const noEmail = stringsIn(q.before).find((s) => /no email address/i.test(s));
  assert(noEmail, "the no-email answer is gone from before the send");
  assertEquals(classifyResend({ status: 200, data: { ok: true, sent: false, reason: noEmail } }), { kind: "refused", sentence: `${RESEND_SAID.noEmail} ${SEND_SAID.nothingSent}` });
  // After the send, the reason is emailSend's own, or "failed", which may have gone.
  assert(q.after.includes('reason: outcome.sent ? null : (outcome.reason || "failed")'), "resend_quote_email rewrites emailSend's reason");
  assertEquals(classifyResend({ status: 200, data: { ok: true, sent: false, reason: "failed" } }).kind, "unclear");
  assertEquals(classifyResend({ status: 200, data: { ok: true, sent: false, reason: "not_active" } }), { kind: "refused", sentence: SEND_SAID.emailOff });
});

Deno.test("a reply that spells out an email address makes no card that sends, and sends nothing", async () => {
  for (const body of ["Hi Dale, write me at mike at gmail dot com. Mike", "Hi Dale, my email is mike (at) ridgeline (dot) com. Mike", "Hi Dale, reach me at mike at gmail. Mike"]) {
    const w = new World();
    const out = await draftTool.run(w.deps, w.turn(), text(body));
    assertEquals(out.content, DRAFT_SAID.contactDetails, body);
    assertEquals([w.proposals.size, w.sends().length], [0, 0], body);
  }
  // The signature's "at" is still fine.
  const w = new World();
  assert(!(await draftTool.run(w.deps, w.turn(), text())).isError);
  assertEquals(w.last().kind, "reply_send");
});

// ── Review fixes (11-06) ──────────────────────────────────────────────────────────────────────────

Deno.test("a press without send: true (an older page's plain Approve) sends nothing and leaves the card ready", async () => {
  for (const make of [(w: World) => sendCard(w), (w: World) => resendCard(w)]) {
    const w = new World();
    const p = await make(w);
    const r = await handleProposalApprove(w.deps, who, { id: p.id, hash: p.shown_hash });
    assertEquals([r.status, r.body.error], [409, SENTENCES.reloadToSend]);
    assertEquals([w.row(p.id).status, w.row(p.id).approved_by, w.sends().length], ["ready", null, 0]);
    // The card's own Approve, from a page that shows its words, still works.
    await w.press(p.id);
    assertEquals([w.row(p.id).status, w.sends().length], ["applied", 1]);
  }
});

Deno.test("a draft made while an older one is being pressed at night can't leave two sendable versions", async () => {
  // The reviewer's sequence: card A, night, A's press held inside its fresh read; card B made for the same
  // customer and channel; A released into quiet hours; morning; both pressed. One text, never two.
  const w = new World();
  const a = await sendCard(w, text("Hi Dale, any questions on the barn? Mike"));
  w.now = NIGHT;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const real = w.deps.portal;
  let hold = true;
  w.deps = { ...w.deps, portal: async (action, body) => {
    if (hold && action === "crm_record" && (body as Any).kind === "contact") { hold = false; await gate; }
    return await real(action, body);
  } };
  const pressing = w.press(a.id);
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(w.row(a.id).status, "applying");
  const s = w.turn();
  const out = JSON.parse((await draftTool.run(w.deps, s, text("Hi Dale, any questions about the 12x24? Mike"))).content);
  w.endTurn(s);
  const b = w.last("reply_send");
  assert(b.id !== a.id);
  // B is put away, and Claude hears why.
  assertEquals([w.row(b.id).status, w.row(b.id).failure, out.putAway, out.sent], ["cancelled", YIELDED, true, false]);
  release();
  await pressing;
  assertEquals([w.row(a.id).status, w.row(a.id).result?.waiting?.reason], ["ready", "quiet_hours"]);
  w.now = Date.parse(OPENS) + 30 * 60_000;
  await w.press(a.id);
  assertEquals((await w.press(b.id)).status, 409);
  assertEquals(w.sends().map((c) => c.body.body), ["Hi Dale, any questions on the barn? Mike"]);

  // The same when the read saw A still ready and the press claimed it before the cancel landed.
  const x = new World();
  const xa = await sendCard(x, text("Hi Dale, one."));
  x.answer.crm_send_sms = () => new Promise(() => {});
  void x.press(xa.id);
  await new Promise((r) => setTimeout(r, 0));
  const byId = x.deps.store.proposalsById;
  x.deps.store.proposalsById = async (c, ids) => (await byId(c, ids)).map((r) => (r.id === xa.id ? { ...r, status: "ready" } : r));
  const xb = await sendCard(x, text("Hi Dale, two."));
  assertEquals([x.row(xa.id).status, x.row(xb.id).status, x.row(xb.id).failure], ["applying", "cancelled", YIELDED]);

  // A press that died with its worker (past the give-up time) doesn't hold a new card back.
  const z = new World();
  z.answer.crm_send_sms = () => new Promise(() => {});
  const za = await sendCard(z, text("Hi Dale, one."));
  void z.press(za.id);
  await new Promise((r) => setTimeout(r, 0));
  z.now += READ_GIVE_UP_MS + 60_000;
  const zb = await sendCard(z, text("Hi Dale, two."));
  assertEquals(z.row(zb.id).status, "ready");
});

Deno.test("an estimate card made while an older one for it is being sent is put away", async () => {
  const w = new World();
  const a = await resendCard(w);
  w.answer.resend_quote_email = () => new Promise(() => {});
  void w.press(a.id);
  await new Promise((r) => setTimeout(r, 0));
  const s = w.turn();
  const out = JSON.parse((await resendTool.run(w.deps, s, resend())).content);
  const b = w.last("estimate_resend");
  assertEquals([w.row(a.id).status, w.row(b.id).status, w.row(b.id).failure, out.putAway], ["applying", "cancelled", YIELDED, true]);
});

// ── Review fixes, round 2 (11-07): one sendable version, even out of order or when a read or save fails ──

/** The two send cards that replace each other: a text (drafts.ts) and an estimate (sends.ts). */
const SAME_TARGET = [
  {
    kind: "reply_send", replaced: REPLACED, replacedKey: "replacedOlderDrafts",
    older: (w: World) => sendCard(w, text("Hi Dale, one.")),
    run: (d: Deps, s: TurnState, body: string) => draftTool.run(d, s, text(body)),
  },
  {
    kind: "estimate_resend", replaced: REPLACED_ESTIMATE, replacedKey: "replacedOlderCards",
    older: (w: World) => resendCard(w),
    run: (d: Deps, s: TurnState, _body: string) => resendTool.run(d, s, resend()),
  },
];
/** Presses every card of this kind that still has its button, and counts what went out. */
async function pressEveryReady(w: World, kind: string): Promise<number> {
  for (const p of [...w.proposals.values()].filter((r) => r.kind === kind)) if (w.row(p.id).status === "ready") await w.press(p.id);
  return w.sends().length;
}
/** Holds the first call of `fn` until release(): before it runs, or (afterCall) after it ran but before its
 *  answer comes back. `reached` settles once that first call has arrived. The rest go straight through. */
function holdFirst<A extends unknown[], R>(fn: (...a: A) => Promise<R>, afterCall = true) {
  let release!: () => void;
  let arrive!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const reached = new Promise<void>((r) => { arrive = r; });
  let n = 0;
  const held = async (...a: A): Promise<R> => {
    const mine = ++n;
    if (mine === 1 && !afterCall) { arrive(); await gate; }
    const out = await fn(...a);
    if (mine === 1 && afterCall) { arrive(); await gate; }
    return out;
  };
  return { held, reached, release: () => release() };
}

Deno.test("two cards for one customer in one round, the older one's save answering last: only the newest keeps its button", async () => {
  // The older card (saved first) hears back after the newer one has finished its whole check, so the newer
  // never saw it. The older one's own check then sees the newer one and puts itself away.
  for (const m of SAME_TARGET) {
    const w = new World();
    const s = w.turn();
    const { held, reached, release } = holdFirst(w.deps.store.insertProposal);
    const d: Deps = { ...w.deps, store: { ...w.deps.store, insertProposal: held } };
    const one = m.run(d, s, "Hi Dale, one.");
    await reached;
    const newer = JSON.parse((await m.run(d, s, "Hi Dale, two.")).content);
    release();
    const older = JSON.parse((await one).content);
    w.endTurn(s);
    const [a, b] = [...w.proposals.values()].filter((p) => p.kind === m.kind);
    assert(a.id < b.id, "a is the older card");
    assertEquals([w.row(a.id).status, w.row(a.id).failure, w.row(b.id).status], ["cancelled", m.replaced, "ready"], m.kind);
    assertEquals([older.putAway, older.replacedByNewer, older.sent, newer.putAway], [true, true, false, undefined], m.kind);
    assert(/newer/.test(older.note) && !/being sent/.test(older.note), older.note);
    assertEquals(w.logs, []);
    w.now += 60_000;
    assertEquals(await pressEveryReady(w, m.kind), 1, m.kind);
  }
});

Deno.test("two cards in one round where the newer one cancels the older first: the older one's answer says so, not 'Approve'", async () => {
  // The older card's check is slow (its chat read answers late): the newer one cancels it, and then its own
  // put-away misses. It reads itself again rather than telling Claude it still has Approve.
  for (const m of SAME_TARGET) {
    const w = new World();
    const s = w.turn();
    const { held, reached, release } = holdFirst(w.deps.store.messages, false);
    const d: Deps = { ...w.deps, store: { ...w.deps.store, messages: held } };
    const one = m.run(d, s, "Hi Dale, one.");
    await reached;
    const newer = JSON.parse((await m.run(d, s, "Hi Dale, two.")).content);
    release();
    const older = JSON.parse((await one).content);
    w.endTurn(s);
    const [a, b] = [...w.proposals.values()].filter((p) => p.kind === m.kind);
    assertEquals([w.row(a.id).status, w.row(a.id).failure, w.row(b.id).status], ["cancelled", m.replaced, "ready"], m.kind);
    assertEquals([newer[m.replacedKey], older.putAway, older.replacedByNewer], [1, true, true], m.kind);
    assertEquals(w.logs, []);
    assertEquals(await pressEveryReady(w, m.kind), 1, m.kind);
  }
});

Deno.test("a read that fails while a new card checks for older ones puts the new one away, logged once", async () => {
  for (const m of SAME_TARGET) {
    // The cards read fails (the real store throws "proposal read failed").
    const w = new World();
    const a = await m.older(w);
    const s = w.turn();
    const d: Deps = { ...w.deps, store: { ...w.deps.store, proposalsById: () => Promise.reject(new Error("proposal read failed")) } };
    const out = JSON.parse((await m.run(d, s, "Hi Dale, two.")).content);
    w.endTurn(s);
    const b = w.last(m.kind);
    assertEquals([w.row(a.id).status, w.row(b.id).status, w.row(b.id).failure], ["ready", "cancelled", UNCHECKED], m.kind);
    assertEquals([out.putAway, out.unchecked, out.sent, out.yielded], [true, true, false, undefined], m.kind);
    assert(!/being sent at that very moment/.test(out.note), out.note);
    assertEquals(w.logs, ["jack_replace_read_failed"]);
    assertEquals(await pressEveryReady(w, m.kind), 1, m.kind);

    // The chat's messages read fails ("history read failed"): the older card from an earlier turn can't be
    // found, so the new one goes.
    const x = new World();
    const xa = await m.older(x);
    const xs = x.turn();
    const xd: Deps = { ...x.deps, store: { ...x.deps.store, messages: () => Promise.reject(new Error("history read failed")) } };
    const xout = JSON.parse((await m.run(xd, xs, "Hi Dale, two.")).content);
    x.endTurn(xs);
    const xb = x.last(m.kind);
    assertEquals([x.row(xa.id).status, x.row(xb.id).status, x.row(xb.id).failure, xout.unchecked], ["ready", "cancelled", UNCHECKED, true], m.kind);
    assertEquals(x.logs, ["jack_replace_read_failed"]);
    assertEquals(await pressEveryReady(x, m.kind), 1, m.kind);

    // The same in a fresh chat: nothing proves there's no other card, so it's put away (none to press).
    const y = new World();
    const ys = y.turn();
    const yd: Deps = { ...y.deps, store: { ...y.deps.store, messages: () => Promise.reject(new Error("chat read failed")) } };
    assertEquals(JSON.parse((await m.run(yd, ys, "Hi Dale, two.")).content).unchecked, true);
    assertEquals([y.last(m.kind).status, y.logs, await pressEveryReady(y, m.kind)], ["cancelled", ["jack_replace_read_failed"], 0]);
  }
});

Deno.test("an older card that can't be put away keeps the new one from standing beside it, logged once", async () => {
  for (const m of SAME_TARGET) {
    // The cancel throws (the real store's "proposal write failed"); the read after it shows the older card ready.
    const w = new World();
    const a = await m.older(w);
    const write = w.deps.store.updateProposal;
    const d: Deps = { ...w.deps, store: { ...w.deps.store, updateProposal: (c, id, patch, when, at) => (id === a.id ? Promise.reject(new Error("proposal write failed")) : write(c, id, patch, when, at)) } };
    const s = w.turn();
    const out = JSON.parse((await m.run(d, s, "Hi Dale, two.")).content);
    w.endTurn(s);
    const b = w.last(m.kind);
    assertEquals([w.row(a.id).status, w.row(b.id).status, w.row(b.id).failure, out.unchecked], ["ready", "cancelled", UNCHECKED, true], m.kind);
    assertEquals(w.logs, ["jack_replace_write_failed"]);
    assertEquals(await pressEveryReady(w, m.kind), 1, m.kind);

    // The cancel misses without an error, and the read after it still shows the older card ready (a press
    // claimed it and put it back inside that moment): not proof it's gone.
    const x = new World();
    const xa = await m.older(x);
    const xwrite = x.deps.store.updateProposal;
    let missed = false;
    const xd: Deps = { ...x.deps, store: { ...x.deps.store, updateProposal: (c, id, patch, when, at) => {
      if (id === xa.id && !missed) { missed = true; return Promise.resolve(null); }
      return xwrite(c, id, patch, when, at);
    } } };
    const xs = x.turn();
    const xout = JSON.parse((await m.run(xd, xs, "Hi Dale, two.")).content);
    x.endTurn(xs);
    const xb = x.last(m.kind);
    assertEquals([missed, x.row(xa.id).status, x.row(xb.id).status, x.row(xb.id).failure, xout.unchecked], [true, "ready", "cancelled", UNCHECKED, true], m.kind);
    assertEquals(x.logs, ["jack_replace_write_failed"]);
    assertEquals(await pressEveryReady(x, m.kind), 1, m.kind);

    // The cancel lands but its answer is lost (it throws after writing). A failed write is a failed write:
    // the new card goes too, so none is left with a button rather than maybe two.
    const y = new World();
    const ya = await m.older(y);
    const ywrite = y.deps.store.updateProposal;
    const yd: Deps = { ...y.deps, store: { ...y.deps.store, updateProposal: async (c, id, patch, when, at) => {
      const r = await ywrite(c, id, patch, when, at);
      if (id === ya.id) throw new Error("proposal write failed");
      return r;
    } } };
    const ys = y.turn();
    const yout = JSON.parse((await m.run(yd, ys, "Hi Dale, two.")).content);
    y.endTurn(ys);
    assertEquals([y.row(ya.id).status, y.row(ya.id).failure, y.last(m.kind).status, yout.unchecked], ["cancelled", m.replaced, "cancelled", true], m.kind);
    assertEquals(y.logs, ["jack_replace_write_failed"]);
    assertEquals(await pressEveryReady(y, m.kind), 0, m.kind);
  }
});

Deno.test("a re-read that fails after the cancel missed puts the new card away, logged once", async () => {
  // The list read saw the older card ready, a press claimed it before the cancel, and reading it again fails:
  // it may be being sent, so the new card goes.
  for (const m of SAME_TARGET) {
    const w = new World();
    const a = await m.older(w);
    w.answer.crm_send_sms = () => new Promise(() => {});
    w.answer.resend_quote_email = () => new Promise(() => {});
    void w.press(a.id);
    await new Promise((r) => setTimeout(r, 0));
    assertEquals(w.row(a.id).status, "applying");
    const byId = w.deps.store.proposalsById;
    const read = w.deps.store.getProposal;
    const d: Deps = { ...w.deps, store: {
      ...w.deps.store,
      proposalsById: async (c, ids) => (await byId(c, ids)).map((r) => (r.id === a.id ? { ...r, status: "ready" } : r)),
      getProposal: (c, id) => (id === a.id ? Promise.reject(new Error("proposal read failed")) : read(c, id)),
    } };
    const s = w.turn();
    const out = JSON.parse((await m.run(d, s, "Hi Dale, two.")).content);
    w.endTurn(s);
    const b = w.last(m.kind);
    assertEquals([w.row(a.id).status, w.row(b.id).status, w.row(b.id).failure, out.unchecked], ["applying", "cancelled", UNCHECKED, true], m.kind);
    assertEquals(w.logs, ["jack_replace_read_failed"]);
    // A's own send is the only one; nothing is left to press.
    assertEquals(await pressEveryReady(w, m.kind), 1, m.kind);
  }
});

Deno.test("a text pressed at night whose texting hours open only after the card runs out ends, and promises no later press", async () => {
  // 816 is Central. Made at 07:30 on Nov 6 (quiet, before 8am), so it runs out at 07:30 on Nov 7. Pressed
  // at 9:15pm on Nov 6 (quiet again): texting opens at 8am on Nov 7, half an hour after the card is gone.
  const w = new World();
  w.now = Date.parse("2026-11-06T13:30:00.000Z");
  const p = await sendCard(w, text("Hi Dale, any questions on the barn? Mike"));
  assert(p.preview.quiet && Date.parse(p.preview.quiet.opensAt) < Date.parse(p.expires_at), "the card's own quiet box is inside its day");
  w.now = Date.parse("2026-11-07T03:15:00.000Z");
  await w.press(p.id);
  assertEquals([w.row(p.id).status, w.row(p.id).failure, w.sends().length], ["failed", SEND_SAID.quietPastCard, 0]);
  assertEquals(w.row(p.id).result?.waiting, undefined);
});

Deno.test("Claude's oldQuoteDays counts only with the person's own answer in this chat, at the card and again at the press", async () => {
  const body = "Hi Dale, your 12x24 Lofted Barn estimate is still $8,450. Mike";
  // No answer behind the number: it asks, and the card isn't made.
  const w = new World();
  w.memory = [];
  const out = JSON.parse((await draftTool.run(w.deps, w.turn(), { ...text(body), oldQuoteDays: 365 })).content);
  assertEquals([out.needsAnswer, out.unproven, w.proposals.size], ["old_quote_days", UNPROVEN_DAYS, 0]);
  // With it: the card holds the number and the question card it came from.
  const q = await w.answered(30);
  const p = await sendCard(w, { ...text(body), oldQuoteDays: 30 });
  assertEquals([p.payload.oldQuoteDays, p.payload.daysCard], [30, q.id]);
  // At the press the question card is read again: gone, and the price has no rule behind it.
  w.proposals.delete(q.id);
  await w.press(p.id);
  assertEquals([w.row(p.id).status, w.row(p.id).failure, w.sends().length], ["failed", SEND_SAID.askAgain, 0]);
  // Still there: it sends.
  const w2 = new World();
  w2.memory = [];
  await w2.answered(30);
  const p2 = await sendCard(w2, { ...text(body), oldQuoteDays: 30 });
  await w2.press(p2.id);
  assertEquals([w2.row(p2.id).status, w2.sends().length], ["applied", 1]);
});

Deno.test("the send cards say exactly who they go to, and a record with no name gets no card that sends", async () => {
  const w = new World();
  w.contact.company = "Miller Farms";
  const p = await sendCard(w);
  assertEquals([p.preview.fullName, p.preview.company, p.preview.town], ["Dale Miller", "Miller Farms", "Sedalia, MO"]);
  const e = await resendCard(w);
  assertEquals([e.preview.fullName, e.preview.company, e.preview.town], ["Dale Miller", "Miller Farms", "Sedalia, MO"]);
  // The whole name stays off Claude's side.
  const s = w.turn();
  const said = (await draftTool.run(w.deps, s, text())).content;
  assert(!said.includes("Miller"), said);
  // The name as the record holds it: a couple, a slash, a plus, a note in brackets and a number stay. A
  // phone number in it is blanked, with the bracket it leaves; a name that is only a number is no name.
  for (const [name, card] of [
    ["Bob & Mary Smith", "Bob & Mary Smith"],
    ["Bob/Mary Smith", "Bob/Mary Smith"],
    ["Dale + Pam Rivers", "Dale + Pam Rivers"],
    ["Dale Rivers (barn)", "Dale Rivers (barn)"],
    ["Dale Rivers 2", "Dale Rivers 2"],
    ["Mike O'Neil-Smith Jr.", "Mike O'Neil-Smith Jr."],
    ["Dale (816) 555-0142", "Dale"],
    ["Dale Rivers, 816-555-0199", "Dale Rivers"],
    ["Dale Rivers – 816.555.0142", "Dale Rivers"],
    ["Dale Rivers — 816.555.0142", "Dale Rivers"],
    ["Dale Rivers | 816-555-0199", "Dale Rivers"],
    ["816-555-0199 – Dale Rivers", "Dale Rivers"],
    ["Mary-Jo", "Mary-Jo"],
    ["Bob & (816) 555-0142", "Bob"],
    ["(816) 555-0142", null],
  ] as [string, string | null][]) {
    const x = new World();
    x.contact.name = name;
    const t = x.turn();
    const out = await draftTool.run(x.deps, t, text(card ? `Hi ${card.split(/\W/)[0]}, any questions on the barn? Mike` : "Hi, any questions on the barn? Mike"));
    assert(!out.isError, out.content);
    assertEquals(x.last().preview.fullName, card, name);
    assertEquals(x.last().kind, card ? "reply_send" : "reply_draft", name);
    // Claude still hears none of it beyond the first name it greets them by.
    for (const bit of ["Mary", "Smith", "Rivers", "barn)", "Pam", "555"]) assert(!out.content.includes(bit) || !name.includes(bit), `${bit} reached Claude: ${out.content}`);
    if (card) {
      const e = await resendCard(x);
      assertEquals(e.preview.fullName, card, `${name} (estimate)`);
    }
  }
  // A lead whose record holds only a number, or nothing, as its name: v1's card, no Approve, and it says why.
  for (const name of [null, "+1 816 555 0142", "   "]) {
    const x = new World();
    x.contact.name = name;
    const out = await draftTool.run(x.deps, x.turn(), text("Hi, any questions on the barn? Mike"));
    const c = x.last();
    assertEquals([c.kind, c.preview.sendable, c.preview.fullName], ["reply_draft", false, null], String(name));
    assert(c.preview.notes.includes(DRAFT_SAID.noName), JSON.stringify(c.preview.notes));
    assert(/no Approve button/.test(JSON.parse(out.content).note), out.content);
    assertEquals((await x.press(c.id)).status, 409);
    assertEquals(x.sends().length, 0);
  }
});

Deno.test("an operator asking for a text is told texting isn't available in view-as, never to send it from the record", async () => {
  const w = new World();
  const out = JSON.parse((await draftTool.run(w.deps, w.turn(operator), text())).content);
  assertEquals(w.last().kind, "reply_draft");
  assert(/Texting isn't available while viewing another account/.test(out.note) && !/send it from the customer's record/.test(out.note), out.note);
});

Deno.test("a database still on 377's kind list: the reply falls back to v1's copy card, and nothing can send", async () => {
  const w = new World();
  const insert = w.deps.store.insertProposal;
  w.deps.store.insertProposal = (p) => (p.kind === "reply_send" ? Promise.reject(new Error("proposal insert failed")) : insert(p));
  const s = w.turn();
  const out = await draftTool.run(w.deps, s, text());
  assert(!out.isError, out.content);
  const p = w.last();
  assertEquals([p.kind, p.preview.sendable, p.preview.ruleNotes, p.preview.quiet, p.title], ["reply_draft", false, [], null, "A text for you to send"]);
  assert(/no Approve button/.test(JSON.parse(out.content).note));
  assert(w.logs.includes("jack_send_card_refused"));
  assertEquals((await w.press(p.id)).status, 409);
  assertEquals(w.sends().length, 0);
});
