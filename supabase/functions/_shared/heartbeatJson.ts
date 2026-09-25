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
// is written, but the WORK IS NOT STOPPED. It was holding money, and it releases or captures it the
// way it would have with nobody listening to an unstreamed answer either.
//
// Dependency-free on purpose: heartbeatJson.test.ts runs in the _shared group, with no import map.

export const HEARTBEAT_MS = 10_000;
export const HEARTBEAT = " ";

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

export function heartbeatJsonResponse(
  work: () => Promise<Response>,
  opts: { headers: HeadersInit; heartbeatMs?: number },
): Response {
  const encoder = new TextEncoder();
  const every = opts.heartbeatMs ?? HEARTBEAT_MS;
  let open = true;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (s: string) => {
        if (!open) return;
        try { controller.enqueue(encoder.encode(s)); } catch { open = false; }
      };
      // One byte at once, so the status line and the first byte leave together rather than
      // waiting ten seconds for the first beat.
      write(HEARTBEAT);
      timer = setInterval(() => write(HEARTBEAT), every);
      // NOT awaited: start() returns now, the 200 goes out now, and the work runs behind it.
      // It cannot reject: everything in it is caught.
      (async () => {
        let last: string;
        try {
          const res = await work();
          last = streamedAnswer(res.status, await res.text());
        } catch {
          last = JSON.stringify({ error: "Internal Server Error", status: 500 });
        }
        stop();
        write(last);
        if (open) {
          open = false;
          try { controller.close(); } catch { /* cancelled while the last write was queued */ }
        }
      })();
    },
    cancel() {
      open = false;
      stop();
    },
  });
  return new Response(body, { status: 200, headers: opts.headers });
}
