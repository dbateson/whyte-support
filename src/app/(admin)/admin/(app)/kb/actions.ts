"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/components/ActionForm";
import { requireStaff, type Staff } from "@/lib/auth/session";
import type { KbAudience } from "@/lib/db/schema";
import { canChange, canSee, visibleAudiences } from "@/lib/kb/access";
import { BULK_LIMIT, bulkApply, type BulkAction, type BulkResult } from "@/lib/kb/bulk";
import { listArticleIds, parseKbFilters, reviewQueue } from "@/lib/kb/queries";
import { createArticle, discardDraft, getArticle, KbError, publish, requestChanges, restore, retire, saveDraft, submitForReview } from "@/lib/kb/service";
import { CATEGORIES } from "@/lib/tickets/format";

const str = (d: FormData, k: string) => String(d.get(k) ?? "").trim();
const audienceOf = (v: string): KbAudience | null => (v === "b2c" || v === "b2b" || v === "both" ? v : null);
const actor = (s: Staff) => ({ id: s.id, label: s.name });

function fields(data: FormData) {
  const title = str(data, "title");
  const body = String(data.get("body") ?? "").trim();
  const audience = audienceOf(str(data, "audience"));
  const category = (CATEGORIES as readonly string[]).includes(str(data, "category")) ? str(data, "category") : null;
  return { title, body, audience, category };
}

export async function createArticleAction(_: ActionState, data: FormData): Promise<ActionState> {
  const staff = await requireStaff("kb.edit");
  const f = fields(data);
  if (!f.title) return { error: "Give the article a title." };
  if (!f.audience) return { error: "Choose who it's for." };
  if (!canChange(staff, "kb.edit", f.audience)) return { error: "Your role can't write articles for that audience." };
  const { article } = await createArticle({ title: f.title, body: f.body, audience: f.audience, category: f.category }, actor(staff));
  redirect(`/admin/kb/articles/${article.id}?saved=1`);
}

/** Save, submit or publish from the editor. */
export async function saveArticleAction(_: ActionState, data: FormData): Promise<ActionState> {
  const staff = await requireStaff("kb.edit");
  const id = str(data, "id");
  const current = await getArticle(id);
  if (!current || !canSee(staff, current.article.audience)) return { error: "That article doesn't exist." };
  const f = fields(data);
  if (!f.title) return { error: "Give the article a title." };
  if (!f.audience) return { error: "Choose who it's for." };
  // Both the old and new audience must be within the editor's segments.
  if (!canChange(staff, "kb.edit", current.article.audience) || !canChange(staff, "kb.edit", f.audience)) {
    return { error: "Your role can't edit articles for that audience." };
  }
  const intent = str(data, "intent");
  if (intent === "publish" && !canChange(staff, "kb.approve", f.audience)) return { error: "Your role can't publish articles for that audience." };
  try {
    await saveDraft(id, { title: f.title, body: f.body, audience: f.audience, category: f.category }, actor(staff));
    if (intent === "submit") await submitForReview(id, actor(staff));
    if (intent === "publish") await publish(id, actor(staff));
  } catch (err) {
    if (err instanceof KbError) return { error: err.message };
    throw err;
  }
  revalidatePath(`/admin/kb/articles/${id}`);
  revalidatePath("/admin/kb");
  return { notice: intent === "publish" ? "Published. The chatbot uses this version now." : intent === "submit" ? "Saved and sent for review." : "Draft saved." };
}

