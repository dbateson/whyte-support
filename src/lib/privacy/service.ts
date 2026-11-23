import "server-only";
import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, schema } from "../db";
import { log } from "../logger";
import { getSettings } from "../settings";
import { objectStore } from "../storage";
import { ref } from "../tickets/format";
import { zoho, zohoConnected } from "../zoho/client";
import { syncEnabled } from "../zoho/push";

/**
 * UK GDPR: find everything held about a person, export it (right of access
 * and portability), and erase it (right to erasure). Erasing keeps each
 * ticket's shape for statistics (dates, category, segment, status) and
 * removes everything personal: names, addresses, message text, files and
 * linked chats. Zoho holds its own copy: a task is created there for
 * someone to erase it, because Zoho owns that record.
 */

export interface Actor {
  id?: string;
  label: string;
}

export const ERASED = "[Erased on request]";
const ERASED_RETENTION = "[Erased: retention period ended]";

/** A hash of the email, kept in the audit log to show a request was handled without keeping the address. */
export const emailFingerprint = (email: string) => createHash("sha256").update(`gdpr:${email.trim().toLowerCase()}`).digest("hex").slice(0, 16);

export async function findSubject(email: string) {
  const clean = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(clean)) return null;
  const [contact] = await db().select().from(schema.contacts).where(eq(schema.contacts.email, clean));
  if (!contact) return null;
  const tickets = await db()
    .select({ id: schema.tickets.id, number: schema.tickets.number, subject: schema.tickets.subject, status: schema.tickets.status, createdAt: schema.tickets.createdAt, erasedAt: schema.tickets.erasedAt, zohoCaseNumber: schema.tickets.zohoCaseNumber })
    .from(schema.tickets)
    .where(eq(schema.tickets.contactId, contact.id))
    .orderBy(asc(schema.tickets.createdAt));
  return { contact, tickets };
}

/** Everything held about a contact, as JSON: their details, every ticket and message, file names, and chats that became tickets. */
export async function exportSubject(contactId: string, actor: Actor) {
  const [contact] = await db().select().from(schema.contacts).where(eq(schema.contacts.id, contactId));
  if (!contact) return null;
  const tickets = await db().select().from(schema.tickets).where(eq(schema.tickets.contactId, contactId)).orderBy(asc(schema.tickets.createdAt));
  const ids = tickets.map((t) => t.id);
  const [messages, files, chats] = ids.length
    ? await Promise.all([
        db().select().from(schema.ticketMessages).where(inArray(schema.ticketMessages.ticketId, ids)).orderBy(asc(schema.ticketMessages.createdAt)),
        db()
          .select({ ticketId: schema.ticketAttachments.ticketId, fileName: schema.ticketAttachments.fileName, contentType: schema.ticketAttachments.contentType, sizeBytes: schema.ticketAttachments.sizeBytes })
          .from(schema.ticketAttachments)
          .where(and(inArray(schema.ticketAttachments.ticketId, ids), eq(schema.ticketAttachments.status, "attached"))),
        db()
          .select({ ticketId: schema.chatSessions.ticketId, createdAt: schema.chatSessions.createdAt, role: schema.chatMessages.role, content: schema.chatMessages.content, at: schema.chatMessages.createdAt })
          .from(schema.chatSessions)
          .innerJoin(schema.chatMessages, eq(schema.chatMessages.sessionId, schema.chatSessions.id))
          .where(inArray(schema.chatSessions.ticketId, ids))
          .orderBy(asc(schema.chatMessages.createdAt)),
      ])
    : [[], [], []];
  await db()
    .insert(schema.auditLog)
    .values({ actorId: actor.id ?? null, actorLabel: actor.label, action: "gdpr.export", target: contactId, detail: { tickets: tickets.length, fingerprint: contact.email ? emailFingerprint(contact.email) : null } });
  return {
    exportedAt: new Date().toISOString(),
    exportedBy: "Whyte Bikes support",
    note: "Messages marked internal are staff notes. Review them before sending: some may be exempt (for example, legal advice). Attached files are listed by name; send copies separately.",
    person: {
      name: contact.name,
      email: contact.email,
      phone: contact.phone,
      business: contact.companyName,
      accountNumber: contact.accountCode,
      customerType: contact.segment === "b2b" ? "Dealer or trade" : "Rider",
      firstContact: contact.createdAt.toISOString(),
      zohoContactId: contact.zohoContactId,
    },
    tickets: tickets.map((t) => ({
      reference: ref(t.number),
      created: t.createdAt.toISOString(),
      status: t.status,
      category: t.category,
      subject: t.subject,
      bike: t.productModel,
      frameNumber: t.frameNumber,
      purchaseDate: t.purchaseDate,
      boughtFrom: t.purchasedFrom,
      orderNumber: t.orderNumber,
      zohoCase: t.zohoCaseNumber,
      messages: messages
        .filter((m) => m.ticketId === t.id)
        .map((m) => ({ at: m.createdAt.toISOString(), from: m.authorType === "customer" ? "You" : m.authorName || "Whyte Bikes", internal: m.internal, body: m.body })),
      files: files.filter((f) => f.ticketId === t.id).map((f) => ({ name: f.fileName, type: f.contentType, bytes: f.sizeBytes })),
      chat: chats.filter((c) => c.ticketId === t.id).map((c) => ({ at: c.at.toISOString(), from: c.role === "user" ? "You" : "Assistant", text: c.content })),
    })),
  };
}

