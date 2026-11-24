import "server-only";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { after } from "next/server";
import { db, schema } from "../db";
import { log } from "../logger";
import { getSettings } from "../settings";
import { ref } from "../tickets/format";
import { firstSuccess, zoho, ZohoError, ZohoNotConfiguredError, type WriteResult } from "./client";
import { CASE_FIELDS, hashFields, NOTE_MAX, ORIGIN, ownedCaseFields, splitName } from "./mapping";
import { logSync } from "./state";

/**
 * Sends queued changes to Zoho. The outbox is filled by a database trigger
 * (see the 0015 migration); this works through it. Each ticket becomes a
 * Case (created once, then updated only when the fields this app owns
 * change), and each message not yet in Zoho becomes a note on it.
 */

const BATCH = 20;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
/** After this many tries a change shows as failed on the health page (it keeps being retried, slowly). */
export const FAILED_AFTER = 5;

export async function syncEnabled(): Promise<boolean> {
  return (await getSettings(["zoho.sync_enabled"]))["zoho.sync_enabled"] === "true";
}

/** Runs the outbox after the response is sent, when called during a request; otherwise does nothing (the cron picks it up). */
export function kickOutbox() {
  try {
    after(async () => {
      if (await syncEnabled()) await runOutbox({ deadline: Date.now() + 20_000 }).catch((err) => log.error("Zoho outbox run failed", { err }));
    });
  } catch {
    /* not in a request: the cron will send it */
  }
}

/** Works through due changes until none are left or the deadline passes. Returns how many were sent. */
export async function runOutbox(opts: { deadline: number; limit?: number }): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  while (Date.now() < opts.deadline && sent + failed < (opts.limit ?? 500)) {
    const claimed = await claim();
    if (claimed.length === 0) break;
    for (const row of claimed) {
      if (Date.now() >= opts.deadline) {
        await release(row.id);
        continue;
      }
      try {
        if (row.entity === "ticket") await pushTicket(row.entityId);
        // Done, unless a newer change arrived while sending.
        // Compared as Postgres text: a JS Date would lose the microseconds and never match.
        await db().execute(sql`delete from sync_outbox where id = ${row.id} and changed_at <= ${row.changedAtText}::timestamptz`);
        await release(row.id);
        sent++;
      } catch (err) {
        failed++;
        await recordFailure(row, err);
        // Zoho throttling or not connected: stop this run, the rest wait for the next.
        if (err instanceof ZohoNotConfiguredError || (err instanceof ZohoError && err.code === "TOO_MANY_REQUESTS")) return { sent, failed };
      }
    }
  }
  return { sent, failed };
}

type OutboxRow = Pick<typeof schema.syncOutbox.$inferSelect, "id" | "entity" | "entityId" | "attempts"> & { changedAtText: string };

/** Takes a batch of due rows for this worker; two workers never get the same row. */
async function claim(): Promise<OutboxRow[]> {
  const rows = await db().execute(sql`
    update sync_outbox set locked_until = now() + interval '2 minutes'
    where id in (
      select id from sync_outbox
      where next_attempt_at <= now() and (locked_until is null or locked_until < now())
      order by next_attempt_at, id
      limit ${BATCH}
      for update skip locked
    )
    returning id, entity, entity_id as "entityId", attempts, changed_at::text as "changedAtText"`);
  return (rows as unknown as OutboxRow[]).map((r) => ({ ...r, id: Number(r.id) }));
}

async function release(id: number) {
  await db().update(schema.syncOutbox).set({ lockedUntil: null }).where(eq(schema.syncOutbox.id, id));
}

async function recordFailure(row: OutboxRow, err: unknown) {
  const attempts = row.attempts + 1;
  const backoff = Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** Math.min(attempts, 12));
  const message = err instanceof Error ? err.message : String(err);
  await db()
    .update(schema.syncOutbox)
    .set({ attempts, lastError: message.slice(0, 1000), nextAttemptAt: new Date(Date.now() + backoff), lockedUntil: null })
    .where(eq(schema.syncOutbox.id, row.id));
  if (attempts === 1 || attempts === FAILED_AFTER) {
    await logSync({ direction: "out", entity: row.entity, entityId: row.entityId, level: attempts >= FAILED_AFTER ? "error" : "warning", message: `Couldn't send to Zoho (attempt ${attempts}): ${message}` });
  }
  if (!(err instanceof ZohoError) && !(err instanceof ZohoNotConfiguredError)) log.error("Zoho push failed", { err, entity: row.entity, id: row.entityId });
}

/** Retry everything that's failed, now (the health page's button). */
export async function retryFailed(): Promise<number> {
  const r = await db().update(schema.syncOutbox).set({ nextAttemptAt: new Date(), lockedUntil: null }).where(sql`${schema.syncOutbox.attempts} > 0`).returning({ id: schema.syncOutbox.id });
  return r.length;
}

