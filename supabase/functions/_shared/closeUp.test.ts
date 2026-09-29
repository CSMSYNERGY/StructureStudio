// deno test -A supabase/functions/_shared/closeUp.test.ts
// The part the two close-up reads share (closeUp.ts): where to cut, the cutting, the frame's fetch
// and the asks. stepZoom.test.ts and overhangZoom.test.ts drive it through their own runs; this pins
// the pieces themselves.
import { assert, assertEquals } from "jsr:@std/assert";
import { askCloseUps, closeUpUsage, closeUpWindow, cutCloseUps, fetchFrame, loadImageLibrary, median, untilAborted } from "./closeUp.ts";

// The image library fetches its WebAssembly from deno.land as it loads (closeUp.ts's note), so the
// test that cuts a real close-up runs only with network access; preflight's run skips it.
const NET = (await Deno.permissions.query({ name: "net", host: "deno.land" })).state === "granted";

Deno.test("closeUpWindow: 1/div of the frame each way, centred on the point and kept inside the frame", () => {
  assertEquals(closeUpWindow([248, 226], [1280, 720], 6), { x: 142, y: 166, w: 213, h: 120 });
  assertEquals(closeUpWindow([918, 293], [1280, 720], 8), { x: 838, y: 248, w: 160, h: 90 });
  // Near an edge the window moves inside, whole-sized.
  assertEquals(closeUpWindow([12, 225], [1280, 720], 6), { x: 0, y: 165, w: 213, h: 120 });
  assertEquals(closeUpWindow([1275, 715], [1280, 720], 6), { x: 1067, y: 600, w: 213, h: 120 });
  // Never under 8 px, and never off a frame smaller than the window.
  assertEquals(closeUpWindow([10, 10], [20, 20], 8), { x: 6, y: 6, w: 8, h: 8 });
  assertEquals(closeUpWindow([3, 3], [6, 6], 8), { x: 0, y: 0, w: 8, h: 8 });
});

Deno.test("median: the middle value, or the mean of the middle two", () => {
  assertEquals([median([3, 1, 2]), median([4, 1, 3, 2]), median([5])], [2, 2.5, 5]);
});

// A fetch stand-in that records what the Messages API was sent and answers `replies` in turn.
const fakeApi = (replies: (Response | Error)[]) => {
  const sent: { url: string; body: Record<string, unknown>; signal?: AbortSignal | null }[] = [];
  let n = 0;
  // deno-lint-ignore require-await
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)), signal: init?.signal });
    const r = replies[n++ % replies.length];
    if (r instanceof Error) throw r;
    return r.clone();
  }) as typeof fetch;
  return { f, sent };
};
const ok = (text: string, usage = { input_tokens: 3300, output_tokens: 900 }) =>
  new Response(JSON.stringify({ content: [{ type: "thinking", thinking: "" }, { type: "text", text }], usage }), { status: 200 });

Deno.test("askCloseUps: the close-ups in order, then the prompt, on the model it was handed, in parallel", async () => {
  const api = fakeApi([ok('{"a": 1}')]);
  const out = await askCloseUps({
    f: api.f, apiKey: "k", model: { model: "m" }, maxTokens: 4000, images: ["AAA", "BBB"], prompt: "Where?",
    asks: 3, callMs: 20_000, signal: new AbortController().signal,
  });
  assertEquals(out.map((a) => a.text), ['{"a": 1}', '{"a": 1}', '{"a": 1}']);
  assertEquals(api.sent.length, 3);
  const b = api.sent[0].body;
  assertEquals(api.sent[0].url, "https://api.anthropic.com/v1/messages");
  assertEquals(Object.keys(b), ["model", "max_tokens", "thinking", "output_config", "messages"], "the step's request, key for key");
  assertEquals([b.model, b.max_tokens, b.thinking, b.output_config], ["m", 4000, { type: "adaptive" }, { effort: "high" }]);
  assertEquals(b.messages, [{ role: "user", content: [
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAA" } },
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBB" } },
    { type: "text", text: "Where?" },
  ] }]);
  assertEquals(closeUpUsage(out), [3 * 3300, 3 * 900]);
});

