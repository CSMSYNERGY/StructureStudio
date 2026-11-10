// The setup piece (setup.ts), through agent.ts's own routing: the tools as Claude reaches them (runTool,
// toolsFor), and the cards as a person presses them (handleProposalApprove / handleProposalUndo). The
// portal routes are a fake that keeps the real ones' input, output and refusals (portal-settings status,
// save, save_branding, catalog, create_style, update_style, set_style_active, delete_style, save_fixture,
// delete_fixture, list_locations, save_location, delete_location, save_serial_start; portal-setup list
// and toggle with viaProposal). No network.

import { assert, assertEquals } from "./test_assert.ts";
import {
  type Deps, editAreasOf, handleProposalApprove, handleProposalGet, handleProposalUndo, type ProposalRow, READ_GIVE_UP_MS, runTool, SENTENCES, type Store,
  toolsFor, type TurnState, type Who,
} from "./agent.ts";
import { PIECE_KINDS, register } from "./pieces.ts";
import { GUIDES, SETUP_KINDS, setupPiece } from "./setup.ts";
import { leaksContactDetails } from "./redact.ts";

register([setupPiece]);

// deno-lint-ignore no-explicit-any
type Any = any;
type Res = { status: number; data: Record<string, unknown> | null };

const OWNER: Who = { clientId: "builder-a", userId: "u-owner", operatorEmail: null };
const REP: Who = { clientId: "builder-a", userId: "u-rep", operatorEmail: null };
const ok = (data: Record<string, unknown> = {}): Res => ({ status: 200, data: { ok: true, ...data } });
const no = (status: number, error: string): Res => ({ status, data: { error } });

// ── The builder's account, and the routes that read and save it ─────────────────────────────────────

class World {
  status: Any = {
    ok: true, clientId: "builder-a", role: "owner",
    businessName: "Ridgeline Barns", businessPhone: "(816) 555-0100", businessWebsite: null,
    businessAddress: { addressLine1: "1234 N Main St", city: "Sedalia", state: "MO", postalCode: "65301", countryCode: "US" },
    businessLogoUrl: "https://cdn.example/logo.png", quoteTerms: null, quoteValidDays: 30, showPricing: false,
    betaMode: false, betaEmail: "owner@ridgeline.example",
    invoiceInGhl: false, ghlInvoicingAllowed: false, ssQuoteNext: null, ssQuotePrefix: "", ssInvoiceNext: null, ssInvoicePrefix: "",
    ssTaxRate: 7.25, emailReady: false,
    branding: { companyName: "Ridgeline", tagline: null, logoUrl: null, accentColor: "#D97706", headerBg: null },
  };
  styles: Any[] = [
    { id: "st-garden", key: "garden", label: "Garden Shed", code: "GS", active: true },
    { id: "st-util", key: "utility", label: "Utility", code: null, active: true },
  ];
  sizes: Any[] = [{ id: "z1", style_id: "st-garden", label: "10x12" }];
  fixtures: Any[] = [{ id: "d1", category: "door", name: "Single door", width_in: 36, height_in: 80, archived: false }];
  rampSettings: Any = { mode: "simple", enabled: true };
  lots: Any[] = [{ id: "lot-1", name: "Main Lot", street: "88 County Road 12", city: "Sedalia", state: "MO", zip: "65301", active: true, buildings: 2 }];
  nextSerial: number | null = null;
  steps: Any[] = [
    step("step-1", "password", "Set your password and sign in", "2026-11-01T00:00:00Z"),
    step("step-2", "business", "Add your business details and logo"),
    step("step-3", "show_prices", "Decide if customers see prices"),
    step("step-4", "paperwork", "Choose how quotes & invoices go out"),
    step("step-5", "locations", "Add sales locations & your serial number start"),
    { ...step("step-6", "quickbooks", "QuickBooks: connect & map your items"), locked: true, requiresFeature: "quickbooks_sync" },
    // A bespoke step an operator wrote, with a phone number in it.
    step("step-7", null, "Call us at 816-555-0199 or write to help@example.com about your lot"),
  ];
  canTick = true;
  calls: { fn: string; action: string; body: Any }[] = [];
  /** Forced answers by action, for the failure paths. */
  answer: Record<string, Res | ((body: Any) => Res)> = {};
  stamps = new Map<string, string>();
  store: Store | null = null;
  seq = 0;

  route(fn: string, action: string, body: Any, who: Who): Res {
    this.calls.push({ fn, action, body });
    const forced = this.answer[`${fn}:${action}`] ?? this.answer[action];
    if (forced) return typeof forced === "function" ? forced(body) : forced;
    if (fn === "portal-setup") return this.setup(action, body, who);
    const s = this.status;
    switch (action) {
      case "status": return { status: 200, data: structuredClone(s) };
      case "save": {
        const text = (v: unknown) => (String(v ?? "").trim() || null);
        const inGhl = "invoiceInGhl" in body ? body.invoiceInGhl === true && s.ghlInvoicingAllowed : s.invoiceInGhl;
        if (("invoiceInGhl" in body || "ssQuoteNext" in body || "ssInvoiceNext" in body) && !inGhl && s.ssTaxRate === null) {
          return no(400, "StructureStudio needs a sales tax rate before it can issue your invoices.");
        }
        for (const [k, v] of Object.entries(body)) {
          if (k === "businessAddress") s.businessAddress = v;
          else if (k === "showPricing") s[k] = v === true;
          // The real save keeps it at false where CRM paperwork isn't allowed, and still answers ok.
          else if (k === "invoiceInGhl") s[k] = v === true && s.ghlInvoicingAllowed === true;
          else if (typeof v === "number") s[k] = v;
          else s[k] = text(v);
        }
        return ok();
      }
      case "save_branding":
        for (const [k, v] of Object.entries(body)) s.branding[k] = String(v ?? "").trim() || null;
        return ok();
      case "catalog":
        return ok({ styles: structuredClone(this.styles), sizes: structuredClone(this.sizes), fixtures: structuredClone(this.fixtures), rampSettings: this.rampSettings });
      case "create_style": {
        if (this.styles.some((x) => x.code === body.code)) return no(409, `Another style already uses the serial code "${body.code}". Each style needs its own.`);
        const id = `st-new-${++this.seq}`;
        this.styles.push({ id, label: body.label, code: body.code, active: true });
        return ok({ styleId: id, key: id });
      }
      case "update_style": {
        const st = this.styles.find((x) => x.id === body.styleId);
        if (!st) return no(404, "Style not found (or not yours).");
        if ("code" in body && !String(body.code ?? "").trim()) return no(400, "A serial code is required for every style (e.g. LBA).");
        if ("label" in body) st.label = body.label;
        if ("code" in body) st.code = body.code;
        return ok({ imageUrl: null });
      }
      case "set_style_active": {
        const st = this.styles.find((x) => x.id === body.styleId);
        if (st) st.active = body.active !== false;
        return ok();
      }
      case "delete_style": {
        const i = this.styles.findIndex((x) => x.id === body.styleId);
        if (i < 0) return no(404, "Style not found (or not yours).");
        this.styles.splice(i, 1);
        this.sizes = this.sizes.filter((z) => z.style_id !== body.styleId);
        return ok();
      }
      case "save_fixture": {
        const id = `fx-${++this.seq}`;
        this.fixtures.push({ id, category: body.category, name: body.name, width_in: body.widthIn, height_in: body.heightIn, price: body.price });
        this.stamps.set(id, "t1");
        return ok({ id });
      }
      case "delete_fixture": {
        const i = this.fixtures.findIndex((x) => x.id === body.id);
        if (i < 0) return no(404, "That item is not in the catalog any more.");
        this.fixtures.splice(i, 1);
        this.stamps.delete(body.id);
        return ok();
      }
      case "list_locations": return ok({ locations: structuredClone(this.lots), nextSerial: this.nextSerial });
      case "save_location": {
        if (!String(body.name ?? "").trim()) return no(400, "Location name is required.");
        const id = `lot-new-${++this.seq}`;
        const str = (v: unknown) => String(v ?? "").trim() || null;
        this.lots.push({ id, name: body.name, street: str(body.street), city: str(body.city), state: str(body.state), zip: str(body.zip), active: true, buildings: 0 });
        return ok({ id });
      }
      case "delete_location": {
        const i = this.lots.findIndex((x) => x.id === body.id);
        if (i < 0) return no(404, "Location not found.");
        this.lots.splice(i, 1);
        return ok();
      }
      case "save_serial_start":
        if (this.nextSerial !== null && body.nextSerial < this.nextSerial) return no(400, `The next serial must be at least ${this.nextSerial}.`);
        this.nextSerial = body.nextSerial;
        return ok({ nextSerial: body.nextSerial });
    }
    return no(400, `Unknown action ${action}`);
  }