/* ---------- One ticket → one Case, its messages → notes ---------- */

/** Applies changes the sync makes locally without queueing them back to Zoho. */
export async function asZoho<T>(fn: (tx: Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0]) => Promise<T>): Promise<T> {
  return db().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.sync_origin', 'zoho', true)`);
    return fn(tx);
  });
}

export async function pushTicket(ticketId: string): Promise<void> {
  const [row] = await db()
    .select({ ticket: schema.tickets, contact: schema.contacts, account: schema.accounts })
    .from(schema.tickets)
    .leftJoin(schema.contacts, eq(schema.contacts.id, schema.tickets.contactId))
    .leftJoin(schema.accounts, eq(schema.accounts.id, schema.contacts.accountId))
    .where(eq(schema.tickets.id, ticketId));
  if (!row) return; // deleted since
  const { ticket, account } = row;
  let { contact } = row;

  if (contact && !contact.zohoContactId && contact.email && !contact.anonymisedAt) contact = { ...contact, zohoContactId: await ensureZohoContact(contact) };

  const s = await getSettings(["zoho.status_map", "zoho.priority_map"]);
  const owned = ownedCaseFields(ticket, { status: s["zoho.status_map"], priority: s["zoho.priority_map"] });
  const links = {
    ...(contact?.zohoContactId ? { [CASE_FIELDS.contact]: { id: contact.zohoContactId } } : {}),
    ...(account ? { [CASE_FIELDS.account]: { id: account.zohoAccountId } } : {}),
  };
  const hash = hashFields({ ...owned, ...links });
  let caseId = ticket.zohoCaseId;

  if (!caseId) {
    const [first] = await db().select().from(schema.ticketMessages).where(eq(schema.ticketMessages.ticketId, ticket.id)).orderBy(asc(schema.ticketMessages.createdAt)).limit(1);
    const details = [
      `${ref(ticket.number)} · ${ticket.segment === "b2b" ? "Dealer" : "Rider"}${ticket.category ? ` · ${ticket.category}` : ""}`,
      ticket.productModel && `Bike: ${ticket.productModel}`,
      ticket.frameNumber && `Frame number: ${ticket.frameNumber}`,
      ticket.purchaseDate && `Bought: ${ticket.purchaseDate}${ticket.purchasedFrom ? ` from ${ticket.purchasedFrom}` : ""}`,
      ticket.orderNumber && `Order: ${ticket.orderNumber}`,
    ].filter(Boolean);
    const res = await zoho<{ data: WriteResult[] }>("POST", "/Cases", {
      body: {
        data: [
          {
            ...owned,
            ...links,
            [CASE_FIELDS.origin]: ORIGIN[ticket.source],
            [CASE_FIELDS.description]: `${details.join("\n")}\n\n${first?.body ?? ""}`.slice(0, 30_000),
            ...(contact?.email && !contact.anonymisedAt ? { [CASE_FIELDS.email]: contact.email } : {}),
            ...(contact?.phone && !contact.anonymisedAt ? { [CASE_FIELDS.phone]: contact.phone } : {}),
          },
        ],
        trigger: [],
      },
    });
    caseId = firstSuccess(res, "case");
    const fetched = await zoho<{ data: { Case_Number?: string }[] }>("GET", `/Cases/${caseId}`, { query: { fields: CASE_FIELDS.number } }).catch(() => null);
    await asZoho(async (tx) => {
      await tx
        .update(schema.tickets)
        .set({ zohoCaseId: caseId, zohoCaseNumber: fetched?.data?.[0]?.Case_Number ?? null, zohoHash: hash })
        .where(eq(schema.tickets.id, ticket.id));
      // The first message went in as the Case's description, not as a note.
      if (first) await tx.update(schema.ticketMessages).set({ zohoNoteId: `case:${caseId}` }).where(eq(schema.ticketMessages.id, first.id));
    });
    await logSync({ direction: "out", entity: "ticket", entityId: ticket.id, zohoId: caseId, message: `Created case for ${ref(ticket.number)}.` });
  } else if (ticket.zohoHash !== hash) {
    const res = await zoho<{ data: WriteResult[] }>("PUT", `/Cases/${caseId}`, { body: { data: [{ ...owned, ...links }], trigger: [] } });
    firstSuccess(res, "case update");
    await asZoho((tx) => tx.update(schema.tickets).set({ zohoHash: hash }).where(eq(schema.tickets.id, ticket.id)));
    await logSync({ direction: "out", entity: "ticket", entityId: ticket.id, zohoId: caseId, message: `Updated case for ${ref(ticket.number)}.` });
  }

  await pushNotes(ticket.id, caseId);
}

