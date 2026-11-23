import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, schema, type Db } from "../db";
import type { Segment, TicketPriority, TicketSource, TicketStatus } from "../db/schema";
import { mailboxKey, messageIdFor, replyToAddress } from "../email/addresses";
import { EmailNotConfiguredError, EmailSendError, sendEmail } from "../email/postmark";
import { log } from "../logger";
import { getSettings } from "../settings";
import { PRIORITY_LABELS, ref, SEGMENT_LABELS, STATUS_LABELS } from "./format";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface Actor {
  id?: string;
  label: string;
}

export type Ticket = typeof schema.tickets.$inferSelect;
export type TicketMessage = typeof schema.ticketMessages.$inferSelect;

/** Finds a contact by email, or creates one. Fills in a missing name, phone or company. */
export async function findOrCreateContact(
  tx: Tx | Db,
  input: { email?: string | null; name?: string; phone?: string | null; segment: Segment; companyName?: string | null },
) {
  const email = input.email?.trim().toLowerCase() || null;
  if (email) {
    const [existing] = await tx.select().from(schema.contacts).where(eq(schema.contacts.email, email));
    if (existing) {
      const patch: Partial<typeof schema.contacts.$inferInsert> = {};
      if (!existing.name && input.name) patch.name = input.name;
      if (!existing.phone && input.phone) patch.phone = input.phone;
      if (!existing.companyName && input.companyName) patch.companyName = input.companyName;
      if (Object.keys(patch).length) {
        await tx.update(schema.contacts).set({ ...patch, updatedAt: new Date() }).where(eq(schema.contacts.id, existing.id));
      }
      return { ...existing, ...patch };
    }
  }
  const [created] = await tx
    .insert(schema.contacts)
    .values({ email, name: input.name ?? "", phone: input.phone ?? null, segment: input.segment, companyName: input.companyName ?? null })
    .returning();
  return created!;
}

export interface NewTicket {
  segment: Segment;
  subject: string;
  body: string;
  source: TicketSource;
  category?: string | null;
  priority?: TicketPriority;
  contact: { email?: string | null; name?: string; phone?: string | null; companyName?: string | null };
  productModel?: string | null;
  frameNumber?: string | null;
  purchaseDate?: string | null;
  assigneeId?: string | null;
  /** Who wrote the first message: the customer (form, email) or staff logging a call. */
  firstMessageFrom: "customer" | "agent";
  /** The first message's author line, when it isn't simply the contact (a call staff logged). */
  firstMessageAuthor?: string;
  channel: (typeof schema.MESSAGE_CHANNELS)[number];
  emailMessageId?: string | null;
}

export async function createTicket(input: NewTicket, actor: Actor): Promise<Ticket> {
  return db().transaction(async (tx) => {
    const contact = await findOrCreateContact(tx, { ...input.contact, segment: input.segment });
    const now = new Date();
    const [ticket] = await tx
      .insert(schema.tickets)
      .values({
        segment: input.segment,
        subject: input.subject.trim().slice(0, 300),
        source: input.source,
        category: input.category ?? null,
        priority: input.priority ?? "normal",
        contactId: contact.id,
        assigneeId: input.assigneeId ?? null,
        productModel: input.productModel ?? null,
        frameNumber: input.frameNumber ?? null,
        purchaseDate: input.purchaseDate ?? null,
        replyToken: randomBytes(12).toString("base64url"),
        lastCustomerMessageAt: input.firstMessageFrom === "customer" ? now : null,
      })
      .returning();
    await tx.insert(schema.ticketMessages).values({
      ticketId: ticket!.id,
      authorType: input.firstMessageFrom,
      authorUserId: input.firstMessageFrom === "agent" ? (actor.id ?? null) : null,
      authorName: input.firstMessageAuthor ?? (input.firstMessageFrom === "agent" ? actor.label : contact.name || contact.email || "Customer"),
      body: input.body.trim(),
      channel: input.channel,
      emailMessageId: input.emailMessageId ?? null,
    });
    await tx.insert(schema.ticketEvents).values({ ticketId: ticket!.id, actorUserId: actor.id ?? null, actorLabel: actor.label, type: "created", toValue: input.source });
    const [fresh] = await tx.select().from(schema.tickets).where(eq(schema.tickets.id, ticket!.id));
    return fresh!;
  });
}

