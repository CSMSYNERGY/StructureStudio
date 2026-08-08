// What KIND of sale an invoice represents, and therefore how the building reaches the
// customer. Carolyn 2026-08-07: "every INVOICE needs a TYPE."
//
// WHERE AN INVOICE ACTUALLY IS. There is no invoices table in this product. The invoice
// object lives in GoHighLevel — send_invoice converts an accepted estimate into one — and is
// mirrored into QuickBooks by _shared/qboInvoice.ts. Our side keeps a ledger row in
// invoice_sends, one per (client_id, short_code). That row IS the invoice as far as this
// system is concerned, so that is where the type is stamped (migration 102).
//
// IT IS A SNAPSHOT, NOT A LOOKUP. The type is computed once, when the invoice is raised, and
// stored. Untying a design from its unit afterwards must not retroactively change the type of
// an invoice that has already gone to a customer and into their books — the same reasoning
// that gave build_jobs its own appearance columns in migration 093.
//
// WHAT IT DRIVES. An `inventory` invoice SKIPS THE BUILD SCHEDULE: the building already
// exists (or is already being built as a spec unit), so the buyer's order must never spawn a
// second, new-build job. The unit's own source='inventory' job, if it has one, carries on
// untouched — a building sold before it is finished still has to be finished. See
// portal-schedule's create_job guard and the tray query it backs up.

export const INVOICE_TYPES = ["new_build", "inventory", "repair"] as const;
export type InvoiceType = typeof INVOICE_TYPES[number];

export const INVOICE_TYPE_LABEL: Record<InvoiceType, string> = {
  new_build: "New build",
  inventory: "Inventory",
  repair: "Repair",
};

/**
 * Classify the design an invoice is being raised against.
 *
 * `repair` is in the vocabulary but nothing returns it yet, deliberately: repairs today have
 * no design and no estimate, so they never reach send_invoice at all (repair invoicing is
 * listed as out of scope in SCHEDULING_SCOPE.md). Reserving the value costs one CHECK entry
 * now and saves migrating live financial rows when repair invoicing ships. Until then, do not
 * offer Repair as a filter option anywhere — a type nothing can produce reads as a broken
 * filter, not a coming feature.
 */
export function invoiceTypeFor(d: { inventory_unit_id?: string | null } | null | undefined): InvoiceType {
  return d && d.inventory_unit_id ? "inventory" : "new_build";
}

export function isInvoiceType(v: unknown): v is InvoiceType {
  return typeof v === "string" && (INVOICE_TYPES as readonly string[]).includes(v);
}