const NOTE_TITLE: Record<string, (m: typeof schema.ticketMessages.$inferSelect) => string> = {
  customer: (m) => `From ${m.authorName || "the customer"}`,
  agent: (m) => (m.internal ? `Internal note: ${m.authorName}` : `Reply from ${m.authorName}`),
  assistant: () => "Support assistant",
  system: () => "Support system",
};

async function pushNotes(ticketId: string, caseId: string) {
  const pending = await db()
    .select()
    .from(schema.ticketMessages)
    .where(and(eq(schema.ticketMessages.ticketId, ticketId), isNull(schema.ticketMessages.zohoNoteId)))
    .orderBy(asc(schema.ticketMessages.createdAt))
    .limit(100);
  if (pending.length === 0) return;
  const files = await db()
    .select({ messageId: schema.ticketAttachments.messageId, fileName: schema.ticketAttachments.fileName })
    .from(schema.ticketAttachments)
    .where(and(inArray(schema.ticketAttachments.messageId, pending.map((m) => m.id)), eq(schema.ticketAttachments.status, "attached")));
  const res = await zoho<{ data: WriteResult[] }>("POST", `/Cases/${caseId}/Notes`, {
    body: {
      data: pending.map((m) => {
        const attached = files.filter((f) => f.messageId === m.id).map((f) => f.fileName);
        const body = attached.length ? `${m.body}\n\nAttachments (in the support app): ${attached.join(", ")}` : m.body;
        return { Note_Title: NOTE_TITLE[m.authorType]!(m).slice(0, 120), Note_Content: body.slice(0, NOTE_MAX) };
      }),
    },
  });
  const results = res?.data ?? [];
  let failedAt: string | null = null;
  await asZoho(async (tx) => {
    for (const [i, m] of pending.entries()) {
      const r = results[i];
      if (r?.status === "success" && r.details.id) await tx.update(schema.ticketMessages).set({ zohoNoteId: r.details.id }).where(eq(schema.ticketMessages.id, m.id));
      else failedAt ??= r?.message ?? "no response";
    }
  });
  if (failedAt) throw new ZohoError(`Zoho didn't accept a note: ${failedAt}`, "NOTE_FAILED", 400, false);
}

/** Links a contact to Zoho: the existing Zoho contact with that email, or a new one. Zoho's copy is never overwritten. */
async function ensureZohoContact(contact: typeof schema.contacts.$inferSelect): Promise<string | null> {
  const found = await zoho<{ data: { id: string }[] }>("GET", "/Contacts/search", { query: { email: contact.email! } });
  let zohoId = found?.data?.[0]?.id ?? null;
  if (!zohoId) {
    const res = await zoho<{ data: WriteResult[] }>("POST", "/Contacts", {
      body: { data: [{ ...splitName(contact.name, contact.email), Email: contact.email, ...(contact.phone ? { Phone: contact.phone } : {}) }], trigger: [] },
    });
    zohoId = firstSuccess(res, "contact");
    await logSync({ direction: "out", entity: "contact", entityId: contact.id, zohoId, message: "Created contact in Zoho." });
  }
  // Another local contact may already hold this Zoho id (two emails merged in Zoho): keep the first link.
  const [taken] = await db().select({ id: schema.contacts.id }).from(schema.contacts).where(eq(schema.contacts.zohoContactId, zohoId));
  if (!taken) await db().update(schema.contacts).set({ zohoContactId: zohoId }).where(eq(schema.contacts.id, contact.id));
  return zohoId;
}

/** For the health page. */
export async function outboxCounts() {
  const [r] = await db()
    .select({
      waiting: sql<number>`count(*) filter (where ${schema.syncOutbox.attempts} = 0)::int`,
      retrying: sql<number>`count(*) filter (where ${schema.syncOutbox.attempts} between 1 and ${FAILED_AFTER - 1})::int`,
      failed: sql<number>`count(*) filter (where ${schema.syncOutbox.attempts} >= ${FAILED_AFTER})::int`,
    })
    .from(schema.syncOutbox);
  return r ?? { waiting: 0, retrying: 0, failed: 0 };
}

export async function failedChanges(limit = 20) {
  return db()
    .select({ id: schema.syncOutbox.id, entity: schema.syncOutbox.entity, entityId: schema.syncOutbox.entityId, attempts: schema.syncOutbox.attempts, lastError: schema.syncOutbox.lastError, nextAttemptAt: schema.syncOutbox.nextAttemptAt, number: schema.tickets.number })
    .from(schema.syncOutbox)
    .leftJoin(schema.tickets, and(eq(schema.syncOutbox.entity, "ticket"), eq(schema.tickets.id, schema.syncOutbox.entityId)))
    .where(or(sql`${schema.syncOutbox.attempts} > 0`))
    .orderBy(sql`${schema.syncOutbox.attempts} desc`)
    .limit(limit);
}
