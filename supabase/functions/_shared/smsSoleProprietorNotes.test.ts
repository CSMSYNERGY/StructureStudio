// No-EIN texting (2026-10-27): the sole proprietor's attention notes, shared by portal-sms and
// twilio-events (smsSoleProprietorNotes.ts). What is pinned:
//   * clearSoleProprietorStepNote clears exactly the four step notes (switched off, not a Starter
//     profile, no SOLE_PROPRIETOR use case, late YES), word for word, and returns {} for every other
//     note, so a spread of it changes nothing for anyone else (an EIN builder above all);
//   * brandEventErrors maps Event Streams' brandregistrationerrors[] onto the {error_code,
//     description, fields} shape the portal reads, passes a REST-shaped entry through, and answers
//     null (write nothing) when the event carries no list;
//   * the brand and campaign code sentences pick the first code that has one, else the fallback.
// Self-contained (no jsr:/npm:), so preflight runs it with no import map, like every _shared test.
// Run: deno test --node-modules-dir=none -A supabase/functions/_shared/smsSoleProprietorNotes.test.ts
// Every value is made up (the repo is public).

import {
  brandEventErrors, clearSoleProprietorStepNote, errorCodesOf, isSoleProprietorStepNote, SOLE_PROP_EXPIRED_NOTE,
  SOLE_PROP_LATE_NOTE, SOLE_PROP_NO_USE_CASE_NOTE, SOLE_PROP_NOT_STARTER_NOTE, SOLE_PROP_OFF_NOTE, SOLE_PROP_STEP_NOTES,
  SOLE_PROP_TRUST_PRODUCT_NOTE, soleProprietorBrandNote, soleProprietorCampaignNote,
} from "./smsSoleProprietorNotes.ts";

const assert = (cond: unknown, msg = "assertion failed") => {
  if (!cond) throw new Error(msg);
};
const assertEquals = (a: unknown, b: unknown, msg?: string) => {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(msg ? `${msg}: ${sa} !== ${sb}` : `${sa} !== ${sb}`);
};

Deno.test("clearSoleProprietorStepNote: the four step notes clear; every other note, and no note, gives {}", () => {
  const CLEARED = { needs_attention: false, attention_note: null };
  const STEP = [SOLE_PROP_OFF_NOTE, SOLE_PROP_NOT_STARTER_NOTE, SOLE_PROP_NO_USE_CASE_NOTE, SOLE_PROP_LATE_NOTE];
  assertEquals([...SOLE_PROP_STEP_NOTES].sort(), [...STEP].sort(), "exactly those four");
  for (const n of STEP) {
    assertEquals(clearSoleProprietorStepNote(n), CLEARED, n.slice(0, 40));
    assert(isSoleProprietorStepNote(n), n.slice(0, 40));
  }
  for (const n of [
    SOLE_PROP_TRUST_PRODUCT_NOTE, SOLE_PROP_EXPIRED_NOTE,
    soleProprietorBrandNote([{ error_code: 30701 }], "fb"), soleProprietorBrandNote([{ error_code: 30791 }], "fb"),
    soleProprietorCampaignNote([{ error_code: 30903 }], "fb"),
    "The carriers rejected this registration.", "The carriers suspended this brand. Only Twilio support can lift it.",
    "The carriers turned down the way this campaign describes its texting. Fix the wording and send it again — resending costs nothing.",
    " " + SOLE_PROP_OFF_NOTE, SOLE_PROP_OFF_NOTE.slice(0, -1), "", null, undefined, 0, {}, [SOLE_PROP_OFF_NOTE],
  ]) {
    assertEquals(clearSoleProprietorStepNote(n), {}, String(n).slice(0, 50));
    assert(!isSoleProprietorStepNote(n), String(n).slice(0, 50));
  }
  // A spread of the "nothing" answer leaves an update object exactly as it was.
  const patch = { status: "brand_approved", next_poll_at: "later" };
  assertEquals({ ...patch, ...clearSoleProprietorStepNote("An operator's own note.") }, patch);
  // The list cannot be changed at runtime.
  assert(Object.isFrozen(SOLE_PROP_STEP_NOTES));
});

