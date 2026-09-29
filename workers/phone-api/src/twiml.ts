// A tiny TwiML builder. Every attribute value and every piece of text is escaped here, so no
// handler ever concatenates a caller-supplied string (a business name, a URL with &) into XML.
//
// Recording is OFF (SPEC section 3): nothing in this file emits a `record` attribute, and
// <Record> is used only for voicemail, which is the caller leaving a message on purpose.

type AttrValue = string | number | boolean | null | undefined;
export type Attrs = Record<string, AttrValue>;

/** For attribute values (always written in double quotes). */
export function escapeXml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** For text content: quotes need no escaping there, and "isn't" should read as written. */
export function escapeText(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function attrs(a: Attrs = {}): string {
  let out = "";
  for (const [k, v] of Object.entries(a)) {
    if (v === null || v === undefined || v === false) continue;
    out += ` ${k}="${escapeXml(String(v))}"`;
  }
  return out;
}

/** One element. `children` is already-built XML; use `text()` for literal text. */
export function el(name: string, a: Attrs = {}, children: string | string[] = ""): string {
  const inner = Array.isArray(children) ? children.join("") : children;
  return inner ? `<${name}${attrs(a)}>${inner}</${name}>` : `<${name}${attrs(a)}/>`;
}

export const text = escapeText;

export function response(...children: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${children.join("")}</Response>`;
}

export const say = (words: string): string => el("Say", { language: "en-US" }, text(words));
export const play = (url: string): string => el("Play", {}, text(url));
export const hangup = (): string => "<Hangup/>";

/** The status events every dialed noun reports (Twilio sends only `completed` unless asked). */
export const STATUS_EVENTS = "initiated ringing answered completed";

export interface ClientNoun {
  identity: string;
  statusCallback: string;
  /** Custom parameters delivered to the callee's CallInvite (e.g. the phone_calls id). */
  params?: Record<string, string>;
}

export function clientNoun(c: ClientNoun): string {
  const parts = [el("Identity", {}, text(c.identity))];
  for (const [name, value] of Object.entries(c.params ?? {})) {
    parts.push(el("Parameter", { name, value }));
  }
  return el("Client", {
    statusCallback: c.statusCallback,
    statusCallbackEvent: STATUS_EVENTS,
    statusCallbackMethod: "POST",
  }, parts);
}

export interface NumberNoun {
  e164: string;
  statusCallback: string;
  /** Whisper/screen URL run on the answered leg before it is bridged. */
  url?: string;
}

export function numberNoun(n: NumberNoun): string {
  return el("Number", {
    url: n.url,
    method: n.url ? "POST" : undefined,
    statusCallback: n.statusCallback,
    statusCallbackEvent: STATUS_EVENTS,
    statusCallbackMethod: "POST",
  }, text(n.e164));
}

export interface DialOpts {
  timeout?: number;
  action?: string;
  callerId?: string;
  answerOnBridge?: boolean;
}

export function dial(o: DialOpts, nouns: string[]): string {
  return el("Dial", {
    timeout: o.timeout,
    action: o.action,
    method: o.action ? "POST" : undefined,
    callerId: o.callerId,
    answerOnBridge: o.answerOnBridge ? "true" : undefined,
  }, nouns);
}

export interface RecordOpts {
  action: string;
  recordingStatusCallback: string;
  maxLength?: number;
  /** Twilio transcription (env TRANSCRIBE=on): the callback that receives the text. */
  transcribeCallback?: string;
}

export function record(o: RecordOpts): string {
  return el("Record", {
    action: o.action,
    method: "POST",
    maxLength: o.maxLength ?? 180,
    timeout: 5,
    playBeep: "true",
    finishOnKey: "#",
    trim: "trim-silence",
    recordingStatusCallback: o.recordingStatusCallback,
    recordingStatusCallbackMethod: "POST",
    recordingStatusCallbackEvent: "completed",
    transcribe: o.transcribeCallback ? "true" : undefined,
    transcribeCallback: o.transcribeCallback,
  });
}

export interface ConferenceOpts {
  /** The conference's name: always the phone_calls id. */
  name: string;
  startConferenceOnEnter: boolean;
  endConferenceOnExit: boolean;
  /**
   * What this leg hears while the conference has not started. Omitted = Twilio's default hold
   * music; "" = silence (Twilio plays nothing for an empty waitUrl).
   */
  waitUrl?: string;
  statusCallback: string;
  /** Conference events, TwiML spelling (start end join leave mute hold ...). */
  statusCallbackEvent: string;
}

/** <Dial><Conference/></Dial> with no action: a leg in a conference is never sent to voicemail. */
export function conference(o: ConferenceOpts): string {
  return el("Dial", {}, [el("Conference", {
    beep: "false",
    startConferenceOnEnter: o.startConferenceOnEnter ? "true" : "false",
    endConferenceOnExit: o.endConferenceOnExit ? "true" : "false",
    waitUrl: o.waitUrl,
    waitMethod: o.waitUrl ? "GET" : undefined,
    statusCallback: o.statusCallback,
    statusCallbackEvent: o.statusCallbackEvent,
    statusCallbackMethod: "POST",
  }, text(o.name))]);
}

export interface GatherOpts {
  action: string;
  numDigits?: number;
  timeout?: number;
}

export function gather(o: GatherOpts, children: string[]): string {
  return el("Gather", {
    action: o.action,
    method: "POST",
    numDigits: o.numDigits ?? 1,
    timeout: o.timeout ?? 8,
  }, children);
}
