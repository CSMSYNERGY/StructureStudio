// changeorders.ts: change orders on signed orders. No network: a fake portal-settings stands in for
// orders_overview, orders_designs, amendment_status, order_paperwork, stage_order_attribute_change,
// send_change_order, void_change_order and request_order_unlock, with the bodies, columns, refusals and
// side effects the real handlers have (portal-settings/index.ts, migrations 126, 210-215, 367).

import { assert, assertEquals } from "./test_assert.ts";
import {
  type Deps, handleProposalApprove, handleProposalGet, handleProposalUndo, type ProposalRow, runTool, SENTENCES, type Store, strictCost, SWITCHES, toolsFor,
  type TurnState, type Who, withinStrictLimits,
} from "./agent.ts";
import { PIECE_KINDS, register } from "./pieces.ts";
import { leaksContactDetails } from "./redact.ts";
import { SAID } from "./common.ts";
import { RULE_WARN_SAID } from "./ruleWarn.ts";
import { CHANGEORDER_KINDS, CO_SAID, changeOrdersPiece, plainWords } from "./changeorders.ts";

register([changeOrdersPiece]);

// deno-lint-ignore no-explicit-any
type Any = any;

const who: Who = { clientId: "builder-a", userId: "u1", operatorEmail: null };
const operator: Who = { clientId: "builder-a", userId: "u1", operatorEmail: "ahsan@csmsynergy.com" };
const CODE = "SS-7K2M9Q4XWD";
const ORDER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const CONTACT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const FORBIDDEN = ["decide_order_unlock", "open_amendment", "finalize_amendment", "attest_change_order", "apply_change_order_money", "send_invoice", "push_to_invoice", "reissue_invoice", "dismiss_invoice_request", "text_sign_link", "resend_quote_email"];
const WRITES = ["stage_order_attribute_change", "send_change_order", "void_change_order", "request_order_unlock"];

// ── The store ────────────────────────────────────────────────────────────────────────────────────

function makeStore(init: { off?: string[] } = {}) {
  const proposals = new Map<string, ProposalRow>();
  let seq = 0;
  const state = { on: true, off: init.off ?? [], proposals };
  const store: Store = {
    settings: () => Promise.resolve({ on: state.on, off: state.off }),
    setOff: (_c, off) => { state.off = off; return Promise.resolve(); },
    usage: () => Promise.resolve({ monthCostMicros: 0, tenant24h: 0, user10m: 0, sheets24h: 0 }),
    openChat: () => Promise.resolve(null),
    createChat: () => Promise.resolve("chat1"),
    chats: () => Promise.resolve([]),
    messages: () => Promise.resolve([]),
    addMessage: (m) => Promise.resolve({ id: `m${++seq}`, role: m.role, body: m.body, created_at: "now", proposal_ids: m.proposalIds ?? [] }),
    bumpChat: () => Promise.resolve(),
    closeChats: () => Promise.resolve(),
    reopenChat: () => Promise.resolve(true),
    accountLine: () => Promise.resolve({ firstName: "Mike", title: "Owner", business: "Ridgeline", role: "owner" }),
    insertProposal: (p) => {
      const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
      const row = { id, conversation_id: null, file_name: null, source: {}, preview: {}, payload: {}, answers: {}, result: null, undo: null, shown_hash: null, failure: null, approved_by: null, approved_by_operator: null, approved_at: null, applied_at: null, undone_at: null, expires_at: new Date(Date.now() + 86_400_000).toISOString(), created_at: new Date().toISOString(), ...p } as ProposalRow;
      proposals.set(id, JSON.parse(JSON.stringify(row)));
      return Promise.resolve(proposals.get(id)!);
    },
    getProposal: (c, id) => { const r = proposals.get(id); return Promise.resolve(r && r.client_id === c ? r : null); },
    updateProposal: (c, id, patch, when) => {
      const r = proposals.get(id);
      if (!r || r.client_id !== c || (when && !when.includes(r.status))) return Promise.resolve(null);
      Object.assign(r, JSON.parse(JSON.stringify(patch)));
      return Promise.resolve(r);
    },
    addProposalCost: () => Promise.resolve(),
    proposals: () => Promise.resolve([...proposals.values()]),
    proposalsById: (_c, ids) => Promise.resolve(ids.map((i) => proposals.get(i)!).filter(Boolean)),
    names: () => Promise.resolve({}),
    fixtureStamp: () => Promise.resolve(null),
    memory: () => Promise.resolve([]),
    putMemory: () => Promise.resolve(true),
    forgetMemory: () => Promise.resolve(true),
  };
  return { store, state };
}

const wallet: Deps["wallet"] = {
  meter: () => Promise.resolve({ active: false, markup: 1.5 }),
  exempt: () => Promise.resolve(false),
  account: () => Promise.resolve({ balanceCents: 5000, heldCents: 0, remainderMicros: 0, autoTopup: false, thresholdCents: null }),
  debit: () => Promise.resolve({ ok: true, txId: 1 }),
  grantOnce: () => Promise.resolve(true),
  requestTopup: () => {},
  mark: () => Promise.resolve(),
  pending: () => Promise.resolve([]),
};

// ── The fake portal-settings ─────────────────────────────────────────────────────────────────────

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const fmtM = (n: number) => {
  const v = Math.round(n * 100) / 100;
  const [i, f] = Math.abs(v).toFixed(2).split(".");
  return `${v < 0 ? "-" : ""}$${i.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${f}`;
};
const CLAD: Record<string, string> = { "": "Builder's standard", lap: "7\" LP Lap Siding", vinyl: "4.5\" Vinyl Siding", panel: "Panel Siding", batten: "Board & Batten", agpanel: "AG Panel" };
const isUuid = (v: unknown) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

type StageMode = "ok" | "lost" | "lost_landed" | "race" | "down_after_design";
type SendMode = "ok" | "lost" | "lost_sent";
type VoidMode = "ok" | "lost" | "signed_meanwhile";
type UnlockMode = "ok" | "lost" | "lost_landed";

