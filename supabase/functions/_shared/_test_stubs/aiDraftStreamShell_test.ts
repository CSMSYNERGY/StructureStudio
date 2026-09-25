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
//      deadline with `stream_deadline` -- is NOT "try again": the shell asks calibrate_style_ai_recover
//      with THE PRESS'S OWN idempotency key (never a clock), AT ONCE -- even for a drop noticed after
//      the press's budget -- and then every ten seconds while the server says pending and the budget
//      lasts, or, after an ask that FAILED (no answer, or a non-2xx), to at least a minute from the
//      first ask. It returns the draft exactly as the answer would have been, frame map included, so
//      the designer's check runs; takes the server's `pending: false` sentence (not retryable), except
//      a `no_row` while the press is under 90 s old; and stops the moment the designer goes away.
//      Never for the lean retry, a press with no key, or a designer without the hooks. Ending with no
//      verdict from the server files ONE client row: draft_recover_timeout (error) when the asking ran
//      out, draft_recover_abandoned (info) when the designer went away; a verdict files none.
//   4. 01-core's invoke wrapper files a streamed refusal under the status it carries, so a 402 in a
//      body stays an info row rather than a fault; a page leave that kills a streamed BODY
//      (TypeError / AbortError from the read) is the navigation abort, like a FunctionsFetchError;
//      and a dropped streamed draft on a page that STAYS is one info row, draft_stream_dropped (the
//      server's pickup rows carry what became of it).

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
// The client rows the shell files through 01-core's ssLogError, kept here to be read.
type Logged = { code: unknown; severity: unknown; context: any };
function shellWith(answer: (body: Record<string, unknown>) => { data: unknown; error: unknown }) {
  const sent: Record<string, unknown>[] = [];
  const logged: Logged[] = [];
  const sb = { functions: { invoke: (_n: string, o: { body: Record<string, unknown> }) => { sent.push(o.body); return Promise.resolve(answer(o.body)); } } };
  const ssLogError = (_source: unknown, _message: unknown, code: unknown, context: unknown, severity: unknown) => { logged.push({ code, severity, context }); };
  const draft = new Function("sb", "ssLogError", `return (${DRAFT_FN});`)(sb, ssLogError) as (...a: unknown[]) => Promise<any>;
  return { draft, sent, logged };
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

// ─── A streamed answer that never arrived: picked up from the server by the press's key ────────
// The ways a streamed press can lose its answer: the body broke off (the JSON parser's error, or the
// body read's), or the server closed it at its own deadline with `stream_deadline`.
const DROPS: [string, () => { data: unknown; error: unknown }][] = [
  ["the body broke off (SyntaxError)", () => ({ data: null, error: { name: "SyntaxError", message: "Unexpected end of JSON input" } })],
  ["the body read failed (TypeError)", () => ({ data: null, error: { name: "TypeError", message: "network error" } })],
  ["the server's deadline (stream_deadline)", () => ({ data: { error: "The draft is taking longer than this connection can wait.", code: "stream_deadline", status: 504 }, error: null })],
];
const SUCCESS = { ok: true, d3: { roof: { type: "gable", pitch: 0.5 } }, frames: 2, dropped: 0, observed: { roofNote: "a gable" }, balanceCents: 6000, dims: DIMS, frameMap: { front: { frame: 1, azimuthDeg: 0 } }, checkId: "11111111-2222-4333-8444-555555555555" };
// What calibrate_style_ai_recover answers with a draft: the success, rebuilt from the ledger row,
// with the frame map the row kept (253).
const RECOVERED = { ...SUCCESS, dropped: null, balanceCents: null, recovered: true };
const PENDING = { ok: true, pending: true };
const NOT_CHARGED = "We could not pick the draft up from the server: that generation did not finish, so you are not charged for it. Press Generate to try again.";
const NO_ROW = { ok: true, pending: false, reason: "no_row", message: NOT_CHARGED };

// The shell with its hooks set: how long it waits between asks, and how long a `no_row` is waited on.
async function withHooks<T>(hooks: Record<string, number>, body: () => Promise<T>): Promise<T> {
  const g = globalThis as any;
  const had = "window" in g;
  const saved = g.window;
  g.window = hooks;
  try { return await body(); } finally {
    if (had) g.window = saved;
    else delete g.window;
  }
}
const withFastPoll = <T>(body: () => Promise<T>) => withHooks({ __ssRecoverPollMs: 5 }, body);
function recoverHooks(o: { untilMs?: number; aliveFor?: number } = {}) {
  const hooks = { recovering: 0, checks: 0 };
  const recover = {
    alive: () => { hooks.checks++; return o.aliveFor === undefined || hooks.checks <= o.aliveFor; },
    until: Date.now() + (o.untilMs ?? 5_000),
    onRecovering: () => { hooks.recovering++; },
  };
  return { hooks, recover };
}
// A server that drops the press's answer and then answers the recover asks in turn.
function droppingServer(drop: () => { data: unknown; error: unknown }, polls: ({ data: unknown; error: unknown } | "throw")[]) {
  const seen: { at: number; body: Record<string, unknown> }[] = [];
  let n = 0;
  const { draft, sent, logged } = shellWith((body) => {
    seen.push({ at: Date.now(), body });
    if (body.action === "calibrate_style_ai") return drop();
    const next = polls[Math.min(n++, polls.length - 1)];
    if (next === "throw") throw new TypeError("Failed to fetch");
    return next;
  });
  const asks = () => seen.filter((s) => s.body.action === "calibrate_style_ai_recover");
  return { draft, sent, seen, asks, logged };
}
const rowsOf = (logged: Logged[]) => logged.map((l) => [l.code, l.severity, l.context && l.context.asks, l.context && l.context.last]);
const UNAVAILABLE = { data: null, error: { name: "FunctionsHttpError", message: "We could not check on your draft just now." } };
const said = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as Error & { ssRetryable?: boolean }; } throw new Error("it did not throw"); };

