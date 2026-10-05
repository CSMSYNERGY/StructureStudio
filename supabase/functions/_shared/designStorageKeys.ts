// Which floor-plans objects belong to a design, and which of them deleting it may remove
// (moved out of portal-settings and widened, 2026-10-05).
//
// THE BUG. Carolyn's board item "Deleting a design is not deleting the estimate" (filed 08-10).
// The CRM half was fixed on 09-02 and has run on production since. What was still left behind
// was everything a design writes to storage OTHER than its plan PDF, because delete_design only
// ever looked at the image_url columns and only accepted the plan PDF's name shapes:
//   <code>-quote.pdf       the StructureStudio quote (sheet 1 is the formal estimate)
//   <code>-estimate.pdf    the CRM-mode formal estimate
//   <code>-plan-<ts>.jpg   the order screen's picture cards (migration 127), one pair per submit
//   <code>-3d-<ts>.jpg
// All of them are PUBLIC objects. On 10-05 the live bucket held 13 quote PDFs and 33 pictures
// whose design no longer exists, while the delete dialog promised "the saved PDFs" go.
//
// WHY THE FOLDER IS LISTED, not just the stored URLs. A design keeps a pointer to its LATEST
// picture pair only (plan_image_url / view3d_image_url), and only in StructureStudio-invoicing
// mode: the CRM path uploads the pair and never records it. Every resubmit adds a pair. On live,
// most designs with pictures had more of them than any column named, and some had eight with no
// pointer at all. So the tenant's folder is listed for names starting with the code, and every
// name it returns goes through the same yes/no test a stored URL does (designObjectKind below).
// The listing can only ADD names that test accepts; it never widens what the test accepts.
//
// THE RULES, each pinned by designStorageKeys.test.ts:
//   1. A key is removable only if it sits under THIS tenant's prefix and is this design's
//      globally-unique short code followed by one exact, known tail. No other shape, no other
//      code (SS-ABCDEF is a prefix of SS-ABCDEFGH, and the tail test is what tells them apart),
//      no other tenant. The bucket-root era (before per-tenant prefixes) admits only the plan
//      PDF, and only for a row created in that era.
//   2. <code>-invoice.pdf is NEVER removed. It is a live money document (09-02 decision), and
//      the invoice row that points at it outlives the design.
//   3. The quote documents (-quote.pdf, -estimate.pdf) stay once ANY invoice exists, from the CRM
//      or from StructureStudio, because the invoice was made from them (invoiceExists). The CRM
//      estimate keeps its own narrower 09-02 rule (crmInvoiceExists): a StructureStudio invoice
//      is made from the StructureStudio quote, never from an estimate in the CRM.
//   4. The quote document keys are derived from (client_id, short_code), never read from a
//      stored URL, so a design that never recorded ss_quote_pdf_url still loses its quote.
//   5. Best-effort, as before: a listing or storage failure must never make a design
//      undeletable. A failed listing still removes the derived and stored keys. A failed remove
//      is reported as such (quote "failed", removeFailed), never as "there was nothing".

export const FLOOR_PLANS = "floor-plans";
export const OBJECT_PATH = `/storage/v1/object/public/${FLOOR_PLANS}/`;

// The plan PDF's tails: none (the pre-2026-06-15 `<code>.pdf` shape) or submitQuote's
// `-${Date.now()}` suffix. `.png` is history from the same era.
const KEY_TAIL = /^(-[0-9]+)?\.(pdf|png)$/;
// Migration 127's picture cards: `-plan-${Date.now()}.jpg` and `-3d-${Date.now()}.jpg`.
const IMAGE_TAIL = /^-(plan|3d)-[0-9]+\.jpg$/;
const QUOTE_TAIL = "-quote.pdf";
const ESTIMATE_TAIL = "-estimate.pdf";
const INVOICE_TAIL = "-invoice.pdf";

// The bucket-root era — slash-less object names, before per-tenant prefixes. It is CLOSED:
// the newest row referencing one was created 2026-06-12, the first prefixed row 2026-06-15,
// and migration 031's storage INSERT policy now requires a "<slug>/" prefix, so no new root
// object can be created. The date therefore records finished history, not policy. Only a
// design row from that era may name a root object; a row with no parseable created_at is
// treated as newer, which is the safe direction.
export const LEGACY_ROOT_ERA_END = Date.parse("2026-06-14T00:00:00Z");

