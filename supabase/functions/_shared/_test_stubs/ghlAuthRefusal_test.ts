// A CRM credential the vendor refuses is a REFUSAL, not a fault — tested against the SHIPPED
// edge-function sources.
//
// Why this test exists. A tenant's saved GoHighLevel key can stop working (invalid, rotated,
// out of scope), and every call made with it then answers 401 or 403 until someone re-saves it.
// Before this, each of those answers filed a severity='error' row, so a Settings visit or a
// test quote on one such tenant kept putting "faults" in the queue that no code change could
// fix, and submit-estimate told the shopper to "try again in a moment" with a 502 — which a
// retry can never satisfy, and which the beta designer reads as "might have been issued", so it
// dropped the customer's draft.
//
// What is pinned, per call site:
//   submit-estimate, step 3 contact upsert — 401/403 answers 400 and files info, in shopper-first
//     words that name neither the vendor nor the credential and never suggest retrying; every
//     other status keeps the 502 fault. The refusal sits before anything is issued.
//   portal-settings list_ghl_pipelines     — 401/403 files info, anything else error.
//   portal-settings verify_save_ghl        — below 500 files info (the builder's own input being
//     refused), 5xx files error.
//   capture-lead GHL upsert                — 401/403 files info, anything else error; response
//     unchanged.
//
// Same technique as captureLeadGuards_test / wallSlab_test: lift the real failure block out of
// the shipped file between stable anchors, fail loudly if an anchor moves, then RUN it against
// stubs. A copy of the logic here would keep passing while the real file drifted.

import { assert, assertEquals } from "jsr:@std/assert";

// CRLF-normalised: *.ts is not pinned to eol=lf, so a Windows checkout reads CRLF.
const read = async (rel: string) =>
  (await Deno.readTextFile(new URL(rel, import.meta.url))).replace(/\r\n/g, "\n");

const SUBMIT = await read("../../submit-estimate/index.ts");
const SETTINGS = await read("../../portal-settings/index.ts");
const CAPTURE = await read("../../capture-lead/index.ts");

// Index just past the "}" that closes the "{" at `open`. Skips strings, template literals (with
// nested ${ }) and comments, so an apostrophe or a brace inside any of them cannot end it early.
function closeOf(src: string, open: number): number {
  const modes: ("code" | "tpl")[] = ["code"];
  const depths: number[] = [0];
  let k = open;
  while (k < src.length) {
    const c = src[k];
    if (modes[modes.length - 1] === "tpl") {
      if (c === "\\") { k += 2; continue; }
      if (c === "`") { modes.pop(); k++; continue; }
      if (c === "$" && src[k + 1] === "{") { modes.push("code"); depths.push(0); k += 2; continue; }
      k++;
      continue;
    }
    if (c === "/" && src[k + 1] === "/") { const e = src.indexOf("\n", k); k = e < 0 ? src.length : e; continue; }
    if (c === "/" && src[k + 1] === "*") { const e = src.indexOf("*/", k + 2); k = e < 0 ? src.length : e + 2; continue; }
    if (c === '"' || c === "'") {
      k++;
      while (k < src.length && src[k] !== c) k += src[k] === "\\" ? 2 : 1;
      k++;
      continue;
    }
    if (c === "`") { modes.push("tpl"); k++; continue; }
    if (c === "{") { depths[depths.length - 1]++; k++; continue; }
    if (c === "}") {
      if (depths.length > 1 && depths[depths.length - 1] === 0) { depths.pop(); modes.pop(); k++; continue; }
      depths[depths.length - 1]--;
      if (depths.length === 1 && depths[0] === 0) return k + 1;
      k++;
      continue;
    }
    k++;
  }
  return -1;
}

type Lifted = { body: string; start: number };

