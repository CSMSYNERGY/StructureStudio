// Unit tests for _shared/crmPipelines.ts (migration 301). Self-contained: no registry imports.
import {
  parseDay, parseDealPatch, parseInstant, parseLead, parseMoneyCents, parsePipelineSave,
  parseStageOrder, parseStageSave, stageSetRefusal,
} from "./crmPipelines.ts";

function eq(a: unknown, b: unknown, msg: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

const U = "11111111-2222-4333-8444-555555555555";

Deno.test("money: dollars to cents, blanks clear, junk refused", () => {
  eq(parseMoneyCents("$12,500"), 1250000, "formatted");
  eq(parseMoneyCents("99.5"), 9950, "one decimal");
  eq(parseMoneyCents(40), 4000, "number");
  eq(parseMoneyCents(""), null, "blank");
  eq(parseMoneyCents(undefined), undefined, "absent");
  eq(parseMoneyCents("-5"), "bad", "negative");
  eq(parseMoneyCents("12.345"), "bad", "three decimals");
  eq(parseMoneyCents("ten"), "bad", "words");
});

Deno.test("dates: day and instant", () => {
  eq(parseDay("2026-11-02"), "2026-11-02", "day");
  eq(parseDay("11/02/2026"), "bad", "US form refused");
  eq(parseDay(""), null, "clear");
  eq(parseInstant("2026-11-02T15:00:00Z"), "2026-11-02T15:00:00.000Z", "instant");
  eq(parseInstant("soon"), "bad", "junk");
});

Deno.test("lead: needs a name or company AND a phone or email", () => {
  eq(parseLead({ phone: "555-0100" }).ok, false, "no name");
  eq(parseLead({ company: "Acme Barns" }).ok, false, "no channel");
  const ok = parseLead({ company: " Acme Barns ", phone: "(816) 555-0100", stageId: U.toUpperCase(), value: "$2,500" });
  if (!ok.ok) throw new Error("valid lead refused: " + ok.error);
  eq([ok.company, ok.name, ok.stageId, ok.valueCents], ["Acme Barns", null, U, 250000], "fields");
  eq(parseLead({ name: "Pat", phone: "12" }).ok, false, "short phone");
  eq(parseLead({ name: "Pat", email: "pat@" }).ok, false, "bad email");
  eq(parseLead({ name: "Pat", email: "pat@acme.com", ownerUserId: "bob" }).ok, false, "bad owner");
  eq(parseLead({ name: "Pat", email: "pat@acme.com", value: "lots" }).ok, false, "bad value");
});

Deno.test("deal patch: only present fields, nothing refused", () => {
  eq(parseDealPatch({}).ok, false, "empty");
  const p = parseDealPatch({ value: "", expectedCloseDate: "2026-12-01" });
  if (!p.ok) throw new Error(p.error);
  eq(p.patch, { value_cents: null, expected_close_date: "2026-12-01" }, "patch");
  eq(parseDealPatch({ nextFollowUpAt: "nope" }).ok, false, "bad follow-up");
});

Deno.test("pipeline and stage saves", () => {
  eq(parsePipelineSave({}).ok, false, "new needs a name");
  const p = parsePipelineSave({ name: "Dealers", lostReasons: ["Price", "price", " ", "Timing"] });
  if (!p.ok) throw new Error(p.error);
  eq(p.lostReasons, ["Price", "Timing"], "deduped, blanks dropped");
  eq(parseStageSave({ name: "Call" }).ok, false, "new stage needs its pipeline");
  eq(parseStageSave({ pipelineId: U, name: "Call", kind: "maybe" }).ok, false, "bad kind");
  eq(parseStageSave({ pipelineId: U, name: "Call", color: "red" }).ok, false, "bad colour");
  eq(parseStageSave({ id: U, color: "#AABBCC" }).ok, true, "edit colour only");
});

Deno.test("stage order: every id once", () => {
  eq(parseStageOrder({ pipelineId: U, ids: [U, U] }).ok, false, "duplicate");
  eq(parseStageOrder({ pipelineId: U, ids: [U] }).ok, true, "one");
});

Deno.test("a pipeline keeps an open stage", () => {
  eq(stageSetRefusal(["won", "lost"]) !== null, true, "no open stage refused");
  eq(stageSetRefusal(["open"]), null, "one open is enough");
});
