// _shared/cardpointe.ts — the Fiserv CardPointe gateway client.
//
// Sibling of _shared/nmi.ts, deliberately: that module is the ONE definition of what "we
// don't know what happened" means for the Deposyt/NMI subscription path, and this is the
// same idea for the CardPointe invoice-payment path. Two different processors, two money
// flows that must never be conflated:
//
//   NMI/Deposyt  builders paying CSM Synergy for the platform      (portal-billing, 050)
//   CardPointe   shed shoppers paying THEIR BUILDER for a building (174)
//
// Different merchants of record. A change here is not a reason to touch nmi.ts.
//
// ⚠️ Duplication ledger — the "GATEWAY_UNKNOWN:" prefix is SHARED VOCABULARY with
//    _shared/nmi.ts and is duplicated rather than extracted. Extracting it is tidier and
//    strictly riskier: it would edit a live money path to buy neatness and force
//    portal-billing, portal-settings and every payment function to redeploy in lockstep on
//    any change to either gateway (_shared bundles PER function). The agreement between
//    the two is pinned by a test case in cardpointe.test.ts, not by this comment.
//    Importers: _shared/invoicePayment.ts, customer-pay/index.ts, portal-payments/index.ts
//
// ── WHY THIS NEEDS MORE FAILURE CLASSES THAN nmi.ts ────────────────────────────────
// nmi.ts splits two ways (decline = known-not-charged, transport = unknown). A JSON/HTTP
// gateway carries information a form-encoded one cannot, and three of the branches below
// are ones NMI structurally cannot have. Every row was chosen against a live UAT response
// captured 2026-09-01, not from the documentation:
//
//   fetch rejects / HTTP >= 500        UNKNOWN    same as NMI
//   HTTP 200 but JSON.parse throws     UNKNOWN    URLSearchParams NEVER throws, so form
//                                                 parsing has no failure mode. A truncated
//                                                 body from a connection dropped mid-stream
//                                                 is a 200 whose card may well be charged.
//   200, valid JSON, no respstat       UNKNOWN    UAT shuffles field order and injects
//                                                 dummy fields; missing is not "no".
//   respstat "A" with no retref        UNKNOWN    an approval we cannot reference is one we
//                                                 can never void, refund or inquire on.
//                                                 That is the definition of unverifiable.
//   respstat "B"                       UNKNOWN    see the note on retries below.
//   429 WITH the documented header     THROTTLED  known: not charged.
//   429 without it                     UNKNOWN    not provably the documented limiter.
//   401 / 403 / 4xx with an error body CONFIG     our credentials or our bad request —
//                                                 never shown to a customer as a decline.
//   respstat "C"                       DECLINE    the gateway answered and said no.
//   respstat "A", amount < requested   PARTIAL    returned, not thrown — see below.
//   respstat "A", amounts agree        APPROVED
//
// ⚠️ respstat "B" IS TREATED AS UNKNOWN, and it is the most consequential call in this
//    file. Fiserv's own guidance is "retry later", and some B responses genuinely are
//    "host unavailable, nothing happened". Others are a downstream processor timeout where
//    the processor may have authorized and the gateway never heard. respstat alone cannot
//    tell them apart, and /auth accepts no idempotency key — so auto-retrying a B is a
//    double-charge machine. The cost of the safe reading is an occasionally blocked order,
//    and inquireByOrderId() resolves nearly all of those in seconds because the orderid is
//    minted before the card is touched. That trade is why this is not a retry.
//
// ⚠️ FIELD NAMES ARE READ BY NAME, NEVER BY POSITION, and this is not a style preference.
//    On 2026-09-01 one live transaction returned `respproc: "RPCT"` from /auth and
//    `respproc: "PPS"` from the /void of that same transaction, and the testing guide's own
//    sample calls the field `cardproc`. Two names in the docs, two values across one
//    transaction. Written from the documentation alone this would have been a silent
//    wrong-field bug.

const RAW_BASE = Deno.env.get("CARDPOINTE_BASE_URL") || "";
export const CP_BASE = RAW_BASE.replace(/\/+$/, "");
const API_USER = Deno.env.get("CARDPOINTE_API_USER") || "";
const API_PASS = Deno.env.get("CARDPOINTE_API_PASS") || "";
export const CP_DEFAULT_MERCHID = Deno.env.get("CARDPOINTE_MERCHID") || "";
export const CP_TOKENIZER_BASE = Deno.env.get("CARDPOINTE_TOKENIZER_BASE") || "";

