// The builder's logo on the formal estimate / quote / invoice PDF (2026-10-05).
//
// Carolyn, 2026-08-06 (Fathom 775681234, 1:00:07): the printed estimate should carry "the
// letterhead". The text letterhead (name, phone, website, address) shipped 08-10; the logo was left
// out on purpose (the old TODO in estimatePdf.ts) because it is a remote fetch on the submit path.
// This module is that fetch, made safe enough to sit there:
//
//   * ONLY OUR OWN STORAGE, ONLY THIS TENANT'S FOLDER. client_settings.business_logo_url is
//     whatever the Settings box holds, and the box also takes a pasted URL. The server fetches what
//     this returns, so it accepts exactly `<project>/storage/v1/object/public/branding/<tenant>/<one
//     plain file name>` (where upload_logo puts it) after the URL parser has resolved any "../",
//     and nothing else: no other host, bucket, tenant or folder, no percent-escapes. A pasted logo
//     from another site still shows in emails; it just is not fetched by the server.
//   * SCALED BY STORAGE, NOT BY US. Logos are uploaded at whatever size the builder had: on
//     2026-10-05 the live ones were a 2084x882 JPEG, a 1254x1254 PNG and an 11000x7000 PNG (77
//     million pixels in 606 KB). pdf-lib decodes a PNG to raw pixels and re-compresses them, which
//     cost ~700 ms of CPU for the 1254x1254 one and would need ~300 MB of memory for the big one.
//     So the first fetch asks Storage's image service for a copy scaled into 640x200 (contain,
//     same format), which came back at 14-39 KB and embeds in under 30 ms. A cold scale took
//     1.8-2.5 s from here; a repeat ~0.12 s (it is cached).
//   * THE ORIGINAL ONLY AS A FALLBACK, AND ONLY IF IT IS SMALL. If the image service refuses (a plan
//     without it, an unsupported format), the original is fetched within what is left of the same
//     budget, and a PNG is embedded only up to LOGO_MAX_PNG_PIXELS. A JPEG is copied into the PDF
//     as it is (no decode), so only the byte cap applies to it.
//   * NEVER THROWS, NEVER BLOCKS THE DOCUMENT. One 3 s budget for both tries, a 1 MB cap on what is
//     read, PNG or JPEG by their bytes (not by a header). Every refusal comes back as null plus one
//     reason for the caller's telemetry, and the document prints the text letterhead it always had.
//     Storage's image service bills per distinct source image per month; one logo per builder is
//     far inside what the plan includes.
//
// Deliberately dependency-free (no jsr:/npm: imports): pdfLogo.test.ts runs in the self-contained
// _shared group, and estimatePdf.ts uses sniffLogo/logoUnfit without pulling in a network path.

/** What is read, at most. The upload allows 2 MB; a logo past 1 MB is not one a PDF should carry. */
export const LOGO_MAX_BYTES = 1024 * 1024;
/** One budget for the scaled fetch and the fallback together. */
export const LOGO_FETCH_TIMEOUT_MS = 3_000;
/** A PNG above this many pixels is not decoded (~200 ms of CPU at the measured ~0.5 us a pixel). */
export const LOGO_MAX_PNG_PIXELS = 400_000;
/** The box Storage scales the logo into before we fetch it: 3x the 48 pt it prints at, roughly. */
export const LOGO_RENDER_BOX = { width: 640, height: 200 };

export interface PdfLogoSources {
  /** Storage's scaled copy of the logo (render/image), tried first. */
  render: string;
  /** The uploaded file itself, tried only when the scaled copy is refused. */
  original: string;
}

const PLAIN_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/;
const TENANT = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * Where the server may fetch this tenant's logo from, or null when the stored URL is not one of
 * ours. `supabaseUrl` is the project's own SUPABASE_URL; `clientId` the resolved tenant.
 */
export function pdfLogoSources(raw: unknown, supabaseUrl: string, clientId: string): PdfLogoSources | null {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s || !TENANT.test(String(clientId ?? ""))) return null;
  let origin: string;
  try {
    origin = new URL(String(supabaseUrl ?? "")).origin;
  } catch {
    return null;
  }
  const folder = `/storage/v1/object/public/branding/${clientId}/`;
  // The string first (the tenantStorageUrl rule in submit-estimate), then the parsed URL: the parser
  // resolves "../" and "%2e%2e" before the comparison, so a value that passes both can only name a
  // file inside this tenant's folder.
  if (!s.startsWith(origin + folder)) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.origin !== origin || !u.pathname.startsWith(folder)) return null;
  const name = u.pathname.slice(folder.length);
  if (!PLAIN_NAME.test(name)) return null;
  const q = `width=${LOGO_RENDER_BOX.width}&height=${LOGO_RENDER_BOX.height}&resize=contain&format=origin`;
  return {
    render: `${origin}/storage/v1/render/image/public/branding/${clientId}/${name}?${q}`,
    original: `${origin}${folder}${name}`,
  };
}

