// A small MIME reader for inbound customer email (2026-11-10).
//
// Amazon SES stores every received message in S3 exactly as it arrived: header lines, one empty
// line, then the body, which is usually a tree of multipart sections. An edge function reads
// those bytes and needs four things out of them: the headers, the plain-text body, the HTML body
// and a list of the attached files. This module does that and nothing more. It does not strip
// quoted replies or signatures (another module owns that), and it does not keep attachment
// bytes, only each file's name, type and size.
//
// Rules this file keeps:
//   - Zero imports. Only Deno/Web built-ins, so any function can share it and its tests run with
//     no import map.
//   - parseMime never throws. The input is whatever a stranger on the internet sent, so every bad
//     shape (empty, truncated, missing boundary, random bytes) degrades to empty strings.
//   - Linear work. A message can be 10 MB, so nothing here grows a string inside a loop over the
//     body, spreads a big array into a call, or rescans text it has already passed.
//
// How bytes are handled: the whole message is first turned into a "binary string" with exactly
// one char per byte (char code = byte value). Structure is then easy to find with indexOf and
// slice, and nothing is lost, because a part's body is turned back into the same bytes before
// its transfer encoding and charset are decoded. The price is that the usual string helpers are
// unsafe on these strings: trim() and \s treat byte 0xA0 as whitespace, and 0xA0 is also the
// second byte of a UTF-8 "a with grave". That is why this file has its own trimWs and never
// uses \s on raw input.

export type MimeAttachment = {
  filename: string;      // decoded (RFC 2047 / RFC 2231), "" when none
  contentType: string;   // lowercase, e.g. "application/pdf"
  size: number;          // decoded byte length
  inline: boolean;       // Content-Disposition: inline, or an image/* part with a Content-ID inside multipart/related
};

export type ParsedMail = {
  /** Lowercased header name -> value. Unfolded, RFC 2047 decoded. When a header repeats, the FIRST
   *  occurrence wins (the receiving server prepends its own headers at the top, so the first one
   *  is the one the sender could not plant). */
  headers: Record<string, string>;
  from: string;        // headers.from ?? ""
  to: string;
  subject: string;
  messageId: string;   // raw header value, angle brackets kept
  inReplyTo: string;
  references: string;
  text: string;        // first text/plain part that is not an attachment, charset-decoded
  html: string;        // first text/html part that is not an attachment, charset-decoded
  attachments: MimeAttachment[];
};

/** Multiparts nested deeper than this are not opened. Real mail rarely goes past four levels,
 *  so anything deeper is either broken or built to exhaust the stack. */
const MAX_DEPTH = 8;
/** Parts visited in one message, the message itself and every container included. Stops a mail
 *  made of a million tiny parts from turning into a million objects. */
const MAX_PARTS = 200;
/** RFC 2231 lets one parameter be split into numbered pieces. Nobody needs more than a handful. */
const MAX_PARAM_SEGMENTS = 64;
/** fromCharCode.apply passes its input as call arguments, and engines cap how many a call takes.
 *  32k at a time is far below every engine's limit. */
const CHUNK = 0x8000;

type RawHeaders = Record<string, string>;
type HeaderParams = { value: string; params: Map<string, string> };
type State = {
  text: string;
  html: string;
  hasText: boolean;
  hasHtml: boolean;
  attachments: MimeAttachment[];
  parts: number;
};

// ── Small byte and string helpers ─────────────────────────────────────────────────────────

/** Space, tab, CR or LF. Deliberately narrower than what trim() and \s accept (see the top). */
function isWs(c: number): boolean {
  return c === 32 || c === 9 || c === 13 || c === 10;
}

function trimWs(s: string): string {
  let a = 0, b = s.length;
  while (a < b && isWs(s.charCodeAt(a))) a++;
  while (b > a && isWs(s.charCodeAt(b - 1))) b--;
  return a === 0 && b === s.length ? s : s.slice(a, b);
}

/** The first word of a value, stopping at whitespace, ";" or "(". Transfer encodings and charset
 *  labels are single words, but mail in the wild appends comments and stray parameters to them. */
function firstToken(s: string): string {
  let a = 0;
  while (a < s.length && isWs(s.charCodeAt(a))) a++;
  let b = a;
  while (b < s.length) {
    const c = s.charCodeAt(b);
    if (isWs(c) || c === 59 || c === 40) break;
    b++;
  }
  return s.slice(a, b);
}

