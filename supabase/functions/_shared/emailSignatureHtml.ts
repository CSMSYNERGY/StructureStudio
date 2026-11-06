// _shared/emailSignatureHtml.ts — the sanitiser for a RICH email signature, and the plain-text
// rendering derived from it.
//
// WHY THIS EXISTS. Carolyn, 2026-11-01, pasting her own signature into My Profile: "We need rich
// text / html for signatures. I tried to paste this in for my signature and it doesn't work."
// Her signature is a headshot beside a styled name, a phone and email, a website link, a tagline,
// a horizontal rule and a grey legal disclaimer — i.e. everything the v1 plain-text box threw
// away. v1 (emailSignature.ts) escaped the signature into the HTML half on purpose, and its
// header said a logo "needs its own sanitiser rather than a loosening of this". This file IS that
// sanitiser; emailSignature.ts now calls it.
//
// ⛔ THIS IS NOT cleanRichText (emailBlocks.ts) AND MUST NOT BECOME IT. That one guards every
// customer-facing email template a BUILDER authors, and its narrow allow-list (no img, no style,
// no span) is the reason a marketing template cannot carry a tracking pixel or a font. Widening it
// to serve signatures would widen it for lead alerts and auto-replies too. Two cleaners, two
// allow-lists, each justified by its own threat model. There is a test below that fails if anybody
// widens the strict one.
//
// WHAT A SIGNATURE MAY CONTAIN, and the reasoning for the two surprising entries:
//   * TABLES are allowed. An Outlook or Gmail desktop signature with a picture beside text is a
//     2-column table essentially every time — it is the only layout primitive that survives
//     Outlook's renderer, which is why every signature generator emits one. Drop tables and the
//     headshot stacks above the text and the whole thing looks broken, which is the exact
//     complaint this feature answers. A table carries no script surface; its risk is layout, and
//     that is handled by the length caps in the style allow-list.
//   * <font> is allowed, and REWRITTEN to <span style>. document.execCommand("fontSize") emits
//     <font size="N"> in Chrome whatever styleWithCSS says, and Word pastes carry <font face>.
//     Normalising it here means one styling mechanism downstream instead of two.
//
// IMAGES: the src must be a URL in OUR OWN public storage bucket, matched literally. A pasted
// Outlook signature points at file:///…/msohtmlclip1/… or cid:image001 or a cookie-authenticated
// Gmail URL — none of which render for the recipient, which is the bug — so the browser re-uploads
// what it can and drops the rest. Nothing here tries to be clever about a foreign URL: a remote
// image in a signature is a tracking pixel we would be sending on a builder's behalf.
//
// Pure: no network, no database. The storage origin is passed in (the edge function reads it from
// SUPABASE_URL), so every rule in this file is testable offline.
//
// ⚠️ Importers, ALL of which must be redeployed together when this changes (_shared bundles PER
//    function):
//      _shared/emailSignature.ts  → portal-settings/index.ts
//      portal-settings/index.ts

/** The longest CLEANED signature kept, in characters. Over this, nothing is stored.
 *
 *  Why 12,000: a real Outlook signature with a headshot pastes at 15–40 KB raw and leaves the
 *  cruft strip below at 1.5–4 KB; a hand-built one with a table, a rule and a disclaimer lands
 *  around 2–3 KB; one storage URL is ~120 characters. This is roughly 4× the realistic worst
 *  case, leaves room for a long legal disclaimer, and keeps the derived plain text comfortably
 *  inside EMAIL_SIGNATURE_MAX and the ledger's own body_text budget.
 *
 *  ⚠️ OVER THE CAP IS A REFUSAL, NEVER A TRUNCATION. A cut HTML string is a broken one — half a
 *  <table> would swallow the rest of a customer's email. cleanSignatureHtml returns null and the
 *  caller authors a sentence. */
export const SIGNATURE_HTML_MAX = 12000;

// ── allow-lists ───────────────────────────────────────────────────────────────────────────────

/** Tags kept. `font` is rewritten to `span`, `div` is kept as `div` (unlike cleanRichText, which
 *  folds it to `p` — a signature's layout leans on divs and a <p>'s margins vary by client). */
const TAGS = new Set([
  "b", "strong", "i", "em", "u", "s", "strike", "sub", "sup",
  "br", "p", "div", "span", "a", "img", "hr",
  "ul", "ol", "li",
  "table", "thead", "tbody", "tr", "td", "th",
]);

