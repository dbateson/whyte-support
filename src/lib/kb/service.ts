import "server-only";
import { and, desc, eq, inArray, max, sql } from "drizzle-orm";
import { db, schema, type Db } from "../db";
import type { KbAudience } from "../db/schema";
import { log } from "../logger";
import { chunkArticle } from "./chunk";
import { embed } from "./embeddings";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface Actor {
  id?: string;
  label: string;
}

export type Article = typeof schema.kbArticles.$inferSelect;
export type Version = typeof schema.kbArticleVersions.$inferSelect;

const audit = (tx: Tx | Db, actor: Actor, action: string, target: string, detail: Record<string, unknown> = {}) =>
  tx.insert(schema.auditLog).values({ actorId: actor.id ?? null, actorLabel: actor.label, action, target, detail });

export class KbError extends Error {}

export interface NewArticle {
  title: string;
  body: string;
  audience: KbAudience;
  category?: string | null;
  origin?: Article["origin"];
  sources?: { kind: (typeof schema.kbSources.$inferInsert)["kind"]; reference: string; title?: string | null }[];
}

/** A new article with its first draft. */
export async function createArticle(input: NewArticle, actor: Actor, database: Db = db()): Promise<{ article: Article; version: Version }> {
  return database.transaction(async (tx) => {
    const [article] = await tx
      .insert(schema.kbArticles)
      .values({ audience: input.audience, category: input.category ?? null, origin: input.origin ?? "manual", createdBy: actor.id ?? null })
      .returning();
    const [version] = await tx
      .insert(schema.kbArticleVersions)
      .values({ articleId: article!.id, number: 1, title: input.title.trim(), body: input.body.trim(), createdBy: actor.id ?? null, authorLabel: actor.label })
      .returning();
    await tx.update(schema.kbArticles).set({ workingVersionId: version!.id }).where(eq(schema.kbArticles.id, article!.id));
    if (input.sources?.length) {
      await tx.insert(schema.kbSources).values(input.sources.map((s) => ({ articleId: article!.id, kind: s.kind, reference: s.reference, title: s.title ?? null })));
    }
    await audit(tx, actor, "kb.create", article!.id, { title: input.title, origin: input.origin ?? "manual" });
    return { article: { ...article!, workingVersionId: version!.id }, version: version! };
  });
}

async function load(tx: Tx | Db, articleId: string) {
  const [article] = await tx.select().from(schema.kbArticles).where(eq(schema.kbArticles.id, articleId));
  if (!article) throw new KbError("That article doesn't exist.");
  const working = article.workingVersionId
    ? (await tx.select().from(schema.kbArticleVersions).where(eq(schema.kbArticleVersions.id, article.workingVersionId)))[0]
    : undefined;
  const published = article.publishedVersionId
    ? (await tx.select().from(schema.kbArticleVersions).where(eq(schema.kbArticleVersions.id, article.publishedVersionId)))[0]
    : undefined;
  return { article, working, published };
}

/**
 * Saves edits. They go to the working version: a draft is edited in place;
 * one in review goes back to draft (it must be submitted again); with no
 * working version, a new one starts from the published text.
 */
export async function saveDraft(
  articleId: string,
  edit: { title: string; body: string; audience: KbAudience; category: string | null },
  actor: Actor,
  database: Db = db(),
): Promise<Version> {
  return database.transaction(async (tx) => {
    const { article, working } = await load(tx, articleId);
    if (article.retiredAt) throw new KbError("Restore the article before editing it.");
    await tx.update(schema.kbArticles).set({ audience: edit.audience, category: edit.category, updatedAt: new Date() }).where(eq(schema.kbArticles.id, articleId));
    if (working) {
      const [v] = await tx
        .update(schema.kbArticleVersions)
        .set({ title: edit.title.trim(), body: edit.body.trim(), status: "draft", submittedAt: null, updatedAt: new Date() })
        .where(eq(schema.kbArticleVersions.id, working.id))
        .returning();
      return v!;
    }
    const [{ n } = { n: 0 }] = await tx.select({ n: max(schema.kbArticleVersions.number) }).from(schema.kbArticleVersions).where(eq(schema.kbArticleVersions.articleId, articleId));
    const [v] = await tx
      .insert(schema.kbArticleVersions)
      .values({ articleId, number: (n ?? 0) + 1, title: edit.title.trim(), body: edit.body.trim(), createdBy: actor.id ?? null, authorLabel: actor.label })
      .returning();
    await tx.update(schema.kbArticles).set({ workingVersionId: v!.id }).where(eq(schema.kbArticles.id, articleId));
    return v!;
  });
}

