"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/components/ActionForm";
import { requireStaff, type Staff } from "@/lib/auth/session";
import type { KbAudience } from "@/lib/db/schema";
import { canChange, canSee } from "@/lib/kb/access";
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
