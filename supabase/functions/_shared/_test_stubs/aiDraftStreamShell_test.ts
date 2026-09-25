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
//   3. A streamed answer that never arrived -- the body broke off, or the server closed it at its
//      deadline with `stream_deadline` -- is NOT "try again": the shell polls
//      calibrate_style_ai_recover (since = the press's start, recorded before it was sent) until the
//      draft comes back, which it returns exactly as the answer would have been; until the server says
//      it never will (its sentence, not retryable); or until the press's budget, and it stops the
//      moment the designer goes away. Never for the lean retry, never without the designer's hooks.
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

// ─── A streamed answer that never arrived: picked up from the server (2026-09-25) ──────────────
// The ways a streamed press can lose its answer: the body broke off (the JSON parser's error, or the
// body read's), or the server closed it at its own deadline with `stream_deadline`.
const DROPS: [string, () => { data: unknown; error: unknown }][] = [
  ["the body broke off (SyntaxError)", () => ({ data: null, error: { name: "SyntaxError", message: "Unexpected end of JSON input" } })],
  ["the body read failed (TypeError)", () => ({ data: null, error: { name: "TypeError", message: "network error" } })],
  ["the server's deadline (stream_deadline)", () => ({ data: { error: "The draft is taking longer than this connection can wait.", code: "stream_deadline", status: 504 }, error: null })],
];
const SUCCESS = { ok: true, d3: { roof: { type: "gable", pitch: 0.5 } }, frames: 2, dropped: 0, observed: { roofNote: "a gable" }, balanceCents: 6000, dims: DIMS, frameMap: { front: { frame: 1, azimuthDeg: 0 } }, checkId: "11111111-2222-4333-8444-555555555555" };
// What calibrate_style_ai_recover answers with a draft: the success, rebuilt from the ledger row.
const RECOVERED = { ...SUCCESS, dropped: null, balanceCents: null, frameMap: null, recovered: true };
const PENDING = { ok: true, pending: true };

// The shell with the poll a thousand times faster, and a designer's `recover` hooks.
async function withFastPoll<T>(body: () => Promise<T>): Promise<T> {
  const g = globalThis as any;
  const had = "window" in g;
  const saved = g.window;
  g.window = { __ssRecoverPollMs: 5 };
  try { return await body(); } finally {
    if (had) g.window = saved;
    else delete g.window;
  }
}
function recoverHooks(o: { untilMs?: number; aliveFor?: number } = {}) {
  const hooks = { recovering: 0, checks: 0 };
  const recover = {
    alive: () => { hooks.checks++; return o.aliveFor === undefined || hooks.checks <= o.aliveFor; },
    until: Date.now() + (o.untilMs ?? 5_000),
    onRecovering: () => { hooks.recovering++; },
  };
  return { hooks, recover };
}
// A server that drops the press's answer and then answers the recover polls in turn.
function droppingServer(drop: () => { data: unknown; error: unknown }, polls: ({ data: unknown; error: unknown } | "throw")[]) {
  const seen: { at: number; body: Record<string, unknown> }[] = [];
  let n = 0;
  const { draft, sent } = shellWith((body) => {
    seen.push({ at: Date.now(), body });
    if (body.action === "calibrate_style_ai") return drop();
    const next = polls[Math.min(n++, polls.length - 1)];
    if (next === "throw") throw new TypeError("Failed to fetch");
    return next;
  });
  return { draft, sent, seen };
}

Deno.test("a streamed answer that never arrived is picked up from the server, and returned exactly as the answer would have been", async () => {
  // The envelope a normal answer becomes, for comparison.
  const normal = await shellWith(() => ({ data: SUCCESS, error: null })).draft(URLS, "farm", 2, "key-1", DIMS);
  for (const [what, drop] of DROPS) {
    await withFastPoll(async () => {
      const { hooks, recover } = recoverHooks();
      const { draft, seen } = droppingServer(drop, [{ data: PENDING, error: null }, "throw", { data: { error: "busy" }, error: { name: "FunctionsHttpError", message: "busy" } }, { data: RECOVERED, error: null }]);
      const got = await draft(URLS, "farm", 2, "key-1", DIMS, { recover });
      // Exactly the normal envelope: the same draft, the same notes, measurements and check id; the
      // frame map (not on the ledger row) is null, so the designer skips the check and says why.
      assertEquals(got, { ...normal, frameMap: null, recovered: true }, what);
      assertEquals(Object.keys(got), [...Object.keys(normal), "recovered"], `${what}: the same keys, in order`);
      assertEquals(got.dropped, 0, `${what}: worked out from what was sent (2 sent, 2 read)`);
      assertEquals(hooks.recovering, 1, `${what}: the card switched to the pickup once`);
      // The press went out once, streamed; then it polled -- through a pending, a poll that threw and a
      // poll the server refused -- until the draft was there, and stopped.
      const press = seen.filter((s) => s.body.action === "calibrate_style_ai");
      const polls = seen.filter((s) => s.body.action === "calibrate_style_ai_recover");
      assertEquals(press.length, 1, what);
      assertEquals(press[0].body.stream, true, what);
      assertEquals(polls.length, 4, `${what}: until the draft, and not once more`);
      for (const p of polls) {
        assertEquals(Object.keys(p.body), ["action", "styleValue", "since", "clientNow"], what);
        assertEquals(p.body.styleValue, "farm");
        // `since` was recorded BEFORE the press was sent, so the press's own ledger row is after it.
        assert(Date.parse(String(p.body.since)) <= press[0].at, `${what}: since is before the press went out`);
        assert(typeof p.body.clientNow === "number", "the browser's clock, so the server can line the two up");
      }
    });
  }
});

