import "server-only";
import { log } from "../logger";
import { getSettings } from "../settings";
import { ref } from "../tickets/format";
import type { Ticket } from "../tickets/service";
import { mailboxKey, replyToAddress } from "./addresses";
import { EmailNotConfiguredError, sendEmail } from "./postmark";

/**
 * "We've got your request": the reference, what happens next and a copy of
 * what they sent. Replies thread onto the ticket. A failure is logged, never
 * shown to the customer (their ticket exists either way).
 */
export async function sendAcknowledgement(ticket: Ticket, to: { name: string; email: string }, details: string, attachments: number) {
  const s = await getSettings(["email.from_address", "email.from_name", "email.inbound_address"]);
  if (!s["email.from_address"]) return;
  const reference = ref(ticket.number);
  const firstName = to.name.trim().split(/\s+/)[0] || "there";
  const files = attachments ? `\n\nWe received ${attachments} file${attachments === 1 ? "" : "s"} with it.` : "";
  try {
    await sendEmail({
      from: `${s["email.from_name"]} <${s["email.from_address"]}>`,
      to: `${to.name.replace(/[<>",]/g, "")} <${to.email}>`,
      subject: `[${reference}] We've got your request: ${ticket.subject}`,
      text: `Hi ${firstName},\n\nThanks for getting in touch. Your reference is ${reference}. One of the team will reply by email, usually within two working days.\n\nIf you've more to add, such as photos or your frame number, just reply to this email.${files}\n\nWhat you sent us:\n\n${details}\n\nWhyte Bikes Support`,
      replyTo: s["email.inbound_address"] ? replyToAddress(s["email.inbound_address"], mailboxKey(ticket.number, ticket.replyToken)) : undefined,
      tag: "ticket-acknowledgement",
    });
  } catch (err) {
    if (!(err instanceof EmailNotConfiguredError)) log.warn("Acknowledgement email failed", { err, ticket: ticket.number });
  }
}