function bytesToBinary(bytes: Uint8Array): string {
  if (bytes.length <= CHUNK) return String.fromCharCode.apply(null, bytes as unknown as number[]);
  const pieces: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    pieces.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]));
  }
  return pieces.join("");
}

function binaryToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Whatever the caller handed over, as a binary string. A JS string is taken as already being
 *  one unless it holds a char above 0xFF, which no byte can be: then it is real text, and its
 *  UTF-8 bytes are what a mail server would have put on the wire. */
function toBinaryString(raw: unknown): string {
  if (typeof raw === "string") {
    for (let i = 0; i < raw.length; i++) {
      if (raw.charCodeAt(i) > 0xFF) return bytesToBinary(new TextEncoder().encode(raw));
    }
    return raw;
  }
  if (raw instanceof Uint8Array) return bytesToBinary(raw);
  if (raw instanceof ArrayBuffer) return bytesToBinary(new Uint8Array(raw));
  return "";
}

/** 0-15 for a hex digit, -1 for anything else (including the NaN that charCodeAt returns past
 *  the end of a string, which saves every caller a bounds check). */
function hexVal(c: number): number {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 65 && c <= 70) return c - 55;
  if (c >= 97 && c <= 102) return c - 87;
  return -1;
}

// ── Transfer encodings ────────────────────────────────────────────────────────────────────

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_VALUE = new Int8Array(256).fill(-1);
for (let i = 0; i < B64_ALPHABET.length; i++) B64_VALUE[B64_ALPHABET.charCodeAt(i)] = i;

/** Base64 that cannot fail. atob throws on a stray character or a wrong length, and a truncated
 *  attachment has exactly that, so this walks the text itself: anything outside the alphabet
 *  (line breaks, spaces, junk) is skipped and leftover bits at the end are dropped. A "=" also
 *  clears the leftover bits, so two padded blocks glued together still decode correctly. */
function base64ToBytes(s: string): Uint8Array {
  const out = new Uint8Array(Math.floor((s.length * 3) / 4) + 1);
  let acc = 0, bits = 0, n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 61) {
      acc = 0;
      bits = 0;
      continue;
    }
    const v = c < 256 ? B64_VALUE[c] : -1;
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 0xFF;
      acc &= (1 << bits) - 1;
    }
  }
  return out.subarray(0, n);
}

/** Quoted-printable: "=XY" is one byte, "=" at the end of a line joins it to the next line.
 *  A "=" followed by anything else is not valid, and is kept as typed, because dropping
 *  characters from a customer's message is worse than showing a stray equals sign. */
function quotedPrintableToBytes(s: string): Uint8Array {
  const len = s.length;
  const out = new Uint8Array(len);
  let n = 0;
  for (let i = 0; i < len; i++) {
    const c = s.charCodeAt(i);
    if (c !== 61) {
      out[n++] = c;
      continue;
    }
    const hi = hexVal(s.charCodeAt(i + 1)), lo = hexVal(s.charCodeAt(i + 2));
    if (hi >= 0 && lo >= 0) {
      out[n++] = (hi << 4) | lo;
      i += 2;
      continue;
    }
    // Mail servers may pad a line with spaces after the "=", so look past them for the newline.
    let j = i + 1;
    while (j < len && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9)) j++;
    // "=" as the very last thing is a soft break whose newline went to the boundary line.
    if (j >= len) break;
    if (s.charCodeAt(j) === 13 && s.charCodeAt(j + 1) === 10) {
      i = j + 1;
      continue;
    }
    if (s.charCodeAt(j) === 10) {
      i = j;
      continue;
    }
    out[n++] = c;
  }
  return out.subarray(0, n);
}

/** A part's body as the bytes the sender meant. 7bit, 8bit, binary and anything unrecognised
 *  are all "the bytes are already the content". */
function transferDecode(body: string, encoding: string): Uint8Array {
  if (encoding === "base64") return base64ToBytes(body);
  if (encoding === "quoted-printable") return quotedPrintableToBytes(body);
  return binaryToBytes(body);
}

/** Only the size is wanted for an attachment, so the plain encodings skip the copy entirely. */
function decodedSize(body: string, encoding: string): number {
  if (encoding === "base64") return base64ToBytes(body).length;
  if (encoding === "quoted-printable") return quotedPrintableToBytes(body).length;
  return body.length;
}

// ── Charsets ──────────────────────────────────────────────────────────────────────────────

