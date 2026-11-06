// A Projects item's status, as a builder sees it. Shared by portal-projects (an operator sets a
// status) and release-ci (a commit lands on beta, or is promoted), so the one rule that reaches a
// builder's screen lives in one place and cannot drift between the two.
//
// Moved here from portal-projects/index.ts on 2026-10-09 (Workstream 4, B1). portal-projects keeps
// a thin wrapper that binds its own service-role client and activity logger;
// _test_stubs/releaseCiWiring_test.ts fails if a local copy of the body comes back.
//
// THE RULE (unchanged from portal-projects, migration 144's design note):
//   * A status label MAY carry `client_status`, one of feedback_submissions' 8 states (054).
//   * Changing a LINKED item (feedback_submission_id set) to such a label updates the tenant-facing
//     mirror row; a label without one is pure-internal and touches nothing tenant-side.
//   * An UNLINKED item returns at once: no mirror write and no activity row from here (the
//     original behaviour, kept; release-ci records its own activity for the items it moves).
//   * A linked item's change is written to pm_activity through the caller's `act`: "client_status"
//     when the mirror moved, "status" when the label is internal-only.
//
// Self-contained on purpose (no jsr:/npm: imports): pmStatus.test.ts runs it against a fake client
// in preflight's dependency-free `_shared` group.

/** The tenant-facing ladder from migration 054 — the ONLY values client_status may hold. */
export const CLIENT_STATUSES = new Set([
  "submitted", "in_review", "planned", "in_progress", "needs_info", "shipped", "declined", "duplicate",
]);

/** portal-projects' best-effort pm_activity writer (or release-ci's), bound to its caller. */
export type ActFn = (
  boardId: string | null,
  itemId: string | null,
  action: string,
  detail?: Record<string, unknown>,
) => Promise<void>;

/** The slice of a supabase-js client this needs: `from("feedback_submissions").update(...).eq(...)`.
 *  Loose on purpose (internalTenant.ts's idiom), so the real client and the test fake both fit. */
export type StatusAdmin = {
  // deno-lint-ignore no-explicit-any
  from: (t: string) => any;
};

/**
 * Propagate a status change to the tenant mirror when the label maps to a client status and the
 * item is linked to a feedback submission. Throws the database error if the mirror write fails,
 * so the caller's request fails rather than reporting a status the builder never sees.
 */
export async function propagateStatus(
  admin: StatusAdmin,
  act: ActFn,
  // deno-lint-ignore no-explicit-any
  item: any,
  // deno-lint-ignore no-explicit-any
  columns: any[],
  newValues: Record<string, unknown>,
  oldValues: Record<string, unknown>,
): Promise<void> {
  if (!item.feedback_submission_id) return;
  for (const col of columns) {
    if (col.type !== "status" || !(col.id in newValues)) continue;
    if (newValues[col.id] === oldValues?.[col.id]) continue;
    // deno-lint-ignore no-explicit-any
    const label = (col.settings?.labels || []).find((l: any) => l.id === newValues[col.id]);
    if (!label) continue;
    if (label.client_status && CLIENT_STATUSES.has(label.client_status)) {
      const { error } = await admin.from("feedback_submissions")
        .update({ status: label.client_status, status_changed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", item.feedback_submission_id);
      if (error) throw error;
      await act(item.board_id, item.id, "client_status", { to: label.client_status, label: label.label });
    } else {
      await act(item.board_id, item.id, "status", { label: label.label });
    }
  }
}