Deno.test("askCloseUps never throws: a turned-away ask, a throw and a non-JSON body are a null text", async () => {
  const api = fakeApi([
    new Response(JSON.stringify({ error: { type: "overloaded_error" } }), { status: 529 }),
    new Error("network down"),
    new Response("<html>bad gateway</html>", { status: 502 }),
    ok("fine"),
  ]);
  const out = await askCloseUps({
    f: api.f, apiKey: "k", model: { model: "m" }, maxTokens: 10, images: ["A"], prompt: "p", asks: 4, callMs: 1, signal: new AbortController().signal,
  });
  assertEquals(out.map((a) => a.text), [null, null, null, "fine"]);
  // A failure that reported usage is still counted; the rest add nothing.
  assertEquals(closeUpUsage([{ text: null, usage: { input_tokens: 7, output_tokens: 2 } }, ...out]), [3307, 902]);
});

Deno.test("fetchFrame: the frame's bytes, or a throw that names the status", async () => {
  // deno-lint-ignore require-await
  const f = (async (url: string | URL | Request) =>
    String(url).endsWith("/ok.jpg") ? new Response(new Uint8Array([1, 2, 3])) : new Response("nope", { status: 404 })) as typeof fetch;
  assertEquals([...await fetchFrame(f, "https://x/ok.jpg", new AbortController().signal)], [1, 2, 3]);
  let err = "";
  try { await fetchFrame(f, "https://x/missing.jpg", new AbortController().signal); } catch (e) { err = String((e as Error).message); }
  assertEquals(err, "the frame answered 404");
});

Deno.test("the image library is never a static import", async () => {
  // A static import would fetch its WebAssembly from deno.land on every cold start of portal-settings.
  for (const f of ["closeUp.ts", "stepZoom.ts", "overhangZoom.ts"]) {
    const src = await Deno.readTextFile(new URL(`./${f}`, import.meta.url));
    assert(!/^\s*import\b[^;]*imagescript/m.test(src), `${f} imports the image library statically`);
  }
  const src = await Deno.readTextFile(new URL("./closeUp.ts", import.meta.url));
  assertEquals(src.split('import("https://deno.land/x/imagescript@1.3.0/mod.ts")').length - 1, 1, "one lazy import");
  assert(src.includes('export const loadImageLibrary = () => import("https://deno.land/x/imagescript@1.3.0/mod.ts");'), "a literal specifier, so the bundle carries it");
});

Deno.test({ name: "cutCloseUps: decodes once, cuts every window and enlarges each", ignore: !NET, fn: async () => {
  const { Image } = await import("https://deno.land/x/imagescript@1.3.0/mod.ts");
  // A 1280 by 720 frame: grey, with a black square at (100..109, 50..59), 1-based.
  const img = new Image(1280, 720);
  img.fill(Image.rgbaToColor(128, 128, 128, 255));
  for (let y = 50; y <= 59; y++) for (let x = 100; x <= 109; x++) img.setPixelAt(x, y, Image.rgbaToColor(0, 0, 0, 255));
  const jpeg = await img.encodeJPEG(95);
  let seen: number[] = [];
  const cut = await cutCloseUps(jpeg, (actual) => {
    seen = actual;
    return [{ x: 90, y: 40, w: 40, h: 30 }, { x: 600, y: 300, w: 20, h: 10 }];
  }, 6, new AbortController().signal);
  assertEquals(seen, [1280, 720], "placed on the frame's real size");
  assertEquals(cut.frame, [1280, 720]);
  assertEquals(cut.closeUps.map((c) => [c.win, c.width, c.height]), [
    [{ x: 90, y: 40, w: 40, h: 30 }, 240, 180],
    [{ x: 600, y: 300, w: 20, h: 10 }, 120, 60],
  ]);
  const first = await Image.decode(Uint8Array.from(atob(cut.closeUps[0].base64), (ch) => ch.charCodeAt(0)));
  assertEquals([first.width, first.height], [240, 180]);
  // The square sits 10 px in from the window's left and top, so 60 px in once enlarged.
  const [r1] = Image.colorToRGBA(first.getPixelAt(90, 90));
  const [r2] = Image.colorToRGBA(first.getPixelAt(20, 20));
  assert(r1 < 40 && r2 > 90, `inside the square ${r1}, outside it ${r2}`);
} });

