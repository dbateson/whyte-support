import { z } from "zod";
import { log } from "@/lib/logger";
import { allow } from "@/lib/rate-limit";
import { clientIp } from "@/lib/request";
import { corsFor, json, preflight, selfOrigin } from "@/lib/public/cors";
import { StorageNotConfiguredError } from "@/lib/storage";
import { ATTACHMENT_LIMITS, issueUploads } from "@/lib/storage/attachments";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

const schema = z.object({
  claimKey: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  files: z
    .array(z.object({ name: z.string().max(500), size: z.number().int().nonnegative(), type: z.string().max(100) }))
    .min(1)
    .max(ATTACHMENT_LIMITS.maxFiles),
});

/** Signed upload slots: the browser then sends each file straight to storage. */
export async function POST(req: Request) {
  const cors = await corsFor(req);
  if (!cors) return new Response(null, { status: 403 });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "Bad request" }, 400, cors);
  if (!(await allow("uploads-ip", await clientIp(), 40, 60 * 60 * 1000))) {
    return json({ error: "Too many uploads just now. Try again later, or reply to our email with the files." }, 429, cors);
  }
  try {
    const slots = await issueUploads(parsed.data.files, parsed.data.claimKey, selfOrigin(req));
    return json({ slots }, 200, cors);
  } catch (err) {
    if (err instanceof StorageNotConfiguredError) return json({ error: "Files can't be attached right now. Send your request, then reply to our email with them." }, 503, cors);
    log.error("Upload slots failed", { err });
    return json({ error: "Files can't be attached right now." }, 500, cors);
  }
}
