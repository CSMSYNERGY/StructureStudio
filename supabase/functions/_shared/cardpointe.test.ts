// Unit tests for the CardPointe gateway client (migration 174).
//
// WHY THESE EXIST, and why they are more thorough than the module they cover is long.
// This file is the ONLY place that decides, from a gateway response, whether a customer's
// card was charged. Every one of its failure modes is asymmetric and expensive: read an
// unknown as a decline and somebody gets billed twice; read a partial approval as an
// approval and a builder marks a shed paid for money they did not get. nmi.ts — the
// equivalent on the subscription path — has NO tests at all, so this also sets the
// precedent that was missing.
//
// The classification table in cardpointe.ts is the contract, and every row of it is pinned
// here. Two cases exist purely because a live UAT response on 2026-09-01 contradicted the
// documentation: the respproc/cardproc field-name split, and the field-order shuffling.
//
// Deliberately dependency-free (no jsr:/npm: imports) so this suite still runs on a machine
// with no registry access — the same rule the other _shared tests follow. Env is set BEFORE
// the dynamic import because the module reads its configuration at load.

Deno.env.set("CARDPOINTE_BASE_URL", "https://isv-uat.example.invalid/cardconnect/rest");
Deno.env.set("CARDPOINTE_API_USER", "u");
Deno.env.set("CARDPOINTE_API_PASS", "p");
Deno.env.set("CARDPOINTE_MERCHID", "490000000101");
Deno.env.set("CARDPOINTE_TOKENIZER_BASE", "https://isv-uat.example.invalid/itoke/ajax-tokenizer.html");

const cp = await import("./cardpointe.ts");

function check(name: string, cond: boolean, detail?: string) {
  if (!cond) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
}

const realFetch = globalThis.fetch;
/** Answer the next request with this status/body/headers. */
function stubFetch(status: number, body: string, headers: Record<string, string> = {}) {
  globalThis.fetch = ((_u: string | URL | Request, _i?: RequestInit) =>
    Promise.resolve(new Response(body, { status, headers }))) as typeof fetch;
}
function stubThrow(err: Error) {
  globalThis.fetch = (() => Promise.reject(err)) as typeof fetch;
}
function restore() {
  globalThis.fetch = realFetch;
}

const REQ = { merchid: "490000000101", amountCents: 600, account: "9413948780281111", orderid: "ssp_x" };

/** Run cpAuth and hand back the thrown error, or null when it returned. */
async function authError(): Promise<Error | null> {
  try {
    await cp.cpAuth(REQ);
    return null;
  } catch (e) {
    return e as Error;
  }
}

Deno.test("approved: amounts agree and a retref is present", async () => {
  stubFetch(200, JSON.stringify({
    respstat: "A", respcode: "000", resptext: "Approval", retref: "244031450749",
    amount: "6.00", authcode: "PPS283", token: "9413948780281111",
    avsresp: "Z", cvvresp: "M", entrymode: "ECommerce", respproc: "RPCT",
  }));
  const r = await cp.cpAuth(REQ);
  restore();
  check("kind", r.kind === "approved");
  if (r.kind !== "approved") return;
  check("retref", r.retref === "244031450749");
  check("amount", r.amountCents === 600);
  check("no surcharge", r.surchargeCents === null);
  check("last4 from token", r.last4 === "1111", String(r.last4));
  check("respproc", r.respproc === "RPCT");
});

Deno.test("respstat C is a DECLINE, not an unknown — the gateway answered", async () => {
  stubFetch(200, JSON.stringify({ respstat: "C", respcode: "116", resptext: "Not sufficient funds", amount: "0.00" }));
  const e = await authError();
  restore();
  check("threw", e !== null);
  check("not unknown", !cp.isGatewayUnknown(e));
  check("carries the reason", String(e?.message).includes("Not sufficient funds"), String(e?.message));
});

Deno.test("respstat B is UNKNOWN — the single most consequential call in the module", async () => {
  // Fiserv documents B as "retry". /auth takes no idempotency key, and a B can be a
  // downstream processor timeout where the card WAS charged. Auto-retrying is a
  // double-charge machine, so B must never be reachable as a decline or a success.
  stubFetch(200, JSON.stringify({ respstat: "B", respcode: "999", resptext: "Retry" }));
  const e = await authError();
  restore();
  check("threw", e !== null);
  check("classified unknown", cp.isGatewayUnknown(e), String(e?.message));
  check("not a decline", !cp.isGatewayThrottled(e) && !cp.isGatewayConfig(e));
});

Deno.test("HTTP 5xx is unknown", async () => {
  for (const s of [500, 502, 503, 504]) {
    stubFetch(s, "gateway blew up");
    const e = await authError();
    check(`HTTP ${s}`, cp.isGatewayUnknown(e), String(e?.message));
  }
  restore();
});