  /** portal-setup, as index.ts answers: the viaProposal check reads the card from the store. */
  setup(action: string, body: Any, who: Who): Res {
    if (action === "list") {
      const counted = this.steps.filter((x) => !x.locked);
      return {
        status: 200,
        data: { items: structuredClone(this.steps), counts: { total: counted.length, done: counted.filter((x) => x.completed_at).length, open: counted.filter((x) => !x.completed_at).length }, canEdit: this.canTick },
      };
    }
    if (action !== "toggle") return no(400, "Unknown action");
    if (!this.canTick) return no(403, "Your account can view designs and leads but not change settings. Ask an owner or admin.");
    const row = this.steps.find((x) => x.id === body.id);
    if (!row) return no(404, "That setup step is not on your list.");
    if (body.done && row.locked && !row.completed_at) return no(403, "That step needs an add-on your account doesn't have yet.");
    if (body.viaProposal && body.done) {
      const card = this.cards.get(body.viaProposal);
      const match = card && card.client_id === who.clientId && card.status === "applying" && card.approved_by === who.userId && (card.payload?.ticks ?? []).some((x: Any) => x.id === row.id);
      if (!match) return no(403, "That approval doesn't match this step.");
      if (row.completed_at) return ok({ already: true, item: row });
    }
    if (body.viaProposal && !body.done) {
      if (!row.completed_at) return ok({ item: row });
      if (row.completed_proposal_id !== body.viaProposal) return { status: 409, data: { error: "Someone ticked that step themselves, so it stays ticked.", kept: true } };
    }
    if (body.done) Object.assign(row, { completed_at: "2026-11-06T12:00:00Z", completed_via: body.viaProposal ? "jack" : null, completed_proposal_id: body.viaProposal ?? null });
    else Object.assign(row, { completed_at: null, completed_via: null, completed_proposal_id: null });
    return ok({ item: row });
  }
  cards = new Map<string, ProposalRow>();
  step(id: string) {
    return this.steps.find((x) => x.id === id);
  }
  saves(action: string) {
    return this.calls.filter((c) => c.action === action).map((c) => c.body);
  }
}

function step(id: string, key: string | null, title: string, completed_at: string | null = null) {
  return { id, key, title, detail: null, link_page: "settings/structures", section: "The basics", image_url: null, position: 1, completed_at, completed_by_kind: completed_at ? "client" : null, completed_by_name: completed_at ? "Mike" : null, completed_via: null, locked: false, requiresFeature: null };
}

/** What a jsonb column gives back: object keys shortest first, then alphabetical, never the order written. */
function jsonb<T>(v: T): T {
  if (Array.isArray(v)) return v.map(jsonb) as T;
  if (v && typeof v === "object") {
    const keys = Object.keys(v as object).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(keys.map((k) => [k, jsonb((v as Record<string, unknown>)[k])])) as T;
  }
  return v;
}

function makeStore(world: World): Store {
  let seq = 0;
  const cards = world.cards;
  const none = () => Promise.resolve();
  return {
    settings: () => Promise.resolve({ on: true, off: [] }),
    setOff: none,
    usage: () => Promise.resolve({ monthCostMicros: 0, tenant24h: 0, user10m: 0, sheets24h: 0 }),
    openChat: () => Promise.resolve(null),
    createChat: () => Promise.resolve("chat1"),
    chats: () => Promise.resolve([]),
    messages: () => Promise.resolve([]),
    addMessage: (m) => Promise.resolve({ id: `m${++seq}`, role: m.role, body: m.body, created_at: "now", proposal_ids: m.proposalIds ?? [] }),
    bumpChat: none,
    closeChats: none,
    reopenChat: () => Promise.resolve(true),
    accountLine: () => Promise.resolve({ firstName: "Mike", title: "Owner", business: "Ridgeline", role: "owner" }),
    insertProposal: (p) => {
      const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
      const now = new Date().toISOString();
      const row = { id, conversation_id: null, file_name: null, source: {}, preview: {}, payload: {}, answers: {}, result: null, undo: null, shown_hash: null, failure: null, approved_by: null, approved_by_operator: null, approved_at: null, applied_at: null, undone_at: null, expires_at: new Date(Date.now() + 86_400_000).toISOString(), created_at: now, updated_at: now, ...jsonb(structuredClone(p)) } as ProposalRow;
      cards.set(id, row);
      return Promise.resolve(row);
    },
    getProposal: (c, id) => { const r = cards.get(id); return Promise.resolve(r && r.client_id === c ? r : null); },
    updateProposal: (c, id, patch, when, at) => {
      const r = cards.get(id);
      if (!r || r.client_id !== c || (when && !when.includes(r.status)) || (at && r.updated_at !== at)) return Promise.resolve(null);
      Object.assign(r, jsonb(structuredClone(patch)));
      return Promise.resolve(r);
    },
    addProposalCost: none,
    proposals: () => Promise.resolve([...cards.values()]),
    proposalsById: (_c, ids) => Promise.resolve(ids.map((i) => cards.get(i)!).filter(Boolean)),
    names: () => Promise.resolve({}),
    fixtureStamp: (_c, id) => Promise.resolve(world.stamps.get(id) ?? null),
    memory: () => Promise.resolve([]),
    putMemory: () => Promise.resolve(false),
    forgetMemory: () => Promise.resolve(false),
  };
}

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

/** One person's turn. `edit` and `read` are their areas: "all", or a list. */
function turn(world: World, o: { who?: Who; edit?: string[] | "all"; read?: string[] | "all"; off?: string[] } = {}) {
  const who = o.who ?? OWNER;
  const store = world.store ?? (world.store = makeStore(world));
  const edit = o.edit ?? "all", read = o.read ?? edit;
  const has = (set: string[] | "all", a: string) => set === "all" || set.includes(a);
  const deps: Deps = {
    env: () => undefined,
    store,
    portal: (action, body) => Promise.resolve(world.route("portal-settings", action, body, who)),
    call: (fn, action, body) => Promise.resolve(world.route(fn, action, body, who)),
    wallet: quietWallet(),
    fetch: () => { throw new Error("Claude isn't called in these tests"); },
    canRead: (a) => has(read, a) || has(edit, a),
    canEdit: (a) => has(edit, a),
    background: () => {},
    budgetMs: () => 300_000,
    makeId: () => crypto.randomUUID(),
    hash: (text) => Promise.resolve(`h${text.length}:${text.slice(0, 60)}`),
    log: () => Promise.resolve(),
    audit: () => Promise.resolve(),
    now: () => Date.now(),
    markSentWithJack: () => Promise.resolve(true),
  };
  const s: TurnState = { who, chatId: "chat1", off: o.off ?? [], proposalIds: [] };
  return { deps, s, who };
}

const lastCard = (world: World) => [...world.cards.values()].at(-1)!;
const approve = (deps: Deps, who: Who, p: ProposalRow) => handleProposalApprove(deps, who, { id: p.id, hash: p.shown_hash });
const undo = (deps: Deps, who: Who, p: ProposalRow) => handleProposalUndo(deps, who, { id: p.id });
const tool = (deps: Deps, s: TurnState, name: string, input: unknown) => runTool(deps, s, name, input);

// ── The piece's shape ─────────────────────────────────────────────────────────────────────────────