function makeWorld() {
  let seq = 0;
  const uid = (p: string) => `${p}${p}${p}${p}${p}${p}${p}${p}-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
  const w = {
    colors: [
      { id: "c1", label: "Charcoal", hex: "#333", siding: false, trim: false, shingle: true, metal: false, allow_custom: false, rate: 0 },
      { id: "c2", label: "Weathered Wood", hex: "#765", siding: false, trim: false, shingle: true, metal: false, allow_custom: false, rate: 50 },
      { id: "c3", label: "Black", hex: "#000", siding: false, trim: true, shingle: false, metal: true, allow_custom: false, rate: 100 },
      { id: "c4", label: "Galvalume", hex: "#ccc", siding: false, trim: false, shingle: false, metal: true, allow_custom: false, rate: 0 },
      { id: "c5", label: "Barn Red", hex: "#a00", siding: true, trim: false, shingle: false, metal: false, allow_custom: false, rate: 0 },
      { id: "c6", label: "Clay", hex: "#cb9", siding: true, trim: false, shingle: false, metal: false, allow_custom: false, rate: 75 },
      { id: "c7", label: "White", hex: "#fff", siding: true, trim: true, shingle: false, metal: false, allow_custom: false, rate: 0 },
      { id: "c8", label: "Custom color", hex: "#888", siding: true, trim: true, shingle: true, metal: true, allow_custom: true, rate: 200 },
    ] as Any[],
    cladding: [] as Any[],
    designs: new Map<string, Any>(),
    orders: [] as Any[],
    cos: [] as Any[],
    unlocks: [] as Any[],
    settings: { invoice_in_ghl: false as boolean | null, co_unlock_required: false, co_fee_cents: 15000, co_fee_taxable: true, co_fee_label: "Change order fee" },
    freeWindow: true,
    gateFails: false,
    /** amendment_status reads the live change order softly: a read error answers amendment null. */
    amendSoft: false,
    overviewCut: false,
    visible: null as Set<string> | null,
    stage: "ok" as StageMode,
    send: "ok" as SendMode,
    voidMode: "ok" as VoidMode,
    unlockMode: "ok" as UnlockMode,
    emails: [] as string[],
    calls: [] as { action: string; body: Any }[],
    rules: [] as Any[],
    rulesDown: false,
    audit: [] as string[],
  };

  const rate = (label: unknown) => w.colors.find((c) => norm(c.label) === norm(label))?.rate ?? 0;
  const priced = (sel: Any, pc: Any) => ({
    lines: [
      { kind: "building", itemKey: "", name: "Lofted Barn 12x24", desc: CLAD[String(sel.cladding ?? "")] ?? "", qty: 1, amount: 7000 },
      { kind: "roof", itemKey: "", name: "Roof", desc: `${sel.roofType}: ${sel.roofColor}`, qty: 1, amount: sel.roofType ? (sel.roofType === "Metal" ? 1500 : 1000) + rate(sel.roofColor) : 0 },
      { kind: "paint", itemKey: "", name: "Paint", desc: sel.paint === "Painted" ? `Body ${pc.body}, trim ${pc.trim}` : "No paint", qty: 1, amount: sel.paint === "Painted" ? 900 + rate(pc.body) + rate(pc.trim) : 0 },
    ],
  });
  const total = (snap: Any) => snap.lines.reduce((t: number, l: Any) => t + l.qty * l.amount, 0);

  const sel0 = { style: "Lofted Barn", size: "12x24", roofType: "Shingle", roofColor: "Charcoal", cladding: "lap", claddingId: "lap", paint: "Painted" };
  const pc0 = { body: "Barn Red", trim: "White" };
  const est0 = priced(sel0, pc0);
  w.designs.set(CODE, {
    short_code: CODE, contact_id: CONTACT_ID,
    contact: { name: "Dale Smith", email: "dale@example.com", phone: "816-555-0142", address: "1234 N Main St", city: "Sedalia" },
    status: "accepted", accepted_at: "2026-10-01T15:00:00Z", ss_quote_number: "E-1042", ss_quote_pdf_url: "https://x/e.pdf",
    selections: { ...sel0 }, paint_colors: { ...pc0 }, estimate_lines: est0,
    agreed: { selections: { ...sel0 }, paintColors: { ...pc0 }, lines: est0 },
  });
  w.orders.push({ id: ORDER_ID, order_no: 1042, short_code: CODE, total_cents: Math.round(total(est0) * 100), ordered_at: "2026-10-01T15:00:00Z" });

  const live = (code: string) => w.cos.find((c) => c.short_code === code && (c.status === "draft" || c.status === "pending_ack")) ?? null;
  const gate = (code: string): Any => {
    if (w.gateFails) return { signed: false, open: true, authority: "free_window", unlock_id: null, fee_cents: 0, fee_taxable: false, reason: "" };
    const d = w.designs.get(code);
    if (!d?.accepted_at) return { signed: false, open: true, authority: "pre_signature", unlock_id: null, expires_at: null, fee_cents: 0, fee_taxable: false, reason: "This order has not been accepted yet." };
    // 209: the regime off answers first, live change order or not.
    if (!w.settings.co_unlock_required) return { signed: true, open: true, authority: "free_window", unlock_id: null, expires_at: null, fee_cents: 0, fee_taxable: false, reason: "Changing a signed order does not need an unlock at this builder." };
    const l = live(code);
    if (l) return { signed: true, open: true, authority: "amendment", unlock_id: l.unlock_id ?? null, expires_at: null, fee_cents: 0, fee_taxable: false, change_order_id: l.id, co_no: l.co_no, reason: `A change is already open on this order (CO-${l.co_no}).` };
    if (w.freeWindow) return { signed: true, open: true, authority: "free_window", unlock_id: null, expires_at: "2026-12-01T00:00:00Z", fee_cents: 0, fee_taxable: false, reason: "Inside this builder's free-change window." };
    const u = w.unlocks.find((x) => x.short_code === code && x.decision === "granted" && !x.consumed_at && !x.released_at && Date.parse(x.expires_at) > Date.now());
    if (u) return { signed: true, open: true, authority: "unlock", unlock_id: u.id, expires_at: u.expires_at, fee_cents: w.settings.co_fee_cents, fee_taxable: w.settings.co_fee_taxable, reason: "Unlocked." };
    return { signed: true, open: false, authority: null, unlock_id: null, expires_at: null, fee_cents: w.settings.co_fee_cents, fee_taxable: w.settings.co_fee_taxable, reason: "This order is signed. An admin or crew leader has to unlock it before it can be changed." };
  };
  const out = (status: number, data: Record<string, unknown> | null) => Promise.resolve({ status, data });
  const notMine = (code: string) => w.visible !== null && !w.visible.has(code);
  const coView = (c: Any) => ({ id: c.id, co_no: c.co_no, status: c.status, source: c.source, description: c.description, total_before_cents: c.total_before_cents, total_after_cents: c.total_after_cents, fee_cents: c.fee_cents, fee_tax_cents: c.fee_tax_cents, fee_taxable: c.fee_taxable, raised_under: c.raised_under, created_at: c.created_at });

  const portal: Deps["portal"] = (action, body) => {
    const b = JSON.parse(JSON.stringify(body)) as Any;
    w.calls.push({ action, body: b });
    if (FORBIDDEN.includes(action)) return out(500, { error: `${action} must never be called` });

    if (action === "crm_rules_list" && w.rulesDown) return out(500, { error: "Couldn't load your automations." });
    if (action === "crm_rules_list") return out(200, { ok: true, rulesVersion: 2, pipelines: [], team: [], canManage: true, rules: w.rules, labels: [], timeZone: "America/Chicago" });

    if (action === "orders_overview") {
      const codes: string[] | null = Array.isArray(b.shortCodes) ? b.shortCodes : null;
      if (w.overviewCut && !codes) return out(200, { ok: true, complete: false, orders: [] });
      const rows = w.orders.filter((o) => (!codes || codes.includes(o.short_code)) && !notMine(o.short_code)).map((o) => {
        const d = w.designs.get(o.short_code);
        return {
          id: o.id, orderNo: o.order_no, shortCode: o.short_code, name: d?.contact?.name ?? null, building: "Lofted Barn 12x24", totalCents: o.total_cents,
          settledCents: 0, pendingCents: 0, balanceCents: o.total_cents, orderedAt: o.ordered_at, soldAt: null, soldAtFrom: null, designStatus: d?.status ?? null,
          sold: false, invoiceOut: false, invoiceRequested: false, lotSale: false,
        };
      });
      return out(200, { ok: true, complete: true, orders: rows, seen: { build: true, delivery: true } });
    }

    if (action === "orders_designs") {
      const codes: string[] = Array.isArray(b.shortCodes) ? b.shortCodes : [];
      if (b.detail === true && codes.length !== 1) return out(400, { error: "detail reads one design at a time." });
      const designs = codes.map((c) => w.designs.get(c)).filter((d) => d && !notMine(d.short_code)).map((d) => ({
        short_code: d.short_code, contact_id: d.contact_id, status: d.status, accepted_at: d.accepted_at, ss_quote_number: d.ss_quote_number, ss_quote_pdf_url: d.ss_quote_pdf_url,
        ss_quote_sent_at: null, image_url: null, plan_image_url: null, view3d_image_url: null,
        estimate_lines: JSON.parse(JSON.stringify(d.estimate_lines)), selections: { ...d.selections }, paint_colors: { ...d.paint_colors }, contact: { ...d.contact },
      }));
      return out(200, { ok: true, designs });
    }

    if (action === "amendment_status") {
      const code = String(b.shortCode ?? "").trim();
      if (!code) return out(400, { error: "A design code is required." });
      if (notMine(code)) return out(404, { error: "That design is not one of yours." });
      const l = live(code);
      const u = w.unlocks.filter((x) => x.short_code === code && !x.consumed_at && !x.released_at).slice(-1)[0] ?? null;
      return out(200, {
        ok: true, gate: gate(code), amendment: l && !w.amendSoft ? coView(l) : null,
        unlock: u ? { id: u.id, reason: u.reason, requested_by_name: "Mike", requested_at: u.requested_at, decision: u.decision, decided_by_name: null, decided_at: null, decision_note: null, expires_at: u.expires_at } : null,
        policy: { unlockRequired: w.settings.co_unlock_required, freeDays: 14, feeCents: w.settings.co_fee_cents, feeTaxable: w.settings.co_fee_taxable, feeLabel: w.settings.co_fee_label },
      });
    }

    if (action === "order_paperwork") {
      const code = String(b.shortCode ?? "").trim();
      if (!code) return out(400, { error: "shortCode is required." });
      if (notMine(code)) return out(404, { error: "That design is not one of yours." });
      if (w.settings.invoice_in_ghl !== false) return out(400, { error: "This account quotes through the CRM — the order document is for StructureStudio-issued paperwork." });
      return out(200, {
        ok: true, business: { name: "Ridgeline Barns", phone: "(816) 555-0100", website: "ridgeline.example", logoUrl: null, quoteTerms: null },
        colors: w.colors.map(({ rate: _r, ...c }) => ({ ...c, is_default: false, sort_order: 0 })), cladding: w.cladding, invoice: null,
      });
    }

    if (action === "stage_order_attribute_change") {
      const code = String(b.shortCode ?? "").trim();
      if (!code) return out(400, { error: "shortCode is required." });
      if (notMine(code)) return out(404, { error: "That design is not one of yours." });
      const attrs = b.attrs && typeof b.attrs === "object" ? b.attrs : {};
      const has = (k: string) => Object.prototype.hasOwnProperty.call(attrs, k);
      if (!["roofType", "roofColor", "cladding", "paintStatus", "paintBody", "paintTrim"].some(has)) return out(400, { error: "Nothing to change." });
      const d = w.designs.get(code);
      if (!d) return out(404, { error: "Design not found." });
      if (!d.ss_quote_number) return out(400, { error: "This design has no StructureStudio quote yet." });
      const g = gate(code);
      if (g.open !== true) return out(409, { error: String(g.reason), reason: "locked" });
      const l = live(code);
      if (l && l.source !== "design_edit") {
        return out(409, { error: l.status === "draft" ? `CO-${l.co_no} is still open — finish it or void it under Change orders before changing the building.` : `CO-${l.co_no} is still waiting on the customer — record their verbal OK or void it under Change orders before changing the building.`, reason: "co_pending" });
      }
      const sel = d.selections, pc = d.paint_colors;
      const cur = { roofType: sel.roofType ?? "", roofColor: sel.roofColor ?? "", cladding: String(sel.cladding ?? ""), paintStatus: String(sel.paint).toLowerCase() === "painted" ? "Paint" : "Unpaint", paintBody: pc.body ?? "", paintTrim: pc.trim ?? "" };
      const next: Any = {};
      for (const k of Object.keys(cur)) next[k] = has(k) ? String(attrs[k] ?? "") : (cur as Any)[k];
      next.paintStatus = next.paintStatus === "Paint" ? "Paint" : "Unpaint";
      const offered = w.cladding.length ? w.cladding.map((c) => c.id) : Object.keys(CLAD);
      if (next.cladding && !offered.includes(next.cladding)) return out(400, { error: "That cladding isn't offered on this building style. Check Settings → Options → Cladding." });
      const labelOk = (v: string, flag: string) => !v || w.colors.some((c) => c[flag] === true && norm(c.label) === norm(v)) || w.colors.some((c) => c.allow_custom);
      if (next.roofType && !["shingle", "metal"].includes(norm(next.roofType))) return out(400, { error: "Roof type must be Shingle or Metal." });
      if (next.roofType && !labelOk(next.roofColor, norm(next.roofType))) return out(400, { error: "That roof color isn't in your catalog." });
      if (next.paintStatus === "Paint" && (!labelOk(next.paintBody, "siding") || !labelOk(next.paintTrim, "trim"))) return out(400, { error: "That body color isn't in your catalog." });
      const nextSel = { ...sel, roofType: next.roofType, roofColor: next.roofColor, cladding: next.cladding, claddingId: next.cladding, paint: next.paintStatus === "Paint" ? "Painted" : "No Paint" };
      const nextPc = next.paintStatus === "Paint" ? { body: next.paintBody, trim: next.paintTrim } : { body: "", trim: "" };
      const say = (fromSel: Any, fromPc: Any) => {
        const outS: string[] = [];
        const s = (label: string, from: string, to: string) => { if (norm(from) !== norm(to)) outS.push(`${label}: ${from || "—"} → ${to || "—"}`); };
        s("Roof type", fromSel.roofType ?? "", next.roofType);
        s("Roof color", fromSel.roofColor ?? "", next.roofColor);
        s("Cladding", CLAD[String(fromSel.cladding ?? "")] ?? "", CLAD[next.cladding] ?? next.cladding);
        s("Paint", String(fromSel.paint).toLowerCase() === "painted" ? "Painted" : "Unpainted", next.paintStatus === "Paint" ? "Painted" : "Unpainted");
        if (next.paintStatus === "Paint") { s("Paint body", fromPc.body ?? "", next.paintBody); s("Paint trim", fromPc.trim ?? "", next.paintTrim); }
        return outS;
      };
      if (!say(sel, pc).length) return out(400, { error: "That matches what the design already carries." });
      const newSnap = priced(nextSel, nextPc);
      const totalBefore = total(d.agreed.lines), totalAfter = total(newSnap);
      let sentences = say(d.agreed.selections, d.agreed.paintColors);
      if (!sentences.length) sentences = say(sel, pc);
      sentences.push(`Total: ${fmtM(totalBefore)} → ${fmtM(totalAfter)}`);
      const description = sentences.join("\n");
      if (b.dryRun === true) return out(200, { ok: true, preview: true, totalBefore, totalAfter, description });
      if (w.stage === "lost") return out(0, null);
      const before = { estimateLines: JSON.parse(JSON.stringify(d.estimate_lines)), selections: { ...sel }, paintColors: { ...pc } };
      d.selections = nextSel; d.paint_colors = nextPc; d.estimate_lines = newSnap;
      if (w.stage === "race") return out(409, { error: "Another change order was opened on this order at the same moment — reload the order and check Change orders before changing the building again.", reason: "co_pending" });
      if (w.stage === "down_after_design") return out(500, { error: "Couldn't raise the change order. Please try again — if it keeps happening, tell CSM Synergy and mention \"raise the change order\".", ref: "raise the change order" });
      let changeOrderId: string | null = null, coNo: number | null = null, draft = false;
      if (d.accepted_at) {
        const existing = l && l.source === "design_edit" ? l : null;
        if (existing) {
          Object.assign(existing, { description, total_before_cents: Math.round(totalBefore * 100), total_after_cents: Math.round(totalAfter * 100) });
          changeOrderId = existing.id; coNo = existing.co_no; draft = existing.status === "draft";
        } else {
          // The guard trigger (214): co_no, the gate's authority and fee, and the unlock spent.
          const gi = gate(code);
          const id = uid("c");
          coNo = w.cos.filter((c) => c.short_code === code).reduce((m, c) => Math.max(m, c.co_no), 0) + 1;
          if (gi.authority === "unlock") { const u = w.unlocks.find((x) => x.id === gi.unlock_id); if (u) u.consumed_at = new Date().toISOString(); }
          w.cos.push({
            id, short_code: code, co_no: coNo, status: "pending_ack", source: "design_edit", description, total_before_cents: Math.round(totalBefore * 100), total_after_cents: Math.round(totalAfter * 100),
            fee_cents: gi.fee_cents, fee_tax_cents: gi.fee_taxable && gi.fee_cents ? Math.round(gi.fee_cents * 0.07) : 0, fee_taxable: gi.fee_taxable, raised_under: gi.authority, unlock_id: gi.unlock_id ?? null,
            created_at: new Date().toISOString(), snapshot_before: before,
          });
          changeOrderId = id;
          // 367: the pending_ack insert fires change_order_sent.
          w.audit.push(`rule_event:change_order_sent:${code}`);
        }
      }
      if (w.stage === "lost_landed") return out(0, null);
      return out(200, { ok: true, changeOrderId, coNo, totalBefore, totalAfter, description, quotePdfUrl: "https://x/e.pdf", pendingAck: !!changeOrderId && !draft, draft });
    }

    if (action === "send_change_order") {
      if (!isUuid(b.changeOrderId)) return out(400, { error: "changeOrderId is required." });
      const co = w.cos.find((c) => c.id === b.changeOrderId);
      if (!co) return out(404, { error: "Change order not found." });
      if (notMine(co.short_code)) return out(404, { error: "That design is not one of yours." });
      if (co.status !== "pending_ack") return out(400, { error: co.status === "draft" ? "This change is still open -- finish it before sending it to the customer." : co.status === "acknowledged" ? "This change order is already acknowledged." : "This change order was voided." });
      if (w.send === "lost") return out(0, null);
      const to = String(w.designs.get(co.short_code)?.contact?.email ?? "");
      if (!/@/.test(to)) return out(200, { ok: true, sent: false, reason: "no email address on this design" });
      if (to.startsWith("bad")) return out(200, { ok: true, sent: false, reason: `that email address was rejected (${to})` });
      w.emails.push(co.id);
      if (w.send === "lost_sent") return out(0, null);
      return out(200, { ok: true, sent: true, reason: null });
    }

    if (action === "void_change_order") {
      if (!isUuid(b.changeOrderId)) return out(400, { error: "changeOrderId is required." });
      if (!String(b.reason ?? "").trim()) return out(400, { error: "Voiding a change order needs a reason." });
      const co = w.cos.find((c) => c.id === b.changeOrderId);
      if (!co) return out(404, { error: "Change order not found." });
      if (notMine(co.short_code)) return out(404, { error: "That design is not one of yours." });
      if (co.status !== "pending_ack" && co.status !== "draft") return out(400, { error: co.status === "acknowledged" ? "This change order is already acknowledged — it can't be discarded." : "This change order is already voided." });
      let reverted = false;
      if (co.snapshot_before?.estimateLines) {
        const d = w.designs.get(co.short_code);
        d.estimate_lines = co.snapshot_before.estimateLines; d.selections = co.snapshot_before.selections; d.paint_colors = co.snapshot_before.paintColors;
        reverted = true;
      }
      // The restore runs before the conditional status update (index.ts:17368-17418).
      if (w.voidMode === "signed_meanwhile") { co.status = "acknowledged"; return out(409, { error: "That change moved while you were looking at it — reload the order." }); }
      co.status = "void"; co.void_reason = b.reason;
      if (co.unlock_id) { const u = w.unlocks.find((x) => x.id === co.unlock_id); if (u) u.consumed_at = null; }
      if (w.voidMode === "lost") return out(0, null);
      return out(200, { ok: true, reverted, coNo: co.co_no });
    }

    if (action === "request_order_unlock") {
      const code = String(b.shortCode ?? "").trim();
      const reason = String(b.reason ?? "").trim().slice(0, 500);
      if (!code) return out(400, { error: "A design code is required." });
      if (notMine(code)) return out(404, { error: "That design is not one of yours." });
      if (!reason) return out(400, { error: "Say what needs changing -- whoever unlocks it will read this." });
      const g = gate(code);
      if (g.open === true) return out(200, { ok: true, needed: false, reason: String(g.reason ?? ""), gate: g });
      for (const u of w.unlocks) if (u.short_code === code && u.decision === "granted" && !u.consumed_at && !u.released_at && Date.parse(u.expires_at) < Date.now()) u.released_at = new Date().toISOString();
      const open = w.unlocks.find((u) => u.short_code === code && !u.consumed_at && !u.released_at && u.decision !== "declined");
      if (open) return out(200, { ok: true, already: true, unlock: open, message: open.decision === "granted" ? "This order is already unlocked." : "Someone has already asked to unlock this order." });
      if (w.unlockMode === "lost") return out(0, null);
      const row = { id: uid("d"), short_code: code, decision: null, reason, requested_at: new Date().toISOString(), expires_at: null, consumed_at: null, released_at: null };
      w.unlocks.push(row);
      w.audit.push("unlock_requested");
      if (w.unlockMode === "lost_landed") return out(0, null);
      return out(200, { ok: true, requested: true, unlock: { id: row.id, reason, requested_by_name: "Mike", requested_at: row.requested_at } });
    }
    return out(404, null);
  };
  return { w, portal };
}

function djb2(t: string) {
  let h = 5381;
  for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function setup(o: { off?: string[]; read?: (a: string) => boolean; edit?: (a: string) => boolean } = {}) {
  const { store, state } = makeStore({ off: o.off });
  const { w, portal } = makeWorld();
  const deps: Deps = {
    env: () => undefined,
    store,
    portal,
    call(fn, action, body) { return fn === "portal-settings" ? this.portal(action, body) : Promise.resolve({ status: 404, data: null }); },
    wallet,
    fetch: () => { throw new Error("no Claude in these tests"); },
    canRead: o.read ?? (() => true),
    canEdit: o.edit ?? (() => true),
    background: () => {},
    budgetMs: () => 300_000,
    makeId: () => crypto.randomUUID(),
    hash: (t) => Promise.resolve("h" + djb2(t)),
    log: () => Promise.resolve(),
    audit: () => Promise.resolve(),
    now: () => Date.now(),
    markSentWithJack: () => Promise.resolve(true),
  };
  const turn = (me: Who = who): TurnState => ({ who: me, chatId: "chat1", off: o.off ?? [], proposalIds: [] });
  const design = () => w.designs.get(CODE);
  const writes = () => w.calls.filter((c) => WRITES.includes(c.action) && !(c.action === "stage_order_attribute_change" && c.body.dryRun === true));
  const forbidden = () => w.calls.filter((c) => FORBIDDEN.includes(c.action));
  return { store, state, w, deps, turn, design, writes, forbidden };
}
type X = ReturnType<typeof setup>;

const textRule = (): Any => ({ id: crypto.randomUUID(), name: "Text them about the change", scopeKind: "pipeline", pipelineId: null, triggerKind: "event", triggerEvent: "change_order_sent", elapsedAnchor: null, elapsedDays: null, schedule: null, conditions: [], oncePerCard: true, enabled: true, appliesFrom: null, actions: [{ kind: "send_sms", params: { body: "Hi" } }], nextRunAt: null, armedCount: null, lastRun: null, stale: [] });
const change = (o: Record<string, unknown> = {}): Any => ({
  action: "change", orderNo: 1042, list: "", ref: "", roofType: "same", roofColor: "", cladding: "", paint: "same", paintBody: "", paintTrim: "", reason: "", ...o,
});
const ask = (reason: string, o: Record<string, unknown> = {}): Any => change({ action: "ask_unlock", reason, ...o });
const look = (o: Record<string, unknown> = {}): Any => ({ orderNo: 1042, list: "", ref: "", ...o });
const json = (s: string) => JSON.parse(s);

async function proposed(x: X, input: unknown, me: Who = who) {
  const s = x.turn(me);
  const out = await runTool(x.deps, s, "propose_change_order", input);
  return { out, s, card: s.proposalIds.length ? x.state.proposals.get(s.proposalIds[0])! : null };
}
/** As the page presses it: the change card's Approve shows the words the customer signs and says send:
 *  true (it emails them); the unlock card's doesn't send anything to a customer. */
const approve = (x: X, card: ProposalRow, me: Who = who) =>
  handleProposalApprove(x.deps, me, { id: card.id, hash: card.shown_hash, ...(card.kind === "changeorder_attrs" ? { send: true } : {}) });
const undo = (x: X, card: ProposalRow, me: Who = who) => handleProposalUndo(x.deps, me, { id: card.id });
const row = (x: X, card: ProposalRow) => x.state.proposals.get(card.id)!;
/** Nothing Claude reads holds a contact detail, the customer's name, their street or the design code. */
function clean(text: string) {
  assert(!leaksContactDetails(text), `a contact detail reached Claude: ${text}`);
  for (const bit of ["Dale", "Smith", "Main St", "dale@", "555-0142", CODE, CONTACT_ID]) assert(!text.includes(bit), `"${bit}" reached Claude: ${text}`);
}

// ── Reading ──────────────────────────────────────────────────────────────────────────────────────

Deno.test("look_at_order_for_change: what it has, what it can take, by number, and nothing about the customer", async () => {
  const x = setup();
  const s = x.turn();
  const out = await runTool(x.deps, s, "look_at_order_for_change", look());
  assert(!out.isError, out.content);
  clean(out.content);
  const a = json(out.content);
  assertEquals(a.order, "#1042");
  assertEquals(a.canChange, true);
  assertEquals(a.now, { roofType: "Shingle", roofColor: "Charcoal", cladding: "7\" LP Lap Siding", paint: "Painted", bodyColor: "Barn Red", trimColor: "White" });
  assertEquals(a.canTake.roofTypes, ["Shingle", "Metal"]);
  assertEquals(a.canTake.metalColors, ["Black", "Galvalume"]);
  assert(!a.canTake.bodyColors.includes("Custom color"), "a custom-allowed color isn't offered, as on the order screen");
  assertEquals(a.canTake.cladding[0], "Builder's standard");
  assertEquals(s.proposalIds.length, 0);
  assertEquals(x.writes().length, 0);
  // The builder's own phone on order_paperwork stays out too.
  assert(!out.content.includes("555-0100"));
});

Deno.test("look_at_order_for_change: a row on the person's own list works; a customer row, another person's list and a missing order don't", async () => {
  const x = setup();
  const list = await x.store.insertProposal({
    client_id: who.clientId, user_id: who.userId, kind: "lookup", status: "applied", title: "Who still owes",
    preview: { look: "who_owes", heading: "", asked: [], leftOut: [], notes: [], groups: [{ key: "owes", label: "Owes", count: 2, cents: null, note: null, more: 0, rows: [
      { ref: "o1", name: "Dale Smith", line: null, days: null, daysWord: null, cents: null, centsWord: null, link: null, orderId: ORDER_ID, shortCode: CODE },
      { ref: "c1", name: "Dale Smith", line: null, days: null, daysWord: null, cents: null, centsWord: null, link: null, contactId: CONTACT_ID, shortCode: CODE },
      { ref: "u1", name: "12x24 Lofted Barn", line: null, days: null, daysWord: null, cents: null, centsWord: null, link: null, shortCode: CODE },
    ] }] },
    payload: { look: "who_owes", area: "orders" },
  });
  const byRef = await runTool(x.deps, x.turn(), "look_at_order_for_change", look({ orderNo: 0, list: list.id, ref: "o1" }));
  assert(!byRef.isError, byRef.content);
  assertEquals(json(byRef.content).order, "#1042");
  assertEquals((await runTool(x.deps, x.turn(), "look_at_order_for_change", look({ orderNo: 0, list: list.id, ref: "c1" }))).content, CO_SAID.customerRow);
  assertEquals((await runTool(x.deps, x.turn(), "look_at_order_for_change", look({ orderNo: 0, list: list.id, ref: "u1" }))).content, CO_SAID.unitRow);
  const other: Who = { clientId: who.clientId, userId: "u2", operatorEmail: null };
  assertEquals((await runTool(x.deps, x.turn(other), "look_at_order_for_change", look({ orderNo: 0, list: list.id, ref: "o1" }))).content, CO_SAID.notOnList);
  assertEquals((await runTool(x.deps, x.turn(), "look_at_order_for_change", look({ orderNo: 77 }))).content, CO_SAID.notFound(77));
  assertEquals((await runTool(x.deps, x.turn(), "look_at_order_for_change", look({ orderNo: 0 }))).content, CO_SAID.noOrder);
  x.w.overviewCut = true;
  assertEquals((await runTool(x.deps, x.turn(), "look_at_order_for_change", look())).content, CO_SAID.listCut);
  // Two orders carrying one number: Jack doesn't pick one.
  const y = setup();
  y.w.orders.push({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", order_no: 1042, short_code: "SS-OTHER00001", total_cents: 100, ordered_at: "2026-10-02T00:00:00Z" });
  const two = await runTool(y.deps, y.turn(), "look_at_order_for_change", look());
  assert(two.isError && two.content.startsWith("More than one order is numbered #1042."), two.content);
  assertEquals((await proposed(y, change({ roofColor: "Weathered Wood" }))).card, null);
});

Deno.test("look_at_order_for_change: a live change order the amendment read missed, an order with no priced lines, and an unlock that ran out", async () => {
  {
    // The live change order read is soft. With the unlock rules on, the gate still names it.
    const x = setup();
    x.w.settings.co_unlock_required = true;
    x.w.amendSoft = true;
    x.w.cos.push({ id: "cccccccc-0000-4000-8000-000000000020", short_code: CODE, co_no: 3, status: "pending_ack", source: "manual", description: "x", total_after_cents: 1, created_at: "2026-11-01T00:00:00Z" });
    const a = json((await runTool(x.deps, x.turn(), "look_at_order_for_change", look())).content);
    assertEquals([a.canChange, a.why], [false, CO_SAID.live(3, false)]);
    assertEquals((await proposed(x, change({ roofColor: "Weathered Wood" }))).out.content, CO_SAID.live(3, false));
  }
  {
    const x = setup();
    x.design().estimate_lines = { lines: [] };
    assertEquals(json((await runTool(x.deps, x.turn(), "look_at_order_for_change", look())).content).why, CO_SAID.noLines);
  }
  {
    // A grant that expired unused: the route releases it, so a new request may go in.
    const x = setup();
    x.w.settings.co_unlock_required = true; x.w.freeWindow = false;
    x.w.unlocks.push({ id: "dddddddd-0000-4000-8000-000000000020", short_code: CODE, decision: "granted", reason: "x", requested_at: "2026-10-01T00:00:00Z", expires_at: "2026-10-04T00:00:00Z", consumed_at: null, released_at: null });
    const a = json((await runTool(x.deps, x.turn(), "look_at_order_for_change", look())).content);
    assertEquals([a.why, a.canAskUnlock], [CO_SAID.locked, true]);
    assert((await proposed(x, ask("Roof"))).card, "a card");
  }
});

Deno.test("look_at_order_for_change: a change already open, a locked order, an unsigned one and a failed gate read say why", async () => {
  {
    const x = setup();
    x.w.cos.push({ id: "cccccccc-0000-4000-8000-000000000099", short_code: CODE, co_no: 3, status: "pending_ack", source: "manual", description: "Move the door — customer asked", total_before_cents: 995000, total_after_cents: 1010000, created_at: "2026-11-01T00:00:00Z" });
    const a = json((await runTool(x.deps, x.turn(), "look_at_order_for_change", look())).content);
    assertEquals([a.canChange, a.why, a.canAskUnlock], [false, CO_SAID.live(3, false), false]);
    assert(!JSON.stringify(a).includes("Move the door"), "a change order's own words don't go to Claude");
  }
  {
    const x = setup();
    x.w.settings.co_unlock_required = true; x.w.freeWindow = false;
    const a = json((await runTool(x.deps, x.turn(), "look_at_order_for_change", look())).content);
    assertEquals([a.canChange, a.why, a.canAskUnlock], [false, CO_SAID.locked, true]);
    assertEquals(a.fee, "If it's unlocked, your change order fee of $150 plus tax goes on this change and is added to what the customer owes when they sign.");
  }
  {
    const x = setup();
    x.design().accepted_at = null;
    assertEquals(json((await runTool(x.deps, x.turn(), "look_at_order_for_change", look())).content).why, CO_SAID.notSigned);
  }
  {
    const x = setup();
    x.w.gateFails = true;
    assertEquals(json((await runTool(x.deps, x.turn(), "look_at_order_for_change", look())).content).why, CO_SAID.gateUnread);
  }
});

// ── The card ─────────────────────────────────────────────────────────────────────────────────────

Deno.test("propose_change_order: one card, only what changes, priced by the route, with the rule that would start", async () => {
  const x = setup();
  x.w.rules = [textRule()];
  const { out, card } = await proposed(x, change({ roofType: "Metal", roofColor: "black", paintTrim: "Black" }));
  assert(!out.isError, out.content);
  clean(out.content);
  assert(card, "a card");
  assertEquals(card!.kind, "changeorder_attrs");
  assertEquals(card!.status, "ready");
  assertEquals(card!.title, "Change order for order #1042: roof and paint");
  assertEquals(card!.payload.shortCode, CODE);
  assertEquals(card!.payload.attrs, { roofType: "Metal", roofColor: "Black", paintStatus: "Paint", paintBody: "Barn Red", paintTrim: "Black" });
  assertEquals(card!.preview.lines, [
    { label: "Roof type", from: "Shingle", to: "Metal" }, { label: "Roof color", from: "Charcoal", to: "Black" }, { label: "Trim color", from: "White", to: "Black" },
  ]);
  assertEquals(card!.preview.totals, { beforeCents: 890000, afterCents: 960000 });
  assertEquals(card!.preview.description, "Roof type: Shingle → Metal\nRoof color: Charcoal → Black\nPaint trim: White → Black\nTotal: $8,900.00 → $9,600.00");
  assertEquals(card!.preview.rules, ["Text them about the change"]);
  assertEquals(card!.preview.notes[0], 'This sets off your rule "Text them about the change", which texts or emails the customer by itself.');
  assertEquals(card!.preview.fee, null);
  const a = json(out.content);
  assertEquals(a.total, "$8,900 to $9,600 (+$700)");
  assert(a.rules.includes("Text them about the change"));
  // Only reads and the route's own dryRun: nothing staged, sent or requested.
  assertEquals(x.writes().length, 0);
  assertEquals(x.w.calls.filter((c) => c.action === "stage_order_attribute_change").map((c) => c.body.dryRun), [true]);
  assertEquals(x.w.cos.length, 0);
  const shown = JSON.stringify(card!.preview) + card!.title;
  for (const bit of ["dale@", "555-0142", "Main St", "Dale"]) assert(!shown.includes(bit), `the card holds ${bit}`);
});

Deno.test("propose_change_order: someone who can't open Automations hears the general rule sentence, no names", async () => {
  const x = setup({ read: (a) => a !== "settings_crm" });
  x.w.rules = [{ id: crypto.randomUUID(), name: "Secret rule", scopeKind: "pipeline", pipelineId: null, triggerKind: "event", triggerEvent: "change_order_sent", conditions: [], oncePerCard: true, enabled: true, actions: [{ kind: "send_email", params: {} }], stale: [] }];
  const { card } = await proposed(x, change({ cladding: "Board & Batten" }));
  assertEquals(card!.preview.notes[0], RULE_WARN_SAID.general);
  assertEquals(card!.preview.rules, []);
  assertEquals(card!.payload.attrs, { cladding: "batten" });
  assertEquals(card!.preview.lines, [{ label: "Cladding", from: "7\" LP Lap Siding", to: "Board & Batten" }]);
});

Deno.test("propose_change_order: refuses a second change order, an unsigned or locked order, a CRM account and money moved by hand", async () => {
  const cases: [string, (x: X) => void, string][] = [
    ["pending manual", (x) => { x.w.cos.push({ id: "cccccccc-0000-4000-8000-000000000001", short_code: CODE, co_no: 2, status: "pending_ack", source: "manual", description: "x", total_after_cents: 1, created_at: "2026-11-01T00:00:00Z" }); }, CO_SAID.live(2, false)],
    ["open draft", (x) => { x.w.cos.push({ id: "cccccccc-0000-4000-8000-000000000002", short_code: CODE, co_no: 4, status: "draft", source: "design_edit", description: "", total_after_cents: null, created_at: "2026-11-01T00:00:00Z" }); }, CO_SAID.live(4, true)],
    ["not signed", (x) => { x.design().accepted_at = null; }, CO_SAID.notSigned],
    ["no SS estimate", (x) => { x.design().ss_quote_number = null; }, CO_SAID.noSS],
    ["locked", (x) => { x.w.settings.co_unlock_required = true; x.w.freeWindow = false; }, CO_SAID.locked],
    ["gate read failed", (x) => { x.w.gateFails = true; }, CO_SAID.gateUnread],
    ["CRM paperwork", (x) => { x.w.settings.invoice_in_ghl = true; }, CO_SAID.crm],
    ["money moved by hand", (x) => { x.w.orders[0].total_cents = 1_050_000; }, CO_SAID.drift("$10,500", "$8,900")],
  ];
  for (const [name, arrange, said] of cases) {
    const x = setup();
    arrange(x);
    const { out, card } = await proposed(x, change({ roofColor: "Weathered Wood" }));
    assertEquals([name, out.isError, out.content], [name, true, said]);
    assertEquals([name, card], [name, null]);
    assertEquals([name, x.writes().length], [name, 0]);
  }
});

Deno.test("propose_change_order: asks rather than guesses, and refuses what the order screen can't do", async () => {
  const x = setup();
  const said = async (i: Any) => (await proposed(x, change(i))).out.content;
  assert((await said({ roofType: "Metal" })).startsWith("Which metal roof color? The ones offered are: Black, Galvalume."), "a new roof type needs its color");
  assert((await said({ roofColor: "Teal" })).startsWith("There's no shingle roof color called \"Teal\". The ones offered are: Charcoal, Weathered Wood."), "no such color");
  assert((await said({ paintBody: "Custom color" })).startsWith("There's no body color called"), "custom-allowed colors aren't offered");
  assert((await said({ cladding: "Brick" })).startsWith("There's no cladding called \"Brick\""), "no such cladding");
  assertEquals(await said({ roofColor: "Charcoal" }), CO_SAID.same);
  assertEquals(await said({}), CO_SAID.nothing);
  assertEquals(await said({ paint: "Unpainted", paintBody: "Clay" }), CO_SAID.unpaintedNoColors);
  assertEquals(await said({ action: "manual" }), CO_SAID.pickAction);
  x.design().estimate_lines.lines = x.design().estimate_lines.lines.filter((l: Any) => l.kind !== "paint");
  x.w.orders[0].total_cents = 800000;
  assertEquals(await said({ paint: "Unpainted" }), CO_SAID.noPaintLine);
  assertEquals(x.state.proposals.size, 0);
  // No field for a change in words or a total typed in: a manual change order has nowhere to go.
  const props = Object.keys((changeOrdersPiece.tools.find((t) => t.def.name === "propose_change_order")!.def.input_schema as Any).properties);
  assert(!props.some((k) => /description|total|amount|price|money|invoice/i.test(k)), props.join(","));
});

Deno.test("propose_change_order: an unpainted building can be painted only with both colors", async () => {
  const x = setup();
  x.design().selections.paint = "No Paint"; x.design().paint_colors = { body: "", trim: "" };
  x.design().estimate_lines = x.design().estimate_lines; // the paint line stays, at $0 for no paint
  assertEquals((await proposed(x, change({ paint: "Painted" }))).out.content, CO_SAID.paintNeedsColors);
  const { card } = await proposed(x, change({ paint: "Painted", paintBody: "Clay", paintTrim: "White" }));
  assertEquals(card!.payload.attrs, { paintStatus: "Paint", paintBody: "Clay", paintTrim: "White" });
});

Deno.test("propose_change_order: colors an old save left on an unpainted building are never used without being named", async () => {
  const x = setup();
  // The order screen hides these while it's unpainted, and look_at_order_for_change never shows them.
  x.design().selections.paint = "No Paint"; x.design().paint_colors = { body: "Clay", trim: "White" };
  assertEquals((await proposed(x, change({ paint: "Painted" }))).out.content, CO_SAID.paintNeedsColors);
  assertEquals((await proposed(x, change({ paint: "Painted", paintBody: "Clay" }))).out.content, CO_SAID.paintNeedsColors);
  const { card } = await proposed(x, change({ paint: "Painted", paintBody: "Clay", paintTrim: "White" }));
  assertEquals(card!.payload.attrs, { paintStatus: "Paint", paintBody: "Clay", paintTrim: "White" });
  assertEquals(card!.preview.lines, [
    { label: "Paint", from: "Unpainted", to: "Painted" }, { label: "Body color", from: "none", to: "Clay" }, { label: "Trim color", from: "none", to: "White" },
  ]);
});

Deno.test("propose_change_order: a roof or cladding change needs its line on the estimate, as on the order screen", async () => {
  {
    const x = setup();
    x.design().estimate_lines.lines = x.design().estimate_lines.lines.filter((l: Any) => l.kind !== "roof");
    x.w.orders[0].total_cents = 790000;
    assertEquals((await proposed(x, change({ roofColor: "Weathered Wood" }))).out.content, CO_SAID.noRoofLine);
    assert(!("roofTypes" in json((await runTool(x.deps, x.turn(), "look_at_order_for_change", look())).content).canTake));
  }
  {
    const x = setup();
    x.design().estimate_lines.lines = x.design().estimate_lines.lines.filter((l: Any) => l.kind !== "building");
    x.w.orders[0].total_cents = 190000;
    assertEquals((await proposed(x, change({ cladding: "Board & Batten" }))).out.content, CO_SAID.noBuildingLine);
  }
});

// ── Approve ──────────────────────────────────────────────────────────────────────────────────────

Deno.test("Approve: reads again, prices again, stages exactly the card ONCE, checks it, emails it ONCE", async () => {
  const x = setup();
  const { card } = await proposed(x, change({ roofType: "Metal", roofColor: "Galvalume" }));
  x.w.calls = [];
  const r = await approve(x, card!);
  assertEquals(r.status, 200);
  const done = row(x, card!);
  assertEquals(done.status, "applied");
  assertEquals(done.result, { changeOrders: 1, coNo: 1, emailed: true, reports: [] });
  assertEquals(done.undo, null);
  assertEquals(done.approved_by, "u1");
  const stage = x.w.calls.filter((c) => c.action === "stage_order_attribute_change" && c.body.dryRun !== true);
  assertEquals(stage.map((c) => c.body), [{ shortCode: CODE, attrs: card!.payload.attrs }]);
  const co = x.w.cos[0];
  assertEquals([co.status, co.source, co.raised_under, co.fee_cents], ["pending_ack", "design_edit", "free_window", 0]);
  assertEquals(x.w.calls.filter((c) => c.action === "send_change_order").map((c) => c.body), [{ changeOrderId: co.id }]);
  assertEquals(x.w.emails, [co.id]);
  assertEquals(x.design().selections.roofType, "Metal");
  // The order the reads and writes went in.
  const seq = x.w.calls.map((c) => c.action === "stage_order_attribute_change" ? (c.body.dryRun ? "dry" : "stage") : c.action);
  assertEquals(seq.slice(-5), ["dry", "crm_rules_list", "stage", "amendment_status", "send_change_order"]);
  assertEquals(x.forbidden().length, 0);
  // After the email there is no Undo: a person voids it and speaks to the customer.
  const u = await undo(x, card!);
  assertEquals(u.status, 409);
  assertEquals(x.w.cos[0].status, "pending_ack");
});

Deno.test("Approve: anything the card showed that moved refuses it, and nothing is staged", async () => {
  const cases: [string, (x: X) => void, string][] = [
    ["the building", (x) => { x.design().paint_colors.trim = "Black"; }, CO_SAID.moved("The building's roof, cladding or paint")],
    ["the price", (x) => { x.w.colors.find((c) => c.label === "Galvalume").rate = 25; }, CO_SAID.moved("The price or the wording of this change")],
    // A designer resubmit moved both the design's price and the order's total: no drift, still moved.
    ["the order total", (x) => { x.design().estimate_lines.lines[0].amount = 7100; x.w.orders[0].total_cents = 900000; }, CO_SAID.moved("The order's total")],
    ["money moved by hand", (x) => { x.w.orders[0].total_cents += 100; }, `${CO_SAID.drift("$8,901", "$8,900")} Nothing was saved.`],
    ["a change order opened", (x) => { x.w.cos.push({ id: "cccccccc-0000-4000-8000-000000000003", short_code: CODE, co_no: 5, status: "pending_ack", source: "manual", description: "x", total_after_cents: 1, created_at: new Date().toISOString() }); }, `${CO_SAID.live(5, false)} Nothing was saved.`],
    ["locked since", (x) => { x.w.settings.co_unlock_required = true; x.w.freeWindow = false; }, CO_SAID.lockedNow],
    ["the fee", (x) => {
      x.w.settings.co_unlock_required = true; x.w.freeWindow = false;
      x.w.unlocks.push({ id: "dddddddd-0000-4000-8000-000000000001", short_code: CODE, decision: "granted", reason: "x", requested_at: "2026-11-05T00:00:00Z", expires_at: new Date(Date.now() + 86_400_000).toISOString(), consumed_at: null, released_at: null });
    }, CO_SAID.moved("What this change would cost, or what lets it happen,")],
    ["the gate read", (x) => { x.w.gateFails = true; }, `${CO_SAID.gateUnread} Nothing was saved.`],
    ["a rule that texts the customer", (x) => { x.w.rules = [textRule()]; }, CO_SAID.moved("Which of your rules this sets off")],
  ];
  for (const [name, arrange, said] of cases) {
    const x = setup();
    const { card } = await proposed(x, change({ roofType: "Metal", roofColor: "Galvalume" }));
    arrange(x);
    await approve(x, card!);
    const r = row(x, card!);
    assertEquals([name, r.status, r.failure], [name, "failed", said]);
    assertEquals([name, x.writes().length], [name, 0]);
  }
});

Deno.test("Approve: a rules list that can't be read now doesn't stop it; the card already said what it knew", async () => {
  const x = setup();
  x.w.rules = [textRule()];
  const { card } = await proposed(x, change({ roofColor: "Weathered Wood" }));
  x.w.rulesDown = true;
  await approve(x, card!);
  assertEquals(row(x, card!).status, "applied");
});

Deno.test("Approve: the rules are refused again only for something the card didn't say, whoever approves it", async () => {
  {
    const x = setup();
    x.w.rulesDown = true;
    const { card } = await proposed(x, change({ roofColor: "Weathered Wood" }));
    assertEquals(card!.preview.rulesSay, RULE_WARN_SAID.unread);
    x.w.rulesDown = false;
    await approve(x, card!);
    assertEquals([row(x, card!).status, row(x, card!).failure], ["applied", null]);
  }
  {
    const x = setup();
    x.w.rulesDown = true;
    const { card } = await proposed(x, change({ roofColor: "Weathered Wood" }));
    x.w.rulesDown = false;
    x.w.rules = [textRule()];
    await approve(x, card!);
    assertEquals([row(x, card!).status, row(x, card!).failure], ["failed", CO_SAID.moved("Which of your rules this sets off")]);
    assertEquals(x.writes().length, 0);
  }
  {
    // Asked by someone who can't open Automations, approved by a teammate who can: no rule on this.
    const x = setup({ read: (a) => a !== "settings_crm" });
    const { card } = await proposed(x, change({ roofColor: "Weathered Wood" }));
    assertEquals(card!.preview.rulesSay, RULE_WARN_SAID.general);
    x.deps.canRead = () => true;
    await approve(x, card!);
    assertEquals([row(x, card!).status, row(x, card!).failure], ["applied", null]);
  }
  {
    // The card named the rule; the teammate approving can't open Automations, so can't check again.
    const x = setup();
    x.w.rules = [textRule()];
    const { card } = await proposed(x, change({ roofColor: "Weathered Wood" }));
    x.deps.canRead = (a) => a !== "settings_crm";
    await approve(x, card!);
    assertEquals([row(x, card!).status, row(x, card!).failure], ["applied", null]);
  }
});

Deno.test("Approve: a worker that dies while the email goes out leaves no Undo; before the email, Undo is saved", async () => {
  const x = setup();
  const { card } = await proposed(x, change({ roofColor: "Weathered Wood" }));
  const realPortal = x.deps.portal;
  let staged = false, sending = false;
  let atCheck: Any = undefined;
  x.deps.portal = (a, b) => {
    if (a === "stage_order_attribute_change" && (b as Any).dryRun !== true) staged = true;
    else if (staged && a === "amendment_status" && atCheck === undefined) atCheck = row(x, card!).undo;
    else if (a === "send_change_order") {
      // The email goes, and the worker never hears back.
      sending = true;
      x.w.calls.push({ action: a, body: b });
      x.w.emails.push(x.w.cos[0].id);
      return new Promise(() => {});
    }
    return realPortal(a, b);
  };
  void approve(x, card!);
  for (let i = 0; i < 200 && !sending; i++) await new Promise((r) => setTimeout(r, 0));
  assert(sending, "the email was on its way");
  assertEquals(atCheck?.changeOrderId, x.w.cos[0].id, "staged and not emailed yet: the Undo is on the row");
  // Past the give-up time the card reads as stopped part way, and the email may have gone: no Undo.
  x.deps.now = () => Date.now() + 8 * 60_000;
  const got = (await handleProposalGet(x.deps, who, { id: card!.id })).body.proposal as Any;
  assertEquals([got.status, got.canUndo], ["partly_applied", false]);
  assertEquals((await undo(x, card!)).status, 409);
  assertEquals(x.w.calls.filter((c) => c.action === "void_change_order").length, 0);
  assertEquals(x.w.cos[0].status, "pending_ack");
});

Deno.test("Approve: a lost stage adopts only a change order made by this press, saying what the card said", async () => {
  const hidden = (x: X, co: Any) => {
    const realPortal = x.deps.portal;
    let hide = true;
    x.deps.portal = (a, b) => {
      if (a === "stage_order_attribute_change" && (b as Any).dryRun !== true && hide) { hide = false; x.w.cos.push(co); }
      return realPortal(a, b);
    };
  };
  {
    // It reads the same, but it was there before the press: not Jack's.
    const x = setup();
    const { card } = await proposed(x, change({ roofColor: "Weathered Wood" }));
    x.w.stage = "lost";
    hidden(x, { id: "cccccccc-0000-4000-8000-000000000010", short_code: CODE, co_no: 7, status: "pending_ack", source: "design_edit", description: card!.preview.description, total_after_cents: card!.preview.totals.afterCents, created_at: "2026-10-20T00:00:00Z", snapshot_before: null });
    await approve(x, card!);
    const r = row(x, card!);
    assertEquals([r.status, r.result.reports[0].reason, r.undo], ["partly_applied", CO_SAID.unsure, null]);
    assertEquals(x.w.calls.filter((c) => c.action === "send_change_order").length, 0);
  }
  {
    // Made just now, but it says something else, though the building shows the new choice: not Jack's either.
    const x = setup();
    const { card } = await proposed(x, change({ roofColor: "Weathered Wood" }));
    x.w.stage = "down_after_design";
    hidden(x, { id: "cccccccc-0000-4000-8000-000000000011", short_code: CODE, co_no: 8, status: "pending_ack", source: "design_edit", description: "Door moved", total_after_cents: 1, created_at: new Date().toISOString(), snapshot_before: null });
    await approve(x, card!);
    const r = row(x, card!);
    assertEquals([r.status, r.result.reports[0].reason, r.undo], ["partly_applied", CO_SAID.unsure, null]);
    assertEquals(x.w.calls.filter((c) => c.action === "send_change_order").length, 0);
  }
});

Deno.test("Approve: a staged change order that isn't the one the card showed is never emailed", async () => {
  const atCheck = (x: X, f: () => void) => {
    const realPortal = x.deps.portal;
    let staged = false, done = false;
    x.deps.portal = (a, b) => {
      if (a === "stage_order_attribute_change" && (b as Any).dryRun !== true) staged = true;
      else if (staged && !done && a === "amendment_status") { done = true; f(); }
      return realPortal(a, b);
    };
  };
  const cases: [string, (x: X) => void, string, boolean][] = [
    ["its words moved (a designer resubmit took it over)", (x) => { x.w.cos[0].description += "\nWindow added"; }, CO_SAID.notAsShown(1), true],
    ["its total moved", (x) => { x.w.cos[0].total_after_cents += 100; }, CO_SAID.notAsShown(1), true],
    ["the live one isn't the one the stage answered with", (x) => { x.w.cos[0].id = "cccccccc-0000-4000-8000-000000000012"; }, CO_SAID.notChecked(1), true],
  ];
  for (const [name, f, said, undoable] of cases) {
    const x = setup();
    const { card } = await proposed(x, change({ roofColor: "Weathered Wood" }));
    atCheck(x, () => f(x));
    await approve(x, card!);
    const r = row(x, card!);
    assertEquals([name, r.status, r.result.reports[0].reason, !!r.undo], [name, "partly_applied", said, undoable]);
    assertEquals([name, x.w.calls.filter((c) => c.action === "send_change_order").length], [name, 0]);
  }
});

Deno.test("Approve: a change folded into someone's open draft is never emailed, and has no Undo to discard their draft", async () => {
  const x = setup();
  const { card } = await proposed(x, change({ roofColor: "Weathered Wood" }));
  const realPortal = x.deps.portal;
  let hide = true;
  x.deps.portal = (a, b) => {
    if (a === "stage_order_attribute_change" && (b as Any).dryRun !== true && hide) {
      hide = false;
      // Opened from the order screen a moment ago: the route takes the change into it and leaves it a draft.
      x.w.cos.push({ id: "cccccccc-0000-4000-8000-000000000013", short_code: CODE, co_no: 9, status: "draft", source: "design_edit", description: "", total_after_cents: null, created_at: new Date().toISOString(), snapshot_before: null });
    }
    return realPortal(a, b);
  };
  await approve(x, card!);
  const r = row(x, card!);
  assertEquals([r.status, r.result.reports[0].reason, r.undo], ["partly_applied", CO_SAID.folded(9), null]);
  assertEquals(x.w.calls.filter((c) => c.action === "send_change_order").length, 0);
});

Deno.test("Approve: a lost stage that didn't land is never sent again", async () => {
  const x = setup();
  const { card } = await proposed(x, change({ roofColor: "Weathered Wood" }));
  x.w.stage = "lost";
  await approve(x, card!);
  const r = row(x, card!);
  assertEquals(r.status, "partly_applied");
  assertEquals(r.result.reports[0].reason, CO_SAID.unsure);
  assertEquals(r.undo, null);
  assertEquals(x.writes().map((c) => c.action), ["stage_order_attribute_change"]);
});

Deno.test("Approve: a lost stage that landed is read back, and emailed once", async () => {
  const x = setup();
  const { card } = await proposed(x, change({ roofColor: "Weathered Wood" }));
  x.w.stage = "lost_landed";
  await approve(x, card!);
  const r = row(x, card!);
  assertEquals(r.status, "applied");
  assertEquals(r.result.emailed, true);
  assertEquals(x.writes().map((c) => c.action), ["stage_order_attribute_change", "send_change_order"]);
  assertEquals(x.w.emails.length, 1);
});

Deno.test("Approve: a stage that wrote the building but no change order, and the one-live race, say check the order", async () => {
  {
    const x = setup();
    const { card } = await proposed(x, change({ roofColor: "Weathered Wood" }));
    x.w.stage = "down_after_design";
    await approve(x, card!);
    const r = row(x, card!);
    assertEquals([r.status, r.result.reports[0].reason, r.undo], ["partly_applied", CO_SAID.designNoCo, null]);
    assertEquals(x.writes().map((c) => c.action), ["stage_order_attribute_change"]);
  }
  {
    const x = setup();
    const { card } = await proposed(x, change({ roofColor: "Weathered Wood" }));
    x.w.stage = "race";
    await approve(x, card!);
    const r = row(x, card!);
    assertEquals([r.status, r.result.reports[0].reason, r.undo], ["partly_applied", CO_SAID.race, null]);
    assertEquals(x.w.calls.filter((c) => c.action === "send_change_order").length, 0);
  }
});

Deno.test("Approve: a lost send may have emailed, so it is never sent again and has no Undo", async () => {
  const x = setup();
  const { card } = await proposed(x, change({ roofColor: "Weathered Wood" }));
  x.w.send = "lost_sent";
  await approve(x, card!);
  const r = row(x, card!);
  assertEquals(r.status, "partly_applied");
  assertEquals(r.result.reports[0].reason, CO_SAID.emailUnsure(1));
  assertEquals(r.undo, null);
  assertEquals(x.w.calls.filter((c) => c.action === "send_change_order").length, 1);
  assertEquals(x.w.emails.length, 1);
  assertEquals((await undo(x, card!)).status, 409);
  assertEquals(x.w.calls.filter((c) => c.action === "void_change_order").length, 0);
});

Deno.test("Approve: an email that didn't go leaves the change order staged, says why without the address, and Undo voids it", async () => {
  const x = setup();
  const { card } = await proposed(x, change({ roofType: "Metal", roofColor: "Black" }));
  x.design().contact.email = "bad-dale@example.com";
  await approve(x, card!);
  const r = row(x, card!);
  assertEquals(r.status, "partly_applied");
  assertEquals(r.result.reports[0].reason, CO_SAID.emailFailed(1, "that email address was rejected"));
  assert(!JSON.stringify(r.result).includes("example.com"), "the customer's address stays off the card");
  assert(r.undo && r.undo.changeOrderId === x.w.cos[0].id, "Undo is there before any email went");
  const u = await undo(x, card!);
  assertEquals(u.status, 200);
  const back = row(x, card!);
  assertEquals(back.status, "undone");
  assertEquals(back.result.undo, { restored: 1, removed: 0, failed: 0, reports: [] });
  assertEquals(x.w.calls.filter((c) => c.action === "void_change_order").map((c) => c.body), [{ changeOrderId: x.w.cos[0].id, reason: CO_SAID.voidReason }]);
  assertEquals(x.w.cos[0].status, "void");
  assertEquals([x.design().selections.roofType, x.design().selections.roofColor], ["Shingle", "Charcoal"]);
});

Deno.test("Undo: a change order or building that moved since is left and named; the customer's answer mid-void is said", async () => {
  const staged = async () => {
    const x = setup();
    const { card } = await proposed(x, change({ roofColor: "Weathered Wood" }));
    x.design().contact.email = "";
    await approve(x, card!);
    assertEquals(row(x, card!).result.reports[0].reason, CO_SAID.emailFailed(1, "no email address on this design"));
    return { x, card: card! };
  };
  {
    const { x, card } = await staged();
    x.design().paint_colors.body = "Clay";
    await undo(x, card);
    const r = row(x, card);
    assertEquals([r.status, r.result.undo.reports[0].reason], ["undone", CO_SAID.changedSince(1)]);
    assertEquals(x.w.calls.filter((c) => c.action === "void_change_order").length, 0);
    assertEquals(x.w.cos[0].status, "pending_ack");
  }
  {
    const { x, card } = await staged();
    x.w.cos[0].status = "acknowledged";
    await undo(x, card);
    assertEquals(row(x, card).result.undo.reports[0].reason, CO_SAID.notWaiting(1));
    assertEquals(x.w.calls.filter((c) => c.action === "void_change_order").length, 0);
  }
  {
    const { x, card } = await staged();
    x.w.cos[0].description += "\nWindow added";
    await undo(x, card);
    assertEquals(row(x, card).result.undo.reports[0].reason, CO_SAID.changedSince(1));
  }
  {
    const { x, card } = await staged();
    x.w.cos[0].total_after_cents += 100;
    await undo(x, card);
    assertEquals(row(x, card).result.undo.reports[0].reason, CO_SAID.changedSince(1));
    assertEquals(x.w.calls.filter((c) => c.action === "void_change_order").length, 0);
  }
  {
    const { x, card } = await staged();
    x.w.voidMode = "signed_meanwhile";
    await undo(x, card);
    const r = row(x, card);
    assertEquals([r.status, r.result.undo.reports[0].reason], ["undone", CO_SAID.signedMeanwhile(1)]);
    // The building was put back before the route saw the answer, so this isn't "left as it was".
    assertEquals(r.result.undo.reports[0].status, "moved");
  }
  {
    // A lost void keeps Undo; the next press reads it back as done and voids nothing twice.
    const { x, card } = await staged();
    x.w.voidMode = "lost";
    await undo(x, card);
    assertEquals(row(x, card).status, "partly_applied");
    assertEquals(row(x, card).result.undo.failed, 1);
    x.w.voidMode = "ok";
    await undo(x, card);
    assertEquals(row(x, card).status, "undone");
    assertEquals(x.w.calls.filter((c) => c.action === "void_change_order").length, 1);
  }
});

Deno.test("Approve: a change folded into one already open is never emailed or voided by Jack", async () => {
  const x = setup();
  const { card } = await proposed(x, change({ roofColor: "Weathered Wood" }));
  // A designer revision raised in the seconds between the last read and the stage (the amendment read
  // is soft, so the fake hides it from the re-read): the route folds the change into it.
  const realPortal = x.deps.portal;
  let hide = true;
  x.deps.portal = (a, b) => {
    if (a === "stage_order_attribute_change" && (b as Any).dryRun !== true && hide) {
      hide = false;
      x.w.cos.push({ id: "cccccccc-0000-4000-8000-000000000007", short_code: CODE, co_no: 6, status: "pending_ack", source: "design_edit", description: "Door moved", total_after_cents: 1, created_at: "2026-10-20T00:00:00Z", snapshot_before: null });
    }
    return realPortal(a, b);
  };
  await approve(x, card!);
  const r = row(x, card!);
  assertEquals([r.status, r.result.reports[0].reason, r.undo], ["partly_applied", CO_SAID.folded(6), null]);
  assertEquals(x.w.calls.filter((c) => c.action === "send_change_order").length, 0);
});

Deno.test("Approve under an unlock: the fee is on the card, and the change order carries it", async () => {
  const x = setup();
  x.w.settings.co_unlock_required = true; x.w.freeWindow = false;
  x.w.unlocks.push({ id: "dddddddd-0000-4000-8000-000000000002", short_code: CODE, decision: "granted", reason: "Roof", requested_at: "2026-11-05T00:00:00Z", expires_at: new Date(Date.now() + 86_400_000).toISOString(), consumed_at: null, released_at: null });
  const { out, card } = await proposed(x, change({ roofType: "Metal", roofColor: "Black" }));
  assertEquals(card!.preview.fee, { cents: 15000, taxable: true, label: "Change order fee" });
  assertEquals(card!.preview.feeSay, "Your change order fee of $150 plus tax goes on this change and is added to what the customer owes when they sign.");
  assert(json(out.content).fee.includes("$150"));
  await approve(x, card!);
  assertEquals(row(x, card!).status, "applied");
  assertEquals([x.w.cos[0].raised_under, x.w.cos[0].fee_cents], ["unlock", 15000]);
});

// ── Unlocking ────────────────────────────────────────────────────────────────────────────────────

Deno.test("ask_unlock: files the request for the person once, never decides it, and has no Undo", async () => {
  const x = setup();
  x.w.settings.co_unlock_required = true; x.w.freeWindow = false;
  // A roof change on the locked order is refused and pointed at the request.
  assertEquals((await proposed(x, change({ roofColor: "Weathered Wood" }))).out.content, CO_SAID.locked);
  assertEquals((await proposed(x, ask(""))).out.content, CO_SAID.noReason);
  const { out, card } = await proposed(x, ask("Customer wants a metal roof instead of shingles."));
  assert(!out.isError, out.content);
  clean(out.content);
  assertEquals(card!.kind, "changeorder_unlock");
  assertEquals(card!.title, "Ask to unlock order #1042");
  assertEquals(card!.payload, { shortCode: CODE, reason: "Customer wants a metal roof instead of shingles." });
  assert(card!.preview.notes.some((n: string) => n.includes("$150 plus tax")), "says the fee that would apply");
  assertEquals(x.writes().length, 0);
  await approve(x, card!);
  const r = row(x, card!);
  assertEquals([r.status, r.undo], ["applied", null]);
  assertEquals(x.writes().map((c) => [c.action, c.body]), [["request_order_unlock", { shortCode: CODE, reason: "Customer wants a metal roof instead of shingles." }]]);
  assertEquals(x.w.unlocks.length, 1);
  assertEquals((await undo(x, card!)).status, 409);
  // Asked already: the next card is refused, and an approver's decision is never Jack's.
  assertEquals((await proposed(x, ask("Again"))).out.content, CO_SAID.askedAlready);
  assertEquals(x.forbidden().length, 0);
  assert(!changeOrdersPiece.tools.some((t) => /decide|grant/i.test(JSON.stringify(t.def.input_schema))), "no tool field that could unlock");
});

Deno.test("ask_unlock: an open order needs none; a request someone filed meanwhile isn't sent twice; a lost one is read back", async () => {
  {
    const x = setup();
    assertEquals((await proposed(x, ask("Roof"))).out.content, CO_SAID.notLocked);
  }
  {
    const x = setup();
    x.w.settings.co_unlock_required = true; x.w.freeWindow = false;
    const { card } = await proposed(x, ask("Roof"));
    x.w.unlocks.push({ id: "dddddddd-0000-4000-8000-000000000003", short_code: CODE, decision: null, reason: "Ann asked", requested_at: new Date().toISOString(), expires_at: null, consumed_at: null, released_at: null });
    await approve(x, card!);
    assertEquals([row(x, card!).status, row(x, card!).failure], ["failed", `${CO_SAID.askedAlready} I didn't ask again.`]);
    assertEquals(x.writes().length, 0);
  }
  {
    const x = setup();
    x.w.settings.co_unlock_required = true; x.w.freeWindow = false;
    const { card } = await proposed(x, ask("Roof"));
    x.w.unlockMode = "lost_landed";
    await approve(x, card!);
    assertEquals(row(x, card!).status, "applied");
    assertEquals(x.writes().length, 1);
  }
  {
    const x = setup();
    x.w.settings.co_unlock_required = true; x.w.freeWindow = false;
    const { card } = await proposed(x, ask("Roof"));
    x.w.unlockMode = "lost";
    await approve(x, card!);
    assertEquals([row(x, card!).status, row(x, card!).result.reports[0].reason], ["partly_applied", CO_SAID.unlockUnsure]);
    assertEquals(x.writes().length, 1);
  }
  {
    // A reason cut at 500 on a space reads back as the one the route kept (it trims what it's sent).
    const x = setup();
    x.w.settings.co_unlock_required = true; x.w.freeWindow = false;
    const { card } = await proposed(x, ask(`${"x".repeat(499)} ${"y".repeat(20)}`));
    assertEquals(card!.payload.reason, "x".repeat(499));
    x.w.unlockMode = "lost_landed";
    await approve(x, card!);
    assertEquals(row(x, card!).status, "applied");
  }
  {
    // Unlocked meanwhile: no request is needed, and none goes.
    const x = setup();
    x.w.settings.co_unlock_required = true; x.w.freeWindow = false;
    const { card } = await proposed(x, ask("Roof"));
    x.w.freeWindow = true;
    await approve(x, card!);
    assertEquals(row(x, card!).status, "failed");
    assertEquals(x.writes().length, 0);
  }
  for (const other of [{ reason: "Ann asked", requested_at: new Date().toISOString() }, { reason: "Roof", requested_at: "2026-10-01T00:00:00Z" }]) {
    // A lost answer, and a request that isn't this press's (other words, or older): not taken for it.
    const x = setup();
    x.w.settings.co_unlock_required = true; x.w.freeWindow = false;
    const { card } = await proposed(x, ask("Roof"));
    const realPortal = x.deps.portal;
    x.deps.portal = (a, b) => {
      if (a !== "request_order_unlock") return realPortal(a, b);
      x.w.calls.push({ action: a, body: b });
      x.w.unlocks.push({ id: "dddddddd-0000-4000-8000-000000000009", short_code: CODE, decision: null, expires_at: null, consumed_at: null, released_at: null, ...other });
      return Promise.resolve({ status: 0, data: null });
    };
    await approve(x, card!);
    assertEquals([other.reason, row(x, card!).status, row(x, card!).result.reports[0].reason], [other.reason, "partly_applied", CO_SAID.unlockUnsure]);
  }
  {
    // A declined request may be asked again.
    const x = setup();
    x.w.settings.co_unlock_required = true; x.w.freeWindow = false;
    x.w.unlocks.push({ id: "dddddddd-0000-4000-8000-000000000004", short_code: CODE, decision: "declined", reason: "x", requested_at: "2026-11-01T00:00:00Z", expires_at: null, consumed_at: null, released_at: null });
    const a = json((await runTool(x.deps, x.turn(), "look_at_order_for_change", look())).content);
    assertEquals([a.canAskUnlock, a.lastUnlock], [true, "An earlier request to unlock it was declined."]);
    assert((await proposed(x, ask("Roof"))).card, "a card");
  }
});