Deno.test("brandEventErrors: Event Streams' brand errors in the portal's shape", () => {
  // Twilio's A2P.BrandRegistrationFailure example payload's entry, with made-up values.
  assertEquals(brandEventErrors([{
    registrationerrorcode: 30701, registrationerrordescription: " Brand Registration Failure: Invalid input parameters ",
    registrationerrorurl: "https://example.test/errors/30701", registrationerrorfields: ["street", "postal_code"],
  }]), [{ error_code: 30701, description: "Brand Registration Failure: Invalid input parameters", fields: ["street", "postal_code"] }]);
  // camelCase spellings, a string code, no fields.
  assertEquals(brandEventErrors([{ registrationErrorCode: "30793", registrationErrorDescription: "Bundles swapped" }]),
    [{ error_code: 30793, description: "Bundles swapped", fields: [] }]);
  // Already REST-shaped (as the poll stores it): passed through.
  assertEquals(brandEventErrors([{ error_code: 30791, description: "Temporary", fields: ["x"] }]), [{ error_code: 30791, description: "Temporary", fields: ["x"] }]);
  // No usable code: kept with error_code null, so the portal shows the description.
  assertEquals(brandEventErrors([{ registrationerrordescription: "Something" }, { registrationerrorcode: "abc" }]),
    [{ error_code: null, description: "Something", fields: [] }, { error_code: null, description: "", fields: [] }]);
  // Junk entries dropped; an empty list is an empty list (the event said "no errors").
  assertEquals(brandEventErrors([null, "x", 7, { registrationerrorcode: 21736 }]), [{ error_code: 21736, description: "", fields: [] }]);
  assertEquals(brandEventErrors([]), []);
  // Not a list at all: null, and the caller writes nothing.
  for (const v of [undefined, null, "30701", { registrationerrorcode: 30701 }, 30701]) assertEquals(brandEventErrors(v), null, String(v));
  // Capped.
  assertEquals(brandEventErrors(Array.from({ length: 50 }, (_, i) => ({ registrationerrorcode: 30000 + i })))!.length, 20);
  // The note mapping reads the mapped list the same as the raw one.
  const raw = [{ registrationerrorcode: 30701 }];
  assertEquals(soleProprietorBrandNote(brandEventErrors(raw), "fb"), soleProprietorBrandNote(raw, "fb"));
  assert(soleProprietorBrandNote(brandEventErrors(raw), "fb") !== "fb");
});

Deno.test("the code sentences: first code with one wins, else the fallback; codes from either vocabulary", () => {
  assertEquals(errorCodesOf([{ error_code: 21736 }, { registrationerrorcode: 30791 }, { code: "30701" }, { error_code: 30791 }]), [21736, 30791, 30701]);
  assertEquals(errorCodesOf(null), []);
  const fb = "The carriers rejected this registration.";
  assertEquals(soleProprietorBrandNote([{ error_code: 21736 }], fb), fb);
  assertEquals(soleProprietorBrandNote(null, fb), fb);
  assert(/Press Resubmit/.test(soleProprietorBrandNote([{ error_code: 21736 }, { registrationerrorcode: 30791 }], fb)));
  assert(/own first and last name/.test(soleProprietorCampaignNote([{ error_code: 30914 }], fb)));
  assertEquals(soleProprietorCampaignNote([{ error_code: 30701 }], fb), fb, "a brand code is not a campaign sentence");
  for (const n of [SOLE_PROP_OFF_NOTE, SOLE_PROP_NOT_STARTER_NOTE, SOLE_PROP_TRUST_PRODUCT_NOTE, SOLE_PROP_NO_USE_CASE_NOTE, SOLE_PROP_LATE_NOTE, SOLE_PROP_EXPIRED_NOTE]) {
    assert(!/\d{5}/.test(n) && n.length > 40, n.slice(0, 40));
  }
});