/** Bytes to text. A named charset is trusted when the runtime knows it. "us-ascii" is not passed
 *  on, for two reasons: the Encoding Standard maps that label to windows-1252, and senders write
 *  it on mail that is really UTF-8. So us-ascii, no label and unknown labels all get the same
 *  guess: UTF-8 when the bytes are valid UTF-8, windows-1252 otherwise (it has a character for
 *  nearly every byte, so the worst case is a wrong accent, not a lost message). */
function decodeBytes(bytes: Uint8Array, charset: string): string {
  const label = firstToken(charset).toLowerCase();
  if (label !== "" && label !== "us-ascii" && label !== "ascii" && label !== "ansi_x3.4-1968" && label !== "iso646-us") {
    try {
      return new TextDecoder(label, { fatal: false }).decode(bytes);
    } catch {
      // A label this runtime has never heard of. Fall through to the guess below.
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Not valid UTF-8, so it is some single-byte charset.
  }
  try {
    return new TextDecoder("windows-1252").decode(bytes);
  } catch {
    return "";
  }
}

/** Header text that was sent as raw 8-bit bytes instead of RFC 2047 words. Plain ASCII, the
 *  normal case, is returned untouched without a copy. */
function decodeLoose(s: string): string {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x7F) return decodeBytes(binaryToBytes(s), "");
  }
  return s;
}

/** Replaces control characters with a space. An encoded word can hide a CR, LF or NUL that the
 *  unfolding never saw, and a decoded header that is later shown, logged or written into another
 *  message must stay one line. Done with char codes because a regex holding control characters
 *  fails the linter. */
function oneLine(s: string): string {
  let i = 0;
  for (; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || c === 127) break;
  }
  if (i === s.length) return s;
  const out: string[] = [];
  let run = 0;
  for (; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || c === 127) {
      out.push(s.slice(run, i), " ");
      run = i + 1;
    }
  }
  out.push(s.slice(run));
  return out.join("");
}

// ── Headers ───────────────────────────────────────────────────────────────────────────────

/** =?charset?B?base64?= or =?charset?Q?quoted?=. Every piece stops at the next "?", so a header
 *  stuffed with "=?" cannot make this backtrack over the same text twice. */
const ENCODED_WORD = /=\?([^? \t\r\n]+)\?([bBqQ])\?([^?]*)\?=/g;

/** Decodes RFC 2047 encoded words inside one header value. Whitespace between two encoded words
 *  is dropped, as the RFC says, because the sender only split them to keep lines short. Neighbours
 *  in the same charset are decoded as one run of bytes: some mailers split in the middle of a
 *  multi-byte character, and decoding each word alone would turn that character into two marks. */
function decodeHeaderValue(value: string): string {
  if (value.indexOf("=?") < 0) return oneLine(decodeLoose(value));
  const out: string[] = [];
  let pending: Uint8Array[] = [];
  let pendingCharset = "";
  const flush = () => {
    if (pending.length === 0) return;
    out.push(decodeBytes(concatBytes(pending), pendingCharset));
    pending = [];
  };
  let last = 0;
  for (const m of value.matchAll(ENCODED_WORD)) {
    const at = m.index ?? 0;
    const gap = value.slice(last, at);
    if (pending.length === 0 || trimWs(gap) !== "") {
      flush();
      out.push(decodeLoose(gap));
    }
    // "utf-8*en" carries a language tag after the star (RFC 2231). Only the charset matters.
    const charset = m[1].split("*")[0].toLowerCase();
    if (pending.length > 0 && charset !== pendingCharset) flush();
    pendingCharset = charset;
    pending.push(
      m[2] === "B" || m[2] === "b"
        ? base64ToBytes(m[3])
        // In the Q form an underscore stands for a space, the rest is quoted-printable.
        : quotedPrintableToBytes(m[3].replace(/_/g, " ")),
    );
    last = at + m[0].length;
  }
  flush();
  out.push(decodeLoose(value.slice(last)));
  return oneLine(out.join(""));
}

/** Cuts a message or a part at its first empty line. With no empty line there is no body: the
 *  whole thing is header lines (a mail cut off inside its headers looks like this). */
function splitHeadBody(s: string): { head: string; body: string } {
  let pos = 0;
  while (pos < s.length) {
    const nl = s.indexOf("\n", pos);
    if (nl < 0) break;
    const len = nl - pos;
    if (len === 0 || (len === 1 && s.charCodeAt(pos) === 13)) {
      return { head: s.slice(0, pos), body: s.slice(nl + 1) };
    }
    pos = nl + 1;
  }
  return { head: s, body: "" };
}

