/**
 * Real, decodable PNG and JPEG-shaped bytes for the PDF tests (estimatePdf_test, quotePdf_test,
 * quoteDocsWiring_test), so a logo test exercises pdf-lib's actual embedders rather than a header
 * that merely sniffs right.
 *
 * makePng writes a genuine 8-bit RGB PNG (IHDR, one zlib IDAT of filter-0 scanlines, IEND, with
 * real CRCs) that pdf-lib decodes. makeJpegShape writes SOI, APP0, a baseline frame header and
 * EOI: that is everything pdf-lib's JPEG embedder reads (it copies the bytes into the PDF as DCT
 * data without decoding them), so it embeds, but no viewer could draw it. It is for "a JPEG takes
 * the JPEG path" assertions only.
 *
 * pako is pdf-lib's own compression dependency (pdfText.ts uses it too), so this adds nothing to
 * the graph. Belongs to the _test_stubs group, which is allowed registry imports.
 */
import { deflate } from "npm:pako@2.1.0";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** A w x h RGB PNG; `paint(x, y)` gives each pixel's [r, g, b] (default: a two-tone block). */
export function makePng(
  w: number,
  h: number,
  paint: (x: number, y: number) => [number, number, number] = (x) => (x < w / 3 ? [27, 120, 149] : [30, 41, 59]),
): Uint8Array {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit, RGB, deflate, filter 0, no interlace
  const raw = new Uint8Array(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < w; x++) raw.set(paint(x, y), row + 1 + x * 3);
  }
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflate(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** JPEG-shaped bytes: SOI, a JFIF APP0, a baseline SOF0 frame header for w x h, EOI. See the
 *  header note. */
export function makeJpegShape(w: number, h: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
    0xff, 0xd9,
  ]);
}
