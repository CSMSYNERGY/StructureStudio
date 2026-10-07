// THE GOLDEN TEST for _shared/emailTemplates.ts (2026-10-04, templates beyond subject and
// opening line). The wording screen grew a closing message, button text and a building photo.
// A builder who never opens that screen must see NO change to any email a customer gets, so
// every document email below is pinned to the exact bytes it produced BEFORE those fields
// existed: a SHA-256 of the subject, the html and the text, taken from the module at e082abd.
//
// Each case is then rendered again with every "nothing saved" shape of the wording (absent, null,
// an empty object, an empty kind, blank fields, the photo switch left on) and with the inputs
// that must not count as a photo (none, http://, data:, a quote mark). All of them must hash to
// the same golden value.
//
// IF THIS FAILS, an email changed for builders who saved nothing. That is either a bug, or a
// deliberate change to the shipped wording, in which case say so in the commit and regenerate:
// run this file with EMAIL_GOLDEN_PRINT=1 against the module you mean to pin, and paste the table
// it prints over GOLDEN below. To see WHAT changed, render the failing case against `git show
// <old commit>:supabase/functions/_shared/emailTemplates.ts` and diff the two.
//
// Dependency-free, like the other _shared tests: no jsr:/npm: imports, no read permission needed.
import {
  acceptanceEmail,
  changeOrderEmail,
  estimateEmail,
  invoiceEmail,
  invoiceRequestEmail,
  testEmail,
  type EmailContent,
} from "./emailTemplates.ts";

// Neutral fixtures (this repo is public): a made-up builder on example domains.
const BIZ = {
  businessName: "Acme Sheds",
  logoUrl: "https://storage.example.com/branding/acme-sheds/logo.png",
  phone: "(555) 555-0100",
  website: "acmesheds.example.com",
  quoteTerms: "50% deposit due on acceptance.\nBalance due on delivery.",
};

const estimateFull = () => ({
  ...BIZ,
  estimateNumber: "EST-2001",
  total: 12345.5,
  styleLabel: "Lofted Barn",
  sizeLabel: "12x24",
  estimateUrl: "https://pay.example.com/estimate/abc123",
  pdfUrl: "https://storage.example.com/floor-plans/acme-sheds/SS-ABC123.pdf",
  formalPdfUrl: "https://storage.example.com/floor-plans/acme-sheds/SS-ABC123-estimate.pdf",
});
const estimateBare = () => ({ businessName: "Acme Sheds", estimateNumber: "EST-2002", total: "$900.00" });
const quoteFull = () => ({
  ...estimateFull(),
  estimateNumber: "AS-1041",
  formalPdfUrl: "https://storage.example.com/floor-plans/acme-sheds/SS-ABC123-quote.pdf",
  docWord: "quote" as const,
});
const quoteNoCta = () => ({ ...quoteFull(), estimateUrl: null, formalPdfUrl: null });
const invoiceView = () => ({
  ...BIZ,
  invoiceNumber: "000012",
  total: "$500.00",
  invoiceUrl: "https://pay.example.com/invoice/xyz789",
});
const invoiceSign = () => ({ ...invoiceView(), signUrl: "https://app.example.com/my-quotes?client=acme-sheds" });
const invoiceBare = () => ({ businessName: "Acme Sheds", invoiceNumber: "000013", total: 0 });

