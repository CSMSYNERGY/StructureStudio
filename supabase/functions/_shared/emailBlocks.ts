// Designed email templates (migration 325, Settings → Customer Hub → Email Templates).
//
// ONE RENDERER. The portal's preview and every real send both call renderEmailDesign here, so the
// builder sees exactly the email that goes out. Output is email-client HTML: nested tables,
// inline styles, no <style> block that Gmail would strip, no script, and esc() on every value
// that came from a person. White-label: nothing here names StructureStudio or CSM Synergy.
//
// NOT emailTemplates.ts on purpose: that file carries the estimate/invoice wording, which is under
// a deploy HOLD (CLAUDE.md, "HOLD: the server half of the estimate wording"). Nothing here touches it.
//
// Pure: no Deno, no network, so emailBlocks.test.ts runs offline.

export const BLOCK_TYPES = ["header", "heading", "text", "image", "button", "divider", "spacer", "columns", "social", "answers", "footer"] as const;
export type BlockType = typeof BLOCK_TYPES[number];
export const MAX_BLOCKS = 60;
const HTML_MAX = 10000;

export type Block = {
  id: string; type: BlockType;
  text?: string; html?: string; html2?: string; url?: string; href?: string; alt?: string;
  align?: "left" | "center" | "right"; size?: number; width?: number; height?: number;
  bg?: string; color?: string; links?: { label: string; url: string }[];
};
export type EmailStyle = { bg: string; contentBg: string; width: number; font: string; text: string; accent: string; radius: number };
export type EmailDesign = { blocks: Block[]; style: EmailStyle };

export const EMAIL_FONTS: Record<string, string> = {
  arial: "Arial,Helvetica,sans-serif",
  georgia: "Georgia,'Times New Roman',serif",
  verdana: "Verdana,Geneva,sans-serif",
  trebuchet: "'Trebuchet MS',Helvetica,sans-serif",
  tahoma: "Tahoma,Geneva,sans-serif",
};

export const DEFAULT_EMAIL_STYLE: EmailStyle = { bg: "#F3F4F6", contentBg: "#FFFFFF", width: 600, font: "arial", text: "#1F2937", accent: "#2563EB", radius: 8 };

/** The merge fields the editor's "Insert field" menu offers. Anything else in {{ }} is left as typed. */
export const MERGE_TAGS: { tag: string; label: string }[] = [
  { tag: "contact.first_name", label: "First name" },
  { tag: "contact.name", label: "Full name" },
  { tag: "contact.email", label: "Email" },
  { tag: "contact.phone", label: "Phone" },
  { tag: "company.name", label: "Your business name" },
  { tag: "company.phone", label: "Your business phone" },
  { tag: "company.website", label: "Your website" },
  { tag: "form.name", label: "Form name" },
];

export const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));
const s = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, max) : "");
const color = (v: unknown, dflt: string) => typeof v === "string" && /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(v.trim()) ? v.trim() : dflt;
const num = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;
};
const align = (v: unknown, dflt: "left" | "center" | "right" = "left") => v === "center" || v === "right" || v === "left" ? v : dflt;
/** A link a person may click in an email: https, or mailto:/tel:. A {{token}} on its own is
 *  allowed too (company.website), checked again once filled. */