Deno.test("the piece: its kinds are registered, none is private, and every tool sits behind the setup switch", () => {
  assertEquals(SETUP_KINDS, ["setup_company", "setup_paperwork", "setup_styles", "setup_fixture", "setup_locations", "setup_tick", "setup_guide"]);
  for (const k of SETUP_KINDS) {
    assert(PIECE_KINDS.has(k), k);
    assert(!PIECE_KINDS.get(k)!.private, `${k} holds no customer data`);
  }
  for (const t of setupPiece.tools) {
    assertEquals(t.switchKey, "setup", t.def.name);
    assert(!t.customerWords, `${t.def.name} reads no customer's words`);
    assertEquals(!!t.proposesChange, t.def.name.startsWith("propose_"), t.def.name);
    // No nullable fields: strict tools share a request-wide budget of union-typed parameters.
    assert(!JSON.stringify(t.def.input_schema).includes("anyOf"), `${t.def.name} has no union types`);
  }
  // The never-list: no tool for tax, team, billing, colors or Customer Hub's settings.
  const names = setupPiece.tools.map((t) => t.def.name).join(" ");
  assert(!/tax|team|billing|color|email|sms|phone/i.test(names));
});

Deno.test("the switch: setup off takes every setup tool away, and its cards can't be approved", async () => {
  const w = new World();
  const on = turn(w);
  assert(toolsFor(on.deps, on.s).some((t) => t.name === "look_at_my_setup"));
  await tool(on.deps, on.s, "propose_company_details", { changes: [{ field: "tagline", value: "Built right" }] });
  const p = lastCard(w);
  const off = turn(w, { off: ["setup"] });
  assertEquals(toolsFor(off.deps, off.s).filter((t) => setupPiece.tools.some((x) => x.def.name === t.name)), []);
  assertEquals((await tool(off.deps, off.s, "look_at_my_setup", {})).isError, true);
  // The account's switch, as the store reads it at the press.
  const store = w.store!;
  store.settings = () => Promise.resolve({ on: true, off: ["setup"] });
  const r = await approve(off.deps, OWNER, p);
  assertEquals([r.status, r.body.error], [403, SENTENCES.switchedOff]);
  assertEquals(w.saves("save_branding"), []);
});

Deno.test("after a customer's words, the setup proposals are not offered; the look and the guide still are", () => {
  const { deps, s } = turn(new World());
  s.customerWordsRead = true;
  const offered = toolsFor(deps, s).map((t) => t.name);
  assert(offered.includes("look_at_my_setup") && offered.includes("point_to_step"));
  // A reply draft and an estimate emailed again move no setting, price, rule or record, so they stay (v2
  // 11-06; 378). Schedule and delivery changes are change tools since 11-09; every setup proposal goes.
  const stays = new Set(["propose_reply_draft", "propose_estimate_resend"]);
  assert(!offered.some((n) => n.startsWith("propose_") && !stays.has(n)), offered.join(","));
});

// ── look_at_my_setup ──────────────────────────────────────────────────────────────────────────────

Deno.test("look: steps with refs, counts and how Jack helps; no phone, email or street reaches Claude", async () => {
  const w = new World();
  const { deps, s } = turn(w);
  const out = await tool(deps, s, "look_at_my_setup", {});
  assert(!out.isError, out.content);
  assert(!leaksContactDetails(out.content), out.content);
  assert(!/Main St|County Road/.test(out.content), "no street line");
  const a = JSON.parse(out.content);
  assertEquals(a.counts, { total: 6, done: 1, open: 5 });
  assertEquals(a.steps.map((x: Any) => x.ref), ["password", "business", "show_prices", "paperwork", "locations", "quickbooks", "s7"]);
  assertEquals(a.steps[5].locked, true);
  assert(a.steps[1].help.includes("propose_company_details"));
  assert(a.steps[0].help.includes("point_to_step"));
  assertEquals(a.company.businessPhone, "set");
  assertEquals(a.company.businessAddress, "set (Sedalia, MO)");
  assertEquals(a.company.salesTaxRate, "set");
  assertEquals(a.lots, { count: 1, serialStart: "not set" });
  // A look writes nothing.
  assertEquals(w.cards.size, 0);
  assertEquals(w.calls.map((c) => c.action).sort(), ["list", "list_locations", "status"]);
});

Deno.test("look: a checklist that can't be read is said, never guessed; a settings read that fails leaves the steps", async () => {
  const w = new World();
  w.answer["portal-setup:list"] = { status: 500, data: null };
  const a = turn(w);
  const out = await tool(a.deps, a.s, "look_at_my_setup", {});
  assertEquals([out.isError, out.content], [true, "I couldn't read that just now, so I won't guess. Please try again."]);
  assertEquals(a.s.proposalIds, []);
  const w2 = new World();
  w2.answer.status = { status: 0, data: null };
  const b = turn(w2);
  const out2 = JSON.parse((await tool(b.deps, b.s, "look_at_my_setup", {})).content);
  assertEquals(out2.company, null);
  assertEquals(out2.steps.length, 7);
});

Deno.test("look: someone without the paperwork area sees the steps but not the numbering", async () => {
  const w = new World();
  // portal-settings filters the CRM block out of `status` for them.
  const { deps, s } = turn(w, { edit: [], read: ["settings_branding"] });
  w.answer.status = () => {
    const d = structuredClone(w.status);
    for (const k of ["invoiceInGhl", "ghlInvoicingAllowed", "ssQuoteNext", "ssQuotePrefix", "ssInvoiceNext", "ssInvoicePrefix", "ssTaxRate", "emailReady"]) delete d[k];
    return { status: 200, data: d };
  };
  const a = JSON.parse((await tool(deps, s, "look_at_my_setup", {})).content);
  assertEquals(a.company.quotesAndInvoices, "not part of this person's access");
  assertEquals(a.company.salesTaxRate, undefined);
});

// ── Business details and branding ─────────────────────────────────────────────────────────────────

Deno.test("company: only the changed keys go on the card, branding apart from settings, and Claude hears labels, not values", async () => {
  const w = new World();
  const { deps, s } = turn(w);
  const out = await tool(deps, s, "propose_company_details", { changes: [
    { field: "businessName", value: "Ridgeline Barns" }, // already so
    { field: "businessPhone", value: "(816) 555-0123" },
    { field: "city", value: "Warsaw" },
    { field: "tagline", value: "Built right, built here" },
    { field: "showPricing", value: "yes" },
  ] });
  assert(!out.isError, out.content);
  assert(!leaksContactDetails(out.content), out.content);
  const a = JSON.parse(out.content);
  assertEquals(a.changing, ["Business phone", "Business address", "Tagline", "Customers see prices"]);
  assertEquals(a.alreadyMatching, ["Business name"]);
  assertEquals(a.ticksStep, ["Add your business details and logo", "Decide if customers see prices"]);
  const p = lastCard(w);
  assertEquals(p.kind, "setup_company");
  assertEquals(p.status, "ready");
  assertEquals(p.payload.calls.save, {
    businessPhone: "(816) 555-0123",
    businessAddress: { addressLine1: "1234 N Main St", city: "Warsaw", state: "MO", postalCode: "65301", countryCode: "US" },
    showPricing: true,
  });
  assertEquals(p.payload.calls.save_branding, { tagline: "Built right, built here" });
  assert(p.shown_hash, "the payload is hashed when written");
  // Both areas, as portal-settings' save gate.
  assertEquals(editAreasOf(p), ["settings_crm", "settings_branding"]);
  // Nothing saved yet.
  assertEquals([w.saves("save"), w.saves("save_branding")], [[], []]);
  // The person sees the old and new values.
  assertEquals(p.preview.lines[0], { label: "Business phone", from: "(816) 555-0100", to: "(816) 555-0123" });
  assert(!/Ridgeline|Mike/.test(p.title) || p.title === "Your business details");
});

