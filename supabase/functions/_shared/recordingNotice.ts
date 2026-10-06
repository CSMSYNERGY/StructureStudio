// Call recording (migration 263): does a business's own announcement tell callers the call is
// recorded? ONE rule for the three places that read the sentence:
//   * portal-settings parseRecording (phone.ts): the owner's save is refused when it doesn't;
//   * the Settings card (portal/11-sms.jsx phoneRecNoticeProblem): a copy, so the owner sees it
//     before pressing Save (tests/phone/callRecordingUi_test.ts checks the two agree);
//   * the phone-api Worker's noticeText (src/recording.ts): a stored sentence that fails it is
//     never spoken; the standard sentence plays instead.
//
// Said: "record", "records", "recorded", "recording" or "recordings" as a word of its own (not
// "record-setting"). Denied: "not", "never", "no" or "n't" up to two words before it ("is not
// recorded", "won't be recorded", "calls are never recorded"). A plain check, not a lawyer: it
// stops the obvious mistakes, and the card's legal note leaves the rest to the business.
// Pure, no imports: the Worker bundles it too.

const SAYS = /\brecord(?:s|ed|ings?)?\b(?!-)/i;
const DENIES = /(?:\b(?:not|never|no)|n't)\s+(?:[\w']+\s+){0,2}record/i;

/** Whether `text` says the call is recorded and doesn't say it isn't. */
export function noticeSaysRecorded(text: string): boolean {
  const t = String(text ?? "");
  return SAYS.test(t) && !DENIES.test(t);
}
