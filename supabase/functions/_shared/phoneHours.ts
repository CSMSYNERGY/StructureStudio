// My Synergy Phone hours: a business's (phone_routes.business_hours, set by the owner on
// Settings › Phone) and, since migration 264, a person's own (phone_user_settings.ring_hours,
// "When my phone rings"). Both are the same weekly shape, {"mon":[["08:00","17:00"]], ...}, and
// ONE rule checks them for the two places that save them:
//   * portal-settings parseRoute (portal-settings/phone.ts, which re-exports these): the owner's
//     business hours and time zone;
//   * the phone-api Worker's POST /settings/me (workers/phone-api/src/routes/me.ts): a person's
//     own hours and the time zone they're in.
// Reading them on a call is the Worker's (src/hours.ts isOpen), which is more forgiving than
// this on purpose: a stored value is never a reason to drop a call.
// Pure, no imports: the Worker bundles it too.

/** The seven keys business_hours uses, in the order the Settings screen shows them. */
export const PHONE_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type PhoneDay = typeof PHONE_DAYS[number];
export type BusinessHours = Partial<Record<PhoneDay, [string, string][]>>;

/** More opening periods than this in one day is a typo, not a timetable. */
const MAX_PERIODS_PER_DAY = 4;

/** Is this an IANA time zone this runtime can actually compute business hours in? */
export function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64 || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_LABEL: Record<PhoneDay, string> = {
  mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday",
};

/**
 * The words a refusal uses: the business's by default; a person's own hours (migration 264) say
 * "Your hours" and "times" instead of "Business hours" and "opening periods".
 */
export interface HoursWords {
  /** The whole value, as a sentence's subject: "Business hours". */
  subject: string;
  /** One day's ranges: "opening periods". */
  periods: string;
}
export const BUSINESS_HOURS_WORDS: HoursWords = { subject: "Business hours", periods: "opening periods" };
export const RING_HOURS_WORDS: HoursWords = { subject: "Your hours", periods: "times" };

/**
 * business_hours as the owner sent it → the stored jsonb, or a sentence saying what is wrong.
 *
 * null means ALWAYS OPEN (SPEC: "null = always open"), which is different from an object whose
 * every day is empty — that one is "closed all week", and every call goes to the after-hours
 * action. Both are legitimate, so the two are never collapsed into each other.
 *
 * A day that is missing or empty is closed. Periods must run forward within the day: an
 * overnight period (22:00-06:00) is written as two, one on each day, which is what a builder
 * with a night shift would expect the screen to show anyway.
 */
export function parseBusinessHours(
  raw: unknown,
  words: HoursWords = BUSINESS_HOURS_WORDS,
): { ok: true; value: BusinessHours | null } | { ok: false; error: string } {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  const shape = `${words.subject} were not in a shape we recognise.`;
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: shape };
  const out: BusinessHours = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(PHONE_DAYS as readonly string[]).includes(k)) return { ok: false, error: shape };
    const day = k as PhoneDay;
    if (!Array.isArray(v)) return { ok: false, error: `${DAY_LABEL[day]}'s hours were not in a shape we recognise.` };
    if (v.length > MAX_PERIODS_PER_DAY) return { ok: false, error: `${DAY_LABEL[day]} has more than ${MAX_PERIODS_PER_DAY} ${words.periods}.` };
    const periods: [string, string][] = [];
    for (const p of v) {
      if (!Array.isArray(p) || p.length !== 2 || !HHMM.test(String(p[0])) || !HHMM.test(String(p[1]))) {
        return { ok: false, error: `${DAY_LABEL[day]} has a time that isn't in hours and minutes.` };
      }
      const [open, close] = [String(p[0]), String(p[1])];
      if (open >= close) return { ok: false, error: `On ${DAY_LABEL[day]}, the closing time has to be after the opening time.` };
      periods.push([open, close]);
    }
    periods.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    for (let i = 1; i < periods.length; i++) {
      if (periods[i][0] < periods[i - 1][1]) return { ok: false, error: `${DAY_LABEL[day]}'s ${words.periods} overlap.` };
    }
    if (periods.length) out[day] = periods;
  }
  return { ok: true, value: out };
}