Deno.test("company: Approve saves exactly the card, then ticks its steps with the card's id", async () => {
  const w = new World();
  const { deps, s } = turn(w);
  await tool(deps, s, "propose_company_details", { changes: [{ field: "businessPhone", value: "816 555 0123" }, { field: "city", value: "Warsaw" }, { field: "showPricing", value: "yes" }, { field: "tagline", value: "Built here" }] });
  const p = lastCard(w);
  const wrong = await handleProposalApprove(deps, OWNER, { id: p.id, hash: "not what was shown" });
  assertEquals(wrong.status, 409);
  assertEquals(w.saves("save"), []);
  const r = await approve(deps, OWNER, p);
  assertEquals(r.status, 200);
  // The address was read back from jsonb in another key order, and still matched its guard.
  assertEquals(w.saves("save"), [{ businessPhone: "816 555 0123", businessAddress: { addressLine1: "1234 N Main St", city: "Warsaw", state: "MO", postalCode: "65301", countryCode: "US" }, showPricing: true }]);
  assertEquals(w.saves("save_branding"), [{ tagline: "Built here" }]);
  const done = w.cards.get(p.id)!;
  assertEquals(done.status, "applied");
  assertEquals(done.result.ticked, ["Add your business details and logo", "Decide if customers see prices"]);
  assertEquals(w.calls.filter((c) => c.action === "toggle").map((c) => c.body), [
    { id: "step-2", done: true, viaProposal: p.id },
    { id: "step-3", done: true, viaProposal: p.id },
  ]);
  assertEquals([w.step("step-2").completed_via, w.step("step-3").completed_via], ["jack", "jack"]);
  // A second press runs nothing.
  assertEquals((await approve(deps, OWNER, p)).status, 409);
  assertEquals(w.saves("save").length, 1);
});

Deno.test("company: Undo puts back only what still holds Jack's value, and takes back only Jack's ticks", async () => {
  const w = new World();
  const { deps, s } = turn(w);
  await tool(deps, s, "propose_company_details", { changes: [{ field: "businessPhone", value: "816-555-0123" }, { field: "postalCode", value: "65355" }, { field: "quoteTerms", value: "Half down." }, { field: "tagline", value: "Built here" }, { field: "showPricing", value: "yes" }] });
  const p = lastCard(w);
  await approve(deps, OWNER, p);
  // Meanwhile someone edits the terms by hand, and unticks and reticks the prices step themselves.
  w.status.quoteTerms = "Half down, rest on delivery.";
  Object.assign(w.step("step-3"), { completed_via: null, completed_proposal_id: null });
  const r = await undo(deps, OWNER, p);
  assertEquals(r.status, 200);
  const row = w.cards.get(p.id)!;
  assertEquals(row.status, "undone");
  assertEquals(w.saves("save").at(-1), { businessPhone: "(816) 555-0100", businessAddress: { addressLine1: "1234 N Main St", city: "Sedalia", state: "MO", postalCode: "65301", countryCode: "US" }, showPricing: false });
  assertEquals(w.saves("save_branding").at(-1), { tagline: "" });
  assertEquals([w.status.businessPhone, w.status.quoteTerms, w.status.branding.tagline, w.status.showPricing], ["(816) 555-0100", "Half down, rest on delivery.", null, false]);
  const reports = row.result.undo.reports.map((x: Any) => `${x.label}: ${x.status}`);
  assertEquals(reports, ["Estimate terms: changed", "Decide if customers see prices: changed"]);
  assertEquals([w.step("step-2").completed_at, w.step("step-3").completed_at === null], [null, false]);
});

Deno.test("company: a field that moved during the review stops the whole card; nothing is saved", async () => {
  const w = new World();
  const { deps, s } = turn(w);
  await tool(deps, s, "propose_company_details", { changes: [{ field: "businessPhone", value: "816-555-0123" }, { field: "tagline", value: "Built here" }] });
  w.status.businessPhone = "(660) 555-0177";
  const r = await approve(deps, OWNER, lastCard(w));
  assertEquals(r.status, 200);
  const row = lastCard(w);
  assertEquals(row.status, "failed");
  assert(row.failure!.startsWith("Business phone changed since I showed you this"), row.failure!);
  assertEquals([w.saves("save"), w.saves("save_branding"), w.calls.filter((c) => c.action === "toggle")], [[], [], []]);
});

Deno.test("company: a refusal is the route's sentence and nothing is ticked; a lost answer says check before trying again", async () => {
  const w = new World();
  const { deps, s } = turn(w);
  await tool(deps, s, "propose_company_details", { changes: [{ field: "showPricing", value: "yes" }, { field: "tagline", value: "Built here" }] });
  w.answer.save = no(400, "Nothing to save.");
  w.answer.save_branding = { status: 502, data: null };
  await approve(deps, OWNER, lastCard(w));
  const row = lastCard(w);
  assertEquals(row.status, "partly_applied");
  assertEquals(row.result.reports.map((x: Any) => [x.label, x.status, x.reason]), [
    ["Customers see prices", "refused", "Nothing to save."],
    ["Tagline", "error", "I couldn't tell if that saved. Check Settings > Company before trying again."],
  ]);
  assertEquals(w.calls.filter((c) => c.action === "toggle"), []);
  // The lost one may have landed, so Undo still covers it.
  assertEquals(row.undo.fields.map((f: Any) => f.key), ["tagline"]);
});

Deno.test("company: Undo that can't read settings, or whose save is lost, keeps the card undoable", async () => {
  const w = new World();
  const { deps, s } = turn(w);
  await tool(deps, s, "propose_company_details", { changes: [{ field: "tagline", value: "Built here" }] });
  const p = lastCard(w);
  await approve(deps, OWNER, p);
  w.answer.status = { status: 0, data: null };
  await undo(deps, OWNER, p);
  assertEquals([w.cards.get(p.id)!.status, ((await handleProposalGet(deps, OWNER, { id: p.id })).body.proposal as Any).canUndo], ["applied", true]);
  delete w.answer.status;
  w.answer.save_branding = { status: 503, data: null };
  await undo(deps, OWNER, p);
  assertEquals(w.cards.get(p.id)!.status, "applied");
  delete w.answer.save_branding;
  await undo(deps, OWNER, p);
  assertEquals([w.cards.get(p.id)!.status, w.status.branding.tagline], ["undone", null]);
});

Deno.test("company: the two-area gate, the same as portal-settings' save", async () => {
  const w = new World();
  // Branding only: may change the customer link's look, not business details.
  const brand = turn(w, { edit: ["settings_branding", "jack"] });
  const refused = await tool(brand.deps, brand.s, "propose_company_details", { changes: [{ field: "businessPhone", value: "816-555-0123" }] });
  assertEquals([refused.isError, refused.content], [true, SENTENCES.noAccess]);
  const fine = await tool(brand.deps, brand.s, "propose_company_details", { changes: [{ field: "tagline", value: "Built here" }] });
  assert(!fine.isError, fine.content);
  assertEquals(editAreasOf(lastCard(w)), ["settings_branding"]);
  // A card that needs both can't be approved by someone holding one.
  const owner = turn(w);
  await tool(owner.deps, owner.s, "propose_company_details", { changes: [{ field: "showPricing", value: "yes" }] });
  const r = await approve(brand.deps, OWNER, lastCard(w));
  assertEquals(r.status, 403);
  assertEquals(w.saves("save"), []);
  // Without Branding edit, the tool isn't offered at all.
  const none = turn(w, { edit: ["settings_crm"] });
  assert(!toolsFor(none.deps, none.s).some((t) => t.name === "propose_company_details"));
});

Deno.test("company: refusals in plain words: a clear, a color, a bad number, nothing to change", async () => {
  const w = new World();
  const { deps, s } = turn(w);
  const r = await tool(deps, s, "propose_company_details", { changes: [{ field: "businessName", value: "" }, { field: "accentColor", value: "orange; x" }, { field: "quoteValidDays", value: "400" }, { field: "businessPhone", value: "555" }] });
  assertEquals(r.isError, true);
  for (const bit of ["I don't clear a box", "Settings > Company > Branding", "from 1 to 365", "doesn't look like a phone number"]) assert(r.content.includes(bit), bit);
  assert(!r.content.includes("hex code"), "a color is guide only, so its format isn't checked");
  const same = JSON.parse((await tool(deps, s, "propose_company_details", { changes: [{ field: "customerLinkName", value: "Ridgeline" }] })).content);
  assertEquals(same.shown, false);
  assertEquals(w.cards.size, 0);
  w.status.quoteValidDays = null;
  const unread = await tool(deps, s, "propose_company_details", { changes: [{ field: "quoteValidDays", value: "45" }] });
  assert(unread.isError && unread.content.includes("can't read how long"), unread.content);
});