/** Tags that never close. Anything else opened is tracked and closed at the end. */
const VOID_TAGS = new Set(["br", "img", "hr"]);

/** Dropped WITH their contents — a `<script>` whose tags were merely stripped would leave its
 *  body as visible text, and a `<style>`'s rules would leak into the email as words. */
const KILL_WITH_CONTENT = "script|style|iframe|object|embed|template|svg|math|noscript|head|title|xml|applet|frameset|frame";

/** Attributes kept per tag. Everything not named here is dropped, including class (Word's
 *  MsoNormal), id, lang, dir, bgcolor, border, cellpadding, every on* handler, srcset, usemap,
 *  background, data-*, and the v:/o:/w: namespaced ones Word emits. */
const ATTRS: Record<string, Set<string>> = {
  a: new Set(["href"]),
  img: new Set(["src", "alt", "width", "height"]),
  table: new Set(["width", "align", "cellpadding", "cellspacing"]),
  tr: new Set(["align", "valign"]),
  td: new Set(["colspan", "rowspan", "align", "valign", "width"]),
  th: new Set(["colspan", "rowspan", "align", "valign", "width"]),
};

/** Style properties kept, each with its own value validator (below). Deliberately absent, because
 *  they are the attack surface rather than typography: position, top/right/bottom/left, z-index,
 *  transform, transition, animation, filter, behavior, -moz-binding, content, clip, cursor, float,
 *  opacity, and anything prefixed mso-, -ms-, -webkit-, -moz-. */
const STYLE_PROPS = new Set([
  "color", "background-color",
  "font-family", "font-size", "font-style", "font-weight", "text-decoration", "text-transform",
  "letter-spacing", "line-height", "text-align", "vertical-align",
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "border", "border-top", "border-bottom", "border-left", "border-right",
  "border-radius", "border-collapse", "border-spacing",
  "width", "max-width", "height", "display", "white-space",
]);

/** The ~150 CSS named colours, so `color:rebeccapurple` survives a paste without opening the
 *  value up to a charset gate (which is how `expression(` gets in). */
const NAMED_COLORS = new Set(("aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue " +
  "blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue " +
  "darkcyan darkgoldenrod darkgray darkgrey darkgreen darkkhaki darkmagenta darkolivegreen darkorange darkorchid " +
  "darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink " +
  "deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold " +
  "goldenrod gray grey green greenyellow honeydew hotpink indianred indigo ivory khaki lavender lavenderblush " +
  "lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgrey lightgreen " +
  "lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime " +
  "limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen " +
  "mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin " +
  "navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise " +
  "palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue " +
  "saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow " +
  "springgreen steelblue tan teal thistle tomato transparent turquoise violet wheat white whitesmoke yellow " +
  "yellowgreen inherit currentcolor").split(" "));

const BORDER_STYLES = new Set(["none", "hidden", "dotted", "dashed", "solid", "double", "groove", "ridge", "inset", "outset"]);

// ── value validators ──────────────────────────────────────────────────────────────────────────

const isColor = (v: string) =>
  /^#[0-9a-f]{3}$/i.test(v) || /^#[0-9a-f]{6}$/i.test(v) ||
  /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d{1,3})\s*)?\)$/i.test(v) ||
  NAMED_COLORS.has(v.toLowerCase());

/** A length, with a per-property ceiling. `pct` says whether a percentage is meaningful here. */
const len = (v: string, maxPx: number, pct: boolean) => {
  const m = /^(-?\d{1,4}(?:\.\d{1,2})?)(px|pt|em|rem|%)?$/i.exec(v.trim());
  if (!m) return false;
  const n = Number(m[1]);
  const unit = (m[2] || "px").toLowerCase();
  if (!Number.isFinite(n)) return false;
  if (unit === "%") return pct && n >= 0 && n <= 100;
  // pt/em/rem are converted to a px-equivalent only for the bounds check; the value is kept as written.
  const px = unit === "pt" ? n * 1.333 : (unit === "em" || unit === "rem") ? n * 16 : n;
  return px >= -maxPx && px <= maxPx;
};

