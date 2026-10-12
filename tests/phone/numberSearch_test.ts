// Searching for a number to buy by the area code AND up to three more digits (the 2026-10-12
// call: the old phone system took "up to six digits"). The parser and what Twilio is sent are
// pinned in supabase/functions/_shared/numberSearch.test.ts; this file pins the rest, against the
// SHIPPED sources (slice between stable anchors, fail loudly if they move):
//   * the portal's search box on both screens (portal/11-sms.jsx): Settings → Phone ("Get a
//     number", "Add another number") and Text Messaging ("Choose your number");
//   * the two server actions that read it: portal-settings phone_search_numbers and portal-sms
//     search_numbers.
//
// Run: deno test --node-modules-dir=none --allow-read --allow-env tests/phone/
//
// Nothing here reaches Twilio or a database. Fixtures are fake (555 numbers).

import { assert, assertEquals } from "jsr:@std/assert@1";
import { numberSearchOf } from "../../supabase/functions/_shared/numberSearch.ts";

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const SMS = await read("../../portal/11-sms.jsx");
const SETTINGS = await read("../../supabase/functions/portal-settings/index.ts");
const PORTAL_SMS = await read("../../supabase/functions/portal-sms/index.ts");
const slice = (src: string, a: string, b: string, what: string) => {
  const i = src.indexOf(a), j = src.indexOf(b, i + a.length);
  if (i < 0 || j < 0) throw new Error(`numberSearch_test: ${what} anchors moved (start=${i}, end=${j}) — re-point them.`);
  return src.slice(i, j);
};

// The three portal helpers, lifted as they ship.
const HELPERS = slice(SMS, "function phoneSearchDigits(raw) {", "\nfunction SmsField(", "the search helpers");
const { phoneSearchDigits, phoneSearchLabel, phoneSearchBody } = new Function(
  `${HELPERS}\nreturn { phoneSearchDigits, phoneSearchLabel, phoneSearchBody };`,
)() as {
  phoneSearchDigits: (raw: unknown) => string;
  phoneSearchLabel: (d: string) => string;
  phoneSearchBody: (d: string) => { areaCode: string; startsWith: string };
};

Deno.test("the box keeps up to six digits, however they're typed or pasted, without a +1", () => {
  assertEquals(phoneSearchDigits("555"), "555");
  assertEquals(phoneSearchDigits("555300"), "555300");
  assertEquals(phoneSearchDigits("555-300"), "555300");
  assertEquals(phoneSearchDigits("(555) 300"), "555300");
  assertEquals(phoneSearchDigits("+1 555 300"), "555300");
  assertEquals(phoneSearchDigits("+1 (555) 300-0101"), "555300", "a whole pasted number is cut to its first six digits");
  assertEquals(phoneSearchDigits("5553001"), "555300", "a seventh digit is not taken");
  assertEquals(phoneSearchDigits("1"), "", "no US area code starts with 1");
  assertEquals(phoneSearchDigits(""), "");
  assertEquals(phoneSearchDigits(null), "");
});

Deno.test("what the box sends, the server reads as the same search (3 to 6 digits)", () => {
  for (const typed of ["555", "5553", "55530", "555300", "555-300", "+1 (555) 300-0101", "(555) 3"]) {
    const d = phoneSearchDigits(typed);
    const body = phoneSearchBody(d);
    const q = numberSearchOf(body.startsWith ?? body.areaCode);
    assert(q.ok && q.digits === d && q.areaCode === d.slice(0, 3), `${typed} → ${JSON.stringify(q)}`);
  }
  // A server from before the longer search reads only areaCode: three digits, its area code.
  assertEquals(phoneSearchBody("555300"), { areaCode: "555", startsWith: "555300" });
  assertEquals(phoneSearchBody(""), { areaCode: "", startsWith: "" });
});

Deno.test("an empty result says what was searched, and what to try", () => {
  assertEquals(phoneSearchLabel("555300"), "555-300");
  assertEquals(phoneSearchLabel("5553"), "555-3");
  assertEquals(phoneSearchLabel("555"), "555");
});

