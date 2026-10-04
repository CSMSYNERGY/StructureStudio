// My Synergy Phone — each person's own hours, "When my phone rings" (migration 264):
//   * the ONE hours rule (_shared/phoneHours.ts), moved out of portal-settings/phone.ts and
//     re-exported there, so the owner's business hours are refused in exactly the old words and
//     a person's own hours in theirs;
//   * the phone-api Worker uses that rule for POST /settings/me and its validTimeZone on a call;
//   * the portal: the weekly editor shared by the business's hours and the person's own, and the
//     Your calls card's hours helpers, lifted from the SHIPPED source the way
//     callRecordingUi_test.ts does (slice between stable anchors, fail loudly if they move);
//   * portal-settings shows each person's hours to the team screen, as a courtesy read;
//   * who can REACH the card: everyone with phone access, not only settings holders (the
//     portal's tab clamp, lifted from 01-core.jsx, against the real title presets).
// The routing itself is the Worker's own tests (workers/phone-api/test/inbound.test.ts).
//
// Run: deno test --node-modules-dir=none --allow-read tests/phone/
//
// Every value here is an obviously fake fixture: this repo is public.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  BUSINESS_HOURS_WORDS, parseBusinessHours, PHONE_DAYS, RING_HOURS_WORDS, validTimeZone,
} from "../../supabase/functions/_shared/phoneHours.ts";
import * as settingsPhone from "../../supabase/functions/portal-settings/phone.ts";
import { PRESETS } from "../../supabase/functions/_shared/access.ts";

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const SMS = await read("../../portal/11-sms.jsx");
const CORE = await read("../../portal/01-core.jsx");
const PHONE_TS = await read("../../supabase/functions/portal-settings/phone.ts");
const SETTINGS_INDEX = await read("../../supabase/functions/portal-settings/index.ts");
const WORKER_ME = await read("../../workers/phone-api/src/routes/me.ts");
const WORKER_HOURS = await read("../../workers/phone-api/src/hours.ts");

const slice = (src: string, a: string, b: string, what: string) => {
  const i = src.indexOf(a), j = src.indexOf(b, i + a.length);
  if (i < 0 || j < 0) throw new Error(`ringHours_test: ${what} anchors moved (start=${i}, end=${j}) — re-point them.`);
  return src.slice(i, j);
};
const err = (r: ReturnType<typeof parseBusinessHours>) => (r.ok ? "" : r.error);

// ── The rule ─────────────────────────────────────────────────────────────────────────────────
Deno.test("portal-settings/phone.ts re-exports the moved rule itself, not a copy", () => {
  assert(settingsPhone.parseBusinessHours === parseBusinessHours);
  assert(settingsPhone.validTimeZone === validTimeZone);
  assert(settingsPhone.PHONE_DAYS === PHONE_DAYS);
  assert(!/function parseBusinessHours|function validTimeZone/.test(PHONE_TS), "no second copy left behind in phone.ts");
});

Deno.test("the owner's business hours are refused in exactly the words they were before the move", () => {
  assertEquals(BUSINESS_HOURS_WORDS, { subject: "Business hours", periods: "opening periods" });
  assertEquals(err(parseBusinessHours([["08:00", "17:00"]])), "Business hours were not in a shape we recognise.");
  assertEquals(err(parseBusinessHours({ wed: [["08:00", "12:00"], ["11:00", "15:00"]] })), "Wednesday's opening periods overlap.");
  assertEquals(err(parseBusinessHours({ fri: [["01:00", "02:00"], ["03:00", "04:00"], ["05:00", "06:00"], ["07:00", "08:00"], ["09:00", "10:00"]] })),
    "Friday has more than 4 opening periods.");
});

Deno.test("a person's own hours: the same rule, in their words", () => {
  const own = (v: unknown) => err(parseBusinessHours(v, RING_HOURS_WORDS));
  assertEquals(own("weekdays"), "Your hours were not in a shape we recognise.");
  assertEquals(own({ funday: [["08:00", "17:00"]] }), "Your hours were not in a shape we recognise.");
  assertEquals(own({ wed: [["08:00", "12:00"], ["11:00", "15:00"]] }), "Wednesday's times overlap.");
  assertEquals(own({ tue: [["17:00", "08:00"]] }), "On Tuesday, the closing time has to be after the opening time.");
  const ok = parseBusinessHours({ fri: [["13:00", "16:00"], ["08:00", "12:00"]], sun: [] }, RING_HOURS_WORDS);
  assertEquals(ok.ok && ok.value, { fri: [["08:00", "12:00"], ["13:00", "16:00"]] });
});