// One page of the tenant folder, filtered by the code. Storage treats `search` as a name
// prefix, so this returns this design's files plus any longer code that starts with this one.
// A design with a thousand files does not exist; if one ever does, the rest stay behind as
// they did before this change, and the derived keys still go.
const LIST_LIMIT = 1000;

/** Object key from a stored public URL, or null if it is not one of our floor-plan URLs. */
export function floorPlanKey(u: unknown): string | null {
  if (typeof u !== "string" || !u) return null;
  let path: string;
  try { path = new URL(u.trim()).pathname; } catch { return null; } // not a URL at all
  if (!path.startsWith(OBJECT_PATH)) return null;
  const key = path.slice(OBJECT_PATH.length);
  // Percent-escapes are REJECTED, never decoded: decodeURIComponent throws on a lone "%",
  // withErrorLog would turn that into a 500, and the design would become undeletable.
  // Nothing legitimate needs them — the code alphabet is [A-HJ-NP-Z2-9] and the tail is
  // digits. new URL() has already resolved any "../" and dropped query/fragment.
  // Only the PATH is pinned, deliberately not the host: the key is checked against
  // server-derived values below, so an off-host URL can still only name this design's own
  // object, whereas anchoring on SUPABASE_URL would reject every row under
  // `functions serve` or behind a future storage CDN and silently orphan every file.
  return key && key.length <= 300 && !key.includes("%") ? key : null;
}

export type DesignObjectKind = "plan" | "image" | "quote" | "estimate" | "invoice";

/** What `key` is, if THIS design's own uploads could have produced it; null otherwise. Both
 *  inputs are server-resolved and neither is ever read from the request body. shortCode comes
 *  from the matched row, and designs.short_code is globally UNIQUE (designs_short_code_key), so
 *  it names at most one design anywhere — that uniqueness IS the authorization test here, not
 *  the date gate above. clientId is the resolved tenant slug: straight from client_users on the
 *  ordinary owner/admin path, assertClient-validated only on the operator-override path. So it
 *  is NOT shape-guaranteed here and must not need to be — plain string ops only, and no RegExp
 *  is ever built from either value, which is what keeps this correct whatever a slug contains. */
export function designObjectKind(key: string, clientId: string, shortCode: string, legacyOk: boolean): DesignObjectKind | null {
  if (typeof key !== "string" || !clientId || !shortCode) return null;
  let name = key;
  let rooted = false;
  if (key.startsWith(`${clientId}/`)) name = key.slice(clientId.length + 1);
  // Another tenant's prefix, or a root object this row is too new to have created.
  else if (key.includes("/") || !legacyOk) return null;
  else rooted = true;
  if (!name.startsWith(shortCode)) return null;
  const tail = name.slice(shortCode.length);
  if (KEY_TAIL.test(tail)) return "plan";
  // Every other shape postdates per-tenant prefixes, so a root object is never one of them.
  if (rooted) return null;
  if (IMAGE_TAIL.test(tail)) return "image";
  if (tail === QUOTE_TAIL) return "quote";
  if (tail === ESTIMATE_TAIL) return "estimate";
  if (tail === INVOICE_TAIL) return "invoice";
  return null;
}

/** The plan PDF test delete_inventory still uses for an inventory master's files. */
export function isOwnFloorPlanKey(key: string, clientId: string, shortCode: string, legacyOk: boolean): boolean {
  return designObjectKind(key, clientId, shortCode, legacyOk) === "plan";
}

/** One of this design's picture cards. Never a root object: the cards postdate the prefixes. */
export function isOwnDesignImageKey(key: string, clientId: string, shortCode: string): boolean {
  return designObjectKind(key, clientId, shortCode, false) === "image";
}

/** The quote documents' fixed paths, derived from the row and never from a stored URL. */
export function quoteDocumentKeys(clientId: string, shortCode: string): string[] {
  return [`${clientId}/${shortCode}${QUOTE_TAIL}`, `${clientId}/${shortCode}${ESTIMATE_TAIL}`];
}

/** The invoice_sends columns the gate reads. */
export type InvoiceLedgerRow = {
  invoice_id?: unknown;
  invoice_number?: unknown;
  invoice_pdf_url?: unknown;
  status?: unknown;
} | null | undefined;

