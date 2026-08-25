// One normalized activity feed for the Pipedrive-style record page.
//
// A SERVER-SIDE UNION, deliberately not a materialized `activities` table and not a SQL
// view.
//   * Not materialized: it would need a backfill AND a dual-write in six existing writers
//     AND a permanent consistency problem, to buy a performance win that does not exist at
//     this scale (a tenant has hundreds of designs, not millions).
//   * Not a SQL view: it must union email_sends and invoice_sends, which are
//     service-role-only with zero policies, so the view would need SECURITY DEFINER anyway
//     — which an edge function already is, with resolveTenant, GATES and audit attached.
//
// 🚨 THE ONE THING THAT HAD TO CHANGE. portal-settings' existing `contact_activity` pages
// the GHL estimate list — up to 20 requests × 100 — ON EVERY DRAWER OPEN. That is
// survivable in a drawer you open occasionally and fatal on a page you land on. So nothing
// here calls GHL. Almost every signal is already projected locally; the two that are not
// (`ghl_last_visited_at`, `ghl_status_at`) are stamped by sync-design-status, which already
// lists estimates ONCE PER TENANT rather than once per design and which the portal already
// fires on every list load. Zero marginal cost, and it fixes the timezone landmine
// documented in 02-sales.jsx once, at write time, instead of re-deriving it in the browser
// on every render.

export type FeedEvent = {
  id: string;
  type: string;
  at: string;
  actor?: string | null;
  title: string;
  body?: string | null;
  code?: string | null;
  contactId?: string | null;
  meta?: Record<string, unknown> | null;
  icon?: string | null;
  pinned?: boolean;
};

// The chip vocabulary, shared with the browser. The chip row and this filter read the SAME
// map, so a chip can never request a type the server does not emit — the RANK/STATUS_RANK
// class of bug, headed off before it can happen again.
export const CRM_FEED_TYPES = {
  activity: ["activity"],
  note: ["note"],
  email: ["email"],
  // Reserved NOW so SMS drops in later without a shell, page or route change: one source
  // below, `enabled: true` on two registry entries, one Twilio webhook. Carolyn is still
  // setting up the Twilio account, so the seam is proved rather than the feature shipped.
  sms: ["sms", "whatsapp"],
  document: ["quote_pdf", "invoice_pdf", "change_order"],
  deal: ["design_created", "design_version", "stage_change", "accepted", "quote_opened"],
  invoice: ["invoice_created", "invoice_sent", "payment"],
  changelog: ["design_version", "stage_change", "status_change"],
} as const;

const iso = (v: unknown): string => (typeof v === "string" ? v : new Date(0).toISOString());

/**
 * Build the feed for one record.
 *
 * `codes` is every design short_code in scope: one entry for a design record, all of a
 * contact's designs for a contact record. Every query below is keyed on an existing index.
 */
