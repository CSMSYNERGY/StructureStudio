// Website lead forms (migration 325, Carolyn 2026-10-22): the definition a builder designs in
// Settings → Customer Hub → Forms, and the rules the server holds a public submission to.
//
// ONE SHAPE, THREE READERS. The portal designer edits a definition, the public page
// (forms-render.js) draws it, and the lead-form edge function validates a submission against it.
// Everything that reaches a database row or a public page goes through cleanDefinition /
// cleanSettings here first — a WHITELIST REBUILD, never a spread of the incoming object — so a
// field the designer never offered cannot ride into the public payload.
//
// Pure: no Deno, no network, no imports from jsr/npm, so leadForms.test.ts runs offline.

export const FORM_NAME_MAX = 120;
export const MAX_FIELDS = 60;
export const MAX_OPTIONS = 50;
export const LABEL_MAX = 200;
export const HELP_MAX = 500;
export const TEXT_BLOCK_MAX = 2000;
export const OPTION_MAX = 120;
export const ANSWER_MAX = 2000;
export const SHORT_ANSWER_MAX = 300;

/** What each field type IS. `input` types collect an answer; display types only draw. `role`
 *  is the contact field the answer fills (the CRM contact), decided by the type, never by the
 *  builder — so "Email" always means the email the contact is matched and mailed on. */
export const FIELD_TYPES: Record<string, { input: boolean; role?: ContactRole; group: string; label: string }> = {
  full_name: { input: true, role: "name", group: "Personal", label: "Full name" },
  first_name: { input: true, role: "first_name", group: "Personal", label: "First name" },
  last_name: { input: true, role: "last_name", group: "Personal", label: "Last name" },
  phone: { input: true, role: "phone", group: "Personal", label: "Phone" },
  email: { input: true, role: "email", group: "Personal", label: "Email" },
  date_of_birth: { input: true, group: "Personal", label: "Date of birth" },
  address: { input: true, role: "street", group: "Address", label: "Address" },
  city: { input: true, role: "city", group: "Address", label: "City" },
  state: { input: true, role: "state", group: "Address", label: "State" },
  postal_code: { input: true, role: "zip", group: "Address", label: "Postal code" },
  country: { input: true, group: "Address", label: "Country" },
  // "Organization", under Address, until 2026-10-25: Carolyn went looking for a company-name
  // field on a form, didn't find one, and asked for it built — it was here all along, named
  // after the contact column's old wording and filed with the postal fields. The TYPE KEY stays
  // `organization` (changing it would orphan the field on every form already published); only
  // what a builder reads changes. Personal, beside the name it sits next to on a real form.
  organization: { input: true, role: "company", group: "Personal", label: "Company name" },
  website: { input: true, group: "Address", label: "Website" },
  text: { input: true, group: "General", label: "Short answer" },
  textarea: { input: true, group: "General", label: "Paragraph" },
  select: { input: true, group: "General", label: "Dropdown" },
  radio: { input: true, group: "General", label: "Single choice" },
  checkboxes: { input: true, group: "General", label: "Multiple choice" },
  number: { input: true, group: "General", label: "Number" },
  date: { input: true, group: "General", label: "Date" },
  hidden: { input: true, group: "General", label: "Hidden value" },
  building_style: { input: true, group: "StructureStudio", label: "Building style" },
  building_size: { input: true, group: "StructureStudio", label: "Building size" },
  delivery_zip: { input: true, role: "zip", group: "StructureStudio", label: "Delivery zip" },
  timeframe: { input: true, group: "StructureStudio", label: "Timeframe to buy" },
  sms_consent: { input: true, group: "Consent", label: "Text message consent" },
  terms: { input: true, group: "Consent", label: "Terms & privacy" },
  heading: { input: false, group: "Layout", label: "Heading" },
  paragraph: { input: false, group: "Layout", label: "Text" },
  divider: { input: false, group: "Layout", label: "Divider" },
  image: { input: false, group: "Layout", label: "Image" },
};

export type ContactRole = "name" | "first_name" | "last_name" | "phone" | "email" | "street" | "city" | "state" | "zip" | "company";