/** Has an invoice been made from this design? The gate for the quote documents in storage, so an
 *  accepted-then-invoiced quote keeps them. (The CRM estimate has its own gate below.)
 *
 *  status alone is not enough, in either mode. A CRM invoice is proven by the ledger's invoice_id
 *  (status is a cached projection that sync-design-status can downgrade on a CRM blip). A
 *  StructureStudio invoice has NO invoice_id: it carries invoice_number and invoice_pdf_url, and
 *  since migration 136 sending one leaves the design 'accepted' with ss_invoice_sent_at set. On
 *  10-05 six live designs with a StructureStudio invoice read 'accepted', so a gate of
 *  `invoice_id || invoiced/delivered` would have deleted the quote those invoices were made from.
 *  A 'claimed' or 'failed' ledger row with nothing created on it is not an invoice. */
export function invoiceExists(status: unknown, inv: InvoiceLedgerRow, ssInvoiceSentAt: unknown): boolean {
  const st = String(status ?? "");
  if (st === "invoiced" || st === "delivered") return true;
  if (ssInvoiceSentAt) return true;
  if (!inv) return false;
  if (inv.invoice_id || inv.invoice_number || inv.invoice_pdf_url) return true;
  return inv.status === "created" || inv.status === "sent";
}

/** Has the CRM made an invoice from this design's CRM estimate? The gate for deleting that
 *  estimate, unchanged since 09-02: the ledger's invoice_id (the durable fact, since status can be
 *  downgraded by sync-design-status on a CRM blip), or status invoiced/delivered.
 *
 *  Deliberately NOT invoiceExists. A design can carry a CRM estimate from before its tenant
 *  switched to StructureStudio paperwork and then get a StructureStudio invoice (one such design
 *  was live on 10-05). That invoice was made from the StructureStudio quote, so there is no CRM
 *  invoice to void. Keeping the estimate would leave it in the CRM with nothing pointing at it
 *  once the design row is gone, and tell the builder to void an invoice that does not exist. */
export function crmInvoiceExists(status: unknown, inv: InvoiceLedgerRow): boolean {
  const st = String(status ?? "");
  return st === "invoiced" || st === "delivered" || Boolean(inv?.invoice_id);
}

export type DesignObjectPlan = {
  /** Keys to hand to storage.remove(). */
  remove: string[];
  /** Which of `remove` are the quote documents, to report whether one really went. */
  quoteKeys: string[];
  /** Distinct stored values we declined to act on (capped at 300 characters each). */
  refused: string[];
  /** The namespaces those named, slug-shaped only, for triage. */
  namespaces: string[];
  /** A quote document exists and the invoice gate kept it. */
  quoteKept: boolean;
  /** A quote document is known to exist: the row records one, or a stored or listed key names one. */
  quoteFound: boolean;
};

/** Pure: what to remove for one design, from the stored URLs and the folder listing. */
export function planDesignObjectRemoval(input: {
  clientId: string;
  shortCode: string;
  legacyOk: boolean;
  invoiced: boolean;
  /** Caller-influenced: the design's and every version's image_url, plan_image_url, view3d_image_url. */
  storedUrls: unknown[];
  /** Names the folder listing returned (relative to the tenant folder). */
  listed: string[];
  /** designs.ss_quote_pdf_url is set (server-written), so a quote document exists. */
  hasQuoteDoc: boolean;
}): DesignObjectPlan {
  const { clientId, shortCode, legacyOk, invoiced } = input;
  const remove = new Set<string>();
  const quoteKeys = new Set<string>();
  const refused = new Set<string>();
  const namespaces = new Set<string>();
  let quoteSeen = input.hasQuoteDoc;

  const take = (key: string, kind: DesignObjectKind) => {
    if (kind === "plan" || kind === "image") { remove.add(key); return; }
    if (kind === "quote" || kind === "estimate") {
      quoteSeen = true;
      if (!invoiced) { remove.add(key); quoteKeys.add(key); }
      return;
    }
    // "invoice": never. The rule is here, in the one place every key passes through.
  };

  for (const u of input.storedUrls) {
    if (!u) continue; // drafts carry no PDF
    const key = floorPlanKey(u);
    const kind = key ? designObjectKind(key, clientId, shortCode, legacyOk) : null;
    if (key && kind) { take(key, kind); continue; }
    refused.add(String(u).slice(0, 300));
    // Only the namespace, and only if it is slug-SHAPED: a real cross-tenant plant names a
    // real slug. Anything else is caller-authored free text, and app_errors is shapes and
    // counts — not a place to let a caller choose what an operator reads.
    const slash = key ? key.indexOf("/") : -1;
    if (key && slash > 0 && !key.startsWith(`${clientId}/`)) {
      const ns = key.slice(0, slash);
      namespaces.add(/^[a-z0-9][a-z0-9-]{0,63}$/.test(ns) ? ns : "(non-slug)");
    }
  }

  // A listed name that fails the test is a longer code sharing this prefix, or a shape no
  // uploader of ours produces. Either way it is not this design's to remove, and it is not a
  // planted value either (storage named it, not a caller), so it is left without a log row.
  for (const name of input.listed) {
    if (typeof name !== "string" || !name || name.includes("/")) continue;
    const key = `${clientId}/${name}`;
    const kind = designObjectKind(key, clientId, shortCode, false);
    if (kind) take(key, kind);
  }

  if (!invoiced) {
    for (const key of quoteDocumentKeys(clientId, shortCode)) { remove.add(key); quoteKeys.add(key); }
  }

  return {
    remove: [...remove],
    quoteKeys: [...quoteKeys],
    refused: [...refused],
    namespaces: [...namespaces],
    quoteKept: invoiced && quoteSeen,
    quoteFound: quoteSeen,
  };
}

