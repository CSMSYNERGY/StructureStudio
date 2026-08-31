/**
 * Read the drawn text back out of a pdf-lib document, for tests that need to prove something
 * actually RENDERED rather than that the builder merely returned bytes.
 *
 * pdf-lib flate-compresses content streams AND hex-encodes drawn strings, so recovering the
 * text means: find each stream (skipping the trailing half of "endstream"), trim the EOL
 * pdf-lib appends before "endstream" (pako refuses trailing bytes), inflate, then decode the
 * <hex> string operands back to text. pako is pdf-lib's own compression dependency, so this
 * adds nothing new to the graph.
 *
 * Extracted here 2026-08-27 when the sales-tax tests became the second consumer — the same
 * reason deHtml moved into _shared. A pair of PDF readers that must agree about what "the
 * document says" is exactly the drift worth avoiding, and this one is subtle enough
 * (endstream ambiguity, the EOL trim) that a second hand-rolled copy would quietly differ.
 *
 * Belongs to the _test_stubs group, which is allowed registry imports; the self-contained
 * _shared/*.test.ts group bans jsr:/npm: so it can run offline.
 */
export async function pdfText(bytes: Uint8Array): Promise<string> {
  const { inflate } = await import("npm:pako@2.1.0");
  const raw = new TextDecoder("latin1").decode(bytes);
  let out = "";
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    if (raw.slice(Math.max(0, m.index - 3), m.index) === "end") continue;
    const start = m.index + m[0].length;

    // THE STREAM'S LENGTH COMES FROM ITS DICTIONARY, not from searching for "endstream".
    //
    // The older approach — find the next "endstream", then strip the EOL bytes pdf-lib writes
    // before it — is wrong in two ways at once, and both bit on 2026-08-28:
    //   1. a DEFLATE body is arbitrary bytes and can contain the literal "endstream", and
    //   2. worse, when the body's LAST byte happens to be 0x0A or 0x0D, the EOL strip eats a
    //      real data byte, pako rejects the truncated body, and the stream is dropped.
    // The symptom of (2) was a perfectly valid PDF whose entire totals block appeared to be
    // missing — the test failed, the document was fine. A test harness that can silently lose
    // half a document is worse than no harness, so the length is now read, not guessed.
    const dict = raw.slice(Math.max(0, m.index - 400), m.index);
    const lenMatch = /\/Length\s+(\d+)[^/]*$/.exec(dict) ?? /\/Length\s+(\d+)/.exec(dict);
    const candidates: number[] = [];
    if (lenMatch) candidates.push(start + Number(lenMatch[1]));
    // Fallback for an indirect /Length (pdf-lib does not emit one, but a fixture from another
    // producer might): walk the "endstream" candidates, untrimmed then trimmed.
    let at = start;
    for (let i = 0; i < 4; i++) {
      const e = raw.indexOf("endstream", at);
      if (e < 0) break;
      at = e + 9;
      candidates.push(e);
      let t = e;
      while (t > start && (bytes[t - 1] === 0x0a || bytes[t - 1] === 0x0d)) t--;
      if (t !== e) candidates.push(t);
    }
    for (const end of candidates) {
      if (end <= start || end > bytes.length) continue;
      try {
        const inflated = inflate(bytes.subarray(start, end));
        if (inflated && inflated.length) {
          out += new TextDecoder("latin1").decode(inflated);
          break;
        }
      } catch { /* wrong boundary — try the next candidate */ }
    }
  }
  return out.replace(/<([0-9A-Fa-f]+)>/g, (_all, h: string) => {
    let s = "";
    for (let i = 0; i + 1 < h.length; i += 2) s += String.fromCharCode(parseInt(h.slice(i, i + 2), 16));
    return s;
  });
}
