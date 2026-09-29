// deno test -A supabase/functions/_shared/stepZoom.test.ts
import { assert, assertEquals } from "jsr:@std/assert";
import { runStepZoom, STEP_ZOOM, STEP_ZOOM_ASKS, stepZoomCrop, stepZoomPlan, stepZoomPrompt, stepZoomVerdict, stepZoomWindow } from "./stepZoom.ts";

// The image library fetches its WebAssembly from deno.land as it loads (stepZoom.ts's note), so the
// tests that cut a real close-up run only with network access; preflight's run skips them.
const NET = (await Deno.permissions.query({ name: "net", host: "deno.land" })).state === "granted";
const imagescript = () => import("https://deno.land/x/imagescript@1.3.0/mod.ts");
// A 1280 by 720 frame: sky above, a dark band (the front fascia) from y 284 to 293 left of x 918
// and one from 278 to 287 right of it, and the wall below 294.
const frameJpeg = async () => {
  const { Image } = await imagescript();
  const img = new Image(1280, 720);
  img.fill(Image.rgbaToColor(120, 170, 220, 255));
  for (let y = 294; y <= 720; y++) for (let x = 1; x <= 1280; x++) img.setPixelAt(x, y, Image.rgbaToColor(40, 44, 48, 255));
  for (let y = 284; y <= 293; y++) for (let x = 1; x <= 918; x++) img.setPixelAt(x, y, Image.rgbaToColor(10, 10, 10, 255));
  for (let y = 278; y <= 287; y++) for (let x = 919; x <= 1280; x++) img.setPixelAt(x, y, Image.rgbaToColor(10, 10, 10, 255));
  return await img.encodeJPEG(95);
};
import { readDraftReply } from "./styleD3.ts";

// One read's measure.step block in a 1280 by 720 frame, the front on the left (the live frame).
const block = (over: Record<string, unknown> = {}) => ({
  frame: 5, size: [1280, 720],
  backBase: [1140, 487], jointBase: [920, 494], frontBase: [185, 515], frontFascia: [185, 252],
  jointFront: [918, 293], jointRear: [922, 287], ...over,
});

Deno.test("stepZoomPlan: the reads' most common frame and their medians there", () => {
  const plan = stepZoomPlan([block(), block({ jointFront: [920, 295] }), block({ jointFront: [916, 291] }), null, block({ frame: 12, jointFront: [268, 262], jointBase: [265, 530] })]);
  assertEquals(plan, { frame: 5, size: [1280, 720], joint: [918, 293], wallPx: 201, frontOnLeft: true });
  // The front on the right of the frame.
  assertEquals(stepZoomPlan([block({ frontBase: [1200, 515], backBase: [100, 487] })])?.frontOnLeft, false);
  // A tie goes to the lower frame.
  assertEquals(stepZoomPlan([block({ frame: 12 }), block()])?.frame, 5);
  // Nothing usable: no plan.
  assertEquals(stepZoomPlan([]), null);
  assertEquals(stepZoomPlan([null, {}, block({ jointFront: [918, 600] }), block({ size: [0, 720] }), block({ frame: 0 })]), null);
});

Deno.test("stepZoomWindow: an eighth of the frame each way, on the joint, kept inside the frame", () => {
  const plan = stepZoomPlan([block()])!;
  assertEquals(stepZoomWindow(plan, [1280, 720]), { x: 838, y: 248, w: 160, h: 90, sx: 1, sy: 1 });
  // The frame is a different size than the reads said: the joint scales with it.
  assertEquals(stepZoomWindow(plan, [1920, 1080]), { x: 1257, y: 372, w: 240, h: 135, sx: 1.5, sy: 1.5 });
  // A joint at the frame's edge: the window moves inside.
  const edge = stepZoomPlan([block({ jointFront: [1275, 5], jointBase: [1275, 300] })])!;
  assertEquals(stepZoomWindow(edge, [1280, 720]), { x: 1120, y: 0, w: 160, h: 90, sx: 1, sy: 1 });
});

Deno.test("stepZoomPrompt: says which way the building runs and how tall the close-up is", () => {
  const l = stepZoomPrompt(true, 720), r = stepZoomPrompt(false, 720);
  assert(l.includes("The FRONT of the building is to the LEFT of the joint and the BACK is to the RIGHT."));
  assert(r.includes("The FRONT of the building is to the RIGHT of the joint and the BACK is to the LEFT."));
  assert(l.includes(`enlarged ${STEP_ZOOM} times`) && l.includes("720 pixels tall"));
});

