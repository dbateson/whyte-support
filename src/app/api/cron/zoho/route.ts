import { safeEqual } from "@/lib/email/addresses";
import { getSetting } from "@/lib/settings";
import { runSync } from "@/lib/zoho/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Every 15 minutes (vercel.json): sends queued changes and pulls what changed in Zoho. */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  if (!secret || !given || !safeEqual(given, secret)) return new Response("Unauthorised", { status: 401 });
  const publicUrl = (await getSetting("app.public_url")) || null;
  const result = await runSync(Date.now() + 240_000, publicUrl);
  return Response.json({ ok: !result.error, ...result });
}
