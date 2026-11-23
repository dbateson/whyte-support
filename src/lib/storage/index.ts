import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { StorageClient } from "@supabase/storage-js";
import { env } from "../env";
import { getSecret } from "../secrets";
import { getSetting } from "../settings";

/**
 * Private object storage for attachments. Production: a Supabase Storage
 * bucket, with the project URL in settings and its secret key in the
 * encrypted store. Development, when that isn't set up: files on local disk,
 * served by /api/dev-storage. Browsers upload straight to storage with a
 * short-lived signed URL, so large photos never pass through our functions.
 */

export const BUCKET = "ticket-attachments";
/** Knowledge-base imports (email exports, Zoho CSVs): any file type, private, deleted after import. */
export const IMPORT_BUCKET = "kb-imports";

export interface UploadTarget {
  /** PUT the file's bytes here, with Content-Type set. */
  url: string;
  headers: Record<string, string>;
}

export interface ObjectStore {
  kind: "supabase" | "local";
  createUpload(key: string, contentType: string): Promise<UploadTarget>;
  stat(key: string): Promise<{ size: number; contentType: string | null } | null>;
  downloadUrl(key: string, fileName: string, expiresInSeconds?: number): Promise<string>;
  remove(keys: string[]): Promise<void>;
  /** Reads bytes [start, start + length) of an object (for large imports read in pieces). */
  readRange(key: string, start: number, length: number): Promise<Buffer>;
}

export class StorageNotConfiguredError extends Error {
  constructor() {
    super("File storage isn't set up: add the Supabase URL in Settings → General and its secret key in Integrations.");
  }
}

async function supabaseStore(bucketName: string): Promise<ObjectStore | null> {
  const url = (await getSetting("storage.supabase_url")).replace(/\/$/, "");
  const key = await getSecret("storage.service_key");
  if (!url || !key) return null;
  const client = new StorageClient(`${url}/storage/v1`, { apikey: key, Authorization: `Bearer ${key}` });
  const bucket = client.from(bucketName);
  return {
    kind: "supabase",
    async createUpload(path, contentType) {
      const { data, error } = await bucket.createSignedUploadUrl(path);
      if (error || !data) throw new Error(`Couldn't create an upload link: ${error?.message ?? "no data"}`);
      return { url: data.signedUrl, headers: { "content-type": contentType, "x-upsert": "false" } };
    },
    async stat(path) {
      const { data, error } = await bucket.info(path);
      if (error || !data) return null;
      return { size: Number(data.size ?? 0), contentType: data.contentType ?? null };
    },
    async downloadUrl(path, fileName, expiresIn = 60) {
      const { data, error } = await bucket.createSignedUrl(path, expiresIn, { download: fileName });
      if (error || !data) throw new Error(`Couldn't create a download link: ${error?.message ?? "no data"}`);
      return data.signedUrl;
    },
    async remove(paths) {
      if (paths.length === 0) return;
      const { error } = await bucket.remove(paths);
      if (error) throw new Error(`Couldn't delete files: ${error.message}`);
    },
    async readRange(path, start, length) {
      const { data, error } = await bucket.createSignedUrl(path, 120);
      if (error || !data) throw new Error(`Couldn't read the file: ${error?.message ?? "no data"}`);
      const res = await fetch(data.signedUrl, { headers: { range: `bytes=${start}-${start + length - 1}` } });
      if (res.status === 416) return Buffer.alloc(0);
      if (!res.ok) throw new Error(`Couldn't read the file: storage returned ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      // A server that ignores Range sends the whole file: take our slice of it.
      return res.status === 206 ? buf : buf.subarray(start, start + length);
    },
  };
}

/* ---------- Local development stand-in ---------- */

const LOCAL_ROOT = join(tmpdir(), "whyte-support-dev-storage");

function localPath(key: string): string {
  const p = normalize(join(LOCAL_ROOT, key));
  if (!p.startsWith(LOCAL_ROOT + "/")) throw new Error("Bad key");
  return p;
}

/** Signs a dev-storage URL so only links we issued work. */
export function signLocal(action: "put" | "get", key: string, expires: number): string {
  return createHmac("sha256", Buffer.from(env().APP_ENCRYPTION_KEY, "base64")).update(`${action}:${key}:${expires}`).digest("base64url");
}

export function verifyLocal(action: "put" | "get", key: string, expires: number, sig: string): boolean {
  if (!Number.isFinite(expires) || expires < Date.now()) return false;
  const a = Buffer.from(signLocal(action, key, expires));
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}

function localStore(origin: string, bucketName: string): ObjectStore {
  const scoped = (key: string) => (bucketName === BUCKET ? key : `${bucketName}/${key}`);
  const link = (action: "put" | "get", key: string, ttlMs: number, extra = "") => {
    const expires = Date.now() + ttlMs;
    return `${origin}/api/dev-storage?${new URLSearchParams({ key, action, expires: String(expires), sig: signLocal(action, key, expires) })}${extra}`;
  };
  return {
    kind: "local",
    async createUpload(key, contentType) {
      return { url: link("put", scoped(key), 2 * 60 * 60 * 1000), headers: { "content-type": contentType } };
    },
    async stat(key) {
      try {
        const s = await stat(localPath(scoped(key)));
        const meta = await readFile(`${localPath(scoped(key))}.type`, "utf8").catch(() => null);
        return { size: s.size, contentType: meta };
      } catch {
        return null;
      }
    },
    async downloadUrl(key, fileName, expiresIn = 60) {
      return link("get", scoped(key), expiresIn * 1000, `&name=${encodeURIComponent(fileName)}`);
    },
    async remove(keys) {
      await Promise.all(keys.map((k) => Promise.all([rm(localPath(scoped(k)), { force: true }), rm(`${localPath(scoped(k))}.type`, { force: true })])));
    },
    async readRange(key, start, length) {
      const fh = await open(localPath(scoped(key)), "r");
      try {
        const buf = Buffer.alloc(length);
        const { bytesRead } = await fh.read(buf, 0, length, start);
        return buf.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
    },
  };
}

export async function writeLocalObject(key: string, body: Buffer, contentType: string) {
  const p = localPath(key);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, body, { flag: "wx" });
  await writeFile(`${p}.type`, contentType);
}

export async function readLocalObject(key: string) {
  const p = localPath(key);
  return { body: await readFile(p), contentType: (await readFile(`${p}.type`, "utf8").catch(() => null)) ?? "application/octet-stream" };
}

/** The configured store for a bucket. Falls back to local disk only outside production. */
export async function objectStore(origin: string, bucketName: string = BUCKET): Promise<ObjectStore> {
  const store = await supabaseStore(bucketName);
  if (store) return store;
  if (process.env.NODE_ENV !== "production" || process.env.WHYTE_LOCAL_STORAGE === "1") return localStore(origin, bucketName);
  throw new StorageNotConfiguredError();
}
