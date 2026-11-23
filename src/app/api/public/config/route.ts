import { getSettings } from "@/lib/settings";
import { corsFor, json, preflight } from "@/lib/public/cors";
import { ACCEPT, ATTACHMENT_LIMITS } from "@/lib/storage/attachments";
import { CATEGORIES } from "@/lib/tickets/format";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

/** What the form needs to draw itself. Nothing secret. */
export async function GET(req: Request) {
  const cors = await corsFor(req);
  if (!cors) return new Response(null, { status: 403 });
  const s = await getSettings(["turnstile.site_key", "support.phone.b2c", "support.phone.b2b", "support.privacy_url"]);
  return json(
    {
      categories: CATEGORIES,
      turnstileSiteKey: s["turnstile.site_key"] || null,
      phone: { b2c: s["support.phone.b2c"] || null, b2b: s["support.phone.b2b"] || null },
      privacyUrl: s["support.privacy_url"] || null,
      attachments: { accept: ACCEPT, maxFiles: ATTACHMENT_LIMITS.maxFiles, maxBytes: ATTACHMENT_LIMITS.maxBytes },
    },
    200,
    { ...cors, "cache-control": "public, max-age=60" },
  );
}