// ── Settings → Phone ───────────────────────────────────────────────────────────────────────
Deno.test("Settings → Phone: the box takes the area code or first digits, and an empty result names them", () => {
  const view = slice(SMS, "function PhoneSettingsView(", "// ── The Calls page", "PhoneSettingsView");
  const box = slice(view, "const searchBlock = (", "const numberCard = (", "searchBlock");
  assert(box.includes('placeholder="Area code or first digits, e.g. 816 or 816300"'), "the placeholder says more than the area code works");
  assert(/onChange=\{\(e\) => setNumQ\(phoneSearchDigits\(e\.target\.value\)\)\}/.test(box));
  assert(!/maxLength=\{3\}/.test(box), "no longer three digits");
  assert(box.includes("No numbers start with ${phoneSearchLabel(numFor)} right now — try fewer digits."));
  assert(box.includes("No numbers available there right now. Try a nearby area code, or leave it empty."), "an area code alone reads as before");
  assert(/phoneAction\("phone_search_numbers", phoneSearchBody\(numQ\)\);\s*setNumResults\(d\.numbers \|\| \[\]\);\s*setNumFor\(numQ\);/.test(view),
    "the empty sentence names what was SEARCHED, not what has been typed since");
  // Hooks stay above the early returns (React #310).
  const firstReturn = view.indexOf("if (err && !data) return");
  const hook = view.indexOf('const [numFor, setNumFor] = useState("");');
  assert(hook > 0 && hook < firstReturn, "numFor is declared above the first early return");
});

// ── Text Messaging → Choose your number ─────────────────────────────────────────────────────
Deno.test("Text Messaging: 'Choose your number' takes the same search", () => {
  const view = slice(SMS, "function SmsMessagingView(", "\nfunction ", "SmsMessagingView");
  const card = slice(view, "<h4 style={{ margin: \"0 0 10px\", fontSize: 14 }}>Choose your number</h4>", "{found && found.length > 0 && (", "Choose your number");
  assert(card.includes('<SmsField label="Area code or first digits">'));
  assert(card.includes('placeholder="e.g. 816 or 816300"'));
  assert(/onChange=\{\(e\) => setAreaCode\(phoneSearchDigits\(e\.target\.value\)\)\}/.test(card));
  assert(!/maxLength=\{3\}/.test(card));
  assert(/call\("search_numbers", phoneSearchBody\(areaCode\)\); setFound\(d\.numbers \|\| \[\]\); setFoundFor\(areaCode\);/.test(card));
  assert(card.includes("No numbers start with ${phoneSearchLabel(foundFor)} right now — try fewer digits."));
  const firstReturn = view.indexOf("if (!data) return <SkelRows");
  const hook = view.indexOf('const [foundFor, setFoundFor] = useState("");');
  assert(hook > 0 && hook < firstReturn, "foundFor is declared above the first early return");
});

// ── The servers ────────────────────────────────────────────────────────────────────────────
Deno.test("portal-settings phone_search_numbers: refuses a bad search before Twilio, sends the pattern, keeps only matches", () => {
  const b = slice(SETTINGS, 'if (action === "phone_search_numbers") {', "\n  }\n", "phone_search_numbers");
  assert(/^if \(action === "phone_search_numbers"\) \{\s*const refused = await phoneRolloutGate\(\);\s*if \(refused\) return refused;/.test(b), "the rollout gate is still first");
  assert(b.includes("const q = numberSearchOf(payload?.startsWith ?? payload?.areaCode);"), "a screen sending only areaCode still works");
  assert(b.includes("if (!q.ok) return json({ error: q.error }, 400);"));
  assert(b.indexOf("if (!q.ok)") < b.indexOf("await tenantTwilio()"), "a bad search is refused before any Twilio account is resolved");
  assert(b.includes("searchAvailableNumbers({ areaCode: q.areaCode ?? undefined, contains: q.contains ?? undefined, limit: 10 }, tw.account)"));
  assert(b.includes("startsWithPrefix(results, q.prefix).map((n) => ({ e164: n.phoneNumber, locality: n.locality, region: n.region }))"));
  assert(SETTINGS.includes('import { numberSearchOf, startsWithPrefix } from "../_shared/numberSearch.ts";'));
  assert(!/areaCodeOf/.test(SETTINGS), "the three-digit-only reader is gone");
});

Deno.test("portal-sms search_numbers: the same reading of the box", () => {
  const c = slice(PORTAL_SMS, 'case "search_numbers": {', 'case "buy_number": {', "search_numbers");
  assert(c.includes("const q = numberSearchOf(p.startsWith ?? p.areaCode);"));
  assert(c.includes("if (!q.ok) return json({ error: q.error }, 400);"));
  assert(c.indexOf("if (!q.ok)") < c.indexOf("await tenantCreds()"), "a bad search is refused before any Twilio account is resolved");
  assert(c.includes("areaCode: q.areaCode ?? undefined,"));
  assert(c.includes("contains: q.contains ?? (p.contains ? String(p.contains) : undefined),"));
  assert(c.includes("return json({ ok: true, numbers: startsWithPrefix(results, q.prefix) });"));
  assert(!/\.slice\(0, 3\) \|\| undefined/.test(c), "the area code is no longer cut to three digits");
  assert(PORTAL_SMS.includes('import { numberSearchOf, startsWithPrefix } from "../_shared/numberSearch.ts";'));
});