Deno.test("the Worker checks a save with that rule and reads a call's zone with its validTimeZone", () => {
  assert(WORKER_ME.includes(`from "../../../../supabase/functions/_shared/phoneHours.ts"`));
  assert(WORKER_ME.includes("parseBusinessHours(body.ring_hours, RING_HOURS_WORDS)"));
  assert(WORKER_HOURS.includes(`import { validTimeZone } from "../../../supabase/functions/_shared/phoneHours.ts";`));
  // Pure: the Worker bundles it, so it may import nothing.
  const shared = Deno.readTextFileSync(new URL("../../supabase/functions/_shared/phoneHours.ts", import.meta.url));
  assert(!/^\s*import\s/m.test(shared), "_shared/phoneHours.ts must stay import-free");
});

// ── The portal ───────────────────────────────────────────────────────────────────────────────
const ZONES_SRC = slice(SMS, "const PHONE_TIME_ZONES = [", "const PHONE_LEVEL_LABEL", "PHONE_TIME_ZONES");
const HOURS_SRC = slice(SMS, "// When my phone rings (migration 264)", "function PhoneYourCallsCard(", "the hours helpers");
type Form = { on: boolean; hours: Record<string, string[][]>; timeZone: string };
const h = new Function(`${ZONES_SRC}; ${HOURS_SRC};
  return { PHONE_TIME_ZONES, phoneClockWord, phoneHoursSummary, phoneZoneWord, phoneRingHoursSupported, phoneRingHoursForm,
    phoneRingHoursPatch, phoneRingHoursProblem, phoneOffHoursText, phoneRingHoursSavedText };`)() as {
  PHONE_TIME_ZONES: [string, string][];
  phoneClockWord: (s: string) => string;
  phoneHoursSummary: (h: unknown) => string;
  phoneZoneWord: (tz: unknown, zones: unknown) => string;
  phoneRingHoursSupported: (s: unknown) => boolean;
  phoneRingHoursForm: (s: unknown, deviceTz: unknown, defaults: unknown) => Form;
  phoneRingHoursPatch: (f: Form) => Record<string, unknown>;
  phoneRingHoursProblem: (f: Form) => string | null;
  phoneOffHoursText: (c: unknown) => string;
  phoneRingHoursSavedText: (f: Form, zones: unknown) => string;
};
const WEEKDAYS = { mon: [["08:00", "17:00"]], tue: [["08:00", "17:00"]], wed: [["08:00", "17:00"]], thu: [["08:00", "17:00"]], fri: [["08:00", "17:00"]] };

Deno.test("times read like a clock on the wall", () => {
  assertEquals(["08:00", "08:30", "12:00", "00:00", "13:05", "17:00", "23:59"].map(h.phoneClockWord),
    ["8 AM", "8:30 AM", "12 PM", "12 AM", "1:05 PM", "5 PM", "11:59 PM"]);
});

// The same fixtures and answers as the phone repo's packages/phone-core/test/ringHours.test.ts
// (ringHoursSummary), so the portal and the apps describe someone's hours the same way.
Deno.test("the summary groups days in a row with the same times (phone-core ringHoursSummary's answers)", () => {
  assertEquals(h.phoneHoursSummary(null), "Any time");
  assertEquals(h.phoneHoursSummary({}), "No days");
  assertEquals(h.phoneHoursSummary(WEEKDAYS), "Mon–Fri 8 AM–5 PM");
  assertEquals(h.phoneHoursSummary({ ...WEEKDAYS, sat: [["09:00", "12:00"]] }), "Mon–Fri 8 AM–5 PM; Sat 9 AM–12 PM");
  assertEquals(h.phoneHoursSummary({ mon: [["08:00", "12:00"], ["13:00", "17:30"]], wed: [["08:00", "12:00"], ["13:00", "17:30"]] }),
    "Mon 8 AM–12 PM, 1 PM–5:30 PM; Wed 8 AM–12 PM, 1 PM–5:30 PM");
  assertEquals(h.phoneHoursSummary({ sat: [["10:00", "14:00"]], sun: [["10:00", "14:00"]] }), "Sat–Sun 10 AM–2 PM");
  assertEquals(h.phoneHoursSummary({ fri: [["07:00", "15:00"]], mon: [["07:00", "15:00"]] }), "Mon 7 AM–3 PM; Fri 7 AM–3 PM");
});

