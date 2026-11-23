import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, lt } from "drizzle-orm";
import { db, schema } from "../db";
import { log } from "../logger";
import { objectStore, type UploadTarget } from "./index";

export const ATTACHMENT_LIMITS = {
  maxFiles: 10,
  maxBytes: 25 * 1000 * 1000,
  types: {
    "image/jpeg": "Photo",
    "image/png": "Image",
    "image/webp": "Image",
    "image/heic": "Photo",
    "image/heif": "Photo",
    "application/pdf": "PDF",
    "video/mp4": "Video",
    "video/quicktime": "Video",
  } as Record<string, string>,
};

export const ACCEPT = Object.keys(ATTACHMENT_LIMITS.types).join(",");

export const claimHash = (claimKey: string) => createHash("sha256").update(`claim:${claimKey}`).digest("hex");

/** File names as people see them: no paths, no control characters, at most 150 characters. */
export function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>|]/g, "").trim();
  return (cleaned || "file").slice(-150);
}

export interface UploadRequest {
  name: string;
  size: number;
  type: string;
}

export type UploadSlot = { id: string; name: string; upload: UploadTarget } | { name: string; error: string };

/** Checks each file and issues a signed upload slot for the good ones. */
export async function issueUploads(files: UploadRequest[], claimKey: string, origin: string): Promise<UploadSlot[]> {
  const store = await objectStore(origin);
  const out: UploadSlot[] = [];
  for (const f of files.slice(0, ATTACHMENT_LIMITS.maxFiles)) {
    const name = cleanFileName(f.name);
    if (!ATTACHMENT_LIMITS.types[f.type]) {
      out.push({ name, error: "Use a photo (JPEG, PNG, HEIC), a PDF or a short video." });
      continue;
    }
    if (!(f.size > 0) || f.size > ATTACHMENT_LIMITS.maxBytes) {
      out.push({ name, error: f.size > 0 ? "Over 25 MB: trim it, or describe it and we'll ask for it." : "That file is empty." });
      continue;
    }
    const id = randomUUID();
    // No customer-provided text in the object's path.
    const storageKey = `uploads/${new Date().toISOString().slice(0, 7)}/${id}`;
    const upload = await store.createUpload(storageKey, f.type);
    await db().insert(schema.ticketAttachments).values({ id, storageKey, fileName: name, contentType: f.type, sizeBytes: f.size, claimHash: claimHash(claimKey) });
    out.push({ id, name, upload });
  }
  return out;
}

/**
 * Attaches uploads to a ticket's message. Only uploads issued to this
 * submission's key, and that actually arrived in storage within the limit, are
 * attached; the rest are ignored. Returns the attached ids.
 */
export async function attachUploads(ids: string[], claimKey: string, ticketId: string, messageId: string, origin: string): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db()
    .select()
    .from(schema.ticketAttachments)
    .where(and(inArray(schema.ticketAttachments.id, ids.slice(0, ATTACHMENT_LIMITS.maxFiles)), eq(schema.ticketAttachments.status, "pending"), eq(schema.ticketAttachments.claimHash, claimHash(claimKey))));
  const store = await objectStore(origin);
  const good: string[] = [];
  for (const row of rows) {
    const info = await store.stat(row.storageKey);
    if (!info || info.size === 0 || info.size > ATTACHMENT_LIMITS.maxBytes) {
      log.warn("Attachment missing or wrong size at submit", { id: row.id, size: info?.size });
      continue;
    }
    good.push(row.id);
    await db()
      .update(schema.ticketAttachments)
      .set({ status: "attached", ticketId, messageId, sizeBytes: info.size, attachedAt: new Date() })
      .where(eq(schema.ticketAttachments.id, row.id));
  }
  return good;
}

/** Deletes uploads that were never attached to a ticket (abandoned forms), older than a day. */
export async function purgePendingUploads(origin: string): Promise<number> {
  const stale = await db()
    .select({ id: schema.ticketAttachments.id, key: schema.ticketAttachments.storageKey })
    .from(schema.ticketAttachments)
    .where(and(eq(schema.ticketAttachments.status, "pending"), lt(schema.ticketAttachments.createdAt, new Date(Date.now() - 24 * 60 * 60 * 1000))))
    .limit(500);
  if (stale.length === 0) return 0;
  const store = await objectStore(origin);
  await store.remove(stale.map((s) => s.key));
  await db().delete(schema.ticketAttachments).where(inArray(schema.ticketAttachments.id, stale.map((s) => s.id)));
  return stale.length;
}

export async function attachmentsForTicket(ticketId: string) {
  return db()
    .select({ id: schema.ticketAttachments.id, messageId: schema.ticketAttachments.messageId, fileName: schema.ticketAttachments.fileName, contentType: schema.ticketAttachments.contentType, sizeBytes: schema.ticketAttachments.sizeBytes })
    .from(schema.ticketAttachments)
    .where(and(eq(schema.ticketAttachments.ticketId, ticketId), eq(schema.ticketAttachments.status, "attached")));
}
