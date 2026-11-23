import { purgeExpiredAuth } from "@/lib/auth/session";
import { safeEqual } from "@/lib/email/addresses";
import { log } from "@/lib/logger";
import { selfOrigin } from "@/lib/public/cors";
import { purgeRateLimits } from "@/lib/rate-limit";
import { purgePendingUploads } from "@/lib/storage/attachments";
import { advanceAll, purgeStaleIngestItems } from "@/lib/ingest/pipeline";
import { embedMissing } from "@/lib/kb/service";
import { purgeOldChats } from "@/lib/chat/engine";
import { purgeSyncLog } from "@/lib/zoho/sync";
import { retentionSweep } from "@/lib/privacy/service";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Nightly job (vercel.json crons): advances unfinished imports, embeds new
 * knowledge-base passages, and tidies up abandoned uploads, expired sessions
 * and links, old rate-limit rows, unused imported text (90 days) and chat
 * conversations idle for 12 months (escalated ones live on in their ticket),
 * and erases closed tickets past the retention period (Settings → General). Vercel sends CRON_SECRET as a
 * bearer token; without that variable set, the route refuses everyone.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  if (!secret || !given || !safeEqual(given, secret)) return new Response("Unauthorised", { status: 401 });
  const result: Record<string, number | string> = {};
  try {
    result.uploads = await purgePendingUploads(selfOrigin(req));
  } catch (err) {
    log.error("Cleanup: uploads failed", { err });
    result.uploads = "failed";
  }
  await purgeExpiredAuth();
  await purgeRateLimits();
  await purgeStaleIngestItems();
  result.chats = await purgeOldChats();
  await purgeSyncLog();
  try {
    const kept = await retentionSweep(selfOrigin(req));
    result.retentionTickets = kept.tickets;
    result.retentionContacts = kept.contacts;
  } catch (err) {
    log.error("Retention sweep failed", { err });
    result.retention = "failed";
  }
  try {
    result.imports = await advanceAll(selfOrigin(req), 200_000);
    result.embedded = await embedMissing();
  } catch (err) {
    log.error("Nightly: imports or embeddings failed", { err });
  }
  log.info("Cleanup done", result);
  return Response.json({ ok: true, ...result });
}
