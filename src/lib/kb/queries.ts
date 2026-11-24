import "server-only";
import { and, count, desc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, schema, type Db } from "../db";
import type { KbAudience } from "../db/schema";
import { log } from "../logger";
import { embed } from "./embeddings";

export const KB_PAGE_SIZE = 25;
export const KB_STATES = ["all", "published", "changes", "review", "draft", "retired"] as const;
export type KbStateFilter = (typeof KB_STATES)[number];

export interface KbListFilters {
  q?: string;
  state: KbStateFilter;
  audience?: KbAudience;
  page: number;
}

export function parseKbFilters(sp: Record<string, string | string[] | undefined>): KbListFilters {
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : sp[k]) as string | undefined;
  const state = one("state");
  const audience = one("audience");
  return {
    q: one("q")?.trim().slice(0, 200) || undefined,
    state: (KB_STATES as readonly string[]).includes(state ?? "") ? (state as KbStateFilter) : "all",
    audience: audience === "b2c" || audience === "b2b" || audience === "both" ? audience : undefined,
    page: Math.max(1, Math.min(10_000, Number(one("page")) || 1)),
  };
}

export function kbHref(f: KbListFilters, patch: Partial<KbListFilters> = {}): string {
  const n = { ...f, ...patch };
  const p = new URLSearchParams();
  if (n.q) p.set("q", n.q);
  if (n.state !== "all") p.set("state", n.state);
  if (n.audience) p.set("audience", n.audience);
  if (n.page > 1) p.set("page", String(n.page));
  const s = p.toString();
  return `/admin/kb${s ? `?${s}` : ""}`;
}

const working = alias(schema.kbArticleVersions, "working");
const published = alias(schema.kbArticleVersions, "published");

