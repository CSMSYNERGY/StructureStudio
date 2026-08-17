// Shared validation for a building style's 3D appearance spec (`building_styles.d3`),
// plus the prompt that drafts one from photos.
//
// Why this is shared rather than inline: two functions write this column —
// portal-settings (the builder, JWT-resolved) and admin-save-settings (the operator,
// ADMIN_PASSWORD) — and the column is emitted straight to every anonymous customer
// browser by get_config. Two copies of the sanitiser would drift, and the day they
// drift is the day the weaker one becomes the way in. Same reasoning as
// resolveTenant.ts existing at all.
//
// The rule for everything below: REBUILD a clean object from known keys. Never store
// what the caller sent. A colour string here ends up inside a customer's page, and a
// number here drives geometry a quote is built from.

export const D3_ROOF_TYPES = ["shed", "gable", "gambrel"] as const;

// Room for a genuinely steep roof and a deep overhang, but not for the values that
// make the renderer produce nonsense (a "pitch" of 40 draws a spike through the sky).
const CLAMPS: Record<string, [number, number]> = {
  pitch: [0, 2],
  ridgeOffset: [-0.35, 0.35],   // saltbox shift, as a fraction of the half-span
  overhang: [0, 3],             // feet past the wall
  kneeU: [0, 1],                // gambrel knee, fraction of half-span
  kneeRise: [0, 1],
  ridgeRise: [0, 1.5],
};

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const clamped = (key: string, v: unknown): number | null => {
  const n = num(v);
  if (n === null) return null;
  const [lo, hi] = CLAMPS[key];
  return Math.min(hi, Math.max(lo, n));
};
// Hex only. This string is interpolated into a customer-facing page by the renderer,
// so "red", "url(...)", and anything else creative is dropped rather than argued with.
const hex = (v: unknown): string | null =>
  (typeof v === "string" && /^#[0-9a-fA-F]{3,8}$/.test(v.trim())) ? v.trim() : null;

export type D3Spec = {
  roof: Record<string, unknown>;
  siding: string | null;
  colors: Record<string, string>;
  wallHeightFt?: number;
  roofMaterial?: string;
};

export function sanitizeD3Spec(raw: unknown): { ok: true; d3: D3Spec } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "A 3D spec object is required." };
  const src = raw as Record<string, any>;
  const rawRoof = src.roof;
  if (!rawRoof || typeof rawRoof !== "object") return { ok: false, error: "The 3D spec needs a roof object." };

  const type = String(rawRoof.type || "");
  if (!(D3_ROOF_TYPES as readonly string[]).includes(type)) {
    return { ok: false, error: `Unknown roof type "${type}" — expected shed, gable or gambrel.` };
  }
  const roof: Record<string, unknown> = { type };
  for (const k of ["pitch", "ridgeOffset", "overhang", "kneeU", "kneeRise", "ridgeRise"]) {
    const v = clamped(k, rawRoof[k]);
    if (v !== null) roof[k] = v;
  }

  // Anything that is not one of the two renderable sidings means "plain", which is
  // what the renderer already does with null. Matches the AI validator's posture.
  const siding = (src.siding === "batten" || src.siding === "lap") ? src.siding : null;

  const colors: Record<string, string> = {};
  const rawColors = (src.colors && typeof src.colors === "object") ? src.colors : {};
  for (const k of ["body", "trim", "roof"]) {
    const c = hex(rawColors[k]);
    if (c) colors[k] = c;
  }

  const d3: D3Spec = { roof, siding, colors };
  const wh = num(src.wallHeightFt);
  if (wh !== null && wh >= 5 && wh <= 14) d3.wallHeightFt = wh;
  // The style's default roof MATERIAL (2026-08-15): the renderer textures the
  // roof with it before any customer roof-type pick. Same posture as siding —
  // anything unknown means "unset".
  if (src.roofMaterial === "shingle" || src.roofMaterial === "metal") d3.roofMaterial = src.roofMaterial;

  // A spec is a handful of numbers. Anything approaching this size is either a mistake
  // or someone using a customer-visible jsonb column as free storage.
  if (JSON.stringify(d3).length > 4096) return { ok: false, error: "That 3D spec is implausibly large." };
  return { ok: true, d3 };
}

// Reference photos for a spec: http(s) only, capped in both count and length. These are
// handed to the vision model AND rendered as thumbnails in the editor.
export function sanitizePhotoUrls(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u.trim()) && u.trim().length <= 600)
    .map((u) => u.trim())
    .slice(0, 4);
}

// Ported verbatim from calibrate-style so the drafted shape cannot drift from the
// shape the renderer consumes and the sanitiser above accepts.
export const SPEC_PROMPT = `You are calibrating a parametric 3D model of a portable building (shed/barn) to match the building in these photos.

Return ONLY a JSON object with this exact shape (no prose, no markdown fence):
{
  "roof": {
    "type": "shed" | "gable" | "gambrel",
    "pitch": <rise over run, e.g. 0.33 for 4:12>,
    "ridgeOffset": <-0.35..0.35, gable only: shifts the ridge toward one eave for a saltbox look; 0 if centred>,
    "overhang": <feet the roof projects past the wall, typically 0.3-1.0>,
    "kneeU": <gambrel only, 0..1: where the lower slope breaks, as a fraction of the half-span>,
    "kneeRise": <gambrel only, 0..1: height of the knee as a fraction of the half-span>,
    "ridgeRise": <gambrel only, 0..1.5: height of the ridge above the knee>
  },
  "siding": "batten" | "lap" | null,
  "colors": { "body": "#rrggbb", "trim": "#rrggbb", "roof": "#rrggbb" },
  "wallHeightFt": <estimated wall height, typically 6-10; doors are about 6.5 ft tall, use them for scale>
}

Judge the roof type from the silhouette: one slope = shed, two = gable, four (a break partway down each side) = gambrel. "batten" means vertical boards with raised strips over the seams; "lap" means horizontal overlapping boards. Colors are the dominant UNPAINTED material colors. Estimate conservatively and use typical values when a photo does not show something.`;

// Tolerant parse of a model reply: pull the first {...} out of whatever wrapping the
// model chose, then hold it to the same rules a hand-typed spec must satisfy.
export function parseModelSpec(text: string): { ok: true; d3: D3Spec } | { ok: false; error: string } {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) return { ok: false, error: "The model did not return a spec." };
  let parsed: unknown;
  try { parsed = JSON.parse(m[0]); } catch { return { ok: false, error: "The model returned malformed JSON." }; }
  return sanitizeD3Spec(parsed);
}