export async function submitForReview(articleId: string, actor: Actor, database: Db = db()) {
  await database.transaction(async (tx) => {
    const { working } = await load(tx, articleId);
    if (!working || working.status !== "draft") throw new KbError("There's no draft to submit.");
    await tx.update(schema.kbArticleVersions).set({ status: "in_review", submittedAt: new Date(), reviewNote: null }).where(eq(schema.kbArticleVersions.id, working.id));
    await audit(tx, actor, "kb.submit", articleId, { version: working.number });
  });
}

/** Sends the working version back to its author with a note. */
export async function requestChanges(articleId: string, note: string, actor: Actor, database: Db = db()) {
  await database.transaction(async (tx) => {
    const { working } = await load(tx, articleId);
    if (!working || working.status !== "in_review") throw new KbError("There's nothing in review.");
    await tx
      .update(schema.kbArticleVersions)
      .set({ status: "draft", reviewedBy: actor.id ?? null, reviewedAt: new Date(), reviewNote: note.trim() || "Changes requested." })
      .where(eq(schema.kbArticleVersions.id, working.id));
    await audit(tx, actor, "kb.request_changes", articleId, { version: working.number });
  });
}

/** Throws away the working version. An article that was never published goes with it. */
export async function discardDraft(articleId: string, actor: Actor, database: Db = db()): Promise<"deleted" | "discarded"> {
  return database.transaction(async (tx) => {
    const { article, working } = await load(tx, articleId);
    if (!working) throw new KbError("There's no draft to discard.");
    if (!article.publishedVersionId) {
      await tx.delete(schema.kbArticles).where(eq(schema.kbArticles.id, articleId));
      await audit(tx, actor, "kb.delete_draft", articleId, { title: working.title });
      return "deleted";
    }
    await tx.update(schema.kbArticleVersions).set({ status: "rejected" }).where(eq(schema.kbArticleVersions.id, working.id));
    await tx.update(schema.kbArticles).set({ workingVersionId: null }).where(eq(schema.kbArticles.id, articleId));
    await audit(tx, actor, "kb.discard_draft", articleId, { version: working.number });
    return "discarded";
  });
}

/**
 * Publishes the working version: the previous one is superseded, and the
 * article's passages are rebuilt so the chatbot reads only the new text.
 */
export async function publish(articleId: string, actor: Actor, database: Db = db()): Promise<Version> {
  const version = await database.transaction(async (tx) => {
    const { article, working, published } = await load(tx, articleId);
    if (!working) throw new KbError("There's nothing to publish.");
    if (article.retiredAt) throw new KbError("Restore the article before publishing.");
    if (!working.title.trim() || working.body.trim().length < 20) throw new KbError("Give the article a title and some content first.");
    if (published) await tx.update(schema.kbArticleVersions).set({ status: "superseded" }).where(eq(schema.kbArticleVersions.id, published.id));
    const [v] = await tx
      .update(schema.kbArticleVersions)
      .set({ status: "published", reviewedBy: actor.id ?? null, reviewedAt: new Date(), reviewNote: null })
      .where(eq(schema.kbArticleVersions.id, working.id))
      .returning();
    await tx.update(schema.kbArticles).set({ publishedVersionId: working.id, workingVersionId: null, updatedAt: new Date() }).where(eq(schema.kbArticles.id, articleId));
    await rebuildChunks(tx, articleId, v!, article.audience);
    await audit(tx, actor, "kb.publish", articleId, { version: v!.number, title: v!.title });
    return v!;
  });
  await embedArticle(articleId, database).catch((err) => log.warn("Embedding after publish failed; full-text search still works", { err, articleId }));
  return version;
}

async function rebuildChunks(tx: Tx, articleId: string, version: Version, audience: KbAudience) {
  await tx.delete(schema.kbChunks).where(eq(schema.kbChunks.articleId, articleId));
  const chunks = chunkArticle(version.title, version.body);
  if (chunks.length) {
    await tx.insert(schema.kbChunks).values(chunks.map((c, i) => ({ articleId, versionId: version.id, audience, position: i, heading: c.heading, content: c.content })));
  }
}