/** Removes a set of tickets' personal content. Files are deleted from storage first. */
async function eraseTickets(ticketIds: string[], origin: string, label: string) {
  if (ticketIds.length === 0) return { files: 0 };
  const files = await db().select({ id: schema.ticketAttachments.id, key: schema.ticketAttachments.storageKey }).from(schema.ticketAttachments).where(inArray(schema.ticketAttachments.ticketId, ticketIds));
  if (files.length) {
    const store = await objectStore(origin);
    for (let i = 0; i < files.length; i += 100) await store.remove(files.slice(i, i + 100).map((f) => f.key));
  }
  await db().transaction(async (tx) => {
    if (files.length) await tx.delete(schema.ticketAttachments).where(inArray(schema.ticketAttachments.id, files.map((f) => f.id)));
    await tx
      .update(schema.ticketMessages)
      .set({ body: label, authorName: sql`case when ${schema.ticketMessages.authorType} = 'customer' then '' else ${schema.ticketMessages.authorName} end`, emailMessageId: null, emailError: null })
      .where(inArray(schema.ticketMessages.ticketId, ticketIds));
    // Chats that became these tickets: the transcript is the person's words.
    await tx.delete(schema.chatSessions).where(inArray(schema.chatSessions.ticketId, ticketIds));
    // Last, so the search index (rebuilt by a trigger) no longer holds the old words.
    await tx
      .update(schema.tickets)
      .set({ subject: label, frameNumber: null, orderNumber: null, purchaseDate: null, purchasedFrom: null, erasedAt: new Date(), updatedAt: new Date() })
      .where(inArray(schema.tickets.id, ticketIds));
  });
  return { files: files.length };
}

function blankContact() {
  return { name: "", email: null, phone: null, companyName: null, accountCode: null, shopifyCustomerId: null, anonymisedAt: new Date(), updatedAt: new Date() };
}

export interface EraseResult {
  tickets: number;
  files: number;
  zoho: "task" | "not-linked" | "not-connected" | "failed";
  zohoCases: string[];
}

