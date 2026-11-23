import { log } from "@/lib/logger";
import { clientIp } from "@/lib/request";
import { startChat } from "@/lib/public/chat";
import { corsFor, json, preflight } from "@/lib/public/cors";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

/** Starts a chat. Returns the session id and the token later calls must carry. */
export async function POST(req: Request) {
  const cors = await corsFor(req);
  if (!cors) return new Response(null, { status: 403 });
  try {
    const r = await startChat(await req.json().catch(() => null), { ip: await clientIp(), origin: req.headers.get("origin") ?? req.headers.get("referer") ?? "" });
    return r.ok ? json(r.value, 201, cors) : json({ error: r.error }, r.status, cors);
  } catch (err) {
    log.error("Chat start failed", { err });
    return json({ error: "Something went wrong on our side." }, 500, cors);
  }
}
