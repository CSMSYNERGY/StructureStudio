/**
 * Quiet hours for outbound SMS — the TCPA send window, decided from the recipient's own
 * area code.
 *
 * A leaf module with zero imports, like twilioSms.ts, so preflight can unit-test it offline.
 *
 * THE RULE: no texting outside 8am–9pm in the RECIPIENT'S local time. Five states cut the
 * evening an hour earlier (8pm): Florida, Connecticut, Maryland, Oklahoma, Washington. The
 * federal floor is 9pm; those states legislated tighter, and the tighter one governs.
 *
 * ⚠️ AN AREA CODE IS NOT A TIMEZONE, and this module does not pretend otherwise. Numbers are
 * portable — a Miami area code can sit in a pocket in Seattle — and several area codes
 * straddle a timezone line. What this buys is a defensible, documented approximation that
 * stops the 2am send, which is the thing that generates complaints and carrier attention.
 * It is deliberately CONSERVATIVE: when the area code is unknown, the strictest common
 * window is applied rather than waving the message through, because an unknown number is
 * exactly the case where guessing wrong is least defensible.
 *
 * ⚠️ A DIRECT HUMAN REPLY IS NOT SUBJECT TO THIS. A builder answering a customer who just
 * texted them at 9:15pm is a conversation, not a campaign. smsSend passes bypassQuietHours
 * for that path. Automation never gets the bypass.
 */

/** Area code → IANA-ish UTC offset in hours (standard time) and whether the state observes
 *  US daylight saving. Only NANP codes we can actually text matter here. */
type Zone = { std: number; dst: boolean; earlyClose?: boolean };

/** Eastern. earlyClose marks the 8pm states: FL, CT, MD. */
const EASTERN: Zone = { std: -5, dst: true };
const EASTERN_EARLY: Zone = { std: -5, dst: true, earlyClose: true };
const CENTRAL: Zone = { std: -6, dst: true };
const CENTRAL_EARLY: Zone = { std: -6, dst: true, earlyClose: true }; // Oklahoma
const MOUNTAIN: Zone = { std: -7, dst: true };
const ARIZONA: Zone = { std: -7, dst: false };
const PACIFIC: Zone = { std: -8, dst: true };
const PACIFIC_EARLY: Zone = { std: -8, dst: true, earlyClose: true }; // Washington
const ALASKA: Zone = { std: -9, dst: true };
const HAWAII: Zone = { std: -10, dst: false };

/**
 * Area codes by zone. Compiled from the NANP assignment list; states that split a timezone
 * are assigned by where the bulk of the code's population sits, which is the same
 * approximation every commercial sender makes.
 */
const AREA_ZONES: Record<string, Zone> = {};
const put = (zone: Zone, codes: string[]) => { for (const c of codes) AREA_ZONES[c] = zone; };

// Florida, Connecticut, Maryland — 8pm close.
put(EASTERN_EARLY, [
  "239", "305", "321", "352", "386", "407", "561", "656", "689", "727", "754", "772", "786",
  "813", "863", "904", "941", "954", // FL
  "203", "475", "860", "959",        // CT
  "227", "240", "301", "410", "443", "667", // MD
]);
// Oklahoma — 8pm close, Central.
put(CENTRAL_EARLY, ["405", "539", "572", "580", "918"]);
// Washington — 8pm close, Pacific.
put(PACIFIC_EARLY, ["206", "253", "360", "425", "509", "564"]);