const styleValueOk = (prop: string, raw: string): boolean => {
  const v = raw.trim();
  if (!v || v.length > 160) return false;
  switch (prop) {
    case "color": case "background-color":
      return isColor(v);
    case "font-family":
      return /^[a-z0-9 ,'"\-]{1,120}$/i.test(v);
    case "font-size":
      return len(v, 72, false) && !/^-/.test(v);
    case "font-style":
      return /^(normal|italic|oblique)$/i.test(v);
    case "font-weight":
      return /^(normal|bold|bolder|lighter|[1-9]00)$/i.test(v);
    case "text-decoration":
      return /^(none|underline|line-through|overline)(\s+(none|underline|line-through|overline))*$/i.test(v);
    case "text-transform":
      return /^(none|uppercase|lowercase|capitalize)$/i.test(v);
    case "letter-spacing":
      return /^normal$/i.test(v) || len(v, 20, false);
    case "line-height":
      return /^normal$/i.test(v) || /^\d(\.\d{1,2})?$/.test(v) || len(v, 80, false);
    case "text-align":
      return /^(left|right|center|justify)$/i.test(v);
    case "vertical-align":
      return /^(top|middle|bottom|baseline|sub|super|text-top|text-bottom)$/i.test(v);
    case "white-space":
      return /^(normal|nowrap|pre|pre-wrap|pre-line)$/i.test(v);
    case "display":
      return /^(block|inline|inline-block|table|table-row|table-cell|none)$/i.test(v);
    case "border-collapse":
      return /^(collapse|separate)$/i.test(v);
    case "border-radius":
      return v.split(/\s+/).every((p) => len(p, 60, true));
    case "border-spacing":
      return v.split(/\s+/).every((p) => len(p, 40, false));
    case "width": case "max-width":
      return len(v, 800, true);
    case "height":
      return /^auto$/i.test(v) || len(v, 800, true);
    default:
      if (prop.startsWith("margin") || prop.startsWith("padding")) {
        return v.split(/\s+/).every((p) => /^(auto|0)$/i.test(p) || len(p, 80, true));
      }
      if (prop === "border" || prop.startsWith("border-")) {
        // <length> <style> <colour> in any order, or the bare keyword none/0.
        if (/^(none|0)$/i.test(v)) return true;
        return v.split(/\s+/).every((p) => BORDER_STYLES.has(p.toLowerCase()) || isColor(p) || len(p, 20, false));
      }
      return false;
  }
};

/** A style attribute, rebuilt property by property. Anything containing url(), expression(), a CSS
 *  escape, a comment or an entity is refused outright before the per-property check — url() is how
 *  `background:url(javascript:…)` and a remote tracking pixel get in through the back door, and a
 *  signature has <img> for its one legitimate image. */
const cleanStyle = (raw: string): string => {
  if (!raw || raw.length > 2000) return "";
  if (/url\s*\(|expression\s*\(|javascript\s*:|behavior\s*:|binding\s*:|[\\]|\/\*|&#|[\r\n]/i.test(raw)) return "";
  const out: string[] = [];
  for (const decl of raw.split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const val = decl.slice(i + 1).trim().replace(/\s*!important$/i, "");
    if (!STYLE_PROPS.has(prop)) continue;
    if (!styleValueOk(prop, val)) continue;
    out.push(`${prop}:${val}`);
  }
  return out.join(";");
};

/** A link a person may click from an email. https, mailto: and tel: only — never http:, never a
 *  protocol-relative //host, never javascript:/data:/vbscript:/file:/cid:. Checked after entity
 *  decoding, so `jav&#x0A;ascript:` cannot sneak past. */
export const signatureLinkUrl = (raw: unknown): string => {
  const t = typeof raw === "string" ? raw.replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, 500) : "";
  if (/^https:\/\/[^\s<>"']+$/i.test(t)) return t;
  if (/^mailto:[^\s<>"']+$/i.test(t)) return t;
  if (/^tel:[+0-9() .\-]{4,30}$/i.test(t)) return t;
  return "";
};

/** The ONE shape an <img src> may take: our own public storage bucket, matched literally against
 *  the origin the caller passes. `<clientId>` is deliberately NOT pinned to the saving tenant — a
 *  client_id is a public DNS-safe slug, not a secret, and pinning it would break a stored
 *  signature if a slug were ever renamed. Everything else is literal. */
export const signatureImageUrl = (raw: unknown, publicOrigin: string): string => {
  const t = typeof raw === "string" ? raw.replace(/[\u0000-\u0020]/g, "").slice(0, 500) : "";
  if (!publicOrigin) return "";
  const prefix = `${publicOrigin.replace(/\/+$/, "")}/storage/v1/object/public/${SIGNATURE_BUCKET}/`;
  if (!t.startsWith(prefix)) return "";
  const path = t.slice(prefix.length);
  return /^[a-z0-9][a-z0-9_-]{0,62}\/[0-9a-f-]{36}\.(jpg|jpeg|png|webp|gif)$/i.test(path) ? t : "";
};

/** The bucket a signature image lives in. Shared with lead-form assets on purpose: it is already
 *  public-read, 5 MB, images-only (migration 325), with the path shape this rule matches. */
export const SIGNATURE_BUCKET = "form-assets";

// ── the cruft strip ───────────────────────────────────────────────────────────────────────────

/** Everything Word and Outlook wrap a signature in, removed before the tag pass. Order matters:
 *  the conditional-comment forms must go before the generic comment strip, because `<![if !mso]>`
 *  is NOT a comment and survives one. */
const stripCruft = (input: string): string => {
  let t = input;
  t = t.replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, "");       // downlevel-hidden
  // Downlevel-REVEALED (<![if !mso]>x<![endif]>) shows x to every client that is not Outlook, so
  // only the markers go — eating what sits between them loses a line of the signature.
  t = t.replace(/<!\[(?:end)?if[^\]]*\]>/gi, "");
  t = t.replace(/<!--[\s\S]*?-->/g, "");                       // real comments
  t = t.replace(/<!--[\s\S]*$/, "");                           // an unterminated one
  t = t.replace(new RegExp(`<(${KILL_WITH_CONTENT})\\b[\\s\\S]*?</\\1\\s*>`, "gi"), "");
  t = t.replace(new RegExp(`<(${KILL_WITH_CONTENT})\\b[\\s\\S]*$`, "gi"), ""); // unclosed
  t = t.replace(/<\/?[a-z]+:[a-z][a-z0-9-]*[^>]*>/gi, "");     // <o:p>, <v:shape>, <w:sdt>
  t = t.replace(/<!DOCTYPE[^>]*>/gi, "");
  t = t.replace(/<\?[\s\S]*?\?>/g, "");
  return t;
};

// ── the tag pass ──────────────────────────────────────────────────────────────────────────────

const decodeEntities = (v: string) =>
  v.replace(/&#x([0-9a-f]{1,6});?/gi, (_m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ""; } })
    .replace(/&#(\d{1,7});?/g, (_m, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch { return ""; } })
    .replace(/&quot;/gi, '"').replace(/&apos;/gi, "'").replace(/&#39;/g, "'")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");

const attrValue = (attrs: string, name: string): string | null => {
  const re = new RegExp(`(?:^|[\\s/])${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const m = re.exec(attrs);
  if (!m) return null;
  return m[2] ?? m[3] ?? m[4] ?? "";
};

const escAttr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const intAttr = (v: string | null, lo: number, hi: number): string | null => {
  if (v === null) return null;
  const m = /^\s*(\d{1,5})(?:px)?\s*$/.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= lo && n <= hi ? String(n) : null;
};

/** <font size|color|face> → <span style>. Chrome's execCommand still emits it, and Word pastes
 *  carry it; normalising here means one styling mechanism downstream. The size scale is HTML's
 *  1–7 mapped to the px sizes browsers have always used for it. */
const FONT_SIZE_PX = ["10px", "13px", "16px", "18px", "24px", "32px", "48px"];

const fontToSpanStyle = (attrs: string): string => {
  const parts: string[] = [];
  const color = attrValue(attrs, "color");
  if (color && isColor(decodeEntities(color).trim())) parts.push(`color:${decodeEntities(color).trim()}`);
  const face = attrValue(attrs, "face");
  if (face) { const f = decodeEntities(face).trim(); if (styleValueOk("font-family", f)) parts.push(`font-family:${f}`); }
  const size = attrValue(attrs, "size");
  if (size) { const n = Number(size.trim()); if (n >= 1 && n <= 7) parts.push(`font-size:${FONT_SIZE_PX[n - 1]}`); }
  const inline = attrValue(attrs, "style");
  if (inline) { const s = cleanStyle(decodeEntities(inline)); if (s) parts.push(s); }
  return parts.join(";");
};

/**
 * Reduce a pasted or edited signature to the allow-lists above, and BALANCE IT.
 *
 * Balancing is not cosmetic and is the one thing cleanRichText does not do: its output lands
 * inside a template that tolerates a stray tag, whereas an unclosed <table> in a signature
 * swallows the rest of the customer's email in Outlook.
 *
 * Returns null for "no signature" — empty input, nothing left after cleaning, or OVER THE CAP
 * (see SIGNATURE_HTML_MAX: a refusal, never a truncation).
 *
 * @param publicOrigin the Supabase project origin an <img src> must sit under. Pass "" to drop
 *                     every image, which is what a caller with no configured origin should do.
 */
export function cleanSignatureHtml(raw: unknown, publicOrigin = ""): string | null {
  if (typeof raw !== "string") return null;
  // A generous input bound: a pasted Outlook blob is 15–40 KB, and the cap applies to the OUTPUT.
  if (raw.length > SIGNATURE_HTML_MAX * 20) return null;

  let t = stripCruft(raw);

  const stack: string[] = [];
  const out: string[] = [];
  let last = 0;
  const tagRe = /<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)\/?\s*>/g;
  let m: RegExpExecArray | null;

  // TEXT between tags is escaped on the way out, so a "<" that never formed a tag — a stray one,
  // or the inside of an attribute whose tag was dropped — can never open one in a mail client.
  const text = (v: string) => v.replace(/</g, "&lt;");

  while ((m = tagRe.exec(t)) !== null) {
    out.push(text(t.slice(last, m.index)));
    last = tagRe.lastIndex;
    const closing = m[1] === "/";
    let name = m[2].toLowerCase();
    let attrs = m[3] || "";

    if (name === "font") { name = "span"; if (!closing) attrs = ` style="${escAttr(fontToSpanStyle(attrs))}"`; else attrs = ""; }
    // A heading in a signature is a font size. <h*> margins are unpredictable across clients.
    if (/^h[1-6]$/.test(name)) { name = closing ? "p" : "p"; if (!closing) attrs = ` style="font-weight:700"`; else attrs = ""; }

    if (!TAGS.has(name)) continue;          // dropped; its text content stays

    if (closing) {
      if (VOID_TAGS.has(name)) continue;
      const at = stack.lastIndexOf(name);
      if (at < 0) continue;                  // a close with no open: drop it
      // Close anything opened inside it too, innermost first, so the output stays well formed.
      for (let i = stack.length - 1; i >= at; i--) out.push(`</${stack[i]}>`);
      stack.length = at;
      continue;
    }

    // Opening tag: rebuild its attributes from the allow-list.
    const kept: string[] = [];
    const allowed = ATTRS[name];
    if (allowed) {
      for (const a of allowed) {
        const v0 = attrValue(attrs, a);
        if (v0 === null) continue;
        const v = decodeEntities(v0);
        if (name === "a" && a === "href") { const href = signatureLinkUrl(v); if (href) kept.push(`href="${escAttr(href)}"`); }
        else if (name === "img" && a === "src") { const src = signatureImageUrl(v, publicOrigin); if (src) kept.push(`src="${escAttr(src)}"`); }
        else if (name === "img" && a === "alt") { const alt = v.replace(/[<>"]/g, "").slice(0, 200).trim(); if (alt) kept.push(`alt="${escAttr(alt)}"`); }
        else if (a === "width" || a === "height") { const n = intAttr(v, 1, 2000); if (n) kept.push(`${a}="${n}"`); }
        else if (a === "colspan" || a === "rowspan") { const n = intAttr(v, 1, 50); if (n) kept.push(`${a}="${n}"`); }
        else if (a === "cellpadding" || a === "cellspacing") { const n = intAttr(v, 0, 40); if (n) kept.push(`${a}="${n}"`); }
        else if (a === "align") { if (/^(left|right|center)$/i.test(v.trim())) kept.push(`align="${v.trim().toLowerCase()}"`); }
        else if (a === "valign") { if (/^(top|middle|bottom)$/i.test(v.trim())) kept.push(`valign="${v.trim().toLowerCase()}"`); }
      }
    }
    const styleRaw = attrValue(attrs, "style");
    if (styleRaw !== null) { const s = cleanStyle(decodeEntities(styleRaw)); if (s) kept.push(`style="${escAttr(s)}"`); }

    // An <img> with no usable src is not an image — drop the tag and keep nothing.
    if (name === "img" && !kept.some((k) => k.startsWith("src="))) continue;

    out.push(`<${name}${kept.length ? " " + kept.join(" ") : ""}>`);
    if (!VOID_TAGS.has(name)) {
      stack.push(name);
      // A pathological nest (a hand-written payload, or Word at its worst) is cut off rather than
      // tracked forever; the unwind below still closes what was opened.
      if (stack.length > 60) break;
    }
  }
  out.push(text(t.slice(last)));
  for (let i = stack.length - 1; i >= 0; i--) out.push(`</${stack[i]}>`);

  t = out.join("");

  // Tidy: Word leaves empty blocks and runs of breaks everywhere.
  for (let i = 0; i < 3; i++) {
    t = t.replace(/<(p|div|span|li)\b[^>]*>\s*(?:&nbsp;|\s)*<\/\1>/gi, "");
  }
  t = t.replace(/(?:\s*<br\s*>\s*){3,}/gi, "<br><br>");
  t = t.replace(/(?:&nbsp;){3,}/gi, "&nbsp;&nbsp;");
  t = t.replace(/^(?:\s|<br\s*>)+/i, "").replace(/(?:\s|<br\s*>)+$/i, "");
  t = t.trim();

  if (!t) return null;
  // Nothing but markup — a table of empty cells, a row of <br> — is not a signature. An IMAGE is,
  // though: a logo-only signature is a real thing, and an <img> with no alt renders as no text.
  if (!signatureHtmlToText(t) && !/<img\b/i.test(t)) return null;
  if (t.length > SIGNATURE_HTML_MAX) return null;
  return t;
}

// ── the plain-text twin ───────────────────────────────────────────────────────────────────────

/**
 * The signature as words, for the text/plain half of the email and for the email_sends ledger
 * copy the conversation feed and the phone app replay.
 *
 * Decisions worth knowing, because each is visible to a customer:
 *   * <td> between cells becomes a SPACE, not a newline. A 2-column signature is a picture cell
 *     beside a text cell; breaking on cells puts the name on its own line under nothing.
 *   * <hr> becomes a rule of dashes. Losing it runs the legal disclaimer straight into the phone
 *     number, which is exactly what the rule is there to prevent.
 *   * <img> becomes its alt in brackets, or nothing. NEVER the URL: a bare storage URL under
 *     somebody's name reads as spam and scores like it.
 *   * a mailto:/tel: link whose text already IS the address does not get "(mailto:…)" after it.
 *     That one is the most common link in any signature and the ugliest to get wrong.
 */
export function signatureHtmlToText(html: unknown): string {
  if (typeof html !== "string" || !html) return "";
  let t = html.slice(0, SIGNATURE_HTML_MAX * 4);

  t = t.replace(new RegExp(`<(${KILL_WITH_CONTENT})\\b[\\s\\S]*?</\\1\\s*>`, "gi"), "");
  t = t.replace(/<!--[\s\S]*?-->/g, "");

  // Links first: the anchor's own text is needed to decide whether the URL adds anything.
  t = t.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_m, attrs: string, inner: string) => {
    const href = decodeEntities(attrValue(attrs, "href") || "").trim();
    const text = inner.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
    if (!href) return text;
    if (!text) return href.replace(/^mailto:/i, "").replace(/^tel:/i, "");
    const bare = href.replace(/^mailto:/i, "").replace(/^tel:/i, "");
    if (text.toLowerCase() === bare.toLowerCase()) return text;
    if (/^(mailto|tel):/i.test(href)) return `${text} (${bare})`;
    // A link whose text already names the destination needs no repeat.
    const host = href.replace(/^https:\/\//i, "").replace(/\/+$/, "");
    if (text.toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "") === host.toLowerCase()) return text;
    return `${text} (${href})`;
  });

  t = t.replace(/<img\b([^>]*)>/gi, (_m, attrs: string) => {
    const alt = decodeEntities(attrValue(attrs, "alt") || "").replace(/\s+/g, " ").trim();
    return alt ? `[${alt}]` : "";
  });

  t = t.replace(/<hr\b[^>]*>/gi, "\n------------------------\n");
  t = t.replace(/<br\s*\/?>/gi, "\n");
  // A row breaks on </tr> ALONE — breaking on <tr> as well put a blank line between every row.
  t = t.replace(/<\/(p|div|tr|table|thead|tbody|ul|ol|h[1-6])\s*>/gi, "\n");
  t = t.replace(/<li\b[^>]*>/gi, "\n");
  t = t.replace(/<\/(td|th)\s*>\s*<(td|th)\b/gi, "<$2");   // cell boundary → handled below
  t = t.replace(/<(td|th)\b[^>]*>/gi, " ");
  t = t.replace(/<[^>]*>/g, "");

  // Decode LAST, after every tag is gone. Decoding earlier and stripping again would eat
  // "Jane &lt;jane@acme.com&gt;" — a real line in a real signature — as if it were markup.
  t = decodeEntities(t);

  t = t.replace(/[^\S\n]+/g, " ");
  t = t.split("\n").map((l) => l.trim()).join("\n");
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim();
}