Deno.test("a streamed answer that never arrived is picked up BY THE PRESS'S KEY, and returned exactly as the answer would have been, frame map and all", async () => {
  // The envelope a normal answer becomes, for comparison.
  const normal = await shellWith(() => ({ data: SUCCESS, error: null })).draft(URLS, "farm", 2, "key-1", DIMS);
  for (const [what, drop] of DROPS) {
    await withFastPoll(async () => {
      const { hooks, recover } = recoverHooks();
      const { draft, seen, asks, logged } = droppingServer(drop, [{ data: PENDING, error: null }, "throw", { data: { error: "busy" }, error: { name: "FunctionsHttpError", message: "busy" } }, { data: RECOVERED, error: null }]);
      const got = await draft(URLS, "farm", 2, "key-1", DIMS, { recover });
      // Exactly the normal envelope, frame map included, so the designer's free check RUNS on it.
      assertEquals(got, { ...normal, recovered: true }, what);
      assertEquals(got.frameMap, SUCCESS.frameMap, `${what}: the check has its map`);
      assertEquals(Object.keys(got), [...Object.keys(normal), "recovered"], `${what}: the same keys, in order`);
      assertEquals(got.dropped, 0, `${what}: worked out from what was sent (2 sent, 2 read)`);
      assertEquals(hooks.recovering, 1, `${what}: the card switched to the pickup once`);
      // The press went out once, streamed; then it asked -- through a pending, an ask that threw and an
      // ask the server refused -- until the draft was there, and stopped.
      const press = seen.filter((s) => s.body.action === "calibrate_style_ai");
      assertEquals(press.length, 1, what);
      assertEquals(press[0].body.stream, true, what);
      assertEquals(asks().length, 4, `${what}: until the draft, and not once more`);
      assertEquals(logged, [], `${what}: a draft files no client row (the server files ai_draft_recovered)`);
      for (const p of asks()) {
        // THE KEY, and nothing about any clock: no since, no clientNow.
        assertEquals(p.body, { action: "calibrate_style_ai_recover", styleValue: "farm", idempotencyKey: "key-1" }, what);
        assertEquals(p.body.idempotencyKey, press[0].body.idempotencyKey, `${what}: the press's own key`);
      }
    });
  }
  // A row that kept no map (written before 253): the envelope says so, and the designer skips the check.
  await withFastPoll(async () => {
    const { recover } = recoverHooks();
    const { draft } = droppingServer(DROPS[0][1], [{ data: { ...RECOVERED, frameMap: null }, error: null }]);
    const got = await draft(URLS, "farm", 2, "key-1", DIMS, { recover });
    assertEquals([got.recovered, got.frameMap], [true, null]);
  });
});