export type TicketChanges = Partial<{
  status: TicketStatus;
  priority: TicketPriority;
  assigneeId: string | null;
  segment: Segment;
  category: string | null;
  subject: string;
  productModel: string | null;
  frameNumber: string | null;
  purchaseDate: string | null;
}>;

/** Applies changes, logs an event for each one people track, and keeps the timestamps in step. */
export async function updateTicket(ticket: Ticket, changes: TicketChanges, actor: Actor, labelForUser?: (id: string | null) => string): Promise<Ticket> {
  return db().transaction(async (tx) => {
    const set: Partial<typeof schema.tickets.$inferInsert> = {};
    const events: (typeof schema.ticketEvents.$inferInsert)[] = [];
    const event = (type: (typeof schema.ticketEvents.$inferInsert)["type"], from: string | null, to: string | null) =>
      events.push({ ticketId: ticket.id, actorUserId: actor.id ?? null, actorLabel: actor.label, type, fromValue: from, toValue: to });

    if (changes.status && changes.status !== ticket.status) {
      set.status = changes.status;
      event("status", STATUS_LABELS[ticket.status], STATUS_LABELS[changes.status]);
      if (changes.status === "resolved") set.resolvedAt = new Date();
      if (changes.status === "closed") set.closedAt = new Date();
      if (changes.status !== "resolved" && changes.status !== "closed") {
        set.resolvedAt = null;
        set.closedAt = null;
      }
    }
    if (changes.priority && changes.priority !== ticket.priority) {
      set.priority = changes.priority;
      event("priority", PRIORITY_LABELS[ticket.priority], PRIORITY_LABELS[changes.priority]);
    }
    if (changes.assigneeId !== undefined && changes.assigneeId !== ticket.assigneeId) {
      set.assigneeId = changes.assigneeId;
      const name = labelForUser ?? (() => "");
      event("assignee", ticket.assigneeId ? name(ticket.assigneeId) : null, changes.assigneeId ? name(changes.assigneeId) : null);
    }
    if (changes.segment && changes.segment !== ticket.segment) {
      set.segment = changes.segment;
      event("segment", SEGMENT_LABELS[ticket.segment], SEGMENT_LABELS[changes.segment]);
    }
    if (changes.category !== undefined && (changes.category || null) !== ticket.category) {
      set.category = changes.category || null;
      event("category", ticket.category, changes.category || null);
    }
    for (const key of ["subject", "productModel", "frameNumber", "purchaseDate"] as const) {
      if (changes[key] !== undefined && (changes[key] || null) !== ticket[key]) {
        (set as Record<string, unknown>)[key] = key === "subject" ? (changes.subject ?? ticket.subject) : changes[key] || null;
      }
    }
    if (Object.keys(set).length === 0) return ticket;
    const [updated] = await tx.update(schema.tickets).set({ ...set, updatedAt: new Date() }).where(eq(schema.tickets.id, ticket.id)).returning();
    if (events.length) await tx.insert(schema.ticketEvents).values(events);
    return updated!;
  });
}

/**
 * A staff reply or internal note. A reply is emailed to the contact (when there's
 * an address and email is set up); its delivery state is kept on the message.
 */
export async function addStaffMessage(
  ticket: Ticket,
  input: { body: string; internal: boolean; statusAfter?: TicketStatus },
  actor: Required<Actor>,
): Promise<{ message: TicketMessage; emailError?: string }> {
  const id = randomUUID();
  const outbound = !input.internal;
  const message = await db().transaction(async (tx) => {
    const [m] = await tx
      .insert(schema.ticketMessages)
      .values({
        id,
        ticketId: ticket.id,
        authorType: "agent",
        authorUserId: actor.id,
        authorName: actor.label,
        body: input.body.trim(),
        internal: input.internal,
        channel: outbound ? "email" : "staff",
        emailMessageId: outbound ? messageIdFor(ticket.number, id) : null,
        emailStatus: outbound ? "sending" : null,
      })
      .returning();
    if (outbound && !ticket.firstResponseAt) {
      await tx.update(schema.tickets).set({ firstResponseAt: new Date() }).where(eq(schema.tickets.id, ticket.id));
    }
    return m!;
  });
  if (input.statusAfter && input.statusAfter !== ticket.status) {
    await updateTicket(ticket, { status: input.statusAfter }, actor);
  }
  if (!outbound) return { message };
  const emailError = await deliverStaffMessage(ticket, message);
  return { message, emailError };
}

