"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/components/ActionForm";
import { requireStaff, type Staff } from "@/lib/auth/session";
import { db, schema } from "@/lib/db";
import { SEGMENTS, TICKET_PRIORITIES, TICKET_STATUSES, type Segment, type TicketPriority, type TicketStatus } from "@/lib/db/schema";
import { CATEGORIES, ref } from "@/lib/tickets/format";
import { assignableStaff, getTicketByNumber } from "@/lib/tickets/queries";
import { addStaffMessage, createTicket, deliverStaffMessage, updateTicket, type TicketChanges } from "@/lib/tickets/service";

const str = (d: FormData, k: string) => String(d.get(k) ?? "").trim();
const oneOf = <T extends string>(v: string, list: readonly T[]): T | undefined => (list as readonly string[]).includes(v) ? (v as T) : undefined;
const actor = (s: Staff) => ({ id: s.id, label: s.name });

/** Loads a ticket and checks the person may act on it in its segment. */
async function ticketFor(number: number, staff: Staff, permission: Parameters<Staff["can"]>[0]) {
  const row = await getTicketByNumber(number);
  if (!row || !staff.can("tickets.view", row.ticket.segment)) return null;
  if (!staff.can(permission, row.ticket.segment)) return "forbidden" as const;
  return row.ticket;
}

export async function replyToTicket(_: ActionState, data: FormData): Promise<ActionState> {
  const staff = await requireStaff();
  const number = Number(data.get("number"));
  const internal = data.get("intent") === "note";
  const ticket = await ticketFor(number, staff, internal ? "tickets.note" : "tickets.reply");
  if (!ticket) return { error: "That ticket doesn't exist." };
  if (ticket === "forbidden") return { error: internal ? "Your role can't add notes to this ticket." : "Your role can't reply to this ticket." };
  const body = str(data, "body");
  if (!body) return { error: internal ? "Write the note first." : "Write the reply first." };
  if (body.length > 20000) return { error: "That's too long for one message (20,000 characters)." };
  const statusAfter = internal ? undefined : oneOf(str(data, "statusAfter"), TICKET_STATUSES);
  if (statusAfter && !staff.can("tickets.update", ticket.segment)) return { error: "Your role can't change the status." };
  const { emailError } = await addStaffMessage(ticket, { body, internal, statusAfter }, actor(staff));
  revalidatePath(`/admin/tickets/${number}`);
  if (emailError) return { error: `Saved to the ticket, but the email wasn't sent: ${emailError}`, done: Date.now() };
  return { notice: internal ? "Note added." : "Reply sent.", done: Date.now() };
}

export async function retryEmail(_: ActionState, data: FormData): Promise<ActionState> {
  const staff = await requireStaff();
  const number = Number(data.get("number"));
  const ticket = await ticketFor(number, staff, "tickets.reply");
  if (!ticket || ticket === "forbidden") return { error: "You can't send this email." };
  const [message] = await db().select().from(schema.ticketMessages).where(eq(schema.ticketMessages.id, str(data, "messageId")));
  if (!message || message.ticketId !== ticket.id || message.emailStatus !== "failed") return { error: "There's nothing to resend." };
  const error = await deliverStaffMessage(ticket, message);
  revalidatePath(`/admin/tickets/${number}`);
  return error ? { error: `Still not sent: ${error}` } : { notice: "Email sent." };
}