/** Whether this deployment can move money at all. All-or-nothing, the nmiConfigured rule:
 *  a tokenizer base without API credentials mints tokens nobody can charge, and credentials
 *  without a tokenizer base cannot collect an instrument in the first place. */
export const cardpointeConfigured = Boolean(
  CP_BASE && API_USER && API_PASS && CP_DEFAULT_MERCHID && CP_TOKENIZER_BASE,
);

const GATEWAY_UNKNOWN = "GATEWAY_UNKNOWN:";
const GATEWAY_THROTTLED = "GATEWAY_THROTTLED:";
const GATEWAY_CONFIG = "GATEWAY_CONFIG:";

export function isGatewayUnknown(e: unknown): boolean {
  return String((e as Error)?.message ?? "").startsWith(GATEWAY_UNKNOWN);
}
export function isGatewayThrottled(e: unknown): boolean {
  return String((e as Error)?.message ?? "").startsWith(GATEWAY_THROTTLED);
}
export function isGatewayConfig(e: unknown): boolean {
  return String((e as Error)?.message ?? "").startsWith(GATEWAY_CONFIG);
}

/** Seconds the limiter says to wait, when it told us. 0 when it did not. */
export function throttledRetryAfter(e: unknown): number {
  const m = /retry after (\d+)/i.exec(String((e as Error)?.message ?? ""));
  return m ? Number(m[1]) : 0;
}

/** Cents -> the gateway's decimal string. THE ONE cents/dollars boundary in this feature;
 *  nothing else converts, in this module or in any caller. */
export function cpAmount(cents: number): string {
  return (Math.round(cents) / 100).toFixed(2);
}

/** The gateway's decimal string -> cents. Rounded, because 6.00/0.01 style values arrive
 *  as strings and parseFloat can land a hair under. */