/** Emails a staff reply to the ticket's contact. Returns a reason on failure (stored on the message too). */
export async function deliverStaffMessage(ticket: Ticket, message: TicketMessage): Promise<string | undefined> {
  const markFailed = async (reason: string) => {
    await db().update(schema.ticketMessages).set({ emailStatus: "failed", emailError: reason }).where(eq(schema.ticketMessages.id, message.id));
    return reason;
  };
  const [contact] = ticket.contactId ? await db().select().from(schema.contacts).where(eq(schema.contacts.id, ticket.contactId)) : [];
  if (!contact?.email) return markFailed("The contact has no email address.");
  const settings = await getSettings(["email.from_address", "email.from_name", "email.inbound_address"]);
  if (!settings["email.from_address"]) return markFailed("Set the sender address in Settings → General.");
  const replyTo = settings["email.inbound_address"]
    ? replyToAddress(settings["email.inbound_address"], mailboxKey(ticket.number, ticket.replyToken))
    : undefined;
  const thread = await db()
    .select({ id: schema.ticketMessages.emailMessageId })
    .from(schema.ticketMessages)
    .where(and(eq(schema.ticketMessages.ticketId, ticket.id), sql`${schema.ticketMessages.emailMessageId} is not null`, sql`${schema.ticketMessages.id} <> ${message.id}`))
    .orderBy(schema.ticketMessages.createdAt);
  const references = thread.map((t) => t.id).filter(Boolean).join(" ");
  const lastId = thread.at(-1)?.id;
  try {
    await sendEmail({
      from: `${settings["email.from_name"]} <${settings["email.from_address"]}>`,
      to: contact.name ? `${contact.name.replace(/[<>",]/g, "")} <${contact.email}>` : contact.email,
      subject: `[${ref(ticket.number)}] ${ticket.subject}`,
      text: `${message.body}\n\n${message.authorName}\nWhyte Bikes Support\n\nReference: ${ref(ticket.number)}. Reply to this email to add to your request.`,
      replyTo,
      tag: "ticket-reply",
      headers: {
        "Message-ID": message.emailMessageId!,
        ...(lastId ? { "In-Reply-To": lastId } : {}),
        ...(references ? { References: references } : {}),
      },
    });
    await db().update(schema.ticketMessages).set({ emailStatus: "sent", emailError: null }).where(eq(schema.ticketMessages.id, message.id));
    return undefined;
  } catch (err) {
    if (err instanceof EmailNotConfiguredError || err instanceof EmailSendError) return markFailed(err.message);
    log.error("Ticket email failed", { err, ticket: ticket.number });
    return markFailed("The email couldn't be sent. Try again in a minute.");
  }
}

/** A customer's message arriving on an existing ticket (email reply now; the portal and chat later). */
export async function addCustomerMessage(
  ticket: Ticket,
  input: { body: string; authorName: string; channel: (typeof schema.MESSAGE_CHANNELS)[number]; emailMessageId?: string | null },
): Promise<TicketMessage> {
  const message = await db().transaction(async (tx) => {
    const [m] = await tx
      .insert(schema.ticketMessages)
      .values({ ticketId: ticket.id, authorType: "customer", authorName: input.authorName, body: input.body, channel: input.channel, emailMessageId: input.emailMessageId ?? null })
      .returning();
    await tx.update(schema.tickets).set({ lastCustomerMessageAt: new Date() }).where(eq(schema.tickets.id, ticket.id));
    return m!;
  });
  const system = { label: "System" };
  if (ticket.status === "resolved" || ticket.status === "closed") {
    await db().insert(schema.ticketEvents).values({ ticketId: ticket.id, actorLabel: system.label, type: "reopened", fromValue: STATUS_LABELS[ticket.status], toValue: STATUS_LABELS.open });
    await db().update(schema.tickets).set({ status: "open", resolvedAt: null, closedAt: null }).where(eq(schema.tickets.id, ticket.id));
  } else if (ticket.status === "pending_customer") {
    await updateTicket(ticket, { status: "open" }, system);
  }
  return message;
}