Deno.test("⚠️ the first ask goes AT ONCE after the drop, not a poll interval later", async () => {
  // Ten minutes between asks: a pickup that waited for the interval first would never finish here.
  await withHooks({ __ssRecoverPollMs: 600_000 }, async () => {
    for (const [what, drop] of DROPS) {
      const { recover } = recoverHooks({ untilMs: 3_600_000 });
      const { draft, seen, asks } = droppingServer(drop, [{ data: RECOVERED, error: null }]);
      const t = Date.now();
      const got = await draft(URLS, "farm", 2, "key-1", DIMS, { recover });
      assertEquals(got.recovered, true, what);
      assertEquals(asks().length, 1, what);
      assert(asks()[0].at - seen[0].at < 1_000 && Date.now() - t < 1_000, `${what}: asked at once`);
    }
  });
});

Deno.test("⚠️ a drop noticed AFTER the press's budget still asks once -- and applies the draft that is there", async () => {
  await withFastPoll(async () => {
    for (const [what, drop] of DROPS) {
      // `until` is long gone: a phone that slept through the whole press.
      const late = () => ({ ...recoverHooks().recover, until: Date.now() - 60_000 });
      const found = droppingServer(drop, [{ data: RECOVERED, error: null }]);
      const got = await found.draft(URLS, "farm", 2, "key-1", DIMS, { recover: late() });
      assertEquals([got.recovered, got.frameMap, found.asks().length], [true, SUCCESS.frameMap, 1], `${what}: the paid draft, applied`);
      // Still running: one ask, and then the budget's sentence -- never a second ask past `until`.
      const running = droppingServer(drop, [{ data: PENDING, error: null }]);
      const err = await said(running.draft(URLS, "farm", 2, "key-1", DIMS, { recover: late() }));
      assert(/did not reach us in time/.test(err.message) && /not charge you twice/.test(err.message), `${what}: ${err.message}`);
      assertEquals(running.asks().length, 1, `${what}: exactly one ask`);
      // The server says it will never come: its own sentence.
      const gone = droppingServer(drop, [{ data: { ok: true, pending: false, reason: "failed", message: NOT_CHARGED }, error: null }]);
      assertEquals((await said(gone.draft(URLS, "farm", 2, "key-1", DIMS, { recover: late() }))).message, NOT_CHARGED, what);
    }
  });
});

Deno.test("⚠️ a late drop whose first ask FAILS asks again (to a minute from the first ask), and the second ask's draft is applied", async () => {
  await withFastPoll(async () => {
    for (const [what, drop] of DROPS) {
      for (const [how, fail] of [["the ask threw", "throw"], ["the ask got a 503", UNAVAILABLE]] as [string, "throw" | typeof UNAVAILABLE][]) {
        // `until` is long gone, and the first ask gets no word from the server.
        const late = { ...recoverHooks().recover, until: Date.now() - 60_000 };
        const s = droppingServer(drop, [fail, { data: RECOVERED, error: null }]);
        const got = await s.draft(URLS, "farm", 2, "key-1", DIMS, { recover: late });
        assertEquals([got.recovered, got.frameMap, s.asks().length], [true, SUCCESS.frameMap, 2], `${what}, ${how}: the paid draft, on the second ask`);
        assertEquals(s.logged, [], `${what}, ${how}: a draft files no client row`);
      }
      // `until` alone still bounds a server that answers: a failed ask, then `pending`, past the
      // budget, is the end -- the minute is for asks that got no word, not for waiting on pending.
      const late = { ...recoverHooks().recover, until: Date.now() - 60_000 };
      const s = droppingServer(drop, ["throw", { data: PENDING, error: null }, { data: RECOVERED, error: null }]);
      const err = await said(s.draft(URLS, "farm", 2, "key-1", DIMS, { recover: late }));
      assert(/did not reach us in time/.test(err.message), `${what}: ${err.message}`);
      assertEquals(s.asks().length, 2, `${what}: no third ask past the budget on a pending answer`);
      assertEquals(rowsOf(s.logged), [["draft_recover_timeout", "error", 2, "pending"]], `${what}: one timeout row`);
    }
  });
});