Deno.test("zones by their everyday name; a zone off the list by its city", () => {
  assertEquals(h.phoneZoneWord("America/Chicago", h.PHONE_TIME_ZONES), "Central time");
  assertEquals(h.phoneZoneWord("America/Phoenix", h.PHONE_TIME_ZONES), "Arizona time");
  assertEquals(h.phoneZoneWord("America/St_Johns", h.PHONE_TIME_ZONES), "Newfoundland time");
  assertEquals(h.phoneZoneWord("America/Argentina/Buenos_Aires", h.PHONE_TIME_ZONES), "Buenos Aires time");
});

Deno.test("the form: offered only by a Worker that keeps hours; seeded from what's saved, else this browser's zone", () => {
  assert(!h.phoneRingHoursSupported({ dnd: false, dnd_cover_user_id: null }), "a Worker without hours: no section");
  assert(h.phoneRingHoursSupported({ ring_hours: null, ring_hours_tz: null }));
  assertEquals(h.phoneRingHoursForm({ ring_hours: null, ring_hours_tz: null }, "America/Denver", WEEKDAYS),
    { on: false, hours: WEEKDAYS, timeZone: "America/Denver" });
  assertEquals(h.phoneRingHoursForm({ ring_hours: { sat: [["09:00", "12:00"]] }, ring_hours_tz: "America/New_York" }, "America/Denver", WEEKDAYS),
    { on: true, hours: { sat: [["09:00", "12:00"]] }, timeZone: "America/New_York" });
  assertEquals(h.phoneRingHoursForm({ ring_hours: null }, null, WEEKDAYS).timeZone, "America/Chicago");
});

Deno.test("the save: Always clears the hours; my hours go with their zone; no day is caught first", () => {
  assertEquals(h.phoneRingHoursPatch({ on: false, hours: WEEKDAYS, timeZone: "America/Denver" }), { ring_hours: null });
  assertEquals(h.phoneRingHoursPatch({ on: true, hours: WEEKDAYS, timeZone: "America/Denver" }), { ring_hours: WEEKDAYS, ring_hours_tz: "America/Denver" });
  assertEquals(h.phoneRingHoursProblem({ on: true, hours: {}, timeZone: "America/Denver" }), "Add hours to at least one day, or choose Always.");
  assertEquals(h.phoneRingHoursProblem({ on: false, hours: {}, timeZone: "America/Denver" }), null);
  assertEquals(h.phoneRingHoursProblem({ on: true, hours: WEEKDAYS, timeZone: "America/Denver" }), null);
  // The same sentence the Worker refuses with.
  const me = Deno.readTextFileSync(new URL("../../workers/phone-api/src/routes/me.ts", import.meta.url));
  assert(me.includes(`const HOURS_NO_DAYS = "Add hours to at least one day, or choose Always.";`));
});

Deno.test("the words: outside your hours names the cover; the saved note names the hours and zone", () => {
  assertEquals(h.phoneOffHoursText({ kind: "teammate", name: "Pat Parker" }), "Outside your hours, calls skip you and ring Pat Parker in your place.");
  assertEquals(h.phoneOffHoursText({ kind: "none" }), "Outside your hours, calls skip you and ring your teammates, or go to voicemail.");
  assertEquals(h.phoneRingHoursSavedText({ on: true, hours: WEEKDAYS, timeZone: "America/Denver" }, h.PHONE_TIME_ZONES),
    "Saved. Your phone rings Mon–Fri 8 AM–5 PM (Mountain time).");
  assertEquals(h.phoneRingHoursSavedText({ on: false, hours: WEEKDAYS, timeZone: "America/Denver" }, h.PHONE_TIME_ZONES),
    "Saved. Your phone rings whenever the business is open.");
});