// ── Access, switches and operators ───────────────────────────────────────────────────────────────

Deno.test("access: the tools follow change_orders and orders, and the records switch takes them away", async () => {
  const names = (x: X) => toolsFor(x.deps, x.turn()).map((t) => t.name).filter((n) => n.includes("order_for_change") || n === "propose_change_order");
  assertEquals(names(setup()), ["look_at_order_for_change", "propose_change_order"]);
  assertEquals(names(setup({ edit: (a) => a !== "change_orders" })), ["look_at_order_for_change"]);
  assertEquals(names(setup({ read: (a) => a !== "change_orders", edit: (a) => a !== "change_orders" })), []);
  assertEquals(names(setup({ read: (a) => a !== "orders" })), []);
  const off = setup({ off: ["records"] });
  assertEquals(names(off), []);
  assertEquals((await runTool(off.deps, off.turn(), "propose_change_order", change({ roofColor: "Weathered Wood" }))).content, "That isn't available here right now.");
});

Deno.test("access: Approve needs change_orders edit and the switch on, and a dealer's row scope still refuses", async () => {
  {
    const x = setup();
    const { card } = await proposed(x, change({ roofColor: "Weathered Wood" }));
    x.deps.canEdit = (a) => a !== "change_orders";
    const r = await approve(x, card!);
    assertEquals([r.status, r.body.error], [403, SENTENCES.noAccess]);
    assertEquals(x.writes().length, 0);
  }
  {
    const x = setup();
    const { card } = await proposed(x, change({ roofColor: "Weathered Wood" }));
    x.state.off = ["records"];
    const r = await approve(x, card!);
    assertEquals([r.status, r.body.error], [403, SENTENCES.switchedOff]);
    assertEquals(x.writes().length, 0);
  }
  {
    // A teammate on 'own' who can't see this customer's order: the routes refuse, word for word.
    const x = setup();
    x.w.visible = new Set();
    assertEquals((await runTool(x.deps, x.turn(), "look_at_order_for_change", look())).content, CO_SAID.notFound(1042));
    const { card } = await (async () => { const y = setup(); return await proposed(y, change({ roofColor: "Weathered Wood" })); })();
    assert(card, "made by someone who can see it");
  }
  {
    const x = setup();
    const { card } = await proposed(x, change({ roofColor: "Weathered Wood" }));
    x.w.visible = new Set();
    await approve(x, card!);
    assertEquals([row(x, card!).status, row(x, card!).failure], ["failed", "That design is not one of yours. Nothing changed."]);
    assertEquals(x.writes().length, 0);
  }
  {
    // Approve reads the order again, so it needs orders too.
    const x = setup();
    const { card } = await proposed(x, change({ roofColor: "Weathered Wood" }));
    x.deps.canRead = (a) => a !== "orders";
    await approve(x, card!);
    assertEquals([row(x, card!).status, row(x, card!).failure], ["failed", `${CO_SAID.noOrders} Nothing changed.`]);
    assertEquals(x.writes().length, 0);
  }
  {
    // Opening the card needs orders too: it shows the order's figures.
    const x = setup();
    const { card } = await proposed(x, change({ roofColor: "Weathered Wood" }));
    x.deps.canRead = (a) => a !== "orders";
    assertEquals((await handleProposalGet(x.deps, who, { id: card!.id })).status, 403);
  }
});

