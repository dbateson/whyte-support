import "server-only";
import { and, asc, count, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { db, schema } from "../db";
import { SEGMENTS, TICKET_PRIORITIES, TICKET_STATUSES, type Segment, type TicketPriority, type TicketStatus } from "../db/schema";
import { OPEN_STATUSES, parseRef } from "./format";

export const PAGE_SIZE = 25;
export const SORTS = ["updated", "created", "number", "priority"] as const;
export type SortKey = (typeof SORTS)[number];

/** The queue's filters, as read from the URL. Unknown values are dropped. */
export interface QueueFilters {
  status: TicketStatus[] | "open" | "all";
  priority?: TicketPriority;
  segment?: Segment;
  assignee?: "me" | "unassigned" | string;
  q?: string;
  sort: SortKey;
  dir: "ascending" | "descending";
  page: number;
}

export function parseQueueFilters(sp: Record<string, string | string[] | undefined>): QueueFilters {
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : sp[k]) as string | undefined;
  const statusRaw = one("status") ?? "open";
  const status: QueueFilters["status"] =
    statusRaw === "all" || statusRaw === "open"
      ? statusRaw
      : (statusRaw.split(",").filter((s): s is TicketStatus => (TICKET_STATUSES as readonly string[]).includes(s)) as TicketStatus[]);
  const priority = one("priority");
  const segment = one("segment");
  const sort = one("sort");
  return {
    status: Array.isArray(status) && status.length === 0 ? "open" : status,
    priority: (TICKET_PRIORITIES as readonly string[]).includes(priority ?? "") ? (priority as TicketPriority) : undefined,
    segment: (SEGMENTS as readonly string[]).includes(segment ?? "") ? (segment as Segment) : undefined,
    assignee: one("assignee") || undefined,
    q: one("q")?.trim().slice(0, 200) || undefined,
    sort: (SORTS as readonly string[]).includes(sort ?? "") ? (sort as SortKey) : "updated",
    dir: one("dir") === "ascending" ? "ascending" : "descending",
    page: Math.max(1, Math.min(10_000, Number(one("page")) || 1)),
  };
}

/** The URL for a set of filters (only what differs from the defaults). */
export function queueHref(f: QueueFilters, patch: Partial<QueueFilters> = {}): string {
  const n = { ...f, ...patch };
  const p = new URLSearchParams();
  if (n.status !== "open") p.set("status", Array.isArray(n.status) ? n.status.join(",") : n.status);
  if (n.priority) p.set("priority", n.priority);
  if (n.segment) p.set("segment", n.segment);
  if (n.assignee) p.set("assignee", n.assignee);
  if (n.q) p.set("q", n.q);
  if (n.sort !== "updated") p.set("sort", n.sort);
  if (n.dir !== "descending") p.set("dir", n.dir);
  if (n.page > 1) p.set("page", String(n.page));
  const s = p.toString();
  return `/admin/tickets${s ? `?${s}` : ""}`;
}

export interface QueueRow {
  id: string;
  number: number;
  subject: string;
  segment: Segment;
  status: TicketStatus;
  priority: TicketPriority;
  category: string | null;
  updatedAt: Date;
  createdAt: Date;
  contactName: string | null;
  contactEmail: string | null;
  assigneeName: string | null;
}

/**
 * The queue. `segments` is what the viewer may see (from their roles); a
 * segment filter outside it returns nothing.
 */