Deno.test("asks that keep failing stop a minute after the first ask, with ONE draft_recover_timeout error row", async () => {
  await withFastPoll(async () => {
    const realNow = Date.now;
    let skew = 0;
    Date.now = () => realNow() + skew;
    try {
      // Every ask fails and moves the clock on 25 s: asked at 0, 25 and 50 s, and not at 75.
      const { draft, sent, logged } = shellWith((body) => {
        if (body.action === "calibrate_style_ai") return DROPS[0][1]();
        skew += 25_000;
        throw new TypeError("Failed to fetch");
      });
      const recover = { ...recoverHooks().recover, until: realNow() - 60_000 };
      const err = await said(draft(URLS, "farm", 2, "key-1", DIMS, { recover }));
      assert(/did not reach us in time/.test(err.message) && !err.ssRetryable, err.message);
      assertEquals(sent.filter((b) => b.action === "calibrate_style_ai_recover").length, 3);
      assertEquals(rowsOf(logged), [["draft_recover_timeout", "error", 3, "failed"]]);
      assertEquals([logged[0].context.fn, logged[0].context.action], ["portal-settings", "calibrate_style_ai_recover"]);
    } finally {
      Date.now = realNow;
    }
  });
});

Deno.test("no_row is waited on while the press is young (its row may not be written yet), then its sentence", async () => {
  // Young: two no_row answers, then the row lands with its draft.
  await withFastPoll(async () => {
    const { recover } = recoverHooks();
    const { draft, asks } = droppingServer(DROPS[0][1], [{ data: NO_ROW, error: null }, { data: NO_ROW, error: null }, { data: RECOVERED, error: null }]);
    const got = await draft(URLS, "farm", 2, "key-1", DIMS, { recover });
    assertEquals([got.recovered, asks().length], [true, 3]);
  });
  // Past the grace (90 s live; 30 ms here): the server's own sentence, not retryable.
  await withHooks({ __ssRecoverPollMs: 5, __ssRecoverNoRowMs: 30 }, async () => {
    const { recover } = recoverHooks();
    const { draft, asks } = droppingServer(DROPS[0][1], [{ data: NO_ROW, error: null }]);
    const t = Date.now();
    const err = await said(draft(URLS, "farm", 2, "key-1", DIMS, { recover }));
    assertEquals(err.message, NOT_CHARGED);
    assert(!err.ssRetryable, "never the automatic lean retry");
    assert(Date.now() - t >= 30 && asks().length >= 2, `asked through the grace: ${asks().length} asks in ${Date.now() - t} ms`);
  });
  // Any OTHER pending:false is taken at once, however young the press.
  await withFastPoll(async () => {
    const { recover } = recoverHooks();
    const { draft, asks } = droppingServer(DROPS[0][1], [{ data: { ok: true, pending: false, reason: "failed", message: NOT_CHARGED }, error: null }, { data: RECOVERED, error: null }]);
    assertEquals((await said(draft(URLS, "farm", 2, "key-1", DIMS, { recover }))).message, NOT_CHARGED);
    assertEquals(asks().length, 1);
  });
});

