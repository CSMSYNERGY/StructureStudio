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
// with no registry access — the same rule the other _shared tests follow. The module reads its
// configuration PER CALL since workstream 1 phase 3, so the UAT set is configured here and the
// production set is set and cleared by the tests that drive it. CARDPOINTE_MERCHID (the old
// deployment default) is deliberately left UNSET: nothing may need it any more.

Deno.env.set("CARDPOINTE_BASE_URL", "https://isv-uat.example.invalid/cardconnect/rest");
Deno.env.set("CARDPOINTE_API_USER", "u");
Deno.env.set("CARDPOINTE_API_PASS", "p");
Deno.env.delete("CARDPOINTE_MERCHID");
Deno.env.set("CARDPOINTE_TOKENIZER_BASE", "https://isv-uat.example.invalid/itoke/ajax-tokenizer.html");
const PROD_KEYS = ["BASE_URL", "API_USER", "API_PASS", "TOKENIZER_BASE"].map((k) => `CARDPOINTE_PROD_${k}`);
for (const k of PROD_KEYS) Deno.env.delete(k);

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

/** Made-up merchants, one on each system. */
const UAT_M = { merchid: "100200300400", env: "uat" as const };
const PROD_M = { merchid: "100200300500", env: "prod" as const };
const REQ = { merchant: UAT_M, amountCents: 600, account: "9413948780281111", orderid: "ssp_x" };

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
  stubFetch(200, JSON.stringify({ merchid: "100200300400", somethingElse: 1 }));
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
  const card = cp.cpTokenizerUrl(UAT_M, "card");
  for (const p of ["enhancedresponse=true", "tokenizewheninactive=true", "inactivityto=2000", "usecvv=true", "useexpiry=true", "unique=true"]) {
    check(`card has ${p}`, card.includes(p), card);
  }
  check("card is NOT full-keyboard", !card.includes("fullmobilekeyboard"), card);
  // iOS zooms the viewport on focus for any input under 16px. The page's own inputs are
  // already 16px for that reason; a smaller field inside the iframe would jump the layout.
  check("16px font is in the css param", decodeURIComponent(card).includes("font-size:16px"), card);

  const ach = cp.cpTokenizerUrl(UAT_M, "ach");
  // Routing and account are typed into ONE field as "routing/account", and a numeric
  // keypad has no slash.
  check("ach is full-keyboard", ach.includes("fullmobilekeyboard=true"), ach);
  check("ach has no cvv", !ach.includes("usecvv=true"), ach);

  check("origin", cp.cpTokenizerOrigin(UAT_M) === "https://isv-uat.example.invalid", cp.cpTokenizerOrigin(UAT_M));
});

