// Quick sends: the cases the portal's copy of the fill-in rules is held to (portal/01-core.jsx,
// ssFillQuickSend / ssInsertIntoDraft and the picker helpers below them).
//
// They are the phone repo's own: every case in packages/phone-core/test/quick-sends.test.ts for
// fillQuickSend and insertIntoDraft, and the picker cases in mobile/__tests__/quickSends.test.ts,
// copied as data so this repo checks the same things without the phone repo. Two kinds of case
// there are NOT copied, on purpose: the starter set's wording, which is the product owner's
// coaching material and lives only in the private phone repo (migration 258's header), and the
// /quick-sends endpoint calls, which are the Worker's. The starter-set cases' SHAPE is here
// (a phone number where the name would be counts as no name), on neutral text.
//
// Read by tests/phone/quickSends_test.ts (Deno, against the source) and by
// tests/harness/crmQuickSends.mjs (Node, against the COMPILED artifact in a browser). Plain data
// and one seeded generator, so both runtimes import it as it is.

const full = { contactName: "Alex Smith", myName: "Jordan Lee" };
const none = { contactName: null, myName: null };

/** [what, body, fill, expected] — phone-core's fillQuickSend cases, in its order. */
export const FILL_CASES = [
  // "fills first name, last name and my name"
  ["all three", "Hi {first_name} {last_name}, it's {my_name}.", full, "Hi Alex Smith, it's Jordan."],
  ["extra spaces in the name", "{first_name}/{last_name}", { contactName: "  Mary Ann  van Dyke ", myName: null }, "Mary/Ann van Dyke"],
  ["the same fill-in twice", "{first_name}{first_name}", full, "AlexAlex"],
  // "drops a missing fill-in with the space or comma before it"
  ["missing, with its comma", "Hey {first_name}, happy to help", none, "Hey, happy to help"],
  ["missing, before !", "thanks {first_name}!", none, "thanks!"],
  ["missing, before a dash", "Totally get it, {first_name} — I want", none, "Totally get it — I want"],
  ["missing, between words and a dash", "Hey {first_name} — yes", none, "Hey — yes"],
  ["missing, no space after a comma", "Thanks,{first_name}.", none, "Thanks."],
  ["two missing", "Thanks {first_name} {last_name}.", none, "Thanks."],
  ["missing my name", "Talk soon, {my_name}", none, "Talk soon"],
  ["only a fill-in", "{first_name}", none, ""],
  // "drops just the last name when the contact has one word"
  ["one-word name", "Hi {first_name} {last_name}, welcome", { contactName: "Alex", myName: "Jordan" }, "Hi Alex, welcome"],
  // "tidies the gap it leaves"
  ["two spaces then a comma", "Hey  {first_name}, there", none, "Hey, there"],
  ["two spaces either side", "Hey  {first_name}  there", none, "Hey there"],
  ["space before a comma", "Hey {first_name} , there", none, "Hey, there"],
  ["before a line break", "Hi {first_name} \nNext line", none, "Hi\nNext line"],
  ["at the end", "Hi there {first_name}", none, "Hi there"],
  ["opening a message, with its comma", "{first_name}, quick one", none, "quick one"],
  ["opening a line, with its dash", "Hi!\n{first_name} — quick one", none, "Hi!\nquick one"],
  // "leaves unknown {words} and text without fill-ins alone"
  ["unknown words", "Hey {firstname} and {First_Name}, {company}", full, "Hey {firstname} and {First_Name}, {company}"],
  ["no fill-ins at all", "Hey  there , friend .  Two  spaces stay ?", none, "Hey  there , friend .  Two  spaces stay ?"],
  ["spaces inside the braces", "{ first_name }", full, "{ first_name }"],
  // "never puts a value through a second fill"
  ["a name that looks like a fill-in", "Hi {first_name}", { contactName: "{last_name} Smith", myName: null }, "Hi {last_name}"],
  ["a name that looks like a replace pattern", "Hi {first_name}", { contactName: "$& Smith", myName: null }, "Hi $&"],
  // The starter-set cases' shape, on neutral text: a name, none, blank, and the two ways a phone
  // number stands in for a name.
  ["named", "Hey {first_name}, good to hear from you!", full, "Hey Alex, good to hear from you!"],
  ["no name (null)", "Hey {first_name}, good to hear from you!", { contactName: null, myName: "Jordan Lee" }, "Hey, good to hear from you!"],
  ["no name (blank)", "Hey {first_name}, good to hear from you!", { contactName: "", myName: null }, "Hey, good to hear from you!"],
  ["a formatted number for a name", "Hey {first_name}, good to hear from you!", { contactName: "(555) 555-0147", myName: "Jordan Lee" }, "Hey, good to hear from you!"],
  ["an E.164 number for a name", "Hey {first_name}, good to hear from you!", { contactName: "+15555550147", myName: "Jordan Lee" }, "Hey, good to hear from you!"],
  ["thanks, then a dash", "Great — thanks {first_name}! Next", full, "Great — thanks Alex! Next"],
  ["thanks, then a dash, no name", "Great — thanks {first_name}! Next", none, "Great — thanks! Next"],
  ["comma then a dash, no name", "Totally get it, {first_name} — I want", { contactName: "+15555550147", myName: null }, "Totally get it — I want"],
];

