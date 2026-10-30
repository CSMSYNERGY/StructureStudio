// The "Full chat" link on a Support ticket (Carolyn, 10-29 call): a ticket handed off from the
// assistant carries its last 6 messages as a note, and this link opens the whole conversation in the
// Admin console's Support chats tab (admin-catalog support_chat_get, operators only).
//
// The tab reads `?chat=<id>` and needs nothing else: support_chat_get takes the chat id alone and reads
// the builder from the chat itself (admin-catalog/supportChats.ts). So the link carries no client id.
//
// ABSOLUTE, on a fixed host. The reader is an operator, not the builder, so the builder's host
// (customerPortalUrl.ts hostFor) is the wrong one; and the Projects cell editor puts https:// in front
// of anything without a scheme, so a relative /console/... would break.
//
// ⚠️ BETA HOST until production serves /console/chats (it 404s on app. as of 10-30). Flip this to
// https://app.structurestudiosuite.com once main has the Support chats tab, and redeploy portal-feedback.
// Links already stored keep working: beta is a permanent host on the same database.
//
// No imports, so the wiring test loads it without loading an index.ts.

export const SUPPORT_CHAT_ORIGIN = "https://beta.structurestudiosuite.com";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The console address of one support chat, or null for anything that is not a chat id (a uuid). */
export function supportChatUrl(id: unknown): string | null {
  if (typeof id !== "string" || !UUID.test(id)) return null;
  return `${SUPPORT_CHAT_ORIGIN}/console/chats?chat=${id.toLowerCase()}`;
}