Deno.test("company: the accent color is guide only: not offered, refused with no card, still reported by the look", async () => {
  const w = new World();
  const { deps, s } = turn(w);
  // Claude isn't offered it, and isn't told it can.
  const def = setupPiece.tools.find((t) => t.def.name === "propose_company_details")!.def as Any;
  assert(!def.input_schema.properties.changes.items.properties.field.enum.includes("accentColor"));
  assert(!/accent/i.test(JSON.stringify(def)), "the tool doesn't mention an accent color");
  assert(!setupPiece.can.some((l) => /accent/i.test(l)), "the can lines don't offer it");
  assert((setupPiece.rules ?? []).some((l) => /accent color/i.test(l) && /guide only/i.test(l)), "the rules say it's guide only");
  // A good hex code arriving anyway is refused with the place to set it, alone or next to a good change.
  for (const changes of [[{ field: "accentColor", value: "#1b7895" }], [{ field: "tagline", value: "Built here" }, { field: "accentColor", value: "#1b7895" }]]) {
    const r = await tool(deps, s, "propose_company_details", { changes });
    assertEquals(r.isError, true);
    assertEquals(r.content, "Accent color: I can't change colors from here. You set it in Settings > Company > Branding.");
  }
  assertEquals([w.cards.size, s.proposalIds, w.saves("save_branding")], [0, [], []]);
  assertEquals(w.status.branding.accentColor, "#D97706");
  // The look still says what's on file.
  const look = JSON.parse((await tool(deps, s, "look_at_my_setup", {})).content);
  assertEquals(look.company.accentColor, "#D97706");
});

Deno.test("company: no logo yet means the business step isn't ticked, and the card says why; a rep's card ticks nothing", async () => {
  const w = new World();
  w.status.businessLogoUrl = null;
  const { deps, s } = turn(w);
  await tool(deps, s, "propose_company_details", { changes: [{ field: "businessWebsite", value: "ridgeline.example" }] });
  const p = lastCard(w);
  assertEquals(p.payload.ticks, []);
  assert(p.preview.notes[0].includes("logo"), p.preview.notes[0]);
  const w2 = new World();
  w2.canTick = false;
  const rep = turn(w2, { who: REP });
  await tool(rep.deps, rep.s, "propose_company_details", { changes: [{ field: "showPricing", value: "yes" }] });
  assertEquals(lastCard(w2).payload.ticks, []);
});

Deno.test("the live checklist's split steps: business ticks without the logo; lots and the serial start tick apart", async () => {
  const split = () => {
    const w = new World();
    w.steps = [
      step("step-2", "business", "Add your business details"),
      step("step-8", "logo", "Set up your logo and branding"),
      step("step-5", "locations", "Add your sales locations"),
      step("step-9", "serial", "Set where your building serial numbers start"),
    ];
    return w;
  };
  const w = split();
  w.status.businessLogoUrl = null;
  const { deps, s } = turn(w);
  await tool(deps, s, "propose_company_details", { changes: [{ field: "businessWebsite", value: "ridgeline.example" }] });
  assertEquals(lastCard(w).payload.ticks.map((x: Any) => x.id), ["step-2"]);
  const lots = await tool(deps, s, "propose_locations", { lots: [{ name: "Clinton Lot", street: "", city: "Clinton", state: "MO", zip: "" }], serialStart: 0 });
  assert(!lots.isError, lots.content);
  assertEquals(lastCard(w).payload.ticks.map((x: Any) => x.id), ["step-5"]);
  const w2 = split();
  w2.lots = [];
  const t2 = turn(w2);
  await tool(t2.deps, t2.s, "propose_locations", { lots: [], serialStart: 5000 });
  assertEquals(lastCard(w2).payload.ticks.map((x: Any) => x.id), ["step-9"]);
});

Deno.test("company: someone who can save but not tick gets the save, and the card says the tick didn't take", async () => {
  const w = new World();
  const { deps, s } = turn(w);
  await tool(deps, s, "propose_company_details", { changes: [{ field: "showPricing", value: "yes" }] });
  const p = lastCard(w);
  w.canTick = false;
  await approve(deps, OWNER, p);
  const row = w.cards.get(p.id)!;
  assertEquals(row.status, "applied");
  assertEquals(row.result.ticked, []);
  assert(row.result.tickNotes[0].startsWith("It's saved, but I couldn't tick"), row.result.tickNotes[0]);
  assertEquals(w.status.showPricing, true);
});

Deno.test("company: an operator in view-as may approve, and the record names them", async () => {
  const w = new World();
  const op: Who = { clientId: "builder-a", userId: "u-op", operatorEmail: "ahsan@example.test" };
  const { deps, s } = turn(w, { who: op });
  await tool(deps, s, "propose_company_details", { changes: [{ field: "showPricing", value: "yes" }] });
  const p = lastCard(w);
  await approve(deps, op, p);
  const row = w.cards.get(p.id)!;
  assertEquals([row.status, row.approved_by, row.approved_by_operator], ["applied", "u-op", "ahsan@example.test"]);
  assertEquals(w.step("step-3").completed_via, "jack");
});

Deno.test("a save that dies part way gives up with where to look", async () => {
  const w = new World();
  const { deps, s } = turn(w);
  await tool(deps, s, "propose_company_details", { changes: [{ field: "tagline", value: "Built here" }] });
  const p = lastCard(w);
  Object.assign(p, { status: "applying", updated_at: new Date(Date.now() - READ_GIVE_UP_MS - 1000).toISOString() });
  const got = (await handleProposalGet(deps, OWNER, { id: p.id })).body.proposal as Any;
  assertEquals(got.status, "partly_applied");
  assert(JSON.stringify(got.result).includes("Check Settings > Company before trying again"));
});

// ── Paperwork ─────────────────────────────────────────────────────────────────────────────────────

Deno.test("paperwork: no tax rate on file means a guide to Sales Tax, never a paperwork card", async () => {
  const w = new World();
  w.status.ssTaxRate = null;
  const { deps, s } = turn(w);
  const out = await tool(deps, s, "propose_paperwork", { changes: [{ field: "quoteStart", value: "5000" }] });
  const a = JSON.parse(out.content);
  assertEquals([a.refused, a.guideShown], [true, true]);
  const p = lastCard(w);
  assertEquals([p.kind, p.status, p.preview.route], ["setup_guide", "applied", { page: "settings", sub: "tax" }]);
  assertEquals((await approve(deps, OWNER, p)).status, 409);
  assertEquals(w.saves("save"), []);
});

Deno.test("paperwork: numbers are one-way, so the card says so and Undo leaves them; the step is ticked", async () => {
  const w = new World();
  w.status.invoiceInGhl = true;
  w.status.ghlInvoicingAllowed = true;
  const { deps, s } = turn(w);
  await tool(deps, s, "propose_paperwork", { changes: [{ field: "paperworkBy", value: "structurestudio" }, { field: "quoteStart", value: "1,500" }, { field: "invoicePrefix", value: "INV-" }] });
  const p = lastCard(w);
  assertEquals(p.kind, "setup_paperwork");
  assertEquals(p.payload.calls.save, { invoiceInGhl: false, ssQuoteNext: 1500, ssInvoicePrefix: "INV-" });
  assert(p.preview.notes.some((n: string) => n.includes("can't be put back")));
  assert(p.preview.notes.some((n: string) => n.includes("from our address")), "email warning, in the page's words");
  assertEquals(editAreasOf(p), ["settings_crm", "settings_branding"]);
  await approve(deps, OWNER, p);
  assertEquals(w.cards.get(p.id)!.status, "applied");
  assertEquals(w.step("step-4").completed_via, "jack");
  assertEquals(w.cards.get(p.id)!.undo.fields.map((f: Any) => f.key), ["invoiceInGhl"]);
  await undo(deps, OWNER, p);
  assertEquals(w.saves("save").at(-1), { invoiceInGhl: true });
  assertEquals([w.status.ssQuoteNext, w.status.ssInvoicePrefix], [1500, "INV-"]);
});

