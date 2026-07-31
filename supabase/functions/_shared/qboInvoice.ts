/**
 * Push a sent invoice into QuickBooks Online, mirroring the GHL invoice line by line.
 *
 * CONTRACT WITH THE CALLER (send_invoice): this function NEVER throws and NEVER changes
 * the caller's response. It runs strictly AFTER the ledger row is marked 'sent' — the
 * money has already moved in GHL; QuickBooks is bookkeeping, and a bookkeeping failure
 * must not un-send an email. Every outcome, success or failure, is recorded on the
 * invoice_sends row (qbo_invoice_id / qbo_doc_number / qbo_pushed_at / qbo_error /
 * qbo_attempts) where the UI and the retry action can see it.
 *
 * DARK BY CONSTRUCTION: it skips silently unless the tenant has a live QuickBooks
 * connection AND the design carries an estimate_lines snapshot (migration 066). No
 * tenant qualifies until they connect and a fresh estimate is submitted — so deploying
 * this changes nothing for anyone until those two things are true.
 *
 * NO PARTIAL INVOICES: if any line cannot be resolved to a QuickBooks item through the
 * tenant's qbo_item_map (most-specific-wins, ending at the 'fallback' kind), the WHOLE
 * push is aborted with qbo_error = 'unmapped: …'. A book entry that quietly drops lines
 * is worse than no entry.
 */

// deno-lint-ignore-file no-explicit-any
import { qboFetch, QboBroken, QboNotConnected } from "./qboToken.ts";

