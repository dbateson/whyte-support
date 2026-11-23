import { after } from "next/server";
import { safeEqual } from "@/lib/email/addresses";
import { log } from "@/lib/logger";
import { getSecret } from "@/lib/secrets";
import { applyNotified } from "@/lib/zoho/pull";
import { syncEnabled } from "@/lib/zoho/push";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Zoho's notifications: record ids that changed, with the token we gave it.
 * Answers at once; the records are fetched and applied after the response.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { token?: string; module?: string; ids?: unknown; operation?: string } | null;
  const expected = await getSecret("zoho.webhook_token");
  if (!body || !expected || typeof body.token !== "string" || !safeEqual(body.token, expected)) return new Response("Forbidden", { status: 403 });
  if (!(await syncEnabled())) return new Response(null, { status: 204 });
  const ids = Array.isArray(body.ids) ? body.ids.filter((i): i is string => typeof i === "string" && /^\d{1,25}$/.test(i)).slice(0, 500) : [];
  const zohoModule = typeof body.module === "string" ? body.module : "";
  const operation = typeof body.operation === "string" ? body.operation : "";
  if (ids.length) {
    after(() => applyNotified(zohoModule, ids, operation).catch((err) => log.error("Applying a Zoho notification failed (the next reconcile will pick it up)", { err, module: zohoModule })));
  }
  return new Response(null, { status: 204 });
}