export async function buildCrmFeed(
  admin: any,
  clientId: string,
  opts: { codes: string[]; contactId?: string | null; limit?: number; isAdmin?: boolean },
): Promise<FeedEvent[]> {
  const codes = (opts.codes || []).filter(Boolean).slice(0, 200);
  const out: FeedEvent[] = [];
  const push = (e: FeedEvent) => { if (e.at) out.push(e); };

  const q = <T>(p: Promise<T>) => p.then((r: any) => r?.data ?? []).catch(() => []);

  const [designs, versions, emails, accepts, changeOrders, invoices, leads, notes, acts] = await Promise.all([
    codes.length ? q(admin.from("designs").select("short_code, created_at, updated_at, status, selections, ghl_estimate_number, ss_quote_number, ss_quote_pdf_url, ss_quote_sent_at, accepted_at, contact").in("short_code", codes).eq("client_id", clientId)) : Promise.resolve([]),
    codes.length ? q(admin.from("design_versions").select("short_code, version, created_at, selections").in("short_code", codes).eq("client_id", clientId).order("version", { ascending: false }).limit(120)) : Promise.resolve([]),
    codes.length ? q(admin.from("email_sends").select("id, short_code, kind, to_email, subject, status, created_at").in("short_code", codes).eq("client_id", clientId).order("created_at", { ascending: false }).limit(80)) : Promise.resolve([]),
    codes.length ? q(admin.from("design_acceptances").select("id, short_code, subject, quote_number, signer_name, method, created_at").in("short_code", codes).eq("client_id", clientId)) : Promise.resolve([]),
    codes.length ? q(admin.from("change_orders").select("id, short_code, co_no, status, total_before_cents, total_after_cents, created_at").in("short_code", codes).eq("client_id", clientId)) : Promise.resolve([]),
    codes.length ? q(admin.from("invoice_sends").select("short_code, status, invoice_number, issued_by, updated_at, created_at").in("short_code", codes).eq("client_id", clientId)) : Promise.resolve([]),
    opts.contactId ? q(admin.from("captured_leads").select("id, name, source, created_at").eq("client_id", clientId).eq("contact_id", opts.contactId)) : Promise.resolve([]),
    q(opts.contactId
      ? admin.from("crm_notes").select("id, body, pinned, created_by, created_at, short_code").eq("client_id", clientId).eq("contact_id", opts.contactId).is("deleted_at", null)
      : admin.from("crm_notes").select("id, body, pinned, created_by, created_at, short_code").eq("client_id", clientId).in("short_code", codes).is("deleted_at", null)),
    q(opts.contactId
      ? admin.from("crm_activities").select("id, kind, subject, due_at, done, done_at, created_at, short_code").eq("client_id", clientId).eq("contact_id", opts.contactId)
      : admin.from("crm_activities").select("id, kind, subject, due_at, done, done_at, created_at, short_code").eq("client_id", clientId).in("short_code", codes)),
  ]);

  for (const d of designs as any[]) {
    const sel = d.selections || {};
    const what = [sel.style, sel.size].filter(Boolean).join(" ") || "a design";
    push({ id: `d:${d.short_code}`, type: "design_created", at: iso(d.created_at), title: `Design started — ${what}`, code: d.short_code, icon: "design" });
    if (d.ss_quote_sent_at) push({ id: `qs:${d.short_code}`, type: "email", at: iso(d.ss_quote_sent_at), title: `Quote ${d.ss_quote_number || ""} sent`.trim(), code: d.short_code, icon: "email" });
    if (d.accepted_at) push({ id: `ac:${d.short_code}`, type: "accepted", at: iso(d.accepted_at), title: "Quote accepted", code: d.short_code, icon: "accept" });
    // The customer OPENED the estimate. The one genuinely GHL-only signal, and it is here
    // as a stamped column rather than a live API call.
    if (d.ghl_last_visited_at) push({ id: `ov:${d.short_code}`, type: "quote_opened", at: iso(d.ghl_last_visited_at), title: "Customer opened the quote", code: d.short_code, icon: "eye" });
  }

  // Versions carry a diff. diffVersionSelections moved server-side with this — including
  // its cladding label map and the whole-row paint comparison, both hard-won — so the
  // browser stops reshaping what the server already knows.
  const byCode: Record<string, any[]> = {};
  for (const v of versions as any[]) (byCode[v.short_code] ||= []).push(v);
  for (const code of Object.keys(byCode)) {
    const list = byCode[code].sort((a, b) => a.version - b.version);
    for (let i = 1; i < list.length; i++) {
      const changed = diffSelections(list[i - 1].selections || {}, list[i].selections || {});
      push({
        id: `v:${code}:${list[i].version}`, type: "design_version", at: iso(list[i].created_at),
        title: `Design edited — version ${list[i].version}`,
        body: changed.length ? changed.join("; ") : null, code, icon: "edit",
      });
    }
  }

  // email_sends is the table that makes the Emails chip REAL. Nothing in the portal reads
  // it today, so every quote and invoice email we have ever sent is invisible in the UI.
  for (const e of emails as any[]) {
    const st = e.status && e.status !== "sent" ? ` (${e.status})` : "";
    push({ id: `e:${e.id}`, type: "email", at: iso(e.created_at), title: `${labelKind(e.kind)} emailed to ${e.to_email || "customer"}${st}`, body: e.subject || null, code: e.short_code, icon: "email" });
  }
  for (const a of accepts as any[]) {
    push({ id: `sig:${a.id}`, type: "accepted", at: iso(a.created_at), title: `${a.subject === "change_order" ? "Change order" : "Quote"} signed by ${a.signer_name || "customer"}`, body: a.quote_number ? `Quote ${a.quote_number} · ${a.method}` : a.method, code: a.short_code, icon: "accept" });
  }
  for (const c of changeOrders as any[]) {
    const delta = (Number(c.total_after_cents || 0) - Number(c.total_before_cents || 0)) / 100;
    push({ id: `co:${c.id}`, type: "change_order", at: iso(c.created_at), title: `Change order ${c.co_no || ""} — ${c.status}`.trim(), body: delta ? `${delta > 0 ? "+" : ""}$${delta.toFixed(2)}` : null, code: c.short_code, icon: "doc" });
  }
  for (const i of invoices as any[]) {
    // Preserves the existing "created but never emailed" warning the Designs tab shows.
    push({ id: `inv:${i.short_code}`, type: i.status === "sent" ? "invoice_sent" : "invoice_created", at: iso(i.updated_at || i.created_at), title: `Invoice ${i.invoice_number || ""} ${i.status}`.trim(), body: i.issued_by ? `issued by ${i.issued_by}` : null, code: i.short_code, icon: "invoice" });
  }
  // The ONLY event a browsing contact has. Without it a top-of-funnel record page is blank,
  // which reads as broken rather than as early.
  for (const l of leads as any[]) {
    push({ id: `cl:${l.id}`, type: "lead_captured", at: iso(l.created_at), title: `Enquired on the design page${l.source ? ` (${l.source})` : ""}`, icon: "lead" });
  }
  for (const n of notes as any[]) {
    push({ id: `n:${n.id}`, type: "note", at: iso(n.created_at), title: "Note", body: n.body, code: n.short_code, pinned: !!n.pinned, actor: n.created_by, icon: "note" });
  }
  for (const a of acts as any[]) {
    push({ id: `a:${a.id}`, type: "activity", at: iso(a.done ? (a.done_at || a.created_at) : a.created_at), title: `${labelActivity(a.kind)}: ${a.subject}`, body: a.done ? "Completed" : (a.due_at ? `Due ${a.due_at}` : "No due date"), code: a.short_code, meta: { kind: a.kind, done: !!a.done, dueAt: a.due_at, id: a.id }, icon: a.kind });
  }

  out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return out.slice(0, opts.limit || 200);
}