/** The slice of a Storage client this needs. admin.storage satisfies it. */
export type FloorPlanStorage = {
  from(bucket: string): {
    list(
      path?: string,
      options?: { limit?: number; offset?: number; search?: string; sortBy?: { column?: string; order?: string } },
    ): Promise<{ data: { name: string }[] | null; error: unknown }>;
    remove(paths: string[]): Promise<{ data: { name: string }[] | null; error: unknown }>;
  };
};

export type DesignObjectOutcome = {
  /** What storage actually removed. remove() does not error on a key that isn't there. */
  filesRemoved: number;
  refused: string[];
  namespaces: string[];
  /** removed: a quote document really went; kept: the invoice gate kept one; failed: the remove
   *  call failed with the quote documents in it, so one may still be there; none: there was none. */
  quote: "removed" | "kept" | "failed" | "none";
  /** The folder listing failed, so only stored and derived keys were tried. */
  listFailed: boolean;
  /** storage.remove() errored or threw, so every one of `planned` keys may still be there. */
  removeFailed: boolean;
  /** How many keys were handed to storage.remove(). */
  planned: number;
};

/** List, plan, remove. Never throws: every failure degrades to removing less. */
export async function removeDesignObjects(storage: FloorPlanStorage, input: {
  clientId: string;
  shortCode: string;
  legacyOk: boolean;
  invoiced: boolean;
  storedUrls: unknown[];
  hasQuoteDoc: boolean;
}): Promise<DesignObjectOutcome> {
  let listed: string[] = [];
  let listFailed = false;
  try {
    const { data, error } = await storage.from(FLOOR_PLANS).list(input.clientId, {
      search: input.shortCode, limit: LIST_LIMIT, sortBy: { column: "name", order: "asc" },
    });
    if (error) listFailed = true;
    else listed = (data ?? []).map((o) => String(o?.name ?? "")).filter(Boolean);
  } catch {
    listFailed = true;
  }

  const plan = planDesignObjectRemoval({ ...input, listed });

  let removed: string[] = [];
  let removeFailed = false;
  if (plan.remove.length) {
    try {
      const rm = await storage.from(FLOOR_PLANS).remove(plan.remove);
      if (rm.error) removeFailed = true;
      else removed = (rm.data ?? []).map((o) => String(o?.name ?? ""));
    } catch {
      removeFailed = true;
    }
  }

  // After a failed remove, "none" would read exactly like "there was no quote" while the public
  // PDF is still there. So it is "failed" unless a working listing and the row together show
  // there never was a quote document: the derived keys are in every uninvoiced plan, which is
  // why their presence alone proves nothing.
  const quote = plan.quoteKept ? "kept"
    : plan.quoteKeys.some((k) => removed.includes(k)) ? "removed"
    : removeFailed && plan.quoteKeys.length && (plan.quoteFound || listFailed) ? "failed"
    : "none";
  return {
    filesRemoved: removed.length, refused: plan.refused, namespaces: plan.namespaces, quote, listFailed,
    removeFailed, planned: plan.remove.length,
  };
}
