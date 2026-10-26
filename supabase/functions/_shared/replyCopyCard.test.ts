// Reply copies on screen (2026-10-07): the My Profile card that switches them, and the line above
// the record's Email box that says where a reply goes. Checked against the shipped source.
//
// The server decides what goes in Reply-To (repReplyTo.ts / emailSend.ts, pinned by their own
// tests); these checks hold the words to it. The card offers two choices, "StructureStudio only"
// by default; neither the card nor the composer may promise the inbox when copies are off, nor
// the record on an account that hasn't set up replies; and both say a customer's attached files
// aren't kept on the record (email-inbound stores the words only), which is the one thing the
// inbox copy still gives that the record doesn't.
//
// ⚠️ THIS FILE SHIPS WITH THE PORTAL COMMIT. repReplyToSenders.test.ts ships with the server one
// and must pass against the old card, so anything about the new card belongs here.
//
// The live behaviour (clicks, saves, the failed-save case) is driven in tests/harness/replyToCard.mjs
// and tests/harness/crmQuickSends.mjs against the compiled portal.
//
// Needs read access to the repo (preflight grants --allow-read=<repo>); no network.

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const read = (rel: string) => Deno.readTextFileSync(new URL(rel, import.meta.url)).replace(/\r\n/g, "\n");
const PROFILE = read("../../../portal/08-integrations.jsx");
const SALES = read("../../../portal/02-sales.jsx");
const SHELL = read("../../../portal/12-shell.jsx");

const cardOf = () => {
  const at = PROFILE.indexOf("Where replies to your emails go");
  assert(at > 0, "couldn't find the reply card");
  // To the next card's comment block, which is not this card's (it talks about quotes being signed).
  const card = PROFILE.slice(at, PROFILE.indexOf("YOUR EMAIL SIGNATURE", at));
  assert(card.length > 500, "couldn't find the end of the reply card");
  return card;
};

Deno.test("the card says what it covers, in estimate wording", () => {
  const card = cardOf();
  assert(/a message, an estimate, an invoice or a change order/.test(card.replace(/\s+/g, " ")), "it covers messages, estimates, invoices and change orders");
  assert(!/\bquotes?\b/i.test(card), "the card says estimate, not quote");
});

Deno.test("the card offers reply copies as two choices, StructureStudio only by default", () => {
  const card = cardOf();
  assert(card.includes('[[false, "StructureStudio only"], [true, "StructureStudio and my inbox"]]'), "the two choices, off first");
  assert(card.includes("onClick={() => saveCopy(on)}"), "each choice saves");
  const btn = card.slice(card.indexOf("data-ss-reply-copy"), card.indexOf("{label}", card.indexOf("data-ss-reply-copy")));
  assert(btn.length > 50 && !/\sdisabled=/.test(btn), "the choices are never silently disabled");
  // Seeded OFF unless the saved prefs say exactly true, the server's rule.
  assert(PROFILE.includes("const [copyOn, setCopyOn] = useState(!!(prefs && prefs.replyCopy === true));"), "OFF unless prefs.replyCopy === true");
});

Deno.test("a save that isn't kept says nothing changed, and a failed one goes back to what the server holds", () => {
  const at = PROFILE.indexOf("const saveCopy = async");
  assert(at > 0, "couldn't find saveCopy");
  const save = PROFILE.slice(at, PROFILE.indexOf("\n  };\n", at));
  assert(/commit\(\{ replyCopy: next \}\)/.test(save), "it saves through the one commit, carrying every other pref");
  // The only build that drops the key is a pre-2026-10-07 one, which still copies everyone: the
  // message must not claim replies stay out of the inbox.
  assert(/if \(next && !kept\)[\s\S]{0,300}"Saved, but this server build didn't keep it, so nothing has changed yet\. Tell CSM Synergy\."/.test(save),
    "a server that drops the key is said plainly, and says nothing changed");
  assert(!/StructureStudio only for now/.test(save), "the message doesn't say where replies go");
  assert(/catch \(e\) \{\s*prefsWant\.current = \{ \.\.\.prefsWant\.current, replyCopy: copyKept\.current \};\s*setCopyOn\(copyKept\.current\);/.test(save),
    "a failed save goes back to what the server last kept");
  // ...and "last kept" is from EVERY card's save, each of which carries replyCopy.
  const c = PROFILE.indexOf("const commit = async");
  const commit = PROFILE.slice(c, PROFILE.indexOf("\n  };\n", c));
  assert(/copyKept\.current = !!\(data && data\.prefs && data\.prefs\.replyCopy === true\);/.test(commit),
    "commit records what the server kept from every save");
});

Deno.test("the card says what each choice does, what waits on replies being set up, and that files aren't kept", () => {
  const card = cardOf();
  assert(/Replies show on the customer's record in StructureStudio only\. Files a customer attaches aren't kept there yet, so pick \\"StructureStudio and my inbox\\" if you need them\./.test(card),
    "OFF: StructureStudio only, and the files go only to the inbox copy");
  assert(/a copy comes to your own inbox too/.test(card), "ON: your inbox as well");
  assert(/Until your company sets up replies under Settings → Email Settings[\s\S]{0,120}whichever you pick/.test(card), "the unrouted fallback");
  assert(/assigned to, if they have one and they've switched this on\./.test(card.replace(/\s+/g, " ")),
    "a confirmation goes to the assigned rep, if there is one, on their own switch");
});

Deno.test("the line above the record's Email box never promises the inbox when copies are off, nor the record before replies are set up", () => {
  const at = SALES.indexOf("{viewingLabel\n");
  assert(at > 0, "couldn't find the line above the Email box");
  const line = SALES.slice(at, SALES.indexOf("</div>", at));
  const branches = line.split("\n").filter((l) => l.includes("<>To <strong>{data.contact.email}</strong>"));
  assert(branches.length === 3, `three lines (view-as, on, off), found ${branches.length}`);
  const [viewAs, on, off] = branches;
  assert(/until this company sets up replies, to the rep only/.test(viewAs), "view-as: the rep alone until replies are set up");
  assert(/if they've switched reply copies on/.test(viewAs), "view-as: the rep's own switch");
  assert(/replies come back here and to your inbox \(just your inbox until your company sets up replies\)/.test(on), "on: the inbox too, and only the inbox before replies are set up");
  assert(/replies come back to this record \(your inbox until your company sets up replies\)/.test(off), "off: the record, the inbox only before replies are set up");
  assert(/Files a customer attaches aren't kept on the record yet: switch on reply copies in My Profile if you need them\./.test(off), "off: files aren't kept on the record");
  assert(!/and to your inbox|comes? to you\b/.test(off), "off never promises the inbox");
  assert(/replyCopy === true\s*\?/.test(line), "only exactly true is on");
});

Deno.test("the shell hands the record the signed-in person's own switch, and nothing in view-as", () => {
  assert(SHELL.includes("replyCopy={viewing ? null : !!(tenant.prefs && tenant.prefs.replyCopy === true)}"),
    "12-shell.jsx passes replyCopy from the boot prefs, null in view-as");
  assert(/emailSignature = null, onEditProfile = null,[\s\S]{0,400}replyCopy = null,/.test(SALES), "CrmRecord takes it, null by default");
});
