// ─── CLOSE-UPS: A SMALL PLACE CUT OUT OF A WALK FRAME, ENLARGED AND ASKED ABOUT (2026-09-29) ─────
// Some shape facts are a few pixels wide in the 1280 x 720 walk frames, and the v2 draft's reads get
// them wrong however they are asked: which way the roof steps at its joint (stepZoom.ts) and how far
// the eaves stand past the walls (overhangZoom.ts). Cutting the spot out of the frame, enlarging it
// and asking about the close-up alone reads it right. This file is the part the two share: where to
// cut, the cutting, fetching the frame, and the asks themselves. Each caller owns its own plan,
// prompt and verdict.
//
// ⚠️ THE IMAGE LIBRARY IS IMPORTED ONLY WHEN A CLOSE-UP IS CUT (cutCloseUps). Its JPEG and zlib modules
// fetch their WebAssembly from deno.land as they load, so a static import would put that fetch on every
// cold start of portal-settings, and an unreachable deno.land would fail requests that never cut one.
//
// ⚠️ AND THAT LOAD IS NOT THE DRAFT'S TO CANCEL (2026-09-30). The library's own WebAssembly fetch takes
// no signal: a cold load over a slow connection held a draft 2.6 and 11 s past its deadline. So the cut
// is waited for only until the draft's signal fires (untilAborted), and the draft moves on; the load
// finishes or fails on its own. A module whose load failed stays failed for the worker's life (the
// module map keeps the error), so every close-up on that worker records the same error until it is
// recycled; the first failure is also logged, once per worker, so such a worker shows in the logs.

export type XY = [number, number];
export const isXY = (v: unknown): v is XY =>
  Array.isArray(v) && v.length === 2 && typeof v[0] === "number" && Number.isFinite(v[0]) && typeof v[1] === "number" && Number.isFinite(v[1]);
export const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// A crop window in the frame's own pixels: 1/div of the frame each way (never under 8 px), centred on
// `centre` (frame pixels) and moved inside the frame, so a spot near the frame's edge is still cut
// whole-sized, just no longer centred.
export type CloseUpWindow = { x: number; y: number; w: number; h: number };
export function closeUpWindow(centre: XY, actual: XY, div: number): CloseUpWindow {
  const w = Math.max(8, Math.round(actual[0] / div)), h = Math.max(8, Math.round(actual[1] / div));
  const x = Math.min(Math.max(0, Math.round(centre[0] - w / 2)), Math.max(0, actual[0] - w));
  const y = Math.min(Math.max(0, Math.round(centre[1] - h / 2)), Math.max(0, actual[1] - h));
  return { x, y, w, h };
}

// `p`, or a rejection with the signal's reason as soon as `signal` fires, whichever comes first
// (straight away when it already has). `p` itself runs on; a later rejection of it is handled here,
// never left unhandled.
export function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([p, aborted]).finally(() => signal.removeEventListener("abort", onAbort));
}

// The image library, loaded on the first cut. Its first failure on a worker is logged (the note above).
//
// ⚠️ LOADED ONCE PER WORKER, AND EVERY CALLER AWAITS THAT ONE LOAD (2026-09-30). The roof-step and
// overhang close-ups cut in parallel, and live, the first draft that needed both failed the overhang's
// with "Cannot access 'Image' before initialization": two import() calls started together, the
// library's modules await their WebAssembly while they evaluate, and the second import handed back
// the namespace before that evaluation had finished. The step's close-up, alone on the worker the day
// before, never met it. So the load is one promise per loader, shared by every cut on the worker: a
// second caller waits for the first load to FINISH. A load that failed stays failed for the worker's
// life (the runtime caches a failed import anyway), and its failure is logged once.
export const loadImageLibrary = () => import("https://deno.land/x/imagescript@1.3.0/mod.ts");
let libraryFailureLogged = false;
const libraryLoads = new WeakMap<typeof loadImageLibrary, ReturnType<typeof loadImageLibrary>>();
function imageLibrary(load: typeof loadImageLibrary): ReturnType<typeof loadImageLibrary> {
  let loading = libraryLoads.get(load);
  if (!loading) {
    loading = load();
    libraryLoads.set(load, loading);
    loading.catch((e) => {
      if (libraryFailureLogged) return;
      libraryFailureLogged = true;
      console.error(`closeUp: the image library did not load, so every close-up on this worker fails until it is recycled: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`);
    });
  }
  return loading;
}