export const linkUrl = (v: unknown) => {
  const t = s(v, 500);
  if (/^\{\{\s*[a-z_.]+\s*\}\}$/.test(t)) return t;
  if (/^https:\/\/[^\s<>"']+$/i.test(t) || /^mailto:[^\s<>"']+$/i.test(t) || /^tel:[+0-9() .-]{4,30}$/i.test(t)) return t;
  return "";
};
const imageUrl = (v: unknown) => { const t = s(v, 500); return /^https:\/\/[^\s<>"']+$/i.test(t) ? t : ""; };

// ── rich text ───────────────────────────────────────────────────────────────────────────────
const ALLOWED = new Set(["b", "strong", "i", "em", "u", "a", "br", "p", "ul", "ol", "li", "div"]);
/** Reduce editor HTML (contentEditable output) to an allow-list: bold, italic, underline, links,
 *  paragraphs, line breaks and lists. Every attribute is dropped except a link's href, and that
 *  only when linkUrl accepts it. Script and style elements go with their contents. */
export function cleanRichText(html: unknown): string {
  let t = typeof html === "string" ? html.slice(0, HTML_MAX * 2) : "";
  t = t.replace(/<(script|style|iframe|object|embed|template|svg|math)[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  t = t.replace(/<\s*(\/?)\s*([a-zA-Z0-9]+)([^>]*)>/g, (_m, close: string, tag: string, attrs: string) => {
    const name = tag.toLowerCase();
    if (!ALLOWED.has(name)) return "";
    const tg = name === "div" ? "p" : name;
    if (close) return tg === "br" ? "" : `</${tg}>`;
    if (tg === "a") {
      const m = /href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
      const href = linkUrl(decodeEntities(m ? (m[2] ?? m[3] ?? m[4] ?? "") : ""));
      return href ? `<a href="${esc(href)}">` : "<a>";
    }
    return `<${tg}>`;
  });
  // A stray "<" that was not a tag (none should survive the pass above) must not open one later.
  t = t.replace(/<(?!\/?(b|strong|i|em|u|a|br|p|ul|ol|li)\b)/gi, "&lt;");
  return t.slice(0, HTML_MAX);
}
function decodeEntities(v: string) {
  return v.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

// ── design cleaner ──────────────────────────────────────────────────────────────────────────
export function cleanDesign(raw: unknown): EmailDesign {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const st = (d.style && typeof d.style === "object" ? d.style : {}) as Record<string, unknown>;
  const style: EmailStyle = {
    bg: color(st.bg, DEFAULT_EMAIL_STYLE.bg), contentBg: color(st.contentBg, DEFAULT_EMAIL_STYLE.contentBg),
    width: num(st.width, 400, 800, 600), font: typeof st.font === "string" && EMAIL_FONTS[st.font] ? st.font : "arial",
    text: color(st.text, DEFAULT_EMAIL_STYLE.text), accent: color(st.accent, DEFAULT_EMAIL_STYLE.accent),
    radius: num(st.radius, 0, 24, 8),
  };
  const seen = new Set<string>();
  const blocks: Block[] = [];
  for (const b of Array.isArray(d.blocks) ? d.blocks.slice(0, MAX_BLOCKS) : []) {
    if (!b || typeof b !== "object") continue;
    const r = b as Record<string, unknown>;
    const type = (BLOCK_TYPES as readonly string[]).includes(r.type as string) ? r.type as BlockType : null;
    const id = typeof r.id === "string" && /^[a-z0-9_-]{1,40}$/i.test(r.id) ? r.id : "";
    if (!type || !id || seen.has(id)) continue;
    seen.add(id);
    const out: Block = { id, type };
    switch (type) {
      case "header": out.url = imageUrl(r.url); out.text = s(r.text, 120); out.align = align(r.align, "center"); out.bg = color(r.bg, style.contentBg); out.width = num(r.width, 40, 400, 160); break;
      case "heading": out.text = s(r.text, 300); out.align = align(r.align); out.size = num(r.size, 16, 40, 24); out.color = color(r.color, style.text); break;
      case "text": out.html = cleanRichText(r.html); out.align = align(r.align); out.size = num(r.size, 12, 22, 15); break;
      case "image": out.url = imageUrl(r.url); out.alt = s(r.alt, 200); out.href = linkUrl(r.href); out.width = num(r.width, 10, 100, 100); out.align = align(r.align, "center"); break;
      case "button": out.text = s(r.text, 80) || "Learn more"; out.href = linkUrl(r.href); out.align = align(r.align, "center"); out.bg = color(r.bg, style.accent); out.color = color(r.color, "#FFFFFF"); break;
      case "divider": out.color = color(r.color, "#E5E7EB"); out.height = num(r.height, 1, 6, 1); break;
      case "spacer": out.height = num(r.height, 4, 80, 24); break;
      case "columns": out.html = cleanRichText(r.html); out.html2 = cleanRichText(r.html2); break;
      case "social": {
        const links = Array.isArray(r.links) ? r.links : [];
        out.links = links.slice(0, 8).map((l) => {
          const o = (l && typeof l === "object" ? l : {}) as Record<string, unknown>;
          return { label: s(o.label, 40), url: linkUrl(o.url) };
        }).filter((l) => l.label && l.url);
        out.align = align(r.align, "center");
        break;
      }
      case "answers": out.text = s(r.text, 120); break;
      case "footer": out.text = s(r.text, 500); out.align = align(r.align, "center"); break;
    }
    blocks.push(out);
  }
  return { blocks, style };
}

// ── rendering ───────────────────────────────────────────────────────────────────────────────
export type Tokens = {
  contact?: { first_name?: string; name?: string; email?: string; phone?: string };
  company?: { name?: string; phone?: string; website?: string; address?: string; logoUrl?: string };
  form?: { name?: string; answers?: { label: string; value: string }[] };
};

const KNOWN_TAGS = new Set([...MERGE_TAGS.map((t) => t.tag), "company.address"]);
function tokenValue(tokens: Tokens, key: string): string | null {
  if (!KNOWN_TAGS.has(key)) return null;
  const [ns, field] = key.split(".");
  // deno-lint-ignore no-explicit-any
  const v = (tokens as any)?.[ns]?.[field];
  return typeof v === "string" ? v : v == null ? "" : null;
}
/** Fill {{ns.field}} in already-escaped HTML with ESCAPED values. Unknown tags stay as typed. */
function fillHtml(html: string, tokens: Tokens) {
  return html.replace(/\{\{\s*([a-z_]+\.[a-z_]+)\s*\}\}/g, (m, key: string) => {
    const v = tokenValue(tokens, key);
    return v === null ? m : esc(v);
  });
}
/** Fill a plain string (a subject, a link) with RAW values; escape at the point of use. */
export function fillText(text: string, tokens: Tokens) {
  return text.replace(/\{\{\s*([a-z_]+\.[a-z_]+)\s*\}\}/g, (m, key: string) => {
    const v = tokenValue(tokens, key);
    return v === null ? m : v;
  });
}
const fillLink = (href: string | undefined, tokens: Tokens) => href ? linkUrl(fillText(href, tokens).trim()) : "";

function richToText(html: string) {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|li)>/gi, "\n").replace(/<li>/gi, "• ").replace(/<[^>]+>/g, ""))
    .replace(/\n{3,}/g, "\n\n").trim();
}

export function renderEmailDesign(design: EmailDesign, tokens: Tokens, preheader = ""): { html: string; text: string } {
  const st = design.style;
  const font = EMAIL_FONTS[st.font] ?? EMAIL_FONTS.arial;
  const rows: string[] = [];
  const text: string[] = [];
  const cell = (inner: string, pad = "12px 32px", alignTo: string = "left") =>
    `<tr><td align="${alignTo}" style="padding:${pad};font-family:${font};color:${st.text};text-align:${alignTo}">${inner}</td></tr>`;
  const p = (html: string, size: number) =>
    html.replace(/<p>/g, `<p style="margin:0 0 12px;font-size:${size}px;line-height:1.55">`)
      .replace(/<a href=/g, `<a style="color:${st.accent}" href=`)
      .replace(/<ul>/g, `<ul style="margin:0 0 12px;padding-left:22px;font-size:${size}px;line-height:1.55">`)
      .replace(/<ol>/g, `<ol style="margin:0 0 12px;padding-left:22px;font-size:${size}px;line-height:1.55">`);

  for (const b of design.blocks) {
    switch (b.type) {
      case "header": {
        const logo = b.url || tokens.company?.logoUrl || "";
        const inner = logo
          ? `<img src="${esc(logo)}" alt="${esc(fillText(b.text || "{{company.name}}", tokens))}" width="${b.width}" style="display:inline-block;max-width:100%;height:auto;border:0">`
          : `<span style="font-size:22px;font-weight:bold">${esc(fillText(b.text || "{{company.name}}", tokens))}</span>`;
        rows.push(`<tr><td align="${b.align}" style="padding:24px 32px;background:${b.bg};font-family:${font};color:${st.text};text-align:${b.align}">${inner}</td></tr>`);
        text.push(fillText(b.text || "{{company.name}}", tokens));
        break;
      }
      case "heading":
        rows.push(cell(`<h1 style="margin:0;font-size:${b.size}px;line-height:1.25;color:${b.color};font-family:${font}">${esc(fillText(b.text || "", tokens))}</h1>`, "20px 32px 8px", b.align));
        text.push(fillText(b.text || "", tokens).toUpperCase());
        break;
      case "text": {
        const h = fillHtml(b.html || "", tokens);
        rows.push(cell(`<div style="font-size:${b.size}px;line-height:1.55">${p(h.includes("<p>") ? h : `<p>${h}</p>`, b.size || 15)}</div>`, "8px 32px", b.align));
        text.push(richToText(h));
        break;
      }
      case "image": {
        if (!b.url) break;
        const img = `<img src="${esc(b.url)}" alt="${esc(b.alt)}" width="${Math.round((st.width - 64) * (b.width || 100) / 100)}" style="display:block;max-width:100%;height:auto;border:0;margin:0 auto">`;
        const href = fillLink(b.href, tokens);
        rows.push(cell(href ? `<a href="${esc(href)}">${img}</a>` : img, "8px 32px", b.align));
        break;
      }
      case "button": {
        const href = fillLink(b.href, tokens);
        const label = esc(fillText(b.text || "", tokens));
        rows.push(cell(`<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="display:inline-table"><tr><td style="border-radius:${st.radius}px;background:${b.bg}"><a href="${esc(href || "#")}" style="display:inline-block;padding:12px 26px;font-family:${font};font-size:15px;font-weight:bold;color:${b.color};text-decoration:none;border-radius:${st.radius}px">${label}</a></td></tr></table>`, "14px 32px", b.align));
        text.push(`${fillText(b.text || "", tokens)}${href ? `: ${href}` : ""}`);
        break;
      }
      case "divider":
        rows.push(`<tr><td style="padding:12px 32px"><div style="height:${b.height}px;line-height:${b.height}px;font-size:1px;background:${b.color}">&nbsp;</div></td></tr>`);
        text.push("————");
        break;
      case "spacer":
        rows.push(`<tr><td style="height:${b.height}px;line-height:${b.height}px;font-size:1px">&nbsp;</td></tr>`);
        break;
      case "columns": {
        const a = fillHtml(b.html || "", tokens), c = fillHtml(b.html2 || "", tokens);
        const col = (h: string) => `<td valign="top" width="50%" style="padding:0 8px;font-family:${font};color:${st.text};font-size:15px;line-height:1.55">${p(h.includes("<p>") ? h : `<p>${h}</p>`, 15)}</td>`;
        rows.push(`<tr><td style="padding:8px 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${col(a)}${col(c)}</tr></table></td></tr>`);
        text.push(richToText(a), richToText(c));
        break;
      }
      case "social": {
        const links = (b.links || []).map((l) => ({ label: l.label, url: fillLink(l.url, tokens) })).filter((l) => l.url);
        if (!links.length) break;
        rows.push(cell(links.map((l) => `<a href="${esc(l.url)}" style="color:${st.accent};text-decoration:none;font-weight:bold;margin:0 8px">${esc(l.label)}</a>`).join(" "), "12px 32px", b.align));
        text.push(links.map((l) => `${l.label}: ${l.url}`).join("\n"));
        break;
      }
      case "answers": {
        const list = tokens.form?.answers ?? [];
        if (!list.length) break;
        const trs = list.map((a) => `<tr><td style="padding:6px 0;border-bottom:1px solid #E5E7EB;font-size:13px;color:#6B7280;width:38%;vertical-align:top">${esc(a.label)}</td><td style="padding:6px 0 6px 12px;border-bottom:1px solid #E5E7EB;font-size:14px;vertical-align:top">${esc(a.value).replace(/\n/g, "<br>")}</td></tr>`).join("");
        rows.push(cell(`${b.text ? `<div style="font-weight:bold;margin-bottom:6px">${esc(fillText(b.text, tokens))}</div>` : ""}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-family:${font}">${trs}</table>`, "8px 32px"));
        text.push(list.map((a) => `${a.label}: ${a.value}`).join("\n"));
        break;
      }
      case "footer": {
        const co = tokens.company ?? {};
        const lines = [b.text ? fillText(b.text, tokens) : "", co.name || "", co.address || "", co.phone || ""].filter(Boolean);
        rows.push(cell(`<div style="font-size:12px;line-height:1.6;color:#6B7280">${lines.map(esc).join("<br>")}</div>`, "20px 32px 28px", b.align));
        text.push(lines.join("\n"));
        break;
      }
    }
  }
  const pre = preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(fillText(preheader, tokens))}</div>` : "";
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>` +
    `<body style="margin:0;padding:0;background:${st.bg}">${pre}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${st.bg}"><tr><td align="center" style="padding:24px 12px">` +
    `<table role="presentation" width="${st.width}" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:${st.width}px;background:${st.contentBg};border-radius:${st.radius}px;overflow:hidden">${rows.join("")}</table>` +
    `</td></tr></table></body></html>`;
  return { html, text: text.filter(Boolean).join("\n\n") };
}

// ── starters ───────────────────────────────────────────────────────────────────────────────
export const EMAIL_STARTERS: Record<string, { name: string; purpose: "form_autoreply" | "form_notification" | "general"; subject: string; preheader: string; design: EmailDesign }> = {
  autoreply: {
    name: "Thanks for reaching out", purpose: "form_autoreply",
    subject: "Thanks, {{contact.first_name}} — we got your message", preheader: "We'll be in touch soon.",
    design: cleanDesign({ blocks: [
      { id: "h", type: "header", text: "{{company.name}}" },
      { id: "t1", type: "heading", text: "Thanks for reaching out!" },
      { id: "t2", type: "text", html: "<p>Hi {{contact.first_name}},</p><p>We got your request and someone from {{company.name}} will get back to you shortly. If it's urgent, call us at {{company.phone}}.</p>" },
      { id: "a", type: "answers", text: "What you sent us" },
      { id: "f", type: "footer" },
    ] }),
  },
  notification: {
    name: "New website lead", purpose: "form_notification",
    subject: "New lead from {{form.name}}: {{contact.name}}", preheader: "Someone just filled out your website form.",
    design: cleanDesign({ blocks: [
      { id: "t1", type: "heading", text: "New website lead", size: 22 },
      { id: "t2", type: "text", html: "<p><b>{{contact.name}}</b> filled out <b>{{form.name}}</b>. They're in your Contacts now.</p>" },
      { id: "a", type: "answers" },
    ] }),
  },
  blank: {
    name: "Untitled email", purpose: "general", subject: "", preheader: "",
    design: cleanDesign({ blocks: [{ id: "h", type: "header", text: "{{company.name}}" }, { id: "t", type: "text", html: "<p>Hi {{contact.first_name}},</p>" }, { id: "f", type: "footer" }] }),
  },
};