Deno.test("paperwork: leaving the CRM where it isn't allowed is one-way; Undo says so instead of a save that changes nothing", async () => {
  // Still on the CRM from before, but not allowed it any more: the save keeps `true` at false.
  const w = new World();
  w.status.invoiceInGhl = true;
  const { deps, s } = turn(w);
  await tool(deps, s, "propose_paperwork", { changes: [{ field: "paperworkBy", value: "structurestudio" }] });
  const p = lastCard(w);
  assert(p.preview.notes.some((n: string) => n.includes("Undo can't move it back")), JSON.stringify(p.preview.notes));
  assert(!p.preview.notes.some((n: string) => n.includes("Starting numbers")), "no numbers on this card");
  await approve(deps, OWNER, p);
  const row = w.cards.get(p.id)!;
  assertEquals([row.status, w.status.invoiceInGhl], ["applied", false]);
  assertEquals(row.undo.fields, [], "nothing on Undo but the tick");
  await undo(deps, OWNER, p);
  assertEquals(w.saves("save").length, 1, "no save back");
  assertEquals(w.status.invoiceInGhl, false);

  // Allowed when the card was made and saved, then turned off before Undo.
  const w2 = new World();
  Object.assign(w2.status, { invoiceInGhl: true, ghlInvoicingAllowed: true });
  const b = turn(w2);
  await tool(b.deps, b.s, "propose_paperwork", { changes: [{ field: "paperworkBy", value: "structurestudio" }] });
  const p2 = lastCard(w2);
  await approve(b.deps, OWNER, p2);
  assertEquals(w2.cards.get(p2.id)!.undo.fields.map((f: Any) => f.key), ["invoiceInGhl"]);
  w2.status.ghlInvoicingAllowed = false;
  await undo(b.deps, OWNER, p2);
  const row2 = w2.cards.get(p2.id)!;
  assertEquals(row2.result.undo.reports.map((x: Any) => [x.label, x.status]), [["Estimates and invoices go out", "kept"]]);
  assertEquals(row2.result.undo.restored, 1, "only the tick went back");
  assertEquals(w2.saves("save").length, 1, "no save back");

  // A move to the CRM that stops being allowed before Approve saves nothing and says why.
  const w3 = new World();
  w3.status.ghlInvoicingAllowed = true;
  const c = turn(w3);
  await tool(c.deps, c.s, "propose_paperwork", { changes: [{ field: "paperworkBy", value: "crm" }] });
  const p3 = lastCard(w3);
  w3.status.ghlInvoicingAllowed = false;
  await approve(c.deps, OWNER, p3);
  const row3 = w3.cards.get(p3.id)!;
  assertEquals(row3.status, "failed");
  assert(row3.failure!.includes("isn't on for this account any more"), row3.failure!);
  assertEquals([w3.saves("save"), w3.calls.filter((x) => x.action === "toggle")], [[], []]);
});

Deno.test("paperwork: a numbering refusal passes through in the route's words", async () => {
  const w = new World();
  const { deps, s } = turn(w);
  await tool(deps, s, "propose_paperwork", { changes: [{ field: "quoteStart", value: "900" }] });
  w.answer.save = no(409, "You have already issued quote 1204. The next quote number has to be higher than that, or two quotes would carry the same number — try 1205.");
  await approve(deps, OWNER, lastCard(w));
  const row = lastCard(w);
  assertEquals(row.status, "partly_applied");
  assert(row.result.reports[0].reason.includes("try 1205"));
  assertEquals(row.undo, null);
});

Deno.test("paperwork: CRM paperwork isn't offered where it isn't allowed, and bad prefixes are refused", async () => {
  const w = new World();
  const { deps, s } = turn(w);
  const r = await tool(deps, s, "propose_paperwork", { changes: [{ field: "paperworkBy", value: "crm" }] });
  assert(r.isError && r.content.includes("isn't on for this account"), r.content);
  const p = await tool(deps, s, "propose_paperwork", { changes: [{ field: "quotePrefix", value: "Q 1" }] });
  assert(p.isError && p.content.includes("letters, numbers and dashes"), p.content);
  assertEquals(w.cards.size, 0);
  // Without the CRM area the tool isn't offered.
  const brand = turn(w, { edit: ["settings_branding"] });
  assert(!toolsFor(brand.deps, brand.s).some((t) => t.name === "propose_paperwork"));
});

// ── Styles ────────────────────────────────────────────────────────────────────────────────────────

Deno.test("styles: add, rename and hide in one card; Undo deletes only Jack's style with no sizes and puts the rest back", async () => {
  const w = new World();
  const { deps, s } = turn(w);
  const out = await tool(deps, s, "propose_styles", {
    add: [{ name: "Lofted Barn", code: "lba" }, { name: "Cabin", code: "CAB" }],
    rename: [{ style: "garden shed", newName: "Garden Classic", newCode: "" }],
    visibility: [{ style: "Utility", show: false }],
  });
  assert(!out.isError, out.content);
  const p = lastCard(w);
  assertEquals(p.title, "Building styles: add 2, change 1, hide 1");
  assertEquals(p.payload.creates, [{ label: "Lofted Barn", code: "LBA" }, { label: "Cabin", code: "CAB" }]);
  await approve(deps, OWNER, p);
  assertEquals(w.cards.get(p.id)!.status, "applied");
  assertEquals(w.saves("create_style"), [{ label: "Lofted Barn", code: "LBA" }, { label: "Cabin", code: "CAB" }]);
  assertEquals(w.saves("update_style"), [{ styleId: "st-garden", label: "Garden Classic" }]);
  assertEquals(w.saves("set_style_active"), [{ styleId: "st-util", active: false }]);
  // The builder adds a size to the cabin before pressing Undo.
  const cabin = w.styles.find((x) => x.label === "Cabin");
  w.sizes.push({ id: "z9", style_id: cabin.id });
  await undo(deps, OWNER, p);
  const row = w.cards.get(p.id)!;
  assertEquals(row.status, "undone");
  assertEquals(w.saves("delete_style").map((b) => w.styles.some((x) => x.id === b.styleId)), [false]);
  assert(!w.styles.some((x) => x.label === "Lofted Barn"), "Jack's empty style is gone");
  assert(w.styles.some((x) => x.label === "Cabin"), "the one with a size stays");
  assertEquals(w.sizes.length, 2, "no size was deleted");
  assertEquals([w.styles.find((x) => x.id === "st-garden").label, w.styles.find((x) => x.id === "st-util").active], ["Garden Shed", true]);
  assertEquals(row.result.undo.reports.map((x: Any) => [x.label, x.status]), [["Cabin", "kept"]]);
});

Deno.test("styles: refusals before any card: unknown style, a taken code, a missing code, a name already there", async () => {
  const w = new World();
  const { deps, s } = turn(w);
  const r = await tool(deps, s, "propose_styles", {
    add: [{ name: "Garden Shed", code: "GX" }, { name: "Barn", code: "GS" }, { name: "Shed Row", code: "" }],
    rename: [{ style: "Mini Barn", newName: "x", newCode: "" }],
    visibility: [],
  });
  assertEquals(r.isError, true);
  for (const bit of ["already have a style called", "already uses the code GS", "needs a serial code", "can't find a style called"]) assert(r.content.includes(bit), bit);
  assertEquals(w.cards.size, 0);
});

Deno.test("styles: a code can't be taken off on Undo, and an edit made since is left alone", async () => {
  const w = new World();
  const { deps, s } = turn(w);
  await tool(deps, s, "propose_styles", { add: [], rename: [{ style: "Utility", newName: "", newCode: "UT" }, { style: "Garden Shed", newName: "Garden Classic", newCode: "" }], visibility: [] });
  const p = lastCard(w);
  await approve(deps, OWNER, p);
  w.styles.find((x) => x.id === "st-garden").label = "Garden Deluxe";
  await undo(deps, OWNER, p);
  const reports = w.cards.get(p.id)!.result.undo.reports.map((x: Any) => x.reason);
  assert(reports.some((x: string) => x.includes("can be changed but not taken off")), reports.join(" | "));
  assert(reports.some((x: string) => x.includes("changed since")), reports.join(" | "));
  assertEquals(w.saves("update_style").length, 2, "Undo sent nothing");
});

