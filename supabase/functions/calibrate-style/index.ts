import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// AI style calibration for the 3D designer (operator tool, plan §"four-sided
// photos"). Takes up to four reference photos of a building style and drafts
// the parametric d3 spec — roof type/pitch/overhang, siding, natural colors,
// wall height — that makes the 3D engine render true to that construction.
// The photos are the calibration REFERENCE; the model never renders from them.
//
// Gated by the shared ADMIN_PASSWORD secret (same as admin-save-settings).
// Requires the ANTHROPIC_API_KEY secret. NOT YET DEPLOYED as of 2026-07-02 —
// deploy via Supabase MCP/CLI and set the secret before the "Draft from
// photos (AI)" button works; the editor's manual fields work without it.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

const SPEC_PROMPT = `You are calibrating a parametric 3D model of a portable building (shed/barn) to match the style shown in the attached reference photos (typically four sides of the same building style).

Return ONLY a JSON object — no prose, no code fences — with exactly this shape:
{
  "roof": {
    "type": "shed" | "gable" | "gambrel",
    "pitch": <number, rise/run of the roof slope, e.g. 0.33 for 4:12; omit for gambrel>,
    "ridgeOffset": <number -0.35..0.35, 0 if the gable ridge is centered; negative shifts toward the building's left eave>,
    "overhang": <number, roof overhang past the walls in feet, e.g. 0.1 for almost none, 1.0 for a wide eave>,
    "kneeU": <gambrel only: knee horizontal position as fraction of half-span, ~0.55>,
    "kneeRise": <gambrel only: knee height as fraction of half-span, ~0.55>,
    "ridgeRise": <gambrel only: ridge height as fraction of half-span, ~0.8>
  },
  "siding": "batten" | "lap" | null,
  "colors": { "body": "<hex>", "trim": "<hex>", "roof": "<hex>" },
  "wallHeightFt": <number, wall plate height in feet estimated from door proportions (doors are ~6.5 ft), usually 6-10>
}

Guidance: "shed" = single slope; "gable" = two slopes meeting at a ridge; "gambrel" = barn profile with a knee bend on each side. "batten" = vertical board-and-batten or vertical groove panels; "lap" = horizontal overlapping boards; null = smooth. Colors are the dominant unpainted/base colors visible. Estimate conservatively; when unsure of a number use a typical value rather than omitting the key.`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let payload: any;
  try { payload = await req.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const { adminPassword, photoUrls, styleLabel } = payload || {};

  const expected = Deno.env.get("ADMIN_PASSWORD");
  if (!expected) return json({ error: "ADMIN_PASSWORD is not configured on the server." }, 500);
  if (!adminPassword || !safeEqual(String(adminPassword), expected)) {
    return json({ error: "Incorrect admin password." }, 401);
  }

  const urls = (Array.isArray(photoUrls) ? photoUrls : [])
    .filter((u: unknown) => typeof u === "string" && /^https?:\/\//.test(u))
    .slice(0, 4);
  if (urls.length === 0) return json({ error: "At least one photo URL is required." }, 400);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return json({ error: "ANTHROPIC_API_KEY is not configured. Set it in Supabase → Edge Functions → Secrets." }, 500);
  }

  const content: any[] = urls.map((u: string) => ({ type: "image", source: { type: "url", url: u } }));
  content.push({ type: "text", text: `${SPEC_PROMPT}\n\nStyle name (context only): ${String(styleLabel || "unknown")}` });

  let raw = "";
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 700,
        messages: [{ role: "user", content }],
      }),
    });
    if (!r.ok) return json({ error: `Anthropic API ${r.status}: ${(await r.text()).slice(0, 300)}` }, 502);
    const d = await r.json();
    raw = (d?.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  } catch (e) {
    return json({ error: `Anthropic call failed: ${(e as Error).message}` }, 502);
  }

  // Parse the spec — tolerate stray fences or prose around the JSON object.
  let d3: any = null;
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    d3 = m ? JSON.parse(m[0]) : null;
  } catch (_) { d3 = null; }
  if (!d3 || typeof d3 !== "object" || !d3.roof || !["shed", "gable", "gambrel"].includes(d3.roof.type)) {
    return json({ error: `Model returned an unusable spec: ${raw.slice(0, 300)}` }, 502);
  }
  if (d3.siding !== "batten" && d3.siding !== "lap") d3.siding = null;
  if (typeof d3.wallHeightFt !== "number" || d3.wallHeightFt < 5 || d3.wallHeightFt > 14) d3.wallHeightFt = 8;

  return json({ ok: true, d3 });
});
