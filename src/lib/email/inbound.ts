import "server-only";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db";
import { log } from "../logger";
import { addCustomerMessage, createTicket } from "../tickets/service";
import { parseMailboxKey, stripQuotedReply, ticketNumberFromMessageId } from "./addresses";

/** The fields we use from Postmark's inbound webhook. */
export interface InboundEmail {
  FromFull?: { Email?: string; Name?: string };
  From?: string;
  Subject?: string;
  TextBody?: string;
  StrippedTextReply?: string;
  MailboxHash?: string;
  MessageID?: string;
  Headers?: { Name: string; Value: string }[];
}

export type InboundResult = { outcome: "added" | "created" | "duplicate" | "ignored"; ticketNumber?: number };

const header = (e: InboundEmail, name: string) => e.Headers?.find((h) => h.Name.toLowerCase() === name.toLowerCase())?.Value;

/**
 * Files an inbound email. Matching, most to least certain: the reply-to key
 * (unguessable), our Message-ID in In-Reply-To/References, then "[WS-n]" in
 * the subject when the sender is that ticket's contact. Anything else becomes
 * a new ticket.
 */
export async function fileInboundEmail(e: InboundEmail): Promise<InboundResult> {
  const fromEmail = (e.FromFull?.Email ?? e.From ?? "").trim().toLowerCase();
  if (!fromEmail || !fromEmail.includes("@")) return { outcome: "ignored" };
  // Auto-replies and bounces would loop with our own replies.
  const auto = header(e, "Auto-Submitted");
  if ((auto && auto.toLowerCase() !== "no") || /^(mailer-daemon|postmaster|no-?reply)@/i.test(fromEmail)) return { outcome: "ignored" };

  // Only a well-formed Message-ID is kept: it's later copied into our replies' headers.
  const rawId = header(e, "Message-ID") ?? (e.MessageID ? `<${e.MessageID}@inbound>` : null);
  const messageId = rawId && /^<[^<>\s]{1,250}>$/.test(rawId.trim()) ? rawId.trim() : null;
  if (messageId) {
    const [dupe] = await db().select({ id: schema.ticketMessages.id }).from(schema.ticketMessages).where(eq(schema.ticketMessages.emailMessageId, messageId));
    if (dupe) return { outcome: "duplicate" };
  }

  const name = e.FromFull?.Name?.trim() || fromEmail;
  const full = (e.TextBody ?? "").trim();
  const reply = (e.StrippedTextReply ?? "").trim() || stripQuotedReply(full);

  const ticket = await matchTicket(e, fromEmail);
  if (ticket) {
    await addCustomerMessage(ticket, { body: reply || full || "(empty message)", authorName: name, channel: "email", emailMessageId: messageId });
    return { outcome: "added", ticketNumber: ticket.number };
  }

  const [contact] = await db().select().from(schema.contacts).where(eq(schema.contacts.email, fromEmail));
  const created = await createTicket(
    {
      segment: contact?.segment ?? "b2c",
      subject: (e.Subject ?? "").replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, "").trim() || "Email enquiry",
      body: full || "(empty message)",
      source: "email",
      contact: { email: fromEmail, name: e.FromFull?.Name?.trim() ?? "" },
      firstMessageFrom: "customer",
      channel: "email",
      emailMessageId: messageId,
    },
    { label: "Email" },
  );
  return { outcome: "created", ticketNumber: created.number };
}

async function matchTicket(e: InboundEmail, fromEmail: string) {
  const key = parseMailboxKey(e.MailboxHash);
  if (key) {
    const [t] = await db().select().from(schema.tickets).where(and(eq(schema.tickets.number, key.number), eq(schema.tickets.replyToken, key.replyToken)));
    if (t) return t;
  }
  const n = ticketNumberFromMessageId(`${header(e, "In-Reply-To") ?? ""} ${header(e, "References") ?? ""}`);
  const bySubject = /\[WS-(\d{4,9})\]/i.exec(e.Subject ?? "");
  const number = n ?? (bySubject ? Number(bySubject[1]) : null);
  if (!number) return null;
  const [row] = await db()
    .select({ ticket: schema.tickets, email: schema.contacts.email })
    .from(schema.tickets)
    .leftJoin(schema.contacts, eq(schema.contacts.id, schema.tickets.contactId))
    .where(eq(schema.tickets.number, number));
  // Headers, subjects and From can all be forged, so they only count when the sender is the
  // ticket's contact and their domain's SPF check passed (Postmark adds Received-SPF).
  const spf = header(e, "Received-SPF")?.trim().toLowerCase();
  const senderVerified = spf === undefined || spf.startsWith("pass");
  if (row && row.email?.toLowerCase() === fromEmail && senderVerified) return row.ticket;
  if (row) log.info("Inbound email referenced a ticket from a different sender; filing as new", { ticket: number });
  return null;
}