export interface LogoShape {
  kind: "png" | "jpeg";
  width: number;
  height: number;
}

/** PNG or JPEG, and its pixel size, read from the bytes themselves. Anything else is null. */
export function sniffLogo(bytes: Uint8Array | null | undefined): LogoShape | null {
  if (!bytes || bytes.length < 24) return null;
  const b = bytes;
  // PNG: the 8-byte signature, then IHDR first (the spec requires it), width/height big-endian.
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a &&
    b[6] === 0x1a && b[7] === 0x0a) {
    if (b[12] !== 0x49 || b[13] !== 0x48 || b[14] !== 0x44 || b[15] !== 0x52) return null; // "IHDR"
    const be32 = (i: number) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
    return { kind: "png", width: be32(16), height: be32(20) };
  }
  // JPEG: SOI, then walk the marker segments to the first frame header (SOF0-SOF15, except DHT C4,
  // JPG C8 and DAC CC, which share the range). Bounded by the buffer, so a truncated file is null.
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 3 < b.length) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1];
      if (m === 0xff) { i++; continue; } // fill byte
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd9)) { i += 2; continue; } // no length
      const len = (b[i + 2] << 8) + b[i + 3];
      if (len < 2) return null;
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        if (i + 8 >= b.length) return null;
        return { kind: "jpeg", width: (b[i + 7] << 8) + b[i + 8], height: (b[i + 5] << 8) + b[i + 6] };
      }
      i += 2 + len;
    }
  }
  return null;
}

/** Why these bytes cannot go on the PDF, or null when they can. */
export function logoUnfit(bytes: Uint8Array | null | undefined): string | null {
  if (!bytes || bytes.length === 0) return "empty";
  if (bytes.length > LOGO_MAX_BYTES) return "over 1 MB";
  const shape = sniffLogo(bytes);
  if (!shape) return "not a PNG or JPEG";
  if (shape.width < 1 || shape.height < 1) return "no size";
  if (shape.kind === "png" && shape.width * shape.height > LOGO_MAX_PNG_PIXELS) {
    return `${shape.width}x${shape.height} PNG is too big to embed`;
  }
  return null;
}

/** The body, up to `cap` bytes; null past it (the rest is never read). */
async function readCapped(res: Response, cap: number): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      try { await reader.cancel(); } catch { /* already closed */ }
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

/**
 * Fetch the logo: Storage's scaled copy first, the original if that is refused, both inside one
 * budget. Returns the bytes of a PNG or JPEG fit to embed, or null with exactly one `note` saying
 * why. Never throws.
 */
export async function fetchPdfLogo(
  src: PdfLogoSources | null | undefined,
  note: (reason: string) => void,
  timeoutMs: number = LOGO_FETCH_TIMEOUT_MS,
): Promise<Uint8Array | null> {
  const say = (r: string) => { try { note(r); } catch { /* telemetry only */ } };
  if (!src) return null;
  const deadline = Date.now() + timeoutMs;
  const refused: string[] = [];
  for (const [label, url] of [["scaled", src.render], ["original", src.original]] as const) {
    const left = deadline - Date.now();
    if (left <= 0) { say(`logo fetch timed out${refused.length ? ` (${refused.join("; ")})` : ""}`); return null; }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(left) });
      if (!res.ok) {
        try { await res.body?.cancel(); } catch { /* nothing to drain */ }
        refused.push(`${label} ${res.status}`);
        continue;
      }
      const declared = Number(res.headers.get("content-length") ?? "");
      if (Number.isFinite(declared) && declared > LOGO_MAX_BYTES) {
        try { await res.body?.cancel(); } catch { /* nothing to drain */ }
        refused.push(`${label} over 1 MB`);
        continue;
      }
      const bytes = await readCapped(res, LOGO_MAX_BYTES);
      const unfit = bytes ? logoUnfit(bytes) : "over 1 MB";
      if (unfit) { refused.push(`${label} ${unfit}`); continue; }
      return bytes;
    } catch (e) {
      const name = (e as Error)?.name || "error";
      // The budget is spent: there is no time left for the fallback either.
      if (name === "TimeoutError" || name === "AbortError") {
        say(`logo fetch timed out${refused.length ? ` (${refused.join("; ")})` : ""}`);
        return null;
      }
      refused.push(`${label} ${name}`);
    }
  }
  say(`logo skipped: ${refused.join("; ")}`);
  return null;
}
