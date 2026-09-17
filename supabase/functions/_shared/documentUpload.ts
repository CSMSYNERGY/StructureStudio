// How a customer document that is REPLACED IN PLACE is uploaded (review, 2026-09-17).
//
// THE DOCUMENTS. The StructureStudio quote and invoice PDFs each live at one fixed path,
// floor-plans/<client>/<code>-quote.pdf and <code>-invoice.pdf, and every link to them is the same
// bare public URL: designs.ss_quote_pdf_url, invoice_sends.invoice_pdf_url, the links in the quote
// and invoice emails, and the URLs the portal hands back. A re-price (the Verify button, a sales-
// location change, a resubmit, a change order), a reissue and a countersignature all overwrite
// that one object.
//
// WHAT WENT WRONG. storage-js uploads with cacheControl "3600" unless told otherwise, and Storage
// serves the object with `Cache-Control: max-age=3600`. A browser that opened the quote at 10:00
// kept that copy until 11:00 without asking again, and a CDN in front of Storage may too. Staff
// re-price at 10:20, the PDF is rebuilt and the updated-quote email goes out naming the new total,
// and the customer clicks its link and is shown the 10:00 document with the old total. The write
// ordering in quoteWriteRace.ts makes the stored object print the final row; the cache made that
// true only at the origin. customer-accept's countersign fetches the document over that same public
// URL, so a CDN copy there would put the signature page on the superseded document.
//
// THE RULE. Every upload to one of those paths passes FIXED_PATH_PDF_UPLOAD: max-age=0, so each
// open revalidates (a 304 on the ETag when nothing changed, the new bytes when something did).
// The stored URLs stay bare on purpose: customer-accept slices the storage path out of
// ss_quote_pdf_url, and a version query would land inside it.
//
// THE ONE GAP LEFT is the rollout. A copy fetched from an object uploaded BEFORE this rule carries
// the old max-age, so it can be served for up to an hour from that fetch, even across a rewrite.
// Every copy of an object written since is clean.
//
// Storage-js writes this value as `cache-control: max-age=<value>` for a byte body, which is why
// it is "0" and not "no-cache" (that would send `max-age=no-cache`, which caches ignore).
//
// The GHL-mode formal estimate (<code>-estimate.pdf) is not one of these on purpose: GHL-mode
// tenants see no change from this work. documentUpload.test.ts drives the real supabase-js to
// prove the header; _test_stubs/documentUploadWiring_test.ts pins every shipped upload call.

export const FIXED_PATH_PDF_UPLOAD = Object.freeze({
  contentType: "application/pdf",
  upsert: true,
  cacheControl: "0",
});
