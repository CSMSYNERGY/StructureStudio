// promo.ts: the one promotion screen rule messages and replies share, and the claims screen. No network.

import { assert, assertEquals } from "./test_assert.ts";
import { CLAIMS, claimHit, looksPromotional, PROMO, promoHit, REPLY_PROMO, replyPromoHit } from "./promo.ts";
import { RULE_MERGE_FIELDS } from "../_shared/crmRules.ts";

const key = (re: RegExp) => `/${re.source}/${re.flags}`;
const has = new Set(PROMO.map(key));

// The two lists that stood before 11-09, copied from 87a81ba0 (rules.ts:321-331, drafts.ts:564-578), so the
// shared screen is at least as wide as both: every one of their patterns is still in it, unchanged.
const OLD_RULES: RegExp[] = [
  /\b(?<!bill of )(?<!bills of )sales?\b(?!\s*(rep|person|team|tax|order|agreement|contract)s?\b)/i,
  /\d+\s*%\s*off\b/i, /\bpercent off\b/i, /\$\s?\d[\d,.]*\s*off\b/i,
  /\bdiscount(s|ed)?\b/i, /\bcoupons?\b/i, /\bpromo(s|tion|tions|tional)?\b/i, /\bpromo code\b/i,
  /\bspecial (offer|deal|price|pricing|financing|discount)s?\b/i, /\bspecials\b/i,
  /\b(this|our|the|a) (week'?s|month'?s|weekend|holiday|summer|spring|fall|winter|seasonal) special\b/i,
  /\blimited[- ]time\b/i, /\bclearance\b/i, /\bsave (up to|\$|\d)/i, /\bsavings\b/i,
  /\bblack friday\b/i, /\bcyber monday\b/i, /\bfree (shipping|delivery|upgrade|gift|setup)\b/i,
  /\bbuy one\b/i, /\bbogo\b/i, /\brebates?\b/i, /\bact now\b/i, /\bwhile (supplies|they) last\b/i,
  /\bdon'?t miss (out|this)\b/i, /\bonly \d+ (left|days left)\b/i, /\bdeal of the\b/i,
];
const OLD_DRAFTS: RegExp[] = [
  /\bspecials?\b(?!\s+(?:order|orders|ordered|request|requests|instructions?|delivery|notes?))/i,
  /\bon\s+sale\b/i,
  /\bsale\s+(?:price|prices|pricing|ends|event)\b/i,
  /\b(?:holiday|fall|spring|summer|winter|year[-\s]end|big|flash)\s+sale\b/i,
  /\bclearance\b/i, /\bcloseout\b/i, /\bblowout\b/i,
  /\bdiscount(?:s|ed)?\b/i, /\bcoupons?\b/i, /\bpromo(?:s|tion|tions|tional)?\b/i, /\brebates?\b/i,
  /\d+\s?%\s?off\b/i, /\$\s?\d[\d,]*\s+off\b/i, /\b(?:percent|dollars)\s+off\b/i,
  /\blimited[-\s]time\b/i, /\bact\s+(?:now|fast)\b/i, /\bhurry\b/i, /\btoday\s+only\b/i, /\b(?:week|weekend|month)\s+only\b/i,
  /\bwhile\s+(?:supplies|they)\s+last\b/i, /\bblack\s+friday\b/i, /\bcyber\s+monday\b/i,
  /\bfree\s+(?:delivery|shipping|upgrades?|gift|set-?up|install(?:ation)?|leveling|ramp|loft|shel(?:f|ves)|windows?)\b/i,
  /\bfor\s+free\b/i,
  /\b(?:best|lowest|unbeatable)\s+(?:price|prices|deal|deals)\b/i, /\bprice\s+(?:drop|cut|cuts)\b/i, /\bsave\s+(?:up\s+to\s+)?\$/i,
  /\bdeal\s+of\s+the\b/i, /\bexclusive\s+offer\b/i, /\boffer\s+(?:ends|expires)\b/i,
];
const OLD_CLAIMS: RegExp[] = [
  /\bwarrant(?:y|ies|ied)\b/i, /\bguarantee(?:d|s)?\b/i, /\blifetime\b/i, /\bengineer(?:ed|ing|s)?\b/i, /\bstamped\b/i,
  /\bsnow[-\s]?loads?\b/i, /\bwind[-\s]?(?:rating|rated|loads?|speeds?)\b/i, /\b\d+\s?mph\b/i, /\bpsf\b/i,
  /\bpounds?\s+per\s+square\s+(?:foot|feet)\b/i, /\bhurricane[-\s]?(?:rated|proof|ready)\b/i,
  /\b(?:building|county|city|local|state|fire|zoning|electrical)\s+codes?\b/i, /\b(?:up\s+to|meets?|meeting|built\s+to)\s+code\b/i,
  /\bcode[-\s]?(?:approved|compliant|compliance|rated)\b/i, /\bpermit[-\s]?(?:free|ready)\b/i,
  /\b(?:no|without\s+a|without|don'?t\s+need\s+a|doesn'?t\s+need\s+a|won'?t\s+need\s+a)\s+permits?\b/i,
  /\bpermits?\s+(?:isn'?t|is\s+not|aren'?t|are\s+not)\s+(?:needed|required)\b/i, /\brated\s+(?:for|to)\s+\d/i, /\bcertified\b/i,
];

/** What an audit (11-09) found the old screens let through. The first five are the rule phrasings the audit
 *  names (it ran nine and names five; the old rules list missed all five, the old reply list the first
 *  one). "Get 500 dollars back" is the reply screen's own miss the audit names. The rest are ordinary sales
 *  wording of the same kind, written here, each one that BOTH old lists missed. */
const MISSED = [
  "Half price on every shed this week",
  "Exclusive offer for past customers",
  "Hurry, offer ends Friday",
  "Our best deal yet on 12x24 barns",
  "Buy now and get a free shelf",
  "Get 500 dollars back when you order",
  "Two for one on lean-tos",
  "Lock in your price before prices go up",
  "0% financing and no money down on every barn",
  "Refer a friend and get a gift card",
  "Last chance: carports are marked down",
  "Great deals on garages, but they're going fast",
  "Save big on carports this month",
];
/** Promotions next to the plain English the 11-09 narrowing lets through: still caught. */
const STILL_CAUGHT = [
  "Save today on every carport",
  "Free if you sign by Friday",
  "Great deal on a 10x12",
  "Available exclusively to past customers",
  "Exclusively for our past customers this month",
  "Rent to own with no money down",
  "$0 down on every barn",
  "No better price in town",
  "A great deal of the year on lean-tos",
];

/** Everyday messages a rule or a reply sends: none of them is a promotion. */
const EVERYDAY = [
  "Your shed is ready for pickup.",
  "Your estimate is attached.",
  "We'll deliver on the date we set together.",
  "Reply STOP to opt out.",
  "Would you leave us a review?",
  "Your bill of sale is attached.",
  "Your special order doors are in.",
  "Thanks from the sales team at {{business}}.",
  "Your sales tax is on the invoice.",
  "Feel free to call us with any questions.",
  "Please keep the site level and free of debris.",
  "Hi {{first_name}}, your {{deal_title}} has been delivered.",
  "Thanks for your payment, {{first_name}}.",
  "Your change order is ready to sign.",
  "Questions? Just reply to this text.",
  "How is your new building holding up?",
  "Our crew is on the way.",
  "Thanks for your business!",
  "We offer delivery and setup with every building.",
  "Use the code in your email to sign in.",
  // Plain English the 11-09 patterns refused at first (an audit, 11-09).
  "We've had a great deal of rain, so your delivery moves to Thursday.",
  "It took a good deal of work to get the permit.",
  "Feel free if you have any questions.",
  "We're exclusively a shed builder.",
  "Please save today's receipt.",
  "It's no big deal, we can move the date.",
  "You get a free estimate before anything is ordered.",
  "Your sales receipt is attached.",
  "Thanks from everyone on the Sales pipeline team.",
];

/** A reply answers a customer's own question, so these pass there, and only there. */
const REPLY_ONLY = ["Yes, it's still for sale. Want me to hold it for you?", "Re: Shed for sale", "Our sales office is open until 5", "I'll ask our sales manager", "We have one on our sales lot", "Thanks for the sale!"];

Deno.test("promo: every pattern either old list had is still in the shared screen, unchanged, but the bare sale one", () => {
  // The bare "sale" pattern (OLD_RULES[0]) let two more words through after it on 11-09, "receipt" and
  // "pipeline". Everything else it caught, it still catches.
  for (const re of [...OLD_RULES.slice(1), ...OLD_DRAFTS]) assert(has.has(key(re)), `missing ${key(re)}`);
  assert(!has.has(key(OLD_RULES[0])));
  for (const t of ["Our holiday sale starts Friday", "Sale! 12x24 barns", "Sales event this weekend", "A sale on every shed", "Thanks for the sale!", "Sheds for sale"]) {
    assert(OLD_RULES[0].test(t), t);
    assert(promoHit(t) !== null, `the rule screen lets "${t}" through`);
  }
  const claims = new Set(CLAIMS.map(key));
  for (const re of OLD_CLAIMS) assert(claims.has(key(re)), `missing claim ${key(re)}`);
  assertEquals(CLAIMS.length, OLD_CLAIMS.length);
});

Deno.test("promo: a reply's screen is the rule screen but for the bare sale pattern, so 'for sale' and 'sales office' pass a reply only", () => {
  assertEquals(REPLY_PROMO.length, PROMO.length);
  assertEquals(REPLY_PROMO.slice(1).map(key), PROMO.slice(1).map(key));
  for (const t of REPLY_ONLY) {
    assertEquals(replyPromoHit(t), null, t);
    assert(promoHit(t) !== null, `a rule text "${t}" got through`);
  }
  for (const t of ["Huge sale on sheds this weekend", "Our sale runs through Sunday", "Labor Day sale!", "Sale! 12x24 barns", "Everything is on sale.", "Our holiday sale starts Friday", ...MISSED, ...STILL_CAUGHT]) {
    assert(replyPromoHit(t) !== null, `a reply "${t}" got through`);
  }
  for (const t of EVERYDAY) assertEquals(replyPromoHit(t), null, t);
});

Deno.test("promo: what the old tests caught is still caught", () => {
  const rulesOld = ["20% off sheds this weekend!", "Our holiday sale starts Friday", "Use coupon code SHED50", "Limited time: free delivery", "Black Friday pricing on all barns", "Save $500 on a 12x24", "Ask about our specials"];
  const draftsOld = ["Take 20% off this week!", "Our fall special ends soon.", "Everything is on sale.", "Free delivery if you sign today.", "Limited time only."];
  for (const t of [...rulesOld, ...draftsOld]) assert(looksPromotional([t]), t);
});

Deno.test("promo: the ordinary sales wording both old lists missed is caught", () => {
  for (const t of [...MISSED, ...STILL_CAUGHT]) {
    assert(promoHit(t) !== null, t);
    assert(looksPromotional(["Hi {{first_name}}.", t]), t);
  }
  // The words it caught come back as written, for the reply's sentence.
  assertEquals(promoHit("Half price on every shed this week"), "Half price");
  assertEquals(promoHit("Get 500 dollars back when you order"), "500 dollars back");
});

Deno.test("promo: everyday messages and the merge fields pass", () => {
  for (const t of EVERYDAY) assertEquals(promoHit(t), null, t);
  for (const f of Object.keys(RULE_MERGE_FIELDS)) assertEquals(promoHit(`Hi ${f}, thanks.`), null, f);
  assert(!looksPromotional(EVERYDAY));
  assert(!looksPromotional([]));
});

Deno.test("claims: the reply's claims screen reads as it did", () => {
  for (const t of ["It comes with a lifetime warranty.", "Engineered for a 40 psf snow load.", "It's built to code.", "No permit needed for that size.", "Rated for 120 mph winds.", "We guarantee it."]) {
    assert(claimHit(t) !== null, t);
  }
  for (const t of EVERYDAY) assertEquals(claimHit(t), null, t);
});