Deno.test("access: the unlock request's Approve needs change_orders edit, the switch, Jack on and a live card, and the order still in view", async () => {
  const locked = () => {
    const x = setup();
    x.w.settings.co_unlock_required = true; x.w.freeWindow = false;
    return x;
  };
  const refused: [string, (x: X, card: ProposalRow) => void, number, string][] = [
    ["no edit", (x) => { x.deps.canEdit = (a) => a !== "change_orders"; }, 403, SENTENCES.noAccess],
    ["switched off", (x) => { x.state.off = ["records"]; }, 403, SENTENCES.switchedOff],
    ["Jack off", (x) => { x.state.on = false; }, 403, SENTENCES.off],
    ["expired", (_x, card) => { card.expires_at = new Date(Date.now() - 1000).toISOString(); }, 409, SENTENCES.expired],
  ];
  for (const [what, arrange, status, error] of refused) {
    const x = locked();
    const { card } = await proposed(x, ask("Customer wants a metal roof."));
    arrange(x, card!);
    const r = await approve(x, card!);
    assertEquals([what, r.status, r.body.error], [what, status, error]);
    assertEquals([what, x.writes().length, x.w.unlocks.length], [what, 0, 0]);
    assertEquals([what, row(x, card!).status], [what, what === "expired" ? "expired" : "ready"]);
  }
  {
    // The order left this person's view since (a dealer's row scope, or it was removed): the route's
    // words, and no request.
    const x = locked();
    const { card } = await proposed(x, ask("Customer wants a metal roof."));
    x.w.visible = new Set();
    await approve(x, card!);
    assertEquals([row(x, card!).status, row(x, card!).failure], ["failed", "That design is not one of yours. Nothing was sent."]);
    assertEquals([x.writes().length, x.w.unlocks.length], [0, 0]);
  }
  {
    // A change order raised meanwhile opens the gate too (authority "amendment"), but a change can't be
    // asked for while it stands: that is what's said, and no request goes.
    const x = locked();
    const { card } = await proposed(x, ask("Customer wants a metal roof."));
    x.w.cos.push({ id: "cccccccc-0000-4000-8000-000000000007", short_code: CODE, co_no: 6, status: "pending_ack", source: "manual", description: "x", total_after_cents: 1, created_at: new Date().toISOString() });
    await approve(x, card!);
    assertEquals([row(x, card!).status, row(x, card!).failure], ["failed", CO_SAID.live(6, false)]);
    assertEquals([x.writes().length, x.w.unlocks.length], [0, 0]);
  }
});