function filterFor(f: KbListFilters, audiences: KbAudience[]) {
  const where: SQL[] = [inArray(schema.kbArticles.audience, f.audience ? audiences.filter((a) => a === f.audience) : audiences)];
  const live = isNull(schema.kbArticles.retiredAt);
  if (f.state === "published") where.push(live, isNotNull(schema.kbArticles.publishedVersionId), isNull(schema.kbArticles.workingVersionId));
  if (f.state === "changes") where.push(live, isNotNull(schema.kbArticles.publishedVersionId), isNotNull(schema.kbArticles.workingVersionId));
  if (f.state === "review") where.push(live, eq(working.status, "in_review"));
  if (f.state === "draft") where.push(live, eq(working.status, "draft"));
  if (f.state === "retired") where.push(isNotNull(schema.kbArticles.retiredAt));
  if (f.q) {
    const like = `%${f.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    where.push(or(sql`${working.title} ilike ${like}`, sql`${published.title} ilike ${like}`, sql`${working.body} ilike ${like}`, sql`${published.body} ilike ${like}`)!);
  }
  return and(...where);
}

/** Every article id matching the filters (for bulk edits), up to a limit. */
export async function listArticleIds(f: KbListFilters, audiences: KbAudience[], max = 1000, database: Db = db()): Promise<string[]> {
  if (audiences.length === 0) return [];
  const rows = await database
    .select({ id: schema.kbArticles.id })
    .from(schema.kbArticles)
    .leftJoin(working, eq(working.id, schema.kbArticles.workingVersionId))
    .leftJoin(published, eq(published.id, schema.kbArticles.publishedVersionId))
    .where(filterFor(f, audiences))
    .orderBy(desc(schema.kbArticles.updatedAt))
    .limit(max);
  return rows.map((r) => r.id);
}

export async function listArticles(f: KbListFilters, audiences: KbAudience[], database: Db = db()) {
  if (audiences.length === 0) return { rows: [], total: 0 };
  const filter = filterFor(f, audiences);
  const base = () =>
    database
      .select({
        id: schema.kbArticles.id,
        audience: schema.kbArticles.audience,
        category: schema.kbArticles.category,
        origin: schema.kbArticles.origin,
        retiredAt: schema.kbArticles.retiredAt,
        publishedVersionId: schema.kbArticles.publishedVersionId,
        updatedAt: schema.kbArticles.updatedAt,
        title: sql<string>`coalesce(${working.title}, ${published.title})`,
        workingStatus: working.status,
        publishedNumber: published.number,
      })
      .from(schema.kbArticles)
      .leftJoin(working, eq(working.id, schema.kbArticles.workingVersionId))
      .leftJoin(published, eq(published.id, schema.kbArticles.publishedVersionId));
  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    base().where(filter).orderBy(desc(schema.kbArticles.updatedAt)).limit(KB_PAGE_SIZE).offset((f.page - 1) * KB_PAGE_SIZE),
    database
      .select({ total: count() })
      .from(schema.kbArticles)
      .leftJoin(working, eq(working.id, schema.kbArticles.workingVersionId))
      .leftJoin(published, eq(published.id, schema.kbArticles.publishedVersionId))
      .where(filter),
  ]);
  return { rows, total };
}

/** Counts for the knowledge base's headline figures. */
export async function kbCounts(audiences: KbAudience[], database: Db = db()) {
  if (audiences.length === 0) return { published: 0, review: 0, drafts: 0 };
  const [row] = await database
    .select({
      published: sql<number>`count(*) filter (where ${schema.kbArticles.publishedVersionId} is not null and ${schema.kbArticles.retiredAt} is null)`.mapWith(Number),
      review: sql<number>`count(*) filter (where ${working.status} = 'in_review' and ${schema.kbArticles.retiredAt} is null)`.mapWith(Number),
      drafts: sql<number>`count(*) filter (where ${working.status} = 'draft' and ${schema.kbArticles.retiredAt} is null)`.mapWith(Number),
    })
    .from(schema.kbArticles)
    .leftJoin(working, eq(working.id, schema.kbArticles.workingVersionId))
    .where(inArray(schema.kbArticles.audience, audiences));
  return row ?? { published: 0, review: 0, drafts: 0 };
}

export interface SearchHit {
  chunkId: string;
  articleId: string;
  versionId: string;
  heading: string;
  content: string;
  audience: KbAudience;
  /** Reciprocal-rank-fusion score: higher is better. */
  score: number;
  matchedBy: ("text" | "meaning")[];
}

const RRF_K = 60;

/**
 * Hybrid search over published passages for the given audiences ("both"
 * is always included). Full-text and, when Voyage is set up, semantic
 * search each rank the top candidates; reciprocal rank fusion merges them.
 */
export async function searchKb(query: string, segment: "b2c" | "b2b" | "any", limit = 8, database: Db = db()): Promise<SearchHit[]> {
  const q = query.trim().slice(0, 500);
  if (!q) return [];
  const audiences: KbAudience[] = segment === "any" ? ["b2c", "b2b", "both"] : [segment, "both"];
  const candidates = 25;
  // Any of the query's words may match (OR); ranking favours passages with more of them.
  const anyWord = sql`to_tsquery('english', replace(plainto_tsquery('english', ${q})::text, '&', '|'))`;
  const text = await database
    .select({ id: schema.kbChunks.id })
    .from(schema.kbChunks)
    .where(and(inArray(schema.kbChunks.audience, audiences), sql`${schema.kbChunks.searchVector} @@ ${anyWord}`))
    .orderBy(desc(sql`ts_rank_cd(${schema.kbChunks.searchVector}, ${anyWord})`))
    .limit(candidates);

  let meaning: { id: string }[] = [];
  try {
    const e = await embed([q], "query");
    if (e) {
      const vec = `[${e.vectors[0]!.join(",")}]`;
      meaning = await database
        .select({ id: schema.kbChunks.id })
        .from(schema.kbChunks)
        .where(and(inArray(schema.kbChunks.audience, audiences), isNotNull(schema.kbChunks.embedding)))
        .orderBy(sql`${schema.kbChunks.embedding} <=> ${vec}::vector`)
        .limit(candidates);
    }
  } catch (err) {
    log.warn("Semantic search unavailable; using full text only", { err });
  }

  const scores = new Map<string, { score: number; by: Set<"text" | "meaning"> }>();
  const add = (list: { id: string }[], by: "text" | "meaning") =>
    list.forEach((r, i) => {
      const s = scores.get(r.id) ?? { score: 0, by: new Set() };
      s.score += 1 / (RRF_K + i + 1);
      s.by.add(by);
      scores.set(r.id, s);
    });
  add(text, "text");
  add(meaning, "meaning");
  const top = [...scores.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, limit);
  if (top.length === 0) return [];
  const rows = await database.select().from(schema.kbChunks).where(inArray(schema.kbChunks.id, top.map(([id]) => id)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return top
    .map(([id, s]) => {
      const r = byId.get(id);
      return r
        ? { chunkId: r.id, articleId: r.articleId, versionId: r.versionId, heading: r.heading, content: r.content, audience: r.audience, score: s.score, matchedBy: [...s.by] }
        : null;
    })
    .filter((h): h is SearchHit => h !== null);
}

/** Everything waiting for a decision: submitted versions, and drafts the pipeline wrote. */
export async function reviewQueue(audiences: KbAudience[], database: Db = db()) {
  if (audiences.length === 0) return [];
  const rows = await database
    .select({
      id: schema.kbArticles.id,
      audience: schema.kbArticles.audience,
      origin: schema.kbArticles.origin,
      title: schema.kbArticleVersions.title,
      status: schema.kbArticleVersions.status,
      author: schema.kbArticleVersions.authorLabel,
      at: schema.kbArticleVersions.updatedAt,
      published: schema.kbArticles.publishedVersionId,
    })
    .from(schema.kbArticles)
    .innerJoin(schema.kbArticleVersions, eq(schema.kbArticleVersions.id, schema.kbArticles.workingVersionId))
    .where(and(inArray(schema.kbArticles.audience, audiences), isNull(schema.kbArticles.retiredAt), inArray(schema.kbArticleVersions.status, ["in_review", "draft"])))
    .orderBy(sql`${schema.kbArticleVersions.updatedAt} asc`)
    .limit(1000);
  return rows.filter((r) => r.status === "in_review" || r.origin !== "manual");
}