/** Where the ":" that ends a header name sits, or -1 when the line is not a header. A name is
 *  printable ASCII with no spaces. Checking that is what keeps random bytes, and the mbox
 *  "From someone Mon Nov ..." line, from becoming headers. */
function headerNameEnd(head: string, from: number, to: number): number {
  for (let i = from; i < to; i++) {
    const c = head.charCodeAt(i);
    if (c === 58) return i > from ? i : -1;
    if (c <= 32 || c >= 127) return -1;
  }
  return -1;
}

/** Header lines to a name -> raw value map. Names are lowercased, folded lines are joined with
 *  one space, and a repeated name keeps its first value (see ParsedMail.headers for why).
 *
 *  The map has no prototype on purpose. Header names come from the sender, and on a normal
 *  object a header called "constructor" or "__proto__" would collide with built-in members. */
function parseHeaderBlock(head: string): RawHeaders {
  const out: RawHeaders = Object.create(null);
  let name = "";
  let pieces: string[] = [];
  const commit = () => {
    if (name !== "" && !(name in out)) out[name] = trimWs(pieces.join(""));
  };
  let pos = 0;
  while (pos < head.length) {
    let nl = head.indexOf("\n", pos);
    if (nl < 0) nl = head.length;
    let end = nl;
    if (end > pos && head.charCodeAt(end - 1) === 13) end--;
    if (end > pos) {
      const first = head.charCodeAt(pos);
      if (first === 32 || first === 9) {
        // A line that starts with a space or tab continues the header above it. Outlook folds
        // with a tab and Gmail with spaces, so the indent is replaced by one space either way.
        const more = trimWs(head.slice(pos, end));
        if (name !== "" && more !== "") pieces.push(" ", more);
      } else {
        commit();
        const colon = headerNameEnd(head, pos, end);
        if (colon >= 0) {
          name = head.slice(pos, colon).toLowerCase();
          pieces = [trimWs(head.slice(colon + 1, end))];
        } else {
          name = "";
          pieces = [];
        }
      }
    }
    pos = nl + 1;
  }
  commit();
  return out;
}

/** Splits a value such as `multipart/mixed; boundary="abc"; charset=utf-8` into its main value
 *  (lowercased) and its parameters (names lowercased, values as written, quotes removed).
 *  Parsed from the RAW header, before any RFC 2047 decoding: a decoded file name may itself
 *  contain a quote or a semicolon, and would then be cut in the wrong place. */
function parseParams(raw: string): HeaderParams {
  const params = new Map<string, string>();
  const len = raw.length;
  const semi = raw.indexOf(";");
  const value = trimWs(semi < 0 ? raw : raw.slice(0, semi)).toLowerCase();
  let i = semi < 0 ? len : semi + 1;
  while (i < len) {
    while (i < len && (isWs(raw.charCodeAt(i)) || raw.charCodeAt(i) === 59)) i++;
    const nameStart = i;
    while (i < len && raw.charCodeAt(i) !== 61 && raw.charCodeAt(i) !== 59) i++;
    // A bare word with no "=" is not a parameter. Skip it and carry on with the next one.
    if (i >= len || raw.charCodeAt(i) === 59) continue;
    const name = trimWs(raw.slice(nameStart, i)).toLowerCase();
    i++;
    while (i < len && isWs(raw.charCodeAt(i))) i++;
    let val: string;
    if (raw.charCodeAt(i) === 34) {
      i++;
      const pieces: string[] = [];
      let run = i;
      while (i < len && raw.charCodeAt(i) !== 34) {
        // Only \" and \\ are treated as escapes. Old Windows mailers put whole paths in file
        // names, and dropping every backslash would glue C:\Users\name into one word.
        const next = raw.charCodeAt(i + 1);
        if (raw.charCodeAt(i) === 92 && (next === 34 || next === 92)) {
          pieces.push(raw.slice(run, i));
          i++;
          run = i;
        }
        i++;
      }
      pieces.push(raw.slice(run, i));
      val = pieces.join("");
      i++;
    } else {
      // Unquoted values should stop at a space, but file names with spaces and no quotes are
      // common enough that reading up to the next ";" loses less.
      const valStart = i;
      while (i < len && raw.charCodeAt(i) !== 59) i++;
      val = trimWs(raw.slice(valStart, i));
    }
    if (name !== "" && !params.has(name)) params.set(name, val);
  }
  return { value, params };
}