Deno.test("operators in view-as may approve, and the record names them", async () => {
  const x = setup();
  const { card } = await proposed(x, change({ roofColor: "Weathered Wood" }), operator);
  await approve(x, card!, operator);
  const r = row(x, card!);
  assertEquals([r.status, r.approved_by_operator], ["applied", "ahsan@csmsynergy.com"]);
  assertEquals(x.w.emails.length, 1);
});

// ── A send card ──────────────────────────────────────────────────────────────────────────────────

Deno.test("the change card is a send card: a press without send: true reads, stages and emails nothing, and the card stays ready", async () => {
  const change1 = PIECE_KINDS.get("changeorder_attrs")!, unlock1 = PIECE_KINDS.get("changeorder_unlock")!;
  assertEquals([change1.sends, change1.gaveUp, change1.onScreen], [true, CO_SAID.gaveUp, CO_SAID.onScreen]);
  // Asking for an unlock emails no customer: it isn't a send card.
  assertEquals(unlock1.sends, undefined);
  const x = setup();
  const { card } = await proposed(x, change({ roofColor: "Weathered Wood" }));
  x.w.calls = [];
  // An older page draws it as a plain card whose Approve says nothing about sending.
  const r = await handleProposalApprove(x.deps, who, { id: card!.id, hash: card!.shown_hash });
  assertEquals([r.status, r.body.error], [409, SENTENCES.reloadToSend]);
  assertEquals([row(x, card!).status, x.w.calls.length, x.w.cos.length, x.w.emails.length], ["ready", 0, 0, 0]);
  // The page that shows the words says send: true, and that press runs it, once.
  await approve(x, card!);
  assertEquals([row(x, card!).status, x.w.cos.length, x.w.emails.length], ["applied", 1, 1]);
  // The unlock card runs as before, without send.
  const y = setup();
  y.w.settings.co_unlock_required = true; y.w.freeWindow = false;
  const asked = (await proposed(y, ask("Roof"))).card!;
  assertEquals((await handleProposalApprove(y.deps, who, { id: asked.id, hash: asked.shown_hash })).status, 200);
  assertEquals(row(y, asked).status, "applied");
});