Deno.test("transport rejection is unknown", async () => {
  stubThrow(new Error("connection reset"));
  const e = await authError();
  restore();
  check("unknown", cp.isGatewayUnknown(e), String(e?.message));
});

Deno.test("HTTP 200 with an unparseable body is UNKNOWN — the branch nmi.ts cannot have", async () => {
  // URLSearchParams never throws, so form-encoded parsing has no failure mode. A truncated
  // JSON body from a connection dropped mid-stream is a 200 whose card may well be charged.
  stubFetch(200, '{"respstat":"A","retref":"2440314');
  const e = await authError();
  restore();
  check("unknown", cp.isGatewayUnknown(e), String(e?.message));
});

Deno.test("200 with valid JSON but no respstat is unknown — missing is not 'no'", async () => {
  stubFetch(200, JSON.stringify({ merchid: "490000000101", somethingElse: 1 }));
  const e = await authError();
  restore();
  check("unknown", cp.isGatewayUnknown(e), String(e?.message));
});

Deno.test("approved with NO retref is unknown — an approval we can never void or refund", async () => {
  stubFetch(200, JSON.stringify({ respstat: "A", respcode: "000", amount: "6.00" }));
  const e = await authError();
  restore();
  check("unknown", cp.isGatewayUnknown(e), String(e?.message));
});

Deno.test("429 WITH the documented header is THROTTLED (known: not charged)", async () => {
  stubFetch(429, JSON.stringify({ error: "rate limited" }), { "X-Rate-Limit-Retry-After-Seconds": "37" });
  const e = await authError();
  restore();
  check("throttled", cp.isGatewayThrottled(e), String(e?.message));
  check("NOT unknown", !cp.isGatewayUnknown(e));
  check("carries the seconds", cp.throttledRetryAfter(e) === 37, String(cp.throttledRetryAfter(e)));
});

Deno.test("429 WITHOUT that header is unknown — not provably the documented limiter", async () => {
  stubFetch(429, JSON.stringify({ error: "slow down" }));
  const e = await authError();
  restore();
  check("unknown", cp.isGatewayUnknown(e), String(e?.message));
  check("not throttled", !cp.isGatewayThrottled(e));
});

Deno.test("401/403 are CONFIG — our credentials, never shown to a customer as a decline", async () => {
  for (const s of [401, 403]) {
    stubFetch(s, JSON.stringify({ resptext: "Unauthorized" }));
    const e = await authError();
    check(`HTTP ${s} config`, cp.isGatewayConfig(e), String(e?.message));
    check(`HTTP ${s} not unknown`, !cp.isGatewayUnknown(e));
  }
  restore();
});

Deno.test("PARTIAL approval is returned, not thrown, and is not an approval", async () => {
  // The hazard a bare `respstat === "A"` check walks straight into: some of the customer's
  // money taken, the ask unsatisfied, and the product has no split-tender model.
  stubFetch(200, JSON.stringify({
    respstat: "A", respcode: "000", resptext: "Approval", retref: "244031999999", amount: "5.00",
  }));
  const r = await cp.cpAuth(REQ);
  restore();
  check("kind", r.kind === "partial", r.kind);
  if (r.kind !== "partial") return;
  check("approved", r.approvedCents === 500);
  check("requested", r.requestedCents === 600);
  check("retref present for the void", r.retref === "244031999999");
});

Deno.test("an amount ABOVE the request is the surcharge Fiserv added, not a discrepancy", async () => {
  stubFetch(200, JSON.stringify({
    respstat: "A", respcode: "000", retref: "r1", amount: "6.18", token: "9413948780281111",
  }));
  const r = await cp.cpAuth(REQ);
  restore();
  check("approved", r.kind === "approved");
  if (r.kind !== "approved") return;
  check("balance amount is what we asked", r.amountCents === 600);
  check("fee is the difference", r.surchargeCents === 18, String(r.surchargeCents));
});

Deno.test("field ORDER and junk fields do not change the parse", async () => {
  // UAT deliberately randomises field order and injects dummy fields, and one live
  // transaction on 2026-09-01 returned respproc "RPCT" from /auth and "PPS" from the /void
  // of that same transaction while the docs call the field cardproc. Positional or
  // name-assuming parsing would be a silent wrong-field bug.
  stubFetch(200, JSON.stringify({
    zzz: "junk", amount: "6.00", nonsense: [1, 2, 3], retref: "r2", respcode: "000",
    cardproc: "RPCT", respstat: "A", filler: null, token: "9413948780284242",
  }));
  const r = await cp.cpAuth(REQ);
  restore();
  check("approved", r.kind === "approved");
  if (r.kind !== "approved") return;
  check("retref", r.retref === "r2");
  check("cardproc read as respproc fallback", r.respproc === "RPCT", String(r.respproc));
  check("last4", r.last4 === "4242");
});

