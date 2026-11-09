// jack-agent: the word screens on what Jack writes for a customer to read (promo_test.ts).
//
// ONE promotion screen for every way Jack's words reach a customer: a reply a person sends (drafts.ts,
// and again at the press in sends.ts) and a rule's text or email, which goes out by itself (rules.ts,
// when Jack writes a rule and before Jack turns one on). The system prompt tells Claude to refuse too;
// this is the part that holds when Claude doesn't.
//
//   - It is the two lists that stood before 11-09, rules.ts's and drafts.ts's, each kept whole, so it
//     catches everything either one caught (promo_test.ts checks every old pattern is still here). On
//     top of them is the ordinary sales wording an audit found both missed (11-09): "half price",
//     "exclusive offer", "our best deal yet", "buy now and get a free shelf", "get 500 dollars back".
//   - It leans to catching more. A refusal goes back to Claude, who words it again; a promotion that
//     slips out is a text the customer never agreed to get (marketing needs its own consent, and rule
//     emails still have no postal address or sending account of their own).
//   - Left alone on purpose: "bill of sale", "the sales team", "sales tax", "special order", "feel free",
//     "free of debris", and the merge fields ({{deal_title}} isn't a deal).
//   - One difference (11-09): a reply, which a person reads before it goes, answers a customer's own
//     question, so its screen (REPLY_PROMO) lets "for sale" and "our sales office" through. A rule's text
//     goes out by itself to everyone it reaches, so its screen (PROMO) still refuses a bare "sale".
//
// The claims screen (warranty, engineering, code) lives here too, so a rule's promise screen and a
// reply's claims screen read the same list.

const firstHit = (res: RegExp[], text: string): string | null => {
  for (const re of res) {
    const m = re.exec(text);
    if (m) return m[0].trim();
  }
  return null;
};

// ── Promotions ────────────────────────────────────────────────────────────────────────────────────

/** The bare "sale" pattern as rules.ts had it before 11-09, plus two more words after it that are never a
 *  promotion: "sales receipt" and "Sales pipeline" (11-09). Rules send on their own, so this stays wide. */
const RULE_SALE = /\b(?<!bill of )(?<!bills of )sales?\b(?!\s*(rep|person|team|tax|order|agreement|contract|receipt|pipeline)s?\b)/i;
/** The same for a reply, which a person reads before it goes: "it's still for sale", "our sales office",
 *  "thanks for the sale" answer a customer's own question (11-09). "Huge sale", "our sale runs through
 *  Sunday", "Labor Day sale" are still caught here or by the lists below. */
const REPLY_SALE = /\b(?<!bill of )(?<!bills of )(?<!for )(?<!for the )sales?\b(?!\s*(rep|person|team|tax|order|agreement|contract|receipt|pipeline|office|manager|department|lot|desk|staff)s?\b)/i;

/** rules.ts's list before 11-09, whole but for its first pattern, which is RULE_SALE above. */
const FROM_RULES: RegExp[] = [
  RULE_SALE,
  /\d+\s*%\s*off\b/i, /\bpercent off\b/i, /\$\s?\d[\d,.]*\s*off\b/i,
  /\bdiscount(s|ed)?\b/i, /\bcoupons?\b/i, /\bpromo(s|tion|tions|tional)?\b/i, /\bpromo code\b/i,
  /\bspecial (offer|deal|price|pricing|financing|discount)s?\b/i, /\bspecials\b/i,
  /\b(this|our|the|a) (week'?s|month'?s|weekend|holiday|summer|spring|fall|winter|seasonal) special\b/i,
  /\blimited[- ]time\b/i, /\bclearance\b/i, /\bsave (up to|\$|\d)/i, /\bsavings\b/i,
  /\bblack friday\b/i, /\bcyber monday\b/i, /\bfree (shipping|delivery|upgrade|gift|setup)\b/i,
  /\bbuy one\b/i, /\bbogo\b/i, /\brebates?\b/i, /\bact now\b/i, /\bwhile (supplies|they) last\b/i,
  /\bdon'?t miss (out|this)\b/i, /\bonly \d+ (left|days left)\b/i, /\bdeal of the\b/i,
];

