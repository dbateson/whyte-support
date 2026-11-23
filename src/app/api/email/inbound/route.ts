import { safeEqual } from "@/lib/email/addresses";
import { fileInboundEmail, type InboundEmail } from "@/lib/email/inbound";
import { log } from "@/lib/logger";
import { getSecret } from "@/lib/secrets";

export const dynamic = "force-dynamic";

/**
 * Postmark's inbound webhook. Set the webhook URL in Postmark with basic-auth
 * credentials: https://postmark:<inbound webhook secret>@<site>/api/email/inbound
 * The secret is the one saved in Settings → Integrations → Email.
 */
export async function POST(req: Request) {
  const secret = await getSecret("email.inbound_secret");
  if (!secret) return new Response("Inbound email isn't set up", { status: 503 });
  const auth = req.headers.get("authorization") ?? "";
  const given = auth.startsWith("Basic ") ? Buffer.from(auth.slice(6), "base64").toString("utf8").split(":").slice(1).join(":") : "";
  if (!given || !safeEqual(given, secret)) return new Response("Unauthorised", { status: 401 });

  let email: InboundEmail;
  try {
    email = (await req.json()) as InboundEmail;
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  try {
    const result = await fileInboundEmail(email);
    log.info("Inbound email filed", result);
    return Response.json({ ok: true, ...result });
  } catch (err) {
    log.error("Inbound email failed", { err });
    // 500 makes Postmark retry later.
    return new Response("Couldn't file the email", { status: 500 });
  }
}
