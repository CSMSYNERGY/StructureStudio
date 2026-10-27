// A stand-in for the Messages API, for the door-generation tests (doorGenerate.test.ts, the door wiring
// tests). Not a test file itself: the _test_stubs group runs only *_test.ts.
//
// It answers each request by what it asks (Stage A, the hinge / handle / meeting-edge close-ups, Stage
// B), from a script, and records every request it was sent. Nothing here reaches the network.

type Rec = Record<string, unknown>;
// One scripted reply: the answer's JSON (sent as the reply's text), raw text, an HTTP failure, a reply
// cut off at max_tokens, a call that never answers (until its signal aborts), or a send that throws.
export type Scripted =
  | Rec
  | { text: string; stop?: string }
  | { status: number; body?: string }
  | "hang"
  | "throw"
  | "cutoff";
export type Script = {
  stageA: Scripted[] | ((i: number) => Scripted);
  hinges?: Scripted | ((i: number) => Scripted);
  handle?: Scripted | ((i: number) => Scripted);
  meet?: Scripted | ((i: number) => Scripted);
  stageB?: Scripted | ((i: number) => Scripted);
  usage?: { input_tokens: number; output_tokens: number };
};
export type Kind = "stageA" | "hinges" | "handle" | "meet" | "stageB" | "other";
export type Sent = { kind: Kind; body: Rec; text: string; images: number };

export function kindOf(text: string): Kind {
  if (text.startsWith("DOOR_LOOK_V2. You are measuring")) return "stageA";
  if (text.startsWith("DOOR_LOOK_V2, second look")) return "stageB";
  if (text.includes("Each crop is centred on one of the door's hinges")) return "hinges";
  if (text.includes("The crop is centred on the door's handle")) return "handle";
  if (text.includes("where the two leaves of a double door meet")) return "meet";
  return "other";
}

export function reply(answer: unknown, usage = { input_tokens: 3000, output_tokens: 1500 }, stop = "end_turn"): Response {
  const text = typeof answer === "string" ? answer : JSON.stringify(answer);
  return new Response(JSON.stringify({ content: [{ type: "thinking", thinking: "..." }, { type: "text", text }], stop_reason: stop, usage }), {
    status: 200, headers: { "content-type": "application/json" },
  });
}

export function fakeModel(script: Script) {
  const sent: Sent[] = [];
  const seen: Record<Kind, number> = { stageA: 0, hinges: 0, handle: 0, meet: 0, stageB: 0, other: 0 };
  const pick = (s: Scripted | Scripted[] | ((i: number) => Scripted) | undefined, i: number): Scripted | undefined =>
    typeof s === "function" ? s(i) : Array.isArray(s) ? s[i % s.length] : s;
  const fetch = (url: string, init: RequestInit): Promise<Response> => {
    if (url !== "https://api.anthropic.com/v1/messages") return Promise.reject(new Error(`TEST FAILURE: unexpected fetch to ${url}`));
    const body = JSON.parse(String(init.body)) as Rec;
    const content = ((body.messages as Rec[])[0].content as Rec[]);
    const text = String(content[content.length - 1].text ?? "");
    const kind = kindOf(text);
    sent.push({ kind, body, text, images: content.filter((b) => b.type === "image").length });
    const s = pick(script[kind as keyof Script] as Scripted | Scripted[] | undefined, seen[kind]++);
    const signal = init.signal;
    if (s === undefined) return Promise.reject(new Error(`TEST FAILURE: no scripted reply for ${kind}`));
    if (s === "throw") return Promise.reject(new TypeError("network down"));
    if (s === "hang") {
      return new Promise((_, reject) => {
        const stop = () => reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
        if (signal?.aborted) stop();
        else signal?.addEventListener("abort", stop, { once: true });
      });
    }
    if (s === "cutoff") return Promise.resolve(reply('{"measure": {"size": [', { input_tokens: 3000, output_tokens: 12000 }, "max_tokens"));
    if (typeof s === "object" && "status" in s && typeof s.status === "number") {
      return Promise.resolve(new Response(String(s.body ?? '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'), { status: s.status }));
    }
    if (typeof s === "object" && "text" in s && typeof s.text === "string") return Promise.resolve(reply(s.text, script.usage, typeof s.stop === "string" ? s.stop : "end_turn"));
    return Promise.resolve(reply(s, script.usage));
  };
  return { fetch, sent, count: (k: Kind) => sent.filter((x) => x.kind === k).length };
}

// A PNG header of the given size: enough for imageHeadOf (and nothing decodes it but the fake library).
export function pngHead(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  b.set([8, 6, 0, 0, 0], 24);
  return b;
}

// The image library as the press reaches it (closeUp.ts's decode / Image), standing in for imagescript,
// which loads its WebAssembly from the network. Every pixel is `paint`.
export function fakeImageLibrary(paint: [number, number, number] = [150, 110, 70]) {
  class Image {
    width: number;
    height: number;
    bitmap: Uint8ClampedArray;
    constructor(w: number, h: number) {
      this.width = w;
      this.height = h;
      this.bitmap = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < w * h; i++) this.bitmap.set([...paint, 255], i * 4);
    }
    clone() { return this; }
    crop(_x: number, _y: number, w: number, h: number) { return new Image(Math.min(w, 64), Math.min(h, 64)); }
    resize(w: number, h: number) { return new Image(Math.min(w, 8), Math.min(h, 8)); }
    encodeJPEG(_q: number) { return Promise.resolve(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])); }
  }
  const decodes: number[] = [];
  const lib = {
    Image,
    decode: (bytes: Uint8Array) => {
      decodes.push(bytes.length);
      const v = new DataView(bytes.buffer, bytes.byteOffset);
      return Promise.resolve(new Image(v.getUint32(16), v.getUint32(20)));
    },
  };
  return { lib, decodes };
}