/** The choices a fresh Timeframe field starts with (the builder may edit them). */
export const TIMEFRAME_OPTIONS = ["As soon as possible", "Within 1 month", "1–3 months", "3–6 months", "Just looking"];

/** Where a Hidden field may take its value from: the page address's query string. */
export const HIDDEN_SOURCES = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid", "static"];

export const THEMES = ["clean", "brand", "dark", "rounded"] as const;
export type Theme = typeof THEMES[number];

export type FormField = {
  id: string; type: string; label: string; placeholder: string; help: string;
  required: boolean; width: "full" | "half"; options: string[];
  text?: string; imageUrl?: string; source?: string; value?: string; level?: 1 | 2;
};

export type FormStyle = {
  layout: "single" | "two"; inputStyle: "box" | "underline" | "rounded";
  width: number; fieldSpacing: number; labelAlign: "top" | "left" | "right"; labelWidth: number;
  padding: number; showLabels: boolean; font: string; fontSize: number; radius: number;
  colors: { pageBg: string; formBg: string; label: string; text: string; inputBg: string; border: string; accent: string; buttonBg: string; buttonText: string };
  button: { text: string; fullWidth: boolean; radius: number; size: "sm" | "md" | "lg"; align: "left" | "center" | "right" };
  shadow: boolean; cssClass: string;
};

export type FormDefinition = {
  fields: FormField[]; style: FormStyle; theme: Theme;
  header: { title: string; subtitle: string; imageUrl: string };
  footerLinks: { privacy: string; terms: string };
};

export type FormSettings = {
  afterSubmit: { mode: "message" | "redirect"; message: string; redirectUrl: string };
  notify: { enabled: boolean; userIds: string[]; emails: string[]; templateId: string | null };
  autoreply: { enabled: boolean; templateId: string | null };
  pipelineId: string | null; stageId: string | null; assignUserId: string | null;
  sourceLabel: string; closesAt: string | null; captureUtm: boolean;
};

/** The fonts a form may use. A short list on purpose: each is a web-safe stack, so the public
 *  page never loads a third-party font file. */
export const FONTS: Record<string, string> = {
  system: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
  inter: "Inter,-apple-system,'Segoe UI',Roboto,Arial,sans-serif",
  georgia: "Georgia,'Times New Roman',serif",
  verdana: "Verdana,Geneva,sans-serif",
  trebuchet: "'Trebuchet MS',Helvetica,sans-serif",
  mono: "ui-monospace,Menlo,Consolas,monospace",
};

export const THEME_PRESETS: Record<Theme, Partial<FormStyle> & { colors: FormStyle["colors"] }> = {
  clean: { inputStyle: "box", radius: 6, shadow: true, colors: { pageBg: "#F3F4F6", formBg: "#FFFFFF", label: "#111827", text: "#111827", inputBg: "#FFFFFF", border: "#D1D5DB", accent: "#2563EB", buttonBg: "#2563EB", buttonText: "#FFFFFF" } },
  brand: { inputStyle: "box", radius: 6, shadow: true, colors: { pageBg: "#F8FAFC", formBg: "#FFFFFF", label: "#0F172A", text: "#0F172A", inputBg: "#FFFFFF", border: "#CBD5E1", accent: "#1E3A5F", buttonBg: "#1E3A5F", buttonText: "#FFFFFF" } },
  dark: { inputStyle: "box", radius: 6, shadow: false, colors: { pageBg: "#0B1220", formBg: "#111827", label: "#F9FAFB", text: "#F9FAFB", inputBg: "#1F2937", border: "#374151", accent: "#60A5FA", buttonBg: "#3B82F6", buttonText: "#FFFFFF" } },
  rounded: { inputStyle: "rounded", radius: 22, shadow: true, colors: { pageBg: "#FFF7ED", formBg: "#FFFFFF", label: "#1C1917", text: "#1C1917", inputBg: "#FFFBF5", border: "#E7E5E4", accent: "#EA580C", buttonBg: "#EA580C", buttonText: "#FFFFFF" } },
};

export const DEFAULT_STYLE: FormStyle = {
  layout: "single", inputStyle: "box", width: 640, fieldSpacing: 16, labelAlign: "top", labelWidth: 200,
  padding: 24, showLabels: true, font: "system", fontSize: 15, radius: 6,
  colors: { ...THEME_PRESETS.clean.colors },
  button: { text: "Submit", fullWidth: true, radius: 6, size: "md", align: "center" },
  shadow: true, cssClass: "",
};

