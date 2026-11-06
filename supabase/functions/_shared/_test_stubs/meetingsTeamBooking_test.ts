// meetingsTeamBooking_test.ts — what the Meetings levels let someone do (2026-10-23).
//
// Carolyn: "I want them to be able to see the entire team and schedule with anyone." So:
//   own  — their own calendar only
//   view — sees the whole team and BOOKS (and cancels / marks / resends) with anyone
//   edit — also changes the setup: meeting types, the booking page, other people's hours
//
// The trap this pins: a gate's level also decides whether an action is a WRITE (gateIsRead,
// which lets a READ-ONLY operator through). Booking must stay a write even though 'view' may do it.
import { assert, assertEquals } from "jsr:@std/assert";
import { checkGate, gateIsRead, ownMeetingsOnly, type Gate } from "../access.ts";

const src = await Deno.readTextFile(new URL("../../portal-meetings/index.ts", import.meta.url));

const TEAM_WRITE: Gate = { any: [{ area: "meetings", level: "edit" }, { area: "meetings", level: "view" }] };
const BOOK: Gate = { all: [{ area: "meetings", level: "view" }, { area: "contacts", level: "edit" }] };

const own = { meetings: "own", contacts: "edit" } as const;
const view = { meetings: "view", contacts: "edit" } as const;
const none = { meetings: "none", contacts: "edit" } as const;

Deno.test("a View holder may book, cancel and resend; nobody without Meetings may", () => {
  assertEquals(checkGate(BOOK, view as never), null);
  assertEquals(checkGate(TEAM_WRITE, view as never), null);
  assertEquals(checkGate(TEAM_WRITE, own as never), null, "own still runs their own diary");
  assert(checkGate(TEAM_WRITE, none as never) !== null);
  assert(checkGate(BOOK, none as never) !== null);
});

Deno.test("booking stays a WRITE, so a read-only operator cannot book in a builder's name", () => {
  assertEquals(gateIsRead(TEAM_WRITE), false);
  assertEquals(gateIsRead(BOOK), false);
});

Deno.test("View is not own-only: the handler shows them the team and lets them book anyone", () => {
  assertEquals(ownMeetingsOnly(view as never), false);
  assertEquals(ownMeetingsOnly(own as never), true);
});

Deno.test("portal-meetings wires the gates that way", () => {
  for (const a of ["cancel", "set_status", "resend", "make_link"]) {
    assert(new RegExp(`\\n  ${a}:\\s+TEAM_WRITE,`).test(src), `${a} uses TEAM_WRITE`);
  }
  assert(/\n  book:\s+\{ all: \[\{ area: "meetings", level: "view" \}, \{ area: "contacts", level: "edit" \}\] \},/.test(src));
  // Setup that is not yours stays with Edit: these are narrowed to your own host below 'edit'.
  for (const a of ["save_host", "save_override", "delete_override", "set_host_types", "video_connect", "video_disconnect"]) {
    assert(src.includes(`"${a}"`) && /const PERSONAL_SETUP = new Set\(\[/.test(src), `${a} is personal setup`);
  }
  // The business's setup is Edit-only, and the screen says so.
  for (const a of ["save_settings", "save_type", "delete_type"]) {
    assert(new RegExp(`\\n  ${a}:\\s+\\{ area: "meetings", level: "edit" \\},`).test(src), `${a} needs edit`);
  }
  assert(src.includes('canManageBusiness: access.meetings === "edit"'));
});