/** Adds embeddings to an article's passages that lack them (no-op without Voyage). */
export async function embedArticle(articleId: string, database: Db = db()): Promise<number> {
  const rows = await database
    .select({ id: schema.kbChunks.id, heading: schema.kbChunks.heading, content: schema.kbChunks.content })
    .from(schema.kbChunks)
    .where(and(eq(schema.kbChunks.articleId, articleId), sql`${schema.kbChunks.embedding} is null`));
  if (rows.length === 0) return 0;
  const result = await embed(rows.map((r) => `${r.heading}\n\n${r.content}`), "document");
  if (!result) return 0;
  for (let i = 0; i < rows.length; i++) {
    await database.update(schema.kbChunks).set({ embedding: result.vectors[i]!, embeddingModel: result.model }).where(eq(schema.kbChunks.id, rows[i]!.id));
  }
  return rows.length;
}

/** Embeds any published passages still missing embeddings (after Voyage is set up, or a failure). */
export async function embedMissing(limit = 200, database: Db = db()): Promise<number> {
  const articles = await database
    .selectDistinct({ id: schema.kbChunks.articleId })
    .from(schema.kbChunks)
    .where(sql`${schema.kbChunks.embedding} is null`)
    .limit(limit);
  let n = 0;
  for (const a of articles) n += await embedArticle(a.id, database);
  return n;
}

/** Takes an article out of use: the chatbot stops reading it at once. */
export async function retire(articleId: string, actor: Actor, database: Db = db()) {
  await database.transaction(async (tx) => {
    await tx.update(schema.kbArticles).set({ retiredAt: new Date(), updatedAt: new Date() }).where(eq(schema.kbArticles.id, articleId));
    await tx.delete(schema.kbChunks).where(eq(schema.kbChunks.articleId, articleId));
    await audit(tx, actor, "kb.retire", articleId);
  });
}

export async function restore(articleId: string, actor: Actor, database: Db = db()) {
  await database.transaction(async (tx) => {
    const { article, published } = await load(tx, articleId);
    await tx.update(schema.kbArticles).set({ retiredAt: null, updatedAt: new Date() }).where(eq(schema.kbArticles.id, articleId));
    if (published) await rebuildChunks(tx, articleId, published, article.audience);
    await audit(tx, actor, "kb.restore", articleId);
  });
  await embedArticle(articleId, database).catch(() => undefined);
}

/** When an article's audience changes after publishing, its passages follow. */
export async function syncChunkAudience(articleId: string, audience: KbAudience, database: Db = db()) {
  await database.update(schema.kbChunks).set({ audience }).where(eq(schema.kbChunks.articleId, articleId));
}

/* ---------- Reading ---------- */

export type ArticleState = "draft" | "in_review" | "published" | "published_with_changes" | "retired";

export function articleState(a: { retiredAt: Date | null; publishedVersionId: string | null; workingStatus: string | null }): ArticleState {
  if (a.retiredAt) return "retired";
  if (a.publishedVersionId) return a.workingStatus ? "published_with_changes" : "published";
  return a.workingStatus === "in_review" ? "in_review" : "draft";
}

export async function getArticle(articleId: string, database: Db = db()) {
  const [article] = await database.select().from(schema.kbArticles).where(eq(schema.kbArticles.id, articleId));
  if (!article) return null;
  const [versions, sources] = await Promise.all([
    database.select().from(schema.kbArticleVersions).where(eq(schema.kbArticleVersions.articleId, articleId)).orderBy(desc(schema.kbArticleVersions.number)),
    database.select().from(schema.kbSources).where(eq(schema.kbSources.articleId, articleId)).orderBy(schema.kbSources.createdAt),
  ]);
  return {
    article,
    versions,
    sources,
    working: versions.find((v) => v.id === article.workingVersionId) ?? null,
    published: versions.find((v) => v.id === article.publishedVersionId) ?? null,
  };
}

export async function versionsByIds(ids: string[], database: Db = db()) {
  if (ids.length === 0) return [];
  return database.select().from(schema.kbArticleVersions).where(inArray(schema.kbArticleVersions.id, ids));
}