const ans = (higher: string, f: number, b: number) => JSON.stringify({ higher, frontFasciaBottomY: f, backFasciaBottomY: b, why: "x" });

Deno.test("stepZoomVerdict: the majority's direction, and its height from the fascia gap over the wall", () => {
  // The live close-ups: front 480, back 400 in an 8x enlargement; the wall 201 px in the frame.
  const v = stepZoomVerdict([ans("back", 480, 400), ans("back", 482, 402), ans("front", 400, 480)], 201, 8, 7.75);
  assertEquals(v, { higher: "back", votes: { front: 1, back: 2 }, riseFt: 0.39 });
  // Lower: a negative rise.
  assertEquals(stepZoomVerdict([ans("front", 400, 480), ans("front", 400, 470)], 201, 8, 7.75)?.riseFt, -0.36);
  // An answer whose own numbers contradict its direction gives no height, only its vote.
  assertEquals(stepZoomVerdict([ans("back", 400, 480), ans("back", 400, 480)], 201, 8, 7.75), { higher: "back", votes: { front: 0, back: 2 }, riseFt: null });
  // Tied, one answer, or nothing parseable: no verdict.
  assertEquals(stepZoomVerdict([ans("back", 480, 400), ans("front", 400, 480)], 201, 8, 7.75), null);
  assertEquals(stepZoomVerdict([ans("back", 480, 400), null, "no json"], 201, 8, 7.75), null);
  assertEquals(stepZoomVerdict(['{"higher": "up"}', "{", null], 201, 8, 7.75), null);
  // A height outside 0.05..1.5 ft is not kept.
  assertEquals(stepZoomVerdict([ans("back", 401, 400), ans("back", 401, 400)], 201, 8, 7.75)?.riseFt, null);
});

Deno.test({ name: "stepZoomCrop: crops the joint out of a JPEG and enlarges it eight times", ignore: !NET, fn: async () => {
  const { Image } = await imagescript();
  const jpeg = await frameJpeg();
  const plan = stepZoomPlan([block()])!;
  const c = await stepZoomCrop(jpeg, plan, new AbortController().signal);
  assertEquals([c.heightPx, c.zoomY, c.wallPxActual], [720, 8, 201]);
  const out = await Image.decode(Uint8Array.from(atob(c.base64), (ch) => ch.charCodeAt(0)));
  assertEquals([out.width, out.height], [1280, 720]);
  // The band right of the joint sits higher in the close-up than the one left of it.
  const darkRows = (x: number) => {
    const rows: number[] = [];
    for (let y = 1; y <= out.height; y++) {
      const [r] = Image.colorToRGBA(out.getPixelAt(x, y));
      if (r < 25) rows.push(y);
    }
    return rows;
  };
  const leftTop = darkRows(200)[0], rightTop = darkRows(1100)[0];
  assert(rightTop < leftTop, `the right band starts at ${rightTop}, the left at ${leftTop}`);
} });

// A fetch stand-in: the frame URL answers `frame`, the Messages API answers `replies` in turn.
const fakeFetch = (frame: Uint8Array | null, replies: (string | null)[], onFrame?: () => void) => {
  const sent: Record<string, unknown>[] = [];
  let n = 0;
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith("https://api.anthropic.com/")) {
      sent.push(JSON.parse(String(init?.body)));
      const text = replies[n++ % replies.length];
      if (text === null) return new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 529 });
      return new Response(JSON.stringify({ content: [{ type: "thinking", thinking: "" }, { type: "text", text }], usage: { input_tokens: 1500, output_tokens: 400 } }), { status: 200 });
    }
    onFrame?.();
    return frame ? new Response(frame as BodyInit, { status: 200 }) : new Response("nope", { status: 404 });
  }) as typeof fetch;
  return { fn, sent };
};
const RUN = (over: Partial<Parameters<typeof runStepZoom>[0]> = {}) => ({
  blocks: [block(), block(), null], photoUrls: Array.from({ length: 12 }, (_, i) => `https://x/frame-${i + 1}.jpg`),
  rise0: -0.25, wallFt: 7.75, leftMs: 200_000, apiKey: "k", model: { model: "m" }, signal: new AbortController().signal, ...over,
});