Deno.test("one weekly editor for the business's hours and your own", () => {
  const editor = slice(SMS, "function PhoneHoursEditor(", "function phoneFormFrom(", "PhoneHoursEditor");
  assertEquals((SMS.match(/<input type="time"/g) ?? []).length, 2, "the time inputs live only in PhoneHoursEditor");
  assert(editor.includes(`<input type="time"`));
  assert(SMS.includes(`<PhoneHoursEditor hours={form.hours} timeZone={form.timeZone} ro={ro}`), "the business's hours use it");
  const card = slice(SMS, "function PhoneYourCallsCard(", "// ── The Calls page", "the card");
  assert(card.includes(`<PhoneHoursEditor hours={hours.hours} timeZone={hours.timeZone}`), "your own hours use it");
  assert(card.includes("ssPhoneSaveMySettings(phoneRingHoursPatch(hours)"), "saved on the Worker, like the cover");
  assert(card.includes("const hoursOk = !!(st && st.settings && phoneRingHoursSupported(st.settings));"));
  const firstReturn = card.indexOf("if (st && st.unavailable) return null;");
  assert(firstReturn > 0 && card.lastIndexOf("useState(") < firstReturn, "hooks stay above the early returns (React #310)");
});

Deno.test("the team screen shows each person's hours, read as a courtesy", () => {
  const get = slice(SETTINGS_INDEX, `if (action === "phone_settings_get") {`, `if (action === "phone_settings_save") {`, "phone_settings_get");
  assert(get.includes(`.select("user_id, ring_hours, ring_hours_tz").eq("client_id", clientId)`));
  assert(get.includes("(hoursRes as any).error ? []"), "a failed read (or a database before 264) shows no hours, never a fault");
  assert(SMS.includes("{t.ringHours && ("), "the member row shows them only when there are some");
});

// ── Who reaches it ───────────────────────────────────────────────────────────────────────────
// The people who answer the phone are mostly not settings holders: the sales_rep, dealer and
// sales_manager presets grant phone and no settings_* area. Before Phone joined SETTINGS_AREAS
// they had no Settings tab at all, so no Your calls card, and both apps' "Change in Structure
// Studio" link (/portal/settings/phone) clamped them to their fallback page.
const line = (src: string, re: RegExp, what: string) => {
  const m = src.match(re);
  if (!m) throw new Error(`ringHours_test: ${what} moved — re-point it.`);
  return m[0];
};
const NAV = [
  line(CORE, /^const SS_SOON_TABS = .*$/m, "SS_SOON_TABS"),
  line(CORE, /^const NONADMIN_TABS = .*$/m, "NONADMIN_TABS"),
  slice(CORE, "const TAB_AREA = {", "// Settings is a hub", "TAB_AREA and SETTINGS_TAB_AREA"),
  slice(CORE, "// Settings is a hub", "// The write half.", "SETTINGS_AREAS and ssCanRead"),
  slice(CORE, "function ssSettingsTabs(", "// ── Inside Company", "ssSettingsTabs"),
  slice(CORE, "function ssCanSeeTab(", "const ACCENT", "the tab clamp"),
].join("\n");
const nav = new Function("ssIsBetaHost", `${NAV}; return { ssClampTab, ssSettingsTabs };`)(() => false) as {
  ssClampTab: (tab: string, isOperator: boolean, canAdmin: boolean, access: unknown) => string;
  ssSettingsTabs: (o: { access: unknown; phoneOffered: boolean }) => [string, ...unknown[]][];
};

Deno.test("a sales rep, dealer or sales manager reaches Settings › Phone (Your calls) and My Profile, and nothing else", () => {
  for (const title of ["sales_rep", "dealer", "sales_manager"] as const) {
    const access = PRESETS[title];
    assert(access.phone === "own" || access.phone === "view", `${title} answers the phone`);
    assert(!Object.keys(access).some((k) => k.startsWith("settings_") && access[k] !== "none"), `${title} holds no settings area`);
    assertEquals(nav.ssClampTab("settings", false, false, access), "settings", `${title}: /portal/settings is theirs`);
    assertEquals(nav.ssSettingsTabs({ access, phoneOffered: true }).map((t) => t[0]), ["phone", "myprofile"], title);
    assertEquals(nav.ssSettingsTabs({ access, phoneOffered: false }).map((t) => t[0]), ["myprofile"], `${title}, calling not offered`);
  }
  // Someone with no phone access and no settings area is still sent to their own page.
  assert(nav.ssClampTab("settings", false, false, PRESETS.crew_member) !== "settings");
});
