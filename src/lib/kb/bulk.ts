import "server-only";
import { eq, inArray } from "drizzle-orm";
import type { Staff } from "../auth/session";
import { db, schema } from "../db";
import type { KbAudience } from "../db/schema";
import { canChange } from "./access";
import { discardDraft, KbError, publish, requestChanges, restore, retire, saveDraft, submitForReview } from "./service";

/**
 * Bulk edits to knowledge-base articles. Each article goes through the same
 * steps as editing it by hand (versions, review, audit log), and each is
 * checked against the person's role for that article's audience; anything
 * they can't change, or that doesn't apply, is skipped and reported.
 */

export const BULK_LIMIT = 500;

export type BulkAction =
  | { kind: "publish" }
  | { kind: "submit" }
  | { kind: "changes"; note: string }
  | { kind: "discard" }
  | { kind: "retire" }
  | { kind: "restore" }
  | { kind: "category"; category: string | null }
  | { kind: "audience"; audience: KbAudience }
  | { kind: "replace"; find: string; replace: string; publish: boolean };

export interface BulkResult {
  done: number;
  skipped: { id: string; title: string; reason: string }[];
}

type Row = Awaited<ReturnType<typeof load>>[number];

async function load(ids: string[]) {
  const articles = await db().select().from(schema.kbArticles).where(inArray(schema.kbArticles.id, ids));
  const versionIds = articles.flatMap((a) => [a.workingVersionId, a.publishedVersionId]).filter((v): v is string => Boolean(v));
  const versions = versionIds.length ? await db().select().from(schema.kbArticleVersions).where(inArray(schema.kbArticleVersions.id, versionIds)) : [];
  const byId = new Map(versions.map((v) => [v.id, v]));
  return articles.map((a) => ({ article: a, working: a.workingVersionId ? byId.get(a.workingVersionId) ?? null : null, published: a.publishedVersionId ? byId.get(a.publishedVersionId) ?? null : null }));
}

const titleOf = (r: Row) => (r.working ?? r.published)?.title ?? "Untitled";

/** Why this person can't do this to this article, or null if they can. */
function refusal(staff: Staff, r: Row, action: BulkAction): string | null {
  const { article, working } = r;
  const needs = (p: "kb.edit" | "kb.approve", ...audiences: (KbAudience | null | undefined)[]) =>
    audiences.filter((a): a is KbAudience => Boolean(a)).every((a) => canChange(staff, p, a)) ? null : p === "kb.approve" ? "Your role can't approve articles for this audience." : "Your role can't edit articles for this audience.";
  const pending = working?.audience;
  switch (action.kind) {
    case "publish":
      if (article.retiredAt) return "Retired: restore it first.";
      if (!working) return "Nothing to publish.";
      return needs("kb.approve", article.audience, pending);
    case "submit":
      if (working?.status !== "draft") return "No draft to send for review.";
      return needs("kb.edit", article.audience, pending);
    case "changes":
      if (working?.status !== "in_review") return "Not in review.";
      return needs("kb.approve", article.audience, pending);
    case "discard":
      if (!working) return "No draft to discard.";
      return needs("kb.edit", article.audience, pending);
    case "retire":
      if (article.retiredAt) return "Already retired.";
      return needs("kb.approve", article.audience);
    case "restore":
      if (!article.retiredAt) return "Not retired.";
      return needs("kb.approve", article.audience);
    case "category":
      if (article.retiredAt) return "Retired: restore it first.";
      return needs("kb.edit", article.audience);
    case "audience":
      if (article.retiredAt) return "Retired: restore it first.";
      if (article.audience === action.audience && !pending) return "Already for that audience.";
      // Changing who sees a live article is an approval; a draft-only article is an edit.
      return needs(article.publishedVersionId ? "kb.approve" : "kb.edit", article.audience, action.audience);
    case "replace": {
      if (article.retiredAt) return "Retired: restore it first.";
      const v = working ?? r.published;
      if (!v || !(`${v.title}\n${v.body}`.includes(action.find))) return "Doesn't contain the text.";
      return needs(action.publish ? "kb.approve" : "kb.edit", article.audience, pending);
    }
  }
}

export async function bulkApply(staff: Staff, ids: string[], action: BulkAction): Promise<BulkResult> {
  const actor = { id: staff.id, label: staff.name };
  const unique = [...new Set(ids.filter((i) => /^[0-9a-f-]{36}$/.test(i)))].slice(0, BULK_LIMIT);
  const rows = unique.length ? await load(unique) : [];
  const result: BulkResult = { done: 0, skipped: [] };
  for (const r of rows) {
    const why = refusal(staff, r, action);
    if (why) {
      result.skipped.push({ id: r.article.id, title: titleOf(r), reason: why });
      continue;
    }
    try {
      await applyOne(r, action, actor);
      result.done++;
    } catch (err) {
      result.skipped.push({ id: r.article.id, title: titleOf(r), reason: err instanceof KbError ? err.message : "Something went wrong." });
      if (!(err instanceof KbError)) throw err;
    }
  }
  return result;
}

async function applyOne(r: Row, action: BulkAction, actor: { id: string; label: string }) {
  const id = r.article.id;
  const v = r.working ?? r.published!;
  switch (action.kind) {
    case "publish":
      return void (await publish(id, actor));
    case "submit":
      return submitForReview(id, actor);
    case "changes":
      return requestChanges(id, action.note, actor);
    case "discard":
      return void (await discardDraft(id, actor));
    case "retire":
      return retire(id, actor);
    case "restore":
      return restore(id, actor);
    case "category":
      await db().update(schema.kbArticles).set({ category: action.category, updatedAt: new Date() }).where(eq(schema.kbArticles.id, id));
      return;
    case "audience":
      if (r.article.publishedVersionId) {
        // An approver's change to a live article: the draft carries it, and publishing applies it (and re-tags the passages).
        // With no draft yet, a copy of the live version is made and published at once, so nothing else changes.
        await saveDraft(id, { title: v.title, body: v.body, audience: action.audience, category: r.article.category }, actor);
        if (!r.working) await publish(id, actor);
        return;
      }
      await saveDraft(id, { title: v.title, body: v.body, audience: action.audience, category: r.article.category }, actor);
      return;
    case "replace": {
      const title = v.title.split(action.find).join(action.replace);
      const body = v.body.split(action.find).join(action.replace);
      await saveDraft(id, { title, body, audience: v.audience ?? r.article.audience, category: r.article.category }, actor);
      if (action.publish) await publish(id, actor);
      return;
    }
  }
}