type Case = { kind: "estimate" | "quote" | "invoice" | "other"; render: (extra: Record<string, unknown>) => EmailContent };
const CASES: Record<string, Case> = {
  estimate_full: { kind: "estimate", render: (x) => estimateEmail({ ...estimateFull(), ...x }) },
  estimate_bare: { kind: "estimate", render: (x) => estimateEmail({ ...estimateBare(), ...x }) },
  quote_full: { kind: "quote", render: (x) => estimateEmail({ ...quoteFull(), ...x }) },
  quote_no_cta: { kind: "quote", render: (x) => estimateEmail({ ...quoteNoCta(), ...x }) },
  invoice_view: { kind: "invoice", render: (x) => invoiceEmail({ ...invoiceView(), ...x }) },
  invoice_sign: { kind: "invoice", render: (x) => invoiceEmail({ ...invoiceSign(), ...x }) },
  invoice_bare: { kind: "invoice", render: (x) => invoiceEmail({ ...invoiceBare(), ...x }) },
  // The emails with no wording screen, pinned too: they share the shell, the CTA and the footer.
  change_order: {
    kind: "other",
    render: () => changeOrderEmail({
      ...BIZ, quoteNumber: "AS-1041", coNo: 2, description: "Added: Window x2 ($450.00)\nTotal: $2,800.00 to $3,250.00",
      totalBefore: 2800, totalAfter: 3250, reviewUrl: "https://app.example.com/my-quotes?client=acme-sheds",
    }),
  },
  acceptance_quote: {
    kind: "other",
    render: () => acceptanceEmail({
      ...BIZ, quoteNumber: "AS-1041", total: 12345.5, signerName: "Pat Example",
      acceptedAtIso: "2026-08-23T18:30:00.000Z", pdfUrl: "https://storage.example.com/floor-plans/acme-sheds/SS-ABC123-quote.pdf",
    }),
  },
  acceptance_invoice_click: {
    kind: "other",
    render: () => acceptanceEmail({
      ...BIZ, quoteNumber: "000012", signerName: "Pat Example", acceptedAtIso: "2026-08-23T18:30:00.000Z",
      docWord: "invoice", method: "click",
    }),
  },
  invoice_request: {
    kind: "other",
    render: () => invoiceRequestEmail({
      businessName: "Acme Sheds", quoteNumber: "AS-1041", customerName: "Pat Example", styleLabel: "Lofted Barn",
      sizeLabel: "12x24", total: 10505.14, acceptedAtIso: "2026-09-15T14:03:00.000Z",
      reviewUrl: "https://app.example.com/portal/orders/o-00000000-0000-4000-8000-000000000001",
    }),
  },
  test_email: {
    kind: "other",
    render: () => testEmail({ businessName: "Acme Sheds", fromAddress: "info@acmesheds.example.com", signature: "Pat Lee\nSales" }),
  },
};

// Taken from emailTemplates.ts at e082abd (before closing / button / picture existed).
// quote_full, quote_no_cta, change_order, acceptance_quote and invoice_request were re-pinned on
// 2026-10-06, when every customer-facing "quote" became "estimate" (Carolyn Q12). Nothing else
// moved: every estimate_* and invoice_* row is the e082abd hash, which is the proof that the CRM
// email and the invoice emails did not change.
const GOLDEN: Record<string, [string, string, string]> = {
  estimate_full: ["d50315373453fb73400776399502f30d49afe1013d8fc1796a363ef121905024","ec763a0fe83907cc7cdd258ca6efdd99490dfa844c73b5e7390270a6c431caec","99f91bd0ec84747412abb3195757ebcf564e1cb438951eb92ecdbb49755b5dc0"],
  estimate_bare: ["88cd35c34cc0a6293d6a44bf3757c5e75a996bb1d418a0a1019aadecc481f608","6d2ca04d39f7c494a58d611472185bfa7e0ba74a13f13d262a2725c9890c23a5","e87c6f40471eb6dc67fcfd25f789751542a3b45bb6430dc784feb3b5d82e0e82"],
  quote_full: ["192820e09da05c674695410ea1b99b9872432ccffb62390916eb7253436b931a","0bfd24640ea683bdc73f5525a6bc9c1f4da102912961cd88e94099cc870ffeba","a0135b6e10557f4d9ed7fc71e054688684e231a407a975cd0609b232334bb3e8"],
  quote_no_cta: ["192820e09da05c674695410ea1b99b9872432ccffb62390916eb7253436b931a","871dd2cac117754f95dd90bccf2364e303806032a81497038365f5f9950d956c","7f9b69f53881d167768284080e21d86c32806655596bc252c5d6900733fc099c"],
  invoice_view: ["18de25ab9991abe61c4984568b64ea840016e02f61bf6700c1daa31cdf3e904e","d144b79dfa87eaf3bf976c80942ba76ec5885a994b812d92846e6d8dd81350ad","897616a380c4713d0d42e5d4091385a15da5aab8263547176d4a8887216d513e"],
  invoice_sign: ["b2c1055b703768ad088c7ea7e42356184b390d67a80ef977b9bbab826c95dad1","82cec71d7c91d28dec0dea19769e48d19bd76a7716484918323298c8a189053d","9037cf80e3b583c18188a4c8cb3bbec0abf7ebe0538b6fa21d84182f28266b28"],
  invoice_bare: ["8c75e400936d2c5a7cc27aeed2d0205b12ad8df84be1486c4a3490760c9b664d","93ccb9ef7aeabd42c5f2dbda4d6e4bd5c8281d808b1f9ea6856d714e7650e79e","924ab4d81cdaec74de4e87112fb1615a9bf8d9efae49acbc7611d6c7fc3e986a"],
  change_order: ["87d996bf05b8e53168715a42f2e529c0ace3d18dc63d92e37d2aee2fe47581d2","31f37dcca548509e18ec0c2906bd19fe673e8ca7ea9a2c855161b4011a219460","6895276cb46bc208c5984c00c837f6b671af6962993985600db2f9908b226b88"],
  acceptance_quote: ["21d20397d3a2374cc368f104f2ba885abda803706f63d771a6d71da7124fef0f","8a80ad2ea8f9604c866a46b4b8281910e2ef7017ab24a70f630e63f083c848bc","700c3556f874ba58c87fd6b30e525f2d2d1e2a86b84bf56370573a727540998e"],
  acceptance_invoice_click: ["b2330fff95ec081f6ce7b2c8633f9e9f5a878e6328cfc4a51ed8c369cffc3b5b","51af0d34988b1c0be42a75a8ae9463a7219ab07dcf8da5377a2b3dcd3ea57dd9","aba436db7ec20e1262e04f4ac8a51a13a58a6e0a93fb01d575b959dccc591d85"],
  invoice_request: ["bec92d24ecf157f2dc8307edaf05d47c3877efa66ca550279c185b7e36022fc1","3040bb87db8ff2583f08d32b6c423ef67c34762a30dc31ac8b0fd0fae6354dd7","46e883cea1677384c44e28927c7f9d4f4b3715843d41493492455944fded3fef"],
  test_email: ["169843ef8b8c98a30391e367325692f483f319814dee05fa889e5e87d3d862d8","05704a6ae55b9d6e5ff8c541fbefc87c7a1c77976a0540004b2ecd45ce4f2b81","24698e10736e78854f5d1cb77317d89c1517235b762b5e4f2c69142abde370d5"],
};

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}
const hashes = async (o: EmailContent): Promise<[string, string, string]> =>
  [await sha256(o.subject), await sha256(o.html), await sha256(o.text)];