/** "%C3%A4" style text to bytes. A "%" that is not followed by two hex digits stays a "%". */
function percentToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 37) {
      const hi = hexVal(s.charCodeAt(i + 1)), lo = hexVal(s.charCodeAt(i + 2));
      if (hi >= 0 && lo >= 0) {
        out[n++] = (hi << 4) | lo;
        i += 2;
        continue;
      }
    }
    out[n++] = c;
  }
  return out.subarray(0, n);
}

/** RFC 2231 extended values look like charset'language'percent-encoded-text. */
function splitExtended(v: string): { charset: string; rest: string } {
  const q1 = v.indexOf("'");
  const q2 = q1 < 0 ? -1 : v.indexOf("'", q1 + 1);
  if (q2 < 0) return { charset: "", rest: v };
  return { charset: v.slice(0, q1), rest: v.slice(q2 + 1) };
}

/** A parameter as readable text, trying the three ways a mailer may have written it:
 *    filename*=UTF-8''na%C3%AFve.pdf            RFC 2231, preferred when present (RFC 6266)
 *    filename*0*=UTF-8''na%C3; filename*1=...   RFC 2231 split into numbered pieces
 *    filename="=?UTF-8?B?...?="                 plain, possibly holding RFC 2047 words
 *  The result is what the sender chose to call the file. It is not cleaned of slashes or dots,
 *  so a caller that stores the file must build its own safe path. */
function paramText(params: Map<string, string>, base: string): string {
  const single = params.get(base + "*");
  if (single !== undefined) {
    const ext = splitExtended(single);
    return decodeBytes(percentToBytes(ext.rest), ext.charset);
  }
  if (params.has(base + "*0*") || params.has(base + "*0")) {
    const chunks: Uint8Array[] = [];
    let charset = "";
    for (let n = 0; n < MAX_PARAM_SEGMENTS; n++) {
      const encoded = params.get(`${base}*${n}*`);
      if (encoded !== undefined) {
        // Only the first piece names the charset. Later pieces are just more encoded text.
        if (n === 0) {
          const ext = splitExtended(encoded);
          charset = ext.charset;
          chunks.push(percentToBytes(ext.rest));
        } else {
          chunks.push(percentToBytes(encoded));
        }
        continue;
      }
      const plain = params.get(`${base}*${n}`);
      if (plain === undefined) break;
      chunks.push(binaryToBytes(plain));
    }
    return chunks.length === 0 ? "" : decodeBytes(concatBytes(chunks), charset);
  }
  const plain = params.get(base);
  return plain === undefined ? "" : decodeHeaderValue(plain);
}

// ── Multipart ─────────────────────────────────────────────────────────────────────────────

/** Cuts a multipart body into its parts (each still "headers, empty line, body").
 *
 *  A delimiter is a whole line: "--boundary", or "--boundary--" for the last one, with nothing
 *  after it but padding. Requiring the whole line matters because mailers derive an inner
 *  boundary from the outer one, so "--abc" must not match the line "--abcdef".
 *
 *  Text before the first delimiter and after the closing one is ignored (it is the "your mail
 *  program cannot read this" notice). If the closing delimiter never comes the mail was cut
 *  short, and whatever follows the last delimiter is still returned as the final part.
 *
 *  Returns null when no delimiter line exists at all, which the caller treats differently from
 *  "delimiters found, but the part budget ran out". */
function splitMultipart(body: string, boundary: string, maxParts: number): string[] | null {
  const delim = "--" + boundary;
  const parts: string[] = [];
  let partStart = -1;
  let from = 0;
  while (parts.length < maxParts) {
    const at = body.indexOf(delim, from);
    if (at < 0) break;
    // Safe to jump the whole match: a boundary cannot hold a newline, so no other delimiter
    // line can begin inside this one.
    from = at + delim.length;
    if (at > 0 && body.charCodeAt(at - 1) !== 10) continue;
    let i = from;
    let closing = false;
    if (body.charCodeAt(i) === 45 && body.charCodeAt(i + 1) === 45) {
      closing = true;
      i += 2;
    }
    while (i < body.length) {
      const c = body.charCodeAt(i);
      if (c !== 32 && c !== 9 && c !== 13) break;
      i++;
    }
    if (i < body.length && body.charCodeAt(i) !== 10) continue;
    if (partStart >= 0) {
      // The line break just before a delimiter belongs to the delimiter, not to the part.
      let end = at;
      if (end > partStart && body.charCodeAt(end - 1) === 10) {
        end--;
        if (end > partStart && body.charCodeAt(end - 1) === 13) end--;
      }
      parts.push(body.slice(partStart, end));
    }
    if (closing) return parts;
    partStart = Math.min(i + 1, body.length);
  }
  if (partStart < 0) return null;
  if (parts.length < maxParts) {
    const tail = body.slice(partStart);
    if (trimWs(tail) !== "") parts.push(tail);
  }
  return parts;
}