Deno.test("the tokenizer css resets CardPointe's body margin and sets a REAL font", () => {
  // Both are fixes for defects seen on a real phone (2026-09-02), and both are invisible
  // in the markup — the only way they regress is silently.
  const css = decodeURIComponent(cp.cpTokenizerUrl(UAT_M, "card"));
  // Without this the inputs at width:100% overflow the frame's right edge, because
  // width:100% is measured against a body wider than the frame.
  check("body margin reset", /body\{[^}]*margin:0/.test(css), css.slice(0, 200));
  // `font-family:inherit` inside an iframe inherits from the IFRAME's document, not the
  // page — which rendered the labels in serif against a sans-serif page.
  check("no font-family:inherit anywhere", !/font-family:inherit/.test(css), css);
  check("labels are styled at all", /label\{/.test(css), css.slice(0, 300));
  // ⚠️ The tokenizer's form is flat, using <br> separators, and its labels are inline.
  // `label{display:block}` on top of those <br>s is a DOUBLE line break — it is what made
  // the form look broken, so it must never come back.
  check("labels are NOT forced to block", !/label\{[^}]*display:block/.test(css), css);
  // width belongs on the individual FIELDS: a blanket input{width:100%} also hits the
  // month and year boxes, which wraps them onto separate lines and doubles the height.
  check("no blanket input width", !/input\{[^}]*width:100%/.test(css), css);
  check("card number is full width", /#ccnumfield\{width:100%/.test(css), css);
  check("month and year are narrow", /#ccexpiryfieldmonth\{width:\d+px/.test(css), css);
});

Deno.test("the tokenizer is tall enough for its rail's full field set", () => {
  // Not cosmetic: the card set is number + expiry + CVV, and at the original 132px the CVV
  // was below the fold of a non-scrolling frame — the form could not be completed and
  // nothing errored. A floor, not an exact value.
  // 357px of content with the CVV's bottom edge at 367, MEASURED against the live
  // tokenizer — the card rail renders FOUR inputs (number, expiry month, expiry year, cvv),
  // each its own block. An earlier 210 passed a >=190 assertion and was still a dead form,
  // which is why this floor is anchored to the measurement rather than to a guess.
  // 243px of content at a 283px frame with the CVV's bottom at 231, MEASURED against the
  // live tokenizer once the CSS stopped forcing month/year onto their own lines. The floor
  // is anchored to that measurement — an earlier 210 passed a >=190 guess and was still an
  // unfinishable form.
  check("card clears the measured 243px content", cp.cpTokenizerHeight("card") >= 250, String(cp.cpTokenizerHeight("card")));
  check("card is not absurdly tall either", cp.cpTokenizerHeight("card") <= 320, String(cp.cpTokenizerHeight("card")));
  check("ach fits its field plus label", cp.cpTokenizerHeight("ach") >= 110, String(cp.cpTokenizerHeight("ach")));
  check("card is taller than ach", cp.cpTokenizerHeight("card") > cp.cpTokenizerHeight("ach"));
});


Deno.test("cpExpiry converts the tokenizer's YYYYMM to the gateway's MMYY", () => {
  // OBSERVED LIVE 2026-09-02: the iFrame's postMessage carries expiry "203212" for 12/2032
  // while /auth expects "1232". Both sides call the field `expiry`, and the documentation
  // describes neither format, so passing it through looks obviously correct and is wrong.
  check("tokenizer YYYYMM", cp.cpExpiry("203212") === "1232", String(cp.cpExpiry("203212")));
  check("already MMYY passes through", cp.cpExpiry("1232") === "1232");
  check("MMYYYY", cp.cpExpiry("122032") === "1232", String(cp.cpExpiry("122032")));
  check("separators stripped", cp.cpExpiry("12/2032") === "1232", String(cp.cpExpiry("12 / 2032")));
  // Unrecognised shapes are OMITTED, not guessed: a token carries its own expiry for its
  // first use, so leaving it out is recoverable where a wrong value is not.
  check("garbage", cp.cpExpiry("nope") === undefined);
  check("empty", cp.cpExpiry("") === undefined);
  check("null", cp.cpExpiry(null) === undefined);
  check("impossible month", cp.cpExpiry("9932") === undefined, String(cp.cpExpiry("9932")));
  check("too short", cp.cpExpiry("123") === undefined);
});

Deno.test("cpExpiry reads the tokenizer's FIVE-digit YYYYM — every card expiring Jan to Sep", () => {
  // Fiserv's itoke.js builds expiry as `expiryYear.toString() + expiryMonth.toString()` with
  // the month as a number, and says so in its own comment: "YYYYM (if Jan-Sep)". Before this
  // case existed, a 5-digit value fell through to undefined and the expiry was silently left
  // off /auth for nine months out of twelve.
  check("YYYYM September", cp.cpExpiry("20329") === "0932", String(cp.cpExpiry("20329")));
  check("YYYYM January", cp.cpExpiry("20321") === "0132", String(cp.cpExpiry("20321")));
  // A hand-typed one-digit month ("9/2032") is the other five-digit shape. The two cannot
  // collide: YYYYM starts with "20", MYYYY has its "20" at positions 1-2.
  check("MYYYY", cp.cpExpiry("92032") === "0932", String(cp.cpExpiry("92032")));
  check("MYYYY with a separator", cp.cpExpiry("9/2032") === "0932", String(cp.cpExpiry("9/2032")));
  // Month 0 is no month. Omitted, never guessed.
  check("YYYYM month 0", cp.cpExpiry("20320") === undefined, String(cp.cpExpiry("20320")));
  check("five digits that are neither shape", cp.cpExpiry("19329") === undefined, String(cp.cpExpiry("19329")));
  check("MYYYY outside the century", cp.cpExpiry("91999") === undefined, String(cp.cpExpiry("91999")));
});

Deno.test("cpAuth sends the gateway MMYY when the tokenizer said YYYYM", async () => {
  // The unit above is only half the fix: what matters is the field /auth actually receives.
  let sent: Record<string, unknown> | null = null;
  globalThis.fetch = ((_u: string | URL | Request, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body ?? "{}"));
    return Promise.resolve(new Response(JSON.stringify({
      respstat: "A", respcode: "000", resptext: "Approval", retref: "r9", amount: "6.00", token: "9413948780281111",
    }), { status: 200 }));
  }) as typeof fetch;
  try {
    await cp.cpAuth({ ...REQ, expiry: "20329" });
  } finally {
    restore();
  }
  const body = (sent ?? {}) as Record<string, unknown>;
  check("expiry reached /auth as MMYY", body.expiry === "0932", JSON.stringify(body.expiry));
});

// ─────────────────────────────────────────────────────────────────────────────────────
// Two systems, chosen per call (workstream 1 phase 3, migration 296).
// ─────────────────────────────────────────────────────────────────────────────────────

const PROD_ENV: Record<string, string> = {
  CARDPOINTE_PROD_BASE_URL: "https://live.example.invalid/cardconnect/rest/",
  CARDPOINTE_PROD_API_USER: "pu",
  CARDPOINTE_PROD_API_PASS: "pp",
  CARDPOINTE_PROD_TOKENIZER_BASE: "https://live.example.invalid/itoke/ajax-tokenizer.html",
};
/** Run `fn` with the production set configured (or `only` some of it), then clear it again. */
async function withProd<T>(fn: () => Promise<T> | T, only: string[] = Object.keys(PROD_ENV)): Promise<T> {
  for (const k of only) Deno.env.set(k, PROD_ENV[k]);
  try {
    return await fn();
  } finally {
    for (const k of PROD_KEYS) Deno.env.delete(k);
  }
}
/** Every request the stub saw: url, method, Authorization, body. */
type Seen = { url: string; method: string; auth: string | null; body: Record<string, unknown> | null };
function recordAll(answer: Record<string, unknown> | number, seen: Seen[]) {
  globalThis.fetch = ((u: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({ url: String(u), method: String(init?.method ?? "GET"), auth: headers.get("Authorization"), body: init?.body ? JSON.parse(String(init.body)) : null });
    return Promise.resolve(typeof answer === "number" ? new Response("", { status: answer }) : new Response(JSON.stringify(answer), { status: 200 }));
  }) as typeof fetch;
}
const basic = (u: string, p: string) => "Basic " + btoa(`${u}:${p}`);

Deno.test("cardpointeConfigured is all-or-nothing PER SYSTEM, and the MID is no longer part of it", async () => {
  // The nmiConfigured rule, per system: a tokenizer base without credentials mints tokens nobody
  // can charge, and credentials without a tokenizer base cannot collect an instrument at all.
  // CARDPOINTE_MERCHID is unset in this file: it was the default merchant, and nothing needs it now.
  check("UAT configured with its four, no MID", cp.cardpointeConfigured("uat") === true);
  check("production unset", cp.cardpointeConfigured("prod") === false);
  await withProd(() => check("production with all four", cp.cardpointeConfigured("prod") === true));
  for (const missing of Object.keys(PROD_ENV)) {
    await withProd(() => check(`production without ${missing}`, cp.cardpointeConfigured("prod") === false),
      Object.keys(PROD_ENV).filter((k) => k !== missing));
  }
  // The UAT set is all-or-nothing too, and setting production does not complete it.
  const saved = Deno.env.get("CARDPOINTE_API_PASS")!;
  Deno.env.delete("CARDPOINTE_API_PASS");
  try {
    await withProd(() => check("UAT without its password is unconfigured, production set or not", cp.cardpointeConfigured("uat") === false));
  } finally {
    Deno.env.set("CARDPOINTE_API_PASS", saved);
  }
  check("an unknown system is never configured", cp.cardpointeConfigured("live" as never) === false);
});

Deno.test("per-call credentials: each merchant's system gets its own base URL and login, on every operation", async () => {
  await withProd(async () => {
    const ok = { respstat: "A", respcode: "00", retref: "r1", amount: "6.00", token: "9413948780281111" };
    for (const [m, base, auth] of [
      [UAT_M, "https://isv-uat.example.invalid/cardconnect/rest", basic("u", "p")],
      [PROD_M, "https://live.example.invalid/cardconnect/rest", basic("pu", "pp")],
    ] as const) {
      const seen: Seen[] = [];
      recordAll(ok, seen);
      try {
        await cp.cpAuth({ ...REQ, merchant: m });
        await cp.cpVoid(m, "r1");
        await cp.cpRefund(m, "r1", 600);
        await cp.cpInquireByOrderId(m, "ssp_x");
        await cp.cpSettleStat(m, "20261009");
        await cp.cpFunding(m, "20261009");
        await cp.cpSurchargeProbe(m, "9413948780281111");
      } finally {
        restore();
      }
      check(`${m.env}: seven calls`, seen.length === 7, String(seen.length));
      for (const s of seen) {
        check(`${m.env}: ${s.url} on its own base`, s.url.startsWith(base + "/"), s.url);
        check(`${m.env}: ${s.url} with its own login`, s.auth === auth, String(s.auth));
        // The MID in every request is the merchant's own, in the body or the path.
        const carries = s.body ? s.body.merchid === m.merchid : s.url.includes(m.merchid);
        check(`${m.env}: ${s.url} names the merchant's MID`, carries, JSON.stringify(s));
      }
    }
  });
});

Deno.test("a LIVE merchant with the production secrets unset is refused with a config error, and NOTHING is sent", async () => {
  const seen: Seen[] = [];
  recordAll({ respstat: "A", retref: "r1", amount: "6.00" }, seen);
  const errs: unknown[] = [];
  try {
    for (
      const call of [
        () => cp.cpAuth({ ...REQ, merchant: PROD_M }),
        () => cp.cpVoid(PROD_M, "r1"),
        () => cp.cpRefund(PROD_M, "r1", 600),
        () => cp.cpInquireByOrderId(PROD_M, "ssp_x"),
        () => cp.cpSettleStat(PROD_M, "20261009"),
        () => cp.cpFunding(PROD_M, "20261009"),
      ]
    ) {
      try {
        await call();
        errs.push(null);
      } catch (e) {
        errs.push(e);
      }
    }
    // The probe never throws: it answers "unknown", still without a request.
    const probe = await cp.cpSurchargeProbe(PROD_M, "9413948780281111");
    check("probe answers unknown", probe.applies === null && probe.percent === null, JSON.stringify(probe));
  } finally {
    restore();
  }
  check("every operation threw a CONFIG error", errs.every((e) => cp.isGatewayConfig(e)), errs.map((e) => String((e as Error)?.message)).join(" | "));
  check("the error names the live system", /live is not configured/.test(String((errs[0] as Error)?.message)), String((errs[0] as Error)?.message));
  check("not one request (never the test system instead)", seen.length === 0, JSON.stringify(seen.map((s) => s.url)));
  check("no tokenizer for it either", cp.cpTokenizerUrl(PROD_M, "card") === "" && cp.cpTokenizerOrigin(PROD_M) === "");
});

Deno.test("NO DEFAULT MERCHANT: a blank MID is refused even with CARDPOINTE_MERCHID set, and an unknown system goes nowhere", async () => {
  const seen: Seen[] = [];
  recordAll({ respstat: "A", retref: "r1", amount: "6.00" }, seen);
  Deno.env.set("CARDPOINTE_MERCHID", "100200300999");
  const errs: unknown[] = [];
  try {
    for (const m of [{ merchid: "", env: "uat" as const }, { merchid: "   ", env: "uat" as const }, { merchid: "100200300400", env: "live" as never }]) {
      try {
        await cp.cpVoid(m, "r1");
        errs.push(null);
      } catch (e) {
        errs.push(e);
      }
    }
  } finally {
    Deno.env.delete("CARDPOINTE_MERCHID");
    restore();
  }
  check("all three refused as CONFIG", errs.length === 3 && errs.every((e) => cp.isGatewayConfig(e)), errs.map((e) => String((e as Error)?.message)).join(" | "));
  check("nothing sent, so the old default was never used", seen.length === 0, JSON.stringify(seen));
});

Deno.test("the tokenizer is the one on the merchant's own system", async () => {
  await withProd(() => {
    check("UAT tokenizer", cp.cpTokenizerUrl(UAT_M, "card").startsWith("https://isv-uat.example.invalid/itoke/ajax-tokenizer.html?"), cp.cpTokenizerUrl(UAT_M, "card"));
    check("live tokenizer", cp.cpTokenizerUrl(PROD_M, "card").startsWith("https://live.example.invalid/itoke/ajax-tokenizer.html?"), cp.cpTokenizerUrl(PROD_M, "card"));
    check("live origin", cp.cpTokenizerOrigin(PROD_M) === "https://live.example.invalid", cp.cpTokenizerOrigin(PROD_M));
    check("same parameters on both", cp.cpTokenizerUrl(PROD_M, "card").split("?")[1] === cp.cpTokenizerUrl(UAT_M, "card").split("?")[1]);
  });
});

Deno.test("cpVerifyMerchant: one inquireByOrderid for an unused order id; reachable, config, throttled and unknown", async () => {
  // Reachable: the gateway answered. The answer is whitelisted, and the MID is not echoed back.
  let seen: Seen[] = [];
  recordAll({ respstat: "C", respcode: "29", resptext: "Txn not found", merchid: UAT_M.merchid, token: "9413948780281111" }, seen);
  const ok = await cp.cpVerifyMerchant(UAT_M);
  restore();
  check("reachable", ok.reachable === true, JSON.stringify(ok));
  check("…and the expected answer (29, Txn not found)", ok.reachable === true && ok.expected === true, JSON.stringify(ok));
  check("one GET", seen.length === 1 && seen[0].method === "GET", JSON.stringify(seen));
  check("an unused order id, on the merchant's MID", /\/inquireByOrderid\/ssverify_[0-9a-f]{16}\/100200300400$/.test(seen[0].url), seen[0].url);
  if (ok.reachable) {
    check("the gateway's own words", ok.answer.resptext === "Txn not found" && ok.answer.respcode === "29", JSON.stringify(ok.answer));
    check("no MID and no token in the answer", !("merchid" in ok.answer) && !("token" in ok.answer), JSON.stringify(ok.answer));
  }
  // Answered, but NOT the answer a check expects: green would claim more than a 200 proves. A 200 can
  // carry an error about the MID itself, an order (a retref) that should not exist, or a shape this
  // module does not know. Each is reachable, never expected, and the gateway's words are kept.
  for (
    const [label, body] of [
      ["another refusal in a 200", { respstat: "C", respcode: "8", resptext: "Invalid merchant" }],
      ["a 29 that carries a retref", { respstat: "C", respcode: "29", resptext: "Txn not found", retref: "123456789012" }],
      ["no respcode at all", { respstat: "C", resptext: "Txn not found" }],
      ["an array", [{ respcode: "29" }]],
      ["a bare null", null],
    ] as [string, unknown][]
  ) {
    recordAll(body as Record<string, unknown>, []);
    const odd = await cp.cpVerifyMerchant(UAT_M);
    restore();
    check(`${label}: reachable, not expected`, odd.reachable === true && odd.expected === false, JSON.stringify(odd));
  }
  recordAll({ respstat: "C", respcode: 29, resptext: "Txn not found" }, []);
  const numeric = await cp.cpVerifyMerchant(UAT_M);
  restore();
  check("a numeric 29 is the expected answer too", numeric.reachable === true && numeric.expected === true, JSON.stringify(numeric));
  // Refused: our credentials or this MID.
  seen = [];
  recordAll(401, seen);
  const denied = await cp.cpVerifyMerchant(UAT_M);
  restore();
  check("401 is config", !denied.reachable && denied.kind === "config", JSON.stringify(denied));
  // No usable answer.
  recordAll(502, []);
  const dark = await cp.cpVerifyMerchant(UAT_M);
  restore();
  check("502 is unknown", !dark.reachable && dark.kind === "unknown", JSON.stringify(dark));
  // A system with no credentials: config, and nothing sent.
  seen = [];
  recordAll({ respstat: "A" }, seen);
  const unset = await cp.cpVerifyMerchant(PROD_M);
  restore();
  check("unset live is config", !unset.reachable && unset.kind === "config" && seen.length === 0, JSON.stringify({ unset, seen }));
});

Deno.test("source: the deployment-default merchant is gone, and the importer ledger names admin-catalog", async () => {
  const src = (await Deno.readTextFile(new URL("./cardpointe.ts", import.meta.url))).replace(/\r\n/g, "\n");
  const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");
  check("CARDPOINTE_MERCHID is never read", !/CARDPOINTE_MERCHID/.test(code));
  check("CP_DEFAULT_MERCHID is gone", !/CP_DEFAULT_MERCHID/.test(code));
  check("no module-level env read (config is per call)", !/^(export )?const [A-Z_]+ = Deno\.env\.get/m.test(code));
  check("the Importers: line names admin-catalog", /Importers:[^\n]*\n\/\/\s+admin-catalog\/index\.ts/.test(src), src.slice(0, 1500));
  for (const fn of ["customer-pay", "portal-payments", "admin-catalog"]) {
    // Comments may tell the history; code may not read the old default.
    const f = (await Deno.readTextFile(new URL(`../${fn}/index.ts`, import.meta.url))).replace(/\r\n/g, "\n")
      .split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");
    check(`${fn} does not read the old default`, !/CP_DEFAULT_MERCHID|CARDPOINTE_MERCHID/.test(f));
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────
// Billing fields, ecomind and the AVS/CVV answer (2026-10, Fiserv certification).
// ─────────────────────────────────────────────────────────────────────────────────────

/** Run cpAuth against a stub that records the /auth body and answers `answer`. */
async function sentBody(
  req: Parameters<typeof cp.cpAuth>[0],
  answer: Record<string, unknown> = { respstat: "A", respcode: "000", retref: "rb", amount: "6.00", token: "9413948780281111" },
): Promise<{ body: Record<string, unknown>; error: Error | null }> {
  let body: Record<string, unknown> = {};
  globalThis.fetch = ((_u: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body ?? "{}"));
    return Promise.resolve(new Response(JSON.stringify(answer), { status: 200 }));
  }) as typeof fetch;
  let error: Error | null = null;
  try {
    await cp.cpAuth(req);
  } catch (e) {
    error = e as Error;
  } finally {
    restore();
  }
  return { body, error };
}

/** Fields that must NEVER reach /auth from this code: a CVV we would then hold, a stored-credential
 *  profile or card-on-file flags (nothing is kept for later charges; the validation form says so),
 *  and raw track data under its own name (a swipe arrives as `account`). */
const NEVER_SENT = ["cvv2", "profile", "cof", "cofscheduled", "track"];

Deno.test("the auth body carries name, address and postal when given, and never cvv2, profile, cof or track", async () => {
  const { body } = await sentBody({ ...REQ, name: "Pat Example", address: "12 Main St", postal: "12345" });
  check("name", body.name === "Pat Example", JSON.stringify(body));
  check("address", body.address === "12 Main St", JSON.stringify(body));
  check("postal", body.postal === "12345", JSON.stringify(body));
  for (const k of NEVER_SENT) check(`no ${k}`, !(k in body), JSON.stringify(Object.keys(body)));

  // Omitted, not sent blank, when none is given: production's pages send none.
  const bare = (await sentBody(REQ)).body;
  for (const k of ["name", "address", "postal", ...NEVER_SENT]) check(`bare: no ${k}`, !(k in bare), JSON.stringify(Object.keys(bare)));
});

Deno.test("cpAuth cleans the billing fields itself, whoever built the request", async () => {
  // A caller that skipped cpBillingFields still cannot put a newline, an over-long street or a
  // malformed ZIP on the wire.
  const { body } = await sentBody({ ...REQ, name: " Pat\tExample ", address: "12 Main St\nApt 4" + "x".repeat(80), postal: "1234" });
  check("name collapsed", body.name === "Pat Example", JSON.stringify(body.name));
  check("street has no newline", !/[\n\r]/.test(String(body.address)), JSON.stringify(body.address));
  check("street capped at 60", String(body.address).length <= 60, String(String(body.address).length));
  check("a malformed ZIP is left off, not sent", !("postal" in body), JSON.stringify(body));
  // A ZIP+4 typed with its dash is ten characters; the wire carries the nine digits.
  const plus4 = (await sentBody({ ...REQ, postal: "12345-6789" })).body;
  check("ZIP+4 goes out as nine digits", plus4.postal === "123456789", JSON.stringify(plus4.postal));
});

Deno.test("cpBillingFields: trim, strip controls, cap the street at 60, keep only a real ZIP (ZIP+4 as nine digits)", () => {
  const NUL = String.fromCharCode(0), BEL = String.fromCharCode(7), NEL = String.fromCharCode(0x85);
  const cases: [string, unknown, Record<string, string>][] = [
    ["all three, clean", { name: "Pat Example", address: "12 Main St", postal: "12345" }, { name: "Pat Example", address: "12 Main St", postal: "12345" }],
    ["trimmed", { name: "  Pat  ", address: "  12 Main St  ", postal: " 12345 " }, { name: "Pat", address: "12 Main St", postal: "12345" }],
    // Nine digits on the wire, dash removed: the gateway's US postal is 5 or 9 digits (AN 9).
    ["ZIP+4 with a dash: sent as nine digits", { postal: "12345-6789" }, { postal: "123456789" }],
    ["ZIP+4 with a dash, padded", { postal: " 02134-0001 " }, { postal: "021340001" }],
    ["ZIP+4 without one", { postal: "123456789" }, { postal: "123456789" }],
    ["four digits: dropped", { postal: "1234" }, {}],
    ["six digits: dropped", { postal: "123456" }, {}],
    ["letters: dropped", { postal: "1234A" }, {}],
    ["a Canadian postcode: dropped", { postal: "K1A 0B6" }, {}],
    ["a space before the +4: dropped", { postal: "12345 6789" }, {}],
    ["a ZIP sent as a number: dropped (02134 would lose its zero)", { postal: 12345 }, {}],
    ["controls become spaces, runs collapse", { name: `Pat${NUL}${BEL}Example`, address: "12 Main St\r\n\tApt 4" }, { name: "Pat Example", address: "12 Main St Apt 4" }],
    ["a C1 control too", { address: `12 Main${NEL}St` }, { address: "12 Main St" }],
    ["the street capped at 60", { address: "1".repeat(75) }, { address: "1".repeat(60) }],
    ["the name capped at 60", { name: "N".repeat(61) }, { name: "N".repeat(60) }],
    ["blank is absent, not empty", { name: "   ", address: "\n", postal: "" }, {}],
    ["non-strings are absent", { name: 5, address: { x: 1 }, postal: null }, {}],
    ["no body", null, {}],
    ["not an object", "12345", {}],
    ["other keys are ignored", { name: "Pat", cvv2: "123", street: "nope", zip: "12345" }, { name: "Pat" }],
  ];
  for (const [label, raw, want] of cases) {
    const got = cp.cpBillingFields(raw);
    check(label, JSON.stringify(got) === JSON.stringify(want), `${JSON.stringify(got)} vs ${JSON.stringify(want)}`);
  }
});

Deno.test("ecomind: E by default, NONE on a swipe (null), and never R", async () => {
  // CardPointe defines R as RECURRING. Every swipe used to go out as "R".
  check("default E", (await sentBody(REQ)).body.ecomind === "E");
  const swipe = (await sentBody({ ...REQ, ecomind: null })).body;
  check("a swipe sends none", !("ecomind" in swipe), JSON.stringify(Object.keys(swipe)));
  check("T when asked", (await sentBody({ ...REQ, ecomind: "T" })).body.ecomind === "T");
});

Deno.test("cpAuthFieldNames is exactly the keys /auth is sent, sorted, and never a value", async () => {
  const req = { ...REQ, name: "Pat Example", address: "12 Main St", postal: "12345", expiry: "203212" };
  const { body } = await sentBody(req);
  const names = cp.cpAuthFieldNames(req);
  check("same keys as the wire", JSON.stringify(names) === JSON.stringify(Object.keys(body).sort()), `${names} vs ${Object.keys(body)}`);
  check("sorted", JSON.stringify(names) === JSON.stringify([...names].sort()));
  check("carries the billing names", ["address", "name", "postal"].every((k) => names.includes(k)), String(names));
  const joined = names.join(",");
  for (const v of [REQ.account, REQ.merchant.merchid, "Pat Example", "12 Main St", "12345", "1232"]) {
    check(`no value (${v}) in the list`, !joined.includes(v), joined);
  }
  // A swipe's list says ecomind was NOT sent; a malformed ZIP is not listed because it is not sent.
  const swipeNames = cp.cpAuthFieldNames({ ...REQ, ecomind: null, postal: "1234" });
  check("swipe: no ecomind listed", !swipeNames.includes("ecomind"), String(swipeNames));
  check("dropped ZIP: no postal listed", !swipeNames.includes("postal"), String(swipeNames));
});

Deno.test("a DECLINE carries its AVS/CVV answer; anything else carries none", async () => {
  const { error } = await sentBody(REQ, { respstat: "C", respcode: "82", resptext: "CVV mismatch", avsresp: "Y", cvvresp: "N" });
  check("declined", error !== null && !cp.isGatewayUnknown(error), String(error?.message));
  check("still the gateway's sentence", String(error?.message) === "CVV mismatch", String(error?.message));
  const v = cp.cpDeclineVerification(error);
  check("verification rides on the decline", JSON.stringify(v) === JSON.stringify({ respcode: "82", avsresp: "Y", cvvresp: "N" }), JSON.stringify(v));
  check("an UNKNOWN carries none", cp.cpDeclineVerification(new Error("GATEWAY_UNKNOWN: x")) === null);
  check("nothing carries none", cp.cpDeclineVerification(null) === null);
  check("cpVerification reads blanks as null", JSON.stringify(cp.cpVerification({ avsresp: " ", cvvresp: 3 })) === JSON.stringify({ respcode: null, avsresp: null, cvvresp: null }));
});
