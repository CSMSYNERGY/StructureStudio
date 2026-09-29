// ═══ A JSON ANSWER THAT OUTLIVES THE GATEWAY'S IDLE TIMEOUT (2026-09-25) ═══════════════════════
//
// Supabase's gateway ends a request that has sent nothing for 150 s with a 504 of its own, which no
// function can see or log. What it times is SILENCE, not the request: a probe function that wrote
// one space every 10 s and then its JSON ran 220 s and answered 200 with the whole body (measured
// 2026-09-25). So a handler whose work can outlast 150 s answers AT ONCE with a 200 whose body is
// that heartbeat, and ends the body with the JSON its work answered. JSON.parse skips leading
// whitespace, and so does supabase-js's `response.json()`, so a caller reads the object it would
// have read.
//
// THE WORK RETURNS THE RESPONSE IT WOULD HAVE RETURNED UNSTREAMED, and this module decides nothing
// about it:
//   * a 2xx goes out as its own body, byte for byte;
//   * anything else can no longer be the status line (the 200 went out before the work began), so
//     it goes out as its own object plus `status`: the code it would have had. Every other key --
//     `error`, `code`, `retryable` -- is the object's own, in its own order;
//   * a throw goes out as { error: "Internal Server Error", status: 500 }, what Deno.serve answers
//     an uncaught throw with. Filing it is the caller's job (portal-settings runs the work inside
//     a replay of its own error wrapper, which files it exactly as it files an unstreamed throw).
//
// A caller that goes away (the tab closed) cancels the body: the heartbeat stops and nothing more
// is written, and the work is NOT cancelled with it. It was holding money, and it releases or
// captures it the way it would have with nobody listening to an unstreamed answer either. Once the
// response is gone nothing else holds the worker open for it, so the work's promise is handed to
// EdgeRuntime.waitUntil, which asks the Supabase runtime to keep the worker until it settles. That
// is a request, not a guarantee: the platform's wall clock still ends the worker, and so does a
// shutdown. A hold stranded that way is released by the stale-hold sweep, and the ledger row keeps
// whatever the work had written by then. (Deno's own test runner has no EdgeRuntime; there the
// promise simply runs on, which is all a test needs.)
//
// THE WATCHDOG (`deadlineMs`, 2026-09-25). supabase-js has no timeout, so a work that hangs after its
// model calls (a database call that never returns) would keep the heartbeat going until the platform
// killed the worker, and the caller would read a body cut off mid-space. With a deadline, the answer
// ends on time instead: STREAM_DEADLINE_BODY (a 504 in the body, NOT retryable, code
// "stream_deadline") is written and the body closed, and the heartbeat stops. The work is not
// stopped: it is still registered with waitUntil, so it can still release or capture its hold and
// write its ledger row, which is where the caller picks the draft up (calibrate_style_ai_recover).
//
// Dependency-free on purpose: heartbeatJson.test.ts runs in the _shared group, with no import map.

export const HEARTBEAT_MS = 10_000;
export const HEARTBEAT = " ";

// What the watchdog writes. Its own code, so the caller can tell "the server gave up waiting on its
// own work" from every answer the work itself gives, and no `retryable`: the work may still finish
// and charge, so a second model call under the same key is the wrong answer to it.
export const STREAM_DEADLINE_CODE = "stream_deadline";
export const STREAM_DEADLINE_BODY = JSON.stringify({
  error: "The draft is taking longer than this connection can wait. It is still being finished on our side.",
  code: STREAM_DEADLINE_CODE,
  status: 504,
});

// What a streamed answer writes last, for an unstreamed answer of `status` whose body was `text`.
export function streamedAnswer(status: number, text: string): string {
  if (status >= 200 && status < 300) return text;
  let obj: unknown = null;
  try { obj = JSON.parse(text); } catch { obj = null; }
  const body = obj && typeof obj === "object" && !Array.isArray(obj)
    ? obj as Record<string, unknown>
    // Not our JSON shape (nothing in portal-settings answers so, but a body this module cannot
    // read must still reach the caller as an error it can show).
    : { error: text || `HTTP ${status}` };
  return JSON.stringify({ ...body, status });
}

// Hand a promise to the Supabase edge runtime's waitUntil, where there is one. Never throws: a
// runtime without it (Deno's test runner, a local serve) just lets the promise run.
export function keepAlive(p: Promise<unknown>): void {
  try {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).EdgeRuntime?.waitUntil?.(p);
  } catch { /* the promise runs on either way */ }
}

export function heartbeatJsonResponse(
  work: () => Promise<Response>,
  opts: {
    headers: HeadersInit;
    heartbeatMs?: number;
    // How long the answer may stay open, from now. Absent: no watchdog.
    deadlineMs?: number;
    // Called once if the watchdog fires (portal-settings files a row). Its promise is kept alive too.
    onDeadline?: () => unknown;
  },
): Response {
  const encoder = new TextEncoder();
  const every = opts.heartbeatMs ?? HEARTBEAT_MS;
  let open = true;
  let timer: ReturnType<typeof setInterval> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    if (watchdog !== undefined) clearTimeout(watchdog);
    watchdog = undefined;
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (s: string) => {
        if (!open) return;
        try { controller.enqueue(encoder.encode(s)); } catch { open = false; }
      };
      // The last write, whoever makes it: the work's answer or the watchdog's. Only the first one
      // lands; the other finds the body closed and writes nothing.
      const finish = (s: string) => {
        stop();
        write(s);
        if (open) {
          open = false;
          try { controller.close(); } catch { /* cancelled while the last write was queued */ }
        }
      };
      // One byte at once, so the status line and the first byte leave together rather than
      // waiting ten seconds for the first beat.
      write(HEARTBEAT);
      timer = setInterval(() => write(HEARTBEAT), every);
      // Armed BEFORE the work starts, so a work that settles at once (a synchronous throw) clears it
      // in finish() rather than leaving a timer behind it.
      if (typeof opts.deadlineMs === "number" && Number.isFinite(opts.deadlineMs)) {
        watchdog = setTimeout(() => {
          watchdog = undefined;
          if (!open) return;
          finish(STREAM_DEADLINE_BODY);
          try {
            const filed = opts.onDeadline?.();
            if (filed && typeof (filed as Promise<unknown>).then === "function") {
              keepAlive(Promise.resolve(filed).catch(() => undefined));
            }
          } catch { /* a logger that throws must not reach the runtime */ }
        }, Math.max(0, opts.deadlineMs));
      }
      // NOT awaited: start() returns now, the 200 goes out now, and the work runs behind it.
      // It cannot reject: everything in it is caught.
      const done = (async () => {
        let last: string;
        try {
          const res = await work();
          last = streamedAnswer(res.status, await res.text());
        } catch {
          last = JSON.stringify({ error: "Internal Server Error", status: 500 });
        }
        finish(last);
      })();
      keepAlive(done);
    },
    cancel() {
      open = false;
      stop();
    },
  });
  return new Response(body, { status: 200, headers: opts.headers });
}
