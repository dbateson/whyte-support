import { log } from "@/lib/logger";
import { clientIp } from "@/lib/request";
import { escalateChat } from "@/lib/public/chat";
import { corsFor, json, preflight } from "@/lib/public/cors";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

/** Passes the chat to the team as a ticket, with the transcript. */
export async function POST(req: Request) {
  const cors = await corsFor(req);
  if (!cors) return new Response(null, { status: 403 });
  try {
    const r = await escalateChat(await req.json().catch(() => null), { ip: await clientIp() });
    return r.ok ? json(r.value, 201, cors) : json({ error: r.error, fields: r.fields }, r.status, cors);
  } catch (err) {
    log.error("Chat escalation failed", { err });
    return json({ error: "Something went wrong on our side. Please use the contact form." }, 500, cors);
  }
}