// The body of the `head {` block that is the LAST one opening before `anchor`, and that
// actually contains it.
function lift(src: string, file: string, head: string, anchor: string): Lifted {
  const a = src.indexOf(anchor);
  const h = a < 0 ? -1 : src.lastIndexOf(head, a);
  const open = h < 0 ? -1 : h + head.length - 1;
  const end = open < 0 || src[open] !== "{" ? -1 : closeOf(src, open);
  if (a < 0 || h < 0 || end < 0 || end <= a) {
    throw new Error(
      `ghlAuthRefusal_test: could not lift the \`${head}\` block around ${JSON.stringify(anchor)} in ` +
        `${file} (anchor=${a}, head=${h}, end=${end}). The anchor moved — re-point it rather than ` +
        "deleting this test.",
    );
  }
  return { body: src.slice(open + 1, end - 1), start: h };
}

// deno-lint-ignore no-explicit-any
type Call = Record<string, any>;
type Result = { status: number; payload: Call; calls: Call[] };

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const PARAMS = ["r", "prodStatus", "prodBody", "logEdgeError", "json", "req", "clientId", "designId", "businessName", "console"];
const RAW = "vendor body naming location LOC123 and its account";
const BUSINESS = "Example Sheds";

async function runBlock(block: Lifted, status: number): Promise<Result> {
  const calls: Call[] = [];
  let fn;
  try {
    fn = new AsyncFunction(...PARAMS, block.body);
  } catch (e) {
    throw new Error(
      "ghlAuthRefusal_test: a lifted CRM-failure block no longer parses as plain JS " +
        `(${(e as Error).message}). Keep TypeScript-only syntax out of it, or move it outside the block.`,
    );
  }
  const out = await fn(
    { ok: false, status, text: () => Promise.resolve(RAW) },
    status,
    RAW,
    (input: Call) => { calls.push(input); return Promise.resolve(); },
    (payload: Call, s = 200) => ({ status: s, payload }),
    new Request("https://edge.invalid/fn"),
    "tenant-under-test",
    "SS-TEST",
    BUSINESS,
    { warn() {}, log() {}, error() {} },
  );
  if (!out || typeof out.status !== "number") {
    throw new Error("ghlAuthRefusal_test: the lifted block did not return a json(...) response");
  }
  return { status: out.status, payload: out.payload, calls };
}

// logEdgeError defaults a missing severity to "error" (logError.ts), so absent means error.
const severityOf = (c: Call) => c.severity ?? "error";

const AUTH = [401, 403];
const OTHER_4XX = [400, 404, 408, 409, 422, 429];
const FAULTS = [500, 502, 503, 504];

// ── submit-estimate ──────────────────────────────────────────────────────────────────────
const SUBMIT_BLOCK = lift(
  SUBMIT,
  "submit-estimate/index.ts",
  "if (!r.ok) {",
  "code: `ghl_contact_upsert_${r.status}`",
);

Deno.test("submit-estimate: a refused CRM credential is a 400 refusal filed as info", async () => {
  for (const status of AUTH) {
    const { status: s, payload, calls } = await runBlock(SUBMIT_BLOCK, status);
    assertEquals(s, 400, `HTTP ${status} from the CRM must answer 400, not a fault`);
    assertEquals(calls.length, 1, "exactly one row is filed");
    assertEquals(severityOf(calls[0]), "info");
    assertEquals(calls[0].code, `ghl_contact_upsert_${status}`);
    assert(String(calls[0].message).includes(RAW), "the raw vendor body still reaches the log");

    const text = String(payload.error || "");
    assert(text.includes(BUSINESS), "the shopper is told which business to contact");
    assert(!/GoHighLevel|HighLevel|\bGHL\b|LeadConnector/i.test(text), `names the vendor: ${text}`);
    assert(!/API key|\btoken\b|credential/i.test(text), `names the credential: ${text}`);
    assert(!/try again/i.test(text), `a retry cannot work, so it must not suggest one: ${text}`);
    assert(!text.includes(RAW), "the vendor body never reaches the browser");
  }
});

