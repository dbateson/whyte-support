"use server";

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireStaff } from "@/lib/auth/session";
import { canChange } from "@/lib/kb/access";
import { db, schema } from "@/lib/db";
import { createJob, runStep, type Job } from "@/lib/ingest/pipeline";
import { baseUrl } from "@/lib/request";
import { IMPORT_BUCKET, objectStore, StorageNotConfiguredError, type UploadTarget } from "@/lib/storage";

const MAX_IMPORT_BYTES = 2 * 1024 * 1024 * 1024;

/** Signed upload slots for import files (they can be large: they go straight to storage). */
export async function requestImportUploads(files: { name: string; size: number }[]): Promise<{ slots?: { key: string; upload: UploadTarget }[]; error?: string }> {
  await requireStaff("kb.edit");
  const parsed = z.array(z.object({ name: z.string().max(300), size: z.number().int().positive().max(MAX_IMPORT_BYTES) })).min(1).max(500).safeParse(files);
  if (!parsed.success) return { error: "Choose files under 2 GB each." };
  try {
    const store = await objectStore(await baseUrl(), IMPORT_BUCKET);
    const slots = [];
    for (let i = 0; i < parsed.data.length; i++) {
      const key = `imports/${new Date().toISOString().slice(0, 10)}/${randomUUID()}`;
      slots.push({ key, upload: await store.createUpload(key, "application/octet-stream") });
    }
    return { slots };
  } catch (err) {
    return { error: err instanceof StorageNotConfiguredError ? err.message : "Couldn't prepare the upload." };
  }
}

const audience = z.enum(["b2c", "b2b", "both"]);

const startSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("mbox"), label: z.string().min(1).max(200), audience, staffDomains: z.array(z.string().min(3)).min(1), files: z.array(z.object({ key: z.string(), size: z.number() })).min(1) }),
  z.object({ kind: z.literal("eml"), label: z.string().min(1).max(200), audience, staffDomains: z.array(z.string().min(3)).min(1), files: z.array(z.object({ key: z.string(), size: z.number() })).min(1) }),
  z.object({ kind: z.literal("zoho_csv"), label: z.string().min(1).max(200), audience, files: z.array(z.object({ key: z.string(), size: z.number() })).length(1) }),
  z.object({ kind: z.literal("web"), label: z.string().min(1).max(200), audience, sitemapUrl: z.string().url(), include: z.array(z.enum(["pages", "products", "blogs"])).min(1) }),
]);

export async function startImport(input: unknown): Promise<{ error?: string }> {
  const staff = await requireStaff("kb.edit");
  const parsed = startSchema.safeParse(input);
  if (!parsed.success) return { error: "Something's missing from the import." };
  const v = parsed.data;
  const keysOk = "files" in v ? v.files.every((f) => /^imports\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}$/.test(f.key)) : true;
  if (!keysOk) return { error: "Bad file reference." };
  if (v.kind === "web" && process.env.NODE_ENV === "production" && !/^https:\/\/([a-z0-9-]+\.)*whytebikes\.com\/[^\s]*$/i.test(v.sitemapUrl)) {
    return { error: "Only whytebikes.com sitemaps can be crawled." };
  }
  const params =
    v.kind === "mbox"
      ? { key: v.files[0]!.key, size: v.files[0]!.size, offset: 0, staffDomains: v.staffDomains, more: v.files.slice(1) }
      : v.kind === "eml"
        ? { keys: v.files.map((f) => f.key), index: 0, staffDomains: v.staffDomains }
        : v.kind === "zoho_csv"
          ? { key: v.files[0]!.key }
          : { sitemapUrl: v.sitemapUrl, include: v.include };
  // Drafts land in the chosen audience: the editor must be allowed to edit there.
  if (!canChange(staff, "kb.edit", v.audience)) return { error: "Your role can't add articles for that audience." };
  const job = await createJob({ kind: v.kind, label: v.label, defaultAudience: v.audience, params }, { id: staff.id, label: staff.name });
  redirect(`/admin/kb/import/${job.id}`);
}

/** One step of work, called by the job page while it's open. */
/** An import this person may run or cancel: one whose audience they can edit. */
async function ownJob(jobId: string) {
  const staff = await requireStaff("kb.edit");
  if (!/^[0-9a-f-]{36}$/.test(jobId)) throw new Error("No such import.");
  const [job] = await db().select({ id: schema.ingestJobs.id, audience: schema.ingestJobs.defaultAudience }).from(schema.ingestJobs).where(eq(schema.ingestJobs.id, jobId));
  if (!job || !canChange(staff, "kb.edit", job.audience)) throw new Error("No such import.");
  return job;
}

export async function stepImport(jobId: string): Promise<Pick<Job, "status" | "stats" | "error">> {
  await ownJob(jobId);
  const job = await runStep(jobId, await baseUrl(), 40_000);
  return { status: job.status, stats: job.stats, error: job.error };
}

export async function cancelImport(jobId: string): Promise<void> {
  await ownJob(jobId);
  await db().update(schema.ingestJobs).set({ status: "cancelled", finishedAt: new Date() }).where(eq(schema.ingestJobs.id, jobId));
}
