// Numbers from the Real-Time Pricing WORKBOOK upload (portal-settings import_rtp_workbook).
//
// The browser parses each cell with rtpNum, which yields NaN for anything that is not a number
// ("TBD", "x1.8", "1.8x", an Excel error) — and JSON.stringify(NaN) is `null`, which Number()
// turns into 0. So the server's `!Number.isFinite(...)` guard never saw a bad cell: a
// non-numeric unit cost was stored as a $0 material, and a non-numeric MULTIPLIER as ×0, which
// rtp_compute_prices applies as `running := running * value` — every building's computed price
// became $0, and rtpApply writes it into building_sizes.base_price at once when the tenant is
// live (0 = "included/free" under the NULL-base-price contract, so every size quotes $0).
// The manual editors refuse NaN in the browser before sending; only the workbook path lacked it.

/** A workbook number, with null / undefined / blank read as NOT A NUMBER instead of 0. */
export function rtpImportNumber(v: unknown): number {
  if (v == null) return NaN;
  if (typeof v === "string" && v.trim() === "") return NaN;
  return Number(v);
}

export type RtpOverheadRow = { label: string; kind: string; value: number; sort_order: number };

/**
 * Validate the Overhead sheet. The lines are ONE formula applied in order, so it is all or
 * nothing: any bad line means the sheet is not applied at all (the caller keeps the current
 * lines). Dropping a single bad line instead would silently remove a markup from every price.
 * A ×0 multiplier is refused outright — it can only ever zero every price.
 */
export function rtpImportOverhead(lines: unknown[]): { rows: RtpOverheadRow[]; invalid: string[] } {
  const KINDS = new Set(["multiplier", "percent_of_price", "flat"]);
  const rows: RtpOverheadRow[] = [];
  const invalid: string[] = [];
  for (const [i, ln] of lines.entries()) {
    const l = (ln ?? {}) as { label?: unknown; kind?: unknown; value?: unknown };
    const label = String(l.label ?? "").trim();
    const kind = String(l.kind ?? "");
    const value = rtpImportNumber(l.value);
    if (!label || !KINDS.has(kind) || !Number.isFinite(value) || value < 0 || (kind === "multiplier" && value === 0)) {
      invalid.push(`overhead line ${i + 1}${label ? ` ("${label}")` : ""}: ${kind === "multiplier" && value === 0 ? "a ×0 multiplier would make every price $0" : "invalid"}`);
      continue;
    }
    rows.push({ label, kind, value, sort_order: i });
  }
  return { rows, invalid };
}