/** [draft, text, expected] — phone-core's insertIntoDraft cases. */
export const INSERT_CASES = [
  ["", "Hello there", "Hello there"],
  ["  \n ", "Hello there", "Hello there"],
  ["Thanks!", "Hello there", "Thanks! Hello there"],
  ["Thanks!   \n", "Hello there", "Thanks! Hello there"],
  ["Thanks!", "", "Thanks!"],
  ["Thanks!", "   ", "Thanks!"],
];

/** The app's picker list (mobile/__tests__/quickSends.test.ts). */
export function pickerList() {
  const qs = (id, category) => ({ id, name: `Quick send ${id}`, body: `Hey {first_name}, this is ${id}`, category, sort_order: 0, usage_count: 0 });
  return [qs("a", "Follow-ups"), qs("b", null), qs("c", "Openers"), qs("d", "Follow-ups"), qs("e", "Closers"), qs("f", "Openers")];
}

/** The app's sentences when Insert won't fit (quickSendTooLong). */
export const TOO_LONG = {
  sms: "That quick send doesn't fit. A text holds up to 1,600 characters, so shorten what's in the box first.",
  email: "That quick send doesn't fit. An email holds up to 20,000 characters, so shorten what's in the box first.",
};

/**
 * Bodies built from the pieces the fill-in rules care about (the three fill-ins, an unknown one,
 * spaces, tabs, commas, dashes, line breaks, punctuation), from a fixed seed, so a run against
 * phone-core itself compares the two copies far past the hand-written cases and the same run
 * repeats exactly.
 */
export function fuzzBodies(n = 400, seed = 20261004) {
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const PIECES = ["{first_name}", "{last_name}", "{my_name}", "{first_name}", "{company}", " ", "  ", "\t", ",", ", ", " ,",
    "—", " — ", "–", "-", "\n", "\r\n", "!", "?", ".", ":", ";", "Hey", "thanks", "Hi there", "x", "{", "}"];
  const out = [];
  for (let i = 0; i < n; i++) {
    const len = 1 + Math.floor(rand() * 9);
    let b = "";
    for (let j = 0; j < len; j++) b += PIECES[Math.floor(rand() * PIECES.length)];
    out.push(b);
  }
  return out;
}

/** The fills a fuzzed body is tried with. */
export const FUZZ_FILLS = [
  { contactName: "Alex Smith", myName: "Jordan Lee" },
  { contactName: "Alex", myName: null },
  { contactName: null, myName: null },
  { contactName: "  ", myName: "  Jordan " },
  { contactName: "(555) 555-0147", myName: "Jordan" },
  { contactName: "Mary Ann van Dyke", myName: "Sam" },
];