put(EASTERN, [
  "201", "202", "212", "215", "216", "217", "223", "234", "236", "260", "267", "272", "276",
  "301", "302", "304", "315", "317", "324", "326", "330", "332", "336", "339", "347", "351",
  "364", "367", "380", "412", "413", "419", "434", "440", "445", "463", "464", "469", "470",
  "475", "484", "513", "516", "517", "518", "540", "551", "557", "567", "570", "571", "574",
  "578", "581", "585", "586", "592", "603", "607", "609", "610", "614", "615", "616", "617",
  "631", "634", "636", "645", "646", "667", "672", "678", "680", "681", "689", "703", "704",
  "706", "707", "716", "717", "718", "724", "726", "729", "732", "734", "737", "740", "743",
  "747", "757", "762", "765", "770", "772", "774", "781", "786", "802", "803", "804", "810",
  "812", "814", "820", "828", "839", "843", "845", "848", "854", "856", "857", "859", "860",
  "862", "864", "865", "878", "904", "908", "910", "914", "917", "919", "929", "930", "934",
  "937", "938", "947", "959", "970", "980", "984",
]);
put(CENTRAL, [
  "205", "214", "217", "218", "219", "224", "225", "228", "251", "254", "256", "262", "270",
  "281", "309", "312", "314", "316", "318", "319", "320", "331", "334", "337", "346", "354",
  "361", "402", "409", "414", "417", "430", "432", "469", "479", "501", "504", "507", "512",
  "515", "563", "573", "575", "601", "605", "608", "612", "618", "620", "630", "636", "641",
  "651", "660", "662", "682", "708", "712", "713", "715", "731", "737", "763", "769", "773",
  "779", "785", "806", "815", "816", "817", "830", "832", "847", "870", "872", "901", "903",
  "913", "915", "920", "931", "936", "940", "952", "956", "972", "979", "985",
]);
put(MOUNTAIN, [
  "208", "303", "307", "308", "385", "406", "435", "505", "575", "719", "720", "801", "970",
  "986",
]);
put(ARIZONA, ["480", "520", "602", "623", "928"]);
put(PACIFIC, [
  "209", "213", "279", "310", "323", "341", "350", "369", "408", "415", "424", "442", "458",
  "503", "530", "541", "559", "562", "619", "626", "628", "650", "657", "661", "669", "702",
  "707", "714", "725", "738", "747", "760", "775", "805", "818", "820", "831", "840", "858",
  "909", "916", "925", "949", "951", "971",
]);
put(ALASKA, ["907"]);
put(HAWAII, ["808"]);

/** US daylight saving: second Sunday in March 2am → first Sunday in November 2am.
 *  Computed rather than table-driven so it does not expire. */
function isUsDst(utc: Date): boolean {
  const y = utc.getUTCFullYear();
  const secondSundayMarch = (() => {
    const d = new Date(Date.UTC(y, 2, 1));
    const firstSunday = 1 + ((7 - d.getUTCDay()) % 7);
    return new Date(Date.UTC(y, 2, firstSunday + 7, 7)); // 2am local ≈ 07:00 UTC
  })();
  const firstSundayNov = (() => {
    const d = new Date(Date.UTC(y, 10, 1));
    const firstSunday = 1 + ((7 - d.getUTCDay()) % 7);
    return new Date(Date.UTC(y, 10, firstSunday, 6));
  })();
  return utc >= secondSundayMarch && utc < firstSundayNov;
}

export type QuietVerdict = { allowed: true } | { allowed: false; reason: string; localHour: number };

/**
 * @param phoneKey the 10-digit NANP key (smsPhoneKey output)
 * @param now      injectable for tests; defaults to the real clock
 */
export function quietHoursVerdict(phoneKey: string, now: Date = new Date()): QuietVerdict {
  const area = String(phoneKey ?? "").slice(0, 3);
  const zone = AREA_ZONES[area];

  // ⚠️ UNKNOWN AREA CODE → THE STRICTEST WINDOW, not a free pass. An unrecognised code is
  // most likely a number we cannot place, and "we did not know where they were" is not a
  // defence anyone wants to make. Eastern open (8am ET = 5am PT) with an early 8pm close is
  // the intersection of every US window.
  const z = zone ?? { std: -5, dst: true, earlyClose: true };

  const offset = z.std + (z.dst && isUsDst(now) ? 1 : 0);
  const localMs = now.getTime() + offset * 3600_000;
  const local = new Date(localMs);
  const hour = local.getUTCHours();
  const closeHour = z.earlyClose ? 20 : 21;

  if (hour >= 8 && hour < closeHour) return { allowed: true };

  const closeLabel = z.earlyClose ? "8pm" : "9pm";
  return {
    allowed: false,
    localHour: hour,
    reason: zone
      ? `It is ${formatHour(hour)} where this customer lives. Texts can only go out between 8am and ${closeLabel} their time — try again then, or call them instead.`
      : `We cannot tell what time it is where this customer lives, so we use the strictest window: 8am to 8pm Eastern. It is ${formatHour(hour)} Eastern now.`,
  };
}

function formatHour(h: number): string {
  const suffix = h < 12 ? "am" : "pm";
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve}${suffix}`;
}