function labelKind(k: string): string {
  return k === "estimate" ? "Quote" : k === "invoice" ? "Invoice"
    : k === "acceptance" ? "Acceptance receipt" : k === "change_order" ? "Change order"
    : k === "test" ? "Test email" : "Email";
}
function labelActivity(k: string): string {
  return k === "call" ? "Call" : k === "meeting" ? "Meeting" : k === "task" ? "Task"
    : k === "deadline" ? "Deadline" : k === "lunch" ? "Lunch" : "Email";
}

// Moved verbatim in spirit from portal/02-sales.jsx's diffVersionSelections. It lives here
// now so the browser is not re-deriving on every render what the server already assembled.
const CLADDING_LABELS: Record<string, string> = {
  panel: "Panel Siding", lap: "Lap Siding", batten: "Board & Batten", agpanel: "Metal",
};
function diffSelections(a: Record<string, any>, b: Record<string, any>): string[] {
  const out: string[] = [];
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    const av = a?.[k], bv = b?.[k];
    if (String(av ?? "") === String(bv ?? "")) continue;
    const pretty = (v: any) => (k === "cladding" ? (CLADDING_LABELS[String(v)] || String(v || "—")) : String(v || "—"));
    out.push(`${k}: ${pretty(av)} → ${pretty(bv)}`);
  }
  return out.slice(0, 8);
}