/** Visits one part: opens it if it is a multipart, otherwise files it as the text body, the
 *  HTML body or an attachment. */
function walkPart(h: RawHeaders, body: string, depth: number, inRelated: boolean, st: State): void {
  if (st.parts >= MAX_PARTS) return;
  st.parts++;
  const ct = parseParams(h["content-type"] ?? "");
  // No Content-Type, or one with no "/" in it, means plain text (RFC 2045 section 5.2).
  const type = ct.value.indexOf("/") > 0 ? ct.value : "text/plain";
  const encoding = firstToken(h["content-transfer-encoding"] ?? "").toLowerCase();
  const charset = ct.params.get("charset") ?? "";

  if (type.startsWith("multipart/")) {
    // Past the depth cap the nested multipart is skipped whole. Listing it as an attachment
    // would show the customer's reply with a nameless file nobody can open.
    if (depth >= MAX_DEPTH) return;
    const boundary = ct.params.get("boundary") ?? "";
    const pieces = boundary === "" ? null : splitMultipart(body, boundary, MAX_PARTS - st.parts);
    if (pieces === null) {
      // It says multipart but cannot be split: no boundary was named, or the named one never
      // appears. Showing the raw body as text beats showing an empty message.
      if (!st.hasText && trimWs(body) !== "") {
        st.hasText = true;
        st.text = decodeBytes(transferDecode(body, encoding), charset);
      }
      return;
    }
    const related = inRelated || type === "multipart/related";
    for (const piece of pieces) {
      const split = splitHeadBody(piece);
      walkPart(parseHeaderBlock(split.head), split.body, depth + 1, related, st);
    }
    return;
  }

  const cd = parseParams(h["content-disposition"] ?? "");
  const filename = oneLine(paramText(cd.params, "filename") || paramText(ct.params, "name")).trim();
  const isBodyType = type === "text/plain" || type === "text/html";
  // message/rfc822 (a forwarded mail) lands here as an attachment and is never opened: its
  // text is the forwarded person's words, not the reply.
  const isAttachment = cd.value === "attachment" || filename !== "" || !isBodyType;

  if (!isAttachment) {
    // Only the first body of each kind is kept. Later ones are dropped, not listed as files.
    if (type === "text/plain") {
      if (!st.hasText) {
        st.hasText = true;
        st.text = decodeBytes(transferDecode(body, encoding), charset);
      }
    } else if (!st.hasHtml) {
      st.hasHtml = true;
      st.html = decodeBytes(transferDecode(body, encoding), charset);
    }
    return;
  }

  // Pictures placed in the HTML (a logo in a signature) often carry no Content-Disposition.
  // Inside multipart/related, a Content-ID on an image is how the HTML points at it.
  const inline = cd.value === "inline" ||
    (inRelated && type.startsWith("image/") && (h["content-id"] ?? "") !== "");
  st.attachments.push({ filename, contentType: type, size: decodedSize(body, encoding), inline });
}

/** Reads one raw email. Never throws: whatever could not be understood comes back as "" or []. */
export function parseMime(raw: Uint8Array | string): ParsedMail {
  const headers: Record<string, string> = Object.create(null);
  const st: State = { text: "", html: "", hasText: false, hasHtml: false, attachments: [], parts: 0 };
  try {
    const message = toBinaryString(raw);
    const split = splitHeadBody(message);
    const rawHeaders = parseHeaderBlock(split.head);
    for (const name of Object.keys(rawHeaders)) headers[name] = decodeHeaderValue(rawHeaders[name]);
    walkPart(rawHeaders, split.body, 0, false, st);
  } catch {
    // Nothing above is expected to throw. This is the last line of defence for the promise in
    // the function's name: the caller gets whatever was collected before the surprise.
  }
  return {
    headers,
    from: headers["from"] ?? "",
    to: headers["to"] ?? "",
    subject: headers["subject"] ?? "",
    messageId: headers["message-id"] ?? "",
    inReplyTo: headers["in-reply-to"] ?? "",
    references: headers["references"] ?? "",
    text: st.text,
    html: st.html,
    attachments: st.attachments,
  };
}
