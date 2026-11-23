import { log } from "@/lib/logger";
import { clientIp } from "@/lib/request";
import { sendChatMessage } from "@/lib/public/chat";
import { corsFor, json, preflight } from "@/lib/public/cors";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const OPTIONS = preflight;

/** A question; the answer comes back with the articles it rests on. */
export async function POST(req: Request) {
  const cors = await corsFor(req);
  if (!cors) return new Response(null, { status: 403 });
  try {
    const r = await sendChatMessage(await req.json().catch(() => null), { ip: await clientIp() });
    return r.ok ? json(r.value, 200, cors) : json({ error: r.error }, r.status, cors);
  } catch (err) {
    log.error("Chat message failed", { err });
    return json({ error: "Something went wrong on our side." }, 500, cors);
  }
}
