import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { db } from "../db";
import type { Segment } from "../db/schema";

/**
 * Support analytics, straight from the database (tickets include history
 * imported from Zoho). Every figure is for tickets created, or chats
 * started, in the chosen range and segment.
 */

export interface Range {
  from: string; // YYYY-MM-DD, inclusive
  to: string; // YYYY-MM-DD, inclusive
  segment?: Segment;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const day = (d: Date) => d.toISOString().slice(0, 10);

export function parseRange(sp: Record<string, string | string[] | undefined>, today = new Date()): Range {
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  const to = one("to") && ISO.test(one("to")!) ? one("to")! : day(today);
  const defaultFrom = day(new Date(Date.parse(to) - 89 * 86_400_000));
  let from = one("from") && ISO.test(one("from")!) ? one("from")! : defaultFrom;
  if (from > to) from = to;
  const seg = one("segment");
  return { from, to, segment: seg === "b2c" || seg === "b2b" ? seg : undefined };
}

/** The same length of time, just before. */
export function previousRange(r: Range): Range {
  const days = Math.round((Date.parse(r.to) - Date.parse(r.from)) / 86_400_000) + 1;
  const to = day(new Date(Date.parse(r.from) - 86_400_000));
  return { ...r, from: day(new Date(Date.parse(to) - (days - 1) * 86_400_000)), to };
}

export function granularity(r: Range): "day" | "week" | "month" {
  const days = (Date.parse(r.to) - Date.parse(r.from)) / 86_400_000;
  return days > 540 ? "month" : days > 92 ? "week" : "day";
}

/** Half-open timestamp bounds in UK time: [from 00:00, to+1 00:00). */
const within = (col: SQL, r: Range) => sql`${col} >= (${r.from}::date)::timestamp at time zone 'Europe/London' and ${col} < (${r.to}::date + 1)::timestamp at time zone 'Europe/London'`;
const seg = (col: SQL, r: Range) => (r.segment ? sql`and ${col} = ${r.segment}` : sql``);

async function rows<T>(q: SQL): Promise<T[]> {
  return (await db().execute(q)) as unknown as T[];
}
const num = (v: unknown) => (v == null ? null : Number(v));

/* ---------- Headline figures ---------- */

export interface Summary {
  tickets: number;
  firstResponseHours: number | null;
  respondedWithinDay: number | null;
  resolutionHours: number | null;
  chats: number;
  answeredByBot: number | null;
  unanswered: number;
}

export async function summary(r: Range): Promise<Summary> {
  const [t] = await rows<Record<string, unknown>>(sql`
    select count(*)::int as tickets,
      percentile_cont(0.5) within group (order by extract(epoch from first_response_at - created_at) / 3600) filter (where first_response_at is not null) as frh,
      avg(case when first_response_at is null then null when first_response_at - created_at <= interval '24 hours' then 1.0 else 0.0 end) as within_day,
      percentile_cont(0.5) within group (order by extract(epoch from resolved_at - created_at) / 3600) filter (where resolved_at is not null) as rh
    from tickets where ${within(sql`created_at`, r)} ${seg(sql`segment`, r)}`);
  // A chat "answered by the assistant": it gave at least one answer, and the person didn't then ask for the team.
  const [c] = await rows<Record<string, unknown>>(sql`
    with s as (
      select cs.id, cs.ticket_id,
        bool_or(m.outcome in ('answered', 'partial')) as answered,
        count(*) filter (where m.outcome in ('no_answer', 'needs_human')) as unanswered
      from chat_sessions cs join chat_messages m on m.session_id = cs.id
      where ${within(sql`cs.created_at`, r)} ${seg(sql`cs.segment`, r)}
      group by cs.id
    )
    select count(*)::int as chats,
      avg(case when answered and ticket_id is null then 1.0 else 0.0 end) as deflected,
      coalesce(sum(unanswered), 0)::int as unanswered
    from s`);
  return {
    tickets: Number(t?.tickets ?? 0),
    firstResponseHours: num(t?.frh),
    respondedWithinDay: num(t?.within_day),
    resolutionHours: num(t?.rh),
    chats: Number(c?.chats ?? 0),
    answeredByBot: Number(c?.chats ?? 0) ? num(c?.deflected) : null,
    unanswered: Number(c?.unanswered ?? 0),
  };
}

/* ---------- Over time ---------- */

export async function volume(r: Range) {
  const g = granularity(r);
  const unit = sql.raw(`'${g}'`);
  const step = sql.raw(`'1 ${g}'`);
  const data = await rows<{ bucket: string; b2c: number; b2b: number; chats: number }>(sql`
    with buckets as (
      select generate_series(date_trunc(${unit}, ${r.from}::date), date_trunc(${unit}, ${r.to}::date), ${step}::interval)::date as bucket
    ),
    t as (
      select date_trunc(${unit}, created_at at time zone 'Europe/London')::date as bucket, segment, count(*) as n
      from tickets where ${within(sql`created_at`, r)} ${seg(sql`segment`, r)} group by 1, 2
    ),
    c as (
      select date_trunc(${unit}, created_at at time zone 'Europe/London')::date as bucket, count(*) as n
      from chat_sessions where message_count > 0 and ${within(sql`created_at`, r)} ${seg(sql`segment`, r)} group by 1
    )
    select to_char(b.bucket, 'YYYY-MM-DD') as bucket,
      coalesce((select n from t where t.bucket = b.bucket and segment = 'b2c'), 0)::int as b2c,
      coalesce((select n from t where t.bucket = b.bucket and segment = 'b2b'), 0)::int as b2b,
      coalesce((select n from c where c.bucket = b.bucket), 0)::int as chats
    from buckets b order by b.bucket`);
  return { granularity: g, data };
}

/* ---------- Breakdowns ---------- */

export async function breakdowns(r: Range) {
  const by = (expr: SQL, limit: number) =>
    rows<{ label: string; value: number }>(sql`
      select ${expr} as label, count(*)::int as value from tickets
      where ${within(sql`created_at`, r)} ${seg(sql`segment`, r)}
      group by 1 order by 2 desc, 1 limit ${limit}`);
  const [category, product, source, resolution] = await Promise.all([
    by(sql`coalesce(category, 'Not set')`, 12),
    // Free text ("905 2024", "905, 2024"): grouped on the model's first word, the part people agree on.
    rows<{ label: string; value: number }>(sql`
      select initcap(split_part(regexp_replace(lower(trim(product_model)), '[^a-z0-9 -]', ' ', 'g'), ' ', 1)) as label, count(*)::int as value
      from tickets where product_model is not null and trim(product_model) <> '' and ${within(sql`created_at`, r)} ${seg(sql`segment`, r)}
      group by 1 order by 2 desc, 1 limit 12`),
    by(sql`source`, 10),
    rows<{ label: string; value: number; n: number }>(sql`
      select coalesce(category, 'Not set') as label,
        (percentile_cont(0.5) within group (order by extract(epoch from resolved_at - created_at) / 3600))::float as value,
        count(*)::int as n
      from tickets where resolved_at is not null and ${within(sql`created_at`, r)} ${seg(sql`segment`, r)}
      group by 1 having count(*) >= 3 order by 2 desc limit 10`),
  ]);
  return { category, product, source, resolution };
}

/* ---------- Automation candidates: topics, by knowledge-base article ---------- */

export interface Topic {
  articleId: string;
  title: string;
  audience: string;
  tickets: number;
  chats: number;
  escalated: number;
  unhelpful: number;
}

/**
 * For each published article: tickets in the range about its subject (its
 * title's words all appear in the ticket), and chats where the assistant
 * answered from it (and how many then went to the team anyway).
 */
export async function topics(r: Range): Promise<Topic[]> {
  const list = await rows<Record<string, unknown>>(sql`
    select a.id as "articleId", v.title, a.audience,
      (select count(*) from tickets t
        where t.search_vector @@ plainto_tsquery('english', v.title) and ${within(sql`t.created_at`, r)} ${seg(sql`t.segment`, r)})::int as tickets,
      (select count(distinct m.session_id) from chat_answer_sources s
        join chat_messages m on m.id = s.message_id join chat_sessions cs on cs.id = m.session_id
        where s.article_id = a.id and s.cited and ${within(sql`m.created_at`, r)} ${seg(sql`cs.segment`, r)})::int as chats,
      (select count(distinct cs.id) from chat_answer_sources s
        join chat_messages m on m.id = s.message_id join chat_sessions cs on cs.id = m.session_id
        where s.article_id = a.id and s.cited and cs.ticket_id is not null and ${within(sql`m.created_at`, r)} ${seg(sql`cs.segment`, r)})::int as escalated,
      (select count(*) from chat_answer_sources s join chat_messages m on m.id = s.message_id join chat_sessions cs on cs.id = m.session_id
        where s.article_id = a.id and s.cited and m.feedback = -1 and ${within(sql`m.created_at`, r)} ${seg(sql`cs.segment`, r)})::int as unhelpful
    from kb_articles a join kb_article_versions v on v.id = a.published_version_id
    where a.retired_at is null ${r.segment ? sql`and a.audience in (${r.segment}, 'both')` : sql``}`);
  return (list as unknown as Topic[]).filter((t) => t.tickets + t.chats > 0).sort((a, b) => b.tickets + b.chats - (a.tickets + a.chats)).slice(0, 25);
}

/** What the numbers suggest for a topic. */
export function topicAdvice(t: Topic): string {
  const handled = t.chats - t.escalated;
  if (t.unhelpful >= 3 && t.unhelpful >= t.chats * 0.2) return "Answers are often rated unhelpful: review the article";
  if (t.tickets >= 5 && t.chats < t.tickets / 2) return "Still mostly tickets: link the article from the form and replies";
  if (t.chats >= 5 && t.escalated > handled) return "The assistant answers, but people still ask for the team: add detail";
  if (handled >= t.tickets && handled > 0) return "Mostly handled by the assistant";
  return "Watch";
}

/* ---------- Gaps ---------- */

/** Questions the assistant couldn't answer from the articles, most asked first. */
export async function unansweredQuestions(r: Range, limit = 20) {
  return rows<{ question: string; times: number; last: string }>(sql`
    with q as (
      select u.content, a.created_at
      from chat_messages a
      join chat_sessions cs on cs.id = a.session_id
      join lateral (
        select content from chat_messages u where u.session_id = a.session_id and u.role = 'user' and u.created_at <= a.created_at order by u.created_at desc limit 1
      ) u on true
      where a.role = 'assistant' and a.outcome in ('no_answer', 'needs_human') and ${within(sql`a.created_at`, r)} ${seg(sql`cs.segment`, r)}
    )
    select min(content) as question, count(*)::int as times, to_char(max(created_at), 'YYYY-MM-DD') as last
    from q group by trim(lower(regexp_replace(content, '[^a-zA-Z0-9]+', ' ', 'g')))
    order by 2 desc, 3 desc limit ${limit}`);
}

/** Tickets no published article's title matches, by category: where articles are missing. */
export async function uncovered(r: Range) {
  return rows<{ label: string; value: number }>(sql`
    select coalesce(t.category, 'Not set') as label, count(*)::int as value
    from tickets t
    where ${within(sql`t.created_at`, r)} ${seg(sql`t.segment`, r)}
      and not exists (
        select 1 from kb_articles a join kb_article_versions v on v.id = a.published_version_id
        where a.retired_at is null and t.search_vector @@ plainto_tsquery('english', v.title)
      )
    group by 1 order by 2 desc limit 10`);
}

/* ---------- Customer experience ---------- */

export async function experience(r: Range) {
  const [x] = await rows<Record<string, unknown>>(sql`
    with t as (select * from tickets where ${within(sql`created_at`, r)} ${seg(sql`segment`, r)}),
    per as (select contact_id, count(*) as n from t where contact_id is not null group by 1)
    select
      (select count(*) from per where n > 1)::int as repeat_customers,
      (select count(*) from per)::int as customers,
      (select count(*) from tickets where status not in ('resolved', 'closed') and created_at < now() - interval '7 days' ${seg(sql`segment`, r)})::int as open_over_week,
      (select count(*) from tickets where status in ('new', 'open') and first_response_at is null and created_at < now() - interval '24 hours' ${seg(sql`segment`, r)})::int as unanswered_over_day,
      (select count(*) from t where exists (select 1 from ticket_events e where e.ticket_id = t.id and e.type = 'reopened'))::int as reopened`);
  return {
    repeatCustomers: Number(x?.repeat_customers ?? 0),
    customers: Number(x?.customers ?? 0),
    openOverWeek: Number(x?.open_over_week ?? 0),
    unansweredOverDay: Number(x?.unanswered_over_day ?? 0),
    reopened: Number(x?.reopened ?? 0),
  };
}

/** For the volume sparkline on each card: nothing extra, but a small helper for the page. */
export function hours(h: number | null): string {
  if (h == null) return "–";
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0)} h`;
  return `${(h / 24).toFixed(1)} days`;
}