Deno.test("styles: a lost create is checked by its code on Undo, never retried", async () => {
  const w = new World();
  const { deps, s } = turn(w);
  await tool(deps, s, "propose_styles", { add: [{ name: "Lofted Barn", code: "LBA" }], rename: [], visibility: [] });
  const p = lastCard(w);
  // It landed, but the answer was lost.
  w.answer.create_style = (b: Any) => { w.styles.push({ id: "st-lost", label: b.label, code: b.code, active: true }); return { status: 0, data: null }; };
  await approve(deps, OWNER, p);
  const row = w.cards.get(p.id)!;
  assertEquals(row.status, "partly_applied");
  assertEquals(w.saves("create_style").length, 1);
  assert(row.result.reports[0].reason.includes("couldn't tell if that saved"));
  delete w.answer.create_style;
  await undo(deps, OWNER, p);
  assert(!w.styles.some((x) => x.id === "st-lost"));
});

Deno.test("styles: a style edited during the review stops the card", async () => {
  const w = new World();
  const { deps, s } = turn(w);
  await tool(deps, s, "propose_styles", { add: [], rename: [], visibility: [{ style: "Utility", show: false }] });
  w.styles.find((x) => x.id === "st-util").active = false;
  await approve(deps, OWNER, lastCard(w));
  assertEquals(lastCard(w).status, "failed");
  assertEquals(w.saves("set_style_active"), []);
});

// ── Doors, windows and ramps ──────────────────────────────────────────────────────────────────────

Deno.test("catalog item: a window saves by category, and Undo deletes it only while nobody has touched it", async () => {
  const w = new World();
  const { deps, s } = turn(w);
  const out = await tool(deps, s, "propose_catalog_item", { category: "window", name: "24x36 Single Hung", widthInches: 24, heightInches: 36, price: 185 });
  assert(!out.isError, out.content);
  const p = lastCard(w);
  assertEquals([p.kind, p.payload], ["setup_fixture", { category: "window", row: { name: "24x36 Single Hung", widthIn: 24, heightIn: 36, price: 185 } }]);
  assertEquals(PIECE_KINDS.get("setup_fixture")!.switches(p), ["setup"]);
  await approve(deps, OWNER, p);
  assertEquals(w.saves("save_fixture"), [{ category: "window", name: "24x36 Single Hung", widthIn: 24, heightIn: 36, price: 185 }]);
  const id = w.cards.get(p.id)!.undo.fixtureId;
  // Someone edits it, so it stays.
  w.stamps.set(id, "t2");
  await undo(deps, OWNER, p);
  assertEquals(w.cards.get(p.id)!.result.undo.reports[0].status, "changed");
  assert(w.fixtures.some((f) => f.id === id));
  assert(w.cards.get(p.id)!.result.undo.reports[0].reason.includes("Settings > Options > Windows"));
});

Deno.test("catalog item: untouched, Undo removes it; a ramp card says when the simple ramp is on", async () => {
  const w = new World();
  const { deps, s } = turn(w);
  await tool(deps, s, "propose_catalog_item", { category: "ramp", name: "4 ft ramp", widthInches: 48, heightInches: 60, price: 250 });
  const p = lastCard(w);
  assert(p.preview.notes.some((n: string) => n.includes("one simple ramp")), JSON.stringify(p.preview.notes));
  assertEquals(p.preview.lines[0].to, "4 ft ramp, 48 inches wide, 60 long, $250");
  await approve(deps, OWNER, p);
  await undo(deps, OWNER, p);
  assertEquals(w.cards.get(p.id)!.status, "undone");
  assert(!w.fixtures.some((f) => f.name === "4 ft ramp"));
});

Deno.test("catalog item: a door goes to propose_new_door; a twin is refused; a lost save says check first", async () => {
  const w = new World();
  w.fixtures.push({ id: "w1", category: "window", name: "Single window", width_in: 24, height_in: 36, archived: false });
  const on = turn(w);
  const door = await tool(on.deps, on.s, "propose_catalog_item", { category: "door", name: "Double door", widthInches: 72, heightInches: 80, price: 600 });
  assertEquals([door.isError, door.content], [true, "A door goes through propose_new_door."]);
  assertEquals(w.cards.size, 0);
  const twin = await tool(on.deps, on.s, "propose_catalog_item", { category: "window", name: "single window", widthInches: 24, heightInches: 36, price: 90 });
  assert(twin.isError && twin.content.includes("already have that window"), twin.content);
  await tool(on.deps, on.s, "propose_catalog_item", { category: "window", name: "Big window", widthInches: 36, heightInches: 48, price: 140 });
  const p = lastCard(w);
  assertEquals(p.payload.row, { name: "Big window", widthIn: 36, heightIn: 48, price: 140 });
  assertEquals(PIECE_KINDS.get("setup_fixture")!.switches(p), ["setup"]);
  w.answer.save_fixture = { status: 504, data: null };
  await approve(on.deps, OWNER, p);
  const row = w.cards.get(p.id)!;
  assertEquals(row.status, "partly_applied");
  assert(String(row.result.reports[0].reason).startsWith("I couldn't tell if that saved. Check Settings > Options"), row.result.reports[0].reason);
  const bad = await tool(on.deps, on.s, "propose_catalog_item", { category: "window", name: "", widthInches: 0, heightInches: 10, price: -1 });
  assert(bad.isError);
});

// ── Lots and the serial start ─────────────────────────────────────────────────────────────────────

Deno.test("lots: adds lots and the serial start once; Claude hears no street; Undo removes only an empty lot and keeps the serial", async () => {
  const w = new World();
  const { deps, s } = turn(w);
  const out = await tool(deps, s, "propose_locations", { lots: [{ name: "Warsaw Lot", street: "1500 W Business 65", city: "Warsaw", state: "MO", zip: "65355" }, { name: "Clinton Lot", street: "", city: "Clinton", state: "MO", zip: "" }], serialStart: 12000 });
  assert(!out.isError, out.content);
  assert(!leaksContactDetails(out.content) && !out.content.includes("1500 W"), out.content);
  const p = lastCard(w);
  assertEquals(p.payload.ticks, [{ id: "step-5", title: "Add sales locations & your serial number start" }]);
  assert(p.preview.notes.some((n: string) => n.includes("Undo leaves it")));
  await approve(deps, OWNER, p);
  assertEquals(w.saves("save_location"), [
    { name: "Warsaw Lot", street: "1500 W Business 65", city: "Warsaw", state: "MO", zip: "65355" },
    { name: "Clinton Lot", street: "", city: "Clinton", state: "MO", zip: "" },
  ]);
  assertEquals([w.nextSerial, w.step("step-5").completed_via], [12000, "jack"]);
  // A building goes onto the Warsaw lot before Undo.
  w.lots.find((l) => l.name === "Warsaw Lot").buildings = 1;
  await undo(deps, OWNER, p);
  const row = w.cards.get(p.id)!;
  assertEquals(row.status, "undone");
  assertEquals(w.lots.map((l) => l.name), ["Main Lot", "Warsaw Lot"]);
  assertEquals(w.nextSerial, 12000);
  assertEquals(row.result.undo.reports.map((x: Any) => [x.label, x.status]), [["Warsaw Lot", "kept"], ["Serial start", "kept"]]);
  assertEquals(w.step("step-5").completed_at, null);
});

Deno.test("lots: a serial start already set is refused, and so is a lot that's already there", async () => {
  const w = new World();
  w.nextSerial = 25698;
  const { deps, s } = turn(w);
  const r = await tool(deps, s, "propose_locations", { lots: [{ name: "main lot", street: "", city: "", state: "", zip: "" }], serialStart: 30000 });
  assertEquals(r.isError, true);
  assert(r.content.includes("already have a lot called") && r.content.includes("can only go up"), r.content);
  assertEquals(w.cards.size, 0);
});