Deno.test("cpAmount is the one cents->dollars boundary and does not drift", () => {
  check("105", cp.cpAmount(105) === "1.05");
  check("1", cp.cpAmount(1) === "0.01");
  check("100000", cp.cpAmount(100000) === "1000.00");
  check("111695", cp.cpAmount(111695) === "1116.95");   // the UAT decline-code amount
  check("365000", cp.cpAmount(365000) === "3650.00");
  check("0", cp.cpAmount(0) === "0.00");
});

Deno.test("cpCents round-trips without floating-point drift", () => {
  check("6.00", cp.cpCents("6.00") === 600);
  check("1116.95", cp.cpCents("1116.95") === 111695);
  check("0.01", cp.cpCents("0.01") === 1);
  check("3650.00", cp.cpCents("3650.00") === 365000);
  check("garbage", cp.cpCents("nope") === null);
  check("missing", cp.cpCents(undefined) === null);
});

Deno.test("the GATEWAY_UNKNOWN sentinel agrees with nmi.ts", async () => {
  // The prefix string is SHARED VOCABULARY duplicated between the two gateway clients
  // rather than extracted, because extracting it would edit a live money path to buy
  // neatness. This assertion is what turns that comment into something that fails a push.
  const nmi = await import("./nmi.ts");
  const e = new Error("GATEWAY_UNKNOWN: something went dark");
  check("cardpointe recognises it", cp.isGatewayUnknown(e));
  check("nmi recognises it", nmi.isGatewayUnknown(e));
});

Deno.test("cpSummary is a whitelist rebuild — secrets cannot leak into a log by accident", () => {
  const out = cp.cpSummary({
    respstat: "A", retref: "r", amount: "6.00",
    account: "4111111111111111", token: "9413948780281111", expiry: "1232", cvv2: "123",
    profile: "12345678901234567890",
  });
  check("keeps respstat", out.respstat === "A");
  check("no account", !("account" in out));
  check("no token", !("token" in out));
  check("no expiry", !("expiry" in out));
  check("no cvv2", !("cvv2" in out));
  check("no profile", !("profile" in out));
});

Deno.test("the tokenizer URL carries the mobile-critical parameters", () => {
  const card = cp.cpTokenizerUrl("card");
  for (const p of ["enhancedresponse=true", "tokenizewheninactive=true", "inactivityto=2000", "usecvv=true", "useexpiry=true", "unique=true"]) {
    check(`card has ${p}`, card.includes(p), card);
  }
  check("card is NOT full-keyboard", !card.includes("fullmobilekeyboard"), card);
  // iOS zooms the viewport on focus for any input under 16px. The page's own inputs are
  // already 16px for that reason; a smaller field inside the iframe would jump the layout.
  check("16px font is in the css param", decodeURIComponent(card).includes("font-size:16px"), card);

  const ach = cp.cpTokenizerUrl("ach");
  // Routing and account are typed into ONE field as "routing/account", and a numeric
  // keypad has no slash.
  check("ach is full-keyboard", ach.includes("fullmobilekeyboard=true"), ach);
  check("ach has no cvv", !ach.includes("usecvv=true"), ach);

  check("origin", cp.cpTokenizerOrigin() === "https://isv-uat.example.invalid", cp.cpTokenizerOrigin());
});

Deno.test("the tokenizer css resets CardPointe's body margin and sets a REAL font", () => {
  // Both are fixes for defects seen on a real phone (2026-09-02), and both are invisible
  // in the markup — the only way they regress is silently.
  const css = decodeURIComponent(cp.cpTokenizerUrl("card"));
  // Without this the inputs at width:100% overflow the frame's right edge, because
  // width:100% is measured against a body wider than the frame.
  check("body margin reset", /body\{[^}]*margin:0/.test(css), css.slice(0, 200));
  // `font-family:inherit` inside an iframe inherits from the IFRAME's document, not the
  // page — which rendered the labels in serif against a sans-serif page.
  check("no font-family:inherit anywhere", !/font-family:inherit/.test(css), css);
  check("labels are styled at all", /label\{/.test(css), css.slice(0, 300));
});

Deno.test("the tokenizer is tall enough for its rail's full field set", () => {
  // Not cosmetic: the card set is number + expiry + CVV, and at the original 132px the CVV
  // was below the fold of a non-scrolling frame — the form could not be completed and
  // nothing errored. A floor, not an exact value.
  check("card fits three fields", cp.cpTokenizerHeight("card") >= 190, String(cp.cpTokenizerHeight("card")));
  check("ach fits one field plus its label", cp.cpTokenizerHeight("ach") >= 90, String(cp.cpTokenizerHeight("ach")));
  check("card is taller than ach", cp.cpTokenizerHeight("card") > cp.cpTokenizerHeight("ach"));
});

Deno.test("cardpointeConfigured is all-or-nothing", () => {
  // The nmiConfigured rule: a tokenizer base without credentials mints tokens nobody can
  // charge, and credentials without a tokenizer base cannot collect an instrument at all.
  check("configured with all five", cp.cardpointeConfigured === true);
});
