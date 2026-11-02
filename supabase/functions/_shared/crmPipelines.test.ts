// Unit tests for _shared/crmPipelines.ts (migration 301). Self-contained: no registry imports.
import {
  parseIdOrder, parseStatusOrder, parseStatusSave, STAGE_STATUS_LINK_RETIRED, STATUS_IS_SYSTEM_SET, statusArchiveRefusal,
  parseDay, parseDealPatch, parseInstant, parseLead, parseMoneyCents, parsePipelineSave,
  parseStageOrder, parseStageSave, stageSetRefusal,
} from "./crmPipelines.ts";

function eq(a: unknown, b: unknown, msg: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

const U2 = "00000000-0000-4000-8000-0000000000f2";
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
  // 353: a stage is a step, never an outcome. Won and Lost are no longer kinds.
  eq(parseStageSave({ pipelineId: U, name: "Call", kind: "won" }).ok, false, "won is not a kind");
  eq(parseStageSave({ pipelineId: U, name: "Call", kind: "lost" }).ok, false, "lost is not a kind");
  eq(parseStageSave({ pipelineId: U, name: "Call", kind: "open" }).ok, true, "open is the only kind");
  eq(parseStageSave({ pipelineId: U, name: "Call", color: "red" }).ok, false, "bad colour");
  eq(parseStageSave({ id: U, color: "#AABBCC" }).ok, true, "edit colour only");
});

Deno.test("a stage never carries a status (migration 303): a stale editor's link is refused, a blank one ignored", () => {
  const st = parseStageSave({ id: U, statusId: U.toUpperCase() });
  eq(st, { ok: false, error: STAGE_STATUS_LINK_RETIRED }, "a real link is refused, not dropped");
  eq(parseStageSave({ pipelineId: U, name: "Call", statusId: U }).ok, false, "a new stage with a link is refused too");
  eq(parseStageSave({ id: U, statusId: "sent" }).ok, false, "junk refused");
  for (const blank of ["", null, "  "]) {
    const cl = parseStageSave({ id: U, name: "Call", statusId: blank });
    eq(cl.ok && "statusId" in cl, false, `a blank link (${JSON.stringify(blank)}) is ignored, and nothing carries one`);
  }
  eq(/quote/i.test(STAGE_STATUS_LINK_RETIRED), false, "estimate wording");
});

Deno.test("stage order: every id once", () => {
  eq(parseStageOrder({ pipelineId: U, ids: [U, U] }).ok, false, "duplicate");
  eq(parseStageOrder({ pipelineId: U, ids: [U] }).ok, true, "one");
});

Deno.test("a pipeline keeps a stage", () => {
  eq(stageSetRefusal([]) !== null, true, "no stage at all refused");
  eq(stageSetRefusal(["open"]), null, "one is enough");
});

Deno.test("statuses: name, colour and the automatic trigger", () => {
  eq(parseStatusSave({}).ok, false, "new needs a name");
  // 354: a NEW status must say which pipeline it is a rung of — there is no tenant-wide list left.
  eq(parseStatusSave({ name: "Contact Made" }).ok, false, "a new status needs its pipeline");
  const a = parseStatusSave({ pipelineId: U2, name: "Contact Made", color: "#0EA5E9", triggerEvent: "" });
  eq(a.ok && [a.name, a.triggerEvent, a.pipelineId], ["Contact Made", null, U2], "no event yet, on its pipeline");
  // An EDIT finds the pipeline from the row, so a caller changing a name need not send one.
  eq(parseStatusSave({ id: U, name: "Renamed" }).ok, true, "editing one needs no pipeline");
  eq(parseStatusSave({ pipelineId: "not-a-uuid", name: "x" }).ok, false, "a pipeline id must look like one");
  // 353: contact being made is an event a status can be set by.
  eq(parseStatusSave({ id: U, triggerEvent: "contact_made" }).ok && true, true, "contact_made is a trigger");
  const b = parseStatusSave({ id: U, triggerEvent: "paid_in_full" });
  eq(b.ok && b.triggerEvent, "paid_in_full", "trigger");
  eq(parseStatusSave({ id: U, triggerEvent: "whenever" }).ok, false, "unknown trigger");
  eq(parseStatusSave({ pipelineId: U2, name: "x".repeat(41) }).ok, false, "too long");
  const c = parseStatusSave({ id: U, name: "New" });
  eq(c.ok && c.triggerEvent, undefined, "absent trigger means unchanged");
  eq(parseIdOrder({ ids: [U, U] }).ok, false, "duplicate");
});

// 354: a reorder is ONE pipeline's ladder, posted whole — the twin of parseStageOrder. Without the
// pipeline the posted ids are always a subset of the account's statuses and can never be checked.
Deno.test("status order: one pipeline's ids, each exactly once", () => {
  eq(parseStatusOrder({ ids: [U] }).ok, false, "needs the pipeline");
  eq(parseStatusOrder({ pipelineId: U2 }).ok, false, "needs the ids");
  eq(parseStatusOrder({ pipelineId: U2, ids: [U, U] }).ok, false, "each one once");
  eq(parseStatusOrder({ pipelineId: U2, ids: ["nope"] }).ok, false, "ids must look like ids");
  const o = parseStatusOrder({ pipelineId: U2, ids: [U] });
  eq(o.ok && [o.pipelineId, o.ids], [U2, [U]], "the pipeline and its order");
});

Deno.test("statuses are system-driven (Carolyn 2026-10-12): the sentences a person reads", () => {
  // The refusal names the events, says estimate (never quote), and never sends anyone to an owner:
  // nobody can set a status by hand, an owner included.
  eq(/by hand/.test(STATUS_IS_SYSTEM_SET) && /estimate/.test(STATUS_IS_SYSTEM_SET), true, "says why");
  eq(/quote|owner|admin/i.test(STATUS_IS_SYSTEM_SET), false, "no quote, no owner");
  eq(statusArchiveRefusal(1), "1 card has this status, so it can't be removed. Rename it or change its colour instead.", "one");
  eq(statusArchiveRefusal(3).startsWith("3 cards have this status"), true, "many");
  eq(/another status first/.test(statusArchiveRefusal(2)), false, "never asks for a hand-set");
});