Deno.test("a server that says the draft will never come: its sentence, not retryable, and the asking stops", async () => {
  await withFastPoll(async () => {
    const { recover } = recoverHooks();
    const charged = "That generation finished and was charged once, but its draft could not be saved for pickup, so it is gone. You have not been charged twice. Reload this page before pressing Generate again; the next press will be a new charge.";
    const { draft, asks, logged } = droppingServer(DROPS[0][1], [{ data: PENDING, error: null }, { data: { ok: true, pending: false, reason: "charged_unsaved", message: charged }, error: null }, { data: RECOVERED, error: null }]);
    const err = await said(draft(URLS, "farm", 2, "key-1", DIMS, { recover }));
    assertEquals(err.message, charged);
    assert(!err.ssRetryable, "never the automatic lean retry: that would be a second model call");
    assertEquals(asks().length, 2, "no ask after the answer");
    assertEquals(logged, [], "the server's verdict: it files its own row, the client none");
  });
});

Deno.test("the press's budget runs out: a plain sentence, no 'try again', and no ask past the deadline", async () => {
  await withFastPoll(async () => {
    const { recover } = recoverHooks({ untilMs: 40 });
    const { draft, asks, logged } = droppingServer(DROPS[2][1], [{ data: PENDING, error: null }]);
    const t = Date.now();
    const err = await said(draft(URLS, "farm", 2, "key-1", DIMS, { recover }));
    assert(/did not reach us in time/.test(err.message) && /not charge you twice/.test(err.message), err.message);
    assert(!/try again/i.test(err.message), "never 'try again' for a press that may have finished");
    assert(!err.ssRetryable);
    // The first ask is at once; the last wait is cut to end AT the deadline, so the last ask is the
    // deadline's own (a timer can run a tick late: Windows' is ~16 ms). None is sent after it.
    assert(asks().length >= 2 && asks().every((p) => p.at <= recover.until + 50), `asked only inside the budget: ${asks().map((p) => p.at - recover.until).join(", ")} ms`);
    const n = asks().length;
    await new Promise((r) => setTimeout(r, 30));
    assertEquals(asks().length, n, "and none after it gave up");
    assert(Date.now() - t < 1_000, "and gave up at the deadline, not later");
    // No verdict from the server: ONE client row, an error, saying how many asks and what the last said.
    assertEquals(rowsOf(logged), [["draft_recover_timeout", "error", n, "pending"]]);
  });
});

Deno.test("the designer goes away (or another press takes over): the asking stops at once", async () => {
  await withFastPoll(async () => {
    // alive() true for its first check only: the one ask that follows it is the last.
    const once = recoverHooks({ aliveFor: 1 });
    const a = droppingServer(DROPS[0][1], [{ data: PENDING, error: null }]);
    assert((await said(a.draft(URLS, "farm", 2, "key-1", DIMS, { recover: once.recover }))) instanceof Error, "the press ends");
    assertEquals(a.asks().length, 1, "one ask, then nothing");
    assertEquals(rowsOf(a.logged), [["draft_recover_abandoned", "info", 1, "pending"]], "one info row, never a timeout");
    // Already gone when the drop surfaced: no ask at all, and the card never switched.
    const never = recoverHooks({ aliveFor: 0 });
    const b = droppingServer(DROPS[0][1], [{ data: RECOVERED, error: null }]);
    await said(b.draft(URLS, "farm", 2, "key-1", DIMS, { recover: never.recover }));
    assertEquals([b.asks().length, never.hooks.recovering], [0, 0]);
    assertEquals(rowsOf(b.logged), [["draft_recover_abandoned", "info", 0, null]]);
    await new Promise((r) => setTimeout(r, 30));
    assertEquals([a.asks().length, b.asks().length], [1, 0], "and nothing later either");
  });
});