/** Review and lifecycle actions that don't carry edits. */
export async function articleStateAction(_: ActionState, data: FormData): Promise<ActionState> {
  const staff = await requireStaff("kb.view");
  const id = str(data, "id");
  const current = await getArticle(id);
  if (!current || !canSee(staff, current.article.audience)) return { error: "That article doesn't exist." };
  const audience = current.article.audience;
  const intent = str(data, "intent");
  const needs = intent === "submit" || intent === "discard" ? "kb.edit" : "kb.approve";
  // A pending audience change must be within the approver's segments too.
  const pending = current.working?.audience;
  if (!canChange(staff, needs, audience) || (pending && !canChange(staff, needs, pending))) return { error: "Your role can't do that for this article." };
  try {
    switch (intent) {
      case "submit":
        await submitForReview(id, actor(staff));
        break;
      case "publish":
        await publish(id, actor(staff));
        break;
      case "changes":
        await requestChanges(id, str(data, "note"), actor(staff));
        break;
      case "discard":
        if ((await discardDraft(id, actor(staff))) === "deleted") redirect("/admin/kb?deleted=1");
        break;
      case "retire":
        await retire(id, actor(staff));
        break;
      case "restore":
        await restore(id, actor(staff));
        break;
      default:
        return { error: "Unknown action." };
    }
  } catch (err) {
    if (err instanceof KbError) return { error: err.message };
    throw err;
  }
  revalidatePath(`/admin/kb/articles/${id}`);
  revalidatePath("/admin/kb");
  const done: Record<string, string> = {
    submit: "Sent for review.",
    publish: "Published. The chatbot uses this version now.",
    changes: "Sent back to the author with your note.",
    discard: "Draft discarded. The published version is unchanged.",
    retire: "Retired. The chatbot no longer uses it.",
    restore: "Restored. The chatbot uses its published version again.",
  };
  return { notice: done[intent] };
}

/* ---------- Bulk edits (articles list and review queue) ---------- */

const REASON_ORDER = (r: BulkResult) =>
  Object.entries(r.skipped.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.reason]: (acc[s.reason] ?? 0) + 1 }), {}))
    .map(([reason, n]) => `${n} × ${reason}`)
    .join(" ");

export async function bulkEditAction(_: ActionState, data: FormData): Promise<ActionState> {
  const staff = await requireStaff("kb.edit");
  const kind = str(data, "bulkAction");
  let action: BulkAction;
  switch (kind) {
    case "publish":
    case "submit":
    case "discard":
    case "retire":
    case "restore":
      action = { kind };
      break;
    case "changes":
      if (!str(data, "note")) return { error: "Add a note for the authors: what needs changing." };
      action = { kind, note: str(data, "note").slice(0, 2000) };
      break;
    case "category": {
      const c = str(data, "category");
      action = { kind, category: (CATEGORIES as readonly string[]).includes(c) ? c : null };
      break;
    }
    case "audience": {
      const a = audienceOf(str(data, "newAudience"));
      if (!a) return { error: "Choose who the articles are for." };
      action = { kind, audience: a };
      break;
    }
    case "replace": {
      const find = String(data.get("find") ?? "");
      if (!find.trim()) return { error: "Enter the text to find." };
      if (find.length > 500) return { error: "That's too long to find." };
      action = { kind, find, replace: String(data.get("replaceWith") ?? "").slice(0, 2000), publish: data.get("publishAfter") === "on" };
      break;
    }
    default:
      return { error: "Choose what to do." };
  }

  // Which articles: the ticked ones, or everything the page's filters (or the review queue) show.
  const scope = str(data, "scope");
  const audiences = visibleAudiences(staff);
  const ids =
    scope === "filtered"
      ? await listArticleIds(parseKbFilters({ q: str(data, "fq") || undefined, state: str(data, "fstate") || undefined, audience: str(data, "faudience") || undefined }), audiences, BULK_LIMIT)
      : scope === "queue"
        ? (await reviewQueue(audiences)).map((r) => r.id).slice(0, BULK_LIMIT)
        : data.getAll("ids").map(String);
  if (ids.length === 0) return { error: "Tick the articles to change first." };

  const r = await bulkApply(staff, ids, action);
  revalidatePath("/admin/kb");
  revalidatePath("/admin/kb/review");
  const what = r.done === 1 ? "1 article" : `${r.done} articles`;
  const note = action.kind === "audience" ? " Live articles with a draft change audience when that draft is published." : "";
  if (r.done === 0) return { error: `Nothing changed. ${REASON_ORDER(r)}` };
  return { notice: `Done: ${what}.${r.skipped.length ? ` Skipped ${r.skipped.length}: ${REASON_ORDER(r)}` : ""}${note}`, done: Date.now() };
}