/** drafts.ts's list before 11-09, whole. */
const FROM_DRAFTS: RegExp[] = [
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

/** Added 11-09: the ordinary sales wording both lists missed. */
const ADDED: RegExp[] = [
  // Price cuts in words: "half price", "two for one", "marked down", "prices go up Monday".
  /\bhalf[-\s]+(?:off|price[ds]?|priced)\b/i,
  /\b(?:two|2|three|3)[-\s]+for[-\s]+(?:one|1|two|2)\b/i,
  /\bbuy\s+(?:now|today|\d+|two|three)\b/i,
  /\bmarked\s+down\b/i, /\bmark[-\s]?downs?\b/i,
  /\b(?:reduced|slashed|lowered)\s+(?:price|prices|pricing)\b/i, /\bprices?\s+(?:reduced|slashed|lowered)\b/i,
  /\bprices?\s+(?:go(?:es|ing)?\s+up|increase|increases|rise|rising)\b/i,
  /\block\s+in\s+(?:your|the|this|a|our|today'?s)\s+(?:price|pricing|rate|deal|savings)\b/i,
  // Money back: "get 500 dollars back", "$500 back", "cash back".
  /(?:\$\s?\d[\d,.]*\s*k?|\b\d[\d,.]*\s*(?:dollars|bucks))\s+back\b/i, /\bcash[-\s]?back\b/i,
  // Offers and deals: "exclusive offer for past customers", "our best deal yet", "deals on barns".
  // "Exclusively" alone is plain English ("we're exclusively a shed builder"); for customers or for now it
  // isn't (11-09).
  /\bexclusive\b/i,
  /\bexclusively\s+(?:(?:for|to)\s+(?:(?:our|past|new|returning|loyal|existing|select)\s+){0,2}(?:customers|clients|buyers|members|you|folks)|(?:this|today|now|online|until|through|thru))\b/i,
  /\b(?:special|limited|great|amazing|incredible|unbeatable|best|new|holiday|seasonal|introductory|loyalty|bonus|vip)\s+offers?\b/i,
  /\boffers?\s+(?:end|ends|ending|expire|expires|expiring|good|valid)\b/i,
  // "No big deal" and "a great deal of rain" are plain English (11-09); "deal of the" is in the old lists.
  /\b(?:best|lowest|great|greatest|unbeatable|amazing|incredible|hot|(?<!\bno\s)big|bigger|biggest|huge|better)\s+(?:price|prices|pricing|deal(?!\s+of\b)|deals|savings|value|buy)\b/i,
  /\bdeals\b/i, /(?<!\b(?:great|good)\s)\bdeal\s+(?:on|of)\b/i,
  // Free things: "buy now and get a free shelf", "free with every order", "free of charge". A free estimate
  // is how a builder answers "do you charge to come out?", and "feel free if" is a nicety (11-09).
  /\b(?:get|gets|getting|receive|receives|includes?|including|plus)\s+(?:a\s+|an\s+|your\s+|one\s+)?free\b(?!\s+(?:estimates?|quotes?)\b)/i,
  /\bfree\s+(?:with|of\s+charge)\b/i, /(?<!\bfeel\s)\bfree\s+(?:when|if)\b/i,
  // Hurry: "don't wait", "last chance", "going fast", "ends soon".
  /\bdon'?t\s+wait\b/i, /\b(?:last|final)\s+chance\b/i, /\b(?:going|selling)\s+fast\b/i, /\bwon'?t\s+last\b/i,
  /\b(?:ends|ending)\s+(?:soon|today|tonight|tomorrow)\b/i,
  /\bonly\s+(?:a\s+few|\d+)\s+(?:left|remaining|available)\b/i,
  // Money terms: "0% financing", "no money down", "save big".
  // "$0 down" too: a \b before the $ never matched at the start of the text or after a space (11-09).
  /\b(?:0|zero)\s*%\s*(?:apr|interest|financing)\b/i, /(?:\bno|\bzero|\$\s?0)\s+(?:money\s+)?down\b/i,
  /\bno[-\s]interest\s+(?:financing|loans?|payments?|for)\b/i, /\binterest[-\s]free\b/i,
  // "Save today's receipt" is a receipt (11-09).
  /\bsave\s+(?:big|hundreds|thousands|more|now|today(?!['’]s)|on)\b/i,
  // Codes, gifts and giveaways.
  /\b(?:use|enter|apply)\s+code\b/i, /\bgift\s+cards?\b/i, /\bgiveaways?\b/i, /\bsweepstakes\b/i, /\braffle\b/i,
  /\brefer\s+a\s+friend\b/i, /\breferral\s+(?:bonus|reward|credit|discount)s?\b/i,
  /\bdoor[-\s]?busters?\b/i, /\bpre[-\s]?season\b/i,
];

/** The promotion screen on a rule's texts and emails, which go out by themselves. Exported for promo_test.ts. */
export const PROMO: readonly RegExp[] = [...FROM_RULES, ...FROM_DRAFTS, ...ADDED];
/** The screen on a reply a person reads and sends: the same, but for the bare "sale" pattern, which is
 *  REPLY_SALE (11-09). Exported for promo_test.ts. */
export const REPLY_PROMO: readonly RegExp[] = [REPLY_SALE, ...FROM_RULES.slice(1), ...FROM_DRAFTS, ...ADDED];

/** The first promotional words in a rule's text, as written, or null. */
export const promoHit = (text: string): string | null => firstHit(PROMO as RegExp[], String(text ?? ""));
/** The first promotional words in a reply, as written, or null. */
export const replyPromoHit = (text: string): string | null => firstHit(REPLY_PROMO as RegExp[], String(text ?? ""));

/** Whether any of these texts reads like a promotion. */
export const looksPromotional = (texts: string[]): boolean => texts.some((t) => promoHit(t) !== null);

// ── Money: every amount in the text (drafts.ts's reader, moved here and widened 11-09) ─────────────
//
// A reply's amounts must each be a total on the customer's record (drafts.ts checkDraft), and a rule's text
// carries none at all (rules.ts). Until 11-09 the reader saw only "$8,450", "8,450 dollars" and "8,450", so
// "7500", "7.5k" and "5 grand" went through as no amount. Now a bare number of 3 to 6 digits counts too,
// unless it's plainly something else: a size (12x24, 10'), a measure (288 sq ft, 30 days), a count of
// buildings, a year (1900 to 2099), or an order, estimate, serial, lot or stop number. A spelled-out
// amount ("seventy-five hundred") can't be checked, so it is refused on its own (spelledAmountHit).

/** Reads patterns one after another over the text. Each match is blanked before the next pattern runs, so
 *  "$8,450" isn't read again as a bare 8,450, and the matches come back in the order they appear. */
export function scan<T>(text: string, passes: [RegExp, (m: string[]) => T | null][]): (T & { at: number })[] {
  const out: (T & { at: number })[] = [];
  let rest = text;
  for (const [re, read] of passes) {
    rest = rest.replace(re, (...args: unknown[]) => {
      const at = args[args.length - 2] as number;
      const m = args.slice(0, -2).map((x) => (x === undefined ? undefined : String(x))) as string[];
      const v = read(m);
      if (v) out.push({ ...v, at });
      return " ".repeat(m[0].length);
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** What a number right after these names: an order, an estimate, a serial, a lot, a stop. */
const NOT_AMOUNT_BEFORE = String.raw`(?<!\b(?:order|orders|quote|quotes|estimate|estimates|invoice|invoices|serial|serials|no|nos|number|numbers|num|stop|stops|load|loads|lot|lots|unit|units|model|models|item|items|ref|job|po|box|route|rte|hwy|highway|suite|ste|room|apt|zip|code|pin|id|account|acct|ticket|case|repair|repairs|sn|r|q|ss)\.?:?\s*#?\s*)`;
/** What a number right before these is: a size or a measure, a span of time, a share. */
const UNIT_AFTER = String.raw`(?!\s*(?:x|×|['’"”]|%|ft\b|feet\b|foot\b|inch(?:es)?\b|sq\b|square\b|sqft\b|lbs?\b|pounds?\b|mph\b|psf\b|gauge\b|ga\b|miles?\b|mi\b|minutes?\b|mins?\b|hours?\b|hrs?\b|days?\b|weeks?\b|wks?\b|months?\b|years?\b|yrs?\b|pieces?\b|pcs\b|percent\b))`;
/** A count of things, never a price: "120 sheds", "500 customers". */
const COUNT_AFTER = String.raw`(?!\s+(?:sheds?|barns?|buildings?|garages?|carports?|cabins?|units?|customers?|people|families|orders?|styles?|sizes?|colou?rs?|options?|reviews?|stars?|homes?)\b)`;
const BARE_AMOUNT = new RegExp(
  String.raw`(?<![\w#$.,:/×])(?<![x×]\s{1,3})(?<!(?<!\d)-)${NOT_AMOUNT_BEFORE}(?!(?:19|20)\d\d(?!\d|\.\d))(\d{3,6})(?:\.(\d{2}))?(?![\w,/'’×%]|\.\d|-(?!\d))${UNIT_AFTER}${COUNT_AFTER}`,
  "gi",
);

/** Every dollar amount in the text, in cents: "$8,450", "$8,450.50", "8,450 dollars", a bare "8,450" or
 *  "8450", "$8.4k", "7.5k" and "5 grand". */
export function moneyIn(text: string): { text: string; cents: number; hasCents: boolean }[] {
  const amount = (raw: string, whole: string, cents: string | undefined, k?: string) => {
    const n = Number(whole.replace(/,/g, "") + (cents ? "." + cents : ""));
    if (!Number.isFinite(n)) return null;
    return { text: raw.trim(), cents: Math.round(n * (k ? 1000 : 1) * 100), hasCents: !!cents && !k };
  };
  type A = { text: string; cents: number; hasCents: boolean };
  return scan<A>(text, [
    [/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(\s?[kK]\b)?/g, (m) => amount(m[0], m[1], m[2], m[3])],
    [/\b(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s?(?:dollars?|bucks|usd)\b/gi, (m) => amount(m[0], m[1], m[2])],
    // "7.5k", "5 grand": thousands, with no $.
    [/(?<![\w#$.,:/-])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s?(k|grand)\b/gi, (m) => amount(m[0], m[1], m[2], m[3])],
    [/(?<![\d.])\b(\d{1,3}(?:,\d{3})+)(?:\.(\d{2}))?\b/g, (m) => amount(m[0], m[1], m[2])],
    [BARE_AMOUNT, (m) => amount(m[0], m[1], m[2])],
  ]).map(({ text, cents, hasCents }) => ({ text, cents, hasCents }));
}

const ONES = "one|two|three|four|five|six|seven|eight|nine";
const NUMBER_WORD = `${ONES}|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety`;
const SPELLED_AMOUNT = new RegExp(
  String.raw`\b(?:${NUMBER_WORD})(?:[-\s]+(?:${ONES}))?\s+(?:hundred|thousand|grand|k)\b(?!\s*(?:percent|%|feet|foot|ft|miles?|people|customers?|sheds?|barns?|buildings?|years?|times)\b)`,
  "i",
);
/** A spelled-out amount ("seventy-five hundred", "five grand"), as written, or null. It can't be checked
 *  against a record, so a reply says it in digits and a rule leaves it out. */
export const spelledAmountHit = (text: string): string | null => {
  const m = SPELLED_AMOUNT.exec(String(text ?? ""));
  return m ? m[0].trim() : null;
};

// ── Claims: warranty, engineering and code (drafts.ts's list, moved here 11-09, unchanged) ─────────

export const CLAIMS: readonly RegExp[] = [
  /\bwarrant(?:y|ies|ied)\b/i,
  /\bguarantee(?:d|s)?\b/i,
  /\blifetime\b/i,
  /\bengineer(?:ed|ing|s)?\b/i,
  /\bstamped\b/i,
  /\bsnow[-\s]?loads?\b/i,
  /\bwind[-\s]?(?:rating|rated|loads?|speeds?)\b/i,
  /\b\d+\s?mph\b/i,
  /\bpsf\b/i,
  /\bpounds?\s+per\s+square\s+(?:foot|feet)\b/i,
  /\bhurricane[-\s]?(?:rated|proof|ready)\b/i,
  /\b(?:building|county|city|local|state|fire|zoning|electrical)\s+codes?\b/i,
  /\b(?:up\s+to|meets?|meeting|built\s+to)\s+code\b/i,
  /\bcode[-\s]?(?:approved|compliant|compliance|rated)\b/i,
  /\bpermit[-\s]?(?:free|ready)\b/i,
  /\b(?:no|without\s+a|without|don'?t\s+need\s+a|doesn'?t\s+need\s+a|won'?t\s+need\s+a)\s+permits?\b/i,
  /\bpermits?\s+(?:isn'?t|is\s+not|aren'?t|are\s+not)\s+(?:needed|required)\b/i,
  /\brated\s+(?:for|to)\s+\d/i,
  /\bcertified\b/i,
];

/** The first warranty, engineering or code claim in the text, as written, or null. */
export const claimHit = (text: string): string | null => firstHit(CLAIMS as RegExp[], String(text ?? ""));
