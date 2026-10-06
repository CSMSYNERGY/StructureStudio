// emailThread.ts on its own: the HTML fallback, the body cap, the ledger statuses, the `or`
// that finds a contact's mail, and the compose decision. reads.test.ts drives them through
// GET /threads/:key.
import { describe, expect, it } from "vitest";
import {
  EMAIL_BODY_CAP, SEND_COLS, SEND_COLS_BEFORE_262, capBody, contactEmailFilter, emailAddress, emailBlock, emailSendingReady, htmlToText,
  receivedEmail, sendStatus, sentEmail,
} from "../src/emailThread";

describe("htmlToText", () => {
  it("keeps the words and the line breaks, and drops style, script, title and comments", () => {
    const html = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>Ignore me</title><style type=\"text/css\">p { color: red }</style></head>"
      + "<body><!-- tracking --><h1>Your shed</h1><p>Hi Jordan,</p><p>It ships <b>Monday</b>.<br/>Call us.</p>"
      + "<table><tr><td>Size</td><td>12x24</td></tr></table><script>steal()</script></body></html>";
    expect(htmlToText(html)).toBe("Your shed\nHi Jordan,\nIt ships Monday.\nCall us.\nSize 12x24");
  });

  it("decodes entities once: an escaped entity stays escaped", () => {
    expect(htmlToText("Tom &amp; Jerry &lt;3 &quot;hi&quot; &#39;yo&#39; &#x2019; &AMP;")).toBe("Tom & Jerry <3 \"hi\" 'yo' ’ &");
    expect(htmlToText("&amp;lt;b&amp;gt;")).toBe("&lt;b&gt;");
  });

  it("leaves what isn't an entity it knows exactly as written", () => {
    expect(htmlToText("&bogus; &constructor; &toString; &#0; &#xFFFFFFF;")).toBe("&bogus; &constructor; &toString; &#0; &#xFFFFFFF;");
  });

  it("a mail that leaves out </head> keeps its body", () => {
    expect(htmlToText("<html><head><meta charset=utf-8><body><p>Still here</p></body>")).toBe("Still here");
  });

  it("an unclosed style block or comment runs to the end, as a browser reads it", () => {
    expect(htmlToText("<p>Before</p><style>p{}<p>never shown")).toBe("Before");
    expect(htmlToText("<p>Before</p><!-- never closed <p>hidden")).toBe("Before");
  });

  it("collapses whitespace, and no more than one blank line in a row", () => {
    expect(htmlToText("  a \t\n\n\n\n  b  \r\n c&nbsp;&nbsp;d  ")).toBe("a\n\nb\nc d");
  });

  it("a stray < that starts no tag stays as text", () => {
    expect(htmlToText("1 < 2 and 3 > 2")).toBe("1 < 2 and 3 > 2");
  });

  it("malformed markup costs one pass: a long run of unclosed tags finishes at once", () => {
    const started = Date.now();
    const out = htmlToText("<a".repeat(100_000) + "<style" .repeat(20_000) + "<!--x".repeat(1));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(out.startsWith("<a<a")).toBe(true);
  });
});

describe("capBody", () => {
  it("cuts at the cap and says so; at the cap exactly, nothing is cut", () => {
    expect(capBody("x".repeat(EMAIL_BODY_CAP))).toEqual({ body: "x".repeat(EMAIL_BODY_CAP), truncated: false });
    const cut = capBody("x".repeat(EMAIL_BODY_CAP + 1));
    expect(cut.body).toHaveLength(EMAIL_BODY_CAP);
    expect(cut.truncated).toBe(true);
  });

  it("never splits an emoji in two", () => {
    const cut = capBody("x".repeat(EMAIL_BODY_CAP - 1) + "\u{1F6D6}" + "tail");
    expect(cut.body).toBe("x".repeat(EMAIL_BODY_CAP - 1));
    expect(cut.truncated).toBe(true);
  });
});

describe("sendStatus", () => {
  it("claimed is sending; sent and delivered say so; a bounce reads as not sent", () => {
    expect(["claimed", "sent", "delivered", "failed", "bounced", "weird", null].map((s) => sendStatus(s)))
      .toEqual(["sending", "sent", "delivered", "failed", "failed", null, null]);
  });

  it("opened_at makes a sent or delivered email \"opened\" (migration 262), never a bounced or failed one", () => {
    const at = "2026-10-04T14:00:00.000Z";
    expect(["claimed", "sent", "delivered", "failed", "bounced"].map((s) => sendStatus(s, at)))
      .toEqual(["sending", "opened", "opened", "failed", "failed"]);
    expect(sendStatus("sent", null)).toBe("sent");
  });
});