// ─── The draft's deadline, which the image library's own load does not take (2026-09-30) ─────────
const timedOut = () => new DOMException("Signal timed out.", "TimeoutError");

Deno.test("untilAborted: the promise's own outcome, or the signal's reason as soon as it fires", async () => {
  assertEquals(await untilAborted(Promise.resolve(7), new AbortController().signal), 7);
  let err: unknown = null;
  try { await untilAborted(Promise.reject(new Error("its own")), new AbortController().signal); } catch (e) { err = e; }
  assertEquals((err as Error).message, "its own");
  // A promise that never settles: the signal fires 30 ms in, and that is when it rejects.
  const c = new AbortController();
  setTimeout(() => c.abort(timedOut()), 30);
  const t = Date.now();
  err = null;
  try { await untilAborted(new Promise(() => {}), c.signal); } catch (e) { err = e; }
  assertEquals([(err as DOMException).name, (err as DOMException).message], ["TimeoutError", "Signal timed out."]);
  assert(Date.now() - t < 1_000, `rejected ${Date.now() - t} ms later`);
  // Already fired: straight away. The promise's own later failure is handled, never left unhandled
  // (which would fail this test).
  let late!: (e: Error) => void;
  const lateP = new Promise<never>((_, reject) => { late = reject; });
  const done = new AbortController();
  done.abort(timedOut());
  err = null;
  try { await untilAborted(lateP, done.signal); } catch (e) { err = e; }
  assertEquals((err as DOMException).name, "TimeoutError");
  late(new Error("the load failed later"));
  await new Promise((r) => setTimeout(r, 10));
});

Deno.test("cutCloseUps: a load that stalls is waited for only until the draft's signal fires, and none starts after it", async () => {
  let loads = 0;
  const stalls = (() => { loads++; return new Promise(() => {}); }) as unknown as typeof loadImageLibrary;
  const c = new AbortController();
  setTimeout(() => c.abort(timedOut()), 30);
  const t = Date.now();
  let err: unknown = null;
  try { await cutCloseUps(new Uint8Array([1]), () => [], 6, c.signal, stalls); } catch (e) { err = e; }
  assertEquals([(err as DOMException).message, loads], ["Signal timed out.", 1]);
  assert(Date.now() - t < 1_000, `gave up ${Date.now() - t} ms later`);
  // Already out of time: nothing is loaded at all.
  err = null;
  try { await cutCloseUps(new Uint8Array([1]), () => [], 6, c.signal, stalls); } catch (e) { err = e; }
  assertEquals([(err as DOMException).message, loads], ["Signal timed out.", 1]);
});

Deno.test("cutCloseUps: a load that fails is logged once for the worker, and every cut still says why", async () => {
  // A fresh copy of the module, so whatever another test did to its once-per-worker flag is not seen.
  const fresh = (await import("./closeUp.ts?log-once")) as typeof import("./closeUp.ts");
  const fails = (() => Promise.reject(new Error("error reading a body from connection"))) as unknown as typeof loadImageLibrary;
  const logged: string[] = [];
  const was = console.error;
  console.error = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
  try {
    for (let i = 0; i < 3; i++) {
      let err: unknown = null;
      try { await fresh.cutCloseUps(new Uint8Array([1]), () => [], 6, new AbortController().signal, fails); } catch (e) { err = e; }
      assertEquals((err as Error).message, "error reading a body from connection");
    }
  } finally {
    console.error = was;
  }
  assertEquals(logged.length, 1, JSON.stringify(logged));
  assert(logged[0].includes("the image library did not load") && logged[0].includes("error reading a body from connection"), logged[0]);
});
