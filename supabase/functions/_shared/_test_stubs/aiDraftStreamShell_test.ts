// The new portal shell's half of the STREAMED v2 draft (2026-09-25). The server's half, driven
// through the shipped handler, is aiDraftStreamWiring_test.
//
// The server answers a streamed draft 200 at once and writes the JSON last, so a failure arrives
// as a 200 whose body carries the status it would have had. What the shell must get right, pinned
// here by RUNNING the shipped onDraftFromCombined against a stand-in supabase client:
//
//   1. It asks for `stream: true` on a press and never on the lean retry (a short read that keeps
//      the old 125 s budget), and the server streams exactly the first of those two bodies.
//   2. A failure in a streamed body becomes exactly the Error a non-2xx becomes: the same sentence,
//      the same `ssRetryable`, and nothing else, so calGenerate's one lean retry under the same key
//      cannot tell them apart. (calIdempotency drives that retry in the compiled portal.)
//   3. A streamed body that broke off mid-way is said plainly and not retried.
//   4. 01-core's invoke wrapper files a streamed refusal under the status it carries, so a 402 in a
//      body stays an info row rather than a fault; and a page leave that kills a streamed BODY
//      (TypeError / AbortError from the read) is the navigation abort, like a FunctionsFetchError.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { wantsStreamedDraft } from "../styleD3.ts";

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const SHELL = await read("../../../../portal/12-shell.jsx");
const CORE = await read("../../../../portal/01-core.jsx");

function lift(src: string, start: string, end: string, what: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i + start.length);
  if (i < 0 || j < 0) {
    throw new Error(
      `aiDraftStreamShell_test: could not find ${what} (start=${i}, end=${j}). ` +
        "The anchors moved — re-point them rather than deleting this test.",
    );
  }
  return src.slice(i, j);
}

const DIMS = { widthFt: 30, lengthFt: 20, wallHeightFt: 8 };

const DRAFT_FN = lift(SHELL, "onDraftFromCombined: async (", "\n    /* THE FREE SECOND PASS", "onDraftFromCombined").trim().replace(/,$/, "").replace(/^onDraftFromCombined:\s*/, "");
function shellWith(answer: (body: Record<string, unknown>) => { data: unknown; error: unknown }) {
  const sent: Record<string, unknown>[] = [];
  const sb = { functions: { invoke: (_n: string, o: { body: Record<string, unknown> }) => { sent.push(o.body); return Promise.resolve(answer(o.body)); } } };
  const draft = new Function("sb", `return (${DRAFT_FN});`)(sb) as (...a: unknown[]) => Promise<any>;
  return { draft, sent };
}
const URLS = ["https://example.test/f1.jpg", "https://example.test/f2.jpg"];

Deno.test("the shell asks for a stream on a press, and never on the lean retry", async () => {
  const { draft, sent } = shellWith(() => ({ data: { ok: true, d3: { roof: { type: "shed" } } }, error: null }));
  await draft(URLS, "farm", 2, "key-1", DIMS);
  await draft(URLS, "farm", 2, "key-1", DIMS, { lean: true });
  assertEquals(sent[0].stream, true);
  assert(!("lean" in sent[0]));
  assertEquals(sent[1].lean, true);
  assert(!("stream" in sent[1]), "the lean retry is a plain request");
  for (const b of sent) assertEquals([b.frame, b.idempotencyKey], ["front", "key-1"]);
  // And what the server makes of those two bodies: the first streams, the retry does not.
  assertEquals(wantsStreamedDraft(sent[0]), true);
  assertEquals(wantsStreamedDraft(sent[1]), false);
});

Deno.test("a failure in a streamed body is exactly the Error a non-2xx becomes", async () => {
  const failures: [Record<string, unknown>, number][] = [
    [{ error: "The AI took too long to answer - please try again.", retryable: true }, 504],
    [{ error: "The AI ran out of room before finishing - please try again.", retryable: true }, 502],
    [{ error: "The model returned malformed JSON." }, 502],
    [{ error: "This 3D generation costs $20.00 and your wallet has $5.00. Add funds in Settings → Billing.", code: "insufficient_funds", priceCents: 2000, balanceCents: 500 }, 402],
    [{ error: "A 3D generation is already running for this account - wait for it to finish." }, 409],
    [{ error: "We already charged you for this generation.", code: "already_charged" }, 409],
    [{ error: "Daily limit reached (10 AI drafts). Tune the sliders by hand, or try again tomorrow." }, 429],
    [{ error: "Internal Server Error" }, 500],
  ];
  const caught = async (answer: () => { data: unknown; error: unknown }) => {
    const { draft } = shellWith(answer);
    try { await draft(URLS, "farm", 2, "key-1", DIMS); } catch (e) { return e as Error & { ssRetryable?: boolean }; }
    throw new Error("it did not throw");
  };
  for (const [obj, status] of failures) {
    // Today's non-2xx, as 01-core's invoke wrapper hands it over: the server's sentence on the
    // message, the Response on context.
    const plain = await caught(() => ({ data: null, error: { name: "FunctionsHttpError", message: obj.error, context: new Response(JSON.stringify(obj), { status }) } }));
    // The streamed answer: a 200 whose parsed body carries the status.
    const streamed = await caught(() => ({ data: { ...obj, status }, error: null }));
    assertEquals(streamed.message, plain.message, `${status}: the same sentence`);
    assertEquals(streamed.ssRetryable === true, plain.ssRetryable === true, `${status}: the same retryable`);
    assertEquals(streamed.ssRetryable === true, obj.retryable === true);
    assertEquals(Object.keys(streamed), Object.keys(plain), `${status}: no other property on either`);
  }
});