export async function listTickets(f: QueueFilters, viewer: { id: string; segments: Segment[] }): Promise<{ rows: QueueRow[]; total: number }> {
  const segments = f.segment ? viewer.segments.filter((s) => s === f.segment) : viewer.segments;
  if (segments.length === 0) return { rows: [], total: 0 };
  const where: SQL[] = [inArray(schema.tickets.segment, segments)];
  if (f.status === "open") where.push(inArray(schema.tickets.status, OPEN_STATUSES));
  else if (Array.isArray(f.status)) where.push(inArray(schema.tickets.status, f.status));
  if (f.priority) where.push(eq(schema.tickets.priority, f.priority));
  if (f.assignee === "me") where.push(eq(schema.tickets.assigneeId, viewer.id));
  else if (f.assignee === "unassigned") where.push(isNull(schema.tickets.assigneeId));
  else if (f.assignee && /^[0-9a-f-]{36}$/.test(f.assignee)) where.push(eq(schema.tickets.assigneeId, f.assignee));
  let rank: SQL | undefined;
  if (f.q) {
    const number = parseRef(f.q);
    const tsq = sql`(websearch_to_tsquery('english', ${f.q}) || websearch_to_tsquery('simple', ${f.q}))`;
    where.push(number ? sql`(${schema.tickets.number} = ${number} or ${schema.tickets.searchVector} @@ ${tsq})` : sql`${schema.tickets.searchVector} @@ ${tsq}`);
    rank = sql`ts_rank(${schema.tickets.searchVector}, ${tsq})`;
  }
  const filter = and(...where);
  const priorityOrder = sql`array_position(array['urgent','high','normal','low']::text[], ${schema.tickets.priority})`;
  const column = { updated: schema.tickets.updatedAt, created: schema.tickets.createdAt, number: schema.tickets.number, priority: priorityOrder }[f.sort];
  // Priority sorts most urgent first when "descending".
  const ascending = f.sort === "priority" ? f.dir === "descending" : f.dir === "ascending";
  const order = [ascending ? asc(column) : desc(column), desc(schema.tickets.number)];
  if (rank && f.sort === "updated" && f.dir === "descending") order.unshift(desc(rank));

  const assignee = sql<string | null>`(select name from users where users.id = ${schema.tickets.assigneeId})`;
  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    db()
      .select({
        id: schema.tickets.id,
        number: schema.tickets.number,
        subject: schema.tickets.subject,
        segment: schema.tickets.segment,
        status: schema.tickets.status,
        priority: schema.tickets.priority,
        category: schema.tickets.category,
        updatedAt: schema.tickets.updatedAt,
        createdAt: schema.tickets.createdAt,
        contactName: schema.contacts.name,
        contactEmail: schema.contacts.email,
        assigneeName: assignee,
      })
      .from(schema.tickets)
      .leftJoin(schema.contacts, eq(schema.contacts.id, schema.tickets.contactId))
      .where(filter)
      .orderBy(...order)
      .limit(PAGE_SIZE)
      .offset((f.page - 1) * PAGE_SIZE),
    db().select({ total: count() }).from(schema.tickets).where(filter),
  ]);
  return { rows: rows as QueueRow[], total };
}

/** Headline counts for the overview, within the viewer's segments. */
export async function queueCounts(viewer: { id: string; segments: Segment[] }) {
  if (viewer.segments.length === 0) return { open: 0, unassigned: 0, mine: 0, waitingOnUs: 0 };
  const open = and(inArray(schema.tickets.segment, viewer.segments), inArray(schema.tickets.status, OPEN_STATUSES));
  const [row] = await db()
    .select({
      open: count(),
      unassigned: sql<number>`count(*) filter (where ${schema.tickets.assigneeId} is null)`.mapWith(Number),
      mine: sql<number>`count(*) filter (where ${schema.tickets.assigneeId} = ${viewer.id})`.mapWith(Number),
      waitingOnUs: sql<number>`count(*) filter (where ${schema.tickets.status} in ('new','open','pending_internal'))`.mapWith(Number),
    })
    .from(schema.tickets)
    .where(open);
  return row ?? { open: 0, unassigned: 0, mine: 0, waitingOnUs: 0 };
}

export async function getTicketByNumber(number: number) {
  const [row] = await db()
    .select({ ticket: schema.tickets, contact: schema.contacts })
    .from(schema.tickets)
    .leftJoin(schema.contacts, eq(schema.contacts.id, schema.tickets.contactId))
    .where(eq(schema.tickets.number, number));
  return row ?? null;
}

export type ThreadItem =
  | { kind: "message"; at: Date; message: typeof schema.ticketMessages.$inferSelect }
  | { kind: "event"; at: Date; event: typeof schema.ticketEvents.$inferSelect };

/** Messages and events merged, oldest first. */
export async function getThread(ticketId: string): Promise<ThreadItem[]> {
  const [messages, events] = await Promise.all([
    db().select().from(schema.ticketMessages).where(eq(schema.ticketMessages.ticketId, ticketId)).orderBy(asc(schema.ticketMessages.createdAt)),
    db().select().from(schema.ticketEvents).where(eq(schema.ticketEvents.ticketId, ticketId)).orderBy(asc(schema.ticketEvents.createdAt)),
  ]);
  const items: ThreadItem[] = [
    ...messages.map((m) => ({ kind: "message" as const, at: m.createdAt, message: m })),
    ...events.filter((e) => e.type !== "created").map((e) => ({ kind: "event" as const, at: e.createdAt, event: e })),
  ];
  return items.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** Staff who can be assigned tickets in a segment: active, with tickets.reply there. */
export async function assignableStaff(segment: Segment) {
  return db()
    .selectDistinct({ id: schema.users.id, name: schema.users.name })
    .from(schema.users)
    .innerJoin(schema.userRoles, eq(schema.userRoles.userId, schema.users.id))
    .innerJoin(schema.roles, eq(schema.roles.id, schema.userRoles.roleId))
    .where(and(eq(schema.users.status, "active"), sql`'tickets.reply' = any(${schema.roles.permissions})`, sql`${segment} = any(${schema.roles.segments})`))
    .orderBy(asc(schema.users.name));
}