Deno.test("submit-estimate: every other CRM failure keeps the 502 fault path", async () => {
  for (const status of [...OTHER_4XX, ...FAULTS]) {
    const { status: s, payload, calls } = await runBlock(SUBMIT_BLOCK, status);
    assertEquals(s, 502, `HTTP ${status} from the CRM stays a 502`);
    assertEquals(calls.length, 1);
    assertEquals(severityOf(calls[0]), "error", `HTTP ${status} stays an error row`);
    assert(!String(payload.error || "").includes(RAW));
  }
});

Deno.test("submit-estimate: the refusal returns before anything is issued", () => {
  // The beta designer keeps the draft on a 4xx because the server refuses before it issues.
  // A 400 that could come after an opportunity, an estimate or the promotion would break that.
  for (const needle of ["promoteIssuedDesign(", "leadconnectorhq.com/opportunities", "leadconnectorhq.com/invoices"]) {
    const k = SUBMIT.indexOf(needle);
    assert(k > 0, `ghlAuthRefusal_test: "${needle}" is no longer in submit-estimate/index.ts — re-point this anchor`);
    assert(SUBMIT_BLOCK.start < k, `the credential refusal must sit before the first ${needle}`);
  }
});

// ── portal-settings ──────────────────────────────────────────────────────────────────────
const PIPELINES_BLOCK = lift(
  SETTINGS,
  "portal-settings/index.ts",
  "if (!r.ok) {",
  "list_ghl_pipelines: GoHighLevel rejected the pipelines fetch",
);
const VERIFY_BLOCK = lift(
  SETTINGS,
  "portal-settings/index.ts",
  "if (!prodOk) {",
  "verify_save_ghl: GoHighLevel rejected the products probe",
);

Deno.test("portal-settings list_ghl_pipelines: 401/403 files info, anything else error", async () => {
  for (const status of AUTH) {
    const { status: s, calls } = await runBlock(PIPELINES_BLOCK, status);
    assertEquals(s, 400, "the response is unchanged");
    assertEquals(calls.length, 1);
    assertEquals(severityOf(calls[0]), "info", `HTTP ${status}`);
  }
  for (const status of [...OTHER_4XX, ...FAULTS]) {
    const { calls } = await runBlock(PIPELINES_BLOCK, status);
    assertEquals(calls.length, 1);
    assertEquals(severityOf(calls[0]), "error", `HTTP ${status}`);
  }
});

Deno.test("portal-settings verify_save_ghl: below 500 is the builder's input (info), 5xx is a fault", async () => {
  for (const status of [...AUTH, ...OTHER_4XX]) {
    const { status: s, calls } = await runBlock(VERIFY_BLOCK, status);
    assertEquals(s, 400, "the response is unchanged");
    assertEquals(calls.length, 1);
    assertEquals(severityOf(calls[0]), "info", `HTTP ${status}`);
  }
  for (const status of FAULTS) {
    const { calls } = await runBlock(VERIFY_BLOCK, status);
    assertEquals(calls.length, 1);
    assertEquals(severityOf(calls[0]), "error", `HTTP ${status}`);
  }
});

// ── capture-lead ─────────────────────────────────────────────────────────────────────────
const CAPTURE_BLOCK = lift(
  CAPTURE,
  "capture-lead/index.ts",
  "if (!r.ok) {",
  "code: `ghl_${r.status}`",
);

Deno.test("capture-lead: 401/403 files info, anything else error; the response is unchanged", async () => {
  for (const status of [...AUTH, ...OTHER_4XX, ...FAULTS]) {
    const { status: s, payload, calls } = await runBlock(CAPTURE_BLOCK, status);
    assertEquals(s, 200, "the gate never blocks");
    assertEquals(payload, { ok: true, captured: false, reason: `ghl_${status}` });
    assertEquals(calls.length, 1);
    assertEquals(calls[0].code, `ghl_${status}`);
    assertEquals(calls[0].context?.ghlStatus, status, "the row keeps its vendor status");
    assertEquals(severityOf(calls[0]), AUTH.includes(status) ? "info" : "error", `HTTP ${status}`);
  }
});