// Decodes a frame's JPEG bytes once and cuts every window `place` gives for the frame's real size,
// each enlarged `zoom` times (the library's default, nearest-neighbour, resize) and encoded as JPEG
// at quality 90. `frame` is the frame's [width, height]; each close-up is its window, its base64 and
// its own width and height (the window's times `zoom`). Waited for only until `signal` (the draft's
// own budget) fires, which rejects with its reason; nothing is started when it already has. `load`
// is the library's loader, a parameter only so a test can hand in one that stalls or fails.
export type CloseUp = { win: CloseUpWindow; base64: string; width: number; height: number };
export async function cutCloseUps(
  bytes: Uint8Array,
  place: (actual: XY) => readonly CloseUpWindow[],
  zoom: number,
  signal: AbortSignal,
  load: typeof loadImageLibrary = loadImageLibrary,
): Promise<{ frame: XY; closeUps: CloseUp[] }> {
  signal.throwIfAborted();
  return await untilAborted((async () => {
    const { decode, Image } = await imageLibrary(load);
    const img = await decode(bytes);
    if (!(img instanceof Image)) throw new Error("the frame is not a still image");
    const frame: XY = [img.width, img.height];
    const closeUps: CloseUp[] = [];
    for (const win of place(frame)) {
      const width = win.w * zoom, height = win.h * zoom;
      const jpeg = await img.clone().crop(win.x, win.y, win.w, win.h).resize(width, height).encodeJPEG(90);
      let bin = "";
      for (let i = 0; i < jpeg.length; i += 0x8000) bin += String.fromCharCode(...jpeg.subarray(i, i + 0x8000));
      closeUps.push({ win, base64: btoa(bin), width, height });
    }
    return { frame, closeUps };
  })(), signal);
}

// The frame's bytes, from the public bucket URL the reads were sent. Throws on a non-2xx answer, and
// gives up after 10 s or when `signal` (the draft's own budget) fires.
export async function fetchFrame(f: typeof fetch, url: string, signal: AbortSignal): Promise<Uint8Array> {
  const got = await f(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
  if (!got.ok) throw new Error(`the frame answered ${got.status}`);
  return new Uint8Array(await got.arrayBuffer());
}

// `asks` identical questions in parallel: the close-ups (in order) and then the prompt, on the model
// the caller hands over (aiModelFields), thinking adaptively at effort "high", each bounded by
// `callMs` and by `signal`. NEVER THROWS: an ask the API turned away, that timed out or that did not
// answer JSON comes back as a null text (with whatever usage the API reported, so a billed failure is
// still counted).
export type CloseUpAnswer = { text: string | null; usage: Record<string, unknown> | null };
export async function askCloseUps(o: {
  f: typeof fetch;
  apiKey: string;
  model: Record<string, unknown>;
  maxTokens: number;
  images: readonly string[];
  prompt: string;
  asks: number;
  callMs: number;
  signal: AbortSignal;
}): Promise<CloseUpAnswer[]> {
  return await Promise.all(Array.from({ length: o.asks }, async () => {
    try {
      const r = await o.f("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": o.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          ...o.model,
          max_tokens: o.maxTokens,
          thinking: { type: "adaptive" },
          output_config: { effort: "high" },
          messages: [{ role: "user", content: [
            ...o.images.map((data) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } })),
            { type: "text", text: o.prompt },
          ] }],
        }),
        signal: AbortSignal.any([o.signal, AbortSignal.timeout(Math.max(1_000, o.callMs))]),
      });
      const j = await r.json();
      const text = r.ok && Array.isArray(j?.content)
        ? j.content.filter((b: { type?: string }) => b?.type === "text").map((b: { text?: string }) => String(b.text ?? "")).join("")
        : null;
      return { text, usage: j?.usage ?? null };
    } catch {
      return { text: null, usage: null };
    }
  }));
}

// The asks' tokens, summed: [input, output].
export function closeUpUsage(asks: readonly CloseUpAnswer[]): [number, number] {
  return [
    asks.reduce((s, a) => s + (Number(a.usage?.input_tokens) || 0), 0),
    asks.reduce((s, a) => s + (Number(a.usage?.output_tokens) || 0), 0),
  ];
}