Deno.test("lots: a refused serial start is never named on Undo as if it had been set", async () => {
  const w = new World();
  const { deps, s } = turn(w);
  await tool(deps, s, "propose_locations", { lots: [{ name: "Warsaw Lot", street: "", city: "Warsaw", state: "MO", zip: "" }], serialStart: 12000 });
  const p = lastCard(w);
  w.answer.save_serial_start = no(400, "Next serial must be a whole number from 1 to 999,999,999.");
  await approve(deps, OWNER, p);
  const row = w.cards.get(p.id)!;
  assertEquals(row.status, "partly_applied");
  assertEquals([row.result.reports.map((x: Any) => [x.label, x.status]), row.result.ticked], [[["Serial start", "refused"]], []]);
  assertEquals(w.nextSerial, null);
  await undo(deps, OWNER, p);
  const after = w.cards.get(p.id)!;
  assertEquals(after.status, "undone");
  assertEquals(after.result.undo.reports, [], "no \"keeps starting at\" for a start that never saved");
  assert(!w.lots.some((l) => l.name === "Warsaw Lot"), "the empty lot Jack added is gone");
});

Deno.test("lots: a serial start set by someone else during the review stops the card", async () => {
  const w = new World();
  const { deps, s } = turn(w);
  await tool(deps, s, "propose_locations", { lots: [], serialStart: 500 });
  const p = lastCard(w);
  assertEquals([p.title, p.undo], ["Where serial numbers start", null]);
  w.nextSerial = 800;
  await approve(deps, OWNER, p);
  assertEquals(lastCard(w).status, "failed");
  assertEquals(w.saves("save_serial_start"), []);
});

// ── Ticking a step done by hand ───────────────────────────────────────────────────────────────────

Deno.test("tick: a step done by hand is ticked with Jack's card, and Undo takes back only that tick", async () => {
  const w = new World();
  const { deps, s } = turn(w);
  const out = await tool(deps, s, "propose_setup_tick", { step: "paperwork" });
  assert(!out.isError, out.content);
  const p = lastCard(w);
  assertEquals([p.kind, p.title, editAreasOf(p)], ["setup_tick", "Mark done: Choose how quotes & invoices go out", []]);
  assertEquals(w.step("step-4").completed_at, null, "nothing until the press");
  await approve(deps, OWNER, p);
  assertEquals([w.cards.get(p.id)!.status, w.step("step-4").completed_via], ["applied", "jack"]);
  await undo(deps, OWNER, p);
  assertEquals([w.cards.get(p.id)!.status, w.step("step-4").completed_at], ["undone", null]);
});

Deno.test("tick: refused for a rep, a locked step, an unknown ref; a done step needs no card", async () => {
  const w = new World();
  const { deps, s } = turn(w);
  assert((await tool(deps, s, "propose_setup_tick", { step: "quickbooks" })).content.includes("needs quickbooks_sync first"));
  assert((await tool(deps, s, "propose_setup_tick", { step: "s99" })).isError);
  assertEquals(JSON.parse((await tool(deps, s, "propose_setup_tick", { step: "password" })).content).alreadyDone, true);
  w.canTick = false;
  assertEquals((await tool(deps, s, "propose_setup_tick", { step: "paperwork" })).content, "Ticking a setup step is for an owner or admin.");
  assertEquals(w.cards.size, 0);
});

Deno.test("tick: a person ticked it meanwhile, so Jack's press changes nothing and Undo has nothing to take back", async () => {
  const w = new World();
  const { deps, s } = turn(w);
  await tool(deps, s, "propose_setup_tick", { step: "s7" });
  const p = lastCard(w);
  Object.assign(w.step("step-7"), { completed_at: "2026-11-06T10:00:00Z" });
  await approve(deps, OWNER, p);
  const row = w.cards.get(p.id)!;
  assertEquals([row.status, row.result.tickNotes, row.undo], ["applied", ["It was already ticked."], null]);
});

// ── Pointing to a page ────────────────────────────────────────────────────────────────────────────

Deno.test("guide: a card with the right page from Jack's own map; no card where there's no page or no access", async () => {
  const w = new World();
  const { deps, s } = turn(w);
  const out = JSON.parse((await tool(deps, s, "point_to_step", { key: "locations" })).content);
  assertEquals([out.shown, out.where], [true, "Settings > Company > Locations"]);
  const p = lastCard(w);
  assertEquals([p.kind, p.status, p.preview.route], ["setup_guide", "applied", { page: "settings", sub: "locations" }]);
  assertEquals((await approve(deps, OWNER, p)).status, 409);
  // The template's stale link_page is never used.
  assertEquals([GUIDES.business.sub, GUIDES.catalog_items.sub, GUIDES.locations.sub, GUIDES.styles.sub], ["company", "doors", "locations", "sheds"]);
  const pw = JSON.parse((await tool(deps, s, "point_to_step", { key: "password" })).content);
  assertEquals(pw.shown, false);
  const rep = turn(w, { edit: [], read: ["settings_branding"] });
  const tax = JSON.parse((await tool(rep.deps, rep.s, "point_to_step", { key: "sales_tax" })).content);
  assertEquals(tax.shown, false);
  assertEquals(w.cards.size, 1);
});

// Carolyn, 11-09: spray foam was sent to Interior items. Every Options tab the portal draws has a guide that
// lands on it, and no Options guide names a tab the portal doesn't have (portal/01-core.jsx ssOptionTabs).
Deno.test("guide: every Settings > Options tab has its own guide, and insulation is its own tab", () => {
  const core = Deno.readTextFileSync(new URL("../../../portal/01-core.jsx", import.meta.url));
  const a = core.indexOf("function ssOptionTabs()");
  const body = core.slice(a, core.indexOf("\n}", a));
  const tabs = [...body.matchAll(/^\s*\["([a-z-]+)", "([^"]+)"/gm)].map((m) => m[1]);
  assert(tabs.length >= 12 && tabs.includes("insulation"), tabs.join(","));
  const optionGuides = Object.values(GUIDES).filter((g) => g.area === "settings_options" && g.page === "settings" && g.sub !== "colors");
  for (const t of tabs) assert(optionGuides.some((g) => g.sub === t), `no guide lands on Settings > Options tab ${t}`);
  for (const g of optionGuides) assert(tabs.includes(String(g.sub)), `${g.title} names ${g.sub}, which isn't an Options tab`);
  assertEquals([GUIDES.insulation.sub, GUIDES.insulation.where], ["insulation", "Settings > Options > Insulation"]);
  assert(GUIDES.addons.sub === "interior" && !/insulation|spray/i.test(GUIDES.addons.say), GUIDES.addons.say);
});

// Carolyn, 11-10: "port this number from my GHL account" got a carrier port's account number and PIN.
Deno.test("guide: bringing a number points at the Bring your number card and hands Claude the real process", async () => {
  const w = new World();
  const { deps, s } = turn(w);
  const out = JSON.parse((await tool(deps, s, "point_to_step", { key: "bring_number" })).content);
  assertEquals([out.shown, lastCard(w).preview.route], [true, { page: "settings", sub: "phone" }]);
  assert(/Bring a number you already have/.test(lastCard(w).preview.say) && /PIN/.test(lastCard(w).preview.say));
  // A GoHighLevel move is a HighLevel ticket: no account number or PIN, one or two business days.
  assert(/GoHighLevel number is not a carrier port/.test(out.how) && /no account number or PIN is needed/.test(out.how), out.how);
  assert(/Never ask for a PIN/.test(out.how) && /SMS - A2P/.test(out.how) && /how/.test(out.note), out.how);
  // The plain phone guide carries no process, and the tool tells Claude to use bring_number for a port.
  assertEquals(GUIDES.phone.how, undefined);
  const point = setupPiece.tools.find((t) => t.def.name === "point_to_step")!;
  assert(/bring_number/.test(point.def.description));
});

Deno.test("guide: every page a guide names is a real settings tab, and every guide is short and plain", () => {
  const subs = new Set(["company", "branding", "team", "commissions", "locations", "crews", "drivers", "tax", "payments", "sheds", "options", "colors", "designer", "connection", "quickbooks", "doors", "windows", "ramps", "interior", "email", "sms", "phone", "wallet", "vents", "cladding", "interior-walls", "electrical", "insulation", "delivery", "foundation"]);
  for (const [key, g] of Object.entries(GUIDES)) {
    if (g.sub) assert(subs.has(g.sub), `${key} -> ${g.sub}`);
    assert(!/[—–]/.test(g.say + g.where + g.title), `${key}: no long dashes`);
  }
});