describe("sentEmail", () => {
  const row = {
    id: "o1", kind: "conversation", subject: "Your shed", status: "delivered", created_at: "2026-10-04T12:00:00.000Z",
    to_email: "jordan@example.test", intended_email: null, body_text: "Hi", sent_by: null, client_temp_id: null,
    delivered_at: "2026-10-04T12:00:05.000Z",
  };
  it("carries opened_at, and the status reads opened once there is one", () => {
    expect(sentEmail(row)).toMatchObject({ status: "delivered", opened_at: null });
    expect(sentEmail({ ...row, opened_at: "2026-10-04T14:00:00.000Z" })).toMatchObject({ status: "opened", opened_at: "2026-10-04T14:00:00.000Z" });
  });
  it("a read from before migration 262 has no opened_at at all and still maps", () => {
    expect(sentEmail({ ...row, status: "sent" })).toMatchObject({ status: "sent", opened_at: null });
  });
  it("a bounce is failed, even after an open", () => {
    expect(sentEmail({ ...row, status: "bounced", opened_at: "2026-10-04T14:00:00.000Z" })).toMatchObject({ status: "failed" });
  });
  it("the two column lists differ by opened_at alone", () => {
    expect(SEND_COLS.split(", ").filter((c) => !SEND_COLS_BEFORE_262.split(", ").includes(c))).toEqual(["opened_at"]);
    expect(SEND_COLS_BEFORE_262.split(", ").filter((c) => !SEND_COLS.split(", ").includes(c))).toEqual([]);
  });
});

describe("receivedEmail", () => {
  const row = { id: "i1", from_email: "jordan@example.test", from_name: null, subject: null, body_text: "Hi", received_at: "2026-10-01T00:00:00.000Z", spam_verdict: null };

  it("the sender check has three answers: confirmed, not confirmed, and nothing known", () => {
    expect(receivedEmail({ ...row, spam_verdict: "spf=pass dkim=pass dmarc=pass" }).sender_verified).toBe(true);
    expect(receivedEmail({ ...row, spam_verdict: "spf=softfail dkim=pass" }).sender_verified).toBe(false);
    expect(receivedEmail({ ...row, spam_verdict: "unreadable" }).sender_verified).toBeNull();
    expect(receivedEmail(row).sender_verified).toBeNull();
  });

  it("a missing subject is empty, and a missing name is null", () => {
    expect(receivedEmail(row)).toMatchObject({ subject: "", from: { name: null, email: "jordan@example.test" }, kind: "conversation", opened_at: null });
  });
});

describe("contactEmailFilter", () => {
  const C = "00000000-0000-4000-8000-00000000c001";
  it("quotes every code, once each, so a reserved character can't change the filter", () => {
    expect(contactEmailFilter(C, ["SS-1", "SS-1", null, "", 'a,b)"c\\'])).toBe(`contact_id.eq.${C},short_code.in.("SS-1","a,b)\\"c\\\\")`);
  });
  it("with no codes, the contact alone", () => {
    expect(contactEmailFilter(C, [])).toBe(`contact_id.eq.${C}`);
  });
});

describe("compose", () => {
  const ready = { email_provider: "resend", invoice_in_ghl: true, email_domain_status: "verified" };

  it("an address is what crm_send_email would send to, trimmed", () => {
    expect(emailAddress(" jordan@example.test ")).toBe("jordan@example.test");
    expect(emailAddress("jordan@example")).toBeNull();
    expect(emailAddress("two words@example.test")).toBeNull();
    expect(emailAddress(null)).toBeNull();
  });

  it("email is ready with a verified domain, through Structure Studio or in paperwork mode", () => {
    expect(emailSendingReady(ready)).toBe(true);
    expect(emailSendingReady({ ...ready, email_provider: "ghl", invoice_in_ghl: false })).toBe(true);
    expect(emailSendingReady({ ...ready, email_provider: "ghl" })).toBe(false);
    expect(emailSendingReady({ ...ready, email_domain_status: "pending" })).toBe(false);
    expect(emailSendingReady({ ...ready, invoice_in_ghl: null, email_provider: null })).toBe(false);
    expect(emailSendingReady(null)).toBe(false);
  });

  it("the first reason wins: no_edit, no_crm, not_set_up, no_address", () => {
    const all = { canEdit: true, crmPaid: true, settings: ready, address: "jordan@example.test" };
    expect(emailBlock(all)).toBeNull();
    expect(emailBlock({ ...all, canEdit: false, crmPaid: false, settings: null, address: null })).toBe("no_edit");
    expect(emailBlock({ ...all, crmPaid: false, settings: null, address: null })).toBe("no_crm");
    expect(emailBlock({ ...all, settings: null, address: null })).toBe("not_set_up");
    expect(emailBlock({ ...all, address: null })).toBe("no_address");
  });
});