export async function updateTicketDetails(_: ActionState, data: FormData): Promise<ActionState> {
  const staff = await requireStaff();
  const number = Number(data.get("number"));
  const ticket = await ticketFor(number, staff, "tickets.update");
  if (!ticket) return { error: "That ticket doesn't exist." };
  if (ticket === "forbidden") return { error: "Your role can't change this ticket." };
  // Each field carries the value the form was loaded with ("was:<field>"). Only fields the person
  // changed are applied, so a stale form can't undo someone else's change made in the meantime.
  const changed = (k: string) => data.has(k) && str(data, k) !== str(data, `was:${k}`);
  const changes: TicketChanges = {};
  if (changed("status")) changes.status = oneOf(str(data, "status"), TICKET_STATUSES);
  if (changed("priority")) changes.priority = oneOf(str(data, "priority"), TICKET_PRIORITIES);
  if (changed("category")) changes.category = oneOf(str(data, "category"), CATEGORIES) ?? null;
  if (changed("productModel")) changes.productModel = str(data, "productModel").slice(0, 120) || null;
  if (changed("frameNumber")) changes.frameNumber = str(data, "frameNumber").slice(0, 60) || null;
  if (changed("purchaseDate")) changes.purchaseDate = /^\d{4}-\d{2}-\d{2}$/.test(str(data, "purchaseDate")) ? str(data, "purchaseDate") : null;
  const segment = changed("segment") ? oneOf(str(data, "segment"), SEGMENTS) : undefined;
  if (segment && segment !== ticket.segment) {
    if (!staff.can("tickets.update", segment)) return { error: `Your role can't move tickets to ${segment.toUpperCase()}.` };
    changes.segment = segment;
  }
  const people = await assignableStaff(changes.segment ?? ticket.segment);
  if (changed("assigneeId")) {
    const assignee = str(data, "assigneeId");
    if (!staff.can("tickets.assign", ticket.segment)) return { error: "Your role can't assign tickets." };
    if (assignee && !people.some((p) => p.id === assignee)) return { error: "That person can't take tickets in this segment." };
    changes.assigneeId = assignee || null;
  }
  const names = new Map(people.map((p) => [p.id, p.name]));
  if (ticket.assigneeId && !names.has(ticket.assigneeId)) {
    const [prev] = await db().select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, ticket.assigneeId));
    if (prev) names.set(ticket.assigneeId, prev.name);
  }
  await updateTicket(ticket, changes, actor(staff), (id) => (id ? (names.get(id) ?? "Someone") : ""));
  revalidatePath(`/admin/tickets/${number}`);
  return { notice: "Saved." };
}

export async function assignToMe(data: FormData): Promise<void> {
  const staff = await requireStaff();
  const number = Number(data.get("number"));
  const ticket = await ticketFor(number, staff, "tickets.assign");
  if (ticket && ticket !== "forbidden" && staff.can("tickets.reply", ticket.segment)) {
    await updateTicket(ticket, { assigneeId: staff.id, ...(ticket.status === "new" ? { status: "open" as TicketStatus } : {}) }, actor(staff), (id) =>
      id === staff.id ? staff.name : "Someone",
    );
  }
  revalidatePath(`/admin/tickets/${number}`);
}

export async function createTicketAction(_: ActionState, data: FormData): Promise<ActionState> {
  const staff = await requireStaff();
  const segment = oneOf(str(data, "segment"), SEGMENTS) as Segment | undefined;
  if (!segment) return { error: "Choose B2C or B2B." };
  if (!staff.can("tickets.create", segment)) return { error: `Your role can't create ${segment.toUpperCase()} tickets.` };
  const email = str(data, "email").toLowerCase();
  const name = str(data, "name");
  const subject = str(data, "subject");
  const body = str(data, "body");
  if (!email && !name) return { error: "Enter the customer's email or name." };
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: "That email address doesn't look right." };
  if (!subject) return { error: "Enter a subject." };
  if (!body) return { error: "Describe the enquiry." };
  const ticket = await createTicket(
    {
      segment,
      subject,
      body,
      source: "staff",
      category: oneOf(str(data, "category"), CATEGORIES) ?? null,
      priority: (oneOf(str(data, "priority"), TICKET_PRIORITIES) as TicketPriority | undefined) ?? "normal",
      contact: { email: email || null, name, phone: str(data, "phone") || null, companyName: str(data, "company") || null },
      productModel: str(data, "productModel") || null,
      frameNumber: str(data, "frameNumber") || null,
      firstMessageFrom: "customer",
      firstMessageAuthor: `${name || email} (logged by ${staff.name})`,
      channel: "staff",
      assigneeId: staff.can("tickets.reply", segment) ? staff.id : null,
    },
    actor(staff),
  );
  redirect(`/admin/tickets/${ticket.number}?created=${encodeURIComponent(ref(ticket.number))}`);
}