Deno.test("a server that says the draft will never come: its sentence, not retryable, and the polling stops", async () => {
  await withFastPoll(async () => {
    const { recover } = recoverHooks();
    const said = "We could not pick the draft up from the server: that generation did not finish, so you are not charged for it. Press Generate to try again.";
    const { draft, seen } = droppingServer(DROPS[0][1], [{ data: PENDING, error: null }, { data: { ok: true, pending: false, message: said }, error: null }, { data: RECOVERED, error: null }]);
    let err: any = null;
    try { await draft(URLS, "farm", 2, "key-1", DIMS, { recover }); } catch (e) { err = e; }
    assertEquals(err && err.message, said);
    assert(!(err && err.ssRetryable), "never the automatic lean retry: that would be a second model call");
    assertEquals(seen.filter((s) => s.body.action === "calibrate_style_ai_recover").length, 2, "no poll after the answer");
  });
});

Deno.test("the press's budget runs out: a plain sentence, no 'try again', and no poll past the deadline", async () => {
  await withFastPoll(async () => {
    const { recover } = recoverHooks({ untilMs: 40 });
    const { draft, seen } = droppingServer(DROPS[2][1], [{ data: PENDING, error: null }]);
    let err: any = null;
    const t = Date.now();
    try { await draft(URLS, "farm", 2, "key-1", DIMS, { recover }); } catch (e) { err = e; }
    assert(err && /did not reach us in time/.test(err.message) && /not charge you twice/.test(err.message), err && err.message);
    assert(!/try again/i.test(err.message), "never 'try again' for a press that may have finished");
    assert(!(err && err.ssRetryable));
    const polls = seen.filter((s) => s.body.action === "calibrate_style_ai_recover");
    // The last wait is cut to end AT the deadline, so the last poll is the deadline's own (a timer can
    // run a tick late: Windows' is ~16 ms). None is sent after it.
    assert(polls.length >= 1 && polls.every((p) => p.at <= recover.until + 50), `polled only inside the budget: ${polls.map((p) => p.at - recover.until).join(", ")} ms`);
    const n = polls.length;
    await new Promise((r) => setTimeout(r, 30));
    assertEquals(seen.filter((s) => s.body.action === "calibrate_style_ai_recover").length, n, "and none after it gave up");
    assert(Date.now() - t < 1_000, "and gave up at the deadline, not later");
  });
});

Deno.test("the designer goes away (or another press takes over): the polling stops at once", async () => {
  await withFastPoll(async () => {
    // alive() answers true for the first check only: the poll that follows it is the last.
    const { recover } = recoverHooks({ aliveFor: 1 });
    const { draft, seen } = droppingServer(DROPS[0][1], [{ data: PENDING, error: null }]);
    let err: any = null;
    try { await draft(URLS, "farm", 2, "key-1", DIMS, { recover }); } catch (e) { err = e; }
    assert(err instanceof Error, "the press ends");
    const polls = seen.filter((s) => s.body.action === "calibrate_style_ai_recover").length;
    assertEquals(polls, 1, "one poll, then nothing");
    await new Promise((r) => setTimeout(r, 30));
    assertEquals(seen.filter((s) => s.body.action === "calibrate_style_ai_recover").length, 1, "and nothing later either");
  });
});

Deno.test("no pickup for the lean retry, nor for a designer without the hooks; neither says 'try again' for a streamed drop", async () => {
  await withFastPoll(async () => {
    // The lean retry is not streamed, so its transport failures read as they always have.
    const lean = droppingServer(DROPS[0][1], [{ data: RECOVERED, error: null }]);
    let err: any = null;
    try { await lean.draft(URLS, "farm", 2, "key-1", DIMS, { lean: true, recover: recoverHooks().recover }); } catch (e) { err = e; }
    assertEquals(err && err.message, "Unexpected end of JSON input");
    assertEquals(lean.seen.filter((s) => s.body.action === "calibrate_style_ai_recover").length, 0, "the lean retry never polls");
    // A designer that never passes `recover` (an older one): said plainly, not polled, not retried.
    for (const [what, drop] of DROPS) {
      const old = droppingServer(drop, [{ data: RECOVERED, error: null }]);
      err = null;
      try { await old.draft(URLS, "farm", 2, "key-1", DIMS); } catch (e) { err = e; }
      assert(err && /connection dropped before the draft arrived/.test(err.message), `${what}: ${err && err.message}`);
      assert(!/try again/i.test(err.message), what);
      assert(!(err && err.ssRetryable), what);
      assertEquals(old.seen.filter((s) => s.body.action === "calibrate_style_ai_recover").length, 0, what);
    }
  });
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