Deno.test("a streamed body that broke off says so plainly, and is not retried", async () => {
  for (const name of ["SyntaxError", "TypeError"]) {
    const { draft } = shellWith(() => ({ data: null, error: { name, message: "Unexpected end of JSON input" } }));
    let err: any = null;
    try { await draft(URLS, "farm", 2, "key-1", DIMS); } catch (e) { err = e; }
    assertEquals(err && err.message, "The connection dropped before the answer arrived - please try again.");
    assert(!(err && err.ssRetryable), "not the automatic retry: the server may have charged");
  }
  // The lean retry is not streamed, so its transport failures read as they always have.
  const { draft } = shellWith(() => ({ data: null, error: { name: "SyntaxError", message: "Unexpected end of JSON input" } }));
  let err: any = null;
  try { await draft(URLS, "farm", 2, "key-1", DIMS, { lean: true }); } catch (e) { err = e; }
  assertEquals(err && err.message, "Unexpected end of JSON input");
});

Deno.test("01-core: a page leave that kills a streamed body mid-read is the navigation abort, not a fault", () => {
  const decl = lift(CORE, "const ssAborted = ssPageLeaving && st === null", ";\n", "the navigation-abort test") + ";";
  const aborted = (leaving: boolean, st: number | null, name: string) =>
    new Function("ssPageLeaving", "st", "res", `${decl}; return ssAborted;`)(leaving, st, { error: { name }, data: null }) as boolean;
  // Before the response: supabase-js's own error. During the body: the read's TypeError or AbortError.
  for (const name of ["FunctionsFetchError", "TypeError", "AbortError"]) {
    assertEquals(aborted(true, null, name), true, `${name} while leaving`);
    assertEquals(aborted(false, null, name), false, `${name} on a page that stays is still a fault`);
    assertEquals(aborted(true, 504, name), false, `${name} with a status the server sent is the server's`);
  }
  // A truncated body the parser choked on, or a refusal, is not the navigation's doing.
  for (const name of ["SyntaxError", "FunctionsHttpError", "FunctionsRelayError", ""]) {
    assertEquals(aborted(true, null, name), false, name || "no name");
  }
  assertEquals(new Function("ssPageLeaving", "st", "res", `${decl}; return ssAborted;`)(true, null, { error: null, data: { error: "x" } }), false, "no error object");
  // And the row it becomes: info, under its own code.
  const call = lift(CORE, "ssLogError(SS_ERR_SOURCE, (res.error && res.error.message) || (res.data && res.data.error),", "} catch (_) {}", "the log call");
  assert(call.includes('ssAborted ? "fetch_aborted_navigating"'), "its own code");
  assert(call.includes('(ssAborted || ssRefusal || (st >= 400 && st < 500)) ? "info" : "error"'), "filed as info");
});

Deno.test("01-core files a streamed refusal under the status it carries, so a 402 stays a refusal", () => {
  const decl = lift(CORE, "const st = (res.error && res.error.ssStatus)", ";\n", "the log status") + ";";
  const st = (res: unknown) => new Function("res", `${decl}; return st;`)(res);
  assertEquals(st({ error: { ssStatus: 402 }, data: null }), 402, "a non-2xx, as before");
  assertEquals(st({ error: null, data: { error: "x", status: 402 } }), 402, "a streamed refusal");
  assertEquals(st({ error: null, data: { error: "x", status: 504, retryable: true } }), 504);
  assertEquals(st({ error: null, data: { ok: true, status: 200 } }), null, "a success is no status");
  assertEquals(st({ error: null, data: { error: "x" } }), null, "an error body with no status, as before");
  assertEquals(st({ error: new Error("reconnecting"), data: null }), null);
});
