import "server-only";
import { and, asc, count, desc, eq, gt, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { db, schema } from "../db";
import { CHAT_OUTCOMES, type ChatOutcome, type Segment } from "../db/schema";

export const CHAT_PAGE_SIZE = 50;

export interface ChatFilters {
  segment?: Segment;
  outcome?: ChatOutcome | "escalated" | "unhelpful";
  page: number;
}

export function parseChatFilters(sp: Record<string, string | string[] | undefined>): ChatFilters {
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  const seg = one("segment");
  const outcome = one("outcome");
  const page = Math.max(1, Math.min(1000, Number(one("page")) || 1));
  return {
    segment: seg === "b2c" || seg === "b2b" ? seg : undefined,
    outcome: outcome && ([...CHAT_OUTCOMES, "escalated", "unhelpful"] as string[]).includes(outcome) ? (outcome as ChatFilters["outcome"]) : undefined,
    page,
  };
}

export function chatHref(f: ChatFilters, change: Partial<ChatFilters> = {}): string {
  const n = { ...f, ...change };
  const q = new URLSearchParams();
  if (n.segment) q.set("segment", n.segment);
  if (n.outcome) q.set("outcome", n.outcome);
  if (n.page > 1) q.set("page", String(n.page));
  const s = q.toString();
  return `/admin/chat${s ? `?${s}` : ""}`;
}

/** Conversations, newest first, with their first question and how they went. */
export async function listChats(f: ChatFilters, segments: Segment[]) {
  if (segments.length === 0) return { rows: [], total: 0 };
  const s = schema.chatSessions;
  const m = schema.chatMessages;
  const where: SQL[] = [inArray(s.segment, f.segment ? segments.filter((x) => x === f.segment) : segments)];
  if (f.outcome === "escalated") where.push(isNotNull(s.ticketId));
  else if (f.outcome === "unhelpful") where.push(sql`exists (select 1 from ${m} where ${m.sessionId} = ${s.id} and ${m.feedback} = -1)`);
  else if (f.outcome) where.push(sql`exists (select 1 from ${m} where ${m.sessionId} = ${s.id} and ${m.outcome} = ${f.outcome})`);
  const filter = and(...where);
  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    db()
      .select({
        id: s.id,
        segment: s.segment,
        status: s.status,
        messageCount: s.messageCount,
        lastMessageAt: s.lastMessageAt,
        ticketNumber: schema.tickets.number,
        firstQuestion: sql<string | null>`(select ${m.content} from ${m} where ${m.sessionId} = ${s.id} and ${m.role} = 'user' order by ${m.createdAt} limit 1)`,
        outcomes: sql<string[] | null>`(select array_agg(distinct ${m.outcome}) from ${m} where ${m.sessionId} = ${s.id} and ${m.outcome} is not null)`,
        helpful: sql<number>`(select count(*)::int from ${m} where ${m.sessionId} = ${s.id} and ${m.feedback} = 1)`,
        unhelpful: sql<number>`(select count(*)::int from ${m} where ${m.sessionId} = ${s.id} and ${m.feedback} = -1)`,
      })
      .from(s)
      .leftJoin(schema.tickets, eq(schema.tickets.id, s.ticketId))
      .where(filter)
      .orderBy(desc(s.lastMessageAt))
      .limit(CHAT_PAGE_SIZE)
      .offset((f.page - 1) * CHAT_PAGE_SIZE),
    db().select({ total: count() }).from(s).where(filter),
  ]);
  return { rows, total };
}

/** The last 30 days at a glance, for the segments the person can see. */
export async function chatStats(segments: Segment[]) {
  const empty = { chats: 0, answers: 0, outcomes: {} as Partial<Record<ChatOutcome, number>>, escalated: 0, helpful: 0, unhelpful: 0 };
  if (segments.length === 0) return empty;
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const m = schema.chatMessages;
  const s = schema.chatSessions;
  const [sessions] = await db()
    .select({ chats: count(), escalated: sql<number>`count(${s.ticketId})::int` })
    .from(s)
    .where(and(inArray(s.segment, segments), gt(s.createdAt, since)));
  const rows = await db()
    .select({ outcome: m.outcome, n: count(), helpful: sql<number>`count(*) filter (where ${m.feedback} = 1)::int`, unhelpful: sql<number>`count(*) filter (where ${m.feedback} = -1)::int` })
    .from(m)
    .innerJoin(s, eq(s.id, m.sessionId))
    .where(and(eq(m.role, "assistant"), inArray(s.segment, segments), gt(m.createdAt, since)))
    .groupBy(m.outcome);
  const out = { ...empty, chats: sessions?.chats ?? 0, escalated: sessions?.escalated ?? 0, outcomes: {} as Partial<Record<ChatOutcome, number>> };
  for (const r of rows) {
    if (r.outcome) out.outcomes[r.outcome] = r.n;
    out.answers += r.n;
    out.helpful += r.helpful;
    out.unhelpful += r.unhelpful;
  }
  return out;
}

/** One conversation, every message, and for each answer the passages it was given. */
export async function getChat(id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const [session] = await db()
    .select({ session: schema.chatSessions, ticketNumber: schema.tickets.number })
    .from(schema.chatSessions)
    .leftJoin(schema.tickets, eq(schema.tickets.id, schema.chatSessions.ticketId))
    .where(eq(schema.chatSessions.id, id));
  if (!session) return null;
  const messages = await db().select().from(schema.chatMessages).where(eq(schema.chatMessages.sessionId, id)).orderBy(asc(schema.chatMessages.createdAt));
  const sources = messages.length
    ? await db()
        .select({
          id: schema.chatAnswerSources.id,
          messageId: schema.chatAnswerSources.messageId,
          articleId: schema.chatAnswerSources.articleId,
          versionNumber: schema.kbArticleVersions.number,
          heading: schema.chatAnswerSources.heading,
          content: schema.chatAnswerSources.content,
          rank: schema.chatAnswerSources.rank,
          score: schema.chatAnswerSources.score,
          cited: schema.chatAnswerSources.cited,
        })
        .from(schema.chatAnswerSources)
        .leftJoin(schema.kbArticleVersions, eq(schema.kbArticleVersions.id, schema.chatAnswerSources.versionId))
        .where(inArray(schema.chatAnswerSources.messageId, messages.map((x) => x.id)))
        .orderBy(asc(schema.chatAnswerSources.rank))
    : [];
  const byMessage = new Map<string, typeof sources>();
  for (const src of sources) byMessage.set(src.messageId, [...(byMessage.get(src.messageId) ?? []), src]);
  return { ...session.session, ticketNumber: session.ticketNumber, messages: messages.map((x) => ({ ...x, sources: byMessage.get(x.id) ?? [] })) };
}