Deno.test("a change order press that threw or stalled says it may have been emailed, never 'saved', and keeps no Undo", async () => {
  {
    const x = setup();
    const { card } = await proposed(x, change({ roofColor: "Weathered Wood" }));
    const realPortal = x.deps.portal;
    x.deps.portal = (a, b) => {
      if (a === "send_change_order") throw new Error("the worker fell over mid-send");
      return realPortal(a, b);
    };
    await approve(x, card!);
    const r = row(x, card!);
    assertEquals([r.status, r.result.reports[0].reason, r.undo], ["partly_applied", CO_SAID.gaveUp, null]);
    assert(!/saved/i.test(CO_SAID.gaveUp), CO_SAID.gaveUp);
  }
  {
    // A press still "applying" past the give-up time died with its worker.
    const x = setup();
    const { card } = await proposed(x, change({ roofColor: "Weathered Wood" }));
    Object.assign(row(x, card!), { status: "applying", updated_at: new Date(Date.now() - 3_600_000).toISOString() });
    await handleProposalGet(x.deps, who, { id: card!.id });
    const r = row(x, card!);
    assertEquals([r.status, r.result.reports.at(-1).reason], ["partly_applied", CO_SAID.gaveUp]);
  }
});

Deno.test("propose_change_order is withheld after a customer's words; the look stays and says to make the card on the reply", async () => {
  const x = setup();
  const read = { ...x.turn(), customerWordsRead: true };
  const offered = toolsFor(x.deps, read).map((t) => t.name);
  assert(offered.includes("look_at_order_for_change") && !offered.includes("propose_change_order"), offered.join(","));
  assertEquals((await runTool(x.deps, read, "propose_change_order", change({ roofColor: "Weathered Wood" }))).content, "That isn't available here right now.");
  assertEquals([read.proposalIds.length, x.writes().length], [0, 0]);
  assert(json((await runTool(x.deps, read, "look_at_order_for_change", look())).content).note.includes("when they reply"));
});