export function cpCents(amount: unknown): number | null {
  const n = typeof amount === "number" ? amount : parseFloat(String(amount ?? ""));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** Whitelist-REBUILD of a gateway response for logging — the styleD3.ts posture, not a
 *  blacklist. `account`, `token`, `expiry`, `cvv2` and `profile` can never leave this
 *  module by accident, because nothing copies them into the result. */
export function cpSummary(raw: unknown): Record<string, unknown> {
  const r = (raw ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (
    const k of [
      "respstat", "respcode", "resptext", "retref", "amount", "authcode",
      "avsresp", "cvvresp", "respproc", "cardproc", "entrymode", "commcard",
      "merchid", "orderid", "orderId", "setlstat", "batchid",
    ]
  ) {
    if (r[k] !== undefined) out[k] = r[k];
  }
  return out;
}

export type CpApproved = {
  kind: "approved";
  retref: string;
  amountCents: number;
  surchargeCents: number | null;
  token: string | null;
  brand: string | null;
  last4: string | null;
  authcode: string | null;
  avsresp: string | null;
  cvvresp: string | null;
  entrymode: string | null;
  respproc: string | null;
  raw: Record<string, unknown>;
};

export type CpPartial = {
  kind: "partial";
  retref: string;
  approvedCents: number;
  requestedCents: number;
  raw: Record<string, unknown>;
};

export type CpAuthResult = CpApproved | CpPartial;

function authHeader(): string {
  return "Basic " + btoa(`${API_USER}:${API_PASS}`);
}

/** One request. Classifies transport and HTTP; does NOT look at respstat — that is the
 *  caller's job, because only the caller knows what it asked for. */
async function cpPost(
  method: "PUT" | "POST" | "GET",
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  if (!cardpointeConfigured) {
    throw new Error(`${GATEWAY_CONFIG} CardPointe is not configured for this deployment`);
  }
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${CP_BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "Authorization": authHeader() },
      body: body === undefined ? undefined : JSON.stringify(body),
      // A redirect off the payment host is not something to follow.
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    // DNS, reset, TLS, timeout — the request may have been processed and we never heard.
    throw new Error(`${GATEWAY_UNKNOWN} ${(e as Error).message}`);
  }

  if (res.status === 429) {
    const secs = res.headers.get("X-Rate-Limit-Retry-After-Seconds");
    if (secs) {
      // The DOCUMENTED limiter sits upstream of the processor and rejects rather than
      // queues, so this is KNOWN-not-charged. Reading it as unknown would brick a tenant
      // the first time a busy minute crosses the cap.
      throw new Error(`${GATEWAY_THROTTLED} rate limited, retry after ${secs} seconds`);
    }
    throw new Error(`${GATEWAY_UNKNOWN} HTTP 429 with no rate-limit header`);
  }
  if (res.status >= 500) {
    throw new Error(`${GATEWAY_UNKNOWN} gateway returned HTTP ${res.status}`);
  }

  try {
    text = await res.text();
  } catch (e) {
    throw new Error(`${GATEWAY_UNKNOWN} response body could not be read: ${(e as Error).message}`);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // THE BRANCH nmi.ts CANNOT HAVE. A 200 we cannot parse is a transaction we cannot
    // account for — never a decline.
    if (res.status >= 400) {
      throw new Error(`${GATEWAY_CONFIG} HTTP ${res.status} with an unparseable body`);
    }
    throw new Error(`${GATEWAY_UNKNOWN} HTTP ${res.status} body did not parse as JSON`);
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error(`${GATEWAY_CONFIG} HTTP ${res.status} — check the API credentials`);
  }
  if (res.status >= 400) {
    throw new Error(`${GATEWAY_CONFIG} HTTP ${res.status} ${String(parsed.resptext ?? "bad request")}`);
  }
  return parsed;
}

/** Read respstat, or refuse to guess. */
function requireRespstat(j: Record<string, unknown>): string {
  const s = typeof j.respstat === "string" ? j.respstat.toUpperCase() : "";
  if (!s) throw new Error(`${GATEWAY_UNKNOWN} response carried no respstat`);
  return s;
}

export type CpAuthRequest = {
  merchid: string;
  amountCents: number;
  /** A CardSecure token from the iFrame tokenizer, OR raw encrypted track data from the
   *  VP3350 reader. The gateway takes either in `account`, which is exactly why the reader
   *  needs no separate integration. */
  account: string;
  expiry?: string;
  orderid: string;
  postal?: string;
  name?: string;
  /** "E" e-commerce (customer paying online) or "R" retail (card present at the counter). */
  ecomind?: "E" | "R";
  /** ACH needs the routing/account form and its own MID; the gateway auto-captures it. */
  rail?: "card" | "ach";
};

/**
 * Authorize AND capture in one call (`capture: "Y"`).
 *
 * A sale rather than auth-then-capture, deliberately: the builder is being paid down a
 * real balance, there is no fulfilment delay to model, and an auth-only flow needs a
 * capture sweep — which this project has no scheduler inside the database to run. The
 * cost is that unwinding depends on /void pre-settlement with /refund as the fallback,
 * which is exactly the ladder portal-billing already uses for NMI.
 *
 * Throws on decline, unknown, throttled and config. Returns on approved and PARTIAL.
 */
export async function cpAuth(req: CpAuthRequest): Promise<CpAuthResult> {
  const body: Record<string, unknown> = {
    merchid: req.merchid,
    account: req.account,
    amount: cpAmount(req.amountCents),
    currency: "USD",
    orderid: req.orderid,
    capture: "Y",
    ecomind: req.ecomind ?? "E",
  };
  if (req.expiry) body.expiry = req.expiry;
  if (req.postal) body.postal = req.postal;
  if (req.name) body.name = req.name;
  if (req.rail === "ach") body.accttype = "ECHK";

  const j = await cpPost("PUT", "/auth", body);
  const stat = requireRespstat(j);

  if (stat === "C") {
    const text = String(j.resptext ?? "").trim() || "The card was declined.";
    throw new Error(text);
  }
  if (stat === "B") {
    // Documented as "retry" and treated as UNKNOWN. See the header.
    throw new Error(
      `${GATEWAY_UNKNOWN} gateway answered respstat B (retry) — the outcome is not knowable from this response`,
    );
  }
  if (stat !== "A") {
    throw new Error(`${GATEWAY_UNKNOWN} unrecognised respstat "${stat}"`);
  }

  const retref = typeof j.retref === "string" ? j.retref.trim() : "";
  if (!retref) {
    throw new Error(`${GATEWAY_UNKNOWN} approved with no retref — the charge cannot be referenced`);
  }

  const approvedCents = cpCents(j.amount);
  if (approvedCents === null) {
    throw new Error(`${GATEWAY_UNKNOWN} approved with an unreadable amount "${String(j.amount)}"`);
  }

  // Fiserv adds the surcharge itself when the merchant has it enabled and the card is
  // credit, then reports it back. So an approved amount ABOVE what we asked for is the
  // surcharge, not a discrepancy — and one BELOW is a partial approval.
  if (approvedCents > req.amountCents) {
    const surcharge = approvedCents - req.amountCents;
    return {
      kind: "approved",
      retref,
      amountCents: req.amountCents,
      surchargeCents: surcharge,
      token: typeof j.token === "string" ? j.token : null,
      brand: readBrand(j),
      last4: readLast4(j),
      authcode: typeof j.authcode === "string" ? j.authcode : null,
      avsresp: typeof j.avsresp === "string" ? j.avsresp : null,
      cvvresp: typeof j.cvvresp === "string" ? j.cvvresp : null,
      entrymode: typeof j.entrymode === "string" ? j.entrymode : null,
      respproc: typeof j.respproc === "string" ? j.respproc : (typeof j.cardproc === "string" ? j.cardproc : null),
      raw: j,
    };
  }

  if (approvedCents < req.amountCents) {
    // NEITHER an approval nor a decline. It takes some of the customer's money without
    // satisfying the ask, and a bare `respstat === "A"` check reads it as paid in full.
    // Returned rather than thrown so the caller can void it — voiding is a money movement
    // and belongs in the choreography, not in the transport layer.
    return { kind: "partial", retref, approvedCents, requestedCents: req.amountCents, raw: j };
  }

  return {
    kind: "approved",
    retref,
    amountCents: approvedCents,
    surchargeCents: null,
    token: typeof j.token === "string" ? j.token : null,
    brand: readBrand(j),
    last4: readLast4(j),
    authcode: typeof j.authcode === "string" ? j.authcode : null,
    avsresp: typeof j.avsresp === "string" ? j.avsresp : null,
    cvvresp: typeof j.cvvresp === "string" ? j.cvvresp : null,
    entrymode: typeof j.entrymode === "string" ? j.entrymode : null,
    respproc: typeof j.respproc === "string" ? j.respproc : (typeof j.cardproc === "string" ? j.cardproc : null),
    raw: j,
  };
}

/** Brand, from whichever field this endpoint chose to use. */
function readBrand(j: Record<string, unknown>): string | null {
  for (const k of ["binttype", "bintype", "cardtype", "binType"]) {
    const v = j[k];
    if (typeof v === "string" && v.trim()) return v.trim().toUpperCase().slice(0, 24);
  }
  return null;
}

/** Last four, taken from the TOKEN — CardSecure tokens preserve the PAN's last four, and
 *  the token is not sensitive. Never from a PAN, which never reaches us. */
function readLast4(j: Record<string, unknown>): string | null {
  for (const k of ["token", "account"]) {
    const v = j[k];
    if (typeof v === "string" && /^\d{8,}$/.test(v)) return v.slice(-4);
  }
  return null;
}

/** Release an authorization that has not settled. Cheap, and always tried before a refund. */
export async function cpVoid(merchid: string, retref: string): Promise<boolean> {
  const j = await cpPost("PUT", "/void", { merchid, retref });
  return requireRespstat(j) === "A";
}

/** Return money on a SETTLED transaction. A refund is a new event, never a mutation of the
 *  original — the original settled and the books have to show both. */
export async function cpRefund(
  merchid: string,
  retref: string,
  amountCents: number,
): Promise<{ ok: boolean; retref: string | null; raw: Record<string, unknown> }> {
  const j = await cpPost("PUT", "/refund", { merchid, retref, amount: cpAmount(amountCents) });
  const ok = requireRespstat(j) === "A";
  return { ok, retref: typeof j.retref === "string" ? j.retref : null, raw: j };
}

/**
 * "Did that charge actually happen?" — the recovery call, and the reason `orderid` is
 * minted before the attempt row is written. Resolves a closed_unknown without a phone call.
 * Returns null when the gateway has no record, which means nothing was charged.
 */
export async function cpInquireByOrderId(
  merchid: string,
  orderid: string,
): Promise<Record<string, unknown> | null> {
  const j = await cpPost("GET", `/inquireByOrderid/${encodeURIComponent(orderid)}/${encodeURIComponent(merchid)}`);
  // The gateway answers with an empty-ish object or a "not found" respstat when there is
  // no such order. Absence of a retref is the honest test.
  const retref = typeof j.retref === "string" ? j.retref.trim() : "";
  return retref ? j : null;
}

/** Settlement status for a date (YYYYMMDD). ONE call returns the whole batch — always
 *  preferred over a per-payment inquire loop, which would 429 itself into uselessness and
 *  starve real customer charges of the shared per-MID quota. */
export async function cpSettleStat(merchid: string, date: string): Promise<unknown> {
  return await cpPost("GET", `/settlestat?merchid=${encodeURIComponent(merchid)}&date=${encodeURIComponent(date)}`);
}

/** Funding detail — the final word on whether an ACH debit actually funded. */
export async function cpFunding(merchid: string, date: string): Promise<unknown> {
  return await cpPost("GET", `/funding?merchid=${encodeURIComponent(merchid)}&date=${encodeURIComponent(date)}`);
}

/**
 * Will this card be surcharged? Carolyn wants the fee on the invoice BEFORE the charge,
 * and that cannot be known until the card is known, because debit is exempt by card-brand
 * rule. Best-effort by design: a probe failure must never block a payment, so this returns
 * "unknown" rather than throwing.
 */
export async function cpSurchargeProbe(
  merchid: string,
  token: string,
  postal?: string,
): Promise<{ applies: boolean | null; percent: number | null }> {
  try {
    const qs = new URLSearchParams({ merchid, account: token });
    if (postal) qs.set("postal", postal);
    const j = await cpPost("GET", `/surcharge?${qs.toString()}`);
    const raw = String(j.surchargeapplied ?? j.surcharge ?? "").toLowerCase();
    const pctRaw = j.surchargepercent ?? j.percent;
    const pct = pctRaw == null ? null : Number(pctRaw);
    if (raw === "y" || raw === "true" || raw === "yes") {
      return { applies: true, percent: Number.isFinite(pct as number) ? (pct as number) : null };
    }
    if (raw === "n" || raw === "false" || raw === "no" || raw === "not applicable") {
      return { applies: false, percent: null };
    }
    return { applies: null, percent: null };
  } catch {
    // Never let the probe decide whether money can move.
    return { applies: null, percent: null };
  }
}

/**
 * The tokenizer iFrame URL, composed SERVER-SIDE and handed to the browser.
 *
 * ⚠️ This repo is PUBLIC. No CardPointe host may appear in a browser-served file, and
 * preflight enforces that. Composing here also means the isv-uat/production switch is a
 * secret change rather than a code edit, and there is exactly one place to get it wrong.
 *
 * The parameter set is chosen for a phone, because most shed shoppers open my-quotes.html
 * from a text message:
 *   enhancedresponse   without it a tokenization FAILURE is indistinguishable from a
 *                      strange token, and the page cannot keep Pay disabled honestly
 *   tokenizewheninactive + inactivityto
 *                      THE mobile requirement. A keyboard covers the bottom third of a
 *                      phone; a "get token" button under the field is one the customer
 *                      cannot see or reach without dismissing the keyboard first.
 *   useexpiry/usecvv   every field we render OURSELVES is a field PCI DSS 6.4.3 makes us
 *                      responsible for. Keep them inside the iframe.
 *   formatinput        live grouping on 16 digits typed with thumbs — this shows up
 *                      directly in the decline rate
 *   invalid*event      inline "that card number isn't right" BEFORE the tap, instead of a
 *                      round trip on a phone connection
 *   unique             a fresh token per entry; we never re-present one
 *   css font-size:16px iOS ZOOMS the viewport on focus for any input under 16px. The
 *                      page's own inputs are already 16px for exactly this reason, and a
 *                      14px field inside the iframe would jump the layout on tap.
 * ACH swaps in fullmobilekeyboard (routing and account are typed as "routing/account", and
 * a numeric keypad has no slash) and drops the card grouping.
 */
export function cpTokenizerUrl(rail: "card" | "ach"): string {
  // ⚠️ THREE THINGS HERE ARE FIXES FOR DEFECTS SEEN ON A REAL PHONE (2026-09-02), not
  // decoration. The first version of this looked fine in the markup and wrong on screen.
  //
  //  1. `body{margin:0}` — CardPointe's own document carries a default body margin, so
  //     inputs at width:100% overflowed the iframe's right edge and the card number ran
  //     off the side of the panel. width:100% is measured against a body that is WIDER
  //     than the frame; resetting the margin is what actually contains it.
  //  2. An EXPLICIT font stack, never `font-family:inherit`. Inside an iframe, `inherit`
  //     resolves against the IFRAME's document — not the embedding page — so it inherited
  //     the browser default and rendered the labels in serif against a sans-serif page.
  //  3. `label` is styled at all. Only `input`/`select` were, so CardPointe's own field
  //     labels were unstyled text sitting above nicely styled boxes.
  //
  // Only the properties on Fiserv's allow-list are honoured; anything else is dropped
  // silently, so every declaration below is drawn from it.
  const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const css = encodeURIComponent(
    `body{margin:0;padding:0;font-family:${FONT};color:#0F172A}` +
      `label{display:block;font-family:${FONT};font-size:13px;font-weight:600;color:#475569;margin:10px 0 4px}` +
      `input{width:100%;box-sizing:border-box;font-size:16px;padding:11px 12px;` +
      `border:1px solid #CBD5E1;border-radius:8px;color:#0F172A;font-family:${FONT}}` +
      `select{font-size:16px;padding:10px;border:1px solid #CBD5E1;border-radius:8px;` +
      `font-family:${FONT};color:#0F172A;margin-right:6px}` +
      `.error{color:#B91C1C;font-size:13px;font-family:${FONT}}`,
  );
  const common = [
    "enhancedresponse=true",
    "unique=true",
    "tokenizewheninactive=true",
    "inactivityto=2000",
    `css=${css}`,
  ];
  const params = rail === "ach"
    ? [
      ...common,
      "fullmobilekeyboard=true",
      "formatinput=false",
      "cardlabel=" + encodeURIComponent("Routing / account number"),
      "placeholder=" + encodeURIComponent("031201360/0000000000"),
    ]
    : [
      ...common,
      "useexpiry=true",
      "useexpiryfield=true",
      "usecvv=true",
      "formatinput=true",
      "cardnumbernumericonly=true",
      "invalidcreditcardevent=true",
      "invalidexpiryevent=true",
      "invalidcvvevent=true",
      "cardlabel=" + encodeURIComponent("Card number"),
      "expirylabel=" + encodeURIComponent("Expires"),
      "cvvlabel=" + encodeURIComponent("Security code"),
      "placeholder=" + encodeURIComponent("Card number"),
    ];
  return `${CP_TOKENIZER_BASE}?${params.join("&")}`;
}

/**
 * How tall the iframe has to be, in px, for the rail's full field set to be REACHABLE.
 *
 * Served rather than hardcoded in the pages, because the two surfaces (my-quotes.html and
 * the portal's Record-a-payment modal) would otherwise carry two copies that drift — and
 * this exact number is a defect if it is too small rather than merely ugly: the card set is
 * number + expiry + CVV, and at the original 132px the CVV was simply below the fold of a
 * non-scrolling frame. A customer could not complete a payment, and nothing errored.
 * Generous on purpose: an over-tall frame is whitespace, an under-tall one is a dead form.
 */
export function cpTokenizerHeight(rail: "card" | "ach"): number {
  // MEASURED against the live tokenizer, not estimated — the first guess (210) was still a
  // dead form. Reading its DOM showed the card rail renders FOUR inputs, not three:
  // ccnumfield, ccexpiryfieldMONTH, ccexpiryfieldYEAR and cccvvfield, each in its own block
  // with its own label, and month/year stack no matter what width they are given (they are
  // not in a shared row, so no CSS on the allow-list makes them sit side by side). Measured
  // content height was 357px with the CVV's bottom edge at 367.
  return rail === "ach" ? 150 : 400;
}

/** The origin the browser must check every postMessage against. */
export function cpTokenizerOrigin(): string {
  try {
    return new URL(CP_TOKENIZER_BASE).origin;
  } catch {
    return "";
  }
}