export async function eraseSubject(contactId: string, actor: Actor, origin: string, opts: { askZoho: boolean }): Promise<EraseResult | null> {
  const [contact] = await db().select().from(schema.contacts).where(eq(schema.contacts.id, contactId));
  if (!contact || contact.anonymisedAt) return null;
  const tickets = await db().select({ id: schema.tickets.id, number: schema.tickets.number, zohoCaseNumber: schema.tickets.zohoCaseNumber }).from(schema.tickets).where(eq(schema.tickets.contactId, contactId));
  const { files } = await eraseTickets(tickets.map((t) => t.id), origin, ERASED);
  await db().update(schema.contacts).set(blankContact()).where(eq(schema.contacts.id, contactId));

  const zohoCases = tickets.map((t) => t.zohoCaseNumber).filter((n): n is string => Boolean(n));
  let zohoOutcome: EraseResult["zoho"] = "not-linked";
  if (opts.askZoho && (contact.zohoContactId || zohoCases.length)) {
    if (!(await zohoConnected()) || !(await syncEnabled())) zohoOutcome = "not-connected";
    else {
      try {
        const due = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
        await zoho("POST", "/Tasks", {
          body: {
            data: [
              {
                Subject: "Erase personal data (UK GDPR request)",
                Due_Date: due,
                Priority: "High",
                ...(contact.zohoContactId ? { Who_Id: { id: contact.zohoContactId } } : {}),
                Description: `A customer asked for their personal data to be erased. It has been erased in the support app. Please erase this contact${zohoCases.length ? ` and the personal details in cases ${zohoCases.join(", ")}` : ""} in Zoho, within the one-month deadline.`,
              },
            ],
            trigger: [],
          },
        });
        zohoOutcome = "task";
      } catch (err) {
        log.warn("Couldn't create the Zoho erasure task", { err });
        zohoOutcome = "failed";
      }
    }
  }
  await db()
    .insert(schema.auditLog)
    .values({
      actorId: actor.id ?? null,
      actorLabel: actor.label,
      action: "gdpr.erase",
      target: contactId,
      detail: { tickets: tickets.map((t) => ref(t.number)), files, zoho: zohoOutcome, fingerprint: contact.email ? emailFingerprint(contact.email) : null },
    });
  return { tickets: tickets.length, files, zoho: zohoOutcome, zohoCases };
}

/**
 * Retention (nightly): a closed or resolved ticket's content is erased once
 * the retention period has passed since it was last touched; a contact with
 * nothing left but erased tickets, and no recent contact, is blanked too.
 */
export async function retentionSweep(origin: string, limit = 500): Promise<{ tickets: number; contacts: number }> {
  const years = Math.max(1, Number((await getSettings(["retention.ticket_years"]))["retention.ticket_years"]) || 6);
  const due = await db()
    .select({ id: schema.tickets.id })
    .from(schema.tickets)
    .where(and(isNull(schema.tickets.erasedAt), inArray(schema.tickets.status, ["resolved", "closed"]), sql`${schema.tickets.updatedAt} < now() - make_interval(years => ${years})`))
    .limit(limit);
  await eraseTickets(due.map((t) => t.id), origin, ERASED_RETENTION);
  const contacts = await db()
    .update(schema.contacts)
    .set(blankContact())
    .where(
      and(
        isNull(schema.contacts.anonymisedAt),
        sql`${schema.contacts.updatedAt} < now() - make_interval(years => ${years})`,
        sql`not exists (select 1 from tickets t where t.contact_id = ${schema.contacts.id} and t.erased_at is null)`,
      ),
    )
    .returning({ id: schema.contacts.id });
  if (due.length || contacts.length) {
    await db().insert(schema.auditLog).values({ actorLabel: "system", action: "gdpr.retention", detail: { tickets: due.length, contacts: contacts.length, years } });
  }
  return { tickets: due.length, contacts: contacts.length };
}

export async function recentRequests(limit = 20) {
  return db()
    .select({ id: schema.auditLog.id, at: schema.auditLog.at, actor: schema.auditLog.actorLabel, action: schema.auditLog.action, detail: schema.auditLog.detail })
    .from(schema.auditLog)
    .where(sql`${schema.auditLog.action} like 'gdpr.%'`)
    .orderBy(sql`${schema.auditLog.at} desc`)
    .limit(limit);
}