/** Every "the builder saved nothing" shape for one kind's wording, plus the stray inputs a
 *  sender may pass that must not change a thing: a customer name with no {customer} to fill, and
 *  a photo that is absent or not a usable https:// address. */
function inertExtras(kind: string): Record<string, unknown>[] {
  const blankKind = { subject: "  ", intro: "", closing: " \n\t\r\n ", button: "   ", picture: true };
  const copies: unknown[] = [
    undefined, null, "not an object", 42, {}, { [kind]: null }, { [kind]: {} }, { [kind]: blankKind },
    // Another kind's wording never leaks across.
    Object.fromEntries(["estimate", "quote", "invoice"].filter((k) => k !== kind).map((k) => [k, { subject: "Other", closing: "Other", button: "Other", picture: false }])),
  ];
  const out: Record<string, unknown>[] = copies.map((templateCopy) => ({ templateCopy }));
  out.push({ customerName: "Alex Smith" });
  for (const pictureUrl of [null, "", "http://storage.example.com/branding/acme-sheds/style.jpg", "data:image/png;base64,AAAA", "javascript:alert(1)", "https://", "https://x.example.com/a b.jpg"]) {
    out.push({ pictureUrl });
  }
  return out;
}

Deno.test("golden: with no saved wording every email is byte for byte what it was before closing, button and photo", async () => {
  if (Deno.env.get("EMAIL_GOLDEN_PRINT") === "1") {
    const table: string[] = [];
    for (const [name, c] of Object.entries(CASES)) table.push(`  ${name}: ${JSON.stringify(await hashes(c.render({})))},`);
    console.log("\n" + table.join("\n"));
    return;
  }
  const names = Object.keys(CASES);
  if (names.length !== Object.keys(GOLDEN).length) throw new Error(`GOLDEN has ${Object.keys(GOLDEN).length} rows for ${names.length} cases`);
  const failures: string[] = [];
  for (const name of names) {
    const want = GOLDEN[name];
    if (!want) { failures.push(`${name}: no golden row`); continue; }
    const c = CASES[name];
    const variants = c.kind === "other" ? [{}] : [{}, ...inertExtras(c.kind)];
    for (const extra of variants) {
      const got = await hashes(c.render(extra));
      ["subject", "html", "text"].forEach((part, i) => {
        if (got[i] !== want[i]) failures.push(`${name} ${part} changed with ${JSON.stringify(extra)}`);
      });
    }
  }
  if (failures.length) throw new Error(`${failures.length} golden mismatch(es):\n  ${failures.join("\n  ")}`);
});