// ── The strict budget, the kinds and the words ───────────────────────────────────────────────────

Deno.test("one strict tool, no unions, nothing optional; the read tool is never strict", () => {
  const defs = changeOrdersPiece.tools.map((t) => t.def);
  assertEquals(strictCost(defs), { tools: 1, optional: 0, unions: 0 });
  assertEquals(strictCost(withinStrictLimits(defs)), { tools: 1, optional: 0, unions: 0 });
  const propose = defs.find((d) => d.name === "propose_change_order")!;
  assert(/^propose_/.test(propose.name) && propose.strict === true);
  assert(!/anyOf|"null"|nullable/.test(JSON.stringify(propose.input_schema)), "no unions, nulls or nullables");
  assertEquals(propose.input_schema.required.sort(), Object.keys(propose.input_schema.properties).sort());
  for (const d of defs.filter((d) => d !== propose)) assert(/^(look_|find_)/.test(d.name) && !d.strict, d.name);
  // With every piece Jack ships, the request stays inside the API's limits and this tool keeps strict.
  const x = setup();
  const all = toolsFor(x.deps, x.turn());
  const c = strictCost(all);
  assert(c.tools <= 20 && c.optional <= 24 && c.unions <= 16, JSON.stringify(c));
  assert(all.find((d) => d.name === "propose_change_order")?.strict === true, "still strict alongside the rest");
});