Deno.test("no pickup for the lean retry, a designer without the hooks, or a press with no key; none says 'try again' for a streamed drop", async () => {
  await withFastPoll(async () => {
    // The lean retry is not streamed, so its transport failures read as they always have.
    const lean = droppingServer(DROPS[0][1], [{ data: RECOVERED, error: null }]);
    const err = await said(lean.draft(URLS, "farm", 2, "key-1", DIMS, { lean: true, recover: recoverHooks().recover }));
    assertEquals(err.message, "Unexpected end of JSON input");
    assertEquals(lean.asks().length, 0, "the lean retry never asks");
    for (const [what, drop] of DROPS) {
      // A designer that never passes `recover` (an older one), or a press that sent no key -- there
      // is nothing to find its row by: said plainly, not asked, not retried.
      for (const [how, key, opts] of [["no hooks", "key-1", undefined], ["no key", undefined, { recover: recoverHooks().recover }]] as [string, string | undefined, unknown][]) {
        const old = droppingServer(drop, [{ data: RECOVERED, error: null }]);
        const e = await said(old.draft(URLS, "farm", 2, key, DIMS, opts));
        assert(/connection dropped before the draft arrived/.test(e.message), `${what}, ${how}: ${e.message}`);
        assert(!/try again/i.test(e.message), `${what}, ${how}`);
        assert(!e.ssRetryable, `${what}, ${how}`);
        assertEquals(old.asks().length, 0, `${what}, ${how}`);
      }
    }
  });
});

Deno.test("01-core: a dropped streamed draft on a page that stays is ONE info row under draft_stream_dropped, never a fault", () => {
  const aborted = lift(CORE, "const ssAborted = ssPageLeaving && st === null", ";\n", "the navigation-abort test") + ";";
  const decl = lift(CORE, "const ssDraftDropped = ", ";\n", "the dropped-draft test") + ";";
  const run = (leaving: boolean, st: number | null, res: unknown, body: unknown) =>
    new Function("ssPageLeaving", "st", "res", "opts", `${aborted}\n${decl}\nreturn { ssAborted, ssDraftDropped };`)(leaving, st, res, { body }) as { ssAborted: boolean; ssDraftDropped: boolean };
  const PRESS = { action: "calibrate_style_ai", stream: true };
  const cut = (name: string) => ({ error: { name }, data: null });
  const deadline = { error: null, data: { error: "x", code: "stream_deadline", status: 504 } };
  // The two drops, on a page that stays: counted, not a fault.
  assertEquals(run(false, null, cut("SyntaxError"), PRESS), { ssAborted: false, ssDraftDropped: true });
  assertEquals(run(false, null, cut("TypeError"), PRESS), { ssAborted: false, ssDraftDropped: true });
  assertEquals(run(false, 504, deadline, PRESS), { ssAborted: false, ssDraftDropped: true });
  // A page that is LEAVING is the navigation's own code, as before.
  assertEquals(run(true, null, cut("TypeError"), PRESS), { ssAborted: true, ssDraftDropped: false });
  // Nothing else is: the lean retry (not streamed), the pickup itself, another action, a refusal in
  // a streamed body, a transport failure before the response, and a status the server sent.
  assertEquals(run(false, null, cut("SyntaxError"), { action: "calibrate_style_ai", lean: true }).ssDraftDropped, false, "the lean retry");
  assertEquals(run(false, null, cut("TypeError"), { action: "calibrate_style_ai_recover" }).ssDraftDropped, false, "a pickup ask");
  assertEquals(run(false, null, cut("SyntaxError"), { action: "status", stream: true }).ssDraftDropped, false, "another action");
  assertEquals(run(false, 402, { error: null, data: { error: "x", code: "insufficient_funds", status: 402 } }, PRESS).ssDraftDropped, false, "a streamed refusal");
  assertEquals(run(false, null, cut("FunctionsFetchError"), PRESS).ssDraftDropped, false, "never reached the server");
  assertEquals(run(false, 502, cut("TypeError"), PRESS).ssDraftDropped, false, "a status the server sent");
  // And the row it becomes: its own code, filed as info.
  const call = lift(CORE, "ssLogError(SS_ERR_SOURCE, (res.error && res.error.message) || (res.data && res.data.error),", "} catch (_) {}", "the log call");
  assert(call.includes('ssAborted ? "fetch_aborted_navigating" : ssDraftDropped ? "draft_stream_dropped" :'), "its own code");
  assert(call.includes('(ssAborted || ssDraftDropped || ssRefusal || (st >= 400 && st < 500)) ? "info" : "error"'), "filed as info");
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
  assert(call.includes('(ssAborted || ssDraftDropped || ssRefusal || (st >= 400 && st < 500)) ? "info" : "error"'), "filed as info");
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