// ── small cleaners ──────────────────────────────────────────────────────────────────────────
const s = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, max) : "");
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], dflt: T): T => (allowed as readonly string[]).includes(v as string) ? v as T : dflt;
const num = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;
};
/** A colour a CSS declaration can take without escaping anything: #hex only. */
export const color = (v: unknown, dflt: string) => typeof v === "string" && /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(v.trim()) ? v.trim() : dflt;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
/** An https address, or "". Never javascript:, data: or a relative path: these land in hrefs. */
export const httpsUrl = (v: unknown, max = 500) => {
  const t = s(v, max);
  if (!/^https:\/\/[^\s<>"']+$/i.test(t)) return "";
  try { return new URL(t).protocol === "https:" ? t : ""; } catch { return ""; }
};
/** Images come from our own public bucket only, so a form can never hot-link (or track with)
 *  somebody else's server. */
export const formAssetUrl = (v: unknown, supabaseUrl: string) => {
  const t = httpsUrl(v);
  const base = supabaseUrl.replace(/\/+$/, "") + "/storage/v1/object/public/form-assets/";
  return t.startsWith(base) && /^[a-z0-9-]+\/[0-9a-f-]{36}\.(jpg|jpeg|png|webp|gif)$/i.test(t.slice(base.length)) ? t : "";
};
const fieldId = (v: unknown) => typeof v === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(v) ? v : "";

/** Rebuild a definition from whatever arrived, keeping only what a form may hold. */
export function cleanDefinition(raw: unknown, supabaseUrl: string): FormDefinition {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const theme = oneOf(d.theme, THEMES, "clean");
  const st = (d.style && typeof d.style === "object" ? d.style : {}) as Record<string, unknown>;
  const c = (st.colors && typeof st.colors === "object" ? st.colors : {}) as Record<string, unknown>;
  const b = (st.button && typeof st.button === "object" ? st.button : {}) as Record<string, unknown>;
  const base = { ...DEFAULT_STYLE, ...THEME_PRESETS[theme] };
  const style: FormStyle = {
    layout: oneOf(st.layout, ["single", "two"] as const, "single"),
    inputStyle: oneOf(st.inputStyle, ["box", "underline", "rounded"] as const, base.inputStyle),
    width: num(st.width, 280, 1200, 640),
    fieldSpacing: num(st.fieldSpacing, 0, 48, 16),
    labelAlign: oneOf(st.labelAlign, ["top", "left", "right"] as const, "top"),
    labelWidth: num(st.labelWidth, 80, 400, 200),
    padding: num(st.padding, 0, 64, 24),
    showLabels: st.showLabels !== false,
    font: typeof st.font === "string" && FONTS[st.font] ? st.font : "system",
    fontSize: num(st.fontSize, 12, 22, 15),
    radius: num(st.radius, 0, 30, base.radius),
    colors: {
      pageBg: color(c.pageBg, base.colors.pageBg), formBg: color(c.formBg, base.colors.formBg),
      label: color(c.label, base.colors.label), text: color(c.text, base.colors.text),
      inputBg: color(c.inputBg, base.colors.inputBg), border: color(c.border, base.colors.border),
      accent: color(c.accent, base.colors.accent), buttonBg: color(c.buttonBg, base.colors.buttonBg),
      buttonText: color(c.buttonText, base.colors.buttonText),
    },
    button: {
      text: s(b.text, 60) || "Submit", fullWidth: b.fullWidth !== false, radius: num(b.radius, 0, 30, base.radius),
      size: oneOf(b.size, ["sm", "md", "lg"] as const, "md"), align: oneOf(b.align, ["left", "center", "right"] as const, "center"),
    },
    shadow: st.shadow === undefined ? !!base.shadow : st.shadow === true,
    cssClass: typeof st.cssClass === "string" && /^[A-Za-z][A-Za-z0-9_ -]{0,79}$/.test(st.cssClass.trim()) ? st.cssClass.trim() : "",
  };
  const seen = new Set<string>();
  const fields: FormField[] = [];
  for (const f of Array.isArray(d.fields) ? d.fields.slice(0, MAX_FIELDS) : []) {
    if (!f || typeof f !== "object") continue;
    const r = f as Record<string, unknown>;
    const type = typeof r.type === "string" && FIELD_TYPES[r.type] ? r.type : "";
    const id = fieldId(r.id);
    if (!type || !id || seen.has(id)) continue;
    seen.add(id);
    const meta = FIELD_TYPES[type];
    const field: FormField = {
      id, type,
      label: s(r.label, LABEL_MAX) || meta.label,
      placeholder: s(r.placeholder, LABEL_MAX),
      help: s(r.help, HELP_MAX),
      // Display blocks are never required; terms is required by definition (an unticked terms box
      // that still submits is not an agreement), and sms_consent never is (texting is optional:
      // a required texting box is not freely given consent).
      required: type === "terms" ? true : type === "sms_consent" || !meta.input || type === "hidden" ? false : r.required === true,
      width: r.width === "half" ? "half" : "full",
      options: [],
    };
    if (type === "select" || type === "radio" || type === "checkboxes" || type === "timeframe") {
      const opts = Array.isArray(r.options) ? r.options.map((o) => s(o, OPTION_MAX)).filter(Boolean) : [];
      field.options = [...new Set(opts)].slice(0, MAX_OPTIONS);
      if (!field.options.length) field.options = type === "timeframe" ? [...TIMEFRAME_OPTIONS] : ["Option 1", "Option 2"];
    }
    if (type === "heading") { field.text = s(r.text, 200) || "Heading"; field.level = r.level === 2 ? 2 : 1; }
    if (type === "paragraph") field.text = s(r.text, TEXT_BLOCK_MAX);
    if (type === "image") field.imageUrl = formAssetUrl(r.imageUrl, supabaseUrl);
    if (type === "hidden") {
      field.source = oneOf(r.source, HIDDEN_SOURCES, "utm_source");
      field.value = field.source === "static" ? s(r.value, SHORT_ANSWER_MAX) : "";
    }
    fields.push(field);
  }
  const h = (d.header && typeof d.header === "object" ? d.header : {}) as Record<string, unknown>;
  const fl = (d.footerLinks && typeof d.footerLinks === "object" ? d.footerLinks : {}) as Record<string, unknown>;
  return {
    fields, style, theme,
    header: { title: s(h.title, 200), subtitle: s(h.subtitle, 500), imageUrl: formAssetUrl(h.imageUrl, supabaseUrl) },
    footerLinks: { privacy: httpsUrl(fl.privacy), terms: httpsUrl(fl.terms) },
  };
}

export function cleanSettings(raw: unknown): FormSettings {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const a = (d.afterSubmit && typeof d.afterSubmit === "object" ? d.afterSubmit : {}) as Record<string, unknown>;
  const n = (d.notify && typeof d.notify === "object" ? d.notify : {}) as Record<string, unknown>;
  const ar = (d.autoreply && typeof d.autoreply === "object" ? d.autoreply : {}) as Record<string, unknown>;
  const redirectUrl = httpsUrl(a.redirectUrl);
  const emails = Array.isArray(n.emails)
    ? [...new Set(n.emails.map((e) => s(e, 200).toLowerCase()).filter((e) => EMAIL.test(e)))].slice(0, 10) : [];
  const userIds = Array.isArray(n.userIds) ? [...new Set(n.userIds.filter(isUuid))].slice(0, 20) : [];
  const closes = s(d.closesAt, 10);
  return {
    afterSubmit: {
      mode: a.mode === "redirect" && redirectUrl ? "redirect" : "message",
      message: s(a.message, 1000) || "Thanks! We got your information and will be in touch soon.",
      redirectUrl,
    },
    notify: { enabled: n.enabled !== false, userIds, emails, templateId: isUuid(n.templateId) ? n.templateId : null },
    autoreply: { enabled: ar.enabled === true, templateId: isUuid(ar.templateId) ? ar.templateId : null },
    pipelineId: isUuid(d.pipelineId) ? d.pipelineId : null,
    stageId: isUuid(d.pipelineId) && isUuid(d.stageId) ? d.stageId : null,
    assignUserId: isUuid(d.assignUserId) ? d.assignUserId : null,
    sourceLabel: s(d.sourceLabel, 80),
    closesAt: /^\d{4}-\d{2}-\d{2}$/.test(closes) ? closes : null,
    captureUtm: d.captureUtm !== false,
  };
}

// ── submissions ─────────────────────────────────────────────────────────────────────────────
export const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/;

export type Answer = { id: string; label: string; type: string; value: string };
export type Contact = Partial<Record<ContactRole, string>> & { website?: string };
export type Checked = { answers: Answer[]; contact: Contact; smsConsent: boolean; errors: Record<string, string> };

/** Hold a raw submission to the PUBLISHED definition. Unknown keys are dropped, every value is
 *  cut to size, choices must be one of the field's own options, and required fields must be
 *  answered. `catalog` is the builder's live style/size labels (Building style/size pick from it). */
export function checkSubmission(def: FormDefinition, raw: unknown, catalog: { styles: string[]; sizes: string[] }): Checked {
  const got = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const answers: Answer[] = [];
  const contact: Contact = {};
  const errors: Record<string, string> = {};
  let smsConsent = false;
  for (const f of def.fields) {
    const meta = FIELD_TYPES[f.type];
    if (!meta?.input) continue;
    const v = got[f.id];
    let value = "";
    if (f.type === "checkboxes") {
      const list = Array.isArray(v) ? v.map((x) => s(x, OPTION_MAX)).filter((x) => f.options.includes(x)) : [];
      value = [...new Set(list)].join(", ");
    } else if (f.type === "sms_consent" || f.type === "terms") {
      value = v === true || v === "yes" || v === "on" ? "Yes" : "";
      if (f.type === "sms_consent" && value) smsConsent = true;
    } else if (f.type === "select" || f.type === "radio" || f.type === "timeframe") {
      const t = s(v, OPTION_MAX);
      value = f.options.includes(t) ? t : "";
    } else if (f.type === "building_style" || f.type === "building_size") {
      const t = s(v, OPTION_MAX);
      const list = f.type === "building_style" ? catalog.styles : catalog.sizes;
      value = list.includes(t) ? t : "";
    } else {
      value = s(v, f.type === "textarea" ? ANSWER_MAX : SHORT_ANSWER_MAX);
      if (value && f.type === "email" && !EMAIL.test(value)) errors[f.id] = "Enter a valid email address.";
      if (value && f.type === "phone") {
        const digits = value.replace(/\D/g, "");
        if (digits.length < 10 || digits.length > 15) errors[f.id] = "Enter a valid phone number.";
      }
      if (value && f.type === "number" && !/^-?\d+(\.\d+)?$/.test(value)) errors[f.id] = "Enter a number.";
      if (value && (f.type === "date" || f.type === "date_of_birth") && !/^\d{4}-\d{2}-\d{2}$/.test(value)) errors[f.id] = "Enter a date.";
      if (value && (f.type === "postal_code" || f.type === "delivery_zip") && !/^[A-Za-z0-9 -]{3,10}$/.test(value)) errors[f.id] = "Enter a valid postal code.";
      if (value && f.type === "website" && !/^(https?:\/\/)?[^\s<>"]+\.[^\s<>"]+$/i.test(value)) errors[f.id] = "Enter a website address.";
    }
    if (f.required && !value) errors[f.id] = f.type === "terms" ? "Please agree to continue." : "This field is required.";
    if (!value) continue;
    answers.push({ id: f.id, label: f.label, type: f.type, value });
    const role = meta.role;
    if (role && !errors[f.id] && !contact[role]) contact[role] = value;
    if (f.type === "website" && !errors[f.id]) contact.website = value;
  }
  if (!contact.name) contact.name = [contact.first_name, contact.last_name].filter(Boolean).join(" ") || undefined;
  return { answers, contact, smsConsent, errors };
}

/** The pinned CRM note a submission leaves on the contact. Plain text, one answer per line. */
export function submissionNote(formName: string, answers: Answer[], pageUrl: string | null): string {
  const lines = answers.filter((a) => a.type !== "sms_consent" && a.type !== "terms").map((a) => `${a.label}: ${a.value}`);
  return [`Website form "${formName}" submitted.`, ...lines, pageUrl ? `Page: ${pageUrl}` : ""].filter(Boolean).join("\n").slice(0, 8000);
}

/** The checks behind the designer's Recommendations button. Also run by publish, which refuses
 *  only the "blocking" ones. */
export function recommendations(def: FormDefinition, published: unknown, smsBoxAllowed = true): { id: string; text: string; blocking?: true }[] {
  const out: { id: string; text: string; blocking?: true }[] = [];
  const types = new Set(def.fields.map((f) => f.type));
  const inputs = def.fields.filter((f) => FIELD_TYPES[f.type]?.input && f.type !== "hidden");
  if (!inputs.length) out.push({ id: "no_inputs", text: "Add at least one field people can fill in.", blocking: true });
  if (!types.has("email") && !types.has("phone")) out.push({ id: "no_contact", text: "Add an Email or Phone field: without one, a submission can't become a contact." });
  const contactRequired = def.fields.some((f) => (f.type === "email" || f.type === "phone") && f.required);
  if ((types.has("email") || types.has("phone")) && !contactRequired) out.push({ id: "contact_optional", text: "Make Email or Phone required so every lead can be reached." });
  if (types.has("phone") && !types.has("sms_consent") && smsBoxAllowed) out.push({ id: "no_sms_consent", text: "You collect a phone number but have no text message consent box. Without one you can't text these leads." });
  if (types.has("sms_consent")) out.push({ id: "a2p", text: "A texting consent box on your website is a new opt-in page. Check your texting registration lists this page before you text these leads." });
  if (!def.footerLinks.privacy) out.push({ id: "no_privacy", text: "Add your Privacy Policy link (Settings tab of this form)." });
  if (published && JSON.stringify(published) !== JSON.stringify(def)) out.push({ id: "unpublished", text: "You have changes that aren't live yet. Press Publish to put them on your website." });
  return out;
}

// ── starters ───────────────────────────────────────────────────────────────────────────────
const F = (id: string, type: string, extra: Partial<FormField> = {}): FormField => ({
  id, type, label: FIELD_TYPES[type].label, placeholder: "", help: "", required: false, width: "full", options: [], ...extra,
});

export const STARTERS: Record<string, { name: string; fields: FormField[] }> = {
  blank: { name: "Untitled form", fields: [F("email", "email", { required: true, placeholder: "you@example.com" })] },
  contact: {
    name: "Contact us",
    fields: [
      F("first_name", "first_name", { width: "half", required: true, placeholder: "First name" }),
      F("last_name", "last_name", { width: "half", placeholder: "Last name" }),
      F("email", "email", { required: true, placeholder: "you@example.com" }),
      F("phone", "phone", { placeholder: "(555) 555-5555" }),
      F("message", "textarea", { label: "How can we help?" }),
    ],
  },
  quote: {
    name: "Request an estimate",
    fields: [
      F("heading", "heading", { text: "Get a free estimate", level: 1 }),
      F("full_name", "full_name", { required: true }),
      F("email", "email", { required: true, width: "half" }),
      F("phone", "phone", { required: true, width: "half" }),
      F("building_style", "building_style", { label: "Which style are you interested in?" }),
      F("building_size", "building_size", { label: "What size?" }),
      F("delivery_zip", "delivery_zip", { width: "half" }),
      F("timeframe", "timeframe", { width: "half", options: [...TIMEFRAME_OPTIONS] }),
      F("notes", "textarea", { label: "Anything else we should know?" }),
    ],
  },
  inquiry: {
    name: "Building inquiry",
    fields: [
      F("full_name", "full_name", { required: true }),
      F("phone", "phone", { required: true }),
      F("email", "email"),
      F("interest", "checkboxes", { label: "What are you looking for?", options: ["Storage shed", "Garage", "Cabin", "Barn", "Something else"] }),
      F("utm_source", "hidden", { label: "Ad source", source: "utm_source" }),
    ],
  },
};

export function starterDefinition(key: string, supabaseUrl: string): { name: string; definition: FormDefinition } {
  const st = STARTERS[key] ?? STARTERS.blank;
  return { name: st.name, definition: cleanDefinition({ fields: st.fields, theme: "clean", style: {} }, supabaseUrl) };
}