Deno.test({ name: "runStepZoom: the majority of the close-up asks sets the direction and the height", ignore: !NET, fn: async () => {
  const f = fakeFetch(await frameJpeg(), [ans("back", 480, 400), ans("back", 482, 402), ans("front", 400, 480)]);
  const z = await runStepZoom(RUN({ fetchFn: f.fn }));
  assertEquals(z.riseFt, 0.39, "back higher, 80 px enlarged over a 201 px wall");
  assertEquals([z.input, z.output], [3 * 1500, 3 * 400]);
  assertEquals(z.record?.votes, { front: 1, back: 2 });
  assertEquals([z.record?.frame, z.record?.before, z.record?.after], [5, -0.25, 0.39]);
  // STEP_ZOOM_ASKS asks, each one image and the prompt, on the model it was handed.
  assertEquals(f.sent.length, STEP_ZOOM_ASKS);
  const content = (f.sent[0].messages as { content: { type: string }[] }[])[0].content;
  assertEquals([f.sent[0].model, content.map((c) => c.type)], ["m", ["image", "text"]]);
  // Two asks the API turned away and one answer: no majority, so the consensus stands.
  const g = fakeFetch(await frameJpeg(), [null, ans("back", 480, 400), null]);
  const none = await runStepZoom(RUN({ fetchFn: g.fn }));
  assertEquals([none.riseFt, none.record?.votes], [null, null]);
  // Answers with a direction but no usable height: the consensus's height, turned the voted way.
  const h = fakeFetch(await frameJpeg(), [ans("back", 400, 480)]);
  assertEquals((await runStepZoom(RUN({ fetchFn: h.fn }))).riseFt, 0.25);
} });

Deno.test("runStepZoom: nothing to crop, no frame, or too little time left is no close-up and no call", async () => {
  const f = fakeFetch(null, [ans("back", 480, 400)]);
  for (const over of [{ blocks: [null, {}] }, { photoUrls: ["https://x/1.jpg"] }, { leftMs: 30_000 }]) {
    const z = await runStepZoom(RUN({ ...over, fetchFn: f.fn }));
    assertEquals(z, { riseFt: null, record: null, input: 0, output: 0 }, JSON.stringify(over));
  }
  assertEquals(f.sent.length, 0);
  // A frame that will not load is recorded and changes nothing.
  const z = await runStepZoom(RUN({ fetchFn: f.fn }));
  assertEquals([z.riseFt, z.record?.error, z.record?.after], [null, "the frame answered 404", null]);
});

Deno.test("runStepZoom: the draft's time running out during the cut stops it there, recorded, with no ask sent", async () => {
  // The image library's own load takes no signal, so the cut is waited for only until the draft's fires.
  const c = new AbortController();
  const f = fakeFetch(new Uint8Array([0xff, 0xd8, 0xff]), [ans("back", 480, 400)], () => c.abort(new DOMException("Signal timed out.", "TimeoutError")));
  const t = Date.now();
  const z = await runStepZoom(RUN({ fetchFn: f.fn, signal: c.signal }));
  assert(Date.now() - t < 1_000, `returned ${Date.now() - t} ms later`);
  assertEquals([z.riseFt, z.record?.error, z.record?.after, z.input], [null, "Signal timed out.", null, 0]);
  assertEquals(f.sent.length, 0);
});

Deno.test("readDraftReply: a measured read's step points ride on the reading, and a read with no step has none", () => {
  const text = (roof: Record<string, unknown>) => JSON.stringify({
    measure: { step: block() },
    roof: { type: "gable", front: "gable", pitch: 0.4, overhangIn: 12, eave: "fascia", ...roof },
    siding: "batten", colors: { body: "#555555" },
  });
  const body = (t: string) => JSON.stringify({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });
  const dims = { widthFt: 14, lengthFt: 40, wallHeightFt: 7.75 };
  const stepped = readDraftReply(body(text({ rearStepFt: 11, rearEaveRiseFt: -0.25 })), dims, true);
  assertEquals(stepped.stepPoints, block());
  assertEquals(readDraftReply(body(text({})), dims, true).stepPoints, undefined);
  // A legacy read never has them.
  assertEquals(readDraftReply(body(text({ rearStepFt: 11, rearEaveRiseFt: -0.25 })), dims, false).stepPoints, undefined);
});