Deno.test("kinds carry this area's prefix; route sentences read estimate, never the old word", () => {
  assertEquals(CHANGEORDER_KINDS, ["changeorder_attrs", "changeorder_unlock"]);
  assertEquals(plainWords("This design has no StructureStudio quote yet."), "This design has no StructureStudio estimate yet.");
  assertEquals(plainWords("CO-2 is still open — finish it or void it."), "CO-2 is still open: finish it or void it.");
  assert(!/quote/i.test(JSON.stringify(changeOrdersPiece.can) + JSON.stringify(changeOrdersPiece.rules) + JSON.stringify(changeOrdersPiece.tools.map((t) => t.def))), "no 'quote' where Claude or a person reads it");
  assert(!JSON.stringify(SAID).includes("quote"));
});

// ── The sends switch (11-09, the cautious side, decided for Ahsan) ───────────────────────────────────

Deno.test("sends off: the change order card needs it as well as records, the unlock request doesn't, and the switch's label names change orders", () => {
  assertEquals(PIECE_KINDS.get("changeorder_attrs")!.switches({} as ProposalRow), ["records", "sends"]);
  assertEquals(PIECE_KINDS.get("changeorder_unlock")!.switches({} as ProposalRow), ["records"]);
  const sw = SWITCHES.find((s) => s.key === "sends")!;
  assertEquals(sw.label, "Send replies, estimates and change orders when you press Approve");
  // What Claude reads says so too.
  const def = changeOrdersPiece.tools.find((t) => t.def.name === "propose_change_order")!.def;
  assert(/makes no card while sending is switched off/.test(def.description) && /ask_unlock sends nothing/.test(def.description), def.description);
  assert(changeOrdersPiece.rules!.some((l) => /needs sending switched on/.test(l)));
  for (const s of [CO_SAID.sendsOff, sw.label, def.description]) assert(!/—|–/.test(s) && !/quote/i.test(s), s);
});

Deno.test("sends off: propose_change_order makes no change card and says so, reading nothing; asking for an unlock still works", async () => {
  const x = setup({ off: ["sends"] });
  // Still offered: the same tool asks for an unlock, which sends nothing.
  assert(toolsFor(x.deps, x.turn()).some((t) => t.name === "propose_change_order"));
  const { out, card } = await proposed(x, change({ roofColor: "Weathered Wood" }));
  assertEquals([out.isError, out.content, card], [true, CO_SAID.sendsOff, null]);
  assertEquals([x.state.proposals.size, x.w.calls.length, x.writes().length], [0, 0, 0]);
  // The look says the change can't go up, and why.
  const seen = json((await runTool(x.deps, x.turn(), "look_at_order_for_change", look())).content);
  assertEquals([seen.canChange, seen.why], [false, CO_SAID.sendsOff]);
  assert(/sending is switched off/.test(seen.note), seen.note);
  // A locked order: the unlock request is still made, and its Approve runs with sending off.
  const y = setup({ off: ["sends"] });
  y.w.settings.co_unlock_required = true; y.w.freeWindow = false;
  const asked = await proposed(y, ask("Customer wants a metal roof."));
  assert(asked.card, asked.out.content);
  assertEquals(asked.card!.kind, "changeorder_unlock");
  assertEquals((await approve(y, asked.card!)).status, 200);
  assertEquals([row(y, asked.card!).status, y.w.unlocks.length, y.w.emails.length], ["applied", 1, 0]);
});

Deno.test("sends off after the card was made: Approve is refused in a sentence that names sending, nothing staged or emailed, the card still ready", async () => {
  const x = setup();
  const { card } = await proposed(x, change({ roofColor: "Weathered Wood" }));
  assert(card, "made while sending was on");
  x.state.off = ["sends"];
  const r = await approve(x, card!);
  assertEquals([r.status, r.body.error], [403, SENTENCES.sendsOff]);
  assertEquals([row(x, card!).status, x.writes().length, x.w.cos.length, x.w.emails.length], ["ready", 0, 0, 0]);
  // Back on, the same card runs once.
  x.state.off = [];
  await approve(x, card!);
  assertEquals([row(x, card!).status, x.w.cos.length, x.w.emails.length], ["applied", 1, 1]);
});