/** QBO query-language string literal: only the single quote needs escaping. */
const q = (s: string) => s.replace(/'/g, "\\'");

type PushArgs = {
  shortCode: string;
  /** GHL invoice number — becomes the QBO DocNumber, tying the two books together. */
  docNumber: string | null;
  /** GHL's own total, when the caller has it; used for the mismatch note only. */
  ghlTotal?: number | null;
};

export async function pushQboInvoice(admin: any, clientId: string, args: PushArgs): Promise<void> {
  const { shortCode } = args;

  // Everything below is best-effort by contract; one catch-all keeps the promise.
  try {
    // ── Dark guards ────────────────────────────────────────────────────────────────
    const { data: cs } = await admin.from("client_settings")
      .select("qbo_realm_id, qbo_refresh_error")
      .eq("client_id", clientId).maybeSingle();
    if (!cs?.qbo_realm_id || cs.qbo_refresh_error) return; // not connected / broken → dark
    const realmId = String(cs.qbo_realm_id);

    const { data: design } = await admin.from("designs")
      .select("estimate_lines, contact")
      .eq("client_id", clientId).eq("short_code", shortCode).maybeSingle();
    const snap = design?.estimate_lines;
    if (!snap || !Array.isArray(snap.lines) || snap.lines.length === 0) return; // pre-066 design → dark

    // Claim an attempt number up front; it seeds Intuit's requestid so a retry of the
    // SAME attempt cannot double-create, while a deliberate retry (new attempt) can.
    const { data: ledger } = await admin.from("invoice_sends")
      .select("qbo_attempts, qbo_invoice_id")
      .eq("client_id", clientId).eq("short_code", shortCode).maybeSingle();
    if (ledger?.qbo_invoice_id) return; // already in the books
    const attempt = (Number(ledger?.qbo_attempts) || 0) + 1;

    const fail = async (msg: string) => {
      await admin.from("invoice_sends").update({
        qbo_error: msg.slice(0, 500),
        qbo_attempts: attempt,
        updated_at: new Date().toISOString(),
      }).eq("client_id", clientId).eq("short_code", shortCode);
    };

    // ── Resolve every line to a QuickBooks item BEFORE touching QuickBooks ────────
    const { data: maps } = await admin.from("qbo_item_map")
      .select("line_kind, item_key, style_id, qbo_item_id, qbo_item_name")
      .eq("client_id", clientId);
    const byKey = new Map<string, { id: string; name: string | null }>();
    for (const m of maps ?? []) {
      byKey.set(`${m.line_kind}|${m.item_key || ""}|${m.style_id || ""}`,
        { id: String(m.qbo_item_id), name: m.qbo_item_name ?? null });
    }
    const styleId = snap.styleId ? String(snap.styleId) : "";
    const resolve = (kind: string, itemKey: string) => {
      const k = String(kind || "fallback");
      const key = String(itemKey || "");
      return (
        // style override first, for the two kinds that support one
        ((k === "building" || k === "layout_item") && styleId
          ? byKey.get(`${k}|${key}|${styleId}`) : undefined) ??
        byKey.get(`${k}|${key}|`) ??             // the kind's (or item's) default
        (k === "layout_item" ? byKey.get("layout_item||") : undefined) ??
        byKey.get("fallback||")                   // tenant-wide safety net
      );
    };

    const unmapped: string[] = [];
    const resolved = snap.lines.map((li: any) => {
      const item = resolve(li.kind, li.itemKey);
      if (!item) unmapped.push(`${li.kind}${li.itemKey ? `:${li.itemKey}` : ""} (${li.name})`);
      return { li, item };
    });
    if (unmapped.length) {
      await fail(`unmapped: ${[...new Set(unmapped)].join(", ")} — map these under Settings → QuickBooks, then Retry`);
      return;
    }

    // ── Find or create the Customer (email first — a precise identity) ────────────
    const contact = design?.contact ?? {};
    const email = String(contact.email ?? "").trim();
    const name = [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim()
      || String(contact.name ?? "").trim() || email || `StructureStudio ${shortCode}`;

    let customerId: string | null = null;
    if (email) {
      const r = await qboFetch(admin, clientId, realmId,
        `/query?query=${encodeURIComponent(`select Id from Customer where PrimaryEmailAddr = '${q(email)}' maxresults 1`)}&minorversion=75`);
      customerId = r?.QueryResponse?.Customer?.[0]?.Id ?? null;
    }
    if (!customerId) {
      const r = await qboFetch(admin, clientId, realmId,
        `/query?query=${encodeURIComponent(`select Id from Customer where DisplayName = '${q(name)}' maxresults 1`)}&minorversion=75`);
      customerId = r?.QueryResponse?.Customer?.[0]?.Id ?? null;
    }
    if (!customerId) {
      const created = await qboFetch(admin, clientId, realmId, `/customer?minorversion=75`, {
        method: "POST",
        body: JSON.stringify({
          DisplayName: name,
          ...(email ? { PrimaryEmailAddr: { Address: email } } : {}),
          ...(contact.phone ? { PrimaryPhone: { FreeFormNumber: String(contact.phone) } } : {}),
        }),
      });
      customerId = created?.Customer?.Id ?? null;
    }
    if (!customerId) { await fail("could not find or create the QuickBooks customer"); return; }

    // ── Idempotency: an invoice with this DocNumber may already exist (crashed run) ─
    const docNumber = (args.docNumber ?? "").toString().slice(0, 21) || null; // QBO cap: 21 chars
    if (docNumber) {
      const r = await qboFetch(admin, clientId, realmId,
        `/query?query=${encodeURIComponent(`select Id, DocNumber, TotalAmt from Invoice where DocNumber = '${q(docNumber)}' maxresults 1`)}&minorversion=75`);
      const existing = r?.QueryResponse?.Invoice?.[0];
      if (existing?.Id) {
        await admin.from("invoice_sends").update({
          qbo_invoice_id: String(existing.Id),
          qbo_doc_number: docNumber,
          qbo_pushed_at: new Date().toISOString(),
          qbo_error: null,
          qbo_attempts: attempt,
          updated_at: new Date().toISOString(),
        }).eq("client_id", clientId).eq("short_code", shortCode);
        return; // adopted — a previous run made it and died before recording it
      }
    }

    // ── Build the invoice ──────────────────────────────────────────────────────────
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const lines: any[] = resolved.map(({ li, item }: any) => ({
      DetailType: "SalesItemLineDetail",
      Amount: round2((Number(li.qty) || 0) * (Number(li.amount) || 0)),
      Description: String(li.name ?? "").slice(0, 4000),
      SalesItemLineDetail: {
        ItemRef: { value: item.id, ...(item.name ? { name: item.name } : {}) },
        Qty: Number(li.qty) || 1,
        UnitPrice: Number(li.amount) || 0,
        // Delivery mirrors GHL's NT category: exempt THIS line, others stay taxable.
        ...(li.nonTaxable ? { TaxCodeRef: { value: "NON" } } : {}),
      },
    }));

    const discount = Number(snap.discount) || 0;
    if (discount > 0) {
      // One native discount line — QBO's own concept, no item mapping needed.
      lines.push({
        DetailType: "DiscountLineDetail",
        Amount: round2(discount),
        DiscountLineDetail: { PercentBased: false },
      });
    }

    const body = {
      CustomerRef: { value: customerId },
      Line: lines,
      ...(docNumber ? { DocNumber: docNumber } : {}),
    };

    // requestid = shortCode-attempt: Intuit dedupes identical requestids, so a network
    // timeout retried by the SAME attempt cannot create two invoices.
    const inv = await qboFetch(admin, clientId, realmId,
      `/invoice?minorversion=75&requestid=${encodeURIComponent(`${shortCode}-${attempt}`.slice(0, 50))}`,
      { method: "POST", body: JSON.stringify(body) });

    const created = inv?.Invoice;
    if (!created?.Id) { await fail("QuickBooks did not return an invoice id"); return; }

    // Total check is INFORMATION, not failure: automated sales tax can legitimately
    // differ from GHL's, and the invoice exists either way. >1¢ gets a note, keeps the id.
    let note: string | null = null;
    const ghlTotal = Number(args.ghlTotal);
    if (Number.isFinite(ghlTotal) && ghlTotal > 0 && created.TotalAmt != null) {
      const diff = Math.abs(Number(created.TotalAmt) - ghlTotal);
      if (diff > 0.01) note = `pushed_with_total_mismatch: QBO $${Number(created.TotalAmt).toFixed(2)} vs GHL $${ghlTotal.toFixed(2)}`;
    }

    await admin.from("invoice_sends").update({
      qbo_invoice_id: String(created.Id),
      qbo_doc_number: created.DocNumber ? String(created.DocNumber) : docNumber,
      qbo_pushed_at: new Date().toISOString(),
      qbo_error: note,
      qbo_attempts: attempt,
      updated_at: new Date().toISOString(),
    }).eq("client_id", clientId).eq("short_code", shortCode);
  } catch (e) {
    // Includes QboBroken / QboNotConnected races (disconnected mid-push) and QBO 4xx/5xx.
    const msg = e instanceof QboBroken ? "QuickBooks needs to be reconnected"
      : e instanceof QboNotConnected ? "QuickBooks is not connected"
      : (e as Error).message || "QuickBooks push failed";
    try {
      await admin.from("invoice_sends").update({
        qbo_error: String(msg).slice(0, 500),
        updated_at: new Date().toISOString(),
      }).eq("client_id", clientId).eq("short_code", args.shortCode);
    } catch { /* the ledger write itself failed — nothing further to do safely */ }
  }
}
